/**
 * Serviço de Push Notifications
 * Registra o dispositivo para receber notificações em tempo real
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Configurar como as notificações são exibidas quando o app está em foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

class PushService {
  private expoPushToken: string | null = null;

  /**
   * Registrar dispositivo para push notifications
   * Retorna o Expo Push Token
   */
  async registerForPushNotifications(): Promise<string | null> {
    try {
      // Verificar se é um dispositivo físico
      if (!Device.isDevice) {
        console.log('[Push] Notificações push requerem dispositivo físico');
        return null;
      }

      // Verificar/solicitar permissão
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        console.log('[Push] Permissão de notificação negada');
        return null;
      }

      // Obter o token
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      const token = await Notifications.getExpoPushTokenAsync({
        projectId: projectId || undefined,
      });

      this.expoPushToken = token.data;
      console.log('[Push] Token registrado:', this.expoPushToken);

      // Configurar canal de notificação para Android
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('alertas', {
          name: 'Alertas de Velocidade',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF0000',
          sound: 'default',
        });

        await Notifications.setNotificationChannelAsync('geofence', {
          name: 'Alertas de Área',
          importance: Notifications.AndroidImportance.DEFAULT,
          sound: 'default',
        });
      }

      return this.expoPushToken;
    } catch (error) {
      console.error('[Push] Erro ao registrar:', error);
      return null;
    }
  }

  /**
   * Obter o token atual
   */
  getToken(): string | null {
    return this.expoPushToken;
  }

  /**
   * Adicionar listener para notificações recebidas (app em foreground)
   */
  addNotificationReceivedListener(
    callback: (notification: Notifications.Notification) => void
  ) {
    return Notifications.addNotificationReceivedListener(callback);
  }

  /**
   * Adicionar listener para quando usuário interage com notificação
   */
  addNotificationResponseListener(
    callback: (response: Notifications.NotificationResponse) => void
  ) {
    return Notifications.addNotificationResponseReceivedListener(callback);
  }

  /**
   * Remover todos os listeners
   */
  removeAllListeners() {
    Notifications.removeAllNotificationListeners();
  }

  /**
   * Limpar badge de notificações
   */
  async clearBadge() {
    await Notifications.setBadgeCountAsync(0);
  }

  /**
   * Enviar notificação local (para testes)
   */
  async sendLocalNotification(title: string, body: string, data?: object) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        data: data || {},
        sound: 'default',
      },
      trigger: null, // Imediato
    });
  }
}

export const pushService = new PushService();
