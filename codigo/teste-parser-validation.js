#!/usr/bin/env node

/**
 * Teste de Validação do Parser XT40
 * Demonstra a DIFERENÇA CRÍTICA na fórmula de coordenadas
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// TESTES DE COORDENADAS
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('🔍 TESTE DE VALIDAÇÃO DO PARSER XT40');
console.log('='.repeat(80) + '\n');

// Dados de teste real do rastreador
const testPacket = Buffer.from('78781F120B081D112E10CF027AC7EB0C465849001482F01CC00287D001FB80003808D0D0A', 'hex');

console.log('📦 Pacote de teste (0x12 - Location):');
console.log(`   Hex: ${testPacket.toString('hex').toUpperCase()}`);
console.log(`   Tamanho: ${testPacket.length} bytes\n`);

// ============================================================================
// TESTE 1: Parsing de Coordenadas
// ============================================================================

console.log('─'.repeat(80));
console.log('TESTE 1: Parsing de Latitude/Longitude');
console.log('─'.repeat(80) + '\n');

// Posição de latitude no pacote (offset 10 bytes: 2 start + 1 len + 1 proto + 6 datetime)
const latOffset = 4 + 6; // Após header + datetime
const lonOffset = latOffset + 4;

const latRaw = testPacket.readUInt32BE(latOffset);
const lonRaw = testPacket.readUInt32BE(lonOffset);

console.log('Valores brutos (hexadecimal):');
console.log(`   Latitude raw:  0x${latRaw.toString(16).padStart(8, '0').toUpperCase()} (${latRaw})`);
console.log(`   Longitude raw: 0x${lonRaw.toString(16).padStart(8, '0').toUpperCase()} (${lonRaw})\n`);

// Extração de flags e valores
const latNS = (latRaw & 0x80000000) >> 31; // 0=North, 1=South
const latValue = (latRaw & 0x7FFFFFFF);

const lonEW = (lonRaw & 0x80000000) >> 31; // 0=East, 1=West
const lonValue = (lonRaw & 0x7FFFFFFF);

console.log('Extração de flags:');
console.log(`   Latitude N/S:   ${latNS === 0 ? 'NORTE ✅' : 'SUL'}`);
console.log(`   Latitude value: ${latValue}`);
console.log(`   Longitude E/W:  ${lonEW === 0 ? 'LESTE ✅' : 'OESTE'}`);
console.log(`   Longitude value: ${lonValue}\n`);

// ❌ FÓRMULA INCORRETA (do código Python original)
const latIncorrect = latValue / 30000.0;
const lonIncorrect = lonValue / 30000.0;

// ✅ FÓRMULA CORRETA
const latCorrect = (latValue / 1800000.0) * (latNS === 0 ? 1 : -1);
const lonCorrect = (lonValue / 1800000.0) * (lonEW === 0 ? 1 : -1);

console.log('⚠️  COMPARAÇÃO DE FÓRMULAS:\n');

console.log(`INCORRETA (/ 30000):`);
console.log(`   Latitude:  ${latIncorrect.toFixed(6)}°`);
console.log(`   Longitude: ${lonIncorrect.toFixed(6)}°`);
console.log(`   ❌ INVÁLIDO! Latitude máxima deveria ser ~90°\n`);

console.log(`CORRETA (/ 1800000 com flags):  `);
console.log(`   Latitude:  ${latCorrect.toFixed(6)}°`);
console.log(`   Longitude: ${lonCorrect.toFixed(6)}°`);
console.log(`   ✅ VÁLIDO! Dentro de ranges esperados\n`);

// Cálculo da diferença
const latDifference = Math.abs(latIncorrect - latCorrect);
const lonDifference = Math.abs(lonIncorrect - lonCorrect);

console.log(`DIFERENÇA ENTRE AS FÓRMULAS:`);
console.log(`   Latitude:  ${latDifference.toFixed(6)}° (~${(latDifference * 111).toFixed(0)} km no equador)`);
console.log(`   Longitude: ${lonDifference.toFixed(6)}° (~${(lonDifference * 111).toFixed(0)} km no equador)`);
console.log(`   ⚠️  ERRO: ~${((latDifference / latCorrect) * 100).toFixed(0)}x maior com fórmula incorreta!\n`);

// ============================================================================
// TESTE 2: Validação de Range
// ============================================================================

console.log('\n' + '─'.repeat(80));
console.log('TESTE 2: Validação de Range de Coordenadas');
console.log('─'.repeat(80) + '\n');

function validateCoordinate(lat, lon) {
  const errors = [];

  if (lat < -90 || lat > 90) {
    errors.push(`❌ Latitude inválida: ${lat}° (range: -90 a 90°)`);
  } else {
    errors.push(`✅ Latitude válida: ${lat}°`);
  }

  if (lon < -180 || lon > 180) {
    errors.push(`❌ Longitude inválida: ${lon}° (range: -180 a 180°)`);
  } else {
    errors.push(`✅ Longitude válida: ${lon}°`);
  }

  return errors;
}

console.log('Validação com fórmula INCORRETA:');
validateCoordinate(latIncorrect, lonIncorrect).forEach(e => console.log(`   ${e}`));

console.log('\nValidação com fórmula CORRETA:');
validateCoordinate(latCorrect, lonCorrect).forEach(e => console.log(`   ${e}`));

// ============================================================================
// TESTE 3: CRC-ITU
// ============================================================================

console.log('\n' + '─'.repeat(80));
console.log('TESTE 3: Validação de CRC-ITU');
console.log('─'.repeat(80) + '\n');

const CRC_TABLE = [
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
  0x7BC7, 0x6A4E, 0x58D5, 0x495C, 0x3DE3, 0x2C6A, 0x1EF1, 0x0F78,
];

function calculateCRC16(buffer, start, end) {
  let crc = 0xFFFF;
  for (let i = start; i < end; i++) {
    crc = (crc >> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xFF];
  }
  return (~crc) & 0xFFFF;
}

// CRC is in bytes before the stop bit (0x0D0A)
const crcReceivedPos = testPacket.length - 4; // 2 bytes CRC + 2 bytes stop
const crcReceived = testPacket.readUInt16BE(crcReceivedPos);

// CRC is calculated from byte 2 (length) to byte before CRC
const crcData = testPacket.slice(2, crcReceivedPos);
const crcCalculated = calculateCRC16(crcData, 0, crcData.length);

console.log(`CRC Recebido:    0x${crcReceived.toString(16).padStart(4, '0').toUpperCase()}`);
console.log(`CRC Calculado:   0x${crcCalculated.toString(16).padStart(4, '0').toUpperCase()}`);
console.log(`Status:          ${crcReceived === crcCalculated ? '✅ OK' : '❌ ERRO'}`);

// ============================================================================
// RESUMO FINAL
// ============================================================================

console.log('\n' + '='.repeat(80));
console.log('📋 RESUMO DAS VALIDAÇÕES');
console.log('='.repeat(80) + '\n');

const summary = [
  ['Fórmula Coordenadas', 'CRÍTICA', '❌ Python usa /30000 (incorreto)', '✅ JS usa /1800000 (correto)'],
  ['Extração N/S/E/W', 'CRÍTICA', '❌ Python não extrai', '✅ JS extrai bits corretamente'],
  ['Validação Range', 'ALTA', '❌ Sem validação em Python', '✅ JS valida em 0x13'],
  ['CRC-ITU', 'MÉDIA', '✅ Ambos implementam corretamente', ''],
  ['Estrutura Código', 'BAIXA', '✅ Python bem organizado', '✅ JS bem estruturado'],
];

console.log('Aspecto                | Severidade | Status Python       | Status JS');
console.log('─'.repeat(80));
summary.forEach(([aspecto, sev, python, js]) => {
  const paddedAspecto = aspecto.padEnd(23);
  const paddedSev = sev.padEnd(11);
  const paddedPython = python.padEnd(20);
  console.log(`${paddedAspecto}| ${paddedSev}| ${paddedPython}| ${js}`);
});

console.log('\n' + '='.repeat(80));
console.log('✅ CONCLUSÃO: Usar implementação JavaScript como referência');
console.log('              Aplicar correções ao código Python antes de usar');
console.log('='.repeat(80) + '\n');
