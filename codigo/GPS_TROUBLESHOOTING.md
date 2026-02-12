# 🛰️ Guia Completo - Ativar GPS e OBD2 no XT40

## Problema Identificado

Você está recebendo **heartbeat** (dados de conexão) mas **NÃO** está recebendo dados de **localização GPS**. Isso acontece porque:

1. **GPS pode não estar ativado** no rastreador
2. **Rastreador pode não ter sinal GPS** (sem satélites)
3. **Intervalo de upload pode estar muito longo** (padrão pode ser 60s ou mais)

---

## Passo 1: Verificar o Status da Conexão

### A. Via API (Mais fácil)

```bash
# Ver dispositivos conectados
curl http://localhost:8000/api/conexoes

# Resposta esperada:
# {
#   "sucesso": true,
#   "total": 1,
#   "dispositivos": [
#     {
#       "imei": "358758081234567",
#       "conectado": true,
#       "remoteAddress": "192.168.x.x",
#       "remotePort": xxxxx
#     }
#   ]
# }
```

**Se não houver dispositivos na lista**: O XT40 não está se conectando. Verifique:
- IP/Porta corretos no XT40
- Firewall bloqueando porta 8877
- Cabagem/conexão do dispositivo

---

## Passo 2: Ativar GPS (Essencial!)

### A. Via API (Recomendado - Fácil)

```bash
# Copiar o IMEI da resposta anterior

IMEI="358758081234567"

# Ativar GPS
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'

# Resposta esperada:
# {
#   "sucesso": true,
#   "mensagem": "Comando enviado com sucesso",
#   "imei": "358758081234567",
#   "comando": "#55555#YGPS#1#",
#   "timestamp": "2025-12-10T14:30:45.000Z"
# }
```

**O que você deveria ver no servidor** (logs):
```
📤 [API CMD] Enviado para 358758081234567: #55555#YGPS#1#
```

### B. Via Script Interativo (Alternativa)

```bash
# Usar o script de diagnóstico criado
chmod +x /home/tomelin/rastreador/diagnostico-gps.js
node /home/tomelin/rastreador/diagnostico-gps.js

# No menu, escolha: 1 (GPS_ON)
# Você verá se houver resposta do rastreador
```

---

## Passo 3: Ativar OBD2

```bash
# Ativar dados OBD2
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}'
```

---

## Passo 4: **CRUCIAL** - Definir Intervalo de Upload para 10 SEGUNDOS

Este é o **PASSO MAIS IMPORTANTE**! O intervalo padrão pode estar muito longo.

```bash
# Definir para 10 segundos (verá dados rápido para teste)
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_10S"}'
```

**Importante**:
- Intervalo padrão: 60s (demora muito para ver dados)
- Intervalo recomendado: 30s (bom balanço)
- Intervalo teste: 10s (para debug)

---

## Passo 5: Enviar Comandos de Inicialização Completos

Se quiser reenviar todos os comandos de uma vez:

```bash
curl -X POST http://localhost:8000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"

# Envia: GPS_ON + OBD_ON + UPLOAD_10S + ONLINE_ON + CONNECT_ON + DIAG_ON
```

---

## Passo 6: Monitorar os Dados Chegando

### A. Ver Heartbeats (Deve estar chegando)

```bash
curl http://localhost:8000/api/heartbeats/$IMEI

# Resposta:
# {
#   "sucesso": true,
#   "dados": {
#     "imei": "358758081234567",
#     "timestamp": "2025-12-10T14:35:10.000Z",
#     "count": 45,
#     "status": "connected"
#   }
# }
```

### B. Ver Localizações GPS (Após ativar GPS)

```bash
curl http://localhost:8000/api/localizacoes

# Deverá mostrar a localização mais recente com:
# - latitude
# - longitude
# - velocidade
# - direção
# - timestamp
```

---

## Passo 7: Ver Logs em Tempo Real

Abra outro terminal e execute seu servidor com logs detalhados:

```bash
# Se o servidor está rodando em background:
ps aux | grep node

# Reinicie com logs detalhados:
npm start

# Você verá mensagens como:
# [TCP] IMEI extracted: 358758081234567
# 📤 [Config] Enviando comandos de inicialização...
# [Location] Saved for 358758081234567
# ✅ [Login] Device 358758081234567 connected and marked online
```

---

## Roteiro Completo de Teste

Execute nesta ordem:

```bash
# 1. Verificar conexão
curl http://localhost:8000/api/conexoes

# 2. Copiar IMEI de uma conexão ativa
IMEI="<COPIE_AQUI>"

# 3. Ativar GPS
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'

# 4. Ativar OBD2
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}'

# 5. Intervalo de 10 segundos (IMPORTANTE!)
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_10S"}'

# 6. Aguardar 15-20 segundos (tempo para rastreador enviar dados)

# 7. Verificar se localizações chegaram
curl http://localhost:8000/api/localizacoes | jq '.'

# 8. Ou verificar via heartbeat
curl http://localhost:8000/api/heartbeats/$IMEI | jq '.'
```

---

## Troubleshooting - Se Ainda Não Funcionar

### ❌ Nenhuma localização após 30 segundos

**Causa 1: GPS não tem sinal**
- XT40 precisa de **visão clara do céu**
- Dentro de carro: 5-10 minutos para primeiro fix
- Lugar interno/coberto: pode não funcionar

**Solução**:
- Coloque o rastreador perto de janela
- Aguarde 30 segundos mínimo
- Verifique se há satélites nas logs

**Causa 2: Rastreador não está recebendo comando**

Teste com comando DIAG para ver se rastreador responde:

```bash
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "DIAG_ON"}'

# Ver STATUS
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "STATUS"}'
```

### ❌ Erro: "Dispositivo não está conectado"

- Verifique com: `curl http://localhost:8000/api/conexoes`
- IMEI pode estar errado
- Dispositivo pode ter desconectado

---

## Protocolo de Dados - O Que Está Acontecendo

### Fluxo Normal

```
XT40 conecta em 0.0.0.0:8877
    ↓
Envia packet 0x01 (Login) com IMEI
    ↓
Servidor reconhece e armazena socket
    ↓
Servidor envia 6 comandos (GPS_ON, OBD_ON, etc)
    ↓
XT40 processa comandos
    ↓
XT40 começa enviar dados:
  - Packet 0x12 (Location/GPS) a cada intervalo
  - Packet 0x94 (OBD2) a cada intervalo
  - Packet 0x01 (Heartbeat) sempre
    ↓
Servidor recebe, valida, e salva no banco
    ↓
Frontend/API mostra dados em tempo real
```

---

## Comandos Disponíveis

| Comando | Código SMS | Efeito |
|---------|-----------|--------|
| GPS_ON | `#55555#YGPS#1#` | Ativa GPS |
| GPS_OFF | `#55555#YGPS#0#` | Desativa GPS |
| OBD_ON | `#55555#YOBD#1#` | Ativa OBD2 |
| OBD_OFF | `#55555#YOBD#0#` | Desativa OBD2 |
| UPLOAD_10S | `#55555#YUP#10#` | 10 segundos |
| UPLOAD_30S | `#55555#YUP#30#` | 30 segundos |
| UPLOAD_60S | `#55555#YUP#60#` | 60 segundos |
| STATUS | `#55555#YSTATUS#` | Ver status |
| VERSION | `#55555#YVERSION#` | Ver versão |
| NETWORK | `#55555#YNETWORK#` | Info de rede |
| DIAG_ON | `#55555#YDIAG#1#` | Ativar diagnóstico |

---

## Verificação Técnica - Packets Esperados

### Login Packet (0x01) - Você está recebendo
```
[7878] [Length=0x0D] [01] [IMEI=358758081234567] [Type] [Timezone] [CRC] [0D0A]
✅ Isto está chegando = Heartbeat visível
```

### Location Packet (0x12) - Você NÃO está recebendo
```
[7878] [Length] [12] [DateTime=6 bytes] [Latitude=4 bytes] [Longitude=4 bytes] [Speed] [Direction] [Sats] [CRC] [0D0A]
❌ Isto NÃO está chegando = GPS não ativado ou sem sinal
```

### OBD2 Packet (0x94) - Provavelmente não
```
[7878] [Length] [94] [RPM=2b] [Speed=1b] [Temp=1b] [Fuel=1b] [Odometer=4b] [...] [CRC] [0D0A]
❌ Isto NÃO está chegando = OBD2 não ativado
```

---

## Próximos Passos Após Ativar

1. ✅ Confirmou que dados chegam → **Mudar para UPLOAD_30S** (intervalo recomendado)
2. ✅ Vendo dados no dashboard → **Configurar alertas/regras**
3. ✅ Tudo funcionando → **Considerar modo offline** para economia

---

## Dúvidas?

- Verifique os logs: `npm start` em terminal separado
- Teste com `curl` ou Postman: `/api/conexoes`, `/api/comandos`, `/api/localizacoes`
- Se rastreador não responde: Pode estar com bateria baixa ou sem sinal GPRS

---

**Última atualização**: 2025-12-10
**Equipamento**: XT40 OBD2 Tracker
**Protocolo**: GT06 com extensões X3Tech
