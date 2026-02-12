#!/bin/bash
# ============================================================
# Script de Instalação - Nova VM para Sistema Rastreador
# Compatível com: Ubuntu 20.04/22.04/24.04, Debian 11/12
# ============================================================

set -e

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
    echo ""
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}============================================${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}[✓] $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}[!] $1${NC}"
}

print_error() {
    echo -e "${RED}[✗] $1${NC}"
}

print_step() {
    echo -e "${BLUE}[→] $1${NC}"
}

# Verificar se é root
if [ "$EUID" -ne 0 ]; then
    print_error "Execute como root: sudo $0"
    exit 1
fi

print_header "INSTALAÇÃO DO AMBIENTE - SISTEMA RASTREADOR"

echo "Este script irá instalar:"
echo "  - Docker e Docker Compose"
echo "  - Node.js 20 LTS"
echo "  - Git"
echo "  - Ferramentas úteis (htop, curl, etc.)"
echo ""
read -p "Continuar? (s/n): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo "Instalação cancelada."
    exit 0
fi

# ============ 1. ATUALIZAR SISTEMA ============
print_header "1/6 - ATUALIZANDO SISTEMA"
apt-get update
apt-get upgrade -y
print_success "Sistema atualizado"

# ============ 2. INSTALAR DEPENDÊNCIAS BÁSICAS ============
print_header "2/6 - INSTALANDO DEPENDÊNCIAS BÁSICAS"
apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    software-properties-common \
    git \
    htop \
    net-tools \
    unzip \
    wget \
    jq \
    tree \
    rsync

print_success "Dependências básicas instaladas"

# ============ 3. INSTALAR DOCKER ============
print_header "3/6 - INSTALANDO DOCKER"

# Remover versões antigas
apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

# Adicionar chave GPG oficial do Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Detectar distribuição
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO=$ID
else
    DISTRO="ubuntu"
fi

# Adicionar repositório
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO} \
  $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instalar Docker
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Iniciar e habilitar Docker
systemctl start docker
systemctl enable docker

# Adicionar usuário ao grupo docker (se não for root)
if [ -n "$SUDO_USER" ]; then
    usermod -aG docker $SUDO_USER
    print_warning "Usuário $SUDO_USER adicionado ao grupo docker"
fi

print_success "Docker instalado: $(docker --version)"
print_success "Docker Compose instalado: $(docker compose version)"

# ============ 4. INSTALAR NODE.JS 20 LTS ============
print_header "4/6 - INSTALANDO NODE.JS 20 LTS"

# Remover versões antigas do NodeSource
rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true

# Instalar via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verificar instalação
print_success "Node.js instalado: $(node --version)"
print_success "NPM instalado: $(npm --version)"

# ============ 5. CONFIGURAR FIREWALL ============
print_header "5/6 - CONFIGURANDO FIREWALL"

# Instalar UFW se não existir
apt-get install -y ufw

# Configurar regras
ufw --force reset
ufw default deny incoming
ufw default allow outgoing

# Portas do sistema
ufw allow 22/tcp comment 'SSH'
ufw allow 62000/tcp comment 'Rastreador HTTP/WebSocket'
ufw allow 8877/tcp comment 'Rastreador TCP XT40 Cabo'
ufw allow 8878/tcp comment 'Rastreador TCP XT40 OBD2'
ufw allow 3000/tcp comment 'Grafana'
ufw allow 9090/tcp comment 'Prometheus'

# Habilitar firewall
ufw --force enable

print_success "Firewall configurado"
echo ""
ufw status

# ============ 6. CONFIGURAÇÕES FINAIS ============
print_header "6/6 - CONFIGURAÇÕES FINAIS"

# Criar diretório do projeto
mkdir -p /home/tomelin/rastreador
if [ -n "$SUDO_USER" ]; then
    chown -R $SUDO_USER:$SUDO_USER /home/tomelin
fi

# Configurar limites do sistema para produção
cat >> /etc/sysctl.conf << 'EOF'

# Otimizações para Sistema Rastreador
# Aumentar conexões TCP
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535

# Reusar conexões TIME_WAIT
net.ipv4.tcp_tw_reuse = 1

# Aumentar range de portas efêmeras
net.ipv4.ip_local_port_range = 1024 65535

# Memória para buffers de rede
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216

# Limite de arquivos abertos
fs.file-max = 2097152
EOF

sysctl -p

# Configurar limites de arquivos abertos
cat >> /etc/security/limits.conf << 'EOF'

# Limites para Sistema Rastreador
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF

# Criar script de verificação
cat > /usr/local/bin/verificar-sistema << 'EOF'
#!/bin/bash
echo "=== Verificação do Sistema Rastreador ==="
echo ""
echo "Docker: $(docker --version 2>/dev/null || echo 'NÃO INSTALADO')"
echo "Docker Compose: $(docker compose version 2>/dev/null || echo 'NÃO INSTALADO')"
echo "Node.js: $(node --version 2>/dev/null || echo 'NÃO INSTALADO')"
echo "NPM: $(npm --version 2>/dev/null || echo 'NÃO INSTALADO')"
echo ""
echo "=== Status dos Containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "Nenhum container rodando"
echo ""
echo "=== Uso de Disco ==="
df -h / | tail -1
echo ""
echo "=== Memória ==="
free -h | grep Mem
EOF
chmod +x /usr/local/bin/verificar-sistema

print_success "Configurações finais aplicadas"

# ============ RESUMO FINAL ============
print_header "INSTALAÇÃO CONCLUÍDA!"

echo -e "
${GREEN}Tudo instalado com sucesso!${NC}

${YELLOW}Versões instaladas:${NC}
  - Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')
  - Docker Compose: $(docker compose version | cut -d' ' -f4)
  - Node.js: $(node --version)
  - NPM: $(npm --version)

${YELLOW}Portas liberadas no firewall:${NC}
  - 22    → SSH
  - 62000 → HTTP/WebSocket (Sistema)
  - 8877  → TCP Rastreador XT40 Cabo
  - 8878  → TCP Rastreador XT40 OBD2
  - 3000  → Grafana
  - 9090  → Prometheus

${YELLOW}Próximos passos:${NC}
  1. Copie o arquivo de exportação para esta VM
  2. Extraia: tar -xzvf rastreador-completo-*.tar.gz
  3. Entre na pasta: cd export_*
  4. Execute: ./restaurar-sistema.sh

${YELLOW}Comando útil:${NC}
  verificar-sistema  → Verifica status do ambiente

${RED}IMPORTANTE:${NC} Faça logout e login novamente para aplicar
permissões do grupo docker (ou execute: newgrp docker)
"
