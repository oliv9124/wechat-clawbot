# WeChat ClawBot Instances (机器人实例专区)

本目录为机器人多实例（Profiles）存放专区。系统采用统一核心引擎与实例配置分离设计，支持单机运行任意多个独立微信机器人。

## 默认实例说明

- **`starter-bot/`**：预置的开箱即用实例模版。
  - 端口：默认 `18888`
  - 称呼：默认 `主人`（助手自称 `小助理`）
  - 功能：支持直接扫码绑定、自带早间天气预报、工作日午餐提醒、晚间休息关怀、短视频无水印下载与文案提取。

## 实例规范目录结构

每个机器人实例包含且仅需包含以下专属私有文件：
```text
<bot_name>/
├── config.json          # 专属私有配置（Token、端口、称呼等）
├── config.example.json  # 模板配置
├── MEMORY.md            # 专属人设与长期记忆
├── tasks.js             # 专属定时任务定义
├── ecosystem.config.cjs # PM2 进程守护配置（直连 ../../core/*.js）
├── start.sh             # 快捷启动脚本
└── data/                # 专属运行时数据与缓存（完全物理隔离）
    ├── chat_history.log # 对话记录
    ├── reminders.json   # 动态提醒数据
    ├── scheduler_state.json # 定时任务状态
    ├── qrcode.png       # 登录二维码
    └── downloads/       # 平台分类存储 (bilibili/douyin/xiaohongshu/wechat)
```

## 新增机器人步骤（1 分钟快速创建新号）

如需在一台机器上同时运行多个不同微信：
1. 复制模版目录：
   ```bash
   cp -r bots/starter-bot bots/my-second-bot
   ```
2. 编辑 `bots/my-second-bot/config.json`：
   - 将 `port` 改为一个新端口（如 `18889`）；
   - 将 `webhook_url` 改为新端口（如 `http://127.0.0.1:18889/webhook/wechat`）；
   - 将 `bot_token` 和 `authorized_user_id` 置空 `""`；
   - 自定义 `user_nickname` 与 `bot_name`。
3. 编辑 `bots/my-second-bot/ecosystem.config.cjs`：
   - 将 PM2 app 名称加上后缀避免冲突（如 `wechat-routine-2`、`wechat-forwarder-2`、`wechat-scheduler-2`）。
4. 运行扫码登录：
   ```bash
   cd bots/my-second-bot
   node ../../core/login.js
   ```
5. 启动服务：
   ```bash
   ./start.sh
   ```
