const { env } = require('./service.config.cjs');

module.exports = {
  apps: [
    {
      name: env.serviceName,
      script: 'dist/main.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
