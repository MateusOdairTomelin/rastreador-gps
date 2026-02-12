// API Base URL
const API_URL = '/api';

// DOM Elements
const navLinks = document.querySelectorAll('.sidebar a');
const views = document.querySelectorAll('.view');
const formAddDevice = document.getElementById('form-add-device');
const devicesList = document.getElementById('devices-list');
const monitoringGrid = document.getElementById('monitoring-grid');

// Navigation
navLinks.forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const viewName = link.getAttribute('data-view');
    showView(viewName);

    // Update active link
    navLinks.forEach(l => l.classList.remove('active'));
    link.classList.add('active');
  });
});

function showView(viewName) {
  // Hide all views
  views.forEach(v => v.classList.remove('active'));

  // Show selected view
  const selectedView = document.getElementById(`view-${viewName}`);
  if (selectedView) {
    selectedView.classList.add('active');
  }

  // Load data based on view
  if (viewName === 'devices') {
    loadDevices();
  } else if (viewName === 'monitoring') {
    loadMonitoring();
  }
}

// Form Submission
formAddDevice.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData);

  // Filter out empty values
  const cleanData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== '') {
      cleanData[key] = value;
    }
  }

  try {
    const response = await fetch(`${API_URL}/dispositivos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanData),
    });

    const result = await response.json();

    if (result.sucesso) {
      showSuccessMessage('✅ Dispositivo cadastrado com sucesso!');
      e.target.reset();

      // Redirect to devices view after 1.5 seconds
      setTimeout(() => {
        const devicesLink = document.querySelector('[data-view="devices"]');
        if (devicesLink) {
          devicesLink.click();
        }
      }, 1500);
    } else {
      showErrorMessage('❌ Erro: ' + (result.mensagem || 'Erro ao cadastrar'));
    }
  } catch (error) {
    showErrorMessage('❌ Erro ao cadastrar: ' + error.message);
    console.error('Error:', error);
  }
});

// Load devices list
async function loadDevices() {
  try {
    devicesList.innerHTML = '<div class="loading"><div class="spinner"></div><p>Carregando...</p></div>';

    const response = await fetch(`${API_URL}/dispositivos`);
    const result = await response.json();

    if (!result.sucesso || result.dados.length === 0) {
      devicesList.innerHTML = '<div class="empty-state"><p>Nenhum dispositivo cadastrado.</p><p>Clique em "Adicionar" para cadastrar um novo rastreador.</p></div>';
      return;
    }

    devicesList.innerHTML = result.dados.map(device => `
      <div class="device-card">
        <h3>
          ${device.veiculo || 'Sem nome'} - ${device.placa || 'Sem placa'}
          <span class="device-status ${device.status}">${device.status === 'online' ? '🟢 Online' : '🔴 Offline'}</span>
        </h3>
        <div class="device-info">
          <div>
            <strong>IMEI</strong>
            <span>${device.imei}</span>
          </div>
          <div>
            <strong>Tipo</strong>
            <span>${device.tipo}</span>
          </div>
          <div>
            <strong>Operadora</strong>
            <span>${device.operadora || 'N/A'}</span>
          </div>
          <div>
            <strong>IMEI Chip</strong>
            <span>${device.imei_chip || 'N/A'}</span>
          </div>
          <div>
            <strong>APN</strong>
            <span>${device.apn || 'N/A'}</span>
          </div>
          <div>
            <strong>Última Conexão</strong>
            <span>${formatDate(device.ultima_conexao)}</span>
          </div>
          ${device.latitude !== null ? `
            <div>
              <strong>Latitude</strong>
              <span>${formatNumber(device.latitude)}</span>
            </div>
            <div>
              <strong>Longitude</strong>
              <span>${formatNumber(device.longitude)}</span>
            </div>
          ` : ''}
        </div>
      </div>
    `).join('');
  } catch (error) {
    devicesList.innerHTML = `<div class="error-message">Erro ao carregar dispositivos: ${error.message}</div>`;
    console.error('Error loading devices:', error);
  }
}

// Load monitoring data
async function loadMonitoring() {
  try {
    monitoringGrid.innerHTML = '<div class="loading"><div class="spinner"></div><p>Carregando telemetria...</p></div>';

    const response = await fetch(`${API_URL}/dispositivos`);
    const result = await response.json();

    if (!result.sucesso || result.dados.length === 0) {
      monitoringGrid.innerHTML = '<div class="empty-state"><p>Nenhum dispositivo para monitorar.</p></div>';
      return;
    }

    const cards = await Promise.all(result.dados.map(async device => {
      try {
        const obd2Response = await fetch(`${API_URL}/dispositivos/${device.imei}/obd2-atual`);
        const obd2Result = await obd2Response.json();
        const obd2 = obd2Result.dados || {};

        return `
          <div class="monitoring-card">
            <h3>
              ${device.veiculo || 'N/A'} - ${device.placa || 'N/A'}
              <span class="device-status ${device.status}">${device.status === 'online' ? '🟢 Online' : '🔴 Offline'}</span>
            </h3>
            <div class="telemetry-grid">
              <div class="telemetry-item">
                <div class="label">Odômetro Plataforma</div>
                <div class="value">${formatNumber(obd2.odometro_plataforma)}</div>
                <div class="unit">km</div>
              </div>
              <div class="telemetry-item">
                <div class="label">Odômetro Embarcado</div>
                <div class="value">${formatNumber(obd2.odometro_embarcado)}</div>
                <div class="unit">km</div>
              </div>
              <div class="telemetry-item">
                <div class="label">Horímetro Plataforma</div>
                <div class="value">${formatNumber(obd2.hora_motor_plataforma)}</div>
                <div class="unit">h</div>
              </div>
              <div class="telemetry-item">
                <div class="label">Horímetro Embarcado</div>
                <div class="value">${formatNumber(obd2.hora_motor_embarcada)}</div>
                <div class="unit">h</div>
              </div>
              <div class="telemetry-item">
                <div class="label">Bateria</div>
                <div class="value">${formatNumber(obd2.percentual_bateria)}</div>
                <div class="unit">%</div>
              </div>
              <div class="telemetry-item">
                <div class="label">Tensão Bateria</div>
                <div class="value">${formatNumber(obd2.tensao_bateria)}</div>
                <div class="unit">V</div>
              </div>
            </div>
          </div>
        `;
      } catch (error) {
        console.error('Error loading OBD2 for device:', device.imei, error);
        return `
          <div class="monitoring-card">
            <h3>${device.veiculo || 'N/A'}</h3>
            <div class="error-message">Erro ao carregar telemetria</div>
          </div>
        `;
      }
    }));

    monitoringGrid.innerHTML = cards.join('');
  } catch (error) {
    monitoringGrid.innerHTML = `<div class="error-message">Erro ao carregar monitoramento: ${error.message}</div>`;
    console.error('Error loading monitoring:', error);
  }
}

// Helper functions
function formatNumber(value) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const num = parseFloat(value);
  if (isNaN(num)) return 'N/A';
  return num.toFixed(2);
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('pt-BR') + ' ' + date.toLocaleTimeString('pt-BR');
}

function showSuccessMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'success-message';
  messageDiv.textContent = message;

  const content = document.querySelector('.content');
  if (content.firstChild) {
    content.insertBefore(messageDiv, content.firstChild);
  } else {
    content.appendChild(messageDiv);
  }

  setTimeout(() => {
    messageDiv.remove();
  }, 3000);
}

function showErrorMessage(message) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'error-message';
  messageDiv.textContent = message;

  const content = document.querySelector('.content');
  if (content.firstChild) {
    content.insertBefore(messageDiv, content.firstChild);
  } else {
    content.appendChild(messageDiv);
  }

  setTimeout(() => {
    messageDiv.remove();
  }, 5000);
}

// Initial load
loadDevices();
