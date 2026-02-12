#!/bin/bash
# ============================================================================
# Script para iniciar a arquitetura de microserviços
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "=============================================="
echo "🚀 Iniciando Arquitetura de Microserviços"
echo "=============================================="
echo ""

# Verificar se docker está rodando
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker não está rodando. Inicie o Docker primeiro."
    exit 1
fi

# Verificar arquivos necessários
if [ ! -f "docker-compose.microservices.yml" ]; then
    echo "❌ docker-compose.microservices.yml não encontrado"
    exit 1
fi

if [ ! -f "haproxy.cfg" ]; then
    echo "❌ haproxy.cfg não encontrado"
    exit 1
fi

# Parar sistema monolítico se estiver rodando
echo "📦 Parando sistema atual (se existir)..."
docker-compose down 2>/dev/null || true
pm2 stop all 2>/dev/null || true

# Construir imagens
echo ""
echo "🔨 Construindo imagens Docker..."
docker-compose -f docker-compose.microservices.yml build

# Iniciar serviços base primeiro
echo ""
echo "🗄️ Iniciando banco de dados e Redis..."
docker-compose -f docker-compose.microservices.yml up -d postgres redis

echo "⏳ Aguardando banco de dados..."
sleep 10

# Iniciar PgBouncer
echo "🔌 Iniciando PgBouncer..."
docker-compose -f docker-compose.microservices.yml up -d pgbouncer
sleep 5

# Executar migrações
echo ""
echo "📊 Executando migrações do banco..."
docker-compose -f docker-compose.microservices.yml run --rm api-server-1 npx prisma db push --accept-data-loss 2>/dev/null || true

# Iniciar gateways e processors
echo ""
echo "🌐 Iniciando TCP Gateways..."
docker-compose -f docker-compose.microservices.yml up -d tcp-gateway-1 tcp-gateway-2

echo ""
echo "⚙️ Iniciando Processors..."
docker-compose -f docker-compose.microservices.yml up -d location-processor-1 location-processor-2 location-processor-3
docker-compose -f docker-compose.microservices.yml up -d status-processor-1
docker-compose -f docker-compose.microservices.yml up -d alarm-processor-1

# Iniciar API servers
echo ""
echo "🖥️ Iniciando API Servers..."
docker-compose -f docker-compose.microservices.yml up -d api-server-1 api-server-2

# Iniciar HAProxy
echo ""
echo "⚖️ Iniciando Load Balancer (HAProxy)..."
docker-compose -f docker-compose.microservices.yml up -d haproxy

echo ""
echo "=============================================="
echo "✅ Arquitetura de Microserviços Iniciada!"
echo "=============================================="
echo ""
echo "📡 TCP (Rastreadores): porta 8877"
echo "🌐 HTTP (Frontend):    porta 80 ou 62000"
echo "📊 HAProxy Stats:      porta 8404 (admin:***)"
echo ""
echo "Comandos úteis:"
echo "  docker-compose -f docker-compose.microservices.yml logs -f"
echo "  docker-compose -f docker-compose.microservices.yml ps"
echo "  docker-compose -f docker-compose.microservices.yml down"
echo ""
