#!/bin/bash

# Script para testar se o rastreador responde a comandos
# PASSO 1 do diagnóstico

IMEI="356354870699551"
API_URL="http://localhost:62000"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        TESTE 1: Verificar se Rastreador Responde              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

echo "📡 Enviando comando STATUS para rastreador: $IMEI"
echo ""

# Enviar comando de status
curl -s -X POST "$API_URL/api/comandos/$IMEI" \
  -H "Content-Type: application/json" \
  -d '{"comandoRaw": "#55555#YSTATUS#"}' | jq .

echo ""
echo "⏳ Aguardando 3 segundos para rastreador processar..."
sleep 3

echo ""
echo "🔍 Verificando logs para resposta do rastreador..."
echo ""

tail -20 /tmp/server.log | grep -i "status\|response\|comando\|tcp" | tail -10

echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "INTERPRETAÇÃO DOS RESULTADOS:"
echo ""
echo "✅ SE nos logs aparecer:"
echo "   [TCP] 📦 Recebido X bytes | Preview: ..."
echo "   └─ Rastreador RESPONDEU ✅"
echo "   └─ Ir para PASSO 3 (enviar toda sequência)"
echo ""
echo "❌ SE nos logs NÃO aparecer nada novo:"
echo "   └─ Rastreador IGNOROU o comando ❌"
echo "   └─ Ir para PASSO 4 (usar painel X3Tech)"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📋 PRÓXIMO PASSO:"
echo ""
echo "Se respondeu:"
echo "  ./teste-init-completo.sh"
echo ""
echo "Se não respondeu:"
echo "  Acessar painel X3Tech: 10.255.13.X ou app"
echo "  Ativar GPS/OBD2 manualmente"
echo ""
