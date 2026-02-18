/**
 * Serviço de Limite de Velocidade
 * Consulta limites de velocidade das vias usando OpenStreetMap (Overpass API)
 */

class SpeedLimitService {
  constructor() {
    // Cache de limites de velocidade para evitar consultas repetidas
    this.cache = new Map();
    this.cacheTimeout = 60 * 60 * 1000; // 1 hora (era 5 min) - vias não mudam frequentemente

    // Cache de erros para evitar bombardear API após falha
    this.errorCache = new Map();
    this.errorCacheTimeout = 60 * 1000; // 1 minuto de cooldown após erro

    // Rate limiter global - máximo 1 requisição por segundo à Overpass API
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 segundo entre requisições
    this.globalCooldown = false;
    this.globalCooldownUntil = 0;

    // ✅ OSRM local para fallback (muito mais rápido)
    this.osrmUrl = process.env.OSRM_URL || 'http://osrm-sul-brasil:5000';

    // Limites padrão por tipo de via (Brasil)
    this.defaultLimits = {
      motorway: 110,      // Rodovia
      trunk: 100,         // Via expressa
      primary: 80,        // Via principal
      secondary: 60,      // Via secundária
      tertiary: 60,       // Via terciária
      residential: 40,    // Via residencial
      living_street: 30,  // Rua de convivência
      unclassified: 60,   // Não classificada
      service: 30,        // Via de serviço
      default: 60         // Padrão geral
    };

    // Tipos de via para veículos (em ordem de prioridade)
    this.vehicleRoadTypes = [
      'motorway', 'motorway_link',
      'trunk', 'trunk_link',
      'primary', 'primary_link',
      'secondary', 'secondary_link',
      'tertiary', 'tertiary_link',
      'residential',
      'unclassified',
      'living_street',
      'service'
    ];

    // Tipos de via a ignorar (não são para veículos)
    this.ignoreRoadTypes = [
      'footway', 'pedestrian', 'path', 'cycleway',
      'steps', 'corridor', 'bridleway', 'track'
    ];
  }

  /**
   * Gera uma chave de cache baseada na localização (arredondada)
   */
  getCacheKey(lat, lng) {
    // Arredondar para ~10m de precisão para cache mais preciso
    const latRound = Math.round(lat * 10000) / 10000;
    const lngRound = Math.round(lng * 10000) / 10000;
    return `${latRound},${lngRound}`;
  }

  /**
   * Consulta o limite de velocidade da via mais próxima
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @returns {Promise<object>} - { limite: number, via: string, fonte: string }
   */
  async getSpeedLimit(lat, lng) {
    const cacheKey = this.getCacheKey(lat, lng);
    const now = Date.now();

    // Verificar cache de sucesso
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }

    // Verificar cooldown global (após muitos erros)
    if (this.globalCooldown && now < this.globalCooldownUntil) {
      return {
        limite: this.defaultLimits.default,
        via: 'API em cooldown',
        tipo: 'default',
        fonte: 'global_cooldown'
      };
    }
    this.globalCooldown = false;

    // Rate limiter: mínimo 1 segundo entre requisições
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      // Retornar padrão sem fazer requisição (rate limited)
      return {
        limite: this.defaultLimits.default,
        via: 'Rate limited',
        tipo: 'default',
        fonte: 'rate_limit'
      };
    }

    // Verificar cache de erros (cooldown após falha nesta posição)
    const errorCached = this.errorCache.get(cacheKey);
    if (errorCached && now - errorCached < this.errorCacheTimeout) {
      return {
        limite: this.defaultLimits.default,
        via: 'Em cooldown',
        tipo: 'default',
        fonte: 'cooldown'
      };
    }

    try {
      // Marcar tempo da requisição
      this.lastRequestTime = now;

      // ✅ Tentar OSRM local primeiro (muito mais rápido e confiável)
      const osrmResult = await this.getSpeedLimitFromOSRM(lat, lng);
      if (osrmResult) {
        // Sucesso - armazenar no cache
        this.cache.set(cacheKey, {
          data: osrmResult,
          timestamp: Date.now()
        });
        return osrmResult;
      }

      // Fallback: Consultar Overpass API (OpenStreetMap) - mais lento mas tem maxspeed real
      const result = await this.queryOverpass(lat, lng);

      // Sucesso - limpar cache de erro e armazenar resultado
      this.errorCache.delete(cacheKey);
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      // Limpar cache antigo periodicamente (aumentado para 5000)
      if (this.cache.size > 5000) {
        this.cleanCache();
      }

      return result;
    } catch (error) {
      console.error('[SpeedLimit] Erro ao consultar limite:', error.message);

      // Se erro 429 ou 504, ativar cooldown global de 5 minutos
      if (error.message.includes('429') || error.message.includes('504')) {
        this.globalCooldown = true;
        this.globalCooldownUntil = Date.now() + (5 * 60 * 1000); // 5 minutos
        console.warn('[SpeedLimit] ⚠️ Cooldown global ativado por 5 minutos (erro de rate limit/timeout)');
      }

      // ✅ Tentar OSRM local como fallback final
      try {
        const osrmFallback = await this.getSpeedLimitFromOSRM(lat, lng);
        if (osrmFallback) {
          console.log('[SpeedLimit] ✅ Usando OSRM como fallback após erro Overpass');
          this.cache.set(cacheKey, {
            data: osrmFallback,
            timestamp: Date.now()
          });
          return osrmFallback;
        }
      } catch (osrmError) {
        console.error('[SpeedLimit] OSRM fallback também falhou:', osrmError.message);
      }

      // Adicionar ao cache de erros para evitar bombardear a API
      this.errorCache.set(cacheKey, Date.now());

      // Limpar cache de erros antigos
      if (this.errorCache.size > 1000) {
        const cleanNow = Date.now();
        for (const [key, timestamp] of this.errorCache.entries()) {
          if (cleanNow - timestamp > this.errorCacheTimeout) {
            this.errorCache.delete(key);
          }
        }
      }

      // Retornar limite padrão em caso de erro
      return {
        limite: this.defaultLimits.default,
        via: 'Desconhecida',
        tipo: 'default',
        fonte: 'erro'
      };
    }
  }

  /**
   * Calcula a distância em metros entre dois pontos (fórmula de Haversine)
   */
  calculateDistance(lat1, lon1, lat2, lon2) {
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
   * Calcula a distância mínima de um ponto a um segmento de linha
   */
  pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
      return this.calculateDistance(py, px, y1, x1);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));

    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;

    return this.calculateDistance(py, px, nearestY, nearestX);
  }

  /**
   * Calcula a distância mínima de um ponto a uma via (conjunto de nodes)
   */
  calculateDistanceToWay(lat, lng, nodes, nodeMap) {
    let minDistance = Infinity;

    for (let i = 0; i < nodes.length - 1; i++) {
      const node1 = nodeMap.get(nodes[i]);
      const node2 = nodeMap.get(nodes[i + 1]);

      if (node1 && node2) {
        const dist = this.pointToSegmentDistance(
          lng, lat,
          node1.lon, node1.lat,
          node2.lon, node2.lat
        );
        minDistance = Math.min(minDistance, dist);
      }
    }

    return minDistance;
  }

  /**
   * Consulta a Overpass API do OpenStreetMap
   */
  async queryOverpass(lat, lng, radius = 25) {
    // Query Overpass para buscar vias próximas COM geometria (nodes)
    const query = `
      [out:json][timeout:10];
      way(around:${radius},${lat},${lng})["highway"];
      out body geom;
    `;

    const url = 'https://overpass-api.de/api/interpreter';

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `data=${encodeURIComponent(query)}`
    });

    if (!response.ok) {
      throw new Error(`Overpass API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.elements || data.elements.length === 0) {
      return {
        limite: this.defaultLimits.default,
        via: 'Via não identificada',
        tipo: 'default',
        fonte: 'padrao'
      };
    }

    // Filtrar apenas vias para veículos
    const vehicleWays = data.elements.filter(el => {
      if (el.type !== 'way' || !el.tags || !el.tags.highway) return false;
      // Ignorar vias de pedestres/ciclistas
      return !this.ignoreRoadTypes.includes(el.tags.highway);
    });

    if (vehicleWays.length === 0) {
      // Se não tem via para veículo no raio atual, tentar com raio maior
      if (radius < 100) {
        console.log(`[SpeedLimit] Sem vias para veículos em ${radius}m, tentando ${radius * 2}m`);
        return this.queryOverpass(lat, lng, radius * 2);
      }
      // Se ainda não encontrou, pegar qualquer via
      const anyWay = data.elements.find(el => el.type === 'way' && el.tags);
      if (anyWay) {
        return this.extractWayInfo(anyWay);
      }
      return {
        limite: this.defaultLimits.default,
        via: 'Via não identificada',
        tipo: 'default',
        fonte: 'padrao'
      };
    }

    // Calcular distância de cada via ao ponto e encontrar a mais próxima
    let bestWay = null;
    let bestDistance = Infinity;
    let bestPriority = Infinity;

    for (const way of vehicleWays) {
      // Calcular distância usando a geometria
      let distance = Infinity;

      if (way.geometry && way.geometry.length > 1) {
        // Usar geometria inline
        for (let i = 0; i < way.geometry.length - 1; i++) {
          const node1 = way.geometry[i];
          const node2 = way.geometry[i + 1];
          const dist = this.pointToSegmentDistance(
            lng, lat,
            node1.lon, node1.lat,
            node2.lon, node2.lat
          );
          distance = Math.min(distance, dist);
        }
      }

      // Prioridade baseada no tipo de via (vias maiores têm prioridade)
      const priority = this.vehicleRoadTypes.indexOf(way.tags.highway);
      const effectivePriority = priority === -1 ? 999 : priority;

      // Selecionar a via mais próxima, com desempate por prioridade
      if (distance < bestDistance - 5 || // Mais de 5m mais próxima
          (Math.abs(distance - bestDistance) <= 5 && effectivePriority < bestPriority)) {
        bestWay = way;
        bestDistance = distance;
        bestPriority = effectivePriority;
      }
    }

    if (!bestWay) {
      return {
        limite: this.defaultLimits.default,
        via: 'Via não identificada',
        tipo: 'default',
        fonte: 'padrao'
      };
    }

    return this.extractWayInfo(bestWay);
  }

  /**
   * Extrai informações de uma via
   */
  extractWayInfo(way) {
    const tags = way.tags;
    const highwayType = tags.highway || 'unclassified';
    const roadName = tags.name || tags.ref || `Via ${highwayType}`;

    // Extrair limite de velocidade
    let speedLimit = null;
    let fonte = 'osm';

    if (tags.maxspeed) {
      // Pode vir como "60", "60 km/h", "BR:urban", etc.
      const match = tags.maxspeed.match(/(\d+)/);
      if (match) {
        speedLimit = parseInt(match[1]);
      } else if (tags.maxspeed === 'BR:urban') {
        speedLimit = 60;
      } else if (tags.maxspeed === 'BR:rural') {
        speedLimit = 80;
      } else if (tags.maxspeed === 'BR:motorway') {
        speedLimit = 110;
      }
    }

    // Se não encontrou limite, usar padrão pelo tipo de via
    if (!speedLimit) {
      speedLimit = this.defaultLimits[highwayType] || this.defaultLimits.default;
      fonte = 'tipo_via';
    }

    return {
      limite: speedLimit,
      via: roadName,
      tipo: highwayType,
      fonte: fonte
    };
  }

  /**
   * Verifica se está acima do limite de velocidade
   * @param {number} velocidadeAtual - Velocidade atual em km/h
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @returns {Promise<object>} - { acima: boolean, velocidade: number, limite: number, via: string, excesso: number }
   */
  async checkSpeedViolation(velocidadeAtual, lat, lng) {
    const limitInfo = await this.getSpeedLimit(lat, lng);
    const excesso = velocidadeAtual - limitInfo.limite;

    return {
      acima: excesso > 0,
      velocidade: velocidadeAtual,
      limite: limitInfo.limite,
      via: limitInfo.via,
      tipo: limitInfo.tipo,
      excesso: excesso > 0 ? excesso : 0,
      fonte: limitInfo.fonte
    };
  }

  /**
   * Limpa entradas antigas do cache
   */
  cleanCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheTimeout) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Retorna estatísticas do cache
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      maxSize: 1000,
      timeout: this.cacheTimeout / 1000 + 's'
    };
  }

  /**
   * ✅ Fallback usando OSRM local (muito mais rápido que Overpass)
   * Retorna nome da rua com limite padrão baseado no tipo
   */
  async getSpeedLimitFromOSRM(lat, lng) {
    try {
      const url = `${this.osrmUrl}/nearest/v1/driving/${lng},${lat}`;
      const response = await fetch(url, { timeout: 3000 });

      if (!response.ok) {
        throw new Error(`OSRM error: ${response.status}`);
      }

      const data = await response.json();

      if (data.code === 'Ok' && data.waypoints && data.waypoints.length > 0) {
        const waypoint = data.waypoints[0];
        const roadName = waypoint.name || 'Via não identificada';

        // Detectar tipo de via pelo nome (heurística simples)
        let roadType = 'unclassified';
        let speedLimit = this.defaultLimits.default;

        const nameLower = roadName.toLowerCase();
        if (nameLower.includes('rodovia') || nameLower.includes('br-') || nameLower.includes('sc-')) {
          roadType = 'trunk';
          speedLimit = this.defaultLimits.trunk;
        } else if (nameLower.includes('avenida') || nameLower.includes('av.')) {
          roadType = 'primary';
          speedLimit = this.defaultLimits.primary;
        } else if (nameLower.includes('rua') || nameLower.includes('r.')) {
          roadType = 'residential';
          speedLimit = this.defaultLimits.residential;
        } else if (nameLower.includes('travessa') || nameLower.includes('beco')) {
          roadType = 'living_street';
          speedLimit = this.defaultLimits.living_street;
        }

        return {
          limite: speedLimit,
          via: roadName,
          tipo: roadType,
          fonte: 'osrm'
        };
      }

      return null;
    } catch (error) {
      console.error('[SpeedLimit] Erro ao consultar OSRM:', error.message);
      return null;
    }
  }
}

module.exports = new SpeedLimitService();
