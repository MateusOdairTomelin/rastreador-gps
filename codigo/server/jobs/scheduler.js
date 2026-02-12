/**
 * Scheduler de Jobs
 *
 * Gerencia a execução de tarefas agendadas usando node-cron
 * Cada job é executado em horários específicos
 */

const cron = require('node-cron');
const multasJob = require('./multas.job');

class Scheduler {
  constructor() {
    this.jobs = [];
    this.isRunning = false;
  }

  /**
   * Inicializar todos os jobs agendados
   */
  start() {
    if (this.isRunning) {
      console.log('[Scheduler] Já está em execução');
      return;
    }

    console.log('[Scheduler] Iniciando jobs agendados...');

    // ============ JOBS DE MULTAS ============

    // Marcar multas vencidas - todo dia às 00:05
    this.addJob('multas-vencidas', '5 0 * * *', async () => {
      try {
        await multasJob.marcarVencidas();
      } catch (error) {
        console.error('[Scheduler] Erro no job multas-vencidas:', error.message);
      }
    });

    // Alertar multas próximas do vencimento - todo dia às 08:00
    this.addJob('multas-alertar-vencimento', '0 8 * * *', async () => {
      try {
        await multasJob.alertarProximasVencer();
      } catch (error) {
        console.error('[Scheduler] Erro no job multas-alertar-vencimento:', error.message);
      }
    });

    // Alertar NIC pendente - todo dia às 08:30
    this.addJob('nic-pendente', '30 8 * * *', async () => {
      try {
        await multasJob.alertarNICPendente();
      } catch (error) {
        console.error('[Scheduler] Erro no job nic-pendente:', error.message);
      }
    });

    // Verificar descontos expirados - todo dia às 00:10
    this.addJob('descontos-expirados', '10 0 * * *', async () => {
      try {
        await multasJob.atualizarDescontosExpirados();
      } catch (error) {
        console.error('[Scheduler] Erro no job descontos-expirados:', error.message);
      }
    });

    this.isRunning = true;
    console.log(`[Scheduler] ${this.jobs.length} jobs agendados`);

    // Listar jobs
    this.jobs.forEach(job => {
      console.log(`  - ${job.name}: ${job.schedule}`);
    });
  }

  /**
   * Adicionar um job ao scheduler
   */
  addJob(name, schedule, task) {
    if (!cron.validate(schedule)) {
      console.error(`[Scheduler] Expressão cron inválida para ${name}: ${schedule}`);
      return;
    }

    const job = cron.schedule(schedule, task, {
      timezone: 'America/Sao_Paulo'
    });

    this.jobs.push({ name, schedule, job });
  }

  /**
   * Parar todos os jobs
   */
  stop() {
    console.log('[Scheduler] Parando jobs...');
    this.jobs.forEach(({ name, job }) => {
      job.stop();
      console.log(`  - ${name} parado`);
    });
    this.isRunning = false;
  }

  /**
   * Executar um job manualmente (para testes ou execução forçada)
   */
  async runNow(jobName) {
    console.log(`[Scheduler] Executando job manualmente: ${jobName}`);

    switch (jobName) {
      case 'multas-vencidas':
        return await multasJob.marcarVencidas();
      case 'multas-alertar-vencimento':
        return await multasJob.alertarProximasVencer();
      case 'nic-pendente':
        return await multasJob.alertarNICPendente();
      case 'descontos-expirados':
        return await multasJob.atualizarDescontosExpirados();
      default:
        throw new Error(`Job não encontrado: ${jobName}`);
    }
  }

  /**
   * Listar jobs registrados
   */
  listJobs() {
    return this.jobs.map(({ name, schedule }) => ({ name, schedule }));
  }
}

// Singleton
const scheduler = new Scheduler();

module.exports = scheduler;
