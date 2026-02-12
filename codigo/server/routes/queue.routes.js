/**
 * Queue Routes - API de Monitoramento de Filas
 * Sistema de Rastreamento Veicular
 */

const express = require('express');
const router = express.Router();
const queueService = require('../services/queue.service');
const { autenticar, apenasAdmin } = require('../middleware/auth.middleware');

/**
 * GET /api/queues/stats
 * Retorna estatísticas de todas as filas
 */
router.get('/stats', autenticar, apenasAdmin, async (req, res) => {
  try {
    const stats = await queueService.getAllStats();
    res.json(stats);
  } catch (error) {
    console.error('[Queue API] Erro ao obter stats:', error.message);
    res.status(500).json({ error: 'Erro ao obter estatísticas das filas' });
  }
});

/**
 * GET /api/queues/:name/stats
 * Retorna estatísticas de uma fila específica
 */
router.get('/:name/stats', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const stats = await queueService.getQueueStats(name);

    if (!stats) {
      return res.status(404).json({ error: `Fila '${name}' não encontrada` });
    }

    res.json(stats);
  } catch (error) {
    console.error(`[Queue API] Erro ao obter stats de ${req.params.name}:`, error.message);
    res.status(500).json({ error: 'Erro ao obter estatísticas da fila' });
  }
});

/**
 * POST /api/queues/:name/pause
 * Pausa uma fila específica
 */
router.post('/:name/pause', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    await queueService.pauseQueue(name);
    res.json({ success: true, message: `Fila '${name}' pausada` });
  } catch (error) {
    console.error(`[Queue API] Erro ao pausar ${req.params.name}:`, error.message);
    res.status(500).json({ error: 'Erro ao pausar fila' });
  }
});

/**
 * POST /api/queues/:name/resume
 * Resume uma fila pausada
 */
router.post('/:name/resume', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    await queueService.resumeQueue(name);
    res.json({ success: true, message: `Fila '${name}' resumida` });
  } catch (error) {
    console.error(`[Queue API] Erro ao resumir ${req.params.name}:`, error.message);
    res.status(500).json({ error: 'Erro ao resumir fila' });
  }
});

/**
 * POST /api/queues/:name/clean
 * Limpa jobs antigos de uma fila
 */
router.post('/:name/clean', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const { grace } = req.body; // Tempo em ms para manter jobs
    await queueService.cleanQueue(name, grace || 3600000);
    res.json({ success: true, message: `Fila '${name}' limpa` });
  } catch (error) {
    console.error(`[Queue API] Erro ao limpar ${req.params.name}:`, error.message);
    res.status(500).json({ error: 'Erro ao limpar fila' });
  }
});

/**
 * GET /api/queues/:name/jobs
 * Lista jobs de uma fila (com paginação)
 */
router.get('/:name/jobs', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name } = req.params;
    const { status = 'waiting', start = 0, end = 20 } = req.query;

    const queue = queueService.queues[name];
    if (!queue) {
      return res.status(404).json({ error: `Fila '${name}' não encontrada` });
    }

    let jobs;
    switch (status) {
      case 'waiting':
        jobs = await queue.getWaiting(parseInt(start), parseInt(end));
        break;
      case 'active':
        jobs = await queue.getActive(parseInt(start), parseInt(end));
        break;
      case 'completed':
        jobs = await queue.getCompleted(parseInt(start), parseInt(end));
        break;
      case 'failed':
        jobs = await queue.getFailed(parseInt(start), parseInt(end));
        break;
      case 'delayed':
        jobs = await queue.getDelayed(parseInt(start), parseInt(end));
        break;
      default:
        jobs = await queue.getWaiting(parseInt(start), parseInt(end));
    }

    // Formatar jobs para resposta
    const formattedJobs = jobs.map(job => ({
      id: job.id,
      name: job.name,
      data: job.data,
      timestamp: job.timestamp,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason,
      finishedOn: job.finishedOn,
      processedOn: job.processedOn,
    }));

    res.json({
      queue: name,
      status,
      count: formattedJobs.length,
      jobs: formattedJobs,
    });
  } catch (error) {
    console.error(`[Queue API] Erro ao listar jobs de ${req.params.name}:`, error.message);
    res.status(500).json({ error: 'Erro ao listar jobs' });
  }
});

/**
 * DELETE /api/queues/:name/jobs/:jobId
 * Remove um job específico
 */
router.delete('/:name/jobs/:jobId', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name, jobId } = req.params;

    const queue = queueService.queues[name];
    if (!queue) {
      return res.status(404).json({ error: `Fila '${name}' não encontrada` });
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `Job '${jobId}' não encontrado` });
    }

    await job.remove();
    res.json({ success: true, message: `Job '${jobId}' removido` });
  } catch (error) {
    console.error(`[Queue API] Erro ao remover job:`, error.message);
    res.status(500).json({ error: 'Erro ao remover job' });
  }
});

/**
 * POST /api/queues/:name/jobs/:jobId/retry
 * Retenta um job que falhou
 */
router.post('/:name/jobs/:jobId/retry', autenticar, apenasAdmin, async (req, res) => {
  try {
    const { name, jobId } = req.params;

    const queue = queueService.queues[name];
    if (!queue) {
      return res.status(404).json({ error: `Fila '${name}' não encontrada` });
    }

    const job = await queue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `Job '${jobId}' não encontrado` });
    }

    await job.retry();
    res.json({ success: true, message: `Job '${jobId}' agendado para retry` });
  } catch (error) {
    console.error(`[Queue API] Erro ao retentar job:`, error.message);
    res.status(500).json({ error: 'Erro ao retentar job' });
  }
});

/**
 * GET /api/queues/health
 * Health check das filas (não requer autenticação)
 */
router.get('/health', async (req, res) => {
  try {
    const stats = await queueService.getAllStats();
    const healthy = stats.enabled && Object.values(stats.queues).every(q => q !== null);

    res.status(healthy ? 200 : 503).json({
      healthy,
      enabled: stats.enabled,
      isWorker: stats.isWorker,
      queues: Object.keys(stats.queues || {}).length,
    });
  } catch (error) {
    res.status(503).json({ healthy: false, error: error.message });
  }
});

module.exports = router;
