import { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useNotificacaoStore } from '@/stores/notificacao.store';
import { Colors } from '@/constants/theme';

function NotificationBadge({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

export default function MainLayout() {
  const { naoLidas, fetchContagem } = useNotificacaoStore();

  useEffect(() => {
    // Inicializar: buscar notificacoes para definir ultimaNotificacaoId
    const inicializar = async () => {
      await fetchContagem();
      // Buscar notificacoes iniciais sem mostrar alerta
      try {
        const { notificacoes } = useNotificacaoStore.getState();
        if (notificacoes.length === 0) {
          // Primeira carga - buscar para inicializar o ID
          await useNotificacaoStore.getState().fetchNotificacoes(5);
          const state = useNotificacaoStore.getState();
          if (state.notificacoes.length > 0) {
            useNotificacaoStore.setState({
              ultimaNotificacaoId: state.notificacoes[0].id,
            });
          }
        }
      } catch (e) {
        console.log('[MainLayout] Erro ao inicializar notificacoes');
      }
    };

    inicializar();

    // Verificar novas notificacoes a cada 15 segundos
    const interval = setInterval(() => {
      fetchContagem();
    }, 15000);

    return () => clearInterval(interval);
  }, [fetchContagem]);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: '#9CA3AF',
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 1,
          borderTopColor: '#E5E7EB',
          paddingBottom: 5,
          paddingTop: 5,
          height: 60,
        },
        headerStyle: {
          backgroundColor: Colors.unifique.deepBlue,
        },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: 'Inicio',
          headerTitle: 'Unifique Rastreador',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notificacoes"
        options={{
          title: 'Alertas',
          headerTitle: 'Notificacoes',
          tabBarIcon: ({ color, size }) => (
            <View>
              <Ionicons name="notifications" size={size} color={color} />
              <NotificationBadge count={naoLidas} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Escanear',
          headerTitle: 'Vincular Veiculo',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="qr-code" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="perfil"
        options={{
          title: 'Perfil',
          headerTitle: 'Meu Perfil',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: Colors.danger,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
});
