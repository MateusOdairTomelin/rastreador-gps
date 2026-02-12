# 🔧 GUIA DE IMPLEMENTAÇÃO DAS CORREÇÕES

## 📋 O QUE FAZER

Você tem **7 correções críticas** para implementar. Este guia mostra EXATAMENTE como fazer isso.

---

## ✅ CORREÇÃO #1: Session IMEI Mapping (CRÍTICA)

### Por que é importante?
Sem isso, pacotes de LOCATION (0x12) e OBD2 (0x94) usam "test-device-001" fake.

### Passo 1: Editar `/home/tomelin/rastreador/server/index.js`

Encontre a função `extractIMEI` (por volta da linha 102) e SUBSTITUA:

**ANTES:**
```javascript
function extractIMEI(buffer) {
  const protocolNumber = buffer.readUInt8(3);
  if (protocolNumber === 0x01) {
    return buffer.slice(4, 12).toString('hex');
  }
  return 'test-device-001'; // ❌ ERRADO!
}
```

**DEPOIS:**
```javascript
// Mapa global de sessões TCP
const sessionImeiMap = new Map();

function getSessionKey(socket) {
  return `${socket.remoteAddress}:${socket.remotePort}`;
}
```

### Passo 2: Modificar o TCP Server

Encontre a seção `const tcpServer = net.createServer((socket) => {` (por volta da linha 173)

SUBSTITUA TODO o socket.on('data'...) por:

```javascript
const tcpServer = net.createServer((socket) => {
  const sessionKey = getSessionKey(socket);
  let sessionImei = null;

  console.log(`[TCP] Cliente conectado: ${sessionKey}`);

  socket.on('data', async (data) => {
    try {
      // Parse do pacote
      const parsedData = gpsParser.parse(data);

      if (!parsedData) {
        console.log(`[TCP] Pacote inválido de ${sessionKey}`);
        return;
      }

      // Se é LOGIN (0x01), registra IMEI da sessão
      if (parsedData.type === 'login' && parsedData.details?.imei) {
        sessionImei = parsedData.details.imei;
        sessionImeiMap.set(sessionKey, sessionImei);
        console.log(`[TCP] IMEI registrado para sessão: ${sessionImei}`);
      }

      // Para outros pacotes, usa IMEI da sessão
      const targetImei = parsedData.details?.imei || sessionImei;

      if (!targetImei) {
        console.warn(`[TCP] Pacote sem IMEI: tipo ${parsedData.type}, sessão ${sessionKey}`);
        return;
      }

      // Agora temos IMEI garantido para TODOS os pacotes!
      console.log(`[TCP] Processando pacote ${parsedData.type} para IMEI: ${targetImei}`);

      // Roteia por tipo
      const dataType = parsedData.type.toLowerCase();
      switch (dataType) {
        case 'login':
          await handleLoginData(targetImei, parsedData.details);
          break;
        case 'location':
          await handleLocationData(targetImei, parsedData.details);
          break;
        case 'obd2':
          await handleOBD2Data(targetImei, parsedData.details);
          break;
        case 'alarm':
          await handleAlarmData(targetImei, parsedData.details);
          break;
        default:
          console.log(`[TCP] Tipo desconhecido: ${dataType}`);
      }

      // Enviar ACK
      const ack = gpsParser.createAckResponse(parsedData.protocol, parsedData.serial);
      if (ack) {
        socket.write(ack);
        console.log(`[TCP] Enviando ACK (${ack.length} bytes): ${ack.toString('hex')}`);
      }

    } catch (error) {
      console.error(`[TCP] Erro ao processar: ${error.message}`);
    }
  });

  socket.on('end', () => {
    sessionImeiMap.delete(sessionKey);
    console.log(`[TCP] Cliente desconectado: ${sessionKey}`);
  });

  socket.on('error', (error) => {
    console.error(`[TCP] Erro na conexão ${sessionKey}: ${error.message}`);
  });
});
```

---

## ✅ CORREÇÃO #2: CRC Validation (CRÍTICA)

### Por que é importante?
Detectar pacotes corrompidos na transmissão.

### Passo 1: Editar `/home/tomelin/rastreador/server/parsers/gps-parser.js`

Encontre a função `parse()` e ADICIONE validação de CRC logo após validação do header:

```javascript
parse(buffer) {
  // Validações existentes...
  if (buffer.length < 10) {
    throw new Error('Packet too short');
  }

  const hex = buffer.toString('hex').toUpperCase();
  if (!hex.startsWith('7878') && !hex.startsWith('7979')) {
    throw new Error('Invalid header');
  }

  // ✅ NOVO: Validar CRC
  try {
    const isValid = this.validateCRC(buffer);
    if (!isValid) {
      console.warn(`[Parser] CRC validation failed: ${hex.substring(0, 50)}...`);
      throw new Error('CRC validation failed');
    }
  } catch (e) {
    console.error(`[Parser] CRC error: ${e.message}`);
    throw e;
  }

  // ... resto da função ...
}
```

### Passo 2: Adicionar Método de Validação

ADICIONE este método na classe `PacketAnalyzer`:

```javascript
validateCRC(buffer) {
  try {
    // Tamanho do pacote: header(2) + length(1) + data + crc(1) + footer(2)
    const length = buffer.readUInt8(2);
    const packetLength = length + 5; // header + length + crc + footer

    if (buffer.length < packetLength) {
      throw new Error(`Buffer too short: ${buffer.length} < ${packetLength}`);
    }

    // Posição do CRC: header(2) + length(1) + data(length)
    const crcPos = 2 + 1 + length;
    const expectedCrc = buffer.readUInt8(crcPos);

    // Calcular CRC dos dados (do byte 2 até antes do CRC)
    const dataBuffer = buffer.slice(2, crcPos);
    const calculatedCrc = this.calculateCRC(dataBuffer, 0, dataBuffer.length);

    const isValid = expectedCrc === calculatedCrc;

    if (!isValid) {
      console.warn(
        `[CRC] Mismatch: expected ${expectedCrc.toString(16)}, ` +
        `got ${calculatedCrc.toString(16)}`
      );
    }

    return isValid;
  } catch (error) {
    console.error(`[CRC] Validation error: ${error.message}`);
    return false;
  }
}
```

---

## ✅ CORREÇÃO #3: Packet Buffer Reassembly (CRÍTICA)

### Por que é importante?
TCP pode fragmentar pacotes. Sem reassembly, perdem-se pacotes.

### Passo 1: Criar Classe PacketBuffer

**Edite:** `/home/tomelin/rastreador/server/tcp-packet-buffer.js` (NOVO ARQUIVO)

```javascript
const Logger = require('./logger');
const logger = new Logger('PacketBuffer');

class TCPPacketBuffer {
  constructor(maxSize = 1024 * 10) {
    this.buffer = Buffer.alloc(0);
    this.packets = [];
    this.maxSize = maxSize;
  }

  /**
   * Adiciona dados brutos do socket TCP
   */
  append(chunk) {
    if (!chunk || chunk.length === 0) return;

    // Proteger contra buffer overflow
    if (this.buffer.length + chunk.length > this.maxSize) {
      logger.warn(`Buffer overflow protection: dropping old data`);
      this.buffer = Buffer.alloc(0);
    }

    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.extractCompletePackets();
  }

  /**
   * Extrai pacotes completos do buffer
   */
  extractCompletePackets() {
    let offset = 0;

    while (offset < this.buffer.length) {
      // Procura por header (0x7878 ou 0x7979)
      const headerIdx = this.findHeader(offset);

      if (headerIdx === -1) {
        // Nenhum header encontrado, descarta dados antigos
        this.buffer = this.buffer.slice(offset);
        break;
      }

      // Pula dados antes do header
      if (headerIdx > offset) {
        offset = headerIdx;
      }

      // Tenta extrair pacote completo
      const packet = this.tryExtractPacket(offset);

      if (!packet) {
        // Pacote incompleto, aguarda mais dados
        this.buffer = this.buffer.slice(offset);
        break;
      }

      // Pacote completo encontrado
      this.packets.push(packet.data);
      offset = packet.nextOffset;
    }

    // Remove dados processados
    this.buffer = this.buffer.slice(offset);
  }

  /**
   * Procura por header 0x7878 ou 0x7979 a partir de offset
   */
  findHeader(offset = 0) {
    for (let i = offset; i < this.buffer.length - 1; i++) {
      const b1 = this.buffer[i];
      const b2 = this.buffer[i + 1];

      if ((b1 === 0x78 && b2 === 0x78) || (b1 === 0x79 && b2 === 0x79)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Tenta extrair um pacote completo começando em offset
   */
  tryExtractPacket(offset) {
    if (offset + 4 > this.buffer.length) {
      // Não tem nem header + length
      return null;
    }

    // Lê tamanho do pacote (na posição offset+2)
    const length = this.buffer.readUInt8(offset + 2);

    // Tamanho total: header(2) + length(1) + data(length) + crc(1) + footer(2)
    const totalSize = 2 + 1 + length + 1 + 2;

    if (offset + totalSize > this.buffer.length) {
      // Pacote incompleto
      return null;
    }

    // Verifica footer (0x0D0A)
    const footerPos = offset + totalSize - 2;
    const footer = this.buffer.readUInt16BE(footerPos);

    if (footer !== 0x0D0A) {
      logger.warn(
        `Invalid footer: ${footer.toString(16)} at offset ${footerPos}, ` +
        `expected 0x0D0A`
      );
      // Tenta próximo header
      return this.tryExtractPacket(offset + 1);
    }

    // Pacote válido!
    const packet = this.buffer.slice(offset, offset + totalSize);

    return {
      data: packet,
      nextOffset: offset + totalSize,
    };
  }

  /**
   * Retorna pacotes extraídos e limpa lista
   */
  getPackets() {
    const result = this.packets;
    this.packets = [];
    return result;
  }

  /**
   * Retorna tamanho do buffer (para debug)
   */
  getSize() {
    return this.buffer.length;
  }

  /**
   * Limpa o buffer (para reset)
   */
  clear() {
    this.buffer = Buffer.alloc(0);
    this.packets = [];
  }
}

module.exports = TCPPacketBuffer;
```

### Passo 2: Usar PacketBuffer no TCP Server

**Edite:** `/home/tomelin/rastreador/server/index.js`

Na parte do TCP server, MUDE:

**ANTES:**
```javascript
socket.on('data', async (data) => {
  const parsedData = gpsParser.parse(data);
  // ...
});
```

**DEPOIS:**
```javascript
const TCPPacketBuffer = require('./tcp-packet-buffer');
const packetBuffer = new TCPPacketBuffer();

socket.on('data', async (rawData) => {
  packetBuffer.append(rawData);

  const packets = packetBuffer.getPackets();

  for (const packet of packets) {
    try {
      const parsedData = gpsParser.parse(packet);
      // ... rest of processing ...
    } catch (error) {
      console.error(`[Parser] Error: ${error.message}`);
    }
  }
});
```

---

## ✅ CORREÇÃO #4: Timezone & Timestamp UTC (IMPORTANTE)

**Edite:** `/home/tomelin/rastreador/server/parsers/gps-parser.js`

Encontre a função `parseLocation()` e MUDE:

**ANTES:**
```javascript
const timestamp = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
```

**DEPOIS:**
```javascript
// Criar timestamp em UTC (GT06 usa UTC)
const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
const timestamp = date.toISOString(); // Formato ISO 8601
```

---

## ✅ CORREÇÃO #5: Validação de Coordenadas (IMPORTANTE)

**Edite:** `/home/tomelin/rastreador/server/parsers/gps-parser.js`

Na função `parseLocation()`, APÓS extrair latitude/longitude, ADICIONE:

```javascript
// Validar ranges
if (latitude < -90 || latitude > 90) {
  return { error: `Invalid latitude: ${latitude}` };
}
if (longitude < -180 || longitude > 180) {
  return { error: `Invalid longitude: ${longitude}` };
}

// Detectar sem satélites (coordenadas 0,0)
if (latitude === 0 && longitude === 0) {
  console.warn(`[GPS] No satellite lock - coordinates are 0,0`);
}
```

---

## ✅ CORREÇÃO #6: Heartbeat Persistence (IMPORTANTE)

**Edite:** `/home/tomelin/rastreador/server/services/heartbeat.service.js`

ADICIONE persistência ao banco:

```javascript
async persistToDatabase(imei) {
  try {
    await prisma.dispositivos.update({
      where: { imei },
      data: {
        ultima_conexao: new Date(),
        status: 'online',
      },
    });
  } catch (error) {
    console.error(`[Heartbeat] Persist error for ${imei}: ${error.message}`);
  }
}

async register(imei) {
  // Registrar em memoria
  if (!this.heartbeats.has(imei)) {
    this.heartbeats.set(imei, { count: 0, lastSeen: null });
  }

  const record = this.heartbeats.get(imei);
  record.count++;
  record.lastSeen = new Date();

  // ✅ NOVO: Persistir no banco também
  await this.persistToDatabase(imei);
}
```

**NO STARTUP DO SERVIDOR**, adicione (procure por onde os services são inicializados):

```javascript
// Persistir heartbeats a cada 30 segundos
setInterval(async () => {
  for (const [imei, data] of heartbeatService.heartbeats) {
    await heartbeatService.persistToDatabase(imei);
  }
}, 30000);
```

---

## ✅ CORREÇÃO #7: Rate Limiting (IMPORTANTE)

**Edite:** `/home/tomelin/rastreador/server/index.js`

NO INÍCIO DO ARQUIVO, ADICIONE:

```javascript
// Rate limiting map
const clientRateLimits = new Map();

function checkRateLimit(clientId, maxPacketsPerSecond = 100) {
  const now = Date.now();

  if (!clientRateLimits.has(clientId)) {
    clientRateLimits.set(clientId, {
      packets: 0,
      resetAt: now + 1000,
    });
    return true;
  }

  const limits = clientRateLimits.get(clientId);

  // Reset a cada segundo
  if (now > limits.resetAt) {
    limits.packets = 0;
    limits.resetAt = now + 1000;
  }

  limits.packets++;

  if (limits.packets > maxPacketsPerSecond) {
    return false;
  }

  return true;
}
```

NO TCP SERVER, antes de processar dados:

```javascript
socket.on('data', async (rawData) => {
  const clientId = getSessionKey(socket);

  // ✅ NOVO: Verificar rate limit
  if (!checkRateLimit(clientId, 100)) {
    console.warn(`[RateLimit] Exceeded for ${clientId}, closing connection`);
    socket.destroy();
    return;
  }

  packetBuffer.append(rawData);
  // ... resto do código ...
});
```

---

## 🧪 COMO TESTAR AS CORREÇÕES

### Teste 1: Session IMEI
```bash
# Enviar LOGIN, depois LOCATION
# Verificar que LOCATION usa IMEI correto (não "test-device-001")
tail -f /tmp/server.log | grep "Processando pacote"
```

### Teste 2: CRC Validation
```bash
# Modificar um byte de um pacote para corromper CRC
# Verificar que é rejeitado
tail -f /tmp/server.log | grep "CRC validation"
```

### Teste 3: Fragmentação
```bash
# Simular envio de pacote fragmentado
# Verificar que é reassemblado corretamente
tail -f /tmp/server.log | grep "PacketBuffer"
```

### Teste 4: Rate Limiting
```bash
# Enviar 1000 pacotes/s de um dispositivo
# Verificar que conexão é fechada após 100 pacotes
tail -f /tmp/server.log | grep "RateLimit"
```

---

## ✅ CHECKLIST IMPLEMENTAÇÃO

- [ ] Correção #1: Session IMEI implementada
- [ ] Correção #2: CRC validation implementada
- [ ] Correção #3: Packet buffer reassembly implementada
- [ ] Correção #4: Timezone UTC implementada
- [ ] Correção #5: Validação de coords implementada
- [ ] Correção #6: Heartbeat persistence implementada
- [ ] Correção #7: Rate limiting implementada
- [ ] Servidor reiniciado
- [ ] Testes executados
- [ ] Dados de LOCATION chegando corretamente

---

**Tempo Estimado:** 2-3 horas para implementar + 1 hora para testar

