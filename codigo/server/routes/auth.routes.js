const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const authService = require('../services/auth.service');
const redisService = require('../services/redis.service');
const { autenticar, apenasAdmin, extrairMetadados } = require('../middleware/auth.middleware');
const { loginLimiter, registroLimiter, resetSenhaLimiter } = require('../middleware/rate-limit.middleware');

/**
 * POST /api/auth/registro
 * Registrar novo usuário (apenas admin pode criar novos usuários)
 */
router.post('/registro', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { email, senha, nome, role } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!email || !senha || !nome) {
      return res.status(400).json({
        error: 'Email, senha e nome são obrigatórios',
        code: 'MISSING_FIELDS'
      });
    }

    // Validar email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Email inválido',
        code: 'INVALID_EMAIL'
      });
    }

    // Validar role
    const rolesValidas = ['admin', 'operador', 'visualizador'];
    if (role && !rolesValidas.includes(role)) {
      return res.status(400).json({
        error: `Role inválida. Valores permitidos: ${rolesValidas.join(', ')}`,
        code: 'INVALID_ROLE'
      });
    }

    const usuario = await authService.registrar(email, senha, nome, role || 'operador');

    res.status(201).json({
      success: true,
      usuario
    });

  } catch (error) {
    console.error('Erro no registro:', error.message);
    res.status(400).json({
      error: error.message,
      code: 'REGISTRATION_ERROR'
    });
  }
});

/**
 * POST /api/auth/registro-inicial
 * Criar primeiro usuário admin (apenas se não existir nenhum usuário)
 */
router.post('/registro-inicial', registroLimiter, async (req, res) => {
  try {
    const { email, senha, nome } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    // Verificar se já existe algum usuário
    const count = await prisma.usuario.count();

    if (count > 0) {
      return res.status(403).json({
        error: 'Sistema já possui usuários cadastrados. Use a rota de registro padrão.',
        code: 'USERS_EXIST'
      });
    }

    if (!email || !senha || !nome) {
      return res.status(400).json({
        error: 'Email, senha e nome são obrigatórios',
        code: 'MISSING_FIELDS'
      });
    }

    const usuario = await authService.registrar(email, senha, nome, 'admin');

    res.status(201).json({
      success: true,
      message: 'Administrador inicial criado com sucesso',
      usuario
    });

  } catch (error) {
    console.error('Erro no registro inicial:', error.message);
    res.status(400).json({
      error: error.message,
      code: 'REGISTRATION_ERROR'
    });
  }
});

/**
 * POST /api/auth/login
 * Autenticar usuário
 */
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, senha } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!email || !senha) {
      return res.status(400).json({
        error: 'Email e senha são obrigatórios',
        code: 'MISSING_CREDENTIALS'
      });
    }

    const resultado = await authService.login(email, senha, ip, userAgent);

    res.json({
      success: true,
      ...resultado
    });

  } catch (error) {
    console.error('Erro no login:', error.message);
    res.status(401).json({
      error: error.message,
      code: 'LOGIN_ERROR'
    });
  }
});

/**
 * POST /api/auth/refresh
 * Renovar access token usando refresh token
 * Preserva organização do token anterior (se disponível)
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!refreshToken) {
      return res.status(400).json({
        error: 'Refresh token é obrigatório',
        code: 'MISSING_REFRESH_TOKEN'
      });
    }

    // Tentar extrair dados de organização do token anterior (mesmo expirado)
    let tokenAnterior = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
        try {
          // Decodificar sem verificar expiração para obter organizacao_id
          const jwt = require('jsonwebtoken');
          const decoded = jwt.decode(parts[1]);
          if (decoded && decoded.organizacao_id) {
            tokenAnterior = {
              organizacao_id: decoded.organizacao_id,
              role_org: decoded.role_org
            };
          }
        } catch (e) {
          // Ignorar erro de decodificação - vai usar fallback
        }
      }
    }

    const tokens = await authService.refreshAccessToken(refreshToken, ip, userAgent, tokenAnterior);

    res.json({
      success: true,
      ...tokens
    });

  } catch (error) {
    console.error('Erro no refresh:', error.message);
    res.status(401).json({
      error: error.message,
      code: 'REFRESH_ERROR'
    });
  }
});

/**
 * POST /api/auth/logout
 * Logout - revogar refresh token e blacklist access token
 * ✅ Integrado com Redis para invalidação imediata
 */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    // Revogar refresh token no banco
    if (refreshToken) {
      await authService.logout(refreshToken, ip, userAgent);
    }

    // ✅ Blacklist do access token no Redis (invalidação imediata)
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) {
        const accessToken = parts[1];
        // TTL de 15 minutos (tempo de vida do access token)
        await redisService.blacklistToken(accessToken, 900);
      }
    }

    res.json({
      success: true,
      message: 'Logout realizado com sucesso'
    });

  } catch (error) {
    console.error('Erro no logout:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'LOGOUT_ERROR'
    });
  }
});

/**
 * POST /api/auth/logout-all
 * Logout de todos os dispositivos
 * ✅ Integrado com Redis para invalidação imediata de todas as sessões
 */
router.post('/logout-all', autenticar, async (req, res) => {
  try {
    const { ip, userAgent } = extrairMetadados(req);

    // Revogar todos os refresh tokens no banco
    await authService.logoutAll(req.usuario.id, ip, userAgent);

    // ✅ Invalidar todos os tokens do usuário no Redis
    await redisService.invalidateUserTokens(req.usuario.id);

    res.json({
      success: true,
      message: 'Logout realizado em todos os dispositivos'
    });

  } catch (error) {
    console.error('Erro no logout-all:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'LOGOUT_ERROR'
    });
  }
});

/**
 * GET /api/auth/me
 * Retorna dados do usuário autenticado
 */
router.get('/me', autenticar, async (req, res) => {
  try {
    const usuario = await authService.buscarUsuario(req.usuario.id);

    if (!usuario) {
      return res.status(404).json({
        error: 'Usuário não encontrado',
        code: 'USER_NOT_FOUND'
      });
    }

    // Incluir informações de organização atual
    const organizacoes = await authService.buscarOrganizacoesDoUsuario(req.usuario.id);

    // Buscar dados completos da organização atual (incluindo logo_url para white-label)
    const orgAtual = organizacoes.find(o => o.id === req.usuario.organizacao_id);

    res.json({
      success: true,
      usuario: {
        ...usuario,
        organizacao_atual: orgAtual || null
      },
      organizacoes
    });

  } catch (error) {
    console.error('Erro ao buscar usuário:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'USER_ERROR'
    });
  }
});

/**
 * GET /api/auth/organizacoes
 * Lista organizações do usuário autenticado
 */
router.get('/organizacoes', autenticar, async (req, res) => {
  try {
    const organizacoes = await authService.buscarOrganizacoesDoUsuario(req.usuario.id);

    // Buscar dados completos da organização atual (incluindo logo_url para white-label)
    const orgAtual = organizacoes.find(o => o.id === req.usuario.organizacao_id);

    res.json({
      success: true,
      organizacoes,
      organizacao_atual: orgAtual || null
    });

  } catch (error) {
    console.error('Erro ao buscar organizações:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'ORGS_ERROR'
    });
  }
});

/**
 * POST /api/auth/selecionar-organizacao
 * Seleciona uma organização e retorna novo token
 */
router.post('/selecionar-organizacao', autenticar, async (req, res) => {
  try {
    const { organizacao_id } = req.body;

    if (!organizacao_id) {
      return res.status(400).json({
        error: 'ID da organização é obrigatório',
        code: 'MISSING_ORG_ID'
      });
    }

    const resultado = await authService.selecionarOrganizacao(
      req.usuario.id,
      parseInt(organizacao_id)
    );

    res.json({
      success: true,
      accessToken: resultado.accessToken,
      refreshToken: resultado.refreshToken,
      organizacao_atual: resultado.organizacao, // Renomear para frontend
      role: resultado.role
    });

  } catch (error) {
    console.error('Erro ao selecionar organização:', error.message);
    res.status(400).json({
      error: error.message,
      code: 'SELECT_ORG_ERROR'
    });
  }
});

/**
 * POST /api/auth/forgot-password
 * Solicitar recuperação de senha
 */
router.post('/forgot-password', resetSenhaLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!email) {
      return res.status(400).json({
        error: 'Email é obrigatório',
        code: 'MISSING_EMAIL'
      });
    }

    // Validar formato do email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Email inválido',
        code: 'INVALID_EMAIL'
      });
    }

    await authService.solicitarRecuperacaoSenha(email, ip, userAgent);

    // Sempre retornar sucesso (segurança - não revelar se email existe)
    res.json({
      success: true,
      message: 'Se o email estiver cadastrado, você receberá um link de recuperação.'
    });

  } catch (error) {
    console.error('Erro ao solicitar recuperação:', error.message);
    // Retornar sucesso genérico para não revelar informações
    res.json({
      success: true,
      message: 'Se o email estiver cadastrado, você receberá um link de recuperação.'
    });
  }
});

/**
 * POST /api/auth/reset-password
 * Redefinir senha usando token de recuperação
 */
router.post('/reset-password', resetSenhaLimiter, async (req, res) => {
  try {
    const { token, novaSenha } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!token) {
      return res.status(400).json({
        error: 'Token é obrigatório',
        code: 'MISSING_TOKEN'
      });
    }

    if (!novaSenha) {
      return res.status(400).json({
        error: 'Nova senha é obrigatória',
        code: 'MISSING_PASSWORD'
      });
    }

    if (novaSenha.length < 8) {
      return res.status(400).json({
        error: 'Senha deve ter no mínimo 8 caracteres',
        code: 'PASSWORD_TOO_SHORT'
      });
    }

    await authService.redefinirSenha(token, novaSenha, ip, userAgent);

    res.json({
      success: true,
      message: 'Senha redefinida com sucesso. Faça login com sua nova senha.'
    });

  } catch (error) {
    console.error('Erro ao redefinir senha:', error.message);
    res.status(400).json({
      error: error.message,
      code: 'RESET_PASSWORD_ERROR'
    });
  }
});

/**
 * GET /api/auth/validate-reset-token
 * Validar token de recuperação de senha
 */
router.get('/validate-reset-token', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        valid: false,
        error: 'Token é obrigatório'
      });
    }

    const result = await authService.validarTokenReset(token);
    res.json(result);

  } catch (error) {
    console.error('Erro ao validar token:', error.message);
    res.status(500).json({
      valid: false,
      error: 'Erro ao validar token'
    });
  }
});

/**
 * PUT /api/auth/senha
 * Alterar senha do usuário autenticado
 */
router.put('/senha', autenticar, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({
        error: 'Senha atual e nova senha são obrigatórias',
        code: 'MISSING_PASSWORDS'
      });
    }

    await authService.alterarSenha(req.usuario.id, senhaAtual, novaSenha, ip, userAgent);

    res.json({
      success: true,
      message: 'Senha alterada com sucesso'
    });

  } catch (error) {
    console.error('Erro ao alterar senha:', error.message);
    res.status(400).json({
      error: error.message,
      code: 'PASSWORD_ERROR'
    });
  }
});

/**
 * GET /api/auth/usuarios
 * Listar usuários (filtrado por organização se não for super_admin)
 */
router.get('/usuarios', autenticar, apenasAdmin, async (req, res) => {
  try {
    const isSuperAdmin = req.usuario.role === 'super_admin';

    // Obter IDs das organizações do usuário logado
    let organizacaoIds = [];
    if (!isSuperAdmin && req.usuario.id) {
      const associacoes = await prisma.usuarioOrganizacao.findMany({
        where: { usuario_id: req.usuario.id },
        select: { organizacao_id: true }
      });
      organizacaoIds = associacoes.map(a => a.organizacao_id);
    }

    const usuarios = await authService.listarUsuarios({
      isSuperAdmin,
      organizacaoIds
    });

    res.json({
      success: true,
      usuarios
    });

  } catch (error) {
    console.error('Erro ao listar usuários:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'LIST_ERROR'
    });
  }
});

/**
 * DELETE /api/auth/usuarios/:id
 * Desativar usuário (apenas admin)
 */
router.delete('/usuarios/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const usuarioId = parseInt(req.params.id);
    const { ip, userAgent } = extrairMetadados(req);

    if (usuarioId === req.usuario.id) {
      return res.status(400).json({
        error: 'Não é possível desativar seu próprio usuário',
        code: 'SELF_DEACTIVATION'
      });
    }

    await authService.desativarUsuario(usuarioId, req.usuario.id, ip, userAgent);

    res.json({
      success: true,
      message: 'Usuário desativado com sucesso'
    });

  } catch (error) {
    console.error('Erro ao desativar usuário:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'DEACTIVATION_ERROR'
    });
  }
});

/**
 * GET /api/auth/auditoria
 * Buscar logs de auditoria (apenas admin)
 * - Super admin sem perfil restritivo vê todos os logs
 * - Super admin com perfil restritivo vê apenas das organizações definidas no perfil
 * - Admin normal vê apenas da sua organização
 */
router.get('/auditoria', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { usuarioId, acao, dataInicio, dataFim, limite, organizacaoId } = req.query;

    const perfilService = require('../services/perfil-permissao.service');

    // Obter organizações permitidas baseado no perfil do usuário
    const organizacoesPermitidas = await perfilService.obterOrganizacoesPermitidas(req.usuario.id);

    // Determinar filtro de organização
    let filtroOrgId = null;
    let filtroOrgIds = null;

    if (organizacoesPermitidas === null) {
      // Acesso total (super_admin sem restrição)
      // Se passou organizacaoId no query, filtra por ela
      if (organizacaoId) {
        filtroOrgId = parseInt(organizacaoId);
      }
      // Se não passou, não filtra (vê tudo)
    } else if (organizacoesPermitidas.length > 0) {
      // Acesso restrito a organizações específicas
      if (organizacaoId) {
        // Verificar se a organização solicitada está permitida
        const orgIdInt = parseInt(organizacaoId);
        if (organizacoesPermitidas.includes(orgIdInt)) {
          filtroOrgId = orgIdInt;
        } else {
          return res.status(403).json({
            error: 'Você não tem permissão para ver logs desta organização',
            code: 'ORG_NOT_ALLOWED'
          });
        }
      } else {
        // Filtrar por todas as organizações permitidas
        filtroOrgIds = organizacoesPermitidas;
      }
    } else {
      // Sem acesso (não deveria chegar aqui por causa do apenasAdmin)
      return res.status(403).json({
        error: 'Sem permissão para ver logs de auditoria',
        code: 'NO_PERMISSION'
      });
    }

    const logs = await authService.buscarAuditoria({
      usuarioId: usuarioId ? parseInt(usuarioId) : undefined,
      organizacaoId: filtroOrgId,
      organizacaoIds: filtroOrgIds,
      acao,
      dataInicio,
      dataFim,
      limite: limite ? parseInt(limite) : 100
    });

    res.json({
      success: true,
      logs,
      // Retornar informação de filtro para o frontend
      filtro: {
        organizacoesPermitidas: organizacoesPermitidas,
        acessoTotal: organizacoesPermitidas === null
      }
    });

  } catch (error) {
    console.error('Erro ao buscar auditoria:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'AUDIT_ERROR'
    });
  }
});

/**
 * POST /api/auth/limpar-tokens
 * Limpar tokens expirados (apenas admin)
 */
router.post('/limpar-tokens', autenticar, apenasAdmin, async (req, res) => {
  try {
    const count = await authService.limparTokensExpirados();

    res.json({
      success: true,
      message: `${count} tokens removidos`
    });

  } catch (error) {
    console.error('Erro ao limpar tokens:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'CLEANUP_ERROR'
    });
  }
});

/**
 * GET /api/auth/csrf-token
 * Obter novo CSRF token (usuário autenticado)
 */
router.get('/csrf-token', autenticar, async (req, res) => {
  try {
    const { generateCSRFToken } = require('../middleware/csrf.middleware');
    const csrfToken = generateCSRFToken(req.usuario.id);

    res.json({
      success: true,
      csrfToken
    });

  } catch (error) {
    console.error('Erro ao gerar CSRF token:', error.message);
    res.status(500).json({
      error: error.message,
      code: 'CSRF_ERROR'
    });
  }
});

module.exports = router;
