/**
 * Serviço de Multas
 *
 * Gerencia CRUD de multas de trânsito com:
 * - Identificação automática de motorista via GPS
 * - Vinculação com veículo, viagem e organização
 * - Gestão de recursos (defesa prévia, JARI, CETRAN)
 * - Filtros por status, período, gravidade
 * - Estatísticas e relatórios
 */

const prisma = require('../db/prisma');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

class MultaService {
  // ========== CRUD DE MULTAS ==========

  /**
   * Listar multas de uma organização
   */
  async listar(organizacao_id, {
    veiculo_id,
    motorista_id,
    status,
    gravidade,
    data_inicio,
    data_fim,
    busca,
    page = 1,
    limit = 50
  } = {}) {
    const where = { organizacao_id };

    if (veiculo_id) where.veiculo_id = parseInt(veiculo_id);
    if (motorista_id) where.motorista_id = parseInt(motorista_id);
    if (status) where.status = status;
    if (gravidade) where.gravidade = gravidade;

    if (data_inicio || data_fim) {
      where.data_infracao = {};
      if (data_inicio) where.data_infracao.gte = new Date(data_inicio);
      if (data_fim) where.data_infracao.lte = new Date(data_fim);
    }

    if (busca) {
      where.OR = [
        { numero_auto: { contains: busca, mode: 'insensitive' } },
        { local_infracao: { contains: busca, mode: 'insensitive' } },
        { descricao_infracao: { contains: busca, mode: 'insensitive' } },
        { veiculo: { placa: { contains: busca, mode: 'insensitive' } } }
      ];
    }

    const [multas, total] = await Promise.all([
      prisma.multa.findMany({
        where,
        include: {
          veiculo: {
            select: { id: true, placa: true, modelo: true, marca: true }
          },
          motorista: {
            select: { id: true, nome: true }
          },
          viagem: {
            select: { id: true, inicio: true, fim: true }
          },
          recursos: {
            select: { id: true, tipo: true, status: true }
          }
        },
        orderBy: { data_infracao: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.multa.count({ where })
    ]);

    return {
      multas,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Buscar multa por ID
   */
  async buscarPorId(id, organizacao_id) {
    return prisma.multa.findFirst({
      where: { id, organizacao_id },
      include: {
        veiculo: true,
        motorista: true,
        viagem: true,
        recursos: {
          orderBy: { data_protocolo: 'desc' }
        }
      }
    });
  }

  /**
   * Criar nova multa
   * Identifica automaticamente o motorista via GPS se não informado
   */
  async criar(organizacao_id, dados, usuario_id = null) {
    // Validar veículo
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: dados.veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Identificar motorista automaticamente se não informado
    let motorista_id = dados.motorista_id;
    let viagem_id = dados.viagem_id;

    if (!motorista_id && dados.data_infracao) {
      const identificacao = await this.identificarMotoristaViaGPS(
        dados.veiculo_id,
        dados.data_infracao,
        dados.hora_infracao
      );
      motorista_id = identificacao?.motorista_id;
      viagem_id = viagem_id || identificacao?.viagem_id;
    }

    // Validar motorista se informado
    if (motorista_id) {
      const motorista = await prisma.motorista.findFirst({
        where: { id: motorista_id, organizacao_id }
      });
      if (!motorista) {
        throw new Error('Motorista não encontrado');
      }
    }

    const multa = await prisma.multa.create({
      data: {
        organizacao_id,
        veiculo_id: dados.veiculo_id,
        motorista_id,
        viagem_id,
        numero_auto: dados.numero_auto || null,
        data_infracao: new Date(dados.data_infracao),
        hora_infracao: dados.hora_infracao || null,
        local_infracao: dados.local_infracao || null,
        latitude: dados.latitude || null,
        longitude: dados.longitude || null,
        codigo_infracao: dados.codigo_infracao || null,
        descricao_infracao: dados.descricao_infracao || null,
        gravidade: dados.gravidade || null,
        pontos: dados.pontos || 0,
        valor_original: dados.valor_original,
        valor_desconto: dados.valor_desconto || null,
        data_vencimento: dados.data_vencimento ? new Date(dados.data_vencimento) : null,
        data_vencimento_desconto: dados.data_vencimento_desconto ? new Date(dados.data_vencimento_desconto) : null,
        notificacao_url: dados.notificacao_url || null,
        observacoes: dados.observacoes || null,
        nic_data_limite: dados.nic_data_limite ? new Date(dados.nic_data_limite) : null,
        created_by: usuario_id
      },
      include: {
        veiculo: true,
        motorista: true
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_MULTA || 'CRIAR_MULTA',
      recurso: 'multa',
      recursoId: multa.id,
      detalhes: `Multa ${dados.numero_auto || 'sem número'} criada para veículo ${veiculo.placa}`,
      dadosNovos: {
        numero_auto: dados.numero_auto,
        data_infracao: dados.data_infracao,
        valor: dados.valor_original,
        motorista_identificado: !!motorista_id
      }
    });

    console.log(`[Multas] Multa ${multa.id} criada - Veículo: ${veiculo.placa}, Motorista: ${motorista_id ? 'identificado' : 'não identificado'}`);

    return multa;
  }

  /**
   * Atualizar multa
   */
  async atualizar(id, organizacao_id, dados, usuario_id = null) {
    const multa = await prisma.multa.findFirst({
      where: { id, organizacao_id },
      include: { veiculo: true }
    });

    if (!multa) {
      throw new Error('Multa não encontrada');
    }

    // Validar motorista se informado
    if (dados.motorista_id) {
      const motorista = await prisma.motorista.findFirst({
        where: { id: dados.motorista_id, organizacao_id }
      });
      if (!motorista) {
        throw new Error('Motorista não encontrado');
      }
    }

    const atualizada = await prisma.multa.update({
      where: { id },
      data: {
        motorista_id: dados.motorista_id !== undefined ? dados.motorista_id : undefined,
        numero_auto: dados.numero_auto !== undefined ? dados.numero_auto : undefined,
        data_infracao: dados.data_infracao ? new Date(dados.data_infracao) : undefined,
        hora_infracao: dados.hora_infracao !== undefined ? dados.hora_infracao : undefined,
        local_infracao: dados.local_infracao !== undefined ? dados.local_infracao : undefined,
        latitude: dados.latitude !== undefined ? dados.latitude : undefined,
        longitude: dados.longitude !== undefined ? dados.longitude : undefined,
        codigo_infracao: dados.codigo_infracao !== undefined ? dados.codigo_infracao : undefined,
        descricao_infracao: dados.descricao_infracao !== undefined ? dados.descricao_infracao : undefined,
        gravidade: dados.gravidade !== undefined ? dados.gravidade : undefined,
        pontos: dados.pontos !== undefined ? dados.pontos : undefined,
        valor_original: dados.valor_original !== undefined ? dados.valor_original : undefined,
        valor_desconto: dados.valor_desconto !== undefined ? dados.valor_desconto : undefined,
        valor_pago: dados.valor_pago !== undefined ? dados.valor_pago : undefined,
        data_vencimento: dados.data_vencimento ? new Date(dados.data_vencimento) : undefined,
        data_vencimento_desconto: dados.data_vencimento_desconto ? new Date(dados.data_vencimento_desconto) : undefined,
        data_pagamento: dados.data_pagamento ? new Date(dados.data_pagamento) : undefined,
        status: dados.status !== undefined ? dados.status : undefined,
        comprovante_url: dados.comprovante_url !== undefined ? dados.comprovante_url : undefined,
        notificacao_url: dados.notificacao_url !== undefined ? dados.notificacao_url : undefined,
        observacoes: dados.observacoes !== undefined ? dados.observacoes : undefined,
        nic_enviado: dados.nic_enviado !== undefined ? dados.nic_enviado : undefined,
        nic_data_envio: dados.nic_data_envio ? new Date(dados.nic_data_envio) : undefined,
        nic_data_limite: dados.nic_data_limite ? new Date(dados.nic_data_limite) : undefined
      },
      include: {
        veiculo: true,
        motorista: true
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.EDITAR_MULTA || 'EDITAR_MULTA',
      recurso: 'multa',
      recursoId: id,
      detalhes: `Multa ${multa.numero_auto || id} atualizada`,
      dadosAnteriores: { status: multa.status, motorista_id: multa.motorista_id },
      dadosNovos: { status: dados.status, motorista_id: dados.motorista_id }
    });

    return atualizada;
  }

  /**
   * Excluir multa
   */
  async excluir(id, organizacao_id, usuario_id = null) {
    const multa = await prisma.multa.findFirst({
      where: { id, organizacao_id },
      include: { veiculo: true }
    });

    if (!multa) {
      throw new Error('Multa não encontrada');
    }

    await prisma.multa.delete({ where: { id } });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.DELETAR_MULTA || 'DELETAR_MULTA',
      recurso: 'multa',
      recursoId: id,
      detalhes: `Multa ${multa.numero_auto || id} excluída - Veículo: ${multa.veiculo?.placa}`
    });

    return { sucesso: true };
  }

  // ========== IDENTIFICAÇÃO DE MOTORISTA VIA GPS ==========

  /**
   * Identifica o motorista que estava dirigindo no momento da infração
   * Busca no histórico de viagens e vinculações
   */
  async identificarMotoristaViaGPS(veiculo_id, data_infracao, hora_infracao = null) {
    // Construir timestamp da infração
    let timestampInfracao = new Date(data_infracao);
    if (hora_infracao) {
      const [horas, minutos] = hora_infracao.split(':');
      timestampInfracao.setHours(parseInt(horas), parseInt(minutos), 0, 0);
    }

    // Buscar dispositivos vinculados ao veículo na data da infração
    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: {
        veiculo_id,
        data_vinculo: { lte: timestampInfracao },
        OR: [
          { data_desvinculo: null },
          { data_desvinculo: { gte: timestampInfracao } }
        ]
      },
      include: {
        dispositivo: true
      }
    });

    if (historico.length === 0) {
      console.log(`[Multas] Nenhum dispositivo vinculado ao veículo ${veiculo_id} na data ${timestampInfracao}`);
      return null;
    }

    // Para cada dispositivo, buscar viagem ativa no momento da infração
    for (const h of historico) {
      const viagem = await prisma.viagem.findFirst({
        where: {
          dispositivo_id: h.dispositivo_id,
          inicio: { lte: timestampInfracao },
          fim: { gte: timestampInfracao }
        },
        include: {
          motorista: true
        }
      });

      if (viagem?.motorista_id) {
        console.log(`[Multas] Motorista identificado via viagem: ${viagem.motorista.nome} (ID: ${viagem.motorista_id})`);
        return {
          motorista_id: viagem.motorista_id,
          viagem_id: viagem.id,
          metodo: 'viagem'
        };
      }
    }

    // Se não encontrou viagem, buscar motorista vinculado ao dispositivo na data
    for (const h of historico) {
      const historicoMotorista = await prisma.historicoMotorista.findFirst({
        where: {
          dispositivo_id: h.dispositivo_id,
          inicio: { lte: timestampInfracao },
          OR: [
            { fim: null },
            { fim: { gte: timestampInfracao } }
          ]
        },
        include: {
          motorista: true
        }
      });

      if (historicoMotorista?.motorista_id) {
        console.log(`[Multas] Motorista identificado via histórico: ${historicoMotorista.motorista.nome} (ID: ${historicoMotorista.motorista_id})`);
        return {
          motorista_id: historicoMotorista.motorista_id,
          viagem_id: null,
          metodo: 'historico_motorista'
        };
      }
    }

    // Última tentativa: motorista atualmente vinculado ao dispositivo
    for (const h of historico) {
      if (h.dispositivo.motorista_id) {
        console.log(`[Multas] Motorista identificado via vinculação atual: ${h.dispositivo.motorista_id}`);
        return {
          motorista_id: h.dispositivo.motorista_id,
          viagem_id: null,
          metodo: 'vinculacao_atual'
        };
      }
    }

    console.log(`[Multas] Não foi possível identificar o motorista para veículo ${veiculo_id}`);
    return null;
  }

  /**
   * Valida localização GPS no momento da infração
   * Útil para recursos e contestações
   */
  async validarLocalizacaoInfracao(veiculo_id, data_infracao, hora_infracao, lat_infracao, lng_infracao, raio_metros = 200) {
    const timestampInfracao = new Date(data_infracao);
    if (hora_infracao) {
      const [horas, minutos] = hora_infracao.split(':');
      timestampInfracao.setHours(parseInt(horas), parseInt(minutos), 0, 0);
    }

    // Margem de 5 minutos para encontrar posição GPS
    const timestampInicio = new Date(timestampInfracao.getTime() - 5 * 60 * 1000);
    const timestampFim = new Date(timestampInfracao.getTime() + 5 * 60 * 1000);

    // Buscar dispositivos do veículo
    const veiculo = await prisma.veiculo.findUnique({
      where: { id: veiculo_id },
      include: {
        dispositivos: { select: { id: true } }
      }
    });

    if (!veiculo?.dispositivos?.length) {
      return { valido: null, motivo: 'Veículo sem dispositivo vinculado' };
    }

    const dispositivoIds = veiculo.dispositivos.map(d => d.id);

    // Buscar localização no momento da infração
    const localizacao = await prisma.localizacao.findFirst({
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: {
          gte: timestampInicio,
          lte: timestampFim
        }
      },
      orderBy: {
        timestamp: 'asc'
      }
    });

    if (!localizacao) {
      return { valido: null, motivo: 'Sem dados GPS no momento da infração' };
    }

    // Calcular distância entre posição GPS e local da infração
    const distancia = this._calcularDistanciaHaversine(
      localizacao.latitude,
      localizacao.longitude,
      lat_infracao,
      lng_infracao
    );

    const distanciaMetros = distancia * 1000;

    return {
      valido: distanciaMetros <= raio_metros,
      distancia_metros: Math.round(distanciaMetros),
      posicao_gps: {
        latitude: localizacao.latitude,
        longitude: localizacao.longitude,
        timestamp: localizacao.timestamp,
        velocidade: localizacao.velocidade
      },
      motivo: distanciaMetros <= raio_metros
        ? `Veículo estava a ${Math.round(distanciaMetros)}m do local da infração`
        : `Veículo estava a ${Math.round(distanciaMetros)}m do local (fora do raio de ${raio_metros}m)`
    };
  }

  /**
   * Calcula distância em km (Haversine)
   */
  _calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // ========== RECURSOS DE MULTA ==========

  /**
   * Criar recurso para uma multa
   */
  async criarRecurso(multa_id, organizacao_id, dados, usuario_id = null) {
    const multa = await prisma.multa.findFirst({
      where: { id: multa_id, organizacao_id }
    });

    if (!multa) {
      throw new Error('Multa não encontrada');
    }

    const recurso = await prisma.recursoMulta.create({
      data: {
        multa_id,
        tipo: dados.tipo,
        data_protocolo: new Date(dados.data_protocolo),
        numero_protocolo: dados.numero_protocolo || null,
        motivo: dados.motivo || null,
        anexos: dados.anexos || null,
        created_by: usuario_id
      }
    });

    // Atualizar status da multa
    await prisma.multa.update({
      where: { id: multa_id },
      data: { status: 'recorrida' }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_RECURSO_MULTA || 'CRIAR_RECURSO_MULTA',
      recurso: 'recurso_multa',
      recursoId: recurso.id,
      detalhes: `Recurso ${dados.tipo} criado para multa ${multa.numero_auto || multa_id}`
    });

    return recurso;
  }

  /**
   * Atualizar recurso (resultado)
   */
  async atualizarRecurso(recurso_id, organizacao_id, dados, usuario_id = null) {
    const recurso = await prisma.recursoMulta.findFirst({
      where: { id: recurso_id },
      include: { multa: true }
    });

    if (!recurso || recurso.multa.organizacao_id !== organizacao_id) {
      throw new Error('Recurso não encontrado');
    }

    const atualizado = await prisma.recursoMulta.update({
      where: { id: recurso_id },
      data: {
        status: dados.status !== undefined ? dados.status : undefined,
        data_resultado: dados.data_resultado ? new Date(dados.data_resultado) : undefined,
        resultado: dados.resultado !== undefined ? dados.resultado : undefined,
        anexos: dados.anexos !== undefined ? dados.anexos : undefined
      }
    });

    // Se recurso foi deferido, atualizar status da multa
    if (dados.status === 'deferido') {
      await prisma.multa.update({
        where: { id: recurso.multa_id },
        data: { status: 'cancelada' }
      });
    } else if (dados.status === 'parcialmente_deferido') {
      await prisma.multa.update({
        where: { id: recurso.multa_id },
        data: { status: 'convertida_advertencia' }
      });
    }

    return atualizado;
  }

  // ========== PAGAMENTO ==========

  /**
   * Registrar pagamento de multa
   */
  async registrarPagamento(id, organizacao_id, dados, usuario_id = null) {
    const multa = await prisma.multa.findFirst({
      where: { id, organizacao_id }
    });

    if (!multa) {
      throw new Error('Multa não encontrada');
    }

    const atualizada = await prisma.multa.update({
      where: { id },
      data: {
        status: 'paga',
        valor_pago: dados.valor_pago,
        data_pagamento: new Date(dados.data_pagamento),
        comprovante_url: dados.comprovante_url || null
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.PAGAR_MULTA || 'PAGAR_MULTA',
      recurso: 'multa',
      recursoId: id,
      detalhes: `Multa ${multa.numero_auto || id} paga - Valor: R$ ${dados.valor_pago}`
    });

    return atualizada;
  }

  /**
   * Enviar NIC (Notificação de Identificação do Condutor)
   */
  async enviarNIC(id, organizacao_id, motorista_id, usuario_id = null) {
    const multa = await prisma.multa.findFirst({
      where: { id, organizacao_id }
    });

    if (!multa) {
      throw new Error('Multa não encontrada');
    }

    const motorista = await prisma.motorista.findFirst({
      where: { id: motorista_id, organizacao_id }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    const atualizada = await prisma.multa.update({
      where: { id },
      data: {
        motorista_id,
        nic_enviado: true,
        nic_data_envio: new Date()
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuario_id,
      organizacaoId: organizacao_id,
      acao: ACOES.ENVIAR_NIC || 'ENVIAR_NIC',
      recurso: 'multa',
      recursoId: id,
      detalhes: `NIC enviado - Multa ${multa.numero_auto || id}, Motorista: ${motorista.nome}`
    });

    return atualizada;
  }

  // ========== ESTATÍSTICAS ==========

  /**
   * Obter estatísticas de multas
   */
  async estatisticas(organizacao_id, { data_inicio, data_fim } = {}) {
    const where = { organizacao_id };

    if (data_inicio || data_fim) {
      where.data_infracao = {};
      if (data_inicio) where.data_infracao.gte = new Date(data_inicio);
      if (data_fim) where.data_infracao.lte = new Date(data_fim);
    }

    const [
      total,
      porStatus,
      porGravidade,
      valorTotal,
      porMotorista,
      porVeiculo
    ] = await Promise.all([
      // Total de multas
      prisma.multa.count({ where }),

      // Por status
      prisma.multa.groupBy({
        by: ['status'],
        where,
        _count: true
      }),

      // Por gravidade
      prisma.multa.groupBy({
        by: ['gravidade'],
        where,
        _count: true
      }),

      // Valor total
      prisma.multa.aggregate({
        where,
        _sum: {
          valor_original: true,
          valor_pago: true
        }
      }),

      // Top motoristas infratores
      prisma.multa.groupBy({
        by: ['motorista_id'],
        where: { ...where, motorista_id: { not: null } },
        _count: true,
        _sum: { pontos: true },
        orderBy: { _count: { motorista_id: 'desc' } },
        take: 10
      }),

      // Top veículos
      prisma.multa.groupBy({
        by: ['veiculo_id'],
        where,
        _count: true,
        _sum: { valor_original: true },
        orderBy: { _count: { veiculo_id: 'desc' } },
        take: 10
      })
    ]);

    // Buscar nomes dos motoristas
    const motoristaIds = porMotorista.map(m => m.motorista_id).filter(Boolean);
    const motoristas = await prisma.motorista.findMany({
      where: { id: { in: motoristaIds } },
      select: { id: true, nome: true }
    });
    const motoristasMap = new Map(motoristas.map(m => [m.id, m.nome]));

    // Buscar placas dos veículos
    const veiculoIds = porVeiculo.map(v => v.veiculo_id);
    const veiculos = await prisma.veiculo.findMany({
      where: { id: { in: veiculoIds } },
      select: { id: true, placa: true }
    });
    const veiculosMap = new Map(veiculos.map(v => [v.id, v.placa]));

    // Calcular valores para o dashboard
    const statusMap = {};
    porStatus.forEach(s => {
      statusMap[s.status] = s._count;
    });

    const pendentes = statusMap['pendente'] || 0;
    const vencidas = statusMap['vencida'] || 0;
    const pagas = statusMap['paga'] || 0;

    // Calcular valor pendente (multas pendentes + vencidas não pagas)
    const valorPendente = await prisma.multa.aggregate({
      where: {
        ...where,
        status: { in: ['pendente', 'vencida'] }
      },
      _sum: { valor_original: true }
    });

    return {
      total,
      pendentes,
      vencidas,
      pagas,
      valor_pendente: valorPendente._sum.valor_original || 0,
      porStatus: porStatus.map(s => ({ status: s.status, count: s._count })),
      porGravidade: porGravidade.map(g => ({ gravidade: g.gravidade, count: g._count })),
      valorTotal: {
        original: valorTotal._sum.valor_original || 0,
        pago: valorTotal._sum.valor_pago || 0
      },
      topMotoristas: porMotorista.map(m => ({
        motorista_id: m.motorista_id,
        nome: motoristasMap.get(m.motorista_id) || 'Não identificado',
        multas: m._count,
        pontos: m._sum.pontos || 0
      })),
      topVeiculos: porVeiculo.map(v => ({
        veiculo_id: v.veiculo_id,
        placa: veiculosMap.get(v.veiculo_id) || 'N/A',
        multas: v._count,
        valor_total: v._sum.valor_original || 0
      }))
    };
  }

  /**
   * Listar multas próximas do vencimento
   */
  async proximasVencer(organizacao_id, dias = 7) {
    const hoje = new Date();
    const limite = new Date();
    limite.setDate(limite.getDate() + dias);

    return prisma.multa.findMany({
      where: {
        organizacao_id,
        status: 'pendente',
        data_vencimento: {
          gte: hoje,
          lte: limite
        }
      },
      include: {
        veiculo: { select: { placa: true } },
        motorista: { select: { nome: true } }
      },
      orderBy: { data_vencimento: 'asc' }
    });
  }

  /**
   * Listar multas com NIC pendente
   */
  async nicPendentes(organizacao_id) {
    const hoje = new Date();

    return prisma.multa.findMany({
      where: {
        organizacao_id,
        nic_enviado: false,
        nic_data_limite: { gte: hoje }
      },
      include: {
        veiculo: { select: { placa: true } },
        motorista: { select: { nome: true } }
      },
      orderBy: { nic_data_limite: 'asc' }
    });
  }
}

module.exports = new MultaService();
