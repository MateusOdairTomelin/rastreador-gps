/**
 * Rotas de Grupos
 * Gerenciamento de grupos de tags para controle de acesso
 */

const express = require('express');
const router = express.Router();
const grupoService = require('../services/grupo.service');
const { autenticar } = require('../middleware/auth.middleware');
const { tenantContext } = require('../middleware/tenant.middleware');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// Todas as rotas requerem autenticação e contexto de tenant
router.use(autenticar);
router.use(tenantContext);

/**
 * GET /api/grupos
 * Listar grupos da organização
 */
router.get('/', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const grupos = await grupoService.listar(req.organizacao_id);
    res.json({ sucesso: true, grupos });
  } catch (error) {
    console.error('[Grupos] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/grupos/:id
 * Buscar grupo por ID
 */
router.get('/:id', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const grupo = await grupoService.buscarPorId(req.params.id, req.organizacao_id);
    res.json({ sucesso: true, grupo });
  } catch (error) {
    console.error('[Grupos] Erro ao buscar:', error.message);
    res.status(404).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/grupos
 * Criar novo grupo
 */
router.post('/', verificarPermissao('veiculos', 'criar'), async (req, res) => {
  try {
    const grupo = await grupoService.criar(req.body, req.organizacao_id);
    res.status(201).json({ sucesso: true, grupo });
  } catch (error) {
    console.error('[Grupos] Erro ao criar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/grupos/:id
 * Atualizar grupo
 */
router.put('/:id', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const grupo = await grupoService.atualizar(req.params.id, req.body, req.organizacao_id);
    res.json({ sucesso: true, grupo });
  } catch (error) {
    console.error('[Grupos] Erro ao atualizar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/grupos/:id
 * Excluir grupo
 */
router.delete('/:id', verificarPermissao('veiculos', 'excluir'), async (req, res) => {
  try {
    const resultado = await grupoService.excluir(req.params.id, req.organizacao_id);
    res.json(resultado);
  } catch (error) {
    console.error('[Grupos] Erro ao excluir:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/grupos/:id/tags
 * Vincular tags ao grupo
 */
router.post('/:id/tags', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const { tagIds } = req.body;
    if (!tagIds || !Array.isArray(tagIds)) {
      return res.status(400).json({ sucesso: false, erro: 'tagIds deve ser um array' });
    }
    const resultado = await grupoService.vincularTags(req.params.id, tagIds, req.organizacao_id);
    res.json(resultado);
  } catch (error) {
    console.error('[Grupos] Erro ao vincular tags:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/grupos/tags/:tagId
 * Desvincular tag de grupo
 */
router.delete('/tags/:tagId', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const resultado = await grupoService.desvincularTag(req.params.tagId, req.organizacao_id);
    res.json(resultado);
  } catch (error) {
    console.error('[Grupos] Erro ao desvincular tag:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ==================== PERMISSÕES DE USUÁRIO ====================

/**
 * GET /api/grupos/usuario/:usuarioId/permissoes
 * Obter permissões de grupos/tags de um usuário
 */
router.get('/usuario/:usuarioId/permissoes', verificarPermissao('usuarios', 'listar'), async (req, res) => {
  try {
    const permissoes = await grupoService.obterPermissoesUsuario(req.params.usuarioId, req.organizacao_id);
    res.json({ sucesso: true, ...permissoes });
  } catch (error) {
    console.error('[Grupos] Erro ao obter permissões:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/grupos/usuario/:usuarioId/permissoes
 * Definir permissões de grupos/tags para um usuário
 * Body: { grupos: [{ grupoId: 1, tagIds: [1, 2, 3] }] }
 */
router.put('/usuario/:usuarioId/permissoes', verificarPermissao('usuarios', 'editar'), async (req, res) => {
  try {
    const { grupos } = req.body;
    const resultado = await grupoService.definirPermissoesUsuario(
      req.params.usuarioId,
      grupos,
      req.organizacao_id
    );
    res.json({ sucesso: true, ...resultado });
  } catch (error) {
    console.error('[Grupos] Erro ao definir permissões:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/grupos/minhas-tags
 * Obter tags que o usuário logado pode ver (para filtros)
 */
router.get('/minhas-tags', async (req, res) => {
  try {
    const tagIds = await grupoService.obterTagsPermitidas(req.usuario.id);
    res.json({
      sucesso: true,
      acessoTotal: tagIds === null,
      tagIds: tagIds || []
    });
  } catch (error) {
    console.error('[Grupos] Erro ao obter tags permitidas:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
