#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const IMEIS = [
  '356354870699551',
  '356354870702322',
  '356354870658615'
];

async function diagnostico() {
  console.log('\n' + '='.repeat(80));
  console.log('DIAGNÓSTICO DE RASTREADORES XT40');
  console.log('='.repeat(80) + '\n');

  for (const imei of IMEIS) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`📱 DISPOSITIVO: ${imei}`);
    console.log('─'.repeat(80));

    // Verificar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      console.log('❌ Dispositivo não encontrado no banco de dados\n');
      continue;
    }

    console.log(`Status: ${dispositivo.status}`);
    console.log(`Última conexão: ${dispositivo.ultima_conexao || 'Nunca'}`);

    // Última localização
    const ultimaLocalizacao = await prisma.localizacao.findFirst({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' }
    });

    console.log(`\n📍 ÚLTIMA LOCALIZAÇÃO:`);
    if (ultimaLocalizacao) {
      console.log(`   Timestamp: ${ultimaLocalizacao.timestamp}`);
      console.log(`   Latitude: ${ultimaLocalizacao.latitude}`);
      console.log(`   Longitude: ${ultimaLocalizacao.longitude}`);
      console.log(`   Velocidade: ${ultimaLocalizacao.velocidade || 0} km/h`);
      console.log(`   Direção: ${ultimaLocalizacao.direcao || 0}°`);
      console.log(`   Precisão: ${ultimaLocalizacao.precisao || 'N/A'}`);
    } else {
      console.log('   ❌ Nenhuma localização recebida');
    }

    // Últimos dados OBD2
    const ultimosOBD2 = await prisma.dadosOBD2.findMany({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' },
      take: 5
    });

    console.log(`\n🔧 DADOS OBD2 (últimos 5 registros):`);
    if (ultimosOBD2.length > 0) {
      console.log(`   Total de registros: ${ultimosOBD2.length}`);

      // Analisar quais campos têm dados
      const campos = {
        rpm: false,
        temperatura_motor: false,
        nivel_combustivel: false,
        odometro_embarcado: false,
        tensao_bateria: false,
        percentual_bateria: false,
        hora_motor_embarcada: false
      };

      ultimosOBD2.forEach(record => {
        if (record.rpm !== null) campos.rpm = true;
        if (record.temperatura_motor !== null) campos.temperatura_motor = true;
        if (record.nivel_combustivel !== null) campos.nivel_combustivel = true;
        if (record.odometro_embarcado !== null) campos.odometro_embarcado = true;
        if (record.tensao_bateria !== null) campos.tensao_bateria = true;
        if (record.percentual_bateria !== null) campos.percentual_bateria = true;
        if (record.hora_motor_embarcada !== null) campos.hora_motor_embarcada = true;
      });

      console.log(`\n   📊 CAMPOS COM DADOS:`);
      console.log(`   ${campos.rpm ? '✅' : '❌'} RPM (Protocolo 0x94)`);
      console.log(`   ${campos.temperatura_motor ? '✅' : '❌'} Temperatura Motor (Protocolo 0x94)`);
      console.log(`   ${campos.nivel_combustivel ? '✅' : '❌'} Nível Combustível (Protocolo 0x94)`);
      console.log(`   ${campos.odometro_embarcado ? '✅' : '❌'} Odômetro Embarcado`);
      console.log(`   ${campos.tensao_bateria ? '✅' : '❌'} Tensão Bateria (Protocolo 0x22)`);
      console.log(`   ${campos.percentual_bateria ? '✅' : '❌'} % Bateria (Protocolo 0x22)`);
      console.log(`   ${campos.hora_motor_embarcada ? '✅' : '❌'} Horímetro (Protocolo 0x22)`);

      // Mostrar último registro completo
      const ultimo = ultimosOBD2[0];
      console.log(`\n   📋 ÚLTIMO REGISTRO (${ultimo.timestamp}):`);
      if (ultimo.rpm !== null) console.log(`      RPM: ${ultimo.rpm}`);
      if (ultimo.temperatura_motor !== null) console.log(`      Temperatura: ${ultimo.temperatura_motor}°C`);
      if (ultimo.nivel_combustivel !== null) console.log(`      Combustível: ${ultimo.nivel_combustivel}%`);
      if (ultimo.odometro_embarcado !== null) console.log(`      Odômetro: ${ultimo.odometro_embarcado} km`);
      if (ultimo.tensao_bateria !== null) console.log(`      Tensão Bateria: ${ultimo.tensao_bateria}V`);
      if (ultimo.percentual_bateria !== null) console.log(`      % Bateria: ${ultimo.percentual_bateria}%`);
      if (ultimo.hora_motor_embarcada !== null) console.log(`      Horímetro: ${ultimo.hora_motor_embarcada.toFixed(2)}h`);
      if (ultimo.ignicao !== null) console.log(`      Ignição: ${ultimo.ignicao ? '✅ LIGADA' : '❌ DESLIGADA'}`);

      // Diagnóstico do protocolo
      console.log(`\n   🔍 DIAGNÓSTICO:`);
      const temOBD2 = campos.rpm || campos.temperatura_motor || campos.nivel_combustivel;
      const tem0x22 = campos.tensao_bateria || campos.percentual_bateria || campos.hora_motor_embarcada;

      if (temOBD2) {
        console.log(`   ✅ Protocolo 0x94 (OBD2) ATIVO - Recebendo dados do veículo`);
      } else {
        console.log(`   ❌ Protocolo 0x94 (OBD2) INATIVO`);
        console.log(`      Possíveis causas:`);
        console.log(`      - Rastreador não é modelo XT40-OBDII`);
        console.log(`      - Cabo OBD2 não conectado ao veículo`);
        console.log(`      - Ignição do veículo desligada`);
        console.log(`      - Veículo não compatível com OBD2`);
      }

      if (tem0x22) {
        console.log(`   ✅ Protocolo 0x22 (Location Frame) ATIVO`);
      } else {
        console.log(`   ❌ Protocolo 0x22 (Location Frame) INATIVO`);
        console.log(`      ⚠️  AÇÃO NECESSÁRIA: Enviar comando SMS "SETLOCX22#"`);
      }

    } else {
      console.log('   ❌ Nenhum dado OBD2 recebido ainda');
      console.log(`   📝 Possíveis causas:`);
      console.log(`      - Rastreador não conectado/configurado`);
      console.log(`      - Aguardando primeiro pacote de dados`);
    }

    console.log('');
  }

  console.log('\n' + '='.repeat(80));
  console.log('RESUMO E RECOMENDAÇÕES');
  console.log('='.repeat(80));
  console.log(`
📌 AÇÕES NECESSÁRIAS:

1. Para ativar Protocolo 0x22 (bateria, odômetro, horímetro):
   → Enviar SMS "SETLOCX22#" para cada rastreador

2. Para ativar dados OBD2 (RPM, temperatura, combustível):
   → Verificar se rastreador é modelo XT40-OBDII
   → Conectar cabo OBD2 à porta do veículo
   → Ligar ignição do veículo
   → Aguardar 30-60 segundos

3. Verificar configuração:
   → Enviar SMS "PARAM#" para ver configuração atual
   → Verificar se retorna "PROTOCOL:SETL"

4. Verificar status:
   → Enviar SMS "STATUS#" para ver status atual
   → Verificar tensões, ACC, GPS

📖 Consulte o guia completo em:
   /home/tomelin/rastreador/scripts/ativar-rastreadores.md
`);
  console.log('='.repeat(80) + '\n');

  await prisma.$disconnect();
}

diagnostico().catch(console.error);
