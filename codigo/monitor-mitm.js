#!/usr/bin/env node

const net = require('net');
const fs = require('fs');

/**
 * MAN-IN-THE-MIDDLE MONITOR
 * Intercepta o tráfego entre rastreador e servidor
 * Sem modificar dados, apenas log e análise
 */

const logFile = '/tmp/mitm-monitor.log';
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const TRACKER_PORT = 8877;
const PROXY_PORT = 8878;
const BACKEND_HOST = 'localhost';
const BACKEND_PORT = 8877;

class MITMMonitor {
  constructor() {
    this.connections = new Map();
    this.packetCount = 0;
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    logStream.write(logMessage + '\n');
  }

  analyzePacket(buffer) {
    const hex = buffer.toString('hex').toUpperCase();
    const length = buffer.length;

    if (hex.startsWith('7878') || hex.startsWith('7979')) {
      const protocolNum = buffer.readUInt8(3);
      const protocols = {
        0x01: 'LOGIN', 0x12: 'LOCATION', 0x94: 'OBD2',
        0x13: 'STATUS', 0x16: 'ALARM', 0x80: 'QUERY'
      };
      return `[${protocols[protocolNum] || `0x${protocolNum.toString(16)}`}] ${length}B`;
    }
    return `[UNKNOWN] ${length}B`;
  }
}

const monitor = new MITMMonitor();

monitor.log('═'.repeat(100));
monitor.log('🔍 MAN-IN-THE-MIDDLE MONITOR INICIADO');
monitor.log(`📊 Proxy: localhost:${PROXY_PORT}`);
monitor.log(`➜ Backend: ${BACKEND_HOST}:${BACKEND_PORT}`);
monitor.log(`📝 Log: ${logFile}`);
monitor.log('═'.repeat(100));

// Criar servidor proxy
const proxyServer = net.createServer((trackerSocket) => {
  const connectionId = `${trackerSocket.remoteAddress}:${trackerSocket.remotePort}`;
  const connectionKey = Date.now() + Math.random();

  monitor.log(`\n✅ [${connectionId}] RASTREADOR CONECTADO`);

  // Conectar ao servidor real
  const serverSocket = net.createConnection(BACKEND_PORT, BACKEND_HOST);

  serverSocket.on('connect', () => {
    monitor.log(`✅ [${connectionId}] CONECTADO AO BACKEND`);
  });

  // Rastreador -> Servidor
  trackerSocket.on('data', (data) => {
    const analysis = monitor.analyzePacket(data);
    monitor.log(`📤 TRACKER→SERVER [${connectionId}] ${analysis}`);

    // Log completo em arquivo separado
    if (data.length > 18 && data.toString('hex').includes('12')) {
      monitor.log(`   📍 LOCATION DATA DETECTED! Hex: ${data.toString('hex').substring(0, 100)}...`);
    }

    serverSocket.write(data);
  });

  // Servidor -> Rastreador
  serverSocket.on('data', (data) => {
    const analysis = monitor.analyzePacket(data);
    monitor.log(`📥 SERVER→TRACKER [${connectionId}] ${analysis}`);
    trackerSocket.write(data);
  });

  trackerSocket.on('end', () => {
    monitor.log(`❌ [${connectionId}] RASTREADOR DESCONECTADO`);
    serverSocket.end();
  });

  serverSocket.on('end', () => {
    trackerSocket.end();
  });

  trackerSocket.on('error', (err) => {
    monitor.log(`⚠️ [${connectionId}] ERRO TRACKER: ${err.message}`);
  });

  serverSocket.on('error', (err) => {
    monitor.log(`⚠️ [${connectionId}] ERRO SERVER: ${err.message}`);
  });
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
  monitor.log(`\n🚀 PROXY ESCUTANDO EM localhost:${PROXY_PORT}`);
  monitor.log('\n💡 PARA USAR:');
  monitor.log(`   Redirecione a porta 8877 para 8878 usando iptables ou rconfig do rastreador`);
  monitor.log(`   Ou configure o rastreador para conectar em porta 8878`);
  monitor.log('\n📊 MONITORAR LOG:');
  monitor.log(`   tail -f ${logFile}`);
});

process.on('SIGINT', () => {
  monitor.log('\n\n🛑 ENCERRANDO MITM MONITOR');
  process.exit(0);
});
