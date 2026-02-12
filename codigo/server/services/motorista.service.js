/**
 * Serviço de Motoristas
 *
 * Gerencia CRUD de motoristas e vinculação com veículos
 * Com criptografia LGPD para dados sensíveis (CPF, CNH, telefone)
 */

const prisma = require('../db/prisma');
const cryptoService = require('./crypto.service');
const auditoriaService = require('./auditoria.service');
const { ACOES } = require('./auditoria.service');

class MotoristaService {
  /**
   * Descriptografar campos sensíveis de um motorista
   */
  _decryptMotorista(motorista) {
    if (!motorista) return motorista;
    return cryptoService.decryptMotoristaFields(motorista);
  }

  /**
   * Descriptografar lista de motoristas
   */
  _decryptMotoristas(motoristas) {
    return motoristas.map(m => this._decryptMotorista(m));
  }

  /**
   * Criptografar campos sensíveis antes de salvar
   */
  _encryptFields(dados) {
    const encrypted = { ...dados };
    if (encrypted.cpf) {
      encrypted.cpf = cryptoService.encrypt(encrypted.cpf);
    }
    if (encrypted.cnh_numero) {
      encrypted.cnh_numero = cryptoService.encrypt(encrypted.cnh_numero);
    }
    if (encrypted.telefone) {
      encrypted.telefone = cryptoService.encrypt(encrypted.telefone);
    }
    return encrypted;
  }
  /**
   * Listar motoristas de uma organização
   */
  async listar(organizacao_id, { ativo, busca, page = 1, limit = 50 } = {}) {
    const where = { organizacao_id };

    if (ativo !== undefined) {
      where.ativo = ativo === 'true' || ativo === true;
    }

    if (busca) {
      where.OR = [
        { nome: { contains: busca, mode: 'insensitive' } },
        { cpf: { contains: busca } },
        { telefone: { contains: busca } },
        { email: { contains: busca, mode: 'insensitive' } }
      ];
    }

    const [motoristas, total] = await Promise.all([
      prisma.motorista.findMany({
        where,
        include: {
          dispositivos: {
            select: {
              id: true,
              imei: true,
              placa: true,
              veiculo: true
            }
          }
        },
        orderBy: { nome: 'asc' },
        skip: (page - 1) * limit,
        take: limit
      }),
      prisma.motorista.count({ where })
    ]);

    return {
      motoristas: this._decryptMotoristas(motoristas),
      total,
      page,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Buscar motorista por ID
   */
  async buscarPorId(id, organizacao_id) {
    const motorista = await prisma.motorista.findFirst({
      where: { id, organizacao_id },
      include: {
        dispositivos: {
          select: {
            id: true,
            imei: true,
            placa: true,
            veiculo: true
          }
        },
        historico: {
          include: {
            dispositivo: {
              select: {
                id: true,
                imei: true,
                placa: true,
                veiculo: true
              }
            }
          },
          orderBy: { inicio: 'desc' },
          take: 20
        }
      }
    });
    return this._decryptMotorista(motorista);
  }

  /**
   * Criar novo motorista
   * CPF, CNH e telefone são criptografados antes de salvar
   */
  async criar(organizacao_id, dados) {
    console.log(`[Motoristas] Criando motorista - organizacao_id: ${organizacao_id}, dados:`, JSON.stringify(dados, null, 2));

    // Validar organizacao_id
    if (!organizacao_id) {
      throw new Error('Organização não definida. Faça logout e login novamente.');
    }

    // Validar CPF único na organização (comparando criptografado)
    if (dados.cpf) {
      const cpfEncrypted = cryptoService.encrypt(dados.cpf);
      const existente = await prisma.motorista.findFirst({
        where: { organizacao_id, cpf: cpfEncrypted }
      });

      if (existente) {
        throw new Error('Já existe um motorista com este CPF nesta organização');
      }
    }

    // Criptografar campos sensíveis
    const encrypted = this._encryptFields(dados);

    const motorista = await prisma.motorista.create({
      data: {
        organizacao_id,
        nome: encrypted.nome,
        cpf: encrypted.cpf || null,
        telefone: encrypted.telefone || null,
        email: dados.email || null,
        foto_url: dados.foto_url || null,
        cnh_numero: encrypted.cnh_numero || null,
        cnh_categoria: dados.cnh_categoria || null,
        cnh_validade: dados.cnh_validade ? new Date(dados.cnh_validade) : null,
        ativo: dados.ativo !== false
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: dados.usuarioId || null,
      organizacaoId: organizacao_id,
      acao: ACOES.CRIAR_MOTORISTA,
      recurso: 'motorista',
      recursoId: motorista.id,
      detalhes: `Motorista "${dados.nome}" criado`,
      dadosNovos: { nome: dados.nome, email: dados.email, cnh_categoria: dados.cnh_categoria }
    });

    console.log(`[LGPD] Motorista ${motorista.id} criado com dados sensíveis criptografados`);
    return this._decryptMotorista(motorista);
  }

  /**
   * Atualizar motorista
   * CPF, CNH e telefone são criptografados antes de salvar
   */
  async atualizar(id, organizacao_id, dados) {
    // Verificar se motorista existe
    const motorista = await prisma.motorista.findFirst({
      where: { id, organizacao_id }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    // Validar CPF único (comparando criptografado)
    if (dados.cpf) {
      const cpfEncrypted = cryptoService.encrypt(dados.cpf);
      // Descriptografar CPF atual para comparar
      const cpfAtual = cryptoService.decrypt(motorista.cpf);

      if (dados.cpf !== cpfAtual) {
        const existente = await prisma.motorista.findFirst({
          where: { organizacao_id, cpf: cpfEncrypted, NOT: { id } }
        });

        if (existente) {
          throw new Error('Já existe um motorista com este CPF nesta organização');
        }
      }
    }

    // Criptografar campos sensíveis
    const encrypted = this._encryptFields(dados);

    // Guardar nome anterior para auditoria
    const nomeAnterior = cryptoService.decrypt(motorista.nome) || motorista.nome;

    const atualizado = await prisma.motorista.update({
      where: { id },
      data: {
        nome: encrypted.nome,
        cpf: encrypted.cpf || null,
        telefone: encrypted.telefone || null,
        email: dados.email || null,
        foto_url: dados.foto_url || null,
        cnh_numero: encrypted.cnh_numero || null,
        cnh_categoria: dados.cnh_categoria || null,
        cnh_validade: dados.cnh_validade ? new Date(dados.cnh_validade) : null,
        ativo: dados.ativo
      }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId: dados.usuarioId || null,
      organizacaoId: organizacao_id,
      acao: ACOES.EDITAR_MOTORISTA,
      recurso: 'motorista',
      recursoId: id,
      detalhes: `Motorista "${nomeAnterior}" atualizado`,
      dadosAnteriores: { nome: nomeAnterior, email: motorista.email, ativo: motorista.ativo },
      dadosNovos: { nome: dados.nome, email: dados.email, ativo: dados.ativo }
    });

    console.log(`[LGPD] Motorista ${id} atualizado com dados sensíveis criptografados`);
    return this._decryptMotorista(atualizado);
  }

  /**
   * Excluir motorista
   */
  async excluir(id, organizacao_id, usuarioId = null) {
    const motorista = await prisma.motorista.findFirst({
      where: { id, organizacao_id }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    // Descriptografar nome para auditoria
    const nomeMotorista = this._decryptMotorista(motorista)?.nome || motorista.nome;

    // Desvincular de todos os veículos primeiro
    await prisma.dispositivo.updateMany({
      where: { motorista_id: id },
      data: { motorista_id: null }
    });

    const resultado = await prisma.motorista.delete({
      where: { id }
    });

    // Registrar auditoria
    await auditoriaService.registrar({
      usuarioId,
      organizacaoId: organizacao_id,
      acao: ACOES.DELETAR_MOTORISTA,
      recurso: 'motorista',
      recursoId: id,
      detalhes: `Motorista "${nomeMotorista}" excluído`
    });

    return resultado;
  }

  /**
   * Vincular motorista a um veículo
   */
  async vincularVeiculo(motorista_id, dispositivo_id, organizacao_id, usuario_id = null) {
    // Verificar se motorista pertence à organização
    const motorista = await prisma.motorista.findFirst({
      where: { id: motorista_id, organizacao_id }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    // Verificar se dispositivo pertence à organização
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { id: dispositivo_id, organizacao_id }
    });

    if (!dispositivo) {
      throw new Error('Veículo não encontrado');
    }

    // Fechar vinculação anterior do veículo (se houver)
    if (dispositivo.motorista_id && dispositivo.motorista_id !== motorista_id) {
      await prisma.historicoMotorista.updateMany({
        where: {
          dispositivo_id,
          motorista_id: dispositivo.motorista_id,
          fim: null
        },
        data: { fim: new Date() }
      });
    }

    // Atualizar dispositivo com novo motorista
    await prisma.dispositivo.update({
      where: { id: dispositivo_id },
      data: { motorista_id }
    });

    // Criar registro de histórico
    await prisma.historicoMotorista.create({
      data: {
        dispositivo_id,
        motorista_id,
        vinculado_por: usuario_id
      }
    });

    return { sucesso: true, mensagem: 'Motorista vinculado com sucesso' };
  }

  /**
   * Desvincular motorista de um veículo
   */
  async desvincularVeiculo(dispositivo_id, organizacao_id) {
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { id: dispositivo_id, organizacao_id }
    });

    if (!dispositivo) {
      throw new Error('Veículo não encontrado');
    }

    if (!dispositivo.motorista_id) {
      throw new Error('Veículo não possui motorista vinculado');
    }

    // Fechar histórico
    await prisma.historicoMotorista.updateMany({
      where: {
        dispositivo_id,
        motorista_id: dispositivo.motorista_id,
        fim: null
      },
      data: { fim: new Date() }
    });

    // Remover vinculação
    await prisma.dispositivo.update({
      where: { id: dispositivo_id },
      data: { motorista_id: null }
    });

    return { sucesso: true, mensagem: 'Motorista desvinculado com sucesso' };
  }

  /**
   * Buscar histórico de motoristas de um veículo
   */
  async historicoVeiculo(dispositivo_id, organizacao_id) {
    const dispositivo = await prisma.dispositivo.findFirst({
      where: { id: dispositivo_id, organizacao_id }
    });

    if (!dispositivo) {
      throw new Error('Veículo não encontrado');
    }

    const historico = await prisma.historicoMotorista.findMany({
      where: { dispositivo_id },
      include: {
        motorista: {
          select: {
            id: true,
            nome: true,
            cpf: true,
            telefone: true,
            foto_url: true
          }
        }
      },
      orderBy: { inicio: 'desc' }
    });

    // Descriptografar dados dos motoristas no histórico
    return historico.map(h => ({
      ...h,
      motorista: h.motorista ? this._decryptMotorista(h.motorista) : null
    }));
  }

  /**
   * Buscar histórico de veículos de um motorista
   */
  async historicoMotorista(motorista_id, organizacao_id) {
    const motorista = await prisma.motorista.findFirst({
      where: { id: motorista_id, organizacao_id }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    return prisma.historicoMotorista.findMany({
      where: { motorista_id },
      include: {
        dispositivo: {
          select: {
            id: true,
            imei: true,
            placa: true,
            veiculo: true
          }
        }
      },
      orderBy: { inicio: 'desc' }
    });
  }

  /**
   * Verificar CNH vencida
   */
  async verificarCnhVencida(organizacao_id) {
    const hoje = new Date();

    const motoristas = await prisma.motorista.findMany({
      where: {
        organizacao_id,
        ativo: true,
        cnh_validade: { lt: hoje }
      },
      orderBy: { cnh_validade: 'asc' }
    });

    return this._decryptMotoristas(motoristas);
  }

  /**
   * Verificar CNH próxima do vencimento (30 dias)
   */
  async verificarCnhProximaVencer(organizacao_id, dias = 30) {
    const hoje = new Date();
    const limite = new Date();
    limite.setDate(limite.getDate() + dias);

    const motoristas = await prisma.motorista.findMany({
      where: {
        organizacao_id,
        ativo: true,
        cnh_validade: {
          gte: hoje,
          lte: limite
        }
      },
      orderBy: { cnh_validade: 'asc' }
    });

    return this._decryptMotoristas(motoristas);
  }
}

module.exports = new MotoristaService();
