/**
 * Rotas de Insights de IA
 *
 * Gerencia insights gerados automaticamente pela IA
 * Detecta padrões, tendências, melhorias e alertas
 */

const express = require('express');
const router = express.Router();
const insightService = require('../services/insight.service');

// ✅ Cache de insights (TTL 10s)
const insightsCache = new Map();
const INSIGHTS_CACHE_TTL = 10000;

// Helper para invalidar cache de uma organização
function invalidateOrgCache(orgId) {
  for (const key of insightsCache.keys()) {
    if (key.startsWith(`${orgId}:`) || key.startsWith(`resumo:${orgId}`)) {
      insightsCache.delete(key);
    }
  }
}

/**
 * GET /api/insights
 * Listar insights da organização
 * Query: ?lido=false&arquivado=false&tipo=motorista&prioridade=alta&limit=50&offset=0
 */
router.get('/', async (req, res) => {
  try {
    const { lido, arquivado, tipo, prioridade, limit, offset } = req.query;

    // Gerar chave de cache
    const cacheKey = `${req.organizacao_id}:${lido}:${arquivado}:${tipo}:${prioridade}:${limit}:${offset}`;
    const cached = insightsCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < INSIGHTS_CACHE_TTL) {
      return res.json(cached.data);
    }

    const resultado = await insightService.listar(req.organizacao_id, {
      lido: lido === 'true' ? true : lido === 'false' ? false : undefined,
      arquivado: arquivado === 'true',
      tipo,
      prioridade,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });

    const response = { sucesso: true, ...resultado };
    insightsCache.set(cacheKey, { data: response, time: Date.now() });

    res.json(response);
  } catch (error) {
    console.error('[Insights] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/insights/resumo
 * Resumo de insights para dashboard
 */
router.get('/resumo', async (req, res) => {
  try {
    // Cache para resumo (TTL 10s)
    const cacheKey = `resumo:${req.organizacao_id}`;
    const cached = insightsCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < INSIGHTS_CACHE_TTL) {
      return res.json(cached.data);
    }

    const resumo = await insightService.getResumo(req.organizacao_id);
    const response = { sucesso: true, ...resumo };
    insightsCache.set(cacheKey, { data: response, time: Date.now() });

    res.json(response);
  } catch (error) {
    console.error('[Insights] Erro ao buscar resumo:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/insights/gerar
 * Gerar novos insights (manual)
 */
router.post('/gerar', async (req, res) => {
  try {
    console.log(`[Insights] Gerando insights manual para org ${req.organizacao_id}`);

    const resultado = await insightService.gerarInsights(req.organizacao_id);

    res.json({
      sucesso: true,
      mensagem: `${resultado.gerados} insights gerados`,
      ...resultado
    });
  } catch (error) {
    console.error('[Insights] Erro ao gerar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/insights/:id
 * Buscar insight por ID
 */
router.get('/:id', async (req, res) => {
  try {
    const insight = await insightService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!insight) {
      return res.status(404).json({ sucesso: false, erro: 'Insight não encontrado' });
    }

    res.json({ sucesso: true, insight });
  } catch (error) {
    console.error('[Insights] Erro ao buscar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/insights/:id/lido
 * Marcar insight como lido
 */
router.post('/:id/lido', async (req, res) => {
  try {
    const insight = await insightService.marcarComoLido(
      parseInt(req.params.id),
      req.organizacao_id
    );

    invalidateOrgCache(req.organizacao_id);
    res.json({ sucesso: true, insight });
  } catch (error) {
    console.error('[Insights] Erro ao marcar como lido:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/insights/marcar-todos-lidos
 * Marcar todos os insights como lidos
 */
router.post('/marcar-todos-lidos', async (req, res) => {
  try {
    const resultado = await insightService.marcarTodosComoLidos(req.organizacao_id);
    invalidateOrgCache(req.organizacao_id);
    res.json({ sucesso: true, ...resultado });
  } catch (error) {
    console.error('[Insights] Erro ao marcar todos como lidos:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/insights/:id/arquivar
 * Arquivar insight
 */
router.post('/:id/arquivar', async (req, res) => {
  try {
    const insight = await insightService.arquivar(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, insight });
  } catch (error) {
    console.error('[Insights] Erro ao arquivar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
