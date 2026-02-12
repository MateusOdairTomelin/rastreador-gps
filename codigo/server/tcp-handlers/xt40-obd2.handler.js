/**
 * Handler TCP para XT40 OBD2
 *
 * PORTA: 8878
 * TIPO: XT40_OBD2
 *
 * Este arquivo contém toda a lógica de processamento para dispositivos XT40 OBD2.
 * Pode ser modificado SEM afetar o handler do XT40 4F.
 *
 * Características do XT40 OBD2:
 * - Conectado na porta OBD2 do veículo
 * - Pode receber dados reais de OBD2 (RPM, temperatura, combustível)
 * - Ignição detectada por RPM ou CAN bus
 * - Alimentação via porta OBD2 (12V constante)
 *
 * NOTA: Este handler pode ser livremente modificado para ajustar
 * o comportamento do OBD2 sem risco de quebrar o XT40_4F.
 */

const gpsParser = require('../parsers/gps-parser');
const dispositivoService = require('../services/dispositivo.service');
const localizacaoService = require('../services/localizacao.service');
const obd2Service = require('../services/obd2.service');
const alarmeService = require('../services/alarme.service');
const heartbeatService = require('../services/heartbeat.service');
const viagemService = require('../services/viagem.service');
const comandoService = require('../services/comando.service');
const geofencingService = require('../services/geofencing.service');

const {
  registerConnection,
  removeConnection,
  setTensaoCache,
  getTensaoCache
} = require('./tcp-base');

// Tipo de dispositivo para esta porta
const DEVICE_TYPE = 'XT40_OBD2';
const PORT = 8878;

// ============ DETECÇÃO DE IGNIÇÃO PARA OBD2 ============
// XT40-OBDII: Usar ACC do dispositivo (bit do terminal info) como fonte principal
// NÃO usar tensão para detectar ignição - pode dar falso positivo
// O XT40-OBDII NÃO lê dados OBD reais, apenas usa o conector para alimentação
function detectarEstadoIgnicaoOBD2(data, obd2Data = null) {
  const velocidade = data.velocidade || 0;

  // PRIORIDADE 1: Se está em movimento, ignição está ligada
  if (velocidade > 3) {
    return 'moving';
  }

  // PRIORIDADE 2: Usar campo ignicao (ACC) do dispositivo - MAIS CONFIÁVEL
  // Este valor vem do bit ACC do terminal info no pacote 0x22
  if (data.ignicao === true || data.ignicao === 1) {
    return velocidade > 0 ? 'moving' : 'idle';
  }

  // PRIORIDADE 3: Se tem dados OBD2 com RPM (raro no XT40-OBDII)
  if (obd2Data && obd2Data.rpm !== undefined && obd2Data.rpm !== null) {
    if (obd2Data.rpm >= 500) {
      return 'idle'; // Motor ligado mas parado
    } else if (obd2Data.rpm > 0) {
      return 'acc_on'; // Meia chave ou motor desligando
    }
  }

  // NÃO usar tensão para detectar ignição no XT40-OBDII
  // A tensão pode estar alta mesmo com motor desligado (bateria carregada)

  // Se ACC = false e velocidade = 0, motor está desligado
  return 'off';
}

// ============ HANDLERS DE DADOS ============

async function handleLogin(imei, socket, parsedData) {
  console.log(`[XT40_OBD2:${PORT}] 🔑 Login de ${imei}`);

  // Registrar heartbeat
  const hbInfo = await heartbeatService.register(imei);
  console.log(`💓 [Heartbeat] #${hbInfo.count} from ${imei}`);

  // Atualizar/criar dispositivo como XT40_OBD2
  await dispositivoService.upsert(imei, {
    status: 'online',
    tipo: DEVICE_TYPE // Força o tipo para XT40_OBD2
  });

  // Armazenar conexão ativa
  registerConnection(imei, socket);
  comandoService.registerSocket(imei, socket);
  console.log(`📡 [Connection] Socket armazenado para ${imei} (${DEVICE_TYPE})`);

  // Configurar keepalive
  socket.setKeepAlive(true, 10000);
  socket.setTimeout(60000);

  console.log(`✅ [Login] Device ${imei} (${DEVICE_TYPE}) connected`);

  // Enviar comandos de reconfiguração IMEDIATAMENTE para dispositivos que precisam
  // (não pode esperar 5 segundos - dispositivo desconecta antes)
  setImmediate(async () => {
    await sendInitCommands(imei, socket);
  });
}

async function handleLocation(imei, parsedData) {
  const data = { ...parsedData.data, timestamp: parsedData.timestamp };

  // Buscar tensão do cache se não tiver no pacote atual
  if (data.tensao_principal === undefined || data.tensao_principal === null) {
    const cached = getTensaoCache(imei);
    if (cached) {
      data.tensao_principal = cached.tensao;
      console.log(`🔋 [Cache→Location] ${imei}: Usando tensão do cache: ${cached.tensao}V`);
    }
  }

  // Detectar estado de ignição para OBD2
  // TODO: Se tiver dados OBD2 recentes, usar RPM para detecção mais precisa
  const estadoIgnicao = detectarEstadoIgnicaoOBD2(data);
  data.ignicao = ['acc_on', 'idle', 'moving'].includes(estadoIgnicao);
  data.estado_ignicao = estadoIgnicao;

  console.log(`🌍 [GPS:${DEVICE_TYPE}] ${imei}: (${data.latitude}, ${data.longitude}) @ ${data.velocidade} km/h | Estado: ${estadoIgnicao}`);

  // Salvar localização
  await dispositivoService.upsert(imei, {
    status: 'online',
    estado_ignicao: estadoIgnicao
  });
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

  // Para OBD2, salvar dados extras como OBD2 se disponíveis
  if (data.odometro_embarcado !== undefined || data.hora_motor_embarcada !== undefined ||
      data.tensao_bateria !== undefined || data.percentual_bateria !== undefined) {
    console.log(`[Location→OBD2] ${imei}: Salvando dados OBD2 do pacote de localização...`);
    await obd2Service.create(imei, data);
  }

  // Processar viagem
  if (data.ignicao !== undefined || data.tensao_principal !== undefined || data.velocidade !== undefined) {
    await viagemService.processarLocalizacao(
      imei,
      data.ignicao,
      data.latitude,
      data.longitude,
      data.velocidade,
      data.timestamp || new Date(),
      data.tensao_principal
    );
  }

  console.log(`✅ [Location] Saved for ${imei}`);
}

async function handleOBD2(imei, parsedData) {
  const obd2Data = parsedData.data;

  await heartbeatService.register(imei);
  await dispositivoService.upsert(imei, { status: 'online' });

  // Validar dados OBD2
  const temDadosValidos = obd2Data.rpm !== null ||
                          obd2Data.temperatura_motor !== null ||
                          obd2Data.nivel_combustivel !== null ||
                          obd2Data.velocidade !== null;

  if (temDadosValidos) {
    console.log(`🔧 [OBD2:${DEVICE_TYPE}] ${imei}:`, {
      rpm: obd2Data.rpm,
      velocidade: obd2Data.velocidade,
      temperatura: obd2Data.temperatura_motor,
      combustivel: obd2Data.nivel_combustivel,
      odometro: obd2Data.odometro_embarcado,
      horimetro: obd2Data.hora_motor_embarcada
    });

    // Salvar dados OBD2
    await obd2Service.create(imei, obd2Data);

    // Atualizar estado de ignição baseado em RPM
    if (obd2Data.rpm !== null && obd2Data.rpm !== undefined) {
      const estado = obd2Data.rpm >= 500 ? 'idle' : 'off';
      await dispositivoService.upsert(imei, { estado_ignicao: estado });
      console.log(`🔑 [OBD2→Ignição] ${imei}: RPM=${obd2Data.rpm} → Estado: ${estado}`);
    }

    console.log(`✅ [OBD2] Dados salvos para ${imei}`);
  } else {
    console.log(`⚠️ [OBD2:${DEVICE_TYPE}] ${imei}: Dados inválidos ignorados`);
  }
}

async function handleStatus(imei, parsedData) {
  const statusData = parsedData.data || {};

  await heartbeatService.register(imei);

  // Salvar tensão no cache
  if (statusData.tensao_bateria !== undefined && statusData.tensao_bateria !== null) {
    const acc = statusData.acc === true || statusData.acc === 1;
    setTensaoCache(imei, statusData.tensao_bateria, acc);

    // XT40-OBD2: Usar ACC do dispositivo (mais confiável que tensão)
    // O ACC vem do bit 1 do terminal info no pacote 0x13
    // NÃO usar tensão para determinar ignição - pode dar falso positivo
    let estado = 'off';
    if (acc) {
      // ACC ligado = ignição ligada
      estado = 'idle'; // Motor ligado (parado)
    }
    // Se ACC = false, estado permanece 'off' (motor desligado)

    console.log(`🔋 [Status:${DEVICE_TYPE}] ${imei}: Tensão=${statusData.tensao_bateria}V, ACC=${acc}, Estado=${estado}`);

    await dispositivoService.upsert(imei, {
      status: 'online',
      estado_ignicao: estado
    });
  }

  console.log(`💓 [Status] ${imei} online (${DEVICE_TYPE})`);
}

async function handleAlarm(imei, parsedData) {
  await heartbeatService.register(imei);
  await dispositivoService.upsert(imei, { status: 'online' });

  const alarmData = parsedData.data;
  console.log(`🚨 [ALARM:${DEVICE_TYPE}] ${imei}:`, {
    tipo: alarmData.tipo_alarme,
    severidade: alarmData.severidade
  });

  await alarmeService.create(imei, alarmData);
}

async function handleSimInfo(imei, parsedData) {
  // Para OBD2, o pacote 0x94 pode conter dados diferentes
  // TODO: Verificar se OBD2 envia dados reais neste pacote
  await heartbeatService.register(imei);
  console.log(`📱 [SIM_INFO:${DEVICE_TYPE}] ${imei}: ICCID recebido`);
}

// ============ COMANDOS DE INICIALIZAÇÃO ============

// Lista de IMEIs que precisam de reconfiguração
const IMEIS_PARA_RECONFIGURAR = new Set([
  '356354871416435', // QIK8A12 - não está enviando localização em movimento
]);

/**
 * Constrói pacote de comando no formato Protocolo 0x80
 */
function buildCommandPacket(comando, serialNumber = 1) {
  const commandBuffer = Buffer.from(comando, 'ascii');
  const serverFlag = Buffer.from([0x00, 0x00, 0x00, 0x00]); // Server Flag
  const lengthOfCommand = 1 + 4 + commandBuffer.length;

  // Protocol 0x80
  const protocol = 0x80;

  // Montar info content
  const infoContent = Buffer.concat([
    Buffer.from([lengthOfCommand]),
    serverFlag,
    commandBuffer
  ]);

  // Serial Number (2 bytes, big endian)
  const serialBuffer = Buffer.alloc(2);
  serialBuffer.writeUInt16BE(serialNumber);

  // Calcular CRC dos dados (Protocol + Info Content + Serial)
  const crcData = Buffer.concat([
    Buffer.from([protocol]),
    infoContent,
    serialBuffer
  ]);

  // CRC16-ITU
  const crctab16 = [
    0x0000, 0x1189, 0x2312, 0x329B, 0x4624, 0x57AD, 0x6536, 0x74BF,
    0x8C48, 0x9DC1, 0xAF5A, 0xBED3, 0xCA6C, 0xDBE5, 0xE97E, 0xF8F7,
    0x1081, 0x0108, 0x3393, 0x221A, 0x56A5, 0x472C, 0x75B7, 0x643E,
    0x9CC9, 0x8D40, 0xBFDB, 0xAE52, 0xDAED, 0xCB64, 0xF9FF, 0xE876
  ];
  let fcs = 0xFFFF;
  for (let i = 0; i < crcData.length; i++) {
    fcs = (fcs >> 8) ^ crctab16[(fcs ^ crcData[i]) & 0x1F];
  }
  const crc = ~fcs & 0xFFFF;
  const crcBuffer = Buffer.alloc(2);
  crcBuffer.writeUInt16LE(crc);

  // Montar pacote completo
  const packet = Buffer.concat([
    Buffer.from([0x78, 0x78]),        // Start bits
    Buffer.from([crcData.length]),    // Packet length
    crcData,                          // Protocol + Info Content + Serial
    crcBuffer,                        // CRC
    Buffer.from([0x0D, 0x0A])         // Stop bits
  ]);

  return packet;
}

async function sendInitCommands(imei, socket) {
  try {
    // Verificar se este IMEI precisa de reconfiguração
    if (!IMEIS_PARA_RECONFIGURAR.has(imei)) {
      console.log(`📋 [Init:${DEVICE_TYPE}] ${imei} não precisa de reconfiguração`);
      return;
    }

    console.log(`🔧 [Init:${DEVICE_TYPE}] RECONFIGURANDO ${imei} - ativando transmissão em tempo real...`);

    // Comandos de configuração para ativar transmissão em tempo real
    const comandos = [
      '#55555#YUP#10#',      // Intervalo de upload: 10 segundos
      '#55555#YGPS#1#',      // Ativar GPS
      '#55555#YONLINE#1#',   // Modo online contínuo
      'SETLOCX22#',          // Ativa protocolo 0x22 com dados completos
    ];

    let serial = 1;
    for (const cmd of comandos) {
      try {
        const packet = buildCommandPacket(cmd, serial++);
        socket.write(packet);
        console.log(`📤 [Init:${DEVICE_TYPE}] ${imei}: Enviado "${cmd}"`);
        // Pequeno delay entre comandos
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (e) {
        console.error(`[Init:${DEVICE_TYPE}] Erro ao enviar "${cmd}":`, e.message);
      }
    }

    console.log(`✅ [Init:${DEVICE_TYPE}] Comandos de reconfiguração enviados para ${imei}`);

    // Remover da lista após enviar (não reenviar toda conexão)
    // IMEIS_PARA_RECONFIGURAR.delete(imei); // Comentado para tentar várias vezes

  } catch (error) {
    console.error(`[Init:${DEVICE_TYPE}] Erro ao enviar comandos:`, error.message);
  }
}

// ============ HANDLER PRINCIPAL ============

async function handlePacket(socket, packet, imei, sessionImei, parsedData) {
  if (!parsedData || !imei) return;

  try {
    switch (parsedData.type) {
      case 'login':
        await handleLogin(imei, socket, parsedData);
        break;

      case 'location':
        await handleLocation(imei, parsedData);
        break;

      case 'obd2':
        // OBD2 REAL - processa dados de diagnóstico
        await handleOBD2(imei, parsedData);
        break;

      case 'status':
      case 'heartbeat':
        await handleStatus(imei, parsedData);
        break;

      case 'alarm':
        await handleAlarm(imei, parsedData);
        break;

      case 'sim_info':
        await handleSimInfo(imei, parsedData);
        break;

      default:
        console.log(`[TCP:${DEVICE_TYPE}] ${imei}: Tipo desconhecido: ${parsedData.type}`);
    }
  } catch (error) {
    console.error(`[TCP:${DEVICE_TYPE}] Erro processando pacote:`, error.message);
  }
}

// ============ CRIAR SERVIDOR ============

function createServer(dependencies = {}) {
  const { createTCPServer } = require('./tcp-base');
  const apiRoutes = dependencies.apiRoutes;

  const server = createTCPServer({
    port: PORT,
    deviceType: DEVICE_TYPE,

    onConnection: (socket, sessionKey) => {
      console.log(`[XT40_OBD2] Nova conexão: ${sessionKey}`);
    },

    onData: async (socket, packet, imei, sessionImei) => {
      try {
        const parsedData = gpsParser.parse(packet);

        if (parsedData) {
          // ✅ CRÍTICO: Enviar ACK IMEDIATAMENTE (antes de qualquer operação async)
          // O dispositivo espera ACK rápido (<2s), se demorar ele desconecta
          if (parsedData.ack && !socket.destroyed) {
            socket.write(parsedData.ack);
            console.log(`[ACK:${DEVICE_TYPE}] ✅ Enviado IMEDIATAMENTE para ${imei || sessionImei}`);
          }

          // Registrar estatísticas
          if (apiRoutes) {
            apiRoutes.recordPacket(parsedData.type);
            apiRoutes.recordPacketDetails({
              type: parsedData.type,
              protocolNumber: `0x${parsedData.protocolNumber.toString(16).padStart(2, '0')}`,
              imei: imei || sessionImei || 'unknown',
              timestamp: parsedData.timestamp.toISOString(),
              deviceType: DEVICE_TYPE
            });
          }

          // Processar pacote (agora em background, ACK já foi enviado)
          await handlePacket(socket, packet, imei || sessionImei, sessionImei, parsedData);
        }
      } catch (error) {
        console.error(`[XT40_OBD2] Erro:`, error.message);
      }
    },

    onClose: (socket, sessionKey, sessionImei) => {
      if (sessionImei) {
        removeConnection(sessionImei);
        dispositivoService.upsert(sessionImei, { status: 'offline' }).catch(() => {});
      }
    },

    onError: (socket, error, sessionKey) => {
      console.error(`[XT40_OBD2] Erro socket ${sessionKey}:`, error.message);
    }
  });

  return server;
}

module.exports = {
  DEVICE_TYPE,
  PORT,
  createServer,
  handlePacket,
  handleLogin,
  handleLocation,
  handleOBD2,
  handleStatus,
  handleAlarm,
  handleSimInfo,
  detectarEstadoIgnicaoOBD2
};
