const prisma = require('../db/prisma');
const { DEVICE_TYPES, detectDeviceType, getDeviceTypeInfo, supportsOBD2, usesVirtualIgnition, usesPostKey, getDefaultConfig, getAllDeviceTypes } = require('../constants/device-types');
const { getVoltageThresholds, CALIBRATION_STATUS } = require('../constants/vehicle-profiles');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

class DispositivoService {
  // Expor funções de tipos de dispositivo
  getDeviceTypes() {
    return getAllDeviceTypes();
  }

  getDeviceTypeInfo(typeId) {
    return getDeviceTypeInfo(typeId);
  }

  supportsOBD2(typeId) {
    return supportsOBD2(typeId);
  }

  usesVirtualIgnition(typeId) {
    return usesVirtualIgnition(typeId);
  }

  detectDeviceTypeFromFirmware(firmwareVersion) {
    return detectDeviceType(firmwareVersion);
  }

  // Get all devices with latest location and OBD2 data
  // ✅ Multi-tenant: Filtra por organizacao_id quando fornecido
  async getAll(tenantFilter = {}) {
    return await prisma.dispositivo.findMany({
      where: tenantFilter,
      include: {
        localizacoes: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
        dados_obd2: {
          orderBy: { timestamp: 'desc' },
          take: 2,  // ✅ Buscar 2 para validar se dados estão variando
        },
        motorista: {
          select: {
            id: true,
            nome: true,
            foto_url: true,
            telefone: true,
            cnh_categoria: true,
            cnh_validade: true,
            ativo: true
          }
        }
      },
      orderBy: { updated_at: 'desc' },
    });
  }

  // Get device by IMEI
  async getByImei(imei) {
    return await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
        dados_obd2: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
        motorista: {
          select: {
            id: true,
            nome: true,
            foto_url: true,
            telefone: true,
            cnh_categoria: true,
            cnh_validade: true,
            ativo: true
          }
        }
      },
    });
  }

  // Create or update device (upsert)
  // Nota: Ao criar novo dispositivo, usa XT40_UNKNOWN como tipo padrão
  // O tipo pode ser atualizado posteriormente via API ou detecção de firmware
  // ✅ Configura automaticamente baseado no tipo do dispositivo
  // ✅ PRESERVA organizacao_id de dispositivos pré-cadastrados
  async upsert(imei, data) {
    // Se não tem tipo definido e não existe dispositivo, usa XT40_UNKNOWN
    const existingDevice = await prisma.dispositivo.findUnique({ where: { imei } });
    const defaultType = existingDevice?.tipo || data.tipo || 'XT40_UNKNOWN';

    // ✅ Obter configurações padrão do tipo de dispositivo
    const config = getDefaultConfig(defaultType);

    // ✅ Se dispositivo já existe (pré-cadastrado), apenas atualizar status
    if (existingDevice) {
      // Dispositivo pré-cadastrado conectou! Manter organizacao_id
      if (existingDevice.organizacao_id && existingDevice.status === 'aguardando') {
        console.log(`[Dispositivo] PRÉ-CADASTRADO ${imei} conectou! Vinculado à org ${existingDevice.organizacao_id}`);
      }

      return await prisma.dispositivo.update({
        where: { imei },
        data: {
          // Só atualiza tipo se explicitamente fornecido (não sobrescreve tipo existente)
          ...(data.tipo && data.tipo !== 'XT40_UNKNOWN' && { tipo: data.tipo }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.estado_ignicao !== undefined && { estado_ignicao: data.estado_ignicao }),
          // ✅ NÃO sobrescrever dados já preenchidos (pré-cadastro)
          ...(data.placa && !existingDevice.placa && { placa: data.placa }),
          ...(data.veiculo && !existingDevice.veiculo && { veiculo: data.veiculo }),
          ...(data.operadora && !existingDevice.operadora && { operadora: data.operadora }),
          ...(data.imei_chip && !existingDevice.imei_chip && { imei_chip: data.imei_chip }),
          ...(data.telefone_chip && !existingDevice.telefone_chip && { telefone_chip: data.telefone_chip }),
          ...(data.apn && !existingDevice.apn && { apn: data.apn }),
          updated_at: new Date(),
          ultima_conexao: new Date(),
          // ✅ NÃO alterar organizacao_id - preservar pré-cadastro!
        },
      });
    }

    // Dispositivo novo (não pré-cadastrado) - criar sem organização
    const createData = {
      imei,
      tipo: defaultType,
      status: data.status || 'offline',
      organizacao_id: null, // ✅ Novo dispositivo sem organização - super_admin atribui
      placa: data.placa || null,
      veiculo: data.veiculo || null,
      operadora: data.operadora || null,
      imei_chip: data.imei_chip || null,
      telefone_chip: data.telefone_chip || null,
      apn: data.apn || null,
      ultima_conexao: new Date(),
      // ✅ CONFIGURAÇÕES AUTOMÁTICAS DO TIPO
      conexao_pos_chave: config.conexao_pos_chave,
      usa_ignicao_virtual: config.usa_ignicao_virtual,
      tensao_motor_ligado: config.tensao_motor_ligado,
      tensao_motor_deslig: config.tensao_motor_deslig,
    };

    console.log(`[Dispositivo] Novo dispositivo ${imei} tipo ${defaultType} - SEM ORGANIZAÇÃO (aguardando atribuição)`);

    return await prisma.dispositivo.create({ data: createData });
  }

  // Update device type (para configuração manual ou detecção de firmware)
  // ✅ Aplica automaticamente as configurações do novo tipo
  async updateType(imei, tipo) {
    const validTypes = Object.keys(DEVICE_TYPES);
    if (!validTypes.includes(tipo)) {
      throw new Error(`Tipo inválido: ${tipo}. Tipos válidos: ${validTypes.join(', ')}`);
    }

    // ✅ Obter configurações padrão do novo tipo
    const config = getDefaultConfig(tipo);

    const updateData = {
      tipo,
      updated_at: new Date(),
      // ✅ APLICAR CONFIGURAÇÕES DO TIPO AUTOMATICAMENTE
      conexao_pos_chave: config.conexao_pos_chave,
      usa_ignicao_virtual: config.usa_ignicao_virtual,
      tensao_motor_ligado: config.tensao_motor_ligado,
      tensao_motor_deslig: config.tensao_motor_deslig,
    };

    console.log(`[Dispositivo] Tipo alterado para ${tipo} - config: posChave=${config.conexao_pos_chave}, tensaoOn=${config.tensao_motor_ligado}V, tensaoOff=${config.tensao_motor_deslig}V`);

    return await prisma.dispositivo.update({
      where: { imei },
      data: updateData,
    });
  }

  // Update device status
  async updateStatus(imei, status) {
    return await prisma.dispositivo.update({
      where: { imei },
      data: {
        status,
        ultima_conexao: new Date(),
      },
    });
  }

  // Get device statistics
  // ✅ Multi-tenant: Filtra por organizacao_id quando fornecido
  async getStats(tenantFilter = {}) {
    const [total, online, offline] = await Promise.all([
      prisma.dispositivo.count({ where: tenantFilter }),
      prisma.dispositivo.count({ where: { ...tenantFilter, status: 'online' } }),
      prisma.dispositivo.count({ where: { ...tenantFilter, status: 'offline' } }),
    ]);

    return { total, online, offline };
  }

  // Create new device
  // ✅ Aplica configurações automaticamente baseado no tipo
  // ✅ Configura odômetro inicial para modelo cabo (XT40_4F)
  // ✅ Suporta perfil de veículo para calibração de tensão
  // ✅ Multi-tenant: Requer organizacao_id
  async create(deviceData, organizacao_id = null) {
    const tipo = deviceData.tipo || 'XT40_UNKNOWN';

    // ✅ Validar organizacao_id se fornecido
    if (organizacao_id === null) {
      throw new Error('organizacao_id é obrigatório para criar dispositivo');
    }

    // ✅ Obter configurações padrão do tipo
    const config = getDefaultConfig(tipo, deviceData.perfil_veiculo, deviceData.ano_veiculo);

    // ✅ Se forneceu perfil de veículo, usar thresholds do perfil
    let tensaoConfig = {
      tensao_motor_ligado: config.tensao_motor_ligado,
      tensao_motor_deslig: config.tensao_motor_deslig,
    };

    if (deviceData.perfil_veiculo) {
      const perfilThresholds = getVoltageThresholds(deviceData.perfil_veiculo);
      tensaoConfig = perfilThresholds;
    }

    const createData = {
      imei: deviceData.imei,
      tipo: tipo,
      organizacao_id: organizacao_id, // ✅ Multi-tenant
      placa: deviceData.placa || null,
      veiculo: deviceData.veiculo || null,
      veiculo_id: deviceData.veiculo_id || null, // ✅ Vínculo com entidade Veiculo
      operadora: deviceData.operadora || null,
      imei_chip: deviceData.imei_chip || null,
      telefone_chip: deviceData.telefone_chip || null,
      apn: deviceData.apn || null,
      status: 'offline',
      // ✅ CONFIGURAÇÕES AUTOMÁTICAS DO TIPO
      conexao_pos_chave: config.conexao_pos_chave,
      usa_ignicao_virtual: config.usa_ignicao_virtual,
      tensao_motor_ligado: tensaoConfig.tensao_motor_ligado,
      tensao_motor_deslig: tensaoConfig.tensao_motor_deslig,
      // ✅ PERFIL DE VEÍCULO E CALIBRAÇÃO
      perfil_veiculo: deviceData.perfil_veiculo || null,
      ano_veiculo: deviceData.ano_veiculo || null,
      calibracao_status: deviceData.perfil_veiculo ? CALIBRATION_STATUS.EM_APRENDIZADO : null,
      calibracao_inicio: deviceData.perfil_veiculo ? new Date() : null,
    };

    console.log(`[Dispositivo] Novo dispositivo ${deviceData.imei} tipo ${tipo} perfil ${deviceData.perfil_veiculo || 'N/A'} - config: posChave=${config.conexao_pos_chave}, tensaoOn=${tensaoConfig.tensao_motor_ligado}V, tensaoOff=${tensaoConfig.tensao_motor_deslig}V`);

    // ✅ Configurar odômetro inicial (principalmente para modelo cabo XT40_4F)
    if (deviceData.odometro_inicial !== undefined && deviceData.odometro_inicial !== null) {
      const odometroKm = parseFloat(deviceData.odometro_inicial);
      if (!isNaN(odometroKm) && odometroKm >= 0) {
        createData.odometro_offset = odometroKm;
        createData.odometro_total = odometroKm; // Inicia com o valor do odômetro
        console.log(`[Dispositivo] Odômetro inicial configurado: ${odometroKm} km`);
      }
    }

    const dispositivo = await prisma.dispositivo.create({
      data: createData,
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: deviceData.usuarioId || null,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_DISPOSITIVO,
      recurso: 'dispositivo',
      recursoId: dispositivo.id,
      detalhes: `Dispositivo "${deviceData.placa || deviceData.imei}" criado`,
      dadosNovos: { imei: deviceData.imei, placa: deviceData.placa, veiculo: deviceData.veiculo, tipo }
    });

    return dispositivo;
  }

  // Update device
  // ✅ Suporta atualização do odômetro inicial
  // ✅ Suporta atualização de perfil de veículo
  // ✅ Suporta atualização de status_uso (ativo, disponivel, inativo)
  async update(imei, deviceData, usuarioId = null) {
    // Buscar dados anteriores para auditoria
    const anterior = await prisma.dispositivo.findUnique({ where: { imei } });

    const updateData = {
      ...(deviceData.tipo && { tipo: deviceData.tipo }),
      ...(deviceData.placa !== undefined && { placa: deviceData.placa }),
      ...(deviceData.veiculo !== undefined && { veiculo: deviceData.veiculo }),
      ...(deviceData.veiculo_id !== undefined && { veiculo_id: deviceData.veiculo_id }), // ✅ Vínculo com entidade Veiculo
      ...(deviceData.operadora !== undefined && { operadora: deviceData.operadora }),
      ...(deviceData.imei_chip !== undefined && { imei_chip: deviceData.imei_chip }),
      ...(deviceData.telefone_chip !== undefined && { telefone_chip: deviceData.telefone_chip }),
      ...(deviceData.apn !== undefined && { apn: deviceData.apn }),
      ...(deviceData.status !== undefined && { status: deviceData.status }),
      ...(deviceData.status_uso !== undefined && { status_uso: deviceData.status_uso }),
      ...(deviceData.ano_veiculo !== undefined && { ano_veiculo: deviceData.ano_veiculo }),
      updated_at: new Date(),
    };

    // ✅ Atualizar perfil de veículo e thresholds de tensão se fornecido
    if (deviceData.perfil_veiculo) {
      const thresholds = getVoltageThresholds(deviceData.perfil_veiculo);
      updateData.perfil_veiculo = deviceData.perfil_veiculo;
      updateData.tensao_motor_ligado = thresholds.tensao_motor_ligado;
      updateData.tensao_motor_deslig = thresholds.tensao_motor_deslig;
      updateData.calibracao_status = CALIBRATION_STATUS.EM_APRENDIZADO;
      updateData.calibracao_inicio = new Date();
      updateData.tensao_sugerida_on = null;
      updateData.tensao_sugerida_off = null;
      updateData.calibracao_confianca = null;
      console.log(`[Dispositivo] ${imei}: Perfil atualizado para ${deviceData.perfil_veiculo} - ON: ${thresholds.tensao_motor_ligado}V, OFF: ${thresholds.tensao_motor_deslig}V`);
    }

    // ✅ Atualizar odômetro inicial se fornecido
    if (deviceData.odometro_inicial !== undefined && deviceData.odometro_inicial !== null) {
      const odometroKm = parseFloat(deviceData.odometro_inicial);
      if (!isNaN(odometroKm) && odometroKm >= 0) {
        if (anterior) {
          const offsetAntigo = anterior.odometro_offset || 0;
          const totalAntigo = anterior.odometro_total || 0;
          const distanciaRodada = totalAntigo - offsetAntigo; // Distância já percorrida

          updateData.odometro_offset = odometroKm;
          updateData.odometro_total = odometroKm + distanciaRodada; // Novo offset + distância já rodada
          console.log(`[Dispositivo] Odômetro atualizado: offset ${offsetAntigo} → ${odometroKm}, total ${totalAntigo} → ${updateData.odometro_total}`);
        }
      }
    }

    const dispositivo = await prisma.dispositivo.update({
      where: { imei },
      data: updateData,
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: anterior?.organizacao_id,
      acao: ACOES.EDITAR_DISPOSITIVO,
      recurso: 'dispositivo',
      recursoId: dispositivo.id,
      detalhes: `Dispositivo "${anterior?.placa || imei}" atualizado`,
      dadosAnteriores: anterior,
      dadosNovos: updateData
    });

    return dispositivo;
  }

  // Delete device
  async delete(imei, usuarioId = null) {
    // Buscar dados antes de deletar para auditoria
    const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });

    const resultado = await prisma.dispositivo.delete({
      where: { imei },
    });

    // Registrar auditoria
    if (dispositivo) {
      await auditoriaService.registrar({
        usuarioId,
        organizacaoId: dispositivo.organizacao_id,
        acao: ACOES.DELETAR_DISPOSITIVO,
        recurso: 'dispositivo',
        recursoId: dispositivo.id,
        detalhes: `Dispositivo "${dispositivo.placa || imei}" excluído`
      });
    }

    return resultado;
  }
}

module.exports = new DispositivoService();
