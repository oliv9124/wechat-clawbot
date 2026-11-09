#!/bin/bash
# 上线前自检：给一个音频或视频文件，应该转出文字
[ -f "$1" ] || { echo "用法：test.sh <音频或视频文件>"; exit 2; }
python3 "$(dirname "$0")/scripts/transcribe.py" "$1" | python3 -c 'import json,sys; r=json.load(sys.stdin); print("ok" if r.get("success") else "FAIL", len(r.get("text") or ""), "字，排队", r.get("waited_sec"), "秒", r.get("error", ""))'
