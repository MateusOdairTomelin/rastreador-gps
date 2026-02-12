/**
 * Serviço de Logging
 * Salva logs em arquivo com rotação e no banco de dados
 */
const fs = require('fs');
const path = require('path');
const prisma = require('../db/prisma');

class LoggerService {
  constructor() {
    this.logDir = path.join(__dirname, '../../logs');
    this.currentLogFile = null;
    this.currentDate = null;
    this.buffer = [];
    this.bufferSize = 100; // Salvar no banco a cada 100 logs
    this.flushInterval = null;

    // Criar diretório de logs se não existir
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Iniciar flush periódico
    this.startFlushInterval();
  }

  /**
   * Retorna nome do arquivo de log baseado na data
   */
  getLogFileName() {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logDir, `server-${dateStr}.log`);
  }

  /**
   * Garante que o arquivo de log correto está aberto
   */
  ensureLogFile() {
    const today = new Date().toISOString().split('T')[0];

    if (this.currentDate !== today) {
      this.currentDate = today;
      this.currentLogFile = this.getLogFileName();
    }
  }

  /**
   * Formata mensagem de log
   */
  formatMessage(nivel, categoria, mensagem, dados = null) {
    const timestamp = new Date().toISOString();
    const niveisEmoji = {
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌',
      debug: '🔍',
      success: '✅'
    };
    const emoji = niveisEmoji[nivel] || '📝';

    let logLine = `[${timestamp}] ${emoji} [${nivel.toUpperCase()}] [${categoria}] ${mensagem}`;

    if (dados) {
      logLine += ` | ${JSON.stringify(dados)}`;
    }

    return logLine;
  }

  /**
   * Escreve log em arquivo
   */
  writeToFile(logLine) {
    try {
      this.ensureLogFile();
      fs.appendFileSync(this.currentLogFile, logLine + '\n');
    } catch (error) {
      console.error('[Logger] Erro ao escrever em arquivo:', error.message);
    }
  }

  /**
   * Adiciona log ao buffer para salvar no banco
   */
  addToBuffer(nivel, categoria, mensagem, dados) {
    this.buffer.push({
      nivel,
      categoria,
      mensagem,
      dados: dados ? JSON.stringify(dados) : null,
      timestamp: new Date()
    });

    // Flush se buffer estiver cheio
    if (this.buffer.length >= this.bufferSize) {
      this.flushToDatabase();
    }
  }

  /**
   * Salva buffer no banco de dados
   */
  async flushToDatabase() {
    if (this.buffer.length === 0) return;

    const logsToSave = [...this.buffer];
    this.buffer = [];

    try {
      await prisma.logServidor.createMany({
        data: logsToSave
      });
    } catch (error) {
      console.error('[Logger] Erro ao salvar logs no banco:', error.message);
      // Restaurar logs ao buffer em caso de erro
      this.buffer = [...logsToSave, ...this.buffer];
    }
  }

  /**
   * Inicia flush periódico (a cada 30 segundos)
   */
  startFlushInterval() {
    this.flushInterval = setInterval(() => {
      this.flushToDatabase();
    }, 30000);
  }

  /**
   * Para o flush periódico
   */
  stopFlushInterval() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushToDatabase(); // Flush final
    }
  }

  /**
   * Log de nível INFO
   */
  info(categoria, mensagem, dados = null) {
    const logLine = this.formatMessage('info', categoria, mensagem, dados);
    console.log(logLine);
    this.writeToFile(logLine);
    this.addToBuffer('info', categoria, mensagem, dados);
  }

  /**
   * Log de nível WARN
   */
  warn(categoria, mensagem, dados = null) {
    const logLine = this.formatMessage('warn', categoria, mensagem, dados);
    console.warn(logLine);
    this.writeToFile(logLine);
    this.addToBuffer('warn', categoria, mensagem, dados);
  }

  /**
   * Log de nível ERROR
   */
  error(categoria, mensagem, dados = null) {
    const logLine = this.formatMessage('error', categoria, mensagem, dados);
    console.error(logLine);
    this.writeToFile(logLine);
    this.addToBuffer('error', categoria, mensagem, dados);
  }

  /**
   * Log de nível DEBUG
   */
  debug(categoria, mensagem, dados = null) {
    const logLine = this.formatMessage('debug', categoria, mensagem, dados);
    if (process.env.DEBUG === 'true') {
      console.log(logLine);
    }
    this.writeToFile(logLine);
    this.addToBuffer('debug', categoria, mensagem, dados);
  }

  /**
   * Log de nível SUCCESS
   */
  success(categoria, mensagem, dados = null) {
    const logLine = this.formatMessage('success', categoria, mensagem, dados);
    console.log(logLine);
    this.writeToFile(logLine);
    this.addToBuffer('info', categoria, mensagem, dados);
  }

  /**
   * Busca logs no banco por filtros
   */
  async search(options = {}) {
    const { nivel, categoria, startDate, endDate, limit = 100, offset = 0 } = options;

    try {
      const where = {};

      if (nivel) where.nivel = nivel;
      if (categoria) where.categoria = categoria;
      if (startDate || endDate) {
        where.timestamp = {};
        if (startDate) where.timestamp.gte = startDate;
        if (endDate) where.timestamp.lte = endDate;
      }

      const logs = await prisma.logServidor.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset
      });

      return logs;
    } catch (error) {
      console.error('[Logger] Erro ao buscar logs:', error.message);
      return [];
    }
  }

  /**
   * Conta logs por nível
   */
  async countByLevel(hours = 24) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - hours);

      const counts = await prisma.logServidor.groupBy({
        by: ['nivel'],
        where: {
          timestamp: { gte: cutoffDate }
        },
        _count: true
      });

      return counts.reduce((acc, item) => {
        acc[item.nivel] = item._count;
        return acc;
      }, {});
    } catch (error) {
      console.error('[Logger] Erro ao contar logs:', error.message);
      return {};
    }
  }

  /**
   * Limpa logs antigos
   */
  async cleanup(daysToKeep = 7) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      // Limpar do banco
      const dbResult = await prisma.logServidor.deleteMany({
        where: {
          timestamp: { lt: cutoffDate }
        }
      });

      // Limpar arquivos antigos
      const files = fs.readdirSync(this.logDir);
      let filesDeleted = 0;

      for (const file of files) {
        const filePath = path.join(this.logDir, file);
        const stat = fs.statSync(filePath);

        if (stat.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          filesDeleted++;
        }
      }

      console.log(`[Logger] Limpeza: ${dbResult.count} logs do banco, ${filesDeleted} arquivos removidos`);
      return { dbLogs: dbResult.count, files: filesDeleted };
    } catch (error) {
      console.error('[Logger] Erro na limpeza:', error.message);
      return { dbLogs: 0, files: 0 };
    }
  }

  /**
   * Lista arquivos de log disponíveis
   */
  listLogFiles() {
    try {
      const files = fs.readdirSync(this.logDir);
      return files
        .filter(f => f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          size: fs.statSync(path.join(this.logDir, f)).size,
          modified: fs.statSync(path.join(this.logDir, f)).mtime
        }))
        .sort((a, b) => b.modified - a.modified);
    } catch (error) {
      console.error('[Logger] Erro ao listar arquivos:', error.message);
      return [];
    }
  }

  /**
   * Lê conteúdo de um arquivo de log
   */
  readLogFile(filename, lines = 100) {
    try {
      const filePath = path.join(this.logDir, filename);
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const allLines = content.split('\n').filter(l => l.trim());

      // Retornar últimas N linhas
      return allLines.slice(-lines);
    } catch (error) {
      console.error('[Logger] Erro ao ler arquivo:', error.message);
      return null;
    }
  }
}

module.exports = new LoggerService();
