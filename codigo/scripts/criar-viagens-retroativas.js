/**
 * Script para criar viagens retroativas para todos os dispositivos
 * Analisa localizacoes existentes e detecta viagens baseado em velocidade
 *
 * Uso: node scripts/criar-viagens-retroativas.js [--imei=XXXX] [--force]
 *
 * --imei=XXXX : Processar apenas um dispositivo especifico
 * --force     : Reprocessar mesmo se ja tem viagens
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Funcao Haversine para calcular distancia em km
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Processa um dispositivo e cria viagens retroativas
 */
async function processarDispositivo(dispositivo) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processando: ${dispositivo.imei} (${dispositivo.tipo})`);
  console.log(`${'='.repeat(60)}`);

  // Buscar localizacoes ordenadas
  const localizacoes = await prisma.localizacao.findMany({
    where: { dispositivo_id: dispositivo.id },
    orderBy: { timestamp: 'asc' }
  });

  console.log(`Total de localizacoes: ${localizacoes.length}`);

  if (localizacoes.length < 5) {
    console.log('Poucas localizacoes, pulando...');
    return { viagens: 0, distancia: 0, duracao: 0 };
  }

  // Detectar viagens baseado em velocidade > 0
  const viagens = [];
  let viagemAtual = null;
  let ultimaLoc = null;
  let pontosParados = 0;

  for (const loc of localizacoes) {
    const emMovimento = loc.velocidade > 0;

    if (emMovimento && !viagemAtual) {
      // Inicio de viagem
      viagemAtual = {
        inicio: loc.timestamp,
        origem_lat: parseFloat(loc.latitude),
        origem_lng: parseFloat(loc.longitude),
        pontos: [loc],
        distancia: 0,
        velocidades: [loc.velocidade],
        vel_max: loc.velocidade,
        fim: loc.timestamp,
        destino_lat: parseFloat(loc.latitude),
        destino_lng: parseFloat(loc.longitude)
      };
      pontosParados = 0;
      console.log(`  Viagem iniciada: ${loc.timestamp.toISOString()}`);
    } else if (viagemAtual) {
      viagemAtual.pontos.push(loc);

      if (ultimaLoc) {
        const dist = calcularDistancia(
          parseFloat(ultimaLoc.latitude), parseFloat(ultimaLoc.longitude),
          parseFloat(loc.latitude), parseFloat(loc.longitude)
        );
        if (dist > 0.01 && dist < 5) {
          viagemAtual.distancia += dist;
        }
      }

      if (loc.velocidade > 0) {
        viagemAtual.velocidades.push(loc.velocidade);
        viagemAtual.vel_max = Math.max(viagemAtual.vel_max, loc.velocidade);
        viagemAtual.fim = loc.timestamp;
        viagemAtual.destino_lat = parseFloat(loc.latitude);
        viagemAtual.destino_lng = parseFloat(loc.longitude);
        pontosParados = 0;
      } else {
        pontosParados++;
      }

      // Fim de viagem: 3+ pontos consecutivos parados OU gap de tempo > 30 min
      const tempoDesdeUltimo = ultimaLoc ?
        (loc.timestamp.getTime() - ultimaLoc.timestamp.getTime()) / 60000 : 0;

      const fimViagem = (pontosParados >= 3 && viagemAtual.velocidades.length > 3) ||
                        (tempoDesdeUltimo > 30 && viagemAtual.velocidades.length > 3);

      if (fimViagem) {
        // Finalizar viagem
        const duracao = (viagemAtual.fim.getTime() - viagemAtual.inicio.getTime()) / 60000;
        const velMedia = viagemAtual.velocidades.reduce((a,b) => a+b, 0) / viagemAtual.velocidades.length;

        // Filtrar viagens muito longas (> 8 horas) que provavelmente sao erro
        if (duracao > 1 && duracao < 480 && viagemAtual.distancia > 0.1) {
          viagens.push({
            dispositivo_id: dispositivo.id,
            inicio: viagemAtual.inicio,
            fim: viagemAtual.fim,
            duracao_minutos: duracao,
            distancia_km: viagemAtual.distancia,
            velocidade_media: velMedia,
            velocidade_max: viagemAtual.vel_max,
            origem_lat: viagemAtual.origem_lat,
            origem_lng: viagemAtual.origem_lng,
            destino_lat: viagemAtual.destino_lat,
            destino_lng: viagemAtual.destino_lng
          });
          console.log(`  Viagem finalizada: ${duracao.toFixed(1)}min, ${viagemAtual.distancia.toFixed(2)}km, velMax=${viagemAtual.vel_max}km/h`);
        } else if (duracao >= 480) {
          console.log(`  Viagem descartada (muito longa): ${duracao.toFixed(1)}min`);
        }
        viagemAtual = null;
        pontosParados = 0;
      }
    }

    ultimaLoc = loc;
  }

  // Se ainda tem viagem em andamento, finalizar
  if (viagemAtual && viagemAtual.velocidades.length > 3) {
    const duracao = (viagemAtual.fim.getTime() - viagemAtual.inicio.getTime()) / 60000;
    const velMedia = viagemAtual.velocidades.reduce((a,b) => a+b, 0) / viagemAtual.velocidades.length;

    if (duracao > 1 && duracao < 480 && viagemAtual.distancia > 0.1) {
      viagens.push({
        dispositivo_id: dispositivo.id,
        inicio: viagemAtual.inicio,
        fim: viagemAtual.fim,
        duracao_minutos: duracao,
        distancia_km: viagemAtual.distancia,
        velocidade_media: velMedia,
        velocidade_max: viagemAtual.vel_max,
        origem_lat: viagemAtual.origem_lat,
        origem_lng: viagemAtual.origem_lng,
        destino_lat: viagemAtual.destino_lat,
        destino_lng: viagemAtual.destino_lng
      });
      console.log(`  Ultima viagem: ${duracao.toFixed(1)}min, ${viagemAtual.distancia.toFixed(2)}km`);
    }
  }

  console.log(`\nTotal de viagens detectadas: ${viagens.length}`);

  if (viagens.length === 0) {
    return { viagens: 0, distancia: 0, duracao: 0 };
  }

  // Inserir viagens no banco
  for (const viagem of viagens) {
    try {
      const created = await prisma.viagem.create({ data: viagem });
      console.log(`  Viagem #${created.id} criada: ${viagem.distancia_km.toFixed(2)}km em ${viagem.duracao_minutos.toFixed(1)}min`);
    } catch (err) {
      console.error(`  Erro ao criar viagem: ${err.message}`);
    }
  }

  // Atualizar totais do dispositivo
  const totalDist = viagens.reduce((a, v) => a + v.distancia_km, 0);
  const totalHoras = viagens.reduce((a, v) => a + v.duracao_minutos, 0) / 60;

  await prisma.dispositivo.update({
    where: { id: dispositivo.id },
    data: {
      odometro_total: { increment: totalDist },
      horimetro_total: { increment: totalHoras }
    }
  });

  console.log(`\nTotais atualizados: +${totalDist.toFixed(2)}km, +${totalHoras.toFixed(2)}h`);

  return { viagens: viagens.length, distancia: totalDist, duracao: totalHoras };
}

async function main() {
  const args = process.argv.slice(2);
  const imeiArg = args.find(a => a.startsWith('--imei='));
  const forceArg = args.includes('--force');
  const imeiFilter = imeiArg ? imeiArg.split('=')[1] : null;

  console.log('============================================================');
  console.log('CRIADOR DE VIAGENS RETROATIVAS');
  console.log('============================================================');
  console.log(`Filtro IMEI: ${imeiFilter || 'TODOS'}`);
  console.log(`Modo Force: ${forceArg ? 'SIM' : 'NAO'}`);

  // Buscar dispositivos
  const whereClause = {};
  if (imeiFilter) {
    whereClause.imei = imeiFilter;
  }

  const dispositivos = await prisma.dispositivo.findMany({
    where: whereClause,
    include: {
      _count: {
        select: { viagens: true, localizacoes: true }
      }
    }
  });

  console.log(`\nDispositivos encontrados: ${dispositivos.length}`);

  let totalViagens = 0;
  let totalDistancia = 0;
  let totalDuracao = 0;

  for (const dispositivo of dispositivos) {
    const temViagens = dispositivo._count.viagens > 0;
    const temLocalizacoes = dispositivo._count.localizacoes > 0;

    // Pular se ja tem viagens e nao esta em modo force
    if (temViagens && !forceArg) {
      console.log(`\n[SKIP] ${dispositivo.imei}: Ja tem ${dispositivo._count.viagens} viagens`);
      continue;
    }

    // Pular se nao tem localizacoes
    if (!temLocalizacoes) {
      console.log(`\n[SKIP] ${dispositivo.imei}: Sem localizacoes`);
      continue;
    }

    const resultado = await processarDispositivo(dispositivo);
    totalViagens += resultado.viagens;
    totalDistancia += resultado.distancia;
    totalDuracao += resultado.duracao;
  }

  console.log('\n============================================================');
  console.log('RESUMO FINAL');
  console.log('============================================================');
  console.log(`Viagens criadas: ${totalViagens}`);
  console.log(`Distancia total: ${totalDistancia.toFixed(2)} km`);
  console.log(`Duracao total: ${totalDuracao.toFixed(2)} horas`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
