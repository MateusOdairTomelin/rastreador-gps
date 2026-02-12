# 🔍 Validar IMEI - Diagnóstico Completo

## O Que Você Quer Saber
1. ✅ O IMEI está correto?
2. ✅ O rastreador está enviando dados com IMEI certo?
3. ✅ Os dados estão sendo salvos com IMEI correto no banco?
4. ✅ O IMEI está sendo rastreado corretamente?

---

## 📋 Passo 1: Ver o IMEI do Seu Rastreador

### Opção A: Olhar Fisicamente no Dispositivo
- O IMEI está impresso em algum lugar do XT40
- Geralmente tem 15 dígitos: `358758091234567`
- Anote este número

### Opção B: Ver no Dashboard Web
```
http://localhost:62000
# Procurar por "Dispositivos" ou "Rastreadores"
# Lá mostra o IMEI registrado
```

### Opção C: Ver nos Logs do Servidor
```bash
npm start 2>&1 | grep "IMEI"

# Você verá algo como:
# [TCP] IMEI extracted: 358758091234567
# [TCP] IMEI registrado para sessão: 358758091234567
```

---

## 🔧 Passo 2: Validar Se IMEI Está Correto (Formato)

### Regra: IMEI Sempre 15 Dígitos

```bash
# Seu IMEI
IMEI="358758091234567"

# Contar os dígitos
echo $IMEI | wc -c
# Deve retornar: 16 (inclui quebra de linha)
# Então são 15 dígitos ✅

# Verificar se tem só números
echo $IMEI | grep -E '^[0-9]{15}$'
# Se retornar o IMEI = ✅ válido
# Se não retornar nada = ❌ inválido
```

---

## 📡 Passo 3: Ver Se Rastreador Está Enviando IMEI Correto

### Terminal 1: Rodar Servidor Com Debug
```bash
npm start 2>&1 | grep -E "(IMEI|extracted|registrado)"
```

### Terminal 2: Conectar Rastreador
- Ligar o XT40 ou fazer ele se conectar

### Terminal 1: Ver Logs
Procure por mensagens como:
```
[TCP] Cliente conectado: 192.168.x.x:xxxxx

[TCP] Dados recebidos (12 bytes): 7878010D358758091234567AABBCCDD0D0A
                                      ↑ IMEI começando aqui

[TCP] IMEI extracted: 358758091234567
      ↑ IMEI detectado corretamente!

[TCP] IMEI registrado para sessão: 358758091234567
💓 [Heartbeat] #1 from 358758091234567
[TCP] IMEI extraído para login: 358758091234567
✅ [Login] Device 358758091234567 connected
```

Se vir o IMEI correto = ✅ **Rastreador enviando IMEI certo**

---

## 💾 Passo 4: Validar Se IMEI Está Correto no Banco de Dados

### Ver Dispositivos Cadastrados
```bash
curl http://localhost:62000/api/dispositivos | jq '.dados[] | {imei, tipo, status}'
```

**Output esperado**:
```json
{
  "imei": "358758091234567",
  "tipo": "XT40_OBD2",
  "status": "online"
}
```

Se vir seu IMEI = ✅ **Banco de dados tem IMEI correto**

### Ver Localizações Associadas ao IMEI
```bash
IMEI="358758091234567"

curl http://localhost:62000/api/localizacoes | \
  jq ".dados[] | select(.dispositivo.imei == \"$IMEI\") | {imei: .dispositivo.imei, lat: .latitude, lon: .longitude}"
```

**Output esperado**:
```json
{
  "imei": "358758091234567",
  "lat": -23.5505,
  "lon": -46.6333
}
```

Se vir = ✅ **Localização associada ao IMEI certo**

---

## 🗄️ Passo 5: Consultar Diretamente o Banco de Dados

### Conectar ao PostgreSQL
```bash
psql -U postgres -d rastreador_db -h localhost
```

### Ver Dispositivos
```sql
SELECT imei, tipo, status, ultima_conexao FROM dispositivo ORDER BY updated_at DESC;
```

**Output esperado**:
```
       imei        |    tipo    | status |        ultima_conexao
--------------------+------------+--------+---------------------------
 358758091234567    | XT40_OBD2  | online | 2025-12-10 14:35:45
```

Se vir seu IMEI = ✅ **Dispositivo registrado corretamente**

### Ver Localizações Deste IMEI
```sql
SELECT l.latitude, l.longitude, l.velocidade, l.timestamp, d.imei
FROM localizacao l
JOIN dispositivo d ON l.dispositivo_id = d.id
WHERE d.imei = '358758091234567'
ORDER BY l.timestamp DESC
LIMIT 5;
```

**Output esperado**:
```
 latitude | longitude | velocidade |         timestamp
----------+-----------+------------+---------------------------
-23.55050 | -46.63330 |          0 | 2025-12-10 14:35:45
-23.55051 | -46.63331 |          5 | 2025-12-10 14:35:15
```

Se vir dados = ✅ **Localizações salvando com IMEI correto**

---

## 🎯 Passo 6: Teste Completo de Fluxo do IMEI

### Criar Script de Validação
```bash
#!/bin/bash
# Salve como: validar-imei.sh

IMEI="358758091234567"

echo "🔍 Validando IMEI: $IMEI"
echo ""

# 1. Verificar formato
echo "1️⃣ Verificando formato..."
if echo $IMEI | grep -qE '^[0-9]{15}$'; then
  echo "  ✅ IMEI tem 15 dígitos"
else
  echo "  ❌ IMEI inválido"
  exit 1
fi

# 2. Verificar se está conectado
echo ""
echo "2️⃣ Verificando se dispositivo está conectado..."
response=$(curl -s http://localhost:62000/api/conexoes)
if echo "$response" | jq -e ".dispositivos[] | select(.imei == \"$IMEI\")" >/dev/null 2>&1; then
  echo "  ✅ Dispositivo conectado"
else
  echo "  ❌ Dispositivo NÃO está conectado"
  exit 1
fi

# 3. Verificar se tem heartbeat
echo ""
echo "3️⃣ Verificando heartbeat..."
response=$(curl -s http://localhost:62000/api/heartbeats/$IMEI)
if echo "$response" | jq -e '.dados.count' >/dev/null 2>&1; then
  count=$(echo "$response" | jq -r '.dados.count')
  echo "  ✅ Heartbeat recebido ($count vezes)"
else
  echo "  ❌ Nenhum heartbeat"
  exit 1
fi

# 4. Verificar se tem localizações
echo ""
echo "4️⃣ Verificando localizações..."
response=$(curl -s http://localhost:62000/api/localizacoes)
total=$(echo "$response" | jq '.total')
if [ "$total" -gt 0 ]; then
  echo "  ✅ Total de localizações: $total"

  # Mostrar última
  lat=$(echo "$response" | jq -r '.dados[0].latitude')
  lon=$(echo "$response" | jq -r '.dados[0].longitude')
  echo "  Última localização: ($lat, $lon)"
else
  echo "  ⚠️ Nenhuma localização ainda"
fi

echo ""
echo "✅ Validação completa!"
```

Use:
```bash
chmod +x validar-imei.sh
./validar-imei.sh
```

---

## 📊 Checklist Completo de Validação

### IMEI Básico
- [ ] IMEI tem 15 dígitos
- [ ] IMEI só contém números
- [ ] Anotei o IMEI do dispositivo físico

### Comunicação
- [ ] Rastreador se conecta na porta 8877
- [ ] Logs mostram IMEI extraído corretamente
- [ ] Servidor não mostra erros ao receber IMEI

### Banco de Dados
- [ ] IMEI está na tabela `dispositivo`
- [ ] Tipo é `XT40_OBD2`
- [ ] Status é `online` (quando conectado)
- [ ] `ultima_conexao` é recente

### Dados Associados
- [ ] Localizações têm o IMEI correto associado
- [ ] OBD2 tem o IMEI correto associado
- [ ] Heartbeat mostra o IMEI correto
- [ ] Timestamps estão em UTC

---

## 🔴 Se Algo Estiver Errado

### Problema: IMEI No Logs Diferente do Físico
```
Físico: 358758091234567
Log:    3587580912345670 (extra zero)
```

**Causas possíveis**:
1. Rastreador enviando IMEI errado (problema no firmware)
2. Parser GT06 não extraindo corretamente
3. Conversão BCD incorreta

**Solução**:
- Ver arquivo `server/parsers/gps-parser.js` linha 105
- Função `bcdToString()` pode estar com problema

### Problema: IMEI Não Aparece nos Logs
```
Conectado mas sem mensagem "[TCP] IMEI extracted"
```

**Causas possíveis**:
1. Rastreador não enviando packet de login (0x01)
2. Conexão apenas heartbeat, sem dados completos

**Solução**:
- Rodar comando: `DIAG_ON` para forçar diagnóstico
- Usar `diagnostico-gps.js` para ver exatamente o que chega

### Problema: IMEI Diferente em Cada Conexão
```
Conexão 1: 358758091234567
Conexão 2: 358758091234568 (último dígito diferente)
```

**Causa**: Rastreador enviando IMEI errado ou tendo problema de comunicação

**Solução**:
- Reiniciar XT40
- Verificar se está com bateria baixa
- Testar em outro local (pode ser interferência de sinal)

---

## 📈 Ver Histórico de Todos os IMEIs Conectados

### Ver Últimas Conexões
```bash
curl http://localhost:62000/api/conexoes | jq '.dispositivos[] | .imei'
```

### Ver Todos no Banco
```bash
# Via SQL
psql -U postgres -d rastreador_db -c \
  "SELECT DISTINCT imei FROM dispositivo;"
```

### Ver Quem Enviou Localizações Hoje
```bash
psql -U postgres -d rastreador_db -c \
  "SELECT DISTINCT d.imei, COUNT(l.id) as total
   FROM dispositivo d
   LEFT JOIN localizacao l ON d.id = l.dispositivo_id
   WHERE l.timestamp > NOW() - INTERVAL '24 hours'
   GROUP BY d.imei
   ORDER BY total DESC;"
```

---

## 🎯 Resumo: Como Validar IMEI

| Passo | O Que Fazer | Comando |
|-------|------------|---------|
| 1 | Ver IMEI físico | Olhar no dispositivo |
| 2 | Validar formato | `echo $IMEI \| grep -E '^[0-9]{15}$'` |
| 3 | Ver em logs | `npm start \| grep IMEI` |
| 4 | Ver no banco | `curl .../api/dispositivos` |
| 5 | Ver localizações | `curl .../api/localizacoes` |
| 6 | Ver no PostgreSQL | `psql ... SELECT ... FROM dispositivo` |

---

## ✅ Quando IMEI Está 100% Correto

Você verá:
```
✅ IMEI tem 15 dígitos
✅ Logs mostram IMEI extraído
✅ Banco tem dispositivo com este IMEI
✅ Localizações associadas ao IMEI
✅ Heartbeat mostra IMEI correto
✅ Dashboard mostra rastreador ativo
```

Quando tudo estiver verde = **IMEI VALIDADO!** 🎉

---

## 🔗 Relacionado

- Ver: `GPS_TROUBLESHOOTING.md` para mais debug
- Ver: `MUDANCAS_CODIGO.md` para entender parsing
- Ver: `server/parsers/gps-parser.js` para logic do IMEI

---

**Data**: 2025-12-10
**Status**: Pronto para usar
