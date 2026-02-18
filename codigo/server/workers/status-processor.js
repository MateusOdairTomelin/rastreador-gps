#!/usr/bin/env node
/**
 * Status Processor Worker
 *
 * Consome pacotes de status/heartbeat e OBD2 do Redis Streams:
 * - Atualiza status online/offline
 * - Processa heartbeats
 * - Detecta ignição por tensão
 * - Salva dados OBD2
 *
 * Uso:
 *   WORKER_ID=status-1 node workers/status-processor.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { redisStreams } = require('../services/redis-streams.service');
const prisma = require('../db/prisma');
const dispositivoService = require('../services/dispositivo.service');
const heartbeatService = require('../services/heartbeat.service');
const obd2Service = require('../services/obd2.service');
const redisService = require('../services/redis.service');
const localizacaoService = require('../services/localizacao.service');

// ============ CONFIGURAÇÃO ============
const WORKER_ID = process.env.WORKER_ID || `status-${process.pid}`;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 20;
const BLOCK_TIME = parseInt(process.env.BLOCK_TIME) || 5000;

// ============ ESTADO ============
const stats = {
  statusProcessed: 0,
  obd2Processed: 0,
  errors: 0,
  startTime: Date.now()
};

// ============ FALLBACK DE IGNIÇÃO POR VOLTAGEM ============
// Cache para rastrear quando ACC=ON com tensão baixa (instalação errada)
const ignitionFallbackCache = new Map(); // imei -> timestamp

// Limpar cache antigo periodicamente (evitar memory leak)
setInterval(() => {
  const now = Date.now();
  const maxAge = 5 * 60 * 1000; // 5 minutos
  for (const [imei, timestamp] of ignitionFallbackCache.entries()) {
    if (now - timestamp > maxAge) {
      ignitionFallbackCache.delete(imei);
    }
  }
}, 60000);

// ============ PROCESSAMENTO DE STATUS ============

async function processStatusMessage(message) {
  // Ignorar mensagens de inicialização do stream
  if (message.init || !message.imei || !message.data) {
    return;
  }

  const { imei, data } = message;

  try {
    const statusData = typeof data === 'string' ? JSON.parse(data) : data;

    // Registrar heartbeat
    await heartbeatService.register(imei);

    // Atualizar status
    const updateData = { status: 'online' };

    // Buscar configuração do dispositivo para ignição virtual
    const dispositivo = await dispositivoService.getByImei(imei);

    // Detectar ignição por tensão (com fallback para instalações com ACC errado)
    let estadoIgnicao = null;
    if (statusData.tensao_bateria != null || statusData.ignicao != null) {
      const tensao = statusData.tensao_bateria;
      const acc = statusData.ignicao;

      // DEBUG: Ver dados recebidos
      if (imei === '356354871416435') {
        console.log(`[DEBUG] ${imei}: ACC=${acc}, tensao=${tensao}, tipo=${dispositivo?.tipo}, usaVirtual=${dispositivo?.usa_ignicao_virtual}`);
      }

      // ⚠️ IMPORTANTE: Para XT40_OBD2 e XT40_4F, a tensão do status packet (tensao_bateria) é INCORRETA
      // O sensor interno reporta ~15V mesmo com motor desligado
      // Apenas os dados do pacote 0x22 (tensao_principal) são confiáveis
      // Portanto, NÃO usar ignição baseada em tensão de STATUS para estes dispositivos
      const isOBD2Device = dispositivo?.tipo === 'XT40_OBD2';
      const isXT40_4F = dispositivo?.tipo === 'XT40_4F';

      if (isOBD2Device || isXT40_4F) {
        // Para XT40_OBD2 e XT40_4F: NÃO atualizar estado_ignicao via status packets
        // A tensão do status packet é a tensão INTERNA do rastreador (~15V), não do veículo
        // O estado correto vem APENAS dos pacotes de localização (0x22) com tensao_principal real
        console.log(`[${WORKER_ID}] ⚠️ ${imei}: ${dispositivo?.tipo} - ignorando status packet para ignição (tensão=${tensao}V é interna, não confiável)`);
        estadoIgnicao = null; // Não atualizar
      }
      // ✅ PRIORIDADE 1: Se usa_ignicao_virtual está ativo, ignorar ACC e usar apenas tensão
      else if (dispositivo?.usa_ignicao_virtual && tensao != null && tensao > 0) {
        const limiteOn = dispositivo.tensao_motor_ligado || 13.2;
        const limiteOff = dispositivo.tensao_motor_deslig || 12.9;

        if (tensao >= limiteOn) {
          estadoIgnicao = 'idle'; // Motor ligado
          console.log(`[${WORKER_ID}] 🔑 ${imei}: Ignição VIRTUAL - tensão ${tensao.toFixed(2)}V >= ${limiteOn}V -> IDLE`);
        } else if (tensao < limiteOff) {
          estadoIgnicao = 'off'; // Motor desligado
          console.log(`[${WORKER_ID}] 🔑 ${imei}: Ignição VIRTUAL - tensão ${tensao.toFixed(2)}V < ${limiteOff}V -> OFF`);
        } else {
          // Zona de histerese - manter estado anterior ou usar 'acc_on'
          estadoIgnicao = 'acc_on';
        }
        ignitionFallbackCache.delete(imei); // Não precisa de fallback quando usa virtual
      }
      // ✅ PRIORIDADE 2: Lógica padrão com fallback
      else if (!acc) {
        // ACC=OFF - limpar cache e considerar desligado
        ignitionFallbackCache.delete(imei);
        estadoIgnicao = 'off';
      } else if (tensao && tensao >= 13.0) {
        // ACC=ON e tensão >= 13V - motor ligado (alternador funcionando)
        ignitionFallbackCache.delete(imei);
        estadoIgnicao = 'idle';
      } else if (acc && tensao && tensao < 13.0) {
        // ACC=ON mas tensão < 13V - possível instalação errada do fio ACC
        const now = Date.now();
        const fallbackStart = ignitionFallbackCache.get(imei);

        if (!fallbackStart) {
          // Primeira vez detectando ACC=ON com tensão baixa
          ignitionFallbackCache.set(imei, now);
          console.log(`[${WORKER_ID}] ⚠️ ${imei}: ACC=ON mas tensão=${tensao?.toFixed(1)}V < 13V - iniciando fallback`);
          estadoIgnicao = 'idle'; // Ainda dá 30s de tolerância
        } else {
          const elapsed = now - fallbackStart;
          if (elapsed > 30000) {
            // Condição persistiu por 30s - considera motor desligado
            console.log(`[${WORKER_ID}] 🔋 ${imei}: Fallback ativo - ACC=ON mas tensão=${tensao?.toFixed(1)}V por ${Math.round(elapsed/1000)}s -> OFF`);
            estadoIgnicao = 'off';
          } else {
            // Ainda dentro dos 30s de tolerância
            estadoIgnicao = 'idle';
          }
        }
      } else if (acc) {
        // ACC=ON sem tensão disponível - confiar no ACC
        estadoIgnicao = 'idle';
      } else {
        estadoIgnicao = 'off';
      }

      // Só atualizar estado_ignicao se tiver um valor válido (não null)
      if (estadoIgnicao) {
        updateData.estado_ignicao = estadoIgnicao;
      }
    }

    await dispositivoService.upsert(imei, updateData);

    // ✅ CORREÇÃO: Criar registro de localização para mudanças de status
    // Isso permite que o histórico de localizações mostre todos os status (off, idle, etc)
    if (estadoIgnicao) {
      await createStatusLocationRecord(imei, estadoIgnicao, statusData);
    }

    stats.statusProcessed++;
    console.log(`[${WORKER_ID}] 💓 ${imei}: Status atualizado (${estadoIgnicao || 'sem ignição'})`);

  } catch (error) {
    stats.errors++;
    console.error(`[${WORKER_ID}] ❌ Status ${imei}:`, error.message);
    throw error;
  }
}

/**
 * Cria um registro de localização baseado no status (para mostrar no histórico)
 * Usa a última coordenada conhecida do dispositivo
 */
async function createStatusLocationRecord(imei, estadoIgnicao, statusData) {
  try {
    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) return;

    // Tentar buscar última posição do cache Redis primeiro
    let lastPosition = await redisService.getPosition(imei);

    // Se não houver no cache, buscar do banco
    if (!lastPosition) {
      lastPosition = await prisma.localizacao.findFirst({
        where: { dispositivo_id: dispositivo.id },
        orderBy: { timestamp: 'desc' }
      });
    }

    // Se não houver posição anterior, não podemos criar o registro
    if (!lastPosition || !lastPosition.latitude || !lastPosition.longitude) {
      return;
    }

    // Verificar se já existe um registro recente com mesmo status (evitar duplicatas)
    const recentRecord = await prisma.localizacao.findFirst({
      where: {
        dispositivo_id: dispositivo.id,
        estado_ignicao: estadoIgnicao,
        timestamp: { gte: new Date(Date.now() - 60000) } // Último minuto
      },
      orderBy: { timestamp: 'desc' }
    });

    if (recentRecord) {
      // Já existe um registro recente com mesmo status, não duplicar
      return;
    }

    // ✅ CORREÇÃO: Usar localizacaoService.create() para aplicar filtros de GPS
    // Isso evita salvar localizações com coordenadas ruins vindas do cache
    const newLocation = await localizacaoService.create(imei, {
      latitude: lastPosition.latitude,
      longitude: lastPosition.longitude,
      altitude: lastPosition.altitude || null,
      velocidade: 0, // Status geralmente significa parado
      direcao: lastPosition.direcao || 0,
      precisao: lastPosition.precisao || null,
      ignicao: estadoIgnicao !== 'off',
      estado_ignicao: estadoIgnicao,
      timestamp: new Date()
    });

    if (newLocation) {
      console.log(`[${WORKER_ID}] 📍 ${imei}: Localização de status criada (${estadoIgnicao})`);
    } else {
      console.log(`[${WORKER_ID}] ⚠️ ${imei}: Localização de status rejeitada pelo filtro GPS`);
    }

  } catch (error) {
    console.error(`[${WORKER_ID}] ⚠️ Erro ao criar localização de status para ${imei}:`, error.message);
    // Não propagar erro - é uma funcionalidade adicional
  }
}

// ============ PROCESSAMENTO DE OBD2 ============

async function processOBD2Message(message) {
  const { imei, data } = message;

  try {
    const obd2Data = typeof data === 'string' ? JSON.parse(data) : data;

    // Registrar heartbeat
    await heartbeatService.register(imei);

    // Validar dados OBD2
    if (obd2Data.rpm == null && obd2Data.temperatura_motor == null) {
      console.log(`[${WORKER_ID}] ⚠️ ${imei}: Dados OBD2 inválidos`);
      return;
    }

    // Detectar ignição
    let estadoIgnicao;
    const acc = obd2Data.ignicao ?? false;
    const rpm = obd2Data.rpm ?? null;

    if (!acc) {
      estadoIgnicao = 'off';
    } else if (rpm == null || rpm < 500) {
      estadoIgnicao = 'acc_on';
    } else {
      estadoIgnicao = 'idle';
    }

    // Atualizar dispositivo
    await dispositivoService.upsert(imei, {
      status: 'online',
      estado_ignicao: estadoIgnicao
    });

    // Salvar OBD2
    await obd2Service.create(imei, obd2Data);

    stats.obd2Processed++;
    console.log(`[${WORKER_ID}] 🔧 ${imei}: OBD2 salvo (RPM: ${rpm || 'N/A'})`);

  } catch (error) {
    stats.errors++;
    console.error(`[${WORKER_ID}] ❌ OBD2 ${imei}:`, error.message);
    throw error;
  }
}

// ============ LOOP PRINCIPAL ============

let running = true;

async function processLoop() {
  while (running) {
    try {
      // Processar status
      await redisStreams.consumeStatus(processStatusMessage, BATCH_SIZE, BLOCK_TIME);

      // Processar OBD2
      await redisStreams.consumeOBD2(processOBD2Message, 10, 1000);

    } catch (error) {
      console.error(`[${WORKER_ID}] Erro no loop:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// ============ INICIALIZAÇÃO ============

async function start() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`💓 STATUS PROCESSOR - ${WORKER_ID}`);
  console.log(`${'='.repeat(60)}\n`);

  // Conectar Redis
  const connected = await redisStreams.connect();
  if (!connected) {
    console.error('❌ Falha ao conectar Redis');
    process.exit(1);
  }

  // Testar banco
  try {
    await prisma.$connect();
    console.log('✅ Banco de dados conectado');
  } catch (error) {
    console.error('❌ Falha ao conectar banco:', error.message);
    process.exit(1);
  }

  console.log(`✅ Worker ${WORKER_ID} iniciado\n`);

  // Estatísticas periódicas
  setInterval(() => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000);
    console.log(`[${WORKER_ID}] 📊 Status: ${stats.statusProcessed} | OBD2: ${stats.obd2Processed} | Erros: ${stats.errors} | Uptime: ${uptime}s`);
  }, 60000);

  // Iniciar loop
  processLoop();
}

// ============ SHUTDOWN ============

async function shutdown(signal) {
  console.log(`\n🛑 [${signal}] Encerrando worker ${WORKER_ID}...`);
  running = false;
  await new Promise(resolve => setTimeout(resolve, 1000));
  await redisStreams.disconnect();
  await prisma.$disconnect();
  console.log(`✅ Worker ${WORKER_ID} encerrado`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
