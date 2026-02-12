/**
 * GPS AI Service - Correção Inteligente de Rotas GPS
 *
 * Sistema de IA híbrido que combina:
 * 1. Detecção de Outliers (regras físicas)
 * 2. Filtro de Kalman (suavização estatística)
 * 3. Modelo de Aprendizado (histórico de correções aprovadas)
 * 4. Auto-aprendizado contínuo com taxa de confiança
 *
 * O sistema aprende com o tempo e melhora as correções
 */

const prisma = require('../db/prisma');

// ✅ Integração com serviço de aprendizado
let gpsAprendizado = null;
try {
  gpsAprendizado = require('./gps-aprendizado.service');
  console.log('[GPS-AI] Aprendizado integrado com sucesso');
} catch (e) {
  console.warn('[GPS-AI] Aprendizado não disponível:', e.message);
}

// ============ CONSTANTES FÍSICAS ============
const CONFIG = {
  // Velocidade máxima possível (km/h) - acima disso é outlier
  MAX_VELOCIDADE: 180,

  // Aceleração máxima possível (m/s²) - veículos normais ~3-4 m/s²
  MAX_ACELERACAO: 15,

  // Distância máxima em 1 segundo (metros) - 180km/h = 50m/s
  MAX_DISTANCIA_1S: 60,

  // Precisão mínima GPS aceitável (metros)
  PRECISAO_MINIMA: 100,

  // Janela de pontos para análise de contexto
  JANELA_CONTEXTO: 5,

  // Peso do histórico no aprendizado (0-1)
  PESO_HISTORICO: 0.3,

  // Limiar de confiança para aceitar ponto (0-1)
  LIMIAR_CONFIANCA: 0.6,
};

// ============ CACHE DE APRENDIZADO ============
// Armazena padrões aprendidos por região
const learningCache = new Map();

// Estatísticas de correção
const stats = {
  totalProcessados: 0,
  outliersDetectados: 0,
  pontosCorigidos: 0,
  modeloTreinamentos: 0,
  aprendizadosAplicados: 0,
};

// ============ SISTEMA DE CONFIANÇA DINÂMICO ============
// Confiança por dispositivo (atualizada com base em aprovações/rejeições)
const confiancaPorDispositivo = new Map();

/**
 * Calcula a taxa de confiança de um dispositivo
 * Baseado em: correções aprovadas vs rejeitadas + aprendizados aplicados
 */
async function calcularConfiancaDispositivo(dispositivoId) {
  try {
    // Buscar estatísticas de correções do dispositivo
    const [aprovados, rejeitados, aprendidos] = await Promise.all([
      prisma.correcaoGPS.count({
        where: { dispositivo_id: dispositivoId, status: 'aprovado' }
      }),
      prisma.correcaoGPS.count({
        where: { dispositivo_id: dispositivoId, status: 'rejeitado' }
      }),
      prisma.coordenadaAprendida.aggregate({
        where: { dispositivo_id: dispositivoId },
        _sum: { vezes_usado: true },
        _count: { id: true }
      })
    ]);

    const totalAvaliacoes = aprovados + rejeitados;
    const totalAprendidos = aprendidos._count.id || 0;
    const vezesUsados = aprendidos._sum.vezes_usado || 0;

    // Cálculo da confiança:
    // - Base: 50% (sem dados)
    // - +30% máx com base em aprovações
    // - +20% máx com base em aprendizados aplicados
    let confianca = 0.5;

    // Fator de aprovação (0-30%)
    if (totalAvaliacoes > 0) {
      const taxaAprovacao = aprovados / totalAvaliacoes;
      confianca += taxaAprovacao * 0.3;
    }

    // Fator de aprendizado (0-20%)
    // Mais coordenadas aprendidas e mais vezes usadas = mais confiança
    if (totalAprendidos > 0) {
      const fatorAprendizado = Math.min(totalAprendidos / 100, 1); // Max em 100 coordenadas
      const fatorUso = Math.min(vezesUsados / 500, 1); // Max em 500 usos
      confianca += (fatorAprendizado * 0.1) + (fatorUso * 0.1);
    }

    // Guardar no cache
    confiancaPorDispositivo.set(dispositivoId, {
      confianca: Math.min(confianca, 0.98), // Máx 98%
      aprovados,
      rejeitados,
      aprendidos: totalAprendidos,
      vezesUsados,
      ultimaAtualizacao: Date.now()
    });

    return confiancaPorDispositivo.get(dispositivoId);
  } catch (error) {
    console.error('[GPS-AI] Erro ao calcular confiança:', error.message);
    return { confianca: 0.5, erro: error.message };
  }
}

/**
 * Obtém confiança de um dispositivo (usa cache se disponível)
 */
async function getConfiancaDispositivo(dispositivoId) {
  const cache = confiancaPorDispositivo.get(dispositivoId);

  // Recarregar se cache tem mais de 5 minutos
  if (!cache || (Date.now() - cache.ultimaAtualizacao) > 5 * 60 * 1000) {
    return await calcularConfiancaDispositivo(dispositivoId);
  }

  return cache;
}

/**
 * Classe principal do filtro de Kalman para GPS
 */
class KalmanFilter {
  constructor() {
    // Estado: [lat, lon, velocidade_lat, velocidade_lon]
    this.state = null;
    this.covariance = null;
    this.initialized = false;

    // Ruído do processo (quanto o estado pode mudar)
    this.processNoise = 0.00001;

    // Ruído da medição (incerteza do GPS)
    this.measurementNoise = 0.0001;
  }

  /**
   * Inicializa o filtro com a primeira medição
   */
  initialize(lat, lon) {
    this.state = {
      lat: lat,
      lon: lon,
      velLat: 0,
      velLon: 0,
    };

    this.covariance = {
      lat: 1,
      lon: 1,
      velLat: 1,
      velLon: 1,
    };

    this.initialized = true;
  }

  /**
   * Predição do próximo estado
   */
  predict(dt) {
    if (!this.initialized) return null;

    // Atualizar posição baseado na velocidade
    this.state.lat += this.state.velLat * dt;
    this.state.lon += this.state.velLon * dt;

    // Aumentar incerteza
    this.covariance.lat += this.processNoise;
    this.covariance.lon += this.processNoise;
    this.covariance.velLat += this.processNoise * 10;
    this.covariance.velLon += this.processNoise * 10;
  }

  /**
   * Atualização com nova medição
   */
  update(lat, lon, dt) {
    if (!this.initialized) {
      this.initialize(lat, lon);
      return { lat, lon, corrigido: false };
    }

    // Predição
    this.predict(dt);

    // Calcular ganho de Kalman
    const kLat = this.covariance.lat / (this.covariance.lat + this.measurementNoise);
    const kLon = this.covariance.lon / (this.covariance.lon + this.measurementNoise);

    // Calcular velocidade observada
    const velLatObs = (lat - this.state.lat) / dt;
    const velLonObs = (lon - this.state.lon) / dt;

    // Atualizar estado
    this.state.lat += kLat * (lat - this.state.lat);
    this.state.lon += kLon * (lon - this.state.lon);
    this.state.velLat = 0.7 * this.state.velLat + 0.3 * velLatObs;
    this.state.velLon = 0.7 * this.state.velLon + 0.3 * velLonObs;

    // Atualizar covariância
    this.covariance.lat *= (1 - kLat);
    this.covariance.lon *= (1 - kLon);

    // Verificar se houve correção significativa
    const distCorrecao = calcularDistancia(lat, lon, this.state.lat, this.state.lon);

    return {
      lat: this.state.lat,
      lon: this.state.lon,
      corrigido: distCorrecao > 5, // Corrigido se moveu mais de 5 metros
      distanciaCorrecao: distCorrecao,
    };
  }

  /**
   * Resetar o filtro
   */
  reset() {
    this.state = null;
    this.covariance = null;
    this.initialized = false;
  }
}

// Instâncias de Kalman por dispositivo
const kalmanFilters = new Map();

/**
 * Calcula distância entre dois pontos (Haversine) em metros
 */
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Raio da Terra em metros
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calcula velocidade entre dois pontos (km/h)
 */
function calcularVelocidade(lat1, lon1, lat2, lon2, tempoSegundos) {
  if (tempoSegundos <= 0) return 0;
  const distancia = calcularDistancia(lat1, lon1, lat2, lon2);
  return (distancia / tempoSegundos) * 3.6; // m/s para km/h
}

/**
 * Detecta se um ponto é outlier baseado em física
 */
function detectarOutlier(pontoAtual, pontoAnterior, pontoPosterior = null) {
  const resultado = {
    isOutlier: false,
    motivo: null,
    confianca: 1.0,
    metricas: {},
  };

  if (!pontoAnterior) return resultado;

  const dt = (new Date(pontoAtual.timestamp) - new Date(pontoAnterior.timestamp)) / 1000;
  if (dt <= 0) {
    resultado.isOutlier = true;
    resultado.motivo = 'timestamp_invalido';
    resultado.confianca = 0;
    return resultado;
  }

  // Calcular velocidade
  const velocidade = calcularVelocidade(
    pontoAnterior.latitude, pontoAnterior.longitude,
    pontoAtual.latitude, pontoAtual.longitude,
    dt
  );
  resultado.metricas.velocidadeCalculada = velocidade;

  // Verificar velocidade impossível
  if (velocidade > CONFIG.MAX_VELOCIDADE) {
    resultado.isOutlier = true;
    resultado.motivo = 'velocidade_impossivel';
    resultado.confianca = 1 - Math.min(velocidade / (CONFIG.MAX_VELOCIDADE * 2), 1);
    stats.outliersDetectados++;
    return resultado;
  }

  // Calcular distância
  const distancia = calcularDistancia(
    pontoAnterior.latitude, pontoAnterior.longitude,
    pontoAtual.latitude, pontoAtual.longitude
  );
  resultado.metricas.distancia = distancia;

  // Verificar salto impossível
  if (dt < 5 && distancia > CONFIG.MAX_DISTANCIA_1S * dt) {
    resultado.isOutlier = true;
    resultado.motivo = 'salto_impossivel';
    resultado.confianca = 1 - Math.min(distancia / (CONFIG.MAX_DISTANCIA_1S * dt * 2), 1);
    stats.outliersDetectados++;
    return resultado;
  }

  // Verificar aceleração impossível
  if (pontoAnterior.velocidade !== undefined && pontoAtual.velocidade !== undefined) {
    const aceleracao = Math.abs(pontoAtual.velocidade - pontoAnterior.velocidade) / (3.6 * dt);
    resultado.metricas.aceleracao = aceleracao;

    if (aceleracao > CONFIG.MAX_ACELERACAO) {
      resultado.isOutlier = true;
      resultado.motivo = 'aceleracao_impossivel';
      resultado.confianca = 1 - Math.min(aceleracao / (CONFIG.MAX_ACELERACAO * 2), 1);
      stats.outliersDetectados++;
      return resultado;
    }
  }

  // Verificar consistência com ponto posterior (se disponível)
  if (pontoPosterior) {
    const velAnterior = calcularVelocidade(
      pontoAnterior.latitude, pontoAnterior.longitude,
      pontoAtual.latitude, pontoAtual.longitude,
      dt
    );

    const dtPosterior = (new Date(pontoPosterior.timestamp) - new Date(pontoAtual.timestamp)) / 1000;
    const velPosterior = calcularVelocidade(
      pontoAtual.latitude, pontoAtual.longitude,
      pontoPosterior.latitude, pontoPosterior.longitude,
      dtPosterior
    );

    // Se velocidade muda muito bruscamente, pode ser outlier
    if (Math.abs(velAnterior - velPosterior) > 100 && velAnterior > 50 && velPosterior > 50) {
      resultado.isOutlier = true;
      resultado.motivo = 'inconsistencia_contexto';
      resultado.confianca = 0.5;
      stats.outliersDetectados++;
    }
  }

  return resultado;
}

/**
 * Corrige um ponto usando interpolação e Kalman
 */
function corrigirPonto(pontoAtual, pontoAnterior, pontoPosterior, kalman) {
  // Se não tem contexto suficiente, usar apenas Kalman
  if (!pontoAnterior) {
    return {
      latitude: pontoAtual.latitude,
      longitude: pontoAtual.longitude,
      corrigido: false,
      metodo: 'original',
    };
  }

  const dt = (new Date(pontoAtual.timestamp) - new Date(pontoAnterior.timestamp)) / 1000;

  // Aplicar Kalman
  const resultadoKalman = kalman.update(pontoAtual.latitude, pontoAtual.longitude, Math.max(dt, 0.1));

  // Se tem ponto posterior, fazer interpolação ponderada
  if (pontoPosterior) {
    const dtTotal = (new Date(pontoPosterior.timestamp) - new Date(pontoAnterior.timestamp)) / 1000;
    const dtAtual = (new Date(pontoAtual.timestamp) - new Date(pontoAnterior.timestamp)) / 1000;
    const fator = dtAtual / dtTotal;

    // Interpolação linear entre anterior e posterior
    const latInterp = pontoAnterior.latitude + fator * (pontoPosterior.latitude - pontoAnterior.latitude);
    const lonInterp = pontoAnterior.longitude + fator * (pontoPosterior.longitude - pontoAnterior.longitude);

    // Combinar Kalman com interpolação (média ponderada)
    const pesoKalman = 0.6;
    const latFinal = pesoKalman * resultadoKalman.lat + (1 - pesoKalman) * latInterp;
    const lonFinal = pesoKalman * resultadoKalman.lon + (1 - pesoKalman) * lonInterp;

    stats.pontosCorigidos++;

    return {
      latitude: latFinal,
      longitude: lonFinal,
      corrigido: true,
      metodo: 'kalman_interpolacao',
      latOriginal: pontoAtual.latitude,
      lonOriginal: pontoAtual.longitude,
    };
  }

  // Apenas Kalman
  if (resultadoKalman.corrigido) {
    stats.pontosCorigidos++;
  }

  return {
    latitude: resultadoKalman.lat,
    longitude: resultadoKalman.lon,
    corrigido: resultadoKalman.corrigido,
    metodo: 'kalman',
    latOriginal: pontoAtual.latitude,
    lonOriginal: pontoAtual.longitude,
  };
}

/**
 * Processa um único ponto GPS em tempo real
 * Prioridade: 1) Aprendizado, 2) Detecção de outliers + Kalman
 */
async function processarPontoGPS(imei, ponto) {
  stats.totalProcessados++;

  // Obter ou criar filtro Kalman para este dispositivo
  if (!kalmanFilters.has(imei)) {
    kalmanFilters.set(imei, new KalmanFilter());
  }
  const kalman = kalmanFilters.get(imei);

  // ✅ PRIORIDADE 1: Verificar aprendizado
  // Se já temos uma correção aprendida para esta coordenada, usar ela
  if (gpsAprendizado && ponto.dispositivo_id) {
    try {
      const aprendido = await gpsAprendizado.buscarCorrecaoAprendida(
        ponto.dispositivo_id,
        ponto.latitude,
        ponto.longitude
      );

      if (aprendido && aprendido.confianca >= 0.7) {
        stats.aprendizadosAplicados++;

        console.log(`[GPS-AI] 🎓 Aprendizado aplicado para ${imei}: (${ponto.latitude.toFixed(6)}, ${ponto.longitude.toFixed(6)}) -> (${aprendido.lat.toFixed(6)}, ${aprendido.lon.toFixed(6)})`);

        // Atualizar Kalman com o ponto corrigido
        const dt = 1;
        kalman.update(aprendido.lat, aprendido.lon, dt);

        return {
          ...ponto,
          latitude: aprendido.lat,
          longitude: aprendido.lon,
          corrigido_ia: true,
          ia_metodo: 'aprendizado_' + aprendido.metodo,
          ia_confianca: aprendido.confianca,
          ia_fonte: 'aprendizado',
        };
      }
    } catch (aprendError) {
      console.warn(`[GPS-AI] Erro no aprendizado: ${aprendError.message}`);
    }
  }

  // ✅ PRIORIDADE 2: Buscar último ponto e detectar outliers
  const ultimoPonto = await prisma.localizacao.findFirst({
    where: {
      dispositivo_id: ponto.dispositivo_id,
      timestamp: { lt: ponto.timestamp },
    },
    orderBy: { timestamp: 'desc' },
  });

  // Detectar se é outlier
  const analise = detectarOutlier(ponto, ultimoPonto);

  // Se for outlier, corrigir
  if (analise.isOutlier) {
    const correcao = corrigirPonto(ponto, ultimoPonto, null, kalman);

    console.log(`[GPS-AI] Outlier detectado para ${imei}: ${analise.motivo}`);
    console.log(`[GPS-AI] Correção: (${ponto.latitude}, ${ponto.longitude}) -> (${correcao.latitude}, ${correcao.longitude})`);

    // Salvar correção para aprendizado futuro (será validada pelo usuário)
    await salvarCorrecao(imei, ponto, correcao, analise);

    return {
      ...ponto,
      latitude: correcao.latitude,
      longitude: correcao.longitude,
      corrigido_ia: true,
      ia_metodo: correcao.metodo,
      ia_motivo: analise.motivo,
      ia_confianca: analise.confianca,
      ia_fonte: 'deteccao',
    };
  }

  // NÃO aplicar Kalman em pontos válidos - manter coordenadas originais
  // Isso evita que a rota seja "achatada" pela suavização excessiva
  return {
    ...ponto,
    latitude: ponto.latitude,
    longitude: ponto.longitude,
    corrigido_ia: false,
    ia_metodo: null,
    ia_fonte: null,
  };
}

/**
 * Processa uma lista de pontos (para correção em lote)
 */
async function processarRotaCompleta(pontos) {
  if (!pontos || pontos.length === 0) return [];

  const kalman = new KalmanFilter();
  const resultado = [];

  for (let i = 0; i < pontos.length; i++) {
    const pontoAnterior = i > 0 ? pontos[i - 1] : null;
    const pontoAtual = pontos[i];
    const pontoPosterior = i < pontos.length - 1 ? pontos[i + 1] : null;

    // Detectar outlier
    const analise = detectarOutlier(pontoAtual, pontoAnterior, pontoPosterior);

    if (analise.isOutlier) {
      // Corrigir ponto
      const correcao = corrigirPonto(pontoAtual, pontoAnterior, pontoPosterior, kalman);
      resultado.push({
        ...pontoAtual,
        latitude: correcao.latitude,
        longitude: correcao.longitude,
        corrigido_ia: true,
        ia_metodo: correcao.metodo,
        ia_motivo: analise.motivo,
        latOriginal: pontoAtual.latitude,
        lonOriginal: pontoAtual.longitude,
      });
    } else {
      // Ponto válido - manter coordenadas originais (não suavizar)
      resultado.push({
        ...pontoAtual,
        latitude: pontoAtual.latitude,
        longitude: pontoAtual.longitude,
        corrigido_ia: false,
        ia_metodo: null,
      });
    }
  }

  return resultado;
}

/**
 * Salva correção para revisão e aprendizado
 */
async function salvarCorrecao(imei, pontoOriginal, correcao, analise) {
  try {
    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) return;

    // Calcular distância da correção
    const distanciaCorrecao = calcularDistancia(
      pontoOriginal.latitude, pontoOriginal.longitude,
      correcao.latitude, correcao.longitude
    );

    // Salvar na tabela de correções (Prisma model)
    await prisma.correcaoGPS.create({
      data: {
        dispositivo_id: dispositivo.id,
        lat_original: pontoOriginal.latitude,
        lon_original: pontoOriginal.longitude,
        vel_original: pontoOriginal.velocidade || 0,
        lat_corrigido: correcao.latitude,
        lon_corrigido: correcao.longitude,
        vel_corrigido: pontoOriginal.velocidade || 0,
        motivo: analise.motivo || 'outlier',
        metodo: correcao.metodo || 'kalman',
        confianca: analise.confianca || 0.5,
        distancia_correcao: distanciaCorrecao,
        status: 'pendente',
        timestamp: pontoOriginal.timestamp || new Date(),
      },
    });

    stats.modeloTreinamentos++;
  } catch (error) {
    console.error('[GPS-AI] Erro ao salvar correção:', error.message);
  }
}

/**
 * Lista correções pendentes de revisão
 */
async function listarCorrecoesPendentes(imei = null, limite = 50) {
  const where = { status: 'pendente' };

  if (imei) {
    const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
    if (dispositivo) {
      where.dispositivo_id = dispositivo.id;
    }
  }

  const correcoes = await prisma.correcaoGPS.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: limite,
  });

  // Agrupar por proximidade para criar "rotas" de correção
  return agruparCorrecoesPorRota(correcoes);
}

/**
 * Agrupa correções próximas em "rotas" para revisão
 */
function agruparCorrecoesPorRota(correcoes) {
  if (correcoes.length === 0) return [];

  const rotas = [];
  let rotaAtual = [correcoes[0]];

  for (let i = 1; i < correcoes.length; i++) {
    const anterior = correcoes[i - 1];
    const atual = correcoes[i];

    // Se mesmo dispositivo e < 30 min de diferença, agrupa na mesma rota
    const diffMinutos = Math.abs(
      new Date(atual.timestamp) - new Date(anterior.timestamp)
    ) / (1000 * 60);

    if (atual.dispositivo_id === anterior.dispositivo_id && diffMinutos < 30) {
      rotaAtual.push(atual);
    } else {
      rotas.push({
        id: `rota_${rotaAtual[0].id}`,
        dispositivo_id: rotaAtual[0].dispositivo_id,
        total_correcoes: rotaAtual.length,
        inicio: rotaAtual[0].timestamp,
        fim: rotaAtual[rotaAtual.length - 1].timestamp,
        correcoes: rotaAtual,
      });
      rotaAtual = [atual];
    }
  }

  // Adicionar última rota
  if (rotaAtual.length > 0) {
    rotas.push({
      id: `rota_${rotaAtual[0].id}`,
      dispositivo_id: rotaAtual[0].dispositivo_id,
      total_correcoes: rotaAtual.length,
      inicio: rotaAtual[0].timestamp,
      fim: rotaAtual[rotaAtual.length - 1].timestamp,
      correcoes: rotaAtual,
    });
  }

  return rotas;
}

/**
 * Aprovar uma correção (feedback positivo para treinamento)
 */
async function aprovarCorrecao(correcaoId, avaliacao = 5, comentario = null) {
  const correcao = await prisma.correcaoGPS.update({
    where: { id: correcaoId },
    data: {
      status: 'aprovado',
      avaliacao,
      comentario,
      avaliado_em: new Date(),
    },
  });

  // Atualizar modelo de aprendizado
  await atualizarModeloIA(correcao, 'aprovado');

  return correcao;
}

/**
 * Rejeitar uma correção (a IA errou - GPS estava offline, não era outlier)
 */
async function rejeitarCorrecao(correcaoId, motivo = null) {
  const correcao = await prisma.correcaoGPS.update({
    where: { id: correcaoId },
    data: {
      status: 'rejeitado',
      avaliacao: 1,
      comentario: motivo || 'Correção incorreta - manter ponto original',
      avaliado_em: new Date(),
    },
  });

  // Atualizar modelo de aprendizado (negativo)
  await atualizarModeloIA(correcao, 'rejeitado');

  return correcao;
}

/**
 * Aprovar/rejeitar todas as correções de uma rota
 */
async function avaliarRota(correcaoIds, aprovado, avaliacao = null, comentario = null) {
  const results = [];

  for (const id of correcaoIds) {
    if (aprovado) {
      results.push(await aprovarCorrecao(id, avaliacao || 5, comentario));
    } else {
      results.push(await rejeitarCorrecao(id, comentario));
    }
  }

  return results;
}

/**
 * Atualiza modelo de IA com base no feedback
 * Aceita dois formatos:
 * 1. atualizarModeloIA(correcao, status) - para correções específicas
 * 2. atualizarModeloIA(tipo, referencia, aprovado, avaliacao) - para modelo global/viagem
 */
async function atualizarModeloIA(param1, param2, param3, param4) {
  try {
    let tipo, referencia, status;

    // Detectar formato de chamada
    if (typeof param1 === 'string' && (param1 === 'global' || param1 === 'dispositivo')) {
      // Formato novo: (tipo, referencia, aprovado, avaliacao)
      tipo = param1;
      referencia = param2 || 'global';
      status = param3 ? 'aprovado' : 'rejeitado';
    } else if (param1 && typeof param1 === 'object') {
      // Formato antigo: (correcao, status)
      tipo = 'dispositivo';
      referencia = String(param1.dispositivo_id);
      status = param2;
    } else {
      console.error('[GPS-AI] Formato de chamada inválido para atualizarModeloIA');
      return;
    }

    // Buscar ou criar modelo
    let modelo = await prisma.modeloIA.findFirst({
      where: {
        tipo: tipo,
        referencia: referencia,
      },
    });

    if (!modelo) {
      modelo = await prisma.modeloIA.create({
        data: {
          tipo: tipo,
          referencia: referencia,
          parametros: JSON.stringify({
            // Parâmetros iniciais
            max_velocidade: CONFIG.MAX_VELOCIDADE,
            max_aceleracao: CONFIG.MAX_ACELERACAO,
            limiar_confianca: CONFIG.LIMIAR_CONFIANCA,
            ajustes: [],
          }),
        },
      });
    }

    // Atualizar contadores
    const updateData = {
      total_treinamentos: { increment: 1 },
    };

    if (status === 'aprovado') {
      updateData.total_aprovados = { increment: 1 };
    } else {
      updateData.total_rejeitados = { increment: 1 };
    }

    await prisma.modeloIA.update({
      where: { id: modelo.id },
      data: updateData,
    });

    // Recalcular taxa de acerto
    const modeloAtualizado = await prisma.modeloIA.findUnique({
      where: { id: modelo.id },
    });

    const total = modeloAtualizado.total_aprovados + modeloAtualizado.total_rejeitados;
    const taxaAcerto = total > 0 ? modeloAtualizado.total_aprovados / total : 0;

    await prisma.modeloIA.update({
      where: { id: modelo.id },
      data: { taxa_acerto: taxaAcerto },
    });

    // Se muitas rejeições, ajustar parâmetros
    if (modeloAtualizado.total_rejeitados > 10 && taxaAcerto < 0.7) {
      await ajustarParametrosIA(modelo.id, correcao);
    }

    console.log(`[GPS-AI] Modelo atualizado: ${status}, taxa de acerto: ${(taxaAcerto * 100).toFixed(1)}%`);

  } catch (error) {
    console.error('[GPS-AI] Erro ao atualizar modelo:', error.message);
  }
}

/**
 * Ajusta parâmetros da IA com base em rejeições
 */
async function ajustarParametrosIA(modeloId, correcaoRejeitada) {
  try {
    const modelo = await prisma.modeloIA.findUnique({
      where: { id: modeloId },
    });

    const parametros = JSON.parse(modelo.parametros);

    // Se a correção foi rejeitada porque era GPS offline (não outlier)
    // Aumentar tolerância
    if (correcaoRejeitada.motivo === 'salto_impossivel' ||
        correcaoRejeitada.motivo === 'velocidade_impossivel') {
      // Aumentar limites se muitas rejeições
      parametros.max_velocidade = Math.min(parametros.max_velocidade * 1.1, 250);
      parametros.ajustes.push({
        data: new Date(),
        tipo: 'aumentar_tolerancia',
        motivo: 'Muitas rejeições de saltos GPS',
      });
    }

    await prisma.modeloIA.update({
      where: { id: modeloId },
      data: {
        parametros: JSON.stringify(parametros),
        versao: { increment: 1 },
      },
    });

    console.log(`[GPS-AI] Parâmetros ajustados para modelo ${modeloId}`);

  } catch (error) {
    console.error('[GPS-AI] Erro ao ajustar parâmetros:', error.message);
  }
}

/**
 * Obtém estatísticas de treinamento
 */
async function getEstatisticasTreinamento() {
  try {
    const [totalPendentes, totalAprovados, totalRejeitados, modelos] = await Promise.all([
      prisma.correcaoGPS.count({ where: { status: 'pendente' } }),
      prisma.correcaoGPS.count({ where: { status: 'aprovado' } }),
      prisma.correcaoGPS.count({ where: { status: 'rejeitado' } }),
      prisma.modeloIA.findMany({ where: { ativo: true } }),
    ]);

    const taxaAcertoGlobal = (totalAprovados + totalRejeitados) > 0
      ? totalAprovados / (totalAprovados + totalRejeitados)
      : 0;

    return {
      pendentes: totalPendentes,
      aprovados: totalAprovados,
      rejeitados: totalRejeitados,
      taxa_acerto_global: (taxaAcertoGlobal * 100).toFixed(1) + '%',
      modelos_ativos: modelos.length,
      modelos: modelos.map(m => ({
        tipo: m.tipo,
        referencia: m.referencia,
        taxa_acerto: (m.taxa_acerto * 100).toFixed(1) + '%',
        treinamentos: m.total_treinamentos,
      })),
    };
  } catch (error) {
    console.error('[GPS-AI] Erro ao obter estatísticas:', error.message);
    return { erro: error.message };
  }
}

/**
 * Obtém estatísticas do serviço de IA
 */
function getStats() {
  return {
    ...stats,
    dispositivosComFiltro: kalmanFilters.size,
    taxaCorrecao: stats.totalProcessados > 0
      ? ((stats.pontosCorigidos / stats.totalProcessados) * 100).toFixed(2) + '%'
      : '0%',
  };
}

/**
 * Reseta o filtro de um dispositivo
 */
function resetarDispositivo(imei) {
  if (kalmanFilters.has(imei)) {
    kalmanFilters.get(imei).reset();
    console.log(`[GPS-AI] Filtro resetado para ${imei}`);
  }
}

/**
 * Treina modelo com dados históricos de um dispositivo
 */
async function treinarComHistorico(imei, horas = 24) {
  try {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      return { sucesso: false, mensagem: 'Dispositivo não encontrado' };
    }

    const dataInicio = new Date();
    dataInicio.setHours(dataInicio.getHours() - horas);

    const pontos = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: dataInicio },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (pontos.length < 10) {
      return { sucesso: false, mensagem: 'Dados insuficientes para treinar' };
    }

    // Processar pontos e identificar padrões
    const analises = [];
    for (let i = 1; i < pontos.length; i++) {
      const analise = detectarOutlier(pontos[i], pontos[i - 1], pontos[i + 1] || null);
      analises.push(analise);
    }

    const outliers = analises.filter(a => a.isOutlier).length;
    const taxaOutliers = (outliers / analises.length) * 100;

    console.log(`[GPS-AI] Treinamento para ${imei}: ${pontos.length} pontos, ${outliers} outliers (${taxaOutliers.toFixed(1)}%)`);

    return {
      sucesso: true,
      pontos: pontos.length,
      outliers,
      taxaOutliers: taxaOutliers.toFixed(2) + '%',
      mensagem: `Modelo treinado com ${pontos.length} pontos`,
    };

  } catch (error) {
    console.error('[GPS-AI] Erro no treinamento:', error.message);
    return { sucesso: false, mensagem: error.message };
  }
}

/**
 * Obtém estatísticas completas de IA para um dispositivo
 * Inclui confiança, aprendizados, correções, etc.
 */
async function getEstatisticasIA(imei) {
  try {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      return { erro: 'Dispositivo não encontrado' };
    }

    // Buscar confiança
    const confianca = await getConfiancaDispositivo(dispositivo.id);

    // Buscar estatísticas de aprendizado
    let aprendizadoStats = null;
    if (gpsAprendizado) {
      aprendizadoStats = await gpsAprendizado.obterEstatisticas(dispositivo.id);
    }

    // Buscar correções recentes
    const correcoes = await prisma.correcaoGPS.groupBy({
      by: ['status'],
      where: { dispositivo_id: dispositivo.id },
      _count: { id: true }
    });

    const correcoesPorStatus = correcoes.reduce((acc, item) => {
      acc[item.status] = item._count.id;
      return acc;
    }, {});

    // Calcular nível de maturidade da IA para este dispositivo
    let nivelMaturidade = 'iniciante';
    const totalAprendidos = confianca.aprendidos || 0;
    const totalAvaliacoes = (confianca.aprovados || 0) + (confianca.rejeitados || 0);

    if (totalAprendidos >= 100 && totalAvaliacoes >= 50) {
      nivelMaturidade = 'expert';
    } else if (totalAprendidos >= 50 && totalAvaliacoes >= 20) {
      nivelMaturidade = 'avancado';
    } else if (totalAprendidos >= 10 && totalAvaliacoes >= 5) {
      nivelMaturidade = 'intermediario';
    }

    return {
      dispositivo: {
        imei,
        id: dispositivo.id,
        veiculo: dispositivo.veiculo
      },
      confianca: {
        taxa: (confianca.confianca * 100).toFixed(1) + '%',
        valor: confianca.confianca,
        nivel: confianca.confianca >= 0.8 ? 'alta' :
               confianca.confianca >= 0.6 ? 'media' : 'baixa'
      },
      aprendizado: {
        coordenadasAprendidas: totalAprendidos,
        vezesAplicado: confianca.vezesUsados || 0,
        ...aprendizadoStats
      },
      avaliacoes: {
        aprovadas: confianca.aprovados || 0,
        rejeitadas: confianca.rejeitados || 0,
        pendentes: correcoesPorStatus.pendente || 0,
        taxaAprovacao: totalAvaliacoes > 0 ?
          ((confianca.aprovados / totalAvaliacoes) * 100).toFixed(1) + '%' : 'N/A'
      },
      maturidade: {
        nivel: nivelMaturidade,
        descricao: {
          iniciante: 'IA está aprendendo. Valide mais correções para melhorar.',
          intermediario: 'IA tem conhecimento básico das rotas.',
          avancado: 'IA conhece bem as rotas frequentes.',
          expert: 'IA altamente treinada para este veículo.'
        }[nivelMaturidade]
      },
      estatisticasGerais: stats
    };
  } catch (error) {
    console.error('[GPS-AI] Erro ao obter estatísticas:', error.message);
    return { erro: error.message };
  }
}

/**
 * Força recálculo de confiança após aprovação/rejeição
 */
async function atualizarConfiancaAposAvaliacao(dispositivoId) {
  // Invalidar cache
  confiancaPorDispositivo.delete(dispositivoId);
  // Recalcular
  return await calcularConfiancaDispositivo(dispositivoId);
}

module.exports = {
  processarPontoGPS,
  processarRotaCompleta,
  getStats,
  resetarDispositivo,
  treinarComHistorico,
  calcularDistancia,
  calcularVelocidade,
  detectarOutlier,
  CONFIG,
  // Funções de treinamento supervisionado
  listarCorrecoesPendentes,
  aprovarCorrecao,
  rejeitarCorrecao,
  avaliarRota,
  getEstatisticasTreinamento,
  atualizarModeloIA,
  // ✅ Novas funções de confiança e estatísticas
  getConfiancaDispositivo,
  calcularConfiancaDispositivo,
  getEstatisticasIA,
  atualizarConfiancaAposAvaliacao,
};
