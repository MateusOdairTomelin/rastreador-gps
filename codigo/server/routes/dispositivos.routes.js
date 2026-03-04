const express = require('express');
const router = express.Router();
const prisma = require('../db/prisma');
const dispositivoService = require('../services/dispositivo.service');
const localizacaoService = require('../services/localizacao.service');
const obd2Service = require('../services/obd2.service');
const alarmeService = require('../services/alarme.service');
const heartbeatService = require('../services/heartbeat.service');
const consultaPlacaService = require('../services/consulta-placa.service');
const grupoService = require('../services/grupo.service');
const { getAllDeviceTypes, getDeviceTypeInfo, getHomologatedDeviceTypes, getDefaultConfig, supportsOBD2 } = require('../constants/device-types');
const { getAllVehicleProfiles, getVehicleProfile, suggestProfileByYear } = require('../constants/vehicle-profiles');
const calibracaoService = require('../services/calibracao.service');
const { verificarPermissao } = require('../middleware/permissao.middleware');

// ✅ Serviço de filtro GPS (Kalman + OSRM Map-Matching)
let gpsFilterService = null;
try {
  gpsFilterService = require('../services/gps-filter.service');
  console.log('[Rotas] GPS Filter Service carregado para interpolação');
} catch (e) {
  console.warn('[Rotas] GPS Filter Service não disponível:', e.message);
}

// Error handler wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Cache para lista de dispositivos (TTL 5s)
let dispositivosCache = new Map();
const DISPOSITIVOS_CACHE_TTL = 5000; // 5 segundos
let dispositivosFetching = new Map(); // Evitar fetches paralelos

// Cache para dispositivos não atribuídos (TTL 10s)
let naoAtribuidosCache = null;
let naoAtribuidosCacheTime = 0;
const NAO_ATRIBUIDOS_CACHE_TTL = 10000;

// Cache genérico por IMEI (TTL 3s) - evita múltiplas chamadas do mesmo endpoint
const imeiCache = new Map();
const IMEI_CACHE_TTL = 3000;

// ✅ Multi-tenant: Verifica se dispositivo pertence à organização do usuário
const verificarPropriedadeDispositivo = async (req, res, next) => {
  const { imei } = req.params;
  if (!imei) return next();

  const dispositivo = await dispositivoService.getByImei(imei);
  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Super admin pode acessar qualquer dispositivo
  if (req.tenant?.isSuperAdmin) {
    req.dispositivo = dispositivo;
    return next();
  }

  // Verificar se pertence à organização do usuário
  if (req.tenant?.id && dispositivo.organizacao_id !== req.tenant.id) {
    return res.status(403).json({
      sucesso: false,
      mensagem: 'Dispositivo não pertence à sua organização',
    });
  }

  req.dispositivo = dispositivo;
  next();
};

// ============ ENDPOINTS DE TIPOS DE DISPOSITIVO ============

// GET /api/dispositivos/tipos - Lista apenas tipos HOMOLOGADOS (para dashboard)
router.get('/tipos', (req, res) => {
  const { todos } = req.query;

  // Se ?todos=true, retorna todos os tipos (para admin/debug)
  // Caso contrário, retorna apenas os homologados
  const tipos = todos === 'true' ? getAllDeviceTypes() : getHomologatedDeviceTypes();

  res.json({
    sucesso: true,
    total: tipos.length,
    tipos,
    mensagem: 'Use PUT /api/dispositivos/:imei/tipo para alterar o tipo de um dispositivo',
    nota: todos === 'true' ? 'Mostrando TODOS os tipos' : 'Mostrando apenas tipos HOMOLOGADOS',
  });
});

// GET /api/dispositivos/tipos/:tipoId - Get info about a specific type
router.get('/tipos/:tipoId', (req, res) => {
  const { tipoId } = req.params;
  const tipoInfo = getDeviceTypeInfo(tipoId);

  if (!tipoInfo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Tipo '${tipoId}' não encontrado`,
      tipos_disponiveis: getAllDeviceTypes().map(t => t.id),
    });
  }

  res.json({
    sucesso: true,
    tipo: tipoInfo,
  });
});

// PUT /api/dispositivos/:imei/tipo - Update device type
router.put('/:imei/tipo', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { tipo } = req.body;

  if (!tipo) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Tipo não especificado',
      uso: '{ "tipo": "XT40_4F" }',
      tipos_disponiveis: getAllDeviceTypes().map(t => t.id),
    });
  }

  try {
    const device = await dispositivoService.updateType(imei, tipo);
    const tipoInfo = getDeviceTypeInfo(tipo);

    res.json({
      sucesso: true,
      mensagem: `Tipo do dispositivo ${imei} atualizado para ${tipo}`,
      dados: device,
      tipo_info: tipoInfo,
    });
  } catch (error) {
    if (error.message.includes('Tipo inválido')) {
      return res.status(400).json({
        sucesso: false,
        mensagem: error.message,
        tipos_disponiveis: getAllDeviceTypes().map(t => t.id),
      });
    }
    throw error;
  }
}));

// ============ ENDPOINTS DE DISPOSITIVOS ============

/**
 * POST /api/dispositivos/pre-cadastro
 * Pré-cadastrar um dispositivo (IMEI) antes dele conectar
 * ✅ Admin da organização pode pré-cadastrar dispositivos
 * ✅ Se informar placa, consulta dados e cria veículo automaticamente
 * Quando o dispositivo conectar, será automaticamente vinculado à organização
 */
router.post('/pre-cadastro', asyncHandler(async (req, res) => {
  const { imei, placa, tipo, odometro_total } = req.body;

  // Validação
  if (!imei) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'IMEI é obrigatório',
    });
  }

  // Validar formato do IMEI (15 dígitos)
  if (!/^\d{15}$/.test(imei)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'IMEI deve ter 15 dígitos numéricos',
    });
  }

  // Verificar se já existe
  const existente = await dispositivoService.getByImei(imei);
  if (existente) {
    // Se já existe e tem organização, verificar se é a mesma
    if (existente.organizacao_id) {
      if (existente.organizacao_id === req.tenant?.id) {
        return res.status(400).json({
          sucesso: false,
          mensagem: 'Este IMEI já está cadastrado na sua organização',
        });
      } else {
        return res.status(403).json({
          sucesso: false,
          mensagem: 'Este IMEI já está vinculado a outra organização',
        });
      }
    }
  }

  // ============ CONSULTA DE PLACA E CRIAÇÃO DE VEÍCULO ============
  let veiculoCriado = null;
  let dadosPlaca = null;
  let nomeVeiculo = null;
  let placaNormalizada = null;

  if (placa) {
    // Normalizar placa
    placaNormalizada = placa.toUpperCase().replace(/[^A-Z0-9]/g, '').trim();

    // Verificar se veículo já existe com essa placa na organização
    const veiculoExistente = await prisma.veiculo.findFirst({
      where: {
        organizacao_id: req.tenant?.id,
        placa: placaNormalizada
      }
    });

    if (veiculoExistente) {
      // Veículo já existe, usar ele
      veiculoCriado = veiculoExistente;
      nomeVeiculo = `${veiculoExistente.marca || ''} ${veiculoExistente.modelo || ''}`.trim() || placaNormalizada;
      console.log(`[Pré-cadastro] Veículo ${placaNormalizada} já existe, vinculando...`);
    } else {
      // Consultar dados da placa via API
      try {
        dadosPlaca = await consultaPlacaService.consultarPlaca(placaNormalizada);
        console.log(`[Pré-cadastro] Dados da placa ${placaNormalizada}:`, dadosPlaca ? 'OK' : 'Não encontrado');
      } catch (e) {
        console.warn(`[Pré-cadastro] Erro ao consultar placa: ${e.message}`);
      }

      // Criar veículo com dados consultados (ou vazios se não encontrou)
      veiculoCriado = await prisma.veiculo.create({
        data: {
          organizacao_id: req.tenant?.id,
          placa: placaNormalizada,
          marca: dadosPlaca?.marca || null,
          modelo: dadosPlaca?.modelo || null,
          ano: dadosPlaca?.ano || null,
          cor: dadosPlaca?.cor || null,
          tipo_veiculo: null, // Pode ser preenchido depois
        }
      });

      nomeVeiculo = dadosPlaca
        ? `${dadosPlaca.marca || ''} ${dadosPlaca.modelo || ''}`.trim()
        : placaNormalizada;

      console.log(`[Pré-cadastro] ✅ Veículo criado: ${placaNormalizada} - ${nomeVeiculo}`);
    }
  }

  // ============ CRIAR/ATUALIZAR DISPOSITIVO ============
  const tipoDispositivo = tipo || 'XT40_UNKNOWN';
  const config = getDefaultConfig(tipoDispositivo);

  let dispositivo;

  if (existente) {
    // Atualizar dispositivo existente (sem organização)
    dispositivo = await prisma.dispositivo.update({
      where: { imei },
      data: {
        organizacao_id: req.tenant?.id,
        placa: placaNormalizada || existente.placa,
        veiculo: nomeVeiculo || existente.veiculo,
        veiculo_id: veiculoCriado?.id || existente.veiculo_id,
        tipo: tipoDispositivo,
        ...(odometro_total != null && { odometro_total: parseFloat(odometro_total) }),
      },
    });
    console.log(`[Pré-cadastro] IMEI ${imei} (existente) vinculado à org ${req.tenant?.id}`);
  } else {
    // Criar novo dispositivo
    dispositivo = await prisma.dispositivo.create({
      data: {
        imei,
        tipo: tipoDispositivo,
        organizacao_id: req.tenant?.id,
        status: 'aguardando',
        placa: placaNormalizada || null,
        veiculo: nomeVeiculo || null,
        veiculo_id: veiculoCriado?.id || null,
        conexao_pos_chave: config.conexao_pos_chave,
        usa_ignicao_virtual: config.usa_ignicao_virtual,
        tensao_motor_ligado: config.tensao_motor_ligado,
        tensao_motor_deslig: config.tensao_motor_deslig,
        odometro_total: odometro_total != null ? parseFloat(odometro_total) : 0,
      },
    });
    console.log(`[Pré-cadastro] IMEI ${imei} pré-cadastrado para org ${req.tenant?.id}`);
  }

  // ============ CRIAR HISTÓRICO DE VÍNCULO ============
  if (veiculoCriado) {
    // Verificar se já existe histórico ativo
    const historicoExistente = await prisma.veiculoDispositivoHistorico.findFirst({
      where: {
        veiculo_id: veiculoCriado.id,
        dispositivo_id: dispositivo.id,
        ativo: true
      }
    });

    if (!historicoExistente) {
      await prisma.veiculoDispositivoHistorico.create({
        data: {
          veiculo_id: veiculoCriado.id,
          dispositivo_id: dispositivo.id,
          ativo: true
        }
      });
      console.log(`[Pré-cadastro] Histórico de vínculo criado: Veículo ${veiculoCriado.id} <-> Dispositivo ${dispositivo.id}`);
    }
  }

  res.status(201).json({
    sucesso: true,
    mensagem: veiculoCriado
      ? `Dispositivo ${imei} pré-cadastrado e vinculado ao veículo ${placaNormalizada} (${nomeVeiculo || 'dados não encontrados'})`
      : `Dispositivo ${imei} pré-cadastrado com sucesso`,
    dados: {
      dispositivo,
      veiculo: veiculoCriado,
      dadosPlaca: dadosPlaca
    }
  });
}));

// POST /api/dispositivos - Create or update device
// ✅ FILA INVISÍVEL: Se IMEI já existe sem organização, vincula à org do usuário
// ✅ Verifica permissão de criar veículos
// ✅ Cria veículo automaticamente se informar placa
router.post('/', verificarPermissao('veiculos', 'criar'), asyncHandler(async (req, res) => {
  const { imei, tipo, placa, veiculo, operadora, imei_chip, telefone_chip, apn, odometro_inicial } = req.body;

  // Log sem dados sensíveis
  console.log('[API] POST /api/dispositivos - IMEI:', imei, 'Tipo:', tipo);

  // Validação
  if (!imei || !tipo) {
    console.log('[API] Validação falhou: IMEI ou tipo ausentes');
    return res.status(400).json({
      sucesso: false,
      mensagem: 'IMEI e tipo são obrigatórios',
    });
  }

  console.log('[API] Verificando se dispositivo já existe...');
  // Verificar se dispositivo já existe
  const existing = await dispositivoService.getByImei(imei);
  console.log('[API] Dispositivo existente:', existing ? 'SIM' : 'NÃO');

  // ✅ Multi-tenant: Verificar propriedade do dispositivo
  if (existing && existing.organizacao_id !== null) {
    // Dispositivo já tem organização - verificar se é a mesma do usuário
    if (req.tenant && req.tenant.id && existing.organizacao_id !== req.tenant.id) {
      return res.status(403).json({
        sucesso: false,
        mensagem: 'Dispositivo pertence a outra organização',
      });
    }
  }

  // ============ CRIAÇÃO AUTOMÁTICA DE VEÍCULO ============
  let veiculoId = null;
  let nomeVeiculo = veiculo;
  let placaNormalizada = placa ? placa.toUpperCase().replace(/[^A-Z0-9]/g, '').trim() : null;

  if (placaNormalizada && placaNormalizada.length >= 7 && req.tenant?.id) {
    // Verificar se veículo já existe com essa placa na organização
    let veiculoExistente = await prisma.veiculo.findFirst({
      where: {
        organizacao_id: req.tenant.id,
        placa: placaNormalizada
      }
    });

    if (veiculoExistente) {
      // Veículo já existe, usar ele
      veiculoId = veiculoExistente.id;
      if (!nomeVeiculo) {
        nomeVeiculo = `${veiculoExistente.marca || ''} ${veiculoExistente.modelo || ''}`.trim() || placaNormalizada;
      }
      console.log(`[API] Veículo ${placaNormalizada} já existe (ID: ${veiculoId}), vinculando...`);
    } else {
      // Consultar dados da placa via API e criar veículo
      let dadosPlaca = null;
      try {
        dadosPlaca = await consultaPlacaService.consultarPlaca(placaNormalizada);
        console.log(`[API] Dados da placa ${placaNormalizada}:`, dadosPlaca ? 'OK' : 'Não encontrado');
      } catch (e) {
        console.warn(`[API] Erro ao consultar placa: ${e.message}`);
      }

      // Criar veículo com dados consultados (ou com dados informados pelo usuário)
      const veiculoCriado = await prisma.veiculo.create({
        data: {
          organizacao_id: req.tenant.id,
          placa: placaNormalizada,
          marca: dadosPlaca?.marca || null,
          modelo: dadosPlaca?.modelo || null,
          ano: dadosPlaca?.ano || null,
          cor: dadosPlaca?.cor || null,
        }
      });

      veiculoId = veiculoCriado.id;
      if (!nomeVeiculo) {
        nomeVeiculo = dadosPlaca
          ? `${dadosPlaca.marca || ''} ${dadosPlaca.modelo || ''}`.trim()
          : placaNormalizada;
      }

      console.log(`[API] ✅ Veículo criado automaticamente: ${placaNormalizada} - ${nomeVeiculo} (ID: ${veiculoId})`);
    }
  }

  let device;
  let acao;

  if (existing) {
    // ✅ FILA INVISÍVEL: Dispositivo existe - verificar se está na fila (sem organização)
    if (existing.organizacao_id === null && req.tenant?.id) {
      // Dispositivo estava na fila invisível - VINCULAR à organização do usuário!
      console.log(`[API] 🎯 IMEI ${imei} estava na FILA INVISÍVEL - vinculando à org ${req.tenant.id}`);
      device = await prisma.dispositivo.update({
        where: { imei },
        data: {
          organizacao_id: req.tenant.id,
          tipo: tipo || existing.tipo,
          placa: placaNormalizada || existing.placa,
          veiculo: nomeVeiculo || existing.veiculo,
          veiculo_id: veiculoId || existing.veiculo_id,
          operadora: operadora || existing.operadora,
          imei_chip: imei_chip || existing.imei_chip,
          telefone_chip: telefone_chip || existing.telefone_chip,
          apn: apn || existing.apn,
          status: existing.status === 'aguardando' ? 'offline' : existing.status,
          updated_at: new Date(),
        },
      });
      acao = 'vinculado';
    } else {
      // Dispositivo já pertence à organização - apenas atualizar
      device = await dispositivoService.update(imei, {
        imei,
        tipo,
        placa: placaNormalizada || placa,
        veiculo: nomeVeiculo || veiculo,
        veiculo_id: veiculoId,
        operadora,
        imei_chip,
        telefone_chip,
        apn,
        odometro_inicial,
      });
      acao = 'atualizado';
    }
  } else {
    // Dispositivo não existe - criar novo vinculado à organização
    device = await dispositivoService.create({
      imei,
      tipo,
      placa: placaNormalizada || placa,
      veiculo: nomeVeiculo || veiculo,
      veiculo_id: veiculoId,
      operadora,
      imei_chip,
      telefone_chip,
      apn,
      odometro_inicial,
    }, req.tenant?.id || null);
    acao = 'criado';
  }

  // ✅ Criar histórico de vínculo se vinculou a um veículo
  if (veiculoId && device) {
    const historicoExistente = await prisma.veiculoDispositivoHistorico.findFirst({
      where: {
        veiculo_id: veiculoId,
        dispositivo_id: device.id,
        ativo: true
      }
    });

    if (!historicoExistente) {
      await prisma.veiculoDispositivoHistorico.create({
        data: {
          veiculo_id: veiculoId,
          dispositivo_id: device.id,
          ativo: true
        }
      });
      console.log(`[API] Histórico de vínculo criado: Veículo ${veiculoId} <-> Dispositivo ${device.id}`);
    }
  }

  const mensagens = {
    'vinculado': `Dispositivo ${imei} encontrado e vinculado à sua organização!`,
    'atualizado': `Dispositivo ${imei} atualizado com sucesso`,
    'criado': 'Dispositivo criado com sucesso (aguardando conexão)',
  };

  res.status(acao === 'criado' ? 201 : 200).json({
    sucesso: true,
    mensagem: mensagens[acao],
    dados: device,
    acao,
    veiculo_criado: veiculoId ? true : false,
  });
}));

// GET /api/dispositivos - List all devices
// ✅ Multi-tenant: Filtra por organizacao_id do usuário
// ✅ Suporta filtro por status_uso: ?status_uso=ativo|disponivel|inativo
// ✅ Filtro por tags permitidas do usuário (hierarquia de grupos)
// ✅ Cache com TTL de 5s para evitar sobrecarga
router.get('/', asyncHandler(async (req, res) => {
  const { status_uso } = req.query;

  // Obter tags permitidas do usuário (null = acesso total)
  let tagIdsPermitidas = null;
  if (req.usuario?.id) {
    tagIdsPermitidas = await grupoService.obterTagsPermitidas(req.usuario.id);
  }

  // Gerar chave de cache: tenant_id + status_uso + tags
  const tenantId = req.tenant?.id || 'global';
  const statusKey = status_uso || 'default';
  const tagsKey = tagIdsPermitidas ? tagIdsPermitidas.sort().join(',') : 'all';
  const cacheKey = `${tenantId}:${statusKey}:${tagsKey}`;

  // Verificar cache válido
  const cached = dispositivosCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < DISPOSITIVOS_CACHE_TTL) {
    return res.json(cached.data);
  }

  // Evitar fetches paralelos para a mesma chave
  if (dispositivosFetching.get(cacheKey)) {
    // Aguardar um pouco e tentar cache novamente
    await new Promise(resolve => setTimeout(resolve, 100));
    const retryCache = dispositivosCache.get(cacheKey);
    if (retryCache && (Date.now() - retryCache.time) < DISPOSITIVOS_CACHE_TTL) {
      return res.json(retryCache.data);
    }
  }

  dispositivosFetching.set(cacheKey, true);

  // Construir filtro
  const filter = { ...(req.tenantFilter || {}) };

  // Filtrar por status_uso se fornecido
  if (status_uso === 'todos') {
    // Não filtrar por status_uso - mostrar todos
  } else if (status_uso) {
    filter.status_uso = status_uso;
  } else {
    // Por padrão, não mostrar inativos (a menos que explicitamente pedido)
    filter.status_uso = { not: 'inativo' };
  }

  const dispositivos = await dispositivoService.getAll(filter, tagIdsPermitidas);

  // Transform to match frontend expectations
  const dados = dispositivos.map((d) => {
    // Validate actual status against heartbeat service (in-memory)
    const hbInfo = heartbeatService.getRecent(d.imei);

    // Status is only "online" if heartbeat is recent OR banco says online
    let actualStatus = d.status || 'offline'; // Usar status do banco como fallback
    let actualUltimaConexao = d.ultima_conexao;

    if (hbInfo && hbInfo.timestamp) {
      const heartbeatTime = new Date(hbInfo.timestamp).getTime();
      const currentTime = Date.now();
      const secondsAgo = (currentTime - heartbeatTime) / 1000;

      // 5 minutos de tolerance
      if (secondsAgo < 300) {
        actualStatus = 'online';
      } else if (secondsAgo < 600) { // até 10 minutos
        actualStatus = 'idle';
      } else {
        actualStatus = 'offline';
      }
      actualUltimaConexao = hbInfo.timestamp;
    } else if (d.status === 'online') {
      // Se banco diz online mas sem heartbeat recente, manter online por 5 min
      const lastConnection = new Date(d.ultima_conexao || d.updated_at).getTime();
      const secondsSinceLastUpdate = (Date.now() - lastConnection) / 1000;

      if (secondsSinceLastUpdate < 300) {
        actualStatus = 'online';
      } else {
        actualStatus = 'offline';
      }
    }

    // ✅ CORREÇÃO: Pegar localização mais recente (already ordered DESC, take 1 no service)
    const localizacaoRecente = d.localizacoes && d.localizacoes.length > 0
      ? d.localizacoes[0]
      : null;

    // ✅ LÓGICA CORRETA: Validação completa de dados OBD2
    let dadosOBD2Validos = false;
    if (d.dados_obd2 && d.dados_obd2.length > 0) {
      const ultimoOBD2 = d.dados_obd2[0];

      // Verificar se dados são recentes (< 10 minutos)
      // Rastreadores XT40 enviam a cada 3-5 minutos normalmente
      const tempoOBD2 = new Date(ultimoOBD2.timestamp).getTime();
      const minutosDesdeOBD2 = (Date.now() - tempoOBD2) / (1000 * 60);
      const dadosRecentes = minutosDesdeOBD2 < 10;

      // Verificar se dados estão variando (não são cache antigo)
      // IMPORTANTE: Motor em idle pode ter RPM constante!
      // Só invalidar se dados forem MUITO antigos (> 1 hora) E idênticos
      let dadosVariando = true;
      if (d.dados_obd2.length >= 2) {
        const obd1 = d.dados_obd2[0];
        const obd2 = d.dados_obd2[1] || d.dados_obd2[0];

        // Calcular tempo entre os 2 pacotes
        const tempo1 = new Date(obd1.timestamp).getTime();
        const tempo2 = new Date(obd2.timestamp).getTime();
        const minutosDiferenca = (tempo1 - tempo2) / (1000 * 60);

        // Se dados idênticos POR MAIS DE 30 MINUTOS = cache
        // Se dados idênticos mas recentes (< 30 min) = motor em idle, OK!
        if (obd1.rpm === obd2.rpm &&
            obd1.temperatura_motor === obd2.temperatura_motor &&
            obd1.rpm !== null && obd1.rpm > 0 &&
            minutosDiferenca > 30) {
          dadosVariando = false;
        }
      }

      // Dados válidos se: recentes (< 2 min) E (variando OU constantes há pouco tempo)
      dadosOBD2Validos = dadosRecentes && dadosVariando;
    }

    // ✅ CORREÇÃO: Determinar estado de ignição CORRETAMENTE
    // PRIORIDADE 0: Para XT40_OBD2, usar SEMPRE o estado do dispositivo (vem do obd2Service)
    // PRIORIDADE 1: Se offline → 'off'
    // PRIORIDADE 2: Se tem localização recente com estado_ignicao → usar esse
    // PRIORIDADE 3: Se tem localização recente com ignicao + velocidade → calcular
    // PRIORIDADE 4: Se tem dados OBD2 válidos → usar do banco
    // PRIORIDADE 5: Default → 'off'
    let estadoIgnicaoFinal = 'off';
    const velocidadeAtual = localizacaoRecente?.velocidade || 0;
    const ignicaoAtiva = localizacaoRecente?.ignicao === true;
    const isOBD2DeviceDisp = supportsOBD2(d.tipo);

    if (actualStatus === 'offline') {
      // Se offline, sempre 'off'
      estadoIgnicaoFinal = 'off';
    } else if (isOBD2DeviceDisp && d.estado_ignicao) {
      // ⚠️ Para dispositivos OBD2: usar SEMPRE o estado do dispositivo (vem do obd2Service, é confiável)
      // Os location packets de dispositivos OBD2 podem ter dados de ignição incorretos
      estadoIgnicaoFinal = d.estado_ignicao;
    } else if (localizacaoRecente?.estado_ignicao) {
      // Se tem estado_ignicao na localização, usar esse (mais confiável)
      estadoIgnicaoFinal = localizacaoRecente.estado_ignicao;
    } else if (ignicaoAtiva) {
      // Se ignição ativa, calcular baseado em velocidade
      estadoIgnicaoFinal = velocidadeAtual >= 5 ? 'moving' : 'idle';
    } else if (dadosOBD2Validos && d.estado_ignicao) {
      // Fallback para OBD2 se disponível
      estadoIgnicaoFinal = d.estado_ignicao;
    }
    // else permanece 'off'

    // Dispositivo é considerado "configurado" se tem veiculo E placa preenchidos
    const configurado = !!(d.veiculo && d.veiculo.trim() && d.placa && d.placa.trim());

    // ✅ Calcular estado de movimento baseado em ignição + velocidade
    let estadoMovimento = 'parado';  // default: ignição OFF

    if (estadoIgnicaoFinal === 'moving') {
      estadoMovimento = 'movimento';
    } else if (estadoIgnicaoFinal === 'idle' || estadoIgnicaoFinal === 'acc_on' || estadoIgnicaoFinal === 'ligado') {
      estadoMovimento = 'ocioso';
    } else if (ignicaoAtiva) {
      // Fallback se estado não determinado mas ignição ativa
      if (velocidadeAtual < 5) {
        estadoMovimento = 'ocioso';
      } else {
        estadoMovimento = 'movimento';
      }
    }

    return {
      id: d.id,
      imei: d.imei,
      tipo: d.tipo,
      placa: d.placa,
      veiculo: d.veiculo,
      veiculo_id: d.veiculo_id,
      operadora: d.operadora,
      imei_chip: d.imei_chip,
      telefone_chip: d.telefone_chip,
      apn: d.apn,
      status: actualStatus,
      status_uso: d.status_uso || 'ativo',  // "ativo", "disponivel", "inativo"
      estado_ignicao: estadoIgnicaoFinal,  // "off", "acc_on", "ligado"
      estado_movimento: estadoMovimento,   // "parado", "ocioso", "movimento"
      latitude: localizacaoRecente?.latitude || null,
      longitude: localizacaoRecente?.longitude || null,
      velocidade: velocidadeAtual,
      direcao: localizacaoRecente?.direcao || 0,
      ultima_atualizacao: localizacaoRecente?.timestamp || d.updated_at,
      ultima_conexao: actualUltimaConexao,
      configurado: configurado,  // true se tem veiculo E placa
      motorista: d.motorista ? {
        id: d.motorista.id,
        nome: d.motorista.nome,
        foto_url: d.motorista.foto_url,
        cnh_categoria: d.motorista.cnh_categoria,
        ativo: d.motorista.ativo
      } : null
    };
  });

  // Separar em configurados e pendentes
  const configurados = dados.filter(d => d.configurado);
  const pendentes = dados.filter(d => !d.configurado);

  const response = {
    sucesso: true,
    total: dados.length,
    total_configurados: configurados.length,
    total_pendentes: pendentes.length,
    dados,
    configurados,
    pendentes,
  };

  // Salvar no cache
  dispositivosCache.set(cacheKey, { data: response, time: Date.now() });
  dispositivosFetching.delete(cacheKey);

  res.json(response);
}));

// GET /api/dispositivos/:imei/localizacao-atual
router.get('/:imei/localizacao-atual', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  // Cache por IMEI (3s)
  const cacheKey = `loc:${imei}`;
  const cached = imeiCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < IMEI_CACHE_TTL) {
    return res.json(cached.data);
  }

  const localizacao = await localizacaoService.getCurrent(imei);

  if (!localizacao) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Nenhuma localização encontrada',
    });
  }

  const response = {
    sucesso: true,
    dados: {
      id: localizacao.id,
      latitude: localizacao.latitude,
      longitude: localizacao.longitude,
      altitude: localizacao.altitude,
      velocidade: localizacao.velocidade,
      direcao: localizacao.direcao,
      precisao: localizacao.precisao,
      timestamp: localizacao.timestamp,
    },
  };

  imeiCache.set(cacheKey, { data: response, time: Date.now() });
  res.json(response);
}));

// GET /api/dispositivos/:imei/historico
// ✅ Agora usa gpsFilterService com interpolação para rotas suaves (igual ao card de GPS)
router.get('/:imei/historico', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { dataInicio, dataFim, horas, corrigido } = req.query;

  // ✅ Correção ATIVADA por padrão para todos os dispositivos
  // Use ?corrigido=false para desativar se necessário
  const aplicarCorrecao = corrigido !== 'false' && gpsFilterService !== null;

  let historico;

  // Se dataInicio e dataFim fornecidos, usar filtro por data
  if (dataInicio && dataFim) {
    historico = await localizacaoService.getHistoryByDateRange(imei, new Date(dataInicio), new Date(dataFim));
  } else {
    // Fallback para filtro por horas
    const horasNum = parseInt(horas) || 24;
    historico = await localizacaoService.getHistory(imei, horasNum);
  }

  // Preparar pontos brutos
  let dadosFinais = historico.map(h => ({
    id: h.id,
    latitude: h.latitude,
    longitude: h.longitude,
    altitude: h.altitude,
    velocidade: h.velocidade,
    direcao: h.direcao,
    ignicao: h.ignicao,
    estado_ignicao: h.estado_ignicao || (h.ignicao ? 'idle' : 'off'), // ✅ Incluir estado_ignicao
    timestamp: h.timestamp,
  }));

  let estatisticasIA = null;

  // ✅ Aplicar interpolação + OSRM (igual ao card de GPS e Analisar com IA)
  if (aplicarCorrecao && historico.length > 1) {
    try {
      // Ordenar por timestamp ascendente para processamento
      const pontosOrdenados = [...dadosFinais].sort((a, b) =>
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      // ✅ Usar gpsFilterService com interpolação + OSRM (igual ao card de GPS)
      const resultado = await gpsFilterService.processarRotaCompleta(pontosOrdenados, {
        usarKalman: true,
        usarMediaMovel: false,
        usarHampel: true,
        usarInterpolacao: true, // ✅ INTERPOLAR para criar pontos intermediários
        usarOSRM: true          // ✅ Colar nas estradas
      });

      const pontosProcessados = resultado.pontos || pontosOrdenados;
      const totalCorrigidos = pontosProcessados.filter(p => p.matched || p.kalman_filtered).length;

      estatisticasIA = {
        ativada: true,
        pontos_originais: pontosOrdenados.length,
        pontos_processados: pontosProcessados.length,
        pontos_interpolados: pontosProcessados.length - pontosOrdenados.length,
        pontos_corrigidos: totalCorrigidos,
        taxa_correcao: ((totalCorrigidos / pontosProcessados.length) * 100).toFixed(2) + '%',
      };

      // Atualizar dados com coordenadas processadas
      dadosFinais = pontosProcessados.map(p => ({
        id: p.id,
        latitude: p.latitude,
        longitude: p.longitude,
        altitude: p.altitude,
        velocidade: p.velocidade,
        direcao: p.direcao,
        ignicao: p.ignicao,
        timestamp: p.timestamp,
        corrigido_ia: p.matched || p.kalman_filtered || false,
        ia_metodo: p.matched ? 'osrm_snap' : (p.kalman_filtered ? 'kalman' : null),
      }));

      // Reordenar para DESC (mais recente primeiro) para manter compatibilidade
      dadosFinais.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      console.log(`[Histórico] ${imei}: ${pontosOrdenados.length} brutos → ${pontosProcessados.length} processados`);

    } catch (iaError) {
      console.warn(`[Histórico] Erro na correção: ${iaError.message}`);
      estatisticasIA = { ativada: false, erro: iaError.message };
    }
  }

  res.json({
    sucesso: true,
    total: dadosFinais.length,
    periodo: dataInicio && dataFim ? { dataInicio, dataFim } : { horas: parseInt(horas) || 24 },
    ia_correcao: estatisticasIA,
    dados: dadosFinais,
  });
}));

// GET /api/dispositivos/:imei/obd2-atual
router.get('/:imei/obd2-atual', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  // Cache por IMEI (3s)
  const cacheKey = `obd2:${imei}`;
  const cached = imeiCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < IMEI_CACHE_TTL) {
    return res.json(cached.data);
  }

  const obd2 = await obd2Service.getCurrent(imei);

  if (!obd2) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Nenhum dado OBD2 encontrado',
    });
  }

  const response = {
    sucesso: true,
    dados: {
      id: obd2.id,
      rpm: obd2.rpm,
      temperatura_motor: obd2.temperatura_motor,
      nivel_combustivel: obd2.nivel_combustivel,
      ignicao: obd2.ignicao,
      odometro_plataforma: obd2.odometro_plataforma,
      odometro_embarcado: obd2.odometro_embarcado,
      hora_motor_plataforma: obd2.hora_motor_plataforma,
      hora_motor_embarcada: obd2.hora_motor_embarcada,
      percentual_bateria: obd2.percentual_bateria,
      tensao_bateria: obd2.tensao_bateria,
      timestamp: obd2.timestamp,
    },
  };

  imeiCache.set(cacheKey, { data: response, time: Date.now() });
  res.json(response);
}));

// GET /api/dispositivos/:imei/obd2-historico
router.get('/:imei/obd2-historico', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const horas = parseInt(req.query.horas) || 24;

  const historico = await obd2Service.getHistory(imei, horas);

  res.json({
    sucesso: true,
    total: historico.length,
    periodo_horas: horas,
    dados: historico.map(h => ({
      id: h.id,
      rpm: h.rpm,
      temperatura_motor: h.temperatura_motor,
      nivel_combustivel: h.nivel_combustivel,
      ignicao: h.ignicao,
      velocidade: h.velocidade,  // ✅ Necessário para mostrar OCIOSO vs MOV no frontend
      odometro_plataforma: h.odometro_plataforma,
      odometro_embarcado: h.odometro_embarcado,
      hora_motor_plataforma: h.hora_motor_plataforma,
      hora_motor_embarcada: h.hora_motor_embarcada,
      percentual_bateria: h.percentual_bateria,
      tensao_bateria: h.tensao_bateria,
      tensao_principal: h.tensao_principal,  // ✅ Tensão do veículo (12-14V)
      timestamp: h.timestamp,
    })),
  });
}));

// GET /api/dispositivos/:imei/alarmes
router.get('/:imei/alarmes', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  const alarmes = await alarmeService.getByDevice(imei, limit);

  res.json({
    sucesso: true,
    total: alarmes.length,
    dados: alarmes.map(a => ({
      id: a.id,
      tipo_alarme: a.tipo_alarme,
      descricao: a.descricao,
      severidade: a.severidade,
      resolvido: a.resolvido,
      timestamp: a.timestamp,
    })),
  });
}));

// ✅ NOVO: GET /api/dispositivos/:imei/estatisticas - Get statistics for device
router.get('/:imei/estatisticas', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
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

  const dataLimite = new Date();
  dataLimite.setHours(dataLimite.getHours() - horas);

  // Buscar OBD2
  const obd2Records = await prisma.dadosOBD2.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataLimite },
    },
  });

  // Buscar Alarmes
  const alarmeRecords = await prisma.alarme.findMany({
    where: {
      dispositivo_id: dispositivo.id,
      timestamp: { gte: dataLimite },
    },
  });

  // Calcular estatísticas OBD2
  const obd2Stats = {
    total: obd2Records.length,
    rpm: {
      min: Math.min(...obd2Records.filter(o => o.rpm).map(o => o.rpm), Infinity),
      max: Math.max(...obd2Records.filter(o => o.rpm).map(o => o.rpm), -Infinity),
      media: obd2Records.filter(o => o.rpm).length > 0
        ? Math.round(obd2Records.filter(o => o.rpm).reduce((a, b) => a + (b.rpm || 0), 0) / obd2Records.filter(o => o.rpm).length)
        : 0,
    },
    velocidade: {
      min: Math.min(...obd2Records.filter(o => o.velocidade).map(o => o.velocidade), Infinity),
      max: Math.max(...obd2Records.filter(o => o.velocidade).map(o => o.velocidade), -Infinity),
    },
    temperatura_motor: {
      min: Math.min(...obd2Records.filter(o => o.temperatura_motor).map(o => o.temperatura_motor), Infinity),
      max: Math.max(...obd2Records.filter(o => o.temperatura_motor).map(o => o.temperatura_motor), -Infinity),
    },
    nivel_combustivel: {
      min: Math.min(...obd2Records.filter(o => o.nivel_combustivel).map(o => o.nivel_combustivel), Infinity),
      max: Math.max(...obd2Records.filter(o => o.nivel_combustivel).map(o => o.nivel_combustivel), -Infinity),
      media: obd2Records.filter(o => o.nivel_combustivel).length > 0
        ? Math.round(obd2Records.filter(o => o.nivel_combustivel).reduce((a, b) => a + (b.nivel_combustivel || 0), 0) / obd2Records.filter(o => o.nivel_combustivel).length)
        : 0,
    },
    ignicao_ativa: obd2Records.filter(o => o.ignicao).length,
  };

  // Calcular estatísticas de Alarmes
  const alarmeStats = {
    total: alarmeRecords.length,
    por_tipo: {},
    por_severidade: {
      critical: alarmeRecords.filter(a => a.severidade === 'critical').length,
      warning: alarmeRecords.filter(a => a.severidade === 'warning').length,
      info: alarmeRecords.filter(a => a.severidade === 'info').length,
    },
    resolvidos: alarmeRecords.filter(a => a.resolvido).length,
    pendentes: alarmeRecords.filter(a => !a.resolvido).length,
  };

  // Agrupar alarmes por tipo
  alarmeRecords.forEach(a => {
    alarmeStats.por_tipo[a.tipo_alarme] = (alarmeStats.por_tipo[a.tipo_alarme] || 0) + 1;
  });

  res.json({
    sucesso: true,
    periodo_horas: horas,
    obd2: obd2Stats,
    alarmes: alarmeStats,
  });
}));

// PUT /api/dispositivos/:imei - Update device
// ✅ Verifica permissão de editar veículos
router.put('/:imei', verificarPropriedadeDispositivo, verificarPermissao('veiculos', 'editar'), asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const updates = req.body;

  const device = await dispositivoService.update(imei, updates);

  res.json({
    sucesso: true,
    mensagem: 'Dispositivo atualizado com sucesso',
    dados: device,
  });
}));

// PUT /api/dispositivos/:imei/status-uso - Alterar status de uso do dispositivo
// Status: ativo (em uso), disponivel (livre para vincular), inativo (guardado/removido)
router.put('/:imei/status-uso', verificarPropriedadeDispositivo, verificarPermissao('veiculos', 'editar'), asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { status_uso } = req.body;

  const statusValidos = ['ativo', 'disponivel', 'inativo'];
  if (!status_uso || !statusValidos.includes(status_uso)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: `Status invalido. Use: ${statusValidos.join(', ')}`,
      status_validos: statusValidos
    });
  }

  const device = await dispositivoService.update(imei, { status_uso });

  const mensagens = {
    ativo: 'Dispositivo marcado como ATIVO (em uso)',
    disponivel: 'Dispositivo marcado como DISPONIVEL (pronto para vincular a outro veiculo)',
    inativo: 'Dispositivo marcado como INATIVO (removido da lista principal)'
  };

  res.json({
    sucesso: true,
    mensagem: mensagens[status_uso],
    dados: device
  });
}));

// ============ IGNIÇÃO VIRTUAL ============

// PUT /api/dispositivos/:imei/ignicao-virtual - Configure virtual ignition
router.put('/:imei/ignicao-virtual', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { ativar, tensao_motor_ligado, tensao_motor_deslig } = req.body;

  // Validação
  if (ativar === undefined) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetro "ativar" é obrigatório (true/false)',
      exemplo: {
        ativar: true,
        tensao_motor_ligado: 13.8,
        tensao_motor_deslig: 12.6
      }
    });
  }

  // Atualizar configuração de ignição virtual
  const device = await prisma.dispositivo.update({
    where: { imei },
    data: {
      usa_ignicao_virtual: ativar === true,
      ...(tensao_motor_ligado !== undefined && { tensao_motor_ligado: parseFloat(tensao_motor_ligado) }),
      ...(tensao_motor_deslig !== undefined && { tensao_motor_deslig: parseFloat(tensao_motor_deslig) }),
    },
  });

  res.json({
    sucesso: true,
    mensagem: ativar
      ? `Ignição virtual ATIVADA para ${imei}. Motor será detectado por tensão >= ${device.tensao_motor_ligado}V`
      : `Ignição virtual DESATIVADA para ${imei}. Motor será detectado por ACC físico`,
    dados: {
      imei: device.imei,
      usa_ignicao_virtual: device.usa_ignicao_virtual,
      tensao_motor_ligado: device.tensao_motor_ligado,
      tensao_motor_deslig: device.tensao_motor_deslig,
    },
    explicacao: ativar ? {
      como_funciona: 'Motor é detectado pela tensão da bateria principal (alternador)',
      motor_ligado: `Tensão >= ${device.tensao_motor_ligado}V`,
      motor_desligado: `Tensão < ${device.tensao_motor_deslig}V`,
      ocioso: 'Motor ligado + Velocidade <= 2 km/h',
      movimento: 'Motor ligado + Velocidade > 2 km/h',
    } : null,
  });
}));

// GET /api/dispositivos/:imei/ignicao-virtual - Get virtual ignition config
router.get('/:imei/ignicao-virtual', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const device = await prisma.dispositivo.findUnique({
    where: { imei },
    select: {
      imei: true,
      tipo: true,
      usa_ignicao_virtual: true,
      tensao_motor_ligado: true,
      tensao_motor_deslig: true,
      estado_ignicao: true,
    },
  });

  if (!device) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  res.json({
    sucesso: true,
    dados: {
      imei: device.imei,
      tipo: device.tipo,
      usa_ignicao_virtual: device.usa_ignicao_virtual,
      tensao_motor_ligado: device.tensao_motor_ligado,
      tensao_motor_deslig: device.tensao_motor_deslig,
      estado_ignicao_atual: device.estado_ignicao,
    },
    como_ativar: 'PUT /api/dispositivos/:imei/ignicao-virtual { "ativar": true }',
  });
}));

// ============ PERFIS DE VEÍCULO E CALIBRAÇÃO ============

// GET /api/dispositivos/perfis-veiculo - Lista todos os perfis disponíveis
router.get('/perfis-veiculo', (req, res) => {
  const perfis = getAllVehicleProfiles();

  res.json({
    sucesso: true,
    total: perfis.length,
    perfis,
    uso: 'PUT /api/dispositivos/:imei/perfil-veiculo { "perfil": "MODERNO", "ano": 2024 }',
  });
});

// GET /api/dispositivos/perfis-veiculo/:perfilId - Info de um perfil específico
router.get('/perfis-veiculo/:perfilId', (req, res) => {
  const { perfilId } = req.params;
  const perfil = getVehicleProfile(perfilId);

  if (!perfil) {
    return res.status(404).json({
      sucesso: false,
      mensagem: `Perfil '${perfilId}' não encontrado`,
      perfis_disponiveis: getAllVehicleProfiles().map(p => p.id),
    });
  }

  res.json({
    sucesso: true,
    perfil,
  });
});

// GET /api/dispositivos/perfis-veiculo/sugerir/:ano - Sugere perfil baseado no ano
router.get('/perfis-veiculo/sugerir/:ano', (req, res) => {
  const ano = parseInt(req.params.ano);

  if (isNaN(ano) || ano < 1900 || ano > 2100) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Ano inválido',
    });
  }

  const perfilSugerido = suggestProfileByYear(ano);
  const perfil = getVehicleProfile(perfilSugerido);

  res.json({
    sucesso: true,
    ano,
    perfil_sugerido: perfilSugerido,
    perfil,
  });
});

// PUT /api/dispositivos/:imei/perfil-veiculo - Define perfil de veículo
router.put('/:imei/perfil-veiculo', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { perfil, ano, tensao_motor_ligado, tensao_motor_deslig } = req.body;

  if (!perfil) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Parâmetro "perfil" é obrigatório',
      perfis_disponiveis: getAllVehicleProfiles().map(p => p.id),
      exemplo: { perfil: 'MODERNO', ano: 2024 },
    });
  }

  // Para perfil PERSONALIZADO, requer tensões
  if (perfil === 'PERSONALIZADO' && (!tensao_motor_ligado || !tensao_motor_deslig)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Para perfil PERSONALIZADO, informe tensao_motor_ligado e tensao_motor_deslig',
      exemplo: { perfil: 'PERSONALIZADO', tensao_motor_ligado: 13.0, tensao_motor_deslig: 12.5 },
    });
  }

  const valoresCustom = perfil === 'PERSONALIZADO' ? {
    tensao_motor_ligado: parseFloat(tensao_motor_ligado),
    tensao_motor_deslig: parseFloat(tensao_motor_deslig),
  } : null;

  const device = await calibracaoService.definirPerfil(imei, perfil, ano ? parseInt(ano) : null, valoresCustom);

  res.json({
    sucesso: true,
    mensagem: `Perfil ${perfil} aplicado ao dispositivo ${imei}`,
    dados: device,
    proximos_passos: 'O sistema irá coletar dados por 48h e sugerir ajustes se necessário.',
  });
}));

// GET /api/dispositivos/:imei/perfil-veiculo - Obtém configuração de perfil
router.get('/:imei/perfil-veiculo', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const status = await calibracaoService.getStatusCalibracao(imei);

  res.json({
    sucesso: true,
    dados: status,
  });
}));

// POST /api/dispositivos/:imei/calibracao/processar - Força processamento de calibração
router.post('/:imei/calibracao/processar', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const resultado = await calibracaoService.processarCalibracao(imei);

  res.json({
    sucesso: true,
    ...resultado,
  });
}));

// POST /api/dispositivos/:imei/calibracao/aplicar - Aplica sugestão de calibração
router.post('/:imei/calibracao/aplicar', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const device = await calibracaoService.aplicarSugestao(imei);

  res.json({
    sucesso: true,
    mensagem: 'Sugestão de calibração aplicada com sucesso',
    dados: device,
  });
}));

// POST /api/dispositivos/:imei/calibracao/rejeitar - Rejeita sugestão de calibração
router.post('/:imei/calibracao/rejeitar', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const device = await calibracaoService.rejeitarSugestao(imei);

  res.json({
    sucesso: true,
    mensagem: 'Sugestão rejeitada, mantendo configuração atual',
    dados: device,
  });
}));

// GET /api/dispositivos/:imei/calibracao/anomalias - Detecta anomalias de tensão
router.get('/:imei/calibracao/anomalias', verificarPropriedadeDispositivo, asyncHandler(async (req, res) => {
  const { imei } = req.params;

  const resultado = await calibracaoService.detectarAnomalias(imei);

  res.json({
    sucesso: true,
    ...resultado,
  });
}));

// DELETE /api/dispositivos/:imei - Delete device
// ✅ Verifica permissão de excluir veículos
router.delete('/:imei', verificarPropriedadeDispositivo, verificarPermissao('veiculos', 'excluir'), asyncHandler(async (req, res) => {
  const { imei } = req.params;

  await dispositivoService.delete(imei);

  res.json({
    sucesso: true,
    mensagem: 'Dispositivo removido com sucesso',
  });
}));

// GET /api/dispositivos/status/refresh - Refresh device status
// ✅ Multi-tenant: Filtra por organizacao_id do usuário
router.get('/status/refresh', asyncHandler(async (req, res) => {
  const dispositivos = await dispositivoService.getAll(req.tenantFilter || {});

  // Transform to match frontend expectations
  const dados = dispositivos.map((d) => {
    // Validate actual status against heartbeat service (in-memory)
    const hbInfo = heartbeatService.getRecent(d.imei);

    // Status is only "online" if heartbeat is recent OR banco says online
    let actualStatus = d.status || 'offline';
    let actualUltimaConexao = d.ultima_conexao;

    if (hbInfo && hbInfo.timestamp) {
      const heartbeatTime = new Date(hbInfo.timestamp).getTime();
      const currentTime = Date.now();
      const secondsAgo = (currentTime - heartbeatTime) / 1000;

      if (secondsAgo < 300) {
        actualStatus = 'online';
      } else if (secondsAgo < 600) {
        actualStatus = 'idle';
      } else {
        actualStatus = 'offline';
      }
      actualUltimaConexao = hbInfo.timestamp;
    } else if (d.status === 'online') {
      const lastConnection = new Date(d.ultima_conexao || d.updated_at).getTime();
      const secondsSinceLastUpdate = (Date.now() - lastConnection) / 1000;

      if (secondsSinceLastUpdate < 300) {
        actualStatus = 'online';
      } else {
        actualStatus = 'offline';
      }
    }

    return {
      id: d.id,
      imei: d.imei,
      tipo: d.tipo,
      placa: d.placa,
      veiculo: d.veiculo,
      operadora: d.operadora,
      imei_chip: d.imei_chip,
      apn: d.apn,
      status: actualStatus,
      latitude: d.localizacoes[0]?.latitude || null,
      longitude: d.localizacoes[0]?.longitude || null,
      velocidade: d.localizacoes[0]?.velocidade || 0,
      direcao: d.localizacoes[0]?.direcao || 0,
      ultima_atualizacao: d.updated_at,
      ultima_conexao: actualUltimaConexao,
    };
  });

  res.json({
    sucesso: true,
    total: dados.length,
    dados,
    timestamp: new Date().toISOString(),
  });
}));

// ============ ENDPOINTS SUPER_ADMIN - DISPOSITIVOS NÃO ATRIBUÍDOS ============

const { apenasSuperAdmin } = require('../middleware/auth.middleware');

/**
 * GET /api/dispositivos/nao-atribuidos
 * Lista dispositivos sem organização (apenas super_admin)
 * Estes são dispositivos que conectaram mas ainda não foram atribuídos a nenhuma org
 */
router.get('/nao-atribuidos', apenasSuperAdmin, asyncHandler(async (req, res) => {
  // Verificar cache
  if (naoAtribuidosCache && (Date.now() - naoAtribuidosCacheTime) < NAO_ATRIBUIDOS_CACHE_TTL) {
    return res.json(naoAtribuidosCache);
  }

  // Buscar dispositivos com organizacao_id = null
  const dispositivos = await prisma.dispositivo.findMany({
    where: { organizacao_id: null },
    include: {
      localizacoes: {
        orderBy: { timestamp: 'desc' },
        take: 1,
      },
    },
    orderBy: { ultima_conexao: 'desc' },
  });

  const dados = dispositivos.map((d) => {
    const hbInfo = heartbeatService.getRecent(d.imei);
    let actualStatus = d.status || 'offline';

    if (hbInfo && hbInfo.timestamp) {
      const secondsAgo = (Date.now() - new Date(hbInfo.timestamp).getTime()) / 1000;
      if (secondsAgo < 300) actualStatus = 'online';
      else if (secondsAgo < 600) actualStatus = 'idle';
      else actualStatus = 'offline';
    }

    const localizacaoRecente = d.localizacoes?.[0] || null;

    return {
      id: d.id,
      imei: d.imei,
      tipo: d.tipo,
      status: actualStatus,
      ultima_conexao: hbInfo?.timestamp || d.ultima_conexao,
      created_at: d.created_at,
      latitude: localizacaoRecente?.latitude || null,
      longitude: localizacaoRecente?.longitude || null,
    };
  });

  const response = {
    sucesso: true,
    total: dados.length,
    dados,
    mensagem: dados.length === 0
      ? 'Nenhum dispositivo aguardando atribuição'
      : `${dados.length} dispositivo(s) aguardando atribuição a uma organização`,
  };

  // Salvar no cache
  naoAtribuidosCache = response;
  naoAtribuidosCacheTime = Date.now();

  res.json(response);
}));

/**
 * PUT /api/dispositivos/:imei/atribuir
 * Atribui dispositivo a uma organização (apenas super_admin)
 */
router.put('/:imei/atribuir', apenasSuperAdmin, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { organizacao_id } = req.body;

  if (!organizacao_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'organizacao_id é obrigatório',
    });
  }

  // Verificar se dispositivo existe
  const dispositivo = await prisma.dispositivo.findUnique({ where: { imei } });
  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Verificar se organização existe
  const organizacao = await prisma.organizacao.findUnique({
    where: { id: parseInt(organizacao_id) }
  });
  if (!organizacao) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Organização não encontrada',
    });
  }

  // Atribuir dispositivo à organização
  const dispositivoAtualizado = await prisma.dispositivo.update({
    where: { imei },
    data: { organizacao_id: parseInt(organizacao_id) },
  });

  console.log(`[Dispositivo] ${imei} atribuído à organização ${organizacao.nome} (ID: ${organizacao_id})`);

  res.json({
    sucesso: true,
    mensagem: `Dispositivo ${imei} atribuído à organização "${organizacao.nome}"`,
    dispositivo: {
      imei: dispositivoAtualizado.imei,
      organizacao_id: dispositivoAtualizado.organizacao_id,
      organizacao_nome: organizacao.nome,
    },
  });
}));

/**
 * PUT /api/dispositivos/:imei/migrar
 * Migra dispositivo E veículo vinculado para outra organização (apenas super_admin)
 * Opção de manter ou excluir histórico de localizações e viagens
 */
router.put('/:imei/migrar', apenasSuperAdmin, asyncHandler(async (req, res) => {
  const { imei } = req.params;
  const { organizacao_destino_id, migrar_veiculo = true, excluir_historico = false } = req.body;

  if (!organizacao_destino_id) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'organizacao_destino_id é obrigatório',
    });
  }

  // Verificar se dispositivo existe
  const dispositivo = await prisma.dispositivo.findUnique({
    where: { imei },
    include: { veiculo_rel: true }
  });
  if (!dispositivo) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Dispositivo não encontrado',
    });
  }

  // Verificar organização de origem
  const orgOrigem = dispositivo.organizacao_id
    ? await prisma.organizacao.findUnique({ where: { id: dispositivo.organizacao_id } })
    : null;

  // Verificar organização de destino
  const orgDestino = await prisma.organizacao.findUnique({
    where: { id: parseInt(organizacao_destino_id) }
  });
  if (!orgDestino) {
    return res.status(404).json({
      sucesso: false,
      mensagem: 'Organização de destino não encontrada',
    });
  }

  // Verificar se já está na organização destino
  if (dispositivo.organizacao_id === parseInt(organizacao_destino_id)) {
    return res.status(400).json({
      sucesso: false,
      mensagem: 'Dispositivo já pertence a esta organização',
    });
  }

  const resultado = {
    dispositivo_migrado: false,
    veiculo_migrado: false,
    historico_excluido: false,
    localizacoes_excluidas: 0,
    viagens_excluidas: 0,
    detalhes: []
  };

  // Excluir histórico se solicitado (ANTES de migrar)
  if (excluir_historico) {
    // Excluir localizações
    const locExcluidas = await prisma.localizacao.deleteMany({
      where: { dispositivo_id: dispositivo.id }
    });
    resultado.localizacoes_excluidas = locExcluidas.count;
    resultado.detalhes.push(`${locExcluidas.count} localizações excluídas`);

    // Excluir viagens
    const viagensExcluidas = await prisma.viagem.deleteMany({
      where: { dispositivo_id: dispositivo.id }
    });
    resultado.viagens_excluidas = viagensExcluidas.count;
    resultado.detalhes.push(`${viagensExcluidas.count} viagens excluídas`);

    // Excluir dados OBD2
    const obd2Excluidos = await prisma.dadosOBD2.deleteMany({
      where: { dispositivo_id: dispositivo.id }
    });
    if (obd2Excluidos.count > 0) {
      resultado.detalhes.push(`${obd2Excluidos.count} registros OBD2 excluídos`);
    }

    // Excluir alarmes
    const alarmesExcluidos = await prisma.alarme.deleteMany({
      where: { dispositivo_id: dispositivo.id }
    });
    if (alarmesExcluidos.count > 0) {
      resultado.detalhes.push(`${alarmesExcluidos.count} alarmes excluídos`);
    }

    resultado.historico_excluido = true;
    console.log(`[Migração] ${imei}: Histórico excluído - ${locExcluidas.count} locs, ${viagensExcluidas.count} viagens`);
  }

  // Migrar dispositivo
  await prisma.dispositivo.update({
    where: { imei },
    data: { organizacao_id: parseInt(organizacao_destino_id) },
  });
  resultado.dispositivo_migrado = true;
  resultado.detalhes.push(`Dispositivo ${imei} migrado`);

  // Migrar veículo vinculado (se existir e se solicitado)
  if (migrar_veiculo && dispositivo.veiculo_id && dispositivo.veiculo_rel) {
    await prisma.veiculo.update({
      where: { id: dispositivo.veiculo_id },
      data: { organizacao_id: parseInt(organizacao_destino_id) },
    });
    resultado.veiculo_migrado = true;
    resultado.detalhes.push(`Veículo ${dispositivo.veiculo_rel.placa || dispositivo.veiculo_id} migrado`);
  }

  console.log(`[Migração] ${imei}: ${orgOrigem?.nome || 'Sem org'} → ${orgDestino.nome}`);

  const msgHistorico = excluir_historico ? ' (histórico excluído)' : ' (histórico mantido)';
  res.json({
    sucesso: true,
    mensagem: `Dispositivo migrado para "${orgDestino.nome}"${resultado.veiculo_migrado ? ' com veículo' : ''}${msgHistorico}`,
    origem: orgOrigem?.nome || 'Sem organização',
    destino: orgDestino.nome,
    ...resultado
  });
}));

/**
 * GET /api/dispositivos/estatisticas-globais
 * Estatísticas de todos os dispositivos (apenas super_admin)
 */
router.get('/estatisticas-globais', apenasSuperAdmin, asyncHandler(async (req, res) => {
  const [total, atribuidos, naoAtribuidos, online, offline] = await Promise.all([
    prisma.dispositivo.count(),
    prisma.dispositivo.count({ where: { organizacao_id: { not: null } } }),
    prisma.dispositivo.count({ where: { organizacao_id: null } }),
    prisma.dispositivo.count({ where: { status: 'online' } }),
    prisma.dispositivo.count({ where: { status: 'offline' } }),
  ]);

  // Dispositivos por organização
  const porOrganizacao = await prisma.dispositivo.groupBy({
    by: ['organizacao_id'],
    _count: { id: true },
    where: { organizacao_id: { not: null } },
  });

  // Buscar nomes das organizações
  const orgIds = porOrganizacao.map(p => p.organizacao_id);
  const organizacoes = await prisma.organizacao.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, nome: true },
  });

  const distribuicao = porOrganizacao.map(p => ({
    organizacao_id: p.organizacao_id,
    organizacao_nome: organizacoes.find(o => o.id === p.organizacao_id)?.nome || 'Desconhecida',
    total: p._count.id,
  }));

  res.json({
    sucesso: true,
    estatisticas: {
      total,
      atribuidos,
      nao_atribuidos: naoAtribuidos,
      online,
      offline,
      distribuicao_por_organizacao: distribuicao,
    },
  });
}));

module.exports = router;
