#!/bin/bash
# ============================================================================
# Script de Escalonamento do Rastreador
# ============================================================================
#
# Uso:
#   ./scripts/escalar.sh normal    # Config normal (2 gateways, 2 processors)
#   ./scripts/escalar.sh scaled    # Config escalada (4 gateways, 4 processors, 2 APIs)
#   ./scripts/escalar.sh status    # Ver status dos containers
#
# ============================================================================

set -e
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

case "$1" in
    normal)
        echo -e "${GREEN}=== Iniciando em modo NORMAL ===${NC}"
        echo "• 2 TCP Gateways"
        echo "• 2 Location Processors"
        echo "• 1 Status Processor"
        echo "• 1 API Server"
        echo ""

        # Parar containers escalados se existirem
        docker compose -f docker-compose.scalable-16gb.yml -f docker-compose.scaled.yml down --remove-orphans 2>/dev/null || true

        # Usar config normal do HAProxy
        cp config/haproxy-16gb.cfg config/haproxy-active.cfg

        # Subir apenas com compose normal
        docker compose -f docker-compose.scalable-16gb.yml up -d --build

        echo -e "\n${GREEN}✅ Sistema iniciado em modo NORMAL${NC}"
        ;;

    scaled)
        echo -e "${YELLOW}=== Iniciando em modo ESCALADO ===${NC}"
        echo "• 4 TCP Gateways (+2)"
        echo "• 4 Location Processors (+2)"
        echo "• 2 Status Processors (+1)"
        echo "• 2 API Servers (+1)"
        echo ""

        # Usar config escalada do HAProxy
        cp config/haproxy-scaled.cfg config/haproxy-16gb.cfg

        # Subir com ambos os compose files
        docker compose -f docker-compose.scalable-16gb.yml -f docker-compose.scaled.yml up -d --build

        echo -e "\n${GREEN}✅ Sistema iniciado em modo ESCALADO${NC}"
        ;;

    status)
        echo -e "${GREEN}=== Status dos Containers ===${NC}\n"

        echo "TCP Gateways:"
        docker ps --filter "name=tcp-gw" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || echo "  Nenhum"

        echo -e "\nLocation Processors:"
        docker ps --filter "name=loc-proc" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || echo "  Nenhum"

        echo -e "\nStatus Processors:"
        docker ps --filter "name=status-proc" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || echo "  Nenhum"

        echo -e "\nAPI Servers:"
        docker ps --filter "name=api-" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || echo "  Nenhum"

        echo -e "\nOutros:"
        docker ps --filter "name=rastreador" --format "  {{.Names}}: {{.Status}}" | grep -v "tcp-gw\|loc-proc\|status-proc\|api-" 2>/dev/null || echo "  Nenhum"

        echo -e "\n${YELLOW}HAProxy Stats: http://localhost:8404/stats (admin:admin)${NC}"
        ;;

    *)
        echo "Uso: $0 {normal|scaled|status}"
        echo ""
        echo "  normal  - Inicia em modo normal (2 gateways, 2 processors)"
        echo "  scaled  - Inicia em modo escalado (4 gateways, 4 processors)"
        echo "  status  - Mostra status dos containers"
        exit 1
        ;;
esac
