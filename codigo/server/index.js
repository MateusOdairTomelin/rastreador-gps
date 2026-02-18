require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const express = require('express');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');

// ============ CONFIGURAÇÃO MULTI-INSTÂNCIA ============
const INSTANCE_ID = process.env.INSTANCE_ID || process.env.NODE_APP_INSTANCE || 0;
const IS_MASTER = process.env.IS_MASTER === 'true' || INSTANCE_ID === 0 || INSTANCE_ID === '0';
const ENABLE_TCP = process.env.ENABLE_TCP !== 'false' && IS_MASTER; // TCP apenas no master
const ENABLE_METRICS = process.env.ENABLE_METRICS !== 'false' && IS_MASTER; // Métricas apenas no master

console.log(`\n🔧 [Instance Config] ID: ${INSTANCE_ID} | Master: ${IS_MASTER} | TCP: ${ENABLE_TCP} | Metrics: ${ENABLE_METRICS}`);

// Database and services imports
const prisma = require('./db/prisma');
const apiRoutes = require('./routes');
const gpsParser = require('./parsers/gps-parser');
const dispositivoService = require('./services/dispositivo.service');
const localizacaoService = require('./services/localizacao.service');
const obd2Service = require('./services/obd2.service');
const alarmeService = require('./services/alarme.service');
const heartbeatService = require('./services/heartbeat.service');
const comandoService = require('./services/comando.service'); // ✅ Serviço de envio de comandos via 0x80
const viagemService = require('./services/viagem.service'); // ✅ Serviço de viagens para dispositivos sem OBD2
const geofencingService = require('./services/geofencing.service'); // ✅ Serviço de geofencing (cercas virtuais)
const TCPPacketBuffer = require('./tcp-packet-buffer'); // ✅ CORREÇÃO #3
const { pipeline: gpsPipeline } = require('./services/gps-pipeline.service'); // ✅ Pipeline de correção GPS (Kalman → IA → Map-Match)
const systemMonitorService = require('./services/system-monitor.service'); // ✅ Monitoramento do sistema
const metricsPersistence = require('./services/metrics-persistence.service'); // ✅ Persistência de métricas
const logger = require('./services/logger.service'); // ✅ Sistema de logs
const helmet = require('helmet'); // ✅ Headers de segurança
const { dynamicRateLimiter, loginLimiter, apiGeralLimiter } = require('./middleware/rate-limit.middleware'); // ✅ Rate limiting com Redis
const redisService = require('./services/redis.service'); // ✅ Redis para cache e escalabilidade
const queueService = require('./services/queue.service'); // ✅ Filas assíncronas com Bull
const { registerAllProcessors } = require('./services/queue-processors.service'); // ✅ Processadores de filas
const { csrfProtection, attachCSRFToken, initRedis: initCsrfRedis, getAllowedOrigins, isOriginAllowed } = require('./middleware/csrf.middleware'); // ✅ Proteção CSRF
const jwt = require('jsonwebtoken'); // ✅ Para autenticação WebSocket
const tcpSecurity = require('./middleware/tcp-security.middleware'); // ✅ Segurança TCP (validação IMEI, rate limit)
const cacheStatsService = require('./services/cache-stats.service'); // ✅ Estatísticas e limpeza de caches em memória
const scheduler = require('./jobs/scheduler'); // ✅ Agendador de jobs (multas, etc)

const app = express();

// ============ INICIALIZAÇÃO REDIS E FILAS ============
// Redis e Filas são inicializados de forma assíncrona
(async () => {
  // 1. Conectar Redis
  const redisConnected = await redisService.connect().catch(err => {
    console.error('[Redis] ❌ Erro na conexão:', err.message);
    return false;
  });

  if (redisConnected) {
    console.log('[Redis] ✅ Conectado e pronto para uso');

    // 2. Inicializar CSRF com Redis (tokens distribuídos entre instâncias)
    const redisClient = redisService.getClient();
    if (redisClient) {
      initCsrfRedis(redisClient);
    }

    // 3. Inicializar filas (depende do Redis)
    const queuesInitialized = await queueService.init();

    if (queuesInitialized && IS_MASTER) {
      // 4. Registrar processadores apenas no master
      registerAllProcessors(queueService);
    }
  } else {
    console.log('[Redis] ⚠️  Não disponível - sistema funcionará sem cache e filas');
  }
})();

const server = http.createServer(app);

// ============ SEGURANÇA ============

// Desabilitar header X-Powered-By
app.disable('x-powered-by');

// Helmet - Headers de segurança HTTP
// NOTA: Em produção com HTTPS, habilitar hsts e upgradeInsecureRequests
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false, // Não usar defaults do Helmet
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://*.tile.openstreetmap.org"],
      scriptSrcAttr: ["'unsafe-inline'"], // Permite onclick, onload, etc.
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https:", "http:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net", "data:"],
      connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
      mediaSrc: ["'self'", "data:", "blob:"], // Permite áudio de notificação
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
      // NÃO incluir upgradeInsecureRequests para permitir HTTP
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  hsts: false, // Desabilita HSTS para HTTP
  xPoweredBy: false
}));

// Rate Limiting - Proteção contra brute force e abuso de API
// Usa Redis em ambiente distribuído (múltiplas instâncias)
// Limites específicos por tipo de endpoint: login, registro, LGPD, comandos, etc.
app.use('/api', dynamicRateLimiter);

console.log('[RateLimit] ✅ Rate limiting ativado com limites diferenciados por endpoint');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// ============ CORS SEGURO ============
// Lista de origens permitidas - usa a lista centralizada do csrf.middleware.js
const ALLOWED_ORIGINS = getAllowedOrigins();

// ✅ SEGURANÇA: IPs internos permitidos para requests sem origin (health checks, scripts internos)
const INTERNAL_IPS = ['127.0.0.1', '::1', '172.', '192.168.', '10.'];
const isInternalRequest = (ip) => {
  if (!ip) return false;
  const cleanIp = ip.replace('::ffff:', '');
  return INTERNAL_IPS.some(prefix => cleanIp.startsWith(prefix));
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const clientIp = req.ip || req.connection?.remoteAddress || '';

  // ✅ SEGURANÇA: Requisições sem origin só permitidas de IPs internos ou rotas de status
  if (!origin) {
    const isStatusRoute = req.path === '/api/status' || req.path === '/health' || req.path.startsWith('/api/infraestrutura');
    if (isInternalRequest(clientIp) || isStatusRoute) {
      // Requisição interna ou health check - permitir sem CORS
      // Não enviar Access-Control-Allow-Origin para requisições internas
    } else {
      // Requisição externa sem origin - permitir apenas GET para compatibilidade
      if (req.method === 'GET') {
        // GET sem origin - pode ser curl, script, etc. Permitir sem CORS header
      } else {
        // POST/PUT/DELETE sem origin de IP externo - bloquear
        return res.status(403).json({ error: 'Origin header obrigatório', code: 'CORS_MISSING_ORIGIN' });
      }
    }
  } else if (isOriginAllowed(origin, host)) {
    // ✅ Origem permitida (lista explícita ou mesma origem)
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else {
    // ❌ Origem não permitida - logar e bloquear
    console.warn(`[CORS] ❌ Origem bloqueada: ${origin} (IP: ${clientIp})`);
    return res.status(403).json({ error: 'Origem não permitida', code: 'CORS_BLOCKED' });
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Tenant-Id');
  res.header('Access-Control-Expose-Headers', 'X-CSRF-Token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============ REDIRECT OLD PAGES ============

// Redirecionar páginas antigas para o novo dashboard unificado
app.get('/dashboard.html', (req, res) => res.redirect(301, '/admin-dashboard.html'));
app.get('/mapa.html', (req, res) => res.redirect(301, '/admin-dashboard.html'));
app.get('/diagnostico.html', (req, res) => res.redirect(301, '/admin-dashboard.html'));
app.get('/heartbeat.html', (req, res) => res.redirect(301, '/admin-dashboard.html'));

console.log('[Redirects] Páginas antigas redirecionadas para /admin-dashboard.html');

// ============ PROTEÇÃO CSRF ============
// Anexar token CSRF em respostas de login
app.use('/api/auth/login', attachCSRFToken);

// Proteção CSRF para rotas que modificam dados
// Frontend envia X-CSRF-Token em requisições POST/PUT/DELETE/PATCH
app.use('/api', csrfProtection);

// ============ MOUNT API ROUTES ============

app.use('/api', apiRoutes);

// ============ GLOBAL ERROR HANDLER ============

app.use((err, req, res, next) => {
  console.error('[Error]', err.stack);

  // Prisma errors
  if (err.code === 'P2002') {
    return res.status(409).json({
      sucesso: false,
      mensagem: 'Registro duplicado',
      erro: 'DUPLICATE_ENTRY',
    });
  }

  if (err.code === 'P2025') {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Registro não encontrado',
      erro: 'NOT_FOUND',
    });
  }

  // Generic error
  res.status(500).json({
    sucesso: false,
    mensagem: 'Erro interno do servidor',
    erro: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============ WEBSOCKET PARA TEMPO REAL (COM AUTENTICAÇÃO) ============

const wss = new WebSocket.Server({
  server,
  path: '/ws',
  // ✅ Configurações para estabilidade de conexão
  perMessageDeflate: false, // Desabilitar compressão (economiza CPU)
  maxPayload: 1024 * 1024   // 1MB max (suficiente para métricas)
});

// ✅ Heartbeat para detectar conexões mortas (a cada 30s)
const WS_HEARTBEAT_INTERVAL = 30000;
const WS_HEARTBEAT_TIMEOUT = 35000; // 5s de tolerância

// Mapa de clientes autenticados para broadcasts filtrados por organização
const authenticatedClients = new Map(); // ws -> { userId, organizacaoId, role, isAlive, lastPing }

// ✅ Heartbeat DESABILITADO - causava problemas de CPU
// O cliente já envia ping a cada 30s via mensagem JSON

// ✅ Função para validar token JWT no WebSocket
function validateWebSocketToken(token) {
  if (!token) return null;

  try {
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      logger.error('WebSocket', 'JWT_SECRET não configurado');
      return null;
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    return {
      userId: decoded.userId,
      organizacaoId: decoded.organizacao_id,
      role: decoded.role,
      email: decoded.email
    };
  } catch (error) {
    logger.warn('WebSocket', `Token inválido: ${error.message}`);
    return null;
  }
}

// ✅ Histórico de métricas agora é gerenciado pelo serviço de persistência
// que carrega do banco ao iniciar e mantém em cache

// ✅ Função para broadcast de métricas via WebSocket (apenas para clientes autenticados)
function broadcastSystemMetrics(metrics) {
  const message = JSON.stringify({
    tipo: 'system_metrics',
    dados: metrics,
    historico: metricsPersistence.getHistory(),
    timestamp: new Date().toISOString()
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
      client.send(message);
    }
  });
}

// ✅ Função para broadcast genérico (apenas para clientes autenticados)
function broadcastToClients(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && authenticatedClients.has(client)) {
      client.send(message);
    }
  });
}

// ✅ Função para broadcast para uma organização específica
function broadcastToOrganization(organizacaoId, data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = authenticatedClients.get(client);
      if (clientInfo && (clientInfo.organizacaoId === organizacaoId || clientInfo.role === 'super_admin')) {
        client.send(message);
      }
    }
  });
}

// ✅ NOVO: Subscribe no Redis Pub/Sub para receber atualizações de localização dos processors
async function setupLocationSubscription() {
  try {
    await redisService.subscribe('location:update', async (locationData) => {
      try {
        // locationData já vem parseado do redis.service.js
        const imei = locationData.imei;
        // Log removido - muito verboso (dezenas por segundo)

        // Buscar organizacao_id do dispositivo
        const dispositivo = await dispositivoService.getByImei(imei);
        if (!dispositivo) return;

        // Broadcast para clientes da mesma organização
        const updateMessage = JSON.stringify({
          tipo: 'location_update',
          imei,
          data: {
            latitude: locationData.latitude,
            longitude: locationData.longitude,
            velocidade: locationData.velocidade,
            direcao: locationData.direcao,
            estado_ignicao: locationData.estado_ignicao,
            ignicao: locationData.ignicao
          },
          timestamp: locationData.timestamp,
          status: 'online'
        });

        let clienteCount = 0;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            const clientInfo = authenticatedClients.get(client);
            if (clientInfo && (clientInfo.organizacaoId === dispositivo.organizacao_id || clientInfo.role === 'super_admin')) {
              client.send(updateMessage);
              clienteCount++;
            }
          }
        });
        // Log removido - muito verboso (dezenas por segundo)
      } catch (err) {
        logger.warn('Redis', `Erro ao processar location update: ${err.message}`);
      }
    });
    logger.info('Redis', '✅ Subscribed to location:update channel');
  } catch (error) {
    logger.warn('Redis', `Falha ao subscrever location:update: ${error.message}`);
  }
}

// Iniciar subscrição após Redis estar pronto
setTimeout(setupLocationSubscription, 5000);

// ✅ Timer para coletar e broadcast métricas a cada 5 segundos
let metricsInterval = null;
let metricsSaveCounter = 0;

async function startMetricsBroadcast() {
  if (metricsInterval) return;

  // Carregar histórico do banco de dados
  logger.info('System', 'Carregando histórico de métricas do banco de dados...');
  await metricsPersistence.loadHistory(60);
  logger.success('System', 'Histórico de métricas carregado');

  // OTIMIZADO: Intervalo de 15s (era 5s) - reduz CPU em ~66%
  logger.info('System', 'Iniciando broadcast de métricas a cada 15s');
  metricsInterval = setInterval(async () => {
    try {
      const metrics = await systemMonitorService.getAll();

      // Adicionar ao cache de histórico
      metricsPersistence.addToHistory(metrics);

      // Salvar no banco a cada 4 coletas (60 segundos)
      metricsSaveCounter++;
      if (metricsSaveCounter >= 4) {
        metricsSaveCounter = 0;
        await metricsPersistence.save(metrics);
      }

      // Broadcast via WebSocket
      broadcastSystemMetrics(metrics);
    } catch (error) {
      logger.error('System', 'Erro ao coletar métricas', { error: error.message });
    }
  }, 15000);

  // Coletar imediatamente na primeira vez
  try {
    const metrics = await systemMonitorService.getAll();
    metricsPersistence.addToHistory(metrics);
    await metricsPersistence.save(metrics); // Salvar primeira coleta
    broadcastSystemMetrics(metrics);
  } catch (error) {
    logger.error('System', 'Erro na coleta inicial de métricas', { error: error.message });
  }
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
  logger.info('WebSocket', `Nova conexão de ${clientIp}`);

  // ✅ SEGURANÇA: Validar Origin antes de aceitar conexão
  const origin = req.headers.origin;
  const host = req.headers.host;

  // Verificar se a origem é permitida (mesmo critério do CORS)
  if (origin && !isOriginAllowed(origin, host)) {
    logger.warn('WebSocket', `❌ Origin bloqueado: ${origin} (IP: ${clientIp})`);
    ws.send(JSON.stringify({
      tipo: 'erro',
      codigo: 'ORIGIN_BLOCKED',
      mensagem: 'Origem não autorizada',
      timestamp: new Date().toISOString()
    }));
    ws.close(4403, 'Origin não autorizado');
    return;
  }

  // ✅ AUTENTICAÇÃO: Extrair token da query string ou header
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token') ||
                req.headers['authorization']?.replace('Bearer ', '');

  // Validar token
  const userInfo = validateWebSocketToken(token);

  if (!userInfo) {
    // Conexão não autenticada - enviar erro e desconectar
    logger.warn('WebSocket', 'Conexão rejeitada: Token inválido ou ausente');
    ws.send(JSON.stringify({
      tipo: 'erro',
      codigo: 'AUTH_REQUIRED',
      mensagem: 'Autenticação obrigatória. Envie token via ?token=xxx ou header Authorization.',
      timestamp: new Date().toISOString()
    }));
    ws.close(4401, 'Autenticação obrigatória');
    return;
  }

  // ✅ Permitir múltiplas conexões por usuário (múltiplas abas)
  // Não fechar conexões antigas - deixar o sistema de heartbeat limpar conexões mortas
  const userConnectionCount = Array.from(authenticatedClients.values())
    .filter(c => c.userId === userInfo.userId).length;

  if (userConnectionCount > 0) {
    logger.debug('WebSocket', `${userInfo.email} tem ${userConnectionCount + 1} conexões ativas`);
  }

  // ✅ Registrar cliente autenticado com timestamp de conexão
  authenticatedClients.set(ws, { ...userInfo, isAlive: true, connectedAt: Date.now() });
  logger.info('WebSocket', `Cliente autenticado: ${userInfo.email} (org: ${userInfo.organizacaoId})`);

  // ✅ Handler para pong do heartbeat nativo
  ws.on('pong', () => {
    const clientInfo = authenticatedClients.get(ws);
    if (clientInfo) {
      clientInfo.isAlive = true;
    }
  });

  // Enviar confirmação de conexão
  ws.send(JSON.stringify({
    tipo: 'conexao',
    mensagem: 'Conectado ao WebSocket com sucesso',
    usuario: {
      id: userInfo.userId,
      email: userInfo.email,
      organizacaoId: userInfo.organizacaoId
    },
    timestamp: new Date().toISOString()
  }));

  // Enviar métricas atuais imediatamente ao conectar
  systemMonitorService.getAll().then(metrics => {
    ws.send(JSON.stringify({
      tipo: 'system_metrics',
      dados: metrics,
      historico: metricsPersistence.getHistory(),
      timestamp: new Date().toISOString()
    }));
  }).catch(err => logger.error('WebSocket', 'Erro ao enviar métricas', { error: err.message }));

  ws.on('message', (message) => {
    try {
      const dados = JSON.parse(message);

      // ✅ Comandos especiais do WebSocket
      if (dados.tipo === 'ping') {
        // Marcar conexão como viva (cliente enviou ping)
        const clientInfo = authenticatedClients.get(ws);
        if (clientInfo) clientInfo.isAlive = true;
        ws.send(JSON.stringify({ tipo: 'pong', timestamp: new Date().toISOString() }));
        return;
      }

      // ✅ Atualizar token (para refresh sem reconectar)
      if (dados.tipo === 'auth_refresh' && dados.token) {
        const newUserInfo = validateWebSocketToken(dados.token);
        if (newUserInfo) {
          authenticatedClients.set(ws, newUserInfo);
          ws.send(JSON.stringify({
            tipo: 'auth_refreshed',
            mensagem: 'Token atualizado',
            timestamp: new Date().toISOString()
          }));
        } else {
          ws.send(JSON.stringify({
            tipo: 'erro',
            codigo: 'INVALID_TOKEN',
            mensagem: 'Token inválido',
            timestamp: new Date().toISOString()
          }));
        }
        return;
      }

      // Log apenas do tipo de mensagem (sem dados sensíveis)
      console.log('[WS] Mensagem recebida de', userInfo.email, ':', { tipo: dados.tipo, canal: dados.canal });
    } catch (error) {
      console.error('[WS] Erro:', error.message);
    }
  });

  ws.on('close', () => {
    // ✅ Remover cliente do mapa de autenticados
    authenticatedClients.delete(ws);
    logger.info('WebSocket', `Cliente desconectado: ${userInfo.email}`);
  });

  ws.on('error', (error) => {
    logger.error('WebSocket', `Erro no cliente ${userInfo.email}`, { error: error.message });
    authenticatedClients.delete(ws);
  });
});

// ============ HELPER FUNCTIONS FOR TCP ============

// ✅ CORREÇÃO #7: Rate Limiting
// Mapa global para rastrear rate limits por client
const clientRateLimits = new Map();

function checkRateLimit(clientId, maxPacketsPerSecond = 100) {
  const now = Date.now();

  if (!clientRateLimits.has(clientId)) {
    clientRateLimits.set(clientId, {
      packets: 0,
      resetAt: now + 1000,
    });
    return true;
  }

  const limits = clientRateLimits.get(clientId);

  // Reset a cada segundo
  if (now > limits.resetAt) {
    limits.packets = 0;
    limits.resetAt = now + 1000;
  }

  limits.packets++;

  if (limits.packets > maxPacketsPerSecond) {
    return false;
  }

  return true;
}

// ✅ CORREÇÃO #1: Session IMEI Mapping
// Mapa global para rastrear IMEI por sessão TCP
const sessionImeiMap = new Map();

// ✅ Mapa global para armazenar sockets ativos por IMEI (para enviar comandos)
const activeConnections = new Map();

// ✅ NOVO: Cache de tensão por IMEI (para dispositivos que enviam 0x12 sem tensão)
// Armazena a última tensão recebida via pacote 0x13 (Status) para usar nos pacotes 0x12 (Location)
const tensaoCache = new Map();

// ========== DETECÇÃO DE GPS COM COORDENADAS DE FÁBRICA ==========
// Coordenadas de Shenzhen, China (onde os XT40 são fabricados)
// Quando o GPS não faz fix, o dispositivo pode enviar essas coordenadas default
const FACTORY_COORDINATES = {
  // Shenzhen, China - fábrica dos XT40
  shenzhen: { lat: 22.697629, lon: 113.782373, tolerance: 0.1 },
  // Outras coordenadas de fábrica conhecidas
  shenzhen2: { lat: 22.5431, lon: 114.0579, tolerance: 0.1 },
};

// Cache de dispositivos com GPS problemático (para não spammar comandos)
const gpsProblematico = new Map(); // imei -> { lastCommand: Date, attempts: number }

/**
 * ============ LIMPEZA DE MEMÓRIA ============
 * Remove entradas antigas dos Maps para evitar memory leaks
 * Esses são caches temporários - dados importantes já estão no banco
 *
 * TTLs definidos:
 * - clientRateLimits: 1 hora (dados de rate limiting são efêmeros)
 * - tensaoCache: 30 minutos (só precisa dos últimos minutos)
 * - gpsProblematico: 2 horas (permite novas tentativas após esse tempo)
 * - heartbeats: 24 horas (via heartbeatService.cleanupStaleEntries)
 */
function cleanupInMemoryMaps() {
  const now = Date.now();
  let stats = { clientRateLimits: 0, tensaoCache: 0, gpsProblematico: 0 };

  // 1. clientRateLimits - limpar entradas inativas há mais de 1 hora
  const rateLimitMaxAge = 60 * 60 * 1000; // 1 hora
  for (const [clientId, data] of clientRateLimits) {
    if (now - data.resetAt > rateLimitMaxAge) {
      clientRateLimits.delete(clientId);
      stats.clientRateLimits++;
    }
  }

  // 2. tensaoCache - limpar entradas com mais de 30 minutos
  const tensaoMaxAge = 30 * 60 * 1000; // 30 minutos
  for (const [imei, data] of tensaoCache) {
    if (data.timestamp && (now - data.timestamp) > tensaoMaxAge) {
      tensaoCache.delete(imei);
      stats.tensaoCache++;
    }
  }

  // 3. gpsProblematico - limpar entradas com mais de 2 horas
  const gpsMaxAge = 2 * 60 * 60 * 1000; // 2 horas
  for (const [imei, data] of gpsProblematico) {
    if (data.lastCommand && (now - data.lastCommand) > gpsMaxAge) {
      gpsProblematico.delete(imei);
      stats.gpsProblematico++;
    }
  }

  return stats;
}

/**
 * Retorna estatísticas de uso dos Maps em memória (para monitoramento)
 */
function getMapStats() {
  return {
    clientRateLimits: clientRateLimits.size,
    tensaoCache: tensaoCache.size,
    gpsProblematico: gpsProblematico.size,
    sessionImeiMap: sessionImeiMap.size,
    activeConnections: activeConnections.size,
    heartbeats: 0 // Será atualizado async se necessário
  };
}

// Versão async de getMapStats para quando precisar do tamanho real do Redis
async function getMapStatsAsync() {
  const stats = getMapStats();
  stats.heartbeats = await heartbeatService.getCacheSize();
  return stats;
}

// ✅ Registrar Maps no serviço de estatísticas (para monitoramento via API)
cacheStatsService.registerMap('clientRateLimits', clientRateLimits, {
  description: 'Rate limiting por cliente TCP',
  maxAgeMs: 60 * 60 * 1000, // 1 hora
  getTimestamp: (data) => data.resetAt
});
cacheStatsService.registerMap('tensaoCache', tensaoCache, {
  description: 'Cache de tensão da bateria por IMEI',
  maxAgeMs: 30 * 60 * 1000, // 30 minutos
  getTimestamp: (data) => data.timestamp
});
cacheStatsService.registerMap('gpsProblematico', gpsProblematico, {
  description: 'Dispositivos com GPS problemático',
  maxAgeMs: 2 * 60 * 60 * 1000, // 2 horas
  getTimestamp: (data) => data.lastCommand
});
cacheStatsService.registerMap('sessionImeiMap', sessionImeiMap, {
  description: 'Mapeamento de sessão TCP para IMEI'
  // Sem cleanup automático - limpo quando conexão fecha
});
cacheStatsService.registerMap('activeConnections', activeConnections, {
  description: 'Conexões TCP ativas por IMEI'
  // Sem cleanup automático - limpo quando conexão fecha
});

/**
 * Verifica se as coordenadas são de fábrica (GPS sem fix real)
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {boolean} true se são coordenadas de fábrica
 */
function isFactoryCoordinates(lat, lon) {
  if (lat === null || lon === null || lat === undefined || lon === undefined) {
    return false;
  }

  for (const [name, coords] of Object.entries(FACTORY_COORDINATES)) {
    const latDiff = Math.abs(lat - coords.lat);
    const lonDiff = Math.abs(lon - coords.lon);

    if (latDiff <= coords.tolerance && lonDiff <= coords.tolerance) {
      console.log(`🏭 [GPS Factory] Coordenadas de fábrica detectadas (${name}): ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      return true;
    }
  }
  return false;
}

/**
 * Tenta reiniciar o GPS de um dispositivo com problema
 * Envia comandos de reinício se não enviou recentemente
 * @param {string} imei - IMEI do dispositivo
 */
async function tentarReiniciarGPS(imei) {
  const agora = Date.now();
  const info = gpsProblematico.get(imei) || { lastCommand: 0, attempts: 0 };

  // Não enviar comandos mais de uma vez a cada 5 minutos
  const INTERVALO_MIN = 5 * 60 * 1000;
  if (agora - info.lastCommand < INTERVALO_MIN) {
    return;
  }

  // Máximo de 3 tentativas antes de desistir por hora
  if (info.attempts >= 3) {
    const ultimaTentativa = info.lastCommand || 0;
    if (agora - ultimaTentativa < 60 * 60 * 1000) { // 1 hora
      return;
    }
    info.attempts = 0; // Reset após 1 hora
  }

  console.log(`🔄 [GPS Restart] Tentando reiniciar GPS do dispositivo ${imei} (tentativa ${info.attempts + 1})`);

  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    console.log(`[GPS Restart] Dispositivo ${imei} não está conectado`);
    return;
  }

  // Enviar comandos de reinício do GPS
  const comandos = [
    X3TECH_COMMANDS.SLEEP_OFF,   // Desabilitar sleep
    X3TECH_COMMANDS.GPS_ON,      // Ativar GPS
    X3TECH_COMMANDS.GNSS_ON,     // Ativar GNSS (GPS + GLONASS)
    X3TECH_COMMANDS.UPLOAD_30S,  // Configurar intervalo
  ];

  for (const cmd of comandos) {
    try {
      await comandoService.sendCommand(imei, cmd);
      await new Promise(resolve => setTimeout(resolve, 500)); // Aguardar entre comandos
    } catch (e) {
      console.warn(`[GPS Restart] Erro ao enviar comando para ${imei}: ${e.message}`);
    }
  }

  info.lastCommand = agora;
  info.attempts++;
  gpsProblematico.set(imei, info);

  console.log(`✅ [GPS Restart] Comandos de reinício enviados para ${imei}`);
}

// ============ COMANDOS X3TECH XT40 ============
// Injetar referências nas rotas da API (depois de definir as variáveis)
// Comandos SMS que podem ser enviados via TCP
const X3TECH_COMMANDS = {
  // ✅ CORREÇÃO: Desabilitar sleep mode (importante antes de ativar GPS/OBD2)
  SLEEP_OFF: '#55555#YSLPOFF#',

  // ✅ CORREÇÃO: GNSS (satélites GPS/GLONASS)
  GNSS_ON: '#55555#YGNSS#1#',

  // Ativar GPS
  GPS_ON: '#55555#YGPS#1#',
  GPS_OFF: '#55555#YGPS#0#',

  // ✅ CORREÇÃO: OBD2 deve usar YDIY#0,1# (não YOBD)
  OBD_ON: '#55555#YDIY#0,1#',
  OBD_OFF: '#55555#YDIY#0,0#',

  // Intervalo de upload (segundos)
  UPLOAD_10S: '#55555#YUP#10#',
  UPLOAD_30S: '#55555#YUP#30#',
  UPLOAD_60S: '#55555#YUP#60#',

  // Diagnóstico
  DIAG_ON: '#55555#YDIAG#1#',
  DIAG_OFF: '#55555#YDIAG#0#',

  // Modo online
  ONLINE_ON: '#55555#YONLINE#1#',
  CONNECT_ON: '#55555#YCONNECT#1#',

  // Status e versão
  STATUS: '#55555#SHOWINFO#',
  VERSION: '#55555#YVERSION#',
  NETWORK: '#55555#YNETWORK#',

  // Display/Test
  DISP_ON: '#55555#YDISP#1#',
  TEST_ON: '#55555#YTEST#1#',

  // Corte de Combustível (Seção 6.3.1 e 6.3.2 do protocolo XT40)
  // Usado principalmente no modelo XT40-4F (cabo) com relé de corte
  // ATENÇÃO: Não pode cortar se GPS off ou velocidade > 20 km/h
  RELAY_CUT: 'DYD,000000#',      // Cortar combustível (Cut Oil and Electricity)
  RELAY_RESTORE: 'HFYD,000000#', // Restaurar combustível (Connect Oil and Electricity)
};

// Função para enviar comando SMS via TCP para o rastreador
function sendCommandToDevice(imei, command) {
  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    console.log(`[CMD] Dispositivo ${imei} não está conectado`);
    return { success: false, error: 'Dispositivo não conectado' };
  }

  try {
    // Comandos X3Tech são enviados como texto simples
    const cmdBuffer = Buffer.from(command + '\r\n', 'ascii');
    socket.write(cmdBuffer);
    console.log(`📤 [CMD] Enviado para ${imei}: ${command}`);
    return { success: true, command };
  } catch (error) {
    console.error(`[CMD] Erro ao enviar comando: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Função para enviar comandos de inicialização ao rastreador
async function sendInitCommands(imei, socket) {
  console.log(`🔧 [Config] Enviando comandos de inicialização via Protocolo 0x80 para ${imei}...`);

  try {
    // Usa o comandoService que implementa protocolo 0x80 corretamente
    const results = await comandoService.setupNewDevice(imei);

    console.log(`✅ [Config] Comandos de inicialização enviados para ${imei}`);
    results.forEach((result, index) => {
      const status = result.success ? '✅' : '❌';
      console.log(`  ${status} [${index+1}/${results.length}] ${result.comando}: ${result.response || result.message}`);
    });

    return results;
  } catch (error) {
    console.error(`❌ [Config] Erro ao enviar comandos de inicialização: ${error.message}`);
    return [];
  }
}

// Injetar referências de conexões ativas nas rotas da API
apiRoutes.setConnections(activeConnections, X3TECH_COMMANDS);

// Gera chave única para cada sessão TCP
function getSessionKey(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}

// Extract IMEI from packet (adjust based on actual protocol)
function extractIMEI(buffer) {
  try {
    const protocolNumber = buffer.readUInt8(3);
    // Example: IMEI typically in login packet or included in each packet
    // This is a simplified implementation - adjust per actual X3Tech XT40 protocol
    if (protocolNumber === 0x01) { // Login packet
      // Extract IMEI (usually 8 bytes BCD encoded)
      return buffer.slice(4, 12).toString('hex');
    }
    // ✅ CORREÇÃO #1: Para outros pacotes, retorna null (será usado IMEI da sessão)
    return null; // Não usar fallback fake!
  } catch (error) {
    console.error('[IMEI] Extraction error:', error.message);
    return null;
  }
}

/**
 * Detecta o estado da ignição baseado em ACC e RPM
 * @param {boolean} acc - Status do ACC (acessórios)
 * @param {number|null} rpm - Rotação do motor
 * @returns {string} Estado: "off", "acc_on", ou "ligado"
 */
// ========== IMEI COM CONFIGURAÇÃO ESPECIAL DE VELOCIDADE ==========
// Dispositivos que precisam de threshold de velocidade mais baixo para detectar movimento
const IMEI_VELOCIDADE_ESPECIAL = {
  '356354870658615': { threshold: 0, descricao: 'Discovery - threshold zero para movimento' }
};

/**
 * Detecta estado da ignição baseado em ACC, RPM, velocidade e tensão
 * @param {boolean} acc - ACC status (bit do terminal info)
 * @param {number|null} rpm - RPM do motor
 * @param {number|null} velocidade - Velocidade em km/h
 * @param {object|null} configIgnicaoVirtual - Configuração de ignição virtual {usa: boolean, tensao: number, limiteOn: number, limiteOff: number}
 * @param {string|null} tipoDispositivo - Tipo do dispositivo
 * @param {string|null} imei - IMEI do dispositivo (para configurações especiais)
 * @param {boolean} conexaoPosChave - Se dispositivo está conectado no pós-chave
 * @returns {'off'|'acc_on'|'idle'|'moving'} Estado da ignição
 */
function detectarEstadoIgnicao(acc, rpm, velocidade = null, configIgnicaoVirtual = null, tipoDispositivo = null, imei = null, conexaoPosChave = false, tensaoPrincipal = null) {
  // ========== PRIORIDADE 1: IGNIÇÃO VIRTUAL POR TENSÃO ==========
  // Para dispositivos que usam ignição virtual (OBD2), a TENSÃO tem prioridade sobre ACC
  // porque o ACC pode não ser confiável nesses dispositivos
  if (configIgnicaoVirtual && configIgnicaoVirtual.usa) {
    const tensao = configIgnicaoVirtual.tensao;
    const limiteOn = configIgnicaoVirtual.limiteOn || 13.5;
    const limiteOff = configIgnicaoVirtual.limiteOff || 13.0;
    const configEspecial = imei ? IMEI_VELOCIDADE_ESPECIAL[imei] : null;
    const thresholdVelocidade = configEspecial ? configEspecial.threshold : 5;

    if (tensao !== null && tensao !== undefined && tensao > 0) {
      if (tensao >= limiteOn) {
        // Motor ligado - verificar velocidade para MOV vs IDLE
        if (velocidade !== null && velocidade !== undefined && velocidade > thresholdVelocidade) {
          console.log(`🔌 [Ignição Virtual] ${imei}: Tensão ${tensao.toFixed(2)}V >= ${limiteOn}V + Vel ${velocidade} > ${thresholdVelocidade} → MOVING`);
          return 'moving';
        }
        console.log(`🔌 [Ignição Virtual] ${imei}: Tensão ${tensao.toFixed(2)}V >= ${limiteOn}V → IDLE (motor ligado)`);
        return 'idle';
      } else if (tensao < limiteOff) {
        console.log(`🔌 [Ignição Virtual] ${imei}: Tensão ${tensao.toFixed(2)}V < ${limiteOff}V → OFF (motor desligado)`);
        return 'off';
      } else {
        // Zona de histerese - assumir OFF por segurança
        console.log(`🔌 [Ignição Virtual] ${imei}: Tensão ${tensao.toFixed(2)}V em zona cinza → OFF (assumindo desligado)`);
        return 'off';
      }
    }
  }

  // ========== PRIORIDADE 2: DETECÇÃO HÍBRIDA PÓS-CHAVE + TENSÃO ==========
  // Para dispositivos conectados no pós-chave, a TENSÃO tem prioridade ABSOLUTA sobre ACC
  // porque nesses dispositivos o ACC pode ser sempre false (não confiável)
  // Detecção BINÁRIA por tensão:
  // - >= 13.2V = motor ligado (alternador ativo)
  // - < 13.2V = motor desligado (bateria em repouso ~12.6-12.9V)
  if (conexaoPosChave) {
    const configEspecial = imei ? IMEI_VELOCIDADE_ESPECIAL[imei] : null;
    const thresholdVelocidade = configEspecial ? configEspecial.threshold : 5;
    const thresholdTensaoMotor = 12.8;  // Motor ligado (alternador) - ajustado para XT40

    // Verificar tensão PRIMEIRO - ignora completamente o ACC
    const tensaoValida = tensaoPrincipal !== null && tensaoPrincipal !== undefined && tensaoPrincipal > 0;

    if (tensaoValida) {
      if (tensaoPrincipal >= thresholdTensaoMotor) {
        // Tensão alta = alternador funcionando = motor ligado (IGNORA ACC!)
        if (velocidade !== null && velocidade !== undefined && velocidade > thresholdVelocidade) {
          console.log(`🔑 [Híbrido] ${imei}: Tensão ${tensaoPrincipal.toFixed(2)}V >= ${thresholdTensaoMotor}V + Vel ${velocidade} km/h → MOVING (ACC ignorado)`);
          return 'moving';
        }
        console.log(`🔑 [Híbrido] ${imei}: Tensão ${tensaoPrincipal.toFixed(2)}V >= ${thresholdTensaoMotor}V → IDLE (motor ligado, ACC ignorado)`);
        return 'idle';
      } else {
        // Tensão baixa = motor desligado
        console.log(`🔑 [Híbrido] ${imei}: Tensão ${tensaoPrincipal.toFixed(2)}V < ${thresholdTensaoMotor}V → OFF`);
        return 'off';
      }
    }

    // Se não tem tensão mas tem velocidade alta, provavelmente motor ligado
    if (velocidade !== null && velocidade > 10) {
      console.log(`🔑 [Híbrido] ${imei}: Tensão N/A mas Vel ${velocidade} km/h → MOVING (fallback velocidade)`);
      return 'moving';
    }

    // Sem tensão e sem velocidade significativa = assumir desligado
    console.log(`🔑 [Híbrido] ${imei}: Tensão N/A, Vel ${velocidade || 0} km/h → OFF`);
    return 'off';
  }

  // ========== PRIORIDADE 3: ACC OFF = MOTOR DESLIGADO ==========
  // Para dispositivos SEM pós-chave e SEM ignição virtual, usar ACC do pacote
  if (acc === false) {
    console.log(`🔑 [Ignição] ACC=OFF → Motor DESLIGADO (ignorando velocidade ${velocidade || 0} km/h)`);
    return 'off';
  }

  // ========== DETECÇÃO COM ACC LIGADO ==========
  // Se chegou aqui, ACC não é false (pode ser true ou undefined)
  // Se ACC é true, verificar velocidade para MOV vs IDLE

  // Verificar se IMEI tem configuração especial de threshold
  const configEspecial = imei ? IMEI_VELOCIDADE_ESPECIAL[imei] : null;
  const thresholdVelocidade = configEspecial ? configEspecial.threshold : 5;  // Aumentado para 5 km/h

  // Se ACC é explicitamente true, usar velocidade para determinar MOV vs IDLE
  if (acc === true) {
    if (velocidade !== null && velocidade !== undefined && velocidade > thresholdVelocidade) {
      console.log(`🚗 [Ignição] ACC=ON + Vel ${velocidade} km/h > ${thresholdVelocidade} → MOVING${configEspecial ? ` [${configEspecial.descricao}]` : ''}`);
      return 'moving';
    }
    console.log(`🚗 [Ignição] ACC=ON + Vel ${velocidade || 0} km/h ≤ ${thresholdVelocidade} → IDLE`);
    return 'idle';
  }

  // ========== FALLBACK: DETECÇÃO POR RPM ==========
  const rpmThreshold = 500; // RPM mínimo para considerar motor ligado

  if (rpm === null || rpm === undefined || rpm < rpmThreshold) {
    // Meia chave: ACC ligado mas motor parado
    return 'acc_on';
  }

  // Motor ligado (RPM >= 500)
  // Verificar se está parado (idle) ou em movimento
  // ✅ Usando threshold consistente de 0.5 km/h
  if (velocidade !== null && velocidade !== undefined) {
    if (velocidade <= thresholdVelocidade) {
      // Motor ligado mas parado = OCIOSO (ar-condicionado ligado, etc)
      return 'idle';
    } else {
      // Motor ligado e em movimento
      return 'moving';
    }
  }

  // Se não tiver velocidade, assumir idle (motor ligado sem info de movimento)
  return 'idle';
}

// Handle location data
async function handleLocationData(imei, data) {
  try {
    // ✅ FILTRAGEM POR LOCATION SOURCE TYPE (protocolo 0x22)
    // 0x01 = Tracking (TIMER) - movimento real → SALVAR
    // 0x02 = Static - veículo parado → FILTRAR (não salvar como localização de movimento)
    // 0x03 = ALARM - evento → SALVAR
    const locationSourceType = data.location_source_type;
    const locationSourceName = data.location_source_name || 'Unknown';

    if (locationSourceType !== undefined) {
      console.log(`📍 [Location Source] ${imei}: ${locationSourceName} (0x${locationSourceType.toString(16).padStart(2, '0')})`);

      // ✅ FILTRAR pacotes Static (0x02) - não são dados de movimento real
      // Estes pacotes são enviados quando o veículo está parado
      // MAS ainda devemos detectar a ignição corretamente pela tensão
      if (locationSourceType === 0x02) {
        console.log(`⏸️  [Location] STATIC packet for ${imei} - vehicle stationary`);

        // Ainda atualizar heartbeat para mostrar que o dispositivo está online
        const hbInfo = await heartbeatService.register(imei);
        console.log(`💓 [Heartbeat] Updated on STATIC - #${hbInfo.count} from ${imei}`);

        // ✅ CORRIGIDO: Detectar ignição para pacotes Static
        // Veículo pode estar parado com motor ligado (idle)
        const dispositivo = await dispositivoService.getByImei(imei);
        let estadoIgnicaoStatic = 'off';

        // ✅ HÍBRIDO PÓS-CHAVE + TENSÃO: Detecção binária (ligado/desligado)
        // NOTA: Não usar ACC por tensão! Bateria em repouso fica em ~12.6-12.9V,
        // o que causava falsos positivos de "acc_on" quando o carro estava desligado.
        // Só o alternador (motor ligado) eleva a tensão acima de 13.2V.
        if (dispositivo && dispositivo.conexao_pos_chave) {
          const tensao = data.tensao_principal;
          const thresholdTensaoMotor = 13.2;  // Motor ligado (alternador ativo)

          if (tensao && tensao >= thresholdTensaoMotor) {
            estadoIgnicaoStatic = 'idle';  // Tensão alta = motor ligado
            console.log(`🔑 [Static/Híbrido] ${imei}: Tensão ${tensao.toFixed(2)}V >= ${thresholdTensaoMotor}V → IDLE (motor ligado)`);
          } else {
            estadoIgnicaoStatic = 'off';  // Tensão abaixo de 13.2V = motor desligado
            console.log(`🔑 [Static/Híbrido] ${imei}: Tensão ${tensao?.toFixed(2) || 'N/A'}V < ${thresholdTensaoMotor}V → OFF (desligado)`);
          }
        }
        // ✅ IGNIÇÃO VIRTUAL: Detectar por tensão
        else if (dispositivo && dispositivo.usa_ignicao_virtual && data.tensao_principal) {
          const tensao = data.tensao_principal;
          const limiteOn = dispositivo.tensao_motor_ligado || 13.8;
          const limiteOff = dispositivo.tensao_motor_deslig || 12.6;

          if (tensao >= limiteOn) {
            estadoIgnicaoStatic = 'idle';  // Motor ligado mas parado
            console.log(`🔌 [Static] Tensão ${tensao.toFixed(2)}V >= ${limiteOn}V → IDLE (motor ligado, parado)`);
          } else if (tensao >= limiteOff) {
            estadoIgnicaoStatic = 'idle';  // Zona de histerese, assumir ligado
            console.log(`🔌 [Static] Tensão ${tensao.toFixed(2)}V em zona de histerese → IDLE`);
          } else {
            estadoIgnicaoStatic = 'off';   // Motor realmente desligado
            console.log(`🔌 [Static] Tensão ${tensao.toFixed(2)}V < ${limiteOff}V → OFF`);
          }
        }

        // Atualizar status do dispositivo com ignição detectada
        await dispositivoService.upsert(imei, {
          status: 'online',
          estado_ignicao: estadoIgnicaoStatic
        });

        // ✅ CORRIGIDO: Salvar localização de pacote Static COM estado de ignição correto
        // Antes: não salvava pacotes Static (sempre aparecia MOV no histórico)
        // Agora: salva com estado_ignicao correto (idle, acc_on, off)
        const ignicaoDetectada = ['acc_on', 'idle', 'moving'].includes(estadoIgnicaoStatic);
        data.ignicao = ignicaoDetectada;
        data.estado_ignicao = estadoIgnicaoStatic;

        console.log(`📍 [Static] Salvando localização para ${imei} com estado: ${estadoIgnicaoStatic}`);
        await localizacaoService.create(imei, data);
        console.log(`✅ [Static] Localização salva para ${imei}: (${data.latitude}, ${data.longitude}) estado=${estadoIgnicaoStatic}`);

        // ✅ CORREÇÃO CRÍTICA: Processar viagem TAMBÉM para pacotes Static
        // Sem isso, a transição ON → OFF nunca é detectada quando o veículo para,
        // e a rota fica em aberto indefinidamente!
        const resultadoViagemStatic = await viagemService.processarLocalizacao(
          imei,
          data.ignicao,
          data.latitude,
          data.longitude,
          data.velocidade || 0,
          data.timestamp || new Date(),
          data.tensao_principal
        );

        if (resultadoViagemStatic) {
          console.log(`🚗 [Static/Viagem] ${imei}: ${resultadoViagemStatic.evento}`);
        }

        return; // Fim do processamento de pacote Static
      }
    }

    // ✅ PIPELINE DE CORREÇÃO GPS (Kalman → IA → Map-Matching)
    // Processar através do pipeline de 3 camadas antes de salvar
    try {
      const posicaoCorrigida = await gpsPipeline.processar({
        latitude: data.latitude,
        longitude: data.longitude,
        velocidade: data.velocidade || 0,
        direcao: data.direcao || 0,
        hdop: data.hdop || 2,
        timestamp: data.timestamp || new Date()
      }, imei);

      // Aplicar correção se válida
      if (posicaoCorrigida.lat && posicaoCorrigida.lon) {
        const correcaoMetros = posicaoCorrigida.correcao_total_metros || 0;

        // Log da correção aplicada
        if (correcaoMetros > 1) {
          console.log(`🎯 [GPS Pipeline] ${imei}: Correção de ${correcaoMetros.toFixed(1)}m aplicada (${posicaoCorrigida.pipeline?.join('→') || 'n/a'})`);
        }

        // Atualizar coordenadas com valores corrigidos
        data.latitude = posicaoCorrigida.lat;
        data.longitude = posicaoCorrigida.lon;

        // Preservar coordenadas originais para referência
        data.latitude_original = posicaoCorrigida.lat_original;
        data.longitude_original = posicaoCorrigida.lon_original;
        data.correcao_gps_metros = correcaoMetros;
        data.pipeline_aplicado = posicaoCorrigida.pipeline;
      }
    } catch (pipelineError) {
      console.warn(`[GPS Pipeline] Erro no pipeline para ${imei}: ${pipelineError.message}`);
      // Continuar com coordenadas originais se pipeline falhar
    }

    // ✅ VALIDAÇÃO: Avisar mas PROCESSAR coordenadas 0,0 (sem sinal de satélite)
    if (data.latitude === 0 && data.longitude === 0) {
      console.warn(`[Location] ⚠️ Processing 0,0 coordinates for ${imei} (no GPS lock yet - device indoors or no fix)`);
    }

    // ✅ NOVO: Detectar coordenadas de fábrica (Shenzhen, China)
    // Quando o GPS não faz fix, o rastreador pode enviar coordenadas da fábrica
    if (isFactoryCoordinates(data.latitude, data.longitude)) {
      console.error(`🏭 [GPS NO FIX] ${imei}: GPS enviando coordenadas de fábrica (Shenzhen) - dispositivo sem sinal GPS!`);

      // Tentar reiniciar o GPS do dispositivo
      tentarReiniciarGPS(imei);

      // Atualizar status do dispositivo como GPS problemático
      await dispositivoService.upsert(imei, {
        status: 'online',
        gps_status: 'NO_FIX_FACTORY',
        ultimo_erro_gps: new Date()
      });

      // Registrar heartbeat mas NÃO processar localização/viagem
      const hbInfo = await heartbeatService.register(imei);
      console.log(`💓 [Heartbeat] Updated on factory coords (GPS NO FIX) - #${hbInfo.count} from ${imei}`);

      // IMPORTANTE: Não processar viagem com coordenadas de fábrica
      // pois isso causa viagens de 1 minuto e velocidades impossíveis
      return;
    }

    // ✅ NOVO: Detectar coordenadas fora do Brasil ou no oceano
    // Latitude Brasil continental: -34 a 5, Longitude: -74 a -32
    // Tolerância maior para incluir áreas costeiras
    const foraDoBrasil = data.latitude < -34 || data.latitude > 6 ||
                         data.longitude < -74 || data.longitude > -32;

    // Detectar coordenadas no oceano (muito ao sul ou leste demais)
    // Ex: (-45, -54) está no Atlântico Sul
    const noOceano = (data.latitude < -40) || // Muito ao sul
                     (data.latitude < -30 && data.longitude < -55); // Atlântico Sul

    if ((foraDoBrasil || noOceano) && data.latitude !== 0 && data.longitude !== 0) {
      console.error(`🌍 [GPS INVALID] ${imei}: Coordenadas fora do Brasil/oceano (${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}) - GPS com problema`);

      // Tentar reiniciar o GPS
      tentarReiniciarGPS(imei);

      // Atualizar status
      await dispositivoService.upsert(imei, {
        status: 'online',
        gps_status: 'INVALID_REGION',
        ultimo_erro_gps: new Date()
      });

      // Registrar heartbeat mas NÃO processar localização/viagem
      const hbInfo = await heartbeatService.register(imei);
      console.log(`💓 [Heartbeat] Updated on invalid region - #${hbInfo.count} from ${imei}`);

      return;
    }

    // ✅ VALIDAÇÃO: Clamping de coordenadas fora do range
    if (data.latitude < -90 || data.latitude > 90 ||
        data.longitude < -180 || data.longitude > 180) {
      console.warn(`[Location] ⚠️ Clamping invalid coordinates for ${imei}: (${data.latitude}, ${data.longitude})`);
      data.latitude = Math.max(-90, Math.min(90, data.latitude));
      data.longitude = Math.max(-180, Math.min(180, data.longitude));
    }

    // ✅ GPS OK: Limpar status de GPS problemático se coordenadas válidas
    if (gpsProblematico.has(imei)) {
      console.log(`✅ [GPS OK] ${imei}: GPS voltou a funcionar corretamente!`);
      gpsProblematico.delete(imei);

      // Atualizar status do dispositivo
      await dispositivoService.upsert(imei, {
        gps_status: 'OK'
      });
    }

    // Update heartbeat (data arrived)
    const hbInfo = await heartbeatService.register(imei);
    console.log(`💓 [Heartbeat] Updated on location - #${hbInfo.count} from ${imei}`);

    // Buscar dispositivo para configuração de ignição virtual
    const dispositivo = await dispositivoService.getByImei(imei);

    // Detectar estado da ignição
    let estadoIgnicao = undefined;
    let accAtual = data.ignicao;

    // ✅ IGNIÇÃO VIRTUAL: Configurar se dispositivo usa
    let configIgnicaoVirtual = null;
    if (dispositivo && dispositivo.usa_ignicao_virtual) {
      configIgnicaoVirtual = {
        usa: true,
        tensao: data.tensao_principal || null,  // Tensão do pacote 0x22
        limiteOn: dispositivo.tensao_motor_ligado || 13.8,
        limiteOff: dispositivo.tensao_motor_deslig || 12.6
      };
      console.log(`🔌 [Ignição Virtual] Dispositivo ${imei} usa ignição virtual. Tensão: ${data.tensao_principal?.toFixed(2) || 'N/A'}V`);
    }

    // ✅ Se pacote não tem ACC (0x12), buscar estado atual do dispositivo (vem do 0x13)
    if (accAtual === undefined && dispositivo && dispositivo.estado_ignicao) {
      // Usar estado anterior: se estava acc_on, idle ou moving, ACC é true
      accAtual = ['acc_on', 'idle', 'moving'].includes(dispositivo.estado_ignicao);
      console.log(`[Location] ACC não presente no pacote, usando estado anterior: ${dispositivo.estado_ignicao} → ACC=${accAtual}`);
    }

    // Detectar estado com ignição virtual ou tradicional
    // ✅ Passar tipo do dispositivo, IMEI e tensão para detecção híbrida
    const tipoDispositivo = dispositivo?.tipo || null;
    const conexaoPosChave = dispositivo?.conexao_pos_chave || false;
    const tensaoPrincipal = data.tensao_principal || null;
    estadoIgnicao = detectarEstadoIgnicao(accAtual, null, data.velocidade, configIgnicaoVirtual, tipoDispositivo, imei, conexaoPosChave, tensaoPrincipal);
    console.log(`🔑 [Ignição] Estado detectado: ${estadoIgnicao} (ACC=${accAtual}, Vel=${data.velocidade}km/h, Tensão=${tensaoPrincipal?.toFixed(2) || 'N/A'}V, Tipo=${tipoDispositivo}, IMEI=${imei}, PósChave=${conexaoPosChave})`);

    // ✅ CRÍTICO: Atualizar campos de ignição no data para salvar na localização
    // acc_on, idle, moving = ignição ligada (true); off = desligada (false)
    const ignicaoDetectada = ['acc_on', 'idle', 'moving'].includes(estadoIgnicao);
    data.ignicao = ignicaoDetectada;
    data.estado_ignicao = estadoIgnicao;  // Salvar estado detalhado (off, acc_on, idle, moving)

    // Ensure device exists (tipo será preservado se já existir, ou XT40_UNKNOWN para novos)
    await dispositivoService.upsert(imei, {
      status: 'online',
      ...(estadoIgnicao && { estado_ignicao: estadoIgnicao })
    });

    // Save location (com ignicao atualizada pela detecção virtual/física)
    await localizacaoService.create(imei, data);

    console.log(`✅ [Location] Saved for ${imei}: (${data.latitude}, ${data.longitude}) @ ${data.velocidade} km/h`);

    // ✅ GEOFENCING: Verificar entrada/saída de cercas virtuais
    geofencingService.verificarPosicao(
      imei,
      data.latitude,
      data.longitude,
      data.velocidade || 0,
      data.timestamp ? new Date(data.timestamp) : new Date()
    ).catch(err => {
      console.warn(`[Geofencing] Erro ao verificar posição: ${err.message}`);
    });

    // ✅ NOVO: Se pacote 0x22 tem dados OBD2 extras (odômetro, horímetro, tensões), salvar também como OBD2
    if (data.odometro_embarcado !== undefined || data.hora_motor_embarcada !== undefined ||
        data.tensao_bateria !== undefined || data.percentual_bateria !== undefined) {
      console.log(`[Location→OBD2] Pacote 0x22 detectado com dados extras, salvando OBD2...`);
      console.log(`[Location→OBD2] Data sendo enviado:`, {
        odo: data.odometro_embarcado,
        hori: data.hora_motor_embarcada,
        bat: data.tensao_bateria,
        batPercent: data.percentual_bateria,
        ignicao: data.ignicao,
        timestamp: data.timestamp
      });
      await obd2Service.create(imei, data);
      console.log(`✅ [Location→OBD2] Dados OBD2 salvos do pacote 0x22`);
    }

    // ✅ VIAGEM: Processar viagem para TODOS os dispositivos (detecta início/fim de viagem)
    // Inclui dispositivos OBD2 (XT40_OBD2) que não enviam dados OBD2 reais
    // Passa tensão principal para detecção de ignição virtual
    if (data.ignicao !== undefined || data.tensao_principal !== undefined || data.velocidade !== undefined) {
      const resultadoViagem = await viagemService.processarLocalizacao(
        imei,
        data.ignicao,
        data.latitude,
        data.longitude,
        data.velocidade,
        data.timestamp || new Date(),
        data.tensao_principal  // ✅ Tensão para ignição virtual
      );

      if (resultadoViagem) {
        if (resultadoViagem.evento === 'inicio_viagem') {
          console.log(`🚗 [Viagem] INÍCIO DE VIAGEM detectado para ${imei}`);
        } else if (resultadoViagem.evento === 'fim_viagem') {
          console.log(`🏁 [Viagem] FIM DE VIAGEM detectado para ${imei}:`, resultadoViagem.viagem);
        }
      }
    }
  } catch (error) {
    console.error('[Location] Save error:', error.message);
  }
}

// Handle OBD2 data
async function handleOBD2Data(imei, data) {
  try {
    // Update heartbeat (data arrived)
    const hbInfo = await heartbeatService.register(imei);
    console.log(`💓 [Heartbeat] Updated on OBD2 - #${hbInfo.count} from ${imei}`);

    // Detectar estado da ignição com ACC + RPM + Velocidade (detecção completa)
    let estadoIgnicao = undefined;
    if (data.ignicao !== undefined || data.rpm !== undefined) {
      const acc = data.ignicao ?? false;
      const rpm = data.rpm ?? null;

      // Buscar última velocidade conhecida do dispositivo
      let velocidade = null;
      try {
        const locAtual = await localizacaoService.getCurrent(imei);
        velocidade = locAtual?.velocidade ?? null;
      } catch (e) { /* Ignorar se não tiver localização */ }

      estadoIgnicao = detectarEstadoIgnicao(acc, rpm, velocidade);
      console.log(`🔑 [Ignição] Estado detectado: ${estadoIgnicao} (ACC=${acc}, RPM=${rpm}, Vel=${velocidade}km/h)`);

      // Atualizar estado do dispositivo (tipo será preservado se já existir)
      await dispositivoService.upsert(imei, {
        status: 'online',
        estado_ignicao: estadoIgnicao
      });
    }

    await obd2Service.create(imei, data);
    console.log(`✅ [OBD2] Saved for ${imei}`);
  } catch (error) {
    console.error('[OBD2] Save error:', error.message);
  }
}

// Handle alarm data
async function handleAlarmData(imei, data) {
  try {
    // Update heartbeat (data arrived)
    const hbInfo = await heartbeatService.register(imei);
    console.log(`💓 [Heartbeat] Updated on alarm - #${hbInfo.count} from ${imei}`);

    await alarmeService.create(imei, data);
    console.log(`✅ [Alarm] Saved for ${imei}:`, data.tipo_alarme);

    // ✅ Broadcast alarme via WebSocket para frontend em tempo real
    broadcastToClients({
      tipo: 'alarm',
      imei: imei,
      dados: data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[Alarm] Save error:', error.message);
  }
}

// Broadcast updates via WebSocket
function broadcastUpdate(imei, parsedData) {
  // ✅ TIPO 1: Broadcast genérico para dashboard normal
  const updateMessage = JSON.stringify({
    tipo: 'update',
    imei,
    data: parsedData.data,
    timestamp: parsedData.timestamp.toISOString(),
    status: 'online', // Sempre online quando dados chegam
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(updateMessage);
    }
  });

  // ✅ TIPO 2: Broadcast de status - importante para frontend saber que dispositivo está online
  const statusMessage = JSON.stringify({
    tipo: 'device_status',
    imei: imei,
    status: 'online',
    timestamp: new Date().toISOString(),
    packet_type: parsedData.type,
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(statusMessage);
    }
  });

  // ✅ TIPO 3: Broadcast específico para debug (novo)
  // Enviar detalhes completos do pacote para dashboard de debug
  const debugMessage = JSON.stringify({
    tipo: 'packet_debug',
    imei: imei,
    protocolNumber: parsedData.protocolNumber,
    type: parsedData.type,
    raw: parsedData.raw.substring(0, 200), // Limitar a primeiros 100 bytes hex (200 chars)
    packetLength: parsedData.packetLength,
    serialNumber: parsedData.serialNumber,
    timestamp: parsedData.timestamp.toISOString(),
    data: parsedData.data
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(debugMessage);
    }
  });
}

// ============ SERVIDOR TCP PARA RASTREADOR ============

const TCP_PORT = process.env.TCP_PORT || 8877;

// TCP Server é criado apenas na instância master
let tcpServer = null;

if (ENABLE_TCP) {
  tcpServer = net.createServer((socket) => {
  const sessionKey = getSessionKey(socket);
  let sessionImei = null; // ✅ CORREÇÃO #1: Rastrear IMEI por sessão
  const packetBuffer = new TCPPacketBuffer(); // ✅ CORREÇÃO #3: Buffer para reassembly

  console.log(`[TCP] Cliente conectado: ${sessionKey}`);

  socket.on('data', async (rawData) => {
    const clientId = getSessionKey(socket);

    // ✅ CORREÇÃO #7: Verificar rate limit
    if (!checkRateLimit(clientId, 100)) {
      console.warn(`[RateLimit] Exceeded for ${clientId}, closing connection`);
      socket.destroy();
      return;
    }

    // ✅ MELHORIA: Logging estruturado (evitar hex dump completo para pacotes grandes)
    const hexPreview = rawData.length > 32
      ? rawData.slice(0, 32).toString('hex').toUpperCase() + '...'
      : rawData.toString('hex').toUpperCase();
    console.log(`[TCP] 📦 Recebido ${rawData.length} bytes | Preview: ${hexPreview}`);

    try {
      // ✅ CORREÇÃO #3: Adicionar dados brutos ao buffer
      packetBuffer.append(rawData);
      const bufferStats = packetBuffer.getStats();
      console.log(`[PacketBuffer] Stats: ${bufferStats.totalPacketsExtracted} packets extracted, buffer size: ${bufferStats.currentBufferSize} bytes`);

      // ✅ CORREÇÃO #3: Extrair pacotes completos
      const packets = packetBuffer.getPackets();

      for (const data of packets) {
        console.log(`[PacketBuffer] Processando pacote de ${data.length} bytes: ${data.toString('hex')}`);

        // Parse GPS data
        const parsedData = gpsParser.parse(data);

        if (parsedData) {
          console.log('[TCP] Dados parseados:', parsedData.type);

          // ✅ CRÍTICO: Enviar ACK IMEDIATAMENTE após parse (antes de qualquer operação async)
          // O dispositivo espera ACK rápido (<2s), se demorar ele desconecta e reconecta
          // Isso causa ciclo de reconexão infinito durante alta carga do sistema
          const ack = gpsParser.createAckResponse(parsedData.protocolNumber, parsedData.serialNumber);
          if (ack && !socket.destroyed) {
            socket.write(ack);
            console.log(`[TCP] ✅ ACK enviado IMEDIATAMENTE (${ack.length} bytes)`);
          }

          // ✅ MELHORIA: Registrar estatísticas de pacotes para debug
          apiRoutes.recordPacket(parsedData.type);
          apiRoutes.recordPacketDetails({
            type: parsedData.type,
            protocolNumber: `0x${parsedData.protocolNumber.toString(16).padStart(2, '0')}`,
            imei: sessionImei || 'unknown',
            timestamp: parsedData.timestamp.toISOString(),
            raw: parsedData.raw.substring(0, 100), // Primeiros 50 bytes hex
            // ✅ NOVO: Incluir data para contagem de Location Source Type
            data: parsedData.data
          });

          // ✅ CORREÇÃO: Extrair IMEI (prioridade: parsedData > extractIMEI > sessionImei)
          let imei = parsedData.imei || extractIMEI(data) || sessionImei;

          // Se ainda não tem IMEI, não processar
          if (!imei) {
            console.warn(`[TCP] Pacote sem IMEI válido, tipo: ${parsedData.type}`);
            continue;
          }

          console.log(`[TCP] IMEI extracted: ${imei} (length: ${imei.length})`);
          // Remove leading zero if exists (X3Tech quirk)
          if (imei.startsWith('0') && imei.length === 16) {
            imei = imei.substring(1);
          }
          imei = imei.substring(0, 15); // Ensure max 15 chars

          // ✅ CORREÇÃO #1: Se é LOGIN, registrar IMEI da sessão
          if (parsedData.type === 'login') {
            sessionImei = imei;
            sessionImeiMap.set(sessionKey, imei);
            console.log(`[TCP] IMEI registrado para sessão: ${imei}`);
          }

          // ✅ SEGURANÇA: Rate limit por IMEI (além do rate limit por IP)
          if (!tcpSecurity.checkImeiRateLimit(imei)) {
            console.warn(`[TCP-Security] ⚠️ Rate limit por IMEI excedido: ${imei}`);
            continue; // Ignora pacote mas mantém conexão
          }

          // ✅ SEGURANÇA: Atualizar atividade do IMEI
          tcpSecurity.updateImeiActivity(imei);

          // Process based on data type
          switch (parsedData.type) {
            case 'login':
              // ✅ SEGURANÇA: Validar IMEI antes de processar login
              const socketInfo = {
                ip: socket.remoteAddress?.replace('::ffff:', '') || 'unknown',
                port: socket.remotePort || 0
              };
              const validation = await tcpSecurity.validateImeiLogin(imei, socketInfo);

              if (!validation.valid) {
                console.warn(`[TCP-Security] ❌ Login rejeitado para ${imei}: ${validation.reason}`);
                if (validation.shouldDisconnect) {
                  // Não desconecta imediatamente para evitar flood de reconexões
                  // Apenas ignora o pacote e não registra o dispositivo
                  break;
                }
              }

              // Registrar heartbeat
              const hbInfo = await heartbeatService.register(imei);
              console.log(`💓 [Heartbeat] #${hbInfo.count} from ${imei}`);

              // Handle device login/online status
              // Tipo será XT40_UNKNOWN para novos dispositivos ou preservado se já existir
              await dispositivoService.upsert(imei, {
                status: 'online',
              });
              console.log(`✅ [Login] Device ${imei} connected and marked online (IP: ${socketInfo.ip})`);

              // ✅ Armazenar conexão ativa para enviar comandos depois
              activeConnections.set(imei, socket);
              comandoService.registerSocket(imei, socket); // Registra no serviço de comandos
              console.log(`📡 [Connection] Socket armazenado para ${imei}`);

              // ✅ Configurar keepalive e timeout para manter conexão aberta
              socket.setKeepAlive(true, 10000); // Manter vivo a cada 10 segundos
              socket.setTimeout(60000); // Timeout de 60 segundos (garante transmissão de dados)
              console.log(`⏱️ [TCP] Keepalive ativado (10s) | Timeout: 60 segundos`);

              // ✅ Enviar comandos de inicialização para ativar GPS/OBD2
              // Aguardar 5 segundos para dispositivo processar ACK
              console.log(`📋 [Init] Agendando comandos de inicialização em 5 segundos...`);
              setTimeout(async () => {
                await sendInitCommands(imei, socket);
              }, 5000);

              break;

            case 'location':
              // Registrar heartbeat e marcar como online
              await heartbeatService.register(imei);
              await dispositivoService.upsert(imei, {
                status: 'online',
              });

              const locationData = {
                ...parsedData.data,
                timestamp: parsedData.timestamp,
              };

              // ✅ NOVO: Se pacote 0x12 não tem tensão, buscar do cache (pacote 0x13)
              // Pacotes 0x12 básicos não incluem tensão, mas 0x13 sim
              if ((locationData.tensao_principal === undefined || locationData.tensao_principal === null) && tensaoCache.has(imei)) {
                const cached = tensaoCache.get(imei);
                // Usar tensão do cache se não for muito antiga (máximo 5 minutos)
                const idadeCache = (new Date() - cached.timestamp) / 1000;
                if (idadeCache < 300) { // 5 minutos
                  locationData.tensao_principal = cached.tensao;
                  // Também usar ACC do cache se não tiver
                  if (locationData.ignicao === undefined || locationData.ignicao === null) {
                    locationData.ignicao = cached.acc;
                  }
                  console.log(`🔋 [Cache→Location] ${imei}: Usando tensão do cache: ${cached.tensao}V (idade: ${idadeCache.toFixed(0)}s)`);
                }
              }

              console.log(`🌍 [GPS] Dados de localização para ${imei}:`, {
                lat: locationData.latitude,
                lon: locationData.longitude,
                speed: locationData.velocidade,
                tensao: locationData.tensao_principal || 'N/A',
                timestamp: locationData.timestamp.toISOString(),
              });
              await handleLocationData(imei, locationData);
              break;

            case 'sim_info':
              // ✅ Pacote 0x94 é MSG_INFO com dados do SIM, NÃO OBD2!
              await heartbeatService.register(imei);
              await dispositivoService.upsert(imei, {
                status: 'online',
              });

              console.log(`📱 [SIM_INFO] Dados do SIM para ${imei}:`, {
                iccid: parsedData.data.iccid,
                nota: 'Pacote 0x94 contém info do SIM, NÃO dados OBD2 reais'
              });
              // NÃO salvar como OBD2 - dados são falsos!
              break;

            case 'obd2':
              // ✅ OBD2 real (se vier de outro tipo de pacote no futuro)
              await heartbeatService.register(imei);
              await dispositivoService.upsert(imei, {
                status: 'online',
              });

              // Verificar se dados são válidos antes de salvar
              if (parsedData.data.rpm !== null || parsedData.data.temperatura_motor !== null) {
                console.log(`🔧 [OBD2] Dados de diagnóstico para ${imei}:`, {
                  rpm: parsedData.data.rpm,
                  speed: parsedData.data.velocidade,
                  temp: parsedData.data.temperatura_motor,
                  fuel: parsedData.data.nivel_combustivel,
                });
                await handleOBD2Data(imei, parsedData.data);
              } else {
                console.log(`⚠️ [OBD2] Dados inválidos ignorados para ${imei}`);
              }
              break;

            case 'alarm':
              // Registrar heartbeat e marcar como online
              await heartbeatService.register(imei);
              await dispositivoService.upsert(imei, {
                status: 'online',
              });

              // ✅ Log melhorado para ALARM
              console.log(`🚨 [ALARM] Dados de alarme para ${imei}:`, {
                tipo: parsedData.data.tipo_alarme,
                severidade: parsedData.data.severidade,
                descricao: parsedData.data.descricao,
                timestamp: parsedData.data.timestamp?.toISOString(),
              });
              await handleAlarmData(imei, parsedData.data);
              break;

            case 'status':
            case 'heartbeat':
              // Registrar heartbeat e marcar como online
              await heartbeatService.register(imei);

              // ✅ Extrair dados de ignição do pacote de status (0x13)
              const statusData = parsedData.data || {};
              let statusUpdate = { status: 'online' };

              // ✅ NOVO: Salvar tensão no cache para usar em pacotes 0x12
              // A tensão do 0x13 é a tensão principal do veículo (não bateria de backup)
              if (statusData.tensao_bateria !== undefined && statusData.tensao_bateria !== null) {
                tensaoCache.set(imei, {
                  tensao: statusData.tensao_bateria,
                  timestamp: new Date(),
                  acc: statusData.ignicao
                });
                console.log(`🔋 [Cache] Tensão salva para ${imei}: ${statusData.tensao_bateria}V (ACC=${statusData.ignicao ? 'ON' : 'OFF'})`);
              }

              // Se tem informação de ignição (ACC)
              if (statusData.ignicao !== undefined) {
                const acc = statusData.ignicao;
                const tensaoBat = statusData.tensao_bateria;
                let estadoIgnicaoStatus;

                // ✅ CORRIGIDO: Detecção binária por tensão (sem estado ACC intermediário)
                // Removido >= 12.5V = acc_on porque causava falsos positivos
                if (!acc) {
                  estadoIgnicaoStatus = 'off';
                } else if (tensaoBat !== undefined && tensaoBat !== null) {
                  // ACC ligado + tensão disponível
                  if (tensaoBat >= 13.2) {
                    estadoIgnicaoStatus = 'idle';  // Motor ligado (alternador ativo)
                  } else {
                    estadoIgnicaoStatus = 'off';  // Tensão abaixo de 13.2V = motor desligado
                  }
                } else {
                  // ACC ligado mas sem info de tensão - assumir idle (ACC do dispositivo é confiável)
                  estadoIgnicaoStatus = 'idle';
                }

                statusUpdate.estado_ignicao = estadoIgnicaoStatus;
                console.log(`🔑 [Status] ${imei}: ACC=${acc ? 'ON' : 'OFF'}, Tensão=${tensaoBat || 'N/A'}V → Estado: ${estadoIgnicaoStatus}`);
              }

              await dispositivoService.upsert(imei, statusUpdate);
              console.log(`💓 [Heartbeat] Status packet from ${imei}`);
              break;

            default:
              console.log('[TCP] Unknown data type:', parsedData.type);
          }

          // ✅ ACK já foi enviado IMEDIATAMENTE no início do processamento
          // (Removido: código antigo que enviava ACK depois do processamento)

          // Broadcast to WebSocket clients
          broadcastUpdate(imei, parsedData);
        } else {
          console.warn('[TCP] Falha ao processar pacote (CRC ou parse error)');
        }
      }
    } catch (error) {
      console.error('[TCP] Processing error:', error.message);
    }
  });

  socket.on('end', () => {
    // ✅ CORREÇÃO #1: Limpar IMEI da sessão quando desconectar
    if (sessionImei) {
      activeConnections.delete(sessionImei);
      comandoService.unregisterSocket(sessionImei); // Remove do serviço de comandos
      tcpSecurity.removeImeiConnection(sessionImei); // ✅ SEGURANÇA: Remove do tracking de conexões
      console.log(`📡 [Connection] Socket removido para ${sessionImei}`);
    }
    sessionImeiMap.delete(sessionKey);
    console.log(`[TCP] Cliente desconectado: ${sessionKey}`);
  });

  socket.on('error', (error) => {
    console.error(`[TCP] Erro na conexão ${sessionKey}: ${error.message}`);
    // ✅ SEGURANÇA: Limpar conexão também em caso de erro
    if (sessionImei) {
      tcpSecurity.removeImeiConnection(sessionImei);
    }
  });
  });

  tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`\n🚗 Servidor TCP XT40_4F escutando em 0.0.0.0:${TCP_PORT}\n`);
  });
} else {
  console.log(`\n⏭️  [Instance ${INSTANCE_ID}] Servidor TCP desabilitado nesta instância (apenas HTTP/API)\n`);
}

// ============ SERVIDOR TCP PARA XT40 OBD2 (PORTA SEPARADA) ============
// Handler isolado para dispositivos OBD2 - pode ser modificado sem afetar o XT40_4F

const TCP_PORT_OBD2 = process.env.TCP_PORT_OBD2 || 8878;
let tcpServerOBD2 = null;

if (ENABLE_TCP) {
  try {
    const obd2Handler = require('./tcp-handlers/xt40-obd2.handler');

    tcpServerOBD2 = obd2Handler.createServer({
      apiRoutes: apiRoutes
    });

    tcpServerOBD2.listen(TCP_PORT_OBD2, '0.0.0.0', () => {
      console.log(`\n🔧 Servidor TCP XT40_OBD2 escutando em 0.0.0.0:${TCP_PORT_OBD2}\n`);
    });

    tcpServerOBD2.on('error', (err) => {
      console.error(`[TCP:OBD2] Erro no servidor:`, err.message);
    });
  } catch (error) {
    console.error(`[TCP:OBD2] Erro ao inicializar servidor OBD2:`, error.message);
    console.log(`[TCP:OBD2] Continuando sem servidor OBD2...`);
  }
}

// ============ SERVIDOR TCP PARA TELTONIKA (PORTA SEPARADA) ============
// Handler para dispositivos Teltonika (FMC800, FMC920, FMC003, FMC650)
// Protocolo completamente diferente do GT06 (X3Tech)

const TCP_PORT_TELTONIKA = process.env.TELTONIKA_PORT || 8879;
let tcpServerTeltonika = null;

if (ENABLE_TCP) {
  try {
    const teltonikaHandler = require('./tcp-handlers/teltonika.handler');

    tcpServerTeltonika = teltonikaHandler.createServer({
      apiRoutes: apiRoutes,
      gatewayId: `teltonika-${INSTANCE_ID}`,
      maxConnections: 2000,
      connectionTimeout: 180000
    });

    tcpServerTeltonika.listen(TCP_PORT_TELTONIKA, '0.0.0.0', () => {
      console.log(`\n📡 Servidor TCP TELTONIKA escutando em 0.0.0.0:${TCP_PORT_TELTONIKA}`);
      console.log(`   Modelos suportados: FMC800, FMC920, FMC003, FMC650`);
      console.log(`   Codecs: Codec 8, Codec 8E, Codec 12, Codec 16\n`);
    });

    tcpServerTeltonika.on('error', (err) => {
      console.error(`[TCP:Teltonika] Erro no servidor:`, err.message);
    });

    // Registrar conexões Teltonika nas rotas da API
    apiRoutes.setTeltonikaConnections(
      teltonikaHandler.activeConnections,
      teltonikaHandler.TELTONIKA_COMMANDS,
      teltonikaHandler.sendCommand
    );
  } catch (error) {
    console.error(`[TCP:Teltonika] Erro ao inicializar servidor Teltonika:`, error.message);
    console.log(`[TCP:Teltonika] Continuando sem servidor Teltonika...`);
  }
}

// ============ SERVIDOR HTTP ============

const HTTP_PORT = process.env.HTTP_PORT || 8000;

server.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚗 SISTEMA DE RASTREAMENTO VEICULAR - Instância ${INSTANCE_ID}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n✅ Servidor HTTP/WebSocket rodando`);
  console.log(`📱 Porta HTTP: ${HTTP_PORT}`);
  console.log(`🏷️  Tipo: ${IS_MASTER ? 'MASTER (TCP + HTTP)' : 'WORKER (HTTP apenas)'}`);
  if (IS_MASTER) {
    console.log(`📡 TCP XT40_4F (Cabo): porta ${TCP_PORT}`);
    console.log(`🔧 TCP XT40_OBD2: porta ${TCP_PORT_OBD2}`);
    console.log(`📡 TCP Teltonika (FMC): porta ${TCP_PORT_TELTONIKA}`);
  }
  console.log(`🔌 WebSocket: ws://0.0.0.0:${HTTP_PORT}/ws`);
  console.log(`\n${'='.repeat(60)}\n`);

  // Sinalizar PM2 que o processo está pronto
  if (process.send) {
    process.send('ready');
  }
});

// ✅ Timers e tarefas periódicas (apenas na instância master)
if (IS_MASTER) {
  // Timer periódico para marcar dispositivos offline e resetar ignição
  setInterval(async () => {
    await heartbeatService.markOfflineDevices();
  }, 5 * 60 * 1000); // A cada 5 minutos
  console.log('⏱️  Timer de verificação offline iniciado (5 min)');

  // ✅ NOVO: Timer de limpeza de Maps em memória (previne memory leaks)
  // Executa a cada 1 hora para remover entradas antigas dos caches
  setInterval(() => {
    const mapStats = cleanupInMemoryMaps();
    const heartbeatRemoved = heartbeatService.cleanupStaleEntries(24); // 24 horas

    const totalRemoved = mapStats.clientRateLimits + mapStats.tensaoCache +
                         mapStats.gpsProblematico + heartbeatRemoved;

    if (totalRemoved > 0) {
      console.log(`🧹 [Memory Cleanup] Removidas ${totalRemoved} entradas antigas: ` +
        `rateLimits=${mapStats.clientRateLimits}, tensao=${mapStats.tensaoCache}, ` +
        `gpsProblematico=${mapStats.gpsProblematico}, heartbeats=${heartbeatRemoved}`);
    }

    // Log de estatísticas atuais (para monitoramento)
    const currentStats = getMapStats();
    console.log(`📊 [Memory Stats] Maps em memória: ` +
      `rateLimits=${currentStats.clientRateLimits}, tensao=${currentStats.tensaoCache}, ` +
      `gpsProblematico=${currentStats.gpsProblematico}, heartbeats=${currentStats.heartbeats}, ` +
      `activeConnections=${currentStats.activeConnections}`);
  }, 60 * 60 * 1000); // A cada 1 hora
  console.log('🧹 Timer de limpeza de memória iniciado (1h)');

  // Limpeza periódica de logs e métricas antigas (a cada 6 horas)
  const dataRetentionService = require('./services/data-retention.service');

  setInterval(async () => {
    logger.info('Cleanup', 'Iniciando limpeza de dados antigos...');
    await metricsPersistence.cleanup(24); // Manter 24 horas de métricas
    await logger.cleanup(7); // Manter 7 dias de logs

    // LGPD: Limpeza automática conforme políticas de retenção
    try {
      await dataRetentionService.runFullCleanup();
    } catch (error) {
      logger.error('Cleanup', `Erro na limpeza LGPD: ${error.message}`);
    }

    logger.success('Cleanup', 'Limpeza concluída');
  }, 6 * 60 * 60 * 1000);
  logger.info('System', 'Timer de limpeza de dados antigos iniciado (6h) - incluindo retenção LGPD');

  // ✅ Iniciar scheduler de jobs (multas, notificações, etc)
  scheduler.start();
  logger.info('System', 'Scheduler de jobs iniciado (multas, NIC, etc)');
}

// ✅ Iniciar broadcast de métricas do sistema via WebSocket (apenas se métricas habilitadas)
if (ENABLE_METRICS) {
  startMetricsBroadcast();
  logger.info('System', 'Broadcast de métricas do sistema iniciado (5s)');
}

async function gracefulShutdown(signal) {
  console.log(`\n\n🛑 [${signal}] Encerrando instância ${INSTANCE_ID}...`);

  // 1. Parar de aceitar novas conexões
  server.close();
  if (tcpServer) {
    tcpServer.close();
  }
  if (tcpServerOBD2) {
    tcpServerOBD2.close();
  }
  if (tcpServerTeltonika) {
    tcpServerTeltonika.close();
  }

  // 2. Encerrar filas (aguardar jobs ativos)
  await queueService.shutdown();

  // 2.1 Parar scheduler de jobs
  scheduler.stop();

  // 3. Desconectar Redis
  await redisService.disconnect();

  // 4. Desconectar banco de dados
  await prisma.$disconnect();

  console.log(`✅ Instância ${INSTANCE_ID} encerrada com sucesso`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = { server, tcpServer };
