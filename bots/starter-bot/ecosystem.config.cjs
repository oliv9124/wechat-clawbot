// PM2 托管这个机器人的 3 个进程。进程名用目录名做前缀（比如 starter-bot-routine），多开时互不冲突。
const path = require('node:path');

const bot = path.basename(__dirname);
const app = (role, script) => ({
  name: `${bot}-${role}`,
  script: path.resolve(__dirname, '../../core', script),
  cwd: __dirname,
  env: { NODE_ENV: 'production' },
  restart_delay: 3000,
  max_restarts: 20,
});

module.exports = {
  apps: [
    app('routine', 'routine_server.js'), // 处理消息、调用智能体、回复
    app('forwarder', 'wechat_forwarder.js'), // 接收微信消息，写进收件箱
    app('scheduler', 'scheduler.js'), // 定时任务、提醒、凌晨记忆整理
  ],
};
