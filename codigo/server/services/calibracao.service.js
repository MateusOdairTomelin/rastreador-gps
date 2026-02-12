/**
 * Serviço de Auto-Calibração de Tensão
 *
 * Analisa o histórico de tensões de um dispositivo e:
 * 1. Calcula thresholds ideais baseados no uso real
 * 2. Sugere ajustes quando detecta discrepância
 * 3. Detecta anomalias (bateria fraca, alternador com problema)
 *
 * Fluxo:
 * - Dispositivo cadastrado com perfil inicial (MODERNO, ANTIGO, etc.)
 * - Após 48h de uso, sistema analisa dados e sugere calibração
 * - Usuário pode aceitar sugestão ou manter configuração manual
 */

const prisma = require('../db/prisma');

const {
  CALIBRATION_STATUS,
  CALIBRATION_CONFIG,
  calculateSuggestedThresholds,
  shouldSuggestCalibration,
  getVehicleProfile,
  getVoltageThresholds,
  validateVoltageForProfile,
} = require('../constants/vehicle-profiles');

/**
 * Inicia o processo de calibração para um dispositivo
 * Chamado automaticamente quando um dispositivo é cadastrado com perfil
 * @param {string} imei - IMEI do dispositivo
 */
async function iniciarCalibracao(imei) {
  try {
    await prisma.dispositivo.update({
      where: { imei },
      data: {
        calibracao_status: CALIBRATION_STATUS.EM_APRENDIZADO,
        calibracao_inicio: new Date(),
        tensao_sugerida_on: null,
        tensao_sugerida_off: null,
        calibracao_confianca: null,
      },
    });

    console.log(`[Calibracao] Iniciada calibração para dispositivo ${imei}`);
  } catch (error) {
    console.error(`[Calibracao] Erro ao iniciar calibração: ${error.message}`);
    throw error;
  }
}

/**
 * Coleta amostras de tensão para calibração
 * @param {string} imei - IMEI do dispositivo
 * @param {number} horasAtras - Quantas horas de histórico analisar (padrão: 48)
 * @returns {array} Array de { tensao, ignicao, timestamp }
 */
async function coletarAmostras(imei, horasAtras = 48) {
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    throw new Error('Dispositivo não encontrado');
  }

  const dataLimite = new Date();
  dataLimite.setHours(dataLimite.getHours() - horasAtras);

  // Buscar dados OBD2 com tensão principal
  const dadosOBD2 = await prisma.dadosOBD2.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataLimite },
      tensao_principal: { not: null },
    },
    select: {
      tensao_principal: true,
      ignicao: true,
      timestamp: true,
    },
    orderBy: { timestamp: 'asc' },
  });

  return dadosOBD2.map(d => ({
    tensao: d.tensao_principal,
    ignicao: d.ignicao,
    timestamp: d.timestamp,
  }));
}

/**
 * Processa calibração para um dispositivo
 * Analisa dados e atualiza status/sugestões
 * @param {string} imei - IMEI do dispositivo
 * @returns {object} Resultado da calibração
 */
async function processarCalibracao(imei) {
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    throw new Error('Dispositivo não encontrado');
  }

  // Verificar se passou tempo mínimo desde início
  if (dispositivo.calibracao_inicio) {
    const horasDesdeInicio = (Date.now() - dispositivo.calibracao_inicio.getTime()) / (1000 * 60 * 60);
    if (horasDesdeInicio < CALIBRATION_CONFIG.periodoMinimoHoras) {
      return {
        status: 'aguardando',
        mensagem: `Aguardando período mínimo de ${CALIBRATION_CONFIG.periodoMinimoHoras}h. Faltam ${Math.ceil(CALIBRATION_CONFIG.periodoMinimoHoras - horasDesdeInicio)}h.`,
        horasRestantes: Math.ceil(CALIBRATION_CONFIG.periodoMinimoHoras - horasDesdeInicio),
      };
    }
  }

  // Coletar amostras
  const amostras = await coletarAmostras(imei, CALIBRATION_CONFIG.periodoMinimoHoras);

  if (amostras.length < CALIBRATION_CONFIG.amostrasMinimas * 2) {
    return {
      status: 'dados_insuficientes',
      mensagem: `Dados insuficientes. Coletadas ${amostras.length} amostras, necessárias ${CALIBRATION_CONFIG.amostrasMinimas * 2}.`,
      amostrasColetadas: amostras.length,
      amostrasNecessarias: CALIBRATION_CONFIG.amostrasMinimas * 2,
    };
  }

  // Calcular thresholds sugeridos
  const sugestao = calculateSuggestedThresholds(amostras);

  if (!sugestao) {
    return {
      status: 'calculo_falhou',
      mensagem: 'Não foi possível calcular thresholds. Verifique se o veículo foi usado normalmente.',
    };
  }

  // Verificar se deve sugerir ajuste
  const configuradoAtual = {
    tensao_motor_ligado: dispositivo.tensao_motor_ligado,
    tensao_motor_deslig: dispositivo.tensao_motor_deslig,
  };

  const deveSugerir = shouldSuggestCalibration(configuradoAtual, sugestao);

  // Atualizar dispositivo com sugestão
  const novoStatus = deveSugerir
    ? CALIBRATION_STATUS.SUGESTAO_DISPONIVEL
    : CALIBRATION_STATUS.CALIBRADO;

  await prisma.dispositivo.update({
    where: { imei },
    data: {
      calibracao_status: novoStatus,
      tensao_sugerida_on: sugestao.tensao_motor_ligado,
      tensao_sugerida_off: sugestao.tensao_motor_deslig,
      calibracao_confianca: sugestao.confianca,
    },
  });

  const resultado = {
    status: deveSugerir ? 'sugestao_disponivel' : 'calibrado',
    sugestao: {
      tensao_motor_ligado: sugestao.tensao_motor_ligado,
      tensao_motor_deslig: sugestao.tensao_motor_deslig,
      confianca: sugestao.confianca,
    },
    atual: configuradoAtual,
    estatisticas: sugestao.estatisticas,
    deveSugerir,
    mensagem: deveSugerir
      ? `Detectamos que seu veículo opera com tensões diferentes do configurado. Sugerimos ajustar para ${sugestao.tensao_motor_ligado}V (ligado) e ${sugestao.tensao_motor_deslig}V (desligado).`
      : 'Calibração confirmada. Os valores atuais estão adequados para seu veículo.',
  };

  console.log(`[Calibracao] ${imei}: ${resultado.mensagem}`);
  return resultado;
}

/**
 * Aplica a sugestão de calibração
 * @param {string} imei - IMEI do dispositivo
 * @returns {object} Novo estado do dispositivo
 */
async function aplicarSugestao(imei) {
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    throw new Error('Dispositivo não encontrado');
  }

  if (!dispositivo.tensao_sugerida_on || !dispositivo.tensao_sugerida_off) {
    throw new Error('Não há sugestão disponível para aplicar');
  }

  const resultado = await prisma.dispositivo.update({
    where: { imei },
    data: {
      tensao_motor_ligado: dispositivo.tensao_sugerida_on,
      tensao_motor_deslig: dispositivo.tensao_sugerida_off,
      calibracao_status: CALIBRATION_STATUS.CALIBRADO,
      perfil_veiculo: 'PERSONALIZADO', // Marcar como personalizado após aplicar sugestão
    },
    select: {
      imei: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      calibracao_status: true,
      perfil_veiculo: true,
    },
  });

  console.log(`[Calibracao] ${imei}: Sugestão aplicada - ON: ${resultado.tensao_motor_ligado}V, OFF: ${resultado.tensao_motor_deslig}V`);
  return resultado;
}

/**
 * Rejeita a sugestão e mantém configuração atual
 * @param {string} imei - IMEI do dispositivo
 * @returns {object} Novo estado do dispositivo
 */
async function rejeitarSugestao(imei) {
  const resultado = await prisma.dispositivo.update({
    where: { imei },
    data: {
      calibracao_status: CALIBRATION_STATUS.CALIBRADO,
      tensao_sugerida_on: null,
      tensao_sugerida_off: null,
      calibracao_confianca: null,
    },
    select: {
      imei: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      calibracao_status: true,
    },
  });

  console.log(`[Calibracao] ${imei}: Sugestão rejeitada, mantendo configuração atual`);
  return resultado;
}

/**
 * Define perfil de veículo e aplica thresholds correspondentes
 * @param {string} imei - IMEI do dispositivo
 * @param {string} perfilId - ID do perfil (MODERNO, ANTIGO, etc.)
 * @param {number|null} anoVeiculo - Ano do veículo (opcional)
 * @param {object|null} valoresCustom - Valores customizados para perfil PERSONALIZADO
 * @returns {object} Novo estado do dispositivo
 */
async function definirPerfil(imei, perfilId, anoVeiculo = null, valoresCustom = null) {
  const perfil = getVehicleProfile(perfilId);

  if (!perfil) {
    throw new Error(`Perfil "${perfilId}" não encontrado`);
  }

  const thresholds = getVoltageThresholds(perfilId, valoresCustom);

  const resultado = await prisma.dispositivo.update({
    where: { imei },
    data: {
      perfil_veiculo: perfilId,
      ano_veiculo: anoVeiculo,
      tensao_motor_ligado: thresholds.tensao_motor_ligado,
      tensao_motor_deslig: thresholds.tensao_motor_deslig,
      calibracao_status: CALIBRATION_STATUS.EM_APRENDIZADO,
      calibracao_inicio: new Date(),
      tensao_sugerida_on: null,
      tensao_sugerida_off: null,
      calibracao_confianca: null,
    },
    select: {
      imei: true,
      perfil_veiculo: true,
      ano_veiculo: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      calibracao_status: true,
    },
  });

  console.log(`[Calibracao] ${imei}: Perfil definido como ${perfilId} (ano: ${anoVeiculo || 'N/A'}) - ON: ${thresholds.tensao_motor_ligado}V, OFF: ${thresholds.tensao_motor_deslig}V`);
  return resultado;
}

/**
 * Obtém status atual da calibração
 * @param {string} imei - IMEI do dispositivo
 * @returns {object} Status da calibração
 */
async function getStatusCalibracao(imei) {
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    select: {
      imei: true,
      perfil_veiculo: true,
      ano_veiculo: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      calibracao_status: true,
      calibracao_inicio: true,
      tensao_sugerida_on: true,
      tensao_sugerida_off: true,
      calibracao_confianca: true,
    },
  });

  if (!dispositivo) {
    throw new Error('Dispositivo não encontrado');
  }

  // Calcular tempo restante se em aprendizado
  let tempoRestante = null;
  if (dispositivo.calibracao_status === CALIBRATION_STATUS.EM_APRENDIZADO && dispositivo.calibracao_inicio) {
    const horasDesdeInicio = (Date.now() - dispositivo.calibracao_inicio.getTime()) / (1000 * 60 * 60);
    if (horasDesdeInicio < CALIBRATION_CONFIG.periodoMinimoHoras) {
      tempoRestante = Math.ceil(CALIBRATION_CONFIG.periodoMinimoHoras - horasDesdeInicio);
    }
  }

  // Obter info do perfil
  const perfil = dispositivo.perfil_veiculo ? getVehicleProfile(dispositivo.perfil_veiculo) : null;

  return {
    ...dispositivo,
    perfilInfo: perfil ? {
      nome: perfil.nome,
      descricao: perfil.descricao,
    } : null,
    tempoRestanteHoras: tempoRestante,
    temSugestao: dispositivo.calibracao_status === CALIBRATION_STATUS.SUGESTAO_DISPONIVEL,
  };
}

/**
 * Detecta anomalias de tensão (bateria fraca, alternador com problema)
 * @param {string} imei - IMEI do dispositivo
 * @returns {object} Diagnóstico de anomalias
 */
async function detectarAnomalias(imei) {
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo || !dispositivo.perfil_veiculo) {
    return { anomalias: [], status: 'sem_perfil' };
  }

  // Buscar últimas 24h de dados
  const amostras = await coletarAmostras(imei, 24);

  if (amostras.length < 10) {
    return { anomalias: [], status: 'dados_insuficientes' };
  }

  const anomalias = [];
  const perfil = getVehicleProfile(dispositivo.perfil_veiculo);

  // Separar amostras por estado
  const tensaoLigado = amostras.filter(a => a.ignicao).map(a => a.tensao);
  const tensaoDesligado = amostras.filter(a => !a.ignicao).map(a => a.tensao);

  // Verificar tensão quando ligado
  if (tensaoLigado.length > 0) {
    const mediaLigado = tensaoLigado.reduce((a, b) => a + b, 0) / tensaoLigado.length;
    const validacao = validateVoltageForProfile(dispositivo.perfil_veiculo, mediaLigado, 'ligado');

    if (!validacao.valido) {
      anomalias.push({
        tipo: 'TENSAO_ANORMAL_LIGADO',
        severidade: mediaLigado < (perfil?.tensao_media_esperada?.ligado?.min || 12) ? 'alta' : 'media',
        mensagem: validacao.mensagem,
        valor: mediaLigado,
        esperado: perfil?.tensao_media_esperada?.ligado,
      });
    }
  }

  // Verificar tensão quando desligado
  if (tensaoDesligado.length > 0) {
    const mediaDesligado = tensaoDesligado.reduce((a, b) => a + b, 0) / tensaoDesligado.length;
    const validacao = validateVoltageForProfile(dispositivo.perfil_veiculo, mediaDesligado, 'desligado');

    if (!validacao.valido) {
      anomalias.push({
        tipo: 'TENSAO_ANORMAL_DESLIGADO',
        severidade: mediaDesligado < 11.5 ? 'alta' : 'media',
        mensagem: validacao.mensagem,
        valor: mediaDesligado,
        esperado: perfil?.tensao_media_esperada?.desligado,
      });
    }

    // Alerta de bateria fraca
    if (mediaDesligado < 11.8) {
      anomalias.push({
        tipo: 'BATERIA_FRACA',
        severidade: mediaDesligado < 11.5 ? 'critica' : 'alta',
        mensagem: `Tensão de bateria muito baixa (${mediaDesligado.toFixed(1)}V). Bateria pode estar descarregando ou com defeito.`,
        valor: mediaDesligado,
      });
    }
  }

  return {
    anomalias,
    status: anomalias.length > 0 ? 'anomalias_detectadas' : 'ok',
    estatisticas: {
      amostrasAnalisadas: amostras.length,
      periodoHoras: 24,
    },
  };
}

/**
 * Processa calibração para todos os dispositivos pendentes
 * Executar via cron job (ex: a cada 6 horas)
 */
async function processarCalibracoesPendentes() {
  const dispositivos = await prisma.dispositivo.findMany({
    where: {
      calibracao_status: CALIBRATION_STATUS.EM_APRENDIZADO,
      calibracao_inicio: {
        lte: new Date(Date.now() - CALIBRATION_CONFIG.periodoMinimoHoras * 60 * 60 * 1000),
      },
    },
    select: { imei: true },
  });

  console.log(`[Calibracao] Processando ${dispositivos.length} dispositivos pendentes...`);

  const resultados = [];
  for (const { imei } of dispositivos) {
    try {
      const resultado = await processarCalibracao(imei);
      resultados.push({ imei, ...resultado });
    } catch (error) {
      console.error(`[Calibracao] Erro ao processar ${imei}: ${error.message}`);
      resultados.push({ imei, status: 'erro', mensagem: error.message });
    }
  }

  return resultados;
}

module.exports = {
  iniciarCalibracao,
  coletarAmostras,
  processarCalibracao,
  aplicarSugestao,
  rejeitarSugestao,
  definirPerfil,
  getStatusCalibracao,
  detectarAnomalias,
  processarCalibracoesPendentes,
};
