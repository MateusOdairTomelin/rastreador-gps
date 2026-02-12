#!/bin/bash
# Script para limpar consumers mortos dos Redis Streams
# Executar periodicamente ou após reiniciar containers

REDIS_PASSWORD="${REDIS_PASSWORD:-UI6+PBaM/EMhf7I4tX6i9qdhtzKg6nttX7VO28oGa90=}"
REDIS_HOST="${REDIS_HOST:-rastreador-redis}"
REDIS_DB=2

# Função para executar comando Redis
redis_cmd() {
    docker exec $REDIS_HOST redis-cli -a "$REDIS_PASSWORD" -n $REDIS_DB $@ 2>/dev/null
}

echo "=== Limpeza de Consumers Redis ==="
echo ""

# Streams e grupos
declare -A STREAMS
STREAMS["gps:packets:location"]="location-processors"
STREAMS["gps:packets:status"]="status-processors"
STREAMS["gps:packets:alarm"]="alarm-processors"

# Workers válidos (prefixos)
VALID_PREFIXES=("loc-" "status-" "alarm-")

for STREAM in "${!STREAMS[@]}"; do
    GROUP="${STREAMS[$STREAM]}"
    echo "Verificando $STREAM ($GROUP)..."

    # Listar consumers
    CONSUMERS=$(redis_cmd XINFO CONSUMERS "$STREAM" "$GROUP" | grep -A1 "^name$" | grep -v "^name$" | grep -v "^--$")

    for CONSUMER in $CONSUMERS; do
        IS_VALID=false

        # Verificar se é um consumer válido (tem prefixo correto)
        for PREFIX in "${VALID_PREFIXES[@]}"; do
            if [[ "$CONSUMER" == $PREFIX* ]]; then
                IS_VALID=true
                break
            fi
        done

        if [ "$IS_VALID" = false ]; then
            echo "  ❌ Removendo consumer inválido: $CONSUMER"
            redis_cmd XGROUP DELCONSUMER "$STREAM" "$GROUP" "$CONSUMER"
        else
            echo "  ✅ Consumer válido: $CONSUMER"
        fi
    done
done

echo ""
echo "=== Status Final ==="
for STREAM in "${!STREAMS[@]}"; do
    GROUP="${STREAMS[$STREAM]}"
    echo ""
    echo "$STREAM:"
    redis_cmd XINFO CONSUMERS "$STREAM" "$GROUP" | grep -A1 "^name$" | grep -v "^name$" | grep -v "^--$" | while read name; do
        echo "  - $name"
    done
done
