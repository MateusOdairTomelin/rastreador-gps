/**
 * Rotas de API para o Pipeline de Correção GPS
 *
 * Endpoints para:
 * - Monitorar estatísticas do pipeline
 * - Configurar parâmetros
 * - Visualizar dados de treinamento da IA
 * - Testar correções manualmente
 */

const express = require('express');
const router = express.Router();
const { pipeline, PIPELINE_CONFIG } = require('../services/gps-pipeline.service');
const gpsAI = require('../services/gps-ai-correction.service');
const { autenticar } = require('../middleware/auth.middleware');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// ==================== ESTATÍSTICAS ====================

/**
 * GET /api/gps-pipeline/stats
 * Retorna estatísticas do pipeline
 */
router.get('/stats', autenticar, verificarPermissao('sistema', 'visualizar'), (req, res) => {
  try {
    const stats = pipeline.getStats();
    res.json({
      sucesso: true,
      dados: stats,
      config: {
        kalman_enabled: PIPELINE_CONFIG.kalman.enabled,
        ai_enabled: PIPELINE_CONFIG.ai.enabled,
        mapMatching_enabled: PIPELINE_CONFIG.mapMatching.enabled,
        mapMatching_provider: PIPELINE_CONFIG.mapMatching.provider
      }
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/gps-pipeline/ai-stats
 * Retorna estatísticas detalhadas da IA
 */
router.get('/ai-stats', autenticar, verificarPermissao('sistema', 'visualizar'), (req, res) => {
  try {
    const stats = gpsAI.getStats();
    res.json({
      sucesso: true,
      dados: stats
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== TESTE DE CORREÇÃO ====================

/**
 * POST /api/gps-pipeline/test
 * Testa o pipeline com uma posição específica
 *
 * Body: {
 *   latitude: number,
 *   longitude: number,
 *   velocidade: number,
 *   direcao: number,
 *   hdop: number,
 *   imei: string
 * }
 */
router.post('/test', autenticar, verificarPermissao('sistema', 'configurar'), async (req, res) => {
  try {
    const { latitude, longitude, velocidade, direcao, hdop, imei } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        sucesso: false,
        erro: 'latitude e longitude são obrigatórios'
      });
    }

    const resultado = await pipeline.processar({
      latitude,
      longitude,
      velocidade: velocidade || 0,
      direcao: direcao || 0,
      hdop: hdop || 2,
      timestamp: new Date()
    }, imei || 'test_device');

    res.json({
      sucesso: true,
      dados: {
        entrada: { latitude, longitude, velocidade, direcao, hdop },
        saida: {
          latitude: resultado.lat,
          longitude: resultado.lon,
          correcao_metros: resultado.correcao_total_metros,
          pipeline_aplicado: resultado.pipeline,
          tempo_ms: resultado.tempo_processamento_ms
        },
        detalhes: resultado
      }
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/gps-pipeline/test-batch
 * Testa o pipeline com múltiplas posições
 *
 * Body: {
 *   imei: string,
 *   pontos: Array<{latitude, longitude, velocidade, direcao, hdop, timestamp}>
 * }
 */
router.post('/test-batch', autenticar, verificarPermissao('sistema', 'configurar'), async (req, res) => {
  try {
    const { imei, pontos } = req.body;

    if (!pontos || !Array.isArray(pontos) || pontos.length === 0) {
      return res.status(400).json({
        sucesso: false,
        erro: 'pontos deve ser um array não vazio'
      });
    }

    const resultados = await pipeline.processarLote(pontos.map(p => ({
      latitude: p.latitude,
      longitude: p.longitude,
      velocidade: p.velocidade || 0,
      direcao: p.direcao || 0,
      hdop: p.hdop || 2,
      timestamp: p.timestamp || new Date()
    })), imei || 'test_device');

    // Calcular estatísticas do lote
    const correcaoTotal = resultados.reduce((sum, r) => sum + (r.correcao_total_metros || 0), 0);
    const correcaoMedia = correcaoTotal / resultados.length;

    res.json({
      sucesso: true,
      dados: {
        total_pontos: resultados.length,
        correcao_media_metros: correcaoMedia.toFixed(2),
        correcao_total_metros: correcaoTotal.toFixed(2),
        pontos: resultados.map(r => ({
          lat: r.lat,
          lon: r.lon,
          lat_original: r.lat_original,
          lon_original: r.lon_original,
          correcao_metros: r.correcao_total_metros?.toFixed(2),
          pipeline: r.pipeline
        }))
      }
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== CONFIGURAÇÃO ====================

/**
 * GET /api/gps-pipeline/config
 * Retorna configuração atual do pipeline
 */
router.get('/config', autenticar, verificarPermissao('sistema', 'visualizar'), (req, res) => {
  res.json({
    sucesso: true,
    dados: PIPELINE_CONFIG
  });
});

/**
 * POST /api/gps-pipeline/config
 * Atualiza configuração do pipeline (parcial)
 *
 * Body: {
 *   kalman?: { enabled?: boolean, processNoise?: number, ... },
 *   ai?: { enabled?: boolean, minConfidence?: number, ... },
 *   mapMatching?: { enabled?: boolean, provider?: string, ... }
 * }
 */
router.post('/config', autenticar, verificarPermissao('sistema', 'configurar'), (req, res) => {
  try {
    const { kalman, ai, mapMatching } = req.body;

    // Atualizar configurações (merge parcial)
    if (kalman) {
      Object.assign(PIPELINE_CONFIG.kalman, kalman);
    }
    if (ai) {
      Object.assign(PIPELINE_CONFIG.ai, ai);
    }
    if (mapMatching) {
      Object.assign(PIPELINE_CONFIG.mapMatching, mapMatching);
    }

    res.json({
      sucesso: true,
      mensagem: 'Configuração atualizada',
      dados: PIPELINE_CONFIG
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== CONTROLE ====================

/**
 * POST /api/gps-pipeline/reset-kalman/:imei
 * Reseta o filtro de Kalman de um dispositivo específico
 */
router.post('/reset-kalman/:imei', autenticar, verificarPermissao('sistema', 'configurar'), (req, res) => {
  try {
    const { imei } = req.params;
    pipeline.resetKalman(imei);

    res.json({
      sucesso: true,
      mensagem: `Filtro de Kalman resetado para ${imei}`
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/gps-pipeline/save-model
 * Força salvamento do modelo de IA
 */
router.post('/save-model', autenticar, verificarPermissao('sistema', 'configurar'), async (req, res) => {
  try {
    await gpsAI.saveModel();

    res.json({
      sucesso: true,
      mensagem: 'Modelo salvo com sucesso'
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/gps-pipeline/train
 * Treina a IA com feedback manual
 *
 * Body: {
 *   posicao_errada: { latitude, longitude },
 *   posicao_correta: { latitude, longitude },
 *   imei: string
 * }
 */
router.post('/train', autenticar, verificarPermissao('sistema', 'configurar'), (req, res) => {
  try {
    const { posicao_errada, posicao_correta, imei } = req.body;

    if (!posicao_errada || !posicao_correta) {
      return res.status(400).json({
        sucesso: false,
        erro: 'posicao_errada e posicao_correta são obrigatórios'
      });
    }

    gpsAI.treinarComFeedback(posicao_errada, posicao_correta, imei || 'manual');

    res.json({
      sucesso: true,
      mensagem: 'IA treinada com feedback',
      stats: gpsAI.getStats()
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== VISUALIZAÇÃO ====================

/**
 * GET /api/gps-pipeline/regions
 * Lista regiões onde a IA tem dados de treinamento
 */
router.get('/regions', autenticar, verificarPermissao('sistema', 'visualizar'), (req, res) => {
  try {
    // Acessar regionModels via stats (não exposto diretamente)
    const stats = gpsAI.getStats();

    res.json({
      sucesso: true,
      dados: {
        total_regioes: stats.totalRegioes,
        total_amostras: stats.totalAmostras
      }
    });
  } catch (error) {
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/gps-pipeline/help
 * Retorna documentação da API
 */
router.get('/help', autenticar, verificarPermissao('sistema', 'visualizar'), (req, res) => {
  res.json({
    sucesso: true,
    dados: {
      descricao: 'Pipeline de Correção GPS em 3 Camadas',
      camadas: [
        {
          nome: 'Kalman Filter',
          descricao: 'Filtro de Kalman 2D estendido para suavizar ruído do GPS',
          entrada: 'lat, lon, velocidade, heading',
          saida: 'posição suavizada'
        },
        {
          nome: 'IA Correction',
          descricao: 'Modelo adaptativo que aprende padrões de erro por região',
          entrada: 'lat, lon, vel, heading, hdop, histórico',
          saida: 'lat_corrigida, lon_corrigida, confiança',
          recursos: ['Dead reckoning em túneis', 'Aprendizado contínuo', 'Correção por região']
        },
        {
          nome: 'Map-Matching',
          descricao: 'OSRM/Valhalla para colar pontos nas vias reais',
          entrada: 'coordenada corrigida',
          saida: 'ponto na via',
          recursos: ['Feedback para treinar IA', 'Batch processing']
        }
      ],
      endpoints: [
        'GET  /api/gps-pipeline/stats        - Estatísticas do pipeline',
        'GET  /api/gps-pipeline/ai-stats     - Estatísticas da IA',
        'GET  /api/gps-pipeline/config       - Configuração atual',
        'POST /api/gps-pipeline/config       - Atualizar configuração',
        'POST /api/gps-pipeline/test         - Testar correção de ponto',
        'POST /api/gps-pipeline/test-batch   - Testar correção de lote',
        'POST /api/gps-pipeline/train        - Treinar IA com feedback',
        'POST /api/gps-pipeline/save-model   - Salvar modelo',
        'POST /api/gps-pipeline/reset-kalman/:imei - Resetar Kalman'
      ]
    }
  });
});

module.exports = router;
