# App Motorista - Rastreador GPS

Aplicativo mobile para motoristas da frota, desenvolvido com React Native e Expo.

## Funcionalidades

- **Login por CPF**: Autenticacao segura com CPF e senha
- **Identificacao no Veiculo**: Leitura de QRCode/NFC para vincular ao rastreador
- **Painel do Motorista**: Visualizacao de dados da viagem atual
- **Notificacoes Push**: Alertas de excesso de velocidade, cercas, etc
- **Historico de Viagens**: Consulta de viagens anteriores
- **Perfil**: Atualizacao de dados e foto

## Screenshots

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│     LOGIN       │  │      HOME       │  │      SCAN       │
│                 │  │                 │  │                 │
│   [CPF Input]   │  │  Bem-vindo,     │  │    [Camera]     │
│   [Senha]       │  │  Motorista!     │  │                 │
│                 │  │                 │  │  Aponte para    │
│   [ENTRAR]      │  │  Veiculo: ---   │  │  o QRCode do    │
│                 │  │  Status: Livre  │  │  rastreador     │
│                 │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## Tecnologias

- **React Native** 0.73+
- **Expo** SDK 50
- **Expo Router** para navegacao
- **Zustand** para gerenciamento de estado
- **Axios** para requisicoes HTTP
- **Expo Camera** para leitura de QRCode
- **Expo Notifications** para push

## Estrutura

```
motorista-app/
├── app/                    # Telas (Expo Router)
│   ├── (auth)/            # Telas de autenticacao
│   │   ├── login.tsx      # Tela de login
│   │   └── termos.tsx     # Termos de uso
│   ├── (main)/            # Telas principais
│   │   ├── home.tsx       # Dashboard do motorista
│   │   ├── scan.tsx       # Scanner QRCode
│   │   ├── perfil.tsx     # Perfil do usuario
│   │   └── notificacoes.tsx
│   ├── _layout.tsx        # Layout raiz
│   └── index.tsx          # Redirect inicial
├── src/
│   ├── services/          # Servicos
│   │   ├── api.service.ts # Cliente da API
│   │   └── push.service.ts# Push notifications
│   ├── stores/            # Zustand stores
│   │   ├── auth.store.ts  # Estado de autenticacao
│   │   └── notificacao.store.ts
│   ├── constants/         # Constantes
│   │   └── theme.ts       # Cores e estilos
│   ├── types/             # TypeScript types
│   └── utils/             # Utilitarios
│       ├── cpf.ts         # Validacao de CPF
│       └── date.ts        # Formatacao de datas
├── assets/                # Imagens e icones
├── app.json              # Configuracao Expo
├── eas.json              # Configuracao EAS Build
└── package.json
```

## Instalacao

### Pre-requisitos

- Node.js 18+
- npm ou yarn
- Expo CLI (`npm install -g expo-cli`)
- Expo Go app no celular (para desenvolvimento)

### Desenvolvimento

```bash
# Instalar dependencias
cd motorista-app
npm install

# Configurar ambiente
cp .env.example .env
# Editar .env:
# EXPO_PUBLIC_API_URL=https://seu-servidor.com/api

# Iniciar servidor de desenvolvimento
npx expo start

# Escanear QRCode com Expo Go no celular
```

### Build de Producao

```bash
# Instalar EAS CLI
npm install -g eas-cli

# Login no Expo
eas login

# Build Android (APK)
eas build --platform android --profile preview

# Build Android (AAB para Play Store)
eas build --platform android --profile production

# Build iOS (requer conta Apple Developer)
eas build --platform ios --profile production
```

## Configuracao

### Variaveis de Ambiente

```env
# .env
EXPO_PUBLIC_API_URL=https://rastreador.unifique.com.br/api
```

### app.json

```json
{
  "expo": {
    "name": "Rastreador Motorista",
    "slug": "rastreador-motorista",
    "version": "1.0.0",
    "android": {
      "package": "br.com.unifique.rastreador.motorista"
    },
    "ios": {
      "bundleIdentifier": "br.com.unifique.rastreador.motorista"
    }
  }
}
```

## API Endpoints Utilizados

### Autenticacao
```
POST /api/auth/motorista/login
Body: { cpf: "12345678900", senha: "***" }
Response: { accessToken, motorista: {...} }

POST /api/auth/motorista/refresh
Headers: Authorization: Bearer <token>

POST /api/auth/motorista/logout
```

### Motorista
```
GET /api/motorista/me
Response: { id, nome, cpf, foto_url, ... }

PUT /api/motorista/me
Body: { telefone, email, ... }

POST /api/motorista/foto
Body: FormData com imagem
```

### Viagens
```
GET /api/motorista/viagens
Response: [{ id, inicio, fim, km_total, ... }]

GET /api/motorista/viagem-atual
Response: { id, dispositivo, inicio, ... } | null
```

### Identificacao
```
POST /api/motorista/identificar
Body: { qrcode: "IMEI_DO_RASTREADOR" }
Response: { sucesso: true, veiculo: {...} }

POST /api/motorista/desidentificar
Response: { sucesso: true }
```

### Notificacoes
```
POST /api/motorista/push-token
Body: { token: "ExponentPushToken[xxx]" }

GET /api/motorista/notificacoes
Response: [{ id, titulo, mensagem, lida, ... }]

PUT /api/motorista/notificacoes/:id/lida
```

## Fluxo do Usuario

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  Login  │────▶│  Home   │────▶│  Scan   │────▶│ Viagem  │
│         │     │ (Livre) │     │ QRCode  │     │  Ativa  │
└─────────┘     └─────────┘     └─────────┘     └─────────┘
                     │                               │
                     │                               ▼
                     │                          ┌─────────┐
                     └─────────────────────────▶│Desvinc. │
                                                └─────────┘
```

1. **Login**: Motorista faz login com CPF/senha
2. **Home**: Ve seu status (livre ou em viagem)
3. **Scan**: Escaneia QRCode do rastreador no veiculo
4. **Viagem Ativa**: Sistema registra motorista na viagem
5. **Desvincular**: Ao sair do veiculo, desvincula

## Push Notifications

### Tipos de Notificacao

| Tipo | Descricao | Acao |
|------|-----------|------|
| `excesso_velocidade` | Motorista ultrapassou limite | Exibe alerta |
| `cerca_entrada` | Entrou em cerca virtual | Exibe notificacao |
| `cerca_saida` | Saiu de cerca virtual | Exibe notificacao |
| `viagem_iniciada` | Viagem registrada | Atualiza home |
| `viagem_encerrada` | Viagem finalizada | Atualiza home |

### Configuracao Push (EAS)

```json
// eas.json
{
  "build": {
    "production": {
      "android": {
        "buildType": "apk"
      }
    }
  },
  "submit": {
    "production": {}
  }
}
```

## Troubleshooting

### Erro de conexao com API

```
Network Error / timeout
```

**Solucao**: Verificar se `EXPO_PUBLIC_API_URL` usa HTTPS e o servidor esta acessivel.

### Camera nao abre

**Solucao**: Verificar permissoes de camera no dispositivo.

### Push nao funciona

**Solucao**:
1. Verificar se o token foi registrado (`POST /api/motorista/push-token`)
2. Verificar logs do servidor
3. Testar com Expo Push Notifications Tool

## Licenca

Proprietario - Unifique Telecomunicacoes

## Contato

Suporte: suporte@unifique.com.br
