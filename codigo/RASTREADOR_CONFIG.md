# 🔧 Configuração Completa do Rastreador XT40 OBD2

## 📋 Objetivo

Se seu rastreador está em **modo heartbeat only** (enviando apenas LOGIN `0x01`), este guia mostra como configurá-lo para enviar **TODOS OS DADOS**: localização GPS, dados OBD2, e status.

---

## ⚠️ Verificar Modo Atual

Você está em **heartbeat only** se:
- ✅ Recebe pacotes LOGIN (18 bytes, protocolo `0x01`)
- ❌ Não recebe LOCATION (protocolo `0x12`)
- ❌ Não recebe OBD2 (protocolo `0x94`)

---

## 🎯 Sequência de Configuração via SMS

**Envie estes comandos para o rastreador, um por um, com 10 segundos entre cada:**

### Passo 1: Ativar GPS

```
#55555#YGPS#1#
```

**Resposta esperada:** `GPS OK!` ou `YGPS OK!`

### Passo 2: Solicitar Diagnóstico

```
#55555#YDIAG#1#
```

**Resposta esperada:** `YDIAG OK!`

### Passo 3: Configurar Intervalo de Atualização (60 segundos)

```
#55555#YUP#60#
```

**Resposta esperada:** `YUP OK!`

### Passo 4: Ativar OBD2 (se disponível)

```
#55555#YOBD#1#
```

**Resposta esperada:** `YOBD OK!` ou similar

### Passo 5: Solicitar Transmissão Imediata

```
#55555#YDISP#1#
```

**Resposta esperada:** `YDISP OK!`

---

## 📊 O que Esperar Depois

### Nos Próximos 2-3 Minutos:

✅ **LED GPS** deve mudar de piscando para **fixo**
- Significa: Adquiriu satélites, tem posição
- Se continuar piscando: Sem satélites (antena/módulo com problema)

✅ **LED Rede** pode continuar **piscando**
- Isso é **NORMAL** (heartbeat pattern)
- Não indica problema

✅ **Dados Chegando no Servidor:**

```
[TCP] Dados recebidos (28 bytes): 78780d12... LOCATION
[TCP] Dados recebidos (20 bytes): 78780d94... OBD2
[TCP] Dados recebidos (18 bytes): 78780d01... LOGIN
```

---

## 🔍 Monitorar Configuração

### No Dashboard (Recomendado):

Acesse:
```
http://seu-ip:62000/diagnostico.html
```

E veja:
- ✅ Localização em tempo real
- ✅ Dados OBD2 (RPM, velocidade, temperatura)
- ✅ Status da bateria

### No Log do Servidor:

```bash
tail -f /tmp/server.log | grep -E "LOCATION|OBD2|Dados recebidos"
```

### Com o Analyzer Dedicado:

```bash
# Terminal 1
node advanced-packet-analyzer.js

# Terminal 2
tail -f /tmp/packet-analysis.log | grep -E "0x12|0x94"
```

---

## ❌ Se Não Funcionar

### Cenário 1: LED GPS Continua Piscando

**Problema:** Sem satélites

**Soluções:**
1. Aguarde 5-10 minutos ao ar livre (sem obstáculos)
2. Verifique se antena está conectada
3. Se continuador: Antena defeituosa ou módulo GPS com problema
4. Contate X3Tech para RMA

### Cenário 2: Recebe LOCATION Mas Não OBD2

**Problema:** GPS funciona, OBD2 não está conectado

**Soluções:**
1. Verifique cabos OBD2 na porta do carro
2. Alguns carros têm proteção OBD2 (encriptado)
3. Se houver `0x94` no log = está funcionando
4. Se não houver = carro não suporta leitura OBD2 standard

### Cenário 3: Nada Muda Após Comandos

**Problema:** Rastreador não reconheceu comandos

**Soluções:**
1. Verifique número do SIM card no rastreador
2. Tente com outro número (x3tech pode validar)
3. Aguarde 30 segundos entre comandos
4. Resend cada comando 2x
5. Contate X3Tech com os logs do rastreador

### Cenário 4: Recebe Dados Mas Aparecem N/A no Dashboard

**Problema:** Dados chegando mas com valores inválidos

**Soluções:**
1. **Tipo de localização:** Verifique se sistema aceita GPS A-GPS
2. **OBD2 encriptado:** Alguns carros nova precisam decodificação
3. **Timezone:** Dados podem estar com timezone errado
4. Vá em `http://seu-ip:62000/diagnostico.html` e veja valores brutos

---

## 📱 Alternativa: Protocolo X3Tech

Se comandos SMS não funcionarem:

1. Acesse plataforma X3Tech oficial
2. Configure rastreador lá
3. Se funciona lá mas não na sua aplicação:
   - Problema é na sua rede/servidor
   - Contate suporte técnico local

4. Se não funciona lá também:
   - Problema é no rastreador
   - Solicite RMA a X3Tech

---

## 🎯 Resumo Rápido

| Passo | Comando | Esperado |
|---|---|---|
| 1 | `#55555#YGPS#1#` | GPS ativado |
| 2 | `#55555#YDIAG#1#` | Diagnóstico solicitado |
| 3 | `#55555#YUP#60#` | Intervalo = 60 segundos |
| 4 | `#55555#YOBD#1#` | OBD2 ativado |
| 5 | `#55555#YDISP#1#` | Transmissão agora |

**Resultado esperado após 2 minutos:**
- LED GPS: Fixo
- LED Rede: Pode piscar (normal)
- Dashboard: Mostra localização e dados OBD2

---

## 🔗 Arquivo de Log

Todos os dados recebidos ficam em:
```
/tmp/server.log
```

Procure por:
```bash
# Verificar localização
grep "LOCATION\|0x12" /tmp/server.log

# Verificar OBD2
grep "OBD2\|0x94" /tmp/server.log

# Verificar heartbeat
grep "Heartbeat\|0x01" /tmp/server.log
```

---

## 📞 Próximos Passos

1. **Envie os 5 comandos** para o rastreador
2. **Aguarde 2 minutos** para que registre e conecte
3. **Acesse o dashboard** em `http://seu-ip:62000/diagnostico.html`
4. **Compartilhe screenshot** se problema persistir

---

**Quando tiver sucesso, seus dados apareçerão no mapa: `http://seu-ip:62000/mapa.html`**

