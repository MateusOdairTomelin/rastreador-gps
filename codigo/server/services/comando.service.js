/**
 * Serviço para envio de comandos para rastreadores via Protocolo 0x80
 * Baseado na documentação XT40 Protocol Rev 1.06 - Seção 6
 */
class ComandoService {
  constructor() {
    // Map para armazenar sockets ativos por IMEI
    this.activeSockets = new Map();
    // Contador de serial number para comandos
    this.serialNumbers = new Map();
  }

  /**
   * Registra socket ativo de um dispositivo
   */
  registerSocket(imei, socket) {
    console.log(`[COMANDO] Socket registrado para IMEI ${imei}`);
    this.activeSockets.set(imei, socket);

    // Inicializa serial number se não existir
    if (!this.serialNumbers.has(imei)) {
      this.serialNumbers.set(imei, 1);
    }
  }

  /**
   * Remove socket quando dispositivo desconecta
   */
  unregisterSocket(imei) {
    console.log(`[COMANDO] Socket removido para IMEI ${imei}`);
    this.activeSockets.delete(imei);
  }

  /**
   * Verifica se dispositivo está conectado
   */
  isOnline(imei) {
    return this.activeSockets.has(imei);
  }

  /**
   * Obtém próximo serial number para o dispositivo
   */
  getNextSerialNumber(imei) {
    let serial = this.serialNumbers.get(imei) || 1;
    this.serialNumbers.set(imei, (serial % 65535) + 1); // Incrementa e reseta em 65535
    return serial;
  }

  /**
   * Calcula CRC16-ITU para verificação de erro
   * Baseado no Appendix A da documentação
   */
  calculateCRC16(buffer) {
    const crctab16 = [
      0x0000, 0x1189, 0x2312, 0x329B, 0x4624, 0x57AD, 0x6536, 0x74BF,
      0x8C48, 0x9DC1, 0xAF5A, 0xBED3, 0xCA6C, 0xDBE5, 0xE97E, 0xF8F7,
      0x1081, 0x0108, 0x3393, 0x221A, 0x56A5, 0x472C, 0x75B7, 0x643E,
      0x9CC9, 0x8D40, 0xBFDB, 0xAE52, 0xDAED, 0xCB64, 0xF9FF, 0xE876,
      0x2102, 0x308B, 0x0210, 0x1399, 0x6726, 0x76AF, 0x4434, 0x55BD,
      0xAD4A, 0xBCC3, 0x8E58, 0x9FD1, 0xEB6E, 0xFAE7, 0xC87C, 0xD9F5,
      0x3183, 0x200A, 0x1291, 0x0318, 0x77A7, 0x662E, 0x54B5, 0x453C,
      0xBDCB, 0xAC42, 0x9ED9, 0x8F50, 0xFBEF, 0xEA66, 0xD8FD, 0xC974,
      0x4204, 0x538D, 0x6116, 0x709F, 0x0420, 0x15A9, 0x2732, 0x36BB,
      0xCE4C, 0xDFC5, 0xED5E, 0xFCD7, 0x8868, 0x99E1, 0xAB7A, 0xBAF3,
      0x5285, 0x430C, 0x7197, 0x601E, 0x14A1, 0x0528, 0x37B3, 0x263A,
      0xDECD, 0xCF44, 0xFDDF, 0xEC56, 0x98E9, 0x8960, 0xBBFB, 0xAA72,
      0x6306, 0x728F, 0x4014, 0x519D, 0x2522, 0x34AB, 0x0630, 0x17B9,
      0xEF4E, 0xFEC7, 0xCC5C, 0xDDD5, 0xA96A, 0xB8E3, 0x8A78, 0x9BF1,
      0x7387, 0x620E, 0x5095, 0x411C, 0x35A3, 0x242A, 0x16B1, 0x0738,
      0xFFCF, 0xEE46, 0xDCDD, 0xCD54, 0xB9EB, 0xA862, 0x9AF9, 0x8B70,
      0x8408, 0x9581, 0xA71A, 0xB693, 0xC22C, 0xD3A5, 0xE13E, 0xF0B7,
      0x0840, 0x19C9, 0x2B52, 0x3ADB, 0x4E64, 0x5FED, 0x6D76, 0x7CFF,
      0x9489, 0x8500, 0xB79B, 0xA612, 0xD2AD, 0xC324, 0xF1BF, 0xE036,
      0x18C1, 0x0948, 0x3BD3, 0x2A5A, 0x5EE5, 0x4F6C, 0x7DF7, 0x6C7E,
      0xA50A, 0xB483, 0x8618, 0x9791, 0xE32E, 0xF2A7, 0xC03C, 0xD1B5,
      0x2942, 0x38CB, 0x0A50, 0x1BD9, 0x6F66, 0x7EEF, 0x4C74, 0x5DFD,
      0xB58B, 0xA402, 0x9699, 0x8710, 0xF3AF, 0xE226, 0xD0BD, 0xC134,
      0x39C3, 0x284A, 0x1AD1, 0x0B58, 0x7FE7, 0x6E6E, 0x5CF5, 0x4D7C,
      0xC60C, 0xD785, 0xE51E, 0xF497, 0x8028, 0x91A1, 0xA33A, 0xB2B3,
      0x4A44, 0x5BCD, 0x6956, 0x78DF, 0x0C60, 0x1DE9, 0x2F72, 0x3EFB,
      0xD68D, 0xC704, 0xF59F, 0xE416, 0x90A9, 0x8120, 0xB3BB, 0xA232,
      0x5AC5, 0x4B4C, 0x79D7, 0x685E, 0x1CE1, 0x0D68, 0x3FF3, 0x2E7A,
      0xE70E, 0xF687, 0xC41C, 0xD595, 0xA12A, 0xB0A3, 0x8238, 0x93B1,
      0x6B46, 0x7ACF, 0x4854, 0x59DD, 0x2D62, 0x3CEB, 0x0E70, 0x1FF9,
      0xF78F, 0xE606, 0xD49D, 0xC514, 0xB1AB, 0xA022, 0x92B9, 0x8330,
      0x7BC7, 0x6A4E, 0x58D5, 0x495C, 0x3DE3, 0x2C6A, 0x1EF1, 0x0F78
    ];

    let fcs = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
      fcs = (fcs >> 8) ^ crctab16[(fcs ^ buffer[i]) & 0xFF];
    }
    return ~fcs & 0xFFFF;
  }

  /**
   * Constrói pacote de comando no formato Protocolo 0x80
   * Formato: Start Bit (2) + Length (1) + Protocol (1) + Info Content + Serial (2) + CRC (2) + Stop (2)
   */
  buildCommandPacket(comando, serialNumber) {
    // Converte comando para buffer ASCII
    const commandBuffer = Buffer.from(comando, 'ascii');

    // Server Flag Bit (4 bytes) - identificação do servidor
    const serverFlag = Buffer.from([0x00, 0x00, 0x01, 0x08]);

    // Length of Command = 1 (length byte) + 4 (server flag) + comando length
    const commandLength = 1 + serverFlag.length + commandBuffer.length;
    const commandLengthByte = Buffer.from([commandLength]);

    // Monta Information Content
    const infoContent = Buffer.concat([
      commandLengthByte,
      serverFlag,
      commandBuffer
    ]);

    // Protocol Number
    const protocolNumber = Buffer.from([0x80]);

    // Packet Length = Protocol (1) + Info Content + Serial (2)
    const packetLength = 1 + infoContent.length + 2;
    const packetLengthByte = Buffer.from([packetLength]);

    // Serial Number (2 bytes, big endian)
    const serialBuf = Buffer.allocUnsafe(2);
    serialBuf.writeUInt16BE(serialNumber, 0);

    // Monta buffer para CRC (Length + Protocol + Info + Serial)
    const crcBuffer = Buffer.concat([
      packetLengthByte,
      protocolNumber,
      infoContent,
      serialBuf
    ]);

    // Calcula CRC
    const crc = this.calculateCRC16(crcBuffer);
    const crcBuf = Buffer.allocUnsafe(2);
    crcBuf.writeUInt16BE(crc, 0);

    // Monta pacote completo
    const packet = Buffer.concat([
      Buffer.from([0x78, 0x78]),        // Start Bit
      crcBuffer,                         // Length + Protocol + Info + Serial
      crcBuf,                            // CRC
      Buffer.from([0x0D, 0x0A])         // Stop Bit
    ]);

    return packet;
  }

  /**
   * Envia comando para um dispositivo
   */
  async sendCommand(imei, comando) {
    return new Promise((resolve, reject) => {
      if (!this.isOnline(imei)) {
        console.warn(`[COMANDO] Dispositivo ${imei} não está conectado`);
        return reject(new Error('Dispositivo offline'));
      }

      const socket = this.activeSockets.get(imei);
      const serialNumber = this.getNextSerialNumber(imei);
      const packet = this.buildCommandPacket(comando, serialNumber);

      console.info(`[COMANDO] Enviando para ${imei}: "${comando}" (Serial: ${serialNumber})`);
      console.debug(`[COMANDO] Pacote hex: ${packet.toString('hex').toUpperCase()}`);

      // Timeout para resposta
      const timeout = setTimeout(() => {
        socket.removeListener('data', responseHandler);
        console.warn(`[COMANDO] Timeout aguardando resposta de ${imei}`);
        resolve({ success: false, message: 'Timeout - sem resposta do dispositivo' });
      }, 5000);

      // Handler para receber resposta (protocolo 0x15)
      const responseHandler = (data) => {
        clearTimeout(timeout);
        socket.removeListener('data', responseHandler);

        console.info(`[COMANDO] Resposta recebida de ${imei}: ${data.toString('hex').toUpperCase()}`);

        // Tenta extrair resposta ASCII do pacote 0x15
        try {
          const response = this.parseCommandResponse(data);
          console.info(`[COMANDO] Resposta decodificada: "${response}"`);
          resolve({ success: true, response });
        } catch (err) {
          console.error(`[COMANDO] Erro ao parsear resposta: ${err.message}`);
          resolve({ success: true, response: 'OK (resposta não parseada)' });
        }
      };

      socket.once('data', responseHandler);

      // Envia comando
      socket.write(packet, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.removeListener('data', responseHandler);
          console.error(`[COMANDO] Erro ao enviar para ${imei}: ${err.message}`);
          reject(err);
        }
      });
    });
  }

  /**
   * Parseia resposta do dispositivo (protocolo 0x15)
   */
  parseCommandResponse(buffer) {
    // Formato: 7878 + Length + 15 + LengthCmd + ServerFlag + Content + Serial + CRC + 0D0A
    if (buffer.length < 10) {
      throw new Error('Resposta muito curta');
    }

    // Pula: Start(2) + Length(1) + Protocol(1) + LengthCmd(1) + ServerFlag(4) = 9 bytes
    const contentStart = 9;
    const contentEnd = buffer.length - 6; // Remove Serial(2) + CRC(2) + Stop(2)

    const content = buffer.slice(contentStart, contentEnd);
    return content.toString('ascii');
  }

  /**
   * Envia sequência de comandos com delay entre eles
   */
  async sendCommandSequence(imei, comandos, delayMs = 1000) {
    const results = [];

    for (const comando of comandos) {
      try {
        const result = await this.sendCommand(imei, comando);
        results.push({ comando, ...result });

        // Aguarda delay antes do próximo comando
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch (err) {
        results.push({
          comando,
          success: false,
          message: err.message
        });
      }
    }

    return results;
  }

  /**
   * Comandos pré-definidos para configuração inicial
   * Baseado no protocolo X3Tech XT40 Rev 1.06
   */
  getInitialSetupCommands() {
    return [
      '#55555#YUP#10#',      // ✅ Intervalo de upload: 10 segundos (CRÍTICO!)
      '#55555#YGPS#1#',      // ✅ Ativar GPS
      '#55555#YGNSS#1#',     // ✅ Ativar GNSS (GPS + GLONASS)
      'SETLOCX22#',          // ✅ Ativa protocolo 0x22 com dados completos
      '#55555#YONLINE#1#',   // ✅ Modo online contínuo
    ];
  }

  /**
   * Envia comandos de configuração inicial para novo dispositivo
   */
  async setupNewDevice(imei) {
    console.info(`[COMANDO] Iniciando configuração automática para ${imei}`);

    const commands = this.getInitialSetupCommands();
    const results = await this.sendCommandSequence(imei, commands, 2000);

    console.info(`[COMANDO] Configuração concluída para ${imei}:`, results);
    return results;
  }
}

// Singleton
const comandoService = new ComandoService();

module.exports = comandoService;
