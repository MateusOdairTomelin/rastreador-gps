/**
 * Rotas de Motoristas
 *
 * CRUD completo + vinculação com veículos
 */

const express = require('express');
const router = express.Router();
const motoristaService = require('../services/motorista.service');

// Autenticação já é aplicada no index.js via: router.use('/motoristas', autenticar, tenantContext, motoristaRoutes)

/**
 * GET /api/motoristas
 * Listar motoristas da organização
 */
router.get('/', async (req, res) => {
  try {
    const { ativo, busca, page, limit } = req.query;

    const resultado = await motoristaService.listar(req.organizacao_id, {
      ativo,
      busca,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50
    });

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('[Motoristas] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/motoristas/cnh-vencida
 * Listar motoristas com CNH vencida
 */
router.get('/cnh-vencida', async (req, res) => {
  try {
    const motoristas = await motoristaService.verificarCnhVencida(req.organizacao_id);

    res.json({
      sucesso: true,
      motoristas,
      total: motoristas.length
    });
  } catch (error) {
    console.error('[Motoristas] Erro ao verificar CNH vencida:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/motoristas/cnh-vencendo
 * Listar motoristas com CNH próxima do vencimento
 */
router.get('/cnh-vencendo', async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const motoristas = await motoristaService.verificarCnhProximaVencer(req.organizacao_id, dias);

    res.json({
      sucesso: true,
      motoristas,
      total: motoristas.length,
      dias
    });
  } catch (error) {
    console.error('[Motoristas] Erro ao verificar CNH vencendo:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/motoristas/:id
 * Buscar motorista por ID
 */
router.get('/:id', async (req, res) => {
  try {
    const motorista = await motoristaService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!motorista) {
      return res.status(404).json({ sucesso: false, erro: 'Motorista não encontrado' });
    }

    res.json({ sucesso: true, motorista });
  } catch (error) {
    console.error('[Motoristas] Erro ao buscar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/motoristas
 * Criar novo motorista
 */
router.post('/', async (req, res) => {
  try {
    const { nome, cpf, telefone, email, foto_url, cnh_numero, cnh_categoria, cnh_validade } = req.body;

    if (!nome || nome.trim().length < 2) {
      return res.status(400).json({ sucesso: false, erro: 'Nome é obrigatório (mínimo 2 caracteres)' });
    }

    const motorista = await motoristaService.criar(req.organizacao_id, {
      nome: nome.trim(),
      cpf,
      telefone,
      email,
      foto_url,
      cnh_numero,
      cnh_categoria,
      cnh_validade
    });

    res.status(201).json({ sucesso: true, motorista });
  } catch (error) {
    console.error('[Motoristas] Erro ao criar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/motoristas/:id
 * Atualizar motorista
 */
router.put('/:id', async (req, res) => {
  try {
    const motorista = await motoristaService.atualizar(
      parseInt(req.params.id),
      req.organizacao_id,
      req.body
    );

    res.json({ sucesso: true, motorista });
  } catch (error) {
    console.error('[Motoristas] Erro ao atualizar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/motoristas/:id
 * Excluir motorista
 */
router.delete('/:id', async (req, res) => {
  try {
    await motoristaService.excluir(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, mensagem: 'Motorista excluído com sucesso' });
  } catch (error) {
    console.error('[Motoristas] Erro ao excluir:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/motoristas/:id/vincular/:dispositivo_id
 * Vincular motorista a um veículo
 */
router.post('/:id/vincular/:dispositivo_id', async (req, res) => {
  try {
    const resultado = await motoristaService.vincularVeiculo(
      parseInt(req.params.id),
      parseInt(req.params.dispositivo_id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Motoristas] Erro ao vincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/motoristas/desvincular/:dispositivo_id
 * Desvincular motorista de um veículo
 */
router.delete('/desvincular/:dispositivo_id', async (req, res) => {
  try {
    const resultado = await motoristaService.desvincularVeiculo(
      parseInt(req.params.dispositivo_id),
      req.organizacao_id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[Motoristas] Erro ao desvincular:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/motoristas/:id/historico
 * Histórico de veículos de um motorista
 */
router.get('/:id/historico', async (req, res) => {
  try {
    const historico = await motoristaService.historicoMotorista(
      parseInt(req.params.id),
      req.organizacao_id
    );

    res.json({ sucesso: true, historico });
  } catch (error) {
    console.error('[Motoristas] Erro ao buscar histórico:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/motoristas/veiculo/:dispositivo_id/historico
 * Histórico de motoristas de um veículo
 */
router.get('/veiculo/:dispositivo_id/historico', async (req, res) => {
  try {
    const historico = await motoristaService.historicoVeiculo(
      parseInt(req.params.dispositivo_id),
      req.organizacao_id
    );

    res.json({ sucesso: true, historico });
  } catch (error) {
    console.error('[Motoristas] Erro ao buscar histórico:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
