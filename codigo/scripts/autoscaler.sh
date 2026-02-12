#!/bin/bash
# Auto-scaler para Rastreador GPS
# Monitora métricas e escala automaticamente

set -e

# Configurações
SERVICE_NAME="rastreador_app"
MIN_REPLICAS=2
MAX_REPLICAS=10
SCALE_UP_THRESHOLD=70    # CPU % para escalar para cima
SCALE_DOWN_THRESHOLD=20  # CPU % para escalar para baixo
CHECK_INTERVAL=60        # Segundos entre verificações
COOLDOWN=300             # Segundos de cooldown após escalar

LAST_SCALE_TIME=0
LOG_FILE="/var/log/rastreador-autoscaler.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

get_current_replicas() {
    docker service inspect --format '{{.Spec.Mode.Replicated.Replicas}}' "$SERVICE_NAME" 2>/dev/null || echo "0"
}

get_cpu_usage() {
    # Obtém uso médio de CPU dos containers do serviço
    docker stats --no-stream --format "{{.CPUPerc}}" $(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE_NAME") 2>/dev/null | \
        sed 's/%//g' | \
        awk '{ sum += $1; count++ } END { if (count > 0) print sum/count; else print 0 }'
}

get_connection_count() {
    # Obtém número de conexões TCP na porta 8877
    curl -s "http://localhost:62000/api/metrics" 2>/dev/null | \
        grep "gps_tcp_connections" | \
        awk '{print $2}' || echo "0"
}

scale_service() {
    local new_replicas=$1
    local current_replicas=$(get_current_replicas)

    if [ "$new_replicas" -eq "$current_replicas" ]; then
        return 0
    fi

    # Verificar cooldown
    local now=$(date +%s)
    local elapsed=$((now - LAST_SCALE_TIME))

    if [ "$elapsed" -lt "$COOLDOWN" ]; then
        log "Cooldown ativo. Aguardando $((COOLDOWN - elapsed))s..."
        return 0
    fi

    log "Escalando $SERVICE_NAME: $current_replicas -> $new_replicas replicas"
    docker service scale "$SERVICE_NAME=$new_replicas"
    LAST_SCALE_TIME=$(date +%s)
}

check_and_scale() {
    local current_replicas=$(get_current_replicas)
    local cpu_usage=$(get_cpu_usage)
    local connections=$(get_connection_count)

    log "Status: replicas=$current_replicas, cpu=${cpu_usage}%, conexoes=$connections"

    # Escalar para CIMA
    if (( $(echo "$cpu_usage > $SCALE_UP_THRESHOLD" | bc -l) )) || [ "$connections" -gt 100 ]; then
        local new_replicas=$((current_replicas + 1))
        if [ "$new_replicas" -le "$MAX_REPLICAS" ]; then
            log "CPU alta ($cpu_usage%) ou muitas conexões ($connections). Escalando para cima..."
            scale_service "$new_replicas"
        else
            log "Já no máximo de replicas ($MAX_REPLICAS)"
        fi
        return
    fi

    # Escalar para BAIXO
    if (( $(echo "$cpu_usage < $SCALE_DOWN_THRESHOLD" | bc -l) )) && [ "$connections" -lt 20 ]; then
        local new_replicas=$((current_replicas - 1))
        if [ "$new_replicas" -ge "$MIN_REPLICAS" ]; then
            log "CPU baixa ($cpu_usage%) e poucas conexões ($connections). Escalando para baixo..."
            scale_service "$new_replicas"
        else
            log "Já no mínimo de replicas ($MIN_REPLICAS)"
        fi
        return
    fi
}

main() {
    log "=== Auto-scaler iniciado ==="
    log "Serviço: $SERVICE_NAME"
    log "Replicas: min=$MIN_REPLICAS, max=$MAX_REPLICAS"
    log "Thresholds: up=${SCALE_UP_THRESHOLD}%, down=${SCALE_DOWN_THRESHOLD}%"
    log "Intervalo: ${CHECK_INTERVAL}s, Cooldown: ${COOLDOWN}s"

    while true; do
        check_and_scale
        sleep "$CHECK_INTERVAL"
    done
}

# Executar
main
