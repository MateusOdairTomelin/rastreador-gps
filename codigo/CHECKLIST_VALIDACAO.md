# Checklist de Validação - Protocolo GT06 Completo

**Data:** 2025-12-10
**Versão:** 1.0
**Objetivo:** Validar coleta completa e correta de dados GT06 no rastreador X3Tech XT40

---

## PARTE 1: PRÉ-REQUISITOS

### Sistema Pronto
- [ ] Servidor Node.js rodando na porta 62000 (`npm start`)
- [ ] Servidor TCP escutando na porta 8877
- [ ] PostgreSQL online e conectado
- [ ] Rastreador X3Tech XT40 ligado e alimentado
- [ ] Rastreador conectado na porta 8877 TCP

### Verificação Rápida
```bash
# Terminal 1: Iniciar servidor
cd /home/tomelin/rastreador
npm start

# Terminal 2: Verificar portas
netstat -tuln | grep -E "8877|62000|5432"
```

**Status:**
- [ ] HTTP rodando em 62000
- [ ] TCP rodando em 8877
- [ ] WebSocket ativo em 62000
- [ ] PostgreSQL ativo em 5432

---

## PARTE 2: TESTES DO PARSER (GT06)

### Login Packet (0x01)
**O que validar:** Extração correta do IMEI do rastreador

**Passos:**
1. [ ] Iniciar servidor
2. [ ] Conectar rastreador na porta 8877
3. [ ] Verificar logs: deve aparecer mensagem com IMEI (15 dígitos)

**Logs esperados:**
```
[GPS Parser] → Processing LOGIN packet (0x01)
[GPS Parser] IMEI (decoded from BCD): 535339958366523
[TCP] IMEI registrado para sessão: 535339958366523
[Login] Device 535339958366523 connected and marked online
```

**Critério de Sucesso:**
- [ ] IMEI extraído com 15 dígitos
- [ ] Status do dispositivo é "online"
- [ ] ACK enviado para rastreador

---

### Location Packet (0x12)
**O que validar:** Coleta correta de coordenadas GPS

**Passos:**
1. [ ] Rastreador enviando dados GPS
2. [ ] Verificar logs de localização
3. [ ] Acessar dashboard: `http://localhost:62000`
4. [ ] Ir para aba "Mapa"

**Logs esperados:**
```
[GPS Parser] → Processing LOCATION packet (0x12)
[GPS Parser] ✅ Location packet SUCCESS: lat=-26.9 lon=-49.0
🌍 [GPS] Dados de localização para 535339958366523
✅ [Location] Saved for 535339958366523: (-26.9, -49.0) @ 45 km/h
```

**Validações Automáticas:**
- [ ] Latitude entre -90 e 90
- [ ] Longitude entre -180 e 180
- [ ] Coordenadas 0,0 rejeitadas (sem satélite)
- [ ] Velocidade > 250 km/h gera warning
- [ ] Timestamp não é futuro (+ 24h)

**Dashboard:**
- [ ] Marcador verde aparece no mapa
- [ ] Card "Localizações" incrementa
- [ ] Popup do marcador mostra: Nome, IMEI, Placa, Status, Velocidade

**Banco de Dados:**
```bash
# Terminal: Verificar se localização foi salva
psql -U admin -d rastreador -c \
  "SELECT latitude, longitude, velocidade, timestamp FROM localizacoes
   WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '535339958366523')
   ORDER BY timestamp DESC LIMIT 5;"
```

**Critério de Sucesso:**
- [ ] Localização salva no banco
- [ ] Coordenadas válidas (não 0,0)
- [ ] Marcador aparece no mapa
- [ ] Dashboard atualiza em tempo real

---

### OBD2 Packet (0x94)
**O que validar:** Coleta de dados diagnósticos do veículo

**Passos:**
1. [ ] Rastreador enviando dados OBD2
2. [ ] Verificar logs OBD2
3. [ ] Acessar API: `curl http://localhost:62000/api/dispositivos/:imei/obd2-atual`

**Logs esperados:**
```
[GPS Parser] → Processing OBD2 packet (0x94)
🔧 [OBD2] Dados de diagnóstico para 535339958366523
[OBD2] Save error: (nenhum erro se tudo ok)
```

**API Response esperado:**
```json
{
  "sucesso": true,
  "dados": {
    "rpm": 1500,
    "velocidade": 50,
    "temperatura_motor": 85,
    "nivel_combustivel": 75,
    "odometro_embarcado": 45230.5,
    "hora_motor_embarcada": 2150.3,
    "percentual_bateria": 95,
    "tensao_bateria": 12.8,
    "ignicao": true
  }
}
```

**Validações Automáticas:**
- [ ] Parsing flexível (aceita tamanhos variáveis)
- [ ] Valores nulos para campos faltantes
- [ ] Temperatura em Celsius (offset -40 aplicado)
- [ ] Odômetro em km (dividido por 10)
- [ ] Tensão em Volts (dividida por 100)

**Banco de Dados:**
```bash
# Verificar se OBD2 foi salvo
psql -U admin -d rastreador -c \
  "SELECT rpm, temperatura_motor, nivel_combustivel, ignicao FROM dados_obd2
   WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '535339958366523')
   ORDER BY timestamp DESC LIMIT 5;"
```

**Critério de Sucesso:**
- [ ] Dados OBD2 salvos no banco
- [ ] API retorna dados corretos
- [ ] Temperatura, combustível, RPM presentes
- [ ] Sem erros de parsing

---

### Alarm Packet (0x16)
**O que validar:** Coleta de alarmes do rastreador

**Passos:**
1. [ ] Forçar um alarme no rastreador (ex: SOS, geofence, etc)
2. [ ] Verificar logs
3. [ ] Acessar API: `curl http://localhost:62000/api/dispositivos/:imei/alarmes`

**Logs esperados:**
```
[GPS Parser] → Processing ALARM packet (0x16)
[Alarm] Save error: (nenhum erro se ok)
```

**API Response esperado:**
```json
{
  "sucesso": true,
  "dados": [
    {
      "tipo_alarme": "SOS",
      "severidade": "critical",
      "descricao": "Alarm: SOS",
      "timestamp": "2025-12-10T15:30:45.000Z"
    }
  ]
}
```

**Tipos de Alarme Suportados:**
- [ ] 0x01 - SOS (severidade: critical)
- [ ] 0x02 - Overspeed (severidade: warning)
- [ ] 0x03 - Geofence (severidade: info)
- [ ] 0x04 - Low Battery (severidade: warning)
- [ ] 0x05 - Vibration (severidade: info)
- [ ] 0x06 - Power Cut (severidade: warning)
- [ ] 0x07 - Door Open (severidade: info)
- [ ] 0x08 - Door Closed (severidade: info)

**Critério de Sucesso:**
- [ ] Alarme salvo no banco
- [ ] Tipo de alarme identificado corretamente
- [ ] Severidade atribuída corretamente
- [ ] API retorna dados do alarme

---

### Status Packet (0x13)
**O que validar:** Informações de status/bateria

**Passos:**
1. [ ] Rastreador enviando status
2. [ ] Verificar logs
3. [ ] Verificar se tensão de bateria foi salva

**Logs esperados:**
```
[GPS Parser] → Processing STATUS packet (0x13)
```

**Critério de Sucesso:**
- [ ] Packet processado sem erros
- [ ] Tensão de bateria extraída
- [ ] Status working registrado

---

## PARTE 3: TESTES DO WEBSOCKET

### WebSocket Real-Time Updates
**O que validar:** Transmissão em tempo real via WebSocket

**Passos:**
1. [ ] Dashboard aberto em `http://localhost:62000`
2. [ ] Abrir DevTools (F12) → Console
3. [ ] Colar código:
```javascript
const ws = new WebSocket('ws://localhost:62000/ws');
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  console.log(`[WS] ${data.tipo}: ${data.imei}`);
};
```

**Esperado:**
```
[WS] update: 535339958366523
[WS] packet_debug: 535339958366523
```

**Dois Tipos de Broadcast:**
- [ ] `tipo: 'update'` - Dashboard normal recebe atualizações
- [ ] `tipo: 'packet_debug'` - Debug dashboard recebe detalhes

**Critério de Sucesso:**
- [ ] Ambos os tipos de mensagem chegam
- [ ] Atualizações chegam em tempo real (< 1s)
- [ ] Sem desconexões inesperadas
- [ ] Reconexão automática se desconectar

---

### Debug Dashboard WebSocket
**O que validar:** Dashboard de debug recebendo pacotes

**Passos:**
1. [ ] Acessar `http://localhost:62000/debug-packets.html`
2. [ ] Deve conectar ao WebSocket automaticamente
3. [ ] Enviar pacote do rastreador
4. [ ] Observar pacote na lista

**Esperado:**
- [ ] Pacote aparece na lista de logs
- [ ] Timestamp, IMEI, Protocolo, Tipo visíveis
- [ ] Hex dump exibido
- [ ] Click abre inspetor com detalhes

**Estatísticas:**
- [ ] Total incrementa
- [ ] Por tipo incrementa (login, location, obd2, alarm, status)
- [ ] Últimos pacotes armazenados (máx 50)

**Filtros:**
- [ ] Desmarcar "Location" esconde pacotes 0x12
- [ ] Marcar apenas "OBD2" mostra só 0x94
- [ ] Botão "Pausar" congela a lista
- [ ] Botão "Limpar Log" remove todos os pacotes
- [ ] Botão "Reset Estatísticas" zera contadores

**Critério de Sucesso:**
- [ ] Dashboard de debug funcional
- [ ] Pacotes aparecem em tempo real
- [ ] Filtros funcionam corretamente
- [ ] Inspetor mostra dados completos

---

## PARTE 4: TESTES DA API REST

### Endpoints de Debug
**O que validar:** API retorna estatísticas de pacotes

**Comando:**
```bash
curl http://localhost:62000/api/debug/packets
```

**Response esperado:**
```json
{
  "sucesso": true,
  "estatisticas": {
    "total": 42,
    "por_tipo": {
      "login": 1,
      "location": 15,
      "obd2": 20,
      "alarm": 2,
      "status": 4
    },
    "ultimos_pacotes_count": 42
  },
  "ultimos_pacotes": [
    {
      "type": "location",
      "protocolNumber": "0x12",
      "imei": "535339958366523",
      "timestamp": "2025-12-10T15:30:45.123Z",
      "raw": "78781234...",
      "recordedAt": "2025-12-10T15:30:45.456Z"
    }
  ]
}
```

**Critério de Sucesso:**
- [ ] Endpoint responde com sucesso
- [ ] Contadores refletem pacotes recebidos
- [ ] Últimos pacotes incluídos
- [ ] Timestamps corretos

---

### Endpoints de Localização
**Comando:**
```bash
curl http://localhost:62000/api/dispositivos/535339958366523/localizacao-atual
```

**Response esperado:**
```json
{
  "sucesso": true,
  "dados": {
    "latitude": -26.9034,
    "longitude": -49.0184,
    "velocidade": 45,
    "direcao": 180,
    "altitude": null,
    "precisao": 25,
    "satellites": 5,
    "timestamp": "2025-12-10T15:30:45.000Z"
  }
}
```

**Critério de Sucesso:**
- [ ] Localização atual retorna dados
- [ ] Coordenadas válidas (não 0,0)
- [ ] Velocidade, direção, satélites presentes
- [ ] Timestamp correto

---

### Endpoints de OBD2
**Comando:**
```bash
curl http://localhost:62000/api/dispositivos/535339958366523/obd2-atual
```

**Response esperado:**
```json
{
  "sucesso": true,
  "dados": {
    "rpm": 1500,
    "temperatura_motor": 85,
    "nivel_combustivel": 75,
    "ignicao": true
  }
}
```

**Critério de Sucesso:**
- [ ] Dados OBD2 retornados
- [ ] Temperatura em Celsius
- [ ] RPM em rotações por minuto
- [ ] Combustível em percentual

---

### Endpoints de Heartbeat
**Comando:**
```bash
curl http://localhost:62000/api/heartbeats/535339958366523
```

**Response esperado:**
```json
{
  "sucesso": true,
  "dados": {
    "imei": "535339958366523",
    "count": 42,
    "timestamp": "2025-12-10T15:30:45.000Z",
    "lastSeen": "2025-12-10T15:30:45.000Z",
    "status": "connected"
  }
}
```

**Critério de Sucesso:**
- [ ] Heartbeat retorna status
- [ ] Count incrementa
- [ ] Timestamp atualizado
- [ ] Status é "connected" ou similar

---

## PARTE 5: TESTES DE PERSISTÊNCIA (PostgreSQL)

### Localizações Salvas
```bash
psql -U admin -d rastreador -c \
  "SELECT COUNT(*) as total FROM localizacoes
   WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '535339958366523');"
```

**Esperado:** `total | número > 0`

**Critério de Sucesso:**
- [ ] Pelo menos 5 localizações salvas
- [ ] Sem coordenadas 0,0
- [ ] Timestamps em ordem crescente
- [ ] Latitude e longitude válidos

---

### OBD2 Salvo
```bash
psql -U admin -d rastreador -c \
  "SELECT COUNT(*) as total FROM dados_obd2
   WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '535339958366523');"
```

**Esperado:** `total | número > 0`

**Critério de Sucesso:**
- [ ] Pelo menos 3 registros OBD2
- [ ] RPM, temperatura, combustível presentes
- [ ] Timestamps válidos
- [ ] Sem erros de parsing

---

### Alarmes Salvos
```bash
psql -U admin -d rastreador -c \
  "SELECT COUNT(*) as total FROM alarmes
   WHERE dispositivo_id = (SELECT id FROM dispositivos WHERE imei = '535339958366523');"
```

**Esperado:** `total | número > 0` (se alarmes foram acionados)

**Critério de Sucesso:**
- [ ] Alarmes salvos corretamente
- [ ] Tipo de alarme preenchido
- [ ] Severidade correta
- [ ] Timestamps válidos

---

### Dispositivo Status
```bash
psql -U admin -d rastreador -c \
  "SELECT imei, status, ultima_conexao FROM dispositivos WHERE imei = '535339958366523';"
```

**Esperado:**
```
imei          | status | ultima_conexao
535339958366523 | online | 2025-12-10 15:30:45.123456
```

**Critério de Sucesso:**
- [ ] Status é "online"
- [ ] Última conexão recente (< 2 minutos)
- [ ] Dispositivo registrado automaticamente

---

## PARTE 6: TESTES DO MAPA

### Visualização no Mapa
**Passos:**
1. [ ] Acessar `http://localhost:62000`
2. [ ] Clicar em "Mapa" na sidebar
3. [ ] Aguardar carregamento do mapa

**Esperado:**
- [ ] Mapa carrega (OpenStreetMap)
- [ ] Centro em Santa Catarina (Brasil)
- [ ] Marcador verde aparece para dispositivo online
- [ ] Zoom ajusta para mostrar todos os dispositivos

**Interatividade:**
- [ ] Click no marcador mostra popup
- [ ] Popup exibe: Nome, IMEI, Placa, Status, Velocidade
- [ ] Marcador atualiza quando localização muda
- [ ] Mapa recarrega a cada nova localização

**Critério de Sucesso:**
- [ ] Mapa funcional
- [ ] Marcador correto
- [ ] Popup com informações
- [ ] Atualizações em tempo real

---

## PARTE 7: TESTES DE PERFORMANCE

### Rate Limiting
**O que validar:** Servidor rejeita > 100 pacotes/segundo

**Teste manual (difícil sem rastreador real enviando muitos pacotes)**
- [ ] Servidor não trava com múltiplos pacotes
- [ ] Logs mostram processamento sem erros
- [ ] Memória não cresce indefinidamente

---

### TCP Packet Buffer
**O que validar:** Reassembly de pacotes fragmentados

**Esperado:**
- [ ] Log mostra `[PacketBuffer] Processando pacote`
- [ ] Pacotes fragmentados são reunidos
- [ ] Sem pacotes perdidos

**Critério de Sucesso:**
- [ ] Todos os pacotes processados
- [ ] Sem erros de incomplete packets
- [ ] Performance mantida

---

### WebSocket Broadcast
**O que validar:** Múltiplos clientes recebem mensagens

**Teste:**
1. [ ] Abrir dashboard em 2 abas diferentes
2. [ ] Enviar pacote do rastreador
3. [ ] Ambas as abas atualizam

**Critério de Sucesso:**
- [ ] Ambas as abas recebem atualizações
- [ ] Sem atraso significativo
- [ ] Sem duplicação de pacotes

---

## PARTE 8: TESTES DE ERRO HANDLING

### CRC Inválido
**O que validar:** Pacote com CRC inválido processa mas gera warning

**Log esperado:**
```
[GPS Parser] ⚠️ CRC validation failed - processing anyway
```

**Critério de Sucesso:**
- [ ] Warning gerado
- [ ] Pacote ainda processado
- [ ] Não trava o servidor

---

### Pacote Truncado
**O que validar:** Pacote incompleto rejeitado

**Log esperado:**
```
[GPS Parser] ❌ REJECT: Incomplete packet
```

**Critério de Sucesso:**
- [ ] Pacote rejeitado
- [ ] Nenhum erro de crash
- [ ] Servidor continua funcionando

---

### Coordenadas 0,0
**O que validar:** Sem satélite, localização não salva

**Log esperado:**
```
[Location] ⚠️ Skipping 0,0 coordinates
```

**Critério de Sucesso:**
- [ ] Coordenada 0,0 não salva
- [ ] Banco não pollui
- [ ] Mapa não mostra marcador inválido

---

### IMEI Não Registrado
**O que validar:** Novo IMEI cria dispositivo automaticamente

**Esperado:**
- [ ] Novo dispositivo criado no banco
- [ ] Status = "online"
- [ ] Localizações salvas corretamente

**Critério de Sucesso:**
- [ ] Dispositivo criado automático
- [ ] Sem erro de "dispositivo não existe"

---

## PARTE 9: TESTES FINAIS DE INTEGRAÇÃO

### Fluxo Completo
**Passos:**
1. [ ] Iniciar servidor (`npm start`)
2. [ ] Acessar dashboard (`http://localhost:62000`)
3. [ ] Conectar rastreador na porta 8877
4. [ ] Verificar dispositivo online em < 10 segundos
5. [ ] Abrir debug dashboard (`http://localhost:62000/debug-packets.html`)
6. [ ] Ver pacotes chegando em tempo real
7. [ ] Ir para aba "Mapa" e ver localização
8. [ ] Ir para aba "Heartbeat" e ver status
9. [ ] Abrir debug para verificar estatísticas

**Critério de Sucesso:**
- [ ] Fluxo completo sem erros
- [ ] Todos os dados aparecem corretos
- [ ] Performance aceitável (sem travamentos)

---

### Reconexão do Rastreador
**Passos:**
1. [ ] Rastreador conectado e funcionando
2. [ ] Desligar rastreador
3. [ ] Verificar status muda para "offline"
4. [ ] Ligar rastreador novamente
5. [ ] Verificar status muda para "online"

**Critério de Sucesso:**
- [ ] Status atualiza corretamente
- [ ] Sem erros de reconexão
- [ ] Dados continuam fluindo

---

## RESUMO DE RESULTADOS

### Checklist Geral

**Parser GT06:**
- [ ] Login (0x01) - IMEI extraído
- [ ] Location (0x12) - Coordenadas salvas
- [ ] OBD2 (0x94) - Diagnóstico salvo
- [ ] Alarm (0x16) - Alarmes salvos
- [ ] Status (0x13) - Status recebido

**WebSocket:**
- [ ] Broadcast "update" funcional
- [ ] Broadcast "packet_debug" funcional
- [ ] Dashboard atualiza em tempo real
- [ ] Debug dashboard funcional

**API:**
- [ ] /api/debug/packets funcional
- [ ] /api/dispositivos/:imei/localizacao-atual funcional
- [ ] /api/dispositivos/:imei/obd2-atual funcional
- [ ] /api/heartbeats/:imei funcional

**Persistência:**
- [ ] Localizações salvam no PostgreSQL
- [ ] OBD2 salva no PostgreSQL
- [ ] Alarmes salvos no PostgreSQL
- [ ] Dispositivo criado automaticamente

**Interface:**
- [ ] Dashboard mostra dados corretos
- [ ] Mapa mostra marcadores
- [ ] Debug dashboard funcional
- [ ] Sem erros JavaScript no console

**Performance:**
- [ ] Sem travamentos
- [ ] WebSocket estável
- [ ] Rate limiting funciona
- [ ] TCP packet buffer funciona

---

## Assinatura de Validação

**Validador:** _______________

**Data:** _______________

**Observações:**
```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

**Resultado Final:**
- [ ] ✅ PASSOU - Sistema pronto para produção
- [ ] ⚠️ PARCIAL - Alguns testes falharam (ver notas acima)
- [ ] ❌ FALHOU - Problemas críticos encontrados

---

## Próximos Passos (se tudo passou)

1. [ ] Documentar configuração no README
2. [ ] Criar backup do banco de dados
3. [ ] Configurar monitoramento/alertas
4. [ ] Treinar operadores no dashboard
5. [ ] Fazer testes de carga
6. [ ] Implementar histórico de rotas
7. [ ] Adicionar exportação de dados
8. [ ] Configurar autenticação/permissões

---

**Última atualização:** 2025-12-10
**Versão:** 1.0
