/**
 * Service de Organizações (Multi-Tenant)
 * Gerencia operações de organizações, convites e usuários
 */

const prisma = require('../db/prisma');
const crypto = require('crypto');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');
const perfilPermissaoService = require('./perfil-permissao.service');

class OrganizacaoService {

  /**
   * Criar nova organização
   */
  async criar(dados, usuarioCriadorId) {
    let { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, logo_url, config_tema } = dados;

    // Sanitizar e validar campos
    nome = (nome || '').trim().substring(0, 100);
    email = (email || '').trim().substring(0, 255);
    telefone = telefone ? telefone.trim().substring(0, 20) : null;
    cnpj = cnpj ? cnpj.trim().substring(0, 18) : null;
    logo_url = logo_url ? logo_url.trim() : null;  // TEXT column - sem limite
    cor_primaria = cor_primaria ? cor_primaria.trim().substring(0, 7) : null;
    cor_secundaria = cor_secundaria ? cor_secundaria.trim().substring(0, 7) : null;

    // Validar config_tema se fornecido
    if (config_tema && typeof config_tema !== 'object') {
      try {
        config_tema = JSON.parse(config_tema);
      } catch (e) {
        config_tema = null;
      }
    }

    // Converter strings vazias para null
    if (cnpj === '') cnpj = null;
    if (telefone === '') telefone = null;
    if (logo_url === '') logo_url = null;

    if (!nome) throw new Error('Nome é obrigatório');
    if (!email) throw new Error('Email é obrigatório');

    // Verificar se slug já existe
    const slugFinal = this.gerarSlug(slug || nome);
    const existente = await prisma.organizacao.findUnique({
      where: { slug: slugFinal }
    });

    if (existente) {
      throw new Error('Slug já está em uso');
    }

    // Verificar CNPJ se fornecido
    if (cnpj) {
      const cnpjExistente = await prisma.organizacao.findUnique({
        where: { cnpj }
      });
      if (cnpjExistente) {
        throw new Error('CNPJ já cadastrado');
      }
    }

    // Criar organização
    const organizacao = await prisma.organizacao.create({
      data: {
        nome,
        slug: slugFinal,
        cnpj,
        email,
        telefone,
        plano_id: plano_id || null,
        ...(cor_primaria && { cor_primaria }),
        ...(cor_secundaria && { cor_secundaria }),
        ...(logo_url && { logo_url }),
        ...(config_tema && { config_tema })
      }
    });

    // Se houver usuário criador, associá-lo como proprietário
    if (usuarioCriadorId) {
      await prisma.usuarioOrganizacao.create({
        data: {
          usuario_id: usuarioCriadorId,
          organizacao_id: organizacao.id,
          role: 'proprietario',
          is_default: true
        }
      });
    }

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuarioCriadorId,
      organizacaoId: organizacao.id,
      acao: ACOES.CRIAR_ORGANIZACAO,
      recurso: 'organizacao',
      recursoId: organizacao.id,
      detalhes: `Organização "${nome}" criada`,
      dadosNovos: { nome, slug: slugFinal, email, cnpj, plano_id }
    });

    return organizacao;
  }

  /**
   * Gerar slug a partir do nome
   */
  gerarSlug(texto) {
    return texto
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  /**
   * Listar todas as organizações (super_admin)
   */
  async listarTodas(filtros = {}) {
    const where = {};

    if (filtros.status) {
      where.status = filtros.status;
    }

    if (filtros.busca) {
      where.OR = [
        { nome: { contains: filtros.busca, mode: 'insensitive' } },
        { slug: { contains: filtros.busca, mode: 'insensitive' } },
        { email: { contains: filtros.busca, mode: 'insensitive' } }
      ];
    }

    return prisma.organizacao.findMany({
      where,
      include: {
        plano: true,
        _count: {
          select: {
            usuarios: true,
            dispositivos: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });
  }

  /**
   * Buscar organização por ID
   */
  async buscarPorId(id) {
    return prisma.organizacao.findUnique({
      where: { id },
      include: {
        plano: true,
        _count: {
          select: {
            usuarios: true,
            dispositivos: true
          }
        }
      }
    });
  }

  /**
   * Buscar organização por slug
   */
  async buscarPorSlug(slug) {
    return prisma.organizacao.findUnique({
      where: { slug },
      include: {
        plano: true
      }
    });
  }

  /**
   * Atualizar organização
   */
  async atualizar(id, dados, usuarioId = null) {
    let { nome, email, telefone, logo_url, cor_primaria, cor_secundaria, config_tema, timezone, plano_id, status, cnpj } = dados;

    // Buscar dados anteriores para auditoria
    const anterior = await prisma.organizacao.findUnique({ where: { id } });

    // Sanitizar campos
    if (nome !== undefined) nome = nome ? nome.trim().substring(0, 100) : null;
    if (email !== undefined) email = email ? email.trim().substring(0, 255) : null;
    if (telefone !== undefined) telefone = telefone ? telefone.trim().substring(0, 20) : null;
    if (cnpj !== undefined) cnpj = cnpj ? cnpj.trim().substring(0, 18) : null;
    if (logo_url !== undefined) logo_url = logo_url ? logo_url.trim() : null;  // TEXT column
    if (cor_primaria !== undefined) cor_primaria = cor_primaria ? cor_primaria.trim().substring(0, 7) : null;
    if (cor_secundaria !== undefined) cor_secundaria = cor_secundaria ? cor_secundaria.trim().substring(0, 7) : null;
    if (timezone !== undefined) timezone = timezone ? timezone.trim().substring(0, 50) : null;

    // Validar config_tema se fornecido
    if (config_tema !== undefined && config_tema !== null && typeof config_tema !== 'object') {
      try {
        config_tema = JSON.parse(config_tema);
      } catch (e) {
        config_tema = null;
      }
    }

    // Converter strings vazias para null
    if (telefone === '') telefone = null;
    if (logo_url === '') logo_url = null;
    if (cnpj === '') cnpj = null;

    const dadosAtualizacao = {
      ...(nome && { nome }),
      ...(email && { email }),
      ...(telefone !== undefined && { telefone }),
      ...(logo_url !== undefined && { logo_url }),
      ...(cor_primaria && { cor_primaria }),
      ...(cor_secundaria && { cor_secundaria }),
      ...(config_tema !== undefined && { config_tema }),
      ...(timezone && { timezone }),
      ...(plano_id !== undefined && { plano_id }),
      ...(status && { status }),
      ...(cnpj !== undefined && { cnpj })
    };

    const organizacao = await prisma.organizacao.update({
      where: { id },
      data: dadosAtualizacao
    });

    // Determinar tipo de ação específico
    let acao = ACOES.EDITAR_ORGANIZACAO;
    let detalhes = `Organização "${anterior?.nome}" atualizada`;

    if (status && anterior?.status !== status) {
      if (status === 'ativo') {
        acao = ACOES.ATIVAR_ORGANIZACAO;
        detalhes = `Organização "${anterior?.nome}" ativada`;
      } else if (status === 'suspenso' || status === 'cancelado') {
        acao = ACOES.SUSPENDER_ORGANIZACAO;
        detalhes = `Organização "${anterior?.nome}" ${status}`;
      }
    }

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: id,
      acao,
      recurso: 'organizacao',
      recursoId: id,
      detalhes,
      dadosAnteriores: anterior,
      dadosNovos: dadosAtualizacao
    });

    return organizacao;
  }

  /**
   * Deletar organização
   */
  async deletar(id, usuarioId = null) {
    // Buscar dados antes de deletar para auditoria
    const organizacao = await prisma.organizacao.findUnique({ where: { id } });

    // Primeiro verificar se há dispositivos
    const dispositivos = await prisma.dispositivo.count({
      where: { organizacao_id: id }
    });

    if (dispositivos > 0) {
      throw new Error(`Não é possível excluir: organização possui ${dispositivos} dispositivo(s)`);
    }

    // Deletar (cascata remove usuarios_organizacoes e convites)
    const resultado = await prisma.organizacao.delete({
      where: { id }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      acao: ACOES.DELETAR_ORGANIZACAO,
      recurso: 'organizacao',
      recursoId: id,
      detalhes: `Organização "${organizacao?.nome}" (${organizacao?.slug}) excluída`
    });

    return resultado;
  }

  /**
   * Estatísticas da organização
   */
  async obterEstatisticas(id) {
    const [dispositivos, usuarios, dispositivosOnline, ultimaLocalizacao] = await Promise.all([
      prisma.dispositivo.count({ where: { organizacao_id: id } }),
      prisma.usuarioOrganizacao.count({ where: { organizacao_id: id } }),
      prisma.dispositivo.count({ where: { organizacao_id: id, status: 'online' } }),
      prisma.localizacao.findFirst({
        where: {
          dispositivo: { organizacao_id: id }
        },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true }
      })
    ]);

    const org = await prisma.organizacao.findUnique({
      where: { id },
      include: { plano: true }
    });

    return {
      dispositivos: {
        total: dispositivos,
        online: dispositivosOnline,
        limite: org?.plano?.max_dispositivos || 10,
        percentual_uso: org?.plano?.max_dispositivos
          ? Math.round((dispositivos / org.plano.max_dispositivos) * 100)
          : 0
      },
      usuarios: {
        total: usuarios,
        limite: org?.plano?.max_usuarios || 5,
        percentual_uso: org?.plano?.max_usuarios
          ? Math.round((usuarios / org.plano.max_usuarios) * 100)
          : 0
      },
      ultima_atividade: ultimaLocalizacao?.timestamp || null,
      plano: org?.plano?.nome || 'basico'
    };
  }

  // ==================== USUÁRIOS DA ORGANIZAÇÃO ====================

  /**
   * Listar usuários da organização
   */
  async listarUsuarios(organizacaoId) {
    const associacoes = await prisma.usuarioOrganizacao.findMany({
      where: { organizacao_id: organizacaoId },
      include: {
        usuario: {
          select: {
            id: true,
            email: true,
            nome: true,
            ativo: true,
            ultimo_login: true,
            created_at: true
          }
        }
      },
      orderBy: { created_at: 'asc' }
    });

    return associacoes.map(a => ({
      ...a.usuario,
      role: a.role,
      is_default: a.is_default,
      associacao_id: a.id
    }));
  }

  /**
   * Alterar role de usuário na organização
   */
  async alterarRoleUsuario(organizacaoId, usuarioId, novoRole) {
    const rolesValidas = ['proprietario', 'admin', 'operador', 'visualizador'];
    if (!rolesValidas.includes(novoRole)) {
      throw new Error(`Role inválida. Valores: ${rolesValidas.join(', ')}`);
    }

    // Verificar se é o único proprietário
    if (novoRole !== 'proprietario') {
      const proprietarios = await prisma.usuarioOrganizacao.count({
        where: {
          organizacao_id: organizacaoId,
          role: 'proprietario'
        }
      });

      const associacao = await prisma.usuarioOrganizacao.findUnique({
        where: {
          usuario_id_organizacao_id: {
            usuario_id: usuarioId,
            organizacao_id: organizacaoId
          }
        }
      });

      if (proprietarios === 1 && associacao?.role === 'proprietario') {
        throw new Error('Não é possível remover o único proprietário');
      }
    }

    return prisma.usuarioOrganizacao.update({
      where: {
        usuario_id_organizacao_id: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId
        }
      },
      data: { role: novoRole }
    });
  }

  /**
   * Remover usuário da organização
   */
  async removerUsuario(organizacaoId, usuarioId) {
    // Verificar se é o único proprietário
    const associacao = await prisma.usuarioOrganizacao.findUnique({
      where: {
        usuario_id_organizacao_id: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId
        }
      }
    });

    if (associacao?.role === 'proprietario') {
      const proprietarios = await prisma.usuarioOrganizacao.count({
        where: {
          organizacao_id: organizacaoId,
          role: 'proprietario'
        }
      });

      if (proprietarios === 1) {
        throw new Error('Não é possível remover o único proprietário');
      }
    }

    return prisma.usuarioOrganizacao.delete({
      where: {
        usuario_id_organizacao_id: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId
        }
      }
    });
  }

  // ==================== CONVITES ====================

  /**
   * Criar convite
   */
  async criarConvite(organizacaoId, email, role, convidadoPorId) {
    // Verificar limite de usuários
    const org = await prisma.organizacao.findUnique({
      where: { id: organizacaoId },
      include: { plano: true }
    });

    const totalUsuarios = await prisma.usuarioOrganizacao.count({
      where: { organizacao_id: organizacaoId }
    });

    const limite = org?.plano?.max_usuarios || 5;
    if (totalUsuarios >= limite) {
      throw new Error(`Limite de usuários atingido (${totalUsuarios}/${limite})`);
    }

    // Verificar se já existe usuário com este email na org
    const usuarioExistente = await prisma.usuario.findUnique({
      where: { email }
    });

    if (usuarioExistente) {
      const jaAssociado = await prisma.usuarioOrganizacao.findUnique({
        where: {
          usuario_id_organizacao_id: {
            usuario_id: usuarioExistente.id,
            organizacao_id: organizacaoId
          }
        }
      });

      if (jaAssociado) {
        throw new Error('Usuário já pertence a esta organização');
      }
    }

    // Verificar se já existe convite pendente
    const conviteExistente = await prisma.convite.findFirst({
      where: {
        organizacao_id: organizacaoId,
        email,
        aceito: false,
        expires_at: { gt: new Date() }
      }
    });

    if (conviteExistente) {
      throw new Error('Já existe um convite pendente para este email');
    }

    // Gerar token único
    const token = crypto.randomBytes(32).toString('hex');

    // Criar convite (expira em 7 dias)
    const expires_at = new Date();
    expires_at.setDate(expires_at.getDate() + 7);

    return prisma.convite.create({
      data: {
        organizacao_id: organizacaoId,
        email,
        role: role || 'operador',
        token,
        expires_at,
        convidado_por: convidadoPorId
      },
      include: {
        organizacao: {
          select: { nome: true, slug: true }
        }
      }
    });
  }

  /**
   * Listar convites da organização
   */
  async listarConvites(organizacaoId) {
    return prisma.convite.findMany({
      where: { organizacao_id: organizacaoId },
      orderBy: { created_at: 'desc' }
    });
  }

  /**
   * Cancelar convite
   */
  async cancelarConvite(conviteId, organizacaoId) {
    const convite = await prisma.convite.findUnique({
      where: { id: conviteId }
    });

    if (!convite || convite.organizacao_id !== organizacaoId) {
      throw new Error('Convite não encontrado');
    }

    return prisma.convite.delete({
      where: { id: conviteId }
    });
  }

  /**
   * Validar convite por token
   */
  async validarConvite(token) {
    const convite = await prisma.convite.findUnique({
      where: { token },
      include: {
        organizacao: {
          select: { id: true, nome: true, slug: true, logo_url: true }
        }
      }
    });

    if (!convite) {
      throw new Error('Convite não encontrado');
    }

    if (convite.aceito) {
      throw new Error('Convite já foi utilizado');
    }

    if (convite.expires_at < new Date()) {
      throw new Error('Convite expirado');
    }

    return convite;
  }

  /**
   * Aceitar convite (criar conta ou associar existente)
   */
  async aceitarConvite(token, dadosUsuario) {
    const convite = await this.validarConvite(token);

    const { nome, senha } = dadosUsuario;

    // Verificar se usuário já existe
    let usuario = await prisma.usuario.findUnique({
      where: { email: convite.email }
    });

    if (usuario) {
      // Usuário existe, apenas associar à organização
      await prisma.usuarioOrganizacao.create({
        data: {
          usuario_id: usuario.id,
          organizacao_id: convite.organizacao_id,
          role: convite.role,
          is_default: false
        }
      });
    } else {
      // Criar novo usuário
      if (!nome || !senha) {
        throw new Error('Nome e senha são obrigatórios para novos usuários');
      }

      const bcrypt = require('bcrypt');
      const senhaHash = await bcrypt.hash(senha, 12);

      usuario = await prisma.usuario.create({
        data: {
          email: convite.email,
          nome,
          senha_hash: senhaHash,
          role: 'usuario'
        }
      });

      // Associar à organização
      await prisma.usuarioOrganizacao.create({
        data: {
          usuario_id: usuario.id,
          organizacao_id: convite.organizacao_id,
          role: convite.role,
          is_default: true
        }
      });
    }

    // Marcar convite como aceito
    await prisma.convite.update({
      where: { id: convite.id },
      data: {
        aceito: true,
        aceito_em: new Date()
      }
    });

    return {
      usuario: {
        id: usuario.id,
        email: usuario.email,
        nome: usuario.nome
      },
      organizacao: convite.organizacao
    };
  }

  // ==================== PLANOS ====================

  /**
   * Listar planos disponíveis
   */
  async listarPlanos() {
    return prisma.plano.findMany({
      where: { ativo: true },
      orderBy: { preco_mensal: 'asc' }
    });
  }

  /**
   * Atualizar email de contato do plano
   */
  async atualizarEmailPlano(planoId, emailContato) {
    return prisma.plano.update({
      where: { id: planoId },
      data: { email_contato: emailContato || null }
    });
  }

  // ==================== GESTÃO GLOBAL DE USUÁRIOS (Super Admin) ====================

  /**
   * Listar todos os usuários (super_admin)
   */
  async listarTodosUsuarios(options = {}) {
    const { isSuperAdmin = false, organizacaoIds = [] } = options;

    // Super admin vê todos os usuários
    if (isSuperAdmin) {
      return prisma.usuario.findMany({
        select: {
          id: true,
          email: true,
          nome: true,
          role: true,
          ativo: true,
          ultimo_login: true,
          created_at: true,
          organizacoes_permitidas: true,
          organizacoes: {
            include: {
              organizacao: {
                select: { id: true, nome: true, slug: true }
              }
            }
          },
          perfis: {
            include: {
              perfil: {
                select: { id: true, nome: true }
              }
            }
          }
        },
        orderBy: { created_at: 'desc' }
      });
    }

    // Admin de organização vê apenas usuários das suas organizações
    if (organizacaoIds.length > 0) {
      // Buscar IDs de usuários que pertencem às organizações
      const associacoes = await prisma.usuarioOrganizacao.findMany({
        where: {
          organizacao_id: { in: organizacaoIds }
        },
        select: { usuario_id: true }
      });

      const usuarioIds = [...new Set(associacoes.map(a => a.usuario_id))];

      return prisma.usuario.findMany({
        where: {
          id: { in: usuarioIds }
        },
        select: {
          id: true,
          email: true,
          nome: true,
          role: true,
          ativo: true,
          ultimo_login: true,
          created_at: true,
          organizacoes_permitidas: true,
          organizacoes: {
            include: {
              organizacao: {
                select: { id: true, nome: true, slug: true }
              }
            }
          },
          perfis: {
            include: {
              perfil: {
                select: { id: true, nome: true }
              }
            }
          }
        },
        orderBy: { created_at: 'desc' }
      });
    }

    // Sem organizações, retorna vazio
    return [];
  }

  /**
   * Criar usuário e associar a uma ou mais organizações (super_admin)
   */
  async criarUsuarioGlobal(dados) {
    const { nome, email, senha, organizacao_id, organizacoes_ids, role_org, role, organizacoes_permitidas } = dados;

    // Verificar se email já existe
    const existente = await prisma.usuario.findUnique({
      where: { email }
    });

    if (existente) {
      throw new Error('Email já cadastrado');
    }

    const bcrypt = require('bcrypt');
    const senhaHash = await bcrypt.hash(senha, 12);

    // Determinar role global (super_admin ou usuario)
    const roleGlobal = role === 'super_admin' ? 'super_admin' : 'usuario';

    // Preparar dados do usuário
    const userData = {
      email,
      nome,
      senha_hash: senhaHash,
      role: roleGlobal
    };

    // Se for super_admin, salvar organizações permitidas
    if (roleGlobal === 'super_admin' && organizacoes_permitidas) {
      userData.organizacoes_permitidas = JSON.stringify(organizacoes_permitidas);
    }

    // Criar usuário
    const usuario = await prisma.usuario.create({
      data: userData
    });

    // Super_admin: vincular a todas as organizações (ou às permitidas)
    if (roleGlobal === 'super_admin') {
      let orgsParaVincular = [];

      if (organizacoes_permitidas && organizacoes_permitidas.length > 0) {
        // Vincular apenas às organizações permitidas
        orgsParaVincular = organizacoes_permitidas;
      } else {
        // Vincular a TODAS as organizações
        const todasOrgs = await prisma.organizacao.findMany({ select: { id: true } });
        orgsParaVincular = todasOrgs.map(o => o.id);
      }

      // Criar vínculos
      for (let i = 0; i < orgsParaVincular.length; i++) {
        await prisma.usuarioOrganizacao.create({
          data: {
            usuario_id: usuario.id,
            organizacao_id: orgsParaVincular[i],
            role: 'admin',
            is_default: i === 0 // Primeira é a padrão
          }
        });
      }
      console.log(`[Usuário] Super_admin ${email} vinculado a ${orgsParaVincular.length} organizações`);
    }
    // Múltiplas organizações (novo formato)
    else if (organizacoes_ids && Array.isArray(organizacoes_ids) && organizacoes_ids.length > 0) {
      for (let i = 0; i < organizacoes_ids.length; i++) {
        await prisma.usuarioOrganizacao.create({
          data: {
            usuario_id: usuario.id,
            organizacao_id: parseInt(organizacoes_ids[i]),
            role: role_org || 'operador',
            is_default: i === 0
          }
        });
      }
      console.log(`[Usuário] ${email} vinculado a ${organizacoes_ids.length} organização(ões)`);
    }
    // Compatibilidade: organização única (formato antigo)
    else if (organizacao_id) {
      await prisma.usuarioOrganizacao.create({
        data: {
          usuario_id: usuario.id,
          organizacao_id: organizacao_id,
          role: role_org || 'operador',
          is_default: true
        }
      });
    }

    console.log(`[Usuário] Criado: ${email} com role ${roleGlobal}`);
    return usuario;
  }

  /**
   * Atualizar usuário (super_admin)
   */
  async atualizarUsuarioGlobal(usuarioId, dados) {
    const { nome, email, senha, ativo, organizacao_id, organizacoes_ids, role_org, role, organizacoes_permitidas } = dados;

    const updateData = {};
    if (nome) updateData.nome = nome;
    if (email) updateData.email = email;
    if (ativo !== undefined) updateData.ativo = ativo;

    // Permitir alteração da role global (super_admin/usuario)
    if (role) {
      updateData.role = role === 'super_admin' ? 'super_admin' : 'usuario';
    }

    // Atualizar organizações permitidas para super_admin
    if (organizacoes_permitidas !== undefined) {
      if (organizacoes_permitidas && organizacoes_permitidas.length > 0) {
        updateData.organizacoes_permitidas = JSON.stringify(organizacoes_permitidas);
      } else {
        updateData.organizacoes_permitidas = null;
      }
    }

    if (senha) {
      const bcrypt = require('bcrypt');
      updateData.senha_hash = await bcrypt.hash(senha, 12);
    }

    const usuario = await prisma.usuario.update({
      where: { id: usuarioId },
      data: updateData
    });

    // Se foram fornecidas MÚLTIPLAS organizações (novo formato)
    if (organizacoes_ids && Array.isArray(organizacoes_ids) && organizacoes_ids.length > 0 && role_org) {
      // Primeiro, remover TODAS as associações antigas
      await prisma.usuarioOrganizacao.deleteMany({
        where: { usuario_id: usuarioId }
      });

      // Criar associações para cada organização selecionada
      for (let i = 0; i < organizacoes_ids.length; i++) {
        await prisma.usuarioOrganizacao.create({
          data: {
            usuario_id: usuarioId,
            organizacao_id: parseInt(organizacoes_ids[i]),
            role: role_org,
            is_default: i === 0 // Primeira é a default
          }
        });
      }

      console.log(`[Usuário] Organizações atualizadas: ID ${usuarioId} -> ${organizacoes_ids.length} org(s): ${organizacoes_ids.join(', ')}`);
    }
    // Compatibilidade: Se fornecida uma única organização (formato antigo)
    else if (organizacao_id && role_org) {
      await prisma.usuarioOrganizacao.deleteMany({
        where: { usuario_id: usuarioId }
      });

      await prisma.usuarioOrganizacao.create({
        data: {
          usuario_id: usuarioId,
          organizacao_id: organizacao_id,
          role: role_org,
          is_default: true
        }
      });

      console.log(`[Usuário] Organização alterada: ID ${usuarioId} -> Org ${organizacao_id}`);
    }

    console.log(`[Usuário] Atualizado: ID ${usuarioId}, role: ${updateData.role || 'mantido'}`);
    return usuario;
  }

  /**
   * Deletar usuário (super_admin)
   */
  async deletarUsuarioGlobal(usuarioId) {
    // Verificar se é super_admin
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId }
    });

    if (usuario?.role === 'super_admin') {
      throw new Error('Não é possível excluir um super admin');
    }

    // Deletar (cascata remove associações)
    return prisma.usuario.delete({
      where: { id: usuarioId }
    });
  }

  // ==================== SUBTENANTS (Modelo Revenda) ====================

  /**
   * Criar sub-organização (subtenant)
   * @param {Object} dados - Dados da nova organização
   * @param {Object} usuarioCriador - Usuário que está criando (revendedor)
   */
  async criarSubtenant(dados, usuarioCriador) {
    const { nome, slug, cnpj, email, telefone, plano_id, cor_primaria, cor_secundaria, logo_url } = dados;

    // 1. Verificar se usuário tem permissão 'criar_subtenant'
    const temPermissao = await perfilPermissaoService.verificarPermissao(
      usuarioCriador.id,
      'organizacoes',
      'criar_subtenant',
      usuarioCriador.organizacao_id
    );

    if (!temPermissao && usuarioCriador.role !== 'super_admin') {
      throw new Error('Você não tem permissão para criar sub-organizações');
    }

    // 2. Buscar organização pai do usuário
    const orgPai = await prisma.organizacao.findUnique({
      where: { id: usuarioCriador.organizacao_id },
      include: { plano: true }
    });

    if (!orgPai) {
      throw new Error('Organização pai não encontrada');
    }

    // 2.5. Verificar limite de nível hierárquico (máximo 2 níveis de profundidade)
    // Nível 0 = Raiz (Unifique), Nível 1 = Revendedor, Nível 2 = Cliente do Revendedor
    const NIVEL_MAXIMO = 2;
    if (orgPai.nivel >= NIVEL_MAXIMO) {
      throw new Error(`Limite de hierarquia atingido. Organizações de nível ${orgPai.nivel} não podem criar sub-organizações.`);
    }

    // 3. Verificar limite de subtenants do plano
    if (orgPai.plano) {
      const maxSubtenants = orgPai.plano.max_subtenants || 0;

      if (maxSubtenants === 0) {
        throw new Error('Seu plano não permite criar sub-organizações');
      }

      if (maxSubtenants > 0) { // -1 = ilimitado
        const subtenantsAtuais = await prisma.organizacao.count({
          where: { parent_organizacao_id: orgPai.id }
        });

        if (subtenantsAtuais >= maxSubtenants) {
          throw new Error(`Limite de sub-organizações atingido (${subtenantsAtuais}/${maxSubtenants})`);
        }
      }
    }

    // 4. Validar e sanitizar dados
    const nomeSanitizado = (nome || '').trim().substring(0, 100);
    const emailSanitizado = (email || '').trim().substring(0, 255);
    const telefoneSanitizado = telefone ? telefone.trim().substring(0, 20) : null;
    const cnpjSanitizado = cnpj ? cnpj.trim().substring(0, 18) : null;

    if (!nomeSanitizado) throw new Error('Nome é obrigatório');
    if (!emailSanitizado) throw new Error('Email é obrigatório');

    // 5. Gerar slug
    const slugFinal = this.gerarSlug(slug || nomeSanitizado);
    const slugExistente = await prisma.organizacao.findUnique({
      where: { slug: slugFinal }
    });

    if (slugExistente) {
      throw new Error('Slug já está em uso');
    }

    // 6. Verificar CNPJ se fornecido
    if (cnpjSanitizado) {
      const cnpjExistente = await prisma.organizacao.findUnique({
        where: { cnpj: cnpjSanitizado }
      });
      if (cnpjExistente) {
        throw new Error('CNPJ já cadastrado');
      }
    }

    // 7. Criar organização filha
    const novaOrg = await prisma.organizacao.create({
      data: {
        nome: nomeSanitizado,
        slug: slugFinal,
        cnpj: cnpjSanitizado,
        email: emailSanitizado,
        telefone: telefoneSanitizado,
        plano_id: plano_id || orgPai.plano_id,  // Herda plano do pai se não especificado
        parent_organizacao_id: orgPai.id,
        criado_por_usuario_id: usuarioCriador.id,
        nivel: orgPai.nivel + 1,
        ...(cor_primaria && { cor_primaria }),
        ...(cor_secundaria && { cor_secundaria }),
        ...(logo_url && { logo_url })
      },
      include: {
        plano: true,
        parent: {
          select: { id: true, nome: true, slug: true }
        }
      }
    });

    // 8. Vincular usuário criador como 'proprietario' da nova org
    await prisma.usuarioOrganizacao.create({
      data: {
        usuario_id: usuarioCriador.id,
        organizacao_id: novaOrg.id,
        role: 'proprietario',
        is_default: false  // Não é a organização padrão
      }
    });

    // 9. Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuarioCriador.id,
      organizacaoId: novaOrg.id,
      acao: ACOES.CRIAR_ORGANIZACAO,
      recurso: 'organizacao',
      recursoId: novaOrg.id,
      detalhes: `Sub-organização "${nomeSanitizado}" criada (pai: ${orgPai.nome})`,
      dadosNovos: { nome: nomeSanitizado, slug: slugFinal, parent_id: orgPai.id }
    });

    console.log(`[Subtenant] Criado: "${nomeSanitizado}" (pai: ${orgPai.nome}) por usuário ${usuarioCriador.id}`);

    return novaOrg;
  }

  /**
   * Listar organizações que o usuário criou ou tem acesso
   * @param {Object} usuario - Usuário logado
   */
  async listarMinhasOrganizacoes(usuario) {
    // Super admin vê todas
    if (usuario.role === 'super_admin') {
      return this.listarTodas({});
    }

    // Verificar se tem permissão gerenciar_subtenants
    const temPermissaoSubtenant = await perfilPermissaoService.verificarPermissao(
      usuario.id,
      'organizacoes',
      'gerenciar_subtenants',
      usuario.organizacao_id
    );

    if (temPermissaoSubtenant) {
      // Retorna: sua org + orgs que criou
      const organizacoes = await prisma.organizacao.findMany({
        where: {
          OR: [
            { id: usuario.organizacao_id },  // Sua própria org
            { criado_por_usuario_id: usuario.id }  // Orgs que criou
          ]
        },
        include: {
          plano: true,
          parent: {
            select: { id: true, nome: true, slug: true }
          },
          _count: {
            select: {
              usuarios: true,
              dispositivos: true,
              filhos: true
            }
          }
        },
        orderBy: [
          { nivel: 'asc' },
          { created_at: 'desc' }
        ]
      });

      return organizacoes;
    }

    // Usuário sem permissão vê apenas sua org
    const minhaOrg = await prisma.organizacao.findUnique({
      where: { id: usuario.organizacao_id },
      include: {
        plano: true,
        _count: {
          select: {
            usuarios: true,
            dispositivos: true
          }
        }
      }
    });

    return minhaOrg ? [minhaOrg] : [];
  }

  /**
   * Listar filhos diretos de uma organização
   * @param {number} organizacaoId - ID da organização pai
   * @param {Object} usuario - Usuário logado
   */
  async listarSubtenants(organizacaoId, usuario) {
    // Verificar permissão
    if (usuario.role !== 'super_admin') {
      // Verificar se o usuário criou esta org ou é a org dele
      const orgPai = await prisma.organizacao.findUnique({
        where: { id: organizacaoId }
      });

      if (!orgPai) {
        throw new Error('Organização não encontrada');
      }

      const ehProprietario = orgPai.criado_por_usuario_id === usuario.id ||
                            organizacaoId === usuario.organizacao_id;

      if (!ehProprietario) {
        throw new Error('Você não tem permissão para ver os subtenants desta organização');
      }
    }

    return prisma.organizacao.findMany({
      where: { parent_organizacao_id: organizacaoId },
      include: {
        plano: true,
        _count: {
          select: {
            usuarios: true,
            dispositivos: true,
            filhos: true
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });
  }

  /**
   * Verificar se usuário pode acessar uma organização
   * @param {number} usuarioId - ID do usuário
   * @param {number} organizacaoId - ID da organização alvo
   */
  async verificarAcessoOrganizacao(usuarioId, organizacaoId) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId }
    });

    if (!usuario) return false;

    // Super admin tem acesso total
    if (usuario.role === 'super_admin') return true;

    // Verificar se é a organização padrão do usuário
    const associacao = await prisma.usuarioOrganizacao.findFirst({
      where: {
        usuario_id: usuarioId,
        organizacao_id: organizacaoId
      }
    });

    if (associacao) return true;

    // Verificar se o usuário criou esta organização
    const orgCriada = await prisma.organizacao.findFirst({
      where: {
        id: organizacaoId,
        criado_por_usuario_id: usuarioId
      }
    });

    return !!orgCriada;
  }

  /**
   * Obter IDs de todas organizações que o usuário pode acessar
   * @param {number} usuarioId - ID do usuário
   */
  async obterOrganizacoesAcessiveis(usuarioId) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId }
    });

    if (!usuario) return [];

    // Super admin: retorna null (sem filtro)
    if (usuario.role === 'super_admin') return null;

    // Buscar orgs onde tem associação
    const associacoes = await prisma.usuarioOrganizacao.findMany({
      where: { usuario_id: usuarioId },
      select: { organizacao_id: true }
    });

    // Buscar orgs que criou
    const orgsCriadas = await prisma.organizacao.findMany({
      where: { criado_por_usuario_id: usuarioId },
      select: { id: true }
    });

    const ids = new Set([
      ...associacoes.map(a => a.organizacao_id),
      ...orgsCriadas.map(o => o.id)
    ]);

    return Array.from(ids);
  }

  /**
   * Suspender organização e todos os filhos (cascata)
   * @param {number} organizacaoId - ID da organização
   * @param {number} usuarioId - Usuário que está suspendendo
   */
  async suspenderComFilhos(organizacaoId, usuarioId) {
    // Buscar todos os filhos recursivamente
    const buscarFilhosRecursivo = async (parentId) => {
      const filhos = await prisma.organizacao.findMany({
        where: { parent_organizacao_id: parentId },
        select: { id: true }
      });

      let todosIds = filhos.map(f => f.id);

      for (const filho of filhos) {
        const netos = await buscarFilhosRecursivo(filho.id);
        todosIds = [...todosIds, ...netos];
      }

      return todosIds;
    };

    const idsFilhos = await buscarFilhosRecursivo(organizacaoId);
    const todosIds = [organizacaoId, ...idsFilhos];

    // Suspender todos
    await prisma.organizacao.updateMany({
      where: { id: { in: todosIds } },
      data: { status: 'suspenso' }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId,
      acao: ACOES.SUSPENDER_ORGANIZACAO,
      recurso: 'organizacao',
      recursoId: organizacaoId,
      detalhes: `Organização suspensa com ${idsFilhos.length} sub-organizações`
    });

    console.log(`[Organização] Suspensas: ${todosIds.length} organizações`);

    return { organizacoes_afetadas: todosIds.length };
  }

  /**
   * Verificar se pode deletar organização (não pode ter filhos)
   */
  async verificarPodeDeletar(organizacaoId) {
    const filhos = await prisma.organizacao.count({
      where: { parent_organizacao_id: organizacaoId }
    });

    if (filhos > 0) {
      throw new Error(`Não é possível excluir: organização possui ${filhos} sub-organização(ões). Delete os filhos primeiro.`);
    }

    return true;
  }

  /**
   * Transferir organização para novo pai (migrar tenant)
   * Usado quando um revendedor encerra parceria e seus clientes precisam ser transferidos
   * @param {number} organizacaoId - ID da organização a ser transferida
   * @param {number} novoParentId - ID do novo pai (null para tornar raiz)
   * @param {object} usuarioExecutor - Usuário que está executando a ação (deve ser super_admin)
   */
  async transferirOrganizacao(organizacaoId, novoParentId, usuarioExecutor) {
    // Apenas super_admin pode transferir organizações
    if (usuarioExecutor.role !== 'super_admin') {
      throw new Error('Apenas super_admin pode transferir organizações entre tenants');
    }

    const orgParaTransferir = await prisma.organizacao.findUnique({
      where: { id: organizacaoId },
      include: { parent: true }
    });

    if (!orgParaTransferir) {
      throw new Error('Organização não encontrada');
    }

    let novoNivel = 0;
    let novoParent = null;

    if (novoParentId) {
      novoParent = await prisma.organizacao.findUnique({
        where: { id: novoParentId }
      });

      if (!novoParent) {
        throw new Error('Nova organização pai não encontrada');
      }

      // Verificar se não está tentando transferir para si mesma ou filho
      if (novoParentId === organizacaoId) {
        throw new Error('Não é possível transferir uma organização para si mesma');
      }

      // Verificar ciclo (não pode transferir para um de seus filhos)
      const ehFilho = await this.verificarSeEhFilho(organizacaoId, novoParentId);
      if (ehFilho) {
        throw new Error('Não é possível transferir para uma sub-organização');
      }

      novoNivel = novoParent.nivel + 1;
    }

    // Calcular diferença de nível para atualizar filhos
    const diferencaNivel = novoNivel - orgParaTransferir.nivel;

    // Buscar todos os filhos recursivamente
    const todosFilhos = await this.buscarTodosFilhosRecursivo(organizacaoId);

    // Atualizar organização principal
    await prisma.organizacao.update({
      where: { id: organizacaoId },
      data: {
        parent_organizacao_id: novoParentId,
        nivel: novoNivel
      }
    });

    // Atualizar nível de todos os filhos
    if (todosFilhos.length > 0 && diferencaNivel !== 0) {
      for (const filho of todosFilhos) {
        await prisma.organizacao.update({
          where: { id: filho.id },
          data: { nivel: filho.nivel + diferencaNivel }
        });
      }
    }

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuarioExecutor.id,
      organizacaoId,
      acao: 'TRANSFERIR_ORGANIZACAO',
      recurso: 'organizacao',
      recursoId: organizacaoId,
      detalhes: `Organização transferida de pai ${orgParaTransferir.parent_organizacao_id || 'raiz'} para ${novoParentId || 'raiz'}. ${todosFilhos.length} sub-organizações afetadas.`
    });

    console.log(`[Organização] Transferida: ${orgParaTransferir.nome} para novo pai ${novoParentId || 'RAIZ'}`);

    return {
      organizacao: orgParaTransferir.nome,
      pai_anterior: orgParaTransferir.parent?.nome || 'Raiz',
      pai_novo: novoParent?.nome || 'Raiz',
      nivel_novo: novoNivel,
      filhos_afetados: todosFilhos.length
    };
  }

  /**
   * Verifica se targetId é filho (direto ou indireto) de parentId
   */
  async verificarSeEhFilho(parentId, targetId) {
    const filhos = await prisma.organizacao.findMany({
      where: { parent_organizacao_id: parentId },
      select: { id: true }
    });

    for (const filho of filhos) {
      if (filho.id === targetId) return true;
      const ehFilhoRecursivo = await this.verificarSeEhFilho(filho.id, targetId);
      if (ehFilhoRecursivo) return true;
    }

    return false;
  }

  /**
   * Busca todos os filhos recursivamente
   */
  async buscarTodosFilhosRecursivo(parentId) {
    const filhos = await prisma.organizacao.findMany({
      where: { parent_organizacao_id: parentId },
      select: { id: true, nivel: true, nome: true }
    });

    let todosFilhos = [...filhos];

    for (const filho of filhos) {
      const netos = await this.buscarTodosFilhosRecursivo(filho.id);
      todosFilhos = todosFilhos.concat(netos);
    }

    return todosFilhos;
  }

  /**
   * Absorver organização (mover todos os recursos para outra org e deletar)
   * Usado quando quer trazer os dados de um revendedor para sua base
   * @param {number} orgOrigemId - Organização a ser absorvida (será deletada)
   * @param {number} orgDestinoId - Organização que receberá os recursos
   * @param {object} usuarioExecutor - Usuário executando (deve ser super_admin)
   */
  async absorverOrganizacao(orgOrigemId, orgDestinoId, usuarioExecutor) {
    if (usuarioExecutor.role !== 'super_admin') {
      throw new Error('Apenas super_admin pode absorver organizações');
    }

    if (orgOrigemId === orgDestinoId) {
      throw new Error('Origem e destino não podem ser iguais');
    }

    const orgOrigem = await prisma.organizacao.findUnique({
      where: { id: orgOrigemId },
      include: { filhos: true }
    });

    const orgDestino = await prisma.organizacao.findUnique({
      where: { id: orgDestinoId }
    });

    if (!orgOrigem) throw new Error('Organização origem não encontrada');
    if (!orgDestino) throw new Error('Organização destino não encontrada');

    // Primeiro, transferir filhos da origem para o destino
    if (orgOrigem.filhos.length > 0) {
      await prisma.organizacao.updateMany({
        where: { parent_organizacao_id: orgOrigemId },
        data: {
          parent_organizacao_id: orgDestinoId,
          nivel: orgDestino.nivel + 1
        }
      });
    }

    // Transferir veículos
    const veiculosTransferidos = await prisma.veiculo.updateMany({
      where: { organizacao_id: orgOrigemId },
      data: { organizacao_id: orgDestinoId }
    });

    // Transferir dispositivos
    const dispositivosTransferidos = await prisma.dispositivo.updateMany({
      where: { organizacao_id: orgOrigemId },
      data: { organizacao_id: orgDestinoId }
    });

    // Transferir motoristas
    const motoristasTransferidos = await prisma.motorista.updateMany({
      where: { organizacao_id: orgOrigemId },
      data: { organizacao_id: orgDestinoId }
    });

    // Transferir cercas virtuais (geofences)
    const cercasTransferidas = await prisma.geofence.updateMany({
      where: { organizacao_id: orgOrigemId },
      data: { organizacao_id: orgDestinoId }
    });

    // Transferir usuários (vincular ao destino)
    const usuariosOrigem = await prisma.usuarioOrganizacao.findMany({
      where: { organizacao_id: orgOrigemId }
    });

    for (const uo of usuariosOrigem) {
      // Verificar se já existe vínculo no destino
      const existeVinculo = await prisma.usuarioOrganizacao.findUnique({
        where: {
          usuario_id_organizacao_id: {
            usuario_id: uo.usuario_id,
            organizacao_id: orgDestinoId
          }
        }
      });

      if (!existeVinculo) {
        await prisma.usuarioOrganizacao.create({
          data: {
            usuario_id: uo.usuario_id,
            organizacao_id: orgDestinoId,
            role: uo.role
          }
        });
      }
    }

    // Remover vínculos da organização origem
    await prisma.usuarioOrganizacao.deleteMany({
      where: { organizacao_id: orgOrigemId }
    });

    // Deletar organização origem
    await prisma.organizacao.delete({
      where: { id: orgOrigemId }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuarioExecutor.id,
      organizacaoId: orgDestinoId,
      acao: 'ABSORVER_ORGANIZACAO',
      recurso: 'organizacao',
      recursoId: orgOrigemId,
      detalhes: `Organização "${orgOrigem.nome}" absorvida por "${orgDestino.nome}". Transferidos: ${veiculosTransferidos.count} veículos, ${dispositivosTransferidos.count} dispositivos, ${motoristasTransferidos.count} motoristas, ${cercasTransferidas.count} cercas, ${usuariosOrigem.length} usuários, ${orgOrigem.filhos.length} sub-organizações.`
    });

    console.log(`[Organização] Absorvida: ${orgOrigem.nome} → ${orgDestino.nome}`);

    return {
      origem_deletada: orgOrigem.nome,
      destino: orgDestino.nome,
      transferidos: {
        veiculos: veiculosTransferidos.count,
        dispositivos: dispositivosTransferidos.count,
        motoristas: motoristasTransferidos.count,
        cercas: cercasTransferidas.count,
        usuarios: usuariosOrigem.length,
        sub_organizacoes: orgOrigem.filhos.length
      }
    };
  }

  /**
   * Absorção RECURSIVA - Absorve organização + TODOS os sub-tenants
   * Move todos os dados de toda a hierarquia para o destino
   * @param {number} orgOrigemId - Organização raiz a ser absorvida
   * @param {number} orgDestinoId - Organização que receberá tudo
   * @param {object} usuarioExecutor - Usuário executando (deve ser super_admin)
   */
  async absorverRecursivo(orgOrigemId, orgDestinoId, usuarioExecutor) {
    if (usuarioExecutor.role !== 'super_admin') {
      throw new Error('Apenas super_admin pode executar absorção recursiva');
    }

    if (orgOrigemId === orgDestinoId) {
      throw new Error('Origem e destino não podem ser iguais');
    }

    const orgOrigem = await prisma.organizacao.findUnique({
      where: { id: orgOrigemId }
    });

    const orgDestino = await prisma.organizacao.findUnique({
      where: { id: orgDestinoId }
    });

    if (!orgOrigem) throw new Error('Organização origem não encontrada');
    if (!orgDestino) throw new Error('Organização destino não encontrada');

    // Verificar se destino não é filho da origem (evitar ciclo)
    const destinoEhFilho = await this.verificarSeEhFilho(orgOrigemId, orgDestinoId);
    if (destinoEhFilho) {
      throw new Error('O destino não pode ser um sub-tenant da origem');
    }

    console.log(`[Organização] Iniciando absorção recursiva: ${orgOrigem.nome} → ${orgDestino.nome}`);

    // Buscar TODA a hierarquia (origem + todos os filhos/netos/etc)
    const todosFilhos = await this.buscarTodosFilhosRecursivo(orgOrigemId);
    const todasOrgs = [{ id: orgOrigemId, nome: orgOrigem.nome }, ...todosFilhos];

    console.log(`[Organização] Total de organizações a absorver: ${todasOrgs.length}`);

    // Contadores totais
    let totalVeiculos = 0;
    let totalDispositivos = 0;
    let totalMotoristas = 0;
    let totalCercas = 0;
    let totalUsuarios = 0;
    const orgsAbsorvidas = [];

    // Processar de baixo para cima (filhos mais profundos primeiro)
    // Ordenar por nível decrescente para processar folhas primeiro
    const orgsOrdenadas = [...todasOrgs].sort((a, b) => (b.nivel || 0) - (a.nivel || 0));

    for (const org of orgsOrdenadas) {
      console.log(`[Organização] Absorvendo: ${org.nome || org.id}`);

      // Transferir veículos
      const veiculos = await prisma.veiculo.updateMany({
        where: { organizacao_id: org.id },
        data: { organizacao_id: orgDestinoId }
      });
      totalVeiculos += veiculos.count;

      // Transferir dispositivos
      const dispositivos = await prisma.dispositivo.updateMany({
        where: { organizacao_id: org.id },
        data: { organizacao_id: orgDestinoId }
      });
      totalDispositivos += dispositivos.count;

      // Transferir motoristas
      const motoristas = await prisma.motorista.updateMany({
        where: { organizacao_id: org.id },
        data: { organizacao_id: orgDestinoId }
      });
      totalMotoristas += motoristas.count;

      // Transferir geofences
      const cercas = await prisma.geofence.updateMany({
        where: { organizacao_id: org.id },
        data: { organizacao_id: orgDestinoId }
      });
      totalCercas += cercas.count;

      // Transferir usuários
      const usuarios = await prisma.usuarioOrganizacao.findMany({
        where: { organizacao_id: org.id }
      });

      for (const uo of usuarios) {
        const existeVinculo = await prisma.usuarioOrganizacao.findUnique({
          where: {
            usuario_id_organizacao_id: {
              usuario_id: uo.usuario_id,
              organizacao_id: orgDestinoId
            }
          }
        });

        if (!existeVinculo) {
          await prisma.usuarioOrganizacao.create({
            data: {
              usuario_id: uo.usuario_id,
              organizacao_id: orgDestinoId,
              role: uo.role
            }
          });
          totalUsuarios++;
        }
      }

      // Remover vínculos da org
      await prisma.usuarioOrganizacao.deleteMany({
        where: { organizacao_id: org.id }
      });

      orgsAbsorvidas.push(org.nome || `ID:${org.id}`);
    }

    // Deletar todas as organizações (folhas primeiro, raiz por último)
    for (const org of orgsOrdenadas) {
      await prisma.organizacao.delete({
        where: { id: org.id }
      });
      console.log(`[Organização] Deletada: ${org.nome || org.id}`);
    }

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: usuarioExecutor.id,
      organizacaoId: orgDestinoId,
      acao: 'ABSORVER_RECURSIVO',
      recurso: 'organizacao',
      recursoId: orgOrigemId,
      detalhes: `Absorção recursiva: ${todasOrgs.length} organizações absorvidas por "${orgDestino.nome}". Transferidos: ${totalVeiculos} veículos, ${totalDispositivos} dispositivos, ${totalMotoristas} motoristas, ${totalCercas} cercas, ${totalUsuarios} usuários.`
    });

    console.log(`[Organização] Absorção recursiva concluída: ${todasOrgs.length} orgs → ${orgDestino.nome}`);

    return {
      destino: orgDestino.nome,
      organizacoes_absorvidas: orgsAbsorvidas,
      total_organizacoes: todasOrgs.length,
      transferidos: {
        veiculos: totalVeiculos,
        dispositivos: totalDispositivos,
        motoristas: totalMotoristas,
        cercas: totalCercas,
        usuarios: totalUsuarios
      }
    };
  }
}

module.exports = new OrganizacaoService();
