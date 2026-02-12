/**
 * Middleware de Multi-Tenant
 * Gerencia o contexto de organização para todas as requisições
 */

const prisma = require('../db/prisma');

/**
 * Middleware principal de contexto de tenant
 * Deve ser usado APÓS o middleware de autenticação
 */
function tenantContext(req, res, next) {
  // Se não há usuário autenticado, não há tenant
  if (!req.usuario) {
    req.tenant = null;
    req.tenantFilter = {};
    return next();
  }

  // Super admin pode acessar qualquer tenant via header
  if (req.usuario.role === 'super_admin') {
    const targetTenant = req.headers['x-tenant-id'];
    req.tenant = {
      id: targetTenant ? parseInt(targetTenant) : req.usuario.organizacao_id,
      slug: req.usuario.organizacao_slug,
      isSuperAdmin: true
    };
  } else {
    // Usuários normais só acessam sua própria organização
    req.tenant = {
      id: req.usuario.organizacao_id,
      slug: req.usuario.organizacao_slug,
      isSuperAdmin: false
    };
  }

  // Verificar se há organização selecionada
  if (!req.tenant.id && req.usuario.role !== 'super_admin') {
    return res.status(403).json({
      sucesso: false,
      erro: 'Nenhuma organização selecionada. Faça login novamente.'
    });
  }

  // Injetar filtro padrão para Prisma
  req.tenantFilter = req.tenant.id
    ? { organizacao_id: req.tenant.id }
    : {};

  // Compatibilidade: definir req.organizacao_id diretamente
  req.organizacao_id = req.tenant.id;

  next();
}

/**
 * Middleware para verificar se usuário tem permissão na organização atual
 * @param {...string} rolesPermitidas - Roles permitidas (proprietario, admin, operador, visualizador)
 */
function verificarRoleOrg(...rolesPermitidas) {
  return (req, res, next) => {
    if (!req.usuario) {
      return res.status(401).json({
        sucesso: false,
        erro: 'Não autenticado'
      });
    }

    // Super admin tem acesso total
    if (req.usuario.role === 'super_admin') {
      return next();
    }

    // Verificar role na organização
    const roleOrg = req.usuario.role_org;
    if (!roleOrg) {
      return res.status(403).json({
        sucesso: false,
        erro: 'Sem permissão nesta organização'
      });
    }

    // Hierarquia de roles: proprietario > admin > operador > visualizador
    const hierarquia = {
      'proprietario': 4,
      'admin': 3,
      'operador': 2,
      'visualizador': 1
    };

    const nivelUsuario = hierarquia[roleOrg] || 0;
    const nivelMinimo = Math.min(...rolesPermitidas.map(r => hierarquia[r] || 0));

    if (nivelUsuario < nivelMinimo) {
      return res.status(403).json({
        sucesso: false,
        erro: 'Permissão insuficiente para esta ação'
      });
    }

    next();
  };
}

/**
 * Middleware para verificar se recurso pertence ao tenant
 * Usa para validar ownership de recursos específicos
 */
function verificarOwnership(model, idParam = 'id') {
  return async (req, res, next) => {
    if (!req.tenant || !req.tenant.id) {
      return res.status(403).json({
        sucesso: false,
        erro: 'Contexto de organização não encontrado'
      });
    }

    // Super admin pode acessar qualquer recurso
    if (req.tenant.isSuperAdmin && req.headers['x-tenant-id']) {
      return next();
    }

    const resourceId = req.params[idParam];
    if (!resourceId) {
      return next();
    }

    try {
      // Verificar se o recurso pertence à organização
      // Isso funciona para dispositivo e outros modelos com organizacao_id
      const recurso = await prisma[model].findFirst({
        where: {
          id: parseInt(resourceId),
          organizacao_id: req.tenant.id
        }
      });

      if (!recurso) {
        return res.status(404).json({
          sucesso: false,
          erro: 'Recurso não encontrado ou sem permissão'
        });
      }

      // Anexar recurso à requisição para uso posterior
      req.recurso = recurso;
      next();
    } catch (error) {
      console.error('Erro ao verificar ownership:', error);
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao verificar permissões'
      });
    }
  };
}

/**
 * Middleware para verificar limites do plano
 * @param {string} tipo - Tipo de limite ('dispositivos', 'usuarios')
 */
function verificarLimitePlano(tipo) {
  return async (req, res, next) => {
    if (!req.tenant || !req.tenant.id) {
      return next();
    }

    try {
      const org = await prisma.organizacao.findUnique({
        where: { id: req.tenant.id },
        include: { plano: true }
      });

      if (!org || !org.plano) {
        return next();
      }

      let contagem, limite;

      if (tipo === 'dispositivos') {
        contagem = await prisma.dispositivo.count({
          where: { organizacao_id: req.tenant.id }
        });
        limite = org.plano.max_dispositivos;
      } else if (tipo === 'usuarios') {
        contagem = await prisma.usuarioOrganizacao.count({
          where: { organizacao_id: req.tenant.id }
        });
        limite = org.plano.max_usuarios;
      }

      if (contagem >= limite) {
        return res.status(403).json({
          sucesso: false,
          erro: `Limite de ${tipo} atingido (${contagem}/${limite}). Faça upgrade do plano.`
        });
      }

      next();
    } catch (error) {
      console.error('Erro ao verificar limite do plano:', error);
      next();
    }
  };
}

module.exports = {
  tenantContext,
  verificarRoleOrg,
  verificarOwnership,
  verificarLimitePlano
};
