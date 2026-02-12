/**
 * Rotas de Autenticação para Motoristas (App Mobile)
 *
 * Endpoints:
 * - POST /api/auth-motorista/login - Login por CPF
 * - POST /api/auth-motorista/refresh - Refresh token
 * - POST /api/auth-motorista/logout - Logout
 * - GET /api/auth-motorista/me - Dados do motorista logado
 * - POST /api/auth-motorista/vincular - Vincular via IMEI (QR Code)
 * - POST /api/auth-motorista/desvincular - Desvincular do veículo
 */

const express = require('express');
const router = express.Router();
const authMotoristaService = require('../services/auth-motorista.service');
const {
  autenticarMotorista,
  extrairMetadadosDispositivo
} = require('../middleware/auth-motorista.middleware');

/**
 * POST /api/auth-motorista/login
 * Login por CPF (sem senha)
 *
 * Body:
 * - cpf: string (com ou sem formatação)
 * - device_info: string (opcional - informações do dispositivo)
 */
router.post('/login', async (req, res) => {
  try {
    const { cpf, device_info } = req.body;

    if (!cpf) {
      return res.status(400).json({
        erro: true,
        mensagem: 'CPF é obrigatório'
      });
    }

    // Validar formato do CPF
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      return res.status(400).json({
        erro: true,
        mensagem: 'CPF inválido. Deve conter 11 dígitos.'
      });
    }

    const { ip, userAgent } = extrairMetadadosDispositivo(req);

    const resultado = await authMotoristaService.loginPorCpf(
      cpf,
      ip,
      userAgent,
      device_info
    );

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro no login:', error.message);
    res.status(401).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/refresh
 * Renovar access token usando refresh token
 *
 * Body:
 * - refresh_token: string
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Refresh token é obrigatório'
      });
    }

    const { ip, userAgent } = extrairMetadadosDispositivo(req);

    const resultado = await authMotoristaService.refreshAccessToken(
      refresh_token,
      ip,
      userAgent
    );

    res.json({
      sucesso: true,
      ...resultado
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro no refresh:', error.message);
    res.status(401).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/logout
 * Logout - revogar refresh token
 *
 * Body:
 * - refresh_token: string
 */
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Refresh token é obrigatório'
      });
    }

    await authMotoristaService.logout(refresh_token);

    res.json({
      sucesso: true,
      mensagem: 'Logout realizado com sucesso'
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro no logout:', error.message);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/auth-motorista/me
 * Obter dados do motorista logado
 *
 * Requer: Token de motorista válido
 */
router.get('/me', autenticarMotorista, async (req, res) => {
  try {
    const dados = await authMotoristaService.getDadosMotorista(req.motorista.id);

    res.json({
      sucesso: true,
      motorista: dados
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao buscar dados:', error.message);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/vincular
 * Vincular motorista a veículo via IMEI (QR Code)
 *
 * Requer: Token de motorista válido
 * Body:
 * - imei: string (15 dígitos do QR Code)
 */
router.post('/vincular', autenticarMotorista, async (req, res) => {
  try {
    const { imei } = req.body;

    if (!imei) {
      return res.status(400).json({
        erro: true,
        mensagem: 'IMEI é obrigatório'
      });
    }

    const resultado = await authMotoristaService.vincularPorImei(
      req.motorista.id,
      imei,
      req.motorista.organizacao_id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[AuthMotorista] Erro ao vincular:', error.message);
    res.status(400).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/desvincular
 * Desvincular motorista do veículo atual
 *
 * Requer: Token de motorista válido
 */
router.post('/desvincular', autenticarMotorista, async (req, res) => {
  try {
    const resultado = await authMotoristaService.desvincular(
      req.motorista.id,
      req.motorista.organizacao_id
    );

    res.json(resultado);
  } catch (error) {
    console.error('[AuthMotorista] Erro ao desvincular:', error.message);
    res.status(400).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/auth-motorista/notificacoes
 * Buscar notificações/alertas do motorista (infrações de velocidade, etc)
 *
 * Query params:
 * - limit: número máximo de notificações (default: 20)
 * - naoLidas: apenas não lidas (default: false)
 *
 * Requer: Token de motorista válido
 */
router.get('/notificacoes', autenticarMotorista, async (req, res) => {
  try {
    const { limit = 20, naoLidas = 'false' } = req.query;

    const notificacoes = await authMotoristaService.getNotificacoes(
      req.motorista.id,
      req.motorista.organizacao_id,
      parseInt(limit),
      naoLidas === 'true'
    );

    res.json({
      sucesso: true,
      notificacoes,
      total: notificacoes.length
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao buscar notificações:', error.message);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/notificacoes/:id/lida
 * Marcar notificação como lida
 *
 * Requer: Token de motorista válido
 */
router.post('/notificacoes/:id/lida', autenticarMotorista, async (req, res) => {
  try {
    const { id } = req.params;

    await authMotoristaService.marcarNotificacaoLida(
      parseInt(id),
      req.motorista.id
    );

    res.json({
      sucesso: true,
      mensagem: 'Notificação marcada como lida'
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao marcar notificação:', error.message);
    res.status(400).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/auth-motorista/notificacoes/contagem
 * Buscar contagem de notificações não lidas
 *
 * Requer: Token de motorista válido
 */
router.get('/notificacoes/contagem', autenticarMotorista, async (req, res) => {
  try {
    const contagem = await authMotoristaService.getContagemNotificacoesNaoLidas(
      req.motorista.id,
      req.motorista.organizacao_id
    );

    res.json({
      sucesso: true,
      naoLidas: contagem
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao contar notificações:', error.message);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/auth-motorista/push-token
 * Registrar/atualizar push token do dispositivo móvel
 * Chamado pelo app após obter o Expo Push Token
 *
 * Requer: Token de motorista válido
 * Body:
 * - push_token: string (ExponentPushToken[xxx])
 */
router.post('/push-token', autenticarMotorista, async (req, res) => {
  try {
    const { push_token } = req.body;

    if (!push_token) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Push token é obrigatório'
      });
    }

    await authMotoristaService.atualizarPushToken(
      req.motorista.id,
      push_token
    );

    res.json({
      sucesso: true,
      mensagem: 'Push token registrado com sucesso'
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao registrar push token:', error.message);
    res.status(400).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * DELETE /api/auth-motorista/push-token
 * Remover push token (quando deslogar ou desabilitar notificações)
 *
 * Requer: Token de motorista válido
 */
router.delete('/push-token', autenticarMotorista, async (req, res) => {
  try {
    await authMotoristaService.atualizarPushToken(
      req.motorista.id,
      null
    );

    res.json({
      sucesso: true,
      mensagem: 'Push token removido com sucesso'
    });
  } catch (error) {
    console.error('[AuthMotorista] Erro ao remover push token:', error.message);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

module.exports = router;
