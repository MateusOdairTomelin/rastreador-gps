/**
 * Teltonika GPS Parser
 *
 * Suporta dispositivos da família FMC (FMC800, FMC920, FMC003, FMC650)
 * Protocolos: Codec 8, Codec 8 Extended, Codec 12 (comandos)
 *
 * Referência: https://wiki.teltonika-gps.com/view/Codec
 */

class TeltonikaParser {
  constructor() {
    // IO Element mapping para dispositivos FMC
    this.ioElements = {
      1: { name: 'digital_input_1', description: 'Ignição/DIN1' },
      2: { name: 'digital_input_2', description: 'DIN2' },
      3: { name: 'digital_input_3', description: 'DIN3' },
      4: { name: 'digital_input_4', description: 'DIN4' },
      9: { name: 'analog_input_1', description: 'Entrada Analógica 1' },
      10: { name: 'sd_status', description: 'Status SD Card' },
      11: { name: 'iccid1', description: 'SIM ICCID parte 1' },
      12: { name: 'fuel_used', description: 'Combustível usado' },
      13: { name: 'fuel_rate', description: 'Taxa combustível' },
      14: { name: 'iccid2', description: 'SIM ICCID parte 2' },
      15: { name: 'eco_score', description: 'Score Eco-driving' },
      16: { name: 'total_odometer', description: 'Odômetro total (metros)' },
      17: { name: 'axis_x', description: 'Acelerômetro X' },
      18: { name: 'axis_y', description: 'Acelerômetro Y' },
      19: { name: 'axis_z', description: 'Acelerômetro Z' },
      21: { name: 'gsm_signal', description: 'Sinal GSM' },
      24: { name: 'speed', description: 'Velocidade GPS' },
      66: { name: 'external_voltage', description: 'Tensão externa (mV)' },
      67: { name: 'battery_voltage', description: 'Tensão bateria interna (mV)' },
      68: { name: 'battery_current', description: 'Corrente bateria (mA)' },
      69: { name: 'gnss_status', description: 'Status GNSS (0=OFF,1=ON NO FIX,2=ON FIX,3=SLEEP)' },
      72: { name: 'dallas_temp_1', description: 'Temperatura Dallas 1' },
      73: { name: 'dallas_temp_2', description: 'Temperatura Dallas 2' },
      74: { name: 'dallas_temp_3', description: 'Temperatura Dallas 3' },
      75: { name: 'dallas_temp_4', description: 'Temperatura Dallas 4' },
      78: { name: 'driver_id', description: 'ID Motorista (iButton)' },
      80: { name: 'data_mode', description: 'Modo de dados' },
      113: { name: 'battery_level', description: 'Nível bateria (%)' },
      175: { name: 'auto_geofence', description: 'Auto Geofence' },
      181: { name: 'gnss_pdop', description: 'GNSS PDOP' },
      182: { name: 'gnss_hdop', description: 'GNSS HDOP' },
      199: { name: 'trip_odometer', description: 'Odômetro da viagem' },
      200: { name: 'deep_sleep', description: 'Deep Sleep' },
      205: { name: 'gsm_cell_id', description: 'Cell ID GSM' },
      206: { name: 'gsm_area_code', description: 'LAC GSM' },
      239: { name: 'ignition', description: 'Ignição' },
      240: { name: 'movement', description: 'Movimento detectado' },
      241: { name: 'gsm_operator', description: 'Operadora GSM' },
      246: { name: 'towing', description: 'Reboque detectado' },
      247: { name: 'crash_detection', description: 'Colisão detectada' },
      248: { name: 'immobilizer', description: 'Imobilizador' },
      249: { name: 'jamming', description: 'Jamming detectado' },
      250: { name: 'trip', description: 'Viagem ativa' },
      251: { name: 'idling', description: 'Motor ocioso' },
      252: { name: 'unplug', description: 'Dispositivo desconectado' },
      253: { name: 'green_driving_type', description: 'Tipo evento Green Driving' },
      254: { name: 'green_driving_value', description: 'Valor Green Driving' },
      255: { name: 'overspeeding', description: 'Excesso velocidade' },
      // IOs estendidos (Codec 8E - 2 bytes)
      256: { name: 'vin', description: 'VIN do veículo' },
      281: { name: 'fault_codes', description: 'Códigos de falha' },
      385: { name: 'beacon_ids', description: 'IDs Beacons' },
    };

    // Tabela CRC-16/IBM (polinômio 0xA001)
    this.crcTable = this._generateCRCTable();
  }

  /**
   * Gera tabela CRC-16/IBM
   */
  _generateCRCTable() {
    const table = [];
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        if (crc & 1) {
          crc = (crc >> 1) ^ 0xA001;
        } else {
          crc >>= 1;
        }
      }
      table.push(crc);
    }
    return table;
  }

  /**
   * Calcula CRC-16/IBM
   */
  calculateCRC16(buffer, start, length) {
    let crc = 0x0000;
    for (let i = start; i < start + length; i++) {
      crc = (crc >> 8) ^ this.crcTable[(crc ^ buffer[i]) & 0xFF];
    }
    return crc;
  }

  /**
   * Parse IMEI do handshake inicial
   * Formato: [length:2][IMEI ASCII:15]
   */
  parseImei(buffer) {
    try {
      if (buffer.length < 2) {
        console.log('[Teltonika] Buffer muito curto para IMEI');
        return null;
      }

      const length = buffer.readUInt16BE(0);
      console.log(`[Teltonika] IMEI length field: ${length}`);

      if (length !== 15 && length !== 16) {
        console.log(`[Teltonika] IMEI length inválido: ${length}`);
        return null;
      }

      if (buffer.length < 2 + length) {
        console.log(`[Teltonika] Buffer incompleto para IMEI: ${buffer.length} < ${2 + length}`);
        return null;
      }

      // IMEI é ASCII
      const imei = buffer.slice(2, 2 + length).toString('ascii').replace(/[^0-9]/g, '');
      console.log(`[Teltonika] IMEI parsed: ${imei}`);

      if (imei.length < 14 || imei.length > 16) {
        console.log(`[Teltonika] IMEI inválido: ${imei}`);
        return null;
      }

      return imei;
    } catch (error) {
      console.error('[Teltonika] Erro ao parsear IMEI:', error.message);
      return null;
    }
  }

  /**
   * Parse pacote de dados AVL (TCP)
   */
  parse(buffer) {
    try {
      if (buffer.length < 12) {
        console.log(`[Teltonika] Pacote muito curto: ${buffer.length} bytes`);
        return null;
      }

      const hex = buffer.toString('hex').toUpperCase();
      console.log(`[Teltonika] ================================`);
      console.log(`[Teltonika] Parsing buffer (${buffer.length} bytes): ${hex.substring(0, 100)}...`);

      // Verificar preamble (4 bytes = 0x00000000)
      const preamble = buffer.readUInt32BE(0);
      if (preamble !== 0x00000000) {
        console.log(`[Teltonika] Preamble inválido: 0x${preamble.toString(16)}`);
        return null;
      }
      console.log(`[Teltonika] ✓ Preamble válido`);

      // Data field length (4 bytes)
      const dataLength = buffer.readUInt32BE(4);
      console.log(`[Teltonika] Data length: ${dataLength}`);

      // Verificar se temos dados suficientes
      // Estrutura: preamble(4) + length(4) + data(dataLength) + crc(4)
      const expectedLength = 4 + 4 + dataLength + 4;
      if (buffer.length < expectedLength) {
        console.log(`[Teltonika] Pacote incompleto: ${buffer.length} < ${expectedLength}`);
        return null;
      }

      // Validar CRC
      const receivedCRC = buffer.readUInt32BE(8 + dataLength);
      const calculatedCRC = this.calculateCRC16(buffer, 8, dataLength);

      if (receivedCRC !== calculatedCRC) {
        console.warn(`[Teltonika] ⚠️ CRC mismatch: received=0x${receivedCRC.toString(16)}, calculated=0x${calculatedCRC.toString(16)}`);
        // Continua processando mesmo com CRC inválido (modo tolerante)
      } else {
        console.log(`[Teltonika] ✓ CRC válido: 0x${calculatedCRC.toString(16)}`);
      }

      // Codec ID (1 byte após length field)
      const codecId = buffer.readUInt8(8);
      console.log(`[Teltonika] Codec ID: 0x${codecId.toString(16).padStart(2, '0')}`);

      // Parse baseado no codec
      let result = null;
      switch (codecId) {
        case 0x08: // Codec 8
          console.log(`[Teltonika] → Processando Codec 8`);
          result = this.parseCodec8(buffer, 8, dataLength);
          break;

        case 0x8E: // Codec 8 Extended
          console.log(`[Teltonika] → Processando Codec 8 Extended`);
          result = this.parseCodec8Extended(buffer, 8, dataLength);
          break;

        case 0x10: // Codec 16
          console.log(`[Teltonika] → Processando Codec 16`);
          result = this.parseCodec16(buffer, 8, dataLength);
          break;

        case 0x0C: // Codec 12 (comandos)
          console.log(`[Teltonika] → Processando Codec 12 (comando)`);
          result = this.parseCodec12(buffer, 8, dataLength);
          break;

        default:
          console.log(`[Teltonika] ❌ Codec não suportado: 0x${codecId.toString(16)}`);
          return null;
      }

      if (result) {
        result.raw = hex;
        result.codecId = codecId;
      }

      return result;
    } catch (error) {
      console.error('[Teltonika] Erro no parse:', error.message);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Parse Codec 8 (padrão)
   */
  parseCodec8(buffer, offset, dataLength) {
    try {
      // Codec ID já foi lido
      offset += 1;

      // Number of Data 1
      const recordCount1 = buffer.readUInt8(offset);
      offset += 1;
      console.log(`[Teltonika] Record count: ${recordCount1}`);

      const records = [];
      for (let i = 0; i < recordCount1; i++) {
        const record = this.parseAVLRecord(buffer, offset, false);
        if (record) {
          records.push(record.data);
          offset = record.nextOffset;
        } else {
          console.warn(`[Teltonika] Falha ao parsear record ${i + 1}`);
          break;
        }
      }

      // Number of Data 2 (deve ser igual a recordCount1)
      const recordCount2 = buffer.readUInt8(offset);
      if (recordCount1 !== recordCount2) {
        console.warn(`[Teltonika] ⚠️ Record count mismatch: ${recordCount1} vs ${recordCount2}`);
      }

      return {
        type: 'avl_data',
        recordCount: records.length,
        records,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('[Teltonika] Erro Codec 8:', error.message);
      return null;
    }
  }

  /**
   * Parse Codec 8 Extended (para FMC series)
   */
  parseCodec8Extended(buffer, offset, dataLength) {
    try {
      // Codec ID já foi lido
      offset += 1;

      // Number of Data 1
      const recordCount1 = buffer.readUInt8(offset);
      offset += 1;
      console.log(`[Teltonika] Record count: ${recordCount1}`);

      const records = [];
      for (let i = 0; i < recordCount1; i++) {
        const record = this.parseAVLRecord(buffer, offset, true); // true = extended
        if (record) {
          records.push(record.data);
          offset = record.nextOffset;
        } else {
          console.warn(`[Teltonika] Falha ao parsear record ${i + 1}`);
          break;
        }
      }

      // Number of Data 2
      const recordCount2 = buffer.readUInt8(offset);
      if (recordCount1 !== recordCount2) {
        console.warn(`[Teltonika] ⚠️ Record count mismatch: ${recordCount1} vs ${recordCount2}`);
      }

      return {
        type: 'avl_data',
        recordCount: records.length,
        records,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('[Teltonika] Erro Codec 8E:', error.message);
      return null;
    }
  }

  /**
   * Parse Codec 16 (FMB630/FM63XY)
   */
  parseCodec16(buffer, offset, dataLength) {
    try {
      offset += 1; // Skip codec ID

      const recordCount1 = buffer.readUInt8(offset);
      offset += 1;

      const records = [];
      for (let i = 0; i < recordCount1; i++) {
        const record = this.parseAVLRecordCodec16(buffer, offset);
        if (record) {
          records.push(record.data);
          offset = record.nextOffset;
        } else {
          break;
        }
      }

      return {
        type: 'avl_data',
        recordCount: records.length,
        records,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('[Teltonika] Erro Codec 16:', error.message);
      return null;
    }
  }

  /**
   * Parse Codec 12 (comandos GPRS)
   */
  parseCodec12(buffer, offset, dataLength) {
    try {
      offset += 1; // Skip codec ID

      const commandCount1 = buffer.readUInt8(offset);
      offset += 1;

      const commands = [];
      for (let i = 0; i < commandCount1; i++) {
        const type = buffer.readUInt8(offset);
        offset += 1;

        const commandSize = buffer.readUInt32BE(offset);
        offset += 4;

        const commandData = buffer.slice(offset, offset + commandSize).toString('ascii');
        offset += commandSize;

        commands.push({
          type: type === 0x05 ? 'command' : 'response',
          data: commandData,
        });
      }

      return {
        type: 'command',
        commands,
        timestamp: new Date(),
      };
    } catch (error) {
      console.error('[Teltonika] Erro Codec 12:', error.message);
      return null;
    }
  }

  /**
   * Parse um registro AVL (Codec 8 e 8E)
   */
  parseAVLRecord(buffer, offset, extended = false) {
    try {
      const startOffset = offset;

      // Timestamp (8 bytes - milissegundos desde Unix epoch)
      const timestampMs = buffer.readBigUInt64BE(offset);
      const timestamp = new Date(Number(timestampMs));
      offset += 8;

      // Priority (1 byte)
      const priority = buffer.readUInt8(offset);
      const priorityNames = { 0: 'low', 1: 'high', 2: 'panic' };
      offset += 1;

      // GPS Element (15 bytes)
      const gps = this.parseGPSElement(buffer, offset);
      offset += 15;

      // IO Element
      const io = this.parseIOElement(buffer, offset, extended);
      offset = io.nextOffset;

      // Mapear dados para formato padrão
      const data = {
        timestamp,
        priority: priorityNames[priority] || 'low',
        latitude: gps.latitude,
        longitude: gps.longitude,
        altitude: gps.altitude,
        direcao: gps.angle,
        velocidade: gps.speed,
        satellites: gps.satellites,
        precisao: gps.satellites > 0 ? Math.max(3, 50 - gps.satellites * 3) : 50,
        io: io.elements,
        // Mapear IOs comuns para campos padrão
        ignicao: io.elements.ignition === 1 || io.elements.digital_input_1 === 1,
        odometro_embarcado: io.elements.total_odometer ? Math.round(io.elements.total_odometer / 1000) : null, // metros -> km
        tensao_bateria: io.elements.battery_voltage ? io.elements.battery_voltage / 1000 : null, // mV -> V
        tensao_principal: io.elements.external_voltage ? io.elements.external_voltage / 1000 : null, // mV -> V
        percentual_bateria: io.elements.battery_level || null,
        sinal_gsm: io.elements.gsm_signal || null,
        movimento: io.elements.movement === 1,
      };

      console.log(`[Teltonika] ✅ AVL Record: lat=${data.latitude}, lon=${data.longitude}, speed=${data.velocidade}, sats=${data.satellites}`);

      return {
        data,
        nextOffset: offset,
      };
    } catch (error) {
      console.error('[Teltonika] Erro parseAVLRecord:', error.message);
      return null;
    }
  }

  /**
   * Parse registro AVL Codec 16
   */
  parseAVLRecordCodec16(buffer, offset) {
    try {
      // Timestamp (8 bytes)
      const timestampMs = buffer.readBigUInt64BE(offset);
      const timestamp = new Date(Number(timestampMs));
      offset += 8;

      // Priority (1 byte)
      const priority = buffer.readUInt8(offset);
      offset += 1;

      // GPS Element (15 bytes)
      const gps = this.parseGPSElement(buffer, offset);
      offset += 15;

      // Event IO ID (2 bytes - diferente do Codec 8)
      const eventIoId = buffer.readUInt16BE(offset);
      offset += 2;

      // Generation Type (1 byte - específico Codec 16)
      const generationType = buffer.readUInt8(offset);
      offset += 1;

      // IO Element count (1 byte)
      const ioCount = buffer.readUInt8(offset);
      offset += 1;

      // Parse IO elements com IDs de 2 bytes
      const io = this.parseIOElementCodec16(buffer, offset);
      offset = io.nextOffset;

      const data = {
        timestamp,
        priority: ['low', 'high', 'panic'][priority] || 'low',
        latitude: gps.latitude,
        longitude: gps.longitude,
        altitude: gps.altitude,
        direcao: gps.angle,
        velocidade: gps.speed,
        satellites: gps.satellites,
        eventIoId,
        generationType,
        io: io.elements,
        ignicao: io.elements.ignition === 1,
      };

      return { data, nextOffset: offset };
    } catch (error) {
      console.error('[Teltonika] Erro parseAVLRecordCodec16:', error.message);
      return null;
    }
  }

  /**
   * Parse GPS Element (15 bytes)
   */
  parseGPSElement(buffer, offset) {
    // Longitude (4 bytes) - valor * 10^-7
    const longitudeRaw = buffer.readInt32BE(offset);
    const longitude = longitudeRaw / 10000000.0;
    offset += 4;

    // Latitude (4 bytes) - valor * 10^-7
    const latitudeRaw = buffer.readInt32BE(offset);
    const latitude = latitudeRaw / 10000000.0;
    offset += 4;

    // Altitude (2 bytes) - metros
    const altitude = buffer.readInt16BE(offset);
    offset += 2;

    // Angle/Direction (2 bytes) - graus 0-360
    const angle = buffer.readUInt16BE(offset);
    offset += 2;

    // Satellites (1 byte)
    const satellites = buffer.readUInt8(offset);
    offset += 1;

    // Speed (2 bytes) - km/h
    const speed = buffer.readUInt16BE(offset);
    offset += 2;

    console.log(`[Teltonika] GPS: lat=${latitude.toFixed(6)}, lon=${longitude.toFixed(6)}, alt=${altitude}m, angle=${angle}°, sats=${satellites}, speed=${speed}km/h`);

    return {
      latitude: parseFloat(latitude.toFixed(6)),
      longitude: parseFloat(longitude.toFixed(6)),
      altitude,
      angle,
      satellites,
      speed,
    };
  }

  /**
   * Parse IO Element (Codec 8 e 8E)
   */
  parseIOElement(buffer, offset, extended = false) {
    const elements = {};

    try {
      // Event IO ID
      const eventIoId = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;

      // Total IO count
      const totalIoCount = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;

      // IO de 1 byte
      const count1 = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;
      for (let i = 0; i < count1; i++) {
        const ioId = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
        offset += extended ? 2 : 1;
        const value = buffer.readUInt8(offset);
        offset += 1;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 2 bytes
      const count2 = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;
      for (let i = 0; i < count2; i++) {
        const ioId = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
        offset += extended ? 2 : 1;
        const value = buffer.readUInt16BE(offset);
        offset += 2;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 4 bytes
      const count4 = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;
      for (let i = 0; i < count4; i++) {
        const ioId = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
        offset += extended ? 2 : 1;
        const value = buffer.readUInt32BE(offset);
        offset += 4;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 8 bytes
      const count8 = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
      offset += extended ? 2 : 1;
      for (let i = 0; i < count8; i++) {
        const ioId = extended ? buffer.readUInt16BE(offset) : buffer.readUInt8(offset);
        offset += extended ? 2 : 1;
        const value = buffer.readBigUInt64BE(offset);
        offset += 8;
        this._setIOElement(elements, ioId, Number(value));
      }

      // IO de tamanho variável (apenas Codec 8E)
      if (extended) {
        const countX = buffer.readUInt16BE(offset);
        offset += 2;
        for (let i = 0; i < countX; i++) {
          const ioId = buffer.readUInt16BE(offset);
          offset += 2;
          const length = buffer.readUInt16BE(offset);
          offset += 2;
          const value = buffer.slice(offset, offset + length);
          offset += length;
          this._setIOElement(elements, ioId, value.toString('hex'));
        }
      }

      elements._eventIoId = eventIoId;
      elements._totalCount = totalIoCount;

    } catch (error) {
      console.error('[Teltonika] Erro parseIOElement:', error.message);
    }

    return { elements, nextOffset: offset };
  }

  /**
   * Parse IO Element Codec 16
   */
  parseIOElementCodec16(buffer, offset) {
    const elements = {};

    try {
      // IO de 1 byte (count é 1 byte, ID é 2 bytes)
      const count1 = buffer.readUInt8(offset);
      offset += 1;
      for (let i = 0; i < count1; i++) {
        const ioId = buffer.readUInt16BE(offset);
        offset += 2;
        const value = buffer.readUInt8(offset);
        offset += 1;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 2 bytes
      const count2 = buffer.readUInt8(offset);
      offset += 1;
      for (let i = 0; i < count2; i++) {
        const ioId = buffer.readUInt16BE(offset);
        offset += 2;
        const value = buffer.readUInt16BE(offset);
        offset += 2;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 4 bytes
      const count4 = buffer.readUInt8(offset);
      offset += 1;
      for (let i = 0; i < count4; i++) {
        const ioId = buffer.readUInt16BE(offset);
        offset += 2;
        const value = buffer.readUInt32BE(offset);
        offset += 4;
        this._setIOElement(elements, ioId, value);
      }

      // IO de 8 bytes
      const count8 = buffer.readUInt8(offset);
      offset += 1;
      for (let i = 0; i < count8; i++) {
        const ioId = buffer.readUInt16BE(offset);
        offset += 2;
        const value = buffer.readBigUInt64BE(offset);
        offset += 8;
        this._setIOElement(elements, ioId, Number(value));
      }
    } catch (error) {
      console.error('[Teltonika] Erro parseIOElementCodec16:', error.message);
    }

    return { elements, nextOffset: offset };
  }

  /**
   * Define elemento IO com nome mapeado
   */
  _setIOElement(elements, ioId, value) {
    const mapping = this.ioElements[ioId];
    if (mapping) {
      elements[mapping.name] = value;
      console.log(`[Teltonika] IO ${ioId} (${mapping.name}): ${value}`);
    } else {
      elements[`io_${ioId}`] = value;
      console.log(`[Teltonika] IO ${ioId}: ${value}`);
    }
  }

  /**
   * Cria resposta ACK para o dispositivo
   * Retorna número de records aceitos (4 bytes)
   */
  createAckResponse(recordCount) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(recordCount, 0);
    console.log(`[Teltonika] ACK criado: ${recordCount} records`);
    return buffer;
  }

  /**
   * Cria resposta para handshake IMEI
   * 0x01 = aceito, 0x00 = rejeitado
   */
  createImeiResponse(accepted = true) {
    const buffer = Buffer.alloc(1);
    buffer.writeUInt8(accepted ? 0x01 : 0x00, 0);
    return buffer;
  }

  /**
   * Cria pacote de comando Codec 12
   */
  createCommand(command) {
    const commandBuffer = Buffer.from(command, 'ascii');
    const dataLength = 1 + 1 + 1 + 4 + commandBuffer.length + 1;

    // Preamble(4) + Length(4) + Data + CRC(4)
    const buffer = Buffer.alloc(4 + 4 + dataLength + 4);
    let offset = 0;

    // Preamble
    buffer.writeUInt32BE(0x00000000, offset);
    offset += 4;

    // Data length
    buffer.writeUInt32BE(dataLength, offset);
    offset += 4;

    // Codec ID
    buffer.writeUInt8(0x0C, offset);
    offset += 1;

    // Command quantity 1
    buffer.writeUInt8(0x01, offset);
    offset += 1;

    // Command type (0x05 = command)
    buffer.writeUInt8(0x05, offset);
    offset += 1;

    // Command size
    buffer.writeUInt32BE(commandBuffer.length, offset);
    offset += 4;

    // Command data
    commandBuffer.copy(buffer, offset);
    offset += commandBuffer.length;

    // Command quantity 2
    buffer.writeUInt8(0x01, offset);
    offset += 1;

    // CRC
    const crc = this.calculateCRC16(buffer, 8, dataLength);
    buffer.writeUInt32BE(crc, offset);

    console.log(`[Teltonika] Comando criado: ${command} (${buffer.length} bytes)`);
    return buffer;
  }
}

module.exports = new TeltonikaParser();
