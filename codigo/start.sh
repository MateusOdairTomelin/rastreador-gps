#!/bin/bash

echo "=========================================="
echo "🚗 Iniciando Sistema de Rastreamento"
echo "=========================================="

# Verificar se Node.js está instalado
if ! command -v node &> /dev/null; then
    echo "❌ Node.js não está instalado!"
    echo "Instale com: sudo apt-get install nodejs npm"
    exit 1
fi

echo "✅ Node.js instalado: $(node --version)"
echo "✅ npm instalado: $(npm --version)"

# Instalar dependências se não existirem
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 Instalando dependências..."
    npm install
fi

# Mostrar informações de rede
echo ""
echo "=========================================="
echo "📡 INFORMAÇÕES DE REDE"
echo "=========================================="
echo ""

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    echo "IPs disponíveis:"
    hostname -I
elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "IPs disponíveis:"
    ifconfig | grep "inet " | awk '{print $2}'
fi

echo ""
echo "=========================================="
echo "🚀 INICIANDO SERVIDOR"
echo "=========================================="
echo ""

# Iniciar servidor
export HTTP_PORT=62000
export TCP_PORT=8877
export API_PORT=62000
node server/index.js
