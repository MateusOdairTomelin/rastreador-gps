# 🛰️ Ativar GPS no Rastreador XT40

## Comandos SMS para Ativar GPS e OBD2

Envie **para o número do chip** do rastreador:

### 1️⃣ Ativar GPS (envio contínuo)

```
#55555#YUP#60#
```

**Significado:**
- `YUP` = GPS Update Position (atualizar posição GPS)
- `60` = Enviar a cada 60 segundos
- `#` = Fim do comando

---

### 2️⃣ Ativar OBD2 (dados do veículo)

```
#55555#YDIY#0,1#
```

**Significado:**
- `YDIY` = DIY (dados customizados)
- `0,1` = Ativar OBD2
- `#` = Fim do comando

---

### 3️⃣ Ativar GPS + OBD2 + Bateria (tudo junto)

```
#55555#YUP#60#
#55555#YDIY#0,1#
#55555#YHBT#1,5#
```

**Significado:**
- `YHBT` = Ativar monitoramento de bateria
- `1,5` = Intervalo de monitoramento

---

### 4️⃣ Status - Verificar se está ativo

```
#55555#SHOWINFO#
```

O rastreador responderá com todas as configurações atuais incluindo GPS.

---

## ⚠️ Configurações Importantes

Se GPS não estiver funcionando mesmo após ativar, verifique:

### Verificar GNSS (satélites)

```
#55555#YGNSS#1#
```

Força busca de satélites GPS/GLONASS.

---

### Resetar GPS

```
#55555#YGPS#0#
```

Para resetar completamente o módulo GPS.

---

### Ativar modo de economia de energia

```
#55555#YSLPOFF#
```

Se GPS está em modo econômico, isso ativa o modo normal.

---

## 📱 Procedimento Completo

1. **Envie na ordem:**
   ```
   #55555#YSLPOFF#
   ```
   Aguarde 5 segundos

   ```
   #55555#YGNSS#1#
   ```
   Aguarde 5 segundos

   ```
   #55555#YUP#60#
   ```
   Aguarde 5 segundos

   ```
   #55555#YDIY#0,1#
   ```

2. **Aguarde 30-60 segundos**

3. **Verifique se dados chegam:**
   ```
   http://6754056cd710.sn.mynetname.net:62000/mapa.html
   ```

---

## 🔍 Debug - Verificar Tudo

Envie este comando para ver o status completo:

```
#55555#SHOWINFO#
```

Procure por:
- `GPS: ON/OFF` - Status do GPS
- `GNSS: número de satélites` - Quantos satélites vê
- `UPP: 60` - Intervalo de envio de GPS
- `OBD2: ON/OFF` - Status do OBD2

---

## ❌ Se ainda não funcionar

Pode ser:
1. **Sem sinal GPS** - Rastreador não vê satélites (indoor/subterrâneo)
2. **OBD2 não plugado** - Conector não conectado ao veículo
3. **Chip sem dados** - SIM card sem plano de dados ativo
4. **Rastreador congelado** - Tente:
   ```
   #55555#RESET#
   ```
   Após reset, reenviie todos os comandos acima.

---

## 📞 Próximos passos

1. Envie os comandos SMS
2. Aguarde 2 minutos
3. Acesse o mapa
4. Se ainda não funcionar, me avisa qual comando respondeu com erro!
