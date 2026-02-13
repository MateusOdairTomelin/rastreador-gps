const prisma = require('../db/prisma');
const redisService = require('./redis.service');
const queueService = require('./queue.service'); // ✅ Filas assíncronas

// Flag para usar filas por padrão (pode ser alterado em runtime)
let useQueues = process.env.USE_LOCATION_QUEUE === 'true';

// ✅ Serviço de IA para correção de GPS
let gpsAI = null;
try {
  gpsAI = require('./gps-ai.service');
  console.log('[Localização] IA GPS carregada com sucesso');
} catch (e) {
  console.warn('[Localização] IA GPS não disponível:', e.message);
}

// ✅ Serviço de aprendizado de rotas (correção automática baseada em histórico)
let gpsAprendizado = null;
try {
  gpsAprendizado = require('./gps-aprendizado.service');
  console.log('[Localização] Aprendizado GPS carregado com sucesso');
} catch (e) {
  console.warn('[Localização] Aprendizado GPS não disponível:', e.message);
}

// Flag para habilitar/desabilitar correção de IA (pode ser configurado via API)
let iaCorrecaoAtiva = true;
// Flag para habilitar/desabilitar aprendizado automático
let aprendizadoAtivo = true;

// ✅ Serviço de Geofencing (cercas virtuais)
let geofencingService = null;
try {
  geofencingService = require('./geofencing.service');
  console.log('[Localização] Geofencing carregado com sucesso');
} catch (e) {
  console.warn('[Localização] Geofencing não disponível:', e.message);
}

// ✅ Serviço de Notificação de Excesso de Velocidade
let velocidadeNotificacaoService = null;
try {
  velocidadeNotificacaoService = require('./velocidade-notificacao.service');
  console.log('[Localização] Notificação de velocidade carregada com sucesso');
} catch (e) {
  console.warn('[Localização] Notificação de velocidade não disponível:', e.message);
}

class LocalizacaoService {
  // Get all locations
  async getAll() {
    return await prisma.localizacao.findMany({
      orderBy: { timestamp: 'desc' },
      include: {
        dispositivo: {
          select: { imei: true, veiculo: true },
        },
      },
    });
  }

  // Get current location for device
  // ✅ Retorna apenas localizações válidas (dentro do Brasil)
  // ✅ Com cache Redis para alta performance
  async getCurrent(imei) {
    // Tentar buscar do cache Redis primeiro
    const cached = await redisService.getPosition(imei);
    if (cached) {
      return cached;
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // Buscar última localização VÁLIDA (dentro do Brasil)
    const location = await prisma.localizacao.findFirst({
      where: {
        dispositivo_id: dispositivo.id,
        // Filtrar coordenadas dentro do Brasil
        latitude: { gte: -35, lte: 5 },
        longitude: { gte: -75, lte: -30 },
      },
      orderBy: { timestamp: 'desc' },
    });

    // Salvar no cache Redis
    if (location) {
      await redisService.setPosition(imei, location);
    }

    return location;
  }

  // Get location history with time range
  async getHistory(imei, horasAtras = 24) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    const dataLimite = new Date();
    dataLimite.setHours(dataLimite.getHours() - horasAtras);

    return await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: dataLimite },
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  // Get location history by date range
  async getHistoryByDateRange(imei, dataInicio, dataFim) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: {
          gte: dataInicio,
          lte: dataFim,
        },
      },
      orderBy: { timestamp: 'desc' },
    });
  }

  // Create new location record
  // ✅ CORREÇÃO: Adicionar lock por IMEI para evitar race condition entre processadores
  async create(imei, locationData) {
    const lockKey = `lock:location:${imei}`;
    const lockTTL = 5; // 5 segundos de timeout
    let lockAcquired = false;

    try {
      // Tentar adquirir lock com Redis (SETNX)
      lockAcquired = await redisService.acquireLock(lockKey, lockTTL);

      if (!lockAcquired) {
        // Se não conseguir o lock, esperar um pouco e tentar novamente uma vez
        await new Promise(resolve => setTimeout(resolve, 100));
        lockAcquired = await redisService.acquireLock(lockKey, lockTTL);

        if (!lockAcquired) {
          console.warn(`[Location] Lock não adquirido para ${imei}, descartando pacote`);
          return null;
        }
      }

      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
      });

      if (!dispositivo) {
        throw new Error('Dispositivo não encontrado');
      }

      // ✅ VALIDAÇÃO: Rejeitar coordenadas inválidas ANTES de salvar
    const lat = locationData.latitude;
    const lon = locationData.longitude;

    // Rejeitar coordenadas nulas ou zero
    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      console.warn(`[Location] Rejeitado: coordenadas nulas para ${imei}`);
      return null;
    }

    // Rejeitar coordenadas (0,0) - sem sinal GPS
    if (lat === 0 && lon === 0) {
      console.warn(`[Location] Rejeitado: coordenadas (0,0) para ${imei} - sem sinal GPS`);
      return null;
    }

    // Rejeitar coordenadas fora do range válido
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      console.warn(`[Location] Rejeitado: coordenadas fora do range (${lat}, ${lon}) para ${imei}`);
      return null;
    }

    // Rejeitar coordenadas fora do Brasil (aproximado)
    // Latitude: -35 a 5, Longitude: -75 a -30
    if (lat < -35 || lat > 5 || lon < -75 || lon > -30) {
      console.warn(`[Location] Rejeitado: coordenadas fora do Brasil (${lat.toFixed(6)}, ${lon.toFixed(6)}) para ${imei}`);
      return null;
    }

    // ✅ VALIDAÇÃO: Detectar saltos impossíveis de GPS
    // Busca última localização válida e calcula se o movimento é fisicamente possível
    const ultimaLocalizacao = await prisma.localizacao.findFirst({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' },
    });

    if (ultimaLocalizacao) {
      // Calcular distância entre pontos (Haversine)
      const R = 6371; // Raio da Terra em km
      const dLat = (lat - ultimaLocalizacao.latitude) * Math.PI / 180;
      const dLon = (lon - ultimaLocalizacao.longitude) * Math.PI / 180;
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(ultimaLocalizacao.latitude * Math.PI / 180) * Math.cos(lat * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distanciaKm = R * c;

      // Calcular tempo entre pontos
      const timestampNovo = locationData.timestamp ? new Date(locationData.timestamp) : new Date();
      const tempoSegundos = Math.abs(timestampNovo - ultimaLocalizacao.timestamp) / 1000;
      const velocidadeImplicita = tempoSegundos > 0 ? (distanciaKm / tempoSegundos) * 3600 : 999999;

      // Log para distâncias significativas (> 500m)
      if (distanciaKm > 0.5) {
        console.log(`[Location] 📏 ${imei}: ${distanciaKm.toFixed(2)}km em ${tempoSegundos.toFixed(0)}s = ${velocidadeImplicita.toFixed(0)}km/h`);
      }

      // ✅ REGRA 1: Salto absoluto - rejeitar distâncias > 10km independente do tempo
      if (distanciaKm > 10) {
        console.warn(`[Location] Rejeitado: salto absoluto para ${imei} - ${distanciaKm.toFixed(1)}km (máx 10km)`);
        console.warn(`[Location]   De: (${ultimaLocalizacao.latitude.toFixed(6)}, ${ultimaLocalizacao.longitude.toFixed(6)})`);
        console.warn(`[Location]   Para: (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
        return null;
      }

      // ✅ REGRA 2: Salto com tempo muito curto - rejeitar > 500m em menos de 2 segundos
      if (tempoSegundos < 2 && distanciaKm > 0.5) {
        console.warn(`[Location] Rejeitado: salto rápido para ${imei} - ${(distanciaKm * 1000).toFixed(0)}m em ${tempoSegundos.toFixed(1)}s`);
        console.warn(`[Location]   De: (${ultimaLocalizacao.latitude.toFixed(6)}, ${ultimaLocalizacao.longitude.toFixed(6)})`);
        console.warn(`[Location]   Para: (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
        return null;
      }

      // ✅ REGRA 3: Velocidade implícita impossível (> 200 km/h)
      const velocidadeImplicita = tempoSegundos > 0 ? (distanciaKm / tempoSegundos) * 3600 : 999999;

      if (velocidadeImplicita > 200) {
        console.warn(`[Location] Rejeitado: velocidade impossível para ${imei} - ${distanciaKm.toFixed(1)}km em ${tempoSegundos}s = ${velocidadeImplicita.toFixed(0)}km/h`);
        console.warn(`[Location]   De: (${ultimaLocalizacao.latitude.toFixed(6)}, ${ultimaLocalizacao.longitude.toFixed(6)})`);
        console.warn(`[Location]   Para: (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
        return null;
      }
    }

    // ✅ Filtrar apenas campos válidos do schema Prisma
    // Remove campos extras como 'satellites' que não existem na tabela
    let timestampFinal = locationData.timestamp ? new Date(locationData.timestamp) : new Date();

    // ✅ AUTO-CORREÇÃO DE TIMESTAMP: Se GPS está muito atrasado, usar hora do servidor
    // Alguns rastreadores XT40 enviam timestamps com relógio desincronizado
    const agora = new Date();
    const diffMinutos = (agora.getTime() - timestampFinal.getTime()) / (1000 * 60);

    if (diffMinutos > 5) {
      // Timestamp do GPS está mais de 5 minutos no passado - usar hora do servidor
      console.log(`[Location] ⚠️ ${imei}: Timestamp GPS atrasado ${diffMinutos.toFixed(1)}min - usando hora do servidor`);
      timestampFinal = agora;
    } else if (diffMinutos < -5) {
      // Timestamp do GPS está no futuro - usar hora do servidor
      console.log(`[Location] ⚠️ ${imei}: Timestamp GPS no futuro ${Math.abs(diffMinutos).toFixed(1)}min - usando hora do servidor`);
      timestampFinal = agora;
    }

    let validFields = {
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      altitude: locationData.altitude || null,
      velocidade: locationData.velocidade || 0,
      direcao: locationData.direcao || 0,
      precisao: locationData.precisao || null,
      ignicao: locationData.ignicao ?? null,           // Boolean: true/false
      estado_ignicao: locationData.estado_ignicao || null, // String: 'off', 'acc_on', 'idle', 'moving'
      timestamp: timestampFinal,
    };

    // ✅ PRIORIDADE 1: Verificar aprendizado (correções aprovadas anteriormente)
    // Se houver uma correção aprendida para esta coordenada, usar ela
    let correcaoAplicada = false;
    if (gpsAprendizado && aprendizadoAtivo) {
      try {
        const correcaoAprendida = await gpsAprendizado.buscarCorrecaoAprendida(
          dispositivo.id,
          validFields.latitude,
          validFields.longitude
        );

        if (correcaoAprendida && correcaoAprendida.confianca >= 0.7) {
          console.log(`[Location] 🎓 Aprendizado aplicado: (${validFields.latitude.toFixed(6)}, ${validFields.longitude.toFixed(6)}) -> (${correcaoAprendida.lat.toFixed(6)}, ${correcaoAprendida.lon.toFixed(6)}) [${correcaoAprendida.metodo}, conf=${(correcaoAprendida.confianca * 100).toFixed(0)}%]`);
          validFields.latitude = correcaoAprendida.lat;
          validFields.longitude = correcaoAprendida.lon;
          validFields.precisao = -3; // Flag especial: correção por aprendizado
          correcaoAplicada = true;
        }
      } catch (aprendizadoError) {
        console.warn(`[Location] Erro no aprendizado GPS: ${aprendizadoError.message}`);
      }
    }

    // ✅ PRIORIDADE 2: Se não houve correção por aprendizado, tentar IA genérica
    if (!correcaoAplicada && gpsAI && iaCorrecaoAtiva) {
      try {
        const pontoOriginal = {
          ...validFields,
          dispositivo_id: dispositivo.id,
        };

        const pontoCorrigido = await gpsAI.processarPontoGPS(imei, pontoOriginal);

        // Se houve correção, usar coordenadas corrigidas
        if (pontoCorrigido.corrigido_ia) {
          console.log(`[Location] IA corrigiu: (${validFields.latitude}, ${validFields.longitude}) -> (${pontoCorrigido.latitude}, ${pontoCorrigido.longitude}) [${pontoCorrigido.ia_metodo}]`);
          validFields.latitude = pontoCorrigido.latitude;
          validFields.longitude = pontoCorrigido.longitude;
        }
      } catch (iaError) {
        console.warn(`[Location] Erro na IA GPS: ${iaError.message}`);
        // Continua com os dados originais em caso de erro
      }
    }

    console.log(`[Location] Creating: lat=${validFields.latitude}, lon=${validFields.longitude}, speed=${validFields.velocidade}, ignicao=${validFields.ignicao}, estado=${validFields.estado_ignicao}`);

    const location = await prisma.localizacao.create({
      data: {
        dispositivo_id: dispositivo.id,
        ...validFields,
      },
    });

    console.log(`[Location] ✅ Created ID=${location.id} for ${imei}: estado_ignicao=${location.estado_ignicao}, ignicao=${location.ignicao}`);

    // ✅ Atualizar cache Redis com nova posição
    await redisService.setPosition(imei, location);

    // ✅ Atualizar status do dispositivo no Redis
    await redisService.setDeviceStatus(imei, {
      online: true,
      lastSeen: new Date().toISOString(),
      ignicao: validFields.ignicao,
      velocidade: validFields.velocidade
    });

    // ✅ Incrementar estatísticas
    await redisService.incrementStat('positions_received');

    // ✅ Verificar geofencing (cercas virtuais)
    if (geofencingService && dispositivo.organizacao_id) {
      try {
        await geofencingService.verificarPosicao(
          imei,
          validFields.latitude,
          validFields.longitude,
          validFields.velocidade,
          validFields.timestamp
        );
      } catch (geoError) {
        console.warn(`[Location] Erro no geofencing: ${geoError.message}`);
      }
    }

    // ✅ Verificar excesso de velocidade e notificar
    if (velocidadeNotificacaoService && validFields.velocidade > 0) {
      try {
        await velocidadeNotificacaoService.verificar(
          imei,
          validFields.latitude,
          validFields.longitude,
          validFields.velocidade
        );
      } catch (velError) {
        console.warn(`[Location] Erro na verificação de velocidade: ${velError.message}`);
      }
    }

    return location;

    } finally {
      // ✅ SEMPRE liberar o lock, mesmo em caso de erro
      if (lockAcquired) {
        await redisService.releaseLock(lockKey);
      }
    }
  }

  // Ativar/desativar correção de IA
  setIACorrecao(ativa) {
    iaCorrecaoAtiva = ativa;
    console.log(`[Location] Correção IA GPS ${ativa ? 'ATIVADA' : 'DESATIVADA'}`);
  }

  // Verificar se IA está ativa
  isIAAtiva() {
    return iaCorrecaoAtiva && gpsAI !== null;
  }

  // ============ MÉTODOS ASSÍNCRONOS COM FILAS ============

  /**
   * Cria localização de forma assíncrona via fila
   * Retorna imediatamente, processamento ocorre em background
   */
  async createAsync(imei, locationData, options = {}) {
    // Validações rápidas (sem consulta ao banco)
    const lat = locationData.latitude;
    const lon = locationData.longitude;

    // Rejeitar coordenadas obviamente inválidas
    if (lat === null || lat === undefined || lon === null || lon === undefined) {
      return { queued: false, reason: 'coordenadas_nulas' };
    }
    if (lat === 0 && lon === 0) {
      return { queued: false, reason: 'sem_sinal_gps' };
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { queued: false, reason: 'coordenadas_invalidas' };
    }
    if (lat < -35 || lat > 5 || lon < -75 || lon > -30) {
      return { queued: false, reason: 'fora_do_brasil' };
    }

    // Adicionar à fila
    const job = await queueService.addJob('location', {
      imei,
      data: locationData,
      timestamp: Date.now(),
    }, {
      priority: options.priority || 2, // Prioridade normal
      delay: options.delay || 0,
    });

    if (job) {
      // Atualizar cache imediatamente para resposta rápida no frontend
      await redisService.setPosition(imei, {
        latitude: lat,
        longitude: lon,
        velocidade: locationData.velocidade || 0,
        timestamp: locationData.timestamp || new Date().toISOString(),
        pendente: true, // Flag indicando que ainda não foi salvo no banco
      });

      return { queued: true, jobId: job.id };
    }

    // Fallback: se fila não disponível, criar diretamente
    console.warn(`[Location] Fila não disponível, criando diretamente para ${imei}`);
    return this.create(imei, locationData);
  }

  /**
   * Cria múltiplas localizações de forma assíncrona (batch)
   */
  async createManyAsync(imei, locationsArray) {
    const jobs = locationsArray.map(loc => ({
      data: { imei, data: loc, timestamp: Date.now() },
      options: { priority: 3 }, // Prioridade mais baixa para batch
    }));

    const results = await queueService.addBulk('location', jobs);
    return { queued: results.length, total: locationsArray.length };
  }

  /**
   * Habilita/desabilita uso de filas para localizações
   */
  setUseQueues(enabled) {
    useQueues = enabled;
    console.log(`[Location] Filas ${enabled ? 'HABILITADAS' : 'DESABILITADAS'}`);
  }

  /**
   * Verifica se filas estão habilitadas
   */
  isUsingQueues() {
    return useQueues && queueService.isEnabled;
  }

  // Batch create locations (for bulk import)
  async createMany(imei, locationsArray) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return await prisma.localizacao.createMany({
      data: locationsArray.map(loc => ({
        dispositivo_id: dispositivo.id,
        ...loc,
      })),
      skipDuplicates: true,
    });
  }
}

module.exports = new LocalizacaoService();
