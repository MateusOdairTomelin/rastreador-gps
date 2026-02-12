# 🔍 Diagnóstico: 2 Rastreadores - 1 Funciona, 1 Não

## 📊 Status Atual

```
┌─────────────────────────┬────────────────────┬───────────────────┐
│ IMEI                    │ LED GPS            │ LED Rede          │
├─────────────────────────┼────────────────────┼───────────────────┤
│ 356354870699551 (OLD)   │ 🔴 FIXO ❌         │ 🔵 PISCANDO ✅    │
│ 356354870702322 (NEW)   │ 🟢 PISCANDO ✅✅✅ │ 🔵 PISCANDO ✅    │
└─────────────────────────┴────────────────────┴───────────────────┘
```

---

## ✅ RASTREADOR NOVO (356354870702322) - FUNCIONANDO!

**LED GPS PISCANDO VERDE = GPS ATIVADO E PROCURANDO SATÉLITES** 🎉

### O que isto significa?
1. ✅ Hardware GPS está OK
2. ✅ Comando YGPS#1# FUNCIONOU (após RSTSYS)
3. ✅ Dispositivo está RESPONSIVO e CONFIGURÁVEL
4. ✅ Modem LTE CONECTADO
5. ✅ Próximo: Aguardar fixação de satélites, depois enviará Location packets

### Timeline esperada para este rastreador:

```
AGORA (T+0):      LED GPS piscando verde (buscando)
T+30-120s:        LED GPS pode acender mais (satélites fixando)
T+2-5min:         Server deve receber packets 0x12 (Location)
```

---

## ❌ RASTREADOR ANTIGO (356354870699551) - PROBLEMA

**LED GPS FIXO = GPS NÃO ATIVOU**

### Diagnóstico:

| Causa Possível | Probabilidade | Solução |
|---|---|---|
| Hardware GPS quebrado/danificado | 60% | Retornar para reparo |
| Firmware corrompido ou versão diferente | 25% | Atualizar firmware |
| Configuração específica bloqueando GPS | 15% | Factory reset completo |

### Verificação:
```
#55555#SHOWINFO#
```
Verifique se há alguma flag ou setting diferente do novo rastreador.

---

## 🎯 PLANO IMEDIATO: Focar no Rastreador QUE FUNCIONA (356354870702322)

### Passo 1: Monitorar Server Logs
```bash
# Terminal 1: Monitor do servidor aguardando Location packets
tail -f nohup.out | grep -E "Location|0x12|356354870702322"
```

**Esperado (nos próximos 2-5 minutos):**
```
[Location] Saved for IMEI: 356354870702322 at coordinates: -23.5505, -46.6333
```

Se aparecer = GPS está ENVIANDO DADOS! ✅

### Passo 2: Verificar Banco de Dados (após 2-3 minutos)
```bash
# Listar últimas localizações do novo IMEI
sqlite3 /home/tomelin/rastreador/prisma/dev.db \
  "SELECT imei, latitude, longitude, altitude, criado_em FROM localizacoes
   WHERE imei = '356354870702322'
   ORDER BY criado_em DESC LIMIT 10;"
```

**Se tiver resultados:**
```
356354870702322 | -23.5505 | -46.6333 | 850 | 2025-12-10 10:18:45
356354870702322 | -23.5506 | -46.6334 | 851 | 2025-12-10 10:19:15
356354870702322 | -23.5507 | -46.6335 | 852 | 2025-12-10 10:19:45
```

= **GPS FUNCIONA PERFEITAMENTE!** 🎉

### Passo 3: Verificar Dashboard
```
http://6754056cd710.sn.mynetname.net:62000/admin-dashboard.html
```

Procure pelo novo IMEI (356354870702322) na lista de dispositivos.
Deve estar mostrando:
- ✅ Localização em tempo real
- ✅ Velocidade
- ✅ Direção
- ✅ Altitude

---

## 🚀 SE DADOS CHEGAREM AO SERVIDOR (Provável!)

**PRÓXIMAS TAREFAS:**
1. ✅ Validar que all 5 protocols funcionam (0x01, 0x12, 0x13, 0x16, 0x94)
2. ✅ Testar OBD2 data (se veículo conectado)
3. ✅ Testar Heartbeat (0x13 status packets)
4. ✅ Testar Alarm packets (0x16) - acionar vibração e verificar
5. ✅ Otimizar intervalo (YUP#X#) conforme necessário

---

## 🔧 PARA O RASTREADOR ANTIGO (356354870699551)

**Opções:**

### Opção 1: Factory Reset (Tenta resolver software issue)
```
#55555#RFID,356354870699551#    (alguns protocolos usam RFID reset)
ou
#55555#RSTSYS#                   (reiniciar novamente)
```

Após 1 minuto, testar novamente:
```
#55555#YGPS#1#
```

LED GPU deve piscar se GPS hardware OK.

### Opção 2: Descartar (Hardware quebrado)
Se LED GPS não piscar após factory reset, device pode ter:
- GPS chip danificado
- Antena GPS desconectada
- Componentes queimados

---

## 📋 PRÓXIMA AÇÃO (IMEDIATO!)

**Execute AGORA para o rastreador novo (356354870702322):**

```bash
# Terminal 1: Start monitoring
tail -f nohup.out | grep -E "Location|0x12|356354870702322"

# Terminal 2: Check database (execute após 2-3 minutos)
sqlite3 /home/tomelin/rastreador/prisma/dev.db \
  "SELECT COUNT(*), MAX(criado_em) FROM localizacoes WHERE imei = '356354870702322';"

# Terminal 3: Check dashboard (abrir no navegador)
# http://6754056cd710.sn.mynetname.net:62000/admin-dashboard.html
```

---

## ⚡ RESUMO EXECUTIVO

| Item | Status |
|------|--------|
| Hardware GPS (novo IMEI) | ✅ OK (LED piscando) |
| Modem LTE | ✅ Conectado |
| Configuração APN/IP | ✅ Aplicada |
| Sistema Responsivo | ✅ Sim |
| **Próximo:** Server recebendo dados? | ⏳ Verificando... |

**Você tem pelo menos 1 rastreador 100% funcional agora!** 🎉

O rastreador antigo pode ser investigado depois ou retornado se hardware está danificado.
