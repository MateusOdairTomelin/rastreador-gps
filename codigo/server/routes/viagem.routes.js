/**
 * Rotas de API para Viagens
 * Gerencia dados de viagem para TODOS os dispositivos (incluindo OBD2)
 * ✅ Integrado com IA GPS para correção automática de rotas
 */

const express = require('express');
const router = express.Router();
const viagemService = require('../services/viagem.service');
const prisma = require('../db/prisma');

// ✅ Correção GPS via OSRM Map-Matching (IA removida - OSRM é mais eficiente)
const GPS_CORRECAO_DISPONIVEL = true;

// ✅ NOVO: Serviço GPS Unificado (central)
let gpsUnificado = null;
try {
  gpsUnificado = require('../services/gps-unificado.service');
  console.log('[Viagens] GPS Unificado carregado');
} catch (e) {
  console.warn('[Viagens] GPS Unificado não disponível:', e.message);
}

// ✅ OSRM Snap-to-Road (ajusta pontos às estradas reais)
const OSRM_HOST = process.env.OSRM_HOST || 'osrm-sul-brasil';
const OSRM_URL = `http://${OSRM_HOST}:5000/match/v1/driving`;

/**
 * Snap-to-Road usando OSRM - Encaixa pontos GPS nas estradas reais
 * Baseado nos pontos GPS reais captados pelo rastreador
 */
async function snapToRoadOSRM(localizacoes) {
  const MAX_COORDS_PER_REQUEST = 100;
  const MAX_GAP_SEGUNDOS = 300;
  const MAX_DISTANCIA_METROS = 2000;

  if (localizacoes.length < 2) {
    return { pontos: localizacoes, info: { confianca: '0%' } };
  }

  const fetch = (await import('node-fetch')).default;
  const todosOsPontos = [];
  let confiancaTotal = 0;
  let matchCount = 0;

  // Segmentar por gaps de tempo/distância
  const segmentos = segmentarRotaPorGaps(localizacoes, MAX_GAP_SEGUNDOS, MAX_DISTANCIA_METROS);

  for (const segmento of segmentos) {
    if (segmento.length < 2) {
      todosOsPontos.push(...segmento.map(p => ({
        ...p,
        latitude: p.latitude,
        longitude: p.longitude,
        matched: false,
        metodo: 'segmento_pequeno'
      })));
      continue;
    }

    // Dividir em chunks
    const chunks = [];
    for (let i = 0; i < segmento.length; i += MAX_COORDS_PER_REQUEST) {
      chunks.push(segmento.slice(i, Math.min(i + MAX_COORDS_PER_REQUEST, segmento.length)));
    }

    for (const chunk of chunks) {
      try {
        const resultado = await processarChunkComOSRM(chunk, fetch);
        todosOsPontos.push(...resultado.pontos);
        confiancaTotal += resultado.confianca;
        matchCount++;
      } catch (e) {
        console.warn(`[Viagens OSRM] Erro no chunk: ${e.message}`);
        todosOsPontos.push(...chunk.map(p => ({
          ...p,
          latitude: p.latitude,
          longitude: p.longitude,
          matched: false,
          metodo: 'erro_osrm'
        })));
      }
    }
  }

  return {
    pontos: todosOsPontos,
    info: {
      confianca: matchCount > 0 ? (confiancaTotal / matchCount).toFixed(1) + '%' : '0%',
      segmentos: segmentos.length,
      total_processados: todosOsPontos.length
    }
  };
}

/**
 * Segmenta rota por gaps de tempo ou distância
 */
function segmentarRotaPorGaps(localizacoes, maxGapSegundos, maxDistanciaMetros) {
  const segmentos = [];
  let segmentoAtual = [];

  for (let i = 0; i < localizacoes.length; i++) {
    const ponto = localizacoes[i];

    if (segmentoAtual.length === 0) {
      segmentoAtual.push(ponto);
      continue;
    }

    const pontoAnterior = segmentoAtual[segmentoAtual.length - 1];
    const tempoAnterior = new Date(pontoAnterior.timestamp).getTime();
    const tempoAtual = new Date(ponto.timestamp).getTime();
    const gapSegundos = (tempoAtual - tempoAnterior) / 1000;

    const distancia = calcularDistanciaMetros(
      pontoAnterior.latitude, pontoAnterior.longitude,
      ponto.latitude, ponto.longitude
    );

    if (gapSegundos > maxGapSegundos || distancia > maxDistanciaMetros) {
      if (segmentoAtual.length > 0) {
        segmentos.push(segmentoAtual);
      }
      segmentoAtual = [ponto];
    } else {
      segmentoAtual.push(ponto);
    }
  }

  if (segmentoAtual.length > 0) {
    segmentos.push(segmentoAtual);
  }

  return segmentos;
}

/**
 * Processa chunk com OSRM
 */
async function processarChunkComOSRM(chunk, fetch) {
  const pontos = [];
  let confianca = 0;

  const coordsString = chunk.map(l => `${l.longitude},${l.latitude}`).join(';');
  const timestamps = chunk.map(l => Math.floor(new Date(l.timestamp).getTime() / 1000)).join(';');
  const radiuses = chunk.map(() => '25').join(';');

  const url = `${OSRM_URL}/${coordsString}?timestamps=${timestamps}&radiuses=${radiuses}&geometries=geojson&overview=full&annotations=true&gaps=ignore`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    timeout: 30000
  });

  if (!response.ok) {
    throw new Error(`OSRM retornou ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== 'Ok' || !data.tracepoints) {
    // Fallback sem timestamps
    const urlSimples = `${OSRM_URL}/${coordsString}?radiuses=${radiuses}&geometries=geojson&overview=full`;
    const response2 = await fetch(urlSimples);
    const data2 = await response2.json();

    if (data2.code !== 'Ok') {
      throw new Error(`OSRM match falhou: ${data2.code}`);
    }
  }

  // Processar tracepoints
  const tracepoints = data.tracepoints || [];
  for (let i = 0; i < chunk.length; i++) {
    const tp = tracepoints[i];
    const pontoOriginal = chunk[i];

    if (tp && tp.location) {
      const distanciaSnap = calcularDistanciaMetros(
        pontoOriginal.latitude, pontoOriginal.longitude,
        tp.location[1], tp.location[0]
      );

      pontos.push({
        ...pontoOriginal,
        latitude: tp.location[1],
        longitude: tp.location[0],
        lat_original: pontoOriginal.latitude,
        lon_original: pontoOriginal.longitude,
        matched: true,
        metodo: 'snap_to_road',
        distancia_snap: distanciaSnap,
        nome_rua: tp.name || null
      });
      confianca += 90;
    } else {
      pontos.push({
        ...pontoOriginal,
        latitude: pontoOriginal.latitude,
        longitude: pontoOriginal.longitude,
        matched: false,
        metodo: 'sem_match'
      });
      confianca += 30;
    }
  }

  return { pontos, confianca: pontos.length > 0 ? confianca / pontos.length : 0 };
}

/**
 * Calcula distância em metros entre dois pontos
 */
function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ✅ Multi-tenant: Verifica se dispositivo pertence à organização do usuário
const verificarDispositivoTenant = async (req, res, next) => {
  const { imei } = req.params;
  if (!imei) return next();

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    select: { id: true, imei: true, organizacao_id: true }
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Super admin pode acessar qualquer dispositivo
  if (req.tenant?.isSuperAdmin) {
    req.dispositivo = dispositivo;
    return next();
  }

  // Verificar se pertence à organização do usuário
  if (req.tenant?.id && dispositivo.organizacao_id !== req.tenant.id) {
    return res.status(403).json({
      sucesso: false,
      mensagem: 'Dispositivo não pertence à sua organização',
    });
  }

  req.dispositivo = dispositivo;
  next();
};

/**
 * Funcao auxiliar para processar rota - ✅ Usa OSRM Snap-to-Road como base
 * Encaixa os pontos GPS reais nas estradas do mapa
 */
async function processarRotaComIA(pontos, dispositivoId, imei) {
  // ✅ USAR OSRM SNAP-TO-ROAD (baseado nos pontos GPS reais)
  try {
    console.log(`[Viagens] Processando ${pontos.length} pontos com OSRM snap-to-road`);
    const resultado = await snapToRoadOSRM(pontos);

    // Formatar para compatibilidade com codigo existente
    return resultado.pontos.map((p, i) => ({
      latitude: p.latitude,
      longitude: p.longitude,
      velocidade: p.velocidade || pontos[i]?.velocidade,
      timestamp: p.timestamp || pontos[i]?.timestamp,
      corrigido_ia: p.matched || false,
      ia_metodo: p.metodo || 'snap_to_road',
      confianca: p.matched ? 0.9 : 0.3,
      nome_rua: p.nome_rua || null,
      distancia_snap: p.distancia_snap || 0
    }));
  } catch (e) {
    console.warn('[Viagens] Erro no OSRM, usando fallback:', e.message);
  }

  // FALLBACK: Usar servico unificado se disponivel
  if (gpsUnificado && dispositivoId) {
    try {
      const resultado = await gpsUnificado.corrigirRota(pontos, {
        usarReferencias: false,
        usarKalman: false,
        imei
      }, dispositivoId);

      return resultado.pontos.map((p, i) => ({
        latitude: p.latitude,
        longitude: p.longitude,
        velocidade: p.velocidade || pontos[i]?.velocidade,
        timestamp: p.timestamp || pontos[i]?.timestamp,
        corrigido_ia: p.corrigido || false,
        ia_metodo: p.metodo || null,
        confianca: p.confianca || 0.5
      }));
    } catch (e) {
      console.warn('[Viagens] Erro no GPS Unificado:', e.message);
    }
  }

  // Se nenhum servico disponivel, retornar pontos originais
  return pontos.map(p => ({ ...p, corrigido_ia: false }));
}

// GET /api/viagens/:imei/atual - Viagem atual em andamento
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/atual', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const resultado = await viagemService.getViagemAtual(imei);

  if (!resultado) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  res.json({
    sucesso: true,
    dados: resultado,
  });
}));

// GET /api/viagens/:imei/historico - Histórico de viagens
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/historico', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const limite = parseInt(req.query.limite) || 20;

  const viagens = await viagemService.getHistoricoViagens(imei, limite);

  res.json({
    sucesso: true,
    dados: {
      total: viagens.length,
      viagens: viagens.map(v => ({
        id: v.id,
        inicio: v.inicio,
        fim: v.fim,
        duracao_minutos: v.duracao_minutos,
        distancia_km: v.distancia_km,
        velocidade_media: v.velocidade_media,
        velocidade_max: v.velocidade_max,
        origem: { lat: v.origem_lat, lng: v.origem_lng },
        destino: { lat: v.destino_lat, lng: v.destino_lng },
      })),
    },
  });
}));

// GET /api/viagens/:imei/estatisticas - Estatísticas de um período
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/estatisticas', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { dataInicio, dataFim } = req.query;

  // Default: últimos 30 dias
  const fim = dataFim ? new Date(dataFim) : new Date();
  const inicio = dataInicio ? new Date(dataInicio) : new Date(fim.getTime() - 30 * 24 * 60 * 60 * 1000);

  const estatisticas = await viagemService.getEstatisticasPeriodo(imei, inicio, fim);

  if (!estatisticas) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  res.json({
    sucesso: true,
    dados: {
      periodo: { inicio, fim },
      ...estatisticas,
    },
  });
}));

// GET /api/viagens/:imei/:viagemId/rota - Trajeto de uma viagem específica
// ⚠️ Correção de IA desativada por padrão - requer aprovação prévia
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/:viagemId/rota', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;
  const { corrigido } = req.query;

  // ✅ Correção ATIVADA por padrão para todos os dispositivos
  const aplicarCorrecao = corrigido !== 'false' && GPS_CORRECAO_DISPONIVEL;

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Buscar viagem
  const viagem = await prisma.viagem.findFirst({
    where: {
      id: parseInt(viagemId),
      dispositivo_id: dispositivo.id,
    },
  });

  if (!viagem) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Viagem não encontrada',
    });
  }

  // Buscar localizações durante o período da viagem
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: {
        gte: viagem.inicio,
        lte: viagem.fim,
      },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      latitude: true,
      longitude: true,
      velocidade: true,
      direcao: true,
      timestamp: true,
    },
  });

  // ✅ Aplicar correção de IA se habilitado
  let pontosFinais = localizacoes.map(loc => ({
    lat: loc.latitude,
    lng: loc.longitude,
    velocidade: loc.velocidade,
    direcao: loc.direcao,
    timestamp: loc.timestamp,
  }));

  let estatisticasIA = null;

  if (aplicarCorrecao && localizacoes.length > 1) {
    try {
      // Preparar pontos para processamento
      const pontosParaIA = localizacoes.map(loc => ({
        latitude: loc.latitude,
        longitude: loc.longitude,
        velocidade: loc.velocidade,
        timestamp: loc.timestamp,
      }));

      // Processar rota completa com IA (usando servico unificado)
      const pontosCorrigidos = await processarRotaComIA(pontosParaIA, dispositivo.id, imei);

      // Calcular estatísticas
      const totalCorrigidos = pontosCorrigidos.filter(p => p.corrigido_ia).length;

      estatisticasIA = {
        ativada: true,
        pontos_analisados: pontosCorrigidos.length,
        pontos_corrigidos: totalCorrigidos,
        taxa_correcao: ((totalCorrigidos / pontosCorrigidos.length) * 100).toFixed(2) + '%',
      };

      // Atualizar pontos com coordenadas corrigidas
      pontosFinais = pontosCorrigidos.map((p, i) => ({
        lat: p.latitude,
        lng: p.longitude,
        velocidade: p.velocidade || localizacoes[i]?.velocidade,
        direcao: localizacoes[i]?.direcao,
        timestamp: p.timestamp,
        corrigido_ia: p.corrigido_ia || false,
      }));

    } catch (iaError) {
      console.warn(`[Viagem Rota] Erro na correção IA: ${iaError.message}`);
      estatisticasIA = { ativada: false, erro: iaError.message };
    }
  }

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
        velocidade_max: viagem.velocidade_max,
        origem: { lat: viagem.origem_lat, lng: viagem.origem_lng },
        destino: { lat: viagem.destino_lat, lng: viagem.destino_lng },
      },
      rota: {
        total_pontos: pontosFinais.length,
        ia_correcao: estatisticasIA,
        pontos: pontosFinais,
      },
    },
  });
}));

// GET /api/viagens/:imei/atual/rota - Trajeto da viagem em andamento
// ⚠️ Correção de IA desativada por padrão - requer aprovação prévia
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/atual/rota', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { corrigido } = req.query;

  // ✅ Correção ATIVADA por padrão para todos os dispositivos
  const aplicarCorrecao = corrigido !== 'false' && GPS_CORRECAO_DISPONIVEL;

  // Buscar dispositivo com dados de viagem
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    select: {
      id: true,
      viagem_inicio: true,
      viagem_odometro: true,
      viagem_vel_max: true,
      viagem_vel_soma: true,
      viagem_vel_count: true,
    },
  });

  if (!dispositivo || !dispositivo.viagem_inicio) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Nenhuma viagem em andamento',
    });
  }

  // Buscar localizações desde o início da viagem
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: {
        gte: dispositivo.viagem_inicio,
      },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      latitude: true,
      longitude: true,
      velocidade: true,
      direcao: true,
      timestamp: true,
    },
  });

  const duracaoMs = Date.now() - dispositivo.viagem_inicio.getTime();
  const duracaoMinutos = duracaoMs / (1000 * 60);
  const velocidadeMedia = dispositivo.viagem_vel_count > 0
    ? dispositivo.viagem_vel_soma / dispositivo.viagem_vel_count
    : 0;

  // ✅ Aplicar correção de IA se habilitado
  let pontosFinais = localizacoes.map(loc => ({
    lat: loc.latitude,
    lng: loc.longitude,
    velocidade: loc.velocidade,
    direcao: loc.direcao,
    timestamp: loc.timestamp,
  }));

  let estatisticasIA = null;

  if (aplicarCorrecao && localizacoes.length > 1) {
    try {
      const pontosParaIA = localizacoes.map(loc => ({
        latitude: loc.latitude,
        longitude: loc.longitude,
        velocidade: loc.velocidade,
        timestamp: loc.timestamp,
      }));

      // ✅ Usar servico unificado
      const pontosCorrigidos = await processarRotaComIA(pontosParaIA, dispositivo.id, imei);
      const totalCorrigidos = pontosCorrigidos.filter(p => p.corrigido_ia).length;

      estatisticasIA = {
        ativada: true,
        pontos_analisados: pontosCorrigidos.length,
        pontos_corrigidos: totalCorrigidos,
        taxa_correcao: ((totalCorrigidos / pontosCorrigidos.length) * 100).toFixed(2) + '%',
      };

      pontosFinais = pontosCorrigidos.map((p, i) => ({
        lat: p.latitude,
        lng: p.longitude,
        velocidade: p.velocidade || localizacoes[i]?.velocidade,
        direcao: localizacoes[i]?.direcao,
        timestamp: p.timestamp,
        corrigido_ia: p.corrigido_ia || false,
      }));

    } catch (iaError) {
      console.warn(`[Viagem Atual] Erro na correção IA: ${iaError.message}`);
      estatisticasIA = { ativada: false, erro: iaError.message };
    }
  }

  res.json({
    sucesso: true,
    dados: {
      viagem: {
        em_andamento: true,
        inicio: dispositivo.viagem_inicio,
        duracao_minutos: parseFloat(duracaoMinutos.toFixed(1)),
        distancia_km: parseFloat((dispositivo.viagem_odometro || 0).toFixed(2)),
        velocidade_media: parseFloat(velocidadeMedia.toFixed(1)),
        velocidade_max: dispositivo.viagem_vel_max || 0,
      },
      rota: {
        total_pontos: pontosFinais.length,
        ia_correcao: estatisticasIA,
        pontos: pontosFinais,
      },
    },
  });
}));

// ============== SISTEMA DE APROVAÇÃO DE CORREÇÕES ==============

// GET /api/viagens/:imei/:viagemId/preview-correcao - Preview da correção (antes de aplicar)
// Retorna rota original e rota corrigida lado a lado para aprovação
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/:viagemId/preview-correcao', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;

  if (!GPS_CORRECAO_DISPONIVEL) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Serviço de correção GPS não disponível',
    });
  }

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Buscar viagem
  const viagem = await prisma.viagem.findFirst({
    where: {
      id: parseInt(viagemId),
      dispositivo_id: dispositivo.id,
    },
  });

  if (!viagem) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Viagem não encontrada',
    });
  }

  // Verificar se já existe aprovação para esta viagem
  const aprovacaoExistente = await prisma.aprovacaoRota.findUnique({
    where: {
      dispositivo_id_viagem_id: {
        dispositivo_id: dispositivo.id,
        viagem_id: viagem.id,
      },
    },
  });

  // Buscar localizações durante o período da viagem
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: {
        gte: viagem.inicio,
        lte: viagem.fim,
      },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      latitude: true,
      longitude: true,
      velocidade: true,
      direcao: true,
      timestamp: true,
    },
  });

  if (localizacoes.length < 2) {
    return res.json({
      sucesso: true,
      dados: {
        viagem: {
          id: viagem.id,
          inicio: viagem.inicio,
          fim: viagem.fim,
          duracao_minutos: viagem.duracao_minutos,
          distancia_km: viagem.distancia_km,
        },
        preview: null,
        mensagem: 'Poucos pontos para análise',
      },
    });
  }

  // Pontos originais
  const pontosOriginais = localizacoes.map(loc => ({
    id: loc.id,
    lat: loc.latitude,
    lng: loc.longitude,
    velocidade: loc.velocidade,
    direcao: loc.direcao,
    timestamp: loc.timestamp,
  }));

  // ✅ USAR OSRM SNAP-TO-ROAD (baseado nos pontos GPS reais)
  const pontosParaOSRM = localizacoes.map(loc => ({
    id: loc.id,
    latitude: loc.latitude,
    longitude: loc.longitude,
    velocidade: loc.velocidade,
    timestamp: loc.timestamp,
  }));

  let pontosCorrigidos;
  let estatisticas;

  try {
    // ✅ OSRM Snap-to-Road - Encaixa pontos nas estradas reais
    console.log(`[Viagens IA] Processando ${pontosParaOSRM.length} pontos com OSRM snap-to-road`);
    const resultadoOSRM = await snapToRoadOSRM(pontosParaOSRM);

    pontosCorrigidos = resultadoOSRM.pontos.map((p, i) => ({
      id: localizacoes[i]?.id,
      lat: p.latitude,
      lng: p.longitude,
      velocidade: p.velocidade || localizacoes[i]?.velocidade,
      direcao: localizacoes[i]?.direcao,
      timestamp: p.timestamp,
      corrigido: p.matched || false,
      metodo: p.metodo || 'snap_to_road',
      nome_rua: p.nome_rua || null,
      distancia_snap: p.distancia_snap || 0,
    }));

    // Calcular estatísticas da correção OSRM
    const totalCorrigidos = pontosCorrigidos.filter(p => p.corrigido).length;
    const pontosSnapped = resultadoOSRM.pontos.filter(p => p.matched).length;

    // Calcular distância total movida pelas correções
    let distanciaCorrecao = 0;
    for (let i = 0; i < pontosOriginais.length; i++) {
      const pCorrigido = pontosCorrigidos[i];
      if (pCorrigido && pCorrigido.corrigido) {
        distanciaCorrecao += calcularDistanciaMetros(
          pontosOriginais[i].lat, pontosOriginais[i].lng,
          pCorrigido.lat, pCorrigido.lng
        );
      }
    }

    // Calcular desvio médio
    const desvioMedio = totalCorrigidos > 0 ? distanciaCorrecao / totalCorrigidos : 0;

    estatisticas = {
      total_pontos: pontosOriginais.length,
      pontos_corrigidos: totalCorrigidos,
      pontos_snapped: pontosSnapped,
      taxa_correcao: ((totalCorrigidos / pontosOriginais.length) * 100).toFixed(1) + '%',
      metodo: 'OSRM Snap-to-Road',
      desvio_medio_metros: desvioMedio.toFixed(2),
      distancia_correcao_metros: Math.round(distanciaCorrecao),
      confianca: resultadoOSRM.info.confianca,
      qualidade_score: Math.min(100, Math.round((pontosSnapped / pontosOriginais.length) * 100)),
    };

    console.log(`[Viagens IA] OSRM: ${totalCorrigidos}/${pontosOriginais.length} pontos encaixados nas estradas`);

  } catch (iaError) {
    console.error('[Viagens IA] Erro OSRM:', iaError.message);
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao processar correção OSRM: ' + iaError.message,
    });
  }

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
        velocidade_max: viagem.velocidade_max,
        origem: { lat: viagem.origem_lat, lng: viagem.origem_lng },
        destino: { lat: viagem.destino_lat, lng: viagem.destino_lng },
      },
      aprovacao: aprovacaoExistente ? {
        status: aprovacaoExistente.status,
        avaliacao: aprovacaoExistente.avaliacao,
        comentario: aprovacaoExistente.comentario,
        aprovado_em: aprovacaoExistente.aprovado_em,
      } : null,
      preview: {
        rota_original: pontosOriginais,
        rota_corrigida: pontosCorrigidos,
        estatisticas,
      },
    },
  });
}));

// ==================== PRE-ANALISE (Botao IA em Acoes) ====================

// GET /api/viagens/:imei/:viagemId/pre-analise - Pre-analisa viagem antes de corrigir
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/:viagemId/pre-analise', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo nao encontrado' });
  }

  // Buscar viagem
  const viagem = await prisma.viagem.findFirst({
    where: { id: parseInt(viagemId), dispositivo_id: dispositivo.id },
  });

  if (!viagem) {
    return res.status(404).json({ sucesso: false, mensagem: 'Viagem nao encontrada' });
  }

  // Buscar localizacoes
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: viagem.inicio, lte: viagem.fim },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      latitude: true,
      longitude: true,
      velocidade: true,
      direcao: true,
      timestamp: true,
      precisao: true,
    },
  });

  if (localizacoes.length < 3) {
    return res.json({
      sucesso: true,
      dados: {
        viagem_id: viagem.id,
        analise: {
          total_pontos: localizacoes.length,
          qualidade_geral: 100,
          recomendacao: 'Poucos pontos para analise',
          precisa_correcao: false,
        },
      },
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
  }));

  // Usar servico unificado para pre-analise
  let analise = {
    total_pontos: pontos.length,
    pontos_validos: pontos.length,
    pontos_invalidos: 0,
    pontos_com_salto: 0,
    qualidade_geral: 100,
    sugestoes_correcao: 0,
    recomendacao: 'Rota com boa qualidade',
    precisa_correcao: false,
  };

  if (gpsUnificado && gpsUnificado.preAnalisarRota) {
    try {
      const analiseUnificada = await gpsUnificado.preAnalisarRota(pontos, dispositivo.id);
      analise = {
        ...analise,
        ...analiseUnificada,
        precisa_correcao: analiseUnificada.qualidade_geral < 80 || analiseUnificada.sugestoes_correcao > 0,
        recomendacao: analiseUnificada.qualidade_geral >= 90
          ? 'Rota com excelente qualidade, correcao opcional'
          : analiseUnificada.qualidade_geral >= 70
            ? 'Rota com boa qualidade, correcao recomendada para maior precisao'
            : analiseUnificada.qualidade_geral >= 50
              ? 'Rota com qualidade regular, correcao RECOMENDADA'
              : 'Rota com problemas de qualidade, correcao NECESSARIA',
      };
    } catch (e) {
      console.warn('[Viagens] Erro na pre-analise:', e.message);
    }
  }

  // Verificar se ja existe aprovacao
  const aprovacaoExistente = await prisma.aprovacaoRota.findUnique({
    where: {
      dispositivo_id_viagem_id: { dispositivo_id: dispositivo.id, viagem_id: viagem.id },
    },
  });

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
      },
      ja_corrigida: aprovacaoExistente?.status === 'aprovado',
      analise,
    },
  });
}));

// POST /api/viagens/:imei/:viagemId/aprovar-correcao - Aprovar correção proposta
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/:viagemId/aprovar-correcao', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;
  const { avaliacao, comentario } = req.body;

  // Buscar dispositivo e viagem
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
  }

  const viagem = await prisma.viagem.findFirst({
    where: { id: parseInt(viagemId), dispositivo_id: dispositivo.id },
  });
  if (!viagem) {
    return res.status(404).json({ sucesso: false, mensagem: 'Viagem não encontrada' });
  }

  // Buscar localizações originais
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: viagem.inicio, lte: viagem.fim },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Processar correção
  const pontosParaIA = localizacoes.map(loc => ({
    latitude: loc.latitude,
    longitude: loc.longitude,
    velocidade: loc.velocidade,
    timestamp: loc.timestamp,
  }));

  // ✅ Usar servico unificado
  const pontosCorrigidos = await processarRotaComIA(pontosParaIA, dispositivo.id, imei);

  // Salvar ou atualizar aprovação
  const aprovacao = await prisma.aprovacaoRota.upsert({
    where: {
      dispositivo_id_viagem_id: {
        dispositivo_id: dispositivo.id,
        viagem_id: viagem.id,
      },
    },
    create: {
      dispositivo_id: dispositivo.id,
      viagem_id: viagem.id,
      data_inicio: viagem.inicio,
      data_fim: viagem.fim,
      status: 'aprovado',
      pontos_originais: JSON.stringify(localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }))),
      pontos_corrigidos: JSON.stringify(pontosCorrigidos.map(p => ({ lat: p.latitude, lng: p.longitude }))),
      estatisticas: JSON.stringify({
        total_pontos: localizacoes.length,
        corrigidos: pontosCorrigidos.filter(p => p.corrigido_ia).length,
      }),
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date(),
    },
    update: {
      status: 'aprovado',
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date(),
    },
  });

  // IA removida - OSRM Map-Matching não precisa de treinamento

  res.json({
    sucesso: true,
    mensagem: 'Correção aprovada e salva com sucesso.',
    dados: {
      aprovacao_id: aprovacao.id,
      status: 'aprovado',
    },
  });
}));

// GET /api/viagens/:imei/:viagemId/pontos-corrigidos - Buscar pontos corrigidos aprovados
// ✅ Retorna pontos corrigidos da aprovação se existir, senão retorna null
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/:viagemId/pontos-corrigidos', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
  }

  // Buscar aprovação da viagem
  const aprovacao = await prisma.aprovacaoRota.findUnique({
    where: {
      dispositivo_id_viagem_id: {
        dispositivo_id: dispositivo.id,
        viagem_id: parseInt(viagemId),
      },
    },
  });

  // Se não existe aprovação ou não está aprovada, retorna null
  if (!aprovacao || aprovacao.status !== 'aprovado') {
    return res.json({
      sucesso: true,
      aprovado: false,
      pontos: null,
      mensagem: 'Viagem não possui correção aprovada. Use OSRM em tempo real.',
    });
  }

  // Parsear pontos corrigidos do JSON
  let pontosCorrigidos = [];
  try {
    pontosCorrigidos = JSON.parse(aprovacao.pontos_corrigidos || '[]');
  } catch (e) {
    return res.json({
      sucesso: false,
      mensagem: 'Erro ao parsear pontos corrigidos',
    });
  }

  // Buscar localizações originais para pegar ignicao e velocidade
  const viagem = await prisma.viagem.findUnique({ where: { id: parseInt(viagemId) } });
  if (viagem) {
    const localizacoesOriginais = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: viagem.inicio, lte: viagem.fim },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Enriquecer pontos corrigidos com dados originais (ignicao, velocidade)
    pontosCorrigidos = pontosCorrigidos.map((p, idx) => {
      // Encontrar localização original mais próxima pelo índice proporcional
      const origIdx = Math.min(
        Math.floor((idx / pontosCorrigidos.length) * localizacoesOriginais.length),
        localizacoesOriginais.length - 1
      );
      const orig = localizacoesOriginais[origIdx] || {};

      return {
        latitude: p.lat,
        longitude: p.lng,
        velocidade: orig.velocidade || 0,
        direcao: orig.direcao || 0,
        ignicao: orig.ignicao ?? false,
        timestamp: orig.timestamp || new Date(),
        corrigido_ia: true,
      };
    });
  }

  res.json({
    sucesso: true,
    aprovado: true,
    aprovado_em: aprovacao.aprovado_em,
    avaliacao: aprovacao.avaliacao,
    total_pontos: pontosCorrigidos.length,
    pontos: pontosCorrigidos,
  });
}));

// POST /api/viagens/:imei/:viagemId/rejeitar-correcao - Rejeitar correção proposta
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/:viagemId/rejeitar-correcao', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;
  const { avaliacao, comentario } = req.body;

  // Buscar dispositivo e viagem
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
  }

  const viagem = await prisma.viagem.findFirst({
    where: { id: parseInt(viagemId), dispositivo_id: dispositivo.id },
  });
  if (!viagem) {
    return res.status(404).json({ sucesso: false, mensagem: 'Viagem não encontrada' });
  }

  // Buscar localizações originais
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: viagem.inicio, lte: viagem.fim },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Salvar rejeição
  const aprovacao = await prisma.aprovacaoRota.upsert({
    where: {
      dispositivo_id_viagem_id: {
        dispositivo_id: dispositivo.id,
        viagem_id: viagem.id,
      },
    },
    create: {
      dispositivo_id: dispositivo.id,
      viagem_id: viagem.id,
      data_inicio: viagem.inicio,
      data_fim: viagem.fim,
      status: 'rejeitado',
      pontos_originais: JSON.stringify(localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }))),
      pontos_corrigidos: '[]',
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date(),
    },
    update: {
      status: 'rejeitado',
      avaliacao: avaliacao || null,
      comentario: comentario || null,
      aprovado_em: new Date(),
    },
  });

  // IA removida - OSRM Map-Matching não precisa de treinamento

  res.json({
    sucesso: true,
    mensagem: 'Correção rejeitada e registrada.',
    dados: {
      aprovacao_id: aprovacao.id,
      status: 'rejeitado',
    },
  });
}));

// GET /api/viagens/pendentes-aprovacao - Listar viagens pendentes de aprovação
// ✅ Multi-tenant: Filtra viagens apenas dos dispositivos da organização
router.get('/pendentes-aprovacao', asyncHandler(async (req, res) => {
  const limite = parseInt(req.query.limite) || 50;

  // ✅ Multi-tenant: Construir filtro de dispositivos da organização
  const dispositivoFilter = {};
  if (req.tenant?.id && !req.tenant?.isSuperAdmin) {
    dispositivoFilter.organizacao_id = req.tenant.id;
  }

  // Buscar viagens que não têm aprovação ou estão pendentes
  const viagens = await prisma.viagem.findMany({
    take: limite,
    orderBy: { inicio: 'desc' },
    where: {
      dispositivo: dispositivoFilter,
    },
    include: {
      dispositivo: {
        select: { imei: true, placa: true, veiculo: true, organizacao_id: true },
      },
    },
  });

  // Buscar aprovações existentes
  const aprovacoes = await prisma.aprovacaoRota.findMany({
    where: {
      viagem_id: { in: viagens.map(v => v.id) },
    },
  });

  const aprovacaoMap = new Map(aprovacoes.map(a => [a.viagem_id, a]));

  // Filtrar viagens sem aprovação ou pendentes
  const viagensPendentes = viagens.filter(v => {
    const aprovacao = aprovacaoMap.get(v.id);
    return !aprovacao || aprovacao.status === 'pendente';
  });

  res.json({
    sucesso: true,
    total: viagensPendentes.length,
    dados: viagensPendentes.map(v => ({
      id: v.id,
      imei: v.dispositivo.imei,
      placa: v.dispositivo.placa,
      veiculo: v.dispositivo.veiculo,
      inicio: v.inicio,
      fim: v.fim,
      duracao_minutos: v.duracao_minutos,
      distancia_km: v.distancia_km,
      velocidade_media: v.velocidade_media,
      velocidade_max: v.velocidade_max,
      status_aprovacao: aprovacaoMap.get(v.id)?.status || 'pendente',
    })),
  });
}));

// GET /api/viagens/:imei/:viagemId/rota-estradas - Buscar rota encaixada nas estradas via OSRM
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/:viagemId/rota-estradas', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei, viagemId } = req.params;

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
  }

  // Buscar viagem
  const viagem = await prisma.viagem.findFirst({
    where: { id: parseInt(viagemId), dispositivo_id: dispositivo.id },
  });

  if (!viagem) {
    return res.status(404).json({ sucesso: false, mensagem: 'Viagem não encontrada' });
  }

  // Buscar localizações da viagem
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: viagem.inicio, lte: viagem.fim },
    },
    orderBy: { timestamp: 'asc' },
    select: { latitude: true, longitude: true, timestamp: true },
  });

  if (localizacoes.length < 2) {
    return res.json({
      sucesso: true,
      dados: { rota_estradas: [], mensagem: 'Poucos pontos para encaixar nas estradas' },
    });
  }

  try {
    // Preparar coordenadas para OSRM (formato: lng,lat;lng,lat;...)
    const coordsStr = localizacoes
      .map(l => `${l.longitude},${l.latitude}`)
      .join(';');

    // Chamar OSRM Match API (encaixa pontos GPS nas estradas)
    const osrmUrl = `http://${OSRM_HOST}:5000/match/v1/driving/${coordsStr}?overview=full&geometries=geojson&radiuses=${localizacoes.map(() => '25').join(';')}`;

    const fetch = (await import('node-fetch')).default;
    const osrmRes = await fetch(osrmUrl, { timeout: 10000 });
    const osrmData = await osrmRes.json();

    if (osrmData.code !== 'Ok' || !osrmData.matchings || osrmData.matchings.length === 0) {
      return res.json({
        sucesso: true,
        dados: {
          rota_estradas: [],
          mensagem: 'Não foi possível encaixar a rota nas estradas',
          osrm_code: osrmData.code,
        },
      });
    }

    // Extrair coordenadas da rota nas estradas
    const rotaEstradas = osrmData.matchings[0].geometry.coordinates.map(coord => ({
      lat: coord[1],
      lng: coord[0],
    }));

    // Calcular distância total da rota nas estradas
    const distanciaEstradas = osrmData.matchings[0].distance / 1000; // metros para km

    res.json({
      sucesso: true,
      dados: {
        rota_estradas: rotaEstradas,
        distancia_km: distanciaEstradas,
        confianca: osrmData.matchings[0].confidence || 0,
        pontos_matched: osrmData.tracepoints?.filter(t => t !== null).length || 0,
        pontos_total: localizacoes.length,
      },
    });
  } catch (osrmError) {
    console.error('[Viagem Estradas] Erro OSRM:', osrmError.message);
    res.json({
      sucesso: true,
      dados: {
        rota_estradas: [],
        mensagem: 'Erro ao consultar OSRM: ' + osrmError.message,
      },
    });
  }
}));

// ============== VIAGENS RETROATIVAS ==============

// POST /api/viagens/processar-retroativas - Processar viagens retroativas para dispositivos sem viagens
// ✅ Multi-tenant: Processa apenas dispositivos da organização
router.post('/processar-retroativas', asyncHandler(async (req, res) => {
  const { imei, force } = req.body;

  console.log('[Viagens Retroativas] Iniciando processamento...');

  // ✅ Multi-tenant: Construir filtro base por organização
  const whereClause = {};
  if (imei) {
    whereClause.imei = imei;
  }
  // Filtrar por organização (exceto super_admin)
  if (req.tenant?.id && !req.tenant?.isSuperAdmin) {
    whereClause.organizacao_id = req.tenant.id;
  }

  const dispositivos = await prisma.dispositivo.findMany({
    where: whereClause,
    include: {
      _count: {
        select: { viagens: true, localizacoes: true }
      }
    }
  });

  const resultados = [];
  let totalViagens = 0;
  let totalDistancia = 0;

  for (const dispositivo of dispositivos) {
    // Pular se ja tem viagens e nao esta em modo force
    if (dispositivo._count.viagens > 0 && !force) {
      resultados.push({
        imei: dispositivo.imei,
        status: 'skip',
        motivo: `Ja tem ${dispositivo._count.viagens} viagens`,
      });
      continue;
    }

    // Pular se nao tem localizacoes
    if (dispositivo._count.localizacoes < 5) {
      resultados.push({
        imei: dispositivo.imei,
        status: 'skip',
        motivo: 'Poucas localizacoes',
      });
      continue;
    }

    // Processar viagens retroativas
    const resultado = await processarViagensRetroativas(dispositivo);
    resultados.push({
      imei: dispositivo.imei,
      status: 'ok',
      viagens_criadas: resultado.viagens,
      distancia_km: resultado.distancia.toFixed(2),
      duracao_horas: resultado.duracao.toFixed(2),
    });
    totalViagens += resultado.viagens;
    totalDistancia += resultado.distancia;
  }

  res.json({
    sucesso: true,
    mensagem: `Processamento concluido: ${totalViagens} viagens criadas`,
    resumo: {
      dispositivos_processados: dispositivos.length,
      viagens_criadas: totalViagens,
      distancia_total_km: totalDistancia.toFixed(2),
    },
    resultados,
  });
}));

/**
 * Processa viagens retroativas para um dispositivo
 */
async function processarViagensRetroativas(dispositivo) {
  // Buscar localizacoes ordenadas
  const localizacoes = await prisma.localizacao.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length < 5) {
    return { viagens: 0, distancia: 0, duracao: 0 };
  }

  // Detectar viagens baseado em velocidade > 0
  const viagens = [];
  let viagemAtual = null;
  let ultimaLoc = null;
  let pontosParados = 0;

  for (const loc of localizacoes) {
    const emMovimento = loc.velocidade > 0;

    if (emMovimento && !viagemAtual) {
      viagemAtual = {
        inicio: loc.timestamp,
        origem_lat: parseFloat(loc.latitude),
        origem_lng: parseFloat(loc.longitude),
        pontos: [loc],
        distancia: 0,
        velocidades: [loc.velocidade],
        vel_max: loc.velocidade,
        fim: loc.timestamp,
        destino_lat: parseFloat(loc.latitude),
        destino_lng: parseFloat(loc.longitude)
      };
      pontosParados = 0;
    } else if (viagemAtual) {
      viagemAtual.pontos.push(loc);

      if (ultimaLoc) {
        const dist = calcularDistanciaMetros(
          parseFloat(ultimaLoc.latitude), parseFloat(ultimaLoc.longitude),
          parseFloat(loc.latitude), parseFloat(loc.longitude)
        ) / 1000; // metros para km
        if (dist > 0.01 && dist < 5) {
          viagemAtual.distancia += dist;
        }
      }

      if (loc.velocidade > 0) {
        viagemAtual.velocidades.push(loc.velocidade);
        viagemAtual.vel_max = Math.max(viagemAtual.vel_max, loc.velocidade);
        viagemAtual.fim = loc.timestamp;
        viagemAtual.destino_lat = parseFloat(loc.latitude);
        viagemAtual.destino_lng = parseFloat(loc.longitude);
        pontosParados = 0;
      } else {
        pontosParados++;
      }

      // Fim de viagem
      const tempoDesdeUltimo = ultimaLoc ?
        (loc.timestamp.getTime() - ultimaLoc.timestamp.getTime()) / 60000 : 0;

      if ((pontosParados >= 3 && viagemAtual.velocidades.length > 3) ||
          (tempoDesdeUltimo > 30 && viagemAtual.velocidades.length > 3)) {
        const duracao = (viagemAtual.fim.getTime() - viagemAtual.inicio.getTime()) / 60000;
        const velMedia = viagemAtual.velocidades.reduce((a,b) => a+b, 0) / viagemAtual.velocidades.length;

        if (duracao > 1 && duracao < 480 && viagemAtual.distancia > 0.1) {
          viagens.push({
            dispositivo_id: dispositivo.id,
            inicio: viagemAtual.inicio,
            fim: viagemAtual.fim,
            duracao_minutos: duracao,
            distancia_km: viagemAtual.distancia,
            velocidade_media: velMedia,
            velocidade_max: viagemAtual.vel_max,
            origem_lat: viagemAtual.origem_lat,
            origem_lng: viagemAtual.origem_lng,
            destino_lat: viagemAtual.destino_lat,
            destino_lng: viagemAtual.destino_lng
          });
        }
        viagemAtual = null;
        pontosParados = 0;
      }
    }
    ultimaLoc = loc;
  }

  // Finalizar ultima viagem
  if (viagemAtual && viagemAtual.velocidades.length > 3) {
    const duracao = (viagemAtual.fim.getTime() - viagemAtual.inicio.getTime()) / 60000;
    const velMedia = viagemAtual.velocidades.reduce((a,b) => a+b, 0) / viagemAtual.velocidades.length;
    if (duracao > 1 && duracao < 480 && viagemAtual.distancia > 0.1) {
      viagens.push({
        dispositivo_id: dispositivo.id,
        inicio: viagemAtual.inicio,
        fim: viagemAtual.fim,
        duracao_minutos: duracao,
        distancia_km: viagemAtual.distancia,
        velocidade_media: velMedia,
        velocidade_max: viagemAtual.vel_max,
        origem_lat: viagemAtual.origem_lat,
        origem_lng: viagemAtual.origem_lng,
        destino_lat: viagemAtual.destino_lat,
        destino_lng: viagemAtual.destino_lng
      });
    }
  }

  // Inserir viagens
  for (const viagem of viagens) {
    await prisma.viagem.create({ data: viagem });
  }

  // Atualizar totais
  const totalDist = viagens.reduce((a, v) => a + v.distancia_km, 0);
  const totalHoras = viagens.reduce((a, v) => a + v.duracao_minutos, 0) / 60;

  if (viagens.length > 0) {
    await prisma.dispositivo.update({
      where: { id: dispositivo.id },
      data: {
        odometro_total: { increment: totalDist },
        horimetro_total: { increment: totalHoras }
      }
    });
  }

  console.log(`[Viagens Retroativas] ${dispositivo.imei}: ${viagens.length} viagens criadas (${totalDist.toFixed(2)}km)`);
  return { viagens: viagens.length, distancia: totalDist, duracao: totalHoras };
}

module.exports = router;
