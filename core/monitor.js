/**
 * clawbot-monitor：定时检查这台机器上所有机器人实例，发现问题就发通知（微信 + 邮件）。
 *
 *   1. 各实例进程写在 data/alerts/ 里的告警事件（登录过期、定时任务失败、消息处理失败等）
 *   2. 每个实例的 3 个 systemd 服务：反复崩溃、停了太久
 *   3. 调度器心跳和任务表：心跳停了、定时任务到点没发
 *
 * 同一问题在去重窗口（默认 6 小时）内只通知一次；一直没好的问题过了窗口再提醒一次；恢复时发一条"已恢复"。
 * 发给谁：配置里有 owner_bot（一台机器上统一管理）时，全部经这个主人的机器人发给主人；没有时（默认），
 * 每个实例经自己的微信发给它自己的用户。发微信的那个机器人自己登录过期时不走微信，只发邮件（配置了的话）。
 * 两个渠道都没发出去的通知，1 小时内每轮重试。通知里只有实例、问题、时间和处理建议，不含任何消息内容。
 * 配置：/etc/clawbot/alert.json（只有 root 能读，不进 git），没有就用项目目录下的 alert.json；
 * 邮件部分由 deploy/set_alert_email.sh 填写。不配置也能用：只走各实例自己的微信。
 * 用法：node monitor.js                         常驻运行（由 clawbot-monitor.service 托管）
 *       node monitor.js --test [wechat|email]   发一条测试通知后退出（默认两个渠道都发）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sendWechatReply, writeJsonAtomic } from './wechat_reply.js';

const env = (name, fallback) => Number(process.env[name]) || fallback;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOTS_DIR = process.env.CLAWBOT_BOTS_DIR || path.join(PROJECT_DIR, 'bots');
const CONFIG_FILE = process.env.CLAWBOT_ALERT_CONFIG
  || (fs.existsSync('/etc/clawbot/alert.json') ? '/etc/clawbot/alert.json' : path.join(PROJECT_DIR, 'alert.json'));
const STATE_FILE = process.env.CLAWBOT_MONITOR_STATE
  || (process.getuid?.() === 0 ? '/var/lib/clawbot/monitor.json' : path.join(PROJECT_DIR, 'data', 'monitor.json'));
const UNIT_FORMAT = process.env.CLAWBOT_UNIT_FORMAT || 'clawbot-{role}@{bot}';
const INTERVAL_MS = env('MONITOR_INTERVAL_MS', 30_000);
const CRASH_WINDOW_MS = env('MONITOR_CRASH_WINDOW_MS', 10 * 60_000);
const CRASH_RESTARTS = env('MONITOR_CRASH_RESTARTS', 3);
const DOWN_AFTER_MS = env('MONITOR_DOWN_AFTER_MS', 2 * 60_000);
const HEARTBEAT_STALE_MS = env('MONITOR_HEARTBEAT_STALE_MS', 3 * 60_000);
const MISSED_AFTER_MS = env('MONITOR_MISSED_AFTER_MS', 5 * 60_000);
const MISSED_WINDOW_MS = env('MONITOR_MISSED_WINDOW_MS', 2 * 3600_000);
const RETRY_FOR_MS = env('MONITOR_RETRY_FOR_MS', 3600_000);
const SEND_TIMEOUT_MS = env('MONITOR_SEND_TIMEOUT_MS', 30_000);
const WINDOW_DEDUPE_MS = env('MONITOR_WINDOW_DEDUPE_MS', 24 * 3600_000); // "太久没发消息"一天最多提醒一次
const AGENT_FAIL_STREAK = env('MONITOR_AGENT_FAIL_STREAK', 3); // 智能体除登录失效外，连续失败几次才报
const AGENT_ERROR_KINDS = { timeout: '超时没完成', error: '调用出错' };
const SEND_MAIL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'send_mail.py');
const HAS_WARP = ['/usr/bin/warp-cli', '/usr/local/bin/warp-cli'].some((p) => fs.existsSync(p));
const ROLES = { routine: '消息处理', forwarder: '消息接收', scheduler: '定时任务' };

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};
const duration = (ms) => (ms >= 2 * 3600_000 ? `${Math.round(ms / 3600_000)} 小时` : `${Math.max(1, Math.round(ms / 60_000))} 分钟`);

export function beijingParts(t = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}` };
}
const beijingTime = (t) => { const p = beijingParts(t); return `${p.date} ${p.hour}:${p.minute}:${p.second}`; };

// 今天（北京时间）某个任务的到点时刻；工作日任务碰上周末返回 null
export function dueTimeToday(task, now = Date.now()) {
  const p = beijingParts(now);
  if (task.workdaysOnly && ['Sat', 'Sun'].includes(p.weekday)) return null;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), task.hour - 8, task.minute);
}

const unitName = (role, bot) => UNIT_FORMAT.replaceAll('{role}', role).replaceAll('{bot}', bot);
// 用 systemd 托管的（服务在运行或已启用）看 journalctl；否则当成 PM2 托管（进程名是 <实例>-<服务>），看 pm2 logs
const systemdManaged = (st) => st?.load === 'loaded' && (st.active !== 'inactive' || st.fileState.startsWith('enabled'));
const logsOf = (role, bot) => (systemdManaged(unitStatus(unitName(role, bot.name)))
  ? `查看日志：journalctl -u ${unitName(role, bot.name)} -n 50`
  : `查看日志：pm2 logs ${bot.name}-${role} --lines 50`);

function unitStatus(unit) {
  try {
    const out = execFileSync('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState', '-p', 'NRestarts'], { encoding: 'utf-8', timeout: 10_000 });
    const kv = {};
    for (const line of out.trim().split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
    }
    return { load: kv.LoadState, active: kv.ActiveState, fileState: kv.UnitFileState || '', restarts: Number(kv.NRestarts || 0) };
  } catch {
    return null;
  }
}

/**
 * 智能体（agy）现在好不好，看各进程记下的调用结果（data/state/agent_routine.json、agent_scheduler.json）：
 *   登录失效之后再没有成功过 → auth；某个进程连续失败 N 次、之后也没有成功过 → failing；否则 ok。没有记录 → null
 */
function agentStatus(bot) {
  const procs = ['routine', 'scheduler']
    .map((p) => readJson(path.join(bot.dir, 'data', 'state', `agent_${p}.json`)))
    .filter(Boolean);
  if (!procs.length) return null;
  const lastOk = Math.max(0, ...procs.map((p) => p.last_ok_at || 0));
  const authAt = Math.max(0, ...procs.map((p) => p.auth_failed_at || 0));
  if (authAt > lastOk) return { kind: 'auth', since: authAt };
  const failing = procs
    .filter((p) => (p.fail_streak || 0) >= AGENT_FAIL_STREAK && (p.last_fail_at || 0) > lastOk)
    .sort((a, b) => b.last_fail_at - a.last_fail_at)[0];
  if (failing) return { kind: 'failing', streak: failing.fail_streak, errorKind: failing.last_error_kind, error: failing.last_error };
  return { kind: 'ok' };
}

// 重新登录 agy 的命令：沙箱实例要以它自己的账号登录（看消息处理服务以哪个账号运行）
function agyLoginAdvice(bot) {
  let user = '';
  try {
    user = execFileSync('systemctl', ['show', unitName('routine', bot.name), '-p', 'User', '--value'], { encoding: 'utf-8', timeout: 10_000 }).trim();
  } catch {}
  const how = user === 'root'
    ? '在服务器上用 root 执行：/root/.local/bin/agy -p "登录测试"'
    : user
      ? `在服务器上用 root 执行：runuser -u ${user} -- env HOME=/home/${user} PATH=/home/${user}/.local/bin:/opt/node22/bin:/usr/bin:/bin agy -p "登录测试"`
      : '用运行这个机器人的账号执行：agy -p "登录测试"';
  return `${how} ，打开它给出的链接用 Google 账号登录，再把页面上的授权码粘贴回终端。登录好后，下一次调用成功就会通知"已恢复"。`;
}

function discoverBots() {
  let names = [];
  try { names = fs.readdirSync(BOTS_DIR); } catch {}
  return names
    .map((name) => ({ name, dir: path.join(BOTS_DIR, name) }))
    .filter((b) => fs.existsSync(path.join(b.dir, 'config.json')))
    .map((b) => {
      const cfg = readJson(path.join(b.dir, 'config.json')) || {};
      return { ...b, display: cfg.bot_name || b.name, user: cfg.user_nickname || '用户' };
    });
}

// 各进程写的事件 → 标题和处理建议。sticky：持续性的问题，没恢复就过了窗口再提醒；recovery：恢复事件
const EVENTS = {
  credential_expired: { key: 'credential', sticky: true, title: '微信登录已过期', advice: (b) => `机器人现在收不到也发不出消息。请在服务器上执行 cd ${b.dir} && node ../../core/login.js ，再用这个机器人绑定的微信扫码。` },
  credential_ok: { key: 'credential', recovery: true, title: '微信登录已恢复' },
  task_failed: { key: 'task_failed', event: true, title: '定时任务没发出去', advice: (b) => logsOf('scheduler', b) },
  reminder_failed: { key: 'reminder_failed', event: true, title: '提醒没发出去', advice: (b) => logsOf('scheduler', b) },
  memory_consolidation_failed: { key: 'memory', event: true, title: '凌晨记忆整理失败', advice: (b) => logsOf('scheduler', b) },
  memory_snapshot_failed: { key: 'memory_snapshot', event: true, title: '记忆历史存版本失败', advice: (b) => `记忆改动暂时没有存进历史，早间的"记忆变动"汇报和撤销可能不全。${logsOf('scheduler', b)}` },
  message_failed: { key: 'message_failed', event: true, title: '有消息没处理成功', advice: (b) => `失败的消息放在 ${b.dir}/data/inbox/failed/ ；${logsOf('routine', b)}` },
  reply_failed: { key: 'reply_failed', event: true, title: '有回复没发出去', advice: (b) => logsOf('routine', b) },
  // 微信只允许机器人在对方最近一次发消息后约 24 小时内主动发消息；标题和建议里用实例自己的称呼
  user_window_closed: {
    key: 'user_window', sticky: true, dedupeMs: WINDOW_DEDUPE_MS,
    title: (b) => `${b.user}太久没给${b.display}发消息，${b.display}暂时发不出消息了`,
    advice: (b) => `微信只允许机器人在对方最近一次发消息后约 24 小时内主动发消息。让${b.user}给${b.display}随便发一句话就能恢复；这期间${b.user}自己设的提醒会先留着，恢复后补发。`,
  },
  user_window_ok: { key: 'user_window', recovery: true, title: (b) => `${b.user}回消息了，${b.display}恢复正常` },
};

// keys：每个问题的通知记录（有记录 = 已通知、还没恢复）；units：服务重启计数采样；retry：没发出去待重试的通知；
// ownerWindowClosedFor / windowClosedFor[实例]：经这个机器人发微信被拒（窗口已关）时，它的用户最后一条消息的时间，
// 用户再发消息之前不再走微信（统一管理时只有主人的机器人发，记在 ownerWindowClosedFor）
let state = { keys: {}, units: {}, retry: [], ownerWindowClosedFor: null, windowClosedFor: {} };
function loadState() {
  const s = readJson(STATE_FILE) || {};
  state = {
    keys: s.keys || {}, units: s.units || {}, retry: s.retry || [],
    ownerWindowClosedFor: s.ownerWindowClosedFor ?? null, windowClosedFor: s.windowClosedFor || {},
  };
}

/**
 * 去重：同一个问题在窗口内只通知一次（事件类会记下这期间又发生了几次）；没恢复的问题过了窗口再提醒；
 * 恢复通知只在之前确实通知过这个问题时才发。
 */
function notify(outgoing, key, alert, dedupeMs) {
  const now = Date.now();
  const s = state.keys[key];
  alert = { at: now, ...alert };
  if (alert.recovery) {
    if (!s) return;
    delete state.keys[key];
    outgoing.push({ ...alert, at: now, since: s.firstAt });
    return;
  }
  if (s && now - s.lastSentAt < dedupeMs) {
    s.repeats++;
    return;
  }
  outgoing.push({ ...alert, repeats: alert.event ? s?.repeats || 0 : 0, ongoingSince: !alert.event && s ? s.firstAt : 0 });
  const { at, ...stickyAlert } = alert;
  state.keys[key] = { firstAt: s?.firstAt || alert.at, lastSentAt: now, repeats: 0, ...(alert.sticky ? { sticky: stickyAlert } : {}) };
}

function checkBot(outgoing, bot, dedupeMs) {
  const now = Date.now();
  const base = { bot: bot.name, botName: bot.display };

  // 1. 各进程写的告警事件（文件名以时间开头，按顺序处理）
  const alertsDir = path.join(bot.dir, 'data', 'alerts');
  let files = [];
  try { files = fs.readdirSync(alertsDir).filter((f) => f.endsWith('.json')).sort(); } catch {}
  for (const f of files) {
    const p = path.join(alertsDir, f);
    const ev = readJson(p);
    fs.rmSync(p, { force: true });
    if (!ev) continue;
    const meta = EVENTS[ev.kind] || { key: ev.kind, event: true, title: `其他问题（${ev.kind}）` };
    notify(outgoing, `${bot.name}:${meta.key}`, {
      ...base, at: ev.at || now, title: typeof meta.title === 'function' ? meta.title(bot) : meta.title, detail: ev.detail,
      recovery: Boolean(meta.recovery), sticky: Boolean(meta.sticky), event: Boolean(meta.event),
      advice: meta.advice ? meta.advice(bot) : '',
      ...(meta.dedupeMs ? { dedupeMs: meta.dedupeMs } : {}),
    }, meta.dedupeMs || dedupeMs);
  }

  // 2. 3 个 systemd 服务：反复崩溃 / 停了太久 / 恢复
  let schedulerActive;
  for (const role of Object.keys(ROLES)) {
    const unit = unitName(role, bot.name);
    const st = unitStatus(unit);
    if (!st || st.load !== 'loaded') continue;
    // 没启用、也没在运行的服务（比如还没上线的新实例）不管
    if (st.active === 'inactive' && !st.fileState.startsWith('enabled')) continue;
    if (role === 'scheduler') schedulerActive = st.active === 'active';

    const u = (state.units[unit] ||= { samples: [], downSince: 0 });
    const last = u.samples[u.samples.length - 1];
    if (last && st.restarts < last[1]) u.samples = []; // 计数被清零了（手动重启等）
    u.samples.push([now, st.restarts]);
    u.samples = u.samples.filter(([t]) => now - t <= CRASH_WINDOW_MS);
    const restarts = st.restarts - u.samples[0][1];
    u.downSince = st.active === 'active' ? 0 : u.downSince || now;

    const key = `${bot.name}:unit:${role}`;
    const label = `${ROLES[role]}服务（${role}）`;
    if (restarts >= CRASH_RESTARTS) {
      notify(outgoing, key, { ...base, title: `${label}在反复崩溃`, detail: `最近 ${duration(CRASH_WINDOW_MS)}内自动重启了 ${restarts} 次`, advice: logsOf(role, bot) }, dedupeMs);
    } else if (u.downSince && now - u.downSince >= DOWN_AFTER_MS) {
      notify(outgoing, key, { ...base, title: `${label}停了`, detail: `状态 ${st.active}，已经 ${duration(now - u.downSince)}`, advice: `查看状态：systemctl status ${unit} ；要重新启动，在 ${bot.dir} 里执行 ./start.sh` }, dedupeMs);
    } else if (st.active === 'active' && restarts === 0) {
      notify(outgoing, key, { ...base, title: `${label}已恢复正常`, recovery: true }, dedupeMs);
    }
  }

  // 3. 智能体（agy）：登录失效立刻报；其他错误连续 N 次才报；之后有一次调用成功就报"已恢复"
  const agent = agentStatus(bot);
  if (agent) {
    const key = `${bot.name}:agent`;
    if (agent.kind === 'auth') {
      notify(outgoing, key, {
        ...base, title: `${bot.display}的智能体（agy）登录失效了`,
        detail: `${beijingTime(agent.since)} 起，调用 agy 都在等 Google 重新授权：${bot.display}回不了消息，定时消息只能用预设文案`,
        advice: agyLoginAdvice(bot),
      }, dedupeMs);
    } else if (agent.kind === 'failing') {
      notify(outgoing, key, {
        ...base, title: `${bot.display}的智能体（agy）连续 ${agent.streak} 次调用失败`,
        detail: `最近一次：${AGENT_ERROR_KINDS[agent.errorKind] || '出错'}（${agent.error}）`,
        advice: `可能是额度用完、网络或代理断了。${HAS_WARP ? '代理状态：warp-cli --accept-tos status（应显示 Connected）；' : ''}${logsOf('routine', bot)}`,
      }, dedupeMs);
    } else {
      notify(outgoing, key, { ...base, title: `${bot.display}的智能体（agy）恢复正常`, recovery: true }, dedupeMs);
    }
  }

  // 4. 调度器心跳和定时任务漏发
  const sched = readJson(path.join(bot.dir, 'data', 'state', 'scheduler.json'));
  if (!sched?.heartbeat_at) return;
  const hbKey = `${bot.name}:scheduler_heartbeat`;
  const age = now - sched.heartbeat_at;
  if (age <= HEARTBEAT_STALE_MS) {
    notify(outgoing, hbKey, { ...base, title: '调度器恢复心跳', recovery: true }, dedupeMs);
  } else if (schedulerActive !== false && !state.keys[`${bot.name}:unit:scheduler`]) {
    // 服务本身停了或在崩溃时，上面已经按服务报了，这里不重复报
    notify(outgoing, hbKey, { ...base, title: '调度器没有心跳', detail: `已经 ${duration(age)}没有心跳，定时任务和提醒可能都没在跑`, advice: `服务还在但卡住了，可以在 ${bot.dir} 里执行 ./start.sh 重启；${logsOf('scheduler', bot)}` }, dedupeMs);
  }

  const fired = readJson(path.join(bot.dir, 'data', 'scheduler_state.json'))?.last_fired || {};
  const today = beijingParts(now).date;
  for (const task of sched.tasks || []) {
    const due = dueTimeToday(task, now);
    if (due === null) continue;
    const late = now - due;
    if (late < MISSED_AFTER_MS || late > MISSED_WINDOW_MS || fired[task.id] === today) continue;
    const hhmm = `${String(task.hour).padStart(2, '0')}:${String(task.minute).padStart(2, '0')}`;
    notify(outgoing, `${bot.name}:task_missed:${task.id}:${today}`, {
      ...base, event: true, title: '定时任务到点没发', detail: `「${task.name}」（${hhmm}）过了 ${duration(late)}还没发出`,
      advice: logsOf('scheduler', bot),
    }, Number.MAX_SAFE_INTEGER);
  }
}

function collect(outgoing, dedupeMs) {
  const bots = discoverBots();
  for (const bot of bots) {
    try {
      checkBot(outgoing, bot, dedupeMs);
    } catch (err) {
      console.error(`[监控] 检查 ${bot.name} 出错:`, err.message);
    }
  }
  const now = Date.now();
  const names = new Set(bots.map((b) => b.name));
  const today = beijingParts(now).date;
  for (const [key, s] of Object.entries(state.keys)) {
    // 漏发记录只留今天的
    if (key.includes(':task_missed:') && !key.endsWith(today)) delete state.keys[key];
    // 持续性的问题（比如登录过期）没恢复，过了窗口再提醒一次（有的问题自带更长的窗口）
    else if (s.sticky && names.has(key.split(':')[0])) {
      const window = s.sticky.dedupeMs || dedupeMs;
      if (now - s.lastSentAt >= window) notify(outgoing, key, s.sticky, window);
    }
  }
}

function formatAlert(alert, dedupeMs) {
  const tag = alert.test ? '测试' : alert.recovery ? '恢复' : '告警';
  const subject = `【ClawBot ${tag}】${alert.botName}：${alert.title}`;
  const lines = [`实例：${alert.botName}（${alert.bot}）`, `时间：${beijingTime(alert.at)}（北京时间）`];
  if (alert.detail) lines.push(`详情：${alert.detail}`);
  if (alert.recovery && alert.since) lines.push(`问题从 ${beijingTime(alert.since)} 开始，持续了约 ${duration(alert.at - alert.since)}。`);
  if (alert.ongoingSince) lines.push(`这个问题从 ${beijingTime(alert.ongoingSince)} 开始，到现在还没恢复。`);
  if (alert.repeats) lines.push(`上次通知之后又发生了 ${alert.repeats} 次（同类问题 ${duration(dedupeMs)}内只通知一次）。`);
  if (alert.advice) lines.push(`处理：${alert.advice}`);
  return { subject, body: lines.join('\n') };
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${Math.round(ms / 1000)} 秒没有响应`)), ms).unref()),
]);

// 经哪个机器人发：统一管理时是主人的机器人，否则是出问题的这个实例自己（发给它自己的用户）
async function viaWechat(cfg, text, bot) {
  const via = cfg.owner_bot || bot;
  const viaDir = via ? path.join(BOTS_DIR, via) : null;
  const viaConfig = viaDir ? readJson(path.join(viaDir, 'config.json')) : null;
  if (!viaConfig?.bot_token || !viaConfig.authorized_user_id) return { status: 'skipped', text: '微信未配置' };
  const viaName = viaConfig.bot_name || via;
  const userName = cfg.owner_bot ? '主人' : viaConfig.user_nickname || '用户';
  if (state.keys[`${via}:credential`]) return { status: 'skipped', text: `微信跳过（${viaName}自己的登录过期了）` };
  // 用户太久没给这个机器人发消息，微信不让它主动发：用户再发消息之前不走微信
  const viaState = readJson(path.join(viaDir, 'data', 'state', 'forwarder.json')) || {};
  const lastAt = Number(viaState.last_user_message_at) || 0;
  const closedFor = cfg.owner_bot ? state.ownerWindowClosedFor : state.windowClosedFor[via];
  if (state.keys[`${via}:user_window`] || closedFor === lastAt) {
    return { status: 'skipped', text: `微信跳过（${userName}太久没给${viaName}发消息，微信不让它主动发）` };
  }
  try {
    await withTimeout(sendWechatReply(viaConfig.authorized_user_id, viaState.last_context_token, text, viaConfig), SEND_TIMEOUT_MS);
    return { status: 'sent', text: '微信已发' };
  } catch (err) {
    if (/prepare failed/i.test(String(err.message))) {
      if (cfg.owner_bot) state.ownerWindowClosedFor = lastAt;
      else state.windowClosedFor[via] = lastAt;
    }
    return { status: 'failed', text: `微信失败（${String(err.message).slice(0, 150)}）` };
  }
}

function viaEmail(email, subject, body) {
  if (!email?.host || !email?.to) return Promise.resolve({ status: 'skipped', text: '邮件未配置' });
  return new Promise((resolve) => {
    // 授权码只经标准输入传给 send_mail.py，不出现在命令行里
    const child = execFile('python3', ['-I', SEND_MAIL], { timeout: SEND_TIMEOUT_MS * 2 }, (err, stdout, stderr) => {
      if (!err) return resolve({ status: 'sent', text: '邮件已发' });
      const reason = String(stderr || '').trim().split('\n').pop() || err.message;
      resolve({ status: 'failed', text: `邮件失败（${reason.slice(0, 200)}）` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ ...email, subject, body }));
  });
}

async function deliver(alert, cfg, dedupeMs, channels = ['wechat', 'email']) {
  const { subject, body } = formatAlert(alert, dedupeMs);
  const results = [];
  if (channels.includes('wechat')) results.push(await viaWechat(cfg, `${alert.recovery ? '✅' : '⚠️'}${subject}\n${body}`, alert.bot));
  if (channels.includes('email')) results.push(await viaEmail(cfg.email, subject, body));
  console.log(`[告警通知] ${alert.bot}：${alert.title} → ${results.map((r) => r.text).join('，')}`);
  return results;
}

async function tick() {
  const cfg = readJson(CONFIG_FILE) || {};
  const dedupeMs = env('MONITOR_DEDUPE_MS', (Number(cfg.dedupe_hours) || 6) * 3600_000);
  const outgoing = [];
  collect(outgoing, dedupeMs);
  const queue = [...state.retry, ...outgoing.map((alert) => ({ alert, firstTriedAt: Date.now() }))];
  state.retry = queue;
  writeJsonAtomic(STATE_FILE, state);

  const failed = [];
  for (const item of queue) {
    const results = await deliver(item.alert, cfg, dedupeMs);
    if (results.some((r) => r.status === 'sent') || !results.some((r) => r.status === 'failed')) continue;
    if (Date.now() - item.firstTriedAt < RETRY_FOR_MS) failed.push(item);
    else console.error(`[告警通知放弃] ${item.alert.bot}：${item.alert.title}（${duration(RETRY_FOR_MS)}内都没发出去）`);
  }
  state.retry = failed.slice(-50);
  writeJsonAtomic(STATE_FILE, state);
}

async function main() {
  loadState();
  const args = process.argv.slice(2);
  if (args[0] === '--test') {
    const cfg = readJson(CONFIG_FILE) || {};
    const channels = args[1] ? [args[1]] : ['wechat', 'email'];
    const test = { test: true, botName: '告警通道', title: '测试通知', detail: '收到这条说明告警通道是通的，不用处理。', at: Date.now() };
    // 统一管理时发一条给主人；否则每个实例经自己的微信各发一条（邮件只发一封）
    const targets = cfg.owner_bot || !channels.includes('wechat') ? [{ name: 'monitor' }] : discoverBots();
    let ok = targets.length > 0;
    for (const [i, b] of targets.entries()) {
      const results = await deliver({ ...test, bot: b.name, ...(b.display ? { botName: b.display } : {}) }, cfg, 0, i === 0 ? channels : channels.filter((c) => c !== 'email'));
      ok = ok && results.every((r) => r.status === 'sent');
    }
    process.exit(ok ? 0 : 1);
  }

  const cfg = readJson(CONFIG_FILE);
  if (!cfg) console.log(`[监控] 没有告警配置 ${CONFIG_FILE}：只经各实例自己的微信通知，不发邮件`);
  console.log(`[监控已启动] 每 ${Math.round(INTERVAL_MS / 1000)} 秒检查一次；实例：${discoverBots().map((b) => b.name).join('、') || '无'}；`
    + `微信通知：${cfg?.owner_bot ? `经 ${cfg.owner_bot} 发给主人` : '各实例经自己的微信发给自己的用户'}；邮件通知：${cfg?.email?.host ? '已配置' : '未配置'}`);
  const loop = () => tick().catch((err) => console.error('[监控异常]:', err.message)).finally(() => setTimeout(loop, INTERVAL_MS));
  loop();
}

// 只在作为入口运行时启动（经符号链接启动也算），被测试导入时不启动
const isEntry = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) main().catch((err) => { console.error('[监控启动失败]:', err.message); process.exit(1); });
