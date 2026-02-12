# 🎯 Como Testar Seu Projeto - Guia Prático

Você perguntou: **"Como testar? Minha aplicação roda na porta 62000 e 8877, como vou testar localhost:8000?"**

## ✅ Resposta: Suas Portas Já Estão Configuradas!

- **HTTP/API**: Porta `62000` ✅
- **TCP Rastreador**: Porta `8877` ✅
- **Todas as URLs** usam `localhost:62000`

Tudo já está ajustado para suas portas!

---

## 🚀 Teste Rápido (3 Passos)

### Passo 1: Iniciar Servidor
```bash
npm start

# Você verá:
# 🚗 Servidor TCP (Rastreador) escutando em 0.0.0.0:8877
# ✅ Servidor HTTP/WebSocket rodando
# 📱 Acesse em: http://localhost:62000    ← PORTA 62000!
```

### Passo 2: Validar IMEI (Automático)
```bash
./validar-imei.sh

# Script faz tudo:
# ✓ Descobre IMEI automaticamente
# ✓ Valida se está conectado
# ✓ Verifica heartbeat
# ✓ Verifica localizações
# ✓ Mostra relatório completo
```

### Passo 3: Ver Dados
Se validação passou, seus dados estão em:
```
http://localhost:62000/api/localizacoes
http://localhost:62000/api/heartbeats
```

---

## 🛠️ 3 Scripts Prontos Para Você Usar

### 1️⃣ Validar IMEI (Recomendado - Comece Aqui!)
```bash
./validar-imei.sh

# Faz tudo automaticamente:
# - Descobre IMEI
# - Valida formato (15 dígitos)
# - Verifica conexão
# - Verifica heartbeat
# - Verifica localizações
# - Verifica banco de dados
# - Mostra relatório visual
```

**Quando usar**: Toda vez que quiser saber se tudo está funcionando

---

### 2️⃣ Teste Automático GPS
```bash
./teste-gps-automatico.sh

# Faz tudo em sequência:
# - Conecta ao servidor
# - Descobri IMEI
# - Envia GPS_ON + OBD_ON + UPLOAD_10S
# - Aguarda 20 segundos
# - Verifica se dados chegaram
# - Mostra resultado visual
```

**Quando usar**: Para teste completo do sistema

---

### 3️⃣ Menu Interativo de Comandos
```bash
./commands-gps.sh

# Menu colorido com opções:
# 1) Listar dispositivos
# 2) Enviar GPS_ON
# 3) Enviar OBD_ON
# 4) Mudar intervalo
# 5) Enviar init
# 6) Ver status
# 7) Ver localizações
# 8) Ver comandos disponíveis
```

**Quando usar**: Para controlar manualmente o rastreador

---

## 📋 Teste Completo Passo a Passo

### Terminal 1: Iniciar Servidor
```bash
cd /home/tomelin/rastreador
npm start

# Espere ver:
# 🚗 Servidor TCP... 8877
# ✅ Servidor HTTP... 62000
```

### Terminal 2: Validar IMEI
```bash
cd /home/tomelin/rastreador
./validar-imei.sh

# Você verá:
# ✓ IMEI tem 15 dígitos
# ✓ Servidor respondendo
# ✓ Dispositivo conectado
# ✓ Heartbeat recebido
# ✓ Localizações encontradas
# ✓ Banco de dados OK
#
# → IMEI VALIDADO COM SUCESSO!
```

### Terminal 2: Ver Dados em Tempo Real
```bash
# Atualizar a cada 2 segundos
watch -n 2 'curl -s http://localhost:62000/api/localizacoes | jq ".total"'

# Ou ver última localização
curl http://localhost:62000/api/localizacoes | jq '.dados[0]'

# Output esperado:
# {
#   "latitude": -23.5505,
#   "longitude": -46.6333,
#   "velocidade": 0,
#   "timestamp": "2025-12-10T14:35:45.000Z"
# }
```

---

## 🎯 Validar IMEI - 3 Formas

### Forma 1: Script Automático (Fácil!)
```bash
./validar-imei.sh
# Valida tudo automaticamente
```

### Forma 2: Command Line (Controle Total)
```bash
IMEI="358758091234567"

# Ver se está conectado
curl http://localhost:62000/api/conexoes | jq ".dispositivos[] | select(.imei == \"$IMEI\")"

# Ver heartbeat
curl http://localhost:62000/api/heartbeats/$IMEI | jq '.'

# Ver localizações
curl http://localhost:62000/api/localizacoes | jq '.dados[0]'
```

### Forma 3: Banco de Dados Direto
```bash
# Conectar ao PostgreSQL
psql -U postgres -d rastreador_db

# Ver dispositivos
SELECT imei, tipo, status FROM dispositivo;

# Ver localizações
SELECT d.imei, l.latitude, l.longitude, l.timestamp
FROM dispositivo d
LEFT JOIN localizacao l ON d.id = l.dispositivo_id
ORDER BY l.timestamp DESC LIMIT 10;
```

---

## 🔍 O Que Validar do IMEI

### ✅ Validação 1: Formato
```bash
# IMEI deve ter 15 dígitos e apenas números
echo "358758091234567" | grep -E '^[0-9]{15}$'
# Se retornar o IMEI = válido ✅
```

### ✅ Validação 2: Conectado
```bash
# Deve aparecer em /api/conexoes
curl http://localhost:62000/api/conexoes | jq '.dispositivos[].imei'
```

### ✅ Validação 3: Enviando Heartbeat
```bash
# Deve ter count > 0
curl http://localhost:62000/api/heartbeats/358758091234567 | jq '.dados.count'
```

### ✅ Validação 4: Enviando Localização
```bash
# Deve ter latitude e longitude
curl http://localhost:62000/api/localizacoes | jq '.dados[0] | {lat: .latitude, lon: .longitude}'
```

### ✅ Validação 5: No Banco de Dados
```bash
# Deve estar registrado
psql -U postgres -d rastreador_db -c \
  "SELECT imei, tipo, status FROM dispositivo WHERE imei = '358758091234567';"
```

---

## 📊 Exemplo de Saída Esperada

### Validar IMEI - Sucesso ✅
```
═══════════════════════════════════════════════════════
  VALIDAÇÃO DE IMEI - XT40
═══════════════════════════════════════════════════════

ℹ Teste 1: Validar Formato do IMEI
  IMEI: 358758091234567
✓ IMEI tem 15 dígitos
✓ IMEI contém apenas números

ℹ Teste 2: Conectividade com Servidor
✓ Servidor respondendo em http://localhost:62000/api

ℹ Teste 3: Verificar Se Dispositivo Está Conectado
✓ Dispositivo conectado em 192.168.1.100:52847

ℹ Teste 4: Verificar Heartbeat
✓ Heartbeat recebido (47 vezes)
  Status: connected
  Última conexão: 2025-12-10T14:35:45.000Z

ℹ Teste 5: Verificar Localizações GPS
✓ Localização encontrada para este IMEI
  Latitude: -23.5505
  Longitude: -46.6333
  Velocidade: 0 km/h
  Timestamp: 2025-12-10T14:35:45.000Z

ℹ Teste 6: Verificar Banco de Dados
✓ Dispositivo registrado no banco de dados
  Tipo: XT40_OBD2
  Status: online
  Última conexão: 2025-12-10T14:35:50.000Z

═══════════════════════════════════════════════════════
RESULTADO DA VALIDAÇÃO
═══════════════════════════════════════════════════════

Testes passados: 6
Testes falhados: 0

✓ IMEI VALIDADO COM SUCESSO!

O IMEI 358758091234567 está:
  ✅ Com formato correto
  ✅ Conectado ao servidor
  ✅ Enviando heartbeat
  ✅ Enviando localizações

Próximos passos:
  1. Rodar: npm start (se não estiver)
  2. Ativar GPS: ./commands-gps.sh
  3. Ver dashboard: http://localhost:62000
```

---

## ❌ Se Falhar - O Que Fazer

### Erro: "Nenhum dispositivo conectado"
```bash
# Motivo: XT40 não conectou na porta 8877

# Solução:
# 1. Verificar se porta 8877 está aberta
netstat -tlnp | grep 8877

# 2. Verificar IP/Porta do XT40
# 3. Ligar o XT40 de novo
# 4. Ver logs do servidor: npm start
```

### Erro: "Heartbeat não encontrado"
```bash
# Motivo: XT40 conectou mas não enviou login packet

# Solução:
# 1. Reiniciar XT40
# 2. Aguardar conexão completar
# 3. Ver logs: procurar por "IMEI extracted"
```

### Erro: "Nenhuma localização"
```bash
# Motivo: GPS não foi ativado ou sem sinal

# Solução:
# 1. Enviar comando GPS_ON
./commands-gps.sh

# 2. Colocar perto de janela (GPS precisa de sinal)
# 3. Aguardar 30 segundos
# 4. Tentar novamente
```

---

## 📚 Documentação Relacionada

| Arquivo | Para Quê |
|---------|----------|
| `TESTE_SUAS_PORTAS.md` | Instruções com suas portas (62000, 8877) |
| `VALIDAR_IMEI.md` | Guia completo de validação |
| `QUICK_GPS_TEST.md` | Teste rápido |
| `RESUMO_GPS_SOLUCAO.md` | Visão geral |
| `GPS_TROUBLESHOOTING.md` | Se tiver problemas |

---

## 🎯 Resumo Visual

```
        Terminal 1                    Terminal 2
        ──────────                    ──────────

        npm start                     ./validar-imei.sh
            ↓                              ↓
    🚗 Servidor rodando          Teste 1: Formato IMEI ✓
    🔌 Porta 8877 (TCP)          Teste 2: Servidor ✓
    📱 Porta 62000 (HTTP)         Teste 3: Conectado ✓
                                  Teste 4: Heartbeat ✓
                                  Teste 5: Localização ✓
                                  Teste 6: Banco de Dados ✓

                                  → VALIDADO COM SUCESSO! ✅
```

---

## 🚀 Checklist Final

- [ ] `npm start` rodando sem erros
- [ ] Ver em logs: "🚗 Servidor TCP... 8877"
- [ ] Ver em logs: "📱 Acesse em: http://localhost:62000"
- [ ] Rodar: `./validar-imei.sh`
- [ ] Ver resultado: IMEI VALIDADO COM SUCESSO!
- [ ] Acessar: http://localhost:62000/api/localizacoes
- [ ] Ver latitude e longitude nos dados

Quando todos estiverem ✅ = **Seu projeto está funcionando!** 🎉

---

**Suas portas**: 62000 (HTTP) e 8877 (TCP) ✅
**Status**: Pronto para testar
**Data**: 2025-12-10
