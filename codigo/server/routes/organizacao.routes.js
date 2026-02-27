/**
 * Rotas de Organizações (Multi-Tenant)
 *
 * Endpoints para gestão de organizações, usuários e convites
 */

const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const organizacaoService = require('../services/organizacao.service');
const authService = require('../services/auth.service');
const perfilPermissaoService = require('../services/perfil-permissao.service');
const { autenticar, apenasSuperAdmin, apenasAdmin } = require('../middleware/auth.middleware');
const { tenantContext, verificarRoleOrg } = require('../middleware/tenant.middleware');

// ==================== PLANOS (PÚBLICO) ====================

/**
 * GET /api/planos
 * Listar planos disponíveis (público)
 */
router.get('/planos', async (req, res) => {
  try {
    const planos = await organizacaoService.listarPlanos();

    res.json({
      sucesso: true,
      planos
    });
  } catch (error) {
    console.error('Erro ao listar planos:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/planos/:id/email
 * Atualizar email de contato do plano (super_admin)
 */
router.put('/planos/:id/email', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { email_contato } = req.body;

    const plano = await organizacaoService.atualizarEmailPlano(parseInt(id), email_contato);

    res.json({
      sucesso: true,
      plano
    });
  } catch (error) {
    console.error('Erro ao atualizar email do plano:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== CONVITES PÚBLICOS ====================

/**
 * GET /api/convites/:token
 * Validar convite (público)
 */
router.get('/convites/:token', async (req, res) => {
  try {
    const convite = await organizacaoService.validarConvite(req.params.token);

    res.json({
      sucesso: true,
      convite: {
        email: convite.email,
        role: convite.role,
        organizacao: convite.organizacao,
        expires_at: convite.expires_at
      }
    });
  } catch (error) {
    console.error('Erro ao validar convite:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/convites/:token/aceitar
 * Aceitar convite (público)
 */
router.post('/convites/:token/aceitar', async (req, res) => {
  try {
    const { nome, senha } = req.body;

    const resultado = await organizacaoService.aceitarConvite(req.params.token, { nome, senha });

    res.json({
      sucesso: true,
      mensagem: 'Convite aceito com sucesso',
      ...resultado
    });
  } catch (error) {
    console.error('Erro ao aceitar convite:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== MINHA ORGANIZAÇÃO (USUÁRIO AUTENTICADO) ====================
// IMPORTANTE: Essas rotas devem vir ANTES das rotas com :id para evitar conflito

/**
 * GET /api/minha-organizacao
 * Dados da organização atual do usuário
 */
router.get('/minha-organizacao', autenticar, tenantContext, async (req, res) => {
  try {
    if (!req.tenant || !req.tenant.id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Nenhuma organização selecionada'
      });
    }

    const organizacao = await organizacaoService.buscarPorId(req.tenant.id);
    const estatisticas = await organizacaoService.obterEstatisticas(req.tenant.id);

    res.json({
      sucesso: true,
      organizacao,
      estatisticas,
      meu_role: req.usuario.role_org
    });
  } catch (error) {
    console.error('Erro ao buscar minha organização:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/minha-organizacao
 * Atualizar minha organização (proprietario/admin)
 */
router.put('/minha-organizacao', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const { nome, email, telefone, logo_url, cor_primaria, cor_secundaria, config_tema, timezone } = req.body;

    const organizacao = await organizacaoService.atualizar(req.tenant.id, {
      nome, email, telefone, logo_url, cor_primaria, cor_secundaria, config_tema, timezone
    });

    res.json({
      sucesso: true,
      organizacao
    });
  } catch (error) {
    console.error('Erro ao atualizar organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/minha-organizacao/usuarios
 * Listar usuários da minha organização
 */
router.get('/minha-organizacao/usuarios', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const usuarios = await organizacaoService.listarUsuarios(req.tenant.id);

    res.json({
      sucesso: true,
      usuarios
    });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/minha-organizacao/usuarios/:id
 * Alterar role de usuário na minha organização
 */
router.put('/minha-organizacao/usuarios/:id', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const { role } = req.body;
    const usuarioId = parseInt(req.params.id);

    // Admin não pode promover a proprietário
    if (role === 'proprietario' && req.usuario.role_org !== 'proprietario') {
      return res.status(403).json({
        sucesso: false,
        erro: 'Apenas proprietário pode promover outro proprietário'
      });
    }

    await organizacaoService.alterarRoleUsuario(req.tenant.id, usuarioId, role);

    res.json({
      sucesso: true,
      mensagem: 'Role alterada com sucesso'
    });
  } catch (error) {
    console.error('Erro ao alterar role:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/minha-organizacao/usuarios/:id
 * Remover usuário da minha organização
 */
router.delete('/minha-organizacao/usuarios/:id', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const usuarioId = parseInt(req.params.id);

    // Não pode remover a si mesmo
    if (usuarioId === req.usuario.id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Não é possível remover a si mesmo'
      });
    }

    await organizacaoService.removerUsuario(req.tenant.id, usuarioId);

    res.json({
      sucesso: true,
      mensagem: 'Usuário removido da organização'
    });
  } catch (error) {
    console.error('Erro ao remover usuário:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/minha-organizacao/convites
 * Listar convites da minha organização
 */
router.get('/minha-organizacao/convites', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const convites = await organizacaoService.listarConvites(req.tenant.id);

    res.json({
      sucesso: true,
      convites
    });
  } catch (error) {
    console.error('Erro ao listar convites:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/minha-organizacao/convites
 * Criar convite para minha organização
 */
router.post('/minha-organizacao/convites', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Email é obrigatório'
      });
    }

    // Admin não pode convidar como proprietário
    if (role === 'proprietario' && req.usuario.role_org !== 'proprietario') {
      return res.status(403).json({
        sucesso: false,
        erro: 'Apenas proprietário pode convidar outro proprietário'
      });
    }

    const convite = await organizacaoService.criarConvite(
      req.tenant.id,
      email,
      role,
      req.usuario.id
    );

    res.status(201).json({
      sucesso: true,
      convite,
      link_convite: `/aceitar-convite/${convite.token}`
    });
  } catch (error) {
    console.error('Erro ao criar convite:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/minha-organizacao/convites/:id
 * Cancelar convite
 */
router.delete('/minha-organizacao/convites/:id', autenticar, tenantContext, verificarRoleOrg('proprietario', 'admin'), async (req, res) => {
  try {
    await organizacaoService.cancelarConvite(parseInt(req.params.id), req.tenant.id);

    res.json({
      sucesso: true,
      mensagem: 'Convite cancelado'
    });
  } catch (error) {
    console.error('Erro ao cancelar convite:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== SUBTENANTS (Modelo Revenda) ====================

/**
 * GET /api/organizacoes/minhas
 * Listar organizações que o usuário criou ou tem acesso
 */
router.get('/organizacoes/minhas', autenticar, tenantContext, async (req, res) => {
  try {
    const organizacoes = await organizacaoService.listarMinhasOrganizacoes(req.usuario);

    res.json({
      sucesso: true,
      organizacoes
    });
  } catch (error) {
    console.error('Erro ao listar minhas organizações:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes/subtenant
 * Criar sub-organização
 */
router.post('/organizacoes/subtenant', autenticar, tenantContext, async (req, res) => {
  try {
    const { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, logo_url } = req.body;

    if (!nome || !email) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Nome e email são obrigatórios'
      });
    }

    const novaOrg = await organizacaoService.criarSubtenant(
      { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, logo_url },
      req.usuario
    );

    res.status(201).json({
      sucesso: true,
      organizacao: novaOrg,
      mensagem: `Sub-organização "${nome}" criada com sucesso`
    });
  } catch (error) {
    console.error('Erro ao criar subtenant:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/organizacoes/:id/filhos
 * Listar filhos de uma organização
 */
router.get('/organizacoes/:id/filhos', autenticar, tenantContext, async (req, res) => {
  try {
    const organizacaoId = parseInt(req.params.id);
    const subtenants = await organizacaoService.listarSubtenants(organizacaoId, req.usuario);

    res.json({
      sucesso: true,
      subtenants
    });
  } catch (error) {
    console.error('Erro ao listar subtenants:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes/:id/trocar-contexto
 * Trocar contexto para outra organização
 */
router.post('/organizacoes/:id/trocar-contexto', autenticar, async (req, res) => {
  try {
    const organizacaoId = parseInt(req.params.id);

    // Verificar se usuário pode acessar esta organização
    const podeAcessar = await organizacaoService.verificarAcessoOrganizacao(
      req.usuario.id,
      organizacaoId
    );

    if (!podeAcessar) {
      return res.status(403).json({
        sucesso: false,
        erro: 'Você não tem permissão para acessar esta organização'
      });
    }

    // Buscar dados da organização
    const organizacao = await organizacaoService.buscarPorId(organizacaoId);

    if (!organizacao) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Organização não encontrada'
      });
    }

    // Buscar role do usuário nesta organização
    const prisma = require('../db/prisma');
    const associacao = await prisma.usuarioOrganizacao.findFirst({
      where: {
        usuario_id: req.usuario.id,
        organizacao_id: organizacaoId
      }
    });

    res.json({
      sucesso: true,
      organizacao: {
        id: organizacao.id,
        nome: organizacao.nome,
        slug: organizacao.slug,
        logo_url: organizacao.logo_url,
        cor_primaria: organizacao.cor_primaria,
        cor_secundaria: organizacao.cor_secundaria,
        config_tema: organizacao.config_tema // White-label completo
      },
      role_org: associacao?.role || 'visualizador',
      mensagem: `Contexto alterado para ${organizacao.nome}`
    });
  } catch (error) {
    console.error('Erro ao trocar contexto:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/organizacoes/:id/acessiveis
 * Listar IDs de organizações que o usuário pode acessar
 */
router.get('/organizacoes/acessiveis', autenticar, async (req, res) => {
  try {
    const ids = await organizacaoService.obterOrganizacoesAcessiveis(req.usuario.id);

    res.json({
      sucesso: true,
      organizacoes_ids: ids,
      acesso_total: ids === null  // null = super_admin com acesso total
    });
  } catch (error) {
    console.error('Erro ao obter organizações acessíveis:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== SUPER ADMIN - GESTÃO DE TODAS AS ORGANIZAÇÕES ====================
// IMPORTANTE: Rotas com parâmetros dinâmicos (:id) devem vir por ÚLTIMO

/**
 * GET /api/organizacoes
 * Listar todas as organizações (super_admin)
 */
router.get('/organizacoes', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { status, busca } = req.query;
    const organizacoes = await organizacaoService.listarTodas({ status, busca });

    res.json({
      sucesso: true,
      organizacoes
    });
  } catch (error) {
    console.error('Erro ao listar organizações:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes
 * Criar nova organização (super_admin)
 */
router.post('/organizacoes', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, config_tema, logo_url } = req.body;

    if (!nome || !email) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Nome e email são obrigatórios'
      });
    }

    const organizacao = await organizacaoService.criar(
      { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, config_tema, logo_url },
      null // Super admin não é associado automaticamente
    );

    res.status(201).json({
      sucesso: true,
      organizacao
    });
  } catch (error) {
    console.error('Erro ao criar organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/organizacoes/:id
 * Detalhes de uma organização (super_admin)
 */
router.get('/organizacoes/:id', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const organizacao = await organizacaoService.buscarPorId(parseInt(req.params.id));

    if (!organizacao) {
      return res.status(404).json({
        sucesso: false,
        erro: 'Organização não encontrada'
      });
    }

    res.json({
      sucesso: true,
      organizacao
    });
  } catch (error) {
    console.error('Erro ao buscar organização:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/organizacoes/:id
 * Atualizar organização (super_admin)
 */
router.put('/organizacoes/:id', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const organizacao = await organizacaoService.atualizar(
      parseInt(req.params.id),
      req.body
    );

    res.json({
      sucesso: true,
      organizacao
    });
  } catch (error) {
    console.error('Erro ao atualizar organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/organizacoes/:id
 * Excluir organização (super_admin)
 */
router.delete('/organizacoes/:id', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    await organizacaoService.deletar(parseInt(req.params.id));

    res.json({
      sucesso: true,
      mensagem: 'Organização excluída com sucesso'
    });
  } catch (error) {
    console.error('Erro ao excluir organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * GET /api/organizacoes/:id/estatisticas
 * Estatísticas de uma organização (super_admin)
 */
router.get('/organizacoes/:id/estatisticas', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const estatisticas = await organizacaoService.obterEstatisticas(parseInt(req.params.id));

    res.json({
      sucesso: true,
      estatisticas
    });
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes/:id/transferir
 * Transferir organização para novo pai (super_admin)
 * Body: { novo_parent_id: number | null }
 */
router.post('/organizacoes/:id/transferir', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { novo_parent_id } = req.body;
    const resultado = await organizacaoService.transferirOrganizacao(
      parseInt(req.params.id),
      novo_parent_id ? parseInt(novo_parent_id) : null,
      req.usuario
    );

    res.json({
      sucesso: true,
      mensagem: 'Organização transferida com sucesso',
      ...resultado
    });
  } catch (error) {
    console.error('Erro ao transferir organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes/:id/absorver
 * Absorver organização (mover todos recursos para outra e deletar)
 * Body: { destino_id: number }
 */
router.post('/organizacoes/:id/absorver', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { destino_id } = req.body;

    if (!destino_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'destino_id é obrigatório'
      });
    }

    const resultado = await organizacaoService.absorverOrganizacao(
      parseInt(req.params.id),
      parseInt(destino_id),
      req.usuario
    );

    res.json({
      sucesso: true,
      mensagem: 'Organização absorvida com sucesso',
      ...resultado
    });
  } catch (error) {
    console.error('Erro ao absorver organização:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/organizacoes/:id/absorver-recursivo
 * Absorção RECURSIVA - absorve org + TODOS os sub-tenants de uma vez
 * Body: { destino_id: number }
 */
router.post('/organizacoes/:id/absorver-recursivo', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { destino_id } = req.body;

    if (!destino_id) {
      return res.status(400).json({
        sucesso: false,
        erro: 'destino_id é obrigatório'
      });
    }

    const resultado = await organizacaoService.absorverRecursivo(
      parseInt(req.params.id),
      parseInt(destino_id),
      req.usuario
    );

    res.json({
      sucesso: true,
      mensagem: 'Absorção recursiva concluída com sucesso',
      ...resultado
    });
  } catch (error) {
    console.error('Erro na absorção recursiva:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

// ==================== SUPER ADMIN - GESTÃO GLOBAL DE USUÁRIOS ====================

/**
 * GET /api/usuarios
 * Listar todos os usuários (super_admin)
 */
router.get('/usuarios', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const usuarios = await organizacaoService.listarTodosUsuarios();

    res.json({
      sucesso: true,
      usuarios
    });
  } catch (error) {
    console.error('Erro ao listar usuários:', error);
    res.status(500).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * POST /api/usuarios
 * Criar novo usuário (super_admin)
 */
router.post('/usuarios', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const { nome, email, senha, organizacao_id, role_org, role, organizacoes_permitidas, perfil_id } = req.body;

    if (!email || !senha) {
      return res.status(400).json({
        sucesso: false,
        erro: 'Email e senha são obrigatórios'
      });
    }

    // Verificar se perfil tem acesso global para determinar role automaticamente
    let roleAutomatico = role || 'usuario';
    if (perfil_id) {
      try {
        const perfil = await prisma.perfilPermissao.findUnique({ where: { id: parseInt(perfil_id) } });
        if (perfil) {
          const permissoes = typeof perfil.permissoes === 'string' ? JSON.parse(perfil.permissoes) : perfil.permissoes;
          if (permissoes?._acesso_global === true || perfil.nome === 'Acesso Total') {
            roleAutomatico = 'super_admin';
          }
        }
      } catch (e) {
        console.error('Erro ao verificar perfil para role:', e);
      }
    }

    const usuario = await organizacaoService.criarUsuarioGlobal({
      nome,
      email,
      senha,
      organizacao_id: organizacao_id ? parseInt(organizacao_id) : null,
      role_org,
      role: roleAutomatico,
      organizacoes_permitidas
    });

    // Associar perfil ao usuário se fornecido
    if (perfil_id && usuario.id) {
      try {
        await prisma.usuarioPerfilPermissao.create({
          data: {
            usuario_id: usuario.id,
            perfil_id: parseInt(perfil_id),
            organizacao_id: roleAutomatico === 'super_admin' ? null : (organizacao_id ? parseInt(organizacao_id) : null)
          }
        });
      } catch (perfilError) {
        console.error('Erro ao associar perfil:', perfilError);
      }
    }

    // Registrar auditoria
    await authService.registrarAuditoria(
      req.usuario.id,
      'CRIAR_USUARIO',
      'usuario',
      usuario.id.toString(),
      `Usuário criado: ${nome || email} (${roleAutomatico})`,
      req.ip,
      req.get('User-Agent'),
      true,
      organizacao_id ? parseInt(organizacao_id) : null
    );

    res.status(201).json({
      sucesso: true,
      usuario
    });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * PUT /api/usuarios/:id
 * Atualizar usuário (super_admin)
 */
router.put('/usuarios/:id', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const usuarioId = parseInt(req.params.id);
    const { perfil_id, ...updateData } = req.body;

    // Verificar se perfil tem acesso global para determinar role automaticamente
    if (perfil_id) {
      try {
        const perfil = await prisma.perfilPermissao.findUnique({ where: { id: parseInt(perfil_id) } });
        if (perfil) {
          const permissoes = typeof perfil.permissoes === 'string' ? JSON.parse(perfil.permissoes) : perfil.permissoes;
          if (permissoes?._acesso_global === true || perfil.nome === 'Acesso Total') {
            updateData.role = 'super_admin';
          } else if (!updateData.role) {
            updateData.role = 'usuario';
          }
        }
      } catch (e) {
        console.error('Erro ao verificar perfil para role:', e);
      }
    }

    const usuario = await organizacaoService.atualizarUsuarioGlobal(
      usuarioId,
      updateData
    );

    // Atualizar perfil do usuário se fornecido
    if (perfil_id !== undefined) {
      try {
        // Remover perfis anteriores
        await prisma.usuarioPerfilPermissao.deleteMany({
          where: { usuario_id: usuarioId }
        });

        // Associar novo perfil se fornecido
        if (perfil_id) {
          const roleAtual = updateData.role || usuario.role;
          await prisma.usuarioPerfilPermissao.create({
            data: {
              usuario_id: usuarioId,
              perfil_id: parseInt(perfil_id),
              organizacao_id: roleAtual === 'super_admin' ? null : (updateData.organizacao_id ? parseInt(updateData.organizacao_id) : null)
            }
          });
        }
      } catch (perfilError) {
        console.error('Erro ao atualizar perfil:', perfilError);
      }
    }

    // Registrar auditoria
    await authService.registrarAuditoria(
      req.usuario.id,
      'EDITAR_USUARIO',
      'usuario',
      usuarioId.toString(),
      `Usuário atualizado: ${usuario.nome || usuario.email}`,
      req.ip,
      req.get('User-Agent'),
      true,
      req.body.organizacao_id ? parseInt(req.body.organizacao_id) : null
    );

    res.json({
      sucesso: true,
      usuario
    });
  } catch (error) {
    console.error('Erro ao atualizar usuário:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

/**
 * DELETE /api/usuarios/:id
 * Excluir usuário (super_admin)
 */
router.delete('/usuarios/:id', autenticar, apenasSuperAdmin, async (req, res) => {
  try {
    const usuarioId = parseInt(req.params.id);
    await organizacaoService.deletarUsuarioGlobal(usuarioId);

    // Registrar auditoria
    await authService.registrarAuditoria(
      req.usuario.id,
      'EXCLUIR_USUARIO',
      'usuario',
      usuarioId.toString(),
      `Usuário excluído`,
      req.ip,
      req.get('User-Agent'),
      true,
      null
    );

    res.json({
      sucesso: true,
      mensagem: 'Usuário excluído com sucesso'
    });
  } catch (error) {
    console.error('Erro ao excluir usuário:', error);
    res.status(400).json({
      sucesso: false,
      erro: error.message
    });
  }
});

module.exports = router;
