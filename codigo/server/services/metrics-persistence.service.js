/**
 * Serviço de Persistência de Métricas do Sistema
 * Salva métricas no PostgreSQL e carrega histórico
 */
const prisma = require('../db/prisma');

class MetricsPersistenceService {
  constructor() {
    this.saveInterval = null;
    this.historyCache = {
      timestamps: [],
      cpu: [],
      memory: [],
      disk: [],
      load: [],
      maxPoints: 60
    };
  }

  /**
   * Salva métricas no banco de dados
   */
  async save(metrics) {
    try {
      await prisma.metricaSistema.create({
        data: {
          cpu_usage: metrics.cpu.usage,
          cpu_cores: metrics.cpu.cores,
          mem_usage: metrics.memory.usage,
          mem_total: BigInt(metrics.memory.total),
          mem_used: BigInt(metrics.memory.used),
          disk_usage: metrics.disk.usage,
          disk_total: BigInt(metrics.disk.total || 0),
          disk_used: BigInt(metrics.disk.used || 0),
          load_1min: metrics.loadAverage['1min'],
          load_5min: metrics.loadAverage['5min'],
          load_15min: metrics.loadAverage['15min'],
          process_uptime: metrics.process.uptime,
          process_memory: BigInt(process.memoryUsage().heapUsed),
          os_uptime: metrics.os.uptime,
          alerts: metrics.alerts ? JSON.stringify(metrics.alerts) : null,
          health_status: metrics.healthStatus || 'healthy'
        }
      });
      return true;
    } catch (error) {
      console.error('[MetricsPersistence] Erro ao salvar:', error.message);
      return false;
    }
  }

  /**
   * Carrega histórico de métricas do banco
   * @param {number} limit - Número de registros (padrão: 60 = 5 minutos)
   */
  async loadHistory(limit = 60) {
    try {
      const records = await prisma.metricaSistema.findMany({
        orderBy: { timestamp: 'desc' },
        take: limit
      });

      // Reverter para ordem cronológica
      records.reverse();

      this.historyCache = {
        timestamps: records.map(r => r.timestamp.toISOString()),
        cpu: records.map(r => r.cpu_usage),
        memory: records.map(r => r.mem_usage),
        disk: records.map(r => r.disk_usage),
        load: records.map(r => r.load_1min),
        maxPoints: limit
      };

      console.log(`[MetricsPersistence] Histórico carregado: ${records.length} registros`);
      return this.historyCache;
    } catch (error) {
      console.error('[MetricsPersistence] Erro ao carregar histórico:', error.message);
      return this.historyCache;
    }
  }

  /**
   * Adiciona métrica ao cache de histórico
   */
  addToHistory(metrics) {
    const now = new Date().toISOString();
    this.historyCache.timestamps.push(now);
    this.historyCache.cpu.push(metrics.cpu.usage);
    this.historyCache.memory.push(metrics.memory.usage);
    this.historyCache.disk.push(metrics.disk.usage);
    this.historyCache.load.push(metrics.loadAverage['1min']);

    // Manter apenas os últimos N pontos
    if (this.historyCache.timestamps.length > this.historyCache.maxPoints) {
      this.historyCache.timestamps.shift();
      this.historyCache.cpu.shift();
      this.historyCache.memory.shift();
      this.historyCache.disk.shift();
      this.historyCache.load.shift();
    }
  }

  /**
   * Retorna cache de histórico atual
   */
  getHistory() {
    return this.historyCache;
  }

  /**
   * Limpa métricas antigas (mais de 24 horas)
   */
  async cleanup(hoursToKeep = 24) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - hoursToKeep);

      const result = await prisma.metricaSistema.deleteMany({
        where: {
          timestamp: { lt: cutoffDate }
        }
      });

      if (result.count > 0) {
        console.log(`[MetricsPersistence] Limpeza: ${result.count} registros antigos removidos`);
      }
      return result.count;
    } catch (error) {
      console.error('[MetricsPersistence] Erro na limpeza:', error.message);
      return 0;
    }
  }

  /**
   * Busca métricas em um período
   */
  async getByPeriod(startDate, endDate, limit = 1000) {
    try {
      return await prisma.metricaSistema.findMany({
        where: {
          timestamp: {
            gte: startDate,
            lte: endDate
          }
        },
        orderBy: { timestamp: 'asc' },
        take: limit
      });
    } catch (error) {
      console.error('[MetricsPersistence] Erro ao buscar por período:', error.message);
      return [];
    }
  }

  /**
   * Retorna estatísticas agregadas
   */
  async getStats(hours = 24) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - hours);

      const stats = await prisma.metricaSistema.aggregate({
        where: {
          timestamp: { gte: cutoffDate }
        },
        _avg: {
          cpu_usage: true,
          mem_usage: true,
          disk_usage: true,
          load_1min: true
        },
        _max: {
          cpu_usage: true,
          mem_usage: true,
          disk_usage: true,
          load_1min: true
        },
        _min: {
          cpu_usage: true,
          mem_usage: true,
          disk_usage: true,
          load_1min: true
        },
        _count: true
      });

      return {
        periodo: `${hours} horas`,
        total_registros: stats._count,
        media: {
          cpu: stats._avg.cpu_usage?.toFixed(1) || 0,
          memoria: stats._avg.mem_usage?.toFixed(1) || 0,
          disco: stats._avg.disk_usage?.toFixed(1) || 0,
          load: stats._avg.load_1min?.toFixed(2) || 0
        },
        maximo: {
          cpu: stats._max.cpu_usage?.toFixed(1) || 0,
          memoria: stats._max.mem_usage?.toFixed(1) || 0,
          disco: stats._max.disk_usage?.toFixed(1) || 0,
          load: stats._max.load_1min?.toFixed(2) || 0
        },
        minimo: {
          cpu: stats._min.cpu_usage?.toFixed(1) || 0,
          memoria: stats._min.mem_usage?.toFixed(1) || 0,
          disco: stats._min.disk_usage?.toFixed(1) || 0,
          load: stats._min.load_1min?.toFixed(2) || 0
        }
      };
    } catch (error) {
      console.error('[MetricsPersistence] Erro ao calcular estatísticas:', error.message);
      return null;
    }
  }
}

module.exports = new MetricsPersistenceService();
