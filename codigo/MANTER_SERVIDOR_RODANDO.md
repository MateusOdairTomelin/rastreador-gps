# Manter o Servidor Rodando Permanentemente

## Opção 1: Script Keep-Alive (Simples)

### Executar em Terminal
```bash
cd /home/tomelin/rastreador
./keep-server-alive.sh
```

**O que faz:**
- ✅ Inicia o servidor
- ✅ Verifica a cada 30 segundos se está rodando
- ✅ Reinicia automaticamente se cair
- ✅ Log em `/tmp/rastreador-server.log`

**Para parar:**
```bash
pkill -f "keep-server-alive"
```

---

## Opção 2: Usar TMUX (Recomendado - Melhor)

### Criar uma sessão persistente
```bash
# Criar sessão chamada 'rastreador'
tmux new -s rastreador -d

# Enviar comando para iniciar servidor
tmux send-keys -t rastreador "cd /home/tomelin/rastreador && npm start" Enter

# Verificar que está rodando
tmux list-sessions
```

### Depois, para reconectar:
```bash
# Reconectar à sessão existente
tmux attach -t rastreador

# Para sair sem matar o processo: Ctrl+B, depois D
```

### Para parar:
```bash
tmux kill-session -t rastreador
```

---

## Opção 3: Serviço Systemd (Produção)

Crie o arquivo `/etc/systemd/system/rastreador.service`:

```ini
[Unit]
Description=Rastreador Veicular - Servidor Node.js
After=network.target postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/home/tomelin/rastreador
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Ativar o serviço:
```bash
# Recarregar serviços
sudo systemctl daemon-reload

# Ativar no boot
sudo systemctl enable rastreador

# Iniciar agora
sudo systemctl start rastreador

# Verificar status
sudo systemctl status rastreador

# Ver logs
journalctl -u rastreador -f
```

### Parar:
```bash
sudo systemctl stop rastreador
```

---

## Opção 4: PM2 (Node.js Process Manager)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Iniciar servidor com PM2
pm2 start npm --name "rastreador" -- start

# Fazer iniciar no boot
pm2 startup
pm2 save

# Ver status
pm2 status

# Ver logs
pm2 logs rastreador

# Parar
pm2 stop rastreador
```

---

## ✅ Verificar se está rodando

```bash
# Verificar processo Node
ps aux | grep "node server/index.js"

# Verificar porta TCP (8877)
netstat -tuln | grep 8877

# Verificar porta HTTP (62000)
netstat -tuln | grep 62000

# Testar API
curl http://localhost:62000/api/status

# Acessar dashboard
# http://6754056cd710.sn.mynetname.net:62000/admin-dashboard.html
```

---

## 🔧 Troubleshooting

### Servidor não inicia
```bash
# Verificar logs
tail -50 /tmp/rastreador-server.log

# Verificar se porta está em uso
lsof -i :62000
lsof -i :8877

# Liberar porta se necessário
kill -9 <PID>
```

### Servidor parou
```bash
# Reiniciar manualmente
killall node 2>/dev/null || true
sleep 2
cd /home/tomelin/rastreador && npm start
```

### PostgreSQL não responde
```bash
# Verificar status
sudo systemctl status postgresql

# Reiniciar
sudo systemctl restart postgresql

# Conectar ao banco
psql -U postgres -d rastreador_db
```

---

## 📊 Recomendação Final

Para **produção**, use **Opção 3 (Systemd)** ou **Opção 4 (PM2)**:

- ✅ Inicia automaticamente após reboot
- ✅ Reinicia se processo cair
- ✅ Logs centralizados
- ✅ Fácil controle via comandos padrão

Para **desenvolvimento**, use **Opção 2 (TMUX)**:

- ✅ Fácil de conectar/desconectar
- ✅ Ver logs em tempo real
- ✅ Rápido de matar e reiniciar

---

**Última atualização:** 2025-12-10
