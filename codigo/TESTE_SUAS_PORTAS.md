# 🎯 Teste Com Suas Portas (62000 e 8877)

## ⚠️ Correção Importante

Sua aplicação roda em:
- **HTTP**: Porta `62000` (não 8000!)
- **TCP Rastreador**: Porta `8877` ✅ (correto)

Todas as URLs de teste devem usar `62000` em vez de `8000`.

---

## ⚡ Teste Rápido (Copiar e Colar) - PARA SUAS PORTAS

### Terminal 1: Iniciar Servidor

```bash
cd /home/tomelin/rastreador
npm start
```

**Esperado ver**:
```
🚗 Servidor TCP (Rastreador) escutando em 0.0.0.0:8877
✅ Servidor HTTP/WebSocket rodando
📱 Acesse em: http://localhost:62000    ← PORTA 62000!
📡 API REST: http://0.0.0.0:62000/api
```

---

### Terminal 2: Descobrir IMEI Conectado

```bash
curl http://localhost:62000/api/conexoes | jq '.dispositivos'
```

**Output esperado**:
```json
[
  {
    "imei": "358758091234567",
    "conectado": true,
    "remoteAddress": "192.168.x.x",
    "remotePort": xxxxx
  }
]
```

**Copiar este IMEI para usar depois**

---

### Terminal 2: Enviar Comandos de Inicialização

```bash
# Substitua pelo seu IMEI
IMEI="358758091234567"

# Ativar GPS + OBD2 + Intervalo 10s (tudo de uma vez)
curl -X POST http://localhost:62000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"
```

**Output esperado**:
```json
{
  "sucesso": true,
  "mensagem": "Comandos de inicialização enviados",
  "imei": "358758091234567",
  "resultados": [
    {
      "comando": "#55555#YGPS#1#",
      "descricao": "Ativar GPS",
      "sucesso": true
    },
    ...
  ]
}
```

---

### Aguardar 15-20 Segundos

```bash
sleep 20
```

Nesse tempo:
- XT40 recebe os comandos
- XT40 ativa GPS e OBD2
- XT40 começa enviar dados de volta

---

### Terminal 2: Verificar se Dados Chegaram

```bash
curl http://localhost:62000/api/localizacoes | jq '.dados[0]'
```

**Output esperado**:
```json
{
  "id": 123,
  "dispositivo_id": 1,
  "latitude": -23.5505,
  "longitude": -46.6333,
  "velocidade": 0,
  "direcao": 180,
  "precisao": 50,
  "satellites": 10,
  "altitude": null,
  "timestamp": "2025-12-10T14:35:45.000Z",
  "created_at": "2025-12-10T14:35:50.000Z"
}
```

Se vir `latitude` e `longitude` = ✅ **GPS FUNCIONANDO!**

---

## 📊 Todas as URLs Corretas (Para Suas Portas)

### Ver Status
```bash
curl http://localhost:62000/api/status
```

### Ver Dispositivos Conectados
```bash
curl http://localhost:62000/api/conexoes
```

### Ver Todas as Localizações
```bash
curl http://localhost:62000/api/localizacoes
```

### Ver Última Localização (Mais Recente)
```bash
curl http://localhost:62000/api/localizacoes | jq '.dados[0]'
```

### Ver Status do Rastreador (Heartbeat)
```bash
IMEI="358758091234567"
curl http://localhost:62000/api/heartbeats/$IMEI
```

---

## 🎮 Enviar Comandos Específicos

### Ativar GPS Apenas
```bash
IMEI="358758091234567"

curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'
```

### Ativar OBD2 Apenas
```bash
curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "OBD_ON"}'
```

### Mudar Intervalo para 10 Segundos
```bash
curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_10S"}'
```

### Mudar Intervalo para 30 Segundos (Recomendado)
```bash
curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_30S"}'
```

### Ver Status do Rastreador
```bash
curl -X POST http://localhost:62000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "STATUS"}'
```

---

## 🔧 Script Shell (Atualizado para Suas Portas)

```bash
# Se quer usar o script, atualize a variável:
export HOST=localhost
export PORT=62000

./commands-gps.sh
```

Ou edite direto o script:
```bash
# Abra commands-gps.sh e mude:
HOST="${HOST:-localhost}"
PORT="${PORT:-62000}"    # Mude de 8000 para 62000
```

---

## 🌐 Acessar Dashboard

Abra no navegador:
```
http://localhost:62000
```

Você verá o dashboard com:
- Mapa em tempo real
- Localização do XT40
- Status dos dispositivos
- Histórico de movimentos

---

## 📺 Ver Logs em Tempo Real

Terminal 1 (onde rodou `npm start`) mostra os logs:

```
[TCP] Cliente conectado: 192.168.x.x:xxxxx

🌍 [GPS] Dados de localização para 358758091234567: {
  lat: -23.5505,
  lon: -46.6333,
  speed: 0,
  timestamp: '2025-12-10T14:35:45.000Z'
}

✅ [Location] Saved for 358758091234567
```

Se vir isso = dados chegando corretamente! ✅

---

## ✅ Checklist para Você

- [ ] Terminal 1: `npm start` rodando
- [ ] Ver "🚗 Servidor TCP... 8877" nos logs
- [ ] Terminal 2: `curl http://localhost:62000/api/conexoes` retorna IMEI
- [ ] Enviar comando init com POST
- [ ] Aguardar 20 segundos
- [ ] Terminal 2: `curl http://localhost:62000/api/localizacoes` mostra latitude/longitude
- [ ] Ver logs em Terminal 1: procurar por `🌍 [GPS]`

Quando todos estiverem ✅ = Teste concluído com sucesso!

---

## 🆘 Se Não Funcionar

### ❌ Erro: "Dispositivo não está conectado"
```bash
# Verificar se XT40 está mesmo conectado
curl http://localhost:62000/api/conexoes

# Se vazio = XT40 não se conectou na porta 8877
# Verificar IP/Porta do XT40
```

### ❌ Nenhuma localização aparece
1. GPS precisa de sinal (próximo a janela)
2. Enviar comando: `{"comando": "GPS_ON"}`
3. Aguardar 30 segundos (primeira vez é lenta)
4. Ver logs em Terminal 1

### ❌ Erro no curl
```bash
# Se receber erro de conexão:
# Confirmar que servidor está rodando
ps aux | grep "node server"

# Confirmar que porta 62000 está aberta
netstat -tlnp | grep 62000
```

---

## 💡 Dica: Automatizar o Teste

```bash
#!/bin/bash
# Salve como: test-gps.sh

IMEI=$(curl -s http://localhost:62000/api/conexoes | jq -r '.dispositivos[0].imei')
echo "IMEI detectado: $IMEI"

echo "Enviando comandos de inicialização..."
curl -X POST http://localhost:62000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"

echo "Aguardando 20 segundos para XT40 processar..."
sleep 20

echo "Verificando dados..."
curl http://localhost:62000/api/localizacoes | jq '.dados[0]'

echo "Pronto!"
```

Use:
```bash
chmod +x test-gps.sh
./test-gps.sh
```

---

## 📚 Todas as URLs - Resumo

| Recurso | URL |
|---------|-----|
| API Status | `GET http://localhost:62000/api/status` |
| Dispositivos | `GET http://localhost:62000/api/conexoes` |
| Localizações | `GET http://localhost:62000/api/localizacoes` |
| Heartbeat | `GET http://localhost:62000/api/heartbeats/:imei` |
| Enviar Comando | `POST http://localhost:62000/api/comandos/:imei` |
| Init Automático | `POST http://localhost:62000/api/comandos/:imei/init` |
| Listar Comandos | `GET http://localhost:62000/api/comandos` |
| Dashboard Web | `http://localhost:62000` |

---

## 🎯 Teste Passo a Passo - Versão Suas Portas

```bash
# 1. Iniciar
npm start

# 2. Em outro terminal, descobrir IMEI
curl http://localhost:62000/api/conexoes | jq '.dispositivos[0].imei'
# Copie a resposta

# 3. Enviar init (substitua o IMEI)
IMEI="coloque_aqui"
curl -X POST http://localhost:62000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"

# 4. Aguardar
sleep 20

# 5. Ver dados
curl http://localhost:62000/api/localizacoes | jq '.dados[0].latitude'

# Se vir um número = ✅ SUCESSO!
```

---

**Resumo**: Use `localhost:62000` em vez de `localhost:8000` em todas as URLs!

**Data**: 2025-12-10
**Status**: ✅ Adaptado para suas portas
