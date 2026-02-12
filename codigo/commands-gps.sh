#!/bin/bash

# Script para enviar comandos GPS/OBD2 ao XT40
# Uso: ./commands-gps.sh IMEI COMANDO
# Exemplo: ./commands-gps.sh 358758091234567 GPS_ON

set -e

# Cores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Config
HOST="${HOST:-localhost}"
PORT="${PORT:-62000}"
BASE_URL="http://$HOST:$PORT/api"

# Funções
print_header() {
  echo -e "${BLUE}════════════════════════════════════${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}════════════════════════════════════${NC}"
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

# Função para enviar comando
send_command() {
  local imei=$1
  local comando=$2

  if [ -z "$imei" ] || [ -z "$comando" ]; then
    print_error "IMEI e comando são obrigatórios"
    return 1
  fi

  print_info "Enviando: $comando para IMEI: $imei"

  response=$(curl -s -X POST "$BASE_URL/comandos/$imei" \
    -H "Content-Type: application/json" \
    -d "{\"comando\": \"$comando\"}")

  if echo "$response" | grep -q '"sucesso":true'; then
    print_success "Comando enviado!"
    echo "$response" | jq '.'
  else
    print_error "Erro ao enviar comando"
    echo "$response" | jq '.'
    return 1
  fi
}

# Função para listar conexões
list_connections() {
  print_info "Buscando dispositivos conectados..."

  response=$(curl -s "$BASE_URL/conexoes")

  if echo "$response" | grep -q '"total":0'; then
    print_error "Nenhum dispositivo conectado!"
    return 1
  fi

  print_success "Dispositivos conectados:"
  echo "$response" | jq '.dispositivos[] | {imei, remoteAddress, remotePort}'
}

# Função para enviar init
send_init() {
  local imei=$1

  if [ -z "$imei" ]; then
    print_error "IMEI é obrigatório"
    return 1
  fi

  print_info "Enviando comandos de inicialização para: $imei"
  print_info "Isto vai: ativar GPS + OBD2 + intervalo 10s + modo online"

  response=$(curl -s -X POST "$BASE_URL/comandos/$imei/init" \
    -H "Content-Type: application/json")

  if echo "$response" | grep -q '"sucesso":true'; then
    print_success "Comandos de inicialização enviados!"
    echo "$response" | jq '.'
  else
    print_error "Erro ao enviar comandos"
    echo "$response" | jq '.'
    return 1
  fi
}

# Função para listar comandos disponíveis
list_commands() {
  print_info "Comandos disponíveis:"

  response=$(curl -s "$BASE_URL/comandos")
  echo "$response" | jq '.comandos'
}

# Função para ver localizações
get_locations() {
  print_info "Últimas localizações:"

  response=$(curl -s "$BASE_URL/localizacoes")

  local total=$(echo "$response" | jq '.total')

  if [ "$total" -eq 0 ]; then
    print_error "Nenhuma localização registrada"
    return 1
  fi

  print_success "Total de localizações: $total"
  echo "$response" | jq '.dados[0:3]'
}

# Função para ver heartbeat
get_heartbeat() {
  local imei=$1

  if [ -z "$imei" ]; then
    print_error "IMEI é obrigatório"
    return 1
  fi

  print_info "Status do dispositivo: $imei"

  response=$(curl -s "$BASE_URL/heartbeats/$imei")
  echo "$response" | jq '.dados'
}

# Menu principal
show_menu() {
  print_header "GPS/OBD2 Command Helper"
  echo ""
  echo "Comandos disponíveis:"
  echo "  1) Listar dispositivos conectados"
  echo "  2) Enviar comando GPS_ON"
  echo "  3) Enviar comando OBD_ON"
  echo "  4) Enviar comando UPLOAD_10S"
  echo "  5) Enviar comando UPLOAD_30S"
  echo "  6) Enviar todos os comandos init (GPS+OBD+etc)"
  echo "  7) Ver status do dispositivo (heartbeat)"
  echo "  8) Ver localizações"
  echo "  9) Listar comandos disponíveis"
  echo "  0) Sair"
  echo ""
}

# Menu interativo
run_interactive() {
  local imei=""

  while true; do
    show_menu

    read -p "Escolha uma opção: " choice

    case $choice in
      1)
        list_connections
        read -p "Copiar o IMEI acima para usar em outros comandos"
        ;;
      2)
        list_connections
        read -p "Digite o IMEI: " imei
        send_command "$imei" "GPS_ON"
        ;;
      3)
        read -p "Digite o IMEI: " imei
        send_command "$imei" "OBD_ON"
        ;;
      4)
        read -p "Digite o IMEI: " imei
        send_command "$imei" "UPLOAD_10S"
        ;;
      5)
        read -p "Digite o IMEI: " imei
        send_command "$imei" "UPLOAD_30S"
        ;;
      6)
        list_connections
        read -p "Digite o IMEI: " imei
        send_init "$imei"
        ;;
      7)
        read -p "Digite o IMEI: " imei
        get_heartbeat "$imei"
        ;;
      8)
        get_locations
        ;;
      9)
        list_commands
        ;;
      0)
        print_info "Encerrando..."
        exit 0
        ;;
      *)
        print_error "Opção inválida"
        ;;
    esac

    echo ""
    read -p "Pressione ENTER para continuar..."
    clear
  done
}

# Main
main() {
  # Verificar argumentos
  if [ $# -eq 0 ]; then
    # Modo interativo
    run_interactive
  else
    # Modo linha de comando
    case "$1" in
      list)
        list_connections
        ;;
      init)
        if [ -z "$2" ]; then
          print_error "IMEI é obrigatório: $0 init <IMEI>"
          exit 1
        fi
        send_init "$2"
        ;;
      send)
        if [ -z "$2" ] || [ -z "$3" ]; then
          print_error "Uso: $0 send <IMEI> <COMANDO>"
          print_info "Comandos: GPS_ON, OBD_ON, UPLOAD_10S, STATUS, etc"
          exit 1
        fi
        send_command "$2" "$3"
        ;;
      status)
        if [ -z "$2" ]; then
          print_error "IMEI é obrigatório: $0 status <IMEI>"
          exit 1
        fi
        get_heartbeat "$2"
        ;;
      locations)
        get_locations
        ;;
      commands)
        list_commands
        ;;
      *)
        echo "Uso: $0 [COMANDO] [ARGUMENTOS]"
        echo ""
        echo "Comandos:"
        echo "  list              - Listar dispositivos conectados"
        echo "  init <IMEI>       - Enviar comandos de inicialização"
        echo "  send <IMEI> <CMD> - Enviar comando específico"
        echo "  status <IMEI>     - Ver status do dispositivo"
        echo "  locations         - Ver localizações"
        echo "  commands          - Listar comandos disponíveis"
        echo ""
        echo "Exemplos:"
        echo "  $0 list"
        echo "  $0 init 358758091234567"
        echo "  $0 send 358758091234567 GPS_ON"
        echo "  $0 status 358758091234567"
        echo ""
        echo "Sem argumentos: inicia modo interativo"
        exit 1
        ;;
    esac
  fi
}

# Executar
main "$@"
