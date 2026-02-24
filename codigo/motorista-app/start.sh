#!/bin/bash
# Script para iniciar o Expo matando processos pendentes

echo "🧹 Limpando processos pendentes..."

# Matar processos Expo/Metro anteriores
pkill -f "expo start" 2>/dev/null
pkill -f "metro" 2>/dev/null
pkill -f "@expo/ngrok" 2>/dev/null

# Aguardar processos morrerem
sleep 1

# Limpar porta 8081 (Metro) se estiver em uso
fuser -k 8081/tcp 2>/dev/null

# Limpar porta 19000/19001 (Expo) se estiver em uso
fuser -k 19000/tcp 2>/dev/null
fuser -k 19001/tcp 2>/dev/null

echo "✅ Processos limpos"
echo "🚀 Iniciando Expo..."

cd /home/tomelin/rastreador/codigo/motorista-app
npx expo start --tunnel --clear
