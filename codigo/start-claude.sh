#!/bin/bash

SESSION="claude-session"
CONFIG_DIR="${HOME}/.config/claude-code"

# Criar diretório de configuração se não existir
mkdir -p "$CONFIG_DIR"

# Cores para output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Claude Code + TMUX ===${NC}"

# Verifica se a sessão já existe
if tmux has-session -t $SESSION 2>/dev/null; then
    echo -e "${GREEN}✓ Sessão existente encontrada${NC}"
    echo -e "${YELLOW}Reconectando...${NC}"
    tmux attach -t $SESSION
else
    echo -e "${YELLOW}Criando nova sessão TMUX...${NC}"
    tmux new-session -d -s $SESSION -x 200 -y 50

    # Enviar comando para iniciar claude com resume
    tmux send-keys -t $SESSION "clear && echo 'Inicializando Claude Code...' && sleep 1 && claude --resume" Enter

    echo -e "${GREEN}✓ Sessão criada e Claude iniciado${NC}"
    echo -e "${BLUE}Conectando à sessão...${NC}\n"

    sleep 2
    tmux attach -t $SESSION
fi
