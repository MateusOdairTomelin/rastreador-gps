// Tema Unifique - Identidade Visual
export const Colors = {
  // Unifique Brand Colors
  unifique: {
    cyan: '#3FCFD5',
    cyanDark: '#28B8BE',
    blue: '#00A2FF',
    deepBlue: '#212492',
    violet: '#131E7D',
    darkBg: '#0d1042',
  },

  // Primary (usando cyan Unifique)
  primary: '#3FCFD5',
  primaryDark: '#28B8BE',
  primaryLight: '#00A2FF',

  // Semantic Colors
  success: '#10B981',
  danger: '#EF4444',
  warning: '#F59E0B',
  info: '#00A2FF',

  // Neutral
  text: '#111827',
  textSecondary: '#6B7280',
  textLight: '#9CA3AF',
  textMuted: '#94a3b8',

  // Borders
  border: '#D1D5DB',
  borderLight: '#E5E7EB',

  // Backgrounds
  background: '#F3F4F6',
  surface: '#FFFFFF',
  surfaceHover: '#F9FAFB',

  // Tab/Navigation
  tabInactive: '#9CA3AF',
  tabActive: '#3FCFD5',
};

// Gradientes Unifique
export const Gradients = {
  // Gradiente principal (cyan → azul → violeta)
  primary: ['#3FCFD5', '#00A2FF', '#212492'] as const,

  // Gradiente horizontal
  horizontal: ['#3FCFD5', '#00A2FF'] as const,

  // Gradiente para botões
  button: ['#3FCFD5', '#28B8BE'] as const,

  // Gradiente escuro (para headers)
  dark: ['#212492', '#131E7D'] as const,
};

// Sombras
export const Shadows = {
  small: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  large: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
};

// Espaçamentos
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// Border Radius
export const BorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
};

// Font Sizes
export const FontSizes = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export default {
  Colors,
  Gradients,
  Shadows,
  Spacing,
  BorderRadius,
  FontSizes,
};
