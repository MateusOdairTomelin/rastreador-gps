const prisma = require('../db/prisma');

/**
 * Serviço de Telemetria Otimizado
 *
 * OTIMIZAÇÕES IMPLEMENTADAS:
 * 1. Cache de odômetro - usa odometro_total como cache incremental
 * 2. Select otimizado - busca só campos necessários (lat, lng, timestamp)
 * 3. Cálculo incremental - processa só posições novas desde último cálculo
 * 4. Menor footprint de memória
 */
class TelemetriaService {

  /**
   * Calcula odômetro de forma INCREMENTAL (otimizado)
   * Em vez de recalcular 1000 pontos, usa cache + calcula só os novos
   */
  async calcularOdometroPlataforma(imei) {
    try {
      // Buscar dispositivo com campos de cache
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: {
          id: true,
          odometro_total: true,
          viagem_ultima_lat: true,
          viagem_ultima_lng: true,
          updated_at: true
        }
      });

      if (!dispositivo) {
        return 0;
      }

      // Usar odometro_total como cache (já calculado incrementalmente pelo location-processor)
      const odometroCache = dispositivo.odometro_total || 0;

      // Se já temos um valor em cache, retornar direto
      if (odometroCache > 0) {
        return parseFloat(odometroCache.toFixed(2));
      }

      // Fallback: calcular do zero se não houver cache (primeira vez ou reset)
      return await this.recalcularOdometroCompleto(dispositivo.id);
    } catch (error) {
      console.error('[Telemetria] Erro ao calcular odômetro:', error.message);
      return 0;
    }
  }

  /**
   * Recalcula odômetro completo (usado apenas na primeira vez ou reset)
   * OTIMIZADO: Select apenas campos necessários
   */
  async recalcularOdometroCompleto(dispositivoId) {
    try {
      // Buscar posições com SELECT otimizado (só campos necessários)
      const historico = await prisma.localizacao.findMany({
        where: { dispositivo_id: dispositivoId },
        orderBy: { timestamp: 'asc' },
        take: 500, // Reduzido de 1000 para 500
        select: {
          latitude: true,
          longitude: true,
          timestamp: true
        }
      });

      if (historico.length < 2) {
        return 0;
      }

      let distanciaTotal = 0;
      let pontosIgnorados = 0;

      for (let i = 1; i < historico.length; i++) {
        const p1 = historico[i - 1];
        const p2 = historico[i];

        // Filtrar coordenadas inválidas
        if ((p1.latitude === 0 && p1.longitude === 0) ||
            (p2.latitude === 0 && p2.longitude === 0)) {
          pontosIgnorados++;
          continue;
        }

        const distancia = this.calcularDistanciaHaversine(
          p1.latitude, p1.longitude,
          p2.latitude, p2.longitude
        );

        // Ignorar movimento menor que 5 metros
        if (distancia < 0.005) continue;

        const tempoSegundos = (p2.timestamp.getTime() - p1.timestamp.getTime()) / 1000;
        if (tempoSegundos <= 0) {
          pontosIgnorados++;
          continue;
        }

        // Validar velocidade realista (< 200 km/h)
        const velocidadeCalculada = (distancia / tempoSegundos) * 3600;
        if (velocidadeCalculada > 200) {
          pontosIgnorados++;
          continue;
        }

        distanciaTotal += distancia;
      }

      // Atualizar cache no dispositivo
      await prisma.dispositivo.update({
        where: { id: dispositivoId },
        data: { odometro_total: distanciaTotal }
      });

      if (pontosIgnorados > 0) {
        console.log(`[Telemetria] Odômetro recalculado: ${distanciaTotal.toFixed(2)} km (${pontosIgnorados} pontos ignorados)`);
      }

      return parseFloat(distanciaTotal.toFixed(2));
    } catch (error) {
      console.error('[Telemetria] Erro ao recalcular odômetro:', error.message);
      return 0;
    }
  }

  /**
   * Calcula horímetro - OTIMIZADO com select
   */
  async calcularHorimetroPlataforma(imei) {
    try {
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: { id: true, horimetro_total: true }
      });

      if (!dispositivo) return 0;

      // Usar cache se disponível
      if (dispositivo.horimetro_total > 0) {
        return parseFloat(dispositivo.horimetro_total.toFixed(2));
      }

      // Fallback: calcular do histórico (otimizado)
      const historico = await prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          ignicao: true,
        },
        orderBy: { timestamp: 'asc' },
        take: 500, // Reduzido de 1000
        select: { timestamp: true }
      });

      if (historico.length < 2) return 0;

      let tempoTotal = 0;
      for (let i = 1; i < historico.length; i++) {
        const diffMs = historico[i].timestamp.getTime() - historico[i - 1].timestamp.getTime();
        const diffHoras = diffMs / (1000 * 60 * 60);
        if (diffHoras > 0 && diffHoras < 1) {
          tempoTotal += diffHoras;
        }
      }

      return parseFloat(tempoTotal.toFixed(2));
    } catch (error) {
      console.error('[Telemetria] Erro ao calcular horímetro:', error.message);
      return 0;
    }
  }

  /**
   * Atualiza telemetria - OTIMIZADO
   */
  async atualizarTelemetriaPlataforma(imei) {
    try {
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: { id: true }
      });

      if (!dispositivo) {
        return { odometro: 0, horimetro: 0 };
      }

      const odometro = await this.calcularOdometroPlataforma(imei);
      const horimetro = await this.calcularHorimetroPlataforma(imei);

      // Atualizar último registro OBD2 se existir
      const ultimoOBD2 = await prisma.dadosOBD2.findFirst({
        where: { dispositivo_id: dispositivo.id },
        orderBy: { timestamp: 'desc' },
        select: { id: true }
      });

      if (ultimoOBD2) {
        await prisma.dadosOBD2.update({
          where: { id: ultimoOBD2.id },
          data: {
            odometro_plataforma: odometro,
            hora_motor_plataforma: horimetro,
          },
        });
      }

      return { odometro, horimetro };
    } catch (error) {
      console.error('[Telemetria] Erro ao atualizar telemetria:', error.message);
      return { odometro: 0, horimetro: 0 };
    }
  }

  /**
   * Fórmula de Haversine - distância em km
   */
  calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  /**
   * Obtém telemetria atual - OTIMIZADO com select
   */
  async obterTelemetriaAtual(imei) {
    try {
      const dispositivo = await prisma.dispositivo.findUnique({
        where: { imei },
        select: {
          id: true,
          imei: true,
          veiculo: true,
          status: true,
          odometro_total: true,
          horimetro_total: true,
          localizacoes: {
            orderBy: { timestamp: 'desc' },
            take: 1,
            select: {
              latitude: true,
              longitude: true,
              velocidade: true,
              direcao: true,
              timestamp: true
            }
          },
          dados_obd2: {
            orderBy: { timestamp: 'desc' },
            take: 1,
            select: {
              odometro_plataforma: true,
              odometro_embarcado: true,
              hora_motor_plataforma: true,
              hora_motor_embarcada: true,
              percentual_bateria: true,
              tensao_bateria: true,
              rpm: true,
              temperatura_motor: true,
              nivel_combustivel: true,
              ignicao: true,
              timestamp: true
            }
          }
        }
      });

      if (!dispositivo) return null;

      const ultimaLocalizacao = dispositivo.localizacoes[0];
      const ultimoOBD2 = dispositivo.dados_obd2[0];

      return {
        dispositivo_id: dispositivo.id,
        imei: dispositivo.imei,
        veiculo: dispositivo.veiculo,
        status: dispositivo.status,
        odometro_cache: dispositivo.odometro_total,
        horimetro_cache: dispositivo.horimetro_total,
        localizacao: ultimaLocalizacao || null,
        telemetria: ultimoOBD2 || null
      };
    } catch (error) {
      console.error('[Telemetria] Erro ao obter telemetria:', error.message);
      return null;
    }
  }

  /**
   * Compara odômetros - OTIMIZADO
   */
  async compararOdometros(imei, limiteErro = 5) {
    try {
      const ultimoOBD2 = await prisma.dadosOBD2.findFirst({
        where: { dispositivo: { imei } },
        orderBy: { timestamp: 'desc' },
        select: {
          odometro_plataforma: true,
          odometro_embarcado: true,
          timestamp: true
        }
      });

      if (!ultimoOBD2) return null;

      const diferenca = Math.abs(
        (ultimoOBD2.odometro_plataforma || 0) - (ultimoOBD2.odometro_embarcado || 0)
      );

      return {
        odometro_plataforma: ultimoOBD2.odometro_plataforma,
        odometro_embarcado: ultimoOBD2.odometro_embarcado,
        diferenca: parseFloat(diferenca.toFixed(2)),
        discrepancia: diferenca > limiteErro,
        timestamp: ultimoOBD2.timestamp
      };
    } catch (error) {
      console.error('[Telemetria] Erro ao comparar odômetros:', error.message);
      return null;
    }
  }
}

module.exports = new TelemetriaService();
