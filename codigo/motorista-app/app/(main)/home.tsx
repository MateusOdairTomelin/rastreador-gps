import { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useAuthStore } from '@/stores/auth.store';
import { Colors, Gradients } from '@/constants/theme';

export default function HomeScreen() {
  const router = useRouter();
  const { motorista, organizacao, veiculo, refreshData, desvincular, isLoading } = useAuthStore();

  const [refreshing, setRefreshing] = useState(false);
  const [isDesvinculating, setIsDesvinculating] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshData();
    setRefreshing(false);
  }, [refreshData]);

  const handleDesvincular = useCallback(async () => {
    Alert.alert(
      'Desvincular Veiculo',
      `Deseja desvincular do veiculo ${veiculo?.placa}?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Desvincular',
          style: 'destructive',
          onPress: async () => {
            setIsDesvinculating(true);
            const result = await desvincular();

            if (result.success) {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert('Sucesso', result.message);
            } else {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              Alert.alert('Erro', result.message);
            }
            setIsDesvinculating(false);
          },
        },
      ]
    );
  }, [veiculo, desvincular]);

  const handleScanQR = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/(main)/scan');
  }, [router]);

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
      {/* Saudacao */}
      <View style={styles.greetingContainer}>
        <Text style={styles.greeting}>Ola,</Text>
        <Text style={styles.name}>{motorista?.nome || 'Motorista'}</Text>
        <Text style={styles.organization}>{organizacao?.nome}</Text>
      </View>

      {/* Card do Veiculo */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Ionicons name="car" size={24} color={Colors.primary} />
          <Text style={styles.cardTitle}>Veiculo Vinculado</Text>
        </View>

        {veiculo ? (
          // Veiculo vinculado
          <View>
            <View style={styles.vehicleInfo}>
              <View style={styles.plateContainer}>
                <Text style={styles.plateLabel}>Placa</Text>
                <Text style={styles.plateValue}>{veiculo.placa}</Text>
              </View>

              <View style={styles.vehicleDetails}>
                <Text style={styles.vehicleModel}>{veiculo.veiculo}</Text>
                <View style={styles.statusBadge}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: veiculo.status === 'online' ? Colors.success : '#9CA3AF' },
                    ]}
                  />
                  <Text style={styles.statusText}>
                    {veiculo.status === 'online' ? 'Online' : 'Offline'}
                  </Text>
                </View>
              </View>
            </View>

            <TouchableOpacity
              style={styles.unlinkButton}
              onPress={handleDesvincular}
              disabled={isDesvinculating}
            >
              {isDesvinculating ? (
                <ActivityIndicator size="small" color={Colors.danger} />
              ) : (
                <>
                  <Ionicons name="unlink" size={20} color={Colors.danger} />
                  <Text style={styles.unlinkButtonText}>Desvincular</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        ) : (
          // Sem veiculo vinculado
          <View style={styles.noVehicle}>
            <Ionicons name="car-outline" size={48} color="#D1D5DB" />
            <Text style={styles.noVehicleText}>
              Voce ainda nao esta vinculado a nenhum veiculo
            </Text>
            <TouchableOpacity onPress={handleScanQR} activeOpacity={0.8}>
              <LinearGradient
                colors={Gradients.button}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.scanButton}
              >
                <Ionicons name="qr-code" size={20} color="#FFFFFF" />
                <Text style={styles.scanButtonText}>Escanear QR Code</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Instrucoes */}
      <View style={styles.instructionsCard}>
        <Text style={styles.instructionsTitle}>Como vincular um veiculo</Text>

        <View style={styles.instruction}>
          <View style={styles.instructionNumber}>
            <Text style={styles.instructionNumberText}>1</Text>
          </View>
          <Text style={styles.instructionText}>
            Localize o QR Code no rastreador do veiculo
          </Text>
        </View>

        <View style={styles.instruction}>
          <View style={styles.instructionNumber}>
            <Text style={styles.instructionNumberText}>2</Text>
          </View>
          <Text style={styles.instructionText}>
            Toque em "Escanear" na aba inferior
          </Text>
        </View>

        <View style={styles.instruction}>
          <View style={styles.instructionNumber}>
            <Text style={styles.instructionNumberText}>3</Text>
          </View>
          <Text style={styles.instructionText}>
            Aponte a camera para o QR Code
          </Text>
        </View>

        <View style={styles.instruction}>
          <View style={styles.instructionNumber}>
            <Text style={styles.instructionNumberText}>4</Text>
          </View>
          <Text style={styles.instructionText}>
            Confirme a vinculacao na tela
          </Text>
        </View>
      </View>
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
  },
  greetingContainer: {
    marginBottom: 20,
  },
  greeting: {
    fontSize: 16,
    color: '#6B7280',
  },
  name: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
  },
  organization: {
    fontSize: 14,
    color: '#9CA3AF',
    marginTop: 4,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginLeft: 10,
  },
  vehicleInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  plateContainer: {
    backgroundColor: '#F3F4F6',
    borderRadius: 12,
    padding: 12,
    marginRight: 16,
    alignItems: 'center',
    minWidth: 100,
  },
  plateLabel: {
    fontSize: 10,
    color: '#9CA3AF',
    marginBottom: 4,
  },
  plateValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
    letterSpacing: 1,
  },
  vehicleDetails: {
    flex: 1,
  },
  vehicleModel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 6,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 14,
    color: '#6B7280',
  },
  unlinkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  unlinkButtonText: {
    color: Colors.danger,
    fontSize: 16,
    fontWeight: '500',
    marginLeft: 8,
  },
  noVehicle: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  noVehicleText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 12,
    marginBottom: 20,
    lineHeight: 20,
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  scanButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  instructionsCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  instructionsTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  instruction: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  instructionNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: `${Colors.primary}20`,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  instructionNumberText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.primary,
  },
  instructionText: {
    flex: 1,
    fontSize: 14,
    color: '#6B7280',
    lineHeight: 20,
  },
});
