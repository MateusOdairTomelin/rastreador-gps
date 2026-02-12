# ⚡ Quick Start - Ativar GPS em 60 Segundos

## 🎯 Objetivo
Ter dados de localização GPS chegando da porta 8877 em tempo real.

---

## ⚙️ Pré-requisitos
- Servidor rodando: `npm start` (em um terminal)
- XT40 conectado e enviando heartbeat

---

## 🚀 Teste Rápido (Copiar e Colar)

### 1️⃣ Ver se rastreador está conectado

```bash
curl http://localhost:8000/api/conexoes | jq '.'
```

**Esperado**: Deve retornar `"total": 1` e um IMEI

Se não tiver nada conectado: XT40 não está se conectando na porta 8877

---

### 2️⃣ Copiar o IMEI e usar este comando

```bash
# Substitua AQUI pelo IMEI de verdade
# Ex: 358758091234567

IMEI="COPIE_O_IMEI_AQUI"

# Ativar GPS + OBD + intervalo 10s (TUDO DE UMA VEZ)
curl -X POST http://localhost:8000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"
```

---

### 3️⃣ Aguarde 15-20 segundos

O rastreador precisa:
- Receber o comando
- Processar
- Enviar dados de volta

---

### 4️⃣ Verificar se chegou

```bash
IMEI="COPIE_O_IMEI_AQUI"

# Ver últimas localizações
curl http://localhost:8000/api/localizacoes | jq '.' | grep -A 10 latitude

# OU verificar via heartbeat
curl http://localhost:8000/api/heartbeats/$IMEI | jq '.'
```

---

## 🔍 Ver Logs em Tempo Real

Abra **outro terminal** e rode:

```bash
npm start
```

Procure por linhas como:

```
🌍 [GPS] Dados de localização para 358758091234567:
   lat: -23.5505
   lon: -46.6333
   speed: 0
   timestamp: 2025-12-10T14:35:45.000Z
```

Se você vê isso = **GPS FUNCIONANDO!** ✅

---

## ❌ Não Viu os Dados?

### Checklist:

- [ ] Servidor rodando? (`npm start`)
- [ ] XT40 conectado? (`curl http://localhost:8000/api/conexoes`)
- [ ] Enviou comando de init? (`curl ... /init`)
- [ ] Aguardou 20 segundos?
- [ ] Verificou logs? Procure por `🌍 [GPS]`

### Se Ainda Não Funcionar:

1. **Testar comando manualmente**:
```bash
IMEI="seu_imei"
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'
```

2. **Ver resposta do comando**:
```bash
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "STATUS"}'
```

3. **Procurar nos logs por erros**

---

## 📊 Fluxo Visual

```
[Você aqui] →  curl /api/conexoes
                    ↓
             Vejo IMEI do XT40
                    ↓
             curl /api/comandos/$IMEI/init
                    ↓
             [Servidor envia: GPS_ON, OBD_ON, UPLOAD_10S...]
                    ↓
             [XT40 recebe e processa] (2-5 segundos)
                    ↓
             [XT40 começa enviar dados] (próximo intervalo)
                    ↓
             curl /api/localizacoes
                    ↓
          ✅ Vejo latitude, longitude, speed, timestamp
```

---

## 🎬 Próximos Passos

Uma vez que GPS funciona:

1. Mudar para UPLOAD_30S:
```bash
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_30S"}'
```

2. Abrir dashboard em browser:
```
http://localhost:8000
```

3. Ver mapa em tempo real com localização

---

## 💡 Dica Pro

Se quer testar sem carro real:

```bash
# Simular múltiplos comandos em sequência
for i in {1..5}; do
  curl -X POST http://localhost:8000/api/comandos/$IMEI \
    -H "Content-Type: application/json" \
    -d '{"comando": "STATUS"}'
  sleep 2
done
```

---

**Pronto! Você tem tudo que precisa. 🚀**
