/**
 * Serviço de Auditoria Centralizado
 * Registra TODAS as ações do sistema para compliance e rastreabilidade
 */

const prisma = require('../db/prisma');

class AuditoriaService {

  /**
   * Registrar ação no log de auditoria
   * @param {Object} dados - Dados da auditoria
   * @param {number} dados.usuarioId - ID do usuário que executou a ação
   * @param {number} dados.organizacaoId - ID da organização (contexto)
   * @param {string} dados.acao - Tipo da ação (ex: CRIAR_DISPOSITIVO)
   * @param {string} dados.recurso - Tipo do recurso (ex: dispositivo, usuario, organizacao)
   * @param {string} dados.recursoId - ID do recurso afetado
   * @param {string} dados.detalhes - Descrição detalhada da ação
   * @param {Object} dados.dadosAnteriores - Estado anterior do recurso (para edições)
   * @param {Object} dados.dadosNovos - Novo estado do recurso
   * @param {string} dados.ip - IP do usuário
   * @param {string} dados.userAgent - User agent do navegador
   * @param {boolean} dados.sucesso - Se a ação foi bem-sucedida
   */
  async registrar({
    usuarioId = null,
    organizacaoId = null,
    acao,
    recurso = null,
    recursoId = null,
    detalhes = null,
    dadosAnteriores = null,
    dadosNovos = null,
    ip = null,
    userAgent = null,
    sucesso = true
  }) {
    try {
      // Construir detalhes completos
      let detalhesCompletos = detalhes || '';

      // Se tiver dados anteriores e novos, registrar as mudanças
      if (dadosAnteriores && dadosNovos) {
        const mudancas = this.detectarMudancas(dadosAnteriores, dadosNovos);
        if (mudancas.length > 0) {
          detalhesCompletos += (detalhesCompletos ? ' | ' : '') + 'Alterações: ' + mudancas.join(', ');
        }
      } else if (dadosNovos && !dadosAnteriores) {
        // Criação - registrar campos principais
        const campos = this.extrairCamposPrincipais(dadosNovos);
        if (campos) {
          detalhesCompletos += (detalhesCompletos ? ' | ' : '') + campos;
        }
      }

      await prisma.auditLog.create({
        data: {
          usuario_id: usuarioId,
          organizacao_id: organizacaoId,
          acao,
          recurso,
          recurso_id: recursoId ? String(recursoId) : null,
          detalhes: detalhesCompletos ? detalhesCompletos.substring(0, 1000) : null, // Limitar tamanho
          ip,
          user_agent: userAgent ? userAgent.substring(0, 500) : null,
          sucesso
        }
      });

      return true;
    } catch (error) {
      console.error('Erro ao registrar auditoria:', error);
      return false;
    }
  }

  /**
   * Detectar mudanças entre dois objetos
   */
  detectarMudancas(anterior, novo) {
    const mudancas = [];
    const camposIgnorados = ['updated_at', 'created_at', 'senha_hash', 'token'];

    for (const chave of Object.keys(novo)) {
      if (camposIgnorados.includes(chave)) continue;

      const valorAnterior = anterior[chave];
      const valorNovo = novo[chave];

      // Ignorar se ambos são undefined/null
      if (valorAnterior == null && valorNovo == null) continue;

      // Comparar valores
      if (JSON.stringify(valorAnterior) !== JSON.stringify(valorNovo)) {
        // Formatar a mudança de forma legível
        const anterior_str = this.formatarValor(valorAnterior);
        const novo_str = this.formatarValor(valorNovo);
        mudancas.push(`${chave}: ${anterior_str} → ${novo_str}`);
      }
    }

    return mudancas;
  }

  /**
   * Formatar valor para exibição
   */
  formatarValor(valor) {
    if (valor === null || valor === undefined) return '(vazio)';
    if (typeof valor === 'boolean') return valor ? 'sim' : 'não';
    if (typeof valor === 'object') return JSON.stringify(valor).substring(0, 50);
    return String(valor).substring(0, 50);
  }

  /**
   * Extrair campos principais de um objeto para log de criação
   */
  extrairCamposPrincipais(dados) {
    const camposImportantes = ['nome', 'email', 'imei', 'placa', 'status', 'role', 'tipo'];
    const valores = [];

    for (const campo of camposImportantes) {
      if (dados[campo]) {
        valores.push(`${campo}: ${dados[campo]}`);
      }
    }

    return valores.join(', ');
  }

  /**
   * Buscar logs de auditoria com filtros avançados
   */
  async buscar({
    usuarioId = null,
    organizacaoId = null,
    acao = null,
    recurso = null,
    recursoId = null,
    dataInicio = null,
    dataFim = null,
    sucesso = null,
    limite = 100,
    offset = 0
  }) {
    const where = {};

    if (usuarioId) where.usuario_id = usuarioId;
    if (organizacaoId) where.organizacao_id = organizacaoId;
    if (acao) where.acao = acao;
    if (recurso) where.recurso = recurso;
    if (recursoId) where.recurso_id = String(recursoId);
    if (sucesso !== null) where.sucesso = sucesso;

    if (dataInicio || dataFim) {
      where.created_at = {};
      if (dataInicio) where.created_at.gte = new Date(dataInicio);
      if (dataFim) {
        const fim = new Date(dataFim);
        fim.setHours(23, 59, 59, 999);
        where.created_at.lte = fim;
      }
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: {
          usuario: {
            select: { id: true, email: true, nome: true }
          },
          organizacao: {
            select: { id: true, nome: true, slug: true }
          }
        },
        orderBy: { created_at: 'desc' },
        take: limite,
        skip: offset
      }),
      prisma.auditLog.count({ where })
    ]);

    return { logs, total };
  }

  /**
   * Obter estatísticas de auditoria
   */
  async obterEstatisticas(organizacaoId = null, dias = 7) {
    const dataInicio = new Date();
    dataInicio.setDate(dataInicio.getDate() - dias);

    const where = {
      created_at: { gte: dataInicio }
    };
    if (organizacaoId) where.organizacao_id = organizacaoId;

    const [
      totalAcoes,
      loginsSucesso,
      loginsFalha,
      alteracoes
    ] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.count({ where: { ...where, acao: 'LOGIN_SUCESSO' } }),
      prisma.auditLog.count({ where: { ...where, acao: 'LOGIN_FALHA' } }),
      prisma.auditLog.count({
        where: {
          ...where,
          acao: { in: ['EDITAR_ORGANIZACAO', 'EDITAR_DISPOSITIVO', 'EDITAR_USUARIO', 'EDITAR_MOTORISTA'] }
        }
      })
    ]);

    return {
      periodo_dias: dias,
      total_acoes: totalAcoes,
      logins_sucesso: loginsSucesso,
      logins_falha: loginsFalha,
      alteracoes: alteracoes
    };
  }
}

// Ações disponíveis para referência
const ACOES = {
  // Autenticação
  LOGIN_SUCESSO: 'LOGIN_SUCESSO',
  LOGIN_FALHA: 'LOGIN_FALHA',
  LOGIN_BLOQUEADO: 'LOGIN_BLOQUEADO',
  LOGIN_ORG_INATIVA: 'LOGIN_ORG_INATIVA',
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  SENHA_ALTERADA: 'SENHA_ALTERADA',
  SENHA_ALTERACAO_FALHA: 'SENHA_ALTERACAO_FALHA',
  TOKEN_REFRESH: 'TOKEN_REFRESH',
  SELECIONAR_ORGANIZACAO: 'SELECIONAR_ORGANIZACAO',

  // Organizações
  CRIAR_ORGANIZACAO: 'CRIAR_ORGANIZACAO',
  EDITAR_ORGANIZACAO: 'EDITAR_ORGANIZACAO',
  DELETAR_ORGANIZACAO: 'DELETAR_ORGANIZACAO',
  SUSPENDER_ORGANIZACAO: 'SUSPENDER_ORGANIZACAO',
  ATIVAR_ORGANIZACAO: 'ATIVAR_ORGANIZACAO',

  // Usuários
  CRIAR_USUARIO: 'CRIAR_USUARIO',
  EDITAR_USUARIO: 'EDITAR_USUARIO',
  DELETAR_USUARIO: 'DELETAR_USUARIO',
  DESATIVAR_USUARIO: 'DESATIVAR_USUARIO',
  ATIVAR_USUARIO: 'ATIVAR_USUARIO',
  ALTERAR_ROLE: 'ALTERAR_ROLE',
  ADICIONAR_ORG: 'ADICIONAR_ORG',
  REMOVER_ORG: 'REMOVER_ORG',

  // Convites
  CRIAR_CONVITE: 'CRIAR_CONVITE',
  ACEITAR_CONVITE: 'ACEITAR_CONVITE',
  CANCELAR_CONVITE: 'CANCELAR_CONVITE',

  // Dispositivos
  CRIAR_DISPOSITIVO: 'CRIAR_DISPOSITIVO',
  EDITAR_DISPOSITIVO: 'EDITAR_DISPOSITIVO',
  DELETAR_DISPOSITIVO: 'DELETAR_DISPOSITIVO',
  ATRIBUIR_DISPOSITIVO: 'ATRIBUIR_DISPOSITIVO',
  DESATRIBUIR_DISPOSITIVO: 'DESATRIBUIR_DISPOSITIVO',

  // Motoristas
  CRIAR_MOTORISTA: 'CRIAR_MOTORISTA',
  EDITAR_MOTORISTA: 'EDITAR_MOTORISTA',
  DELETAR_MOTORISTA: 'DELETAR_MOTORISTA',
  VINCULAR_MOTORISTA: 'VINCULAR_MOTORISTA',
  DESVINCULAR_MOTORISTA: 'DESVINCULAR_MOTORISTA',

  // Veiculos
  CRIAR_VEICULO: 'CRIAR_VEICULO',
  EDITAR_VEICULO: 'EDITAR_VEICULO',
  DELETAR_VEICULO: 'DELETAR_VEICULO',
  VINCULAR_DISPOSITIVO: 'VINCULAR_DISPOSITIVO',
  DESVINCULAR_DISPOSITIVO: 'DESVINCULAR_DISPOSITIVO',
  TROCAR_DISPOSITIVO: 'TROCAR_DISPOSITIVO',

  // Geofences
  CRIAR_GEOFENCE: 'CRIAR_GEOFENCE',
  EDITAR_GEOFENCE: 'EDITAR_GEOFENCE',
  DELETAR_GEOFENCE: 'DELETAR_GEOFENCE',

  // Notificações
  CONFIGURAR_NOTIFICACOES: 'CONFIGURAR_NOTIFICACOES',

  // Comandos de veículos
  ENVIAR_COMANDO: 'ENVIAR_COMANDO',
  CORTAR_COMBUSTIVEL: 'CORTAR_COMBUSTIVEL',
  RELIGAR_COMBUSTIVEL: 'RELIGAR_COMBUSTIVEL'
};

module.exports = new AuditoriaService();
module.exports.ACOES = ACOES;
