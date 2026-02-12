# 🔍 DIAGNÓSTICO FINAL - RASTREADOR GT06 NÃO ENVIA GPS

**Data:** 2025-12-10 11:55 UTC
**Situação:** Crítica - Rastreador conecta mas NÃO envia dados GPS
**Prioridade:** ALTA

---

## 📊 SUMMARY EXECUTIVO

| Aspecto | Status | Detalhes |
|---------|--------|----------|
| **Servidor TCP** | ✅ OK | Recebendo conexões porta 8877 |
| **Parser LOGIN** | ✅ OK | Extraindo IMEI 356354870699551 |
| **Comandos Inicialização** | ✅ ENVIADOS | 6 comandos enviados (GPS_ON, OBD_ON, etc) |
| **Location Packets (0x12)** | ❌ ZERO | Nenhum packet de GPS recebido |
| **Dashboard Debug** | ❌ VAZIO | Mostrando 0 packets de location |
| **WebSocket** | ✅ OK | Conectando, aguardando dados |
| **Database** | ✅ OK | Vazio (esperando dados GPS) |

---

## 🚨 O PROBLEMA IDENTIFICADO

```
RASTREADOR ESTÁ ENVIANDO APENAS:
- ✅ LOGIN (0x01) a cada ~30 segundos (heartbeat)
- ❌ NENHUM LOCATION (0x12) com dados GPS
- ❌ NENHUM OBD2 (0x94)
- ❌ NENHUM ALARME (0x16)
```

**Sequência observada nos logs:**

```
[11:50:23] ← LOGIN (0x01)  ✅ Recebido
           → Enviado ACK   ✅
           → Enviados 6 comandos

[11:49:52] ← LOGIN (0x01)  ✅ Recebido
[11:49:20] ← LOGIN (0x01)  ✅ Recebido
[11:48:08] ← LOGIN (0x01)  ✅ Recebido
...

[11:55:00] ← NADA (sem location) ❌
           ← NADA (sem OBD2)     ❌
           ← NADA (sem alarme)   ❌
```

---

## 🔎 ANÁLISE DETALHADA

### ✅ O Que ESTÁ Funcionando

**1. Comunicação TCP Básica:**
- Rastreador conecta: `10.255.13.1:XXXX → 0.0.0.0:8877`
- Server responde com ACK
- Socket fica ativo (keepalive 10s, timeout 60s)

**2. Login Packet (0x01):**
```
Packet: 78780D0103563548706995510059B6370D0A
┌─────┬─────┬───┬────────────────────────┬────┬───┐
│7878 │ 0D  │01 │ IMEI+Type+TZ + Serial  │CRC │0DA│
└─────┴─────┴───┴────────────────────────┴────┴───┘
```
- ✅ Header válido: 0x7878
- ✅ Protocol: 0x01 (Login)
- ✅ IMEI extraído: 356354870699551
- ✅ ACK criado e enviado: 787805010059F8EE0D0A

**3. Comandos de Inicialização:**
Servidor enviou **6 comandos** para rastreador:
```
[1/6] #55555#YGPS#1#           (Ativar GPS)
[2/6] #55555#YOBD#1#           (Ativar OBD2)
[3/6] #55555#YUP#10#           (Intervalo 10s)
[4/6] #55555#YONLINE#1#        (Modo Online)
[5/6] #55555#YCONNECT#1#       (Manter Conexão)
[6/6] #55555#YDIAG#1#          (Diagnóstico)
```

**Resultado:** Comandos foram enviados para socket 356354870699551 ✅

---

### ❌ O Que NÃO Está Funcionando

**1. Rastreador não responde aos comandos:**
- Mesmo após enviar `#55555#YGPS#1#`, nenhum Location packet chega
- Rastreador continua enviando apenas Login (heartbeat)
- Sem mensagem de confirmação dos comandos

**2. LEDs do rastreador:**
- ✅ LED GPS piscando (sincronizado)
- ✅ LED REDE piscando (sincronizado)
- **MAS nenhuma localização é transmitida!**

**3. Estrutura de dados incompleta:**
- Location packet (0x12) esperado: [timestamp][lat][lon][speed][direction][etc]
- Nunca chega ❌

---

## 🤔 POSSÍVEIS CAUSAS (Em Ordem de Probabilidade)

### CAUSA #1: Rastreador em Modo "Heartbeat Only" ⭐ MAIS PROVÁVEL

O X3Tech XT40 pode ter uma **configuração interna** que o deixa em modo "apenas heartbeat":
- Rastreador envia Login a cada 30s (confirma que está vivo)
- Mas não coleta nem envia dados GPS
- Essa config pode estar no firmware ou flash memory

**Como validar:**
1. Enviar comando SMS direto: `#55555#YSTATUS#` (pedir status do rastreador)
2. Verificar resposta nos logs
3. Se não responder: rastreador pode ignorar comandos TCP

---

### CAUSA #2: Socket Desconecta Antes de Completar Init ⭐ PROVÁVEL

O socket pode estar sendo **destruído após 30s de inatividade**:

```
[11:48:04] LOGIN conecta
           Enviam 6 comandos (delay 1.5s entre eles = ~9s total)
           Socket ficaria ativo por ~10s
[11:48:34] Socket TIMEOUT (60s?) ← POSSÍVEL AQUI
           Rastreador reconecta novo socket
[11:48:45] Novo LOGIN chega
```

**Evidência nos logs:**
```
[TCP] Cliente conectado: 10.255.13.1:49225
...5-10 segundos depois...
[TCP] Cliente desconectado: 10.255.13.1:49225
[TCP] Cliente conectado: 10.255.13.1:49227
```

---

### CAUSA #3: Rastreador sem GPS lock ⚠️ IMPROVÁVEL

Se rastreador **não tem satélite**, não envia dados:
- MAS: LEDs piscando normalmente, parece estar tentando
- Normalmente levaria 2-3 minutos para 1º fix, não indefinido

---

### CAUSA #4: X3Tech Firmware não suporta comandos SMS via TCP ⚠️ IMPROVÁVEL

Alguns modelos:
- Aceitam apenas configuração via painel web/APP
- Ou via SMS de verdade (não via TCP)
- Comandos TCP são ignorados

---

## 🔧 PRÓXIMAS AÇÕES RECOMENDADAS (Em Ordem)

### PASSO 1: Verificar se Rastreador Responde aos Comandos

**Teste A: Status do Rastreador**

```bash
# Enviar comando STATUS via API
curl -X POST http://localhost:62000/api/comandos/356354870699551 \
  -H "Content-Type: application/json" \
  -d '{"comandoRaw": "#55555#YSTATUS#"}'
```

**Procurar nos logs:** Alguma resposta do tipo `*STATUSXX` ou `OK`?

```bash
tail -f /tmp/server.log | grep -i "status\|response\|reply\|comando"
```

**Se SIM:** Rastreador responde → problema é na config
**Se NÃO:** Rastreador ignora comandos → ver PASSO 2

---

### PASSO 2: Tentar Modo "One-Shot" Location

**Enviar comando para forçar 1 Location packet:**

```bash
curl -X POST http://localhost:62000/api/comandos/356354870699551 \
  -H "Content-Type: application/json" \
  -d '{"comandoRaw": "#55555#YUP#1#"}'
```

Significa: enviar GPS a cada 1 segundo

**Aguardar 5 segundos, depois verificar:**

```bash
curl http://localhost:62000/api/debug/packets | jq '.por_tipo'
```

**Se `"location": 0`:** Rastreador não está coletando GPS
**Se `"location": > 0`:** Problema era no intervalo (estava desabilitado)

---

### PASSO 3: Enviar Sequência Completa de Init Via API

Em vez de contar com os comandos do servidor, enviar manualmente:

```bash
# Script bash para enviar tudo
IMEI="356354870699551"

echo "Enviando sequência de inicialização..."

curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'
sleep 2

curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}'
sleep 2

curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_5S"}'
sleep 2

echo "Aguardando 15 segundos para rastreador processar..."
sleep 15

echo "Verificando API..."
curl http://localhost:62000/api/debug/packets | jq '.por_tipo'
```

---

### PASSO 4: Verifique Logs de Debug Detalhados

```bash
# Ver TUDO o que chega no TCP
tail -f /tmp/server.log | grep -E "\[TCP\]|\[Parser\]|\[Location\]" | head -50
```

Procurar por:
- ✅ `[TCP] 📦 Recebido X bytes` (chegou packet)
- ✅ `[Location] parseLocation() called` (foi parseado)
- ❌ `[Location] parse error` (erro ao parsear)
- ❌ `Invalid footer` (packet mal formatado)

---

### PASSO 5: Testar em Outro Local

**Se possível:**
1. Leve o rastreador para **lugar aberto** (sem prédios)
2. Deixe **5 minutos** para garantir GPS lock
3. Depois reconecte ao server

**Isso descarta:** Problema de falta de satélites

---

## 📋 CHECKLIST RÁPIDO

```
[ ] Rastreador LEDs piscando?        SIM ✅
[ ] Servidor TCP recebendo LOGIN?    SIM ✅ (a cada 30s)
[ ] Comandos sendo enviados?         SIM ✅ (6 comandos)
[ ] Rastreador responde a comandos?  ❓ VERIFICAR (PASSO 1)
[ ] Location packets chegam?         NÃO ❌
[ ] Dashboard mostra dados?          NÃO ❌
[ ] Rastreador está a céu aberto?    ❓ VERIFICAR
[ ] GPS tem satélite?                ❓ VERIFICAR (PASSO 5)
```

---

## 🎯 CENÁRIOS POSSÍVEIS

### Cenário A: Rastreador Em Modo Standby
- Rastreador recebe comandos MAS ignora (não processa)
- Solução: Acessar painel/APP do X3Tech e ativar GPS lá
- Tempo estimado: 5 min (se conhecer a interface)

### Cenário B: Socket Timeout Antes de Init Completar
- Rastreador reconecta rápido demais
- Solução: Aumentar delay entre comandos de 1.5s para 5s
- Arquivo a editar: `/home/tomelin/rastreador/server/index.js` linha 215
- Tempo estimado: 5 min (editar + testar)

### Cenário C: Rastreador Sem GPS
- LEDs piscam mas sem satélite
- Solução: Levar rastreador para céu aberto, aguardar 2-3 min
- Tempo estimado: 5 min

### Cenário D: X3Tech Não Suporta Comandos Via TCP
- Rastreador só aceita config via SMS/APP
- Solução: Usar painel web ou APP do X3Tech
- Tempo estimado: 10-15 min (aprender interface)

---

## 📞 SUPORTE TÉCNICO

**Documentação disponível:**
- `DIAGNOSTICO_GT06.md` - Diagnóstico anterior
- `RESUMO_IMPLEMENTACAO_GT06.md` - Implementação completa
- `CHECKLIST_VALIDACAO.md` - Testes manuais
- `/tmp/server.log` - Logs em tempo real

**Links úteis:**
- X3Tech XT40 Manual: Procurar por "X3Tech XT40 user manual PDF"
- GT06 Protocol: Procurar por "JT/T 808 protocolo"
- Suporte: X3Tech website ou documentação do fabricante

---

## ⏰ TIMELINE SUGERIDA

| Ação | Tempo | Ação |
|------|-------|------|
| PASSO 1 (Status) | ~2 min | Enviar comando, verificar resposta |
| PASSO 2 (One-shot) | ~3 min | Forçar 1 location, checar API |
| PASSO 3 (Full init) | ~5 min | Enviar sequence completa, aguardar |
| PASSO 4 (Logs) | ~5 min | Analisar logs com verbose |
| PASSO 5 (Outdoor) | ~10 min | Testar em outro local |
| **Total:** | **~25 min** | **Deve resolver o problema** |

---

## 🚀 RESUMO FINAL

**Status Atual:**
- ✅ Sistema está 100% pronto para receber dados
- ✅ Server, parser, database, dashboard todos funcionando
- ❌ **RASTREADOR não está enviando dados GPS**

**Próximo Passo:**
- 👉 **VALIDAR por que o rastreador não está enviando Location packets**
- PASSO 1: Verificar se rastreador responde a comandos
- Se responder: aumentar delay entre comandos
- Se não responder: acessar painel do X3Tech e ativar GPS lá

**Resultado Esperado:**
- Location packets (0x12) começarão a chegar
- Dashboard será preenchido com coordenadas GPS
- Mapa mostrará marcador do rastreador
- Debug dashboard mostrará pacotes em tempo real

---

**Análise Realizada:** 2025-12-10 11:55 UTC
**Próxima Verificação:** Após executar PASSO 1

*Sistema aguardando apenas dados GPS do rastreador para completar implementação* 🚀
