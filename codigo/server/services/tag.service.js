/**
 * Serviço de Tags de Veículos
 *
 * Gerencia CRUD de tags e vinculação com veículos.
 * Permite categorizar e organizar veículos por região, tipo, centro de custo, etc.
 */

const prisma = require('../db/prisma');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

class TagService {
  /**
   * Listar tags de uma organização
   */
  async listar(organizacao_id, { busca, ativo = true } = {}) {
    const where = { organizacao_id };

    if (ativo !== null && ativo !== undefined) {
      where.ativo = ativo;
    }

    if (busca) {
      where.OR = [
        { nome: { contains: busca, mode: 'insensitive' } },
        { descricao: { contains: busca, mode: 'insensitive' } }
      ];
    }

    const tags = await prisma.tag.findMany({
      where,
      include: {
        _count: {
          select: { veiculos: true }
        }
      },
      orderBy: { nome: 'asc' }
    });

    // Mapear para incluir contagem de veículos
    return tags.map(tag => ({
      ...tag,
      totalVeiculos: tag._count.veiculos,
      _count: undefined
    }));
  }

  /**
   * Buscar tag por ID
   */
  async buscarPorId(id, organizacao_id) {
    return prisma.tag.findFirst({
      where: { id, organizacao_id },
      include: {
        veiculos: {
          include: {
            veiculo: {
              select: {
                id: true,
                placa: true,
                modelo: true,
                marca: true
              }
            }
          }
        }
      }
    });
  }

  /**
   * Criar nova tag
   */
  async criar(organizacao_id, dados, usuarioId = null) {
    if (!organizacao_id) {
      throw new Error('Organização não definida');
    }

    if (!dados.nome || dados.nome.trim().length < 2) {
      throw new Error('Nome da tag é obrigatório (mínimo 2 caracteres)');
    }

    const nomeNormalizado = dados.nome.trim();

    // Verificar se já existe
    const existente = await prisma.tag.findFirst({
      where: {
        organizacao_id,
        nome: { equals: nomeNormalizado, mode: 'insensitive' }
      }
    });

    if (existente) {
      throw new Error('Já existe uma tag com este nome nesta organização');
    }

    const tag = await prisma.tag.create({
      data: {
        organizacao_id,
        nome: nomeNormalizado,
        cor: dados.cor || '#3B82F6',
        descricao: dados.descricao?.trim() || null
      }
    });

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'CRIAR_TAG',
      recurso: 'tag',
      recursoId: tag.id,
      detalhes: `Tag "${nomeNormalizado}" criada`
    });

    console.log(`[Tags] Tag ${tag.id} (${nomeNormalizado}) criada`);
    return tag;
  }

  /**
   * Atualizar tag
   */
  async atualizar(id, organizacao_id, dados, usuarioId = null) {
    const tag = await prisma.tag.findFirst({
      where: { id, organizacao_id }
    });

    if (!tag) {
      throw new Error('Tag não encontrada');
    }

    // Se mudando o nome, verificar unicidade
    if (dados.nome) {
      const nomeNormalizado = dados.nome.trim();

      if (nomeNormalizado.toLowerCase() !== tag.nome.toLowerCase()) {
        const existente = await prisma.tag.findFirst({
          where: {
            organizacao_id,
            nome: { equals: nomeNormalizado, mode: 'insensitive' },
            NOT: { id }
          }
        });

        if (existente) {
          throw new Error('Já existe uma tag com este nome nesta organização');
        }

        dados.nome = nomeNormalizado;
      }
    }

    const atualizada = await prisma.tag.update({
      where: { id },
      data: {
        nome: dados.nome,
        cor: dados.cor,
        descricao: dados.descricao?.trim(),
        ativo: dados.ativo
      }
    });

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'EDITAR_TAG',
      recurso: 'tag',
      recursoId: id,
      detalhes: `Tag "${atualizada.nome}" atualizada`
    });

    return atualizada;
  }

  /**
   * Excluir tag
   */
  async excluir(id, organizacao_id, usuarioId = null) {
    const tag = await prisma.tag.findFirst({
      where: { id, organizacao_id }
    });

    if (!tag) {
      throw new Error('Tag não encontrada');
    }

    // Excluir vínculos com veículos (cascade fará isso, mas vamos ser explícitos)
    await prisma.veiculoTag.deleteMany({
      where: { tag_id: id }
    });

    await prisma.tag.delete({
      where: { id }
    });

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'DELETAR_TAG',
      recurso: 'tag',
      recursoId: id,
      detalhes: `Tag "${tag.nome}" excluída`
    });

    return { sucesso: true };
  }

  /**
   * Vincular tag a um veículo
   */
  async vincularVeiculo(tag_id, veiculo_id, organizacao_id, usuarioId = null) {
    // Verificar se tag pertence à organização
    const tag = await prisma.tag.findFirst({
      where: { id: tag_id, organizacao_id }
    });

    if (!tag) {
      throw new Error('Tag não encontrada');
    }

    // Verificar se veículo pertence à organização
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Verificar se já está vinculado
    const existente = await prisma.veiculoTag.findFirst({
      where: { tag_id, veiculo_id }
    });

    if (existente) {
      return { sucesso: true, mensagem: 'Tag já vinculada ao veículo' };
    }

    await prisma.veiculoTag.create({
      data: { tag_id, veiculo_id }
    });

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'VINCULAR_TAG',
      recurso: 'veiculo',
      recursoId: veiculo_id,
      detalhes: `Tag "${tag.nome}" vinculada ao veículo ${veiculo.placa}`
    });

    return {
      sucesso: true,
      mensagem: `Tag "${tag.nome}" vinculada ao veículo ${veiculo.placa}`
    };
  }

  /**
   * Desvincular tag de um veículo
   */
  async desvincularVeiculo(tag_id, veiculo_id, organizacao_id, usuarioId = null) {
    const tag = await prisma.tag.findFirst({
      where: { id: tag_id, organizacao_id }
    });

    if (!tag) {
      throw new Error('Tag não encontrada');
    }

    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    await prisma.veiculoTag.deleteMany({
      where: { tag_id, veiculo_id }
    });

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'DESVINCULAR_TAG',
      recurso: 'veiculo',
      recursoId: veiculo_id,
      detalhes: `Tag "${tag.nome}" desvinculada do veículo ${veiculo.placa}`
    });

    return {
      sucesso: true,
      mensagem: `Tag "${tag.nome}" desvinculada do veículo ${veiculo.placa}`
    };
  }

  /**
   * Definir tags de um veículo (substitui todas as tags existentes)
   */
  async definirTagsVeiculo(veiculo_id, tag_ids, organizacao_id, usuarioId = null) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    // Verificar se todas as tags pertencem à organização
    if (tag_ids && tag_ids.length > 0) {
      const tagsValidas = await prisma.tag.count({
        where: {
          id: { in: tag_ids },
          organizacao_id
        }
      });

      if (tagsValidas !== tag_ids.length) {
        throw new Error('Uma ou mais tags não pertencem a esta organização');
      }
    }

    // Remover todas as tags atuais
    await prisma.veiculoTag.deleteMany({
      where: { veiculo_id }
    });

    // Adicionar novas tags
    if (tag_ids && tag_ids.length > 0) {
      await prisma.veiculoTag.createMany({
        data: tag_ids.map(tag_id => ({
          veiculo_id,
          tag_id
        }))
      });
    }

    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: 'DEFINIR_TAGS_VEICULO',
      recurso: 'veiculo',
      recursoId: veiculo_id,
      detalhes: `Tags do veículo ${veiculo.placa} atualizadas: ${tag_ids?.length || 0} tags`
    });

    return {
      sucesso: true,
      mensagem: `Tags do veículo ${veiculo.placa} atualizadas`
    };
  }

  /**
   * Buscar veículos por tag
   */
  async buscarVeiculosPorTag(tag_id, organizacao_id) {
    const tag = await prisma.tag.findFirst({
      where: { id: tag_id, organizacao_id }
    });

    if (!tag) {
      throw new Error('Tag não encontrada');
    }

    const vinculos = await prisma.veiculoTag.findMany({
      where: { tag_id },
      include: {
        veiculo: {
          include: {
            dispositivos: {
              select: {
                id: true,
                imei: true,
                status: true,
                estado_ignicao: true,
                ultima_conexao: true
              }
            }
          }
        }
      }
    });

    return vinculos.map(v => v.veiculo);
  }

  /**
   * Buscar tags de um veículo
   */
  async buscarTagsVeiculo(veiculo_id, organizacao_id) {
    const veiculo = await prisma.veiculo.findFirst({
      where: { id: veiculo_id, organizacao_id }
    });

    if (!veiculo) {
      throw new Error('Veículo não encontrado');
    }

    const vinculos = await prisma.veiculoTag.findMany({
      where: { veiculo_id },
      include: {
        tag: true
      }
    });

    return vinculos.map(v => v.tag);
  }

  /**
   * Estatísticas das tags
   */
  async getEstatisticas(organizacao_id) {
    const tags = await prisma.tag.findMany({
      where: { organizacao_id, ativo: true },
      include: {
        _count: {
          select: { veiculos: true }
        }
      }
    });

    const totalVeiculos = await prisma.veiculo.count({
      where: { organizacao_id }
    });

    const veiculosSemTag = await prisma.veiculo.count({
      where: {
        organizacao_id,
        tags: { none: {} }
      }
    });

    return {
      totalTags: tags.length,
      totalVeiculos,
      veiculosSemTag,
      veiculosComTag: totalVeiculos - veiculosSemTag,
      tags: tags.map(tag => ({
        id: tag.id,
        nome: tag.nome,
        cor: tag.cor,
        totalVeiculos: tag._count.veiculos
      }))
    };
  }
}

module.exports = new TagService();
