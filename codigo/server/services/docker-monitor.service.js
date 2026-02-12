/**
 * Docker Monitor Service
 * Monitora containers Docker para exibição no dashboard
 * Usa a Docker Engine API via socket Unix
 */

const http = require('http');
const fs = require('fs');

class DockerMonitorService {
  constructor() {
    this.cache = null;
    this.cacheTime = null;
    this.cacheTTL = 5000; // 5 segundos de cache
    this.socketPath = '/var/run/docker.sock';
  }

  /**
   * Verifica se o socket do Docker está disponível
   */
  isDockerAvailable() {
    try {
      return fs.existsSync(this.socketPath);
    } catch {
      return false;
    }
  }

  /**
   * Faz requisição à API do Docker via socket Unix
   */
  async dockerRequest(path) {
    return new Promise((resolve, reject) => {
      const options = {
        socketPath: this.socketPath,
        path: path,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      req.end();
    });
  }

  /**
   * Obtém lista de containers com status
   */
  async getContainers() {
    try {
      const containers = await this.dockerRequest('/containers/json?all=true');
      return containers.map(c => ({
        id: c.Id.substring(0, 12),
        name: c.Names[0].replace('/', ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        running: c.State === 'running',
        healthy: c.Status.includes('healthy')
      }));
    } catch (error) {
      console.error('[DockerMonitor] Erro ao listar containers:', error.message);
      return [];
    }
  }

  /**
   * Obtém estatísticas de um container específico
   */
  async getContainerStats(containerId) {
    try {
      const stats = await this.dockerRequest(`/containers/${containerId}/stats?stream=false`);

      // Calcular CPU % (mesma fórmula do docker stats)
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      // NÃO multiplicar por numCpus - docker stats já mostra porcentagem relativa ao total
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * 100 : 0;

      // Calcular memória
      const memUsage = stats.memory_stats.usage || 0;
      const memLimit = stats.memory_stats.limit || 1;
      const memPercent = (memUsage / memLimit) * 100;

      return {
        cpu: cpuPercent.toFixed(1),
        memUsage: this.formatBytes(memUsage),
        memLimit: this.formatBytes(memLimit),
        memPerc: memPercent.toFixed(1)
      };
    } catch (error) {
      return { cpu: '0', memUsage: '—', memLimit: '—', memPerc: '0' };
    }
  }

  /**
   * Formata bytes para exibição
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Classifica containers por tipo
   */
  classifyContainers(containers) {
    const types = {
      gateways: [],
      processors: [],
      api: [],
      database: [],
      cache: [],
      loadbalancer: [],
      monitoring: [],
      other: []
    };

    containers.forEach(c => {
      const name = c.name.toLowerCase();

      if (name.includes('tcp-gw') || name.includes('gateway')) {
        types.gateways.push(c);
      } else if (name.includes('proc') || name.includes('processor') || name.includes('worker')) {
        types.processors.push(c);
      } else if (name.includes('api')) {
        types.api.push(c);
      } else if (name.includes('postgres') || name.includes('db') || name.includes('pgbouncer')) {
        types.database.push(c);
      } else if (name.includes('redis')) {
        types.cache.push(c);
      } else if (name.includes('haproxy') || name.includes('nginx') || name.includes('traefik')) {
        types.loadbalancer.push(c);
      } else if (name.includes('prometheus') || name.includes('grafana')) {
        types.monitoring.push(c);
      } else {
        types.other.push(c);
      }
    });

    return types;
  }

  /**
   * Calcula indicadores de saúde e recomendações de scaling
   */
  calculateScalingRecommendations(containers, statsMap) {
    const recommendations = [];
    const types = this.classifyContainers(containers);

    // Verificar processadores
    const processors = types.processors.filter(c => c.running);
    const avgProcessorCPU = processors.length > 0
      ? processors.reduce((sum, p) => sum + parseFloat(statsMap[p.id]?.cpu || 0), 0) / processors.length
      : 0;

    if (avgProcessorCPU > 70) {
      recommendations.push({
        type: 'warning',
        component: 'processors',
        message: `CPU media dos processors: ${avgProcessorCPU.toFixed(1)}% - Considere escalar`,
        action: 'docker compose -f docker-compose.scalable-16gb.yml up -d location-processor-3 --no-deps'
      });
    }

    // Verificar gateways
    const gateways = types.gateways.filter(c => c.running);
    if (gateways.length < 2) {
      recommendations.push({
        type: 'critical',
        component: 'gateways',
        message: 'Menos de 2 gateways ativos - Sem redundancia!',
        action: 'Verifique os gateways TCP'
      });
    }

    // Verificar API servers
    const apis = types.api.filter(c => c.running);
    const avgApiCPU = apis.length > 0
      ? apis.reduce((sum, a) => sum + parseFloat(statsMap[a.id]?.cpu || 0), 0) / apis.length
      : 0;

    if (avgApiCPU > 80) {
      recommendations.push({
        type: 'warning',
        component: 'api',
        message: `CPU media da API: ${avgApiCPU.toFixed(1)}% - Considere escalar`,
        action: 'Adicione mais instancias de API e atualize o HAProxy'
      });
    }

    // Verificar Redis
    const redis = types.cache.find(c => c.running);
    if (redis && statsMap[redis.id]) {
      const redisMemPerc = parseFloat(statsMap[redis.id].memPerc || 0);
      if (redisMemPerc > 80) {
        recommendations.push({
          type: 'warning',
          component: 'redis',
          message: `Redis usando ${redisMemPerc.toFixed(1)}% da memoria`,
          action: 'Aumente maxmemory ou limpe dados antigos'
        });
      }
    }

    // Verificar Database
    const db = types.database.find(c => c.name.includes('db') && !c.name.includes('pgbouncer'));
    if (db && statsMap[db.id]) {
      const dbMemPerc = parseFloat(statsMap[db.id].memPerc || 0);
      if (dbMemPerc > 85) {
        recommendations.push({
          type: 'warning',
          component: 'database',
          message: `PostgreSQL usando ${dbMemPerc.toFixed(1)}% da memoria`,
          action: 'Considere aumentar recursos do banco'
        });
      }
    }

    return recommendations;
  }

  /**
   * Retorna status completo da infraestrutura
   */
  async getInfrastructureStatus() {
    // Verificar cache
    if (this.cache && this.cacheTime && (Date.now() - this.cacheTime < this.cacheTTL)) {
      return this.cache;
    }

    // Verificar se Docker está disponível
    if (!this.isDockerAvailable()) {
      return {
        sucesso: false,
        erro: 'Docker socket não disponível. Monte /var/run/docker.sock no container.',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const containers = await this.getContainers();

      // Filtrar apenas containers do rastreador
      const rastreadorContainers = containers.filter(c =>
        c.name.includes('rastreador') ||
        c.name.includes('codigo-') ||
        c.name.includes('loc-proc') ||
        c.name.includes('tcp-gw')
      );

      // Obter stats dos containers em paralelo (apenas running)
      const runningContainers = rastreadorContainers.filter(c => c.running);
      const statsPromises = runningContainers.map(c =>
        this.getContainerStats(c.id).then(stats => ({ id: c.id, stats }))
      );

      const statsResults = await Promise.all(statsPromises);
      const statsMap = {};
      statsResults.forEach(({ id, stats }) => {
        statsMap[id] = stats;
      });

      // Adicionar stats aos containers
      rastreadorContainers.forEach(c => {
        c.stats = statsMap[c.id] || {};
      });

      const types = this.classifyContainers(rastreadorContainers);
      const recommendations = this.calculateScalingRecommendations(rastreadorContainers, statsMap);

      // Calcular totais
      const totalRunning = rastreadorContainers.filter(c => c.running).length;
      const totalHealthy = rastreadorContainers.filter(c => c.healthy).length;
      const totalContainers = rastreadorContainers.length;

      // Status geral
      let overallStatus = 'healthy';
      if (recommendations.some(r => r.type === 'critical')) {
        overallStatus = 'critical';
      } else if (recommendations.some(r => r.type === 'warning')) {
        overallStatus = 'warning';
      }

      const result = {
        sucesso: true,
        timestamp: new Date().toISOString(),

        // Resumo
        summary: {
          status: overallStatus,
          totalContainers,
          running: totalRunning,
          healthy: totalHealthy,
          stopped: totalContainers - totalRunning
        },

        // Containers por tipo
        components: {
          gateways: {
            name: 'TCP Gateways',
            description: 'Recebem conexoes dos rastreadores',
            containers: types.gateways,
            running: types.gateways.filter(c => c.running).length,
            total: types.gateways.length
          },
          processors: {
            name: 'Processors',
            description: 'Processam dados GPS, status e alarmes',
            containers: types.processors,
            running: types.processors.filter(c => c.running).length,
            total: types.processors.length
          },
          api: {
            name: 'API Servers',
            description: 'HTTP/WebSocket para frontend',
            containers: types.api,
            running: types.api.filter(c => c.running).length,
            total: types.api.length
          },
          database: {
            name: 'Database',
            description: 'PostgreSQL + PgBouncer',
            containers: types.database,
            running: types.database.filter(c => c.running).length,
            total: types.database.length
          },
          cache: {
            name: 'Cache/Queue',
            description: 'Redis Streams + Cache',
            containers: types.cache,
            running: types.cache.filter(c => c.running).length,
            total: types.cache.length
          },
          loadbalancer: {
            name: 'Load Balancer',
            description: 'HAProxy para distribuicao de carga',
            containers: types.loadbalancer,
            running: types.loadbalancer.filter(c => c.running).length,
            total: types.loadbalancer.length
          }
        },

        // Recomendações de scaling
        recommendations,

        // Comandos úteis
        scalingCommands: {
          addProcessor: 'docker compose -f docker-compose.scalable-16gb.yml up -d location-processor-3 --no-deps',
          addGateway: 'docker compose -f docker-compose.scalable-16gb.yml up -d tcp-gateway-3 --no-deps',
          viewLogs: 'docker logs -f <container-name>',
          viewStats: 'docker stats --no-stream'
        }
      };

      // Atualizar cache
      this.cache = result;
      this.cacheTime = Date.now();

      return result;

    } catch (error) {
      console.error('[DockerMonitor] Erro ao obter status:', error);
      return {
        sucesso: false,
        erro: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new DockerMonitorService();
