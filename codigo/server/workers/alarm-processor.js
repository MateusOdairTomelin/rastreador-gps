#!/usr/bin/env node
/**
 * Alarm Processor Worker
 *
 * Consome pacotes de alarme do Redis Streams:
 * - Salva alarmes no banco
 * - Envia notificações (futuro)
 * - Prioridade alta (processa rápido)
 *
 * Uso:
 *   WORKER_ID=alarm-1 node workers/alarm-processor.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { redisStreams } = require('../services/redis-streams.service');
const prisma = require('../db/prisma');
const dispositivoService = require('../services/dispositivo.service');
const alarmeService = require('../services/alarme.service');
const heartbeatService = require('../services/heartbeat.service');

// ============ CONFIGURAÇÃO ============
const WORKER_ID = process.env.WORKER_ID || `alarm-${process.pid}`;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 5;
const BLOCK_TIME = parseInt(process.env.BLOCK_TIME) || 1000; // Baixo para prioridade

// ============ ESTADO ============
const stats = {
  processed: 0,
  errors: 0,
  startTime: Date.now(),
  byType: {}
};

// ============ PROCESSAMENTO ============

async function processAlarmMessage(message) {
  // Ignorar mensagens de inicialização do stream
  if (message.init || !message.imei || !message.data) {
    return;
  }

  const { imei, data } = message;

  try {
    const alarmData = typeof data === 'string' ? JSON.parse(data) : data;

    // Registrar heartbeat
    await heartbeatService.register(imei);

    // Atualizar dispositivo
    await dispositivoService.upsert(imei, { status: 'online' });

    // Salvar alarme
    await alarmeService.create(imei, alarmData);

    // Estatísticas por tipo
    const tipoAlarme = alarmData.tipo_alarme || 'unknown';
    stats.byType[tipoAlarme] = (stats.byType[tipoAlarme] || 0) + 1;

    stats.processed++;
    console.log(`[${WORKER_ID}] 🚨 ${imei}: Alarme ${tipoAlarme} (${alarmData.severidade || 'N/A'})`);

    // TODO: Enviar notificação push/SMS/email
    // await notificationService.send(imei, alarmData);

  } catch (error) {
    stats.errors++;
    console.error(`[${WORKER_ID}] ❌ Alarme ${imei}:`, error.message);
    throw error;
  }
}

// ============ LOOP PRINCIPAL ============

let running = true;

async function processLoop() {
  while (running) {
    try {
      // Processar pendentes primeiro (alta prioridade)
      await redisStreams.processPending(
        'gps:packets:alarm',
        'alarm-processors',
        processAlarmMessage,
        5
      );

      // Processar novos
      await redisStreams.consumeAlarm(processAlarmMessage, BATCH_SIZE, BLOCK_TIME);

    } catch (error) {
      console.error(`[${WORKER_ID}] Erro no loop:`, error.message);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Intervalo curto para prioridade
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// ============ INICIALIZAÇÃO ============

async function start() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚨 ALARM PROCESSOR - ${WORKER_ID}`);
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

  console.log(`✅ Worker ${WORKER_ID} iniciado (ALTA PRIORIDADE)\n`);

  // Estatísticas
  setInterval(() => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000);
    console.log(`[${WORKER_ID}] 📊 Processados: ${stats.processed} | Erros: ${stats.errors} | Uptime: ${uptime}s`);
    if (Object.keys(stats.byType).length > 0) {
      console.log(`[${WORKER_ID}] 📊 Por tipo:`, stats.byType);
    }
  }, 60000);

  // Iniciar loop
  processLoop();
}

// ============ SHUTDOWN ============

async function shutdown(signal) {
  console.log(`\n🛑 [${signal}] Encerrando worker ${WORKER_ID}...`);
  running = false;
  await new Promise(resolve => setTimeout(resolve, 500));
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
