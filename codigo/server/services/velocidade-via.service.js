/**
 * Serviço de Consulta de Limite de Velocidade por Via
 * Usa OpenStreetMap/Overpass API e OSRM para determinar limites de velocidade
 *
 * OTIMIZAÇÃO: Cache persistente no banco de dados
 * - Primeira consulta: busca na API externa e salva no banco
 * - Consultas seguintes: busca instantânea do banco de dados
 */

const fetch = require('node-fetch');
const prisma = require('../db/prisma');

// Cache em memória para acelerar consultas frequentes (sessão atual)
const cacheMemoria = new Map();
const CACHE_MEMORIA_TTL = 3600000; // 1 hora em ms

// Limites padrão por tipo de via (Brasil)
const LIMITES_PADRAO = {
  'motorway': 110,      // Rodovia
  'motorway_link': 80,
  'trunk': 100,         // Via expressa
  'trunk_link': 60,
  'primary': 80,        // Via primária (BR, PR)
  'primary_link': 60,
  'secondary': 60,      // Via secundária (avenidas)
  'secondary_link': 50,
  'tertiary': 50,       // Via terciária
  'tertiary_link': 40,
  'residential': 40,    // Residencial
  'living_street': 20,  // Zona 30
  'service': 30,        // Via de serviço
  'unclassified': 40,   // Não classificada
  'default': 60         // Padrão urbano
};

// Padrões de nomes de vias para estimar limite
const PADROES_VIAS = [
  { regex: /^(BR|PR|SC|RS|SP|MG|RJ|BA|GO|MT|MS)\s*-?\s*\d+/i, limite: 80 },   // Rodovias federais/estaduais
  { regex: /rodovia|highway|autoestrada/i, limite: 80 },
  { regex: /^av\.?|^avenida/i, limite: 60 },                                    // Avenidas
  { regex: /marginal|anel viário|contorno/i, limite: 70 },
  { regex: /^r\.?|^rua/i, limite: 40 },                                         // Ruas
  { regex: /^trav\.?|^travessa/i, limite: 30 },                                 // Travessas
  { regex: /^al\.?|^alameda/i, limite: 40 },
  { regex: /^pça\.?|^praça/i, limite: 30 },
  { regex: /^estr\.?|^estrada/i, limite: 60 }                                   // Estradas
];

/**
 * Gera chave de cache baseada na localização (arredondada para ~100m)
 */
function getCacheKey(lat, lng) {
  // Arredondar para 4 casas decimais (~10m de precisão para maior acurácia)
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/**
 * Gera chaves para o banco de dados (lat e lng separados)
 */
function getDBKeys(lat, lng) {
  return {
    lat_key: lat.toFixed(4),
    lng_key: lng.toFixed(4)
  };
}

/**
 * Busca no cache persistente (banco de dados)
 */
async function buscarCachePersistente(lat, lng) {
  try {
    const { lat_key, lng_key } = getDBKeys(lat, lng);

    const cached = await prisma.cacheLimiteVelocidade.findUnique({
      where: {
        lat_key_lng_key: { lat_key, lng_key }
      }
    });

    if (cached) {
      return {
        limite: cached.limite,
        nome: cached.nome_via || 'Via não identificada',
        tipo: cached.tipo_via || 'cached',
        fonte: cached.fonte || 'cache_db'
      };
    }
  } catch (error) {
    // Se a tabela não existe ainda, apenas retorna null
    if (!error.message?.includes('does not exist')) {
      console.warn('[Velocidade Via] Erro ao buscar cache:', error.message);
    }
  }
  return null;
}

/**
 * Salva no cache persistente (banco de dados)
 */
async function salvarCachePersistente(lat, lng, dados) {
  try {
    const { lat_key, lng_key } = getDBKeys(lat, lng);

    await prisma.cacheLimiteVelocidade.upsert({
      where: {
        lat_key_lng_key: { lat_key, lng_key }
      },
      update: {
        limite: dados.limite,
        nome_via: dados.nome?.substring(0, 255),
        tipo_via: dados.tipo?.substring(0, 50),
        fonte: dados.fonte?.substring(0, 20) || 'osm',
        updated_at: new Date()
      },
      create: {
        lat_key,
        lng_key,
        limite: dados.limite,
        nome_via: dados.nome?.substring(0, 255),
        tipo_via: dados.tipo?.substring(0, 50),
        fonte: dados.fonte?.substring(0, 20) || 'osm'
      }
    });
  } catch (error) {
    // Se a tabela não existe ainda, apenas loga
    if (!error.message?.includes('does not exist')) {
      console.warn('[Velocidade Via] Erro ao salvar cache:', error.message);
    }
  }
}

/**
 * Consulta o OSRM para obter informações da via
 */
async function consultarOSRM(lat, lng) {
  try {
    const osrmHost = process.env.OSRM_HOST || 'osrm-sul-brasil';
    const url = `http://${osrmHost}:5000/nearest/v1/driving/${lng},${lat}?number=1`;
    const response = await fetch(url, { timeout: 5000 });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.code === 'Ok' && data.waypoints && data.waypoints[0]) {
      return {
        nome: data.waypoints[0].name || '',
        distancia: data.waypoints[0].distance
      };
    }
  } catch (error) {
    // Silencioso para não poluir logs
  }
  return null;
}

/**
 * Consulta a Overpass API para obter o limite de velocidade real
 */
async function consultarOverpass(lat, lng) {
  try {
    // Buscar vias num raio de 50m
    const query = `
      [out:json][timeout:10];
      way(around:50,${lat},${lng})["highway"]["maxspeed"];
      out body;
    `;

    const url = 'https://overpass-api.de/api/interpreter';
    const response = await fetch(url, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    if (!response.ok) return null;

    const data = await response.json();
    if (data.elements && data.elements.length > 0) {
      // Pegar a primeira via com maxspeed
      for (const element of data.elements) {
        if (element.tags && element.tags.maxspeed) {
          const maxspeed = element.tags.maxspeed;
          // Converter para número (pode vir como "60" ou "60 km/h")
          const limite = parseInt(maxspeed.replace(/[^\d]/g, ''));
          if (!isNaN(limite) && limite > 0 && limite < 200) {
            return {
              limite,
              nome: element.tags.name || '',
              tipo: element.tags.highway || 'unknown',
              fonte: 'openstreetmap'
            };
          }
        }
      }
    }
  } catch (error) {
    // Silencioso para não poluir logs
  }
  return null;
}

/**
 * Estima o limite de velocidade baseado no nome da via
 */
function estimarPorNome(nomeVia) {
  if (!nomeVia) return null;

  for (const padrao of PADROES_VIAS) {
    if (padrao.regex.test(nomeVia)) {
      return {
        limite: padrao.limite,
        nome: nomeVia,
        tipo: 'estimado_nome',
        fonte: 'padrao_nome'
      };
    }
  }
  return null;
}

/**
 * Obtém o limite de velocidade para uma localização GPS
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @param {boolean} usarCache - Usar cache (default: true)
 * @returns {Promise<{limite: number, nome: string, tipo: string, fonte: string}>}
 */
async function obterLimiteVelocidade(lat, lng, usarCache = true) {
  const cacheKey = getCacheKey(lat, lng);

  // 1. Verificar cache em memória (mais rápido)
  if (usarCache && cacheMemoria.has(cacheKey)) {
    const cached = cacheMemoria.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_MEMORIA_TTL) {
      return cached.data;
    }
    cacheMemoria.delete(cacheKey);
  }

  // 2. Verificar cache persistente (banco de dados)
  if (usarCache) {
    const cachePersistente = await buscarCachePersistente(lat, lng);
    if (cachePersistente) {
      // Salvar em memória para próximas consultas
      cacheMemoria.set(cacheKey, {
        timestamp: Date.now(),
        data: cachePersistente
      });
      return cachePersistente;
    }
  }

  let resultado = null;

  // 3. Tentar consultar OSRM primeiro (mais rápido)
  const infoOSRM = await consultarOSRM(lat, lng);

  if (infoOSRM && infoOSRM.nome) {
    // Tentar estimar pelo nome da via
    resultado = estimarPorNome(infoOSRM.nome);
    if (resultado) {
      resultado.nome = infoOSRM.nome;
    }
  }

  // 4. Se não conseguiu pelo nome, tentar Overpass API (mais preciso mas mais lento)
  if (!resultado) {
    resultado = await consultarOverpass(lat, lng);
  }

  // 5. Fallback: usar limite padrão urbano
  if (!resultado) {
    resultado = {
      limite: LIMITES_PADRAO.default,
      nome: infoOSRM?.nome || 'Via não identificada',
      tipo: 'default',
      fonte: 'padrao'
    };
  }

  // 6. Salvar nos caches
  if (usarCache) {
    // Cache em memória
    cacheMemoria.set(cacheKey, {
      timestamp: Date.now(),
      data: resultado
    });

    // Cache persistente (banco de dados) - async, não bloqueia
    salvarCachePersistente(lat, lng, resultado).catch(() => {});
  }

  return resultado;
}

/**
 * Obtém limites de velocidade para múltiplas localizações (otimizado para exportação)
 * Agrupa pontos próximos para reduzir consultas
 * @param {Array<{lat: number, lng: number}>} pontos - Array de coordenadas
 * @returns {Promise<Map<string, {limite: number, nome: string}>>} - Map de cacheKey para limite
 */
async function obterLimitesEmLote(pontos) {
  const resultados = new Map();
  const pontosUnicos = new Map();

  // Agrupar pontos por região (~10m)
  for (const ponto of pontos) {
    const key = getCacheKey(ponto.lat, ponto.lng);
    if (!pontosUnicos.has(key)) {
      pontosUnicos.set(key, { lat: ponto.lat, lng: ponto.lng });
    }
  }

  const totalRegioes = pontosUnicos.size;
  console.log(`[Velocidade Via] Processando ${totalRegioes} regiões únicas de ${pontos.length} pontos`);

  // Buscar todos os caches persistentes de uma vez (otimização)
  const regioes = Array.from(pontosUnicos.entries());
  let cacheHits = 0;
  let apiCalls = 0;

  // Primeiro, buscar todos do cache do banco
  const dbKeys = regioes.map(([_, coords]) => getDBKeys(coords.lat, coords.lng));

  try {
    const cachedRecords = await prisma.cacheLimiteVelocidade.findMany({
      where: {
        OR: dbKeys.map(k => ({ lat_key: k.lat_key, lng_key: k.lng_key }))
      }
    });

    // Mapear resultados do cache
    for (const record of cachedRecords) {
      const cacheKey = `${record.lat_key},${record.lng_key}`;
      resultados.set(cacheKey, {
        limite: record.limite,
        nome: record.nome_via || 'Via não identificada',
        tipo: record.tipo_via || 'cached',
        fonte: 'cache_db'
      });
      cacheHits++;
    }
  } catch (error) {
    // Se tabela não existe, continua sem cache
  }

  // Identificar regiões que precisam ser consultadas
  const regioesParaConsultar = regioes.filter(([key]) => !resultados.has(key));

  if (regioesParaConsultar.length > 0) {
    console.log(`[Velocidade Via] ${cacheHits} do cache, ${regioesParaConsultar.length} para consultar`);

    // Processar em lotes de 10 para não sobrecarregar
    const BATCH_SIZE = 10;

    for (let i = 0; i < regioesParaConsultar.length; i += BATCH_SIZE) {
      const batch = regioesParaConsultar.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async ([key, coords]) => {
        try {
          const limite = await obterLimiteVelocidade(coords.lat, coords.lng, true);
          resultados.set(key, limite);
          apiCalls++;
        } catch (error) {
          // Em caso de erro, usar padrão
          resultados.set(key, {
            limite: LIMITES_PADRAO.default,
            nome: 'Erro ao consultar',
            tipo: 'error',
            fonte: 'fallback'
          });
        }
      }));

      // Pequena pausa entre lotes para não sobrecarregar APIs
      if (i + BATCH_SIZE < regioesParaConsultar.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  console.log(`[Velocidade Via] Concluído: ${cacheHits} cache hits, ${apiCalls} API calls`);

  return resultados;
}

/**
 * Limpa o cache em memória
 */
function limparCache() {
  cacheMemoria.clear();
  console.log('[Velocidade Via] Cache em memória limpo');
}

/**
 * Limpa todo o cache (memória + banco)
 */
async function limparCacheCompleto() {
  cacheMemoria.clear();
  try {
    await prisma.cacheLimiteVelocidade.deleteMany({});
    console.log('[Velocidade Via] Cache completo limpo (memória + banco)');
  } catch (error) {
    console.log('[Velocidade Via] Cache em memória limpo (banco indisponível)');
  }
}

/**
 * Retorna estatísticas do cache
 */
async function estatisticasCache() {
  let totalBanco = 0;
  try {
    totalBanco = await prisma.cacheLimiteVelocidade.count();
  } catch (error) {
    // Tabela não existe
  }

  return {
    memoria: {
      entradas: cacheMemoria.size,
      ttl_ms: CACHE_MEMORIA_TTL
    },
    banco: {
      entradas: totalBanco
    }
  };
}

module.exports = {
  obterLimiteVelocidade,
  obterLimitesEmLote,
  limparCache,
  limparCacheCompleto,
  estatisticasCache,
  LIMITES_PADRAO,
  getCacheKey
};
