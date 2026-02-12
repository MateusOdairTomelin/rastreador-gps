#!/bin/bash
# ============================================================
# Script para configurar cron jobs do GPS Tracker
# ============================================================

set -e

BASE_DIR="/home/tomelin/rastreador"
SCRIPT_DIR="${BASE_DIR}/scripts"

# Cores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "============================================================"
echo " Configurando Cron Jobs - GPS Tracker Platform"
echo "============================================================"
echo ""

# Criar diretorios necessarios
echo -e "${GREEN}[1/4]${NC} Criando diretorios..."
mkdir -p "${BASE_DIR}/backups/daily"
mkdir -p "${BASE_DIR}/backups/weekly"
mkdir -p "${BASE_DIR}/backups/monthly"
mkdir -p "${BASE_DIR}/logs"

# Dar permissao de execucao aos scripts
echo -e "${GREEN}[2/4]${NC} Configurando permissoes..."
chmod +x "${SCRIPT_DIR}/backup.sh"
chmod +x "${SCRIPT_DIR}/restore.sh"

# Copiar para /etc/cron.d (requer sudo)
echo -e "${GREEN}[3/4]${NC} Instalando cron jobs..."

if [ -w "/etc/cron.d" ]; then
    cp "${SCRIPT_DIR}/cron/backup-cron" /etc/cron.d/gps-tracker
    chmod 644 /etc/cron.d/gps-tracker
    echo "  -> Instalado em /etc/cron.d/gps-tracker"
else
    echo -e "${YELLOW}[AVISO]${NC} Sem permissao para /etc/cron.d"
    echo "  -> Execute manualmente: sudo cp ${SCRIPT_DIR}/cron/backup-cron /etc/cron.d/gps-tracker"
    echo ""
    echo "  Ou adicione ao crontab do usuario:"
    echo "  crontab -e"
    echo "  # Adicionar linha:"
    echo "  0 3 * * * ${SCRIPT_DIR}/backup.sh >> ${BASE_DIR}/logs/backup.log 2>&1"
fi

# Testar backup (dry-run)
echo -e "${GREEN}[4/4]${NC} Verificando configuracao..."
echo ""

echo "Diretorios de backup:"
ls -la "${BASE_DIR}/backups/" 2>/dev/null || echo "  (ainda nao criados)"
echo ""

echo "Scripts configurados:"
ls -la "${SCRIPT_DIR}/backup.sh" "${SCRIPT_DIR}/restore.sh" 2>/dev/null
echo ""

echo "============================================================"
echo " Configuracao concluida!"
echo "============================================================"
echo ""
echo "Comandos disponiveis:"
echo "  ${SCRIPT_DIR}/backup.sh          # Executar backup manual"
echo "  ${SCRIPT_DIR}/restore.sh list    # Listar backups"
echo "  ${SCRIPT_DIR}/restore.sh restore <path>  # Restaurar backup"
echo ""
echo "O backup automatico sera executado diariamente as 03:00"
echo ""
