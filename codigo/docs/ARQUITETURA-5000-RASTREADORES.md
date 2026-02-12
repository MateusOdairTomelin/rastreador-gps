# Arquitetura para 5.000+ Rastreadores

## Visão Geral

```
                                    ┌─────────────────────────────────────────────────────────────┐
                                    │                      LOAD BALANCER                          │
                                    │                    (HAProxy/Nginx)                          │
                                    │               TCP:8877 | HTTP:80/443                        │
                                    └─────────────────────────────────────────────────────────────┘
                                                              │
                        ┌─────────────────────────────────────┼─────────────────────────────────────┐
                        │                                     │                                     │
                        ▼                                     ▼                                     ▼
          ┌─────────────────────────┐       ┌─────────────────────────┐       ┌─────────────────────────┐
          │   TCP GATEWAY 1         │       │   TCP GATEWAY 2         │       │   TCP GATEWAY N         │
          │   (Rastreadores)        │       │   (Rastreadores)        │       │   (Rastreadores)        │
          │   ~1.700 conexões       │       │   ~1.700 conexões       │       │   ~1.700 conexões       │
          │   Port: 8877            │       │   Port: 8877            │       │   Port: 8877            │
          └───────────┬─────────────┘       └───────────┬─────────────┘       └───────────┬─────────────┘
                      │                                 │                                 │
                      └─────────────────────────────────┼─────────────────────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────────────────┐
                              │              MESSAGE QUEUE                   │
                              │         (Redis Streams / RabbitMQ)          │
                              │                                             │
                              │  Filas:                                     │
                              │  - location_queue (alta prioridade)         │
                              │  - obd2_queue (média prioridade)            │
                              │  - alarm_queue (crítica)                    │
                              │  - command_queue (baixa prioridade)         │
                              └─────────────────────────────────────────────┘
                                                        │
          ┌─────────────────────────────────────────────┼─────────────────────────────────────────────┐
          │                                             │                                             │
          ▼                                             ▼                                             ▼
┌───────────────────────┐               ┌───────────────────────┐               ┌───────────────────────┐
│  LOCATION PROCESSOR   │               │   OBD2 PROCESSOR      │               │   ALARM PROCESSOR     │
│  (Worker 1-5)         │               │   (Worker 1-2)        │               │   (Worker 1-2)        │
│                       │               │                       │               │                       │
│  - Parse location     │               │  - Process OBD2       │               │  - Handle alarms      │
│  - GPS Pipeline       │               │  - Telemetria         │               │  - Notifications      │
│  - Kalman Filter      │               │  - Odômetro/Horímetro │               │  - Push alerts        │
│  - Map Matching       │               │                       │               │                       │
└───────────┬───────────┘               └───────────┬───────────┘               └───────────┬───────────┘
            │                                       │                                       │
            └───────────────────────────────────────┼───────────────────────────────────────┘
                                                    │
                                                    ▼
                              ┌─────────────────────────────────────────────┐
                              │            DATABASE CLUSTER                  │
                              │                                             │
                              │  ┌─────────────┐    ┌─────────────────────┐ │
                              │  │ PostgreSQL  │◄──►│ PostgreSQL Replica  │ │
                              │  │  (Primary)  │    │     (Read-Only)     │ │
                              │  │  Writes     │    │     Reads           │ │
                              │  └─────────────┘    └─────────────────────┘ │
                              │                                             │
                              │  ┌─────────────┐    ┌─────────────────────┐ │
                              │  │   Redis     │    │    TimescaleDB      │ │
                              │  │   Cache     │    │    (Time-series)    │ │
                              │  │   Sessions  │    │    Localizações     │ │
                              │  └─────────────┘    └─────────────────────┘ │
                              └─────────────────────────────────────────────┘
                                                    │
          ┌─────────────────────────────────────────┼─────────────────────────────────────────────┐
          │                                         │                                             │
          ▼                                         ▼                                             ▼
┌───────────────────────┐               ┌───────────────────────┐               ┌───────────────────────┐
│     API SERVER 1      │               │     API SERVER 2      │               │     API SERVER N      │
│     (Express.js)      │               │     (Express.js)      │               │     (Express.js)      │
│                       │               │                       │               │                       │
│  - REST API           │               │  - REST API           │               │  - REST API           │
│  - WebSocket          │               │  - WebSocket          │               │  - WebSocket          │
│  - Dashboard          │               │  - Dashboard          │               │  - Dashboard          │
└───────────────────────┘               └───────────────────────┘               └───────────────────────┘
                                                    │
                                                    ▼
                              ┌─────────────────────────────────────────────┐
                              │              SUPPORT SERVICES                │
                              │                                             │
                              │  ┌─────────────┐    ┌─────────────────────┐ │
                              │  │    OSRM     │    │     Prometheus      │ │
                              │  │ Map-Matching│    │     + Grafana       │ │
                              │  └─────────────┘    └─────────────────────┘ │
                              │                                             │
                              │  ┌─────────────┐    ┌─────────────────────┐ │
                              │  │   Minio     │    │      Loki           │ │
                              │  │  (Storage)  │    │     (Logs)          │ │
                              │  └─────────────┘    └─────────────────────┘ │
                              └─────────────────────────────────────────────┘
```

---

## Componentes Detalhados

### 1. TCP GATEWAY (Stateless)

**Responsabilidade:** Receber conexões TCP dos rastreadores e publicar na fila.

```javascript
// Cada gateway suporta ~1.700 conexões simultâneas
// 3 gateways = 5.100 conexões

Funções:
- Aceitar conexão TCP (porta 8877)
- Parse de pacotes GT06 (apenas validação básica)
- Extrair IMEI do pacote 0x01 (LOGIN)
- Enviar ACK para rastreador
- Publicar pacote na fila Redis
- Manter sessão ativa (heartbeat)
- Enviar comandos (0x80) quando solicitado
```

**Scaling:**
- Horizontal (adicionar mais instâncias)
- Sticky sessions por IMEI (mesmo gateway para mesmo device)

### 2. MESSAGE QUEUE (Redis Streams)

**Filas:**

| Fila | Prioridade | Volume/seg | Consumers |
|------|------------|------------|-----------|
| `alarm_queue` | CRITICAL | ~2 | 2 workers |
| `location_queue` | HIGH | ~200 | 5 workers |
| `obd2_queue` | MEDIUM | ~50 | 2 workers |
| `command_queue` | LOW | ~1 | 1 worker |

**Formato da mensagem:**
```json
{
  "imei": "356354870699551",
  "packet_type": "0x22",
  "raw_hex": "7878...",
  "parsed": {
    "latitude": -26.8195,
    "longitude": -49.272547,
    "velocidade": 45,
    "timestamp": "2025-12-19T12:00:00Z"
  },
  "gateway_id": "gw-1",
  "received_at": "2025-12-19T12:00:00.123Z"
}
```

### 3. LOCATION PROCESSOR (Workers)

**Responsabilidade:** Processar localizações com pipeline GPS.

```
Input: location_queue
Output: PostgreSQL + Redis Cache

Pipeline:
1. Validar coordenadas
2. Aplicar Kalman Filter
3. Detectar outliers
4. Map-matching (OSRM)
5. Detectar estado de ignição
6. Calcular viagem (se ativa)
7. Salvar no banco
8. Publicar no Redis (real-time)
```

**Scaling:**
- 5 workers iniciais
- Auto-scale baseado em queue depth
- CPU-bound (precisa de mais cores)

### 4. DATABASE CLUSTER

#### PostgreSQL (Primary + Replica)
```
Primary (Writes):
- Localizações (particionado por mês)
- Dispositivos
- Viagens
- Alarmes

Replica (Reads):
- Históricos
- Relatórios
- Dashboard
```

#### TimescaleDB (Time-series)
```
Otimizado para:
- INSERT massivo de localizações
- Queries por time range
- Compressão automática (90%+)
- Retenção automática (90 dias hot, archive cold)
```

#### Redis
```
- Cache de dispositivos (TTL 5min)
- Cache de última localização (TTL 1min)
- Sessões TCP (gateway <-> IMEI)
- Pub/Sub para real-time updates
- Rate limiting counters
```

### 5. API SERVER (Stateless)

**Responsabilidade:** Servir API REST e WebSocket.

```
Endpoints:
- /api/dispositivos
- /api/localizacoes
- /api/viagens
- /api/alarmes
- /api/comandos
- /ws (WebSocket)
```

**Scaling:**
- Horizontal (load balancer)
- Stateless (sessions no Redis)
- 2-3 instâncias iniciais

---

## Docker Compose (Desenvolvimento)

```yaml
version: '3.8'

services:
  # =============================================================================
  # LOAD BALANCER
  # =============================================================================
  haproxy:
    image: haproxy:2.8
    ports:
      - "8877:8877"   # TCP (rastreadores)
      - "80:80"       # HTTP
      - "443:443"     # HTTPS
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
    depends_on:
      - tcp-gateway-1
      - tcp-gateway-2
      - api-server-1
    networks:
      - rastreador-net

  # =============================================================================
  # TCP GATEWAYS
  # =============================================================================
  tcp-gateway-1:
    build:
      context: .
      dockerfile: Dockerfile.tcp-gateway
    environment:
      - GATEWAY_ID=gw-1
      - REDIS_URL=redis://redis:6379
      - MAX_CONNECTIONS=2000
    depends_on:
      - redis
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1'

  tcp-gateway-2:
    build:
      context: .
      dockerfile: Dockerfile.tcp-gateway
    environment:
      - GATEWAY_ID=gw-2
      - REDIS_URL=redis://redis:6379
      - MAX_CONNECTIONS=2000
    depends_on:
      - redis
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1'

  tcp-gateway-3:
    build:
      context: .
      dockerfile: Dockerfile.tcp-gateway
    environment:
      - GATEWAY_ID=gw-3
      - REDIS_URL=redis://redis:6379
      - MAX_CONNECTIONS=2000
    depends_on:
      - redis
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1'

  # =============================================================================
  # MESSAGE QUEUE
  # =============================================================================
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --maxmemory 2gb --maxmemory-policy allkeys-lru
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 2G
          cpus: '2'

  # =============================================================================
  # PROCESSORS (Workers)
  # =============================================================================
  location-processor-1:
    build:
      context: .
      dockerfile: Dockerfile.processor
    environment:
      - PROCESSOR_TYPE=location
      - WORKER_ID=loc-1
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
      - OSRM_URL=http://osrm:5000
    depends_on:
      - redis
      - postgres-primary
      - osrm
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'

  location-processor-2:
    build:
      context: .
      dockerfile: Dockerfile.processor
    environment:
      - PROCESSOR_TYPE=location
      - WORKER_ID=loc-2
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
      - OSRM_URL=http://osrm:5000
    depends_on:
      - redis
      - postgres-primary
      - osrm
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'

  location-processor-3:
    build:
      context: .
      dockerfile: Dockerfile.processor
    environment:
      - PROCESSOR_TYPE=location
      - WORKER_ID=loc-3
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
      - OSRM_URL=http://osrm:5000
    depends_on:
      - redis
      - postgres-primary
      - osrm
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'

  obd2-processor:
    build:
      context: .
      dockerfile: Dockerfile.processor
    environment:
      - PROCESSOR_TYPE=obd2
      - WORKER_ID=obd-1
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
    depends_on:
      - redis
      - postgres-primary
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1'

  alarm-processor:
    build:
      context: .
      dockerfile: Dockerfile.processor
    environment:
      - PROCESSOR_TYPE=alarm
      - WORKER_ID=alarm-1
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
    depends_on:
      - redis
      - postgres-primary
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: '1'

  # =============================================================================
  # DATABASE CLUSTER
  # =============================================================================
  postgres-primary:
    image: timescale/timescaledb:latest-pg15
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=rastreador
    ports:
      - "5432:5432"
    volumes:
      - postgres-primary-data:/var/lib/postgresql/data
      - ./init-db.sql:/docker-entrypoint-initdb.d/init.sql
    command: >
      postgres
      -c shared_buffers=2GB
      -c effective_cache_size=6GB
      -c maintenance_work_mem=512MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=64MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
      -c effective_io_concurrency=200
      -c work_mem=10MB
      -c min_wal_size=1GB
      -c max_wal_size=4GB
      -c max_worker_processes=8
      -c max_parallel_workers_per_gather=4
      -c max_parallel_workers=8
      -c max_connections=200
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 8G
          cpus: '4'

  postgres-replica:
    image: timescale/timescaledb:latest-pg15
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=rastreador
      - PGDATA=/var/lib/postgresql/data
    volumes:
      - postgres-replica-data:/var/lib/postgresql/data
    depends_on:
      - postgres-primary
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'

  # =============================================================================
  # API SERVERS
  # =============================================================================
  api-server-1:
    build:
      context: .
      dockerfile: Dockerfile.api
    environment:
      - NODE_ENV=production
      - API_ID=api-1
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-replica:5432/rastreador
      - DATABASE_WRITE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
    depends_on:
      - redis
      - postgres-primary
      - postgres-replica
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'

  api-server-2:
    build:
      context: .
      dockerfile: Dockerfile.api
    environment:
      - NODE_ENV=production
      - API_ID=api-2
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=postgresql://postgres:password@postgres-replica:5432/rastreador
      - DATABASE_WRITE_URL=postgresql://postgres:password@postgres-primary:5432/rastreador
    depends_on:
      - redis
      - postgres-primary
      - postgres-replica
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 1G
          cpus: '2'

  # =============================================================================
  # SUPPORT SERVICES
  # =============================================================================
  osrm:
    image: osrm/osrm-backend
    ports:
      - "5000:5000"
    volumes:
      - ./osrm-data:/data
    command: osrm-routed --algorithm mld /data/brazil-latest.osrm
    networks:
      - rastreador-net
    deploy:
      resources:
        limits:
          memory: 4G
          cpus: '2'

  # =============================================================================
  # MONITORING
  # =============================================================================
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    networks:
      - rastreador-net

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    depends_on:
      - prometheus
    networks:
      - rastreador-net

  loki:
    image: grafana/loki:latest
    ports:
      - "3100:3100"
    volumes:
      - loki-data:/loki
    networks:
      - rastreador-net

# =============================================================================
# VOLUMES
# =============================================================================
volumes:
  redis-data:
  postgres-primary-data:
  postgres-replica-data:
  prometheus-data:
  grafana-data:
  loki-data:

# =============================================================================
# NETWORKS
# =============================================================================
networks:
  rastreador-net:
    driver: bridge
```

---

## Estimativa de Recursos

### Hardware Mínimo (5.000 rastreadores)

| Componente | CPU | RAM | Disco | Instâncias |
|------------|-----|-----|-------|------------|
| TCP Gateway | 1 core | 512 MB | 1 GB | 3 |
| Location Processor | 2 cores | 1 GB | 1 GB | 3-5 |
| OBD2 Processor | 1 core | 512 MB | 1 GB | 1-2 |
| Alarm Processor | 1 core | 512 MB | 1 GB | 1-2 |
| API Server | 2 cores | 1 GB | 1 GB | 2-3 |
| Redis | 2 cores | 2 GB | 10 GB | 1 |
| PostgreSQL Primary | 4 cores | 8 GB | 500 GB SSD | 1 |
| PostgreSQL Replica | 2 cores | 4 GB | 500 GB SSD | 1 |
| OSRM | 2 cores | 4 GB | 10 GB | 1 |
| Prometheus + Grafana | 1 core | 1 GB | 50 GB | 1 |
| **TOTAL** | **~25 cores** | **~25 GB** | **~1 TB SSD** | - |

### Cloud Equivalente (AWS/GCP/Azure)

**Opção 1: VMs separadas**
- 3x t3.medium (TCP Gateway)
- 5x t3.large (Processors)
- 3x t3.large (API)
- 1x r5.2xlarge (PostgreSQL Primary)
- 1x r5.xlarge (PostgreSQL Replica)
- 1x r5.large (Redis)
- 1x t3.xlarge (OSRM)

**Custo estimado:** ~$1.500-2.000/mês

**Opção 2: Kubernetes (EKS/GKE/AKS)**
- 5x n2-standard-4 nodes
- Managed PostgreSQL (RDS/Cloud SQL)
- Managed Redis (ElastiCache/Memorystore)

**Custo estimado:** ~$2.000-2.500/mês (mais fácil de escalar)

---

## Roadmap de Migração

### Fase 1: Preparação (2 semanas)
- [ ] Containerizar aplicação atual (Docker)
- [ ] Separar TCP Gateway do API Server
- [ ] Implementar Redis para sessões
- [ ] Configurar TimescaleDB para localizações
- [ ] Criar scripts de migração de dados

### Fase 2: Infraestrutura (2 semanas)
- [ ] Provisionar servidores/cloud
- [ ] Configurar Docker Compose / Kubernetes
- [ ] Setup de monitoring (Prometheus + Grafana)
- [ ] Setup de logs (Loki)
- [ ] Configurar backups automáticos

### Fase 3: Migração (1 semana)
- [ ] Migrar dados para novo banco
- [ ] Testar com subset de rastreadores
- [ ] Validar pipeline GPS
- [ ] Validar detecção de ignição
- [ ] Testar comandos (0x80)

### Fase 4: Go-Live (1 semana)
- [ ] DNS cutover gradual (10% → 50% → 100%)
- [ ] Monitorar métricas
- [ ] Ajustar scaling conforme necessário
- [ ] Documentar runbooks

### Fase 5: Otimização (contínuo)
- [ ] Ajustar auto-scaling
- [ ] Otimizar queries lentas
- [ ] Implementar cache agressivo
- [ ] Adicionar novos modelos de rastreadores

---

## Suporte a Novos Rastreadores

### Arquitetura de Plugins

```
/server/parsers/
├── parser-interface.js      # Interface base
├── gt06-parser.js           # GT06 protocol (atual)
├── jt808-parser.js          # JT/T 808 protocol (futuro)
├── teltonika-parser.js      # Teltonika protocol (futuro)
└── parser-factory.js        # Factory para selecionar parser

/server/protocols/
├── tcp-protocol.js          # TCP (atual)
├── udp-protocol.js          # UDP (futuro)
├── mqtt-protocol.js         # MQTT (futuro - IoT)
└── http-protocol.js         # HTTP webhook (futuro)
```

### Adicionar Novo Modelo

1. Criar parser em `/server/parsers/novo-parser.js`
2. Implementar interface:
   - `parse(buffer)` → { type, imei, data }
   - `createAck(serialNumber)` → Buffer
   - `validateCRC(buffer)` → boolean
3. Registrar no `parser-factory.js`
4. Adicionar tipo em `device-types.js`
5. Configurar porta (se diferente)

### Portas por Protocolo

| Protocolo | Porta | Rastreadores |
|-----------|-------|--------------|
| GT06 (TCP) | 8877 | XT40, X3Tech, Concox |
| JT808 (TCP) | 8878 | Chineses JT/T 808 |
| Teltonika (TCP) | 8879 | FMB, FMC series |
| MQTT | 1883 | IoT devices |
| HTTP Webhook | 8880 | API-based trackers |

---

## Conclusão

A arquitetura proposta permite:

1. **Escalar horizontalmente** de 5.000 para 50.000+ rastreadores
2. **Alta disponibilidade** com redundância em todos os componentes
3. **Fácil manutenção** com containers e CI/CD
4. **Flexibilidade** para adicionar novos protocolos/rastreadores
5. **Monitoramento completo** com Prometheus + Grafana
6. **Custo otimizado** pagando apenas pelo que usar

### Próximo Passo Recomendado

Começar pela **Fase 1** - containerizar a aplicação atual sem mudar a arquitetura, para validar que funciona em Docker antes de separar em microserviços.
