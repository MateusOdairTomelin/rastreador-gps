/**
 * Monitor de Viagem em Tempo Real
 * Dispositivo: 356354870699551
 * Data: 2025-12-11
 */

const fs = require('fs');
const path = require('path');

const IMEI = '356354870699551';
const API_BASE = 'http://localhost:62000/api';
const INTERVALO_COLETA = 5000; // 5 segundos
const DATA_ATUAL = new Date().toISOString().split('T')[0];

// Arquivos de saída
const OUTPUT_DIR = '/home/tomelin/rastreador/coleta_dados';
const DADOS_FILE = path.join(OUTPUT_DIR, `viagem_${IMEI}_${DATA_ATUAL}.json`);
const LOG_FILE = path.join(OUTPUT_DIR, `viagem_log_${IMEI}_${DATA_ATUAL}.txt`);

// Dados coletados
const dadosViagem = {
  imei: IMEI,
  inicio: new Date().toISOString(),
  fim: null,
  localizacoes: [],
  dadosOBD: [],
  pacotesDebug: [],
  estatisticas: {
    velocidade_max: 0,
    velocidade_media: 0,
    rpm_max: 0,
    rpm_media: 0,
    temperatura_max: 0,
    distancia_total: 0,
    duracao_minutos: 0,
    pontos_coletados: 0
  }
};

let ultimaLocalizacao = null;
let somaVelocidades = 0;
let somaRPMs = 0;
let contadorVelocidades = 0;
let contadorRPMs = 0;

// Função para log
function log(mensagem) {
  const timestamp = new Date().toISOString();
  const linha = `[${timestamp}] ${mensagem}`;
  console.log(linha);
  fs.appendFileSync(LOG_FILE, linha + '\n');
}

// Calcula distância entre dois pontos (Haversine)
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// Fetch com timeout
async function fetchComTimeout(url, timeout = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    return null;
  }
}

// Coleta dados de localização
async function coletarLocalizacao() {
  const data = await fetchComTimeout(`${API_BASE}/dispositivos/${IMEI}/localizacao-atual`);
  if (data && data.sucesso && data.dados) {
    const loc = data.dados;

    // Calcular distância desde último ponto
    if (ultimaLocalizacao) {
      const dist = calcularDistancia(
        ultimaLocalizacao.latitude, ultimaLocalizacao.longitude,
        loc.latitude, loc.longitude
      );
      dadosViagem.estatisticas.distancia_total += dist;
    }

    // Atualizar estatísticas de velocidade
    if (loc.velocidade > 0) {
      somaVelocidades += loc.velocidade;
      contadorVelocidades++;
      if (loc.velocidade > dadosViagem.estatisticas.velocidade_max) {
        dadosViagem.estatisticas.velocidade_max = loc.velocidade;
      }
    }

    // Adicionar ao histórico
    dadosViagem.localizacoes.push({
      ...loc,
      coletado_em: new Date().toISOString()
    });

    ultimaLocalizacao = loc;
    dadosViagem.estatisticas.pontos_coletados++;

    return loc;
  }
  return null;
}

// Coleta dados OBD2
async function coletarOBD2() {
  const data = await fetchComTimeout(`${API_BASE}/dispositivos/${IMEI}/obd2-atual`);
  if (data && data.sucesso && data.dados) {
    const obd = data.dados;

    // Atualizar estatísticas OBD
    if (obd.rpm && obd.rpm > 0) {
      somaRPMs += obd.rpm;
      contadorRPMs++;
      if (obd.rpm > dadosViagem.estatisticas.rpm_max) {
        dadosViagem.estatisticas.rpm_max = obd.rpm;
      }
    }

    if (obd.temperatura_motor && obd.temperatura_motor > dadosViagem.estatisticas.temperatura_max) {
      dadosViagem.estatisticas.temperatura_max = obd.temperatura_motor;
    }

    // Adicionar ao histórico
    dadosViagem.dadosOBD.push({
      ...obd,
      coletado_em: new Date().toISOString()
    });

    return obd;
  }
  return null;
}

// Coleta pacotes de debug
async function coletarPacotesDebug() {
  const data = await fetchComTimeout(`${API_BASE}/debug/packets`);
  if (data && data.sucesso) {
    // Filtrar apenas pacotes do nosso IMEI
    const pacotesIMEI = data.ultimos_pacotes.filter(p => p.imei === IMEI);

    // Adicionar novos pacotes
    for (const pacote of pacotesIMEI) {
      const jaExiste = dadosViagem.pacotesDebug.some(p =>
        p.raw === pacote.raw && p.recordedAt === pacote.recordedAt
      );
      if (!jaExiste) {
        dadosViagem.pacotesDebug.push(pacote);
      }
    }

    return data.estatisticas;
  }
  return null;
}

// Salva dados em arquivo
function salvarDados() {
  // Atualizar médias
  dadosViagem.estatisticas.velocidade_media = contadorVelocidades > 0
    ? Math.round(somaVelocidades / contadorVelocidades) : 0;
  dadosViagem.estatisticas.rpm_media = contadorRPMs > 0
    ? Math.round(somaRPMs / contadorRPMs) : 0;
  dadosViagem.estatisticas.duracao_minutos = Math.round(
    (Date.now() - new Date(dadosViagem.inicio).getTime()) / 60000
  );
  dadosViagem.fim = new Date().toISOString();

  fs.writeFileSync(DADOS_FILE, JSON.stringify(dadosViagem, null, 2));
}

// Loop principal de coleta
async function coletarDados() {
  log('='.repeat(60));
  log(`COLETA #${dadosViagem.estatisticas.pontos_coletados + 1}`);

  // Coletar localização
  const loc = await coletarLocalizacao();
  if (loc) {
    log(`GPS: ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)} | Vel: ${loc.velocidade} km/h | Dir: ${loc.direcao}°`);
  } else {
    log('GPS: Sem dados');
  }

  // Coletar OBD2
  const obd = await coletarOBD2();
  if (obd) {
    log(`OBD: RPM=${obd.rpm || 'N/A'} | Temp=${obd.temperatura_motor || 'N/A'}°C | Comb=${obd.nivel_combustivel || 'N/A'}% | Odo=${obd.odometro_embarcado || 'N/A'}km`);
  } else {
    log('OBD: Sem dados');
  }

  // Coletar pacotes debug
  const stats = await coletarPacotesDebug();
  if (stats) {
    log(`Pacotes: Total=${stats.total} | Location=${stats.por_tipo.location} | OBD2=${stats.por_tipo.obd2}`);
  }

  // Estatísticas atuais
  log(`STATS: Dist=${dadosViagem.estatisticas.distancia_total.toFixed(2)}km | VelMax=${dadosViagem.estatisticas.velocidade_max}km/h | RPMMax=${dadosViagem.estatisticas.rpm_max}`);

  // Salvar dados
  salvarDados();
}

// Iniciar monitoramento
async function iniciar() {
  log('='.repeat(60));
  log(`MONITOR DE VIAGEM INICIADO`);
  log(`Dispositivo: ${IMEI}`);
  log(`Intervalo: ${INTERVALO_COLETA/1000}s`);
  log(`Arquivos:`);
  log(`  - Dados: ${DADOS_FILE}`);
  log(`  - Log: ${LOG_FILE}`);
  log('='.repeat(60));
  log('Aguardando dados... (Ctrl+C para parar)');
  log('');

  // Primeira coleta
  await coletarDados();

  // Loop de coleta
  setInterval(coletarDados, INTERVALO_COLETA);
}

// Tratamento de encerramento
process.on('SIGINT', () => {
  log('');
  log('='.repeat(60));
  log('MONITORAMENTO ENCERRADO');
  log(`Duração: ${dadosViagem.estatisticas.duracao_minutos} minutos`);
  log(`Pontos coletados: ${dadosViagem.estatisticas.pontos_coletados}`);
  log(`Distância total: ${dadosViagem.estatisticas.distancia_total.toFixed(2)} km`);
  log(`Velocidade máxima: ${dadosViagem.estatisticas.velocidade_max} km/h`);
  log(`Velocidade média: ${dadosViagem.estatisticas.velocidade_media} km/h`);
  log(`RPM máximo: ${dadosViagem.estatisticas.rpm_max}`);
  log(`RPM médio: ${dadosViagem.estatisticas.rpm_media}`);
  log(`Temperatura máxima: ${dadosViagem.estatisticas.temperatura_max}°C`);
  log('='.repeat(60));
  salvarDados();
  process.exit(0);
});

// Iniciar
iniciar();
