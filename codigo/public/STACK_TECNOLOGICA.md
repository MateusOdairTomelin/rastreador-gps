# Sistema de Rastreamento Veicular - Stack Tecnológica

## Resumo Executivo

Sistema completo de rastreamento veicular em tempo real, desenvolvido com arquitetura escalável e segura, capaz de gerenciar milhares de dispositivos GPS simultaneamente.

---

## Linguagens de Programação

| Linguagem | Uso | Percentual |
|-----------|-----|------------|
| **JavaScript (Node.js)** | Backend, APIs, TCP Gateway | 85% |
| **HTML5** | Frontend, Dashboards | 8% |
| **CSS3** | Estilização | 5% |
| **SQL** | Queries de banco de dados | 2% |

---

## Stack Backend

### Runtime e Framework
- **Node.js 18** - Runtime JavaScript
- **Express.js 5** - Framework web para APIs REST

### Banco de Dados
- **PostgreSQL 15** - Banco relacional principal
- **TimescaleDB** - Extensão para séries temporais (dados GPS)
- **Prisma ORM** - Object-Relational Mapping moderno
- **PgBouncer** - Connection pooling (6432 conexões)

### Cache e Filas
- **Redis** - Cache distribuído e pub/sub
- **Bull** - Sistema de filas assíncronas
- **ioredis** - Cliente Redis de alta performance

### Comunicação em Tempo Real
- **WebSocket (ws)** - Atualizações em tempo real
- **TCP Server** - Comunicação com rastreadores GPS

---

## Stack Frontend

### Interface Web
- **HTML5/CSS3** - Estrutura e estilização
- **JavaScript Vanilla** - Lógica de interface
- **Leaflet.js** - Mapas interativos (OpenStreetMap)
- **Chart.js** - Gráficos e visualizações

### UI Components
- **Bootstrap 5** - Framework CSS responsivo
- **Font Awesome** - Ícones

---

## Infraestrutura e DevOps

### Containerização
- **Docker** - Containerização de serviços
- **Docker Compose** - Orquestração de containers

### Load Balancing
- **HAProxy** - Balanceador de carga TCP/HTTP
  - Sticky sessions para rastreadores
  - Round-robin para APIs
  - Health checks automáticos

### Segurança
- **UFW** - Firewall (deny by default)
- **Fail2ban** - Proteção contra brute-force (5 jails)
- **Helmet.js** - Headers de segurança HTTP
- **JWT** - Autenticação stateless
- **bcrypt** - Hash de senhas
- **CSRF Protection** - Tokens anti-CSRF
- **Rate Limiting** - Proteção contra DDoS

---

## Protocolos de Comunicação

### Rastreadores GPS
- **GT06/XT40** - Protocolo binário TCP
- **Teltonika** - Protocolo Codec8/Codec8E
- **OBD2** - Dados de diagnóstico veicular

### APIs
- **REST** - API HTTP para frontend/integrações
- **WebSocket** - Streaming de dados em tempo real

---

## Arquitetura do Sistema

```
┌─────────────────────────────────────────────────────────────────┐
│                        INTERNET                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │      UFW          │
                    │    Firewall       │
                    └─────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
        │  HAProxy  │   │  HAProxy  │   │  HAProxy  │
        │  TCP:8877 │   │  TCP:8878 │   │ HTTP:62000│
        └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
              │               │               │
    ┌─────────┼─────────┐     │     ┌─────────┼─────────┐
    │         │         │     │     │         │         │
┌───┴───┐ ┌───┴───┐ ┌───┴───┐ │ ┌───┴───┐ ┌───┴───┐
│TCP-GW1│ │TCP-GW2│ │TCP-GW3│ │ │ API-1 │ │ API-2 │
└───┬───┘ └───┬───┘ └───┬───┘ │ └───┬───┘ └───┬───┘
    │         │         │     │     │         │
    └─────────┴────┬────┴─────┴─────┴────┬────┘
                   │                     │
           ┌───────┴───────┐     ┌───────┴───────┐
           │     Redis     │     │   PgBouncer   │
           │  Cache/Queue  │     │   Pool:5432   │
           └───────────────┘     └───────┬───────┘
                                         │
                                 ┌───────┴───────┐
                                 │  PostgreSQL   │
                                 │  TimescaleDB  │
                                 └───────────────┘
```

---

## Funcionalidades Principais

### Rastreamento
- Posicionamento GPS em tempo real
- Histórico de rotas com replay
- Geofencing (cercas virtuais)
- Alertas de velocidade
- Detecção de ignição

### Gestão de Frota
- Cadastro de veículos e motoristas
- Relatórios de utilização
- Análise de viagens
- Consumo de combustível (OBD2)

### Segurança e LGPD
- Multi-tenancy (organizações isoladas)
- Controle de acesso por perfil
- Anonimização de dados
- Logs de auditoria
- Criptografia de dados sensíveis

### Monitoramento
- Dashboard em tempo real
- Métricas do sistema
- Alertas de dispositivos offline
- Health checks automáticos

---

## Bibliotecas Principais

| Biblioteca | Versão | Função |
|------------|--------|--------|
| express | 5.2.1 | Framework web |
| @prisma/client | 5.22.0 | ORM para PostgreSQL |
| ioredis | 5.8.2 | Cliente Redis |
| bull | 4.16.5 | Filas de processamento |
| ws | 8.18.3 | WebSocket server |
| jsonwebtoken | 9.0.3 | Autenticação JWT |
| bcrypt | 6.0.0 | Hash de senhas |
| helmet | 8.1.0 | Segurança HTTP |
| pdfkit | 0.17.2 | Geração de relatórios PDF |
| nodemailer | 7.0.13 | Envio de emails |
| serialport | 13.0.0 | Comunicação serial |
| prom-client | 15.1.3 | Métricas Prometheus |

---

## Métricas de Código

- **Arquivos de código**: ~150 arquivos
- **Linhas de código**: ~25.000 linhas
- **Endpoints API**: ~80 rotas
- **Modelos de dados**: 15 tabelas
- **Containers Docker**: 12 serviços

---

## Requisitos de Hardware (Produção)

| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Disco | 100 GB SSD | 500 GB SSD |
| Rede | 100 Mbps | 1 Gbps |

---

## Escalabilidade

O sistema foi projetado para escalar horizontalmente:

- **3 TCP Gateways** - Balanceados por HAProxy
- **2 API Servers** - Load balancing round-robin
- **3 Processadores de Localização** - Filas Redis
- **Connection Pooling** - PgBouncer (até 1000 conexões)

**Capacidade estimada**: 10.000+ dispositivos simultâneos

---

## Contato

Desenvolvido para apresentação à equipe de desenvolvimento e diretoria.

*Documento gerado em: Fevereiro/2026*
