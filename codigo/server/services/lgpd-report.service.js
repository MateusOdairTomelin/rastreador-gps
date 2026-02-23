/**
 * LGPD Report Service
 * Gera relatórios de conformidade LGPD em PDF para auditorias
 */

const PDFDocument = require('pdfkit');
const prisma = require('../prisma');

class LgpdReportService {

  /**
   * Gera relatório completo de conformidade LGPD
   * @param {Object} options - Opções do relatório
   * @param {number} options.organizacao_id - ID da organização (null para todas - super_admin)
   * @param {Date} options.dataInicio - Data inicial do período
   * @param {Date} options.dataFim - Data final do período
   * @returns {Buffer} PDF buffer
   */
  async gerarRelatorioConformidade(options = {}) {
    const { organizacao_id, dataInicio, dataFim } = options;

    // Coletar dados
    const [
      estatisticas,
      usuariosPendentes,
      motoristasPendentes,
      solicitacoesExclusao,
      consentimentosRecentes,
      logsAcesso
    ] = await Promise.all([
      this.obterEstatisticas(organizacao_id),
      this.obterUsuariosPendentes(organizacao_id),
      this.obterMotoristasPendentes(organizacao_id),
      this.obterSolicitacoesExclusao(organizacao_id, dataInicio, dataFim),
      this.obterConsentimentosRecentes(organizacao_id, dataInicio, dataFim),
      this.obterLogsAcesso(organizacao_id, dataInicio, dataFim)
    ]);

    // Gerar PDF
    return this.criarPDF({
      estatisticas,
      usuariosPendentes,
      motoristasPendentes,
      solicitacoesExclusao,
      consentimentosRecentes,
      logsAcesso,
      organizacao_id,
      dataInicio,
      dataFim
    });
  }

  async obterEstatisticas(organizacao_id) {
    const whereUsuarios = organizacao_id ? {
      usuario_organizacoes: { some: { organizacao_id } }
    } : {};

    const whereMotoristas = organizacao_id ? { organizacao_id } : {};

    // Total de usuários
    const totalUsuarios = await prisma.usuario.count({
      where: { ...whereUsuarios, ativo: true }
    });

    // Usuários com consentimento válido
    const usuariosConformes = await prisma.usuario.count({
      where: {
        ...whereUsuarios,
        ativo: true,
        consentimentos: {
          some: {
            tipo: 'privacidade',
            aceito: true,
            data_revogacao: null
          }
        }
      }
    });

    // Total de motoristas
    const totalMotoristas = await prisma.motorista.count({
      where: { ...whereMotoristas, ativo: true }
    });

    // Motoristas com consentimento válido
    const motoristasConformes = await prisma.motorista.count({
      where: {
        ...whereMotoristas,
        ativo: true,
        consentimentos: {
          some: {
            tipo: 'privacidade',
            aceito: true,
            data_revogacao: null
          }
        }
      }
    });

    // Solicitações de exclusão
    const solicitacoesPendentes = await prisma.solicitacaoExclusao.count({
      where: { status: 'pendente' }
    });

    const solicitacoesProcessadas = await prisma.solicitacaoExclusao.count({
      where: { status: { in: ['concluido', 'recusado'] } }
    });

    return {
      usuarios: {
        total: totalUsuarios,
        conformes: usuariosConformes,
        taxa: totalUsuarios > 0 ? Math.round((usuariosConformes / totalUsuarios) * 100) : 100
      },
      motoristas: {
        total: totalMotoristas,
        conformes: motoristasConformes,
        taxa: totalMotoristas > 0 ? Math.round((motoristasConformes / totalMotoristas) * 100) : 100
      },
      solicitacoes: {
        pendentes: solicitacoesPendentes,
        processadas: solicitacoesProcessadas
      }
    };
  }

  async obterUsuariosPendentes(organizacao_id) {
    const where = organizacao_id ? {
      usuario_organizacoes: { some: { organizacao_id } }
    } : {};

    return prisma.usuario.findMany({
      where: {
        ...where,
        ativo: true,
        OR: [
          { consentimentos: { none: { tipo: 'privacidade', aceito: true, data_revogacao: null } } },
          { consentimentos: { none: { tipo: 'termos_uso', aceito: true, data_revogacao: null } } }
        ]
      },
      select: {
        id: true,
        nome: true,
        email: true,
        created_at: true
      },
      take: 50
    });
  }

  async obterMotoristasPendentes(organizacao_id) {
    const where = organizacao_id ? { organizacao_id } : {};

    return prisma.motorista.findMany({
      where: {
        ...where,
        ativo: true,
        OR: [
          { consentimentos: { none: { tipo: 'privacidade', aceito: true, data_revogacao: null } } },
          { consentimentos: { none: { tipo: 'termos_uso', aceito: true, data_revogacao: null } } }
        ]
      },
      select: {
        id: true,
        nome: true,
        created_at: true
      },
      take: 50
    });
  }

  async obterSolicitacoesExclusao(organizacao_id, dataInicio, dataFim) {
    const where = {};
    if (organizacao_id) where.organizacao_id = organizacao_id;
    if (dataInicio) where.created_at = { gte: dataInicio };
    if (dataFim) where.created_at = { ...where.created_at, lte: dataFim };

    return prisma.solicitacaoExclusao.findMany({
      where,
      include: {
        usuario: { select: { nome: true, email: true } },
        processado_por_usuario: { select: { nome: true } }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });
  }

  async obterConsentimentosRecentes(organizacao_id, dataInicio, dataFim) {
    const where = {};
    if (dataInicio) where.data_aceite = { gte: dataInicio };
    if (dataFim) where.data_aceite = { ...where.data_aceite, lte: dataFim };

    const consentimentos = await prisma.consentimento.findMany({
      where,
      include: {
        usuario: {
          select: {
            nome: true,
            email: true,
            usuario_organizacoes: organizacao_id ? {
              where: { organizacao_id }
            } : false
          }
        }
      },
      orderBy: { data_aceite: 'desc' },
      take: 100
    });

    // Filtrar por organização se necessário
    if (organizacao_id) {
      return consentimentos.filter(c =>
        c.usuario?.usuario_organizacoes?.length > 0
      );
    }

    return consentimentos;
  }

  async obterLogsAcesso(organizacao_id, dataInicio, dataFim) {
    const where = {
      acao: { in: ['lgpd_exportar_dados', 'lgpd_visualizar_dados', 'lgpd_solicitar_exclusao'] }
    };
    if (dataInicio) where.created_at = { gte: dataInicio };
    if (dataFim) where.created_at = { ...where.created_at, lte: dataFim };

    return prisma.auditLog.findMany({
      where,
      include: {
        usuario: { select: { nome: true, email: true } }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });
  }

  criarPDF(dados) {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];

      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Header
      this.adicionarHeader(doc, dados);

      // Resumo Executivo
      this.adicionarResumoExecutivo(doc, dados.estatisticas);

      // Usuários Pendentes
      if (dados.usuariosPendentes.length > 0) {
        this.adicionarSecaoUsuariosPendentes(doc, dados.usuariosPendentes);
      }

      // Motoristas Pendentes
      if (dados.motoristasPendentes.length > 0) {
        this.adicionarSecaoMotoristasPendentes(doc, dados.motoristasPendentes);
      }

      // Solicitações de Exclusão
      if (dados.solicitacoesExclusao.length > 0) {
        this.adicionarSecaoSolicitacoes(doc, dados.solicitacoesExclusao);
      }

      // Consentimentos Recentes
      if (dados.consentimentosRecentes.length > 0) {
        this.adicionarSecaoConsentimentos(doc, dados.consentimentosRecentes);
      }

      // Logs de Acesso
      if (dados.logsAcesso.length > 0) {
        this.adicionarSecaoLogs(doc, dados.logsAcesso);
      }

      // Rodapé
      this.adicionarRodape(doc);

      doc.end();
    });
  }

  adicionarHeader(doc, dados) {
    const dataGeracao = new Date().toLocaleString('pt-BR');
    const periodo = dados.dataInicio && dados.dataFim
      ? `${new Date(dados.dataInicio).toLocaleDateString('pt-BR')} a ${new Date(dados.dataFim).toLocaleDateString('pt-BR')}`
      : 'Todos os períodos';

    doc.fontSize(20).fillColor('#131E7D')
       .text('Relatório de Conformidade LGPD', { align: 'center' });

    doc.moveDown(0.5);
    doc.fontSize(12).fillColor('#666')
       .text(`Gerado em: ${dataGeracao}`, { align: 'center' });
    doc.text(`Período: ${periodo}`, { align: 'center' });

    if (dados.organizacao_id) {
      doc.text(`Organização ID: ${dados.organizacao_id}`, { align: 'center' });
    } else {
      doc.text('Escopo: Todas as organizações', { align: 'center' });
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#3FCFD5');
    doc.moveDown(1);
  }

  adicionarResumoExecutivo(doc, estatisticas) {
    doc.fontSize(16).fillColor('#131E7D')
       .text('Resumo Executivo', { underline: true });
    doc.moveDown(0.5);

    // Taxa de conformidade geral
    const taxaGeral = Math.round(
      (estatisticas.usuarios.taxa + estatisticas.motoristas.taxa) / 2
    );

    doc.fontSize(12).fillColor('#333');

    // Box de destaque
    const startY = doc.y;
    doc.rect(50, startY, 495, 80).fill('#f0f9ff');

    doc.fillColor('#131E7D').fontSize(24)
       .text(`${taxaGeral}%`, 60, startY + 10);
    doc.fontSize(10).fillColor('#666')
       .text('Taxa de Conformidade Geral', 60, startY + 40);

    doc.fontSize(11).fillColor('#333')
       .text(`Usuários: ${estatisticas.usuarios.conformes}/${estatisticas.usuarios.total} (${estatisticas.usuarios.taxa}%)`, 200, startY + 15)
       .text(`Motoristas: ${estatisticas.motoristas.conformes}/${estatisticas.motoristas.total} (${estatisticas.motoristas.taxa}%)`, 200, startY + 35)
       .text(`Solicitações pendentes: ${estatisticas.solicitacoes.pendentes}`, 200, startY + 55)
       .text(`Solicitações processadas: ${estatisticas.solicitacoes.processadas}`, 380, startY + 55);

    doc.y = startY + 95;
    doc.moveDown(1);
  }

  adicionarSecaoUsuariosPendentes(doc, usuarios) {
    this.verificarNovaPagina(doc);

    doc.fontSize(14).fillColor('#EF4444')
       .text(`Usuários com Consentimento Pendente (${usuarios.length})`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');

    // Cabeçalho da tabela
    const tableTop = doc.y;
    doc.font('Helvetica-Bold')
       .text('Nome', 50, tableTop)
       .text('Email', 200, tableTop)
       .text('Cadastro', 400, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke('#ddd');

    // Dados
    doc.font('Helvetica');
    let y = tableTop + 20;

    for (const u of usuarios.slice(0, 20)) {
      if (y > 700) break;
      doc.text(u.nome?.substring(0, 25) || '-', 50, y)
         .text(u.email?.substring(0, 30) || '-', 200, y)
         .text(new Date(u.created_at).toLocaleDateString('pt-BR'), 400, y);
      y += 15;
    }

    if (usuarios.length > 20) {
      doc.fillColor('#666').text(`... e mais ${usuarios.length - 20} usuários`, 50, y);
    }

    doc.y = y + 20;
    doc.moveDown(1);
  }

  adicionarSecaoMotoristasPendentes(doc, motoristas) {
    this.verificarNovaPagina(doc);

    doc.fontSize(14).fillColor('#F59E0B')
       .text(`Motoristas com Consentimento Pendente (${motoristas.length})`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');

    const tableTop = doc.y;
    doc.font('Helvetica-Bold')
       .text('Nome', 50, tableTop)
       .text('Cadastro', 300, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke('#ddd');

    doc.font('Helvetica');
    let y = tableTop + 20;

    for (const m of motoristas.slice(0, 20)) {
      if (y > 700) break;
      doc.text(m.nome?.substring(0, 40) || '-', 50, y)
         .text(new Date(m.created_at).toLocaleDateString('pt-BR'), 300, y);
      y += 15;
    }

    if (motoristas.length > 20) {
      doc.fillColor('#666').text(`... e mais ${motoristas.length - 20} motoristas`, 50, y);
    }

    doc.y = y + 20;
    doc.moveDown(1);
  }

  adicionarSecaoSolicitacoes(doc, solicitacoes) {
    this.verificarNovaPagina(doc);

    doc.fontSize(14).fillColor('#131E7D')
       .text(`Solicitações de Exclusão (${solicitacoes.length})`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');

    const tableTop = doc.y;
    doc.font('Helvetica-Bold')
       .text('Data', 50, tableTop)
       .text('Usuário', 130, tableTop)
       .text('Tipo', 280, tableTop)
       .text('Status', 350, tableTop)
       .text('Processado por', 430, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke('#ddd');

    doc.font('Helvetica');
    let y = tableTop + 20;

    for (const s of solicitacoes.slice(0, 15)) {
      if (y > 700) break;

      const statusColor = s.status === 'concluido' ? '#10B981' :
                          s.status === 'recusado' ? '#EF4444' : '#F59E0B';

      doc.fillColor('#333')
         .text(new Date(s.created_at).toLocaleDateString('pt-BR'), 50, y)
         .text(s.usuario?.nome?.substring(0, 20) || '-', 130, y)
         .text(s.tipo, 280, y);
      doc.fillColor(statusColor).text(s.status, 350, y);
      doc.fillColor('#333').text(s.processado_por_usuario?.nome?.substring(0, 15) || '-', 430, y);
      y += 15;
    }

    doc.y = y + 20;
    doc.moveDown(1);
  }

  adicionarSecaoConsentimentos(doc, consentimentos) {
    this.verificarNovaPagina(doc);

    doc.fontSize(14).fillColor('#10B981')
       .text(`Consentimentos Recentes (${consentimentos.length})`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');

    const tableTop = doc.y;
    doc.font('Helvetica-Bold')
       .text('Data', 50, tableTop)
       .text('Usuário', 130, tableTop)
       .text('Tipo', 320, tableTop)
       .text('Versão', 420, tableTop)
       .text('Status', 480, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke('#ddd');

    doc.font('Helvetica');
    let y = tableTop + 20;

    for (const c of consentimentos.slice(0, 15)) {
      if (y > 700) break;

      doc.text(new Date(c.data_aceite).toLocaleDateString('pt-BR'), 50, y)
         .text(c.usuario?.nome?.substring(0, 25) || '-', 130, y)
         .text(c.tipo, 320, y)
         .text(c.versao_documento || '1.0', 420, y);
      doc.fillColor(c.aceito ? '#10B981' : '#EF4444')
         .text(c.aceito ? 'Aceito' : 'Revogado', 480, y);
      doc.fillColor('#333');
      y += 15;
    }

    doc.y = y + 20;
    doc.moveDown(1);
  }

  adicionarSecaoLogs(doc, logs) {
    this.verificarNovaPagina(doc);

    doc.fontSize(14).fillColor('#131E7D')
       .text(`Logs de Acesso a Dados (${logs.length})`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#333');

    const tableTop = doc.y;
    doc.font('Helvetica-Bold')
       .text('Data/Hora', 50, tableTop)
       .text('Usuário', 160, tableTop)
       .text('Ação', 320, tableTop);

    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke('#ddd');

    doc.font('Helvetica');
    let y = tableTop + 20;

    for (const l of logs.slice(0, 15)) {
      if (y > 700) break;

      doc.text(new Date(l.created_at).toLocaleString('pt-BR'), 50, y)
         .text(l.usuario?.nome?.substring(0, 25) || '-', 160, y)
         .text(this.formatarAcao(l.acao), 320, y);
      y += 15;
    }

    doc.y = y + 20;
  }

  adicionarRodape(doc) {
    const pageCount = doc.bufferedPageRange().count;

    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);

      doc.fontSize(8).fillColor('#999')
         .text(
           `Página ${i + 1} de ${pageCount} | Relatório gerado automaticamente pelo Sistema de Rastreamento GPS - Unifique`,
           50, 750,
           { align: 'center', width: 495 }
         );
    }
  }

  verificarNovaPagina(doc) {
    if (doc.y > 650) {
      doc.addPage();
    }
  }

  formatarAcao(acao) {
    const acoes = {
      'lgpd_exportar_dados': 'Exportou dados pessoais',
      'lgpd_visualizar_dados': 'Visualizou dados pessoais',
      'lgpd_solicitar_exclusao': 'Solicitou exclusão de dados'
    };
    return acoes[acao] || acao;
  }
}

module.exports = new LgpdReportService();
