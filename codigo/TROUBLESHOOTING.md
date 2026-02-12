# 🔧 Troubleshooting Guide - Rastreador de Frota

## 🎯 Quick Diagnosis

### Symptom 1: "Não estou vendo localização no mapa"

**Step 1: Check Dashboard**
```
Acesse: http://seu-ip:62000/diagnostico.html
Clique em: "Carregar Dispositivo" para seu IMEI
```

**Expected Result:**
- Se mostra dados (localização, velocidade) → Problema é na sua aplicação
- Se mostra N/A → Rastreador não está enviando dados

---

### Symptom 2: "Estou vendo heartbeat mas sem localização"

**This is NORMAL!** ✅

Significa:
- Servidor está recebendo conexões ✅
- Rastreador está vivo ✅
- Mas GPS/OBD2 não foram ativados ⏳

**Solução:** Envie comando de configuração
```
#55555#YGPS#1#
```

---

### Symptom 3: "Não estou vendo nada no dashboard"

**Diagnosticar:**

1. **Servidor está rodando?**
   ```bash
   curl -s http://localhost:62000/api/heartbeats | jq .
   ```
   - Se retorna JSON → Servidor OK
   - Se erro → Servidor não está rodando

2. **Rastreador está se conectando?**
   ```bash
   tail -20 /tmp/server.log | grep -i "conectado\|heartbeat"
   ```
   - Se vê "conectado" → Rastreador OK
   - Se vê nada → Rastreador não está conectando

3. **Banco de dados está salva ndo?**
   ```bash
   psql -U postgres -d rastreador -c "SELECT COUNT(*) FROM dispositivos;"
   ```
   - Se retorna > 0 → Database OK
   - Se retorna 0 → Nenhum dispositivo registrado

---

## 🔴 Problemas Comuns

### Problema 1: LED GPS Piscando (Procurando Satélite)

**Causa:** Rastreador sem lock de satélites

**Soluções (em ordem):**

1. **Aguarde 5-10 minutos**
   - GPS precisa de tempo para adquirir satélites
   - Deixe o rastreador próximo a janela
   - Não coloque em área com obstáculos

2. **Verifique antena GPS**
   ```
   - Antena deve estar conectada na porta GPS
   - Antena deve estar para cima (não dobrada)
   - Tente remover e reconectar
   ```

3. **Ativar GPS via SMS**
   ```
   #55555#YGPS#1#
   Resposta esperada: GPS OK!
   ```

4. **Solicitar diagnóstico**
   ```
   #55555#YDIAG#1#
   Resposta esperada: YDIAG OK!
   ```

5. **Se continuar piscando após 15 minutos**
   - Antena defeituosa (substituir)
   - Módulo GPS defeituoso (RMA)
   - Contate X3Tech

---

### Problema 2: LED Rede Piscando (Blinking)

**Cause:** Heartbeat pattern (normal!)

**Explicação:**
```
[0s]     Conecta ao servidor
[0.5s]   Envia LOGIN
[0.6s]   Recebe ACK
[0.7s]   Desconecta
[30s]    Aguarda
[30s]    Conecta novamente → Blink!
```

**Você está vendo:** Esse padrão de blink, blink, blink...

**Isso significa:**
- ✅ Rastreador está vivo
- ✅ Servidor está respondendo
- ✅ Comunicação está normal
- ❌ Não é um erro!

**Quando deve estar fixo?**
- Se enviar dados continuamente (0x12 LOCATION)
- LED piscará menos frequentemente

---

### Problema 3: "Enviador SMS mas Rastreador Não Responde"

**Passo 1: Verificar Número do SIM**

```bash
# O número deve ser exato
# Verifique qual número está no seu SIM card
```

**Passo 2: Testar Outro Número**

- Peça à X3Tech qual número usar
- Tente enviar para esse número primeiro
- Depois reconfigurar seu número

**Passo 3: Aguardar Resposta Correta**

```
Enviado:  #55555#YGPS#1#
Esperado: GPS OK! (ou YGPS OK!)
Se não recebe: SIM não está ativo
```

**Passo 4: Validar com X3Tech**

Se nenhum comando retorna resposta:
1. Contate X3Tech com número do SIM
2. Verifique se crédito está ativo
3. Peça envio de SMS de teste para seu número

---

### Problema 4: "Rastreador Conecta Mas Desconecta Rápido"

**Causa Provável:** ACK incorreto

**Verificação:**

```bash
# Ver logs de ACK
tail -50 /tmp/server.log | grep "ACK"
```

**Esperado:**
```
[TCP] Enviando ACK (10 bytes): 78780401010001050d0a
```

**Se ACK estiver errado:**
- Bytes incorretos
- Tamanho incorreto
- Servidor não tá enviando

**Solução:**

Verifique que `server/parsers/gps-parser.js` tem:

```javascript
createAckResponse(protocolNumber, serialNumber) {
  const buffer = Buffer.alloc(10);
  let pos = 0;

  buffer.writeUInt16BE(0x7878, pos);
  pos += 2;
  buffer.writeUInt8(0x04, pos++);
  buffer.writeUInt8(0x01, pos++);
  buffer.writeUInt8(protocolNumber, pos++);
  buffer.writeUInt16BE(serialNumber || 0x0001, pos);
  pos += 2;

  const crc = this.calculateCRC(buffer, 2, pos);
  buffer.writeUInt8(crc, pos++);
  buffer.writeUInt8(0x0D, pos++);
  buffer.writeUInt8(0x0A, pos++);

  return buffer;
}
```

---

### Problema 5: "Rastreador Envia LOCATION Mas Dashboard Mostra N/A"

**Possíveis Causas:**

#### 1. Dados Inválidos (Coordenadas = 0,0)

```bash
# Ver dados recebidos
tail -100 /tmp/server.log | grep -A 5 "LOCATION"
```

**Se vê:**
```
latitude: 0.000000°N
longitude: 0.000000°E
```

**Problema:** GPS não tem lock de satélites

**Solução:**
- Deixe ao ar livre por 10 minutos
- Verifique antena
- Verifique se realmente tem satélites

#### 2. Tipo de Localização não Suportado

**X3Tech usa A-GPS:** Tenta fornecer posição mesmo sem satélites completos

**Seu servidor pode não estar decodificando:**

Verifique em `server/parsers/gps-parser.js`:

```javascript
parseLocation(buffer) {
  // Deve ter offset correto para dados A-GPS vs normal GPS
  const offset = buffer.indexOf(0x78); // Ajustar conforme necessário
}
```

#### 3. Timezone Incorreto

```bash
# Ver timestamp dos dados
tail -100 /tmp/server.log | grep "timestamp"
```

Se timestamp está no futuro/passado:
```
Problema: Timezone incorreto no rastreador
Solução: Enviar comando de timezone
#55555#YTZ#-3# (para São Paulo = UTC-3)
```

---

### Problema 6: "OBD2 Dados Sempre N/A"

**Verificação 1: Está Ativado?**

```bash
# Verificar se OBD2 foi ativado
tail -100 /tmp/server.log | grep "OBD2\|0x94"
```

- Se vê 0x94 packets → OBD2 ativado ✅
- Se não vê nada → Não foi ativado

**Solução:** Enviar comando de ativação
```
#55555#YOBD#1#
```

**Verificação 2: Cabo OBD2 Conectado?**

```
- Desconectar conector OBD2 do carro
- Checar se tem pinos corrosão
- Reconectar firmemente
```

**Verificação 3: Carro Suporta OBD2 Standard?**

Alguns carros usam OBD2 encriptado:
- Carros muito novos (após 2020)
- Alguns modelos de luxo
- Carros com sistema de proteção

**Teste:** Conectar scanner OBD2 comercial ao carro
- Se scanner lê dados → Carro suporta
- Se scanner não lê → Carro encriptado ou com proteção

**Solução para OBD2 Encriptado:**
- Contate X3Tech sobre firmware com suporte
- Pode precisar de licença adicional

---

### Problema 7: "Servidor Log Mostra Erro de Parse"

**Procure por:**
```bash
tail -100 /tmp/server.log | grep -i "error\|erro"
```

**Tipos Comuns:**

**Erro 1: "CRC Checksum Failed"**
```
Significado: Pacote corrompido na transmissão
Solução: Ignorar, próxima tentativa
Status: Normal, acontece ocasionalmente
```

**Erro 2: "Unknown Protocol 0xXX"**
```
Significado: Rastreador enviou protocolo não reconhecido
Solução: Investigar se é novo tipo de pacote
Status: Pode precisar atualizar parser
```

**Erro 3: "IMEI Not Found in Database"**
```
Significado: Pacote chegou de rastreador não cadastrado
Solução: Cadastrar novo dispositivo manualmente
Status: Criará dispositivo automaticamente na próxima
```

**Erro 4: "Buffer Too Short"**
```
Significado: Pacote incompleto
Solução: Ignorar, aguardar próximo
Status: Normal em conexões lentas
```

---

## 🎯 Checklist de Diagnóstico Completo

Quando tiver problema, execute em ordem:

```bash
# 1. Servidor está online?
curl -s http://localhost:62000/ | head -5

# 2. Porta 8877 está escutando?
sudo lsof -i :8877

# 3. Rastreador conectou?
tail -20 /tmp/server.log | grep "Cliente conectado"

# 4. Dados foram recebidos?
tail -20 /tmp/server.log | grep "Dados recebidos"

# 5. Parsing funcionou?
tail -20 /tmp/server.log | grep "parseados\|parsed"

# 6. Device foi criado?
psql -U postgres -d rastreador -c \
  "SELECT imei, dispositivo_nome, online FROM dispositivos;"

# 7. Localização foi salva?
psql -U postgres -d rastreador -c \
  "SELECT imei, latitud, longitude FROM localizacoes LIMIT 5;"

# 8. Heartbeat foi registrado?
curl -s http://localhost:62000/api/heartbeats | jq .

# 9. API responde com dados?
curl -s http://localhost:62000/api/dispositivos | jq .

# 10. Dashboard carrega?
curl -s http://localhost:62000/diagnostico.html | wc -l
```

**Se tudo retornar sem erros:** Sistema está 100% OK!

---

## 📞 Quando Contatar X3Tech

**Contate X3Tech se:**

1. **LED GPS não ativa após 15 minutos**
   - Pode ser antena ou módulo defeituoso
   - Solicite RMA

2. **Nenhum comando SMS retorna resposta**
   - Pode ser SIM inativo ou crédito zerado
   - Peça validação de número e crédito

3. **Dados OBD2 nunca chegam**
   - Pode ser carro encriptado
   - Peça suporte para seu modelo de carro

4. **Rastreador conecta mas envia dados lixo**
   - Pode ser firmware desatualizado
   - Peça atualização de firmware

**O que enviar a X3Tech:**

```
1. Número IMEI do rastreador
2. Modelo exato do carro
3. Número do SIM card usado
4. Screenshot deste troubleshooting
5. Logs do servidor (tail -100 /tmp/server.log)
6. Se tiver: Saída da plataforma X3Tech mostrando dados
```

---

## ✅ Validação de Sistema OK

Se você vê **TODOS** estes sinais:

- ✅ Dashboard carrega sem erro
- ✅ Heartbeat contador incrementando (1, 2, 3, 4...)
- ✅ Dispositivo mostra status "online"
- ✅ Timestamp update recentemente
- ✅ Servidor log sem erros RED
- ✅ API `/api/heartbeats` retorna JSON válido
- ✅ Conexões TCP em `/var/log/server.log` constantes

**Parabéns!** Seu sistema está 100% funcional!

A falta de localização é **apenas configuração do rastreador**, não problema da aplicação.

---

## 📋 Documentos Relacionados

- **RASTREADOR_CONFIG.md** - Como ativar todos os recursos
- **SYSTEM_STATUS.md** - Status atual do sistema
- **QUICK_START_TRACKING.md** - Começar rápido
- **RASTREAR_PROTOCOLO.md** - Entender protocolo GT06

