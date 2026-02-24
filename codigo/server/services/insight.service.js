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
        insightsOciosidade,
        insightsRanking,
        insightsManutencao,
        insightsPadroes,
        insightsAnomalias,
        insightsMultas
      ] = await Promise.all([
        this._gerarInsightsMotoristas(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsVeiculos(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsAlarmes(organizacao_id, periodo_inicio, periodo_fim, periodo_anterior_inicio, periodo_anterior_fim),
        this._gerarInsightsVelocidade(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsOciosidade(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsRanking(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsManutencao(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsPadroesTemporais(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsAnomalias(organizacao_id, periodo_inicio, periodo_fim),
        this._gerarInsightsMultas(organizacao_id, periodo_inicio, periodo_fim)
      ]);

      insights.push(
        ...insightsMotorista,
        ...insightsVeiculo,
        ...insightsAlarmes,
        ...insightsVelocidade,
        ...insightsOciosidade,
        ...insightsRanking,
        ...insightsManutencao,
        ...insightsPadroes,
        ...insightsAnomalias,
        ...insightsMultas
      );

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
            acao_recomendada: variacaoKm > 0
              ? 'Verifique se há rotas alternativas mais curtas ou otimize o planejamento de entregas.'
              : 'Investigue o motivo da redução. Verifique se há problemas operacionais ou com o veículo.',
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
          acao_recomendada: velMaxAtual > 150
            ? 'Aplique advertência e agende treinamento de direção defensiva urgente.'
            : 'Converse com o motorista sobre condução segura e configure alertas de velocidade no veículo.',
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
          acao_recomendada: 'Verifique o status do rastreador e se o veículo está em manutenção. Considere redistribuir a frota se estiver ocioso.',
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
          acao_recomendada: kmTotal > 3000
            ? 'Agende manutenção preventiva urgente. Verifique pneus, óleo e freios.'
            : 'Acompanhe o desgaste do veículo e verifique se a próxima revisão está em dia.',
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
          // Gerar ação recomendada baseada no tipo de alarme
          let acaoRecomendada = 'Analise os eventos detalhadamente no relatório de alarmes.';
          const tipoLower = alarme.tipo_alarme.toLowerCase();
          if (tipoLower.includes('velocidade') || tipoLower.includes('speed')) {
            acaoRecomendada = 'Configure cercas de velocidade e agende treinamento de direção defensiva para os motoristas.';
          } else if (tipoLower.includes('freada') || tipoLower.includes('brake')) {
            acaoRecomendada = 'Verifique o estado dos freios dos veículos e oriente os motoristas sobre direção preventiva.';
          } else if (tipoLower.includes('cerca') || tipoLower.includes('geofence')) {
            acaoRecomendada = 'Revise as configurações das cercas eletrônicas e verifique se estão corretas.';
          } else if (tipoLower.includes('bateria') || tipoLower.includes('battery')) {
            acaoRecomendada = 'Verifique o sistema elétrico dos veículos e a condição das baterias.';
          } else if (tipoLower.includes('desconex') || tipoLower.includes('disconnect')) {
            acaoRecomendada = 'Verifique a instalação dos rastreadores e possíveis tentativas de sabotagem.';
          }

          insights.push({
            tipo: TIPOS.SEGURANCA,
            categoria: CATEGORIAS.ALERTA,
            titulo: `Aumento de ${Math.round(variacao)}% em alarmes de "${alarme.tipo_alarme}"`,
            descricao: `A frota apresentou ${countAtual} eventos de "${alarme.tipo_alarme}" na última semana, um aumento de ${Math.round(variacao)}% em relação à semana anterior (${countAnterior} eventos).`,
            acao_recomendada: acaoRecomendada,
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
          acao_recomendada: 'Analise os trajetos no mapa e identifique horários/rotas com congestionamento. Considere ajustar horários de saída.',
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
          acao_recomendada: 'Identifique o motorista responsável imediatamente. Aplique medidas disciplinares e agende treinamento obrigatório.',
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
            acao_recomendada: percentualOcioso > 60
              ? 'Instale sistema de corte de marcha lenta automático ou oriente o motorista a desligar o veículo em paradas longas.'
              : 'Oriente o motorista a desligar o motor em paradas superiores a 2 minutos para economizar combustível.',
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
          acao_recomendada: 'Implemente política de desligamento do motor em paradas. Considere metas de redução de ociosidade com bonificação.',
          valor_depois: mediaOciosidade,
          score: Math.min(100, mediaOciosidade * 2),
          prioridade: mediaOciosidade > 40 ? 'alta' : 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar ranking de motoristas por eficiência
   */
  async _gerarInsightsRanking(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar motoristas com viagens
    const motoristas = await prisma.motorista.findMany({
      where: { organizacao_id, ativo: true },
      include: {
        viagens: {
          where: {
            inicio: { gte: periodo_inicio, lte: periodo_fim }
          },
          select: {
            distancia_km: true,
            duracao_minutos: true,
            velocidade_media: true,
            velocidade_max: true,
            consumo_combustivel: true
          }
        }
      }
    });

    // Calcular score de eficiência para cada motorista
    const rankings = motoristas
      .filter(m => m.viagens.length >= 3)
      .map(m => {
        const km = m.viagens.reduce((s, v) => s + (v.distancia_km || 0), 0);
        const velMedia = m.viagens.reduce((s, v) => s + (v.velocidade_media || 0), 0) / m.viagens.length;
        const velMax = Math.max(...m.viagens.map(v => v.velocidade_max || 0));
        const consumo = m.viagens.reduce((s, v) => s + (v.consumo_combustivel || 0), 0);

        // Score: quanto menor a velocidade máxima e melhor o consumo, maior o score
        const penalVelocidade = velMax > 120 ? (velMax - 120) * 2 : 0;
        const score = 100 - penalVelocidade;

        return { motorista: m, km, velMedia, velMax, consumo, score, viagens: m.viagens.length };
      })
      .sort((a, b) => b.score - a.score);

    if (rankings.length >= 3) {
      // Melhor motorista
      const melhor = rankings[0];
      insights.push({
        tipo: TIPOS.MOTORISTA,
        categoria: CATEGORIAS.MELHORIA,
        motorista_id: melhor.motorista.id,
        titulo: `${melhor.motorista.nome} é o motorista mais eficiente`,
        descricao: `${melhor.motorista.nome} lidera o ranking de eficiência com ${Math.round(melhor.km)} km percorridos, velocidade média de ${Math.round(melhor.velMedia)} km/h e velocidade máxima de ${Math.round(melhor.velMax)} km/h.`,
        acao_recomendada: 'Considere bonificar este motorista e usar seu comportamento como exemplo para os demais.',
        valor_depois: melhor.score,
        score: 70,
        prioridade: 'normal'
      });

      // Motorista que precisa melhorar
      const pior = rankings[rankings.length - 1];
      if (pior.score < 60) {
        insights.push({
          tipo: TIPOS.MOTORISTA,
          categoria: CATEGORIAS.ALERTA,
          motorista_id: pior.motorista.id,
          titulo: `${pior.motorista.nome} precisa melhorar a condução`,
          descricao: `${pior.motorista.nome} está no final do ranking de eficiência, com velocidade máxima de ${Math.round(pior.velMax)} km/h e score de ${Math.round(pior.score)}/100.`,
          acao_recomendada: 'Agende uma conversa com o motorista e ofereça treinamento de direção econômica e segura.',
          valor_depois: pior.score,
          score: 60,
          prioridade: 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar insights de previsão de manutenção
   */
  async _gerarInsightsManutencao(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar veículos com odômetro
    const veiculos = await prisma.veiculo.findMany({
      where: { organizacao_id },
      include: {
        dispositivos: {
          select: { odometro_total: true, horimetro_total: true }
        }
      }
    });

    for (const veiculo of veiculos) {
      if (veiculo.dispositivos.length === 0) continue;

      const odometro = veiculo.dispositivos[0].odometro_total || 0;
      const horimetro = veiculo.dispositivos[0].horimetro_total || 0;

      // Verificar marcos de manutenção
      const proximaRevisao = Math.ceil(odometro / 10000) * 10000;
      const kmParaRevisao = proximaRevisao - odometro;

      if (kmParaRevisao <= 500 && kmParaRevisao > 0) {
        insights.push({
          tipo: TIPOS.VEICULO,
          categoria: CATEGORIAS.ALERTA,
          veiculo_id: veiculo.id,
          titulo: `${veiculo.placa} próximo da revisão (${Math.round(kmParaRevisao)} km)`,
          descricao: `O veículo ${veiculo.placa} está a ${Math.round(kmParaRevisao)} km da próxima revisão (${proximaRevisao.toLocaleString()} km). Odômetro atual: ${odometro.toLocaleString()} km.`,
          acao_recomendada: 'Agende a revisão preventiva agora para evitar paradas não programadas.',
          valor_depois: odometro,
          score: 80,
          prioridade: 'alta'
        });
      } else if (kmParaRevisao <= 1500 && kmParaRevisao > 500) {
        insights.push({
          tipo: TIPOS.VEICULO,
          categoria: CATEGORIAS.TENDENCIA,
          veiculo_id: veiculo.id,
          titulo: `${veiculo.placa} revisão em ${Math.round(kmParaRevisao)} km`,
          descricao: `O veículo ${veiculo.placa} precisa de revisão em aproximadamente ${Math.round(kmParaRevisao)} km. Considere agendar a manutenção preventiva.`,
          acao_recomendada: 'Planeje a revisão para a próxima semana, evitando dias de alta demanda.',
          valor_depois: odometro,
          score: 50,
          prioridade: 'normal'
        });
      }
    }

    return insights;
  }

  /**
   * Gerar insights de padrões temporais
   */
  async _gerarInsightsPadroesTemporais(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar viagens agrupadas por dia da semana
    const viagens = await prisma.viagem.findMany({
      where: {
        dispositivo: { organizacao_id },
        inicio: { gte: periodo_inicio, lte: periodo_fim }
      },
      select: { inicio: true, distancia_km: true, duracao_minutos: true }
    });

    if (viagens.length < 10) return insights;

    // Agrupar por dia da semana
    const diasSemana = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
    const porDia = {};

    viagens.forEach(v => {
      const dia = new Date(v.inicio).getDay();
      if (!porDia[dia]) porDia[dia] = { viagens: 0, km: 0 };
      porDia[dia].viagens++;
      porDia[dia].km += v.distancia_km || 0;
    });

    // Encontrar dia mais e menos produtivo
    const dias = Object.entries(porDia).map(([dia, data]) => ({ dia: parseInt(dia), ...data }));
    if (dias.length >= 3) {
      dias.sort((a, b) => b.km - a.km);

      const maisProdutivo = dias[0];
      const menosProdutivo = dias[dias.length - 1];

      insights.push({
        tipo: TIPOS.FROTA,
        categoria: CATEGORIAS.TENDENCIA,
        titulo: `${diasSemana[maisProdutivo.dia]} é o dia mais produtivo`,
        descricao: `A frota percorre em média ${Math.round(maisProdutivo.km)} km às ${diasSemana[maisProdutivo.dia]}s, com ${maisProdutivo.viagens} viagens. ${diasSemana[menosProdutivo.dia]} é o dia menos ativo (${Math.round(menosProdutivo.km)} km).`,
        acao_recomendada: `Considere redistribuir tarefas de ${diasSemana[maisProdutivo.dia]} para ${diasSemana[menosProdutivo.dia]} para equilibrar a demanda.`,
        valor_depois: maisProdutivo.km,
        score: 40,
        prioridade: 'baixa'
      });
    }

    // Agrupar por hora do dia
    const porHora = {};
    viagens.forEach(v => {
      const hora = new Date(v.inicio).getHours();
      if (!porHora[hora]) porHora[hora] = 0;
      porHora[hora]++;
    });

    const horas = Object.entries(porHora).map(([hora, count]) => ({ hora: parseInt(hora), count }));
    if (horas.length >= 5) {
      horas.sort((a, b) => b.count - a.count);
      const picoInicio = horas[0];

      insights.push({
        tipo: TIPOS.FROTA,
        categoria: CATEGORIAS.TENDENCIA,
        titulo: `Horário de pico: ${picoInicio.hora}h`,
        descricao: `A maior parte das viagens inicia às ${picoInicio.hora}h (${picoInicio.count} viagens na última semana). Planeje a logística considerando este horário.`,
        acao_recomendada: 'Garanta que os veículos estejam abastecidos e prontos antes deste horário de pico.',
        valor_depois: picoInicio.count,
        score: 35,
        prioridade: 'baixa'
      });
    }

    return insights;
  }

  /**
   * Gerar insights de anomalias de comportamento
   */
  async _gerarInsightsAnomalias(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    // Buscar viagens com dados anômalos
    const viagens = await prisma.viagem.findMany({
      where: {
        dispositivo: { organizacao_id },
        inicio: { gte: periodo_inicio, lte: periodo_fim }
      },
      include: {
        motorista: { select: { id: true, nome: true } },
        dispositivo: {
          include: {
            veiculo: { select: { id: true, placa: true } }
          }
        }
      }
    });

    if (viagens.length < 5) return insights;

    // Calcular médias
    const mediaKm = viagens.reduce((s, v) => s + (v.distancia_km || 0), 0) / viagens.length;
    const mediaDuracao = viagens.reduce((s, v) => s + (v.duracao_minutos || 0), 0) / viagens.length;

    // Detectar viagens muito longas (2x a média)
    const viagensLongas = viagens.filter(v => (v.distancia_km || 0) > mediaKm * 2 && v.distancia_km > 100);

    if (viagensLongas.length > 0) {
      const maiorViagem = viagensLongas.sort((a, b) => (b.distancia_km || 0) - (a.distancia_km || 0))[0];
      const placa = maiorViagem.dispositivo?.veiculo?.placa || 'N/A';
      const motorista = maiorViagem.motorista?.nome || 'Não identificado';

      insights.push({
        tipo: TIPOS.FROTA,
        categoria: CATEGORIAS.ALERTA,
        titulo: `Viagem atípica: ${Math.round(maiorViagem.distancia_km)} km`,
        descricao: `O veículo ${placa} (motorista: ${motorista}) realizou uma viagem de ${Math.round(maiorViagem.distancia_km)} km, muito acima da média de ${Math.round(mediaKm)} km. Verifique se a rota foi adequada.`,
        acao_recomendada: 'Analise o trajeto no mapa e verifique se havia uma rota mais curta disponível.',
        veiculo_id: maiorViagem.dispositivo?.veiculo?.id,
        motorista_id: maiorViagem.motorista?.id,
        valor_depois: maiorViagem.distancia_km,
        score: 55,
        prioridade: 'normal'
      });
    }

    // Detectar viagens em horários incomuns (madrugada)
    const viagensMadrugada = viagens.filter(v => {
      const hora = new Date(v.inicio).getHours();
      return hora >= 0 && hora < 5;
    });

    if (viagensMadrugada.length > 0) {
      insights.push({
        tipo: TIPOS.SEGURANCA,
        categoria: CATEGORIAS.ALERTA,
        titulo: `${viagensMadrugada.length} viagens na madrugada`,
        descricao: `Foram detectadas ${viagensMadrugada.length} viagens iniciadas entre 00h e 05h na última semana. Viagens noturnas apresentam maior risco de acidentes.`,
        acao_recomendada: 'Avalie a necessidade dessas viagens noturnas. Se necessárias, garanta que os motoristas descansaram adequadamente.',
        valor_depois: viagensMadrugada.length,
        score: 60,
        prioridade: 'normal'
      });
    }

    return insights;
  }

  /**
   * Gerar insights de multas
   */
  async _gerarInsightsMultas(organizacao_id, periodo_inicio, periodo_fim) {
    const insights = [];

    try {
      // Buscar multas no período
      const multas = await prisma.multa.findMany({
        where: {
          organizacao_id,
          data_infracao: { gte: periodo_inicio, lte: periodo_fim }
        },
        include: {
          veiculo: { select: { id: true, placa: true } },
          motorista: { select: { id: true, nome: true } }
        }
      });

      if (multas.length === 0) return insights;

      const valorTotal = multas.reduce((s, m) => s + (m.valor || 0), 0);

      // Agrupar por motorista
      const porMotorista = {};
      multas.forEach(m => {
        if (m.motorista) {
          if (!porMotorista[m.motorista.id]) {
            porMotorista[m.motorista.id] = { motorista: m.motorista, count: 0, valor: 0 };
          }
          porMotorista[m.motorista.id].count++;
          porMotorista[m.motorista.id].valor += m.valor || 0;
        }
      });

      // Insight geral de multas
      insights.push({
        tipo: TIPOS.CUSTO,
        categoria: CATEGORIAS.ALERTA,
        titulo: `${multas.length} multas na última semana (R$ ${valorTotal.toFixed(2)})`,
        descricao: `A frota recebeu ${multas.length} multas totalizando R$ ${valorTotal.toFixed(2)} na última semana. Principais infrações devem ser analisadas.`,
        acao_recomendada: 'Identifique as infrações mais comuns e implemente treinamento específico para evitá-las.',
        valor_depois: valorTotal,
        score: Math.min(100, multas.length * 20),
        prioridade: multas.length > 5 ? 'critica' : multas.length > 2 ? 'alta' : 'normal'
      });

      // Motorista com mais multas
      const motoristasOrdenados = Object.values(porMotorista).sort((a, b) => b.count - a.count);
      if (motoristasOrdenados.length > 0 && motoristasOrdenados[0].count >= 2) {
        const piorMotorista = motoristasOrdenados[0];
        insights.push({
          tipo: TIPOS.MOTORISTA,
          categoria: CATEGORIAS.ALERTA,
          motorista_id: piorMotorista.motorista.id,
          titulo: `${piorMotorista.motorista.nome}: ${piorMotorista.count} multas`,
          descricao: `O motorista ${piorMotorista.motorista.nome} acumulou ${piorMotorista.count} multas (R$ ${piorMotorista.valor.toFixed(2)}) na última semana.`,
          acao_recomendada: 'Aplique advertência formal e agende reciclagem obrigatória de direção.',
          valor_depois: piorMotorista.count,
          score: 75,
          prioridade: piorMotorista.count >= 3 ? 'critica' : 'alta'
        });
      }
    } catch (error) {
      // Tabela de multas pode não existir
      console.log('[Insights] Tabela de multas não disponível');
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
