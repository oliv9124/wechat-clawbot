import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sendWechatReply, loadConfig, loadRuntimeState, saveRuntimeState, describeText, writeJsonAtomic } from './wechat_reply.js';
import { loadTopicsConfig, textAfterLastReset, listMemoryFiles, capForLoading, charCount, MEMORY_MAX_CHARS, TOPIC_MAX_CHARS } from './memory_config.js';
import { prepareWorkCopy, discardWorkCopy, collectChanges, checkChanges, applyChanges, slimFile, overLimitFiles, agyPlanAgent } from './memory_slim.js';
import { memoryMode, useStandaloneHistory, snapshotAll, buildDigest, markDigestDelivered, syncBotDigests } from './memory_history.js';
import { raiseAlert } from './alert.js';
import { AGY_STREAM_ARGS, agyInputLine, agyOutcome, recordAgentResult } from './agent_health.js';
import { callAiCopy } from './ai_copy.js';

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
export { callAiCopy };

// 动态载入当前 Bot 的专属任务配置 tasks.js。每轮都看一眼文件，改了就重新载入，
// 智能体加的任务不用重启就生效。新内容载入失败（写坏了、写到一半）就继续用上一份能用的，同一版只报一次错、告警一次
let cachedTasks = null;
let loadedVersion = null;
let brokenVersion = null;
// 运行中新加、改了时间的任务从什么时候起算数：监控据此不把"加上时已经过了点"的任务当成漏发
const taskSince = new Map();
const hhmm = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
const taskManifest = (tasks) => tasks.map((t) => ({
  id: t.id, name: t.name, hour: t.hour, minute: t.minute, workdaysOnly: Boolean(t.workdaysOnly),
  ...(taskSince.has(t.id) ? { since: taskSince.get(t.id) } : {}),
}));

// 任务表的基本检查：last_fired 按 id 记，id 重复会让其中一个永远不发
function taskProblem(tasks) {
  if (!Array.isArray(tasks)) return 'TASKS 不是数组';
  const ids = new Set();
  for (const [i, t] of tasks.entries()) {
    const label = `第 ${i + 1} 个任务${typeof t?.id === 'string' && t.id ? `（${t.id}）` : ''}`;
    if (typeof t?.id !== 'string' || !t.id) return `${label}缺少 id`;
    if (ids.has(t.id)) return `${label}的 id 和前面的重复了`;
    ids.add(t.id);
    if (!Number.isInteger(t.hour) || t.hour < 0 || t.hour > 23 || !Number.isInteger(t.minute) || t.minute < 0 || t.minute > 59) {
      return `${label}的时间不对（hour 要 0~23，minute 要 0~59）`;
    }
    if (typeof t.generateCopy !== 'function') return `${label}缺少 generateCopy`;
  }
  return '';
}

// 和上一份比，列出新增、去掉、改了时间的任务（写进日志）
function noteTaskChanges(before, after) {
  const was = new Map(before.map((t) => [t.id, t]));
  const ids = new Set(after.map((t) => t.id));
  const parts = [];
  for (const t of after) {
    const o = was.get(t.id);
    if (o && hhmm(o) === hhmm(t) && Boolean(o.workdaysOnly) === Boolean(t.workdaysOnly)) continue;
    taskSince.set(t.id, Date.now());
    parts.push(o ? `「${t.name}」改到 ${hhmm(t)}${t.workdaysOnly ? '（工作日）' : ''}` : `新增 ${hhmm(t)}「${t.name}」`);
  }
  for (const t of before) {
    if (ids.has(t.id)) continue;
    taskSince.delete(t.id);
    parts.push(`去掉「${t.name}」`);
  }
  return parts.join('，');
}

async function loadBotTasks() {
  const schedulePath = path.join(botRoot, 'tasks.js');
  let stat = null;
  try { stat = fs.statSync(schedulePath); } catch {}
  // 启动时没有任务文件：没有定时任务；运行中文件不见了：先按原来的跑
  if (!stat) return (cachedTasks ||= []);
  const version = `${stat.mtimeMs}:${stat.size}`;
  if (cachedTasks && (version === loadedVersion || version === brokenVersion)) return cachedTasks;
  const name = path.basename(schedulePath);
  try {
    const mod = await import(`${pathToFileURL(schedulePath).href}?t=${Date.now()}`);
    const tasks = mod.TASKS || mod.default || [];
    const problem = taskProblem(tasks);
    if (problem) throw new Error(problem);
    if (cachedTasks) {
      const changes = noteTaskChanges(cachedTasks, tasks);
      console.log(`[任务配置已重新载入]: ${name} 共 ${tasks.length} 个任务${changes ? `（${changes}）` : ''}`);
    }
    if (brokenVersion) {
      console.log(`[任务配置已恢复]: ${name} 改好了`);
      raiseAlert('tasks_config_ok', `${name} 改好了，按新的 ${tasks.length} 个任务执行`);
    }
    cachedTasks = tasks;
    loadedVersion = version;
    brokenVersion = null;
  } catch (e) {
    brokenVersion = version;
    const reason = String(e.message).split('\n')[0].slice(0, 150);
    const fallback = cachedTasks ? `先按上一份能用的 ${cachedTasks.length} 个任务执行` : '现在没有定时任务';
    cachedTasks ||= [];
    console.error(`[载入任务配置失败 (${name})]: ${reason}；${fallback}`);
    raiseAlert('tasks_config_broken', `${name} 载入失败，${fallback}：${reason}`);
  }
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

// 到点现写的提醒（ai: true）：content 写的是"要写什么"，到点让智能体现查现写；联网查资料常要一两分钟（环境变量仅供测试）
const AI_REMINDER_TIMEOUT_MS = Number(process.env.AI_REMINDER_TIMEOUT_MS) || 180_000;
async function aiReminderText(item, dueLabel, nick) {
  const prompt = `现在是北京时间 ${dueLabel}。${nick}约好这个时间收到一条消息，要求是：${item.content}
需要最新信息（比赛结果、新闻、行情、天气等）就先联网搜索核实，只写查到的事实；查不到的直接说没查到，绝不编造。
直接输出要发给${nick}的内容，不要额外的客套话。`;
  try {
    return { text: await callAiCopy(prompt, { timeoutMs: AI_REMINDER_TIMEOUT_MS }), note: '（现写）' };
  } catch {
    // 具体原因 callAiCopy 已经记在日志里；写不出来就如实说，不把"要写什么"当成内容发出去
    return {
      text: `🔔 ${nick}，到点了：${item.content}\n（这条本来要到点现查现写，这次没写出来。回我一句，我马上现查。）`,
      note: '（现写没成功，发了说明）',
    };
  }
}

async function deliverDueReminders() {
  const reminders = readReminders();
  if (!reminders || reminders.length === 0) return;

  const now = Date.now();
  const remaining = []; // [原来的位置, 留下的条目]：写回时保持原来的顺序
  const config = loadConfig();
  let windowClosed = Boolean(replyWindow().closed_at);

  // 现写的提醒可能要等智能体一两分钟：同一轮到点的普通提醒先发
  const order = reminders.map((item, i) => [i, item]).sort(([, a], [, b]) => Boolean(a.ai) - Boolean(b.ai));
  for (const [i, item] of order) {
    // 上次没发出去、在等重试的，没到重试时间先留着
    if (item.target_time_ms && now >= item.target_time_ms && !(item.retry_at && now < item.retry_at)) {
      // 安全隔离防护：如果指定了 user_id 但不是当前实例绑定的微信用户，则跳过不处理，防止串号
      if (item.user_id && config.authorized_user_id && item.user_id !== config.authorized_user_id) {
        console.warn(`[动态提醒隔离拦截]: 任务用户 ${item.user_id} 非本实例绑定用户 ${config.authorized_user_id}，跳过处理`);
        remaining.push([i, item]);
        continue;
      }
      // 微信窗口关着：先留着，等对方回消息后补发
      if (windowClosed) {
        remaining.push([i, { ...item, held_by_window: true }]);
        continue;
      }

      console.log(`\n⏰ [动态定时提醒到期触发]: ${describeText(item.content)}${item.ai ? '（到点现写）' : ''}`);
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
        const body = item.prepared_text
          ? { text: item.prepared_text, note: '' }
          : item.ai
            ? await aiReminderText(item, dueLabel, userNickname)
            : { text: `🔔 ${userNickname}，提醒到啦：${item.content}`, note: '' };
        const nudge = withReplyNudge(`${body.text}${late}`, config);
        try {
          await sendWechatReply(toUser, ctxToken, nudge.text, config);
          appendLog(`[动态提醒下发成功]: ${item.ai ? body.text : item.content}`);
          console.log(`✅ [动态提醒已发送微信]: ${describeText(nudge.text)}${late ? '（补发）' : ''}${body.note}`);
        } catch (e) {
          nudge.undo();
          if (isWindowClosedError(e)) {
            console.warn('[动态提醒未送达]: 微信窗口已关闭，先留着，对方回消息后补发');
            markReplyWindowClosed();
            windowClosed = true;
            remaining.push([i, { ...item, held_by_window: true }]);
            continue;
          }
          // 网络之类的临时错误：留着，过一会儿再发（现写的提醒把写好的文字存下来，重试不再调用智能体）；试够次数才放弃并告警
          const tries = (item.send_failures || 0) + 1;
          if (tries < REMINDER_MAX_TRIES) {
            console.warn(`[动态提醒发送失败，${Math.round(REMINDER_RETRY_MS / 60000)} 分钟后重试（第 ${tries} 次）]:`, e.message);
            remaining.push([i, { ...item, send_failures: tries, retry_at: Date.now() + REMINDER_RETRY_MS, ...(item.ai ? { prepared_text: body.text } : {}) }]);
            continue;
          }
          console.error(`❌ [动态提醒发送失败]:`, e.message);
          raiseAlert('reminder_failed', `一条 ${dueLabel} 的提醒没发出去（试了 ${tries} 次）：${e.message}`);
        }
      } else {
        console.warn(`[动态提醒跳过]: 缺少 authorized_user_id 或 context_token`);
        raiseAlert('reminder_failed', `一条 ${dueLabel} 的提醒没发出去：缺少授权用户或 context_token`);
      }
    } else {
      remaining.push([i, item]);
    }
  }

  // 写回前重新读一遍：发送期间智能体可能又追加了新提醒，这些要保留下来
  const seen = new Set(reminders.map((r) => JSON.stringify(r)));
  const added = (readReminders() || []).filter((r) => !seen.has(JSON.stringify(r)));
  const next = [...remaining.sort((a, b) => a[0] - b[0]).map(([, r]) => r), ...added];
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
const CONSOLIDATION_TIMEOUT_MS = Number(process.env.CLAWBOT_CONSOLIDATION_TIMEOUT_MS) || 600000; // 平时每段 2~4 分钟，最慢的一次 4 分半
const durationText = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
// 03:00 之后这么久之内都可以开始或补跑（失败了隔 15 分钟重试，一天最多试 3 次）；进度记在 data/state/memory_consolidation.json
const NIGHT_WINDOW_MIN = Number(process.env.CLAWBOT_NIGHT_WINDOW_MIN) || 180;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MS = Number(process.env.CLAWBOT_CONSOLIDATION_RETRY_MS) || 15 * 60_000;
// 按天的聊天日志保存多久（平时不加载，只在要找"当时原话"时搜）
const LOG_KEEP_DAYS = Number(process.env.CLAWBOT_LOG_KEEP_DAYS) || 365;
// 一次性提醒发送失败（不是微信窗口关了那种）：隔几分钟重试，最多试几次
const REMINDER_RETRY_MS = Number(process.env.CLAWBOT_REMINDER_RETRY_MS) || 2 * 60_000;
const REMINDER_MAX_TRIES = Number(process.env.CLAWBOT_REMINDER_MAX_TRIES) || 5;
let consolidationRunning = false;

function consolidationState() {
  try { return loadRuntimeState('memory_consolidation'); } catch { return {}; }
}

/**
 * 凌晨 03:00 起整理昨天的聊天（Nightly Memory Consolidation）。
 * 放在后台跑，不卡调度循环（心跳、定时任务、提醒照常）。失败了自动重试，从没整理完的那一段接着来；服务重启后也能接上。
 */
async function checkNightlyMemoryConsolidation() {
  if (consolidationRunning) return;
  const info = getBeijingInfo();
  const minuteOfDay = info.hour * 60 + info.minute;
  if (minuteOfDay < NIGHTLY_AT_MINUTE || minuteOfDay > NIGHTLY_AT_MINUTE + NIGHT_WINDOW_MIN) return;

  const day = getBeijingInfo(new Date(Date.now() - 86400000)).dateStr;
  const st = consolidationState();
  if (st.day === day) {
    if (st.result === 'ok' || st.result === 'skipped' || (st.attempts || 0) >= MAX_ATTEMPTS) return;
    if (st.next_try_at && Date.now() < st.next_try_at) return;
  }

  consolidationRunning = true;
  runNightlyConsolidation({ day, resume: st.day === day ? st : null })
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

// 整理提示词：workDir 是记忆的副本（智能体只改副本，程序核对后再合并回线上）
function consolidationPrompt({ day, part, parts, chunk, userNickname, botName, workDir }) {
  const size = (rel) => {
    try { return charCount(fs.readFileSync(path.join(workDir, rel), 'utf-8')); } catch { return 0; }
  };
  const memoryPath = path.join(workDir, 'MEMORY.md');
  const currentMemory = fs.existsSync(memoryPath) ? capForLoading(fs.readFileSync(memoryPath, 'utf-8'), MEMORY_MAX_CHARS).text : '';
  // 专题来自本实例的 topics.json，核心代码不写死任何专题
  const topics = loadTopicsConfig(workDir);
  const topicLines = topics.length
    ? topics.map((t) => `   - ${t.name}：data/memory/topics/${t.file}（现在 ${size(`data/memory/topics/${t.file}`)} 字）`).join('\n')
    : '   - （还没有专题。需要时新建 data/memory/topics/<英文名>.md，并在 topics.json 里登记名字和关键词）';
  const shelves = [...new Set(listMemoryFiles(workDir).filter((f) => f.kind === 'library').map((f) => f.rel.split('/')[3]))];
  const md = day.slice(5);
  const partNote = parts > 1
    ? `昨天聊得比较多，分成 ${parts} 段整理，这是第 ${part} 段；前面的段已经整理过，当前目录里的记忆是整理后的最新内容。\n`
    : '';

  return `你是${botName}的记忆整理员。任务：读用户【${userNickname}】昨天（${day}）和助手【${botName}】的微信聊天记录，把值得长期记住的内容整理进当前目录下的记忆文件。
${partNote}
记忆分四块，都在当前目录下：
1. 核心档案 MEMORY.md（现在 ${size('MEMORY.md')} 字，上限 ${MEMORY_MAX_CHARS} 字）：每次聊天都要用到的——用户的身份、称呼、偏好、作息、底线。
2. 专题 data/memory/topics/（每本上限 ${TOPIC_MAX_CHARS} 字）：某个领域的结论、决定、现状，一条一两句话。现有专题：
${topicLines}
3. 资料库 data/memory/library/<专题文件名去掉 .md>/<主题>.md：调研资料、参数、价格、型号、步骤、对比、教程原文。一个文件一个主题，已有的接着往后写。${shelves.length ? `现有：${shelves.join('、')}。` : ''}
4. 大事记 data/memory/timeline/${day.slice(0, 7)}.md：在文件末尾加一节「## ${md}」，3～8 行，一行一件事：昨天发生了什么、定了什么、完成了什么。不写闲聊。

规则：
1. 只记有长期价值的：新的偏好、习惯、禁忌、决定、结论、长期待办、重要经历。忽略打招呼、客套、一次性的查询（问天气、下载一个视频）。
2. 只改和昨天聊天有关的条目：昨天没聊到的条目一个字都不要动（日期也不动），不要为了省字数去删字、合并或改写别的条目。
3. 同一件事只留最新的：已经有这件事的条目，就改那一条，不要另加一条；被取代的旧说法值得留的，写进大事记（"某某从 A 改成 B"）。
4. 资料细节放资料库：专题里只写一句结论，后面注明"（细节见资料库 <路径>）"。
5. 专题和核心档案里，昨天聊到的条目末尾标〔${md}〕（已有日期的改成〔${md}〕）。用户说"一直记住"的条目开头加 📌。
6. 用户说"忘掉""别记了"的：从核心档案和专题里删掉，大事记里只写一行"已按要求忘掉：<一个词说明是哪方面>"，不写具体内容。
7. 只写事实、规则、数字，不用比喻和修辞。
8. 文件超了上限也不要自己删别的内容：程序会另外把旧条目原样搬去资料库。
9. 资料库和大事记只往里加，不改、不删已有内容。
10. 只改当前目录下的这些记忆文件和 topics.json，别的文件不要动。昨天没有值得记的就什么都不改。

【当前 MEMORY.md 全文】：
${currentMemory}

【昨天的聊天记录${parts > 1 ? `（第 ${part}/${parts} 段）` : ''}】：
${chunk}`;
}

// 整理用的智能体在记忆副本的目录里跑（cwd），只改副本
function runConsolidationAgent(promptText, cwd) {
  return new Promise((resolve) => {
    const args = ['--dangerously-skip-permissions', ...AGY_STREAM_ARGS];
    const child = execFile(
      'agy',
      args,
      { cwd, timeout: CONSOLIDATION_TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ outcome: agyOutcome(err, stdout, stderr), err, stderr })
    );
    // 提示词（含昨天的聊天记录）从标准输入交过去，不放在命令行参数里
    child.stdin.on('error', () => {});
    child.stdin.end(agyInputLine(promptText));
  });
}

// 清理 LOG_KEEP_DAYS 天（默认一年）以前的按天日志
function cleanOldDailyLogs() {
  const historyDir = path.join(dataDir, 'history');
  try {
    if (fs.existsSync(historyDir)) {
      const cutoffMs = Date.now() - LOG_KEEP_DAYS * 86400000;
      for (const file of fs.readdirSync(historyDir)) {
        if (file.startsWith('chat_') && file.endsWith('.log')) {
          const fullP = path.join(historyDir, file);
          if (fs.statSync(fullP).mtimeMs < cutoffMs) {
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
 * 整理一段聊天：先把记忆复制一份，智能体只改副本；改完核对（见 memory_slim.js 的 checkChanges），
 * 通过了才合并回线上，没通过或出错就丢掉副本——线上不会留下改了一半的文件。
 */
async function consolidateChunk({ day, part, parts, chunk, userNickname, botName }) {
  const work = prepareWorkCopy(botRoot);
  try {
    const promptText = consolidationPrompt({ day, part, parts, chunk, userNickname, botName, workDir: work.dir });
    const { outcome, err, stderr } = await runConsolidationAgent(promptText, work.dir);
    recordAgentResult('scheduler', outcome);
    if (!outcome.ok) {
      // 只记退出码和错误输出的末尾，不用 err.message（里面是完整命令行）
      const detail = outcome.kind === 'auth'
        ? outcome.reason
        : outcome.kind === 'timeout'
          ? `超过 ${durationText(CONSOLIDATION_TIMEOUT_MS)}没整理完，这一段的改动没有采用`
          : String(stderr || '').trim().slice(-300) || `exit ${err?.code ?? err?.signal ?? 'status ERROR'}`;
      return { ok: false, kind: outcome.kind, detail };
    }
    const check = checkChanges(work, collectChanges(work));
    for (const n of check.notes) console.warn(`[睡眠记忆固化] ${n}`);
    if (!check.ok) return { ok: false, kind: 'rejected', detail: `整理结果没通过核对，没有采用：${check.reason}` };
    return { ok: true, ...applyChanges(botRoot, check.changes) };
  } finally {
    discardWorkCopy(work);
  }
}

// 超上限的核心档案或专题，一晚腾一个：旧的、细节的条目原样搬去资料库（只搬不删，程序核对）
async function slimOneOverLimitFile() {
  const over = overLimitFiles(botRoot);
  if (!over.length) return null;
  const f = over[0];
  const agent = agyPlanAgent(botRoot);
  const runPlanAgent = async (prompt) => {
    try {
      const text = await agent(prompt);
      recordAgentResult('scheduler', { ok: true });
      return text;
    } catch (e) {
      if (e.outcome) recordAgentResult('scheduler', e.outcome);
      throw e;
    }
  };
  const res = await slimFile(botRoot, f.rel, { runPlanAgent, today: getBeijingInfo().dateStr });
  if (res.ok) {
    const n = res.moved.reduce((s, m) => s + m.count, 0);
    console.log(`[腾地方] ${res.label}：${res.before} → ${res.after} 字，搬了 ${n} 条到 ${res.moved.map((m) => m.to).join('、')}`);
    appendLog(`[腾地方] ${res.label} ${res.before} → ${res.after} 字，搬了 ${n} 条去资料库`);
  } else {
    console.warn(`[腾地方没完成] ${f.label}：${res.reason}`);
    raiseAlert('memory_consolidation_failed', `「${f.label}」超上限，今晚腾地方没完成：${res.reason}。内容没有动，明晚再试`);
  }
  if (res.conflicts?.length) {
    raiseAlert('memory_consolidation_failed', `腾地方时「${f.label}」正好也被改了，自动合并不了，这次没有改它；搬家结果另存在 ${res.conflicts.map((c) => c.saved).join('、')}`);
  }
  return res;
}

/**
 * 整理昨天（北京时间）的全部聊天：没有昨天的按天日志就跳过（不再退回去读总日志，免得旧对话被一遍遍重新整理）；
 * 聊得多就按消息边界分段，一段一段整理，每段都在副本上做、核对后合并回线上。
 * 进度写在 data/state/memory_consolidation.json：哪一天、第几次尝试、整理完了几段、下次什么时候重试；
 * 失败了从没整理完的那一段接着来。管理服务存记忆版本时也据此标明"凌晨整理"。
 * 全部整理完以后，超上限的文件腾一个。
 */
export async function runNightlyConsolidation({ day, resume = null } = {}) {
  const yesterdayStr = day || getBeijingInfo(new Date(Date.now() - 86400000)).dateStr;
  const prev = resume && resume.day === yesterdayStr ? resume : {};
  const attempts = (prev.attempts || 0) + 1;
  let chunksDone = prev.chunks_done || 0;
  let result = 'failed';
  let parts = prev.parts || 0;
  let nextTry = null;
  let lastError = null;
  saveRuntimeState('memory_consolidation', {
    day: yesterdayStr, attempts, running: true, started_at: Date.now(), finished_at: null,
    result: null, parts, chunks_done: chunksDone, next_try_at: null, last_error: null,
  });
  console.log(`\n🌙 [03:00 睡眠记忆固化反思启动]: 整理 ${yesterdayStr} 的聊天${attempts > 1 ? `（第 ${attempts} 次尝试，从第 ${chunksDone + 1} 段接着来）` : ''}...`);
  appendLog(`[03:00 睡眠记忆固化启动] 开始复盘沉淀昨日记忆${attempts > 1 ? `（第 ${attempts} 次尝试）` : ''}`);

  try {
    const logPath = path.join(dataDir, 'history', `chat_${yesterdayStr}.log`);
    if (!fs.existsSync(logPath)) {
      result = 'skipped';
      console.log(`[睡眠记忆固化跳过]: 昨天（${yesterdayStr}）没有聊天记录。`);
      appendLog(`[睡眠记忆固化跳过] 昨日没有聊天记录`);
      await slimOneOverLimitFile();
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
      result = 'skipped';
      console.log(`[睡眠记忆固化跳过]: 昨日无足够对话记录 (${total} 字)。`);
      appendLog(`[睡眠记忆固化跳过] 昨日无足够对话记录`);
      await slimOneOverLimitFile();
      return;
    }

    let chunks = splitIntoChunks(entries, CHUNK_CHARS);
    if (chunks.length > MAX_CHUNKS) {
      console.warn(`[睡眠记忆固化]: 昨天的聊天有 ${chunks.length} 段，只整理最后 ${MAX_CHUNKS} 段。`);
      appendLog(`[睡眠记忆固化] 昨日聊天有 ${chunks.length} 段，只整理了最后 ${MAX_CHUNKS} 段`);
      chunks = chunks.slice(-MAX_CHUNKS);
    }
    parts = chunks.length;

    for (let i = chunksDone; i < chunks.length; i++) {
      const where = chunks.length > 1 ? `（第 ${i + 1}/${chunks.length} 段）` : '';
      const r = await consolidateChunk({ day: yesterdayStr, part: i + 1, parts: chunks.length, chunk: chunks[i], userNickname, botName });
      if (!r.ok) {
        lastError = r.detail;
        const retry = attempts < MAX_ATTEMPTS;
        if (retry) nextTry = Date.now() + RETRY_AFTER_MS;
        console.error(`[睡眠记忆固化执行异常]${where}: ${r.detail}`);
        appendLog(`[睡眠记忆固化失败]${where}: ${r.detail}`);
        // 登录失效由"智能体登录失效"告警统一报，这里不再重复报一条
        if (r.kind !== 'auth') {
          raiseAlert('memory_consolidation_failed', `凌晨记忆整理失败${where}：${r.detail}。${retry
            ? `${Math.round(RETRY_AFTER_MS / 60000)} 分钟后自动重试（第 ${attempts + 1}/${MAX_ATTEMPTS} 次），已经整理好的段不会重复整理`
            : '今天的自动重试已经用完，没整理的部分今天不会再整理'}`);
        }
        return;
      }
      chunksDone = i + 1;
      saveRuntimeState('memory_consolidation', { chunks_done: chunksDone, parts });
      if (r.conflicts.length) {
        raiseAlert('memory_consolidation_failed', `整理${where}时 ${r.conflicts.map((c) => c.rel).join('、')} 正好也被改了，自动合并不了，没有改它们；整理结果另存在 ${r.conflicts.map((c) => c.saved).join('、')}`);
      }
      if (where) console.log(`[睡眠记忆固化]: ${where.slice(1, -1)}整理完成，改了 ${r.applied.length} 个文件`);
    }
    result = 'ok';
    console.log(`🎉 [03:00 睡眠记忆固化完成]: 昨天的聊天整理完了${chunks.length > 1 ? `（分 ${chunks.length} 段）` : ''}`);
    appendLog(`[睡眠记忆固化完成] 昨天的聊天整理完了`);
    await slimOneOverLimitFile();
  } finally {
    if (result === 'failed' && !nextTry && attempts < MAX_ATTEMPTS) nextTry = Date.now() + RETRY_AFTER_MS;
    saveRuntimeState('memory_consolidation', {
      running: false, finished_at: Date.now(), result, parts, chunks_done: chunksDone, next_try_at: nextTry, last_error: lastError,
    });
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
  console.log(` • [03:00] 每天 - 把昨天的聊天整理进记忆（失败自动重试；超上限的文件把旧条目搬去资料库）`);
  const memoryNote = {
    owner: '记忆历史：定时检查所有实例的记忆改动并存版本，早间播报附上"记忆变动"',
    standalone: '记忆历史：定时检查本实例的记忆改动并存版本（data/memory-history/），早间播报附上"记忆变动"',
    managed: '改动汇报：早间播报附上管理服务准备好的汇报（记忆和设置的版本由管理服务统一存）',
    off: '记忆历史：没有开启（没装 git，或者设了 CLAWBOT_MEMORY_MODE=off）',
  }[MEMORY_MODE];
  console.log(` • ${memoryNote}`);
  console.log(`====================================================\n`);

  // 心跳 + 任务表：监控服务据此发现"调度器停了"和"定时任务到点没发"；任务表跟着 tasks.js 的重新载入更新
  const heartbeat = () => {
    try {
      saveRuntimeState('scheduler', { heartbeat_at: Date.now(), tasks: taskManifest(cachedTasks || []) });
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
