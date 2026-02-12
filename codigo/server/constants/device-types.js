/**
 * Constantes de tipos de dispositivos suportados
 *
 * Referência:
 * - XT40 Protocol Rev 1.06 (GT06-based) - Porta 8877/8878
 * - Teltonika Codec 8/8E/12/16 Protocol - Porta 8879
 */

const { getVoltageThresholds, suggestProfileByYear } = require('./vehicle-profiles');

const DEVICE_TYPES = {
  // ============================================
  // TELTONIKA DEVICES - Protocolo Codec 8/8E
  // Porta TCP: 8879
  // ============================================

  // Teltonika FMC920 - 4G LTE Cat 1 M1, compacto
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMC920: {
    id: 'TELTONIKA_FMC920',
    nome: 'Teltonika FMC920',
    descricao: 'Rastreador 4G LTE Cat 1 M1 compacto com backup de bateria',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMC920/i,
    homologado: true,
  },

  // Teltonika FMC800 - 4G LTE Cat 1 para equipamentos pesados
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMC800: {
    id: 'TELTONIKA_FMC800',
    nome: 'Teltonika FMC800',
    descricao: 'Rastreador 4G LTE Cat 1 para equipamentos pesados e frotas',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMC800/i,
    homologado: true,
  },

  // Teltonika FMB920 - 2G GPRS, modelo compacto popular
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMB920: {
    id: 'TELTONIKA_FMB920',
    nome: 'Teltonika FMB920',
    descricao: 'Rastreador 2G GPRS compacto com Bluetooth',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMB920/i,
    homologado: true,
  },

  // Teltonika FMB125 - 2G GPRS com antenas internas
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMB125: {
    id: 'TELTONIKA_FMB125',
    nome: 'Teltonika FMB125',
    descricao: 'Rastreador 2G GPRS com antenas internas GPS/GNSS',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMB125/i,
    homologado: true,
  },

  // Teltonika FMB130 - 2G GPRS avançado
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMB130: {
    id: 'TELTONIKA_FMB130',
    nome: 'Teltonika FMB130',
    descricao: 'Rastreador 2G GPRS avançado com CAN bus',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: true,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMB130/i,
    homologado: true,
  },

  // Teltonika FMT100 - 4G LTE básico
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMT100: {
    id: 'TELTONIKA_FMT100',
    nome: 'Teltonika FMT100',
    descricao: 'Rastreador 4G LTE básico - entrada de nível',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMT100/i,
    homologado: true,
  },

  // Teltonika FMC130 - 4G LTE avançado com CAN
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMC130: {
    id: 'TELTONIKA_FMC130',
    nome: 'Teltonika FMC130',
    descricao: 'Rastreador 4G LTE avançado com CAN bus e Bluetooth',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: true,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMC130/i,
    homologado: true,
  },

  // Teltonika FMC640 - 4G LTE Cat 1 avançado com mais I/O
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  TELTONIKA_FMC640: {
    id: 'TELTONIKA_FMC640',
    nome: 'Teltonika FMC640',
    descricao: 'Rastreador 4G LTE Cat 1 avançado com múltiplas I/O',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /FMC640/i,
    homologado: true,
  },

  // Teltonika Genérico - para modelos não identificados
  TELTONIKA_GENERIC: {
    id: 'TELTONIKA_GENERIC',
    nome: 'Teltonika (Outro modelo)',
    descricao: 'Rastreador Teltonika - modelo genérico',
    conexao: 'cabo',
    protocolo: 'teltonika',
    porta_tcp: 8879,
    suporta_obd2: false,
    usa_ignicao_virtual: false,
    firmware_pattern: /TELTONIKA|FMB|FMC|FMT|FM[A-Z]/i,
    homologado: true,
  },

  // ============================================
  // XT40 DEVICES - Protocolo GT06-based
  // Porta TCP: 8877/8878
  // ============================================

  // XT40-OBDII - Conecta via porta OBD2 (apenas alimentação, NÃO lê dados da ECU)
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  // ⚠️ IMPORTANTE: Este modelo NÃO lê dados OBD2 reais (RPM, temp, etc.)
  //    Ele apenas usa o conector OBD2 para alimentação (pinos 4, 5, 16)
  //    A detecção de ignição usa o bit ACC do terminal info (confiável)
  XT40_OBD2: {
    id: 'XT40_OBD2',
    nome: 'XT40 OBD-II',
    descricao: 'Rastreador com conexão OBD2 (alimentação) - Usa ACC para ignição',
    conexao: 'obd2',
    suporta_obd2: false, // NÃO lê dados OBD2 reais - apenas alimentação
    usa_ignicao_virtual: false, // USA o bit ACC do dispositivo (mais confiável)
    firmware_pattern: /OBD2_ECU|OBD_REAL|OBDII/i,
    homologado: true, // ✅ HOMOLOGADO
  },

  // XT40-4F - Conecta via cabo (4 fios), sem diagnóstico OBD2
  // ✅ HOMOLOGADO - Disponível para seleção na dashboard
  // ✅ Usa lógica HÍBRIDA: pós-chave + tensão (ACC não é confiável neste modelo)
  XT40_4F: {
    id: 'XT40_4F',
    nome: 'XT40 Cabo (4F)',
    descricao: 'Rastreador com conexão via cabo - Sem diagnóstico OBD2',
    conexao: 'cabo',
    suporta_obd2: false,
    usa_ignicao_virtual: false,  // NÃO usa ignição virtual pura
    conexao_pos_chave: true,     // USA lógica híbrida (pós-chave + tensão)
    tensao_motor_ligado: 12.8,   // Threshold: motor ligado >= 12.8V
    tensao_motor_deslig: 12.4,   // Threshold: motor desligado < 12.4V
    firmware_pattern: /^(?!.*OBDII).*(BX1|4F|CABLE)/i,
    homologado: true, // ✅ HOMOLOGADO
  },

  // XT40-PERSONAL - Rastreador pessoal portátil
  XT40_PERSONAL: {
    id: 'XT40_PERSONAL',
    nome: 'XT40 Personal',
    descricao: 'Rastreador pessoal portátil',
    conexao: 'bateria',
    suporta_obd2: false,
    firmware_pattern: /PERSONAL|PER/i,
    homologado: false, // Não homologado
  },

  // XT40-PORTABLE - Rastreador portátil com bateria
  XT40_PORTABLE: {
    id: 'XT40_PORTABLE',
    nome: 'XT40 Portable',
    descricao: 'Rastreador portátil com bateria',
    conexao: 'bateria',
    suporta_obd2: false,
    firmware_pattern: /PORTABLE|PORT/i,
    homologado: false, // Não homologado
  },

  // Tipo genérico para dispositivos não identificados
  // ✅ PADRÃO SEGURO: usa lógica híbrida (pós-chave + tensão) para garantir
  // que novos dispositivos funcionem corretamente até serem configurados
  XT40_UNKNOWN: {
    id: 'XT40_UNKNOWN',
    nome: 'XT40 (Não identificado)',
    descricao: 'Modelo XT40 não identificado - Configure o tipo correto',
    conexao: 'desconhecido',
    suporta_obd2: false,
    usa_ignicao_virtual: false,  // NÃO usa ignição virtual pura
    conexao_pos_chave: true,     // USA lógica híbrida por padrão
    tensao_motor_ligado: 12.8,   // Threshold padrão seguro
    tensao_motor_deslig: 12.4,   // Threshold padrão seguro
    firmware_pattern: null,
    homologado: false, // Não disponível para seleção manual
  },
};

/**
 * Detecta o tipo de dispositivo baseado na string de firmware
 * IMPORTANTE: A ordem de verificação importa! Tipos mais específicos devem vir primeiro.
 * @param {string} firmwareVersion - Versão do firmware (ex: "HA1617_XT40_OBDII_CAT1_BX1_V1.0.0_250120.093957")
 * @returns {string} ID do tipo de dispositivo (ex: "XT40_OBD2", "XT40_4F")
 */
function detectDeviceType(firmwareVersion) {
  if (!firmwareVersion || typeof firmwareVersion !== 'string') {
    return DEVICE_TYPES.XT40_UNKNOWN.id;
  }

  // Ordem de prioridade para detecção (mais específicos primeiro)
  const priorityOrder = [
    // Teltonika - modelos específicos primeiro
    'TELTONIKA_FMC920',
    'TELTONIKA_FMC800',
    'TELTONIKA_FMB920',
    'TELTONIKA_FMB125',
    'TELTONIKA_FMB130',
    'TELTONIKA_FMT100',
    'TELTONIKA_FMC130',
    'TELTONIKA_FMC640',
    'TELTONIKA_GENERIC', // Genérico Teltonika por último
    // XT40 - modelos específicos
    'XT40_4F',          // BX1/4F sem OBDII = cabo
    'XT40_OBD2',        // OBD2 com ECU real
    'XT40_PERSONAL',
    'XT40_PORTABLE',
    'XT40_UNKNOWN',
  ];

  // Verificar na ordem de prioridade
  for (const typeId of priorityOrder) {
    const typeInfo = DEVICE_TYPES[typeId];
    if (typeInfo && typeInfo.firmware_pattern && typeInfo.firmware_pattern.test(firmwareVersion)) {
      console.log(`[DeviceType] Firmware "${firmwareVersion}" → Tipo: ${typeId} (${typeInfo.nome})`);
      return typeId;
    }
  }

  // Se não encontrou, retornar desconhecido
  console.log(`[DeviceType] Firmware "${firmwareVersion}" não identificado → XT40_UNKNOWN`);
  return DEVICE_TYPES.XT40_UNKNOWN.id;
}

/**
 * Obtém informações completas de um tipo de dispositivo
 * @param {string} typeId - ID do tipo (ex: "XT40_4F")
 * @returns {object|null} Informações do tipo ou null se não existir
 */
function getDeviceTypeInfo(typeId) {
  return DEVICE_TYPES[typeId] || null;
}

/**
 * Verifica se um tipo de dispositivo suporta OBD2
 * @param {string} typeId - ID do tipo
 * @returns {boolean} true se suporta OBD2
 */
function supportsOBD2(typeId) {
  const info = DEVICE_TYPES[typeId];
  return info ? info.suporta_obd2 : false;
}

/**
 * Verifica se um tipo de dispositivo usa ignição virtual (por tensão/movimento)
 * @param {string} typeId - ID do tipo
 * @returns {boolean} true se usa ignição virtual
 */
function usesVirtualIgnition(typeId) {
  const info = DEVICE_TYPES[typeId];
  return info ? info.usa_ignicao_virtual === true : false;
}

/**
 * Verifica se um tipo de dispositivo usa conexão pós-chave (lógica híbrida)
 * @param {string} typeId - ID do tipo
 * @returns {boolean} true se usa conexão pós-chave
 */
function usesPostKey(typeId) {
  const info = DEVICE_TYPES[typeId];
  return info ? info.conexao_pos_chave === true : true; // Padrão: true
}

/**
 * Obtém as configurações padrão de um tipo de dispositivo
 * Usado para configurar novos dispositivos automaticamente
 * @param {string} typeId - ID do tipo
 * @param {string|null} perfilVeiculo - Perfil do veículo (MODERNO, ANTIGO, etc.)
 * @param {number|null} anoVeiculo - Ano do veículo (usado para sugerir perfil)
 * @returns {object} Configurações padrão
 */
function getDefaultConfig(typeId, perfilVeiculo = null, anoVeiculo = null) {
  const info = DEVICE_TYPES[typeId] || DEVICE_TYPES.XT40_UNKNOWN;

  // Se forneceu perfil ou ano, usar thresholds do perfil
  let thresholds;
  if (perfilVeiculo) {
    thresholds = getVoltageThresholds(perfilVeiculo);
  } else if (anoVeiculo) {
    const perfilSugerido = suggestProfileByYear(anoVeiculo);
    thresholds = getVoltageThresholds(perfilSugerido);
  } else {
    // Usar defaults do tipo de dispositivo
    thresholds = {
      tensao_motor_ligado: info.tensao_motor_ligado || 12.8,
      tensao_motor_deslig: info.tensao_motor_deslig || 12.4,
    };
  }

  return {
    usa_ignicao_virtual: info.usa_ignicao_virtual || false,
    conexao_pos_chave: info.conexao_pos_chave !== false, // true por padrão
    tensao_motor_ligado: thresholds.tensao_motor_ligado,
    tensao_motor_deslig: thresholds.tensao_motor_deslig,
    perfil_veiculo: perfilVeiculo || (anoVeiculo ? suggestProfileByYear(anoVeiculo) : null),
    ano_veiculo: anoVeiculo,
  };
}

/**
 * Lista todos os tipos de dispositivos disponíveis
 * @returns {array} Lista de tipos com id, nome e descrição
 */
function getAllDeviceTypes() {
  return Object.values(DEVICE_TYPES).map(type => ({
    id: type.id,
    nome: type.nome,
    descricao: type.descricao,
    conexao: type.conexao,
    suporta_obd2: type.suporta_obd2,
    homologado: type.homologado || false,
  }));
}

/**
 * Lista apenas os tipos de dispositivos HOMOLOGADOS
 * Estes são os tipos disponíveis para seleção na dashboard
 * @returns {array} Lista de tipos homologados
 */
function getHomologatedDeviceTypes() {
  return Object.values(DEVICE_TYPES)
    .filter(type => type.homologado === true)
    .map(type => ({
      id: type.id,
      nome: type.nome,
      descricao: type.descricao,
      conexao: type.conexao,
      suporta_obd2: type.suporta_obd2,
      protocolo: type.protocolo || 'gt06',
      porta_tcp: type.porta_tcp || 8877,
    }));
}

/**
 * Obtém a porta TCP para um tipo de dispositivo
 * @param {string} typeId - ID do tipo
 * @returns {number} Porta TCP (8879 para Teltonika, 8877 para XT40/GT06)
 */
function getTcpPort(typeId) {
  const info = DEVICE_TYPES[typeId];
  return info?.porta_tcp || 8877;
}

/**
 * Obtém o protocolo de um tipo de dispositivo
 * @param {string} typeId - ID do tipo
 * @returns {string} Protocolo ('teltonika' ou 'gt06')
 */
function getProtocol(typeId) {
  const info = DEVICE_TYPES[typeId];
  return info?.protocolo || 'gt06';
}

module.exports = {
  DEVICE_TYPES,
  detectDeviceType,
  getDeviceTypeInfo,
  supportsOBD2,
  usesVirtualIgnition,
  usesPostKey,
  getDefaultConfig,
  getAllDeviceTypes,
  getHomologatedDeviceTypes,
  getTcpPort,
  getProtocol,
};
