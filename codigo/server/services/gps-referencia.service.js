/**
 * GPS Referencia Service - Pontos de Alta Precisao como Referencia
 *
 * Identifica e usa pontos GPS de alta precisao (HDOP baixo) como
 * "ancora" para treinar e validar correcoes da IA.
 *
 * Criterios de ponto de alta precisao:
 * 1. HDOP <= 2 (excelente precisao)
 * 2. Velocidade consistente (sem saltos)
 * 3. Heading consistente com trajeto
 * 4. Posicao consistente com pontos anteriores e posteriores
 */

const prisma = require('../db/prisma');

// Cache de pontos de referencia por dispositivo
const cacheReferencia = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// Configuracoes
const CONFIG = {
  // Criterios para ponto de alta precisao
  maxHDOP: 2.0,              // HDOP maximo para considerar alta precisao
  maxVariacaoVelocidade: 10, // km/h de variacao maxima
  maxVariacaoDirecao: 20,    // graus de variacao maxima
  minConsistencia: 0.8,      // Score minimo de consistencia (0-1)

  // Grid para indexacao espacial
  gridPrecisao: 10000,       // 4 casas decimais (~11m)

  // Treinamento
  minPontosParaTreinar: 1,   // Minimo de pontos de referencia para treinar (1 = mais agressivo)
  raioInfluencia: 150,       // Metros de influencia de um ponto de referencia (150m = maior alcance)
};

/**
 * Calcula distancia em metros (Haversine)
 */
function calcularDistancia(lat1, lon1, lat2, lon2) {
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
 * Calcula bearing entre dois pontos
 */
function calcularBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Normaliza angulo para -180 a 180
 */
function normalizarAngulo(angulo) {
  while (angulo > 180) angulo -= 360;
  while (angulo < -180) angulo += 360;
  return angulo;
}

/**
 * Calcula grid key para indexacao espacial
 */
function calcularGridKey(lat, lon) {
  const gridLat = Math.floor(lat * CONFIG.gridPrecisao) / CONFIG.gridPrecisao;
  const gridLon = Math.floor(lon * CONFIG.gridPrecisao) / CONFIG.gridPrecisao;
  return `${gridLat.toFixed(4)}_${gridLon.toFixed(4)}`;
}

/**
 * Avalia se um ponto e de alta precisao baseado no contexto
 * @param {Object} ponto - Ponto atual
 * @param {Object} anterior - Ponto anterior (pode ser null)
 * @param {Object} posterior - Ponto posterior (pode ser null)
 * @returns {Object} { altaPrecisao: boolean, score: number, motivos: string[] }
 */
function avaliarPrecisaoPonto(ponto, anterior, posterior) {
  const resultado = {
    altaPrecisao: false,
    score: 0,
    motivos: [],
    metricas: {}
  };

  let scoreTotal = 0;
  let pesoTotal = 0;

  // 1. Avaliar HDOP (peso 3)
  const hdop = ponto.precisao || ponto.hdop || 5;
  resultado.metricas.hdop = hdop;

  if (hdop <= 1.0) {
    scoreTotal += 3 * 1.0;
    resultado.motivos.push('HDOP excelente (<= 1.0)');
  } else if (hdop <= CONFIG.maxHDOP) {
    scoreTotal += 3 * (1 - (hdop - 1) / (CONFIG.maxHDOP - 1));
    resultado.motivos.push(`HDOP bom (${hdop.toFixed(1)})`);
  } else {
    resultado.motivos.push(`HDOP ruim (${hdop.toFixed(1)})`);
  }
  pesoTotal += 3;

  // 2. Avaliar consistencia de velocidade (peso 2)
  if (anterior && posterior) {
    const velAtual = ponto.velocidade || 0;
    const velAnterior = anterior.velocidade || 0;
    const velPosterior = posterior.velocidade || 0;
    const varVel = Math.max(
      Math.abs(velAtual - velAnterior),
      Math.abs(velAtual - velPosterior)
    );
    resultado.metricas.variacaoVelocidade = varVel;

    if (varVel <= CONFIG.maxVariacaoVelocidade) {
      const scoreVel = 1 - (varVel / CONFIG.maxVariacaoVelocidade);
      scoreTotal += 2 * scoreVel;
      resultado.motivos.push(`Velocidade consistente (var: ${varVel.toFixed(1)} km/h)`);
    } else {
      resultado.motivos.push(`Velocidade inconsistente (var: ${varVel.toFixed(1)} km/h)`);
    }
    pesoTotal += 2;
  }

  // 3. Avaliar consistencia de direcao (peso 2)
  if (anterior && posterior) {
    const dirAtual = ponto.direcao || 0;
    const dirAnterior = anterior.direcao || 0;
    const dirPosterior = posterior.direcao || 0;

    // Calcular direcao esperada baseada na trajetoria
    const bearingCalculado = calcularBearing(
      anterior.latitude, anterior.longitude,
      posterior.latitude, posterior.longitude
    );

    const varDir = Math.abs(normalizarAngulo(dirAtual - bearingCalculado));
    resultado.metricas.variacaoDirecao = varDir;

    if (varDir <= CONFIG.maxVariacaoDirecao) {
      const scoreDir = 1 - (varDir / CONFIG.maxVariacaoDirecao);
      scoreTotal += 2 * scoreDir;
      resultado.motivos.push(`Direcao consistente (var: ${varDir.toFixed(1)} graus)`);
    } else {
      resultado.motivos.push(`Direcao inconsistente (var: ${varDir.toFixed(1)} graus)`);
    }
    pesoTotal += 2;
  }

  // 4. Avaliar consistencia espacial (peso 3)
  if (anterior && posterior) {
    // O ponto deve estar aproximadamente na linha entre anterior e posterior
    const distAntPost = calcularDistancia(
      anterior.latitude, anterior.longitude,
      posterior.latitude, posterior.longitude
    );

    const distAntAtual = calcularDistancia(
      anterior.latitude, anterior.longitude,
      ponto.latitude, ponto.longitude
    );

    const distAtualPost = calcularDistancia(
      ponto.latitude, ponto.longitude,
      posterior.latitude, posterior.longitude
    );

    // Desvio = distancia extra comparado a linha reta
    const desvio = (distAntAtual + distAtualPost) - distAntPost;
    resultado.metricas.desvioEspacial = desvio;

    // Normalizar pelo tempo entre pontos (esperar algum desvio em curvas)
    const tempoTotal = (new Date(posterior.timestamp) - new Date(anterior.timestamp)) / 1000;
    const desvioNormalizado = tempoTotal > 0 ? desvio / (tempoTotal * 0.5) : desvio / 5;

    if (desvioNormalizado <= 5) { // Ate 5m de desvio normalizado
      const scoreEspacial = Math.max(0, 1 - (desvioNormalizado / 5));
      scoreTotal += 3 * scoreEspacial;
      resultado.motivos.push(`Posicao consistente (desvio: ${desvio.toFixed(1)}m)`);
    } else {
      resultado.motivos.push(`Posicao com desvio (${desvio.toFixed(1)}m)`);
    }
    pesoTotal += 3;
  }

  // Calcular score final
  resultado.score = pesoTotal > 0 ? scoreTotal / pesoTotal : 0;
  resultado.altaPrecisao = resultado.score >= CONFIG.minConsistencia && hdop <= CONFIG.maxHDOP;

  return resultado;
}

/**
 * Identifica pontos de alta precisao em uma lista de localizacoes
 * @param {Array} localizacoes - Lista de localizacoes ordenadas por timestamp
 * @returns {Array} Lista de pontos de alta precisao com metadados
 */
function identificarPontosAltaPrecisao(localizacoes) {
  if (localizacoes.length < 3) return [];

  const pontosAltaPrecisao = [];

  for (let i = 1; i < localizacoes.length - 1; i++) {
    const anterior = localizacoes[i - 1];
    const atual = localizacoes[i];
    const posterior = localizacoes[i + 1];

    const avaliacao = avaliarPrecisaoPonto(atual, anterior, posterior);

    if (avaliacao.altaPrecisao) {
      pontosAltaPrecisao.push({
        ...atual,
        scoreReferencia: avaliacao.score,
        motivos: avaliacao.motivos,
        metricas: avaliacao.metricas,
        gridKey: calcularGridKey(atual.latitude, atual.longitude),
        indiceOriginal: i
      });
    }
  }

  console.log(`[GPS-Ref] Identificados ${pontosAltaPrecisao.length}/${localizacoes.length} pontos de alta precisao`);

  return pontosAltaPrecisao;
}

/**
 * Carrega pontos de referencia de um dispositivo das ultimas N horas
 */
async function carregarPontosReferencia(dispositivoId, horas = 24) {
  try {
    const dataInicio = new Date();
    dataInicio.setHours(dataInicio.getHours() - horas);

    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivoId,
        timestamp: { gte: dataInicio }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length < 10) {
      return [];
    }

    const pontosRef = identificarPontosAltaPrecisao(localizacoes);

    // Atualizar cache
    cacheReferencia.set(dispositivoId, {
      pontos: pontosRef,
      timestamp: Date.now(),
      total: localizacoes.length
    });

    return pontosRef;
  } catch (error) {
    console.error('[GPS-Ref] Erro ao carregar pontos:', error.message);
    return [];
  }
}

/**
 * Obtem pontos de referencia do cache ou carrega do banco
 */
async function obterPontosReferencia(dispositivoId, forcarRecarregar = false) {
  const cache = cacheReferencia.get(dispositivoId);

  if (!forcarRecarregar && cache && (Date.now() - cache.timestamp) < CACHE_TTL) {
    return cache.pontos;
  }

  return await carregarPontosReferencia(dispositivoId);
}

/**
 * Busca pontos de referencia proximos a uma coordenada
 * @param {number} dispositivoId - ID do dispositivo
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} raioMetros - Raio de busca em metros
 * @returns {Array} Pontos de referencia proximos
 */
async function buscarReferenciasProximas(dispositivoId, lat, lon, raioMetros = CONFIG.raioInfluencia) {
  const pontosRef = await obterPontosReferencia(dispositivoId);

  if (pontosRef.length === 0) return [];

  const proximos = [];

  for (const ref of pontosRef) {
    const dist = calcularDistancia(lat, lon, ref.latitude, ref.longitude);

    if (dist <= raioMetros) {
      proximos.push({
        ...ref,
        distancia: dist,
        peso: 1 - (dist / raioMetros) // Peso maior para pontos mais proximos
      });
    }
  }

  // Ordenar por distancia
  proximos.sort((a, b) => a.distancia - b.distancia);

  return proximos;
}

/**
 * Valida uma correcao da IA usando pontos de referencia proximos
 * @param {Object} original - Posicao original {lat, lon}
 * @param {Object} corrigido - Posicao corrigida {lat, lon}
 * @param {number} dispositivoId - ID do dispositivo
 * @returns {Object} { valido: boolean, confianca: number, motivo: string }
 */
async function validarCorrecaoComReferencia(original, corrigido, dispositivoId) {
  const referencias = await buscarReferenciasProximas(
    dispositivoId,
    original.lat,
    original.lon,
    CONFIG.raioInfluencia * 2 // Buscar em raio maior
  );

  if (referencias.length === 0) {
    return {
      valido: true, // Sem referencias, aceitar correcao
      confianca: 0.5,
      motivo: 'sem_referencias_proximas'
    };
  }

  // Calcular distancia media do original e corrigido para as referencias
  let somaDistOriginal = 0;
  let somaDistCorrigido = 0;
  let somaPesos = 0;

  for (const ref of referencias) {
    const distOriginal = calcularDistancia(original.lat, original.lon, ref.latitude, ref.longitude);
    const distCorrigido = calcularDistancia(corrigido.lat, corrigido.lon, ref.latitude, ref.longitude);

    somaDistOriginal += distOriginal * ref.peso;
    somaDistCorrigido += distCorrigido * ref.peso;
    somaPesos += ref.peso;
  }

  const mediaDistOriginal = somaPesos > 0 ? somaDistOriginal / somaPesos : 0;
  const mediaDistCorrigido = somaPesos > 0 ? somaDistCorrigido / somaPesos : 0;

  // A correcao e valida se aproximou o ponto das referencias
  // ou se manteve a mesma distancia
  const melhorou = mediaDistCorrigido <= mediaDistOriginal;
  const diferencaMetros = mediaDistOriginal - mediaDistCorrigido;

  // Calcular confianca baseado na quantidade e qualidade das referencias
  const scoreRefMedia = referencias.reduce((sum, r) => sum + r.scoreReferencia, 0) / referencias.length;
  let confianca = 0.5 + (scoreRefMedia * 0.3) + (Math.min(referencias.length, 5) / 5 * 0.2);

  if (melhorou) {
    confianca += 0.1;
  }

  return {
    valido: melhorou || Math.abs(diferencaMetros) < 5, // Aceitar se melhorou ou variacao < 5m
    confianca: Math.min(confianca, 1.0),
    motivo: melhorou
      ? `correcao_aproximou_${diferencaMetros.toFixed(1)}m`
      : `correcao_afastou_${Math.abs(diferencaMetros).toFixed(1)}m`,
    referencias: referencias.length,
    distOriginal: mediaDistOriginal.toFixed(1),
    distCorrigido: mediaDistCorrigido.toFixed(1)
  };
}

/**
 * Sugere correcao baseada em pontos de referencia proximos
 * @param {number} dispositivoId - ID do dispositivo
 * @param {number} lat - Latitude do ponto a corrigir
 * @param {number} lon - Longitude do ponto a corrigir
 * @returns {Object} { sugerido: boolean, lat, lon, confianca, motivo }
 */
async function sugerirCorrecaoPorReferencia(dispositivoId, lat, lon) {
  const referencias = await buscarReferenciasProximas(dispositivoId, lat, lon);

  if (referencias.length < CONFIG.minPontosParaTreinar) {
    return {
      sugerido: false,
      lat,
      lon,
      confianca: 0,
      motivo: 'referencias_insuficientes'
    };
  }

  // Calcular posicao media ponderada pelas referencias
  let somaLatPeso = 0;
  let somaLonPeso = 0;
  let somaPesos = 0;

  for (const ref of referencias) {
    const peso = ref.peso * ref.scoreReferencia;
    somaLatPeso += ref.latitude * peso;
    somaLonPeso += ref.longitude * peso;
    somaPesos += peso;
  }

  if (somaPesos === 0) {
    return { sugerido: false, lat, lon, confianca: 0, motivo: 'sem_peso' };
  }

  const latSugerido = somaLatPeso / somaPesos;
  const lonSugerido = somaLonPeso / somaPesos;

  // Calcular correcao
  const correcaoMetros = calcularDistancia(lat, lon, latSugerido, lonSugerido);

  // So sugerir se a correcao for significativa mas nao muito grande
  if (correcaoMetros < 1 || correcaoMetros > 50) {
    return {
      sugerido: false,
      lat,
      lon,
      confianca: 0.5,
      motivo: correcaoMetros < 1 ? 'correcao_muito_pequena' : 'correcao_muito_grande'
    };
  }

  // Interpolar: nao ir 100% para a posicao sugerida
  // Quanto maior a correcao, menor o fator (mais conservador)
  const fator = Math.min(0.6, Math.max(0.2, 1 - (correcaoMetros / 100))); // 20-60% de interpolacao
  const latFinal = lat + (latSugerido - lat) * fator;
  const lonFinal = lon + (lonSugerido - lon) * fator;

  const confianca = Math.min(0.9, 0.5 + (referencias.length / 10) * 0.3);

  return {
    sugerido: true,
    lat: latFinal,
    lon: lonFinal,
    lat_original: lat,
    lon_original: lon,
    correcao_metros: calcularDistancia(lat, lon, latFinal, lonFinal),
    confianca,
    referencias: referencias.length,
    motivo: 'correcao_por_referencias'
  };
}

/**
 * Obtem estatisticas de pontos de referencia para um dispositivo
 */
async function obterEstatisticasReferencia(imei) {
  try {
    const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
    if (!dispositivo) return { erro: 'Dispositivo nao encontrado' };

    const pontosRef = await obterPontosReferencia(dispositivo.id, true);

    if (pontosRef.length === 0) {
      return {
        total: 0,
        cobertura: '0%',
        qualidadeMedia: 0,
        regioes: 0
      };
    }

    // Calcular estatisticas
    const scoreMedia = pontosRef.reduce((sum, p) => sum + p.scoreReferencia, 0) / pontosRef.length;
    const regioes = new Set(pontosRef.map(p => p.gridKey)).size;
    const cache = cacheReferencia.get(dispositivo.id);
    const totalPontos = cache ? cache.total : 0;
    const cobertura = totalPontos > 0 ? ((pontosRef.length / totalPontos) * 100).toFixed(1) : '0';

    // Distribuicao por score
    const distribuicao = {
      excelente: pontosRef.filter(p => p.scoreReferencia >= 0.9).length,
      bom: pontosRef.filter(p => p.scoreReferencia >= 0.8 && p.scoreReferencia < 0.9).length,
      aceitavel: pontosRef.filter(p => p.scoreReferencia < 0.8).length
    };

    return {
      total: pontosRef.length,
      totalPontos,
      cobertura: cobertura + '%',
      qualidadeMedia: (scoreMedia * 100).toFixed(1) + '%',
      regioes,
      distribuicao,
      ultimaAtualizacao: cache ? new Date(cache.timestamp).toISOString() : null
    };
  } catch (error) {
    console.error('[GPS-Ref] Erro ao obter estatisticas:', error.message);
    return { erro: error.message };
  }
}

/**
 * Treina a IA usando pontos de referencia como verdade
 */
async function treinarIAComReferencias(dispositivoId, gpsAI) {
  const pontosRef = await obterPontosReferencia(dispositivoId);

  if (pontosRef.length < CONFIG.minPontosParaTreinar) {
    console.log(`[GPS-Ref] Pontos insuficientes para treinar: ${pontosRef.length}`);
    return { treinados: 0, motivo: 'pontos_insuficientes' };
  }

  let treinados = 0;

  // Para cada ponto de referencia, treinar a IA
  for (const ref of pontosRef) {
    // Simular que o ponto de referencia e a "verdade"
    // e usar para ajustar o bias da regiao
    if (gpsAI && typeof gpsAI.treinarComFeedback === 'function') {
      // O ponto de referencia e a posicao correta
      gpsAI.treinarComFeedback(
        { latitude: ref.latitude, longitude: ref.longitude },
        { latitude: ref.latitude, longitude: ref.longitude }, // Mesma posicao = sem erro
        ref.dispositivo_id
      );
      treinados++;
    }
  }

  console.log(`[GPS-Ref] Treinamento concluido: ${treinados} pontos de referencia usados`);

  return {
    treinados,
    totalReferencias: pontosRef.length,
    qualidadeMedia: (pontosRef.reduce((s, p) => s + p.scoreReferencia, 0) / pontosRef.length * 100).toFixed(1) + '%'
  };
}

module.exports = {
  avaliarPrecisaoPonto,
  identificarPontosAltaPrecisao,
  carregarPontosReferencia,
  obterPontosReferencia,
  buscarReferenciasProximas,
  validarCorrecaoComReferencia,
  sugerirCorrecaoPorReferencia,
  obterEstatisticasReferencia,
  treinarIAComReferencias,
  CONFIG
};
