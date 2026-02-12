#!/bin/bash
# Script para iniciar arquitetura escalável
# Uso: ./scripts/start-scalable.sh [build|up|down|logs|scale]

set -e

COMPOSE_FILE="docker-compose.scalable.yml"
PROJECT_NAME="rastreador-scalable"

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se docker e docker-compose estão instalados
check_dependencies() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker não está instalado"
        exit 1
    fi

    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_error "Docker Compose não está instalado"
        exit 1
    fi
}

# Usar docker-compose ou docker compose
get_compose_cmd() {
    if docker compose version &> /dev/null 2>&1; then
        echo "docker compose"
    else
        echo "docker-compose"
    fi
}

COMPOSE_CMD=$(get_compose_cmd)

build() {
    log_info "Building images..."
    $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME build
    log_info "Build complete!"
}

up() {
    log_info "Starting services..."
    $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME up -d
    log_info "Services started!"
    echo ""
    log_info "Endpoints:"
    echo "  - TCP (Rastreadores): localhost:8877"
    echo "  - HTTP (API): localhost:62000"
    echo "  - HAProxy Stats: http://localhost:8404/stats (admin:admin)"
    echo ""
    log_info "Para ver logs: ./scripts/start-scalable.sh logs"
}

down() {
    log_info "Stopping services..."
    $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME down
    log_info "Services stopped!"
}

logs() {
    service=$2
    if [ -n "$service" ]; then
        $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME logs -f $service
    else
        $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME logs -f
    fi
}

status() {
    log_info "Service status:"
    $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME ps
}

scale() {
    component=$2
    count=$3
    if [ -z "$component" ] || [ -z "$count" ]; then
        log_error "Uso: ./scripts/start-scalable.sh scale <component> <count>"
        echo "Componentes: tcp-gateway, location-processor, api-server"
        exit 1
    fi

    case $component in
        tcp-gateway)
            log_info "Scaling TCP gateways to $count..."
            # Escalar gateways 2 e 3 (gateway 1 sempre ativo)
            ;;
        location-processor)
            log_info "Scaling location processors to $count..."
            ;;
        api-server)
            log_info "Scaling API servers to $count..."
            ;;
        *)
            log_error "Componente desconhecido: $component"
            exit 1
            ;;
    esac
}

restart() {
    log_info "Restarting services..."
    $COMPOSE_CMD -f $COMPOSE_FILE -p $PROJECT_NAME restart
    log_info "Services restarted!"
}

help() {
    echo "Uso: ./scripts/start-scalable.sh [comando]"
    echo ""
    echo "Comandos:"
    echo "  build    - Construir imagens Docker"
    echo "  up       - Iniciar todos os serviços"
    echo "  down     - Parar todos os serviços"
    echo "  restart  - Reiniciar serviços"
    echo "  logs     - Ver logs (opcional: nome do serviço)"
    echo "  status   - Ver status dos serviços"
    echo "  scale    - Escalar componente (ex: scale tcp-gateway 5)"
    echo "  help     - Mostrar esta ajuda"
}

# Main
check_dependencies

case "$1" in
    build)
        build
        ;;
    up)
        up
        ;;
    down)
        down
        ;;
    logs)
        logs "$@"
        ;;
    status)
        status
        ;;
    scale)
        scale "$@"
        ;;
    restart)
        restart
        ;;
    help|--help|-h)
        help
        ;;
    *)
        if [ -n "$1" ]; then
            log_error "Comando desconhecido: $1"
        fi
        help
        exit 1
        ;;
esac
