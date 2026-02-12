/**
 * Rate Limiting Middleware - LGPD/Segurança
 *
 * Proteção contra:
 * - Brute force em login
 * - Ataques de enumeração
 * - DoS/DDoS
 * - Abuso de API
 *
 * Usa armazenamento em memória (funciona em instância única)
 * Para ambiente distribuído, configurar Redis separadamente
 */

const rateLimit = require('express-rate-limit');

// Desabilitar validação estrita de IPv6 (nosso ambiente usa IPv4)
// Isso evita o erro ERR_ERL_KEY_GEN_IPV6
process.env.EXPRESS_RATE_LIMIT_SKIP_HEADERS_CHECK = 'true';

// ============ CONFIGURAÇÕES POR TIPO DE ENDPOINT ============

const RATE_LIMITS = {
  // Login - proteção brute force (limite aumentado para desenvolvimento)
  login: {
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 20, // 20 tentativas
    message: {
      sucesso: false,
      erro: 'Muitas tentativas de login. Aguarde 5 minutos.',
      codigo: 'RATE_LIMIT_LOGIN',
      aguardar_minutos: 5
    }
  },

  // Registro - restritivo (proteção spam)
  registro: {
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3, // 3 registros por hora
    message: {
      sucesso: false,
      erro: 'Muitos registros. Aguarde 1 hora.',
      codigo: 'RATE_LIMIT_REGISTRO'
    }
  },

  // Reset de senha - muito restritivo
  resetSenha: {
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 3, // 3 solicitações por hora
    message: {
      sucesso: false,
      erro: 'Muitas solicitações de reset. Aguarde 1 hora.',
      codigo: 'RATE_LIMIT_RESET'
    }
  },

  // Exportação de dados LGPD - moderado
  exportacaoDados: {
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 50, // 50 exportações por hora (aumentado para relatórios)
    message: {
      sucesso: false,
      erro: 'Muitas exportações de dados. Aguarde 1 hora.',
      codigo: 'RATE_LIMIT_EXPORTACAO'
    }
  },

  // Relatórios - mais permissivo
  relatorios: {
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 30, // 30 relatórios por 5 minutos
    message: {
      sucesso: false,
      erro: 'Muitos relatórios gerados. Aguarde alguns minutos.',
      codigo: 'RATE_LIMIT_RELATORIOS'
    }
  },

  // Solicitação de exclusão LGPD - muito restritivo
  exclusaoDados: {
    windowMs: 24 * 60 * 60 * 1000, // 24 horas
    max: 2, // 2 por dia
    message: {
      sucesso: false,
      erro: 'Muitas solicitações de exclusão. Aguarde 24 horas.',
      codigo: 'RATE_LIMIT_EXCLUSAO'
    }
  },

  // API geral - permissivo
  apiGeral: {
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 1000, // 1000 requisições por minuto
    message: {
      sucesso: false,
      erro: 'Muitas requisições. Aguarde um momento.',
      codigo: 'RATE_LIMIT_API'
    }
  },

  // Endpoints de localização (alta frequência)
  localizacao: {
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 600, // 600 requisições por minuto (10/seg)
    message: {
      sucesso: false,
      erro: 'Muitas requisições de localização.',
      codigo: 'RATE_LIMIT_LOCALIZACAO'
    }
  },

  // Comandos para dispositivos - moderado
  comandos: {
    windowMs: 5 * 60 * 1000, // 5 minutos
    max: 30, // 30 comandos por 5 minutos
    message: {
      sucesso: false,
      erro: 'Muitos comandos enviados. Aguarde alguns minutos.',
      codigo: 'RATE_LIMIT_COMANDOS'
    }
  },

  // Upload/Download de arquivos
  arquivos: {
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 20, // 20 uploads/downloads por hora
    message: {
      sucesso: false,
      erro: 'Muitas operações de arquivo. Aguarde.',
      codigo: 'RATE_LIMIT_ARQUIVOS'
    }
  },

  // Webhooks/Notificações externas
  webhooks: {
    windowMs: 1 * 60 * 1000, // 1 minuto
    max: 100, // 100 por minuto
    message: {
      sucesso: false,
      erro: 'Rate limit de webhooks excedido.',
      codigo: 'RATE_LIMIT_WEBHOOKS'
    }
  }
};

// ============ FUNÇÕES AUXILIARES ============

/**
 * Criar key generator customizado
 * Usa IP + User ID (se autenticado) para identificação mais precisa
 * Normaliza IPv6 para IPv4 quando possível
 */
function createKeyGenerator(prefix) {
  return (req) => {
    // Normalizar IP (remover prefixo IPv6-mapped IPv4)
    let ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    const userId = req.usuario?.id || 'anon';
    const orgId = req.organizacaoId || 'no-org';
    return `rl:${prefix}:${ip}:${userId}:${orgId}`;
  };
}

/**
 * Skip function para não limitar super admins em alguns casos
 */
function skipSuperAdmin(req) {
  return req.usuario?.tipo === 'super_admin';
}

/**
 * Handler quando rate limit é atingido (logging)
 */
function onLimitReached(req, res, options) {
  const ip = req.ip || req.connection.remoteAddress;
  const path = req.originalUrl || req.path;
  const userId = req.usuario?.id || 'anon';

  console.warn(`[RateLimit] 🚫 Limite atingido: IP=${ip} User=${userId} Path=${path}`);

  // Log de segurança para análise
  try {
    const prisma = require('../db/prisma');
    prisma.auditLog.create({
      data: {
        usuario_id: req.usuario?.id || null,
        organizacao_id: req.organizacaoId || null,
        acao: 'RATE_LIMIT_EXCEEDED',
        recurso: 'api',
        recurso_id: path,
        detalhes: JSON.stringify({
          ip,
          path,
          limite: options.max,
          janela_minutos: options.windowMs / 60000
        }),
        ip,
        user_agent: req.headers['user-agent']?.substring(0, 500),
        sucesso: false
      }
    }).catch(() => {}); // Ignora erros de log
  } catch (e) {
    // Ignora
  }
}

/**
 * Criar rate limiter com armazenamento em memória
 */
function createLimiter(config, keyPrefix) {
  const options = {
    windowMs: config.windowMs,
    max: config.max,
    message: config.message,
    standardHeaders: true, // Headers RateLimit-*
    legacyHeaders: false,  // Desabilita X-RateLimit-*
    keyGenerator: createKeyGenerator(keyPrefix),
    handler: (req, res, next, options) => {
      onLimitReached(req, res, options);
      res.status(429).json(config.message);
    },
    skip: (req) => {
      // Skip rate limiting para super_admin em endpoints não-críticos
      if (req.usuario?.tipo === 'super_admin' && !keyPrefix.includes('login')) {
        return true;
      }
      return false;
    },
    // Desabilitar validação estrita de IPv6 (keyGenerator já normaliza)
    validate: {
      xForwardedForHeader: false,
      trustProxy: false,
      keyGeneratorIpFallback: false,
      default: true
    }
  };

  return rateLimit(options);
}

// ============ EXPORTAR LIMITERS ============

// Limiters individuais
const loginLimiter = createLimiter(RATE_LIMITS.login, 'login');
const registroLimiter = createLimiter(RATE_LIMITS.registro, 'registro');
const resetSenhaLimiter = createLimiter(RATE_LIMITS.resetSenha, 'reset');
const exportacaoDadosLimiter = createLimiter(RATE_LIMITS.exportacaoDados, 'export');
const relatoriosLimiter = createLimiter(RATE_LIMITS.relatorios, 'relatorios');
const exclusaoDadosLimiter = createLimiter(RATE_LIMITS.exclusaoDados, 'exclusao');
const apiGeralLimiter = createLimiter(RATE_LIMITS.apiGeral, 'api');
const localizacaoLimiter = createLimiter(RATE_LIMITS.localizacao, 'loc');
const comandosLimiter = createLimiter(RATE_LIMITS.comandos, 'cmd');
const arquivosLimiter = createLimiter(RATE_LIMITS.arquivos, 'files');
const webhooksLimiter = createLimiter(RATE_LIMITS.webhooks, 'hooks');

/**
 * Middleware para aplicar rate limit dinâmico baseado na rota
 */
function dynamicRateLimiter(req, res, next) {
  // Usar originalUrl para ter o path completo
  const path = (req.originalUrl || req.path).toLowerCase();

  // Debug: descomentar para troubleshooting
  // console.log(`[RateLimit] Path: ${path}`);

  // Determinar qual limiter usar baseado no path
  if (path.includes('/api/auth/login')) {
    return loginLimiter(req, res, next);
  }
  if (path.includes('/auth/registro') || path.includes('/auth/register')) {
    return registroLimiter(req, res, next);
  }
  if (path.includes('/auth/reset') || path.includes('/auth/recuperar')) {
    return resetSenhaLimiter(req, res, next);
  }
  if (path.includes('/relatorios')) {
    return relatoriosLimiter(req, res, next);
  }
  if (path.includes('/lgpd/meus-dados') || path.includes('/motorista/meus-dados')) {
    return exportacaoDadosLimiter(req, res, next);
  }
  if (path.includes('/exportar')) {
    return relatoriosLimiter(req, res, next); // Usar limiter mais permissivo
  }
  if (path.includes('/lgpd/solicitar-exclusao') || path.includes('/processar-exclusao')) {
    return exclusaoDadosLimiter(req, res, next);
  }
  if (path.includes('/localizacao') || path.includes('/gps') || path.includes('/posicao')) {
    return localizacaoLimiter(req, res, next);
  }
  if (path.includes('/comando') || path.includes('/command')) {
    return comandosLimiter(req, res, next);
  }
  if (path.includes('/upload') || path.includes('/download') || path.includes('/arquivo')) {
    return arquivosLimiter(req, res, next);
  }
  if (path.includes('/webhook') || path.includes('/callback')) {
    return webhooksLimiter(req, res, next);
  }

  // Default: API geral
  return apiGeralLimiter(req, res, next);
}

/**
 * Criar limiter customizado para casos específicos
 */
function createCustomLimiter(windowMs, max, message, keyPrefix) {
  return createLimiter({ windowMs, max, message }, keyPrefix);
}

module.exports = {
  // Limiters específicos
  loginLimiter,
  registroLimiter,
  resetSenhaLimiter,
  exportacaoDadosLimiter,
  relatoriosLimiter,
  exclusaoDadosLimiter,
  apiGeralLimiter,
  localizacaoLimiter,
  comandosLimiter,
  arquivosLimiter,
  webhooksLimiter,

  // Middleware dinâmico
  dynamicRateLimiter,

  // Factory para limiters customizados
  createCustomLimiter,

  // Configurações (para referência)
  RATE_LIMITS
};
