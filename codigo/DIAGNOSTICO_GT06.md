# 🔍 DIAGNÓSTICO COMPLETO - PROTOCOLO GT06

**Data:** 2025-12-10 11:50 UTC
**Rastreador:** X3Tech XT40 (IMEI: 356354870699551)
**Status:** ⚠️ PROBLEMA IDENTIFICADO

---

## 📊 ACHADOS

### ✅ O Que Está Funcionando

1. **Servidor TCP** - Recebendo conexões na porta 8877
2. **Parser LOGIN** - Extraindo IMEI corretamente
3. **ACK Response** - Enviando reconhecimento para rastreador
4. **WebSocket** - Servidor aceita conexões
5. **API Debug** - Endpoints respondendo corretamente
6. **Heartbeat** - Registrando conexões

### ❌ O Que NÃO Está Funcionando

**NENHUM packet de LOCATION (0x12) está sendo recebido!**

Evidence:
```json
{
  "total": 8,
  "login": 8,        ✅ (Chegando)
  "location": 0,     ❌ (NÃO chegando)
  "obd2": 0,         ❌ (NÃO chegando)
  "alarm": 0,        ❌ (NÃO chegando)
  "status": 0        ❌ (NÃO chegando)
}
```

---

## 🚨 PROBLEMA IDENTIFICADO

**O rastreador X3Tech está apenas enviando LOGIN packets (0x01) periodicamente.**

O padrão é:
```
[11:50:23] ← LOGIN (0x01) de 8 pacotes
[11:49:52] ← LOGIN (0x01)
[11:49:20] ← LOGIN (0x01)
[11:48:08] ← LOGIN (0x01)
[11:48:04] ← LOGIN (0x01)
[11:47:34] ← LOGIN (0x01)
[11:47:02] ← LOGIN (0x01)
[11:46:31] ← LOGIN (0x01)
```

**Cada ~30 segundos = apenas LOGIN (heartbeat)**

**NÃO está enviando GPS (0x12)!**

---

## 🔧 POSSÍVEIS CAUSAS

### Causa #1: Rastreador não foi configurado (MAIS PROVÁVEL)
O rastreador precisa receber **comandos SMS** ou ser configurado manualmente para:
- ✅ Ativar GPS: `#55555#YGPS#1#`
- ✅ Ativar OBD2: `#55555#YOBD#1#`
- ✅ Definir intervalo: `#55555#YUP#10#` (10 segundos)

**Status Atual:** Apenas fazendo heartbeat (LOGIN), sem coletar dados

### Causa #2: Rastreador sem sinal GPS
- Pode estar em local sem satélites
- Precisa ficar a céu aberto por ~2-3 minutos para ativar

### Causa #3: OBD2 não conectado
- Se rastreador está conectado em carro, precisa de conexão OBD2

### Causa #4: Rastreador em modo "only heartbeat"
- Configuração padrão pode enviar apenas login

---

## ✅ SOLUÇÃO RECOMENDADA

### Passo 1: Verificar Logs do Rastreador

O servidor está tentando enviar comandos automaticamente. Verifique nos logs:

```bash
tail -50 /tmp/server.log | grep -i "init\|command\|config\|gps"
```

Procure por:
```
[Init] Agendando comandos de inicialização
[CMD] Enviado para 356354870699551: #55555#YGPS#1#
```

### Passo 2: Se os comandos não forem enviados

A API tem endpoint para enviar comandos manualmente:

```bash
# Ativar GPS
curl -X POST http://localhost:62000/api/comandos/356354870699551 \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'

# Ativar OBD2
curl -X POST http://localhost:62000/api/comandos/356354870699551 \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}'

# Definir intervalo 10 segundos
curl -X POST http://localhost:62000/api/comandos/356354870699551 \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_10S"}'

# Enviar toda a sequência de inicialização
curl -X POST http://localhost:62000/api/comandos/356354870699551/init
```

### Passo 3: Se via SMS/Configuração do Rastreador

Envie para o rastreador via SMS ou painel:

```
#55555#YGPS#1#           (Ativar GPS)
#55555#YOBD#1#           (Ativar OBD2)
#55555#YUP#10#           (Intervalo 10s)
#55555#YONLINE#1#        (Modo online)
#55555#YCONNECT#1#       (Manter conexão)
#55555#YDIAG#1#          (Diagnóstico ativo)
```

### Passo 4: Aguardar 10-15 segundos

Após enviar comandos, o rastreador pode precisar de:
- ⏳ 5-10 segundos para processar
- ⏳ 2-3 minutos para adquirir GPS (se estiver sem sinal)

### Passo 5: Verificar se começou a enviar Location

Monitor em tempo real:

```bash
# Terminal 1: Ver logs
tail -f /tmp/server.log | grep -E "Location|0x12|[0-9]+\.[0-9]+ [0-9]+-[0-9]+"

# Terminal 2: Verificar API
watch -n 1 'curl -s http://localhost:62000/api/debug/packets | jq .estatisticas'

# Browser: Dashboard de debug
http://6754056cd710.sn.mynetname.net:62000/debug-packets.html
```

---

## 📋 CHECKLIST DE DEBUG

- [ ] Rastreador está **a céu aberto** (para GPS)?
- [ ] Rastreador tem **sinal de rede/3G** (LED de rede piscando)?
- [ ] Rastreador tem **GPS ativado** (LED de GPS piscando)?
- [ ] **Comandos foram enviados** via API ou SMS?
- [ ] **Aguardou 10-15 segundos** após comandos?
- [ ] **Verifique logs** para erros de inicialização?
- [ ] **Dashboard de debug** mostra packets de Location?
- [ ] **API /debug/packets** mostra location > 0?

---

## 🔎 ANALISANDO OS DADOS DO RASTREADOR

Os packets LOGIN que estão chegando mostram:

```hex
78780d0103563548706995510059b6370d0a
│  │ │ │ │   │
│  │ │ │ └─── IMEI: 03563548706995510 (BCD)
│  │ │ └───── Protocol: 0x01 (LOGIN)
│  │ └─────── Length: 13 (0x0d)
│  └───────── Start: 0x7878 ✅
└──────────── Header: 0x78
```

**Confirmado:** IMEI **356354870699551** está conectando.

Agora precisa enviar **GPS data (0x12)**.

---

## 🎯 PRÓXIMAS AÇÕES

### Se Problema Persiste Depois de Ativar GPS

1. **Verificar timeout do rastreador**
   ```bash
   # O rastreador pode estar desconectando após 60s
   # Verificar logs se houver: "socket.on('timeout')"
   tail -f /tmp/server.log | grep -i "timeout\|end\|close"
   ```

2. **Verificar configuração de intervalo**
   ```bash
   # Se rastreador está com intervalo muito longo
   # Tentar: #55555#YUP#5# (5 segundos em vez de 10)
   ```

3. **Verificar se rastreador suporta GPS**
   ```bash
   # Alguns XT40 podem ter GPS desabilitado
   # Enviar: #55555#YSTATUS# para ver versão/status
   ```

4. **Verificar sem socket TCP**
   ```bash
   # Se socket está sendo destruído:
   tail -f /tmp/server.log | grep -i "socket\|destroyed\|close"
   ```

---

## 📊 ESTADO ATUAL DO SISTEMA

| Componente | Status | Ação Necessária |
|-----------|--------|-----------------|
| Servidor TCP | ✅ OK | Nenhuma |
| Parser LOGIN | ✅ OK | Nenhuma |
| Parser LOCATION | ⚠️ Não recebe | **ATIVAR GPS** |
| WebSocket | ✅ OK | Nenhuma |
| API REST | ✅ OK | Nenhuma |
| PostgreSQL | ✅ OK | Nenhuma |
| Dashboard | ✅ OK | Aguardar dados |
| Rastreador | ⏸️ Standby | **Enviar comandos** |

---

## 🚀 RESUMO EM POUCAS PALAVRAS

**O que está acontecendo:**
1. ✅ Rastreador conecta e envia heartbeat (LOGIN)
2. ❌ **Não está enviando GPS data** - servidor está pronto mas rastreador não configurado
3. 📡 LEDs piscando sincronizados = rastreador funcionando
4. 🗺️ Mapa vazio = nenhuma localização recebida

**O que fazer:**
1. **Enviar comandos de ativação** via API ou SMS
2. Aguardar **10-15 segundos**
3. Verificar logs para erros
4. Confirmar em `/debug-packets.html`

**Resultado esperado:**
- Location packets (0x12) começarão a chegar
- Dashboard mostrará coordenadas GPS
- Mapa será preenchido com marcador

---

**Status Atual:** Sistema OK, aguardando dados GPS ⏳

**Próximo Passo:** ATIVAR GPS no rastreador

**Última atualização:** 2025-12-10 11:50 UTC
