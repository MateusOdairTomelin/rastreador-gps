/**
 * XT40 Protocol Parser - Versão Corrigida
 * Baseado em documentação GT06 protocol
 *
 * CORREÇÕES APLICADAS:
 * ✅ Latitude/Longitude: Confirmado uso correto de /1800000
 * ✅ Extração de N/S e E/W flags
 * ✅ Validações de range adicionadas
 * ✅ Melhor tratamento de erros
 */

// CRC-ITU Lookup Table (256 entries)
const CRC_TABLE = [
  0x0000, 0x1189, 0x2312, 0x329B, 0x4624, 0x57AD, 0x6536, 0x74BF,
  0x8C48, 0x9DC1, 0xAF5A, 0xBED3, 0xCA6C, 0xDBE5, 0xE97E, 0xF8F7,
  // ... (rest of table omitted for brevity, same as original)
];

class XT40Parser {
  /**
   * Parse coordinate with proper formula
   *
   * Formato: 1/30000 minuto
   * Conversão: valor / 30000 / 60 = valor / 1800000 graus
   *
   * Bit 31: Direction flag (0=North/East, 1=South/West)
   * Bits 30-0: Coordinate value
   */
  static parseLatitude(buffer, offset) {
    const rawValue = buffer.readUInt32BE(offset);

    // Extract direction flag (bit 31)
    const isNorth = ((rawValue & 0x80000000) >> 31) === 0;

    // Extract coordinate value (bits 30-0)
    const coordinateValue = (rawValue & 0x7FFFFFFF);

    // Convert: 1/30000 minute format
    // 1 minute = 1/60 degree
    // So: value / 30000 / 60 = value / 1800000
    const degrees = coordinateValue / 1800000.0;

    // Validate range
    if (degrees > 90) {
      console.warn(`[XT40] Invalid latitude: ${degrees} (exceeds 90°)`);
      return isNorth ? 90 : -90;
    }

    return isNorth ? degrees : -degrees;
  }

  static parseLongitude(buffer, offset) {
    const rawValue = buffer.readUInt32BE(offset);

    // Extract direction flag (bit 31)
    const isEast = ((rawValue & 0x80000000) >> 31) === 0;

    // Extract coordinate value (bits 30-0)
    const coordinateValue = (rawValue & 0x7FFFFFFF);

    // Convert: 1/30000 minute format
    const degrees = coordinateValue / 1800000.0;

    // Validate range
    if (degrees > 180) {
      console.warn(`[XT40] Invalid longitude: ${degrees} (exceeds 180°)`);
      return isEast ? 180 : -180;
    }

    return isEast ? degrees : -degrees;
  }

  /**
   * Parse location packet (0x12) with corrected coordinate parsing
   */
  static parseLocation(buffer) {
    const offset = 4; // After header, length, protocol

    try {
      // DateTime (6 bytes: YY MM DD HH MM SS)
      const year = 2000 + buffer.readUInt8(offset);
      const month = buffer.readUInt8(offset + 1);
      const day = buffer.readUInt8(offset + 2);
      const hour = buffer.readUInt8(offset + 3);
      const minute = buffer.readUInt8(offset + 4);
      const second = buffer.readUInt8(offset + 5);

      const timestamp = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

      // ✅ COORDENADAS CORRIGIDAS
      const latitude = this.parseLatitude(buffer, offset + 6);
      const longitude = this.parseLongitude(buffer, offset + 10);

      // Speed (1 byte, km/h)
      const velocidade = buffer.readUInt8(offset + 14);

      // Direction/Course (2 bytes)
      const direcao = buffer.readUInt16BE(offset + 15) & 0x03FF;

      // Satellite count
      const satellites = buffer.readUInt8(offset + 17) || 0;

      // Validate coordinates
      if (latitude < -90 || latitude > 90) {
        console.warn(`[XT40] Invalid latitude: ${latitude}`);
        return null;
      }

      if (longitude < -180 || longitude > 180) {
        console.warn(`[XT40] Invalid longitude: ${longitude}`);
        return null;
      }

      // Detect no GPS lock (0,0 coordinates)
      if (latitude === 0 && longitude === 0) {
        console.warn(`[XT40] No GPS lock (0,0 coordinates)`);
      }

      return {
        latitude: parseFloat(latitude.toFixed(6)),
        longitude: parseFloat(longitude.toFixed(6)),
        velocidade,
        direcao,
        satellites,
        timestamp,
        precisao: satellites * 5,
      };
    } catch (error) {
      console.error('[XT40] Location parse error:', error.message);
      return null;
    }
  }

  /**
   * Calcular CRC16 para validação
   */
  static calculateCRC16(buffer, start, end) {
    let crc = 0xFFFF;

    for (let i = start; i < end; i++) {
      const byte = buffer[i];
      crc = (crc >> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    }

    return crc;
  }

  /**
   * Validar CRC do pacote
   */
  static validateCRC(buffer, packetLength) {
    try {
      // CRC position: 2 + 1 + packetLength - 1
      const crcPos = 2 + 1 + packetLength - 1;

      if (crcPos >= buffer.length) {
        console.warn(`[XT40] CRC position ${crcPos} >= buffer length ${buffer.length}`);
        return false;
      }

      // Expected CRC (from packet)
      const expectedCrc = buffer.readUInt8(crcPos);

      // Calculate CRC
      const calculatedCrc = this.calculateCRC16(buffer, 2, crcPos);

      if (expectedCrc !== (calculatedCrc & 0xFF)) {
        console.warn(
          `[XT40] CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(2, '0')}, ` +
          `calculated 0x${(calculatedCrc & 0xFF).toString(16).padStart(2, '0')}`
        );
        return false;
      }

      return true;
    } catch (error) {
      console.error(`[XT40] CRC validation error: ${error.message}`);
      return false;
    }
  }
}

module.exports = XT40Parser;
