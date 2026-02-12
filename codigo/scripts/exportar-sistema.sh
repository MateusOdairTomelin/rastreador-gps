#!/bin/bash
# ============================================================
# Script de Exportação Completa do Sistema Rastreador
# ============================================================

set -e

PROJETO_DIR="/home/tomelin/rastreador"
DATA_ATUAL=$(date +%Y%m%d_%H%M%S)
EXPORT_DIR="/home/tomelin/export_${DATA_ATUAL}"
ARQUIVO_FINAL="/home/tomelin/rastreador-completo-${DATA_ATUAL}.tar.gz"

echo "============================================"
echo "  EXPORTAÇÃO DO SISTEMA RASTREADOR"
echo "============================================"
echo ""

# Criar diretório temporário
mkdir -p "${EXPORT_DIR}"

# ============ 1. EXPORTAR CÓDIGO FONTE ============
echo "[1/5] Exportando código fonte..."
rsync -av --progress \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='logs/*.log' \
    --exclude='backups/*' \
    --exclude='nohup.out' \
    --exclude='*.tar.gz' \
    "${PROJETO_DIR}/" "${EXPORT_DIR}/codigo/"

# ============ 2. EXPORTAR BANCO DE DADOS ============
echo ""
echo "[2/5] Exportando banco de dados PostgreSQL..."
if docker ps --format '{{.Names}}' | grep -q 'rastreador-db'; then
    docker exec rastreador-db pg_dump -U postgres -d rastreador_db -F c -f /tmp/backup.dump
    docker cp rastreador-db:/tmp/backup.dump "${EXPORT_DIR}/database-backup.dump"
    docker exec rastreador-db rm /tmp/backup.dump
    echo "    -> Banco exportado com sucesso!"
else
    echo "    -> Container do banco não está rodando. Pulando..."
fi

# ============ 3. EXPORTAR REDIS (opcional) ============
echo ""
echo "[3/5] Exportando dados do Redis..."
if docker ps --format '{{.Names}}' | grep -q 'rastreador-redis'; then
    docker exec rastreador-redis redis-cli -a "${REDIS_PASSWORD:-UI6+PBaM/EMhf7I4tX6i9qdhtzKg6nttX7VO28oGa90=}" BGSAVE 2>/dev/null || true
    sleep 2
    docker cp rastreador-redis:/data/dump.rdb "${EXPORT_DIR}/redis-backup.rdb" 2>/dev/null || echo "    -> Sem dados Redis para exportar"
    echo "    -> Redis exportado!"
else
    echo "    -> Container Redis não está rodando. Pulando..."
fi

# ============ 4. EXPORTAR VOLUMES GRAFANA/PROMETHEUS ============
echo ""
echo "[4/5] Exportando configurações Grafana/Prometheus..."
cp -r "${PROJETO_DIR}/grafana" "${EXPORT_DIR}/" 2>/dev/null || true
cp "${PROJETO_DIR}/prometheus.yml" "${EXPORT_DIR}/" 2>/dev/null || true
cp -r "${PROJETO_DIR}/prometheus-rules" "${EXPORT_DIR}/" 2>/dev/null || true
echo "    -> Configurações exportadas!"

# ============ 5. CRIAR SCRIPT DE RESTAURAÇÃO ============
echo ""
echo "[5/5] Criando script de restauração..."
cat > "${EXPORT_DIR}/restaurar-sistema.sh" << 'RESTORE_SCRIPT'
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
RESTORE_SCRIPT

chmod +x "${EXPORT_DIR}/restaurar-sistema.sh"

# ============ CRIAR ARQUIVO FINAL ============
echo ""
echo "Compactando tudo..."
cd /home/tomelin
tar -czvf "${ARQUIVO_FINAL}" "export_${DATA_ATUAL}"

# Limpar diretório temporário
rm -rf "${EXPORT_DIR}"

echo ""
echo "============================================"
echo "  EXPORTAÇÃO CONCLUÍDA!"
echo "============================================"
echo ""
echo "Arquivo criado: ${ARQUIVO_FINAL}"
echo "Tamanho: $(du -h ${ARQUIVO_FINAL} | cut -f1)"
echo ""
echo "Para usar na nova VM:"
echo "  1. Copie o arquivo para a nova VM"
echo "  2. tar -xzvf rastreador-completo-*.tar.gz"
echo "  3. cd export_*"
echo "  4. ./restaurar-sistema.sh"
echo ""
