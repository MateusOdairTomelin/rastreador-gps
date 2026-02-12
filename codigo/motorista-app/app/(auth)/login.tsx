import { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  Image,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/auth.store';
import { formatCPF, validateCPF, cleanCPF } from '@/utils';
import { Colors, Gradients } from '@/constants/theme';

export default function LoginScreen() {
  const router = useRouter();
  const { login, isLoading, error, clearError } = useAuthStore();

  const [cpf, setCpf] = useState('');
  const [cpfError, setCpfError] = useState('');

  const handleCpfChange = useCallback((text: string) => {
    clearError();
    setCpfError('');

    // Limitar a 14 caracteres (com formatacao)
    const formatted = formatCPF(text);
    if (formatted.length <= 14) {
      setCpf(formatted);
    }
  }, [clearError]);

  const handleLogin = useCallback(async () => {
    clearError();
    setCpfError('');

    const cpfLimpo = cleanCPF(cpf);

    // Validar tamanho
    if (cpfLimpo.length !== 11) {
      setCpfError('CPF deve ter 11 digitos');
      return;
    }

    // Validar digitos verificadores
    if (!validateCPF(cpfLimpo)) {
      setCpfError('CPF invalido');
      return;
    }

    const result = await login(cpfLimpo);

    if (result.success) {
      if (result.needsConsent) {
        // Redirecionar para tela de termos
        router.replace('/(auth)/termos');
      } else {
        // Redirecionar para home
        router.replace('/(main)/home');
      }
    } else if (error) {
      Alert.alert('Erro', error);
    }
  }, [cpf, login, router, error, clearError]);

  const openPrivacyPolicy = useCallback(() => {
    // URL da politica de privacidade
    const url = 'https://seu-dominio.com/politica-privacidade.html';
    Linking.openURL(url).catch(() => {
      Alert.alert('Erro', 'Nao foi possivel abrir o link');
    });
  }, []);

  const openTermsOfUse = useCallback(() => {
    // URL dos termos de uso
    const url = 'https://seu-dominio.com/termos-uso.html';
    Linking.openURL(url).catch(() => {
      Alert.alert('Erro', 'Nao foi possivel abrir o link');
    });
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.content}>
        {/* Logo com Gradiente Unifique */}
        <View style={styles.logoContainer}>
          <LinearGradient
            colors={Gradients.primary}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.logoGradient}
          >
            <View style={styles.logoInner}>
              <Text style={styles.logoText}>Unifique</Text>
              <Text style={styles.logoSubtext}>Rastreador</Text>
            </View>
          </LinearGradient>
        </View>

        {/* Titulo */}
        <Text style={styles.title}>Bem-vindo!</Text>
        <Text style={styles.subtitle}>
          Digite seu CPF para acessar o aplicativo
        </Text>

        {/* Input CPF */}
        <View style={styles.inputContainer}>
          <Text style={styles.label}>CPF</Text>
          <TextInput
            style={[styles.input, (cpfError || error) && styles.inputError]}
            placeholder="000.000.000-00"
            placeholderTextColor="#9CA3AF"
            value={cpf}
            onChangeText={handleCpfChange}
            keyboardType="numeric"
            maxLength={14}
            autoFocus
          />
          {cpfError ? (
            <Text style={styles.errorText}>{cpfError}</Text>
          ) : error ? (
            <Text style={styles.errorText}>{error}</Text>
          ) : null}
        </View>

        {/* Botao Entrar com Gradiente */}
        <TouchableOpacity
          onPress={handleLogin}
          disabled={isLoading}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={isLoading ? ['#9CA3AF', '#9CA3AF'] : Gradients.button}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.button}
          >
            {isLoading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.buttonText}>Entrar</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        {/* Info */}
        <Text style={styles.infoText}>
          Seu CPF deve estar cadastrado pelo administrador da frota.
          Em caso de duvidas, entre em contato com seu supervisor.
        </Text>

        {/* Links */}
        <View style={styles.linksContainer}>
          <TouchableOpacity onPress={openPrivacyPolicy}>
            <Text style={styles.linkText}>Politica de Privacidade</Text>
          </TouchableOpacity>
          <Text style={styles.linkSeparator}>|</Text>
          <TouchableOpacity onPress={openTermsOfUse}>
            <Text style={styles.linkText}>Termos de Uso</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logoGradient: {
    width: 130,
    height: 130,
    borderRadius: 65,
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoInner: {
    width: 122,
    height: 122,
    borderRadius: 61,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoText: {
    color: Colors.unifique.cyan,
    fontSize: 22,
    fontWeight: 'bold',
  },
  logoSubtext: {
    color: Colors.unifique.deepBlue,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#111827',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 32,
  },
  inputContainer: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    color: '#111827',
    backgroundColor: '#F9FAFB',
    textAlign: 'center',
    letterSpacing: 2,
  },
  inputError: {
    borderColor: Colors.danger,
    backgroundColor: '#FEF2F2',
  },
  errorText: {
    color: Colors.danger,
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  button: {
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 24,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  infoText: {
    fontSize: 14,
    color: '#9CA3AF',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 32,
  },
  linksContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  linkText: {
    fontSize: 14,
    color: Colors.primary,
  },
  linkSeparator: {
    marginHorizontal: 12,
    color: '#D1D5DB',
  },
});
