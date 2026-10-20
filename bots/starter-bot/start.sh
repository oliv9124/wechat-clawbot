#!/bin/bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR" || exit 1

echo "正在通过 PM2 启动/重载当前微信机器人服务..."
pm2 startOrReload ecosystem.config.cjs
pm2 save
pm2 status
