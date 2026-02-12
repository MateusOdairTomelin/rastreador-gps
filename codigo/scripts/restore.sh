#!/bin/bash
# ============================================================
# Script de Restore - GPS Tracker Platform
# ============================================================
# Restaura backups criados pelo backup.sh
# ============================================================

set -e

# ============ CONFIGURACOES ============
BACKUP_DIR="${BACKUP_DIR:-/home/tomelin/rastreador/backups}"

# Banco de dados
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-rastreador_db}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-L5430ZEumKwHIlEeecXX}"

# Docker
USE_DOCKER="${USE_DOCKER:-true}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-rastreador-db}"
REDIS_CONTAINER="${REDIS_CONTAINER:-rastreador-redis}"

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

list_backups() {
    echo ""
    echo -e "${BLUE}Backups disponíveis:${NC}"
    echo ""

    for type in monthly weekly daily; do
        if [ -d "${BACKUP_DIR}/${type}" ]; then
            echo -e "${YELLOW}=== ${type^^} ===${NC}"
            for backup in $(ls -1d "${BACKUP_DIR}/${type}/backup_"* 2>/dev/null | sort -r | head -10); do
                local manifest="${backup}/manifest.json"
                if [ -f "$manifest" ]; then
                    local timestamp=$(grep -o '"timestamp": "[^"]*"' "$manifest" | cut -d'"' -f4)
                    local size=$(du -sh "$backup" | cut -f1)
                    echo "  $(basename $backup) - ${timestamp} (${size})"
                else
                    echo "  $(basename $backup)"
                fi
            done
            echo ""
        fi
    done
}

validate_backup() {
    local backup_path=$1

    if [ ! -d "$backup_path" ]; then
        log_error "Diretorio de backup nao encontrado: $backup_path"
        return 1
    fi

    if [ ! -f "${backup_path}/postgresql.tar.gz" ]; then
        log_error "Arquivo postgresql.tar.gz nao encontrado"
        return 1
    fi

    # Verificar integridade
    for tarfile in "${backup_path}"/*.tar.gz; do
        if [ -f "$tarfile" ]; then
            if ! tar -tzf "$tarfile" > /dev/null 2>&1; then
                log_error "Arquivo corrompido: $tarfile"
                return 1
            fi
        fi
    done

    log_info "Backup validado com sucesso"
    return 0
}

restore_postgres() {
    local backup_path=$1
    local temp_dir=$(mktemp -d)

    log_info "Restaurando PostgreSQL..."

    # Extrair backup
    tar -xzf "${backup_path}/postgresql.tar.gz" -C "$temp_dir"

    if [ "$USE_DOCKER" == "true" ]; then
        # Restaurar schema
        if [ -f "${temp_dir}/postgresql/schema.sql" ]; then
            log_info "  -> Restaurando schema..."
            docker cp "${temp_dir}/postgresql/schema.sql" "${POSTGRES_CONTAINER}:/tmp/schema.sql"
            docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -f /tmp/schema.sql 2>/dev/null || {
                log_warn "Algumas tabelas ja existem (ignorando erros de schema)"
            }
        fi

        # Restaurar dados principais
        if [ -f "${temp_dir}/postgresql/data_main.sql" ]; then
            log_info "  -> Restaurando dados principais..."
            docker cp "${temp_dir}/postgresql/data_main.sql" "${POSTGRES_CONTAINER}:/tmp/data_main.sql"
            docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -f /tmp/data_main.sql 2>/dev/null || true
        fi

        # Restaurar localizacoes recentes
        for csv in "${temp_dir}/postgresql/localizacoes"*.csv; do
            if [ -f "$csv" ]; then
                log_info "  -> Restaurando $(basename $csv)..."
                docker cp "$csv" "${POSTGRES_CONTAINER}:/tmp/localizacoes.csv"
                docker exec "$POSTGRES_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
                    "COPY localizacoes FROM '/tmp/localizacoes.csv' WITH CSV HEADER" 2>/dev/null || {
                    log_warn "Erro ao restaurar localizacoes (possiveis duplicatas)"
                }
            fi
        done

        # Limpar arquivos temporarios
        docker exec "$POSTGRES_CONTAINER" rm -f /tmp/schema.sql /tmp/data_main.sql /tmp/localizacoes.csv 2>/dev/null || true

    else
        export PGPASSWORD="$DB_PASSWORD"

        if [ -f "${temp_dir}/postgresql/schema.sql" ]; then
            psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "${temp_dir}/postgresql/schema.sql" || true
        fi

        if [ -f "${temp_dir}/postgresql/data_main.sql" ]; then
            psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "${temp_dir}/postgresql/data_main.sql" || true
        fi

        unset PGPASSWORD
    fi

    rm -rf "$temp_dir"
    log_info "Restauracao PostgreSQL concluida"
}

restore_redis() {
    local backup_path=$1

    if [ ! -f "${backup_path}/redis.tar.gz" ]; then
        log_warn "Backup Redis nao encontrado, pulando..."
        return 0
    fi

    local temp_dir=$(mktemp -d)
    log_info "Restaurando Redis..."

    tar -xzf "${backup_path}/redis.tar.gz" -C "$temp_dir"

    if [ "$USE_DOCKER" == "true" ]; then
        # Parar Redis, copiar dump, reiniciar
        docker exec "$REDIS_CONTAINER" redis-cli SHUTDOWN NOSAVE 2>/dev/null || true
        sleep 2

        docker cp "${temp_dir}/redis/dump.rdb" "${REDIS_CONTAINER}:/data/dump.rdb" 2>/dev/null || {
            log_warn "Nao foi possivel restaurar Redis"
        }

        docker start "$REDIS_CONTAINER" 2>/dev/null || true
    fi

    rm -rf "$temp_dir"
    log_info "Restauracao Redis concluida"
}

restore_config() {
    local backup_path=$1
    local restore_to="${2:-/home/tomelin/rastreador}"

    if [ ! -f "${backup_path}/config.tar.gz" ]; then
        log_warn "Backup de configuracoes nao encontrado, pulando..."
        return 0
    fi

    local temp_dir=$(mktemp -d)
    log_info "Restaurando configuracoes..."

    tar -xzf "${backup_path}/config.tar.gz" -C "$temp_dir"

    # Listar arquivos disponiveis
    echo ""
    echo "Arquivos de configuracao disponiveis para restaurar:"
    ls -la "${temp_dir}/config/"
    echo ""

    read -p "Restaurar todos os arquivos de configuracao? (s/N): " confirm
    if [[ "$confirm" =~ ^[Ss]$ ]]; then
        # Backup dos arquivos atuais
        local backup_current="${restore_to}/config_backup_$(date +%Y%m%d_%H%M%S)"
        mkdir -p "$backup_current"

        for file in .env docker-compose.yml docker-compose.microservices.yml prometheus.yml haproxy.cfg; do
            [ -f "${restore_to}/${file}" ] && cp "${restore_to}/${file}" "$backup_current/"
        done

        # Restaurar
        cp -r "${temp_dir}/config/"* "${restore_to}/" 2>/dev/null || true

        log_info "Configuracoes restauradas. Backup anterior em: $backup_current"
    else
        log_info "Restauracao de configuracoes cancelada"
    fi

    rm -rf "$temp_dir"
}

# ============ MAIN ============

usage() {
    echo ""
    echo "Uso: $0 <comando> [opcoes]"
    echo ""
    echo "Comandos:"
    echo "  list                      Lista backups disponiveis"
    echo "  restore <backup_path>     Restaura um backup especifico"
    echo "  restore-db <backup_path>  Restaura apenas o banco de dados"
    echo "  restore-redis <backup_path> Restaura apenas o Redis"
    echo "  restore-config <backup_path> Restaura apenas configuracoes"
    echo ""
    echo "Exemplos:"
    echo "  $0 list"
    echo "  $0 restore ${BACKUP_DIR}/daily/backup_20241226_120000"
    echo "  $0 restore-db ${BACKUP_DIR}/monthly/backup_20241201_030000"
    echo ""
}

main() {
    local command="${1:-}"
    local backup_path="${2:-}"

    case "$command" in
        list)
            list_backups
            ;;

        restore)
            if [ -z "$backup_path" ]; then
                log_error "Especifique o caminho do backup"
                usage
                exit 1
            fi

            validate_backup "$backup_path" || exit 1

            echo ""
            echo -e "${YELLOW}ATENCAO: Esta operacao ira sobrescrever dados existentes!${NC}"
            read -p "Continuar com a restauracao? (s/N): " confirm

            if [[ ! "$confirm" =~ ^[Ss]$ ]]; then
                log_info "Restauracao cancelada"
                exit 0
            fi

            restore_postgres "$backup_path"
            restore_redis "$backup_path"
            restore_config "$backup_path"

            echo ""
            log_info "Restauracao completa!"
            echo ""
            ;;

        restore-db)
            if [ -z "$backup_path" ]; then
                log_error "Especifique o caminho do backup"
                exit 1
            fi

            validate_backup "$backup_path" || exit 1
            restore_postgres "$backup_path"
            ;;

        restore-redis)
            if [ -z "$backup_path" ]; then
                log_error "Especifique o caminho do backup"
                exit 1
            fi

            restore_redis "$backup_path"
            ;;

        restore-config)
            if [ -z "$backup_path" ]; then
                log_error "Especifique o caminho do backup"
                exit 1
            fi

            restore_config "$backup_path"
            ;;

        *)
            usage
            exit 1
            ;;
    esac
}

main "$@"
