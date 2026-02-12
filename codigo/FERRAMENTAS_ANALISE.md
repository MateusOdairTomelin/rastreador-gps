# 🛠️ Ferramentas de Análise do Rastreador

Você tem agora **3 ferramentas poderosas** para entender exatamente como o rastreador funciona:

---

## 🎯 Escolha Rápida

```
┌─────────────────────────────────────────────────────────┐
│ QUAL FERRAMENTA USAR?                                   │
├─────────────────────────────────────────────────────────┤
│ Análise Completa e Detalhada   → advanced-packet-analyzer.js │
│ Não quer reconfigurar           → monitor-mitm.js            │
│ Ver logs em tempo real          → diagnostico.html            │
│ Monitorar saúde do rastreador   → heartbeat.html              │
└─────────────────────────────────────────────────────────┘
```

---

## 🔍 Ferramenta 1: Advanced Packet Analyzer

**Arquivo:** `advanced-packet-analyzer.js`
**Porta:** 9999
**Para que serve:** Análise PROFUNDA de todos os pacotes

### Uso Rápido:

```bash
# Terminal 1: Iniciar o analisador
node advanced-packet-analyzer.js

# Terminal 2: Monitorar em tempo real
tail -f /tmp/packet-analysis.log

# Terminal 3: Configurar rastreador via SMS
#55555#SERVER,1,seu-ip,9999,0#
```

### O que você verá:

```
✅ CONEXÃO ESTABELECIDA: 192.168.1.100:56188

📥 PACOTE RECEBIDO de 192.168.1.100:56188 (18 bytes)

{
  "hex": "78780D01035635487069955100DA00A40D0A",
  "direction": "RX",
  "protocol": {
    "number": "0x01",
    "name": "LOGIN/Heartbeat"
  },
  "details": {
    "type": "LOGIN",
    "imei": "356354870699551",
    "deviceType": "0x03"
  }
}
```

### Interpretação:

| O que você vê | Significa |
|---|---|
| `0x01` LOGIN | Rastreador conectando |
| `0x12` LOCATION | GPS enviando coordenadas ✅ |
| `0x94` OBD2 | Dados do carro ✅ |
| `0x13` STATUS | Status da bateria |
| Só `0x01` | Rastreador não envia localização ❌ |

---

## 🕵️ Ferramenta 2: Man-in-the-Middle Monitor

**Arquivo:** `monitor-mitm.js`
**Porta:** 8878 (proxy para 8877)
**Para que serve:** Ver tudo que passa entre rastreador e servidor

### Uso Rápido:

```bash
# Terminal 1: Iniciar MITM
node monitor-mitm.js

# Terminal 2: Monitorar
tail -f /tmp/mitm-monitor.log

# Terminal 3: Redirecionar tráfego (opcional)
# Pode deixar o rastreador conectando normalmente na porta 8877
```

### Vantagens:

- ✅ Não precisa reconfigurar rastreador
- ✅ Vê dados em tempo real
- ✅ Detecta Location data automaticamente
- ✅ Não modifica nada (man-in-the-middle puro)

---

## 📊 Ferramenta 3: Dashboard de Diagnóstico

**URL:** `http://seu-ip:62000/diagnostico.html`
**Para que serve:** Interface visual para testar a API

### Recursos:

- 📈 Status geral do sistema
- 📱 Seleção de dispositivo
- 📊 Telemetria em tempo real
- ⚡ Testes rápidos de API
- 📋 Log estruturado

---

## 💓 Ferramenta 4: Monitor de Heartbeat

**URL:** `http://seu-ip:62000/heartbeat.html`
**Para que serve:** Visualizar padrão de conexão do rastreador

### Recursos:

- 💓 Contagem de heartbeats
- 📱 Status de cada dispositivo
- ⏱️ Tempo desde última conexão
- 🔄 Auto-atualização a cada 5 segundos
- 🎨 Indicadores visuais

---

## 📋 Plano de Ação

### Passo 1: Capturar Dados (15 minutos)

```bash
# Iniciar Advanced Packet Analyzer
node advanced-packet-analyzer.js &

# Em outro terminal, monitorar
tail -f /tmp/packet-analysis.log

# Deixar rodando enquanto você:
# - Reconfiguração rastreador
# - Envia alguns SMS de comando
# - Aguarda 10 minutos capturando
```

### Passo 2: Analisar Resultados

```bash
# Contar tipos de pacote
grep -o '"name": "[^"]*"' /tmp/packet-analysis.log | sort | uniq -c

# Ver se há Location Data
grep -i location /tmp/packet-analysis.log

# Ver se há OBD2
grep -i "obd2" /tmp/packet-analysis.log
```

### Passo 3: Interpretação

| Resultado | Significado | Ação |
|---|---|---|
| Vê `0x12` LOCATION | GPS funcionando ✅ | Configure servidor para processar |
| Vê `0x94` OBD2 | OBD funcionando ✅ | Configure servidor para processar |
| Só vê `0x01` | Rastreador com problema ❌ | Tente outros comandos SMS |
| Muitos heartbeats | Rastreador vivo ✅ | Padrão normal de conexão |

---

## 🚀 Exemplo Completo

### Cenário: Você quer ver localização no mapa

**Passo 1:** Executar Advanced Analyzer
```bash
node advanced-packet-analyzer.js
```

**Passo 2:** Reconfigurar rastreador
```bash
# Via SMS ao rastreador
#55555#SERVER,1,192.168.1.100,9999,0#
```

**Passo 3:** Enviar comando para localização
```bash
# Via SMS ao rastreador
#55555#YGPS#1#
```

**Passo 4:** Monitorar o log
```bash
tail -f /tmp/packet-analysis.log | grep -E "LOCATION|0x12"
```

**Passo 5:** Se vir `0x12` LOCATION
- ✅ GPS está funcionando
- ✅ Rastreador está enviando
- ✅ Agora configurar mapa.html para processar

---

## 🔧 Configurar Servidor para Receber Localização

Após confirmar que o rastreador envia `0x12`:

### 1. Verificar se parser recogniza

**Arquivo:** `/home/tomelin/rastreador/server/parsers/gps-parser.js`

O parser já deveria reconhecer `0x12` e chamar `parseLocation()`

### 2. Verificar se servidor processa

**Arquivo:** `/home/tomelin/rastreador/server/index.js`

No switch de tipos, procure:
```javascript
case 'location':
  await handleLocationData(imei, parsedData.data);
  break;
```

Se não encontrar, adicionamos.

### 3. Verificar se salva no banco

**Arquivo:** `/home/tomelin/rastreador/server/services/localizacao.service.js`

Deve ter `create()` para salvar dados.

### 4. Exibir no mapa

**Arquivo:** `/home/tomelin/rastreador/public/mapa.html`

Já está implementado! Só precisa dos dados no banco.

---

## 💡 Dicas Importantes

### 📱 Não Quer Reconfigurar?

Use o `monitor-mitm.js` que funciona sem reconfigurar:
```bash
node monitor-mitm.js &
tail -f /tmp/mitm-monitor.log
```

### 🔄 Ver Estatísticas em Tempo Real

O analyzer mostra a cada 30 segundos:
```json
{
  "totalPackets": 150,
  "byProtocol": {
    "LOGIN/Heartbeat": 120,
    "Location Data": 20,
    "OBD2 Data": 10
  },
  "byDirection": {
    "RX": 140,
    "TX": 10
  }
}
```

### 📊 Comparar com Teste Vehicle

Se o "Veículo de Teste" envia dados:
- Vá em `http://ip:62000/diagnostivo.html`
- Carregue o Veículo de Teste
- Veja que dados ele envia
- Compare padrão com seu rastreador

---

## ❓ Perguntas Frequentes

**P: Por que só vejo LOGIN?**
A: Rastreador não foi configurado para enviar GPS. Tente comandos SMS.

**P: Preciso parar o servidor atual?**
A: Não! Use monitor-mitm.js que funciona paralelo.

**P: Como interpretar o HEX?**
A: Veja a seção "Estrutura de um Pacote" em RASTREAR_PROTOCOLO.md

**P: E se nada funcionar?**
A: Envie os logs para X3Tech. Pode ser hardware defeituoso.

---

## 📞 Próximos Passos

1. ✅ Escolher ferramenta apropriada
2. ✅ Capturar dados por 15 minutos
3. ✅ Análisar resultados
4. ✅ Se vê localização → Configurar mapa
5. ✅ Se não vê → Tentar outros comandos

**Quando tiver os resultados, compartilhe os logs comigo!**
