# WeChat ClawBot - 微信智能全能助手 (基于 Antigravity CLI)

这是一个基于腾讯官方微信 iLink 协议打造的高可用、企业级个人微信 AI 助手。底层接入 **Google Antigravity CLI (`agy`)**，具备大模型深度推理、多轮会话记忆、自动化工具调用、多模态多媒体处理与 24 小时日程调度能力。

---

## 🌟 核心特性

- 💬 **智能全双工对话**：支持任意任务咨询、代码调试、系统运维与自由聊天，具备多轮会话记忆与快捷指令（输入 `/reset` 即可一键开启全新会话）；
- 🎙 **微信语音原生识别**：接收微信语音消息时自动提取官方高精度 ASR 转写文本，无需手动打字；
- 🖼 **多模态图文理解**：直接在微信中发送照片或截图，小助手会自动完成解密分析并给出专业回复；
- 🎬 **原生 Type 5 视频卡片**：下载与交付视频时，自动通过 ffmpeg 提取首帧封面与精确时长，以微信原生小视频卡片下发，聊天窗口内点击即可全屏无缝播放；
- 📝 **短视频文案提取与核心要点总结**：用户发送短视频链接（抖音、B站、小红书等），自动解析并下载原画，同时调用 Faster-Whisper 或官方字幕提取逐字稿台词，生成核心重点速览；
- ⏰ **24 小时智能日程调度**：内置天气预报（自动读取 Open-Meteo 无需 Key）、工作日午餐提醒、晚安关怀；支持随口说“10分钟后提醒我倒水”即时入库并准时提醒；
- 🏢 **多实例（Profiles）架构**：统一核心引擎，完全物理隔离各账号的 Token、人设与数据，轻松在单机上部署 2 个或更多独立机器人。

---

## 📂 项目结构

```text
├── install.sh                  # 一键环境检查与依赖安装脚本
├── README.md                   # 详细使用手册
├── AGENTS.md                   # AI 核心准则与记忆定义（时效性联网搜索、视频下发规则）
├── GEMINI.md                   # AI 核心准则镜像文件
├── .gitignore                  # Git 安全忽略规则（防凭证泄漏）
│
├── core/                       # 核心通用共享引擎
│   ├── routine_server.js       # Webhook 中枢与消息队列（异步队列 + 输入状态反馈）
│   ├── wechat_forwarder.js     # 微信 iLink 消息长轮询监听器
│   ├── wechat_reply.js         # 消息发送封装、AES 加解密与腾讯 CDN 直连引擎
│   ├── scheduler.js            # 24小时日常定时提醒与即时任务调度器
│   ├── weather.js              # 免费实时气象服务 (Open-Meteo)
│   ├── login.js                # 官方 iLink 微信扫码授权绑定脚本
│   └── package.json            # 核心依赖清单 (qrcode, qrcode-terminal)
│
├── skills/                     # 增强技能插件库
│   ├── video-transcriber/      # 视频原画下载、文案提取与总结技能
│   └── xiaohongshu/            # 小红书搜索与舆情分析技能
│
└── bots/                       # 机器人实例专区
    └── starter-bot/            # 预置开箱即用实例模版
        ├── config.json         # 机器人配置（端口、昵称、Token）
        ├── config.example.json # 模板配置
        ├── MEMORY.md           # 专属人设与长期记忆
        ├── tasks.js            # 定时播报任务定义（早间天气/午餐提醒/晚安）
        ├── ecosystem.config.cjs# PM2 进程守护配置 (直连 ../../core/*.js)
        ├── start.sh            # 一键启动守护脚本
        └── data/               # 运行时数据与缓存 (物理隔离)
            ├── chat_history.log# 对话记录
            ├── reminders.json  # 动态提醒数据
            ├── scheduler_state.json # 定时任务状态
            └── downloads/      # 平台分类存储 (bilibili/douyin/xiaohongshu/wechat)
```

---

## 🛠 极速上手指南（3 步上线）

### 第 1 步：安装基础环境与核心依赖

在终端中执行一键安装脚本：
```bash
bash install.sh
```
> 脚本会自动检测并提示安装 Node.js、ffmpeg、Python3 与 PM2，并在 `core/` 下自动完成 npm 依赖安装。

确保当前环境已配置并登录了 Google Antigravity CLI：
```bash
agy --version
```

---

### 第 2 步：扫码绑定您的个人微信

进入默认机器人目录并运行扫码脚本：
```bash
cd bots/starter-bot
node ../../core/login.js
```
1. 终端将输出字符二维码，同时在 `bots/starter-bot/data/` 目录下生成 `qrcode.png`；
2. 用微信扫描二维码并在手机上点击**确认授权**；
3. 授权成功后，程序会自动保存凭证到 `config.json`；
4. **重要**：绑定成功后，请在手机微信的 ClawBot 对话窗口中发送任意文字（如“你好”），激活腾讯网关的首次会话上下文！

---

### 第 3 步：一键启动后台 24 小时守护服务

在 `bots/starter-bot` 目录下执行：
```bash
./start.sh
```
启动后，PM2 将接管后台守护：
- `wechat-routine`：消息处理与 AI 推理中枢
- `wechat-forwarder`：微信消息监听与附件解密
- `wechat-scheduler`：定时天气播报与随口提醒

查看服务运行状态：
```bash
pm2 status
```
查看实时运行日志：
```bash
pm2 logs
```

---

## ⚙️ 个性化定制

### 1. 修改称呼与人设
编辑 `bots/starter-bot/config.json`：
```json
{
  "user_nickname": "浩哥",     // 你的微信昵称（小助手会这样称呼你）
  "bot_name": "贾维斯"         // 小助手的名字
}
```
编辑 `bots/starter-bot/MEMORY.md`，写下你的个人偏好、作息习惯或业务知识，助手会在所有微信对话中记住并运用！

### 2. 定制早间天气城市与定时任务
编辑 `bots/starter-bot/tasks.js`：
- 修改 `fetchWeather('39.9042', '116.4074', '北京')` 为你所在城市的经纬度与名称；
- 任意增减提醒任务（如喝水提醒、站立提醒、股票开盘提醒等）。

---

## 🚀 微信端一键空中升级 (OTA Air-Upgrade)

部署完成后，日常无需登录服务器终端，直接在手机微信即可一键更新系统：
- 随时在手机微信给机器人发送：**`更新系统`** 或 **`/upgrade`**；
- 机器人会自动校验主人权限，秒回接单提示，并在后台连接 GitHub 拉取最新核心代码与技能扩展；
- 更新成功后，小助理会自动平滑热重载后台服务，并在微信中推送最新版本号与更新摘要！

---

## 👥 如何新增第二个机器人（多开）

无需重复安装引擎，只需 1 分钟复制新实例：
```bash
# 1. 复制一份新实例
cp -r bots/starter-bot bots/my-bot-2

# 2. 修改端口与 PM2 名字
# 将 bots/my-bot-2/config.json 中的 port 改为 18889，清空 bot_token
# 将 bots/my-bot-2/ecosystem.config.cjs 中的 name 改为 wechat-routine-2 等

# 3. 扫码登录新微信
cd bots/my-bot-2
node ../../core/login.js

# 4. 启动新微信守护
./start.sh
```

---

## 🔒 隐私与安全性保障

- **零私密外泄**：本发行包已通过自动化安全脱敏审计，所有个人微信 Token、B站 Cookie、聊天记录、下载缓存已全部剔除。
- **本地落盘安全**：微信通信密钥保存在本地服务器，不经过任何第三方中转服务器，直连腾讯官方 iLink 节点。
