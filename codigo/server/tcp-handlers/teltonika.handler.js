/**
 * Handler TCP para dispositivos Teltonika
 *
 * PORTA: 8879
 * MODELOS: FMC800, FMC920, FMC003, FMC650
 *
 * Este arquivo contém toda a lógica de processamento para dispositivos Teltonika.
 * Protocolo completamente diferente do GT06 (usado no X3Tech).
 *
 * Características Teltonika:
 * - Handshake: IMEI ASCII de 15 dígitos (resposta 0x01 aceito, 0x00 rejeitado)
 * - Codecs: Codec 8, Codec 8 Extended (0x8E), Codec 12, Codec 16
 * - Preamble: 0x00000000 (4 bytes de zeros)
 * - CRC: CRC-16/IBM (diferente do CRC-16/X25 do GT06)
 * - Resposta AVL: 4 bytes com número de records aceitos
 */

const net = require('net');
const teltonikaParser = require('../parsers/teltonika-parser');
const dispositivoService = require('../services/dispositivo.service');
const localizacaoService = require('../services/localizacao.service');
const alarmeService = require('../services/alarme.service');
const heartbeatService = require('../services/heartbeat.service');
const viagemService = require('../services/viagem.service');
const geofencingService = require('../services/geofencing.service');
const { redisStreams } = require('../services/redis-streams.service');

// Tipo de dispositivo para esta porta
const DEVICE_TYPE = 'TELTONIKA';
const PORT = 8879;

// ============ ESTADO ============
const activeConnections = new Map(); // IMEI → socket
const sessionData = new Map(); // sessionKey → { imei, buffer, lastActivity, authenticated }
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

// ============ HANDLERS DE DADOS ============

async function handleLogin(imei, socket, sessionKey, gatewayId) {
  console.log(`[Teltonika:${PORT}] 🔑 Login de ${imei}`);

  // Registrar heartbeat
  const hbInfo = await heartbeatService.register(imei);
  console.log(`💓 [Heartbeat] #${hbInfo.count} from ${imei}`);

  // Atualizar/criar dispositivo como Teltonika
  await dispositivoService.upsert(imei, {
    status: 'online',
    tipo: DEVICE_TYPE
  });

  // Armazenar conexão ativa
  activeConnections.set(imei, socket);
  console.log(`📡 [Connection] Socket armazenado para ${imei} (${DEVICE_TYPE})`);

  // Registrar sessão no Redis (se disponível)
  if (redisStreams && redisStreams.isAvailable && redisStreams.isAvailable()) {
    try {
      await redisStreams.registerSession(imei, gatewayId, {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
        protocol: 'teltonika'
      });
    } catch (e) {
      console.warn(`[Teltonika] Redis session register failed: ${e.message}`);
    }
  }

  console.log(`✅ [Login] Device ${imei} (${DEVICE_TYPE}) connected`);
}

async function handleLocation(imei, record, parsedData) {
  const data = {
    latitude: record.latitude,
    longitude: record.longitude,
    velocidade: record.velocidade,
    direcao: record.direcao,
    altitude: record.altitude,
    precisao: record.precisao,
    satellites: record.satellites,
    ignicao: record.ignicao,
    odometro_embarcado: record.odometro_embarcado,
    tensao_bateria: record.tensao_bateria,
    tensao_principal: record.tensao_principal,
    percentual_bateria: record.percentual_bateria,
    sinal_gsm: record.sinal_gsm,
    movimento: record.movimento,
    timestamp: record.timestamp,
    protocol: 'teltonika',
    codec: parsedData.codecId ? `0x${parsedData.codecId.toString(16).padStart(2, '0')}` : null
  };

  // Detectar estado de ignição
  let estadoIgnicao = 'off';
  if (data.ignicao === true || data.ignicao === 1) {
    if (data.velocidade > 3) {
      estadoIgnicao = 'moving';
    } else {
      estadoIgnicao = 'idle';
    }
  } else if (data.movimento === true || data.movimento === 1) {
    estadoIgnicao = 'moving';
  }

  data.estado_ignicao = estadoIgnicao;

  console.log(`🌍 [GPS:${DEVICE_TYPE}] ${imei}: (${data.latitude}, ${data.longitude}) @ ${data.velocidade} km/h | Estado: ${estadoIgnicao}`);

  // Atualizar dispositivo
  await dispositivoService.upsert(imei, {
    status: 'online',
    estado_ignicao: estadoIgnicao
  });

  // Registrar heartbeat
  await heartbeatService.register(imei);

  // Salvar localização
  await localizacaoService.create(imei, data);

  // Verificar geofencing
  geofencingService.verificarPosicao(
    imei,
    data.latitude,
    data.longitude,
    data.velocidade || 0,
    data.timestamp ? new Date(data.timestamp) : new Date()
  ).catch(err => {
    console.warn(`[Geofencing] Erro: ${err.message}`);
  });

  // Processar viagem
  await viagemService.processarLocalizacao(
    imei,
    data.ignicao,
    data.latitude,
    data.longitude,
    data.velocidade,
    data.timestamp || new Date(),
    data.tensao_principal
  );

  console.log(`✅ [Location] Saved for ${imei}`);
  return data;
}

async function handleAlarm(imei, record, priority) {
  await heartbeatService.register(imei);
  await dispositivoService.upsert(imei, { status: 'online' });

  const tipoAlarme = priority === 'panic' ? 'SOS/Panic' : 'High Priority Event';
  const severidade = priority === 'panic' ? 'critical' : 'warning';

  const alarmData = {
    tipo_alarme: tipoAlarme,
    severidade: severidade,
    latitude: record.latitude,
    longitude: record.longitude,
    velocidade: record.velocidade,
    timestamp: record.timestamp,
    descricao: `Evento ${priority} do dispositivo Teltonika`
  };

  console.log(`🚨 [ALARM:${DEVICE_TYPE}] ${imei}:`, {
    tipo: alarmData.tipo_alarme,
    severidade: alarmData.severidade
  });

  await alarmeService.create(imei, alarmData);
}

async function handleCommandResponse(imei, commands, gatewayId) {
  console.log(`📨 [Teltonika:${PORT}] Resposta de comando de ${imei}:`, commands);

  // Publicar no Redis se disponível
  if (redisStreams && redisStreams.isAvailable && redisStreams.isAvailable()) {
    try {
      await redisStreams.publish('gps:command:responses', {
        imei: imei,
        gateway_id: gatewayId,
        commands: commands,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.warn(`[Teltonika] Redis publish failed: ${e.message}`);
    }
  }
}

// ============ BUFFER PROCESSING ============

async function processBuffer(socket, session, gatewayId, apiRoutes) {
  const sessionKey = getSessionKey(socket);

  // Se não autenticado, esperar IMEI
  if (!session.authenticated) {
    // IMEI packet: [length:2][IMEI:15-16]
    if (session.buffer.length >= 17) {
      const imei = teltonikaParser.parseImei(session.buffer);

      if (imei) {
        session.imei = imei;
        session.authenticated = true;
        activeConnections.set(imei, socket);

        // Enviar ACK de IMEI aceito
        const ack = teltonikaParser.createImeiResponse(true);
        socket.write(ack);

        console.log(`[Teltonika:${PORT}] ✅ Autenticado: ${imei}`);

        // Limpar buffer do IMEI
        const imeiLength = session.buffer.readUInt16BE(0);
        session.buffer = session.buffer.slice(2 + imeiLength);

        // Handler de login
        await handleLogin(imei, socket, sessionKey, gatewayId);

        // Registrar estatísticas
        if (apiRoutes) {
          apiRoutes.recordPacket('login');
          apiRoutes.recordPacketDetails({
            type: 'login',
            protocolNumber: '0x00',
            imei: imei,
            timestamp: new Date().toISOString(),
            deviceType: DEVICE_TYPE
          });
        }

      } else {
        // IMEI inválido - rejeitar
        console.warn(`[Teltonika:${PORT}] ❌ IMEI inválido de ${sessionKey}`);
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
    // Verificar preamble
    const preamble = session.buffer.readUInt32BE(0);
    if (preamble !== 0x00000000) {
      // Preamble inválido - tentar encontrar próximo pacote válido
      console.warn(`[Teltonika:${PORT}] Preamble inválido, buscando próximo pacote`);
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
      console.log(`[Teltonika:${PORT}] Aguardando mais dados: ${session.buffer.length}/${packetLength}`);
      break;
    }

    // Extrair pacote completo
    const packet = session.buffer.slice(0, packetLength);
    session.buffer = session.buffer.slice(packetLength);

    stats.packetsReceived++;

    // Parsear pacote
    const parsed = teltonikaParser.parse(packet);

    if (parsed && parsed.type === 'avl_data' && parsed.records) {
      // ✅ CRÍTICO: Enviar ACK IMEDIATAMENTE (antes do processamento)
      // O dispositivo espera ACK rápido, se demorar ele desconecta
      const recordCount = parsed.records.length;
      const ack = teltonikaParser.createAckResponse(recordCount);
      if (!socket.destroyed) {
        socket.write(ack);
        console.log(`[Teltonika:${PORT}] ✅ ACK enviado IMEDIATAMENTE: ${recordCount} records`);
      }

      // Processar cada registro AVL (agora em background, ACK já foi enviado)
      for (const record of parsed.records) {
        stats.recordsProcessed++;

        // Handler de localização
        await handleLocation(session.imei, record, parsed);

        // Se tem evento de alarme, processar separadamente
        if (record.priority === 'panic' || record.priority === 'high') {
          await handleAlarm(session.imei, record, record.priority);
        }
      }

      stats.packetsPublished++;

      console.log(`[Teltonika:${PORT}] ✅ ${session.imei}: ${recordCount} records processados`);

      // Registrar estatísticas
      if (apiRoutes) {
        apiRoutes.recordPacket('location');
        apiRoutes.recordPacketDetails({
          type: 'avl_data',
          protocolNumber: `0x${parsed.codecId.toString(16).padStart(2, '0')}`,
          imei: session.imei,
          timestamp: new Date().toISOString(),
          deviceType: DEVICE_TYPE,
          recordCount: parsed.records.length
        });
      }

    } else if (parsed && parsed.type === 'command') {
      // Resposta de comando
      await handleCommandResponse(session.imei, parsed.commands, gatewayId);

    } else {
      console.warn(`[Teltonika:${PORT}] ⚠️ Pacote não processado de ${session.imei}`);
      stats.errors++;
    }
  }
}

// ============ ENVIAR COMANDO ============

function sendCommand(imei, command) {
  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    console.log(`[Teltonika:${PORT}] Dispositivo ${imei} não conectado`);
    return { success: false, error: 'Dispositivo não conectado' };
  }

  try {
    const commandPacket = teltonikaParser.createCommand(command);
    socket.write(commandPacket);
    console.log(`[Teltonika:${PORT}] 📤 Comando enviado para ${imei}: ${command}`);
    return { success: true, command };
  } catch (error) {
    console.error(`[Teltonika:${PORT}] Erro ao enviar comando:`, error.message);
    return { success: false, error: error.message };
  }
}

// ============ CRIAR SERVIDOR ============

function createServer(dependencies = {}) {
  const apiRoutes = dependencies.apiRoutes;
  const gatewayId = dependencies.gatewayId || `teltonika-${process.pid}`;
  const maxConnections = dependencies.maxConnections || 2000;
  const connectionTimeout = dependencies.connectionTimeout || 180000; // 3 min

  const server = net.createServer((socket) => {
    // Verificar limite de conexões
    if (stats.connectionsCurrent >= maxConnections) {
      console.warn(`[Teltonika:${PORT}] Limite de conexões atingido (${maxConnections})`);
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

    console.log(`[Teltonika:${PORT}] 📡 Nova conexão: ${sessionKey} (total: ${stats.connectionsCurrent})`);

    // Configurar socket
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(connectionTimeout);

    // ============ DATA ============
    socket.on('data', async (data) => {
      session.lastActivity = Date.now();

      try {
        // Acumular dados no buffer
        session.buffer = Buffer.concat([session.buffer, data]);

        // Processar buffer
        await processBuffer(socket, session, gatewayId, apiRoutes);

      } catch (error) {
        stats.errors++;
        console.error(`[Teltonika:${PORT}] Erro ao processar dados:`, error.message);
      }
    });

    // ============ TIMEOUT ============
    socket.on('timeout', () => {
      console.log(`[Teltonika:${PORT}] Timeout: ${sessionKey} (IMEI: ${session.imei || 'não autenticado'})`);
      socket.destroy();
    });

    // ============ CLOSE ============
    socket.on('close', async () => {
      stats.connectionsCurrent--;

      if (session.imei) {
        activeConnections.delete(session.imei);

        // Remover sessão do Redis
        if (redisStreams && redisStreams.isAvailable && redisStreams.isAvailable()) {
          try {
            await redisStreams.removeSession(session.imei);
          } catch (e) {
            // Ignorar erro de Redis
          }
        }

        // Marcar dispositivo como offline
        await dispositivoService.upsert(session.imei, { status: 'offline' }).catch(() => {});

        console.log(`[Teltonika:${PORT}] 📴 Desconectado: ${session.imei}`);
      } else {
        console.log(`[Teltonika:${PORT}] 📴 Desconectado: ${sessionKey} (não autenticado)`);
      }

      sessionData.delete(sessionKey);
    });

    // ============ ERROR ============
    socket.on('error', (error) => {
      stats.errors++;
      if (error.code !== 'ECONNRESET') {
        console.error(`[Teltonika:${PORT}] Erro ${sessionKey}:`, error.message);
      }
    });
  });

  return server;
}

// ============ ESTATÍSTICAS ============

function getStats() {
  return {
    ...stats,
    uptime: Math.round((Date.now() - stats.startTime) / 1000),
    activeConnections: stats.connectionsCurrent
  };
}

// ============ COMANDOS TELTONIKA COMUNS ============
const TELTONIKA_COMMANDS = {
  // Comandos de configuração (via GPRS)
  GET_INFO: 'getinfo',
  GET_VER: 'getver',
  GET_GPS: 'getgps',
  GET_IO: 'getio',

  // Configuração de intervalo
  SET_PARAM_DATA_FREQ: 'setparam 1002:',  // Frequência de dados (segundos)

  // Ignição
  GET_IGNITION: 'getparam 239',

  // Odômetro
  GET_ODOMETER: 'getparam 16',
  RESET_ODOMETER: 'setparam 16:0',

  // GPRS
  FLUSH_DATA: 'flush',

  // Reiniciar dispositivo
  RESTART: 'cpureset',
};

module.exports = {
  DEVICE_TYPE,
  PORT,
  createServer,
  sendCommand,
  getStats,
  activeConnections,
  TELTONIKA_COMMANDS
};
