// ========== API Response Types ==========

export interface ApiResponse<T> {
  sucesso: boolean;
  erro?: boolean;
  mensagem?: string;
  [key: string]: unknown;
}

// ========== Auth Types ==========

export interface Motorista {
  id: number;
  nome: string;
  cpf_mascarado?: string;
  telefone_mascarado?: string;
  email?: string;
  foto_url?: string;
  cnh_categoria?: string;
  cnh_validade?: string;
  cnh_status?: 'valida' | 'vence_em_breve' | 'vencida' | 'nao_informada';
  ativo: boolean;
}

export interface Organizacao {
  id: number;
  nome: string;
  slug: string;
  logo_url?: string;
  cor_primaria?: string;
}

export interface Veiculo {
  id: number;
  imei: string;
  placa: string;
  veiculo: string;
  status?: string;
  estado_ignicao?: string;
}

export interface Consentimento {
  tipo: string;
  versao_documento: string;
  data_aceite: string;
}

export interface LoginResponse {
  sucesso: boolean;
  accessToken: string;
  refreshToken: string;
  motorista: {
    id: number;
    nome: string;
    foto_url?: string;
    cnh_validade?: string;
    cnh_categoria?: string;
  };
  organizacao: Organizacao;
  veiculo_vinculado: Veiculo | null;
  consentimentos_pendentes: boolean;
  tipos_pendentes: string[];
}

export interface RefreshResponse {
  sucesso: boolean;
  accessToken: string;
  refreshToken: string;
}

export interface MeResponse {
  sucesso: boolean;
  motorista: Motorista & {
    organizacao: Organizacao;
    veiculo_vinculado: Veiculo | null;
    consentimentos: Consentimento[];
    consentimentos_pendentes: boolean;
    tipos_pendentes: string[];
  };
}

// ========== Vinculacao Types ==========

export interface VincularResponse {
  sucesso: boolean;
  mensagem: string;
  veiculo: Veiculo;
  motorista_desvinculado?: string; // Nome do motorista que foi desvinculado
  vinculo_expira_em?: string; // Data/hora de expiração do vínculo
}

export interface DesvincularResponse {
  sucesso: boolean;
  mensagem: string;
  veiculo_desvinculado: Veiculo;
}

// ========== LGPD Types ==========

export interface VersoesDocumentos {
  privacidade: string;
  termos_uso: string;
}

export interface VerificarConsentimentoResponse {
  sucesso: boolean;
  consentimentosValidos: boolean;
  pendentes: string[];
  versoes: VersoesDocumentos;
}

// ========== Notificacao Types ==========

export type TipoNotificacao = 'excesso_velocidade' | 'geofence_entrada' | 'geofence_saida';
export type SeveridadeNotificacao = 'info' | 'warning' | 'danger';

export interface Notificacao {
  id: number;
  tipo: TipoNotificacao;
  titulo: string;
  mensagem: string;
  severidade: SeveridadeNotificacao;
  lida: boolean;
  lida_em?: string;
  created_at: string;
  veiculo?: {
    placa: string;
    veiculo: string;
  };
  dados_extras?: {
    velocidade?: number;
    limite?: number;
    nome_via?: string;
    latitude?: number;
    longitude?: number;
    [key: string]: unknown;
  };
}

export interface NotificacoesResponse {
  sucesso: boolean;
  notificacoes: Notificacao[];
  total: number;
}

export interface ContagemNotificacoesResponse {
  sucesso: boolean;
  naoLidas: number;
}

export interface MarcarLidaResponse {
  sucesso: boolean;
  mensagem?: string;
}
