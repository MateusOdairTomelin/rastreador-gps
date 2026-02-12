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
const prisma = require('../db/prisma');

// Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant } = require('../middleware/tenant-device.middleware');

// Serviço de limite de velocidade por via
const velocidadeViaService = require('../services/velocidade-via.service');

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

function formatarTempo(minutos) {
  const horas = Math.floor(minutos / 60);
  const mins = Math.round(minutos % 60);
  if (horas > 0) return `${horas}h ${mins}min`;
  return `${mins} min`;
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
router.get('/velocidade/:imei', verificarDispositivoTenant, async (req, res) => {
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
      doc.rect(50, infoBoxY, 240, 65).fillAndStroke('#f5f5f5', '#ddd');
      doc.rect(300, infoBoxY, 245, 65).fillAndStroke('#f5f5f5', '#ddd');

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

      doc.y = infoBoxY + 75;

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
router.get('/ocioso/:imei', verificarDispositivoTenant, async (req, res) => {
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
router.get('/quilometragem/:imei', verificarDispositivoTenant, async (req, res) => {
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
router.get('/frota', async (req, res) => {
  try {
    const {
      dataInicio,
      dataFim,
      formato = 'csv',
      imei // Filtro opcional por veículo(s) - pode ser string única ou array
    } = req.query;

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

    console.log('[Relatórios/frota] whereClause:', JSON.stringify(whereClause));

    const dispositivos = await prisma.dispositivo.findMany({
      where: whereClause
    });

    console.log('[Relatórios/frota] Dispositivos encontrados:', dispositivos.length);

    if (dispositivos.length === 0) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Nenhum dispositivo encontrado'
      });
    }

    // Calcular estatísticas para cada veículo (em paralelo para maior velocidade)
    const LIMITE_EXCESSO_PADRAO = 80; // Limite padrão para visão geral (relatório detalhado usa limites precisos)

    // Se filtrar por poucos veículos, buscar todos os registros para precisão
    // Se buscar muitos, limitar para performance
    const limiteRegistros = dispositivos.length <= 3 ? undefined : 2000;

    const processarVeiculo = async (dispositivo) => {
      // Buscar localizações com campos mínimos necessários
      const localizacoes = await prisma.localizacao.findMany({
        where: {
          dispositivo_id: dispositivo.id,
          timestamp: { gte: inicio, lte: fim }
        },
        select: {
          timestamp: true,
          latitude: true,
          longitude: true,
          velocidade: true,
          ignicao: true
        },
        orderBy: { timestamp: 'asc' },
        take: limiteRegistros
      });

      let distanciaMovimento = 0; // Só conta km quando em movimento (consistente com veiculo-detalhes)
      let tempoMovimento = 0;
      let tempoOcioso = 0;
      let velocidadeMax = 0;
      let excessosVelocidade = 0;

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

          // Excesso simplificado para visão geral
          if (loc.velocidade > LIMITE_EXCESSO_PADRAO) {
            excessosVelocidade++;
          }
        } else if (loc.ignicao === true) {
          // Parado com motor ligado = ocioso
          tempoOcioso += tempoMinutos;
        }
      }

      return {
        placa: dispositivo.placa || 'N/A',
        veiculo: dispositivo.veiculo || 'N/A',
        imei: dispositivo.imei,
        status: dispositivo.status || 'offline',
        distanciaTotal: distanciaMovimento.toFixed(2),
        tempoMovimento: formatarTempo(tempoMovimento),
        tempoMovimentoMinutos: Math.round(tempoMovimento),
        tempoOcioso: formatarTempo(tempoOcioso),
        tempoOciosoMinutos: Math.round(tempoOcioso),
        velocidadeMax: velocidadeMax,
        excessosVelocidade: excessosVelocidade,
        totalRegistros: localizacoes.length
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
      const colWidths = [70, 100, 60, 60, 60, 60, 50];
      const headers = ['Placa', 'Veículo', 'Distância', 'Mov.', 'Ocioso', 'Vel. Máx', 'Reg.'];

      doc.fontSize(7).font('Helvetica-Bold').fillColor('#fff');
      doc.rect(50, tableTop, 495, 15).fill('#3f51b5');

      let xPos = 55;
      headers.forEach((header, i) => {
        doc.text(header, xPos, tableTop + 4, { width: colWidths[i], align: 'left' });
        xPos += colWidths[i];
      });

      doc.fillColor('#000').font('Helvetica').fontSize(7);
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
          (veiculo.veiculo || '').substring(0, 18),
          `${veiculo.distanciaTotal} km`,
          veiculo.tempoMovimento,
          veiculo.tempoOcioso,
          `${veiculo.velocidadeMax} km/h`,
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

    } else {
      // Gerar CSV
      let csvContent = `RESUMO DA FROTA
Período: ${formatDateTime(inicio)} até ${formatDateTime(fim)}
Gerado em: ${formatDateTime(new Date())}

=== ESTATÍSTICAS GERAIS ===
Total de Veículos: ${estatisticas.totalVeiculos}
Veículos Ativos no Período: ${estatisticas.veiculosAtivos}
Distância Total da Frota: ${estatisticas.distanciaTotalFrota} km
Média por Veículo: ${estatisticas.mediaKmVeiculo} km

=== DETALHAMENTO POR VEÍCULO ===
Placa,Veículo,IMEI,Status,Distância (km),Tempo Movimento,Tempo Ocioso,Velocidade Máxima (km/h),Total Registros
`;

      for (const veiculo of resumoFrota) {
        csvContent += `${veiculo.placa},"${veiculo.veiculo}",${veiculo.imei},${veiculo.status},${veiculo.distanciaTotal},"${veiculo.tempoMovimento}","${veiculo.tempoOcioso}",${veiculo.velocidadeMax},${veiculo.totalRegistros}\n`;
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

module.exports = router;
