module.exports = {
  apps: [
    {
      name: 'backend',
      script: 'server.js',
      cwd: __dirname,
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
      },
      error_file: '/home/ubuntu/logs/backend-error.log',
      out_file: '/home/ubuntu/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
    },
  ],
};
