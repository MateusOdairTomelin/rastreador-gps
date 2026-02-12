module.exports = {
  apps: [
    // ============ INSTÂNCIA PRINCIPAL (TCP + HTTP + WebSocket) ============
    {
      name: 'rastreador-master',
      script: './server/index.js',
      cwd: '/home/tomelin/rastreador',

      instances: 1,
      exec_mode: 'fork',

      // Ambiente
      env: {
        NODE_ENV: 'production',
        HTTP_PORT: 62000,
        TCP_PORT: 8877,
        INSTANCE_ID: 0,
        IS_MASTER: 'true',
        // Habilitar todos os serviços nesta instância
        ENABLE_TCP: 'true',
        ENABLE_HTTP: 'true',
        ENABLE_WEBSOCKET: 'true',
        ENABLE_METRICS: 'true'
      },

      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/home/tomelin/rastreador/logs/master-error.log',
      out_file: '/home/tomelin/rastreador/logs/master-out.log',
      merge_logs: true,

      // Auto-restart
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      kill_timeout: 10000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s'
    },

    // ============ WORKERS HTTP (load balanced) ============
    {
      name: 'rastreador-worker',
      script: './server/index.js',
      cwd: '/home/tomelin/rastreador',

      // 3 instâncias workers para HTTP
      instances: 3,
      exec_mode: 'cluster',

      // Ambiente - portas diferentes para cada worker
      env: {
        NODE_ENV: 'production',
        HTTP_PORT: 62001, // PM2 incrementa automaticamente em cluster mode
        INSTANCE_ID: 'worker',
        IS_MASTER: 'false',
        // Desabilitar TCP nessas instâncias (apenas HTTP)
        ENABLE_TCP: 'false',
        ENABLE_HTTP: 'true',
        ENABLE_WEBSOCKET: 'true',
        ENABLE_METRICS: 'false' // Apenas master coleta métricas
      },

      // Incrementar porta para cada instância
      increment_var: 'HTTP_PORT',

      // Logs
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/home/tomelin/rastreador/logs/worker-error.log',
      out_file: '/home/tomelin/rastreador/logs/worker-out.log',
      merge_logs: true,

      // Auto-restart
      watch: false,
      max_memory_restart: '400M',
      restart_delay: 3000,
      kill_timeout: 8000,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',

      // Wait for master to start first
      wait_ready: true,
      listen_timeout: 10000
    }
  ]
};
