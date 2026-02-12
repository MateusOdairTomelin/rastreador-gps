# Migração para Docker - GPS Tracker Platform

**Data da Migração:** 2025-12-26
**Status:** COMPLETA E FUNCIONAL

---

## Resumo da Arquitetura

### Antes (Sistema Antigo)
- Node.js via PM2
- PostgreSQL local (porta 5432)
- Redis local (porta 6379)
- OSRM local (porta 5000)

### Agora (Docker)
- **rastreador-app** - Aplicação Node.js
- **rastreador-db** - TimescaleDB (PostgreSQL 15 otimizado para séries temporais)
- **rastreador-redis** - Redis 7 (cache/filas)
- **rastreador-pgbouncer** - Connection pooling
- **rastreador-prometheus** - Métricas
- **rastreador-grafana** - Dashboards
- **osrm-sul-brasil** - Map-matching (externo, conectado à rede)

---

## Portas Expostas

| Serviço | Porta | Descrição |
|---------|-------|-----------|
| HTTP/WebSocket | 62000 | API e Frontend |
| TCP Rastreadores | 8877 | Conexão dos GPS |
| PostgreSQL | 5432 | Banco de dados |
| PgBouncer | 6432 | Connection pool |
| Redis | 6379 | Cache |
| Prometheus | 9090 | Métricas |
| Grafana | 3000 | Dashboards |

---

## Comandos Úteis

### Iniciar o Sistema
```bash
cd /home/tomelin/rastreador
docker compose up -d
```

### Parar o Sistema
```bash
cd /home/tomelin/rastreador
docker compose down
```

### Ver Logs
```bash
# Todos os containers
docker compose logs -f

# Apenas aplicação
docker compose logs -f app

# Últimas 100 linhas
docker compose logs --tail=100 app
```

### Status dos Containers
```bash
docker compose ps
```

### Reiniciar Apenas a Aplicação
```bash
docker compose restart app
```

### Rebuild (após alterações no código)
```bash
docker compose build app --no-cache
docker compose up -d app
```

---

## Backups

### Backup Manual
```bash
cd /home/tomelin/rastreador
./scripts/backup.sh
```

### Backup Automático
Configurado via cron:
- Diário às 02:00
- Semanal aos domingos às 03:00
- Mensal no dia 1 às 04:00

### Restaurar Backup
```bash
cd /home/tomelin/rastreador
./scripts/restore.sh /caminho/do/backup
```

---

## Monitoramento

### Grafana
- URL: http://seu-servidor:3000
- Login: admin / admin123

### Prometheus
- URL: http://seu-servidor:9090

### Métricas da Aplicação
- URL: http://seu-servidor:62000/metrics

---

## Inicialização Automática

O sistema está configurado para iniciar automaticamente no boot via systemd:

```bash
# Status do serviço
sudo systemctl status rastreador

# Iniciar manualmente
sudo systemctl start rastreador

# Parar
sudo systemctl stop rastreador

# Ver logs do serviço
journalctl -u rastreador -f
```

---

## Backup Pré-Migração

Localização: `/home/tomelin/rastreador/backups/pre-migration-20251226_115708/`

Conteúdo:
- `rastreador_db.dump` - Backup PostgreSQL (binário)
- `rastreador_db.sql` - Backup PostgreSQL (SQL)
- `redis-dump.rdb` - Snapshot Redis
- `rastreador-app.tar.gz` - Código fonte original

---

## Troubleshooting

### Container não inicia
```bash
docker compose logs app
docker compose down
docker compose up -d
```

### Rotas aparecem como linhas retas
Verificar se OSRM está conectado à rede:
```bash
docker network connect rastreador_rastreador-network osrm-sul-brasil
docker compose restart app
```

### Problemas de conexão com banco
```bash
docker compose logs db
docker compose restart db pgbouncer app
```

### Limpar tudo e recomeçar
```bash
docker compose down -v  # CUIDADO: Remove volumes (dados)
docker compose up -d
```

---

## Escalabilidade Futura

A arquitetura Docker permite escalar horizontalmente:
- Múltiplas instâncias da aplicação atrás de load balancer
- Réplicas do banco de dados
- Redis cluster para alta disponibilidade

Para escalar a aplicação:
```bash
docker compose up -d --scale app=3
```

---

## Contatos e Suporte

- Backup automático: `/home/tomelin/rastreador/backups/`
- Logs: `docker compose logs`
- Configuração: `/home/tomelin/rastreador/docker-compose.yml`
