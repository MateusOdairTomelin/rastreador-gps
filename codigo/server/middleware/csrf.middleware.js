/**
 * Middleware de Proteção CSRF
 *
 * Implementa proteção contra Cross-Site Request Forgery usando:
 * 1. Token CSRF gerado e validado
 * 2. Verificação de Origin/Referer
 * 3. SameSite cookies (quando aplicável)
 * 4. Redis para armazenamento distribuído (multi-instância)
 */

const crypto = require('crypto');

// ============================================================================
// ARMAZENAMENTO DE TOKENS (Redis com fallback para memória)
// ============================================================================

let redisClient = null;
const CSRF_PREFIX = 'csrf:';
const CSRF_TTL = 3600; // 1 hora em segundos

// Fallback para memória (usado quando Redis não está disponível)
const memoryTokens = new Map();

/**
 * Inicializa a conexão com Redis para CSRF tokens
 * Chamado automaticamente quando o Redis está disponível
 */
function initRedis(client) {
  redisClient = client;
  console.log('[CSRF] ✅ Usando Redis para armazenamento de tokens');
}

/**
 * Verifica se Redis está disponível
 */
function isRedisAvailable() {
  return redisClient && redisClient.isOpen;
}

/**
 * Armazena token no Redis ou memória
 */
async function storeToken(token, userId) {
  const data = {
    userId,
    createdAt: Date.now()
  };

  if (isRedisAvailable()) {
    try {
      await redisClient.setEx(`${CSRF_PREFIX}${token}`, CSRF_TTL, JSON.stringify(data));
      return true;
    } catch (error) {
      console.warn('[CSRF] Erro ao salvar no Redis, usando memória:', error.message);
    }
  }

  // Fallback para memória
  memoryTokens.set(token, data);
  return true;
}

/**
 * Recupera token do Redis ou memória
 */
async function getToken(token) {
  if (isRedisAvailable()) {
    try {
      const data = await redisClient.get(`${CSRF_PREFIX}${token}`);
      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      console.warn('[CSRF] Erro ao ler do Redis, tentando memória:', error.message);
    }
  }

  // Fallback para memória
  return memoryTokens.get(token) || null;
}

/**
 * Remove token do Redis ou memória
 */
async function deleteToken(token) {
  if (isRedisAvailable()) {
    try {
      await redisClient.del(`${CSRF_PREFIX}${token}`);
    } catch (error) {
      console.warn('[CSRF] Erro ao deletar do Redis:', error.message);
    }
  }

  // Também remove da memória (pode estar em ambos)
  memoryTokens.delete(token);
}

// Limpar tokens expirados da memória a cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of memoryTokens.entries()) {
    if (now - data.createdAt > CSRF_TTL * 1000) {
      memoryTokens.delete(token);
    }
  }
}, 300000);

// ============================================================================
// FUNÇÕES PRINCIPAIS
// ============================================================================

/**
 * Gera um token CSRF para o usuário
 */
async function generateCSRFToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await storeToken(token, userId);
  return token;
}

/**
 * Valida um token CSRF
 */
async function validateCSRFToken(token, userId) {
  if (!token) return false;

  const data = await getToken(token);
  if (!data) return false;

  // Verificar se o token pertence ao usuário correto
  if (data.userId !== userId) return false;

  // Verificar se não expirou (1 hora)
  if (Date.now() - data.createdAt > CSRF_TTL * 1000) {
    await deleteToken(token);
    return false;
  }

  return true;
}

/**
 * Lista de origens permitidas (centralizada)
 */
function getAllowedOrigins() {
  return [
    'http://localhost:62000',
    'http://127.0.0.1:62000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    process.env.FRONTEND_URL,
    process.env.ALLOWED_ORIGIN
  ].filter(Boolean);
}

/**
 * Verifica se uma origem é permitida
 */
function isOriginAllowed(origin, host) {
  if (!origin) return false;

  const allowedOrigins = getAllowedOrigins();

  // Verificar lista explícita
  if (allowedOrigins.includes(origin)) {
    return true;
  }

  // Verificar mesma origem (navegador acessando o próprio servidor)
  if (host && origin.includes(host)) {
    return true;
  }

  return false;
}

/**
 * Middleware que protege rotas contra CSRF
 * Aplica-se apenas a métodos que modificam dados (POST, PUT, DELETE, PATCH)
 */
function csrfProtection(req, res, next) {
  // Métodos seguros não precisam de CSRF
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  // Rotas de login/auth não precisam de CSRF (ainda não tem sessão)
  const exemptRoutes = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/refresh',
    '/api/auth-motorista/',  // App mobile - todas as rotas (usa JWT próprio)
    '/api/convites/'
  ];

  if (exemptRoutes.some(route => req.path.startsWith(route))) {
    return next();
  }

  // Verificar Origin header (proteção primária)
  const origin = req.headers.origin;
  const host = req.headers.host;

  // Verificar se a origem é válida
  if (origin && !isOriginAllowed(origin, host)) {
    console.warn(`[CSRF] Origem suspeita bloqueada: ${origin}`);
    return res.status(403).json({
      error: 'CSRF detectado - Origem inválida',
      code: 'CSRF_ORIGIN_MISMATCH'
    });
  }

  // Verificar token CSRF no header (para requisições autenticadas)
  if (req.usuario) {
    const csrfToken = req.headers['x-csrf-token'];

    if (!csrfToken) {
      return res.status(403).json({
        error: 'Token CSRF ausente',
        code: 'CSRF_TOKEN_MISSING'
      });
    }

    // Validação assíncrona
    validateCSRFToken(csrfToken, req.usuario.id).then(isValid => {
      if (!isValid) {
        return res.status(403).json({
          error: 'Token CSRF inválido',
          code: 'CSRF_TOKEN_INVALID'
        });
      }
      next();
    }).catch(error => {
      console.error('[CSRF] Erro na validação:', error.message);
      // Em caso de erro, permitir (fail-open para não quebrar o sistema)
      next();
    });
    return;
  }

  next();
}

/**
 * Middleware para adicionar token CSRF na resposta após login
 */
function attachCSRFToken(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function(data) {
    // Se é uma resposta de login bem-sucedida, adicionar token CSRF
    if (data && data.success && data.accessToken && req.body && req.body.email) {
      // Extrair userId do token ou dos dados
      const userId = data.usuario?.id || data.userId;
      if (userId) {
        // Gerar token de forma assíncrona
        generateCSRFToken(userId).then(csrfToken => {
          data.csrfToken = csrfToken;
          res.header('X-CSRF-Token', csrfToken);
          return originalJson(data);
        }).catch(error => {
          console.error('[CSRF] Erro ao gerar token:', error.message);
          return originalJson(data);
        });
        return; // Não chamar originalJson aqui, será chamado no then/catch
      }
    }

    return originalJson(data);
  };

  next();
}

/**
 * Endpoint para obter novo token CSRF (usuário já autenticado)
 */
async function getNewCSRFToken(req, res) {
  if (!req.usuario) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  const token = await generateCSRFToken(req.usuario.id);

  res.json({
    success: true,
    csrfToken: token
  });
}

module.exports = {
  csrfProtection,
  attachCSRFToken,
  getNewCSRFToken,
  generateCSRFToken,
  validateCSRFToken,
  initRedis,
  getAllowedOrigins,
  isOriginAllowed
};
