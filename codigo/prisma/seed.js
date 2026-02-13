const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // ========== PERFIS DE PERMISSÃO DO SISTEMA ==========
  console.log('\n📋 Criando perfis de permissão do sistema...');

  // Perfil Revendedor - para usuários que podem criar sub-organizações
  const perfilRevendedor = await prisma.perfilPermissao.upsert({
    where: { id: 1 }, // ID fixo para perfil do sistema
    update: {
      nome: 'Revendedor',
      descricao: 'Pode criar e gerenciar sub-organizações',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        organizacoes: ['listar', 'criar_subtenant', 'gerenciar_subtenants'],
        usuarios: ['listar', 'criar', 'editar', 'perfis'],
        dispositivos: ['listar', 'criar', 'editar', 'excluir', 'comandos'],
        veiculos: ['listar', 'criar', 'editar', 'excluir'],
        motoristas: ['listar', 'criar', 'editar', 'excluir'],
        monitoramento: ['visualizar', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'exportar'],
        geofences: ['listar', 'criar', 'editar', 'excluir', 'alertas'],
        viagens: ['listar', 'visualizar', 'exportar'],
        alertas: ['listar', 'criar', 'editar', 'configurar'],
        configuracoes: ['visualizar', 'editar']
      }),
      sistema: true,
      ativo: true
    },
    create: {
      id: 1,
      nome: 'Revendedor',
      descricao: 'Pode criar e gerenciar sub-organizações',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        organizacoes: ['listar', 'criar_subtenant', 'gerenciar_subtenants'],
        usuarios: ['listar', 'criar', 'editar', 'perfis'],
        dispositivos: ['listar', 'criar', 'editar', 'excluir', 'comandos'],
        veiculos: ['listar', 'criar', 'editar', 'excluir'],
        motoristas: ['listar', 'criar', 'editar', 'excluir'],
        monitoramento: ['visualizar', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'exportar'],
        geofences: ['listar', 'criar', 'editar', 'excluir', 'alertas'],
        viagens: ['listar', 'visualizar', 'exportar'],
        alertas: ['listar', 'criar', 'editar', 'configurar'],
        configuracoes: ['visualizar', 'editar']
      }),
      sistema: true,
      ativo: true,
      organizacao_id: null
    }
  });
  console.log('✅ Perfil Revendedor criado/atualizado:', perfilRevendedor.nome);

  // Perfil Administrador - acesso completo à organização
  const perfilAdmin = await prisma.perfilPermissao.upsert({
    where: { id: 2 },
    update: {
      nome: 'Administrador',
      descricao: 'Acesso administrativo completo à organização',
      permissoes: JSON.stringify({
        dashboard: ['visualizar', 'exportar'],
        organizacoes: ['listar', 'editar', 'configurar'],
        usuarios: ['listar', 'criar', 'editar', 'excluir', 'perfis'],
        dispositivos: ['listar', 'criar', 'editar', 'excluir', 'comandos', 'diagnostico'],
        veiculos: ['listar', 'criar', 'editar', 'excluir', 'exportar'],
        motoristas: ['listar', 'criar', 'editar', 'excluir', 'exportar'],
        monitoramento: ['visualizar', 'comandos', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'criar', 'exportar', 'agendar'],
        geofences: ['listar', 'criar', 'editar', 'excluir', 'alertas'],
        viagens: ['listar', 'visualizar', 'exportar', 'analise'],
        alertas: ['listar', 'criar', 'editar', 'excluir', 'configurar'],
        configuracoes: ['visualizar', 'editar', 'avancadas'],
        auditoria: ['visualizar', 'exportar'],
        lgpd: ['visualizar', 'exportar_dados', 'consentimentos']
      }),
      sistema: true,
      ativo: true
    },
    create: {
      id: 2,
      nome: 'Administrador',
      descricao: 'Acesso administrativo completo à organização',
      permissoes: JSON.stringify({
        dashboard: ['visualizar', 'exportar'],
        organizacoes: ['listar', 'editar', 'configurar'],
        usuarios: ['listar', 'criar', 'editar', 'excluir', 'perfis'],
        dispositivos: ['listar', 'criar', 'editar', 'excluir', 'comandos', 'diagnostico'],
        veiculos: ['listar', 'criar', 'editar', 'excluir', 'exportar'],
        motoristas: ['listar', 'criar', 'editar', 'excluir', 'exportar'],
        monitoramento: ['visualizar', 'comandos', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'criar', 'exportar', 'agendar'],
        geofences: ['listar', 'criar', 'editar', 'excluir', 'alertas'],
        viagens: ['listar', 'visualizar', 'exportar', 'analise'],
        alertas: ['listar', 'criar', 'editar', 'excluir', 'configurar'],
        configuracoes: ['visualizar', 'editar', 'avancadas'],
        auditoria: ['visualizar', 'exportar'],
        lgpd: ['visualizar', 'exportar_dados', 'consentimentos']
      }),
      sistema: true,
      ativo: true,
      organizacao_id: null
    }
  });
  console.log('✅ Perfil Administrador criado/atualizado:', perfilAdmin.nome);

  // Perfil Operador - operações do dia-a-dia
  const perfilOperador = await prisma.perfilPermissao.upsert({
    where: { id: 3 },
    update: {
      nome: 'Operador',
      descricao: 'Operações do dia-a-dia, monitoramento e gestão de veículos',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        dispositivos: ['listar', 'comandos'],
        veiculos: ['listar', 'editar'],
        motoristas: ['listar', 'editar'],
        monitoramento: ['visualizar', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'exportar'],
        geofences: ['listar', 'alertas'],
        viagens: ['listar', 'visualizar'],
        alertas: ['listar']
      }),
      sistema: true,
      ativo: true
    },
    create: {
      id: 3,
      nome: 'Operador',
      descricao: 'Operações do dia-a-dia, monitoramento e gestão de veículos',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        dispositivos: ['listar', 'comandos'],
        veiculos: ['listar', 'editar'],
        motoristas: ['listar', 'editar'],
        monitoramento: ['visualizar', 'historico', 'tempo_real'],
        relatorios: ['visualizar', 'exportar'],
        geofences: ['listar', 'alertas'],
        viagens: ['listar', 'visualizar'],
        alertas: ['listar']
      }),
      sistema: true,
      ativo: true,
      organizacao_id: null
    }
  });
  console.log('✅ Perfil Operador criado/atualizado:', perfilOperador.nome);

  // Perfil Visualizador - apenas leitura
  const perfilVisualizador = await prisma.perfilPermissao.upsert({
    where: { id: 4 },
    update: {
      nome: 'Visualizador',
      descricao: 'Acesso somente leitura ao sistema',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        dispositivos: ['listar'],
        veiculos: ['listar'],
        motoristas: ['listar'],
        monitoramento: ['visualizar'],
        geofences: ['listar'],
        viagens: ['listar', 'visualizar']
      }),
      sistema: true,
      ativo: true
    },
    create: {
      id: 4,
      nome: 'Visualizador',
      descricao: 'Acesso somente leitura ao sistema',
      permissoes: JSON.stringify({
        dashboard: ['visualizar'],
        dispositivos: ['listar'],
        veiculos: ['listar'],
        motoristas: ['listar'],
        monitoramento: ['visualizar'],
        geofences: ['listar'],
        viagens: ['listar', 'visualizar']
      }),
      sistema: true,
      ativo: true,
      organizacao_id: null
    }
  });
  console.log('✅ Perfil Visualizador criado/atualizado:', perfilVisualizador.nome);

  // ========== PLANOS COM SUPORTE A SUBTENANTS ==========
  console.log('\n📦 Atualizando planos com suporte a subtenants...');

  // Plano Enterprise com subtenants ilimitados
  await prisma.plano.upsert({
    where: { nome: 'enterprise' },
    update: {
      max_subtenants: -1,  // Ilimitado
      descricao: 'Plano completo com subtenants ilimitados'
    },
    create: {
      nome: 'enterprise',
      descricao: 'Plano completo com subtenants ilimitados',
      max_dispositivos: 1000,
      max_usuarios: 100,
      max_historico_dias: 365,
      max_subtenants: -1,
      funcionalidades: JSON.stringify(['relatorios', 'api', 'whitelabel', 'suporte_prioritario', 'subtenants']),
      preco_mensal: null,
      ativo: true
    }
  });
  console.log('✅ Plano Enterprise atualizado');

  // Plano Profissional com até 10 subtenants
  await prisma.plano.upsert({
    where: { nome: 'profissional' },
    update: {
      max_subtenants: 10,
      descricao: 'Plano profissional com até 10 sub-organizações'
    },
    create: {
      nome: 'profissional',
      descricao: 'Plano profissional com até 10 sub-organizações',
      max_dispositivos: 100,
      max_usuarios: 20,
      max_historico_dias: 90,
      max_subtenants: 10,
      funcionalidades: JSON.stringify(['relatorios', 'api', 'subtenants']),
      preco_mensal: 299.90,
      ativo: true
    }
  });
  console.log('✅ Plano Profissional atualizado');

  // Plano Básico sem subtenants
  await prisma.plano.upsert({
    where: { nome: 'basico' },
    update: {
      max_subtenants: 0,
      descricao: 'Plano básico para pequenas frotas'
    },
    create: {
      nome: 'basico',
      descricao: 'Plano básico para pequenas frotas',
      max_dispositivos: 10,
      max_usuarios: 5,
      max_historico_dias: 30,
      max_subtenants: 0,
      funcionalidades: JSON.stringify(['relatorios']),
      preco_mensal: 99.90,
      ativo: true
    }
  });
  console.log('✅ Plano Básico atualizado');

  // ========== DADOS DE TESTE (OPCIONAL) ==========
  console.log('\n🚗 Criando dados de teste...');

  // Create test device
  const device = await prisma.dispositivo.upsert({
    where: { imei: '123456789012345' },
    update: {},
    create: {
      imei: '123456789012345',
      tipo: 'XT40_OBD2',
      placa: 'ABC-1234',
      veiculo: 'Veículo de Teste',
      status: 'online',
      ultima_conexao: new Date(),
    },
  });

  console.log('✅ Created device:', device.imei);

  // Create test location
  const location = await prisma.localizacao.create({
    data: {
      dispositivo_id: device.id,
      latitude: -15.7933,
      longitude: -48.0019,
      altitude: 950,
      velocidade: 0,
      direcao: 0,
      precisao: 10,
      timestamp: new Date(),
    },
  });

  console.log('✅ Created location:', location.id);

  // Create test OBD2 data
  const obd2 = await prisma.dadosOBD2.create({
    data: {
      dispositivo_id: device.id,
      rpm: 0,
      temperatura_motor: 85,
      nivel_combustivel: 75,
      ignicao: false,
      odometro_plataforma: 50000,
      hora_motor_plataforma: 1200,
      timestamp: new Date(),
    },
  });

  console.log('✅ Created OBD2 data:', obd2.id);

  // Create test alarm
  const alarm = await prisma.alarme.create({
    data: {
      dispositivo_id: device.id,
      tipo_alarme: 'Test Alert',
      descricao: 'Sistema de rastreamento inicializado',
      severidade: 'info',
      timestamp: new Date(),
    },
  });

  console.log('✅ Created alarm:', alarm.id);

  console.log('\n✨ Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
