/**
 * 记忆历史：给机器人的记忆文件（MEMORY.md、data/memory/topics/*.md）存版本、生成"记忆变动"汇报、按条撤销。
 *
 * 每个实例一个 git 库 <历史目录>/<实例>/，里面是记忆文件的副本；线上文件只在撤销、恢复时才会被写回。
 * 两种用法（memoryMode 决定）：
 *   standalone（默认）：每个实例自己管自己。历史存在实例自己的 data/memory-history/，
 *     它的调度器存版本、早间播报附上自己的"记忆变动"，消息处理认「记忆改动」「撤销记忆 N」。
 *   owner + managed（一台机器上由一个主人的机器人统一管）：主人的机器人（/etc/clawbot/alert.json 的 owner_bot，
 *     以 root 运行）把所有实例的历史存在只有 root 能读写的 /var/lib/clawbot/memory-history，
 *     早间播报附上自己的"记忆变动"，「X记忆改动」可以专门看别的实例；沙箱里被代管的实例（managed）
 *     读不到历史，主人的机器人替它把汇报写进它自己的目录，它的早间播报附上（不编号、不能撤销）。
 * 汇报列到哪一版、最近一份清单的编号，记在 <历史目录>/review.json（只记版本号，不记内容）。
 * 日志和提交说明里只有实例名、文件名和条数，不写记忆内容。
 *
 * 命令行：
 *   node memory_history.js log <实例>                       版本列表
 *   node memory_history.js show <实例> <版本>                那一版改了什么
 *   node memory_history.js restore <实例> <版本|YYYY-MM-DD>   把这个实例的记忆整体恢复到那一版（写日期取那天最后一版）
 *   node memory_history.js snapshot [实例]                  马上检查一遍、有变化就存一版
 *   node memory_history.js import-baseline <代码仓库目录>     统一管理时上线用：代码仓库里提交过的版本作起点
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listMemoryFiles, memoryLabel, charCount } from './memory_config.js';
import { writeJsonAtomic } from './wechat_reply.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 告警配置：服务器上统一放 /etc/clawbot/alert.json；没有就用项目目录下的 alert.json
const ALERT_CONFIG = process.env.CLAWBOT_ALERT_CONFIG
  || (fs.existsSync('/etc/clawbot/alert.json') ? '/etc/clawbot/alert.json' : path.join(PROJECT_DIR, 'alert.json'));
const DEFAULT_BOTS_DIR = process.env.CLAWBOT_BOTS_DIR || path.join(PROJECT_DIR, 'bots');
// 改完多久没再动才存一版（智能体可能分几次写同一个文件）
const STABLE_MS = Number(process.env.CLAWBOT_MEMORY_STABLE_MS) || 2 * 60_000;
// 凌晨整理结束后这么久之内存的版本，都算"凌晨整理"改的
const NIGHT_GRACE_MS = STABLE_MS + 3 * 60_000;
const DIGEST_MAX_ITEMS = 5;
const LIST_MAX_CHARS = 1800;
const SHOWN_VALID_MS = 7 * 86400_000;

// 历史放在哪、只管哪个实例：默认是统一管理的位置；独立模式（useStandaloneHistory）改成实例自己的目录、只管它自己
const settings = {
  historyDir: process.env.CLAWBOT_MEMORY_HISTORY_DIR || '/var/lib/clawbot/memory-history',
  only: null,
};
const reviewFile = () => path.join(settings.historyDir, 'review.json');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
};

export function ownerBotName() {
  return readJson(ALERT_CONFIG)?.owner_bot || null;
}

let gitOk = null;
function gitAvailable() {
  if (gitOk === null) {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      gitOk = true;
    } catch {
      gitOk = false;
    }
  }
  return gitOk;
}

/**
 * 这个实例的记忆历史怎么管：
 *   owner      主人的机器人（root，并且是告警配置里的 owner_bot）：管这台机器上所有实例
 *   managed    服务配置里设了 CLAWBOT_MEMORY_MODE=managed：由主人的机器人代管，只附它准备好的汇报
 *   standalone 默认：自己管自己
 *   off        设了 CLAWBOT_MEMORY_MODE=off，或者没装 git：不存记忆历史
 */
export function memoryMode(botRoot) {
  try {
    if (process.getuid?.() === 0 && ownerBotName() === path.basename(botRoot)) return 'owner';
  } catch {}
  const forced = process.env.CLAWBOT_MEMORY_MODE;
  if (forced === 'managed' || forced === 'off') return forced;
  return gitAvailable() ? 'standalone' : 'off';
}

/** 独立模式：历史放在实例自己的 data/memory-history/，只管这一个实例 */
export function useStandaloneHistory(botRoot) {
  settings.historyDir = path.join(botRoot, 'data', 'memory-history');
  settings.only = path.basename(botRoot);
}

// ---------- git ----------
function git(repo, args, { input, allowFail = false, env = {} } = {}) {
  try {
    return execFileSync('git', [
      '-C', repo, '-c', 'core.quotepath=false', '-c', 'user.name=clawbot-memory', '-c', 'user.email=memory@clawbot.local',
      '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args,
    ], {
      encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8', TZ: 'Asia/Shanghai', ...env },
    });
  } catch (err) {
    if (allowFail) return null;
    // git 的报错只有文件名和行号，不含内容
    const last = String(err.stderr || err.message).trim().split('\n').filter(Boolean).pop() || '';
    throw new Error(`git ${args[0]} 失败：${last.slice(0, 200)}`);
  }
}

const repoDir = (bot) => path.join(settings.historyDir, bot);
const head = (repo) => git(repo, ['rev-parse', 'HEAD']).trim();
const rootCommit = (repo) => git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n').pop();
const isCommit = (repo, c) => Boolean(c) && git(repo, ['cat-file', '-e', `${c}^{commit}`], { allowFail: true }) !== null;
const subjectOf = (repo, c) => git(repo, ['show', '-s', '--format=%s', c]).trim();
const commitTime = (repo, c) => Number(git(repo, ['show', '-s', '--format=%ct', c]).trim()) * 1000;

function ensureRepo(bot) {
  const repo = repoDir(bot);
  if (fs.existsSync(path.join(repo, '.git'))) return repo;
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 });
  git(repo, ['init', '-q']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', '记忆历史开始']);
  return repo;
}

// 同一时间只有一个进程动历史库（调度器存版本、消息处理撤销）；用目录当锁，2 分钟没释放就当是进程崩了留下的
function withLock(fn) {
  fs.mkdirSync(settings.historyDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(settings.historyDir, 0o700); } catch {}
  const lock = path.join(settings.historyDir, '.lock');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('记忆历史正被别的进程占用（等了 15 秒）');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function loadReview() {
  return readJson(reviewFile()) || {};
}

function saveReview(state) {
  writeJsonAtomic(reviewFile(), state);
}

// ---------- 实例 ----------
export function discoverBots(botsDir = DEFAULT_BOTS_DIR) {
  let names = [];
  try { names = fs.readdirSync(botsDir); } catch {}
  const owner = ownerBotName();
  return names
    .filter((n) => (!settings.only || n === settings.only) && fs.existsSync(path.join(botsDir, n, 'config.json')))
    .sort((a, b) => (a === owner ? -1 : b === owner ? 1 : a.localeCompare(b)))
    .map((n) => path.join(botsDir, n));
}

const displayName = (botRoot) => readJson(path.join(botRoot, 'config.json'))?.bot_name || path.basename(botRoot);

// ---------- 存版本 ----------
// 把线上的记忆文件同步进历史库的工作区并暂存；返回有没有变化
function syncToRepo(botRoot, repo) {
  const want = new Map();
  for (const f of listMemoryFiles(botRoot)) {
    try { want.set(f.rel, fs.readFileSync(f.abs)); } catch {}
  }
  for (const rel of git(repo, ['ls-files']).split('\n').filter(Boolean)) {
    if (!want.has(rel)) fs.rmSync(path.join(repo, rel), { force: true });
  }
  for (const [rel, buf] of want) {
    const dst = path.join(repo, rel);
    let same = false;
    try { same = fs.readFileSync(dst).equals(buf); } catch {}
    if (!same) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf, { mode: 0o600 });
    }
  }
  git(repo, ['add', '-A']);
  return git(repo, ['status', '--porcelain']).trim() !== '';
}

function recentlyModified(botRoot, now) {
  return listMemoryFiles(botRoot).some((f) => {
    try { return now - fs.statSync(f.abs).mtimeMs < STABLE_MS; } catch { return false; }
  });
}

// 这一版是谁改的：实例自己的调度器在凌晨整理时会写 data/state/memory_consolidation.json
function snapshotSource(botRoot, now) {
  const st = readJson(path.join(botRoot, 'data', 'state', 'memory_consolidation.json')) || {};
  const running = st.running && now - (st.started_at || 0) < 2 * 3600_000;
  if (running || (st.finished_at && now - st.finished_at < NIGHT_GRACE_MS)) return '凌晨整理';
  return '聊天时';
}

function snapshotBot(botRoot, { force = false, source = null, now = Date.now() } = {}) {
  if (!force && recentlyModified(botRoot, now)) return null;
  const repo = ensureRepo(path.basename(botRoot));
  if (!syncToRepo(botRoot, repo)) return null;
  git(repo, ['commit', '-q', '-m', source || snapshotSource(botRoot, now)]);
  return head(repo);
}

function snapshotAllUnlocked(botsDir, opts = {}) {
  const saved = [];
  for (const botRoot of discoverBots(botsDir)) {
    const commit = snapshotBot(botRoot, opts);
    if (commit) saved.push({ bot: path.basename(botRoot), commit });
  }
  return saved;
}

/** 检查所有实例，有变化（并且已经停了一会儿）的存一版。返回 [{ bot, commit }] */
export function snapshotAll({ botsDir = DEFAULT_BOTS_DIR, force = false } = {}) {
  return withLock(() => snapshotAllUnlocked(botsDir, { force }));
}

// ---------- 改动清单 ----------
function parsePatch(patch) {
  const lines = patch.split('\n');
  let i = 0;
  const header = [];
  while (i < lines.length && !lines[i].startsWith('@@')) header.push(lines[i++]);
  const hunks = [];
  let cur = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('@@')) {
      if (cur) hunks.push(cur);
      cur = [l];
    } else if (cur && /^[-+ \\]/.test(l)) {
      cur.push(l);
    }
  }
  if (cur) hunks.push(cur);
  return { header: `${header.join('\n')}\n`, hunks: hunks.map((h) => `${h.join('\n')}\n`) };
}

const filePatch = (repo, from, to, rel) => git(repo, ['diff', '--no-color', '--no-ext-diff', '-U1', from, to, '--', rel]);

function hunkLines(hunk) {
  const body = hunk.split('\n').slice(1);
  return {
    added: body.filter((l) => l.startsWith('+')).map((l) => l.slice(1)),
    removed: body.filter((l) => l.startsWith('-')).map((l) => l.slice(1)),
  };
}

const cleanLine = (line) => String(line).trim()
  .replace(/^(?:[-*+•]|\d+[.)、]|#{1,6})\s+/, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .trim();
const visible = (lines) => lines.map(cleanLine).filter(Boolean);
const clip = (text, n) => {
  const c = [...String(text)];
  return c.length > n ? `${c.slice(0, n).join('')}…` : String(text);
};

/**
 * from..to 之间一个实例的改动，按段（git diff 的 hunk）拆成一条条。只改了空行的段不列。
 * 每条：{ bot, rel, from, to, hunk, label, added, removed, source }（added/removed 只在内存里用，不存盘）
 */
function diffItems(botRoot, from, to) {
  const bot = path.basename(botRoot);
  const repo = repoDir(bot);
  if (from === to) return [];
  const showCache = new Map();
  const contentAt = (c, rel) => {
    const key = `${c}:${rel}`;
    if (!showCache.has(key)) showCache.set(key, (git(repo, ['show', `${c}:${rel}`], { allowFail: true }) ?? '').split('\n'));
    return showCache.get(key);
  };
  const items = [];
  for (const rel of git(repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean)) {
    const { hunks } = parsePatch(filePatch(repo, from, to, rel));
    const commits = git(repo, ['rev-list', '--reverse', `${from}..${to}`, '--', rel]).split('\n').filter(Boolean);
    hunks.forEach((h, i) => {
      const { added, removed } = hunkLines(h);
      if (!visible(added).length && !visible(removed).length) return;
      // 来源：新内容的第一行最早出现在哪一版；纯删除看旧内容的第一行最早消失在哪一版
      const probe = added.find((l) => l.trim());
      const gone = probe === undefined ? removed.find((l) => l.trim()) : undefined;
      const c = commits.find((x) => (probe !== undefined ? contentAt(x, rel).includes(probe) : !contentAt(x, rel).includes(gone)));
      items.push({ bot, rel, from, to, hunk: i, label: memoryLabel(botRoot, rel), added, removed, source: c ? subjectOf(repo, c) : '' });
    });
  }
  return items;
}

function itemParts(item) {
  const add = visible(item.added);
  const del = visible(item.removed);
  if (!del.length) return { kind: '新增', body: clip(add[0], 30), lines: add.length };
  if (!add.length) return { kind: '删除', body: clip(del[0], 30), lines: del.length };
  return { kind: '修改', body: `${clip(del[0], 14)} → ${clip(add[0], 14)}`, lines: Math.max(add.length, del.length) };
}

// 给主人看的一行：编号、类型、文件、来源、内容
function itemLine(item) {
  const { kind, body, lines } = itemParts(item);
  return `${item.n}. ${kind}｜${item.label}${item.source ? `（${item.source}）` : ''}：${body}${lines > 1 ? `（共 ${lines} 行）` : ''}`;
}

// 给被代管实例的用户看的一行：不编号、不写来源
function plainItemLine(item) {
  const { kind, body, lines } = itemParts(item);
  return `• ${kind}｜${item.label}：${body}${lines > 1 ? `（共 ${lines} 行）` : ''}`;
}

function sinceText(ms) {
  if (!ms) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// 第一次见到的实例（还没有汇报起点）：从它的历史里第一次存的那一版算起——已有的记忆不当成"新增"，
// 之后的改动照常汇报（不会因为第一次看得晚，就漏掉这之前存下的改动）。返回 state 有没有改
function initReported(botsDir, state) {
  let changed = false;
  for (const botRoot of discoverBots(botsDir)) {
    const bot = path.basename(botRoot);
    const repo = ensureRepo(bot);
    if (!isCommit(repo, state.reported?.[bot])) {
      const commits = git(repo, ['rev-list', '--reverse', 'HEAD']).trim().split('\n');
      const first = commits[1] || commits[0];
      state.reported = { ...state.reported, [bot]: first };
      state.reported_at = { ...state.reported_at, [bot]: commitTime(repo, first) };
      changed = true;
    }
  }
  return changed;
}

function findBot(botsDir, bot) {
  const botRoot = discoverBots(botsDir).find((b) => path.basename(b) === bot);
  if (!botRoot) throw new Error(`没有实例 ${bot}`);
  return botRoot;
}

/** 按机器人的名字（config.json 的 bot_name）或实例目录名找实例；找不到返回 null */
export function findBotByName(name, { botsDir = DEFAULT_BOTS_DIR } = {}) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const botRoot = discoverBots(botsDir).find((b) => path.basename(b).toLowerCase() === want || displayName(b).toLowerCase() === want);
  return botRoot ? path.basename(botRoot) : null;
}

// 一个实例从 from 到最新一版的改动，编号从 1 开始
function botItems(botRoot, from) {
  const repo = ensureRepo(path.basename(botRoot));
  const to = head(repo);
  const start = isCommit(repo, from) ? from : to;
  const botName = displayName(botRoot);
  const items = diffItems(botRoot, start, to).map((it, i) => ({ ...it, botName, n: i + 1 }));
  return { items, range: { from: start, to } };
}

function overLimitNotes(botRoot) {
  const notes = [];
  for (const f of listMemoryFiles(botRoot)) {
    let n = 0;
    try { n = charCount(fs.readFileSync(f.abs, 'utf-8')); } catch { continue; }
    if (n > f.max) notes.push(`⚠️ ${displayName(botRoot)}的「${f.label}」${n} 字，超过上限 ${f.max} 字，下次凌晨整理时会合并精简。`);
  }
  return notes;
}

// 存进 review.json 的清单只留定位用的字段，不存内容
const storedItem = ({ n, bot, rel, from, to, hunk, label, botName }) => ({ n, bot, rel, from, to, hunk, label, botName });

function recordDelivered(state, bot, range, at) {
  state.reported = { ...state.reported, [bot]: range.to };
  state.reported_at = { ...state.reported_at, [bot]: at };
  state.last_digest = { ...state.last_digest, [bot]: { at, from: range.from, to: range.to } };
}

/**
 * 主人的早间汇报：上一份汇报以来主人自己那个实例的改动（不含其他实例），带编号和撤销说明。没有改动返回 null。
 * 发出去之后要调用 markDigestDelivered(digest)，下一份才会从这里接着列；没发出去就留到下一次一起列。
 */
export function buildDigest({ botsDir = DEFAULT_BOTS_DIR, bot }) {
  return withLock(() => {
    snapshotAllUnlocked(botsDir, { force: true });
    const botRoot = findBot(botsDir, bot);
    const state = loadReview();
    if (initReported(botsDir, state)) saveReview(state);
    const { items, range } = botItems(botRoot, state.reported?.[bot]);
    if (!items.length) return null;
    const since = state.reported_at?.[bot] || commitTime(repoDir(bot), range.from);
    const lines = [`📝 记忆变动（${sinceText(since)} 以来）`, ...items.slice(0, DIGEST_MAX_ITEMS).map(itemLine)];
    if (items.length > DIGEST_MAX_ITEMS) lines.push(`还有 ${items.length - DIGEST_MAX_ITEMS} 条，回「记忆改动」看全部。`);
    lines.push(...overLimitNotes(botRoot));
    lines.push(items.length > DIGEST_MAX_ITEMS
      ? `回「撤销记忆 1」撤销第 1 条，「撤销记忆 全部」撤销全部 ${items.length} 条。`
      : '回「撤销记忆 1」撤销第 1 条，「撤销记忆 全部」全部撤销，「记忆改动」看完整内容。');
    return { bot, text: lines.join('\n'), items: items.map(storedItem), range };
  });
}

export function markDigestDelivered(digest) {
  withLock(() => {
    const state = loadReview();
    recordDelivered(state, digest.bot, digest.range, Date.now());
    // 主人的「撤销记忆 N」按这份汇报的编号
    state.shown = { at: Date.now(), items: digest.items };
    saveReview(state);
  });
}

/**
 * 「记忆改动」「X记忆改动」：一个实例从最近一份早间汇报的起点到现在的全部改动（含汇报之后新的改动），
 * 带编号，主人接着回「撤销记忆 N」就按这份的编号撤。
 */
export function showChanges({ botsDir = DEFAULT_BOTS_DIR, bot }) {
  return withLock(() => {
    snapshotAllUnlocked(botsDir, { force: true });
    const botRoot = findBot(botsDir, bot);
    const state = loadReview();
    initReported(botsDir, state);
    const last = state.last_digest?.[bot];
    const { items, range } = botItems(botRoot, last?.from || state.reported?.[bot]);
    state.shown = { at: Date.now(), items: items.map(storedItem) };
    saveReview(state);
    const whose = bot === ownerBotName() || bot === settings.only ? '' : `${displayName(botRoot)}的`;
    if (!items.length) return `最近一份汇报以来，${whose}记忆没有变化（或者改动都已经撤销了）。`;
    const since = last?.from ? last.at : state.reported_at?.[bot] || commitTime(repoDir(bot), range.from);
    const out = [`📝 ${whose}记忆改动（${sinceText(since)} 以来，共 ${items.length} 条）`];
    let used = out[0].length;
    let shortFrom = null;
    for (const it of items) {
      const detail = [
        ...visible(it.removed).map((l) => `   － ${clip(l, 60)}`),
        ...visible(it.added).map((l) => `   ＋ ${clip(l, 60)}`),
      ];
      const block = [itemLine(it).replace(/：.*$/, ''), ...detail.slice(0, 4)];
      if (detail.length > 4) block.push(`   …（共 ${detail.length} 行）`);
      const text = block.join('\n');
      if (used + text.length > LIST_MAX_CHARS) {
        shortFrom = it.n;
        break;
      }
      out.push(text);
      used += text.length + 1;
    }
    if (shortFrom) {
      // 放不下了：后面的只列一行摘要
      for (const it of items.slice(shortFrom - 1)) {
        const line = itemLine(it);
        if (used + line.length > LIST_MAX_CHARS + 600) {
          out.push(`……后面还有 ${items.length - it.n + 1} 条没列出来，「撤销记忆 全部」也会撤销它们。`);
          break;
        }
        out.push(line);
        used += line.length + 1;
      }
    }
    out.push(...overLimitNotes(botRoot));
    out.push('回「撤销记忆 编号」撤销（可以写多个，比如「撤销记忆 1 3」），「撤销记忆 全部」全部撤销。编号以这份清单为准。');
    return out.join('\n');
  });
}

// ---------- 沙箱实例的早间汇报 ----------
// 沙箱里被代管的实例读不到记忆历史：主人的机器人把它还没汇报过的改动整理成一段文字，放进它自己的
// data/state/memory_digest.json（归它自己的账号）；它的早间播报附上这段，发出去后写 memory_digest_ack.json
const pendingFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest.json');
const ackFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest_ack.json');

function plainDigestText(items, since, botName) {
  const lines = [`📝 记忆变动（${sinceText(since)} 以来）`, ...items.slice(0, DIGEST_MAX_ITEMS).map(plainItemLine)];
  if (items.length > DIGEST_MAX_ITEMS) lines.push(`另外还有 ${items.length - DIGEST_MAX_ITEMS} 条小改动，就不一一列了。`);
  lines.push(`哪里记得不对，直接告诉${botName}是哪件事就行～`);
  return lines.join('\n');
}

// 写进实例自己的目录：先写临时文件、改成实例账号所有，再改名，对方永远读不到写了一半的内容
function writeJsonForBot(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const st = fs.statSync(dir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chownSync(tmp, st.uid, st.gid);
  fs.renameSync(tmp, file);
}

/**
 * 主人的机器人每次检查完调用：先看各沙箱实例有没有发出汇报的回执，对上号就把它的汇报进度推到那一版；
 * 再把它现在还没汇报过的改动写成待发的汇报（没有改动就删掉那个文件）。
 */
export function syncBotDigests({ botsDir = DEFAULT_BOTS_DIR } = {}) {
  return withLock(() => {
    const owner = ownerBotName();
    const state = loadReview();
    let dirty = initReported(botsDir, state);
    for (const botRoot of discoverBots(botsDir)) {
      const bot = path.basename(botRoot);
      if (bot === owner) continue;
      const pending = state.pending?.[bot] || {};
      const ack = readJson(ackFile(botRoot));
      if (ack?.id && pending[ack.id] && state.acked?.[bot] !== ack.id) {
        recordDelivered(state, bot, pending[ack.id], Number(ack.delivered_at) || Date.now());
        state.acked = { ...state.acked, [bot]: ack.id };
        state.pending = { ...state.pending, [bot]: {} };
        dirty = true;
      }
      const file = pendingFile(botRoot);
      const repo = ensureRepo(bot);
      const to = head(repo);
      const from = state.reported[bot];
      const current = readJson(file);
      const id = `${from.slice(0, 10)}-${to.slice(0, 10)}`;
      if (current?.id === id) continue;
      const { items } = from === to ? { items: [] } : botItems(botRoot, from);
      if (!items.length) {
        if (current) fs.rmSync(file, { force: true });
        continue;
      }
      const since = state.reported_at?.[bot] || commitTime(repo, from);
      writeJsonForBot(file, { id, at: Date.now(), count: items.length, text: plainDigestText(items, since, displayName(botRoot)) });
      // 只留最近几份的范围：回执可能对应稍早写的那一份
      const ids = Object.entries({ ...(state.pending?.[bot] || {}), [id]: { from, to } }).slice(-5);
      state.pending = { ...state.pending, [bot]: Object.fromEntries(ids) };
      dirty = true;
    }
    if (dirty) saveReview(state);
  });
}

// ---------- 撤销 ----------
// 把历史库工作区里的文件写回线上，保留线上文件原来的属主和权限（沙箱实例的文件属于它自己的账号）
function writeBack(botRoot, repo, rel) {
  const src = path.join(repo, rel);
  const dst = path.join(botRoot, rel);
  if (!fs.existsSync(src)) {
    fs.rmSync(dst, { force: true });
    return;
  }
  let st = null;
  try { st = fs.statSync(dst); } catch {}
  const dir = path.dirname(dst);
  if (!fs.existsSync(dir)) {
    const rootSt = fs.statSync(botRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.chownSync(dir, rootSt.uid, rootSt.gid);
  }
  const dirSt = fs.statSync(dir);
  const uid = st ? st.uid : dirSt.uid;
  const gid = st ? st.gid : dirSt.gid;
  const mode = st ? st.mode & 0o7777 : dirSt.mode & 0o666;
  const tmp = `${dst}.${process.pid}.${Date.now()}.undo.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(src));
  fs.chmodSync(tmp, mode);
  fs.chownSync(tmp, uid, gid);
  fs.renameSync(tmp, dst);
}

/**
 * 撤销最近一份清单里的几条（selection 是编号数组，或 'all'）。返回给主人的回复。
 * 先把线上现状存一版；每条按"反向打补丁"撤销，那一段后来又被改过就不硬改，告诉主人。
 */
export function undoItems(selection, { botsDir = DEFAULT_BOTS_DIR } = {}) {
  return withLock(() => {
    const state = loadReview();
    const shown = state.shown;
    if (!shown?.items?.length || Date.now() - shown.at > SHOWN_VALID_MS) {
      return '现在没有可以撤销的清单。回「记忆改动」看看最近的改动。';
    }
    const picked = selection === 'all'
      ? shown.items.filter((i) => !i.undone)
      : selection.map((n) => shown.items.find((i) => i.n === n) || { n, missing: true });
    const missing = picked.filter((i) => i.missing).map((i) => i.n);
    const already = picked.filter((i) => i.undone).map((i) => i.n);
    const todo = picked.filter((i) => !i.missing && !i.undone);
    const done = [];
    const failed = [];
    if (todo.length) {
      snapshotAllUnlocked(botsDir, { force: true });
      // 同一个文件从后往前撤，前面那些段的行号不受影响
      const order = [...todo].sort((a, b) => a.bot.localeCompare(b.bot) || a.rel.localeCompare(b.rel) || b.hunk - a.hunk);
      const touched = new Map();
      for (const it of order) {
        const repo = repoDir(it.bot);
        let patch = null;
        if (isCommit(repo, it.from) && isCommit(repo, it.to)) {
          const { header, hunks } = parsePatch(filePatch(repo, it.from, it.to, it.rel));
          if (hunks[it.hunk]) patch = header + hunks[it.hunk];
        }
        if (!patch || git(repo, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch, allowFail: true }) === null) {
          failed.push(it);
          continue;
        }
        done.push(it);
        if (!touched.has(it.bot)) touched.set(it.bot, new Set());
        touched.get(it.bot).add(it.rel);
      }
      for (const [bot, rels] of touched) {
        const botRoot = path.join(botsDir, bot);
        const repo = repoDir(bot);
        for (const rel of rels) writeBack(botRoot, repo, rel);
        git(repo, ['add', '-A']);
        const nums = done.filter((d) => d.bot === bot).map((d) => d.n).sort((a, b) => a - b);
        git(repo, ['commit', '-q', '-m', '撤销', '-m', `撤销清单第 ${nums.join('、')} 条`]);
      }
      for (const it of shown.items) if (done.some((d) => d.n === it.n)) it.undone = true;
      saveReview(state);
    }
    const parts = [];
    if (done.length === 1) parts.push(`已撤销第 ${done[0].n} 条（${done[0].botName}的「${done[0].label}」）。`);
    else if (done.length > 1) parts.push(`已撤销 ${done.length} 条：第 ${done.map((d) => d.n).sort((a, b) => a - b).join('、')} 条。`);
    if (failed.length) parts.push(`第 ${failed.map((d) => d.n).sort((a, b) => a - b).join('、')} 条没有撤销：那段内容后来又改过，自动撤销可能改错。回「记忆改动」看最新的清单再撤。`);
    if (already.length) parts.push(`第 ${already.join('、')} 条之前已经撤销过了。`);
    if (missing.length) parts.push(`清单里没有第 ${missing.join('、')} 条（这份清单一共 ${shown.items.length} 条）。`);
    if (!parts.length) parts.push('这份清单里的改动都已经撤销过了。');
    return parts.join('\n');
  });
}

/**
 * 主人发来的记忆命令，不是就返回 null：
 *   「记忆改动」→ { type: 'show' }；「X记忆改动」「X的记忆改动」「记忆改动 X」→ { type: 'show', name: 'X' }
 *   「撤销记忆 2」「撤销记忆 1 3」→ { type: 'undo', items: [2] / [1, 3] }；「撤销记忆 全部」→ { type: 'undo', items: 'all' }
 * 带名字的由调用方确认真有这个机器人（findBotByName），没有就当普通消息交给智能体。
 */
export function parseMemoryCommand(text) {
  const t = String(text || '').trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  let m = t.match(/^(?:(.{1,12}?)的?)?记忆(?:改动|变动)$/);
  if (m) return m[1] ? { type: 'show', name: m[1] } : { type: 'show' };
  m = t.match(/^记忆(?:改动|变动)\s+(.{1,12})$/);
  if (m) return { type: 'show', name: m[1].trim() };
  m = t.match(/^撤销记忆\s*(全部|所有|\d+(?:\s*[,，、\s]\s*\d+)*)$/);
  if (!m) return null;
  if (/^(全部|所有)$/.test(m[1])) return { type: 'undo', items: 'all' };
  return { type: 'undo', items: [...new Set(m[1].split(/\D+/).filter(Boolean).map(Number))] };
}

// ---------- 上线 / 命令行 ----------
/**
 * 上线时用：代码仓库里最后提交的那版记忆文件作为起点，线上现在的文件存为"上线前"；
 * 第一份早间汇报从起点开始列，这几天攒下没人看过的改动可以一次看完。已经有历史库的实例跳过。
 */
export function importBaseline(codeRepo, { botsDir = DEFAULT_BOTS_DIR } = {}) {
  return withLock(() => {
    const state = loadReview();
    const report = [];
    for (const botRoot of discoverBots(botsDir)) {
      const bot = path.basename(botRoot);
      if (fs.existsSync(path.join(repoDir(bot), '.git'))) {
        report.push(`${bot}: 已经有历史库，跳过`);
        continue;
      }
      const repo = ensureRepo(bot);
      const prefix = path.relative(codeRepo, botRoot).split(path.sep).join('/');
      const tracked = git(codeRepo, ['ls-files', '--', `${prefix}/MEMORY.md`, `${prefix}/data/memory/topics`]).split('\n').filter(Boolean);
      for (const p of tracked) {
        const dst = path.join(repo, path.posix.relative(prefix, p));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, git(codeRepo, ['show', `HEAD:${p}`]), { mode: 0o600 });
      }
      const date = tracked.length ? git(codeRepo, ['log', '-1', '--format=%cI', '--', ...tracked]).trim() : '';
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '--allow-empty', '-m', '代码仓库里的版本'], { env: date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {} });
      const base = head(repo);
      const changed = syncToRepo(botRoot, repo);
      if (changed) git(repo, ['commit', '-q', '-m', '上线前']);
      state.reported = { ...state.reported, [bot]: base };
      state.reported_at = { ...state.reported_at, [bot]: date ? Date.parse(date) : Date.now() };
      const stat = changed ? git(repo, ['diff', '--shortstat', base, 'HEAD']).trim() : '没有差别';
      report.push(`${bot}: 起点 = 代码仓库里 ${date || '（没有提交过）'} 的版本；上线前的改动：${stat}`);
    }
    saveReview(state);
    return report;
  });
}

function resolveRev(repo, rev) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(rev)) {
    const c = git(repo, ['rev-list', '-1', `--before=${rev} 23:59:59 +0800`, 'HEAD']).trim();
    if (!c) throw new Error(`${rev} 之前没有版本`);
    return c;
  }
  const c = git(repo, ['rev-parse', '--verify', `${rev}^{commit}`], { allowFail: true });
  if (!c) throw new Error(`找不到版本 ${rev}`);
  return c.trim();
}

/** 把一个实例的记忆整体恢复到某一版（先存一版现状，恢复本身也存一版，随时能再恢复回来） */
export function restoreBot(bot, rev, { botsDir = DEFAULT_BOTS_DIR } = {}) {
  return withLock(() => {
    const botRoot = path.join(botsDir, bot);
    if (!fs.existsSync(path.join(botRoot, 'config.json'))) throw new Error(`没有实例 ${bot}`);
    snapshotBot(botRoot, { force: true });
    const repo = repoDir(bot);
    const target = resolveRev(repo, rev);
    const now = git(repo, ['ls-files']).split('\n').filter(Boolean);
    const then = git(repo, ['ls-tree', '-r', '--name-only', target]).split('\n').filter(Boolean);
    for (const rel of now) if (!then.includes(rel)) fs.rmSync(path.join(repo, rel), { force: true });
    if (then.length) git(repo, ['checkout', target, '--', ...then]);
    for (const rel of new Set([...now, ...then])) writeBack(botRoot, repo, rel);
    git(repo, ['add', '-A']);
    if (git(repo, ['status', '--porcelain']).trim()) {
      git(repo, ['commit', '-q', '-m', '手动恢复', '-m', `恢复到 ${target.slice(0, 7)}`]);
      return `已把 ${bot} 的记忆恢复到 ${target.slice(0, 7)}（${sinceText(commitTime(repo, target))} 的版本）`;
    }
    return `${bot} 的记忆和 ${target.slice(0, 7)} 一样，不用恢复`;
  });
}

function main(argv) {
  const [cmd, a, b] = argv;
  // 指定的实例自己管历史（独立模式，历史在它自己的 data/memory-history/ 里）：就用那里的
  if (a && cmd !== 'import-baseline' && !process.env.CLAWBOT_MEMORY_HISTORY_DIR) {
    const botRoot = path.join(DEFAULT_BOTS_DIR, a);
    if (fs.existsSync(path.join(botRoot, 'data', 'memory-history', a, '.git'))) useStandaloneHistory(botRoot);
  }
  const repo = a ? repoDir(a) : null;
  if (cmd === 'log' && a) {
    process.stdout.write(git(repo, ['log', '--date=format-local:%Y-%m-%d %H:%M', '--format=%h  %ad  %s', '--shortstat']));
  } else if (cmd === 'show' && a && b) {
    process.stdout.write(git(repo, ['show', '--date=format-local:%Y-%m-%d %H:%M', resolveRev(repo, b)]));
  } else if (cmd === 'restore' && a && b) {
    console.log(restoreBot(a, b));
  } else if (cmd === 'snapshot') {
    const saved = snapshotAll({ force: true });
    console.log(saved.length ? saved.map((s) => `${s.bot}: 存了一版 ${s.commit.slice(0, 7)}`).join('\n') : '没有变化');
  } else if (cmd === 'import-baseline' && a) {
    console.log(importBaseline(path.resolve(a)).join('\n'));
  } else {
    console.log('用法：node memory_history.js log <实例> | show <实例> <版本> | restore <实例> <版本|YYYY-MM-DD> | snapshot | import-baseline <代码仓库目录>');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
