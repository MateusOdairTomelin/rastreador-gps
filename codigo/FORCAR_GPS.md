# 🛰️ FORÇAR GPS - Comandos Agressivos

## SMS para Forçar Fix de Satélites

### 1️⃣ Resetar módulo GPS completamente

```
#55555#YGPS#0#
```

Aguarde 10 segundos, depois:

```
#55555#YGPS#1#
```

---

### 2️⃣ Forçar busca de satélites AGORA

```
#55555#YGNSS#1#
```

Repetir 3 vezes com 5 segundos de intervalo:

```
#55555#YGNSS#1#
#55555#YGNSS#1#
#55555#YGNSS#1#
```

---

### 3️⃣ Desativar sleep completamente

```
#55555#YSLPOFF#
```

---

### 4️⃣ Forçar modo GPS de alta precisão

```
#55555#YACCGPS#1#
```

---

### 5️⃣ Definir intervalo MÍNIMO de envio (5 segundos)

```
#55555#YUP#5#
```

---

### 6️⃣ Ativar GNSS (GPS + GLONASS + Galileo)

```
#55555#YGNSS#3#
```

(Usa múltiplas constelações de satélites)

---

## ⚡ SEQUÊNCIA COMPLETA PARA FORÇAR

Envie na ordem, com **2 segundos de intervalo** entre cada:

```
#55555#RESET#
(aguarde 30 segundos)

#55555#YSLPOFF#
#55555#YGPS#0#
#55555#YGPS#1#
#55555#YGNSS#3#
#55555#YACCGPS#1#
#55555#YUP#5#
#55555#SHOWINFO#
```

---

## 📊 Verificar Status GPS

Envie e veja a resposta:

```
#55555#SHOWINFO#
```

Procure por:
- `GNSS: 0` = Sem satélites (❌ problema)
- `GNSS: 5+` = Tem fix (✅ funcionando)

---

## 🔌 Via Console Serial (se tiver acesso)

Se conseguir conectar via USB/Serial:

```bash
# Abrir porta serial (Linux/Mac)
screen /dev/ttyUSB0 115200

# Ou via minicom
minicom -D /dev/ttyUSB0 -b 115200
```

Depois envie (SEM o `#55555#`):

```
YGPS*0
YGPS*1
YGNSS*3
YUP*5
```

(Use `*` em vez de `#` no console)

---

## 🚨 Se Ainda Não Funcionar

**Teste de Hardware:**

1. Verifique se antena está conectada
2. Teste com magneto (ímã) próximo à antena
3. Reinicie completamente o rastreador (desconectar/conectar bateria)
4. Verifique se há LED de GPS piscando (indica tentativa de fix)

---

## 💡 Último Recurso

Se nada funcionar, pode ser:
- ❌ Antena GPS defeituosa
- ❌ Módulo GPS com problema de hardware
- ❌ Rastreador precisa de firmware update

Nesse caso, precisará contato com suporte técnico da X3Tech!
