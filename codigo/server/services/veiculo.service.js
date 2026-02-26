/**
 * Serviço de Veículos
 *
 * Gerencia CRUD de veículos e vinculação com dispositivos (rastreadores).
 * Permite trocar rastreador sem perder histórico do veículo.
 */

const prisma = require('../db/prisma');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

class VeiculoService {
  /**
   * Listar veículos de uma organização
   */
  async listar(organizacao_id, { busca, page = 1, limit = 50 } = {}) {
    const where = { organizacao_id };

    if (busca) {
      where.OR = [
        { placa: { contains: busca, mode: 'insensitive' } },
        { modelo: { contains: busca, mode: 'insensitive' } },
        { marca: { contains: busca, mode: 'insensitive' } }
      ];
    }

    const [veiculos, total] = await Promise.all([
      prisma.veiculo.findMany({
        where,
        include: {
          dispositivos: {
            select: {
              id: true,
              imei: true,
              tipo: true,
              status: true,
              estado_ignicao: true,
              ultima_conexao: true
            }
          },
          tags: {
            include: {
              tag: {
                select: {
                  id: true,
                  nome: true,
                  cor: true
                }
              }
            }
          }
        },
        orderBy: { placa: 'asc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.veiculo.count({ where })
    ]);

    return {
      veiculos,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Buscar veículo por ID
   */
  async buscarPorId(id, organizacao_id) {
    return prisma.veiculo.findFirst({
      where: { id, organizacao_id },
      include: {
        dispositivos: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true,
            estado_ignicao: true,
            ultima_conexao: true,
            placa: true,
            veiculo: true
          }
        },
        historico_dispositivos: {
          include: {
            dispositivo: {
              select: {
                id: true,
                imei: true,
                tipo: true
              }
            }
          },
          orderBy: { data_vinculo: 'desc' },
          take: 20
        }
      }
    });
  }

  /**
   * Buscar veículo por placa
   */
  async buscarPorPlaca(placa, organizacao_id) {
    return prisma.veiculo.findFirst({
      where: {
        placa: { equals: placa, mode: 'insensitive' },
        organizacao_id
      },
      include: {
        dispositivos: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true
          }
        }
      }
    });
  }

  /**
   * Criar novo veículo
   */
  async criar(organizacao_id, dados, usuarioId = null) {
    // Validar organização
    if (!organizacao_id) {
      throw new Error('Organização não definida');
    }

    // Validar placa obrigatória
    if (!dados.placa || dados.placa.trim().length < 7) {
      throw new Error('Placa é obrigatória (mínimo 7 caracteres)');
    }

    // Normalizar placa (uppercase, sem espaços)
    const placaNormalizada = dados.placa.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Verificar se placa já existe na organização
    const existente = await prisma.veiculo.findFirst({
      where: {
        organizacao_id,
        placa: placaNormalizada
      }
    });

    if (existente) {
      throw new Error('Já existe um veículo com esta placa nesta organização');
    }

    const veiculo = await prisma.veiculo.create({
      data: {
        organizacao_id,
        placa: placaNormalizada,
        modelo: dados.modelo?.trim() || null,
        marca: dados.marca?.trim() || null,
        ano: dados.ano ? parseInt(dados.ano) : null,
        cor: dados.cor?.trim() || null,
        tipo_veiculo: dados.tipo_veiculo?.trim() || null,
        chassi: dados.chassi?.trim() || null,
        renavam: dados.renavam?.trim() || null
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_VEICULO || 'CRIAR_VEICULO',
      recurso: 'veiculo',
      recursoId: veiculo.id,
      detalhes: `Veículo "${placaNormalizada}" criado`
    });

    console.log(`[Veículos] Veículo ${veiculo.id} (${placaNormalizada}) criado`);
    return veiculo;
  }

  /**
   * Atualizar veículo
   */
  async atualizar(id, organizacao_id, dados, usuarioId = null) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Se mudando a placa, verificar unicidade
    if (dados.placa) {
      const placaNormalizada = dados.placa.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

      if (placaNormalizada !== veiculo.placa) {
        const existente = await prisma.veiculo.findFirst({
          where: {
            organizacao_id,
            placa: placaNormalizada,
            NOT: { id }
          }
        });

        if (existente) {
          throw new Error('Já existe um veículo com esta placa nesta organização');
        }

        dados.placa = placaNormalizada;
      }
    }

    const atualizado = await prisma.veiculo.update({
      where: { id },
      data: {
        placa: dados.placa,
        modelo: dados.modelo?.trim() || null,
        marca: dados.marca?.trim() || null,
        ano: dados.ano ? parseInt(dados.ano) : null,
        cor: dados.cor?.trim() || null,
        tipo_veiculo: dados.tipo_veiculo?.trim() || null,
        chassi: dados.chassi?.trim() || null,
        renavam: dados.renavam?.trim() || null
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.EDITAR_VEICULO || 'EDITAR_VEICULO',
      recurso: 'veiculo',
      recursoId: id,
      detalhes: `Veículo "${atualizado.placa}" atualizado`
    });

    return atualizado;
  }

  /**
   * Excluir veículo
   */
  async excluir(id, organizacao_id, usuarioId = null) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Desvincular todos os dispositivos primeiro
    await prisma.dispositivo.updateMany({
      where: { veiculo_id: id },
      data: { veiculo_id: null }
    });

    // Excluir veículo (histórico será excluído por cascade)
    await prisma.veiculo.delete({
      where: { id }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.DELETAR_VEICULO || 'DELETAR_VEICULO',
      recurso: 'veiculo',
      recursoId: id,
      detalhes: `Veículo "${veiculo.placa}" excluído`
    });

    return { sucesso: true };
  }

  /**
   * Vincular dispositivo a um veículo
   */
  async vincularDispositivo(veiculo_id, dispositivo_id, organizacao_id, usuarioId = null) {
    // Verificar se veículo pertence à organização
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Verificar se dispositivo pertence à organização
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { id: dispositivo_id, organizacao_id }
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // Se dispositivo já está vinculado a outro veículo, desvincular primeiro
    if (dispositivo.veiculo_id && dispositivo.veiculo_id !== veiculo_id) {
      await this._desvincularInterno(dispositivo.id);
    }

    // Atualizar dispositivo com novo veículo
    await prisma.dispositivo.update({
      where: { id: dispositivo_id },
      data: {
        veiculo_id,
        status_uso: 'ativo', // Marcar como ativo quando vinculado
        // Copiar dados do veículo para campos legados (compatibilidade)
        placa: veiculo.placa,
        veiculo: veiculo.modelo ? `${veiculo.marca || ''} ${veiculo.modelo}`.trim() : null
      }
    });

    // Criar registro de histórico
    await prisma.veiculoDispositivoHistorico.create({
      data: {
        veiculo_id,
        dispositivo_id,
        ativo: true
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.VINCULAR_DISPOSITIVO || 'VINCULAR_DISPOSITIVO',
      recurso: 'veiculo',
      recursoId: veiculo_id,
      detalhes: `Dispositivo ${dispositivo.imei} vinculado ao veículo ${veiculo.placa}`
    });

    return {
      sucesso: true,
      mensagem: `Dispositivo ${dispositivo.imei} vinculado ao veículo ${veiculo.placa}`
    };
  }

  /**
   * Desvincular dispositivo de um veículo (interno)
   */
  async _desvincularInterno(dispositivo_id) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivo_id }
    });

    if (!dispositivo || !dispositivo.veiculo_id) {
      return;
    }

    // Fechar histórico atual
    await prisma.veiculoDispositivoHistorico.updateMany({
      where: {
        dispositivo_id,
        veiculo_id: dispositivo.veiculo_id,
        ativo: true
      },
      data: {
        data_desvinculo: new Date(),
        ativo: false
      }
    });

    // Remover vínculo do dispositivo e marcar como disponível
    await prisma.dispositivo.update({
      where: { id: dispositivo_id },
      data: {
        veiculo_id: null,
        status_uso: 'disponivel' // Marcar como disponível quando desvinculado
      }
    });
  }

  /**
   * Desvincular dispositivo de um veículo (público)
   */
  async desvincularDispositivo(dispositivo_id, organizacao_id, usuarioId = null) {
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { id: dispositivo_id, organizacao_id },
      include: { veiculo_rel: true }
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    if (!dispositivo.veiculo_id) {
      throw new Error('Dispositivo não está vinculado a nenhum veículo');
    }

    const placaAnterior = dispositivo.veiculo_rel?.placa;
    await this._desvincularInterno(dispositivo_id);

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.DESVINCULAR_DISPOSITIVO || 'DESVINCULAR_DISPOSITIVO',
      recurso: 'dispositivo',
      recursoId: dispositivo_id,
      detalhes: `Dispositivo ${dispositivo.imei} desvinculado do veículo ${placaAnterior}`
    });

    return {
      sucesso: true,
      mensagem: `Dispositivo ${dispositivo.imei} desvinculado do veículo ${placaAnterior}`
    };
  }

  /**
   * Trocar dispositivo de um veículo (desvincula atual, vincula novo)
   */
  async trocarDispositivo(veiculo_id, novo_imei, organizacao_id, usuarioId = null) {
    // Buscar veículo
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id },
      include: { dispositivos: true }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Buscar novo dispositivo pelo IMEI
    const novoDispositivo = await prisma.dispositivo.findFirst({
      where: { imei: novo_imei, organizacao_id }
    });

    if (!novoDispositivo) {
      throw new Error(`Dispositivo com IMEI ${novo_imei} não encontrado`);
    }

    // Desvincular dispositivo atual (se houver)
    const dispositivoAtual = veiculo.dispositivos.find(d => d.veiculo_id === veiculo_id);
    if (dispositivoAtual) {
      await this._desvincularInterno(dispositivoAtual.id);
    }

    // Vincular novo dispositivo
    await this.vincularDispositivo(veiculo_id, novoDispositivo.id, organizacao_id, usuarioId);

    return {
      sucesso: true,
      mensagem: `Rastreador trocado para ${novo_imei}`,
      dispositivo_anterior: dispositivoAtual?.imei || null,
      dispositivo_novo: novo_imei
    };
  }

  /**
   * Buscar histórico de dispositivos de um veículo
   */
  async historicoDispositivos(veiculo_id, organizacao_id) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    return prisma.veiculoDispositivoHistorico.findMany({
      where: { veiculo_id },
      include: {
        dispositivo: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true
          }
        }
      },
      orderBy: { data_vinculo: 'desc' }
    });
  }

  /**
   * Buscar histórico completo de localizações de um veículo
   * (agregando TODOS os dispositivos que já foram vinculados)
   */
  async getHistoricoCompleto(veiculo_id, organizacao_id, { dataInicio, dataFim, limit = 1000 } = {}) {
    // Verificar se veículo pertence à organização
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Buscar IDs de TODOS os dispositivos que já foram vinculados ao veículo
    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: { veiculo_id },
      select: { dispositivo_id: true }
    });

    const dispositivoIds = [...new Set(historico.map(h => h.dispositivo_id))];

    if (dispositivoIds.length === 0) {
      return { localizacoes: [], total: 0, dispositivos: [] };
    }

    // Construir filtro de data
    const whereTimestamp = {};
    if (dataInicio) {
      whereTimestamp.gte = new Date(dataInicio);
    }
    if (dataFim) {
      whereTimestamp.lte = new Date(dataFim);
    }

    // Buscar localizações de TODOS os dispositivos
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: { in: dispositivoIds },
        ...(Object.keys(whereTimestamp).length > 0 ? { timestamp: whereTimestamp } : {})
      },
      include: {
        dispositivo: {
          select: {
            id: true,
            imei: true,
            tipo: true
          }
        }
      },
      orderBy: { timestamp: 'desc' },
      take: limit
    });

    return {
      localizacoes,
      total: localizacoes.length,
      dispositivos: dispositivoIds.length
    };
  }

  /**
   * Buscar viagens de um veículo
   * (agregando TODOS os dispositivos que já foram vinculados)
   */
  async getViagens(veiculo_id, organizacao_id, { dataInicio, dataFim, page = 1, limit = 50 } = {}) {
    // Verificar se veículo pertence à organização
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Buscar IDs de TODOS os dispositivos que já foram vinculados ao veículo
    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: { veiculo_id },
      select: { dispositivo_id: true }
    });

    const dispositivoIds = [...new Set(historico.map(h => h.dispositivo_id))];

    if (dispositivoIds.length === 0) {
      return { viagens: [], total: 0, page, totalPages: 0 };
    }

    // Construir filtro de data
    const whereTimestamp = {};
    if (dataInicio) {
      whereTimestamp.gte = new Date(dataInicio);
    }
    if (dataFim) {
      whereTimestamp.lte = new Date(dataFim);
    }

    // Buscar viagens de TODOS os dispositivos
    const [viagens, total] = await Promise.all([
      prisma.viagem.findMany({
        where: {
          dispositivo_id: { in: dispositivoIds },
          ...(Object.keys(whereTimestamp).length > 0 ? { inicio: whereTimestamp } : {})
        },
        include: {
          dispositivo: {
            select: {
              id: true,
              imei: true,
              tipo: true
            }
          },
          motorista: {
            select: {
              id: true,
              nome: true
            }
          }
        },
        orderBy: { inicio: 'desc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.viagem.count({
        where: {
          dispositivo_id: { in: dispositivoIds },
          ...(Object.keys(whereTimestamp).length > 0 ? { inicio: whereTimestamp } : {})
        }
      })
    ]);

    return {
      viagens,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Estatísticas agregadas do veículo
   */
  async getEstatisticas(veiculo_id, organizacao_id) {
    // Verificar se veículo pertence à organização
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Buscar IDs de TODOS os dispositivos que já foram vinculados ao veículo
    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: { veiculo_id },
      select: { dispositivo_id: true }
    });

    const dispositivoIds = [...new Set(historico.map(h => h.dispositivo_id))];

    if (dispositivoIds.length === 0) {
      return {
        total_viagens: 0,
        total_km: 0,
        total_horas: 0,
        velocidade_maxima: 0,
        total_dispositivos: 0
      };
    }

    // Agregar estatísticas de viagens
    const estatisticasViagens = await prisma.viagem.aggregate({
      where: { dispositivo_id: { in: dispositivoIds } },
      _count: { id: true },
      _sum: {
        distancia_km: true,
        duracao_minutos: true
      },
      _max: { velocidade_max: true }
    });

    return {
      total_viagens: estatisticasViagens._count.id || 0,
      total_km: Math.round((estatisticasViagens._sum.distancia_km || 0) * 100) / 100,
      total_horas: Math.round(((estatisticasViagens._sum.duracao_minutos || 0) / 60) * 100) / 100,
      velocidade_maxima: estatisticasViagens._max.velocidade_max || 0,
      total_dispositivos: dispositivoIds.length
    };
  }

  /**
   * Buscar IDs de dispositivos de um veículo em um período
   * Usado para buscar localizações considerando trocas de rastreador
   *
   * @param {number} veiculo_id - ID do veículo
   * @param {Date} dataInicio - Data início do período (opcional)
   * @param {Date} dataFim - Data fim do período (opcional)
   * @returns {Promise<number[]>} Array de dispositivo_ids
   */
  async getDispositivoIdsPorPeriodo(veiculo_id, dataInicio = null, dataFim = null) {
    // Buscar histórico de dispositivos do veículo
    const whereHistorico = { veiculo_id };

    // Se tem período, filtrar dispositivos que estavam vinculados nesse período
    if (dataInicio || dataFim) {
      whereHistorico.AND = [];

      // Dispositivo estava vinculado antes do fim do período
      if (dataFim) {
        whereHistorico.AND.push({
          data_vinculo: { lte: new Date(dataFim) }
        });
      }

      // Dispositivo foi desvinculado depois do início do período (ou ainda está vinculado)
      if (dataInicio) {
        whereHistorico.AND.push({
          OR: [
            { data_desvinculo: null }, // Ainda vinculado
            { data_desvinculo: { gte: new Date(dataInicio) } } // Desvinculado depois do início
          ]
        });
      }
    }

    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: whereHistorico,
      select: { dispositivo_id: true }
    });

    // Retornar IDs únicos
    return [...new Set(historico.map(h => h.dispositivo_id))];
  }

  /**
   * Buscar dispositivo atual E todos os históricos de um veículo
   * Retorna informações completas para exibição
   */
  async getDispositivosComHistorico(veiculo_id, organizacao_id) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id },
      include: {
        dispositivos: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true,
            ultima_conexao: true
          }
        }
      }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: { veiculo_id },
      include: {
        dispositivo: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true
          }
        }
      },
      orderBy: { data_vinculo: 'desc' }
    });

    return {
      veiculo,
      dispositivo_atual: veiculo.dispositivos[0] || null,
      historico: historico.map(h => ({
        dispositivo: h.dispositivo,
        data_vinculo: h.data_vinculo,
        data_desvinculo: h.data_desvinculo,
        ativo: h.ativo
      }))
    };
  }
}

module.exports = new VeiculoService();
