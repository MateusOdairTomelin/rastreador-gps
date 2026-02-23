/**
 * Serviço LGPD - Gestão de Consentimentos e Exclusão de Dados
 *
 * Funcionalidades:
 * - Registrar/revogar consentimentos
 * - Verificar consentimentos pendentes
 * - Solicitar exclusão de dados
 * - Exportar dados do usuário (portabilidade)
 * - Exclusão completa com cascata
 */

const prisma = require('../db/prisma');

// Versões atuais dos documentos
const VERSAO_POLITICA_PRIVACIDADE = '1.0';
const VERSAO_TERMOS_USO = '1.0';

class LGPDService {

  /**
   * Registrar aceite de consentimento
   */
  async registrarConsentimento(usuarioId, tipo, versaoDocumento, ip, userAgent) {
    // Verificar se já existe consentimento ativo para este tipo
    const existente = await prisma.consentimento.findFirst({
      where: {
        usuario_id: usuarioId,
        tipo: tipo,
        aceito: true,
        data_revogacao: null
      }
    });

    if (existente) {
      // Se a versão é diferente, registrar novo consentimento
      if (existente.versao_documento !== versaoDocumento) {
        return await prisma.consentimento.create({
          data: {
            usuario_id: usuarioId,
            tipo,
            aceito: true,
            versao_documento: versaoDocumento,
            ip,
            user_agent: userAgent
          }
        });
      }
      return existente;
    }

    return await prisma.consentimento.create({
      data: {
        usuario_id: usuarioId,
        tipo,
        aceito: true,
        versao_documento: versaoDocumento,
        ip,
        user_agent: userAgent
      }
    });
  }

  /**
   * Registrar múltiplos consentimentos de uma vez
   */
  async registrarConsentimentosIniciais(usuarioId, ip, userAgent) {
    const consentimentos = [
      { tipo: 'privacidade', versao: VERSAO_POLITICA_PRIVACIDADE },
      { tipo: 'termos_uso', versao: VERSAO_TERMOS_USO }
    ];

    const resultados = [];
    for (const c of consentimentos) {
      const resultado = await this.registrarConsentimento(
        usuarioId, c.tipo, c.versao, ip, userAgent
      );
      resultados.push(resultado);
    }

    return resultados;
  }

  /**
   * Revogar consentimento
   */
  async revogarConsentimento(usuarioId, tipo) {
    const consentimento = await prisma.consentimento.findFirst({
      where: {
        usuario_id: usuarioId,
        tipo: tipo,
        aceito: true,
        data_revogacao: null
      }
    });

    if (!consentimento) {
      throw new Error('Consentimento não encontrado ou já revogado');
    }

    return await prisma.consentimento.update({
      where: { id: consentimento.id },
      data: {
        aceito: false,
        data_revogacao: new Date()
      }
    });
  }

  /**
   * Verificar se usuário tem consentimentos pendentes
   */
  async verificarConsentimentosPendentes(usuarioId) {
    const consentimentosNecessarios = [
      { tipo: 'privacidade', versao: VERSAO_POLITICA_PRIVACIDADE },
      { tipo: 'termos_uso', versao: VERSAO_TERMOS_USO }
    ];

    const pendentes = [];

    for (const c of consentimentosNecessarios) {
      const existe = await prisma.consentimento.findFirst({
        where: {
          usuario_id: usuarioId,
          tipo: c.tipo,
          versao_documento: c.versao,
          aceito: true,
          data_revogacao: null
        }
      });

      if (!existe) {
        pendentes.push(c);
      }
    }

    return pendentes;
  }

  /**
   * Listar consentimentos do usuário
   */
  async listarConsentimentos(usuarioId) {
    return await prisma.consentimento.findMany({
      where: { usuario_id: usuarioId },
      orderBy: { data_aceite: 'desc' }
    });
  }

  /**
   * Verificar se tem consentimento válido (para middleware)
   */
  async temConsentimentoValido(usuarioId) {
    const pendentes = await this.verificarConsentimentosPendentes(usuarioId);
    return pendentes.length === 0;
  }

  /**
   * Solicitar exclusão de dados
   */
  async solicitarExclusao(usuarioId, organizacaoId, tipo, recursoId, motivo) {
    return await prisma.solicitacaoExclusao.create({
      data: {
        usuario_id: usuarioId,
        organizacao_id: organizacaoId,
        tipo,
        recurso_id: recursoId,
        motivo,
        status: 'pendente'
      }
    });
  }

  /**
   * Listar solicitações de exclusão
   */
  async listarSolicitacoesExclusao(filtros = {}) {
    const where = {};
    if (filtros.usuario_id) where.usuario_id = filtros.usuario_id;
    if (filtros.organizacao_id) where.organizacao_id = filtros.organizacao_id;
    if (filtros.status) where.status = filtros.status;

    return await prisma.solicitacaoExclusao.findMany({
      where,
      orderBy: { created_at: 'desc' }
    });
  }

  /**
   * Processar solicitação de exclusão
   */
  async processarExclusao(solicitacaoId, processadoPorId, aprovar, motivoRecusa = null) {
    const solicitacao = await prisma.solicitacaoExclusao.findUnique({
      where: { id: solicitacaoId }
    });

    if (!solicitacao) {
      throw new Error('Solicitação não encontrada');
    }

    if (solicitacao.status !== 'pendente') {
      throw new Error('Solicitação já foi processada');
    }

    if (!aprovar) {
      return await prisma.solicitacaoExclusao.update({
        where: { id: solicitacaoId },
        data: {
          status: 'recusado',
          motivo_recusa: motivoRecusa,
          processado_por: processadoPorId,
          processado_em: new Date()
        }
      });
    }

    // Aprovar e executar exclusão
    await prisma.solicitacaoExclusao.update({
      where: { id: solicitacaoId },
      data: { status: 'processando' }
    });

    try {
      let dadosExcluidos = {};

      if (solicitacao.tipo === 'dispositivo' && solicitacao.recurso_id) {
        dadosExcluidos = await this.excluirDadosDispositivo(parseInt(solicitacao.recurso_id));
      } else if (solicitacao.tipo === 'motorista' && solicitacao.recurso_id) {
        dadosExcluidos = await this.excluirDadosMotorista(parseInt(solicitacao.recurso_id));
      } else if (solicitacao.tipo === 'meus_dados' && solicitacao.usuario_id) {
        dadosExcluidos = await this.excluirDadosUsuario(solicitacao.usuario_id);
      }

      return await prisma.solicitacaoExclusao.update({
        where: { id: solicitacaoId },
        data: {
          status: 'concluido',
          processado_por: processadoPorId,
          processado_em: new Date(),
          dados_excluidos: JSON.stringify(dadosExcluidos)
        }
      });

    } catch (error) {
      await prisma.solicitacaoExclusao.update({
        where: { id: solicitacaoId },
        data: {
          status: 'pendente',
          motivo_recusa: `Erro ao processar: ${error.message}`
        }
      });
      throw error;
    }
  }

  /**
   * Excluir dados de um dispositivo com cascata completa
   */
  async excluirDadosDispositivo(dispositivoId) {
    const resumo = {
      dispositivo_id: dispositivoId,
      localizacoes: 0,
      dados_obd2: 0,
      alarmes: 0,
      viagens: 0,
      geofence_eventos: 0,
      notificacoes: 0
    };

    // Excluir localizações
    const localizacoes = await prisma.localizacao.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.localizacoes = localizacoes.count;

    // Excluir dados OBD2
    const obd2 = await prisma.dadosOBD2.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.dados_obd2 = obd2.count;

    // Excluir alarmes
    const alarmes = await prisma.alarme.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.alarmes = alarmes.count;

    // Excluir viagens
    const viagens = await prisma.viagem.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.viagens = viagens.count;

    // Excluir eventos de geofence
    const geofenceEventos = await prisma.geofenceEvento.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.geofence_eventos = geofenceEventos.count;

    // Excluir notificações
    const notificacoes = await prisma.notificacao.deleteMany({
      where: { dispositivo_id: dispositivoId }
    });
    resumo.notificacoes = notificacoes.count;

    // Excluir o dispositivo
    await prisma.dispositivo.delete({
      where: { id: dispositivoId }
    });

    console.log(`[LGPD] Dispositivo ${dispositivoId} excluído com todos os dados:`, resumo);
    return resumo;
  }

  /**
   * Excluir/anonimizar dados de motorista
   */
  async excluirDadosMotorista(motoristaId) {
    // Anonimizar em vez de excluir (manter histórico de viagens)
    const motorista = await prisma.motorista.update({
      where: { id: motoristaId },
      data: {
        nome: 'DADOS REMOVIDOS',
        cpf: null,
        telefone: null,
        email: null,
        foto_url: null,
        cnh_numero: null,
        cnh_categoria: null,
        cnh_validade: null,
        ativo: false
      }
    });

    console.log(`[LGPD] Motorista ${motoristaId} anonimizado`);
    return { motorista_id: motoristaId, anonimizado: true };
  }

  /**
   * Excluir todos os dados de um usuário
   */
  async excluirDadosUsuario(usuarioId) {
    const resumo = {
      usuario_id: usuarioId,
      consentimentos: 0,
      refresh_tokens: 0,
      audit_logs: 0
    };

    // Excluir consentimentos
    const consentimentos = await prisma.consentimento.deleteMany({
      where: { usuario_id: usuarioId }
    });
    resumo.consentimentos = consentimentos.count;

    // Excluir refresh tokens
    const tokens = await prisma.refreshToken.deleteMany({
      where: { usuario_id: usuarioId }
    });
    resumo.refresh_tokens = tokens.count;

    // Anonimizar audit logs (manter para compliance)
    const logs = await prisma.auditLog.updateMany({
      where: { usuario_id: usuarioId },
      data: { usuario_id: null }
    });
    resumo.audit_logs = logs.count;

    // Excluir o usuário
    await prisma.usuario.delete({
      where: { id: usuarioId }
    });

    console.log(`[LGPD] Usuário ${usuarioId} excluído:`, resumo);
    return resumo;
  }

  /**
   * Exportar todos os dados de um usuário (portabilidade)
   */
  async exportarDadosUsuario(usuarioId) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      include: {
        organizacoes: {
          include: {
            organizacao: true
          }
        }
      }
    });

    if (!usuario) {
      throw new Error('Usuário não encontrado');
    }

    const consentimentos = await prisma.consentimento.findMany({
      where: { usuario_id: usuarioId }
    });

    const auditLogs = await prisma.auditLog.findMany({
      where: { usuario_id: usuarioId },
      orderBy: { created_at: 'desc' },
      take: 1000
    });

    return {
      exportado_em: new Date().toISOString(),
      usuario: {
        id: usuario.id,
        email: usuario.email,
        nome: usuario.nome,
        created_at: usuario.created_at
      },
      organizacoes: usuario.organizacoes.map(uo => ({
        nome: uo.organizacao.nome,
        role: uo.role,
        desde: uo.created_at
      })),
      consentimentos: consentimentos.map(c => ({
        tipo: c.tipo,
        versao: c.versao_documento,
        aceito: c.aceito,
        data_aceite: c.data_aceite,
        data_revogacao: c.data_revogacao
      })),
      acessos: auditLogs.map(log => ({
        acao: log.acao,
        recurso: log.recurso,
        data: log.created_at,
        ip: log.ip
      }))
    };
  }

  /**
   * Obter versões atuais dos documentos
   */
  getVersoesDocumentos() {
    return {
      privacidade: VERSAO_POLITICA_PRIVACIDADE,
      termos_uso: VERSAO_TERMOS_USO
    };
  }

  // ============ MÉTODOS ADMINISTRATIVOS ============

  /**
   * Listar todos os usuários com status de consentimento (super_admin)
   */
  async listarUsuariosComConsentimentos(filtros = {}) {
    const where = {};
    if (filtros.organizacao_id) {
      where.organizacoes = {
        some: { organizacao_id: filtros.organizacao_id }
      };
    }

    const usuarios = await prisma.usuario.findMany({
      where,
      include: {
        consentimentos: {
          where: {
            aceito: true,
            data_revogacao: null
          },
          orderBy: { data_aceite: 'desc' }
        },
        organizacoes: {
          include: {
            organizacao: {
              select: { id: true, nome: true }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    // Processar para adicionar status de consentimento
    return usuarios.map(u => {
      const temPrivacidade = u.consentimentos.some(c =>
        c.tipo === 'privacidade' && c.versao_documento === VERSAO_POLITICA_PRIVACIDADE
      );
      const temTermos = u.consentimentos.some(c =>
        c.tipo === 'termos_uso' && c.versao_documento === VERSAO_TERMOS_USO
      );

      return {
        id: u.id,
        email: u.email,
        nome: u.nome,
        role: u.role,
        ativo: u.ativo,
        created_at: u.created_at,
        organizacoes: u.organizacoes.map(uo => ({
          id: uo.organizacao.id,
          nome: uo.organizacao.nome,
          role: uo.role
        })),
        consentimentos: {
          privacidade: temPrivacidade,
          termos_uso: temTermos,
          completo: temPrivacidade && temTermos
        },
        ultimo_aceite: u.consentimentos[0]?.data_aceite || null
      };
    });
  }

  /**
   * Listar motoristas com status de consentimento
   */
  async listarMotoristasComConsentimentos(organizacaoId) {
    const motoristas = await prisma.motorista.findMany({
      where: {
        organizacao_id: organizacaoId,
        ativo: true
      },
      include: {
        consentimentos_motorista: {
          where: {
            aceito: true,
            data_revogacao: null
          },
          orderBy: { data_aceite: 'desc' }
        }
      },
      orderBy: { nome: 'asc' }
    });

    return motoristas.map(m => {
      const temPrivacidade = m.consentimentos_motorista?.some(c =>
        c.tipo === 'privacidade' && c.versao_documento === VERSAO_POLITICA_PRIVACIDADE
      ) || false;
      const temTermos = m.consentimentos_motorista?.some(c =>
        c.tipo === 'termos_uso' && c.versao_documento === VERSAO_TERMOS_USO
      ) || false;

      return {
        id: m.id,
        nome: m.nome,
        cpf: m.cpf ? '***' + m.cpf.slice(-4) : null, // Mascarar CPF
        telefone: m.telefone ? '***' + m.telefone.slice(-4) : null, // Mascarar telefone
        email: m.email,
        cnh_validade: m.cnh_validade,
        ativo: m.ativo,
        created_at: m.created_at,
        consentimentos: {
          privacidade: temPrivacidade,
          termos_uso: temTermos,
          completo: temPrivacidade && temTermos
        },
        ultimo_aceite: m.consentimentos_motorista?.[0]?.data_aceite || null
      };
    });
  }

  /**
   * Registrar consentimento de motorista (para o APP)
   */
  async registrarConsentimentoMotorista(motoristaId, tipo, versaoDocumento, ip, userAgent) {
    // Verificar se já existe consentimento ativo para este tipo
    const existente = await prisma.consentimentoMotorista.findFirst({
      where: {
        motorista_id: motoristaId,
        tipo: tipo,
        aceito: true,
        data_revogacao: null
      }
    });

    if (existente) {
      if (existente.versao_documento !== versaoDocumento) {
        return await prisma.consentimentoMotorista.create({
          data: {
            motorista_id: motoristaId,
            tipo,
            aceito: true,
            versao_documento: versaoDocumento,
            ip,
            user_agent: userAgent
          }
        });
      }
      return existente;
    }

    return await prisma.consentimentoMotorista.create({
      data: {
        motorista_id: motoristaId,
        tipo,
        aceito: true,
        versao_documento: versaoDocumento,
        ip,
        user_agent: userAgent
      }
    });
  }

  /**
   * Registrar consentimentos iniciais de motorista
   */
  async registrarConsentimentosIniciaisMotorista(motoristaId, ip, userAgent) {
    const consentimentos = [
      { tipo: 'privacidade', versao: VERSAO_POLITICA_PRIVACIDADE },
      { tipo: 'termos_uso', versao: VERSAO_TERMOS_USO }
    ];

    const resultados = [];
    for (const c of consentimentos) {
      const resultado = await this.registrarConsentimentoMotorista(
        motoristaId, c.tipo, c.versao, ip, userAgent
      );
      resultados.push(resultado);
    }

    return resultados;
  }

  /**
   * Verificar consentimentos pendentes de motorista
   */
  async verificarConsentimentosPendentesMotorista(motoristaId) {
    const consentimentosNecessarios = [
      { tipo: 'privacidade', versao: VERSAO_POLITICA_PRIVACIDADE },
      { tipo: 'termos_uso', versao: VERSAO_TERMOS_USO }
    ];

    const pendentes = [];

    for (const c of consentimentosNecessarios) {
      const existe = await prisma.consentimentoMotorista.findFirst({
        where: {
          motorista_id: motoristaId,
          tipo: c.tipo,
          versao_documento: c.versao,
          aceito: true,
          data_revogacao: null
        }
      });

      if (!existe) {
        pendentes.push(c);
      }
    }

    return pendentes;
  }

  /**
   * Exportar dados de motorista (portabilidade)
   */
  async exportarDadosMotorista(motoristaId) {
    const motorista = await prisma.motorista.findUnique({
      where: { id: motoristaId },
      include: {
        organizacao: {
          select: { nome: true }
        },
        viagens: {
          take: 100,
          orderBy: { inicio: 'desc' },
          select: {
            id: true,
            inicio: true,
            fim: true,
            distancia_km: true,
            dispositivo: {
              select: { imei: true, placa: true }
            }
          }
        },
        consentimentos_motorista: true
      }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    return {
      exportado_em: new Date().toISOString(),
      motorista: {
        id: motorista.id,
        nome: motorista.nome,
        email: motorista.email,
        telefone: motorista.telefone,
        cpf: motorista.cpf,
        cnh_numero: motorista.cnh_numero,
        cnh_categoria: motorista.cnh_categoria,
        cnh_validade: motorista.cnh_validade,
        created_at: motorista.created_at
      },
      organizacao: motorista.organizacao?.nome,
      viagens: motorista.viagens.map(v => ({
        id: v.id,
        inicio: v.inicio,
        fim: v.fim,
        km: v.distancia_km,
        veiculo: v.dispositivo?.placa || v.dispositivo?.imei
      })),
      consentimentos: motorista.consentimentos_motorista?.map(c => ({
        tipo: c.tipo,
        versao: c.versao_documento,
        aceito: c.aceito,
        data_aceite: c.data_aceite,
        data_revogacao: c.data_revogacao
      })) || []
    };
  }

  /**
   * Obter estatísticas LGPD (super_admin)
   */
  async obterEstatisticasLGPD() {
    const [
      totalUsuarios,
      usuariosComConsentimento,
      totalMotoristas,
      motoristasComConsentimento,
      solicitacoesPendentes,
      solicitacoesProcessadas
    ] = await Promise.all([
      prisma.usuario.count({ where: { ativo: true } }),
      prisma.consentimento.groupBy({
        by: ['usuario_id'],
        where: {
          aceito: true,
          data_revogacao: null
        }
      }),
      prisma.motorista.count({ where: { ativo: true } }),
      prisma.consentimentoMotorista.groupBy({
        by: ['motorista_id'],
        where: {
          aceito: true,
          data_revogacao: null
        }
      }),
      prisma.solicitacaoExclusao.count({ where: { status: 'pendente' } }),
      prisma.solicitacaoExclusao.count({ where: { status: 'concluido' } })
    ]);

    return {
      usuarios: {
        total: totalUsuarios,
        com_consentimento: usuariosComConsentimento.length,
        sem_consentimento: totalUsuarios - usuariosComConsentimento.length,
        taxa_conformidade: totalUsuarios > 0
          ? Math.round((usuariosComConsentimento.length / totalUsuarios) * 100)
          : 0
      },
      motoristas: {
        total: totalMotoristas,
        com_consentimento: motoristasComConsentimento.length,
        sem_consentimento: totalMotoristas - motoristasComConsentimento.length,
        taxa_conformidade: totalMotoristas > 0
          ? Math.round((motoristasComConsentimento.length / totalMotoristas) * 100)
          : 0
      },
      solicitacoes_exclusao: {
        pendentes: solicitacoesPendentes,
        processadas: solicitacoesProcessadas
      }
    };
  }

  /**
   * Listar usuários com consentimento pendente
   */
  async listarUsuariosPendentes(organizacaoId) {
    const where = organizacaoId ? {
      usuario_organizacoes: { some: { organizacao_id: organizacaoId } }
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
        created_at: true,
        consentimentos: {
          where: { aceito: true, data_revogacao: null },
          select: { tipo: true, data_aceite: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });
  }

  /**
   * Listar motoristas com consentimento pendente
   */
  async listarMotoristasPendentes(organizacaoId) {
    const where = organizacaoId ? { organizacao_id: organizacaoId } : {};

    return prisma.motorista.findMany({
      where: {
        ...where,
        ativo: true,
        OR: [
          { consentimentos_motorista: { none: { tipo: 'privacidade', aceito: true, data_revogacao: null } } },
          { consentimentos_motorista: { none: { tipo: 'termos_uso', aceito: true, data_revogacao: null } } }
        ]
      },
      select: {
        id: true,
        nome: true,
        email: true,
        telefone: true,
        created_at: true,
        consentimentos_motorista: {
          where: { aceito: true, data_revogacao: null },
          select: { tipo: true, data_aceite: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: 100
    });
  }

  /**
   * Obter logs de acesso a dados pessoais
   */
  async obterLogsAcesso(where = {}, limit = 100) {
    return prisma.auditLog.findMany({
      where,
      include: {
        usuario: {
          select: { id: true, nome: true, email: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: limit
    });
  }

  /**
   * Listar todas as organizações com status LGPD (super_admin)
   */
  async listarOrganizacoesComStatusLGPD() {
    const organizacoes = await prisma.organizacao.findMany({
      where: { status: 'ativo' },
      include: {
        _count: {
          select: {
            usuarios: true,
            motoristas: true,
            dispositivos: true
          }
        }
      },
      orderBy: { nome: 'asc' }
    });

    // Para cada organização, calcular conformidade
    const resultado = await Promise.all(organizacoes.map(async (org) => {
      const [usuariosConformes, motoristasConformes] = await Promise.all([
        prisma.$queryRaw`
          SELECT COUNT(DISTINCT c.usuario_id) as count
          FROM consentimentos c
          JOIN usuarios_organizacoes uo ON c.usuario_id = uo.usuario_id
          WHERE uo.organizacao_id = ${org.id}
            AND c.aceito = true
            AND c.data_revogacao IS NULL
        `,
        prisma.consentimentoMotorista.groupBy({
          by: ['motorista_id'],
          where: {
            aceito: true,
            data_revogacao: null,
            motorista: {
              organizacao_id: org.id
            }
          }
        })
      ]);

      return {
        id: org.id,
        nome: org.nome,
        usuarios: org._count.usuarios,
        motoristas: org._count.motoristas,
        dispositivos: org._count.dispositivos,
        conformidade: {
          usuarios: Number(usuariosConformes[0]?.count || 0),
          motoristas: motoristasConformes.length
        }
      };
    }));

    return resultado;
  }
}

module.exports = new LGPDService();
