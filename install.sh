#!/bin/bash
# 准备运行环境：检查依赖、安装 PM2 和 core/ 的 npm 包、把 bots/starter-bot 准备好（已有的文件不覆盖）
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================================="
echo "   WeChat ClawBot：检查环境并安装依赖"
echo "========================================================="

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 Node.js，请先安装 Node.js 18 以上（推荐 22）：https://nodejs.org"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 18 ]; then
  echo "❌ Node.js 版本太旧（$(node -v)），需要 18 以上"
  exit 1
fi
echo "✅ Node.js $(node -v)"

command -v npm >/dev/null 2>&1 || { echo "❌ 没找到 npm"; exit 1; }

if command -v git >/dev/null 2>&1; then
  echo "✅ git $(git --version | awk '{print $3}')"
else
  echo "⚠️ 没找到 git：记忆历史（「记忆改动」「撤销记忆」、早间的记忆变动汇报）会关闭。安装：sudo apt install -y git"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "… 没找到 PM2，正在安装（npm install -g pm2）"
  npm install -g pm2 || { echo "❌ PM2 安装失败，请手动执行：sudo npm install -g pm2"; exit 1; }
fi
echo "✅ PM2 $(pm2 -v)"

if command -v agy >/dev/null 2>&1; then
  echo "✅ Antigravity CLI（agy）"
else
  echo "⚠️ 没找到 agy（Google Antigravity CLI）：机器人要靠它回答问题，请先安装并登录（agy -p \"你好\" 能正常回答）"
fi
command -v python3 >/dev/null 2>&1 || echo "⚠️ 没找到 python3：短视频下载和文案提取用不了（建议 Python 3.10+）"
command -v ffmpeg >/dev/null 2>&1 || echo "⚠️ 没找到 ffmpeg：视频卡片的封面和时长用不了。安装：sudo apt install -y ffmpeg 或 brew install ffmpeg"
[ "$(id -u)" = 0 ] && echo "⚠️ 正在用 root 运行：建议换成普通账号，智能体会以运行它的账号的权限执行命令"

echo ""
echo "📦 安装 core/ 的依赖"
(cd "$DIR/core" && npm install --no-audit --no-fund)

echo ""
bash "$DIR/scripts/new_bot.sh" starter-bot

echo ""
echo "========================================================="
echo "🎉 准备好了，接下来："
echo "1. 扫码绑定微信："
echo "     cd $DIR/bots/starter-bot && node ../../core/login.js"
echo "2. 在手机微信的 ClawBot 对话里随便发一句话，激活会话"
echo "3. 启动：./start.sh"
echo "可选：告警监控  pm2 start $DIR/ecosystem.monitor.cjs && pm2 save"
echo "========================================================="
