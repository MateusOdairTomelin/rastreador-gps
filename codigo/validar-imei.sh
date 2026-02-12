#!/bin/bash

# Script de Validação de IMEI
# Valida se o IMEI do rastreador está correto e funcionando
# Uso: ./validar-imei.sh [IMEI]
# Exemplo: ./validar-imei.sh 358758091234567

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Variáveis
HOST="localhost"
PORT="62000"
BASE_URL="http://$HOST:$PORT/api"
IMEI="${1:-}"
PASSED=0
FAILED=0

# Funções
print_header() {
  echo -e "\n${CYAN}═══════════════════════════════════════════════════════${NC}"
  echo -e "${CYAN}  $1${NC}"
  echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}\n"
}

print_success() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASSED++))
}

print_error() {
  echo -e "${RED}✗${NC} $1"
  ((FAILED++))
}

print_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

# Main
main() {
  clear
  print_header "VALIDAÇÃO DE IMEI - XT40"

  # Se não passou IMEI, tentar descobrir
  if [ -z "$IMEI" ]; then
    print_info "Nenhum IMEI especificado, descobrindo..."

    # Verificar conexão com servidor
    if ! curl -s "$BASE_URL/status" > /dev/null 2>&1; then
      print_error "Não consegui conectar ao servidor em $BASE_URL"
      print_info "Certifique-se que rodou: npm start"
      exit 1
    fi

    # Buscar IMEI conectado
    response=$(curl -s "$BASE_URL/conexoes")
    total=$(echo "$response" | jq '.total' 2>/dev/null || echo "0")

    if [ "$total" -eq 0 ]; then
      print_error "Nenhum dispositivo conectado"
      print_info "Conecte o XT40 e tente novamente"
      exit 1
    fi

    IMEI=$(echo "$response" | jq -r '.dispositivos[0].imei' 2>/dev/null)
    print_success "IMEI detectado: $IMEI"
  fi

  echo ""

  # ===== TESTE 1: Formato do IMEI =====
  print_info "Teste 1: Validar Formato do IMEI"
  echo "  IMEI: $IMEI"

  length=${#IMEI}
  if [ "$length" -eq 15 ]; then
    print_success "IMEI tem 15 dígitos"
  else
    print_error "IMEI tem $length dígitos (deve ser 15)"
  fi

  if echo "$IMEI" | grep -qE '^[0-9]{15}$'; then
    print_success "IMEI contém apenas números"
  else
    print_error "IMEI contém caracteres inválidos"
  fi

  echo ""

  # ===== TESTE 2: Servidor Respondendo =====
  print_info "Teste 2: Conectividade com Servidor"

  if curl -s "$BASE_URL/status" | jq -e '.sucesso' >/dev/null 2>&1; then
    print_success "Servidor respondendo em $BASE_URL"
  else
    print_error "Servidor não respondendo"
    exit 1
  fi

  echo ""

  # ===== TESTE 3: Dispositivo Conectado =====
  print_info "Teste 3: Verificar Se Dispositivo Está Conectado"

  response=$(curl -s "$BASE_URL/conexoes")
  connected=$(echo "$response" | jq --arg imei "$IMEI" '.dispositivos[] | select(.imei == $imei)' 2>/dev/null)

  if [ -n "$connected" ]; then
    ip=$(echo "$connected" | jq -r '.remoteAddress' 2>/dev/null)
    port=$(echo "$connected" | jq -r '.remotePort' 2>/dev/null)
    print_success "Dispositivo conectado em $ip:$port"
  else
    print_error "Dispositivo NÃO está conectado"
    print_info "Conecte o XT40 e tente novamente"
  fi

  echo ""

  # ===== TESTE 4: Heartbeat =====
  print_info "Teste 4: Verificar Heartbeat"

  response=$(curl -s "$BASE_URL/heartbeats/$IMEI")

  if echo "$response" | jq -e '.dados' >/dev/null 2>&1; then
    count=$(echo "$response" | jq -r '.dados.count' 2>/dev/null || echo "0")
    status=$(echo "$response" | jq -r '.dados.status' 2>/dev/null)
    timestamp=$(echo "$response" | jq -r '.dados.timestamp' 2>/dev/null)

    print_success "Heartbeat recebido ($count vezes)"
    print_info "  Status: $status"
    print_info "  Última conexão: $timestamp"
  else
    print_warning "Nenhum heartbeat encontrado"
  fi

  echo ""

  # ===== TESTE 5: Localizações =====
  print_info "Teste 5: Verificar Localizações GPS"

  response=$(curl -s "$BASE_URL/localizacoes")
  total=$(echo "$response" | jq '.total' 2>/dev/null || echo "0")

  if [ "$total" -gt 0 ]; then
    # Procurar localização com este IMEI
    location=$(echo "$response" | jq --arg imei "$IMEI" '.dados[] | select(.dispositivo.imei == $imei)' 2>/dev/null | head -1)

    if [ -n "$location" ]; then
      lat=$(echo "$location" | jq -r '.latitude' 2>/dev/null)
      lon=$(echo "$location" | jq -r '.longitude' 2>/dev/null)
      speed=$(echo "$location" | jq -r '.velocidade' 2>/dev/null)
      timestamp=$(echo "$location" | jq -r '.timestamp' 2>/dev/null)

      print_success "Localização encontrada para este IMEI"
      print_info "  Latitude: $lat"
      print_info "  Longitude: $lon"
      print_info "  Velocidade: $speed km/h"
      print_info "  Timestamp: $timestamp"
    else
      print_warning "Existem localizações no banco, mas nenhuma para este IMEI"
    fi
  else
    print_warning "Nenhuma localização no banco ainda"
  fi

  echo ""

  # ===== TESTE 6: Banco de Dados =====
  print_info "Teste 6: Verificar Banco de Dados"

  response=$(curl -s "$BASE_URL/dispositivos" 2>/dev/null || echo "{}")

  if echo "$response" | jq -e '.dados' >/dev/null 2>&1; then
    device=$(echo "$response" | jq --arg imei "$IMEI" '.dados[] | select(.imei == $imei)' 2>/dev/null)

    if [ -n "$device" ]; then
      tipo=$(echo "$device" | jq -r '.tipo' 2>/dev/null)
      status=$(echo "$device" | jq -r '.status' 2>/dev/null)
      ultima=$(echo "$device" | jq -r '.ultima_conexao' 2>/dev/null)

      print_success "Dispositivo registrado no banco de dados"
      print_info "  Tipo: $tipo"
      print_info "  Status: $status"
      print_info "  Última conexão: $ultima"
    else
      print_warning "Dispositivo não encontrado no banco"
    fi
  else
    print_warning "Não consegui consultar dispositivos"
  fi

  echo ""

  # ===== RESULTADO FINAL =====
  print_header "RESULTADO DA VALIDAÇÃO"

  echo "Testes passados: ${GREEN}$PASSED${NC}"
  echo "Testes falhados: ${RED}$FAILED${NC}"
  echo ""

  if [ "$FAILED" -eq 0 ]; then
    print_success "IMEI VALIDADO COM SUCESSO!"
    echo ""
    print_info "O IMEI $IMEI está:"
    echo "  ✅ Com formato correto"
    echo "  ✅ Conectado ao servidor"
    echo "  ✅ Enviando heartbeat"
    if [ "$total" -gt 0 ]; then
      echo "  ✅ Enviando localizações"
    else
      echo "  ⚠️ Sem localizações (ativar GPS com: ./commands-gps.sh)"
    fi
    echo ""
    echo "Próximos passos:"
    echo "  1. Rodar: npm start (se não estiver)"
    echo "  2. Ativar GPS: ./commands-gps.sh"
    echo "  3. Ver dashboard: http://$HOST:$PORT"
  else
    print_error "IMEI COM PROBLEMAS"
    echo ""
    print_info "Problemas encontrados:"

    if [ "$length" -ne 15 ]; then
      echo "  - IMEI não tem 15 dígitos"
    fi

    if ! echo "$IMEI" | grep -qE '^[0-9]{15}$'; then
      echo "  - IMEI contém caracteres inválidos"
    fi

    if [ -z "$connected" ]; then
      echo "  - Dispositivo não está conectado"
    fi

    if [ -z "$count" ] || [ "$count" = "0" ]; then
      echo "  - Nenhum heartbeat recebido"
    fi

    if [ "$total" -eq 0 ]; then
      echo "  - Nenhuma localização enviada"
    fi

    echo ""
    print_info "Soluções:"
    echo "  1. Verifique o IMEI no dispositivo físico"
    echo "  2. Certifique-se que XT40 está conectado na porta 8877"
    echo "  3. Verifique se npm start está rodando"
    echo "  4. Consulte: VALIDAR_IMEI.md"
  fi

  echo ""
}

# Executar
if [ -z "$IMEI" ] && [ "$1" != "" ]; then
  IMEI="$1"
fi

main
