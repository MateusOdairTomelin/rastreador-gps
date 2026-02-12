#!/bin/bash
# =============================================================================
# Instalador do Sistema de Monitoramento do Rastreador
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 Instalando Sistema de Monitoramento do Rastreador..."
echo ""

# Verificar se está rodando como root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Este script precisa ser executado como root (sudo)"
    exit 1
fi

# Tornar scripts executáveis
chmod +x "$SCRIPT_DIR/watchdog.sh"

# Copiar arquivos do systemd
cp "$SCRIPT_DIR/rastreador-watchdog.service" /etc/systemd/system/
cp "$SCRIPT_DIR/rastreador-watchdog.timer" /etc/systemd/system/

# Recarregar systemd
systemctl daemon-reload

# Habilitar e iniciar o timer
systemctl enable rastreador-watchdog.timer
systemctl start rastreador-watchdog.timer

echo ""
echo "✅ Instalação concluída!"
echo ""
echo "📋 Próximos passos:"
echo ""
echo "1. Configure o WhatsApp editando o arquivo:"
echo "   nano $SCRIPT_DIR/config.env"
echo ""
echo "2. Para obter a API key do CallMeBot:"
echo "   - Adicione +34 644 51 95 23 aos contatos do WhatsApp"
echo "   - Envie: I allow callmebot to send me messages"
echo "   - Você receberá sua API key por mensagem"
echo ""
echo "3. Comandos úteis:"
echo "   - Ver status: systemctl status rastreador-watchdog.timer"
echo "   - Ver logs:   journalctl -u rastreador-watchdog -f"
echo "   - Testar:     $SCRIPT_DIR/watchdog.sh"
echo ""
