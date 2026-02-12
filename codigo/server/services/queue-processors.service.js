/**
 * Queue Processors - Processadores de Jobs
 * Sistema de Rastreamento Veicular
 *
 * Este arquivo contém os processadores para cada tipo de fila.
 * São executados apenas nas instâncias configuradas como workers.
 */

const prisma = require('../db/prisma');
const redisService = require('./redis.service');

// Lazy load para evitar dependência circular
let localizacaoService = null;
function getLocalizacaoService() {
  if (!localizacaoService) {
    localizacaoService = require('./localizacao.service');
  }
  return localizacaoService;
}

/**
 * Processador de Localizações
 * Usa o serviço de localização completo (com validações e IA)
 */
async function locationProcessor(job) {
  const { imei, data } = job.data;

  try {
    const service = getLocalizacaoService();

    // Usar o método create completo do serviço (inclui validações e IA)
    const localizacao = await service.create(imei, data);

    if (localizacao) {
      return {
        success: true,
        localizacaoId: localizacao.id,
        imei,
      };
    } else {
      // Localização rejeitada por validação (não é erro)
      return {
        success: true,
        rejected: true,
        imei,
        reason: 'validation_failed',
      };
    }
  } catch (error) {
    console.error(`[Queue:location] ❌ Erro processando ${imei}:`, error.message);
    throw error; // Re-throw para retry
  }
}

/**
 * Processador de Alarmes
 * Processa e salva alarmes/alertas
 */
async function alarmProcessor(job) {
  const { imei, tipo, dados, timestamp } = job.data;

  try {
    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error(`Dispositivo não encontrado: ${imei}`);
    }

    // Criar alarme
    const alarme = await prisma.alarme.create({
      data: {
        dispositivo_id: dispositivo.id,
        tipo,
        descricao: dados.descricao || `Alarme: ${tipo}`,
        latitude: dados.latitude || null,
        longitude: dados.longitude || null,
        velocidade: dados.velocidade || null,
        resolvido: false,
        timestamp: new Date(timestamp),
      },
    });

    // Publicar evento via Redis para WebSocket
    await redisService.publish('alarm', {
      type: 'new_alarm',
      alarme: {
        id: alarme.id,
        imei,
        tipo,
        timestamp,
        ...dados,
      },
    });

    // Incrementar estatísticas
    await redisService.incrementStat('alarms_created');

    return {
      success: true,
      alarmeId: alarme.id,
      imei,
      tipo,
    };
  } catch (error) {
    console.error(`[Queue:alarm] ❌ Erro processando alarme ${tipo} para ${imei}:`, error.message);
    throw error;
  }
}

/**
 * Processador de Viagens
 * Atualiza viagens ativas ou cria novas
 */
async function tripProcessor(job) {
  const { imei, action, data } = job.data;

  try {
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error(`Dispositivo não encontrado: ${imei}`);
    }

    let result;

    switch (action) {
      case 'start':
        // Iniciar nova viagem
        result = await prisma.viagem.create({
          data: {
            dispositivo_id: dispositivo.id,
            inicio: new Date(data.timestamp),
            lat_inicio: data.latitude,
            lon_inicio: data.longitude,
            distancia_km: 0,
            velocidade_max: 0,
            velocidade_media: 0,
            finalizada: false,
          },
        });
        break;

      case 'update':
        // Atualizar viagem ativa
        const viagemAtiva = await prisma.viagem.findFirst({
          where: {
            dispositivo_id: dispositivo.id,
            finalizada: false,
          },
          orderBy: { inicio: 'desc' },
        });

        if (viagemAtiva) {
          result = await prisma.viagem.update({
            where: { id: viagemAtiva.id },
            data: {
              distancia_km: data.distancia_km,
              velocidade_max: Math.max(viagemAtiva.velocidade_max, data.velocidade || 0),
              velocidade_media: data.velocidade_media,
            },
          });
        }
        break;

      case 'end':
        // Finalizar viagem
        const viagemParaFinalizar = await prisma.viagem.findFirst({
          where: {
            dispositivo_id: dispositivo.id,
            finalizada: false,
          },
          orderBy: { inicio: 'desc' },
        });

        if (viagemParaFinalizar) {
          result = await prisma.viagem.update({
            where: { id: viagemParaFinalizar.id },
            data: {
              fim: new Date(data.timestamp),
              lat_fim: data.latitude,
              lon_fim: data.longitude,
              distancia_km: data.distancia_km,
              velocidade_media: data.velocidade_media,
              finalizada: true,
            },
          });
        }
        break;

      default:
        throw new Error(`Ação desconhecida: ${action}`);
    }

    return {
      success: true,
      action,
      imei,
      viagemId: result?.id,
    };
  } catch (error) {
    console.error(`[Queue:trip] ❌ Erro processando viagem para ${imei}:`, error.message);
    throw error;
  }
}

/**
 * Processador de Dados OBD2
 * Salva dados de telemetria OBD2
 */
async function obd2Processor(job) {
  const { imei, data } = job.data;

  try {
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error(`Dispositivo não encontrado: ${imei}`);
    }

    // Criar registro OBD2
    const obd2 = await prisma.dadosObd2.create({
      data: {
        dispositivo_id: dispositivo.id,
        rpm: data.rpm || null,
        velocidade: data.velocidade || null,
        temperatura_motor: data.temperatura_motor || null,
        nivel_combustivel: data.nivel_combustivel || null,
        odometro: data.odometro || null,
        horimetro: data.horimetro || null,
        tensao_bateria: data.tensao_bateria || null,
        timestamp: new Date(data.timestamp),
      },
    });

    // Atualizar cache de telemetria no Redis
    await redisService.set(`obd2:${imei}`, JSON.stringify({
      ...data,
      updatedAt: Date.now(),
    }), 300); // TTL de 5 minutos

    return {
      success: true,
      obd2Id: obd2.id,
      imei,
    };
  } catch (error) {
    console.error(`[Queue:obd2] ❌ Erro processando OBD2 para ${imei}:`, error.message);
    throw error;
  }
}

/**
 * Processador de Notificações (preparado para futuro)
 * Envia notificações push, email, SMS, etc.
 */
async function notificationProcessor(job) {
  const { type, recipient, message, data } = job.data;

  try {
    // Por enquanto apenas loga - implementar integrações futuras
    console.log(`[Queue:notification] 📧 Enviando ${type} para ${recipient}: ${message}`);

    // TODO: Implementar integrações
    // - Push notification (Firebase)
    // - Email (SendGrid, SES)
    // - SMS (Twilio)
    // - Webhook

    // Salvar log de notificação
    await prisma.logsServidor.create({
      data: {
        nivel: 'info',
        categoria: 'notification',
        mensagem: `Notificação ${type} enviada para ${recipient}`,
        detalhes: JSON.stringify({ type, recipient, message, data }),
        timestamp: new Date(),
      },
    });

    return {
      success: true,
      type,
      recipient,
    };
  } catch (error) {
    console.error(`[Queue:notification] ❌ Erro enviando notificação:`, error.message);
    throw error;
  }
}

/**
 * Registra todos os processadores no serviço de filas
 */
function registerAllProcessors(queueService) {
  // Concorrência baseada no tipo de processamento
  queueService.registerProcessor('location', locationProcessor, 10);  // Alta concorrência
  queueService.registerProcessor('alarm', alarmProcessor, 5);         // Média concorrência
  queueService.registerProcessor('trip', tripProcessor, 5);           // Média concorrência
  queueService.registerProcessor('obd2', obd2Processor, 10);          // Alta concorrência
  queueService.registerProcessor('notification', notificationProcessor, 3); // Baixa concorrência

  console.log('[Queue] ✅ Todos os processadores registrados');
}

module.exports = {
  locationProcessor,
  alarmProcessor,
  tripProcessor,
  obd2Processor,
  notificationProcessor,
  registerAllProcessors,
};
