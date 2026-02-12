/**
 * Metrics Service - Exporta métricas para Prometheus
 *
 * Métricas exportadas:
 * - gps_devices_total: Total de dispositivos
 * - gps_devices_online: Dispositivos online
 * - gps_locations_total: Total de localizações
 * - gps_locations_rate: Taxa de localizações por segundo
 * - gps_tcp_connections: Conexões TCP ativas
 * - gps_websocket_connections: Conexões WebSocket ativas
 * - gps_queue_size: Tamanho das filas
 * - gps_database_queries: Queries ao banco
 * - nodejs_*: Métricas padrão do Node.js
 */

const client = require('prom-client');
const prisma = require('../db/prisma');

// Registro de métricas
const register = new client.Registry();

// Coletar métricas padrão do Node.js (CPU, memória, event loop)
client.collectDefaultMetrics({ register });

// ============ MÉTRICAS CUSTOMIZADAS ============

// Dispositivos
const devicesTotal = new client.Gauge({
  name: 'gps_devices_total',
  help: 'Total de dispositivos cadastrados',
  registers: [register]
});

const devicesOnline = new client.Gauge({
  name: 'gps_devices_online',
  help: 'Dispositivos online no momento',
  registers: [register]
});

const devicesByStatus = new client.Gauge({
  name: 'gps_devices_by_status',
  help: 'Dispositivos por status',
  labelNames: ['status'],
  registers: [register]
});

const devicesByIgnition = new client.Gauge({
  name: 'gps_devices_by_ignition',
  help: 'Dispositivos por estado de ignição',
  labelNames: ['state'],
  registers: [register]
});

// Localizações
const locationsTotal = new client.Counter({
  name: 'gps_locations_total',
  help: 'Total de localizações recebidas',
  registers: [register]
});

const locationsRate = new client.Gauge({
  name: 'gps_locations_rate',
  help: 'Taxa de localizações por minuto',
  registers: [register]
});

const locationsByDevice = new client.Counter({
  name: 'gps_locations_by_device',
  help: 'Localizações por dispositivo',
  labelNames: ['imei'],
  registers: [register]
});

// Conexões
const tcpConnections = new client.Gauge({
  name: 'gps_tcp_connections',
  help: 'Conexões TCP ativas',
  registers: [register]
});

const websocketConnections = new client.Gauge({
  name: 'gps_websocket_connections',
  help: 'Conexões WebSocket ativas',
  registers: [register]
});

// Filas (Redis)
const queueSize = new client.Gauge({
  name: 'gps_queue_size',
  help: 'Tamanho das filas de processamento',
  labelNames: ['queue'],
  registers: [register]
});

const queueProcessed = new client.Counter({
  name: 'gps_queue_processed_total',
  help: 'Total de jobs processados',
  labelNames: ['queue', 'status'],
  registers: [register]
});

// Banco de dados
const dbQueryDuration = new client.Histogram({
  name: 'gps_db_query_duration_seconds',
  help: 'Duração das queries ao banco',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

const dbConnections = new client.Gauge({
  name: 'gps_db_connections',
  help: 'Conexões ativas ao banco',
  registers: [register]
});

// Alarmes
const alarmsTotal = new client.Counter({
  name: 'gps_alarms_total',
  help: 'Total de alarmes recebidos',
  labelNames: ['type', 'severity'],
  registers: [register]
});

// Viagens
const tripsActive = new client.Gauge({
  name: 'gps_trips_active',
  help: 'Viagens ativas no momento',
  registers: [register]
});

const tripsCompleted = new client.Counter({
  name: 'gps_trips_completed_total',
  help: 'Total de viagens completadas',
  registers: [register]
});

// HTTP
const httpRequestDuration = new client.Histogram({
  name: 'gps_http_request_duration_seconds',
  help: 'Duração das requisições HTTP',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [register]
});

const httpRequestsTotal = new client.Counter({
  name: 'gps_http_requests_total',
  help: 'Total de requisições HTTP',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

// ============ SERVIÇO ============

class MetricsService {
  constructor() {
    this.locationCount = 0;
    this.lastLocationCheck = Date.now();
    this.tcpConnectionCount = 0;
    this.wsConnectionCount = 0;
  }

  /**
   * Atualiza métricas de dispositivos do banco
   */
  async updateDeviceMetrics() {
    try {
      // Total de dispositivos
      const total = await prisma.dispositivo.count();
      devicesTotal.set(total);

      // Por status
      const byStatus = await prisma.dispositivo.groupBy({
        by: ['status'],
        _count: true
      });

      byStatus.forEach(s => {
        devicesByStatus.labels(s.status).set(s._count);
        if (s.status === 'online') {
          devicesOnline.set(s._count);
        }
      });

      // Por ignição
      const byIgnition = await prisma.dispositivo.groupBy({
        by: ['estado_ignicao'],
        _count: true
      });

      byIgnition.forEach(i => {
        devicesByIgnition.labels(i.estado_ignicao || 'unknown').set(i._count);
      });

      // Viagens ativas
      const activeTrips = await prisma.dispositivo.count({
        where: {
          viagem_inicio: { not: null }
        }
      });
      tripsActive.set(activeTrips);

    } catch (error) {
      console.error('[Metrics] Erro ao atualizar métricas de dispositivos:', error.message);
    }
  }

  /**
   * Registra uma nova localização
   */
  recordLocation(imei) {
    locationsTotal.inc();
    locationsByDevice.labels(imei).inc();
    this.locationCount++;
  }

  /**
   * Registra um alarme
   */
  recordAlarm(type, severity) {
    alarmsTotal.labels(type, severity).inc();
  }

  /**
   * Registra viagem completada
   */
  recordTripCompleted() {
    tripsCompleted.inc();
  }

  /**
   * Atualiza contagem de conexões TCP
   */
  setTcpConnections(count) {
    this.tcpConnectionCount = count;
    tcpConnections.set(count);
  }

  /**
   * Atualiza contagem de conexões WebSocket
   */
  setWsConnections(count) {
    this.wsConnectionCount = count;
    websocketConnections.set(count);
  }

  /**
   * Atualiza tamanho das filas
   */
  setQueueSize(queueName, size) {
    queueSize.labels(queueName).set(size);
  }

  /**
   * Registra job processado
   */
  recordQueueJob(queueName, success) {
    queueProcessed.labels(queueName, success ? 'success' : 'error').inc();
  }

  /**
   * Mede duração de query
   */
  measureDbQuery(operation, table) {
    const end = dbQueryDuration.startTimer({ operation, table });
    return end;
  }

  /**
   * Calcula taxa de localizações
   */
  calculateLocationRate() {
    const now = Date.now();
    const elapsed = (now - this.lastLocationCheck) / 1000 / 60; // minutos

    if (elapsed > 0) {
      const rate = this.locationCount / elapsed;
      locationsRate.set(rate);
      this.locationCount = 0;
      this.lastLocationCheck = now;
    }
  }

  /**
   * Middleware Express para medir requisições HTTP
   */
  httpMiddleware() {
    return (req, res, next) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const route = req.route?.path || req.path || 'unknown';
        const method = req.method;
        const status = res.statusCode.toString();

        httpRequestDuration.labels(method, route, status).observe(duration);
        httpRequestsTotal.labels(method, route, status).inc();
      });

      next();
    };
  }

  /**
   * Retorna métricas no formato Prometheus
   */
  async getMetrics() {
    // Atualizar métricas do banco antes de retornar
    await this.updateDeviceMetrics();
    this.calculateLocationRate();

    return register.metrics();
  }

  /**
   * Retorna content-type das métricas
   */
  getContentType() {
    return register.contentType;
  }

  /**
   * Retorna métricas em formato JSON (para debug)
   */
  async getMetricsJson() {
    await this.updateDeviceMetrics();
    return register.getMetricsAsJSON();
  }
}

// Singleton
const metricsService = new MetricsService();

// Atualizar métricas periodicamente
setInterval(() => {
  metricsService.calculateLocationRate();
}, 60000); // A cada minuto

module.exports = metricsService;
