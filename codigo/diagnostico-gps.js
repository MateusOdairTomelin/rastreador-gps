#!/usr/bin/env node

/**
 * Script de diagnóstico para XT40 - Testa comunicação GPS e OBD2
 *
 * Uso:
 *   node diagnostico-gps.js [IMEI]
 *
 * Exemplo:
 *   node diagnostico-gps.js 352753091234567
 */

const net = require('net');
const readline = require('readline');

// Cores para output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[✓]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[✗]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[!]${colors.reset} ${msg}`),
  raw: (title, hex) => console.log(`${colors.cyan}[${title}]${colors.reset}\n${hex}\n`),
};

// Comandos X3Tech XT40
const commands = {
  GPS_ON: '#55555#YGPS#1#',
  GPS_OFF: '#55555#YGPS#0#',
  OBD_ON: '#55555#YOBD#1#',
  OBD_OFF: '#55555#YOBD#0#',
  UPLOAD_10S: '#55555#YUP#10#',
  UPLOAD_30S: '#55555#YUP#30#',
  UPLOAD_60S: '#55555#YUP#60#',
  DIAG_ON: '#55555#YDIAG#1#',
  DIAG_OFF: '#55555#YDIAG#0#',
  ONLINE_ON: '#55555#YONLINE#1#',
  CONNECT_ON: '#55555#YCONNECT#1#',
  STATUS: '#55555#YSTATUS#',
  VERSION: '#55555#YVERSION#',
  NETWORK: '#55555#YNETWORK#',
};

class GPSConnector {
  constructor(host, port, timeout = 30000) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.socket = null;
    this.data = Buffer.alloc(0);
    this.responses = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.port, this.host);

      this.socket.on('connect', () => {
        log.success(`Conectado em ${this.host}:${this.port}`);
        resolve();
      });

      this.socket.on('error', (err) => {
        log.error(`Erro de conexão: ${err.message}`);
        reject(err);
      });

      this.socket.on('data', (chunk) => {
        log.info(`Dados recebidos: ${chunk.length} bytes`);
        log.raw('RESPOSTA', chunk.toString('hex').toUpperCase());
        this.data = Buffer.concat([this.data, chunk]);
        this.responses.push({
          data: chunk,
          hex: chunk.toString('hex').toUpperCase(),
          timestamp: new Date().toISOString(),
        });
      });

      this.socket.on('end', () => {
        log.info('Conexão encerrada pelo servidor');
      });

      this.socket.on('close', () => {
        log.info('Socket fechado');
      });

      setTimeout(() => {
        reject(new Error('Timeout de conexão'));
      }, this.timeout);
    });
  }

  sendCommand(cmd, description) {
    return new Promise((resolve) => {
      if (!this.socket || this.socket.destroyed) {
        log.error(`Socket não está conectado`);
        resolve(false);
        return;
      }

      try {
        const buffer = Buffer.from(cmd + '\r\n', 'ascii');
        this.socket.write(buffer);
        log.success(`Comando enviado: ${description}`);
        log.raw('COMANDO', cmd);

        // Aguardar um pouco por resposta
        setTimeout(() => {
          if (this.responses.length > 0) {
            log.success(`Resposta recebida para: ${description}`);
          } else {
            log.warn(`Nenhuma resposta para: ${description}`);
          }
          resolve(true);
        }, 1000);
      } catch (error) {
        log.error(`Erro ao enviar comando: ${error.message}`);
        resolve(false);
      }
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  printSummary() {
    console.log(`\n${colors.bright}═══════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}RESUMO DA COMUNICAÇÃO${colors.reset}`);
    console.log(`${colors.bright}═══════════════════════════════════${colors.reset}`);
    console.log(`Total de respostas: ${this.responses.length}`);
    console.log(`\nRespostas recebidas:`);
    this.responses.forEach((resp, i) => {
      console.log(`  ${i + 1}. ${resp.timestamp} - ${resp.hex.substring(0, 40)}...`);
    });
    console.log();
  }
}

async function main() {
  const imei = process.argv[2];
  const host = process.argv[3] || 'localhost';
  const port = parseInt(process.argv[4] || '8877', 10);

  console.log(`${colors.bright}${'═'.repeat(50)}${colors.reset}`);
  console.log(`${colors.bright}DIAGNÓSTICO GPS - XT40${colors.reset}`);
  console.log(`${colors.bright}${'═'.repeat(50)}${colors.reset}\n`);

  log.info(`Host: ${host}:${port}`);
  log.info(`IMEI: ${imei || 'Será detectado automaticamente'}`);
  log.info(`Timeout: 30 segundos\n`);

  const connector = new GPSConnector(host, port);

  try {
    await connector.connect();

    // Aguardar um pouco para ver se há dados iniciais
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Menu interativo
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const showMenu = () => {
      console.log(`\n${colors.bright}Comandos disponíveis:${colors.reset}`);
      console.log('  1 - GPS_ON (Ativar GPS)');
      console.log('  2 - OBD_ON (Ativar OBD2)');
      console.log('  3 - UPLOAD_10S (Upload a cada 10s)');
      console.log('  4 - STATUS (Ver status)');
      console.log('  5 - DIAG_ON (Ativar diagnóstico)');
      console.log('  6 - VERSION (Ver versão)');
      console.log('  0 - Sair');
      console.log();
    };

    const sendNext = async () => {
      return new Promise((resolve) => {
        showMenu();
        rl.question(`${colors.cyan}Escolha uma opção: ${colors.reset}`, async (choice) => {
          const commandMap = {
            '1': ['GPS_ON', 'Ativar GPS'],
            '2': ['OBD_ON', 'Ativar OBD2'],
            '3': ['UPLOAD_10S', 'Intervalo 10s'],
            '4': ['STATUS', 'Ver status'],
            '5': ['DIAG_ON', 'Ativar diagnóstico'],
            '6': ['VERSION', 'Ver versão'],
          };

          if (choice === '0') {
            log.info('Encerrando...');
            rl.close();
            connector.close();
            connector.printSummary();
            resolve(false);
            return;
          }

          if (commandMap[choice]) {
            const [cmd, desc] = commandMap[choice];
            await connector.sendCommand(commands[cmd], desc);
          } else {
            log.error('Opção inválida');
          }

          resolve(true);
        });
      });
    };

    let continuar = true;
    while (continuar) {
      continuar = await sendNext();
    }
  } catch (error) {
    log.error(error.message);
    process.exit(1);
  }
}

main();
