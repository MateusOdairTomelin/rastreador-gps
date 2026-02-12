#!/usr/bin/env node

/**
 * Find available serial ports
 */

const { SerialPort } = require('serialport');

async function listPorts() {
  console.log('\n📡 Procurando portas seriais disponíveis...\n');

  try {
    const ports = await SerialPort.list();

    if (ports.length === 0) {
      console.log('❌ Nenhuma porta serial encontrada!');
      console.log('   Verifique se o rastreador está conectado via USB.');
      return;
    }

    console.log(`✅ ${ports.length} porta(s) serial(is) encontrada(s):\n`);

    ports.forEach((port, index) => {
      console.log(`${index + 1}. ${port.path}`);
      if (port.manufacturer) console.log(`   Fabricante: ${port.manufacturer}`);
      if (port.serialNumber) console.log(`   Serial: ${port.serialNumber}`);
      if (port.productId) console.log(`   Product ID: ${port.productId}`);
      console.log('');
    });

    console.log('💡 Dica: Use a porta que aparece quando o rastreador está conectado.');
    console.log('   Normalmente é /dev/ttyUSB0 ou /dev/ttyUSB1 no Linux');
    console.log('   ou COM3, COM4, etc. no Windows\n');

  } catch (error) {
    console.error('❌ Erro ao listar portas:', error.message);
  }
}

listPorts();
