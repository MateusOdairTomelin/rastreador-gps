#!/usr/bin/env node

/**
 * Capturador de pacotes TCP brutos
 * Mostra TODOS os bytes que chegam no servidor
 */

const net = require('net');

const TCP_PORT = process.env.TCP_PORT || 8877;

const server = net.createServer((socket) => {
  console.log(`\n[CAPTURE] Cliente conectado: ${socket.remoteAddress}:${socket.remotePort}`);

  let packetCount = 0;

  socket.on('data', (data) => {
    packetCount++;
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];

    console.log(`\n[${timestamp}] Pacote #${packetCount}`);
    console.log(`Tamanho: ${data.length} bytes`);
    console.log(`Hex:     ${data.toString('hex').toUpperCase()}`);
    console.log(`ASCII:   ${data.toString('ascii').replace(/[\x00-\x1f\x7f-\xff]/g, '.')}`);

    // Analisar tipo de protocolo
    if (data.length >= 4) {
      const startBit = data.readUInt16BE(0);
      const packetLength = data.readUInt8(2);
      const protocolNumber = data.readUInt8(3);

      console.log(`Análise:`);
      console.log(`  - Start bit: 0x${startBit.toString(16).toUpperCase()}`);
      console.log(`  - Packet length: ${packetLength}`);
      console.log(`  - Protocol number: 0x${protocolNumber.toString(16).toUpperCase()} (${getProtocolName(protocolNumber)})`);
    }
  });

  socket.on('end', () => {
    console.log(`\n[CAPTURE] Cliente desconectado: ${socket.remoteAddress}`);
  });

  socket.on('error', (err) => {
    console.error(`\n[CAPTURE] Erro: ${err.message}`);
  });
});

function getProtocolName(num) {
  const protocols = {
    0x01: 'LOGIN/HEARTBEAT',
    0x12: 'LOCATION',
    0x13: 'STATUS',
    0x16: 'ALARM',
    0x94: 'OBD2',
  };
  return protocols[num] || 'UNKNOWN';
}

server.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('📡 Capturador de Pacotes TCP Ativo');
  console.log(`${'='.repeat(60)}`);
  console.log(`\nEscutando em: 0.0.0.0:${TCP_PORT}`);
  console.log(`\nAguardando conexões do rastreador...`);
  console.log(`Todos os pacotes serão analisados e exibidos aqui.\n`);
});

process.on('SIGINT', () => {
  console.log('\n\n🛑 Finalizando capturador...');
  server.close();
  process.exit(0);
});
