import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sendWechatReply, loadConfig, loadRuntimeState, saveRuntimeState, describeText, writeJsonAtomic } from './wechat_reply.js';
import { loadTopicsConfig, textAfterLastReset, listMemoryFiles, capForLoading, charCount, MEMORY_MAX_CHARS, TOPIC_MAX_CHARS } from './memory_config.js';
import {
  prepareWorkCopy, discardWorkCopy, collectChanges, checkChanges, applyChanges, slimFile, overLimitFiles, agyPlanAgent,
  numberMemory, parseChangeList, applyChangeList,
} from './memory_slim.js';
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

// 现读现改现写：调度循环和补发可能同时在跑，各改各的字段，不拿手里旧的整份去覆盖
function updateState(change) {
  const state = loadState();
  change(state);
  saveState(state);
  return state;
}

/**
 * 微信只允许机器人在对方最近一次发消息后的一段时间内（实测约 24 小时）主动发消息，超过就返回 prepare failed。
 *   - 对方超过 12 小时没发消息：下一条主动消息末尾请对方回一句（同一段只加一次，config.reply_nudge_hours 可调）
 *   - 发送被拒：记为"窗口已关"，不再生成文案、不再逐条报错，只告警一次；到点的提醒先留着
 *   - 对方发来新消息（forwarder 记下 last_user_message_at）：窗口重新打开，告警"已恢复"，留着的提醒补发
 *   - 早间播报（标了 memoryDigest 的任务）当天没送达：对方当天回消息时补发一次（文案现写，带上记忆变动）；过了当天就不补
 * 状态在 data/state/reply_window.json：closed_at、closed_user_at、nudged_for；没送达的播报记在 scheduler_state.json 的 missed
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

// 早间播报因为微信窗口关着没送达：记下来，对方当天回消息就补发一次。
// missed：{ 任务 id: { date, at, digestOnly } }；digestOnly = 播报已经发出去了，只差"记忆变动"那一条
function markMissed(task, todayStr, digestOnly = false) {
  if (!task.memoryDigest) return;
  updateState((s) => {
    s.missed = { ...(s.missed || {}), [task.id]: { date: todayStr, at: hhmm(task), digestOnly } };
  });
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
      updateState((s) => {
        s.last_fired = { ...(s.last_fired || {}), [task.id]: todayStr };
      });
      await deliverTask(task, { todayStr });
    }
  }
}

/**
 * 发一个定时任务。标了 memoryDigest 的播报（早间天气）：播报一条，这个实例自己的"记忆变动"另发一条；
 * 记忆变动没发出去就留到下一次一起列。微信窗口关着、没送达的早间播报记进 missed，对方当天回消息时补发。
 *   late：补发时原本的时间（"08:30"），播报末尾写明是补发；digestOnly：播报已经发过了，只补记忆变动
 * 返回 'sent' | 'window'（窗口关着，有东西留着等补发）| 'failed'
 */
async function deliverTask(task, { todayStr, late = '', digestOnly = false }) {
  try {
    const config = loadConfig();
    const userId = config.authorized_user_id;

    if (!userId) {
      console.warn(`[跳过任务 ${task.id}]: 未找到 authorized_user_id，请先扫码绑定。`);
      raiseAlert('task_failed', `定时任务「${task.name}」没发出去：实例未绑定授权用户`);
      return 'failed';
    }

    // 对方太久没发消息、微信已经拒绝过主动发送：不白白生成文案，等对方回消息后恢复（早间播报当天补发）
    if (replyWindow().closed_at) {
      console.warn(`[跳过定时任务 ${task.id}]: 微信窗口已关闭，等${config.user_nickname || '用户'}回消息后恢复`);
      appendLog(`[定时任务暂停] ${task.name}: 微信窗口已关闭`);
      markMissed(task, todayStr, digestOnly);
      return 'window';
    }

    // 每次发送都用最新的 context_token：现写文案可能要一两分钟，这期间对方也许发了新消息
    const send = (text) => sendWechatReply(userId, loadRuntimeState('forwarder').last_context_token, text, config);
    const msgText = digestOnly ? '' : await task.generateCopy();
    const digest = !task.memoryDigest ? null : MEMORY_REVIEW ? memoryDigest() : MEMORY_MODE === 'managed' ? pendingDigest() : null;
    const digestCount = digest ? digest.items?.length ?? digest.count : 0;
    if (digestOnly && !digest) {
      console.log(`[记忆变动不用补发]: ${task.name}，已经没有待发的了`);
      return 'sent';
    }
    let sentText = '';

    if (!digestOnly) {
      const lateNote = late ? `\n（这条播报原本是今天 ${late} 的，当时微信不让${config.bot_name || '小助理'}主动发，现在补上。）` : '';
      const text = `${msgText}${lateNote}`;
      const nudge = withReplyNudge(text, config);
      console.log(`[生成文案]: ${describeText(nudge.text)}${digest ? `（附记忆变动 ${digestCount} 条）` : ''}${nudge.text !== text ? '（末尾请对方回一句）' : ''}${late ? '（补发）' : ''}`);
      try {
        await send(nudge.text);
      } catch (sendErr) {
        nudge.undo();
        throw sendErr;
      }
      sentText = nudge.text;
    }

    let digestLeft = false;
    if (digest) {
      try {
        await send(digest.text);
        try {
          // 自己管历史的记进度；被代管的实例写回执，主人的机器人看到后再记
          if (MEMORY_REVIEW) markDigestDelivered(digest);
          else saveRuntimeState('memory_digest_ack', { id: digest.id, delivered_at: Date.now() });
        } catch (e) {
          console.error('[记录记忆汇报进度失败]:', e.message);
        }
      } catch (e) {
        digestLeft = true;
        if (isWindowClosedError(e)) {
          console.warn(`[记忆变动未送达]: ${task.name}（微信窗口已关闭），对方今天回消息后补发`);
          markReplyWindowClosed();
          markMissed(task, todayStr, true);
        } else {
          console.error(`[记忆变动没发出去，留到下次一起列]: ${task.name}`, e.message);
        }
        if (digestOnly) return isWindowClosedError(e) ? 'window' : 'failed';
      }
    }

    // 聊天日志里不写汇报的内容（免得被凌晨整理当成对话），只记条数
    if (digestOnly) {
      appendLog(`[记忆变动补发成功] ${task.name}: ${digestCount} 条`);
      console.log(`✅ [记忆变动补发完成]: ${task.name}\n`);
      return 'sent';
    }
    const what = !digest ? sentText : `${msgText}（${digestLeft ? `记忆变动 ${digestCount} 条没发出去，留着` : `附记忆变动 ${digestCount} 条`}）`;
    appendLog(`[定时任务成功] ${task.name}${late ? '（补发）' : ''}: ${what}`);
    console.log(`✅ [定时任务下发完成]: ${task.name}${late ? '（补发）' : ''}\n`);
    return digestLeft && replyWindow().closed_at ? 'window' : 'sent';
  } catch (err) {
    if (isWindowClosedError(err)) {
      console.warn(`[定时任务未送达]: ${task.name}（微信窗口已关闭）`);
      appendLog(`[定时任务未送达] ${task.name}: 微信窗口已关闭`);
      markReplyWindowClosed();
      markMissed(task, todayStr, digestOnly);
      return 'window';
    }
    console.error(`❌ [定时任务执行失败]: ${task.name}`, err.message);
    appendLog(`[定时任务失败] ${task.name}: ${err.message}`);
    raiseAlert('task_failed', `定时任务「${task.name}」没发出去：${err.message}`);
    return 'failed';
  }
}

// 对方回了消息、窗口重新打开：当天没送达的早间播报补发一次（文案现写，带上到现在为止的记忆变动）。
// 不是今天的不补（隔天的天气没意义；记忆变动会跟着下一次播报一起列）
let catchUpBusy = false;
async function catchUpMissedBroadcasts() {
  if (catchUpBusy) return;
  const missed = loadState().missed || {};
  if (!Object.keys(missed).length) return;
  catchUpBusy = true;
  try {
    const todayStr = getBeijingInfo().dateStr;
    const tasks = await loadBotTasks();
    for (const [id, m] of Object.entries(missed)) {
      const task = tasks.find((t) => t.id === id);
      if (m?.date !== todayStr || !task?.memoryDigest) {
        console.log(`[不再补发] ${task?.name || id}：${m?.date !== todayStr ? `是 ${m?.date} 的，已经过了当天` : '这个任务已经不在了'}`);
        updateState((s) => {
          if (s.missed) delete s.missed[id];
        });
        continue;
      }
      if (replyWindow().closed_at) continue;
      console.log(`\n📮 [补发早间播报]: ${task.name}（原本 ${m.at}${m.digestOnly ? '，播报已经发了，只补记忆变动' : ''}）`);
      const result = await deliverTask(task, { todayStr, late: m.at, digestOnly: Boolean(m.digestOnly) });
      if (result !== 'window') {
        updateState((s) => {
          if (s.missed) delete s.missed[id];
        });
      }
    }
  } finally {
    catchUpBusy = false;
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
// 每段限时：一段只调一次智能体，平时一两分钟；模型慢的时候一次也可能要好几分钟，留足余量
const CONSOLIDATION_TIMEOUT_MS = Number(process.env.CLAWBOT_CONSOLIDATION_TIMEOUT_MS) || 1200000;
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

// 整理提示词：智能体不碰文件，只交一张改动清单（JSON），程序照着改副本、核对后合并回线上。
// 核心档案和各本专题按条目编号给全（numberMemory），资料库只列文件名，聊天记录给这一段。
// 11-12 凌晨两个机器人都超时：原来让智能体自己一步步改文件，一段要和模型来回十几到几十次，模型一慢就整段作废
function consolidationPrompt({ day, part, parts, chunk, userNickname, botName, workDir, numbered }) {
  const library = listMemoryFiles(workDir).filter((f) => f.kind === 'library').map((f) => f.rel.slice('data/memory/library/'.length));
  const md = day.slice(5);
  const timeline = `data/memory/timeline/${day.slice(0, 7)}.md`;
  const core = numbered.parts.find((p) => p.file.kind === 'core');
  const topicParts = numbered.parts.filter((p) => p.file.kind === 'topic');
  const topicLines = topicParts.length
    ? topicParts.map((p) => `   - ${p.file.label}：${path.basename(p.file.rel)}（现在 ${p.size} 字）`).join('\n')
    : '   - （还没有专题）';
  const exampleTopic = topicParts.length ? path.basename(topicParts[0].file.rel) : 'health.md';
  const partNote = parts > 1
    ? `昨天聊得比较多，分成 ${parts} 段整理，这是第 ${part} 段；前面的段已经整理过，下面给的记忆是整理后的最新内容。\n`
    : '';
  // 文件写坏了、超过上限很多的：只列前面两倍上限的字数（后面的条目这次不改），免得提示词撑爆
  const clip = (s, max) => {
    const c = [...s];
    return c.length > max * 2 ? `${c.slice(0, max * 2).join('')}\n…（后面还有 ${c.length - max * 2} 字没列出来，这次不改它们）` : s;
  };
  const sections = [
    `【核心档案 MEMORY.md（现在 ${core?.size ?? 0} 字，上限 ${MEMORY_MAX_CHARS} 字）】：\n${clip(core?.listing || '（还是空的）', MEMORY_MAX_CHARS)}`,
    ...topicParts.map((p) => `【专题：${p.file.label}（${path.basename(p.file.rel)}，现在 ${p.size} 字，上限 ${TOPIC_MAX_CHARS} 字）】：\n${clip(p.listing || '（还是空的）', TOPIC_MAX_CHARS)}`),
  ];

  return `你是${botName}的记忆整理员。任务：读用户【${userNickname}】昨天（${day}）和助手【${botName}】的微信聊天记录，把值得长期记住的内容整理进记忆。
${partNote}
你不能自己改文件，也不用改：只要交一张"改动清单"（JSON），程序照着改，改完再核对。要用的东西下面都给全了：核心档案和每本专题的全文（每一条前面的 [#编号] 用来指明改哪一条）、资料库有哪些文件、昨天的聊天记录。不要调用任何工具，不要读文件、列目录，也不要上网查——这是整理，不是调研，聊天里怎么说就怎么记。直接输出 JSON。

记忆分四块：
1. 核心档案 MEMORY.md（现在 ${core?.size ?? 0} 字，上限 ${MEMORY_MAX_CHARS} 字）：每次聊天都要用到的——用户的身份、称呼、偏好、作息、底线。
2. 专题 data/memory/topics/（每本上限 ${TOPIC_MAX_CHARS} 字）：某个领域的结论、决定、现状，一条一两句话。现有专题：
${topicLines}
3. 资料库 data/memory/library/<专题文件名去掉 .md>/<主题>.md：调研资料、参数、价格、型号、步骤、对比、教程，一个文件一个主题。每次往一个文件里加的内容只记要点，不超过 1500 字，不用整段照抄聊天（聊天原文另有一年的日志可查）。现有文件：${library.length ? library.slice(0, 80).join('、') : '（还没有）'}
4. 大事记 ${timeline}：昨天发生了什么、定了什么、完成了什么，3～8 行，一行一件事，不写闲聊。程序会把它们放在「## ${md}」下面。

规则：
1. 只记有长期价值的：新的偏好、习惯、禁忌、决定、结论、长期待办、重要经历。忽略打招呼、客套、一次性的查询（问天气、下载一个视频）。
2. 只改和昨天聊天有关的条目：昨天没聊到的条目一个字都不要动（不要写进清单，日期也不动），不要为了省字数去删字、合并或改写别的条目。
3. 同一件事只留最新的：已经有这件事的条目，就用 replace 改那一条，不要另加一条；被取代的旧说法值得留的，写进大事记（"某某从 A 改成 B"）。
4. 资料细节放资料库：专题里只写一句结论，后面注明"（细节见资料库 <路径>）"。
5. 专题和核心档案里，昨天聊到的条目末尾标〔${md}〕（已有日期的改成〔${md}〕）。用户说"一直记住"的条目开头加 📌；带 📌 的条目改写时 📌 要保留。
6. 用户说"忘掉""别记了"的：用 replace 把那一条的 text 写成空字符串（就是删掉），大事记里只写一行"已按要求忘掉：<一个词说明是哪方面>"，不写具体内容。
7. 只写事实、规则、数字，不用比喻和修辞。
8. 文件超了上限也不要自己删别的内容：程序会另外把旧条目原样搬去资料库。
9. 资料库和大事记只往里加：程序会加在文件末尾，已有的内容不用重复。
10. 昨天没有值得记的，就交一张空清单：{"replace":[],"insert":[],"library":[],"timeline":[]}。

改动清单的格式（只输出这一个 JSON，不要任何别的文字）：
{"replace":[{"id":"#12","text":"改后的完整条目"}],
 "insert":[{"after":"#12","text":"- 新条目〔${md}〕"}],
 "library":[{"file":"<专题文件名去掉 .md>/<主题>.md","text":"要追加的内容"}],
 "timeline":["一行一件事"],
 "new_topics":[]}
- replace：改已有的条目。id 是那一条前面的编号，text 是改后的完整条目（原来几行就写几行）。
- insert：加新条目。after 写放在哪一条后面（放在相关小标题下最后一条的编号后面）；要加到某个文件末尾，after 写文件名（MEMORY.md 或专题的文件名，比如 ${exampleTopic}）。
- library：file 写资料库里的相对路径；已有的文件追加到末尾，没有就新建。
- timeline：只写这几行内容，每行一件事。
- new_topics：现有专题都不合适、又确实需要时才新建（很少用），格式 {"name":"专题名","file":"英文名.md","keywords":["关键词"],"text":"第一批条目"}。
- 没有要改的项就写空数组。

${sections.join('\n\n')}

【昨天的聊天记录${parts > 1 ? `（第 ${part}/${parts} 段）` : ''}】：
${chunk}`;
}

// 整理用的智能体在一个空目录里跑，只要它的文字回复（改动清单），它碰不到记忆文件
const CONSOLIDATION_AGENT_DIR = path.join('data', 'state', 'consolidation-agent');
// 整理用哪个模型：默认跟这个账号的设置走；环境变量可以单独指定（比如 gemini-3.8-flash-medium）
const CONSOLIDATION_MODEL = process.env.CLAWBOT_CONSOLIDATION_MODEL || '';
function runConsolidationAgent(promptText) {
  return new Promise((resolve) => {
    const cwd = path.join(botRoot, CONSOLIDATION_AGENT_DIR);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    const args = ['--dangerously-skip-permissions', ...(CONSOLIDATION_MODEL ? ['--model', CONSOLIDATION_MODEL] : []), ...AGY_STREAM_ARGS];
    const child = execFile(
      'agy',
      args,
      { cwd, timeout: CONSOLIDATION_TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.rmSync(cwd, { recursive: true, force: true });
        resolve({ outcome: agyOutcome(err, stdout, stderr), err, stderr });
      }
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
 * 整理一段聊天：先把记忆复制一份；智能体只交改动清单，程序照清单改副本（不合规的项跳过并记下来）；
 * 改完核对（见 memory_slim.js 的 checkChanges），通过了才合并回线上，没通过或出错就丢掉副本——线上不会留下改了一半的文件。
 */
async function consolidateChunk({ day, part, parts, chunk, userNickname, botName }) {
  const work = prepareWorkCopy(botRoot);
  try {
    const files = listMemoryFiles(work.dir).filter((f) => f.kind === 'core' || f.kind === 'topic');
    const numbered = numberMemory(work.dir, files);
    const promptText = consolidationPrompt({ day, part, parts, chunk, userNickname, botName, workDir: work.dir, numbered });
    const { outcome, err, stderr } = await runConsolidationAgent(promptText);
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
    let list;
    try {
      list = parseChangeList(outcome.json?.response);
    } catch (e) {
      return { ok: false, kind: 'error', detail: `智能体没交出能用的改动清单（${e.message}），这一段没有整理` };
    }
    const { notes, counts } = applyChangeList(work.dir, list, { day, numbered });
    for (const n of notes) console.warn(`[睡眠记忆固化] 清单里这一项没有采用：${n}`);
    const check = checkChanges(work, collectChanges(work));
    for (const n of check.notes) console.warn(`[睡眠记忆固化] ${n}`);
    if (!check.ok) return { ok: false, kind: 'rejected', detail: `整理结果没通过核对，没有采用：${check.reason}` };
    return { ok: true, counts, skipped: notes, ...applyChanges(botRoot, check.changes) };
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
      const n = r.counts || {};
      console.log(`[睡眠记忆固化]: ${where ? where.slice(1, -1) : ''}整理完成：改 ${n.replace || 0} 条、删 ${n.delete || 0} 条、新加 ${n.insert || 0} 条、资料库 ${n.library || 0} 处、大事记 ${n.timeline || 0} 行${n.newTopics ? `、新专题 ${n.newTopics} 本` : ''}${r.skipped?.length ? `，跳过 ${r.skipped.length} 项` : ''}，写了 ${r.applied.length} 个文件`);
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
    owner: '记忆历史：定时检查所有实例的记忆改动并存版本，早间播报之后另发一条"记忆变动"',
    standalone: '记忆历史：定时检查本实例的记忆改动并存版本（data/memory-history/），早间播报之后另发一条"记忆变动"',
    managed: '改动汇报：早间播报之后另发一条管理服务准备好的汇报（记忆和设置的版本由管理服务统一存）',
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
    catchUpMissedBroadcasts().catch((e) => console.error('[补发早间播报异常]:', e.message));
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

  catchUpMissedBroadcasts().catch((e) => console.error('[首次补发检查异常]:', e.message));
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
