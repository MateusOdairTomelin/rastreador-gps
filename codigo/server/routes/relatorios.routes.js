/**
 * Rotas de Relatórios Avançados
 * Endpoints para geração de relatórios específicos:
 * - Excessos de Velocidade
 * - Tempo Ocioso
 * - Quilometragem
 * - Resumo da Frota
 */

const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const prisma = require('../db/prisma');

// Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant } = require('../middleware/tenant-device.middleware');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// Serviço de limite de velocidade por via
const velocidadeViaService = require('../services/velocidade-via.service');

// Serviço de veículos (para histórico de dispositivos)
const veiculoService = require('../services/veiculo.service');

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

/**
 * Expande um dispositivo_id para incluir TODOS os dispositivos do mesmo veículo
 * Isso permite buscar histórico completo mesmo após troca de rastreador
 *
 * @param {number} dispositivo_id - ID do dispositivo atual
 * @param {Date} inicio - Data início do período
 * @param {Date} fim - Data fim do período
 * @returns {Promise<number[]>} Array de dispositivo_ids (inclui o original + histórico)
 */
async function expandirDispositivosDoVeiculo(dispositivo_id, inicio, fim) {
  try {
    // Buscar o dispositivo para ver se tem veículo vinculado
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivo_id },
      select: { id: true, veiculo_id: true }
    });

    if (!dispositivo) {
      return [dispositivo_id];
    }

    // Se não tem veículo, retorna apenas o dispositivo atual
    if (!dispositivo.veiculo_id) {
      return [dispositivo_id];
    }

    // Buscar todos os dispositivos que já estiveram vinculados a este veículo no período
    const dispositivoIds = await veiculoService.getDispositivoIdsPorPeriodo(
      dispositivo.veiculo_id,
      inicio,
      fim
    );

    // Se não encontrou histórico, retorna apenas o dispositivo atual
    if (!dispositivoIds || dispositivoIds.length === 0) {
      return [dispositivo_id];
    }

    // Garantir que o dispositivo atual está incluído
    if (!dispositivoIds.includes(dispositivo_id)) {
      dispositivoIds.push(dispositivo_id);
    }

    return dispositivoIds;
  } catch (error) {
    console.error('[Relatórios] Erro ao expandir dispositivos do veículo:', error.message);
    return [dispositivo_id];
  }
}

function formatarTempo(minutos) {
  const horas = Math.floor(minutos / 60);
  const mins = Math.round(minutos % 60);
  if (horas > 0) return `${horas}h ${mins}min`;
  return `${mins} min`;
}

/**
 * Busca motoristas vinculados a um dispositivo em um período específico
 * Retorna array com info de cada motorista e seu período de vinculação
 */
async function buscarMotoristasNoPeriodo(dispositivoId, inicio, fim) {
  try {
    // Buscar do histórico de motoristas
    const historicoMotoristas = await prisma.historicoMotorista.findMany({
      where: {
        dispositivo_id: dispositivoId,
        // Motorista que estava vinculado durante o período:
        // inicio do vínculo <= fim do relatório E (fim do vínculo >= início do relatório OU ainda vinculado)
        inicio: { lte: fim },
        OR: [
          { fim: { gte: inicio } },
          { fim: null } // Ainda vinculado
        ]
      },
      include: {
        motorista: {
          select: {
            id: true,
            nome: true,
            cpf: true,
            telefone: true,
            cnh_numero: true
          }
        }
      },
      orderBy: { inicio: 'asc' }
    });

    // Também buscar motorista atualmente vinculado ao dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivoId },
      include: {
        motorista: {
          select: {
            id: true,
            nome: true,
            cpf: true,
            telefone: true,
            cnh_numero: true
          }
        }
      }
    });

    // Consolidar motoristas únicos
    const motoristasMap = new Map();

    for (const h of historicoMotoristas) {
      if (h.motorista) {
        const existente = motoristasMap.get(h.motorista.id);
        if (existente) {
          // Expandir período se necessário
          if (new Date(h.inicio) < new Date(existente.periodo_inicio)) {
            existente.periodo_inicio = h.inicio;
          }
          if (!h.fim || !existente.periodo_fim || new Date(h.fim) > new Date(existente.periodo_fim)) {
            existente.periodo_fim = h.fim;
          }
        } else {
          motoristasMap.set(h.motorista.id, {
            ...h.motorista,
            periodo_inicio: h.inicio,
            periodo_fim: h.fim
          });
        }
      }
    }

    // Incluir motorista atual se não estiver no histórico
    if (dispositivo?.motorista && !motoristasMap.has(dispositivo.motorista.id)) {
      motoristasMap.set(dispositivo.motorista.id, {
        ...dispositivo.motorista,
        periodo_inicio: null,
        periodo_fim: null,
        atual: true
      });
    }

    return Array.from(motoristasMap.values());
  } catch (error) {
    console.error('[buscarMotoristasNoPeriodo] Erro:', error);
    return [];
  }
}

/**
 * Formata lista de motoristas para exibição
 */
function formatarMotoristasParaExibicao(motoristas) {
  if (!motoristas || motoristas.length === 0) {
    return 'Nenhum motorista vinculado';
  }
  return motoristas.map(m => {
    let info = m.nome;
    if (m.periodo_inicio || m.periodo_fim) {
      const periodoStr = `${m.periodo_inicio ? formatDateTime(m.periodo_inicio).split(' ')[0] : '?'} - ${m.periodo_fim ? formatDateTime(m.periodo_fim).split(' ')[0] : 'atual'}`;
      info += ` (${periodoStr})`;
    } else if (m.atual) {
      info += ' (atual)';
    }
    return info;
  }).join(', ');
}

// ============ RELATÓRIO DE EXCESSOS DE VELOCIDADE ============

/**
 * GET /api/relatorios/velocidade/:imei
 * Relatório detalhado de excessos de velocidade
 *
 * Query params:
 * - dataInicio: Data inicial (ISO string)
 * - dataFim: Data final (ISO string)
 * - formato: csv ou pdf (default: csv)
 */
router.get('/velocidade/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv'
    } = req.query;

    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Expandir para todos os dispositivos do veículo (histórico de trocas de rastreador)
    const dispositivoIds = await expandirDispositivosDoVeiculo(dispositivo.id, inicio, fim);

    // Buscar localizações de TODOS os dispositivos do veículo
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum registro encontrado no período selecionado'
      });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Cache persistente: primeira consulta é lenta, próximas são instantâneas do banco
    console.log(`[Relatório Velocidade] Processando ${localizacoes.length} pontos com cache persistente...`);

    // Preparar pontos para consulta em lote (cache otimizado)
    const pontosParaConsulta = localizacoes.map(l => ({ lat: l.latitude, lng: l.longitude }));

    // Consultar limites de velocidade (usa cache do banco de dados)
    let limitesVia = new Map();
    try {
      limitesVia = await velocidadeViaService.obterLimitesEmLote(pontosParaConsulta);
    } catch (e) {
      console.log('[Relatório Velocidade] Erro ao consultar limites:', e.message);
    }

    // Filtrar apenas excessos de velocidade
    const excessos = [];
    let debugViasEncontradas = 0;
    let debugViasSemNome = 0;

    for (const loc of localizacoes) {
      const velocidade = loc.velocidade || 0;
      const cacheKey = velocidadeViaService.getCacheKey(loc.latitude, loc.longitude);
      const infoVia = limitesVia.get(cacheKey);

      // Usar limite da via do cache, fallback para 60 km/h (padrão urbano)
      const limite = infoVia?.limite || 60;
      const nomeVia = infoVia?.nome || '';

      // Debug: contar vias encontradas
      if (nomeVia && nomeVia !== 'N/A' && nomeVia !== 'Via não identificada') {
        debugViasEncontradas++;
      } else {
        debugViasSemNome++;
      }

      if (velocidade > limite) {
        excessos.push({
          timestamp: loc.timestamp,
          latitude: loc.latitude,
          longitude: loc.longitude,
          velocidade: velocidade,
          limite: limite,
          excesso: velocidade - limite,
          nomeVia: nomeVia || 'N/A'
        });
      }
    }

    console.log(`[Relatório Velocidade] Debug: ${debugViasEncontradas} vias com nome, ${debugViasSemNome} sem nome`);
    console.log(`[Relatório Velocidade] Total de excessos: ${excessos.length}`);

    // Estatísticas básicas
    const estatisticas = {
      totalRegistros: localizacoes.length,
      totalExcessos: excessos.length,
      percentualExcessos: ((excessos.length / localizacoes.length) * 100).toFixed(1),
      maiorExcesso: excessos.length > 0 ? Math.max(...excessos.map(e => e.excesso)) : 0,
      velocidadeMaxima: excessos.length > 0 ? Math.max(...excessos.map(e => e.velocidade)) : 0,
      mediaExcesso: excessos.length > 0 ? (excessos.reduce((s, e) => s + e.excesso, 0) / excessos.length).toFixed(1) : 0
    };

    // Análise por gravidade
    const excessosLeves = excessos.filter(e => e.excesso <= 10).length;      // até 10 km/h acima
    const excessosModerados = excessos.filter(e => e.excesso > 10 && e.excesso <= 20).length;  // 10-20 km/h
    const excessosGraves = excessos.filter(e => e.excesso > 20 && e.excesso <= 40).length;     // 20-40 km/h
    const excessosMuitoGraves = excessos.filter(e => e.excesso > 40).length; // acima de 40 km/h

    // Top 10 vias com mais excessos
    const excessosPorVia = {};
    for (const exc of excessos) {
      const via = exc.nomeVia && exc.nomeVia !== 'N/A' && exc.nomeVia !== 'Via não identificada'
        ? exc.nomeVia
        : `Coord: ${exc.latitude.toFixed(4)}, ${exc.longitude.toFixed(4)}`;
      if (!excessosPorVia[via]) {
        excessosPorVia[via] = { count: 0, maxExcesso: 0, maxVelocidade: 0, limite: exc.limite };
      }
      excessosPorVia[via].count++;
      excessosPorVia[via].maxExcesso = Math.max(excessosPorVia[via].maxExcesso, exc.excesso);
      excessosPorVia[via].maxVelocidade = Math.max(excessosPorVia[via].maxVelocidade, exc.velocidade);
    }
    const topVias = Object.entries(excessosPorVia)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);

    // Debug: mostrar primeiros excessos
    if (excessos.length > 0) {
      console.log('[Relatório Velocidade] Amostra de excessos:');
      excessos.slice(0, 3).forEach((e, i) => {
        console.log(`  ${i+1}. Via: "${e.nomeVia}", Vel: ${e.velocidade}, Limite: ${e.limite}`);
      });
    }

    if (formato === 'pdf') {
      // Gerar PDF melhorado
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Relatório de Velocidade - ${dispositivo.placa || imei}`,
          Author: 'Sistema de Rastreamento Veicular'
        }
      });

      const filename = `excessos_velocidade_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // ===== CABEÇALHO =====
      doc.rect(0, 0, 595, 80).fill('#667eea');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#fff')
        .text('RELATÓRIO DE EXCESSOS DE VELOCIDADE', 50, 25, { align: 'center', width: 495 });
      doc.fontSize(10).font('Helvetica').fillColor('#fff')
        .text(`Gerado em: ${formatDateTime(new Date())}`, 50, 52, { align: 'center', width: 495 });

      doc.y = 100;

      // ===== INFORMAÇÕES DO VEÍCULO =====
      doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Informações do Veículo');
      doc.moveDown(0.3);

      const infoBoxY = doc.y;
      doc.rect(50, infoBoxY, 495, 80).fillAndStroke('#f5f5f5', '#ddd');

      doc.fillColor('#333').fontSize(9).font('Helvetica');
      doc.text('Veículo:', 60, infoBoxY + 8);
      doc.font('Helvetica-Bold').text(dispositivo.veiculo || 'N/A', 110, infoBoxY + 8);
      doc.font('Helvetica').text('Placa:', 60, infoBoxY + 22);
      doc.font('Helvetica-Bold').text(dispositivo.placa || 'N/A', 110, infoBoxY + 22);
      doc.font('Helvetica').text('IMEI:', 60, infoBoxY + 36);
      doc.text(dispositivo.imei, 110, infoBoxY + 36);

      doc.font('Helvetica').text('Período:', 310, infoBoxY + 8);
      doc.font('Helvetica-Bold').text(formatDateTime(inicio), 360, infoBoxY + 8);
      doc.font('Helvetica').text('até:', 310, infoBoxY + 22);
      doc.font('Helvetica-Bold').text(formatDateTime(fim), 360, infoBoxY + 22);
      doc.font('Helvetica').text('Registros GPS:', 310, infoBoxY + 36);
      doc.font('Helvetica-Bold').text(estatisticas.totalRegistros.toLocaleString('pt-BR'), 390, infoBoxY + 36);

      // Motoristas vinculados no período
      doc.font('Helvetica').text('Motorista(s):', 60, infoBoxY + 50);
      const motoristasResumo = motoristas.length > 0
        ? motoristas.map(m => m.nome).join(', ')
        : 'Nenhum vinculado';
      doc.font('Helvetica-Bold').text(motoristasResumo.substring(0, 80), 130, infoBoxY + 50, { width: 400 });
      if (motoristas.length > 1) {
        doc.font('Helvetica').fontSize(8).fillColor('#666').text(`(${motoristas.length} motoristas no período)`, 60, infoBoxY + 64);
      }

      doc.y = infoBoxY + 90;

      // ===== RESUMO GERAL =====
      doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Resumo Geral');
      doc.moveDown(0.3);

      const resumoY = doc.y;
      // Box principal de excessos
      doc.rect(50, resumoY, 150, 55).fillAndStroke('#fff3e0', '#ff9800');
      doc.fillColor('#ff9800').fontSize(28).font('Helvetica-Bold')
        .text(estatisticas.totalExcessos.toString(), 55, resumoY + 5, { width: 140, align: 'center' });
      doc.fillColor('#333').fontSize(9).font('Helvetica')
        .text('Excessos de Velocidade', 55, resumoY + 38, { width: 140, align: 'center' });

      // Percentual
      doc.rect(210, resumoY, 110, 55).fillAndStroke('#e3f2fd', '#2196f3');
      doc.fillColor('#2196f3').fontSize(20).font('Helvetica-Bold')
        .text(`${estatisticas.percentualExcessos}%`, 215, resumoY + 10, { width: 100, align: 'center' });
      doc.fillColor('#333').fontSize(9).font('Helvetica')
        .text('do trajeto', 215, resumoY + 38, { width: 100, align: 'center' });

      // Velocidade máxima
      doc.rect(330, resumoY, 100, 55).fillAndStroke('#ffebee', '#f44336');
      doc.fillColor('#f44336').fontSize(18).font('Helvetica-Bold')
        .text(`${estatisticas.velocidadeMaxima}`, 335, resumoY + 8, { width: 90, align: 'center' });
      doc.fillColor('#333').fontSize(9).font('Helvetica')
        .text('km/h máx', 335, resumoY + 28, { width: 90, align: 'center' });

      // Maior excesso
      doc.rect(440, resumoY, 105, 55).fillAndStroke('#fce4ec', '#e91e63');
      doc.fillColor('#e91e63').fontSize(18).font('Helvetica-Bold')
        .text(`+${estatisticas.maiorExcesso}`, 445, resumoY + 8, { width: 95, align: 'center' });
      doc.fillColor('#333').fontSize(9).font('Helvetica')
        .text('km/h acima', 445, resumoY + 28, { width: 95, align: 'center' });

      doc.y = resumoY + 65;

      // ===== CLASSIFICAÇÃO POR GRAVIDADE =====
      doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Classificação por Gravidade');
      doc.moveDown(0.3);

      const gravY = doc.y;
      const gravWidth = 120;

      // Leve (verde)
      doc.rect(50, gravY, gravWidth, 40).fillAndStroke('#e8f5e9', '#4caf50');
      doc.fillColor('#4caf50').fontSize(16).font('Helvetica-Bold')
        .text(excessosLeves.toString(), 50, gravY + 5, { width: gravWidth, align: 'center' });
      doc.fillColor('#333').fontSize(8).font('Helvetica')
        .text('Leve (até 10 km/h)', 50, gravY + 25, { width: gravWidth, align: 'center' });

      // Moderado (amarelo)
      doc.rect(50 + gravWidth + 5, gravY, gravWidth, 40).fillAndStroke('#fff8e1', '#ffc107');
      doc.fillColor('#f57c00').fontSize(16).font('Helvetica-Bold')
        .text(excessosModerados.toString(), 50 + gravWidth + 5, gravY + 5, { width: gravWidth, align: 'center' });
      doc.fillColor('#333').fontSize(8).font('Helvetica')
        .text('Moderado (10-20 km/h)', 50 + gravWidth + 5, gravY + 25, { width: gravWidth, align: 'center' });

      // Grave (laranja)
      doc.rect(50 + (gravWidth + 5) * 2, gravY, gravWidth, 40).fillAndStroke('#fff3e0', '#ff9800');
      doc.fillColor('#e65100').fontSize(16).font('Helvetica-Bold')
        .text(excessosGraves.toString(), 50 + (gravWidth + 5) * 2, gravY + 5, { width: gravWidth, align: 'center' });
      doc.fillColor('#333').fontSize(8).font('Helvetica')
        .text('Grave (20-40 km/h)', 50 + (gravWidth + 5) * 2, gravY + 25, { width: gravWidth, align: 'center' });

      // Muito Grave (vermelho)
      doc.rect(50 + (gravWidth + 5) * 3, gravY, gravWidth, 40).fillAndStroke('#ffebee', '#f44336');
      doc.fillColor('#c62828').fontSize(16).font('Helvetica-Bold')
        .text(excessosMuitoGraves.toString(), 50 + (gravWidth + 5) * 3, gravY + 5, { width: gravWidth, align: 'center' });
      doc.fillColor('#333').fontSize(8).font('Helvetica')
        .text('Muito Grave (+40 km/h)', 50 + (gravWidth + 5) * 3, gravY + 25, { width: gravWidth, align: 'center' });

      doc.y = gravY + 50;

      // ===== TOP VIAS COM MAIS EXCESSOS =====
      if (topVias.length > 0) {
        doc.fillColor('#000').fontSize(14).font('Helvetica-Bold').text('Locais com Mais Excessos');
        doc.moveDown(0.3);

        const topTableY = doc.y;
        const topColWidths = [30, 220, 60, 80, 80];
        const topHeaders = ['#', 'Via / Local', 'Qtd', 'Maior Excesso', 'Vel. Máxima'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, topTableY, 495, 14).fill('#667eea');

        let xPos = 55;
        topHeaders.forEach((header, i) => {
          doc.text(header, xPos, topTableY + 4, { width: topColWidths[i], align: i === 0 ? 'center' : 'left' });
          xPos += topColWidths[i];
        });

        doc.fillColor('#333').font('Helvetica').fontSize(8);
        let yPos = topTableY + 16;

        topVias.forEach(([via, dados], index) => {
          if (index % 2 === 0) {
            doc.rect(50, yPos - 1, 495, 13).fill('#f5f5f5');
            doc.fillColor('#333');
          }

          xPos = 55;
          const viaName = via.length > 40 ? via.substring(0, 37) + '...' : via;
          const topRowData = [
            `${index + 1}`,
            viaName,
            dados.count.toString(),
            `+${dados.maxExcesso} km/h`,
            `${dados.maxVelocidade} km/h`
          ];

          topRowData.forEach((data, i) => {
            doc.text(data, xPos, yPos + 2, { width: topColWidths[i], align: i === 0 ? 'center' : 'left' });
            xPos += topColWidths[i];
          });

          yPos += 13;
        });

        doc.y = yPos + 5;
      }

      // ===== NOVA PÁGINA PARA DETALHAMENTO =====
      doc.addPage();

      // Cabeçalho da segunda página
      doc.rect(0, 0, 595, 50).fill('#667eea');
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#fff')
        .text('DETALHAMENTO DOS EXCESSOS', 50, 18, { align: 'center', width: 495 });

      doc.y = 70;

      // Tabela de excessos detalhada
      if (excessos.length > 0) {
        const tableTop = doc.y;
        const colWidths = [90, 200, 65, 65, 65];
        const headers = ['Data/Hora', 'Via / Local', 'Velocidade', 'Limite', 'Excesso'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#ff9800');

        let xPos = 55;
        headers.forEach((header, i) => {
          doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        doc.fillColor('#333').font('Helvetica').fontSize(7);
        let yPos = tableTop + 18;

        const maxRegistros = 80; // Mais registros por página
        for (const exc of excessos.slice(0, maxRegistros)) {
          if (yPos > 760) {
            doc.addPage();
            // Repetir cabeçalho na nova página
            doc.rect(0, 0, 595, 30).fill('#667eea');
            doc.fontSize(12).font('Helvetica-Bold').fillColor('#fff')
              .text('DETALHAMENTO DOS EXCESSOS (continuação)', 50, 8, { align: 'center', width: 495 });

            yPos = 45;
            doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
            doc.rect(50, yPos, 495, 15).fill('#ff9800');
            xPos = 55;
            headers.forEach((header, i) => {
              doc.text(header, xPos, yPos + 4, { width: colWidths[i], align: 'left' });
              xPos += colWidths[i];
            });
            doc.fillColor('#333').font('Helvetica').fontSize(7);
            yPos += 18;
          }

          const rowIndex = excessos.indexOf(exc);
          if (rowIndex % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#fff8e1');
            doc.fillColor('#333');
          }

          // Formatar nome da via
          let localExcesso = exc.nomeVia || '';
          if (!localExcesso || localExcesso === 'N/A' || localExcesso === 'Via não identificada' || localExcesso === '') {
            localExcesso = `${exc.latitude.toFixed(5)}, ${exc.longitude.toFixed(5)}`;
          } else if (localExcesso.length > 38) {
            localExcesso = localExcesso.substring(0, 35) + '...';
          }

          xPos = 55;
          const rowData = [
            formatDateTime(exc.timestamp),
            localExcesso,
            `${exc.velocidade} km/h`,
            `${exc.limite} km/h`,
            `+${exc.excesso} km/h`
          ];

          rowData.forEach((data, i) => {
            doc.text(data, xPos, yPos, { width: colWidths[i], align: 'left' });
            xPos += colWidths[i];
          });

          yPos += 12;
        }

        if (excessos.length > maxRegistros) {
          doc.moveDown();
          doc.fontSize(9).fillColor('#666');
          doc.text(`Mostrando ${maxRegistros} de ${excessos.length} registros. Use o formato CSV para exportar todos os dados.`, { align: 'center' });
        }
      } else {
        doc.fontSize(12).fillColor('#4caf50').font('Helvetica-Bold');
        doc.text('Nenhum excesso de velocidade registrado no período!', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).fillColor('#666').font('Helvetica');
        doc.text('O condutor respeitou os limites de velocidade durante todo o trajeto.', { align: 'center' });
      }

      // Rodapé em todas as páginas
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        doc.fontSize(8).fillColor('#999').font('Helvetica');
        doc.text(
          `Sistema de Rastreamento Veicular | Página ${i + 1} de ${totalPages}`,
          50, 780, { align: 'center', width: 495 }
        );
      }

      doc.end();

    } else {
      // Gerar CSV
      let csvContent = `RELATÓRIO DE EXCESSOS DE VELOCIDADE
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
IMEI: ${dispositivo.imei}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Gerado em: ${formatDateTime(new Date())}

=== RESUMO ===
Total de Registros GPS: ${estatisticas.totalRegistros}
Total de Excessos: ${estatisticas.totalExcessos}
Percentual de Excessos: ${estatisticas.percentualExcessos}%
Maior Excesso: ${estatisticas.maiorExcesso} km/h acima do limite
Velocidade Máxima Registrada: ${estatisticas.velocidadeMaxima} km/h

=== DETALHAMENTO DOS EXCESSOS ===
Data/Hora,Velocidade (km/h),Limite (km/h),Excesso (km/h),Latitude,Longitude,Via
`;

      for (const exc of excessos) {
        csvContent += `${formatDateTime(exc.timestamp)},${exc.velocidade},${exc.limite},${exc.excesso},${exc.latitude},${exc.longitude},"${(exc.nomeVia || '').replace(/"/g, '""')}"\n`;
      }

      const filename = `excessos_velocidade_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }

  } catch (error) {
    console.error('[Relatório Velocidade] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO DE TEMPO OCIOSO ============

/**
 * GET /api/relatorios/ocioso/:imei
 * Relatório detalhado de tempo ocioso (veículo parado com motor ligado)
 */
router.get('/ocioso/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv',
      tempoMinimo = '5' // Tempo mínimo em minutos para considerar ocioso
    } = req.query;

    const tempoMinimoMin = parseInt(tempoMinimo) || 5;

    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Expandir para todos os dispositivos do veículo (histórico de trocas de rastreador)
    const dispositivoIds = await expandirDispositivosDoVeiculo(dispositivo.id, inicio, fim);

    // Buscar localizações de TODOS os dispositivos do veículo
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum registro encontrado no período selecionado'
      });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Identificar períodos ociosos
    const periodosOciosos = [];
    let inicioOcioso = null;
    let latOcioso = null;
    let lonOcioso = null;

    for (let i = 0; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const velocidade = loc.velocidade || 0;
      const ignicao = loc.ignicao;

      // Ocioso = ignição ligada + velocidade = 0
      const estaOcioso = ignicao === true && velocidade === 0;

      if (estaOcioso && !inicioOcioso) {
        // Início de período ocioso
        inicioOcioso = loc.timestamp;
        latOcioso = loc.latitude;
        lonOcioso = loc.longitude;
      } else if (!estaOcioso && inicioOcioso) {
        // Fim de período ocioso
        const duracao = (new Date(loc.timestamp) - new Date(inicioOcioso)) / (1000 * 60);

        if (duracao >= tempoMinimoMin) {
          periodosOciosos.push({
            inicio: inicioOcioso,
            fim: loc.timestamp,
            duracao: duracao,
            latitude: latOcioso,
            longitude: lonOcioso
          });
        }

        inicioOcioso = null;
        latOcioso = null;
        lonOcioso = null;
      }
    }

    // Verificar se ainda está ocioso no final
    if (inicioOcioso) {
      const ultimaLoc = localizacoes[localizacoes.length - 1];
      const duracao = (new Date(ultimaLoc.timestamp) - new Date(inicioOcioso)) / (1000 * 60);

      if (duracao >= tempoMinimoMin) {
        periodosOciosos.push({
          inicio: inicioOcioso,
          fim: ultimaLoc.timestamp,
          duracao: duracao,
          latitude: latOcioso,
          longitude: lonOcioso,
          emAndamento: true
        });
      }
    }

    // Estatísticas
    const tempoTotalOcioso = periodosOciosos.reduce((sum, p) => sum + p.duracao, 0);
    const mediaOcioso = periodosOciosos.length > 0 ? tempoTotalOcioso / periodosOciosos.length : 0;
    const maiorOcioso = periodosOciosos.length > 0 ? Math.max(...periodosOciosos.map(p => p.duracao)) : 0;

    const estatisticas = {
      totalPeriodos: periodosOciosos.length,
      tempoTotalOcioso: tempoTotalOcioso,
      tempoTotalOciosoFormatado: formatarTempo(tempoTotalOcioso),
      mediaOcioso: formatarTempo(mediaOcioso),
      maiorOcioso: formatarTempo(maiorOcioso)
    };

    if (formato === 'pdf') {
      // Gerar PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Relatório de Tempo Ocioso - ${dispositivo.placa || imei}`,
          Author: 'Sistema de Rastreamento'
        }
      });

      const filename = `tempo_ocioso_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // Cabeçalho
      doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE TEMPO OCIOSO', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#667eea');
      doc.moveDown(0.5);

      // Informações do veículo
      doc.fontSize(12).font('Helvetica-Bold').text('Informações do Veículo');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'}`);
      doc.text(`Placa: ${dispositivo.placa || 'N/A'}`);
      doc.text(`IMEI: ${dispositivo.imei}`);
      doc.text(`Motorista(s): ${motoristas.length > 0 ? motoristas.map(m => m.nome).join(', ') : 'Nenhum vinculado'}`);
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.text(`Tempo mínimo considerado: ${tempoMinimoMin} minutos`);
      doc.moveDown();

      // Estatísticas
      doc.fontSize(12).font('Helvetica-Bold').text('Resumo');
      const statsY = doc.y;
      doc.rect(50, statsY, 495, 70).fillAndStroke('#e3f2fd', '#2196f3');

      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Total de Períodos Ociosos: ${estatisticas.totalPeriodos}`, 60, statsY + 10);
      doc.text(`Tempo Total Ocioso: ${estatisticas.tempoTotalOciosoFormatado}`, 60, statsY + 25);
      doc.text(`Média por Período: ${estatisticas.mediaOcioso}`, 300, statsY + 10);
      doc.text(`Maior Período: ${estatisticas.maiorOcioso}`, 300, statsY + 25);

      doc.y = statsY + 80;
      doc.moveDown();

      // Tabela de períodos
      if (periodosOciosos.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Detalhamento dos Períodos Ociosos');
        doc.moveDown(0.5);

        const tableTop = doc.y;
        const colWidths = [120, 120, 80, 165];
        const headers = ['Início', 'Fim', 'Duração', 'Localização'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#2196f3');

        let xPos = 55;
        headers.forEach((header, i) => {
          doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        doc.fillColor('#000').font('Helvetica').fontSize(8);
        let yPos = tableTop + 18;

        for (const periodo of periodosOciosos) {
          if (yPos > 750) {
            doc.addPage();
            yPos = 50;
          }

          if (periodosOciosos.indexOf(periodo) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#e3f2fd');
            doc.fillColor('#000');
          }

          xPos = 55;
          const rowData = [
            formatDateTime(periodo.inicio),
            periodo.emAndamento ? 'Em andamento' : formatDateTime(periodo.fim),
            formatarTempo(periodo.duracao),
            `${periodo.latitude.toFixed(5)}, ${periodo.longitude.toFixed(5)}`
          ];

          rowData.forEach((data, i) => {
            doc.text(data, xPos, yPos, { width: colWidths[i], align: 'left' });
            xPos += colWidths[i];
          });

          yPos += 12;
        }
      }

      // Rodapé
      doc.fontSize(8).fillColor('#999');
      doc.text('Sistema de Rastreamento Veicular - Relatório gerado automaticamente', 50, 780, { align: 'center', width: 495 });

      doc.end();

    } else {
      // Gerar CSV
      let csvContent = `RELATÓRIO DE TEMPO OCIOSO
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
IMEI: ${dispositivo.imei}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Tempo mínimo considerado: ${tempoMinimoMin} minutos
Gerado em: ${formatDateTime(new Date())}

=== RESUMO ===
Total de Períodos Ociosos: ${estatisticas.totalPeriodos}
Tempo Total Ocioso: ${estatisticas.tempoTotalOciosoFormatado}
Média por Período: ${estatisticas.mediaOcioso}
Maior Período: ${estatisticas.maiorOcioso}

=== DETALHAMENTO DOS PERÍODOS OCIOSOS ===
Início,Fim,Duração (min),Latitude,Longitude,Em Andamento
`;

      for (const periodo of periodosOciosos) {
        csvContent += `${formatDateTime(periodo.inicio)},${periodo.emAndamento ? 'Em andamento' : formatDateTime(periodo.fim)},${periodo.duracao.toFixed(1)},${periodo.latitude},${periodo.longitude},${periodo.emAndamento ? 'Sim' : 'Não'}\n`;
      }

      const filename = `tempo_ocioso_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }

  } catch (error) {
    console.error('[Relatório Ocioso] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO DE QUILOMETRAGEM ============

/**
 * GET /api/relatorios/quilometragem/:imei
 * Relatório detalhado de quilometragem diária
 */
router.get('/quilometragem/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv'
    } = req.query;

    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Último 7 dias
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Expandir para todos os dispositivos do veículo (histórico de trocas de rastreador)
    const dispositivoIds = await expandirDispositivosDoVeiculo(dispositivo.id, inicio, fim);

    // Buscar localizações de TODOS os dispositivos do veículo
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: { in: dispositivoIds },
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum registro encontrado no período selecionado'
      });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Agrupar por dia
    const quilometragemPorDia = {};
    let distanciaTotal = 0;

    for (let i = 1; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const locAnterior = localizacoes[i - 1];

      const dist = calcularDistancia(
        locAnterior.latitude, locAnterior.longitude,
        loc.latitude, loc.longitude
      );

      // Filtrar distâncias muito grandes (erro de GPS)
      if (dist < 50) { // Máximo 50km entre pontos consecutivos
        const dia = new Date(loc.timestamp).toISOString().split('T')[0];

        if (!quilometragemPorDia[dia]) {
          quilometragemPorDia[dia] = {
            data: dia,
            distancia: 0,
            primeiraLoc: locAnterior.timestamp,
            ultimaLoc: loc.timestamp,
            pontos: 1
          };
        }

        quilometragemPorDia[dia].distancia += dist;
        quilometragemPorDia[dia].ultimaLoc = loc.timestamp;
        quilometragemPorDia[dia].pontos++;
        distanciaTotal += dist;
      }
    }

    const diasComDados = Object.values(quilometragemPorDia).sort((a, b) => a.data.localeCompare(b.data));

    // Estatísticas
    const mediaKmDia = diasComDados.length > 0 ? distanciaTotal / diasComDados.length : 0;
    const maiorKmDia = diasComDados.length > 0 ? Math.max(...diasComDados.map(d => d.distancia)) : 0;
    const menorKmDia = diasComDados.length > 0 ? Math.min(...diasComDados.map(d => d.distancia)) : 0;

    const estatisticas = {
      distanciaTotal: distanciaTotal.toFixed(2),
      diasComDados: diasComDados.length,
      mediaKmDia: mediaKmDia.toFixed(2),
      maiorKmDia: maiorKmDia.toFixed(2),
      menorKmDia: menorKmDia.toFixed(2)
    };

    if (formato === 'pdf') {
      // Gerar PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Relatório de Quilometragem - ${dispositivo.placa || imei}`,
          Author: 'Sistema de Rastreamento'
        }
      });

      const filename = `quilometragem_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // Cabeçalho
      doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE QUILOMETRAGEM', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#667eea');
      doc.moveDown(0.5);

      // Informações do veículo
      doc.fontSize(12).font('Helvetica-Bold').text('Informações do Veículo');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'}`);
      doc.text(`Placa: ${dispositivo.placa || 'N/A'}`);
      doc.text(`IMEI: ${dispositivo.imei}`);
      doc.text(`Motorista(s): ${motoristas.length > 0 ? motoristas.map(m => m.nome).join(', ') : 'Nenhum vinculado'}`);
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.moveDown();

      // Estatísticas
      doc.fontSize(12).font('Helvetica-Bold').text('Resumo');
      const statsY = doc.y;
      doc.rect(50, statsY, 495, 85).fillAndStroke('#e8f5e9', '#4caf50');

      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Distância Total: ${estatisticas.distanciaTotal} km`, 60, statsY + 10);
      doc.text(`Dias com Dados: ${estatisticas.diasComDados}`, 60, statsY + 25);
      doc.text(`Média Diária: ${estatisticas.mediaKmDia} km/dia`, 60, statsY + 40);
      doc.text(`Maior Quilometragem: ${estatisticas.maiorKmDia} km`, 300, statsY + 10);
      doc.text(`Menor Quilometragem: ${estatisticas.menorKmDia} km`, 300, statsY + 25);

      doc.y = statsY + 95;
      doc.moveDown();

      // Tabela por dia
      if (diasComDados.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Quilometragem Diária');
        doc.moveDown(0.5);

        const tableTop = doc.y;
        const colWidths = [100, 120, 120, 80, 75];
        const headers = ['Data', 'Primeira Loc.', 'Última Loc.', 'Distância', 'Registros'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#4caf50');

        let xPos = 55;
        headers.forEach((header, i) => {
          doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        doc.fillColor('#000').font('Helvetica').fontSize(8);
        let yPos = tableTop + 18;

        for (const dia of diasComDados) {
          if (yPos > 750) {
            doc.addPage();
            yPos = 50;
          }

          if (diasComDados.indexOf(dia) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#e8f5e9');
            doc.fillColor('#000');
          }

          const dataFormatada = new Date(dia.data + 'T12:00:00').toLocaleDateString('pt-BR', {
            weekday: 'short',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
          });

          xPos = 55;
          const rowData = [
            dataFormatada,
            formatDateTime(dia.primeiraLoc),
            formatDateTime(dia.ultimaLoc),
            `${dia.distancia.toFixed(2)} km`,
            dia.pontos.toString()
          ];

          rowData.forEach((data, i) => {
            doc.text(data, xPos, yPos, { width: colWidths[i], align: 'left' });
            xPos += colWidths[i];
          });

          yPos += 12;
        }
      }

      // Rodapé
      doc.fontSize(8).fillColor('#999');
      doc.text('Sistema de Rastreamento Veicular - Relatório gerado automaticamente', 50, 780, { align: 'center', width: 495 });

      doc.end();

    } else {
      // Gerar CSV
      let csvContent = `RELATÓRIO DE QUILOMETRAGEM
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
IMEI: ${dispositivo.imei}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Gerado em: ${formatDateTime(new Date())}

=== RESUMO ===
Distância Total: ${estatisticas.distanciaTotal} km
Dias com Dados: ${estatisticas.diasComDados}
Média Diária: ${estatisticas.mediaKmDia} km/dia
Maior Quilometragem: ${estatisticas.maiorKmDia} km
Menor Quilometragem: ${estatisticas.menorKmDia} km

=== QUILOMETRAGEM DIÁRIA ===
Data,Primeira Localização,Última Localização,Distância (km),Registros
`;

      for (const dia of diasComDados) {
        csvContent += `${dia.data},${formatDateTime(dia.primeiraLoc)},${formatDateTime(dia.ultimaLoc)},${dia.distancia.toFixed(2)},${dia.pontos}\n`;
      }

      const filename = `quilometragem_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }

  } catch (error) {
    console.error('[Relatório Quilometragem] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RESUMO DA FROTA ============

/**
 * GET /api/relatorios/frota
 * Relatório resumido de toda a frota (todos os veículos da organização)
 */
router.get('/frota', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const {
      dataInicio,
      dataFim,
      formato = 'csv',
      imei, // Filtro opcional por veículo(s) - pode ser string única ou array
      tags,  // Filtro opcional por tags - pode ser string única ou array de IDs
      motorista, // Filtro opcional por motorista(s) - pode ser ID único ou array de IDs
      // Filtros avançados
      modulos = '', // Módulos a incluir no relatório
      soExcessos = 'false', // Só mostrar excessos de velocidade
      velAcima80 = 'false',
      velAcima100 = 'false',
      velAcima120 = 'false',
      incluirExcessos = 'false', // Incluir detalhes de excessos
      incluirViagens = 'false',
      incluirScore = 'false',
      incluirOcioso = 'false',
      geofenceIds = '',
      tiposAlarme = ''
    } = req.query;

    // Parsear filtros booleanos
    const filtroSoExcessos = soExcessos === 'true';
    const filtroVelAcima80 = velAcima80 === 'true';
    const filtroVelAcima100 = velAcima100 === 'true';
    const filtroVelAcima120 = velAcima120 === 'true';
    const incluirDetalhesExcessos = incluirExcessos === 'true';
    const incluirDetalhesViagens = incluirViagens === 'true';
    const incluirDetalhesScore = incluirScore === 'true';
    const incluirDetalhesOcioso = incluirOcioso === 'true';

    // Parsear IDs de geofences e tipos de alarme
    const geofenceIdsFiltro = geofenceIds ? geofenceIds.split(',').map(id => parseInt(id)).filter(id => !isNaN(id)) : [];
    const tiposAlarmeFiltro = tiposAlarme ? tiposAlarme.split(',').filter(t => t.trim()) : [];
    const modulosSelecionados = modulos ? modulos.split(',').filter(m => m.trim()) : [];

    // Determinar limite de velocidade baseado nos filtros
    let limiteVelocidadeFiltro = 0;
    if (filtroVelAcima120) limiteVelocidadeFiltro = 120;
    else if (filtroVelAcima100) limiteVelocidadeFiltro = 100;
    else if (filtroVelAcima80) limiteVelocidadeFiltro = 80;
    else if (filtroSoExcessos) limiteVelocidadeFiltro = 80; // Padrão para excessos

    console.log('[Relatórios/frota] Filtros:', {
      soExcessos: filtroSoExcessos,
      limiteVelocidade: limiteVelocidadeFiltro,
      modulos: modulosSelecionados,
      geofences: geofenceIdsFiltro,
      alarmes: tiposAlarmeFiltro,
      viagens: incluirDetalhesViagens
    });

    // Multi-tenant: usar filtro do tenant
    const tenantFilter = req.tenantFilter || {};

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Buscar dispositivos (filtrar por IMEI(s) se especificado)
    const whereClause = { ...tenantFilter };
    if (imei) {
      // Suportar array de IMEIs ou IMEI único
      const imeis = Array.isArray(imei) ? imei : [imei];
      whereClause.imei = { in: imeis };
      console.log('[Relatórios/frota] Filtrando por IMEIs:', imeis);
    }

    // Filtrar por tags (veículos que tenham pelo menos uma das tags selecionadas)
    if (tags) {
      const tagIds = (Array.isArray(tags) ? tags : [tags]).map(t => parseInt(t)).filter(t => !isNaN(t));
      if (tagIds.length > 0) {
        whereClause.veiculo_rel = {
          tags: {
            some: {
              tag_id: { in: tagIds }
            }
          }
        };
        console.log('[Relatórios/frota] Filtrando por tags:', tagIds);
      }
    }

    // Filtrar por motorista (vinculado atualmente ou no período)
    let motoristaIds = [];
    if (motorista) {
      motoristaIds = (Array.isArray(motorista) ? motorista : [motorista])
        .map(m => parseInt(m))
        .filter(m => !isNaN(m));

      if (motoristaIds.length > 0) {
        // Buscar dispositivos que têm esse motorista vinculado atualmente
        // OU que tiveram esse motorista vinculado no período
        whereClause.OR = [
          // Motorista atualmente vinculado
          { motorista_id: { in: motoristaIds } },
          // Motorista vinculado no período (via histórico)
          {
            historicoMotoristas: {
              some: {
                motorista_id: { in: motoristaIds },
                inicio: { lte: fim },
                OR: [
                  { fim: { gte: inicio } },
                  { fim: null }
                ]
              }
            }
          }
        ];
        console.log('[Relatórios/frota] Filtrando por motoristas:', motoristaIds);
      }
    }

    console.log('[Relatórios/frota] whereClause:', JSON.stringify(whereClause));

    const dispositivos = await prisma.dispositivo.findMany({
      where: whereClause,
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

    console.log('[Relatórios/frota] Dispositivos encontrados:', dispositivos.length);

    // Se nenhum dispositivo encontrado, retornar lista vazia (não 404)
    if (dispositivos.length === 0) {
      return res.json({
        sucesso: true,
        veiculos: [],
        periodo: { inicio, fim },
        mensagem: 'Nenhum veículo encontrado com os filtros aplicados'
      });
    }

    // Calcular estatísticas para cada veículo (em paralelo para maior velocidade)
    const LIMITE_EXCESSO_PADRAO = limiteVelocidadeFiltro > 0 ? limiteVelocidadeFiltro : 80;

    // Se filtrar por poucos veículos, buscar todos os registros para precisão
    // Se buscar muitos, limitar para performance (10000 = ~27h de dados a 6 pkt/min)
    const limiteRegistros = dispositivos.length <= 5 ? undefined : 10000;

    const processarVeiculo = async (dispositivo) => {
      // Construir where para localizações
      const whereLocalizacao = {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      };

      // Se filtro de velocidade ativo, só buscar registros acima do limite
      if (limiteVelocidadeFiltro > 0) {
        whereLocalizacao.velocidade = { gt: limiteVelocidadeFiltro };
      }

      // Buscar localizações com campos mínimos necessários
      const localizacoes = await prisma.localizacao.findMany({
        where: whereLocalizacao,
        select: {
          timestamp: true,
          latitude: true,
          longitude: true,
          velocidade: true,
          ignicao: true,
          estado_ignicao: true
        },
        orderBy: { timestamp: 'asc' },
        take: limiteRegistros
      });

      // Se filtro de velocidade ativo, também buscar total de registros no período (para estatísticas)
      let totalRegistrosNoPeriodo = localizacoes.length;
      if (limiteVelocidadeFiltro > 0) {
        totalRegistrosNoPeriodo = await prisma.localizacao.count({
          where: {
            dispositivo_id: dispositivo.id,
            timestamp: { gte: inicio, lte: fim }
          }
        });
      }

      // Buscar última localização (posição atual)
      const ultimaLocalizacao = await prisma.localizacao.findFirst({
        where: { dispositivo_id: dispositivo.id },
        select: {
          timestamp: true,
          latitude: true,
          longitude: true,
          velocidade: true,
          ignicao: true
        },
        orderBy: { timestamp: 'desc' }
      });

      let distanciaMovimento = 0; // Só conta km quando em movimento (consistente com veiculo-detalhes)
      let tempoMovimento = 0;
      let tempoOcioso = 0;
      let velocidadeMax = 0;
      let excessosVelocidade = 0;

      // Contadores de excessos por faixa
      let excessos80_100 = 0;
      let excessos100_120 = 0;
      let excessos120plus = 0;
      let listaExcessos = []; // Detalhes de cada excesso

      for (let i = 1; i < localizacoes.length; i++) {
        const loc = localizacoes[i];
        const locAnterior = localizacoes[i - 1];

        const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

        // Ignorar gaps muito grandes (> 30 min = provavelmente desligado)
        if (tempoMinutos > 30) continue;

        if (loc.velocidade > 0) {
          // Em movimento - calcular distância
          const dist = calcularDistancia(
            locAnterior.latitude, locAnterior.longitude,
            loc.latitude, loc.longitude
          );

          // Filtrar distâncias irreais (erro GPS)
          if (dist < 5) { // Máximo 5km entre pontos consecutivos
            distanciaMovimento += dist;
          }

          tempoMovimento += tempoMinutos;

          if (loc.velocidade > velocidadeMax) {
            velocidadeMax = loc.velocidade;
          }

          // Contar excessos por faixa
          if (loc.velocidade > 120) {
            excessos120plus++;
            excessosVelocidade++;
            if (incluirDetalhesExcessos && listaExcessos.length < 50) {
              listaExcessos.push({
                timestamp: loc.timestamp,
                velocidade: loc.velocidade,
                latitude: loc.latitude,
                longitude: loc.longitude,
                faixa: '120+'
              });
            }
          } else if (loc.velocidade > 100) {
            excessos100_120++;
            excessosVelocidade++;
            if (incluirDetalhesExcessos && listaExcessos.length < 50) {
              listaExcessos.push({
                timestamp: loc.timestamp,
                velocidade: loc.velocidade,
                latitude: loc.latitude,
                longitude: loc.longitude,
                faixa: '100-120'
              });
            }
          } else if (loc.velocidade > 80) {
            excessos80_100++;
            excessosVelocidade++;
            if (incluirDetalhesExcessos && listaExcessos.length < 50) {
              listaExcessos.push({
                timestamp: loc.timestamp,
                velocidade: loc.velocidade,
                latitude: loc.latitude,
                longitude: loc.longitude,
                faixa: '80-100'
              });
            }
          }
        } else {
          // Parado - verificar se é ocioso ou desligado
          // Usar mesma logica do Excel para consistencia
          let isOcioso = false;

          if (loc.estado_ignicao) {
            // estado_ignicao é a fonte mais confiável
            isOcioso = loc.estado_ignicao === 'idle';
          } else if (loc.ignicao === true || loc.ignicao === 1) {
            // Fallback: ignicao ligada com velocidade 0 = ocioso
            isOcioso = true;
          }

          if (isOcioso) {
            tempoOcioso += tempoMinutos;
          }
        }
      }

      // Buscar motoristas vinculados no período
      const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);

      // Extrair tags do veículo
      const veiculoTags = dispositivo.veiculo_rel?.tags?.map(vt => ({
        id: vt.tag.id,
        nome: vt.tag.nome,
        cor: vt.tag.cor
      })) || [];

      // Buscar alarmes no período (se filtro de alarmes ativo ou módulo selecionado)
      let totalAlarmes = 0;
      let alarmesPorTipo = {};
      if (tiposAlarmeFiltro.length > 0 || modulosSelecionados.includes('alarmes')) {
        const whereAlarme = {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        };
        if (tiposAlarmeFiltro.length > 0) {
          whereAlarme.tipo_alarme = { in: tiposAlarmeFiltro };
        }
        const alarmes = await prisma.alarme.findMany({
          where: whereAlarme,
          select: { tipo_alarme: true }
        });
        totalAlarmes = alarmes.length;
        alarmes.forEach(a => {
          alarmesPorTipo[a.tipo_alarme] = (alarmesPorTipo[a.tipo_alarme] || 0) + 1;
        });
      }

      // Buscar viagens no período (se incluirViagens ativo ou módulo selecionado)
      let totalViagens = 0;
      let kmViagens = 0;
      let tempoViagens = 0;
      if (incluirDetalhesViagens || modulosSelecionados.includes('viagens')) {
        const viagens = await prisma.viagem.findMany({
          where: {
            dispositivo_id: dispositivo.id,
            inicio: { gte: inicio, lte: fim }
          },
          select: { distancia_km: true, inicio: true, fim: true }
        });
        totalViagens = viagens.length;
        viagens.forEach(v => {
          kmViagens += v.distancia_km || 0;
          if (v.inicio && v.fim) {
            tempoViagens += (new Date(v.fim) - new Date(v.inicio)) / (1000 * 60);
          }
        });
      }

      // Geofences - TODO: Implementar quando tabela de eventos existir
      let dentroGeofence = false;
      let geofencesVisitados = [];
      // Por enquanto, geofences não são processados no relatório consolidado

      return {
        placa: dispositivo.placa || 'N/A',
        veiculo: dispositivo.veiculo || 'N/A',
        imei: dispositivo.imei,
        tipo: dispositivo.tipo || 'N/A',
        motorista: motoristas.length > 0 ? motoristas[motoristas.length - 1].nome : 'N/A',
        motoristas: motoristas.map(m => m.nome).join(', ') || 'Nenhum',
        status: dispositivo.status || 'offline',
        estado_ignicao: dispositivo.estado_ignicao || 'off',
        estado_movimento: dispositivo.estado_ignicao === 'moving' ? 'movimento' : dispositivo.estado_ignicao === 'idle' ? 'ocioso' : 'parado',
        // Dados da última localização
        latitude: ultimaLocalizacao?.latitude || null,
        longitude: ultimaLocalizacao?.longitude || null,
        velocidade: ultimaLocalizacao?.velocidade || 0,
        ignicao: ultimaLocalizacao?.ignicao ?? null,
        ultima_atualizacao: ultimaLocalizacao?.timestamp || dispositivo.ultima_conexao || null,
        distanciaTotal: distanciaMovimento.toFixed(2),
        tempoMovimento: formatarTempo(tempoMovimento),
        tempoMovimentoMinutos: Math.round(tempoMovimento),
        tempoOcioso: formatarTempo(tempoOcioso),
        tempoOciosoMinutos: Math.round(tempoOcioso),
        velocidadeMax: velocidadeMax,
        excessosVelocidade: excessosVelocidade,
        // Excessos por faixa
        excessos80_100: excessos80_100,
        excessos100_120: excessos100_120,
        excessos120plus: excessos120plus,
        // Detalhes de excessos (se solicitado)
        listaExcessos: incluirDetalhesExcessos ? listaExcessos : undefined,
        totalRegistros: limiteVelocidadeFiltro > 0 ? totalRegistrosNoPeriodo : localizacoes.length,
        registrosFiltrados: limiteVelocidadeFiltro > 0 ? localizacoes.length : undefined,
        tags: veiculoTags,
        // Alarmes
        totalAlarmes: totalAlarmes,
        alarmesPorTipo: alarmesPorTipo,
        // Viagens
        totalViagens: totalViagens,
        kmViagens: kmViagens.toFixed(2),
        tempoViagens: formatarTempo(tempoViagens),
        // Geofences
        geofencesVisitados: geofencesVisitados.length,
        dentroGeofence: dentroGeofence
      };
    };

    // Processar todos os veículos em paralelo
    const resumoFrota = await Promise.all(dispositivos.map(processarVeiculo));

    // Ordenar por distância (maior primeiro)
    resumoFrota.sort((a, b) => parseFloat(b.distanciaTotal) - parseFloat(a.distanciaTotal));

    // Estatísticas gerais
    const distanciaTotalFrota = resumoFrota.reduce((sum, v) => sum + parseFloat(v.distanciaTotal), 0);
    const veiculosAtivos = resumoFrota.filter(v => v.totalRegistros > 0).length;

    const estatisticas = {
      totalVeiculos: dispositivos.length,
      veiculosAtivos: veiculosAtivos,
      distanciaTotalFrota: distanciaTotalFrota.toFixed(2),
      mediaKmVeiculo: dispositivos.length > 0 ? (distanciaTotalFrota / dispositivos.length).toFixed(2) : '0'
    };

    // Retornar JSON para frontend
    if (formato === 'json') {
      return res.json({
        sucesso: true,
        estatisticas,
        veiculos: resumoFrota,
        periodo: {
          inicio: inicio.toISOString(),
          fim: fim.toISOString()
        }
      });
    }

    if (formato === 'pdf') {
      // Gerar PDF
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: 'Resumo da Frota',
          Author: 'Sistema de Rastreamento'
        }
      });

      const filename = `resumo_frota_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      doc.pipe(res);

      // Cabeçalho
      doc.fontSize(18).font('Helvetica-Bold').text('RESUMO DA FROTA', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#667eea');
      doc.moveDown(0.5);

      // Período
      doc.fontSize(10).font('Helvetica');
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.text(`Gerado em: ${formatDateTime(new Date())}`);
      doc.moveDown();

      // Estatísticas gerais
      doc.fontSize(12).font('Helvetica-Bold').text('Estatísticas Gerais');
      const statsY = doc.y;
      doc.rect(50, statsY, 495, 55).fillAndStroke('#e8eaf6', '#3f51b5');

      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Total de Veículos: ${estatisticas.totalVeiculos}`, 60, statsY + 10);
      doc.text(`Veículos Ativos no Período: ${estatisticas.veiculosAtivos}`, 60, statsY + 25);
      doc.text(`Distância Total da Frota: ${estatisticas.distanciaTotalFrota} km`, 300, statsY + 10);
      doc.text(`Média por Veículo: ${estatisticas.mediaKmVeiculo} km`, 300, statsY + 25);

      doc.y = statsY + 65;
      doc.moveDown();

      // Tabela de veículos
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Detalhamento por Veículo');
      doc.moveDown(0.5);

      const tableTop = doc.y;
      const colWidths = [55, 75, 75, 50, 50, 50, 50, 50];
      const headers = ['Placa', 'Veículo', 'Motorista', 'Dist.', 'Mov.', 'Ocioso', 'V.Máx', 'Reg.'];

      doc.fontSize(6).font('Helvetica-Bold').fillColor('#fff');
      doc.rect(50, tableTop, 495, 15).fill('#3f51b5');

      let xPos = 52;
      headers.forEach((header, i) => {
        doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
        xPos += colWidths[i];
      });

      doc.fillColor('#000').font('Helvetica').fontSize(6);
      let yPos = tableTop + 18;

      for (const veiculo of resumoFrota) {
        if (yPos > 750) {
          doc.addPage();
          yPos = 50;
        }

        if (resumoFrota.indexOf(veiculo) % 2 === 0) {
          doc.rect(50, yPos - 2, 495, 12).fill('#e8eaf6');
          doc.fillColor('#000');
        }

        xPos = 55;
        const rowData = [
          veiculo.placa,
          (veiculo.veiculo || '').substring(0, 12),
          (veiculo.motorista || 'N/A').substring(0, 12),
          `${veiculo.distanciaTotal}`,
          veiculo.tempoMovimento,
          veiculo.tempoOcioso,
          `${veiculo.velocidadeMax}`,
          veiculo.totalRegistros.toString()
        ];

        rowData.forEach((data, i) => {
          doc.text(data, xPos, yPos, { width: colWidths[i], align: 'left' });
          xPos += colWidths[i];
        });

        yPos += 12;
      }

      // Rodapé
      doc.fontSize(8).fillColor('#999');
      doc.text('Sistema de Rastreamento Veicular - Relatório gerado automaticamente', 50, 780, { align: 'center', width: 495 });

      doc.end();

    } else if (formato === 'xlsx') {
      // Gerar Excel
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Sistema de Rastreamento';
      workbook.created = new Date();

      // Aba de Resumo
      const resumoSheet = workbook.addWorksheet('Resumo');

      // Título
      resumoSheet.mergeCells('A1:J1');
      resumoSheet.getCell('A1').value = 'RESUMO DA FROTA';
      resumoSheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF3F51B5' } };
      resumoSheet.getCell('A1').alignment = { horizontal: 'center' };

      // Período e data de geração
      resumoSheet.getCell('A3').value = `Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`;
      resumoSheet.getCell('A4').value = `Gerado em: ${formatDateTime(new Date())}`;

      // Filtros aplicados
      let filtrosTexto = [];
      if (limiteVelocidadeFiltro > 0) filtrosTexto.push(`Velocidade > ${limiteVelocidadeFiltro} km/h`);
      if (geofenceIdsFiltro.length > 0) filtrosTexto.push(`${geofenceIdsFiltro.length} geofence(s)`);
      if (tiposAlarmeFiltro.length > 0) filtrosTexto.push(`Alarmes: ${tiposAlarmeFiltro.join(', ')}`);
      if (incluirDetalhesViagens) filtrosTexto.push('Incluir viagens');
      if (filtrosTexto.length > 0) {
        resumoSheet.getCell('A5').value = `Filtros: ${filtrosTexto.join(' | ')}`;
        resumoSheet.getCell('A5').font = { italic: true, color: { argb: 'FF666666' } };
      }

      // Estatísticas gerais
      resumoSheet.getCell('A7').value = 'ESTATÍSTICAS GERAIS';
      resumoSheet.getCell('A7').font = { bold: true, size: 12 };

      resumoSheet.getCell('A8').value = 'Total de Veículos:';
      resumoSheet.getCell('B8').value = estatisticas.totalVeiculos;
      resumoSheet.getCell('A9').value = 'Veículos Ativos:';
      resumoSheet.getCell('B9').value = estatisticas.veiculosAtivos;
      resumoSheet.getCell('A10').value = 'Distância Total (km):';
      resumoSheet.getCell('B10').value = parseFloat(estatisticas.distanciaTotalFrota);
      resumoSheet.getCell('A11').value = 'Média por Veículo (km):';
      resumoSheet.getCell('B11').value = parseFloat(estatisticas.mediaKmVeiculo);

      // Total de excessos
      const totalExcessos = resumoFrota.reduce((sum, v) => sum + v.excessosVelocidade, 0);
      const totalExcessos80 = resumoFrota.reduce((sum, v) => sum + v.excessos80_100, 0);
      const totalExcessos100 = resumoFrota.reduce((sum, v) => sum + v.excessos100_120, 0);
      const totalExcessos120 = resumoFrota.reduce((sum, v) => sum + v.excessos120plus, 0);
      resumoSheet.getCell('D8').value = 'Total Excessos:';
      resumoSheet.getCell('E8').value = totalExcessos;
      resumoSheet.getCell('D9').value = '80-100 km/h:';
      resumoSheet.getCell('E9').value = totalExcessos80;
      resumoSheet.getCell('D10').value = '100-120 km/h:';
      resumoSheet.getCell('E10').value = totalExcessos100;
      resumoSheet.getCell('D11').value = '>120 km/h:';
      resumoSheet.getCell('E11').value = totalExcessos120;
      resumoSheet.getCell('E11').font = { color: { argb: 'FFFF0000' } };

      // Construir cabeçalhos dinamicamente baseado nos filtros
      const headerRow = resumoSheet.getRow(14);
      let headers = ['Placa', 'Veículo', 'Motorista(s)', 'IMEI', 'Dist (km)', 'T.Mov', 'T.Ocioso', 'V.Máx', 'Excessos', '80-100', '100-120', '>120'];

      // Adicionar colunas extras baseado nos filtros
      const temAlarmes = tiposAlarmeFiltro.length > 0 || modulosSelecionados.includes('alarmes');
      const temViagens = incluirDetalhesViagens || modulosSelecionados.includes('viagens');
      const temGeofences = geofenceIdsFiltro.length > 0;

      if (temAlarmes) headers.push('Alarmes');
      if (temViagens) headers.push('Viagens', 'Km Viag.');
      if (temGeofences) headers.push('Geofences');
      headers.push('Registros');

      headers.forEach((h, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F51B5' } };
        cell.alignment = { horizontal: 'center' };
      });

      // Dados dos veículos
      resumoFrota.forEach((veiculo, idx) => {
        const row = resumoSheet.getRow(15 + idx);
        let col = 1;
        row.getCell(col++).value = veiculo.placa;
        row.getCell(col++).value = veiculo.veiculo;
        row.getCell(col++).value = veiculo.motoristas || 'N/A';
        row.getCell(col++).value = veiculo.imei;
        row.getCell(col++).value = parseFloat(veiculo.distanciaTotal);
        row.getCell(col++).value = veiculo.tempoMovimento;
        row.getCell(col++).value = veiculo.tempoOcioso;
        row.getCell(col++).value = veiculo.velocidadeMax;
        row.getCell(col++).value = veiculo.excessosVelocidade;
        row.getCell(col++).value = veiculo.excessos80_100;
        row.getCell(col++).value = veiculo.excessos100_120;
        const col120 = col;
        row.getCell(col++).value = veiculo.excessos120plus;

        // Colunas extras
        if (temAlarmes) row.getCell(col++).value = veiculo.totalAlarmes;
        if (temViagens) {
          row.getCell(col++).value = veiculo.totalViagens;
          row.getCell(col++).value = parseFloat(veiculo.kmViagens);
        }
        if (temGeofences) row.getCell(col++).value = veiculo.geofencesVisitados;
        row.getCell(col++).value = veiculo.totalRegistros;

        // Destacar excessos graves em vermelho
        if (veiculo.excessos120plus > 0) {
          row.getCell(col120).font = { color: { argb: 'FFFF0000' }, bold: true };
        }

        // Zebrado
        if (idx % 2 === 0) {
          row.eachCell(cell => {
            if (!cell.font?.color) {
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
            }
          });
        }
      });

      // Ajustar larguras
      resumoSheet.columns = [
        { width: 12 }, { width: 18 }, { width: 22 }, { width: 18 }, { width: 10 },
        { width: 10 }, { width: 10 }, { width: 8 }, { width: 9 }, { width: 8 },
        { width: 8 }, { width: 8 }, { width: 10 }
      ];

      // Enviar arquivo
      const filename = `resumo_frota_${formatDateForFilename(new Date())}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);

    } else {
      // Gerar CSV (padrão)
      const totalExcessos = resumoFrota.reduce((sum, v) => sum + v.excessosVelocidade, 0);
      const totalExcessos80 = resumoFrota.reduce((sum, v) => sum + v.excessos80_100, 0);
      const totalExcessos100 = resumoFrota.reduce((sum, v) => sum + v.excessos100_120, 0);
      const totalExcessos120 = resumoFrota.reduce((sum, v) => sum + v.excessos120plus, 0);
      const totalAlarmes = resumoFrota.reduce((sum, v) => sum + v.totalAlarmes, 0);
      const totalViagens = resumoFrota.reduce((sum, v) => sum + v.totalViagens, 0);

      // Verificar quais colunas extras incluir
      const temAlarmes = tiposAlarmeFiltro.length > 0 || modulosSelecionados.includes('alarmes');
      const temViagens = incluirDetalhesViagens || modulosSelecionados.includes('viagens');
      const temGeofences = geofenceIdsFiltro.length > 0;

      let filtrosTexto = [];
      if (limiteVelocidadeFiltro > 0) filtrosTexto.push(`Velocidade > ${limiteVelocidadeFiltro} km/h`);
      if (geofenceIdsFiltro.length > 0) filtrosTexto.push(`${geofenceIdsFiltro.length} geofence(s)`);
      if (tiposAlarmeFiltro.length > 0) filtrosTexto.push(`Alarmes: ${tiposAlarmeFiltro.join(', ')}`);
      if (incluirDetalhesViagens) filtrosTexto.push('Incluir viagens');

      // Construir cabeçalho dinamicamente
      let headerCols = ['Placa', 'Veículo', 'Motorista(s)', 'IMEI', 'Status', 'Distância (km)', 'Tempo Movimento', 'Tempo Ocioso', 'Vel.Máxima', 'Excessos Total', '80-100', '100-120', '>120'];
      if (temAlarmes) headerCols.push('Alarmes');
      if (temViagens) headerCols.push('Viagens', 'Km Viagens');
      if (temGeofences) headerCols.push('Geofences');
      headerCols.push('Registros');

      let csvContent = `RESUMO DA FROTA
Período;${formatDateTime(inicio)} até ${formatDateTime(fim)}
Gerado em;${formatDateTime(new Date())}
${filtrosTexto.length > 0 ? `Filtros aplicados;${filtrosTexto.join(' | ')}\n` : ''}
=== ESTATÍSTICAS GERAIS ===
Total de Veículos;${estatisticas.totalVeiculos}
Veículos Ativos no Período;${estatisticas.veiculosAtivos}
Distância Total da Frota;${estatisticas.distanciaTotalFrota} km
Média por Veículo;${estatisticas.mediaKmVeiculo} km
Total de Excessos;${totalExcessos}
Excessos 80-100 km/h;${totalExcessos80}
Excessos 100-120 km/h;${totalExcessos100}
Excessos >120 km/h;${totalExcessos120}
${temAlarmes ? `Total de Alarmes;${totalAlarmes}\n` : ''}${temViagens ? `Total de Viagens;${totalViagens}\n` : ''}
=== DETALHAMENTO POR VEÍCULO ===
${headerCols.join(';')}
`;

      for (const veiculo of resumoFrota) {
        let rowCols = [
          veiculo.placa,
          `"${veiculo.veiculo}"`,
          `"${veiculo.motoristas}"`,
          veiculo.imei,
          veiculo.status,
          veiculo.distanciaTotal,
          `"${veiculo.tempoMovimento}"`,
          `"${veiculo.tempoOcioso}"`,
          veiculo.velocidadeMax,
          veiculo.excessosVelocidade,
          veiculo.excessos80_100,
          veiculo.excessos100_120,
          veiculo.excessos120plus
        ];
        if (temAlarmes) rowCols.push(veiculo.totalAlarmes);
        if (temViagens) rowCols.push(veiculo.totalViagens, veiculo.kmViagens);
        if (temGeofences) rowCols.push(veiculo.geofencesVisitados);
        rowCols.push(veiculo.totalRegistros);
        csvContent += rowCols.join(';') + '\n';
      }

      const filename = `resumo_frota_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }

  } catch (error) {
    console.error('[Relatório Frota] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO DE TEMPO DE OPERAÇÃO ============

/**
 * GET /api/relatorios/operacao/:imei
 * Relatório de tempo de operação do veículo (motor ligado)
 */
router.get('/operacao/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv'
    } = req.query;

    // Buscar dispositivo
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei }
    });

    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    // Configurar período
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    // Buscar localizações
    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: inicio, lte: fim }
      },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum registro encontrado no período selecionado'
      });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Agrupar por dia e calcular tempo de operação
    const operacaoPorDia = {};
    let tempoTotalOperacao = 0;
    let tempoTotalMovimento = 0;
    let tempoTotalOcioso = 0;

    for (let i = 1; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const locAnterior = localizacoes[i - 1];

      const tempoMinutos = (new Date(loc.timestamp) - new Date(locAnterior.timestamp)) / (1000 * 60);

      // Ignorar gaps muito grandes (> 30 min)
      if (tempoMinutos > 30) continue;

      const dia = new Date(loc.timestamp).toISOString().split('T')[0];

      if (!operacaoPorDia[dia]) {
        operacaoPorDia[dia] = {
          data: dia,
          tempoOperacao: 0,
          tempoMovimento: 0,
          tempoOcioso: 0,
          primeiraLoc: locAnterior.timestamp,
          ultimaLoc: loc.timestamp
        };
      }

      // Motor ligado = em operação
      if (loc.ignicao === true || loc.velocidade > 0) {
        operacaoPorDia[dia].tempoOperacao += tempoMinutos;
        tempoTotalOperacao += tempoMinutos;

        if (loc.velocidade > 0) {
          operacaoPorDia[dia].tempoMovimento += tempoMinutos;
          tempoTotalMovimento += tempoMinutos;
        } else {
          operacaoPorDia[dia].tempoOcioso += tempoMinutos;
          tempoTotalOcioso += tempoMinutos;
        }
      }

      operacaoPorDia[dia].ultimaLoc = loc.timestamp;
    }

    const diasComDados = Object.values(operacaoPorDia).sort((a, b) => a.data.localeCompare(b.data));

    // Estatísticas
    const estatisticas = {
      tempoTotalOperacao: formatarTempo(tempoTotalOperacao),
      tempoTotalMovimento: formatarTempo(tempoTotalMovimento),
      tempoTotalOcioso: formatarTempo(tempoTotalOcioso),
      diasComDados: diasComDados.length,
      mediaOperacaoDia: formatarTempo(diasComDados.length > 0 ? tempoTotalOperacao / diasComDados.length : 0),
      eficiencia: tempoTotalOperacao > 0 ? ((tempoTotalMovimento / tempoTotalOperacao) * 100).toFixed(1) : '0'
    };

    if (formato === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const filename = `tempo_operacao_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      // Cabeçalho
      doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE TEMPO DE OPERAÇÃO', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#667eea');
      doc.moveDown(0.5);

      // Info veículo
      doc.fontSize(12).font('Helvetica-Bold').text('Informações do Veículo');
      doc.fontSize(10).font('Helvetica');
      doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'} | Placa: ${dispositivo.placa || 'N/A'}`);
      doc.text(`Motorista(s): ${motoristas.length > 0 ? motoristas.map(m => m.nome).join(', ') : 'Nenhum vinculado'}`);
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.moveDown();

      // Estatísticas
      doc.fontSize(12).font('Helvetica-Bold').text('Resumo');
      const statsY = doc.y;
      doc.rect(50, statsY, 495, 70).fillAndStroke('#e3f2fd', '#2196f3');
      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Tempo Total de Operação: ${estatisticas.tempoTotalOperacao}`, 60, statsY + 10);
      doc.text(`Tempo em Movimento: ${estatisticas.tempoTotalMovimento}`, 60, statsY + 25);
      doc.text(`Tempo Ocioso: ${estatisticas.tempoTotalOcioso}`, 60, statsY + 40);
      doc.text(`Média Diária: ${estatisticas.mediaOperacaoDia}`, 300, statsY + 10);
      doc.text(`Eficiência: ${estatisticas.eficiencia}%`, 300, statsY + 25);
      doc.y = statsY + 80;
      doc.moveDown();

      // Tabela
      if (diasComDados.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Detalhamento Diário');
        doc.moveDown(0.5);
        const tableTop = doc.y;
        const colWidths = [100, 100, 100, 100, 95];
        const headers = ['Data', 'Operação', 'Movimento', 'Ocioso', 'Eficiência'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#2196f3');
        let xPos = 55;
        headers.forEach((h, i) => { doc.text(h, xPos, tableTop + 4, { width: colWidths[i] }); xPos += colWidths[i]; });

        doc.fillColor('#000').font('Helvetica').fontSize(8);
        let yPos = tableTop + 18;

        for (const dia of diasComDados) {
          if (yPos > 750) { doc.addPage(); yPos = 50; }
          if (diasComDados.indexOf(dia) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#e3f2fd');
            doc.fillColor('#000');
          }
          const eficienciaDia = dia.tempoOperacao > 0 ? ((dia.tempoMovimento / dia.tempoOperacao) * 100).toFixed(0) : '0';
          xPos = 55;
          [
            new Date(dia.data + 'T12:00:00').toLocaleDateString('pt-BR'),
            formatarTempo(dia.tempoOperacao),
            formatarTempo(dia.tempoMovimento),
            formatarTempo(dia.tempoOcioso),
            `${eficienciaDia}%`
          ].forEach((d, i) => { doc.text(d, xPos, yPos, { width: colWidths[i] }); xPos += colWidths[i]; });
          yPos += 12;
        }
      }

      doc.fontSize(8).fillColor('#999').text('Sistema de Rastreamento Veicular', 50, 780, { align: 'center', width: 495 });
      doc.end();
    } else {
      let csvContent = `RELATÓRIO DE TEMPO DE OPERAÇÃO
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}

=== RESUMO ===
Tempo Total de Operação: ${estatisticas.tempoTotalOperacao}
Tempo em Movimento: ${estatisticas.tempoTotalMovimento}
Tempo Ocioso: ${estatisticas.tempoTotalOcioso}
Eficiência: ${estatisticas.eficiencia}%

=== DETALHAMENTO DIÁRIO ===
Data,Tempo Operação (min),Tempo Movimento (min),Tempo Ocioso (min),Eficiência (%)
`;
      for (const dia of diasComDados) {
        const eficienciaDia = dia.tempoOperacao > 0 ? ((dia.tempoMovimento / dia.tempoOperacao) * 100).toFixed(1) : '0';
        csvContent += `${dia.data},${dia.tempoOperacao.toFixed(0)},${dia.tempoMovimento.toFixed(0)},${dia.tempoOcioso.toFixed(0)},${eficienciaDia}\n`;
      }

      const filename = `tempo_operacao_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }
  } catch (error) {
    console.error('[Relatório Operação] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO DE PARADAS LONGAS ============

/**
 * GET /api/relatorios/paradas/:imei
 * Relatório de paradas longas (veículo parado por mais de X minutos)
 */
router.get('/paradas/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv',
      tempoMinimo = '30' // Tempo mínimo em minutos para considerar parada longa
    } = req.query;

    const tempoMinimoMin = parseInt(tempoMinimo) || 30;

    const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    const localizacoes = await prisma.localizacao.findMany({
      where: { dispositivo_id: dispositivo.id, timestamp: { gte: inicio, lte: fim } },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({ sucesso: false, mensagem: 'Nenhum registro encontrado' });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Identificar paradas longas
    const paradas = [];
    let inicioParada = null;
    let latParada = null, lonParada = null;

    for (let i = 0; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const velocidade = loc.velocidade || 0;
      const estaParado = velocidade === 0;

      if (estaParado && !inicioParada) {
        inicioParada = loc.timestamp;
        latParada = loc.latitude;
        lonParada = loc.longitude;
      } else if (!estaParado && inicioParada) {
        const duracao = (new Date(loc.timestamp) - new Date(inicioParada)) / (1000 * 60);
        if (duracao >= tempoMinimoMin) {
          paradas.push({
            inicio: inicioParada,
            fim: loc.timestamp,
            duracao,
            latitude: latParada,
            longitude: lonParada,
            motorLigado: loc.ignicao === true
          });
        }
        inicioParada = null;
      }
    }

    // Verificar parada em andamento
    if (inicioParada) {
      const ultimaLoc = localizacoes[localizacoes.length - 1];
      const duracao = (new Date(ultimaLoc.timestamp) - new Date(inicioParada)) / (1000 * 60);
      if (duracao >= tempoMinimoMin) {
        paradas.push({
          inicio: inicioParada,
          fim: ultimaLoc.timestamp,
          duracao,
          latitude: latParada,
          longitude: lonParada,
          emAndamento: true
        });
      }
    }

    const tempoTotalParado = paradas.reduce((s, p) => s + p.duracao, 0);
    const estatisticas = {
      totalParadas: paradas.length,
      tempoTotalParado: formatarTempo(tempoTotalParado),
      mediaParada: formatarTempo(paradas.length > 0 ? tempoTotalParado / paradas.length : 0),
      maiorParada: formatarTempo(paradas.length > 0 ? Math.max(...paradas.map(p => p.duracao)) : 0)
    };

    if (formato === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const filename = `paradas_longas_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE PARADAS LONGAS', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ff9800');
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica');
      doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'} | Placa: ${dispositivo.placa || 'N/A'}`);
      doc.text(`Motorista(s): ${motoristas.length > 0 ? motoristas.map(m => m.nome).join(', ') : 'Nenhum vinculado'}`);
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.text(`Tempo mínimo considerado: ${tempoMinimoMin} minutos`);
      doc.moveDown();

      const statsY = doc.y;
      doc.rect(50, statsY, 495, 55).fillAndStroke('#fff3e0', '#ff9800');
      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Total de Paradas: ${estatisticas.totalParadas}`, 60, statsY + 10);
      doc.text(`Tempo Total Parado: ${estatisticas.tempoTotalParado}`, 60, statsY + 25);
      doc.text(`Média por Parada: ${estatisticas.mediaParada}`, 300, statsY + 10);
      doc.text(`Maior Parada: ${estatisticas.maiorParada}`, 300, statsY + 25);
      doc.y = statsY + 65;
      doc.moveDown();

      if (paradas.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Detalhamento das Paradas');
        doc.moveDown(0.5);
        const tableTop = doc.y;
        const colWidths = [120, 120, 80, 175];
        const headers = ['Início', 'Fim', 'Duração', 'Localização'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#ff9800');
        let xPos = 55;
        headers.forEach((h, i) => { doc.text(h, xPos, tableTop + 4, { width: colWidths[i] }); xPos += colWidths[i]; });

        doc.fillColor('#000').font('Helvetica').fontSize(8);
        let yPos = tableTop + 18;

        for (const parada of paradas) {
          if (yPos > 750) { doc.addPage(); yPos = 50; }
          if (paradas.indexOf(parada) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#fff3e0');
            doc.fillColor('#000');
          }
          xPos = 55;
          [
            formatDateTime(parada.inicio),
            parada.emAndamento ? 'Em andamento' : formatDateTime(parada.fim),
            formatarTempo(parada.duracao),
            `${parada.latitude.toFixed(5)}, ${parada.longitude.toFixed(5)}`
          ].forEach((d, i) => { doc.text(d, xPos, yPos, { width: colWidths[i] }); xPos += colWidths[i]; });
          yPos += 12;
        }
      }

      doc.fontSize(8).fillColor('#999').text('Sistema de Rastreamento Veicular', 50, 780, { align: 'center', width: 495 });
      doc.end();
    } else {
      let csvContent = `RELATÓRIO DE PARADAS LONGAS
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Tempo mínimo considerado: ${tempoMinimoMin} minutos

=== RESUMO ===
Total de Paradas: ${estatisticas.totalParadas}
Tempo Total Parado: ${estatisticas.tempoTotalParado}
Média por Parada: ${estatisticas.mediaParada}
Maior Parada: ${estatisticas.maiorParada}

=== DETALHAMENTO ===
Início,Fim,Duração (min),Latitude,Longitude,Em Andamento
`;
      for (const p of paradas) {
        csvContent += `${formatDateTime(p.inicio)},${p.emAndamento ? 'Em andamento' : formatDateTime(p.fim)},${p.duracao.toFixed(0)},${p.latitude},${p.longitude},${p.emAndamento ? 'Sim' : 'Não'}\n`;
      }

      const filename = `paradas_longas_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }
  } catch (error) {
    console.error('[Relatório Paradas] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RANKING DE CONDUTORES ============

/**
 * GET /api/relatorios/ranking
 * Ranking dos condutores/veículos por performance
 */
router.get('/ranking', verificarPermissao('relatorios', 'listar'), async (req, res) => {
  try {
    const {
      dataInicio,
      dataFim,
      formato = 'csv'
    } = req.query;

    const tenantFilter = req.tenantFilter || {};
    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    const dispositivos = await prisma.dispositivo.findMany({ where: tenantFilter });
    if (dispositivos.length === 0) {
      return res.status(404).json({ sucesso: false, mensagem: 'Nenhum dispositivo encontrado' });
    }

    // Calcular métricas para cada veículo
    const rankings = await Promise.all(dispositivos.map(async (dispositivo) => {
      const localizacoes = await prisma.localizacao.findMany({
        where: { dispositivo_id: dispositivo.id, timestamp: { gte: inicio, lte: fim } },
        orderBy: { timestamp: 'asc' },
        take: 2000
      });

      let km = 0, tempoMovimento = 0, tempoOcioso = 0, excessos = 0, velMax = 0;

      for (let i = 1; i < localizacoes.length; i++) {
        const loc = localizacoes[i];
        const anterior = localizacoes[i - 1];
        const tempo = (new Date(loc.timestamp) - new Date(anterior.timestamp)) / (1000 * 60);

        if (tempo > 30) continue;

        if (loc.velocidade > 0) {
          const dist = calcularDistancia(anterior.latitude, anterior.longitude, loc.latitude, loc.longitude);
          if (dist < 5) km += dist;
          tempoMovimento += tempo;
          if (loc.velocidade > velMax) velMax = loc.velocidade;
          if (loc.velocidade > 80) excessos++;
        } else if (loc.ignicao) {
          tempoOcioso += tempo;
        }
      }

      // Buscar motoristas vinculados no período
      const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
      const motoristaAtual = motoristas.length > 0 ? motoristas[motoristas.length - 1].nome : null;

      // Pontuação: mais km = melhor, menos excessos = melhor, menos ocioso = melhor
      const eficiencia = (tempoMovimento + tempoOcioso) > 0 ? (tempoMovimento / (tempoMovimento + tempoOcioso)) * 100 : 0;
      const pontuacao = Math.max(0, 100 - (excessos * 2) + (eficiencia * 0.5) + (km * 0.1));

      return {
        placa: dispositivo.placa || 'N/A',
        veiculo: dispositivo.veiculo || 'N/A',
        imei: dispositivo.imei,
        motorista: motoristaAtual || 'N/A',
        motoristas: motoristas.map(m => m.nome).join(', ') || 'Nenhum',
        km: km.toFixed(2),
        tempoMovimento: formatarTempo(tempoMovimento),
        tempoOcioso: formatarTempo(tempoOcioso),
        eficiencia: eficiencia.toFixed(1),
        excessos,
        velMax,
        pontuacao: pontuacao.toFixed(0)
      };
    }));

    rankings.sort((a, b) => parseFloat(b.pontuacao) - parseFloat(a.pontuacao));

    // Adicionar posição
    rankings.forEach((r, i) => r.posicao = i + 1);

    if (formato === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const filename = `ranking_condutores_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      doc.fontSize(18).font('Helvetica-Bold').text('RANKING DE CONDUTORES', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#4caf50');
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica');
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.moveDown();

      const tableTop = doc.y;
      const colWidths = [25, 50, 85, 85, 45, 45, 45, 40, 35, 30];
      const headers = ['#', 'Placa', 'Veículo', 'Motorista', 'Km', 'Mov.', 'Efic.', 'Exc.', 'Máx', 'Pts'];

      doc.fontSize(6).font('Helvetica-Bold').fillColor('#fff');
      doc.rect(50, tableTop, 495, 15).fill('#4caf50');
      let xPos = 52;
      headers.forEach((h, i) => { doc.text(h, xPos, tableTop + 4, { width: colWidths[i] }); xPos += colWidths[i]; });

      doc.fillColor('#000').font('Helvetica').fontSize(6);
      let yPos = tableTop + 18;

      for (const r of rankings) {
        if (yPos > 750) { doc.addPage(); yPos = 50; }

        let bgColor = '#fff';
        if (r.posicao === 1) bgColor = '#ffd700';
        else if (r.posicao === 2) bgColor = '#c0c0c0';
        else if (r.posicao === 3) bgColor = '#cd7f32';
        else if (r.posicao % 2 === 0) bgColor = '#e8f5e9';

        doc.rect(50, yPos - 2, 495, 12).fill(bgColor);
        doc.fillColor('#000');

        xPos = 52;
        [
          r.posicao.toString(),
          r.placa,
          (r.veiculo || '').substring(0, 14),
          (r.motorista || 'N/A').substring(0, 14),
          r.km,
          r.tempoMovimento,
          `${r.eficiencia}%`,
          r.excessos.toString(),
          `${r.velMax}`,
          r.pontuacao
        ].forEach((d, i) => { doc.text(d, xPos, yPos, { width: colWidths[i] }); xPos += colWidths[i]; });
        yPos += 12;
      }

      doc.fontSize(8).fillColor('#999').text('Sistema de Rastreamento Veicular', 50, 780, { align: 'center', width: 495 });
      doc.end();
    } else {
      let csvContent = `RANKING DE CONDUTORES
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}

Posição,Placa,Veículo,Motorista(s),Km,Tempo Movimento,Tempo Ocioso,Eficiência (%),Excessos,Vel. Máxima,Pontuação
`;
      for (const r of rankings) {
        csvContent += `${r.posicao},${r.placa},"${r.veiculo}","${r.motoristas}",${r.km},"${r.tempoMovimento}","${r.tempoOcioso}",${r.eficiencia},${r.excessos},${r.velMax},${r.pontuacao}\n`;
      }

      const filename = `ranking_condutores_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }
  } catch (error) {
    console.error('[Relatório Ranking] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO DE CONSUMO ESTIMADO ============

/**
 * GET /api/relatorios/consumo/:imei
 * Relatório de consumo estimado de combustível
 */
router.get('/consumo/:imei', verificarPermissao('relatorios', 'listar'), verificarDispositivoTenant, async (req, res) => {
  try {
    const { imei } = req.params;
    const {
      dataInicio,
      dataFim,
      formato = 'csv',
      consumoMedio = '10' // km/L padrão
    } = req.query;

    const kmPorLitro = parseFloat(consumoMedio) || 10;

    const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
    if (!dispositivo) {
      return res.status(404).json({ sucesso: false, mensagem: 'Dispositivo não encontrado' });
    }

    const inicio = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const fim = dataFim ? new Date(dataFim) : new Date();

    const localizacoes = await prisma.localizacao.findMany({
      where: { dispositivo_id: dispositivo.id, timestamp: { gte: inicio, lte: fim } },
      orderBy: { timestamp: 'asc' }
    });

    if (localizacoes.length === 0) {
      return res.status(404).json({ sucesso: false, mensagem: 'Nenhum registro encontrado' });
    }

    // Buscar motoristas vinculados no período
    const motoristas = await buscarMotoristasNoPeriodo(dispositivo.id, inicio, fim);
    const motoristasTexto = formatarMotoristasParaExibicao(motoristas);

    // Agrupar por dia
    const consumoPorDia = {};
    let kmTotal = 0;

    for (let i = 1; i < localizacoes.length; i++) {
      const loc = localizacoes[i];
      const anterior = localizacoes[i - 1];

      if (loc.velocidade > 0) {
        const dist = calcularDistancia(anterior.latitude, anterior.longitude, loc.latitude, loc.longitude);
        if (dist < 50) {
          const dia = new Date(loc.timestamp).toISOString().split('T')[0];
          if (!consumoPorDia[dia]) {
            consumoPorDia[dia] = { data: dia, km: 0, litros: 0 };
          }
          consumoPorDia[dia].km += dist;
          kmTotal += dist;
        }
      }
    }

    // Calcular litros estimados
    for (const dia of Object.values(consumoPorDia)) {
      dia.litros = dia.km / kmPorLitro;
    }

    const diasComDados = Object.values(consumoPorDia).sort((a, b) => a.data.localeCompare(b.data));
    const litrosTotal = kmTotal / kmPorLitro;

    const estatisticas = {
      kmTotal: kmTotal.toFixed(2),
      litrosTotal: litrosTotal.toFixed(2),
      mediaKmDia: (diasComDados.length > 0 ? kmTotal / diasComDados.length : 0).toFixed(2),
      mediaLitrosDia: (diasComDados.length > 0 ? litrosTotal / diasComDados.length : 0).toFixed(2),
      consumoMedio: kmPorLitro
    };

    if (formato === 'pdf') {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const filename = `consumo_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      doc.pipe(res);

      doc.fontSize(18).font('Helvetica-Bold').text('RELATÓRIO DE CONSUMO ESTIMADO', { align: 'center' });
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#9c27b0');
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica');
      doc.text(`Veículo: ${dispositivo.veiculo || 'N/A'} | Placa: ${dispositivo.placa || 'N/A'}`);
      doc.text(`Motorista(s): ${motoristas.length > 0 ? motoristas.map(m => m.nome).join(', ') : 'Nenhum vinculado'}`);
      doc.text(`Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}`);
      doc.text(`Consumo médio considerado: ${kmPorLitro} km/L`);
      doc.moveDown();

      const statsY = doc.y;
      doc.rect(50, statsY, 495, 70).fillAndStroke('#f3e5f5', '#9c27b0');
      doc.fillColor('#000').fontSize(10).font('Helvetica');
      doc.text(`Quilometragem Total: ${estatisticas.kmTotal} km`, 60, statsY + 10);
      doc.text(`Consumo Total Estimado: ${estatisticas.litrosTotal} L`, 60, statsY + 25);
      doc.text(`Média Diária (km): ${estatisticas.mediaKmDia} km`, 300, statsY + 10);
      doc.text(`Média Diária (L): ${estatisticas.mediaLitrosDia} L`, 300, statsY + 25);
      doc.y = statsY + 80;
      doc.moveDown();

      if (diasComDados.length > 0) {
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#000').text('Consumo Diário');
        doc.moveDown(0.5);
        const tableTop = doc.y;
        const colWidths = [150, 170, 175];
        const headers = ['Data', 'Quilometragem (km)', 'Consumo Estimado (L)'];

        doc.fontSize(8).font('Helvetica-Bold').fillColor('#fff');
        doc.rect(50, tableTop, 495, 15).fill('#9c27b0');
        let xPos = 55;
        headers.forEach((h, i) => { doc.text(h, xPos, tableTop + 4, { width: colWidths[i] }); xPos += colWidths[i]; });

        doc.fillColor('#000').font('Helvetica').fontSize(8);
        let yPos = tableTop + 18;

        for (const dia of diasComDados) {
          if (yPos > 750) { doc.addPage(); yPos = 50; }
          if (diasComDados.indexOf(dia) % 2 === 0) {
            doc.rect(50, yPos - 2, 495, 12).fill('#f3e5f5');
            doc.fillColor('#000');
          }
          xPos = 55;
          [
            new Date(dia.data + 'T12:00:00').toLocaleDateString('pt-BR'),
            dia.km.toFixed(2),
            dia.litros.toFixed(2)
          ].forEach((d, i) => { doc.text(d, xPos, yPos, { width: colWidths[i] }); xPos += colWidths[i]; });
          yPos += 12;
        }
      }

      doc.fontSize(8).fillColor('#999').text('Sistema de Rastreamento Veicular', 50, 780, { align: 'center', width: 495 });
      doc.end();
    } else {
      let csvContent = `RELATÓRIO DE CONSUMO ESTIMADO
Veículo: ${dispositivo.veiculo || 'N/A'}
Placa: ${dispositivo.placa || 'N/A'}
Motorista(s): ${motoristasTexto}
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Consumo médio considerado: ${kmPorLitro} km/L

=== RESUMO ===
Quilometragem Total: ${estatisticas.kmTotal} km
Consumo Total Estimado: ${estatisticas.litrosTotal} L
Média Diária (km): ${estatisticas.mediaKmDia} km
Média Diária (L): ${estatisticas.mediaLitrosDia} L

=== CONSUMO DIÁRIO ===
Data,Quilometragem (km),Consumo Estimado (L)
`;
      for (const dia of diasComDados) {
        csvContent += `${dia.data},${dia.km.toFixed(2)},${dia.litros.toFixed(2)}\n`;
      }

      const filename = `consumo_${dispositivo.placa || imei}_${formatDateForFilename(new Date())}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send('\ufeff' + csvContent);
    }
  } catch (error) {
    console.error('[Relatório Consumo] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar relatório', erro: error.message });
  }
});

// ============ RELATÓRIO PERSONALIZADO PDF ============

/**
 * POST /relatorios/personalizado/pdf
 * Gera PDF com colunas e dados personalizados
 */
router.post('/personalizado/pdf', verificarPermissao('relatorios', 'exportar'), async (req, res) => {
  try {
    const { colunas, dados, filtros, titulo } = req.body;

    if (!colunas || !dados || colunas.length === 0) {
      return res.status(400).json({
        sucesso: false,
        mensagem: 'Colunas e dados são obrigatórios'
      });
    }

    // Criar PDF
    const doc = new PDFDocument({
      size: 'A4',
      layout: colunas.length > 6 ? 'landscape' : 'portrait',
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      bufferPages: true
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="relatorio_personalizado_${Date.now()}.pdf"`);
      res.send(pdfBuffer);
    });

    // Configurações de layout
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = Math.min(pageWidth / colunas.length, 120);
    const startX = doc.page.margins.left;
    let currentY = doc.page.margins.top;

    // Título
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#1a1a2e');
    doc.text(titulo || 'Relatório Personalizado', startX, currentY, { align: 'center', width: pageWidth });
    currentY += 30;

    // Informações do período
    if (filtros && filtros.dataInicio && filtros.dataFim) {
      doc.fontSize(10).font('Helvetica').fillColor('#666666');
      doc.text(`Período: ${formatDateTime(filtros.dataInicio)} a ${formatDateTime(filtros.dataFim)}`, startX, currentY, { align: 'center', width: pageWidth });
      currentY += 15;
    }

    // Data de geração
    doc.fontSize(9).fillColor('#999999');
    doc.text(`Gerado em: ${formatDateTime(new Date())}`, startX, currentY, { align: 'center', width: pageWidth });
    currentY += 25;

    // Cabeçalho da tabela
    doc.fillColor('#1a1a2e');
    doc.rect(startX, currentY, pageWidth, 22).fill('#f0f0f5');

    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a2e');
    colunas.forEach((col, i) => {
      const x = startX + (i * colWidth);
      const text = col.nome.length > 12 ? col.nome.substring(0, 12) + '...' : col.nome;
      doc.text(text, x + 4, currentY + 6, { width: colWidth - 8 });
    });
    currentY += 22;

    // Linhas de dados
    doc.font('Helvetica').fontSize(8).fillColor('#333333');
    const rowHeight = 18;

    for (let i = 0; i < dados.length; i++) {
      const item = dados[i];

      // Verificar se precisa de nova página
      if (currentY + rowHeight > doc.page.height - doc.page.margins.bottom - 30) {
        doc.addPage();
        currentY = doc.page.margins.top;

        // Repetir cabeçalho
        doc.fillColor('#1a1a2e');
        doc.rect(startX, currentY, pageWidth, 22).fill('#f0f0f5');
        doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a2e');
        colunas.forEach((col, j) => {
          const x = startX + (j * colWidth);
          const text = col.nome.length > 12 ? col.nome.substring(0, 12) + '...' : col.nome;
          doc.text(text, x + 4, currentY + 6, { width: colWidth - 8 });
        });
        currentY += 22;
        doc.font('Helvetica').fontSize(8).fillColor('#333333');
      }

      // Fundo alternado
      if (i % 2 === 1) {
        doc.rect(startX, currentY, pageWidth, rowHeight).fill('#fafafa');
      }

      // Linha de separação
      doc.strokeColor('#e0e0e0').lineWidth(0.5);
      doc.moveTo(startX, currentY + rowHeight).lineTo(startX + pageWidth, currentY + rowHeight).stroke();

      // Valores
      doc.fillColor('#333333');
      colunas.forEach((col, j) => {
        const x = startX + (j * colWidth);
        let valor = item[col.id] || '-';

        // Truncar se muito longo
        if (typeof valor === 'string' && valor.length > 15) {
          valor = valor.substring(0, 15) + '...';
        }

        doc.text(String(valor), x + 4, currentY + 4, { width: colWidth - 8 });
      });

      currentY += rowHeight;
    }

    // Rodapé com total
    currentY += 10;
    doc.fontSize(9).fillColor('#666666');
    doc.text(`Total: ${dados.length} registros`, startX, currentY, { align: 'right', width: pageWidth });

    // Numerar páginas
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor('#999999');
      doc.text(
        `Página ${i + 1} de ${pages.count}`,
        doc.page.margins.left,
        doc.page.height - 30,
        { align: 'center', width: pageWidth }
      );
    }

    doc.end();
  } catch (error) {
    console.error('[Relatório Personalizado] Erro:', error);
    res.status(500).json({ sucesso: false, mensagem: 'Erro ao gerar PDF', erro: error.message });
  }
});

module.exports = router;
