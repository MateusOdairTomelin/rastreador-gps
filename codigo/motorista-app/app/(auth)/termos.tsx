import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/auth.store';
import { Colors } from '@/constants/theme';

// URLs dos documentos (ajustar para producao)
const BASE_URL = process.env.EXPO_PUBLIC_API_URL?.replace('/api', '') || 'http://192.168.1.100:8000';
const PRIVACY_URL = `${BASE_URL}/politica-privacidade.html`;
const TERMS_URL = `${BASE_URL}/termos-uso.html`;

type DocumentType = 'privacy' | 'terms';

export default function TermosScreen() {
  const router = useRouter();
  const { aceitarTermos, logout, isLoading } = useAuthStore();

  const [activeDocument, setActiveDocument] = useState<DocumentType>('privacy');
  const [privacyRead, setPrivacyRead] = useState(false);
  const [termsRead, setTermsRead] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleWebViewLoad = useCallback(() => {
    // Marcar documento como lido quando a webview carrega
    if (activeDocument === 'privacy') {
      setPrivacyRead(true);
    } else {
      setTermsRead(true);
    }
  }, [activeDocument]);

  const handleAccept = useCallback(async () => {
    if (!privacyAccepted || !termsAccepted) {
      Alert.alert(
        'Atencao',
        'Voce precisa aceitar a Politica de Privacidade e os Termos de Uso para continuar.'
      );
      return;
    }

    try {
      setIsSubmitting(true);
      await aceitarTermos();
      router.replace('/(main)/home');
    } catch (error) {
      Alert.alert('Erro', 'Nao foi possivel registrar o consentimento. Tente novamente.');
    } finally {
      setIsSubmitting(false);
    }
  }, [privacyAccepted, termsAccepted, aceitarTermos, router]);

  const handleDecline = useCallback(() => {
    Alert.alert(
      'Recusar termos',
      'Se voce nao aceitar os termos, nao podera usar o aplicativo. Deseja fazer logout?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Fazer logout',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  }, [logout, router]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Termos e Condicoes</Text>
        <Text style={styles.headerSubtitle}>
          Leia e aceite os documentos para continuar
        </Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeDocument === 'privacy' && styles.tabActive]}
          onPress={() => setActiveDocument('privacy')}
        >
          <Text
            style={[styles.tabText, activeDocument === 'privacy' && styles.tabTextActive]}
          >
            Privacidade
          </Text>
          {privacyRead && (
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={activeDocument === 'privacy' ? Colors.primary : Colors.success}
              style={styles.tabIcon}
            />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeDocument === 'terms' && styles.tabActive]}
          onPress={() => setActiveDocument('terms')}
        >
          <Text
            style={[styles.tabText, activeDocument === 'terms' && styles.tabTextActive]}
          >
            Termos de Uso
          </Text>
          {termsRead && (
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={activeDocument === 'terms' ? Colors.primary : Colors.success}
              style={styles.tabIcon}
            />
          )}
        </TouchableOpacity>
      </View>

      {/* WebView */}
      <View style={styles.webviewContainer}>
        <WebView
          source={{ uri: activeDocument === 'privacy' ? PRIVACY_URL : TERMS_URL }}
          style={styles.webview}
          onLoad={handleWebViewLoad}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={Colors.primary} />
            </View>
          )}
        />
      </View>

      {/* Checkboxes */}
      <View style={styles.checkboxContainer}>
        <TouchableOpacity
          style={styles.checkbox}
          onPress={() => setPrivacyAccepted(!privacyAccepted)}
        >
          <View style={[styles.checkboxBox, privacyAccepted && styles.checkboxChecked]}>
            {privacyAccepted && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
          </View>
          <Text style={styles.checkboxText}>
            Li e aceito a{' '}
            <Text style={styles.checkboxLink}>Politica de Privacidade</Text>
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.checkbox}
          onPress={() => setTermsAccepted(!termsAccepted)}
        >
          <View style={[styles.checkboxBox, termsAccepted && styles.checkboxChecked]}>
            {termsAccepted && <Ionicons name="checkmark" size={16} color="#FFFFFF" />}
          </View>
          <Text style={styles.checkboxText}>
            Li e aceito os{' '}
            <Text style={styles.checkboxLink}>Termos de Uso</Text>
          </Text>
        </TouchableOpacity>
      </View>

      {/* Buttons */}
      <View style={styles.buttonsContainer}>
        <TouchableOpacity
          style={styles.declineButton}
          onPress={handleDecline}
          disabled={isSubmitting}
        >
          <Text style={styles.declineButtonText}>Recusar</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.acceptButton,
            (!privacyAccepted || !termsAccepted) && styles.acceptButtonDisabled,
          ]}
          onPress={handleAccept}
          disabled={!privacyAccepted || !termsAccepted || isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.acceptButtonText}>Concordar e Continuar</Text>
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#6B7280',
  },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    marginHorizontal: 4,
  },
  tabActive: {
    backgroundColor: '#E0F7F8',
    borderWidth: 1,
    borderColor: Colors.primary,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#6B7280',
  },
  tabTextActive: {
    color: Colors.primary,
  },
  tabIcon: {
    marginLeft: 6,
  },
  webviewContainer: {
    flex: 1,
    marginHorizontal: 20,
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  webview: {
    flex: 1,
  },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  checkboxContainer: {
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  checkbox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  checkboxBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    marginRight: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkboxChecked: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  checkboxText: {
    flex: 1,
    fontSize: 14,
    color: '#374151',
  },
  checkboxLink: {
    color: Colors.primary,
    fontWeight: '500',
  },
  buttonsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 12,
  },
  declineButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
  },
  declineButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6B7280',
  },
  acceptButton: {
    flex: 2,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: Colors.primary,
    alignItems: 'center',
  },
  acceptButtonDisabled: {
    backgroundColor: '#93C5FD',
  },
  acceptButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
