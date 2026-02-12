/**
 * Rotas de Infraestrutura
 * Monitoramento de containers Docker e recomendações de scaling
 */

const express = require('express');
const router = express.Router();
const dockerMonitor = require('../services/docker-monitor.service');

/**
 * GET /api/infraestrutura/status
 * Retorna status completo da infraestrutura Docker
 */
router.get('/status', async (req, res) => {
  try {
    const status = await dockerMonitor.getInfrastructureStatus();
    res.json(status);
  } catch (error) {
    console.error('[Infraestrutura] Erro:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/infraestrutura/resumo
 * Retorna apenas o resumo (mais leve)
 */
router.get('/resumo', async (req, res) => {
  try {
    const status = await dockerMonitor.getInfrastructureStatus();
    res.json({
      sucesso: true,
      summary: status.summary,
      recommendations: status.recommendations,
      timestamp: status.timestamp
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/infraestrutura/haproxy
 * Retorna estatísticas do HAProxy
 */
router.get('/haproxy', async (req, res) => {
  try {
    const http = require('http');

    const fetchStats = () => new Promise((resolve, reject) => {
      const auth = Buffer.from('admin:admin').toString('base64');
      const options = {
        hostname: 'rastreador-haproxy',
        port: 8404,
        path: '/stats;csv',
        method: 'GET',
        timeout: 5000,
        headers: {
          'Authorization': `Basic ${auth}`
        }
      };

      const request = http.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
      });

      request.on('error', reject);
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Timeout'));
      });
      request.end();
    });

    const csvData = await fetchStats();
    const lines = csvData.trim().split('\n');
    const headers = lines[0].replace('# ', '').split(',');

    const stats = {
      frontends: [],
      backends: [],
      servers: []
    };

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      const row = {};
      headers.forEach((h, idx) => row[h] = values[idx]);

      const entry = {
        name: row.pxname,
        svname: row.svname,
        status: row.status,
        scur: parseInt(row.scur) || 0,      // sessões atuais
        smax: parseInt(row.smax) || 0,      // máximo de sessões
        slim: parseInt(row.slim) || 0,      // limite de sessões
        stot: parseInt(row.stot) || 0,      // total de sessões
        bin: parseInt(row.bin) || 0,        // bytes in
        bout: parseInt(row.bout) || 0,      // bytes out
        dreq: parseInt(row.dreq) || 0,      // requests negados
        dresp: parseInt(row.dresp) || 0,    // responses negados
        ereq: parseInt(row.ereq) || 0,      // erros de request
        econ: parseInt(row.econ) || 0,      // erros de conexão
        eresp: parseInt(row.eresp) || 0,    // erros de response
        wretr: parseInt(row.wretr) || 0,    // retries
        wredis: parseInt(row.wredis) || 0,  // redispatches
        rate: parseInt(row.rate) || 0,      // sessões por segundo
        hrsp_1xx: parseInt(row.hrsp_1xx) || 0,
        hrsp_2xx: parseInt(row.hrsp_2xx) || 0,
        hrsp_3xx: parseInt(row.hrsp_3xx) || 0,
        hrsp_4xx: parseInt(row.hrsp_4xx) || 0,
        hrsp_5xx: parseInt(row.hrsp_5xx) || 0,
        chkfail: parseInt(row.chkfail) || 0,
        chkdown: parseInt(row.chkdown) || 0,
        lastchg: parseInt(row.lastchg) || 0, // segundos desde última mudança de status
        downtime: parseInt(row.downtime) || 0
      };

      if (row.svname === 'FRONTEND') {
        stats.frontends.push(entry);
      } else if (row.svname === 'BACKEND') {
        stats.backends.push(entry);
      } else {
        stats.servers.push(entry);
      }
    }

    // Formatar para exibição
    const formatBytes = (bytes) => {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    };

    const formatUptime = (seconds) => {
      if (seconds < 60) return seconds + 's';
      if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
      if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
      return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h';
    };

    // Agrupar por serviço
    const services = {};
    const serviceConfig = [
      { key: 'tcp_xt40', frontendName: 'tcp_xt40_frontend', backendName: 'tcp_gateways_xt40', displayName: 'TCP XT40 (8877)' },
      { key: 'tcp_obd2', frontendName: 'tcp_obd2_frontend', backendName: 'tcp_gateways_obd2', displayName: 'TCP OBD2 (8878)' },
      { key: 'tcp_teltonika', frontendName: 'tcp_teltonika_frontend', backendName: 'tcp_gateways_teltonika', displayName: 'TCP Teltonika (8879)' },
      { key: 'http', frontendName: 'http_frontend', backendName: 'api_servers', displayName: 'HTTP/API (62000)' }
    ];

    serviceConfig.forEach(svc => {
      const frontend = stats.frontends.find(f => f.name === svc.frontendName);
      const backend = stats.backends.find(b => b.name === svc.backendName);
      const servers = stats.servers.filter(s => s.name === svc.backendName);

      if (frontend || backend) {
        services[svc.key] = {
          name: svc.displayName,
          frontend: frontend ? {
            status: frontend.status,
            currentConn: frontend.scur,
            totalConn: frontend.stot,
            bytesIn: formatBytes(frontend.bin),
            bytesOut: formatBytes(frontend.bout),
            rate: frontend.rate
          } : null,
          backend: backend ? {
            status: backend.status,
            currentConn: backend.scur,
            totalConn: backend.stot,
            errors: backend.econ + backend.eresp,
            retries: backend.wretr
          } : null,
          servers: servers.map(s => ({
            name: s.svname,
            status: s.status,
            currentConn: s.scur,
            totalConn: s.stot,
            uptime: formatUptime(s.lastchg),
            healthChecks: {
              failed: s.chkfail,
              down: s.chkdown
            }
          }))
        };
      }
    });

    res.json({
      sucesso: true,
      timestamp: new Date().toISOString(),
      stats: services,
      raw: {
        frontends: stats.frontends.length,
        backends: stats.backends.length,
        servers: stats.servers.length
      }
    });
  } catch (error) {
    console.error('[HAProxy] Erro ao buscar stats:', error.message);
    res.json({
      sucesso: false,
      erro: error.message,
      disponivel: false
    });
  }
});

/**
 * GET /api/infraestrutura/tcp-security
 * Retorna estatísticas de segurança TCP (conexões, rejeições, rate limits)
 */
router.get('/tcp-security', async (req, res) => {
  try {
    const tcpSecurity = require('../middleware/tcp-security.middleware');

    const stats = tcpSecurity.getSecurityStats();
    const connections = tcpSecurity.listActiveConnections();

    res.json({
      sucesso: true,
      timestamp: new Date().toISOString(),
      stats: {
        validConnections: stats.validConnections,
        imeiRejections: stats.imeiRejections,
        rateLimitHits: stats.rateLimitHits,
        duplicateConnections: stats.duplicateConnections,
        activeConnections: stats.activeConnections,
        cachedImeis: stats.cachedImeis,
        uptimeHours: stats.uptimeHours
      },
      activeConnections: connections.slice(0, 50), // Máximo 50 para não sobrecarregar
      totalActiveConnections: connections.length
    });
  } catch (error) {
    console.error('[TCP-Security] Erro ao buscar stats:', error.message);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/infraestrutura/apresentacao
 * Retorna página HTML com apresentação da arquitetura
 */
router.get('/apresentacao', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arquitetura - Sistema de Rastreamento Veicular</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: #fff; min-height: 100vh; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        h1 { text-align: center; font-size: 2.5em; margin-bottom: 10px; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        h2 { color: #00d4ff; margin: 30px 0 20px; padding-bottom: 10px; border-bottom: 2px solid #00d4ff; }
        h3 { color: #7b2cbf; margin: 20px 0 10px; }
        .subtitle { text-align: center; color: #888; margin-bottom: 40px; }
        .card { background: rgba(255,255,255,0.05); border-radius: 15px; padding: 25px; margin: 20px 0; border: 1px solid rgba(255,255,255,0.1); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 30px 0; }
        .stat-card { background: linear-gradient(135deg, rgba(0,212,255,0.2), rgba(123,44,191,0.2)); border-radius: 15px; padding: 25px; text-align: center; border: 1px solid rgba(0,212,255,0.3); }
        .stat-card .number { font-size: 2.5em; font-weight: bold; background: linear-gradient(90deg, #00d4ff, #7b2cbf); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stat-card .label { color: #888; margin-top: 5px; }
        .diagram { background: #0a0a1a; border-radius: 10px; padding: 30px; font-family: 'Courier New', monospace; font-size: 11px; overflow-x: auto; white-space: pre; line-height: 1.4; color: #00d4ff; }
        table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        th { background: rgba(0,212,255,0.2); color: #00d4ff; }
        tr:hover { background: rgba(255,255,255,0.05); }
        .component-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .component { background: rgba(255,255,255,0.03); border-radius: 10px; padding: 20px; border-left: 4px solid #00d4ff; }
        .component.green { border-left-color: #00ff88; }
        .component.purple { border-left-color: #7b2cbf; }
        .component.orange { border-left-color: #ff9500; }
        .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.8em; margin: 2px; }
        .badge-blue { background: rgba(0,212,255,0.3); color: #00d4ff; }
        .badge-green { background: rgba(0,255,136,0.3); color: #00ff88; }
        .badge-purple { background: rgba(123,44,191,0.3); color: #c77dff; }
        .flow-diagram { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 10px; margin: 30px 0; }
        .flow-box { background: linear-gradient(135deg, #1e3a5f, #0d1b2a); border: 2px solid #00d4ff; border-radius: 10px; padding: 15px 25px; text-align: center; min-width: 120px; }
        .flow-arrow { color: #00d4ff; font-size: 1.5em; }
        .redundancy-box { display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; margin: 20px 0; }
        .instance { background: linear-gradient(135deg, rgba(0,255,136,0.2), rgba(0,212,255,0.1)); border: 2px solid #00ff88; border-radius: 10px; padding: 20px; text-align: center; min-width: 150px; }
        .instance.down { background: linear-gradient(135deg, rgba(255,71,87,0.2), rgba(255,71,87,0.1)); border-color: #ff4757; opacity: 0.5; }
        .print-btn { position: fixed; top: 20px; right: 20px; background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: white; border: none; padding: 10px 20px; border-radius: 25px; cursor: pointer; font-weight: bold; z-index: 1000; }
        .print-btn:hover { transform: scale(1.05); }
        @media print { body { background: white; color: black; } .card { border: 1px solid #ccc; } .print-btn { display: none; } .diagram { background: #f5f5f5; color: #333; } }
    </style>
</head>
<body>
    <button class="print-btn" onclick="window.print()">Imprimir / PDF</button>
    <div class="container">
        <h1>Sistema de Rastreamento Veicular</h1>
        <p class="subtitle">Arquitetura de Alta Disponibilidade e Escalabilidade</p>

        <div class="stats-grid">
            <div class="stat-card"><div class="number">6.000+</div><div class="label">Rastreadores Simultaneos</div></div>
            <div class="stat-card"><div class="number">99.9%</div><div class="label">Disponibilidade</div></div>
            <div class="stat-card"><div class="number">14</div><div class="label">Containers Docker</div></div>
            <div class="stat-card"><div class="number">&lt;100ms</div><div class="label">Latencia Real-time</div></div>
        </div>

        <h2>Diagrama de Arquitetura</h2>
        <div class="card">
            <div class="diagram">                                    INTERNET
                                        |
                                        v
                +-----------------------------------------------+
                |                   HAPROXY                     |
                |              (Load Balancer)                  |
                |      TCP: 8877 | HTTP: 62000 | Stats: 8404   |
                +-----------------------------------------------+
                       /           |           \\            \\
                      v            v            v            v
           +-----------+  +-----------+  +-----------+   +-----------+
           |  TCP GW   |  |  TCP GW   |  |  TCP GW   |   |  API SRV  |
           |   gw-1    |  |   gw-2    |  |   gw-3    |   |  api-1/2  |
           |  2000 con |  |  2000 con |  |  2000 con |   | WebSocket |
           +-----------+  +-----------+  +-----------+   +-----------+
                 \\              |              /                |
                  v             v             v                 v
                +------------------------------------+----------+
                |              REDIS                |
                |     (Message Queue + Cache)       |
                |     Streams | Cache | Pub/Sub     |
                +------------------------------------+
                                 |
            +--------------------+--------------------+
            v                    v                    v
      +-----------+        +-----------+        +-----------+
      | LOC PROC  |        | LOC PROC  |        | LOC PROC  |
      |   loc-1   |        |   loc-2   |        |   loc-3   |
      +-----------+        +-----------+        +-----------+
            +--------------------+--------------------+
                                 v
                +------------------------------------+
                |            PGBOUNCER              |
                |       (Connection Pooling)        |
                +------------------------------------+
                                 v
                +------------------------------------+
                |    POSTGRESQL + TIMESCALEDB       |
                |        (Banco de Dados)           |
                +------------------------------------+</div>
        </div>

        <h2>Fluxo de Dados</h2>
        <div class="card">
            <h3>Entrada (Rastreador - Sistema)</h3>
            <div class="flow-diagram">
                <div class="flow-box">Rastreador<br><small>GPS/4G</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">HAProxy<br><small>L4 LB</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">TCP Gateway<br><small>Parser</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">Redis<br><small>Stream</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">Processor<br><small>Validacao</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">PostgreSQL<br><small>Persistencia</small></div>
            </div>
            <h3>Saida (Sistema - Usuario)</h3>
            <div class="flow-diagram">
                <div class="flow-box">PostgreSQL<br><small>Dados</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">Redis<br><small>Cache</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">API Server<br><small>REST/WS</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">HAProxy<br><small>L7 LB</small></div>
                <span class="flow-arrow">-></span>
                <div class="flow-box">Navegador<br><small>Usuario</small></div>
            </div>
        </div>

        <h2>Componentes do Sistema</h2>
        <div class="component-grid">
            <div class="component">
                <h3>HAProxy</h3>
                <p>Load Balancer de alta performance</p>
                <span class="badge badge-blue">TCP: Round Robin</span>
                <span class="badge badge-blue">HTTP: Least Conn</span>
                <table><tr><td>Health Check</td><td>5 segundos</td></tr><tr><td>Failover</td><td>Automatico</td></tr></table>
            </div>
            <div class="component green">
                <h3>TCP Gateways (3x)</h3>
                <p>Recebem conexoes dos rastreadores</p>
                <span class="badge badge-green">2000 conn/gw</span>
                <span class="badge badge-green">512MB RAM</span>
                <table><tr><td>Total Conexoes</td><td>6.000</td></tr><tr><td>Protocolos</td><td>XT40, OBD2, Teltonika</td></tr></table>
            </div>
            <div class="component purple">
                <h3>Redis</h3>
                <p>Message Queue e Cache em memoria</p>
                <span class="badge badge-purple">Streams</span>
                <span class="badge badge-purple">Cache</span>
                <span class="badge badge-purple">Pub/Sub</span>
                <table><tr><td>Memoria</td><td>1GB</td></tr><tr><td>Persistencia</td><td>AOF</td></tr></table>
            </div>
            <div class="component orange">
                <h3>Location Processors (3x)</h3>
                <p>Processam e validam localizacoes GPS</p>
                <span class="badge badge-blue">Batch: 10 msg</span>
                <span class="badge badge-blue">1GB RAM</span>
                <table><tr><td>Validacoes</td><td>GPS, Velocidade, Geofence</td></tr><tr><td>Lock</td><td>Distribuido (Redis)</td></tr></table>
            </div>
            <div class="component">
                <h3>API Servers (2x)</h3>
                <p>REST API e WebSocket real-time</p>
                <span class="badge badge-blue">Stateless</span>
                <span class="badge badge-green">JWT Auth</span>
                <table><tr><td>Memoria</td><td>1-1.5GB</td></tr><tr><td>WebSocket</td><td>Redis Pub/Sub</td></tr></table>
            </div>
            <div class="component">
                <h3>PostgreSQL + TimescaleDB</h3>
                <p>Banco otimizado para series temporais</p>
                <span class="badge badge-purple">Hypertables</span>
                <span class="badge badge-purple">Compressao</span>
                <table><tr><td>Memoria</td><td>4GB</td></tr><tr><td>Max Conexoes</td><td>200</td></tr></table>
            </div>
        </div>

        <h2>Redundancia e Alta Disponibilidade</h2>
        <div class="card">
            <h3>Cenario Normal</h3>
            <div class="redundancy-box">
                <div class="instance">GW-1<br><strong>2000</strong> conn</div>
                <div class="instance">GW-2<br><strong>2000</strong> conn</div>
                <div class="instance">GW-3<br><strong>2000</strong> conn</div>
            </div>
            <p style="text-align: center; color: #00ff88;">Total: 6000 conexoes distribuidas</p>
            <h3>1 Gateway Down</h3>
            <div class="redundancy-box">
                <div class="instance down">GW-1<br><strong>OFF</strong></div>
                <div class="instance">GW-2<br><strong>3000</strong> conn</div>
                <div class="instance">GW-3<br><strong>3000</strong> conn</div>
            </div>
            <p style="text-align: center; color: #ff9500;">Failover automatico - Sem perda de servico</p>
            <h3>2 Gateways Down</h3>
            <div class="redundancy-box">
                <div class="instance down">GW-1<br><strong>OFF</strong></div>
                <div class="instance down">GW-2<br><strong>OFF</strong></div>
                <div class="instance">GW-3<br><strong>6000</strong> conn</div>
            </div>
            <p style="text-align: center; color: #ff4757;">Operacao degradada - Sistema ainda funcional</p>
        </div>

        <h2>Recursos de Hardware</h2>
        <div class="card">
            <table>
                <thead><tr><th>Componente</th><th>Memoria</th><th>CPU</th><th>Instancias</th><th>Total RAM</th></tr></thead>
                <tbody>
                    <tr><td>HAProxy</td><td>128MB</td><td>0.5</td><td>1</td><td>128MB</td></tr>
                    <tr><td>TCP Gateway</td><td>512MB</td><td>1</td><td>3</td><td>1.5GB</td></tr>
                    <tr><td>Location Processor</td><td>1GB</td><td>2</td><td>3</td><td>3GB</td></tr>
                    <tr><td>Status Processor</td><td>512MB</td><td>1</td><td>1</td><td>512MB</td></tr>
                    <tr><td>Alarm Processor</td><td>512MB</td><td>1</td><td>1</td><td>512MB</td></tr>
                    <tr><td>API Server</td><td>1.25GB</td><td>2</td><td>2</td><td>2.5GB</td></tr>
                    <tr><td>PgBouncer</td><td>128MB</td><td>0.5</td><td>1</td><td>128MB</td></tr>
                    <tr><td>Redis</td><td>1GB</td><td>2</td><td>1</td><td>1GB</td></tr>
                    <tr><td>PostgreSQL</td><td>4GB</td><td>4</td><td>1</td><td>4GB</td></tr>
                    <tr style="background: rgba(0,212,255,0.1); font-weight: bold;"><td>TOTAL</td><td>-</td><td>~20</td><td>14</td><td>~13GB</td></tr>
                </tbody>
            </table>
        </div>

        <h2>Seguranca</h2>
        <div class="card">
            <div class="component-grid">
                <div class="component"><h3>Rede</h3><p>Docker network isolada</p></div>
                <div class="component green"><h3>API</h3><p>JWT + Rate Limiting + CSRF</p></div>
                <div class="component purple"><h3>Dados (LGPD)</h3><p>AES-256-GCM para dados sensiveis</p></div>
                <div class="component orange"><h3>Banco</h3><p>Senha forte + Connection Pool</p></div>
            </div>
        </div>

        <h2>Metricas de Performance</h2>
        <div class="stats-grid">
            <div class="stat-card"><div class="number">~200</div><div class="label">Pacotes/Segundo</div></div>
            <div class="stat-card"><div class="number">17M</div><div class="label">Localizacoes/Dia</div></div>
            <div class="stat-card"><div class="number">&lt;50ms</div><div class="label">Processamento GPS</div></div>
            <div class="stat-card"><div class="number">~50GB</div><div class="label">Armazenamento/Mes</div></div>
        </div>

        <div class="card" style="text-align: center; margin-top: 40px;">
            <p style="color: #888;">Documento gerado em Fevereiro 2026 | Versao 1.0</p>
            <p style="margin-top: 10px;">
                <span class="badge badge-green">Alta Disponibilidade</span>
                <span class="badge badge-blue">Escalavel</span>
                <span class="badge badge-purple">LGPD Compliant</span>
            </p>
        </div>
    </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
