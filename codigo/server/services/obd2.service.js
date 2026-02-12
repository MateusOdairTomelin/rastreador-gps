const prisma = require('../db/prisma');
const { supportsOBD2 } = require('../constants/device-types');
const telemetriaService = require('./telemetria.service');

class OBD2Service {
  /**
   * Verifica se um dispositivo suporta leitura OBD2 real
   * Dispositivos como XT40_4F (cabo) não têm conexão OBD2
   */
  async deviceSupportsOBD2(imei) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: { tipo: true },
    });
    if (!dispositivo) return false;
    return supportsOBD2(dispositivo.tipo);
  }
  // Aplica calibração de odômetro
  // Fórmula: odometro_calibrado = (odometro_bruto * fator) + offset
  applyOdometerCalibration(rawValue, fator, offset) {
    if (rawValue === null || rawValue === undefined) return null;
    return (rawValue * fator) + offset;
  }

  // Get current OBD2 data (merged from multiple packet types)
  async getCurrent(imei) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // ✅ Verificar se dispositivo suporta OBD2 real
    const suportaOBD2 = supportsOBD2(dispositivo.tipo);

    // Buscar os últimos 30 registros para mesclar dados de diferentes pacotes
    // (0x94 OBD2 e 0x22 Location com bateria chegam em intervalos diferentes)
    const recentRecords = await prisma.dadosOBD2.findMany({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' },
      take: 30,
    });

    // ✅ Se não há registros OBD2, retornar dados básicos do dispositivo
    if (recentRecords.length === 0) {
      // Para dispositivos novos sem dados, retornar pelo menos o odômetro configurado
      const suportaOBD2Check = supportsOBD2(dispositivo.tipo);
      return {
        id: null,
        timestamp: dispositivo.updated_at || new Date(),
        rpm: null,
        temperatura_motor: null,
        nivel_combustivel: null,
        ignicao: false,
        odometro_plataforma: dispositivo.odometro_total || 0,
        odometro_embarcado: null,
        hora_motor_plataforma: dispositivo.horimetro_total || 0,
        hora_motor_embarcada: null,
        percentual_bateria: null,
        tensao_bateria: null,
        suporta_obd2: suportaOBD2Check,
        tipo_dispositivo: dispositivo.tipo,
        calibracao: {
          fator: dispositivo.odometro_fator || 1,
          offset: dispositivo.odometro_offset || 0,
          calibrado: false,
        },
        viagem: {
          em_viagem: false,
          viagem_atual: null,
          totais: {
            odometro_total: dispositivo.odometro_total || 0,
            horimetro_total: dispositivo.horimetro_total || 0,
          },
        },
        _nota: 'Dispositivo novo - aguardando primeiros dados de telemetria',
      };
    }

    // Mesclar dados: priorizar valores não-nulos dos registros mais recentes
    const merged = {
      id: recentRecords[0].id,
      timestamp: recentRecords[0].timestamp,
      rpm: null,
      temperatura_motor: null,
      nivel_combustivel: null,
      ignicao: false,
      odometro_plataforma: null,
      odometro_embarcado: null,
      odometro_bruto: null, // Valor bruto para referência
      hora_motor_plataforma: null,
      hora_motor_embarcada: null,
      percentual_bateria: null,
      tensao_bateria: null,
    };

    // ✅ Variáveis para priorizar odômetro OBD2 real (pacote 0x94 que tem RPM)
    let odometroOBD2Real = null;
    let horaMotorOBD2Real = null;

    // Mesclar valores não-nulos dos registros mais recentes
    for (const record of recentRecords) {
      // ✅ IMPORTANTE: Campos OBD2 reais só são mesclados se dispositivo suporta OBD2
      if (suportaOBD2) {
        if (merged.rpm === null && record.rpm !== null) merged.rpm = record.rpm;
        if (merged.temperatura_motor === null && record.temperatura_motor !== null) merged.temperatura_motor = record.temperatura_motor;
        if (merged.nivel_combustivel === null && record.nivel_combustivel !== null) merged.nivel_combustivel = record.nivel_combustivel;

        // ✅ NOVO: Se registro tem RPM (pacote 0x94), guardar odômetro OBD2 real
        // Priorizar odômetro do OBD2 real sobre o do pacote 0x22 (GPS)
        if (record.rpm !== null && record.odometro_embarcado !== null && record.odometro_embarcado > 0) {
          if (odometroOBD2Real === null) {
            odometroOBD2Real = record.odometro_embarcado;
          }
        }
        if (record.rpm !== null && record.hora_motor_embarcada !== null && record.hora_motor_embarcada > 0) {
          if (horaMotorOBD2Real === null) {
            horaMotorOBD2Real = record.hora_motor_embarcada;
          }
        }
      }
      // Campos que funcionam para todos os dispositivos
      if (!merged.ignicao && record.ignicao) merged.ignicao = record.ignicao;
      if (merged.odometro_plataforma === null && record.odometro_plataforma !== null) merged.odometro_plataforma = record.odometro_plataforma;
      if (merged.odometro_embarcado === null && record.odometro_embarcado !== null) merged.odometro_embarcado = record.odometro_embarcado;
      if (merged.hora_motor_plataforma === null && record.hora_motor_plataforma !== null) merged.hora_motor_plataforma = record.hora_motor_plataforma;
      if (merged.hora_motor_embarcada === null && record.hora_motor_embarcada !== null) merged.hora_motor_embarcada = record.hora_motor_embarcada;
      if (merged.percentual_bateria === null && record.percentual_bateria !== null) merged.percentual_bateria = record.percentual_bateria;
      if (merged.tensao_bateria === null && record.tensao_bateria !== null) merged.tensao_bateria = record.tensao_bateria;
    }

    // ✅ NOVO: Para dispositivos OBD2, priorizar odômetro e horímetro do pacote 0x94
    if (suportaOBD2) {
      if (odometroOBD2Real !== null) {
        merged.odometro_embarcado = odometroOBD2Real;
        console.log(`[OBD2] Usando odômetro OBD2 real: ${odometroOBD2Real} km (priorizado sobre GPS)`);
      }
      if (horaMotorOBD2Real !== null) {
        merged.hora_motor_embarcada = horaMotorOBD2Real;
        console.log(`[OBD2] Usando horímetro OBD2 real: ${horaMotorOBD2Real} h (priorizado)`);
      }
    }

    // ✅ Para dispositivos sem OBD2: calcular odômetro e horímetro pela plataforma
    if (!suportaOBD2) {
      console.log(`[OBD2] Dispositivo ${imei} (${dispositivo.tipo}) não suporta OBD2 - usando cálculos da plataforma`);

      // Calcular odômetro por GPS se não tiver embarcado
      if (merged.odometro_embarcado === null || merged.odometro_embarcado === 0) {
        const odometroGPS = await telemetriaService.calcularOdometroPlataforma(imei);
        merged.odometro_plataforma = odometroGPS;
        merged.odometro_embarcado = null; // Forçar null para deixar claro que não há dados embarcados
      }

      // Calcular horímetro por tempo de ignição se não tiver embarcado
      if (merged.hora_motor_embarcada === null || merged.hora_motor_embarcada === 0) {
        const horimetroCalc = await telemetriaService.calcularHorimetroPlataforma(imei);
        merged.hora_motor_plataforma = horimetroCalc;
        merged.hora_motor_embarcada = null; // Forçar null para deixar claro que não há dados embarcados
      }
    }

    // Guardar valor bruto e aplicar calibração de odômetro (apenas se tiver valor embarcado)
    merged.odometro_bruto = merged.odometro_embarcado;
    if (merged.odometro_embarcado !== null) {
      merged.odometro_embarcado = this.applyOdometerCalibration(
        merged.odometro_bruto,
        dispositivo.odometro_fator,
        dispositivo.odometro_offset
      );
    }

    // Incluir info de calibração e tipo na resposta
    merged.calibracao = {
      fator: dispositivo.odometro_fator,
      offset: dispositivo.odometro_offset,
      calibrado: dispositivo.odometro_fator !== 1.0 || dispositivo.odometro_offset !== 0.0
    };
    merged.suporta_obd2 = suportaOBD2;
    merged.tipo_dispositivo = dispositivo.tipo;

    // ✅ Para dispositivos sem OBD2: incluir dados de viagem
    if (!suportaOBD2) {
      // Buscar dados de viagem do dispositivo
      const dispComViagem = await prisma.dispositivo.findUnique({
        where: { imei },
        select: {
          viagem_inicio: true,
          viagem_odometro: true,
          viagem_horimetro: true,
          viagem_vel_max: true,
          viagem_vel_soma: true,
          viagem_vel_count: true,
          odometro_total: true,
          horimetro_total: true,
        },
      });

      if (dispComViagem) {
        const emViagem = dispComViagem.viagem_inicio !== null;
        const velMedia = dispComViagem.viagem_vel_count > 0
          ? dispComViagem.viagem_vel_soma / dispComViagem.viagem_vel_count
          : 0;

        merged.viagem = {
          em_viagem: emViagem,
          viagem_atual: emViagem ? {
            inicio: dispComViagem.viagem_inicio,
            odometro: parseFloat((dispComViagem.viagem_odometro || 0).toFixed(2)),
            horimetro: parseFloat((dispComViagem.viagem_horimetro || 0).toFixed(2)),
            velocidade_media: parseFloat(velMedia.toFixed(1)),
            velocidade_max: dispComViagem.viagem_vel_max || 0,
            duracao_minutos: dispComViagem.viagem_inicio
              ? parseFloat(((Date.now() - dispComViagem.viagem_inicio.getTime()) / (1000 * 60)).toFixed(1))
              : 0,
          } : null,
          totais: {
            odometro_total: parseFloat((dispComViagem.odometro_total || 0).toFixed(2)),
            horimetro_total: parseFloat((dispComViagem.horimetro_total || 0).toFixed(2)),
          },
        };

        // Usar totais acumulados para os campos principais se não em viagem
        if (!emViagem) {
          merged.odometro_plataforma = dispComViagem.odometro_total || 0;
          merged.hora_motor_plataforma = dispComViagem.horimetro_total || 0;
        } else {
          // Durante viagem: mostrar total + viagem atual
          merged.odometro_plataforma = (dispComViagem.odometro_total || 0) + (dispComViagem.viagem_odometro || 0);
          merged.hora_motor_plataforma = (dispComViagem.horimetro_total || 0) + (dispComViagem.viagem_horimetro || 0);
        }
      }
    }

    return merged;
  }

  // Get OBD2 history
  async getHistory(imei, horasAtras = 24) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    const dataLimite = new Date();
    dataLimite.setHours(dataLimite.getHours() - horasAtras);

    return await prisma.dadosOBD2.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: dataLimite },
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  // Calibrar odômetro com valor real atual
  // O usuário informa o valor real do odômetro e o sistema calcula o offset
  async calibrarOdometro(imei, odometroReal, fator = null) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // Buscar último valor bruto de odômetro
    const ultimoOBD2 = await prisma.dadosOBD2.findFirst({
      where: {
        dispositivo_id: dispositivo.id,
        odometro_embarcado: { not: null }
      },
      orderBy: { timestamp: 'desc' },
    });

    if (!ultimoOBD2 || ultimoOBD2.odometro_embarcado === null) {
      throw new Error('Nenhum dado de odômetro encontrado para calibração. Aguarde o dispositivo enviar dados.');
    }

    const odometroBruto = ultimoOBD2.odometro_embarcado;

    // Se o usuário forneceu um fator específico, use-o
    // Caso contrário, use fator 1.0 e apenas calcule o offset
    const novoFator = fator !== null ? fator : 1.0;

    // Calcular offset: odometroReal = (odometroBruto * fator) + offset
    // offset = odometroReal - (odometroBruto * fator)
    const novoOffset = odometroReal - (odometroBruto * novoFator);

    // Atualizar dispositivo com nova calibração
    await prisma.dispositivo.update({
      where: { imei },
      data: {
        odometro_fator: novoFator,
        odometro_offset: novoOffset,
      },
    });

    console.log(`[OBD2] Calibração aplicada: IMEI=${imei}, bruto=${odometroBruto}, real=${odometroReal}, fator=${novoFator}, offset=${novoOffset}`);

    return {
      imei,
      odometro_bruto: odometroBruto,
      odometro_real: odometroReal,
      fator: novoFator,
      offset: novoOffset,
      formula: `${odometroReal} = (${odometroBruto} × ${novoFator}) + ${novoOffset.toFixed(2)}`,
    };
  }

  // Obter informações de calibração do dispositivo
  async getCalibracao(imei) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: {
        imei: true,
        placa: true,
        veiculo: true,
        odometro_fator: true,
        odometro_offset: true,
      },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return {
      imei: dispositivo.imei,
      placa: dispositivo.placa,
      veiculo: dispositivo.veiculo,
      fator: dispositivo.odometro_fator,
      offset: dispositivo.odometro_offset,
      calibrado: dispositivo.odometro_fator !== 1.0 || dispositivo.odometro_offset !== 0.0,
    };
  }

  // Create new OBD2 record
  async create(imei, obd2Data) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // ✅ Verificar se dispositivo suporta OBD2 real
    const suportaOBD2 = supportsOBD2(dispositivo.tipo);

    // ✅ Filtrar campos válidos do schema Prisma
    // Para dispositivos sem OBD2: anular campos que não podem ser coletados
    const validFields = {
      // Campos OBD2 reais: só aceitar se dispositivo suporta OBD2
      rpm: suportaOBD2 ? (obd2Data.rpm ?? null) : null,
      temperatura_motor: suportaOBD2 ? (obd2Data.temperatura_motor ?? null) : null,
      nivel_combustivel: suportaOBD2 ? (obd2Data.nivel_combustivel ?? null) : null,

      // Campos universais que funcionam para todos os dispositivos
      ignicao: obd2Data.ignicao ?? false,
      velocidade: obd2Data.velocidade ?? null, // Para determinar ocioso/movimento
      odometro_plataforma: obd2Data.odometro_plataforma ?? null,
      odometro_embarcado: obd2Data.odometro_embarcado ?? null,
      hora_motor_plataforma: obd2Data.hora_motor_plataforma ?? null,
      hora_motor_embarcada: obd2Data.hora_motor_embarcada ?? null,
      percentual_bateria: obd2Data.percentual_bateria ?? null,
      tensao_bateria: obd2Data.tensao_bateria ?? null,
      tensao_principal: obd2Data.tensao_principal ?? null, // ✅ Tensão do veículo (12-14V) para ignição virtual
      timestamp: obd2Data.timestamp || new Date(),
    };

    // ✅ Para dispositivos sem OBD2: calcular odômetro e horímetro da plataforma
    if (!suportaOBD2) {
      console.log(`[OBD2] Dispositivo ${imei} (${dispositivo.tipo}) sem OBD2 - calculando valores da plataforma`);

      // Calcular odômetro por GPS
      const odometroGPS = await telemetriaService.calcularOdometroPlataforma(imei);
      validFields.odometro_plataforma = odometroGPS;

      // Calcular horímetro por tempo de ignição
      const horimetroCalc = await telemetriaService.calcularHorimetroPlataforma(imei);
      validFields.hora_motor_plataforma = horimetroCalc;

      // Limpar valores embarcados que não são confiáveis
      validFields.odometro_embarcado = null;
      validFields.hora_motor_embarcada = null;
    }

    console.log(`[OBD2] Creating record for ${imei} (suporta_obd2=${suportaOBD2}): rpm=${validFields.rpm}, temp=${validFields.temperatura_motor}, fuel=${validFields.nivel_combustivel}, odo_emb=${validFields.odometro_embarcado}, odo_plat=${validFields.odometro_plataforma}, hori_emb=${validFields.hora_motor_embarcada}, hori_plat=${validFields.hora_motor_plataforma}, bat=${validFields.tensao_bateria}, bat%=${validFields.percentual_bateria}`);

    // ✅ Atualizar estado_ignicao APENAS para dispositivos OBD2 REAIS
    // NÃO sobrescrever estado de ignição para:
    // - XT40_4F (rastreador com cabo) - usa detectarEstadoIgnicao() do location-processor
    // - Dispositivos com usa_ignicao_virtual=true - usa lógica de tensão do location-processor
    // - Dispositivos com conexao_pos_chave=true - usa lógica de tensão do location-processor
    const isOBD2Device = dispositivo.tipo === 'XT40_OBD2';
    const isXT40_4F = dispositivo.tipo === 'XT40_4F';
    const usaIgnicaoVirtual = dispositivo.usa_ignicao_virtual === true;
    const conexaoPosChave = dispositivo.conexao_pos_chave === true;
    const tensao = validFields.tensao_principal || 0;
    const temDadosOBD2Reais = tensao > 0;

    // ⚠️ NÃO SOBRESCREVER estado de ignição para dispositivos que usam detectarEstadoIgnicao()
    if (isXT40_4F || usaIgnicaoVirtual || conexaoPosChave) {
      console.log(`[OBD2] ${imei}: ${dispositivo.tipo} (virtual=${usaIgnicaoVirtual}, posChave=${conexaoPosChave}) - NÃO sobrescrevendo estado_ignicao`);
    } else if ((suportaOBD2 || isOBD2Device) && temDadosOBD2Reais) {
      const velocidade = validFields.velocidade || 0;
      let estadoIgnicao;

      // Para XT40_OBD2 com dados reais:
      // - ignicao=true explicitamente OU tensao >= 13.5V = motor ligado
      // - ignicao=false OU tensao < 13V = motor desligado
      const ignicaoLigada = validFields.ignicao === true || tensao >= 13.5;

      if (!ignicaoLigada) {
        estadoIgnicao = 'off';
      } else if (velocidade > 3) {
        estadoIgnicao = 'moving';
      } else {
        estadoIgnicao = 'idle';
      }

      // Atualizar estado do dispositivo
      await prisma.dispositivo.update({
        where: { id: dispositivo.id },
        data: { estado_ignicao: estadoIgnicao }
      });

      console.log(`[OBD2] ${imei}: Estado ignição atualizado -> ${estadoIgnicao} (ignicao=${validFields.ignicao}, tensao=${tensao}V, vel=${velocidade})`);
    } else if (isOBD2Device) {
      // XT40_OBD2 sem dados OBD2 reais: não atualizar estado_ignicao aqui
      // O location-processor já definiu o estado baseado em velocidade
      console.log(`[OBD2] ${imei}: XT40_OBD2 sem dados OBD2 reais (tensao=${tensao}V) - mantendo estado do location-processor`);
    }

    return await prisma.dadosOBD2.create({
      data: {
        dispositivo_id: dispositivo.id,
        ...validFields,
      },
    });
  }
}

module.exports = new OBD2Service();
