# 🔍 Como Rastrear o Protocolo do Rastreador

## O Objetivo

Entender **exatamente** o que o rastreador está enviando e recebendo para:
1. Identificar por que não envia dados de localização
2. Configurar o servidor para processar corretamente
3. Mostrar a localização no mapa

---

## 📊 Método 1: Usar o Advanced Packet Analyzer (RECOMENDADO)

O `advanced-packet-analyzer.js` monitora **TODA** a comunicação e cria um log detalhado.

### Passo 1: Iniciar o Analisador

```bash
node advanced-packet-analyzer.js
```

Você verá:
```
🔍 ADVANCED PACKET ANALYZER INICIADO
📝 Log: /tmp/packet-analysis.log
🚀 SERVIDOR DE MONITORAMENTO ESCUTANDO NA PORTA 9999
```

### Passo 2: Configurar o Rastreador para Conectar ao Analisador

**Via SMS:**
```
#55555#SERVER,1,seu-ip-local,9999,0#
```

**Exemplo:**
```
#55555#SERVER,1,192.168.1.100,9999,0#
```

### Passo 3: Monitorar o Log em Tempo Real

```bash
tail -f /tmp/packet-analysis.log
```

### Passo 4: Enviar Comandos ao Rastreador

Enquanto monitora o log, envie alguns comandos para ver a reação:

```bash
# Ativar GPS
#55555#YGPS#1#

# Solicitar localização
#55555#YDIAG#1#

# Solicitar OBD2
#55555#YOBD#1#

# Atualizar a cada 10 segundos
#55555#YUP#10#
```

### Passo 5: Analisar os Resultados

O log mostrará:

**LOGIN (esperado):**
```json
{
  "protocol": {
    "number": "0x01",
    "name": "LOGIN/Heartbeat"
  },
  "details": {
    "type": "LOGIN",
    "imei": "356354870699551",
    "deviceType": "0x03",
    "timezone": 0
  }
}
```

**LOCATION (o que queremos):**
```json
{
  "protocol": {
    "number": "0x12",
    "name": "Location Data"
  },
  "details": {
    "type": "LOCATION",
    "timestamp": "2025-12-09 17:45:30",
    "latitude": "-15.793300° S",
    "longitude": "-48.001900° W",
    "speed": "0 km/h",
    "direction": "0°",
    "satellites": 12
  }
}
```

**OBD2 (o que queremos):**
```json
{
  "protocol": {
    "number": "0x94",
    "name": "OBD2 Data"
  },
  "details": {
    "type": "OBD2_DATA",
    "rpm": 1200,
    "speed": 0,
    "temperature": 75,
    "fuel": 95,
    "odometer": "12345.5",
    "batteryPercent": 85,
    "batteryVoltage": "12.85",
    "ignition": "ON"
  }
}
```

---

## 📈 Método 2: Analisar o Log Estruturado

Depois que o analisador rodou por um tempo:

```bash
cat /tmp/packet-analysis.log | grep -A 10 "LOCATION"
```

Isso mostrará todas as mensagens de localização capturadas.

---

## 🎯 O Que Procurar

### ✅ Bom Sinal:
- [ ] Você vê pacotes de tipo `0x12` (LOCATION)?
- [ ] Você vê pacotes de tipo `0x94` (OBD2)?
- [ ] Os dados têm valores válidos (latitude/longitude diferente de zero)?
- [ ] Timestamp está correto?

### ❌ Problema:
- [ ] Só vê `0x01` (LOGIN) repetidamente?
- [ ] Nenhum `0x12` ou `0x94` é enviado?
- [ ] Rastreador desconecta após cada LOGIN?

---

## 🔧 O Que Fazer com os Resultados

### Se você vê LOCATION (0x12):

A localização está sendo enviada! O servidor precisa:

1. **Ativar a função de parsing de location** em `/home/tomelin/rastreador/server/parsers/gps-parser.js`
2. **Salvar no banco de dados** em `/home/tomelin/rastreador/server/services/localizacao.service.js`
3. **Mostrar no mapa** que já está pronto em `/home/tomelin/rastreador/public/mapa.html`

### Se você NÃO vê LOCATION (0x12):

O rastreador não está enviando. Possibilidades:

1. **GPS sem satélites** - Antena/módulo com problema
2. **Comando errado** - Precisa de outro comando SMS
3. **Configuração do rastreador** - Precisa ser reconfigurado
4. **Modo offline** - Rastreador em modo heartbeat-only

---

## 📊 Interpretar os Dados Brutos

### Estrutura de um Pacote (HEX):

```
78 78 - Start bit (sempre 0x7878)
0D   - Comprimento (13 bytes de dados)
01   - Protocol number (0x01 = LOGIN)
03   - Device type
56 35 48 70 69 95 51 - IMEI em BCD
00 00 - Timezone
12 34 - Serial number
56 - CRC checksum
0D 0A - End bits
```

### Decodificar BCD (para IMEI):

O IMEI é codificado em BCD (Binary Coded Decimal):
```
Hex: 56 35 48 70 69 95 51
BCD:  5  6  3  5  4  8  7  0  6  9  9  5  5  1
IMEI: 356354870699551
```

---

## 💡 Dicas

1. **Deixe rodando por 2-3 minutos** para capturar vários ciclos
2. **Registre o padrão de conexão**:
   - A cada quanto tempo conecta?
   - Quanto tempo fica conectado?
   - Que tipo de dados envia?

3. **Compare com dispositivos de teste** que funcionam

4. **Verifique logs de erros** no final do arquivo

---

## 📱 Alternativa: Usar plataforma X3Tech

A plataforma da X3Tech também mostra os pacotes. Se você acessar a conta dele lá, verá:
- Status em tempo real
- Dados de localização sendo recebidos
- Histórico completo

Se não vê dados lá, é definitivamente problema no rastreador, não na sua aplicação.

---

## ✅ Checklist

- [ ] Advanced Packet Analyzer iniciado
- [ ] Rastreador reconfigurado para conectar ao analisador
- [ ] Capturou pelo menos 5 conexões
- [ ] Analisou o tipo de pacote enviado
- [ ] Identificou se há dados de localização
- [ ] Registrou o padrão de comportamento
- [ ] Compartilhou os logs comigo para análise

---

**Quando tiver os resultados, compartilhe comigo que vou ajudar a interpretar e configurar o servidor corretamente!**
