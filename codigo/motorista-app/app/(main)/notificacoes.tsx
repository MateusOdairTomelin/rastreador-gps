import { useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useNotificacaoStore } from '@/stores/notificacao.store';
import { Notificacao, TipoNotificacao, SeveridadeNotificacao } from '@/types';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Colors } from '@/constants/theme';

const TIPO_CONFIG: Record<
  TipoNotificacao,
  { icon: keyof typeof Ionicons.glyphMap; label: string }
> = {
  excesso_velocidade: { icon: 'speedometer', label: 'Excesso de Velocidade' },
  geofence_entrada: { icon: 'enter', label: 'Entrada em Area' },
  geofence_saida: { icon: 'exit', label: 'Saida de Area' },
};

const SEVERIDADE_CONFIG: Record<
  SeveridadeNotificacao,
  { color: string; bgColor: string }
> = {
  info: { color: Colors.primary, bgColor: '#E0F7F8' },
  warning: { color: '#F59E0B', bgColor: '#FFFBEB' },
  danger: { color: '#EF4444', bgColor: '#FEF2F2' },
};

function formatTempo(dateString: string): string {
  try {
    return formatDistanceToNow(new Date(dateString), {
      addSuffix: true,
      locale: ptBR,
    });
  } catch {
    return '';
  }
}

interface NotificacaoItemProps {
  item: Notificacao;
  onPress: (id: number) => void;
}

function NotificacaoItem({ item, onPress }: NotificacaoItemProps) {
  const tipoConfig = TIPO_CONFIG[item.tipo] || {
    icon: 'alert-circle',
    label: 'Alerta',
  };
  const severidadeConfig = SEVERIDADE_CONFIG[item.severidade] || SEVERIDADE_CONFIG.info;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress(item.id);
  };

  return (
    <TouchableOpacity
      style={[
        styles.notificacaoItem,
        !item.lida && styles.notificacaoNaoLida,
        { borderLeftColor: severidadeConfig.color },
      ]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <View
        style={[styles.iconContainer, { backgroundColor: severidadeConfig.bgColor }]}
      >
        <Ionicons
          name={tipoConfig.icon}
          size={24}
          color={severidadeConfig.color}
        />
      </View>

      <View style={styles.conteudo}>
        <View style={styles.header}>
          <Text style={styles.titulo} numberOfLines={1}>
            {item.titulo}
          </Text>
          {!item.lida && <View style={styles.pontinho} />}
        </View>

        <Text style={styles.mensagem} numberOfLines={2}>
          {item.mensagem}
        </Text>

        <View style={styles.footer}>
          {item.veiculo && (
            <View style={styles.veiculoTag}>
              <Ionicons name="car" size={12} color="#6B7280" />
              <Text style={styles.veiculoText}>{item.veiculo.placa}</Text>
            </View>
          )}
          <Text style={styles.tempo}>{formatTempo(item.created_at)}</Text>
        </View>

        {item.tipo === 'excesso_velocidade' && item.dados_extras && (
          <View style={styles.detalhesVelocidade}>
            <Text style={styles.detalhesText}>
              Velocidade: {item.dados_extras.velocidade} km/h
              {item.dados_extras.limite && ` (Limite: ${item.dados_extras.limite} km/h)`}
            </Text>
            {item.dados_extras.nome_via && (
              <Text style={styles.detalhesText} numberOfLines={1}>
                Via: {item.dados_extras.nome_via}
              </Text>
            )}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyContainer}>
      <Ionicons name="notifications-off-outline" size={64} color="#D1D5DB" />
      <Text style={styles.emptyTitle}>Nenhuma notificacao</Text>
      <Text style={styles.emptySubtitle}>
        Voce sera alertado sobre excesso de velocidade e eventos de geofence
      </Text>
    </View>
  );
}

export default function NotificacoesScreen() {
  const {
    notificacoes,
    naoLidas,
    isLoading,
    fetchNotificacoes,
    marcarComoLida,
    marcarTodasComoLidas,
    refresh,
  } = useNotificacaoStore();

  useEffect(() => {
    fetchNotificacoes();
  }, [fetchNotificacoes]);

  const handleRefresh = useCallback(async () => {
    await refresh();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [refresh]);

  const handleNotificacaoPress = useCallback(
    (id: number) => {
      marcarComoLida(id);
    },
    [marcarComoLida]
  );

  const handleMarcarTodas = useCallback(async () => {
    await marcarTodasComoLidas();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [marcarTodasComoLidas]);

  const renderItem = useCallback(
    ({ item }: { item: Notificacao }) => (
      <NotificacaoItem item={item} onPress={handleNotificacaoPress} />
    ),
    [handleNotificacaoPress]
  );

  return (
    <View style={styles.container}>
      {naoLidas > 0 && (
        <TouchableOpacity
          style={styles.marcarTodasButton}
          onPress={handleMarcarTodas}
        >
          <Ionicons name="checkmark-done" size={20} color={Colors.primary} />
          <Text style={styles.marcarTodasText}>
            Marcar todas como lidas ({naoLidas})
          </Text>
        </TouchableOpacity>
      )}

      {isLoading && notificacoes.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Carregando notificacoes...</Text>
        </View>
      ) : (
        <FlatList
          data={notificacoes}
          renderItem={renderItem}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={
            notificacoes.length === 0 ? styles.listEmpty : styles.listContent
          }
          ListEmptyComponent={EmptyState}
          refreshControl={
            <RefreshControl
              refreshing={isLoading}
              onRefresh={handleRefresh}
              colors={[Colors.primary]}
              tintColor={Colors.primary}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  listEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  marcarTodasButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  marcarTodasText: {
    color: Colors.primary,
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  notificacaoItem: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  notificacaoNaoLida: {
    backgroundColor: '#FEFEFE',
    shadowOpacity: 0.1,
    elevation: 3,
  },
  iconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  conteudo: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  titulo: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: '#111827',
  },
  pontinho: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
    marginLeft: 8,
  },
  mensagem: {
    fontSize: 14,
    color: '#4B5563',
    lineHeight: 20,
    marginBottom: 8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  veiculoTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F3F4F6',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  veiculoText: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 4,
    fontWeight: '500',
  },
  tempo: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  detalhesVelocidade: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  detalhesText: {
    fontSize: 12,
    color: '#6B7280',
    marginBottom: 2,
  },
  emptyContainer: {
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
});
