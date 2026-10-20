#!/bin/bash
set -e

echo "========================================================="
echo "   🚀 WeChat ClawBot 智能全能助手 - 一键环境部署安装器"
echo "========================================================="

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
    echo "❌ 未检测到 Node.js，请先安装 Node.js (推荐 v18 或更高版本)！"
    echo "Ubuntu/Debian: sudo apt install -y nodejs npm"
    echo "macOS: brew install node"
    exit 1
fi
echo "✅ Node.js 环境: $(node -v)"

# 2. 检查 npm
if ! command -v npm >/dev/null 2>&1; then
    echo "❌ 未检测到 npm，请先安装 npm！"
    exit 1
fi

# 3. 检查并提示 PM2
if ! command -v pm2 >/dev/null 2>&1; then
    echo "⚠️ 未检测到 pm2 进程守护工具，正在尝试全局安装..."
    npm install -g pm2 || {
        echo "❌ pm2 全局安装失败，请手动执行: sudo npm install -g pm2"
        exit 1
    }
fi
echo "✅ PM2 守护工具: $(pm2 -v)"

# 4. 检查 Python 3
if ! command -v python3 >/dev/null 2>&1; then
    echo "❌ 未检测到 python3，建议安装 Python 3.10+ 以启用短视频原画下载与文案提取！"
fi

# 5. 检查 ffmpeg
if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "⚠️ 未检测到 ffmpeg，微信原生视频卡片封面截取与音频转码需要 ffmpeg。"
    echo "请执行安装: sudo apt install -y ffmpeg  或  brew install ffmpeg"
else
    echo "✅ ffmpeg 媒体引擎就绪"
fi

# 6. 安装 core 核心依赖
echo ""
echo "📦 正在安装 core 核心引擎依赖包 (qrcode, qrcode-terminal)..."
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR/core"
npm install --no-audit --no-fund

# 7. 初始化 starter-bot 实例环境
echo ""
echo "⚙️ 初始化 starter-bot 运行环境..."
if [ ! -f "$DIR/bots/starter-bot/config.json" ]; then
    cp "$DIR/bots/starter-bot/config.example.json" "$DIR/bots/starter-bot/config.json"
fi
if [ ! -f "$DIR/bots/starter-bot/tasks.js" ]; then
    cp "$DIR/bots/starter-bot/tasks.example.js" "$DIR/bots/starter-bot/tasks.js"
fi
mkdir -p "$DIR/bots/starter-bot/data/downloads/douyin" \
         "$DIR/bots/starter-bot/data/downloads/bilibili" \
         "$DIR/bots/starter-bot/data/downloads/xiaohongshu" \
         "$DIR/bots/starter-bot/data/downloads/wechat"

# 8. 引导用户扫码
echo ""
echo "========================================================="
echo "🎉 核心依赖安装完毕！"
echo "========================================================="
echo "👉 下一步操作指南："
echo "1. 执行扫码绑定您的个人微信："
echo "   cd $DIR/bots/starter-bot"
echo "   node ../../core/login.js"
echo ""
echo "2. 扫码成功后，在手机微信 ClawBot 对话窗口里发送一句话（如“你好”）激活会话"
echo ""
echo "3. 启动后台 24 小时常驻守护服务："
echo "   ./start.sh"
echo "========================================================="
