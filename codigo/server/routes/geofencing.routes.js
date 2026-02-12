/**
 * Rotas de Geofencing - Cercas Virtuais
 *
 * Endpoints:
 * POST   /api/geofencing              - Criar cerca
 * GET    /api/geofencing              - Listar cercas da organização
 * GET    /api/geofencing/estatisticas - Estatísticas de geofencing
 * GET    /api/geofencing/eventos      - Todos eventos da organização
 * GET    /api/geofencing/:id          - Detalhes de uma cerca
 * PUT    /api/geofencing/:id          - Atualizar cerca
 * DELETE /api/geofencing/:id          - Deletar cerca
 * PATCH  /api/geofencing/:id/toggle   - Ativar/desativar cerca
 * GET    /api/geofencing/:id/eventos  - Eventos de uma cerca específica
 * GET    /api/geofencing/dispositivo/:imei/eventos - Eventos por dispositivo
 * GET    /api/geofencing/dispositivo/:imei/status  - Status atual do dispositivo
 */

const express = require('express');
const router = express.Router();
const geofencingService = require('../services/geofencing.service');

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ==================== ROTAS DE CERCAS ====================

/**
 * POST /api/geofencing - Criar nova cerca
 */
router.post('/', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Nenhuma organização selecionada. Vá em "Selecionar Organização" no menu do usuário e escolha uma organização.',
      dica: 'Se você é super_admin, selecione uma organização antes de criar cercas.'
    });
  }

  const { nome, descricao, latitude, longitude, raio_metros, cor, tipo_alerta } = req.body;

  // Validações básicas
  if (!nome) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Nome da cerca é obrigatório'
    });
  }

  if (!latitude || !longitude) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Coordenadas (latitude e longitude) são obrigatórias'
    });
  }

  if (!raio_metros) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Raio em metros é obrigatório'
    });
  }

  try {
    const geofence = await geofencingService.criar(organizacao_id, {
      nome,
      descricao,
      latitude,
      longitude,
      raio_metros,
      cor,
      tipo_alerta
    });

    res.status(201).json({
      sucesso: true,
      mensagem: 'Cerca criada com sucesso',
      dados: geofence
    });
  } catch (error) {
    res.status(400).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * GET /api/geofencing - Listar cercas da organização
 */
router.get('/', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  const { ativo, limite } = req.query;

  const geofences = await geofencingService.listar(organizacao_id, {
    ativo: ativo !== undefined ? ativo === 'true' : undefined,
    limite: limite ? parseInt(limite) : 100
  });

  res.json({
    sucesso: true,
    total: geofences.length,
    dados: geofences.map(g => ({
      id: g.id,
      nome: g.nome,
      descricao: g.descricao,
      latitude: g.latitude,
      longitude: g.longitude,
      raio_metros: g.raio_metros,
      cor: g.cor,
      tipo_alerta: g.tipo_alerta,
      ativo: g.ativo,
      total_eventos: g._count?.eventos || 0,
      created_at: g.created_at,
      updated_at: g.updated_at
    }))
  });
}));

/**
 * GET /api/geofencing/estatisticas - Estatísticas de geofencing
 */
router.get('/estatisticas', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  const estatisticas = await geofencingService.obterEstatisticas(organizacao_id);

  res.json({
    sucesso: true,
    dados: estatisticas
  });
}));

/**
 * GET /api/geofencing/eventos - Todos eventos da organização
 */
router.get('/eventos', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  const { geofence_id, dispositivo_id, tipo_evento, data_inicio, data_fim, limite } = req.query;

  const eventos = await geofencingService.listarEventos(organizacao_id, {
    geofence_id,
    dispositivo_id,
    tipo_evento,
    data_inicio,
    data_fim,
    limite: limite ? parseInt(limite) : 100
  });

  res.json({
    sucesso: true,
    total: eventos.length,
    dados: eventos.map(e => ({
      id: e.id,
      tipo_evento: e.tipo_evento,
      latitude: e.latitude,
      longitude: e.longitude,
      velocidade: e.velocidade,
      timestamp: e.timestamp,
      geofence: e.geofence,
      dispositivo: e.dispositivo
    }))
  });
}));

/**
 * GET /api/geofencing/dispositivo/:imei/eventos - Eventos por dispositivo
 */
router.get('/dispositivo/:imei/eventos', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { imei } = req.params;
  const { limite } = req.query;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  try {
    const eventos = await geofencingService.listarEventosPorDispositivo(
      imei,
      organizacao_id,
      limite ? parseInt(limite) : 50
    );

    res.json({
      sucesso: true,
      total: eventos.length,
      dados: eventos
    });
  } catch (error) {
    res.status(404).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * GET /api/geofencing/dispositivo/:imei/status - Status atual do dispositivo
 */
router.get('/dispositivo/:imei/status', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { imei } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  try {
    const status = await geofencingService.obterStatusDispositivo(imei, organizacao_id);

    res.json({
      sucesso: true,
      dados: status
    });
  } catch (error) {
    res.status(404).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * GET /api/geofencing/:id - Detalhes de uma cerca
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  const geofence = await geofencingService.obter(id, organizacao_id);

  if (!geofence) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Cerca não encontrada'
    });
  }

  res.json({
    sucesso: true,
    dados: {
      id: geofence.id,
      nome: geofence.nome,
      descricao: geofence.descricao,
      latitude: geofence.latitude,
      longitude: geofence.longitude,
      raio_metros: geofence.raio_metros,
      cor: geofence.cor,
      tipo_alerta: geofence.tipo_alerta,
      ativo: geofence.ativo,
      total_eventos: geofence._count?.eventos || 0,
      created_at: geofence.created_at,
      updated_at: geofence.updated_at
    }
  });
}));

/**
 * PUT /api/geofencing/:id - Atualizar cerca
 */
router.put('/:id', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  try {
    const geofence = await geofencingService.atualizar(id, organizacao_id, req.body);

    res.json({
      sucesso: true,
      mensagem: 'Cerca atualizada com sucesso',
      dados: geofence
    });
  } catch (error) {
    res.status(400).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * DELETE /api/geofencing/:id - Deletar cerca
 */
router.delete('/:id', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  try {
    await geofencingService.deletar(id, organizacao_id);

    res.json({
      sucesso: true,
      mensagem: 'Cerca deletada com sucesso'
    });
  } catch (error) {
    res.status(400).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * PATCH /api/geofencing/:id/toggle - Ativar/desativar cerca
 */
router.patch('/:id/toggle', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  try {
    const geofence = await geofencingService.toggleAtivo(id, organizacao_id);

    res.json({
      sucesso: true,
      mensagem: `Cerca ${geofence.ativo ? 'ativada' : 'desativada'} com sucesso`,
      dados: geofence
    });
  } catch (error) {
    res.status(400).json({
      sucesso: false,
      mensagem: error.message
    });
  }
}));

/**
 * GET /api/geofencing/:id/eventos - Eventos de uma cerca específica
 */
router.get('/:id/eventos', asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;
  const { limite } = req.query;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Organização não identificada'
    });
  }

  // Verificar se a cerca existe e pertence à organização
  const geofence = await geofencingService.obter(id, organizacao_id);
  if (!geofence) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Cerca não encontrada'
    });
  }

  const eventos = await geofencingService.listarEventosPorGeofence(
    id,
    limite ? parseInt(limite) : 50
  );

  res.json({
    sucesso: true,
    total: eventos.length,
    geofence: {
      id: geofence.id,
      nome: geofence.nome
    },
    dados: eventos
  });
}));

module.exports = router;
