// PM2 process definition. Start with:  pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'crypto-gateway',
      script: 'server.js',
      instances: 1,            // single instance: the poller must not run in parallel
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
