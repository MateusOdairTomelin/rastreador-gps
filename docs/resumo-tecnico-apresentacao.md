# Plataforma de Rastreamento GPS - Resumo Técnico

## Visão Geral

**O que é?**
Sistema de rastreamento veicular em tempo real com monitoramento via web e app mobile.

**Principais funcionalidades:**
- Localização em tempo real
- Histórico de viagens
- Alertas (velocidade, cerca virtual, ignição)
- App para motoristas
- Relatórios de uso

---

## Arquitetura

**Stack tecnológico:**
| Camada | Tecnologia |
|--------|------------|
| Frontend Web | React + TypeScript |
| App Mobile | React Native (Expo) |
| Backend/API | Node.js + Express |
| Banco de Dados | PostgreSQL |
| Cache/Filas | Redis |
| Proxy/SSL | HAProxy |
| Containers | Docker |

**Como funciona o fluxo de dados?**
```
Rastreador GPS → TCP Gateway → Redis → Processadores → Banco → API → Interface
```

---

## Perguntas Frequentes

**Quantos rastreadores suporta?**
Arquitetura escalável horizontalmente. Configuração atual suporta ~1.000 dispositivos simultâneos.

**Qual a latência dos dados?**
Tempo real (< 3 segundos) do rastreador até a interface.

**Quais protocolos de rastreadores são suportados?**
- X3Tech (XT40, XT40 OBD2)
- Teltonika
- GT06 (compatíveis)

**Os dados são seguros?**
- HTTPS com certificado SSL
- Autenticação JWT
- Isolamento por organização (multi-tenant)
- Conformidade LGPD

**Funciona offline?**
O rastreador armazena dados temporariamente se perder conexão e envia quando reconecta.

**Como são calculadas as viagens?**
Automaticamente por ignição do veículo (liga/desliga motor) ou por velocidade para dispositivos OBD2.

---

## Diferenciais Técnicos

- **Alta disponibilidade:** Load balancer com múltiplos gateways
- **Processamento distribuído:** Workers paralelos para escala
- **Filtro inteligente:** Algoritmo Kalman para precisão GPS
- **Notificações push:** Alertas em tempo real no app
- **API RESTful:** Integração com sistemas externos

---

## Infraestrutura

**Requisitos mínimos servidor:**
- 4 vCPUs
- 8GB RAM
- 100GB SSD

**Portas utilizadas:**
| Porta | Uso |
|-------|-----|
| 443 | HTTPS (Web/API) |
| 8877 | Rastreadores XT40 |
| 8878 | Rastreadores OBD2 |
| 8879 | Rastreadores Teltonika |

---

## Contato Técnico

**Suporte:** suporte@unifique.com.br
**Documentação:** https://rastreador.unifique.com.br/docs

---

*Versão: 1.0 | Data: Fevereiro/2026*
