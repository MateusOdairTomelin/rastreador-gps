#!/bin/bash
# =============================================================================
# Teste de envio de WhatsApp
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.env"

echo "🔧 Testando envio de WhatsApp..."
echo ""
echo "Provedor: ${WHATSAPP_PROVIDER:-callmebot}"
echo "Número: $WHATSAPP_PHONE"
echo "API Key: ${WHATSAPP_APIKEY:0:8}..."
echo ""

if [ "$WHATSAPP_APIKEY" == "SUA_API_KEY_AQUI" ] || [ -z "$WHATSAPP_APIKEY" ]; then
    echo "❌ WhatsApp não configurado!"
    echo ""
    if [ "$WHATSAPP_PROVIDER" == "textmebot" ]; then
        echo "Para configurar TextMeBot:"
        echo "1. Acesse https://www.textmebot.com/"
        echo "2. Clique em 'Get ApiKey' e informe seu email"
        echo "3. Siga as instruções do email para conectar seu WhatsApp"
        echo "4. Edite $SCRIPT_DIR/config.env com sua API key"
    else
        echo "Para configurar CallMeBot:"
        echo "1. Adicione +34 644 51 95 23 aos contatos do WhatsApp"
        echo "2. Envie: I allow callmebot to send me messages"
        echo "3. Edite $SCRIPT_DIR/config.env com sua API key"
    fi
    exit 1
fi

message="✅ *TESTE* - Sistema de Monitoramento

🖥️ Servidor: $(hostname)
📅 $(date '+%d/%m/%Y %H:%M:%S')

Se você recebeu esta mensagem, o sistema de alertas está funcionando corretamente!"

encoded_message=$(echo -n "$message" | python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read()))")

provider="${WHATSAPP_PROVIDER:-callmebot}"

if [ "$provider" == "textmebot" ]; then
    url="https://api.textmebot.com/send.php?recipient=${WHATSAPP_PHONE}&apikey=${WHATSAPP_APIKEY}&text=${encoded_message}"
else
    url="https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${encoded_message}&apikey=${WHATSAPP_APIKEY}"
fi

echo "Enviando mensagem de teste via $provider..."
response=$(curl -s -w "\n%{http_code}" "$url")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" == "200" ]; then
    echo ""
    echo "✅ Mensagem enviada com sucesso!"
    echo "Verifique seu WhatsApp."
else
    echo ""
    echo "❌ Erro ao enviar (HTTP $http_code)"
    echo "Resposta: $body"
fi
