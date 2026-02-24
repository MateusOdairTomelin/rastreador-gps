/**
 * Rotas de Tags de Veículos
 *
 * CRUD completo de tags + vinculação com veículos
 * Permite categorizar e filtrar veículos por tags
 */

const express = require('express');
const router = express.Router();
const tagService = require('../services/tag.service');

// ============ CRUD DE TAGS ============

/**
 * GET /api/tags
 * Listar tags da organização
 */
router.get('/', async (req, res) => {
  try {
    const { busca, ativo } = req.query;

    const tags = await tagService.listar(req.organizacao_id, {
      busca,
      ativo: ativo === 'false' ? false : ativo === 'true' ? true : undefined
    });

    res.json({ sucesso: true, tags });
  } catch (error) {
    console.error('[Tags] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/tags/estatisticas
 * Estatísticas das tags
 */
router.get('/estatisticas', async (req, res) => {
  try {
    const estatisticas = await tagService.getEstatisticas(req.organizacao_id);
    res.json({ sucesso: true, ...estatisticas });
  } catch (error) {
    console.error('[Tags] Erro ao buscar estatísticas:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/tags/:id
 * Buscar tag por ID
 */
router.get('/:id', async (req, res) => {
  try {
    const tag = await tagService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!tag) {
      return res.status(404).json({ sucesso: false, erro: 'Tag não encontrada' });
    }

    res.json({ sucesso: true, tag });
  } catch (error) {
    console.error('[Tags] Erro ao buscar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/tags
 * Criar nova tag
 */
router.post('/', async (req, res) => {
  try {
    const { nome, cor, descricao } = req.body;

    if (!nome || nome.trim().length < 2) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Nome da tag é obrigatório (mínimo 2 caracteres)'
      });
    }

    const tag = await tagService.criar(req.organizacao_id, {
      nome,
      cor,
      descricao
    }, req.usuario?.id);

    res.status(201).json({ sucesso: true, tag });
  } catch (error) {
    console.error('[Tags] Erro ao criar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/tags/:id
 * Atualizar tag
 */
router.put('/:id', async (req, res) => {
  try {
    const tag = await tagService.atualizar(
      parseInt(req.params.id),
      req.organizacao_id,
      req.body,
      req.usuario?.id
    );

    res.json({ sucesso: true, tag });
  } catch (error) {
    console.error('[Tags] Erro ao atualizar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/tags/:id
 * Excluir tag
 */
router.delete('/:id', async (req, res) => {
  try {
    await tagService.excluir(
      parseInt(req.params.id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json({ sucesso: true, mensagem: 'Tag excluída com sucesso' });
  } catch (error) {
    console.error('[Tags] Erro ao excluir:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ============ VINCULAÇÃO COM VEÍCULOS ============

/**
 * GET /api/tags/:id/veiculos
 * Listar veículos de uma tag
 */
router.get('/:id/veiculos', async (req, res) => {
  try {
    const veiculos = await tagService.buscarVeiculosPorTag(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, veiculos });
  } catch (error) {
    console.error('[Tags] Erro ao buscar veículos:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/tags/:id/vincular
 * Vincular tag a um veículo
 * Body: { veiculo_id: 123 }
 */
router.post('/:id/vincular', async (req, res) => {
  try {
    const { veiculo_id } = req.body;

    if (!veiculo_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'veiculo_id é obrigatório'
      });
    }

    const resultado = await tagService.vincularVeiculo(
      parseInt(req.params.id),
      parseInt(veiculo_id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Tags] Erro ao vincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/tags/:id/desvincular
 * Desvincular tag de um veículo
 * Body: { veiculo_id: 123 }
 */
router.post('/:id/desvincular', async (req, res) => {
  try {
    const { veiculo_id } = req.body;

    if (!veiculo_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'veiculo_id é obrigatório'
      });
    }

    const resultado = await tagService.desvincularVeiculo(
      parseInt(req.params.id),
      parseInt(veiculo_id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Tags] Erro ao desvincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ============ ROTAS PARA VEÍCULOS ============

/**
 * GET /api/tags/veiculo/:veiculo_id
 * Listar tags de um veículo
 */
router.get('/veiculo/:veiculo_id', async (req, res) => {
  try {
    const tags = await tagService.buscarTagsVeiculo(
      parseInt(req.params.veiculo_id),
      req.organizacao_id
    );

    res.json({ sucesso: true, tags });
  } catch (error) {
    console.error('[Tags] Erro ao buscar tags do veículo:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/tags/veiculo/:veiculo_id
 * Definir tags de um veículo (substitui todas)
 * Body: { tag_ids: [1, 2, 3] }
 */
router.put('/veiculo/:veiculo_id', async (req, res) => {
  try {
    const { tag_ids } = req.body;

    const resultado = await tagService.definirTagsVeiculo(
      parseInt(req.params.veiculo_id),
      tag_ids || [],
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Tags] Erro ao definir tags do veículo:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
