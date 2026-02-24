/**
 * Job de Geração Automática de Insights
 *
 * Executa diariamente para analisar dados da frota e gerar insights
 * - Analisa padrões de motoristas
 * - Detecta anomalias em veículos
 * - Identifica tendências de uso
 * - Gera alertas de segurança
 */

const insightService = require('../services/insight.service');
const prisma = require('../db/prisma');

class InsightsJob {
  constructor() {
    this.lastRun = null;
    this.stats = { total: 0, sucesso: 0, falhas: 0 };
  }

  /**
   * Gerar insights para todas as organizações
   * Executado diariamente às 06:00
   */
  async gerarInsightsDiarios() {
    console.log('[InsightsJob] Iniciando geração diária de insights...');
    const inicio = Date.now();

    try {
      // Buscar todas as organizações ativas
      const organizacoes = await prisma.organizacao.findMany({
        where: { ativo: true },
        select: { id: true, nome: true }
      });

      console.log(`[InsightsJob] ${organizacoes.length} organizações ativas`);

      let totalGerados = 0;
      let orgComInsights = 0;

      for (const org of organizacoes) {
        try {
          const resultado = await insightService.gerarInsights(org.id);

          if (resultado.gerados > 0) {
            totalGerados += resultado.gerados;
            orgComInsights++;
            console.log(`[InsightsJob] Org ${org.id}: ${resultado.gerados} insights gerados`);
          }
        } catch (error) {
          console.error(`[InsightsJob] Erro na org ${org.id}:`, error.message);
          this.stats.falhas++;
        }
      }

      const duracao = ((Date.now() - inicio) / 1000).toFixed(1);
      this.lastRun = new Date();
      this.stats.total++;
      this.stats.sucesso++;

      console.log(`[InsightsJob] Concluído em ${duracao}s: ${totalGerados} insights em ${orgComInsights} orgs`);

      return { totalGerados, orgComInsights, duracao };
    } catch (error) {
      this.stats.falhas++;
      console.error('[InsightsJob] Erro fatal:', error.message);
      throw error;
    }
  }

  /**
   * Limpar insights antigos (> 30 dias) e já lidos
   * Executado semanalmente aos domingos às 03:00
   */
  async limparInsightsAntigos() {
    console.log('[InsightsJob] Limpando insights antigos...');

    try {
      // Deletar insights lidos com mais de 30 dias
      const resultado = await prisma.insightIA.deleteMany({
        where: {
          lido: true,
          created_at: {
            lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      });

      // Deletar insights arquivados com mais de 7 dias
      const arquivados = await prisma.insightIA.deleteMany({
        where: {
          arquivado: true,
          updated_at: {
            lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }
      });

      console.log(`[InsightsJob] Removidos: ${resultado.count} lidos antigos, ${arquivados.count} arquivados`);

      return { removidosLidos: resultado.count, removidosArquivados: arquivados.count };
    } catch (error) {
      console.error('[InsightsJob] Erro ao limpar:', error.message);
      throw error;
    }
  }

  /**
   * Estatísticas do job
   */
  getStats() {
    return {
      lastRun: this.lastRun,
      ...this.stats
    };
  }
}

// Singleton
const insightsJob = new InsightsJob();

module.exports = insightsJob;
