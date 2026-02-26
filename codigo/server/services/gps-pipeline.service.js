/**
 * GPS Correction Pipeline Service
 *
 * Pipeline completo de correção de GPS em 3 camadas:
 *
 * 1. FILTRO DE KALMAN (Camada 1)
 *    - Filtro de Kalman 2D estendido com velocidade e heading
 *    - Suaviza ruído antes de qualquer processamento
 *    - Entrada: lat, lon, velocidade, heading
 *    - Saída: posição suavizada (menos saltos)
 *
 * 2. IA DE CORREÇÃO (Camada 2)
 *    - Modelo adaptativo que aprende padrões de erro
 *    - Corrige baseado em histórico + velocidade + heading
 *    - Dead reckoning quando GPS falhar
 *    - Entrada: [lat, lon, vel, heading, hdop, últimas N posições]
 *    - Saída: [lat_corrigida, lon_corrigida]
 *
 * 3. MAP-MATCHING (Camada 3)
 *    - OSRM ou Valhalla para colar pontos nas vias
 *    - Feedback para treinar a IA
 *    - Entrada: coordenada corrigida
 *    - Saída: ponto final ajustado para a rua correta
 *
 * Pipeline: GPS Bruto → Kalman → IA → Map-Matching → Posição Final
 */

const gpsAI = require('./gps-ai-correction.service');

// ==================== CONFIGURAÇÕES DO PIPELINE ====================

const PIPELINE_CONFIG = {
  // Ativar/desativar camadas
  kalman: {
    enabled: true,
    // AJUSTADO: Kalman menos agressivo para não puxar pontos para fora da rua
    processNoise: 0.001,         // Q - aumentado para seguir mais a medição
    measurementNoise: 5,         // R - reduzido para confiar mais no GPS
    velocityWeight: 0.2,         // Peso da velocidade no modelo (reduzido)
  },

  ai: {
    enabled: true,
    minConfidence: 0.5,          // AUMENTADO: Confiança mínima para aplicar correção
    maxCorrectionMeters: 15,     // REDUZIDO: Limite de correção da IA
  },

  mapMatching: {
    enabled: true,
    provider: 'osrm',            // 'osrm' ou 'valhalla'
    osrmUrl: process.env.OSRM_URL || 'http://osrm-sul-brasil:5000/match/v1/driving',  // OSRM Docker
    valhallaUrl: 'http://localhost:8002/trace_attributes',
    batchSize: 5,                // Mais pontos = mais contexto para decisão correta
    autoFlushMs: 10000,          // Flush automatico a cada 10s se houver pontos pendentes
    radiusMeters: 15,            // REDUZIDO: Raio menor para evitar snap em rua errada
    maxCorrectionMeters: 20,     // NOVO: Limite máximo de correção (ignora se > 20m)
    validateDirection: true,     // NOVO: Validar se correção é consistente com direção
    trainFromMatching: true,     // Usar matching para treinar IA
  },

  // Cache e performance
  cache: {
    enabled: true,
    ttlSeconds: 300,             // TTL do cache
    maxSize: 10000,              // Máximo de entradas
  },

  // Logging
  logging: {
    verbose: false,              // Log detalhado de cada ponto
    stats: true,                 // Log de estatísticas
    statsIntervalMs: 60000,      // Intervalo de log de stats
  }
};

// ==================== FILTRO DE KALMAN ESTENDIDO ====================

/**
 * Filtro de Kalman 2D Estendido com Velocidade e Heading
 * Modelo de estado: [lat, lon, vel_lat, vel_lon]
 */
class ExtendedKalmanFilter {
  constructor(config = {}) {
    this.config = { ...PIPELINE_CONFIG.kalman, ...config };

    // Estado: [lat, lon, vel_lat, vel_lon]
    this.state = null;

    // Covariância
    this.P = null;

    // Ruído do processo (Q)
    this.Q = null;

    // Ruído da medição (R)
    this.R = null;

    this.initialized = false;
  }

  /**
   * Inicializa o filtro com primeira medição
   */
  initialize(lat, lon, velocidade = 0, heading = 0) {
    // Converter velocidade km/h e heading em componentes lat/lon
    const { velLat, velLon } = this.velocityComponents(velocidade, heading);

    this.state = [lat, lon, velLat, velLon];

    // Covariância inicial alta (incerteza inicial)
    this.P = [
      [100, 0, 0, 0],
      [0, 100, 0, 0],
      [0, 0, 100, 0],
      [0, 0, 0, 100]
    ];

    // Ruído do processo
    const q = this.config.processNoise;
    this.Q = [
      [q, 0, 0, 0],
      [0, q, 0, 0],
      [0, 0, q * 10, 0],
      [0, 0, 0, q * 10]
    ];

    // Ruído da medição
    const r = this.config.measurementNoise;
    this.R = [
      [r, 0],
      [0, r]
    ];

    this.initialized = true;
  }

  /**
   * Converte velocidade e heading em componentes lat/lon
   */
  velocityComponents(velocidadeKmh, headingGraus) {
    const velocidadeMs = velocidadeKmh / 3.6;
    const headingRad = headingGraus * Math.PI / 180;

    // Conversão aproximada para graus/segundo
    const metersPerDegree = 111320; // aproximado

    return {
      velLat: (velocidadeMs * Math.cos(headingRad)) / metersPerDegree,
      velLon: (velocidadeMs * Math.sin(headingRad)) / metersPerDegree
    };
  }

  /**
   * Etapa de predição
   */
  predict(dt) {
    if (!this.initialized) return;

    // Matriz de transição de estado
    const F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];

    // Predizer estado: x = F * x
    const newState = [
      this.state[0] + this.state[2] * dt,
      this.state[1] + this.state[3] * dt,
      this.state[2],
      this.state[3]
    ];
    this.state = newState;

    // Predizer covariância: P = F * P * F' + Q
    this.P = this.matAdd(
      this.matMult(this.matMult(F, this.P), this.transpose(F)),
      this.Q
    );
  }

  /**
   * Etapa de atualização com nova medição
   */
  update(lat, lon, velocidade = null, heading = null) {
    if (!this.initialized) {
      this.initialize(lat, lon, velocidade || 0, heading || 0);
      return { lat, lon, filtered: false };
    }

    // Medição
    const z = [lat, lon];

    // Matriz de observação
    const H = [
      [1, 0, 0, 0],
      [0, 1, 0, 0]
    ];

    // Inovação: y = z - H * x
    const Hx = [this.state[0], this.state[1]];
    const y = [z[0] - Hx[0], z[1] - Hx[1]];

    // Covariância da inovação: S = H * P * H' + R
    const HP = this.matMult(H, this.P);
    const HPHt = this.matMult(HP, this.transpose(H));
    const S = this.matAdd(HPHt, this.R);

    // Ganho de Kalman: K = P * H' * S^(-1)
    const PHt = this.matMult(this.P, this.transpose(H));
    const Sinv = this.inverse2x2(S);
    const K = this.matMult(PHt, Sinv);

    // Atualizar estado: x = x + K * y
    const Ky = [
      K[0][0] * y[0] + K[0][1] * y[1],
      K[1][0] * y[0] + K[1][1] * y[1],
      K[2][0] * y[0] + K[2][1] * y[1],
      K[3][0] * y[0] + K[3][1] * y[1]
    ];

    this.state = [
      this.state[0] + Ky[0],
      this.state[1] + Ky[1],
      this.state[2] + Ky[2],
      this.state[3] + Ky[3]
    ];

    // Incorporar velocidade/heading se disponíveis
    if (velocidade !== null && heading !== null) {
      const { velLat, velLon } = this.velocityComponents(velocidade, heading);
      // Média ponderada com velocidade medida
      const w = this.config.velocityWeight;
      this.state[2] = this.state[2] * (1 - w) + velLat * w;
      this.state[3] = this.state[3] * (1 - w) + velLon * w;
    }

    // Atualizar covariância: P = (I - K * H) * P
    const KH = this.matMult(K, H);
    const I = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
    const IKH = this.matSub(I, KH);
    this.P = this.matMult(IKH, this.P);

    return {
      lat: this.state[0],
      lon: this.state[1],
      lat_original: lat,
      lon_original: lon,
      vel_lat: this.state[2],
      vel_lon: this.state[3],
      filtered: true
    };
  }

  /**
   * Filtra um ponto (predict + update)
   */
  filter(lat, lon, velocidade, heading, dt = 1.0) {
    this.predict(dt);
    return this.update(lat, lon, velocidade, heading);
  }

  // ===== Funções de álgebra linear =====
  matMult(A, B) {
    const result = [];
    for (let i = 0; i < A.length; i++) {
      result[i] = [];
      for (let j = 0; j < B[0].length; j++) {
        result[i][j] = 0;
        for (let k = 0; k < B.length; k++) {
          result[i][j] += A[i][k] * B[k][j];
        }
      }
    }
    return result;
  }

  transpose(M) {
    return M[0].map((_, i) => M.map(row => row[i]));
  }

  matAdd(A, B) {
    return A.map((row, i) => row.map((val, j) => val + B[i][j]));
  }

  matSub(A, B) {
    return A.map((row, i) => row.map((val, j) => val - B[i][j]));
  }

  inverse2x2(M) {
    const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    if (Math.abs(det) < 1e-10) return [[1,0],[0,1]];
    return [
      [M[1][1] / det, -M[0][1] / det],
      [-M[1][0] / det, M[0][0] / det]
    ];
  }
}

// ==================== MAP-MATCHING ====================

/**
 * Map-Matching com OSRM
 */
class MapMatcher {
  constructor(config = {}) {
    this.config = { ...PIPELINE_CONFIG.mapMatching, ...config };
    this.pendingPoints = new Map(); // IMEI -> pontos pendentes para batch
    this.cache = new Map();
    this.lastMatchedPoints = new Map(); // IMEI -> últimos pontos matched (para retorno)

    // Auto-flush: processar batches pendentes periodicamente
    if (this.config.autoFlushMs > 0) {
      setInterval(() => this.autoFlush(), this.config.autoFlushMs);
      console.log(`[MapMatch] Auto-flush ativado: a cada ${this.config.autoFlushMs}ms`);
    }
  }

  /**
   * Auto-flush: processa todos os batches pendentes
   */
  async autoFlush() {
    const imeis = Array.from(this.pendingPoints.keys());
    let processados = 0;

    for (const imei of imeis) {
      const pending = this.pendingPoints.get(imei);
      if (pending && pending.length >= 2) {
        try {
          const matched = await this.processBatch(imei);
          if (matched.length > 0 && matched[0].matched) {
            // Guardar último ponto matched para uso futuro
            this.lastMatchedPoints.set(imei, matched[matched.length - 1]);
            processados += matched.length;
          }
        } catch (e) {
          console.warn(`[MapMatch] Auto-flush erro ${imei}: ${e.message}`);
        }
      }
      // ✅ Pontos órfãos (apenas 1) são limpos pelo cleanupInactiveDevices()
      // após 30 minutos de inatividade - não é agressivo demais
    }

    if (processados > 0) {
      console.log(`[MapMatch] Auto-flush: ${processados} pontos processados de ${imeis.length} dispositivos`);
    }
  }

  /**
   * Faz map-matching de um único ponto
   * Adiciona ao batch para processamento eficiente
   */
  async matchSingle(position, imei) {
    // Adicionar ao batch pendente
    if (!this.pendingPoints.has(imei)) {
      this.pendingPoints.set(imei, []);
    }

    const pending = this.pendingPoints.get(imei);
    pending.push(position);

    // Se batch cheio, processar e retornar último ponto
    if (pending.length >= this.config.batchSize) {
      const matched = await this.processBatch(imei);
      // Retornar o último ponto matched (correspondente ao ponto atual)
      if (matched && matched.length > 0) {
        const ultimo = matched[matched.length - 1];
        this.lastMatchedPoints.set(imei, ultimo);
        return ultimo;
      }
    }

    // Retornar posição com flag de pending
    return {
      ...position,
      matched: false,
      pending_batch: true
    };
  }

  /**
   * Processa batch de pontos via OSRM
   */
  async processBatch(imei) {
    const pontos = this.pendingPoints.get(imei) || [];
    if (pontos.length < 2) {
      return pontos.map(p => ({ ...p, matched: false }));
    }

    // Limpar batch
    this.pendingPoints.set(imei, []);

    try {
      if (this.config.provider === 'osrm') {
        return await this.matchWithOSRM(pontos);
      } else {
        return await this.matchWithValhalla(pontos);
      }
    } catch (error) {
      console.error(`[MapMatch] Erro: ${error.message}`);
      return pontos.map(p => ({ ...p, matched: false, error: error.message }));
    }
  }

  /**
   * Map-matching via OSRM
   */
  async matchWithOSRM(pontos) {
    const fetch = (await import('node-fetch')).default;

    // Montar URL
    const coords = pontos.map(p => `${p.lon},${p.lat}`).join(';');
    const timestamps = pontos.map(p =>
      Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000)
    ).join(';');
    const radiuses = pontos.map(() => this.config.radiusMeters).join(';');

    const url = `${this.config.osrmUrl}/${coords}?` +
      `timestamps=${timestamps}&` +
      `radiuses=${radiuses}&` +
      `geometries=geojson&` +
      `overview=full&` +
      `annotations=true&` +
      `gaps=ignore`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`OSRM HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
      throw new Error(`OSRM: ${data.code || 'no matchings'}`);
    }

    // Extrair pontos matched
    const resultado = [];
    for (const matching of data.matchings) {
      if (matching.geometry && matching.geometry.coordinates) {
        const coords = matching.geometry.coordinates;

        for (let i = 0; i < coords.length; i++) {
          const [lon, lat] = coords[i];

          // Mapear para ponto original
          const progress = i / Math.max(1, coords.length - 1);
          const origIdx = Math.floor(progress * (pontos.length - 1));
          const orig = pontos[Math.min(origIdx, pontos.length - 1)];

          resultado.push({
            lat,
            lon,
            lat_original: orig.lat,
            lon_original: orig.lon,
            velocidade: orig.velocidade,
            direcao: orig.direcao,
            timestamp: orig.timestamp,
            matched: true,
            provider: 'osrm'
          });
        }
      }
    }

    if (resultado.length > 0) {
      console.log(`[MapMatch] OSRM OK: ${pontos.length} pontos → ${resultado.length} matched`);
      return resultado;
    }
    return pontos.map(p => ({ ...p, matched: false }));
  }

  /**
   * Map-matching via Valhalla (alternativa)
   */
  async matchWithValhalla(pontos) {
    const fetch = (await import('node-fetch')).default;

    const shape = pontos.map(p => ({
      lat: p.lat,
      lon: p.lon,
      time: Math.floor(new Date(p.timestamp || Date.now()).getTime() / 1000)
    }));

    const body = {
      shape,
      costing: 'auto',
      shape_match: 'map_snap',
      filters: {
        attributes: ['edge.names', 'matched.point', 'matched.type']
      }
    };

    const response = await fetch(this.config.valhallaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 15000
    });

    if (!response.ok) {
      throw new Error(`Valhalla HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.matched_points) {
      throw new Error('Valhalla: no matched points');
    }

    return data.matched_points.map((mp, i) => ({
      lat: mp.lat,
      lon: mp.lon,
      lat_original: pontos[Math.min(i, pontos.length - 1)].lat,
      lon_original: pontos[Math.min(i, pontos.length - 1)].lon,
      velocidade: pontos[Math.min(i, pontos.length - 1)].velocidade,
      direcao: pontos[Math.min(i, pontos.length - 1)].direcao,
      timestamp: pontos[Math.min(i, pontos.length - 1)].timestamp,
      matched: mp.type !== 'unmatched',
      provider: 'valhalla'
    }));
  }

  /**
   * Força processamento de batch pendente
   */
  async flushBatch(imei) {
    if (this.pendingPoints.has(imei) && this.pendingPoints.get(imei).length > 0) {
      return this.processBatch(imei);
    }
    return [];
  }
}

// ==================== PIPELINE PRINCIPAL ====================

/**
 * GPS Correction Pipeline
 * Orquestra as 3 camadas de correção
 */
class GPSCorrectionPipeline {
  constructor(config = {}) {
    this.config = { ...PIPELINE_CONFIG, ...config };

    // Filtros de Kalman por dispositivo
    this.kalmanFilters = new Map();

    // ✅ NOVO: Rastrear última atividade de cada IMEI para limpeza
    this.lastActivity = new Map(); // imei -> timestamp

    // Map-Matcher compartilhado
    this.mapMatcher = new MapMatcher(this.config.mapMatching);

    // Estatísticas
    this.stats = {
      processed: 0,
      kalmanApplied: 0,
      aiCorrected: 0,
      mapMatched: 0,
      errors: 0,
      totalCorrectionMeters: 0,
      avgProcessingTimeMs: 0,
      // ✅ NOVO: Métricas de memória
      kalmanFiltersSize: 0,
      pendingPointsSize: 0,
      lastCleanup: Date.now()
    };

    // Log de estatísticas periódico
    if (this.config.logging.stats) {
      setInterval(() => this.logStats(), this.config.logging.statsIntervalMs);
    }

    // ✅ NOVO: Limpeza periódica de dispositivos inativos (a cada 5 minutos)
    setInterval(() => this.cleanupInactiveDevices(), 5 * 60 * 1000);

    console.log('[GPS Pipeline] Inicializado com configuração:', {
      kalman: this.config.kalman.enabled,
      ai: this.config.ai.enabled,
      mapMatching: this.config.mapMatching.enabled
    });
  }

  /**
   * ✅ NOVO: Limpa dispositivos inativos dos Maps
   * Remove filtros Kalman e pontos pendentes de dispositivos sem atividade há 30+ minutos
   */
  cleanupInactiveDevices() {
    const now = Date.now();
    const maxInactiveMs = 30 * 60 * 1000; // 30 minutos
    let kalmanCleaned = 0;
    let pendingCleaned = 0;

    // Limpar Kalman filters inativos
    for (const [imei, lastTime] of this.lastActivity.entries()) {
      if (now - lastTime > maxInactiveMs) {
        if (this.kalmanFilters.has(imei)) {
          this.kalmanFilters.delete(imei);
          kalmanCleaned++;
        }
        this.lastActivity.delete(imei);
      }
    }

    // Limpar pontos pendentes do MapMatcher
    if (this.mapMatcher && this.mapMatcher.pendingPoints) {
      for (const [imei, points] of this.mapMatcher.pendingPoints.entries()) {
        const lastActivityTime = this.lastActivity.get(imei);
        if (!lastActivityTime || now - lastActivityTime > maxInactiveMs) {
          this.mapMatcher.pendingPoints.delete(imei);
          this.mapMatcher.lastMatchedPoints.delete(imei);
          pendingCleaned++;
        }
      }
    }

    // Atualizar métricas
    this.stats.kalmanFiltersSize = this.kalmanFilters.size;
    this.stats.pendingPointsSize = this.mapMatcher?.pendingPoints?.size || 0;
    this.stats.lastCleanup = now;

    if (kalmanCleaned > 0 || pendingCleaned > 0) {
      console.log(`[GPS Pipeline] 🧹 Cleanup: ${kalmanCleaned} Kalman, ${pendingCleaned} pendingPoints removidos`);
      console.log(`[GPS Pipeline] 📊 Estado atual: ${this.kalmanFilters.size} Kalman, ${this.mapMatcher?.pendingPoints?.size || 0} pendingPoints`);
    }
  }

  /**
   * Processa uma posição GPS através do pipeline completo
   *
   * @param {Object} position - Posição GPS bruta
   * @param {string} imei - IMEI do dispositivo
   * @returns {Object} Posição corrigida
   */
  async processar(position, imei) {
    const inicio = Date.now();
    this.stats.processed++;

    // ✅ NOVO: Registrar última atividade do IMEI
    this.lastActivity.set(imei, inicio);

    let resultado = {
      lat: position.latitude,
      lon: position.longitude,
      lat_original: position.latitude,
      lon_original: position.longitude,
      velocidade: position.velocidade || 0,
      direcao: position.direcao || 0,
      timestamp: position.timestamp || new Date(),
      pipeline: []
    };

    try {
      // ========== CAMADA 1: FILTRO DE KALMAN ==========
      if (this.config.kalman.enabled) {
        resultado = await this.aplicarKalman(resultado, imei);
      }

      // ========== CAMADA 2: IA DE CORREÇÃO ==========
      if (this.config.ai.enabled) {
        resultado = await this.aplicarIA(resultado, imei);
      }

      // ========== CAMADA 3: MAP-MATCHING ==========
      if (this.config.mapMatching.enabled) {
        resultado = await this.aplicarMapMatching(resultado, imei);
      }

    } catch (error) {
      console.error(`[GPS Pipeline] Erro para ${imei}: ${error.message}`);
      this.stats.errors++;
      resultado.erro = error.message;
    }

    // Calcular correção total
    resultado.correcao_total_metros = this.distanciaMetros(
      position.latitude, position.longitude,
      resultado.lat, resultado.lon
    );
    this.stats.totalCorrectionMeters += resultado.correcao_total_metros;

    // Tempo de processamento
    resultado.tempo_processamento_ms = Date.now() - inicio;
    this.stats.avgProcessingTimeMs =
      (this.stats.avgProcessingTimeMs * (this.stats.processed - 1) + resultado.tempo_processamento_ms) /
      this.stats.processed;

    if (this.config.logging.verbose) {
      console.log(`[GPS Pipeline] ${imei}: correção=${resultado.correcao_total_metros.toFixed(1)}m, camadas=${resultado.pipeline.join('→')}`);
    }

    return resultado;
  }

  /**
   * CAMADA 1: Aplica Filtro de Kalman
   */
  async aplicarKalman(position, imei) {
    // Obter ou criar filtro para este dispositivo
    if (!this.kalmanFilters.has(imei)) {
      this.kalmanFilters.set(imei, {
        filter: new ExtendedKalmanFilter(this.config.kalman),
        lastTimestamp: null
      });
    }

    const kf = this.kalmanFilters.get(imei);

    // Calcular dt
    let dt = 1.0;
    if (kf.lastTimestamp && position.timestamp) {
      dt = (new Date(position.timestamp) - new Date(kf.lastTimestamp)) / 1000;
      dt = Math.max(0.1, Math.min(dt, 60)); // Limitar entre 0.1s e 60s
    }
    kf.lastTimestamp = position.timestamp;

    // Aplicar filtro
    const filtrado = kf.filter.filter(
      position.lat,
      position.lon,
      position.velocidade,
      position.direcao,
      dt
    );

    this.stats.kalmanApplied++;

    return {
      ...position,
      lat: filtrado.lat,
      lon: filtrado.lon,
      lat_pre_kalman: position.lat,
      lon_pre_kalman: position.lon,
      kalman_applied: true,
      pipeline: [...(position.pipeline || []), 'kalman']
    };
  }

  /**
   * CAMADA 2: Aplica IA de Correção
   * MELHORADO: Valida se a correção mantém o ponto na rua
   */
  async aplicarIA(position, imei) {
    // Chamar serviço de IA
    const correcao = await gpsAI.corrigir({
      latitude: position.lat,
      longitude: position.lon,
      velocidade: position.velocidade,
      direcao: position.direcao,
      hdop: position.hdop,
      timestamp: position.timestamp
    }, imei);

    // Verificar confiança mínima
    if (correcao.confianca < this.config.ai.minConfidence) {
      return {
        ...position,
        ai_skipped: true,
        ai_confidence: correcao.confianca,
        ai_reason: 'confianca_baixa',
        pipeline: [...position.pipeline, 'ai_skip']
      };
    }

    // Verificar limite de correção
    const correcaoMetros = this.distanciaMetros(
      position.lat, position.lon,
      correcao.lat, correcao.lon
    );

    if (correcaoMetros > this.config.ai.maxCorrectionMeters) {
      return {
        ...position,
        ai_limited: true,
        ai_correction_requested: correcaoMetros,
        ai_reason: 'correcao_muito_grande',
        pipeline: [...position.pipeline, 'ai_limit']
      };
    }

    // NOVO: Se a correção é muito pequena (< 1m), não vale a pena aplicar
    if (correcaoMetros < 1) {
      return {
        ...position,
        ai_skipped: true,
        ai_reason: 'correcao_insignificante',
        ai_correction_metros: correcaoMetros,
        pipeline: [...position.pipeline, 'ai_micro']
      };
    }

    // NOVO: Validar se a correção mantém o ponto em uma direção consistente
    // Se temos velocidade > 5km/h e heading, a correção deve ser na direção do movimento
    if (position.velocidade > 5 && position.direcao !== undefined) {
      const direcaoCorrecao = this.calcularDirecao(
        position.lat, position.lon,
        correcao.lat, correcao.lon
      );

      const diferencaAngulo = Math.abs(this.normalizarAngulo(direcaoCorrecao - position.direcao));

      // Se a correção é perpendicular ou contrária ao movimento, rejeitar
      if (diferencaAngulo > 90 && correcaoMetros > 5) {
        console.log(`[GPS Pipeline] Rejeitando correção perpendicular ao movimento: diff=${diferencaAngulo.toFixed(0)}° corr=${correcaoMetros.toFixed(1)}m`);
        return {
          ...position,
          ai_skipped: true,
          ai_reason: 'direcao_inconsistente',
          ai_direcao_diff: diferencaAngulo,
          pipeline: [...position.pipeline, 'ai_direcao_reject']
        };
      }
    }

    this.stats.aiCorrected++;

    return {
      ...position,
      lat: correcao.lat,
      lon: correcao.lon,
      lat_pre_ai: position.lat,
      lon_pre_ai: position.lon,
      ai_confidence: correcao.confianca,
      ai_method: correcao.metodo,
      ai_correction_metros: correcaoMetros,
      pipeline: [...position.pipeline, 'ai']
    };
  }

  /**
   * Calcula direção (bearing) entre dois pontos em graus
   */
  calcularDirecao(lat1, lon1, lat2, lon2) {
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
   * Normaliza ângulo para -180 a 180
   */
  normalizarAngulo(angulo) {
    while (angulo > 180) angulo -= 360;
    while (angulo < -180) angulo += 360;
    return angulo;
  }

  /**
   * CAMADA 3: Aplica Map-Matching com validações de proteção
   */
  async aplicarMapMatching(position, imei) {
    const matched = await this.mapMatcher.matchSingle({
      lat: position.lat,
      lon: position.lon,
      velocidade: position.velocidade,
      direcao: position.direcao,
      timestamp: position.timestamp
    }, imei);

    // Se matched, validar antes de aplicar
    if (matched.matched) {
      // Calcular distância da correção
      const correcaoMetros = this.distanciaMetros(
        position.lat, position.lon,
        matched.lat, matched.lon
      );

      // PROTEÇÃO 1: Limite máximo de correção
      const maxCorrecao = this.config.mapMatching.maxCorrectionMeters || 20;
      if (correcaoMetros > maxCorrecao) {
        console.log(`[MapMatch] Correção ignorada: ${correcaoMetros.toFixed(1)}m > ${maxCorrecao}m limite`);
        return {
          ...position,
          map_matched: false,
          map_rejected: 'correcao_muito_grande',
          map_correction_metros: correcaoMetros,
          pipeline: [...position.pipeline, 'map_reject_dist']
        };
      }

      // PROTEÇÃO 2: Validar direção (se veículo em movimento)
      if (this.config.mapMatching.validateDirection && position.velocidade > 5 && position.direcao !== undefined) {
        const direcaoCorrecao = this.calcularDirecao(
          position.lat, position.lon,
          matched.lat, matched.lon
        );

        const diferencaAngulo = Math.abs(this.normalizarAngulo(direcaoCorrecao - position.direcao));

        // Se correção é perpendicular/contrária ao movimento E significativa (> 10m), rejeitar
        if (diferencaAngulo > 90 && correcaoMetros > 10) {
          console.log(`[MapMatch] Correção ignorada: direção ${diferencaAngulo.toFixed(0)}° perpendicular ao movimento`);
          return {
            ...position,
            map_matched: false,
            map_rejected: 'direcao_inconsistente',
            map_direcao_diff: diferencaAngulo,
            pipeline: [...position.pipeline, 'map_reject_dir']
          };
        }
      }

      // Correção válida - aplicar
      this.stats.mapMatched++;

      // Treinar IA com feedback do map-matching
      if (this.config.mapMatching.trainFromMatching) {
        gpsAI.treinarComMapMatching(
          { latitude: position.lat_pre_ai || position.lat, longitude: position.lon_pre_ai || position.lon },
          matched
        );
      }

      console.log(`[MapMatch] Aplicado: ${correcaoMetros.toFixed(1)}m de correção`);

      return {
        ...position,
        lat: matched.lat,
        lon: matched.lon,
        lat_pre_match: position.lat,
        lon_pre_match: position.lon,
        map_matched: true,
        map_correction_metros: correcaoMetros,
        map_provider: matched.provider,
        pipeline: [...position.pipeline, 'map_match']
      };
    }

    return {
      ...position,
      map_matched: false,
      pending_batch: matched.pending_batch,
      pipeline: [...position.pipeline, matched.pending_batch ? 'map_pending' : 'map_fail']
    };
  }

  /**
   * Força processamento de batch pendente de map-matching
   */
  async flushMapMatching(imei) {
    return this.mapMatcher.flushBatch(imei);
  }

  /**
   * Processa múltiplos pontos de uma vez (para histórico)
   */
  async processarLote(pontos, imei) {
    const resultados = [];

    for (const ponto of pontos) {
      const resultado = await this.processar(ponto, imei);
      resultados.push(resultado);
    }

    // Flush map-matching
    const matchedBatch = await this.flushMapMatching(imei);
    if (matchedBatch.length > 0) {
      // Atualizar últimos pontos com map-matching
      const startIdx = resultados.length - matchedBatch.length;
      for (let i = 0; i < matchedBatch.length && startIdx + i < resultados.length; i++) {
        if (matchedBatch[i].matched) {
          resultados[startIdx + i].lat = matchedBatch[i].lat;
          resultados[startIdx + i].lon = matchedBatch[i].lon;
          resultados[startIdx + i].map_matched = true;
          resultados[startIdx + i].pipeline.push('map_match');
          this.stats.mapMatched++;
        }
      }
    }

    return resultados;
  }

  /**
   * Obtém estatísticas do pipeline
   */
  getStats() {
    return {
      ...this.stats,
      avgCorrectionMeters: this.stats.processed > 0
        ? this.stats.totalCorrectionMeters / this.stats.processed
        : 0,
      kalmanRate: this.stats.processed > 0
        ? (this.stats.kalmanApplied / this.stats.processed * 100).toFixed(1) + '%'
        : '0%',
      aiRate: this.stats.processed > 0
        ? (this.stats.aiCorrected / this.stats.processed * 100).toFixed(1) + '%'
        : '0%',
      mapMatchRate: this.stats.processed > 0
        ? (this.stats.mapMatched / this.stats.processed * 100).toFixed(1) + '%'
        : '0%',
      ai: gpsAI.getStats()
    };
  }

  /**
   * Log de estatísticas
   */
  logStats() {
    if (this.stats.processed > 0) {
      const stats = this.getStats();

      // ✅ NOVO: Atualizar métricas de tamanho dos Maps
      this.stats.kalmanFiltersSize = this.kalmanFilters.size;
      this.stats.pendingPointsSize = this.mapMatcher?.pendingPoints?.size || 0;

      console.log(`[GPS Pipeline] Stats: ${stats.processed} processados, Kalman=${stats.kalmanRate}, IA=${stats.aiRate}, MapMatch=${stats.mapMatchRate}, Correção média=${stats.avgCorrectionMeters.toFixed(1)}m, Tempo médio=${stats.avgProcessingTimeMs.toFixed(1)}ms`);

      // ✅ NOVO: Log de estado dos Maps (IMPORTANTE para diagnóstico de delay)
      console.log(`[GPS Pipeline] 📊 Maps: ${this.kalmanFilters.size} kalman, ${this.mapMatcher?.pendingPoints?.size || 0} pendingPoints, ${this.lastActivity.size} tracked`);

      // ✅ ALERTA: Se Maps estão muito grandes, pode indicar problema
      if (this.kalmanFilters.size > 5000) {
        console.warn(`[GPS Pipeline] ⚠️ ALERTA: kalmanFilters muito grande (${this.kalmanFilters.size}), pode causar lentidão!`);
      }
      if ((this.mapMatcher?.pendingPoints?.size || 0) > 1000) {
        console.warn(`[GPS Pipeline] ⚠️ ALERTA: pendingPoints muito grande (${this.mapMatcher?.pendingPoints?.size}), pode causar delay!`);
      }

      // ✅ NOVO: Publicar métricas no Redis para o frontend
      this.publishMetricsToRedis();
    }
  }

  /**
   * ✅ NOVO: Publica métricas no Redis para exibição no frontend
   */
  async publishMetricsToRedis() {
    try {
      const Redis = require('ioredis');
      const workerId = process.env.WORKER_ID || process.env.PARTITION_ID || 'unknown';

      // Criar conexão temporária ao Redis DB 0
      const redis = new Redis({
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: 0,
        lazyConnect: false
      });

      const metrics = {
        workerId,
        kalmanFiltersSize: this.kalmanFilters.size,
        pendingPointsSize: this.mapMatcher?.pendingPoints?.size || 0,
        lastMatchedPointsSize: this.mapMatcher?.lastMatchedPoints?.size || 0,
        trackedDevices: this.lastActivity.size,
        processed: this.stats.processed,
        kalmanApplied: this.stats.kalmanApplied,
        aiCorrected: this.stats.aiCorrected,
        mapMatched: this.stats.mapMatched,
        errors: this.stats.errors,
        avgProcessingTimeMs: this.stats.avgProcessingTimeMs,
        lastCleanup: this.stats.lastCleanup,
        timestamp: Date.now()
      };

      // Salvar com TTL de 2 minutos (expira se processor parar)
      await redis.setex(`gps:pipeline:metrics:${workerId}`, 120, JSON.stringify(metrics));
      await redis.quit();
    } catch (e) {
      // Silencioso - não falhar processamento por causa de métricas
      console.warn(`[GPS Pipeline] Erro ao publicar métricas: ${e.message}`);
    }
  }

  /**
   * Reseta filtro de Kalman para um dispositivo
   */
  resetKalman(imei) {
    this.kalmanFilters.delete(imei);
    console.log(`[GPS Pipeline] Kalman resetado para ${imei}`);
  }

  /**
   * Calcula distância em metros
   */
  distanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
}

// Exportar instância singleton
const pipeline = new GPSCorrectionPipeline();

module.exports = {
  pipeline,
  GPSCorrectionPipeline,
  ExtendedKalmanFilter,
  MapMatcher,
  PIPELINE_CONFIG
};
