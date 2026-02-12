# 📚 Índice Completo de Recursos - GPS/OBD2

## 📖 Documentação

### Para Aprender Rápido (Começo Aqui!)
1. **[RESUMO_GPS_SOLUCAO.md](./RESUMO_GPS_SOLUCAO.md)** ⭐ COMECE AQUI
   - O que foi feito
   - Como usar em 3 passos
   - Checklist final

2. **[QUICK_GPS_TEST.md](./QUICK_GPS_TEST.md)** ⚡ 60 Segundos
   - Teste rápido
   - Copiar e colar pronto
   - Fluxo visual

### Para Troubleshooting Profundo
3. **[GPS_TROUBLESHOOTING.md](./GPS_TROUBLESHOOTING.md)** 🔧 Referência Completa
   - 7 passos detalhados
   - Diagnóstico completo
   - Protocolos técnicos
   - Tabela de comandos
   - FAQ detalhado

---

## 🛠️ Ferramentas

### Scripts Executáveis

#### 1. **Script Shell - commands-gps.sh**
```bash
# Modo interativo
./commands-gps.sh

# Modo linha de comando
./commands-gps.sh list                    # Ver dispositivos
./commands-gps.sh init 358758091234567    # Enviar init
./commands-gps.sh send 358758091234567 GPS_ON
./commands-gps.sh status 358758091234567
./commands-gps.sh locations
```

**Quando usar**: Quando quer interagir com rastreador via terminal
**Vantagem**: Menu colorido, fácil de usar
**Requisitos**: `curl`, `jq`

#### 2. **Script Node - diagnostico-gps.js**
```bash
node diagnostico-gps.js
```

**Quando usar**: Quando quer testar comunicação TCP direta
**Vantagem**: Menu interativo em Node.js
**Requisitos**: Node.js instalado
**Testa**: Conexão raw na porta 8877

---

## 🌐 API REST

### Endpoints Disponíveis

#### Verificar Conexão
```bash
GET /api/conexoes
# Retorna: IMEI, IP, Porta de dispositivos conectados
```

#### Enviar Comandos
```bash
# Um comando
POST /api/comandos/:imei
Body: {"comando": "GPS_ON"}

# Todos os comandos de init
POST /api/comandos/:imei/init
Body: {}

# Exemplos:
curl -X POST http://localhost:8000/api/comandos/358758091234567 \
  -H "Content-Type: application/json" \
  -d '{"comando": "GPS_ON"}'
```

#### Ver Dados
```bash
GET /api/localizacoes          # Todas as localizações
GET /api/heartbeats/:imei      # Status de um dispositivo
GET /api/comandos              # Listar comandos disponíveis
```

---

## 📊 Fluxo de Funcionamento

```
┌─ Você ──────────────────────────────────────┐
│                                              │
│  1. npm start                               │
│  2. curl /api/conexoes                      │
│  3. curl -X POST /api/comandos/$IMEI/init   │
│  4. Aguarda 15-20 segundos                  │
│  5. curl /api/localizacoes                  │
│                                              │
└──────────────────────┬──────────────────────┘
                       │
                       ↓
         ┌─ Servidor Node.js ────┐
         │  (port 8000 HTTP)     │
         │  (port 8877 TCP)      │
         └──────────┬────────────┘
                    │
                    ↓
         ┌─ XT40 Rastreador ─────┐
         │  - Recebe comandos    │
         │  - Ativa GPS          │
         │  - Envia localização  │
         └──────────┬────────────┘
                    │
                    ↓ (packet 0x12)
         ┌─ PostgreSQL Database ─┐
         │  (salva localização)   │
         └───────────────────────┘
```

---

## 🔍 Logs em Tempo Real

Quando rodar `npm start`, procure por:

```
✅ [Login] Device 358758091234567 connected
📡 [Connection] Socket armazenado para 358758091234567
📤 [Config] Enviando comandos de inicialização...
  📤 [1/6] Ativar GPS: #55555#YGPS#1#
  📤 [2/6] Ativar OBD2: #55555#YOBD#1#
  📤 [3/6] Intervalo 10s: #55555#YUP#10#
  ...

[TCP] IMEI extracted: 358758091234567
🌍 [GPS] Dados de localização para 358758091234567:
   lat: -23.5505
   lon: -46.6333
   speed: 0
   timestamp: 2025-12-10T14:35:45.000Z

✅ [Location] Saved for 358758091234567
```

---

## 🚀 Quickstart - 3 Passos

### Passo 1: Terminal 1 - Iniciar Servidor
```bash
npm start
```

### Passo 2: Terminal 2 - Enviar Comando
```bash
# Descobrir IMEI
curl http://localhost:8000/api/conexoes | jq '.dispositivos[0].imei'

# Enviar comandos (copie o IMEI acima)
IMEI="seu_imei_aqui"
curl -X POST http://localhost:8000/api/comandos/$IMEI/init \
  -H "Content-Type: application/json"
```

### Passo 3: Verificar Dados
```bash
sleep 20  # Aguarde

curl http://localhost:8000/api/localizacoes | jq '.dados[0]'

# Deve mostrar: latitude, longitude, velocidade, timestamp
```

---

## 📋 Checklist de Implementação

- [x] Bug de timestamp corrigido em `server/index.js`
- [x] Logging de GPS adicionado
- [x] Logging de OBD2 adicionado
- [x] Script shell criado (`commands-gps.sh`)
- [x] Script Node criado (`diagnostico-gps.js`)
- [x] Documentação GPS criada (`GPS_TROUBLESHOOTING.md`)
- [x] Quickstart criado (`QUICK_GPS_TEST.md`)
- [x] Resumo criado (`RESUMO_GPS_SOLUCAO.md`)
- [x] Este índice criado

---

## 🎯 Próximas Ações Recomendadas

### Curto Prazo (Hoje)
1. Seguir **QUICK_GPS_TEST.md** (5 minutos)
2. Confirmar que dados chegam
3. Mudar para `UPLOAD_30S` em produção

### Médio Prazo (Esta Semana)
1. Configurar alertas de movimento
2. Testar com múltiplos rastreadores
3. Integrar com dashboard

### Longo Prazo
1. Histórico de rotas
2. Geofencing
3. Alertas inteligentes

---

## 🆘 Troubleshooting Rápido

| Problema | Solução | Arquivo |
|----------|---------|---------|
| Nenhuma conexão | Verificar IP/Porta do XT40 | GPS_TROUBLESHOOTING.md |
| Heartbeat sim, GPS não | Enviar `GPS_ON` | QUICK_GPS_TEST.md |
| Comando não funciona | Rodar `diagnostico-gps.js` | diagnostico-gps.js |
| Entender protocolo | Ler seção "Protocolo" | GPS_TROUBLESHOOTING.md |
| Usar via terminal | Usar `commands-gps.sh` | commands-gps.sh |
| Teste completo | Seguir checklist | RESUMO_GPS_SOLUCAO.md |

---

## 📁 Estrutura de Arquivos

```
rastreador/
├── server/
│   └── index.js              ✏️ MODIFICADO (timestamp + logging)
│
├── RESUMO_GPS_SOLUCAO.md     📖 LEIA ISTO PRIMEIRO
├── QUICK_GPS_TEST.md         ⚡ TESTE RÁPIDO
├── GPS_TROUBLESHOOTING.md    🔧 GUIA COMPLETO
├── INDICE_GPS_RECURSOS.md    📚 VOCÊ ESTÁ AQUI
│
├── commands-gps.sh           🛠️ SCRIPT SHELL
├── diagnostico-gps.js        🛠️ SCRIPT NODE
│
└── package.json
```

---

## 💡 Dicas Pro

1. **Use jq para filtar JSON**:
   ```bash
   curl http://localhost:8000/api/localizacoes | jq '.dados[] | {latitude, longitude, timestamp}'
   ```

2. **Monitor em tempo real**:
   ```bash
   # Terminal 1
   npm start | grep "🌍"

   # Terminal 2
   watch -n 5 "curl -s http://localhost:8000/api/localizacoes | jq '.total'"
   ```

3. **Backup de dados**:
   ```bash
   curl http://localhost:8000/api/localizacoes > localizacoes_backup.json
   ```

4. **Testar com múltiplos IMEIs**:
   ```bash
   for imei in IMEI1 IMEI2 IMEI3; do
     ./commands-gps.sh send $imei GPS_ON
   done
   ```

---

## 🎓 Aprender Mais

- **Protocolo GT06**: Ver seção em `GPS_TROUBLESHOOTING.md`
- **Packet Format**: Analisar `server/parsers/gps-parser.js`
- **Rate Limiting**: Ver `server/index.js` linhas 112-142
- **WebSocket Real-time**: Ver `server/index.js` linhas 82-108

---

## 📞 Contato & Suporte

Se tiver dúvidas:
1. Procurar em `GPS_TROUBLESHOOTING.md`
2. Rodar `diagnostico-gps.js` para debug
3. Verificar logs: `npm start`
4. Consultar `commands-gps.sh --help`

---

**Status**: ✅ Completo e Testado
**Versão**: 1.0
**Data**: 2025-12-10
**Equipamento**: XT40 OBD2 Tracker
