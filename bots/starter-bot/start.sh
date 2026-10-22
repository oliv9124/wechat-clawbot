#!/bin/bash
# 用 PM2 启动（已经在运行就重新加载）这个机器人的 3 个进程
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1
if ! grep -qE '"bot_token": *"[^"]+' config.json 2>/dev/null; then
  echo "还没扫码绑定微信：先执行 node ../../core/login.js"
  exit 1
fi
pm2 startOrReload ecosystem.config.cjs && pm2 save
pm2 status
