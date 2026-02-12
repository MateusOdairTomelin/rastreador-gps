/**
 * Serviço de estatísticas e limpeza de caches em memória
 * Centraliza o gerenciamento de todos os Maps usados pelo sistema
 *
 * LGPD: Esses caches armazenam apenas dados técnicos (IMEI, IP, timestamps)
 * Dados pessoais (localizações, informações de usuários) estão no banco de dados
 */

class CacheStatsService {
  constructor() {
    // Referências aos Maps (serão registrados pelo index.js)
    this.registeredMaps = {};
  }

  /**
   * Registra um Map para monitoramento e limpeza
   * @param {string} name - Nome do Map
   * @param {Map} map - Referência ao Map
   * @param {Object} config - Configuração de limpeza
   * @param {number} config.maxAgeMs - Idade máxima das entradas em ms
   * @param {string} config.timestampField - Campo que contém o timestamp (ou função)
   */
  registerMap(name, map, config = {}) {
    this.registeredMaps[name] = { map, config };
  }

  /**
   * Retorna estatísticas de todos os Maps registrados
   */
  getStats() {
    const stats = {};
    for (const [name, { map }] of Object.entries(this.registeredMaps)) {
      stats[name] = map.size;
    }
    return stats;
  }

  /**
   * Retorna estatísticas detalhadas com exemplos de dados (sem dados sensíveis)
   */
  getDetailedStats() {
    const stats = {};
    for (const [name, { map, config }] of Object.entries(this.registeredMaps)) {
      stats[name] = {
        size: map.size,
        maxAgeMs: config.maxAgeMs || 'N/A',
        description: config.description || ''
      };
    }
    return stats;
  }

  /**
   * Limpa entradas antigas de todos os Maps registrados
   * @returns {Object} Estatísticas de limpeza por Map
   */
  cleanupAll() {
    const now = Date.now();
    const results = {};

    for (const [name, { map, config }] of Object.entries(this.registeredMaps)) {
      if (!config.maxAgeMs || !config.getTimestamp) {
        results[name] = { skipped: true, reason: 'no cleanup config' };
        continue;
      }

      let removed = 0;
      for (const [key, value] of map) {
        const timestamp = config.getTimestamp(value);
        if (timestamp && (now - timestamp) > config.maxAgeMs) {
          map.delete(key);
          removed++;
        }
      }
      results[name] = { removed, remaining: map.size };
    }

    return results;
  }

  /**
   * Limpa entradas de um Map específico
   * @param {string} name - Nome do Map
   * @returns {number} Quantidade de entradas removidas
   */
  cleanupMap(name) {
    const mapInfo = this.registeredMaps[name];
    if (!mapInfo) return 0;

    const { map, config } = mapInfo;
    if (!config.maxAgeMs || !config.getTimestamp) return 0;

    const now = Date.now();
    let removed = 0;

    for (const [key, value] of map) {
      const timestamp = config.getTimestamp(value);
      if (timestamp && (now - timestamp) > config.maxAgeMs) {
        map.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Retorna o total de entradas em todos os Maps
   */
  getTotalEntries() {
    let total = 0;
    for (const { map } of Object.values(this.registeredMaps)) {
      total += map.size;
    }
    return total;
  }
}

module.exports = new CacheStatsService();
