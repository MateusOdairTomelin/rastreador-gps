/**
 * TCP Security Middleware
 * Validações de segurança para conexões TCP de rastreadores
 *
 * Implementa:
 * - Validação de IMEI cadastrado no banco
 * - Rate limiting por IMEI
 * - Detecção de conexões duplicadas (mesmo IMEI de IPs diferentes)
 * - Logging de segurança
 */

const { PrismaClient } = require('@prisma/client');

// Lazy loading do Prisma para evitar problemas de inicialização
let prisma = null;
const getPrisma = () => {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
};

// Cache de IMEIs válidos (evita consultas repetidas ao banco)
const imeiCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Mapa de conexões ativas por IMEI (para detectar duplicatas)
const activeImeiConnections = new Map();

// Rate limiting por IMEI
const imeiRateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minuto
const MAX_PACKETS_PER_MINUTE = 120; // Máximo 2 pacotes/segundo em média

// Estatísticas de segurança
const securityStats = {
  imeiRejections: 0,
  rateLimitHits: 0,
  duplicateConnections: 0,
  validConnections: 0,
  lastReset: new Date()
};

/**
 * Verifica se um IMEI está cadastrado no banco de dados
 * Usa cache para evitar consultas repetidas
 */
async function isImeiRegistered(imei) {
  if (!imei || imei.length !== 15) {
    return false;
  }

  // Verificar cache primeiro
  const cached = imeiCache.get(imei);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.registered;
  }

  try {
    const db = getPrisma();
    const dispositivo = await db.dispositivo.findUnique({
      where: { imei },
      select: { id: true }
    });

    const registered = !!dispositivo;

    // Atualizar cache
    imeiCache.set(imei, {
      registered,
      timestamp: Date.now()
    });

    return registered;
  } catch (error) {
    console.error(`[TCP-Security] Erro ao verificar IMEI ${imei}:`, error.message);
    // Em caso de erro de banco, permitir (fail open para não bloquear rastreadores)
    // mas logar para investigação
    return true;
  }
}

/**
 * Valida um IMEI no login TCP
 * Retorna objeto com resultado da validação
 */
async function validateImeiLogin(imei, socketInfo) {
  const result = {
    valid: false,
    reason: null,
    shouldDisconnect: false
  };

  // 1. Verificar formato do IMEI
  if (!imei || typeof imei !== 'string') {
    result.reason = 'IMEI_MISSING';
    result.shouldDisconnect = true;
    securityStats.imeiRejections++;
    console.warn(`[TCP-Security] ⚠️ IMEI ausente - IP: ${socketInfo.ip}`);
    return result;
  }

  if (imei.length !== 15 || !/^\d{15}$/.test(imei)) {
    result.reason = 'IMEI_INVALID_FORMAT';
    result.shouldDisconnect = true;
    securityStats.imeiRejections++;
    console.warn(`[TCP-Security] ⚠️ IMEI formato inválido: ${imei} - IP: ${socketInfo.ip}`);
    return result;
  }

  // 2. Verificar se IMEI está cadastrado
  const registered = await isImeiRegistered(imei);
  if (!registered) {
    result.reason = 'IMEI_NOT_REGISTERED';
    result.shouldDisconnect = true;
    securityStats.imeiRejections++;
    console.warn(`[TCP-Security] 🚫 IMEI não cadastrado: ${imei} - IP: ${socketInfo.ip}`);
    return result;
  }

  // 3. Verificar conexão duplicada (mesmo IMEI de IP diferente)
  const existingConnection = activeImeiConnections.get(imei);
  if (existingConnection && existingConnection.ip !== socketInfo.ip) {
    // Conexão duplicada detectada
    securityStats.duplicateConnections++;
    console.warn(
      `[TCP-Security] ⚠️ CONEXÃO DUPLICADA DETECTADA!\n` +
      `  IMEI: ${imei}\n` +
      `  IP anterior: ${existingConnection.ip}\n` +
      `  IP novo: ${socketInfo.ip}\n` +
      `  Conexão anterior: ${new Date(existingConnection.connectedAt).toISOString()}`
    );

    // Permitir nova conexão (pode ser reconexão legítima após mudança de IP)
    // mas alertar para investigação
    // A conexão antiga será substituída
  }

  // 4. Registrar conexão ativa
  activeImeiConnections.set(imei, {
    ip: socketInfo.ip,
    port: socketInfo.port,
    connectedAt: Date.now(),
    lastPacket: Date.now()
  });

  result.valid = true;
  securityStats.validConnections++;

  return result;
}

/**
 * Verifica rate limit por IMEI
 * Retorna true se dentro do limite, false se excedeu
 */
function checkImeiRateLimit(imei) {
  if (!imei) return true;

  const now = Date.now();
  let record = imeiRateLimits.get(imei);

  if (!record || (now - record.windowStart) > RATE_LIMIT_WINDOW) {
    // Nova janela de tempo
    record = {
      windowStart: now,
      count: 1
    };
    imeiRateLimits.set(imei, record);
    return true;
  }

  record.count++;

  if (record.count > MAX_PACKETS_PER_MINUTE) {
    securityStats.rateLimitHits++;
    console.warn(
      `[TCP-Security] ⚠️ Rate limit excedido para IMEI ${imei}: ` +
      `${record.count} pacotes em ${Math.round((now - record.windowStart) / 1000)}s`
    );
    return false;
  }

  return true;
}

/**
 * Atualiza timestamp do último pacote recebido de um IMEI
 */
function updateImeiActivity(imei) {
  const connection = activeImeiConnections.get(imei);
  if (connection) {
    connection.lastPacket = Date.now();
  }
}

/**
 * Remove registro de conexão ativa quando desconecta
 */
function removeImeiConnection(imei) {
  if (imei) {
    activeImeiConnections.delete(imei);
    console.log(`[TCP-Security] Conexão removida: ${imei}`);
  }
}

/**
 * Limpa cache de IMEI específico (usar após cadastro/remoção)
 */
function invalidateImeiCache(imei) {
  imeiCache.delete(imei);
}

/**
 * Retorna estatísticas de segurança
 */
function getSecurityStats() {
  const now = new Date();
  const uptimeMs = now - securityStats.lastReset;
  const uptimeHours = (uptimeMs / (1000 * 60 * 60)).toFixed(2);

  return {
    ...securityStats,
    activeConnections: activeImeiConnections.size,
    cachedImeis: imeiCache.size,
    rateLimitRecords: imeiRateLimits.size,
    uptimeHours,
    timestamp: now.toISOString()
  };
}

/**
 * Lista conexões ativas (para debugging)
 */
function listActiveConnections() {
  const connections = [];
  for (const [imei, info] of activeImeiConnections) {
    connections.push({
      imei,
      ip: info.ip,
      connectedAt: new Date(info.connectedAt).toISOString(),
      lastPacket: new Date(info.lastPacket).toISOString(),
      idleSeconds: Math.round((Date.now() - info.lastPacket) / 1000)
    });
  }
  return connections.sort((a, b) => b.idleSeconds - a.idleSeconds);
}

/**
 * Limpeza periódica de registros antigos
 */
function cleanupOldRecords() {
  const now = Date.now();

  // Limpar cache de IMEIs expirados
  for (const [imei, data] of imeiCache) {
    if ((now - data.timestamp) > CACHE_TTL * 2) {
      imeiCache.delete(imei);
    }
  }

  // Limpar rate limits antigos
  for (const [imei, data] of imeiRateLimits) {
    if ((now - data.windowStart) > RATE_LIMIT_WINDOW * 2) {
      imeiRateLimits.delete(imei);
    }
  }

  // Limpar conexões inativas (sem pacote há mais de 10 minutos)
  const INACTIVE_THRESHOLD = 10 * 60 * 1000;
  for (const [imei, data] of activeImeiConnections) {
    if ((now - data.lastPacket) > INACTIVE_THRESHOLD) {
      console.log(`[TCP-Security] Removendo conexão inativa: ${imei} (${Math.round((now - data.lastPacket) / 1000)}s sem atividade)`);
      activeImeiConnections.delete(imei);
    }
  }
}

// Executar limpeza a cada 5 minutos
setInterval(cleanupOldRecords, 5 * 60 * 1000);

module.exports = {
  validateImeiLogin,
  checkImeiRateLimit,
  updateImeiActivity,
  removeImeiConnection,
  invalidateImeiCache,
  getSecurityStats,
  listActiveConnections,
  isImeiRegistered
};
