const prisma = require('../db/prisma');
const viagemService = require('./viagem.service');

// Redis será carregado dinamicamente para evitar dependência circular
let redisService = null;

const REDIS_PREFIX = 'hb:'; // heartbeat prefix
const REDIS_TTL = 86400;    // 24 horas
const STATS_RESET_INTERVAL = 60 * 60 * 1000; // 1 hora em ms

class HeartbeatService {
  // Cache local como fallback (usado se Redis não estiver disponível)
  heartbeats = new Map();

  // Timestamp do último reset de estatísticas
  lastStatsReset = Date.now();

  // Contadores locais para a hora atual
  hourlyHeartbeats = 0;
  hourlyLocations = 0;

  /**
   * Obtém o serviço Redis (lazy loading para evitar dependência circular)
   */
  getRedis() {
    if (!redisService) {
      try {
        redisService = require('./redis.service');
      } catch (e) {
        console.error('[Heartbeat] Redis service não disponível:', e.message);
      }
    }
    return redisService;
  }

  /**
   * Verifica se Redis está disponível, tenta conectar se necessário
   */
  async ensureRedisConnected() {
    const redis = this.getRedis();
    if (!redis) return false;

    if (redis.isAvailable()) return true;

    // Tentar conectar se não estiver conectado
    if (redis.isEnabled && !redis.isConnected) {
      try {
        await redis.connect();
        return redis.isAvailable();
      } catch (e) {
        // Silently fail - usará Map local
        return false;
      }
    }

    return false;
  }

  /**
   * Verifica se Redis está disponível (síncrono, para checks rápidos)
   */
  isRedisAvailable() {
    const redis = this.getRedis();
    return redis && redis.isAvailable();
  }

  // ✅ CORREÇÃO #6: Persistir heartbeat no banco
  async persistToDatabase(imei, timestamp) {
    try {
      await prisma.dispositivo.update({
        where: { imei },
        data: {
          ultima_conexao: timestamp,
          updated_at: new Date(),
          status: 'online'
        }
      });
    } catch (error) {
      if (error.code !== 'P2025') {
        console.error(`[Heartbeat] Persist error for ${imei}: ${error.message}`);
      }
    }
  }

  /**
   * Verifica se deve resetar estatísticas (a cada hora)
   */
  checkAndResetStats() {
    const now = Date.now();
    if (now - this.lastStatsReset >= STATS_RESET_INTERVAL) {
      console.log(`[Heartbeat] 🔄 Resetando contadores horários (heartbeats: ${this.hourlyHeartbeats}, locations: ${this.hourlyLocations})`);
      this.hourlyHeartbeats = 0;
      this.hourlyLocations = 0;
      this.lastStatsReset = now;

      // Resetar contador global no Redis também
      if (this.isRedisAvailable()) {
        const redis = this.getRedis();
        redis.client.set(`${REDIS_PREFIX}total`, '0').catch(() => {});
        redis.client.set(`${REDIS_PREFIX}locations`, '0').catch(() => {});

        // Resetar contadores por dispositivo
        redis.client.keys(`${REDIS_PREFIX}*`).then(keys => {
          const deviceKeys = keys.filter(k =>
            k !== `${REDIS_PREFIX}total` &&
            k !== `${REDIS_PREFIX}locations` &&
            k.startsWith(REDIS_PREFIX)
          );

          if (deviceKeys.length > 0) {
            const pipeline = redis.client.pipeline();
            deviceKeys.forEach(key => {
              pipeline.hset(key, 'count', '0');
            });
            pipeline.exec().catch(() => {});
            console.log(`[Heartbeat] Resetados ${deviceKeys.length} contadores de dispositivos`);
          }
        }).catch(() => {});
      }

      // Limpar Map local também
      this.heartbeats.forEach((value, key) => {
        this.heartbeats.set(key, { ...value, count: 0 });
      });
    }
  }

  /**
   * Incrementar contador de localizações
   */
  incrementLocations() {
    this.checkAndResetStats();
    this.hourlyLocations++;

    if (this.isRedisAvailable()) {
      const redis = this.getRedis();
      redis.client.incr(`${REDIS_PREFIX}locations`).catch(() => {});
    }
  }

  /**
   * Obter contadores horários
   */
  async getHourlyStats() {
    this.checkAndResetStats();

    let heartbeats = this.hourlyHeartbeats;
    let locations = this.hourlyLocations;

    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();
        const [hbTotal, locTotal] = await Promise.all([
          redis.client.get(`${REDIS_PREFIX}total`),
          redis.client.get(`${REDIS_PREFIX}locations`)
        ]);
        if (hbTotal) heartbeats = parseInt(hbTotal);
        if (locTotal) locations = parseInt(locTotal);
      } catch (e) {
        // Usar valores locais
      }
    }

    return { heartbeats, locations };
  }

  /**
   * Registrar um heartbeat
   * Usa Redis para compartilhar entre containers, com fallback para Map local
   */
  async register(imei) {
    // Verificar se deve resetar contadores
    this.checkAndResetStats();

    const now = new Date();
    let count = 1;

    // Incrementar contador horário
    this.hourlyHeartbeats++;

    // Tentar conectar Redis se necessário
    const redisConnected = await this.ensureRedisConnected();

    if (redisConnected) {
      try {
        const redis = this.getRedis();
        const key = `${REDIS_PREFIX}${imei}`;

        // Buscar count atual do Redis
        const existing = await redis.client.hgetall(key);
        if (existing && existing.count) {
          count = parseInt(existing.count) + 1;
        }

        // Atualizar no Redis
        await redis.client.hset(key, {
          timestamp: now.toISOString(),
          count: count.toString()
        });
        await redis.client.expire(key, REDIS_TTL);

        // Incrementar estatística global
        await redis.client.incr(`${REDIS_PREFIX}total`);

      } catch (error) {
        console.error(`[Heartbeat] Redis error: ${error.message}, falling back to local Map`);
        // Fallback para Map local
        const existing = this.heartbeats.get(imei);
        count = (existing?.count || 0) + 1;
        this.heartbeats.set(imei, { timestamp: now, count });
      }
    } else {
      // Usar Map local se Redis não disponível
      const existing = this.heartbeats.get(imei);
      count = (existing?.count || 0) + 1;
      this.heartbeats.set(imei, { timestamp: now, count });
    }

    // Sempre persistir no banco
    await this.persistToDatabase(imei, now);

    return {
      imei,
      timestamp: now,
      count
    };
  }

  /**
   * Obter últimos heartbeats de um dispositivo
   * NOTA: Usa Map local para performance (síncrono), Redis é usado para getStats()
   */
  getRecent(imei, limit = 20) {
    const hb = this.heartbeats.get(imei);
    if (!hb) return null;

    return {
      imei,
      ...hb,
      status: this.getStatusFromData(hb)
    };
  }

  /**
   * Versão async que busca do Redis (para quando precisar de dados compartilhados)
   */
  async getRecentAsync(imei) {
    let hb = null;

    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();
        const key = `${REDIS_PREFIX}${imei}`;
        const data = await redis.client.hgetall(key);

        if (data && data.timestamp) {
          hb = {
            timestamp: new Date(data.timestamp),
            count: parseInt(data.count) || 0
          };
        }
      } catch (error) {
        console.error(`[Heartbeat] Redis getRecentAsync error: ${error.message}`);
      }
    }

    // Fallback para Map local
    if (!hb) {
      hb = this.heartbeats.get(imei);
    }

    if (!hb) return null;

    return {
      imei,
      ...hb,
      status: this.getStatusFromData(hb)
    };
  }

  /**
   * Calcular status baseado em dados de heartbeat
   */
  getStatusFromData(hb) {
    if (!hb || !hb.timestamp) return 'unknown';

    const timestamp = hb.timestamp instanceof Date ? hb.timestamp : new Date(hb.timestamp);
    const timeSinceLastHB = Date.now() - timestamp.getTime();
    const minutesSinceLastHB = timeSinceLastHB / (1000 * 60);

    if (minutesSinceLastHB < 2) return 'connected';
    if (minutesSinceLastHB < 10) return 'active';
    if (minutesSinceLastHB < 60) return 'idle';
    return 'offline';
  }

  /**
   * Verificar status do dispositivo baseado em heartbeats (síncrono, usa Map local)
   */
  getStatus(imei) {
    const hb = this.heartbeats.get(imei);
    return this.getStatusFromData(hb);
  }

  /**
   * Versão async que busca do Redis
   */
  async getStatusAsync(imei) {
    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();
        const key = `${REDIS_PREFIX}${imei}`;
        const data = await redis.client.hgetall(key);

        if (data && data.timestamp) {
          return this.getStatusFromData({
            timestamp: new Date(data.timestamp),
            count: parseInt(data.count) || 0
          });
        }
      } catch (error) {
        console.error(`[Heartbeat] Redis getStatusAsync error: ${error.message}`);
      }
    }

    // Fallback para Map local
    const hb = this.heartbeats.get(imei);
    return this.getStatusFromData(hb);
  }

  /**
   * Obter estatísticas de heartbeat (busca do Redis para compartilhar entre containers)
   * Contadores resetam a cada hora
   */
  async getStats() {
    // Verificar se deve resetar contadores
    this.checkAndResetStats();

    const stats = {
      total_devices: 0,
      connected: 0,
      active: 0,
      idle: 0,
      offline: 0,
      unknown: 0,
      total_heartbeats: this.hourlyHeartbeats, // Usar contador horário
      devices: [],
      source: 'local' // Indica de onde vieram os dados
    };

    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();

        // Buscar todas as chaves de heartbeat
        const keys = await redis.client.keys(`${REDIS_PREFIX}*`);
        const heartbeatKeys = keys.filter(k => k !== `${REDIS_PREFIX}total` && k.startsWith(REDIS_PREFIX));

        if (heartbeatKeys.length > 0) {
          const pipeline = redis.client.pipeline();
          heartbeatKeys.forEach(key => pipeline.hgetall(key));

          const results = await pipeline.exec();

          results.forEach((result, index) => {
            if (result[0]) return; // erro

            const data = result[1];
            if (!data || !data.timestamp) return;

            const imei = heartbeatKeys[index].replace(REDIS_PREFIX, '');
            const hb = {
              timestamp: new Date(data.timestamp),
              count: parseInt(data.count) || 0
            };

            const status = this.getStatusFromData(hb);
            stats[status] = (stats[status] || 0) + 1;
            stats.total_heartbeats += hb.count;
            stats.total_devices++;

            stats.devices.push({
              imei,
              status,
              count: hb.count,
              last_hb: hb.timestamp.toISOString(),
              time_since_last: this.formatTimeSince(hb.timestamp)
            });
          });
        }

        // Buscar total horário (não acumulado)
        const globalTotal = await redis.client.get(`${REDIS_PREFIX}total`);
        if (globalTotal) {
          stats.total_heartbeats = parseInt(globalTotal);
        }

        stats.source = 'redis';
        stats.reset_in = Math.round((STATS_RESET_INTERVAL - (Date.now() - this.lastStatsReset)) / 60000); // minutos até reset
        return stats;

      } catch (error) {
        console.error(`[Heartbeat] Redis getStats error: ${error.message}, falling back to local`);
      }
    }

    // Fallback para Map local
    const allHeartbeats = Array.from(this.heartbeats.entries());
    stats.total_devices = allHeartbeats.length;

    allHeartbeats.forEach(([imei, data]) => {
      const status = this.getStatusFromData(data);
      stats[status] = (stats[status] || 0) + 1;
      // Não somar counts individuais - usar contador horário

      stats.devices.push({
        imei,
        status,
        count: data.count,
        last_hb: data.timestamp.toISOString(),
        time_since_last: this.formatTimeSince(data.timestamp)
      });
    });

    stats.reset_in = Math.round((STATS_RESET_INTERVAL - (Date.now() - this.lastStatsReset)) / 60000); // minutos até reset
    return stats;
  }

  /**
   * Formatar tempo desde último heartbeat
   */
  formatTimeSince(timestamp) {
    const ts = timestamp instanceof Date ? timestamp : new Date(timestamp);
    const diff = Date.now() - ts.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  // Tempo legível desde último heartbeat (mantido para compatibilidade)
  getTimeSinceLastHB(imei) {
    const hb = this.heartbeats.get(imei);
    if (!hb) return 'N/A';
    return this.formatTimeSince(hb.timestamp);
  }

  /**
   * Limpa entradas antigas do cache
   * No Redis, as chaves expiram automaticamente pelo TTL
   * No Map local, remove manualmente
   */
  async cleanupStaleEntries(maxAgeHours = 24) {
    let removed = 0;
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

    // Limpar Map local
    for (const [imei, data] of this.heartbeats) {
      const timestamp = data.timestamp instanceof Date ? data.timestamp : new Date(data.timestamp);
      const age = now - timestamp.getTime();
      if (age > maxAgeMs) {
        this.heartbeats.delete(imei);
        removed++;
      }
    }

    // Redis limpa automaticamente pelo TTL, mas podemos forçar limpeza
    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();
        const keys = await redis.client.keys(`${REDIS_PREFIX}*`);

        for (const key of keys) {
          if (key === `${REDIS_PREFIX}total`) continue;

          const data = await redis.client.hgetall(key);
          if (!data || !data.timestamp) {
            await redis.client.del(key);
            removed++;
            continue;
          }

          const timestamp = new Date(data.timestamp);
          const age = now - timestamp.getTime();
          if (age > maxAgeMs) {
            await redis.client.del(key);
            removed++;
          }
        }
      } catch (error) {
        console.error(`[Heartbeat] Redis cleanup error: ${error.message}`);
      }
    }

    return removed;
  }

  /**
   * Retorna o tamanho atual do cache (para monitoramento)
   */
  async getCacheSize() {
    if (this.isRedisAvailable()) {
      try {
        const redis = this.getRedis();
        const keys = await redis.client.keys(`${REDIS_PREFIX}*`);
        // Subtrair 1 se existir a chave 'total'
        const hasTotal = keys.includes(`${REDIS_PREFIX}total`);
        return hasTotal ? keys.length - 1 : keys.length;
      } catch (error) {
        console.error(`[Heartbeat] Redis getCacheSize error: ${error.message}`);
      }
    }
    return this.heartbeats.size;
  }

  // Obter histórico em formato JSON
  async toJSON(imei = null) {
    if (imei) {
      return await this.getRecent(imei);
    }
    return await this.getStats();
  }

  /**
   * ✅ Marca dispositivos offline, reseta estado da ignição E ENCERRA VIAGENS
   * Executado periodicamente para manter consistência
   */
  async markOfflineDevices() {
    try {
      const offlineThreshold = 10 * 60 * 1000; // 10 minutos
      const now = new Date();

      // Buscar TODOS os dispositivos do banco
      const dispositivos = await prisma.dispositivo.findMany({
        where: {
          status: 'online'
        },
        select: {
          id: true,
          imei: true,
          ultima_conexao: true,
          viagem_inicio: true,
          viagem_ultima_lat: true,
          viagem_ultima_lng: true
        }
      });

      for (const dispositivo of dispositivos) {
        const ultimaConexao = dispositivo.ultima_conexao?.getTime() || 0;
        const timeSinceLastConnection = now.getTime() - ultimaConexao;

        if (timeSinceLastConnection > offlineThreshold) {
          console.log(`[Heartbeat] 🔴 Marcando ${dispositivo.imei} como OFFLINE (${Math.round(timeSinceLastConnection / 60000)}min sem contato)`);

          if (dispositivo.viagem_inicio) {
            console.log(`[Heartbeat] 🏁 Encerrando viagem aberta para ${dispositivo.imei}`);
            try {
              await viagemService.finalizarViagem(
                dispositivo.id,
                dispositivo.viagem_ultima_lat,
                dispositivo.viagem_ultima_lng,
                now
              );
            } catch (viagemError) {
              console.error(`[Heartbeat] Erro ao encerrar viagem para ${dispositivo.imei}: ${viagemError.message}`);
            }
          }

          await prisma.dispositivo.update({
            where: { imei: dispositivo.imei },
            data: {
              status: 'offline',
              estado_ignicao: 'off'
            }
          }).catch(() => {});
        }
      }

      // Encerrar viagens de dispositivos já offline mas com viagem aberta
      const dispositivosInconsistentes = await prisma.dispositivo.findMany({
        where: {
          status: 'offline',
          viagem_inicio: { not: null }
        },
        select: {
          id: true,
          imei: true,
          viagem_inicio: true,
          viagem_ultima_lat: true,
          viagem_ultima_lng: true
        }
      });

      for (const dispositivo of dispositivosInconsistentes) {
        console.log(`[Heartbeat] ⚠️ Corrigindo inconsistência: ${dispositivo.imei} está OFFLINE mas tem viagem aberta`);
        try {
          await viagemService.finalizarViagem(
            dispositivo.id,
            dispositivo.viagem_ultima_lat,
            dispositivo.viagem_ultima_lng,
            now
          );
        } catch (viagemError) {
          await prisma.dispositivo.update({
            where: { id: dispositivo.id },
            data: {
              viagem_inicio: null,
              viagem_odometro: 0,
              viagem_horimetro: 0,
              viagem_vel_max: 0,
              viagem_vel_soma: 0,
              viagem_vel_count: 0,
              viagem_origem_lat: null,
              viagem_origem_lng: null,
              viagem_ultima_lat: null,
              viagem_ultima_lng: null
            }
          }).catch(() => {});
        }
      }

      // Timeout para encerrar viagens em IDLE
      const idleTimeoutMs = 5 * 60 * 1000;
      const dispositivosComViagem = await prisma.dispositivo.findMany({
        where: {
          viagem_inicio: { not: null }
        },
        select: {
          id: true,
          imei: true,
          estado_ignicao: true,
          viagem_inicio: true,
          viagem_ultima_lat: true,
          viagem_ultima_lng: true,
          conexao_pos_chave: true
        }
      });

      for (const dispositivo of dispositivosComViagem) {
        const ultimaLocalizacao = await prisma.localizacao.findFirst({
          where: { dispositivo_id: dispositivo.id },
          orderBy: { timestamp: 'desc' },
          select: { timestamp: true, velocidade: true, ignicao: true }
        });

        if (!ultimaLocalizacao) continue;

        const timeSinceLastGPS = now.getTime() - ultimaLocalizacao.timestamp.getTime();
        const minutosSemGPS = Math.round(timeSinceLastGPS / 60000);

        const deveEncerrar = (
          timeSinceLastGPS > idleTimeoutMs &&
          ultimaLocalizacao.velocidade === 0 &&
          (dispositivo.estado_ignicao === 'idle' || ultimaLocalizacao.ignicao === true)
        );

        if (deveEncerrar) {
          const tipoInstalacao = dispositivo.conexao_pos_chave ? 'pós-chave' : 'bateria';
          console.log(`[Heartbeat] 🛑 ${dispositivo.imei} (${tipoInstalacao}): ${minutosSemGPS}min sem GPS → Encerrando viagem`);

          try {
            await viagemService.finalizarViagem(
              dispositivo.id,
              dispositivo.viagem_ultima_lat,
              dispositivo.viagem_ultima_lng,
              ultimaLocalizacao.timestamp
            );

            await prisma.dispositivo.update({
              where: { id: dispositivo.id },
              data: { estado_ignicao: 'off' }
            });

            console.log(`[Heartbeat] ✅ ${dispositivo.imei}: Viagem encerrada`);
          } catch (err) {
            console.error(`[Heartbeat] Erro ao encerrar viagem ${dispositivo.imei}: ${err.message}`);
            await prisma.dispositivo.update({
              where: { id: dispositivo.id },
              data: {
                estado_ignicao: 'off',
                viagem_inicio: null,
                viagem_odometro: 0,
                viagem_horimetro: 0,
                viagem_vel_max: 0,
                viagem_vel_soma: 0,
                viagem_vel_count: 0,
                viagem_origem_lat: null,
                viagem_origem_lng: null,
                viagem_ultima_lat: null,
                viagem_ultima_lng: null
              }
            }).catch(() => {});
          }
        }
      }

    } catch (error) {
      console.error('[Heartbeat] Error marking offline devices:', error.message);
    }
  }
}

module.exports = new HeartbeatService();
