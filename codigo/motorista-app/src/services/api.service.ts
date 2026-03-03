import axios, { AxiosInstance, AxiosError } from 'axios';
import * as SecureStore from 'expo-secure-store';
import {
  LoginResponse,
  RefreshResponse,
  MeResponse,
  VincularResponse,
  DesvincularResponse,
  VerificarConsentimentoResponse,
  NotificacoesResponse,
  ContagemNotificacoesResponse,
  MarcarLidaResponse,
} from '@/types';
import { pushService } from './push.service';

// URL base da API - ajustar para producao
const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://192.168.1.100:8000/api';

// Chaves do SecureStore
const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';

class ApiService {
  private api: AxiosInstance;
  private isRefreshing = false;
  private refreshSubscribers: ((token: string) => void)[] = [];

  constructor() {
    this.api = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Interceptor para adicionar token em todas as requisicoes
    this.api.interceptors.request.use(
      async (config) => {
        const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Interceptor para refresh token automatico
    this.api.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as typeof error.config & { _retry?: boolean };

        if (error.response?.status === 401 && !originalRequest._retry) {
          originalRequest._retry = true;

          if (this.isRefreshing) {
            // Aguardar refresh em andamento
            return new Promise((resolve) => {
              this.refreshSubscribers.push((token: string) => {
                if (originalRequest.headers) {
                  originalRequest.headers.Authorization = `Bearer ${token}`;
                }
                resolve(this.api(originalRequest));
              });
            });
          }

          this.isRefreshing = true;

          try {
            const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
            if (!refreshToken) {
              throw new Error('No refresh token');
            }

            const { data } = await axios.post<RefreshResponse>(
              `${API_BASE_URL}/auth-motorista/refresh`,
              { refresh_token: refreshToken }
            );

            await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, data.accessToken);
            await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, data.refreshToken);

            // Notificar subscribers
            this.refreshSubscribers.forEach((callback) => callback(data.accessToken));
            this.refreshSubscribers = [];

            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${data.accessToken}`;
            }
            return this.api(originalRequest);
          } catch (refreshError) {
            // Refresh falhou - limpar tokens
            await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
            await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
            this.refreshSubscribers = [];
            throw refreshError;
          } finally {
            this.isRefreshing = false;
          }
        }

        return Promise.reject(error);
      }
    );
  }

  // ========== Auth ==========

  async login(cpf: string, deviceInfo?: string): Promise<LoginResponse> {
    const { data } = await this.api.post<LoginResponse>('/auth-motorista/login', {
      cpf,
      device_info: deviceInfo,
    });
    return data;
  }

  /**
   * Registra o push token no servidor apos login bem-sucedido
   * Deve ser chamado apos salvar os tokens de autenticacao
   */
  async registerPushToken(): Promise<void> {
    try {
      const pushToken = await pushService.registerForPushNotifications();
      if (pushToken) {
        await this.api.post('/auth-motorista/push-token', {
          push_token: pushToken,
        });
        console.log('[API] Push token registrado no servidor');
      }
    } catch (error) {
      console.warn('[API] Erro ao registrar push token:', error);
      // Nao lanca erro - push e opcional
    }
  }

  /**
   * Remove o push token do servidor (chamado no logout)
   */
  async unregisterPushToken(): Promise<void> {
    try {
      await this.api.delete('/auth-motorista/push-token');
      console.log('[API] Push token removido do servidor');
    } catch (error) {
      console.warn('[API] Erro ao remover push token:', error);
      // Nao lanca erro - continua com logout
    }
  }

  async logout(): Promise<void> {
    // Remover push token antes de fazer logout
    await this.unregisterPushToken();

    const refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
    if (refreshToken) {
      await this.api.post('/auth-motorista/logout', { refresh_token: refreshToken });
    }

    // Limpar listeners de notificacao
    pushService.removeAllListeners();
  }

  async getMe(): Promise<MeResponse> {
    const { data } = await this.api.get<MeResponse>('/auth-motorista/me');
    return data;
  }

  // ========== Vinculacao ==========

  async vincular(imei: string, duracaoHoras?: number): Promise<VincularResponse> {
    const payload: { imei: string; duracaoHoras?: number } = { imei };
    if (duracaoHoras) {
      payload.duracaoHoras = duracaoHoras;
    }
    const { data } = await this.api.post<VincularResponse>('/auth-motorista/vincular', payload);
    return data;
  }

  async desvincular(): Promise<DesvincularResponse> {
    const { data } = await this.api.post<DesvincularResponse>('/auth-motorista/desvincular');
    return data;
  }

  // ========== LGPD ==========

  async verificarConsentimentos(motoristaId: number): Promise<VerificarConsentimentoResponse> {
    const { data } = await this.api.get<VerificarConsentimentoResponse>(
      `/lgpd/motorista/verificar/${motoristaId}`
    );
    return data;
  }

  async registrarConsentimentoInicial(motoristaId: number): Promise<void> {
    await this.api.post('/lgpd/motorista/consentimento/inicial', {
      motorista_id: motoristaId,
    });
  }

  async getVersoes(): Promise<{ versoes: { privacidade: string; termos_uso: string } }> {
    const { data } = await this.api.get('/lgpd/versoes');
    return data;
  }

  // ========== Notificacoes ==========

  async getNotificacoes(limit = 20, naoLidas = false): Promise<NotificacoesResponse> {
    const { data } = await this.api.get<NotificacoesResponse>('/auth-motorista/notificacoes', {
      params: { limit, naoLidas: naoLidas.toString() },
    });
    return data;
  }

  async getContagemNotificacoes(): Promise<ContagemNotificacoesResponse> {
    const { data } = await this.api.get<ContagemNotificacoesResponse>(
      '/auth-motorista/notificacoes/contagem'
    );
    return data;
  }

  async marcarNotificacaoLida(id: number): Promise<MarcarLidaResponse> {
    const { data } = await this.api.post<MarcarLidaResponse>(
      `/auth-motorista/notificacoes/${id}/lida`
    );
    return data;
  }

  // ========== Storage Helpers ==========

  async saveTokens(accessToken: string, refreshToken: string): Promise<void> {
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  }

  async clearTokens(): Promise<void> {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }

  async hasTokens(): Promise<boolean> {
    const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
    return !!token;
  }
}

export const apiService = new ApiService();
