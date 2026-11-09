#!/bin/bash
# 启动小红书 MCP 服务

XHS_MCP="$HOME/.local/bin/xiaohongshu-mcp"
PID_FILE="$HOME/.xiaohongshu/mcp.pid"
LOG_FILE="$HOME/.xiaohongshu/mcp.log"

# Cookies 路径（可通过环境变量覆盖）
# XHS_COOKIES_SRC: 源 cookies 文件（用于远程服务器场景）
# 默认检查 ~/cookies.json 和 ~/.xiaohongshu/cookies.json
COOKIES_DST="/tmp/cookies.json"

mkdir -p "$HOME/.xiaohongshu"

# 同步 cookies（支持多个可能的来源）
# 机器人自己存的小红书凭证（用户在微信里发「设置凭证 小红书 <cookie>」，存在它自己的 data/skills/xiaohongshu/cookie.txt）
BOT_COOKIE="${CLAWBOT_BOT_DIR:-$PWD}/data/skills/xiaohongshu/cookie.txt"

sync_cookies() {
    local src=""

    # 优先用机器人自己存的凭证，转成 MCP 要的格式；写出来的文件只有自己能读
    if [ -s "$BOT_COOKIE" ]; then
        (umask 077; python3 - "$BOT_COOKIE" "$COOKIES_DST" <<'PY'
import json, sys
pairs = [p.strip().split('=', 1) for p in open(sys.argv[1], encoding='utf-8').read().strip().split(';') if '=' in p]
json.dump([{'name': k.strip(), 'value': v.strip(), 'domain': '.xiaohongshu.com', 'path': '/', 'expires': -1,
            'httpOnly': False, 'secure': False} for k, v in pairs], open(sys.argv[2], 'w'))
PY
        )
        chmod 600 "$COOKIES_DST"
        echo "已用这个机器人自己存的小红书凭证"
        return
    fi

    # 优先使用环境变量指定的路径
    if [ -n "$XHS_COOKIES_SRC" ] && [ -f "$XHS_COOKIES_SRC" ]; then
        src="$XHS_COOKIES_SRC"
    elif [ -f "$HOME/cookies.json" ]; then
        src="$HOME/cookies.json"
    elif [ -f "$HOME/.xiaohongshu/cookies.json" ]; then
        src="$HOME/.xiaohongshu/cookies.json"
    fi

    if [ -n "$src" ]; then
        if [ ! -f "$COOKIES_DST" ] || [ "$src" -nt "$COOKIES_DST" ]; then
            (umask 077; cp "$src" "$COOKIES_DST")
            chmod 600 "$COOKIES_DST"
            echo "已同步 cookies: $src -> $COOKIES_DST"
        fi
    fi
}

sync_cookies

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "MCP 服务已在运行 (PID: $PID)"
        echo "如需重启，请先运行 stop-mcp.sh"
        exit 0
    fi
fi

# 解析参数
HEADLESS="true"
for arg in "$@"; do
    case $arg in
        --headless=false)
            HEADLESS="false"
            ;;
    esac
done

# 启动服务
echo "启动小红书 MCP 服务..."
if [ "$HEADLESS" = "false" ]; then
    nohup "$XHS_MCP" -headless=false > "$LOG_FILE" 2>&1 &
else
    nohup "$XHS_MCP" > "$LOG_FILE" 2>&1 &
fi

echo $! > "$PID_FILE"
sleep 2

# 验证启动
if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "✓ MCP 服务已启动 (PID: $(cat $PID_FILE))"
    echo "  端点: http://localhost:18060/mcp"
    echo "  日志: $LOG_FILE"
else
    echo "✗ 启动失败，查看日志: $LOG_FILE"
    cat "$LOG_FILE"
    exit 1
fi
