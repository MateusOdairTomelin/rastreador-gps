/**
 * GPS AI Correction Service - Modelo de IA para correção de coordenadas GPS
 *
 * Implementa um modelo de Machine Learning adaptativo que:
 * 1. Aprende padrões de erro do GPS em diferentes regiões
 * 2. Estima coordenadas corrigidas baseado em histórico
 * 3. Prediz posição quando o GPS falhar (túneis/prédios)
 * 4. Ajusta rota conforme velocidade + heading + histórico
 *
 * Entrada: [lat, lon, velocidade, heading, hdop, últimas N posições]
 * Saída: [lat_corrigida, lon_corrigida, confianca]
 */

const fs = require('fs');
const path = require('path');

// Integrar com servico de pontos de referencia
let gpsReferencia = null;
try {
  gpsReferencia = require('./gps-referencia.service');
  console.log('[GPS-AI] Servico de referencias integrado');
} catch (e) {
  console.warn('[GPS-AI] Servico de referencias nao disponivel:', e.message);
}

// ==================== CONFIGURAÇÕES ====================
const CONFIG = {
  // Histórico de posições para o modelo
  historySize: 10,           // Últimas N posições consideradas

  // Modelo adaptativo
  learningRate: 0.01,        // Taxa de aprendizado
  momentumFactor: 0.9,       // Momentum para suavização

  // Limites de correção
  maxCorrectionMeters: 50,   // Correção máxima permitida (metros)
  minConfidence: 0.3,        // Confiança mínima para aplicar correção

  // Pesos das features
  weights: {
    hdop: 0.3,               // Peso do HDOP (maior = mais impacto)
    velocidade: 0.2,         // Peso da velocidade
    heading: 0.2,            // Peso da direção
    historico: 0.3,          // Peso do histórico
  },

  // Dead reckoning (para prever quando GPS falhar)
  deadReckoning: {
    maxSeconds: 120,         // Máximo de segundos para extrapolar
    decayFactor: 0.95,       // Fator de decaimento da confiança por segundo
  },

  // Arquivo para persistir modelo treinado
  modelPath: path.join(__dirname, '../../data/gps-ai-model.json'),
  trainingDataPath: path.join(__dirname, '../../data/gps-training-data.json'),
};

// ==================== ESTRUTURAS DE DADOS ====================

/**
 * Cache de histórico por dispositivo
 * Map<imei, Array<PositionData>>
 */
const deviceHistoryCache = new Map();

/**
 * Modelo treinado por região (grid)
 * Map<gridKey, RegionModel>
 */
const regionModels = new Map();

/**
 * Buffer de dados para treinamento contínuo
 */
const trainingBuffer = [];
const MAX_TRAINING_BUFFER = 10000;

// ==================== CLASSE PRINCIPAL ====================

class GPSAICorrection {
  constructor() {
    this.loadModel();

    // Salvar modelo periodicamente
    setInterval(() => this.saveModel(), 5 * 60 * 1000); // A cada 5 minutos
  }

  /**
   * Corrige uma posição GPS usando o modelo de IA
   * @param {Object} position - Posição atual {lat, lon, velocidade, direcao, hdop, timestamp}
   * @param {string} imei - IMEI do dispositivo
   * @returns {Object} Posição corrigida {lat, lon, confianca, metodo}
   */
  async corrigir(position, imei) {
    const inicio = Date.now();

    // 1. Obter histórico do dispositivo
    const historico = this.getHistorico(imei);

    // 2. Verificar se GPS está com sinal válido
    const gpsValido = this.validarGPS(position);

    let resultado;

    if (!gpsValido && historico.length >= 2) {
      // GPS sem sinal - usar dead reckoning
      resultado = this.deadReckoning(historico, position.timestamp);
      resultado.metodo = 'dead_reckoning';
      console.log(`[GPS-AI] Dead reckoning para ${imei}: confiança ${(resultado.confianca * 100).toFixed(1)}%`);
    } else if (gpsValido) {
      // GPS com sinal - aplicar correção inteligente
      resultado = await this.aplicarCorrecaoInteligente(position, historico, imei);
      resultado.metodo = 'ai_correction';

      // Atualizar histórico
      this.adicionarAoHistorico(imei, {
        ...position,
        lat_corrigida: resultado.lat,
        lon_corrigida: resultado.lon,
        timestamp: position.timestamp || new Date()
      });

      // Adicionar ao buffer de treinamento
      this.adicionarDadoTreinamento(position, resultado, historico);
    } else {
      // GPS inválido e sem histórico suficiente
      resultado = {
        lat: position.latitude,
        lon: position.longitude,
        confianca: 0.1,
        metodo: 'passthrough'
      };
    }

    resultado.tempoProcessamentoMs = Date.now() - inicio;

    return resultado;
  }

  /**
   * Valida se o GPS está com sinal válido
   */
  validarGPS(position) {
    // Coordenadas 0,0 = sem sinal
    if (position.latitude === 0 && position.longitude === 0) return false;

    // Coordenadas fora do range
    if (Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180) return false;

    // HDOP muito alto
    if (position.hdop && position.hdop > 10) return false;

    return true;
  }

  /**
   * Obtém histórico de posições do dispositivo
   */
  getHistorico(imei) {
    if (!deviceHistoryCache.has(imei)) {
      deviceHistoryCache.set(imei, []);
    }
    return deviceHistoryCache.get(imei);
  }

  /**
   * Adiciona posição ao histórico
   */
  adicionarAoHistorico(imei, position) {
    const historico = this.getHistorico(imei);
    historico.push(position);

    // Manter apenas últimas N posições
    while (historico.length > CONFIG.historySize) {
      historico.shift();
    }
  }

  /**
   * Aplica correção inteligente baseada em múltiplos fatores
   * CORRIGIDO: Muito mais conservador - só corrige quando tem alta confiança
   * Prioriza manter o ponto original se não tiver certeza
   */
  async aplicarCorrecaoInteligente(position, historico, imei) {
    const lat = position.latitude;
    const lon = position.longitude;
    const velocidade = position.velocidade || 0;
    const heading = position.direcao || 0;
    const hdop = position.hdop || 2;

    // 1. Calcular features do modelo
    const features = this.extrairFeatures(position, historico);

    // 2. Obter modelo da região
    const gridKey = this.getGridKey(lat, lon);
    const regionModel = this.getRegionModel(gridKey);

    // 3. Verificar se temos treinamento suficiente
    const temTreinamento = regionModel.samples >= 10;
    const biasSignificativo = Math.abs(regionModel.bias.lat) > 0.000001 || Math.abs(regionModel.bias.lon) > 0.000001;

    // 4. Calcular confiança inicial baseada no HDOP
    const hdopFactor = Math.min(hdop / 5, 2);
    let confianca = Math.max(0.3, 1 - (hdopFactor * 0.3));

    // 5. SE NÃO TEM TREINAMENTO: tentar usar pontos de referência
    if (!temTreinamento || !biasSignificativo) {
      // NOVO: Tentar usar pontos de referência de alta precisão
      if (gpsReferencia && position.dispositivo_id) {
        try {
          const sugestao = await gpsReferencia.sugerirCorrecaoPorReferencia(
            position.dispositivo_id,
            lat,
            lon
          );

          if (sugestao.sugerido && sugestao.confianca >= 0.6) {
            console.log(`[GPS-AI] Correcao por referencias: ${sugestao.correcao_metros.toFixed(1)}m, ${sugestao.referencias} refs`);

            return {
              lat: sugestao.lat,
              lon: sugestao.lon,
              lat_original: lat,
              lon_original: lon,
              correcao_metros: sugestao.correcao_metros,
              confianca: sugestao.confianca,
              metodo_interno: 'correcao_por_referencias',
              referencias_usadas: sugestao.referencias,
              features
            };
          }
        } catch (refError) {
          console.warn(`[GPS-AI] Erro ao usar referencias: ${refError.message}`);
        }
      }

      // Sem referencias: usar predição com suavização leve
      if (historico.length >= 2 && velocidade > 2) {
        const predicao = this.predizePosicaoPorHistorico(historico, position.timestamp);
        const diffMetros = this.distanciaMetros(lat, lon, predicao.lat, predicao.lon);

        // Só fazer micro-ajuste se a diferença for pequena (< 10m)
        // E a predição tiver alta confiança
        if (diffMetros < 10 && predicao.confianca > 0.7) {
          // Correção muito leve: apenas 10% em direção à predição
          const fator = 0.1;
          const novoLat = lat + (predicao.lat - lat) * fator;
          const novoLon = lon + (predicao.lon - lon) * fator;

          return {
            lat: novoLat,
            lon: novoLon,
            lat_original: lat,
            lon_original: lon,
            correcao_metros: this.distanciaMetros(lat, lon, novoLat, novoLon),
            confianca: confianca * 0.8,
            metodo_interno: 'micro_suavizacao_sem_treino',
            features
          };
        }
      }

      // Sem condições para corrigir: retornar original
      return {
        lat: lat,
        lon: lon,
        lat_original: lat,
        lon_original: lon,
        correcao_metros: 0,
        confianca: confianca,
        metodo_interno: 'passthrough_sem_treino',
        features
      };
    }

    // 6. COM TREINAMENTO: aplicar correções mais assertivas
    let correcaoLat = 0;
    let correcaoLon = 0;

    // Correção por consistência com histórico
    if (historico.length >= 2) {
      const predicao = this.predizePosicaoPorHistorico(historico, position.timestamp);
      const diffMetros = this.distanciaMetros(lat, lon, predicao.lat, predicao.lon);

      // Só corrigir se diferença for razoável (5-30m) e temos confiança
      if (diffMetros > 5 && diffMetros < 30 && predicao.confianca > 0.5) {
        // Fator de correção proporcional à confiança da predição
        const fatorCorrecao = Math.min(0.4, (diffMetros / 50) * predicao.confianca);
        correcaoLat = (predicao.lat - lat) * fatorCorrecao;
        correcaoLon = (predicao.lon - lon) * fatorCorrecao;
        confianca *= (1 - fatorCorrecao * 0.2);
      } else if (diffMetros <= 5) {
        // Posição muito consistente - alta confiança
        confianca *= 1.1;
      } else if (diffMetros > 30) {
        // Diferença muito grande - não corrigir, pode ser mudança real de direção
        confianca *= 0.6;
      }
    }

    // Aplicar bias da região (aprendido) - só se significativo
    if (biasSignificativo) {
      // Aplicar bias ponderado pelo HDOP (mais HDOP = mais bias)
      const pesoBias = Math.min(hdopFactor * 0.5, 1);
      correcaoLat += regionModel.bias.lat * pesoBias;
      correcaoLon += regionModel.bias.lon * pesoBias;
    }

    // Limitar correção máxima a 20m (mais conservador que antes)
    const maxCorrecao = Math.min(CONFIG.maxCorrectionMeters, 20);
    const correcaoMetros = this.distanciaMetros(lat, lon, lat + correcaoLat, lon + correcaoLon);
    if (correcaoMetros > maxCorrecao) {
      const fator = maxCorrecao / correcaoMetros;
      correcaoLat *= fator;
      correcaoLon *= fator;
    }

    // Normalizar confiança
    confianca = Math.max(0.1, Math.min(1.0, confianca));

    const latFinal = lat + correcaoLat;
    const lonFinal = lon + correcaoLon;

    return {
      lat: latFinal,
      lon: lonFinal,
      lat_original: lat,
      lon_original: lon,
      correcao_metros: this.distanciaMetros(lat, lon, latFinal, lonFinal),
      confianca,
      metodo_interno: 'correcao_com_treino',
      features
    };
  }

  /**
   * Dead Reckoning - prediz posição quando GPS falha
   */
  deadReckoning(historico, timestamp) {
    if (historico.length < 2) {
      return { lat: 0, lon: 0, confianca: 0 };
    }

    // Usar últimas posições para calcular velocidade e direção médias
    const ultimas = historico.slice(-5);
    let velMedia = 0;
    let dirMedia = 0;
    let count = 0;

    for (let i = 1; i < ultimas.length; i++) {
      if (ultimas[i].velocidade) velMedia += ultimas[i].velocidade;
      if (ultimas[i].direcao) dirMedia += ultimas[i].direcao;
      count++;
    }

    if (count > 0) {
      velMedia /= count;
      dirMedia /= count;
    }

    // Calcular tempo desde última posição válida
    const ultimaPosicao = ultimas[ultimas.length - 1];
    const dt = timestamp
      ? (new Date(timestamp) - new Date(ultimaPosicao.timestamp)) / 1000
      : 0;

    // Limitar tempo de extrapolação
    const dtLimitado = Math.min(dt, CONFIG.deadReckoning.maxSeconds);

    // Calcular nova posição
    const novaPosicao = this.calcularPosicaoEsperada(ultimaPosicao, velMedia, dirMedia, dtLimitado);

    // Confiança decresce com o tempo
    const confianca = Math.pow(CONFIG.deadReckoning.decayFactor, dtLimitado / 10);

    return {
      lat: novaPosicao.lat,
      lon: novaPosicao.lon,
      lat_original: ultimaPosicao.latitude || ultimaPosicao.lat_corrigida,
      lon_original: ultimaPosicao.longitude || ultimaPosicao.lon_corrigida,
      confianca: Math.max(0.1, confianca),
      dt_segundos: dtLimitado,
      velocidade_usada: velMedia,
      direcao_usada: dirMedia
    };
  }

  /**
   * Prediz posição baseada no histórico usando velocidade e heading
   * CORRIGIDO: Não usa mais regressão linear que extrapolava errado
   * Agora usa velocidade + heading do último ponto válido
   */
  predizePosicaoPorHistorico(historico, timestamp) {
    if (historico.length < 1) {
      return { lat: 0, lon: 0, confianca: 0 };
    }

    const ultimo = historico[historico.length - 1];
    const latUltimo = ultimo.lat_corrigida || ultimo.latitude;
    const lonUltimo = ultimo.lon_corrigida || ultimo.longitude;

    if (historico.length < 2) {
      return { lat: latUltimo, lon: lonUltimo, confianca: 0.5 };
    }

    // Calcular tempo desde o último ponto
    const dtSegundos = timestamp
      ? (new Date(timestamp).getTime() - new Date(ultimo.timestamp).getTime()) / 1000
      : 1;

    // Se muito tempo passou, não confiar na predição
    if (dtSegundos > 30 || dtSegundos < 0) {
      return { lat: latUltimo, lon: lonUltimo, confianca: 0.3 };
    }

    // Usar velocidade e heading do último ponto para predizer
    const velocidade = ultimo.velocidade || 0;
    const heading = ultimo.direcao || 0;

    // Se parado ou muito lento, não mover
    if (velocidade < 3) {
      return { lat: latUltimo, lon: lonUltimo, confianca: 0.9 };
    }

    // Calcular posição esperada baseada em velocidade + heading
    const predicao = this.calcularPosicaoEsperada(
      { lat_corrigida: latUltimo, lon_corrigida: lonUltimo },
      velocidade,
      heading,
      dtSegundos
    );

    // Confiança decresce com o tempo
    const confianca = Math.max(0.3, 1 - (dtSegundos / 30));

    return {
      lat: predicao.lat,
      lon: predicao.lon,
      confianca
    };
  }

  /**
   * Regressão linear simples
   */
  regressaoLinear(x, y) {
    const n = x.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
    }

    const denom = n * sumX2 - sumX * sumX;
    if (Math.abs(denom) < 1e-10) {
      return { a: 0, b: sumY / n };
    }

    const a = (n * sumXY - sumX * sumY) / denom;
    const b = (sumY - a * sumX) / n;

    return { a, b };
  }

  /**
   * Calcula posição esperada baseada em velocidade e heading
   */
  calcularPosicaoEsperada(posicao, velocidadeKmh, headingGraus, dtSegundos) {
    const lat = posicao.lat_corrigida || posicao.latitude;
    const lon = posicao.lon_corrigida || posicao.longitude;

    // Converter velocidade para m/s
    const velocidadeMs = velocidadeKmh / 3.6;

    // Distância percorrida
    const distanciaMetros = velocidadeMs * dtSegundos;

    // Converter heading para radianos
    const headingRad = headingGraus * Math.PI / 180;

    // Calcular deslocamento
    const R = 6371000; // Raio da Terra em metros
    const dLat = (distanciaMetros * Math.cos(headingRad)) / R;
    const dLon = (distanciaMetros * Math.sin(headingRad)) / (R * Math.cos(lat * Math.PI / 180));

    return {
      lat: lat + (dLat * 180 / Math.PI),
      lon: lon + (dLon * 180 / Math.PI)
    };
  }

  /**
   * Extrai features para o modelo
   */
  extrairFeatures(position, historico) {
    const features = {
      // Features básicas
      hdop: position.hdop || 2,
      velocidade: position.velocidade || 0,
      heading: position.direcao || 0,

      // Features derivadas
      variacao_velocidade: 0,
      variacao_heading: 0,
      distancia_ultima: 0,
      tempo_desde_ultima: 0,

      // Features de consistência
      pontos_no_historico: historico.length,
      consistencia: 0
    };

    if (historico.length > 0) {
      const ultimo = historico[historico.length - 1];

      features.variacao_velocidade = Math.abs((position.velocidade || 0) - (ultimo.velocidade || 0));
      features.variacao_heading = Math.abs(this.diferencaAngulo(position.direcao || 0, ultimo.direcao || 0));
      features.distancia_ultima = this.distanciaMetros(
        position.latitude, position.longitude,
        ultimo.lat_corrigida || ultimo.latitude, ultimo.lon_corrigida || ultimo.longitude
      );
      features.tempo_desde_ultima = (new Date(position.timestamp) - new Date(ultimo.timestamp)) / 1000;

      // Calcular consistência (baseado em quão próximo está da predição)
      if (historico.length >= 2) {
        const predicao = this.predizePosicaoPorHistorico(historico, position.timestamp);
        const distPredicao = this.distanciaMetros(position.latitude, position.longitude, predicao.lat, predicao.lon);
        features.consistencia = Math.max(0, 1 - (distPredicao / 100));
      }
    }

    return features;
  }

  /**
   * Obtém ou cria modelo para uma região
   */
  getRegionModel(gridKey) {
    if (!regionModels.has(gridKey)) {
      regionModels.set(gridKey, {
        bias: { lat: 0, lon: 0 },
        samples: 0,
        errors: []
      });
    }
    return regionModels.get(gridKey);
  }

  /**
   * Gera chave de grid para uma coordenada
   * Grid de ~1km x 1km
   */
  getGridKey(lat, lon) {
    const gridLat = Math.floor(lat * 100) / 100; // ~1.1km de resolução
    const gridLon = Math.floor(lon * 100) / 100;
    return `${gridLat.toFixed(2)}_${gridLon.toFixed(2)}`;
  }

  /**
   * Adiciona dados para treinamento contínuo
   */
  adicionarDadoTreinamento(original, corrigido, historico) {
    const dado = {
      timestamp: new Date().toISOString(),
      original: {
        lat: original.latitude,
        lon: original.longitude,
        velocidade: original.velocidade,
        heading: original.direcao,
        hdop: original.hdop
      },
      corrigido: {
        lat: corrigido.lat,
        lon: corrigido.lon,
        confianca: corrigido.confianca
      },
      historico_size: historico.length,
      grid_key: this.getGridKey(original.latitude, original.longitude)
    };

    trainingBuffer.push(dado);

    // Limitar buffer
    while (trainingBuffer.length > MAX_TRAINING_BUFFER) {
      trainingBuffer.shift();
    }
  }

  /**
   * Treina o modelo com feedback real
   * Chamado quando sabemos que uma posição estava errada
   */
  treinarComFeedback(posicaoErrada, posicaoCorreta, imei) {
    const gridKey = this.getGridKey(posicaoErrada.latitude, posicaoErrada.longitude);
    const modelo = this.getRegionModel(gridKey);

    // Calcular erro
    const erroLat = posicaoCorreta.latitude - posicaoErrada.latitude;
    const erroLon = posicaoCorreta.longitude - posicaoErrada.longitude;

    // Atualizar bias usando média móvel exponencial
    const alpha = CONFIG.learningRate;
    modelo.bias.lat = modelo.bias.lat * (1 - alpha) + erroLat * alpha;
    modelo.bias.lon = modelo.bias.lon * (1 - alpha) + erroLon * alpha;
    modelo.samples++;

    // Armazenar erro para análise
    modelo.errors.push({
      timestamp: new Date().toISOString(),
      erroLat,
      erroLon,
      imei
    });

    // Manter apenas últimos 100 erros por região
    while (modelo.errors.length > 100) {
      modelo.errors.shift();
    }

    console.log(`[GPS-AI] Treinamento: grid=${gridKey}, bias=(${modelo.bias.lat.toFixed(6)}, ${modelo.bias.lon.toFixed(6)}), samples=${modelo.samples}`);
  }

  /**
   * Treina automaticamente usando map-matching como referência
   */
  async treinarComMapMatching(posicaoOriginal, posicaoMapMatched) {
    if (!posicaoMapMatched.matched) return;

    const erroMetros = this.distanciaMetros(
      posicaoOriginal.latitude, posicaoOriginal.longitude,
      posicaoMapMatched.lat, posicaoMapMatched.lon
    );

    // Só treinar se erro significativo (> 5m)
    if (erroMetros > 5) {
      this.treinarComFeedback(posicaoOriginal, {
        latitude: posicaoMapMatched.lat,
        longitude: posicaoMapMatched.lon
      });
    }
  }

  /**
   * Salva modelo em arquivo
   */
  async saveModel() {
    try {
      // Garantir que diretório existe
      const dir = path.dirname(CONFIG.modelPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const modelData = {
        version: '1.0',
        savedAt: new Date().toISOString(),
        config: CONFIG,
        regions: Object.fromEntries(regionModels),
        stats: {
          totalRegions: regionModels.size,
          totalSamples: Array.from(regionModels.values()).reduce((sum, r) => sum + r.samples, 0)
        }
      };

      fs.writeFileSync(CONFIG.modelPath, JSON.stringify(modelData, null, 2));
      console.log(`[GPS-AI] Modelo salvo: ${regionModels.size} regiões, ${modelData.stats.totalSamples} amostras`);

      // Salvar dados de treinamento separadamente
      if (trainingBuffer.length > 0) {
        fs.writeFileSync(CONFIG.trainingDataPath, JSON.stringify(trainingBuffer, null, 2));
        console.log(`[GPS-AI] Dados de treinamento salvos: ${trainingBuffer.length} amostras`);
      }
    } catch (error) {
      console.error(`[GPS-AI] Erro ao salvar modelo: ${error.message}`);
    }
  }

  /**
   * Carrega modelo de arquivo
   */
  loadModel() {
    try {
      if (fs.existsSync(CONFIG.modelPath)) {
        const data = JSON.parse(fs.readFileSync(CONFIG.modelPath, 'utf8'));

        // Restaurar modelos de região
        if (data.regions) {
          for (const [key, value] of Object.entries(data.regions)) {
            regionModels.set(key, value);
          }
        }

        console.log(`[GPS-AI] Modelo carregado: ${regionModels.size} regiões, versão ${data.version}`);
      } else {
        console.log('[GPS-AI] Nenhum modelo salvo encontrado, iniciando do zero');
      }
    } catch (error) {
      console.error(`[GPS-AI] Erro ao carregar modelo: ${error.message}`);
    }
  }

  /**
   * Calcula distância em metros entre dois pontos
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

  /**
   * Calcula diferença angular (-180 a 180)
   */
  diferencaAngulo(a1, a2) {
    let diff = ((a2 - a1 + 180) % 360) - 180;
    return diff < -180 ? diff + 360 : diff;
  }

  /**
   * Obtém estatísticas do modelo
   */
  getStats() {
    const regionsArray = Array.from(regionModels.values());

    return {
      totalRegioes: regionModels.size,
      totalAmostras: regionsArray.reduce((sum, r) => sum + r.samples, 0),
      mediaErrosPorRegiao: regionsArray.length > 0
        ? regionsArray.reduce((sum, r) => sum + r.errors.length, 0) / regionsArray.length
        : 0,
      dispositivosAtivos: deviceHistoryCache.size,
      bufferTreinamento: trainingBuffer.length
    };
  }
}

// Exportar instância singleton
module.exports = new GPSAICorrection();
