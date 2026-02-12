/**
 * TCP Base - Utilitários compartilhados entre handlers TCP
 *
 * Este arquivo contém funcionalidades comuns usadas por todos os handlers TCP.
 * NÃO MODIFICAR a menos que queira afetar TODOS os tipos de dispositivos.
 */

const net = require('net');

// ============ PACKET BUFFER ============
// Buffer para reassembly de pacotes fragmentados
class TCPPacketBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.totalPacketsExtracted = 0;
  }

  append(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  getPackets() {
    const packets = [];

    while (this.buffer.length >= 5) {
      // Verificar header válido (0x78 0x78 ou 0x79 0x79)
      if ((this.buffer[0] === 0x78 && this.buffer[1] === 0x78) ||
          (this.buffer[0] === 0x79 && this.buffer[1] === 0x79)) {

        // Determinar tamanho do pacote
        let packetLength;
        if (this.buffer[0] === 0x78) {
          // Pacote curto: header(2) + length(1) + data + serial(2) + crc(2) + footer(2)
          packetLength = this.buffer[2] + 5; // length byte + header(2) + footer(2)
        } else {
          // Pacote longo: header(2) + length(2) + data + serial(2) + crc(2) + footer(2)
          packetLength = (this.buffer[2] << 8 | this.buffer[3]) + 6;
        }

        // Verificar se temos o pacote completo
        if (this.buffer.length >= packetLength) {
          // Verificar footer válido
          if (this.buffer[packetLength - 2] === 0x0D && this.buffer[packetLength - 1] === 0x0A) {
            packets.push(this.buffer.slice(0, packetLength));
            this.buffer = this.buffer.slice(packetLength);
            this.totalPacketsExtracted++;
          } else {
            // Footer inválido - descartar byte e tentar novamente
            this.buffer = this.buffer.slice(1);
          }
        } else {
          // Pacote incompleto - aguardar mais dados
          break;
        }
      } else {
        // Header inválido - descartar byte e tentar novamente
        this.buffer = this.buffer.slice(1);
      }
    }

    return packets;
  }

  getStats() {
    return {
      totalPacketsExtracted: this.totalPacketsExtracted,
      currentBufferSize: this.buffer.length
    };
  }

  clear() {
    this.buffer = Buffer.alloc(0);
  }
}

// ============ RATE LIMITER ============
const rateLimitMap = new Map();

function checkRateLimit(clientId, maxPerSecond = 100) {
  const now = Date.now();
  const windowMs = 1000;

  if (!rateLimitMap.has(clientId)) {
    rateLimitMap.set(clientId, { count: 1, windowStart: now });
    return true;
  }

  const entry = rateLimitMap.get(clientId);

  if (now - entry.windowStart > windowMs) {
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }

  entry.count++;
  return entry.count <= maxPerSecond;
}

// ============ SESSION MANAGEMENT ============
const sessionImeiMap = new Map();

function getSessionKey(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}

function registerSession(socket, imei) {
  const key = getSessionKey(socket);
  sessionImeiMap.set(key, imei);
}

function getSessionImei(socket) {
  const key = getSessionKey(socket);
  return sessionImeiMap.get(key);
}

function clearSession(socket) {
  const key = getSessionKey(socket);
  sessionImeiMap.delete(key);
}

// ============ IMEI EXTRACTION ============
function extractIMEI(data) {
  // Protocol 0x01 (Login): IMEI starts at byte 4
  if (data.length >= 12 && data[0] === 0x78 && data[1] === 0x78) {
    const protocolNumber = data[3];

    if (protocolNumber === 0x01) {
      // Login packet: IMEI is 8 bytes starting at position 4
      const imeiBytes = data.slice(4, 12);
      let imei = '';
      for (let i = 0; i < imeiBytes.length; i++) {
        imei += imeiBytes[i].toString(16).padStart(2, '0');
      }
      // Remove leading zeros and limit to 15 chars
      imei = imei.replace(/^0+/, '');
      if (imei.length > 15) imei = imei.substring(0, 15);
      return imei;
    }
  }
  return null;
}

// ============ ACTIVE CONNECTIONS ============
const activeConnections = new Map();

function registerConnection(imei, socket) {
  activeConnections.set(imei, socket);
}

function getConnection(imei) {
  return activeConnections.get(imei);
}

function removeConnection(imei) {
  activeConnections.delete(imei);
}

// ============ TENSION CACHE ============
// Cache de tensão para compartilhar entre pacotes 0x13 (status) e 0x12 (location)
const tensaoCache = new Map();

function setTensaoCache(imei, tensao, acc) {
  tensaoCache.set(imei, {
    tensao,
    acc,
    timestamp: new Date()
  });
}

function getTensaoCache(imei, maxAgeSeconds = 300) {
  const cached = tensaoCache.get(imei);
  if (!cached) return null;

  const age = (new Date() - cached.timestamp) / 1000;
  if (age > maxAgeSeconds) return null;

  return cached;
}

// ============ CRIAR SERVIDOR TCP ============
function createTCPServer(options = {}) {
  const {
    port,
    deviceType,
    onConnection,
    onData,
    onClose,
    onError
  } = options;

  const server = net.createServer((socket) => {
    const sessionKey = getSessionKey(socket);
    const packetBuffer = new TCPPacketBuffer();
    let sessionImei = null;

    console.log(`[TCP:${port}] Cliente conectado: ${sessionKey} (${deviceType})`);

    if (onConnection) {
      onConnection(socket, sessionKey, deviceType);
    }

    socket.on('data', async (rawData) => {
      // Verificar rate limit
      if (!checkRateLimit(sessionKey, 100)) {
        console.warn(`[RateLimit:${port}] Exceeded for ${sessionKey}, closing connection`);
        socket.destroy();
        return;
      }

      // Log resumido
      const hexPreview = rawData.length > 32
        ? rawData.slice(0, 32).toString('hex').toUpperCase() + '...'
        : rawData.toString('hex').toUpperCase();
      console.log(`[TCP:${port}] 📦 Recebido ${rawData.length} bytes | Preview: ${hexPreview}`);

      try {
        // Adicionar ao buffer e extrair pacotes completos
        packetBuffer.append(rawData);
        const packets = packetBuffer.getPackets();

        for (const packet of packets) {
          // Tentar extrair IMEI
          let imei = extractIMEI(packet);
          if (!imei && sessionImei) {
            imei = sessionImei;
          }

          // Normalizar IMEI
          if (imei) {
            if (imei.startsWith('0') && imei.length === 16) {
              imei = imei.substring(1);
            }
            imei = imei.substring(0, 15);

            // Registrar na sessão se for login
            if (packet[3] === 0x01) {
              sessionImei = imei;
              registerSession(socket, imei);
            }
          }

          // Chamar handler de dados
          if (onData) {
            await onData(socket, packet, imei, sessionImei, deviceType);
          }
        }
      } catch (error) {
        console.error(`[TCP:${port}] Erro processando dados:`, error.message);
      }
    });

    socket.on('close', () => {
      console.log(`[TCP:${port}] Cliente desconectado: ${sessionKey}`);
      if (sessionImei) {
        removeConnection(sessionImei);
      }
      clearSession(socket);
      if (onClose) {
        onClose(socket, sessionKey, sessionImei, deviceType);
      }
    });

    socket.on('error', (error) => {
      console.error(`[TCP:${port}] Erro no socket ${sessionKey}:`, error.message);
      if (onError) {
        onError(socket, error, sessionKey, deviceType);
      }
    });

    socket.on('timeout', () => {
      console.log(`[TCP:${port}] Timeout para ${sessionKey}`);
      socket.destroy();
    });
  });

  return server;
}

module.exports = {
  TCPPacketBuffer,
  checkRateLimit,
  getSessionKey,
  registerSession,
  getSessionImei,
  clearSession,
  extractIMEI,
  activeConnections,
  registerConnection,
  getConnection,
  removeConnection,
  tensaoCache,
  setTensaoCache,
  getTensaoCache,
  createTCPServer
};
