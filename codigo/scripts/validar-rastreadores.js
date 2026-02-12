const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Script de validação completa de rastreadores
 * Verifica dados OBD2, configuração e sugere ações
 */

const CAMPOS_ESPERADOS = {
  location: ['latitude', 'longitude', 'velocidade'],
  obd2_0x22: ['tensao_bateria', 'percentual_bateria', 'hora_motor_embarcada', 'odometro_embarcado'],
  obd2_0x94: ['rpm', 'temperatura_motor', 'nivel_combustivel', 'ignicao']
};

async function validarRastreadores() {
  console.log('🔍 VALIDAÇÃO COMPLETA DE RASTREADORES\n');
  console.log('=' .repeat(80));

  const dispositivos = await prisma.dispositivo.findMany({
    include: {
      localizacoes: {
        orderBy: { timestamp: 'desc' },
        take: 5
      },
      dados_obd2: {
        orderBy: { timestamp: 'desc' },
        take: 5
      }
    }
  });

  const resultados = [];

  for (const dispositivo of dispositivos) {
    console.log(`\n📡 DISPOSITIVO: ${dispositivo.imei}`);
    console.log(`   Veículo: ${dispositivo.veiculo || 'N/A'}`);
    console.log(`   Status: ${dispositivo.status || 'desconhecido'}`);
    console.log('-'.repeat(80));

    const resultado = {
      imei: dispositivo.imei,
      veiculo: dispositivo.veiculo,
      status: dispositivo.status,
      problemas: [],
      recomendacoes: [],
      campos_ok: [],
      campos_faltando: []
    };

    // 1. Verificar dados de localização
    console.log('\n   📍 LOCALIZAÇÃO:');
    if (dispositivo.localizacoes.length === 0) {
      console.log('      ❌ Sem dados de localização');
      resultado.problemas.push('Sem dados de localização');
      resultado.recomendacoes.push('Verificar conexão TCP/IP do rastreador');
    } else {
      const ultimaLoc = dispositivo.localizacoes[0];
      const idadeLoc = (Date.now() - new Date(ultimaLoc.timestamp).getTime()) / (1000 * 60);

      console.log(`      ✅ Última atualização: ${Math.round(idadeLoc)} minutos atrás`);
      console.log(`      Coordenadas: ${ultimaLoc.latitude}, ${ultimaLoc.longitude}`);
      console.log(`      Velocidade: ${ultimaLoc.velocidade} km/h`);

      if (idadeLoc > 60) {
        resultado.problemas.push(`Localização antiga (${Math.round(idadeLoc)} min)`);
      }
    }

    // 2. Verificar dados OBD2
    console.log('\n   🔧 DADOS OBD2:');
    if (dispositivo.dados_obd2.length === 0) {
      console.log('      ❌ SEM DADOS OBD2 - Rastreador não configurado!');
      resultado.problemas.push('Sem dados OBD2');
      resultado.recomendacoes.push('Enviar comando: SETLOCX22#');
      resultado.recomendacoes.push('Verificar cabo OBD2 conectado');
    } else {
      const ultimoOBD2 = dispositivo.dados_obd2[0];
      const idadeOBD2 = (Date.now() - new Date(ultimoOBD2.timestamp).getTime()) / (1000 * 60);

      console.log(`      Última atualização: ${Math.round(idadeOBD2)} minutos atrás`);

      // Verificar campos do protocolo 0x94 (OBD2 do veículo)
      const campos0x94 = {
        'RPM': ultimoOBD2.rpm,
        'Temperatura': ultimoOBD2.temperatura_motor,
        'Combustível': ultimoOBD2.nivel_combustivel,
        'Ignição (ACC)': ultimoOBD2.ignicao
      };

      console.log('\n      Protocolo 0x94 (Dados do veículo via OBD2):');
      let campos0x94_ok = 0;
      for (const [campo, valor] of Object.entries(campos0x94)) {
        if (valor !== null && valor !== undefined) {
          console.log(`         ✅ ${campo}: ${valor}`);
          campos0x94_ok++;
          resultado.campos_ok.push(campo);
        } else {
          console.log(`         ❌ ${campo}: null`);
          resultado.campos_faltando.push(campo);
        }
      }

      // Verificar campos do protocolo 0x22 (Dados do rastreador)
      const campos0x22 = {
        'Bateria V': ultimoOBD2.tensao_bateria,
        'Bateria %': ultimoOBD2.percentual_bateria,
        'Horímetro': ultimoOBD2.hora_motor_embarcada,
        'Odômetro': ultimoOBD2.odometro_embarcado
      };

      console.log('\n      Protocolo 0x22 (Dados do rastreador):');
      let campos0x22_ok = 0;
      for (const [campo, valor] of Object.entries(campos0x22)) {
        if (valor !== null && valor !== undefined) {
          console.log(`         ✅ ${campo}: ${valor}`);
          campos0x22_ok++;
          resultado.campos_ok.push(campo);
        } else {
          console.log(`         ❌ ${campo}: null`);
          resultado.campos_faltando.push(campo);
        }
      }

      // Análise de problemas
      if (campos0x94_ok === 0) {
        resultado.problemas.push('Nenhum dado OBD2 do veículo (0x94)');
        resultado.recomendacoes.push('Verificar cabo OBD2 conectado na porta do veículo');
        resultado.recomendacoes.push('Verificar se veículo suporta protocolo OBD2');
      }

      if (campos0x22_ok === 0) {
        resultado.problemas.push('Nenhum dado do rastreador (0x22)');
        resultado.recomendacoes.push('Enviar comando: SETLOCX22#');
      }

      // Detectar dados em cache
      if (dispositivo.dados_obd2.length >= 2) {
        const obd1 = dispositivo.dados_obd2[0];
        const obd2 = dispositivo.dados_obd2[1];

        if (obd1.rpm === obd2.rpm &&
            obd1.temperatura_motor === obd2.temperatura_motor &&
            obd1.rpm !== null && obd1.rpm > 0) {
          const tempo1 = new Date(obd1.timestamp).getTime();
          const tempo2 = new Date(obd2.timestamp).getTime();
          const minDiff = (tempo1 - tempo2) / (1000 * 60);

          if (minDiff > 5) {
            console.log(`\n      ⚠️  ALERTA: Dados idênticos há ${Math.round(minDiff)} min (possível cache)`);
            resultado.problemas.push(`Dados em cache (${Math.round(minDiff)} min)`);
          }
        }
      }

      if (idadeOBD2 > 60) {
        resultado.problemas.push(`Dados OBD2 antigos (${Math.round(idadeOBD2)} min)`);
      }
    }

    // 3. Recomendações finais
    if (resultado.recomendacoes.length > 0) {
      console.log('\n   💡 RECOMENDAÇÕES:');
      resultado.recomendacoes.forEach(rec => {
        console.log(`      → ${rec}`);
      });
    }

    // 4. Status geral
    const statusGeral = resultado.problemas.length === 0 ? '✅ OK' :
                       resultado.problemas.length < 3 ? '⚠️  ATENÇÃO' : '❌ CRÍTICO';
    console.log(`\n   Status Geral: ${statusGeral}`);

    resultados.push(resultado);
  }

  // Resumo final
  console.log('\n' + '='.repeat(80));
  console.log('📊 RESUMO GERAL\n');

  const total = resultados.length;
  const ok = resultados.filter(r => r.problemas.length === 0).length;
  const atencao = resultados.filter(r => r.problemas.length > 0 && r.problemas.length < 3).length;
  const critico = resultados.filter(r => r.problemas.length >= 3).length;

  console.log(`Total de dispositivos: ${total}`);
  console.log(`   ✅ OK: ${ok}`);
  console.log(`   ⚠️  Atenção: ${atencao}`);
  console.log(`   ❌ Crítico: ${critico}`);

  console.log('\n' + '='.repeat(80));

  await prisma.$disconnect();
}

validarRastreadores().catch(console.error);
