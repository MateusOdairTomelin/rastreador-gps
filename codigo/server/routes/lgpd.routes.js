/**
 * Rotas LGPD - Consentimentos e Direitos do Titular
 *
 * Endpoints:
 * - POST /api/lgpd/consentimento - Registrar consentimento
 * - GET /api/lgpd/consentimentos - Listar consentimentos do usuário
 * - DELETE /api/lgpd/consentimento/:tipo - Revogar consentimento
 * - GET /api/lgpd/verificar - Verificar consentimentos pendentes
 * - POST /api/lgpd/solicitar-exclusao - Solicitar exclusão de dados
 * - GET /api/lgpd/meus-dados - Exportar dados (portabilidade)
 * - GET /api/lgpd/versoes - Obter versões dos documentos
 */

const express = require('express');
const router = express.Router();
const lgpdService = require('../services/lgpd.service');
const dataRetentionService = require('../services/data-retention.service');
const { autenticar, apenasAdmin, apenasSuperAdmin } = require('../middleware/auth.middleware');
const { exportacaoDadosLimiter, exclusaoDadosLimiter } = require('../middleware/rate-limit.middleware');

/**
 * Extrair metadados da requisição
 */
const extrairMetadados = (req) => ({
  ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
  userAgent: req.headers['user-agent']
});

/**
 * POST /api/lgpd/consentimento
 * Registrar aceite de consentimento
 */
router.post('/consentimento', autenticar, async (req, res) => {
  try {
    const { tipo, versao } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!tipo || !versao) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Tipo e versão do documento são obrigatórios'
      });
    }

    const consentimento = await lgpdService.registrarConsentimento(
      req.usuario.id, tipo, versao, ip, userAgent
    );

    res.json({
      sucesso: true,
      mensagem: 'Consentimento registrado com sucesso',
      consentimento
    });
  } catch (error) {
    console.error('[LGPD] Erro ao registrar consentimento:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/lgpd/consentimento/inicial
 * Registrar consentimentos iniciais (privacidade + termos)
 */
router.post('/consentimento/inicial', autenticar, async (req, res) => {
  try {
    const { ip, userAgent } = extrairMetadados(req);

    const consentimentos = await lgpdService.registrarConsentimentosIniciais(
      req.usuario.id, ip, userAgent
    );

    res.json({
      sucesso: true,
      mensagem: 'Consentimentos registrados com sucesso',
      consentimentos
    });
  } catch (error) {
    console.error('[LGPD] Erro ao registrar consentimentos iniciais:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/consentimentos
 * Listar consentimentos do usuário
 */
router.get('/consentimentos', autenticar, async (req, res) => {
  try {
    const consentimentos = await lgpdService.listarConsentimentos(req.usuario.id);

    res.json({
      sucesso: true,
      consentimentos
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar consentimentos:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * DELETE /api/lgpd/consentimento/:tipo
 * Revogar consentimento
 */
router.delete('/consentimento/:tipo', autenticar, async (req, res) => {
  try {
    const { tipo } = req.params;

    const consentimento = await lgpdService.revogarConsentimento(req.usuario.id, tipo);

    res.json({
      sucesso: true,
      mensagem: 'Consentimento revogado com sucesso',
      consentimento
    });
  } catch (error) {
    console.error('[LGPD] Erro ao revogar consentimento:', error);
    res.status(400).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/verificar
 * Verificar se usuário tem consentimentos pendentes
 */
router.get('/verificar', autenticar, async (req, res) => {
  try {
    const pendentes = await lgpdService.verificarConsentimentosPendentes(req.usuario.id);
    const versoes = lgpdService.getVersoesDocumentos();

    res.json({
      sucesso: true,
      consentimentosValidos: pendentes.length === 0,
      pendentes,
      versoes
    });
  } catch (error) {
    console.error('[LGPD] Erro ao verificar consentimentos:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/versoes
 * Obter versões atuais dos documentos
 */
router.get('/versoes', (req, res) => {
  const versoes = lgpdService.getVersoesDocumentos();
  res.json({
    sucesso: true,
    versoes,
    documentos: {
      privacidade: '/politica-privacidade.html',
      termos_uso: '/termos-uso.html'
    }
  });
});

/**
 * POST /api/lgpd/solicitar-exclusao
 * Solicitar exclusão de dados
 */
router.post('/solicitar-exclusao', autenticar, exclusaoDadosLimiter, async (req, res) => {
  try {
    const { tipo, recurso_id, motivo } = req.body;

    if (!tipo) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Tipo de exclusão é obrigatório (meus_dados, dispositivo, motorista)'
      });
    }

    const organizacaoId = req.usuario.organizacao_id || null;

    const solicitacao = await lgpdService.solicitarExclusao(
      req.usuario.id, organizacaoId, tipo, recurso_id, motivo
    );

    res.json({
      sucesso: true,
      mensagem: 'Solicitação de exclusão registrada. Será processada em até 15 dias úteis.',
      solicitacao
    });
  } catch (error) {
    console.error('[LGPD] Erro ao solicitar exclusão:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/solicitacoes-exclusao
 * Listar solicitações de exclusão (admin)
 */
router.get('/solicitacoes-exclusao', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { status, usuario_id } = req.query;
    const filtros = {
      organizacao_id: req.usuario.organizacao_id
    };
    if (status) filtros.status = status;
    if (usuario_id) filtros.usuario_id = parseInt(usuario_id);

    const solicitacoes = await lgpdService.listarSolicitacoesExclusao(filtros);

    res.json({
      sucesso: true,
      solicitacoes
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar solicitações:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/lgpd/processar-exclusao/:id
 * Processar solicitação de exclusão (admin)
 */
router.post('/processar-exclusao/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { aprovar, motivo_recusa } = req.body;

    if (aprovar === undefined) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Campo "aprovar" é obrigatório (true/false)'
      });
    }

    const resultado = await lgpdService.processarExclusao(
      parseInt(id), req.usuario.id, aprovar, motivo_recusa
    );

    res.json({
      sucesso: true,
      mensagem: aprovar ? 'Exclusão processada com sucesso' : 'Solicitação recusada',
      resultado
    });
  } catch (error) {
    console.error('[LGPD] Erro ao processar exclusão:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/meus-dados
 * Exportar todos os dados do usuário (portabilidade)
 */
router.get('/meus-dados', autenticar, exportacaoDadosLimiter, async (req, res) => {
  try {
    const dados = await lgpdService.exportarDadosUsuario(req.usuario.id);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="meus-dados-${Date.now()}.json"`);
    res.json(dados);
  } catch (error) {
    console.error('[LGPD] Erro ao exportar dados:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * DELETE /api/lgpd/dispositivo/:id
 * Excluir dispositivo com todos os dados (cascata)
 */
router.delete('/dispositivo/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmar } = req.body;

    if (confirmar !== 'EXCLUIR') {
      return res.status(400).json({
        erro: true,
        mensagem: 'Para confirmar, envie { "confirmar": "EXCLUIR" }'
      });
    }

    const resultado = await lgpdService.excluirDadosDispositivo(parseInt(id));

    res.json({
      sucesso: true,
      mensagem: 'Dispositivo e todos os dados associados foram excluídos',
      resultado
    });
  } catch (error) {
    console.error('[LGPD] Erro ao excluir dispositivo:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * DELETE /api/lgpd/motorista/:id
 * Anonimizar dados de motorista
 */
router.delete('/motorista/:id', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmar } = req.body;

    if (confirmar !== 'ANONIMIZAR') {
      return res.status(400).json({
        erro: true,
        mensagem: 'Para confirmar, envie { "confirmar": "ANONIMIZAR" }'
      });
    }

    const resultado = await lgpdService.excluirDadosMotorista(parseInt(id));

    res.json({
      sucesso: true,
      mensagem: 'Dados do motorista foram anonimizados',
      resultado
    });
  } catch (error) {
    console.error('[LGPD] Erro ao anonimizar motorista:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

// ============ ENDPOINTS DE RETENÇÃO DE DADOS ============

/**
 * GET /api/lgpd/retencao/politicas
 * Obter políticas de retenção de dados (admin)
 */
router.get('/retencao/politicas', autenticar, apenasAdmin, (req, res) => {
  const politicas = dataRetentionService.getPolicies();

  res.json({
    sucesso: true,
    politicas,
    descricao: {
      localizacoes: 'Histórico de localizações GPS',
      dados_obd2: 'Dados de telemetria OBD2',
      viagens: 'Registros de viagens',
      alarmes: 'Alarmes e eventos',
      audit_logs: 'Logs de auditoria (obrigação legal)',
      refresh_tokens: 'Tokens de autenticação expirados',
      geofence_eventos: 'Eventos de entrada/saída de cercas',
      notificacoes: 'Notificações lidas',
      system_metrics: 'Métricas do sistema'
    }
  });
});

/**
 * GET /api/lgpd/retencao/estimativa
 * Obter estimativa de dados a serem excluídos (admin)
 */
router.get('/retencao/estimativa', autenticar, apenasAdmin, async (req, res) => {
  try {
    const estimativa = await dataRetentionService.getCleanupEstimate();

    res.json({
      sucesso: true,
      estimativa,
      mensagem: 'Estimativa de registros que serão excluídos na próxima limpeza'
    });
  } catch (error) {
    console.error('[LGPD] Erro ao obter estimativa:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/retencao/status
 * Obter status da última execução da limpeza (admin)
 */
router.get('/retencao/status', autenticar, apenasAdmin, (req, res) => {
  const status = dataRetentionService.getLastRunStats();

  res.json({
    sucesso: true,
    ultimaExecucao: status.lastRun,
    estatisticas: status.stats,
    proxima: status.lastRun
      ? new Date(new Date(status.lastRun).getTime() + 6 * 60 * 60 * 1000)
      : 'Aguardando primeira execução'
  });
});

/**
 * POST /api/lgpd/retencao/executar
 * Executar limpeza manual (super admin)
 */
router.post('/retencao/executar', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    console.log(`[LGPD] Limpeza manual iniciada por ${req.usuario.email}`);

    const resultado = await dataRetentionService.runFullCleanup();

    res.json({
      sucesso: true,
      mensagem: 'Limpeza de dados executada com sucesso',
      resultado
    });
  } catch (error) {
    console.error('[LGPD] Erro na limpeza manual:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

// ============ ENDPOINTS ADMINISTRATIVOS (SUPER_ADMIN) ============

/**
 * GET /api/lgpd/admin/estatisticas
 * Obter estatísticas gerais LGPD (super admin)
 */
router.get('/admin/estatisticas', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const estatisticas = await lgpdService.obterEstatisticasLGPD();

    res.json({
      sucesso: true,
      estatisticas
    });
  } catch (error) {
    console.error('[LGPD] Erro ao obter estatísticas:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/admin/organizacoes
 * Listar todas organizações com status LGPD (super admin)
 */
router.get('/admin/organizacoes', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const organizacoes = await lgpdService.listarOrganizacoesComStatusLGPD();

    res.json({
      sucesso: true,
      organizacoes
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar organizações:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/admin/usuarios
 * Listar todos usuários com status de consentimento (super admin)
 * Query params: organizacao_id (opcional)
 */
router.get('/admin/usuarios', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { organizacao_id } = req.query;
    const filtros = {};
    if (organizacao_id) filtros.organizacao_id = parseInt(organizacao_id);

    const usuarios = await lgpdService.listarUsuariosComConsentimentos(filtros);

    res.json({
      sucesso: true,
      usuarios,
      total: usuarios.length
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar usuários:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/admin/motoristas
 * Listar motoristas com status de consentimento
 * Admin: apenas da sua organização
 * Super admin: todas ou filtradas por organizacao_id
 */
router.get('/admin/motoristas', autenticar, apenasAdmin, async (req, res) => {
  try {
    let organizacaoId;

    if (req.usuario.role === 'super_admin') {
      organizacaoId = req.query.organizacao_id ? parseInt(req.query.organizacao_id) : null;
      if (!organizacaoId) {
        return res.status(400).json({
          erro: true,
          mensagem: 'Para super_admin, organizacao_id é obrigatório'
        });
      }
    } else {
      organizacaoId = req.usuario.organizacao_id;
    }

    const motoristas = await lgpdService.listarMotoristasComConsentimentos(organizacaoId);

    res.json({
      sucesso: true,
      motoristas,
      total: motoristas.length
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar motoristas:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/admin/usuarios-organizacao
 * Listar usuários da própria organização (admin)
 */
router.get('/admin/usuarios-organizacao', autenticar, apenasAdmin, async (req, res) => {
  try {
    const organizacaoId = req.usuario.organizacao_id;

    if (!organizacaoId) {
      return res.status(400).json({
        erro: true,
        mensagem: 'Usuário não está associado a uma organização'
      });
    }

    const usuarios = await lgpdService.listarUsuariosComConsentimentos({
      organizacao_id: organizacaoId
    });

    res.json({
      sucesso: true,
      usuarios,
      total: usuarios.length
    });
  } catch (error) {
    console.error('[LGPD] Erro ao listar usuários da organização:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

// ============ ENDPOINTS PARA MOTORISTAS (APP MOBILE) ============

/**
 * POST /api/lgpd/motorista/consentimento
 * Registrar consentimento de motorista (APP)
 */
router.post('/motorista/consentimento', async (req, res) => {
  try {
    const { motorista_id, tipo, versao } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!motorista_id || !tipo || !versao) {
      return res.status(400).json({
        erro: true,
        mensagem: 'motorista_id, tipo e versão são obrigatórios'
      });
    }

    const consentimento = await lgpdService.registrarConsentimentoMotorista(
      parseInt(motorista_id), tipo, versao, ip, userAgent
    );

    res.json({
      sucesso: true,
      mensagem: 'Consentimento registrado com sucesso',
      consentimento
    });
  } catch (error) {
    console.error('[LGPD] Erro ao registrar consentimento de motorista:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * POST /api/lgpd/motorista/consentimento/inicial
 * Registrar consentimentos iniciais de motorista (APP)
 */
router.post('/motorista/consentimento/inicial', async (req, res) => {
  try {
    const { motorista_id } = req.body;
    const { ip, userAgent } = extrairMetadados(req);

    if (!motorista_id) {
      return res.status(400).json({
        erro: true,
        mensagem: 'motorista_id é obrigatório'
      });
    }

    const consentimentos = await lgpdService.registrarConsentimentosIniciaisMotorista(
      parseInt(motorista_id), ip, userAgent
    );

    res.json({
      sucesso: true,
      mensagem: 'Consentimentos registrados com sucesso',
      consentimentos
    });
  } catch (error) {
    console.error('[LGPD] Erro ao registrar consentimentos de motorista:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/motorista/verificar/:motorista_id
 * Verificar consentimentos pendentes de motorista (APP)
 */
router.get('/motorista/verificar/:motorista_id', async (req, res) => {
  try {
    const { motorista_id } = req.params;

    const pendentes = await lgpdService.verificarConsentimentosPendentesMotorista(
      parseInt(motorista_id)
    );
    const versoes = lgpdService.getVersoesDocumentos();

    res.json({
      sucesso: true,
      consentimentosValidos: pendentes.length === 0,
      pendentes,
      versoes
    });
  } catch (error) {
    console.error('[LGPD] Erro ao verificar consentimentos de motorista:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

/**
 * GET /api/lgpd/motorista/meus-dados/:motorista_id
 * Exportar dados de motorista (portabilidade - APP)
 */
router.get('/motorista/meus-dados/:motorista_id', exportacaoDadosLimiter, async (req, res) => {
  try {
    const { motorista_id } = req.params;

    const dados = await lgpdService.exportarDadosMotorista(parseInt(motorista_id));

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="meus-dados-motorista-${Date.now()}.json"`);
    res.json(dados);
  } catch (error) {
    console.error('[LGPD] Erro ao exportar dados de motorista:', error);
    res.status(500).json({
      erro: true,
      mensagem: error.message
    });
  }
});

module.exports = router;
