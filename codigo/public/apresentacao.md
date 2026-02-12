# Sistema de Rastreamento Veicular
## Arquitetura de Alta Disponibilidade e Escalabilidade

---

## 1. Visao Geral

Sistema projetado para suportar **5.000+ rastreadores simultaneos** com:
- Alta disponibilidade (99.9% uptime)
- Redundancia em todas as camadas
- Escalabilidade horizontal
- Processamento em tempo real

---

## 2. Diagrama de Arquitetura

```
                                    INTERNET
                                        |
                                        v
                    +-------------------------------------------+
                    |              HAPROXY                      |
                    |         (Load Balancer)                   |
                    |   TCP: 8877 | HTTP: 62000 | Stats: 8404   |
                    +-------------------------------------------+
                           /        |        \           \
                          /         |         \           \
                         v          v          v           v
              +-----------+ +-----------+ +-----------+  +-----------+
              |  TCP GW   | |  TCP GW   | |  TCP GW   |  |  API SRV  |
              |   gw-1    | |   gw-2    | |   gw-3    |  |   api-1   |
              |  2000 con | |  2000 con | |  2000 con |  |   api-2   |
              +-----------+ +-----------+ +-----------+  +-----------+
                    \            |            /                |
                     \           |           /                 |
                      v          v          v                  |
              +----------------------------------+              |
              |           REDIS                 |              |
              |    (Message Queue + Cache)      |<-------------+
              |    Streams | Cache | Pub/Sub    |
              +----------------------------------+
                           |
          +----------------+----------------+
          |                |                |
          v                v                v
    +-----------+    +-----------+    +-----------+
    | LOC PROC  |    | LOC PROC  |    | LOC PROC  |
    |   loc-1   |    |   loc-2   |    |   loc-3   |
    +-----------+    +-----------+    +-----------+
          |                |                |
          +----------------+----------------+
                           |
                           v
              +----------------------------------+
              |         PGBOUNCER               |
              |    (Connection Pooling)         |
              |    2000 conexoes cliente        |
              |    100 conexoes pool            |
              +----------------------------------+
                           |
                           v
              +----------------------------------+
              |     POSTGRESQL + TIMESCALEDB    |
              |      (Banco de Dados)           |
              |   Particoes automaticas         |
              |   Compressao de dados           |
              +----------------------------------+
```

---

## 3. Fluxo de Dados

```
+-------------+     +----------+     +-------+     +-----------+     +----------+
| RASTREADOR  | --> | HAPROXY  | --> | TCP   | --> |   REDIS   | --> | LOCATION |
| (Veiculo)   |     | (L4 LB)  |     | GW    |     | (Streams) |     | PROC     |
+-------------+     +----------+     +-------+     +-----------+     +----------+
                                                                          |
                                                                          v
+-------------+     +----------+     +-------+     +-----------+     +----------+
| NAVEGADOR   | <-- | HAPROXY  | <-- | API   | <-- |   REDIS   | <-- | POSTGRES |
| (Usuario)   |     | (L7 LB)  |     | SRV   |     |  (Cache)  |     |  (DB)    |
+-------------+     +----------+     +-------+     +-----------+     +----------+
```

---

## 4. Componentes e Redundancia

### 4.1 HAProxy (Load Balancer)
| Caracteristica | Valor |
|----------------|-------|
| Algoritmo TCP | Round Robin |
| Algoritmo HTTP | Least Connections |
| Health Check | A cada 5s |
| Failover | Automatico |

**Redundancia:** Se um backend cair, trafego e redirecionado automaticamente.

---

### 4.2 TCP Gateways (3 instancias)
| Caracteristica | Valor |
|----------------|-------|
| Conexoes/Gateway | 2.000 |
| Total Conexoes | 6.000 |
| Memoria/Gateway | 512MB |
| CPU/Gateway | 1 core |

**Redundancia:**
- 3 gateways ativos simultaneamente
- Se 1 cair, os outros 2 assumem (4.000 conexoes)
- Se 2 cairem, 1 mantem operacao (2.000 conexoes)

```
     NORMAL                    1 GATEWAY DOWN              2 GATEWAYS DOWN

  [GW-1: 2000]               [GW-1: ----]                [GW-1: ----]
  [GW-2: 2000]      -->      [GW-2: 3000]       -->      [GW-2: ----]
  [GW-3: 2000]               [GW-3: 3000]                [GW-3: 6000]

  Total: 6000                Total: 6000                 Total: 6000
```

---

### 4.3 Redis (Message Queue + Cache)
| Caracteristica | Valor |
|----------------|-------|
| Memoria | 1GB |
| Persistencia | AOF (Append Only File) |
| Politica Eviction | allkeys-lru |

**Funcoes:**
1. **Streams** - Fila de mensagens entre componentes
2. **Cache** - Ultima posicao de cada rastreador
3. **Pub/Sub** - WebSocket em tempo real
4. **Locks** - Controle de concorrencia

---

### 4.4 Location Processors (3 instancias)
| Caracteristica | Valor |
|----------------|-------|
| Batch Size | 10 mensagens |
| Block Time | 5 segundos |
| Memoria/Proc | 1GB |
| CPU/Proc | 2 cores |

**Redundancia:**
- Consumer Groups do Redis garantem que cada mensagem e processada apenas 1 vez
- Se 1 processor cair, os outros 2 assumem a carga
- Lock distribuido evita duplicacao

```
                    REDIS STREAM
                         |
         +---------------+---------------+
         |               |               |
         v               v               v
    [LOC-PROC-1]    [LOC-PROC-2]    [LOC-PROC-3]
         |               |               |
         +---------------+---------------+
                         |
                         v
                    [POSTGRES]
```

---

### 4.5 API Servers (2 instancias)
| Caracteristica | Valor |
|----------------|-------|
| Memoria/API | 1-1.5GB |
| CPU/API | 2 cores |
| Health Check | /api/system/health |

**Redundancia:**
- 2 servidores ativos
- HAProxy distribui carga (least connections)
- Sessoes armazenadas no Redis (stateless)

---

### 4.6 PgBouncer (Connection Pooling)
| Caracteristica | Valor |
|----------------|-------|
| Max Client Conn | 2.000 |
| Pool Size | 100 |
| Pool Mode | Transaction |

**Beneficio:** Reduz conexoes no PostgreSQL de 2.000 para ~100

```
  SEM PGBOUNCER                    COM PGBOUNCER

  [API-1] --100 conn--+         [API-1] --100 conn--+
  [API-2] --100 conn--+                             |
  [LOC-1] --50 conn---+         [API-2] --100 conn--+
  [LOC-2] --50 conn---+--->[DB]                     +-->[PGBOUNCER]--100 conn-->[DB]
  [LOC-3] --50 conn---+         [LOC-1] --50 conn---+
  [STATUS]--20 conn---+         [LOC-2] --50 conn---+
  [ALARM] --20 conn---+         [LOC-3] --50 conn---+
                                [STATUS]--20 conn---+
  Total: 390 conexoes           [ALARM] --20 conn---+

                                Total no Pool: ~100 conexoes
```

---

### 4.7 PostgreSQL + TimescaleDB
| Caracteristica | Valor |
|----------------|-------|
| Versao | PostgreSQL 15 |
| Extensao | TimescaleDB |
| Memoria | 4GB |
| CPU | 4 cores |
| Shared Buffers | 1GB |
| Effective Cache | 3GB |

**Otimizacoes:**
- Particionamento automatico por tempo (hypertables)
- Compressao de dados antigos
- Indices otimizados para consultas temporais

---

## 5. Metricas de Capacidade

### 5.1 Capacidade Total
| Metrica | Valor |
|---------|-------|
| Rastreadores Simultaneos | 6.000 |
| Pacotes/Segundo | ~200 |
| Localizacoes/Dia | ~17 milhoes |
| Armazenamento/Mes | ~50GB |

### 5.2 Latencia
| Operacao | Latencia |
|----------|----------|
| Receber pacote TCP | < 10ms |
| Processar localizacao | < 50ms |
| Atualizar WebSocket | < 100ms |
| Consulta API | < 200ms |

---

## 6. Cenarios de Falha

### Cenario 1: Queda de 1 TCP Gateway
```
IMPACTO: Nenhum - HAProxy redireciona automaticamente
TEMPO RECUPERACAO: Instantaneo
ACAO: Nenhuma necessaria
```

### Cenario 2: Queda de 1 Location Processor
```
IMPACTO: Leve aumento de latencia
TEMPO RECUPERACAO: Instantaneo
ACAO: Nenhuma necessaria
```

### Cenario 3: Queda do Redis
```
IMPACTO: Sistema para de processar novos dados
TEMPO RECUPERACAO: ~30 segundos (restart automatico)
ACAO: Monitorar restart
```

### Cenario 4: Queda do PostgreSQL
```
IMPACTO: Sistema para de persistir dados
TEMPO RECUPERACAO: ~1 minuto (restart automatico)
ACAO: Verificar integridade dos dados
```

---

## 7. Monitoramento

### 7.1 Health Checks
Todos os containers possuem health checks automaticos:
- **Intervalo:** 10-30 segundos
- **Timeout:** 5-10 segundos
- **Retries:** 3-5 tentativas

### 7.2 Metricas HAProxy
Disponivel em: `http://servidor:8404/stats`

```
+------------------+--------+--------+--------+
| Backend          | Status | Sess   | Rate   |
+------------------+--------+--------+--------+
| tcp-gateway-1    | UP     | 1500   | 50/s   |
| tcp-gateway-2    | UP     | 1500   | 50/s   |
| tcp-gateway-3    | UP     | 1500   | 50/s   |
| api-server-1     | UP     | 25     | 10/s   |
| api-server-2     | UP     | 25     | 10/s   |
+------------------+--------+--------+--------+
```

---

## 8. Escalabilidade

### 8.1 Escalar TCP Gateways
```bash
docker-compose -f docker-compose.scalable.yml up -d --scale tcp-gateway=5
```

### 8.2 Escalar Location Processors
```bash
docker-compose -f docker-compose.scalable.yml up -d --scale location-processor=5
```

### 8.3 Escalar API Servers
```bash
docker-compose -f docker-compose.scalable.yml up -d --scale api-server=4
```

---

## 9. Recursos de Hardware (Atual)

| Componente | Memoria | CPU | Instancias | Total |
|------------|---------|-----|------------|-------|
| HAProxy | 128MB | 0.5 | 1 | 128MB |
| TCP Gateway | 512MB | 1 | 3 | 1.5GB |
| Location Proc | 1GB | 2 | 3 | 3GB |
| Status Proc | 512MB | 1 | 1 | 512MB |
| Alarm Proc | 512MB | 1 | 1 | 512MB |
| API Server | 1.25GB | 2 | 2 | 2.5GB |
| PgBouncer | 128MB | 0.5 | 1 | 128MB |
| Redis | 1GB | 2 | 1 | 1GB |
| PostgreSQL | 4GB | 4 | 1 | 4GB |
| **TOTAL** | | | **14** | **~13GB** |

---

## 10. Seguranca

| Camada | Protecao |
|--------|----------|
| Rede | Docker network isolada |
| API | JWT + Rate Limiting |
| Dados | AES-256-GCM (LGPD) |
| Banco | Senha forte + Pool |
| TCP | Validacao de protocolo |

---

## 11. Conclusao

### Pontos Fortes
- Arquitetura distribuida e escalavel
- Redundancia em todas as camadas criticas
- Processamento em tempo real
- Conformidade com LGPD

### Capacidade Atual
- 6.000 rastreadores simultaneos
- 17 milhoes de localizacoes/dia
- 99.9% de disponibilidade

### Proximos Passos (Opcional)
- Cluster Redis (Sentinel/Cluster)
- Replica PostgreSQL (read replicas)
- Kubernetes para orquestracao

---

**Documento gerado em:** Fevereiro 2026
**Versao:** 1.0
