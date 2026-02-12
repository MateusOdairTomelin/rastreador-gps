# Sistema de Rastreamento Veicular - Documentação de Infraestrutura

**Data:** 04/02/2026
**Versão:** 2.0 (Arquitetura Escalável)
**Status:** Produção

---

## 1. Diagrama de Arquitetura

```
                                    ┌─────────────────────────────────────────────────────────────┐
                                    │                      INTERNET                               │
                                    └─────────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
                    ┌─────────────────────────────────────────────────────────────────────────────┐
                    │                           SERVIDOR (187.85.164.97)                          │
                    │                         Ubuntu 22.04 | 8 vCPUs | 16GB RAM                   │
                    └─────────────────────────────────────────────────────────────────────────────┘
                                                              │
                    ┌─────────────────────────────────────────────────────────────────────────────┐
                    │                              HAProxy (Load Balancer)                         │
                    │                           Container: rastreador-haproxy                      │
                    ├─────────────────────────────────────────────────────────────────────────────┤
                    │  :8877 (XT40-4F)  │  :8878 (OBD2)  │  :8879 (Teltonika)  │  :62000 (HTTP)   │
                    └─────────────────────────────────────────────────────────────────────────────┘
                              │                    │                   │                │
            ┌─────────────────┴────────────────────┴───────────────────┴────────────────┴─────────┐
            │                                                                                      │
            ▼                                                                                      ▼
┌───────────────────────────────────────────────────┐      ┌───────────────────────────────────────┐
│              TCP GATEWAYS (3x)                    │      │            API SERVERS (2x)           │
│  ┌─────────────┐┌─────────────┐┌─────────────┐   │      │  ┌─────────────┐ ┌─────────────┐     │
│  │  tcp-gw-1   ││  tcp-gw-2   ││  tcp-gw-3   │   │      │  │  api-1      │ │  api-2      │     │
│  │  512MB/1CPU ││  512MB/1CPU ││  512MB/1CPU │   │      │  │  1.5GB/2CPU │ │  1GB/2CPU   │     │
│  │  Portas:    ││  Portas:    ││  Portas:    │   │      │  │  (Master)   │ │  (Replica)  │     │
│  │  8877-8879  ││  8877-8879  ││  8877-8879  │   │      │  └─────────────┘ └─────────────┘     │
│  └─────────────┘└─────────────┘└─────────────┘   │      │         │               │            │
└──────────────────────────┬───────────────────────┘      └─────────┼───────────────┼────────────┘
                           │                                        │               │
                           ▼                                        │               │
            ┌──────────────────────────────┐                        │               │
            │     REDIS (Message Queue)    │◄───────────────────────┴───────────────┘
            │     Container: redis         │
            │     1GB RAM | 2 CPUs         │
            │     Porta: 6379              │
            └──────────────┬───────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    PROCESSORS (Workers)                                         │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌────────────┐ ┌────────────┐  │
│  │  loc-proc-1      │ │  loc-proc-2      │ │  loc-proc-3      │ │ status-proc│ │ alarm-proc │  │
│  │  1GB/2CPU        │ │  1GB/2CPU        │ │  1GB/2CPU        │ │ 512MB/1CPU │ │ 512MB/1CPU │  │
│  │  Localizações    │ │  Localizações    │ │  Localizações    │ │ Heartbeats │ │ Alarmes    │  │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘ └────────────┘ └────────────┘  │
└─────────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                                  │
                                                  ▼
                           ┌──────────────────────────────────────┐
                           │         PgBouncer (Pool)             │
                           │         Porta: 6432                  │
                           │         Max Conn: 2000               │
                           └──────────────────┬───────────────────┘
                                              │
                                              ▼
                           ┌──────────────────────────────────────┐
                           │    PostgreSQL + TimescaleDB          │
                           │    Container: rastreador-db          │
                           │    4GB RAM | 4 CPUs                  │
                           │    Porta: 5432                       │
                           │    Tamanho: 64 MB                    │
                           └──────────────────────────────────────┘
```

---

## 2. Portas e Protocolos

| Porta | Protocolo | Serviço | Descrição |
|-------|-----------|---------|-----------|
| **8877** | TCP | XT40-4F | Rastreadores modelo cabo (GT06) |
| **8878** | TCP | XT40-OBD2 | Rastreadores OBD2 (GT06) |
| **8879** | TCP | Teltonika | Rastreadores Teltonika |
| **62000** | HTTP/WS | API + WebSocket | Frontend e API REST |
| **5432** | TCP | PostgreSQL | Banco de dados (interno) |
| **6432** | TCP | PgBouncer | Connection pooling |
| **6379** | TCP | Redis | Cache e filas |
| **8404** | HTTP | HAProxy Stats | Monitoramento do balanceador |

---

## 3. Containers e Recursos

| Container | Função | CPU | Memória | Status |
|-----------|--------|-----|---------|--------|
| rastreador-haproxy | Load Balancer | - | ~12 MB | ✅ Healthy |
| rastreador-tcp-gw-1 | Gateway TCP | 1 | 512 MB | ✅ Healthy |
| rastreador-tcp-gw-2 | Gateway TCP | 1 | 512 MB | ✅ Healthy |
| rastreador-tcp-gw-3 | Gateway TCP | 1 | 512 MB | ✅ Healthy |
| rastreador-api-1 | API REST (Master) | 2 | 1.5 GB | ✅ Healthy |
| rastreador-api-2 | API REST (Replica) | 2 | 1 GB | ✅ Healthy |
| rastreador-loc-proc-1 | Processador Localização | 2 | 1 GB | ✅ Healthy |
| rastreador-loc-proc-2 | Processador Localização | 2 | 1 GB | ✅ Healthy |
| rastreador-loc-proc-3 | Processador Localização | 2 | 1 GB | ✅ Healthy |
| rastreador-status-proc | Processador Status | 1 | 512 MB | ✅ Healthy |
| rastreador-alarm-proc | Processador Alarmes | 1 | 512 MB | ✅ Healthy |
| rastreador-redis | Cache/Filas | 2 | 1 GB | ✅ Healthy |
| rastreador-pgbouncer | Connection Pool | - | ~3 MB | ✅ Healthy |
| rastreador-db | PostgreSQL/TimescaleDB | 4 | 4 GB | ✅ Healthy |

**Total de Recursos Alocados:** ~12.5 GB RAM | 22 CPUs

---

## 4. Especificações do Servidor

| Recurso | Especificação | Uso Atual |
|---------|---------------|-----------|
| **Sistema Operacional** | Ubuntu 22.04 LTS | - |
| **Kernel** | Linux 6.8.0-90-generic | - |
| **CPUs** | 8 vCPUs | ~30% |
| **Memória RAM** | 16 GB | 7.3 GB (46%) |
| **Disco SSD** | 145 GB | 44 GB (32%) |
| **IP Público** | 187.85.164.97 | - |

---

## 5. Banco de Dados

| Métrica | Valor |
|---------|-------|
| **Engine** | PostgreSQL 15 + TimescaleDB |
| **Tamanho Total** | 64 MB |
| **Max Connections** | 200 (PostgreSQL) / 2000 (PgBouncer) |
| **Particionamento** | Tabela localizações (mensal) |

### Tabelas Principais

| Tabela | Tamanho | Descrição |
|--------|---------|-----------|
| dados_obd2 | 11 MB | Telemetria OBD2 |
| localizacoes_2026_01 | 11 MB | Posições Janeiro/2026 |
| localizacoes_2026_02 | 1.7 MB | Posições Fevereiro/2026 |
| dispositivos | 216 KB | Cadastro de rastreadores |
| geofences | - | Cercas virtuais |

---

## 6. Dados do Sistema

| Entidade | Quantidade |
|----------|------------|
| **Dispositivos** | 7 |
| ├─ Online | 4 |
| └─ Offline | 3 |
| **Por Tipo** | |
| ├─ XT40_4F (cabo) | 4 |
| ├─ XT40_OBD2 | 2 |
| └─ XT40_UNKNOWN | 1 |
| **Organizações** | 3 |
| **Usuários** | 6 |
| **Cercas Virtuais** | 2 |

---

## 7. Fluxo de Dados

```
┌─────────────┐     TCP        ┌─────────────┐     Redis Stream    ┌─────────────┐
│ Rastreador  │ ──────────────▶│ TCP Gateway │ ──────────────────▶ │  Processor  │
│ (Veículo)   │   GT06/Codec8  │  (Parser)   │    location:stream  │  (Worker)   │
└─────────────┘                └─────────────┘                     └──────┬──────┘
                                                                          │
                                                                          ▼
┌─────────────┐     HTTP/WS    ┌─────────────┐     SQL/Prisma      ┌─────────────┐
│  Frontend   │ ◀─────────────▶│  API Server │ ◀──────────────────▶│  PostgreSQL │
│  (Browser)  │                │  (Node.js)  │                     │  (Database) │
└─────────────┘                └─────────────┘                     └─────────────┘
```

### Etapas do Processamento

1. **Recepção**: TCP Gateway recebe pacote do rastreador
2. **Parsing**: Decodifica protocolo GT06 ou Codec8
3. **Publicação**: Envia para Redis Stream
4. **Processamento**: Worker consome e processa
5. **Persistência**: Salva no PostgreSQL
6. **Notificação**: WebSocket envia para frontend

---

## 8. Funcionalidades Implementadas

### Rastreamento
- ✅ Localização em tempo real (GPS)
- ✅ Histórico de posições
- ✅ Velocidade e direção
- ✅ Status de ignição (ligado/desligado/movimento)
- ✅ Tensão da bateria

### Telemetria OBD2
- ✅ RPM do motor
- ✅ Temperatura do motor
- ✅ Nível de combustível
- ✅ Odômetro

### Cercas Virtuais (Geofencing)
- ✅ Criação de cercas circulares
- ✅ Alertas de entrada/saída
- ✅ Histórico de eventos

### Gestão
- ✅ Multi-tenant (organizações)
- ✅ Controle de permissões (RBAC)
- ✅ Pré-cadastro de dispositivos
- ✅ Auditoria de ações

### App Mobile
- ✅ App Motorista (Expo/React Native)
- ✅ Login com QR Code
- ✅ Visualização de viagens

---

## 9. Escalabilidade

### Capacidade Atual
- **Conexões TCP simultâneas**: 6.000 (2.000 por gateway × 3)
- **Requisições HTTP**: Load balanced entre 2 APIs
- **Processamento**: 3 workers de localização em paralelo

### Para Escalar (5.000+ dispositivos)
```bash
# Adicionar mais gateways
docker compose -f docker-compose.scalable.yml up -d --scale tcp-gateway=5

# Adicionar mais processadores
docker compose -f docker-compose.scalable.yml up -d --scale location-processor=5
```

---

## 10. Comandos de Operação

### Iniciar Sistema
```bash
cd /home/tomelin/rastreador/codigo
docker compose -f docker-compose.scalable.yml up -d
```

### Parar Sistema
```bash
docker compose -f docker-compose.scalable.yml down
```

### Ver Logs
```bash
# Todos os containers
docker compose -f docker-compose.scalable.yml logs -f

# Container específico
docker logs -f rastreador-tcp-gw-1
```

### Reiniciar Serviço
```bash
docker compose -f docker-compose.scalable.yml restart api-server-1
```

### Rebuild após mudanças de código
```bash
docker compose -f docker-compose.scalable.yml build api-server-1 api-server-2 --no-cache
docker compose -f docker-compose.scalable.yml up -d api-server-1 api-server-2
```

---

## 11. URLs de Acesso

| Serviço | URL |
|---------|-----|
| **Frontend Admin** | http://187.85.164.97:62000/admin-dashboard.html |
| **Frontend Veículo** | http://187.85.164.97:62000/veiculo-detalhes.html |
| **API REST** | http://187.85.164.97:62000/api/ |
| **HAProxy Stats** | http://187.85.164.97:8404/stats |
| **App Motorista** | Expo Go (QR Code) |

---

## 12. Backup e Recuperação

### Backup do Banco
```bash
docker exec rastreador-db pg_dump -U postgres rastreador_db > backup.sql
```

### Restaurar Banco
```bash
docker exec -i rastreador-db psql -U postgres rastreador_db < backup.sql
```

---

## 13. Monitoramento

### Health Check
Todos os containers possuem health checks automáticos.

### Métricas
- HAProxy Stats: http://187.85.164.97:8404/stats
- API Health: http://187.85.164.97:62000/api/system/health

---

**Documento gerado em:** 04/02/2026 12:30
**Infraestrutura validada:** ✅ Todos os serviços operacionais
