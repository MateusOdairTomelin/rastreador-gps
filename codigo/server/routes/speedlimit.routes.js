/**
 * Rotas de API para Limite de Velocidade
 * Consulta limites de velocidade das vias via OpenStreetMap
 */

const express = require('express');
const router = express.Router();
const speedLimitService = require('../services/speedlimit.service');

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/speedlimit?lat=XXX&lng=XXX - Consulta limite de velocidade de uma coordenada
router.get('/', asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetros lat e lng são obrigatórios'
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetros lat e lng devem ser números válidos'
    });
  }

  const resultado = await speedLimitService.getSpeedLimit(latitude, longitude);

  res.json({
    sucesso: true,
    dados: resultado
  });
}));

// GET /api/speedlimit/check?lat=XXX&lng=XXX&velocidade=XXX - Verifica violação de velocidade
router.get('/check', asyncHandler(async (req, res) => {
  const { lat, lng, velocidade } = req.query;

  if (!lat || !lng || !velocidade) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetros lat, lng e velocidade são obrigatórios'
    });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  const speed = parseFloat(velocidade);

  if (isNaN(latitude) || isNaN(longitude) || isNaN(speed)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetros devem ser números válidos'
    });
  }

  const resultado = await speedLimitService.checkSpeedViolation(speed, latitude, longitude);

  res.json({
    sucesso: true,
    dados: resultado
  });
}));

// GET /api/speedlimit/cache-stats - Estatísticas do cache
router.get('/cache-stats', (req, res) => {
  const stats = speedLimitService.getCacheStats();

  res.json({
    sucesso: true,
    dados: stats
  });
});

module.exports = router;
