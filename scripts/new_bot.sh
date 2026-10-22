#!/bin/bash
# 新建一个机器人：bash scripts/new_bot.sh <名字> [端口]
# 从 bots/starter-bot 里的模板（*.example.*）复制出配置、人设、任务和专题；已经有的文件不覆盖，可以放心重复运行。
# 名字只能用字母、数字、- 和 _（它也是 PM2 进程名的前缀）；端口不写就自动选一个其他机器人没用的。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-}"
PORT="${2:-}"
if ! [[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "用法：bash scripts/new_bot.sh <名字> [端口]（名字只能用字母、数字、- 和 _）"
  exit 1
fi
T="$ROOT/bots/starter-bot"
B="$ROOT/bots/$NAME"

mkdir -p "$B/data/memory/topics"
for d in bilibili douyin xiaohongshu wechat; do mkdir -p "$B/data/downloads/$d"; done
copy() { [ -e "$B/$2" ] || cp "$T/$1" "$B/$2"; }
copy MEMORY.example.md MEMORY.md
copy tasks.example.js tasks.js
copy topics.example.json topics.json
if [ "$B" != "$T" ]; then
  cp "$T/ecosystem.config.cjs" "$T/start.sh" "$B/"
  chmod +x "$B/start.sh"
fi

if [ ! -e "$B/config.json" ]; then
  # 本地接口的密钥随机生成；端口取其他机器人用过的最大端口 + 1（第一个是 18888）
  BOT_DIR="$B" ROOT="$ROOT" WANT_PORT="$PORT" node - <<'JS'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const botsDir = path.join(process.env.ROOT, 'bots');
const used = fs.readdirSync(botsDir)
  .map((n) => { try { return Number(JSON.parse(fs.readFileSync(path.join(botsDir, n, 'config.json'), 'utf-8')).port); } catch { return 0; } })
  .filter(Boolean);
const port = Number(process.env.WANT_PORT) || (used.length ? Math.max(...used) + 1 : 18888);
if (used.includes(port)) {
  console.error(`端口 ${port} 已经被其他机器人用了，换一个`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(botsDir, 'starter-bot', 'config.example.json'), 'utf-8'));
cfg.port = port;
cfg.webhook_url = `http://127.0.0.1:${port}/webhook/wechat`;
cfg.webhook_key = crypto.randomBytes(24).toString('hex');
const file = path.join(process.env.BOT_DIR, 'config.json');
fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
console.log(`已生成 ${path.relative(process.env.ROOT, file)}（端口 ${port}）`);
JS
fi

echo "✅ bots/$NAME 准备好了。下一步：cd bots/$NAME && node ../../core/login.js 扫码绑定微信，然后 ./start.sh"
