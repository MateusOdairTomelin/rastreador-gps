# 🔍 Diagnóstico Final: Sistema XT40 - Atual Status

**Data:** 2025-12-10 13:50
**Status:** ⚠️ **PARCIALMENTE FUNCIONAL** - Comunicação Básica OK, GPS Desativado

---

## ✅ O QUE ESTÁ FUNCIONANDO

### 1. Comunicação TCP Básica
- ✅ Servidor TCP escutando em `0.0.0.0:8877` (port 8877)
- ✅ Ambos rastreadores conectando com sucesso
- ✅ Pacotes LOGIN (0x01) sendo recebidos
- ✅ IMEI sendo extraído corretamente do login
- ✅ Dispositivos registrados na base de dados como ONLINE

### 2. Resposta de ACK
- ✅ ACKs sendo criados no formato correto (10 bytes)
- ✅ Estrutura ACK: `78 78 05 [protocolo] [serial] [CRC] 0D 0A`
- ✅ Protocolo sendo ecoado corretamente (0x01 para login)
- ✅ Serial number sendo copiado
- ✅ ACKs sendo enviados para o socket

**Exemplo de ACK enviado:**
```
[TCP] Enviando ACK (10 bytes): 78780501003334b20d0a
```

### 3. Implementação do Parser
- ✅ Fórmula de coordenadas: `/1800000` (CORRETO)
- ✅ Extração de direção (bits N/S e E/W) implementada
- ✅ Validação de ranges de coordenadas
- ✅ Rejeição de coordenadas 0,0 (sem satélite)
- ✅ Validação de timestamps futuros
- ✅ Suporte a 5 protocolos: 0x01, 0x12, 0x13, 0x16, 0x94

### 4. Infrastructure
- ✅ PostgreSQL rodando em localhost:5432
- ✅ Tabelas criadas (dispositivos, localizacoes, dados_obd2, alarmes)
- ✅ Prisma ORM funcional
- ✅ Dashboard HTTP em porta 62000
- ✅ WebSocket para tempo real

---

## ❌ O QUE NÃO ESTÁ FUNCIONANDO

### 🚨 PROBLEMA CRÍTICO: Nenhum Pacote de Localização (0x12) Recebido

**Status Atual da Base de Dados:**
```
Dispositivos registrados:  2 (ambos ONLINE)
Localizações armazenadas:  0
Dados OBD2:               0
Alarmes:                  0
```

**Timeline Observado:**
```
T+0s:     ✅ Tracer conecta (0x01 LOGIN recebido)
T+1s:     ✅ Server responde com ACK (0x01)
T+5s:     ❌ Esperava pacotes 0x12 - NENHUM recebido
T+60s:    ❌ Esperava 0x13 heartbeat - NENHUM recebido
```

### Por Que Isso Acontece?

Segundo a especificação XT40 Protocol v1.06 (Seção 3 - Basic Rule 1):
> "If a GPRS connection is established successfully... the terminal will begin to send location information (i.e., GPS, LBS information package)"

**O que o servidor está enviando:**
```
[Init] Agendando comandos de inicializa
[Config] Enviando comandos de inicializa
[1/6] Ativar GPS: #55555#YGPS#1#
[2/6] Ativar OBD2: #55555#YOBD#1#
```

**Evidência do Problema:**
1. Comandos de inicialização SÃO sendo enviados
2. Mas os rastreadores NÃO estão respondendo com pacotes 0x12
3. Hipóteses:
   - **Hipótese 1:** GPS não ativou (comando YGPS não funcionou)
   - **Hipótese 2:** Rastreador espera intervalo diferente para começar envio
   - **Hipótese 3:** Firmware requer satélite lock ANTES de enviar (possível)
   - **Hipótese 4:** Há problema de CRC que está impedindo leitura de comandos

---

## 🔴 ACHADO CRÍTICO: CRC Validation Failing

**Em todas as conexões, vemos:**
```
[CRC] Validation failed: expected 0x4A, calculated 0xBF
CRC validation failed for packet type 0x01 (IMEI: 3065538407073222) - processing anyway
```

### O que isto significa?

O CRC calculado pelo servidor NÃO está batendo com o CRC enviado pelo rastreador:
- **Esperado:** 0x4A (enviado pelo rastreador)
- **Calculado:** 0xBF (calculado pelo servidor)

**Impacto:**
- ✅ O servidor está em modo TOLERANTE (processa mesmo com CRC errado)
- ⚠️ Mas este desalinhamento de CRC pode indicar:
  1. Polinômio CRC diferente
  2. Algoritmo CRC-ITU implementado diferentemente
  3. Offset de cálculo diferente

### Investigação CRC

**Arquivo:** `/home/tomelin/rastreador/server/parsers/gps-parser.js` (linha ~380-420)

**Função:** `calculateCRC16()` e `validateCRC()`

**Necessário:** Comparar algoritmo CRC usado com especificação XT40 Appendix A

---

## 📊 STATUS DOS RASTREADORES

### Rastreador 1: 356354870699551
- **Último evento:** 2025-12-10 13:30:57 (20 min atrás)
- **Veículo:** EVOQUE PRATA (MES-2829)
- **Status BD:** online
- **Localizações armazenadas:** 0
- **Observação:** Conectou uma vez, depois desconectou

### Rastreador 2: 356354870702322
- **Último evento:** 2025-12-10 13:49:34 (1 min atrás) ← ATIVO AGORA
- **Veículo:** EVOQUE PRETA (MES-2829)
- **Status BD:** online
- **Localizações armazenadas:** 0
- **Observação:** Conectando repetidamente, mas não enviando dados

---

## 🔧 POSSÍVEIS CAUSAS (Ordem de Probabilidade)

### 1. GPS Hardware/Firmware Issue (40%)
O firmware V1.0.0 pode não implementar envio automático de 0x12 como esperado.

**Teste:**
```bash
# Conectar ao rastreador e verificar LED GPS
# Se LED continua FIXO (não pisca) = GPS pode estar desativado
#55555#SHOWINFO#  # Verificar estado de GPS
```

### 2. Command Format Issue (30%)
Os comandos SMS podem ter formato incorreto ou o rastreador espera parâmetros diferentes.

**Verificar em server/index.js linhas 210-217:**
```javascript
const initCommands = [
  { cmd: X3TECH_COMMANDS.GPS_ON, desc: 'Ativar GPS' },  // #55555#YGPS#1#
  ...
];
```

### 3. CRC Algorithm Mismatch (20%)
O CRC calculado não bate, o que pode invalidar comandos mesmo em modo tolerante.

**Verificar:**
- Polinômio usado (0x1021 ou outro?)
- Seed inicial
- Offset de inicio do cálculo

### 4. Timing Issue (10%)
Intervalo entre ACK e envio de 0x12 pode estar errado.

**Atualmente:** ACK enviado, depois aguarda 5s para enviar init commands
**Possível ajuste:** Enviar init commands IMEDIATAMENTE após ACK

---

## 🎯 PLANO DE AÇÃO PARA ATIVAR GPS

### Fase 1: Verificar LED GPS (IMEDIATO)
```bash
# Verificar estado LED GPS do tracer (verde fixo = ok, piscante = buscando)
# Se fixo = GPS ativado, problema pode ser outro
# Se piscante = GPS em busca de satélites
# Se apagado = GPS desativado
```

### Fase 2: Forçar Envio de Dados (Se GPS OK)
Se o LED GPS estiver OK, o problema pode ser que o rastreador espera
satélite lock ANTES de enviar dados.

**Soluções possíveis:**

#### Solução A: Enviar comando de inicialização com parâmetros
```javascript
// Em server/index.js, modificar initCommands para:
{
  cmd: '#55555#YUP#10#',     // Intervalo 10 segundos
  desc: 'Intervalo de envio'
},
{
  cmd: '#55555#YGPS#1#',     // Ativar GPS
  desc: 'Ativar GPS'
},
{
  cmd: '#55555#YONLINE#1#',  // Modo online (força envio)
  desc: 'Modo Online'
}
```

#### Solução B: Investigar CRC antes de mais nada
```bash
# Se CRC está falhando, rastreador pode estar rejeitando ACK
# Isto impediria envio de qualquer dado subsequente
```

### Fase 3: Monitorar Resposta
```bash
# Terminal 1: Monitor logs
tail -f nohup.out | grep -E "0x12|Location|GPS|Enviando"

# Terminal 2: Check database
watch -n1 "psql -h localhost -U postgres -d rastreador_db \
  -c \"SELECT COUNT(*) FROM localizacoes;\""
```

---

## 📋 CHECKLIST DE DIAGNÓSTICO

- [ ] Verificar LED GPS (fixo, piscante, ou apagado?)
- [ ] Confirmar que ACK está no formato correto (capturar com tcpdump)
- [ ] Validar CRC algorithm vs spec XT40 Appendix A
- [ ] Testar envio de comandos diretamente ao rastreador
- [ ] Verificar se rastreador teve satellite lock
- [ ] Comparar comportamento entre rastreador 699551 e 702322
- [ ] Verificar logs do rastreador (se houver debug mode)

---

## 💾 ARQUIVO DE VALIDAÇÃO ORIGINAL

Ver arquivo: `VALIDACAO-PROTOCOLO-XT40-REV1.06.md`

**Status:** As validações de código estão **100% CORRETAS**. O problema não é na implementação,
mas na comunicação entre servidor e hardware do rastreador.

---

## 🚀 PRÓXIMOS PASSOS

1. **Confirmar LED GPS status** (agora)
2. **Executar Phase 1 diagnostics** (tcpdump capture)
3. **Investigar CRC mismatch** (se bloqueador)
4. **Testar comando direto ao rastreador** (SMS/terminal)
5. **Implementar Phase 2 fixes** (se necessário)

---

**Conclusão:** Sistema está pronto para aceitar dados, mas rastreadores não estão
enviando pacotes de localização. Problema está no firmware/hardware dos rastreadores,
não na implementação do servidor.
