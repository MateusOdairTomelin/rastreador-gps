/**
 * GPS Aprendizado Service
 *
 * Sistema de aprendizado de rotas que:
 * 1. Salva correções aprovadas como coordenadas de referência
 * 2. Busca coordenadas similares quando chegam novos dados GPS
 * 3. Aplica correções automaticamente baseadas no histórico
 *
 * Usa sistema de grid espacial para busca rápida (~11m de precisão)
 */

const prisma = require('../db/prisma');

// Cache em memória para acelerar buscas (por dispositivo)
const cacheAprendizado = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const CACHE_MAX_SIZE = 10000; // Máximo de coordenadas por dispositivo no cache

/**
 * Calcula o grid espacial para uma coordenada
 * Cada célula do grid tem ~11m x 11m (0.0001 grau ~ 11m)
 */
function calcularGrid(lat, lon) {
  const precisao = 10000; // 4 casas decimais = ~11m
  return {
    gridLat: Math.floor(lat * precisao) / precisao,
    gridLon: Math.floor(lon * precisao) / precisao
  };
}

/**
 * Calcula distância entre dois pontos em metros (Haversine)
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
 * Salva uma correção como aprendizado
 * @param {number} dispositivoId - ID do dispositivo
 * @param {object} original - {lat, lon} coordenada original
 * @param {object} corrigido - {lat, lon} coordenada corrigida
 * @param {string} metodo - 'micro_ajuste' ou 'snap_to_road'
 */
async function salvarAprendizado(dispositivoId, original, corrigido, metodo) {
  try {
    const { gridLat, gridLon } = calcularGrid(original.lat, original.lon);
    const distancia = calcularDistancia(original.lat, original.lon, corrigido.lat, corrigido.lon);

    // Só salvar se a correção for significativa (> 3m) e razoável (< 100m)
    // Correções > 100m são claramente erros de GPS/LBS, não devem ser aprendidas
    if (distancia < 3) {
      return null;
    }

    if (distancia > 100) {
      console.warn(`[Aprendizado] REJEITADO: correção de ${distancia.toFixed(0)}m é muito grande (max 100m)`);
      return null;
    }

    // Upsert - atualiza se já existe para este grid, senão cria
    const aprendizado = await prisma.coordenadaAprendida.upsert({
      where: {
        dispositivo_id_grid_lat_grid_lon: {
          dispositivo_id: dispositivoId,
          grid_lat: gridLat,
          grid_lon: gridLon
        }
      },
      update: {
        lat_original: original.lat,
        lon_original: original.lon,
        lat_corrigido: corrigido.lat,
        lon_corrigido: corrigido.lon,
        metodo,
        distancia,
        confianca: Math.min(0.95, 0.9 + (0.01 * (distancia < 20 ? 1 : 0))),
        ultima_uso: new Date()
      },
      create: {
        dispositivo_id: dispositivoId,
        lat_original: original.lat,
        lon_original: original.lon,
        lat_corrigido: corrigido.lat,
        lon_corrigido: corrigido.lon,
        grid_lat: gridLat,
        grid_lon: gridLon,
        metodo,
        distancia,
        confianca: 0.9
      }
    });

    // Invalidar cache para este dispositivo
    cacheAprendizado.delete(dispositivoId);

    console.log(`[Aprendizado] Salvo: dispositivo=${dispositivoId}, grid=(${gridLat}, ${gridLon}), dist=${distancia.toFixed(1)}m`);

    return aprendizado;
  } catch (error) {
    console.error('[Aprendizado] Erro ao salvar:', error.message);
    return null;
  }
}

/**
 * Salva múltiplas correções de uma vez (batch)
 */
async function salvarAprendizadoBatch(dispositivoId, correcoes, metodo) {
  let salvos = 0;

  for (const correcao of correcoes) {
    const resultado = await salvarAprendizado(
      dispositivoId,
      { lat: correcao.lat_original, lon: correcao.lon_original },
      { lat: correcao.lat_corrigido, lon: correcao.lon_corrigido },
      metodo
    );
    if (resultado) salvos++;
  }

  console.log(`[Aprendizado] Batch salvo: ${salvos}/${correcoes.length} correções para dispositivo ${dispositivoId}`);

  return salvos;
}

/**
 * Carrega aprendizado do dispositivo para o cache
 */
async function carregarCacheDispositivo(dispositivoId) {
  try {
    const coordenadas = await prisma.coordenadaAprendida.findMany({
      where: { dispositivo_id: dispositivoId },
      orderBy: { ultima_uso: 'desc' },
      take: CACHE_MAX_SIZE
    });

    // Criar mapa por grid para busca rápida
    const mapa = new Map();
    for (const coord of coordenadas) {
      const chave = `${coord.grid_lat},${coord.grid_lon}`;
      mapa.set(chave, {
        latOriginal: coord.lat_original,
        lonOriginal: coord.lon_original,
        latCorrigido: coord.lat_corrigido,
        lonCorrigido: coord.lon_corrigido,
        confianca: coord.confianca,
        metodo: coord.metodo,
        id: coord.id
      });
    }

    cacheAprendizado.set(dispositivoId, {
      mapa,
      timestamp: Date.now(),
      total: coordenadas.length
    });

    console.log(`[Aprendizado] Cache carregado: dispositivo=${dispositivoId}, ${coordenadas.length} coordenadas`);

    return mapa;
  } catch (error) {
    console.error('[Aprendizado] Erro ao carregar cache:', error.message);
    return new Map();
  }
}

/**
 * Busca coordenada corrigida no aprendizado
 * @returns {object|null} {lat, lon, confianca} se encontrou, null se não
 */
async function buscarCorrecaoAprendida(dispositivoId, lat, lon) {
  try {
    // Verificar cache
    let cache = cacheAprendizado.get(dispositivoId);

    // Recarregar cache se expirado ou não existe
    if (!cache || (Date.now() - cache.timestamp) > CACHE_TTL) {
      await carregarCacheDispositivo(dispositivoId);
      cache = cacheAprendizado.get(dispositivoId);
    }

    if (!cache || cache.mapa.size === 0) {
      return null;
    }

    // Calcular grid da coordenada
    const { gridLat, gridLon } = calcularGrid(lat, lon);
    const chave = `${gridLat},${gridLon}`;

    // Buscar exato no grid
    const aprendido = cache.mapa.get(chave);

    if (aprendido) {
      // Verificar distância para garantir que está próximo o suficiente
      const distOriginal = calcularDistancia(lat, lon, aprendido.latOriginal, aprendido.lonOriginal);

      // Só aplicar se a coordenada original está muito próxima (< 15m)
      // E se a correção é razoável (< 100m)
      const distCorrecao = calcularDistancia(lat, lon, aprendido.latCorrigido, aprendido.lonCorrigido);

      if (distOriginal < 15 && distCorrecao < 100) {
        // Atualizar contador de uso (async, não bloquear)
        prisma.coordenadaAprendida.update({
          where: { id: aprendido.id },
          data: {
            vezes_usado: { increment: 1 },
            ultima_uso: new Date()
          }
        }).catch(() => {}); // Ignorar erros

        return {
          lat: aprendido.latCorrigido,
          lon: aprendido.lonCorrigido,
          confianca: aprendido.confianca,
          metodo: aprendido.metodo,
          distanciaMatch: distOriginal
        };
      }
    }

    // Buscar nos grids vizinhos (8 células ao redor)
    const precisao = 10000;
    const delta = 1 / precisao;

    for (let dLat = -delta; dLat <= delta; dLat += delta) {
      for (let dLon = -delta; dLon <= delta; dLon += delta) {
        if (dLat === 0 && dLon === 0) continue; // Já verificamos

        const vizinhoLat = Math.floor((lat + dLat) * precisao) / precisao;
        const vizinhoLon = Math.floor((lon + dLon) * precisao) / precisao;
        const chaveVizinho = `${vizinhoLat},${vizinhoLon}`;

        const aprendidoVizinho = cache.mapa.get(chaveVizinho);

        if (aprendidoVizinho) {
          const distOriginal = calcularDistancia(lat, lon, aprendidoVizinho.latOriginal, aprendidoVizinho.lonOriginal);

          if (distOriginal < 15) {
            // Atualizar contador
            prisma.coordenadaAprendida.update({
              where: { id: aprendidoVizinho.id },
              data: {
                vezes_usado: { increment: 1 },
                ultima_uso: new Date()
              }
            }).catch(() => {});

            return {
              lat: aprendidoVizinho.latCorrigido,
              lon: aprendidoVizinho.lonCorrigido,
              confianca: aprendidoVizinho.confianca * 0.9, // Reduzir confiança para vizinho
              metodo: aprendidoVizinho.metodo,
              distanciaMatch: distOriginal
            };
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error('[Aprendizado] Erro ao buscar correção:', error.message);
    return null;
  }
}

/**
 * Aplica correção de aprendizado a uma coordenada se disponível
 * Retorna a coordenada corrigida ou a original se não houver aprendizado
 */
async function aplicarCorrecaoAutomatica(dispositivoId, lat, lon) {
  const correcao = await buscarCorrecaoAprendida(dispositivoId, lat, lon);

  if (correcao && correcao.confianca >= 0.7) {
    return {
      lat: correcao.lat,
      lon: correcao.lon,
      corrigido: true,
      metodo: correcao.metodo,
      confianca: correcao.confianca
    };
  }

  return {
    lat,
    lon,
    corrigido: false
  };
}

/**
 * Obtém estatísticas de aprendizado para um dispositivo
 */
async function obterEstatisticas(dispositivoId) {
  try {
    const stats = await prisma.coordenadaAprendida.aggregate({
      where: { dispositivo_id: dispositivoId },
      _count: { id: true },
      _sum: { vezes_usado: true },
      _avg: { confianca: true, distancia: true }
    });

    const porMetodo = await prisma.coordenadaAprendida.groupBy({
      by: ['metodo'],
      where: { dispositivo_id: dispositivoId },
      _count: { id: true }
    });

    return {
      totalCoordenadas: stats._count.id || 0,
      totalAplicacoes: stats._sum.vezes_usado || 0,
      confiancaMedia: (stats._avg.confianca || 0).toFixed(2),
      distanciaMedia: (stats._avg.distancia || 0).toFixed(2) + 'm',
      porMetodo: porMetodo.reduce((acc, item) => {
        acc[item.metodo] = item._count.id;
        return acc;
      }, {})
    };
  } catch (error) {
    console.error('[Aprendizado] Erro ao obter estatísticas:', error.message);
    return null;
  }
}

/**
 * Limpa aprendizados antigos ou pouco usados
 */
async function limparAprendizadosAntigos(diasSemUso = 90) {
  try {
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - diasSemUso);

    const resultado = await prisma.coordenadaAprendida.deleteMany({
      where: {
        OR: [
          { ultima_uso: { lt: dataLimite } },
          { ultima_uso: null, created_at: { lt: dataLimite } }
        ],
        vezes_usado: { lt: 3 } // Só remover se usado menos de 3 vezes
      }
    });

    console.log(`[Aprendizado] Limpeza: ${resultado.count} coordenadas antigas removidas`);

    // Limpar todos os caches
    cacheAprendizado.clear();

    return resultado.count;
  } catch (error) {
    console.error('[Aprendizado] Erro na limpeza:', error.message);
    return 0;
  }
}

module.exports = {
  salvarAprendizado,
  salvarAprendizadoBatch,
  buscarCorrecaoAprendida,
  aplicarCorrecaoAutomatica,
  obterEstatisticas,
  limparAprendizadosAntigos,
  calcularGrid,
  calcularDistancia
};
