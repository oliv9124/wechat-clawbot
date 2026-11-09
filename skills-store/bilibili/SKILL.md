---
name: bilibili
description: >-
  B站视频：读字幕或把音频转成逐字稿，再提炼要点；用户明确要视频时才下载 MP4。
  用户发来 B站 链接（bilibili.com、b23.tv 短链、BV 号）要总结、提取文案、下载视频时用。
---

# B站（官方技能）

## 怎么用

```bash
python3 .agents/skills/bilibili/scripts/bilibili.py "<B站链接或分享文本>" --output-dir "$PWD/data/downloads"
```

- 默认只取文字：拿得到这个视频自己的字幕就直接读（几秒钟）。B站的字幕接口不稳定，经常给别的视频的字幕或者不给，脚本会核对、对不上就不用，改成下载音频转文字（要排队，视频越长越慢，可以先跟用户说一声）。
- 用户明确说"下载这个视频"时才加 `--download-video`：MP4 放在 `data/downloads/bilibili/`，用原生视频卡片发给用户。
- 输出是 JSON：`text` 逐字稿、`summary` 要点、`from_subtitle` 是不是读的字幕、`video_path` 下载了视频才有。

## 凭证

- 很多视频不登录拿不到 AI 字幕和音频。凭证存在这个机器人自己的 `data/skills/bilibili/cookie.txt`，只有它自己能读。
- 结果里说"要登录"，或者还没有凭证时：告诉用户在微信里发「设置凭证 B站 <cookie>」，程序会直接存好（不经过你，也不进聊天记录）。不要让用户把 cookie 当普通消息发给你。

## 回复格式

```text
🎬 文案提取与重点解析已完成！

💡 【核心要点总结】
• 要点 1 …
• 要点 2 …

📝 【完整逐字稿台词】
……
```
