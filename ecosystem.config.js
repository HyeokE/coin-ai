module.exports = {
  apps: [
    {
      name: 'auto-coin-bot',
      script: 'dist/index.js',
      cwd: '/home/ubuntu/auto-coin',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      interpreter: 'node',
      interpreter_args: '-r dotenv/config',
      env: {
        NODE_ENV: 'production',
      },
      error_file: '/home/ubuntu/auto-coin/logs/bot-error.log',
      out_file: '/home/ubuntu/auto-coin/logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'auto-coin-dashboard',
      script: 'dist/dashboard/server.js',
      cwd: '/home/ubuntu/auto-coin',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      interpreter: 'node',
      interpreter_args: '-r dotenv/config',
      env: {
        NODE_ENV: 'production',
        DASHBOARD_PORT: 3001,
      },
      error_file: '/home/ubuntu/auto-coin/logs/dashboard-error.log',
      out_file: '/home/ubuntu/auto-coin/logs/dashboard-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};

