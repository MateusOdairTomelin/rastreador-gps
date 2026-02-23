class GPSParser {
  /**
   * Parse XT40 GPS tracker hex data using GT06 protocol
   * Protocol reference: GT06 Communication Protocol
   * Packet format: [0x7878][Length][ProtocolNumber][Data][CRC][0x0D0A]
   */
  parse(hexBuffer) {
    try {
      const hex = hexBuffer.toString('hex').toUpperCase();
      console.log(`[GPS Parser] ================================`);
      console.log(`[GPS Parser] Parsing buffer (${hexBuffer.length} bytes): ${hex}`);

      // Verify minimum packet length
      if (hexBuffer.length < 10) {
        console.warn(`[GPS Parser] ❌ REJECT: Packet too short: ${hexBuffer.length} bytes`);
        return null;
      }

      // Protocol header verification (0x7878 or 0x7979)
      const startBit = hexBuffer.readUInt16BE(0);
      if (startBit !== 0x7878 && startBit !== 0x7979) {
        console.log(`[GPS Parser] ❌ REJECT: Invalid header: 0x${startBit.toString(16).padStart(4, '0')}`);
        return null;
      }
      console.log(`[GPS Parser] ✓ Header valid: 0x${startBit.toString(16).padStart(4, '0')}`);

      // ✅ SUPORTE A DOIS FORMATOS:
      // 0x7878: length é 1 byte (posição 2), protocol em posição 3
      // 0x7979: length é 2 bytes (posição 2-3), protocol em posição 4
      let packetLength, protocolNumber, dataOffset;

      if (startBit === 0x7979) {
        // Header 0x7979: length é 2 bytes, protocol está em posição 4
        packetLength = hexBuffer.readUInt16BE(2);
        protocolNumber = hexBuffer.readUInt8(4);
        dataOffset = 5; // Dados começam depois do protocol
        console.log(`[GPS Parser] ✓ Format 0x7979: length=${packetLength} (2 bytes), protocol=0x${protocolNumber.toString(16).padStart(2, '0')}, dataOffset=${dataOffset}`);
      } else {
        // Header 0x7878: length é 1 byte, protocol está em posição 3
        packetLength = hexBuffer.readUInt8(2);
        protocolNumber = hexBuffer.readUInt8(3);
        dataOffset = 4; // Dados começam depois do protocol
        console.log(`[GPS Parser] ✓ Format 0x7878: length=${packetLength} (1 byte), protocol=0x${protocolNumber.toString(16).padStart(2, '0')}, dataOffset=${dataOffset}`);
      }

      // Validate packet length
      // 0x7878 format: header(2) + len(1) + data(packetLength) + footer(2) = 5 + packetLength
      // 0x7979 format: header(2) + len(2) + data(packetLength) + footer(2) = 6 + packetLength
      const expectedMinSize = startBit === 0x7979 ? 6 + packetLength : 5 + packetLength;
      if (hexBuffer.length < expectedMinSize) {
        console.log(`[GPS Parser] ❌ REJECT: Incomplete packet: expected ${expectedMinSize} bytes, got ${hexBuffer.length}`);
        return null;
      }
      console.log(`[GPS Parser] ✓ Packet complete: ${hexBuffer.length} >= ${expectedMinSize} bytes`);

      // ✅ CORREÇÃO #2: Validar CRC do pacote (MODO TOLERANTE)
      // Validar mas NÃO rejeitar - permite que dados sejam recebidos e processados
      const crcValid = this.validateCRC(hexBuffer, packetLength);
      if (!crcValid) {
        const imei = this.extractImeiFromBuffer(hexBuffer);
        console.warn(`[GPS Parser] ⚠️ CRC validation FAILED for packet type 0x${protocolNumber.toString(16).padStart(2, '0')} (IMEI: ${imei || 'unknown'}) - PROCESSING ANYWAY (TOLERANT MODE)`);
      } else {
        console.log(`[GPS Parser] ✅ CRC validation passed for protocol 0x${protocolNumber.toString(16).padStart(2, '0')}`);
      }

      // Extract serial number (2 bytes before CRC and footer)
      // Position: start(2) + length(1) + data(packetLength-2) = 2+1+packetLength-2 = packetLength+1
      // Or simpler: before footer(2) and CRC(2), so at position: totalLength - 6
      const serialPosition = 2 + 1 + packetLength - 4; // header(2) + len(1) + data - serial(2) - crc(2)
      let serialNumber = 0x0001;
      try {
        if (serialPosition >= 4 && serialPosition + 2 <= hexBuffer.length - 4) {
          serialNumber = hexBuffer.readUInt16BE(serialPosition);
        }
      } catch (e) {
        console.log(`[GPS Parser] Could not extract serial number: ${e.message}`);
      }

      const result = {
        raw: hexBuffer.toString('hex'),
        packetLength,
        protocolNumber,
        serialNumber,
        timestamp: new Date(),
      };

      // Parse based on protocol number - passar buffer original e dataOffset
      console.log(`[GPS Parser] ✓ Switching to protocol handler for type: 0x${protocolNumber.toString(16)}`);
      switch (protocolNumber) {
        case 0x01: // Login/heartbeat packet
          console.log(`[GPS Parser] → Processing LOGIN packet (0x01)`);
          const loginResult = this.parseLogin(hexBuffer, result, dataOffset);
          if (loginResult) {
            console.log(`[GPS Parser] ✅ Login packet SUCCESS: IMEI=${loginResult.imei}`);
          } else {
            console.log(`[GPS Parser] ❌ Login packet FAILED (parseLogin returned null)`);
          }
          return loginResult;

        case 0x12: // Location packet (GPS data with timestamp)
          console.log(`[GPS Parser] → Processing LOCATION packet (0x12)`);
          const locResult = this.parseLocation(hexBuffer, result, dataOffset);
          if (locResult && locResult.data) {
            console.log(`[GPS Parser] ✅ Location 0x12 SUCCESS: lat=${locResult.data.latitude}, lon=${locResult.data.longitude}`);
          } else {
            console.log(`[GPS Parser] ❌ Location packet FAILED (parseLocation returned null)`);
          }
          return locResult;

        case 0x13: // Status packet (includes battery info)
          console.log(`[GPS Parser] → Processing STATUS packet (0x13)`);
          return this.parseStatus(hexBuffer, result, dataOffset);

        case 0x16: // Alarm packet
          console.log(`[GPS Parser] → Processing ALARM packet (0x16)`);
          return this.parseAlarm(hexBuffer, result, dataOffset);

        case 0x94: // OBD2 data packet
          console.log(`[GPS Parser] → Processing OBD2 packet (0x94)`);
          return this.parseOBD2(hexBuffer, result, dataOffset);

        case 0x22: // X3Tech Location Data Frame (protocolo completo com campos extras)
          console.log(`[GPS Parser] → Processing X3TECH LOCATION packet (0x22)`);
          const x3Result = this.parseX3TechLocation(hexBuffer, result, dataOffset);
          if (x3Result) {
            console.log(`[GPS Parser] ✅ X3Tech Location SUCCESS: lat=${x3Result.data?.latitude}, lon=${x3Result.data?.longitude}, odo=${x3Result.data?.odometro_embarcado}km`);
          }
          return x3Result;

        default:
          console.log(`[GPS Parser] ❌ Unknown protocol number: 0x${protocolNumber.toString(16)}`);
          return null;
      }
    } catch (error) {
      console.error(`[GPS Parser] ❌ EXCEPTION in parse(): ${error.message}`);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Parse login packet to extract device IMEI
   */
  parseLogin(buffer, baseResult, dataOffset = 4) {
    try {
      console.log(`[GPS Parser] → parseLogin() called`);

      // GT06 Login packet: [0x7878][Length][0x01][IMEI(8bytes)][DeviceType][Timezone][CRC][0x0D0A]
      const offset = dataOffset;
      console.log(`[GPS Parser]   Reading 8 IMEI bytes from offset ${offset}`);

      // Extract IMEI (8 bytes, BCD encoded)
      const imeiBytes = buffer.slice(offset, offset + 8);
      console.log(`[GPS Parser]   IMEI bytes (raw hex): ${imeiBytes.toString('hex').toUpperCase()}`);

      // ✅ CORREÇÃO: Usar formato padrão BCD (high nibble first) e remover zeros à esquerda
      // Formato GT06 invertido causava IMEI errado (ex: 3065538... em vez de 3563548...)
      const imei = this.bcdToStringStandard(imeiBytes).replace(/^0+/, '');
      console.log(`[GPS Parser]   IMEI (decoded from BCD): ${imei}`);
      console.log(`[GPS Parser]   IMEI length: ${imei.length} (expected: 15)`);

      if (imei.length !== 15) {
        console.warn(`[GPS Parser]   ⚠️  IMEI length mismatch: ${imei.length} != 15`);
      }

      // ✅ Gerar ACK para o login - ESSENCIAL para dispositivos X3Tech/GT06
      // O dispositivo só envia dados GPS após receber o ACK do login
      const ack = this.createAckResponse(baseResult.protocolNumber, baseResult.serialNumber);
      console.log(`[GPS Parser] ✅ ACK gerado para login: ${ack.toString('hex').toUpperCase()}`);

      return {
        ...baseResult,
        type: 'login',
        imei,
        ack, // Resposta a ser enviada de volta ao dispositivo
      };
    } catch (error) {
      console.error(`[GPS Parser] ❌ Login parse error: ${error.message}`);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Parse location packet with GPS coordinates and datetime
   * ✅ XT40 PROTOCOL REV 1.06 - Section 5.2.1
   * Structure: Start(2) + Length(1) + Protocol(1) + DateTime(6) + GPSInfo(1) + Lat(4) + Lon(4) + Speed(1) + Course(2) + LBS(...)
   */
  parseLocation(buffer, baseResult, dataOffset = 4) {
    try {
      let offset = dataOffset; // After header + length + protocol

      // ========== DATETIME (6 bytes) ==========
      // Format: YY MM DD HH MM SS (as per section 5.2.1.4)
      const year = 2000 + buffer.readUInt8(offset);
      const month = buffer.readUInt8(offset + 1);
      const day = buffer.readUInt8(offset + 2);
      const hour = buffer.readUInt8(offset + 3);
      const minute = buffer.readUInt8(offset + 4);
      const second = buffer.readUInt8(offset + 5);
      offset += 6;

      // Timestamp raw do GPS - dispositivos no Brasil enviam em hora LOCAL (UTC-3)
      // Brasil NÃO tem horário de verão desde 2019, então sempre UTC-3
      let timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      const now = new Date();

      // ✅ CORREÇÃO TIMEZONE BRASIL: Dispositivos enviam hora local (UTC-3)
      // Estratégia: Testar se timestamp faz mais sentido como UTC-3 ou UTC puro
      const diffAsUTC = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);
      const timestampAsUTC3 = new Date(timestamp.getTime() + (3 * 60 * 60 * 1000));
      const diffAsUTC3 = (now.getTime() - timestampAsUTC3.getTime()) / (1000 * 60 * 60);

      // Se interpretar como UTC-3 resulta em timestamp mais próximo do presente (±30min)
      // então o dispositivo está enviando hora local Brasil
      if (Math.abs(diffAsUTC3) < Math.abs(diffAsUTC) && diffAsUTC > 1) {
        timestamp = timestampAsUTC3;
        // Log apenas se diferença era significativa (evita spam)
        if (diffAsUTC > 2) {
          console.log(`[GPS Parser] 🇧🇷 Timezone Brasil: +3h aplicado (era ${diffAsUTC.toFixed(1)}h atrás)`);
        }
      }

      // ✅ VALIDAÇÃO DE TIMESTAMP: Se timestamp inválido, usar hora do servidor
      const minValidDate = new Date('2020-01-01T00:00:00Z');
      const maxValidDate = new Date(now.getTime() + 86400000); // 24h no futuro

      if (timestamp < minValidDate || timestamp > maxValidDate) {
        console.warn(`[GPS Parser] ⚠️ Timestamp inválido (${timestamp.toISOString()}), usando hora do servidor`);
        timestamp = now;
      }

      // ========== GPS INFORMATION BYTE (1 byte) ==========
      // Bits 7-4: GPS Data Length (usually 12 or 13)
      // Bits 3-0: Number of satellites used for positioning
      // As per section 5.2.1.5: "if the value is 0xCB, it means length is 12 and satellites is 11"
      const gpsInfoByte = buffer.readUInt8(offset);
      const gpsDataLength = (gpsInfoByte >> 4) & 0x0F;
      const satellites = gpsInfoByte & 0x0F;
      offset += 1;

      console.log(`[GPS Parser] 📡 GPS Info: length=${gpsDataLength} bytes, satellites=${satellites}`);

      // ========== LATITUDE (4 bytes) ==========
      // As per section 5.2.1.6: Range 0-162000000 (0°-90°)
      // Conversion: value / 1800000 = degrees
      // Bit 31: N/S flag (0=North/+, 1=South/-)
      const latRaw = buffer.readUInt32BE(offset);
      const latBit31 = (latRaw >> 31) & 1;  // 0=North, 1=South
      let latValue = latRaw & 0x7FFFFFFF;   // Get bits 30-0
      let latitude = latValue / 1800000.0;
      if (latBit31 === 1) {
        latitude = -latitude; // South is negative
      }
      offset += 4;

      console.log(`[GPS Parser] 📍 Latitude: ${latitude.toFixed(6)}° (${latBit31 === 0 ? 'North' : 'South'})`);

      // ========== LONGITUDE (4 bytes) ==========
      // As per section 5.2.1.7: Range 0-324000000 (0°-180°)
      // Same conversion as latitude
      // Bit 31: E/W flag (0=East/+, 1=West/-)
      const lonRaw = buffer.readUInt32BE(offset);
      const lonBit31 = (lonRaw >> 31) & 1;  // 0=East, 1=West
      let lonValue = lonRaw & 0x7FFFFFFF;   // Get bits 30-0
      let longitude = lonValue / 1800000.0;
      if (lonBit31 === 1) {
        longitude = -longitude; // West is negative
      }
      offset += 4;

      console.log(`[GPS Parser] 📍 Longitude: ${longitude.toFixed(6)}° (${lonBit31 === 0 ? 'East' : 'West'})`);

      // ✅ Validar ranges conforme especificação
      if (latitude < -90 || latitude > 90) {
        console.warn(`[GPS Parser] ⚠️ Invalid latitude: ${latitude}°, clamping to [-90, 90]`);
        latitude = Math.max(-90, Math.min(90, latitude));
      }
      if (longitude < -180 || longitude > 180) {
        console.warn(`[GPS Parser] ⚠️ Invalid longitude: ${longitude}°, clamping to [-180, 180]`);
        longitude = Math.max(-180, Math.min(180, longitude));
      }

      // Avisar se não tem lock de satélites
      if (latitude === 0 && longitude === 0 && satellites === 0) {
        console.warn(`[GPS Parser] ⚠️ NO GPS LOCK: coordinates are 0,0 and no satellites (device indoors or no signal)`);
      }

      // ========== SPEED (1 byte) ==========
      // As per section 5.2.1.8: 0x00 to 0xFF = 0 to 255 km/h
      // Velocidade é direta em km/h, sem fator de conversão
      const velocidade = buffer.readUInt8(offset);
      offset += 1;

      console.log(`[GPS Parser] 🏃 Speed: ${velocidade} km/h`);

      // ========== COURSE / STATUS (2 bytes) ==========
      // As per section 5.2.1.9: Range 0° to 360°
      // BYTE_1 bits:
      //   Bit7-6: Always 0
      //   Bit5: GPS real-time (1) or differential (0) positioning
      //   Bit4: GPS has been positioned (1) or not (0)
      //   Bit3: East (0) or West (1) longitude
      //   Bit2: North (1) or South (0) latitude
      //   Bit1-0: Part of course
      // BYTE_2: Remaining course bits (0-359)
      const courseStatusByte1 = buffer.readUInt8(offset);
      const courseStatusByte2 = buffer.readUInt8(offset + 1);
      offset += 2;

      // Extract course: bits 0-9 from both bytes
      const course = ((courseStatusByte1 & 0x03) << 8) | courseStatusByte2;

      // Extract status bits
      const gpsRealtime = (courseStatusByte1 >> 5) & 1;
      const gpsPositioned = (courseStatusByte1 >> 4) & 1;
      const lonDirection = (courseStatusByte1 >> 3) & 1; // 0=East, 1=West
      const latDirection = (courseStatusByte1 >> 2) & 1; // 0=South, 1=North

      // ✅ CORREÇÃO CRÍTICA: Aplicar sinais baseados nos bits de direção do Course/Status
      // O rastreador XT40 usa esses bits (não o bit 31 das coordenadas) para indicar hemisfério
      // Bit2: 0=Sul (latitude negativa), 1=Norte (latitude positiva)
      // Bit3: 0=Leste (longitude positiva), 1=Oeste (longitude negativa)
      if (latDirection === 0) {
        latitude = -Math.abs(latitude);  // Sul = negativo
      } else {
        latitude = Math.abs(latitude);   // Norte = positivo
      }
      if (lonDirection === 1) {
        longitude = -Math.abs(longitude); // Oeste = negativo
      } else {
        longitude = Math.abs(longitude);  // Leste = positivo
      }

      console.log(`[GPS Parser] 🧭 Course: ${course}° (${gpsRealtime ? 'Real-time' : 'Differential'} GPS, ${gpsPositioned ? 'Positioned' : 'Not positioned'})`);
      console.log(`[GPS Parser] 🌍 Hemisphere: ${latDirection === 0 ? 'South' : 'North'}, ${lonDirection === 1 ? 'West' : 'East'} → lat=${latitude.toFixed(6)}, lon=${longitude.toFixed(6)}`);

      // ========== LBS INFORMATION ==========
      // As per section 5.2.1.10-13: MCC(2) + MNC(1) + LAC(2) + Cell ID(3)
      const mcc = buffer.readUInt16BE(offset);
      const mnc = buffer.readUInt8(offset + 2);
      const lac = buffer.readUInt16BE(offset + 3);
      const cellId = (buffer.readUInt8(offset + 5) << 16) |
                     (buffer.readUInt8(offset + 6) << 8) |
                     buffer.readUInt8(offset + 7);

      console.log(`[GPS Parser] 📶 LBS: MCC=${mcc}, MNC=${mnc}, LAC=0x${lac.toString(16)}, CellID=${cellId}`);

      console.log(`[GPS Parser] Location complete: lat=${latitude.toFixed(6)}, lon=${longitude.toFixed(6)}, speed=${velocidade}, dir=${course}, sats=${satellites}`);

      // ⚠️ Avisos informativos - NÃO REJEITA O PACOTE
      const nowTime = new Date();
      if (timestamp > new Date(nowTime.getTime() + 86400000)) { // 24 horas no futuro
        console.warn(`[GPS Parser] ⚠️ Timestamp in the future: ${timestamp.toISOString()}`);
      }

      if (velocidade > 250) {
        console.warn(`[GPS Parser] ⚠️ Suspicious speed: ${velocidade} km/h (device may be reporting incorrectly)`);
      }

      // ✅ Calcular precisão estimada baseada em satélites
      // Mais satélites = MELHOR precisão (número MENOR)
      // Fórmula: 50m base - (satélites * 3) com mínimo de 3m
      // 15 sats → ~5m, 10 sats → ~20m, 5 sats → ~35m, 0 sats → ~50m
      let precisaoEstimada = 50;
      if (satellites > 0) {
        precisaoEstimada = Math.max(3, 50 - (satellites * 3));
      }

      const data = {
        latitude: parseFloat(latitude.toFixed(6)),
        longitude: parseFloat(longitude.toFixed(6)),
        velocidade,
        direcao: course,
        precisao: precisaoEstimada,
        satellites,
        altitude: null, // May not be present in all packets
      };

      // Log removido (duplicado) - log principal está no switch case

      return {
        ...baseResult,
        type: 'location',
        timestamp,
        data,
      };
    } catch (error) {
      console.error('[GPS Parser] Location parse error:', error.message);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Parse MSG_INFO packet (0x94)
   *
   * ⚠️ IMPORTANTE: Este pacote NÃO contém dados OBD2 reais!
   *
   * ESTRUTURA REAL DO PACOTE 0x94 (MSG_INFO):
   * Contém informações do SIM card (ICCID) e metadados do dispositivo.
   * Os bytes NÃO são RPM/temperatura/combustível como estava sendo interpretado.
   *
   * Estrutura observada:
   *   0:     Sub-protocol (1 byte) - 0x0A
   *   1-8:   IMEI dispositivo (8 bytes BCD)
   *   9-12:  Timestamp ou dados fixos (07 24 29 20 - idêntico entre dispositivos)
   *   13-14: Dados variáveis
   *   15-24: ICCID do SIM card (10 bytes) - ex: 89552920000001217935
   *
   * NOTA: Os dados OBD2 reais (RPM, temp, combustível) provavelmente vêm
   * de outro protocolo ou precisam de configuração específica no dispositivo.
   */
  parseOBD2(buffer, baseResult, dataOffset = 4) {
    try {
      let offset = dataOffset;

      console.log(`[GPS Parser] ⚠️ MSG_INFO (0x94) - NÃO É OBD2 REAL!`);
      console.log(`[GPS Parser] Raw data: ${buffer.slice(offset, Math.min(offset + 30, buffer.length)).toString('hex').toUpperCase()}`);

      const remainingLength = buffer.length - offset - 6;
      if (remainingLength < 20) {
        console.warn(`[GPS Parser] MSG_INFO packet too short: ${remainingLength} bytes`);
        return null;
      }

      // Sub-protocol (1 byte)
      const subProtocol = buffer.readUInt8(offset);
      console.log(`[GPS Parser] MSG_INFO sub-protocol: 0x${subProtocol.toString(16).padStart(2, '0')}`);
      offset += 1;

      // IMEI do dispositivo (8 bytes BCD)
      const imeiBytes = buffer.slice(offset, offset + 8);
      let imei = '';
      for (let i = 0; i < imeiBytes.length; i++) {
        const byte = imeiBytes[i];
        const high = (byte >> 4) & 0x0F;
        const low = byte & 0x0F;
        imei += high.toString() + low.toString();
      }
      imei = imei.replace(/^0+/, '');
      console.log(`[GPS Parser] MSG_INFO IMEI: ${imei}`);
      offset += 8;

      // Extrair ICCID do SIM card (últimos 10 bytes antes de serial/crc/footer)
      // Os bytes são: 89 55 29 20 00 00 01 XX XX XX (onde XX são únicos por chip)
      const iccidOffset = offset + 6; // Pular bytes fixos (07 24 29 20 00 1X)
      let iccid = '';
      try {
        const iccidBytes = buffer.slice(iccidOffset, iccidOffset + 10);
        for (let i = 0; i < iccidBytes.length; i++) {
          const byte = iccidBytes[i];
          const high = (byte >> 4) & 0x0F;
          const low = byte & 0x0F;
          iccid += high.toString() + low.toString();
        }
        console.log(`[GPS Parser] MSG_INFO ICCID extraído: ${iccid}`);
      } catch (e) {
        console.log(`[GPS Parser] MSG_INFO não foi possível extrair ICCID: ${e.message}`);
      }

      // Retornar como tipo 'sim_info' para não confundir com dados OBD2
      const data = {
        tipo_pacote: 'MSG_INFO',
        iccid: iccid || null,
        imei_pacote: imei,
        // NÃO incluir rpm, temperatura, combustível pois são dados FALSOS
        nota: 'Pacote 0x94 contém info do SIM, NÃO dados OBD2 reais'
      };

      console.log(`[GPS Parser] ✅ MSG_INFO (0x94) parsed - ICCID: ${iccid}`);
      console.log(`[GPS Parser] ⚠️ Este pacote NÃO contém dados OBD2 reais!`);

      return {
        ...baseResult,
        type: 'sim_info', // Renomeado de 'obd2' para 'sim_info'
        data,
      };
    } catch (error) {
      console.error('[GPS Parser] MSG_INFO parse error:', error.message);
      return null;
    }
  }

  /**
   * Parse alarm packet (0x16) - Full structure per XT40 Protocol Rev 1.06
   * Structure: DateTime(6) + GPS(1+4+4+1+2) + LBS(1+2+1+2+3) + Status(1+1+1+2) + Serial(2)
   */
  parseAlarm(buffer, baseResult, dataOffset = 4) {
    try {
      let offset = dataOffset; // After header + length + protocol

      // ========== DATE TIME (6 bytes) ==========
      const year = 2000 + buffer.readUInt8(offset);
      const month = buffer.readUInt8(offset + 1);
      const day = buffer.readUInt8(offset + 2);
      const hour = buffer.readUInt8(offset + 3);
      const minute = buffer.readUInt8(offset + 4);
      const second = buffer.readUInt8(offset + 5);
      let timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      offset += 6;

      // ✅ CORREÇÃO TIMEZONE BRASIL: Dispositivos enviam hora local (UTC-3)
      const now = new Date();
      const diffAsUTC = (now.getTime() - timestamp.getTime()) / (1000 * 60 * 60);
      const timestampAsUTC3 = new Date(timestamp.getTime() + (3 * 60 * 60 * 1000));
      const diffAsUTC3 = (now.getTime() - timestampAsUTC3.getTime()) / (1000 * 60 * 60);

      if (Math.abs(diffAsUTC3) < Math.abs(diffAsUTC) && diffAsUTC > 1) {
        timestamp = timestampAsUTC3;
      }

      // ✅ VALIDAÇÃO DE TIMESTAMP: Se timestamp inválido, usar hora do servidor
      const minValidDate = new Date('2020-01-01T00:00:00Z');
      const maxValidDate = new Date(now.getTime() + 86400000); // 24h no futuro
      if (timestamp < minValidDate || timestamp > maxValidDate) {
        console.warn(`[GPS Parser] ⚠️ Alarm timestamp inválido (${timestamp.toISOString()}), usando hora do servidor`);
        timestamp = now;
      }

      // ========== GPS INFORMATION ==========
      const gpsInfoByte = buffer.readUInt8(offset);
      const gpsDataLength = (gpsInfoByte >> 4) & 0x0F;
      const satellites = gpsInfoByte & 0x0F;
      offset += 1;

      const latRaw = buffer.readUInt32BE(offset);
      const latBit31 = (latRaw >> 31) & 1;
      let latitude = (latRaw & 0x7FFFFFFF) / 1800000.0;
      if (latBit31 === 1) latitude = -latitude;
      offset += 4;

      const lonRaw = buffer.readUInt32BE(offset);
      const lonBit31 = (lonRaw >> 31) & 1;
      let longitude = (lonRaw & 0x7FFFFFFF) / 1800000.0;
      if (lonBit31 === 1) longitude = -longitude;
      offset += 4;

      const speed = buffer.readUInt8(offset);
      offset += 1;

      const courseStatus = buffer.readUInt16BE(offset);
      const courseStatusByte1 = (courseStatus >> 8) & 0xFF;
      const course = ((courseStatusByte1 & 0x03) << 8) | (courseStatus & 0xFF);

      // ✅ CORREÇÃO: Extrair bits de direção e aplicar sinais
      const lonDirection = (courseStatusByte1 >> 3) & 1; // 0=East, 1=West
      const latDirection = (courseStatusByte1 >> 2) & 1; // 0=South, 1=North

      if (latDirection === 0) {
        latitude = -Math.abs(latitude);  // Sul = negativo
      } else {
        latitude = Math.abs(latitude);   // Norte = positivo
      }
      if (lonDirection === 1) {
        longitude = -Math.abs(longitude); // Oeste = negativo
      } else {
        longitude = Math.abs(longitude);  // Leste = positivo
      }
      offset += 2;

      // ========== LBS INFORMATION ==========
      const lbsLength = buffer.readUInt8(offset);
      offset += 1;

      const mcc = buffer.readUInt16BE(offset);
      offset += 2;

      const mnc = buffer.readUInt8(offset);
      offset += 1;

      const lac = buffer.readUInt16BE(offset);
      offset += 2;

      const cellId = (buffer.readUInt8(offset) << 16) |
                     (buffer.readUInt8(offset + 1) << 8) |
                     buffer.readUInt8(offset + 2);
      offset += 3;

      // ========== STATUS INFORMATION ==========
      const terminalInfo = buffer.readUInt8(offset);
      const voltageBit = (terminalInfo >> 7) & 1;  // Oil/Electricity connected
      const gpsBit = (terminalInfo >> 6) & 1;      // GPS tracking on
      const alarmBits = (terminalInfo >> 3) & 0x07; // Bits 5-3
      const chargeBit = (terminalInfo >> 2) & 1;   // Charge on
      const accBit = (terminalInfo >> 1) & 1;      // ACC high
      const activeBit = terminalInfo & 1;          // Activated
      offset += 1;

      const voltageLevel = buffer.readUInt8(offset);
      offset += 1;

      const gsmSignal = buffer.readUInt8(offset);
      offset += 1;

      const alarmLanguageByte1 = buffer.readUInt8(offset);
      const alarmLanguageByte2 = buffer.readUInt8(offset + 1);
      offset += 2;

      // ========== MAP ALARM CODES ==========
      const alarmCodeMap = {
        0x00: { tipo: 'Normal', severidade: 'info' },
        0x01: { tipo: 'SOS', severidade: 'critical' },
        0x02: { tipo: 'Power Cut Alarm', severidade: 'warning' },
        0x03: { tipo: 'Shock Alarm', severidade: 'warning' },
        0x04: { tipo: 'ACC On Alarm', severidade: 'info' },
        0x05: { tipo: 'ACC Off Alarm', severidade: 'info' },
        0x08: { tipo: 'Over Speed Alarm', severidade: 'warning' },
        0x0E: { tipo: 'Fast Acceleration', severidade: 'warning' },
        0x0F: { tipo: 'Harsh Braking', severidade: 'warning' },
        0x10: { tipo: 'Sharp Turn', severidade: 'warning' },
        0x11: { tipo: 'Collision', severidade: 'critical' },
        0x13: { tipo: 'Tow Sensor', severidade: 'warning' },
        0x14: { tipo: 'Low Power', severidade: 'warning' },
        0x15: { tipo: 'Main Power Connected', severidade: 'info' },
        0x18: { tipo: 'Low Battery Backup', severidade: 'warning' },
        0x21: { tipo: 'Full Charge', severidade: 'info' },
        0x23: { tipo: 'Fall Alarm', severidade: 'critical' },
        0x26: { tipo: 'Light Sensor', severidade: 'info' },
      };

      const alarmInfo = alarmCodeMap[alarmLanguageByte1] || {
        tipo: `Alarm 0x${alarmLanguageByte1.toString(16).toUpperCase()}`,
        severidade: 'info'
      };

      const statusDescription = [
        voltageBit === 0 ? 'Oil/Electricity connected' : 'Oil/Electricity disconnected',
        gpsBit === 1 ? 'GPS ON' : 'GPS OFF',
        `Alarm: ${alarmInfo.tipo}`,
        chargeBit === 1 ? 'Charging' : 'Not charging',
        accBit === 1 ? 'ACC HIGH' : 'ACC LOW',
        activeBit === 1 ? 'Activated' : 'Deactivated',
      ].join(', ');

      console.log(`[GPS Parser] 🚨 ALARM PACKET PARSED:`);
      console.log(`  → Type: ${alarmInfo.tipo}`);
      console.log(`  → Location: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
      console.log(`  → GPS Satellites: ${satellites}`);
      console.log(`  → Speed: ${speed} km/h`);
      console.log(`  → Status: ${statusDescription}`);

      return {
        ...baseResult,
        type: 'alarm',
        data: {
          tipo_alarme: alarmInfo.tipo,
          severidade: alarmInfo.severidade,
          descricao: statusDescription,
          latitude,
          longitude,
          velocidade: speed,
          satelites: satellites,
          nivel_tensao: voltageLevel,
          sinal_gsm: gsmSignal,
          timestamp,
        },
      };
    } catch (error) {
      console.error('[GPS Parser] ❌ Alarm parse error:', error.message);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Parse status packet (0x13) - GT06 Protocol
   * Contains device status including ACC (ignition) and battery info
   *
   * Structure (XT40 Protocol Rev 1.06 - Section 5.3):
   * - Terminal Info Status (1 byte):
   *   Bit 0: Oil/Electricity disconnected (0=normal, 1=cut)
   *   Bit 1: GPS tracking (0=off, 1=on)
   *   Bit 2: Alarm type (see below)
   *   Bit 3-4: Alarm type bits
   *   Bit 5: Charging (0=not charging, 1=charging)
   *   Bit 6: ACC (0=low/off, 1=high/on) ← IGNIÇÃO!
   *   Bit 7: Fortification (0=off, 1=on)
   * - Battery Voltage (2 bytes)
   * - GSM Signal Strength (1 byte)
   * - Reserved/Extended (2 bytes)
   */
  parseStatus(buffer, baseResult, dataOffset = 4) {
    try {
      const offset = dataOffset;

      // Terminal Info Status (1 byte) - contém ACC!
      const terminalStatus = buffer.readUInt8(offset);

      // Extrair bits de status
      const oilCut = (terminalStatus & 0x01) !== 0;        // Bit 0
      const gpsTracking = (terminalStatus & 0x02) !== 0;   // Bit 1
      const charging = (terminalStatus & 0x20) !== 0;      // Bit 5
      const acc = (terminalStatus & 0x40) !== 0;           // Bit 6 ← IGNIÇÃO
      const fortification = (terminalStatus & 0x80) !== 0; // Bit 7

      // Battery Voltage (2 bytes) - offset + 1
      const batteryVoltage = buffer.readUInt16BE(offset + 1) / 100; // Em volts

      // GSM Signal (1 byte) - offset + 3
      const gsmSignal = buffer.readUInt8(offset + 3);

      console.log(`[GPS Parser] 🔋 Status 0x13: ACC=${acc ? 'ON' : 'OFF'}, Bat=${batteryVoltage}V, GSM=${gsmSignal}, Charging=${charging}`);

      return {
        ...baseResult,
        type: 'status',
        data: {
          ignicao: acc,  // ← ACC = Ignição!
          tensao_bateria: batteryVoltage,
          gsm_signal: gsmSignal,
          charging: charging,
          oil_cut: oilCut,
          gps_tracking: gpsTracking,
          fortification: fortification,
          terminal_status_raw: terminalStatus,
        },
      };
    } catch (error) {
      console.error('[GPS Parser] Status parse error:', error.message);
      return null;
    }
  }

  /**
   * Parse X3Tech Location Data Frame (0x22) - Protocolo XT40 Rev 1.06 Seção 5.5
   * Estrutura completa com campos extras: odômetro, horímetro, tensões, etc.
   *
   * Campos adicionais após Location Data (0x12):
   * - Location Source Type (1 byte)
   * - Terminal ID (8 bytes)
   * - Internal Date Time (6 bytes)
   * - Power Voltage (2 bytes)
   * - Battery Voltage (1 byte)
   * - Mileage/Odômetro (3 bytes)
   * - TotalHoursSum/Horímetro (3 bytes)
   */
  parseX3TechLocation(buffer, baseResult, dataOffset = 5) {
    try {
      let offset = dataOffset;

      console.log(`[X3Tech] Parsing 0x22 from offset ${offset}, total buffer: ${buffer.length} bytes`);

      // ========== LOCATION SOURCE TYPE (1 byte) ==========
      const locationType = buffer.readUInt8(offset);
      const locationTypeMap = {
        0x01: 'Tracking (TIMER)',
        0x02: 'Static',
        0x03: 'ALARM'
      };
      console.log(`[X3Tech] Location Source: ${locationTypeMap[locationType] || `Unknown (0x${locationType.toString(16)})`}`);
      offset += 1;

      // ========== TERMINAL ID / IMEI (8 bytes BCD) ==========
      // XT40 usa BCD padrão (high nibble first), não GT06 (low nibble first)
      const imeiBytes = buffer.slice(offset, offset + 8);
      const imei = this.bcdToStringStandard(imeiBytes).replace(/^0+/, ''); // Remove leading zeros
      console.log(`[X3Tech] IMEI: ${imei}`);
      offset += 8;

      // ========== INTERNAL DATE TIME (6 bytes) ==========
      const intYear = 2000 + buffer.readUInt8(offset);
      const intMonth = buffer.readUInt8(offset + 1);
      const intDay = buffer.readUInt8(offset + 2);
      const intHour = buffer.readUInt8(offset + 3);
      const intMinute = buffer.readUInt8(offset + 4);
      const intSecond = buffer.readUInt8(offset + 5);
      const internalTimestamp = new Date(Date.UTC(intYear, intMonth - 1, intDay, intHour, intMinute, intSecond));
      console.log(`[X3Tech] Internal Timestamp: ${internalTimestamp.toISOString()}`);
      offset += 6;

      // ========== GPS DATE TIME (6 bytes) ==========
      const gpsYear = 2000 + buffer.readUInt8(offset);
      const gpsMonth = buffer.readUInt8(offset + 1);
      const gpsDay = buffer.readUInt8(offset + 2);
      const gpsHour = buffer.readUInt8(offset + 3);
      const gpsMinute = buffer.readUInt8(offset + 4);
      const gpsSecond = buffer.readUInt8(offset + 5);
      let gpsTimestamp = new Date(Date.UTC(gpsYear, gpsMonth - 1, gpsDay, gpsHour, gpsMinute, gpsSecond));
      offset += 6;

      // ✅ AUTO-CORREÇÃO DE TIMEZONE: Detecta e corrige automaticamente
      const now = new Date();
      const diffHours = (now.getTime() - gpsTimestamp.getTime()) / (1000 * 60 * 60);
      if (diffHours > 2 && diffHours < 5) {
        gpsTimestamp = new Date(gpsTimestamp.getTime() + (3 * 60 * 60 * 1000));
        console.log(`[X3Tech] ⚠️ Auto-correção timezone: +3h aplicado (diff era ${diffHours.toFixed(1)}h)`);
      }

      // Validar timestamp
      if (gpsTimestamp < new Date('2020-01-01') || gpsTimestamp > new Date(now.getTime() + 86400000)) {
        console.warn(`[X3Tech] Invalid GPS timestamp, using server time`);
        gpsTimestamp = now;
      }

      // ========== GPS INFORMATION (1 byte) ==========
      const gpsInfoByte = buffer.readUInt8(offset);
      const gpsDataLength = (gpsInfoByte >> 4) & 0x0F;
      const satellites = gpsInfoByte & 0x0F;
      console.log(`[X3Tech] GPS: length=${gpsDataLength}, satellites=${satellites}`);
      offset += 1;

      // ========== LATITUDE (4 bytes) ==========
      const latRaw = buffer.readUInt32BE(offset);
      let latitude = (latRaw & 0x7FFFFFFF) / 1800000.0;
      // DEBUG: Log bytes brutos para análise
      console.log(`[X3Tech] LAT RAW: 0x${latRaw.toString(16).toUpperCase()} = ${latRaw} → ${latitude.toFixed(6)}°`);
      offset += 4;

      // ========== LONGITUDE (4 bytes) ==========
      const lonRaw = buffer.readUInt32BE(offset);
      let longitude = (lonRaw & 0x7FFFFFFF) / 1800000.0;
      // DEBUG: Log bytes brutos para análise
      console.log(`[X3Tech] LON RAW: 0x${lonRaw.toString(16).toUpperCase()} = ${lonRaw} → ${longitude.toFixed(6)}°`);
      offset += 4;

      // ========== SPEED (1 byte) ==========
      const velocidade = buffer.readUInt8(offset);
      offset += 1;

      // ========== COURSE/STATUS (2 bytes) ==========
      const courseStatusByte1 = buffer.readUInt8(offset);
      const courseStatusByte2 = buffer.readUInt8(offset + 1);
      const course = ((courseStatusByte1 & 0x03) << 8) | courseStatusByte2;

      // Aplicar direções (hemisférios)
      const lonDirection = (courseStatusByte1 >> 3) & 1; // 0=East, 1=West
      const latDirection = (courseStatusByte1 >> 2) & 1; // 0=South, 1=North
      const gpsPositioned = (courseStatusByte1 >> 4) & 1;

      if (latDirection === 0) latitude = -Math.abs(latitude);
      else latitude = Math.abs(latitude);
      if (lonDirection === 1) longitude = -Math.abs(longitude);
      else longitude = Math.abs(longitude);

      console.log(`[X3Tech] Position: ${latitude.toFixed(6)}, ${longitude.toFixed(6)} | Speed: ${velocidade}km/h | Course: ${course}°`);
      offset += 2;

      // ========== LBS LENGTH (1 byte) ==========
      const lbsLength = buffer.readUInt8(offset);
      console.log(`[X3Tech] LBS Length: ${lbsLength}`);
      offset += 1;

      // ========== LBS INFORMATION ==========
      const mcc = buffer.readUInt16BE(offset);
      const mnc = buffer.readUInt8(offset + 2);
      const lac = buffer.readUInt16BE(offset + 3);
      const cellId = (buffer.readUInt8(offset + 5) << 16) | (buffer.readUInt8(offset + 6) << 8) | buffer.readUInt8(offset + 7);
      console.log(`[X3Tech] LBS: MCC=${mcc}, MNC=${mnc}, LAC=${lac}, Cell=${cellId}`);
      offset += 8;

      // ========== TERMINAL INFORMATION (1 byte) ==========
      const terminalInfo = buffer.readUInt8(offset);
      const accBit = (terminalInfo >> 1) & 1; // Bit1 = ACC (ignição)
      const gpsBit = (terminalInfo >> 6) & 1;
      const chargeBit = (terminalInfo >> 2) & 1;
      const ignicao = accBit === 1;
      console.log(`[X3Tech] Terminal Info: ACC=${ignicao ? 'ON' : 'OFF'}, GPS=${gpsBit ? 'ON' : 'OFF'}, Charging=${chargeBit ? 'YES' : 'NO'}`);
      offset += 1;

      // ========== POWER VOLTAGE (2 bytes) - Seção 5.5.1.19 ==========
      // Tensão principal multiplicada por 100 (ex: 1185 = 11.85V)
      const powerVoltageRaw = buffer.readUInt16BE(offset);
      const tensao_principal = powerVoltageRaw / 100.0; // Dividir por 100
      console.log(`[X3Tech] Power Voltage: ${powerVoltageRaw} raw → ${tensao_principal.toFixed(2)}V`);
      offset += 2;

      // ========== BATTERY VOLTAGE (1 byte) - Seção 5.5.1.20 ==========
      // Tensão bateria multiplicada por 10 (ex: 41 = 4.1V)
      const batteryVoltageRaw = buffer.readUInt8(offset);
      const tensao_bateria = batteryVoltageRaw / 10.0; // Dividir por 10
      // Calcular percentual estimado (3.0V = 0%, 4.2V = 100%)
      const percentual_bateria = Math.max(0, Math.min(100, ((tensao_bateria - 3.0) / 1.2) * 100));
      console.log(`[X3Tech] Battery Voltage: ${batteryVoltageRaw} raw → ${tensao_bateria.toFixed(2)}V (${percentual_bateria.toFixed(0)}%)`);
      offset += 1;

      // ========== GSM SIGNAL STRENGTH (1 byte) ==========
      const gsmSignal = buffer.readUInt8(offset);
      console.log(`[X3Tech] GSM Signal: ${gsmSignal}%`);
      offset += 1;

      // ========== ALARM/LANGUAGE (2 bytes) ==========
      const alarmByte = buffer.readUInt8(offset);
      const languageByte = buffer.readUInt8(offset + 1);
      console.log(`[X3Tech] Alarm: 0x${alarmByte.toString(16)}, Language: 0x${languageByte.toString(16)}`);
      offset += 2;

      // ========== MILEAGE/ODÔMETRO (3 bytes) - Seção 5.5.1.23 ==========
      // 3 bytes - Valor bruto do rastreador (calibração aplicada na API)
      const odometro_embarcado = (buffer.readUInt8(offset) << 16) | (buffer.readUInt8(offset + 1) << 8) | buffer.readUInt8(offset + 2);
      console.log(`[X3Tech] Odometer raw: ${odometro_embarcado} km`);
      offset += 3;

      // ========== TOTAL HOURS SUM/HORÍMETRO (3 bytes) - Seção 5.5.1.24 ==========
      // 3 bytes em MINUTOS (converter para horas)
      const horimetroMinutos = (buffer.readUInt8(offset) << 16) | (buffer.readUInt8(offset + 1) << 8) | buffer.readUInt8(offset + 2);
      const hora_motor_embarcada = horimetroMinutos / 60.0; // Converter minutos para horas
      console.log(`[X3Tech] Horimeter: ${horimetroMinutos} minutes → ${hora_motor_embarcada.toFixed(2)} hours`);
      offset += 3;

      console.log(`[X3Tech] ✅ Parse complete - Final offset: ${offset}`);

      // ✅ Calcular precisão estimada baseada em satélites
      // Mais satélites = MELHOR precisão (número MENOR)
      // Fórmula: 50m base - (satélites * 3) com mínimo de 3m
      // 15 sats → ~5m, 10 sats → ~20m, 5 sats → ~35m, 0 sats → ~50m
      let precisaoEstimadaX3 = 50;
      if (satellites > 0) {
        precisaoEstimadaX3 = Math.max(3, 50 - (satellites * 3));
      }

      return {
        ...baseResult,
        type: 'location',
        imei,
        timestamp: gpsTimestamp,
        data: {
          latitude: parseFloat(latitude.toFixed(6)),
          longitude: parseFloat(longitude.toFixed(6)),
          velocidade,
          direcao: course,
          precisao: precisaoEstimadaX3,
          satellites,
          altitude: null,
          ignicao,
          odometro_embarcado,
          hora_motor_embarcada,
          percentual_bateria: parseFloat(percentual_bateria.toFixed(1)),
          tensao_bateria: parseFloat(tensao_bateria.toFixed(2)),
          tensao_principal: parseFloat(tensao_principal.toFixed(2)),
          nivel_combustivel: null, // Não disponível no 0x22
          sinal_gsm: gsmSignal,
          // ✅ NOVO: Location Source Type para filtragem de dados
          // 0x01 = Tracking (TIMER) - dados de movimento real
          // 0x02 = Static - veículo parado (não salvar como localização de movimento)
          // 0x03 = ALARM - evento de alarme
          location_source_type: locationType,
          location_source_name: locationTypeMap[locationType] || `Unknown (0x${locationType.toString(16)})`,
        },
      };
    } catch (error) {
      console.error('[X3Tech] Parse error:', error.message);
      console.error(error.stack);
      return null;
    }
  }

  /**
   * Convert BCD (Binary Coded Decimal) bytes to string
   * GT06 Protocol: nibbles are SWAPPED - low nibble first, high nibble second
   * Example: byte 0x53 = (5 low, 3 high) = "35"
   */
  bcdToString(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const low = byte & 0x0F;           // Lower 4 bits (ones digit)
      const high = (byte >> 4) & 0x0F;   // Upper 4 bits (tens digit)
      // GT06 uses swapped format: low nibble first, high nibble second
      result += low.toString() + high.toString();
    }
    return result;
  }

  /**
   * Convert BCD (Binary Coded Decimal) bytes to string - STANDARD format
   * XT40 Protocol 0x22: Uses standard BCD (high nibble first)
   * Example: byte 0x35 = (3 high, 5 low) = "35"
   */
  bcdToStringStandard(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const high = (byte >> 4) & 0x0F;   // Upper 4 bits (tens digit)
      const low = byte & 0x0F;           // Lower 4 bits (ones digit)
      // Standard BCD: high nibble first, then low nibble
      result += high.toString() + low.toString();
    }
    return result;
  }

  /**
   * ✅ NOVO: Extrair IMEI de qualquer pacote (se disponível)
   * Útil para logging com contexto de IMEI
   */
  extractImeiFromBuffer(buffer) {
    try {
      if (buffer.length < 12) return null;
      const protocolNumber = buffer.readUInt8(3);
      if (protocolNumber === 0x01 && buffer.length >= 12) {
        const imeiBytes = buffer.slice(4, 12);
        return this.bcdToString(imeiBytes);
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Calculate CRC checksum for GT06 protocol (simple XOR - for some packets)
   */
  calculateCRC(buffer, start, end) {
    let crc = 0;
    for (let i = start; i < end; i++) {
      crc ^= buffer[i];
    }
    return crc;
  }

  /**
   * Calculate CRC16-X25 for GT06 protocol (for ACK responses)
   * This is the standard CRC used in GT06 protocol
   */
  calculateCRC16(buffer, start, end) {
    const crcTable = [
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
    for (let i = start; i < end; i++) {
      fcs = (fcs >> 8) ^ crcTable[(fcs ^ buffer[i]) & 0xFF];
    }
    return (~fcs) & 0xFFFF;
  }

  /**
   * ✅ CORREÇÃO #2: Validar CRC do pacote recebido
   */
  validateCRC(buffer, packetLength) {
    try {
      // Estrutura do pacote: [start(2)][length(1)][data(length)][crc(2)][end(2)]
      // CRC é calculado sobre: length(1) + protocol(1) + content + serial(2)
      // CRC está nos últimos 2 bytes antes do footer

      // Posição do CRC (2 bytes): start(2) + length(1) + data(length-2) = primeiros 2 bytes do CRC
      const crcPos = 2 + 1 + packetLength - 2;

      if (crcPos + 2 > buffer.length - 2) {
        console.warn(`[CRC] CRC position invalid: ${crcPos}, buffer length ${buffer.length}`);
        return false;
      }

      // CRC esperado (do pacote recebido) - 2 bytes, big-endian
      const expectedCrc = buffer.readUInt16BE(crcPos);

      // Calcular CRC: dados começam em posição 2 (após start) até crcPos
      const calculatedCrc = this.calculateCRC16(buffer, 2, crcPos);

      // Comparar
      const isValid = expectedCrc === calculatedCrc;

      if (!isValid) {
        console.warn(
          `[CRC] Validation failed: expected 0x${expectedCrc.toString(16).padStart(4, '0').toUpperCase()}, ` +
          `calculated 0x${calculatedCrc.toString(16).padStart(4, '0').toUpperCase()}`
        );
      } else {
        console.log(`[CRC] ✓ Validation passed: 0x${calculatedCrc.toString(16).padStart(4, '0').toUpperCase()}`);
      }

      return isValid;
    } catch (error) {
      console.error(`[CRC] Validation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Generate acknowledgment response for XT40 (GT06 Protocol)
   * Format: [0x7878][Length][ProtocolNumber][SerialNumber(2)][CRC16(2)][0x0D][0x0A]
   * Total: 10 bytes for login ACK
   */
  createAckResponse(protocolNumber, serialNumber) {
    try {
      // Buffer: start(2) + length(1) + protocol(1) + serial(2) + crc16(2) + end(2) = 10 bytes
      const buffer = Buffer.alloc(10);
      let pos = 0;

      // Start bit
      buffer.writeUInt16BE(0x7878, pos);
      pos += 2;

      // Length (data bytes: protocol(1) + serial(2) + crc(2) = 5 bytes)
      buffer.writeUInt8(0x05, pos);
      pos += 1;

      // Protocol number (echo back the same protocol)
      buffer.writeUInt8(protocolNumber, pos);
      pos += 1;

      // Serial number (2 bytes, big endian)
      buffer.writeUInt16BE(serialNumber || 0x0001, pos);
      pos += 2;

      // Calculate CRC16 (from length byte position 2 to before CRC position)
      const crc16 = this.calculateCRC16(buffer, 2, pos);
      buffer.writeUInt16BE(crc16, pos);
      pos += 2;

      // End bits
      buffer.writeUInt8(0x0D, pos);
      pos += 1;
      buffer.writeUInt8(0x0A, pos);

      console.log(`[GPS Parser] ACK criado: ${buffer.toString('hex').toUpperCase()} (protocol=0x${protocolNumber.toString(16)}, serial=${serialNumber})`);

      return buffer;
    } catch (error) {
      console.error('[GPS Parser] ACK creation error:', error.message);
      return null;
    }
  }
}

module.exports = new GPSParser();
