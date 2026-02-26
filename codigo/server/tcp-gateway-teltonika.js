#!/usr/bin/env node
/**
 * TCP Gateway Teltonika - Rastreamento Veicular
 *
 * Gateway para dispositivos Teltonika (FMC800, FMC920, FMC003, FMC650)
 * - Protocolo: Codec 8, Codec 8 Extended, Codec 12, Codec 16
 * - Porta padrão: 8879
 *
 * Estrutura independente do gateway GT06/X3Tech (porta 8877/8878)
 * Ambos publicam no mesmo Redis Streams para processamento unificado.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const net = require('net');
const teltonikaParser = require('./parsers/teltonika-parser');
const { redisStreams } = require('./services/redis-streams.service');

// ============ CONFIGURAÇÃO ============
const GATEWAY_ID = process.env.TELTONIKA_GATEWAY_ID || `gw-teltonika-${process.pid}`;
const TCP_PORT = parseInt(process.env.TELTONIKA_PORT) || 8879;
const MAX_CONNECTIONS = parseInt(process.env.TELTONIKA_MAX_CONNECTIONS) || 2000;
const CONNECTION_TIMEOUT = parseInt(process.env.TELTONIKA_CONNECTION_TIMEOUT) || 180000; // 3 min

// ============ ESTADO ============
const activeConnections = new Map(); // IMEI → socket
const sessionData = new Map(); // sessionKey → { imei, buffer, lastActivity }
const stats = {
  connectionsTotal: 0,
  connectionsCurrent: 0,
  packetsReceived: 0,
  packetsPublished: 0,
  recordsProcessed: 0,
  errors: 0,
  startTime: Date.now()
};

// ============ HELPERS ============

function getSessionKey(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}

// ============ TCP SERVER ============

const tcpServer = net.createServer((socket) => {
  // Verificar limite de conexões
  if (stats.connectionsCurrent >= MAX_CONNECTIONS) {
    console.warn(`[Teltonika:${GATEWAY_ID}] Limite de conexões atingido (${MAX_CONNECTIONS})`);
    socket.destroy();
    return;
  }

  const sessionKey = getSessionKey(socket);

  // Estado da sessão
  const session = {
    imei: null,
    buffer: Buffer.alloc(0),
    authenticated: false,
    lastActivity: Date.now()
  };
  sessionData.set(sessionKey, session);

  stats.connectionsTotal++;
  stats.connectionsCurrent++;

  console.log(`[Teltonika:${GATEWAY_ID}] 📡 Nova conexão: ${sessionKey} (total: ${stats.connectionsCurrent})`);

  // Configurar socket
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(CONNECTION_TIMEOUT);

  // ============ DATA ============
  socket.on('data', async (data) => {
    session.lastActivity = Date.now();
    stats.packetsReceived++;

    console.log(`[Teltonika:${GATEWAY_ID}] 📦 DATA recebido: ${data.length} bytes - HEX: ${data.toString('hex').substring(0, 60)}`);

    try {
      // Acumular dados no buffer
      session.buffer = Buffer.concat([session.buffer, data]);

      // Processar buffer
      await processBuffer(socket, session);

    } catch (error) {
      stats.errors++;
      console.error(`[Teltonika:${GATEWAY_ID}] Erro ao processar dados:`, error.message);
    }
  });

  // ============ TIMEOUT ============
  socket.on('timeout', () => {
    console.log(`[Teltonika:${GATEWAY_ID}] Timeout: ${sessionKey} (IMEI: ${session.imei || 'não autenticado'})`);
    socket.destroy();
  });

  // ============ CLOSE ============
  socket.on('close', async () => {
    stats.connectionsCurrent--;

    if (session.imei) {
      activeConnections.delete(session.imei);
      await redisStreams.removeSession(session.imei);
      console.log(`[Teltonika:${GATEWAY_ID}] 📴 Desconectado: ${session.imei}`);
    } else {
      console.log(`[Teltonika:${GATEWAY_ID}] 📴 Desconectado: ${sessionKey} (não autenticado)`);
    }

    sessionData.delete(sessionKey);
  });

  // ============ ERROR ============
  socket.on('error', (error) => {
    stats.errors++;
    if (error.code !== 'ECONNRESET') {
      console.error(`[Teltonika:${GATEWAY_ID}] Erro ${sessionKey}:`, error.message);
    }
  });
});

/**
 * Processa buffer de dados acumulados
 */
async function processBuffer(socket, session) {
  const sessionKey = getSessionKey(socket);

  // Se não autenticado, esperar IMEI
  if (!session.authenticated) {
    // IMEI packet: [length:2][IMEI:15-16]
    console.log(`[Teltonika:${GATEWAY_ID}] 📥 Buffer recebido: ${session.buffer.length} bytes - ${session.buffer.slice(0, Math.min(30, session.buffer.length)).toString('hex')}`);

    if (session.buffer.length >= 17) {
      const imei = teltonikaParser.parseImei(session.buffer);

      if (imei) {
        session.imei = imei;
        session.authenticated = true;
        activeConnections.set(imei, socket);

        // Registrar sessão no Redis
        await redisStreams.registerSession(imei, GATEWAY_ID, {
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          protocol: 'teltonika'
        });

        // Enviar ACK de IMEI aceito
        const ack = teltonikaParser.createImeiResponse(true);
        socket.write(ack);

        console.log(`[Teltonika:${GATEWAY_ID}] ✅ Autenticado: ${imei}`);

        // Limpar buffer do IMEI
        const imeiLength = session.buffer.readUInt16BE(0);
        session.buffer = session.buffer.slice(2 + imeiLength);

        // Publicar evento de login
        await redisStreams.publishStatus(imei, {
          event: 'login',
          protocol: 'teltonika',
          timestamp: new Date().toISOString()
        }, GATEWAY_ID);

      } else {
        // IMEI inválido - rejeitar
        console.warn(`[Teltonika:${GATEWAY_ID}] ❌ IMEI inválido de ${sessionKey}`);
        const ack = teltonikaParser.createImeiResponse(false);
        socket.write(ack);
        socket.destroy();
        return;
      }
    }
    return;
  }

  // Já autenticado - processar pacotes AVL
  while (session.buffer.length >= 12) {
    // Verificar se temos um pacote completo
    // Estrutura: preamble(4) + length(4) + data(length) + crc(4)

    // Verificar preamble
    const preamble = session.buffer.readUInt32BE(0);
    if (preamble !== 0x00000000) {
      // Preamble inválido - tentar encontrar próximo pacote válido
      console.warn(`[Teltonika:${GATEWAY_ID}] Preamble inválido, buscando próximo pacote`);
      const nextPreamble = session.buffer.indexOf(Buffer.from([0x00, 0x00, 0x00, 0x00]), 1);
      if (nextPreamble > 0) {
        session.buffer = session.buffer.slice(nextPreamble);
        continue;
      } else {
        // Limpar buffer se não encontrar preamble válido
        session.buffer = Buffer.alloc(0);
        break;
      }
    }

    // Verificar se temos length field
    if (session.buffer.length < 8) break;

    const dataLength = session.buffer.readUInt32BE(4);
    const packetLength = 4 + 4 + dataLength + 4; // preamble + length + data + crc

    // Verificar se temos o pacote completo
    if (session.buffer.length < packetLength) {
      console.log(`[Teltonika:${GATEWAY_ID}] Aguardando mais dados: ${session.buffer.length}/${packetLength}`);
      break;
    }

    // Extrair pacote completo
    const packet = session.buffer.slice(0, packetLength);
    session.buffer = session.buffer.slice(packetLength);

    // Parsear pacote
    const parsed = teltonikaParser.parse(packet);

    if (parsed && parsed.type === 'avl_data' && parsed.records) {
      // Processar cada registro AVL
      for (const record of parsed.records) {
        stats.recordsProcessed++;

        // Preparar dados para publicação
        const locationData = {
          latitude: record.latitude,
          longitude: record.longitude,
          velocidade: record.velocidade,
          direcao: record.direcao,
          precisao: record.precisao,
          altitude: record.altitude,
          satellites: record.satellites,
          ignicao: record.ignicao,
          odometro_embarcado: record.odometro_embarcado,
          tensao_bateria: record.tensao_bateria,
          tensao_principal: record.tensao_principal,
          percentual_bateria: record.percentual_bateria,
          sinal_gsm: record.sinal_gsm,
          movimento: record.movimento,
          // Dados OBD2 extras
          rpm: record.rpm,
          temperatura_motor: record.temperatura_motor,
          nivel_combustivel: record.nivel_combustivel,
          timestamp: record.timestamp.toISOString(),
          protocol: 'teltonika',
          codec: `0x${parsed.codecId.toString(16).padStart(2, '0')}`,
          io_raw: record.io
        };

        // Publicar localização
        await redisStreams.publishLocation(session.imei, locationData, GATEWAY_ID);

        // Se tem evento de alarme, publicar separadamente
        if (record.priority === 'panic' || record.priority === 'high') {
          await redisStreams.publishAlarm(session.imei, {
            ...locationData,
            tipo_alarme: record.priority === 'panic' ? 'SOS/Panic' : 'High Priority Event',
            severidade: record.priority === 'panic' ? 'critical' : 'warning'
          }, GATEWAY_ID);
        }
      }

      stats.packetsPublished++;

      // Enviar ACK com número de records aceitos
      const ack = teltonikaParser.createAckResponse(parsed.records.length);
      socket.write(ack);

      console.log(`[Teltonika:${GATEWAY_ID}] ✅ ${session.imei}: ${parsed.records.length} records processados`);

      // Atualizar atividade da sessão no Redis
      await redisStreams.updateSessionActivity(session.imei);

    } else if (parsed && parsed.type === 'command') {
      // Resposta de comando
      console.log(`[Teltonika:${GATEWAY_ID}] 📨 Resposta de comando de ${session.imei}:`, parsed.commands);

      await redisStreams.publish('gps:command:responses', {
        imei: session.imei,
        gateway_id: GATEWAY_ID,
        commands: parsed.commands,
        timestamp: new Date().toISOString()
      });

    } else {
      console.warn(`[Teltonika:${GATEWAY_ID}] ⚠️ Pacote não processado de ${session.imei}`);
    }
  }
}

/**
 * Envia comando para dispositivo
 */
function sendCommandToDevice(imei, command) {
  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    console.log(`[Teltonika:${GATEWAY_ID}] Dispositivo ${imei} não conectado`);
    return { success: false, error: 'Dispositivo não conectado' };
  }

  try {
    const commandPacket = teltonikaParser.createCommand(command);
    socket.write(commandPacket);
    console.log(`[Teltonika:${GATEWAY_ID}] 📤 Comando enviado para ${imei}: ${command}`);
    return { success: true, command };
  } catch (error) {
    console.error(`[Teltonika:${GATEWAY_ID}] Erro ao enviar comando:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Processa comandos do Redis Stream
 */
async function processCommands() {
  if (!redisStreams.isAvailable()) return;

  try {
    await redisStreams.consumeCommands(async (message) => {
      const { imei, command, command_id } = message;

      // Verificar se é um dispositivo Teltonika conectado a este gateway
      if (!activeConnections.has(imei)) return;

      console.log(`[Teltonika:${GATEWAY_ID}] Comando recebido: ${command_id} para ${imei}`);

      const result = sendCommandToDevice(imei, command);

      // Publicar resposta
      await redisStreams.publish('gps:command:responses', {
        command_id,
        imei,
        gateway_id: GATEWAY_ID,
        success: result.success,
        error: result.error || null,
        timestamp: new Date().toISOString()
      });
    }, 5, 1000);
  } catch (error) {
    console.error(`[Teltonika:${GATEWAY_ID}] Erro ao processar comandos:`, error.message);
  }
}

// ============ INICIALIZAÇÃO ============

async function start() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 TCP GATEWAY TELTONIKA - ${GATEWAY_ID}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📡 Dispositivos suportados: FMC800, FMC920, FMC003, FMC650`);
  console.log(`📡 Codecs: Codec 8, Codec 8E, Codec 12, Codec 16`);
  console.log(`${'='.repeat(60)}\n`);

  // Conectar Redis Streams
  const redisConnected = await redisStreams.connect();
  if (!redisConnected) {
    console.error('❌ Falha ao conectar Redis Streams. Encerrando...');
    process.exit(1);
  }

  // Iniciar consumo de comandos em loop
  setInterval(processCommands, 1000);

  // Iniciar servidor TCP
  tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`✅ Gateway Teltonika escutando em 0.0.0.0:${TCP_PORT}`);
    console.log(`📊 Max conexões: ${MAX_CONNECTIONS}`);
    console.log(`⏱️  Timeout: ${CONNECTION_TIMEOUT / 1000}s\n`);
  });

  // Estatísticas periódicas
  setInterval(() => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000);
    const uptimeMin = Math.floor(uptime / 60);
    console.log(
      `[Teltonika:${GATEWAY_ID}] 📊 Conexões: ${stats.connectionsCurrent} | ` +
      `Packets: ${stats.packetsReceived} | Records: ${stats.recordsProcessed} | ` +
      `Publicados: ${stats.packetsPublished} | Erros: ${stats.errors} | ` +
      `Uptime: ${uptimeMin}min`
    );
  }, 60000);
}

// ============ SHUTDOWN ============

async function shutdown(signal) {
  console.log(`\n🛑 [${signal}] Encerrando gateway Teltonika ${GATEWAY_ID}...`);

  // Fechar novas conexões
  tcpServer.close();

  // Desconectar todas as sessões
  for (const [imei, socket] of activeConnections) {
    await redisStreams.removeSession(imei);
    socket.destroy();
  }

  // Desconectar Redis
  await redisStreams.disconnect();

  console.log(`✅ Gateway Teltonika ${GATEWAY_ID} encerrado`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============ START ============
start().catch((error) => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});

module.exports = { tcpServer, activeConnections, stats, sendCommandToDevice };
