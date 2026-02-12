# Guia de Ativação de Funcionalidades - Rastreador XT40

## Comandos SMS para Enviar aos Rastreadores

### 📱 Dispositivo 1: 356354870699551
```
SETLOCX22#
PARAM#
STATUS#
```

### 📱 Dispositivo 2: 356354870702322
```
SETLOCX22#
PARAM#
STATUS#
```

### 📱 Dispositivo 3: 356354870658615
```
SETLOCX22#
PARAM#
STATUS#
```

## O que cada comando faz:

### `SETLOCX22#`
**OBRIGATÓRIO** - Ativa o protocolo 0x22 que envia:
- ✅ Tensão bateria interna (3.0V-4.2V)
- ✅ Tensão alimentação principal (12V/24V)
- ✅ Odômetro do rastreador (km acumulados)
- ✅ Horímetro (horas de ignição ligada)
- ✅ Status de ignição (ACC bit)

**Resposta esperada:** `Angle compensation:ON!` ou `SET LOCX22,OK!`

---

### `PARAM#`
Verifica configuração atual do rastreador.

**Resposta esperada:**
```
APN:allcom.br,allcom,allcom
IP:RASTREADORES.VITALLIN.COM.BR:5003
IMEI:356354871544368
TIMER: 30
LANG: EN
GMT: W3
HBT: 1.5
PROTOCOL:SETL
```

**O que validar:**
- `PROTOCOL:SETL` = Protocolo 0x22 está ATIVO ✅
- `PROTOCOL:` vazio ou outro = Protocolo 0x22 NÃO está ativo ❌
- `TIMER: 30` = Envia dados a cada 30 segundos

---

### `STATUS#`
Verifica status atual do rastreador.

**Resposta esperada:**
```
BATTERY:100%
GSM Signal:HIGH
GPS:FIXED
GPS SIGNAL:HIGH
RELAYER:DISABLE
ACC:ON,151m
ACCVIRT:OFF
CHARGER:NORMAL
VOLTAGE:13.176,4.222
```

**O que validar:**
- `BATTERY:` = Percentual de bateria interna
- `ACC:ON` = Ignição ligada
- `GPS:FIXED` = GPS com sinal
- `VOLTAGE:13.176,4.222` = Tensão principal (13.2V) e bateria (4.2V)

---

## 🔧 Dados OBD2 (RPM, Temperatura, Combustível)

### ⚠️ IMPORTANTE:
**NÃO há comando para ativar OBD2** - É automático!

### Pré-requisitos para receber dados OBD2:
1. ✅ Rastreador modelo **XT40-OBDII** (não XT40-4F ou outros)
2. ✅ Cabo OBD2 **conectado à porta do veículo**
3. ✅ **Ignição do veículo LIGADA**
4. ✅ Veículo **compatível com protocolo OBD2**

### Se não está recebendo dados OBD2:
- Verificar se o rastreador é modelo OBDII
- Verificar conexão física do cabo OBD2
- Ligar a ignição do veículo
- Aguardar 30-60 segundos

---

## 📊 Dados Coletados por Protocolo

| Dado | Protocolo 0x22 | Protocolo 0x94 (OBD2) |
|------|----------------|----------------------|
| **Tensão Bateria Interna** | ✅ SIM | ❌ NÃO |
| **Tensão Principal** | ✅ SIM | ❌ NÃO |
| **Odômetro Rastreador** | ✅ SIM | ❌ NÃO |
| **Horímetro** | ✅ SIM | ❌ NÃO |
| **Ignição (ACC)** | ✅ SIM | ✅ SIM |
| **RPM** | ❌ NÃO | ✅ SIM |
| **Temperatura Motor** | ❌ NÃO | ✅ SIM |
| **Nível Combustível** | ❌ NÃO | ✅ SIM |
| **Odômetro Veículo** | ❌ NÃO | ✅ SIM |

---

## 🚀 Como Enviar os Comandos

### Opção 1: Via SMS (Recomendado)
Envie SMS para o número do chip do rastreador:
```
SETLOCX22#
```

### Opção 2: Via Aplicativo do Fabricante
Use o aplicativo da X3Tech se disponível.

### Opção 3: Via Servidor (Protocolo 0x80)
Envie comando pelo servidor TCP (já implementado no código).

---

## ✅ Checklist de Ativação

- [ ] Enviar `SETLOCX22#` para todos os 3 rastreadores
- [ ] Aguardar 30 segundos
- [ ] Enviar `PARAM#` para verificar `PROTOCOL:SETL`
- [ ] Enviar `STATUS#` para ver tensões atuais
- [ ] Verificar se rastreadores têm modelo OBDII
- [ ] Verificar conexão física OBD2 nos veículos
- [ ] Ligar ignição dos veículos
- [ ] Aguardar 1-2 minutos para receber dados
- [ ] Testar frontend em http://localhost:62000

---

## 📞 Números dos Chips (adicionar aqui)

- **Dispositivo 356354870699551:** _________________
- **Dispositivo 356354870702322:** _________________
- **Dispositivo 356354870658615:** _________________

