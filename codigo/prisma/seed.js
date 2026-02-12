const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create test device
  const device = await prisma.dispositivo.upsert({
    where: { imei: '123456789012345' },
    update: {},
    create: {
      imei: '123456789012345',
      tipo: 'XT40_OBD2',
      placa: 'ABC-1234',
      veiculo: 'Veículo de Teste',
      status: 'online',
      ultima_conexao: new Date(),
    },
  });

  console.log('✅ Created device:', device.imei);

  // Create test location
  const location = await prisma.localizacao.create({
    data: {
      dispositivo_id: device.id,
      latitude: -15.7933,
      longitude: -48.0019,
      altitude: 950,
      velocidade: 0,
      direcao: 0,
      precisao: 10,
      timestamp: new Date(),
    },
  });

  console.log('✅ Created location:', location.id);

  // Create test OBD2 data
  const obd2 = await prisma.dadosOBD2.create({
    data: {
      dispositivo_id: device.id,
      rpm: 0,
      temperatura_motor: 85,
      nivel_combustivel: 75,
      ignicao: false,
      odometro: 50000,
      hora_motor: 1200,
      timestamp: new Date(),
    },
  });

  console.log('✅ Created OBD2 data:', obd2.id);

  // Create test alarm
  const alarm = await prisma.alarme.create({
    data: {
      dispositivo_id: device.id,
      tipo_alarme: 'Test Alert',
      descricao: 'Sistema de rastreamento inicializado',
      severidade: 'info',
      timestamp: new Date(),
    },
  });

  console.log('✅ Created alarm:', alarm.id);

  console.log('\n✨ Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
