---
name: transcribe
description: >-
  把音频或视频文件转成逐字稿并提炼要点（本地 Whisper，不联网）。
  用户发来语音、音频、视频文件（在 data/downloads/wechat/ 等目录里）要转文字、整理会议录音、提取台词时用。
---

# 转文字（官方技能）

## 怎么用

```bash
python3 .agents/skills/transcribe/scripts/transcribe.py "<音频或视频文件的路径>"
```

- 输出是 JSON：`text` 逐字稿、`summary` 要点、`duration_sec` 时长、`waited_sec` 排队等了多久。
- 整台服务器同一时间只跑一个转写，其他的排队；长的录音要几分钟，开始前跟用户说一声。
- 抖音、B站技能需要转文字时会自己调用这里，不用另外装也能用；只有直接转用户发来的文件时才需要装这个技能。
