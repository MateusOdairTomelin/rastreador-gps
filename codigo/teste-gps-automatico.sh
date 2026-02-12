#!/bin/bash

# Script de Teste Automático GPS - Para Suas Portas (62000, 8877)
# Uso: ./teste-gps-automatico.sh
# Faz tudo automaticamente!

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Config
HOST="localhost"
PORT="62000"
BASE_URL="http://$HOST:$PORT/api"

# Funções
print_header() {
  echo -e "\n${CYAN}═══════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}\n"
}

print_success() {
  echo -e "${GREEN}✓${NC} $1"
}

print_error() {
  echo -e "${RED}✗${NC} $1"
}

print_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

print_step() {
  echo -e "${YELLOW}→${NC} $1"
}

# Main
main() {
  clear
  print_header "TESTE AUTOMÁTICO GPS/OBD2 XT40"

  print_info "Versão: 1.0 | Porta API: $PORT | Porta TCP: 8877"

  # PASSO 1: Verificar conexão com servidor
  print_step "Passo 1: Verificando conexão com servidor..."

  if ! curl -s "$BASE_URL/status" > /dev/null 2>&1; then
    print_error "Não consegui conectar em http://$HOST:$PORT"
    print_info "Certifique-se que o servidor está rodando: npm start"
    exit 1
  fi

  print_success "Servidor respondendo em $BASE_URL"

  # PASSO 2: Descobrir IMEI
  print_step "Passo 2: Descobrindo IMEI do XT40 conectado..."

  response=$(curl -s "$BASE_URL/conexoes")
  total=$(echo "$response" | jq '.total' 2>/dev/null || echo "0")

  if [ "$total" -eq 0 ]; then
    print_error "Nenhum dispositivo conectado!"
    print_info "Conecte o XT40 na porta 8877 e tente novamente"
    exit 1
  fi

  IMEI=$(echo "$response" | jq -r '.dispositivos[0].imei' 2>/dev/null)

  if [ -z "$IMEI" ] || [ "$IMEI" = "null" ]; then
    print_error "Não consegui extrair o IMEI"
    echo "$response" | jq '.'
    exit 1
  fi

  print_success "IMEI detectado: $IMEI"

  # PASSO 3: Enviar comandos de init
  print_step "Passo 3: Enviando comandos de inicialização..."
  print_info "  - Ativar GPS"
  print_info "  - Ativar OBD2"
  print_info "  - Intervalo 10 segundos"
  print_info "  - Modo online"

  response=$(curl -s -X POST "$BASE_URL/comandos/$IMEI/init" \
    -H "Content-Type: application/json")

  if echo "$response" | jq -e '.sucesso' >/dev/null 2>&1; then
    print_success "Comandos enviados com sucesso"
  else
    print_error "Erro ao enviar comandos"
    echo "$response" | jq '.'
    exit 1
  fi

  # PASSO 4: Aguardar processamento
  print_step "Passo 4: Aguardando processamento do XT40..."
  print_info "Isto pode levar 15-20 segundos..."

  for i in {20..1}; do
    printf "\r${BLUE}⏳ Aguardando... %2d segundos${NC}" "$i"
    sleep 1
  done
  echo ""

  print_success "Aguardo concluído"

  # PASSO 5: Verificar se dados chegaram
  print_step "Passo 5: Verificando se dados de GPS chegaram..."

  locations=$(curl -s "$BASE_URL/localizacoes")
  location_total=$(echo "$locations" | jq '.total' 2>/dev/null || echo "0")

  if [ "$location_total" -gt 0 ]; then
    latitude=$(echo "$locations" | jq -r '.dados[0].latitude' 2>/dev/null)
    longitude=$(echo "$locations" | jq -r '.dados[0].longitude' 2>/dev/null)
    speed=$(echo "$locations" | jq -r '.dados[0].velocidade' 2>/dev/null)
    timestamp=$(echo "$locations" | jq -r '.dados[0].timestamp' 2>/dev/null)

    print_success "Dados de GPS recebidos!"
    echo ""
    echo -e "  ${CYAN}Localização:${NC}"
    echo -e "    Latitude:   $latitude"
    echo -e "    Longitude:  $longitude"
    echo -e "    Velocidade: $speed km/h"
    echo -e "    Timestamp:  $timestamp"
    echo ""
  else
    print_error "Nenhum dado de GPS recebido"
    print_info "Possíveis causas:"
    print_info "  1. GPS sem sinal (próximo a janela por 30+ segundos)"
    print_info "  2. XT40 não processou o comando"
    print_info "  3. Comando GPS_ON não foi aceito"
  fi

  # PASSO 6: Mostrar status
  print_step "Passo 6: Verificando status do dispositivo..."

  heartbeat=$(curl -s "$BASE_URL/heartbeats/$IMEI")
  status=$(echo "$heartbeat" | jq -r '.dados.status' 2>/dev/null)
  count=$(echo "$heartbeat" | jq -r '.dados.count' 2>/dev/null)

  if [ -n "$status" ] && [ "$status" != "null" ]; then
    print_success "Dispositivo status: $status"
    print_success "Total de heartbeats: $count"
  fi

  # RESULTADO FINAL
  echo ""
  print_header "RESULTADO DO TESTE"

  if [ "$location_total" -gt 0 ]; then
    print_success "✅ GPS FUNCIONANDO!"
    echo ""
    print_info "Próximos passos:"
    echo "  1. Mudar intervalo para 30s em produção:"
    echo "     curl -X POST http://$HOST:$PORT/api/comandos/$IMEI \\"
    echo "       -H 'Content-Type: application/json' \\"
    echo "       -d '{\"comando\": \"UPLOAD_30S\"}'"
    echo ""
    echo "  2. Acessar dashboard: http://$HOST:$PORT"
    echo ""
    echo "  3. Ver documentação: RESUMO_GPS_SOLUCAO.md"
  else
    print_error "❌ GPS NÃO ESTÁ FUNCIONAR"
    echo ""
    print_info "Problemas possíveis:"
    echo "  1. GPS não tem sinal - coloque perto de janela"
    echo "  2. Rastreador não recebeu comando - tente manualmente:"
    echo "     curl -X POST http://$HOST:$PORT/api/comandos/$IMEI \\"
    echo "       -H 'Content-Type: application/json' \\"
    echo "       -d '{\"comando\": \"GPS_ON\"}'"
    echo ""
    echo "  3. Ver documentação: GPS_TROUBLESHOOTING.md"
  fi

  echo ""
  print_info "Relatório completo:"
  echo ""
  echo "  Servidor:     http://$HOST:$PORT"
  echo "  IMEI:         $IMEI"
  echo "  Localizações: $location_total"
  echo "  Status:       $status"
  echo "  Heartbeats:   $count"
  echo ""
}

# Executar
main
