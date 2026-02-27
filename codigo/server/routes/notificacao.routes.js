/**
 * Rotas de Notificações
 *
 * Endpoints:
 * GET    /api/notificacoes                  - Listar notificações
 * GET    /api/notificacoes/count            - Contar não lidas
 * GET    /api/notificacoes/config           - Obter configuração
 * PUT    /api/notificacoes/config           - Atualizar configuração
 * POST   /api/notificacoes/config/telegram/validar - Validar bot Telegram
 * PATCH  /api/notificacoes/:id/lida         - Marcar como lida
 * PATCH  /api/notificacoes/todas-lidas      - Marcar todas como lidas
 */

const express = require('express');
const router = express.Router();
const notificationService = require('../services/notification.service');
const telegramService = require('../services/telegram.service');
const { verificarPermissao } = require('../middleware/permissao.middleware');

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/notificacoes - Listar
router.get('/', verificarPermissao('notificacoes', 'listar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  const { limite, offset, lida, tipo, dispositivo_id } = req.query;

  const notificacoes = await notificationService.listar(organizacao_id, {
    limite: limite ? parseInt(limite) : 50,
    offset: offset ? parseInt(offset) : 0,
    lida: lida !== undefined ? lida === 'true' : undefined,
    tipo,
    dispositivo_id: dispositivo_id ? parseInt(dispositivo_id) : undefined
  });

  res.json({
    sucesso: true,
    total: notificacoes.length,
    dados: notificacoes.map(n => ({
      ...n,
      dados_extras: n.dados_extras ? JSON.parse(n.dados_extras) : null
    }))
  });
}));

// GET /api/notificacoes/count - Contar não lidas
router.get('/count', verificarPermissao('notificacoes', 'listar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  const count = await notificationService.contarNaoLidas(organizacao_id);

  res.json({
    sucesso: true,
    nao_lidas: count
  });
}));

// GET /api/notificacoes/config - Obter configuração
router.get('/config', verificarPermissao('notificacoes', 'configurar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  const config = await notificationService.getConfig(organizacao_id);

  res.json({
    sucesso: true,
    dados: config || {
      telegram_ativo: false,
      telegram_bot_token: null,
      telegram_chat_id: null,
      som_ativo: true,
      debounce_geofence: 60,
      debounce_velocidade: 300,
      notificar_geofence_entrada: true,
      notificar_geofence_saida: true,
      notificar_excesso_velocidade: true,
      velocidade_limite_custom: null
    }
  });
}));

// PUT /api/notificacoes/config - Atualizar configuração
router.put('/config', verificarPermissao('notificacoes', 'configurar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  // Campos permitidos para atualização
  const camposPermitidos = [
    'telegram_ativo',
    'telegram_bot_token',
    'telegram_chat_id',
    'som_ativo',
    'debounce_geofence',
    'debounce_velocidade',
    'notificar_geofence_entrada',
    'notificar_geofence_saida',
    'notificar_excesso_velocidade',
    'velocidade_limite_custom'
  ];

  const dados = {};
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) {
      dados[campo] = req.body[campo];
    }
  }

  const config = await notificationService.upsertConfig(organizacao_id, dados);

  res.json({
    sucesso: true,
    mensagem: 'Configuração atualizada',
    dados: config
  });
}));

// POST /api/notificacoes/config/telegram/validar - Validar bot Telegram
router.post('/config/telegram/validar', verificarPermissao('notificacoes', 'configurar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { bot_token, chat_id } = req.body;

  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  if (!bot_token || !chat_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'bot_token e chat_id são obrigatórios' });
  }

  const resultado = await telegramService.validarBot(bot_token, chat_id);

  if (resultado.sucesso) {
    // Salvar configuração validada
    await notificationService.upsertConfig(organizacao_id, {
      telegram_bot_token: bot_token,
      telegram_chat_id: chat_id,
      telegram_ativo: true
    });
  }

  res.json(resultado);
}));

// PATCH /api/notificacoes/todas-lidas - Marcar todas como lidas
// IMPORTANTE: Esta rota deve vir ANTES de /:id/lida
router.patch('/todas-lidas', verificarPermissao('notificacoes', 'editar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  await notificationService.marcarTodasComoLidas(organizacao_id);

  res.json({
    sucesso: true,
    mensagem: 'Todas as notificações marcadas como lidas'
  });
}));

// PATCH /api/notificacoes/:id/lida - Marcar como lida
router.patch('/:id/lida', verificarPermissao('notificacoes', 'editar'), asyncHandler(async (req, res) => {
  const organizacao_id = req.tenant?.id;
  const { id } = req.params;

  if (!organizacao_id) {
    return res.status(400).json({ sucesso: false, mensagem: 'Organização não identificada' });
  }

  await notificationService.marcarComoLida(parseInt(id), organizacao_id);

  res.json({
    sucesso: true,
    mensagem: 'Notificação marcada como lida'
  });
}));

module.exports = router;
