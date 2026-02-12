#!/usr/bin/env node

/**
 * Configure X3Tech XT40 Tracker with Server Details
 * Suporta comunicação via Serial Port ou TCP/IP
 */

const net = require('net');
const SerialPort = require('serialport');

// ===== CONFIGURAÇÕES =====
const config = {
  SERVER_HOST: '6754056cd710.sn.mynetname.net',
  SERVER_PORT: 8877,
  PROTOCOL_ID: 1,
  RESERVE: 0,
};

// Comando para o rastreador (formato X3Tech XT40)
// SERVER,<protocol_id>,<server_host>,<server_port>,<reserve>#
const buildCommand = () => {
  return `SERVER,${config.PROTOCOL_ID},${config.SERVER_HOST},${config.SERVER_PORT},${config.RESERVE}#`;
};

// ===== OPÇÃO 1: COMUNICAÇÃO VIA SERIAL PORT =====
async function configureViaSerial(portName = '/dev/ttyUSB0', baudRate = 9600) {
  console.log('\n📡 Conectando ao rastreador via porta serial...');
  console.log(`   Porta: ${portName}`);
  console.log(`   Baud Rate: ${baudRate}\n`);

  return new Promise((resolve, reject) => {
    const port = new SerialPort(portName, { baudRate });

    port.on('open', () => {
      console.log('✅ Porta serial aberta com sucesso!');

      const command = buildCommand();
      console.log(`📤 Enviando comando:\n   ${command}\n`);

      port.write(command + '\r\n', (err) => {
        if (err) {
          console.error('❌ Erro ao enviar comando:', err.message);
          reject(err);
          return;
        }

        console.log('✅ Comando enviado!');

        // Aguardar resposta por 2 segundos
        let response = '';
        const timeout = setTimeout(() => {
          port.close();
          console.log('\n📨 Resposta do rastreador:');
          console.log(response || '(Nenhuma resposta recebida)');
          resolve(response);
        }, 2000);

        port.on('data', (data) => {
          response += data.toString();
          console.log('📥 Dados recebidos:', data.toString());
        });

        port.on('error', (err) => {
          clearTimeout(timeout);
          console.error('❌ Erro na porta serial:', err.message);
          reject(err);
        });
      });
    });

    port.on('error', (err) => {
      console.error('❌ Erro ao abrir porta serial:', err.message);
      reject(err);
    });
  });
}

// ===== OPÇÃO 2: COMUNICAÇÃO VIA TCP/IP =====
async function configureViaTCP(trackerHost, trackerPort = 5000) {
  console.log('\n📡 Conectando ao rastreador via TCP/IP...');
  console.log(`   Host: ${trackerHost}`);
  console.log(`   Porta: ${trackerPort}\n`);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(
      { host: trackerHost, port: trackerPort },
      () => {
        console.log('✅ Conectado ao rastreador via TCP!');

        const command = buildCommand();
        console.log(`📤 Enviando comando:\n   ${command}\n`);

        socket.write(command + '\r\n', (err) => {
          if (err) {
            console.error('❌ Erro ao enviar comando:', err.message);
            reject(err);
            return;
          }

          console.log('✅ Comando enviado!');
        });

        // Aguardar resposta por 3 segundos
        let response = '';
        const timeout = setTimeout(() => {
          socket.destroy();
          console.log('\n📨 Resposta do rastreador:');
          console.log(response || '(Nenhuma resposta recebida)');
          resolve(response);
        }, 3000);

        socket.on('data', (data) => {
          response += data.toString();
          console.log('📥 Dados recebidos:', data.toString());
        });

        socket.on('error', (err) => {
          clearTimeout(timeout);
          console.error('❌ Erro na conexão TCP:', err.message);
          reject(err);
        });
      }
    );

    socket.on('error', (err) => {
      console.error('❌ Erro ao conectar ao rastreador:', err.message);
      reject(err);
    });
  });
}

// ===== INTERFACE CLI =====
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🚗 Configurador X3Tech XT40');
  console.log('='.repeat(60));
  console.log(`\n⚙️  Configuração a enviar:`);
  console.log(`   Server: ${config.SERVER_HOST}`);
  console.log(`   Port: ${config.SERVER_PORT}`);
  console.log(`   Protocol ID: ${config.PROTOCOL_ID}`);
  console.log(`   Comando: ${buildCommand()}`);

  const args = process.argv.slice(2);
  const method = args[0] || 'help';

  try {
    if (method === 'serial') {
      const port = args[1] || '/dev/ttyUSB0';
      const baud = parseInt(args[2]) || 9600;
      await configureViaSerial(port, baud);

    } else if (method === 'tcp') {
      const host = args[1] || 'localhost';
      const port = parseInt(args[2]) || 5000;
      await configureViaTCP(host, port);

    } else {
      console.log('\n📖 USO:\n');
      console.log('Via Serial Port:');
      console.log('  node configure-tracker.js serial [porta] [baud_rate]');
      console.log('  Exemplos:');
      console.log('    node configure-tracker.js serial /dev/ttyUSB0 9600');
      console.log('    node configure-tracker.js serial COM3 115200');
      console.log('\nVia TCP/IP:');
      console.log('  node configure-tracker.js tcp [host] [port]');
      console.log('  Exemplos:');
      console.log('    node configure-tracker.js tcp 192.168.1.100 5000');
      console.log('    node configure-tracker.js tcp 10.0.0.50 8888');
      console.log('\n');
    }
  } catch (error) {
    console.error('\n❌ Erro fatal:', error.message);
    process.exit(1);
  }
}

main();
