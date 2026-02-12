/**
 * Queue Service - Processamento Assíncrono com Bull
 * Sistema de Rastreamento Veicular
 *
 * Filas disponíveis:
 * - location: Processamento de localizações GPS
 * - alarm: Processamento de alarmes e alertas
 * - trip: Cálculo e atualização de viagens
 * - obd2: Processamento de dados OBD2
 * - notification: Envio de notificações (futuro)
 */

const Bull = require('bull');

// Configuração do Redis para as filas
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_QUEUE_DB) || 1, // DB separado para filas
};

// Opções padrão para todas as filas
const DEFAULT_QUEUE_OPTIONS = {
  redis: REDIS_CONFIG,
  defaultJobOptions: {
    removeOnComplete: 100, // Manter últimos 100 jobs completados
    removeOnFail: 500,     // Manter últimos 500 jobs com falha
    attempts: 3,           // 3 tentativas em caso de falha
    backoff: {
      type: 'exponential',
      delay: 1000,         // Delay inicial de 1s
    },
  },
  settings: {
    stalledInterval: 30000,  // Verificar jobs travados a cada 30s
    maxStalledCount: 2,      // Máximo de vezes que um job pode travar
  },
};

class QueueService {
  constructor() {
    this.queues = {};
    this.processors = {};
    this.isEnabled = process.env.QUEUE_ENABLED !== 'false';
    this.isWorker = process.env.QUEUE_WORKER === 'true' || process.env.IS_MASTER === 'true';

    // Estatísticas
    this.stats = {
      processed: 0,
      failed: 0,
      startTime: Date.now(),
    };
  }

  /**
   * Inicializa todas as filas
   */
  async init() {
    if (!this.isEnabled) {
      console.log('[Queue] ⚠️  Filas desabilitadas (QUEUE_ENABLED=false)');
      return false;
    }

    try {
      // Criar filas
      this.queues.location = this.createQueue('location', {
        limiter: {
          max: 1000,        // Máximo 1000 jobs
          duration: 1000,   // Por segundo
        },
      });

      this.queues.alarm = this.createQueue('alarm', {
        defaultJobOptions: {
          ...DEFAULT_QUEUE_OPTIONS.defaultJobOptions,
          priority: 1, // Alta prioridade
        },
      });

      this.queues.trip = this.createQueue('trip', {
        limiter: {
          max: 500,
          duration: 1000,
        },
      });

      this.queues.obd2 = this.createQueue('obd2', {
        limiter: {
          max: 500,
          duration: 1000,
        },
      });

      this.queues.notification = this.createQueue('notification', {
        defaultJobOptions: {
          ...DEFAULT_QUEUE_OPTIONS.defaultJobOptions,
          attempts: 5, // Mais tentativas para notificações
        },
      });

      // Configurar eventos globais
      this.setupGlobalEvents();

      console.log('[Queue] ✅ Serviço de filas inicializado');
      console.log(`[Queue] 📊 Filas criadas: ${Object.keys(this.queues).join(', ')}`);
      console.log(`[Queue] 🔧 Modo: ${this.isWorker ? 'WORKER (processando jobs)' : 'PRODUCER (apenas enviando)'}`);

      return true;
    } catch (error) {
      console.error('[Queue] ❌ Erro ao inicializar filas:', error.message);
      this.isEnabled = false;
      return false;
    }
  }

  /**
   * Cria uma fila com configurações específicas
   */
  createQueue(name, options = {}) {
    const queue = new Bull(name, {
      ...DEFAULT_QUEUE_OPTIONS,
      ...options,
    });

    // Eventos da fila
    queue.on('error', (error) => {
      console.error(`[Queue:${name}] ❌ Erro:`, error.message);
    });

    queue.on('waiting', (jobId) => {
      // Log apenas em debug
      if (process.env.QUEUE_DEBUG === 'true') {
        console.log(`[Queue:${name}] ⏳ Job ${jobId} aguardando`);
      }
    });

    queue.on('active', (job) => {
      if (process.env.QUEUE_DEBUG === 'true') {
        console.log(`[Queue:${name}] 🔄 Job ${job.id} iniciado`);
      }
    });

    queue.on('completed', (job, result) => {
      this.stats.processed++;
      if (process.env.QUEUE_DEBUG === 'true') {
        console.log(`[Queue:${name}] ✅ Job ${job.id} completado`);
      }
    });

    queue.on('failed', (job, err) => {
      this.stats.failed++;
      console.error(`[Queue:${name}] ❌ Job ${job.id} falhou: ${err.message}`);
    });

    queue.on('stalled', (job) => {
      console.warn(`[Queue:${name}] ⚠️ Job ${job.id} travado, será reprocessado`);
    });

    return queue;
  }

  /**
   * Configura eventos globais para monitoramento
   */
  setupGlobalEvents() {
    // Log de estatísticas a cada minuto
    setInterval(() => {
      const uptime = Math.round((Date.now() - this.stats.startTime) / 1000 / 60);
      console.log(`[Queue] 📊 Stats: ${this.stats.processed} processados, ${this.stats.failed} falhas (uptime: ${uptime}min)`);
    }, 60000);
  }

  /**
   * Registra um processador para uma fila
   */
  registerProcessor(queueName, processor, concurrency = 5) {
    if (!this.isEnabled || !this.isWorker) {
      return;
    }

    const queue = this.queues[queueName];
    if (!queue) {
      console.error(`[Queue] ❌ Fila '${queueName}' não encontrada`);
      return;
    }

    queue.process(concurrency, processor);
    this.processors[queueName] = { processor, concurrency };

    console.log(`[Queue] 🔧 Processador registrado para '${queueName}' (concurrency: ${concurrency})`);
  }

  /**
   * Adiciona um job à fila
   */
  async addJob(queueName, data, options = {}) {
    if (!this.isEnabled) {
      return null;
    }

    const queue = this.queues[queueName];
    if (!queue) {
      console.error(`[Queue] ❌ Fila '${queueName}' não encontrada`);
      return null;
    }

    try {
      const job = await queue.add(data, options);
      return job;
    } catch (error) {
      console.error(`[Queue:${queueName}] ❌ Erro ao adicionar job:`, error.message);
      return null;
    }
  }

  /**
   * Adiciona múltiplos jobs em lote (mais eficiente)
   */
  async addBulk(queueName, jobs) {
    if (!this.isEnabled) {
      return [];
    }

    const queue = this.queues[queueName];
    if (!queue) {
      console.error(`[Queue] ❌ Fila '${queueName}' não encontrada`);
      return [];
    }

    try {
      const bulkJobs = jobs.map(job => ({
        data: job.data,
        opts: job.options || {},
      }));
      return await queue.addBulk(bulkJobs);
    } catch (error) {
      console.error(`[Queue:${queueName}] ❌ Erro ao adicionar jobs em lote:`, error.message);
      return [];
    }
  }

  /**
   * Obtém estatísticas de uma fila
   */
  async getQueueStats(queueName) {
    const queue = this.queues[queueName];
    if (!queue) {
      return null;
    }

    try {
      const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getCompletedCount(),
        queue.getFailedCount(),
        queue.getDelayedCount(),
        queue.getPausedCount(),
      ]);

      return {
        name: queueName,
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused,
        total: waiting + active + delayed + paused,
      };
    } catch (error) {
      console.error(`[Queue:${queueName}] ❌ Erro ao obter stats:`, error.message);
      return null;
    }
  }

  /**
   * Obtém estatísticas de todas as filas
   */
  async getAllStats() {
    const stats = {
      enabled: this.isEnabled,
      isWorker: this.isWorker,
      global: {
        processed: this.stats.processed,
        failed: this.stats.failed,
        uptime: Math.round((Date.now() - this.stats.startTime) / 1000),
      },
      queues: {},
    };

    for (const queueName of Object.keys(this.queues)) {
      stats.queues[queueName] = await this.getQueueStats(queueName);
    }

    return stats;
  }

  /**
   * Pausa uma fila
   */
  async pauseQueue(queueName) {
    const queue = this.queues[queueName];
    if (queue) {
      await queue.pause();
      console.log(`[Queue] ⏸️  Fila '${queueName}' pausada`);
    }
  }

  /**
   * Resume uma fila
   */
  async resumeQueue(queueName) {
    const queue = this.queues[queueName];
    if (queue) {
      await queue.resume();
      console.log(`[Queue] ▶️  Fila '${queueName}' resumida`);
    }
  }

  /**
   * Limpa jobs completados/falhos de uma fila
   */
  async cleanQueue(queueName, grace = 3600000) {
    const queue = this.queues[queueName];
    if (queue) {
      await queue.clean(grace, 'completed');
      await queue.clean(grace, 'failed');
      console.log(`[Queue] 🧹 Fila '${queueName}' limpa`);
    }
  }

  /**
   * Encerra todas as filas graciosamente
   */
  async shutdown() {
    console.log('[Queue] 🛑 Encerrando filas...');

    for (const [name, queue] of Object.entries(this.queues)) {
      try {
        await queue.close();
        console.log(`[Queue] ✅ Fila '${name}' encerrada`);
      } catch (error) {
        console.error(`[Queue] ❌ Erro ao encerrar '${name}':`, error.message);
      }
    }
  }
}

// Singleton
const queueService = new QueueService();

module.exports = queueService;
