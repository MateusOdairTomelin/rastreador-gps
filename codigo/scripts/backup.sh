#!/bin/bash
# ============================================================
# Script de Backup Automatizado - GPS Tracker Platform
# ============================================================
# Faz backup de:
# - PostgreSQL/TimescaleDB (dump completo + dados recentes)
# - Redis (snapshot RDB)
# - Configuracoes da aplicacao
# ============================================================

set -e

# ============ CONFIGURACOES ============
BACKUP_DIR="${BACKUP_DIR:-/home/tomelin/rastreador/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-3}"

# Banco de dados
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-rastreador_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-L5430ZEumKwHIlEeecXX}"

# Redis
REDIS_HOST="${REDIS_HOST:-localhost}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Docker
USE_DOCKER="${USE_DOCKER:-true}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-rastreador-db}"
REDIS_CONTAINER="${REDIS_CONTAINER:-rastreador-redis}"

# Notificacoes (opcional)
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"
NOTIFY_SLACK_WEBHOOK="${NOTIFY_SLACK_WEBHOOK:-}"

# ============ VARIAVEIS ============
DATE=$(date +%Y%m%d_%H%M%S)
DAY_OF_WEEK=$(date +%u)
DAY_OF_MONTH=$(date +%d)
BACKUP_TYPE="daily"

# Determinar tipo de backup
if [ "$DAY_OF_MONTH" == "01" ]; then
    BACKUP_TYPE="monthly"
elif [ "$DAY_OF_WEEK" == "7" ]; then
    BACKUP_TYPE="weekly"
fi

BACKUP_SUBDIR="${BACKUP_DIR}/${BACKUP_TYPE}"
BACKUP_NAME="backup_${DATE}"
BACKUP_PATH="${BACKUP_SUBDIR}/${BACKUP_NAME}"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============ FUNCOES ============

log_info() {
    echo -e "${GREEN}[INFO]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $(date '+%Y-%m-%d %H:%M:%S') - $1"
}

send_notification() {
    local status=$1
    local message=$2

    # Email
    if [ -n "$NOTIFY_EMAIL" ]; then
        echo "$message" | mail -s "GPS Tracker Backup: $status" "$NOTIFY_EMAIL" 2>/dev/null || true
    fi

    # Slack
    if [ -n "$NOTIFY_SLACK_WEBHOOK" ]; then
        local color="good"
        [ "$status" == "FAILED" ] && color="danger"

        curl -s -X POST "$NOTIFY_SLACK_WEBHOOK" \
            -H 'Content-type: application/json' \
            -d "{\"attachments\":[{\"color\":\"$color\",\"title\":\"GPS Tracker Backup: $status\",\"text\":\"$message\"}]}" \
            2>/dev/null || true
    fi
}

check_disk_space() {
    local min_space_gb=${1:-10}
    local available_gb=$(df -BG "$BACKUP_DIR" | awk 'NR==2 {print $4}' | tr -d 'G')

    if [ "$available_gb" -lt "$min_space_gb" ]; then
        log_error "Espaco em disco insuficiente: ${available_gb}GB disponivel (minimo: ${min_space_gb}GB)"
        return 1
    fi

    log_info "Espaco em disco disponivel: ${available_gb}GB"
    return 0
}

backup_postgres() {
    log_info "Iniciando backup PostgreSQL/TimescaleDB..."

    local pg_backup_dir="${BACKUP_PATH}/postgresql"
    mkdir -p "$pg_backup_dir"

    if [ "$USE_DOCKER" == "true" ]; then
        # Backup via Docker

        # 1. Dump completo do schema
        log_info "  -> Exportando schema..."
        docker exec "$POSTGRES_CONTAINER" \
            pg_dump -U "$DB_USER" -d "$DB_NAME" --schema-only \
            > "${pg_backup_dir}/schema.sql" 2>/dev/null

        # 2. Dump completo dos dados (exceto tabelas grandes de historico)
        log_info "  -> Exportando dados principais..."
        docker exec "$POSTGRES_CONTAINER" \
            pg_dump -U "$DB_USER" -d "$DB_NAME" \
            --data-only \
            --exclude-table='localizacoes' \
            --exclude-table='dados_obd2' \
            --exclude-table='alarmes' \
            > "${pg_backup_dir}/data_main.sql" 2>/dev/null

        # 3. Dump das tabelas de time-series (ultimos 7 dias apenas para backup diario)
        if [ "$BACKUP_TYPE" == "daily" ]; then
            log_info "  -> Exportando localizacoes dos ultimos 7 dias..."
            docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
                "COPY (SELECT * FROM localizacoes WHERE data_hora >= NOW() - INTERVAL '7 days') TO STDOUT WITH CSV HEADER" \
                > "${pg_backup_dir}/localizacoes_recent.csv" 2>/dev/null
        else
            # Backup mensal/semanal: exportar mais dados
            local days=30
            [ "$BACKUP_TYPE" == "monthly" ] && days=90

            log_info "  -> Exportando localizacoes dos ultimos ${days} dias..."
            docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
                "COPY (SELECT * FROM localizacoes WHERE data_hora >= NOW() - INTERVAL '${days} days') TO STDOUT WITH CSV HEADER" \
                > "${pg_backup_dir}/localizacoes_${days}d.csv" 2>/dev/null
        fi

        # 4. Dump dos continuous aggregates (dados pre-computados)
        log_info "  -> Exportando aggregates..."
        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "COPY (SELECT * FROM localizacoes_horarias) TO STDOUT WITH CSV HEADER" \
            > "${pg_backup_dir}/localizacoes_horarias.csv" 2>/dev/null || true

        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "COPY (SELECT * FROM localizacoes_diarias) TO STDOUT WITH CSV HEADER" \
            > "${pg_backup_dir}/localizacoes_diarias.csv" 2>/dev/null || true

        # 5. Exportar configuracoes TimescaleDB
        log_info "  -> Exportando configuracoes TimescaleDB..."
        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "SELECT * FROM timescaledb_information.hypertables" \
            > "${pg_backup_dir}/timescale_info.txt" 2>/dev/null || true

    else
        # Backup sem Docker (conexao direta)
        export PGPASSWORD="$DB_PASSWORD"

        pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --schema-only \
            > "${pg_backup_dir}/schema.sql"

        pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
            --data-only \
            --exclude-table='localizacoes' \
            --exclude-table='dados_obd2' \
            --exclude-table='alarmes' \
            > "${pg_backup_dir}/data_main.sql"

        unset PGPASSWORD
    fi

    # Comprimir
    log_info "  -> Comprimindo backup PostgreSQL..."
    tar -czf "${BACKUP_PATH}/postgresql.tar.gz" -C "${BACKUP_PATH}" postgresql
    rm -rf "$pg_backup_dir"

    local size=$(du -h "${BACKUP_PATH}/postgresql.tar.gz" | cut -f1)
    log_info "Backup PostgreSQL concluido: $size"
}

backup_redis() {
    log_info "Iniciando backup Redis..."

    local redis_backup_dir="${BACKUP_PATH}/redis"
    mkdir -p "$redis_backup_dir"

    if [ "$USE_DOCKER" == "true" ]; then
        # Forcar save do Redis
        docker exec "$REDIS_CONTAINER" redis-cli BGSAVE 2>/dev/null
        sleep 2

        # Copiar arquivo RDB
        docker cp "${REDIS_CONTAINER}:/data/dump.rdb" "${redis_backup_dir}/dump.rdb" 2>/dev/null || {
            log_warn "Nao foi possivel copiar dump.rdb do Redis"
        }
    else
        redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" BGSAVE
        sleep 2
        cp /var/lib/redis/dump.rdb "${redis_backup_dir}/" 2>/dev/null || true
    fi

    # Comprimir
    if [ -f "${redis_backup_dir}/dump.rdb" ]; then
        tar -czf "${BACKUP_PATH}/redis.tar.gz" -C "${BACKUP_PATH}" redis
        rm -rf "$redis_backup_dir"
        local size=$(du -h "${BACKUP_PATH}/redis.tar.gz" | cut -f1)
        log_info "Backup Redis concluido: $size"
    else
        rm -rf "$redis_backup_dir"
        log_warn "Backup Redis ignorado (sem dados)"
    fi
}

backup_config() {
    log_info "Iniciando backup de configuracoes..."

    local config_backup_dir="${BACKUP_PATH}/config"
    mkdir -p "$config_backup_dir"

    # Copiar arquivos de configuracao
    local base_dir="/home/tomelin/rastreador"

    [ -f "${base_dir}/.env" ] && cp "${base_dir}/.env" "${config_backup_dir}/"
    [ -f "${base_dir}/docker-compose.yml" ] && cp "${base_dir}/docker-compose.yml" "${config_backup_dir}/"
    [ -f "${base_dir}/docker-compose.microservices.yml" ] && cp "${base_dir}/docker-compose.microservices.yml" "${config_backup_dir}/"
    [ -f "${base_dir}/prometheus.yml" ] && cp "${base_dir}/prometheus.yml" "${config_backup_dir}/"
    [ -f "${base_dir}/haproxy.cfg" ] && cp "${base_dir}/haproxy.cfg" "${config_backup_dir}/"
    [ -d "${base_dir}/prometheus-rules" ] && cp -r "${base_dir}/prometheus-rules" "${config_backup_dir}/"
    [ -d "${base_dir}/grafana" ] && cp -r "${base_dir}/grafana" "${config_backup_dir}/"

    # Exportar lista de dispositivos e perfis
    if [ "$USE_DOCKER" == "true" ]; then
        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "COPY (SELECT * FROM dispositivos) TO STDOUT WITH CSV HEADER" \
            > "${config_backup_dir}/dispositivos.csv" 2>/dev/null || true

        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "COPY (SELECT * FROM perfis_veiculo) TO STDOUT WITH CSV HEADER" \
            > "${config_backup_dir}/perfis_veiculo.csv" 2>/dev/null || true

        docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
            "COPY (SELECT * FROM usuarios) TO STDOUT WITH CSV HEADER" \
            > "${config_backup_dir}/usuarios.csv" 2>/dev/null || true
    fi

    # Comprimir
    tar -czf "${BACKUP_PATH}/config.tar.gz" -C "${BACKUP_PATH}" config
    rm -rf "$config_backup_dir"

    local size=$(du -h "${BACKUP_PATH}/config.tar.gz" | cut -f1)
    log_info "Backup configuracoes concluido: $size"
}

cleanup_old_backups() {
    log_info "Limpando backups antigos..."

    # Backups diarios: manter por RETENTION_DAYS dias
    if [ -d "${BACKUP_DIR}/daily" ]; then
        find "${BACKUP_DIR}/daily" -type d -name "backup_*" -mtime +${RETENTION_DAYS} -exec rm -rf {} \; 2>/dev/null || true
        local daily_count=$(find "${BACKUP_DIR}/daily" -maxdepth 1 -type d -name "backup_*" 2>/dev/null | wc -l)
        log_info "  -> Backups diarios mantidos: $daily_count"
    fi

    # Backups semanais: manter por RETENTION_WEEKLY semanas
    if [ -d "${BACKUP_DIR}/weekly" ]; then
        local weekly_days=$((RETENTION_WEEKLY * 7))
        find "${BACKUP_DIR}/weekly" -type d -name "backup_*" -mtime +${weekly_days} -exec rm -rf {} \; 2>/dev/null || true
        local weekly_count=$(find "${BACKUP_DIR}/weekly" -maxdepth 1 -type d -name "backup_*" 2>/dev/null | wc -l)
        log_info "  -> Backups semanais mantidos: $weekly_count"
    fi

    # Backups mensais: manter por RETENTION_MONTHLY meses
    if [ -d "${BACKUP_DIR}/monthly" ]; then
        local monthly_days=$((RETENTION_MONTHLY * 30))
        find "${BACKUP_DIR}/monthly" -type d -name "backup_*" -mtime +${monthly_days} -exec rm -rf {} \; 2>/dev/null || true
        local monthly_count=$(find "${BACKUP_DIR}/monthly" -maxdepth 1 -type d -name "backup_*" 2>/dev/null | wc -l)
        log_info "  -> Backups mensais mantidos: $monthly_count"
    fi
}

create_manifest() {
    log_info "Criando manifesto do backup..."

    cat > "${BACKUP_PATH}/manifest.json" << EOF
{
    "timestamp": "$(date -Iseconds)",
    "type": "${BACKUP_TYPE}",
    "host": "$(hostname)",
    "database": "${DB_NAME}",
    "files": [
        $(ls -la "${BACKUP_PATH}"/*.tar.gz 2>/dev/null | awk '{print "\"" $NF "\""}' | tr '\n' ',' | sed 's/,$//')
    ],
    "sizes": {
        $(for f in "${BACKUP_PATH}"/*.tar.gz; do
            [ -f "$f" ] && echo "\"$(basename $f)\": \"$(du -h "$f" | cut -f1)\","
        done | sed '$ s/,$//')
    },
    "retention": {
        "daily_days": ${RETENTION_DAYS},
        "weekly_weeks": ${RETENTION_WEEKLY},
        "monthly_months": ${RETENTION_MONTHLY}
    }
}
EOF
}

verify_backup() {
    log_info "Verificando integridade do backup..."

    local errors=0

    for tarfile in "${BACKUP_PATH}"/*.tar.gz; do
        if [ -f "$tarfile" ]; then
            if ! tar -tzf "$tarfile" > /dev/null 2>&1; then
                log_error "Arquivo corrompido: $tarfile"
                ((errors++))
            fi
        fi
    done

    if [ $errors -eq 0 ]; then
        log_info "Verificacao concluida: todos os arquivos integros"
        return 0
    else
        log_error "Verificacao falhou: $errors arquivo(s) corrompido(s)"
        return 1
    fi
}

# ============ MAIN ============

main() {
    local start_time=$(date +%s)

    echo ""
    echo "============================================================"
    echo " GPS Tracker Backup - $(date '+%Y-%m-%d %H:%M:%S')"
    echo " Tipo: ${BACKUP_TYPE^^}"
    echo "============================================================"
    echo ""

    # Criar diretorios
    mkdir -p "$BACKUP_SUBDIR"
    mkdir -p "$BACKUP_PATH"

    # Verificar espaco em disco
    check_disk_space 5 || {
        send_notification "FAILED" "Backup falhou: espaco em disco insuficiente"
        exit 1
    }

    # Executar backups
    local backup_status="SUCCESS"

    backup_postgres || {
        log_error "Falha no backup PostgreSQL"
        backup_status="PARTIAL"
    }

    backup_redis || {
        log_warn "Falha no backup Redis"
        backup_status="PARTIAL"
    }

    backup_config || {
        log_error "Falha no backup de configuracoes"
        backup_status="PARTIAL"
    }

    # Criar manifesto
    create_manifest

    # Verificar integridade
    verify_backup || backup_status="FAILED"

    # Limpar backups antigos
    cleanup_old_backups

    # Calcular tempo total
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))

    # Tamanho total
    local total_size=$(du -sh "$BACKUP_PATH" | cut -f1)

    echo ""
    echo "============================================================"
    echo " Backup ${backup_status}"
    echo " Duracao: ${duration}s"
    echo " Tamanho: ${total_size}"
    echo " Local: ${BACKUP_PATH}"
    echo "============================================================"
    echo ""

    # Enviar notificacao
    send_notification "$backup_status" "Backup ${BACKUP_TYPE} concluido em ${duration}s. Tamanho: ${total_size}. Local: ${BACKUP_PATH}"

    [ "$backup_status" == "FAILED" ] && exit 1
    exit 0
}

# Executar
main "$@"
