#!/bin/bash
# Deploy do Rastreador GPS para Docker Swarm com Auto-scaling

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=== Deploy Rastreador GPS - Docker Swarm ==="
echo ""

# 1. Verificar se Swarm está ativo
if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
    echo "[1/6] Inicializando Docker Swarm..."
    docker swarm init 2>/dev/null || true
else
    echo "[1/6] Docker Swarm já ativo ✓"
fi

# 2. Parar docker-compose se estiver rodando
echo "[2/6] Parando containers docker-compose..."
docker-compose down 2>/dev/null || true

# 3. Construir imagem da aplicação
echo "[3/6] Construindo imagem da aplicação..."
docker build -t rastreador-app:latest .

# 4. Conectar OSRM à rede overlay (se existir)
echo "[4/6] Configurando rede..."
docker network create --driver overlay --attachable rastreador-network 2>/dev/null || true

# Conectar OSRM se estiver rodando
if docker ps --format '{{.Names}}' | grep -q "osrm-sul-brasil"; then
    docker network connect rastreador-network osrm-sul-brasil 2>/dev/null || true
    echo "    OSRM conectado à rede ✓"
fi

# 5. Deploy do stack
echo "[5/6] Fazendo deploy do stack..."
docker stack deploy -c docker-stack.yml rastreador

# 6. Aguardar serviços ficarem prontos
echo "[6/6] Aguardando serviços..."
sleep 10

echo ""
echo "=== Status do Deploy ==="
docker stack services rastreador

echo ""
echo "=== Verificando saúde dos serviços ==="
sleep 5
docker stack ps rastreador --filter "desired-state=running"

echo ""
echo "=== Deploy concluído! ==="
echo ""
echo "URLs:"
echo "  - Frontend:  http://localhost:62000"
echo "  - HAProxy:   http://localhost:8404/stats"
echo "  - Grafana:   http://localhost:3000"
echo "  - Prometheus: http://localhost:9090"
echo ""
echo "Comandos úteis:"
echo "  - Ver serviços:    docker stack services rastreador"
echo "  - Ver containers:  docker stack ps rastreador"
echo "  - Escalar app:     docker service scale rastreador_app=5"
echo "  - Logs da app:     docker service logs -f rastreador_app"
echo "  - Remover stack:   docker stack rm rastreador"
echo ""
