const authService = require('../services/auth.service');
const redisService = require('../services/redis.service');

/**
 * Middleware de autenticação JWT
 * Verifica se o token é válido e adiciona dados do usuário ao request
 * ✅ Integrado com Redis para verificar blacklist de tokens
 */
async function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: 'Token não fornecido',
      code: 'NO_TOKEN'
    });
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2) {
    return res.status(401).json({
      error: 'Token mal formatado',
      code: 'TOKEN_MALFORMED'
    });
  }

  const [scheme, token] = parts;

  if (!/^Bearer$/i.test(scheme)) {
    return res.status(401).json({
      error: 'Token mal formatado',
      code: 'TOKEN_MALFORMED'
    });
  }

  // ✅ Verificar se token está na blacklist (Redis)
  const isBlacklisted = await redisService.isTokenBlacklisted(token);
  if (isBlacklisted) {
    return res.status(401).json({
      error: 'Token foi revogado (logout)',
      code: 'TOKEN_REVOKED'
    });
  }

  const decoded = authService.verifyAccessToken(token);

  if (!decoded) {
    return res.status(401).json({
      error: 'Token inválido ou expirado',
      code: 'TOKEN_INVALID'
    });
  }

  // ✅ Verificar se todos os tokens do usuário foram invalidados
  const tokenIssuedAt = decoded.iat ? decoded.iat * 1000 : 0;
  const invalidated = await redisService.areUserTokensInvalidated(decoded.userId, tokenIssuedAt);
  if (invalidated) {
    return res.status(401).json({
      error: 'Sessão invalidada, faça login novamente',
      code: 'SESSION_INVALIDATED'
    });
  }

  // Adiciona dados do usuário ao request (incluindo multi-tenant)
  req.usuario = {
    id: decoded.userId,
    email: decoded.email,
    role: decoded.role,          // Role global: super_admin, usuario
    nome: decoded.nome,
    // Campos multi-tenant
    organizacao_id: decoded.organizacao_id || null,
    organizacao_slug: decoded.organizacao_slug || null,
    organizacao_nome: decoded.organizacao_nome || null,
    role_org: decoded.role_org || null  // Role na organização: proprietario, admin, operador, visualizador
  };

  // Salvar token no request para possível logout
  req.token = token;

  return next();
}

/**
 * Middleware opcional de autenticação
 * Se token presente, valida e adiciona usuário ao request
 * Se não presente, continua sem autenticação
 */
function autenticarOpcional(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
    return next();
  }

  const decoded = authService.verifyAccessToken(parts[1]);

  if (decoded) {
    req.usuario = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      nome: decoded.nome,
      organizacao_id: decoded.organizacao_id || null,
      organizacao_slug: decoded.organizacao_slug || null,
      organizacao_nome: decoded.organizacao_nome || null,
      role_org: decoded.role_org || null
    };
  }

  return next();
}

/**
 * Middleware de autorização por role
 * @param {...string} rolesPermitidas - Roles permitidas para acessar a rota
 */
function autorizar(...rolesPermitidas) {
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({
        error: 'Não autenticado',
        code: 'NOT_AUTHENTICATED'
      });
    }

    if (!rolesPermitidas.includes(req.usuario.role)) {
      return res.status(403).json({
        error: 'Sem permissão para acessar este recurso',
        code: 'FORBIDDEN'
      });
    }

    return next();
  };
}

/**
 * Middleware para verificar se é admin
 * Aceita super_admin (global) ou admin/proprietario (na organização)
 */
function apenasAdmin(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({
      error: 'Não autenticado',
      code: 'NOT_AUTHENTICATED'
    });
  }

  // Super admin tem acesso total
  if (req.usuario.role === 'super_admin') {
    return next();
  }

  // Verificar role na organização
  const rolesAdmin = ['proprietario', 'admin'];
  if (!rolesAdmin.includes(req.usuario.role_org)) {
    return res.status(403).json({
      error: 'Acesso restrito a administradores',
      code: 'ADMIN_ONLY'
    });
  }

  return next();
}

/**
 * Middleware para verificar se é super admin (plataforma)
 */
function apenasSuperAdmin(req, res, next) {
  if (!req.usuario) {
    return res.status(401).json({
      error: 'Não autenticado',
      code: 'NOT_AUTHENTICATED'
    });
  }

  if (req.usuario.role !== 'super_admin') {
    return res.status(403).json({
      error: 'Acesso restrito a super administradores',
      code: 'SUPER_ADMIN_ONLY'
    });
  }

  return next();
}

/**
 * Extrai IP e User-Agent do request
 */
function extrairMetadados(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.connection?.remoteAddress ||
             req.socket?.remoteAddress ||
             null;

  const userAgent = req.headers['user-agent'] || null;

  return { ip, userAgent };
}

module.exports = {
  autenticar,
  autenticarOpcional,
  autorizar,
  apenasAdmin,
  apenasSuperAdmin,
  extrairMetadados
};
