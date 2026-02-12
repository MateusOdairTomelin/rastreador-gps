#!/usr/bin/env node

const net = require('net');
const fs = require('fs');
const path = require('path');

/**
 * ADVANCED PACKET ANALYZER
 * Rastreia e analisa todas as comunicações do rastreador
 * Objetivo: Entender o protocolo completo
 */

const logFile = '/tmp/packet-analysis.log';
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

class PacketAnalyzer {
  constructor() {
    this.packets = [];
    this.connections = new Map();
    this.startTime = new Date();
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logStream.write(logMessage + '\n');
  }

  analyzePacket(data, direction = 'RX') {
    const hex = data.toString('hex').toUpperCase();
    const length = data.length;

    // Analisar estrutura GT06
    if (hex.startsWith('7878') || hex.startsWith('7979')) {
      return this.parseGT06(data, hex, direction);
    }

    return {
      hex,
      length,
      direction,
      analysis: 'Estrutura desconhecida'
    };
  }

  parseGT06(buffer, hex, direction) {
    const startBit = buffer.readUInt16BE(0);
    const length = buffer.readUInt8(2);
    const protocolNum = buffer.readUInt8(3);

    const protocolNames = {
      0x01: 'LOGIN/Heartbeat',
      0x08: 'Terminal Status Report',
      0x12: 'Location Data',
      0x13: 'GPS Report',
      0x16: 'Alarm',
      0x19: 'GPS Additional Info',
      0x20: 'Server Response',
      0x80: 'Command Query',
      0x81: 'Command Execute',
      0x94: 'OBD2 Data',
      0xA0: 'Server Command',
      0xA1: 'Server Heartbeat'
    };

    const protocolName = protocolNames[protocolNum] || `Unknown (0x${protocolNum.toString(16)})`;

    let analysis = {
      hex,
      direction,
      length: buffer.length,
      packetLength: length,
      protocol: {
        number: `0x${protocolNum.toString(16).padStart(2, '0').toUpperCase()}`,
        name: protocolName
      }
    };

    // Análise específica por protocolo
    switch (protocolNum) {
      case 0x01:
        analysis.details = this.parseLogin(buffer);
        break;
      case 0x12:
        analysis.details = this.parseLocation(buffer);
        break;
      case 0x13:
        analysis.details = this.parseStatus(buffer);
        break;
      case 0x94:
        analysis.details = this.parseOBD2(buffer);
        break;
      case 0x80:
        analysis.details = 'Query Command (server asking device for data)';
        break;
      case 0x01:
        analysis.details = this.parseLogin(buffer);
        break;
      default:
        analysis.details = this.parseRawData(buffer);
    }

    return analysis;
  }

  parseLogin(buffer) {
    try {
      const imeiBytes = buffer.slice(4, 12);
      const imei = this.bcdToString(imeiBytes);
      const deviceType = buffer.readUInt8(12);
      const timezone = buffer.readInt8(13);

      return {
        type: 'LOGIN',
        imei: imei,
        deviceType: `0x${deviceType.toString(16)}`,
        timezone: timezone,
        info: `Dispositivo ${imei} conectando com timezone ${timezone}`
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  parseLocation(buffer) {
    try {
      if (buffer.length < 25) {
        return { error: 'Packet too short for location data', length: buffer.length };
      }

      const offset = 4;
      const year = 2000 + buffer.readUInt8(offset);
      const month = buffer.readUInt8(offset + 1);
      const day = buffer.readUInt8(offset + 2);
      const hour = buffer.readUInt8(offset + 3);
      const minute = buffer.readUInt8(offset + 4);
      const second = buffer.readUInt8(offset + 5);

      const timestamp = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;

      const latRaw = buffer.readUInt32BE(offset + 6);
      const latNS = (latRaw & 0x80000000) >> 31;
      const latitude = ((latRaw & 0x7FFFFFFF) / 1800000).toFixed(6);

      const lonRaw = buffer.readUInt32BE(offset + 10);
      const lonEW = (lonRaw & 0x80000000) >> 31;
      const longitude = ((lonRaw & 0x7FFFFFFF) / 1800000).toFixed(6);

      const speed = buffer.readUInt8(offset + 14);
      const direction = buffer.readUInt16BE(offset + 15) & 0x03FF;

      return {
        type: 'LOCATION',
        timestamp,
        latitude: `${latitude}° ${latNS ? 'S' : 'N'}`,
        longitude: `${longitude}° ${lonEW ? 'W' : 'E'}`,
        speed: `${speed} km/h`,
        direction: `${direction}°`,
        satellites: buffer.length > 24 ? buffer.readUInt8(offset + 17) : 'N/A'
      };
    } catch (e) {
      return { error: e.message, hint: 'Possível dados de localização incompletos' };
    }
  }

  parseStatus(buffer) {
    try {
      const offset = 4;
      const batteryVoltage = (buffer.readUInt16BE(offset) / 100).toFixed(2);
      const workingStatus = buffer.readUInt8(offset + 2);

      const statusBits = {
        'GPS': (workingStatus & 0x01) ? 'ON' : 'OFF',
        'GPRS': (workingStatus & 0x02) ? 'ON' : 'OFF',
        'Alarm': (workingStatus & 0x04) ? 'YES' : 'NO'
      };

      return {
        type: 'STATUS',
        batteryVoltage: `${batteryVoltage}V`,
        workingStatus,
        statusBits
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  parseOBD2(buffer) {
    try {
      const offset = 4;

      return {
        type: 'OBD2_DATA',
        rpm: buffer.readUInt16BE(offset),
        speed: buffer.readUInt8(offset + 2),
        temperature: buffer.readUInt8(offset + 3) - 40,
        fuel: buffer.readUInt8(offset + 4),
        odometer: (buffer.readUInt32BE(offset + 5) / 10).toFixed(1),
        engineHours: (buffer.readUInt32BE(offset + 9) / 3600).toFixed(1),
        batteryPercent: buffer.readUInt8(offset + 13),
        batteryVoltage: (buffer.readUInt16BE(offset + 14) / 100).toFixed(2),
        ignition: (buffer.readUInt8(offset + 16) & 0x01) ? 'ON' : 'OFF'
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  parseRawData(buffer) {
    const preview = buffer.slice(4, Math.min(buffer.length, 20));
    return {
      dataPreview: preview.toString('hex').toUpperCase(),
      totalLength: buffer.length
    };
  }

  bcdToString(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i];
      const high = (byte >> 4) & 0x0F;
      const low = byte & 0x0F;
      result += high.toString() + low.toString();
    }
    return result;
  }

  recordPacket(analysis) {
    this.packets.push({
      timestamp: new Date(),
      ...analysis
    });

    // Log estruturado
    const logEntry = JSON.stringify(analysis, null, 2);
    this.log('═'.repeat(80));
    this.log(logEntry);
    this.log('═'.repeat(80));
  }

  getStats() {
    const stats = {
      totalPackets: this.packets.length,
      byProtocol: {},
      byDirection: { RX: 0, TX: 0 }
    };

    this.packets.forEach(p => {
      if (p.protocol) {
        stats.byProtocol[p.protocol.name] = (stats.byProtocol[p.protocol.name] || 0) + 1;
      }
      stats.byDirection[p.direction] = (stats.byDirection[p.direction] || 0) + 1;
    });

    return stats;
  }
}

// Inicializar analisador
const analyzer = new PacketAnalyzer();

analyzer.log('🔍 ADVANCED PACKET ANALYZER INICIADO');
analyzer.log(`📝 Log: ${logFile}`);
analyzer.log('═'.repeat(80));

// Criar servidor TCP para monitorar
const monitorServer = net.createServer((socket) => {
  const connectionId = `${socket.remoteAddress}:${socket.remotePort}`;
  analyzer.log(`✅ CONEXÃO ESTABELECIDA: ${connectionId}`);

  socket.on('data', (data) => {
    analyzer.log(`\n📥 PACOTE RECEBIDO de ${connectionId} (${data.length} bytes)`);
    const analysis = analyzer.analyzePacket(data, 'RX');
    analyzer.recordPacket(analysis);
  });

  socket.on('end', () => {
    analyzer.log(`❌ CONEXÃO ENCERRADA: ${connectionId}`);
  });

  socket.on('error', (error) => {
    analyzer.log(`⚠️ ERRO NA CONEXÃO ${connectionId}: ${error.message}`);
  });
});

const TCP_PORT = 9999;
monitorServer.listen(TCP_PORT, '0.0.0.0', () => {
  analyzer.log(`\n🚀 SERVIDOR DE MONITORAMENTO ESCUTANDO NA PORTA ${TCP_PORT}`);
  analyzer.log('Conecte o rastreador a este servidor para análise completa');
  analyzer.log('\nPara usar com o rastreador existente, configure:');
  analyzer.log(`  SERVER,1,localhost,${TCP_PORT},0#`);
  analyzer.log('\n' + '═'.repeat(80));
});

// Mostrar estatísticas a cada 30 segundos
setInterval(() => {
  const stats = analyzer.getStats();
  analyzer.log(`\n📊 ESTATÍSTICAS ATUAIS:`);
  analyzer.log(JSON.stringify(stats, null, 2));
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  analyzer.log('\n\n🛑 ENCERRANDO ANALYZER');
  analyzer.log(`Total de pacotes capturados: ${analyzer.packets.length}`);
  process.exit(0);
});
