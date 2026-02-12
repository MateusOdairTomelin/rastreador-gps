#!/bin/bash
# Monitor de logs do servidor para capturar dados brutos do XT40

IMEI="356354870702322"
DATA=$(date +%Y-%m-%d)
ARQUIVO_LOG="/home/tomelin/rastreador/coleta_dados/logs_servidor_${IMEI}_${DATA}.txt"

echo "=============================================="
echo "MONITOR DE LOGS DO SERVIDOR"
echo "IMEI: $IMEI"
echo "Arquivo: $ARQUIVO_LOG"
echo "=============================================="
echo ""

# Monitorar logs do nohup ou do processo node
if [ -f /home/tomelin/rastreador/nohup.out ]; then
    echo "Monitorando nohup.out..."
    tail -f /home/tomelin/rastreador/nohup.out | grep --line-buffered -E "(${IMEI}|XT40|OBD|GT06|pacote|dados|GPS|locali)" | tee -a "$ARQUIVO_LOG"
elif [ -f /home/tomelin/rastreador/server.log ]; then
    echo "Monitorando server.log..."
    tail -f /home/tomelin/rastreador/server.log | grep --line-buffered -E "(${IMEI}|XT40|OBD|GT06|pacote|dados|GPS|locali)" | tee -a "$ARQUIVO_LOG"
else
    echo "Monitorando stdout do processo node..."
    # Capturar logs do processo
    journalctl -f | grep --line-buffered -E "(${IMEI}|XT40|OBD|GT06|pacote|dados|GPS|locali)" | tee -a "$ARQUIVO_LOG"
fi
