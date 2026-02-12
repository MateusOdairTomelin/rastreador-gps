#!/usr/bin/env node
/**
 * Script de Validacao da IA de GPS
 *
 * Compara pontos originais vs corrigidos e mostra se a correcao
 * esta melhorando ou piorando a trajetoria.
 *
 * Uso: node scripts/validar-ia-gps.js [imei] [horas]
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Funcoes de calculo
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function calcularBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

function normalizarAngulo(angulo) {
  while (angulo > 180) angulo -= 360;
  while (angulo < -180) angulo += 360;
  return angulo;
}

// Metricas de qualidade
function calcularMetricasTrajetoria(pontos) {
  if (pontos.length < 2) return null;

  let distanciaTotal = 0;
  let mudancasDirecao = [];
  let velocidades = [];

  for (let i = 1; i < pontos.length; i++) {
    const anterior = pontos[i - 1];
    const atual = pontos[i];

    const dist = calcularDistancia(anterior.lat, anterior.lon, atual.lat, atual.lon);
    distanciaTotal += dist;

    if (i > 1) {
      const bearing1 = calcularBearing(pontos[i-2].lat, pontos[i-2].lon, anterior.lat, anterior.lon);
      const bearing2 = calcularBearing(anterior.lat, anterior.lon, atual.lat, atual.lon);
      const mudanca = Math.abs(normalizarAngulo(bearing2 - bearing1));
      mudancasDirecao.push(mudanca);
    }

    const dt = (new Date(atual.timestamp) - new Date(anterior.timestamp)) / 1000;
    if (dt > 0) {
      velocidades.push((dist / dt) * 3.6); // km/h
    }
  }

  // Calcular suavidade (menor = mais suave)
  const suavidade = mudancasDirecao.length > 0
    ? mudancasDirecao.reduce((a, b) => a + b, 0) / mudancasDirecao.length
    : 0;

  // Calcular variacao de velocidade
  const velMedia = velocidades.length > 0
    ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length
    : 0;
  const varVel = velocidades.length > 0
    ? Math.sqrt(velocidades.reduce((acc, v) => acc + Math.pow(v - velMedia, 2), 0) / velocidades.length)
    : 0;

  // Detectar pontos fora de padrao (outliers)
  let outliers = 0;
  for (let i = 2; i < pontos.length; i++) {
    const p0 = pontos[i - 2];
    const p1 = pontos[i - 1];
    const p2 = pontos[i];

    const d1 = calcularDistancia(p0.lat, p0.lon, p1.lat, p1.lon);
    const d2 = calcularDistancia(p1.lat, p1.lon, p2.lat, p2.lon);

    // Se ponto do meio esta muito deslocado em relacao a linha reta
    const dDireto = calcularDistancia(p0.lat, p0.lon, p2.lat, p2.lon);
    const desvio = (d1 + d2) - dDireto;

    if (desvio > 20) { // Desvio maior que 20m = outlier
      outliers++;
    }
  }

  return {
    pontos: pontos.length,
    distanciaTotal: Math.round(distanciaTotal),
    suavidade: suavidade.toFixed(1),
    velocidadeMedia: velMedia.toFixed(1),
    variacaoVelocidade: varVel.toFixed(1),
    outliers,
    qualidade: calcularIndiceQualidade(suavidade, varVel, outliers, pontos.length)
  };
}

function calcularIndiceQualidade(suavidade, varVel, outliers, totalPontos) {
  // Indice de 0 a 100 (maior = melhor)
  let indice = 100;

  // Penalizar por suavidade ruim (mudancas bruscas de direcao)
  indice -= Math.min(30, suavidade * 0.5);

  // Penalizar por variacao de velocidade alta
  indice -= Math.min(20, varVel * 0.5);

  // Penalizar por outliers
  indice -= Math.min(30, (outliers / Math.max(1, totalPontos)) * 100);

  return Math.max(0, Math.round(indice));
}

async function validarDispositivo(imei, horas) {
  console.log(`\n=== Validacao IA GPS para ${imei} (ultimas ${horas}h) ===\n`);

  // Buscar dispositivo
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei }
  });

  if (!dispositivo) {
    console.log('Dispositivo nao encontrado!');
    return;
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  // Buscar localizacoes
  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio }
    },
    orderBy: { timestamp: 'asc' }
  });

  if (localizacoes.length < 5) {
    console.log(`Poucos pontos para analise: ${localizacoes.length}`);
    return;
  }

  console.log(`Total de pontos: ${localizacoes.length}\n`);

  // Separar pontos originais e corrigidos
  const pontosOriginais = [];
  const pontosCorrigidos = [];

  for (const loc of localizacoes) {
    // Se temos coordenada original, usar ela
    if (loc.latitude_original && loc.longitude_original) {
      pontosOriginais.push({
        lat: loc.latitude_original,
        lon: loc.longitude_original,
        timestamp: loc.timestamp
      });
      pontosCorrigidos.push({
        lat: loc.latitude,
        lon: loc.longitude,
        timestamp: loc.timestamp
      });
    } else {
      // Usar coordenada atual como ambas
      pontosOriginais.push({
        lat: loc.latitude,
        lon: loc.longitude,
        timestamp: loc.timestamp
      });
      pontosCorrigidos.push({
        lat: loc.latitude,
        lon: loc.longitude,
        timestamp: loc.timestamp
      });
    }
  }

  // Calcular metricas
  const metricasOriginais = calcularMetricasTrajetoria(pontosOriginais);
  const metricasCorrigidos = calcularMetricasTrajetoria(pontosCorrigidos);

  console.log('--- METRICAS PONTOS ORIGINAIS ---');
  console.log(`  Distancia total: ${metricasOriginais.distanciaTotal}m`);
  console.log(`  Suavidade (menor=melhor): ${metricasOriginais.suavidade} graus/ponto`);
  console.log(`  Velocidade media: ${metricasOriginais.velocidadeMedia} km/h`);
  console.log(`  Variacao velocidade: ${metricasOriginais.variacaoVelocidade} km/h`);
  console.log(`  Outliers detectados: ${metricasOriginais.outliers}`);
  console.log(`  INDICE DE QUALIDADE: ${metricasOriginais.qualidade}/100`);

  console.log('\n--- METRICAS PONTOS CORRIGIDOS ---');
  console.log(`  Distancia total: ${metricasCorrigidos.distanciaTotal}m`);
  console.log(`  Suavidade (menor=melhor): ${metricasCorrigidos.suavidade} graus/ponto`);
  console.log(`  Velocidade media: ${metricasCorrigidos.velocidadeMedia} km/h`);
  console.log(`  Variacao velocidade: ${metricasCorrigidos.variacaoVelocidade} km/h`);
  console.log(`  Outliers detectados: ${metricasCorrigidos.outliers}`);
  console.log(`  INDICE DE QUALIDADE: ${metricasCorrigidos.qualidade}/100`);

  // Comparacao
  console.log('\n--- COMPARACAO ---');
  const diffQualidade = metricasCorrigidos.qualidade - metricasOriginais.qualidade;
  const diffSuavidade = parseFloat(metricasOriginais.suavidade) - parseFloat(metricasCorrigidos.suavidade);
  const diffOutliers = metricasOriginais.outliers - metricasCorrigidos.outliers;

  if (diffQualidade > 0) {
    console.log(`  MELHORIA de qualidade: +${diffQualidade} pontos`);
  } else if (diffQualidade < 0) {
    console.log(`  PIORA de qualidade: ${diffQualidade} pontos`);
  } else {
    console.log(`  Qualidade IGUAL`);
  }

  if (diffSuavidade > 0) {
    console.log(`  Suavidade melhorou: ${diffSuavidade.toFixed(1)} graus/ponto a menos`);
  } else if (diffSuavidade < 0) {
    console.log(`  Suavidade piorou: ${Math.abs(diffSuavidade).toFixed(1)} graus/ponto a mais`);
  }

  if (diffOutliers > 0) {
    console.log(`  Outliers removidos: ${diffOutliers}`);
  } else if (diffOutliers < 0) {
    console.log(`  Outliers ADICIONADOS: ${Math.abs(diffOutliers)} (PROBLEMA!)`);
  }

  // Veredicto final
  console.log('\n--- VEREDICTO ---');
  if (diffQualidade >= 5 && diffOutliers >= 0) {
    console.log('  A IA esta MELHORANDO a trajetoria');
  } else if (diffQualidade <= -5 || diffOutliers < -2) {
    console.log('  A IA esta PIORANDO a trajetoria!');
    console.log('  Recomendacao: Revisar parametros ou desabilitar temporariamente');
  } else {
    console.log('  A IA tem impacto NEUTRO');
    console.log('  Recomendacao: Treinar com mais dados validados');
  }

  // Buscar estatisticas de correcao
  const correcoes = await prisma.correcaoGPS.groupBy({
    by: ['status'],
    where: { dispositivo_id: dispositivo.id },
    _count: { id: true }
  });

  console.log('\n--- HISTORICO DE CORRECOES ---');
  const stats = correcoes.reduce((acc, c) => {
    acc[c.status] = c._count.id;
    return acc;
  }, {});
  console.log(`  Aprovadas: ${stats.aprovado || 0}`);
  console.log(`  Rejeitadas: ${stats.rejeitado || 0}`);
  console.log(`  Pendentes: ${stats.pendente || 0}`);

  const total = (stats.aprovado || 0) + (stats.rejeitado || 0);
  if (total > 0) {
    const taxa = ((stats.aprovado || 0) / total * 100).toFixed(1);
    console.log(`  Taxa de aprovacao: ${taxa}%`);
  }

  await prisma.$disconnect();
}

// Main
const args = process.argv.slice(2);
const imei = args[0] || '356354870699551';
const horas = parseInt(args[1]) || 24;

validarDispositivo(imei, horas).catch(console.error);
