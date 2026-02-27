/**
 * Rotas de Auditoria
 *
 * Endpoints para visualização de logs de auditoria do sistema
 * ✅ Multi-tenant: Filtra por organização do usuário
 */

const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const { autenticar } = require('../middleware/auth.middleware');
const { tenantContext } = require('../middleware/tenant.middleware');
const { verificarPermissao } = require('../middleware/permissao.middleware');

/**
 * GET /api/auditoria
 * Listar logs de auditoria
 */
router.get('/', autenticar, tenantContext, verificarPermissao('auditoria', 'listar'), async (req, res) => {
  try {
    const {
      usuario_id,
      acao,
      recurso,
      sucesso,
      dataInicio,
      dataFim,
      limite = 100,
      pagina = 1
    } = req.query;

    const where = {};

    // Multi-tenant: Filtrar por organização (exceto super_admin)
    if (req.usuario.role !== 'super_admin') {
      where.organizacao_id = req.usuario.organizacao_id;
    } else if (req.query.organizacao_id) {
      where.organizacao_id = parseInt(req.query.organizacao_id);
    }

    // Filtros opcionais
    if (usuario_id) where.usuario_id = parseInt(usuario_id);
    if (acao) where.acao = acao;
    if (recurso) where.recurso = recurso;
    if (sucesso !== undefined) where.sucesso = sucesso === 'true';

    if (dataInicio || dataFim) {
      where.created_at = {};
      if (dataInicio) where.created_at.gte = new Date(dataInicio);
      if (dataFim) where.created_at.lte = new Date(dataFim);
    }

    const skip = (parseInt(pagina) - 1) * parseInt(limite);

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          usuario: {
            select: { id: true, nome: true, email: true }
          }
        },
        orderBy: { created_at: 'desc' },
        take: parseInt(limite),
        skip
      }),
      prisma.auditLog.count({ where })
    ]);

    res.json({
      sucesso: true,
      logs,
      paginacao: {
        total,
        pagina: parseInt(pagina),
        limite: parseInt(limite),
        totalPaginas: Math.ceil(total / parseInt(limite))
      }
    });
  } catch (error) {
    console.error('[Auditoria] Erro ao listar logs:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/auditoria/estatisticas
 * Estatísticas de auditoria
 */
router.get('/estatisticas', autenticar, tenantContext, verificarPermissao('auditoria', 'listar'), async (req, res) => {
  try {
    const { dataInicio, dataFim } = req.query;

    const where = {};

    // Multi-tenant
    if (req.usuario.role !== 'super_admin') {
      where.organizacao_id = req.usuario.organizacao_id;
    }

    if (dataInicio || dataFim) {
      where.created_at = {};
      if (dataInicio) where.created_at.gte = new Date(dataInicio);
      if (dataFim) where.created_at.lte = new Date(dataFim);
    }

    const [porAcao, porRecurso, porSucesso, total] = await Promise.all([
      prisma.auditLog.groupBy({
        by: ['acao'],
        where,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10
      }),
      prisma.auditLog.groupBy({
        by: ['recurso'],
        where,
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10
      }),
      prisma.auditLog.groupBy({
        by: ['sucesso'],
        where,
        _count: { id: true }
      }),
      prisma.auditLog.count({ where })
    ]);

    res.json({
      sucesso: true,
      estatisticas: {
        total,
        porAcao: porAcao.map(a => ({ acao: a.acao, quantidade: a._count.id })),
        porRecurso: porRecurso.map(r => ({ recurso: r.recurso, quantidade: r._count.id })),
        porSucesso: {
          sucesso: porSucesso.find(s => s.sucesso === true)?._count?.id || 0,
          falha: porSucesso.find(s => s.sucesso === false)?._count?.id || 0
        }
      }
    });
  } catch (error) {
    console.error('[Auditoria] Erro ao buscar estatísticas:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/auditoria/acoes
 * Listar tipos de ações únicas
 */
router.get('/acoes', autenticar, tenantContext, verificarPermissao('auditoria', 'listar'), async (req, res) => {
  try {
    const acoes = await prisma.auditLog.findMany({
      distinct: ['acao'],
      select: { acao: true },
      orderBy: { acao: 'asc' }
    });

    res.json({
      sucesso: true,
      acoes: acoes.map(a => a.acao)
    });
  } catch (error) {
    console.error('[Auditoria] Erro ao listar ações:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/auditoria/recursos
 * Listar tipos de recursos únicos
 */
router.get('/recursos', autenticar, tenantContext, verificarPermissao('auditoria', 'listar'), async (req, res) => {
  try {
    const recursos = await prisma.auditLog.findMany({
      distinct: ['recurso'],
      select: { recurso: true },
      where: { recurso: { not: null } },
      orderBy: { recurso: 'asc' }
    });

    res.json({
      sucesso: true,
      recursos: recursos.map(r => r.recurso)
    });
  } catch (error) {
    console.error('[Auditoria] Erro ao listar recursos:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/auditoria/exportar
 * Exportar logs de auditoria (CSV)
 */
router.get('/exportar', autenticar, tenantContext, verificarPermissao('auditoria', 'exportar'), async (req, res) => {
  try {
    const { dataInicio, dataFim, formato = 'csv' } = req.query;

    const where = {};

    // Multi-tenant
    if (req.usuario.role !== 'super_admin') {
      where.organizacao_id = req.usuario.organizacao_id;
    }

    if (dataInicio || dataFim) {
      where.created_at = {};
      if (dataInicio) where.created_at.gte = new Date(dataInicio);
      if (dataFim) where.created_at.lte = new Date(dataFim);
    }

    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        usuario: {
          select: { nome: true, email: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 10000 // Limite para evitar sobrecarga
    });

    if (formato === 'csv') {
      const header = 'Data/Hora,Usuario,Email,Acao,Recurso,ID Recurso,Sucesso,IP,Detalhes\n';
      const rows = logs.map(log => {
        const data = new Date(log.created_at).toLocaleString('pt-BR');
        const usuario = log.usuario?.nome || 'Sistema';
        const email = log.usuario?.email || '-';
        const detalhes = (log.detalhes || '').replace(/"/g, '""').substring(0, 200);
        return `"${data}","${usuario}","${email}","${log.acao}","${log.recurso || '-'}","${log.recurso_id || '-'}","${log.sucesso ? 'Sim' : 'Não'}","${log.ip || '-'}","${detalhes}"`;
      }).join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="auditoria_${new Date().toISOString().split('T')[0]}.csv"`);
      res.send('\ufeff' + header + rows);
    } else {
      res.json({
        sucesso: true,
        logs,
        total: logs.length
      });
    }
  } catch (error) {
    console.error('[Auditoria] Erro ao exportar:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

module.exports = router;
