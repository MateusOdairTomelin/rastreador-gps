/**
 * Serviço de Retenção de Dados - LGPD
 *
 * Gerencia a retenção e exclusão automática de dados conforme
 * políticas de privacidade e requisitos da LGPD.
 *
 * Políticas padrão (configuráveis via env):
 * - Localizações GPS: 90 dias
 * - Dados OBD2: 90 dias
 * - Viagens: 365 dias
 * - Alarmes: 90 dias
 * - Logs de auditoria: 5 anos (obrigação legal)
 * - Refresh tokens expirados: 30 dias
 * - Métricas do sistema: 7 dias
 */

const prisma = require('../db/prisma');

// Políticas de retenção (em dias)
const RETENTION_POLICIES = {
  localizacoes: parseInt(process.env.RETENTION_LOCALIZACOES) || 90,
  dados_obd2: parseInt(process.env.RETENTION_OBD2) || 90,
  viagens: parseInt(process.env.RETENTION_VIAGENS) || 365,
  alarmes: parseInt(process.env.RETENTION_ALARMES) || 90,
  audit_logs: parseInt(process.env.RETENTION_AUDIT_LOGS) || 1825, // 5 anos
  refresh_tokens: parseInt(process.env.RETENTION_REFRESH_TOKENS) || 30,
  geofence_eventos: parseInt(process.env.RETENTION_GEOFENCE_EVENTOS) || 90,
  notificacoes: parseInt(process.env.RETENTION_NOTIFICACOES) || 90,
  system_metrics: parseInt(process.env.RETENTION_METRICS) || 7
};

class DataRetentionService {
  constructor() {
    this.lastRun = null;
    this.stats = {};
  }

  /**
   * Obter data limite para retenção
   */
  getRetentionDate(days) {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date;
  }

  /**
   * Limpar localizações antigas
   */
  async cleanupLocalizacoes() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.localizacoes);

    const result = await prisma.localizacao.deleteMany({
      where: {
        timestamp: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} localizações excluídas (> ${RETENTION_POLICIES.localizacoes} dias)`);
    return result.count;
  }

  /**
   * Limpar dados OBD2 antigos
   */
  async cleanupDadosOBD2() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.dados_obd2);

    const result = await prisma.dadosOBD2.deleteMany({
      where: {
        timestamp: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} registros OBD2 excluídos (> ${RETENTION_POLICIES.dados_obd2} dias)`);
    return result.count;
  }

  /**
   * Limpar viagens antigas
   */
  async cleanupViagens() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.viagens);

    const result = await prisma.viagem.deleteMany({
      where: {
        inicio: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} viagens excluídas (> ${RETENTION_POLICIES.viagens} dias)`);
    return result.count;
  }

  /**
   * Limpar alarmes antigos
   */
  async cleanupAlarmes() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.alarmes);

    const result = await prisma.alarme.deleteMany({
      where: {
        timestamp: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} alarmes excluídos (> ${RETENTION_POLICIES.alarmes} dias)`);
    return result.count;
  }

  /**
   * Limpar logs de auditoria antigos (manter conforme obrigação legal)
   */
  async cleanupAuditLogs() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.audit_logs);

    const result = await prisma.auditLog.deleteMany({
      where: {
        created_at: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} logs de auditoria excluídos (> ${RETENTION_POLICIES.audit_logs} dias)`);
    return result.count;
  }

  /**
   * Limpar refresh tokens expirados
   */
  async cleanupRefreshTokens() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.refresh_tokens);

    const result = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { createdAt: { lt: dataLimite }, revoked: true }
        ]
      }
    });

    console.log(`[LGPD Retention] ${result.count} refresh tokens expirados excluídos`);
    return result.count;
  }

  /**
   * Limpar eventos de geofence antigos
   */
  async cleanupGeofenceEventos() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.geofence_eventos);

    const result = await prisma.geofenceEvento.deleteMany({
      where: {
        timestamp: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} eventos de geofence excluídos (> ${RETENTION_POLICIES.geofence_eventos} dias)`);
    return result.count;
  }

  /**
   * Limpar notificações antigas
   */
  async cleanupNotificacoes() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.notificacoes);

    const result = await prisma.notificacao.deleteMany({
      where: {
        created_at: { lt: dataLimite },
        lida: true // Apenas notificações já lidas
      }
    });

    console.log(`[LGPD Retention] ${result.count} notificações excluídas (> ${RETENTION_POLICIES.notificacoes} dias, lidas)`);
    return result.count;
  }

  /**
   * Limpar métricas do sistema antigas
   */
  async cleanupSystemMetrics() {
    const dataLimite = this.getRetentionDate(RETENTION_POLICIES.system_metrics);

    const result = await prisma.systemMetric.deleteMany({
      where: {
        timestamp: { lt: dataLimite }
      }
    });

    console.log(`[LGPD Retention] ${result.count} métricas do sistema excluídas (> ${RETENTION_POLICIES.system_metrics} dias)`);
    return result.count;
  }

  /**
   * Executar limpeza completa
   */
  async runFullCleanup() {
    console.log('[LGPD Retention] ========================================');
    console.log('[LGPD Retention] Iniciando limpeza automática de dados...');
    console.log('[LGPD Retention] ========================================');

    const stats = {
      localizacoes: 0,
      dados_obd2: 0,
      viagens: 0,
      alarmes: 0,
      audit_logs: 0,
      refresh_tokens: 0,
      geofence_eventos: 0,
      notificacoes: 0,
      system_metrics: 0,
      errors: []
    };

    const startTime = Date.now();

    // Executar cada limpeza com tratamento de erro individual
    try {
      stats.localizacoes = await this.cleanupLocalizacoes();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar localizações:', error.message);
      stats.errors.push({ table: 'localizacoes', error: error.message });
    }

    try {
      stats.dados_obd2 = await this.cleanupDadosOBD2();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar OBD2:', error.message);
      stats.errors.push({ table: 'dados_obd2', error: error.message });
    }

    try {
      stats.viagens = await this.cleanupViagens();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar viagens:', error.message);
      stats.errors.push({ table: 'viagens', error: error.message });
    }

    try {
      stats.alarmes = await this.cleanupAlarmes();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar alarmes:', error.message);
      stats.errors.push({ table: 'alarmes', error: error.message });
    }

    try {
      stats.audit_logs = await this.cleanupAuditLogs();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar audit logs:', error.message);
      stats.errors.push({ table: 'audit_logs', error: error.message });
    }

    try {
      stats.refresh_tokens = await this.cleanupRefreshTokens();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar refresh tokens:', error.message);
      stats.errors.push({ table: 'refresh_tokens', error: error.message });
    }

    try {
      stats.geofence_eventos = await this.cleanupGeofenceEventos();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar geofence eventos:', error.message);
      stats.errors.push({ table: 'geofence_eventos', error: error.message });
    }

    try {
      stats.notificacoes = await this.cleanupNotificacoes();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar notificações:', error.message);
      stats.errors.push({ table: 'notificacoes', error: error.message });
    }

    try {
      stats.system_metrics = await this.cleanupSystemMetrics();
    } catch (error) {
      console.error('[LGPD Retention] Erro ao limpar métricas:', error.message);
      stats.errors.push({ table: 'system_metrics', error: error.message });
    }

    const duration = Date.now() - startTime;
    const totalExcluidos = Object.values(stats).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0);

    console.log('[LGPD Retention] ========================================');
    console.log('[LGPD Retention] Limpeza concluída!');
    console.log(`[LGPD Retention] Total de registros excluídos: ${totalExcluidos}`);
    console.log(`[LGPD Retention] Tempo de execução: ${duration}ms`);
    console.log(`[LGPD Retention] Erros: ${stats.errors.length}`);
    console.log('[LGPD Retention] ========================================');

    this.lastRun = new Date();
    this.stats = stats;

    return stats;
  }

  /**
   * Obter políticas de retenção atuais
   */
  getPolicies() {
    return RETENTION_POLICIES;
  }

  /**
   * Obter estatísticas da última execução
   */
  getLastRunStats() {
    return {
      lastRun: this.lastRun,
      stats: this.stats
    };
  }

  /**
   * Obter estimativa de dados a serem excluídos
   */
  async getCleanupEstimate() {
    const estimates = {};

    // Localizações
    const localizacoes = await prisma.localizacao.count({
      where: { timestamp: { lt: this.getRetentionDate(RETENTION_POLICIES.localizacoes) } }
    });
    estimates.localizacoes = { count: localizacoes, policy: `${RETENTION_POLICIES.localizacoes} dias` };

    // OBD2
    const obd2 = await prisma.dadosOBD2.count({
      where: { timestamp: { lt: this.getRetentionDate(RETENTION_POLICIES.dados_obd2) } }
    });
    estimates.dados_obd2 = { count: obd2, policy: `${RETENTION_POLICIES.dados_obd2} dias` };

    // Viagens
    const viagens = await prisma.viagem.count({
      where: { inicio: { lt: this.getRetentionDate(RETENTION_POLICIES.viagens) } }
    });
    estimates.viagens = { count: viagens, policy: `${RETENTION_POLICIES.viagens} dias` };

    // Alarmes
    const alarmes = await prisma.alarme.count({
      where: { timestamp: { lt: this.getRetentionDate(RETENTION_POLICIES.alarmes) } }
    });
    estimates.alarmes = { count: alarmes, policy: `${RETENTION_POLICIES.alarmes} dias` };

    return estimates;
  }
}

module.exports = new DataRetentionService();
