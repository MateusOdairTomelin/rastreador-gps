/**
 * System Monitor Service
 * Coleta metricas do sistema: CPU, RAM, Disco, Rede, Uptime
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

class SystemMonitorService {
  constructor() {
    this.startTime = Date.now();
    this.previousCpuInfo = null;
  }

  /**
   * Formata bytes para unidade legivel
   */
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
  }

  /**
   * Formata segundos para tempo legivel
   */
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Calcula uso de CPU (media entre todas as cores)
   */
  getCpuUsage() {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - (100 * idle / total);

    return {
      usage: parseFloat(usage.toFixed(1)),
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown',
      speed: cpus[0]?.speed || 0, // MHz
    };
  }

  /**
   * Obtem informacoes de memoria
   */
  getMemoryInfo() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usagePercent = (usedMem / totalMem) * 100;

    return {
      total: totalMem,
      totalFormatted: this.formatBytes(totalMem),
      free: freeMem,
      freeFormatted: this.formatBytes(freeMem),
      used: usedMem,
      usedFormatted: this.formatBytes(usedMem),
      usage: parseFloat(usagePercent.toFixed(1)),
    };
  }

  /**
   * Obtem informacoes de disco (async para Linux)
   */
  async getDiskInfo() {
    return new Promise((resolve) => {
      const { exec } = require('child_process');

      // Comando para obter uso de disco no Linux
      exec("df -B1 / | tail -1 | awk '{print $2,$3,$4,$5}'", (error, stdout) => {
        if (error) {
          // Fallback se o comando falhar
          resolve({
            total: 0,
            totalFormatted: 'N/A',
            used: 0,
            usedFormatted: 'N/A',
            free: 0,
            freeFormatted: 'N/A',
            usage: 0,
          });
          return;
        }

        const parts = stdout.trim().split(' ');
        if (parts.length >= 4) {
          const total = parseInt(parts[0]) || 0;
          const used = parseInt(parts[1]) || 0;
          const free = parseInt(parts[2]) || 0;
          const usage = parseFloat(parts[3]) || 0;

          resolve({
            total,
            totalFormatted: this.formatBytes(total),
            used,
            usedFormatted: this.formatBytes(used),
            free,
            freeFormatted: this.formatBytes(free),
            usage: parseFloat(usage.toFixed(1)),
          });
        } else {
          resolve({
            total: 0,
            totalFormatted: 'N/A',
            used: 0,
            usedFormatted: 'N/A',
            free: 0,
            freeFormatted: 'N/A',
            usage: 0,
          });
        }
      });
    });
  }

  /**
   * Obtem informacoes de rede
   */
  getNetworkInfo() {
    const interfaces = os.networkInterfaces();
    const result = [];

    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;

      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          result.push({
            interface: name,
            address: addr.address,
            mac: addr.mac,
          });
        }
      }
    }

    return result;
  }

  /**
   * Obtem load average (Linux)
   */
  getLoadAverage() {
    const loadavg = os.loadavg();
    return {
      '1min': parseFloat(loadavg[0].toFixed(2)),
      '5min': parseFloat(loadavg[1].toFixed(2)),
      '15min': parseFloat(loadavg[2].toFixed(2)),
    };
  }

  /**
   * Obtem informacoes do processo Node.js
   */
  getProcessInfo() {
    const memUsage = process.memoryUsage();
    return {
      pid: process.pid,
      uptime: process.uptime(),
      uptimeFormatted: this.formatUptime(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rss: this.formatBytes(memUsage.rss),
        heapTotal: this.formatBytes(memUsage.heapTotal),
        heapUsed: this.formatBytes(memUsage.heapUsed),
        external: this.formatBytes(memUsage.external || 0),
      },
    };
  }

  /**
   * Obtem informacoes do sistema operacional
   */
  getOsInfo() {
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      type: os.type(),
      uptime: os.uptime(),
      uptimeFormatted: this.formatUptime(os.uptime()),
    };
  }

  /**
   * Verifica saude do sistema e retorna alertas
   */
  getHealthAlerts(metrics) {
    const alerts = [];

    // Alerta de CPU
    if (metrics.cpu.usage > 90) {
      alerts.push({ level: 'critical', message: `CPU em ${metrics.cpu.usage}% - Sobrecarga!` });
    } else if (metrics.cpu.usage > 75) {
      alerts.push({ level: 'warning', message: `CPU em ${metrics.cpu.usage}% - Atenção` });
    }

    // Alerta de Memoria
    if (metrics.memory.usage > 90) {
      alerts.push({ level: 'critical', message: `Memória em ${metrics.memory.usage}% - Crítico!` });
    } else if (metrics.memory.usage > 80) {
      alerts.push({ level: 'warning', message: `Memória em ${metrics.memory.usage}% - Atenção` });
    }

    // Alerta de Disco
    if (metrics.disk.usage > 90) {
      alerts.push({ level: 'critical', message: `Disco em ${metrics.disk.usage}% - Espaço crítico!` });
    } else if (metrics.disk.usage > 80) {
      alerts.push({ level: 'warning', message: `Disco em ${metrics.disk.usage}% - Espaço baixo` });
    }

    // Alerta de Load Average (se maior que numero de cores)
    const loadThreshold = metrics.cpu.cores;
    if (metrics.loadAverage['1min'] > loadThreshold * 2) {
      alerts.push({ level: 'critical', message: `Load Average em ${metrics.loadAverage['1min']} - Sistema sobrecarregado!` });
    } else if (metrics.loadAverage['1min'] > loadThreshold) {
      alerts.push({ level: 'warning', message: `Load Average em ${metrics.loadAverage['1min']} - Atenção` });
    }

    return alerts;
  }

  /**
   * Coleta todas as metricas do sistema
   */
  async getAll() {
    const cpu = this.getCpuUsage();
    const memory = this.getMemoryInfo();
    const disk = await this.getDiskInfo();
    const network = this.getNetworkInfo();
    const loadAverage = this.getLoadAverage();
    const process = this.getProcessInfo();
    const os = this.getOsInfo();

    const metrics = {
      cpu,
      memory,
      disk,
      network,
      loadAverage,
      process,
      os,
      timestamp: new Date().toISOString(),
    };

    // Adicionar alertas
    metrics.alerts = this.getHealthAlerts(metrics);
    metrics.healthStatus = metrics.alerts.some(a => a.level === 'critical')
      ? 'critical'
      : metrics.alerts.some(a => a.level === 'warning')
        ? 'warning'
        : 'healthy';

    return metrics;
  }

  /**
   * Retorna resumo rapido (para polling frequente)
   */
  getQuickStats() {
    const cpu = this.getCpuUsage();
    const memory = this.getMemoryInfo();
    const loadAverage = this.getLoadAverage();
    const processInfo = this.getProcessInfo();

    return {
      cpu: {
        usage: cpu.usage,
        cores: cpu.cores,
      },
      memory: {
        usage: memory.usage,
        usedFormatted: memory.usedFormatted,
        totalFormatted: memory.totalFormatted,
      },
      loadAverage,
      process: {
        uptime: processInfo.uptimeFormatted,
        memory: processInfo.memory.heapUsed,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = new SystemMonitorService();
