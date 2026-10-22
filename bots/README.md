# bots：每个机器人一个目录

每个目录就是一个完全独立的机器人：自己的微信、人设、记忆、定时任务和运行数据都在里面。`core/` 的程序以这个目录为工作目录运行。

`starter-bot/` 是第一个机器人，里面的 `*.example.*` 也是新建机器人时用的模板。

## 目录里有什么

```text
<名字>/
├── config.json          # 端口、本地接口密钥、称呼；微信凭证由扫码登录写入（不进 git）
├── MEMORY.md            # 人设和长期记忆，每条消息都带上（不进 git）
├── topics.json          # 专题分卷的名字、文件和关键词（不进 git）
├── tasks.js             # 定时任务（不进 git）
├── ecosystem.config.cjs # PM2 配置：<名字>-routine / -forwarder / -scheduler 三个进程
├── start.sh             # 启动或重新加载这 3 个进程
└── data/                # 运行数据（不进 git）
    ├── inbox/           # 收件箱：pending/ 待处理、processing/ 处理中、failed/ 反复出错需人工查看
    ├── state/           # 运行状态：同步进度、会话、调度器心跳、微信窗口、智能体调用结果、凌晨整理进度
    ├── alerts/          # 待发送的告警事件，监控读完就删
    ├── memory/topics/   # 专题分卷
    ├── memory-history/  # 记忆历史（git 库）和汇报进度
    ├── history/         # 按天的聊天记录（保留 30 天），凌晨整理用
    ├── chat_history.log # 聊天总记录（超过 3MB 自动截掉前一半）
    ├── reminders.json   # 随口提醒
    └── downloads/       # 下载的视频和文件，按平台分类
```

## 新建一个机器人

```bash
bash scripts/new_bot.sh <名字> [端口]
cd bots/<名字>
node ../../core/login.js   # 用这个机器人要绑定的微信扫码
./start.sh
```

`new_bot.sh` 从 `starter-bot` 的模板复制配置、人设、任务和专题，本地接口的密钥随机生成，端口不写就自动选一个没用过的。已经有的文件不会被覆盖。

## 删除一个机器人

```bash
pm2 delete <名字>-routine <名字>-forwarder <名字>-scheduler && pm2 save
rm -r bots/<名字>
```
