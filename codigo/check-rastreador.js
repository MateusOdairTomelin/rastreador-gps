const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const imei = '356354871416435';

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    include: {
      veiculo: true
    }
  });

  if (!dispositivo) {
    console.log('❌ Dispositivo não encontrado com IMEI:', imei);

    // Listar todos os dispositivos para verificar
    const todos = await prisma.dispositivo.findMany({
      select: { imei: true, nome: true, status: true }
    });
    console.log('\n📋 Dispositivos cadastrados:');
    todos.forEach(d => console.log(`  - ${d.imei} | ${d.nome} | ${d.status}`));

    await prisma.$disconnect();
    return;
  }

  console.log('═'.repeat(60));
  console.log('DIAGNÓSTICO DO RASTREADOR');
  console.log('═'.repeat(60));

  console.log('\n📱 DISPOSITIVO:');
  console.log(`  IMEI: ${dispositivo.imei}`);
  console.log(`  Nome: ${dispositivo.nome || 'N/A'}`);
  console.log(`  Status atual: ${dispositivo.status}`);
  console.log(`  Última conexão: ${dispositivo.ultima_conexao || 'Nunca'}`);
  console.log(`  Criado em: ${dispositivo.created_at}`);

  if (dispositivo.veiculo) {
    console.log('\n🚗 VEÍCULO:');
    console.log(`  Placa: ${dispositivo.veiculo.placa || 'N/A'}`);
    console.log(`  Modelo: ${dispositivo.veiculo.modelo || 'N/A'}`);
    console.log(`  Ano: ${dispositivo.veiculo.ano || 'N/A'}`);
  }

  // Última localização
  const ultimaLoc = await prisma.localizacao.findFirst({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' }
  });

  console.log('\n📍 ÚLTIMA LOCALIZAÇÃO:');
  if (ultimaLoc) {
    console.log(`  Timestamp: ${ultimaLoc.timestamp}`);
    console.log(`  Latitude: ${ultimaLoc.latitude}`);
    console.log(`  Longitude: ${ultimaLoc.longitude}`);
    console.log(`  Velocidade: ${ultimaLoc.velocidade || 0} km/h`);
    console.log(`  Ignição: ${ultimaLoc.ignicao === true ? '✅ LIGADA' : ultimaLoc.ignicao === false ? '❌ DESLIGADA' : '⚠️ INDEFINIDA'}`);
    console.log(`  Direção: ${ultimaLoc.direcao || 0}°`);

    // Calcular tempo offline
    const agora = new Date();
    const ultimoTimestamp = new Date(ultimaLoc.timestamp);
    const diffMinutos = Math.round((agora - ultimoTimestamp) / 1000 / 60);
    console.log(`  Tempo desde última posição: ${diffMinutos} minutos`);

    if (diffMinutos > 5) {
      console.log(`  ⚠️ OFFLINE há mais de 5 minutos!`);
    }
  } else {
    console.log('  ❌ Nenhuma localização registrada');
  }

  // Últimos 10 registros de localização
  const ultimas10 = await prisma.localizacao.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' },
    take: 10
  });

  console.log('\n📊 ÚLTIMAS 10 LOCALIZAÇÕES:');
  if (ultimas10.length > 0) {
    ultimas10.forEach((loc, i) => {
      const ignicaoStr = loc.ignicao === true ? 'ON' : loc.ignicao === false ? 'OFF' : '??';
      console.log(`  ${i+1}. ${loc.timestamp} | Vel: ${String(loc.velocidade || 0).padStart(3)} km/h | Ign: ${ignicaoStr}`);
    });
  } else {
    console.log('  Nenhum registro');
  }

  // Últimos alarmes
  const alarmes = await prisma.alarme.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' },
    take: 10
  });

  console.log('\n🚨 ÚLTIMOS 10 ALARMES:');
  if (alarmes.length > 0) {
    alarmes.forEach((a, i) => {
      console.log(`  ${i+1}. ${a.timestamp} | Tipo: ${a.tipo} | Status: ${a.status}`);
    });
  } else {
    console.log('  Nenhum alarme registrado');
  }

  // Verificar dados OBD2
  const obd2 = await prisma.dadosOBD2.findFirst({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' }
  });

  console.log('\n🔧 ÚLTIMO DADO OBD2:');
  if (obd2) {
    console.log(`  Timestamp: ${obd2.timestamp}`);
    console.log(`  Ignição: ${obd2.ignicao === true ? '✅ LIGADA' : obd2.ignicao === false ? '❌ DESLIGADA' : '⚠️ INDEFINIDA'}`);
    if (obd2.tensao_bateria) console.log(`  Tensão bateria: ${obd2.tensao_bateria}V`);
    if (obd2.percentual_bateria) console.log(`  % Bateria: ${obd2.percentual_bateria}%`);
    if (obd2.rpm !== null) console.log(`  RPM: ${obd2.rpm}`);
    if (obd2.temperatura_motor !== null) console.log(`  Temp. motor: ${obd2.temperatura_motor}°C`);
  } else {
    console.log('  Nenhum dado OBD2 registrado');
  }

  // DIAGNÓSTICO DO PROBLEMA
  console.log('\n' + '═'.repeat(60));
  console.log('ANÁLISE DO PROBLEMA');
  console.log('═'.repeat(60));

  const agora = new Date();

  // Verificar se está realmente offline
  if (ultimaLoc) {
    const ultimoTimestamp = new Date(ultimaLoc.timestamp);
    const diffMinutos = Math.round((agora - ultimoTimestamp) / 1000 / 60);

    if (diffMinutos > 5 && dispositivo.status === 'online') {
      console.log('\n⚠️ PROBLEMA DETECTADO:');
      console.log(`  - Status no banco: "${dispositivo.status}"`);
      console.log(`  - Última comunicação: há ${diffMinutos} minutos`);
      console.log(`  - Deveria estar: "offline"`);
      console.log('\n📝 CAUSA PROVÁVEL:');
      console.log('  O serviço de heartbeat não está atualizando o status');
      console.log('  ou o timeout de offline está configurado muito alto.');
    }

    // Verificar ignição
    if (ultimaLoc.velocidade === 0 || ultimaLoc.velocidade === null) {
      if (ultimaLoc.ignicao === true) {
        console.log('\n⚠️ POSSÍVEL INCONSISTÊNCIA:');
        console.log('  - Velocidade: 0 km/h');
        console.log('  - Ignição marcada: LIGADA');
        console.log('  - Se o veículo está parado há muito tempo, a ignição deveria estar OFF');
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('Erro:', e);
  process.exit(1);
});
