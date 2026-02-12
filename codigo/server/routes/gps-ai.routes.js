/**
 * Rotas de API para o serviço de IA GPS
 * Correção inteligente de rotas com detecção de outliers e filtro de Kalman
 * ✅ Multi-tenant: Filtra por organização do usuário
 */

const express = require('express');
const router = express.Router();
const gpsAI = require('../services/gps-ai.service');
const prisma = require('../db/prisma');

// ✅ Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant, criarFiltroDispositivosTenant } = require('../middleware/tenant-device.middleware');

// Servico de pontos de referencia
let gpsReferencia = null;
try {
  gpsReferencia = require('../services/gps-referencia.service');
} catch (e) {
  console.warn('[GPS-AI Routes] Servico de referencias nao disponivel');
}

// ✅ NOVO: Servico GPS Unificado (central)
let gpsUnificado = null;
try {
  gpsUnificado = require('../services/gps-unificado.service');
  console.log('[GPS-AI Routes] GPS Unificado carregado');
} catch (e) {
  console.warn('[GPS-AI Routes] GPS Unificado nao disponivel:', e.message);
}

// ✅ OSRM Snap-to-Road (ajusta pontos às estradas reais)
const OSRM_HOST = process.env.OSRM_HOST || 'osrm-sul-brasil';
const OSRM_URL = `http://${OSRM_HOST}:5000/match/v1/driving`;

/**
 * Snap-to-Road usando OSRM - Encaixa pontos GPS nas estradas reais
 */
async function snapToRoadOSRM(localizacoes) {
  const MAX_COORDS_PER_REQUEST = 100;
  const MAX_GAP_SEGUNDOS = 300;
  const MAX_DISTANCIA_METROS = 2000;

  if (localizacoes.length < 2) {
    return { pontos: localizacoes, info: { confianca: '0%', matched: 0 } };
  }

  const fetch = (await import('node-fetch')).default;
  const todosOsPontos = [];
  let totalMatched = 0;
  let totalDistanciaSnap = 0;

  // Segmentar por gaps
  const segmentos = [];
  let segmentoAtual = [];

  for (let i = 0; i < localizacoes.length; i++) {
    const ponto = localizacoes[i];
    if (segmentoAtual.length === 0) {
      segmentoAtual.push(ponto);
      continue;
    }

    const pontoAnterior = segmentoAtual[segmentoAtual.length - 1];
    const gapSegundos = (new Date(ponto.timestamp) - new Date(pontoAnterior.timestamp)) / 1000;
    const distancia = calcularDistanciaMetros(
      pontoAnterior.latitude, pontoAnterior.longitude,
      ponto.latitude, ponto.longitude
    );

    if (gapSegundos > MAX_GAP_SEGUNDOS || distancia > MAX_DISTANCIA_METROS) {
      if (segmentoAtual.length > 0) segmentos.push(segmentoAtual);
      segmentoAtual = [ponto];
    } else {
      segmentoAtual.push(ponto);
    }
  }
  if (segmentoAtual.length > 0) segmentos.push(segmentoAtual);

  // Processar cada segmento
  for (const segmento of segmentos) {
    if (segmento.length < 2) {
      todosOsPontos.push(...segmento.map(p => ({ ...p, matched: false })));
      continue;
    }

    // Dividir em chunks
    for (let i = 0; i < segmento.length; i += MAX_COORDS_PER_REQUEST) {
      const chunk = segmento.slice(i, Math.min(i + MAX_COORDS_PER_REQUEST, segmento.length));

      try {
        const coordsString = chunk.map(l => `${l.longitude},${l.latitude}`).join(';');
        const radiuses = chunk.map(() => '25').join(';');
        const url = `${OSRM_URL}/${coordsString}?radiuses=${radiuses}&geometries=geojson&overview=full`;

        const response = await fetch(url, { timeout: 30000 });
        const data = await response.json();

        if (data.code === 'Ok' && data.tracepoints) {
          for (let j = 0; j < chunk.length; j++) {
            const tp = data.tracepoints[j];
            const pontoOriginal = chunk[j];

            if (tp && tp.location) {
              const distSnap = calcularDistanciaMetros(
                pontoOriginal.latitude, pontoOriginal.longitude,
                tp.location[1], tp.location[0]
              );
              todosOsPontos.push({
                ...pontoOriginal,
                lat_snapped: tp.location[1],
                lon_snapped: tp.location[0],
                matched: true,
                distancia_snap: distSnap,
                nome_rua: tp.name || null
              });
              totalMatched++;
              totalDistanciaSnap += distSnap;
            } else {
              todosOsPontos.push({ ...pontoOriginal, matched: false });
            }
          }
        } else {
          todosOsPontos.push(...chunk.map(p => ({ ...p, matched: false })));
        }
      } catch (e) {
        todosOsPontos.push(...chunk.map(p => ({ ...p, matched: false })));
      }
    }
  }

  return {
    pontos: todosOsPontos,
    info: {
      total: localizacoes.length,
      matched: totalMatched,
      taxa_match: ((totalMatched / localizacoes.length) * 100).toFixed(1) + '%',
      desvio_medio: totalMatched > 0 ? (totalDistanciaSnap / totalMatched).toFixed(2) : 0,
      confianca: totalMatched > 0 ? Math.round((totalMatched / localizacoes.length) * 100) + '%' : '0%'
    }
  };
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

/**
 * Funcao auxiliar para processar rota - usa servico unificado quando disponivel
 */
async function processarRotaComIA(pontos, dispositivoId, imei) {
  // ✅ Usar servico unificado se disponivel
  if (gpsUnificado && dispositivoId) {
    try {
      const resultado = await gpsUnificado.corrigirRota(pontos, {
        usarReferencias: true,
        usarKalman: true,
        imei
      }, dispositivoId);

      // Formatar para compatibilidade com codigo existente
      return resultado.pontos.map((p, i) => ({
        id: pontos[i]?.id,
        latitude: p.latitude,
        longitude: p.longitude,
        velocidade: p.velocidade || pontos[i]?.velocidade,
        timestamp: p.timestamp || pontos[i]?.timestamp,
        corrigido_ia: p.corrigido || false,
        ia_metodo: p.metodo || null,
        ia_motivo: p.motivo || null,
        confianca: p.confianca || 0.5,
        latOriginal: p.corrigido ? pontos[i]?.latitude : null,
        lonOriginal: p.corrigido ? pontos[i]?.longitude : null
      }));
    } catch (e) {
      console.warn('[GPS-AI Routes] Erro no GPS Unificado, usando fallback:', e.message);
    }
  }

  // FALLBACK: Usar servico de IA antigo
  return await gpsAI.processarRotaCompleta(pontos);
}

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/gps-ai/status - Status do serviço de IA
router.get('/status', async (req, res) => {
  const stats = gpsAI.getStats();

  // Verificar status do OSRM
  let osrmStatus = { disponivel: false };
  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${OSRM_URL}/-49.27,-26.82;-49.28,-26.83?geometries=geojson`, { timeout: 5000 });
    const data = await response.json();
    // OSRM responde mesmo quando não há match - verificar se API está respondendo
    osrmStatus = {
      disponivel: response.ok || data.code === 'NoMatch', // NoMatch também significa que está funcionando
      url: OSRM_URL,
      metodo: 'Snap-to-Road (Map Matching)'
    };
  } catch (e) {
    osrmStatus = { disponivel: false, erro: e.message };
  }

  res.json({
    sucesso: true,
    servico: 'GPS AI - Correção Inteligente de Rotas',
    versao: '2.0.0', // ✅ Nova versão com OSRM
    estatisticas: stats,
    config: {
      maxVelocidade: gpsAI.CONFIG.MAX_VELOCIDADE + ' km/h',
      maxAceleracao: gpsAI.CONFIG.MAX_ACELERACAO + ' m/s²',
      limiarConfianca: gpsAI.CONFIG.LIMIAR_CONFIANCA,
    },
    // ✅ NOVA SEÇÃO: Status OSRM
    osrm: osrmStatus,
    metodo_principal: 'OSRM Snap-to-Road',
    descricao: 'Correção baseada em pontos GPS reais encaixados nas estradas do OpenStreetMap'
  });
});

// GET /api/gps-ai/:imei/corrigir-rota - Corrige rota histórica
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/corrigir-rota', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  // Buscar pontos originais
  const pontosOriginais = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      id: true,
      latitude: true,
      longitude: true,
      velocidade: true,
      timestamp: true,
    },
  });

  if (pontosOriginais.length === 0) {
    return res.json({
      sucesso: true,
      mensagem: 'Nenhum ponto encontrado no período',
      dados: { pontos: [], estatisticas: {} },
    });
  }

  // ✅ Processar rota com servico unificado
  const pontosCorrigidos = await processarRotaComIA(pontosOriginais, dispositivo.id, imei);

  // Calcular estatísticas
  const totalCorrigidos = pontosCorrigidos.filter(p => p.corrigido_ia).length;
  const motivosCorrecao = {};
  pontosCorrigidos.forEach(p => {
    if (p.ia_motivo) {
      motivosCorrecao[p.ia_motivo] = (motivosCorrecao[p.ia_motivo] || 0) + 1;
    }
  });

  res.json({
    sucesso: true,
    dados: {
      dispositivo: {
        imei: dispositivo.imei,
        nome: dispositivo.veiculo || `Dispositivo ${imei}`,
      },
      periodo: {
        inicio: dataInicio,
        fim: new Date(),
        horas,
      },
      estatisticas: {
        total_pontos: pontosOriginais.length,
        pontos_corrigidos: totalCorrigidos,
        taxa_correcao: ((totalCorrigidos / pontosOriginais.length) * 100).toFixed(2) + '%',
        motivos: motivosCorrecao,
      },
      pontos: pontosCorrigidos.map(p => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        velocidade: p.velocidade,
        timestamp: p.timestamp,
        corrigido: p.corrigido_ia || false,
        metodo: p.ia_metodo,
        motivo: p.ia_motivo,
        original: p.latOriginal && p.lonOriginal ? {
          lat: p.latOriginal,
          lon: p.lonOriginal,
        } : null,
      })),
    },
  });
}));

// GET /api/gps-ai/:imei/analisar - Analisa qualidade dos dados GPS
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/analisar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  const pontos = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      latitude: true,
      longitude: true,
      velocidade: true,
      timestamp: true,
    },
  });

  if (pontos.length < 2) {
    return res.json({
      sucesso: true,
      mensagem: 'Dados insuficientes para análise',
      dados: { qualidade: 'indefinida' },
    });
  }

  // Analisar cada ponto
  const analises = [];
  const problemas = [];

  for (let i = 1; i < pontos.length; i++) {
    const analise = gpsAI.detectarOutlier(pontos[i], pontos[i - 1], pontos[i + 1] || null);
    analises.push(analise);

    if (analise.isOutlier) {
      problemas.push({
        indice: i,
        timestamp: pontos[i].timestamp,
        motivo: analise.motivo,
        metricas: analise.metricas,
      });
    }
  }

  // Calcular métricas de qualidade
  const outliers = analises.filter(a => a.isOutlier).length;
  const taxaOutliers = (outliers / analises.length) * 100;

  // Calcular distância total e velocidade média
  let distanciaTotal = 0;
  let velocidadeMedia = 0;
  let velocidadeMax = 0;

  for (let i = 1; i < pontos.length; i++) {
    const dist = gpsAI.calcularDistancia(
      pontos[i - 1].latitude, pontos[i - 1].longitude,
      pontos[i].latitude, pontos[i].longitude
    );
    distanciaTotal += dist;

    if (pontos[i].velocidade > velocidadeMax) {
      velocidadeMax = pontos[i].velocidade;
    }
    velocidadeMedia += pontos[i].velocidade || 0;
  }
  velocidadeMedia /= pontos.length;

  // ✅ ANÁLISE OSRM SNAP-TO-ROAD (baseada nos pontos GPS reais)
  let osrmAnalise = null;
  try {
    console.log(`[GPS-AI] Analisando ${pontos.length} pontos com OSRM para ${imei}`);
    const osrmResult = await snapToRoadOSRM(pontos);

    // Calcular pontos fora da estrada (distância > 15m)
    const pontosForaEstrada = osrmResult.pontos.filter(p => p.matched && p.distancia_snap > 15).length;
    const pontosNasEstradas = osrmResult.pontos.filter(p => p.matched && p.distancia_snap <= 15).length;

    osrmAnalise = {
      total_pontos: osrmResult.info.total,
      pontos_matched: osrmResult.info.matched,
      taxa_match: osrmResult.info.taxa_match,
      desvio_medio_metros: osrmResult.info.desvio_medio,
      pontos_nas_estradas: pontosNasEstradas,
      pontos_fora_estrada: pontosForaEstrada,
      precisao_estradas: osrmResult.info.matched > 0
        ? ((pontosNasEstradas / osrmResult.info.matched) * 100).toFixed(1) + '%'
        : '0%',
      confianca: osrmResult.info.confianca
    };
    console.log(`[GPS-AI] OSRM: ${osrmResult.info.matched}/${osrmResult.info.total} pontos nas estradas`);
  } catch (osrmError) {
    console.warn('[GPS-AI] Erro na análise OSRM:', osrmError.message);
    osrmAnalise = { erro: osrmError.message };
  }

  // Determinar qualidade geral (combinando outliers + OSRM)
  let qualidade = 'excelente';
  let notaBase = 100 - taxaOutliers * 3; // Peso menor para outliers

  // Ajustar nota baseado no OSRM
  if (osrmAnalise && !osrmAnalise.erro) {
    const taxaMatch = parseFloat(osrmAnalise.taxa_match) || 0;
    const precisaoEstradas = parseFloat(osrmAnalise.precisao_estradas) || 0;
    notaBase = (notaBase * 0.4) + (taxaMatch * 0.3) + (precisaoEstradas * 0.3);
  }

  if (notaBase < 50) qualidade = 'ruim';
  else if (notaBase < 70) qualidade = 'regular';
  else if (notaBase < 85) qualidade = 'boa';

  res.json({
    sucesso: true,
    dados: {
      dispositivo: {
        imei: dispositivo.imei,
        nome: dispositivo.veiculo || `Dispositivo ${imei}`,
      },
      periodo: { inicio: dataInicio, fim: new Date(), horas },
      qualidade: {
        classificacao: qualidade,
        nota: Math.max(0, Math.min(100, notaBase)).toFixed(0) + '/100',
        recomendacao: notaBase < 70
          ? 'Correção OSRM recomendada - alguns pontos estão fora das estradas reais'
          : 'Rota de boa qualidade - pontos GPS próximos às estradas reais',
        ia_ativa: true,
        metodo: 'OSRM Snap-to-Road'
      },
      estatisticas: {
        total_pontos: pontos.length,
        outliers: outliers,
        taxa_outliers: taxaOutliers.toFixed(2) + '%',
        distancia_km: (distanciaTotal / 1000).toFixed(2),
        velocidade_media: velocidadeMedia.toFixed(1) + ' km/h',
        velocidade_max: velocidadeMax + ' km/h',
      },
      // ✅ NOVA SEÇÃO: Análise OSRM
      osrm: osrmAnalise,
      problemas: problemas.slice(0, 20),
    },
  });
}));

// POST /api/gps-ai/:imei/treinar - Treina modelo com dados históricos
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/treinar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.body.horas) || 24;

  const resultado = await gpsAI.treinarComHistorico(imei, horas);

  res.json({
    sucesso: resultado.sucesso,
    dados: resultado,
  });
}));

// POST /api/gps-ai/:imei/resetar - Reseta filtro do dispositivo
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/resetar', verificarDispositivoTenant, (req, res) => {
  const { imei } = req.params;

  gpsAI.resetarDispositivo(imei);

  res.json({
    sucesso: true,
    mensagem: `Filtro de Kalman resetado para ${imei}`,
  });
});

// GET /api/gps-ai/:imei/comparar - Compara rota original vs corrigida (para visualização)
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/comparar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 6;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  const pontosOriginais = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    orderBy: { timestamp: 'asc' },
    select: {
      latitude: true,
      longitude: true,
      velocidade: true,
      timestamp: true,
    },
  });

  if (pontosOriginais.length === 0) {
    return res.json({
      sucesso: true,
      dados: { original: [], corrigida: [] },
    });
  }

  // ✅ Processar com servico unificado
  const pontosCorrigidos = await processarRotaComIA(pontosOriginais, dispositivo.id, imei);

  res.json({
    sucesso: true,
    dados: {
      dispositivo: {
        imei: dispositivo.imei,
        nome: dispositivo.veiculo,
      },
      periodo: { horas },
      original: pontosOriginais.map(p => ({
        lat: p.latitude,
        lng: p.longitude,
        vel: p.velocidade,
        ts: p.timestamp,
      })),
      corrigida: pontosCorrigidos.map(p => ({
        lat: p.latitude,
        lng: p.longitude,
        vel: p.velocidade,
        ts: p.timestamp,
        corrigido: p.corrigido_ia,
      })),
      estatisticas: {
        total: pontosOriginais.length,
        corrigidos: pontosCorrigidos.filter(p => p.corrigido_ia).length,
      },
    },
  });
}));

// GET /api/gps-ai/historico-correcoes - Histórico de correções realizadas
router.get('/historico-correcoes', asyncHandler(async (req, res) => {
  const limite = parseInt(req.query.limite) || 100;

  try {
    const correcoes = await prisma.correcaoGPS.findMany({
      orderBy: { created_at: 'desc' },
      take: limite,
    });

    res.json({
      sucesso: true,
      total: correcoes.length,
      dados: correcoes,
    });
  } catch (error) {
    res.json({
      sucesso: true,
      total: 0,
      dados: [],
      mensagem: 'Nenhuma correção registrada ainda',
    });
  }
}));

// ==================== TREINAMENTO SUPERVISIONADO ====================

// GET /api/gps-ai/treinamento/pendentes - Rotas pendentes de revisão
router.get('/treinamento/pendentes', asyncHandler(async (req, res) => {
  const { imei, limite } = req.query;

  const rotas = await gpsAI.listarCorrecoesPendentes(imei, parseInt(limite) || 50);

  // Buscar info dos dispositivos
  const dispositivosIds = [...new Set(rotas.map(r => r.dispositivo_id))];
  const dispositivos = await prisma.dispositivo.findMany({
    where: { id: { in: dispositivosIds } },
    select: { id: true, imei: true, veiculo: true },
  });

  const dispMap = new Map(dispositivos.map(d => [d.id, d]));

  res.json({
    sucesso: true,
    total_rotas: rotas.length,
    total_correcoes: rotas.reduce((sum, r) => sum + r.total_correcoes, 0),
    rotas: rotas.map(r => ({
      ...r,
      dispositivo: dispMap.get(r.dispositivo_id) || { imei: 'desconhecido' },
    })),
  });
}));

// GET /api/gps-ai/treinamento/estatisticas - Estatísticas de treinamento
router.get('/treinamento/estatisticas', asyncHandler(async (req, res) => {
  const stats = await gpsAI.getEstatisticasTreinamento();

  res.json({
    sucesso: true,
    dados: stats,
  });
}));

// GET /api/gps-ai/treinamento/rota/:id - Detalhes de uma rota para revisão
router.get('/treinamento/rota/:id', asyncHandler(async (req, res) => {
  const correcaoId = parseInt(req.params.id);

  // Buscar a correção inicial
  const correcaoInicial = await prisma.correcaoGPS.findUnique({
    where: { id: correcaoId },
  });

  if (!correcaoInicial) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Correção não encontrada',
    });
  }

  // Buscar correções próximas (mesma rota)
  const inicioJanela = new Date(correcaoInicial.timestamp);
  inicioJanela.setMinutes(inicioJanela.getMinutes() - 30);
  const fimJanela = new Date(correcaoInicial.timestamp);
  fimJanela.setMinutes(fimJanela.getMinutes() + 30);

  const correcoesDaRota = await prisma.correcaoGPS.findMany({
    where: {
      dispositivo_id: correcaoInicial.dispositivo_id,
      timestamp: {
        gte: inicioJanela,
        lte: fimJanela,
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Buscar localizações originais para contexto
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: correcaoInicial.dispositivo_id,
      timestamp: {
        gte: inicioJanela,
        lte: fimJanela,
      },
    },
    orderBy: { timestamp: 'asc' },
  });

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { id: correcaoInicial.dispositivo_id },
    select: { imei: true, veiculo: true },
  });

  res.json({
    sucesso: true,
    dados: {
      dispositivo,
      periodo: {
        inicio: inicioJanela,
        fim: fimJanela,
      },
      rota_original: localizacoes.map(l => ({
        lat: l.latitude,
        lng: l.longitude,
        vel: l.velocidade,
        ts: l.timestamp,
      })),
      correcoes: correcoesDaRota.map(c => ({
        id: c.id,
        original: { lat: c.lat_original, lng: c.lon_original },
        corrigido: { lat: c.lat_corrigido, lng: c.lon_corrigido },
        motivo: c.motivo,
        metodo: c.metodo,
        distancia: c.distancia_correcao,
        confianca: c.confianca,
        status: c.status,
        ts: c.timestamp,
      })),
      total_correcoes: correcoesDaRota.length,
    },
  });
}));

// POST /api/gps-ai/treinamento/aprovar - Aprovar uma correção
router.post('/treinamento/aprovar', asyncHandler(async (req, res) => {
  const { correcao_id, avaliacao, comentario } = req.body;

  if (!correcao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'correcao_id é obrigatório',
    });
  }

  const resultado = await gpsAI.aprovarCorrecao(
    parseInt(correcao_id),
    parseInt(avaliacao) || 5,
    comentario
  );

  res.json({
    sucesso: true,
    mensagem: 'Correção aprovada - IA aprendeu com este feedback',
    dados: resultado,
  });
}));

// POST /api/gps-ai/treinamento/rejeitar - Rejeitar uma correção
router.post('/treinamento/rejeitar', asyncHandler(async (req, res) => {
  const { correcao_id, motivo } = req.body;

  if (!correcao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'correcao_id é obrigatório',
    });
  }

  const resultado = await gpsAI.rejeitarCorrecao(
    parseInt(correcao_id),
    motivo
  );

  res.json({
    sucesso: true,
    mensagem: 'Correção rejeitada - IA ajustará parâmetros',
    dados: resultado,
  });
}));

// POST /api/gps-ai/treinamento/avaliar-rota - Aprovar/rejeitar toda uma rota
router.post('/treinamento/avaliar-rota', asyncHandler(async (req, res) => {
  const { correcao_ids, aprovado, avaliacao, comentario } = req.body;

  if (!correcao_ids || !Array.isArray(correcao_ids)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'correcao_ids (array) é obrigatório',
    });
  }

  const resultados = await gpsAI.avaliarRota(
    correcao_ids.map(id => parseInt(id)),
    aprovado === true,
    parseInt(avaliacao) || null,
    comentario
  );

  res.json({
    sucesso: true,
    mensagem: `${resultados.length} correções ${aprovado ? 'aprovadas' : 'rejeitadas'}`,
    total: resultados.length,
    dados: resultados,
  });
}));

// ==================== PONTOS DE REFERENCIA (Alta Precisao) ====================

// GET /api/gps-ai/:imei/referencias/estatisticas - Estatisticas de pontos de referencia
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/referencias/estatisticas', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  if (!gpsReferencia) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Servico de referencias nao disponivel',
    });
  }

  const stats = await gpsReferencia.obterEstatisticasReferencia(imei);

  res.json({
    sucesso: true,
    dados: {
      imei,
      ...stats,
      descricao: 'Pontos de alta precisao (HDOP baixo, trajetoria consistente) usados como referencia para corrigir outros pontos',
    },
  });
}));

// GET /api/gps-ai/:imei/referencias/pontos - Lista pontos de referencia
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/referencias/pontos', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  if (!gpsReferencia) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Servico de referencias nao disponivel',
    });
  }

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado',
    });
  }

  const pontosRef = await gpsReferencia.carregarPontosReferencia(dispositivo.id, horas);

  res.json({
    sucesso: true,
    dados: {
      imei,
      periodo_horas: horas,
      total: pontosRef.length,
      pontos: pontosRef.map(p => ({
        latitude: p.latitude,
        longitude: p.longitude,
        velocidade: p.velocidade,
        direcao: p.direcao,
        timestamp: p.timestamp,
        score: (p.scoreReferencia * 100).toFixed(1) + '%',
        motivos: p.motivos,
        hdop: p.metricas?.hdop,
      })),
    },
  });
}));

// POST /api/gps-ai/:imei/referencias/treinar - Treina IA usando pontos de referencia
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/referencias/treinar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  if (!gpsReferencia) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Servico de referencias nao disponivel',
    });
  }

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado',
    });
  }

  const resultado = await gpsReferencia.treinarIAComReferencias(dispositivo.id, gpsAI);

  res.json({
    sucesso: true,
    mensagem: 'Treinamento com pontos de referencia concluido',
    dados: {
      imei,
      ...resultado,
    },
  });
}));

// POST /api/gps-ai/:imei/referencias/validar - Valida uma correcao usando referencias
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/referencias/validar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { lat_original, lon_original, lat_corrigido, lon_corrigido } = req.body;

  if (!gpsReferencia) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Servico de referencias nao disponivel',
    });
  }

  if (!lat_original || !lon_original || !lat_corrigido || !lon_corrigido) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Coordenadas originais e corrigidas sao obrigatorias',
    });
  }

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado',
    });
  }

  const validacao = await gpsReferencia.validarCorrecaoComReferencia(
    { lat: parseFloat(lat_original), lon: parseFloat(lon_original) },
    { lat: parseFloat(lat_corrigido), lon: parseFloat(lon_corrigido) },
    dispositivo.id
  );

  res.json({
    sucesso: true,
    dados: {
      imei,
      correcao_valida: validacao.valido,
      confianca: (validacao.confianca * 100).toFixed(1) + '%',
      motivo: validacao.motivo,
      referencias_usadas: validacao.referencias,
      distancia_original: validacao.distOriginal + 'm',
      distancia_corrigido: validacao.distCorrigido + 'm',
    },
  });
}));

// POST /api/gps-ai/:imei/referencias/sugerir - Sugere correcao baseada em referencias
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.post('/:imei/referencias/sugerir', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { latitude, longitude } = req.body;

  if (!gpsReferencia) {
    return res.status(503).json({
      sucesso: false,
      mensagem: 'Servico de referencias nao disponivel',
    });
  }

  if (!latitude || !longitude) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Latitude e longitude sao obrigatorias',
    });
  }

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo nao encontrado',
    });
  }

  const sugestao = await gpsReferencia.sugerirCorrecaoPorReferencia(
    dispositivo.id,
    parseFloat(latitude),
    parseFloat(longitude)
  );

  res.json({
    sucesso: true,
    dados: {
      imei,
      sugeriu_correcao: sugestao.sugerido,
      latitude_sugerida: sugestao.lat,
      longitude_sugerida: sugestao.lon,
      correcao_metros: sugestao.correcao_metros?.toFixed(2) || '0',
      confianca: (sugestao.confianca * 100).toFixed(1) + '%',
      referencias_usadas: sugestao.referencias || 0,
      motivo: sugestao.motivo,
    },
  });
}));

module.exports = router;
