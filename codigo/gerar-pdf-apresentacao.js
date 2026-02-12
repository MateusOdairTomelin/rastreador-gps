const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Criar documento PDF
const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 50, bottom: 50, left: 50, right: 50 },
  info: {
    Title: 'Sistema de Rastreamento Veicular - Stack Tecnológica',
    Author: 'Equipe de Desenvolvimento',
    Subject: 'Documentação Técnica',
    CreationDate: new Date()
  }
});

// Arquivo de saída
const outputPath = path.join(__dirname, 'public', 'APRESENTACAO_STACK_TECNOLOGICA.pdf');
doc.pipe(fs.createWriteStream(outputPath));

// Cores
const AZUL_ESCURO = '#1a365d';
const AZUL_CLARO = '#3182ce';
const CINZA = '#4a5568';
const VERDE = '#38a169';

// ============================================================================
// CAPA
// ============================================================================
doc.rect(0, 0, doc.page.width, doc.page.height).fill('#1a365d');

doc.fontSize(36)
   .fillColor('white')
   .text('Sistema de Rastreamento', 50, 200, { align: 'center' });

doc.fontSize(36)
   .text('Veicular', { align: 'center' });

doc.moveDown(2);
doc.fontSize(20)
   .text('Stack Tecnológica', { align: 'center' });

doc.moveDown(4);
doc.fontSize(14)
   .text('Documentação para Apresentação', { align: 'center' });

doc.moveDown(1);
doc.fontSize(12)
   .text('Fevereiro 2026', { align: 'center' });

// Rodapé da capa
doc.fontSize(10)
   .text('Confidencial - Uso Interno', 50, doc.page.height - 80, { align: 'center' });

// ============================================================================
// PÁGINA 2 - RESUMO EXECUTIVO
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Resumo Executivo', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(1);
doc.fillColor(CINZA).fontSize(12).text(
  'Sistema completo de rastreamento veicular em tempo real, desenvolvido com arquitetura escalável e segura, capaz de gerenciar milhares de dispositivos GPS simultaneamente.',
  50, 100, { width: 495, align: 'justify' }
);

doc.moveDown(2);
doc.fillColor(AZUL_ESCURO).fontSize(16).text('Principais Características');
doc.moveDown(0.5);

const caracteristicas = [
  'Monitoramento em tempo real de frotas',
  'Suporte a múltiplos protocolos de rastreadores (GT06, XT40, Teltonika)',
  'Arquitetura escalável com Docker e load balancing',
  'Sistema multi-tenant com isolamento de dados',
  'Conformidade com LGPD',
  'Alta disponibilidade e tolerância a falhas'
];

caracteristicas.forEach(item => {
  doc.fillColor(VERDE).fontSize(11).text('✓ ', { continued: true });
  doc.fillColor(CINZA).text(item);
});

// ============================================================================
// PÁGINA 3 - LINGUAGENS E TECNOLOGIAS
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Linguagens de Programação', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

// Tabela de linguagens
const linguagens = [
  { nome: 'JavaScript (Node.js)', uso: 'Backend, APIs, TCP Gateway', percent: '85%' },
  { nome: 'HTML5', uso: 'Frontend, Dashboards', percent: '8%' },
  { nome: 'CSS3', uso: 'Estilização', percent: '5%' },
  { nome: 'SQL', uso: 'Queries de banco de dados', percent: '2%' }
];

let y = 110;
doc.fillColor('white').rect(50, y, 495, 25).fill(AZUL_ESCURO);
doc.fillColor('white').fontSize(11)
   .text('Linguagem', 55, y + 7)
   .text('Uso', 200, y + 7)
   .text('Percentual', 450, y + 7);

y += 25;
linguagens.forEach((lang, i) => {
  const bgColor = i % 2 === 0 ? '#f7fafc' : 'white';
  doc.rect(50, y, 495, 22).fill(bgColor);
  doc.fillColor(CINZA).fontSize(10)
     .text(lang.nome, 55, y + 6)
     .text(lang.uso, 200, y + 6)
     .text(lang.percent, 460, y + 6);
  y += 22;
});

// Stack Backend
doc.moveDown(3);
y = doc.y + 20;
doc.fillColor(AZUL_ESCURO).fontSize(18).text('Stack Backend', 50, y);
doc.moveDown(1);

const backend = [
  { cat: 'Runtime', items: 'Node.js 18, Express.js 5' },
  { cat: 'Banco de Dados', items: 'PostgreSQL 15, TimescaleDB, Prisma ORM' },
  { cat: 'Cache/Filas', items: 'Redis, Bull, ioredis' },
  { cat: 'Tempo Real', items: 'WebSocket (ws), TCP Server' }
];

backend.forEach(item => {
  doc.fillColor(AZUL_CLARO).fontSize(11).text(item.cat + ': ', { continued: true });
  doc.fillColor(CINZA).text(item.items);
  doc.moveDown(0.3);
});

// Stack Frontend
doc.moveDown(1);
doc.fillColor(AZUL_ESCURO).fontSize(18).text('Stack Frontend');
doc.moveDown(0.5);

const frontend = [
  { cat: 'Interface', items: 'HTML5, CSS3, JavaScript Vanilla' },
  { cat: 'Mapas', items: 'Leaflet.js, OpenStreetMap' },
  { cat: 'Gráficos', items: 'Chart.js' },
  { cat: 'UI', items: 'Bootstrap 5, Font Awesome' }
];

frontend.forEach(item => {
  doc.fillColor(AZUL_CLARO).fontSize(11).text(item.cat + ': ', { continued: true });
  doc.fillColor(CINZA).text(item.items);
  doc.moveDown(0.3);
});

// ============================================================================
// PÁGINA 4 - INFRAESTRUTURA
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Infraestrutura e DevOps', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(2);

const infra = [
  { titulo: 'Containerização', desc: 'Docker e Docker Compose para orquestração de 12 serviços' },
  { titulo: 'Load Balancing', desc: 'HAProxy para balanceamento TCP (rastreadores) e HTTP (API)' },
  { titulo: 'Connection Pooling', desc: 'PgBouncer gerenciando até 1000 conexões simultâneas' },
  { titulo: 'Firewall', desc: 'UFW com política deny-by-default' },
  { titulo: 'Proteção', desc: 'Fail2ban com 5 jails ativos contra brute-force' }
];

infra.forEach(item => {
  doc.fillColor(AZUL_ESCURO).fontSize(13).text(item.titulo);
  doc.fillColor(CINZA).fontSize(11).text(item.desc);
  doc.moveDown(1);
});

// Segurança
doc.moveDown(1);
doc.fillColor(AZUL_ESCURO).fontSize(18).text('Segurança Implementada');
doc.moveDown(0.5);

const seguranca = [
  'JWT (JSON Web Tokens) para autenticação',
  'bcrypt para hash de senhas',
  'Helmet.js para headers HTTP seguros',
  'CSRF Protection com tokens Redis',
  'Rate Limiting por IP e endpoint',
  'Validação de IMEI no TCP Gateway',
  'Criptografia de dados sensíveis (LGPD)'
];

seguranca.forEach(item => {
  doc.fillColor(VERDE).fontSize(11).text('🔒 ', { continued: true });
  doc.fillColor(CINZA).text(item);
});

// ============================================================================
// PÁGINA 5 - ARQUITETURA
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Arquitetura do Sistema', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(2);
doc.fillColor(CINZA).fontSize(11).text(
  'O sistema utiliza uma arquitetura de microserviços containerizada, com separação clara de responsabilidades:',
  { width: 495 }
);

doc.moveDown(2);

// Desenhar diagrama simplificado
const boxWidth = 100;
const boxHeight = 40;
const startX = 100;
let startY = doc.y + 20;

// Função para desenhar caixa
function drawBox(x, y, text, color = AZUL_CLARO) {
  doc.rect(x, y, boxWidth, boxHeight).fill(color);
  doc.fillColor('white').fontSize(9).text(text, x, y + 15, { width: boxWidth, align: 'center' });
}

// Internet
doc.fillColor(CINZA).fontSize(10).text('INTERNET', 250, startY);
startY += 25;

// Firewall
drawBox(220, startY, 'UFW Firewall', '#e53e3e');
startY += 60;

// HAProxy
drawBox(120, startY, 'HAProxy\nTCP:8877', AZUL_ESCURO);
drawBox(270, startY, 'HAProxy\nHTTP:62000', AZUL_ESCURO);
startY += 60;

// Gateways e APIs
drawBox(50, startY, 'TCP-GW-1', AZUL_CLARO);
drawBox(160, startY, 'TCP-GW-2', AZUL_CLARO);
drawBox(270, startY, 'API-1', VERDE);
drawBox(380, startY, 'API-2', VERDE);
startY += 60;

// Redis e PgBouncer
drawBox(120, startY, 'Redis\nCache/Queue', '#ed8936');
drawBox(270, startY, 'PgBouncer\nPool', '#ed8936');
startY += 60;

// PostgreSQL
drawBox(195, startY, 'PostgreSQL\nTimescaleDB', '#805ad5');

// Legenda
startY += 70;
doc.fillColor(CINZA).fontSize(10).text('Componentes:', 50, startY);
startY += 15;
doc.rect(50, startY, 15, 15).fill(AZUL_CLARO);
doc.fillColor(CINZA).text('TCP Gateway', 70, startY + 2);
doc.rect(150, startY, 15, 15).fill(VERDE);
doc.text('API Server', 170, startY + 2);
doc.rect(250, startY, 15, 15).fill('#ed8936');
doc.text('Cache/Pool', 270, startY + 2);
doc.rect(350, startY, 15, 15).fill('#805ad5');
doc.text('Database', 370, startY + 2);

// ============================================================================
// PÁGINA 6 - PROTOCOLOS E FUNCIONALIDADES
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Protocolos Suportados', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(2);

const protocolos = [
  { nome: 'GT06/XT40', desc: 'Protocolo binário TCP para rastreadores chineses (mais comum no mercado)' },
  { nome: 'Teltonika', desc: 'Codec8/Codec8E para rastreadores profissionais Teltonika' },
  { nome: 'OBD2', desc: 'Dados de diagnóstico veicular (velocidade, RPM, combustível, erros)' }
];

protocolos.forEach(p => {
  doc.fillColor(AZUL_ESCURO).fontSize(13).text(p.nome);
  doc.fillColor(CINZA).fontSize(11).text(p.desc);
  doc.moveDown(1);
});

doc.moveDown(1);
doc.fillColor(AZUL_ESCURO).fontSize(18).text('Funcionalidades Principais');
doc.moveDown(0.5);

const funcionalidades = [
  { cat: 'Rastreamento', items: 'GPS tempo real, histórico de rotas, replay de trajetos' },
  { cat: 'Geofencing', items: 'Cercas virtuais com alertas de entrada/saída' },
  { cat: 'Alertas', items: 'Velocidade, ignição, bateria, violação de cerca' },
  { cat: 'Relatórios', items: 'Viagens, paradas, consumo, quilometragem' },
  { cat: 'Multi-tenant', items: 'Organizações isoladas com controle de acesso' },
  { cat: 'LGPD', items: 'Anonimização, exportação e exclusão de dados' }
];

funcionalidades.forEach(f => {
  doc.fillColor(AZUL_CLARO).fontSize(11).text(f.cat + ': ', { continued: true });
  doc.fillColor(CINZA).text(f.items);
  doc.moveDown(0.3);
});

// ============================================================================
// PÁGINA 7 - MÉTRICAS E ESCALABILIDADE
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Métricas e Escalabilidade', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(2);
doc.fillColor(AZUL_ESCURO).fontSize(16).text('Métricas do Código');
doc.moveDown(0.5);

const metricas = [
  { nome: 'Arquivos de código', valor: '~150 arquivos' },
  { nome: 'Linhas de código', valor: '~25.000 linhas' },
  { nome: 'Endpoints API', valor: '~80 rotas REST' },
  { nome: 'Modelos de dados', valor: '15 tabelas' },
  { nome: 'Containers Docker', valor: '12 serviços' }
];

y = doc.y + 10;
metricas.forEach((m, i) => {
  const bgColor = i % 2 === 0 ? '#edf2f7' : 'white';
  doc.rect(50, y, 250, 22).fill(bgColor);
  doc.fillColor(CINZA).fontSize(11)
     .text(m.nome, 55, y + 6)
     .text(m.valor, 200, y + 6);
  y += 22;
});

doc.moveDown(4);
doc.fillColor(AZUL_ESCURO).fontSize(16).text('Capacidade de Escalabilidade');
doc.moveDown(0.5);

const escala = [
  { componente: 'TCP Gateways', atual: '3 instâncias', escala: 'Horizontal' },
  { componente: 'API Servers', atual: '2 instâncias', escala: 'Horizontal' },
  { componente: 'Processadores', atual: '3 instâncias', escala: 'Horizontal' },
  { componente: 'Conexões DB', atual: '1000 (pool)', escala: 'Vertical' }
];

y = doc.y + 10;
doc.fillColor('white').rect(50, y, 400, 25).fill(AZUL_ESCURO);
doc.fillColor('white').fontSize(10)
   .text('Componente', 55, y + 7)
   .text('Atual', 180, y + 7)
   .text('Escalabilidade', 300, y + 7);

y += 25;
escala.forEach((e, i) => {
  const bgColor = i % 2 === 0 ? '#f7fafc' : 'white';
  doc.rect(50, y, 400, 22).fill(bgColor);
  doc.fillColor(CINZA).fontSize(10)
     .text(e.componente, 55, y + 6)
     .text(e.atual, 180, y + 6)
     .text(e.escala, 300, y + 6);
  y += 22;
});

doc.moveDown(4);
doc.fillColor(VERDE).fontSize(14).text('Capacidade Estimada: 10.000+ dispositivos simultâneos', { align: 'center' });

// ============================================================================
// PÁGINA 8 - REQUISITOS E DEPENDÊNCIAS
// ============================================================================
doc.addPage();
doc.fillColor(AZUL_ESCURO).fontSize(24).text('Requisitos de Hardware', 50, 50);
doc.moveTo(50, 80).lineTo(545, 80).stroke(AZUL_CLARO);

doc.moveDown(2);

const requisitos = [
  { recurso: 'CPU', minimo: '4 cores', recomendado: '8 cores' },
  { recurso: 'RAM', minimo: '8 GB', recomendado: '16 GB' },
  { recurso: 'Disco', minimo: '100 GB SSD', recomendado: '500 GB SSD' },
  { recurso: 'Rede', minimo: '100 Mbps', recomendado: '1 Gbps' }
];

y = doc.y;
doc.fillColor('white').rect(50, y, 400, 25).fill(AZUL_ESCURO);
doc.fillColor('white').fontSize(11)
   .text('Recurso', 55, y + 7)
   .text('Mínimo', 180, y + 7)
   .text('Recomendado', 300, y + 7);

y += 25;
requisitos.forEach((r, i) => {
  const bgColor = i % 2 === 0 ? '#f7fafc' : 'white';
  doc.rect(50, y, 400, 22).fill(bgColor);
  doc.fillColor(CINZA).fontSize(10)
     .text(r.recurso, 55, y + 6)
     .text(r.minimo, 180, y + 6)
     .text(r.recomendado, 300, y + 6);
  y += 22;
});

doc.moveDown(4);
doc.fillColor(AZUL_ESCURO).fontSize(16).text('Principais Dependências');
doc.moveDown(0.5);

const deps = [
  { lib: 'express', versao: '5.2.1', funcao: 'Framework web' },
  { lib: '@prisma/client', versao: '5.22.0', funcao: 'ORM PostgreSQL' },
  { lib: 'ioredis', versao: '5.8.2', funcao: 'Cliente Redis' },
  { lib: 'bull', versao: '4.16.5', funcao: 'Filas de processamento' },
  { lib: 'ws', versao: '8.18.3', funcao: 'WebSocket server' },
  { lib: 'jsonwebtoken', versao: '9.0.3', funcao: 'Autenticação JWT' },
  { lib: 'helmet', versao: '8.1.0', funcao: 'Segurança HTTP' },
  { lib: 'pdfkit', versao: '0.17.2', funcao: 'Geração de PDFs' }
];

y = doc.y + 10;
doc.fillColor('white').rect(50, y, 450, 25).fill(AZUL_ESCURO);
doc.fillColor('white').fontSize(10)
   .text('Biblioteca', 55, y + 7)
   .text('Versão', 180, y + 7)
   .text('Função', 280, y + 7);

y += 25;
deps.forEach((d, i) => {
  const bgColor = i % 2 === 0 ? '#f7fafc' : 'white';
  doc.rect(50, y, 450, 20).fill(bgColor);
  doc.fillColor(CINZA).fontSize(9)
     .text(d.lib, 55, y + 5)
     .text(d.versao, 180, y + 5)
     .text(d.funcao, 280, y + 5);
  y += 20;
});

// ============================================================================
// ÚLTIMA PÁGINA - CONTATO
// ============================================================================
doc.addPage();
doc.rect(0, 0, doc.page.width, doc.page.height).fill(AZUL_ESCURO);

doc.fillColor('white').fontSize(28).text('Obrigado!', 50, 250, { align: 'center' });

doc.moveDown(2);
doc.fontSize(14).text('Sistema de Rastreamento Veicular', { align: 'center' });
doc.moveDown(0.5);
doc.fontSize(12).text('Documentação Técnica para Apresentação', { align: 'center' });

doc.moveDown(4);
doc.fontSize(10).text('Desenvolvido com Node.js, PostgreSQL, Redis e Docker', { align: 'center' });
doc.moveDown(0.5);
doc.text('Arquitetura escalável e segura', { align: 'center' });

doc.moveDown(4);
doc.fontSize(9).text('Fevereiro 2026', { align: 'center' });

// Finalizar
doc.end();

console.log('✅ PDF gerado com sucesso:', outputPath);
