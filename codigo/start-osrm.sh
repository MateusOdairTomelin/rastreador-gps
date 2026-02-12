#!/bin/bash
# Script para iniciar o servidor OSRM local

CONTAINER_NAME="osrm-sul-brasil"
OSRM_DATA="/home/tomelin/rastreador/codigo/osrm-data"
DOCKER_NETWORK="codigo_rastreador-network"

# Verificar se o container já existe
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    # Container existe, verificar se está rodando
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "[OSRM] Container já está rodando"
    else
        echo "[OSRM] Iniciando container existente..."
        docker start ${CONTAINER_NAME}
    fi
else
    echo "[OSRM] Criando e iniciando novo container..."
    docker run -d \
        --name ${CONTAINER_NAME} \
        --restart unless-stopped \
        --network ${DOCKER_NETWORK} \
        -p 5000:5000 \
        -v ${OSRM_DATA}:/data \
        ghcr.io/project-osrm/osrm-backend \
        osrm-routed --algorithm mld /data/sul-brasil.osrm
fi

# Aguardar inicialização
sleep 3

# Verificar se está funcionando
if curl -s "http://localhost:5000/route/v1/driving/-49.276,-26.820;-49.275,-26.819" | grep -q '"Ok"'; then
    echo "[OSRM] Servidor OSRM local iniciado com sucesso na porta 5000"
else
    echo "[OSRM] ERRO: Servidor OSRM não está respondendo"
    exit 1
fi
