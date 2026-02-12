const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const imei = '356354871416435';

  // 1. Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    select: {
      id: true,
      imei: true,
      tipo: true,
      placa: true,
      veiculo: true,
      status: true,
      estado_ignicao: true,
      ultima_conexao: true,
      usa_ignicao_virtual: true,
      conexao_pos_chave: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      viagem_inicio: true,
      gps_status: true
    }
  });

  if (!dispositivo) {
    console.log('DISPOSITIVO NÃO ENCONTRADO COM IMEI:', imei);

    // Listar todos para debug
    const todos = await prisma.dispositivo.findMany({
      select: { imei: true, status: true }
    });
    console.log('\nDispositivos cadastrados:');
    todos.forEach(d => console.log('  ', d.imei, '-', d.status));

    await prisma.$disconnect();
    return;
  }

  console.log('='.repeat(60));
  console.log('DIAGNÓSTICO DO RASTREADOR:', imei);
  console.log('='.repeat(60));

  console.log('\n=== DADOS DO DISPOSITIVO ===');
  console.log('IMEI:', dispositivo.imei);
  console.log('Tipo:', dispositivo.tipo);
  console.log('Placa:', dispositivo.placa || 'N/A');
  console.log('Veículo:', dispositivo.veiculo || 'N/A');
  console.log('STATUS:', dispositivo.status);
  console.log('Estado Ignição:', dispositivo.estado_ignicao);
  console.log('Última conexão:', dispositivo.ultima_conexao ? dispositivo.ultima_conexao.toISOString() : 'Nunca');
  console.log('Usa ignição virtual:', dispositivo.usa_ignicao_virtual);
  console.log('Conexão pós-chave:', dispositivo.conexao_pos_chave);
  console.log('Tensão motor ligado:', dispositivo.tensao_motor_ligado + 'V');
  console.log('Tensão motor deslig:', dispositivo.tensao_motor_deslig + 'V');
  console.log('Viagem início:', dispositivo.viagem_inicio ? dispositivo.viagem_inicio.toISOString() : 'Sem viagem');
  console.log('GPS Status:', dispositivo.gps_status || 'N/A');

  // Tempo offline
  if (dispositivo.ultima_conexao) {
    const tempoOffline = (Date.now() - new Date(dispositivo.ultima_conexao).getTime()) / 1000 / 60;
    console.log('\nTEMPO DESDE ÚLTIMA CONEXÃO:', tempoOffline.toFixed(2), 'minutos');
  }

  // 2. Últimas localizações
  const localizacoes = await prisma.localizacao.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      latitude: true,
      longitude: true,
      velocidade: true,
      estado_ignicao: true,
      ignicao: true,
      timestamp: true,
      created_at: true
    }
  });

  console.log('\n=== ÚLTIMAS 10 LOCALIZAÇÕES ===');
  if (localizacoes.length === 0) {
    console.log('NENHUMA LOCALIZAÇÃO REGISTRADA');
  } else {
    localizacoes.forEach((loc, i) => {
      const idade = ((Date.now() - new Date(loc.timestamp).getTime()) / 1000 / 60).toFixed(1);
      console.log(
        (i+1) + '.',
        'lat:', loc.latitude ? loc.latitude.toFixed(6) : 'null',
        'lon:', loc.longitude ? loc.longitude.toFixed(6) : 'null',
        'vel:', loc.velocidade || 0,
        'km/h | ign:', loc.estado_ignicao || loc.ignicao,
        '| há', idade, 'min |',
        loc.timestamp.toISOString().split('T')[1].substring(0,8)
      );
    });
  }

  // 3. Últimos dados OBD2 (tensão)
  const obd2 = await prisma.dadosOBD2.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      tensao_principal: true,
      tensao_bateria: true,
      velocidade: true,
      ignicao: true,
      timestamp: true
    }
  });

  console.log('\n=== ÚLTIMOS 10 DADOS OBD2/TENSÃO ===');
  if (obd2.length === 0) {
    console.log('NENHUM DADO OBD2 REGISTRADO');
  } else {
    obd2.forEach((d, i) => {
      const idade = ((Date.now() - new Date(d.timestamp).getTime()) / 1000 / 60).toFixed(1);
      console.log(
        (i+1) + '.',
        'tensão:', (d.tensao_principal || 0).toFixed(2) + 'V',
        '| bat:', (d.tensao_bateria || 0).toFixed(2) + 'V',
        '| vel:', d.velocidade || 0,
        '| ign:', d.ignicao,
        '| há', idade, 'min'
      );
    });
  }

  // 4. ANÁLISE DO PROBLEMA
  console.log('\n' + '='.repeat(60));
  console.log('ANÁLISE DO PROBLEMA');
  console.log('='.repeat(60));

  if (dispositivo.status === 'offline') {
    console.log('\n⚠️  O DISPOSITIVO ESTÁ MARCADO COMO OFFLINE');
    console.log('\nPOSSÍVEIS CAUSAS:');

    if (dispositivo.ultima_conexao) {
      const tempoOffline = (Date.now() - new Date(dispositivo.ultima_conexao).getTime()) / 1000 / 60;
      console.log('1. Última conexão TCP há', tempoOffline.toFixed(1), 'minutos');
      if (tempoOffline > 10) {
        console.log('   → TIMEOUT de 10 minutos atingido - sistema marcou offline');
      }
    } else {
      console.log('1. Nunca conectou ao servidor TCP');
    }

    if (localizacoes.length > 0) {
      const ultimaLoc = localizacoes[0];
      const idadeGPS = (Date.now() - new Date(ultimaLoc.timestamp).getTime()) / 1000 / 60;
      console.log('2. Última posição GPS há', idadeGPS.toFixed(1), 'minutos');

      if (ultimaLoc.velocidade > 0) {
        console.log('   → ÚLTIMA VELOCIDADE:', ultimaLoc.velocidade, 'km/h (estava em movimento)');
      }
    }

    console.log('\nO QUE VERIFICAR:');
    console.log('- O rastreador pode ter perdido sinal de celular');
    console.log('- O SIM card pode estar sem crédito/dados');
    console.log('- O rastreador pode ter reiniciado');
    console.log('- Verificar se o servidor TCP (porta 8877) está rodando');
    console.log('- Verificar conexões ativas no TCP Gateway');
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('ERRO:', e.message);
  process.exit(1);
});
