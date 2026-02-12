# Arquitetura do Sistema de Rastreamento

## Visao Geral

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              RASTREADORES                                    │
│                    (XT40_4F, XT40_OBD2, Teltonika)                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HAProxy (porta 8877-8879)                       │
│                         Load Balancer TCP                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
            ┌──────────────┐                ┌──────────────┐
            │ TCP Gateway 1│                │ TCP Gateway 2│
            │   (gw-1)     │                │   (gw-2)     │
            └──────────────┘                └──────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Redis Streams (DB 2)                               │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐                │
│  │gps:packets:     │ │gps:packets:     │ │gps:packets:     │                │
│  │  location       │ │  status         │ │  obd2           │                │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
    ┌──────────────┐        ┌──────────────┐        ┌──────────────┐
    │  Location    │        │   Status     │        │   Alarm      │
    │  Processor   │        │  Processor   │        │  Processor   │
    │  (1 e 2)     │        │              │        │              │
    └──────────────┘        └──────────────┘        └──────────────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PostgreSQL (via PgBouncer)                            │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                │
│  │dispositivos│ │localizacoes│ │ dados_obd2 │ │  viagens   │                │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API Servers (1 e 2)                                  │
│                         HAProxy porta 62000                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                        │
│                    (Dashboard, Mapa, Relatorios)                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Componentes e Responsabilidades

### 1. TCP Gateways (rastreador-tcp-gw-1, rastreador-tcp-gw-2)

**Arquivo**: `server/tcp-gateway.js`
**Portas**: 8877 (XT40_4F), 8878 (XT40_OBD2), 8879 (Teltonika)
**Container**: `rastreador-tcp-gw-1`, `rastreador-tcp-gw-2`

**Responsabilidades**:
- Receber conexoes TCP dos rastreadores
- Parsear pacotes usando `server/parsers/gps-parser.js`
- Enviar ACK de volta para o rastreador
- Publicar dados no Redis Streams (NAO processa, apenas encaminha)

**Tipos de Pacotes Parseados**:
| Protocolo | Tipo | Descricao |
|-----------|------|-----------|
| 0x01 | LOGIN | Autenticacao do dispositivo |
| 0x13 | STATUS | Heartbeat com tensao, ACC, sinal GSM |
| 0x22 | LOCATION | GPS + dados extras (odometro, horimetro) |
| 0x26 | ALARM | Alertas (SOS, bateria, etc) |
| 0x94 | INFO | Informacoes do dispositivo |

**Streams de Saida**:
```
gps:packets:location  → Pacotes 0x22 (GPS)
gps:packets:status    → Pacotes 0x13 (heartbeat)
gps:packets:obd2      → Pacotes OBD2 reais (raro)
gps:packets:alarm     → Pacotes 0x26 (alertas)
```

---

### 2. Location Processor (rastreador-loc-proc-1, rastreador-loc-proc-2)

**Arquivo**: `server/workers/location-processor.js`
**Stream**: Consome de `gps:packets:location`

**Responsabilidades**:
- Validar coordenadas (fora do Brasil, coordenadas de fabrica)
- Aplicar pipeline GPS (Kalman, Map-Matching via OSRM)
- Detectar estado de ignicao (EXCETO XT40_OBD2)
- Salvar em `localizacoes`
- Processar viagens (inicio/fim)
- Verificar geofencing
- Criar dados OBD2 quando pacote tem dados extras

**Servicos Utilizados**:
- `localizacaoService` → Salva localizacoes
- `viagemService` → Gerencia viagens
- `obd2Service` → Cria registros OBD2
- `geofencingService` → Verifica cercas virtuais
- `gps-pipeline.service` → Kalman + Map-Matching

**Logica de Ignicao**:
```
XT40_4F:     Usa tensao_principal + ACC do pacote
XT40_OBD2:   IGNORA pacote (estado vem do obd2Service)
```

---

### 3. Status Processor (rastreador-status-proc)

**Arquivo**: `server/workers/status-processor.js`
**Stream**: Consome de `gps:packets:status`

**Responsabilidades**:
- Registrar heartbeat
- Atualizar status online/offline
- Detectar estado de ignicao por tensao (EXCETO XT40_OBD2)
- Criar registro de localizacao para mudancas de status

**Logica de Ignicao**:
```
XT40_4F:     tensao >= 13V → idle, tensao < 13V por 30s → off
XT40_OBD2:   IGNORA (tensao do status packet e incorreta ~15.4V)
```

---

### 4. Alarm Processor (rastreador-alarm-proc)

**Arquivo**: `server/workers/alarm-processor.js`
**Stream**: Consome de `gps:packets:alarm`

**Responsabilidades**:
- Processar alertas (SOS, bateria baixa, etc)
- Criar registros em `alarmes`
- Disparar notificacoes

---

### 5. API Servers (rastreador-api-1, rastreador-api-2)

**Arquivo**: `server/index.js`
**Porta**: 3000 (interno), 62000 (HAProxy)

**Rotas Principais**:
| Rota | Arquivo | Descricao |
|------|---------|-----------|
| `/api/dispositivos` | `dispositivos.routes.js` | CRUD dispositivos, status |
| `/api/localizacoes` | `localizacoes.routes.js` | Historico GPS |
| `/api/viagens` | `viagens.routes.js` | Viagens/trajetos |
| `/api/obd2` | `obd2.routes.js` | Dados OBD2 |
| `/api/alertas` | `alertas.routes.js` | Alertas/alarmes |
| `/api/geofences` | `geofences.routes.js` | Cercas virtuais |
| `/api/relatorios` | `relatorios.routes.js` | Relatorios |

**Logica de Estado para Frontend** (`dispositivos.routes.js`):
```
Prioridade para determinar estado_ignicao:
1. Se offline → 'off'
2. Se XT40_OBD2 → usa dispositivos.estado_ignicao (do obd2Service)
3. Se tem localizacao recente → usa localizacao.estado_ignicao
4. Default → 'off'
```

---

## Fluxo de Dados por Tipo de Dispositivo

### XT40_4F (Rastreador com Fios)

```
Rastreador → TCP Gateway (8877) → Redis Stream
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
            gps:packets:location                   gps:packets:status
                    │                                      │
                    ▼                                      ▼
            Location Processor                     Status Processor
                    │                                      │
                    ├─ Detecta ignicao por tensao          ├─ Detecta ignicao por tensao
                    ├─ Salva localizacao                   ├─ Atualiza dispositivo
                    ├─ Processa viagem                     └─ Cria localizacao de status
                    └─ Cria dados OBD2 (se tiver)
```

**Campos Relevantes**:
- `tensao_principal`: Tensao do veiculo (12-14.5V)
- `ignicao` (ACC): Bit do terminal info
- Ignicao: `tensao >= 13V` = motor ligado

---

### XT40_OBD2 (Rastreador Plug-and-Play)

```
Rastreador → TCP Gateway (8878) → Redis Stream
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
            gps:packets:location                   gps:packets:status
                    │                                      │
                    ▼                                      ▼
            Location Processor                     Status Processor
                    │                                      │
                    ├─ IGNORA ignicao do pacote            ├─ IGNORA ignicao do pacote
                    ├─ Salva localizacao                   └─ Apenas atualiza status online
                    ├─ Processa viagem
                    └─ Chama obd2Service.create()
                              │
                              ▼
                       obd2Service
                              │
                              ├─ Detecta ignicao por dados OBD2 reais
                              └─ Atualiza dispositivos.estado_ignicao
```

**IMPORTANTE - XT40_OBD2**:
- `tensao_bateria` do status packet: ~15.4V (INCORRETO, sensor interno)
- `tensao_principal` do dados_obd2: ~12.6V (CORRETO, via OBD)
- `ignicao` do dados_obd2: Correto (via CAN bus)
- Estado de ignicao: Vem APENAS do `obd2Service.create()`

---

## Tabelas do Banco de Dados

### dispositivos
```sql
- imei (PK)
- tipo: 'XT40_4F', 'XT40_OBD2', 'TELTONIKA', etc
- status: 'online', 'offline', 'aguardando'
- estado_ignicao: 'off', 'acc_on', 'idle', 'moving'
- ultima_conexao
- organizacao_id (FK)
- tensao_motor_ligado, tensao_motor_deslig (thresholds)
- usa_ignicao_virtual (bool)
```

### localizacoes (particionada por mes)
```sql
- dispositivo_id (FK)
- latitude, longitude
- velocidade, direcao, altitude
- estado_ignicao
- timestamp
```

### dados_obd2
```sql
- dispositivo_id (FK)
- rpm, temperatura_motor, nivel_combustivel
- tensao_principal (tensao CORRETA do veiculo)
- tensao_bateria (bateria interna do rastreador)
- ignicao (bool - CORRETO para OBD2)
- odometro_embarcado, hora_motor_embarcada
- timestamp
```

### viagens
```sql
- dispositivo_id (FK)
- inicio, fim
- origem_lat, origem_lng
- destino_lat, destino_lng
- distancia_km
- velocidade_media, velocidade_maxima
```

### coordenadas_aprendidas (GPS Learning)
```sql
- dispositivo_id (FK)
- lat_original, lon_original
- lat_corrigido, lon_corrigido
- distancia (metros) - MAX 100m permitido
- confianca, vezes_usado
```

---

## Redis Keys

### DB 0 (Cache geral)
```
hb:{imei}                    → Heartbeat (timestamp, count)
device:{imei}:location       → Ultima localizacao (cache)
```

### DB 2 (Streams)
```
gps:packets:location         → Stream de localizacoes
gps:packets:status           → Stream de status/heartbeat
gps:packets:obd2             → Stream de dados OBD2
gps:packets:alarm            → Stream de alarmes
gps:session:{imei}           → Sessao do dispositivo
gps:commands                 → Comandos para enviar
gps:command:responses        → Respostas de comandos
```

---

## Portas e Servicos

| Servico | Porta Interna | Porta Externa | Descricao |
|---------|---------------|---------------|-----------|
| HAProxy | - | 62000 | Load balancer HTTP (API) |
| HAProxy | - | 8877 | Load balancer TCP (XT40_4F) |
| HAProxy | - | 8878 | Load balancer TCP (XT40_OBD2) |
| HAProxy | - | 8879 | Load balancer TCP (Teltonika) |
| API Server | 3000 | - | REST API |
| PostgreSQL | 5432 | - | Banco de dados |
| PgBouncer | 5432 | - | Connection pooling |
| Redis | 6379 | - | Cache e Streams |
| OSRM | 5000 | - | Map-matching |

---

## Troubleshooting Rapido

### Dispositivo mostra status errado
1. Verificar `dispositivos.estado_ignicao` no banco
2. Verificar ultima localizacao em `localizacoes`
3. Para XT40_OBD2: verificar `dados_obd2` (fonte correta)

### Dispositivo nao atualiza posicao
1. Verificar se esta conectado: `docker logs rastreador-tcp-gw-1 | grep {imei}`
2. Verificar Redis stream: `redis-cli -n 2 XINFO STREAM gps:packets:location`
3. Verificar location processor: `docker logs rastreador-loc-proc-1 | grep {imei}`

### Coordenadas erradas/pulando
1. Verificar `coordenadas_aprendidas` (limpar se distancia > 100m)
2. Verificar pipeline GPS (Kalman pode estar "travando")
3. Verificar se e LBS vs GPS (precisao com muitos decimais = calculado)

### XT40_OBD2 especifico
- Status packets tem tensao ERRADA (~15.4V)
- Dados OBD2 tem tensao CORRETA (~12.6V)
- `estado_ignicao` so deve vir de `obd2Service.create()`

---

## Comandos Uteis

```bash
# Ver conexoes ativas
docker logs rastreador-tcp-gw-1 2>&1 | grep "Login\|Desconectado"

# Ver processamento de localizacoes
docker logs rastreador-loc-proc-1 2>&1 | grep {imei}

# Ver status de streams
docker exec rastreador-redis redis-cli -a '{senha}' -n 2 XINFO STREAM gps:packets:location

# Verificar estado do dispositivo
docker exec rastreador-db psql -U postgres -d rastreador_db -c "SELECT imei, tipo, status, estado_ignicao FROM dispositivos WHERE imei = '{imei}';"

# Ver ultimas localizacoes
docker exec rastreador-db psql -U postgres -d rastreador_db -c "SELECT timestamp, latitude, longitude, estado_ignicao, velocidade FROM localizacoes WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '{imei}') ORDER BY timestamp DESC LIMIT 10;"

# Ver dados OBD2 (para XT40_OBD2)
docker exec rastreador-db psql -U postgres -d rastreador_db -c "SELECT timestamp, tensao_principal, ignicao FROM dados_obd2 WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '{imei}') ORDER BY timestamp DESC LIMIT 5;"
```

---

## Escalonamento Horizontal

### Componentes Escalaveis

| Componente | Container | Escalavel | Por que |
|------------|-----------|-----------|---------|
| TCP Gateway | tcp-gw-1, tcp-gw-2 | Sim | HAProxy distribui conexoes TCP |
| Location Processor | loc-proc-1, loc-proc-2 | Sim | Redis Consumer Groups |
| Status Processor | status-proc | Sim | Redis Consumer Groups |
| API Server | api-1, api-2 | Sim | HAProxy distribui HTTP |
| Alarm Processor | alarm-proc | Sim | Redis Consumer Groups |
| PostgreSQL | postgres | Nao | Banco centralizado |
| Redis | redis | Nao | Cache/Streams centralizado |
| HAProxy | haproxy | Nao | Load balancer unico |

---

### Arquitetura Normal vs Escalada

```
NORMAL (16GB RAM):                    ESCALADA (32GB+ RAM):

├── tcp-gateway-1                     ├── tcp-gateway-1
├── tcp-gateway-2                     ├── tcp-gateway-2
│                                     ├── tcp-gateway-3
│                                     ├── tcp-gateway-4
│                                     │
├── location-processor-1              ├── location-processor-1
├── location-processor-2              ├── location-processor-2
│                                     ├── location-processor-3
│                                     ├── location-processor-4
│                                     │
├── status-processor                  ├── status-processor-1
│                                     ├── status-processor-2
│                                     │
├── api-server-1                      ├── api-server-1
│                                     ├── api-server-2
│                                     │
├── postgres                          ├── postgres
├── pgbouncer                         ├── pgbouncer
├── redis                             ├── redis
└── haproxy                           └── haproxy
```

---

### Capacidade por Modo

| Modo | TCP Gateways | Loc Processors | APIs | Rastreadores | RAM Necessaria |
|------|--------------|----------------|------|--------------|----------------|
| Normal | 2 | 2 | 1 | ~2.000 | 16GB |
| Escalado | 4 | 4 | 2 | ~4.000 | 32GB |

---

### Arquivos de Configuracao

```
/home/tomelin/rastreador/codigo/
├── docker-compose.scalable-16gb.yml   # Compose principal (modo normal)
├── docker-compose.scaled.yml          # Compose adicional (containers extras)
├── config/
│   ├── haproxy-16gb.cfg               # HAProxy modo normal (2 gateways)
│   └── haproxy-scaled.cfg             # HAProxy modo escalado (4 gateways)
└── scripts/
    └── escalar.sh                     # Script de escalonamento
```

---

### Comandos de Escalonamento

```bash
# ============================================
# USANDO O SCRIPT (RECOMENDADO)
# ============================================

# Ver status atual dos containers
./scripts/escalar.sh status

# Iniciar em modo NORMAL (2 gateways, 2 processors, 1 API)
./scripts/escalar.sh normal

# Iniciar em modo ESCALADO (4 gateways, 4 processors, 2 APIs)
./scripts/escalar.sh scaled

# ============================================
# COMANDOS MANUAIS
# ============================================

# Subir modo normal
docker compose -f docker-compose.scalable-16gb.yml up -d

# Subir modo escalado (adiciona containers extras)
docker compose -f docker-compose.scalable-16gb.yml -f docker-compose.scaled.yml up -d

# Voltar ao normal (parar containers extras)
docker stop rastreador-tcp-gw-3 rastreador-tcp-gw-4 \
            rastreador-loc-proc-3 rastreador-loc-proc-4 \
            rastreador-status-proc-2 rastreador-api-2

# Rebuild de um servico especifico
docker compose -f docker-compose.scalable-16gb.yml up -d {servico} --build --force-recreate
```

---

### HAProxy Stats (Monitoramento)

Acesse o painel de monitoramento do HAProxy para ver:
- Status de cada backend (UP/DOWN)
- Conexoes ativas por servidor
- Bytes transferidos
- Tempo de resposta

```
URL: http://{IP}:8404/stats
Usuario: admin
Senha: admin
```

---

### Fluxo de Escalonamento

```
                         HAProxy (Load Balancer)
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
         tcp-gw-1            tcp-gw-2            tcp-gw-N
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                                  ▼
                           Redis Streams
                      (fila de mensagens)
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
        loc-proc-1          loc-proc-2          loc-proc-N
              │                   │                   │
              └───────────────────┼───────────────────┘
                                  │
                                  ▼
                    PostgreSQL (via PgBouncer)
```

**Como funciona:**
1. HAProxy distribui conexoes TCP entre os gateways (balance: source)
2. Cada gateway publica no mesmo Redis Stream
3. Redis Consumer Groups distribui mensagens entre os processors
4. Cada processor pode processar mensagens independentemente
5. PgBouncer gerencia pool de conexoes com o banco

---

### Adicionar Mais Instancias Manualmente

Para adicionar um tcp-gateway-5, por exemplo:

1. Editar `docker-compose.scaled.yml`:
```yaml
tcp-gateway-5:
  build:
    context: .
    dockerfile: Dockerfile.tcp-gateway
  container_name: rastreador-tcp-gw-5
  environment:
    - GATEWAY_ID=gw-5
    # ... (copiar do gw-4)
```

2. Editar `config/haproxy-scaled.cfg`:
```
backend tcp_gateways_xt40
    server gw-5 rastreador-tcp-gw-5:8877 check inter 5s fall 3 rise 2 weight 100
```

3. Recarregar:
```bash
docker compose -f docker-compose.scalable-16gb.yml -f docker-compose.scaled.yml up -d
docker kill -s HUP rastreador-haproxy  # Reload HAProxy config
```
