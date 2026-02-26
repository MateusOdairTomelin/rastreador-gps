/**
 * Rotas de Exportação de Dados
 * Endpoints para download de histórico em CSV e PDF
 */

const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const prisma = require('../db/prisma');
const https = require('https');
const http = require('http');

// Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant } = require('../middleware/tenant-device.middleware');

// Serviço de limite de velocidade por via
const velocidadeViaService = require('../services/velocidade-via.service');

// Serviço de veículos (histórico de rastreadores)
const veiculoService = require('../services/veiculo.service');

// Serviço de correção GPS (OSRM)
let gpsFilterService = null;
try {
  gpsFilterService = require('../services/gps-filter.service');
  console.log('[Exportar] GPS Filter Service carregado');
} catch (e) {
  console.warn('[Exportar] GPS Filter Service não disponível:', e.message);
}

// Tipos de dispositivo para verificar suporte OBD2
const { supportsOBD2 } = require('../constants/device-types');

// ============ HELPER: FILTRAR LOCALIZAÇÕES POR STATUS ============
/**
 * Filtra localizações baseado no status selecionado
 * @param {Array} localizacoes - Array de localizações
 * @param {string} statusFiltro - Status para filtrar (movimento, ocioso, parado, offline ou multiplos separados por virgula)
 * @param {Object} dispositivo - Dispositivo (para verificar status online/offline)
 * @returns {Array} Localizações filtradas
 */
function filtrarLocalizacoesPorStatus(localizacoes, statusFiltro, dispositivo) {
  if (!statusFiltro || statusFiltro === 'todos' || statusFiltro === '') {
    return localizacoes;
  }

  // Suporta multiplos status separados por virgula (ex: "movimento,ocioso")
  const statusList = statusFiltro.split(',').map(s => s.trim().toLowerCase());

  // Funcao helper para verificar se localização corresponde a um status
  const matchStatus = (loc, status) => {
    const velocidade = loc.velocidade || 0;
    const estadoIgnicao = loc.estado_ignicao || '';

    switch (status) {
      case 'movimento':
        return velocidade > 0;
      case 'ocioso':
        return velocidade === 0 && (loc.ignicao === true || estadoIgnicao === 'idle');
      case 'parado':
        return velocidade === 0 && loc.ignicao !== true && estadoIgnicao !== 'idle';
      case 'offline':
        const agora = new Date();
        const ultimoUpdate = new Date(loc.timestamp);
        const diffMinutos = (agora - ultimoUpdate) / (1000 * 60);
        return diffMinutos > 5;
      default:
        return false;
    }
  };

  return localizacoes.filter(loc => {
    // Retorna true se a localização corresponde a QUALQUER um dos status selecionados
    return statusList.some(status => matchStatus(loc, status));
  });
}

// ============ HELPER: BUSCAR HISTÓRICO DE RASTREADORES DO VEÍCULO ============
/**
 * Busca o histórico de rastreadores vinculados ao veículo em um período
 * @param {number} veiculo_id - ID do veículo
 * @param {Date} inicio - Data início do período
 * @param {Date} fim - Data fim do período
 * @returns {Promise<Array>} Array com histórico de rastreadores
 */
async function buscarHistoricoRastreadores(veiculo_id, inicio, fim) {
  if (!veiculo_id) return [];

  try {
    // 1. Buscar histórico de trocas (tabela VeiculoDispositivoHistorico)
    const historico = await prisma.veiculoDispositivoHistorico.findMany({
      where: {
        veiculo_id,
        // Rastreadores que estavam vinculados durante o período
        data_vinculo: { lte: fim },
        OR: [
          { data_desvinculo: null }, // Ainda vinculado
          { data_desvinculo: { gte: inicio } } // Desvinculado depois do início
        ]
      },
      include: {
        dispositivo: {
          select: {
            id: true,
            imei: true,
            tipo: true,
            status: true
          }
        }
      },
      orderBy: { data_vinculo: 'asc' }
    });

    const resultado = historico.map(h => ({
      imei: h.dispositivo?.imei || 'N/A',
      tipo: h.dispositivo?.tipo || 'N/A',
      status: h.dispositivo?.status || 'offline',
      data_vinculo: h.data_vinculo,
      data_desvinculo: h.data_desvinculo,
      ativo: h.ativo
    }));

    // 2. Buscar rastreador atual vinculado ao veículo (mesmo sem histórico de trocas)
    const dispositivoAtual = await prisma.dispositivo.findFirst({
      where: { veiculo_id },
      select: { id: true, imei: true, tipo: true, status: true, created_at: true }
    });

    // Se há dispositivo atual e ele NÃO está no histórico, adicionar
    if (dispositivoAtual) {
      const jaNoHistorico = resultado.some(r => r.imei === dispositivoAtual.imei);
      if (!jaNoHistorico) {
        resultado.push({
          imei: dispositivoAtual.imei,
          tipo: dispositivoAtual.tipo || 'N/A',
          status: dispositivoAtual.status || 'offline',
          data_vinculo: dispositivoAtual.created_at, // Usar data de criação como aproximação
          data_desvinculo: null,
          ativo: true
        });
      }
    }

    return resultado;
  } catch (error) {
    console.error('[Exportar] Erro ao buscar histórico de rastreadores:', error.message);
    return [];
  }
}

// ============ EXPORTAR CSV ============

/**
 * GET /api/exportar/:imei/csv
 * Exporta histórico do veículo em formato CSV MODULAR
 *
 * Query params:
 * - dataInicio: Data inicial (ISO string)
 * - dataFim: Data final (ISO string)
 * - modulos: string - lista separada por vírgula dos módulos a incluir
 *   Valores: resumo, score, consumo, kmDia, excessos, paradas, viagens, obd2, alarmes, localizacoes
 * - corrigido: boolean (default: true) - usar dados corrigidos pelo OSRM
 * - estado: string - filtrar por estado (movimento, ocioso, parado, ligado)
 * - velMin: number - velocidade mínima
 * - velMax: number - velocidade máxima
 * - soExcessos: boolean - apenas excessos de velocidade
 * - tipoAlarme: string - filtrar por tipo de alarme
 * Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/csv', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      modulos = 'resumo,score,consumo,kmDia,excessos,paradas,viagens,obd2,alarmes,localizacoes', // Padrão: todos
      incluirLocalizacoes = 'true',
      incluirOBD2 = 'true',
      incluirAlarmes = 'true',
      corrigido = 'true',
      estado = '',
      velMin = '',
      velMax = '',
      soExcessos = 'false',
      tipoAlarme = '',
      motoristaIds = '', // IDs dos motoristas filtrados (separados por vírgula)
      mostrarMotoristas = '', // 'todos' para mostrar todos os motoristas vinculados
      tagIds = '', // IDs das tags filtradas (separados por vírgula)
      statusFiltro = '', // Status filtrado (movimento, ocioso, parado, offline)
      // Filtros Avancados
      geofenceIds = '', // IDs das cercas filtradas
      tiposAlarme = '', // Tipos de alarme
      incluirViagens = '', // Checkbox simples para incluir viagens
      multaStatus = '', multaGravidade = '', // Multas
      velAcima80 = '', velAcima100 = '', velAcima120 = '', // Velocidade
      scoreMin = '', scoreMax = '', // Performance
      excessosMax = '', ociosoMax = '', kmMinRodado = '' // Performance
    } = req.query;

    // Extrair filtro de tags
    // Se mais de 50 tags forem enviadas, ignorar filtro (significa "Todos" selecionado)
    const tagIdsFiltroRaw = tagIds
      ? tagIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const tagIdsFiltro = tagIdsFiltroRaw.length > 50 ? [] : tagIdsFiltroRaw;
    const filtroTagAtivo = tagIdsFiltro.length > 0;

    // Extrair filtro de status
    const statusFiltroAtivo = statusFiltro && statusFiltro !== 'todos';

    // Extrair filtro de motorista
    const motoristaIdsFiltro = motoristaIds
      ? motoristaIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const mostrarTodosMotoristas = mostrarMotoristas === 'todos';
    const filtroMotoristaAtivo = motoristaIdsFiltro.length > 0 || mostrarTodosMotoristas;

    // Extrair filtros avançados
    const geofenceIdsFiltro = geofenceIds ? geofenceIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
    const filtroGeofenceAtivo = geofenceIdsFiltro.length > 0;

    const tiposAlarmeFiltro = tiposAlarme ? tiposAlarme.split(',').filter(t => t.trim()) : [];
    const filtroAlarmeAtivo = tiposAlarmeFiltro.length > 0;

    // Viagens: checkbox simples - inclui todas as viagens do periodo
    const filtroViagemAtivo = incluirViagens === 'true';

    const multaStatusFiltro = multaStatus ? multaStatus.split(',').filter(s => s.trim()) : [];
    const multaGravidadeFiltro = multaGravidade ? multaGravidade.split(',').filter(g => g.trim()) : [];
    const filtroMultaAtivo = multaStatusFiltro.length > 0 || multaGravidadeFiltro.length > 0;

    const filtrosVelocidade = {
      acima80: velAcima80 === 'true',
      acima100: velAcima100 === 'true',
      acima120: velAcima120 === 'true'
    };

    const filtrosPerformance = {
      scoreMin: scoreMin ? parseFloat(scoreMin) : null,
      scoreMax: scoreMax ? parseFloat(scoreMax) : null,
      excessosMax: excessosMax ? parseInt(excessosMax) : null,
      ociosoMax: ociosoMax ? parseInt(ociosoMax) : null,
      kmMinRodado: kmMinRodado ? parseFloat(kmMinRodado) : null
    };
    const filtroPerformanceAtivo = Object.values(filtrosPerformance).some(v => v !== null);

    // Parsear módulos selecionados
    const modulosSelecionados = modulos.split(',').map(m => m.trim().toLowerCase());
    const temModulo = (nome) => modulosSelecionados.includes(nome.toLowerCase());

    console.log('[CSV Modular] Módulos selecionados:', modulosSelecionados);
    console.log('[CSV Modular] Filtros avançados:', { geofenceIdsFiltro, tiposAlarmeFiltro, filtrosViagem, filtroMultaAtivo });

    // Converter filtros numéricos
    const velocidadeMin = velMin ? parseFloat(velMin) : null;
    const velocidadeMax = velMax ? parseFloat(velMax) : null;
    const filtrarSoExcessos = soExcessos === 'true';
    const aplicarCorrecao = corrigido === 'true' && gpsFilterService !== null;

    // Buscar dispositivo com tags do veículo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        veiculo_rel: {
          include: {
            tags: {
              include: {
                tag: { select: { id: true, nome: true, cor: true } }
              }
            }
          }
        }
      }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Extrair tags do veículo
    const tagsVeiculo = dispositivo.veiculo_rel?.tags?.map(vt => vt.tag.nome).join(', ') || 'Nenhuma';

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    let csvContent = '';
    let totalRegistros = 0;

    // Função auxiliar para formatar tempo
    const formatarTempoCSV = (minutos) => {
      const horas = Math.floor(minutos / 60);
      const mins = Math.round(minutos % 60);
      if (horas > 0) return `${horas}h ${mins}min`;
      return `${mins} min`;
    };

    // ============ BUSCAR MOTORISTA(S) VINCULADO(S) NO PERÍODO (CSV) ============
    // Busca motoristas se: filtro específico OU "todos os motoristas"
    let motoristasTextoCSV = '';
    let motoristasVinculadosCSV = [];

    if (filtroMotoristaAtivo) {
      try {
        // Construir filtro base
        const whereHistorico = {
          dispositivo_id: dispositivo.id,
          OR: [{ fim: null }, { fim: { gte: inicio } }],
          inicio: { lte: fim }
        };

        // Se não é "todos", filtrar por IDs específicos
        if (!mostrarTodosMotoristas && motoristaIdsFiltro.length > 0) {
          whereHistorico.motorista_id = { in: motoristaIdsFiltro };
        }

        const historicoMotoristasCSV = await prisma.historicoMotorista.findMany({
          where: whereHistorico,
          include: { motorista: { select: { id: true, nome: true, cnh_categoria: true } } },
          orderBy: { inicio: 'asc' }
        });

        // Função para formatar período com DATA + HORA precisa
        const formatarPeriodoCSV = (data) => {
          if (!data) return '';
          const d = new Date(data);
          return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        };

        // Mostrar CADA vínculo separadamente (não consolidar por motorista)
        motoristasVinculadosCSV = historicoMotoristasCSV
          .filter(h => h.motorista)
          .map(h => ({
            ...h.motorista,
            periodoInicio: h.inicio,
            periodoFim: h.fim
          }))
          .sort((a, b) => new Date(a.periodoInicio) - new Date(b.periodoInicio));

        // Formatar texto com todos os vínculos
        if (motoristasVinculadosCSV.length > 0) {
          motoristasTextoCSV = motoristasVinculadosCSV.map(m => {
            const inicioStr = formatarPeriodoCSV(m.periodoInicio);
            const fimStr = m.periodoFim ? formatarPeriodoCSV(m.periodoFim) : 'atual';
            return `${m.nome}${m.cnh_categoria ? ` (CNH ${m.cnh_categoria})` : ''} [${inicioStr} até ${fimStr}]`;
          }).join('; ');
        }
      } catch (e) {
        console.log('[CSV] Erro ao buscar motoristas:', e.message);
      }
    }

    // Função helper para encontrar motorista em um timestamp específico (CSV)
    const encontrarMotoristaPorTimestampCSV = (timestamp) => {
      const ts = new Date(timestamp);
      for (const m of motoristasVinculadosCSV) {
        const inicio = new Date(m.periodoInicio);
        const fim = m.periodoFim ? new Date(m.periodoFim) : new Date();
        if (ts >= inicio && ts <= fim) {
          return m.nome;
        }
      }
      return null;
    };

    // ============ BUSCAR NOMES DAS TAGS FILTRADAS (CSV) ============
    let tagsFiltradas = [];
    if (filtroTagAtivo) {
      try {
        tagsFiltradas = await prisma.tag.findMany({
          where: { id: { in: tagIdsFiltro } },
          select: { id: true, nome: true }
        });
      } catch (e) {
        console.log('[CSV] Erro ao buscar tags filtradas:', e.message);
      }
    }
    const tagsFiltradasTexto = tagsFiltradas.map(t => t.nome).join('; ') || '';

    // ============ TEXTO DO STATUS FILTRADO (CSV) ============
    const statusTextoMap = {
      'movimento': 'Em Movimento',
      'ocioso': 'Ocioso (motor ligado)',
      'parado': 'Parado (motor desligado)',
      'offline': 'Offline'
    };
    const statusFiltradoTexto = statusFiltroAtivo ? (statusTextoMap[statusFiltro] || statusFiltro) : '';

    // ============ BUSCAR DADOS DOS FILTROS AVANÇADOS (CSV) ============

    // Geofencing
    let geofencesFiltradas = [];
    if (filtroGeofenceAtivo) {
      try {
        geofencesFiltradas = await prisma.geofence.findMany({
          where: { id: { in: geofenceIdsFiltro } },
          select: { id: true, nome: true, raio_metros: true }
        });
      } catch (e) {
        console.log('[CSV] Erro ao buscar cercas:', e.message);
      }
    }
    const geofencesTexto = geofencesFiltradas.map(g => `${g.nome} (${g.raio_metros}m)`).join('; ') || '';

    // Alarmes - Mapeamento de tipos
    const alarmesTextoMap = {
      'excesso_velocidade': '🚨 Excesso de Velocidade',
      'sos': '🆘 SOS/Pânico',
      'bateria_baixa': '🔋 Bateria Baixa',
      'desconexao': 'Desconexão GPS',
      'geofence_entrada': 'Entrada em Cerca',
      'geofence_saida': 'Saída de Cerca',
      'ignicao': '🔑 Ignição On/Off',
      'vibracao': '📳 Vibração/Impacto'
    };
    const alarmesTexto = tiposAlarmeFiltro.map(t => alarmesTextoMap[t] || t).join('; ') || '';

    // Viagens - Texto (checkbox simples)
    const viagensTexto = filtroViagemAtivo ? 'Sim (todas do periodo)' : '';

    // Multas - Texto
    let multasTexto = '';
    if (filtroMultaAtivo) {
      const partes = [];
      if (multaStatusFiltro.length > 0) {
        partes.push(`Status: ${multaStatusFiltro.join(', ')}`);
      }
      if (multaGravidadeFiltro.length > 0) {
        partes.push(`Gravidade: ${multaGravidadeFiltro.join(', ')}`);
      }
      multasTexto = partes.join('; ');
    }

    // ⚡ Velocidade - Texto
    let velocidadeTexto = '';
    const velPartes = [];
    if (velocidadeMin || velocidadeMax) {
      velPartes.push(`${velocidadeMin || 0}-${velocidadeMax || '∞'} km/h`);
    }
    if (filtrosVelocidade.acima80) velPartes.push('>80 km/h');
    if (filtrosVelocidade.acima100) velPartes.push('>100 km/h');
    if (filtrosVelocidade.acima120) velPartes.push('>120 km/h');
    if (filtrarSoExcessos) velPartes.push('Apenas excessos');
    velocidadeTexto = velPartes.join('; ');

    // Performance - Texto
    let performanceTexto = '';
    if (filtroPerformanceAtivo) {
      const partes = [];
      if (filtrosPerformance.scoreMin || filtrosPerformance.scoreMax) {
        partes.push(`Score: ${filtrosPerformance.scoreMin || 0}-${filtrosPerformance.scoreMax || 100}`);
      }
      if (filtrosPerformance.excessosMax) {
        partes.push(`Max excessos: ${filtrosPerformance.excessosMax}`);
      }
      if (filtrosPerformance.ociosoMax) {
        partes.push(`Max ocioso: ${filtrosPerformance.ociosoMax} min`);
      }
      if (filtrosPerformance.kmMinRodado) {
        partes.push(`Min rodado: ${filtrosPerformance.kmMinRodado} km`);
      }
      performanceTexto = partes.join('; ');
    }

    // ============ MÓDULO: LOCALIZAÇÕES ============
    // Localizações são necessárias para vários módulos (resumo, excessos, paradas, etc)
    const precisaLocalizacoes = temModulo('localizacoes') || temModulo('resumo') || temModulo('excessos') || temModulo('paradas');
    if (precisaLocalizacoes) {
      let localizacoes = await prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });

      // Aplicar filtro de status se selecionado
      if (statusFiltroAtivo) {
        const totalAntes = localizacoes.length;
        localizacoes = filtrarLocalizacoesPorStatus(localizacoes, statusFiltro, dispositivo);
        console.log(`[CSV] Filtro status '${statusFiltro}': ${totalAntes} -> ${localizacoes.length} registros`);
      }

      // Aplicar correção GPS (OSRM) se habilitado
      if (aplicarCorrecao && localizacoes.length > 1) {
        console.log(`[CSV] Aplicando correção GPS em ${localizacoes.length} pontos...`);
        try {
          const pontosParaCorrigir = localizacoes.map(l => ({
            latitude: l.latitude,
            longitude: l.longitude,
            velocidade: l.velocidade,
            direcao: l.direcao,
            ignicao: l.ignicao,
            timestamp: l.timestamp,
            precisao: l.precisao
          }));

          const resultado = await gpsFilterService.processarRotaCompleta(pontosParaCorrigir, {
            usarKalman: true,
            usarHampel: true,
            usarInterpolacao: false, // Não interpolar para CSV (manter pontos reais)
            usarOSRM: true
          });

          if (resultado && resultado.pontos) {
            localizacoes = resultado.pontos;
            console.log(`[CSV] Correção aplicada: ${pontosParaCorrigir.length} -> ${localizacoes.length} pontos`);
          }
        } catch (e) {
          console.warn('[CSV] Erro ao aplicar correção GPS:', e.message);
        }
      }

      if (localizacoes.length > 0) {
        // Cache persistente: primeira consulta lenta, próximas instantâneas do banco
        console.log(`[CSV] Consultando limites para ${localizacoes.length} pontos (cache persistente)...`);

        // Consultar limites de velocidade em lote (usa cache do banco)
        let limitesVia = new Map();
        try {
          const pontosParaConsulta = localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));
          limitesVia = await velocidadeViaService.obterLimitesEmLote(pontosParaConsulta);
        } catch (e) {
          console.log('[CSV] Erro ao consultar limites:', e.message);
        }

        // Aplicar filtros avançados
        let localizacoesFiltradas = localizacoes.filter(loc => {
          const velocidade = loc.velocidade || 0;

          // Filtro de velocidade
          if (velocidadeMin !== null && velocidade < velocidadeMin) return false;
          if (velocidadeMax !== null && velocidade > velocidadeMax) return false;

          // Determinar estado - usar estado_ignicao se disponível, senão fallback
          let estadoAtual = 'parado';
          if (loc.estado_ignicao) {
            // Mapear estados novos para termos de filtro
            switch (loc.estado_ignicao) {
              case 'moving': estadoAtual = 'movimento'; break;
              case 'idle': estadoAtual = 'ocioso'; break;
              case 'acc_on': estadoAtual = 'ocioso'; break;  // Meia chave = similar a ocioso para filtro
              case 'off': estadoAtual = 'parado'; break;
              default: estadoAtual = 'parado';
            }
          } else if (loc.ignicao === true || loc.ignicao === 1) {
            // Fallback para registros antigos sem estado_ignicao
            estadoAtual = velocidade > 5 ? 'movimento' : 'ocioso';
          }

          // Filtro de estado
          if (estado === 'movimento' && estadoAtual !== 'movimento') return false;
          if (estado === 'ocioso' && estadoAtual !== 'ocioso') return false;
          if (estado === 'parado' && estadoAtual !== 'parado') return false;
          if (estado === 'ligado' && estadoAtual === 'parado') return false;  // ligado = movimento ou ocioso

          // Filtro de excesso de velocidade (usando cache precisso)
          if (filtrarSoExcessos) {
            const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
            const infoVia = limitesVia.get(cacheKey);
            const limite = infoVia?.limite || 60;
            if (velocidade <= limite) return false;
          }

          return true;
        });

        if (localizacoesFiltradas.length > 0 && temModulo('localizacoes')) {
          csvContent += '[LOCALIZACOES]\n';
          csvContent += 'Data/Hora,Estado,Latitude,Longitude,Velocidade (km/h),Limite Via,Nome Via,Excesso (km/h),Dist. Anterior (m),Tempo Anterior,Direcao,Corrigido\n';

          // Arrays para coletar dados extras
          let excessosDetalhados = [];
          let paradasCSV = [];
          let paradaAtualCSV = null;
          const TEMPO_MINIMO_PARADA_CSV = 5; // minutos
          const DISTANCIA_MESMA_PARADA_CSV = 0.1; // km (100m)

          for (let i = 0; i < localizacoesFiltradas.length; i++) {
            const loc = localizacoesFiltradas[i];
            const locAnterior = i > 0 ? localizacoesFiltradas[i - 1] : null;

            // Calcular distância e tempo do ponto anterior
            let distanciaAnterior = 0;
            let tempoAnteriorMin = 0;
            let tempoAnteriorTexto = '-';

            if (locAnterior) {
              distanciaAnterior = calcularDistancia(
                locAnterior.latitude, locAnterior.longitude,
                loc.latitude, loc.longitude
              ) * 1000; // converter para metros

              tempoAnteriorMin = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);
              if (tempoAnteriorMin < 1) {
                tempoAnteriorTexto = `${Math.round(tempoAnteriorMin * 60)}s`;
              } else if (tempoAnteriorMin < 60) {
                tempoAnteriorTexto = `${Math.round(tempoAnteriorMin)}min`;
              } else {
                const horas = Math.floor(tempoAnteriorMin / 60);
                const mins = Math.round(tempoAnteriorMin % 60);
                tempoAnteriorTexto = `${horas}h${mins}min`;
              }
            }

            // Determinar estado (usar estado_ignicao se disponivel)
            let estadoTexto = 'Parado';
            const velocidadeLoc = loc.velocidade || 0;
            if (loc.estado_ignicao) {
              // Usar campo estado_ignicao se disponivel
              switch (loc.estado_ignicao) {
                case 'moving': estadoTexto = 'Em Movimento'; break;
                case 'idle': estadoTexto = 'Ocioso'; break;
                case 'off': estadoTexto = 'Parado'; break;
                default: estadoTexto = loc.estado_ignicao;
              }
            } else if (loc.ignicao === true || loc.ignicao === 1) {
              estadoTexto = velocidadeLoc > 5 ? 'Em Movimento' : 'Ocioso';
            }

            // Obter limite de velocidade da via (cache preciso)
            const velocidade = loc.velocidade || 0;
            const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
            const infoVia = limitesVia.get(cacheKey);
            const limiteVia = infoVia?.limite || 60;
            const nomeVia = (infoVia?.nome || 'N/A').replace(/,/g, ';');

            // Calcular valor do excesso (em vez de SIM/NÃO)
            const excedeValor = velocidade > limiteVia ? velocidade - limiteVia : 0;
            const excedeTexto = excedeValor > 0 ? `+${excedeValor}` : '-';
            const foiCorrigido = loc.matched ? 'SIM' : 'NÃO';

            // Coletar excessos detalhados
            if (excedeValor > 0) {
              excessosDetalhados.push({
                timestamp: loc.timestamp,
                latitude: loc.latitude,
                longitude: loc.longitude,
                velocidade: velocidade,
                limite: limiteVia,
                excesso: excedeValor,
                nomeVia: nomeVia,
                motorista: encontrarMotoristaPorTimestampCSV(loc.timestamp) // Motorista no momento do excesso
              });
            }

            // Detectar paradas significativas
            if (velocidade === 0) {
              if (!paradaAtualCSV) {
                paradaAtualCSV = {
                  inicio: loc.timestamp,
                  fim: loc.timestamp,
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  tempoMinutos: 0
                };
              } else {
                const distParada = calcularDistancia(
                  paradaAtualCSV.latitude, paradaAtualCSV.longitude,
                  loc.latitude, loc.longitude
                );
                if (distParada < DISTANCIA_MESMA_PARADA_CSV) {
                  paradaAtualCSV.fim = loc.timestamp;
                  paradaAtualCSV.tempoMinutos += tempoAnteriorMin;
                } else {
                  if (paradaAtualCSV.tempoMinutos >= TEMPO_MINIMO_PARADA_CSV) {
                    paradasCSV.push({ ...paradaAtualCSV });
                  }
                  paradaAtualCSV = {
                    inicio: loc.timestamp,
                    fim: loc.timestamp,
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    tempoMinutos: 0
                  };
                }
              }
            } else {
              if (paradaAtualCSV && paradaAtualCSV.tempoMinutos >= TEMPO_MINIMO_PARADA_CSV) {
                paradasCSV.push({ ...paradaAtualCSV });
              }
              paradaAtualCSV = null;
            }

            csvContent += `${formatDateTime(loc.timestamp)},${estadoTexto},${loc.latitude},${loc.longitude},${velocidade},${limiteVia},${nomeVia},${excedeTexto},${Math.round(distanciaAnterior)},${tempoAnteriorTexto},${loc.direcao || ''},${foiCorrigido}\n`;
          }

          // Finalizar última parada se existir
          if (paradaAtualCSV && paradaAtualCSV.tempoMinutos >= TEMPO_MINIMO_PARADA_CSV) {
            paradasCSV.push({ ...paradaAtualCSV });
          }

          csvContent += '\n';
          totalRegistros += localizacoesFiltradas.length;

          // ============ SEÇÃO DE EXCESSOS DE VELOCIDADE ============
          if (excessosDetalhados.length > 0) {
            csvContent += '\n\n';
            csvContent += '[RESUMO EXCESSOS]\n';
            csvContent += 'Metrica,Valor\n';
            csvContent += `Total de Excessos,${excessosDetalhados.length}\n`;
            csvContent += `Maior Excesso,+${Math.max(...excessosDetalhados.map(e => e.excesso))} km/h\n`;
            csvContent += `Velocidade Maxima,${Math.max(...excessosDetalhados.map(e => e.velocidade))} km/h\n`;
            csvContent += '\n\n';
            csvContent += '[EXCESSOS DE VELOCIDADE]\n';
            csvContent += 'Data/Hora,Via,Motorista,Velocidade (km/h),Limite (km/h),Excesso (km/h),Latitude,Longitude\n';

            // Ordenar por excesso (maior primeiro)
            const excessosOrdenados = [...excessosDetalhados].sort((a, b) => b.excesso - a.excesso);
            for (const exc of excessosOrdenados) {
              const motoristaCSV = exc.motorista || 'N/I'; // N/I = Não Identificado
              csvContent += `${formatDateTime(exc.timestamp)},${exc.nomeVia},${motoristaCSV},${exc.velocidade},${exc.limite},+${exc.excesso},${exc.latitude},${exc.longitude}\n`;
            }
            csvContent += '\n';
          }

          // ============ SEÇÃO DE PARADAS SIGNIFICATIVAS ============
          if (paradasCSV.length > 0) {
            // Buscar nomes das vias para cada parada
            for (const parada of paradasCSV) {
              try {
                const infoVia = await velocidadeViaService.obterLimiteVelocidade(parada.latitude, parada.longitude);
                parada.nomeVia = (infoVia.nome || 'Local não identificado').replace(/,/g, ';');
              } catch (e) {
                parada.nomeVia = 'Local não identificado';
              }
            }

            const tempoTotalParadas = paradasCSV.reduce((sum, p) => sum + p.tempoMinutos, 0);
            const maiorParada = Math.max(...paradasCSV.map(p => p.tempoMinutos));

            csvContent += '\n\n';
            csvContent += '[RESUMO PARADAS]\n';
            csvContent += 'Metrica,Valor\n';
            csvContent += `Total de Paradas,${paradasCSV.length}\n`;
            csvContent += `Tempo Total Parado,${formatarTempoCSV(tempoTotalParadas)}\n`;
            csvContent += `Maior Parada,${formatarTempoCSV(maiorParada)}\n`;
            csvContent += '\n\n';
            csvContent += '[PARADAS DETALHADAS]\n';
            csvContent += 'Numero,Inicio,Fim,Duracao,Local/Via,Latitude,Longitude\n';

            // Ordenar por duração (maior primeiro)
            const paradasOrdenadas = [...paradasCSV].sort((a, b) => b.tempoMinutos - a.tempoMinutos);
            for (let i = 0; i < paradasOrdenadas.length; i++) {
              const parada = paradasOrdenadas[i];
              csvContent += `${i + 1},${formatDateTime(parada.inicio)},${formatDateTime(parada.fim)},${formatarTempoCSV(parada.tempoMinutos)},${parada.nomeVia},${parada.latitude},${parada.longitude}\n`;
            }
            csvContent += '\n';
          }
        }
      }
    }

    // ============ MÓDULO: EXCESSOS (SEPARADO) ============
    // Gera seção de excessos mesmo se 'localizacoes' não estiver selecionado
    if (temModulo('excessos') && !temModulo('localizacoes')) {
      // Buscar localizações para detectar excessos
      let locsExcessos = await prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });

      // Aplicar filtro de status se selecionado
      if (statusFiltroAtivo) {
        locsExcessos = filtrarLocalizacoesPorStatus(locsExcessos, statusFiltro, dispositivo);
      }

      if (locsExcessos.length > 0) {
        // Obter limites de velocidade
        let limitesViaExc = new Map();
        try {
          const pontosExc = locsExcessos.map(l => ({ lat: l.latitude, lng: l.longitude }));
          limitesViaExc = await velocidadeViaService.obterLimitesEmLote(pontosExc);
        } catch (e) {
          console.log('[CSV Excessos] Erro ao consultar limites:', e.message);
        }

        // Detectar excessos
        const excessosCSV = [];
        for (const loc of locsExcessos) {
          const velocidade = loc.velocidade || 0;
          const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
          const infoVia = limitesViaExc.get(cacheKey);
          const limiteVia = infoVia?.limite || 60;
          const nomeVia = (infoVia?.nome || 'N/A').replace(/,/g, ';');

          if (velocidade > limiteVia) {
            excessosCSV.push({
              timestamp: loc.timestamp,
              latitude: loc.latitude,
              longitude: loc.longitude,
              velocidade: velocidade,
              limite: limiteVia,
              excesso: velocidade - limiteVia,
              nomeVia: nomeVia
            });
          }
        }

        if (excessosCSV.length > 0) {
          csvContent += '\n\n';
          csvContent += '[RESUMO EXCESSOS]\n';
          csvContent += 'Metrica,Valor\n';
          csvContent += `Total de Excessos,${excessosCSV.length}\n`;
          csvContent += `Maior Excesso,+${Math.max(...excessosCSV.map(e => e.excesso))} km/h\n`;
          csvContent += `Velocidade Maxima,${Math.max(...excessosCSV.map(e => e.velocidade))} km/h\n`;
          csvContent += '\n\n';
          csvContent += '[EXCESSOS DE VELOCIDADE]\n';
          csvContent += 'Data/Hora,Via,Velocidade (km/h),Limite (km/h),Excesso (km/h),Latitude,Longitude\n';

          const excessosOrd = [...excessosCSV].sort((a, b) => b.excesso - a.excesso);
          for (const exc of excessosOrd) {
            csvContent += `${formatDateTime(exc.timestamp)},${exc.nomeVia},${exc.velocidade},${exc.limite},+${exc.excesso},${exc.latitude},${exc.longitude}\n`;
          }
          csvContent += '\n';
          totalRegistros += excessosCSV.length;
        }
      }
    }

    // ============ MÓDULO: DADOS OBD2 ============
    // Só inclui OBD2 se o dispositivo SUPORTA OBD2 (não inclui para XT40_4F)
    const dispositivoSuportaOBD2 = supportsOBD2(dispositivo.tipo);
    if (temModulo('obd2') && dispositivoSuportaOBD2) {
      const dadosOBD2 = await prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });

      if (dadosOBD2.length > 0) {
        // Calcular estatísticas de consumo/combustível
        const combustivelDados = dadosOBD2.filter(o => o.nivel_combustivel !== null && o.nivel_combustivel !== undefined);
        const odometroDados = dadosOBD2.filter(o => o.odometro_embarcado !== null && o.odometro_embarcado !== undefined);
        const rpmDados = dadosOBD2.filter(o => o.rpm !== null && o.rpm !== undefined);
        const tempDados = dadosOBD2.filter(o => o.temperatura_motor !== null && o.temperatura_motor !== undefined);

        csvContent += '\n\n';

        // Resumo de consumo se houver dados suficientes
        if (combustivelDados.length >= 2 || odometroDados.length >= 2) {
          csvContent += '[RESUMO OBD2]\n';
          csvContent += 'Metrica,Valor\n';

          if (combustivelDados.length >= 2) {
            const primeiroNivel = combustivelDados[0].nivel_combustivel;
            const ultimoNivel = combustivelDados[combustivelDados.length - 1].nivel_combustivel;
            const consumoPct = primeiroNivel - ultimoNivel;
            csvContent += `Combustivel Inicial,${primeiroNivel}%\n`;
            csvContent += `Combustivel Final,${ultimoNivel}%\n`;
            if (consumoPct > 0) {
              csvContent += `Consumo no Periodo,${consumoPct.toFixed(1)}%\n`;
            } else if (consumoPct < 0) {
              csvContent += `Abastecimento Detectado,+${Math.abs(consumoPct).toFixed(1)}%\n`;
            }
          }

          if (odometroDados.length >= 2) {
            const primeiroOdo = odometroDados[0].odometro_embarcado;
            const ultimoOdo = odometroDados[odometroDados.length - 1].odometro_embarcado;
            const distanciaOBD2 = ultimoOdo - primeiroOdo;
            csvContent += `Odometro Inicial,${Math.round(primeiroOdo)} km\n`;
            csvContent += `Odometro Final,${Math.round(ultimoOdo)} km\n`;
            if (distanciaOBD2 > 0) {
              csvContent += `Distancia Percorrida OBD2,${distanciaOBD2.toFixed(1)} km\n`;

              // Calcular consumo médio se tiver ambos os dados
              if (combustivelDados.length >= 2) {
                const consumoPct = combustivelDados[0].nivel_combustivel - combustivelDados[combustivelDados.length - 1].nivel_combustivel;
                if (consumoPct > 0 && distanciaOBD2 > 1) {
                  const litrosConsumidos = (consumoPct / 100) * 50;
                  const kmPorLitro = distanciaOBD2 / litrosConsumidos;
                  csvContent += `Consumo Estimado,${kmPorLitro.toFixed(1)} km/L\n`;
                }
              }
            }
          }

          if (rpmDados.length > 0) {
            const rpmMax = Math.max(...rpmDados.map(o => o.rpm));
            const rpmMedia = Math.round(rpmDados.reduce((sum, o) => sum + o.rpm, 0) / rpmDados.length);
            csvContent += `RPM Maximo,${rpmMax}\n`;
            csvContent += `RPM Medio,${rpmMedia}\n`;
          }

          if (tempDados.length > 0) {
            const tempMax = Math.max(...tempDados.map(o => o.temperatura_motor));
            const tempMedia = Math.round(tempDados.reduce((sum, o) => sum + o.temperatura_motor, 0) / tempDados.length);
            csvContent += `Temperatura Maxima Motor,${tempMax}C\n`;
            csvContent += `Temperatura Media Motor,${tempMedia}C\n`;
          }

          csvContent += '\n\n';
        }

        csvContent += '[DADOS OBD2 DETALHADOS]\n';
        csvContent += 'Data/Hora,Ignicao,RPM,Temp Motor (C),Combustivel (%),Odometro (km),Horimetro (h),Bateria (%),Tensao (V)\n';

        for (const obd of dadosOBD2) {
          // Determinar estado da ignição
          let ignicaoTexto = 'N/A';
          if (obd.ignicao !== null && obd.ignicao !== undefined) {
            if (!obd.ignicao) {
              ignicaoTexto = 'Desligado';
            } else if (obd.velocidade !== null && obd.velocidade > 5) {
              ignicaoTexto = 'Em Movimento';
            } else if (obd.velocidade !== null && obd.velocidade <= 5) {
              ignicaoTexto = 'Ocioso';
            } else {
              ignicaoTexto = 'Ligado';
            }
          }
          csvContent += `${formatDateTime(obd.timestamp)},${ignicaoTexto},${obd.rpm || ''},${obd.temperatura_motor || ''},${obd.nivel_combustivel || ''},${obd.odometro_embarcado ? Math.round(obd.odometro_embarcado) : ''},${obd.hora_motor_embarcada ? Math.round(obd.hora_motor_embarcada) : ''},${obd.percentual_bateria || ''},${obd.tensao_bateria ? obd.tensao_bateria.toFixed(2) : ''}\n`;
        }
        csvContent += '\n';
        totalRegistros += dadosOBD2.length;
      }
    }

    // ============ MÓDULO: ALARMES ============
    if (temModulo('alarmes')) {
      // Construir filtro de tipo de alarme
      const whereAlarme = {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      };

      // Filtrar por tipo de alarme se especificado
      if (tipoAlarme) {
        whereAlarme.tipo_alarme = { contains: tipoAlarme, mode: 'insensitive' };
      }

      const alarmes = await prisma.alarme.findMany({
        where: whereAlarme,
        orderBy: { timestamp: 'asc' }
      });

      if (alarmes.length > 0) {
        csvContent += '\n\n';
        csvContent += '[ALARMES]\n';
        csvContent += 'Data/Hora,Tipo,Severidade,Descricao,Latitude,Longitude,Resolvido\n';

        for (const alarme of alarmes) {
          csvContent += `${formatDateTime(alarme.timestamp)},${alarme.tipo_alarme},${alarme.severidade},${(alarme.descricao || '').replace(/,/g, ';')},${alarme.latitude || ''},${alarme.longitude || ''},${alarme.resolvido ? 'Sim' : 'Nao'}\n`;
        }
        csvContent += '\n';
        totalRegistros += alarmes.length;
      }
    }

    // ============ MÓDULO: HISTORICO RASTREADORES ============
    if (temModulo('rastreadores')) {
      const historicoRastreadores = await buscarHistoricoRastreadores(
        dispositivo.veiculo_id,
        inicio,
        fim
      );

      if (historicoRastreadores.length > 0) {
        csvContent += '\n\n';
        csvContent += '[HISTORICO RASTREADORES]\n';
        csvContent += 'IMEI,Tipo,Data Vinculo,Data Desvinculo,Status\n';

        for (const rastreador of historicoRastreadores) {
          const dataVinculo = rastreador.data_vinculo ? formatDateTime(rastreador.data_vinculo) : 'N/A';
          const dataDesvinculo = rastreador.data_desvinculo ? formatDateTime(rastreador.data_desvinculo) : 'Atual';
          const status = rastreador.ativo ? 'Ativo' : 'Inativo';
          csvContent += `${rastreador.imei},${rastreador.tipo},${dataVinculo},${dataDesvinculo},${status}\n`;
        }
        csvContent += '\n';
        totalRegistros += historicoRastreadores.length;
      }
    }

    if (totalRegistros === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum registro encontrado no período selecionado'
      });
    }

    // Calcular estatísticas para o cabeçalho
    let distanciaTotal = 0;
    let distanciaMovimento = 0;
    let tempoMovimentoTotal = 0;
    let tempoOciosoTotal = 0;
    let tempoParadoTotal = 0;
    let excessosVelocidade = 0;
    let maxVelocidadeRota = 0;

    // Buscar todas as localizações para cálculo
    let todasLocalizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    // Aplicar filtro de status se selecionado
    if (statusFiltroAtivo) {
      todasLocalizacoes = filtrarLocalizacoesPorStatus(todasLocalizacoes, statusFiltro, dispositivo);
    }

    const todosOBD2 = await prisma.dadosOBD2.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    // Cache persistente: consulta limites com precisão do banco
    let limitesViaStats = new Map();
    if (todasLocalizacoes.length > 0) {
      try {
        console.log(`[CSV Stats] Consultando limites para ${todasLocalizacoes.length} pontos (cache persistente)...`);
        const pontosStats = todasLocalizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));
        limitesViaStats = await velocidadeViaService.obterLimitesEmLote(pontosStats);
      } catch (e) {
        console.log('[CSV Stats] Erro ao consultar limites:', e.message);
      }
    }

    if (todasLocalizacoes.length > 1) {
      for (let i = 1; i < todasLocalizacoes.length; i++) {
        const loc = todasLocalizacoes[i];
        const locAnterior = todasLocalizacoes[i - 1];

        const dist = calcularDistancia(
          locAnterior.latitude, locAnterior.longitude,
          loc.latitude, loc.longitude
        );
        const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

        distanciaTotal += dist;

        // Buscar OBD2 correspondente
        const obd2 = todosOBD2.find(o => {
          const diff = Math.abs(new Date(o.timestamp) - new Date(loc.timestamp));
          return diff < 60000;
        });

        // Lógica diferenciada por tipo de dispositivo
        let motorLigado = false;
        let motorDesligado = false;

        if (dispositivo.tipo === 'XT40_4F') {
          // XT40_4F: Usa ignição virtual (baseada na tensão da bateria)
          motorLigado = loc.ignicao === true && loc.velocidade === 0;
          motorDesligado = loc.ignicao === false && loc.velocidade === 0;
        } else if (dispositivo.tipo === 'XT40_OBD2') {
          // XT40_OBD2: Prioridade: RPM > Tensao > Estado ignicao
          const temRPM = obd2 && obd2.rpm !== null && obd2.rpm !== undefined && obd2.rpm > 0;
          const temTensao = obd2 && obd2.tensao_principal !== null && obd2.tensao_principal !== undefined;

          if (loc.velocidade === 0) {
            if (temRPM) {
              // RPM disponivel - motor ligado se RPM >= 500
              motorLigado = obd2.rpm >= 500;
              motorDesligado = obd2.rpm < 500;
            } else if (temTensao) {
              // Sem RPM, usar tensao - motor ligado se tensao > 13.5V
              motorLigado = obd2.tensao_principal > 13.5;
              motorDesligado = obd2.tensao_principal <= 13.5;
            } else {
              // Sem RPM nem tensao - usar estado de ignicao
              motorLigado = loc.ignicao === true;
              motorDesligado = loc.ignicao === false;
            }
          }
        } else {
          // Outros dispositivos: usar estado de ignição
          motorLigado = loc.ignicao === true && loc.velocidade === 0;
          motorDesligado = loc.ignicao === false && loc.velocidade === 0;
        }

        if (loc.velocidade > 0) {
          distanciaMovimento += dist;
          tempoMovimentoTotal += tempoMinutos;

          // Verificar velocidade máxima
          if (loc.velocidade > maxVelocidadeRota) {
            maxVelocidadeRota = loc.velocidade;
          }

          // Verificar excesso de velocidade baseado no limite REAL da via
          const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
          const infoVia = limitesViaStats.get(cacheKey) || { limite: 60 };
          if (loc.velocidade > infoVia.limite) {
            excessosVelocidade++;
          }
        } else if (motorLigado) {
          tempoOciosoTotal += tempoMinutos;
        } else if (motorDesligado) {
          tempoParadoTotal += tempoMinutos;
        }
      }
    }

    // Montar texto de filtros aplicados
    let filtrosTexto = [];
    if (aplicarCorrecao) filtrosTexto.push('GPS Corrigido (OSRM)');
    if (estado) filtrosTexto.push(`Estado: ${estado}`);
    if (velocidadeMin !== null) filtrosTexto.push(`Vel. Mín: ${velocidadeMin} km/h`);
    if (velocidadeMax !== null) filtrosTexto.push(`Vel. Máx: ${velocidadeMax} km/h`);
    if (filtrarSoExcessos) filtrosTexto.push('Apenas excessos');
    if (tipoAlarme) filtrosTexto.push(`Alarme: ${tipoAlarme}`);

    // ============ CALCULAR MÉTRICAS ADICIONAIS (CSV) ============
    // Km por dia
    const kmPorDiaCSV = new Map();
    if (todasLocalizacoes.length > 1) {
      for (let i = 1; i < todasLocalizacoes.length; i++) {
        const loc = todasLocalizacoes[i];
        const locAnterior = todasLocalizacoes[i - 1];
        const dist = calcularDistancia(locAnterior.latitude, locAnterior.longitude, loc.latitude, loc.longitude);
        const dia = new Date(loc.timestamp).toLocaleDateString('pt-BR');
        kmPorDiaCSV.set(dia, (kmPorDiaCSV.get(dia) || 0) + dist);
      }
    }

    // Score de Condução
    let scoreConducaoCSV = 100;
    if (todasLocalizacoes.length > 0) {
      const penalizacaoExcessos = Math.min(40, excessosVelocidade * 1);
      scoreConducaoCSV -= penalizacaoExcessos;
      const velocidadeMediaCSV = todasLocalizacoes.filter(l => l.velocidade > 0).length > 0 ?
        Math.round(todasLocalizacoes.filter(l => l.velocidade > 0).reduce((a, l) => a + l.velocidade, 0) / todasLocalizacoes.filter(l => l.velocidade > 0).length) : 0;
      if (velocidadeMediaCSV > 100) scoreConducaoCSV -= 15;
      else if (velocidadeMediaCSV > 90) scoreConducaoCSV -= 10;
      else if (velocidadeMediaCSV > 80) scoreConducaoCSV -= 5;
      const tempoTotal = tempoMovimentoTotal + tempoOciosoTotal + tempoParadoTotal;
      if (tempoTotal > 0 && (tempoOciosoTotal / tempoTotal) > 0.5) scoreConducaoCSV -= 10;
      else if (tempoTotal > 0 && (tempoOciosoTotal / tempoTotal) > 0.3) scoreConducaoCSV -= 5;
      scoreConducaoCSV = Math.max(0, Math.min(100, scoreConducaoCSV));
    }
    const scoreTextoCSV = scoreConducaoCSV >= 80 ? 'BOM' : scoreConducaoCSV >= 60 ? 'REGULAR' : 'ATENCAO';

    // Consumo estimado
    const consumoMedioCSV = 10; // L/100km
    const consumoEstimadoCSV = (distanciaTotal * consumoMedioCSV) / 100;

    // Média diária
    const diasComMovimento = kmPorDiaCSV.size;
    const mediaDiariaCSV = diasComMovimento > 0 ? distanciaTotal / diasComMovimento : 0;

    // Adicionar cabeçalho do relatório com estatísticas em formato de tabela
    let header = '';

    // TABELA 1: INFORMACOES DO VEICULO
    header += '[INFORMACOES DO VEICULO]\n';
    header += 'Campo,Valor\n';
    header += `Veiculo,${(dispositivo.veiculo || 'N/A').replace(/,/g, ';')}\n`;
    header += `Placa,${dispositivo.placa || 'N/A'}\n`;
    header += `IMEI,${dispositivo.imei}\n`;
    header += `Tipo,${dispositivo.tipo || 'N/A'}\n`;
    if (filtroMotoristaAtivo && motoristasTextoCSV) {
      header += `Motorista(s),${motoristasTextoCSV.replace(/,/g, ';')}\n`;
    }
    header += `Periodo,${formatDateTime(inicio)} ate ${formatDateTime(fim)}\n`;
    header += `Total de Registros,${totalRegistros}\n`;
    header += `Gerado em,${formatDateTime(new Date())}\n`;
    header += `Filtros,${filtrosTexto.length > 0 ? filtrosTexto.join(' | ').replace(/,/g, ';') : 'Nenhum'}\n`;
    header += `Tags do Veiculo,${tagsVeiculo.replace(/,/g, ';')}\n`;
    if (statusFiltroAtivo && statusFiltradoTexto) {
      header += `Status Filtrado,${statusFiltradoTexto}\n`;
    }
    // Filtros Avançados
    if (filtroGeofenceAtivo && geofencesTexto) {
      header += `Cercas Filtradas,${geofencesTexto.replace(/,/g, ';')}\n`;
    }
    if (filtroAlarmeAtivo && alarmesTexto) {
      header += `Tipos de Alarme,${alarmesTexto.replace(/,/g, ';')}\n`;
    }
    if (filtroViagemAtivo && viagensTexto) {
      header += `Filtro Viagens,${viagensTexto.replace(/,/g, ';')}\n`;
    }
    if (filtroMultaAtivo && multasTexto) {
      header += `Filtro Multas,${multasTexto.replace(/,/g, ';')}\n`;
    }
    if (velocidadeTexto) {
      header += `Filtro Velocidade,${velocidadeTexto.replace(/,/g, ';')}\n`;
    }
    if (filtroPerformanceAtivo && performanceTexto) {
      header += `Filtro Performance,${performanceTexto.replace(/,/g, ';')}\n`;
    }
    header += '\n\n';

    // TABELA 2: RESUMO ESTATISTICO
    header += '[RESUMO ESTATISTICO]\n';
    header += 'Metrica,Valor\n';
    header += `Distancia Total,${distanciaTotal.toFixed(2)} km\n`;
    header += `Distancia em Movimento,${distanciaMovimento.toFixed(2)} km\n`;
    header += `Media Diaria,${mediaDiariaCSV.toFixed(2)} km/dia\n`;
    header += `Tempo em Movimento,${formatarTempoCSV(tempoMovimentoTotal)}\n`;
    header += `Tempo Ocioso,${formatarTempoCSV(tempoOciosoTotal)}\n`;
    header += `Tempo Parado,${formatarTempoCSV(tempoParadoTotal)}\n`;
    header += `Velocidade Maxima,${maxVelocidadeRota} km/h\n`;
    header += `Excessos de Velocidade,${excessosVelocidade} ocorrencias\n`;
    header += '\n\n';

    // TABELA 3: SCORE DE CONDUCAO
    header += '[SCORE DE CONDUCAO]\n';
    header += 'Metrica,Valor\n';
    header += `Pontuacao,${scoreConducaoCSV}/100\n`;
    header += `Classificacao,${scoreTextoCSV}\n`;
    header += `Penalizacao Excessos,-${Math.min(40, excessosVelocidade)} pts\n`;
    if (tempoOciosoTotal / (tempoMovimentoTotal + tempoOciosoTotal + tempoParadoTotal) > 0.3) {
      header += `Penalizacao Ociosidade,-5 a -10 pts\n`;
    }
    header += '\n\n';

    // TABELA 4: CONSUMO ESTIMADO
    header += '[CONSUMO ESTIMADO]\n';
    header += 'Metrica,Valor\n';
    header += `Consumo Medio,${consumoMedioCSV} L/100km\n`;
    header += `Consumo Total Estimado,${consumoEstimadoCSV.toFixed(1)} litros\n`;
    header += '\n\n';

    // TABELA 5: KM POR DIA
    header += '[KM POR DIA]\n';
    header += 'Data,Quilometragem\n';
    if (kmPorDiaCSV.size > 0) {
      for (const [dia, km] of kmPorDiaCSV.entries()) {
        header += `${dia},${km.toFixed(2)} km\n`;
      }
    } else {
      header += 'Sem dados,0 km\n';
    }
    header += '\n\n';

    csvContent = header + csvContent;

    // Configurar headers para download
    const filename = `historico_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Adicionar BOM para Excel reconhecer UTF-8
    res.send('\ufeff' + csvContent);

  } catch (error) {
    console.error('[Exportar CSV] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar CSV', erro: error.message });
  }
});

// ============ EXPORTAR PDF ============

/**
 * GET /api/exportar/:imei/pdf
 * Exporta histórico do veículo em formato PDF MODULAR
 *
 * Query params:
 * - modulos: string - lista separada por vírgula dos módulos a incluir
 *   Valores: resumo, score, consumo, kmDia, excessos, paradas, viagens, obd2, alarmes, localizacoes
 * - corrigido: boolean (default: true) - usar dados corrigidos pelo OSRM
 * - estado: string - filtrar por estado (movimento, ocioso, parado, ligado)
 * - velMin: number - velocidade mínima
 * - velMax: number - velocidade máxima
 * - soExcessos: boolean - apenas excessos de velocidade
 * - tipoAlarme: string - filtrar por tipo de alarme
 * Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/pdf', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      modulos = 'resumo,score,consumo,kmDia,excessos,paradas,viagens,obd2,alarmes', // Padrão: todos menos localizacoes
      incluirLocalizacoes = 'true',
      incluirOBD2 = 'true',
      incluirAlarmes = 'true',
      incluirEstatisticas = 'true',
      corrigido = 'true',
      estado = '',
      velMin = '',
      velMax = '',
      soExcessos = 'false',
      tipoAlarme = '',
      motoristaIds = '', // IDs dos motoristas filtrados
      mostrarMotoristas = '', // 'todos' para mostrar todos os motoristas vinculados
      tagIds = '', // IDs das tags filtradas (separados por vírgula)
      statusFiltro = '', // Status filtrado (movimento, ocioso, parado, offline)
      // Filtros Avancados
      geofenceIds = '', tiposAlarme = '',
      incluirViagens = '', // Checkbox simples
      multaStatus = '', multaGravidade = '',
      velAcima80 = '', velAcima100 = '', velAcima120 = '',
      scoreMin = '', scoreMax = '', excessosMax = '', ociosoMax = '', kmMinRodado = ''
    } = req.query;

    // Extrair filtro de tags
    // Se mais de 50 tags forem enviadas, ignorar filtro (significa "Todos" selecionado)
    const tagIdsFiltroRaw = tagIds
      ? tagIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const tagIdsFiltro = tagIdsFiltroRaw.length > 50 ? [] : tagIdsFiltroRaw;
    const filtroTagAtivo = tagIdsFiltro.length > 0;

    // Extrair filtro de status
    const statusFiltroAtivo = statusFiltro && statusFiltro !== 'todos';

    // Extrair filtro de motorista
    const motoristaIdsFiltro = motoristaIds
      ? motoristaIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const mostrarTodosMotoristas = mostrarMotoristas === 'todos';
    const filtroMotoristaAtivo = motoristaIdsFiltro.length > 0 || mostrarTodosMotoristas;

    // Extrair filtros avançados (PDF)
    const geofenceIdsFiltro = geofenceIds ? geofenceIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
    const filtroGeofenceAtivo = geofenceIdsFiltro.length > 0;
    const tiposAlarmeFiltro = tiposAlarme ? tiposAlarme.split(',').filter(t => t.trim()) : [];
    const filtroAlarmeAtivo = tiposAlarmeFiltro.length > 0;
    const filtroViagemAtivo = incluirViagens === 'true';
    const filtroMultaAtivo = multaStatus || multaGravidade;
    const filtroVelocidadeAvancado = velAcima80 === 'true' || velAcima100 === 'true' || velAcima120 === 'true';
    const filtroPerformanceAtivo = scoreMin || scoreMax || excessosMax || ociosoMax || kmMinRodado;

    // Parsear módulos selecionados
    const modulosSelecionados = modulos.split(',').map(m => m.trim().toLowerCase());
    const temModulo = (nome) => modulosSelecionados.includes(nome.toLowerCase());

    console.log('[PDF Modular] Módulos selecionados:', modulosSelecionados);

    // Converter filtros numéricos
    const velocidadeMin = velMin ? parseFloat(velMin) : null;
    const velocidadeMax = velMax ? parseFloat(velMax) : null;
    const filtrarSoExcessos = soExcessos === 'true';
    const aplicarCorrecao = corrigido === 'true' && gpsFilterService !== null;

    // Buscar dispositivo com tags do veículo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        veiculo_rel: {
          include: {
            tags: {
              include: {
                tag: { select: { id: true, nome: true, cor: true } }
              }
            }
          }
        }
      }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Extrair tags do veículo
    const tagsVeiculo = dispositivo.veiculo_rel?.tags?.map(vt => vt.tag.nome).join(', ') || 'Nenhuma';

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Criar documento PDF
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Relatório - ${dispositivo.placa || imei}`,
        Author: 'Sistema de Rastreamento',
        Subject: 'Histórico do Veículo'
      }
    });

    // Configurar headers para download
    const filename = `relatorio_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    doc.pipe(res);

    // ============ CABEÇALHO ============
    doc.fontSize(20).font('Helvetica-Bold').text('RELATÓRIO DE HISTÓRICO', { align: 'center' });
    doc.moveDown(0.5);

    // Linha decorativa
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#667eea');
    doc.moveDown(0.5);

    // ============ BUSCAR MOTORISTA(S) VINCULADO(S) NO PERÍODO ============
    // Busca motoristas se: filtro específico OU "todos os motoristas"
    let motoristasVinculados = [];

    if (filtroMotoristaAtivo) {
      try {
        // Construir filtro base
        const whereHistorico = {
          dispositivo_id: dispositivo.id,
          OR: [{ fim: null }, { fim: { gte: inicio } }],
          inicio: { lte: fim }
        };

        // Se não é "todos", filtrar por IDs específicos
        if (!mostrarTodosMotoristas && motoristaIdsFiltro.length > 0) {
          whereHistorico.motorista_id = { in: motoristaIdsFiltro };
        }

        const historicoMotoristas = await prisma.historicoMotorista.findMany({
          where: whereHistorico,
          include: {
            motorista: {
              select: { id: true, nome: true, cnh_categoria: true }
            }
          },
          orderBy: { inicio: 'asc' }
        });

        // Mostrar CADA vínculo separadamente (não consolidar por motorista)
        motoristasVinculados = historicoMotoristas
          .filter(h => h.motorista)
          .map(h => ({
            ...h.motorista,
            periodoInicio: h.inicio,
            periodoFim: h.fim,
            fonte: 'vinculacao'
          }))
          .sort((a, b) => new Date(a.periodoInicio) - new Date(b.periodoInicio));
      } catch (e) {
        console.log('[PDF] Erro ao buscar motoristas:', e.message);
      }
    }

    // Função helper para encontrar motorista em um timestamp específico
    const encontrarMotoristaPorTimestamp = (timestamp) => {
      const ts = new Date(timestamp);
      for (const m of motoristasVinculados) {
        const inicio = new Date(m.periodoInicio);
        const fim = m.periodoFim ? new Date(m.periodoFim) : new Date(); // Se não tem fim, ainda está ativo
        if (ts >= inicio && ts <= fim) {
          return m.nome;
        }
      }
      return null; // Não identificado
    };

    // ============ BUSCAR NOMES DAS TAGS FILTRADAS (PDF) ============
    let tagsFiltradasPDF = [];
    if (filtroTagAtivo) {
      try {
        tagsFiltradasPDF = await prisma.tag.findMany({
          where: { id: { in: tagIdsFiltro } },
          select: { id: true, nome: true }
        });
      } catch (e) {
        console.log('[PDF] Erro ao buscar tags filtradas:', e.message);
      }
    }
    const tagsFiltradasTextoPDF = tagsFiltradasPDF.map(t => t.nome).join(', ') || '';

    // ============ TEXTO DO STATUS FILTRADO (PDF) ============
    const statusTextoMapPDF = {
      'movimento': 'Em Movimento',
      'ocioso': 'Ocioso (motor ligado)',
      'parado': 'Parado (motor desligado)',
      'offline': 'Offline'
    };
    const statusFiltradoTextoPDF = statusFiltroAtivo ? (statusTextoMapPDF[statusFiltro] || statusFiltro) : '';

    // ============ BUSCAR DADOS DOS FILTROS AVANÇADOS (PDF) ============
    let geofencesFiltradasPDF = [];
    if (filtroGeofenceAtivo) {
      try {
        geofencesFiltradasPDF = await prisma.geofence.findMany({
          where: { id: { in: geofenceIdsFiltro } },
          select: { id: true, nome: true, raio_metros: true }
        });
      } catch (e) {
        console.log('[PDF] Erro ao buscar cercas:', e.message);
      }
    }
    const geofencesTextoPDF = geofencesFiltradasPDF.map(g => `${g.nome} (${g.raio_metros}m)`).join(', ') || '';

    // Textos dos filtros avançados
    const alarmesTextoMapPDF = {
      'excesso_velocidade': 'Excesso Vel.', 'sos': 'SOS', 'bateria_baixa': 'Bateria',
      'desconexao': 'Desconexão', 'geofence_entrada': 'Entrada Cerca',
      'geofence_saida': 'Saída Cerca', 'ignicao': 'Ignição', 'vibracao': 'Vibração'
    };
    const alarmesTextoPDF = tiposAlarmeFiltro.map(t => alarmesTextoMapPDF[t] || t).join(', ') || '';

    // Informações do veículo
    doc.fontSize(12).font('Helvetica-Bold').text('Informações do Veículo');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'}`);
    doc.text(`Placa: ${dispositivo.placa || 'N/A'}`);
    doc.text(`IMEI: ${dispositivo.imei}`);
    doc.text(`Tipo: ${dispositivo.tipo || 'N/A'}`);
    doc.text(`Status: ${dispositivo.status === 'online' ? 'Online' : 'Offline'}`);
    doc.text(`Tags do Veículo: ${tagsVeiculo}`);
    if (statusFiltroAtivo && statusFiltradoTextoPDF) {
      doc.font('Helvetica-Bold').fillColor('#059669');
      doc.text(`Status Filtrado: ${statusFiltradoTextoPDF}`);
      doc.font('Helvetica').fillColor('#000');
    }

    // Mostrar filtros avançados no PDF
    if (filtroGeofenceAtivo && geofencesTextoPDF) {
      doc.font('Helvetica-Bold').fillColor('#eab308');
      doc.text(`Cercas: ${geofencesTextoPDF}`);
      doc.font('Helvetica').fillColor('#000');
    }
    if (filtroAlarmeAtivo && alarmesTextoPDF) {
      doc.font('Helvetica-Bold').fillColor('#ef4444');
      doc.text(`Alarmes: ${alarmesTextoPDF}`);
      doc.font('Helvetica').fillColor('#000');
    }
    if (filtroViagemAtivo) {
      doc.font('Helvetica-Bold').fillColor('#6366f1');
      doc.text('Viagens: Incluidas (todas do periodo)');
      doc.font('Helvetica').fillColor('#000');
    }
    if (filtroMultaAtivo) {
      doc.font('Helvetica-Bold').fillColor('#ec4899');
      doc.text(`Multas: ${multaStatus || ''} ${multaGravidade || ''}`);
      doc.font('Helvetica').fillColor('#000');
    }
    if (filtroVelocidadeAvancado || velocidadeMin || velocidadeMax) {
      doc.font('Helvetica-Bold').fillColor('#f59e0b');
      const partes = [];
      if (velocidadeMin || velocidadeMax) partes.push(`${velocidadeMin || 0}-${velocidadeMax || '∞'} km/h`);
      if (velAcima80 === 'true') partes.push('>80');
      if (velAcima100 === 'true') partes.push('>100');
      if (velAcima120 === 'true') partes.push('>120');
      doc.text(`⚡ Velocidade: ${partes.join(', ')}`);
      doc.font('Helvetica').fillColor('#000');
    }
    if (filtroPerformanceAtivo) {
      doc.font('Helvetica-Bold').fillColor('#10b981');
      const partes = [];
      if (scoreMin || scoreMax) partes.push(`Score: ${scoreMin || 0}-${scoreMax || 100}`);
      if (excessosMax) partes.push(`Max exc: ${excessosMax}`);
      if (ociosoMax) partes.push(`Max ocioso: ${ociosoMax}min`);
      doc.text(`Performance: ${partes.join(', ')}`);
      doc.font('Helvetica').fillColor('#000');
    }

    // Mostrar motorista(s) vinculado(s) com período - APENAS se filtro ativo
    if (filtroMotoristaAtivo && motoristasVinculados.length > 0) {
      doc.font('Helvetica-Bold').fillColor('#1565c0');
      if (motoristasVinculados.length === 1) {
        // Um único motorista - formato com período
        const m = motoristasVinculados[0];
        const formatarPeriodo = (data) => {
          if (!data) return '';
          const d = new Date(data);
          return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        };
        const inicioStr = formatarPeriodo(m.periodoInicio);
        const fimStr = m.periodoFim ? formatarPeriodo(m.periodoFim) : 'atual';
        doc.text(`Motorista: ${m.nome}${m.cnh_categoria ? ` (CNH ${m.cnh_categoria})` : ''} [${inicioStr} até ${fimStr}]`);
      } else {
        // Múltiplos motoristas - mostrar com período COMPLETO (data + hora) de cada
        doc.text(`Motorista(s) no período: ${motoristasVinculados.length}`);
        doc.font('Helvetica').fillColor('#333').fontSize(8);
        motoristasVinculados.forEach(m => {
          const formatarPeriodo = (data) => {
            if (!data) return '';
            const d = new Date(data);
            return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          };
          const inicioStr = formatarPeriodo(m.periodoInicio);
          const fimStr = m.periodoFim ? formatarPeriodo(m.periodoFim) : 'atual';
          const periodoStr = inicioStr ? `${inicioStr} até ${fimStr}` : '';
          doc.text(`  • ${m.nome}${m.cnh_categoria ? ` (${m.cnh_categoria})` : ''}${periodoStr ? ` [${periodoStr}]` : ''}`);
        });
      }
      doc.font('Helvetica').fillColor('#000').fontSize(10);
    }
    // Se filtro não ativo, não mostra nada sobre motorista

    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica-Oblique').fillColor('#666');
    doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
    doc.text(`Gerado em: ${formatDateTime(new Date())}`);

    // Mostrar filtros aplicados
    let filtrosTexto = [];
    if (aplicarCorrecao) filtrosTexto.push('GPS Corrigido (OSRM)');
    if (estado) filtrosTexto.push(`Estado: ${estado}`);
    if (velocidadeMin !== null) filtrosTexto.push(`Vel. Mín: ${velocidadeMin} km/h`);
    if (velocidadeMax !== null) filtrosTexto.push(`Vel. Máx: ${velocidadeMax} km/h`);
    if (filtrarSoExcessos) filtrosTexto.push('Apenas excessos');
    if (tipoAlarme) filtrosTexto.push(`Alarme: ${tipoAlarme}`);

    if (filtrosTexto.length > 0) {
      doc.text(`Filtros: ${filtrosTexto.join(' | ')}`);
    }

    doc.fillColor('#000');
    doc.moveDown();

    // ============ ESTATÍSTICAS ============
    // Módulos: resumo, score, consumo, kmDia, excessos, paradas
    const precisaEstatisticas = temModulo('resumo') || temModulo('score') || temModulo('consumo') ||
                                 temModulo('kmdia') || temModulo('excessos') || temModulo('paradas');
    console.log(`[PDF] precisaEstatisticas=${precisaEstatisticas}, modulos:`, modulosSelecionados);
    if (precisaEstatisticas) {
      console.log('[PDF] Buscando dados para estatísticas...');
      // Buscar dados para estatísticas
      let localizacoes = await prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });

      // Aplicar filtro de status se selecionado
      if (statusFiltroAtivo) {
        const totalAntes = localizacoes.length;
        localizacoes = filtrarLocalizacoesPorStatus(localizacoes, statusFiltro, dispositivo);
        console.log(`[PDF] Filtro status '${statusFiltro}': ${totalAntes} -> ${localizacoes.length} registros`);
      }

      // Aplicar correção GPS (OSRM) para ter rota realista que segue as ruas
      let localizacoesCorrigidas = localizacoes;
      if (aplicarCorrecao && gpsFilterService && localizacoes.length > 1) {
        console.log(`[PDF] Aplicando correção OSRM em ${localizacoes.length} pontos para rota realista...`);
        try {
          const pontosParaCorrigir = localizacoes.map(l => ({
            latitude: l.latitude,
            longitude: l.longitude,
            velocidade: l.velocidade,
            direcao: l.direcao,
            ignicao: l.ignicao,
            timestamp: l.timestamp
          }));

          const resultado = await gpsFilterService.processarRotaCompleta(pontosParaCorrigir, {
            usarKalman: true,
            usarHampel: true,
            usarInterpolacao: true, // Interpolar para rota mais suave
            usarOSRM: true          // OSRM para seguir ruas reais
          });

          if (resultado && resultado.pontos && resultado.pontos.length > 0) {
            localizacoesCorrigidas = resultado.pontos;
            console.log(`[PDF] Correção OSRM aplicada: ${localizacoes.length} -> ${localizacoesCorrigidas.length} pontos`);
          }
        } catch (e) {
          console.warn('[PDF] Erro ao aplicar correção OSRM:', e.message);
          // Continuar com dados originais
        }
      }

      const dadosOBD2 = await prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        }
      });

      const alarmes = await prisma.alarme.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        }
      });

      // Calcular estatísticas
      let distanciaTotal = 0;
      let distanciaMovimento = 0;
      let velocidadeMax = 0;
      let velocidadeMedia = 0;
      let tempoMovimentoTotal = 0;
      let tempoOciosoTotal = 0;
      let tempoParadoTotal = 0;
      let excessosVelocidade = 0;
      let detalhesExcessos = []; // Coletar detalhes dos excessos com nome da via

      // Detectar paradas significativas (>5 minutos no mesmo local)
      let paradasSignificativas = [];
      let paradaAtual = null;
      const TEMPO_MINIMO_PARADA = 5; // minutos
      const DISTANCIA_MESMA_PARADA = 0.1; // km (100m)

      // Cache persistente: consulta limites com precisão do banco
      let limitesViaPDF = new Map();
      if (localizacoes.length > 0) {
        try {
          console.log(`[PDF Stats] Consultando limites para ${localizacoes.length} pontos (cache persistente)...`);
          const pontosPDF = localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));
          limitesViaPDF = await velocidadeViaService.obterLimitesEmLote(pontosPDF);
        } catch (e) {
          console.log('[PDF Stats] Erro ao consultar limites:', e.message);
        }
      }

      if (localizacoes.length > 1) {
        for (let i = 1; i < localizacoes.length; i++) {
          const loc = localizacoes[i];
          const locAnterior = localizacoes[i - 1];

          const dist = calcularDistancia(
            locAnterior.latitude, locAnterior.longitude,
            loc.latitude, loc.longitude
          );
          const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

          distanciaTotal += dist;

          // Buscar OBD2 correspondente (se houver)
          const obd2 = dadosOBD2.find(o => {
            const diff = Math.abs(new Date(o.timestamp) - new Date(loc.timestamp));
            return diff < 60000;
          });

          // Lógica diferenciada por tipo de dispositivo
          let motorLigado = false;
          let motorDesligado = false;

          if (dispositivo.tipo === 'XT40_4F') {
            // XT40_4F: Usa ignição virtual (baseada na tensão da bateria)
            motorLigado = loc.ignicao === true && loc.velocidade === 0;
            motorDesligado = loc.ignicao === false && loc.velocidade === 0;
          } else if (dispositivo.tipo === 'XT40_OBD2') {
            // XT40_OBD2: Prioridade: RPM > Tensao > Estado ignicao
            const temRPM = obd2 && obd2.rpm !== null && obd2.rpm !== undefined && obd2.rpm > 0;
            const temTensao = obd2 && obd2.tensao_principal !== null && obd2.tensao_principal !== undefined;

            if (loc.velocidade === 0) {
              if (temRPM) {
                // RPM disponivel - motor ligado se RPM >= 500
                motorLigado = obd2.rpm >= 500;
                motorDesligado = obd2.rpm < 500;
              } else if (temTensao) {
                // Sem RPM, usar tensao - motor ligado se tensao > 13.5V
                motorLigado = obd2.tensao_principal > 13.5;
                motorDesligado = obd2.tensao_principal <= 13.5;
              } else {
                // Sem RPM nem tensao - usar estado de ignicao
                motorLigado = loc.ignicao === true;
                motorDesligado = loc.ignicao === false;
              }
            }
          } else {
            // Outros dispositivos: usar estado de ignição
            motorLigado = loc.ignicao === true && loc.velocidade === 0;
            motorDesligado = loc.ignicao === false && loc.velocidade === 0;
          }

          // Separar por estado
          if (loc.velocidade > 0) {
            // Em movimento
            distanciaMovimento += dist;
            tempoMovimentoTotal += tempoMinutos;

            // Verificar excesso de velocidade baseado no limite REAL da via
            const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
            const infoVia = limitesViaPDF.get(cacheKey) || { limite: 60, nome: '' };
            if (loc.velocidade > infoVia.limite) {
              excessosVelocidade++;
              // Coletar detalhes do excesso
              if (!detalhesExcessos) detalhesExcessos = [];
              detalhesExcessos.push({
                timestamp: loc.timestamp,
                latitude: loc.latitude,
                longitude: loc.longitude,
                velocidade: loc.velocidade,
                limite: infoVia.limite,
                excesso: loc.velocidade - infoVia.limite,
                nomeVia: infoVia.nome || '',
                motorista: encontrarMotoristaPorTimestamp(loc.timestamp) // Motorista no momento do excesso
              });
            }
          } else if (motorLigado) {
            // Ocioso (motor ligado, parado)
            tempoOciosoTotal += tempoMinutos;
          } else if (motorDesligado) {
            // Parado (motor desligado)
            tempoParadoTotal += tempoMinutos;
          }

          // Detectar paradas significativas
          if (loc.velocidade === 0) {
            if (!paradaAtual) {
              // Início de uma nova parada
              paradaAtual = {
                inicio: loc.timestamp,
                fim: loc.timestamp,
                latitude: loc.latitude,
                longitude: loc.longitude,
                tempoMinutos: 0,
                motorLigado: motorLigado
              };
            } else {
              // Verificar se ainda é a mesma parada (mesmo local)
              const distParada = calcularDistancia(
                paradaAtual.latitude, paradaAtual.longitude,
                loc.latitude, loc.longitude
              );
              if (distParada < DISTANCIA_MESMA_PARADA) {
                // Mesma parada - atualizar fim
                paradaAtual.fim = loc.timestamp;
                paradaAtual.tempoMinutos += tempoMinutos;
              } else {
                // Nova localização - finalizar parada anterior se significativa
                if (paradaAtual.tempoMinutos >= TEMPO_MINIMO_PARADA) {
                  paradasSignificativas.push({ ...paradaAtual });
                }
                // Iniciar nova parada
                paradaAtual = {
                  inicio: loc.timestamp,
                  fim: loc.timestamp,
                  latitude: loc.latitude,
                  longitude: loc.longitude,
                  tempoMinutos: 0,
                  motorLigado: motorLigado
                };
              }
            }
          } else {
            // Em movimento - finalizar parada se existir
            if (paradaAtual && paradaAtual.tempoMinutos >= TEMPO_MINIMO_PARADA) {
              paradasSignificativas.push({ ...paradaAtual });
            }
            paradaAtual = null;
          }
        }

        // Finalizar última parada se existir
        if (paradaAtual && paradaAtual.tempoMinutos >= TEMPO_MINIMO_PARADA) {
          paradasSignificativas.push({ ...paradaAtual });
        }

        console.log(`[PDF] Paradas significativas encontradas: ${paradasSignificativas.length}`);

        const velocidades = localizacoes.filter(l => l.velocidade > 0).map(l => l.velocidade);
        if (velocidades.length > 0) {
          velocidadeMax = Math.max(...velocidades);
          velocidadeMedia = Math.round(velocidades.reduce((a, b) => a + b, 0) / velocidades.length);
        }
      }

      // Formatar tempos
      const formatarTempo = (minutos) => {
        const horas = Math.floor(minutos / 60);
        const mins = Math.round(minutos % 60);
        if (horas > 0) return `${horas}h ${mins}min`;
        return `${mins} min`;
      };

      // ============ MÓDULO: RESUMO ESTATÍSTICO ============
      if (temModulo('resumo')) {
        doc.fontSize(12).font('Helvetica-Bold').text('Resumo Estatístico');
        doc.moveDown(0.3);

        // Box de estatísticas (aumentado para caber mais dados)
        const statsY = doc.y;
        doc.rect(50, statsY, 495, 125).fillAndStroke('#f7fafc', '#e2e8f0');

        doc.fillColor('#000').fontSize(10).font('Helvetica');
        // Coluna 1 - Distâncias e Velocidades
        doc.text(`Distância Total: ${distanciaTotal.toFixed(2)} km`, 60, statsY + 10);
        doc.text(`Distância em Movimento: ${distanciaMovimento.toFixed(2)} km`, 60, statsY + 25);
        doc.text(`Velocidade Máxima: ${velocidadeMax} km/h`, 60, statsY + 40);
        doc.text(`Velocidade Média: ${velocidadeMedia} km/h`, 60, statsY + 55);
        doc.text(`Limite de Velocidade: Dinâmico por via`, 60, statsY + 70);

        // Coluna 2 - Tempos e contagens
        doc.text(`Tempo em Movimento: ${formatarTempo(tempoMovimentoTotal)}`, 300, statsY + 10);
        doc.text(`Tempo Ocioso: ${formatarTempo(tempoOciosoTotal)}`, 300, statsY + 25);
        doc.text(`Tempo Parado: ${formatarTempo(tempoParadoTotal)}`, 300, statsY + 40);
        doc.text(`Posições GPS: ${localizacoes.length}`, 300, statsY + 55);
        // Só mostrar Registros OBD2 se o dispositivo suporta OBD2
        const suportaOBD2PDF = supportsOBD2(dispositivo.tipo);
        if (suportaOBD2PDF) {
          doc.text(`Registros OBD2: ${dadosOBD2.length}`, 300, statsY + 70);
        }

        // Linha de alertas (destaque se houver excessos)
        if (excessosVelocidade > 0) {
          doc.fillColor('#c62828').font('Helvetica-Bold');
          doc.text(`Excessos de Velocidade: ${excessosVelocidade} ocorrências`, 60, statsY + 85);
          doc.fillColor('#000').font('Helvetica');
        } else {
          doc.text(`Excessos de Velocidade: 0`, 60, statsY + 85);
        }
        doc.text(`Alarmes: ${alarmes.length}`, 300, statsY + 85);

        // Tipo de dispositivo
        doc.fontSize(8).fillColor('#666');
        doc.text(`Tipo: ${dispositivo.tipo || 'N/A'}`, 60, statsY + 105);

        doc.y = statsY + 135;
        doc.moveDown();
      }

      // ============ RESUMO POR DIA + SCORE DE CONDUÇÃO + CONSUMO ============
      // Calcular km por dia
      const kmPorDia = new Map();
      if (localizacoes.length > 1) {
        for (let i = 1; i < localizacoes.length; i++) {
          const loc = localizacoes[i];
          const locAnterior = localizacoes[i - 1];
          const dist = calcularDistancia(
            locAnterior.latitude, locAnterior.longitude,
            loc.latitude, loc.longitude
          );
          const dia = new Date(loc.timestamp).toLocaleDateString('pt-BR');
          kmPorDia.set(dia, (kmPorDia.get(dia) || 0) + dist);
        }
      }

      // Calcular Score de Condução (0-100)
      // Fatores: excessos de velocidade, velocidade média, tempo ocioso
      let scoreConducao = 100;
      const totalPontos = localizacoes.length;
      if (totalPontos > 0) {
        // Penalizar excessos (cada excesso = -1 ponto, max -40)
        const penalizacaoExcessos = Math.min(40, excessosVelocidade * 1);
        scoreConducao -= penalizacaoExcessos;

        // Penalizar velocidade alta (média > 80 = penalização)
        if (velocidadeMedia > 100) scoreConducao -= 15;
        else if (velocidadeMedia > 90) scoreConducao -= 10;
        else if (velocidadeMedia > 80) scoreConducao -= 5;

        // Penalizar muito tempo ocioso (> 30% do tempo total = penalização)
        const tempoTotal = tempoMovimentoTotal + tempoOciosoTotal + tempoParadoTotal;
        if (tempoTotal > 0) {
          const percentualOcioso = (tempoOciosoTotal / tempoTotal) * 100;
          if (percentualOcioso > 50) scoreConducao -= 10;
          else if (percentualOcioso > 30) scoreConducao -= 5;
        }

        scoreConducao = Math.max(0, Math.min(100, scoreConducao));
      }

      // Estimar consumo (L/100km médio por tipo de veículo)
      // Pode ser melhorado com dados reais do OBD2
      const consumoMedio = 10; // L/100km (média de veículo leve)
      const consumoEstimadoLitros = (distanciaTotal * consumoMedio) / 100;

      // ============ MÓDULO: MÉTRICAS ADICIONAIS (Score, Consumo, Km/Dia) ============
      const temMetricasAdicionais = temModulo('score') || temModulo('consumo') || temModulo('kmdia');
      if (temMetricasAdicionais && (kmPorDia.size > 0 || scoreConducao < 100)) {
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Métricas Adicionais');
        doc.moveDown(0.3);

        const metricasY = doc.y;
        doc.rect(50, metricasY, 495, 85).fillAndStroke('#f0f7ff', '#667eea');

        let xOffset = 60; // Posição inicial

        // Score de Condução com cor
        if (temModulo('score')) {
          const scoreColor = scoreConducao >= 80 ? '#4caf50' :
                            scoreConducao >= 60 ? '#ff9800' : '#f44336';
          const scoreTexto = scoreConducao >= 80 ? 'BOM' :
                            scoreConducao >= 60 ? 'REGULAR' : 'ATENÇÃO';

          doc.fontSize(20).font('Helvetica-Bold').fillColor(scoreColor);
          doc.text(`${scoreConducao}`, xOffset, metricasY + 8, { width: 80, align: 'center' });
          doc.fontSize(9).font('Helvetica').fillColor('#333');
          doc.text(`Score (${scoreTexto})`, xOffset, metricasY + 32, { width: 80, align: 'center' });
          xOffset += 90;
        }

        // Consumo Estimado
        if (temModulo('consumo')) {
          doc.fontSize(16).font('Helvetica-Bold').fillColor('#1565c0');
          doc.text(`${consumoEstimadoLitros.toFixed(1)}L`, xOffset, metricasY + 8, { width: 80, align: 'center' });
          doc.fontSize(9).font('Helvetica').fillColor('#333');
          doc.text('Consumo Est.', xOffset, metricasY + 32, { width: 80, align: 'center' });
          xOffset += 90;
        }

        // Média diária
        if (temModulo('kmdia')) {
          const diasComMovimento = kmPorDia.size;
          const mediaDiaria = diasComMovimento > 0 ? distanciaTotal / diasComMovimento : 0;
          doc.fontSize(16).font('Helvetica-Bold').fillColor('#667eea');
          doc.text(`${mediaDiaria.toFixed(1)}`, xOffset, metricasY + 8, { width: 80, align: 'center' });
          doc.fontSize(9).font('Helvetica').fillColor('#333');
          doc.text('km/dia (média)', xOffset, metricasY + 32, { width: 80, align: 'center' });

          // Resumo por dia (tabela compacta)
          if (kmPorDia.size > 0 && kmPorDia.size <= 10) {
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
            doc.text('Resumo por Dia:', 340, metricasY + 8);
            doc.fontSize(7).font('Helvetica').fillColor('#555');
            let diaY = metricasY + 20;
            const diasOrdenados = Array.from(kmPorDia.entries()).sort((a, b) =>
              new Date(a[0].split('/').reverse().join('-')) - new Date(b[0].split('/').reverse().join('-'))
            );
            for (const [dia, km] of diasOrdenados.slice(0, 5)) {
              doc.text(`${dia}: ${km.toFixed(1)} km`, 340, diaY);
              diaY += 10;
            }
            if (diasOrdenados.length > 5) {
              doc.text(`... +${diasOrdenados.length - 5} dias`, 340, diaY);
            }
          }
        }

        doc.y = metricasY + 95;
        doc.moveDown(0.5);
      }

      // ============ MÓDULO: EXCESSOS DE VELOCIDADE ============
      console.log(`[PDF Excessos] Total de excessos detectados: ${detalhesExcessos ? detalhesExcessos.length : 0}`);
      if (temModulo('excessos') && detalhesExcessos && detalhesExcessos.length > 0) {
        console.log(`[PDF Excessos] Amostra: Via="${detalhesExcessos[0].nomeVia}", Vel=${detalhesExcessos[0].velocidade}, Limite=${detalhesExcessos[0].limite}`);

        // Nova página para excessos de velocidade
        doc.addPage();
        doc.rect(0, 0, 595, 50).fill('#c62828');
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
          .text('EXCESSOS DE VELOCIDADE', 50, 18, { align: 'center', width: 495 });
        doc.y = 70;

        // Resumo rápido
        const resumoY = doc.y;
        doc.rect(50, resumoY, 160, 50).fillAndStroke('#ffebee', '#c62828');
        doc.rect(220, resumoY, 160, 50).fillAndStroke('#fff3e0', '#ff9800');
        doc.rect(390, resumoY, 155, 50).fillAndStroke('#e3f2fd', '#2196f3');

        doc.fillColor('#c62828').fontSize(20).font('Helvetica-Bold')
          .text(detalhesExcessos.length.toString(), 50, resumoY + 8, { width: 160, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Total de Excessos', 50, resumoY + 32, { width: 160, align: 'center' });

        const maxExc = Math.max(...detalhesExcessos.map(e => e.excesso));
        doc.fillColor('#e65100').fontSize(18).font('Helvetica-Bold')
          .text(`+${maxExc}`, 220, resumoY + 8, { width: 160, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Maior Excesso (km/h)', 220, resumoY + 32, { width: 160, align: 'center' });

        const maxVel = Math.max(...detalhesExcessos.map(e => e.velocidade));
        doc.fillColor('#1565c0').fontSize(18).font('Helvetica-Bold')
          .text(`${maxVel}`, 390, resumoY + 8, { width: 155, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Velocidade Máxima', 390, resumoY + 32, { width: 155, align: 'center' });

        doc.y = resumoY + 60;

        // Tabela detalhada com TODOS os excessos (com coordenadas)
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Registro Detalhado dos Excessos');
        doc.fontSize(8).fillColor('#666').font('Helvetica')
          .text('(Coordenadas incluídas para identificação de radares/multas)');
        doc.moveDown(0.3);

        // LEGENDA DE CORES DA TABELA
        const legendaExcY = doc.y;
        doc.rect(50, legendaExcY, 495, 28).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#333');
        doc.text('LEGENDA:', 55, legendaExcY + 5);
        doc.rect(110, legendaExcY + 3, 12, 10).fill('#ffcdd2');
        doc.fillColor('#333').font('Helvetica').text('Excesso grave (>20 km/h)', 125, legendaExcY + 5);
        doc.rect(250, legendaExcY + 3, 12, 10).fill('#fff8e1');
        doc.fillColor('#333').text('Excesso moderado', 265, legendaExcY + 5);
        doc.fontSize(6).fillColor('#666');
        doc.text('Motorista: Nome do condutor vinculado no momento do excesso | N/I = Não Identificado (sem motorista vinculado no horário)', 55, legendaExcY + 17);
        doc.moveDown(0.5);

        const excTableY = doc.y;
        // Adicionada coluna Motorista para identificar condutor no momento do excesso
        const excColWidths = [70, 95, 75, 35, 35, 35, 150];
        const excHeaders = ['Data/Hora', 'Via', 'Motorista', 'Vel.', 'Lim.', 'Exc.', 'Coordenadas'];

        doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, excTableY, 495, 13).fill('#c62828');

        let xPos = 53;
        excHeaders.forEach((header, i) => {
          doc.text(header, xPos, excTableY + 3, { width: excColWidths[i], align: 'left' });
          xPos += excColWidths[i];
        });

        doc.fillColor('#333').font('Helvetica').fontSize(6);
        let yPos = excTableY + 15;

        // Ordenar por data (mais recentes primeiro) e mostrar até 50 registros
        const excessosOrdenados = [...detalhesExcessos].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const maxRegistros = 50;

        for (let i = 0; i < Math.min(excessosOrdenados.length, maxRegistros); i++) {
          const exc = excessosOrdenados[i];

          if (yPos > 760) {
            doc.addPage();
            // Repetir cabeçalho
            doc.rect(0, 0, 595, 30).fill('#c62828');
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#fff')
              .text('EXCESSOS DE VELOCIDADE (continuação)', 50, 8, { align: 'center', width: 495 });

            yPos = 45;
            doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
            doc.rect(50, yPos, 495, 13).fill('#c62828');
            xPos = 53;
            excHeaders.forEach((header, idx) => {
              doc.text(header, xPos, yPos + 3, { width: excColWidths[idx], align: 'left' });
              xPos += excColWidths[idx];
            });
            doc.fillColor('#333').font('Helvetica').fontSize(6);
            yPos += 15;
          }

          // Fundo alternado (vermelho claro para excessos graves)
          if (exc.excesso > 20) {
            doc.rect(50, yPos - 1, 495, 11).fill('#ffcdd2');
          } else if (i % 2 === 0) {
            doc.rect(50, yPos - 1, 495, 11).fill('#fff8e1');
          }
          doc.fillColor('#333');

          const nomeVia = exc.nomeVia && exc.nomeVia !== '' && exc.nomeVia !== 'N/A'
            ? (exc.nomeVia.length > 18 ? exc.nomeVia.substring(0, 15) + '...' : exc.nomeVia)
            : 'Via não identif.';

          // Motorista no momento do excesso
          const motoristaExc = exc.motorista
            ? (exc.motorista.length > 14 ? exc.motorista.substring(0, 11) + '...' : exc.motorista)
            : 'N/I';

          xPos = 53;
          const excRowData = [
            formatDateTime(exc.timestamp),
            nomeVia,
            motoristaExc,
            `${exc.velocidade}`,
            `${exc.limite}`,
            `+${exc.excesso}`,
            `${exc.latitude.toFixed(6)}, ${exc.longitude.toFixed(6)}`
          ];

          excRowData.forEach((data, idx) => {
            // Destacar excesso em vermelho
            if (idx === 5 && exc.excesso > 20) {
              doc.fillColor('#c62828').font('Helvetica-Bold');
            }
            doc.text(data, xPos, yPos + 1, { width: excColWidths[idx], align: 'left' });
            if (idx === 5) {
              doc.fillColor('#333').font('Helvetica');
            }
            xPos += excColWidths[idx];
          });

          yPos += 11;
        }

        if (excessosOrdenados.length > maxRegistros) {
          doc.moveDown(0.5);
          doc.fontSize(8).fillColor('#666');
          doc.text(`Mostrando ${maxRegistros} de ${excessosOrdenados.length} excessos. Use o CSV para ver todos.`, { align: 'center' });
        }

        doc.moveDown();
        doc.fillColor('#000');
      }

      // ============ MÓDULO: PARADAS SIGNIFICATIVAS ============
      console.log(`[PDF Paradas] Total de paradas: ${paradasSignificativas.length}`);
      if (temModulo('paradas') && paradasSignificativas.length > 0) {
        // Buscar nomes das vias para cada parada
        const velocidadeViaService = require('../services/velocidade-via.service');
        for (const parada of paradasSignificativas) {
          try {
            const infoVia = await velocidadeViaService.obterLimiteVelocidade(parada.latitude, parada.longitude);
            parada.nomeVia = infoVia.nome || 'Local não identificado';
          } catch (e) {
            parada.nomeVia = 'Local não identificado';
          }
        }

        // Nova página para paradas
        doc.addPage();
        doc.rect(0, 0, 595, 50).fill('#1565c0');
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
          .text('PARADAS SIGNIFICATIVAS', 50, 18, { align: 'center', width: 495 });
        doc.y = 70;

        // Resumo das paradas
        const resumoParY = doc.y;
        const tempoTotalParadas = paradasSignificativas.reduce((sum, p) => sum + p.tempoMinutos, 0);
        const maiorParada = Math.max(...paradasSignificativas.map(p => p.tempoMinutos));

        doc.rect(50, resumoParY, 160, 50).fillAndStroke('#e3f2fd', '#1565c0');
        doc.rect(220, resumoParY, 160, 50).fillAndStroke('#fff3e0', '#ff9800');
        doc.rect(390, resumoParY, 155, 50).fillAndStroke('#e8f5e9', '#4caf50');

        doc.fillColor('#1565c0').fontSize(20).font('Helvetica-Bold')
          .text(paradasSignificativas.length.toString(), 50, resumoParY + 8, { width: 160, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Total de Paradas', 50, resumoParY + 32, { width: 160, align: 'center' });

        doc.fillColor('#e65100').fontSize(18).font('Helvetica-Bold')
          .text(formatarTempo(maiorParada), 220, resumoParY + 8, { width: 160, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Maior Parada', 220, resumoParY + 32, { width: 160, align: 'center' });

        doc.fillColor('#2e7d32').fontSize(18).font('Helvetica-Bold')
          .text(formatarTempo(tempoTotalParadas), 390, resumoParY + 8, { width: 155, align: 'center' });
        doc.fillColor('#333').fontSize(9).font('Helvetica')
          .text('Tempo Total Parado', 390, resumoParY + 32, { width: 155, align: 'center' });

        doc.y = resumoParY + 65;

        // Tabela de paradas
        doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Registro de Paradas (> 5 minutos)');
        doc.fontSize(8).fillColor('#666').font('Helvetica')
          .text('(Locais onde o veículo permaneceu parado por tempo significativo)');
        doc.moveDown(0.3);

        // LEGENDA DE CORES DA TABELA DE PARADAS
        const legendaParY = doc.y;
        doc.rect(50, legendaParY, 495, 18).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#333');
        doc.text('LEGENDA:', 55, legendaParY + 5);
        doc.rect(110, legendaParY + 3, 12, 10).fill('#bbdefb');
        doc.fillColor('#333').font('Helvetica').text('Parada longa (>30 min)', 125, legendaParY + 5);
        doc.rect(260, legendaParY + 3, 12, 10).fill('#f5f5f5');
        doc.fillColor('#333').text('Parada normal', 275, legendaParY + 5);
        doc.moveDown(0.5);

        const parTableY = doc.y;
        const parColWidths = [30, 70, 70, 55, 150, 115];
        const parHeaders = ['#', 'Início', 'Fim', 'Duração', 'Local/Via', 'Coordenadas'];

        doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, parTableY, 495, 13).fill('#1565c0');

        let xPos = 53;
        parHeaders.forEach((header, i) => {
          doc.text(header, xPos, parTableY + 3, { width: parColWidths[i], align: 'left' });
          xPos += parColWidths[i];
        });

        doc.fillColor('#333').font('Helvetica').fontSize(6);
        let yPos = parTableY + 15;

        // Ordenar por duração (maior primeiro)
        const paradasOrdenadas = [...paradasSignificativas].sort((a, b) => b.tempoMinutos - a.tempoMinutos);

        for (let i = 0; i < paradasOrdenadas.length; i++) {
          const parada = paradasOrdenadas[i];

          if (yPos > 760) {
            doc.addPage();
            // Repetir cabeçalho
            doc.rect(0, 0, 595, 30).fill('#1565c0');
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#fff')
              .text('PARADAS SIGNIFICATIVAS (continuação)', 50, 8, { align: 'center', width: 495 });

            yPos = 45;
            doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
            doc.rect(50, yPos, 495, 13).fill('#1565c0');
            xPos = 53;
            parHeaders.forEach((header, idx) => {
              doc.text(header, xPos, yPos + 3, { width: parColWidths[idx], align: 'left' });
              xPos += parColWidths[idx];
            });
            doc.fillColor('#333').font('Helvetica').fontSize(6);
            yPos += 15;
          }

          // Fundo alternado (azul claro para paradas longas > 30min)
          if (parada.tempoMinutos > 30) {
            doc.rect(50, yPos - 1, 495, 11).fill('#bbdefb');
          } else if (i % 2 === 0) {
            doc.rect(50, yPos - 1, 495, 11).fill('#f5f5f5');
          }
          doc.fillColor('#333');

          const nomeLocal = parada.nomeVia && parada.nomeVia !== 'Local não identificado'
            ? (parada.nomeVia.length > 35 ? parada.nomeVia.substring(0, 32) + '...' : parada.nomeVia)
            : 'Local não identificado';

          xPos = 53;
          const parRowData = [
            (i + 1).toString(),
            formatDateTime(parada.inicio),
            formatDateTime(parada.fim),
            formatarTempo(parada.tempoMinutos),
            nomeLocal,
            `${parada.latitude.toFixed(6)}, ${parada.longitude.toFixed(6)}`
          ];

          parRowData.forEach((data, idx) => {
            // Destacar duração longa em azul
            if (idx === 3 && parada.tempoMinutos > 30) {
              doc.fillColor('#1565c0').font('Helvetica-Bold');
            }
            doc.text(data, xPos, yPos + 1, { width: parColWidths[idx], align: 'left' });
            if (idx === 3) {
              doc.fillColor('#333').font('Helvetica');
            }
            xPos += parColWidths[idx];
          });

          yPos += 11;
        }

        doc.moveDown();
        doc.fillColor('#000');
      }

      // ============ MÓDULO: VIAGENS ============
      if (temModulo('viagens')) {
        const viagens = await prisma.viagem.findMany({
          where: {
            dispositivo_id: dispositivo.id,
            inicio: { gte: inicio, lte: fim }
          },
          include: {
            motorista: { select: { nome: true, cnh_categoria: true } }
          },
          orderBy: { inicio: 'desc' }
        });

        if (viagens.length > 0) {
          doc.addPage();
          doc.rect(0, 0, 595, 50).fill('#4caf50');
          doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
            .text('REGISTRO DE VIAGENS', 50, 18, { align: 'center', width: 495 });
          doc.y = 70;

          // Resumo das viagens
          const resumoViagensY = doc.y;
          const kmTotalViagens = viagens.reduce((sum, v) => sum + (v.distancia_km || 0), 0);
          const tempoTotalViagens = viagens.reduce((sum, v) => {
            if (v.inicio && v.fim) {
              return sum + (new Date(v.fim) - new Date(v.inicio)) / (1000 * 60);
            }
            return sum;
          }, 0);

          doc.rect(50, resumoViagensY, 160, 50).fillAndStroke('#e8f5e9', '#4caf50');
          doc.rect(220, resumoViagensY, 160, 50).fillAndStroke('#e3f2fd', '#2196f3');
          doc.rect(390, resumoViagensY, 155, 50).fillAndStroke('#fff3e0', '#ff9800');

          doc.fillColor('#2e7d32').fontSize(20).font('Helvetica-Bold')
            .text(viagens.length.toString(), 50, resumoViagensY + 8, { width: 160, align: 'center' });
          doc.fillColor('#333').fontSize(9).font('Helvetica')
            .text('Total de Viagens', 50, resumoViagensY + 32, { width: 160, align: 'center' });

          doc.fillColor('#1565c0').fontSize(18).font('Helvetica-Bold')
            .text(`${kmTotalViagens.toFixed(1)} km`, 220, resumoViagensY + 8, { width: 160, align: 'center' });
          doc.fillColor('#333').fontSize(9).font('Helvetica')
            .text('Distância Total', 220, resumoViagensY + 32, { width: 160, align: 'center' });

          doc.fillColor('#e65100').fontSize(18).font('Helvetica-Bold')
            .text(formatarTempo(tempoTotalViagens), 390, resumoViagensY + 8, { width: 155, align: 'center' });
          doc.fillColor('#333').fontSize(9).font('Helvetica')
            .text('Tempo Total', 390, resumoViagensY + 32, { width: 155, align: 'center' });

          doc.y = resumoViagensY + 65;

          // Tabela de viagens
          doc.fontSize(11).font('Helvetica-Bold').fillColor('#333').text('Detalhamento das Viagens');
          doc.moveDown(0.3);

          const viagensTableY = doc.y;
          const viagensColWidths = [30, 70, 70, 50, 55, 80, 100];
          const viagensHeaders = ['#', 'Início', 'Fim', 'Duração', 'Km', 'Motorista', 'Status'];

          doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
          doc.rect(50, viagensTableY, 495, 13).fill('#4caf50');

          let xPos = 53;
          viagensHeaders.forEach((header, i) => {
            doc.text(header, xPos, viagensTableY + 3, { width: viagensColWidths[i], align: 'left' });
            xPos += viagensColWidths[i];
          });

          doc.fillColor('#333').font('Helvetica').fontSize(6);
          let yPos = viagensTableY + 15;

          for (let i = 0; i < Math.min(viagens.length, 50); i++) {
            const viagem = viagens[i];

            if (yPos > 760) {
              doc.addPage();
              yPos = 50;
              doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
              doc.rect(50, yPos, 495, 13).fill('#4caf50');
              xPos = 53;
              viagensHeaders.forEach((header, idx) => {
                doc.text(header, xPos, yPos + 3, { width: viagensColWidths[idx], align: 'left' });
                xPos += viagensColWidths[idx];
              });
              doc.fillColor('#333').font('Helvetica').fontSize(6);
              yPos += 15;
            }

            if (i % 2 === 0) {
              doc.rect(50, yPos - 1, 495, 11).fill('#f5f5f5');
            }
            doc.fillColor('#333');

            const duracao = viagem.inicio && viagem.fim
              ? formatarTempo((new Date(viagem.fim) - new Date(viagem.inicio)) / (1000 * 60))
              : 'Em andamento';

            const motoristaViagem = viagem.motorista?.nome || 'N/I';
            const statusViagem = viagem.fim ? 'Concluída' : 'Em andamento';

            xPos = 53;
            const viagemRowData = [
              (i + 1).toString(),
              formatDateTime(viagem.inicio),
              viagem.fim ? formatDateTime(viagem.fim) : '-',
              duracao,
              `${(viagem.distancia_km || 0).toFixed(1)}`,
              motoristaViagem.length > 15 ? motoristaViagem.substring(0, 12) + '...' : motoristaViagem,
              statusViagem
            ];

            viagemRowData.forEach((data, idx) => {
              doc.text(data, xPos, yPos + 1, { width: viagensColWidths[idx], align: 'left' });
              xPos += viagensColWidths[idx];
            });

            yPos += 11;
          }

          if (viagens.length > 50) {
            doc.moveDown(0.5);
            doc.fontSize(8).fillColor('#666');
            doc.text(`Mostrando 50 de ${viagens.length} viagens.`, { align: 'center' });
          }

          doc.moveDown();
          doc.fillColor('#000');
        }
      }

      // ============ MAPA COM TRAJETÓRIA ============
      // Usar localizacoesCorrigidas para desenhar rota que segue as ruas
      console.log(`[PDF] Total de localizacoes: ${localizacoes.length}, corrigidas: ${localizacoesCorrigidas.length}`);
      if (localizacoes.length > 0) {
        // Nova página para trajetória
        doc.addPage();
        doc.rect(0, 0, 595, 50).fill('#667eea');
        doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
          .text('TRAJETÓRIA DO VEÍCULO', 50, 18, { align: 'center', width: 495 });
        doc.y = 70;

        // Usar dados corrigidos pelo OSRM para o mapa (rota realista nas ruas)
        const mapInfo = generateMapInfo(localizacoesCorrigidas);

        if (mapInfo && mapInfo.validLocs.length > 0) {
          const validLocs = mapInfo.validLocs;
          // Usar coordenadas corrigidas mas timestamps originais
          const primeiro = validLocs[0];
          const ultimo = validLocs[validLocs.length - 1];
          // Timestamps das localizações originais (início e fim reais da viagem)
          const primeiroOriginal = localizacoes[0];
          const ultimoOriginal = localizacoes[localizacoes.length - 1];

          // Box visual da trajetória
          const routeBoxY = doc.y;
          doc.rect(50, routeBoxY, 495, 120).fillAndStroke('#f0f7ff', '#667eea');

          // Título do box
          doc.fontSize(10).font('Helvetica-Bold').fillColor('#667eea');
          doc.text('RESUMO DA TRAJETÓRIA', 60, routeBoxY + 10);

          // Linha divisória
          doc.moveTo(60, routeBoxY + 25).lineTo(535, routeBoxY + 25).stroke('#667eea');

          // Ponto de INÍCIO (coordenadas originais, timestamp original)
          doc.fontSize(9).font('Helvetica-Bold').fillColor('#2e7d32');
          doc.text('INÍCIO', 60, routeBoxY + 35);
          doc.fontSize(8).font('Helvetica').fillColor('#333');
          doc.text(`Coordenadas: ${primeiroOriginal.latitude.toFixed(6)}, ${primeiroOriginal.longitude.toFixed(6)}`, 60, routeBoxY + 48);
          doc.text(`Data/Hora: ${formatDateTime(primeiroOriginal.timestamp)}`, 60, routeBoxY + 60);

          // Ponto de FIM (coordenadas originais, timestamp original)
          doc.fontSize(9).font('Helvetica-Bold').fillColor('#c62828');
          doc.text('FIM', 300, routeBoxY + 35);
          doc.fontSize(8).font('Helvetica').fillColor('#333');
          doc.text(`Coordenadas: ${ultimoOriginal.latitude.toFixed(6)}, ${ultimoOriginal.longitude.toFixed(6)}`, 300, routeBoxY + 48);
          doc.text(`Data/Hora: ${formatDateTime(ultimoOriginal.timestamp)}`, 300, routeBoxY + 60);

          // Informações extras
          doc.fontSize(8).fillColor('#666');
          doc.text(`Total de pontos GPS: ${localizacoes.length} (${validLocs.length} na rota corrigida)`, 60, routeBoxY + 80);
          doc.text(`Área: ${mapInfo.bounds.minLat.toFixed(4)} a ${mapInfo.bounds.maxLat.toFixed(4)} (lat)`, 60, routeBoxY + 92);
          doc.text(`       ${mapInfo.bounds.minLng.toFixed(4)} a ${mapInfo.bounds.maxLng.toFixed(4)} (lon)`, 60, routeBoxY + 104);

          // Link para ver no mapa (usando coordenadas originais)
          doc.fillColor('#1976d2').font('Helvetica-Bold');
          doc.text(`Ver no Google Maps: maps.google.com/?q=${primeiroOriginal.latitude},${primeiroOriginal.longitude}`, 300, routeBoxY + 80, { link: `https://maps.google.com/?q=${primeiroOriginal.latitude},${primeiroOriginal.longitude}`, underline: true });

          doc.y = routeBoxY + 130;

          // MAPA REMOVIDO - geração mais rápida sem download de tiles OSM

          // Lista de pontos intermediários (amostragem)
          if (validLocs.length > 2) {
            doc.moveDown();
            doc.fontSize(9).font('Helvetica-Bold').fillColor('#000');
            doc.text('Pontos Intermediários (amostragem):');
            doc.fontSize(7).font('Helvetica').fillColor('#555');

            // Mostrar até 10 pontos intermediários
            const step = Math.max(1, Math.floor(validLocs.length / 10));
            let count = 0;
            for (let i = step; i < validLocs.length - 1 && count < 8; i += step) {
              const ponto = validLocs[i];
              doc.text(`  ${count + 1}. ${ponto.latitude.toFixed(5)}, ${ponto.longitude.toFixed(5)} - ${formatDateTime(ponto.timestamp)} - ${ponto.velocidade || 0} km/h`);
              count++;
            }
          }
        } else {
          // Sem localizações válidas
          doc.fontSize(10).fillColor('#999');
          doc.text('Nenhuma localização GPS válida encontrada no período selecionado.', { align: 'center' });
          doc.text('(Coordenadas 0,0 ou -90,-180 são consideradas inválidas)', { align: 'center' });
        }

        doc.moveDown();
      }
    }

    // ============ MÓDULO: LOCALIZAÇÕES (TODOS os dados do período) ============
    if (temModulo('localizacoes')) {
      let localizacoes = await prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'desc' }
        // SEM LIMITE - exportar todos os dados do período
      });

      // Aplicar filtro de status se selecionado
      if (statusFiltroAtivo) {
        localizacoes = filtrarLocalizacoesPorStatus(localizacoes, statusFiltro, dispositivo);
      }

      if (localizacoes.length > 0) {
        doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').text(`Histórico de Localizações (${localizacoes.length} registros)`);
        doc.moveDown(0.3);

        // LEGENDA DE CORES DA TABELA DE LOCALIZAÇÕES
        const legendaLocY = doc.y;
        doc.rect(50, legendaLocY, 495, 22).fill('#f5f5f5');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#333');
        doc.text('LEGENDA:', 55, legendaLocY + 4);
        doc.rect(110, legendaLocY + 2, 12, 10).fill('#ffe6e6');
        doc.fillColor('#333').font('Helvetica').text('Excesso de velocidade', 125, legendaLocY + 4);
        doc.rect(240, legendaLocY + 2, 12, 10).fill('#f7fafc');
        doc.fillColor('#333').text('Linha alternada', 255, legendaLocY + 4);
        doc.fontSize(6).fillColor('#666');
        doc.text('Estados: MOV = Em movimento | OCIOSO = Motor ligado, parado | OFF = Motor desligado', 55, legendaLocY + 14);
        doc.moveDown(0.5);

        // Cache persistente: consulta limites com precisão do banco
        console.log(`[PDF Table] Consultando limites para ${localizacoes.length} pontos (cache persistente)...`);
        let limitesViaTabela = new Map();
        try {
          const pontosTabela = localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));
          limitesViaTabela = await velocidadeViaService.obterLimitesEmLote(pontosTabela);
        } catch (e) {
          console.log('[PDF Table] Erro ao consultar limites:', e.message);
        }

        // Tabela de localizações (com coluna de excesso)
        const tableTop = doc.y;
        const colWidths = [80, 50, 70, 70, 55, 40, 45, 45];
        const headers = ['Data/Hora', 'Ignição', 'Latitude', 'Longitude', 'Velocidade', 'Limite', 'Excesso', 'Direção'];

        // Cabeçalho da tabela
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#667eea');

        let xPos = 55;
        headers.forEach((header, i) => {
          doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        doc.fillColor('#000').font('Helvetica').fontSize(7);
        let yPos = tableTop + 18;

        for (const loc of localizacoes) {  // TODOS os registros
          if (yPos > 750) {
            doc.addPage();
            yPos = 50;
          }

          // Obter limite de velocidade da via (cache preciso)
          const velocidade = loc.velocidade || 0;
          const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
          const infoVia = limitesViaTabela.get(cacheKey);
          const limiteVia = infoVia?.limite || 60;

          // Verificar excesso de velocidade
          const excedeVelocidade = velocidade > limiteVia;

          // Alternar cor de fundo (vermelho claro se excedeu)
          if (excedeVelocidade) {
            doc.rect(50, yPos - 2, 495, 12).fill('#ffe6e6');
          } else if (localizacoes.indexOf(loc) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#f7fafc');
          }
          doc.fillColor('#000');

          // Determinar estado da ignição
          let ignicaoTexto = 'N/A';
          if (loc.ignicao !== null && loc.ignicao !== undefined) {
            if (!loc.ignicao) {
              ignicaoTexto = 'OFF';
            } else if (velocidade > 5) {
              ignicaoTexto = 'MOV';
            } else {
              ignicaoTexto = 'OCIOSO';
            }
          }

          xPos = 55;
          const rowData = [
            formatDateTime(loc.timestamp),
            ignicaoTexto,
            loc.latitude?.toFixed(6) || '',
            loc.longitude?.toFixed(6) || '',
            `${velocidade} km/h`,
            `${limiteVia}`,
            excedeVelocidade ? 'SIM' : '-',
            `${loc.direcao || '-'}°`
          ];

          rowData.forEach((data, i) => {
            // Destacar excesso em vermelho
            if (i === 6 && excedeVelocidade) {
              doc.fillColor('#c62828').font('Helvetica-Bold');
            }
            doc.text(data, xPos, yPos, { width: colWidths[i], align: 'left' });
            if (i === 6 && excedeVelocidade) {
              doc.fillColor('#000').font('Helvetica');
            }
            xPos += colWidths[i];
          });

          yPos += 12;
        }
      }
    }

    // ============ MÓDULO: DADOS OBD2 (TODOS os dados do período) ============
    // Só inclui OBD2 se o dispositivo SUPORTA OBD2 (não inclui para XT40_4F)
    const dispositivoSuportaOBD2PDF = supportsOBD2(dispositivo.tipo);
    if (temModulo('obd2') && dispositivoSuportaOBD2PDF) {
      const dadosOBD2 = await prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'desc' }
        // SEM LIMITE - exportar todos os dados do período
      });

      if (dadosOBD2.length > 0) {
        doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(`Dados de Telemetria/OBD2 (${dadosOBD2.length} registros)`);
        doc.moveDown(0.5);

        const tableTop = doc.y;
        const colWidths = [80, 55, 45, 45, 45, 50, 50, 45, 40];
        const headers = ['Data/Hora', 'Ignição', 'RPM', 'Temp.', 'Comb.', 'Odômetro', 'Horímetro', 'Bateria', 'Tensão'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#667eea');

        let xPos = 55;
        headers.forEach((header, i) => {
          doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        doc.fillColor('#000').font('Helvetica').fontSize(7);
        let yPos = tableTop + 18;

        for (const obd of dadosOBD2) {
          if (yPos > 750) {
            doc.addPage();
            yPos = 50;
          }

          if (dadosOBD2.indexOf(obd) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#f7fafc');
            doc.fillColor('#000');
          }

          // Determinar estado da ignição
          let ignicaoTexto = 'N/A';
          if (obd.ignicao !== null && obd.ignicao !== undefined) {
            if (!obd.ignicao) {
              ignicaoTexto = 'OFF';
            } else if (obd.velocidade !== null && obd.velocidade > 5) {
              ignicaoTexto = 'MOV';
            } else if (obd.velocidade !== null && obd.velocidade <= 5) {
              ignicaoTexto = 'OCIOSO';
            } else {
              ignicaoTexto = 'ON';
            }
          }

          xPos = 55;
          const rowData = [
            formatDateTime(obd.timestamp),
            ignicaoTexto,
            obd.rpm || '-',
            obd.temperatura_motor ? `${obd.temperatura_motor}°C` : '-',
            obd.nivel_combustivel ? `${obd.nivel_combustivel}%` : '-',
            obd.odometro_embarcado ? `${Math.round(obd.odometro_embarcado)} km` : '-',
            obd.hora_motor_embarcada ? `${Math.round(obd.hora_motor_embarcada)} h` : '-',
            obd.percentual_bateria ? `${obd.percentual_bateria}%` : '-',
            obd.tensao_bateria ? `${obd.tensao_bateria.toFixed(1)}V` : '-'
          ];

          rowData.forEach((data, i) => {
            doc.text(String(data), xPos, yPos, { width: colWidths[i], align: 'left' });
            xPos += colWidths[i];
          });

          yPos += 12;
        }
      }
    }

    // ============ MÓDULO: ALARMES ============
    if (temModulo('alarmes')) {
      const alarmes = await prisma.alarme.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'desc' }
      });

      if (alarmes.length > 0) {
        doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(`Registro de Alarmes (${alarmes.length} registros)`);
        doc.moveDown(0.5);

        for (const alarme of alarmes) {  // TODOS os alarmes
          const severidadeCor = alarme.severidade === 'critical' ? '#f56565' :
                               alarme.severidade === 'high' ? '#ed8936' : '#48bb78';

          doc.rect(50, doc.y, 495, 40).fillAndStroke('#fff', '#e2e8f0');
          doc.rect(50, doc.y, 5, 40).fill(severidadeCor);

          doc.fillColor('#000').fontSize(9).font('Helvetica-Bold');
          doc.text(alarme.tipo_alarme, 60, doc.y + 5);

          doc.fontSize(8).font('Helvetica').fillColor('#666');
          doc.text(formatDateTime(alarme.timestamp), 60, doc.y + 18);
          doc.text(alarme.descricao || '', 60, doc.y + 28, { width: 400 });

          doc.y += 45;

          if (doc.y > 750) {
            doc.addPage();
          }
        }
      }
    }

    // ============ MÓDULO: HISTORICO RASTREADORES ============
    if (temModulo('rastreadores')) {
      const historicoRastreadores = await buscarHistoricoRastreadores(
        dispositivo.veiculo_id,
        inicio,
        fim
      );

      if (historicoRastreadores.length > 0) {
        doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text(`Histórico de Rastreadores (${historicoRastreadores.length} registros)`);
        doc.moveDown(0.5);

        // Cabeçalho da tabela
        const tableTop = doc.y;
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#333');
        doc.text('IMEI', 50, tableTop);
        doc.text('Tipo', 180, tableTop);
        doc.text('Data Vínculo', 280, tableTop);
        doc.text('Data Desvínculo', 380, tableTop);
        doc.text('Status', 500, tableTop);
        doc.moveDown(0.3);

        // Linha separadora
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#e2e8f0');
        doc.moveDown(0.3);

        doc.font('Helvetica').fontSize(8).fillColor('#000');
        for (const rastreador of historicoRastreadores) {
          const dataVinculo = rastreador.data_vinculo ? formatDateTime(rastreador.data_vinculo) : 'N/A';
          const dataDesvinculo = rastreador.data_desvinculo ? formatDateTime(rastreador.data_desvinculo) : 'Atual';
          const status = rastreador.ativo ? 'Ativo' : 'Inativo';
          const statusCor = rastreador.ativo ? '#48bb78' : '#a0aec0';

          const rowY = doc.y;
          doc.text(rastreador.imei, 50, rowY);
          doc.text(rastreador.tipo, 180, rowY);
          doc.text(dataVinculo, 280, rowY);
          doc.text(dataDesvinculo, 380, rowY);
          doc.fillColor(statusCor).text(status, 500, rowY);
          doc.fillColor('#000');

          doc.moveDown(0.5);

          if (doc.y > 750) {
            doc.addPage();
          }
        }
      }
    }

    // ============ RODAPÉ ============
    const addFooter = () => {
      doc.fontSize(8).fillColor('#999');
      doc.text(
        'Sistema de Rastreamento Veicular - Documento gerado automaticamente',
        50, 780, { align: 'center', width: 495 }
      );
    };

    // Adicionar rodapé em todas as páginas
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      addFooter();
    }

    doc.end();

  } catch (error) {
    console.error('[Exportar PDF] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar PDF', erro: error.message });
  }
});

// ============ DADOS PARA PDF COM MAPA (JSON) ============

/**
 * GET /api/exportar/:imei/dados-relatorio
 * Retorna dados formatados para gerar PDF no cliente (com mapa)
 * Multi-tenant: Verifica propriedade do dispositivo
 */
router.get('/:imei/dados-relatorio', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const { dataInicio, dataFim } = req.query;

    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Buscar todos os dados
    const [localizacoes, dadosOBD2, alarmes] = await Promise.all([
      prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      }),
      prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'desc' }
      }),
      prisma.alarme.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'desc' }
      })
    ]);

    // Calcular estatísticas
    let distanciaTotal = 0;
    let velocidadeMax = 0;
    let velocidadeMedia = 0;

    if (localizacoes.length > 1) {
      for (let i = 1; i < localizacoes.length; i++) {
        const dist = calcularDistancia(
          localizacoes[i-1].latitude, localizacoes[i-1].longitude,
          localizacoes[i].latitude, localizacoes[i].longitude
        );
        distanciaTotal += dist;
      }

      const velocidades = localizacoes.filter(l => l.velocidade > 0).map(l => l.velocidade);
      if (velocidades.length > 0) {
        velocidadeMax = Math.max(...velocidades);
        velocidadeMedia = Math.round(velocidades.reduce((a, b) => a + b, 0) / velocidades.length);
      }
    }

    res.json({
      sucesso: true,
      dados: {
        dispositivo: {
          imei: dispositivo.imei,
          placa: dispositivo.placa,
          veiculo: dispositivo.veiculo,
          tipo: dispositivo.tipo,
          status: dispositivo.status
        },
        periodo: {
          inicio: inicio.toISOString(),
          fim: fim.toISOString()
        },
        estatisticas: {
          distanciaTotal: distanciaTotal.toFixed(2),
          velocidadeMax,
          velocidadeMedia,
          totalLocalizacoes: localizacoes.length,
          totalOBD2: dadosOBD2.length,
          totalAlarmes: alarmes.length
        },
        localizacoes: localizacoes.map(l => ({
          timestamp: l.timestamp,
          ignicao: l.ignicao,
          latitude: l.latitude,
          longitude: l.longitude,
          velocidade: l.velocidade,
          direcao: l.direcao
        })),
        obd2: dadosOBD2,  // TODOS os dados OBD2
        alarmes: alarmes  // TODOS os alarmes
      }
    });

  } catch (error) {
    console.error('[Dados Relatório] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao buscar dados', erro: error.message });
  }
});

// ============ HELPERS ============

function formatDateTime(date) {
  if (!date) return '';
  return new Date(date).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatDateForFilename(date) {
  return new Date(date).toISOString().split('T')[0].replace(/-/g, '');
}

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

// ============ GERAÇÃO DE MAPA ESTÁTICO ============

/**
 * Codifica polyline no formato do Google Static Maps
 * Algoritmo: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
function encodePolyline(coordinates) {
  if (!coordinates || coordinates.length === 0) return '';

  let encoded = '';
  let prevLat = 0;
  let prevLng = 0;

  for (const [lat, lng] of coordinates) {
    // Escalar para 5 casas decimais e arredondar
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);

    // Calcular diferenças
    let dLat = latE5 - prevLat;
    let dLng = lngE5 - prevLng;

    prevLat = latE5;
    prevLng = lngE5;

    // Codificar cada diferença
    encoded += encodeNumber(dLat);
    encoded += encodeNumber(dLng);
  }

  return encoded;
}

function encodeNumber(num) {
  // Transformar em representação de sinal invertido
  let sgn_num = num << 1;
  if (num < 0) {
    sgn_num = ~sgn_num;
  }

  let encoded = '';
  while (sgn_num >= 0x20) {
    encoded += String.fromCharCode((0x20 | (sgn_num & 0x1f)) + 63);
    sgn_num >>= 5;
  }
  encoded += String.fromCharCode(sgn_num + 63);

  return encoded;
}

/**
 * Gera URL do Google Static Maps com a rota
 */
function generateStaticMapUrl(localizacoes, width = 640, height = 400) {
  if (!localizacoes || localizacoes.length === 0) {
    return null;
  }

  // Filtrar localizações válidas (não 0,0 e não -90,-180)
  const validLocs = localizacoes.filter(l =>
    l.latitude && l.longitude &&
    !(l.latitude === 0 && l.longitude === 0) &&
    !(l.latitude === -90 && l.longitude === -180) &&
    l.latitude >= -90 && l.latitude <= 90 &&
    l.longitude >= -180 && l.longitude <= 180
  );

  if (validLocs.length === 0) return null;

  // Amostrar pontos se houver muitos (limite do Google: ~2000 chars na URL)
  let pontos = validLocs;
  if (validLocs.length > 100) {
    const step = Math.ceil(validLocs.length / 100);
    pontos = validLocs.filter((_, i) => i % step === 0);
  }

  // Criar array de coordenadas [lat, lng]
  const coordinates = pontos.map(l => [l.latitude, l.longitude]);

  // Codificar polyline
  const encodedPath = encodePolyline(coordinates);

  // Marcador de início (verde) e fim (vermelho)
  const startMarker = `markers=color:green|label:I|${coordinates[0][0]},${coordinates[0][1]}`;
  const endMarker = `markers=color:red|label:F|${coordinates[coordinates.length-1][0]},${coordinates[coordinates.length-1][1]}`;

  // URL do Google Static Maps (free tier: 25k requests/month)
  const url = `https://maps.googleapis.com/maps/api/staticmap?` +
    `size=${width}x${height}&` +
    `maptype=roadmap&` +
    `path=color:0x0000ff|weight:3|enc:${encodeURIComponent(encodedPath)}&` +
    `${startMarker}&${endMarker}&` +
    `key=`;  // Sem API key (funciona com limitações)

  return url;
}

/**
 * Gera informações de mapa estático e coordenadas da rota
 */
function generateMapInfo(localizacoes) {
  if (!localizacoes || localizacoes.length === 0) return null;

  // Filtrar localizações válidas
  const validLocs = localizacoes.filter(l =>
    l.latitude && l.longitude &&
    !(l.latitude === 0 && l.longitude === 0) &&
    !(l.latitude === -90 && l.longitude === -180) &&
    Math.abs(l.latitude) <= 90 &&
    Math.abs(l.longitude) <= 180
  );

  if (validLocs.length === 0) return null;

  // Calcular bounds do mapa
  const lats = validLocs.map(l => l.latitude);
  const lngs = validLocs.map(l => l.longitude);

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  // Calcular zoom apropriado
  const latDiff = maxLat - minLat;
  const lngDiff = maxLng - minLng;
  const maxDiff = Math.max(latDiff, lngDiff);

  let zoom = 15;
  if (maxDiff > 0.5) zoom = 10;
  else if (maxDiff > 0.2) zoom = 12;
  else if (maxDiff > 0.1) zoom = 13;
  else if (maxDiff > 0.05) zoom = 14;

  return {
    centerLat,
    centerLng,
    zoom,
    bounds: { minLat, maxLat, minLng, maxLng },
    validLocs,
    totalPontos: validLocs.length
  };
}

/**
 * Gera URL de mapa estático usando OpenStreetMap (gratuito, sem API key)
 */
function generateOSMStaticMapUrl(localizacoes, width = 600, height = 400) {
  const mapInfo = generateMapInfo(localizacoes);
  if (!mapInfo) return null;

  // Usar serviço de mapa estático OSM
  const url = `https://staticmap.openstreetmap.de/staticmap.php?` +
    `center=${mapInfo.centerLat},${mapInfo.centerLng}&` +
    `zoom=${mapInfo.zoom}&` +
    `size=${width}x${height}&` +
    `maptype=mapnik`;

  return { ...mapInfo, url };
}

/**
 * Gera um SVG da rota para embutir no PDF
 * Não depende de serviços externos
 */
function generateRouteSVG(localizacoes, width = 495, height = 200) {
  const mapInfo = generateMapInfo(localizacoes);
  if (!mapInfo || !mapInfo.validLocs || mapInfo.validLocs.length < 2) return null;

  const validLocs = mapInfo.validLocs;
  const { bounds } = mapInfo;

  // Margem para marcadores
  const margin = 20;
  const innerWidth = width - 2 * margin;
  const innerHeight = height - 2 * margin;

  // Converter lat/lng para coordenadas SVG
  const latRange = bounds.maxLat - bounds.minLat;
  const lngRange = bounds.maxLng - bounds.minLng;

  // Garantir range mínimo
  const effectiveLatRange = Math.max(latRange, 0.01);
  const effectiveLngRange = Math.max(lngRange, 0.01);

  const toSVG = (lat, lng) => {
    const x = margin + ((lng - bounds.minLng) / effectiveLngRange) * innerWidth;
    const y = margin + ((bounds.maxLat - lat) / effectiveLatRange) * innerHeight; // Y invertido
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };

  // Simplificar pontos se houver muitos
  let pontos = validLocs;
  if (validLocs.length > 100) {
    const step = Math.ceil(validLocs.length / 100);
    pontos = validLocs.filter((_, i) => i % step === 0 || i === validLocs.length - 1);
  }

  // Gerar path da rota
  const pathPoints = pontos.map(loc => toSVG(loc.latitude, loc.longitude));
  const pathD = pathPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  // Pontos de início e fim
  const inicio = toSVG(validLocs[0].latitude, validLocs[0].longitude);
  const fim = toSVG(validLocs[validLocs.length - 1].latitude, validLocs[validLocs.length - 1].longitude);

  // Calcular distância total
  let distanciaTotal = 0;
  for (let i = 1; i < validLocs.length; i++) {
    const lat1 = validLocs[i - 1].latitude * Math.PI / 180;
    const lat2 = validLocs[i].latitude * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLng = (validLocs[i].longitude - validLocs[i - 1].longitude) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    distanciaTotal += 6371 * c; // km
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <!-- Background -->
    <rect width="100%" height="100%" fill="#f5f5f5" rx="5"/>

    <!-- Grid lines -->
    <g stroke="#e0e0e0" stroke-width="0.5">
      ${Array.from({ length: 5 }, (_, i) => {
    const y = margin + (i * innerHeight / 4);
    return `<line x1="${margin}" y1="${y}" x2="${width - margin}" y2="${y}"/>`;
  }).join('')}
      ${Array.from({ length: 5 }, (_, i) => {
    const x = margin + (i * innerWidth / 4);
    return `<line x1="${x}" y1="${margin}" x2="${x}" y2="${height - margin}"/>`;
  }).join('')}
    </g>

    <!-- Route path -->
    <path d="${pathD}" fill="none" stroke="#1976d2" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Start marker (green) -->
    <circle cx="${inicio.x}" cy="${inicio.y}" r="8" fill="#4CAF50" stroke="white" stroke-width="2"/>
    <text x="${inicio.x}" y="${inicio.y + 4}" fill="white" font-size="10" font-weight="bold" text-anchor="middle">I</text>

    <!-- End marker (red) -->
    <circle cx="${fim.x}" cy="${fim.y}" r="8" fill="#f44336" stroke="white" stroke-width="2"/>
    <text x="${fim.x}" y="${fim.y + 4}" fill="white" font-size="10" font-weight="bold" text-anchor="middle">F</text>

    <!-- Legend -->
    <g transform="translate(${margin}, ${height - 15})">
      <circle cx="5" cy="0" r="5" fill="#4CAF50"/>
      <text x="15" y="4" font-size="9" fill="#333">Início</text>
      <circle cx="60" cy="0" r="5" fill="#f44336"/>
      <text x="70" y="4" font-size="9" fill="#333">Fim</text>
      <text x="${innerWidth - 50}" y="4" font-size="9" fill="#666">${distanciaTotal.toFixed(1)} km | ${pontos.length} pts</text>
    </g>
  </svg>`;

  return svg;
}

/**
 * Baixa imagem de uma URL e retorna como Buffer
 */
function downloadImage(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'RastreadorApp/1.0 (GPS Tracking PDF Export)'
      }
    }, (response) => {
      // Seguir redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadImage(response.headers.location, timeout).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Converte coordenadas lat/lon para números de tile OSM
 */
function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Converte números de tile OSM para coordenadas lat/lon (canto superior esquerdo do tile)
 */
function tileToLatLon(x, y, zoom) {
  const n = Math.pow(2, zoom);
  const lon = x / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lon };
}

/**
 * Baixa múltiplos tiles OSM e retorna informações para composição
 */
async function downloadOSMTiles(bounds, zoom, maxTiles = 16) {
  const minTile = latLonToTile(bounds.maxLat, bounds.minLng, zoom); // maxLat para tile menor Y
  const maxTile = latLonToTile(bounds.minLat, bounds.maxLng, zoom); // minLat para tile maior Y

  // Limitar número de tiles
  const numTilesX = maxTile.x - minTile.x + 1;
  const numTilesY = maxTile.y - minTile.y + 1;

  if (numTilesX * numTilesY > maxTiles) {
    console.log(`[PDF] Muitos tiles (${numTilesX}x${numTilesY}), reduzindo zoom`);
    return null;
  }

  const tiles = [];
  const baseUrl = 'https://tile.openstreetmap.org';

  console.log(`[PDF] Baixando ${numTilesX}x${numTilesY} tiles OSM (zoom ${zoom})`);

  for (let y = minTile.y; y <= maxTile.y; y++) {
    for (let x = minTile.x; x <= maxTile.x; x++) {
      const url = `${baseUrl}/${zoom}/${x}/${y}.png`;
      try {
        const buffer = await downloadImage(url, 5000);
        if (buffer && buffer.length > 100) {
          const tileBounds = {
            topLeft: tileToLatLon(x, y, zoom),
            bottomRight: tileToLatLon(x + 1, y + 1, zoom)
          };
          tiles.push({
            x, y, zoom, buffer,
            bounds: tileBounds,
            gridX: x - minTile.x,
            gridY: y - minTile.y
          });
        }
      } catch (e) {
        console.log(`[PDF] Erro ao baixar tile ${x},${y}: ${e.message}`);
      }
    }
  }

  if (tiles.length === 0) return null;

  // Calcular bounds reais dos tiles baixados
  const firstTile = tiles[0];
  const lastTile = tiles[tiles.length - 1];
  const tileBounds = {
    minLat: lastTile.bounds.bottomRight.lat,
    maxLat: firstTile.bounds.topLeft.lat,
    minLng: firstTile.bounds.topLeft.lon,
    maxLng: lastTile.bounds.bottomRight.lon
  };

  return {
    tiles,
    numTilesX,
    numTilesY,
    bounds: tileBounds,
    tileSize: 256
  };
}

// ============ EXPORTAR EXCEL (.XLSX) ============

/**
 * GET /api/exportar/:imei/xlsx
 * Exporta histórico do veículo em formato Excel (.xlsx) com múltiplas abas
 *
 * Query params:
 * - dataInicio: Data inicial (ISO string)
 * - dataFim: Data final (ISO string)
 * - modulos: string - lista separada por vírgula dos módulos a incluir
 */
router.get('/:imei/xlsx', verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      modulos = 'resumo,score,consumo,kmDia,excessos,paradas,viagens,obd2,alarmes,localizacoes',
      corrigido = 'true',
      motoristaIds = '', // IDs dos motoristas filtrados
      mostrarMotoristas = '', // 'todos' para mostrar todos os motoristas vinculados
      tagIds = '', // IDs das tags filtradas (separados por vírgula)
      statusFiltro = '', // Status filtrado (movimento, ocioso, parado, offline)
      // Filtros Avancados
      geofenceIds = '', tiposAlarme = '',
      incluirViagens = '', // Checkbox simples
      multaStatus = '', multaGravidade = '',
      velMin = '', velMax = '', soExcessos = '',
      velAcima80 = '', velAcima100 = '', velAcima120 = '',
      scoreMin = '', scoreMax = '', excessosMax = '', ociosoMax = '', kmMinRodado = ''
    } = req.query;

    // Extrair filtro de tags
    // Se mais de 50 tags forem enviadas, ignorar filtro (significa "Todos" selecionado)
    const tagIdsFiltroRaw = tagIds
      ? tagIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const tagIdsFiltro = tagIdsFiltroRaw.length > 50 ? [] : tagIdsFiltroRaw;
    const filtroTagAtivo = tagIdsFiltro.length > 0;

    // Extrair filtro de status
    const statusFiltroAtivo = statusFiltro && statusFiltro !== 'todos';

    // Extrair filtro de motorista
    const motoristaIdsFiltro = motoristaIds
      ? motoristaIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
      : [];
    const mostrarTodosMotoristas = mostrarMotoristas === 'todos';
    const filtroMotoristaAtivo = motoristaIdsFiltro.length > 0 || mostrarTodosMotoristas;

    // Extrair filtros avancados (Excel)
    const geofenceIdsFiltro = geofenceIds ? geofenceIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
    const filtroGeofenceAtivo = geofenceIdsFiltro.length > 0;
    const tiposAlarmeFiltro = tiposAlarme ? tiposAlarme.split(',').filter(t => t.trim()) : [];
    const filtroAlarmeAtivo = tiposAlarmeFiltro.length > 0;
    const filtroViagemAtivo = incluirViagens === 'true';
    const filtroMultaAtivo = multaStatus || multaGravidade;
    const filtroVelocidadeAvancado = velAcima80 === 'true' || velAcima100 === 'true' || velAcima120 === 'true' || velMin || velMax || soExcessos === 'true';
    const filtroPerformanceAtivo = scoreMin || scoreMax || excessosMax || ociosoMax || kmMinRodado;

    // Parsear módulos selecionados
    const modulosSelecionados = modulos.split(',').map(m => m.trim().toLowerCase());
    const temModulo = (nome) => modulosSelecionados.includes(nome.toLowerCase());

    console.log('[Excel] Módulos selecionados:', modulosSelecionados);

    // Buscar dispositivo com tags do veículo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      include: {
        veiculo_rel: {
          include: {
            tags: {
              include: {
                tag: { select: { id: true, nome: true, cor: true } }
              }
            }
          }
        }
      }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Extrair tags do veículo
    const tagsVeiculo = dispositivo.veiculo_rel?.tags?.map(vt => vt.tag.nome).join(', ') || 'Nenhuma';

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Buscar localizações
    let localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    // Aplicar filtro de status se selecionado
    if (statusFiltroAtivo) {
      const totalAntes = localizacoes.length;
      localizacoes = filtrarLocalizacoesPorStatus(localizacoes, statusFiltro, dispositivo);
      console.log(`[Excel] Filtro status '${statusFiltro}': ${totalAntes} -> ${localizacoes.length} registros`);
    }

    // Buscar OBD2 (se aplicável)
    const isOBD2Device = supportsOBD2(dispositivo.tipo);
    let dadosOBD2 = [];
    if (isOBD2Device && temModulo('obd2')) {
      dadosOBD2 = await prisma.dadosOBD2.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });
    }

    // Buscar alarmes
    let alarmes = [];
    if (temModulo('alarmes')) {
      alarmes = await prisma.alarme.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        orderBy: { timestamp: 'asc' }
      });
    }

    // Buscar viagens
    let viagens = [];
    if (temModulo('viagens')) {
      viagens = await prisma.viagem.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          inicio: { gte: inicio },
          fim: { lte: fim }
        },
        orderBy: { inicio: 'asc' }
      });
    }

    // Buscar motoristas vinculados - se filtro específico OU "todos os motoristas"
    let motoristasVinculadosExcel = [];
    if (filtroMotoristaAtivo) {
      // Construir filtro base
      const whereHistorico = {
        dispositivo_id: dispositivo.id,
        inicio: { lte: fim },
        OR: [{ fim: { gte: inicio } }, { fim: null }]
      };

      // Se não é "todos", filtrar por IDs específicos
      if (!mostrarTodosMotoristas && motoristaIdsFiltro.length > 0) {
        whereHistorico.motorista_id = { in: motoristaIdsFiltro };
      }

      const historico = await prisma.historicoMotorista.findMany({
        where: whereHistorico,
        include: { motorista: { select: { id: true, nome: true, cnh_categoria: true } } },
        orderBy: { inicio: 'asc' }
      });

      // Guardar vínculos para aba separada
      motoristasVinculadosExcel = historico
        .filter(h => h.motorista)
        .map(h => ({
          ...h.motorista,
          periodoInicio: h.inicio,
          periodoFim: h.fim
        }))
        .sort((a, b) => new Date(a.periodoInicio) - new Date(b.periodoInicio));
    }

    // ============ BUSCAR NOMES DAS TAGS FILTRADAS (Excel) ============
    let tagsFiltradasExcel = [];
    if (filtroTagAtivo) {
      try {
        tagsFiltradasExcel = await prisma.tag.findMany({
          where: { id: { in: tagIdsFiltro } },
          select: { id: true, nome: true }
        });
      } catch (e) {
        console.log('[Excel] Erro ao buscar tags filtradas:', e.message);
      }
    }
    const tagsFiltradasTextoExcel = tagsFiltradasExcel.map(t => t.nome).join(', ') || '';

    // ============ TEXTO DO STATUS FILTRADO (Excel) ============
    const statusTextoMapExcel = {
      'movimento': 'Em Movimento',
      'ocioso': 'Ocioso (motor ligado)',
      'parado': 'Parado (motor desligado)',
      'offline': 'Offline'
    };
    const statusFiltradoTextoExcel = statusFiltroAtivo ? (statusTextoMapExcel[statusFiltro] || statusFiltro) : '';

    // ============ BUSCAR DADOS DOS FILTROS AVANÇADOS (Excel) ============
    let geofencesFiltradasExcel = [];
    if (filtroGeofenceAtivo) {
      try {
        geofencesFiltradasExcel = await prisma.geofence.findMany({
          where: { id: { in: geofenceIdsFiltro } },
          select: { id: true, nome: true, raio_metros: true }
        });
      } catch (e) {
        console.log('[Excel] Erro ao buscar cercas:', e.message);
      }
    }
    const geofencesTextoExcel = geofencesFiltradasExcel.map(g => `${g.nome} (${g.raio_metros}m)`).join(', ') || '';

    // Alarmes
    const alarmesTextoMapExcel = {
      'excesso_velocidade': 'Excesso Vel.', 'sos': 'SOS', 'bateria_baixa': 'Bateria',
      'desconexao': 'Desconexão', 'geofence_entrada': 'Entrada Cerca',
      'geofence_saida': 'Saída Cerca', 'ignicao': 'Ignição', 'vibracao': 'Vibração'
    };
    const alarmesTextoExcel = tiposAlarmeFiltro.map(t => alarmesTextoMapExcel[t] || t).join(', ') || '';

    // Viagens (checkbox simples)
    const viagensTextoExcel = filtroViagemAtivo ? 'Incluidas (todas do periodo)' : '';

    // Velocidade
    let velocidadeTextoExcel = '';
    const velPartesExcel = [];
    if (velMin || velMax) velPartesExcel.push(`${velMin || 0}-${velMax || '∞'} km/h`);
    if (velAcima80 === 'true') velPartesExcel.push('>80');
    if (velAcima100 === 'true') velPartesExcel.push('>100');
    if (velAcima120 === 'true') velPartesExcel.push('>120');
    if (soExcessos === 'true') velPartesExcel.push('Só excessos');
    velocidadeTextoExcel = velPartesExcel.join(', ');

    // Performance
    let performanceTextoExcel = '';
    if (filtroPerformanceAtivo) {
      const partes = [];
      if (scoreMin || scoreMax) partes.push(`Score: ${scoreMin || 0}-${scoreMax || 100}`);
      if (excessosMax) partes.push(`Max exc: ${excessosMax}`);
      if (ociosoMax) partes.push(`Max ocioso: ${ociosoMax}min`);
      if (kmMinRodado) partes.push(`Min rodado: ${kmMinRodado}km`);
      performanceTextoExcel = partes.join(', ');
    }

    // Calcular estatísticas
    let distanciaTotal = 0;
    let tempoMovimento = 0;
    let tempoOcioso = 0;
    let tempoParado = 0;
    let maxVelocidade = 0;
    let excessosVelocidade = 0;
    const kmPorDia = new Map();
    const paradas = [];
    let paradaAtual = null;

    // Helper para determinar status - IDENTICO ao usado na planilha Periodos Ocioso
    const getStatusResumo = (loc) => {
      const vel = loc.velocidade || 0;
      if (loc.estado_ignicao) {
        switch (loc.estado_ignicao) {
          case 'moving': return 'movimento';
          case 'idle': return 'ocioso';
          case 'off': return 'parado';
          default: return 'parado';
        }
      }
      if (loc.ignicao === true || loc.ignicao === 1) {
        return vel > 5 ? 'movimento' : 'ocioso';
      }
      return 'parado';
    };

    for (let i = 1; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const locAnterior = localizacoes[i - 1];
      const tempoMin = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

      if (tempoMin > 30) continue;

      const dist = calcularDistancia(
        locAnterior.latitude, locAnterior.longitude,
        loc.latitude, loc.longitude
      );

      // KM por dia
      const diaKey = new Date(loc.timestamp).toISOString().split('T')[0];
      if (dist < 5 && loc.velocidade > 0) {
        kmPorDia.set(diaKey, (kmPorDia.get(diaKey) || 0) + dist);
      }

      // Usar mesma logica de determinarStatusLoc para consistencia
      const status = getStatusResumo(loc);

      if (status === 'movimento') {
        if (dist < 5) distanciaTotal += dist;
        tempoMovimento += tempoMin;
        if (loc.velocidade > maxVelocidade) maxVelocidade = loc.velocidade;
        if (loc.velocidade > 80) excessosVelocidade++;

        // Finalizar parada
        if (paradaAtual && paradaAtual.tempoMinutos >= 5) {
          paradas.push(paradaAtual);
        }
        paradaAtual = null;
      } else if (status === 'ocioso') {
        tempoOcioso += tempoMin;

        // Rastrear parada ocioso
        if (!paradaAtual) {
          paradaAtual = {
            inicio: loc.timestamp,
            fim: loc.timestamp,
            latitude: loc.latitude,
            longitude: loc.longitude,
            tempoMinutos: 0
          };
        } else {
          paradaAtual.fim = loc.timestamp;
          paradaAtual.tempoMinutos += tempoMin;
        }
      } else {
        // parado
        tempoParado += tempoMin;

        // Rastrear parada
        if (!paradaAtual) {
          paradaAtual = {
            inicio: loc.timestamp,
            fim: loc.timestamp,
            latitude: loc.latitude,
            longitude: loc.longitude,
            tempoMinutos: 0
          };
        } else {
          paradaAtual.fim = loc.timestamp;
          paradaAtual.tempoMinutos += tempoMin;
        }
      }
    }

    // Finalizar última parada
    if (paradaAtual && paradaAtual.tempoMinutos >= 5) {
      paradas.push(paradaAtual);
    }

    // Criar workbook Excel
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sistema Rastreador GPS';
    workbook.created = new Date();

    // Estilo padrão para cabeçalhos
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } },
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      }
    };

    const cellStyle = {
      border: {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
      }
    };

    // Função auxiliar para formatar tempo
    const formatarTempo = (minutos) => {
      const horas = Math.floor(minutos / 60);
      const mins = Math.round(minutos % 60);
      return horas > 0 ? `${horas}h ${mins}min` : `${mins}min`;
    };

    // Função auxiliar para formatar data/hora
    const formatDateTime = (date) => {
      return new Date(date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    };

    // ========== ABA 1: RESUMO ==========
    if (temModulo('resumo') || temModulo('score') || temModulo('consumo')) {
      const resumoSheet = workbook.addWorksheet('Resumo');

      // Título
      resumoSheet.mergeCells('A1:B1');
      resumoSheet.getCell('A1').value = 'RELATORIO DO VEICULO';
      resumoSheet.getCell('A1').font = { bold: true, size: 16 };
      resumoSheet.getCell('A1').alignment = { horizontal: 'center' };

      // Info do veículo
      resumoSheet.addRow([]);
      resumoSheet.addRow(['INFORMACOES DO VEICULO', '']);
      const infoHeaderRow = resumoSheet.lastRow;
      infoHeaderRow.eachCell(cell => Object.assign(cell, headerStyle));
      resumoSheet.mergeCells(`A${infoHeaderRow.number}:B${infoHeaderRow.number}`);

      const infoData = [
        ['Veiculo', dispositivo.veiculo || 'N/A'],
        ['Placa', dispositivo.placa || 'N/A'],
        ['IMEI', dispositivo.imei],
        ['Tipo', dispositivo.tipo || 'N/A'],
        ['Tags do Veiculo', tagsVeiculo],
        // Status filtrado (se houver)
        ...(statusFiltroAtivo && statusFiltradoTextoExcel
          ? [['Status Filtrado', statusFiltradoTextoExcel]]
          : []),
        // Filtros avançados
        ...(filtroGeofenceAtivo && geofencesTextoExcel
          ? [['Cercas Filtradas', geofencesTextoExcel]]
          : []),
        ...(filtroAlarmeAtivo && alarmesTextoExcel
          ? [['Alarmes Filtrados', alarmesTextoExcel]]
          : []),
        ...(filtroViagemAtivo && viagensTextoExcel
          ? [['Filtro Viagens', viagensTextoExcel]]
          : []),
        ...(filtroMultaAtivo
          ? [['Filtro Multas', `${multaStatus || ''} ${multaGravidade || ''}`]]
          : []),
        ...(filtroVelocidadeAvancado && velocidadeTextoExcel
          ? [['⚡ Filtro Velocidade', velocidadeTextoExcel]]
          : []),
        ...(filtroPerformanceAtivo && performanceTextoExcel
          ? [['Filtro Performance', performanceTextoExcel]]
          : []),
        // Referência à aba de Motoristas se houver vínculos
        ...(filtroMotoristaAtivo && motoristasVinculadosExcel.length > 0
          ? [['Motorista(s)', `${motoristasVinculadosExcel.length} vinculo(s) - ver aba Motoristas`]]
          : []),
        ['Periodo', `${formatDateTime(inicio)} até ${formatDateTime(fim)}`],
        ['Total de Registros', localizacoes.length]
      ];

      infoData.forEach(row => {
        const addedRow = resumoSheet.addRow(row);
        addedRow.eachCell(cell => Object.assign(cell, cellStyle));
      });

      // Estatísticas
      resumoSheet.addRow([]);
      resumoSheet.addRow(['RESUMO ESTATISTICO', '']);
      const statsHeaderRow = resumoSheet.lastRow;
      statsHeaderRow.eachCell(cell => Object.assign(cell, headerStyle));
      resumoSheet.mergeCells(`A${statsHeaderRow.number}:B${statsHeaderRow.number}`);

      const statsData = [
        ['Distancia Total', `${distanciaTotal.toFixed(2)} km`],
        ['Tempo em Movimento', formatarTempo(tempoMovimento)],
        ['Tempo Ocioso', formatarTempo(tempoOcioso)],
        ['Tempo Parado', formatarTempo(tempoParado)],
        ['Velocidade Maxima', `${maxVelocidade} km/h`],
        ['Excessos de Velocidade', `${excessosVelocidade} ocorrencias`]
      ];

      statsData.forEach(row => {
        const addedRow = resumoSheet.addRow(row);
        addedRow.eachCell(cell => Object.assign(cell, cellStyle));
      });

      // Score de condução
      if (temModulo('score')) {
        let scoreConducao = 100;
        scoreConducao -= Math.min(40, excessosVelocidade);
        const tempoTotal = tempoMovimento + tempoOcioso + tempoParado;
        if (tempoTotal > 0 && (tempoOcioso / tempoTotal) > 0.5) scoreConducao -= 10;
        else if (tempoTotal > 0 && (tempoOcioso / tempoTotal) > 0.3) scoreConducao -= 5;
        scoreConducao = Math.max(0, Math.min(100, scoreConducao));
        const scoreTexto = scoreConducao >= 80 ? 'BOM' : scoreConducao >= 60 ? 'REGULAR' : 'ATENCAO';

        resumoSheet.addRow([]);
        resumoSheet.addRow(['SCORE DE CONDUCAO', '']);
        const scoreHeaderRow = resumoSheet.lastRow;
        scoreHeaderRow.eachCell(cell => Object.assign(cell, headerStyle));
        resumoSheet.mergeCells(`A${scoreHeaderRow.number}:B${scoreHeaderRow.number}`);

        resumoSheet.addRow(['Pontuacao', `${scoreConducao}/100`]).eachCell(cell => Object.assign(cell, cellStyle));
        resumoSheet.addRow(['Classificacao', scoreTexto]).eachCell(cell => Object.assign(cell, cellStyle));
      }

      // Consumo estimado
      if (temModulo('consumo')) {
        const consumoMedio = 10; // L/100km
        const consumoEstimado = (distanciaTotal * consumoMedio) / 100;

        resumoSheet.addRow([]);
        resumoSheet.addRow(['CONSUMO ESTIMADO', '']);
        const consumoHeaderRow = resumoSheet.lastRow;
        consumoHeaderRow.eachCell(cell => Object.assign(cell, headerStyle));
        resumoSheet.mergeCells(`A${consumoHeaderRow.number}:B${consumoHeaderRow.number}`);

        resumoSheet.addRow(['Consumo Medio', '10 L/100km']).eachCell(cell => Object.assign(cell, cellStyle));
        resumoSheet.addRow(['Consumo Total Estimado', `${consumoEstimado.toFixed(1)} litros`]).eachCell(cell => Object.assign(cell, cellStyle));
      }

      // Ajustar largura das colunas
      resumoSheet.getColumn(1).width = 25;
      resumoSheet.getColumn(2).width = 40;
    }

    // ========== ABA 2: KM POR DIA ==========
    if (temModulo('kmdia') && kmPorDia.size > 0) {
      const kmSheet = workbook.addWorksheet('KM por Dia');

      kmSheet.addRow(['Data', 'Quilometragem (km)']);
      kmSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      for (const [dia, km] of kmPorDia.entries()) {
        kmSheet.addRow([dia, parseFloat(km.toFixed(2))]).eachCell(cell => Object.assign(cell, cellStyle));
      }

      kmSheet.getColumn(1).width = 15;
      kmSheet.getColumn(2).width = 20;
    }

    // ========== ABA 3: PARADAS ==========
    if (temModulo('paradas') && paradas.length > 0) {
      const paradasSheet = workbook.addWorksheet('Paradas');

      paradasSheet.addRow(['#', 'Inicio', 'Fim', 'Duracao', 'Latitude', 'Longitude']);
      paradasSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      paradas.sort((a, b) => b.tempoMinutos - a.tempoMinutos);

      paradas.forEach((parada, idx) => {
        paradasSheet.addRow([
          idx + 1,
          formatDateTime(parada.inicio),
          formatDateTime(parada.fim),
          formatarTempo(parada.tempoMinutos),
          parada.latitude.toFixed(6),
          parada.longitude.toFixed(6)
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      [5, 20, 20, 12, 14, 14].forEach((width, idx) => {
        paradasSheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA 4: VIAGENS ==========
    if (temModulo('viagens') && viagens.length > 0) {
      const viagensSheet = workbook.addWorksheet('Viagens');

      viagensSheet.addRow(['#', 'Inicio', 'Fim', 'Duracao', 'Distancia (km)', 'Status']);
      viagensSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      viagens.forEach((viagem, idx) => {
        const duracao = viagem.fim
          ? (new Date(viagem.fim) - new Date(viagem.inicio)) / (1000 * 60)
          : 0;

        viagensSheet.addRow([
          idx + 1,
          formatDateTime(viagem.inicio),
          viagem.fim ? formatDateTime(viagem.fim) : 'Em andamento',
          formatarTempo(duracao),
          viagem.distancia_km ? parseFloat(viagem.distancia_km.toFixed(2)) : 0,
          viagem.fim ? 'Finalizada' : 'Em andamento'
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      [5, 20, 20, 12, 15, 15].forEach((width, idx) => {
        viagensSheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA 5: ALARMES ==========
    if (temModulo('alarmes') && alarmes.length > 0) {
      const alarmesSheet = workbook.addWorksheet('Alarmes');

      alarmesSheet.addRow(['#', 'Data/Hora', 'Tipo', 'Descricao', 'Latitude', 'Longitude']);
      alarmesSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      alarmes.forEach((alarme, idx) => {
        alarmesSheet.addRow([
          idx + 1,
          formatDateTime(alarme.timestamp),
          alarme.tipo || 'N/A',
          alarme.descricao || '',
          alarme.latitude?.toFixed(6) || '',
          alarme.longitude?.toFixed(6) || ''
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      [5, 20, 15, 30, 14, 14].forEach((width, idx) => {
        alarmesSheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA 6: OBD2 ==========
    if (temModulo('obd2') && dadosOBD2.length > 0) {
      const obd2Sheet = workbook.addWorksheet('Dados OBD2');

      obd2Sheet.addRow(['Data/Hora', 'RPM', 'Velocidade', 'Temperatura Motor', 'Carga Motor %', 'Tensao']);
      obd2Sheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      dadosOBD2.forEach(obd2 => {
        obd2Sheet.addRow([
          formatDateTime(obd2.timestamp),
          obd2.rpm || '',
          obd2.velocidade || '',
          obd2.temperatura_motor || '',
          obd2.carga_motor || '',
          obd2.tensao_principal?.toFixed(1) || ''
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      [20, 10, 12, 18, 15, 10].forEach((width, idx) => {
        obd2Sheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA: HISTORICO RASTREADORES ==========
    if (temModulo('rastreadores')) {
      const historicoRastreadores = await buscarHistoricoRastreadores(
        dispositivo.veiculo_id,
        inicio,
        fim
      );

      if (historicoRastreadores.length > 0) {
        const rastreadoresSheet = workbook.addWorksheet('Historico Rastreadores');

        rastreadoresSheet.addRow(['#', 'IMEI', 'Tipo', 'Data Vinculo', 'Data Desvinculo', 'Status']);
        rastreadoresSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

        historicoRastreadores.forEach((rastreador, idx) => {
          const dataVinculo = rastreador.data_vinculo ? formatDateTime(rastreador.data_vinculo) : 'N/A';
          const dataDesvinculo = rastreador.data_desvinculo ? formatDateTime(rastreador.data_desvinculo) : 'Atual';
          const status = rastreador.ativo ? 'Ativo' : 'Inativo';

          const row = rastreadoresSheet.addRow([
            idx + 1,
            rastreador.imei,
            rastreador.tipo,
            dataVinculo,
            dataDesvinculo,
            status
          ]);
          row.eachCell(cell => Object.assign(cell, cellStyle));

          // Cor verde para ativo, cinza para inativo
          if (rastreador.ativo) {
            row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
          } else {
            row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECEFF1' } };
          }
        });

        [5, 20, 15, 20, 20, 12].forEach((width, idx) => {
          rastreadoresSheet.getColumn(idx + 1).width = width;
        });
      }
    }

    // ========== ABA 7: LOCALIZACOES ==========
    // Helper para determinar status
    const determinarStatusLoc = (loc) => {
      const vel = loc.velocidade || 0;
      if (loc.estado_ignicao) {
        switch (loc.estado_ignicao) {
          case 'moving': return 'Em Movimento';
          case 'idle': return 'Ocioso';
          case 'off': return 'Parado';
          default: return loc.estado_ignicao;
        }
      }
      if (loc.ignicao === true || loc.ignicao === 1) {
        return vel > 5 ? 'Em Movimento' : 'Ocioso';
      }
      return 'Parado';
    };

    if (temModulo('localizacoes') && localizacoes.length > 0) {
      const locsSheet = workbook.addWorksheet('Localizacoes');

      locsSheet.addRow(['Data/Hora', 'Status', 'Latitude', 'Longitude', 'Velocidade', 'Ignicao', 'Satelites']);
      locsSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));

      // Limitar a 10000 registros para não travar o Excel
      const locsLimitadas = localizacoes.slice(0, 10000);

      locsLimitadas.forEach(loc => {
        const status = determinarStatusLoc(loc);
        const row = locsSheet.addRow([
          formatDateTime(loc.timestamp),
          status,
          loc.latitude?.toFixed(6) || '',
          loc.longitude?.toFixed(6) || '',
          loc.velocidade || 0,
          loc.ignicao ? 'Sim' : 'Nao',
          loc.satelites || ''
        ]);
        row.eachCell(cell => Object.assign(cell, cellStyle));
        // Cores por status
        if (status === 'Em Movimento') {
          row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };
        } else if (status === 'Ocioso') {
          row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E1' } };
        } else if (status === 'Parado') {
          row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
        }
      });

      if (localizacoes.length > 10000) {
        locsSheet.addRow([`... mais ${localizacoes.length - 10000} registros omitidos`]);
      }

      [20, 14, 14, 14, 12, 10, 10].forEach((width, idx) => {
        locsSheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA: PERIODOS OCIOSO ==========
    // Detectar períodos de ociosidade (motor ligado, parado)
    const periodosOcioso = [];
    let periodoAtual = null;
    for (let i = 0; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const status = determinarStatusLoc(loc);

      if (status === 'Ocioso') {
        if (!periodoAtual) {
          periodoAtual = {
            inicio: loc.timestamp,
            fim: loc.timestamp,
            latitude: loc.latitude,
            longitude: loc.longitude,
            duracao: 0
          };
        } else {
          periodoAtual.fim = loc.timestamp;
        }
      } else {
        if (periodoAtual) {
          periodoAtual.duracao = (new Date(periodoAtual.fim) - new Date(periodoAtual.inicio)) / (1000 * 60);
          if (periodoAtual.duracao >= 1) { // Apenas periodos >= 1 minuto
            periodosOcioso.push({ ...periodoAtual });
          }
          periodoAtual = null;
        }
      }
    }
    // Finalizar ultimo periodo
    if (periodoAtual) {
      periodoAtual.duracao = (new Date(periodoAtual.fim) - new Date(periodoAtual.inicio)) / (1000 * 60);
      if (periodoAtual.duracao >= 1) {
        periodosOcioso.push({ ...periodoAtual });
      }
    }

    if (periodosOcioso.length > 0) {
      const ociosoSheet = workbook.addWorksheet('Periodos Ocioso');

      // Resumo
      ociosoSheet.mergeCells('A1:F1');
      ociosoSheet.getCell('A1').value = 'PERIODOS DE OCIOSIDADE (Motor Ligado, Parado)';
      ociosoSheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFF59E0B' } };
      ociosoSheet.getCell('A1').alignment = { horizontal: 'center' };

      const tempoTotalOcioso = periodosOcioso.reduce((sum, p) => sum + p.duracao, 0);
      const maiorOcioso = Math.max(...periodosOcioso.map(p => p.duracao));

      ociosoSheet.addRow([]);
      ociosoSheet.addRow(['Total de Periodos:', periodosOcioso.length]);
      ociosoSheet.addRow(['Tempo Total Ocioso:', `${Math.floor(tempoTotalOcioso / 60)}h ${Math.round(tempoTotalOcioso % 60)}min`]);
      ociosoSheet.addRow(['Maior Periodo:', `${Math.round(maiorOcioso)} min`]);
      ociosoSheet.addRow([]);

      // Cabecalho
      ociosoSheet.addRow(['Inicio', 'Fim', 'Duracao', 'Latitude', 'Longitude']);
      ociosoSheet.getRow(7).eachCell(cell => Object.assign(cell, headerStyle));

      // Ordenar por duracao (maior primeiro)
      const ociosoOrd = [...periodosOcioso].sort((a, b) => b.duracao - a.duracao);
      ociosoOrd.forEach(p => {
        ociosoSheet.addRow([
          formatDateTime(p.inicio),
          formatDateTime(p.fim),
          `${Math.round(p.duracao)} min`,
          p.latitude?.toFixed(6) || '',
          p.longitude?.toFixed(6) || ''
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      [20, 20, 12, 14, 14].forEach((width, idx) => {
        ociosoSheet.getColumn(idx + 1).width = width;
      });
    }

    // ========== ABA: EXCESSOS DE VELOCIDADE ==========
    if (temModulo('excessos')) {
      // Detectar excessos de velocidade
      let limitesViaExcel = new Map();
      try {
        const pontosExcel = localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));
        limitesViaExcel = await velocidadeViaService.obterLimitesEmLote(pontosExcel);
      } catch (e) {
        console.log('[Excel Excessos] Erro ao consultar limites:', e.message);
      }

      const excessosExcel = [];
      for (const loc of localizacoes) {
        const velocidade = loc.velocidade || 0;
        const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
        const infoVia = limitesViaExcel.get(cacheKey);
        const limiteVia = infoVia?.limite || 60;
        const nomeVia = infoVia?.nome || 'N/A';

        if (velocidade > limiteVia) {
          excessosExcel.push({
            timestamp: loc.timestamp,
            latitude: loc.latitude,
            longitude: loc.longitude,
            velocidade: velocidade,
            limite: limiteVia,
            excesso: velocidade - limiteVia,
            nomeVia: nomeVia
          });
        }
      }

      if (excessosExcel.length > 0) {
        const excessosSheet = workbook.addWorksheet('Excessos Velocidade');

        // Resumo no topo
        excessosSheet.mergeCells('A1:G1');
        excessosSheet.getCell('A1').value = 'EXCESSOS DE VELOCIDADE';
        excessosSheet.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFC62828' } };
        excessosSheet.getCell('A1').alignment = { horizontal: 'center' };

        excessosSheet.addRow([]);
        excessosSheet.addRow(['Total de Excessos:', excessosExcel.length]);
        excessosSheet.addRow(['Maior Excesso:', `+${Math.max(...excessosExcel.map(e => e.excesso))} km/h`]);
        excessosSheet.addRow(['Velocidade Maxima:', `${Math.max(...excessosExcel.map(e => e.velocidade))} km/h`]);
        excessosSheet.addRow([]);

        // Cabeçalho da tabela
        excessosSheet.addRow(['Data/Hora', 'Via', 'Velocidade', 'Limite', 'Excesso', 'Latitude', 'Longitude']);
        excessosSheet.getRow(7).eachCell(cell => Object.assign(cell, headerStyle));

        // Ordenar por excesso (maior primeiro)
        const excessosOrd = [...excessosExcel].sort((a, b) => b.excesso - a.excesso);
        excessosOrd.forEach(exc => {
          const row = excessosSheet.addRow([
            formatDateTime(exc.timestamp),
            exc.nomeVia,
            exc.velocidade,
            exc.limite,
            `+${exc.excesso}`,
            exc.latitude?.toFixed(6) || '',
            exc.longitude?.toFixed(6) || ''
          ]);
          row.eachCell(cell => Object.assign(cell, cellStyle));
          // Destacar excessos graves
          if (exc.excesso > 20) {
            row.eachCell(cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } });
          }
        });

        [20, 30, 12, 10, 10, 14, 14].forEach((width, idx) => {
          excessosSheet.getColumn(idx + 1).width = width;
        });
      }
    }

    // ========== ABA 8: MOTORISTAS (se houver vínculos) ==========
    if (filtroMotoristaAtivo && motoristasVinculadosExcel.length > 0) {
      const motoristasSheet = workbook.addWorksheet('Motoristas');

      // Título
      motoristasSheet.mergeCells('A1:E1');
      motoristasSheet.getCell('A1').value = 'HISTORICO DE MOTORISTAS VINCULADOS';
      motoristasSheet.getCell('A1').font = { bold: true, size: 14 };
      motoristasSheet.getCell('A1').alignment = { horizontal: 'center' };

      motoristasSheet.addRow([]);

      // Cabeçalho da tabela
      motoristasSheet.addRow(['Motorista', 'CNH', 'Inicio Vinculo', 'Fim Vinculo', 'Duracao']);
      motoristasSheet.getRow(3).eachCell(cell => Object.assign(cell, headerStyle));

      // Função para calcular duração
      const calcularDuracao = (inicio, fim) => {
        const dataInicio = new Date(inicio);
        const dataFim = fim ? new Date(fim) : new Date();
        const diffMs = dataFim - dataInicio;
        const diffMin = Math.floor(diffMs / (1000 * 60));
        const dias = Math.floor(diffMin / (60 * 24));
        const horas = Math.floor((diffMin % (60 * 24)) / 60);
        const mins = diffMin % 60;

        if (dias > 0) return `${dias}d ${horas}h ${mins}min`;
        if (horas > 0) return `${horas}h ${mins}min`;
        return `${mins}min`;
      };

      // Dados dos motoristas
      motoristasVinculadosExcel.forEach(m => {
        motoristasSheet.addRow([
          m.nome,
          m.cnh_categoria || '-',
          formatDateTime(m.periodoInicio),
          m.periodoFim ? formatDateTime(m.periodoFim) : 'Atual (vinculado)',
          calcularDuracao(m.periodoInicio, m.periodoFim)
        ]).eachCell(cell => Object.assign(cell, cellStyle));
      });

      // Largura das colunas
      [30, 8, 22, 22, 15].forEach((width, idx) => {
        motoristasSheet.getColumn(idx + 1).width = width;
      });

      // Resumo
      motoristasSheet.addRow([]);
      motoristasSheet.addRow([`Total: ${motoristasVinculadosExcel.length} vinculo(s) no periodo`]);
    }

    // Gerar buffer e enviar
    const filename = `relatorio_${dispositivo.placa || imei}_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();

    console.log(`[Excel] Gerado: ${filename} (${localizacoes.length} registros)`);

  } catch (error) {
    console.error('[Exportar Excel] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar Excel', erro: error.message });
  }
});

module.exports = router;
