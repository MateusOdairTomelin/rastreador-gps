/**
 * Middleware para verificação de propriedade de dispositivo por tenant
 * ✅ Multi-tenant: Verifica se o dispositivo pertence à organização do usuário
 *
 * Uso: Importar e aplicar nas rotas que acessam dispositivos por :imei
 */

const prisma = require('../db/prisma');

/**
 * Middleware que verifica se o dispositivo pertence à organização do usuário
 * - Se usuário é super_admin, permite acesso a qualquer dispositivo
 * - Se usuário não é super_admin, verifica se dispositivo pertence à sua organização
 *
 * Requisitos:
 * - req.params.imei deve conter o IMEI do dispositivo
 * - req.tenant deve ter sido configurado pelo tenantContext middleware
 *
 * Resultado:
 * - req.dispositivo é populado com os dados do dispositivo encontrado
 */
const verificarDispositivoTenant = async (req, res, next) => {
  const { imei } = req.params;

  // Se não tem IMEI na rota, passa para o próximo middleware
  if (!imei) return next();

  try {
    // Buscar dispositivo pelo IMEI
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei },
      select: {
        id: true,
        imei: true,
        organizacao_id: true,
        placa: true,
        veiculo: true,
        tipo: true,
        status: true
      }
    });

    if (!dispositivo) {
      return res.status(404).json({
        sucesso: false,
        mensagem: 'Dispositivo não encontrado'
      });
    }

    // Super admin pode acessar qualquer dispositivo
    if (req.tenant?.isSuperAdmin) {
      req.dispositivo = dispositivo;
      return next();
    }

    // Verificar se dispositivo pertence à organização do usuário
    if (req.tenant?.id && dispositivo.organizacao_id !== req.tenant.id) {
      return res.status(403).json({
        sucesso: false,
        mensagem: 'Dispositivo não pertence à sua organização'
      });
    }

    // Dispositivo autorizado - anexar ao request
    req.dispositivo = dispositivo;
    next();
  } catch (error) {
    console.error('[verificarDispositivoTenant] Erro:', error);
    return res.status(500).json({
      sucesso: false,
      mensagem: 'Erro ao verificar dispositivo',
      erro: error.message
    });
  }
};

/**
 * Factory que cria middleware de verificação de tenant para queries
 * Retorna filtro para usar em queries Prisma
 *
 * Uso:
 * const tenantFilter = criarFiltroTenant(req);
 * const dispositivos = await prisma.dispositivo.findMany({
 *   where: { ...tenantFilter, ...outrosFiltros }
 * });
 */
const criarFiltroTenant = (req) => {
  // Super admin não tem filtro (acessa tudo)
  if (req.tenant?.isSuperAdmin) {
    return {};
  }

  // Usuário normal: filtrar pela sua organização
  if (req.tenant?.id) {
    return { organizacao_id: req.tenant.id };
  }

  // Sem tenant configurado: retorna filtro vazio (comportamento padrão)
  return {};
};

/**
 * Factory que cria filtro de dispositivos para queries que relacionam
 * com dispositivo (viagens, localizações, alarmes)
 *
 * Uso:
 * const dispositivoFilter = criarFiltroDispositivosTenant(req);
 * const viagens = await prisma.viagem.findMany({
 *   where: {
 *     dispositivo: dispositivoFilter
 *   }
 * });
 */
const criarFiltroDispositivosTenant = (req) => {
  // Super admin não tem filtro
  if (req.tenant?.isSuperAdmin) {
    return {};
  }

  // Filtrar dispositivos pela organização
  if (req.tenant?.id) {
    return { organizacao_id: req.tenant.id };
  }

  return {};
};

module.exports = {
  verificarDispositivoTenant,
  criarFiltroTenant,
  criarFiltroDispositivosTenant
};
