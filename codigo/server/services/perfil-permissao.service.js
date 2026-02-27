/**
 * Serviço de Perfis de Permissão
 *
 * Gerencia perfis de permissão personalizados
 * Cada perfil define quais módulos e ações um usuário pode acessar
 */

const prisma = require('../db/prisma');

// Módulos disponíveis no sistema
const MODULOS = {
  dashboard: {
    nome: 'Dashboard',
    acoes: ['listar', 'editar', 'visualizar', 'exportar']
  },
  veiculos: {
    nome: 'Veículos',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'exportar', 'importar']
  },
  motoristas: {
    nome: 'Motoristas',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'exportar', 'importar']
  },
  monitoramento: {
    nome: 'Monitoramento',
    acoes: ['listar', 'visualizar', 'comandos', 'historico', 'tempo_real']
  },
  relatorios: {
    nome: 'Relatórios',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'exportar', 'agendar', 'visualizar']
  },
  geofences: {
    nome: 'Cercas Virtuais',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'alertas']
  },
  viagens: {
    nome: 'Viagens',
    acoes: ['listar', 'criar', 'editar', 'visualizar', 'exportar', 'analise']
  },
  alertas: {
    nome: 'Alertas/Notificações',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'configurar']
  },
  usuarios: {
    nome: 'Usuários',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'perfis']
  },
  organizacoes: {
    nome: 'Organizações',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'configurar', 'criar_subtenant', 'gerenciar_subtenants']
  },
  auditoria: {
    nome: 'Auditoria',
    acoes: ['listar', 'exportar', 'visualizar', 'filtrar_todas_orgs']
  },
  configuracoes: {
    nome: 'Configurações',
    acoes: ['visualizar', 'editar', 'avancadas']
  },
  dispositivos: {
    nome: 'Dispositivos/Rastreadores',
    acoes: ['listar', 'criar', 'editar', 'excluir', 'comandos', 'diagnostico']
  },
  lgpd: {
    nome: 'LGPD',
    acoes: ['listar', 'configurar', 'exportar', 'excluir', 'executar', 'visualizar']
  },
  notificacoes: {
    nome: 'Notificações',
    acoes: ['listar', 'editar', 'configurar', 'visualizar', 'telegram', 'email', 'push']
  },
  graficos: {
    nome: 'Gráficos',
    acoes: ['listar', 'visualizar', 'criar', 'exportar']
  },
  status: {
    nome: 'Status',
    acoes: ['visualizar', 'painel', 'heartbeat']
  },
  diagnostico: {
    nome: 'Diagnóstico',
    acoes: ['visualizar', 'executar', 'logs']
  },
  heartbeat: {
    nome: 'Heartbeat',
    acoes: ['visualizar', 'configurar', 'historico']
  },
  perfil: {
    nome: 'Perfil',
    acoes: ['visualizar', 'editar', 'alterar_senha']
  },
  debug: {
    nome: 'Debug',
    acoes: ['visualizar', 'logs', 'pacotes', 'avancado']
  },
  perfis: {
    nome: 'Perfis de Permissão',
    acoes: ['listar', 'criar', 'editar', 'excluir']
  },
  planos: {
    nome: 'Planos de Assinatura',
    acoes: ['listar', 'criar', 'editar', 'excluir']
  },
  sistema: {
    nome: 'Configurações do Sistema',
    acoes: ['visualizar', 'configurar', 'executar']
  }
};

class PerfilPermissaoService {
  /**
   * Obter módulos disponíveis
   */
  getModulosDisponiveis() {
    return MODULOS;
  }

  /**
   * Listar perfis de uma organização
   * Inclui perfis do sistema (globais)
   */
  async listar(organizacao_id = null) {
    const where = {
      OR: [
        { sistema: true },  // Perfis do sistema
        { organizacao_id: organizacao_id }  // Perfis da organização
      ],
      ativo: true
    };

    const perfis = await prisma.perfilPermissao.findMany({
      where,
      orderBy: [
        { sistema: 'desc' },
        { nome: 'asc' }
      ]
    });

    return perfis.map(p => ({
      ...p,
      permissoes: JSON.parse(p.permissoes)
    }));
  }

  /**
   * Buscar perfil por ID
   */
  async buscarPorId(id) {
    const perfil = await prisma.perfilPermissao.findUnique({
      where: { id }
    });

    if (!perfil) return null;

    return {
      ...perfil,
      permissoes: JSON.parse(perfil.permissoes)
    };
  }

  /**
   * Criar novo perfil
   */
  async criar(dados) {
    const { nome, descricao, organizacao_id, permissoes, criado_por } = dados;

    // Validar permissões
    this.validarPermissoes(permissoes);

    const perfil = await prisma.perfilPermissao.create({
      data: {
        nome,
        descricao,
        organizacao_id,
        permissoes: JSON.stringify(permissoes),
        criado_por,
        sistema: false
      }
    });

    console.log(`[Perfil] Criado: "${nome}" para org ${organizacao_id || 'global'}`);

    return {
      ...perfil,
      permissoes
    };
  }

  /**
   * Atualizar perfil
   */
  async atualizar(id, dados) {
    const perfil = await prisma.perfilPermissao.findUnique({
      where: { id }
    });

    if (!perfil) {
      throw new Error('Perfil não encontrado');
    }

    // Permitir edição de perfis do sistema (apenas super_admin pode acessar esta função)
    const updateData = {};
    if (dados.nome) updateData.nome = dados.nome;
    if (dados.descricao !== undefined) updateData.descricao = dados.descricao;
    if (dados.ativo !== undefined) updateData.ativo = dados.ativo;

    if (dados.permissoes) {
      this.validarPermissoes(dados.permissoes);
      updateData.permissoes = JSON.stringify(dados.permissoes);
    }

    const atualizado = await prisma.perfilPermissao.update({
      where: { id },
      data: updateData
    });

    console.log(`[Perfil] Atualizado: "${atualizado.nome}"`);

    return {
      ...atualizado,
      permissoes: JSON.parse(atualizado.permissoes)
    };
  }

  /**
   * Excluir perfil
   */
  async excluir(id) {
    const perfil = await prisma.perfilPermissao.findUnique({
      where: { id }
    });

    if (!perfil) {
      throw new Error('Perfil não encontrado');
    }

    if (perfil.sistema) {
      throw new Error('Perfis do sistema não podem ser excluídos');
    }

    // Verificar se há usuários usando este perfil
    const usuarios = await prisma.usuarioPerfilPermissao.count({
      where: { perfil_id: id }
    });

    if (usuarios > 0) {
      throw new Error(`Este perfil está sendo usado por ${usuarios} usuário(s). Remova as associações primeiro.`);
    }

    await prisma.perfilPermissao.delete({
      where: { id }
    });

    console.log(`[Perfil] Excluído: "${perfil.nome}"`);

    return { sucesso: true };
  }

  /**
   * Associar perfil a um usuário
   */
  async associarUsuario(usuario_id, perfil_id, organizacao_id = null) {
    // Verificar se perfil existe
    const perfil = await prisma.perfilPermissao.findUnique({
      where: { id: perfil_id }
    });

    if (!perfil) {
      throw new Error('Perfil não encontrado');
    }

    // Verificar se já existe associação
    const existente = await prisma.usuarioPerfilPermissao.findFirst({
      where: {
        usuario_id,
        perfil_id,
        organizacao_id
      }
    });

    if (existente) {
      return existente; // Já existe
    }

    const associacao = await prisma.usuarioPerfilPermissao.create({
      data: {
        usuario_id,
        perfil_id,
        organizacao_id
      }
    });

    console.log(`[Perfil] Usuário ${usuario_id} associado ao perfil "${perfil.nome}"`);

    return associacao;
  }

  /**
   * Remover perfil de um usuário
   */
  async removerUsuario(usuario_id, perfil_id, organizacao_id = null) {
    const where = {
      usuario_id,
      perfil_id
    };

    if (organizacao_id) {
      where.organizacao_id = organizacao_id;
    }

    const resultado = await prisma.usuarioPerfilPermissao.deleteMany({
      where
    });

    return { removidos: resultado.count };
  }

  /**
   * Remover todos os perfis de um usuário
   */
  async removerTodosPerfisUsuario(usuario_id) {
    const resultado = await prisma.usuarioPerfilPermissao.deleteMany({
      where: { usuario_id }
    });

    console.log(`[Perfil] Removidos ${resultado.count} perfis do usuário ${usuario_id}`);

    return { removidos: resultado.count };
  }

  /**
   * Listar perfis de um usuário
   */
  async listarPerfisUsuario(usuario_id, organizacao_id = null) {
    const where = { usuario_id };

    if (organizacao_id) {
      where.OR = [
        { organizacao_id },
        { organizacao_id: null }  // Perfis globais
      ];
    }

    const associacoes = await prisma.usuarioPerfilPermissao.findMany({
      where,
      include: {
        perfil: true
      }
    });

    return associacoes.map(a => ({
      ...a.perfil,
      permissoes: JSON.parse(a.perfil.permissoes),
      organizacao_aplicada: a.organizacao_id
    }));
  }

  /**
   * Verificar se usuário tem permissão
   */
  async verificarPermissao(usuario_id, modulo, acao, organizacao_id = null) {
    // Buscar usuário para verificar role global
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuario_id }
    });

    if (!usuario) return false;

    // Super admin sem perfil restritivo tem acesso total
    // (se tiver perfil, respeita o perfil)
    const perfisUsuario = await this.listarPerfisUsuario(usuario_id, organizacao_id);

    if (perfisUsuario.length === 0 && usuario.role === 'super_admin') {
      return true; // Super admin sem restrições
    }

    // Verificar se algum perfil permite a ação
    for (const perfil of perfisUsuario) {
      const permissoes = perfil.permissoes;
      if (permissoes[modulo] && permissoes[modulo].includes(acao)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Obter permissões consolidadas de um usuário
   */
  async obterPermissoesUsuario(usuario_id, organizacao_id = null) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuario_id }
    });

    if (!usuario) return {};

    const perfisUsuario = await this.listarPerfisUsuario(usuario_id, organizacao_id);

    // Super admin sem perfil tem tudo
    if (perfisUsuario.length === 0 && usuario.role === 'super_admin') {
      const todasPermissoes = {};
      for (const [modulo, config] of Object.entries(MODULOS)) {
        todasPermissoes[modulo] = [...config.acoes];
      }
      return todasPermissoes;
    }

    // Consolidar permissões de todos os perfis
    const permissoesConsolidadas = {};

    for (const perfil of perfisUsuario) {
      for (const [modulo, acoes] of Object.entries(perfil.permissoes)) {
        if (!permissoesConsolidadas[modulo]) {
          permissoesConsolidadas[modulo] = [];
        }
        for (const acao of acoes) {
          if (!permissoesConsolidadas[modulo].includes(acao)) {
            permissoesConsolidadas[modulo].push(acao);
          }
        }
      }
    }

    return permissoesConsolidadas;
  }

  /**
   * Validar estrutura de permissões
   */
  validarPermissoes(permissoes) {
    if (typeof permissoes !== 'object') {
      throw new Error('Permissões devem ser um objeto');
    }

    for (const [modulo, acoes] of Object.entries(permissoes)) {
      // Ignorar campos especiais que começam com underscore
      if (modulo.startsWith('_')) {
        continue;
      }

      if (!MODULOS[modulo]) {
        throw new Error(`Módulo inválido: ${modulo}`);
      }

      if (!Array.isArray(acoes)) {
        throw new Error(`Ações do módulo ${modulo} devem ser um array`);
      }

      for (const acao of acoes) {
        if (!MODULOS[modulo].acoes.includes(acao)) {
          throw new Error(`Ação inválida para módulo ${modulo}: ${acao}`);
        }
      }
    }
  }

  /**
   * Obter organizações permitidas para um usuário
   * Prioridade: 1) Campo do usuário, 2) Perfis de permissão
   * @returns {Array|null} - Array de IDs ou null se tem acesso total
   */
  async obterOrganizacoesPermitidas(usuario_id) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuario_id }
    });

    if (!usuario) return [];

    // 1. PRIORIDADE: Verificar campo organizacoes_permitidas do próprio usuário
    if (usuario.organizacoes_permitidas) {
      try {
        const orgsUsuario = JSON.parse(usuario.organizacoes_permitidas);
        if (Array.isArray(orgsUsuario)) {
          // Se contém 'todas', tem acesso total
          if (orgsUsuario.includes('todas')) {
            return null; // null = acesso total
          }
          // Retornar organizações específicas
          return orgsUsuario.filter(id => typeof id === 'number');
        }
      } catch (e) {
        console.error('Erro ao parsear organizacoes_permitidas do usuário:', e);
      }
    }

    // 2. FALLBACK: Verificar perfis de permissão
    const perfisUsuario = await this.listarPerfisUsuario(usuario_id, null);

    // Se não tem perfil e é super_admin, acesso total
    if (perfisUsuario.length === 0 && usuario.role === 'super_admin') {
      return null; // null = acesso total
    }

    // Se não tem perfil e não é super_admin, só a organização atual
    if (perfisUsuario.length === 0) {
      // Buscar organização padrão do usuário
      const assocDefault = await prisma.usuarioOrganizacao.findFirst({
        where: { usuario_id, is_default: true }
      });
      return assocDefault ? [assocDefault.organizacao_id] : [];
    }

    // Consolidar organizações permitidas de todos os perfis
    const organizacoesPermitidas = new Set();
    let temAcessoTotal = false;

    for (const perfil of perfisUsuario) {
      const permissoes = perfil.permissoes;

      // Verificar campo especial _organizacoes_permitidas
      if (permissoes._organizacoes_permitidas) {
        // Se contém 'todas', tem acesso total
        if (permissoes._organizacoes_permitidas.includes('todas')) {
          temAcessoTotal = true;
          break;
        }

        // Adicionar organizações específicas
        for (const orgId of permissoes._organizacoes_permitidas) {
          if (typeof orgId === 'number') {
            organizacoesPermitidas.add(orgId);
          }
        }
      }
    }

    if (temAcessoTotal) {
      return null; // null = acesso total
    }

    // Se não tem organizações definidas nos perfis, buscar organização padrão
    if (organizacoesPermitidas.size === 0) {
      const assocDefault = await prisma.usuarioOrganizacao.findFirst({
        where: { usuario_id, is_default: true }
      });
      if (assocDefault) {
        organizacoesPermitidas.add(assocDefault.organizacao_id);
      }
    }

    return Array.from(organizacoesPermitidas);
  }
}

module.exports = new PerfilPermissaoService();
module.exports.MODULOS = MODULOS;
