# Análise de Segurança e Conformidade LGPD
## Sistema de Rastreamento Veicular

**Data:** 19/12/2025
**Status:** CRÍTICO - Ações Imediatas Necessárias

---

## SUMÁRIO EXECUTIVO

| Severidade | Quantidade | Status |
|------------|------------|--------|
| 🔴 CRÍTICO | 3 | Corrigir em 24h |
| 🟠 ALTO | 4 | Corrigir em 1 semana |
| 🟡 MÉDIO | 2 | Corrigir em 2 semanas |
| 🟢 BAIXO | 1 | Monitorar |

---

## PARTE 1: VULNERABILIDADES DE SEGURANÇA

### 🔴 CRÍTICO 1: Credenciais Expostas

**Arquivo:** `.env`

```env
# ATUAL (INSEGURO)
DATABASE_URL="postgresql://postgres:sua_senha_aqui@localhost:5432/rastreador_db"
DB_PASSWORD=sua_senha_aqui
```

**Correção Imediata:**

```bash
# 1. Gerar senha forte
openssl rand -base64 32

# 2. Alterar senha do PostgreSQL
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'NOVA_SENHA_FORTE_32_CHARS';"

# 3. Atualizar .env
DATABASE_URL="postgresql://postgres:NOVA_SENHA_FORTE@localhost:5432/rastreador_db"
DB_PASSWORD=NOVA_SENHA_FORTE
```

**Adicionar ao `.gitignore`:**
```
.env
.env.local
.env.production
*.pem
*.key
```

---

### 🔴 CRÍTICO 2: Ausência de Autenticação

**Problema:** API completamente aberta, qualquer pessoa pode:
- Ver localização de TODOS os veículos
- Cortar combustível de qualquer veículo
- Enviar comandos para rastreadores

**Arquivo:** `server/index.js` (linhas 34-42)

```javascript
// ATUAL (INSEGURO)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');  // ❌ Permite QUALQUER origem
  next();
});
```

**Correção - Implementar JWT:**

```javascript
// CORRIGIDO
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

// Configuração
const JWT_SECRET = process.env.JWT_SECRET; // 64+ chars aleatórios
const JWT_EXPIRES = '24h';

// Middleware de autenticação
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
};

// Middleware de autorização por role
const authorize = (roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ erro: 'Sem permissão' });
  }
  next();
};

// CORS restrito
app.use(cors({
  origin: ['https://seudominio.com.br', 'https://admin.seudominio.com.br'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// Proteger rotas
app.use('/api/dispositivos', authenticate);
app.use('/api/localizacoes', authenticate);
app.use('/api/comandos', authenticate, authorize(['admin', 'operador']));
app.post('/api/comandos/:imei/cortar-combustivel', authenticate, authorize(['admin']));
```

---

### 🔴 CRÍTICO 3: Dados Sensíveis em Logs

**Problema:** IMEIs e comandos sendo logados em texto plano

**Correção:**

```javascript
// Função para mascarar IMEI
const mascarar = (imei) => {
  if (!imei) return '***';
  return imei.slice(0, 4) + '****' + imei.slice(-4);
};

// Antes (INSEGURO)
console.log(`[TCP] IMEI: ${imei}`);

// Depois (SEGURO)
console.log(`[TCP] IMEI: ${mascarar(imei)}`);
// Output: [TCP] IMEI: 3563****8418
```

---

### 🟠 ALTO 1: Falta de Validação de Entrada

**Instalar Zod:**
```bash
npm install zod
```

**Implementar validação:**

```javascript
const { z } = require('zod');

// Schema de validação
const dispositivoSchema = z.object({
  imei: z.string().length(15).regex(/^\d+$/),
  tipo: z.enum(['XT40_4F', 'XT40_OBD2', 'XT40_SV']),
  placa: z.string().max(10).optional(),
  veiculo: z.string().max(100).optional(),
});

const comandoSchema = z.object({
  comando: z.enum([
    'GPS_ON', 'GPS_OFF', 'OBD_ON', 'OBD_OFF',
    'CORTAR_COMBUSTIVEL', 'RESTAURAR_COMBUSTIVEL'
  ]),
});

// Middleware de validação
const validate = (schema) => (req, res, next) => {
  try {
    schema.parse(req.body);
    next();
  } catch (error) {
    return res.status(400).json({
      erro: 'Dados inválidos',
      detalhes: error.errors
    });
  }
};

// Uso nas rotas
router.post('/dispositivos', validate(dispositivoSchema), createDevice);
router.post('/comandos/:imei', validate(comandoSchema), sendCommand);
```

---

### 🟠 ALTO 2: Operações Críticas Sem Confirmação

**Problema:** Corte de combustível pode ser feito instantaneamente

**Correção - Double Confirmation:**

```javascript
// 1. Criar tabela de solicitações pendentes
// prisma/schema.prisma
model SolicitacaoCorte {
  id              Int       @id @default(autoincrement())
  dispositivo_id  Int
  solicitado_por  Int       // user_id
  aprovado_por    Int?      // user_id diferente
  status          String    @default("pendente") // pendente, aprovado, rejeitado, executado
  motivo          String
  created_at      DateTime  @default(now())
  aprovado_at     DateTime?
  executado_at    DateTime?
}

// 2. Fluxo de corte com aprovação
router.post('/comandos/:imei/solicitar-corte', authenticate, authorize(['operador', 'admin']), async (req, res) => {
  const { imei } = req.params;
  const { motivo } = req.body;

  // Criar solicitação (precisa de aprovação)
  const solicitacao = await prisma.solicitacaoCorte.create({
    data: {
      dispositivo_id: dispositivo.id,
      solicitado_por: req.user.id,
      motivo,
      status: 'pendente'
    }
  });

  // Notificar admins
  await enviarNotificacao('admin', `Solicitação de corte para ${imei}`);

  res.json({ mensagem: 'Solicitação criada, aguardando aprovação', id: solicitacao.id });
});

router.post('/comandos/:imei/aprovar-corte/:solicitacaoId', authenticate, authorize(['admin']), async (req, res) => {
  const { solicitacaoId } = req.params;

  const solicitacao = await prisma.solicitacaoCorte.findUnique({
    where: { id: parseInt(solicitacaoId) }
  });

  // Admin não pode aprovar própria solicitação
  if (solicitacao.solicitado_por === req.user.id) {
    return res.status(403).json({ erro: 'Não pode aprovar própria solicitação' });
  }

  // Executar corte
  await comandoService.sendCommand(imei, 'DYD,000000#');

  // Atualizar status
  await prisma.solicitacaoCorte.update({
    where: { id: solicitacao.id },
    data: {
      status: 'executado',
      aprovado_por: req.user.id,
      aprovado_at: new Date(),
      executado_at: new Date()
    }
  });

  // Log de auditoria
  await prisma.auditLog.create({
    data: {
      acao: 'CORTE_COMBUSTIVEL',
      usuario_id: req.user.id,
      dispositivo_imei: imei,
      ip: req.ip,
      detalhes: JSON.stringify({ solicitacao_id: solicitacaoId })
    }
  });

  res.json({ mensagem: 'Corte executado com sucesso' });
});
```

---

### 🟠 ALTO 3: Headers de Segurança

**Instalar Helmet:**
```bash
npm install helmet
```

**Configurar:**

```javascript
const helmet = require('helmet');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
```

---

### 🟠 ALTO 4: Rate Limiting

**Instalar:**
```bash
npm install express-rate-limit
```

**Configurar:**

```javascript
const rateLimit = require('express-rate-limit');

// Limite geral: 100 req/15min por IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { erro: 'Muitas requisições, tente novamente em 15 minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limite para login: 5 tentativas/15min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { erro: 'Muitas tentativas de login, conta bloqueada por 15 minutos' },
});

// Limite para operações críticas: 3/hora
const criticalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { erro: 'Limite de operações críticas atingido' },
});

app.use('/api/', generalLimiter);
app.post('/api/auth/login', loginLimiter);
app.post('/api/comandos/:imei/cortar-combustivel', criticalLimiter);
```

---

## PARTE 2: CONFORMIDADE LGPD

### Dados Pessoais Tratados

| Dado | Categoria LGPD | Finalidade | Base Legal |
|------|----------------|------------|------------|
| Localização GPS | Dado Pessoal Sensível* | Rastreamento veicular | Consentimento / Legítimo Interesse |
| Placa do veículo | Dado Pessoal | Identificação | Execução de contrato |
| IMEI do rastreador | Dado Técnico | Operação do serviço | Execução de contrato |
| Histórico de rotas | Dado Pessoal Sensível* | Análise de deslocamento | Consentimento |
| Velocidade | Dado Pessoal | Telemetria | Execução de contrato |

*Localização pode ser considerada dado sensível pois revela hábitos e comportamentos.

---

### Requisitos LGPD a Implementar

#### 1. Política de Privacidade

Criar documento explicando:
- Quais dados são coletados
- Para que são usados
- Com quem são compartilhados
- Por quanto tempo são retidos
- Direitos do titular

#### 2. Termo de Consentimento

```javascript
// Model para consentimento
model Consentimento {
  id              Int       @id @default(autoincrement())
  usuario_id      Int
  tipo            String    // 'rastreamento', 'historico', 'compartilhamento'
  aceito          Boolean
  ip              String
  user_agent      String
  created_at      DateTime  @default(now())
  revogado_at     DateTime?
}

// Endpoint para registro de consentimento
router.post('/consentimento', authenticate, async (req, res) => {
  const { tipo, aceito } = req.body;

  await prisma.consentimento.create({
    data: {
      usuario_id: req.user.id,
      tipo,
      aceito,
      ip: req.ip,
      user_agent: req.headers['user-agent']
    }
  });

  res.json({ mensagem: 'Consentimento registrado' });
});
```

#### 3. Direito de Acesso aos Dados

```javascript
// Endpoint para exportar dados do usuário (LGPD Art. 18)
router.get('/meus-dados', authenticate, async (req, res) => {
  const usuario = await prisma.usuario.findUnique({
    where: { id: req.user.id },
    include: {
      dispositivos: {
        include: {
          localizacoes: {
            take: 1000,
            orderBy: { timestamp: 'desc' }
          },
          viagens: true
        }
      },
      consentimentos: true
    }
  });

  // Formato portável (JSON ou CSV)
  res.json({
    dados_pessoais: {
      nome: usuario.nome,
      email: usuario.email,
      criado_em: usuario.created_at
    },
    dispositivos: usuario.dispositivos.map(d => ({
      placa: d.placa,
      veiculo: d.veiculo,
      localizacoes_count: d.localizacoes.length,
      viagens_count: d.viagens.length
    })),
    consentimentos: usuario.consentimentos,
    exportado_em: new Date().toISOString()
  });
});
```

#### 4. Direito de Exclusão (Esquecimento)

```javascript
// Endpoint para solicitar exclusão de dados (LGPD Art. 18)
router.post('/excluir-meus-dados', authenticate, async (req, res) => {
  const { confirmacao, motivo } = req.body;

  if (confirmacao !== 'EXCLUIR MEUS DADOS') {
    return res.status(400).json({ erro: 'Confirmação inválida' });
  }

  // Criar solicitação (30 dias para processar)
  await prisma.solicitacaoExclusao.create({
    data: {
      usuario_id: req.user.id,
      motivo,
      status: 'pendente',
      prazo: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 dias
    }
  });

  // Notificar DPO
  await enviarEmail(process.env.DPO_EMAIL, 'Solicitação de exclusão de dados', {
    usuario_id: req.user.id,
    motivo
  });

  res.json({
    mensagem: 'Solicitação recebida. Seus dados serão excluídos em até 30 dias.',
    protocolo: `EXC-${Date.now()}`
  });
});

// Job para processar exclusões
async function processarExclusoes() {
  const solicitacoes = await prisma.solicitacaoExclusao.findMany({
    where: {
      status: 'pendente',
      prazo: { lte: new Date() }
    }
  });

  for (const s of solicitacoes) {
    // Anonimizar dados (não deletar completamente para auditoria)
    await prisma.localizacao.updateMany({
      where: { dispositivo: { usuario_id: s.usuario_id } },
      data: {
        latitude: 0,
        longitude: 0,
        // Manter timestamp para auditoria
      }
    });

    await prisma.usuario.update({
      where: { id: s.usuario_id },
      data: {
        nome: 'USUÁRIO REMOVIDO',
        email: `removido_${s.usuario_id}@anonimo.local`,
        deleted_at: new Date()
      }
    });

    await prisma.solicitacaoExclusao.update({
      where: { id: s.id },
      data: { status: 'concluido' }
    });
  }
}
```

#### 5. Retenção de Dados

```javascript
// Política de retenção
const RETENCAO_LOCALIZACOES = 90;  // dias
const RETENCAO_VIAGENS = 365;       // dias
const RETENCAO_LOGS = 30;           // dias

// Job de limpeza (executar diariamente)
async function limparDadosAntigos() {
  const agora = new Date();

  // Deletar localizações antigas
  const limiteLocalizacoes = new Date(agora - RETENCAO_LOCALIZACOES * 24 * 60 * 60 * 1000);
  await prisma.localizacao.deleteMany({
    where: { timestamp: { lt: limiteLocalizacoes } }
  });

  // Deletar viagens antigas
  const limiteViagens = new Date(agora - RETENCAO_VIAGENS * 24 * 60 * 60 * 1000);
  await prisma.viagem.deleteMany({
    where: { fim: { lt: limiteViagens } }
  });

  // Deletar logs antigos
  const limiteLogs = new Date(agora - RETENCAO_LOGS * 24 * 60 * 60 * 1000);
  await prisma.logServidor.deleteMany({
    where: { timestamp: { lt: limiteLogs } }
  });

  console.log(`[LGPD] Limpeza concluída: ${new Date().toISOString()}`);
}

// Agendar execução diária às 3:00
const cron = require('node-cron');
cron.schedule('0 3 * * *', limparDadosAntigos);
```

#### 6. Registro de Atividades de Tratamento (ROPA)

```javascript
// Model para auditoria LGPD
model AuditLog {
  id              Int       @id @default(autoincrement())
  acao            String    // 'ACESSO', 'MODIFICACAO', 'EXCLUSAO', 'EXPORTACAO'
  tabela          String    // 'localizacao', 'usuario', 'dispositivo'
  registro_id     Int?
  usuario_id      Int?
  ip              String
  user_agent      String?
  dados_antes     Json?     // Estado anterior (para modificações)
  dados_depois    Json?     // Estado novo
  timestamp       DateTime  @default(now())
}

// Middleware de auditoria
const auditar = (acao, tabela) => async (req, res, next) => {
  const original = res.json;

  res.json = function(data) {
    // Registrar após resposta bem-sucedida
    if (res.statusCode < 400) {
      prisma.auditLog.create({
        data: {
          acao,
          tabela,
          registro_id: data?.id,
          usuario_id: req.user?.id,
          ip: req.ip,
          user_agent: req.headers['user-agent'],
          dados_depois: data
        }
      }).catch(console.error);
    }

    return original.call(this, data);
  };

  next();
};

// Uso
router.get('/localizacoes/:imei', authenticate, auditar('ACESSO', 'localizacao'), getLocalizacoes);
router.post('/dispositivos', authenticate, auditar('CRIACAO', 'dispositivo'), createDispositivo);
```

---

## PARTE 3: CHECKLIST DE IMPLEMENTAÇÃO

### Semana 1 (CRÍTICO)

- [ ] Alterar senha do PostgreSQL (32+ chars)
- [ ] Adicionar `.env` ao `.gitignore`
- [ ] Implementar autenticação JWT básica
- [ ] Restringir CORS para domínios específicos
- [ ] Instalar e configurar Helmet.js
- [ ] Mascarar IMEIs nos logs

### Semana 2 (ALTO)

- [ ] Implementar validação de entrada (Zod)
- [ ] Adicionar rate limiting
- [ ] Implementar autorização por roles (RBAC)
- [ ] Proteger WebSocket com autenticação
- [ ] Remover `forcarCorte` - exigir aprovação

### Semana 3-4 (LGPD)

- [ ] Criar Política de Privacidade
- [ ] Implementar endpoint `/meus-dados`
- [ ] Implementar endpoint `/excluir-meus-dados`
- [ ] Configurar retenção automática de dados
- [ ] Implementar registro de consentimento
- [ ] Criar tabela de auditoria (ROPA)

### Mês 2 (MELHORIAS)

- [ ] Implementar 2FA para admins
- [ ] Configurar TLS no TCP (se suportado)
- [ ] Realizar pentest
- [ ] Treinar equipe em LGPD
- [ ] Nomear DPO (Encarregado de Dados)

---

## MODELO DE POLÍTICA DE PRIVACIDADE

```markdown
# Política de Privacidade - Sistema de Rastreamento

## 1. Dados Coletados

Coletamos os seguintes dados:
- **Localização GPS**: Latitude, longitude, velocidade, direção
- **Dados do Veículo**: Placa, modelo, odômetro
- **Dados Técnicos**: IMEI do rastreador, tensão da bateria

## 2. Finalidade

Os dados são utilizados para:
- Rastreamento em tempo real do veículo
- Histórico de rotas e viagens
- Alertas de velocidade e cercas virtuais
- Relatórios de uso

## 3. Base Legal

- **Execução de contrato**: Serviço de rastreamento contratado
- **Consentimento**: Para funcionalidades opcionais

## 4. Compartilhamento

Seus dados NÃO são vendidos. Podem ser compartilhados com:
- Autoridades policiais (mediante ordem judicial)
- Seguradoras (com seu consentimento expresso)

## 5. Retenção

- Localizações: 90 dias
- Histórico de viagens: 1 ano
- Dados de conta: Enquanto ativo + 5 anos

## 6. Seus Direitos

Você pode:
- Acessar seus dados (/meus-dados)
- Exportar seus dados
- Solicitar exclusão (/excluir-meus-dados)
- Revogar consentimento

## 7. Contato

DPO: dpo@suaempresa.com.br
Telefone: (XX) XXXX-XXXX

Última atualização: DD/MM/AAAA
```

---

## CONTATOS IMPORTANTES

- **ANPD** (Autoridade Nacional de Proteção de Dados): https://www.gov.br/anpd
- **Denúncias LGPD**: https://www.gov.br/anpd/pt-br/canais_atendimento
- **Prazo para comunicar incidentes**: 2 dias úteis após conhecimento

---

## CONCLUSÃO

A plataforma atual possui **vulnerabilidades críticas** que precisam ser corrigidas **imediatamente**. A conformidade LGPD também precisa ser implementada para evitar multas de até **2% do faturamento** (limitado a R$ 50 milhões por infração).

**Prioridade:**
1. 🔴 Segurança básica (autenticação, senhas) - 24-48h
2. 🟠 Proteções adicionais (validação, rate limit) - 1 semana
3. 🟡 Conformidade LGPD - 2-4 semanas
