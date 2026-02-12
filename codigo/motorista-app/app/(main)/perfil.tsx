import { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  Image,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAuthStore } from '@/stores/auth.store';
import { getCnhStatus, formatDate } from '@/utils';
import { Colors } from '@/constants/theme';

export default function PerfilScreen() {
  const router = useRouter();
  const { motorista, organizacao, logout, refreshData, isLoading } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshData();
    setRefreshing(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [refreshData]);

  const cnhInfo = motorista?.cnh_validade
    ? getCnhStatus(motorista.cnh_validade)
    : getCnhStatus(null);

  const handleLogout = useCallback(() => {
    Alert.alert(
      'Sair',
      'Deseja realmente sair do aplicativo?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sair',
          style: 'destructive',
          onPress: async () => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  }, [logout, router]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[Colors.primary]}
          tintColor={Colors.primary}
        />
      }
    >
      {/* Foto e Nome */}
      <View style={styles.header}>
        <View style={styles.avatarContainer}>
          {motorista?.foto_url ? (
            <Image source={{ uri: motorista.foto_url }} style={styles.avatar} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Ionicons name="person" size={48} color="#9CA3AF" />
            </View>
          )}
        </View>
        <Text style={styles.name}>{motorista?.nome || 'Motorista'}</Text>
        <Text style={styles.organization}>{organizacao?.nome}</Text>
      </View>

      {/* Informacoes Pessoais */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Informacoes Pessoais</Text>

        <View style={styles.infoCard}>
          <View style={styles.infoRow}>
            <View style={styles.infoIconContainer}>
              <Ionicons name="card-outline" size={20} color="#6B7280" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>CPF</Text>
              <Text style={styles.infoValue}>{motorista?.cpf_mascarado || '***.***.***-**'}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoIconContainer}>
              <Ionicons name="mail-outline" size={20} color="#6B7280" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>E-mail</Text>
              <Text style={styles.infoValue}>
                {motorista?.email || 'Nao informado'}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <View style={styles.infoIconContainer}>
              <Ionicons name="call-outline" size={20} color="#6B7280" />
            </View>
            <View style={styles.infoContent}>
              <Text style={styles.infoLabel}>Telefone</Text>
              <Text style={styles.infoValue}>
                {motorista?.telefone_mascarado || 'Nao informado'}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/* CNH */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Carteira de Habilitacao</Text>

        <View style={styles.infoCard}>
          <View style={styles.cnhHeader}>
            <View>
              <Text style={styles.cnhCategoria}>
                Categoria: {motorista?.cnh_categoria || '--'}
              </Text>
              <Text style={styles.cnhValidade}>
                {motorista?.cnh_validade
                  ? `Validade: ${formatDate(motorista.cnh_validade)}`
                  : 'Validade nao informada'}
              </Text>
            </View>
            <View style={[styles.cnhBadge, { backgroundColor: cnhInfo.color + '20' }]}>
              <Text style={[styles.cnhBadgeText, { color: cnhInfo.color }]}>
                {cnhInfo.label}
              </Text>
            </View>
          </View>

          {cnhInfo.status === 'vencida' && (
            <View style={styles.cnhWarning}>
              <Ionicons name="warning" size={20} color="#EF4444" />
              <Text style={styles.cnhWarningText}>
                Sua CNH esta vencida. Procure renovar o mais rapido possivel.
              </Text>
            </View>
          )}

          {cnhInfo.status === 'vence_em_breve' && (
            <View style={[styles.cnhWarning, { backgroundColor: '#FEF3C7' }]}>
              <Ionicons name="time-outline" size={20} color="#F59E0B" />
              <Text style={[styles.cnhWarningText, { color: '#92400E' }]}>
                Sua CNH vence em {cnhInfo.diasRestantes} dias. Providencie a renovacao.
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Acoes */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Conta</Text>

        <TouchableOpacity style={styles.actionButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={24} color="#EF4444" />
          <Text style={styles.actionButtonText}>Sair do aplicativo</Text>
          <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
        </TouchableOpacity>
      </View>

      {/* Versao */}
      <Text style={styles.version}>Versao 1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    alignItems: 'center',
    marginBottom: 24,
  },
  avatarContainer: {
    marginBottom: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 3,
    borderColor: Colors.primary,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  organization: {
    fontSize: 14,
    color: '#6B7280',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  infoIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  infoContent: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 12,
    color: '#9CA3AF',
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 16,
    color: '#111827',
  },
  divider: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginHorizontal: 16,
  },
  cnhHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  cnhCategoria: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  cnhValidade: {
    fontSize: 14,
    color: '#6B7280',
  },
  cnhBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  cnhBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  cnhWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 16,
  },
  cnhWarningText: {
    flex: 1,
    fontSize: 13,
    color: '#991B1B',
    marginLeft: 10,
    lineHeight: 18,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  actionButtonText: {
    flex: 1,
    fontSize: 16,
    color: '#EF4444',
    marginLeft: 12,
  },
  version: {
    textAlign: 'center',
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 8,
  },
});
