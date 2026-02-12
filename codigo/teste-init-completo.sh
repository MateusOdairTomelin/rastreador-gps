#!/bin/bash

# Script para enviar sequência completa de inicialização
# PASSO 3 do diagnóstico

IMEI="356354870699551"
API_URL="http://localhost:62000"
DELAY=3  # Delay de 3 segundos entre comandos

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        TESTE 3: Enviar Sequência Completa de Init             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "🚀 Iniciando sequência de 6 comandos para: $IMEI"
echo "⏱️  Delay entre comandos: ${DELAY}s"
echo ""

# COMANDO 1: GPS ON
echo "📡 [1/6] Ativar GPS..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}' | jq '.mensagem' -r
sleep $DELAY

# COMANDO 2: OBD ON
echo "📡 [2/6] Ativar OBD2..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}' | jq '.mensagem' -r
sleep $DELAY

# COMANDO 3: UPLOAD 10S
echo "📡 [3/6] Intervalo de Upload 10 segundos..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_10S"}' | jq '.mensagem' -r
sleep $DELAY

# COMANDO 4: ONLINE ON
echo "📡 [4/6] Modo Online..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "ONLINE_ON"}' | jq '.mensagem' -r
sleep $DELAY

# COMANDO 5: CONNECT ON
echo "📡 [5/6] Manter Conexão..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "CONNECT_ON"}' | jq '.mensagem' -r
sleep $DELAY

# COMANDO 6: DIAG ON
echo "📡 [6/6] Diagnóstico..."
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comando": "DIAG_ON"}' | jq '.mensagem' -r

echo ""
echo "✅ Todos os comandos foram enviados!"
echo ""
echo "⏳ Aguardando 15 segundos para rastreador processar..."
sleep 15

echo ""
echo "🔍 Verificando estatísticas de pacotes..."
echo ""

# Verificar se location packets foram recebidos
STATS=$(curl -s "$API_URL/api/debug/packets" | jq '.estatisticas.por_tipo')

echo "📊 Pacotes recebidos:"
echo "$STATS" | jq .

# Extrair valor de location
LOCATION=$(echo "$STATS" | jq '.location')

echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""

if [ "$LOCATION" -gt 0 ]; then
  echo "✅ SUCESSO! Location packets começaram a chegar!"
  echo "   Dashboard agora deve mostrar dados GPS!"
  echo ""
  echo "📊 Acessar:"
  echo "   Dashboard: http://6754056cd710.sn.mynetname.net:62000/admin-dashboard.html"
  echo "   Debug: http://6754056cd710.sn.mynetname.net:62000/debug-packets.html"
else
  echo "❌ ERRO: Nenhum Location packet recebido ainda"
  echo ""
  echo "Possíveis causas:"
  echo "  1. Rastreador está esperando mais tempo para processar"
  echo "  2. Rastreador precisa estar a céu aberto para GPS lock"
  echo "  3. Rastreador não responde a comandos TCP"
  echo ""
  echo "Próximos passos:"
  echo "  1. Aguarde mais 2-3 minutos"
  echo "  2. Leve rastreador para fora (céu aberto)"
  echo "  3. Verifique painel X3Tech se rastreador suporta TCP commands"
fi

echo ""
echo "════════════════════════════════════════════════════════════════"
