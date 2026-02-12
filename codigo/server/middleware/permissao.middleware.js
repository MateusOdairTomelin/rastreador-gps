/**
 * Middleware de Verificação de Permissões
 *
 * Verifica se o usuário tem permissão para acessar determinado recurso/ação
 */

const perfilService = require('../services/perfil-permissao.service');

/**
 * Cria um middleware que verifica permissão específica
 * @param {string} modulo - Nome do módulo (dashboard, veiculos, etc.)
 * @param {string} acao - Nome da ação (listar, criar, editar, excluir, etc.)
 */
function verificarPermissao(modulo, acao) {
  return async (req, res, next) => {
    try {
      // Se não tiver usuário autenticado, bloquear
      // CORREÇÃO: usar req.usuario (definido pelo auth.middleware)
      if (!req.usuario || !req.usuario.id) {
        return res.status(401).json({
          sucesso: false,
          erro: 'Não autenticado'
        });
      }

      // Super admin sem perfil tem acesso total
      // Se tiver perfil, verificar a permissão
      const temPermissao = await perfilService.verificarPermissao(
        req.usuario.id,
        modulo,
        acao,
        req.usuario.organizacao_id
      );

      if (!temPermissao) {
        console.log(`[Permissão] Negada: usuário ${req.usuario.id} tentou ${acao} em ${modulo}`);
        return res.status(403).json({
          sucesso: false,
          erro: 'Você não tem permissão para realizar esta ação',
          modulo,
          acao
        });
      }

      next();
    } catch (error) {
      console.error('Erro ao verificar permissão:', error);
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao verificar permissão'
      });
    }
  };
}

/**
 * Middleware que verifica múltiplas permissões (qualquer uma satisfaz)
 * @param {Array} permissoes - Array de {modulo, acao}
 */
function verificarQualquerPermissao(permissoes) {
  return async (req, res, next) => {
    try {
      if (!req.usuario || !req.usuario.id) {
        return res.status(401).json({
          sucesso: false,
          erro: 'Não autenticado'
        });
      }

      for (const { modulo, acao } of permissoes) {
        const temPermissao = await perfilService.verificarPermissao(
          req.usuario.id,
          modulo,
          acao,
          req.usuario.organizacao_id
        );

        if (temPermissao) {
          return next();
        }
      }

      return res.status(403).json({
        sucesso: false,
        erro: 'Você não tem permissão para realizar esta ação'
      });
    } catch (error) {
      console.error('Erro ao verificar permissão:', error);
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao verificar permissão'
      });
    }
  };
}

/**
 * Middleware que verifica todas as permissões (todas devem ser satisfeitas)
 * @param {Array} permissoes - Array de {modulo, acao}
 */
function verificarTodasPermissoes(permissoes) {
  return async (req, res, next) => {
    try {
      if (!req.usuario || !req.usuario.id) {
        return res.status(401).json({
          sucesso: false,
          erro: 'Não autenticado'
        });
      }

      for (const { modulo, acao } of permissoes) {
        const temPermissao = await perfilService.verificarPermissao(
          req.usuario.id,
          modulo,
          acao,
          req.usuario.organizacao_id
        );

        if (!temPermissao) {
          return res.status(403).json({
            sucesso: false,
            erro: `Você não tem permissão para ${acao} em ${modulo}`
          });
        }
      }

      next();
    } catch (error) {
      console.error('Erro ao verificar permissão:', error);
      return res.status(500).json({
        sucesso: false,
        erro: 'Erro ao verificar permissão'
      });
    }
  };
}

/**
 * Injeta permissões do usuário no request para uso posterior
 */
async function injetarPermissoes(req, res, next) {
  try {
    if (req.usuario && req.usuario.id) {
      req.permissoes = await perfilService.obterPermissoesUsuario(
        req.usuario.id,
        req.usuario.organizacao_id
      );
    }
    next();
  } catch (error) {
    console.error('Erro ao injetar permissões:', error);
    next();
  }
}

module.exports = {
  verificarPermissao,
  verificarQualquerPermissao,
  verificarTodasPermissoes,
  injetarPermissoes
};
