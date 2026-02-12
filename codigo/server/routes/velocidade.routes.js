/**
 * Rotas de API para Log de Velocidade
 * Gera histórico e gráficos de velocidade
 * ✅ Multi-tenant: Filtra por organização do usuário
 */

const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');

// ✅ Multi-tenant: Middleware de verificação de propriedade
const { verificarDispositivoTenant, criarFiltroTenant } = require('../middleware/tenant-device.middleware');

// Wrapper para async/await
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/velocidade - Lista todos dispositivos com links para gráficos
// ✅ Multi-tenant: Filtra dispositivos por organização
router.get('/', asyncHandler(async (req, res) => {
  // Construir filtro de tenant
  const tenantFilter = criarFiltroTenant(req);

  const dispositivos = await prisma.dispositivo.findMany({
    where: tenantFilter,
    select: {
      id: true,
      imei: true,
      veiculo: true,
      tipo: true,
      status: true,
      ultima_conexao: true,
    },
    orderBy: { updated_at: 'desc' },
  });

  res.json({
    sucesso: true,
    total: dispositivos.length,
    dispositivos: dispositivos.map(d => ({
      imei: d.imei,
      nome: d.veiculo || `Dispositivo ${d.imei}`,
      tipo: d.tipo,
      status: d.status,
      ultima_conexao: d.ultima_conexao,
      links: {
        historico: `/api/velocidade/${d.imei}/historico`,
        grafico: `/api/velocidade/${d.imei}/grafico`,
        grafico_24h: `/api/velocidade/${d.imei}/grafico?horas=24`,
        grafico_7d: `/api/velocidade/${d.imei}/grafico?horas=168`,
      },
    })),
  });
}));

// GET /api/velocidade/:imei/historico - Dados de velocidade em JSON
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/historico', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;
  const limite = parseInt(req.query.limite) || 1000;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    select: {
      timestamp: true,
      velocidade: true,
      latitude: true,
      longitude: true,
      ignicao: true,
    },
    orderBy: { timestamp: 'asc' },
    take: limite,
  });

  // Calcular estatísticas
  const velocidades = localizacoes.map(l => l.velocidade || 0);
  const velocidadeMedia = velocidades.length > 0
    ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length
    : 0;
  const velocidadeMax = velocidades.length > 0 ? Math.max(...velocidades) : 0;
  const velocidadeMin = velocidades.length > 0 ? Math.min(...velocidades.filter(v => v > 0)) : 0;

  // Detectar períodos em movimento (velocidade > 5 km/h)
  let tempoMovimento = 0;
  let tempoParado = 0;
  for (let i = 1; i < localizacoes.length; i++) {
    const diff = (new Date(localizacoes[i].timestamp) - new Date(localizacoes[i-1].timestamp)) / 1000 / 60; // minutos
    if (localizacoes[i].velocidade > 5) {
      tempoMovimento += diff;
    } else {
      tempoParado += diff;
    }
  }

  res.json({
    sucesso: true,
    dados: {
      dispositivo: {
        imei: dispositivo.imei,
        nome: dispositivo.veiculo || `Dispositivo ${imei}`,
        tipo: dispositivo.tipo,
      },
      periodo: {
        inicio: dataInicio,
        fim: new Date(),
        horas,
      },
      estatisticas: {
        total_registros: localizacoes.length,
        velocidade_media: parseFloat(velocidadeMedia.toFixed(1)),
        velocidade_max: velocidadeMax,
        velocidade_min: velocidadeMin || 0,
        tempo_movimento_min: parseFloat(tempoMovimento.toFixed(1)),
        tempo_parado_min: parseFloat(tempoParado.toFixed(1)),
      },
      registros: localizacoes.map(l => ({
        timestamp: l.timestamp,
        velocidade: l.velocidade || 0,
        ignicao: l.ignicao,
        posicao: { lat: l.latitude, lng: l.longitude },
      })),
    },
  });
}));

// GET /api/velocidade/:imei/grafico - Página HTML com gráfico interativo
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/grafico', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    select: {
      timestamp: true,
      velocidade: true,
      ignicao: true,
    },
    orderBy: { timestamp: 'asc' },
    take: 2000,
  });

  // Preparar dados para o gráfico
  const labels = localizacoes.map(l => {
    const d = new Date(l.timestamp);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  });
  const velocidades = localizacoes.map(l => l.velocidade || 0);
  const ignicoes = localizacoes.map(l => l.ignicao ? 1 : 0);

  // Calcular estatísticas
  const velocidadeMedia = velocidades.length > 0
    ? velocidades.reduce((a, b) => a + b, 0) / velocidades.length
    : 0;
  const velocidadeMax = velocidades.length > 0 ? Math.max(...velocidades) : 0;

  const nomeDispositivo = dispositivo.veiculo || `Dispositivo ${imei}`;

  // Gerar HTML com Chart.js
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Velocidade - ${nomeDispositivo}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 15px;
      backdrop-filter: blur(10px);
    }
    .header h1 { font-size: 2em; margin-bottom: 10px; }
    .header .imei { color: #00d9ff; font-family: monospace; font-size: 1.1em; }
    .header .periodo { color: #aaa; margin-top: 10px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: rgba(255,255,255,0.1);
      border-radius: 15px;
      padding: 20px;
      text-align: center;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .stat-card .value {
      font-size: 2.5em;
      font-weight: bold;
      color: #00d9ff;
    }
    .stat-card .label { color: #aaa; margin-top: 5px; }
    .stat-card.max .value { color: #ff6b6b; }
    .stat-card.avg .value { color: #4ecdc4; }
    .stat-card.records .value { color: #a8e6cf; }
    .chart-container {
      background: rgba(255,255,255,0.05);
      border-radius: 15px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .chart-wrapper { height: 400px; position: relative; }
    .controls {
      display: flex;
      gap: 10px;
      justify-content: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 25px;
      cursor: pointer;
      font-weight: bold;
      transition: all 0.3s;
      text-decoration: none;
      color: #fff;
    }
    .btn-primary { background: linear-gradient(135deg, #00d9ff, #0099cc); }
    .btn-primary:hover { transform: scale(1.05); box-shadow: 0 5px 20px rgba(0,217,255,0.4); }
    .btn-secondary { background: rgba(255,255,255,0.2); }
    .btn-secondary:hover { background: rgba(255,255,255,0.3); }
    .btn.active { box-shadow: 0 0 15px rgba(0,217,255,0.6); }
    .footer {
      text-align: center;
      padding: 20px;
      color: #666;
      font-size: 0.9em;
    }
    .back-link {
      display: inline-block;
      margin-bottom: 20px;
      color: #00d9ff;
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/velocidade" class="back-link">&larr; Voltar para lista de dispositivos</a>

    <div class="header">
      <h1>${nomeDispositivo}</h1>
      <div class="imei">IMEI: ${imei}</div>
      <div class="periodo">Período: últimas ${horas} horas (${dispositivo.tipo || 'GPS'})</div>
    </div>

    <div class="controls">
      <a href="?horas=1" class="btn ${horas === 1 ? 'btn-primary active' : 'btn-secondary'}">1 hora</a>
      <a href="?horas=6" class="btn ${horas === 6 ? 'btn-primary active' : 'btn-secondary'}">6 horas</a>
      <a href="?horas=12" class="btn ${horas === 12 ? 'btn-primary active' : 'btn-secondary'}">12 horas</a>
      <a href="?horas=24" class="btn ${horas === 24 ? 'btn-primary active' : 'btn-secondary'}">24 horas</a>
      <a href="?horas=48" class="btn ${horas === 48 ? 'btn-primary active' : 'btn-secondary'}">48 horas</a>
      <a href="?horas=168" class="btn ${horas === 168 ? 'btn-primary active' : 'btn-secondary'}">7 dias</a>
    </div>

    <div class="stats">
      <div class="stat-card max">
        <div class="value">${velocidadeMax}</div>
        <div class="label">Velocidade Máxima (km/h)</div>
      </div>
      <div class="stat-card avg">
        <div class="value">${velocidadeMedia.toFixed(1)}</div>
        <div class="label">Velocidade Média (km/h)</div>
      </div>
      <div class="stat-card records">
        <div class="value">${localizacoes.length}</div>
        <div class="label">Total de Registros</div>
      </div>
    </div>

    <div class="chart-container">
      <h3 style="margin-bottom: 15px; color: #00d9ff;">Gráfico de Velocidade</h3>
      <div class="chart-wrapper">
        <canvas id="velocidadeChart"></canvas>
      </div>
    </div>

    <div class="chart-container">
      <h3 style="margin-bottom: 15px; color: #4ecdc4;">Ignição (ON/OFF)</h3>
      <div class="chart-wrapper" style="height: 150px;">
        <canvas id="ignicaoChart"></canvas>
      </div>
    </div>

    <div class="footer">
      <p>Sistema de Rastreamento GPS - Atualizado em ${new Date().toLocaleString('pt-BR')}</p>
      <p style="margin-top: 10px;">
        <a href="/api/velocidade/${imei}/historico?horas=${horas}" style="color: #00d9ff;">
          Download JSON dos dados
        </a>
      </p>
    </div>
  </div>

  <script>
    const labels = ${JSON.stringify(labels)};
    const velocidades = ${JSON.stringify(velocidades)};
    const ignicoes = ${JSON.stringify(ignicoes)};

    // Gráfico de Velocidade
    const ctxVel = document.getElementById('velocidadeChart').getContext('2d');
    new Chart(ctxVel, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Velocidade (km/h)',
          data: velocidades,
          borderColor: '#00d9ff',
          backgroundColor: 'rgba(0, 217, 255, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: velocidades.length > 200 ? 0 : 3,
          pointHoverRadius: 5,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            labels: { color: '#fff' }
          },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleColor: '#00d9ff',
            bodyColor: '#fff',
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#888',
              maxTicksLimit: 12,
              maxRotation: 45,
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#888' },
            grid: { color: 'rgba(255,255,255,0.1)' },
            title: {
              display: true,
              text: 'km/h',
              color: '#888'
            }
          }
        }
      }
    });

    // Gráfico de Ignição
    const ctxIgn = document.getElementById('ignicaoChart').getContext('2d');
    new Chart(ctxIgn, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Ignição',
          data: ignicoes,
          borderColor: '#4ecdc4',
          backgroundColor: 'rgba(78, 205, 196, 0.3)',
          fill: true,
          stepped: true,
          pointRadius: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#fff' }
          }
        },
        scales: {
          x: {
            ticks: {
              color: '#888',
              maxTicksLimit: 12,
              display: false,
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
            min: 0,
            max: 1,
            ticks: {
              color: '#888',
              callback: function(value) {
                return value === 1 ? 'ON' : 'OFF';
              }
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          }
        }
      }
    });
  </script>
</body>
</html>
`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

// GET /api/velocidade/:imei/exportar - Exportar dados em CSV
// ✅ Multi-tenant: Verifica propriedade do dispositivo
router.get('/:imei/exportar', verificarDispositivoTenant, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
  });

  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  const localizacoes = await prisma.localizacao.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataInicio },
    },
    select: {
      timestamp: true,
      velocidade: true,
      latitude: true,
      longitude: true,
      ignicao: true,
    },
    orderBy: { timestamp: 'asc' },
  });

  // Gerar CSV
  const csvHeader = 'Data/Hora,Velocidade (km/h),Latitude,Longitude,Ignição\n';
  const csvRows = localizacoes.map(l => {
    const data = new Date(l.timestamp).toLocaleString('pt-BR');
    return `"${data}",${l.velocidade || 0},${l.latitude},${l.longitude},${l.ignicao ? 'ON' : 'OFF'}`;
  }).join('\n');

  const csv = csvHeader + csvRows;
  const filename = `velocidade_${imei}_${new Date().toISOString().split('T')[0]}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));

// GET /api/velocidade/comparar - Comparar velocidade de múltiplos dispositivos
// ✅ Multi-tenant: Filtra dispositivos por organização
router.get('/comparar/grafico', asyncHandler(async (req, res) => {
  const imeis = req.query.imeis?.split(',') || [];
  const horas = parseInt(req.query.horas) || 24;

  // Construir filtro de tenant
  const tenantFilter = criarFiltroTenant(req);

  if (imeis.length === 0) {
    // Buscar dispositivos da organização
    const dispositivos = await prisma.dispositivo.findMany({
      where: tenantFilter,
      select: { imei: true, veiculo: true },
    });

    return res.json({
      sucesso: true,
      mensagem: 'Use ?imeis=imei1,imei2,imei3 para comparar dispositivos',
      dispositivos_disponiveis: dispositivos.map(d => ({
        imei: d.imei,
        nome: d.veiculo || `Dispositivo ${d.imei}`,
      })),
      exemplo: `/api/velocidade/comparar/grafico?imeis=${dispositivos.slice(0, 3).map(d => d.imei).join(',')}&horas=24`,
    });
  }

  const dataInicio = new Date();
  dataInicio.setHours(dataInicio.getHours() - horas);

  // Buscar dados de cada dispositivo
  const dadosDispositivos = await Promise.all(imeis.map(async (imei) => {
    const dispositivo = await prisma.dispositivo.findUnique({
      where: { imei: imei.trim() },
    });

    if (!dispositivo) return null;

    const localizacoes = await prisma.localizacao.findMany({
      where: {
        dispositivo_id: dispositivo.id,
        timestamp: { gte: dataInicio },
      },
      select: {
        timestamp: true,
        velocidade: true,
      },
      orderBy: { timestamp: 'asc' },
      take: 500,
    });

    return {
      imei: dispositivo.imei,
      nome: dispositivo.veiculo || `Dispositivo ${imei}`,
      dados: localizacoes,
    };
  }));

  const dispositivosValidos = dadosDispositivos.filter(d => d !== null);

  // Cores para cada dispositivo
  const cores = ['#00d9ff', '#ff6b6b', '#4ecdc4', '#f7dc6f', '#bb8fce', '#82e0aa'];

  const datasets = dispositivosValidos.map((d, i) => ({
    nome: d.nome,
    imei: d.imei,
    cor: cores[i % cores.length],
    labels: d.dados.map(l => new Date(l.timestamp).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    })),
    velocidades: d.dados.map(l => l.velocidade || 0),
  }));

  // Gerar HTML comparativo
  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Comparativo de Velocidade</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
      padding: 20px;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 15px;
    }
    .chart-container {
      background: rgba(255,255,255,0.05);
      border-radius: 15px;
      padding: 20px;
    }
    .chart-wrapper { height: 500px; }
    .legend-item {
      display: inline-block;
      margin: 10px 15px;
      padding: 5px 15px;
      border-radius: 20px;
      background: rgba(255,255,255,0.1);
    }
    .back-link {
      display: inline-block;
      margin-bottom: 20px;
      color: #00d9ff;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/velocidade" class="back-link">&larr; Voltar</a>

    <div class="header">
      <h1>Comparativo de Velocidade</h1>
      <p style="color: #aaa; margin-top: 10px;">Últimas ${horas} horas</p>
      <div style="margin-top: 15px;">
        ${datasets.map(d => `
          <span class="legend-item" style="border-left: 4px solid ${d.cor}">
            ${d.nome}
          </span>
        `).join('')}
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-wrapper">
        <canvas id="comparativoChart"></canvas>
      </div>
    </div>
  </div>

  <script>
    const datasets = ${JSON.stringify(datasets)};

    const ctx = document.getElementById('comparativoChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        datasets: datasets.map(d => ({
          label: d.nome,
          data: d.velocidades.map((v, i) => ({ x: d.labels[i], y: v })),
          borderColor: d.cor,
          backgroundColor: d.cor + '20',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            labels: { color: '#fff' }
          }
        },
        scales: {
          x: {
            type: 'category',
            ticks: { color: '#888', maxTicksLimit: 12 },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#888' },
            grid: { color: 'rgba(255,255,255,0.1)' },
            title: { display: true, text: 'km/h', color: '#888' }
          }
        }
      }
    });
  </script>
</body>
</html>
`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

module.exports = router;
