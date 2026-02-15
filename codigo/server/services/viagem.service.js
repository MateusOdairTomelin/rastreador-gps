/**
 * Serviço de Viagem - Gerencia viagens para TODOS os dispositivos
 *
 * Funcionalidades:
 * - Detecta início de viagem (ignição OFF -> ON ou velocidade > 0)
 * - Detecta fim de viagem (ignição ON -> OFF ou velocidade = 0 por tempo)
 * - Calcula odômetro incremental baseado em GPS
 * - Calcula horímetro baseado em tempo de ignição/movimento
 * - Calcula velocidade média e máxima
 * - Mantém histórico de viagens
 *
 * NOTA: Dispositivos OBD2 (XT40_OBD2) também usam este sistema pois
 * não enviam dados OBD2 reais (RPM, temperatura, combustível).
 */

const prisma = require('../db/prisma');
const { supportsOBD2 } = require('../constants/device-types');

// ========== IMEI COM CONFIGURAÇÃO ESPECIAL DE VELOCIDADE ==========
// Dispositivos que precisam de threshold de velocidade mais baixo para detectar movimento
const IMEI_VELOCIDADE_ESPECIAL = {
  '356354870658615': { threshold: 0, descricao: 'Discovery - threshold zero para movimento' }
};

// ========== CONFIGURAÇÃO DE IGNIÇÃO POR VELOCIDADE ==========
// Para dispositivos OBD2 que não reportam tensão corretamente
// Usa velocidade para detectar motor ligado/desligado
const CONFIG_IGNICAO_VELOCIDADE = {
  velocidadeMinima: 5,           // km/h - acima disso considera motor ligado
  tempoParadoEncerrar: 5 * 60,   // 5 minutos em segundos - tempo parado para encerrar viagem
  habilitado: true               // Ativar/desativar globalmente
};

class ViagemService {
  /**
   * Calcula a distância entre dois pontos usando a fórmula de Haversine
   * @returns Distância em km
   */
  calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // Raio da Terra em km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Verifica se uma coordenada é válida
   * ✅ Agora inclui validação de região (Brasil) e detecção de oceano/fábrica
   */
  isValidCoordinate(lat, lng) {
    // Validações básicas
    if (lat === null || lng === null) return false;
    if (lat === 0 && lng === 0) return false;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;

    // ✅ Detecção de coordenadas de fábrica (Shenzhen, China)
    if (Math.abs(lat - 22.697629) < 0.1 && Math.abs(lng - 113.782373) < 0.1) {
      console.warn(`[Viagem] Coordenada de fábrica (Shenzhen) rejeitada: (${lat}, ${lng})`);
      return false;
    }

    // ✅ Validação de região: deve estar dentro do Brasil continental
    // Latitude: -34 a 6, Longitude: -74 a -32
    if (lat < -34 || lat > 6 || lng < -74 || lng > -32) {
      console.warn(`[Viagem] Coordenada fora do Brasil rejeitada: (${lat}, ${lng})`);
      return false;
    }

    // ✅ Detecção de coordenadas no oceano Atlântico Sul
    if (lat < -40 || (lat < -30 && lng < -55)) {
      console.warn(`[Viagem] Coordenada no oceano rejeitada: (${lat}, ${lng})`);
      return false;
    }

    return true;
  }

  /**
   * Detecta ignição virtual baseada na tensão da bateria principal
   * @param {number|null} tensao - Tensão da bateria principal em Volts
   * @param {number} limiteOn - Tensão mínima para motor ligado (default: 13.5V)
   * @param {number} limiteOff - Tensão máxima para motor desligado (default: 13.0V)
   * @returns {boolean|null} true se motor ligado, false se desligado, null se indeterminado
   */
  detectarIgnicaoVirtualPorTensao(tensao, limiteOn = 13.5, limiteOff = 13.0) {
    if (tensao === null || tensao === undefined) {
      return null;
    }
    if (tensao >= limiteOn) {
      return true;  // Motor ligado (alternador carregando)
    }
    if (tensao < limiteOff) {
      return false; // Motor desligado
    }
    return null; // Zona de histerese
  }

  /**
   * Processa uma atualização de localização para dispositivo sem OBD2
   * Atualiza métricas de viagem em tempo real
   *
   * @param imei - IMEI do dispositivo
   * @param ignicao - Estado atual da ignição (true = ligado)
   * @param latitude - Latitude atual
   * @param longitude - Longitude atual
   * @param velocidade - Velocidade atual em km/h
   * @param timestamp - Timestamp do pacote
   * @param tensaoPrincipal - Tensão da bateria principal (para ignição virtual)
   */
  async processarLocalizacao(imei, ignicao, latitude, longitude, velocidade, timestamp, tensaoPrincipal = null) {
    try {
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
      });

      if (!dispositivo) {
        console.warn(`[Viagem] Dispositivo não encontrado: ${imei}`);
        return null;
      }

      // ✅ REMOVIDO: Verificação que excluía dispositivos OBD2
      // Dispositivos XT40_OBD2 NÃO enviam dados OBD2 reais, então também
      // precisam do sistema de viagens baseado em GPS/ignição.
      // if (supportsOBD2(dispositivo.tipo)) {
      //   return null; // Dispositivos OBD2 usam dados embarcados
      // }

      const isOBD2Device = supportsOBD2(dispositivo.tipo);
      if (isOBD2Device) {
        console.log(`[Viagem] Processando dispositivo OBD2: ${imei} (tipo: ${dispositivo.tipo})`);
      }

      // ✅ DETECÇÃO INTELIGENTE DE IGNIÇÃO (funciona para TODOS os dispositivos)
      // CORREÇÃO: Prioridade depende do tipo de dispositivo
      // - Dispositivos com ignição virtual: usar TENSÃO (ignorar ACC que pode ser incorreto)
      // - Dispositivos sem ignição virtual: usar ACC
      let ignicaoFinal = ignicao;
      let metodoDeteccao = 'pacote';

      // Verificar se IMEI tem configuração especial de threshold
      const configEspecial = IMEI_VELOCIDADE_ESPECIAL[imei];
      const thresholdVelocidade = configEspecial ? configEspecial.threshold : 5;

      // 🔌 REGRA 1: Se dispositivo usa ignição virtual, TENSÃO tem prioridade (ignora ACC)
      if (dispositivo.usa_ignicao_virtual && tensaoPrincipal !== null && tensaoPrincipal > 0) {
        const limiteOn = dispositivo.tensao_motor_ligado || 13.8;
        const limiteOff = dispositivo.tensao_motor_deslig || 12.6;
        const ignicaoVirtual = this.detectarIgnicaoVirtualPorTensao(tensaoPrincipal, limiteOn, limiteOff);

        if (ignicaoVirtual !== null) {
          ignicaoFinal = ignicaoVirtual;
          metodoDeteccao = 'tensao';
          console.log(`🔌 [Viagem] ${imei}: Tensão ${tensaoPrincipal.toFixed(2)}V → Motor ${ignicaoVirtual ? 'LIGADO' : 'DESLIGADO'}`);
        }
      }
      // 🔑 REGRA 2: Para dispositivos SEM ignição virtual, usar ACC do pacote
      // Se ACC é false → motor desligado (ignorar velocidade - GPS drift)
      // EXCETO: Se tensão é NULL/0 e velocidade > threshold → usar velocidade (REGRA 2B)
      else if (ignicao === false) {
        // 🚗 REGRA 2B: Ignição por VELOCIDADE para dispositivos sem tensão confiável
        // Se tensão é NULL/0 e velocidade > threshold → motor ligado
        const tensaoNaoConfiavel = tensaoPrincipal === null || tensaoPrincipal === 0;
        const velocidadeAlta = (velocidade || 0) >= CONFIG_IGNICAO_VELOCIDADE.velocidadeMinima;

        if (CONFIG_IGNICAO_VELOCIDADE.habilitado && tensaoNaoConfiavel && velocidadeAlta) {
          ignicaoFinal = true;
          metodoDeteccao = 'velocidade';
          console.log(`🚗 [Viagem] ${imei}: ACC=OFF mas tensão NULL e vel=${velocidade}km/h → Motor LIGADO (por velocidade)`);
        }
        // Se tensão não confiável e velocidade = 0 mas tem viagem aberta → manter viagem (heartbeat encerrará)
        else if (CONFIG_IGNICAO_VELOCIDADE.habilitado && tensaoNaoConfiavel && dispositivo.viagem_inicio) {
          ignicaoFinal = true;  // Manter viagem aberta, heartbeat encerrará após timeout
          metodoDeteccao = 'velocidade_parado';
          console.log(`⏸️ [Viagem] ${imei}: ACC=OFF, tensão NULL, vel=0 → Mantendo viagem (heartbeat encerrará após ${CONFIG_IGNICAO_VELOCIDADE.tempoParadoEncerrar/60}min)`);
        }
        // Caso padrão: ACC=false → motor desligado
        else {
          ignicaoFinal = false;
          metodoDeteccao = 'acc_off';
          console.log(`🔑 [Viagem] ${imei}: ACC=OFF → Motor DESLIGADO (ignorando vel ${velocidade || 0} km/h)`);
        }
      }
      // 📡 REGRA 3: ACC é true ou undefined → usar valor do pacote
      else if (ignicao !== null && ignicao !== undefined) {
        ignicaoFinal = ignicao;
        metodoDeteccao = 'acc';
      }

      // Detectar estado anterior da ignição
      const ignicaoAnterior = dispositivo.viagem_inicio !== null;
      const ignicaoAtual = ignicaoFinal === true;

      console.log(`[Viagem] ${imei}: anterior=${ignicaoAnterior ? 'VIAGEM' : 'PARADO'}, atual=${ignicaoAtual ? 'LIGADO' : 'DESLIGADO'} (método=${metodoDeteccao}, vel=${velocidade || 0}km/h)`);

      // ========== TRANSIÇÃO: OFF -> ON (Início de viagem) ==========
      if (!ignicaoAnterior && ignicaoAtual) {
        console.log(`[Viagem] 🚗 INÍCIO DE VIAGEM: ${imei}`);
        await this.iniciarViagem(dispositivo.id, latitude, longitude, timestamp);
        return { evento: 'inicio_viagem', imei };
      }

      // ========== TRANSIÇÃO: ON -> OFF (Fim de viagem) ==========
      if (ignicaoAnterior && !ignicaoAtual) {
        console.log(`[Viagem] 🏁 FIM DE VIAGEM: ${imei}`);
        const viagem = await this.finalizarViagem(dispositivo.id, latitude, longitude, timestamp);
        return { evento: 'fim_viagem', imei, viagem };
      }

      // ========== DURANTE A VIAGEM (Atualização contínua) ==========
      if (ignicaoAtual && dispositivo.viagem_inicio) {
        await this.atualizarViagem(dispositivo.id, latitude, longitude, velocidade, timestamp);
        return { evento: 'atualizacao_viagem', imei };
      }

      return null;
    } catch (error) {
      console.error(`[Viagem] Erro ao processar localização: ${error.message}`);
      return null;
    }
  }

  /**
   * Inicia uma nova viagem
   */
  async iniciarViagem(dispositivoId, latitude, longitude, timestamp) {
    const now = timestamp || new Date();
    const coordValida = this.isValidCoordinate(latitude, longitude);

    await prisma.dispositivo.update({
      where: { id: dispositivoId },
      data: {
        viagem_inicio: now,
        viagem_odometro: 0,
        viagem_horimetro: 0,
        viagem_vel_max: 0,
        viagem_vel_soma: 0,
        viagem_vel_count: 0,
        // ✅ Salvar origem da viagem (fixo, não muda durante a viagem)
        viagem_origem_lat: coordValida ? latitude : null,
        viagem_origem_lng: coordValida ? longitude : null,
        // Última posição para cálculo incremental de distância
        viagem_ultima_lat: coordValida ? latitude : null,
        viagem_ultima_lng: coordValida ? longitude : null,
      },
    });

    console.log(`[Viagem] Viagem iniciada para dispositivo ${dispositivoId} em ${now.toISOString()} - Origem: ${latitude?.toFixed(6)}, ${longitude?.toFixed(6)}`);
  }

  /**
   * Atualiza métricas da viagem em andamento
   */
  async atualizarViagem(dispositivoId, latitude, longitude, velocidade, timestamp) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivoId },
    });

    if (!dispositivo || !dispositivo.viagem_inicio) {
      return;
    }

    let incrementoDistancia = 0;
    const coordenadaValida = this.isValidCoordinate(latitude, longitude);

    // Calcular distância incremental se tiver coordenadas válidas anteriores
    if (coordenadaValida &&
        dispositivo.viagem_ultima_lat !== null &&
        dispositivo.viagem_ultima_lng !== null) {

      incrementoDistancia = this.calcularDistanciaHaversine(
        dispositivo.viagem_ultima_lat,
        dispositivo.viagem_ultima_lng,
        latitude,
        longitude
      );

      // Filtrar movimentos muito pequenos (< 10 metros) ou muito grandes (> 5 km em um pacote)
      if (incrementoDistancia < 0.01 || incrementoDistancia > 5) {
        incrementoDistancia = 0;
      }
    }

    // Calcular tempo decorrido desde início da viagem
    const now = timestamp || new Date();
    const tempoDecorridoMs = now.getTime() - dispositivo.viagem_inicio.getTime();
    const tempoDecorridoHoras = tempoDecorridoMs / (1000 * 60 * 60);

    // Atualizar métricas
    const novoOdometro = (dispositivo.viagem_odometro || 0) + incrementoDistancia;
    const novaVelMax = Math.max(dispositivo.viagem_vel_max || 0, velocidade || 0);
    const novaVelSoma = (dispositivo.viagem_vel_soma || 0) + (velocidade || 0);
    const novoVelCount = (dispositivo.viagem_vel_count || 0) + 1;

    await prisma.dispositivo.update({
      where: { id: dispositivoId },
      data: {
        viagem_odometro: novoOdometro,
        viagem_horimetro: tempoDecorridoHoras,
        viagem_vel_max: novaVelMax,
        viagem_vel_soma: novaVelSoma,
        viagem_vel_count: novoVelCount,
        viagem_ultima_lat: coordenadaValida ? latitude : dispositivo.viagem_ultima_lat,
        viagem_ultima_lng: coordenadaValida ? longitude : dispositivo.viagem_ultima_lng,
      },
    });

    const velMedia = novoVelCount > 0 ? novaVelSoma / novoVelCount : 0;
    console.log(`[Viagem] Atualização: dist=${novoOdometro.toFixed(2)}km, tempo=${(tempoDecorridoHoras * 60).toFixed(1)}min, velMedia=${velMedia.toFixed(1)}km/h, velMax=${novaVelMax}km/h`);
  }

  /**
   * Finaliza a viagem atual e salva no histórico
   */
  async finalizarViagem(dispositivoId, latitude, longitude, timestamp) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivoId },
    });

    if (!dispositivo || !dispositivo.viagem_inicio) {
      return null;
    }

    const now = timestamp || new Date();

    // Calcular última atualização de distância
    let distanciaFinal = dispositivo.viagem_odometro || 0;
    if (this.isValidCoordinate(latitude, longitude) &&
        dispositivo.viagem_ultima_lat !== null &&
        dispositivo.viagem_ultima_lng !== null) {

      const incrementoFinal = this.calcularDistanciaHaversine(
        dispositivo.viagem_ultima_lat,
        dispositivo.viagem_ultima_lng,
        latitude,
        longitude
      );

      if (incrementoFinal >= 0.01 && incrementoFinal <= 5) {
        distanciaFinal += incrementoFinal;
      }
    }

    // Calcular métricas finais
    const tempoDecorridoMs = now.getTime() - dispositivo.viagem_inicio.getTime();
    let duracaoMinutos = tempoDecorridoMs / (1000 * 60);

    // ✅ Proteção contra timestamp fora de ordem (duração negativa)
    // Corrige tanto a duração quanto os timestamps de inicio/fim
    let inicioViagem = dispositivo.viagem_inicio;
    let fimViagem = now;

    if (duracaoMinutos < 0) {
      console.warn(`[Viagem] Timestamps invertidos detectados (${duracaoMinutos.toFixed(1)}min) - corrigindo ordem`);
      duracaoMinutos = Math.abs(duracaoMinutos);
      // Trocar inicio e fim para garantir ordem correta
      [inicioViagem, fimViagem] = [fimViagem, inicioViagem];
    }

    const velocidadeMedia = dispositivo.viagem_vel_count > 0
      ? dispositivo.viagem_vel_soma / dispositivo.viagem_vel_count
      : 0;

    // ✅ Usar origem CORRETA: viagem_origem_lat (salva no início) em vez de viagem_ultima_lat
    const origemLat = dispositivo.viagem_origem_lat || dispositivo.viagem_ultima_lat || latitude || 0;
    const origemLng = dispositivo.viagem_origem_lng || dispositivo.viagem_ultima_lng || longitude || 0;

    // ✅ CORRIGIDO: Só salvar viagem se teve movimento REAL
    // Thresholds aumentados para evitar viagens micro causadas por ACC oscilante
    // Critérios: (duração > 2 min E distância > 100m) OU (distância > 300m) OU (velocidade alta E distância mínima)
    const teveMovimentoReal = (
      (duracaoMinutos > 2 && distanciaFinal > 0.1) ||    // Viagem normal: > 2min E > 100m
      distanciaFinal > 0.3 ||                             // Distância significativa: > 300m
      ((dispositivo.viagem_vel_max || 0) > 20 && distanciaFinal > 0.05)  // Alta velocidade: > 20km/h E > 50m
    );

    if (teveMovimentoReal) {
      // Criar registro de viagem no histórico
      const viagem = await prisma.viagem.create({
        data: {
          dispositivo_id: dispositivoId,
          inicio: inicioViagem,  // ✅ Usa timestamp corrigido
          fim: fimViagem,        // ✅ Usa timestamp corrigido
          duracao_minutos: duracaoMinutos,
          distancia_km: distanciaFinal,
          velocidade_media: velocidadeMedia,
          velocidade_max: dispositivo.viagem_vel_max || 0,
          // ✅ CORRIGIDO: Usar origem salva no início da viagem
          origem_lat: origemLat,
          origem_lng: origemLng,
          destino_lat: latitude || 0,
          destino_lng: longitude || 0,
        },
      });

      console.log(`[Viagem] Viagem #${viagem.id} salva: ${distanciaFinal.toFixed(2)}km em ${duracaoMinutos.toFixed(1)}min, velMédia=${velocidadeMedia.toFixed(1)}km/h`);
      console.log(`[Viagem] Origem: ${origemLat.toFixed(6)}, ${origemLng.toFixed(6)} → Destino: ${latitude?.toFixed(6)}, ${longitude?.toFixed(6)}`);

      // Atualizar totais acumulados
      await prisma.dispositivo.update({
        where: { id: dispositivoId },
        data: {
          odometro_total: { increment: distanciaFinal },
          horimetro_total: { increment: duracaoMinutos / 60 }, // Converter para horas
          // Limpar dados da viagem atual
          viagem_inicio: null,
          viagem_odometro: 0,
          viagem_horimetro: 0,
          viagem_vel_max: 0,
          viagem_vel_soma: 0,
          viagem_vel_count: 0,
          viagem_origem_lat: null,
          viagem_origem_lng: null,
          viagem_ultima_lat: null,
          viagem_ultima_lng: null,
        },
      });

      return viagem;
    } else {
      // Viagem sem movimento real - apenas limpar dados (não salvar no histórico)
      await prisma.dispositivo.update({
        where: { id: dispositivoId },
        data: {
          viagem_inicio: null,
          viagem_odometro: 0,
          viagem_horimetro: 0,
          viagem_vel_max: 0,
          viagem_vel_soma: 0,
          viagem_vel_count: 0,
          viagem_origem_lat: null,
          viagem_origem_lng: null,
          viagem_ultima_lat: null,
          viagem_ultima_lng: null,
        },
      });

      console.log(`[Viagem] ⏭️ Viagem descartada (sem movimento real): ${distanciaFinal.toFixed(2)}km em ${duracaoMinutos.toFixed(1)}min, velMax=${dispositivo.viagem_vel_max || 0}km/h`);
      return null;
    }
  }

  /**
   * Obtém dados da viagem atual
   */
  async getViagemAtual(imei) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: {
        tipo: true,
        viagem_inicio: true,
        viagem_odometro: true,
        viagem_horimetro: true,
        viagem_vel_max: true,
        viagem_vel_soma: true,
        viagem_vel_count: true,
        odometro_total: true,
        horimetro_total: true,
      },
    });

    if (!dispositivo) {
      return null;
    }

    // Se tem viagem em andamento (para TODOS os dispositivos, incluindo OBD2)
    if (dispositivo.viagem_inicio) {
      const velocidadeMedia = dispositivo.viagem_vel_count > 0
        ? dispositivo.viagem_vel_soma / dispositivo.viagem_vel_count
        : 0;

      return {
        em_viagem: true,
        viagem_atual: {
          inicio: dispositivo.viagem_inicio,
          odometro: dispositivo.viagem_odometro,
          horimetro: dispositivo.viagem_horimetro,
          velocidade_media: parseFloat(velocidadeMedia.toFixed(1)),
          velocidade_max: dispositivo.viagem_vel_max,
          duracao_minutos: parseFloat(((Date.now() - dispositivo.viagem_inicio.getTime()) / (1000 * 60)).toFixed(1)),
        },
        totais: {
          odometro_total: dispositivo.odometro_total,
          horimetro_total: dispositivo.horimetro_total,
        },
      };
    }

    // Se não está em viagem, retornar apenas totais
    return {
      em_viagem: false,
      viagem_atual: null,
      totais: {
        odometro_total: dispositivo.odometro_total,
        horimetro_total: dispositivo.horimetro_total,
      },
    };
  }

  /**
   * Obtém histórico de viagens de um dispositivo
   */
  async getHistoricoViagens(imei, limite = 20) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      return [];
    }

    return await prisma.viagem.findMany({
      where: { dispositivo_id: dispositivo.id },
      orderBy: { inicio: 'desc' },
      take: limite,
    });
  }

  /**
   * Obtém estatísticas de viagem de um período
   */
  async getEstatisticasPeriodo(imei, dataInicio, dataFim) {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
    });

    if (!dispositivo) {
      return null;
    }

    const viagens = await prisma.viagem.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        inicio: { gte: dataInicio },
        fim: { lte: dataFim },
      },
    });

    if (viagens.length === 0) {
      return {
        total_viagens: 0,
        distancia_total: 0,
        tempo_total_minutos: 0,
        velocidade_media_geral: 0,
        velocidade_max_geral: 0,
      };
    }

    const distanciaTotal = viagens.reduce((sum, v) => sum + v.distancia_km, 0);
    const tempoTotal = viagens.reduce((sum, v) => sum + v.duracao_minutos, 0);
    const velMaxGeral = Math.max(...viagens.map(v => v.velocidade_max));
    const velMediaGeral = distanciaTotal / (tempoTotal / 60); // km/h

    return {
      total_viagens: viagens.length,
      distancia_total: parseFloat(distanciaTotal.toFixed(2)),
      tempo_total_minutos: parseFloat(tempoTotal.toFixed(1)),
      tempo_total_horas: parseFloat((tempoTotal / 60).toFixed(2)),
      velocidade_media_geral: parseFloat(velMediaGeral.toFixed(1)),
      velocidade_max_geral: velMaxGeral,
    };
  }
}

module.exports = new ViagemService();
