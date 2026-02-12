/**
 * Rotas de Métricas para Prometheus
 *
 * Endpoints:
 * - GET /metrics - Métricas no formato Prometheus
 * - GET /metrics/json - Métricas em JSON (debug)
 */

const express = require('express');
const router = express.Router();
const metricsService = require('../services/metrics.service');

/**
 * GET /metrics
 * Retorna métricas no formato Prometheus
 */
router.get('/', async (req, res) => {
  try {
    const metrics = await metricsService.getMetrics();
    res.set('Content-Type', metricsService.getContentType());
    res.send(metrics);
  } catch (error) {
    console.error('[Metrics] Erro ao gerar métricas:', error.message);
    res.status(500).send('# Error generating metrics\n');
  }
});

/**
 * GET /metrics/json
 * Retorna métricas em JSON (para debug)
 */
router.get('/json', async (req, res) => {
  try {
    const metrics = await metricsService.getMetricsJson();
    res.json({
      sucesso: true,
      metrics
    });
  } catch (error) {
    console.error('[Metrics] Erro ao gerar métricas JSON:', error.message);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

module.exports = router;
