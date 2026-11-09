---
name: douyin
description: >-
  抖音：下载无水印原画视频，转出逐字稿并提炼要点。
  用户发来抖音链接或分享文本（v.douyin.com、douyin.com）要下载视频、提取文案、总结时用。
---

# 抖音（官方技能）

## 怎么用

```bash
python3 .agents/skills/douyin/scripts/douyin.py "<抖音链接或分享文本>" --output-dir "$PWD/data/downloads"
```

- 视频下载到 `data/downloads/douyin/`，接着自动转出逐字稿（要排队，视频长就慢一些）。只要视频、不要文字时加 `--no-transcribe`。
- 输出是 JSON：`video_path` 视频文件、`text` 逐字稿、`summary` 要点。
- 先用原生视频卡片把视频发给用户，再发要点和逐字稿。

## 凭证

- 可选：大部分视频不登录也能下。下不了时，告诉用户在微信里发「设置凭证 抖音 <cookie>」，程序会直接存到这个机器人自己的 `data/skills/douyin/cookie.txt`（不经过你，也不进聊天记录）。

## 回复格式

```text
🎬 文案提取与重点解析已完成！

💡 【核心要点总结】
• 要点 1 …

📝 【完整逐字稿台词】
……
```
