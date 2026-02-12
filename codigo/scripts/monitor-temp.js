const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

let ultimoTs = null;
let timestamps = [];

async function verificar() {
  const loc = await prisma.localizacao.findFirst({
    where: { dispositivo: { imei: '356354870658615' } },
    orderBy: { timestamp: 'desc' }
  });

  const obd = await prisma.dadosOBD2.findFirst({
    where: { dispositivo: { imei: '356354870658615' } },
    orderBy: { timestamp: 'desc' }
  });

  if (loc) {
    const ts = loc.timestamp.getTime();
    const novo = ultimoTs !== ts;

    if (novo && ultimoTs) {
      const intervalo = (ts - ultimoTs) / 1000;
      timestamps.push(intervalo);
      const tensao = obd && obd.tensao_principal ? obd.tensao_principal.toFixed(2) + 'V' : '--';
      console.log(`🆕 [${new Date().toLocaleTimeString('pt-BR')}] vel=${String(loc.velocidade).padStart(2)}km/h ign=${loc.ignicao ? 'ON ' : 'OFF'} tensao=${tensao} | Intervalo: ${intervalo.toFixed(0)}s`);
    } else if (novo) {
      const tensao = obd && obd.tensao_principal ? obd.tensao_principal.toFixed(2) + 'V' : '--';
      console.log(`🆕 [${new Date().toLocaleTimeString('pt-BR')}] vel=${String(loc.velocidade).padStart(2)}km/h ign=${loc.ignicao ? 'ON ' : 'OFF'} tensao=${tensao} | Primeiro ponto`);
    }

    if (novo) ultimoTs = ts;
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('🚗 VERIFICANDO INTERVALO (5 minutos)');
console.log('═══════════════════════════════════════════════════════════════');

let count = 0;
const maxCount = 60; // 60 x 5s = 5 min

const interval = setInterval(async () => {
  await verificar();
  count++;
  if (count >= maxCount) {
    clearInterval(interval);
    if (timestamps.length > 1) {
      // Filtrar intervalos muito grandes (> 60s) que são da config antiga
      const filtrados = timestamps.filter(t => t < 60);
      const media = filtrados.length > 0
        ? filtrados.reduce((a,b) => a+b, 0) / filtrados.length
        : timestamps.reduce((a,b) => a+b, 0) / timestamps.length;
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log(`✅ Total de pontos: ${timestamps.length + 1}`);
      console.log(`✅ Intervalo médio (< 60s): ${media.toFixed(1)} segundos`);
      console.log(`📊 Intervalos: ${timestamps.map(t => t.toFixed(0) + 's').join(', ')}`);
      console.log('═══════════════════════════════════════════════════════════════');
    } else {
      console.log('⚠️ Poucos pontos recebidos');
    }
    prisma.$disconnect();
  }
}, 5000);

verificar();
