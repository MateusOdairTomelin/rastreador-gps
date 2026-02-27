/**
 * Rotas de Multas
 *
 * Endpoints REST para gestão completa de multas de trânsito:
 * - CRUD de multas
 * - Identificação automática de motorista via GPS
 * - Gestão de recursos (defesa prévia, JARI, CETRAN)
 * - Pagamentos e NIC
 * - Dashboard e estatísticas
 */

const express = require('express');
const router = express.Router();
const multaService = require('../services/multa.service');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// Autenticação já é aplicada no index.js via: router.use('/multas', autenticar, tenantContext, multaRoutes)

// ========== LISTAGEM E BUSCA ==========

/**
 * GET /api/multas
 * Listar multas da organização com filtros
 */
router.get('/', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const {
      veiculo_id,
      motorista_id,
      status,
      gravidade,
      data_inicio,
      data_fim,
      busca,
      page,
      limit
    } = req.query;

    const resultado = await multaService.listar(req.organizacao_id, {
      veiculo_id,
      motorista_id,
      status,
      gravidade,
      data_inicio,
      data_fim,
      busca,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50
    });

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('[Multas] Erro ao listar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/multas/estatisticas
 * Dashboard com estatísticas de multas
 */
router.get('/estatisticas', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const { data_inicio, data_fim } = req.query;

    const stats = await multaService.estatisticas(req.organizacao_id, {
      data_inicio,
      data_fim
    });

    res.json({
      sucesso: true,
      estatisticas: stats
    });
  } catch (error) {
    console.error('[Multas] Erro ao obter estatísticas:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/multas/proximas-vencer
 * Multas próximas do vencimento
 */
router.get('/proximas-vencer', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 7;

    const multas = await multaService.proximasVencer(req.organizacao_id, dias);

    res.json({
      sucesso: true,
      multas,
      total: multas.length,
      dias
    });
  } catch (error) {
    console.error('[Multas] Erro ao buscar próximas a vencer:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/multas/nic-pendentes
 * Multas com NIC pendente
 */
router.get('/nic-pendentes', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const multas = await multaService.nicPendentes(req.organizacao_id);

    res.json({
      sucesso: true,
      multas,
      total: multas.length
    });
  } catch (error) {
    console.error('[Multas] Erro ao buscar NIC pendentes:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * GET /api/multas/:id
 * Buscar multa por ID
 */
router.get('/:id', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const multa = await multaService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!multa) {
      return res.status(404).json({ sucesso: false, erro: 'Multa não encontrada' });
    }

    res.json({ sucesso: true, multa });
  } catch (error) {
    console.error('[Multas] Erro ao buscar:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// ========== CRUD ==========

/**
 * POST /api/multas
 * Criar nova multa
 */
router.post('/', verificarPermissao('relatorios', 'criar'), async (req, res) => {
  try {
    const {
      veiculo_id,
      motorista_id,
      viagem_id,
      numero_auto,
      data_infracao,
      hora_infracao,
      local_infracao,
      latitude,
      longitude,
      codigo_infracao,
      descricao_infracao,
      gravidade,
      pontos,
      valor_original,
      valor_desconto,
      data_vencimento,
      data_vencimento_desconto,
      notificacao_url,
      observacoes,
      nic_data_limite
    } = req.body;

    // Validações
    if (!veiculo_id) {
      return res.status(400).json({ sucesso: false, erro: 'Veículo é obrigatório' });
    }
    if (!data_infracao) {
      return res.status(400).json({ sucesso: false, erro: 'Data da infração é obrigatória' });
    }
    if (!valor_original || valor_original <= 0) {
      return res.status(400).json({ sucesso: false, erro: 'Valor da multa deve ser maior que zero' });
    }

    const multa = await multaService.criar(req.organizacao_id, {
      veiculo_id: parseInt(veiculo_id),
      motorista_id: motorista_id ? parseInt(motorista_id) : null,
      viagem_id: viagem_id ? parseInt(viagem_id) : null,
      numero_auto,
      data_infracao,
      hora_infracao,
      local_infracao,
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      codigo_infracao,
      descricao_infracao,
      gravidade,
      pontos: pontos ? parseInt(pontos) : 0,
      valor_original: parseFloat(valor_original),
      valor_desconto: valor_desconto ? parseFloat(valor_desconto) : null,
      data_vencimento,
      data_vencimento_desconto,
      notificacao_url,
      observacoes,
      nic_data_limite
    }, req.usuario?.id);

    res.status(201).json({ sucesso: true, multa });
  } catch (error) {
    console.error('[Multas] Erro ao criar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/multas/:id
 * Atualizar multa
 */
router.put('/:id', verificarPermissao('relatorios', 'editar'), async (req, res) => {
  try {
    const multa = await multaService.atualizar(
      parseInt(req.params.id),
      req.organizacao_id,
      req.body,
      req.usuario?.id
    );

    res.json({ sucesso: true, multa });
  } catch (error) {
    console.error('[Multas] Erro ao atualizar:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * DELETE /api/multas/:id
 * Excluir multa
 */
router.delete('/:id', verificarPermissao('relatorios', 'excluir'), async (req, res) => {
  try {
    await multaService.excluir(
      parseInt(req.params.id),
      req.organizacao_id,
      req.usuario?.id
    );

    res.json({ sucesso: true, mensagem: 'Multa excluída com sucesso' });
  } catch (error) {
    console.error('[Multas] Erro ao excluir:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ========== IDENTIFICAÇÃO DE MOTORISTA ==========

/**
 * POST /api/multas/:id/identificar-motorista
 * Tenta identificar o motorista via GPS
 */
router.post('/:id/identificar-motorista', verificarPermissao('relatorios', 'editar'), async (req, res) => {
  try {
    const multa = await multaService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!multa) {
      return res.status(404).json({ sucesso: false, erro: 'Multa não encontrada' });
    }

    const identificacao = await multaService.identificarMotoristaViaGPS(
      multa.veiculo_id,
      multa.data_infracao,
      multa.hora_infracao
    );

    if (identificacao?.motorista_id) {
      // Atualizar a multa com o motorista identificado
      await multaService.atualizar(
        multa.id,
        req.organizacao_id,
        { motorista_id: identificacao.motorista_id },
        req.usuario?.id
      );

      res.json({
        sucesso: true,
        identificado: true,
        motorista_id: identificacao.motorista_id,
        metodo: identificacao.metodo,
        viagem_id: identificacao.viagem_id
      });
    } else {
      res.json({
        sucesso: true,
        identificado: false,
        mensagem: 'Não foi possível identificar o motorista automaticamente'
      });
    }
  } catch (error) {
    console.error('[Multas] Erro ao identificar motorista:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * POST /api/multas/:id/validar-localizacao
 * Valida se o veículo estava no local da infração
 */
router.post('/:id/validar-localizacao', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const { latitude, longitude, raio_metros } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ sucesso: false, erro: 'Coordenadas são obrigatórias' });
    }

    const multa = await multaService.buscarPorId(
      parseInt(req.params.id),
      req.organizacao_id
    );

    if (!multa) {
      return res.status(404).json({ sucesso: false, erro: 'Multa não encontrada' });
    }

    const validacao = await multaService.validarLocalizacaoInfracao(
      multa.veiculo_id,
      multa.data_infracao,
      multa.hora_infracao,
      parseFloat(latitude),
      parseFloat(longitude),
      raio_metros ? parseInt(raio_metros) : 200
    );

    res.json({
      sucesso: true,
      validacao
    });
  } catch (error) {
    console.error('[Multas] Erro ao validar localização:', error.message);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// ========== PAGAMENTO ==========

/**
 * POST /api/multas/:id/pagar
 * Registrar pagamento de multa
 */
router.post('/:id/pagar', verificarPermissao('relatorios', 'editar'), async (req, res) => {
  try {
    const { valor_pago, data_pagamento, comprovante_url } = req.body;

    if (!valor_pago || valor_pago <= 0) {
      return res.status(400).json({ sucesso: false, erro: 'Valor pago deve ser maior que zero' });
    }
    if (!data_pagamento) {
      return res.status(400).json({ sucesso: false, erro: 'Data de pagamento é obrigatória' });
    }

    const multa = await multaService.registrarPagamento(
      parseInt(req.params.id),
      req.organizacao_id,
      {
        valor_pago: parseFloat(valor_pago),
        data_pagamento,
        comprovante_url
      },
      req.usuario?.id
    );

    res.json({ sucesso: true, multa });
  } catch (error) {
    console.error('[Multas] Erro ao registrar pagamento:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ========== NIC ==========

/**
 * POST /api/multas/:id/nic
 * Enviar NIC (Notificação de Identificação do Condutor)
 */
router.post('/:id/nic', verificarPermissao('relatorios', 'editar'), async (req, res) => {
  try {
    const { motorista_id } = req.body;

    if (!motorista_id) {
      return res.status(400).json({ sucesso: false, erro: 'Motorista é obrigatório para enviar NIC' });
    }

    const multa = await multaService.enviarNIC(
      parseInt(req.params.id),
      req.organizacao_id,
      parseInt(motorista_id),
      req.usuario?.id
    );

    res.json({ sucesso: true, multa });
  } catch (error) {
    console.error('[Multas] Erro ao enviar NIC:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

// ========== RECURSOS ==========

/**
 * POST /api/multas/:id/recursos
 * Criar recurso para uma multa
 */
router.post('/:id/recursos', verificarPermissao('relatorios', 'criar'), async (req, res) => {
  try {
    const { tipo, data_protocolo, numero_protocolo, motivo, anexos } = req.body;

    if (!tipo) {
      return res.status(400).json({ sucesso: false, erro: 'Tipo de recurso é obrigatório' });
    }
    if (!data_protocolo) {
      return res.status(400).json({ sucesso: false, erro: 'Data do protocolo é obrigatória' });
    }

    const validTypes = ['defesa_previa', 'jari', 'cetran', 'recurso_especial'];
    if (!validTypes.includes(tipo)) {
      return res.status(400).json({
        sucesso: false,
        erro: `Tipo inválido. Use: ${validTypes.join(', ')}`
      });
    }

    const recurso = await multaService.criarRecurso(
      parseInt(req.params.id),
      req.organizacao_id,
      {
        tipo,
        data_protocolo,
        numero_protocolo,
        motivo,
        anexos
      },
      req.usuario?.id
    );

    res.status(201).json({ sucesso: true, recurso });
  } catch (error) {
    console.error('[Multas] Erro ao criar recurso:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PUT /api/multas/:multa_id/recursos/:recurso_id
 * Atualizar recurso (resultado)
 */
router.put('/:multa_id/recursos/:recurso_id', verificarPermissao('relatorios', 'editar'), async (req, res) => {
  try {
    const { status, data_resultado, resultado, anexos } = req.body;

    const recurso = await multaService.atualizarRecurso(
      parseInt(req.params.recurso_id),
      req.organizacao_id,
      {
        status,
        data_resultado,
        resultado,
        anexos
      },
      req.usuario?.id
    );

    res.json({ sucesso: true, recurso });
  } catch (error) {
    console.error('[Multas] Erro ao atualizar recurso:', error.message);
    res.status(400).json({ sucesso: false, erro: error.message });
  }
});

module.exports = router;
