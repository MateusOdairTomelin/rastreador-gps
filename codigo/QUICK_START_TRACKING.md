# ⚡ Quick Start - Rastrear Rastreador em 5 Minutos

## 🎯 Objetivo Final
Entender o que o rastreador está enviando e mostrar localização no mapa.

---

## 📋 Opção 1: Análise Completa (Recomendado)

### Terminal 1: Iniciar o Analisador
```bash
cd /home/tomelin/rastreador
node advanced-packet-analyzer.js
```

Você verá:
```
🔍 ADVANCED PACKET ANALYZER INICIADO
🚀 SERVIDOR DE MONITORAMENTO ESCUTANDO NA PORTA 9999
```

### Terminal 2: Monitorar em Tempo Real
```bash
tail -f /tmp/packet-analysis.log | head -100
```

### Terminal 3: Configurar Rastreador (via SMS)

Envie SMS ao rastreador:
```
#55555#SERVER,1,seu-ip-interno,9999,0#
```

**Exemplo (substitua seu IP):**
```
#55555#SERVER,1,192.168.1.100,9999,0#
```

### Aguardar 2 minutos e ver no log:

```json
{
  "protocol": {
    "number": "0x01",
    "name": "LOGIN/Heartbeat"
  }
}
```

Se vir:
- ✅ `0x12` = Localização está sendo enviada! 🎉
- ✅ `0x94` = Dados OBD2 sendo enviados! 🎉
- ❌ Só `0x01` = Precisa outro comando SMS

---

## 📊 Opção 2: Monitor sem Reconfigurar

### Terminal 1: Iniciar MITM
```bash
node monitor-mitm.js
```

### Terminal 2: Monitorar
```bash
tail -f /tmp/mitm-monitor.log
```

### Vantagem
- ✅ Não precisa reconfigurar rastreador
- ✅ Vê tudo que passa
- ✅ Detecta Location automaticamente

---

## 🖥️ Dashboard Visual (Opcional)

### Monitor de Heartbeat
```
http://seu-ip:62000/heartbeat.html
```

Mostra:
- Contagem de heartbeats
- Status conectado/ativo/offline
- Tempo desde última conexão

### Dashboard de Diagnóstico
```
http://seu-ip:62000/diagnostico.html
```

Mostra:
- Status geral
- Telemetria
- Testes de API

---

## 🔍 Interpretar Resultados

### Se você vê `0x12` LOCATION:

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
    "satellites": 12
  }
}
```

**✅ ÓTIMO! Localização funciona!**

Próximo passo: Servidor já está configurado para processar isso. Apenas aguarde dados aparecerem no mapa em:
```
http://seu-ip:62000/mapa.html
```

### Se você vê `0x94` OBD2:

```json
{
  "protocol": {
    "number": "0x94",
    "name": "OBD2 Data"
  },
  "details": {
    "rpm": 1200,
    "speed": 45,
    "temperature": 75,
    "batteryPercent": 85
  }
}
```

**✅ ÓTIMO! Dados do carro funcionam!**

Apareçam em:
```
http://seu-ip:62000/diagnostico.html
```

### Se você NÃO vê nada além de `0x01`:

```json
{
  "protocol": {
    "number": "0x01",
    "name": "LOGIN/Heartbeat"
  }
}
```

**❌ Rastreador não está enviando localização**

Tente:
```bash
# Ativar GPS
#55555#YGPS#1#

# Solicitar localização
#55555#YDIAG#1#

# Atualizar a cada 10 segundos
#55555#YUP#10#

# Forçar envio
#55555#YDISP#1#
```

---

## 📊 Comparar com Teste Vehicle

**Veículo de Teste** (IMEI: 123456789012345) está funcionando!

Acesse:
```
http://seu-ip:62000/diagnostico.html
```

Clique em "Carregar 1º Dispositivo" e veja que ele:
- ✅ Tem localização
- ✅ Tem velocidade
- ✅ Tem bateria
- ✅ Tem OBD2

Se seu Evoque Prata também mandar `0x12` e `0x94`, terá os mesmos dados.

---

## 🗺️ Ver Localização no Mapa

Quando tiver dados de localização:

```
http://seu-ip:62000/mapa.html
```

O mapa:
- 📍 Mostra todos os dispositivos
- 🔄 Atualiza a cada 5 segundos
- 🗺️ Pode clicar para centralizar
- 📊 Mostra status, velocidade, última atualização

---

## ⏱️ Timeline Esperada

```
Minuto 0:    Iniciar analyzer / MITM
Minuto 1:    Reconfigurar rastreador com novo SERVER
Minuto 2:    Primeira conexão chega ao analyzer
Minuto 3-5:  Vários heartbeats capturados
Minuto 10:   Padrão identificado

Se tiver GPS:
Minuto 5-10: Começa a enviar 0x12 LOCATION
Minuto 15+:  Dados aparecem no mapa
```

---

## 🚨 Troubleshooting

| Problema | Solução |
|----------|---------|
| Analyzer não mostra nada | Rastreador ainda conectando na porta antiga. Aguarde reconfiguração. |
| Só vejo LOGIN | Rastreador não foi reconfigurado. Envie SMS novamente. |
| Analyzer mostra erro | Verifique se IMEI está no banco de dados. |
| Não consegue enviar SMS | Número pode estar errado. Teste com plataforma X3Tech. |

---

## 📊 O Que o Servidor Já Sabe Fazer

✅ Receber LOGIN (0x01)
✅ Receber LOCATION (0x12)
✅ Receber OBD2 (0x94)
✅ Salvar no banco de dados
✅ Mostrar no mapa
✅ Mostrar na API
✅ Rastrear heartbeats

**Tudo já está pronto! Só precisa dos dados chegando!**

---

## 📱 Próximas Ações

**NOS PRÓXIMOS 10 MINUTOS:**
- [ ] Escolher Opção 1 ou 2
- [ ] Iniciar o analyzer/monitor
- [ ] Monitorar o log
- [ ] Enviar SMS de reconfiguração

**NOS PRÓXIMOS 30 MINUTOS:**
- [ ] Identificar tipo de protocolo recebido
- [ ] Ver se há 0x12 (LOCATION)
- [ ] Ver se há 0x94 (OBD2)
- [ ] Tirar screenshot do resultado

**QUANDO TIVER LOCALIZAÇÃO:**
- [ ] Aguardar aparecer no `/mapa.html`
- [ ] Verificar se coordenadas estão corretas
- [ ] Celebrar! 🎉

---

## 💬 Compartilhe os Resultados

Depois de capturar dados, envie:
1. Screenshot do analyzer/monitor
2. Tipo de protocolo que viu
3. Se tem LOCATION (0x12) ou OBD2 (0x94)
4. Padrão de frequência (a cada quantos segundos conecta)

Isso ajudará a entender exatamente como seu rastreador funciona!

---

**🚀 Pronto! Comece agora e nos vemos nos logs!**
