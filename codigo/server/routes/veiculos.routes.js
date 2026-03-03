/**
 * Rotas de Veículos
 *
 * CRUD completo + vinculação com dispositivos (rastreadores)
 * Permite trocar rastreador sem perder histórico do veículo
 */

const express = require('express');
const router = express.Router();
const veiculoService = require('../services/veiculo.service');
const consultaPlacaService = require('../services/consulta-placa.service');
const grupoService = require('../services/grupo.service');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// Cache de veículos (TTL 5s)
const veiculosCache = new Map();
const VEICULOS_CACHE_TTL = 5000;

// Autenticação já é aplicada no index.js via: router.use('/veiculos', autenticar, tenantContext, veiculosRoutes)

// ============ CONSULTA DE PLACA (API EXTERNA) ============
// IMPORTANTE: Esta rota DEVE vir ANTES de /:id para não conflitar

/**
 * GET /api/veiculos/consulta-placa/:placa
 * Consulta dados do veículo em API externa pela placa
 * Retorna: marca, modelo, ano, cor, etc.
 */
router.get('/consulta-placa/:placa', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const { placa } = req.params;

    if (!placa || placa.length < 7) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Placa inválida. Use formato ABC1234 ou ABC1D23'
      });
    }

    console.log(`[Veículos] Consultando placa ${placa} para org ${req.organizacao_id}`);

    const dados = await consultaPlacaService.consultarPlaca(placa);

    if (!dados) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Veículo não encontrado na base de dados'
      });
    }

    res.json({
      sucesso: true,
      dados
    });
  } catch (error) {
    console.error('[Veículos] Erro ao consultar placa:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos
 * Listar veículos da organização
 * Filtra por tags permitidas do usuário (se houver restrições)
 */
router.get('/', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const { busca, page, limit } = req.query;

    // Obter tags permitidas do usuário (null = acesso total)
    let tagIdsPermitidas = null;
    if (req.usuario?.id) {
      tagIdsPermitidas = await grupoService.obterTagsPermitidas(req.usuario.id);
    }

    // Cache key: org + busca + page + limit + tags
    const tagsKey = tagIdsPermitidas ? tagIdsPermitidas.sort().join(',') : 'all';
    const cacheKey = `${req.organizacao_id}:${busca || ''}:${page || 1}:${limit || 50}:${tagsKey}`;
    const cached = veiculosCache.get(cacheKey);
    if (cached && (Date.now() - cached.time) < VEICULOS_CACHE_TTL) {
      return res.json(cached.data);
    }

    const resultado = await veiculoService.listar(req.organizacao_id, {
      busca,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      tagIds: tagIdsPermitidas  // null = sem filtro, array = filtrar por essas tags
    });

    const response = {
      sucesso: true,
      ...resultado
    };

    veiculosCache.set(cacheKey, { data: response, time: Date.now() });
    res.json(response);
  } catch (error) {
    console.error('[Veículos] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/:id
 * Buscar veículo por ID
 */
router.get('/:id', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const veiculo = await veiculoService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!veiculo) {
      return res.status(404).json({ sucesso: false, erro: 'Veículo não encontrado' });
    }

    res.json({ sucesso: true, veiculo });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/placa/:placa
 * Buscar veículo por placa
 */
router.get('/placa/:placa', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const veiculo = await veiculoService.buscarPorPlaca(
      req.params.placa,
      req.organizacao_id
    );

    if (!veiculo) {
      return res.status(404).json({ sucesso: false, erro: 'Veículo não encontrado' });
    }

    res.json({ sucesso: true, veiculo });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar por placa:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/veiculos
 * Criar novo veículo
 */
router.post('/', verificarPermissao('veiculos', 'criar'), async (req, res) => {
  try {
    const { placa, modelo, marca, ano, cor, tipo_veiculo, chassi, renavam } = req.body;

    if (!placa || placa.trim().length < 7) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Placa é obrigatória (mínimo 7 caracteres)'
      });
    }

    const veiculo = await veiculoService.criar(req.organizacao_id, {
      placa,
      modelo,
      marca,
      ano,
      cor,
      tipo_veiculo,
      chassi,
      renavam
    }, req.usuario?.id);

    res.status(201).json({ sucesso: true, veiculo });
  } catch (error) {
    console.error('[Veículos] Erro ao criar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/veiculos/:id
 * Atualizar veículo
 */
router.put('/:id', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const veiculo = await veiculoService.atualizar(
      parseInt(req.params.id),
      req.organizacao_id,
      req.body,
      req.usuario?.id
    );

    res.json({ sucesso: true, veiculo });
  } catch (error) {
    console.error('[Veículos] Erro ao atualizar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/veiculos/:id
 * Excluir veículo
 */
router.delete('/:id', verificarPermissao('veiculos', 'excluir'), async (req, res) => {
  try {
    await veiculoService.excluir(
      parseInt(req.params.id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json({ sucesso: true, mensagem: 'Veículo excluído com sucesso' });
  } catch (error) {
    console.error('[Veículos] Erro ao excluir:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/veiculos/:id/vincular
 * Vincular dispositivo a um veículo
 * Body: { dispositivo_id: 123 }
 */
router.post('/:id/vincular', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const { dispositivo_id } = req.body;

    if (!dispositivo_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'dispositivo_id é obrigatório'
      });
    }

    const resultado = await veiculoService.vincularDispositivo(
      parseInt(req.params.id),
      parseInt(dispositivo_id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Veículos] Erro ao vincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/veiculos/:id/desvincular
 * Desvincular dispositivo atual do veículo
 * Body: { dispositivo_id: 123 }
 */
router.post('/:id/desvincular', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const { dispositivo_id } = req.body;

    if (!dispositivo_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'dispositivo_id é obrigatório'
      });
    }

    const resultado = await veiculoService.desvincularDispositivo(
      parseInt(dispositivo_id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Veículos] Erro ao desvincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/veiculos/:id/trocar-dispositivo
 * Trocar rastreador do veículo
 * Body: { novo_imei: "356354870702322" }
 */
router.post('/:id/trocar-dispositivo', verificarPermissao('veiculos', 'editar'), async (req, res) => {
  try {
    const { novo_imei } = req.body;

    if (!novo_imei) {
      return res.status(400).json({
        sucesso: false,
        erro: 'novo_imei é obrigatório'
      });
    }

    const resultado = await veiculoService.trocarDispositivo(
      parseInt(req.params.id),
      novo_imei.trim(),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Veículos] Erro ao trocar dispositivo:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/:id/dispositivos
 * Histórico de dispositivos do veículo
 */
router.get('/:id/dispositivos', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const historico = await veiculoService.historicoDispositivos(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, historico });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar histórico de dispositivos:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/:id/historico
 * Histórico completo de localizações do veículo
 * Query: ?dataInicio=2024-01-01&dataFim=2024-12-31&limit=1000
 */
router.get('/:id/historico', verificarPermissao('monitoramento', 'historico'), async (req, res) => {
  try {
    const { dataInicio, dataFim, limit } = req.query;

    const resultado = await veiculoService.getHistoricoCompleto(
      parseInt(req.params.id),
      req.organizacao_id,
      {
        dataInicio,
        dataFim,
        limit: parseInt(limit) || 1000
      }
    );

    res.json({ sucesso: true, ...resultado });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar histórico:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/:id/viagens
 * Viagens do veículo (agregadas de todos os dispositivos)
 * Query: ?dataInicio=2024-01-01&dataFim=2024-12-31&page=1&limit=50
 */
router.get('/:id/viagens', verificarPermissao('viagens', 'listar'), async (req, res) => {
  try {
    const { dataInicio, dataFim, page, limit } = req.query;

    const resultado = await veiculoService.getViagens(
      parseInt(req.params.id),
      req.organizacao_id,
      {
        dataInicio,
        dataFim,
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 50
      }
    );

    res.json({ sucesso: true, ...resultado });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar viagens:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/veiculos/:id/estatisticas
 * Estatísticas agregadas do veículo
 */
router.get('/:id/estatisticas', verificarPermissao('veiculos', 'listar'), async (req, res) => {
  try {
    const estatisticas = await veiculoService.getEstatisticas(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, estatisticas });
  } catch (error) {
    console.error('[Veículos] Erro ao buscar estatísticas:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
