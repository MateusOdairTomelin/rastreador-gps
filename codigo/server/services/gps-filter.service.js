/**
 * GPS Filter Service - Pipeline de processamento de rotas GPS
 *
 * Implementa:
 * 1. Filtro de Kalman (2D constante-velocidade)
 * 2. Validação de HDOP e rejeição de outliers
 * 3. Média móvel para suavização
 * 4. Filtro Hampel para outliers
 * 5. Interpolação baseada em velocidade/heading
 * 6. Map-matching com OSRM (HMM)
 */

const fetch = require('node-fetch');

// ==================== CONFIGURAÇÕES ====================
// AJUSTADO: Parâmetros mais conservadores para manter pontos na rua
const CONFIG = {
  // Filtro de Kalman - AJUSTADO para ser menos agressivo
  kalman: {
    processNoise: 0.01,      // Q - AUMENTADO: seguir mais a medição real
    measurementNoise: 10,    // R - REDUZIDO: confiar mais no GPS
    initialCovariance: 100,  // P inicial - REDUZIDO: menor incerteza inicial
  },

  // Validação
  validation: {
    maxHDOP: 8,              // REDUZIDO: Rejeitar HDOP > 8 (mais rigoroso)
    maxSpeedKmh: 180,        // REDUZIDO: Velocidade máxima plausível
    minSpeedForInterp: 2,    // AUMENTADO: Só interpolar se em movimento
    maxGapSeconds: 120,      // REDUZIDO: Gap máximo para interpolar (2 min)
  },

  // Média móvel - AJUSTADO
  movingAverage: {
    windowSize: 3,           // Mantido: Janela de 3 pontos
    enabled: false,          // DESABILITADO: Pode tirar pontos da rua
  },

  // Map-matching OSRM
  osrm: {
    url: process.env.OSRM_URL || 'http://osrm-sul-brasil:5000/match/v1/driving',  // OSRM Docker
    gpsPrecision: 8,         // REDUZIDO: Precisão GPS em metros
    radiusMeters: 25,        // REDUZIDO: Raio de busca mais preciso
    maxCoordsPerRequest: 50, // REDUZIDO: Evitar URLs muito longas (erro 400)
  },

  // HMM local (quando OSRM falha)
  hmm: {
    sigma: 6,                // REDUZIDO: Desvio padrão emissão (metros)
    beta: 50,                // REDUZIDO: Tolerância transição (metros)
  },

  // Interpolação - AJUSTADO para ser mais conservador
  interpolation: {
    maxDistanceMeters: 200,  // REDUZIDO: Distância máxima para interpolar
    minDistanceMeters: 8,    // AUMENTADO: Só interpolar gaps maiores
    pointsPerSegment: 10,    // REDUZIDO: Menos pontos intermediários
  },
};

// ==================== FILTRO DE KALMAN ====================

class KalmanFilter2D {
  constructor(config = {}) {
    const dt = config.dt || 1.0; // Intervalo de tempo (segundos)

    // Matriz de transição de estado (posição + velocidade)
    this.F = [
      [1, 0, dt, 0],
      [0, 1, 0, dt],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];

    // Matriz de observação (só medimos posição)
    this.H = [
      [1, 0, 0, 0],
      [0, 1, 0, 0]
    ];

    // Ruído do processo
    const q = config.processNoise || CONFIG.kalman.processNoise;
    this.Q = [
      [q, 0, 0, 0],
      [0, q, 0, 0],
      [0, 0, q * 100, 0],
      [0, 0, 0, q * 100]
    ];

    // Ruído da medição
    const r = config.measurementNoise || CONFIG.kalman.measurementNoise;
    this.R = [
      [r, 0],
      [0, r]
    ];

    // Estado inicial [lat, lon, vel_lat, vel_lon]
    this.x = null;

    // Covariância inicial
    const p = config.initialCovariance || CONFIG.kalman.initialCovariance;
    this.P = [
      [p, 0, 0, 0],
      [0, p, 0, 0],
      [0, 0, p, 0],
      [0, 0, 0, p]
    ];
  }

  // Inicializar com primeiro ponto
  initialize(lat, lon) {
    this.x = [lat, lon, 0, 0];
  }

  // Predição
  predict() {
    // x = F * x
    this.x = this.matVecMult(this.F, this.x);

    // P = F * P * F' + Q
    const FP = this.matMult(this.F, this.P);
    const FT = this.transpose(this.F);
    const FPFt = this.matMult(FP, FT);
    this.P = this.matAdd(FPFt, this.Q);
  }

  // Atualização com nova medição
  update(lat, lon) {
    const z = [lat, lon];

    // y = z - H * x (inovação)
    const Hx = this.matVecMult(this.H, this.x);
    const y = [z[0] - Hx[0], z[1] - Hx[1]];

    // S = H * P * H' + R
    const HP = this.matMult(this.H, this.P);
    const HT = this.transpose(this.H);
    const HPHt = this.matMult(HP, HT);
    const S = this.matAdd(HPHt, this.R);

    // K = P * H' * S^(-1) (ganho de Kalman)
    const PHt = this.matMult(this.P, HT);
    const Sinv = this.inverse2x2(S);
    const K = this.matMult(PHt, Sinv);

    // x = x + K * y
    const Ky = this.matVecMult(K, y);
    this.x = [
      this.x[0] + Ky[0],
      this.x[1] + Ky[1],
      this.x[2] + Ky[2],
      this.x[3] + Ky[3]
    ];

    // P = (I - K * H) * P
    const KH = this.matMult(K, this.H);
    const I = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
    const IKH = this.matSub(I, KH);
    this.P = this.matMult(IKH, this.P);

    return { lat: this.x[0], lon: this.x[1] };
  }

  // Processar e retornar posição filtrada
  filter(lat, lon, dt = 1.0) {
    // Atualizar dt na matriz F
    this.F[0][2] = dt;
    this.F[1][3] = dt;

    if (this.x === null) {
      this.initialize(lat, lon);
      return { lat, lon };
    }

    this.predict();
    return this.update(lat, lon);
  }

  // ===== Funções auxiliares de álgebra linear =====

  matVecMult(M, v) {
    return M.map(row => row.reduce((sum, val, i) => sum + val * v[i], 0));
  }

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
    if (Math.abs(det) < 1e-10) return [[1,0],[0,1]]; // Evitar divisão por zero
    return [
      [M[1][1] / det, -M[0][1] / det],
      [-M[1][0] / det, M[0][0] / det]
    ];
  }
}

// ==================== FUNÇÕES DE VALIDAÇÃO ====================

/**
 * Valida e filtra pontos GPS ruins
 */
function validarPontos(pontos, config = CONFIG.validation) {
  const rejeitados = { hdop: 0, velocidade: 0, coordInvalidas: 0, foraBrasil: 0 };

  const resultado = pontos.filter((p, index) => {
    // Rejeitar HDOP alto (se disponível)
    if (p.hdop && p.hdop > config.maxHDOP) {
      rejeitados.hdop++;
      return false;
    }

    // Rejeitar velocidade impossível
    if (p.velocidade && p.velocidade > config.maxSpeedKmh) {
      rejeitados.velocidade++;
      return false;
    }

    // Rejeitar coordenadas inválidas (0,0 ou fora do range)
    if (p.latitude === 0 && p.longitude === 0) {
      rejeitados.coordInvalidas++;
      return false;
    }
    // Rejeitar coordenadas de fallback do GPS (-90,-180 ou similares)
    if (p.latitude <= -89 || p.longitude <= -179) {
      rejeitados.coordInvalidas++;
      return false;
    }
    if (p.latitude < -90 || p.latitude > 90) {
      rejeitados.coordInvalidas++;
      return false;
    }
    if (p.longitude < -180 || p.longitude > 180) {
      rejeitados.coordInvalidas++;
      return false;
    }

    // Rejeitar coordenadas fora do Brasil (aproximado)
    // Latitude: -35 a 5, Longitude: -75 a -30
    if (p.latitude < -35 || p.latitude > 5) {
      rejeitados.foraBrasil++;
      return false;
    }
    if (p.longitude < -75 || p.longitude > -30) {
      rejeitados.foraBrasil++;
      return false;
    }

    return true;
  });

  if (Object.values(rejeitados).some(v => v > 0)) {
    console.log(`[GPS] Validação: ${pontos.length} -> ${resultado.length} pontos. Rejeitados:`, rejeitados);
  }

  return resultado;
}

/**
 * Detecta e remove outliers usando velocidade impossível entre pontos
 */
function removerSaltosImposssiveis(pontos, maxSpeedKmh = 180) {
  if (pontos.length < 2) return pontos;

  const resultado = [pontos[0]];

  for (let i = 1; i < pontos.length; i++) {
    const anterior = resultado[resultado.length - 1];
    const atual = pontos[i];

    const distanciaKm = calcularDistanciaHaversine(
      anterior.latitude, anterior.longitude,
      atual.latitude, atual.longitude
    );

    const tempoHoras = (new Date(atual.timestamp) - new Date(anterior.timestamp)) / (1000 * 60 * 60);

    if (tempoHoras > 0) {
      const velocidadeCalculada = distanciaKm / tempoHoras;

      if (velocidadeCalculada <= maxSpeedKmh) {
        resultado.push(atual);
      } else {
        console.log(`[GPS] Removendo salto impossível: ${velocidadeCalculada.toFixed(0)} km/h`);
      }
    } else {
      resultado.push(atual);
    }
  }

  return resultado;
}

/**
 * Filtro Hampel para detectar outliers isolados
 */
function filtroHampel(pontos, windowSize = 5, threshold = 3) {
  if (pontos.length < windowSize) return pontos;

  const resultado = [...pontos];
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = halfWindow; i < pontos.length - halfWindow; i++) {
    // Coletar janela de latitudes
    const windowLats = [];
    const windowLons = [];

    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j !== i) {
        windowLats.push(pontos[j].latitude);
        windowLons.push(pontos[j].longitude);
      }
    }

    // Calcular mediana e MAD (Median Absolute Deviation)
    const medianLat = mediana(windowLats);
    const medianLon = mediana(windowLons);

    const madLat = mediana(windowLats.map(x => Math.abs(x - medianLat))) * 1.4826;
    const madLon = mediana(windowLons.map(x => Math.abs(x - medianLon))) * 1.4826;

    // Verificar se ponto atual é outlier
    const desvioLat = Math.abs(pontos[i].latitude - medianLat) / (madLat || 1e-10);
    const desvioLon = Math.abs(pontos[i].longitude - medianLon) / (madLon || 1e-10);

    if (desvioLat > threshold || desvioLon > threshold) {
      // Substituir por mediana
      resultado[i] = {
        ...pontos[i],
        latitude: medianLat,
        longitude: medianLon,
        corrigido: true
      };
      console.log(`[Hampel] Corrigido outlier no ponto ${i}`);
    }
  }

  return resultado;
}

function mediana(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ==================== MÉDIA MÓVEL ====================

/**
 * Aplica média móvel para suavização inicial
 */
function mediaMovel(pontos, windowSize = 3) {
  if (pontos.length <= windowSize) return pontos;

  const resultado = [];
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = 0; i < pontos.length; i++) {
    let sumLat = 0, sumLon = 0, count = 0;

    for (let j = Math.max(0, i - halfWindow); j <= Math.min(pontos.length - 1, i + halfWindow); j++) {
      sumLat += pontos[j].latitude;
      sumLon += pontos[j].longitude;
      count++;
    }

    resultado.push({
      ...pontos[i],
      latitude: sumLat / count,
      longitude: sumLon / count
    });
  }

  return resultado;
}

// ==================== FILTRO DE KALMAN APLICADO ====================

/**
 * Aplica filtro de Kalman em sequência de pontos
 */
function aplicarKalman(pontos, config = CONFIG.kalman) {
  if (pontos.length < 2) return pontos;

  const kalman = new KalmanFilter2D(config);
  const resultado = [];

  for (let i = 0; i < pontos.length; i++) {
    const p = pontos[i];

    // Calcular dt
    let dt = 1.0;
    if (i > 0 && p.timestamp && pontos[i-1].timestamp) {
      dt = (new Date(p.timestamp) - new Date(pontos[i-1].timestamp)) / 1000;
      dt = Math.max(0.1, Math.min(dt, 60)); // Limitar entre 0.1s e 60s
    }

    const filtrado = kalman.filter(p.latitude, p.longitude, dt);

    resultado.push({
      ...p,
      latitude: filtrado.lat,
      longitude: filtrado.lon,
      latitude_original: p.latitude,
      longitude_original: p.longitude,
      kalman_filtered: true
    });
  }

  return resultado;
}

// ==================== INTERPOLAÇÃO COM CATMULL-ROM SPLINE ====================

/**
 * Interpola pontos usando Catmull-Rom splines para curvas mais suaves
 * Esta técnica cria curvas que passam exatamente pelos pontos originais
 */
function interpolarComHeading(pontos, config = CONFIG.interpolation) {
  if (pontos.length < 2) return pontos;

  const resultado = [];

  for (let i = 0; i < pontos.length - 1; i++) {
    const p1 = pontos[i];
    const p2 = pontos[i + 1];

    resultado.push({ ...p1, original: true });

    // Calcular gap de tempo
    const tempoSegundos = (new Date(p2.timestamp) - new Date(p1.timestamp)) / 1000;

    // Não interpolar gaps grandes (perda de sinal)
    if (tempoSegundos > CONFIG.validation.maxGapSeconds) {
      continue;
    }

    // Calcular distância
    const distanciaMetros = calcularDistanciaHaversine(
      p1.latitude, p1.longitude,
      p2.latitude, p2.longitude
    ) * 1000;

    // Calcular mudança de direção (importante para curvas)
    const mudancaDirecao = Math.abs(normalizarAngulo((p2.direcao || 0) - (p1.direcao || 0)));

    // Interpolar mais agressivamente quando há curva (mudança > 15°)
    const temCurva = mudancaDirecao > 15;

    // Verificar se precisa interpolar
    // Interpolar se: distância > 2m E <= max
    // Qualquer mudança de direção merece interpolação para suavizar
    if (distanciaMetros < 2 || distanciaMetros > config.maxDistanceMeters) {
      continue;
    }

    // Calcular número de pontos intermediários
    // Mínimo 3 pontos para criar curva suave, mais em curvas
    let numPontos;
    if (temCurva) {
      // Em curvas: mais pontos proporcional à mudança de direção
      const fatorCurva = 1 + (mudancaDirecao / 60); // 1x a 3x baseado na curva
      numPontos = Math.max(4, Math.min(
        Math.ceil((distanciaMetros / 2) * fatorCurva),
        config.pointsPerSegment * 2
      ));
    } else {
      // Em retas: mínimo 3 pontos
      numPontos = Math.max(3, Math.min(
        Math.ceil(distanciaMetros / config.minDistanceMeters),
        config.pointsPerSegment
      ));
    }

    // Usar Catmull-Rom se tivermos pontos antes e depois
    const p0 = i > 0 ? pontos[i - 1] : p1;
    const p3 = i < pontos.length - 2 ? pontos[i + 2] : p2;

    // Gerar pontos intermediários usando Catmull-Rom
    for (let j = 1; j < numPontos; j++) {
      const t = j / numPontos;

      // Catmull-Rom spline (mais suave que Bezier)
      const lat = catmullRom(p0.latitude, p1.latitude, p2.latitude, p3.latitude, t);
      const lon = catmullRom(p0.longitude, p1.longitude, p2.longitude, p3.longitude, t);

      const vel = Math.round(p1.velocidade + (p2.velocidade - p1.velocidade) * t);
      const dir = interpolarAngulo(p1.direcao || 0, p2.direcao || 0, t);

      const ts1 = new Date(p1.timestamp).getTime();
      const ts2 = new Date(p2.timestamp).getTime();

      resultado.push({
        latitude: lat,
        longitude: lon,
        velocidade: vel,
        direcao: Math.round(dir),
        timestamp: new Date(ts1 + (ts2 - ts1) * t),
        ignicao: p1.ignicao,  // ✅ Herdar ignição do ponto anterior
        original: false,
        interpolado: true
      });
    }
  }

  // Adicionar último ponto
  resultado.push({ ...pontos[pontos.length - 1], original: true });

  return resultado;
}

/**
 * Interpolação Catmull-Rom spline
 * Cria curvas que passam exatamente pelos pontos de controle
 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;

  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Normaliza ângulo para -180 a 180
 */
function normalizarAngulo(angulo) {
  while (angulo > 180) angulo -= 360;
  while (angulo < -180) angulo += 360;
  return angulo;
}

// ==================== FILTRO PRÉ-OSRM ====================

/**
 * Remove pontos redundantes/oscilantes antes de enviar ao OSRM
 * Isso evita que o OSRM crie rotas de ida e volta quando o veículo está parado
 */
function removerPontosRedundantes(pontos, distanciaMinMetros = 10) {
  if (pontos.length < 2) return pontos;

  const resultado = [pontos[0]];

  for (let i = 1; i < pontos.length; i++) {
    const ultimo = resultado[resultado.length - 1];
    const atual = pontos[i];

    const distancia = calcularDistanciaHaversine(
      ultimo.latitude, ultimo.longitude,
      atual.latitude, atual.longitude
    ) * 1000; // Converter km para metros

    // Só adicionar se estiver a pelo menos X metros do último ponto mantido
    if (distancia >= distanciaMinMetros) {
      resultado.push(atual);
    }
  }

  // Sempre manter o último ponto
  const ultimoPonto = pontos[pontos.length - 1];
  const ultimoMantido = resultado[resultado.length - 1];
  if (ultimoPonto !== ultimoMantido) {
    resultado.push(ultimoPonto);
  }

  if (resultado.length < pontos.length) {
    console.log(`[PreOSRM] Removidos ${pontos.length - resultado.length} pontos redundantes (< ${distanciaMinMetros}m)`);
  }

  return resultado;
}

/**
 * Detecta e remove oscilações (pontos que voltam para posição anterior)
 * Exemplo: A -> B -> A -> B -> C vira A -> C
 */
function removerOscilacoes(pontos, toleranciaMetros = 20) {
  if (pontos.length < 3) return pontos;

  const resultado = [pontos[0]];

  for (let i = 1; i < pontos.length - 1; i++) {
    const anterior = resultado[resultado.length - 1];
    const atual = pontos[i];
    const proximo = pontos[i + 1];

    // Verificar se o próximo ponto está mais perto do anterior que do atual
    // Isso indica uma oscilação (foi e voltou)
    const distAtualAnterior = calcularDistanciaHaversine(
      atual.latitude, atual.longitude,
      anterior.latitude, anterior.longitude
    ) * 1000;

    const distProximoAnterior = calcularDistanciaHaversine(
      proximo.latitude, proximo.longitude,
      anterior.latitude, anterior.longitude
    ) * 1000;

    const distProximoAtual = calcularDistanciaHaversine(
      proximo.latitude, proximo.longitude,
      atual.latitude, atual.longitude
    ) * 1000;

    // Se o próximo ponto está voltando para perto do anterior, pular o ponto atual
    const estaOscilando = distProximoAnterior < distAtualAnterior &&
                          distProximoAnterior < toleranciaMetros;

    if (!estaOscilando) {
      resultado.push(atual);
    }
  }

  // Sempre manter o último ponto
  resultado.push(pontos[pontos.length - 1]);

  if (resultado.length < pontos.length) {
    console.log(`[PreOSRM] Removidas ${pontos.length - resultado.length} oscilações`);
  }

  return resultado;
}

/**
 * Simplifica trajetória usando algoritmo Douglas-Peucker
 * Mantém a forma geral da rota removendo pontos intermediários desnecessários
 */
function simplificarTrajetoria(pontos, toleranciaMetros = 15) {
  if (pontos.length < 3) return pontos;

  // Função auxiliar para calcular distância perpendicular de um ponto a uma linha
  function distanciaPontoLinha(ponto, inicio, fim) {
    const lat = ponto.latitude;
    const lon = ponto.longitude;
    const lat1 = inicio.latitude;
    const lon1 = inicio.longitude;
    const lat2 = fim.latitude;
    const lon2 = fim.longitude;

    // Vetor da linha
    const dx = lat2 - lat1;
    const dy = lon2 - lon1;

    // Comprimento ao quadrado da linha
    const linhaLen2 = dx * dx + dy * dy;

    if (linhaLen2 === 0) {
      // Linha é um ponto
      return calcularDistanciaHaversine(lat, lon, lat1, lon1) * 1000;
    }

    // Projeção do ponto na linha
    const t = Math.max(0, Math.min(1, ((lat - lat1) * dx + (lon - lon1) * dy) / linhaLen2));
    const projLat = lat1 + t * dx;
    const projLon = lon1 + t * dy;

    return calcularDistanciaHaversine(lat, lon, projLat, projLon) * 1000;
  }

  // Algoritmo Douglas-Peucker recursivo
  function douglasPeucker(pontosArr, epsilon) {
    if (pontosArr.length < 3) return pontosArr;

    // Encontrar ponto com maior distância
    let maxDist = 0;
    let maxIndex = 0;

    for (let i = 1; i < pontosArr.length - 1; i++) {
      const dist = distanciaPontoLinha(pontosArr[i], pontosArr[0], pontosArr[pontosArr.length - 1]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }

    // Se a distância máxima é maior que a tolerância, dividir
    if (maxDist > epsilon) {
      const esquerda = douglasPeucker(pontosArr.slice(0, maxIndex + 1), epsilon);
      const direita = douglasPeucker(pontosArr.slice(maxIndex), epsilon);
      return esquerda.slice(0, -1).concat(direita);
    } else {
      // Manter apenas primeiro e último
      return [pontosArr[0], pontosArr[pontosArr.length - 1]];
    }
  }

  const resultado = douglasPeucker(pontos, toleranciaMetros);

  if (resultado.length < pontos.length) {
    console.log(`[PreOSRM] Simplificação Douglas-Peucker: ${pontos.length} -> ${resultado.length} pontos`);
  }

  return resultado;
}

// ==================== MAP-MATCHING OSRM ====================

/**
 * Map-matching usando OSRM com parâmetros otimizados
 * ✅ CORREÇÃO: Usa tracepoints para manter ordem correta dos pontos
 */
async function mapMatchOSRM(pontos, config = CONFIG.osrm) {
  if (pontos.length < 2) return pontos;

  const chunks = [];
  for (let i = 0; i < pontos.length; i += config.maxCoordsPerRequest) {
    chunks.push(pontos.slice(i, i + config.maxCoordsPerRequest));
  }

  let todosOsPontos = [];
  let globalIndex = 0; // Índice global para timestamps únicos

  for (const chunk of chunks) {
    try {
      // Montar coordenadas (lon,lat)
      const coordsString = chunk
        .map(p => `${p.longitude},${p.latitude}`)
        .join(';');

      // Timestamps Unix
      const timestamps = chunk
        .map(p => Math.floor(new Date(p.timestamp).getTime() / 1000))
        .join(';');

      // Radiuses (precisão GPS para cada ponto)
      const radiuses = chunk
        .map(p => {
          const hdop = p.hdop || 2;
          return Math.min(hdop * 5, config.radiusMeters);
        })
        .join(';');

      // URL com parâmetros otimizados
      const url = `${config.url}/${coordsString}?` +
        `timestamps=${timestamps}&` +
        `radiuses=${radiuses}&` +
        `geometries=geojson&` +
        `overview=full&` +
        `annotations=true&` +
        `gaps=ignore`;  // ✅ MUDANÇA: ignore para forçar rota contínua (preenche gaps)

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 30000
      });

      if (!response.ok) {
        throw new Error(`OSRM retornou ${response.status}`);
      }

      const data = await response.json();

      if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
        throw new Error(`OSRM match falhou: ${data.code}`);
      }

      // ✅ USAR GEOMETRIA COMPLETA DA ROTA (segue as ruas, sem linhas retas)
      // Em vez de usar apenas tracepoints, usamos a geometria que o OSRM retorna
      // Isso preenche os gaps entre pontos seguindo a via real

      const chunkStartTime = new Date(chunk[0].timestamp).getTime();
      const chunkEndTime = new Date(chunk[chunk.length - 1].timestamp).getTime();
      const totalTimeMs = Math.max(1, chunkEndTime - chunkStartTime);

      // Extrair todas as coordenadas da geometria de todos os matchings
      let geometryCoords = [];
      for (const matching of data.matchings) {
        if (matching.geometry && matching.geometry.coordinates) {
          geometryCoords = geometryCoords.concat(matching.geometry.coordinates);
        }
      }

      if (geometryCoords.length === 0) {
        throw new Error('OSRM não retornou geometria');
      }

      console.log(`[OSRM] Usando ${geometryCoords.length} pontos da geometria (chunk tinha ${chunk.length} pontos)`);

      // Criar pontos a partir da geometria completa, interpolando velocidade/ignição
      for (let i = 0; i < geometryCoords.length; i++) {
        const [lon, lat] = geometryCoords[i];

        // Calcular progresso (0 a 1) ao longo da geometria
        const progress = i / Math.max(1, geometryCoords.length - 1);

        // Encontrar o ponto original correspondente pelo progresso
        const originalIndex = Math.min(
          Math.floor(progress * (chunk.length - 1)),
          chunk.length - 1
        );
        const pontoOriginal = chunk[originalIndex];

        // Distribuir timestamps uniformemente ao longo da geometria
        const interpolatedTime = chunkStartTime + (progress * totalTimeMs) + globalIndex;
        globalIndex++;

        todosOsPontos.push({
          latitude: lat,
          longitude: lon,
          velocidade: pontoOriginal.velocidade || 0,
          direcao: pontoOriginal.direcao || 0,
          timestamp: new Date(interpolatedTime).toISOString(),
          ignicao: pontoOriginal.ignicao,
          matched: true,
          _index: todosOsPontos.length
        });
      }
    } catch (error) {
      console.warn(`[OSRM] Falha no chunk: ${error.message}`);
      // ✅ MELHORIA: Quando OSRM falha, adicionar apenas primeiro e último ponto
      // Isso evita linhas retas cortando o mapa (melhor que adicionar todos os pontos)
      if (chunk.length > 0) {
        todosOsPontos.push({
          ...chunk[0],
          matched: false,
          _index: todosOsPontos.length
        });
        if (chunk.length > 1) {
          todosOsPontos.push({
            ...chunk[chunk.length - 1],
            matched: false,
            _index: todosOsPontos.length
          });
        }
      }
    }
  }

  return todosOsPontos;
}

// ==================== PIPELINE COMPLETO ====================

/**
 * Pipeline completo de processamento GPS
 *
 * 1. Validação e rejeição de pontos ruins
 * 2. Remoção de saltos impossíveis
 * 3. Filtro Hampel para outliers
 * 4. Média móvel inicial
 * 5. Filtro de Kalman
 * 6. Interpolação com heading/Bezier
 * 7. Map-matching OSRM (opcional)
 */
async function processarRotaCompleta(pontos, opcoes = {}) {
  const {
    usarKalman = true,
    usarMediaMovel = true,
    usarHampel = true,
    usarInterpolacao = true,
    usarOSRM = true,  // ATIVADO: Cola pontos nas ruas reais via OSRM
  } = opcoes;

  console.log(`[Pipeline] Iniciando processamento de ${pontos.length} pontos...`);

  let resultado = pontos;

  // 1. Validação
  resultado = validarPontos(resultado);
  console.log(`[Pipeline] Após validação: ${resultado.length} pontos`);

  if (resultado.length < 2) {
    return { pontos: resultado, stats: { original: pontos.length, final: resultado.length } };
  }

  // 2. Remover saltos impossíveis
  resultado = removerSaltosImposssiveis(resultado);
  console.log(`[Pipeline] Após remover saltos: ${resultado.length} pontos`);

  // 3. Filtro Hampel
  if (usarHampel && resultado.length >= 5) {
    resultado = filtroHampel(resultado);
    console.log(`[Pipeline] Após Hampel: ${resultado.length} pontos`);
  }

  // 4. Média móvel - DESABILITADO por padrão pois pode tirar pontos da rua
  if (usarMediaMovel && CONFIG.movingAverage.enabled && resultado.length >= 3) {
    resultado = mediaMovel(resultado);
    console.log(`[Pipeline] Após média móvel: ${resultado.length} pontos`);
  }

  // 5. Filtro de Kalman
  if (usarKalman && resultado.length >= 2) {
    resultado = aplicarKalman(resultado);
    console.log(`[Pipeline] Após Kalman: ${resultado.length} pontos`);
  }

  const pontosAntesInterp = resultado.length;

  // 6. Interpolação com heading
  if (usarInterpolacao && resultado.length >= 2) {
    resultado = interpolarComHeading(resultado);
    console.log(`[Pipeline] Após interpolação: ${resultado.length} pontos`);
  }

  // 7. Map-matching OSRM (opcional)
  if (usarOSRM && resultado.length >= 2) {
    // 7a. Pré-processamento: remover pontos redundantes e oscilações
    const pontosAntesPreOSRM = resultado.length;
    resultado = removerPontosRedundantes(resultado, 10);  // Min 10m entre pontos
    resultado = removerOscilacoes(resultado, 20);         // Detectar oscilações < 20m
    resultado = simplificarTrajetoria(resultado, 15);     // Douglas-Peucker com 15m tolerância
    console.log(`[Pipeline] Pré-OSRM: ${pontosAntesPreOSRM} -> ${resultado.length} pontos`);

    // 7b. Map-matching OSRM
    resultado = await mapMatchOSRM(resultado);
    console.log(`[Pipeline] Após OSRM: ${resultado.length} pontos`);
  }

  // ✅ 8. VALIDAÇÃO FINAL: Garantir que pontos não se afastaram demais dos originais
  // Se algum ponto processado está muito distante do ponto original mais próximo,
  // significa que houve erro no processamento e devemos usar os dados originais
  const pontosOriginais = pontos;
  const MAX_DESVIO_KM = 5; // Máximo 5km de desvio tolerado

  let pontosComDesvioExcessivo = 0;
  for (const ponto of resultado) {
    // Encontrar ponto original mais próximo pelo timestamp
    let menorDistancia = Infinity;
    for (const original of pontosOriginais) {
      const dist = calcularDistanciaHaversine(
        ponto.latitude, ponto.longitude,
        original.latitude, original.longitude
      );
      if (dist < menorDistancia) {
        menorDistancia = dist;
      }
    }
    if (menorDistancia > MAX_DESVIO_KM) {
      pontosComDesvioExcessivo++;
    }
  }

  // Se mais de 10% dos pontos têm desvio excessivo, algo deu errado - retornar originais
  const taxaDesvio = pontosComDesvioExcessivo / resultado.length;
  if (taxaDesvio > 0.1) {
    console.warn(`[Pipeline] ⚠️ ${(taxaDesvio * 100).toFixed(1)}% dos pontos com desvio > ${MAX_DESVIO_KM}km - retornando dados originais`);
    return {
      pontos: pontosOriginais,
      stats: {
        original: pontos.length,
        aposValidacao: pontosAntesInterp,
        final: pontos.length,
        interpolados: 0,
        erro: 'desvio_excessivo'
      }
    };
  }

  return {
    pontos: resultado,
    stats: {
      original: pontos.length,
      aposValidacao: pontosAntesInterp,
      final: resultado.length,
      interpolados: resultado.length - pontosAntesInterp
    }
  };
}

// ==================== FUNÇÕES AUXILIARES ====================

function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(deg) {
  return deg * Math.PI / 180;
}

function calcularPontoNaDirecao(lat, lon, direcaoRad, distanciaMetros) {
  const R = 6371000;
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;

  const novaLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(distanciaMetros / R) +
    Math.cos(latRad) * Math.sin(distanciaMetros / R) * Math.cos(direcaoRad)
  );

  const novaLonRad = lonRad + Math.atan2(
    Math.sin(direcaoRad) * Math.sin(distanciaMetros / R) * Math.cos(latRad),
    Math.cos(distanciaMetros / R) - Math.sin(latRad) * Math.sin(novaLatRad)
  );

  return {
    lat: novaLatRad * 180 / Math.PI,
    lon: novaLonRad * 180 / Math.PI
  };
}

function bezierCubica(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return mt*mt*mt*p0 + 3*mt*mt*t*p1 + 3*mt*t*t*p2 + t*t*t*p3;
}

function interpolarAngulo(a1, a2, t) {
  a1 = ((a1 % 360) + 360) % 360;
  a2 = ((a2 % 360) + 360) % 360;

  let diff = a2 - a1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  return ((a1 + diff * t) % 360 + 360) % 360;
}

// ==================== EXPORTS ====================

module.exports = {
  KalmanFilter2D,
  validarPontos,
  removerSaltosImposssiveis,
  filtroHampel,
  mediaMovel,
  aplicarKalman,
  interpolarComHeading,
  removerPontosRedundantes,
  removerOscilacoes,
  simplificarTrajetoria,
  mapMatchOSRM,
  processarRotaCompleta,
  CONFIG
};
