/**
 * Middleware de Autenticação para Motoristas (App Mobile)
 *
 * Valida JWT com tipo 'motorista' no payload
 * Popula req.motorista com dados do motorista
 */

const authMotoristaService = require('../services/auth-motorista.service');

/**
 * Middleware de autenticação para motoristas
 * Verifica se o token é válido e do tipo 'motorista'
 */
async function autenticarMotorista(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      erro: true,
      mensagem: 'Token não fornecido',
      codigo: 'NO_TOKEN'
    });
  }

  const parts = authHeader.split(' ');

  if (parts.length !== 2) {
    return res.status(401).json({
      erro: true,
      mensagem: 'Token mal formatado',
      codigo: 'TOKEN_MALFORMED'
    });
  }

  const [scheme, token] = parts;

  if (!/^Bearer$/i.test(scheme)) {
    return res.status(401).json({
      erro: true,
      mensagem: 'Token mal formatado',
      codigo: 'TOKEN_MALFORMED'
    });
  }

  const decoded = authMotoristaService.verifyAccessToken(token);

  if (!decoded) {
    return res.status(401).json({
      erro: true,
      mensagem: 'Token inválido ou expirado',
      codigo: 'TOKEN_INVALID'
    });
  }

  // Verificar se é token de motorista
  if (decoded.tipo !== 'motorista') {
    return res.status(401).json({
      erro: true,
      mensagem: 'Token não é de motorista',
      codigo: 'WRONG_TOKEN_TYPE'
    });
  }

  // Adiciona dados do motorista ao request
  req.motorista = {
    id: decoded.motoristaId,
    organizacao_id: decoded.organizacaoId,
    nome: decoded.nome
  };

  // Salvar token no request para possível logout
  req.token = token;

  return next();
}

/**
 * Middleware opcional de autenticação para motoristas
 * Se token presente, valida e adiciona motorista ao request
 * Se não presente, continua sem autenticação
 */
function autenticarMotoristaOpcional(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || !/^Bearer$/i.test(parts[0])) {
    return next();
  }

  const decoded = authMotoristaService.verifyAccessToken(parts[1]);

  if (decoded && decoded.tipo === 'motorista') {
    req.motorista = {
      id: decoded.motoristaId,
      organizacao_id: decoded.organizacaoId,
      nome: decoded.nome
    };
  }

  return next();
}

/**
 * Extrai IP, User-Agent e informações do dispositivo do request
 */
function extrairMetadadosDispositivo(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.headers['x-real-ip'] ||
             req.connection?.remoteAddress ||
             req.socket?.remoteAddress ||
             null;

  const userAgent = req.headers['user-agent'] || null;

  // Informações adicionais do dispositivo (enviadas pelo app)
  const deviceInfo = req.headers['x-device-info'] || req.body?.device_info || null;

  return { ip, userAgent, deviceInfo };
}

module.exports = {
  autenticarMotorista,
  autenticarMotoristaOpcional,
  extrairMetadadosDispositivo
};
