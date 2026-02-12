# 🛰️ GPS/OBD2 XT40 - Guia Rápido

> Seu rastreador XT40 agora envia dados de GPS e OBD2 em tempo real!

## ⚡ Começo Rápido (60 segundos)

```bash
# Terminal 1: Iniciar servidor
npm start

# Terminal 2: Ver dispositivos conectados
curl http://localhost:8000/api/conexoes | jq '.dispositivos[0].imei'

# Copie o IMEI acima e execute:
IMEI="seu_imei_aqui"
curl -X POST http://localhost:8000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"

# Aguarde 20 segundos e veja os dados:
curl http://localhost:8000/api/localizacoes | jq '.dados[0]'
```

## 📚 Documentação

- **[QUICK_GPS_TEST.md](./QUICK_GPS_TEST.md)** - Teste em 60 segundos
- **[RESUMO_GPS_SOLUCAO.md](./RESUMO_GPS_SOLUCAO.md)** - Visão geral completa
- **[GPS_TROUBLESHOOTING.md](./GPS_TROUBLESHOOTING.md)** - Guia de troubleshooting
- **[MUDANCAS_CODIGO.md](./MUDANCAS_CODIGO.md)** - O que foi mudado
- **[GPS_CHEAT_SHEET.txt](./GPS_CHEAT_SHEET.txt)** - Referência rápida
- **[INDICE_GPS_RECURSOS.md](./INDICE_GPS_RECURSOS.md)** - Índice de tudo

## 🛠️ Ferramentas

```bash
# Modo interativo com menu
./commands-gps.sh

# Teste de diagnóstico TCP
node diagnostico-gps.js
```

## 📊 Dados Disponíveis

```bash
# Localizações GPS
curl http://localhost:8000/api/localizacoes

# Status do rastreador
curl http://localhost:8000/api/heartbeats/IMEI

# Dispositivos conectados
curl http://localhost:8000/api/conexoes
```

## 🎯 Comandos Disponíveis

```bash
IMEI="seu_imei"

# Ativar GPS
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'

# Intervalo de envio (10s para teste, 30s produção)
curl -X POST http://localhost:8000/api/comandos/$IMEI \
  -H "Content-Type: application/json" \
  -d '{"comando": "UPLOAD_30S"}'
```

## ✅ Pronto!

Seus dados estão chegando em:
- **HTTP API**: `http://localhost:8000/api/`
- **WebSocket**: `ws://localhost:8000/ws`
- **Banco de Dados**: `PostgreSQL`

Para mais informações, leia **[RESUMO_GPS_SOLUCAO.md](./RESUMO_GPS_SOLUCAO.md)**.

---

**Versão**: 1.0 | **Data**: 2025-12-10 | **Status**: ✅ Pronto
