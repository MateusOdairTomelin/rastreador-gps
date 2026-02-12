/**
 * Serviço de Geofencing - Cercas Virtuais
 *
 * Funcionalidades:
 * - CRUD de cercas circulares por organização
 * - Verificação de entrada/saída de dispositivos
 * - Integração com sistema de alarmes
 * - Cache Redis para estado atual
 */

const prisma = require('../db/prisma');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

// Carregar serviços opcionais
let redisService = null;
let alarmeService = null;

try {
  redisService = require('./redis.service');
  console.log('[Geofencing] Redis carregado com sucesso');
} catch (e) {
  console.warn('[Geofencing] Redis não disponível:', e.message);
}

try {
  alarmeService = require('./alarme.service');
  console.log('[Geofencing] Serviço de alarmes carregado');
} catch (e) {
  console.warn('[Geofencing] Serviço de alarmes não disponível:', e.message);
}

// Serviço de notificações (lazy load para evitar circular dependency)
let notificationService = null;
const getNotificationService = () => {
  if (!notificationService) {
    try {
      notificationService = require('./notification.service');
    } catch (e) {
      console.warn('[Geofencing] Serviço de notificações não disponível:', e.message);
    }
  }
  return notificationService;
};

// Cooldown para evitar eventos duplicados (em ms)
// Reduzido para 30 segundos - permite detectar entrada/saída rápida
const EVENTO_COOLDOWN = 30000; // 30 segundos

class GeofencingService {
  constructor() {
    // Cache em memória para estado dos dispositivos
    // Formato: { "dispositivo_id:geofence_id": { dentro: boolean, ultimoEvento: timestamp } }
    this.estadoCache = new Map();
  }

  // ==================== CRUD DE CERCAS ====================

  /**
   * Criar nova cerca virtual
   */
  async criar(organizacao_id, dados) {
    const { nome, descricao, latitude, longitude, raio_metros, cor, tipo_alerta } = dados;

    // Validações
    if (!nome || nome.trim().length === 0) {
      throw new Error('Nome da cerca é obrigatório');
    }

    if (!latitude || !longitude) {
      throw new Error('Coordenadas são obrigatórias');
    }

    if (!raio_metros || raio_metros < 10 || raio_metros > 50000) {
      throw new Error('Raio deve estar entre 10 e 50.000 metros');
    }

    // Validar coordenadas do Brasil
    if (latitude < -35 || latitude > 6 || longitude < -75 || longitude > -30) {
      throw new Error('Coordenadas fora do território brasileiro');
    }

    const geofence = await prisma.geofence.create({
      data: {
        organizacao_id,
        nome: nome.trim(),
        descricao: descricao?.trim() || null,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        raio_metros: parseInt(raio_metros),
        cor: cor || '#3B82F6',
        tipo_alerta: tipo_alerta || 'ambos',
        ativo: true
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: dados.usuarioId || null,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_GEOFENCE,
      recurso: 'geofence',
      recursoId: geofence.id,
      detalhes: `Cerca virtual "${nome}" criada (raio: ${raio_metros}m)`,
      dadosNovos: { nome, raio_metros, tipo_alerta, latitude, longitude }
    });

    console.log(`[Geofencing] Cerca "${nome}" criada para org ${organizacao_id}`);
    return geofence;
  }

  /**
   * Listar cercas de uma organização
   */
  async listar(organizacao_id, filtros = {}) {
    const { ativo, limite = 100 } = filtros;

    const where = { organizacao_id };
    if (ativo !== undefined) {
      where.ativo = ativo === true || ativo === 'true';
    }

    const geofences = await prisma.geofence.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limite,
      include: {
        _count: {
          select: { eventos: true }
        }
      }
    });

    return geofences;
  }

  /**
   * Obter cerca por ID
   */
  async obter(id, organizacao_id = null) {
    const where = { id: parseInt(id) };
    if (organizacao_id) {
      where.organizacao_id = organizacao_id;
    }

    const geofence = await prisma.geofence.findFirst({
      where,
      include: {
        _count: {
          select: { eventos: true }
        }
      }
    });

    return geofence;
  }

  /**
   * Atualizar cerca
   */
  async atualizar(id, organizacao_id, dados) {
    const { nome, descricao, latitude, longitude, raio_metros, cor, tipo_alerta, ativo } = dados;

    // Verificar se a cerca existe e pertence à organização
    const cercaExistente = await this.obter(id, organizacao_id);
    if (!cercaExistente) {
      throw new Error('Cerca não encontrada');
    }

    // Construir objeto de atualização
    const updateData = {};
    if (nome !== undefined) updateData.nome = nome.trim();
    if (descricao !== undefined) updateData.descricao = descricao?.trim() || null;
    if (latitude !== undefined) updateData.latitude = parseFloat(latitude);
    if (longitude !== undefined) updateData.longitude = parseFloat(longitude);
    if (raio_metros !== undefined) {
      if (raio_metros < 10 || raio_metros > 50000) {
        throw new Error('Raio deve estar entre 10 e 50.000 metros');
      }
      updateData.raio_metros = parseInt(raio_metros);
    }
    if (cor !== undefined) updateData.cor = cor;
    if (tipo_alerta !== undefined) updateData.tipo_alerta = tipo_alerta;
    if (ativo !== undefined) updateData.ativo = ativo;

    const geofence = await prisma.geofence.update({
      where: { id: parseInt(id) },
      data: updateData
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: dados.usuarioId || null,
      organizacaoId: organizacao_id,
      acao: ACOES.EDITAR_GEOFENCE,
      recurso: 'geofence',
      recursoId: id,
      detalhes: `Cerca virtual "${cercaExistente.nome}" atualizada`,
      dadosAnteriores: cercaExistente,
      dadosNovos: updateData
    });

    console.log(`[Geofencing] Cerca ${id} atualizada`);
    return geofence;
  }

  /**
   * Deletar cerca
   */
  async deletar(id, organizacao_id, usuarioId = null) {
    // Verificar se a cerca existe e pertence à organização
    const cercaExistente = await this.obter(id, organizacao_id);
    if (!cercaExistente) {
      throw new Error('Cerca não encontrada');
    }

    await prisma.geofence.delete({
      where: { id: parseInt(id) }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.DELETAR_GEOFENCE,
      recurso: 'geofence',
      recursoId: id,
      detalhes: `Cerca virtual "${cercaExistente.nome}" excluída`
    });

    // Limpar cache
    this.limparCacheGeofence(id);

    console.log(`[Geofencing] Cerca ${id} deletada`);
    return true;
  }

  /**
   * Ativar/desativar cerca
   */
  async toggleAtivo(id, organizacao_id) {
    const cerca = await this.obter(id, organizacao_id);
    if (!cerca) {
      throw new Error('Cerca não encontrada');
    }

    const geofence = await prisma.geofence.update({
      where: { id: parseInt(id) },
      data: { ativo: !cerca.ativo }
    });

    console.log(`[Geofencing] Cerca ${id} ${geofence.ativo ? 'ativada' : 'desativada'}`);
    return geofence;
  }

  // ==================== VERIFICAÇÃO DE POSIÇÃO ====================

  /**
   * Verificar se dispositivo entrou/saiu de alguma cerca
   * Chamado a cada nova localização recebida
   */
  async verificarPosicao(imei, latitude, longitude, velocidade = 0, timestamp = new Date()) {
    try {
      // Buscar dispositivo
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: { id: true, organizacao_id: true, placa: true, veiculo: true }
      });

      if (!dispositivo || !dispositivo.organizacao_id) {
        return []; // Dispositivo não encontrado ou sem organização
      }

      // Buscar cercas ativas da organização
      const cercas = await this.obterCercasAtivas(dispositivo.organizacao_id);
      if (cercas.length === 0) {
        return [];
      }

      const eventos = [];

      for (const cerca of cercas) {
        const dentroAgora = this.estaDentroCirculo(
          latitude,
          longitude,
          cerca.latitude,
          cerca.longitude,
          cerca.raio_metros
        );

        // Obter estado anterior
        const cacheKey = `${dispositivo.id}:${cerca.id}`;
        const estadoAnterior = this.estadoCache.get(cacheKey);
        const dentroAntes = estadoAnterior?.dentro ?? null;

        // Verificar se houve transição
        if (dentroAntes !== null && dentroAntes !== dentroAgora) {
          // Verificar cooldown para evitar eventos duplicados
          const agora = Date.now();
          if (estadoAnterior?.ultimoEvento && (agora - estadoAnterior.ultimoEvento) < EVENTO_COOLDOWN) {
            console.log(`[Geofencing] Cooldown ativo para ${dispositivo.id}:${cerca.id} (aguarde ${Math.round((EVENTO_COOLDOWN - (agora - estadoAnterior.ultimoEvento)) / 1000)}s)`);
            continue; // Ainda em cooldown
          }
          console.log(`[Geofencing] Transição detectada: ${dentroAntes ? 'DENTRO→FORA' : 'FORA→DENTRO'} para cerca "${cerca.nome}"`);

          const tipoEvento = dentroAgora ? 'entrada' : 'saida';

          // Verificar se devemos alertar este tipo de evento
          if (cerca.tipo_alerta === 'ambos' || cerca.tipo_alerta === tipoEvento) {
            const evento = await this.registrarEvento(
              cerca,
              dispositivo,
              tipoEvento,
              latitude,
              longitude,
              velocidade,
              timestamp
            );
            eventos.push(evento);
          }
        }

        // Atualizar cache
        this.estadoCache.set(cacheKey, {
          dentro: dentroAgora,
          ultimoEvento: eventos.length > 0 ? Date.now() : estadoAnterior?.ultimoEvento
        });
      }

      return eventos;
    } catch (error) {
      console.error('[Geofencing] Erro ao verificar posição:', error.message);
      return [];
    }
  }

  /**
   * Registrar evento de entrada/saída
   */
  async registrarEvento(cerca, dispositivo, tipoEvento, latitude, longitude, velocidade, timestamp) {
    // Salvar evento no banco
    const evento = await prisma.geofenceEvento.create({
      data: {
        geofence_id: cerca.id,
        dispositivo_id: dispositivo.id,
        tipo_evento: tipoEvento,
        latitude,
        longitude,
        velocidade,
        timestamp: timestamp || new Date()
      }
    });

    console.log(`[Geofencing] ${tipoEvento.toUpperCase()}: Dispositivo ${dispositivo.id} ${tipoEvento === 'entrada' ? 'entrou em' : 'saiu de'} "${cerca.nome}"`);

    // Criar alarme
    if (alarmeService) {
      try {
        const descricao = tipoEvento === 'entrada'
          ? `Veículo entrou na cerca "${cerca.nome}"`
          : `Veículo saiu da cerca "${cerca.nome}"`;

        await prisma.alarme.create({
          data: {
            dispositivo_id: dispositivo.id,
            tipo_alarme: `geofence_${tipoEvento}`,
            descricao,
            severidade: 'info',
            timestamp: timestamp || new Date()
          }
        });
      } catch (err) {
        console.error('[Geofencing] Erro ao criar alarme:', err.message);
      }
    }

    // Emitir evento WebSocket
    this.emitirEventoWebSocket({
      tipo: 'geofence_evento',
      organizacao_id: cerca.organizacao_id,
      dados: {
        evento_id: evento.id,
        tipo_evento: tipoEvento,
        geofence: {
          id: cerca.id,
          nome: cerca.nome,
          cor: cerca.cor
        },
        dispositivo: {
          id: dispositivo.id,
          placa: dispositivo.placa,
          veiculo: dispositivo.veiculo
        },
        latitude,
        longitude,
        velocidade,
        timestamp: evento.timestamp
      }
    });

    // Criar notificação (não bloquear o fluxo)
    const notifService = getNotificationService();
    if (notifService) {
      const veiculo = dispositivo.placa || dispositivo.veiculo || `Dispositivo ${dispositivo.id}`;
      const tipoNotif = tipoEvento === 'entrada' ? 'geofence_entrada' : 'geofence_saida';
      const titulo = tipoEvento === 'entrada'
        ? `Entrada em "${cerca.nome}"`
        : `Saída de "${cerca.nome}"`;
      const mensagem = tipoEvento === 'entrada'
        ? `${veiculo} entrou na cerca "${cerca.nome}"`
        : `${veiculo} saiu da cerca "${cerca.nome}"`;

      notifService.criar({
        organizacao_id: cerca.organizacao_id,
        dispositivo_id: dispositivo.id,
        tipo: tipoNotif,
        titulo,
        mensagem,
        severidade: 'info',
        dados_extras: {
          geofence_id: cerca.id,
          geofence_nome: cerca.nome,
          latitude,
          longitude,
          velocidade
        }
      }).catch(err => {
        console.warn('[Geofencing] Erro ao criar notificação:', err.message);
      });
    }

    return evento;
  }

  /**
   * Emitir evento via WebSocket
   */
  emitirEventoWebSocket(evento) {
    try {
      const wsClients = global.wsClients;
      if (!wsClients || wsClients.size === 0) {
        return;
      }

      const mensagem = JSON.stringify(evento);

      wsClients.forEach((client, id) => {
        try {
          // Filtrar por organização se disponível
          if (client.readyState === 1) { // OPEN
            if (!client.organizacao_id || client.organizacao_id === evento.organizacao_id) {
              client.send(mensagem);
            }
          }
        } catch (err) {
          console.error('[Geofencing] Erro ao enviar WebSocket:', err.message);
        }
      });
    } catch (error) {
      console.error('[Geofencing] Erro ao emitir WebSocket:', error.message);
    }
  }

  /**
   * Obter cercas ativas de uma organização (com cache)
   */
  async obterCercasAtivas(organizacao_id) {
    // Poderia usar Redis para cache, mas por simplicidade usamos query direta
    // As cercas raramente mudam e a query é rápida com índices
    return await prisma.geofence.findMany({
      where: {
        organizacao_id,
        ativo: true
      },
      select: {
        id: true,
        nome: true,
        latitude: true,
        longitude: true,
        raio_metros: true,
        tipo_alerta: true,
        cor: true,
        organizacao_id: true
      }
    });
  }

  // ==================== CÁLCULOS GEOMÉTRICOS ====================

  /**
   * Calcular distância entre dois pontos usando fórmula de Haversine
   * Retorna distância em metros
   */
  calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Raio da Terra em metros
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Converter graus para radianos
   */
  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Verificar se um ponto está dentro de um círculo
   */
  estaDentroCirculo(lat, lon, cercaLat, cercaLon, raioMetros) {
    const distancia = this.calcularDistanciaHaversine(lat, lon, cercaLat, cercaLon);
    return distancia <= raioMetros;
  }

  // ==================== HISTÓRICO DE EVENTOS ====================

  /**
   * Listar eventos de geofencing
   */
  async listarEventos(organizacao_id, filtros = {}) {
    const { geofence_id, dispositivo_id, tipo_evento, data_inicio, data_fim, limite = 100 } = filtros;

    // Construir filtro
    const where = {
      geofence: {
        organizacao_id
      }
    };

    if (geofence_id) where.geofence_id = parseInt(geofence_id);
    if (dispositivo_id) where.dispositivo_id = parseInt(dispositivo_id);
    if (tipo_evento) where.tipo_evento = tipo_evento;
    if (data_inicio || data_fim) {
      where.timestamp = {};
      if (data_inicio) where.timestamp.gte = new Date(data_inicio);
      if (data_fim) where.timestamp.lte = new Date(data_fim);
    }

    const eventos = await prisma.geofenceEvento.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limite,
      include: {
        geofence: {
          select: { id: true, nome: true, cor: true }
        },
        dispositivo: {
          select: { id: true, imei: true, placa: true, veiculo: true }
        }
      }
    });

    return eventos;
  }

  /**
   * Listar eventos por geofence
   */
  async listarEventosPorGeofence(geofence_id, limite = 50) {
    return await prisma.geofenceEvento.findMany({
      where: { geofence_id: parseInt(geofence_id) },
      orderBy: { timestamp: 'desc' },
      take: limite,
      include: {
        dispositivo: {
          select: { id: true, imei: true, placa: true, veiculo: true }
        }
      }
    });
  }

  /**
   * Listar eventos por dispositivo
   */
  async listarEventosPorDispositivo(imei, organizacao_id, limite = 50) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: { id: true }
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    return await prisma.geofenceEvento.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        geofence: {
          organizacao_id
        }
      },
      orderBy: { timestamp: 'desc' },
      take: limite,
      include: {
        geofence: {
          select: { id: true, nome: true, cor: true }
        }
      }
    });
  }

  /**
   * Obter status atual de um dispositivo (em quais cercas está)
   */
  async obterStatusDispositivo(imei, organizacao_id) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: { id: true }
    });

    if (!dispositivo) {
      throw new Error('Dispositivo não encontrado');
    }

    // Obter última localização
    const ultimaLocalizacao = await prisma.localizacao.findFirst({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { timestamp: 'desc' },
      select: { latitude: true, longitude: true, timestamp: true }
    });

    if (!ultimaLocalizacao) {
      return { dispositivo_id: dispositivo.id, cercas: [], ultima_localizacao: null };
    }

    // Verificar em quais cercas está
    const cercas = await this.obterCercasAtivas(organizacao_id);
    const cercasAtivas = [];

    for (const cerca of cercas) {
      const dentro = this.estaDentroCirculo(
        ultimaLocalizacao.latitude,
        ultimaLocalizacao.longitude,
        cerca.latitude,
        cerca.longitude,
        cerca.raio_metros
      );

      if (dentro) {
        const distancia = this.calcularDistanciaHaversine(
          ultimaLocalizacao.latitude,
          ultimaLocalizacao.longitude,
          cerca.latitude,
          cerca.longitude
        );

        cercasAtivas.push({
          id: cerca.id,
          nome: cerca.nome,
          cor: cerca.cor,
          distancia_centro: Math.round(distancia)
        });
      }
    }

    return {
      dispositivo_id: dispositivo.id,
      cercas: cercasAtivas,
      ultima_localizacao: ultimaLocalizacao
    };
  }

  // ==================== UTILITÁRIOS ====================

  /**
   * Limpar cache de uma geofence específica
   */
  limparCacheGeofence(geofence_id) {
    const keysToDelete = [];
    this.estadoCache.forEach((_, key) => {
      if (key.endsWith(`:${geofence_id}`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.estadoCache.delete(key));
  }

  /**
   * Obter estatísticas de geofencing
   */
  async obterEstatisticas(organizacao_id) {
    const [totalCercas, cercasAtivas, totalEventos, eventosHoje] = await Promise.all([
      prisma.geofence.count({ where: { organizacao_id } }),
      prisma.geofence.count({ where: { organizacao_id, ativo: true } }),
      prisma.geofenceEvento.count({
        where: { geofence: { organizacao_id } }
      }),
      prisma.geofenceEvento.count({
        where: {
          geofence: { organizacao_id },
          timestamp: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      })
    ]);

    return {
      total_cercas: totalCercas,
      cercas_ativas: cercasAtivas,
      total_eventos: totalEventos,
      eventos_hoje: eventosHoje
    };
  }
}

module.exports = new GeofencingService();
