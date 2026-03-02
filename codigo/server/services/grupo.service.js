/**
 * Serviço de Grupos
 * Gerencia grupos de tags para controle de acesso hierárquico
 */

const prisma = require('../db/prisma');

class GrupoService {
  /**
   * Listar todos os grupos de uma organização
   */
  async listar(organizacaoId) {
    const grupos = await prisma.grupo.findMany({
      where: { organizacao_id: organizacaoId },
      include: {
        tags: {
          select: {
            id: true,
            nome: true,
            cor: true
          }
        },
        _count: {
          select: {
            tags: true,
            usuarios_grupos: true
          }
        }
      },
      orderBy: { nome: 'asc' }
    });

    return grupos.map(g => ({
      ...g,
      totalTags: g._count.tags,
      totalUsuarios: g._count.usuarios_grupos
    }));
  }

  /**
   * Buscar grupo por ID
   */
  async buscarPorId(id, organizacaoId) {
    const grupo = await prisma.grupo.findFirst({
      where: {
        id: parseInt(id),
        organizacao_id: organizacaoId
      },
      include: {
        tags: {
          select: {
            id: true,
            nome: true,
            cor: true
          }
        }
      }
    });

    if (!grupo) {
      throw new Error('Grupo não encontrado');
    }

    return grupo;
  }

  /**
   * Criar novo grupo
   */
  async criar(dados, organizacaoId) {
    const { nome, descricao, cor } = dados;

    if (!nome || nome.trim().length < 2) {
      throw new Error('Nome do grupo deve ter pelo menos 2 caracteres');
    }

    // Verificar se já existe grupo com mesmo nome na organização
    const existente = await prisma.grupo.findFirst({
      where: {
        nome: nome.trim(),
        organizacao_id: organizacaoId
      }
    });

    if (existente) {
      throw new Error('Já existe um grupo com este nome');
    }

    const grupo = await prisma.grupo.create({
      data: {
        nome: nome.trim(),
        descricao: descricao?.trim() || null,
        cor: cor || '#6b7280',
        organizacao_id: organizacaoId
      }
    });

    console.log(`[Grupos] Grupo criado: ${grupo.nome} (org: ${organizacaoId})`);
    return grupo;
  }

  /**
   * Atualizar grupo
   */
  async atualizar(id, dados, organizacaoId) {
    const grupo = await this.buscarPorId(id, organizacaoId);

    const { nome, descricao, cor, ativo } = dados;

    // Verificar duplicidade de nome
    if (nome && nome.trim() !== grupo.nome) {
      const existente = await prisma.grupo.findFirst({
        where: {
          nome: nome.trim(),
          organizacao_id: organizacaoId,
          id: { not: parseInt(id) }
        }
      });

      if (existente) {
        throw new Error('Já existe um grupo com este nome');
      }
    }

    const atualizado = await prisma.grupo.update({
      where: { id: parseInt(id) },
      data: {
        nome: nome?.trim() || grupo.nome,
        descricao: descricao !== undefined ? descricao?.trim() || null : grupo.descricao,
        cor: cor || grupo.cor,
        ativo: ativo !== undefined ? ativo : grupo.ativo,
        updated_at: new Date()
      }
    });

    console.log(`[Grupos] Grupo atualizado: ${atualizado.nome}`);
    return atualizado;
  }

  /**
   * Excluir grupo
   */
  async excluir(id, organizacaoId) {
    const grupo = await this.buscarPorId(id, organizacaoId);

    // Desvincular tags do grupo antes de excluir
    await prisma.tag.updateMany({
      where: { grupo_id: parseInt(id) },
      data: { grupo_id: null }
    });

    await prisma.grupo.delete({
      where: { id: parseInt(id) }
    });

    console.log(`[Grupos] Grupo excluído: ${grupo.nome}`);
    return { sucesso: true, mensagem: 'Grupo excluído com sucesso' };
  }

  /**
   * Vincular tags a um grupo
   */
  async vincularTags(grupoId, tagIds, organizacaoId) {
    await this.buscarPorId(grupoId, organizacaoId);

    // Atualizar grupo_id das tags selecionadas
    await prisma.tag.updateMany({
      where: {
        id: { in: tagIds.map(id => parseInt(id)) },
        organizacao_id: organizacaoId
      },
      data: { grupo_id: parseInt(grupoId) }
    });

    console.log(`[Grupos] ${tagIds.length} tags vinculadas ao grupo ${grupoId}`);
    return { sucesso: true, mensagem: `${tagIds.length} tags vinculadas` };
  }

  /**
   * Desvincular tag de grupo
   */
  async desvincularTag(tagId, organizacaoId) {
    await prisma.tag.updateMany({
      where: {
        id: parseInt(tagId),
        organizacao_id: organizacaoId
      },
      data: { grupo_id: null }
    });

    return { sucesso: true };
  }

  // ==================== PERMISSÕES DE USUÁRIO ====================

  /**
   * Obter permissões de grupos/tags de um usuário
   */
  async obterPermissoesUsuario(usuarioId, organizacaoId) {
    // Buscar grupos do usuário
    const gruposUsuario = await prisma.usuariosGrupos.findMany({
      where: { usuario_id: parseInt(usuarioId) },
      include: {
        grupo: {
          include: {
            tags: {
              select: { id: true, nome: true, cor: true }
            }
          }
        }
      }
    });

    // Buscar tags específicas do usuário
    const tagsUsuario = await prisma.usuariosTags.findMany({
      where: { usuario_id: parseInt(usuarioId) },
      include: {
        tag: {
          select: { id: true, nome: true, cor: true, grupo_id: true }
        }
      }
    });

    return {
      grupos: gruposUsuario.map(ug => ({
        id: ug.grupo.id,
        nome: ug.grupo.nome,
        cor: ug.grupo.cor,
        tags: ug.grupo.tags
      })),
      tagsEspecificas: tagsUsuario.map(ut => ut.tag)
    };
  }

  /**
   * Definir permissões de grupos/tags para um usuário
   * @param {number} usuarioId
   * @param {Array} grupos - Array de { grupoId, tagIds: [] }
   * @param {number} organizacaoId
   */
  async definirPermissoesUsuario(usuarioId, grupos, organizacaoId) {
    // Remover permissões anteriores
    await prisma.usuariosGrupos.deleteMany({
      where: { usuario_id: parseInt(usuarioId) }
    });
    await prisma.usuariosTags.deleteMany({
      where: { usuario_id: parseInt(usuarioId) }
    });

    // Se não há grupos, usuário tem acesso total
    if (!grupos || grupos.length === 0) {
      console.log(`[Grupos] Usuário ${usuarioId}: acesso total (sem restrições)`);
      return { sucesso: true, acessoTotal: true };
    }

    // Adicionar novos grupos
    for (const g of grupos) {
      // Vincular usuário ao grupo
      await prisma.usuariosGrupos.create({
        data: {
          usuario_id: parseInt(usuarioId),
          grupo_id: parseInt(g.grupoId)
        }
      });

      // Se há tags específicas, vincular
      if (g.tagIds && g.tagIds.length > 0) {
        for (const tagId of g.tagIds) {
          await prisma.usuariosTags.create({
            data: {
              usuario_id: parseInt(usuarioId),
              tag_id: parseInt(tagId)
            }
          });
        }
      }
    }

    console.log(`[Grupos] Usuário ${usuarioId}: ${grupos.length} grupos atribuídos`);
    return { sucesso: true, grupos: grupos.length };
  }

  /**
   * Obter IDs de tags que o usuário pode ver
   * Retorna null se usuário tem acesso total
   */
  async obterTagsPermitidas(usuarioId) {
    // Buscar grupos do usuário
    const gruposUsuario = await prisma.usuariosGrupos.findMany({
      where: { usuario_id: parseInt(usuarioId) },
      select: { grupo_id: true }
    });

    // Se não tem grupos, acesso total
    if (gruposUsuario.length === 0) {
      return null; // null = acesso total
    }

    const grupoIds = gruposUsuario.map(g => g.grupo_id);

    // Buscar tags específicas do usuário
    const tagsEspecificas = await prisma.usuariosTags.findMany({
      where: { usuario_id: parseInt(usuarioId) },
      select: { tag_id: true }
    });

    // Se tem tags específicas, usar apenas essas
    if (tagsEspecificas.length > 0) {
      return tagsEspecificas.map(t => t.tag_id);
    }

    // Senão, usar todas as tags dos grupos
    const tagsGrupos = await prisma.tag.findMany({
      where: { grupo_id: { in: grupoIds } },
      select: { id: true }
    });

    return tagsGrupos.map(t => t.id);
  }
}

module.exports = new GrupoService();
