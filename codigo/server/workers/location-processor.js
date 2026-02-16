#!/usr/bin/env node
/**
 * Location Processor Worker
 *
 * Consome pacotes de localização do Redis Streams e processa:
 * - Validação de coordenadas
 * - Pipeline GPS (Kalman, Map-Matching)
 * - Detecção de ignição
 * - Processamento de viagens
 * - Salvamento no banco de dados
 *
 * Uso:
 *   WORKER_ID=loc-1 node workers/location-processor.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { redisStreams } = require('../services/redis-streams.service');
const prisma = require('../db/prisma');
const dispositivoService = require('../services/dispositivo.service');
const localizacaoService = require('../services/localizacao.service');
const viagemService = require('../services/viagem.service');
const heartbeatService = require('../services/heartbeat.service');
const obd2Service = require('../services/obd2.service');
const { pipeline: gpsPipeline } = require('../services/gps-pipeline.service');
const redisService = require('../services/redis.service');

// ========== HELPER: Calcular distância entre coordenadas ==========
function calcularDistanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Serviços de alertas (lazy load)
let geofencingService = null;
let velocidadeService = null;

const getGeofencingService = () => {
  if (!geofencingService) {
    try {
      geofencingService = require('../services/geofencing.service');
    } catch (e) {
      // Silenciosamente ignora se não disponível
    }
  }
  return geofencingService;
};

const getVelocidadeService = () => {
  if (!velocidadeService) {
    try {
      velocidadeService = require('../services/velocidade-notificacao.service');
    } catch (e) {
      // Silenciosamente ignora se não disponível
    }
  }
  return velocidadeService;
};

// ============ CONFIGURAÇÃO ============
const WORKER_ID = process.env.WORKER_ID || `loc-${process.pid}`;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 10;
const BLOCK_TIME = parseInt(process.env.BLOCK_TIME) || 5000;
const PROCESS_INTERVAL = parseInt(process.env.PROCESS_INTERVAL) || 100;

// ============ ESTADO ============
const stats = {
  processed: 0,
  errors: 0,
  startTime: Date.now()
};

// ============ COORDENADAS DE FÁBRICA (Shenzhen) ============
const FACTORY_COORDINATES = {
  shenzhen: { lat: 22.697629, lon: 113.782373, tolerance: 0.1 },
  shenzhen2: { lat: 22.5431, lon: 114.0579, tolerance: 0.1 }
};

function isFactoryCoordinates(lat, lon) {
  if (lat == null || lon == null) return false;

  for (const coords of Object.values(FACTORY_COORDINATES)) {
    const latDiff = Math.abs(lat - coords.lat);
    const lonDiff = Math.abs(lon - coords.lon);
    if (latDiff <= coords.tolerance && lonDiff <= coords.tolerance) {
      return true;
    }
  }
  return false;
}

// ============ AUTO-RESET DO KALMAN ============
// Contador de rejeições consecutivas por IMEI
// Se muitos pontos são rejeitados, o Kalman pode estar travado
const rejectionCounter = new Map(); // imei -> { count, lastCoords }
const REJECTION_THRESHOLD = 5; // Após 5 rejeições consecutivas, resetar Kalman

function incrementRejectionCounter(imei, lat, lon, satellites, velocidade, distanciaKm) {
  const current = rejectionCounter.get(imei) || { count: 0, lastCoords: null };
  current.count++;
  current.lastCoords = { lat, lon };
  rejectionCounter.set(imei, current);

  // Se atingiu o limite, verificar se deve resetar Kalman
  if (current.count >= REJECTION_THRESHOLD) {
    // ⚠️ REGRAS RIGOROSAS para aceitar ponto após múltiplas rejeições:
    // 1. Saltos > 5km NUNCA são aceitos (impossível mesmo em alta velocidade)
    // 2. Saltos > 1km com velocidade 0 NUNCA são aceitos (drift de GPS)
    // 3. Saltos > 2km com poucos satélites (<10) NÃO são aceitos

    const isHugeSalt = distanciaKm > 5; // Salto absurdo - NUNCA aceitar
    const isDriftWithZeroSpeed = (distanciaKm > 1) && (velocidade === 0); // Drift com carro parado
    const isLowQualityJump = (distanciaKm > 2) && (satellites < 10); // Salto grande com poucos satélites

    if (isHugeSalt) {
      console.warn(`[${WORKER_ID}] ⚠️ ${imei}: ${current.count} rejeições - salto ABSURDO de ${distanciaKm.toFixed(1)}km - NUNCA aceitar`);
      rejectionCounter.delete(imei);
      return false;
    }

    if (isDriftWithZeroSpeed) {
      console.warn(`[${WORKER_ID}] ⚠️ ${imei}: ${current.count} rejeições - drift de ${distanciaKm.toFixed(1)}km com vel=0 - NÃO aceitar`);
      rejectionCounter.delete(imei);
      return false;
    }

    if (isLowQualityJump) {
      console.warn(`[${WORKER_ID}] ⚠️ ${imei}: ${current.count} rejeições - salto ${distanciaKm.toFixed(1)}km com apenas ${satellites} satélites - NÃO aceitar`);
      rejectionCounter.delete(imei);
      return false;
    }

    console.log(`[${WORKER_ID}] 🔄 ${imei}: ${current.count} rejeições consecutivas - RESETANDO KALMAN (${distanciaKm.toFixed(1)}km, sat=${satellites}, vel=${velocidade})`);
    gpsPipeline.resetKalman(imei);
    rejectionCounter.delete(imei);
    return true; // Indica que deve aceitar o ponto atual
  }
  return false;
}

function resetRejectionCounter(imei) {
  rejectionCounter.delete(imei);
}

// ============ DETECÇÃO DE IGNIÇÃO ============

// Cache para fallback de ignição por voltagem
// Rastreia quando detectamos ACC=ON com tensão baixa (possível instalação errada)
const ignitionFallbackCache = new Map(); // imei -> timestamp

// Limpar caches antigos periodicamente (evitar memory leak)
setInterval(() => {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutos
  for (const [imei, timestamp] of ignitionFallbackCache.entries()) {
    if (now - timestamp > maxAge) {
      ignitionFallbackCache.delete(imei);
    }
  }
  // Limpar contadores de rejeição antigos também
  for (const [imei, data] of rejectionCounter.entries()) {
    if (data.count > 0 && data.count < REJECTION_THRESHOLD) {
      // Se não atingiu o threshold em 5 min, limpar
      rejectionCounter.delete(imei);
    }
  }
}, 60000);

function detectarEstadoIgnicao(acc, tensao, velocidade, dispositivo, imei) {
  // Debug log para rastrear lógica de ignição
  if (dispositivo?.usa_ignicao_virtual || dispositivo?.conexao_pos_chave) {
    console.log(`[Ignição] ${imei}: acc=${acc}, tensao=${tensao}V, vel=${velocidade}, virtual=${dispositivo?.usa_ignicao_virtual}, posChave=${dispositivo?.conexao_pos_chave}, limiteOn=${dispositivo?.tensao_motor_ligado}V, limiteOff=${dispositivo?.tensao_motor_deslig}V`);
  }

  // ✅ PRIORIDADE 1: Se está em movimento, ignição DEVE estar ligada
  // Independente de ACC ou tensão - velocidade é prova definitiva de motor ligado
  if (velocidade > 5) {
    ignitionFallbackCache.delete(imei); // Limpar cache - está claramente ligado
    return 'moving';
  }

  // Ignição virtual por tensão
  if (dispositivo?.usa_ignicao_virtual && tensao != null && tensao > 0) {
    const limiteOn = dispositivo.tensao_motor_ligado || 13.8;
    const limiteOff = dispositivo.tensao_motor_deslig || 12.6;

    ignitionFallbackCache.delete(imei); // Não usar fallback quando virtual está ativo
    if (tensao >= limiteOn) {
      return velocidade > 0 ? 'moving' : 'idle';
    } else if (tensao < limiteOff) {
      return 'off';
    }
    return 'off';
  }

  // Híbrido pós-chave + tensão
  // ✅ Usa valores configurados no dispositivo, com fallback para valores padrão
  if (dispositivo?.conexao_pos_chave && tensao != null && tensao > 0) {
    const thresholdOn = dispositivo.tensao_motor_ligado || 13.5;  // Padrão: 13.5V = motor ligado
    const thresholdOff = dispositivo.tensao_motor_deslig || 12.5; // Padrão: 12.5V = motor desligado
    ignitionFallbackCache.delete(imei); // Não usar fallback quando híbrido está ativo

    if (tensao >= thresholdOn) {
      // Tensão alta = motor ligado
      return velocidade > 0 ? 'moving' : 'idle';
    } else if (tensao < thresholdOff) {
      // Tensão baixa = motor desligado
      return 'off';
    }
    // Tensão intermediária - considerar desligado para evitar falsos positivos
    return 'off';
  }

  // ACC tradicional com FALLBACK por voltagem
  if (acc === true) {
    // ✅ FALLBACK: Se ACC=ON mas tensão < 13V por 30+ segundos, considera desligado
    // Isso corrige instalações onde o fio ACC está em linha permanente
    if (tensao != null && tensao > 0 && tensao < 13.0) {
      const now = Date.now();
      const fallbackStart = ignitionFallbackCache.get(imei);

      if (!fallbackStart) {
        // Primeira vez detectando ACC=ON com tensão baixa
        ignitionFallbackCache.set(imei, now);
        console.log(`[Ignição] ${imei}: ACC=ON mas tensão=${tensao}V < 13V - iniciando fallback`);
        return velocidade > 0 ? 'moving' : 'idle'; // Ainda dá 30s de tolerância
      }

      const elapsed = now - fallbackStart;
      if (elapsed > 30000) {
        // Condição persistiu por 30s - considera motor desligado
        console.log(`[Ignição] ${imei}: Fallback ativo - ACC=ON mas tensão=${tensao}V por ${Math.round(elapsed/1000)}s -> OFF`);
        return 'off';
      }

      // Ainda dentro dos 30s de tolerância
      return velocidade > 0 ? 'moving' : 'idle';
    }

    // Tensão >= 13V ou não disponível - limpar cache e usar ACC normalmente
    ignitionFallbackCache.delete(imei);
    return velocidade > 0 ? 'moving' : 'idle';
  }

  // ACC=OFF - limpar cache e retornar desligado
  ignitionFallbackCache.delete(imei);
  return 'off';
}

// ============ PROCESSAMENTO ============

async function processLocationMessage(message) {
  // Ignorar mensagens de inicialização do stream (não são dados reais)
  if (message.init || !message.imei || !message.data) {
    return;
  }

  const { imei, data, gateway_id } = message;

  try {
    const locationData = typeof data === 'string' ? JSON.parse(data) : data;

    // Validar coordenadas
    if (locationData.latitude == null || locationData.longitude == null) {
      console.warn(`[${WORKER_ID}] ${imei}: Coordenadas inválidas`);
      return;
    }

    // Detectar coordenadas de fábrica
    if (isFactoryCoordinates(locationData.latitude, locationData.longitude)) {
      console.warn(`[${WORKER_ID}] ${imei}: Coordenadas de fábrica (GPS sem fix)`);
      await dispositivoService.upsert(imei, {
        status: 'online',
        gps_status: 'NO_FIX_FACTORY'
      });
      return;
    }

    // Validar região (Brasil)
    const foraDoBrasil = locationData.latitude < -34 || locationData.latitude > 6 ||
                         locationData.longitude < -74 || locationData.longitude > -32;
    if (foraDoBrasil && locationData.latitude !== 0) {
      console.warn(`[${WORKER_ID}] ${imei}: Coordenadas fora do Brasil`);
      await dispositivoService.upsert(imei, {
        status: 'online',
        gps_status: 'INVALID_REGION'
      });
      return;
    }

    // Clamping de coordenadas
    locationData.latitude = Math.max(-90, Math.min(90, locationData.latitude));
    locationData.longitude = Math.max(-180, Math.min(180, locationData.longitude));

    // Registrar heartbeat
    await heartbeatService.register(imei);

    // Buscar dispositivo
    const dispositivo = await dispositivoService.getByImei(imei);

    // ========== FILTRO DE SALTOS GPS (Outlier Detection) ==========
    // Rejeita pontos que pulam distâncias impossíveis (LBS errado, GPS bugado)
    try {
      // ✅ CORREÇÃO: Usar getCurrent em vez de getLastLocation (que não existia!)
      const ultimaLoc = await localizacaoService.getCurrent(imei);
      if (ultimaLoc) {
        const distanciaKm = calcularDistanciaKm(
          ultimaLoc.latitude, ultimaLoc.longitude,
          locationData.latitude, locationData.longitude
        );

        const tempoSegundos = (new Date(locationData.timestamp) - new Date(ultimaLoc.timestamp)) / 1000;
        // ✅ CORREÇÃO: Usar valor absoluto do tempo para pontos de buffer (timestamp antigo)
        const tempoAbsoluto = Math.abs(tempoSegundos);
        const velocidadeAtual = locationData.velocidade || 0;
        const velocidadeAnterior = ultimaLoc.velocidade || 0;

        // Usar a MAIOR velocidade entre atual e anterior (com margem de 50%)
        // Isso cobre aceleração/frenagem entre os pontos
        const velocidadeReferencia = Math.max(velocidadeAtual, velocidadeAnterior);

        // RIGOROSO para parado: máximo 100m absoluto
        // Em movimento: velocidade real + 50% de margem (max 200km/h)
        let limiteKm;
        if (velocidadeReferencia === 0) {
          // Parado: limite ABSOLUTO de 100m (0.1km), independente do tempo
          // GPS drift normal é < 50m, qualquer coisa > 100m é dado ruim
          limiteKm = 0.1;
        } else {
          // Em movimento: baseado na velocidade real
          const velocidadeMaxKmh = Math.min(velocidadeReferencia * 1.5, 200);
          // ✅ CORREÇÃO: Usar tempoAbsoluto para evitar limites negativos/errados
          const distanciaMaxKm = (velocidadeMaxKmh / 3600) * Math.max(tempoAbsoluto, 1);
          // Mínimo de 300m em movimento (para GPS drift durante frenagem)
          limiteKm = Math.max(distanciaMaxKm, 0.3);
        }

        if (distanciaKm > limiteKm) {
          // Incrementar contador de rejeições - pode resetar Kalman se muitas rejeições
          const satellites = locationData.satellites || 0;
          const shouldAccept = incrementRejectionCounter(imei, locationData.latitude, locationData.longitude, satellites, velocidadeAtual, distanciaKm);

          if (shouldAccept) {
            // Kalman foi resetado, aceitar este ponto
            console.log(`[${WORKER_ID}] ✅ ${imei}: Ponto aceito após reset do Kalman (${distanciaKm.toFixed(1)}km, sat=${satellites})`);
          } else {
            console.warn(`[${WORKER_ID}] ⚠️ ${imei}: SALTO GPS REJEITADO - ${distanciaKm.toFixed(1)}km em ${tempoAbsoluto.toFixed(0)}s @ ${velocidadeAtual}km/h (velRef=${velocidadeReferencia}, max: ${limiteKm.toFixed(2)}km)`);
            await dispositivoService.upsert(imei, {
              status: 'online',
              gps_status: 'GPS_JUMP_REJECTED'
            });
            return; // Rejeita este ponto
          }
        } else {
          // Ponto aceito normalmente - resetar contador de rejeições
          resetRejectionCounter(imei);
        }
      }
    } catch (e) {
      // ✅ CORREÇÃO: Logar erros do filtro - não silenciar
      console.warn(`[${WORKER_ID}] ⚠️ ${imei}: Erro no filtro de saltos: ${e.message}`);
    }

    // Pipeline GPS (Kalman, Map-Matching)
    try {
      const corrigido = await gpsPipeline.processar({
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        velocidade: locationData.velocidade || 0,
        direcao: locationData.direcao || 0,
        hdop: locationData.hdop || 2,
        timestamp: locationData.timestamp || new Date()
      }, imei);

      if (corrigido.lat && corrigido.lon) {
        locationData.latitude_original = locationData.latitude;
        locationData.longitude_original = locationData.longitude;
        locationData.latitude = corrigido.lat;
        locationData.longitude = corrigido.lon;
        locationData.correcao_gps_metros = corrigido.correcao_total_metros || 0;
      }
    } catch (e) {
      // Continuar com coordenadas originais
    }

    // Detectar ignição (com fallback por voltagem para instalações com ACC errado)
    // ⚠️ Para XT40_OBD2: NÃO usar detecção de ignição dos location packets
    // A tensão e ACC dos location packets são INCORRETOS para XT40_OBD2
    // O estado_ignicao correto vem APENAS do obd2Service.create()
    const isOBD2Device = dispositivo?.tipo === 'XT40_OBD2';

    let estadoIgnicao = null;
    if (!isOBD2Device) {
      estadoIgnicao = detectarEstadoIgnicao(
        locationData.ignicao,
        locationData.tensao_principal,
        locationData.velocidade,
        dispositivo,
        imei
      );
      locationData.estado_ignicao = estadoIgnicao;
      const ignicaoBoolean = ['acc_on', 'idle', 'moving'].includes(estadoIgnicao);
      locationData.ignicao = ignicaoBoolean;
      console.log(`[${WORKER_ID}] 🔧 ${imei}: detectarEstadoIgnicao retornou '${estadoIgnicao}' → ignicao=${ignicaoBoolean}`);
    } else {
      // XT40_OBD2: usar velocidade como fallback para estado de ignição
      // Se o pacote tem tensao_principal, o obd2Service.create() vai cuidar do estado
      // Senão, usamos a velocidade como indicador de ignição
      const velocidade = locationData.velocidade || 0;

      if (velocidade > 3) {
        estadoIgnicao = 'moving';
        locationData.estado_ignicao = estadoIgnicao;
        locationData.ignicao = true; // ✅ Setar ignicao para viagem ser processada
        console.log(`[${WORKER_ID}] 🚗 ${imei}: XT40_OBD2 - velocidade ${velocidade}km/h → ${estadoIgnicao}`);
      } else {
        // XT40_OBD2 sem dados OBD2 reais: velocidade = 0 significa OFF
        // Não temos como saber se motor está ligado sem dados OBD2
        estadoIgnicao = 'off';
        locationData.estado_ignicao = estadoIgnicao;
        locationData.ignicao = false; // ✅ Setar ignicao para viagem ser processada
        console.log(`[${WORKER_ID}] ⏹️ ${imei}: XT40_OBD2 - velocidade ${velocidade}km/h → ${estadoIgnicao}`);
      }
    }

    // Filtrar pacotes Static
    if (locationData.location_source_type === 0x02) {
      console.log(`[${WORKER_ID}] ${imei}: Pacote Static (veículo parado)`);
    }

    // ✅ CORREÇÃO DE TIMESTAMP: Detectar e corrigir timestamps atrasados ANTES de publicar
    let timestampCorrigido = locationData.timestamp ? new Date(locationData.timestamp) : new Date();
    const agora = new Date();
    const diffMinutos = (agora.getTime() - timestampCorrigido.getTime()) / (1000 * 60);

    if (diffMinutos > 5) {
      // Timestamp do GPS está mais de 5 minutos no passado - usar hora do servidor
      console.log(`[${WORKER_ID}] ⚠️ ${imei}: Timestamp GPS atrasado ${diffMinutos.toFixed(1)}min - corrigindo para hora do servidor`);
      timestampCorrigido = agora;
    } else if (diffMinutos < -5) {
      // Timestamp do GPS está no futuro - usar hora do servidor
      console.log(`[${WORKER_ID}] ⚠️ ${imei}: Timestamp GPS no futuro ${Math.abs(diffMinutos).toFixed(1)}min - corrigindo para hora do servidor`);
      timestampCorrigido = agora;
    }

    // Atualizar dispositivo
    const updateData = {
      status: 'online',
      gps_status: 'OK'
    };
    // Atualizar estado_ignicao se temos um valor válido
    // Para XT40_OBD2: usa velocidade como fallback (calculado acima)
    // Para outros: usa detecção por tensão/ACC
    if (estadoIgnicao) {
      updateData.estado_ignicao = estadoIgnicao;
    }
    await dispositivoService.upsert(imei, updateData);

    // Salvar localização com timestamp corrigido
    // ✅ CORREÇÃO: Verificar se create() retornou null (ponto rejeitado pelo filtro)
    const localizacaoSalva = await localizacaoService.create(imei, {
      ...locationData,
      timestamp: timestampCorrigido
    });

    // Se o ponto foi rejeitado pelo filtro interno, não continuar processamento
    if (!localizacaoSalva) {
      console.log(`[${WORKER_ID}] ⏭️ ${imei}: Ponto rejeitado pelo filtro do localizacaoService`);
      return;
    }

    // ✅ Publicar no Redis Pub/Sub para notificar API Server (WebSocket)
    // IMPORTANTE: Usar timestamp CORRIGIDO para o frontend mostrar hora correta
    try {
      const pubResult = await redisService.publish('location:update', JSON.stringify({
        imei,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        velocidade: locationData.velocidade || 0,
        direcao: locationData.direcao || 0,
        estado_ignicao: estadoIgnicao,
        ignicao: locationData.ignicao,
        timestamp: timestampCorrigido.toISOString()
      }));
      if (pubResult) {
        console.log(`[${WORKER_ID}] 📡 PubSub: ${imei} @ ${locationData.velocidade || 0}km/h`);
      } else {
        console.warn(`[${WORKER_ID}] Pub/Sub: publish retornou false para ${imei}`);
      }
    } catch (pubErr) {
      // Não falhar se publish falhar
      console.warn(`[${WORKER_ID}] Pub/Sub error: ${pubErr.message}`);
    }

    // Incrementar contador horário de localizações
    heartbeatService.incrementLocations();

    // Processar viagem com timestamp corrigido
    if (locationData.ignicao !== undefined || locationData.tensao_principal !== undefined) {
      const resultadoViagem = await viagemService.processarLocalizacao(
        imei,
        locationData.ignicao,
        locationData.latitude,
        locationData.longitude,
        locationData.velocidade || 0,
        timestampCorrigido,
        locationData.tensao_principal
      );

      if (resultadoViagem) {
        console.log(`[${WORKER_ID}] ${imei}: ${resultadoViagem.evento}`);
      }
    }

    // Se pacote tem dados OBD2 extras (0x22) ou tensão principal (para ignição virtual)
    // ✅ Para XT40_OBD2: SEMPRE chamar obd2Service para atualizar estado_ignicao
    if (locationData.odometro_embarcado !== undefined ||
        locationData.hora_motor_embarcada !== undefined ||
        locationData.tensao_principal !== undefined ||
        isOBD2Device) {
      await obd2Service.create(imei, locationData);
    }

    // Verificar geofencing (cercas virtuais)
    const geoService = getGeofencingService();
    if (geoService) {
      geoService.verificarPosicao(
        imei,
        locationData.latitude,
        locationData.longitude,
        locationData.velocidade || 0,
        locationData.timestamp ? new Date(locationData.timestamp) : new Date()
      ).catch(err => {
        console.warn(`[${WORKER_ID}] Erro geofencing: ${err.message}`);
      });
    }

    // Verificar excesso de velocidade
    const velService = getVelocidadeService();
    if (velService && locationData.velocidade > 0) {
      velService.verificar(
        imei,
        locationData.latitude,
        locationData.longitude,
        locationData.velocidade
      ).catch(err => {
        console.warn(`[${WORKER_ID}] Erro velocidade: ${err.message}`);
      });
    }

    stats.processed++;
    console.log(`[${WORKER_ID}] ✅ ${imei}: (${locationData.latitude.toFixed(5)}, ${locationData.longitude.toFixed(5)}) @ ${locationData.velocidade || 0} km/h`);

  } catch (error) {
    stats.errors++;
    console.error(`[${WORKER_ID}] ❌ ${imei}: ${error.message}`);
    throw error;
  }
}

// ============ LOOP PRINCIPAL ============

let running = true;

async function processLoop() {
  while (running) {
    try {
      // Processar mensagens pendentes primeiro
      await redisStreams.processPending(
        'gps:packets:location',
        'location-processors',
        processLocationMessage,
        5
      );

      // Processar novas mensagens
      await redisStreams.consumeLocation(
        processLocationMessage,
        BATCH_SIZE,
        BLOCK_TIME
      );

    } catch (error) {
      console.error(`[${WORKER_ID}] Erro no loop:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await new Promise(resolve => setTimeout(resolve, PROCESS_INTERVAL));
  }
}

// ============ INICIALIZAÇÃO ============

async function start() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📍 LOCATION PROCESSOR - ${WORKER_ID}`);
  console.log(`${'='.repeat(60)}\n`);

  // Conectar Redis Streams (para consumir pacotes)
  const connected = await redisStreams.connect();
  if (!connected) {
    console.error('❌ Falha ao conectar Redis');
    process.exit(1);
  }

  // Conectar Redis Service (para Pub/Sub de atualizações em tempo real)
  await redisService.connect();
  if (redisService.isAvailable()) {
    console.log('✅ Redis Pub/Sub conectado');
  } else {
    console.warn('⚠️ Redis Pub/Sub não disponível - atualizações em tempo real desabilitadas');
  }

  // Testar banco
  try {
    await prisma.$connect();
    console.log('✅ Banco de dados conectado');
  } catch (error) {
    console.error('❌ Falha ao conectar banco:', error.message);
    process.exit(1);
  }

  console.log(`✅ Worker ${WORKER_ID} iniciado`);
  console.log(`📊 Batch: ${BATCH_SIZE} | Block: ${BLOCK_TIME}ms\n`);

  // Estatísticas periódicas
  setInterval(() => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000);
    console.log(`[${WORKER_ID}] 📊 Processados: ${stats.processed} | Erros: ${stats.errors} | Uptime: ${uptime}s`);
  }, 60000);

  // Iniciar loop de processamento
  processLoop();
}

// ============ SHUTDOWN ============

async function shutdown(signal) {
  console.log(`\n🛑 [${signal}] Encerrando worker ${WORKER_ID}...`);
  running = false;

  // Aguardar processamento em andamento
  await new Promise(resolve => setTimeout(resolve, 1000));

  await redisStreams.disconnect();
  await prisma.$disconnect();

  console.log(`✅ Worker ${WORKER_ID} encerrado`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============ START ============
start().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
