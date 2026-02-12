#!/bin/bash
# ============================================================================
# Script para aplicar migração TimescaleDB em banco existente
# ============================================================================
#
# Este script:
# 1. Faz backup do banco atual
# 2. Aplica a migração para TimescaleDB
# 3. Verifica se a migração foi bem-sucedida
#
# Uso:
#   ./scripts/apply-timescaledb.sh
#
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Migração para TimescaleDB${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Verificar se PostgreSQL está rodando
echo -e "${YELLOW}[1/6] Verificando conexão com PostgreSQL...${NC}"
if ! docker-compose exec -T postgres pg_isready -U postgres -d rastreador_db > /dev/null 2>&1; then
    echo -e "${RED}❌ PostgreSQL não está acessível${NC}"
    echo "Execute: docker-compose up -d postgres"
    exit 1
fi
echo -e "${GREEN}✅ PostgreSQL está rodando${NC}"

# Verificar se já é TimescaleDB
echo ""
echo -e "${YELLOW}[2/6] Verificando se TimescaleDB está instalado...${NC}"
TIMESCALE_VERSION=$(docker-compose exec -T postgres psql -U postgres -d rastreador_db -t -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';" 2>/dev/null | tr -d ' ' || echo "")

if [ -n "$TIMESCALE_VERSION" ]; then
    echo -e "${GREEN}✅ TimescaleDB já está instalado (versão: $TIMESCALE_VERSION)${NC}"
else
    echo -e "${YELLOW}⚠️  TimescaleDB não está instalado, instalando...${NC}"

    # Verificar se a imagem é TimescaleDB
    POSTGRES_IMAGE=$(docker-compose config | grep 'image:' | grep postgres | head -1 | awk '{print $2}')
    if [[ "$POSTGRES_IMAGE" != *"timescale"* ]]; then
        echo -e "${RED}❌ A imagem do PostgreSQL não é TimescaleDB${NC}"
        echo "Atualize docker-compose.yml para usar: timescale/timescaledb:latest-pg15"
        exit 1
    fi

    docker-compose exec -T postgres psql -U postgres -d rastreador_db -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
    TIMESCALE_VERSION=$(docker-compose exec -T postgres psql -U postgres -d rastreador_db -t -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';" | tr -d ' ')
    echo -e "${GREEN}✅ TimescaleDB instalado (versão: $TIMESCALE_VERSION)${NC}"
fi

# Backup
echo ""
echo -e "${YELLOW}[3/6] Criando backup do banco...${NC}"
BACKUP_FILE="$PROJECT_DIR/backups/backup_pre_timescale_$(date +%Y%m%d_%H%M%S).sql"
mkdir -p "$PROJECT_DIR/backups"

docker-compose exec -T postgres pg_dump -U postgres -d rastreador_db > "$BACKUP_FILE" 2>/dev/null
if [ -f "$BACKUP_FILE" ] && [ -s "$BACKUP_FILE" ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo -e "${GREEN}✅ Backup criado: $BACKUP_FILE ($BACKUP_SIZE)${NC}"
else
    echo -e "${YELLOW}⚠️  Backup vazio ou falhou (banco pode estar vazio)${NC}"
fi

# Verificar se já tem hypertables
echo ""
echo -e "${YELLOW}[4/6] Verificando hypertables existentes...${NC}"
HYPERTABLES=$(docker-compose exec -T postgres psql -U postgres -d rastreador_db -t -c "SELECT COUNT(*) FROM timescaledb_information.hypertables;" 2>/dev/null | tr -d ' ' || echo "0")

if [ "$HYPERTABLES" -gt "0" ]; then
    echo -e "${GREEN}✅ Já existem $HYPERTABLES hypertables configuradas${NC}"

    # Mostrar quais são
    echo ""
    echo "Hypertables existentes:"
    docker-compose exec -T postgres psql -U postgres -d rastreador_db -c "SELECT hypertable_name, num_chunks, compression_enabled FROM timescaledb_information.hypertables;"

    echo ""
    read -p "Deseja reconfigurar as políticas de compressão/retenção? (s/N): " RECONFIG
    if [ "$RECONFIG" != "s" ] && [ "$RECONFIG" != "S" ]; then
        echo "Migração cancelada pelo usuário"
        exit 0
    fi
fi

# Aplicar migração
echo ""
echo -e "${YELLOW}[5/6] Aplicando migração TimescaleDB...${NC}"
docker-compose exec -T postgres psql -U postgres -d rastreador_db < "$SCRIPT_DIR/migrate-timescaledb.sql"

# Verificar resultado
echo ""
echo -e "${YELLOW}[6/6] Verificando resultado da migração...${NC}"

# Contar hypertables
HYPERTABLES_AFTER=$(docker-compose exec -T postgres psql -U postgres -d rastreador_db -t -c "SELECT COUNT(*) FROM timescaledb_information.hypertables;" | tr -d ' ')

if [ "$HYPERTABLES_AFTER" -ge "3" ]; then
    echo -e "${GREEN}✅ Migração concluída com sucesso!${NC}"
    echo ""

    # Mostrar estatísticas
    echo "=== Hypertables Criadas ==="
    docker-compose exec -T postgres psql -U postgres -d rastreador_db -c \
        "SELECT hypertable_name, num_chunks, compression_enabled FROM timescaledb_information.hypertables;"

    echo ""
    echo "=== Políticas de Compressão ==="
    docker-compose exec -T postgres psql -U postgres -d rastreador_db -c \
        "SELECT hypertable_name, schedule_interval FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression';"

    echo ""
    echo "=== Políticas de Retenção ==="
    docker-compose exec -T postgres psql -U postgres -d rastreador_db -c \
        "SELECT hypertable_name, schedule_interval FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention';"

    echo ""
    echo -e "${GREEN}============================================${NC}"
    echo -e "${GREEN}  TimescaleDB configurado com sucesso!${NC}"
    echo -e "${GREEN}============================================${NC}"
    echo ""
    echo "Próximos passos:"
    echo "  1. Reinicie a aplicação: docker-compose restart app"
    echo "  2. Monitore o uso de disco para ver a compressão em ação"
    echo "  3. Backup está em: $BACKUP_FILE"
else
    echo -e "${RED}❌ Migração pode ter falhado${NC}"
    echo "Verifique os logs e o backup em: $BACKUP_FILE"
    exit 1
fi
