---
name: video-transcriber
description: >-
  短视频原画下载、无水印视频解析、语音识别逐字稿提取与AI核心要点总结。
  使用场景：
  - 用户发送抖音、小红书、B站等短视频链接，要求下载视频或提取文案
  - "下载这个视频"
  - "提取视频台词/逐字稿"
  - "总结视频核心重点"
---

# 视频原画下载与文案逐字稿提取技能 (video-transcriber)

本技能提供全自动短视频解析、无水印原画下载、离线极速语音识别（Faster-Whisper CPU int8 推理）及 AI 核心要点提炼能力。

## 一、 核心执行命令

```bash
python3 /root/agy/.agents/skills/video-transcriber/scripts/video_transcriber.py "<url_or_filepath>" --output-dir "<downloads_dir>"
```

### 参数说明：
- `<url_or_filepath>`: 视频的分享链接（如抖音短链 https://v.douyin.com/...、B站链接 https://www.bilibili.com/video/BV... 或 b23.tv 短链）或本地 mp4 绝对路径。
- `--output-dir`: 下载视频保存的目标目录。
- `--download-video`: 强制下载完整视频 MP4（主要针对 B站；默认 B站不下载视频大文件）。

---

## 二、 微信端处理与推送规范

1. **下载目录物理隔离与平台分类归档**：
   - 输出目录指定为**当前机器人实例目录**下的 `data/downloads/`（即 `<实例目录>/data/downloads/`，实例目录就是智能体运行时的当前工作目录）
   - **自动按平台分类归档**：脚本会自动按平台分别存储至 `douyin/`、`bilibili/`、`xiaohongshu/`、`wechat/` 子文件夹。
   - **严禁跨实例混用或访问对方 downloads 目录**。

2. **平台差异化推送策略**：
   - **抖音短视频**：自动下载无水印原画，先推原生 **Type 5 视频卡片 (`video_item`)**，再推【逐字稿台词】与【核心要点总结】。
   - **B站视频（轻量极速原则）**：
     - **默认行为**：仅提取字幕或纯音频转录，**不下载几百 MB 的视频文件**，**不推送视频卡片**，直接将【核心要点总结】与【完整逐字稿台词】以文本形式秒回用户。
     - **特定下载**：仅在用户明确指令（如“下载这个B站视频”）时，才追加 `--download-video` 下载 MP4 并推 Type 5 视频卡片。

3. **B站凭证配置**：
   - 配置文件路径：`config/bilibili_config.json`（存放 `cookie` 或 `sessdata`）。配置后可稳定穿透云服务器机房 IP 的 412 风控。

4. **逐字稿与摘要回复格式**：
   - 回复提炼出的文本：
     ```text
     🎬 文案提取与重点解析已完成！

     💡 【核心要点总结】
     • 要点 1 ...
     • 要点 2 ...

     📝 【完整逐字稿台词】
     ……（完整普通话台词）……
     ```

