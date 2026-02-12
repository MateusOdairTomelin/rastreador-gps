/**
 * Script para corrigir dados históricos de ignição
 * Atualiza localizações que foram salvas incorretamente com ignicao=true
 * quando o veículo estava parado (velocidade baixa, GPS drift)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function corrigirHistorico() {
  console.log('=== CORREÇÃO DE HISTÓRICO DE IGNIÇÃO ===\n');

  // Buscar todos os dispositivos
  const dispositivos = await prisma.dispositivo.findMany();
  console.log(`Total de dispositivos: ${dispositivos.length}\n`);

  for (const dispositivo of dispositivos) {
    console.log(`\n--- Processando: ${dispositivo.imei} (${dispositivo.tipo}) ---`);

    // Contar localizações problemáticas:
    // - ignicao = true
    // - estado_ignicao = 'idle' ou 'moving'
    // - velocidade <= 5 km/h (provavelmente GPS drift, não movimento real)
    const countProblematicos = await prisma.localizacao.count({
      where: {
        dispositivo_id: dispositivo.id,
        ignicao: true,
        estado_ignicao: { in: ['idle', 'moving'] },
        velocidade: { lte: 5 }
      }
    });

    if (countProblematicos === 0) {
      console.log('  Nenhum registro problemático encontrado.');
      continue;
    }

    console.log(`  Registros problemáticos: ${countProblematicos}`);

    // Atualizar em lotes para não sobrecarregar
    const result = await prisma.localizacao.updateMany({
      where: {
        dispositivo_id: dispositivo.id,
        ignicao: true,
        estado_ignicao: { in: ['idle', 'moving'] },
        velocidade: { lte: 5 }
      },
      data: {
        ignicao: false,
        estado_ignicao: 'off'
      }
    });

    console.log(`  ✅ Corrigidos: ${result.count} registros`);
  }

  console.log('\n=== CORREÇÃO CONCLUÍDA ===');
  await prisma.$disconnect();
}

corrigirHistorico().catch(e => {
  console.error('Erro:', e);
  prisma.$disconnect();
  process.exit(1);
});
