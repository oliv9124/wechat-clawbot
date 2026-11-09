#!/bin/bash
# 上线前自检：在某个机器人目录里运行（用它自己的凭证）。读一条有 AI 字幕的公开视频，应该几秒内直接读到字幕
cd "${1:-$PWD}" || exit 1
out=$(python3 "$(dirname "$0")/scripts/bilibili.py" "${2:-https://www.bilibili.com/video/BV126nt6GE4W}")
echo "$out" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("ok" if r.get("success") else "FAIL", r.get("from_subtitle"), len(r.get("text") or ""), "字", r.get("error", ""))'
