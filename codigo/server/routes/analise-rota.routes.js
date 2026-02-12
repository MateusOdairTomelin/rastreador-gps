const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const fetch = require('node-fetch');

// ✅ Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant } = require('../middleware/tenant-device.middleware');

// Serviço de filtro GPS com Kalman, Hampel, etc.
const gpsFilterService = require('../services/gps-filter.service');

// ✅ Serviço de IA para correção de GPS
let gpsAI = null;
try {
  gpsAI = require('../services/gps-ai.service');
  console.log('[Análise Rota] IA GPS carregada para correção automática');
} catch (e) {
  console.warn('[Análise Rota] IA GPS não disponível:', e.message);
}

// ✅ Serviço de aprendizado de rotas
let gpsAprendizado = null;
try {
  gpsAprendizado = require('../services/gps-aprendizado.service');
  console.log('[Análise Rota] Aprendizado GPS carregado');
} catch (e) {
  console.warn('[Análise Rota] Aprendizado GPS não disponível:', e.message);
}

// ✅ NOVO: Serviço GPS Unificado (central)
let gpsUnificado = null;
try {
  gpsUnificado = require('../services/gps-unificado.service');
  console.log('[Análise Rota] GPS Unificado carregado');
} catch (e) {
  console.warn('[Análise Rota] GPS Unificado não disponível:', e.message);
}

// Limites de velocidade por tipo de via (km/h)
const LIMITES_VELOCIDADE = {
  residencial: 40,
  urbana: 60,
  rodovia: 80,
  expressa: 110,
  default: 60 // Padrão se não identificado
};

/**
 * Analisa trajeto completo com detecção de eventos
 * GET /api/analise-rota/:imei/analisar?horas=24
 * ✅ Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/analisar', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    // Buscar histórico de localizações + OBD2
    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        },
        dados_obd2: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    // Análise de trajeto
    const eventos = [];
    const pontos = [];
    let tempoOciosoTotal = 0;
    let tempoMovimentoTotal = 0;
    let tempoParadoTotal = 0;
    let distanciaTotal = 0;
    let distanciaOcioso = 0;
    let distanciaMovimento = 0;
    let excesoesVelocidade = 0;

    for (let i = 0; i < dispositivo.localizacoes.length; i++) {
      const loc = dispositivo.localizacoes[i];
      const locAnterior = i > 0 ? dispositivo.localizacoes[i - 1] : null;

      // Buscar dados OBD2 correspondentes (timestamp próximo)
      const obd2 = dispositivo.dados_obd2.find(o => {
        const diff = Math.abs(new Date(o.timestamp) - new Date(loc.timestamp));
        return diff < 60000; // Diferença < 1 minuto
      });

      // Tipo de ponto
      let tipoPonto = 'normal';
      let evento = null;

      // 1. Detectar EXCESSO DE VELOCIDADE
      const limiteVia = LIMITES_VELOCIDADE.default;
      if (loc.velocidade > limiteVia) {
        tipoPonto = 'excesso_velocidade';
        excesoesVelocidade++;
        evento = {
          tipo: 'excesso_velocidade',
          timestamp: loc.timestamp,
          latitude: loc.latitude,
          longitude: loc.longitude,
          velocidade: loc.velocidade,
          limite: limiteVia,
          excesso: loc.velocidade - limiteVia
        };
        eventos.push(evento);
      }

      // 2. Detectar OCIOSO (motor ligado, velocidade 0)
      // ✅ Lógica diferenciada por tipo de dispositivo
      let motorLigado = false;
      let motorDesligado = false;

      if (dispositivo.tipo === 'XT40_4F') {
        // XT40_4F: Usa ignição virtual (baseada na tensão da bateria)
        motorLigado = loc.ignicao === true && loc.velocidade === 0;
        motorDesligado = loc.ignicao === false && loc.velocidade === 0;
      } else if (dispositivo.tipo === 'XT40_OBD2') {
        // XT40_OBD2: Primeiro tenta RPM, senão usa estado de ignição
        const temRPM = obd2 && obd2.rpm !== null && obd2.rpm !== undefined;
        if (temRPM) {
          // RPM disponível - usar dados reais da ECU
          motorLigado = obd2.rpm >= 500 && loc.velocidade === 0;
          motorDesligado = obd2.rpm < 500 && loc.velocidade === 0;
        } else {
          // ✅ FALLBACK: Sem RPM - detectar ocioso se houve movimento recente
          if (loc.velocidade === 0) {
            // Verificar se houve movimento nos últimos 10 minutos
            let temMovimentoRecente = false;
            for (let j = i - 1; j >= 0 && j > i - 30; j--) {
              const locPassada = dispositivo.localizacoes[j];
              const diffTempo = (new Date(loc.timestamp) - new Date(locPassada.timestamp)) / (1000 * 60);
              if (diffTempo > 10) break; // Só olhar últimos 10 minutos
              if (locPassada.velocidade > 3) {
                temMovimentoRecente = true;
                break;
              }
            }
            // Se houve movimento recente = OCIOSO (motor provavelmente ligado)
            // Se não houve movimento recente = PARADO (motor desligado)
            motorLigado = temMovimentoRecente;
            motorDesligado = !temMovimentoRecente;
          }
        }
      } else {
        // Outros dispositivos: usar estado de ignição
        motorLigado = loc.ignicao === true && loc.velocidade === 0;
        motorDesligado = loc.ignicao === false && loc.velocidade === 0;
      }

      if (motorLigado) {
        // Calcular tempo ocioso (diferença com ponto anterior)
        if (locAnterior) {
          const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);
          // ✅ Sempre acumular tempo ocioso (mesmo intervalos pequenos)
          tipoPonto = 'ocioso';
          tempoOciosoTotal += tempoMinutos;
          // Só criar evento se intervalo > 1 min (evitar spam de eventos)
          if (tempoMinutos > 1) {
            evento = {
              tipo: 'ocioso',
              timestamp: loc.timestamp,
              latitude: loc.latitude,
              longitude: loc.longitude,
              rpm: obd2?.rpm || null,
              ignicao: loc.ignicao,
              duracao_minutos: tempoMinutos.toFixed(1)
            };
            eventos.push(evento);
          }
        }
      }

      // 3. Detectar PARADA (motor desligado)
      if (motorDesligado) {
        if (locAnterior) {
          const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);
          if (tempoMinutos > 5) { // Parado por mais de 5 minutos
            tipoPonto = 'parada';
            evento = {
              tipo: 'parada',
              timestamp: loc.timestamp,
              latitude: loc.latitude,
              longitude: loc.longitude,
              ignicao: loc.ignicao,
              duracao_minutos: tempoMinutos.toFixed(1)
            };
            eventos.push(evento);
          }
        }
      }

      // 4. Calcular distância e tempo percorrido
      if (locAnterior) {
        const dist = calcularDistancia(
          locAnterior.latitude, locAnterior.longitude,
          loc.latitude, loc.longitude
        );
        const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

        distanciaTotal += dist;

        // Separar por estado
        if (loc.velocidade > 0) {
          // Em movimento
          distanciaMovimento += dist;
          tempoMovimentoTotal += tempoMinutos;
        } else if (tipoPonto === 'ocioso') {
          // Ocioso (motor ligado, parado)
          distanciaOcioso += dist; // Geralmente 0, mas pode ter pequenas variações
        } else if (tipoPonto === 'parada') {
          // Parado (motor desligado)
          tempoParadoTotal += tempoMinutos;
        }
      }

      // Adicionar ponto ao trajeto
      pontos.push({
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.timestamp,
        velocidade: loc.velocidade,
        tipo: tipoPonto,
        ignicao: loc.ignicao,
        rpm: obd2?.rpm || null,
        evento: evento
      });
    }

    // Estatísticas gerais
    const estatisticas = {
      periodo_horas: horas,
      total_pontos: pontos.length,
      distancia_km: distanciaTotal.toFixed(2),
      distancia_movimento_km: distanciaMovimento.toFixed(2),
      tempo_movimento_minutos: tempoMovimentoTotal.toFixed(1),
      tempo_ocioso_minutos: tempoOciosoTotal.toFixed(1),
      tempo_parado_minutos: tempoParadoTotal.toFixed(1),
      excessos_velocidade: excesoesVelocidade,
      total_eventos: eventos.length,
      tipo_dispositivo: dispositivo.tipo
    };

    // Eventos por tipo
    const eventosPorTipo = {
      excesso_velocidade: eventos.filter(e => e.tipo === 'excesso_velocidade').length,
      ocioso: eventos.filter(e => e.tipo === 'ocioso').length,
      parada: eventos.filter(e => e.tipo === 'parada').length
    };

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        estatisticas,
        eventos_por_tipo: eventosPorTipo,
        pontos: pontos,
        eventos: eventos.slice(0, 50) // Limitar a 50 eventos principais
      }
    });

  } catch (error) {
    console.error('[Análise Rota] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * Calcula distância entre dois pontos GPS (Haversine)
 */
function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Obtém rota suavizada com SNAP TO ROAD (OSRM)
 * Ajusta os pontos GPS para seguir as estradas reais
 * GET /api/analise-rota/:imei/rota-suavizada?horas=24&snapToRoad=true
 */
router.get('/:imei/rota-suavizada', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;
    const snapToRoad = req.query.snapToRoad !== 'false'; // Ativado por padrão

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({ sucesso: false, dados: { pontos: [] } });
    }

    // Filtrar pontos GPS válidos (remover pontos com coordenadas inválidas ou muito distantes)
    let localizacoes = dispositivo.localizacoes.filter(loc => {
      // Coordenadas válidas (Brasil aproximadamente)
      if (!loc.latitude || !loc.longitude) return false;
      if (loc.latitude < -35 || loc.latitude > 5) return false;
      if (loc.longitude < -75 || loc.longitude > -30) return false;
      return true;
    });

    // Remover pontos com saltos impossíveis (velocidade > 200km/h entre pontos)
    localizacoes = filtrarSaltosImpossveis(localizacoes);

    if (localizacoes.length < 2) {
      return res.json({ sucesso: true, dados: { pontos: localizacoes.map(l => ({
        latitude: l.latitude,
        longitude: l.longitude,
        velocidade: l.velocidade,
        timestamp: l.timestamp
      })) } });
    }

    let pontosProcessados;

    // ✅ Usar OSRM para snap-to-road se habilitado
    if (snapToRoad && localizacoes.length >= 2) {
      try {
        pontosProcessados = await snapToRoadOSRM(localizacoes);
        console.log(`[Rota] OSRM snap-to-road: ${localizacoes.length} -> ${pontosProcessados.length} pontos`);
      } catch (osrmError) {
        console.warn('[Rota] OSRM falhou, usando interpolação local:', osrmError.message);
        pontosProcessados = processarRotaInteligente(localizacoes);
      }
    } else {
      // Processar rota com filtros inteligentes e suavização local
      pontosProcessados = processarRotaInteligente(localizacoes);
    }

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        total_pontos: pontosProcessados.length,
        total_original: dispositivo.localizacoes.length,
        periodo_horas: horas,
        snap_to_road: snapToRoad,
        pontos: pontosProcessados
      }
    });

  } catch (error) {
    console.error('[Rota Suavizada] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * Retorna pontos GPS ORIGINAIS (sem correção automática)
 * ⚠️ ALTERADO: Não aplica correção automaticamente - usuário deve aprovar
 * GET /api/analise-rota/:imei/pontos-gps?horas=24
 */
router.get('/:imei/pontos-gps', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    // ✅ ATIVADO: Aplicar correção com OSRM para colar pontos nas ruas
    const aplicarCorrecao = req.query.correcao !== 'false'; // Ativo por padrão

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({ sucesso: true, dados: { pontos: [], ia_correcao: null } });
    }

    // Preparar pontos
    let pontos = dispositivo.localizacoes.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade,
      direcao: l.direcao,
      timestamp: l.timestamp,
      ignicao: l.ignicao
    }));

    let estatisticasIA = null;

    // ✅ Aplicar correção com OSRM (cola pontos nas ruas reais)
    if (aplicarCorrecao && pontos.length > 1) {
      try {
        // Usar gpsFilterService com OSRM para colar pontos nas ruas
        const resultado = await gpsFilterService.processarRotaCompleta(pontos, {
          usarKalman: true,
          usarMediaMovel: false,
          usarHampel: true,
          usarInterpolacao: true,
          usarOSRM: true  // ✅ OSRM ativado - cola nas ruas
        });

        const pontosCorrigidos = resultado.pontos || [];
        const totalCorrigidos = pontosCorrigidos.filter(p => p.matched || p.kalman_filtered).length;

        estatisticasIA = {
          ativada: true,
          osrm_ativo: true,
          pontos_originais: resultado.stats?.original || pontos.length,
          pontos_analisados: pontosCorrigidos.length,
          pontos_corrigidos: totalCorrigidos,
          pontos_interpolados: resultado.stats?.interpolados || 0,
          taxa_correcao: ((totalCorrigidos / Math.max(1, pontosCorrigidos.length)) * 100).toFixed(2) + '%',
        };

        pontos = pontosCorrigidos.map(p => ({
          latitude: p.latitude,
          longitude: p.longitude,
          velocidade: p.velocidade,
          direcao: p.direcao,
          timestamp: p.timestamp,
          ignicao: p.ignicao,
          corrigido_ia: p.matched || p.kalman_filtered || false,
        }));

      } catch (iaError) {
        console.warn(`[Pontos GPS] Erro na correção OSRM: ${iaError.message}`);
        estatisticasIA = { ativada: false, osrm_ativo: false, erro: iaError.message };
      }
    }

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        total_pontos: pontos.length,
        periodo_horas: horas,
        ia_correcao: estatisticasIA,
        // Informar status da correção
        aviso: aplicarCorrecao
          ? 'Pontos GPS processados com OSRM (colados nas ruas reais).'
          : 'Pontos GPS originais. Adicione ?correcao=true para aplicar correção.',
        pontos
      }
    });

  } catch (error) {
    console.error('[Pontos GPS] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PRÉVIA de correção IA - NÃO aplica, apenas mostra comparação
 * ✅ Mostra rota original vs rota com micro-ajustes sugeridos pela IA
 * GET /api/analise-rota/:imei/preview-correcao-ia?horas=24
 * GET /api/analise-rota/:imei/preview-correcao-ia?dataInicio=ISO&dataFim=ISO (para viagens específicas)
 */
router.get('/:imei/preview-correcao-ia', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { dataInicio, dataFim } = req.query;
    const horas = parseInt(req.query.horas) || 24;

    if (!gpsAI) {
      return res.json({
        sucesso: false,
        erro: 'Serviço de IA não disponível'
      });
    }

    // Se dataInicio e dataFim forem fornecidos, usar eles (viagem específica)
    // Senão, usar horas como antes
    let whereClause;
    if (dataInicio && dataFim) {
      whereClause = {
        timestamp: {
          gte: new Date(dataInicio),
          lte: new Date(dataFim)
        }
      };
    } else {
      const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);
      whereClause = {
        timestamp: { gte: timestampLimite }
      };
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: whereClause,
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({
        sucesso: true,
        dados: {
          pontos_originais: [],
          pontos_sugeridos: [],
          estatisticas: null
        }
      });
    }

    // Preparar pontos originais brutos
    const pontosOriginaisBrutos = dispositivo.localizacoes.map(l => ({
      id: l.id,
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade,
      direcao: l.direcao,
      timestamp: l.timestamp,
      ignicao: l.ignicao
    }));

    // ✅ USAR A MESMA LÓGICA DO APLICAR (gerarSugestoesMicroAjustes)
    // Isso garante que o preview mostra exatamente o que será aplicado
    let pontosOriginais = pontosOriginaisBrutos;
    let pontosSugeridos = [];

    try {
      // Usar gerarSugestoesMicroAjustes (OSRM snap-to-road com limite de 15m)
      // Mesma função usada pelo endpoint aplicar-correcao-ia
      pontosSugeridos = await gerarSugestoesMicroAjustes(pontosOriginaisBrutos, dispositivo.id);

      console.log(`[Preview IA] ${pontosOriginaisBrutos.length} pontos processados com OSRM snap-to-road`);
    } catch (filterError) {
      console.warn(`[Preview IA] Erro ao processar com OSRM:`, filterError.message);
      // Em caso de erro, manter pontos originais sem ajustes
      pontosSugeridos = pontosOriginaisBrutos.map(p => ({
        ...p,
        ajuste_sugerido: false,
        motivo_ajuste: null
      }));
    }

    // Calcular estatísticas da prévia
    let totalAjustes = 0;
    let distanciaTotalAjuste = 0;
    const ajustesDetalhes = [];

    for (let i = 0; i < pontosOriginais.length; i++) {
      const orig = pontosOriginais[i];
      const sug = pontosSugeridos[i];

      // Verificar se sug existe e tem ajuste sugerido
      if (sug && sug.ajuste_sugerido) {
        totalAjustes++;
        const dist = calcularDistancia(orig.latitude, orig.longitude, sug.latitude, sug.longitude) * 1000;
        distanciaTotalAjuste += dist;
        ajustesDetalhes.push({
          indice: i,
          timestamp: orig.timestamp,
          original: { lat: orig.latitude, lng: orig.longitude },
          sugerido: { lat: sug.latitude, lng: sug.longitude },
          distancia_metros: dist.toFixed(2),
          motivo: sug.motivo_ajuste
        });
      }
    }

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_horas: horas,
        estatisticas: {
          total_pontos: pontosOriginais.length,
          ajustes_sugeridos: totalAjustes,
          distancia_media_ajuste: totalAjustes > 0 ? (distanciaTotalAjuste / totalAjustes).toFixed(2) + 'm' : '0m',
          taxa_ajustes: ((totalAjustes / pontosOriginais.length) * 100).toFixed(2) + '%'
        },
        // Rota original (para comparação no mapa)
        pontos_originais: pontosOriginais.map(p => ({
          lat: p.latitude,
          lng: p.longitude,
          vel: p.velocidade,
          ts: p.timestamp
        })),
        // Rota com micro-ajustes sugeridos (prévia)
        pontos_sugeridos: pontosSugeridos.filter(p => p).map(p => ({
          lat: p.latitude,
          lng: p.longitude,
          vel: p.velocidade,
          ts: p.timestamp,
          ajustado: p.ajuste_sugerido || false,
          motivo: p.motivo_ajuste || null
        })),
        // Detalhes dos ajustes para revisão
        detalhes_ajustes: ajustesDetalhes
      }
    });

  } catch (error) {
    console.error('[Preview Correção IA] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * APLICAR correção IA - Só após aprovação do usuário
 * POST /api/analise-rota/:imei/aplicar-correcao-ia
 * Body: { horas: 24 } ou { dataInicio: ISO, dataFim: ISO } para viagens específicas
 */
router.post('/:imei/aplicar-correcao-ia', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { horas, ajustes_aprovados, dataInicio, dataFim } = req.body;

    if (!gpsAI) {
      return res.json({
        sucesso: false,
        erro: 'Serviço de IA não disponível'
      });
    }

    // Se dataInicio e dataFim forem fornecidos, usar eles (viagem específica)
    // Senão, usar horas como antes
    let whereClause;
    if (dataInicio && dataFim) {
      whereClause = {
        timestamp: {
          gte: new Date(dataInicio),
          lte: new Date(dataFim)
        }
      };
    } else {
      const horasNum = parseInt(horas) || 24;
      const timestampLimite = new Date(Date.now() - horasNum * 60 * 60 * 1000);
      whereClause = {
        timestamp: { gte: timestampLimite }
      };
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    // Buscar localizações do período
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        ...whereClause
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.json({ sucesso: false, erro: 'Nenhuma localização encontrada' });
    }

    // Gerar sugestões novamente
    const pontosOriginais = localizacoes.map(l => ({
      id: l.id,
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade,
      direcao: l.direcao,
      timestamp: l.timestamp
    }));

    // ✅ Passa dispositivo.id para usar serviço unificado
    const pontosSugeridos = await gerarSugestoesMicroAjustes(pontosOriginais, dispositivo.id);

    // Aplicar APENAS os ajustes que o usuário aprovou
    let ajustesAplicados = 0;

    for (let i = 0; i < pontosSugeridos.length; i++) {
      const sugestao = pontosSugeridos[i];
      const original = pontosOriginais[i];

      // Verificar se este ajuste foi aprovado pelo usuário
      const foiAprovado = !ajustes_aprovados || ajustes_aprovados.length === 0 ||
                          ajustes_aprovados.includes(i);

      if (sugestao.ajuste_sugerido && foiAprovado) {
        // Atualizar no banco de dados
        await prisma.localizacao.update({
          where: { id: original.id },
          data: {
            latitude: sugestao.latitude,
            longitude: sugestao.longitude,
            // Marcar que foi corrigido pela IA
            precisao: -1 // Flag especial para indicar correção IA
          }
        });

        // Registrar a correção para aprendizado
        await prisma.correcaoGPS.create({
          data: {
            dispositivo_id: dispositivo.id,
            lat_original: original.latitude,
            lon_original: original.longitude,
            vel_original: original.velocidade || 0,
            lat_corrigido: sugestao.latitude,
            lon_corrigido: sugestao.longitude,
            vel_corrigido: original.velocidade || 0,
            motivo: sugestao.motivo_ajuste || 'micro_ajuste',
            metodo: 'kalman_suave',
            confianca: 0.9,
            distancia_correcao: calcularDistancia(
              original.latitude, original.longitude,
              sugestao.latitude, sugestao.longitude
            ) * 1000,
            status: 'aprovado',
            avaliacao: 5,
            avaliado_em: new Date(),
            timestamp: original.timestamp
          }
        });

        // ✅ NOVO: Salvar no sistema de aprendizado para correção automática futura
        if (gpsAprendizado) {
          await gpsAprendizado.salvarAprendizado(
            dispositivo.id,
            { lat: original.latitude, lon: original.longitude },
            { lat: sugestao.latitude, lon: sugestao.longitude },
            'micro_ajuste'
          );
        }

        ajustesAplicados++;
      }
    }

    // Treinar modelo com feedback positivo
    if (gpsAI) {
      await gpsAI.atualizarModeloIA('dispositivo', String(dispositivo.id), true, 5);
    }

    res.json({
      sucesso: true,
      mensagem: `${ajustesAplicados} ajustes aplicados com sucesso`,
      dados: {
        total_pontos: pontosOriginais.length,
        ajustes_aplicados: ajustesAplicados,
        ajustes_ignorados: pontosSugeridos.filter(p => p.ajuste_sugerido).length - ajustesAplicados
      }
    });

  } catch (error) {
    console.error('[Aplicar Correção IA] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * PRÉVIA de correção com OSRM (snap-to-road) - Compara GPS com estradas reais
 * ✅ Usa OSRM Map Matching para ajustar rota às estradas do mapa
 * GET /api/analise-rota/:imei/preview-snap-road?horas=24
 * GET /api/analise-rota/:imei/preview-snap-road?dataInicio=ISO&dataFim=ISO (para viagens específicas)
 */
router.get('/:imei/preview-snap-road', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { dataInicio, dataFim } = req.query;
    const horas = parseInt(req.query.horas) || 24;

    // Se dataInicio e dataFim forem fornecidos, usar eles (viagem específica)
    // Senão, usar horas como antes
    let whereClause;
    if (dataInicio && dataFim) {
      whereClause = {
        timestamp: {
          gte: new Date(dataInicio),
          lte: new Date(dataFim)
        }
      };
    } else {
      const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);
      whereClause = {
        timestamp: { gte: timestampLimite }
      };
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: whereClause,
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({
        sucesso: true,
        dados: {
          pontos_originais: [],
          pontos_estrada: [],
          estatisticas: null
        }
      });
    }

    // Filtrar pontos válidos
    let pontosOriginaisBrutos = dispositivo.localizacoes.filter(loc => {
      if (!loc.latitude || !loc.longitude) return false;
      if (loc.latitude < -35 || loc.latitude > 5) return false;
      if (loc.longitude < -75 || loc.longitude > -30) return false;
      return true;
    });

    if (pontosOriginaisBrutos.length < 2) {
      return res.json({
        sucesso: true,
        dados: {
          pontos_originais: pontosOriginaisBrutos.map(p => ({ lat: p.latitude, lng: p.longitude, ts: p.timestamp })),
          pontos_estrada: [],
          estatisticas: { total_pontos: pontosOriginaisBrutos.length, erro: 'Poucos pontos para análise' }
        }
      });
    }

    // ✅ USAR A MESMA LÓGICA DO CARD DE GPS
    let pontosOriginais = pontosOriginaisBrutos;
    let pontosEstrada = [];
    let matchInfo = null;

    try {
      // Usar gpsFilterService igual ao card de GPS (com interpolação + OSRM)
      const resultadoCompleto = await gpsFilterService.processarRotaCompleta(pontosOriginaisBrutos, {
        usarKalman: true,
        usarMediaMovel: false,
        usarHampel: true,
        usarInterpolacao: true, // ✅ INTERPOLAR
        usarOSRM: true          // ✅ Colar nas estradas
      });

      const pontosProcessados = resultadoCompleto.pontos || pontosOriginaisBrutos;
      const totalMatched = pontosProcessados.filter(p => p.matched).length;

      // Ambas as rotas usam os mesmos pontos processados
      pontosOriginais = pontosProcessados;
      pontosEstrada = pontosProcessados;
      matchInfo = {
        confianca: `${((totalMatched / Math.max(1, pontosProcessados.length)) * 100).toFixed(1)}%`
      };

      console.log(`[Snap Road] ${pontosOriginaisBrutos.length} brutos → ${pontosOriginais.length} processados (interpolados + OSRM)`);
    } catch (filterError) {
      console.warn('[Snap Road] Erro no gpsFilterService, usando OSRM direto:', filterError.message);
      // Fallback: usar OSRM direto sem interpolação
      try {
        const osrmResult = await snapToRoadOSRMDetalhado(pontosOriginaisBrutos);
        pontosEstrada = osrmResult.pontos;
        pontosOriginais = pontosOriginaisBrutos;
        matchInfo = osrmResult.info;
      } catch (osrmError) {
        console.error('[Snap Road] Erro OSRM:', osrmError.message);
        return res.json({
          sucesso: false,
          erro: 'Erro ao consultar serviço de rotas: ' + osrmError.message
        });
      }
    }

    // Calcular desvios entre rota original e rota nas estradas
    const desvios = calcularDesviosRota(pontosOriginais, pontosEstrada);

    // Estatísticas
    const estatisticas = {
      total_pontos_original: pontosOriginais.length,
      total_pontos_estrada: pontosEstrada.length,
      desvio_medio_metros: desvios.media.toFixed(2),
      desvio_maximo_metros: desvios.maximo.toFixed(2),
      pontos_fora_estrada: desvios.foraEstrada,
      taxa_precisao: ((1 - desvios.foraEstrada / pontosOriginais.length) * 100).toFixed(1) + '%',
      confianca_match: matchInfo?.confianca || 'N/A'
    };

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_horas: horas,
        estatisticas,
        // Rota GPS original
        pontos_originais: pontosOriginais.map(p => ({
          lat: p.latitude,
          lng: p.longitude,
          vel: p.velocidade,
          ts: p.timestamp
        })),
        // Rota ajustada às estradas (snap-to-road)
        pontos_estrada: pontosEstrada.map(p => ({
          lat: p.latitude,
          lng: p.longitude,
          vel: p.velocidade || 0,
          ts: p.timestamp,
          confianca: p.confianca || null
        })),
        // Detalhes dos desvios significativos (> 10m)
        desvios_significativos: desvios.detalhes.filter(d => d.distancia > 10).slice(0, 30)
      }
    });

  } catch (error) {
    console.error('[Preview Snap Road] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * APLICAR correção snap-to-road - Ajusta pontos GPS às estradas reais
 * POST /api/analise-rota/:imei/aplicar-snap-road
 */
router.post('/:imei/aplicar-snap-road', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { horas } = req.body;

    const horasNum = parseInt(horas) || 24;
    const timestampLimite = new Date(Date.now() - horasNum * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    // Buscar localizações
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: timestampLimite }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length < 2) {
      return res.json({ sucesso: false, erro: 'Poucos pontos para ajuste' });
    }

    // Filtrar pontos válidos
    const pontosValidos = localizacoes.filter(loc => {
      if (!loc.latitude || !loc.longitude) return false;
      if (loc.latitude < -35 || loc.latitude > 5) return false;
      if (loc.longitude < -75 || loc.longitude > -30) return false;
      return true;
    });

    // Chamar OSRM para snap-to-road
    let pontosEstrada;
    try {
      const osrmResult = await snapToRoadOSRMDetalhado(pontosValidos);
      pontosEstrada = osrmResult.pontos;
    } catch (osrmError) {
      return res.json({ sucesso: false, erro: 'Erro OSRM: ' + osrmError.message });
    }

    // Aplicar correções no banco de dados
    let ajustesAplicados = 0;
    const MAX_AJUSTE_METROS = 50; // Máximo de 50m de ajuste para snap-to-road

    for (let i = 0; i < pontosValidos.length && i < pontosEstrada.length; i++) {
      const original = pontosValidos[i];
      const estrada = pontosEstrada[i];

      if (!estrada || !estrada.latitude || !estrada.longitude) continue;

      const distancia = calcularDistancia(
        original.latitude, original.longitude,
        estrada.latitude, estrada.longitude
      ) * 1000;

      // Só ajustar se desvio for significativo mas não absurdo
      if (distancia > 5 && distancia <= MAX_AJUSTE_METROS) {
        await prisma.localizacao.update({
          where: { id: original.id },
          data: {
            latitude: estrada.latitude,
            longitude: estrada.longitude,
            precisao: -2 // Flag especial: correção snap-to-road
          }
        });

        // Registrar correção
        await prisma.correcaoGPS.create({
          data: {
            dispositivo_id: dispositivo.id,
            lat_original: original.latitude,
            lon_original: original.longitude,
            vel_original: original.velocidade || 0,
            lat_corrigido: estrada.latitude,
            lon_corrigido: estrada.longitude,
            vel_corrigido: original.velocidade || 0,
            motivo: 'snap_to_road',
            metodo: 'osrm_match',
            confianca: 0.95,
            distancia_correcao: distancia,
            status: 'aprovado',
            avaliacao: 5,
            avaliado_em: new Date(),
            timestamp: original.timestamp
          }
        });

        // ✅ NOVO: Salvar no sistema de aprendizado para correção automática futura
        if (gpsAprendizado) {
          await gpsAprendizado.salvarAprendizado(
            dispositivo.id,
            { lat: original.latitude, lon: original.longitude },
            { lat: estrada.latitude, lon: estrada.longitude },
            'snap_to_road'
          );
        }

        ajustesAplicados++;
      }
    }

    // Obter estatísticas de aprendizado
    let statsAprendizado = null;
    if (gpsAprendizado) {
      statsAprendizado = await gpsAprendizado.obterEstatisticas(dispositivo.id);
    }

    res.json({
      sucesso: true,
      mensagem: `${ajustesAplicados} pontos ajustados às estradas reais`,
      aprendizado: statsAprendizado,
      dados: {
        total_pontos: pontosValidos.length,
        ajustes_aplicados: ajustesAplicados
      }
    });

  } catch (error) {
    console.error('[Aplicar Snap Road] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * Snap-to-road usando OSRM Match API com detalhes
 * Retorna pontos ajustados às estradas reais
 */
async function snapToRoadOSRMDetalhado(localizacoes) {
  const OSRM_HOST = process.env.OSRM_HOST || 'osrm-sul-brasil';
  const OSRM_URL = `http://${OSRM_HOST}:5000/match/v1/driving`;  // OSRM Docker
  const MAX_COORDS_PER_REQUEST = 100;
  const MAX_GAP_SEGUNDOS = 300; // 5 minutos - gap máximo entre pontos
  const MAX_DISTANCIA_METROS = 2000; // 2km - distância máxima entre pontos consecutivos

  if (localizacoes.length < 2) {
    return { pontos: localizacoes, info: { confianca: 0 } };
  }

  const todosOsPontos = [];
  let confiancaTotal = 0;
  let matchCount = 0;

  // ✅ NOVO: Segmentar rota por gaps de tempo/distância
  // Isso evita que o OSRM crie linhas impossíveis entre pontos muito distantes
  const segmentos = segmentarRotaPorGaps(localizacoes, MAX_GAP_SEGUNDOS, MAX_DISTANCIA_METROS);
  console.log(`[Snap-to-Road] Rota dividida em ${segmentos.length} segmento(s) baseado em gaps`);

  // Processar cada segmento separadamente
  for (const segmento of segmentos) {
    if (segmento.length < 2) {
      // Segmento muito pequeno, manter pontos originais
      todosOsPontos.push(...segmento.map(p => ({
        ...p,
        latitude: p.latitude,
        longitude: p.longitude,
        matched: false,
        motivo: 'segmento_pequeno'
      })));
      continue;
    }

    // Dividir segmento em chunks para OSRM
    const chunks = [];
    for (let i = 0; i < segmento.length; i += MAX_COORDS_PER_REQUEST) {
      chunks.push(segmento.slice(i, Math.min(i + MAX_COORDS_PER_REQUEST, segmento.length)));
    }

    for (const chunk of chunks) {
      try {
        const resultado = await processarChunkOSRM(chunk, OSRM_URL);
        todosOsPontos.push(...resultado.pontos);
        confiancaTotal += resultado.confianca;
        matchCount++;
      } catch (e) {
        console.warn(`[Snap-to-Road] Erro no chunk: ${e.message}`);
        // Manter pontos originais em caso de erro
        todosOsPontos.push(...chunk.map(p => ({
          ...p,
          latitude: p.latitude,
          longitude: p.longitude,
          matched: false,
          motivo: 'erro_osrm'
        })));
      }
    }
  }

  return {
    pontos: todosOsPontos,
    info: {
      confianca: matchCount > 0 ? (confiancaTotal / matchCount).toFixed(1) + '%' : '0%',
      segmentos: segmentos.length,
      total_processados: todosOsPontos.length
    }
  };
}

/**
 * Segmenta a rota em partes quando há gaps grandes de tempo ou distância
 * Isso evita que o OSRM crie rotas impossíveis
 */
function segmentarRotaPorGaps(localizacoes, maxGapSegundos, maxDistanciaMetros) {
  const segmentos = [];
  let segmentoAtual = [];

  for (let i = 0; i < localizacoes.length; i++) {
    const ponto = localizacoes[i];

    if (segmentoAtual.length === 0) {
      segmentoAtual.push(ponto);
      continue;
    }

    const pontoAnterior = segmentoAtual[segmentoAtual.length - 1];

    // Calcular gap de tempo
    const tempoAnterior = new Date(pontoAnterior.timestamp).getTime();
    const tempoAtual = new Date(ponto.timestamp).getTime();
    const gapSegundos = (tempoAtual - tempoAnterior) / 1000;

    // Calcular distância
    const distancia = calcularDistancia(
      pontoAnterior.latitude, pontoAnterior.longitude,
      ponto.latitude, ponto.longitude
    ) * 1000; // em metros

    // Verificar se deve criar novo segmento
    const gapMuitoGrande = gapSegundos > maxGapSegundos;
    const distanciaMuitoGrande = distancia > maxDistanciaMetros;

    if (gapMuitoGrande || distanciaMuitoGrande) {
      // Salvar segmento atual e começar novo
      if (segmentoAtual.length > 0) {
        segmentos.push(segmentoAtual);
      }
      segmentoAtual = [ponto];

      if (gapMuitoGrande) {
        console.log(`[Segmentar] Gap de ${Math.round(gapSegundos/60)}min detectado, novo segmento`);
      }
      if (distanciaMuitoGrande) {
        console.log(`[Segmentar] Salto de ${Math.round(distancia)}m detectado, novo segmento`);
      }
    } else {
      segmentoAtual.push(ponto);
    }
  }

  // Adicionar último segmento
  if (segmentoAtual.length > 0) {
    segmentos.push(segmentoAtual);
  }

  return segmentos;
}

/**
 * Processa um chunk de pontos com OSRM
 */
async function processarChunkOSRM(chunk, OSRM_URL) {
  const pontos = [];
  let confianca = 0;

  // Montar coordenadas (lon,lat;lon,lat;...)
  const coordsString = chunk
    .map(l => `${l.longitude},${l.latitude}`)
    .join(';');

  // Timestamps em segundos Unix
  const timestamps = chunk
    .map(l => Math.floor(new Date(l.timestamp).getTime() / 1000))
    .join(';');

  // Radiuses - tolerância em metros para cada ponto
  const radiuses = chunk.map(() => '25').join(';');

  const url = `${OSRM_URL}/${coordsString}?timestamps=${timestamps}&radiuses=${radiuses}&geometries=geojson&overview=full&annotations=true&gaps=ignore`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    timeout: 30000
  });

  if (!response.ok) {
    throw new Error(`OSRM retornou ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== 'Ok') {
    // Tentar sem timestamps se falhar
    const urlSimples = `${OSRM_URL}/${coordsString}?radiuses=${radiuses}&geometries=geojson&overview=full`;
    const response2 = await fetch(urlSimples);
    const data2 = await response2.json();

    if (data2.code !== 'Ok' || !data2.matchings?.length) {
      throw new Error(`OSRM match falhou: ${data2.code || 'sem matchings'}`);
    }

    // Usar resultado simplificado - mapear para pontos originais
    for (let i = 0; i < chunk.length; i++) {
      const pontoOriginal = chunk[i];
      // Manter ponto original se não houver match
      pontos.push({
        latitude: pontoOriginal.latitude,
        longitude: pontoOriginal.longitude,
        velocidade: pontoOriginal.velocidade,
        timestamp: pontoOriginal.timestamp,
        confianca: 0.3,
        matched: false
      });
    }

    return { pontos, confianca: 30 };
  }

  // Processar matchings com tracepoints para mapeamento preciso
  // Limite máximo de ajuste - evita criar trajetórias "retas" irreais
  const MAX_DISTANCIA_AJUSTE_METROS = 15;

  if (data.tracepoints) {
    for (let i = 0; i < data.tracepoints.length; i++) {
      const tp = data.tracepoints[i];
      const pontoOriginal = chunk[i];

      if (tp && tp.location) {
        // Calcular distância do ajuste
        const distAjuste = calcularDistancia(
          pontoOriginal.latitude, pontoOriginal.longitude,
          tp.location[1], tp.location[0]
        ) * 1000; // metros

        // Verificar se o ajuste está dentro do limite permitido
        if (distAjuste <= MAX_DISTANCIA_AJUSTE_METROS) {
          // Ajuste válido - usar coordenadas do OSRM
          pontos.push({
            latitude: tp.location[1],
            longitude: tp.location[0],
            velocidade: pontoOriginal.velocidade,
            timestamp: pontoOriginal.timestamp,
            confianca: 0.9,
            matched: true,
            distancia_ajuste: distAjuste
          });
          confianca += 90;
        } else {
          // Ajuste muito grande (> 20m) - manter original para evitar trajetória estranha
          pontos.push({
            latitude: pontoOriginal.latitude,
            longitude: pontoOriginal.longitude,
            velocidade: pontoOriginal.velocidade,
            timestamp: pontoOriginal.timestamp,
            confianca: 0.5,
            matched: false,
            motivo: `ajuste_${distAjuste.toFixed(0)}m_excede_limite`
          });
          confianca += 50;
        }
      } else {
        // Ponto não foi matched - manter original
        pontos.push({
          latitude: pontoOriginal.latitude,
          longitude: pontoOriginal.longitude,
          velocidade: pontoOriginal.velocidade,
          timestamp: pontoOriginal.timestamp,
          confianca: 0.3,
          matched: false
        });
        confianca += 30;
      }
    }
  }

  // Calcular confiança média
  const confiancaMedia = pontos.length > 0 ? confianca / pontos.length : 0;

  return { pontos, confianca: confiancaMedia };
}

/**
 * Calcula desvios entre rota original e rota snap-to-road
 */
function calcularDesviosRota(pontosOriginais, pontosEstrada) {
  const detalhes = [];
  let somaDesvios = 0;
  let maxDesvio = 0;
  let foraEstrada = 0;

  const minLength = Math.min(pontosOriginais.length, pontosEstrada.length);

  for (let i = 0; i < minLength; i++) {
    const orig = pontosOriginais[i];
    const estrada = pontosEstrada[i];

    if (!estrada || !estrada.latitude) continue;

    const distancia = calcularDistancia(
      orig.latitude, orig.longitude,
      estrada.latitude, estrada.longitude
    ) * 1000; // metros

    somaDesvios += distancia;
    if (distancia > maxDesvio) maxDesvio = distancia;
    if (distancia > 15) foraEstrada++; // Considerar "fora da estrada" se > 15m

    detalhes.push({
      indice: i,
      timestamp: orig.timestamp,
      original: { lat: orig.latitude, lng: orig.longitude },
      estrada: { lat: estrada.latitude, lng: estrada.longitude },
      distancia: distancia
    });
  }

  return {
    media: minLength > 0 ? somaDesvios / minLength : 0,
    maximo: maxDesvio,
    foraEstrada,
    detalhes
  };
}

/**
 * Gera micro-ajustes suaves para os pontos GPS
 * ✅ ATUALIZADO: Usa OSRM Snap-to-Road para encaixar nas estradas reais
 * Baseado nos pontos GPS reais captados pelo rastreador
 */
async function gerarSugestoesMicroAjustes(pontos, dispositivoId = null) {
  if (!pontos || pontos.length === 0) return [];

  // Distância máxima permitida para ajuste snap-to-road
  // Ajustes > 15m criam trajetórias estranhas/retas demais
  const MAX_DISTANCIA_SNAP_METROS = 15;

  // ✅ USAR OSRM SNAP-TO-ROAD (baseado nos pontos GPS reais)
  try {
    console.log(`[Análise Rota] Processando ${pontos.length} pontos com OSRM snap-to-road (max ${MAX_DISTANCIA_SNAP_METROS}m)`);
    const resultado = await snapToRoadOSRMDetalhado(pontos);

    // Formatar resultado para compatibilidade com código existente
    const pontosFormatados = [];
    let ajustesAplicados = 0;
    let ajustesIgnorados = 0;

    for (let i = 0; i < pontos.length; i++) {
      const p = resultado.pontos[i];
      const original = pontos[i];
      if (p && original) {
        const foiMatchedOSRM = p.matched === true;
        const distAjuste = foiMatchedOSRM ? calcularDistancia(
          original.latitude, original.longitude,
          p.latitude, p.longitude
        ) * 1000 : 0;

        // Verificar se o ajuste está dentro do limite permitido
        const ajusteDentroDoLimite = distAjuste <= MAX_DISTANCIA_SNAP_METROS;
        const deveAjustar = foiMatchedOSRM && ajusteDentroDoLimite && distAjuste > 2; // Mínimo de 2m para ajustar

        if (deveAjustar) {
          ajustesAplicados++;
          pontosFormatados.push({
            ...original,
            latitude: p.latitude,
            longitude: p.longitude,
            ajuste_sugerido: true,
            motivo_ajuste: 'snap_to_road',
            lat_original: original.latitude,
            lon_original: original.longitude,
            distancia_ajuste: distAjuste,
            confianca: p.confianca || 0.9,
            nome_rua: p.nome_rua || null
          });
        } else {
          // Ajuste muito grande ou muito pequeno - manter original
          if (foiMatchedOSRM && !ajusteDentroDoLimite) {
            ajustesIgnorados++;
          }
          pontosFormatados.push({
            ...original,
            ajuste_sugerido: false,
            motivo_nao_ajuste: distAjuste > MAX_DISTANCIA_SNAP_METROS ? `distancia_${distAjuste.toFixed(0)}m_excede_limite` : null
          });
        }
      } else if (original) {
        pontosFormatados.push({
          ...original,
          ajuste_sugerido: false
        });
      }
    }
    console.log(`[Análise Rota] OSRM: ${ajustesAplicados}/${pontos.length} ajustes aplicados (${ajustesIgnorados} ignorados por exceder ${MAX_DISTANCIA_SNAP_METROS}m)`);
    return pontosFormatados;
  } catch (e) {
    console.warn('[Análise Rota] Erro no OSRM, usando fallback Kalman:', e.message);
  }

  // FALLBACK: Código original
  const resultado = [];
  const MAX_AJUSTE_METROS = 15; // Máximo de 15 metros de ajuste

  // Filtro de Kalman simplificado para suavização
  let kalmanState = null;
  const processNoise = 0.000001; // Muito baixo para ajustes suaves
  const measurementNoise = 0.00005;

  for (let i = 0; i < pontos.length; i++) {
    const ponto = pontos[i];
    const pontoAnterior = i > 0 ? pontos[i - 1] : null;
    const pontoPosterior = i < pontos.length - 1 ? pontos[i + 1] : null;

    // Inicializar Kalman
    if (!kalmanState) {
      kalmanState = {
        lat: ponto.latitude,
        lon: ponto.longitude,
        covLat: 1,
        covLon: 1
      };
      resultado.push({
        ...ponto,
        ajuste_sugerido: false
      });
      continue;
    }

    // Calcular predição
    const dt = pontoAnterior ?
      (new Date(ponto.timestamp) - new Date(pontoAnterior.timestamp)) / 1000 : 1;

    // Atualizar covariância
    kalmanState.covLat += processNoise;
    kalmanState.covLon += processNoise;

    // Ganho de Kalman
    const kLat = kalmanState.covLat / (kalmanState.covLat + measurementNoise);
    const kLon = kalmanState.covLon / (kalmanState.covLon + measurementNoise);

    // Calcular nova posição suavizada
    const latSuavizado = kalmanState.lat + kLat * (ponto.latitude - kalmanState.lat);
    const lonSuavizado = kalmanState.lon + kLon * (ponto.longitude - kalmanState.lon);

    // Calcular distância do ajuste
    const distAjuste = calcularDistancia(ponto.latitude, ponto.longitude, latSuavizado, lonSuavizado) * 1000;

    // Atualizar estado
    kalmanState.lat = latSuavizado;
    kalmanState.lon = lonSuavizado;
    kalmanState.covLat *= (1 - kLat);
    kalmanState.covLon *= (1 - kLon);

    // Verificar se o ajuste é significativo mas não excessivo
    const ajusteSignificativo = distAjuste > 2 && distAjuste <= MAX_AJUSTE_METROS;

    // Se o ajuste é muito grande, limitar ou ignorar
    let latFinal = ponto.latitude;
    let lonFinal = ponto.longitude;
    let motivo = null;

    if (ajusteSignificativo) {
      // Aplicar ajuste suave
      latFinal = latSuavizado;
      lonFinal = lonSuavizado;
      motivo = 'suavizacao_kalman';
    } else if (distAjuste > MAX_AJUSTE_METROS) {
      // Ajuste muito grande - verificar com contexto
      if (pontoPosterior) {
        // Interpolar suavemente entre anterior e posterior
        const fator = 0.5;
        const latInterp = pontoAnterior.latitude + fator * (pontoPosterior.latitude - pontoAnterior.latitude);
        const lonInterp = pontoAnterior.longitude + fator * (pontoPosterior.longitude - pontoAnterior.longitude);

        const distInterp = calcularDistancia(ponto.latitude, ponto.longitude, latInterp, lonInterp) * 1000;

        if (distInterp <= MAX_AJUSTE_METROS) {
          latFinal = latInterp;
          lonFinal = lonInterp;
          motivo = 'interpolacao_suave';
        }
        // Se interpolação também é muito grande, manter original
      }
    }

    resultado.push({
      ...ponto,
      latitude: latFinal,
      longitude: lonFinal,
      ajuste_sugerido: latFinal !== ponto.latitude || lonFinal !== ponto.longitude,
      motivo_ajuste: motivo,
      lat_original: ponto.latitude,
      lon_original: ponto.longitude,
      distancia_ajuste: latFinal !== ponto.latitude ?
        calcularDistancia(ponto.latitude, ponto.longitude, latFinal, lonFinal) * 1000 : 0
    });
  }

  return resultado;
}

/**
 * Retorna rota com interpolação PRECISA baseada em direção (bearing)
 * Usa curvas de Bezier para criar trajetórias realistas entre pontos GPS
 * GET /api/analise-rota/:imei/rota-precisa?horas=24
 */
router.get('/:imei/rota-precisa', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({ sucesso: true, dados: { pontos: [], pontos_originais: [] } });
    }

    // Filtrar pontos válidos
    let localizacoes = dispositivo.localizacoes.filter(loc => {
      if (!loc.latitude || !loc.longitude) return false;
      if (loc.latitude < -35 || loc.latitude > 5) return false;
      if (loc.longitude < -75 || loc.longitude > -30) return false;
      return true;
    });

    // Remover saltos impossíveis
    localizacoes = filtrarSaltosImpossveis(localizacoes);

    if (localizacoes.length < 2) {
      return res.json({
        sucesso: true,
        dados: {
          pontos: localizacoes.map(l => ({
            latitude: l.latitude,
            longitude: l.longitude,
            velocidade: l.velocidade,
            direcao: l.direcao,
            timestamp: l.timestamp,
            original: true
          })),
          pontos_originais: localizacoes.length
        }
      });
    }

    // Interpolar usando direção (bearing) e curvas de Bezier
    const pontosInterpolados = interpolarComBearing(localizacoes);

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        total_pontos: pontosInterpolados.length,
        pontos_originais: localizacoes.length,
        periodo_horas: horas,
        metodo: 'bearing_bezier',
        pontos: pontosInterpolados
      }
    });

  } catch (error) {
    console.error('[Rota Precisa] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * Interpola pontos GPS usando direção (bearing) e curvas de Bezier
 * Cria trajetórias realistas baseadas na direção do veículo
 */
function interpolarComBearing(localizacoes) {
  if (localizacoes.length < 2) {
    return localizacoes.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade,
      direcao: l.direcao,
      timestamp: l.timestamp,
      original: true
    }));
  }

  const resultado = [];
  const GAP_MAXIMO_SEGUNDOS = 120; // 2 minutos - não interpolar gaps grandes

  for (let i = 0; i < localizacoes.length - 1; i++) {
    const p1 = localizacoes[i];
    const p2 = localizacoes[i + 1];

    // Adicionar ponto original
    resultado.push({
      latitude: p1.latitude,
      longitude: p1.longitude,
      velocidade: p1.velocidade,
      direcao: p1.direcao,
      timestamp: p1.timestamp,
      original: true
    });

    // Calcular gap de tempo
    const tempoSegundos = (new Date(p2.timestamp) - new Date(p1.timestamp)) / 1000;

    // Não interpolar se gap muito grande (perda de sinal)
    if (tempoSegundos > GAP_MAXIMO_SEGUNDOS) {
      continue;
    }

    // Calcular distância entre pontos
    const distanciaMetros = calcularDistancia(p1.latitude, p1.longitude, p2.latitude, p2.longitude) * 1000;

    // Se distância < 20m, não precisa interpolar
    if (distanciaMetros < 20) {
      continue;
    }

    // Velocidade média do segmento (km/h -> m/s)
    const velMedia = ((p1.velocidade || 0) + (p2.velocidade || 0)) / 2;
    const velMs = velMedia / 3.6;

    // Se parado, não interpolar
    if (velMs < 1) {
      continue;
    }

    // Calcular quantos pontos intermediários (1 ponto a cada ~15 metros)
    const numPontos = Math.min(Math.ceil(distanciaMetros / 15), 20);

    if (numPontos < 2) {
      continue;
    }

    // Direções (em radianos)
    const dir1 = (p1.direcao || 0) * Math.PI / 180;
    const dir2 = (p2.direcao || 0) * Math.PI / 180;

    // Calcular pontos de controle para curva de Bezier
    // baseado na direção do veículo em cada ponto
    const controlDist = distanciaMetros / 3; // 1/3 da distância

    // Ponto de controle 1: na direção de p1
    const ctrl1 = calcularPontoNaDirecao(p1.latitude, p1.longitude, dir1, controlDist);

    // Ponto de controle 2: oposto à direção de p2
    const ctrl2 = calcularPontoNaDirecao(p2.latitude, p2.longitude, dir2 + Math.PI, controlDist);

    // Gerar pontos na curva de Bezier cúbica
    for (let j = 1; j < numPontos; j++) {
      const t = j / numPontos;

      // Bezier cúbica: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
      const lat = bezierCubica(p1.latitude, ctrl1.lat, ctrl2.lat, p2.latitude, t);
      const lon = bezierCubica(p1.longitude, ctrl1.lon, ctrl2.lon, p2.longitude, t);

      // Interpolar velocidade e direção
      const vel = Math.round(p1.velocidade + (p2.velocidade - p1.velocidade) * t);
      const dir = interpolarAngulo(p1.direcao || 0, p2.direcao || 0, t);

      // Interpolar timestamp
      const ts1 = new Date(p1.timestamp).getTime();
      const ts2 = new Date(p2.timestamp).getTime();
      const timestamp = new Date(ts1 + (ts2 - ts1) * t);

      resultado.push({
        latitude: lat,
        longitude: lon,
        velocidade: vel,
        direcao: Math.round(dir),
        timestamp: timestamp,
        original: false,
        interpolado: true
      });
    }
  }

  // Adicionar último ponto
  const ultimo = localizacoes[localizacoes.length - 1];
  resultado.push({
    latitude: ultimo.latitude,
    longitude: ultimo.longitude,
    velocidade: ultimo.velocidade,
    direcao: ultimo.direcao,
    timestamp: ultimo.timestamp,
    original: true
  });

  return resultado;
}

/**
 * Calcula um ponto a uma distância na direção especificada
 */
function calcularPontoNaDirecao(lat, lon, direcaoRad, distanciaMetros) {
  const R = 6371000; // Raio da Terra em metros
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;

  const novaLatRad = Math.asin(
    Math.sin(latRad) * Math.cos(distanciaMetros / R) +
    Math.cos(latRad) * Math.sin(distanciaMetros / R) * Math.cos(direcaoRad)
  );

  const novaLonRad = lonRad + Math.atan2(
    Math.sin(direcaoRad) * Math.sin(distanciaMetros / R) * Math.cos(latRad),
    Math.cos(distanciaMetros / R) - Math.sin(latRad) * Math.sin(novaLatRad)
  );

  return {
    lat: novaLatRad * 180 / Math.PI,
    lon: novaLonRad * 180 / Math.PI
  };
}

/**
 * Curva de Bezier cúbica
 */
function bezierCubica(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return mt * mt * mt * p0 +
         3 * mt * mt * t * p1 +
         3 * mt * t * t * p2 +
         t * t * t * p3;
}

/**
 * Interpola ângulos corretamente (considerando 0°/360°)
 */
function interpolarAngulo(a1, a2, t) {
  // Normalizar para 0-360
  a1 = ((a1 % 360) + 360) % 360;
  a2 = ((a2 % 360) + 360) % 360;

  // Calcular diferença menor
  let diff = a2 - a1;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;

  let resultado = a1 + diff * t;
  return ((resultado % 360) + 360) % 360;
}

/**
 * Usa OSRM (Open Source Routing Machine) para snap-to-road
 * Serviço gratuito que ajusta coordenadas GPS para seguir estradas reais
 * Limite: 100 coordenadas por requisição
 */
async function snapToRoadOSRM(localizacoes) {
  const OSRM_HOST = process.env.OSRM_HOST || 'osrm-sul-brasil';
  const OSRM_URL = `http://${OSRM_HOST}:5000/match/v1/driving`;  // OSRM Docker
  const MAX_COORDS_PER_REQUEST = 100;

  // Dividir em chunks se necessário
  const chunks = [];
  for (let i = 0; i < localizacoes.length; i += MAX_COORDS_PER_REQUEST) {
    chunks.push(localizacoes.slice(i, i + MAX_COORDS_PER_REQUEST));
  }

  let todosOsPontos = [];

  for (const chunk of chunks) {
    // Montar string de coordenadas (lon,lat;lon,lat;...)
    const coordsString = chunk
      .map(l => `${l.longitude},${l.latitude}`)
      .join(';');

    // Montar timestamps (em segundos Unix)
    const timestamps = chunk
      .map(l => Math.floor(new Date(l.timestamp).getTime() / 1000))
      .join(';');

    // Chamar API OSRM Match
    const url = `${OSRM_URL}/${coordsString}?timestamps=${timestamps}&geometries=geojson&overview=full&annotations=true`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 30000
    });

    if (!response.ok) {
      throw new Error(`OSRM retornou ${response.status}`);
    }

    const data = await response.json();

    if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) {
      throw new Error(`OSRM match falhou: ${data.code || 'sem matchings'}`);
    }

    // Extrair pontos da geometria retornada
    for (const matching of data.matchings) {
      if (matching.geometry && matching.geometry.coordinates) {
        const coords = matching.geometry.coordinates;

        for (let i = 0; i < coords.length; i++) {
          const [lon, lat] = coords[i];

          // Interpolar timestamp e velocidade
          const progress = i / Math.max(1, coords.length - 1);
          const startIdx = 0;
          const endIdx = chunk.length - 1;
          const interpolatedIdx = Math.floor(startIdx + progress * (endIdx - startIdx));
          const originalPoint = chunk[Math.min(interpolatedIdx, chunk.length - 1)];

          todosOsPontos.push({
            latitude: lat,
            longitude: lon,
            velocidade: originalPoint.velocidade,
            timestamp: originalPoint.timestamp,
            snapped: true
          });
        }
      }
    }
  }

  // Remover pontos duplicados muito próximos
  return removerPontosRedundantes(todosOsPontos, 3);
}

/**
 * Filtra saltos impossíveis entre pontos GPS
 * Remove pontos que indicam teletransporte (velocidade impossível)
 */
function filtrarSaltosImpossveis(localizacoes) {
  if (localizacoes.length < 2) return localizacoes;

  const resultado = [localizacoes[0]];
  const VELOCIDADE_MAXIMA_KMH = 180; // Velocidade máxima plausível

  for (let i = 1; i < localizacoes.length; i++) {
    const anterior = resultado[resultado.length - 1];
    const atual = localizacoes[i];

    const distanciaKm = calcularDistancia(
      anterior.latitude, anterior.longitude,
      atual.latitude, atual.longitude
    );

    const tempoHoras = (new Date(atual.timestamp) - new Date(anterior.timestamp)) / (1000 * 60 * 60);

    // Calcular velocidade necessária para o salto
    if (tempoHoras > 0) {
      const velocidadeNecessaria = distanciaKm / tempoHoras;

      // Se velocidade necessária for plausível, aceitar ponto
      if (velocidadeNecessaria <= VELOCIDADE_MAXIMA_KMH) {
        resultado.push(atual);
      } else {
        console.log(`[Filtro GPS] Removendo ponto com salto impossível: ${velocidadeNecessaria.toFixed(0)} km/h`);
      }
    } else {
      resultado.push(atual);
    }
  }

  return resultado;
}

/**
 * Processa pontos GPS com filtros inteligentes e suavização
 * Técnicas: Filtro de Kalman simplificado + interpolação Catmull-Rom
 */
function processarRotaInteligente(localizacoes) {
  if (localizacoes.length < 2) {
    return localizacoes.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade,
      timestamp: l.timestamp
    }));
  }

  // 1. Aplicar filtro de média móvel para suavizar ruído GPS
  const pontosSuavizados = aplicarMediaMovel(localizacoes, 3);

  // 2. Remover pontos redundantes (muito próximos)
  const pontosOtimizados = removerPontosRedundantes(pontosSuavizados, 5); // 5 metros

  // 3. Aplicar interpolação Catmull-Rom para curvas suaves
  const pontosInterpolados = interpolarCatmullRom(pontosOtimizados);

  console.log(`[Rota] Processados ${localizacoes.length} -> ${pontosInterpolados.length} pontos (suavização + interpolação)`);

  return pontosInterpolados;
}

/**
 * Filtro de média móvel para suavizar ruído GPS
 */
function aplicarMediaMovel(pontos, janela = 3) {
  if (pontos.length <= janela) return pontos;

  const resultado = [];
  const halfWindow = Math.floor(janela / 2);

  for (let i = 0; i < pontos.length; i++) {
    let sumLat = 0, sumLon = 0, count = 0;

    // Janela de média
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(pontos.length - 1, i + halfWindow); j++) {
      sumLat += pontos[j].latitude;
      sumLon += pontos[j].longitude;
      count++;
    }

    resultado.push({
      latitude: sumLat / count,
      longitude: sumLon / count,
      velocidade: pontos[i].velocidade,
      timestamp: pontos[i].timestamp
    });
  }

  return resultado;
}

/**
 * Remove pontos muito próximos (redundantes)
 */
function removerPontosRedundantes(pontos, distanciaMinMetros = 5) {
  if (pontos.length < 2) return pontos;

  const resultado = [pontos[0]];

  for (let i = 1; i < pontos.length; i++) {
    const ultimo = resultado[resultado.length - 1];
    const atual = pontos[i];

    const distancia = calcularDistancia(
      ultimo.latitude, ultimo.longitude,
      atual.latitude, atual.longitude
    ) * 1000; // km para metros

    // Manter ponto se distância > mínima OU se for o último ponto
    if (distancia >= distanciaMinMetros || i === pontos.length - 1) {
      resultado.push(atual);
    }
  }

  return resultado;
}

/**
 * Interpolação Catmull-Rom para curvas suaves
 * Gera pontos intermediários que seguem uma curva natural
 */
function interpolarCatmullRom(pontos) {
  if (pontos.length < 4) {
    // Poucos pontos, retornar sem interpolação
    return pontos;
  }

  const resultado = [];
  const PONTOS_POR_SEGMENTO = 5; // Pontos intermediários

  for (let i = 0; i < pontos.length - 1; i++) {
    // Pontos de controle (p0, p1, p2, p3)
    const p0 = pontos[Math.max(0, i - 1)];
    const p1 = pontos[i];
    const p2 = pontos[Math.min(pontos.length - 1, i + 1)];
    const p3 = pontos[Math.min(pontos.length - 1, i + 2)];

    // Adicionar ponto inicial do segmento
    resultado.push({
      latitude: p1.latitude,
      longitude: p1.longitude,
      velocidade: p1.velocidade,
      timestamp: p1.timestamp
    });

    // Calcular distância do segmento
    const distancia = calcularDistancia(p1.latitude, p1.longitude, p2.latitude, p2.longitude) * 1000;

    // Só interpolar se distância for significativa (> 20 metros)
    if (distancia > 20 && distancia < 500) {
      // Interpolar pontos intermediários
      const numPontos = Math.min(PONTOS_POR_SEGMENTO, Math.ceil(distancia / 30));

      for (let j = 1; j < numPontos; j++) {
        const t = j / numPontos;

        // Fórmula Catmull-Rom
        const lat = catmullRom(p0.latitude, p1.latitude, p2.latitude, p3.latitude, t);
        const lon = catmullRom(p0.longitude, p1.longitude, p2.longitude, p3.longitude, t);

        // Interpolar timestamp
        const t1 = new Date(p1.timestamp).getTime();
        const t2 = new Date(p2.timestamp).getTime();
        const timestamp = new Date(t1 + (t2 - t1) * t);

        // Interpolar velocidade
        const vel = Math.round(p1.velocidade + (p2.velocidade - p1.velocidade) * t);

        resultado.push({
          latitude: lat,
          longitude: lon,
          velocidade: vel,
          timestamp: timestamp,
          interpolado: true
        });
      }
    }
  }

  // Adicionar último ponto
  const ultimo = pontos[pontos.length - 1];
  resultado.push({
    latitude: ultimo.latitude,
    longitude: ultimo.longitude,
    velocidade: ultimo.velocidade,
    timestamp: ultimo.timestamp
  });

  return resultado;
}

/**
 * Função Catmull-Rom para um valor
 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;

  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

// ==================== ROTA OTIMIZADA COM PIPELINE COMPLETO ====================

/**
 * Retorna rota OTIMIZADA com pipeline completo de processamento GPS
 *
 * Pipeline:
 * 1. Validação e rejeição de pontos ruins (HDOP, velocidade impossível)
 * 2. Remoção de saltos impossíveis
 * 3. Filtro Hampel para outliers isolados
 * 4. Média móvel para suavização inicial
 * 5. Filtro de Kalman (2D constante-velocidade)
 * 6. Interpolação com heading/Bezier
 * 7. Map-matching OSRM (opcional)
 *
 * GET /api/analise-rota/:imei/rota-otimizada?horas=24&kalman=true&osrm=false
 */
router.get('/:imei/rota-otimizada', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    // Opções do pipeline
    const opcoes = {
      usarKalman: req.query.kalman !== 'false',
      usarMediaMovel: req.query.mediaMovel !== 'false',
      usarHampel: req.query.hampel !== 'false',
      usarInterpolacao: req.query.interpolacao !== 'false',
      usarOSRM: req.query.osrm === 'true', // Desabilitado por padrão
    };

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: {
            timestamp: { gte: timestampLimite }
          },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({
        sucesso: true,
        dados: {
          pontos: [],
          stats: { original: 0, final: 0 }
        }
      });
    }

    // Preparar pontos para o pipeline
    const pontosInput = dispositivo.localizacoes.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade || 0,
      direcao: l.direcao || 0,
      timestamp: l.timestamp,
      hdop: l.precisao || null, // Usar precisão como proxy para HDOP
      ignicao: l.ignicao
    }));

    // Executar pipeline completo
    const resultado = await gpsFilterService.processarRotaCompleta(pontosInput, opcoes);

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_horas: horas,
        pipeline: {
          kalman: opcoes.usarKalman,
          mediaMovel: opcoes.usarMediaMovel,
          hampel: opcoes.usarHampel,
          interpolacao: opcoes.usarInterpolacao,
          osrm: opcoes.usarOSRM
        },
        stats: resultado.stats,
        total_pontos: resultado.pontos.length,
        pontos_originais: resultado.stats.original,
        pontos: resultado.pontos
      }
    });

  } catch (error) {
    console.error('[Rota Otimizada] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * Retorna configuração atual do filtro GPS
 * GET /api/analise-rota/config/filtro-gps
 */
router.get('/config/filtro-gps', (req, res) => {
  res.json({
    sucesso: true,
    config: gpsFilterService.CONFIG,
    descricao: {
      kalman: {
        processNoise: 'Q - ruído do processo (menor = mais suave)',
        measurementNoise: 'R - ruído da medição em m² (GPS ~5m -> 25)',
        initialCovariance: 'P inicial'
      },
      validation: {
        maxHDOP: 'Rejeitar pontos com HDOP acima deste valor',
        maxSpeedKmh: 'Velocidade máxima plausível',
        minSpeedForInterp: 'Velocidade mínima para interpolar',
        maxGapSeconds: 'Gap máximo para interpolar (evita linhas retas em perdas de sinal)'
      },
      interpolation: {
        maxDistanceMeters: 'Distância máxima para interpolar',
        minDistanceMeters: 'Distância mínima para interpolar',
        pointsPerSegment: 'Pontos intermediários máximos por segmento'
      }
    }
  });
});

/**
 * ✅ Obtém estatísticas completas da IA GPS para um dispositivo
 * Inclui: taxa de confiança, aprendizados, correções, maturidade
 * GET /api/analise-rota/:imei/estatisticas-ia
 */
router.get('/:imei/estatisticas-ia', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;

    if (!gpsAI) {
      return res.status(503).json({
        sucesso: false,
        erro: 'Serviço de IA GPS não disponível'
      });
    }

    // Buscar estatísticas completas
    const estatisticas = await gpsAI.getEstatisticasIA(imei);

    if (estatisticas.erro) {
      return res.status(404).json({
        sucesso: false,
        erro: estatisticas.erro
      });
    }

    res.json({
      sucesso: true,
      dados: estatisticas
    });

  } catch (error) {
    console.error('[Análise Rota] Erro ao obter estatísticas IA:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * ✅ Obtém estatísticas globais de treinamento da IA
 * GET /api/analise-rota/estatisticas-ia-global
 */
router.get('/estatisticas-ia-global', async (req, res) => {
  try {
    if (!gpsAI) {
      return res.status(503).json({
        sucesso: false,
        erro: 'Serviço de IA GPS não disponível'
      });
    }

    const estatisticas = await gpsAI.getEstatisticasTreinamento();

    res.json({
      sucesso: true,
      dados: estatisticas
    });

  } catch (error) {
    console.error('[Análise Rota] Erro ao obter estatísticas globais:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== ENDPOINTS DE FEEDBACK DO USUÁRIO ====================

/**
 * ✅ Registra feedback do usuário sobre uma correção
 * POST /api/analise-rota/:imei/feedback-correcao
 *
 * Body: {
 *   correcao_id: number,     // ID da correção GPS
 *   aprovado: boolean,       // true = boa, false = ruim
 *   avaliacao: number,       // 1-5 estrelas
 *   comentario: string       // Comentário opcional
 * }
 */
router.post('/:imei/feedback-correcao', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { correcao_id, aprovado, avaliacao, comentario } = req.body;

    if (!correcao_id) {
      return res.status(400).json({ sucesso: false, erro: 'correcao_id é obrigatório' });
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    // Buscar correção
    const correcao = await prisma.correcaoGPS.findUnique({
      where: { id: correcao_id }
    });

    if (!correcao) {
      return res.status(404).json({ sucesso: false, erro: 'Correção não encontrada' });
    }

    // Atualizar correção com feedback
    const correcaoAtualizada = await prisma.correcaoGPS.update({
      where: { id: correcao_id },
      data: {
        status: aprovado ? 'aprovado' : 'rejeitado',
        avaliacao: avaliacao || (aprovado ? 5 : 1),
        comentario: comentario || null,
        avaliado_em: new Date()
      }
    });

    // ✅ APRENDIZADO: Ajustar confiança baseado no feedback
    if (gpsAprendizado) {
      if (aprovado) {
        // Feedback positivo: salvar/reforçar aprendizado
        await gpsAprendizado.salvarAprendizado(
          dispositivo.id,
          { lat: correcao.lat_original, lon: correcao.lon_original },
          { lat: correcao.lat_corrigido, lon: correcao.lon_corrigido },
          correcao.metodo + '_confirmado'
        );
        console.log(`[Feedback] ✅ Correção ${correcao_id} APROVADA - aprendizado salvo`);
      } else {
        // Feedback negativo: remover aprendizado
        const { gridLat, gridLon } = gpsAprendizado.calcularGrid(correcao.lat_original, correcao.lon_original);

        // Reduzir confiança ou remover do aprendizado
        try {
          await prisma.coordenadaAprendida.updateMany({
            where: {
              dispositivo_id: dispositivo.id,
              grid_lat: gridLat,
              grid_lon: gridLon
            },
            data: {
              confianca: { decrement: 0.3 } // Reduzir confiança
            }
          });

          // Remover coordenadas com confiança muito baixa
          await prisma.coordenadaAprendida.deleteMany({
            where: {
              dispositivo_id: dispositivo.id,
              confianca: { lt: 0.3 }
            }
          });

          console.log(`[Feedback] ❌ Correção ${correcao_id} REJEITADA - aprendizado ajustado`);
        } catch (e) {
          console.warn('[Feedback] Erro ao ajustar aprendizado:', e.message);
        }

        // Reverter a coordenada no banco se ainda não foi modificada
        if (correcao.lat_original && correcao.lon_original) {
          await prisma.localizacao.updateMany({
            where: {
              dispositivo_id: dispositivo.id,
              latitude: correcao.lat_corrigido,
              longitude: correcao.lon_corrigido,
              timestamp: correcao.timestamp
            },
            data: {
              latitude: correcao.lat_original,
              longitude: correcao.lon_original,
              precisao: 0 // Remover flag de correção
            }
          });
          console.log(`[Feedback] 🔄 Coordenada revertida para original`);
        }
      }
    }

    // Treinar modelo com feedback
    if (gpsAI) {
      await gpsAI.atualizarModeloIA('dispositivo', String(dispositivo.id), aprovado, avaliacao || (aprovado ? 5 : 1));
    }

    res.json({
      sucesso: true,
      mensagem: aprovado ? 'Correção aprovada e aprendizado salvo' : 'Correção rejeitada e revertida',
      dados: {
        correcao_id,
        status: correcaoAtualizada.status,
        avaliacao: correcaoAtualizada.avaliacao
      }
    });

  } catch (error) {
    console.error('[Feedback] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * ✅ Registra feedback em lote para múltiplas correções
 * POST /api/analise-rota/:imei/feedback-lote
 *
 * Body: {
 *   feedbacks: [
 *     { indice: number, aprovado: boolean, avaliacao: number },
 *     ...
 *   ],
 *   horas: number
 * }
 */
router.post('/:imei/feedback-lote', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { feedbacks, horas } = req.body;

    if (!feedbacks || !Array.isArray(feedbacks)) {
      return res.status(400).json({ sucesso: false, erro: 'feedbacks é obrigatório e deve ser array' });
    }

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    const horasNum = parseInt(horas) || 24;
    const timestampLimite = new Date(Date.now() - horasNum * 60 * 60 * 1000);

    // Buscar correções do período
    const correcoes = await prisma.correcaoGPS.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: timestampLimite }
      },
      orderBy: { timestamp: 'asc' }
    });

    let aprovados = 0;
    let rejeitados = 0;

    for (const fb of feedbacks) {
      const correcao = correcoes[fb.indice];
      if (!correcao) continue;

      // Atualizar correção
      await prisma.correcaoGPS.update({
        where: { id: correcao.id },
        data: {
          status: fb.aprovado ? 'aprovado' : 'rejeitado',
          avaliacao: fb.avaliacao || (fb.aprovado ? 5 : 1),
          avaliado_em: new Date()
        }
      });

      // Ajustar aprendizado
      if (gpsAprendizado) {
        if (fb.aprovado) {
          await gpsAprendizado.salvarAprendizado(
            dispositivo.id,
            { lat: correcao.lat_original, lon: correcao.lon_original },
            { lat: correcao.lat_corrigido, lon: correcao.lon_corrigido },
            correcao.metodo + '_confirmado'
          );
          aprovados++;
        } else {
          // Reduzir confiança
          const { gridLat, gridLon } = gpsAprendizado.calcularGrid(correcao.lat_original, correcao.lon_original);
          await prisma.coordenadaAprendida.updateMany({
            where: {
              dispositivo_id: dispositivo.id,
              grid_lat: gridLat,
              grid_lon: gridLon
            },
            data: {
              confianca: { decrement: 0.3 }
            }
          });
          rejeitados++;
        }
      }
    }

    // Treinar modelo
    if (gpsAI && feedbacks.length > 0) {
      const mediaAvaliacao = feedbacks.reduce((sum, f) => sum + (f.avaliacao || 3), 0) / feedbacks.length;
      await gpsAI.atualizarModeloIA('dispositivo', String(dispositivo.id), aprovados > rejeitados, Math.round(mediaAvaliacao));
    }

    res.json({
      sucesso: true,
      mensagem: `Feedback processado: ${aprovados} aprovados, ${rejeitados} rejeitados`,
      dados: {
        total_feedbacks: feedbacks.length,
        aprovados,
        rejeitados
      }
    });

  } catch (error) {
    console.error('[Feedback Lote] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * ✅ Lista correções pendentes de validação
 * GET /api/analise-rota/:imei/correcoes-pendentes?horas=24
 */
router.get('/:imei/correcoes-pendentes', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    // Buscar correções pendentes (não avaliadas)
    const correcoes = await prisma.correcaoGPS.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: timestampLimite },
        OR: [
          { status: 'pendente' },
          { status: null }
        ]
      },
      orderBy: { timestamp: 'desc' }
    });

    // Estatísticas
    const stats = {
      total_pendentes: correcoes.length,
      por_metodo: {}
    };

    for (const c of correcoes) {
      const metodo = c.metodo || 'desconhecido';
      stats.por_metodo[metodo] = (stats.por_metodo[metodo] || 0) + 1;
    }

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_horas: horas,
        estatisticas: stats,
        correcoes: correcoes.map(c => ({
          id: c.id,
          timestamp: c.timestamp,
          original: { lat: c.lat_original, lon: c.lon_original },
          corrigido: { lat: c.lat_corrigido, lon: c.lon_corrigido },
          distancia_metros: c.distancia_correcao?.toFixed(2),
          metodo: c.metodo,
          confianca: c.confianca
        }))
      }
    });

  } catch (error) {
    console.error('[Correções Pendentes] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * ✅ Histórico de feedbacks do usuário
 * GET /api/analise-rota/:imei/historico-feedbacks?dias=30
 */
router.get('/:imei/historico-feedbacks', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const dias = parseInt(req.query.dias) || 30;

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    const timestampLimite = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

    // Buscar correções avaliadas
    const correcoes = await prisma.correcaoGPS.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        avaliado_em: { gte: timestampLimite }
      },
      orderBy: { avaliado_em: 'desc' },
      take: 100
    });

    // Estatísticas
    const stats = {
      total_avaliados: correcoes.length,
      aprovados: correcoes.filter(c => c.status === 'aprovado').length,
      rejeitados: correcoes.filter(c => c.status === 'rejeitado').length,
      avaliacao_media: correcoes.length > 0
        ? (correcoes.reduce((sum, c) => sum + (c.avaliacao || 0), 0) / correcoes.length).toFixed(1)
        : 0
    };

    stats.taxa_aprovacao = stats.total_avaliados > 0
      ? ((stats.aprovados / stats.total_avaliados) * 100).toFixed(1) + '%'
      : '0%';

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_dias: dias,
        estatisticas: stats,
        feedbacks: correcoes.map(c => ({
          id: c.id,
          timestamp: c.timestamp,
          avaliado_em: c.avaliado_em,
          status: c.status,
          avaliacao: c.avaliacao,
          comentario: c.comentario,
          metodo: c.metodo,
          distancia_metros: c.distancia_correcao?.toFixed(2)
        }))
      }
    });

  } catch (error) {
    console.error('[Histórico Feedbacks] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * ✅ Estatísticas de aprendizado do dispositivo
 * GET /api/analise-rota/:imei/estatisticas-aprendizado
 */
router.get('/:imei/estatisticas-aprendizado', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, erro: 'Dispositivo não encontrado' });
    }

    if (!gpsAprendizado) {
      return res.status(503).json({ sucesso: false, erro: 'Serviço de aprendizado não disponível' });
    }

    const stats = await gpsAprendizado.obterEstatisticas(dispositivo.id);

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        aprendizado: stats,
        descricao: {
          totalCoordenadas: 'Quantas coordenadas de referência foram aprendidas',
          totalAplicacoes: 'Quantas vezes o aprendizado foi usado para corrigir automaticamente',
          confiancaMedia: 'Confiança média das correções (0-1)',
          distanciaMedia: 'Distância média das correções',
          porMetodo: 'Quantidade de correções por método (micro_ajuste, snap_to_road, etc)'
        }
      }
    });

  } catch (error) {
    console.error('[Estatísticas Aprendizado] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

/**
 * ✅ COMPARATIVO IA - Análise detalhada antes/depois com sugestões de melhoria
 * Mostra:
 * 1. Comparativo visual (pontos originais vs corrigidos)
 * 2. Métricas de qualidade da rota
 * 3. Problemas detectados
 * 4. Sugestões automáticas de melhoria
 *
 * GET /api/analise-rota/:imei/comparativo-ia?horas=24
 */
router.get('/:imei/comparativo-ia', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const horas = parseInt(req.query.horas) || 24;

    const timestampLimite = new Date(Date.now() - horas * 60 * 60 * 1000);

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        localizacoes: {
          where: { timestamp: { gte: timestampLimite } },
          orderBy: { timestamp: 'asc' }
        }
      }
    });

    if (!dispositivo || !dispositivo.localizacoes.length) {
      return res.json({
        sucesso: true,
        dados: {
          comparativo: null,
          metricas: null,
          sugestoes: ['Sem dados GPS no período solicitado']
        }
      });
    }

    // Preparar pontos originais
    const pontosOriginais = dispositivo.localizacoes.map(l => ({
      latitude: l.latitude,
      longitude: l.longitude,
      velocidade: l.velocidade || 0,
      direcao: l.direcao || 0,
      timestamp: l.timestamp,
      hdop: l.precisao || null,
      ignicao: l.ignicao
    }));

    // Processar com pipeline completo (OSRM ativado)
    const resultadoCorrigido = await gpsFilterService.processarRotaCompleta(pontosOriginais, {
      usarKalman: true,
      usarMediaMovel: false,
      usarHampel: true,
      usarInterpolacao: true,
      usarOSRM: true
    });

    const pontosCorrigidos = resultadoCorrigido.pontos || [];

    // ==================== CALCULAR MÉTRICAS ====================
    const metricas = calcularMetricasQualidadeIA(pontosOriginais, pontosCorrigidos);

    // ==================== DETECTAR PROBLEMAS ====================
    const problemas = detectarProblemasGPSIA(pontosOriginais, pontosCorrigidos, metricas);

    // ==================== GERAR SUGESTÕES ====================
    const sugestoes = gerarSugestoesMelhoriaIA(metricas, problemas);

    // ==================== PREPARAR COMPARATIVO ====================
    const amostraComparativo = criarAmostraComparativoIA(pontosOriginais, pontosCorrigidos, 50);

    res.json({
      sucesso: true,
      dados: {
        imei,
        veiculo: dispositivo.veiculo,
        periodo_horas: horas,

        // Resumo
        resumo: {
          pontos_originais: pontosOriginais.length,
          pontos_corrigidos: pontosCorrigidos.length,
          pontos_interpolados: resultadoCorrigido.stats?.interpolados || 0,
          taxa_correcao: metricas.taxaCorrecao,
          qualidade_geral: metricas.qualidadeGeral,
          nota_qualidade: metricas.notaQualidade
        },

        // Métricas detalhadas
        metricas: {
          distancia: {
            original_km: metricas.distanciaOriginal,
            corrigida_km: metricas.distanciaCorrigida,
            diferenca_km: metricas.diferencaDistancia,
            diferenca_percentual: metricas.diferencaDistanciaPercent
          },
          velocidade: {
            media_original: metricas.velocidadeMediaOriginal,
            media_corrigida: metricas.velocidadeMediaCorrigida,
            maxima_original: metricas.velocidadeMaxOriginal,
            maxima_corrigida: metricas.velocidadeMaxCorrigida,
            saltos_removidos: metricas.saltosRemovidos
          },
          precisao: {
            desvio_medio_metros: metricas.desvioMedio,
            desvio_maximo_metros: metricas.desvioMaximo,
            pontos_na_rua: metricas.pontosNaRua,
            pontos_fora_rua: metricas.pontosForaRua,
            hdop_medio: metricas.hdopMedio
          },
          continuidade: {
            gaps_detectados: metricas.gapsDetectados,
            gap_maximo_segundos: metricas.gapMaximo,
            tempo_total_gaps_minutos: metricas.tempoTotalGaps,
            cobertura_temporal: metricas.coberturaTemporal
          },
          outliers: {
            total_detectados: metricas.outliersDetectados,
            teletransportes: metricas.teletransportes,
            velocidades_impossiveis: metricas.velocidadesImpossiveis,
            coordenadas_invalidas: metricas.coordenadasInvalidas
          }
        },

        // Problemas detectados
        problemas: problemas,

        // Sugestões de melhoria
        sugestoes: sugestoes,

        // Amostra para visualização
        comparativo: amostraComparativo,

        // Configuração atual
        config_atual: {
          kalman: gpsFilterService.CONFIG.kalman,
          validation: gpsFilterService.CONFIG.validation,
          osrm: gpsFilterService.CONFIG.osrm
        }
      }
    });

  } catch (error) {
    console.error('[Comparativo IA] Erro:', error);
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// ==================== FUNÇÕES AUXILIARES PARA MÉTRICAS ====================

function calcularMetricasQualidadeIA(pontosOriginais, pontosCorrigidos) {
  const metricas = {
    taxaCorrecao: '0%',
    qualidadeGeral: 'desconhecida',
    notaQualidade: 0,
    distanciaOriginal: 0,
    distanciaCorrigida: 0,
    diferencaDistancia: 0,
    diferencaDistanciaPercent: '0%',
    velocidadeMediaOriginal: 0,
    velocidadeMediaCorrigida: 0,
    velocidadeMaxOriginal: 0,
    velocidadeMaxCorrigida: 0,
    saltosRemovidos: 0,
    desvioMedio: 0,
    desvioMaximo: 0,
    pontosNaRua: 0,
    pontosForaRua: 0,
    hdopMedio: 0,
    gapsDetectados: 0,
    gapMaximo: 0,
    tempoTotalGaps: 0,
    coberturaTemporal: '0%',
    outliersDetectados: 0,
    teletransportes: 0,
    velocidadesImpossiveis: 0,
    coordenadasInvalidas: 0
  };

  if (!pontosOriginais.length || !pontosCorrigidos.length) return metricas;

  // Distância total original
  let distOriginal = 0;
  for (let i = 1; i < pontosOriginais.length; i++) {
    distOriginal += calcularDistanciaHaversineIA(
      pontosOriginais[i-1].latitude, pontosOriginais[i-1].longitude,
      pontosOriginais[i].latitude, pontosOriginais[i].longitude
    );
  }
  metricas.distanciaOriginal = parseFloat(distOriginal.toFixed(2));

  // Distância total corrigida
  let distCorrigida = 0;
  for (let i = 1; i < pontosCorrigidos.length; i++) {
    distCorrigida += calcularDistanciaHaversineIA(
      pontosCorrigidos[i-1].latitude, pontosCorrigidos[i-1].longitude,
      pontosCorrigidos[i].latitude, pontosCorrigidos[i].longitude
    );
  }
  metricas.distanciaCorrigida = parseFloat(distCorrigida.toFixed(2));

  metricas.diferencaDistancia = parseFloat((distCorrigida - distOriginal).toFixed(2));
  metricas.diferencaDistanciaPercent = distOriginal > 0
    ? ((metricas.diferencaDistancia / distOriginal) * 100).toFixed(1) + '%'
    : '0%';

  // Velocidades
  const velsOriginal = pontosOriginais.map(p => p.velocidade || 0).filter(v => v > 0);
  const velsCorrigida = pontosCorrigidos.map(p => p.velocidade || 0).filter(v => v > 0);

  metricas.velocidadeMediaOriginal = velsOriginal.length > 0
    ? parseFloat((velsOriginal.reduce((a, b) => a + b, 0) / velsOriginal.length).toFixed(1))
    : 0;
  metricas.velocidadeMediaCorrigida = velsCorrigida.length > 0
    ? parseFloat((velsCorrigida.reduce((a, b) => a + b, 0) / velsCorrigida.length).toFixed(1))
    : 0;

  metricas.velocidadeMaxOriginal = Math.max(...velsOriginal, 0);
  metricas.velocidadeMaxCorrigida = Math.max(...velsCorrigida, 0);

  // Detectar saltos (teletransportes)
  let saltosCount = 0;
  for (let i = 1; i < pontosOriginais.length; i++) {
    const dist = calcularDistanciaHaversineIA(
      pontosOriginais[i-1].latitude, pontosOriginais[i-1].longitude,
      pontosOriginais[i].latitude, pontosOriginais[i].longitude
    ) * 1000;
    const tempoSeg = (new Date(pontosOriginais[i].timestamp) - new Date(pontosOriginais[i-1].timestamp)) / 1000;
    if (tempoSeg > 0 && (dist / tempoSeg) * 3.6 > 200) saltosCount++;
  }
  metricas.saltosRemovidos = saltosCount;
  metricas.teletransportes = saltosCount;

  // Desvio médio
  let somaDesvio = 0, maxDesvio = 0, countDesvio = 0;
  for (let i = 0; i < Math.min(pontosOriginais.length, pontosCorrigidos.length); i++) {
    const desvio = calcularDistanciaHaversineIA(
      pontosOriginais[i].latitude, pontosOriginais[i].longitude,
      pontosCorrigidos[i].latitude, pontosCorrigidos[i].longitude
    ) * 1000;
    somaDesvio += desvio;
    maxDesvio = Math.max(maxDesvio, desvio);
    countDesvio++;
  }
  metricas.desvioMedio = countDesvio > 0 ? parseFloat((somaDesvio / countDesvio).toFixed(1)) : 0;
  metricas.desvioMaximo = parseFloat(maxDesvio.toFixed(1));

  // Pontos na rua
  metricas.pontosNaRua = pontosCorrigidos.filter(p => p.matched).length;
  metricas.pontosForaRua = pontosCorrigidos.filter(p => !p.matched && p.original).length;

  // HDOP médio
  const hdops = pontosOriginais.filter(p => p.hdop && p.hdop > 0).map(p => p.hdop);
  metricas.hdopMedio = hdops.length > 0 ? parseFloat((hdops.reduce((a, b) => a + b, 0) / hdops.length).toFixed(1)) : 0;

  // Gaps de sinal
  let gapsCount = 0, gapMax = 0, tempoGaps = 0;
  for (let i = 1; i < pontosOriginais.length; i++) {
    const gapSeg = (new Date(pontosOriginais[i].timestamp) - new Date(pontosOriginais[i-1].timestamp)) / 1000;
    if (gapSeg > 120) {
      gapsCount++;
      gapMax = Math.max(gapMax, gapSeg);
      tempoGaps += gapSeg;
    }
  }
  metricas.gapsDetectados = gapsCount;
  metricas.gapMaximo = Math.round(gapMax);
  metricas.tempoTotalGaps = parseFloat((tempoGaps / 60).toFixed(1));

  // Cobertura temporal
  if (pontosOriginais.length >= 2) {
    const tempoTotal = (new Date(pontosOriginais[pontosOriginais.length-1].timestamp) - new Date(pontosOriginais[0].timestamp)) / 1000;
    const tempoComDados = tempoTotal - tempoGaps;
    metricas.coberturaTemporal = tempoTotal > 0 ? ((tempoComDados / tempoTotal) * 100).toFixed(1) + '%' : '100%';
  }

  // Outliers
  metricas.outliersDetectados = pontosCorrigidos.filter(p => p.corrigido || p.kalman_filtered).length;
  metricas.velocidadesImpossiveis = pontosOriginais.filter(p => p.velocidade > 200).length;
  metricas.coordenadasInvalidas = pontosOriginais.filter(p => p.latitude === 0 || p.longitude === 0).length;

  // Taxa de correção
  const totalCorrigidos = pontosCorrigidos.filter(p => p.matched || p.kalman_filtered || p.interpolado).length;
  metricas.taxaCorrecao = pontosCorrigidos.length > 0
    ? ((totalCorrigidos / pontosCorrigidos.length) * 100).toFixed(1) + '%' : '0%';

  // Nota de qualidade (0-100)
  let nota = 100;
  nota -= metricas.teletransportes * 5;
  nota -= metricas.gapsDetectados * 3;
  nota -= metricas.coordenadasInvalidas * 10;
  nota -= metricas.velocidadesImpossiveis * 5;
  nota -= Math.max(0, metricas.hdopMedio - 5) * 2;
  nota -= Math.max(0, metricas.desvioMedio - 20);
  if (metricas.pontosNaRua > metricas.pontosForaRua * 2) nota += 5;
  if (metricas.gapsDetectados === 0) nota += 5;
  if (parseFloat(metricas.coberturaTemporal) > 95) nota += 5;

  nota = Math.max(0, Math.min(100, nota));
  metricas.notaQualidade = Math.round(nota);

  if (nota >= 90) metricas.qualidadeGeral = 'excelente';
  else if (nota >= 75) metricas.qualidadeGeral = 'boa';
  else if (nota >= 50) metricas.qualidadeGeral = 'regular';
  else if (nota >= 25) metricas.qualidadeGeral = 'ruim';
  else metricas.qualidadeGeral = 'crítica';

  return metricas;
}

function detectarProblemasGPSIA(pontosOriginais, pontosCorrigidos, metricas) {
  const problemas = [];

  if (metricas.teletransportes > 5) {
    problemas.push({
      tipo: 'teletransporte',
      severidade: 'alta',
      icone: '⚡',
      quantidade: metricas.teletransportes,
      descricao: `${metricas.teletransportes} saltos impossíveis detectados`,
      causa_provavel: 'Perda de sinal GPS ou reflexão em prédios',
      impacto: 'Rota cortando rios, prédios e áreas impossíveis'
    });
  }

  if (metricas.gapsDetectados > 3) {
    problemas.push({
      tipo: 'gap_sinal',
      severidade: 'média',
      icone: '📡',
      quantidade: metricas.gapsDetectados,
      descricao: `${metricas.gapsDetectados} gaps de sinal (> 2 min)`,
      causa_provavel: 'Túneis, garagens ou áreas sem cobertura',
      impacto: 'Rota incompleta com linhas retas'
    });
  }

  if (metricas.hdopMedio > 5) {
    problemas.push({
      tipo: 'hdop_alto',
      severidade: 'média',
      icone: '🎯',
      quantidade: null,
      descricao: `HDOP médio ${metricas.hdopMedio} (ideal < 3)`,
      causa_provavel: 'Poucos satélites visíveis',
      impacto: `Erro de até ${(metricas.hdopMedio * 5).toFixed(0)}m`
    });
  }

  if (metricas.desvioMedio > 30) {
    problemas.push({
      tipo: 'desvio_alto',
      severidade: 'alta',
      icone: '📍',
      quantidade: null,
      descricao: `Desvio médio de ${metricas.desvioMedio}m`,
      causa_provavel: 'GPS com baixa precisão',
      impacto: 'Correção significativa necessária'
    });
  }

  if (metricas.coordenadasInvalidas > 0) {
    problemas.push({
      tipo: 'coordenadas_invalidas',
      severidade: 'crítica',
      icone: '❌',
      quantidade: metricas.coordenadasInvalidas,
      descricao: `${metricas.coordenadasInvalidas} coordenadas inválidas`,
      causa_provavel: 'Falha no rastreador',
      impacto: 'Pontos descartados'
    });
  }

  const cobertura = parseFloat(metricas.coberturaTemporal);
  if (cobertura < 80) {
    problemas.push({
      tipo: 'baixa_cobertura',
      severidade: 'alta',
      icone: '⏱️',
      quantidade: null,
      descricao: `Apenas ${cobertura}% de cobertura`,
      causa_provavel: 'Muitos gaps ou rastreador desligado',
      impacto: 'Rota majoritariamente interpolada'
    });
  }

  return problemas;
}

function gerarSugestoesMelhoriaIA(metricas, problemas) {
  const sugestoes = [];

  for (const problema of problemas) {
    switch (problema.tipo) {
      case 'teletransporte':
        sugestoes.push({
          prioridade: 'alta',
          icone: '🔧',
          titulo: 'Reduzir limite de velocidade máxima',
          descricao: 'Mudar maxSpeedKmh de 180 para 150 km/h',
          config: 'CONFIG.validation.maxSpeedKmh = 150',
          impacto: 'Filtra mais saltos automaticamente'
        });
        sugestoes.push({
          prioridade: 'alta',
          icone: '📡',
          titulo: 'Verificar antena GPS',
          descricao: 'Reposicionar antena com visão clara do céu',
          config: null,
          impacto: 'Melhora precisão em 50-70%'
        });
        break;

      case 'gap_sinal':
        sugestoes.push({
          prioridade: 'média',
          icone: '⏱️',
          titulo: 'Aumentar maxGapSeconds',
          descricao: `Gap máximo de ${metricas.gapMaximo}s. Aumentar limite para interpolação`,
          config: `CONFIG.validation.maxGapSeconds = ${Math.min(300, metricas.gapMaximo + 60)}`,
          impacto: 'Interpola gaps maiores'
        });
        break;

      case 'hdop_alto':
        sugestoes.push({
          prioridade: 'média',
          icone: '🎯',
          titulo: 'Reduzir limite de HDOP',
          descricao: 'Rejeitar pontos com HDOP > 5',
          config: 'CONFIG.validation.maxHDOP = 5',
          impacto: 'Menos pontos, maior precisão'
        });
        break;

      case 'desvio_alto':
        sugestoes.push({
          prioridade: 'alta',
          icone: '🧠',
          titulo: 'Ajustar Kalman (menos agressivo)',
          descricao: 'Aumentar measurementNoise para confiar mais no GPS',
          config: 'CONFIG.kalman.measurementNoise = 15',
          impacto: 'Pontos mais próximos da medição'
        });
        break;
    }
  }

  // Sugestões baseadas na nota
  if (metricas.notaQualidade >= 80) {
    sugestoes.push({
      prioridade: 'baixa',
      icone: '✅',
      titulo: 'Qualidade boa!',
      descricao: 'Configuração atual adequada. Ajustes opcionais.',
      config: null,
      impacto: 'Melhoria marginal de 1-5%'
    });
  }

  if (metricas.notaQualidade < 50) {
    sugestoes.push({
      prioridade: 'alta',
      icone: '🛠️',
      titulo: 'Instalar OSRM local',
      descricao: 'Servidor OSRM local para maior controle',
      config: 'docker run -p 5000:5000 osrm/osrm-backend',
      impacto: 'Processamento mais rápido e configurável'
    });
  }

  return sugestoes;
}

function criarAmostraComparativoIA(pontosOriginais, pontosCorrigidos, maxPontos) {
  const amostra = { originais: [], corrigidos: [], desvios: [] };

  const stepOrig = Math.max(1, Math.floor(pontosOriginais.length / maxPontos));
  const stepCorr = Math.max(1, Math.floor(pontosCorrigidos.length / maxPontos));

  for (let i = 0; i < pontosOriginais.length && amostra.originais.length < maxPontos; i += stepOrig) {
    const p = pontosOriginais[i];
    amostra.originais.push({ lat: p.latitude, lng: p.longitude, vel: p.velocidade, timestamp: p.timestamp });
  }

  for (let i = 0; i < pontosCorrigidos.length && amostra.corrigidos.length < maxPontos; i += stepCorr) {
    const p = pontosCorrigidos[i];
    amostra.corrigidos.push({
      lat: p.latitude, lng: p.longitude, vel: p.velocidade,
      matched: p.matched || false, interpolado: p.interpolado || false, timestamp: p.timestamp
    });
  }

  const minLen = Math.min(amostra.originais.length, amostra.corrigidos.length);
  for (let i = 0; i < minLen; i++) {
    const desvio = calcularDistanciaHaversineIA(
      amostra.originais[i].lat, amostra.originais[i].lng,
      amostra.corrigidos[i].lat, amostra.corrigidos[i].lng
    ) * 1000;
    amostra.desvios.push({ index: i, metros: parseFloat(desvio.toFixed(1)), significativo: desvio > 20 });
  }

  return amostra;
}

function calcularDistanciaHaversineIA(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

module.exports = router;
