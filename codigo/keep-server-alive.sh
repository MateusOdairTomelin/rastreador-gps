#!/bin/bash

# Script para manter o servidor rodando com reinício automático
# Use: ./keep-server-alive.sh

SERVER_DIR="/home/tomelin/rastreador"
LOG_FILE="/tmp/rastreador-server.log"
PID_FILE="/tmp/rastreador-server.pid"
CHECK_INTERVAL=30  # segundos

cd "$SERVER_DIR"

function start_server() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ▶️ Iniciando servidor..."
    npm start > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Servidor iniciado (PID: $(cat $PID_FILE))"
    sleep 3
}

function is_running() {
    if [ -f "$PID_FILE" ]; then
        pid=$(cat "$PID_FILE")
        if ps -p "$pid" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

function check_health() {
    response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:62000/api/status)
    if [ "$response" == "200" ]; then
        return 0
    fi
    return 1
}

# Limpar processo anterior se existir
if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE")
    if ps -p "$old_pid" > /dev/null 2>&1; then
        kill "$old_pid" 2>/dev/null || true
    fi
fi

# Iniciar servidor
start_server

# Loop de monitoramento
while true; do
    sleep "$CHECK_INTERVAL"

    if ! is_running; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Processo morreu, reiniciando..."
        start_server
    elif ! check_health; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ Servidor não respondendo, reiniciando..."
        pid=$(cat "$PID_FILE")
        kill "$pid" 2>/dev/null || true
        sleep 2
        start_server
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Servidor OK"
    fi
done
