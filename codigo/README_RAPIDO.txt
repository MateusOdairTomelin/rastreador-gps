═══════════════════════════════════════════════════════════════════════════════
   🚗 RASTREADOR VEICULAR COM PROTOCOLO GT06
═══════════════════════════════════════════════════════════════════════════════

✅ STATUS: SISTEMA PRONTO PARA USO

═══════════════════════════════════════════════════════════════════════════════
📍 ACESSAR AGORA
═══════════════════════════════════════════════════════════════════════════════

Dashboard Principal:
  http://6754056cd710.sn.mynetname.net:62000/admin-dashboard.html

Debug de Pacotes:
  http://6754056cd710.sn.mynetname.net:62000/debug-packets.html

═══════════════════════════════════════════════════════════════════════════════
🚀 INICIAR SERVIDOR
═══════════════════════════════════════════════════════════════════════════════

OPÇÃO 1: Terminal Normal
  $ cd /home/tomelin/rastreador
  $ npm start

OPÇÃO 2: Keep-Alive (Recomendado)
  $ ./keep-server-alive.sh

OPÇÃO 3: TMUX (Desenvolvimento)
  $ tmux new -s rastreador -d
  $ tmux send-keys -t rastreador "npm start" Enter
  $ tmux attach -t rastreador

OPÇÃO 4: Systemd (Produção)
  $ sudo systemctl start rastreador
  $ sudo systemctl status rastreador

═══════════════════════════════════════════════════════════════════════════════
✅ VERIFICAR SE ESTÁ ONLINE
═══════════════════════════════════════════════════════════════════════════════

API Status:
  $ curl http://localhost:62000/api/status

Dispositivos:
  $ curl http://localhost:62000/api/dispositivos | jq

Debug Packets:
  $ curl http://localhost:62000/api/debug/packets | jq

═══════════════════════════════════════════════════════════════════════════════
📊 DADOS COLETADOS
═══════════════════════════════════════════════════════════════════════════════

✅ Login (0x01)        - IMEI e conexão
✅ Location (0x12)     - GPS (lat, lon, velocidade, direção)
✅ OBD2 (0x94)         - RPM, temperatura, combustível, ignição
✅ Alarm (0x16)        - SOS, overspeed, geofence, etc
✅ Status (0x13)       - Bateria, sinal

═══════════════════════════════════════════════════════════════════════════════
🔧 FEATURES PRINCIPAIS
═══════════════════════════════════════════════════════════════════════════════

✅ Coleta automática de dados GT06
✅ Validação de coordenadas e dados
✅ WebSocket em tempo real
✅ Dashboard de debug com filtros
✅ API REST completa
✅ PostgreSQL persistindo dados
✅ Heartbeat/presença dos rastreadores
✅ Comandos SMS para rastreador
✅ Mapa interativo com marcadores
✅ Log de alarmes

═══════════════════════════════════════════════════════════════════════════════
📋 DOCUMENTAÇÃO
═══════════════════════════════════════════════════════════════════════════════

Implementação completa:
  $ cat RESUMO_IMPLEMENTACAO_GT06.md

Manter servidor online:
  $ cat MANTER_SERVIDOR_RODANDO.md

Checklist de testes:
  $ cat CHECKLIST_VALIDACAO.md

═══════════════════════════════════════════════════════════════════════════════
🛑 PARAR SERVIDOR
═══════════════════════════════════════════════════════════════════════════════

Systemd:
  $ sudo systemctl stop rastreador

TMUX:
  $ tmux kill-session -t rastreador

Keep-Alive:
  $ pkill -f "keep-server-alive"

Normal:
  Ctrl+C no terminal

═══════════════════════════════════════════════════════════════════════════════
⚡ DICAS RÁPIDAS
═══════════════════════════════════════════════════════════════════════════════

• Servidor inicia em 3-5 segundos
• Dashboard carrega automaticamente
• WebSocket reconecta se desconectar
• Dados salvam em tempo real no PostgreSQL
• Log em tempo real em /tmp/rastreador-server.log
• Rastreador conecta na porta 8877

═══════════════════════════════════════════════════════════════════════════════
✅ PRONTO PARA USO!

Desenvolvido com Claude Code - https://claude.com/claude-code
Última atualização: 2025-12-10
═══════════════════════════════════════════════════════════════════════════════
