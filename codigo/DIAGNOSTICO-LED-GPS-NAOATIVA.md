# 🔴 Diagnóstico: LED GPS Fixo + Comando YGPS Não Funciona

## Status Observado
```
LED GPS:      🔴 FIXO (não está piscando) = GPS OFF
LED Rede:     🔵 PISCANDO AZUL = Rede OK, conectado
Comando:      #55555#YGPS#1# NÃO FUNCIONA
```

## Análise

### O que LED GPS FIXO significa?
- GPS está DESATIVADO ou não respondendo
- Luz fixa = sem atividade
- Deveria piscar após ativar GPS

### Por que YGPS#1# não funciona?

**Possível Causa 1: Device em Sleep Mode (Provável 70%)**
- SHOWINFO mostra `SLEEP: SLPOFF<60>` - mas pode ainda estar em micro-sleep
- Dispositivo não processa comandos durante sleep, mesmo em modo parcial
- **Solução:** Enviar WAKE command ANTES de YGPS

**Possível Causa 2: Firmware Bug ou Comando Rejeição (20%)**
- V1.0.0 build 250120.093957 pode ter issue com YGPS parsing
- Dispositivo só processa alguns comandos (YVERSION, SHOWINFO funcionam)
- Outros comandos como YUP#10#, YGPS#1# podem estar bugados

**Possível Causa 3: Sistema Precisa Reiniciar (10%)**
- Mudanças de configuração só aplicam após RSTSYS
- GPS pode estar "frozen" no firmware e precisa reset

---

## ✅ Sequência de Ativação - TESTAR AGORA

**IMPORTANTE:** Execute os comandos na SEQUÊNCIA abaixo. Aguarde 5-10 segundos entre cada um.

### Passo 1: Forçar Wake (desperta completo)
```
#55555#WAKE,1#
```
**Esperado:** Nada visível na interface (wake é silencioso)
**Verify:** LED rede pode piscar mais rápido

### Passo 2: Desabilitar Todos Sleep Modes
```
#55555#SLPOFF#
```
**Esperado:** Confirmação (silent command)

### Passo 3: Ativar GPS
```
#55555#YGPS#1#
```
**OBSERVAR LED GPS IMEDIATAMENTE:**
- ✅ LED GPS começa a PISCAR VERDE = GPS está buscando satélites (FUNCIONOU!)
- ❌ LED GPS continua FIXO = Comando ainda não funciona

### Passo 4: Reiniciar Sistema (se LED GPS ainda fixo)
```
#55555#RSTSYS#
```
**Esperado:** Rastreador reinicia, LEDs piscam, volta ao normal (30-45 segundos)
**Após restart:** Verifique se LED GPS agora pisca verde

### Passo 5: Verificar Configuração
```
#55555#SHOWINFO#
```
**Aguarde resposta e check se:**
```
TIMER: 60    ← mudou para 10?
SLEEP: SLPOFF<60>  ← aparece?
```

---

## 🎯 Timeline Esperada

| Tempo | Ação | Observação |
|-------|------|-----------|
| T+0s  | Enviar WAKE,1 | Silent |
| T+5s  | Enviar SLPOFF | Silent |
| T+10s | Enviar YGPS#1 | **WATCH LED GPS** |
| T+15s | Se falhou: RSTSYS | Aguarde restart 30s |
| T+50s | Enviar SHOWINFO | Verifica se mudanças aplicadas |

---

## 📊 Resultados Possíveis

### Cenário A: ✅ LED GPS pisca VERDE (Melhor Caso)
```
Resultado: GPS ATIVADO COM SUCESSO!
Próximo: Aguardar 1-2 minutos para satélites se conectarem
         Depois enviar SHOWINFO novamente
         Server deve receber packets 0x12 (Location)
Ação: Monitorar nohup.out para [Location] messages
```

### Cenário B: ❌ LED GPS continua FIXO (Sleep Issue)
```
Resultado: Device em Sleep profundo, não responde
Solução:
  1. Enviar #55555#SLPOFF# (desabilita sleep completamente)
  2. Desconectar e reconectar bateria/USB (hard reset)
  3. Tentar novamente YGPS#1#
```

### Cenário C: ❌ LED GPS continua FIXO (Firmware Bug)
```
Resultado: Comando YGPS não é reconhecido pelo V1.0.0
Possibilidade: Versão firmware tem issue com GPS activation
Solução:
  1. Verificar se existe firmware update disponível
  2. Alternative: Tentar comando #55555#YOBD#1# (ativa OBD2)
     para confirmar se OU comandos em geral estão bugados
  3. Se nenhum comando Y* funciona: Device precisa upgrade/suporte
```

---

## 🔧 Diagnóstico Adicional

### Se LED REDE desaparecer ou mudar
- Vermelho = Erro de rede ou perda de sinal
- Laranja piscando = Procurando conexão
- Azul piscando = Conectado e ativo ✅

### Se comando funcionar (LED GPS pisca), monitorar:
```bash
# Terminal 1: Logs do servidor
tail -f /home/tomelin/rastreador/nohup.out | grep -E "Location|0x12|GPS|8877"

# Terminal 2: Verificar banco de dados
sqlite3 /home/tomelin/rastreador/prisma/dev.db "SELECT * FROM localizacoes ORDER BY criado_em DESC LIMIT 5;"
```

---

## 📝 O que Reportar Após Testes

Responda com:
1. **LED GPS após YGPS#1#:** Pisca ou continua fixo?
2. **LED GPS após RSTSYS:** Mudou?
3. **SHOWINFO response:** Qual é o conteúdo completo?
4. **Server logs:** Alguma mensagem "[Location]" apareceu?
5. **LED Rede durante testes:** Mudou de azul piscante?

---

## 🚨 Se nada funcionar

1. Device pode estar em DEEP SLEEP ou HIBERNATE mode
2. Tentar: Desconectar alimentação (bateria + USB) por 10 segundos, reconectar
3. Enviar então novamente: #55555#WAKE,1# + #55555#YGPS#1# + #55555#SHOWINFO#

Se AINDA não funcionar:
- Firmware pode ter issue que impede GPS activation
- Verificar se existe atualização de firmware disponível
- Contatar suporte técnico com: IMEI (356354870699551) + Versão (V1.0.0) + Descrição do problema
