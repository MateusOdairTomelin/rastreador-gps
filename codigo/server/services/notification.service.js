/**
 * Serviço de Notificações
 *
 * Funcionalidades:
 * - Criar notificações com debounce/throttle
 * - Broadcast via WebSocket para dashboard
 * - Integração com Telegram
 * - Push notifications para app mobile (Expo)
 * - Cache Redis para contador de não lidas
 */

const prisma = require('../db/prisma');
const redisService = require('./redis.service');
const https = require('https');

// Endpoint da API do Expo Push
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Cooldown em memória para debounce
const cooldownMap = new Map(); // "org:dispositivo:tipo" -> timestamp

// Cache de configurações em memória (TTL 5 min)
const configCache = new Map();
const CONFIG_CACHE_TTL = 5 * 60 * 1000;

class NotificationService {

  /**
   * Criar notificação com verificação de debounce
   */
  async criar(dados) {
    const {
      organizacao_id,
      dispositivo_id,
      tipo,
      titulo,
      mensagem,
      dados_extras,
      severidade
    } = dados;

    // Verificar debounce
    if (!await this.verificarDebounce(organizacao_id, dispositivo_id, tipo)) {
      console.log(`[Notificação] Debounce ativo para ${tipo} - ignorando`);
      return null;
    }

    try {
      // Criar notificação no banco
      const notificacao = await prisma.notificacao.create({
        data: {
          organizacao_id,
          dispositivo_id: dispositivo_id || null,
          tipo,
          titulo,
          mensagem,
          dados_extras: dados_extras ? JSON.stringify(dados_extras) : null,
          severidade: severidade || 'info',
        },
        include: {
          dispositivo: {
            select: { imei: true, placa: true, veiculo: true }
          }
        }
      });

      console.log(`[Notificação] Criada: ${tipo} - ${titulo}`);

      // Invalidar cache de contador
      await this.invalidarContadorCache(organizacao_id);

      // Broadcast via WebSocket
      this.broadcastNotificacao(notificacao);

      // Enviar para Telegram (se configurado) - não bloquear
      this.enviarTelegram(notificacao).catch(err =>
        console.warn('[Notificação] Erro Telegram:', err.message)
      );

      // Enviar push notification para app mobile (se motorista vinculado) - não bloquear
      this.enviarPushMobile(notificacao).catch(err =>
        console.warn('[Notificação] Erro Push Mobile:', err.message)
      );

      return notificacao;
    } catch (error) {
      console.error('[Notificação] Erro ao criar:', error.message);
      return null;
    }
  }

  /**
   * Verificar debounce para evitar notificações em excesso
   */
  async verificarDebounce(organizacao_id, dispositivo_id, tipo) {
    const key = `${organizacao_id}:${dispositivo_id || 'all'}:${tipo}`;
    const agora = Date.now();
    const ultimoEnvio = cooldownMap.get(key) || 0;

    // Buscar configuração da organização
    const config = await this.getConfig(organizacao_id);
    let debounceMs = 60000; // 1 minuto padrão

    if (tipo.startsWith('geofence')) {
      debounceMs = (config?.debounce_geofence || 60) * 1000;
    } else if (tipo === 'excesso_velocidade') {
      debounceMs = (config?.debounce_velocidade || 300) * 1000;
    }

    if (agora - ultimoEnvio < debounceMs) {
      return false;
    }

    cooldownMap.set(key, agora);
    return true;
  }

  /**
   * Broadcast notificação via WebSocket
   */
  broadcastNotificacao(notificacao) {
    const wsClients = global.wsClients;
    if (!wsClients || wsClients.size === 0) return;

    const mensagem = JSON.stringify({
      tipo: 'notificacao',
      organizacao_id: notificacao.organizacao_id,
      dados: {
        id: notificacao.id,
        tipo: notificacao.tipo,
        titulo: notificacao.titulo,
        mensagem: notificacao.mensagem,
        severidade: notificacao.severidade,
        dados_extras: notificacao.dados_extras ? JSON.parse(notificacao.dados_extras) : null,
        dispositivo: notificacao.dispositivo,
        created_at: notificacao.created_at
      }
    });

    let enviados = 0;
    wsClients.forEach((client) => {
      if (client.readyState === 1) { // WebSocket.OPEN
        // Enviar para todos ou filtrar por organização
        if (!client.organizacao_id || client.organizacao_id === notificacao.organizacao_id) {
          client.send(mensagem);
          enviados++;
        }
      }
    });

    if (enviados > 0) {
      console.log(`[Notificação] WebSocket enviado para ${enviados} cliente(s)`);
    }
  }

  /**
   * Enviar notificação para Telegram
   */
  async enviarTelegram(notificacao) {
    try {
      const config = await this.getConfig(notificacao.organizacao_id);

      if (!config?.telegram_ativo || !config?.telegram_bot_token || !config?.telegram_chat_id) {
        return false;
      }

      // Verificar se este tipo deve ser enviado
      if (notificacao.tipo.startsWith('geofence')) {
        const tipoEvento = notificacao.tipo.includes('entrada') ? 'entrada' : 'saida';
        if (tipoEvento === 'entrada' && !config.notificar_geofence_entrada) return false;
        if (tipoEvento === 'saida' && !config.notificar_geofence_saida) return false;
      }
      if (notificacao.tipo === 'excesso_velocidade' && !config.notificar_excesso_velocidade) return false;

      // Importar serviço do Telegram (lazy load)
      const telegramService = require('./telegram.service');

      await telegramService.enviarMensagem(
        config.telegram_bot_token,
        config.telegram_chat_id,
        notificacao
      );

      // Atualizar que foi enviado
      await prisma.notificacao.update({
        where: { id: notificacao.id },
        data: {
          enviada_telegram: true,
          telegram_enviado_em: new Date()
        }
      });

      return true;
    } catch (error) {
      console.error('[Notificação] Erro ao enviar Telegram:', error.message);
      return false;
    }
  }

  /**
   * Enviar push notification para app mobile via Expo
   * Busca motoristas vinculados ao dispositivo e envia push
   */
  async enviarPushMobile(notificacao) {
    try {
      if (!notificacao.dispositivo_id) {
        return false;
      }

      // Buscar motorista vinculado ao dispositivo com push token
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { id: notificacao.dispositivo_id },
        select: {
          motorista: {
            select: {
              id: true,
              nome: true,
              push_token: true
            }
          }
        }
      });

      if (!dispositivo?.motorista?.push_token) {
        return false;
      }

      const pushToken = dispositivo.motorista.push_token;

      // Validar formato do token Expo
      if (!pushToken.startsWith('ExponentPushToken[')) {
        console.warn('[Notificação] Push token inválido:', pushToken);
        return false;
      }

      // Determinar canal de notificação baseado no tipo
      let channelId = 'default';
      let sound = 'default';

      if (notificacao.tipo === 'excesso_velocidade') {
        channelId = 'alertas';
        sound = 'default';
      } else if (notificacao.tipo.startsWith('geofence')) {
        channelId = 'geofence';
        sound = 'default';
      }

      // Preparar dados extras
      const dadosExtras = notificacao.dados_extras
        ? (typeof notificacao.dados_extras === 'string'
            ? JSON.parse(notificacao.dados_extras)
            : notificacao.dados_extras)
        : {};

      // Construir mensagem push
      const pushMessage = {
        to: pushToken,
        title: notificacao.titulo,
        body: notificacao.mensagem,
        sound,
        channelId,
        priority: notificacao.severidade === 'critical' || notificacao.severidade === 'danger' ? 'high' : 'default',
        data: {
          notificacao_id: notificacao.id,
          tipo: notificacao.tipo,
          severidade: notificacao.severidade,
          ...dadosExtras
        }
      };

      // Enviar para Expo Push API
      const resultado = await this.enviarExpoPush([pushMessage]);

      if (resultado.success) {
        console.log(`[Notificação] Push enviado para motorista ${dispositivo.motorista.nome}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Notificação] Erro ao enviar push mobile:', error.message);
      return false;
    }
  }

  /**
   * Enviar mensagens para Expo Push API
   * @param {Array} messages - Array de mensagens push
   */
  async enviarExpoPush(messages) {
    return new Promise((resolve) => {
      const data = JSON.stringify(messages);

      const options = {
        hostname: 'exp.host',
        path: '/--/api/v2/push/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const result = JSON.parse(responseData);

            if (result.data && result.data.length > 0) {
              const ticket = result.data[0];
              if (ticket.status === 'ok') {
                resolve({ success: true, ticket });
              } else {
                console.warn('[Expo Push] Erro no ticket:', ticket);
                resolve({ success: false, error: ticket.message });
              }
            } else {
              resolve({ success: true, result });
            }
          } catch (e) {
            console.error('[Expo Push] Erro ao parsear resposta:', e.message);
            resolve({ success: false, error: e.message });
          }
        });
      });

      req.on('error', (error) => {
        console.error('[Expo Push] Erro na requisição:', error.message);
        resolve({ success: false, error: error.message });
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Buscar configuração de notificações da organização (com cache)
   */
  async getConfig(organizacao_id) {
    const cacheKey = `config:${organizacao_id}`;
    const cached = configCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp) < CONFIG_CACHE_TTL) {
      return cached.data;
    }

    const config = await prisma.configuracaoNotificacao.findUnique({
      where: { organizacao_id }
    });

    configCache.set(cacheKey, { data: config, timestamp: Date.now() });
    return config;
  }

  /**
   * Criar/atualizar configuração
   */
  async upsertConfig(organizacao_id, dados) {
    // Remover campos que não devem ser atualizados
    const { id, organizacao_id: _, created_at, ...updateData } = dados;

    const config = await prisma.configuracaoNotificacao.upsert({
      where: { organizacao_id },
      update: updateData,
      create: { organizacao_id, ...updateData }
    });

    // Invalidar cache
    configCache.delete(`config:${organizacao_id}`);

    return config;
  }

  /**
   * Listar notificações da organização
   */
  async listar(organizacao_id, filtros = {}) {
    const { limite = 50, offset = 0, lida, tipo, dispositivo_id } = filtros;

    const where = { organizacao_id };
    if (lida !== undefined) where.lida = lida;
    if (tipo) where.tipo = tipo;
    if (dispositivo_id) where.dispositivo_id = dispositivo_id;

    return prisma.notificacao.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limite,
      skip: offset,
      include: {
        dispositivo: {
          select: { imei: true, placa: true, veiculo: true }
        }
      }
    });
  }

  /**
   * Contar notificações não lidas (com cache Redis)
   */
  async contarNaoLidas(organizacao_id) {
    const cacheKey = `notif:count:${organizacao_id}`;

    // Tentar cache primeiro
    try {
      if (redisService.client) {
        const cached = await redisService.client.get(cacheKey);
        if (cached !== null) {
          return parseInt(cached);
        }
      }
    } catch (e) {
      // Redis não disponível, continua sem cache
    }

    // Buscar do banco
    const count = await prisma.notificacao.count({
      where: { organizacao_id, lida: false }
    });

    // Salvar no cache (TTL 60s)
    try {
      if (redisService.client) {
        await redisService.client.setex(cacheKey, 60, count.toString());
      }
    } catch (e) {
      // Ignora erro de cache
    }

    return count;
  }

  /**
   * Invalidar cache do contador
   */
  async invalidarContadorCache(organizacao_id) {
    try {
      if (redisService.client) {
        await redisService.client.del(`notif:count:${organizacao_id}`);
      }
    } catch (e) {
      // Ignora erro
    }
  }

  /**
   * Marcar notificação como lida
   */
  async marcarComoLida(id, organizacao_id) {
    const notificacao = await prisma.notificacao.updateMany({
      where: { id, organizacao_id },
      data: { lida: true, lida_em: new Date() }
    });

    await this.invalidarContadorCache(organizacao_id);
    return notificacao;
  }

  /**
   * Marcar todas como lidas
   */
  async marcarTodasComoLidas(organizacao_id) {
    await prisma.notificacao.updateMany({
      where: { organizacao_id, lida: false },
      data: { lida: true, lida_em: new Date() }
    });

    await this.invalidarContadorCache(organizacao_id);
  }

  /**
   * Deletar notificações antigas (limpeza)
   */
  async limparAntigas(diasRetencao = 30) {
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - diasRetencao);

    const result = await prisma.notificacao.deleteMany({
      where: {
        created_at: { lt: dataLimite },
        lida: true
      }
    });

    console.log(`[Notificação] Limpeza: ${result.count} notificações antigas removidas`);
    return result.count;
  }
}

module.exports = new NotificationService();
