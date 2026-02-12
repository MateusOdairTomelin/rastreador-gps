import { create } from 'zustand';
import { apiService } from '@/services/api.service';
import { Motorista, Organizacao, Veiculo } from '@/types';

interface AuthState {
  // Estado
  isAuthenticated: boolean;
  isLoading: boolean;
  motorista: Motorista | null;
  organizacao: Organizacao | null;
  veiculo: Veiculo | null;
  consentimentosPendentes: boolean;
  tiposPendentes: string[];
  error: string | null;

  // Acoes
  initialize: () => Promise<void>;
  login: (cpf: string) => Promise<{ success: boolean; needsConsent: boolean }>;
  logout: () => Promise<void>;
  refreshData: () => Promise<void>;
  vincular: (imei: string) => Promise<{ success: boolean; message: string }>;
  desvincular: () => Promise<{ success: boolean; message: string }>;
  aceitarTermos: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // Estado inicial
  isAuthenticated: false,
  isLoading: true,
  motorista: null,
  organizacao: null,
  veiculo: null,
  consentimentosPendentes: false,
  tiposPendentes: [],
  error: null,

  // Inicializar - verificar se ha token salvo
  initialize: async () => {
    try {
      set({ isLoading: true, error: null });

      const hasTokens = await apiService.hasTokens();
      if (!hasTokens) {
        set({ isAuthenticated: false, isLoading: false });
        return;
      }

      // Verificar se token ainda e valido
      const response = await apiService.getMe();

      if (response.sucesso) {
        const { motorista } = response;
        set({
          isAuthenticated: true,
          motorista: {
            id: motorista.id,
            nome: motorista.nome,
            cpf_mascarado: motorista.cpf_mascarado,
            telefone_mascarado: motorista.telefone_mascarado,
            email: motorista.email,
            foto_url: motorista.foto_url,
            cnh_categoria: motorista.cnh_categoria,
            cnh_validade: motorista.cnh_validade,
            cnh_status: motorista.cnh_status,
            ativo: motorista.ativo,
          },
          organizacao: motorista.organizacao,
          veiculo: motorista.veiculo_vinculado,
          consentimentosPendentes: motorista.consentimentos_pendentes,
          tiposPendentes: motorista.tipos_pendentes,
          isLoading: false,
        });
      } else {
        await apiService.clearTokens();
        set({ isAuthenticated: false, isLoading: false });
      }
    } catch (error) {
      console.error('Erro ao inicializar:', error);
      await apiService.clearTokens();
      set({ isAuthenticated: false, isLoading: false });
    }
  },

  // Login por CPF
  login: async (cpf: string) => {
    try {
      set({ isLoading: true, error: null });

      const response = await apiService.login(cpf);

      if (response.sucesso) {
        await apiService.saveTokens(response.accessToken, response.refreshToken);

        set({
          isAuthenticated: true,
          motorista: {
            id: response.motorista.id,
            nome: response.motorista.nome,
            foto_url: response.motorista.foto_url,
            cnh_categoria: response.motorista.cnh_categoria,
            cnh_validade: response.motorista.cnh_validade,
            ativo: true,
          },
          organizacao: response.organizacao,
          veiculo: response.veiculo_vinculado,
          consentimentosPendentes: response.consentimentos_pendentes,
          tiposPendentes: response.tipos_pendentes,
          isLoading: false,
        });

        return {
          success: true,
          needsConsent: response.consentimentos_pendentes,
        };
      }

      set({ isLoading: false });
      return { success: false, needsConsent: false };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro ao fazer login';
      set({ error: errorMessage, isLoading: false });
      return { success: false, needsConsent: false };
    }
  },

  // Logout
  logout: async () => {
    try {
      await apiService.logout();
    } catch (error) {
      console.error('Erro ao fazer logout:', error);
    } finally {
      await apiService.clearTokens();
      set({
        isAuthenticated: false,
        motorista: null,
        organizacao: null,
        veiculo: null,
        consentimentosPendentes: false,
        tiposPendentes: [],
      });
    }
  },

  // Atualizar dados do motorista
  refreshData: async () => {
    try {
      set({ isLoading: true });

      const response = await apiService.getMe();

      if (response.sucesso) {
        const { motorista } = response;
        set({
          motorista: {
            id: motorista.id,
            nome: motorista.nome,
            cpf_mascarado: motorista.cpf_mascarado,
            telefone_mascarado: motorista.telefone_mascarado,
            email: motorista.email,
            foto_url: motorista.foto_url,
            cnh_categoria: motorista.cnh_categoria,
            cnh_validade: motorista.cnh_validade,
            cnh_status: motorista.cnh_status,
            ativo: motorista.ativo,
          },
          organizacao: motorista.organizacao,
          veiculo: motorista.veiculo_vinculado,
          consentimentosPendentes: motorista.consentimentos_pendentes,
          tiposPendentes: motorista.tipos_pendentes,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Erro ao atualizar dados:', error);
      set({ isLoading: false });
    }
  },

  // Vincular a veiculo
  vincular: async (imei: string) => {
    try {
      set({ isLoading: true, error: null });

      const response = await apiService.vincular(imei);

      if (response.sucesso) {
        set({
          veiculo: response.veiculo,
          isLoading: false,
        });
        return { success: true, message: response.mensagem };
      }

      set({ isLoading: false });
      return { success: false, message: 'Erro ao vincular' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro ao vincular';
      set({ error: errorMessage, isLoading: false });
      return { success: false, message: errorMessage };
    }
  },

  // Desvincular do veiculo
  desvincular: async () => {
    try {
      set({ isLoading: true, error: null });

      const response = await apiService.desvincular();

      if (response.sucesso) {
        set({
          veiculo: null,
          isLoading: false,
        });
        return { success: true, message: response.mensagem };
      }

      set({ isLoading: false });
      return { success: false, message: 'Erro ao desvincular' };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Erro ao desvincular';
      set({ error: errorMessage, isLoading: false });
      return { success: false, message: errorMessage };
    }
  },

  // Aceitar termos
  aceitarTermos: async () => {
    try {
      const { motorista } = get();
      if (!motorista) return;

      await apiService.registrarConsentimentoInicial(motorista.id);

      set({
        consentimentosPendentes: false,
        tiposPendentes: [],
      });
    } catch (error) {
      console.error('Erro ao aceitar termos:', error);
      throw error;
    }
  },

  // Limpar erro
  clearError: () => set({ error: null }),
}));
