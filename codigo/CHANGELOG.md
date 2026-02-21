# Changelog

Todas as alterações notáveis do projeto serão documentadas neste arquivo.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [2.2.0] - 2026-02-21

### Adicionado
- **Novos tipos de relatório**:
  - Tempo de Operação - tempo com motor ligado por dia
  - Paradas Longas - paradas superiores a 30 minutos
  - Ranking de Condutores - pontuação baseada em eficiência e excessos
  - Consumo Estimado - estimativa de combustível por quilometragem
- **Flatpickr na seção Relatórios** - Mesmo calendário com range da seção Trajetos

### Alterado
- **Filtro de período em Relatórios** - Substituído dropdown por Flatpickr (calendário com seleção de range)
- Tipos de relatório expandidos de 4 para 9 opções

---

## [2.1.0] - 2026-02-21

### Adicionado
- **Flatpickr** - Biblioteca para seleção de período com calendário único
- **Input digitável de veículo** - Autocomplete com datalist na seção Trajetos

### Alterado
- **Layout Responsivo** - Grids com `auto-fit` e `clamp()` para adaptar a qualquer resolução
- **Cards de estatísticas** - Tamanhos fluidos, não cortam mais em telas menores
- **Seção Trajetos**:
  - Seleção de período em calendário único (range picker)
  - Slider de horário simplificado (barra azul)
  - Animação da rota mais lenta (3000ms ao invés de 800ms)
  - Sidebar sempre visível (removido comportamento de hover)

### Removido
- Carrinhos cinzas de direção ao longo da rota (mantidos apenas marcadores de início/fim)
- Seletor dropdown de período (substituído por calendário)
- Aba duplicada de Trajetos na seção Relatórios

### Corrigido
- Data inicial e final não eram setadas corretamente
- Cards cortados em resoluções menores
- Overflow horizontal em algumas seções

---

## [2.0.0] - 2026-02-18

### Adicionado
- **Particionamento por IMEI** - Escalabilidade horizontal com 4 partições
- **Auto-reset do Kalman** - Reseta automaticamente após 5 rejeições consecutivas
- **Filtro de saltos GPS rigoroso** - Regras para saltos absurdos (>5km nunca aceita)

### Alterado
- `LOCATION_PARTITIONS=4` nos gateways e processors
- `MAXLEN` do Redis aumentado para 50.000
- `batchSize` do MapMatch: 20 → 5

### Corrigido
- Race conditions entre processadores de localização
- MapMatch estava 0% - OSRM nunca era chamado
- TCP Gateways sem DATABASE_URL causavam falha silenciosa

---

## [1.9.0] - 2026-02-12

### Adicionado
- **Ignição virtual por tensão** - Para dispositivos XT40_4F sem sinal ACC
- Thresholds configuráveis por dispositivo (`tensao_motor_ligado`, `tensao_motor_deslig`)

### Corrigido
- XT40_4F mostrava OCIOSO quando motor desligado
- XT40_OBD2 usava tensão interna (15.4V) ao invés da tensão real

---

## [1.8.0] - 2026-02-11

### Adicionado
- **Ignição por velocidade** - Para dispositivos sem tensão (XT40_OBD2)
- Heartbeat encerra viagem após 5min parado

### Corrigido
- Viagens não eram criadas para dispositivos com tensão NULL
- App Motorista com Network Error (HTTPS)

---

## Legenda

- **Adicionado** - Novas funcionalidades
- **Alterado** - Mudanças em funcionalidades existentes
- **Removido** - Funcionalidades removidas
- **Corrigido** - Correções de bugs
- **Segurança** - Correções de vulnerabilidades
