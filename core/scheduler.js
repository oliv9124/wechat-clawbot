import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sendWechatReply, loadConfig, loadRuntimeState, saveRuntimeState, describeText, writeJsonAtomic } from './wechat_reply.js';
import { loadTopicsConfig, textAfterLastReset, listMemoryFiles, capForLoading, charCount, MEMORY_MAX_CHARS, TOPIC_MAX_CHARS } from './memory_config.js';
import { memoryMode, useStandaloneHistory, snapshotAll, buildDigest, markDigestDelivered, syncBotDigests } from './memory_history.js';
import { raiseAlert } from './alert.js';
import { AGY_STREAM_ARGS, agyInputLine, agyOutcome, recordAgentResult } from './agent_health.js';

const botRoot = process.cwd();

// 记忆历史：默认每个实例自己管（standalone）；统一管理时主人的机器人管所有实例（owner），被代管的实例只附汇报（managed）
const MEMORY_MODE = memoryMode(botRoot);
if (MEMORY_MODE === 'standalone') useStandaloneHistory(botRoot);
// 这个进程自己存版本、附带编号能撤销的汇报
const MEMORY_REVIEW = MEMORY_MODE === 'owner' || MEMORY_MODE === 'standalone';
const SNAPSHOT_EVERY_MS = Number(process.env.CLAWBOT_MEMORY_SNAPSHOT_MS) || 60_000;

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

// 原子写：监控服务会同时读这个文件
function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

/**
 * 微信只允许机器人在对方最近一次发消息后的一段时间内（实测约 24 小时）主动发消息，超过就返回 prepare failed。
 *   - 对方超过 12 小时没发消息：下一条主动消息末尾请对方回一句（同一段只加一次，config.reply_nudge_hours 可调）
 *   - 发送被拒：记为"窗口已关"，不再生成文案、不再逐条报错，只告警一次；到点的提醒先留着
 *   - 对方发来新消息（forwarder 记下 last_user_message_at）：窗口重新打开，告警"已恢复"，留着的提醒补发
 * 状态在 data/state/reply_window.json：closed_at、closed_user_at、nudged_for
 */
const NUDGE_AFTER_MS = Number(process.env.SCHEDULER_NUDGE_AFTER_MS) || 12 * 3600_000;
const isWindowClosedError = (err) => /prepare failed/i.test(String(err?.message || ''));
const replyWindow = () => loadRuntimeState('reply_window');
const lastUserMessageAt = () => Number(loadRuntimeState('forwarder').last_user_message_at) || 0;

function shortTime(ms) {
  const i = getBeijingInfo(new Date(ms));
  return `${i.dateStr.slice(5)} ${i.timeStr.slice(0, 5)}`;
}

function safeConfig() {
  try { return loadConfig(); } catch { return {}; }
}

function checkReplyWindow() {
  try {
    const w = replyWindow();
    const last = lastUserMessageAt();
    if (!w.closed_at || !last || last <= (w.closed_user_at || 0)) return;
    saveRuntimeState('reply_window', { closed_at: null, closed_user_at: null });
    const nick = safeConfig().user_nickname || '用户';
    console.log(`[微信窗口恢复] ${shortTime(last)} 收到${nick}的新消息，恢复主动发送`);
    raiseAlert('user_window_ok', `${shortTime(last)} 收到了${nick}的新消息`);
  } catch (e) {
    console.error('[检查微信窗口失败]:', e.message);
  }
}

function markReplyWindowClosed() {
  if (replyWindow().closed_at) return;
  const last = lastUserMessageAt();
  saveRuntimeState('reply_window', { closed_at: Date.now(), closed_user_at: last || null });
  const nick = safeConfig().user_nickname || '用户';
  const since = last
    ? `最后一次收到${nick}的消息是 ${shortTime(last)}（${Math.round((Date.now() - last) / 3600_000)} 小时前）`
    : `没有记录到${nick}最近一次发消息的时间`;
  console.warn(`[微信窗口已关闭] ${since}；主动消息先暂停，等${nick}回消息`);
  raiseAlert('user_window_closed', `${since}；微信拒绝了主动发送（prepare failed）`);
}

// 先记下"已提醒"再发，避免同一轮两条消息都带上；发送失败就用 undo 撤回这条记录
function withReplyNudge(text, config) {
  const last = lastUserMessageAt();
  const afterMs = Number(config.reply_nudge_hours) * 3600_000 || NUDGE_AFTER_MS;
  const w = replyWindow();
  if (!last || Date.now() - last < afterMs || w.nudged_for === last) return { text, undo() {} };
  saveRuntimeState('reply_window', { nudged_for: last });
  const nick = config.user_nickname || '主人';
  const bot = config.bot_name || '小助理';
  return {
    text: `${text}\n\n（${nick}，回${bot}一句话吧，随便说什么都行。超过一天没收到你的消息，微信就不让${bot}给你发提醒了～）`,
    undo: () => saveRuntimeState('reply_window', { nudged_for: w.nudged_for ?? null }),
  };
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

// callAiCopy 已移到 ai_copy.js，这里继续转出，兼容仍从 scheduler.js 导入的旧 tasks.js
export { callAiCopy } from './ai_copy.js';

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
        const contextToken = loadRuntimeState('forwarder').last_context_token;

        if (!userId) {
          console.warn(`[跳过任务 ${task.id}]: 未找到 authorized_user_id，请先扫码绑定。`);
          raiseAlert('task_failed', `定时任务「${task.name}」没发出去：实例未绑定授权用户`);
          continue;
        }

        // 对方太久没发消息、微信已经拒绝过主动发送：不白白生成文案，等对方回消息后恢复
        if (replyWindow().closed_at) {
          console.warn(`[跳过定时任务 ${task.id}]: 微信窗口已关闭，等${config.user_nickname || '用户'}回消息后恢复`);
          appendLog(`[定时任务暂停] ${task.name}: 微信窗口已关闭`);
          continue;
        }

        const msgText = await task.generateCopy();
        // 标了 memoryDigest 的播报（早间天气）后面附上这个实例自己的"记忆变动"；没发出去就留到下一次一起列
        const digest = !task.memoryDigest ? null : MEMORY_REVIEW ? memoryDigest() : MEMORY_MODE === 'managed' ? pendingDigest() : null;
        const digestCount = digest ? digest.items?.length ?? digest.count : 0;
        const fullText = digest ? `${msgText}\n\n${digest.text}` : msgText;
        const nudge = withReplyNudge(fullText, config);
        console.log(`[生成文案]: ${describeText(nudge.text)}${digest ? `（附记忆变动 ${digestCount} 条）` : ''}${nudge.text !== fullText ? '（末尾请对方回一句）' : ''}`);

        try {
          await sendWechatReply(userId, contextToken, nudge.text, config);
        } catch (sendErr) {
          nudge.undo();
          throw sendErr;
        }
        if (digest) {
          try {
            // 自己管历史的记进度；被代管的实例写回执，主人的机器人看到后再记
            if (MEMORY_REVIEW) markDigestDelivered(digest);
            else saveRuntimeState('memory_digest_ack', { id: digest.id, delivered_at: Date.now() });
          } catch (e) {
            console.error('[记录记忆汇报进度失败]:', e.message);
          }
        }
        // 聊天日志里不写汇报的内容（免得被凌晨整理当成对话），只记条数
        appendLog(`[定时任务成功] ${task.name}: ${digest ? `${msgText}（附记忆变动 ${digestCount} 条）` : nudge.text}`);
        console.log(`✅ [定时任务下发完成]: ${task.name}\n`);
      } catch (err) {
        if (isWindowClosedError(err)) {
          console.warn(`[定时任务未送达]: ${task.name}（微信窗口已关闭）`);
          appendLog(`[定时任务未送达] ${task.name}: 微信窗口已关闭`);
          markReplyWindowClosed();
          continue;
        }
        console.error(`❌ [定时任务执行失败]: ${task.name}`, err.message);
        appendLog(`[定时任务失败] ${task.name}: ${err.message}`);
        raiseAlert('task_failed', `定时任务「${task.name}」没发出去：${err.message}`);
      }
    }
  }
}

// reminders.json：文件不存在算空；内容读不出来返回 null（智能体可能正写到一半）
function readReminders() {
  try {
    const raw = fs.readFileSync(REMINDERS_FILE, 'utf-8').trim();
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : null;
  } catch (err) {
    return err.code === 'ENOENT' ? [] : null;
  }
}

// 轮询并执行动态即时提醒 (reminders.json)。上一轮还在发（补发攒着的提醒可能要好几秒）就不再开一轮，避免重复发送
let remindersBusy = false;
async function checkDynamicReminders() {
  if (remindersBusy) return;
  remindersBusy = true;
  try {
    await deliverDueReminders();
  } finally {
    remindersBusy = false;
  }
}

async function deliverDueReminders() {
  const reminders = readReminders();
  if (!reminders || reminders.length === 0) return;

  const now = Date.now();
  const remaining = [];
  const config = loadConfig();
  let windowClosed = Boolean(replyWindow().closed_at);

  for (const item of reminders) {
    if (item.target_time_ms && now >= item.target_time_ms) {
      // 安全隔离防护：如果指定了 user_id 但不是当前实例绑定的微信用户，则跳过不处理，防止串号
      if (item.user_id && config.authorized_user_id && item.user_id !== config.authorized_user_id) {
        console.warn(`[动态提醒隔离拦截]: 任务用户 ${item.user_id} 非本实例绑定用户 ${config.authorized_user_id}，跳过处理`);
        remaining.push(item);
        continue;
      }
      // 微信窗口关着：先留着，等对方回消息后补发
      if (windowClosed) {
        remaining.push({ ...item, held_by_window: true });
        continue;
      }

      console.log(`\n⏰ [动态定时提醒到期触发]: ${describeText(item.content)}`);
      const toUser = config.authorized_user_id;
      // 优先用最新的 context_token：提醒创建时带的那个可能早就过期了
      const ctxToken = loadRuntimeState('forwarder').last_context_token || item.context_token;
      const userNickname = config.user_nickname || '主人';
      // 告警里只写提醒的时间，不写提醒内容
      const due = getBeijingInfo(new Date(item.target_time_ms));
      const dueLabel = `${due.dateStr} ${due.timeStr.slice(0, 5)}`;
      if (toUser && ctxToken) {
        const late = item.held_by_window
          ? `\n（这条提醒原本是 ${shortTime(item.target_time_ms)} 的，当时${userNickname}太久没发消息，微信不让${config.bot_name || '小助理'}主动发，现在补上。）`
          : '';
        const nudge = withReplyNudge(`🔔 ${userNickname}，提醒到啦：${item.content}${late}`, config);
        try {
          await sendWechatReply(toUser, ctxToken, nudge.text, config);
          appendLog(`[动态提醒下发成功]: ${item.content}`);
          console.log(`✅ [动态提醒已发送微信]: ${describeText(nudge.text)}${late ? '（补发）' : ''}`);
        } catch (e) {
          nudge.undo();
          if (isWindowClosedError(e)) {
            console.warn('[动态提醒未送达]: 微信窗口已关闭，先留着，对方回消息后补发');
            markReplyWindowClosed();
            windowClosed = true;
            remaining.push({ ...item, held_by_window: true });
            continue;
          }
          console.error(`❌ [动态提醒发送失败]:`, e.message);
          raiseAlert('reminder_failed', `一条 ${dueLabel} 的提醒没发出去：${e.message}`);
        }
      } else {
        console.warn(`[动态提醒跳过]: 缺少 authorized_user_id 或 context_token`);
        raiseAlert('reminder_failed', `一条 ${dueLabel} 的提醒没发出去：缺少授权用户或 context_token`);
      }
    } else {
      remaining.push(item);
    }
  }

  // 写回前重新读一遍：发送期间智能体可能又追加了新提醒，这些要保留下来
  const seen = new Set(reminders.map((r) => JSON.stringify(r)));
  const added = (readReminders() || []).filter((r) => !seen.has(JSON.stringify(r)));
  const next = [...remaining, ...added];
  if (JSON.stringify(next) !== JSON.stringify(reminders)) {
    try {
      writeJsonAtomic(REMINDERS_FILE, next);
    } catch (e) {
      console.error(`[更新 reminders.json 失败]:`, e.message);
    }
  }
}

// 凌晨整理几点开始（环境变量只给测试用），聊天记录每段多少字、最多整理几段、每段的超时
const NIGHTLY_AT_MINUTE = (() => {
  const m = String(process.env.CLAWBOT_NIGHTLY_TIME || '03:00').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 180;
})();
const CHUNK_CHARS = Number(process.env.CLAWBOT_CONSOLIDATION_CHUNK_CHARS) || 12000;
const MAX_CHUNKS = 8;
const CONSOLIDATION_TIMEOUT_MS = Number(process.env.CLAWBOT_CONSOLIDATION_TIMEOUT_MS) || 300000;
let consolidationRunning = false;

/**
 * 凌晨 03:00 自动执行【类人脑睡眠记忆固化与反思】(Nightly Memory Consolidation)
 * 分段整理可能要跑好几分钟，放在后台跑，不卡调度循环（心跳、定时任务、提醒照常）。
 */
async function checkNightlyMemoryConsolidation() {
  const info = getBeijingInfo();
  // 每天凌晨 03:00 ~ 03:05 触发
  const minuteOfDay = info.hour * 60 + info.minute;
  if (minuteOfDay < NIGHTLY_AT_MINUTE || minuteOfDay > NIGHTLY_AT_MINUTE + 5) return;

  const state = loadState();
  if (!state.last_fired) state.last_fired = {};
  const todayStr = info.dateStr;

  if (state.last_fired['nightly_memory_consolidation'] === todayStr || consolidationRunning) {
    return;
  }

  // 立即标记防重
  state.last_fired['nightly_memory_consolidation'] = todayStr;
  saveState(state);

  consolidationRunning = true;
  runNightlyConsolidation()
    .catch((err) => {
      console.error('[睡眠记忆反思主流程异常]:', err.message);
      appendLog(`[睡眠记忆反思主流程异常]: ${err.message}`);
      raiseAlert('memory_consolidation_failed', `凌晨记忆整理失败：${err.message}`);
    })
    .finally(() => {
      consolidationRunning = false;
    });
}

const LOG_ENTRY_SPLIT = /\n(?=\[\d{4}-\d{2}-\d{2}T)/;

// 按天日志 → 整理用的对话记录：只留用户和助手说的话，不带微信用户 ID，时间只留到分钟（北京时间）
function transcriptEntries(raw, userNickname, botName) {
  const entries = [];
  for (const block of textAfterLastReset(raw).split(LOG_ENTRY_SPLIT)) {
    const m = block.trim().match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*([\s\S]*)$/);
    if (!m) continue;
    const time = getBeijingInfo(new Date(m[1])).timeStr.slice(0, 5);
    const user = m[2].match(/^微信接收\s*\([^)]*\):\s*([\s\S]*)$/);
    const ai = m[2].match(/^AI回复(?:\([^)]*\))?:\s*([\s\S]*)$/);
    if (user) {
      const text = user[1].trim();
      if (text) entries.push({ role: 'user', text: `${time} ${userNickname}：${text}` });
    } else if (ai) {
      const text = ai[1]
        .replace(/^🔔\s*【后台任务完成通知】\s*[\r\n]*/, '')
        .replace(/^[^\n]*您交办的长任务已全部处理完成[^\n]*[\r\n]*/, '')
        .trim();
      if (text) entries.push({ role: 'bot', text: `${time} ${botName}：${text}` });
    }
  }
  return entries;
}

// 按消息边界分段，每段不超过 maxChars 字；单条就超长的截掉后半
function splitIntoChunks(entries, maxChars) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const e of entries) {
    let chars = [...e.text];
    if (chars.length > maxChars - 20) chars = [...chars.slice(0, maxChars - 40), ...'…（这条太长，后面省略）'];
    if (size + chars.length + 1 > maxChars && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      size = 0;
    }
    cur.push(chars.join(''));
    size += chars.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

function consolidationPrompt({ day, part, parts, chunk, userNickname, botName }) {
  const sizes = new Map(listMemoryFiles(botRoot).map((f) => {
    try { return [f.rel, charCount(fs.readFileSync(f.abs, 'utf-8'))]; } catch { return [f.rel, 0]; }
  }));
  const memoryPath = path.join(botRoot, 'MEMORY.md');
  const currentMemory = fs.existsSync(memoryPath) ? capForLoading(fs.readFileSync(memoryPath, 'utf-8'), MEMORY_MAX_CHARS).text : '';
  // 专题分卷的归档目标来自本实例的 topics.json，核心代码不写死任何专题
  const topics = loadTopicsConfig(botRoot);
  const topicLines = topics.length
    ? topics.map((t) => `   - ${t.name}：更新至 data/memory/topics/${t.file}（现在 ${sizes.get(`data/memory/topics/${t.file}`) || 0} 字）；`).join('\n')
    : '   - （本实例没有配置专题分卷，全部归入 MEMORY.md）';
  const partNote = parts > 1
    ? `昨天聊得比较多，分成 ${parts} 段整理，这是第 ${part} 段；前面的段已经整理过，下面的 MEMORY.md 是整理后的最新内容。\n`
    : '';

  return `你是一个顶级的 AI 知识管理与记忆沉淀分析师。
你的唯一任务是：审阅用户【${userNickname}】昨日（${day}）与助手【${botName}】的微信聊天记录，结合当前 MEMORY.md 现状，去粗取精，提取出高价值的长期记忆，增量更新或沉淀到当前目录的 MEMORY.md 或 data/memory/topics/ 对应专题分卷中。
${partNote}
【核心萃取原则】：
1. 坚决过滤口水废话：忽略打招呼（“你好/在吗”）、客套答谢、一次性天气询问、普通的短视频下载解析等临时性指令。
2. 重点萃取核心认知：
   - 用户明确表达的新偏好、新习惯、新禁忌、作息时间变化；
   - 重要的专项心得与经验（归入下面对应的专题分卷）；
   - 跨多天的连续事件或长期待办约定。
3. 知识归档原则：
   - 核心全局偏好：合并到当前目录下的 MEMORY.md（现在 ${sizes.get('MEMORY.md') || 0} 字）；
${topicLines}
4. 长度上限：MEMORY.md 不超过 ${MEMORY_MAX_CHARS} 字，每个专题分卷不超过 ${TOPIC_MAX_CHARS} 字。接近或超过上限时，先合并重复的条目、精简过时的内容，再写新内容。
5. 修改原则：重复、过时的条目可以合并精简，但仍然有效的信息不能删除。如果昨日没有值得长期记住的新内容，就保持原样，不要为了修改而修改。

【当前 MEMORY.md 全文】：
${currentMemory}

【昨日真实对话记录${parts > 1 ? `（第 ${part}/${parts} 段）` : ''}】：
${chunk}`;
}

function runConsolidationAgent(promptText) {
  return new Promise((resolve) => {
    const args = ['--dangerously-skip-permissions', ...AGY_STREAM_ARGS];
    const child = execFile(
      'agy',
      args,
      { cwd: botRoot, timeout: CONSOLIDATION_TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ outcome: agyOutcome(err, stdout, stderr), err, stderr })
    );
    // 提示词（含昨天的聊天记录）从标准输入交过去，不放在命令行参数里
    child.stdin.on('error', () => {});
    child.stdin.end(agyInputLine(promptText));
  });
}

// 自动维护清理 30 天前的旧日志切片
function cleanOldDailyLogs() {
  const historyDir = path.join(dataDir, 'history');
  try {
    if (fs.existsSync(historyDir)) {
      const thirtyDaysAgoMs = Date.now() - 30 * 86400000;
      for (const file of fs.readdirSync(historyDir)) {
        if (file.startsWith('chat_') && file.endsWith('.log')) {
          const fullP = path.join(historyDir, file);
          if (fs.statSync(fullP).mtimeMs < thirtyDaysAgoMs) {
            fs.unlinkSync(fullP);
            console.log(`[自动归档清理过时日志]: ${file}`);
          }
        }
      }
    }
  } catch (cleanErr) {
    console.warn('[清理过时日志异常]:', cleanErr.message);
  }
}

/**
 * 整理昨天（北京时间）的全部聊天：没有昨天的按天日志就跳过（不再退回去读总日志，免得旧对话被一遍遍重新整理）；
 * 聊得多就按消息边界分段，一段一段整理，每段都重新读一遍当前记忆。进度写在 data/state/memory_consolidation.json，
 * 主人的机器人存记忆版本时据此标明"凌晨整理"。
 */
export async function runNightlyConsolidation({ day } = {}) {
  saveRuntimeState('memory_consolidation', { running: true, started_at: Date.now(), finished_at: null, result: null, parts: 0 });
  let result = 'skipped';
  let parts = 0;
  console.log(`\n🌙 [03:00 睡眠记忆固化反思启动]: 正在复盘昨日知识与习惯并沉淀至 MEMORY.md...`);
  appendLog(`[03:00 睡眠记忆固化启动] 开始复盘沉淀昨日记忆`);

  try {
    const yesterdayStr = day || getBeijingInfo(new Date(Date.now() - 86400000)).dateStr;
    const logPath = path.join(dataDir, 'history', `chat_${yesterdayStr}.log`);
    if (!fs.existsSync(logPath)) {
      console.log(`[睡眠记忆固化跳过]: 昨天（${yesterdayStr}）没有聊天记录。`);
      appendLog(`[睡眠记忆固化跳过] 昨日没有聊天记录`);
      return;
    }

    const config = loadConfig();
    const userNickname = config.user_nickname || '主人';
    const botName = config.bot_name || '小助理';
    // 用户清除过记忆：重置之前的对话不再拿来沉淀长期记忆
    const entries = transcriptEntries(fs.readFileSync(logPath, 'utf-8'), userNickname, botName);
    const total = entries.reduce((n, e) => n + charCount(e.text), 0);
    // 用户昨天没说过话，或者内容过短（小于 150 字），无需消耗 AI 额度
    if (!entries.some((e) => e.role === 'user') || total < 150) {
      console.log(`[睡眠记忆固化跳过]: 昨日无足够对话记录 (${total} 字)。`);
      appendLog(`[睡眠记忆固化跳过] 昨日无足够对话记录`);
      return;
    }

    let chunks = splitIntoChunks(entries, CHUNK_CHARS);
    if (chunks.length > MAX_CHUNKS) {
      console.warn(`[睡眠记忆固化]: 昨天的聊天有 ${chunks.length} 段，只整理最后 ${MAX_CHUNKS} 段。`);
      appendLog(`[睡眠记忆固化] 昨日聊天有 ${chunks.length} 段，只整理了最后 ${MAX_CHUNKS} 段`);
      chunks = chunks.slice(-MAX_CHUNKS);
    }

    for (let i = 0; i < chunks.length; i++) {
      parts = i + 1;
      const where = chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : '';
      const promptText = consolidationPrompt({ day: yesterdayStr, part: i + 1, parts: chunks.length, chunk: chunks[i], userNickname, botName });
      const { outcome, err, stderr } = await runConsolidationAgent(promptText);
      recordAgentResult('scheduler', outcome);
      if (!outcome.ok) {
        result = 'failed';
        // 只记退出码和错误输出的末尾，不用 err.message（里面是完整命令行）
        const detail = outcome.kind === 'auth'
          ? outcome.reason
          : String(stderr || '').trim().slice(-300) || `exit ${err?.code ?? err?.signal ?? 'status ERROR'}`;
        console.error(`[睡眠记忆固化执行异常]${where}: ${detail}`);
        appendLog(`[睡眠记忆固化失败]${where}: ${detail}`);
        // 登录失效由"智能体登录失效"告警统一报，这里不再重复报一条
        if (outcome.kind !== 'auth') raiseAlert('memory_consolidation_failed', `凌晨记忆整理失败${where}：${detail}`);
        return;
      }
      if (where) console.log(`[睡眠记忆固化]: ${where.slice(1, -1)}整理完成`);
    }
    result = 'ok';
    console.log(`🎉 [03:00 睡眠记忆固化完成]: 昨日智慧已成功沉淀入知识库！${chunks.length > 1 ? `（分 ${chunks.length} 段）` : ''}`);
    appendLog(`[睡眠记忆固化完成] 昨日智慧已成功沉淀入知识库`);
  } finally {
    saveRuntimeState('memory_consolidation', { running: false, finished_at: Date.now(), result, parts });
    cleanOldDailyLogs();
  }
}

// 主人的机器人：每分钟检查一次各实例的记忆文件，有改动、并且停了一会儿，就存一版；
// 再替沙箱里的实例更新它们各自待发的"记忆变动"（它们读不到记忆历史）
let lastSnapshotAlertAt = 0;
function checkMemorySnapshots() {
  try {
    for (const s of snapshotAll({ botsDir: path.dirname(botRoot) })) {
      console.log(`[记忆历史] ${s.bot} 的记忆有改动，存了一版 ${s.commit.slice(0, 7)}`);
    }
    if (MEMORY_MODE === 'owner') syncBotDigests({ botsDir: path.dirname(botRoot) });
  } catch (e) {
    console.error('[记忆快照失败]:', e.message);
    if (Date.now() - lastSnapshotAlertAt > 3600_000) {
      lastSnapshotAlertAt = Date.now();
      raiseAlert('memory_snapshot_failed', `记忆快照失败：${e.message}`);
    }
  }
}

function memoryDigest() {
  try {
    return buildDigest({ botsDir: path.dirname(botRoot), bot: path.basename(botRoot) });
  } catch (e) {
    console.error('[记忆变动汇报生成失败，这次不附]:', e.message);
    return null;
  }
}

// 沙箱实例：主人的机器人放在 data/state/memory_digest.json 的待发汇报；这一份已经发过（有回执）就不再附
function pendingDigest() {
  try {
    const pending = loadRuntimeState('memory_digest');
    if (!pending.id || !pending.text) return null;
    if (loadRuntimeState('memory_digest_ack').id === pending.id) return null;
    return pending;
  } catch (e) {
    console.error('[读取待发的记忆变动失败，这次不附]:', e.message);
    return null;
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
  const memoryNote = {
    owner: '记忆历史：定时检查所有实例的记忆改动并存版本，早间播报附上"记忆变动"',
    standalone: '记忆历史：定时检查本实例的记忆改动并存版本（data/memory-history/），早间播报附上"记忆变动"',
    managed: '记忆变动：早间播报附上主人的机器人准备好的汇报',
    off: '记忆历史：没有开启（没装 git，或者设了 CLAWBOT_MEMORY_MODE=off）',
  }[MEMORY_MODE];
  console.log(` • ${memoryNote}`);
  console.log(`====================================================\n`);

  // 心跳 + 任务表：监控服务据此发现"调度器停了"和"定时任务到点没发"
  const manifest = tasks.map((t) => ({ id: t.id, name: t.name, hour: t.hour, minute: t.minute, workdaysOnly: Boolean(t.workdaysOnly) }));
  const heartbeat = () => {
    try {
      saveRuntimeState('scheduler', { heartbeat_at: Date.now(), tasks: manifest });
    } catch (e) {
      console.error('[调度心跳写入失败]:', e.message);
    }
  };
  heartbeat();
  checkReplyWindow();

  setInterval(() => {
    heartbeat();
    checkReplyWindow();
    checkAndTrigger().catch((e) => console.error('[调度循环异常]:', e.message));
    checkDynamicReminders().catch((e) => console.error('[动态提醒循环异常]:', e.message));
    checkNightlyMemoryConsolidation().catch((e) => console.error('[记忆固化循环异常]:', e.message));
  }, 10000);

  if (MEMORY_REVIEW) {
    // 存版本要调几次 git（同步执行，会占住进程几十毫秒）：和 10 秒一轮的主循环错开 5 秒，不跟发提醒、发定时消息挤在同一刻
    setTimeout(() => {
      checkMemorySnapshots();
      setInterval(checkMemorySnapshots, SNAPSHOT_EVERY_MS);
    }, Math.min(5000, SNAPSHOT_EVERY_MS / 2));
  }

  checkAndTrigger().catch((e) => console.error('[首次检查异常]:', e.message));
  checkDynamicReminders().catch((e) => console.error('[首次动态检查异常]:', e.message));
  checkNightlyMemoryConsolidation().catch((e) => console.error('[首次记忆固化检查异常]:', e.message));
}

export { startScheduler };

// 只在作为入口运行时启动：直接 `node scheduler.js`，或由 PM2 托管。
// PM2 是用自己的 ProcessContainerFork.js 去 import() 本文件的，此时 argv[1] 是 PM2 的容器脚本，
// 真正的入口在 pm_exec_path 里；只认 argv[1] 会导致 PM2 下调度器永远不启动。
const selfPath = fileURLToPath(import.meta.url);
const argvEntry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const launchedByPm2 =
  /[\\/]pm2[\\/]lib[\\/]ProcessContainer/.test(argvEntry) &&
  Boolean(process.env.pm_exec_path) &&
  path.resolve(process.env.pm_exec_path) === selfPath;

if (argvEntry === selfPath || launchedByPm2) {
  startScheduler();
}
