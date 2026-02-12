/**
 * GPS Unificado Service - Servico Central de Correcao GPS
 *
 * Este servico UNIFICA todas as tratativas de correcao GPS em um unico lugar.
 * Deve ser usado por TODOS os endpoints que precisam corrigir rotas:
 * - Card de Localizacao GPS
 * - Aba Viagens / Historico
 * - Tela de IA GPS
 * - Botao de IA em Acoes
 *
 * Pipeline de correcao:
 * 1. Validacao inicial (HDOP, velocidade, coordenadas)
 * 2. Remocao de saltos impossiveis
 * 3. Correcao por pontos de referencia (alta precisao)
 * 4. Filtro de Kalman para suavizacao
 * 5. Snap-to-road opcional (OSRM)
 * 6. Aprendizado automatico
 */

const prisma = require('../db/prisma');

// Importar servicos especializados
let gpsAICorrection = null;
let gpsReferencia = null;
let gpsAprendizado = null;
let gpsFilter = null;
let gpsPipeline = null;

// Carregar servicos com fallback
try {
  gpsAICorrection = require('./gps-ai-correction.service');
  console.log('[GPS-Unificado] Servico de correcao IA carregado');
} catch (e) {
  console.warn('[GPS-Unificado] Correcao IA nao disponivel:', e.message);
}

try {
  gpsReferencia = require('./gps-referencia.service');
  console.log('[GPS-Unificado] Servico de referencias carregado');
} catch (e) {
  console.warn('[GPS-Unificado] Referencias nao disponivel:', e.message);
}

try {
  gpsAprendizado = require('./gps-aprendizado.service');
  console.log('[GPS-Unificado] Servico de aprendizado carregado');
} catch (e) {
  console.warn('[GPS-Unificado] Aprendizado nao disponivel:', e.message);
}

try {
  gpsFilter = require('./gps-filter.service');
  console.log('[GPS-Unificado] Servico de filtros carregado');
} catch (e) {
  console.warn('[GPS-Unificado] Filtros nao disponivel:', e.message);
}

try {
  gpsPipeline = require('./gps-pipeline.service');
  console.log('[GPS-Unificado] Pipeline GPS carregado');
} catch (e) {
  console.warn('[GPS-Unificado] Pipeline nao disponivel:', e.message);
}

// Configuracao unificada
const CONFIG = {
  // Validacao
  maxHDOP: 8,
  maxVelocidadeKmh: 180,
  coordenadasBrasil: {
    latMin: -35, latMax: 5,
    lonMin: -75, lonMax: -30
  },

  // Correcao
  maxCorrecaoMetros: 30,
  minPontosParaCorrecao: 3,

  // Referencias - DESATIVADO: estava puxando pontos para coordenadas médias
  usarReferencias: false,
  raioReferenciaMetros: 150,

  // Pipeline
  usarKalman: true,
  usarSnapToRoad: true, // Habilitado para encaixar pontos nas vias reais

  // Snap-to-Road (OSRM) - Encaixar pontos nas estradas reais
  snapToRoad: {
    enabled: true, // Habilitado para corrigir pontos fora da via
    osrmUrl: process.env.OSRM_URL || 'http://osrm-sul-brasil:5000/match/v1/driving',  // OSRM Docker
    radiusMetros: 60, // Raio de busca aumentado para cobrir erros urbanos
    maxDistanciaCorrecao: 80, // Maximo de metros para corrigir (aumentado)
    minPontosParaBatch: 5, // Minimo de pontos para chamar OSRM
  },

  // Aprendizado
  treinarAutomaticamente: true,
};

/**
 * Calcula distancia entre dois pontos em metros (Haversine)
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
 * Valida um ponto GPS
 */
function validarPonto(ponto) {
  const erros = [];

  // Coordenadas validas
  if (!ponto.latitude || !ponto.longitude) {
    erros.push('coordenadas_ausentes');
  } else {
    if (ponto.latitude < CONFIG.coordenadasBrasil.latMin ||
        ponto.latitude > CONFIG.coordenadasBrasil.latMax) {
      erros.push('latitude_fora_brasil');
    }
    if (ponto.longitude < CONFIG.coordenadasBrasil.lonMin ||
        ponto.longitude > CONFIG.coordenadasBrasil.lonMax) {
      erros.push('longitude_fora_brasil');
    }
  }

  // HDOP
  const hdop = ponto.hdop || ponto.precisao || 5;
  if (Math.abs(hdop) > CONFIG.maxHDOP) {
    erros.push('hdop_alto');
  }

  // Velocidade
  if (ponto.velocidade && ponto.velocidade > CONFIG.maxVelocidadeKmh) {
    erros.push('velocidade_impossivel');
  }

  return {
    valido: erros.length === 0,
    erros,
    hdop: Math.abs(hdop)
  };
}

/**
 * Remove saltos impossiveis entre pontos
 */
function removerSaltosImpossives(pontos) {
  if (pontos.length < 2) return pontos;

  const resultado = [pontos[0]];

  for (let i = 1; i < pontos.length; i++) {
    const anterior = resultado[resultado.length - 1];
    const atual = pontos[i];

    const distanciaMetros = calcularDistancia(
      anterior.latitude, anterior.longitude,
      atual.latitude, atual.longitude
    );

    const tempoSegundos = (new Date(atual.timestamp) - new Date(anterior.timestamp)) / 1000;

    if (tempoSegundos > 0) {
      const velocidadeKmh = (distanciaMetros / tempoSegundos) * 3.6;

      if (velocidadeKmh <= CONFIG.maxVelocidadeKmh) {
        resultado.push(atual);
      } else {
        console.log(`[GPS-Unificado] Removendo salto impossivel: ${velocidadeKmh.toFixed(0)} km/h`);
      }
    } else {
      resultado.push(atual);
    }
  }

  return resultado;
}

/**
 * FUNCAO PRINCIPAL: Corrige uma rota completa
 *
 * @param {Array} pontos - Array de pontos GPS
 * @param {Object} opcoes - Opcoes de correcao
 * @param {number} dispositivoId - ID do dispositivo (para referencias e aprendizado)
 * @returns {Object} { pontos: Array, estatisticas: Object }
 */
async function corrigirRota(pontos, opcoes = {}, dispositivoId = null) {
  const inicio = Date.now();

  const config = {
    usarReferencias: opcoes.usarReferencias ?? CONFIG.usarReferencias,
    usarKalman: opcoes.usarKalman ?? CONFIG.usarKalman,
    usarSnapToRoad: opcoes.usarSnapToRoad ?? CONFIG.usarSnapToRoad,
    treinar: opcoes.treinar ?? CONFIG.treinarAutomaticamente,
  };

  const estatisticas = {
    pontos_originais: pontos.length,
    pontos_validos: 0,
    pontos_removidos_salto: 0,
    pontos_corrigidos_referencia: 0,
    pontos_corrigidos_ia: 0,
    pontos_corrigidos_kalman: 0,
    pontos_finais: 0,
    tempo_ms: 0,
    metodos_usados: []
  };

  if (pontos.length < CONFIG.minPontosParaCorrecao) {
    return {
      pontos: pontos.map(p => ({
        ...p,
        corrigido: false,
        metodo: 'passthrough_poucos_pontos'
      })),
      estatisticas
    };
  }

  // 1. Validar pontos
  let pontosValidos = pontos.filter(p => {
    const validacao = validarPonto(p);
    return validacao.valido;
  });
  estatisticas.pontos_validos = pontosValidos.length;

  // 2. Remover saltos impossiveis
  const antesRemocao = pontosValidos.length;
  pontosValidos = removerSaltosImpossives(pontosValidos);
  estatisticas.pontos_removidos_salto = antesRemocao - pontosValidos.length;

  if (pontosValidos.length < CONFIG.minPontosParaCorrecao) {
    return {
      pontos: pontosValidos.map(p => ({
        ...p,
        corrigido: false,
        metodo: 'passthrough_apos_validacao'
      })),
      estatisticas
    };
  }

  // 3. Correcao por pontos de referencia (se disponivel)
  let pontosCorrigidos = [...pontosValidos];

  if (config.usarReferencias && gpsReferencia && dispositivoId) {
    estatisticas.metodos_usados.push('referencias');

    // Carregar referencias do dispositivo
    await gpsReferencia.carregarPontosReferencia(dispositivoId, 48); // Ultimas 48h

    for (let i = 0; i < pontosCorrigidos.length; i++) {
      const ponto = pontosCorrigidos[i];

      try {
        const sugestao = await gpsReferencia.sugerirCorrecaoPorReferencia(
          dispositivoId,
          ponto.latitude,
          ponto.longitude
        );

        if (sugestao.sugerido && sugestao.confianca >= 0.5) {
          pontosCorrigidos[i] = {
            ...ponto,
            latitude: sugestao.lat,
            longitude: sugestao.lon,
            lat_original: ponto.latitude,
            lon_original: ponto.longitude,
            corrigido: true,
            metodo: 'referencia',
            correcao_metros: sugestao.correcao_metros,
            confianca: sugestao.confianca
          };
          estatisticas.pontos_corrigidos_referencia++;
        }
      } catch (e) {
        // Silencioso - continuar sem correcao
      }
    }
  }

  // 4. Correcao por IA (para pontos nao corrigidos)
  if (gpsAICorrection) {
    estatisticas.metodos_usados.push('ia_correcao');

    for (let i = 0; i < pontosCorrigidos.length; i++) {
      const ponto = pontosCorrigidos[i];

      // Pular se ja foi corrigido por referencia
      if (ponto.corrigido && ponto.metodo === 'referencia') {
        continue;
      }

      try {
        const historico = pontosCorrigidos.slice(Math.max(0, i - 5), i);
        const imei = opcoes.imei || `disp_${dispositivoId}`;

        const correcao = await gpsAICorrection.corrigir({
          latitude: ponto.latitude,
          longitude: ponto.longitude,
          velocidade: ponto.velocidade,
          direcao: ponto.direcao,
          hdop: ponto.hdop || ponto.precisao,
          timestamp: ponto.timestamp,
          dispositivo_id: dispositivoId
        }, imei);

        if (correcao.correcao_metros > 1 && correcao.confianca >= 0.5) {
          pontosCorrigidos[i] = {
            ...ponto,
            latitude: correcao.lat,
            longitude: correcao.lon,
            lat_original: ponto.lat_original || ponto.latitude,
            lon_original: ponto.lon_original || ponto.longitude,
            corrigido: true,
            metodo: correcao.metodo_interno || 'ia',
            correcao_metros: correcao.correcao_metros,
            confianca: correcao.confianca
          };
          estatisticas.pontos_corrigidos_ia++;
        }
      } catch (e) {
        // Silencioso
      }
    }
  }

  // 5. Filtro de Kalman para suavizacao final (se habilitado)
  if (config.usarKalman && gpsFilter) {
    estatisticas.metodos_usados.push('kalman');

    try {
      const resultado = await gpsFilter.processarRotaCompleta(pontosCorrigidos, {
        usarKalman: true,
        usarMediaMovel: false, // Desabilitado
        usarHampel: true,
        usarInterpolacao: true,  // ATIVADO: Interpola gaps
        usarOSRM: true           // ATIVADO: Cola pontos nas ruas reais
      });

      if (resultado && resultado.pontos) {
        // Mesclar resultados mantendo metadados
        for (let i = 0; i < Math.min(pontosCorrigidos.length, resultado.pontos.length); i++) {
          const original = pontosCorrigidos[i];
          const filtrado = resultado.pontos[i];

          if (filtrado && filtrado.latitude !== original.latitude) {
            pontosCorrigidos[i] = {
              ...original,
              latitude: filtrado.latitude,
              longitude: filtrado.longitude,
              lat_pre_kalman: original.latitude,
              lon_pre_kalman: original.longitude,
              corrigido: true,
              metodo: original.metodo ? `${original.metodo}+kalman` : 'kalman'
            };
            estatisticas.pontos_corrigidos_kalman++;
          }
        }
      }
    } catch (e) {
      console.warn('[GPS-Unificado] Erro no Kalman:', e.message);
    }
  }

  // 6. Aprendizado automatico (se habilitado)
  if (config.treinar && gpsAprendizado && dispositivoId) {
    for (const ponto of pontosCorrigidos) {
      if (ponto.corrigido && ponto.lat_original) {
        try {
          await gpsAprendizado.salvarAprendizado(
            dispositivoId,
            { lat: ponto.lat_original, lon: ponto.lon_original },
            { lat: ponto.latitude, lon: ponto.longitude },
            ponto.metodo || 'correcao_unificada'
          );
        } catch (e) {
          // Silencioso
        }
      }
    }
  }

  // Finalizar estatisticas
  estatisticas.pontos_finais = pontosCorrigidos.length;
  estatisticas.tempo_ms = Date.now() - inicio;
  estatisticas.taxa_correcao = pontosCorrigidos.length > 0
    ? ((pontosCorrigidos.filter(p => p.corrigido).length / pontosCorrigidos.length) * 100).toFixed(1) + '%'
    : '0%';

  return {
    pontos: pontosCorrigidos,
    estatisticas
  };
}

/**
 * Corrige um unico ponto GPS (para uso em tempo real)
 */
async function corrigirPonto(ponto, dispositivoId, imei) {
  const validacao = validarPonto(ponto);

  if (!validacao.valido) {
    return {
      ...ponto,
      corrigido: false,
      erros: validacao.erros
    };
  }

  // Tentar correcao por referencia primeiro
  if (gpsReferencia && dispositivoId) {
    try {
      const sugestao = await gpsReferencia.sugerirCorrecaoPorReferencia(
        dispositivoId,
        ponto.latitude,
        ponto.longitude
      );

      if (sugestao.sugerido && sugestao.confianca >= 0.6) {
        return {
          ...ponto,
          latitude: sugestao.lat,
          longitude: sugestao.lon,
          lat_original: ponto.latitude,
          lon_original: ponto.longitude,
          corrigido: true,
          metodo: 'referencia',
          correcao_metros: sugestao.correcao_metros,
          confianca: sugestao.confianca
        };
      }
    } catch (e) {
      // Continuar para IA
    }
  }

  // Tentar correcao por IA
  if (gpsAICorrection) {
    try {
      const correcao = await gpsAICorrection.corrigir({
        latitude: ponto.latitude,
        longitude: ponto.longitude,
        velocidade: ponto.velocidade,
        direcao: ponto.direcao,
        hdop: ponto.hdop || ponto.precisao,
        timestamp: ponto.timestamp,
        dispositivo_id: dispositivoId
      }, imei);

      if (correcao.correcao_metros > 1 && correcao.confianca >= 0.5) {
        return {
          ...ponto,
          latitude: correcao.lat,
          longitude: correcao.lon,
          lat_original: ponto.latitude,
          lon_original: ponto.longitude,
          corrigido: true,
          metodo: correcao.metodo_interno || 'ia',
          correcao_metros: correcao.correcao_metros,
          confianca: correcao.confianca
        };
      }
    } catch (e) {
      // Retornar original
    }
  }

  return {
    ...ponto,
    corrigido: false,
    metodo: 'passthrough'
  };
}

/**
 * Pre-analisa uma rota e retorna estatisticas sem aplicar correcoes
 * Usado para preview antes de aplicar
 */
async function preAnalisarRota(pontos, dispositivoId) {
  const analise = {
    total_pontos: pontos.length,
    pontos_validos: 0,
    pontos_invalidos: 0,
    pontos_com_salto: 0,
    pontos_fora_rua: 0,
    qualidade_geral: 0,
    referencias_disponiveis: 0,
    sugestoes_correcao: 0,
    distancia_total_km: 0,
    tempo_total_min: 0,
    detalhes: []
  };

  if (pontos.length < 2) {
    return analise;
  }

  // Validar pontos
  for (let i = 0; i < pontos.length; i++) {
    const ponto = pontos[i];
    const validacao = validarPonto(ponto);

    if (validacao.valido) {
      analise.pontos_validos++;
    } else {
      analise.pontos_invalidos++;
      analise.detalhes.push({
        indice: i,
        tipo: 'invalido',
        erros: validacao.erros,
        ponto: { lat: ponto.latitude, lon: ponto.longitude }
      });
    }
  }

  // Detectar saltos
  for (let i = 1; i < pontos.length; i++) {
    const anterior = pontos[i - 1];
    const atual = pontos[i];

    const distanciaMetros = calcularDistancia(
      anterior.latitude, anterior.longitude,
      atual.latitude, atual.longitude
    );

    const tempoSegundos = (new Date(atual.timestamp) - new Date(anterior.timestamp)) / 1000;

    if (tempoSegundos > 0) {
      const velocidadeKmh = (distanciaMetros / tempoSegundos) * 3.6;

      if (velocidadeKmh > CONFIG.maxVelocidadeKmh) {
        analise.pontos_com_salto++;
        analise.detalhes.push({
          indice: i,
          tipo: 'salto_impossivel',
          velocidade: velocidadeKmh.toFixed(0),
          distancia: distanciaMetros.toFixed(0)
        });
      }

      analise.distancia_total_km += distanciaMetros / 1000;
    }
  }

  // Calcular tempo total
  if (pontos.length >= 2) {
    const tempoMs = new Date(pontos[pontos.length - 1].timestamp) - new Date(pontos[0].timestamp);
    analise.tempo_total_min = (tempoMs / 60000).toFixed(1);
  }

  // Verificar referencias disponiveis
  if (gpsReferencia && dispositivoId) {
    try {
      const stats = await gpsReferencia.obterEstatisticasReferencia(
        await obterImeiPorDispositivoId(dispositivoId)
      );
      analise.referencias_disponiveis = stats.total || 0;

      // Contar quantos pontos podem ser corrigidos por referencia
      await gpsReferencia.carregarPontosReferencia(dispositivoId, 48);

      for (const ponto of pontos) {
        try {
          const sugestao = await gpsReferencia.sugerirCorrecaoPorReferencia(
            dispositivoId,
            ponto.latitude,
            ponto.longitude
          );
          if (sugestao.sugerido) {
            analise.sugestoes_correcao++;
          }
        } catch (e) {
          // Continuar
        }
      }
    } catch (e) {
      // Silencioso
    }
  }

  // Calcular qualidade geral (0-100)
  const taxaValidos = analise.pontos_validos / analise.total_pontos;
  const taxaSemSalto = 1 - (analise.pontos_com_salto / analise.total_pontos);
  analise.qualidade_geral = Math.round((taxaValidos * 0.5 + taxaSemSalto * 0.5) * 100);

  return analise;
}

/**
 * Obtem IMEI por dispositivo ID
 */
async function obterImeiPorDispositivoId(dispositivoId) {
  try {
    const disp = await prisma.dispositivo.findUnique({
      where: { id: dispositivoId },
      select: { imei: true }
    });
    return disp?.imei;
  } catch (e) {
    return null;
  }
}

/**
 * Treina a IA com feedback do usuario
 */
async function treinarComFeedback(dispositivoId, pontosOriginais, pontosCorrigidos, aprovado, avaliacao) {
  if (!gpsAprendizado) return { sucesso: false, motivo: 'aprendizado_nao_disponivel' };

  try {
    let treinados = 0;

    for (let i = 0; i < Math.min(pontosOriginais.length, pontosCorrigidos.length); i++) {
      const original = pontosOriginais[i];
      const corrigido = pontosCorrigidos[i];

      if (original.latitude !== corrigido.latitude || original.longitude !== corrigido.longitude) {
        await gpsAprendizado.salvarAprendizado(
          dispositivoId,
          { lat: original.latitude, lon: original.longitude },
          { lat: corrigido.latitude, lon: corrigido.longitude },
          aprovado ? 'aprovado_usuario' : 'rejeitado_usuario'
        );
        treinados++;
      }
    }

    // Atualizar modelo se existir
    if (gpsAICorrection && gpsAICorrection.atualizarModeloIA) {
      await gpsAICorrection.atualizarModeloIA('dispositivo', String(dispositivoId), aprovado, avaliacao || (aprovado ? 5 : 1));
    }

    return {
      sucesso: true,
      treinados,
      aprovado
    };
  } catch (e) {
    return { sucesso: false, motivo: e.message };
  }
}

/**
 * Obtem estatisticas do sistema unificado
 */
async function obterEstatisticas(imei) {
  const stats = {
    servicos_ativos: [],
    referencias: null,
    aprendizado: null,
    ia: null
  };

  if (gpsReferencia) {
    stats.servicos_ativos.push('referencias');
    try {
      stats.referencias = await gpsReferencia.obterEstatisticasReferencia(imei);
    } catch (e) {
      stats.referencias = { erro: e.message };
    }
  }

  if (gpsAprendizado) {
    stats.servicos_ativos.push('aprendizado');
    try {
      const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
      if (dispositivo) {
        stats.aprendizado = await gpsAprendizado.obterEstatisticas(dispositivo.id);
      }
    } catch (e) {
      stats.aprendizado = { erro: e.message };
    }
  }

  if (gpsAICorrection) {
    stats.servicos_ativos.push('ia_correcao');
    try {
      stats.ia = gpsAICorrection.getStats ? gpsAICorrection.getStats() : { disponivel: true };
    } catch (e) {
      stats.ia = { erro: e.message };
    }
  }

  if (gpsFilter) stats.servicos_ativos.push('filtros');
  if (gpsPipeline) stats.servicos_ativos.push('pipeline');

  return stats;
}

// ==================== SNAP-TO-ROAD (OSRM) ====================

/**
 * Encaixa pontos GPS nas estradas reais usando OSRM
 * Compara a rota com as linhas de estrada do mapa
 *
 * @param {Array} pontos - Array de pontos GPS
 * @param {Object} opcoes - Opcoes de configuracao
 * @returns {Object} - Pontos corrigidos + estatisticas
 */
async function snapToRoad(pontos, opcoes = {}) {
  if (!pontos || pontos.length < 2) {
    return {
      sucesso: false,
      erro: 'Minimo de 2 pontos necessarios',
      pontos: pontos || []
    };
  }

  const config = {
    osrmUrl: opcoes.osrmUrl || CONFIG.snapToRoad.osrmUrl,
    radiusMetros: opcoes.radiusMetros || CONFIG.snapToRoad.radiusMetros,
    maxDistanciaCorrecao: opcoes.maxDistanciaCorrecao || CONFIG.snapToRoad.maxDistanciaCorrecao
  };

  try {
    const fetch = (await import('node-fetch')).default;

    // Preparar coordenadas para OSRM (formato: lon,lat)
    const coords = pontos.map(p => {
      const lon = p.longitude || p.lon || p.lng;
      const lat = p.latitude || p.lat;
      return `${lon},${lat}`;
    }).join(';');

    // Timestamps para melhor matching
    const timestamps = pontos.map(p => {
      if (p.timestamp) {
        return Math.floor(new Date(p.timestamp).getTime() / 1000);
      }
      return Math.floor(Date.now() / 1000);
    }).join(';');

    // Raios de busca
    const radiuses = pontos.map(() => config.radiusMetros).join(';');

    // URL do OSRM
    const url = `${config.osrmUrl}/${coords}?` +
      `timestamps=${timestamps}&` +
      `radiuses=${radiuses}&` +
      `geometries=geojson&` +
      `overview=full&` +
      `annotations=true&` +
      `gaps=ignore`;

    console.log(`[Snap-to-Road] Chamando OSRM com ${pontos.length} pontos...`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`OSRM HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
      console.warn('[Snap-to-Road] OSRM nao encontrou rota:', data.code);
      return {
        sucesso: false,
        erro: `OSRM: ${data.code || 'Nenhuma rota encontrada'}`,
        pontos: pontos.map(p => ({ ...p, snapped: false }))
      };
    }

    // Processar resultado
    const pontosSnapped = [];
    let totalSnapped = 0;
    let distanciaTotal = 0;

    // OSRM retorna tracepoints com os pontos matched
    if (data.tracepoints) {
      for (let i = 0; i < data.tracepoints.length; i++) {
        const tp = data.tracepoints[i];
        const original = pontos[i];
        const latOriginal = original.latitude || original.lat;
        const lonOriginal = original.longitude || original.lon || original.lng;

        if (tp && tp.location) {
          const [lonSnapped, latSnapped] = tp.location;
          const distancia = calcularDistancia(latOriginal, lonOriginal, latSnapped, lonSnapped);

          // Verificar se a correcao esta dentro do limite
          if (distancia <= config.maxDistanciaCorrecao) {
            pontosSnapped.push({
              ...original,
              latitude: latSnapped,
              longitude: lonSnapped,
              lat_original: latOriginal,
              lon_original: lonOriginal,
              snapped: true,
              distancia_snap: distancia,
              nome_rua: tp.name || null,
              confianca_snap: tp.matchings_index !== null ? 0.9 : 0.7
            });
            totalSnapped++;
            distanciaTotal += distancia;
          } else {
            // Correcao muito grande, manter original
            pontosSnapped.push({
              ...original,
              latitude: latOriginal,
              longitude: lonOriginal,
              snapped: false,
              motivo: `Distancia ${distancia.toFixed(1)}m excede limite de ${config.maxDistanciaCorrecao}m`
            });
          }
        } else {
          // Ponto nao matched
          pontosSnapped.push({
            ...original,
            latitude: latOriginal,
            longitude: lonOriginal,
            snapped: false,
            motivo: 'OSRM nao encontrou estrada proxima'
          });
        }
      }
    }

    // Estatisticas
    const estatisticas = {
      total_pontos: pontos.length,
      pontos_snapped: totalSnapped,
      pontos_mantidos: pontos.length - totalSnapped,
      taxa_snap: ((totalSnapped / pontos.length) * 100).toFixed(1) + '%',
      distancia_media_snap: totalSnapped > 0 ? (distanciaTotal / totalSnapped).toFixed(2) + 'm' : '0m',
      distancia_total_rota: data.matchings[0]?.distance ? (data.matchings[0].distance / 1000).toFixed(2) + 'km' : null,
      duracao_estimada: data.matchings[0]?.duration ? Math.round(data.matchings[0].duration / 60) + 'min' : null
    };

    console.log(`[Snap-to-Road] Concluido: ${totalSnapped}/${pontos.length} pontos encaixados nas estradas`);

    return {
      sucesso: true,
      pontos: pontosSnapped,
      estatisticas,
      // Geometria da rota para desenhar no mapa
      rota_estrada: data.matchings[0]?.geometry?.coordinates?.map(([lon, lat]) => ({ lat, lng: lon })) || []
    };

  } catch (error) {
    console.error('[Snap-to-Road] Erro:', error.message);
    return {
      sucesso: false,
      erro: error.message,
      pontos: pontos.map(p => ({
        ...p,
        latitude: p.latitude || p.lat,
        longitude: p.longitude || p.lon || p.lng,
        snapped: false
      }))
    };
  }
}

/**
 * Compara rota GPS com estradas reais
 * Retorna analise de desvio e sugestoes
 */
async function compararComEstradas(pontos, dispositivoId = null) {
  const resultado = await snapToRoad(pontos);

  if (!resultado.sucesso) {
    return resultado;
  }

  // Calcular desvios
  const desvios = [];
  let desvioTotal = 0;
  let pontosForaEstrada = 0;

  for (const p of resultado.pontos) {
    if (p.snapped && p.distancia_snap > 0) {
      desvios.push({
        lat: p.lat_original,
        lng: p.lon_original,
        distancia: p.distancia_snap,
        nome_rua: p.nome_rua
      });
      desvioTotal += p.distancia_snap;
      if (p.distancia_snap > 15) {
        pontosForaEstrada++;
      }
    }
  }

  // Classificar qualidade
  const desvioMedio = desvios.length > 0 ? desvioTotal / desvios.length : 0;
  let qualidade = 'excelente';
  if (desvioMedio > 20) qualidade = 'ruim';
  else if (desvioMedio > 10) qualidade = 'regular';
  else if (desvioMedio > 5) qualidade = 'boa';

  return {
    sucesso: true,
    analise: {
      qualidade,
      desvio_medio_metros: desvioMedio.toFixed(2),
      pontos_fora_estrada: pontosForaEstrada,
      total_pontos: resultado.pontos.length,
      recomendacao: desvioMedio > 10
        ? 'Rota com desvios significativos - correcao RECOMENDADA'
        : 'Rota alinhada com estradas - correcao opcional'
    },
    pontos: resultado.pontos,
    estatisticas: resultado.estatisticas,
    rota_estrada: resultado.rota_estrada,
    desvios
  };
}

module.exports = {
  corrigirRota,
  corrigirPonto,
  preAnalisarRota,
  treinarComFeedback,
  obterEstatisticas,
  validarPonto,
  calcularDistancia,
  snapToRoad,
  compararComEstradas,
  CONFIG
};
