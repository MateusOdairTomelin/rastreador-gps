const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../db/prisma');
const redisService = require('./redis.service');
const emailService = require('./email.service');

// ✅ SEGURANÇA: JWT_SECRET obrigatório - não permitir fallback inseguro
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ ERRO FATAL: JWT_SECRET não está configurado no ambiente!');
  console.error('   Configure a variável de ambiente JWT_SECRET antes de iniciar o servidor.');
  process.exit(1);
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '15m';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const SALT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

class AuthService {

  /**
   * Gerar hash de senha
   */
  async hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Verificar senha
   */
  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
  }

  /**
   * Gerar token JWT
   * @param {Object} user - Usuário
   * @param {Object} organizacao - Organização selecionada (opcional)
   * @param {string} roleNaOrg - Papel do usuário na organização
   */
  generateAccessToken(user, organizacao = null, roleNaOrg = null) {
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,  // Role global (super_admin, usuario)
      nome: user.nome
    };

    // Se há organização selecionada, incluir no token
    if (organizacao) {
      payload.organizacao_id = organizacao.id;
      payload.organizacao_slug = organizacao.slug;
      payload.organizacao_nome = organizacao.nome;
      payload.role_org = roleNaOrg || 'operador';  // Role na organização
    }

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Buscar organizações do usuário
   * Para super_admin, retorna TODAS as organizações
   */
  async buscarOrganizacoesDoUsuario(usuarioId) {
    // Verificar se é super_admin
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: { role: true }
    });

    // Se for super_admin, listar TODAS as organizações
    if (usuario?.role === 'super_admin') {
      // Buscar qual é a organização padrão do usuário
      const assocDefault = await prisma.usuarioOrganizacao.findMany({
        where: { usuario_id: usuarioId },
        select: { organizacao_id: true, is_default: true }
      });
      const defaultOrgId = assocDefault.find(a => a.is_default)?.organizacao_id;

      const todasOrgs = await prisma.organizacao.findMany({
        where: { status: 'ativo' },
        include: { plano: true },
        orderBy: { nome: 'asc' }
      });

      return todasOrgs.map(org => ({
        id: org.id,
        nome: org.nome,
        slug: org.slug,
        logo_url: org.logo_url,
        cor_primaria: org.cor_primaria,
        cor_secundaria: org.cor_secundaria,
        config_tema: org.config_tema,
        role: 'super_admin',
        is_default: org.id === defaultOrgId,
        plano: org.plano?.nome || 'basico',
        status: org.status
      }));
    }

    // Para usuários normais, buscar apenas associações
    const associacoes = await prisma.usuarioOrganizacao.findMany({
      where: { usuario_id: usuarioId },
      include: {
        organizacao: {
          include: {
            plano: true
          }
        }
      },
      orderBy: { is_default: 'desc' }
    });

    return associacoes.map(a => ({
      id: a.organizacao.id,
      nome: a.organizacao.nome,
      slug: a.organizacao.slug,
      logo_url: a.organizacao.logo_url,
      cor_primaria: a.organizacao.cor_primaria,
      cor_secundaria: a.organizacao.cor_secundaria,
      config_tema: a.organizacao.config_tema,
      role: a.role,
      is_default: a.is_default,
      plano: a.organizacao.plano?.nome || 'basico',
      status: a.organizacao.status
    }));
  }

  /**
   * Selecionar organização (gerar novo token com org)
   * Super_admin pode selecionar qualquer organização
   */
  async selecionarOrganizacao(usuarioId, organizacaoId) {
    // Buscar usuário
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId }
    });

    if (!usuario) {
      throw new Error('Usuário não encontrado');
    }

    // Super admin pode acessar qualquer organização (inclusive inativas para gerenciamento)
    if (usuario.role === 'super_admin') {
      const organizacao = await prisma.organizacao.findUnique({
        where: { id: organizacaoId }
      });

      if (!organizacao) {
        throw new Error('Organização não encontrada');
      }

      // Super admin pode acessar orgs inativas para gerenciamento
      const accessToken = this.generateAccessToken(usuario, organizacao, 'super_admin');

      // Registrar auditoria de acesso à organização
      await this.registrarAuditoria(usuarioId, 'SELECIONAR_ORGANIZACAO', 'organizacao', organizacaoId.toString(),
        `Super admin acessou organização "${organizacao.nome}"`, null, null, true, organizacaoId);

      return {
        accessToken,
        organizacao: {
          id: organizacao.id,
          nome: organizacao.nome,
          slug: organizacao.slug,
          logo_url: organizacao.logo_url,
          cor_primaria: organizacao.cor_primaria,
          cor_secundaria: organizacao.cor_secundaria,
          config_tema: organizacao.config_tema
        },
        role: 'super_admin'
      };
    }

    // Para usuários normais, verificar associação
    const associacao = await prisma.usuarioOrganizacao.findUnique({
      where: {
        usuario_id_organizacao_id: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId
        }
      },
      include: {
        organizacao: true,
        usuario: true
      }
    });

    if (!associacao) {
      throw new Error('Usuário não pertence a esta organização');
    }

    if (associacao.organizacao.status !== 'ativo') {
      throw new Error('Esta organização está temporariamente suspensa. Entre em contato com o suporte para mais informações.');
    }

    // Gerar novo token com a organização selecionada
    const accessToken = this.generateAccessToken(
      associacao.usuario,
      associacao.organizacao,
      associacao.role
    );

    // Registrar auditoria de troca de organização
    await this.registrarAuditoria(usuarioId, 'SELECIONAR_ORGANIZACAO', 'organizacao', organizacaoId.toString(),
      `Usuário acessou organização "${associacao.organizacao.nome}"`, null, null, true, organizacaoId);

    return {
      accessToken,
      organizacao: {
        id: associacao.organizacao.id,
        nome: associacao.organizacao.nome,
        slug: associacao.organizacao.slug,
        logo_url: associacao.organizacao.logo_url,
        cor_primaria: associacao.organizacao.cor_primaria,
        cor_secundaria: associacao.organizacao.cor_secundaria,
        config_tema: associacao.organizacao.config_tema
      },
      role: associacao.role
    };
  }

  /**
   * Gerar refresh token
   */
  generateRefreshToken() {
    const crypto = require('crypto');
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Verificar token JWT
   */
  verifyAccessToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch (error) {
      return null;
    }
  }

  /**
   * Registrar novo usuário
   */
  async registrar(email, senha, nome, role = 'operador') {
    // Verificar se email já existe
    const existente = await prisma.usuario.findUnique({
      where: { email }
    });

    if (existente) {
      throw new Error('Email já cadastrado');
    }

    // Validar força da senha
    if (senha.length < 8) {
      throw new Error('Senha deve ter no mínimo 8 caracteres');
    }

    const senhaHash = await this.hashPassword(senha);

    const usuario = await prisma.usuario.create({
      data: {
        email,
        senha_hash: senhaHash,
        nome,
        role
      }
    });

    // Log de auditoria
    await this.registrarAuditoria(usuario.id, 'REGISTRO', 'usuario', usuario.id.toString(),
      `Novo usuário registrado: ${email}`);

    return {
      id: usuario.id,
      email: usuario.email,
      nome: usuario.nome,
      role: usuario.role
    };
  }

  /**
   * Login de usuário
   */
  async login(email, senha, ip = null, userAgent = null) {
    const usuario = await prisma.usuario.findUnique({
      where: { email }
    });

    if (!usuario) {
      await this.registrarAuditoria(null, 'LOGIN_FALHA', 'usuario', null,
        `Tentativa de login com email inexistente: ${email}`, ip, userAgent, false);
      throw new Error('Credenciais inválidas');
    }

    // Verificar se está bloqueado
    if (usuario.bloqueado_ate && usuario.bloqueado_ate > new Date()) {
      const minutosRestantes = Math.ceil((usuario.bloqueado_ate - new Date()) / 60000);
      await this.registrarAuditoria(usuario.id, 'LOGIN_BLOQUEADO', 'usuario', usuario.id.toString(),
        `Tentativa de login com conta bloqueada`, ip, userAgent, false);
      throw new Error(`Conta bloqueada. Tente novamente em ${minutosRestantes} minutos`);
    }

    // Verificar se usuário está ativo
    if (!usuario.ativo) {
      await this.registrarAuditoria(usuario.id, 'LOGIN_INATIVO', 'usuario', usuario.id.toString(),
        `Tentativa de login com conta inativa`, ip, userAgent, false);
      throw new Error('Conta desativada');
    }

    // Verificar senha
    const senhaCorreta = await this.verifyPassword(senha, usuario.senha_hash);

    if (!senhaCorreta) {
      // Incrementar tentativas de login
      const tentativas = usuario.tentativas_login + 1;
      const updateData = { tentativas_login: tentativas };

      // Bloquear se excedeu tentativas
      if (tentativas >= MAX_LOGIN_ATTEMPTS) {
        updateData.bloqueado_ate = new Date(Date.now() + LOCKOUT_DURATION_MINUTES * 60000);
      }

      await prisma.usuario.update({
        where: { id: usuario.id },
        data: updateData
      });

      await this.registrarAuditoria(usuario.id, 'LOGIN_FALHA', 'usuario', usuario.id.toString(),
        `Senha incorreta. Tentativa ${tentativas}/${MAX_LOGIN_ATTEMPTS}`, ip, userAgent, false);

      if (tentativas >= MAX_LOGIN_ATTEMPTS) {
        throw new Error(`Conta bloqueada por ${LOCKOUT_DURATION_MINUTES} minutos após ${MAX_LOGIN_ATTEMPTS} tentativas`);
      }

      throw new Error('Credenciais inválidas');
    }

    // Login bem-sucedido - resetar tentativas
    await prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        tentativas_login: 0,
        bloqueado_ate: null,
        ultimo_login: new Date()
      }
    });

    // Buscar organizações do usuário
    const organizacoes = await this.buscarOrganizacoesDoUsuario(usuario.id);

    // Verificar se usuário tem ao menos uma organização ativa (exceto super_admin)
    if (usuario.role !== 'super_admin') {
      const orgsAtivas = organizacoes.filter(o => o.status === 'ativo');
      if (organizacoes.length > 0 && orgsAtivas.length === 0) {
        await this.registrarAuditoria(usuario.id, 'LOGIN_ORG_INATIVA', 'usuario', usuario.id.toString(),
          `Tentativa de login com todas as organizações inativas`, ip, userAgent, false);
        throw new Error('Sua organização está temporariamente suspensa. Entre em contato com o suporte para mais informações.');
      }
    }

    // Encontrar organização padrão (ou primeira ativa)
    let orgPadrao = organizacoes.find(o => o.is_default && o.status === 'ativo');
    if (!orgPadrao) {
      orgPadrao = organizacoes.find(o => o.status === 'ativo');
    }

    // Gerar tokens (com organização se houver)
    let accessToken;
    if (orgPadrao) {
      // Buscar dados completos da organização para o token
      const orgCompleta = await prisma.organizacao.findUnique({
        where: { id: orgPadrao.id }
      });
      accessToken = this.generateAccessToken(usuario, orgCompleta, orgPadrao.role);
    } else {
      accessToken = this.generateAccessToken(usuario);
    }

    const refreshToken = this.generateRefreshToken();

    // Calcular expiração do refresh token
    const refreshExpiresAt = new Date();
    const refreshDays = parseInt(JWT_REFRESH_EXPIRES_IN) || 7;
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshDays);

    // Salvar refresh token
    await prisma.refreshToken.create({
      data: {
        usuario_id: usuario.id,
        token: refreshToken,
        expires_at: refreshExpiresAt,
        ip,
        user_agent: userAgent
      }
    });

    await this.registrarAuditoria(usuario.id, 'LOGIN_SUCESSO', 'usuario', usuario.id.toString(),
      'Login realizado com sucesso', ip, userAgent, true, orgPadrao?.id || null);

    return {
      accessToken,
      refreshToken,
      usuario: {
        id: usuario.id,
        email: usuario.email,
        nome: usuario.nome,
        role: usuario.role
      },
      organizacoes,
      organizacao_atual: orgPadrao || null
    };
  }

  /**
   * Renovar access token usando refresh token
   * @param {string} refreshToken - Token de refresh
   * @param {string} ip - IP do cliente (opcional)
   * @param {string} userAgent - User agent (opcional)
   * @param {Object} tokenAnterior - Dados do token anterior para preservar organização (opcional)
   */
  async refreshAccessToken(refreshToken, ip = null, userAgent = null, tokenAnterior = null) {
    const tokenData = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { usuario: true }
    });

    if (!tokenData) {
      throw new Error('Refresh token inválido');
    }

    if (tokenData.revogado) {
      // Possível ataque - revogar todos os tokens do usuário
      await prisma.refreshToken.updateMany({
        where: { usuario_id: tokenData.usuario_id },
        data: { revogado: true }
      });
      await this.registrarAuditoria(tokenData.usuario_id, 'TOKEN_REUSO_DETECTADO', 'refresh_token', null,
        'Possível ataque: reuso de refresh token revogado', ip, userAgent, false);
      throw new Error('Refresh token já foi utilizado');
    }

    if (tokenData.expires_at < new Date()) {
      throw new Error('Refresh token expirado');
    }

    if (!tokenData.usuario.ativo) {
      throw new Error('Conta desativada');
    }

    // Revogar token antigo (rotation)
    await prisma.refreshToken.update({
      where: { id: tokenData.id },
      data: { revogado: true }
    });

    // Buscar organização para incluir no novo token
    let organizacao = null;
    let roleNaOrg = null;

    // Se temos dados do token anterior, usar a organização dele
    if (tokenAnterior?.organizacao_id) {
      organizacao = await prisma.organizacao.findUnique({
        where: { id: tokenAnterior.organizacao_id }
      });
      roleNaOrg = tokenAnterior.role_org;
    }

    // Se não há organização do token anterior, buscar organização padrão do usuário
    if (!organizacao) {
      const organizacoes = await this.buscarOrganizacoesDoUsuario(tokenData.usuario.id);
      const orgPadrao = organizacoes.find(o => o.is_default && o.status === 'ativo') ||
                        organizacoes.find(o => o.status === 'ativo');

      if (orgPadrao) {
        organizacao = await prisma.organizacao.findUnique({
          where: { id: orgPadrao.id }
        });
        roleNaOrg = orgPadrao.role;
      }
    }

    // Gerar novos tokens (agora com organização preservada)
    const newAccessToken = this.generateAccessToken(tokenData.usuario, organizacao, roleNaOrg);
    const newRefreshToken = this.generateRefreshToken();

    const refreshExpiresAt = new Date();
    const refreshDays = parseInt(JWT_REFRESH_EXPIRES_IN) || 7;
    refreshExpiresAt.setDate(refreshExpiresAt.getDate() + refreshDays);

    await prisma.refreshToken.create({
      data: {
        usuario_id: tokenData.usuario_id,
        token: newRefreshToken,
        expires_at: refreshExpiresAt,
        ip,
        user_agent: userAgent
      }
    });

    await this.registrarAuditoria(tokenData.usuario_id, 'TOKEN_REFRESH', 'refresh_token', null,
      'Access token renovado', ip, userAgent);

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  }

  /**
   * Logout - revogar refresh token
   */
  async logout(refreshToken, ip = null, userAgent = null) {
    const tokenData = await prisma.refreshToken.findUnique({
      where: { token: refreshToken }
    });

    if (tokenData) {
      await prisma.refreshToken.update({
        where: { id: tokenData.id },
        data: { revogado: true }
      });

      await this.registrarAuditoria(tokenData.usuario_id, 'LOGOUT', 'usuario', null,
        'Logout realizado', ip, userAgent);
    }

    return { success: true };
  }

  /**
   * Logout de todos os dispositivos
   */
  async logoutAll(usuarioId, ip = null, userAgent = null) {
    await prisma.refreshToken.updateMany({
      where: { usuario_id: usuarioId },
      data: { revogado: true }
    });

    await this.registrarAuditoria(usuarioId, 'LOGOUT_ALL', 'usuario', usuarioId.toString(),
      'Logout de todos os dispositivos', ip, userAgent);

    return { success: true };
  }

  /**
   * Alterar senha
   */
  async alterarSenha(usuarioId, senhaAtual, novaSenha, ip = null, userAgent = null) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId }
    });

    if (!usuario) {
      throw new Error('Usuário não encontrado');
    }

    const senhaCorreta = await this.verifyPassword(senhaAtual, usuario.senha_hash);
    if (!senhaCorreta) {
      await this.registrarAuditoria(usuarioId, 'SENHA_ALTERACAO_FALHA', 'usuario', usuarioId.toString(),
        'Senha atual incorreta', ip, userAgent, false);
      throw new Error('Senha atual incorreta');
    }

    if (novaSenha.length < 8) {
      throw new Error('Nova senha deve ter no mínimo 8 caracteres');
    }

    const novaHash = await this.hashPassword(novaSenha);

    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { senha_hash: novaHash }
    });

    // Revogar todos os refresh tokens (forçar re-login)
    await prisma.refreshToken.updateMany({
      where: { usuario_id: usuarioId },
      data: { revogado: true }
    });

    await this.registrarAuditoria(usuarioId, 'SENHA_ALTERADA', 'usuario', usuarioId.toString(),
      'Senha alterada com sucesso', ip, userAgent);

    return { success: true };
  }

  /**
   * Buscar usuário por ID
   */
  async buscarUsuario(usuarioId) {
    const usuario = await prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: {
        id: true,
        email: true,
        nome: true,
        role: true,
        ativo: true,
        ultimo_login: true,
        created_at: true
      }
    });

    return usuario;
  }

  /**
   * Listar usuários (apenas admin)
   */
  async listarUsuarios() {
    return prisma.usuario.findMany({
      select: {
        id: true,
        email: true,
        nome: true,
        role: true,
        ativo: true,
        ultimo_login: true,
        created_at: true
      },
      orderBy: { created_at: 'desc' }
    });
  }

  /**
   * Desativar usuário (apenas admin)
   */
  async desativarUsuario(usuarioId, adminId, ip = null, userAgent = null) {
    await prisma.usuario.update({
      where: { id: usuarioId },
      data: { ativo: false }
    });

    // Revogar todos os tokens
    await prisma.refreshToken.updateMany({
      where: { usuario_id: usuarioId },
      data: { revogado: true }
    });

    await this.registrarAuditoria(adminId, 'USUARIO_DESATIVADO', 'usuario', usuarioId.toString(),
      `Usuário ${usuarioId} desativado`, ip, userAgent);

    return { success: true };
  }

  /**
   * Registrar log de auditoria
   */
  async registrarAuditoria(usuarioId, acao, recurso = null, recursoId = null, detalhes = null, ip = null, userAgent = null, sucesso = true, organizacaoId = null) {
    try {
      await prisma.auditLog.create({
        data: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId,
          acao,
          recurso,
          recurso_id: recursoId,
          detalhes,
          ip,
          user_agent: userAgent,
          sucesso
        }
      });
    } catch (error) {
      console.error('Erro ao registrar auditoria:', error);
    }
  }

  /**
   * Buscar logs de auditoria
   */
  async buscarAuditoria(filtros = {}) {
    const where = {};

    if (filtros.usuarioId) {
      where.usuario_id = filtros.usuarioId;
    }

    // Filtrar por organização única (se especificado)
    if (filtros.organizacaoId) {
      where.organizacao_id = filtros.organizacaoId;
    }

    // Filtrar por múltiplas organizações (se especificado)
    if (filtros.organizacaoIds && Array.isArray(filtros.organizacaoIds) && filtros.organizacaoIds.length > 0) {
      where.organizacao_id = { in: filtros.organizacaoIds };
    }

    if (filtros.acao) {
      where.acao = filtros.acao;
    }

    if (filtros.dataInicio && filtros.dataFim) {
      where.created_at = {
        gte: new Date(filtros.dataInicio),
        lte: new Date(filtros.dataFim)
      };
    }

    return prisma.auditLog.findMany({
      where,
      include: {
        usuario: {
          select: { email: true, nome: true }
        },
        organizacao: {
          select: { id: true, nome: true, slug: true }
        }
      },
      orderBy: { created_at: 'desc' },
      take: filtros.limite || 100
    });
  }

  /**
   * Limpar tokens expirados (job de manutenção)
   */
  async limparTokensExpirados() {
    const result = await prisma.refreshToken.deleteMany({
      where: {
        OR: [
          { expires_at: { lt: new Date() } },
          { revogado: true }
        ]
      }
    });

    console.log(`🧹 Tokens limpos: ${result.count}`);
    return result.count;
  }

  /**
   * Solicitar recuperação de senha
   * Gera token de reset e envia email
   */
  async solicitarRecuperacaoSenha(email, ip = null, userAgent = null) {
    // Buscar usuário pelo email
    const usuario = await prisma.usuario.findUnique({
      where: { email }
    });

    // Por segurança, sempre retornamos sucesso (não revelar se email existe)
    if (!usuario) {
      await this.registrarAuditoria(null, 'RESET_SENHA_EMAIL_NAO_ENCONTRADO', 'usuario', null,
        `Tentativa de reset para email inexistente: ${email}`, ip, userAgent, false);
      return { success: true }; // Não revelar que email não existe
    }

    if (!usuario.ativo) {
      await this.registrarAuditoria(usuario.id, 'RESET_SENHA_CONTA_INATIVA', 'usuario', usuario.id.toString(),
        'Tentativa de reset para conta inativa', ip, userAgent, false);
      return { success: true }; // Não revelar que conta está inativa
    }

    // Gerar token de reset (32 bytes = 64 caracteres hex)
    const resetToken = crypto.randomBytes(32).toString('hex');

    // Armazenar token no Redis com TTL de 1 hora
    const redisKey = `password_reset:${resetToken}`;
    const tokenData = {
      userId: usuario.id,
      email: usuario.email,
      createdAt: Date.now()
    };

    try {
      await redisService.set(redisKey, JSON.stringify(tokenData), 3600); // 1 hora
    } catch (error) {
      console.error('Erro ao salvar token de reset no Redis:', error);
      throw new Error('Erro interno ao processar solicitação');
    }

    // Enviar email de recuperação
    try {
      await emailService.sendPasswordReset(usuario.email, usuario.nome, resetToken);
    } catch (error) {
      console.error('Erro ao enviar email de recuperação:', error);
      // Remover token do Redis se email falhar
      await redisService.del(redisKey);
      throw new Error('Erro ao enviar email de recuperação');
    }

    await this.registrarAuditoria(usuario.id, 'RESET_SENHA_SOLICITADO', 'usuario', usuario.id.toString(),
      'Solicitação de recuperação de senha enviada', ip, userAgent);

    return { success: true };
  }

  /**
   * Validar token de reset
   */
  async validarTokenReset(token) {
    const redisKey = `password_reset:${token}`;

    try {
      const data = await redisService.get(redisKey);

      if (!data) {
        return { valid: false, error: 'Token inválido ou expirado' };
      }

      const tokenData = JSON.parse(data);

      // Verificar se usuário ainda existe e está ativo
      const usuario = await prisma.usuario.findUnique({
        where: { id: tokenData.userId }
      });

      if (!usuario || !usuario.ativo) {
        return { valid: false, error: 'Usuário não encontrado ou inativo' };
      }

      return {
        valid: true,
        userId: tokenData.userId,
        email: tokenData.email
      };
    } catch (error) {
      console.error('Erro ao validar token de reset:', error);
      return { valid: false, error: 'Erro ao validar token' };
    }
  }

  /**
   * Redefinir senha usando token
   */
  async redefinirSenha(token, novaSenha, ip = null, userAgent = null) {
    // Validar token
    const validacao = await this.validarTokenReset(token);

    if (!validacao.valid) {
      throw new Error(validacao.error);
    }

    // Validar força da senha
    if (!novaSenha || novaSenha.length < 8) {
      throw new Error('Nova senha deve ter no mínimo 8 caracteres');
    }

    // Hash da nova senha
    const novaHash = await this.hashPassword(novaSenha);

    // Atualizar senha do usuário
    await prisma.usuario.update({
      where: { id: validacao.userId },
      data: {
        senha_hash: novaHash,
        tentativas_login: 0,
        bloqueado_ate: null
      }
    });

    // Revogar todos os refresh tokens (forçar re-login em todos os dispositivos)
    await prisma.refreshToken.updateMany({
      where: { usuario_id: validacao.userId },
      data: { revogado: true }
    });

    // Invalidar token de reset (uso único)
    const redisKey = `password_reset:${token}`;
    await redisService.del(redisKey);

    // Invalidar todos os tokens do usuário no Redis
    await redisService.invalidateUserTokens(validacao.userId);

    await this.registrarAuditoria(validacao.userId, 'SENHA_REDEFINIDA', 'usuario', validacao.userId.toString(),
      'Senha redefinida via link de recuperação', ip, userAgent);

    return { success: true };
  }
}

module.exports = new AuthService();
