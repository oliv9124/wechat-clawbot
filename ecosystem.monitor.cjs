// 可选：告警监控（一台机器一个）。每 30 秒检查 bots/ 下所有机器人，出问题时经这个机器人自己的微信通知它的用户；
// 用 deploy/set_alert_email.sh 配置了邮件的话同时发邮件。启动：pm2 start ecosystem.monitor.cjs && pm2 save
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'clawbot-monitor',
      script: path.join(__dirname, 'core', 'monitor.js'),
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        CLAWBOT_BOTS_DIR: path.join(__dirname, 'bots'),
        CLAWBOT_ALERT_CONFIG: path.join(__dirname, 'alert.json'),
        CLAWBOT_MONITOR_STATE: path.join(__dirname, 'data', 'monitor.json'),
      },
      restart_delay: 10000,
    },
  ],
};
