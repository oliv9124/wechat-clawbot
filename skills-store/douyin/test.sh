#!/bin/bash
# 上线前自检：在某个机器人目录里运行。下载一条公开视频（不转文字），应该拿到 mp4 文件
cd "${1:-$PWD}" || exit 1
out=$(python3 "$(dirname "$0")/scripts/douyin.py" "${2:-https://www.douyin.com/video/7683895013282107067}" --no-transcribe)
echo "$out" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("ok" if r.get("success") else "FAIL", r.get("size_mb", ""), "MB", r.get("error", ""))'
