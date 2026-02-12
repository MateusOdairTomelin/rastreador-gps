const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Detecta o estado da ignição baseado em ACC, RPM e velocidade
 */
function detectarEstadoIgnicao(acc, rpm, velocidade = null) {
  // OFF: ACC desligado
  if (!acc) {
    return 'off';
  }

  // ACC ligado - verificar se motor está rodando
  const rpmThreshold = 500;

  if (rpm === null || rpm === undefined || rpm < rpmThreshold) {
    // Meia chave: ACC ligado mas motor parado
    return 'acc_on';
  }

  // Motor ligado (RPM >= 500)
  // Verificar se está parado (idle) ou em movimento
  if (velocidade !== null && velocidade !== undefined) {
    if (velocidade <= 2) {
      // Motor ligado mas parado = OCIOSO (ar-condicionado ligado, etc)
      return 'idle';
    } else {
      // Motor ligado e em movimento
      return 'moving';
    }
  }

  // Se não tiver velocidade, retornar genérico "ligado"
  return 'ligado';
}

/**
 * Atualiza o estado da ignição de todos os dispositivos
 */
async function atualizarEstadosIgnicao() {
  console.log('🔑 Atualizando estados de ignição para todos os dispositivos...\n');

  try {
    // Buscar todos os dispositivos
    const dispositivos = await prisma.dispositivo.findMany();
    const timeoutMinutos = 5; // Timeout de 5 minutos para dados OBD2

    for (const dispositivo of dispositivos) {
      // Buscar último dado OBD2
      const ultimoOBD2 = await prisma.dadosOBD2.findFirst({
        where: { dispositivo_id: dispositivo.id },
        orderBy: { timestamp: 'desc' }
      });

      // Buscar última localização para pegar velocidade
      const ultimaLocalizacao = await prisma.localizacao.findFirst({
        where: { dispositivo_id: dispositivo.id },
        orderBy: { timestamp: 'desc' }
      });

      if (!ultimoOBD2) {
        console.log(`⚠️  ${dispositivo.imei}: Sem dados OBD2 - setando OFF`);
        await prisma.dispositivo.update({
          where: { id: dispositivo.id },
          data: { estado_ignicao: 'off' }
        });
        continue;
      }

      // Verificar se dados OBD2 são muito antigos (> 5 minutos)
      const tempoOBD2 = new Date(ultimoOBD2.timestamp).getTime();
      const minutosDesdeOBD2 = (Date.now() - tempoOBD2) / (1000 * 60);

      if (minutosDesdeOBD2 > timeoutMinutos) {
        console.log(`⏱️  ${dispositivo.imei}: Dados OBD2 antigos (${Math.round(minutosDesdeOBD2)} min) - setando OFF`);
        await prisma.dispositivo.update({
          where: { id: dispositivo.id },
          data: { estado_ignicao: 'off' }
        });
        continue;
      }

      const acc = ultimoOBD2.ignicao ?? false;
      const rpm = ultimoOBD2.rpm ?? null;
      const velocidade = ultimaLocalizacao?.velocidade ?? null;

      const estadoIgnicao = detectarEstadoIgnicao(acc, rpm, velocidade);

      // Atualizar dispositivo
      await prisma.dispositivo.update({
        where: { id: dispositivo.id },
        data: { estado_ignicao: estadoIgnicao }
      });

      const estadoLabel = {
        'off': '🔴 OFF',
        'acc_on': '🟡 Meia Chave',
        'idle': '🟠 Ocioso (parado)',
        'moving': '🟢 Em Movimento',
        'ligado': '🟢 Ligado'
      }[estadoIgnicao];

      console.log(`${dispositivo.imei}: ${estadoLabel} (ACC=${acc}, RPM=${rpm || 'N/A'}, Vel=${velocidade || 'N/A'}km/h)`);
    }

    console.log('\n✅ Estados de ignição atualizados com sucesso!');
  } catch (error) {
    console.error('❌ Erro:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

atualizarEstadosIgnicao();
