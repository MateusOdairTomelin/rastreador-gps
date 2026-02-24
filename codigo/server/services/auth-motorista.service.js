/**
 * Serviço de Autenticação para Motoristas (App Mobile)
 *
 * Login via CPF (motorista já cadastrado pelo admin)
 * Sem senha - CPF único como identificador
 * JWT com tipo 'motorista' no payload
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const prisma = require('../db/prisma');
const cryptoService = require('./crypto.service');
const lgpdService = require('./lgpd.service');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ERRO FATAL: JWT_SECRET não está configurado!');
  process.exit(1);
}

const JWT_EXPIRES_IN = process.env.JWT_MOTORISTA_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_MOTORISTA_REFRESH_EXPIRES_IN || '30d';

class AuthMotoristaService {
  /**
   * Gerar token JWT para motorista
   */
  generateAccessToken(motorista) {
    const payload = {
      tipo: 'motorista',
      motoristaId: motorista.id,
      organizacaoId: motorista.organizacao_id,
      nome: motorista.nome
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Verificar token JWT
   */
  verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.tipo !== 'motorista') {
        return null;
      }
      return decoded;
    } catch (error) {
      return null;
    }
  }

  /**
   * Gerar refresh token
   */
  generateRefreshToken() {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Limpar CPF (remover formatação)
   */
  cleanCPF(cpf) {
    return cpf.replace(/\D/g, '');
  }

  /**
   * Login por CPF
   * @param {string} cpf - CPF do motorista (com ou sem formatação)
   * @param {string} ip - IP do dispositivo
   * @param {string} userAgent - User-Agent do dispositivo
   * @param {string} deviceInfo - Informações do dispositivo (modelo, SO, etc)
   */
  async loginPorCpf(cpf, ip = null, userAgent = null, deviceInfo = null) {
    const cpfLimpo = this.cleanCPF(cpf);

    if (cpfLimpo.length !== 11) {
      throw new Error('CPF inválido');
    }

    // Buscar todos os motoristas ativos
    const motoristas = await prisma.motorista.findMany({
      where: {
        ativo: true
      },
      include: {
        organizacao: {
          select: {
            id: true,
            nome: true,
            slug: true,
            status: true
          }
        },
        dispositivos: {
          select: {
            id: true,
            imei: true,
            placa: true,
            veiculo: true
          }
        }
      }
    });

    // Procurar motorista com CPF correspondente (suporta criptografado e texto plano)
    let motoristaEncontrado = null;
    for (const m of motoristas) {
      if (!m.cpf) continue;

      let cpfMotoristLimpo;

      // Tentar descriptografar - se falhar, assumir que está em texto plano
      try {
        const cpfDescriptografado = cryptoService.decrypt(m.cpf);
        cpfMotoristLimpo = this.cleanCPF(cpfDescriptografado || '');
      } catch (e) {
        // CPF não está criptografado - usar texto plano
        cpfMotoristLimpo = this.cleanCPF(m.cpf);
      }

      if (cpfMotoristLimpo === cpfLimpo) {
        motoristaEncontrado = m;
        break;
      }
    }

    if (!motoristaEncontrado) {
      throw new Error('CPF não cadastrado. Entre em contato com o administrador.');
    }

    // Verificar se organização está ativa
    if (motoristaEncontrado.organizacao?.status !== 'ativo') {
      throw new Error('Organização suspensa. Entre em contato com o suporte.');
    }

    // Gerar tokens
    const accessToken = this.generateAccessToken(motoristaEncontrado);
    const refreshToken = this.generateRefreshToken();

    // Calcular expiração do refresh token
    const refreshExpiresAt = new Date();
    const refreshDays = parseInt(JWT_REFRESH_EXPIRES_IN) || 30;
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshDays);

    // Salvar refresh token
    await prisma.refreshTokenMotorista.create({
      data: {
        motorista_id: motoristaEncontrado.id,
        token: refreshToken,
        expires_at: refreshExpiresAt,
        ip,
        user_agent: userAgent,
        device_info: deviceInfo
      }
    });

    console.log(`[AuthMotorista] Login: motorista ${motoristaEncontrado.id} - ${motoristaEncontrado.nome}`);

    // Verificar consentimentos pendentes
    const consentimentosPendentes = await lgpdService.verificarConsentimentosPendentesMotorista(
      motoristaEncontrado.id
    );

    return {
      accessToken,
      refreshToken,
      motorista: {
        id: motoristaEncontrado.id,
        nome: motoristaEncontrado.nome,
        foto_url: motoristaEncontrado.foto_url,
        cnh_validade: motoristaEncontrado.cnh_validade,
        cnh_categoria: motoristaEncontrado.cnh_categoria
      },
      organizacao: {
        id: motoristaEncontrado.organizacao.id,
        nome: motoristaEncontrado.organizacao.nome,
        slug: motoristaEncontrado.organizacao.slug
      },
      veiculo_vinculado: motoristaEncontrado.dispositivos[0] || null,
      consentimentos_pendentes: consentimentosPendentes.length > 0,
      tipos_pendentes: consentimentosPendentes
    };
  }

  /**
   * Refresh do access token
   */
  async refreshAccessToken(refreshToken, ip = null, userAgent = null) {
    const tokenData = await prisma.refreshTokenMotorista.findUnique({
      where: { token: refreshToken },
      include: {
        motorista: {
          include: {
            organizacao: true,
            dispositivos: {
              select: {
                id: true,
                imei: true,
                placa: true,
                veiculo: true
              }
            }
          }
        }
      }
    });

    if (!tokenData) {
      throw new Error('Refresh token inválido');
    }

    if (tokenData.revogado) {
      // Possível ataque - revogar todos os tokens do motorista
      await prisma.refreshTokenMotorista.updateMany({
        where: { motorista_id: tokenData.motorista_id },
        data: { revogado: true }
      });
      throw new Error('Token já utilizado. Faça login novamente.');
    }

    if (tokenData.expires_at < new Date()) {
      throw new Error('Refresh token expirado');
    }

    if (!tokenData.motorista.ativo) {
      throw new Error('Conta desativada');
    }

    if (tokenData.motorista.organizacao?.status !== 'ativo') {
      throw new Error('Organização suspensa');
    }

    // Revogar token antigo (rotation)
    await prisma.refreshTokenMotorista.update({
      where: { id: tokenData.id },
      data: { revogado: true }
    });

    // Gerar novos tokens
    const newAccessToken = this.generateAccessToken(tokenData.motorista);
    const newRefreshToken = this.generateRefreshToken();

    const refreshExpiresAt = new Date();
    const refreshDays = parseInt(JWT_REFRESH_EXPIRES_IN) || 30;
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshDays);

    await prisma.refreshTokenMotorista.create({
      data: {
        motorista_id: tokenData.motorista_id,
        token: newRefreshToken,
        expires_at: refreshExpiresAt,
        ip,
        user_agent: userAgent
      }
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  }

  /**
   * Logout - revogar refresh token
   */
  async logout(refreshToken) {
    const tokenData = await prisma.refreshTokenMotorista.findUnique({
      where: { token: refreshToken }
    });

    if (tokenData) {
      await prisma.refreshTokenMotorista.update({
        where: { id: tokenData.id },
        data: { revogado: true }
      });
      console.log(`[AuthMotorista] Logout: motorista ${tokenData.motorista_id}`);
    }

    return { success: true };
  }

  /**
   * Obter dados do motorista logado
   */
  async getDadosMotorista(motoristaId) {
    const motorista = await prisma.motorista.findUnique({
      where: { id: motoristaId },
      include: {
        organizacao: {
          select: {
            id: true,
            nome: true,
            slug: true,
            logo_url: true,
            cor_primaria: true
          }
        },
        dispositivos: {
          select: {
            id: true,
            imei: true,
            placa: true,
            veiculo: true,
            status: true,
            estado_ignicao: true
          }
        },
        consentimentos_motorista: {
          where: {
            aceito: true,
            data_revogacao: null
          },
          select: {
            tipo: true,
            versao_documento: true,
            data_aceite: true
          }
        }
      }
    });

    if (!motorista) {
      throw new Error('Motorista não encontrado');
    }

    // Descriptografar campos sensíveis para exibição segura
    const cpfMascarado = cryptoService.maskCPF(motorista.cpf);
    const telefoneMascarado = cryptoService.maskPhone(motorista.telefone);

    // Verificar status da CNH
    let cnhStatus = 'valida';
    if (motorista.cnh_validade) {
      const hoje = new Date();
      const validade = new Date(motorista.cnh_validade);
      const diasRestantes = Math.ceil((validade - hoje) / (1000 * 60 * 60 * 24));

      if (diasRestantes < 0) {
        cnhStatus = 'vencida';
      } else if (diasRestantes <= 30) {
        cnhStatus = 'vence_em_breve';
      }
    } else {
      cnhStatus = 'nao_informada';
    }

    // Verificar consentimentos pendentes
    const consentimentosPendentes = await lgpdService.verificarConsentimentosPendentesMotorista(motoristaId);

    return {
      id: motorista.id,
      nome: motorista.nome,
      cpf_mascarado: cpfMascarado,
      telefone_mascarado: telefoneMascarado,
      email: motorista.email,
      foto_url: motorista.foto_url,
      cnh_categoria: motorista.cnh_categoria,
      cnh_validade: motorista.cnh_validade,
      cnh_status: cnhStatus,
      ativo: motorista.ativo,
      organizacao: motorista.organizacao,
      veiculo_vinculado: motorista.dispositivos[0] || null,
      consentimentos: motorista.consentimentos_motorista,
      consentimentos_pendentes: consentimentosPendentes.length > 0,
      tipos_pendentes: consentimentosPendentes
    };
  }

  /**
   * Vincular motorista a veículo via IMEI (QR Code)
   */
  async vincularPorImei(motoristaId, imei, organizacaoId) {
    // Validar IMEI
    const imeiLimpo = imei.replace(/\D/g, '');
    if (imeiLimpo.length !== 15) {
      throw new Error('IMEI inválido. Deve conter 15 dígitos.');
    }

    // Buscar dispositivo pelo IMEI
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei: imeiLimpo },
      include: {
        motorista: {
          select: { id: true, nome: true }
        }
      }
    });

    if (!dispositivo) {
      throw new Error('Veículo não encontrado. Verifique o QR Code.');
    }

    // Verificar se pertence à mesma organização
    if (dispositivo.organizacao_id !== organizacaoId) {
      throw new Error('Veículo não pertence à sua organização.');
    }

    // Verificar se já está vinculado a outro motorista
    if (dispositivo.motorista_id && dispositivo.motorista_id !== motoristaId) {
      throw new Error(`Veículo já vinculado a: ${dispositivo.motorista.nome}`);
    }

    // Verificar se motorista já está vinculado a outro veículo
    const motoristaAtual = await prisma.motorista.findUnique({
      where: { id: motoristaId },
      include: {
        dispositivos: {
          select: { id: true, placa: true }
        }
      }
    });

    if (motoristaAtual.dispositivos.length > 0) {
      const outroVeiculo = motoristaAtual.dispositivos[0];
      if (outroVeiculo.id !== dispositivo.id) {
        throw new Error(`Você já está vinculado ao veículo: ${outroVeiculo.placa}`);
      }
    }

    // Fechar vinculação anterior do veículo (se houver)
    if (dispositivo.motorista_id) {
      await prisma.historicoMotorista.updateMany({
        where: {
          dispositivo_id: dispositivo.id,
          fim: null
        },
        data: { fim: new Date() }
      });
    }

    // Vincular motorista ao veículo
    await prisma.dispositivo.update({
      where: { id: dispositivo.id },
      data: { motorista_id: motoristaId }
    });

    // Criar registro de histórico
    await prisma.historicoMotorista.create({
      data: {
        dispositivo_id: dispositivo.id,
        motorista_id: motoristaId
      }
    });

    console.log(`[AuthMotorista] Vinculação: motorista ${motoristaId} -> veículo ${dispositivo.placa} (IMEI: ${imeiLimpo})`);

    return {
      sucesso: true,
      mensagem: 'Veículo vinculado com sucesso!',
      veiculo: {
        id: dispositivo.id,
        imei: dispositivo.imei,
        placa: dispositivo.placa,
        veiculo: dispositivo.veiculo
      }
    };
  }

  /**
   * Desvincular motorista do veículo atual
   */
  async desvincular(motoristaId, organizacaoId) {
    // Buscar veículo vinculado ao motorista
    const dispositivo = await prisma.dispositivo.findFirst({
      where: {
        motorista_id: motoristaId,
        organizacao_id: organizacaoId
      }
    });

    if (!dispositivo) {
      throw new Error('Você não está vinculado a nenhum veículo.');
    }

    // Fechar histórico
    await prisma.historicoMotorista.updateMany({
      where: {
        dispositivo_id: dispositivo.id,
        motorista_id: motoristaId,
        fim: null
      },
      data: { fim: new Date() }
    });

    // Desvincular
    await prisma.dispositivo.update({
      where: { id: dispositivo.id },
      data: { motorista_id: null }
    });

    console.log(`[AuthMotorista] Desvinculação: motorista ${motoristaId} <- veículo ${dispositivo.placa}`);

    return {
      sucesso: true,
      mensagem: 'Desvinculado do veículo com sucesso.',
      veiculo_desvinculado: {
        id: dispositivo.id,
        placa: dispositivo.placa,
        veiculo: dispositivo.veiculo
      }
    };
  }

  /**
   * Limpar tokens expirados (job de manutenção)
   */
  async limparTokensExpirados() {
    const result = await prisma.refreshTokenMotorista.deleteMany({
      where: {
        OR: [
          { expires_at: { lt: new Date() } },
          { revogado: true }
        ]
      }
    });

    console.log(`[AuthMotorista] Tokens limpos: ${result.count}`);
    return result.count;
  }

  /**
   * Buscar notificações do motorista
   * Retorna apenas notificações criadas APÓS a vinculação do motorista ao veículo
   *
   * @param {number} motoristaId - ID do motorista
   * @param {number} organizacaoId - ID da organização
   * @param {number} limit - Limite de notificações
   * @param {boolean} apenasNaoLidas - Filtrar apenas não lidas
   */
  async getNotificacoes(motoristaId, organizacaoId, limit = 20, apenasNaoLidas = false) {
    // Buscar histórico de vinculações do motorista (com data de início e fim)
    const historico = await prisma.historicoMotorista.findMany({
      where: {
        motorista_id: motoristaId
      },
      select: {
        dispositivo_id: true,
        inicio: true,
        fim: true
      },
      orderBy: { inicio: 'desc' }
    });

    if (historico.length === 0) {
      return [];
    }

    // Construir filtros por dispositivo com período de vinculação
    // Para cada vinculação, buscar notificações entre inicio e fim (ou agora se ainda vinculado)
    const filtrosDispositivos = historico.map(h => {
      // Usa objeto único com gte e lte combinados
      const createdAtFilter = { gte: h.inicio };
      if (h.fim) {
        createdAtFilter.lte = h.fim;
      }
      return {
        dispositivo_id: h.dispositivo_id,
        created_at: createdAtFilter
      };
    });

    // Log para debug
    console.log('[AuthMotorista] Filtros notificações:', JSON.stringify(filtrosDispositivos, null, 2));

    // Buscar notificações com os filtros de período
    const baseWhere = {
      organizacao_id: organizacaoId,
      tipo: { in: ['excesso_velocidade', 'geofence_entrada', 'geofence_saida'] },
      ...(apenasNaoLidas ? { lida: false } : {})
    };

    // Usar OR para combinar os filtros de cada dispositivo/período
    const notificacoes = await prisma.notificacao.findMany({
      where: {
        ...baseWhere,
        OR: filtrosDispositivos
      },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: {
        dispositivo: {
          select: {
            id: true,
            placa: true,
            veiculo: true
          }
        }
      }
    });

    // Formatar notificações para o app
    return notificacoes.map(n => ({
      id: n.id,
      tipo: n.tipo,
      titulo: n.titulo,
      mensagem: n.mensagem,
      severidade: n.severidade,
      lida: n.lida,
      lida_em: n.lida_em,
      created_at: n.created_at,
      veiculo: n.dispositivo ? {
        placa: n.dispositivo.placa,
        veiculo: n.dispositivo.veiculo
      } : null,
      dados_extras: n.dados_extras ? JSON.parse(n.dados_extras) : null
    }));
  }

  /**
   * Marcar notificação como lida
   *
   * @param {number} notificacaoId - ID da notificação
   * @param {number} motoristaId - ID do motorista (para validação)
   */
  async marcarNotificacaoLida(notificacaoId, motoristaId) {
    // Verificar se a notificação pertence a um dispositivo do motorista
    const notificacao = await prisma.notificacao.findUnique({
      where: { id: notificacaoId },
      include: {
        dispositivo: {
          select: { motorista_id: true }
        }
      }
    });

    if (!notificacao) {
      throw new Error('Notificação não encontrada');
    }

    // Verificar se motorista está ou esteve vinculado ao dispositivo
    const historicoVinculo = await prisma.historicoMotorista.findFirst({
      where: {
        dispositivo_id: notificacao.dispositivo_id,
        motorista_id: motoristaId
      }
    });

    const vinculoAtual = notificacao.dispositivo?.motorista_id === motoristaId;

    if (!vinculoAtual && !historicoVinculo) {
      throw new Error('Você não tem permissão para acessar esta notificação');
    }

    // Marcar como lida
    await prisma.notificacao.update({
      where: { id: notificacaoId },
      data: {
        lida: true,
        lida_em: new Date()
      }
    });

    return { sucesso: true };
  }

  /**
   * Contar notificações não lidas do motorista
   * Conta apenas notificações criadas APÓS a vinculação
   *
   * @param {number} motoristaId - ID do motorista
   * @param {number} organizacaoId - ID da organização
   */
  async getContagemNotificacoesNaoLidas(motoristaId, organizacaoId) {
    // Buscar histórico de vinculações do motorista
    const historico = await prisma.historicoMotorista.findMany({
      where: {
        motorista_id: motoristaId
      },
      select: {
        dispositivo_id: true,
        inicio: true,
        fim: true
      }
    });

    if (historico.length === 0) {
      return 0;
    }

    // Construir filtros por dispositivo com período de vinculação
    const filtrosDispositivos = historico.map(h => {
      const createdAtFilter = { gte: h.inicio };
      if (h.fim) {
        createdAtFilter.lte = h.fim;
      }
      return {
        dispositivo_id: h.dispositivo_id,
        created_at: createdAtFilter
      };
    });

    const contagem = await prisma.notificacao.count({
      where: {
        organizacao_id: organizacaoId,
        tipo: { in: ['excesso_velocidade', 'geofence_entrada', 'geofence_saida'] },
        lida: false,
        OR: filtrosDispositivos
      }
    });

    return contagem;
  }

  /**
   * Atualizar push token do motorista
   * Chamado pelo app mobile após obter o Expo Push Token
   *
   * @param {number} motoristaId - ID do motorista
   * @param {string} pushToken - Expo Push Token (ExponentPushToken[xxx])
   */
  async atualizarPushToken(motoristaId, pushToken) {
    // Validar formato do token Expo
    if (pushToken && !pushToken.startsWith('ExponentPushToken[')) {
      throw new Error('Push token inválido. Formato esperado: ExponentPushToken[xxx]');
    }

    await prisma.motorista.update({
      where: { id: motoristaId },
      data: { push_token: pushToken }
    });

    console.log(`[AuthMotorista] Push token atualizado para motorista ${motoristaId}`);
    return { sucesso: true };
  }

  /**
   * Obter push token do motorista
   *
   * @param {number} motoristaId - ID do motorista
   */
  async getPushToken(motoristaId) {
    const motorista = await prisma.motorista.findUnique({
      where: { id: motoristaId },
      select: { push_token: true }
    });

    return motorista?.push_token || null;
  }

  /**
   * Buscar motoristas vinculados a um dispositivo
   * (para enviar push quando houver alerta)
   *
   * @param {number} dispositivoId - ID do dispositivo
   */
  async getMotoristasPorDispositivo(dispositivoId) {
    // Buscar motorista atualmente vinculado
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { id: dispositivoId },
      select: {
        motorista: {
          select: {
            id: true,
            nome: true,
            push_token: true
          }
        }
      }
    });

    if (dispositivo?.motorista?.push_token) {
      return [dispositivo.motorista];
    }

    return [];
  }
}

module.exports = new AuthMotoristaService();
