/**
 * Redis Streams Service - Comunicação entre TCP Gateway e Processors
 *
 * Arquitetura de Mensagens:
 * - TCP Gateway publica pacotes brutos em streams
 * - Processors consomem e processam dados
 * - Consumer groups garantem processamento distribuído
 *
 * Streams:
 * - gps:packets:location - Pacotes de localização (alta prioridade)
 * - gps:packets:obd2 - Pacotes OBD2 (média prioridade)
 * - gps:packets:alarm - Pacotes de alarme (crítica)
 * - gps:packets:status - Heartbeat/Status (baixa prioridade)
 * - gps:commands - Comandos para enviar aos dispositivos
 */

const Redis = require('ioredis');

// Configuração do Redis
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_STREAMS_DB) || 2, // DB separado para streams
  retryStrategy: (times) => {
    if (times > 10) return null;
    return Math.min(times * 200, 5000);
  },
  maxRetriesPerRequest: 3,
  lazyConnect: true
};

// Nomes dos streams
const STREAMS = {
  LOCATION: 'gps:packets:location',
  OBD2: 'gps:packets:obd2',
  ALARM: 'gps:packets:alarm',
  STATUS: 'gps:packets:status',
  COMMANDS: 'gps:commands',
  // Stream para resposta de comandos (gateway → API)
  COMMAND_RESPONSES: 'gps:command:responses',
  // Stream para eventos do sistema
  EVENTS: 'gps:events'
};

// Consumer groups
const CONSUMER_GROUPS = {
  LOCATION: 'location-processors',
  OBD2: 'obd2-processors',
  ALARM: 'alarm-processors',
  STATUS: 'status-processors'
};

class RedisStreamsService {
  constructor() {
    this.client = null;
    this.subscriber = null;
    this.isConnected = false;
    this.isEnabled = process.env.REDIS_ENABLED === 'true';
    // Usar WORKER_ID para garantir consumers únicos em ambiente Docker
    this.consumerId = process.env.CONSUMER_ID || process.env.WORKER_ID || `consumer-${process.pid}`;

    // Estatísticas
    this.stats = {
      published: 0,
      consumed: 0,
      errors: 0,
      startTime: Date.now()
    };
  }

  /**
   * Conecta ao Redis
   */
  async connect() {
    if (!this.isEnabled) {
      console.log('[RedisStreams] Desabilitado via configuração');
      return false;
    }

    try {
      this.client = new Redis(REDIS_CONFIG);
      this.subscriber = new Redis(REDIS_CONFIG);

      this.client.on('connect', () => {
        this.isConnected = true;
        console.log('[RedisStreams] Conectado');
      });

      this.client.on('error', (err) => {
        console.error('[RedisStreams] Erro:', err.message);
        this.isConnected = false;
      });

      await this.client.connect();
      await this.subscriber.connect();
      await this.client.ping();

      // Criar consumer groups para cada stream
      await this.ensureConsumerGroups();

      console.log('[RedisStreams] Serviço pronto');
      return true;
    } catch (error) {
      console.error('[RedisStreams] Falha ao conectar:', error.message);
      return false;
    }
  }

  /**
   * Garante que os consumer groups existem
   */
  async ensureConsumerGroups() {
    const groupConfigs = [
      { stream: STREAMS.LOCATION, group: CONSUMER_GROUPS.LOCATION },
      { stream: STREAMS.OBD2, group: CONSUMER_GROUPS.OBD2 },
      { stream: STREAMS.ALARM, group: CONSUMER_GROUPS.ALARM },
      { stream: STREAMS.STATUS, group: CONSUMER_GROUPS.STATUS }
    ];

    for (const { stream, group } of groupConfigs) {
      try {
        // Tentar criar consumer group (MKSTREAM cria o stream automaticamente se não existir)
        // NÃO criar mensagem dummy 'init' pois causa erros nos processors
        await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
        console.log(`[RedisStreams] Consumer group criado: ${group} em ${stream}`);
      } catch (error) {
        // Ignorar erro se grupo já existe
        if (!error.message.includes('BUSYGROUP')) {
          console.warn(`[RedisStreams] Aviso ao criar grupo ${group}:`, error.message);
        }
      }
    }
  }

  /**
   * Verifica se está disponível
   */
  isAvailable() {
    return this.isEnabled && this.isConnected && this.client;
  }

  // ==================== PUBLICAÇÃO ====================

  /**
   * Publica pacote de localização
   */
  async publishLocation(imei, data, gatewayId = 'gw-1') {
    return this.publish(STREAMS.LOCATION, {
      imei,
      type: 'location',
      data,
      gateway_id: gatewayId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Publica pacote OBD2
   */
  async publishOBD2(imei, data, gatewayId = 'gw-1') {
    return this.publish(STREAMS.OBD2, {
      imei,
      type: 'obd2',
      data,
      gateway_id: gatewayId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Publica pacote de alarme (prioridade alta)
   */
  async publishAlarm(imei, data, gatewayId = 'gw-1') {
    return this.publish(STREAMS.ALARM, {
      imei,
      type: 'alarm',
      data,
      gateway_id: gatewayId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Publica pacote de status/heartbeat
   */
  async publishStatus(imei, data, gatewayId = 'gw-1') {
    return this.publish(STREAMS.STATUS, {
      imei,
      type: 'status',
      data,
      gateway_id: gatewayId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Publica comando para dispositivo
   * Gateway monitora este stream e envia para o device
   */
  async publishCommand(imei, command, commandId = null) {
    const id = commandId || `cmd-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    return this.publish(STREAMS.COMMANDS, {
      command_id: id,
      imei,
      command,
      timestamp: new Date().toISOString(),
      status: 'pending'
    });
  }

  /**
   * Método genérico de publicação
   */
  async publish(stream, message) {
    if (!this.isAvailable()) {
      console.warn('[RedisStreams] Não disponível, mensagem descartada');
      return null;
    }

    try {
      const fields = [];
      for (const [key, value] of Object.entries(message)) {
        fields.push(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }

      // MAXLEN ~50000 mantém últimas 50k mensagens por stream (suporta ~1000 rastreadores)
      const messageId = await this.client.xadd(stream, 'MAXLEN', '~', '50000', '*', ...fields);
      this.stats.published++;

      return messageId;
    } catch (error) {
      console.error(`[RedisStreams] Erro ao publicar em ${stream}:`, error.message);
      this.stats.errors++;
      return null;
    }
  }

  // ==================== CONSUMO ====================

  /**
   * Consome mensagens de localização
   * @param {Function} processor - Função async que processa cada mensagem
   * @param {number} count - Número de mensagens por lote
   * @param {number} blockMs - Tempo de bloqueio aguardando mensagens
   */
  async consumeLocation(processor, count = 10, blockMs = 5000) {
    return this.consume(STREAMS.LOCATION, CONSUMER_GROUPS.LOCATION, processor, count, blockMs);
  }

  /**
   * Consome mensagens OBD2
   */
  async consumeOBD2(processor, count = 10, blockMs = 5000) {
    return this.consume(STREAMS.OBD2, CONSUMER_GROUPS.OBD2, processor, count, blockMs);
  }

  /**
   * Consome mensagens de alarme
   */
  async consumeAlarm(processor, count = 5, blockMs = 1000) {
    return this.consume(STREAMS.ALARM, CONSUMER_GROUPS.ALARM, processor, count, blockMs);
  }

  /**
   * Consome mensagens de status
   */
  async consumeStatus(processor, count = 20, blockMs = 5000) {
    return this.consume(STREAMS.STATUS, CONSUMER_GROUPS.STATUS, processor, count, blockMs);
  }

  /**
   * Consome comandos (usado pelo TCP Gateway)
   */
  async consumeCommands(processor, count = 5, blockMs = 1000) {
    if (!this.isAvailable()) return [];

    try {
      // Ler mensagens pendentes primeiro
      const messages = await this.client.xread(
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', STREAMS.COMMANDS, '$'
      );

      if (!messages || messages.length === 0) return [];

      const results = [];
      for (const [stream, entries] of messages) {
        for (const [id, fields] of entries) {
          const message = this.parseFields(fields);
          message._id = id;

          try {
            await processor(message);
            // Remover mensagem após processamento
            await this.client.xdel(STREAMS.COMMANDS, id);
            results.push({ id, success: true });
          } catch (error) {
            console.error(`[RedisStreams] Erro ao processar comando ${id}:`, error.message);
            results.push({ id, success: false, error: error.message });
          }
        }
      }

      return results;
    } catch (error) {
      console.error('[RedisStreams] Erro ao consumir comandos:', error.message);
      return [];
    }
  }

  /**
   * Método genérico de consumo com consumer group
   */
  async consume(stream, group, processor, count = 10, blockMs = 5000) {
    if (!this.isAvailable()) return [];

    try {
      // Ler mensagens pendentes primeiro, depois novas
      const messages = await this.client.xreadgroup(
        'GROUP', group, this.consumerId,
        'COUNT', count,
        'BLOCK', blockMs,
        'STREAMS', stream, '>'
      );

      if (!messages || messages.length === 0) return [];

      const results = [];
      for (const [streamName, entries] of messages) {
        for (const [id, fields] of entries) {
          const message = this.parseFields(fields);
          message._id = id;
          message._stream = streamName;

          try {
            await processor(message);
            // Confirmar processamento (ACK)
            await this.client.xack(stream, group, id);
            this.stats.consumed++;
            results.push({ id, success: true });
          } catch (error) {
            console.error(`[RedisStreams] Erro ao processar ${id}:`, error.message);
            this.stats.errors++;
            results.push({ id, success: false, error: error.message });
          }
        }
      }

      return results;
    } catch (error) {
      console.error(`[RedisStreams] Erro ao consumir ${stream}:`, error.message);
      return [];
    }
  }

  /**
   * Processa mensagens pendentes (não confirmadas)
   */
  async processPending(stream, group, processor, count = 10) {
    if (!this.isAvailable()) return [];

    try {
      // Buscar mensagens pendentes
      const pending = await this.client.xpending(stream, group, '-', '+', count);
      if (!pending || pending.length === 0) return [];

      const results = [];
      for (const [id, consumer, idleTime, deliveryCount] of pending) {
        // Se idle > 60s, reclamar mensagem
        if (idleTime > 60000) {
          try {
            const claimed = await this.client.xclaim(
              stream, group, this.consumerId,
              60000, // min idle time
              id
            );

            if (claimed && claimed.length > 0) {
              const [claimedId, fields] = claimed[0];
              const message = this.parseFields(fields);
              message._id = claimedId;
              message._reclaimed = true;
              message._deliveryCount = deliveryCount;

              await processor(message);
              await this.client.xack(stream, group, claimedId);
              results.push({ id: claimedId, success: true, reclaimed: true });
            }
          } catch (error) {
            console.error(`[RedisStreams] Erro ao reclamar ${id}:`, error.message);
          }
        }
      }

      return results;
    } catch (error) {
      console.error(`[RedisStreams] Erro ao processar pendentes:`, error.message);
      return [];
    }
  }

  /**
   * Converte array de campos Redis para objeto
   */
  parseFields(fields) {
    const obj = {};
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      let value = fields[i + 1];

      // Tentar parse JSON
      if (value.startsWith('{') || value.startsWith('[')) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          // Manter como string
        }
      }

      obj[key] = value;
    }
    return obj;
  }

  // ==================== SESSÕES TCP ====================

  /**
   * Registra sessão TCP (gateway → IMEI)
   */
  async registerSession(imei, gatewayId, socketInfo = {}) {
    if (!this.isAvailable()) return false;

    try {
      const key = `gps:session:${imei}`;
      await this.client.hset(key, {
        gateway_id: gatewayId,
        connected_at: new Date().toISOString(),
        remote_address: socketInfo.remoteAddress || '',
        remote_port: String(socketInfo.remotePort || ''),
        last_activity: new Date().toISOString()
      });
      await this.client.expire(key, 3600); // 1 hora TTL
      return true;
    } catch (error) {
      console.error('[RedisStreams] Erro ao registrar sessão:', error.message);
      return false;
    }
  }

  /**
   * Atualiza atividade da sessão
   */
  async updateSessionActivity(imei) {
    if (!this.isAvailable()) return false;

    try {
      const key = `gps:session:${imei}`;
      await this.client.hset(key, 'last_activity', new Date().toISOString());
      await this.client.expire(key, 3600);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Remove sessão TCP
   */
  async removeSession(imei) {
    if (!this.isAvailable()) return false;

    try {
      await this.client.del(`gps:session:${imei}`);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Busca gateway de uma sessão
   */
  async getSessionGateway(imei) {
    if (!this.isAvailable()) return null;

    try {
      const key = `gps:session:${imei}`;
      return await this.client.hget(key, 'gateway_id');
    } catch (error) {
      return null;
    }
  }

  /**
   * Lista todas as sessões ativas
   */
  async getAllSessions() {
    if (!this.isAvailable()) return [];

    try {
      const keys = await this.client.keys('gps:session:*');
      if (!keys.length) return [];

      const sessions = [];
      for (const key of keys) {
        const imei = key.replace('gps:session:', '');
        const data = await this.client.hgetall(key);
        sessions.push({ imei, ...data });
      }

      return sessions;
    } catch (error) {
      return [];
    }
  }

  // ==================== ESTATÍSTICAS ====================

  /**
   * Retorna estatísticas dos streams
   */
  async getStreamStats() {
    if (!this.isAvailable()) return null;

    try {
      const stats = {};

      for (const [name, stream] of Object.entries(STREAMS)) {
        const info = await this.client.xinfo('STREAM', stream).catch(() => null);
        if (info) {
          const infoObj = {};
          for (let i = 0; i < info.length; i += 2) {
            infoObj[info[i]] = info[i + 1];
          }
          stats[name] = {
            length: infoObj.length || 0,
            firstEntry: infoObj['first-entry'] ? infoObj['first-entry'][0] : null,
            lastEntry: infoObj['last-entry'] ? infoObj['last-entry'][0] : null,
            groups: infoObj.groups || 0
          };
        }
      }

      return {
        streams: stats,
        service: {
          published: this.stats.published,
          consumed: this.stats.consumed,
          errors: this.stats.errors,
          uptime: Math.round((Date.now() - this.stats.startTime) / 1000)
        }
      };
    } catch (error) {
      console.error('[RedisStreams] Erro ao obter stats:', error.message);
      return null;
    }
  }

  // ==================== UTILITÁRIOS ====================

  /**
   * Fecha conexões
   */
  async disconnect() {
    try {
      if (this.client) await this.client.quit();
      if (this.subscriber) await this.subscriber.quit();
      this.isConnected = false;
      console.log('[RedisStreams] Desconectado');
    } catch (error) {
      console.error('[RedisStreams] Erro ao desconectar:', error.message);
    }
  }
}

// Constantes exportadas
module.exports = {
  RedisStreamsService,
  STREAMS,
  CONSUMER_GROUPS,
  // Singleton para uso comum
  redisStreams: new RedisStreamsService()
};
