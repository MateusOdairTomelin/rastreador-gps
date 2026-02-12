# Documentação de Infraestrutura - Sistema de Rastreamento GPS

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Requisitos de Hardware](#2-requisitos-de-hardware)
3. [Sistema Operacional](#3-sistema-operacional)
4. [Arquitetura do Sistema](#4-arquitetura-do-sistema)
5. [Componentes e Serviços](#5-componentes-e-serviços)
6. [Cálculo de Capacidade](#6-cálculo-de-capacidade)
7. [Configurações de Produção](#7-configurações-de-produção)
8. [Guia de Instalação](#8-guia-de-instalação)
9. [Segurança](#9-segurança)
10. [Backup e Recovery](#10-backup-e-recovery)
11. [Monitoramento](#11-monitoramento)
12. [Escalabilidade](#12-escalabilidade)
13. [Provedores de Cloud](#13-provedores-de-cloud)
14. [Checklist de Migração](#14-checklist-de-migração)

---

## 1. Visão Geral

### 1.1 Descrição do Sistema

Sistema de rastreamento GPS em tempo real para gestão de frotas, composto por:

- **Backend API REST** - Node.js/Express para gerenciamento
- **Servidor TCP** - Recepção de dados GPS dos rastreadores (protocolo X3Tech/Concox)
- **Banco de Dados** - PostgreSQL com TimescaleDB para séries temporais
- **Cache** - Redis para sessões e dados em tempo real
- **Map Matching** - OSRM para correção de rotas em vias
- **Monitoramento** - Prometheus + Grafana

### 1.2 Capacidade Alvo

| Métrica | Valor |
|---------|-------|
| Rastreadores simultâneos | 1.000 |
| Pacotes GPS/segundo (pico) | 100 |
| Pacotes GPS/dia | ~5.760.000 |
| Retenção de dados | 12 meses |
| Disponibilidade alvo | 99.5% |

---

## 2. Requisitos de Hardware

### 2.1 Configuração Recomendada (1000 rastreadores)

| Recurso | Especificação | Justificativa |
|---------|---------------|---------------|
| **CPU** | 8 vCPUs (x86_64) | Processamento TCP, GPS Pipeline, Map Matching |
| **RAM** | 16 GB DDR4 | Node.js (4GB), PostgreSQL (6GB), Redis (1GB), OSRM (4GB), SO (1GB) |
| **Disco Principal** | 500 GB SSD NVMe | ~50GB/mês de dados + índices + logs |
| **Disco Backup** | 500 GB HDD (opcional) | Backups locais |
| **Rede** | 100 Mbps dedicado | 1000 conexões TCP simultâneas |
| **IP** | 1 IPv4 público fixo | Acesso externo dos rastreadores |

### 2.2 Configuração Mínima (início/testes)

| Recurso | Especificação |
|---------|---------------|
| **CPU** | 4 vCPUs |
| **RAM** | 8 GB |
| **Disco** | 250 GB SSD |
| **Rede** | 50 Mbps |

### 2.3 Configuração para Alta Disponibilidade (2000+ rastreadores)

| Recurso | Especificação |
|---------|---------------|
| **CPU** | 16 vCPUs |
| **RAM** | 32 GB |
| **Disco** | 1 TB SSD NVMe |
| **Rede** | 1 Gbps |
| **Redundância** | 2 VMs em regiões diferentes |

### 2.4 Distribuição de Memória RAM (16GB)

```
┌─────────────────────────────────────────────────────────┐
│                    RAM Total: 16 GB                      │
├─────────────────────────────────────────────────────────┤
│ Node.js App          │████████░░░░░░░░│  4 GB  (25%)    │
│ PostgreSQL           │████████████░░░░│  6 GB  (37.5%)  │
│ Redis                │██░░░░░░░░░░░░░░│  1 GB  (6.25%)  │
│ OSRM Map Matching    │████████░░░░░░░░│  4 GB  (25%)    │
│ Sistema Operacional  │██░░░░░░░░░░░░░░│  1 GB  (6.25%)  │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Sistema Operacional

### 3.1 Recomendação Principal

| Item | Especificação |
|------|---------------|
| **Distribuição** | Ubuntu Server 22.04 LTS |
| **Arquitetura** | x86_64 (AMD64) |
| **Kernel** | 5.15+ (incluído) |
| **Suporte** | Até Abril 2027 |

### 3.2 Alternativas Suportadas

| SO | Versão | Prós | Contras |
|----|--------|------|---------|
| **Ubuntu Server** | 22.04 LTS | Melhor suporte Docker, comunidade ativa | - |
| **Ubuntu Server** | 24.04 LTS | Mais recente, kernel 6.x | Menos testado |
| **Debian** | 12 (Bookworm) | Muito estável, leve | Pacotes mais antigos |
| **Rocky Linux** | 9 | Enterprise-grade, substituto CentOS | Menos documentação |
| **Alpine Linux** | 3.19 | Ultra leve (50MB) | Menos ferramentas |

### 3.3 Requisitos do SO

- Suporte a Docker 24.0+
- Suporte a Docker Compose v2
- Systemd como init system
- Suporte a cgroups v2
- OpenSSL 3.0+

---

## 4. Arquitetura do Sistema

### 4.1 Diagrama de Arquitetura

```
                                    INTERNET
                                        │
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    │           ┌───────▼───────┐           │
                    │           │   Firewall    │           │
                    │           │   (UFW)       │           │
                    │           └───────┬───────┘           │
                    │                   │                   │
        ┌───────────┼───────────────────┼───────────────────┼───────────┐
        │           │                   │                   │           │
   ┌────▼────┐ ┌────▼────┐        ┌─────▼─────┐       ┌─────▼─────┐     │
   │TCP:8877 │ │TCP:8878 │        │ HTTP:443  │       │ HTTP:3000 │     │
   │GPS Data │ │OBD2 Data│        │ API REST  │       │ Grafana   │     │
   └────┬────┘ └────┬────┘        └─────┬─────┘       └─────┬─────┘     │
        │           │                   │                   │           │
        └───────────┴─────────┬─────────┴───────────────────┘           │
                              │                                         │
                       ┌──────▼──────┐                                  │
                       │             │                                  │
                       │  Docker     │                                  │
                       │  Network    │                                  │
                       │             │                                  │
                       └──────┬──────┘                                  │
                              │                                         │
        ┌─────────────────────┼─────────────────────┐                   │
        │                     │                     │                   │
   ┌────▼────┐          ┌─────▼─────┐         ┌────▼────┐              │
   │ Node.js │◄────────►│  Redis    │         │  OSRM   │              │
   │   App   │          │  Cache    │         │ MapMatch│              │
   └────┬────┘          └───────────┘         └─────────┘              │
        │                                                               │
        │              ┌─────────────┐                                  │
        └─────────────►│  PgBouncer  │                                  │
                       │  Pool       │                                  │
                       └──────┬──────┘                                  │
                              │                                         │
                       ┌──────▼──────┐                                  │
                       │ PostgreSQL  │                                  │
                       │ TimescaleDB │                                  │
                       └─────────────┘                                  │
                                                                        │
                              VM / Servidor                              │
        └───────────────────────────────────────────────────────────────┘
```

### 4.2 Portas Utilizadas

| Porta | Protocolo | Serviço | Acesso |
|-------|-----------|---------|--------|
| 22 | TCP | SSH | Restrito (IP específico) |
| 80 | TCP | HTTP (redirect) | Público |
| 443 | TCP | HTTPS (API) | Público |
| 3000 | TCP | Grafana | Restrito |
| 5432 | TCP | PostgreSQL | Interno |
| 6379 | TCP | Redis | Interno |
| 6432 | TCP | PgBouncer | Interno |
| 8877 | TCP | GPS Data | Público |
| 8878 | TCP | OBD2 Data | Público |
| 9090 | TCP | Prometheus | Interno |
| 62000 | TCP | API HTTP | Público |

### 4.3 Fluxo de Dados GPS

```
Rastreador GPS
      │
      │ TCP (porta 8877)
      │ Protocolo X3Tech/Concox
      ▼
┌─────────────┐
│  TCP Server │ ─── Parse do pacote binário
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Parser    │ ─── Extração: IMEI, coordenadas, velocidade, etc.
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ GPS Pipeline│ ─── Filtro Kalman → Detecção Outliers → Map Matching
└──────┬──────┘
       │
       ├──────────────┐
       │              │
       ▼              ▼
┌─────────────┐ ┌─────────────┐
│   Redis     │ │ PostgreSQL  │
│ (tempo real)│ │ (histórico) │
└─────────────┘ └─────────────┘
```

---

## 5. Componentes e Serviços

### 5.1 Containers Docker

| Container | Imagem | Função | Recursos |
|-----------|--------|--------|----------|
| **rastreador-app** | Node.js 20 Alpine | Aplicação principal | 4GB RAM, 4 CPU |
| **rastreador-db** | timescale/timescaledb:pg15 | Banco de dados | 6GB RAM, 2 CPU |
| **rastreador-redis** | redis:7-alpine | Cache e sessões | 1GB RAM |
| **rastreador-pgbouncer** | edoburu/pgbouncer | Connection pooling | 128MB RAM |
| **rastreador-grafana** | grafana/grafana | Dashboards | 256MB RAM |
| **rastreador-prometheus** | prom/prometheus | Métricas | 256MB RAM |
| **osrm-backend** | osrm/osrm-backend | Map matching | 4GB RAM |

### 5.2 Volumes de Dados

| Volume | Caminho no Host | Conteúdo | Backup |
|--------|-----------------|----------|--------|
| postgres_data | /var/lib/docker/volumes/postgres_data | Dados PostgreSQL | Sim |
| redis_data | /var/lib/docker/volumes/redis_data | Dados Redis | Não |
| app_logs | /var/lib/docker/volumes/app_logs | Logs da aplicação | Sim |
| grafana_data | /var/lib/docker/volumes/grafana_data | Dashboards | Sim |
| osrm_data | /var/lib/docker/volumes/osrm_data | Mapas OSRM | Não |

---

## 6. Cálculo de Capacidade

### 6.1 Volume de Dados GPS

#### Premissas
- Intervalo de envio: 10-30 segundos (média: 15s)
- Horas de operação: 12h/dia (frota comercial típica)
- Dias de operação: 26 dias/mês

#### Cálculo para 1000 Rastreadores

```
Pacotes por rastreador:
  - Por minuto: 4 pacotes (intervalo 15s)
  - Por hora: 240 pacotes
  - Por dia (12h): 2.880 pacotes
  - Por mês (26 dias): 74.880 pacotes

Total da frota (1000 rastreadores):
  - Por minuto: 4.000 pacotes
  - Por hora: 240.000 pacotes
  - Por dia: 2.880.000 pacotes
  - Por mês: 74.880.000 pacotes

Tamanho dos dados:
  - Registro de localização: ~250 bytes (com índices)
  - Por dia: 2.880.000 × 250 = 720 MB
  - Por mês: 74.880.000 × 250 = 18.7 GB
  - Por ano: ~225 GB (apenas localizações)

Total com todos os dados (OBD2, logs, etc.):
  - Por mês: ~50 GB
  - Por ano: ~600 GB
```

### 6.2 Throughput de Rede

```
Tamanho médio do pacote TCP: 65 bytes
Pacotes por segundo (pico): 100

Bandwidth de entrada (rastreadores):
  - Normal: 100 × 65 = 6.5 KB/s = 52 Kbps
  - Pico: 200 × 65 = 13 KB/s = 104 Kbps

Bandwidth de saída (API/Dashboard):
  - Estimado: 1-5 Mbps (depende do uso)

Total recomendado: 100 Mbps (com folga)
```

### 6.3 Conexões Simultâneas

```
Conexões TCP (rastreadores):
  - Ativas: 1000 (uma por rastreador)
  - Buffer: +20% = 1200 conexões

Conexões HTTP (API):
  - Usuários simultâneos: ~50
  - Conexões por usuário: ~5
  - Total: ~250 conexões

Conexões PostgreSQL:
  - Pool size: 100 (via PgBouncer)
  - Max connections: 200
```

---

## 7. Configurações de Produção

### 7.1 PostgreSQL (postgresql.conf)

```conf
# Memória
shared_buffers = 4GB                    # 25% da RAM total
effective_cache_size = 12GB             # 75% da RAM total
work_mem = 256MB                        # Para ordenações/joins
maintenance_work_mem = 1GB              # Para VACUUM, índices
huge_pages = try                        # Melhor performance

# Conexões
max_connections = 200                   # Via PgBouncer
superuser_reserved_connections = 3

# WAL e Checkpoint
wal_buffers = 64MB
checkpoint_completion_target = 0.9
max_wal_size = 4GB
min_wal_size = 1GB

# Query Planner
random_page_cost = 1.1                  # SSD
effective_io_concurrency = 200          # SSD

# Logging
log_min_duration_statement = 1000       # Log queries > 1s
log_checkpoints = on
log_connections = on
log_disconnections = on

# TimescaleDB
shared_preload_libraries = 'timescaledb'
timescaledb.max_background_workers = 8
```

### 7.2 PgBouncer (pgbouncer.ini)

```ini
[databases]
rastreador_db = host=postgres port=5432 dbname=rastreador_db

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = md5
auth_file = /etc/pgbouncer/userlist.txt

pool_mode = transaction
max_client_conn = 1000
default_pool_size = 50
min_pool_size = 10
reserve_pool_size = 25
reserve_pool_timeout = 3

# Timeouts
server_connect_timeout = 15
server_idle_timeout = 600
server_lifetime = 3600
client_idle_timeout = 0
client_login_timeout = 60
query_timeout = 0
query_wait_timeout = 120

# Logging
log_connections = 1
log_disconnections = 1
log_pooler_errors = 1
stats_period = 60
```

### 7.3 Redis (redis.conf)

```conf
# Memória
maxmemory 1gb
maxmemory-policy allkeys-lru

# Persistência
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec

# Rede
tcp-keepalive 300
timeout 0

# Segurança
requirepass ${REDIS_PASSWORD}
```

### 7.4 Node.js (Environment)

```bash
# Variáveis de ambiente
NODE_ENV=production
NODE_OPTIONS="--max-old-space-size=4096"

# Cluster (opcional para múltiplos cores)
CLUSTER_WORKERS=4

# Limites
UV_THREADPOOL_SIZE=16
```

### 7.5 Kernel Linux (sysctl.conf)

```conf
# Conexões TCP
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.core.netdev_max_backlog = 65535

# Buffers de rede
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# File descriptors
fs.file-max = 1000000
fs.nr_open = 1000000

# Memória
vm.swappiness = 10
vm.dirty_ratio = 60
vm.dirty_background_ratio = 2
```

### 7.6 Limits (limits.conf)

```conf
# /etc/security/limits.conf
* soft nofile 1000000
* hard nofile 1000000
* soft nproc 65535
* hard nproc 65535
root soft nofile 1000000
root hard nofile 1000000
```

---

## 8. Guia de Instalação

### 8.1 Preparação do Sistema

```bash
#!/bin/bash
# Script de instalação - Ubuntu 22.04 LTS

# 1. Atualizar sistema
sudo apt update && sudo apt upgrade -y

# 2. Instalar dependências
sudo apt install -y \
    curl \
    wget \
    git \
    htop \
    iotop \
    net-tools \
    ufw \
    fail2ban \
    unzip \
    jq

# 3. Configurar timezone
sudo timedatectl set-timezone America/Sao_Paulo

# 4. Configurar hostname
sudo hostnamectl set-hostname rastreador-prod
```

### 8.2 Instalação do Docker

```bash
#!/bin/bash

# Remover versões antigas
sudo apt remove -y docker docker-engine docker.io containerd runc 2>/dev/null

# Instalar Docker
curl -fsSL https://get.docker.com | sh

# Adicionar usuário ao grupo docker
sudo usermod -aG docker $USER

# Instalar Docker Compose plugin
sudo apt install -y docker-compose-plugin

# Verificar instalação
docker --version
docker compose version

# Configurar Docker para iniciar no boot
sudo systemctl enable docker
sudo systemctl start docker
```

### 8.3 Configuração do Firewall

```bash
#!/bin/bash

# Habilitar UFW
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (restringir a IPs específicos em produção)
sudo ufw allow 22/tcp

# HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Portas da aplicação
sudo ufw allow 8877/tcp comment 'GPS TCP'
sudo ufw allow 8878/tcp comment 'OBD2 TCP'
sudo ufw allow 62000/tcp comment 'API HTTP'

# Grafana (restringir a IPs específicos)
sudo ufw allow from 192.168.0.0/16 to any port 3000 comment 'Grafana'

# Ativar firewall
sudo ufw enable
sudo ufw status verbose
```

### 8.4 Configuração de Swap

```bash
#!/bin/bash

# Criar arquivo de swap de 4GB
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Tornar permanente
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Ajustar swappiness
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### 8.5 Otimizações de Kernel

```bash
#!/bin/bash

# Criar arquivo de configuração
sudo tee /etc/sysctl.d/99-rastreador.conf << 'EOF'
# Conexões TCP
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.core.netdev_max_backlog = 65535

# Buffers de rede
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# File descriptors
fs.file-max = 1000000

# Memória
vm.swappiness = 10
vm.dirty_ratio = 60
vm.dirty_background_ratio = 2
EOF

# Aplicar configurações
sudo sysctl -p /etc/sysctl.d/99-rastreador.conf

# Configurar limits
sudo tee /etc/security/limits.d/99-rastreador.conf << 'EOF'
* soft nofile 1000000
* hard nofile 1000000
* soft nproc 65535
* hard nproc 65535
EOF
```

### 8.6 Deploy da Aplicação

```bash
#!/bin/bash

# 1. Clonar repositório (ou copiar arquivos)
cd /opt
git clone https://seu-repositorio/rastreador.git
cd rastreador

# 2. Configurar variáveis de ambiente
cp .env.example .env
nano .env  # Editar com suas configurações

# 3. Criar diretórios necessários
mkdir -p logs data backups

# 4. Build e iniciar containers
docker compose build --no-cache
docker compose up -d

# 5. Verificar status
docker compose ps
docker compose logs -f app
```

---

## 9. Segurança

### 9.1 Checklist de Segurança

- [ ] Firewall (UFW) configurado e ativo
- [ ] Fail2ban instalado e configurado
- [ ] SSH com chave pública (desabilitar senha)
- [ ] Usuário root desabilitado para SSH
- [ ] SSL/TLS configurado (Let's Encrypt)
- [ ] Senhas fortes para todos os serviços
- [ ] ENCRYPTION_KEY configurada para LGPD
- [ ] Backups criptografados
- [ ] Logs de auditoria habilitados
- [ ] Atualizações automáticas de segurança

### 9.2 Configuração SSH Seguro

```bash
# /etc/ssh/sshd_config
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
AllowUsers seu_usuario
```

### 9.3 Fail2ban para SSH

```ini
# /etc/fail2ban/jail.local
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
findtime = 600
```

### 9.4 SSL/TLS com Let's Encrypt

```bash
#!/bin/bash

# Instalar Certbot
sudo apt install -y certbot

# Obter certificado
sudo certbot certonly --standalone -d seu-dominio.com.br

# Renovação automática (já configurada pelo certbot)
sudo systemctl enable certbot.timer
```

### 9.5 Variáveis Sensíveis (.env)

```bash
# NUNCA commitar o .env no repositório!

# Gerar JWT_SECRET seguro
openssl rand -base64 64

# Gerar ENCRYPTION_KEY seguro
openssl rand -hex 32

# Gerar senhas seguras
openssl rand -base64 32
```

---

## 10. Backup e Recovery

### 10.1 Estratégia de Backup

| Tipo | Frequência | Retenção | Destino |
|------|------------|----------|---------|
| Full DB | Diário (3h) | 7 dias | Local + S3 |
| Incremental | Hora em hora | 24 horas | Local |
| Configurações | Diário | 30 dias | Git + S3 |
| Logs | Diário | 30 dias | Local |

### 10.2 Script de Backup PostgreSQL

```bash
#!/bin/bash
# /home/tomelin/rastreador/scripts/backup-db.sh

set -e

BACKUP_DIR="/home/tomelin/rastreador/backups"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

# Criar diretório se não existir
mkdir -p $BACKUP_DIR

# Backup do banco
docker compose exec -T postgres pg_dump -U postgres -Fc rastreador_db \
    > "$BACKUP_DIR/rastreador_db_$DATE.dump"

# Compactar
gzip "$BACKUP_DIR/rastreador_db_$DATE.dump"

# Remover backups antigos
find $BACKUP_DIR -name "*.dump.gz" -mtime +$RETENTION_DAYS -delete

# Upload para S3 (opcional)
# aws s3 cp "$BACKUP_DIR/rastreador_db_$DATE.dump.gz" s3://seu-bucket/backups/

echo "Backup concluído: rastreador_db_$DATE.dump.gz"
```

### 10.3 Cron para Backup Automático

```bash
# Editar crontab
crontab -e

# Adicionar linha (backup às 3h da manhã)
0 3 * * * /home/tomelin/rastreador/scripts/backup-db.sh >> /var/log/backup.log 2>&1
```

### 10.4 Restore do Backup

```bash
#!/bin/bash
# Restore de backup

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
    echo "Uso: $0 <arquivo_backup.dump.gz>"
    exit 1
fi

# Descompactar se necessário
if [[ $BACKUP_FILE == *.gz ]]; then
    gunzip -k $BACKUP_FILE
    BACKUP_FILE=${BACKUP_FILE%.gz}
fi

# Parar aplicação
docker compose stop app

# Restore
docker compose exec -T postgres pg_restore -U postgres -d rastreador_db \
    --clean --if-exists < $BACKUP_FILE

# Reiniciar aplicação
docker compose start app

echo "Restore concluído!"
```

---

## 11. Monitoramento

### 11.1 Métricas Importantes

| Métrica | Alerta Warning | Alerta Critical |
|---------|----------------|-----------------|
| CPU Usage | > 70% | > 90% |
| RAM Usage | > 80% | > 95% |
| Disco Usage | > 70% | > 90% |
| Conexões TCP | > 800 | > 950 |
| Latência API | > 500ms | > 2000ms |
| Erro Rate | > 1% | > 5% |
| DB Connections | > 150 | > 190 |

### 11.2 Endpoints de Health Check

```
GET /api/status              - Status básico
GET /api/system/health       - Saúde completa do sistema
GET /api/system/metrics      - Métricas detalhadas (admin)
GET /api/heartbeats          - Status dos rastreadores
```

### 11.3 Dashboards Grafana

Dashboards incluídos:
- **Sistema** - CPU, RAM, Disco, Rede
- **Aplicação** - Requests, Latência, Erros
- **PostgreSQL** - Conexões, Queries, Cache
- **Redis** - Memória, Comandos, Conexões
- **Rastreadores** - Online, Offline, Pacotes/s

### 11.4 Alertas Recomendados

```yaml
# Exemplo de alerta Prometheus
groups:
  - name: rastreador
    rules:
      - alert: HighCPUUsage
        expr: node_cpu_seconds_total > 90
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "CPU alta no servidor"

      - alert: LowDiskSpace
        expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Disco com menos de 10% livre"

      - alert: HighMemoryUsage
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Memória com menos de 10% livre"
```

---

## 12. Escalabilidade

### 12.1 Escalabilidade Vertical (Scale Up)

| Rastreadores | CPU | RAM | Disco |
|--------------|-----|-----|-------|
| 500 | 4 vCPU | 8 GB | 250 GB |
| 1.000 | 8 vCPU | 16 GB | 500 GB |
| 2.000 | 16 vCPU | 32 GB | 1 TB |
| 5.000 | 32 vCPU | 64 GB | 2 TB |

### 12.2 Escalabilidade Horizontal (Scale Out)

Para mais de 5.000 rastreadores, considerar arquitetura distribuída:

```
                    ┌─────────────────┐
                    │  Load Balancer  │
                    │    (HAProxy)    │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
    ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
    │   Node 1    │   │   Node 2    │   │   Node 3    │
    │  (TCP+API)  │   │  (TCP+API)  │   │  (TCP+API)  │
    └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Redis Cluster  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   PostgreSQL    │
                    │ (Primary+Replica)│
                    └─────────────────┘
```

### 12.3 Otimizações para Alta Escala

1. **Particionamento de dados** - TimescaleDB já faz por tempo
2. **Connection pooling** - PgBouncer já configurado
3. **Cache agressivo** - Redis para dados frequentes
4. **Compressão de dados** - TimescaleDB compression
5. **Índices otimizados** - Já criados no schema

---

## 13. Provedores de Cloud

### 13.1 Comparativo de Preços (Config. Recomendada)

| Provedor | Configuração | Preço/mês | Observações |
|----------|--------------|-----------|-------------|
| **Hetzner** | CPX41 (8vCPU/16GB/240GB) | €30 (~R$170) | Melhor custo-benefício |
| **Contabo** | VPS M (6vCPU/16GB/400GB) | €12 (~R$70) | Mais barato, performance OK |
| **DigitalOcean** | Premium Droplet 8vCPU/16GB | $96 (~R$500) | Bom suporte, mais caro |
| **Vultr** | High Frequency 8vCPU/16GB | $96 (~R$500) | SSD NVMe rápido |
| **AWS EC2** | t3.xlarge (4vCPU/16GB) | ~$120 (~R$620) | Enterprise, mais caro |
| **Oracle Cloud** | VM.Standard.E4.Flex | Grátis (Free Tier) | 4 vCPU/24GB grátis |

### 13.2 Recomendação por Cenário

| Cenário | Recomendação |
|---------|--------------|
| **Menor custo** | Contabo VPS M |
| **Melhor custo-benefício** | Hetzner CPX41 |
| **Produção crítica** | DigitalOcean ou AWS |
| **Teste/Desenvolvimento** | Oracle Cloud Free Tier |
| **Brasil (baixa latência)** | Locaweb, Hostinger Brasil |

### 13.3 Requisitos do Datacenter

- Localização: Brasil ou América do Sul (latência < 50ms)
- Uptime SLA: 99.9% ou superior
- Backup de energia (UPS + Gerador)
- Rede redundante
- Suporte 24/7 (produção crítica)

---

## 14. Checklist de Migração

### 14.1 Pré-Migração

- [ ] Nova VM provisionada e acessível
- [ ] Sistema operacional instalado (Ubuntu 22.04 LTS)
- [ ] Docker e Docker Compose instalados
- [ ] Firewall configurado
- [ ] DNS configurado (ou IP fixo anotado)
- [ ] Backup completo do ambiente atual
- [ ] Certificado SSL obtido (se usando domínio)

### 14.2 Migração

- [ ] Copiar arquivos da aplicação para nova VM
- [ ] Copiar arquivo .env com configurações
- [ ] Restaurar backup do banco de dados
- [ ] Build dos containers Docker
- [ ] Iniciar serviços
- [ ] Verificar logs de erro
- [ ] Testar endpoints da API
- [ ] Testar conexão TCP (porta 8877)

### 14.3 Pós-Migração

- [ ] Atualizar IP/DNS nos rastreadores (se necessário)
- [ ] Verificar se rastreadores estão conectando
- [ ] Monitorar performance por 24-48h
- [ ] Configurar backups automáticos
- [ ] Configurar monitoramento/alertas
- [ ] Documentar nova infraestrutura
- [ ] Desligar servidor antigo (após validação)

### 14.4 Rollback (se necessário)

```bash
# Se precisar voltar ao servidor antigo:

# 1. Parar aplicação no novo servidor
docker compose down

# 2. Reverter DNS/IP para servidor antigo

# 3. Verificar se servidor antigo ainda está operacional

# 4. Investigar problema no novo servidor
docker compose logs -f
```

---

## Apêndice A: Comandos Úteis

### Gerenciamento Docker

```bash
# Ver status dos containers
docker compose ps

# Ver logs em tempo real
docker compose logs -f app

# Reiniciar um serviço
docker compose restart app

# Parar tudo
docker compose down

# Iniciar tudo
docker compose up -d

# Rebuild e reiniciar
docker compose build --no-cache && docker compose up -d
```

### Monitoramento

```bash
# Ver uso de recursos dos containers
docker stats

# Ver conexões TCP ativas
ss -tuln | grep -E "8877|8878|62000"

# Ver processos por uso de CPU
htop

# Ver uso de disco
df -h

# Ver logs do sistema
journalctl -f
```

### Banco de Dados

```bash
# Acessar PostgreSQL
docker compose exec postgres psql -U postgres -d rastreador_db

# Ver tamanho das tabelas
docker compose exec postgres psql -U postgres -d rastreador_db -c "
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;
"

# Ver conexões ativas
docker compose exec postgres psql -U postgres -c "SELECT * FROM pg_stat_activity;"
```

### Redis

```bash
# Acessar Redis CLI
docker compose exec redis redis-cli

# Ver estatísticas
docker compose exec redis redis-cli INFO

# Ver memória usada
docker compose exec redis redis-cli INFO memory
```

---

## Apêndice B: Troubleshooting

### Problema: Rastreadores não conectam

```bash
# Verificar se porta está aberta
nc -zv localhost 8877

# Verificar firewall
sudo ufw status

# Verificar logs TCP
docker compose logs app | grep TCP
```

### Problema: API lenta

```bash
# Verificar uso de recursos
docker stats

# Verificar queries lentas
docker compose exec postgres psql -U postgres -d rastreador_db -c "
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - pg_stat_activity.query_start > interval '5 seconds';
"
```

### Problema: Disco cheio

```bash
# Ver uso de disco
df -h

# Limpar logs antigos
docker compose exec app find /app/logs -mtime +7 -delete

# Limpar imagens Docker não usadas
docker system prune -a
```

### Problema: Memória insuficiente

```bash
# Ver uso de memória
free -h

# Ver processos por memória
ps aux --sort=-%mem | head -20

# Reiniciar containers para liberar memória
docker compose restart
```

---

**Documento gerado em:** Janeiro/2026
**Versão:** 1.0
**Autor:** Sistema de Documentação Automatizada
