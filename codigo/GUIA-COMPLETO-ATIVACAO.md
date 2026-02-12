# 📋 GUIA COMPLETO DE ATIVAÇÃO - RASTREADORES XT40

## 🎯 STATUS ATUAL DO SISTEMA

### ✅ **O QUE ESTÁ FUNCIONANDO:**

1. **Protocolo 0x94 (OBD2 do veículo)** - 2 de 3 rastreadores
   - RPM ✅
   - Temperatura do motor ✅
   - Nível de combustível ✅
   - Ignição (ACC) ✅

2. **Protocolo 0x22 (Dados do rastreador)** - 1 de 3 rastreadores
   - Tensão da bateria ✅
   - Percentual da bateria ✅
   - Horímetro ✅
   - Odômetro ✅

3. **Sistema de detecção de ignição** - COMPLETO
   - Estado: off/acc_on/idle/moving ✅
   - Detecção de motor ocioso ✅
   - Validação de dados em cache ✅
   - Timeout automático (10 minutos) ✅

4. **Alarmes** - FUNCIONANDO
   - Recepção de alarmes ✅
   - Salvamento no banco ✅
   - API funcionando ✅
   - Frontend: precisa recarregar página (CTRL+SHIFT+R)

---

## 🔧 COMANDOS DE ATIVAÇÃO NECESSÁRIOS

### **Para TODOS os rastreadores:**

#### 1. **Ativar Protocolo 0x22 (Location Data Frame completo)**
```
Comando: SETLOCX22#
Resposta esperada: SET LOCX22,OK!
```

**O que ativa:**
- Bateria (tensão e %)
- Horímetro
- Odômetro do rastreador
- Dados GPS completos

#### 2. **Verificar configuração atual**
```
Comando: PARAM#
Resposta mostra: PROTOCOL, TIMER, IP, PORT, APN
```

**Verificar se contém:** `PROTOCOL:SETL`

#### 3. **Verificar status em tempo real**
```
Comando: STATUS#
Resposta mostra: BATTERY%, GPS, ACC, VOLTAGE
```

---

## 📊 DADOS DISPONÍVEIS POR PROTOCOLO

### **Protocolo 0x94 (OBD2 - Requer cabo OBD2 conectado)**
| Campo | Descrição | Unidade |
|-------|-----------|---------|
| RPM | Rotação do motor | RPM |
| Temperatura | Temperatura do motor | °C |
| Combustível | Nível de combustível | % |
| Ignição | Status ACC do veículo | bool |
| Odômetro veículo | Hodômetro do veículo | km |

**Nota:** Dados vêm automaticamente se:
- Rastreador modelo XT40-OBDII
- Cabo OBD2 conectado
- Veículo suporta OBD2 (padrão 1996+)

### **Protocolo 0x22 (Location - Requer comando SETLOCX22#)**
| Campo | Descrição | Unidade |
|-------|-----------|---------|
| Bateria V | Tensão bateria backup | V |
| Bateria % | Percentual bateria | % |
| Horímetro | Horas com motor ligado | horas |
| Odômetro | Distância rastreador | km |
| GPS | Latitude/Longitude | graus |
| Velocidade | Velocidade atual | km/h |
| ACC | Ignição do rastreador | bool |

---

## 🚀 COMO ATIVAR VIA API

### **Via TCP (Recomendado - Automático)**

```bash
# Ativar dispositivo específico
curl -X POST http://localhost:62000/api/comandos/356354870699551/ativar

# Enviar comando individual
curl -X POST http://localhost:62000/api/comandos/356354870699551/enviar \
  -H "Content-Type: application/json" \
  -d '{"comando": "SETLOCX22#"}'
```

### **Via SMS (Backup - Manual)**

Enviar SMS para o chip do rastreador:
```
SETLOCX22#
```

---

## 📱 ALARMES - STATUS E FUNCIONAMENTO

### **✅ Alarmes ESTÃO funcionando:**

#### **Alarmes recebidos recentemente:**
1. **Shock Alarm** (2025-12-10 22:40) - Choque detectado
2. **Power Cut Alarm** (2025-12-10 20:33) - Corte de energia
3. **Alarm 0x2B** (2025-12-10 19:33) - Tipo desconhecido

#### **18 tipos de alarmes implementados:**
- SOS (0x01)
- Corte de energia (0x02)
- Choque (0x03)
- ACC ON/OFF (0x04/0x05)
- Excesso de velocidade (0x08)
- Aceleração brusca (0x0E)
- Freada brusca (0x0F)
- Curva acentuada (0x10)
- Colisão (0x11)
- Reboque (0x13)
- Bateria baixa/conectada (0x14/0x15)
- Bateria fraca (0x18)
- Carga completa (0x21)
- Queda (0x23)
- Sensor de luz (0x26)

### **Ver alarmes via API:**
```bash
curl "http://localhost:62000/api/dispositivos/356354870699551/alarmes?horas=48"
```

---

## 🔍 VALIDAÇÃO DO SISTEMA

### **Script de validação completa:**
```bash
node scripts/validar-rastreadores.js
```

**O que verifica:**
- ✅ Status de conexão
- ✅ Idade dos dados
- ✅ Campos presentes/faltantes
- ✅ Detecção de dados em cache
- ✅ Recomendações automáticas

---

## 🎯 PRÓXIMOS PASSOS PARA DADOS 100% COMPLETOS

### **Para dispositivo 356354870699551:**
1. ✅ OBD2 funcionando (RPM, Temp, Combustível)
2. ❌ Falta bateria/horímetro → **Enviar: SETLOCX22#**

### **Para dispositivo 356354870702322:**
1. ✅ OBD2 funcionando (RPM, Temp, Combustível)
2. ❌ Falta bateria/horímetro → **Enviar: SETLOCX22#**

### **Para dispositivo 356354870658615:**
1. ✅ Bateria/horímetro funcionando
2. ❌ Falta OBD2 → **Verificar cabo OBD2 conectado**

---

## 📝 RESUMO FINAL

### **Sistema está 100% funcional com:**
- ✅ Detecção automática de ignição (off/acc_on/idle/moving)
- ✅ Validação de dados em cache
- ✅ Timeout automático (10 min)
- ✅ Alarmes sendo recebidos e salvos
- ✅ API completa funcionando
- ✅ Script de validação automática

### **Para dados completos, executar:**
```bash
# Ativar todos os rastreadores automaticamente
curl -X POST http://localhost:62000/api/comandos/356354870699551/ativar
curl -X POST http://localhost:62000/api/comandos/356354870702322/ativar
curl -X POST http://localhost:62000/api/comandos/356354870658615/ativar
```

### **Frontend:**
- Recarregar com `CTRL + SHIFT + R` para ver alarmes
- Alarmes aparecem na aba "Alarmes" automaticamente

---

## 🛠️ TROUBLESHOOTING

### **Dados OBD2 não aparecem:**
1. Verificar cabo OBD2 conectado
2. Verificar se veículo tem protocolo OBD2 (1996+)
3. Ligar ignição do veículo

### **Bateria/Horímetro não aparecem:**
1. Enviar comando `SETLOCX22#`
2. Aguardar 1 minuto
3. Verificar com `PARAM#` se `PROTOCOL:SETL`

### **Alarmes não aparecem:**
1. Verificar API: `curl .../alarmes?horas=48`
2. Recarregar página com `CTRL + SHIFT + R`
3. Verificar aba "Alarmes" na página

---

**Sistema validado e pronto para uso!** 🚀
