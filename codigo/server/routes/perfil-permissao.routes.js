/**
 * Rotas de Perfis de Permissão
 */

const express = require('express');
const router = express.Router();
const perfilService = require('../services/perfil-permissao.service');
const { MODULOS } = require('../services/perfil-permissao.service');
const { autenticar, apenasAdmin } = require('../middleware/auth.middleware');

// Cache de permissões por usuário (TTL 30s)
const permissoesCache = new Map();
const PERMISSOES_CACHE_TTL = 30000;

/**
 * GET /api/perfis-permissao/modulos
 * Listar módulos disponíveis
 */
router.get('/modulos', autenticar, (req, res) => {
  res.json({
    sucesso: true,
    modulos: MODULOS
  });
});

/**
 * GET /api/perfis-permissao
 * Listar perfis (da organização + sistema)
 */
router.get('/', autenticar, async (req, res) => {
  try {
    const organizacao_id = req.usuario.role === 'super_admin'
      ? req.query.organizacao_id ? parseInt(req.query.organizacao_id) : null
      : req.usuario.organizacao_id;

    const perfis = await perfilService.listar(organizacao_id);

    res.json({
      sucesso: true,
      perfis
    });
  } catch (error) {
    console.error('Erro ao listar perfis:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/perfis-permissao/:id
 * Buscar perfil por ID
 */
router.get('/:id', autenticar, async (req, res) => {
  try {
    const perfil = await perfilService.buscarPorId(parseInt(req.params.id));

    if (!perfil) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Perfil não encontrado'
      });
    }

    res.json({
      sucesso: true,
      perfil
    });
  } catch (error) {
    console.error('Erro ao buscar perfil:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/perfis-permissao
 * Criar novo perfil
 */
router.post('/', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { nome, descricao, permissoes, organizacao_id } = req.body;

    if (!nome || !permissoes) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Nome e permissões são obrigatórios'
      });
    }

    // Determinar organização
    const org_id = req.usuario.role === 'super_admin'
      ? organizacao_id || null  // Super admin pode criar perfil global
      : req.usuario.organizacao_id;

    const perfil = await perfilService.criar({
      nome,
      descricao,
      organizacao_id: org_id,
      permissoes,
      criado_por: req.usuario.id
    });

    res.status(201).json({
      sucesso: true,
      perfil
    });
  } catch (error) {
    console.error('Erro ao criar perfil:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/perfis-permissao/:id
 * Atualizar perfil
 */
router.put('/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const perfil = await perfilService.atualizar(
      parseInt(req.params.id),
      req.body
    );

    res.json({
      sucesso: true,
      perfil
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/perfis-permissao/:id
 * Excluir perfil
 */
router.delete('/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    await perfilService.excluir(parseInt(req.params.id));

    res.json({
      sucesso: true,
      mensagem: 'Perfil excluído com sucesso'
    });
  } catch (error) {
    console.error('Erro ao excluir perfil:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/perfis-permissao/:id/usuarios/:usuarioId
 * Associar perfil a um usuário
 */
router.post('/:id/usuarios/:usuarioId', autenticar, apenasAdmin, async (req, res) => {
  try {
    const perfil_id = parseInt(req.params.id);
    const usuario_id = parseInt(req.params.usuarioId);
    const organizacao_id = req.body.organizacao_id || null;

    const associacao = await perfilService.associarUsuario(
      usuario_id,
      perfil_id,
      organizacao_id
    );

    res.json({
      sucesso: true,
      associacao
    });
  } catch (error) {
    console.error('Erro ao associar perfil:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/perfis-permissao/:id/usuarios/:usuarioId
 * Remover perfil de um usuário
 */
router.delete('/:id/usuarios/:usuarioId', autenticar, apenasAdmin, async (req, res) => {
  try {
    const perfil_id = parseInt(req.params.id);
    const usuario_id = parseInt(req.params.usuarioId);
    const organizacao_id = req.query.organizacao_id
      ? parseInt(req.query.organizacao_id)
      : null;

    const resultado = await perfilService.removerUsuario(
      usuario_id,
      perfil_id,
      organizacao_id
    );

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('Erro ao remover perfil:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/perfis-permissao/usuarios/:usuarioId/perfis
 * Remover todos os perfis de um usuário
 */
router.delete('/usuarios/:usuarioId/perfis', autenticar, apenasAdmin, async (req, res) => {
  try {
    const usuario_id = parseInt(req.params.usuarioId);

    const resultado = await perfilService.removerTodosPerfisUsuario(usuario_id);

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('Erro ao remover perfis:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/perfis-permissao/usuarios/:usuarioId
 * Listar perfis de um usuário
 */
router.get('/usuarios/:usuarioId', autenticar, async (req, res) => {
  try {
    const usuario_id = parseInt(req.params.usuarioId);
    const organizacao_id = req.query.organizacao_id
      ? parseInt(req.query.organizacao_id)
      : null;

    const perfis = await perfilService.listarPerfisUsuario(
      usuario_id,
      organizacao_id
    );

    res.json({
      sucesso: true,
      perfis
    });
  } catch (error) {
    console.error('Erro ao listar perfis do usuário:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/perfis-permissao/usuarios/:usuarioId/permissoes
 * Obter permissões consolidadas de um usuário
 */
router.get('/usuarios/:usuarioId/permissoes', autenticar, async (req, res) => {
  try {
    const usuario_id = parseInt(req.params.usuarioId);
    const organizacao_id = req.query.organizacao_id
      ? parseInt(req.query.organizacao_id)
      : null;

    const permissoes = await perfilService.obterPermissoesUsuario(
      usuario_id,
      organizacao_id
    );

    res.json({
      sucesso: true,
      permissoes
    });
  } catch (error) {
    console.error('Erro ao obter permissões:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/perfis-permissao/me/permissoes
 * Obter minhas permissões
 */
router.get('/me/permissoes', autenticar, async (req, res) => {
  try {
    const cacheKey = `${req.usuario.id}:${req.usuario.organizacao_id}`;
    const cached = permissoesCache.get(cacheKey);

    if (cached && (Date.now() - cached.time) < PERMISSOES_CACHE_TTL) {
      return res.json(cached.data);
    }

    const permissoes = await perfilService.obterPermissoesUsuario(
      req.usuario.id,
      req.usuario.organizacao_id
    );

    const response = {
      sucesso: true,
      permissoes
    };

    permissoesCache.set(cacheKey, { data: response, time: Date.now() });
    res.json(response);
  } catch (error) {
    console.error('Erro ao obter permissões:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

module.exports = router;
