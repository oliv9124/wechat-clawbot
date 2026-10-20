# WeChat ClawBot Core Engine (共享核心引擎)

本目录为微信机器人的通用基础核心引擎，所有服务代码全局唯一，由各个机器人实例（Profile）共享调用。

## 模块结构

| 文件 | 职责 |
| :--- | :--- |
| `routine_server.js` | 核心 HTTP Webhook 服务，接收转发消息并调用 `agy` 生成回复，处理图文/视频/文件卡片下发 |
| `wechat_forwarder.js` | 核心微信 iLink 长轮询服务，监听微信消息，自动下载解密用户媒体并中继到 Routine |
| `wechat_reply.js` | 核心 iLink 通信库（动态加载对应实例的 `config.json`，发送文本、输入中、媒体与文件卡片） |
| `scheduler.js` | 核心定时器与即时提醒引擎，动态加载当前实例的 `schedules.js` 与 `reminders.json` |
| `weather.js` | 免费实时气象服务（基于 Open-Meteo，支持任意城市与经纬度查询） |
| `login.js` | 微信 iLink 扫码认证工具（自动生成终端二维码与图片二维码） |

## 运行机制

每个机器人实例在启动时，将其自身目录作为 `cwd`（工作目录）。`core` 内的代码会自动：
1. 从 `cwd` 读取专属 `config.json`（自动获取端口、机器人名称、用户昵称、微信 Token）；
2. 从 `cwd` 读取专属 `schedules.js`（定时播报任务）与 `MEMORY.md`（长期人设与记忆）；
3. 将动态日志与数据写入 `cwd/data/` 目录（完全物理隔离）。
