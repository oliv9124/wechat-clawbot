/**
 * 版本记录：给机器人目录里的记忆（MEMORY.md、data/memory/）和设置（tasks.js、topics.json、profile.json、
 * .agents/ 里自己的技能和规则、scripts/）存版本，生成早间的"改动"汇报，按条撤销。
 *
 * 每个实例一个 git 库 <历史目录>/<实例>/，里面是这些文件的副本；线上文件只在撤销、恢复时才会被写回。
 * 用法（memoryMode 决定）：
 *   managed：由管理服务（core/manager.js，clawbot-manager.service，root）统一管。历史在只有 root 能读写的
 *     /var/lib/clawbot/memory-history；管理服务替每个实例把待发的汇报写进它自己的目录，处理它转来的管理指令，
 *     直接经它的微信回复。管理员（告警配置里 owner_bot 那个实例的用户）还能看、能撤销别的实例的改动。
 *   standalone（默认）：每个实例自己管自己。历史存在实例自己的 data/memory-history/，
 *     它的调度器存版本、早间播报附上自己的"改动"，消息处理认「记忆改动」「撤销 N」。
 *   owner：旧的统一管理方式（主人的机器人以 root 运行，在自己的进程里管所有实例），已由管理服务取代，只为兼容保留。
 * 汇报列到哪一版、每个人最近一份清单的编号，记在 <历史目录>/review.json（只记版本号，不记内容）。
 * 日志和提交说明里只有实例名、文件名和条数，不写内容。以 root 读写机器人目录时不跟着软链接走（见 insideBot）。
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
import { listMemoryFiles, memoryLabel, memoryKind, charCount, normalizeLine, DATE_TAG, LIBRARY_DIR, TOPICS_DIR } from './memory_config.js';
import { writeJsonAtomic, loadBotSettings } from './wechat_reply.js';

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
 * 这个实例的版本记录怎么管：
 *   managed    服务配置里设了 CLAWBOT_MEMORY_MODE=managed（服务模板里都设了）：由管理服务统一管，
 *              早间播报附上它准备好的汇报，管理指令转给它处理
 *   standalone 默认：自己管自己
 *   owner      旧的统一管理方式：主人的机器人以 root 运行、又没写明模式时，在自己的进程里管所有实例（只为兼容保留）
 *   off        设了 CLAWBOT_MEMORY_MODE=off，或者没装 git：不存版本
 */
export function memoryMode(botRoot) {
  const forced = process.env.CLAWBOT_MEMORY_MODE;
  if (forced === 'managed' || forced === 'off') return forced;
  try {
    if (process.getuid?.() === 0 && ownerBotName() === path.basename(botRoot)) return 'owner';
  } catch {}
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

const displayName = (botRoot) => loadBotSettings(botRoot).bot_name || path.basename(botRoot);


// ---------- 以 root 读写机器人目录 ----------
// 不跟着软链接走：不然沙箱里的机器人放一个指向 /etc/shadow 或别的机器人目录的链接，就能借 root 替它读出来、写进去。
// 路径上每一段都得是这个目录里真实的文件夹（还不存在的会新建，也是真实的），最后一段读的时候不能是软链接
export function insideBot(botRoot, abs) {
  const rel = path.relative(botRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = botRoot;
  for (const part of rel.split(path.sep).slice(0, -1)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return true; }
    if (!st.isDirectory()) return false;
  }
  try {
    const rootReal = fs.realpathSync(botRoot);
    const parent = fs.realpathSync(path.dirname(abs));
    return parent === rootReal || parent.startsWith(rootReal + path.sep);
  } catch {
    return true;
  }
}

export function readBotFile(botRoot, abs) {
  if (!insideBot(botRoot, abs)) throw new Error('路径经过软链接，不读');
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

// ---------- 设置文件 ----------
// 除了记忆，机器人目录里它自己的设置也存版本：定时任务、专题设置、称呼和人设、自己的技能和规则（.agents/）、脚本（scripts/）。
// .venv、下载、日志、运行状态不存；超过 200KB 或者不是文本的文件不存；软链接（比如装上的官方技能）只记它指向哪里
const SETTING_FILES = ['tasks.js', 'topics.json', 'profile.json'];
const SETTING_DIRS = ['.agents', 'scripts'];
const SKIP_DIRS = new Set(['.venv', 'venv', 'node_modules', '__pycache__', '.git', '.cache']);
const SETTING_MAX_BYTES = 200 * 1024;
const SETTING_MAX_FILES = 500;
const isMemoryRel = (rel) => rel === 'MEMORY.md' || rel.startsWith('data/memory/');

/** 要存版本的设置文件：[{ rel, abs, buf }]，软链接是 [{ rel, abs, link }] */
export function listSettingFiles(botRoot) {
  const out = [];
  const add = (rel) => {
    if (out.length >= SETTING_MAX_FILES) return;
    const abs = path.join(botRoot, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) {
      try { out.push({ rel, abs, link: fs.readlinkSync(abs) }); } catch {}
      return;
    }
    if (!st.isFile() || st.size > SETTING_MAX_BYTES) return;
    let buf;
    try { buf = readBotFile(botRoot, abs); } catch { return; }
    if (!buf.subarray(0, 8192).includes(0)) out.push({ rel, abs, buf });
  };
  for (const f of SETTING_FILES) add(f);
  const walk = (relDir) => {
    const abs = path.join(botRoot, relDir);
    try { if (!fs.lstatSync(abs).isDirectory()) return; } catch { return; }
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else {
        add(rel);
      }
    }
  };
  for (const d of SETTING_DIRS) walk(d);
  return out;
}

// 设置开始存版本时（第一次见到这个实例、或者刚升级到会存设置的版本）打上标签 settings-base：
// 汇报和清单只列这之后的设置改动，已有的设置不当成"新增"
const SETTINGS_BASE = 'settings-base';
const settingsBase = (repo) => git(repo, ['rev-parse', '--verify', '-q', `refs/tags/${SETTINGS_BASE}^{commit}`], { allowFail: true })?.trim() || null;
const isAncestor = (repo, a, b) => git(repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true }) !== null;

// 已经有记忆历史、还没有"设置的起点"的（升级上来的）：现有的设置单独存一版"设置的起点"。
// 新实例不在这里：它的第一版记忆和设置一起存，就从那一版算起（见 snapshotBot）
function ensureSettingsBase(botRoot, repo) {
  if (settingsBase(repo)) return;
  if (syncToRepo(botRoot, repo, { only: 'settings' })) git(repo, ['commit', '-q', '-m', '设置的起点']);
  git(repo, ['tag', SETTINGS_BASE]);
}

// 刚改过（2 分钟内）的设置文件这一轮先不存，等它停下来：智能体可能分几次写同一个文件
const settingTooFresh = (botRoot, rel, now) => {
  try { return now - fs.lstatSync(path.join(botRoot, rel)).mtimeMs < STABLE_MS; } catch { return false; }
};

// ---------- 存版本 ----------
// 把线上的记忆和设置文件同步进历史库的工作区并暂存；返回有没有变化。only：只同步 'memory' 或 'settings' 这一类，另一类原样不动；
// skip(rel) 为真的设置文件这一轮原样不动（刚改过、还没停下来）
function syncToRepo(botRoot, repo, { only = null, skip = null } = {}) {
  const want = new Map();
  // 读不出来（权限不对、变成了软链接、目录列不出来）不等于删掉了：这些文件历史里保留上一版，不记成删除
  const keep = new Set();
  const repoFiles = git(repo, ['ls-files']).split('\n').filter(Boolean);
  if (only !== 'settings') {
    for (const f of listMemoryFiles(botRoot)) {
      try {
        want.set(f.rel, { buf: readBotFile(botRoot, f.abs) });
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        keep.add(f.rel);
        console.warn(`[记忆历史] ${path.basename(botRoot)} 的 ${f.rel} 读不出来（${e.code || e.message}），这一版保留上次的内容`);
      }
    }
    for (const dir of ['data/memory', TOPICS_DIR, 'data/memory/timeline', LIBRARY_DIR]) {
      try {
        fs.readdirSync(path.join(botRoot, dir));
      } catch (e) {
        if (e.code === 'ENOENT') continue;
        for (const rel of repoFiles) if (rel.startsWith(`${dir}/`)) keep.add(rel);
        console.warn(`[记忆历史] ${path.basename(botRoot)} 的 ${dir}/ 列不出来（${e.code || e.message}），里面的文件这一版保留上次的内容`);
      }
    }
  }
  if (only !== 'memory') {
    for (const f of listSettingFiles(botRoot)) {
      if (!skip?.(f.rel)) want.set(f.rel, f.link !== undefined ? { link: f.link } : { buf: f.buf });
    }
  }
  const untouched = (rel) => (only === 'memory' && !isMemoryRel(rel)) || (only === 'settings' && isMemoryRel(rel))
    || (!isMemoryRel(rel) && Boolean(skip?.(rel)));
  for (const rel of repoFiles) {
    if (!want.has(rel) && !untouched(rel) && !keep.has(rel)) fs.rmSync(path.join(repo, rel), { force: true });
  }
  const repoReal = fs.realpathSync(repo);
  for (const [rel, f] of want) {
    const dst = path.join(repo, rel);
    let same = false;
    try {
      const st = fs.lstatSync(dst);
      same = f.link !== undefined ? st.isSymbolicLink() && fs.readlinkSync(dst) === f.link : st.isFile() && fs.readFileSync(dst).equals(f.buf);
    } catch {}
    if (same) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const parent = fs.realpathSync(path.dirname(dst));
    if (parent !== repoReal && !parent.startsWith(repoReal + path.sep)) continue;
    fs.rmSync(dst, { force: true, recursive: true });
    if (f.link !== undefined) fs.symlinkSync(f.link, dst);
    else fs.writeFileSync(dst, f.buf, { mode: 0o600 });
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
  // 管理员做一次性迁移（memory_slim.js apply）时写 data/state/memory_migration.json：那之后半小时内存的版本算"一次性搬家"
  // （机器人正在聊天、文件一直在动时，要等文件停下 2 分钟才存，可能晚好几分钟）
  const mig = readJson(path.join(botRoot, 'data', 'state', 'memory_migration.json')) || {};
  if (mig.at && now - mig.at < 30 * 60_000) return '一次性搬家';
  const st = readJson(path.join(botRoot, 'data', 'state', 'memory_consolidation.json')) || {};
  const running = st.running && now - (st.started_at || 0) < 2 * 3600_000;
  if (running || (st.finished_at && now - st.finished_at < NIGHT_GRACE_MS)) return '凌晨整理';
  return '聊天时';
}

function snapshotBot(botRoot, { force = false, source = null, now = Date.now() } = {}) {
  if (!force && recentlyModified(botRoot, now)) return null;
  const repo = ensureRepo(path.basename(botRoot));
  // 新实例：第一版连同现有的设置一起存，打上"设置的起点"；升级上来的：先把现有的设置单独存一版
  const fresh = !settingsBase(repo) && git(repo, ['rev-list', '--count', 'HEAD']).trim() === '1';
  if (!fresh) ensureSettingsBase(botRoot, repo);
  const skip = force || fresh ? null : (rel) => settingTooFresh(botRoot, rel, now);
  const changed = syncToRepo(botRoot, repo, { skip });
  if (changed) git(repo, ['commit', '-q', '-m', source || snapshotSource(botRoot, now)]);
  if (fresh) git(repo, ['tag', SETTINGS_BASE]);
  return changed ? head(repo) : null;
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

// 汇报里显示的一行：去掉列表符号、标题符号、加粗、行内代码记号和末尾的日期标记〔11-05〕
const cleanLine = (line) => String(line).replace(DATE_TAG, '').trim()
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
  // 腾地方时条目搬到了哪：to 那一版的资料库（核心档案的条目还可能搬进专题）
  let destLines = null;
  const destination = () => {
    if (destLines === null) {
      const files = git(repo, ['ls-tree', '-r', '--name-only', to, '--', LIBRARY_DIR, TOPICS_DIR]).split('\n').filter(Boolean);
      destLines = new Set(files.flatMap((f) => (git(repo, ['show', `${to}:${f}`], { allowFail: true }) ?? '').split('\n').map(normalizeLine)));
    }
    return destLines;
  };
  const items = [];
  for (const rel of git(repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean)) {
    if (!isMemoryRel(rel)) continue;
    const { hunks } = parsePatch(filePatch(repo, from, to, rel));
    const commits = git(repo, ['rev-list', '--reverse', `${from}..${to}`, '--', rel]).split('\n').filter(Boolean);
    const kind = memoryKind(rel);
    if (kind === 'library' || kind === 'timeline') {
      // 资料库、大事记按文件算一条（只往里加，逐段列太碎）；撤销时整个文件退回改之前
      const all = hunks.map(hunkLines);
      const added = all.flatMap((h) => h.added);
      const removed = all.flatMap((h) => h.removed);
      if (!visible(added).length && !visible(removed).length) continue;
      const existed = git(repo, ['cat-file', '-e', `${from}:${rel}`], { allowFail: true }) !== null;
      const last = commits[commits.length - 1];
      items.push({ bot, rel, from, to, hunk: -1, label: memoryLabel(botRoot, rel), added, removed, source: last ? subjectOf(repo, last) : '', kind: 'file', files: [rel], created: !existed });
      continue;
    }
    hunks.forEach((h, i) => {
      const { added, removed } = hunkLines(h);
      // 去掉日期标记〔11-05〕后两边都有的行不算改动；只改了日期或空白的段不列
      const rest = (a, b) => {
        const pool = [...b];
        return a.filter((l) => {
          const i = pool.indexOf(l);
          if (i < 0) return true;
          pool.splice(i, 1);
          return false;
        });
      };
      const addOnly = rest(visible(added), visible(removed));
      const delOnly = rest(visible(removed), visible(added));
      if (!addOnly.length && !delOnly.length) return;
      // 来源：新内容的第一行最早出现在哪一版；纯删除看旧内容的第一行最早消失在哪一版
      const probe = added.find((l) => l.trim());
      const gone = probe === undefined ? removed.find((l) => l.trim()) : undefined;
      const c = commits.find((x) => (probe !== undefined ? contentAt(x, rel).includes(probe) : !contentAt(x, rel).includes(gone)));
      // 删掉的每一行都原样出现在资料库（或专题）里、最多只加了一句结论：这是"搬走"，不是删除
      const moved = delOnly.length > 0 && addOnly.length <= 1
        && removed.filter((l) => !/^\s*#/.test(l) && delOnly.includes(cleanLine(l))).every((l) => destination().has(normalizeLine(l)));
      items.push({ bot, rel, from, to, hunk: i, label: memoryLabel(botRoot, rel), added, removed, source: c ? subjectOf(repo, c) : '', moved, movedLines: moved ? delOnly : null, keptSummary: moved && addOnly.length > 0 });
    });
  }
  return [...items, ...settingItems(botRoot, from, to)];
}

// ---------- 设置的改动 ----------
// 设置按"项"汇报：自己的一个技能（.agents/skills/<名字>/ 下的全部文件）、scripts/ 下的一个文件或文件夹各算一项，其他每个文件各算一项
const settingGroup = (rel) => rel.match(/^(\.agents\/skills\/[^/]+|scripts\/[^/]+)/)?.[1] || rel;

function settingLabel(group) {
  const fixed = { 'tasks.js': '定时任务', 'topics.json': '专题设置', 'profile.json': '称呼和人设', '.agents/skills.json': '技能设置' };
  if (fixed[group]) return fixed[group];
  let m = group.match(/^\.agents\/skills\/(.+)$/);
  if (m) return `技能 ${m[1]}`;
  m = group.match(/^\.agents\/rules\/(.+?)(?:\.md)?$/);
  if (m) return `规则 ${m[1]}`;
  m = group.match(/^scripts\/(.+)$/);
  return m ? `脚本 ${m[1]}` : group;
}

const treeMode = (repo, c, rel) => (git(repo, ['ls-tree', c, '--', rel], { allowFail: true }) || '').split(/\s/)[0] || null;

/**
 * from..to 之间设置的改动，一项一条：{ kind: 'setting', bot, rel（这一项的路径）, files, from, to, label, change, added, removed, link, source }。
 * "设置的起点"之前的不算：起点更早就从"设置的起点"开始比
 */
function settingItems(botRoot, from, to) {
  const bot = path.basename(botRoot);
  const repo = repoDir(bot);
  const base = settingsBase(repo);
  if (!base || !isCommit(repo, from)) return [];
  const start = isAncestor(repo, from, base) ? base : from;
  if (start === to) return [];
  const groups = new Map();
  for (const line of git(repo, ['diff', '--no-renames', '--name-status', start, to]).split('\n').filter(Boolean)) {
    const [status, rel] = line.split('\t');
    if (!rel || isMemoryRel(rel)) continue;
    const key = settingGroup(rel);
    if (!groups.has(key)) groups.set(key, { files: [], statuses: new Set(), added: 0, removed: 0 });
    groups.get(key).files.push(rel);
    groups.get(key).statuses.add(status[0]);
  }
  for (const line of git(repo, ['diff', '--no-renames', '--numstat', start, to]).split('\n').filter(Boolean)) {
    const [a, d, rel] = line.split('\t');
    const g = rel && !isMemoryRel(rel) ? groups.get(settingGroup(rel)) : null;
    if (g) {
      g.added += Number(a) || 0;
      g.removed += Number(d) || 0;
    }
  }
  return [...groups].map(([rel, g]) => {
    const change = g.statuses.size === 1 && g.statuses.has('A') ? '新增' : g.statuses.size === 1 && g.statuses.has('D') ? '删除' : '修改';
    const link = g.files.length === 1 && treeMode(repo, change === '删除' ? start : to, g.files[0]) === '120000';
    const source = git(repo, ['log', '-1', '--format=%s', `${start}..${to}`, '--', ...g.files], { allowFail: true })?.trim() || '';
    return { kind: 'setting', bot, rel, files: g.files, from: start, to, label: settingLabel(rel), change, added: g.added, removed: g.removed, link, source };
  });
}

function settingLine(it) {
  const lines = [it.added ? `+${it.added}` : '', it.removed ? `−${it.removed}` : ''].filter(Boolean).join(' ');
  const what = it.link
    ? (it.change === '删除' ? '卸掉了官方技能' : '装上了官方技能')
    : [it.files.length > 1 ? `${it.files.length} 个文件` : '', lines ? `${lines} 行` : ''].filter(Boolean).join('，');
  return `${it.n}. ${it.change}｜${it.label}${it.source ? `（${it.source}）` : ''}：${what || '有改动'}`;
}

// 清单里设置那几条的细节：改了的那几行（每行最多 60 字）
function settingDetail(it) {
  const repo = repoDir(it.bot);
  const out = [];
  for (const rel of it.files || []) {
    const patch = git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', it.from, it.to, '--', rel], { allowFail: true }) || '';
    for (const l of patch.split('\n')) {
      if ((l.startsWith('+') && !l.startsWith('+++')) || (l.startsWith('-') && !l.startsWith('---'))) {
        const text = l.slice(1).trim();
        if (text) out.push(`   ${l[0] === '+' ? '＋' : '－'} ${clip(text, 60)}`);
      }
    }
  }
  return out;
}

// 一行记忆常写成"标题：一句；一句；…"（cleanLine 已经去掉了 ** 和列表符号）。只改了其中几句时按句比较、
// 只列改了的那几句：不然改前改后开头一样，汇报里根本看不出改了什么
const splitKey = (line) => {
  const m = String(line).match(/^([^：:]{1,30})[：:]\s*(.+)$/);
  return m ? { key: m[1].trim(), body: m[2] } : { key: '', body: String(line) };
};
const sentencesOf = (text) => String(text).split(/(?<=[；;。！？!?])/).map((s) => s.trim()).filter(Boolean);
const bare = (s) => s.replace(/[；;。！？!?，,\s]+$/, '');
const charLen = (s) => [...String(s)].length;

// 两组句子之间连续改动的地方，一块一块列出来：[{ del: [句], add: [句] }]（比较时不看句末标点）
function sentenceBlocks(a, b) {
  const x = a.map(bare);
  const y = b.map(bare);
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const blocks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      if (cur) blocks.push(cur);
      cur = null;
      i++;
      j++;
      continue;
    }
    cur ||= { del: [], add: [] };
    if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) cur.del.push(a[i++]);
    else cur.add.push(b[j++]);
  }
  if (cur) blocks.push(cur);
  return blocks;
}

// 同一段里改前、改后的行配成对：标题相同的先配；剩下的行数一样就按顺序配，不一样就只配开头四个字相同的。
// 配不上的整行算新增或删除
function pairLines(del, add) {
  const pairs = [];
  const used = new Set();
  const restDel = [];
  for (const d of del) {
    const k = splitKey(d).key;
    const j = k ? add.findIndex((a, idx) => !used.has(idx) && splitKey(a).key === k) : -1;
    if (j < 0) {
      restDel.push(d);
      continue;
    }
    used.add(j);
    pairs.push([d, add[j]]);
  }
  let restAdd = add.filter((_, idx) => !used.has(idx));
  if (restDel.length === restAdd.length) return { pairs: [...pairs, ...restDel.map((d, idx) => [d, restAdd[idx]])], dels: [], adds: [] };
  const lead = (s) => [...s].slice(0, 4).join('');
  const dels = [];
  for (const d of restDel) {
    const j = restAdd.findIndex((a) => lead(a) === lead(d));
    if (j < 0) {
      dels.push(d);
      continue;
    }
    pairs.push([d, restAdd[j]]);
    restAdd = restAdd.filter((_, idx) => idx !== j);
  }
  return { pairs, dels, adds: restAdd };
}

// 一对改前改后的行：两版标题相同就只比正文，返回 { key, blocks }
function lineEdit(oldLine, newLine) {
  const o = splitKey(oldLine);
  const n = splitKey(newLine);
  const key = o.key && o.key === n.key ? o.key : '';
  return { key, blocks: key ? sentenceBlocks(sentencesOf(o.body), sentencesOf(n.body)) : sentenceBlocks(sentencesOf(oldLine), sentencesOf(newLine)) };
}

// 一句里改了几个字：放得下就整句列出；放不下就去掉前后相同的部分，各留几个字当上下文
function replaceText(oldText, newText, max) {
  if (charLen(oldText) <= max && charLen(newText) <= max) return `${oldText} → ${newText}`;
  const a = [...oldText];
  const b = [...newText];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const from = Math.max(0, p - 6);
  const span = (c) => `${from > 0 ? '…' : ''}${c.slice(from, c.length - s + Math.min(s, 6)).join('')}${s > 6 ? '…' : ''}`;
  return `${clip(span(a), max)} → ${clip(span(b), max)}`;
}

// 一处改动写成一句话：加了「…」、删了「…」或者 改前 → 改后
function blockText(b, max) {
  if (!b.del.length) return `加了「${clip(b.add.join(''), max)}」`;
  if (!b.add.length) return `删了「${clip(b.del.join(''), max)}」`;
  return replaceText(b.del.join(''), b.add.join(''), max);
}

// 汇报里的一条：类型、哪一项（行的标题）、改了什么、改了几行（只改一行时，这一行还有几处改动）
function itemParts(item) {
  const add = visible(item.added);
  const del = visible(item.removed);
  if (item.moved) {
    const m = item.movedLines;
    return { kind: '搬走', key: '', body: `「${clip(m[0], 30)}」${m.length > 1 ? `等 ${m.length} 行` : ''}原样搬去了资料库${item.keptSummary ? '，原处留了一句结论' : ''}`, lines: 0, more: 0 };
  }
  if (!del.length) return { kind: '新增', key: '', body: clip(add[0], 40), lines: add.length, more: 0 };
  if (!add.length) return { kind: '删除', key: '', body: clip(del[0], 40), lines: del.length, more: 0 };
  const lines = Math.max(add.length, del.length);
  const { pairs, dels, adds } = pairLines(del, add);
  const edits = pairs.map(([o, n]) => lineEdit(o, n)).filter((e) => e.blocks.length);
  if (!edits.length) {
    // 配上对的行只改了标点或空格：有整行增删的就列那一行
    const body = adds.length ? `加了一行「${clip(adds[0], 30)}」` : dels.length ? `删了一行「${clip(dels[0], 30)}」` : '只改了标点或空格';
    return { kind: '修改', key: '', body, lines, more: 0 };
  }
  const changes = edits.reduce((n, e) => n + e.blocks.length, 0) + dels.length + adds.length;
  return { kind: '修改', key: edits[0].key, body: blockText(edits[0].blocks[0], 30), lines, more: changes - 1 };
}

const itemSuffix = ({ lines, more }) => (lines > 1 ? `（共 ${lines} 行）` : more > 0 ? `（这一行还有 ${more} 处改动）` : '');

// 给主人看的一行：编号、类型、文件（和哪一项）、来源、内容
function itemLine(item) {
  const p = itemParts(item);
  return `${item.n}. ${p.kind}｜${item.label}${p.key ? `「${p.key}」` : ''}${item.source ? `（${item.source}）` : ''}：${p.body}${itemSuffix(p)}`;
}

// 资料库、大事记按文件算的一条
function fileParts(item) {
  const add = visible(item.added);
  const del = visible(item.removed);
  const verb = item.created ? '新增' : !add.length ? '删除' : '更新';
  const body = add.length ? `加了 ${add.length} 行，比如「${clip(add[0], 30)}」` : `删了 ${del.length} 行`;
  return { verb, body };
}
function fileLine(item) {
  const p = fileParts(item);
  return `${item.n}. ${p.verb}｜${item.label}${item.source ? `（${item.source}）` : ''}：${p.body}`;
}
function fileDetail(item) {
  const add = visible(item.added);
  return [
    ...add.slice(0, 6).map((l) => `   ＋ ${clip(l, 100)}`),
    ...(add.length > 6 ? [`   …一共加了 ${add.length} 行`] : []),
    ...visible(item.removed).slice(0, 3).map((l) => `   － ${clip(l, 100)}`),
  ];
}

// 给被代管实例的用户看的一行：不编号、不写来源
function plainItemLine(item) {
  if (item.kind === 'file') {
    const f = fileParts(item);
    return `• ${f.verb}｜${item.label}：${f.body}`;
  }
  const p = itemParts(item);
  return `• ${p.kind}｜${item.label}${p.key ? `「${p.key}」` : ''}：${p.body}${itemSuffix(p)}`;
}

// 「记忆改动」里一条的明细：短的行照旧整行列出改前改后；长的行（多半一行里写了好几句）只列改了的那几句
function itemDetail(item) {
  const { pairs, dels, adds } = pairLines(visible(item.removed), visible(item.added));
  const out = [];
  for (const [o, n] of pairs) {
    if (charLen(o) <= 60 && charLen(n) <= 60) {
      out.push(`   － ${o}`, `   ＋ ${n}`);
      continue;
    }
    const { key, blocks } = lineEdit(o, n);
    const where = key ? `「${key}」` : '';
    if (!blocks.length) out.push(`   ✎ ${where}只改了标点或空格`);
    for (const b of blocks) out.push(`   ✎ ${where}${blockText(b, 100)}`);
  }
  return [...out, ...dels.map((l) => `   － ${clip(l, 100)}`), ...adds.map((l) => `   ＋ ${clip(l, 100)}`)];
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

// 超上限的核心档案和专题：如实说聊天时有没有被截断、晚上会怎么处理（资料库、大事记没有上限）
function overLimitNotes(botRoot) {
  const notes = [];
  for (const f of listMemoryFiles(botRoot)) {
    if (!Number.isFinite(f.max)) continue;
    let n = 0;
    try { n = charCount(readBotFile(botRoot, f.abs).toString('utf-8')); } catch { continue; }
    if (n <= f.max) continue;
    const cut = n > f.max * 2 ? `聊天时只带得上前 ${f.max * 2} 字，` : '';
    notes.push(`⚠️ ${displayName(botRoot)}的「${f.label}」${n} 字，超过上限 ${f.max} 字。${cut}凌晨整理会把旧的、细节的条目原样搬去资料库（一晚整理一个文件），内容不会丢。`);
  }
  return notes;
}

// 汇报起点以来的"腾地方"：从实例自己的 data/state/memory_slim.json 读（只读数字和文件名，路径经过软链接不读）
function slimNotes(botRoot, since) {
  let entries = [];
  try {
    entries = JSON.parse(readBotFile(botRoot, path.join(botRoot, 'data', 'state', 'memory_slim.json')).toString('utf-8')).entries;
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  // 同一个文件可能分几次搬（比如一次性迁移搬了两轮）：合成一行，写"原来多少字、现在多少字、一共搬了几条去哪"
  const byFile = new Map();
  for (const e of entries.filter((x) => x && Number(x.at) > (since || 0)).sort((a, b) => Number(a.at) - Number(b.at))) {
    const rel = String(e.rel || '');
    const g = byFile.get(rel) || { label: '', before: Number(e.before) || 0, count: 0, dests: new Set() };
    g.label = String(e.label || rel);
    for (const m of Array.isArray(e.moved) ? e.moved : []) {
      g.count += Number(m?.count) || 0;
      g.dests.add(String(m?.to || '').replace(`${LIBRARY_DIR}/`, '').replace(`${TOPICS_DIR}/`, '专题 '));
    }
    byFile.set(rel, g);
  }
  return [...byFile].slice(0, 8).map(([rel, g]) => {
    let now = null;
    try { now = charCount(readBotFile(botRoot, path.join(botRoot, rel)).toString('utf-8')); } catch {}
    const dests = [...g.dests];
    return `🗂 「${clip(g.label, 20)}」腾地方：原来 ${g.before} 字，${now === null ? '' : `现在 ${now} 字，`}一共 ${g.count} 条原样搬去了 ${clip(dests.slice(0, 3).join('、'), 60)}${dests.length > 3 ? ' 等' : ''}，需要时还能查到。`;
  });
}

// 存进 review.json 的清单只留定位用的字段，不存内容
const storedItem = ({ n, bot, rel, from, to, hunk, label, botName, kind, files }) => ({ n, bot, rel, from, to, hunk, label, botName, kind, files });
const lineOf = (it) => (it.kind === 'setting' ? settingLine(it) : it.kind === 'file' ? fileLine(it) : itemLine(it));
const detailOf = (it) => (it.kind === 'setting' ? settingDetail(it) : it.kind === 'file' ? fileDetail(it) : itemDetail(it));
// 整个文件退回改之前（设置、资料库、大事记）；其余按段反向打补丁
const fileLevel = (it) => it.kind === 'setting' || it.kind === 'file';

// 带编号的汇报：记忆在前、设置在后，编号接着排；notes 附在后面（超长提醒、别的机器人有设置变动）
function numberedDigestText(items, since, notes = []) {
  const mem = items.filter((i) => i.kind !== 'setting');
  const set = items.filter((i) => i.kind === 'setting');
  const lines = [];
  if (mem.length) {
    lines.push(`📝 记忆变动（${sinceText(since)} 以来）`, ...mem.slice(0, DIGEST_MAX_ITEMS).map(lineOf));
    if (mem.length > DIGEST_MAX_ITEMS) lines.push(`还有 ${mem.length - DIGEST_MAX_ITEMS} 条，回「记忆改动」看全部。`);
  }
  if (set.length) {
    lines.push(mem.length ? '🛠 设置变动' : `🛠 设置变动（${sinceText(since)} 以来）`, ...set.slice(0, DIGEST_MAX_ITEMS).map(settingLine));
    if (set.length > DIGEST_MAX_ITEMS) lines.push(`还有 ${set.length - DIGEST_MAX_ITEMS} 条，回「记忆改动」看全部。`);
  }
  lines.push(...notes);
  if (items.length) {
    const cmd = set.length ? '撤销' : '撤销记忆';
    lines.push(items.length > DIGEST_MAX_ITEMS
      ? `回「${cmd} 1」撤销第 1 条，「${cmd} 全部」撤销全部 ${items.length} 条。`
      : `回「${cmd} 1」撤销第 1 条，「${cmd} 全部」全部撤销，「记忆改动」看完整内容。`);
  }
  return lines.join('\n');
}

// 「撤销 N」按谁最近看到的那份清单：shown_by[谁]；shown 是旧的写法（主人模式、独立模式），一起留着
function setShown(state, viewer, items) {
  const entry = { at: Date.now(), items };
  state.shown_by = { ...state.shown_by, [viewer]: entry };
  if (viewer === ownerBotName() || viewer === settings.only) state.shown = entry;
}
const shownFor = (state, viewer) => state.shown_by?.[viewer] || (viewer === ownerBotName() || viewer === settings.only ? state.shown : null);

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
    return { bot, text: numberedDigestText(items, since, [...slimNotes(botRoot, since), ...overLimitNotes(botRoot)]), items: items.map(storedItem), range };
  });
}

export function markDigestDelivered(digest) {
  withLock(() => {
    const state = loadReview();
    recordDelivered(state, digest.bot, digest.range, Date.now());
    setShown(state, digest.bot, digest.items);
    saveReview(state);
  });
}

/**
 * 「记忆改动」「X记忆改动」：一个实例从最近一份早间汇报的起点到现在的全部改动（含汇报之后新的改动），
 * 带编号，主人接着回「撤销记忆 N」就按这份的编号撤。
 */
export function showChanges({ botsDir = DEFAULT_BOTS_DIR, bot, viewer = null }) {
  return withLock(() => {
    snapshotAllUnlocked(botsDir, { force: true });
    const botRoot = findBot(botsDir, bot);
    const state = loadReview();
    initReported(botsDir, state);
    const who = viewer || settings.only || ownerBotName() || bot;
    const last = state.last_digest?.[bot];
    const { items, range } = botItems(botRoot, last?.from || state.reported?.[bot]);
    setShown(state, who, items.map(storedItem));
    // 管理员看过别的机器人的改动，早间汇报就不再提醒"它有几处设置变动"
    if (who !== bot) state.pointed = { ...state.pointed, [bot]: range.to };
    saveReview(state);
    const whose = bot === who ? '' : `${displayName(botRoot)}的`;
    if (!items.length) return `最近一份汇报以来，${whose}记忆没有变化（或者改动都已经撤销了）。`;
    const cmd = items.some((i) => i.kind === 'setting') ? '撤销' : '撤销记忆';
    const since = last?.from ? last.at : state.reported_at?.[bot] || commitTime(repoDir(bot), range.from);
    const out = [`📝 ${whose}${cmd === '撤销' ? '' : '记忆'}改动（${sinceText(since)} 以来，共 ${items.length} 条）`];
    let used = out[0].length;
    let shortFrom = null;
    for (const it of items) {
      const detail = detailOf(it);
      // 记忆那几条的摘要就是下面的细节，标题里去掉；设置的摘要（改了几行、装上了官方技能）留着
      const block = [it.kind === 'setting' ? settingLine(it) : lineOf(it).replace(/：.*$/, ''), ...detail.slice(0, 4)];
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
        const line = lineOf(it);
        if (used + line.length > LIST_MAX_CHARS + 600) {
          out.push(`……后面还有 ${items.length - it.n + 1} 条没列出来，「${cmd} 全部」也会撤销它们。`);
          break;
        }
        out.push(line);
        used += line.length + 1;
      }
    }
    out.push(...overLimitNotes(botRoot));
    out.push(`回「${cmd} 编号」撤销（可以写多个，比如「${cmd} 1 3」），「${cmd} 全部」全部撤销。编号以这份清单为准。`);
    return out.join('\n');
  });
}

// ---------- 沙箱实例的早间汇报 ----------
// 沙箱里被代管的实例读不到记忆历史：主人的机器人把它还没汇报过的改动整理成一段文字，放进它自己的
// data/state/memory_digest.json（归它自己的账号）；它的早间播报附上这段，发出去后写 memory_digest_ack.json
const pendingFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest.json');
const ackFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest_ack.json');

function plainDigestText(items, since, botName, notes = []) {
  // 只列记忆：设置是用户当面让机器人改的，改的时候已经说过了；管理员在自己那边看得到
  items = items.filter((i) => i.kind !== 'setting');
  const lines = [`📝 记忆变动（${sinceText(since)} 以来）`, ...items.slice(0, DIGEST_MAX_ITEMS).map(plainItemLine)];
  if (items.length > DIGEST_MAX_ITEMS) lines.push(`另外还有 ${items.length - DIGEST_MAX_ITEMS} 条小改动，就不一一列了。`);
  lines.push(...notes);
  lines.push(`哪里记得不对，直接告诉${botName}是哪件事就行～`);
  return lines.join('\n');
}

// 写进实例自己的目录：先写临时文件、改成那个目录的属主，再改名，对方永远读不到写了一半的内容；路径经过软链接就不写
export function writeJsonForBot(botRoot, file, data) {
  if (!insideBot(botRoot, file)) throw new Error(`${path.relative(botRoot, file)} 的路径经过软链接，不写`);
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
export function syncBotDigests({ botsDir = DEFAULT_BOTS_DIR, includeOwner = false } = {}) {
  return withLock(() => {
    const owner = ownerBotName();
    const state = loadReview();
    let dirty = initReported(botsDir, state);
    const bots = discoverBots(botsDir);
    for (const botRoot of bots) {
      const bot = path.basename(botRoot);
      if (bot === owner && !includeOwner) continue;
      const pending = state.pending?.[bot] || {};
      const ack = readJson(ackFile(botRoot));
      if (ack?.id && pending[ack.id] && state.acked?.[bot] !== ack.id) {
        const p = pending[ack.id];
        recordDelivered(state, bot, p, Number(ack.delivered_at) || Date.now());
        if (p.items) setShown(state, bot, p.items);
        if (p.pointed) state.pointed = { ...state.pointed, ...p.pointed };
        state.acked = { ...state.acked, [bot]: ack.id };
        state.pending = { ...state.pending, [bot]: {} };
        dirty = true;
      }
      const numbered = (loadBotSettings(botRoot).digest_style || (bot === owner ? 'numbered' : 'plain')) !== 'plain';
      const file = pendingFile(botRoot);
      const repo = ensureRepo(bot);
      const to = head(repo);
      const from = state.reported[bot];
      // 管理员的汇报：别的机器人从上次提醒（或管理员上次看过）以来有几处设置变动
      const pointers = numbered && bot === owner
        ? bots.filter((b) => b !== botRoot).map((b) => {
          const other = path.basename(b);
          const otherRepo = ensureRepo(other);
          const otherTo = head(otherRepo);
          const otherFrom = isCommit(otherRepo, state.pointed?.[other]) ? state.pointed[other] : state.reported?.[other];
          const n = otherFrom && otherFrom !== otherTo ? settingItems(b, otherFrom, otherTo).length : 0;
          return { bot: other, name: displayName(b), n, to: otherTo };
        }).filter((p) => p.n > 0)
        : [];
      const current = readJson(file);
      const id = `${from.slice(0, 10)}-${to.slice(0, 10)}${pointers.map((p) => `-${p.bot}${p.to.slice(0, 6)}`).join('')}`;
      if (current?.id === id) continue;
      const { items } = from === to ? { items: [] } : botItems(botRoot, from);
      const listed = numbered ? items : items.filter((i) => i.kind !== 'setting');
      if (!listed.length && !pointers.length) {
        if (current) fs.rmSync(file, { force: true });
        continue;
      }
      const since = state.reported_at?.[bot] || commitTime(repo, from);
      const pointerLines = pointers.map((p) => `（${p.name}有 ${p.n} 处设置变动，回「${p.name}改动」看）`);
      let text;
      if (!numbered) text = plainDigestText(items, since, displayName(botRoot), slimNotes(botRoot, since));
      else if (!items.length) text = pointers.map((p) => `📝 ${p.name}有 ${p.n} 处设置变动，回「${p.name}改动」看。`).join('\n');
      else text = numberedDigestText(items, since, [...slimNotes(botRoot, since), ...overLimitNotes(botRoot), ...pointerLines]);
      writeJsonForBot(botRoot, file, { id, at: Date.now(), count: listed.length, text });
      // 只留最近几份的范围：回执可能对应稍早写的那一份
      const entry = { from, to, ...(numbered ? { items: items.map(storedItem) } : {}), ...(pointers.length ? { pointed: Object.fromEntries(pointers.map((p) => [p.bot, p.to])) } : {}) };
      const ids = Object.entries({ ...(state.pending?.[bot] || {}), [id]: entry }).slice(-5);
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
  if (!insideBot(botRoot, dst)) throw new Error(`${rel} 的路径经过软链接，不写回`);
  let srcSt = null;
  try { srcSt = fs.lstatSync(src); } catch {}
  if (!srcSt) {
    fs.rmSync(dst, { force: true });
    return;
  }
  let st = null;
  try { st = fs.lstatSync(dst); } catch {}
  // 新建的文件、文件夹跟它所在的文件夹同一个属主；直接放在实例目录下的归这个机器人自己
  // （看它 data/ 的属主：沙箱里的机器人，实例目录本身归 root）
  const ownerOf = (d) => {
    if (d !== botRoot) return fs.statSync(d);
    try { return fs.statSync(path.join(botRoot, 'data')); } catch { return fs.statSync(botRoot); }
  };
  const dir = path.dirname(dst);
  const missing = [];
  for (let d = dir; d !== botRoot && !fs.existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    const o = ownerOf(path.dirname(d));
    fs.mkdirSync(d);
    fs.chownSync(d, o.uid, o.gid);
  }
  const dirSt = fs.statSync(dir);
  const owner = ownerOf(dir);
  const uid = st ? st.uid : owner.uid;
  const gid = st ? st.gid : owner.gid;
  const tmp = `${dst}.${process.pid}.${Date.now()}.undo.tmp`;
  if (srcSt.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), tmp);
    fs.lchownSync(tmp, uid, gid);
  } else {
    const mode = st && st.isFile() ? st.mode & 0o7777 : dirSt.mode & 0o666;
    fs.writeFileSync(tmp, fs.readFileSync(src));
    fs.chmodSync(tmp, mode);
    fs.chownSync(tmp, uid, gid);
  }
  fs.renameSync(tmp, dst);
}

/**
 * 撤销最近一份清单里的几条（selection 是编号数组，或 'all'）。返回给主人的回复。
 * 先把线上现状存一版；每条按"反向打补丁"撤销，那一段后来又被改过就不硬改，告诉主人。
 */
// scope：「撤销记忆 全部」只撤记忆那几条（'memory'，默认），「撤销 全部」连设置一起撤（'all'）；写了编号的按编号撤
export function undoItems(selection, { botsDir = DEFAULT_BOTS_DIR, viewer = null, scope = 'memory' } = {}) {
  return withLock(() => {
    const state = loadReview();
    const shown = shownFor(state, viewer || settings.only || ownerBotName());
    if (!shown?.items?.length || Date.now() - shown.at > SHOWN_VALID_MS) {
      return '现在没有可以撤销的清单。回「记忆改动」看看最近的改动。';
    }
    const picked = selection === 'all'
      ? shown.items.filter((i) => !i.undone && (scope === 'all' || i.kind !== 'setting'))
      : selection.map((n) => shown.items.find((i) => i.n === n) || { n, missing: true });
    const missing = picked.filter((i) => i.missing).map((i) => i.n);
    const already = picked.filter((i) => i.undone).map((i) => i.n);
    const todo = picked.filter((i) => !i.missing && !i.undone);
    const done = [];
    const failed = [];
    if (todo.length) {
      snapshotAllUnlocked(botsDir, { force: true });
      // 同一个文件从后往前撤，前面那些段的行号不受影响
      const order = todo.filter((i) => !fileLevel(i)).sort((a, b) => a.bot.localeCompare(b.bot) || a.rel.localeCompare(b.rel) || b.hunk - a.hunk);
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
      // 设置按项、资料库和大事记按文件，整个退回改之前的样子（新增的就删掉）；后来又改过就不硬改
      for (const it of todo.filter(fileLevel)) {
        const repo = repoDir(it.bot);
        const unchanged = isCommit(repo, it.from) && isCommit(repo, it.to)
          && (it.files || []).every((rel) => git(repo, ['diff', '--quiet', it.to, 'HEAD', '--', rel], { allowFail: true }) !== null);
        if (!unchanged || !it.files?.length) {
          failed.push(it);
          continue;
        }
        for (const rel of it.files) {
          if (treeMode(repo, it.from, rel)) git(repo, ['checkout', it.from, '--', rel]);
          else fs.rmSync(path.join(repo, rel), { force: true });
        }
        done.push(it);
        if (!touched.has(it.bot)) touched.set(it.bot, new Set());
        for (const rel of it.files) touched.get(it.bot).add(rel);
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
  // 「记忆改动」「改动」看自己的；「X记忆改动」「X改动」「X的改动」「记忆改动 X」「改动 X」看机器人 X 的
  if (/^(?:记忆)?(?:改动|变动)$/.test(t)) return { type: 'show' };
  let m = t.match(/^(.{1,12}?)的?(?:记忆)?(?:改动|变动)$/);
  if (m) return { type: 'show', name: m[1] };
  m = t.match(/^(?:记忆)?(?:改动|变动)\s+(.{1,12})$/);
  if (m) return { type: 'show', name: m[1].trim() };
  // 「撤销记忆 2」「撤销 1 3」；「撤销记忆 全部」只撤记忆，「撤销 全部」连设置一起撤（scope: 'all'）
  m = t.match(/^撤销(记忆)?\s*(全部|所有|\d+(?:\s*[,，、\s]\s*\d+)*)$/);
  if (!m) return null;
  if (/^(全部|所有)$/.test(m[2])) return m[1] ? { type: 'undo', items: 'all' } : { type: 'undo', items: 'all', scope: 'all' };
  return { type: 'undo', items: [...new Set(m[2].split(/\D+/).filter(Boolean).map(Number))] };
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
    // 只恢复记忆：设置文件按条撤销（「撤销 N」），不跟着整体恢复
    const now = git(repo, ['ls-files']).split('\n').filter(Boolean).filter(isMemoryRel);
    const then = git(repo, ['ls-tree', '-r', '--name-only', target]).split('\n').filter(Boolean).filter(isMemoryRel);
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
