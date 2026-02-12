#!/bin/bash
# =============================================================================
# Rastreador Watchdog - Auto-recovery com alertas Telegram
# =============================================================================
# Monitora o sistema, tenta recuperar automaticamente e notifica status
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.env"

LOG_FILE="$PROJECT_DIR/logs/watchdog.log"
STATE_FILE="/tmp/rastreador_watchdog_state"
LOCK_FILE="/tmp/rastreador_watchdog.lock"
FAILURE_FILE="/tmp/rastreador_was_failing"

# Criar diretório de logs se não existir
mkdir -p "$(dirname "$LOG_FILE")"

# Função de logging
log() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" | tee -a "$LOG_FILE"
}

# Prevenir múltiplas execuções
if [ -f "$LOCK_FILE" ]; then
    pid=$(cat "$LOCK_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        exit 0
    fi
fi
echo $$ > "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

# Enviar mensagem via Telegram
send_telegram() {
    local message="$1"

    if [ -z "$TELEGRAM_BOT_TOKEN" ] || [ -z "$TELEGRAM_CHAT_ID" ]; then
        log "WARN" "Telegram não configurado"
        return 1
    fi

    local url="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage"

    local response=$(curl -s -w "\n%{http_code}" -X POST "$url" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\": \"${TELEGRAM_CHAT_ID}\", \"text\": \"${message}\", \"parse_mode\": \"HTML\"}")

    local http_code=$(echo "$response" | tail -n1)

    if [ "$http_code" == "200" ]; then
        log "INFO" "Telegram enviado com sucesso"
        return 0
    else
        log "ERROR" "Falha ao enviar Telegram (HTTP $http_code)"
        return 1
    fi
}

# Notificação de SISTEMA OFFLINE (falha crítica)
notify_offline() {
    local failed="$1"
    local hostname=$(hostname)
    local timestamp=$(date '+%d/%m/%Y %H:%M')

    local message="🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴

🚨🚨🚨 <b>ALERTA CRÍTICO</b> 🚨🚨🚨

⛔️ <b>SERVIDOR OFFLINE</b> ⛔️

━━━━━━━━━━━━━━━━━━━━
📅 <b>Data:</b> ${timestamp}
🖥️ <b>Servidor:</b> ${hostname}
━━━━━━━━━━━━━━━━━━━━

❌ <b>SERVIÇOS COM FALHA:</b>
<code>${failed}</code>

🔄 Tentativas de recuperação: ${MAX_RECOVERY_ATTEMPTS}
❌ <b>Status: NÃO RECUPERADO</b>

⚠️ <b>INTERVENÇÃO MANUAL NECESSÁRIA!</b>

🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴"

    send_telegram "$message"

    # Marcar que houve falha
    echo "$(date '+%Y-%m-%d %H:%M:%S')" > "$FAILURE_FILE"
}

# Notificação de SISTEMA ONLINE (recuperado)
notify_online() {
    local hostname=$(hostname)
    local timestamp=$(date '+%d/%m/%Y %H:%M')
    local downtime=""

    # Calcular tempo de inatividade se possível
    if [ -f "$FAILURE_FILE" ]; then
        local fail_time=$(cat "$FAILURE_FILE")
        downtime="
⏱️ <b>Início da falha:</b> ${fail_time}"
        rm -f "$FAILURE_FILE"
    fi

    local message="🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢

✅✅✅ <b>SISTEMA RECUPERADO</b> ✅✅✅

🟢 <b>SERVIDOR ONLINE</b> 🟢

━━━━━━━━━━━━━━━━━━━━
📅 <b>Data:</b> ${timestamp}
🖥️ <b>Servidor:</b> ${hostname}${downtime}
━━━━━━━━━━━━━━━━━━━━

✅ Todos os serviços funcionando
✅ Rastreadores podem se conectar
✅ Sistema operacional

🎉 <b>Tudo normalizado!</b>

🟢🟢🟢🟢🟢🟢🟢🟢🟢🟢"

    send_telegram "$message"
}

# Verificar se um container está rodando e saudável
check_container() {
    local container="rastreador-$1"
    local status=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null)
    local health=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null)

    if [ "$status" != "running" ]; then
        return 1
    fi

    # Se tem healthcheck, verificar
    if [ -n "$health" ] && [ "$health" != "healthy" ] && [ "$health" != "" ]; then
        return 1
    fi

    return 0
}

# Verificar porta TCP
check_tcp_port() {
    local port="$1"
    nc -z localhost "$port" 2>/dev/null
    return $?
}

# Verificar saúde do sistema
check_system_health() {
    local failed_services=()

    # Verificar containers
    for service in $SERVICES; do
        if ! check_container "$service"; then
            failed_services+=("container:$service")
        fi
    done

    # Verificar porta TCP dos rastreadores
    if ! check_tcp_port "$TCP_PORT"; then
        failed_services+=("port:tcp-$TCP_PORT")
    fi

    # Verificar porta HTTP
    if ! check_tcp_port "$HTTP_PORT"; then
        failed_services+=("port:http-$HTTP_PORT")
    fi

    if [ ${#failed_services[@]} -gt 0 ]; then
        echo "${failed_services[*]}"
        return 1
    fi

    return 0
}

# Tentar recuperar o sistema
attempt_recovery() {
    log "INFO" "Iniciando tentativa de recuperação..."

    cd "$PROJECT_DIR"

    # Parar pgbouncer local se estiver rodando
    sudo systemctl stop pgbouncer 2>/dev/null || true
    sudo pkill -f pgbouncer 2>/dev/null || true

    # Reiniciar containers
    docker-compose down --remove-orphans 2>/dev/null
    sleep 5
    docker-compose up -d 2>&1

    # Aguardar inicialização
    log "INFO" "Aguardando containers iniciarem..."
    sleep 30

    # Verificar novamente
    if check_system_health > /dev/null 2>&1; then
        log "INFO" "Sistema recuperado com sucesso!"
        return 0
    else
        log "WARN" "Sistema ainda com problemas após recuperação"
        return 1
    fi
}

# Função principal
main() {
    log "INFO" "=== Watchdog iniciado ==="

    # Verificar saúde
    local failed=$(check_system_health)

    if [ -z "$failed" ]; then
        # Sistema OK
        if [ -f "$STATE_FILE" ]; then
            # Estava em recuperação e agora está OK - notificar!
            rm -f "$STATE_FILE"
            log "INFO" "Sistema recuperado - enviando notificação"
            notify_online
        elif [ -f "$FAILURE_FILE" ]; then
            # Havia falha anterior e agora está OK - notificar!
            log "INFO" "Sistema voltou ao normal - enviando notificação"
            notify_online
        fi
        log "INFO" "Sistema OK - todos os serviços funcionando"
        exit 0
    fi

    log "WARN" "Problema detectado: $failed"

    # Marcar que está com problema (para notificar quando voltar)
    if [ ! -f "$FAILURE_FILE" ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S')" > "$FAILURE_FILE"
    fi

    # Carregar estado anterior
    local attempts=0
    if [ -f "$STATE_FILE" ]; then
        attempts=$(cat "$STATE_FILE")
    fi

    # Tentar recuperação
    while [ $attempts -lt $MAX_RECOVERY_ATTEMPTS ]; do
        attempts=$((attempts + 1))
        echo "$attempts" > "$STATE_FILE"

        log "INFO" "Tentativa de recuperação $attempts de $MAX_RECOVERY_ATTEMPTS"

        if attempt_recovery; then
            rm -f "$STATE_FILE"
            log "INFO" "Recuperação bem-sucedida na tentativa $attempts"
            # Notificar que voltou online
            notify_online
            exit 0
        fi

        if [ $attempts -lt $MAX_RECOVERY_ATTEMPTS ]; then
            log "INFO" "Aguardando ${RECOVERY_WAIT_SECONDS}s antes da próxima tentativa..."
            sleep $RECOVERY_WAIT_SECONDS
        fi
    done

    # Todas as tentativas falharam - enviar alerta crítico
    log "ERROR" "FALHA CRÍTICA: Sistema não recuperou após $MAX_RECOVERY_ATTEMPTS tentativas"

    notify_offline "$failed"

    exit 1
}

# Executar
main "$@"
