#!/bin/bash
# Script para restaurar o sistema na nova VM

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "============================================"
echo "  RESTAURAÇÃO DO SISTEMA RASTREADOR"
echo "============================================"

# 1. Copiar código
echo "[1/4] Copiando código fonte..."
mkdir -p /home/tomelin/rastreador
cp -r "${SCRIPT_DIR}/codigo/"* /home/tomelin/rastreador/

# 2. Instalar dependências
echo "[2/4] Instalando dependências..."
cd /home/tomelin/rastreador
npm install

# 3. Subir containers
echo "[3/4] Subindo containers Docker..."
docker compose up -d

# 4. Aguardar banco ficar pronto
echo "[4/4] Aguardando banco de dados..."
sleep 15

# 5. Restaurar banco (se existir backup)
if [ -f "${SCRIPT_DIR}/database-backup.dump" ]; then
    echo "Restaurando banco de dados..."
    docker cp "${SCRIPT_DIR}/database-backup.dump" rastreador-db:/tmp/backup.dump
    docker exec rastreador-db pg_restore -U postgres -d rastreador_db -c /tmp/backup.dump 2>/dev/null || true
    docker exec rastreador-db rm /tmp/backup.dump
    echo "Banco restaurado!"
fi

# 6. Restaurar Redis (se existir)
if [ -f "${SCRIPT_DIR}/redis-backup.rdb" ]; then
    echo "Restaurando Redis..."
    docker cp "${SCRIPT_DIR}/redis-backup.rdb" rastreador-redis:/data/dump.rdb
    docker restart rastreador-redis
fi

echo ""
echo "============================================"
echo "  RESTAURAÇÃO CONCLUÍDA!"
echo "============================================"
echo ""
echo "Acesse: http://SEU_IP:62000"
