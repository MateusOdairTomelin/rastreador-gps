import { create } from 'zustand';
import { Alert, Vibration } from 'react-native';
import { apiService } from '@/services/api.service';
import { Notificacao } from '@/types';

interface NotificacaoState {
  // Estado
  notificacoes: Notificacao[];
  naoLidas: number;
  isLoading: boolean;
  error: string | null;
  lastFetch: Date | null;
  ultimaNotificacaoId: number | null; // Para detectar novas notificacoes
  novaNotificacao: Notificacao | null; // Notificacao mais recente para exibir alerta

  // Acoes
  fetchNotificacoes: (limit?: number) => Promise<void>;
  fetchContagem: () => Promise<void>;
  checkNovasNotificacoes: () => Promise<void>; // Verifica e mostra alerta
  marcarComoLida: (id: number) => Promise<void>;
  marcarTodasComoLidas: () => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
  limparNovaNotificacao: () => void;
}

// Intervalo minimo entre fetchs (em ms) - evita chamadas excessivas
const FETCH_DEBOUNCE = 5000;

export const useNotificacaoStore = create<NotificacaoState>((set, get) => ({
  // Estado inicial
  notificacoes: [],
  naoLidas: 0,
  isLoading: false,
  error: null,
  lastFetch: null,
  ultimaNotificacaoId: null,
  novaNotificacao: null,

  // Buscar notificacoes
  fetchNotificacoes: async (limit = 20) => {
    try {
      // Debounce - evitar chamadas muito frequentes
      const { lastFetch, isLoading } = get();
      if (isLoading) return;
      if (lastFetch && Date.now() - lastFetch.getTime() < FETCH_DEBOUNCE) {
        return;
      }

      set({ isLoading: true, error: null });

      const response = await apiService.getNotificacoes(limit);

      if (response.sucesso) {
        // Contar nao lidas
        const naoLidas = response.notificacoes.filter(n => !n.lida).length;

        set({
          notificacoes: response.notificacoes,
          naoLidas,
          isLoading: false,
          lastFetch: new Date(),
        });
      } else {
        set({ isLoading: false });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro ao buscar notificacoes';
      console.error('[NotificacaoStore] Erro:', errorMessage);
      set({ error: errorMessage, isLoading: false });
    }
  },

  // Buscar apenas contagem de nao lidas (mais leve)
  fetchContagem: async () => {
    try {
      const response = await apiService.getContagemNotificacoes();

      if (response.sucesso) {
        const { naoLidas: naoLidasAntes } = get();
        set({ naoLidas: response.naoLidas });

        // Se aumentou o numero de nao lidas, verificar nova notificacao
        if (response.naoLidas > naoLidasAntes) {
          get().checkNovasNotificacoes();
        }
      }
    } catch (error: unknown) {
      console.error('[NotificacaoStore] Erro ao buscar contagem:', error);
    }
  },

  // Verificar novas notificacoes e mostrar alerta
  checkNovasNotificacoes: async () => {
    try {
      const response = await apiService.getNotificacoes(5, true); // Apenas nao lidas

      if (response.sucesso && response.notificacoes.length > 0) {
        const maisRecente = response.notificacoes[0];
        const { ultimaNotificacaoId } = get();

        // Se e uma notificacao nova (ID maior que a ultima vista)
        if (!ultimaNotificacaoId || maisRecente.id > ultimaNotificacaoId) {
          set({
            ultimaNotificacaoId: maisRecente.id,
            novaNotificacao: maisRecente,
          });

          // Vibrar para alertar
          Vibration.vibrate([0, 300, 100, 300]);

          // Mostrar alerta nativo
          const severidadeEmoji =
            maisRecente.severidade === 'critical' ? '🚨' :
            maisRecente.severidade === 'danger' ? '⚠️' :
            maisRecente.severidade === 'warning' ? '⚡' : 'ℹ️';

          Alert.alert(
            `${severidadeEmoji} ${maisRecente.titulo}`,
            maisRecente.mensagem,
            [
              {
                text: 'OK',
                onPress: () => {
                  get().limparNovaNotificacao();
                  get().marcarComoLida(maisRecente.id);
                },
              },
            ],
            { cancelable: false }
          );
        }
      }
    } catch (error: unknown) {
      console.error('[NotificacaoStore] Erro ao verificar novas:', error);
    }
  },

  // Limpar notificacao exibida
  limparNovaNotificacao: () => set({ novaNotificacao: null }),

  // Marcar notificacao como lida
  marcarComoLida: async (id: number) => {
    try {
      const { notificacoes, naoLidas } = get();

      // Atualizar otimisticamente
      const notificacaoIndex = notificacoes.findIndex(n => n.id === id);
      if (notificacaoIndex === -1) return;

      const notificacao = notificacoes[notificacaoIndex];
      if (notificacao.lida) return; // Ja esta lida

      const novasNotificacoes = [...notificacoes];
      novasNotificacoes[notificacaoIndex] = {
        ...notificacao,
        lida: true,
        lida_em: new Date().toISOString(),
      };

      set({
        notificacoes: novasNotificacoes,
        naoLidas: Math.max(0, naoLidas - 1),
      });

      // Chamar API
      await apiService.marcarNotificacaoLida(id);
    } catch (error: unknown) {
      // Reverter em caso de erro
      console.error('[NotificacaoStore] Erro ao marcar como lida:', error);

      // Refazer fetch para sincronizar
      get().fetchNotificacoes();
    }
  },

  // Marcar todas como lidas
  marcarTodasComoLidas: async () => {
    try {
      const { notificacoes } = get();
      const naoLidas = notificacoes.filter(n => !n.lida);

      if (naoLidas.length === 0) return;

      // Marcar todas otimisticamente
      const novasNotificacoes = notificacoes.map(n => ({
        ...n,
        lida: true,
        lida_em: n.lida_em || new Date().toISOString(),
      }));

      set({ notificacoes: novasNotificacoes, naoLidas: 0 });

      // Chamar API para cada uma (em paralelo)
      await Promise.all(
        naoLidas.map(n => apiService.marcarNotificacaoLida(n.id).catch(() => {}))
      );
    } catch (error: unknown) {
      console.error('[NotificacaoStore] Erro ao marcar todas como lidas:', error);
      get().fetchNotificacoes();
    }
  },

  // Refresh forcado
  refresh: async () => {
    set({ lastFetch: null });
    await get().fetchNotificacoes();
  },

  // Limpar erro
  clearError: () => set({ error: null }),
}));
