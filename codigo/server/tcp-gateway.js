#!/usr/bin/env node
/**
 * TCP Gateway Standalone - Rastreamento Veicular
 *
 * Gateway stateless para conexões TCP de rastreadores.
 * - Aceita conexões TCP
 * - Parse mínimo de pacotes (LOGIN para IMEI)
 * - Envia ACK para rastreadores
 * - Publica pacotes no Redis Streams
 * - Consome comandos do Redis e envia para dispositivos
 *
 * Este gateway NÃO processa dados - apenas roteia.
 * O processamento é feito pelos workers (location-processor, etc).
 *
 * Uso:
 *   GATEWAY_ID=gw-1 TCP_PORT=8877 node tcp-gateway.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const net = require('net');
const gpsParser = require('./parsers/gps-parser');
const TCPPacketBuffer = require('./tcp-packet-buffer');
const { redisStreams } = require('./services/redis-streams.service');
const tcpSecurity = require('./middleware/tcp-security.middleware'); // ✅ Segurança TCP

// ============ CONFIGURAÇÃO ============
const GATEWAY_ID = process.env.GATEWAY_ID || `gw-${process.pid}`;
const TCP_PORT = parseInt(process.env.TCP_PORT) || 8877;
const TCP_PORT_OBD2 = parseInt(process.env.TCP_PORT_OBD2) || 0; // Porta OBD2 (opcional)
const TELTONIKA_PORT = parseInt(process.env.TELTONIKA_PORT) || 0; // Porta Teltonika (opcional)
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS) || 2000;
const CONNECTION_TIMEOUT = parseInt(process.env.CONNECTION_TIMEOUT) || 120000; // 2 min

// ============ ESTADO ============
const activeConnections = new Map(); // IMEI → socket
const sessionImeiMap = new Map(); // sessionKey → IMEI
const stats = {
  connectionsTotal: 0,
  connectionsCurrent: 0,
  packetsReceived: 0,
  packetsPublished: 0,
  errors: 0,
  startTime: Date.now()
};

// ============ RECONFIGURAÇÃO DE DISPOSITIVOS ============
// IMEIs que precisam receber comandos de configuração na próxima conexão
// Adicione IMEIs aqui quando precisar reconfigurar um dispositivo específico
const IMEIS_RECONFIGURAR = new Set([
  // '356354871416435', // QIK8A12 - RECONFIGURADO em 06/02/2026
]);

// ✅ AUTO-CONFIG: Enviar comandos de timezone para TODOS os dispositivos ao conectar
// Isso garante que todos usem UTC e evita problemas de delay
const AUTO_CONFIG_TODOS = process.env.AUTO_CONFIG_TODOS === 'true';
const AUTO_CONFIG_TIMEZONE = process.env.AUTO_CONFIG_TIMEZONE !== 'false'; // true por padrão

/**
 * Constrói pacote de comando no formato Protocolo 0x80
 */
function buildCommandPacket(comando, serialNumber = 1) {
  const commandBuffer = Buffer.from(comando, 'ascii');
  const serverFlag = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const lengthOfCommand = 1 + 4 + commandBuffer.length;
  const protocol = 0x80;

  const infoContent = Buffer.concat([
    Buffer.from([lengthOfCommand]),
    serverFlag,
    commandBuffer
  ]);

  const serialBuffer = Buffer.alloc(2);
  serialBuffer.writeUInt16BE(serialNumber);

  const crcData = Buffer.concat([
    Buffer.from([protocol]),
    infoContent,
    serialBuffer
  ]);

  // CRC16-ITU simplificado
  let fcs = 0xFFFF;
  for (let i = 0; i < crcData.length; i++) {
    fcs = (fcs >> 8) ^ ((fcs ^ crcData[i]) & 0xFF);
  }
  const crc = ~fcs & 0xFFFF;
  const crcBuffer = Buffer.alloc(2);
  crcBuffer.writeUInt16LE(crc);

  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    Buffer.from([crcData.length]),
    crcData,
    crcBuffer,
    Buffer.from([0x0D, 0x0A])
  ]);
}

/**
 * Envia comandos de reconfiguração para dispositivo
 */
async function enviarComandosReconfig(imei, socket) {
  const deveReconfigurar = IMEIS_RECONFIGURAR.has(imei) || AUTO_CONFIG_TODOS;
  const deveConfigTimezone = AUTO_CONFIG_TIMEZONE;

  // Se não precisa fazer nada, retorna
  if (!deveReconfigurar && !deveConfigTimezone) return;

  // Comandos completos de reconfiguração
  const comandosCompletos = [
    { cmd: '#55555#TIMEZONE,E,0#', desc: 'Timezone UTC+0' },  // ✅ CRÍTICO: Evita delay de 1.8h
    { cmd: '#55555#YUP#10#', desc: 'Intervalo 10s' },
    { cmd: '#55555#YGPS#1#', desc: 'Ativar GPS' },
    { cmd: '#55555#YONLINE#1#', desc: 'Modo online' },
    { cmd: 'SETLOCX22#', desc: 'Protocolo 0x22' },
  ];

  // Apenas timezone (para todos os dispositivos)
  const comandosTimezone = [
    { cmd: '#55555#TIMEZONE,E,0#', desc: 'Timezone UTC+0' },
  ];

  // Seleciona quais comandos enviar
  const comandos = deveReconfigurar ? comandosCompletos : comandosTimezone;
  const tipoConfig = deveReconfigurar ? 'RECONFIGURAÇÃO COMPLETA' : 'TIMEZONE';

  console.log(`🔧 [Gateway:${GATEWAY_ID}] ${imei}: ${tipoConfig}`);

  let serial = 1;
  for (const { cmd, desc } of comandos) {
    try {
      if (socket.destroyed) {
        console.log(`⚠️ [Gateway:${GATEWAY_ID}] ${imei}: Socket fechado, abortando config`);
        break;
      }
      const packet = buildCommandPacket(cmd, serial++);
      socket.write(packet);
      console.log(`📤 [Gateway:${GATEWAY_ID}] ${imei}: Enviado "${cmd}" (${desc})`);
      await new Promise(r => setTimeout(r, 50)); // 50ms entre comandos
    } catch (e) {
      console.error(`❌ [Gateway:${GATEWAY_ID}] ${imei}: Erro ao enviar "${cmd}":`, e.message);
    }
  }

  console.log(`✅ [Gateway:${GATEWAY_ID}] ${imei}: Configuração enviada!`);
}

// ============ RATE LIMITING ============
const clientRateLimits = new Map();

function checkRateLimit(clientId, maxPacketsPerSecond = 100) {
  const now = Date.now();

  if (!clientRateLimits.has(clientId)) {
    clientRateLimits.set(clientId, { packets: 0, resetAt: now + 1000 });
    return true;
  }

  const limits = clientRateLimits.get(clientId);
  if (now > limits.resetAt) {
    limits.packets = 0;
    limits.resetAt = now + 1000;
  }

  limits.packets++;
  return limits.packets <= maxPacketsPerSecond;
}

// ============ HELPERS ============

function getSessionKey(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}

function extractIMEI(buffer) {
  try {
    const protocolNumber = buffer.readUInt8(3);
    if (protocolNumber === 0x01) {
      // Login packet - IMEI em BCD
      return buffer.slice(4, 12).toString('hex');
    }
    return null;
  } catch (error) {
    return null;
  }
}

// ============ COMANDOS ============

/**
 * Envia comando para dispositivo conectado
 */
function sendCommandToDevice(imei, command) {
  const socket = activeConnections.get(imei);
  if (!socket || socket.destroyed) {
    console.log(`[Gateway:${GATEWAY_ID}] Dispositivo ${imei} não conectado`);
    return { success: false, error: 'Dispositivo não conectado' };
  }

  try {
    // Criar pacote 0x80 (comando)
    const commandBuffer = gpsParser.createCommandPacket
      ? gpsParser.createCommandPacket(command)
      : Buffer.from(command + '\r\n', 'ascii');

    socket.write(commandBuffer);
    console.log(`[Gateway:${GATEWAY_ID}] 📤 Comando enviado para ${imei}: ${command.substring(0, 50)}...`);
    return { success: true, command };
  } catch (error) {
    console.error(`[Gateway:${GATEWAY_ID}] Erro ao enviar comando:`, error.message);
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
      console.log(`[Gateway:${GATEWAY_ID}] Comando recebido: ${command_id} para ${imei}`);

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
    console.error(`[Gateway:${GATEWAY_ID}] Erro ao processar comandos:`, error.message);
  }
}

// ============ TCP SERVER ============

const tcpServer = net.createServer((socket) => {
  // Verificar limite de conexões
  if (stats.connectionsCurrent >= MAX_CONNECTIONS) {
    console.warn(`[Gateway:${GATEWAY_ID}] Limite de conexões atingido (${MAX_CONNECTIONS})`);
    socket.destroy();
    return;
  }

  const sessionKey = getSessionKey(socket);
  let sessionImei = null;
  const packetBuffer = new TCPPacketBuffer();

  stats.connectionsTotal++;
  stats.connectionsCurrent++;

  console.log(`[Gateway:${GATEWAY_ID}] 📡 Conexão: ${sessionKey} (total: ${stats.connectionsCurrent})`);

  // Configurar socket
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(CONNECTION_TIMEOUT);

  // ============ DATA ============
  socket.on('data', async (rawData) => {
    const clientId = sessionKey;

    // Rate limiting
    if (!checkRateLimit(clientId)) {
      console.warn(`[Gateway:${GATEWAY_ID}] Rate limit excedido: ${clientId}`);
      socket.destroy();
      return;
    }

    stats.packetsReceived++;

    try {
      // Adicionar ao buffer
      packetBuffer.append(rawData);
      const packets = packetBuffer.getPackets();

      for (const data of packets) {
        // Parse mínimo
        const parsedData = gpsParser.parse(data);
        if (!parsedData) {
          console.warn(`[Gateway:${GATEWAY_ID}] Pacote inválido`);
          continue;
        }

        // Extrair IMEI (prioridade: parsedData > extractIMEI > sessionImei)
        let imei = parsedData.imei || extractIMEI(data) || sessionImei;

        if (!imei) {
          console.warn(`[Gateway:${GATEWAY_ID}] Pacote sem IMEI`);
          continue;
        }

        // Normalizar IMEI
        if (imei.startsWith('0') && imei.length === 16) {
          imei = imei.substring(1);
        }
        imei = imei.substring(0, 15);

        // ✅ SEGURANÇA: Rate limit por IMEI
        if (!tcpSecurity.checkImeiRateLimit(imei)) {
          console.warn(`[Gateway:${GATEWAY_ID}] ⚠️ Rate limit excedido: ${imei}`);
          continue; // Ignora pacote mas mantém conexão
        }

        // ✅ SEGURANÇA: Atualizar atividade do IMEI
        tcpSecurity.updateImeiActivity(imei);

        // LOGIN: registrar sessão
        if (parsedData.type === 'login') {
          // ✅ SEGURANÇA: Validar IMEI antes de processar login
          const socketInfo = {
            ip: socket.remoteAddress?.replace('::ffff:', '') || 'unknown',
            port: socket.remotePort || 0
          };
          const validation = await tcpSecurity.validateImeiLogin(imei, socketInfo);

          if (!validation.valid) {
            console.warn(`[Gateway:${GATEWAY_ID}] ❌ Login rejeitado: ${imei} - ${validation.reason}`);
            // Envia ACK mesmo assim para não causar flood de reconexões
            // mas não registra a sessão
            const loginAck = gpsParser.createAckResponse(parsedData.protocolNumber, parsedData.serialNumber);
            if (loginAck && !socket.destroyed) {
              socket.write(loginAck);
            }
            continue; // Não processa mais esse pacote
          }

          sessionImei = imei;
          sessionImeiMap.set(sessionKey, imei);
          activeConnections.set(imei, socket);

          // ✅ CRÍTICO: Enviar ACK IMEDIATAMENTE após login (antes das operações Redis)
          // O dispositivo espera ACK rápido, se demorar ele desconecta
          const loginAck = gpsParser.createAckResponse(parsedData.protocolNumber, parsedData.serialNumber);
          if (loginAck && !socket.destroyed) {
            socket.write(loginAck);
            console.log(`[Gateway:${GATEWAY_ID}] ✅ Login: ${imei} (ACK enviado imediatamente)`);

            // ✅ Enviar comandos de reconfiguração IMEDIATAMENTE após o ACK
            // (para dispositivos que precisam ser reconfigurados)
            setImmediate(() => enviarComandosReconfig(imei, socket));
          }

          // Registrar sessão no Redis (em background, não bloqueia o ACK)
          redisStreams.registerSession(imei, GATEWAY_ID, {
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort
          }).catch(err => console.error(`[Gateway:${GATEWAY_ID}] Erro ao registrar sessão:`, err.message));
        }

        // ✅ CRÍTICO: Enviar ACK IMEDIATAMENTE para outros tipos de pacote também
        // (login já foi tratado acima)
        if (parsedData.type !== 'login') {
          const ack = gpsParser.createAckResponse(parsedData.protocolNumber, parsedData.serialNumber);
          if (ack && !socket.destroyed) {
            socket.write(ack);
          }
        }

        // Preparar dados do stream
        const streamData = {
          ...parsedData.data,
          timestamp: parsedData.timestamp.toISOString(),
          protocol_number: parsedData.protocolNumber,
          serial_number: parsedData.serialNumber,
          raw_hex: parsedData.raw.substring(0, 200) // Limitar tamanho
        };

        // Publicar no Redis em background (não bloqueia ACK que já foi enviado)
        // Usar Promise.all para operações paralelas, mas sem await para não bloquear
        const publishPromise = (async () => {
          try {
            // Atualizar atividade da sessão
            await redisStreams.updateSessionActivity(imei);

            // Publicar no stream apropriado
            switch (parsedData.type) {
              case 'login':
                await redisStreams.publishStatus(imei, { ...streamData, event: 'login' }, GATEWAY_ID);
                break;

              case 'location':
                await redisStreams.publishLocation(imei, streamData, GATEWAY_ID);
                break;

              case 'obd2':
                await redisStreams.publishOBD2(imei, streamData, GATEWAY_ID);
                break;

              case 'alarm':
                await redisStreams.publishAlarm(imei, streamData, GATEWAY_ID);
                break;

              case 'status':
              case 'heartbeat':
                await redisStreams.publishStatus(imei, streamData, GATEWAY_ID);
                break;

              case 'sim_info':
                await redisStreams.publishStatus(imei, { ...streamData, event: 'sim_info' }, GATEWAY_ID);
                break;

              default:
                await redisStreams.publishStatus(imei, { ...streamData, event: parsedData.type }, GATEWAY_ID);
            }
            stats.packetsPublished++;
          } catch (err) {
            stats.errors++;
            console.error(`[Gateway:${GATEWAY_ID}] Erro ao publicar ${parsedData.type}:`, err.message);
          }
        })();

        // Não bloquear - deixa a Promise resolver em background
        publishPromise.catch(() => {}); // Evitar unhandled rejection
      }
    } catch (error) {
      stats.errors++;
      console.error(`[Gateway:${GATEWAY_ID}] Erro:`, error.message);
    }
  });

  // ============ TIMEOUT ============
  socket.on('timeout', () => {
    console.log(`[Gateway:${GATEWAY_ID}] Timeout: ${sessionKey}`);
    socket.destroy();
  });

  // ============ CLOSE ============
  socket.on('close', async () => {
    stats.connectionsCurrent--;

    if (sessionImei) {
      activeConnections.delete(sessionImei);
      await redisStreams.removeSession(sessionImei);
      tcpSecurity.removeImeiConnection(sessionImei); // ✅ SEGURANÇA: Remove do tracking
      console.log(`[Gateway:${GATEWAY_ID}] 📴 Desconectado: ${sessionImei}`);
    }

    sessionImeiMap.delete(sessionKey);
  });

  // ============ ERROR ============
  socket.on('error', (error) => {
    stats.errors++;
    console.error(`[Gateway:${GATEWAY_ID}] Erro ${sessionKey}:`, error.message);
    // ✅ SEGURANÇA: Limpar conexão também em caso de erro
    if (sessionImei) {
      tcpSecurity.removeImeiConnection(sessionImei);
    }
  });
});

// ============ SERVIDORES ADICIONAIS (mesma lógica) ============

// Criar servidor para porta OBD2 (8878)
const tcpServerOBD2 = TCP_PORT_OBD2 > 0 ? net.createServer(tcpServer.listeners('connection')[0]) : null;

// Criar servidor para porta Teltonika (8879)
const tcpServerTeltonika = TELTONIKA_PORT > 0 ? net.createServer(tcpServer.listeners('connection')[0]) : null;

// ============ INICIALIZAÇÃO ============

async function start() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 TCP GATEWAY - ${GATEWAY_ID}`);
  console.log(`${'='.repeat(60)}\n`);

  // Conectar Redis Streams
  const redisConnected = await redisStreams.connect();
  if (!redisConnected) {
    console.error('❌ Falha ao conectar Redis Streams. Encerrando...');
    process.exit(1);
  }

  // Iniciar consumo de comandos em loop
  setInterval(processCommands, 1000);

  // Iniciar servidor TCP principal (XT40 - 8877)
  tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`✅ Gateway ${GATEWAY_ID} [XT40] escutando em 0.0.0.0:${TCP_PORT}`);
  });

  // Iniciar servidor OBD2 (8878) se configurado
  if (tcpServerOBD2 && TCP_PORT_OBD2 > 0) {
    tcpServerOBD2.listen(TCP_PORT_OBD2, '0.0.0.0', () => {
      console.log(`✅ Gateway ${GATEWAY_ID} [OBD2] escutando em 0.0.0.0:${TCP_PORT_OBD2}`);
    });
  }

  // Iniciar servidor Teltonika (8879) se configurado
  if (tcpServerTeltonika && TELTONIKA_PORT > 0) {
    tcpServerTeltonika.listen(TELTONIKA_PORT, '0.0.0.0', () => {
      console.log(`✅ Gateway ${GATEWAY_ID} [Teltonika] escutando em 0.0.0.0:${TELTONIKA_PORT}`);
    });
  }

  console.log(`📊 Max conexões: ${MAX_CONNECTIONS}`);
  console.log(`⏱️  Timeout: ${CONNECTION_TIMEOUT / 1000}s\n`);

  // Estatísticas periódicas
  setInterval(() => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000);
    console.log(`[Gateway:${GATEWAY_ID}] 📊 Conexões: ${stats.connectionsCurrent} | Packets: ${stats.packetsReceived} | Publicados: ${stats.packetsPublished} | Erros: ${stats.errors} | Uptime: ${uptime}s`);
  }, 60000);
}

// ============ SHUTDOWN ============

async function shutdown(signal) {
  console.log(`\n🛑 [${signal}] Encerrando gateway ${GATEWAY_ID}...`);

  // Fechar novas conexões
  tcpServer.close();
  if (tcpServerOBD2) tcpServerOBD2.close();
  if (tcpServerTeltonika) tcpServerTeltonika.close();

  // Desconectar todas as sessões
  for (const [imei, socket] of activeConnections) {
    await redisStreams.removeSession(imei);
    socket.destroy();
  }

  // Desconectar Redis
  await redisStreams.disconnect();

  console.log(`✅ Gateway ${GATEWAY_ID} encerrado`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============ START ============
start().catch((error) => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});

module.exports = { tcpServer, activeConnections, stats };
