# 📱 Configurar Rastreador XT40 via SMS

## Dados do Servidor

```
Host: 6754056cd710.sn.mynetname.net
Porta: 8877
Protocolo: TCP
```

---

## 📤 Comandos SMS para Enviar

Envie cada comando via SMS **para o número do rastreador/chip**.

### 1️⃣ Configurar Servidor (OBRIGATÓRIO)

```
SERVER,1,6754056cd710.sn.mynetname.net,8877,0#
```

**Explicação:**
- `SERVER` = Comando de configuração do servidor
- `1` = Protocol ID (1 = TCP padrão para X3Tech)
- `6754056cd710.sn.mynetname.net` = Seu host/domínio
- `8877` = Porta do servidor
- `0` = Reserve (não altere)
- `#` = Fim do comando

---

### 2️⃣ Configurar APN (se necessário)

Se o rastreador não estiver conectando à rede:

```
APN,unifique.com.br#
```

**Para outras operadoras:**
- Vivo: `APN,vivo.br#`
- Claro: `APN,claro.com.br#`
- TIM: `APN,tim.br#`
- Oi: `APN,oi.com.br#`

---

### 3️⃣ Configurar Intervalo de Envio (Opcional)

Para enviar localização a cada 60 segundos:

```
GPRS,60#
```

(Intervalo em segundos)

---

### 4️⃣ Verificar Configuração (Opcional)

Para confirmar se foi configurado:

```
CONFIG#
```

O rastreador deve responder com as configurações atuais.

---

## ✅ Procedimento Completo

1. **Anote o número do chip/rastreador**
   - Exemplo: +55 11 98765-4321

2. **Envie o SMS principal:**
   ```
   SERVER,1,6754056cd710.sn.mynetname.net,8877,0#
   ```

3. **Se necessário, configure APN:**
   ```
   APN,unifique.com.br#
   ```
   *(substitua pela operadora do seu chip)*

4. **Aguarde 30-60 segundos**
   - O rastreador vai se conectar ao servidor

5. **Verifique no dashboard:**
   - Acesse: http://seu-ip-externo:62000
   - Procure pelo rastreador na lista

---

## 🔍 Verificação

No dashboard, você deve ver:
- Status: 🟢 **Online**
- Última conexão: Data/hora recente
- Localização: Latitude/Longitude

---

## 📋 Checklist Pré-Configuração

- [ ] Porta 8877 aberta no UFW do servidor
- [ ] Port Forwarding configurado na Mikrotik
- [ ] Chip/SIM ativo com plano de dados
- [ ] Rastreador XT40 com bateria
- [ ] DNS dinâmico atualizado
- [ ] Servidor Node.js rodando (`node server/index.js`)

---

## 🆘 Se Não Conectar

1. **Verifique o status do servidor:**
   ```bash
   ss -tlnp | grep 8877
   ```
   Deve mostrar: `LISTEN ... 0.0.0.0:8877`

2. **Teste a conectividade:**
   ```bash
   netcat -zv 6754056cd710.sn.mynetname.net 8877
   ```
   Deve retornar: `Connection succeeded`

3. **Verifique os logs:**
   ```bash
   tail -f /tmp/server.log
   ```
   Procure por: `[TCP] Cliente conectado`

4. **Confirme a APN:**
   ```
   APN#
   ```
   O rastreador responderá com a APN configurada

---

## 📞 Suporte X3Tech

Se precisar de mais informações sobre comandos específicos:
- Documentação: [X3Tech Knowledge Base](https://www.traccar.org)
- Formato pode variar conforme o modelo do rastreador
