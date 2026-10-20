const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'wechat-routine',
      script: path.resolve(__dirname, '../../core/routine_server.js'),
      cwd: __dirname,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 20,
    },
    {
      name: 'wechat-forwarder',
      script: path.resolve(__dirname, '../../core/wechat_forwarder.js'),
      cwd: __dirname,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 20,
    },
    {
      name: 'wechat-scheduler',
      script: path.resolve(__dirname, '../../core/scheduler.js'),
      cwd: __dirname,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 20,
    },
  ],
};
