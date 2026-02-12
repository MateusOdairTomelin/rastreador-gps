/**
 * Serviço de Detecção de Excesso de Velocidade
 *
 * Funcionalidades:
 * - Verificar se velocidade excede limite configurado
 * - Consultar limite da via (OSRM) ou usar limite customizado
 * - Tolerância de 10% antes de notificar
 * - Severidade baseada no excesso
 */

const prisma = require('../db/prisma');

// Serviço de limite de velocidade por via (com cache)
let velocidadeViaService = null;
try {
  velocidadeViaService = require('./velocidade-via.service');
  console.log('[Velocidade Notificação] Serviço de limite de via carregado');
} catch (e) {
  console.warn('[Velocidade Notificação] Serviço de limite de via não disponível:', e.message);
}

// Lazy load para evitar circular dependency
let notificationService = null;
const getNotificationService = () => {
  if (!notificationService) {
    try {
      notificationService = require('./notification.service');
    } catch (e) {
      console.warn('[Velocidade] Serviço de notificações não disponível:', e.message);
    }
  }
  return notificationService;
};

// Cache de configurações (TTL 5 min)
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

// Cooldown para evitar notificações em excesso
const cooldownMap = new Map(); // "dispositivo_id" -> timestamp
const COOLDOWN_DEFAULT = 300000; // 5 minutos padrão

// Limite padrão de velocidade (usado quando não há limite da via)
const LIMITE_PADRAO = 80; // km/h
const TOLERANCIA_PERCENTUAL = 0.10; // 10% de tolerância

class VelocidadeNotificacaoService {

  /**
   * Verificar excesso de velocidade e criar notificação se necessário
   */
  async verificar(imei, latitude, longitude, velocidade) {
    try {
      // Ignorar velocidades muito baixas ou inválidas
      if (!velocidade || velocidade < 10) {
        return null;
      }

      // Buscar dispositivo
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: { id: true, organizacao_id: true, placa: true, veiculo: true }
      });

      if (!dispositivo || !dispositivo.organizacao_id) {
        return null;
      }

      // Buscar configuração da organização
      const config = await this.getConfig(dispositivo.organizacao_id);

      // Verificar se notificações de velocidade estão ativas
      if (config && config.notificar_excesso_velocidade === false) {
        return null;
      }

      // Determinar limite de velocidade
      let limiteVelocidade = LIMITE_PADRAO;
      let nomeVia = 'Via não identificada';
      let fonteVia = 'padrao';

      // Usar limite customizado se configurado
      if (config?.velocidade_limite_custom) {
        limiteVelocidade = config.velocidade_limite_custom;
        fonteVia = 'customizado';
      } else {
        // Tentar obter limite da via (OpenStreetMap/OSRM com cache)
        const infoVia = await this.obterLimiteVia(latitude, longitude);
        if (infoVia && infoVia.limite) {
          limiteVelocidade = infoVia.limite;
          nomeVia = infoVia.nome || 'Via não identificada';
          fonteVia = infoVia.fonte || 'via';
        }
      }

      // Aplicar tolerância
      const limiteComTolerancia = limiteVelocidade * (1 + TOLERANCIA_PERCENTUAL);

      // Verificar se excede
      if (velocidade <= limiteComTolerancia) {
        return null;
      }

      // Verificar cooldown
      const cooldownMs = (config?.debounce_velocidade || 300) * 1000;
      if (!this.verificarCooldown(dispositivo.id, cooldownMs)) {
        return null;
      }

      // Calcular excesso
      const excesso = Math.round(velocidade - limiteVelocidade);

      // Determinar severidade baseada no excesso
      const severidade = this.calcularSeveridade(excesso);

      // Criar notificação
      const notifService = getNotificationService();
      if (!notifService) {
        console.warn('[Velocidade] Serviço de notificações não disponível');
        return null;
      }

      const veiculo = dispositivo.placa || dispositivo.veiculo || `Dispositivo ${dispositivo.id}`;
      const titulo = `Excesso de Velocidade`;
      const mensagem = nomeVia !== 'Via não identificada'
        ? `${veiculo} a ${Math.round(velocidade)} km/h na ${nomeVia} (limite: ${limiteVelocidade} km/h, excesso: +${excesso} km/h)`
        : `${veiculo} a ${Math.round(velocidade)} km/h (limite: ${limiteVelocidade} km/h, excesso: +${excesso} km/h)`;

      const notificacao = await notifService.criar({
        organizacao_id: dispositivo.organizacao_id,
        dispositivo_id: dispositivo.id,
        tipo: 'excesso_velocidade',
        titulo,
        mensagem,
        severidade,
        dados_extras: {
          velocidade: Math.round(velocidade),
          limite_velocidade: limiteVelocidade,
          excesso,
          nome_via: nomeVia,
          fonte_limite: fonteVia,
          latitude,
          longitude
        }
      });

      if (notificacao) {
        console.log(`[Velocidade] Excesso detectado: ${veiculo} a ${Math.round(velocidade)} km/h (limite ${limiteVelocidade})`);
      }

      return notificacao;
    } catch (error) {
      console.error('[Velocidade] Erro ao verificar:', error.message);
      return null;
    }
  }

  /**
   * Verificar cooldown para evitar notificações em excesso
   */
  verificarCooldown(dispositivo_id, cooldownMs = COOLDOWN_DEFAULT) {
    const agora = Date.now();
    const ultimoAlerta = cooldownMap.get(dispositivo_id) || 0;

    if (agora - ultimoAlerta < cooldownMs) {
      return false;
    }

    cooldownMap.set(dispositivo_id, agora);
    return true;
  }

  /**
   * Calcular severidade baseada no excesso de velocidade
   */
  calcularSeveridade(excesso) {
    if (excesso >= 50) return 'critical';
    if (excesso >= 30) return 'danger';
    if (excesso >= 15) return 'warning';
    return 'info';
  }

  /**
   * Obter limite de velocidade da via usando serviço completo
   * Consulta OpenStreetMap, OSRM e usa cache para performance
   */
  async obterLimiteVia(latitude, longitude) {
    try {
      // Usar serviço completo de velocidade via (com cache e múltiplas fontes)
      if (velocidadeViaService) {
        const resultado = await velocidadeViaService.obterLimiteVelocidade(latitude, longitude);
        if (resultado && resultado.limite) {
          console.log(`[Velocidade] Limite da via: ${resultado.limite} km/h (${resultado.nome || 'via'}) - fonte: ${resultado.fonte}`);
          return {
            limite: resultado.limite,
            nome: resultado.nome || 'Via não identificada',
            tipo: resultado.tipo,
            fonte: resultado.fonte
          };
        }
      }
      return null;
    } catch (error) {
      console.warn('[Velocidade] Erro ao obter limite da via:', error.message);
      return null;
    }
  }

  /**
   * Obter configuração de notificações da organização
   */
  async getConfig(organizacao_id) {
    const cacheKey = `veloc:${organizacao_id}`;
    const cached = configCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < CONFIG_CACHE_TTL) {
      return cached.data;
    }

    try {
      const config = await prisma.configuracaoNotificacao.findUnique({
        where: { organizacao_id }
      });

      configCache.set(cacheKey, { data: config, timestamp: Date.now() });
      return config;
    } catch (error) {
      return null;
    }
  }

  /**
   * Limpar cache de configurações
   */
  limparCache(organizacao_id) {
    if (organizacao_id) {
      configCache.delete(`veloc:${organizacao_id}`);
    } else {
      configCache.clear();
    }
  }

  /**
   * Limpar cooldown de um dispositivo (para testes)
   */
  limparCooldown(dispositivo_id) {
    if (dispositivo_id) {
      cooldownMap.delete(dispositivo_id);
    } else {
      cooldownMap.clear();
    }
  }
}

module.exports = new VelocidadeNotificacaoService();
