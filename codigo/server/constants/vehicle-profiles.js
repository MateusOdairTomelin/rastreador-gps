/**
 * Perfis de Veículos para Calibração de Tensão
 *
 * Define thresholds de tensão para diferentes tipos/anos de veículos.
 * Carros modernos têm alternadores mais eficientes que mantêm tensões mais altas.
 * Carros antigos operam em tensões mais baixas.
 *
 * Uso: Ao cadastrar um dispositivo, selecionar o perfil apropriado para
 * aplicar automaticamente os thresholds de tensão corretos.
 */

const VEHICLE_PROFILES = {
  // Veículos modernos (2015+) - Alternadores eficientes, sistemas elétricos robustos
  MODERNO: {
    id: 'MODERNO',
    nome: 'Veículo Moderno (2015+)',
    descricao: 'Carros a partir de 2015 com sistema elétrico moderno',
    anoMin: 2015,
    anoMax: null,
    tensao_motor_ligado: 13.2,   // Motor ligado >= 13.2V
    tensao_motor_deslig: 12.8,   // Motor desligado < 12.8V
    tensao_media_esperada: {
      ligado: { min: 13.0, max: 14.5 },
      desligado: { min: 12.0, max: 12.8 },
    },
    exemplos: ['HB20 2024', 'Onix 2023', 'Argo 2022', 'Polo 2020'],
  },

  // Veículos intermediários (2008-2014) - Transição entre gerações
  INTERMEDIARIO: {
    id: 'INTERMEDIARIO',
    nome: 'Veículo Intermediário (2008-2014)',
    descricao: 'Carros entre 2008 e 2014',
    anoMin: 2008,
    anoMax: 2014,
    tensao_motor_ligado: 12.8,   // Motor ligado >= 12.8V
    tensao_motor_deslig: 12.4,   // Motor desligado < 12.4V
    tensao_media_esperada: {
      ligado: { min: 12.6, max: 14.2 },
      desligado: { min: 11.8, max: 12.5 },
    },
    exemplos: ['Gol G5 2012', 'Corsa 2010', 'Fiesta 2009'],
  },

  // Veículos antigos (até 2007) - Sistemas elétricos mais simples
  ANTIGO: {
    id: 'ANTIGO',
    nome: 'Veículo Antigo (até 2007)',
    descricao: 'Carros até 2007 com sistema elétrico básico',
    anoMin: null,
    anoMax: 2007,
    tensao_motor_ligado: 12.4,   // Motor ligado >= 12.4V
    tensao_motor_deslig: 12.0,   // Motor desligado < 12.0V
    tensao_media_esperada: {
      ligado: { min: 12.2, max: 14.0 },
      desligado: { min: 11.5, max: 12.2 },
    },
    exemplos: ['Uno 2007', 'Gol G4 2005', 'Palio 2003'],
  },

  // Veículos diesel - Alternadores maiores, tensões mais altas
  DIESEL: {
    id: 'DIESEL',
    nome: 'Veículo Diesel',
    descricao: 'Caminhões, pickups e utilitários diesel',
    anoMin: null,
    anoMax: null,
    tensao_motor_ligado: 13.5,   // Motor ligado >= 13.5V
    tensao_motor_deslig: 13.0,   // Motor desligado < 13.0V
    tensao_media_esperada: {
      ligado: { min: 13.2, max: 14.8 },
      desligado: { min: 12.2, max: 13.0 },
    },
    exemplos: ['Hilux', 'S10 Diesel', 'Amarok', 'Ranger'],
  },

  // Veículos 24V (caminhões pesados)
  CAMINHAO_24V: {
    id: 'CAMINHAO_24V',
    nome: 'Caminhão 24V',
    descricao: 'Caminhões pesados com sistema 24V',
    anoMin: null,
    anoMax: null,
    tensao_motor_ligado: 26.0,   // Motor ligado >= 26.0V
    tensao_motor_deslig: 25.0,   // Motor desligado < 25.0V
    tensao_media_esperada: {
      ligado: { min: 25.5, max: 29.0 },
      desligado: { min: 24.0, max: 25.5 },
    },
    exemplos: ['Scania', 'Volvo FH', 'Mercedes Actros'],
  },

  // Perfil personalizado - valores definidos manualmente
  PERSONALIZADO: {
    id: 'PERSONALIZADO',
    nome: 'Personalizado',
    descricao: 'Valores configurados manualmente pelo usuário',
    anoMin: null,
    anoMax: null,
    tensao_motor_ligado: null,   // Definido pelo usuário
    tensao_motor_deslig: null,   // Definido pelo usuário
    tensao_media_esperada: null,
    exemplos: [],
  },
};

// Status de calibração automática
const CALIBRATION_STATUS = {
  PENDENTE: 'PENDENTE',           // Aguardando dados suficientes
  EM_APRENDIZADO: 'EM_APRENDIZADO', // Coletando dados (primeiras 48h)
  CALIBRADO: 'CALIBRADO',         // Calibração manual ou auto completa
  SUGESTAO_DISPONIVEL: 'SUGESTAO_DISPONIVEL', // Sistema tem sugestão de ajuste
};

// Configurações do algoritmo de auto-calibração
const CALIBRATION_CONFIG = {
  // Período mínimo de coleta de dados antes de sugerir calibração
  periodoMinimoHoras: 48,

  // Número mínimo de amostras por estado (ligado/desligado)
  amostrasMinimas: 50,

  // Diferença mínima de tensão para considerar motor ligado vs desligado
  diferencaMinimaVolts: 0.3,

  // Margem de segurança para evitar falsos positivos
  margemSeguranca: 0.2,

  // Threshold para sugerir ajuste (diferença entre configurado e detectado)
  thresholdSugestao: 0.3,

  // Percentis para cálculo dos thresholds
  // Usa percentil 10 do ligado e percentil 90 do desligado para evitar outliers
  percentilLigado: 10,
  percentilDesligado: 90,
};

/**
 * Obtém o perfil de veículo baseado no ID
 * @param {string} profileId - ID do perfil (MODERNO, INTERMEDIARIO, ANTIGO, etc.)
 * @returns {object|null} Perfil do veículo ou null se não existir
 */
function getVehicleProfile(profileId) {
  return VEHICLE_PROFILES[profileId] || null;
}

/**
 * Sugere um perfil baseado no ano do veículo
 * @param {number} ano - Ano do veículo
 * @returns {string} ID do perfil sugerido
 */
function suggestProfileByYear(ano) {
  if (!ano || typeof ano !== 'number') {
    return 'INTERMEDIARIO'; // Padrão seguro
  }

  if (ano >= 2015) return 'MODERNO';
  if (ano >= 2008) return 'INTERMEDIARIO';
  return 'ANTIGO';
}

/**
 * Obtém os thresholds de tensão para um perfil
 * @param {string} profileId - ID do perfil
 * @param {object} customValues - Valores customizados para perfil PERSONALIZADO
 * @returns {object} { tensao_motor_ligado, tensao_motor_deslig }
 */
function getVoltageThresholds(profileId, customValues = {}) {
  const profile = VEHICLE_PROFILES[profileId];

  if (!profile) {
    // Perfil não encontrado, retorna padrão intermediário
    return {
      tensao_motor_ligado: 12.8,
      tensao_motor_deslig: 12.4,
    };
  }

  if (profileId === 'PERSONALIZADO') {
    // Para perfil personalizado, usa valores fornecidos ou padrão
    return {
      tensao_motor_ligado: customValues.tensao_motor_ligado || 12.8,
      tensao_motor_deslig: customValues.tensao_motor_deslig || 12.4,
    };
  }

  return {
    tensao_motor_ligado: profile.tensao_motor_ligado,
    tensao_motor_deslig: profile.tensao_motor_deslig,
  };
}

/**
 * Lista todos os perfis disponíveis para seleção
 * @returns {array} Lista de perfis com id, nome e descrição
 */
function getAllVehicleProfiles() {
  return Object.values(VEHICLE_PROFILES).map(profile => ({
    id: profile.id,
    nome: profile.nome,
    descricao: profile.descricao,
    anoMin: profile.anoMin,
    anoMax: profile.anoMax,
    tensao_motor_ligado: profile.tensao_motor_ligado,
    tensao_motor_deslig: profile.tensao_motor_deslig,
    exemplos: profile.exemplos,
  }));
}

/**
 * Valida se uma tensão está dentro do esperado para um perfil
 * @param {string} profileId - ID do perfil
 * @param {number} tensao - Tensão em Volts
 * @param {string} estado - 'ligado' ou 'desligado'
 * @returns {object} { valido: boolean, mensagem: string }
 */
function validateVoltageForProfile(profileId, tensao, estado) {
  const profile = VEHICLE_PROFILES[profileId];

  if (!profile || !profile.tensao_media_esperada) {
    return { valido: true, mensagem: 'Perfil sem validação definida' };
  }

  const esperado = profile.tensao_media_esperada[estado];
  if (!esperado) {
    return { valido: true, mensagem: 'Estado não validado' };
  }

  if (tensao < esperado.min) {
    return {
      valido: false,
      mensagem: `Tensão ${tensao}V abaixo do esperado para motor ${estado} (mín: ${esperado.min}V). Possível bateria fraca ou perfil incorreto.`,
    };
  }

  if (tensao > esperado.max) {
    return {
      valido: false,
      mensagem: `Tensão ${tensao}V acima do esperado para motor ${estado} (máx: ${esperado.max}V). Possível alternador com problema ou perfil incorreto.`,
    };
  }

  return { valido: true, mensagem: 'Tensão dentro do esperado' };
}

/**
 * Calcula thresholds sugeridos baseado em dados históricos
 * @param {array} amostras - Array de { tensao: number, ignicao: boolean }
 * @returns {object|null} { tensao_motor_ligado, tensao_motor_deslig, confianca } ou null se dados insuficientes
 */
function calculateSuggestedThresholds(amostras) {
  if (!amostras || amostras.length < CALIBRATION_CONFIG.amostrasMinimas * 2) {
    return null; // Dados insuficientes
  }

  // Separar amostras por estado de ignição
  const tensaoLigado = amostras.filter(a => a.ignicao === true).map(a => a.tensao);
  const tensaoDesligado = amostras.filter(a => a.ignicao === false).map(a => a.tensao);

  if (tensaoLigado.length < CALIBRATION_CONFIG.amostrasMinimas ||
      tensaoDesligado.length < CALIBRATION_CONFIG.amostrasMinimas) {
    return null; // Dados insuficientes em um dos estados
  }

  // Ordenar para cálculo de percentis
  tensaoLigado.sort((a, b) => a - b);
  tensaoDesligado.sort((a, b) => a - b);

  // Calcular percentis para evitar outliers
  const idxLigado = Math.floor(tensaoLigado.length * CALIBRATION_CONFIG.percentilLigado / 100);
  const idxDesligado = Math.floor(tensaoDesligado.length * CALIBRATION_CONFIG.percentilDesligado / 100);

  const minLigado = tensaoLigado[idxLigado];
  const maxDesligado = tensaoDesligado[idxDesligado];

  // Verificar se há separação suficiente entre os estados
  const diferenca = minLigado - maxDesligado;
  if (diferenca < CALIBRATION_CONFIG.diferencaMinimaVolts) {
    return null; // Estados muito próximos, difícil distinguir
  }

  // Calcular thresholds com margem de segurança
  // Threshold ON: ligeiramente abaixo do mínimo observado quando ligado
  // Threshold OFF: ligeiramente acima do máximo observado quando desligado
  const tensao_motor_ligado = minLigado - CALIBRATION_CONFIG.margemSeguranca;
  const tensao_motor_deslig = maxDesligado + CALIBRATION_CONFIG.margemSeguranca;

  // Calcular confiança baseada na separação dos estados
  const confianca = Math.min(1, diferenca / 1.0); // 1.0V de diferença = 100% confiança

  return {
    tensao_motor_ligado: Math.round(tensao_motor_ligado * 10) / 10, // 1 casa decimal
    tensao_motor_deslig: Math.round(tensao_motor_deslig * 10) / 10,
    confianca: Math.round(confianca * 100) / 100,
    estatisticas: {
      amostrasLigado: tensaoLigado.length,
      amostrasDesligado: tensaoDesligado.length,
      mediaLigado: Math.round(tensaoLigado.reduce((a, b) => a + b, 0) / tensaoLigado.length * 10) / 10,
      mediaDesligado: Math.round(tensaoDesligado.reduce((a, b) => a + b, 0) / tensaoDesligado.length * 10) / 10,
      separacao: Math.round(diferenca * 10) / 10,
    },
  };
}

/**
 * Verifica se deve sugerir ajuste de calibração
 * @param {object} configurado - { tensao_motor_ligado, tensao_motor_deslig }
 * @param {object} sugerido - Resultado de calculateSuggestedThresholds()
 * @returns {boolean} true se deve sugerir ajuste
 */
function shouldSuggestCalibration(configurado, sugerido) {
  if (!sugerido || sugerido.confianca < 0.7) {
    return false; // Sugestão não confiável
  }

  const diffLigado = Math.abs(configurado.tensao_motor_ligado - sugerido.tensao_motor_ligado);
  const diffDesligado = Math.abs(configurado.tensao_motor_deslig - sugerido.tensao_motor_deslig);

  return diffLigado > CALIBRATION_CONFIG.thresholdSugestao ||
         diffDesligado > CALIBRATION_CONFIG.thresholdSugestao;
}

module.exports = {
  VEHICLE_PROFILES,
  CALIBRATION_STATUS,
  CALIBRATION_CONFIG,
  getVehicleProfile,
  suggestProfileByYear,
  getVoltageThresholds,
  getAllVehicleProfiles,
  validateVoltageForProfile,
  calculateSuggestedThresholds,
  shouldSuggestCalibration,
};
