/**
 * Serviço de Insights de IA
 *
 * Gera insights automáticos analisando dados da frota.
 * Detecta padrões, tendências, melhorias e alertas.
 */

const prisma = require('../db/prisma');

// Tipos de insights
const TIPOS = {
  MOTORISTA: 'motorista',
  VEICULO: 'veiculo',
  FROTA: 'frota',
  CUSTO: 'custo',
  SEGURANCA: 'seguranca'
};

// Categorias de insights
const CATEGORIAS = {
  MELHORIA: 'melhoria',
  ALERTA: 'alerta',
  TENDENCIA: 'tendencia',
  COMPARATIVO: 'comparativo'
};

class InsightService {
  /**
   * Listar insights de uma organização
   */
  async listar(organizacao_id, { lido, arquivado = false, tipo, prioridade, limit = 50, offset = 0 } = {}) {
    const where = { organizacao_id, arquivado };

    if (lido !== undefined) {
      where.lido = lido;
    }

    if (tipo) {
      where.tipo = tipo;
    }

    if (prioridade) {
      where.prioridade = prioridade;
    }

    const [insights, total] = await Promise.all([
      prisma.insightIA.findMany({
        where,
        orderBy: [
          { prioridade: 'desc' },
          { score: 'desc' },
          { created_at: 'desc' }
        ],
        skip: offset,
        take: limit
      }),
      prisma.insightIA.count({ where })
    ]);

    return {
      insights,
      total,
      naoLidos: await prisma.insightIA.count({
        where: { organizacao_id, lido: false, arquivado: false }
      })
    };
  }

  /**
   * Buscar insight por ID
   */
  async buscarPorId(id, organizacao_id) {
    return prisma.insightIA.findFirst({
      where: { id, organizacao_id }
    });
  }

  /**
   * Marcar insight como lido
   */
  async marcarComoLido(id, organizacao_id) {
    const insight = await prisma.insightIA.findFirst({
      where: { id, organizacao_id }
    });

    if (!insight) {
      throw new Error('Insight não encontrado');
    }

    return prisma.insightIA.update({
      where: { id },
      data: {
        lido: true,
        lido_em: new Date()
      }
    });
  }

  /**
   * Marcar todos como lidos
   */
  async marcarTodosComoLidos(organizacao_id) {
    const result = await prisma.insightIA.updateMany({
      where: { organizacao_id, lido: false },
      data: {
        lido: true,
        lido_em: new Date()
      }
    });

    return { atualizados: result.count };
  }

  /**
   * Arquivar insight
   */
  async arquivar(id, organizacao_id) {
    const insight = await prisma.insightIA.findFirst({
      where: { id, organizacao_id }
    });

    if (!insight) {
      throw new Error('Insight não encontrado');
    }

    return prisma.insightIA.update({
      where: { id },
      data: { arquivado: true }
    });
  }

  /**
   * ========================================
   * GERAÇÃO DE INSIGHTS
   * ========================================
   */

  /**
   * Gerar todos os insights para uma organização
   */
  async gerarInsights(organizacao_id) {
    console.log(`[Insights] Gerando insights para organização ${organizacao_id}...`);

    const insights = [];

    // Período de análise (última semana)
    const periodo_fim = new Date();
    const periodo_inicio = new Date();
    periodo_inicio.setDate(periodo_inicio.getDate() - 7);

    // Período anterior (para comparação)
    const periodo_anterior_fim = new Date(periodo_inicio);
    const periodo_anterior_inicio = new Date(periodo_anterior_fim);
    periodo_anterior_inicio.setDate(periodo_anterior_inicio.getDate() - 7);

    try {
      // Gerar diferentes tipos de insights
      const [
        insightsMotorista,
        insightsVeiculo,
        insightsAlarmes,
        insightsVelocidade,
        insightsOciosidade
      ] = await Promise.all([
        this._gerarInsightsMotoristas(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsVeiculos(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsAlarmes(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsVelocidade(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsOciosidade(organizacao_id, periodo_inicio, periodo_fim)
      ]);

      insights.push(...insightsMotorista, ...insightsVeiculo, ...insightsAlarmes, ...insightsVelocidade, ...insightsOciosidade);

      // Salvar insights gerados
      if (insights.length > 0) {
        await prisma.insightIA.createMany({
          data: insights.map(i => ({
            ...i,
            organizacao_id,
            periodo_inicio,
            periodo_fim
          }))
        });
      }

      console.log(`[Insights] ${insights.length} insights gerados para organização ${organizacao_id}`);
      return { gerados: insights.length };

    } catch (error) {
      console.error(`[Insights] Erro ao gerar insights:`, error);
      throw error;
    }
  }

  /**
   * Gerar insights sobre motoristas
   */
  async _gerarInsightsMotoristas(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim) {
    const insights = [];

    // Buscar motoristas com viagens no período
    const motoristas = await prisma.motorista.findMany({
      where: { organizacao_id, ativo: true },
      include: {
        viagens: {
          where: {
            inicio: { gte: periodo_inicio, lte: periodo_fim }
          }
        }
      }
    });

    for (const motorista of motoristas) {
      if (motorista.viagens.length === 0) continue;

      // Calcular métricas do período atual
      const kmAtual = motorista.viagens.reduce((sum, v) => sum + (v.distancia_km || 0), 0);
      const viagensAtual = motorista.viagens.length;
      const velMaxAtual = Math.max(...motorista.viagens.map(v => v.velocidade_max || 0));
      const velMediaAtual = motorista.viagens.reduce((sum, v) => sum + (v.velocidade_media || 0), 0) / viagensAtual;

      // Buscar viagens do período anterior para comparação
      const viagensAnteriores = await prisma.viagem.findMany({
        where: {
          motorista_id: motorista.id,
          inicio: { gte: periodo_anterior_inicio, lte: periodo_anterior_fim }
        }
      });

      if (viagensAnteriores.length > 0) {
        const kmAnterior = viagensAnteriores.reduce((sum, v) => sum + (v.distancia_km || 0), 0);
        const variacaoKm = ((kmAtual - kmAnterior) / kmAnterior) * 100;

        // Insight de variação significativa de km
        if (Math.abs(variacaoKm) >= 20) {
          insights.push({
            tipo: TIPOS.MOTORISTA,
            categoria: variacaoKm > 0 ? CATEGORIAS.TENDENCIA : CATEGORIAS.ALERTA,
            motorista_id: motorista.id,
            titulo: variacaoKm > 0
              ? `${motorista.nome} aumentou a quilometragem em ${Math.round(variacaoKm)}%`
              : `${motorista.nome} reduziu a quilometragem em ${Math.round(Math.abs(variacaoKm))}%`,
            descricao: `O motorista ${motorista.nome} percorreu ${Math.round(kmAtual)} km na última semana, ${variacaoKm > 0 ? 'um aumento' : 'uma redução'} de ${Math.round(Math.abs(variacaoKm))}% em relação à semana anterior (${Math.round(kmAnterior)} km).`,
            valor_antes: kmAnterior,
            valor_depois: kmAtual,
            variacao_pct: variacaoKm,
            score: Math.min(100, Math.abs(variacaoKm)),
            prioridade: Math.abs(variacaoKm) >= 50 ? 'alta' : 'normal'
          });
        }
      }

      // Insight de velocidade máxima alta
      if (velMaxAtual > 120) {
        insights.push({
          tipo: TIPOS.SEGURANCA,
          categoria: CATEGORIAS.ALERTA,
          motorista_id: motorista.id,
          titulo: `${motorista.nome} atingiu ${Math.round(velMaxAtual)} km/h`,
          descricao: `O motorista ${motorista.nome} atingiu velocidade máxima de ${Math.round(velMaxAtual)} km/h na última semana. A velocidade média foi de ${Math.round(velMediaAtual)} km/h em ${viagensAtual} viagens.`,
          valor_depois: velMaxAtual,
          score: Math.min(100, (velMaxAtual - 100) * 2),
          prioridade: velMaxAtual > 150 ? 'critica' : velMaxAtual > 130 ? 'alta' : 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar insights sobre veículos
   */
  async _gerarInsightsVeiculos(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim) {
    const insights = [];

    // Buscar veículos com dispositivos
    const veiculos = await prisma.veiculo.findMany({
      where: { organizacao_id },
      include: {
        dispositivos: {
          select: {
            id: true,
            imei: true,
            odometro_total: true,
            horimetro_total: true
          }
        }
      }
    });

    for (const veiculo of veiculos) {
      if (veiculo.dispositivos.length === 0) continue;

      const dispositivoIds = veiculo.dispositivos.map(d => d.id);

      // Buscar viagens do veículo
      const viagens = await prisma.viagem.findMany({
        where: {
          dispositivo_id: { in: dispositivoIds },
          inicio: { gte: periodo_inicio, lte: periodo_fim }
        }
      });

      if (viagens.length === 0) {
        // Veículo parado
        insights.push({
          tipo: TIPOS.VEICULO,
          categoria: CATEGORIAS.ALERTA,
          veiculo_id: veiculo.id,
          titulo: `Veículo ${veiculo.placa} sem viagens na última semana`,
          descricao: `O veículo ${veiculo.placa} (${veiculo.modelo || 'sem modelo'}) não realizou nenhuma viagem nos últimos 7 dias. Verifique se está operacional ou se houve algum problema.`,
          score: 50,
          prioridade: 'baixa'
        });
        continue;
      }

      // Métricas do período
      const kmTotal = viagens.reduce((sum, v) => sum + (v.distancia_km || 0), 0);
      const horasTotal = viagens.reduce((sum, v) => sum + (v.duracao_minutos || 0), 0) / 60;
      const velMaxima = Math.max(...viagens.map(v => v.velocidade_max || 0));

      // Veículo com alta quilometragem
      if (kmTotal > 2000) {
        insights.push({
          tipo: TIPOS.VEICULO,
          categoria: CATEGORIAS.TENDENCIA,
          veiculo_id: veiculo.id,
          titulo: `Veículo ${veiculo.placa} percorreu ${Math.round(kmTotal)} km`,
          descricao: `O veículo ${veiculo.placa} teve alta utilização na última semana, percorrendo ${Math.round(kmTotal)} km em ${Math.round(horasTotal)} horas de operação.`,
          valor_depois: kmTotal,
          score: Math.min(100, kmTotal / 30),
          prioridade: kmTotal > 3000 ? 'alta' : 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar insights sobre alarmes
   */
  async _gerarInsightsAlarmes(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim) {
    const insights = [];

    // Buscar dispositivos da organização
    const dispositivos = await prisma.dispositivo.findMany({
      where: { organizacao_id },
      select: { id: true, imei: true, placa: true }
    });

    const dispositivoIds = dispositivos.map(d => d.id);
    if (dispositivoIds.length === 0) return insights;

    // Contar alarmes por tipo no período atual
    const alarmesPorTipo = await prisma.alarme.groupBy({
      by: ['tipo_alarme'],
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: { gte: periodo_inicio, lte: periodo_fim }
      },
      _count: { id: true }
    });

    // Contar alarmes no período anterior
    const alarmesAnteriores = await prisma.alarme.groupBy({
      by: ['tipo_alarme'],
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: { gte: periodo_anterior_inicio, lte: periodo_anterior_fim }
      },
      _count: { id: true }
    });

    const mapaAnteriores = new Map(alarmesAnteriores.map(a => [a.tipo_alarme, a._count.id]));

    for (const alarme of alarmesPorTipo) {
      const countAtual = alarme._count.id;
      const countAnterior = mapaAnteriores.get(alarme.tipo_alarme) || 0;

      if (countAtual > 10 && countAnterior > 0) {
        const variacao = ((countAtual - countAnterior) / countAnterior) * 100;

        if (variacao >= 30) {
          insights.push({
            tipo: TIPOS.SEGURANCA,
            categoria: CATEGORIAS.ALERTA,
            titulo: `Aumento de ${Math.round(variacao)}% em alarmes de "${alarme.tipo_alarme}"`,
            descricao: `A frota apresentou ${countAtual} eventos de "${alarme.tipo_alarme}" na última semana, um aumento de ${Math.round(variacao)}% em relação à semana anterior (${countAnterior} eventos).`,
            valor_antes: countAnterior,
            valor_depois: countAtual,
            variacao_pct: variacao,
            dados: JSON.stringify({ tipo_alarme: alarme.tipo_alarme }),
            score: Math.min(100, variacao),
            prioridade: variacao >= 100 ? 'critica' : variacao >= 50 ? 'alta' : 'normal'
          });
        }
      }
    }

    return insights;
  }

  /**
   * Gerar insights sobre velocidade
   */
  async _gerarInsightsVelocidade(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar dispositivos da organização
    const dispositivos = await prisma.dispositivo.findMany({
      where: { organizacao_id },
      select: { id: true }
    });

    const dispositivoIds = dispositivos.map(d => d.id);
    if (dispositivoIds.length === 0) return insights;

    // Estatísticas de viagens
    const estatisticas = await prisma.viagem.aggregate({
      where: {
        dispositivo_id: { in: dispositivoIds },
        inicio: { gte: periodo_inicio, lte: periodo_fim }
      },
      _avg: { velocidade_media: true, velocidade_max: true },
      _max: { velocidade_max: true },
      _count: { id: true }
    });

    if (estatisticas._count.id > 0) {
      const velMediaGeral = estatisticas._avg.velocidade_media || 0;
      const velMaxGeral = estatisticas._max.velocidade_max || 0;

      // Frota com velocidade média baixa (ineficiência)
      if (velMediaGeral < 30 && estatisticas._count.id > 10) {
        insights.push({
          tipo: TIPOS.FROTA,
          categoria: CATEGORIAS.TENDENCIA,
          titulo: `Velocidade média da frota: ${Math.round(velMediaGeral)} km/h`,
          descricao: `A frota apresentou velocidade média de ${Math.round(velMediaGeral)} km/h na última semana em ${estatisticas._count.id} viagens. Uma velocidade média baixa pode indicar congestionamentos frequentes ou rotas ineficientes.`,
          valor_depois: velMediaGeral,
          score: 40,
          prioridade: 'baixa'
        });
      }

      // Velocidade máxima extrema na frota
      if (velMaxGeral > 150) {
        insights.push({
          tipo: TIPOS.SEGURANCA,
          categoria: CATEGORIAS.ALERTA,
          titulo: `Velocidade extrema detectada: ${Math.round(velMaxGeral)} km/h`,
          descricao: `Foi registrada velocidade máxima de ${Math.round(velMaxGeral)} km/h na frota durante a última semana. Velocidades acima de 150 km/h representam alto risco de acidentes.`,
          valor_depois: velMaxGeral,
          score: 90,
          prioridade: 'critica'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar insights sobre ociosidade
   */
  async _gerarInsightsOciosidade(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar veículos com estado de ignição
    const veiculos = await prisma.veiculo.findMany({
      where: { organizacao_id },
      include: {
        dispositivos: {
          select: { id: true, imei: true, placa: true }
        }
      }
    });

    let totalOcioso = 0;
    let veiculosAnalisados = 0;

    for (const veiculo of veiculos) {
      if (veiculo.dispositivos.length === 0) continue;

      const dispositivoIds = veiculo.dispositivos.map(d => d.id);

      // Contar localizações com estado "idle" (ocioso)
      const ocioso = await prisma.localizacao.count({
        where: {
          dispositivo_id: { in: dispositivoIds },
          timestamp: { gte: periodo_inicio, lte: periodo_fim },
          estado_ignicao: 'idle'
        }
      });

      const total = await prisma.localizacao.count({
        where: {
          dispositivo_id: { in: dispositivoIds },
          timestamp: { gte: periodo_inicio, lte: periodo_fim }
        }
      });

      if (total > 100) {
        const percentualOcioso = (ocioso / total) * 100;
        totalOcioso += percentualOcioso;
        veiculosAnalisados++;

        // Veículo com alta ociosidade
        if (percentualOcioso > 40) {
          insights.push({
            tipo: TIPOS.CUSTO,
            categoria: CATEGORIAS.ALERTA,
            veiculo_id: veiculo.id,
            titulo: `Veículo ${veiculo.placa}: ${Math.round(percentualOcioso)}% do tempo ocioso`,
            descricao: `O veículo ${veiculo.placa} permaneceu ocioso (motor ligado parado) em ${Math.round(percentualOcioso)}% do tempo de operação. Isso representa desperdício de combustível e pode indicar esperas excessivas.`,
            valor_depois: percentualOcioso,
            score: Math.min(100, percentualOcioso),
            prioridade: percentualOcioso > 60 ? 'alta' : 'normal'
          });
        }
      }
    }

    // Insight geral de ociosidade da frota
    if (veiculosAnalisados > 3) {
      const mediaOciosidade = totalOcioso / veiculosAnalisados;

      if (mediaOciosidade > 25) {
        insights.push({
          tipo: TIPOS.FROTA,
          categoria: CATEGORIAS.CUSTO,
          titulo: `Frota com ${Math.round(mediaOciosidade)}% de ociosidade média`,
          descricao: `A frota apresentou ociosidade média de ${Math.round(mediaOciosidade)}% na última semana. Reduzir o tempo ocioso pode gerar economia significativa de combustível.`,
          valor_depois: mediaOciosidade,
          score: Math.min(100, mediaOciosidade * 2),
          prioridade: mediaOciosidade > 40 ? 'alta' : 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Resumo de insights para dashboard
   */
  async getResumo(organizacao_id) {
    const [
      totalNaoLidos,
      porTipo,
      porPrioridade,
      ultimoGerado
    ] = await Promise.all([
      prisma.insightIA.count({
        where: { organizacao_id, lido: false, arquivado: false }
      }),
      prisma.insightIA.groupBy({
        by: ['tipo'],
        where: { organizacao_id, arquivado: false },
        _count: { id: true }
      }),
      prisma.insightIA.groupBy({
        by: ['prioridade'],
        where: { organizacao_id, lido: false, arquivado: false },
        _count: { id: true }
      }),
      prisma.insightIA.findFirst({
        where: { organizacao_id },
        orderBy: { created_at: 'desc' },
        select: { created_at: true }
      })
    ]);

    return {
      totalNaoLidos,
      porTipo: Object.fromEntries(porTipo.map(t => [t.tipo, t._count.id])),
      porPrioridade: Object.fromEntries(porPrioridade.map(p => [p.prioridade, p._count.id])),
      ultimoGerado: ultimoGerado?.created_at || null,
      criticos: porPrioridade.find(p => p.prioridade === 'critica')?._count.id || 0
    };
  }
}

module.exports = new InsightService();
module.exports.TIPOS = TIPOS;
module.exports.CATEGORIAS = CATEGORIAS;
