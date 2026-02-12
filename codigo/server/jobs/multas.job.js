/**
 * Jobs de Multas
 *
 * Tarefas automáticas relacionadas a multas:
 * - Marcar multas vencidas
 * - Alertar sobre multas próximas do vencimento
 * - Alertar sobre NIC pendente
 */

const prisma = require('../db/prisma');

// Helper para criar notificações (quando o serviço estiver disponível)
async function criarNotificacao(dados) {
  try {
    // Criar notificação no banco
    await prisma.notificacao.create({
      data: {
        usuario_id: dados.usuario_id,
        tipo: dados.tipo,
        titulo: dados.titulo,
        mensagem: dados.mensagem,
        dados: dados.dados || {},
        lida: false
      }
    });
  } catch (error) {
    // Se a tabela não existir ou outro erro, apenas loga
    console.log(`[Notificação] ${dados.titulo}: ${dados.mensagem}`);
  }
}

class MultasJob {
  /**
   * Marcar multas como vencidas
   * Executar diariamente às 00:05
   */
  async marcarVencidas() {
    const inicio = Date.now();
    console.log('[MultasJob] Iniciando verificação de multas vencidas...');

    try {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      // Buscar multas pendentes com data de vencimento passada
      const multasVencidas = await prisma.multa.updateMany({
        where: {
          status: 'pendente',
          data_vencimento: {
            lt: hoje
          }
        },
        data: {
          status: 'vencida'
        }
      });

      const duracao = Date.now() - inicio;
      console.log(`[MultasJob] ${multasVencidas.count} multas marcadas como vencidas (${duracao}ms)`);

      return { atualizadas: multasVencidas.count };
    } catch (error) {
      console.error('[MultasJob] Erro ao marcar multas vencidas:', error);
      throw error;
    }
  }

  /**
   * Alertar sobre multas próximas do vencimento
   * Executar diariamente às 08:00
   */
  async alertarProximasVencer() {
    const inicio = Date.now();
    console.log('[MultasJob] Verificando multas próximas do vencimento...');

    try {
      const hoje = new Date();
      const em7dias = new Date();
      em7dias.setDate(em7dias.getDate() + 7);

      // Buscar multas que vencem nos próximos 7 dias
      const multas = await prisma.multa.findMany({
        where: {
          status: 'pendente',
          data_vencimento: {
            gte: hoje,
            lte: em7dias
          }
        },
        include: {
          veiculo: { select: { placa: true } },
          organizacao: { select: { id: true, nome: true } }
        }
      });

      // Agrupar por organização
      const porOrganizacao = {};
      for (const multa of multas) {
        const orgId = multa.organizacao_id;
        if (!porOrganizacao[orgId]) {
          porOrganizacao[orgId] = {
            organizacao: multa.organizacao,
            multas: []
          };
        }
        porOrganizacao[orgId].multas.push(multa);
      }

      // Enviar notificação para cada organização
      let notificacoesEnviadas = 0;
      for (const orgId of Object.keys(porOrganizacao)) {
        const { organizacao, multas: multasOrg } = porOrganizacao[orgId];

        if (multasOrg.length > 0) {
          try {
            // Buscar admins da organização
            const admins = await prisma.usuario.findMany({
              where: {
                organizacao_id: parseInt(orgId),
                role: { in: ['admin', 'super_admin'] },
                ativo: true
              },
              select: { id: true }
            });

            const valorTotal = multasOrg.reduce((sum, m) => sum + (m.valor_original || 0), 0);
            const placas = [...new Set(multasOrg.map(m => m.veiculo?.placa))].filter(Boolean).join(', ');

            // Criar notificação
            for (const admin of admins) {
              await criarNotificacao({
                usuario_id: admin.id,
                tipo: 'multa_vencendo',
                titulo: `${multasOrg.length} multa(s) vencendo em breve`,
                mensagem: `Veículos: ${placas}. Valor total: R$ ${valorTotal.toFixed(2)}`,
                dados: {
                  quantidade: multasOrg.length,
                  valor_total: valorTotal,
                  multa_ids: multasOrg.map(m => m.id)
                }
              });
              notificacoesEnviadas++;
            }
          } catch (err) {
            console.error(`[MultasJob] Erro ao notificar org ${orgId}:`, err.message);
          }
        }
      }

      const duracao = Date.now() - inicio;
      console.log(`[MultasJob] ${multas.length} multas próximas do vencimento, ${notificacoesEnviadas} notificações enviadas (${duracao}ms)`);

      return { multas: multas.length, notificacoes: notificacoesEnviadas };
    } catch (error) {
      console.error('[MultasJob] Erro ao alertar multas próximas:', error);
      throw error;
    }
  }

  /**
   * Alertar sobre NIC pendente
   * Executar diariamente às 08:30
   */
  async alertarNICPendente() {
    const inicio = Date.now();
    console.log('[MultasJob] Verificando NIC pendentes...');

    try {
      const hoje = new Date();
      const em5dias = new Date();
      em5dias.setDate(em5dias.getDate() + 5);

      // Buscar multas com NIC pendente nos próximos 5 dias
      const multas = await prisma.multa.findMany({
        where: {
          nic_enviado: false,
          nic_data_limite: {
            gte: hoje,
            lte: em5dias
          }
        },
        include: {
          veiculo: { select: { placa: true } },
          organizacao: { select: { id: true, nome: true } }
        }
      });

      // Agrupar por organização e notificar
      const porOrganizacao = {};
      for (const multa of multas) {
        const orgId = multa.organizacao_id;
        if (!porOrganizacao[orgId]) {
          porOrganizacao[orgId] = [];
        }
        porOrganizacao[orgId].push(multa);
      }

      let notificacoesEnviadas = 0;
      for (const orgId of Object.keys(porOrganizacao)) {
        const multasOrg = porOrganizacao[orgId];

        try {
          const admins = await prisma.usuario.findMany({
            where: {
              organizacao_id: parseInt(orgId),
              role: { in: ['admin', 'super_admin'] },
              ativo: true
            },
            select: { id: true }
          });

          for (const admin of admins) {
            await criarNotificacao({
              usuario_id: admin.id,
              tipo: 'nic_pendente',
              titulo: `${multasOrg.length} NIC pendente(s)`,
              mensagem: `Prazo para identificação do condutor vencendo em breve`,
              dados: {
                quantidade: multasOrg.length,
                multa_ids: multasOrg.map(m => m.id)
              }
            });
            notificacoesEnviadas++;
          }
        } catch (err) {
          console.error(`[MultasJob] Erro ao notificar NIC org ${orgId}:`, err.message);
        }
      }

      const duracao = Date.now() - inicio;
      console.log(`[MultasJob] ${multas.length} NIC pendentes, ${notificacoesEnviadas} notificações enviadas (${duracao}ms)`);

      return { multas: multas.length, notificacoes: notificacoesEnviadas };
    } catch (error) {
      console.error('[MultasJob] Erro ao alertar NIC pendente:', error);
      throw error;
    }
  }

  /**
   * Atualizar status de multas vencidas com desconto
   * Se passou a data do desconto mas não a data normal, mantém pendente
   */
  async atualizarDescontosExpirados() {
    const inicio = Date.now();
    console.log('[MultasJob] Verificando descontos expirados...');

    try {
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);

      // Buscar multas com desconto vencido mas ainda dentro do prazo normal
      const multas = await prisma.multa.findMany({
        where: {
          status: 'pendente',
          data_vencimento_desconto: {
            lt: hoje
          },
          data_vencimento: {
            gte: hoje
          }
        },
        select: { id: true, numero_auto: true }
      });

      // Não muda o status, apenas loga para acompanhamento
      const duracao = Date.now() - inicio;
      console.log(`[MultasJob] ${multas.length} multas com desconto expirado (${duracao}ms)`);

      return { multas: multas.length };
    } catch (error) {
      console.error('[MultasJob] Erro ao verificar descontos:', error);
      throw error;
    }
  }
}

module.exports = new MultasJob();
