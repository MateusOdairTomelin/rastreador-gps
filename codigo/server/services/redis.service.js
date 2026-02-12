/**
 * Redis Service - Cache e Filas para Escalabilidade
 *
 * Funcionalidades:
 * - Cache de posições GPS (última posição de cada rastreador)
 * - Blacklist de tokens JWT (logout instantâneo)
 * - Pub/Sub para WebSocket escalável
 * - Rate limiting distribuído
 * - Filas de processamento
 */

const Redis = require('ioredis');

class RedisService {
  constructor() {
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.isConnected = false;
    this.isEnabled = process.env.REDIS_ENABLED === 'true';

    // Prefixos para organizar as chaves
    this.PREFIX = {
      POSITION: 'pos:',           // pos:{imei} - última posição
      POSITION_HISTORY: 'posh:',  // posh:{imei} - histórico recente
      TOKEN_BLACKLIST: 'tbl:',    // tbl:{token} - tokens invalidados
      RATE_LIMIT: 'rl:',          // rl:{ip}:{endpoint} - rate limiting
      SESSION: 'sess:',           // sess:{userId} - sessões ativas
      DEVICE_STATUS: 'dev:',      // dev:{imei} - status do dispositivo
      STATS: 'stats:',            // stats:{metric} - estatísticas
      PUBSUB: 'channel:'          // channel:{name} - pub/sub channels
    };

    // TTLs padrão (em segundos)
    this.TTL = {
      POSITION: 30,               // 30 segundos (cache curto para atualização rápida)
      POSITION_HISTORY: 3600,     // 1 hora
      TOKEN_BLACKLIST: 86400,     // 24 horas (deve ser >= tempo do token)
      RATE_LIMIT: 60,             // 1 minuto
      SESSION: 604800,            // 7 dias
      DEVICE_STATUS: 600          // 10 minutos
    };
  }

  /**
   * Inicializa conexão com Redis
   */
  async connect() {
    if (!this.isEnabled) {
      console.log('[Redis] Desabilitado via configuração (REDIS_ENABLED=false)');
      return false;
    }

    const config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      db: parseInt(process.env.REDIS_DB) || 0,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => {
        if (times > 10) {
          console.error('[Redis] Máximo de tentativas de reconexão atingido');
          return null;
        }
        const delay = Math.min(times * 200, 5000);
        console.log(`[Redis] Tentando reconectar em ${delay}ms...`);
        return delay;
      },
      maxRetriesPerRequest: 3,
      lazyConnect: true
    };

    try {
      // Cliente principal para comandos
      this.client = new Redis(config);

      // Cliente separado para subscriber (Pub/Sub)
      this.subscriber = new Redis(config);

      // Cliente separado para publisher (Pub/Sub)
      this.publisher = new Redis(config);

      // Event handlers
      this.client.on('connect', () => {
        this.isConnected = true;
        console.log('[Redis] Conectado com sucesso');
      });

      this.client.on('error', (err) => {
        console.error('[Redis] Erro:', err.message);
        this.isConnected = false;
      });

      this.client.on('close', () => {
        console.log('[Redis] Conexão fechada');
        this.isConnected = false;
      });

      // Conectar
      await this.client.connect();
      await this.subscriber.connect();
      await this.publisher.connect();

      // Testar conexão
      await this.client.ping();
      console.log('[Redis] Ping OK - Serviço pronto');

      return true;
    } catch (error) {
      console.error('[Redis] Falha ao conectar:', error.message);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Verifica se Redis está disponível
   */
  isAvailable() {
    return this.isEnabled && this.isConnected && !!this.client;
  }

  // ==================== CACHE DE POSIÇÕES GPS ====================

  /**
   * Salva última posição do rastreador
   */
  async setPosition(imei, position) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.POSITION}${imei}`;
      const data = JSON.stringify({
        ...position,
        cachedAt: new Date().toISOString()
      });

      await this.client.setex(key, this.TTL.POSITION, data);

      // Também adiciona ao histórico recente (lista limitada)
      const histKey = `${this.PREFIX.POSITION_HISTORY}${imei}`;
      await this.client.lpush(histKey, data);
      await this.client.ltrim(histKey, 0, 99); // Mantém últimas 100 posições
      await this.client.expire(histKey, this.TTL.POSITION_HISTORY);

      return true;
    } catch (error) {
      console.error('[Redis] Erro ao salvar posição:', error.message);
      return false;
    }
  }

  /**
   * Busca última posição do rastreador
   */
  async getPosition(imei) {
    if (!this.isAvailable()) return null;

    try {
      const key = `${this.PREFIX.POSITION}${imei}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('[Redis] Erro ao buscar posição:', error.message);
      return null;
    }
  }

  /**
   * Busca últimas posições de múltiplos rastreadores
   */
  async getMultiplePositions(imeis) {
    if (!this.isAvailable() || !imeis?.length) return {};

    try {
      const pipeline = this.client.pipeline();
      imeis.forEach(imei => {
        pipeline.get(`${this.PREFIX.POSITION}${imei}`);
      });

      const results = await pipeline.exec();
      const positions = {};

      results.forEach((result, index) => {
        if (result[1]) {
          positions[imeis[index]] = JSON.parse(result[1]);
        }
      });

      return positions;
    } catch (error) {
      console.error('[Redis] Erro ao buscar múltiplas posições:', error.message);
      return {};
    }
  }

  /**
   * Busca histórico recente de posições
   */
  async getPositionHistory(imei, limit = 50) {
    if (!this.isAvailable()) return [];

    try {
      const key = `${this.PREFIX.POSITION_HISTORY}${imei}`;
      const data = await this.client.lrange(key, 0, limit - 1);
      return data.map(item => JSON.parse(item));
    } catch (error) {
      console.error('[Redis] Erro ao buscar histórico:', error.message);
      return [];
    }
  }

  // ==================== BLACKLIST DE TOKENS JWT ====================

  /**
   * Adiciona token à blacklist (logout)
   */
  async blacklistToken(token, expiresInSeconds = null) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.TOKEN_BLACKLIST}${token}`;
      const ttl = expiresInSeconds || this.TTL.TOKEN_BLACKLIST;

      await this.client.setex(key, ttl, '1');
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao blacklistar token:', error.message);
      return false;
    }
  }

  /**
   * Verifica se token está na blacklist
   */
  async isTokenBlacklisted(token) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.TOKEN_BLACKLIST}${token}`;
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      console.error('[Redis] Erro ao verificar blacklist:', error.message);
      return false;
    }
  }

  /**
   * Invalida todos os tokens de um usuário
   */
  async invalidateUserTokens(userId) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.SESSION}${userId}:invalidated`;
      await this.client.setex(key, this.TTL.SESSION, Date.now().toString());
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao invalidar tokens:', error.message);
      return false;
    }
  }

  /**
   * Verifica se tokens do usuário foram invalidados após determinado timestamp
   */
  async areUserTokensInvalidated(userId, tokenIssuedAt) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.SESSION}${userId}:invalidated`;
      const invalidatedAt = await this.client.get(key);

      if (!invalidatedAt) return false;
      return parseInt(invalidatedAt) > tokenIssuedAt;
    } catch (error) {
      console.error('[Redis] Erro ao verificar invalidação:', error.message);
      return false;
    }
  }

  // ==================== RATE LIMITING ====================

  /**
   * Incrementa contador de rate limiting
   * Retorna: { allowed: boolean, remaining: number, resetIn: number }
   */
  async checkRateLimit(identifier, maxRequests = 100, windowSeconds = 60) {
    if (!this.isAvailable()) {
      return { allowed: true, remaining: maxRequests, resetIn: 0 };
    }

    try {
      const key = `${this.PREFIX.RATE_LIMIT}${identifier}`;
      const now = Date.now();
      const windowStart = now - (windowSeconds * 1000);

      // Remove entradas antigas
      await this.client.zremrangebyscore(key, 0, windowStart);

      // Conta requisições na janela
      const count = await this.client.zcard(key);

      if (count >= maxRequests) {
        // Busca tempo até reset
        const oldest = await this.client.zrange(key, 0, 0, 'WITHSCORES');
        const resetIn = oldest.length > 1
          ? Math.ceil((parseInt(oldest[1]) + (windowSeconds * 1000) - now) / 1000)
          : windowSeconds;

        return { allowed: false, remaining: 0, resetIn };
      }

      // Adiciona nova requisição
      await this.client.zadd(key, now, `${now}-${Math.random()}`);
      await this.client.expire(key, windowSeconds + 1);

      return {
        allowed: true,
        remaining: maxRequests - count - 1,
        resetIn: windowSeconds
      };
    } catch (error) {
      console.error('[Redis] Erro no rate limiting:', error.message);
      return { allowed: true, remaining: maxRequests, resetIn: 0 };
    }
  }

  // ==================== PUB/SUB PARA WEBSOCKET ====================

  /**
   * Publica mensagem em um canal
   */
  async publish(channel, message) {
    if (!this.isAvailable()) return false;

    try {
      const fullChannel = `${this.PREFIX.PUBSUB}${channel}`;
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      await this.publisher.publish(fullChannel, data);
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao publicar:', error.message);
      return false;
    }
  }

  /**
   * Inscreve em um canal
   */
  async subscribe(channel, callback) {
    if (!this.isAvailable()) return false;

    try {
      const fullChannel = `${this.PREFIX.PUBSUB}${channel}`;

      this.subscriber.subscribe(fullChannel, (err) => {
        if (err) {
          console.error('[Redis] Erro ao inscrever:', err.message);
          return;
        }
        console.log(`[Redis] Inscrito no canal: ${channel}`);
      });

      this.subscriber.on('message', (ch, message) => {
        if (ch === fullChannel) {
          try {
            const data = JSON.parse(message);
            callback(data);
          } catch {
            callback(message);
          }
        }
      });

      return true;
    } catch (error) {
      console.error('[Redis] Erro ao inscrever:', error.message);
      return false;
    }
  }

  // ==================== STATUS DE DISPOSITIVOS ====================

  /**
   * Atualiza status do dispositivo
   */
  async setDeviceStatus(imei, status) {
    if (!this.isAvailable()) return false;

    try {
      const key = `${this.PREFIX.DEVICE_STATUS}${imei}`;
      const data = JSON.stringify({
        ...status,
        updatedAt: new Date().toISOString()
      });

      await this.client.setex(key, this.TTL.DEVICE_STATUS, data);
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao salvar status:', error.message);
      return false;
    }
  }

  /**
   * Busca status do dispositivo
   */
  async getDeviceStatus(imei) {
    if (!this.isAvailable()) return null;

    try {
      const key = `${this.PREFIX.DEVICE_STATUS}${imei}`;
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('[Redis] Erro ao buscar status:', error.message);
      return null;
    }
  }

  /**
   * Busca todos os dispositivos online
   */
  async getOnlineDevices() {
    if (!this.isAvailable()) return [];

    try {
      const keys = await this.client.keys(`${this.PREFIX.DEVICE_STATUS}*`);
      if (!keys.length) return [];

      const pipeline = this.client.pipeline();
      keys.forEach(key => pipeline.get(key));

      const results = await pipeline.exec();
      const devices = [];

      results.forEach((result, index) => {
        if (result[1]) {
          const imei = keys[index].replace(this.PREFIX.DEVICE_STATUS, '');
          devices.push({
            imei,
            ...JSON.parse(result[1])
          });
        }
      });

      return devices;
    } catch (error) {
      console.error('[Redis] Erro ao buscar dispositivos online:', error.message);
      return [];
    }
  }

  // ==================== ESTATÍSTICAS ====================

  /**
   * Incrementa contador de estatísticas
   */
  async incrementStat(metric, value = 1) {
    if (!this.isAvailable()) return;

    try {
      const key = `${this.PREFIX.STATS}${metric}`;
      await this.client.incrby(key, value);
    } catch (error) {
      console.error('[Redis] Erro ao incrementar stat:', error.message);
    }
  }

  /**
   * Busca estatísticas
   */
  async getStats() {
    if (!this.isAvailable()) return {};

    try {
      const keys = await this.client.keys(`${this.PREFIX.STATS}*`);
      if (!keys.length) return {};

      const pipeline = this.client.pipeline();
      keys.forEach(key => pipeline.get(key));

      const results = await pipeline.exec();
      const stats = {};

      results.forEach((result, index) => {
        const metric = keys[index].replace(this.PREFIX.STATS, '');
        stats[metric] = parseInt(result[1]) || 0;
      });

      return stats;
    } catch (error) {
      console.error('[Redis] Erro ao buscar stats:', error.message);
      return {};
    }
  }

  // ==================== UTILITÁRIOS ====================

  /**
   * Salva valor com chave arbitrária (para uso geral)
   */
  async set(key, value, ttlSeconds = null) {
    if (!this.isAvailable()) return false;

    try {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao salvar:', error.message);
      return false;
    }
  }

  /**
   * Busca valor por chave arbitrária (para uso geral)
   */
  async get(key) {
    if (!this.isAvailable()) return null;

    try {
      return await this.client.get(key);
    } catch (error) {
      console.error('[Redis] Erro ao buscar:', error.message);
      return null;
    }
  }

  /**
   * Remove chave (para uso geral)
   */
  async del(key) {
    if (!this.isAvailable()) return false;

    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error('[Redis] Erro ao deletar:', error.message);
      return false;
    }
  }

  /**
   * Limpa todas as chaves com determinado prefixo
   */
  async clearByPrefix(prefix) {
    if (!this.isAvailable()) return 0;

    try {
      const keys = await this.client.keys(`${prefix}*`);
      if (!keys.length) return 0;

      await this.client.del(...keys);
      return keys.length;
    } catch (error) {
      console.error('[Redis] Erro ao limpar por prefixo:', error.message);
      return 0;
    }
  }

  /**
   * Busca informações do Redis
   */
  async getInfo() {
    if (!this.isAvailable()) {
      return { connected: false, enabled: this.isEnabled };
    }

    try {
      const info = await this.client.info('memory');
      const dbSize = await this.client.dbsize();

      const memoryMatch = info.match(/used_memory_human:(\S+)/);

      return {
        connected: true,
        enabled: this.isEnabled,
        memoryUsed: memoryMatch ? memoryMatch[1] : 'N/A',
        keys: dbSize
      };
    } catch (error) {
      console.error('[Redis] Erro ao buscar info:', error.message);
      return { connected: false, enabled: this.isEnabled, error: error.message };
    }
  }

  /**
   * Retorna o cliente Redis para uso externo (ex: CSRF tokens)
   * @returns {Redis|null} Cliente Redis ou null se não conectado
   */
  getClient() {
    if (!this.isAvailable()) {
      return null;
    }
    return this.client;
  }

  /**
   * Adquire um lock distribuído (para evitar race conditions entre processadores)
   * @param {string} key - Chave do lock
   * @param {number} ttlSeconds - Tempo de expiração em segundos
   * @returns {boolean} - true se adquiriu o lock, false caso contrário
   */
  async acquireLock(key, ttlSeconds = 5) {
    if (!this.isAvailable()) {
      // Se Redis não disponível, permitir (fail open)
      return true;
    }

    try {
      // SETNX retorna 'OK' se conseguiu setar (lock adquirido)
      const result = await this.client.set(key, Date.now().toString(), 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      console.error(`[Redis] Erro ao adquirir lock ${key}:`, error.message);
      return true; // Fail open
    }
  }

  /**
   * Libera um lock distribuído
   * @param {string} key - Chave do lock
   */
  async releaseLock(key) {
    if (!this.isAvailable()) {
      return;
    }

    try {
      await this.client.del(key);
    } catch (error) {
      console.error(`[Redis] Erro ao liberar lock ${key}:`, error.message);
    }
  }

  /**
   * Fecha conexões
   */
  async disconnect() {
    try {
      if (this.client) await this.client.quit();
      if (this.subscriber) await this.subscriber.quit();
      if (this.publisher) await this.publisher.quit();

      this.isConnected = false;
      console.log('[Redis] Desconectado');
    } catch (error) {
      console.error('[Redis] Erro ao desconectar:', error.message);
    }
  }
}

// Singleton
const redisService = new RedisService();

module.exports = redisService;
