/**
 * Rotas de API para o Servico GPS Unificado
 *
 * Endpoints centralizados para correcao de rotas GPS.
 * Use estes endpoints em TODAS as telas que precisam corrigir rotas.
 * ✅ Multi-tenant: Filtra por organização do usuário
 */

const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');

// ✅ Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant } = require('../middleware/tenant-device.middleware');

// Servico unificado
const gpsUnificado = require('../services/gps-unificado.service');

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ==================== CORRECAO DE ROTAS ====================

/**
 * POST /api/gps-unificado/:imei/corrigir-rota
 * Corrige uma rota completa usando o pipeline unificado
 *
 * Body: { pontos: Array, opcoes?: Object }
 * Retorna: { pontos: Array, estatisticas: Object }
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.post('/:imei/corrigir-rota', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { pontos, opcoes } = req.body;

  if (!pontos || !Array.isArray(pontos) || pontos.length === 0) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Array de pontos e obrigatorio'
    });
  }

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  // Corrigir rota
  const resultado = await gpsUnificado.corrigirRota(
    pontos,
    { ...opcoes, imei },
    dispositivo.id
  );

  res.json({
    sucesso: true,
    dados: resultado
  });
}));

/**
 * GET /api/gps-unificado/:imei/historico-corrigido
 * Retorna historico de localizacoes com correcao aplicada
 *
 * Query: horas=24, usarReferencias=true, usarKalman=true
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/historico-corrigido', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const opcoes = {
    usarReferencias: req.query.usarReferencias !== 'false',
    usarKalman: req.query.usarKalman !== 'false',
    usarSnapToRoad: req.query.usarSnapToRoad === 'true',
    treinar: req.query.treinar !== 'false'
  };

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

  // Buscar localizacoes
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: timestampLimite }
    },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length === 0) {
    return res.json({
      sucesso: true,
      dados: {
        pontos: [],
        estatisticas: { pontos_originais: 0 }
      }
    });
  }

  // Preparar pontos
  const pontos = localizacoes.map(l => ({
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    hdop: l.precisao,
    timestamp: l.timestamp,
    ignicao: l.ignicao
  }));

  // Corrigir
  const resultado = await gpsUnificado.corrigirRota(pontos, opcoes, dispositivo.id);

  res.json({
    sucesso: true,
    dados: {
      imei,
      veiculo: dispositivo.veiculo,
      periodo_horas: horas,
      opcoes_usadas: opcoes,
      ...resultado
    }
  });
}));

// ==================== PRE-ANALISE ====================

/**
 * GET /api/gps-unificado/:imei/pre-analise
 * Pre-analisa uma rota sem aplicar correcoes
 * Retorna estatisticas e sugestoes
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/pre-analise', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: timestampLimite }
    },
    orderBy: { timestamp: 'asc' }
  });

  const pontos = localizacoes.map(l => ({
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    hdop: l.precisao,
    timestamp: l.timestamp
  }));

  const analise = await gpsUnificado.preAnalisarRota(pontos, dispositivo.id);

  res.json({
    sucesso: true,
    dados: {
      imei,
      veiculo: dispositivo.veiculo,
      periodo_horas: horas,
      analise
    }
  });
}));

// ==================== VIAGENS ====================

/**
 * GET /api/gps-unificado/:imei/viagem/:viagemId/corrigir
 * Corrige uma viagem especifica
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/viagem/:viagemId/corrigir', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const viagem = await prisma.viagem.findFirst({
    where: {
      id: parseInt(viagemId),
      dispositivo_id: dispositivo.id
    }
  });

  if (!viagem) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Viagem nao encontrada'
    });
  }

  // Buscar localizacoes da viagem
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: {
        gte: viagem.inicio,
        lte: viagem.fim
      }
    },
    orderBy: { timestamp: 'asc' }
  });

  const pontos = localizacoes.map(l => ({
    id: l.id,
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    hdop: l.precisao,
    timestamp: l.timestamp
  }));

  // Pre-analise
  const analise = await gpsUnificado.preAnalisarRota(pontos, dispositivo.id);

  // Corrigir
  const resultado = await gpsUnificado.corrigirRota(pontos, { imei }, dispositivo.id);

  res.json({
    sucesso: true,
    dados: {
      viagem: {
        id: viagem.id,
        inicio: viagem.inicio,
        fim: viagem.fim,
        duracao_minutos: viagem.duracao_minutos,
        distancia_km: viagem.distancia_km,
        velocidade_media: viagem.velocidade_media,
        velocidade_max: viagem.velocidade_max
      },
      analise_pre: analise,
      correcao: resultado
    }
  });
}));

/**
 * POST /api/gps-unificado/:imei/viagem/:viagemId/aplicar
 * Aplica correcao a uma viagem e salva no banco
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.post('/:imei/viagem/:viagemId/aplicar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;
  const { avaliacao, comentario } = req.body;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const viagem = await prisma.viagem.findFirst({
    where: {
      id: parseInt(viagemId),
      dispositivo_id: dispositivo.id
    }
  });

  if (!viagem) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Viagem nao encontrada'
    });
  }

  // Buscar localizacoes
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: {
        gte: viagem.inicio,
        lte: viagem.fim
      }
    },
    orderBy: { timestamp: 'asc' }
  });

  const pontosOriginais = localizacoes.map(l => ({
    id: l.id,
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    timestamp: l.timestamp
  }));

  // Corrigir
  const resultado = await gpsUnificado.corrigirRota(pontosOriginais, { imei }, dispositivo.id);

  // Aplicar correcoes no banco
  let atualizados = 0;
  for (let i = 0; i < resultado.pontos.length; i++) {
    const ponto = resultado.pontos[i];
    const original = pontosOriginais[i];

    if (ponto.corrigido && original.id) {
      await prisma.localizacao.update({
        where: { id: original.id },
        data: {
          latitude: ponto.latitude,
          longitude: ponto.longitude,
          precisao: -10 // Flag: corrigido pelo sistema unificado
        }
      });

      // Registrar correcao
      await prisma.correcaoGPS.create({
        data: {
          dispositivo_id: dispositivo.id,
          lat_original: original.latitude,
          lon_original: original.longitude,
          vel_original: original.velocidade,
          lat_corrigido: ponto.latitude,
          lon_corrigido: ponto.longitude,
          vel_corrigido: ponto.velocidade || original.velocidade,
          motivo: ponto.metodo || 'unificado',
          metodo: 'gps_unificado',
          confianca: ponto.confianca || 0.8,
          distancia_correcao: ponto.correcao_metros || 0,
          status: 'aprovado',
          avaliacao: avaliacao || 5,
          avaliado_em: new Date(),
          timestamp: original.timestamp
        }
      });

      atualizados++;
    }
  }

  // Treinar com feedback
  await gpsUnificado.treinarComFeedback(
    dispositivo.id,
    pontosOriginais,
    resultado.pontos,
    true,
    avaliacao || 5
  );

  // Salvar aprovacao
  await prisma.aprovacaoRota.upsert({
    where: {
      dispositivo_id_viagem_id: {
        dispositivo_id: dispositivo.id,
        viagem_id: viagem.id
      }
    },
    create: {
      dispositivo_id: dispositivo.id,
      viagem_id: viagem.id,
      data_inicio: viagem.inicio,
      data_fim: viagem.fim,
      status: 'aprovado',
      pontos_originais: JSON.stringify(pontosOriginais.map(p => ({ lat: p.latitude, lng: p.longitude }))),
      pontos_corrigidos: JSON.stringify(resultado.pontos.map(p => ({ lat: p.latitude, lng: p.longitude }))),
      estatisticas: JSON.stringify(resultado.estatisticas),
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date()
    },
    update: {
      status: 'aprovado',
      pontos_corrigidos: JSON.stringify(resultado.pontos.map(p => ({ lat: p.latitude, lng: p.longitude }))),
      estatisticas: JSON.stringify(resultado.estatisticas),
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date()
    }
  });

  res.json({
    sucesso: true,
    mensagem: `${atualizados} pontos corrigidos e salvos`,
    dados: {
      viagem_id: viagem.id,
      pontos_atualizados: atualizados,
      estatisticas: resultado.estatisticas
    }
  });
}));

// ==================== ESTATISTICAS ====================

/**
 * GET /api/gps-unificado/:imei/estatisticas
 * Retorna estatisticas do sistema unificado
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/estatisticas', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const stats = await gpsUnificado.obterEstatisticas(imei);

  res.json({
    sucesso: true,
    dados: {
      imei,
      ...stats
    }
  });
}));

/**
 * GET /api/gps-unificado/config
 * Retorna configuracao do sistema unificado
 */
router.get('/config', (req, res) => {
  res.json({
    sucesso: true,
    config: gpsUnificado.CONFIG
  });
});

// ==================== TREINAMENTO ====================

/**
 * POST /api/gps-unificado/:imei/treinar
 * Treina a IA com feedback manual
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.post('/:imei/treinar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { pontos_originais, pontos_corrigidos, aprovado, avaliacao } = req.body;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const resultado = await gpsUnificado.treinarComFeedback(
    dispositivo.id,
    pontos_originais,
    pontos_corrigidos,
    aprovado !== false,
    avaliacao || (aprovado !== false ? 5 : 1)
  );

  res.json({
    sucesso: resultado.sucesso,
    mensagem: resultado.sucesso
      ? `Treinamento concluido: ${resultado.treinados} pontos processados`
      : resultado.motivo,
    dados: resultado
  });
}));

// ==================== SNAP-TO-ROAD (Encaixar nas Estradas) ====================

/**
 * GET /api/gps-unificado/:imei/snap-to-road
 * Encaixa pontos GPS nas estradas reais usando OSRM
 * Compara a rota com as linhas de estrada do mapa
 *
 * Query: horas=6, radiusMetros=25, maxDistancia=50
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/snap-to-road', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 6;
  const radiusMetros = parseInt(req.query.radiusMetros) || 25;
  const maxDistancia = parseInt(req.query.maxDistancia) || 50;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

  // Buscar localizacoes
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: timestampLimite }
    },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length < 2) {
    return res.json({
      sucesso: true,
      dados: {
        pontos: [],
        estatisticas: { total_pontos: 0 },
        mensagem: 'Poucos pontos para analise'
      }
    });
  }

  // Preparar pontos
  const pontos = localizacoes.map(l => ({
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    timestamp: l.timestamp
  }));

  // Chamar snap-to-road
  const resultado = await gpsUnificado.snapToRoad(pontos, {
    radiusMetros,
    maxDistanciaCorrecao: maxDistancia
  });

  res.json({
    sucesso: resultado.sucesso,
    dados: {
      imei,
      veiculo: dispositivo.veiculo,
      periodo_horas: horas,
      ...resultado
    }
  });
}));

/**
 * GET /api/gps-unificado/:imei/comparar-estradas
 * Compara rota GPS com estradas reais e retorna analise de desvio
 *
 * Query: horas=6
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/comparar-estradas', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 6;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: timestampLimite }
    },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length < 2) {
    return res.json({
      sucesso: true,
      dados: {
        analise: { qualidade: 'indefinida', total_pontos: 0 },
        mensagem: 'Poucos pontos para analise'
      }
    });
  }

  const pontos = localizacoes.map(l => ({
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    direcao: l.direcao || 0,
    timestamp: l.timestamp
  }));

  const resultado = await gpsUnificado.compararComEstradas(pontos, dispositivo.id);

  res.json({
    sucesso: resultado.sucesso,
    dados: {
      imei,
      veiculo: dispositivo.veiculo,
      periodo_horas: horas,
      ...resultado
    }
  });
}));

/**
 * POST /api/gps-unificado/:imei/aplicar-snap-to-road
 * Aplica snap-to-road e salva no banco
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.post('/:imei/aplicar-snap-to-road', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { horas, avaliacao } = req.body;
  const periodo = parseInt(horas) || 6;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado'
    });
  }

  const timestampLimite = new Date(Date.now() - periodo * 60 * 60 * 1000);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: timestampLimite }
    },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length < 2) {
    return res.json({
      sucesso: false,
      mensagem: 'Poucos pontos para aplicar correcao'
    });
  }

  const pontos = localizacoes.map(l => ({
    id: l.id,
    latitude: l.latitude,
    longitude: l.longitude,
    velocidade: l.velocidade || 0,
    timestamp: l.timestamp
  }));

  const resultado = await gpsUnificado.snapToRoad(pontos);

  if (!resultado.sucesso) {
    return res.json({
      sucesso: false,
      mensagem: resultado.erro || 'Erro ao processar snap-to-road'
    });
  }

  // Aplicar correcoes no banco
  let atualizados = 0;
  for (let i = 0; i < resultado.pontos.length; i++) {
    const ponto = resultado.pontos[i];
    const original = localizacoes[i];

    if (ponto.snapped && original) {
      await prisma.localizacao.update({
        where: { id: original.id },
        data: {
          latitude: ponto.latitude,
          longitude: ponto.longitude,
          precisao: -20 // Flag: corrigido por snap-to-road
        }
      });

      // Registrar correcao
      await prisma.correcaoGPS.create({
        data: {
          dispositivo_id: dispositivo.id,
          lat_original: ponto.lat_original,
          lon_original: ponto.lon_original,
          vel_original: original.velocidade || 0,
          lat_corrigido: ponto.latitude,
          lon_corrigido: ponto.longitude,
          vel_corrigido: original.velocidade || 0,
          motivo: 'snap_to_road',
          metodo: 'osrm',
          confianca: ponto.confianca_snap || 0.9,
          distancia_correcao: ponto.distancia_snap || 0,
          status: 'aprovado',
          avaliacao: avaliacao || 5,
          avaliado_em: new Date(),
          timestamp: original.timestamp
        }
      });

      atualizados++;
    }
  }

  res.json({
    sucesso: true,
    mensagem: `${atualizados} pontos encaixados nas estradas`,
    dados: {
      pontos_atualizados: atualizados,
      estatisticas: resultado.estatisticas
    }
  });
}));

module.exports = router;
