# Rastreador GPS - Plataforma Completa de Rastreamento

Sistema completo de rastreamento GPS para frotas, desenvolvido com Node.js, React Native e PostgreSQL.

## Funcionalidades

- **Rastreamento em Tempo Real**: Visualize a posicao de todos os veiculos no mapa
- **Gestao de Viagens**: Historico completo de rotas e paradas
- **Cercas Virtuais (Geofencing)**: Alertas quando veiculos entram/saem de areas
- **Gestao de Motoristas**: Identificacao automatica por NFC/QRCode
- **Multas de Transito**: Cadastro, acompanhamento e alertas de vencimento
- **Dados OBD2**: Telemetria avancada (RPM, combustivel, temperatura)
- **Alertas Configuraveis**: Velocidade, bateria, SOS, desconexao
- **Relatorios**: Exportacao em PDF/Excel
- **Multi-tenant**: Suporte a multiplas organizacoes

## Arquitetura

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Rastreadores  │────▶│   TCP Gateway   │────▶│  Redis Streams  │
│  (GPS/OBD2)     │     │   (HAProxy)     │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐     ┌────────▼────────┐
│    Frontend     │◀────│   API REST      │◀────│   Processors    │
│  (Dashboard)    │     │   (Express)     │     │  (Location/OBD) │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
┌─────────────────┐                             ┌────────▼────────┐
│   App Mobile    │────────────────────────────▶│   PostgreSQL    │
│  (Motorista)    │                             │  (TimescaleDB)  │
└─────────────────┘                             └─────────────────┘
```

## Tecnologias

### Backend
- **Node.js** + Express
- **PostgreSQL** com TimescaleDB
- **Redis** Streams para processamento em tempo real
- **Prisma** ORM
- **JWT** para autenticacao

### Frontend Web
- HTML5/CSS3/JavaScript vanilla
- **Leaflet** + OpenStreetMap
- Dashboard responsivo

### App Mobile
- **React Native** com Expo
- Leitura de QRCode/NFC
- Push notifications

### Infraestrutura
- **Docker** Compose
- **HAProxy** para balanceamento
- **OSRM** para map matching
- **Prometheus** + Grafana para monitoramento

## Estrutura do Projeto

```
rastreador/
├── codigo/
│   ├── server/              # Backend Node.js
│   │   ├── routes/          # Rotas da API
│   │   ├── services/        # Logica de negocio
│   │   ├── workers/         # Processadores Redis
│   │   ├── tcp-handlers/    # Handlers de rastreadores
│   │   ├── middleware/      # Autenticacao, CORS, etc
│   │   └── jobs/            # Tarefas agendadas
│   ├── public/              # Frontend web
│   ├── prisma/              # Schema do banco
│   ├── motorista-app/       # App React Native
│   ├── config/              # HAProxy, PgBouncer
│   └── scripts/             # Deploy, backup, etc
├── grafana/                 # Dashboards
├── prometheus-rules/        # Alertas
└── docs/                    # Documentacao extra
```

## Dispositivos Suportados

| Modelo | Protocolo | Porta | Recursos |
|--------|-----------|-------|----------|
| XT40_4F | GT06 | 8877 | GPS, ACC, Tensao |
| XT40_OBD2 | GT06 + OBD2 | 8878 | GPS, OBD2, RPM, Combustivel |
| Teltonika | Codec8 | 8879 | GPS, Sensores |

## Instalacao

### Pre-requisitos
- Docker e Docker Compose
- Node.js 18+
- PostgreSQL 15+ (ou usar Docker)

### Deploy com Docker

```bash
# Clonar repositorio
git clone https://github.com/MateusOdairTomelin/rastreador-gps.git
cd rastreador-gps/codigo

# Configurar variaveis de ambiente
cp .env.example .env
# Editar .env com suas credenciais

# Iniciar servicos
docker compose -f docker-compose.scalable-16gb.yml up -d

# Aplicar migrations
docker exec rastreador-api npx prisma migrate deploy

# Seed inicial (opcional)
docker exec rastreador-api npx prisma db seed
```

### Portas

| Servico | Porta | Descricao |
|---------|-------|-----------|
| API | 62000 | REST API (HTTPS via HAProxy) |
| Frontend | 62000 | Dashboard (mesmo endpoint) |
| TCP XT40_4F | 8877 | Rastreadores XT40 |
| TCP XT40_OBD2 | 8878 | Rastreadores OBD2 |
| TCP Teltonika | 8879 | Rastreadores Teltonika |
| Grafana | 3000 | Monitoramento |
| Prometheus | 9090 | Metricas |

## Documentacao

- [Arquitetura Detalhada](codigo/ARQUITETURA.md)
- [Infraestrutura de Producao](INFRAESTRUTURA_RASTREADOR.md)
- [Seguranca e LGPD](codigo/docs/SEGURANCA-E-LGPD.md)
- [Guia do App Motorista](codigo/motorista-app/README.md)
- [Troubleshooting](codigo/TROUBLESHOOTING.md)

## API Endpoints Principais

### Autenticacao
```
POST /api/auth/login          # Login
POST /api/auth/refresh        # Renovar token
POST /api/auth/logout         # Logout
```

### Dispositivos
```
GET  /api/dispositivos              # Listar
GET  /api/dispositivos/:id          # Detalhes
GET  /api/dispositivos/:id/posicao  # Ultima posicao
GET  /api/dispositivos/:id/historico # Historico GPS
```

### Viagens
```
GET  /api/viagens                   # Listar viagens
GET  /api/viagens/:id               # Detalhes da viagem
GET  /api/viagens/:id/rota          # Rota da viagem
```

### Motoristas
```
GET  /api/motoristas                # Listar
POST /api/motoristas                # Criar
GET  /api/motoristas/:id            # Detalhes
```

### Multas
```
GET  /api/multas                    # Listar
POST /api/multas                    # Cadastrar
PUT  /api/multas/:id                # Atualizar
GET  /api/multas/estatisticas       # Dashboard
```

## Monitoramento

### Metricas Prometheus
- `gps_packets_processed_total` - Total de pacotes processados
- `gps_active_connections` - Conexoes TCP ativas
- `gps_location_saved_total` - Localizacoes salvas
- `api_request_duration_seconds` - Latencia da API

### Alertas Configurados
- Rastreador offline > 5min
- Alta latencia de processamento
- Disco/memoria acima de 80%
- Conexoes TCP zeradas

## Licenca

Proprietario - Unifique Telecomunicacoes

## Autor

Mateus Odair Tomelin - [mateus@unifique.com.br](mailto:mateus@unifique.com.br)
