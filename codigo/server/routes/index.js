const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const dispositivosRoutes = require('./dispositivos.routes');
const analiseRotaRoutes = require('./analise-rota.routes');
const exportarRoutes = require('./exportar.routes');
const viagemRoutes = require('./viagem.routes');
const gpsPipelineRoutes = require('./gps-pipeline.routes'); // ✅ Pipeline de correção GPS
const speedLimitRoutes = require('./speedlimit.routes'); // ✅ Limites de velocidade das vias
const velocidadeRoutes = require('./velocidade.routes'); // ✅ Log e gráficos de velocidade
const gpsAIRoutes = require('./gps-ai.routes'); // ✅ IA para correção de rotas GPS
const gpsUnificadoRoutes = require('./gps-unificado.routes'); // ✅ Servico GPS Unificado (central)
const authRoutes = require('./auth.routes'); // ✅ Autenticação JWT
const authMotoristaRoutes = require('./auth-motorista.routes'); // ✅ Autenticação Motoristas (App Mobile)
const organizacaoRoutes = require('./organizacao.routes'); // ✅ Multi-tenant: Organizações
const geofencingRoutes = require('./geofencing.routes'); // ✅ Geofencing: Cercas Virtuais
const notificacaoRoutes = require('./notificacao.routes'); // ✅ Sistema de Notificações
const motoristaRoutes = require('./motorista.routes'); // ✅ Cadastro de Motoristas
const veiculosRoutes = require('./veiculos.routes'); // ✅ Gestão de Veículos (separado de Dispositivos)
const multaRoutes = require('./multa.routes'); // ✅ Gestão de Multas de Trânsito
const tagRoutes = require('./tag.routes'); // ✅ Tags de Veículos (categorização)
const insightRoutes = require('./insight.routes'); // ✅ Insights de IA (análise automática)
const lgpdRoutes = require('./lgpd.routes'); // ✅ LGPD: Consentimentos e Exclusão de Dados
const relatoriosRoutes = require('./relatorios.routes'); // ✅ Relatórios Avançados (Velocidade, Ocioso, Quilometragem, Frota)
const perfilPermissaoRoutes = require('./perfil-permissao.routes'); // ✅ Perfis de Permissão
const infraestruturaRoutes = require('./infraestrutura.routes'); // ✅ Monitoramento Docker/Infraestrutura
const { autenticar, autenticarOpcional, apenasAdmin, apenasSuperAdmin } = require('../middleware/auth.middleware'); // ✅ Middleware de autenticação
const { tenantContext } = require('../middleware/tenant.middleware'); // ✅ Multi-tenant: Contexto
const heartbeatService = require('../services/heartbeat.service');
const localizacaoService = require('../services/localizacao.service');
const comandoService = require('../services/comando.service');
const systemMonitorService = require('../services/system-monitor.service');
const metricsPersistence = require('../services/metrics-persistence.service');
const logger = require('../services/logger.service');
const redisService = require('../services/redis.service'); // ✅ Redis para cache
const cacheStatsService = require('../services/cache-stats.service'); // ✅ Estatísticas de cache em memória

// Referência para as conexões ativas (será definida pelo index.js)
let activeConnections = null;
let X3TECH_COMMANDS = null;

// Referência para conexões Teltonika
let teltonikaConnections = null;
let TELTONIKA_COMMANDS = null;
let teltonikaSendCommand = null;

// Função para injetar dependências do servidor principal
router.setConnections = (connections, commands) => {
  activeConnections = connections;
  X3TECH_COMMANDS = commands;
};

// Função para injetar dependências do servidor Teltonika
router.setTeltonikaConnections = (connections, commands, sendCommandFn) => {
  teltonikaConnections = connections;
  TELTONIKA_COMMANDS = commands;
  teltonikaSendCommand = sendCommandFn;
  console.log('[Routes] Teltonika connections registered');
};

// Status endpoint (keep for backward compatibility)
router.get('/status', (req, res) => {
  res.json({
    sucesso: true,
    mensagem: 'Servidor rodando!',
    timestamp: new Date().toISOString(),
    porta: process.env.HTTP_PORT || 8000,
  });
});

// ✅ Redis status endpoint
router.get('/redis/status', autenticar, apenasAdmin, async (req, res) => {
  try {
    const info = await redisService.getInfo();
    const stats = await redisService.getStats();
    const onlineDevices = await redisService.getOnlineDevices();

    res.json({
      sucesso: true,
      redis: info,
      stats: stats,
      dispositivosOnline: onlineDevices.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao buscar status do Redis',
      erro: error.message
    });
  }
});

// Heartbeat monitoring endpoints (protegido + multi-tenant)
const dispositivoService = require('../services/dispositivo.service');

// ✅ Multi-tenant: Verifica se dispositivo pertence à organização do usuário
const verificarDispositivoComando = async (req, res, next) => {
  const { imei } = req.params;
  if (!imei) return next();

  const dispositivo = await dispositivoService.getByImei(imei);
  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Super admin pode acessar qualquer dispositivo
  if (req.tenant?.isSuperAdmin) {
    req.dispositivo = dispositivo;
    return next();
  }

  // Verificar se pertence à organização do usuário
  if (req.tenant?.id && dispositivo.organizacao_id !== req.tenant.id) {
    return res.status(403).json({
      sucesso: false,
      mensagem: 'Dispositivo não pertence à sua organização',
    });
  }

  req.dispositivo = dispositivo;
  next();
};

// Cache global para heartbeats (TTL 5s) - compartilhado entre requests
let heartbeatsGlobalCache = null;
let heartbeatsCacheTime = 0;
const HEARTBEATS_CACHE_TTL = 5000; // 5 segundos
let heartbeatsFetching = false; // Evita múltiplas requisições simultâneas

router.get('/heartbeats', autenticar, tenantContext, async (req, res) => {
  try {
    const now = Date.now();
    const orgId = req.tenantFilter?.organizacao_id;

    // Função para filtrar por organização (multi-tenant)
    const filterByOrg = async (devices) => {
      if (!orgId) return devices; // Super admin vê tudo

      // Buscar IMEIs da organização
      const imeisOrg = await prisma.dispositivo.findMany({
        where: { organizacao_id: orgId },
        select: { imei: true }
      });
      const imeiSet = new Set(imeisOrg.map(d => d.imei));
      return devices.filter(d => imeiSet.has(d.imei));
    };

    // Função para calcular stats filtrados
    const calcFilteredStats = (filtered) => ({
      total_devices: filtered.length,
      connected: filtered.filter(d => d.status === 'connected').length,
      active: filtered.filter(d => d.status === 'active').length,
      idle: filtered.filter(d => d.status === 'idle').length,
      offline: filtered.filter(d => d.status === 'offline').length,
      // Somar contagens de heartbeats apenas dos dispositivos filtrados
      total_heartbeats: filtered.reduce((sum, d) => sum + (d.count || 0), 0),
      devices: filtered
    });

    // Se cache válido, retorna imediatamente (mas sempre filtra por org)
    if (heartbeatsGlobalCache && (now - heartbeatsCacheTime) < HEARTBEATS_CACHE_TTL) {
      const filtered = await filterByOrg(heartbeatsGlobalCache.devices);

      return res.json({
        sucesso: true,
        dados: calcFilteredStats(filtered),
        timestamp: new Date().toISOString(),
        cached: true
      });
    }

    // Se já está buscando, aguarda um pouco e retorna cache antigo (filtrado por org)
    if (heartbeatsFetching && heartbeatsGlobalCache) {
      const filtered = await filterByOrg(heartbeatsGlobalCache.devices);
      return res.json({
        sucesso: true,
        dados: calcFilteredStats(filtered),
        timestamp: new Date().toISOString(),
        cached: true
      });
    }

    heartbeatsFetching = true;

    // Buscar stats do heartbeat service (já usa Redis internamente)
    const allStats = await heartbeatService.getStats();

    // Montar cache global
    heartbeatsGlobalCache = {
      total_devices: allStats.total_devices || 0,
      connected: allStats.connected || 0,
      active: allStats.active || 0,
      idle: allStats.idle || 0,
      offline: allStats.offline || 0,
      total_heartbeats: allStats.total_heartbeats || 0,
      devices: allStats.devices || []
    };
    heartbeatsCacheTime = now;
    heartbeatsFetching = false;

    // Sempre filtrar por organização (multi-tenant security)
    const filtered = await filterByOrg(heartbeatsGlobalCache.devices);

    res.json({
      sucesso: true,
      dados: calcFilteredStats(filtered),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    heartbeatsFetching = false;
    console.error('Erro ao buscar heartbeats:', error);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao buscar heartbeats',
      erro: error.message
    });
  }
});

router.get('/heartbeats/:imei', autenticar, tenantContext, async (req, res) => {
  const { imei } = req.params;

  // ✅ Multi-tenant: Verificar se dispositivo pertence à organização
  if (req.tenantFilter?.organizacao_id) {
    const dispositivo = await dispositivoService.getByImei(imei);
    if (!dispositivo || dispositivo.organizacao_id !== req.tenantFilter.organizacao_id) {
      return res.status(403).json({
        sucesso: false,
        mensagem: 'Dispositivo não pertence à sua organização',
      });
    }
  }

  const heartbeat = heartbeatService.getRecent(imei);

  if (!heartbeat) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Nenhum heartbeat encontrado para este IMEI',
    });
  }

  res.json({
    sucesso: true,
    dados: heartbeat,
  });
});

// Localizações endpoint - retorna contadores horários (protegido + multi-tenant)
router.get('/localizacoes', autenticar, tenantContext, async (req, res) => {
  try {
    const orgId = req.tenantFilter?.organizacao_id;
    const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000);

    // ✅ Multi-tenant: Contar apenas localizações dos dispositivos da organização
    if (orgId) {
      // Buscar dispositivos da organização
      const dispositivos = await prisma.dispositivo.findMany({
        where: { organizacao_id: orgId },
        select: { id: true }
      });

      if (dispositivos.length === 0) {
        return res.json({
          sucesso: true,
          total: 0,
          heartbeats: 0,
          periodo: 'última hora',
          timestamp: new Date().toISOString(),
        });
      }

      const dispositivoIds = dispositivos.map(d => d.id);

      // Contar localizações da última hora para esses dispositivos
      const locCount = await prisma.localizacao.count({
        where: {
          dispositivo_id: { in: dispositivoIds },
          timestamp: { gte: umaHoraAtras }
        }
      });

      // Para heartbeats, usar contagem de dispositivos online
      const onlineCount = await prisma.dispositivo.count({
        where: {
          id: { in: dispositivoIds },
          status: 'online'
        }
      });

      return res.json({
        sucesso: true,
        total: locCount,
        heartbeats: onlineCount * 60, // Estimativa: dispositivos online * heartbeats esperados/hora
        periodo: 'última hora',
        timestamp: new Date().toISOString(),
      });
    }

    // Super admin vê stats globais
    const hourlyStats = await heartbeatService.getHourlyStats();

    res.json({
      sucesso: true,
      total: hourlyStats.locations,
      heartbeats: hourlyStats.heartbeats,
      periodo: 'última hora',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao carregar localizações',
      erro: error.message,
    });
  }
});

// ============ ROTAS PÚBLICAS (sem autenticação) ============
router.use('/auth', authRoutes); // ✅ Autenticação JWT (login, registro, refresh)
router.use('/auth-motorista', authMotoristaRoutes); // ✅ Autenticação Motoristas App Mobile (login CPF, vincular QR)
router.use('/', organizacaoRoutes); // ✅ Multi-tenant: Organizações (/organizacoes, /minha-organizacao, /convites, /planos)

// ✅ Tipos de dispositivos - PÚBLICO (para formulário de cadastro)
const { getHomologatedDeviceTypes, getAllDeviceTypes } = require('../constants/device-types');
const { getAllVehicleProfiles } = require('../constants/vehicle-profiles');

// ✅ Apresentação da Infraestrutura - PÚBLICO (para download)
router.get('/apresentacao', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getApresentacaoHTML());
});

function getApresentacaoHTML() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Arquitetura - Sistema de Rastreamento Veicular</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: linear-gradient(135deg, #1a1a2e, #16213e); color: #fff; min-height: 100vh; }
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
        .diagram { background: #0a0a1a; border-radius: 10px; padding: 20px; font-family: monospace; font-size: 10px; overflow-x: auto; white-space: pre; color: #00d4ff; }
        table { width: 100%; border-collapse: collapse; margin: 15px 0; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
        th { background: rgba(0,212,255,0.2); color: #00d4ff; }
        .component-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
        .component { background: rgba(255,255,255,0.03); border-radius: 10px; padding: 20px; border-left: 4px solid #00d4ff; }
        .component.green { border-left-color: #00ff88; }
        .component.purple { border-left-color: #7b2cbf; }
        .component.orange { border-left-color: #ff9500; }
        .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.8em; margin: 2px; background: rgba(0,212,255,0.3); color: #00d4ff; }
        .flow-diagram { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 10px; margin: 20px 0; }
        .flow-box { background: linear-gradient(135deg, #1e3a5f, #0d1b2a); border: 2px solid #00d4ff; border-radius: 10px; padding: 12px 20px; text-align: center; min-width: 100px; }
        .flow-arrow { color: #00d4ff; font-size: 1.5em; }
        .redundancy-box { display: flex; gap: 15px; justify-content: center; flex-wrap: wrap; margin: 15px 0; }
        .instance { background: linear-gradient(135deg, rgba(0,255,136,0.2), rgba(0,212,255,0.1)); border: 2px solid #00ff88; border-radius: 10px; padding: 15px; text-align: center; min-width: 120px; }
        .instance.down { border-color: #ff4757; opacity: 0.5; }
        .print-btn { position: fixed; top: 20px; right: 20px; background: linear-gradient(90deg, #00d4ff, #7b2cbf); color: white; border: none; padding: 12px 24px; border-radius: 25px; cursor: pointer; font-weight: bold; z-index: 1000; font-size: 14px; }
        @media print { body { background: white; color: black; } .print-btn { display: none; } .diagram { background: #f5f5f5; color: #333; } .stat-card .number { color: #333; -webkit-text-fill-color: #333; } }
    </style>
</head>
<body>
    <button class="print-btn" onclick="window.print()">Salvar como PDF</button>
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
                +-----------------------------------------------+
                |              REDIS (Message Queue + Cache)    |
                +-----------------------------------------------+
                                 |
            +--------------------+--------------------+
            v                    v                    v
      +-----------+        +-----------+        +-----------+
      | LOC PROC  |        | LOC PROC  |        | LOC PROC  |
      |   loc-1   |        |   loc-2   |        |   loc-3   |
      +-----------+        +-----------+        +-----------+
            +--------------------+--------------------+
                                 v
                +-----------------------------------------------+
                |  PGBOUNCER (Pool) -> POSTGRESQL + TIMESCALEDB |
                +-----------------------------------------------+</div>
        </div>
        <h2>Fluxo de Dados</h2>
        <div class="card">
            <h3>Entrada (Rastreador ao Sistema)</h3>
            <div class="flow-diagram">
                <div class="flow-box">Rastreador</div><span class="flow-arrow">-></span>
                <div class="flow-box">HAProxy</div><span class="flow-arrow">-></span>
                <div class="flow-box">TCP GW</div><span class="flow-arrow">-></span>
                <div class="flow-box">Redis</div><span class="flow-arrow">-></span>
                <div class="flow-box">Processor</div><span class="flow-arrow">-></span>
                <div class="flow-box">PostgreSQL</div>
            </div>
        </div>
        <h2>Componentes</h2>
        <div class="component-grid">
            <div class="component"><h3>HAProxy</h3><p>Load Balancer</p><span class="badge">TCP Round Robin</span><span class="badge">HTTP Least Conn</span></div>
            <div class="component green"><h3>TCP Gateways (3x)</h3><p>2000 conn/gateway = 6000 total</p><span class="badge">512MB RAM cada</span></div>
            <div class="component purple"><h3>Redis</h3><p>Message Queue + Cache</p><span class="badge">Streams</span><span class="badge">Pub/Sub</span></div>
            <div class="component orange"><h3>Location Processors (3x)</h3><p>Validacao GPS + Geofencing</p><span class="badge">Lock Distribuido</span></div>
            <div class="component"><h3>API Servers (2x)</h3><p>REST + WebSocket</p><span class="badge">JWT</span><span class="badge">Stateless</span></div>
            <div class="component"><h3>PostgreSQL + TimescaleDB</h3><p>Series temporais otimizadas</p><span class="badge">Hypertables</span></div>
        </div>
        <h2>Redundancia</h2>
        <div class="card">
            <h3>Cenario Normal</h3>
            <div class="redundancy-box">
                <div class="instance">GW-1: 2000</div>
                <div class="instance">GW-2: 2000</div>
                <div class="instance">GW-3: 2000</div>
            </div>
            <p style="text-align:center;color:#00ff88">Total: 6000 conexoes</p>
            <h3>1 Gateway Down (Failover Automatico)</h3>
            <div class="redundancy-box">
                <div class="instance down">GW-1: OFF</div>
                <div class="instance">GW-2: 3000</div>
                <div class="instance">GW-3: 3000</div>
            </div>
            <p style="text-align:center;color:#ff9500">Sistema continua operando sem interrupcao</p>
        </div>
        <h2>Recursos de Hardware</h2>
        <div class="card">
            <table>
                <tr><th>Componente</th><th>RAM</th><th>CPU</th><th>Instancias</th><th>Total</th></tr>
                <tr><td>HAProxy</td><td>128MB</td><td>0.5</td><td>1</td><td>128MB</td></tr>
                <tr><td>TCP Gateway</td><td>512MB</td><td>1</td><td>3</td><td>1.5GB</td></tr>
                <tr><td>Location Processor</td><td>1GB</td><td>2</td><td>3</td><td>3GB</td></tr>
                <tr><td>Status/Alarm Proc</td><td>512MB</td><td>1</td><td>2</td><td>1GB</td></tr>
                <tr><td>API Server</td><td>1.25GB</td><td>2</td><td>2</td><td>2.5GB</td></tr>
                <tr><td>PgBouncer</td><td>128MB</td><td>0.5</td><td>1</td><td>128MB</td></tr>
                <tr><td>Redis</td><td>1GB</td><td>2</td><td>1</td><td>1GB</td></tr>
                <tr><td>PostgreSQL</td><td>4GB</td><td>4</td><td>1</td><td>4GB</td></tr>
                <tr style="background:rgba(0,212,255,0.1);font-weight:bold"><td>TOTAL</td><td>-</td><td>~20</td><td>14</td><td>~13GB</td></tr>
            </table>
        </div>
        <h2>Seguranca</h2>
        <div class="component-grid">
            <div class="component"><h3>Rede</h3><p>Docker network isolada</p></div>
            <div class="component green"><h3>API</h3><p>JWT + Rate Limiting + CSRF</p></div>
            <div class="component purple"><h3>Dados (LGPD)</h3><p>AES-256-GCM criptografia</p></div>
            <div class="component orange"><h3>Banco</h3><p>Senha forte + Pool conexoes</p></div>
        </div>
        <h2>Metricas</h2>
        <div class="stats-grid">
            <div class="stat-card"><div class="number">~200</div><div class="label">Pacotes/Segundo</div></div>
            <div class="stat-card"><div class="number">17M</div><div class="label">Localizacoes/Dia</div></div>
            <div class="stat-card"><div class="number">&lt;50ms</div><div class="label">Processamento GPS</div></div>
            <div class="stat-card"><div class="number">~50GB</div><div class="label">Armazenamento/Mes</div></div>
        </div>
        <div class="card" style="text-align:center;margin-top:40px">
            <p style="color:#888">Fevereiro 2026 | v1.0</p>
            <p><span class="badge">Alta Disponibilidade</span><span class="badge">Escalavel</span><span class="badge">LGPD</span></p>
        </div>
    </div>
</body>
</html>`;
}

router.get('/dispositivos/tipos', (req, res) => {
  const { todos } = req.query;
  const tipos = todos === 'true' ? getAllDeviceTypes() : getHomologatedDeviceTypes();
  res.json({
    sucesso: true,
    total: tipos.length,
    tipos,
  });
});

router.get('/dispositivos/perfis-veiculo', (req, res) => {
  const perfis = getAllVehicleProfiles();
  res.json({
    sucesso: true,
    total: perfis.length,
    perfis,
  });
});

// ✅ Infraestrutura Docker - Status de containers e recomendações de scaling
router.use('/infraestrutura', autenticar, apenasAdmin, infraestruturaRoutes);

// ============ ROTAS PROTEGIDAS (requer autenticação + contexto de tenant) ============
router.use('/dispositivos', autenticar, tenantContext, dispositivosRoutes);
router.use('/analise-rota', autenticar, tenantContext, analiseRotaRoutes);
router.use('/exportar', autenticar, tenantContext, exportarRoutes);
router.use('/viagens', autenticar, tenantContext, viagemRoutes);
router.use('/gps-pipeline', autenticar, tenantContext, gpsPipelineRoutes); // ✅ Pipeline de correção GPS (Kalman → IA → Map-Match)
router.use('/speedlimit', autenticar, tenantContext, speedLimitRoutes); // ✅ Limites de velocidade das vias (OpenStreetMap)
router.use('/velocidade', autenticar, tenantContext, velocidadeRoutes); // ✅ Log e gráficos de velocidade por dispositivo
router.use('/gps-ai', autenticar, tenantContext, gpsAIRoutes); // ✅ IA para correção de rotas GPS (Kalman + Outliers)
router.use('/gps-unificado', autenticar, tenantContext, gpsUnificadoRoutes); // ✅ Servico GPS Unificado - USE ESTE!
router.use('/geofencing', autenticar, tenantContext, geofencingRoutes); // ✅ Geofencing: Cercas Virtuais
router.use('/notificacoes', autenticar, tenantContext, notificacaoRoutes); // ✅ Sistema de Notificações
router.use('/motoristas', autenticar, tenantContext, motoristaRoutes); // ✅ Cadastro de Motoristas
router.use('/veiculos', autenticar, tenantContext, veiculosRoutes); // ✅ Gestão de Veículos (permite trocar rastreador sem perder histórico)
router.use('/multas', autenticar, tenantContext, multaRoutes); // ✅ Gestão de Multas de Trânsito
router.use('/tags', autenticar, tenantContext, tagRoutes); // ✅ Tags de Veículos (categorização por região, tipo, etc)
router.use('/insights', autenticar, tenantContext, insightRoutes); // ✅ Insights de IA (análise automática de padrões)
router.use('/lgpd', lgpdRoutes); // ✅ LGPD: Consentimentos e Exclusão de Dados (autenticação no próprio arquivo)
router.use('/relatorios', autenticar, tenantContext, relatoriosRoutes); // ✅ Relatórios Avançados
router.use('/perfis-permissao', perfilPermissaoRoutes); // ✅ Perfis de Permissão (autenticação no próprio arquivo)

// ============ ENDPOINTS DE COMANDOS (PROTEGIDO) ============

// Listar comandos disponíveis
router.get('/comandos', autenticar, (req, res) => {
  res.json({
    sucesso: true,
    x3tech: X3TECH_COMMANDS || {
      GPS_ON: '#55555#YGPS#1#',
      GPS_OFF: '#55555#YGPS#0#',
      OBD_ON: '#55555#YOBD#1#',
      OBD_OFF: '#55555#YOBD#0#',
      UPLOAD_10S: '#55555#YUP#10#',
      UPLOAD_30S: '#55555#YUP#30#',
      UPLOAD_60S: '#55555#YUP#60#',
      DIAG_ON: '#55555#YDIAG#1#',
      STATUS: '#55555#YSTATUS#',
      VERSION: '#55555#YVERSION#',
      NETWORK: '#55555#YNETWORK#',
    },
    teltonika: TELTONIKA_COMMANDS || {
      GET_INFO: 'getinfo',
      GET_VER: 'getver',
      GET_GPS: 'getgps',
      GET_IO: 'getio',
      FLUSH_DATA: 'flush',
      RESTART: 'cpureset',
    },
    uso: 'POST /api/comandos/:imei com body { "comando": "GPS_ON" } ou { "comandoRaw": "#55555#YGPS#1#" }',
  });
});

// Listar dispositivos conectados
router.get('/conexoes', autenticar, (req, res) => {
  const conectados = [];

  // X3Tech connections
  if (activeConnections) {
    activeConnections.forEach((socket, imei) => {
      if (socket && !socket.destroyed) {
        conectados.push({
          imei,
          tipo: 'X3TECH',
          conectado: true,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });
      }
    });
  }

  // Teltonika connections
  if (teltonikaConnections) {
    teltonikaConnections.forEach((socket, imei) => {
      if (socket && !socket.destroyed) {
        conectados.push({
          imei,
          tipo: 'TELTONIKA',
          conectado: true,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
        });
      }
    });
  }

  res.json({
    sucesso: true,
    total: conectados.length,
    x3tech: conectados.filter(d => d.tipo === 'X3TECH').length,
    teltonika: conectados.filter(d => d.tipo === 'TELTONIKA').length,
    dispositivos: conectados,
  });
});

// Enviar comando para dispositivo
// ✅ Multi-tenant: Verifica propriedade do dispositivo antes de enviar comando
router.post('/comandos/:imei', autenticar, tenantContext, verificarDispositivoComando, (req, res) => {
  const { imei } = req.params;
  const { comando, comandoRaw } = req.body;

  // Verificar se dispositivo está conectado em X3Tech
  let socket = activeConnections ? activeConnections.get(imei) : null;
  let deviceType = 'X3TECH';

  // Se não está em X3Tech, verificar Teltonika
  if (!socket || socket.destroyed) {
    socket = teltonikaConnections ? teltonikaConnections.get(imei) : null;
    deviceType = 'TELTONIKA';
  }

  if (!socket || socket.destroyed) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
      dica: 'Use GET /api/conexoes para ver dispositivos conectados',
    });
  }

  // Determinar comando a enviar baseado no tipo de dispositivo
  let cmdToSend;
  if (comandoRaw) {
    cmdToSend = comandoRaw;
  } else if (deviceType === 'TELTONIKA') {
    // Para Teltonika, usar comandos específicos
    if (comando && TELTONIKA_COMMANDS && TELTONIKA_COMMANDS[comando]) {
      cmdToSend = TELTONIKA_COMMANDS[comando];
    } else if (comando) {
      cmdToSend = comando;
    } else {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'Comando não especificado',
        uso: '{ "comando": "GET_INFO" } ou { "comandoRaw": "getinfo" }',
        comandosDisponiveis: Object.keys(TELTONIKA_COMMANDS || {}),
      });
    }
  } else {
    // Para X3Tech
    if (comando && X3TECH_COMMANDS && X3TECH_COMMANDS[comando]) {
      cmdToSend = X3TECH_COMMANDS[comando];
    } else if (comando) {
      cmdToSend = comando;
    } else {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'Comando não especificado',
        uso: '{ "comando": "GPS_ON" } ou { "comandoRaw": "#55555#YGPS#1#" }',
      });
    }
  }

  try {
    if (deviceType === 'TELTONIKA' && teltonikaSendCommand) {
      // Usar função de envio específica do Teltonika (Codec 12)
      const result = teltonikaSendCommand(imei, cmdToSend);
      console.log(`📤 [API CMD:Teltonika] Enviado para ${imei}: ${cmdToSend}`);

      res.json({
        sucesso: result.success,
        mensagem: result.success ? 'Comando enviado com sucesso' : result.error,
        imei,
        tipo: deviceType,
        comando: cmdToSend,
        timestamp: new Date().toISOString(),
      });
    } else {
      // X3Tech: enviar como texto ASCII
      const cmdBuffer = Buffer.from(cmdToSend + '\r\n', 'ascii');
      socket.write(cmdBuffer);
      console.log(`📤 [API CMD:X3Tech] Enviado para ${imei}: ${cmdToSend}`);

      res.json({
        sucesso: true,
        mensagem: 'Comando enviado com sucesso',
        imei,
        tipo: deviceType,
        comando: cmdToSend,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error(`[API CMD] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao enviar comando',
      erro: error.message,
    });
  }
});

// Enviar todos os comandos de inicialização
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/comandos/:imei/init', autenticar, tenantContext, verificarDispositivoComando, async (req, res) => {
  const { imei } = req.params;

  if (!activeConnections) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Sistema ainda inicializando',
    });
  }

  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
    });
  }

  const commands = X3TECH_COMMANDS || {};
  const initCommands = [
    { cmd: commands.GPS_ON || '#55555#YGPS#1#', desc: 'Ativar GPS' },
    { cmd: commands.OBD_ON || '#55555#YOBD#1#', desc: 'Ativar OBD2' },
    { cmd: commands.UPLOAD_10S || '#55555#YUP#10#', desc: 'Intervalo 10s' },
    { cmd: commands.ONLINE_ON || '#55555#YONLINE#1#', desc: 'Modo Online' },
    { cmd: commands.CONNECT_ON || '#55555#YCONNECT#1#', desc: 'Manter Conexão' },
    { cmd: commands.DIAG_ON || '#55555#YDIAG#1#', desc: 'Diagnóstico' },
  ];

  const results = [];
  for (const { cmd, desc } of initCommands) {
    try {
      const cmdBuffer = Buffer.from(cmd + '\r\n', 'ascii');
      socket.write(cmdBuffer);
      results.push({ comando: cmd, descricao: desc, sucesso: true });
      console.log(`📤 [API Init] ${imei}: ${desc}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      results.push({ comando: cmd, descricao: desc, sucesso: false, erro: error.message });
    }
  }

  res.json({
    sucesso: true,
    mensagem: 'Comandos de inicialização enviados',
    imei,
    resultados: results,
    timestamp: new Date().toISOString(),
  });
});

// ============ NOVOS ENDPOINTS COM PROTOCOLO 0x80 ============

// Listar comandos disponíveis para protocolo 0x80
router.get('/comandos/disponiveis', autenticar, (req, res) => {
  res.json({
    sucesso: true,
    comandos_protocolos: {
      protocolo_0x80: {
        descricao: 'Comandos enviados via protocolo binário 0x80 (método correto conforme documentação XT40)',
        comandos: [
          { nome: 'SETLOCX22#', descricao: 'Ativa protocolo 0x22 com dados completos (bateria, horímetro, odômetro)' },
          { nome: 'PARAM#', descricao: 'Consulta configuração atual (APN, IP, IMEI, TIMER, PROTOCOL, GMT, language)' },
          { nome: 'STATUS#', descricao: 'Consulta status atual (BATTERY%, GPS, ACC, VOLTAGE)' },
          { nome: 'TIMER,30#', descricao: 'Define intervalo de envio de dados (em segundos)' },
          { nome: 'HBT,1.5#', descricao: 'Define intervalo de heartbeat (em minutos)' }
        ],
        uso: 'POST /api/comandos/:imei/enviar com body { "comando": "SETLOCX22#" }'
      },
      protocolo_texto: {
        descricao: 'Comandos antigos em texto simples (compatibilidade)',
        comandos: X3TECH_COMMANDS || {},
        uso: 'POST /api/comandos/:imei com body { "comando": "GPS_ON" }'
      }
    }
  });
});

// Enviar comando via protocolo 0x80 (método correto)
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/comandos/:imei/enviar', autenticar, tenantContext, verificarDispositivoComando, async (req, res) => {
  const { imei } = req.params;
  const { comando } = req.body;

  if (!comando) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Comando não especificado',
      uso: '{ "comando": "SETLOCX22#" }'
    });
  }

  if (!comandoService.isOnline(imei)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
      dica: 'Use GET /api/conexoes para ver dispositivos conectados'
    });
  }

  try {
    const result = await comandoService.sendCommand(imei, comando);

    res.json({
      sucesso: result.success,
      mensagem: result.success ? 'Comando enviado com sucesso' : 'Falha ao enviar comando',
      imei,
      comando,
      resposta: result.response || result.message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[API CMD 0x80] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao enviar comando',
      erro: error.message
    });
  }
});

// Ativar configuração completa automaticamente (SETLOCX22# + outros)
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/comandos/:imei/ativar', autenticar, tenantContext, verificarDispositivoComando, async (req, res) => {
  const { imei } = req.params;

  if (!comandoService.isOnline(imei)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
      dica: 'Use GET /api/conexoes para ver dispositivos conectados'
    });
  }

  try {
    const results = await comandoService.setupNewDevice(imei);

    const todosOk = results.every(r => r.success);

    res.json({
      sucesso: todosOk,
      mensagem: todosOk
        ? 'Dispositivo configurado com sucesso! Protocolo 0x22 ativado.'
        : 'Alguns comandos falharam. Verifique os resultados.',
      imei,
      resultados: results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[API Ativar] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao ativar dispositivo',
      erro: error.message
    });
  }
});

// ============ ENDPOINTS DE CORTE DE COMBUSTÍVEL ============
// Seção 6.3.1 e 6.3.2 do protocolo XT40
// IMPORTANTE: Verificações de segurança antes de cortar combustível

// Cortar combustível (RELAY OFF) - APENAS ADMIN
// ✅ Multi-tenant: CRÍTICO - Verifica propriedade do dispositivo antes de cortar combustível
router.post('/comandos/:imei/cortar-combustivel', autenticar, tenantContext, verificarDispositivoComando, apenasAdmin, async (req, res) => {
  const { imei } = req.params;
  const { forcarCorte } = req.body; // Para ignorar verificações de segurança

  if (!comandoService.isOnline(imei)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
      dica: 'Use GET /api/conexoes para ver dispositivos conectados'
    });
  }

  try {
    // Verificações de segurança (podem ser ignoradas com forcarCorte=true)
    if (!forcarCorte) {
      // Buscar última localização para verificar velocidade
      const locAtual = await localizacaoService.getCurrent(imei);

      if (!locAtual) {
        return res.status(400).json({
          sucesso: false,
          mensagem: 'Sem dados de GPS. Não é seguro cortar combustível.',
          codigo: 'NO_GPS_DATA',
          dica: 'Use forcarCorte: true para ignorar esta verificação (NÃO RECOMENDADO)'
        });
      }

      // Verificar se coordenadas são válidas (0,0 = sem sinal GPS)
      if (locAtual.latitude === 0 && locAtual.longitude === 0) {
        return res.status(400).json({
          sucesso: false,
          mensagem: 'GPS sem sinal (0,0). Não é seguro cortar combustível.',
          codigo: 'GPS_NO_SIGNAL',
          dica: 'Aguarde o dispositivo obter sinal GPS ou use forcarCorte: true'
        });
      }

      // Verificar velocidade (não cortar se > 20 km/h conforme documentação)
      const VELOCIDADE_MAXIMA_CORTE = 20;
      if (locAtual.velocidade > VELOCIDADE_MAXIMA_CORTE) {
        return res.status(400).json({
          sucesso: false,
          mensagem: `Veículo em movimento (${locAtual.velocidade} km/h). Velocidade máxima para corte: ${VELOCIDADE_MAXIMA_CORTE} km/h`,
          codigo: 'SPEED_TOO_HIGH',
          velocidade_atual: locAtual.velocidade,
          velocidade_maxima: VELOCIDADE_MAXIMA_CORTE,
          dica: 'Aguarde o veículo parar ou use forcarCorte: true (PERIGOSO!)'
        });
      }
    }

    // Enviar comando de corte via protocolo 0x80
    const result = await comandoService.sendCommand(imei, 'DYD,000000#');

    res.json({
      sucesso: result.success,
      mensagem: result.success
        ? '⚠️ COMBUSTÍVEL CORTADO! O veículo não poderá ser ligado.'
        : 'Falha ao enviar comando de corte',
      imei,
      comando: 'DYD,000000#',
      resposta: result.response || result.message,
      forcado: forcarCorte || false,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[API Corte] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao cortar combustível',
      erro: error.message
    });
  }
});

// Restaurar combustível (RELAY ON) - APENAS ADMIN
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/comandos/:imei/restaurar-combustivel', autenticar, tenantContext, verificarDispositivoComando, apenasAdmin, async (req, res) => {
  const { imei } = req.params;

  if (!comandoService.isOnline(imei)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`,
      dica: 'Use GET /api/conexoes para ver dispositivos conectados'
    });
  }

  try {
    // Enviar comando de restauração via protocolo 0x80
    const result = await comandoService.sendCommand(imei, 'HFYD,000000#');

    res.json({
      sucesso: result.success,
      mensagem: result.success
        ? '✅ Combustível restaurado! O veículo pode ser ligado normalmente.'
        : 'Falha ao enviar comando de restauração',
      imei,
      comando: 'HFYD,000000#',
      resposta: result.response || result.message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[API Restaurar] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao restaurar combustível',
      erro: error.message
    });
  }
});

// Consultar status do relé (se possível)
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/comandos/:imei/status-rele', autenticar, tenantContext, verificarDispositivoComando, async (req, res) => {
  const { imei } = req.params;

  if (!comandoService.isOnline(imei)) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Dispositivo ${imei} não está conectado`
    });
  }

  try {
    // Enviar comando STATUS para obter informações
    const result = await comandoService.sendCommand(imei, 'STATUS#');

    res.json({
      sucesso: result.success,
      mensagem: result.success ? 'Status consultado' : 'Falha ao consultar status',
      imei,
      resposta: result.response || result.message,
      timestamp: new Date().toISOString(),
      nota: 'O campo "relay" na resposta indica: ON=combustível ligado, OFF=combustível cortado'
    });
  } catch (error) {
    console.error(`[API Status Relé] Erro: ${error.message}`);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao consultar status',
      erro: error.message
    });
  }
});

// ============ ENDPOINTS DE DEBUG PARA ANÁLISE DE PACOTES ============

// Armazenar estatísticas de pacotes em memória
const packetStats = {
  total: 0,
  login: 0,
  location: 0,
  obd2: 0,
  alarm: 0,
  status: 0,
  lastPackets: [], // Últimos 50 pacotes
  // ✅ NOVO: Contadores por Location Source Type (protocolo 0x22)
  location_source: {
    tracking: 0,  // 0x01 - Dados de movimento real
    static: 0,    // 0x02 - Veículo parado (filtrados)
    alarm: 0,     // 0x03 - Eventos de alarme
    unknown: 0    // Outros valores
  }
};

// Métodos para registrar pacotes (será chamado do index.js)
router.recordPacket = (type) => {
  packetStats.total++;
  if (packetStats[type] !== undefined) {
    packetStats[type]++;
  }
};

router.recordPacketDetails = (packetData) => {
  packetStats.lastPackets.unshift({
    ...packetData,
    recordedAt: new Date().toISOString()
  });
  // Manter apenas últimos 50 pacotes
  if (packetStats.lastPackets.length > 50) {
    packetStats.lastPackets.pop();
  }

  // ✅ NOVO: Contar Location Source Types para pacotes de localização
  if (packetData.type === 'location' && packetData.data?.location_source_type !== undefined) {
    const sourceType = packetData.data.location_source_type;
    if (sourceType === 0x01) {
      packetStats.location_source.tracking++;
    } else if (sourceType === 0x02) {
      packetStats.location_source.static++;
    } else if (sourceType === 0x03) {
      packetStats.location_source.alarm++;
    } else {
      packetStats.location_source.unknown++;
    }
  }
};

// GET /api/debug/packets - Retorna estatísticas de pacotes (admin)
router.get('/debug/packets', autenticar, apenasAdmin, (req, res) => {
  res.json({
    sucesso: true,
    estatisticas: {
      total: packetStats.total,
      por_tipo: {
        login: packetStats.login,
        location: packetStats.location,
        obd2: packetStats.obd2,
        alarm: packetStats.alarm,
        status: packetStats.status
      },
      // ✅ NOVO: Breakdown de Location Source Type (protocolo 0x22)
      location_source_breakdown: {
        tracking: packetStats.location_source.tracking,  // 0x01 - Movimento real (salvos)
        static: packetStats.location_source.static,      // 0x02 - Parado (filtrados)
        alarm: packetStats.location_source.alarm,        // 0x03 - Alarmes
        unknown: packetStats.location_source.unknown,
        nota: 'Pacotes Static (0x02) são filtrados e não salvos como localização de movimento'
      },
      ultimos_pacotes_count: packetStats.lastPackets.length
    },
    ultimos_pacotes: packetStats.lastPackets,
    timestamp: new Date().toISOString()
  });
});

// POST /api/debug/reset - Resetar estatísticas (admin)
router.post('/debug/reset', autenticar, apenasAdmin, (req, res) => {
  packetStats.total = 0;
  packetStats.login = 0;
  packetStats.location = 0;
  packetStats.obd2 = 0;
  packetStats.alarm = 0;
  packetStats.status = 0;
  packetStats.lastPackets = [];
  // ✅ NOVO: Resetar contadores de Location Source Type
  packetStats.location_source.tracking = 0;
  packetStats.location_source.static = 0;
  packetStats.location_source.alarm = 0;
  packetStats.location_source.unknown = 0;

  res.json({
    sucesso: true,
    mensagem: 'Estatísticas resetadas (incluindo Location Source Types)',
    timestamp: new Date().toISOString()
  });
});

// ============ ENDPOINTS DE MONITORAMENTO DO SISTEMA ============

// GET /api/system/metrics - Metricas completas do sistema (admin)
router.get('/system/metrics', autenticar, apenasAdmin, async (req, res) => {
  try {
    const metrics = await systemMonitorService.getAll();
    res.json({
      sucesso: true,
      dados: metrics,
    });
  } catch (error) {
    console.error('[System Monitor] Error:', error.message);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao coletar metricas do sistema',
      erro: error.message,
    });
  }
});

// GET /api/system/quick - Metricas rapidas (para polling frequente)
router.get('/system/quick', autenticar, (req, res) => {
  try {
    const quickStats = systemMonitorService.getQuickStats();
    res.json({
      sucesso: true,
      dados: quickStats,
    });
  } catch (error) {
    console.error('[System Monitor] Error:', error.message);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao coletar metricas rapidas',
      erro: error.message,
    });
  }
});

// GET /api/system/health - Status de saude do sistema (público para health checks)
router.get('/system/health', async (req, res) => {
  try {
    const metrics = await systemMonitorService.getAll();
    const isHealthy = metrics.healthStatus === 'healthy';

    res.status(isHealthy ? 200 : 503).json({
      sucesso: true,
      status: metrics.healthStatus,
      alertas: metrics.alerts,
      resumo: {
        cpu: `${metrics.cpu.usage}%`,
        memoria: `${metrics.memory.usage}%`,
        disco: `${metrics.disk.usage}%`,
        uptime: metrics.os.uptimeFormatted,
      },
      timestamp: metrics.timestamp,
    });
  } catch (error) {
    console.error('[System Health] Error:', error.message);
    res.status(500).json({
      sucesso: false,
      status: 'error',
      mensagem: 'Erro ao verificar saude do sistema',
      erro: error.message,
    });
  }
});

// GET /api/system/stats - Estatisticas agregadas de metricas (admin)
router.get('/system/stats', autenticar, apenasAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const stats = await metricsPersistence.getStats(hours);

    res.json({
      sucesso: true,
      dados: stats,
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao obter estatisticas',
      erro: error.message,
    });
  }
});

// GET /api/system/history - Historico de metricas por periodo (admin)
router.get('/system/history', autenticar, apenasAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 1;
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const records = await metricsPersistence.getByPeriod(startDate, new Date(), 500);

    res.json({
      sucesso: true,
      total: records.length,
      periodo: `${hours} horas`,
      dados: records.map(r => ({
        timestamp: r.timestamp,
        cpu: r.cpu_usage,
        memoria: r.mem_usage,
        disco: r.disk_usage,
        load: r.load_1min,
        health: r.health_status,
      })),
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao obter historico',
      erro: error.message,
    });
  }
});

// GET /api/system/memory - Estatísticas de caches em memória (admin)
// Útil para monitorar uso de memória e identificar memory leaks
router.get('/system/memory', autenticar, apenasAdmin, async (req, res) => {
  try {
    const cacheStats = cacheStatsService.getDetailedStats();
    const heartbeatSize = await heartbeatService.getCacheSize();

    res.json({
      sucesso: true,
      dados: {
        caches: {
          ...cacheStats,
          heartbeats: {
            size: heartbeatSize,
            maxAgeMs: 24 * 60 * 60 * 1000, // 24 horas
            description: 'Cache de heartbeats por IMEI'
          }
        },
        totalEntradas: cacheStatsService.getTotalEntries() + heartbeatSize,
        observacao: 'Esses caches armazenam apenas dados técnicos (IMEI, timestamps). Dados pessoais estão no banco de dados.',
        limpezaAutomatica: 'A cada 1 hora são removidas entradas antigas conforme TTL de cada cache'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao obter estatísticas de memória',
      erro: error.message
    });
  }
});

// POST /api/system/memory/cleanup - Força limpeza manual dos caches (admin)
router.post('/system/memory/cleanup', autenticar, apenasAdmin, async (req, res) => {
  try {
    const cacheResults = cacheStatsService.cleanupAll();
    const heartbeatRemoved = heartbeatService.cleanupStaleEntries(24);

    const totalRemoved = Object.values(cacheResults)
      .filter(r => !r.skipped)
      .reduce((acc, r) => acc + r.removed, 0) + heartbeatRemoved;

    logger.info('MemoryCleanup', `Limpeza manual executada: ${totalRemoved} entradas removidas`);

    res.json({
      sucesso: true,
      mensagem: `Limpeza executada: ${totalRemoved} entradas removidas`,
      detalhes: {
        ...cacheResults,
        heartbeats: { removed: heartbeatRemoved }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao executar limpeza de memória',
      erro: error.message
    });
  }
});

// GET /api/system/pipeline-debug - Debug do pipeline GPS (admin)
router.get('/system/pipeline-debug', autenticar, apenasAdmin, async (req, res) => {
  try {
    const Redis = require('ioredis');
    const prisma = require('../db/prisma');

    // Criar conexão direta ao Redis DB 2 (streams)
    const redisStreamsClient = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 2,
      lazyConnect: false
    });

    // Conexão DB 0 (conexões TCP)
    const redisDefault = new Redis({
      host: process.env.REDIS_HOST || 'redis',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: 0,
      lazyConnect: false
    });

    // 1. Filas Redis (partições de location) - DB 2
    const queues = [];
    let totalLag = 0;
    for (let i = 0; i < 4; i++) {
      try {
        const len = await redisStreamsClient.xlen(`gps:packets:location:${i}`);
        queues.push(len || 0);
        totalLag += len || 0;
      } catch (e) {
        console.error(`[PipelineDebug] Erro ao ler fila ${i}:`, e.message);
        queues.push(0);
      }
    }

    // 2. Conexões TCP ativas - DB 0 (chaves dev:*)
    let connections = 0;
    try {
      const devKeys = await redisDefault.keys('dev:*');
      connections = devKeys ? devKeys.length : 0;
    } catch (e) {
      console.error('[PipelineDebug] Erro ao ler conexões:', e.message);
    }

    // 3. Consumers ativos - DB 2 (verificar TODAS as 4 partições)
    let consumers = 0;
    try {
      for (let i = 0; i < 4; i++) {
        const groupName = `location-processors-p${i}`;
        const consumerInfo = await redisStreamsClient.xinfo('CONSUMERS', `gps:packets:location:${i}`, groupName);
        if (Array.isArray(consumerInfo) && consumerInfo.length > 0) {
          consumers += consumerInfo.length;
        }
      }
    } catch (e) {
      console.error('[PipelineDebug] Erro ao ler consumers:', e.message);
    }

    // Fechar conexões temporárias
    await redisStreamsClient.quit();
    await redisDefault.quit();

    // 4. Latência (últimos 10 registros)
    let latencyData = { avg: 0, min: 0, max: 0, lastInsert: '-' };
    let recentData = [];
    try {
      const recentLocs = await prisma.localizacao.findMany({
        take: 10,
        orderBy: { created_at: 'desc' },
        select: {
          timestamp: true,
          created_at: true,
          velocidade: true,
          dispositivo: {
            select: {
              imei: true,
              placa: true
            }
          }
        }
      });

      if (recentLocs.length > 0) {
        const delays = recentLocs.map(l => {
          const ts = new Date(l.timestamp);
          const ca = new Date(l.created_at);
          return Math.round((ca - ts) / 1000);
        }).filter(d => d >= 0 && d < 86400); // Filtrar valores absurdos

        if (delays.length > 0) {
          latencyData.avg = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
          latencyData.min = Math.min(...delays);
          latencyData.max = Math.max(...delays);
        }

        latencyData.lastInsert = new Date(recentLocs[0].created_at).toLocaleTimeString('pt-BR');

        recentData = recentLocs.map(l => ({
          imei: l.dispositivo?.imei || '-',
          placa: l.dispositivo?.placa || '-',
          timestampGps: new Date(l.timestamp).toLocaleString('pt-BR'),
          createdAt: new Date(l.created_at).toLocaleTimeString('pt-BR'),
          delay: Math.round((new Date(l.created_at) - new Date(l.timestamp)) / 1000),
          velocidade: l.velocidade || 0
        }));
      }
    } catch (e) {
      console.error('Erro ao buscar latência:', e);
    }

    // 5. Throughput (inserções no último minuto)
    let insertsPerMin = 0;
    let inserts5Min = 0;
    try {
      const oneMinAgo = new Date(Date.now() - 60000);
      const fiveMinAgo = new Date(Date.now() - 300000);
      insertsPerMin = await prisma.localizacao.count({
        where: { created_at: { gte: oneMinAgo } }
      });
      inserts5Min = await prisma.localizacao.count({
        where: { created_at: { gte: fiveMinAgo } }
      });
    } catch (e) {}

    // 5b. ✅ NOVO: Estatísticas por tipo de dispositivo
    let deviceTypeStats = [];
    try {
      const oneMinAgo = new Date(Date.now() - 60000);
      const fiveMinAgo = new Date(Date.now() - 300000);

      // Buscar contagem por tipo de dispositivo
      const tipoStats = await prisma.$queryRaw`
        SELECT
          d.tipo,
          COUNT(DISTINCT d.id) as total_devices,
          COUNT(CASE WHEN d.status = 'online' THEN 1 END) as online,
          COUNT(l.id) FILTER (WHERE l.created_at >= ${oneMinAgo}) as inserts_1min,
          COUNT(l.id) FILTER (WHERE l.created_at >= ${fiveMinAgo}) as inserts_5min,
          ROUND(AVG(EXTRACT(EPOCH FROM (l.created_at - l.timestamp)))::numeric, 1) FILTER (WHERE l.created_at >= ${fiveMinAgo}) as avg_delay_sec
        FROM dispositivos d
        LEFT JOIN localizacoes l ON l.dispositivo_id = d.id AND l.created_at >= ${fiveMinAgo}
        WHERE d.tipo IS NOT NULL
        GROUP BY d.tipo
        ORDER BY d.tipo
      `;

      deviceTypeStats = tipoStats.map(s => ({
        tipo: s.tipo || 'Desconhecido',
        totalDevices: Number(s.total_devices) || 0,
        online: Number(s.online) || 0,
        inserts1min: Number(s.inserts_1min) || 0,
        inserts5min: Number(s.inserts_5min) || 0,
        avgDelaySec: Number(s.avg_delay_sec) || 0
      }));
    } catch (e) {
      console.warn('[PipelineDebug] Erro ao buscar stats por tipo:', e.message);
    }

    // 5c. ✅ NOVO: Estatísticas detalhadas por partição
    let partitionStats = [];
    try {
      const redisPartitions = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: 2,
        lazyConnect: false
      });

      for (let i = 0; i < 4; i++) {
        const stream = `gps:packets:location:${i}`;
        const groupName = `location-processors-p${i}`;

        let partInfo = {
          id: i,
          length: queues[i] || 0,
          consumers: 0,
          pendingCount: 0,
          lastDelivered: null,
          oldestPending: null
        };

        try {
          // Info do grupo
          const groupInfo = await redisPartitions.xinfo('GROUPS', stream);
          if (Array.isArray(groupInfo) && groupInfo.length > 0) {
            for (const group of groupInfo) {
              const groupData = {};
              for (let j = 0; j < group.length; j += 2) {
                groupData[group[j]] = group[j + 1];
              }
              if (groupData.name === groupName) {
                partInfo.consumers = groupData.consumers || 0;
                partInfo.pendingCount = groupData.pending || 0;
                partInfo.lastDelivered = groupData['last-delivered-id'] || null;
              }
            }
          }

          // Consumers ativos
          const consumerInfo = await redisPartitions.xinfo('CONSUMERS', stream, groupName);
          if (Array.isArray(consumerInfo)) {
            partInfo.activeConsumers = consumerInfo.map(c => {
              const consumerData = {};
              for (let j = 0; j < c.length; j += 2) {
                consumerData[c[j]] = c[j + 1];
              }
              return {
                name: consumerData.name,
                pending: consumerData.pending || 0,
                idle: Math.round((consumerData.idle || 0) / 1000)
              };
            });
          }
        } catch (e) {
          // Stream ou grupo pode não existir ainda
        }

        partitionStats.push(partInfo);
      }

      await redisPartitions.quit();
    } catch (e) {
      console.warn('[PipelineDebug] Erro ao buscar stats de partição:', e.message);
    }

    // 6. Gerar alertas baseados nos dados
    const alerts = [];
    const MAXLEN = 5000;

    // Alerta de filas acumulando
    queues.forEach((q, i) => {
      if (q >= MAXLEN) {
        alerts.push({
          type: 'error',
          component: `Redis P${i}`,
          message: `Partição ${i} no MAXLEN (${q}/${MAXLEN}) - dados sendo descartados!`,
          action: 'Verificar location-processor-' + i
        });
      } else if (q > 1000) {
        alerts.push({
          type: 'warning',
          component: `Redis P${i}`,
          message: `Partição ${i} acumulando (${q} msgs)`,
          action: 'Monitorar processor'
        });
      }
    });

    // Alerta de latência alta
    if (latencyData.avg > 300) {
      alerts.push({
        type: 'error',
        component: 'Latência',
        message: `Delay médio de ${Math.round(latencyData.avg / 60)} minutos!`,
        action: 'Filas acumuladas ou processors parados'
      });
    } else if (latencyData.avg > 60) {
      alerts.push({
        type: 'warning',
        component: 'Latência',
        message: `Delay médio de ${latencyData.avg}s`,
        action: 'Verificar throughput dos processors'
      });
    }

    // Alerta de conexões TCP
    if (connections === 0) {
      alerts.push({
        type: 'warning',
        component: 'TCP Gateway',
        message: 'Nenhuma conexão TCP ativa',
        action: 'Verificar se gateways estão rodando'
      });
    }

    // Alerta de consumers
    if (consumers < 4) {
      alerts.push({
        type: 'warning',
        component: 'Processors',
        message: `Apenas ${consumers} de 4 consumers ativos`,
        action: 'Reiniciar location-processors'
      });
    }

    // Alerta de inserções
    if (insertsPerMin === 0 && totalLag > 0) {
      alerts.push({
        type: 'error',
        component: 'Database',
        message: 'Filas com dados mas sem inserções!',
        action: 'Processors não estão processando'
      });
    }

    // 7. ✅ NOVO: Métricas do GPS Pipeline (dos location-processors via Redis)
    let pipelineMetrics = {
      totalKalmanFilters: 0,
      totalPendingPoints: 0,
      totalTrackedDevices: 0,
      totalProcessed: 0,
      avgProcessingTimeMs: 0,
      workers: [],
      alerts: []
    };

    try {
      const redisPipeline = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: 0,
        lazyConnect: false
      });

      // Buscar métricas de todos os workers
      const keys = await redisPipeline.keys('gps:pipeline:metrics:*');
      for (const key of keys) {
        try {
          const data = await redisPipeline.get(key);
          if (data) {
            const metrics = JSON.parse(data);
            const age = Date.now() - metrics.timestamp;

            // Só considerar métricas recentes (< 2 min)
            if (age < 120000) {
              pipelineMetrics.workers.push({
                id: metrics.workerId,
                kalmanFilters: metrics.kalmanFiltersSize,
                pendingPoints: metrics.pendingPointsSize,
                trackedDevices: metrics.trackedDevices,
                processed: metrics.processed,
                avgTimeMs: Math.round(metrics.avgProcessingTimeMs * 10) / 10,
                age: Math.round(age / 1000)
              });

              pipelineMetrics.totalKalmanFilters += metrics.kalmanFiltersSize || 0;
              pipelineMetrics.totalPendingPoints += metrics.pendingPointsSize || 0;
              pipelineMetrics.totalTrackedDevices += metrics.trackedDevices || 0;
              pipelineMetrics.totalProcessed += metrics.processed || 0;
            }
          }
        } catch (e) {}
      }

      // Calcular média de tempo de processamento
      if (pipelineMetrics.workers.length > 0) {
        const avgTimes = pipelineMetrics.workers.map(w => w.avgTimeMs).filter(t => t > 0);
        if (avgTimes.length > 0) {
          pipelineMetrics.avgProcessingTimeMs = Math.round(avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length * 10) / 10;
        }
      }

      // Alertas de GPS Pipeline
      if (pipelineMetrics.totalKalmanFilters > 5000) {
        alerts.push({
          type: 'warning',
          component: 'GPS Pipeline',
          message: `Muitos filtros Kalman ativos (${pipelineMetrics.totalKalmanFilters})`,
          action: 'Pode causar lentidão - aguardar cleanup automático'
        });
        pipelineMetrics.alerts.push('kalman_high');
      }
      if (pipelineMetrics.totalPendingPoints > 1000) {
        alerts.push({
          type: 'warning',
          component: 'GPS Pipeline',
          message: `Muitos pontos pendentes MapMatch (${pipelineMetrics.totalPendingPoints})`,
          action: 'Verificar OSRM ou aguardar cleanup'
        });
        pipelineMetrics.alerts.push('pending_high');
      }

      await redisPipeline.quit();
    } catch (e) {
      console.warn('[PipelineDebug] Erro ao ler métricas GPS Pipeline:', e.message);
    }

    // Montar resposta
    const response = {
      gateway: {
        status: connections > 0 ? 'ok' : 'warning',
        value: `${connections} conn`,
        detail: connections > 0 ? 'Rastreadores conectados' : 'Sem conexões ativas'
      },
      redis: {
        status: totalLag < 100 ? 'ok' : totalLag < 1000 ? 'warning' : 'error',
        value: `${totalLag} msgs`,
        queues,
        maxlen: MAXLEN,
        detail: totalLag === 0 ? 'Filas vazias (OK)' :
                totalLag < 100 ? 'Processamento normal' :
                totalLag < 1000 ? 'Acumulando - verificar' : 'CRÍTICO - filas cheias!'
      },
      processors: {
        status: consumers >= 4 ? 'ok' : consumers > 0 ? 'warning' : 'error',
        value: `${consumers}/4 ativos`,
        detail: consumers >= 4 ? 'Todos os processors rodando' :
                consumers > 0 ? `${4 - consumers} processors parados` : 'Nenhum processor ativo!'
      },
      database: {
        status: insertsPerMin > 0 ? 'ok' : 'warning',
        value: `${insertsPerMin}/min`,
        detail: `${inserts5Min} inserções nos últimos 5 min`
      },
      api: {
        status: 'ok',
        value: 'Online',
        detail: 'API respondendo normalmente'
      },
      frontend: {
        status: 'ok',
        value: 'WebSocket',
        detail: 'Conexão em tempo real ativa'
      },
      latency: {
        ...latencyData,
        detail: latencyData.avg <= 5 ? 'Tempo real' :
                latencyData.avg <= 30 ? 'Leve atraso' :
                latencyData.avg <= 60 ? 'Atraso moderado' :
                `Atraso crítico (${Math.round(latencyData.avg / 60)} min)`
      },
      throughput: {
        connections,
        packetsPerMin: totalLag > 0 ? Math.round(totalLag / 5) : insertsPerMin,
        insertsPerMin,
        inserts5Min,
        consumers,
        totalLag
      },
      // ✅ NOVO: Métricas do GPS Pipeline
      gpsPipeline: pipelineMetrics,
      // ✅ NOVO: Estatísticas por tipo de dispositivo
      deviceTypeStats,
      // ✅ NOVO: Estatísticas detalhadas por partição
      partitionStats,
      alerts,
      recentData,
      timestamp: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Erro em pipeline-debug:', error);
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao obter debug do pipeline',
      erro: error.message
    });
  }
});

// ============ ENDPOINTS DE LOGS ============

// GET /api/logs - Buscar logs (admin)
router.get('/logs', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nivel, categoria, limit = 100, offset = 0 } = req.query;

    const logs = await logger.search({
      nivel,
      categoria,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      sucesso: true,
      total: logs.length,
      dados: logs,
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao buscar logs',
      erro: error.message,
    });
  }
});

// GET /api/logs/stats - Estatisticas de logs (admin)
router.get('/logs/stats', autenticar, apenasAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const counts = await logger.countByLevel(hours);

    res.json({
      sucesso: true,
      periodo: `${hours} horas`,
      dados: counts,
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao obter estatisticas de logs',
      erro: error.message,
    });
  }
});

// GET /api/logs/files - Listar arquivos de log (admin)
router.get('/logs/files', autenticar, apenasAdmin, (req, res) => {
  try {
    const files = logger.listLogFiles();

    res.json({
      sucesso: true,
      total: files.length,
      dados: files.map(f => ({
        nome: f.name,
        tamanho: f.size,
        modificado: f.modified,
      })),
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao listar arquivos de log',
      erro: error.message,
    });
  }
});

// GET /api/logs/files/:filename - Ler arquivo de log (admin)
router.get('/logs/files/:filename', autenticar, apenasAdmin, (req, res) => {
  try {
    const { filename } = req.params;
    const lines = parseInt(req.query.lines) || 100;

    const content = logger.readLogFile(filename, lines);

    if (!content) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Arquivo não encontrado',
      });
    }

    res.json({
      sucesso: true,
      arquivo: filename,
      linhas: content.length,
      dados: content,
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao ler arquivo de log',
      erro: error.message,
    });
  }
});

// ============ ROTAS DE FILAS (Queue Management) ============
const queueRoutes = require('./queue.routes');
router.use('/queues', queueRoutes);

// ============ ROTAS DE MÉTRICAS PROMETHEUS ============
const metricsRoutes = require('./metrics.routes');
router.use('/metrics', metricsRoutes); // Público para Prometheus scraper

// ============ ROTAS DE JOBS (Execução Manual) ============
const scheduler = require('../jobs/scheduler');
const multasJob = require('../jobs/multas.job');

// Listar jobs disponíveis
router.get('/jobs', autenticar, apenasAdmin, (req, res) => {
  res.json({
    sucesso: true,
    jobs: scheduler.listJobs()
  });
});

// Executar job manualmente
router.post('/jobs/:jobName/run', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { jobName } = req.params;
    console.log(`[Jobs] Execução manual solicitada: ${jobName} por ${req.usuario?.email}`);

    const resultado = await scheduler.runNow(jobName);

    res.json({
      sucesso: true,
      job: jobName,
      resultado
    });
  } catch (error) {
    console.error('[Jobs] Erro na execução manual:', error);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// Estatísticas rápidas de multas (para dashboard de jobs)
router.get('/jobs/multas/stats', autenticar, apenasAdmin, async (req, res) => {
  try {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    const em7dias = new Date();
    em7dias.setDate(em7dias.getDate() + 7);

    const prisma = require('../db/prisma');

    const [vencidas, vencendo, nicPendente] = await Promise.all([
      prisma.multa.count({ where: { status: 'vencida' } }),
      prisma.multa.count({
        where: {
          status: 'pendente',
          data_vencimento: { gte: hoje, lte: em7dias }
        }
      }),
      prisma.multa.count({
        where: {
          nic_enviado: false,
          nic_data_limite: { gte: hoje }
        }
      })
    ]);

    res.json({
      sucesso: true,
      stats: { vencidas, vencendo, nicPendente }
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
