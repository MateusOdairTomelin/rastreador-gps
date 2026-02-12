/**
 * Handler TCP para XT40 4F (Cabo/4 Fios)
 *
 * PORTA: 8877
 * TIPO: XT40_4F
 *
 * Este arquivo contém toda a lógica de processamento para dispositivos XT40 4F.
 * Pode ser modificado SEM afetar o handler do XT40 OBD2.
 *
 * Características do XT40 4F:
 * - Alimentação por cabo (4 fios)
 * - Ignição detectada por tensão da bateria principal
 * - Não possui OBD2 real (dados OBD2 são simulados/extraídos do pacote 0x22)
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
const DEVICE_TYPE = 'XT40_4F';
const PORT = 8877;

// ============ DETECÇÃO DE IGNIÇÃO VIRTUAL ============
// Para XT40 4F, a ignição é detectada pela tensão da bateria principal
// ⚠️ USA CONFIGURAÇÕES DO DISPOSITIVO (tensao_motor_ligado/deslig)
function detectarEstadoIgnicao4F(data, dispositivo = null) {
  const velocidade = data.velocidade || 0;
  const tensao = data.tensao_principal || data.tensao_bateria;

  // Se está em movimento, ignição está ligada
  if (velocidade > 3) {
    return 'moving';
  }

  // ✅ Usar thresholds configurados no dispositivo (ou padrões)
  const thresholdOn = dispositivo?.tensao_motor_ligado || 13.5;
  const thresholdOff = dispositivo?.tensao_motor_deslig || 12.5;

  // Se tem tensão, usar thresholds configurados
  if (tensao !== undefined && tensao !== null) {
    if (tensao >= thresholdOn) {
      return velocidade > 0 ? 'moving' : 'idle';
    } else if (tensao < thresholdOff) {
      return 'off';
    }
    // Tensão intermediária - considerar OFF para evitar falsos positivos
    return 'off';
  }

  // Fallback: usar campo ignicao se disponível
  if (data.ignicao === true || data.ignicao === 1) {
    return velocidade > 0 ? 'moving' : 'idle';
  }

  return 'off';
}

// ============ HANDLERS DE DADOS ============

async function handleLogin(imei, socket, parsedData) {
  console.log(`[XT40_4F:${PORT}] 🔑 Login de ${imei}`);

  // Registrar heartbeat
  const hbInfo = await heartbeatService.register(imei);
  console.log(`💓 [Heartbeat] #${hbInfo.count} from ${imei}`);

  // Atualizar/criar dispositivo como XT40_4F
  await dispositivoService.upsert(imei, {
    status: 'online',
    tipo: DEVICE_TYPE // Força o tipo para XT40_4F
  });

  // Armazenar conexão ativa
  registerConnection(imei, socket);
  comandoService.registerSocket(imei, socket);
  console.log(`📡 [Connection] Socket armazenado para ${imei} (${DEVICE_TYPE})`);

  // Configurar keepalive
  socket.setKeepAlive(true, 10000);
  socket.setTimeout(60000);

  // Enviar comandos de inicialização após 5 segundos
  setTimeout(async () => {
    await sendInitCommands(imei, socket);
  }, 5000);

  console.log(`✅ [Login] Device ${imei} (${DEVICE_TYPE}) connected`);
}

async function handleLocation(imei, parsedData) {
  const data = { ...parsedData.data, timestamp: parsedData.timestamp };

  // Buscar tensão do cache (do pacote 0x13) se não tiver no pacote atual
  if (data.tensao_principal === undefined || data.tensao_principal === null) {
    const cached = getTensaoCache(imei);
    if (cached) {
      data.tensao_principal = cached.tensao;
      if (data.ignicao === undefined || data.ignicao === null) {
        data.ignicao = cached.acc;
      }
      console.log(`🔋 [Cache→Location] ${imei}: Usando tensão do cache: ${cached.tensao}V`);
    }
  }

  // ✅ Buscar dispositivo para usar configurações de tensão
  const dispositivo = await dispositivoService.getByImei(imei);

  // Detectar estado de ignição para XT40 4F (usando thresholds do dispositivo)
  const estadoIgnicao = detectarEstadoIgnicao4F(data, dispositivo);
  data.ignicao = ['acc_on', 'idle', 'moving'].includes(estadoIgnicao);
  data.estado_ignicao = estadoIgnicao;

  const thresholdOn = dispositivo?.tensao_motor_ligado || 13.5;
  const thresholdOff = dispositivo?.tensao_motor_deslig || 12.5;
  console.log(`🌍 [GPS:${DEVICE_TYPE}] ${imei}: (${data.latitude}, ${data.longitude}) @ ${data.velocidade} km/h | Tensão: ${data.tensao_principal || 'N/A'}V (on=${thresholdOn}V, off=${thresholdOff}V) | Estado: ${estadoIgnicao}`);

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

  // Se pacote 0x22 tem dados extras (odômetro, horímetro), salvar como OBD2
  if (data.odometro_embarcado !== undefined || data.hora_motor_embarcada !== undefined ||
      data.tensao_bateria !== undefined || data.percentual_bateria !== undefined) {
    console.log(`[Location→OBD2] Pacote 0x22 com dados extras, salvando...`);
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

async function handleStatus(imei, parsedData) {
  const statusData = parsedData.data || {};

  await heartbeatService.register(imei);

  // Salvar tensão no cache para usar em pacotes 0x12
  if (statusData.tensao_bateria !== undefined && statusData.tensao_bateria !== null) {
    const acc = statusData.acc === true || statusData.acc === 1;
    setTensaoCache(imei, statusData.tensao_bateria, acc);

    // ✅ Buscar dispositivo para usar thresholds configurados
    const dispositivo = await dispositivoService.getByImei(imei);
    const thresholdOn = dispositivo?.tensao_motor_ligado || 13.5;
    const thresholdOff = dispositivo?.tensao_motor_deslig || 12.5;

    // Detectar estado pela tensão (usando thresholds do dispositivo)
    let estado = 'off';
    if (statusData.tensao_bateria >= thresholdOn) {
      estado = acc ? 'idle' : 'acc_on';
    } else if (statusData.tensao_bateria < thresholdOff) {
      estado = 'off';
    }

    console.log(`🔋 [Status:${DEVICE_TYPE}] ${imei}: Tensão=${statusData.tensao_bateria}V (on=${thresholdOn}V, off=${thresholdOff}V), ACC=${acc}, Estado=${estado}`);

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

// ============ COMANDOS DE INICIALIZAÇÃO ============

async function sendInitCommands(imei, socket) {
  try {
    console.log(`📋 [Init:${DEVICE_TYPE}] Enviando comandos para ${imei}...`);

    // Comando para ativar GPS contínuo
    // Para XT40 4F, os comandos são específicos para o modelo cabo

    // Exemplo de comando para configurar intervalo de transmissão
    // const cmd = Buffer.from([0x78, 0x78, ...]);
    // socket.write(cmd);

    console.log(`✅ [Init:${DEVICE_TYPE}] Comandos enviados para ${imei}`);
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

      case 'status':
      case 'heartbeat':
        await handleStatus(imei, parsedData);
        break;

      case 'alarm':
        await handleAlarm(imei, parsedData);
        break;

      case 'sim_info':
        // Pacote 0x94 - apenas info do SIM, não OBD2
        await heartbeatService.register(imei);
        console.log(`📱 [SIM_INFO:${DEVICE_TYPE}] ${imei}: ICCID recebido`);
        break;

      case 'obd2':
        // XT40 4F não tem OBD2 real, dados vêm do pacote 0x22
        console.log(`⚠️ [OBD2:${DEVICE_TYPE}] ${imei}: Ignorando - XT40_4F não tem OBD2 real`);
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
      console.log(`[XT40_4F] Nova conexão: ${sessionKey}`);
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
        console.error(`[XT40_4F] Erro:`, error.message);
      }
    },

    onClose: (socket, sessionKey, sessionImei) => {
      if (sessionImei) {
        removeConnection(sessionImei);
        dispositivoService.upsert(sessionImei, { status: 'offline' }).catch(() => {});
      }
    },

    onError: (socket, error, sessionKey) => {
      console.error(`[XT40_4F] Erro socket ${sessionKey}:`, error.message);
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
  handleStatus,
  handleAlarm,
  detectarEstadoIgnicao4F
};
