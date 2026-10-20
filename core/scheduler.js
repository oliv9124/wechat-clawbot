import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sendWechatReply, loadConfig, stripMarkdown } from './wechat_reply.js';
import { loadTopicsConfig } from './memory_config.js';

const botRoot = process.cwd();

// 数据目录支持
const dataDir = path.join(botRoot, 'data');
if (!fs.existsSync(dataDir)) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
}

const STATE_FILE = fs.existsSync(dataDir)
  ? path.join(dataDir, 'scheduler_state.json')
  : path.join(botRoot, 'scheduler_state.json');

const REMINDERS_FILE = fs.existsSync(dataDir)
  ? path.join(dataDir, 'reminders.json')
  : path.join(botRoot, 'reminders.json');

const LOG_FILE = fs.existsSync(dataDir)
  ? path.join(dataDir, 'chat_history.log')
  : path.join(botRoot, 'chat_history.log');

function appendLog(line) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${line}\n`, 'utf-8');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return { last_fired: {} };
    }
  }
  return { last_fired: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

export function getBeijingInfo(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dateStr: `${obj.year}-${obj.month}-${obj.day}`,
    hour: parseInt(obj.hour, 10),
    minute: parseInt(obj.minute, 10),
    second: parseInt(obj.second, 10),
    dayOfWeek: weekdayMap[obj.weekday] ?? 0,
    weekday: obj.weekday,
    timeStr: `${obj.hour}:${obj.minute}:${obj.second}`,
  };
}

export function callAiCopy(promptText) {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const userNickname = config.user_nickname || '主人';
    const botName = config.bot_name || '小助理';
    const forbiddenPrompt = config.forbidden_persona ? `严禁称呼用户为“${config.forbidden_persona}”。` : '';
    const personaPrefix = `【系统指令】：当前推送对象为【${userNickname}】，你的身份是专属助理【${botName}】。在文案中必须称呼用户为“${userNickname}”，语气自然亲切幽默，${forbiddenPrompt}严禁使用任何其他非指定称呼！\n\n`;
    const fullPrompt = personaPrefix + promptText;
    const args = ['--dangerously-skip-permissions', '-p', fullPrompt, '--output-format', 'json'];
    execFile(
      'agy',
      args,
      {
        cwd: botRoot,
        timeout: 18000,
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const res = JSON.parse(stdout.trim());
          if (res.response) return resolve(res.response.trim());
        } catch {
          if (stdout.trim()) return resolve(stdout.trim());
        }
        reject(new Error('Empty AI response'));
      }
    );
  });
}

// 动态载入当前 Bot 的专属任务配置 (优先 tasks.js，向下兼容 schedules.js)
let cachedTasks = null;
async function loadBotTasks() {
  if (cachedTasks) return cachedTasks;
  const schedulePath = fs.existsSync(path.join(botRoot, 'tasks.js'))
    ? path.join(botRoot, 'tasks.js')
    : path.join(botRoot, 'schedules.js');
  if (fs.existsSync(schedulePath)) {
    try {
      const mod = await import(pathToFileURL(schedulePath).href + `?t=${Date.now()}`);
      cachedTasks = mod.TASKS || mod.default || [];
      return cachedTasks;
    } catch (e) {
      console.error(`[载入任务配置失败 (${path.basename(schedulePath)})]:`, e.message);
    }
  }
  cachedTasks = [];
  return cachedTasks;
}

async function checkAndTrigger() {
  const info = getBeijingInfo();
  const state = loadState();
  if (!state.last_fired) state.last_fired = {};
  const todayStr = info.dateStr;
  const isWorkday = info.dayOfWeek >= 1 && info.dayOfWeek <= 5;

  const tasks = await loadBotTasks();

  for (const task of tasks) {
    if (task.workdaysOnly && !isWorkday) continue;

    if (info.hour === task.hour && info.minute === task.minute) {
      const lastFired = state.last_fired[task.id];
      if (lastFired === todayStr) {
        continue;
      }

      console.log(`\n⏰ [定时任务触发]: ${task.name} (${info.timeStr} 北京时间)`);
      state.last_fired[task.id] = todayStr;
      saveState(state);

      try {
        const config = loadConfig();
        const userId = config.authorized_user_id;
        const contextToken = config.last_context_token;

        if (!userId) {
          console.warn(`[跳过任务 ${task.id}]: 未找到 authorized_user_id，请先在微信发送任意消息绑定。`);
          continue;
        }

        const msgText = await task.generateCopy();
        console.log(`[生成文案]: ${msgText}`);

        await sendWechatReply(userId, contextToken, msgText, config);
        appendLog(`[定时任务成功] ${task.name}: ${msgText}`);
        console.log(`✅ [定时任务下发完成]: ${task.name}\n`);
      } catch (err) {
        console.error(`❌ [定时任务执行失败]: ${task.name}`, err.message);
        appendLog(`[定时任务失败] ${task.name}: ${err.message}`);
      }
    }
  }
}

// 轮询并执行动态即时提醒 (reminders.json)
async function checkDynamicReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return;

  let reminders = [];
  try {
    const raw = fs.readFileSync(REMINDERS_FILE, 'utf-8').trim();
    if (raw) {
      reminders = JSON.parse(raw);
    }
  } catch (err) {
    return;
  }

  if (!Array.isArray(reminders) || reminders.length === 0) return;

  const now = Date.now();
  const remaining = [];
  const config = loadConfig();

  for (const item of reminders) {
    if (item.target_time_ms && now >= item.target_time_ms) {
      // 安全隔离防护：如果指定了 user_id 但不是当前实例绑定的微信用户，则跳过不处理，防止串号
      if (item.user_id && config.authorized_user_id && item.user_id !== config.authorized_user_id) {
        console.warn(`[动态提醒隔离拦截]: 任务用户 ${item.user_id} 非本实例绑定用户 ${config.authorized_user_id}，跳过处理`);
        remaining.push(item);
        continue;
      }

      console.log(`\n⏰ [动态定时提醒到期触发]: ${item.content}`);
      const toUser = config.authorized_user_id;
      const ctxToken = item.context_token || config.last_context_token;
      const userNickname = config.user_nickname || '主人';
      if (toUser && ctxToken) {
        const text = `🔔 ${userNickname}，提醒到啦：${item.content}`;
        try {
          await sendWechatReply(toUser, ctxToken, text, config);
          appendLog(`[动态提醒下发成功]: ${item.content}`);
          console.log(`✅ [动态提醒已发送微信]: ${text}`);
        } catch (e) {
          console.error(`❌ [动态提醒发送失败]:`, e.message);
        }
      } else {
        console.warn(`[动态提醒跳过]: 缺少 authorized_user_id 或 context_token`);
      }
    } else {
      remaining.push(item);
    }
  }

  if (remaining.length !== reminders.length) {
    try {
      fs.writeFileSync(REMINDERS_FILE, JSON.stringify(remaining, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[更新 reminders.json 失败]:`, e.message);
    }
  }
}

/**
 * 凌晨 03:00 自动执行【类人脑睡眠记忆固化与反思】(Nightly Memory Consolidation)
 */
async function checkNightlyMemoryConsolidation() {
  const info = getBeijingInfo();
  // 每天凌晨 03:00 ~ 03:05 触发
  if (info.hour !== 3 || info.minute > 5) return;

  const state = loadState();
  if (!state.last_fired) state.last_fired = {};
  const todayStr = info.dateStr;

  if (state.last_fired['nightly_memory_consolidation'] === todayStr) {
    return;
  }

  // 立即标记防重
  state.last_fired['nightly_memory_consolidation'] = todayStr;
  saveState(state);

  console.log(`\n🌙 [03:00 睡眠记忆固化反思启动]: 正在复盘昨日知识与习惯并沉淀至 MEMORY.md...`);
  appendLog(`[03:00 睡眠记忆固化启动] 开始复盘沉淀昨日记忆`);

  try {
    // 1. 获取昨日日期与昨日日志
    const yesterdayDate = new Date(Date.now() - 86400000);
    const yInfo = getBeijingInfo(yesterdayDate);
    const yesterdayStr = yInfo.dateStr;
    const historyDir = path.join(dataDir, 'history');
    const yesterdayLogPath = path.join(historyDir, `chat_${yesterdayStr}.log`);

    let logContent = '';
    if (fs.existsSync(yesterdayLogPath)) {
      logContent = fs.readFileSync(yesterdayLogPath, 'utf-8').trim();
    } else if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf-8');
      logContent = raw.slice(-10000);
    }

    // 如果昨日没有聊天或内容过短（小于 150 字符），无需消耗 AI 额度
    if (!logContent || logContent.length < 150) {
      console.log(`[睡眠记忆固化跳过]: 昨日无足够对话记录 (${logContent.length} 字符)。`);
      appendLog(`[睡眠记忆固化跳过] 昨日无足够对话记录`);
      return;
    }

    const safeLogSnippet = logContent.length > 8000 ? logContent.slice(-8000) : logContent;
    const memoryPath = path.join(botRoot, 'MEMORY.md');
    const currentMemory = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, 'utf-8') : '';

    const config = loadConfig();
    const userNickname = config.user_nickname || '主人';
    const botName = config.bot_name || '小助理';

    // 专题分卷的归档目标来自本实例的 topics.json
    const topics = loadTopicsConfig(botRoot);
    const topicLines = topics.length
      ? topics.map((t) => `   - ${t.name}：更新至 data/memory/topics/${t.file}；`).join('\n')
      : '   - （本实例没有配置专题分卷，全部归入 MEMORY.md）';

    const promptText = `你是一个顶级的 AI 知识管理与记忆沉淀分析师。
你的唯一任务是：审阅用户【${userNickname}】昨日与助手【${botName}】的微信聊天记录，结合当前 MEMORY.md 现状，去粗取精，提取出高价值的长期记忆，增量更新或沉淀到当前目录的 MEMORY.md 或 data/memory/topics/ 对应专题分卷中。

【核心萃取原则】：
1. 坚决过滤口水废话：忽略打招呼（“你好/在吗”）、客套答谢、一次性天气询问、普通的短视频下载解析等临时性指令。
2. 重点萃取核心认知：
   - 用户明确表达的新偏好、新习惯、新禁忌、作息时间变化；
   - 重要的专项心得与经验（归入下面对应的专题分卷）；
   - 跨多天的连续事件或长期待办约定。
3. 知识归档原则：
   - 核心全局偏好：增量合并到当前目录下的 MEMORY.md（保持结构整洁，控制在 3KB 内）；
${topicLines}
4. 绝对原则：严禁覆盖或删除原有的宝贵历史条目！仅做“增量合并与修订”。如果昨日内容无重大新偏好，则保持原样无需强行修改。

【当前 MEMORY.md 核心现状】：
${currentMemory.slice(0, 3000)}

【昨日真实对话记录】：
${safeLogSnippet}`;

    const args = ['--dangerously-skip-permissions', '-p', promptText, '--output-format', 'json'];
    execFile(
      'agy',
      args,
      {
        cwd: botRoot,
        timeout: 300000,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err) => {
        if (err) {
          console.error('[睡眠记忆固化执行异常]:', err.message);
          appendLog(`[睡眠记忆固化失败]: ${err.message}`);
          return;
        }
        console.log(`🎉 [03:00 睡眠记忆固化完成]: 昨日智慧已成功沉淀入知识库！`);
        appendLog(`[睡眠记忆固化完成] 昨日智慧已成功沉淀入知识库`);
      }
    );

    // 2. 自动维护清理 30 天前的旧日志切片
    try {
      if (fs.existsSync(historyDir)) {
        const files = fs.readdirSync(historyDir);
        const thirtyDaysAgoMs = Date.now() - 30 * 86400000;
        for (const file of files) {
          if (file.startsWith('chat_') && file.endsWith('.log')) {
            const fullP = path.join(historyDir, file);
            const st = fs.statSync(fullP);
            if (st.mtimeMs < thirtyDaysAgoMs) {
              fs.unlinkSync(fullP);
              console.log(`[自动归档清理过时日志]: ${file}`);
            }
          }
        }
      }
    } catch (cleanErr) {
      console.warn('[清理过时日志异常]:', cleanErr.message);
    }

  } catch (err) {
    console.error('[睡眠记忆反思主流程异常]:', err.message);
    appendLog(`[睡眠记忆反思主流程异常]: ${err.message}`);
  }
}

async function startScheduler() {
  const info = getBeijingInfo();
  const tasks = await loadBotTasks();
  console.log(`====================================================`);
  console.log(`🤖 [微信助理定时任务调度服务已启动] (工作目录: ${botRoot})`);
  console.log(`当前北京时间: ${info.dateStr} ${info.timeStr} (${info.weekday})`);
  console.log('已配置的定时任务列表：');
  for (const t of tasks) {
    const time = `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    const scope = t.workdaysOnly ? '周一至周五(工作日)' : '每天';
    console.log(` • [${time}] ${scope} - ${t.name}`);
  }
  console.log(` • [03:00] 每天 - 类人脑睡眠记忆固化与反思 (自动沉淀至 MEMORY.md)`);
  console.log(`====================================================\n`);

  setInterval(() => {
    checkAndTrigger().catch((e) => console.error('[调度循环异常]:', e.message));
    checkDynamicReminders().catch((e) => console.error('[动态提醒循环异常]:', e.message));
    checkNightlyMemoryConsolidation().catch((e) => console.error('[记忆固化循环异常]:', e.message));
  }, 10000);

  checkAndTrigger().catch((e) => console.error('[首次检查异常]:', e.message));
  checkDynamicReminders().catch((e) => console.error('[首次动态检查异常]:', e.message));
  checkNightlyMemoryConsolidation().catch((e) => console.error('[首次记忆固化检查异常]:', e.message));
}

export { startScheduler };

if (process.argv[1] && process.argv[1].endsWith('scheduler.js')) {
  startScheduler();
}
