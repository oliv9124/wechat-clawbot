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
// 早间复盘最多列几条（带编号的，其余回「记忆改动」看；不带编号的看不了全文，多列一些）；「记忆改动」最多多少字
const DIGEST_MAX_ITEMS = 15;
const PLAIN_MAX_ITEMS = 25;
const LIST_MAX_CHARS = 2400;
const SHOWN_VALID_MS = 7 * 86400_000;
// 官方技能放在这些目录里：机器人装上的技能是指向这里的软链接，汇报时从这里读技能的说明（指向别处的不读）
const TRUSTED_SKILL_DIRS = (process.env.CLAWBOT_TRUSTED_SKILL_DIRS || [path.join(PROJECT_DIR, 'skills-store'), '/opt/clawbot-cap/skills'].join(':'))
  .split(':').filter(Boolean);

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
 *   standalone 默认：自己管自己，以 root 运行的也一样（10-22 起的"主人的机器人在自己进程里管所有实例"那种方式 11-17 删了，统一管理只靠管理服务）
 *   off        设了 CLAWBOT_MEMORY_MODE=off，或者没装 git：不存版本
 */
export function memoryMode(botRoot) {
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
const isCommit = (repo, c) => Boolean(c) && git(repo, ['cat-file', '-e', `${c}^{commit}`], { allowFail: true }) !== null;
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
// 进程被停掉（systemd 发 SIGTERM，或者 Ctrl-C）时，Node 默认马上退出：正在存版本的话，下面 finally 里删锁那一步来不及做，
// 锁目录留下，之后的「记忆改动」要先等 15 秒才报"被占用"，2 分钟后才算过期（11-14 测试里查到，线上调度器重启也会这样）。
// 装上处理函数以后，信号要等手上这段同步的存版本做完才轮到它，锁已经删了，再退出。只装一次，已经有人处理的信号不管
let signalsHooked = false;
function hookExitSignals() {
  if (signalsHooked) return;
  signalsHooked = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    if (process.listenerCount(sig) === 0) process.on(sig, () => process.exit(0));
  }
}

function withLock(fn) {
  hookExitSignals();
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
// 11-18 起汇报按"一条一行"列，用大白话说，不写文件名、路径：
//   核心档案、专题、大事记逐行拆成一条条——新记住的、更新的、不再记的、昨天的事（大事记新加的）；
//   原样搬去资料（或别的专题）、去掉重复的，每个文件合成一条"收拾了一下"；资料库按文件算一条；设置按项算一条。
// 编号按分类排。撤销时按清单那一版（from..to）重新算出这一条，在现在的文件里撤（见 undoLineItems）
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
const clip = (text, n) => {
  const c = [...String(text)];
  return c.length > n ? `${c.slice(0, n).join('')}…` : String(text);
};
const charLen = (s) => [...String(s)].length;
const HAN = /[\u4e00-\u9fff]/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
const headingLevel = (l) => String(l).match(/^\s{0,3}(#{1,6})\s/)?.[1].length || 0;
// 结构行：空行、标题、分隔线、表格的分隔行。汇报里不单列；撤销时跟着旁边的内容一起放回去
const isStructural = (raw) => !cleanLine(raw) || HEADING.test(raw)
  || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw) || /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(raw);
const indentOf = (raw) => String(raw).match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
// 大事记的一行开头常写着日期（"11-17 …""11-17：…"），汇报里按日期分好了，去掉
const LEAD_DATE = /^(?:\d{4}-)?\d{1,2}-\d{1,2}(?:\s*[：:、，,]\s*|\s+)/;

/**
 * git diff -U0：一块一块的改动 [{ del: [{ i, raw }], add: [{ j, raw }] }]，i、j 是改之前、改之后文件里的行号（从 0 数）
 */
function changeBlocks(repo, from, to, rel) {
  const patch = git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', from, to, '--', rel]);
  const blocks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  for (const l of patch.split('\n')) {
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      i = Number(m[1]) - 1;
      j = Number(m[2]) - 1;
      cur = { del: [], add: [] };
      blocks.push(cur);
    } else if (cur && l.startsWith('-')) {
      cur.del.push({ i: i++, raw: l.slice(1) });
    } else if (cur && l.startsWith('+')) {
      cur.add.push({ j: j++, raw: l.slice(1) });
    }
  }
  return blocks;
}

// 一行记忆常写成"标题：一句；一句；…"（cleanLine 已经去掉了 ** 和列表符号）。只改了其中几句时按句比较、
// 只说改了的那几句：不然改前改后开头一样，汇报里根本看不出改了什么
const splitKey = (line) => {
  const m = String(line).match(/^([^：:]{1,30})[：:]\s*(.+)$/);
  return m ? { key: m[1].trim(), body: m[2] } : { key: '', body: String(line) };
};
const sentencesOf = (text) => String(text).split(/(?<=[；;。！？!?])/).map((s) => s.trim()).filter(Boolean);
const bare = (s) => String(s).replace(/[；;。！？!?，,\s]+$/, '');

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

// 两行字有多像：相邻两个字的组合重合多少（0 到 1）
function similarity(a, b) {
  const grams = (s) => {
    const c = [...String(s).replace(/\s+/g, '')];
    const m = new Map();
    for (let i = 0; i + 1 < c.length; i++) m.set(c[i] + c[i + 1], (m.get(c[i] + c[i + 1]) || 0) + 1);
    return m;
  };
  const x = grams(a);
  const y = grams(b);
  let both = 0;
  let total = 0;
  for (const [g, v] of x) {
    both += Math.min(v, y.get(g) || 0);
    total += v;
  }
  for (const v of y.values()) total += v;
  return total ? (2 * both) / total : 0;
}

// 改前、改后的行配成对（下标）：标题相同的算同一条；没有标题的，缩进一样、字有一小半以上相同的才算（最像的那个）。
// 配不上的算删掉、新加——不能因为删一行、加一行，就说成"把 A 改成了 B"。del、add：[{ text（已清理）, ind（缩进） }]
function pairIdx(del, add) {
  const pairs = [];
  const used = new Set();
  const dels = [];
  del.forEach((d, di) => {
    const key = splitKey(d.text).key;
    let best = -1;
    let score = 0;
    add.forEach((a, ai) => {
      if (used.has(ai)) return;
      const s = key && key === splitKey(a.text).key ? 1 : d.ind === a.ind ? similarity(d.text, a.text) : 0;
      if (s > score) {
        best = ai;
        score = s;
      }
    });
    if (best >= 0 && score >= 0.4) {
      used.add(best);
      pairs.push([di, best]);
    } else {
      dels.push(di);
    }
  });
  return { pairs, dels, adds: add.map((_, ai) => ai).filter((ai) => !used.has(ai)) };
}

// 一对改前改后的行：两版标题相同就只比正文，返回 { key, blocks }
function lineEdit(oldLine, newLine) {
  const o = splitKey(oldLine);
  const n = splitKey(newLine);
  const key = o.key && o.key === n.key ? o.key : '';
  return { key, blocks: key ? sentenceBlocks(sentencesOf(o.body), sentencesOf(n.body)) : sentenceBlocks(sentencesOf(oldLine), sentencesOf(newLine)) };
}

// 连着的几行里缩进更深的，是上一条的子项（"复诊：" 下面的 "- 空腹"），算同一条
function groupKids(lines, key) {
  const groups = [];
  for (const l of [...lines].sort((a, b) => a[key] - b[key])) {
    const g = groups[groups.length - 1];
    if (g && l[key] === g[g.length - 1][key] + 1 && indentOf(l.raw) > indentOf(g[0].raw)) g.push(l);
    else groups.push([l]);
  }
  return groups;
}

// 子项上面那一条的标题（"饮食：" 或 "饮食：少油" 里的"饮食"）：只看到"空腹"不知道说的是什么，放在前面
function parentKey(lines, idx) {
  const ind = indentOf(lines[idx]);
  if (!ind) return '';
  for (let k = idx - 1; k >= 0 && idx - k <= 60; k--) {
    const l = lines[k];
    if (HEADING.test(l)) return '';
    if (isStructural(l) || indentOf(l) >= ind) continue;
    const c = cleanLine(l);
    const m = c.match(/^(.{1,20}?)[：:]$/);
    if (m) return m[1];
    const key = splitKey(c).key;
    return key && charLen(key) <= 20 ? key : '';
  }
  return '';
}

// 一条（连同子项）说成一句话
function groupText(lines, idxs) {
  const parts = idxs.map((x) => cleanLine(lines[x])).filter(Boolean);
  if (!parts.length) return '';
  const [head, ...kids] = parts;
  let text = !kids.length ? head : /[：:]$/.test(head) ? `${head}${kids.map(bare).join('；')}` : `${bare(head)}；${kids.map(bare).join('；')}`;
  const key = parentKey(lines, idxs[0]);
  if (key && !text.startsWith(key)) text = `${key}：${text}`;
  return text;
}

// 大事记里一行属于哪天：上面最近的 "## 11-17"
function eventDate(lines, idx) {
  for (let k = idx - 1; k >= 0; k--) {
    const m = lines[k].match(/^\s{0,3}#{1,6}\s+(?:\d{4}-)?(\d{1,2}-\d{1,2})(?!\d)/);
    if (m) return m[1];
    if (HEADING.test(lines[k])) return '';
  }
  return '';
}

// 一句里改了的那一段：去掉前后相同的部分，各留几个字当上下文
function diffSpan(a, b, ctx = 6) {
  const x = [...String(a)];
  const y = [...String(b)];
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const start = Math.max(0, p - ctx);
  const cut = (c) => `${start > 0 ? '…' : ''}${c.slice(start, c.length - s + Math.min(s, ctx)).join('')}${s > ctx ? '…' : ''}`;
  return [cut(x), cut(y)];
}

// 改了的一行怎么说：改后的内容，括号里说原来记的是什么（一行里只改了一句的，只说那一句）
function updateText(oldLine, newLine, max) {
  const { key, blocks } = lineEdit(oldLine, newLine);
  if (!blocks.length) return `${clip(newLine, max)}（只改了标点或空格）`;
  const short = charLen(newLine) <= max;
  if (blocks.length === 1) {
    const was = blocks[0].del.join('');
    const now = blocks[0].add.join('');
    if (!was) return `${clip(newLine, max)}（新补了「${clip(now, 30)}」）`;
    if (!now) return `${clip(newLine, max)}（删掉了「${clip(was, 30)}」）`;
    const [os, ns] = diffSpan(was, now);
    const shown = short ? newLine : `${key ? `${key}：` : ''}${clip(charLen(now) <= max ? now : ns, max)}`;
    return `${shown}（原来记的是「${charLen(was) <= 30 ? was : clip(os, 30)}」）`;
  }
  const [os] = diffSpan(oldLine, newLine);
  return `${clip(newLine, max)}（改了 ${blocks.length} 处，原来记的是「${clip(os, 30)}」）`;
}

// 资料的标题：第一个带中文的标题；没有就第一行带中文的内容；再没有就用文件名
function libraryTitle(text, rel) {
  const lines = String(text || '').split('\n').slice(0, 60);
  const h = lines.find((l) => HEADING.test(l) && HAN.test(l));
  if (h) return clip(cleanLine(h).replace(/^[一二三四五六七八九十]+、\s*/, ''), 20);
  const c = lines.find((l) => !isStructural(l) && HAN.test(l));
  if (c) return clip(cleanLine(c), 20);
  return path.basename(rel).replace(/\.md$/, '');
}

/**
 * from..to 之间一个实例的改动，一条一条（按分类排好）：
 *   { kind: 'line', section: new / update / gone / event, rel, op（这个文件里的第几处）, text（update 是 oldText、newText）, date }
 *   { kind: 'move', section: 'tidy', rel, op, text, examples, leave }  原样搬去别处、去掉重复的，每个文件合成一条
 *   { kind: 'file', section: library / gone, rel, files, title, text, examples }  资料库按文件
 *   { kind: 'setting', section: 'setting', rel, files, change, link, text, desc }  设置按项
 * 公共字段 bot, from, to, label（不含内容的短名字，存进清单）。fd、lineOp 只在内存里用（撤销时按 from..to 重新算）。
 * 不列：只改了日期标记、空白，或者换了位置的行；原样搬过来的那一头（资料、专题里多出来的同样的行）
 */
function diffItems(botRoot, from, to, { memoryOnly = false } = {}) {
  const bot = path.basename(botRoot);
  const repo = repoDir(bot);
  const items = [];
  items.fds = new Map();
  if (from === to) return items;
  const show = (c, rel) => git(repo, ['show', `${c}:${rel}`], { allowFail: true });
  const rels = git(repo, ['diff', '--name-only', from, to]).split('\n').filter(Boolean).filter(isMemoryRel);

  // 第一遍：逐行的文件（核心档案、专题、大事记）读出改动块；两边都有的同一行（只改了日期标记、空白，或者换了位置）抵消掉
  const files = [];
  // 整个删掉的核心档案、专题、大事记：算一条，撤销时整个文件放回来（不拆成一行一行的"不再记"）
  const deleted = [];
  for (const rel of rels) {
    const kind = memoryKind(rel);
    if (kind === 'library') continue;
    const fromText = show(from, rel);
    const toText = show(to, rel);
    if (fromText !== null && toText === null) {
      deleted.push({ rel, kind, fromLines: fromText.split('\n') });
      continue;
    }
    const fd = {
      rel, kind, fromText, toText,
      fromLines: fromText === null ? [] : fromText.split('\n'),
      toLines: toText === null ? [] : toText.split('\n'),
      blocks: changeBlocks(repo, from, to, rel),
      sameDel: new Set(),
      sameAdd: new Set(),
      receiving: [],
    };
    const pool = new Map();
    for (const a of fd.blocks.flatMap((b) => b.add)) {
      if (isStructural(a.raw)) continue;
      const n = normalizeLine(a.raw);
      if (!pool.has(n)) pool.set(n, []);
      pool.get(n).push(a.j);
    }
    for (const d of fd.blocks.flatMap((b) => b.del)) {
      if (isStructural(d.raw)) continue;
      const q = pool.get(normalizeLine(d.raw));
      if (q?.length) {
        fd.sameDel.add(d.i);
        fd.sameAdd.add(q.shift());
      }
    }
    fd.addedHeads = new Set(fd.blocks.flatMap((b) => b.add).filter((a) => HEADING.test(a.raw)).map((a) => a.raw));
    files.push(fd);
    items.fds.set(rel, fd);
  }

  // 删掉的行在别的记忆文件里（to 那一版）原样有：是搬走了，不是删了；只在同一个文件里还有：是去掉了重复的
  let dest = null;
  const destOf = (rel, raw) => {
    if (!dest) {
      dest = new Map();
      const all = git(repo, ['ls-tree', '-r', '--name-only', to, '--', 'MEMORY.md', TOPICS_DIR, LIBRARY_DIR]).split('\n').filter(Boolean);
      for (const f of all) {
        for (const l of (show(to, f) ?? '').split('\n')) {
          if (isStructural(l)) continue;
          const n = normalizeLine(l);
          if (!dest.has(n)) dest.set(n, []);
          if (!dest.get(n).includes(f)) dest.get(n).push(f);
        }
      }
    }
    const where = dest.get(normalizeLine(raw)) || [];
    return where.find((f) => f !== rel) || (where.includes(rel) ? rel : null);
  };
  const realDel = (fd, d) => !isStructural(d.raw) && !fd.sameDel.has(d.i);
  const movedNorms = new Map();
  const noteMoved = (rel, raw) => {
    const t = destOf(rel, raw);
    if (!t || t === rel) return false;
    const n = normalizeLine(raw);
    if (!movedNorms.has(n)) movedNorms.set(n, new Set());
    movedNorms.get(n).add(rel);
    return true;
  };
  for (const fd of files) {
    for (const d of fd.blocks.flatMap((b) => b.del)) if (realDel(fd, d)) noteMoved(fd.rel, d.raw);
  }
  for (const df of deleted) {
    const rows = df.fromLines.map((raw, i) => ({ i, raw })).filter((x) => !isStructural(x.raw));
    const allMoved = rows.map((x) => noteMoved(df.rel, x.raw)).every(Boolean) && rows.length > 0;
    const groups = groupKids(rows, 'i');
    const examples = groups.map((g) => groupText(df.fromLines, g.map((x) => x.i)));
    const name = df.kind === 'core' ? '常用记忆' : df.kind === 'timeline' ? `${path.basename(df.rel, '.md')} 的大事记`
      : `「${memoryLabel(botRoot, df.rel)}」${df.kind === 'topic' ? '专题' : ''}`;
    items.push({
      bot, rel: df.rel, from, to, hunk: -1, kind: 'file', files: [df.rel], label: `整个${name}`, examples, leave: [],
      section: allMoved ? 'tidy' : 'gone',
      text: allMoved ? `${name}里的 ${groups.length} 条都挪到了别处（没删，还能找回）`
        : `整个${name}（${groups.length} 条${examples.length ? `，比如「${clip(showText(examples[0]), 20)}」` : ''}）`,
    });
  }
  const movedFromElsewhere = (rel, raw) => [...(movedNorms.get(normalizeLine(raw)) || [])].some((r) => r !== rel);

  // 第二遍：每个文件拆成一条条
  for (const fd of files) {
    const ops = [];
    let move = null;
    let dup = null;
    const newOp = (type) => {
      const o = { type, del: [], add: [], leave: [], moved: [] };
      ops.push(o);
      return o;
    };
    for (const b of fd.blocks) {
      const del = b.del.filter((d) => realDel(fd, d));
      let rest = b.add.filter((a) => !isStructural(a.raw) && !fd.sameAdd.has(a.j));
      // 原样搬过来的那一头：别的文件里删掉、这里多出来的同样的行（撤销"搬走"那条时一起拿掉）
      for (const a of rest.filter((x) => movedFromElsewhere(fd.rel, x.raw))) fd.receiving.push({ j: a.j, norm: normalizeLine(a.raw) });
      rest = rest.filter((a) => !movedFromElsewhere(fd.rel, a.raw));
      const moved = [];
      const dups = [];
      const gone = [];
      for (const d of del) {
        const t = destOf(fd.rel, d.raw);
        (t && t !== fd.rel ? moved : t === fd.rel ? dups : gone).push(d);
      }
      if (moved.length || dups.length) {
        if (moved.length) {
          move ||= newOp('move');
          move.del.push(...moved.map((d) => d.i));
          move.moved.push(...moved.map((d) => d.i));
        }
        if (dups.length) {
          dup ||= newOp('dup');
          dup.del.push(...dups.map((d) => d.i));
          dup.moved.push(...dups.map((d) => d.i));
        }
        if (!gone.length) {
          // 这一块只是搬走：一起删掉的标题、空行跟着这条放回去；原处留的一句结论（最多一句）也算这条的
          const host = moved.length ? move : dup;
          host.del.push(...b.del.filter((d) => isStructural(d.raw)).map((d) => d.i));
          if (rest.length <= 1) {
            host.leave.push(...rest.map((a) => a.j));
            host.add.push(...rest.map((a) => a.j));
            rest = [];
          }
        }
      }
      const { pairs, dels, adds } = pairIdx(
        gone.map((d) => ({ text: cleanLine(d.raw), ind: indentOf(d.raw) })),
        rest.map((a) => ({ text: cleanLine(a.raw), ind: indentOf(a.raw) })),
      );
      for (const [x, y] of pairs) ops.push({ type: 'update', del: [gone[x].i], add: [rest[y].j] });
      const goneOps = groupKids(dels.map((x) => gone[x]), 'i').map((g) => {
        const o = { type: 'gone', del: g.map((d) => d.i), add: [] };
        ops.push(o);
        return o;
      });
      for (const g of groupKids(adds.map((y) => rest[y]), 'j')) {
        ops.push({ type: fd.kind === 'timeline' ? 'event' : 'new', del: [], add: g.map((a) => a.j) });
      }
      // 和删掉的条目一起删的标题、空行：跟着它后面最近的那条"删掉"，撤销时一起放回去
      if (goneOps.length) {
        for (const s of b.del.filter((d) => isStructural(d.raw))) {
          (goneOps.find((o) => o.del[0] > s.i) || goneOps[goneOps.length - 1]).del.push(s.i);
        }
      }
    }
    ops.forEach((o, op) => {
      const base = { bot, rel: fd.rel, from, to, op, kind: o.type === 'move' || o.type === 'dup' ? 'move' : 'line', lineOp: o, fd };
      if (o.type === 'update') {
        const [i] = o.del;
        const [j] = o.add;
        const key = parentKey(fd.toLines, j);
        const nw = cleanLine(fd.toLines[j]);
        items.push({ ...base, section: 'update', label: '更新的一条', oldText: cleanLine(fd.fromLines[i]), newText: key && !nw.startsWith(key) ? `${key}：${nw}` : nw });
      } else if (o.type === 'gone') {
        const idxs = o.del.filter((i) => !isStructural(fd.fromLines[i])).sort((a, b) => a - b);
        items.push({ ...base, section: 'gone', label: '不再记的一条', text: groupText(fd.fromLines, idxs) });
      } else if (o.type === 'new' || o.type === 'event') {
        const text = groupText(fd.toLines, o.add);
        const event = o.type === 'event';
        items.push({
          ...base, section: o.type, label: event ? '记下的一件事' : '新记住的一条',
          text: event ? text.replace(LEAD_DATE, '') || text : text, date: event ? eventDate(fd.toLines, o.add[0]) : '',
        });
      } else {
        const lines = [...o.moved].sort((a, b) => a - b);
        const groups = groupKids(lines.map((i) => ({ i, raw: fd.fromLines[i] })), 'i');
        const src = fd.kind === 'core' ? '' : `「${memoryLabel(botRoot, fd.rel)}」${fd.kind === 'topic' ? '专题' : ''}里 `;
        let text;
        if (o.type === 'dup') {
          text = `${src}去掉了 ${groups.length} 条重复的记录`;
        } else {
          const dests = [...new Set(lines.map((i) => destOf(fd.rel, fd.fromLines[i])))];
          const lib = dests.every((d) => memoryKind(d) === 'library');
          const where = dests.length > 1 ? '资料和专题' : memoryKind(dests[0]) === 'core' ? '常用记忆' : `「${memoryLabel(botRoot, dests[0])}」专题`;
          text = lib ? `${src}${groups.length} 条旧记录挪进了资料（没删，还能找回）` : `${src}${groups.length} 条记录挪到了${where}（没删）`;
        }
        items.push({
          ...base, section: 'tidy', label: '收拾的一条', text,
          examples: groups.map((g) => groupText(fd.fromLines, g.map((d) => d.i))),
          leave: o.leave.map((j) => cleanLine(fd.toLines[j])),
        });
      }
    });
  }
  // 搬去别的专题、核心档案的：那边多出来的同样的行，撤销"搬走"时一起拿掉
  for (const it of items.filter((x) => x.lineOp?.type === 'move')) {
    const want = it.lineOp.moved.map((i) => normalizeLine(it.fd.fromLines[i]));
    it.lineOp.receivers = [];
    for (const other of files) {
      if (other === it.fd) continue;
      for (const r of other.receiving) {
        if (!r.claimed && want.includes(r.norm)) {
          r.claimed = true;
          it.lineOp.receivers.push({ rel: other.rel, j: r.j });
        }
      }
    }
  }

  // 资料库按文件算一条（只往里加，逐行列太碎）；撤销时整个文件退回改之前
  for (const rel of rels.filter((r) => memoryKind(r) === 'library')) {
    const all = parsePatch(filePatch(repo, from, to, rel)).hunks.map(hunkLines);
    const added = all.flatMap((h) => h.added).filter((l) => !isStructural(l));
    const removed = all.flatMap((h) => h.removed).filter((l) => !isStructural(l));
    if (!added.length && !removed.length) continue;
    // 只是原样搬过来的（腾地方时从核心档案、专题搬来的）：算在"收拾了一下"那条里，不单列
    if (!removed.length && added.every((l) => movedNorms.has(normalizeLine(l)))) continue;
    const fromText = show(from, rel);
    const toText = show(to, rel);
    const title = libraryTitle(toText ?? fromText, rel);
    const base = { bot, rel, from, to, hunk: -1, kind: 'file', files: [rel], label: `资料「${title}」`, title };
    const fresh = added.filter((l) => !movedNorms.has(normalizeLine(l))).map(cleanLine);
    if (toText === null) {
      items.push({ ...base, section: 'gone', text: `整份资料「${title}」`, examples: [] });
    } else {
      const what = fromText === null ? ''
        : !removed.length ? `（补了 ${fresh.length} 条）`
          : !added.length ? `（删了 ${removed.length} 条）` : `（改了 ${Math.max(added.length, removed.length)} 处）`;
      items.push({ ...base, section: 'library', text: `${title}${what}`, examples: fresh });
    }
  }
  if (!memoryOnly) items.push(...settingItems(botRoot, from, to));
  // 按分类排，同一类里保持原来的顺序
  items.sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);
  return items;
}

// ---------- 设置的改动 ----------
// 设置按"项"汇报：自己的一个技能（.agents/skills/<名字>/ 下的全部文件）、scripts/ 下的一个文件或文件夹各算一项，其他每个文件各算一项
const settingGroup = (rel) => rel.match(/^(\.agents\/skills\/[^/]+|scripts\/[^/]+)/)?.[1] || rel;

const treeMode = (repo, c, rel) => (git(repo, ['ls-tree', c, '--', rel], { allowFail: true }) || '').split(/\s/)[0] || null;

// SKILL.md 开头 description 的内容（> 和 | 写法的多行也认）
function skillDescription(md) {
  const lines = String(md || '').split('\n');
  if (lines[0]?.trim() !== '---') return '';
  let desc = null;
  for (let k = 1; k < lines.length && k < 80; k++) {
    const l = lines[k];
    if (l.trim() === '---') break;
    if (desc !== null) {
      if (/^\s+\S/.test(l)) {
        desc += ` ${l.trim()}`;
        continue;
      }
      break;
    }
    const m = l.match(/^description:\s*(.*)$/);
    if (m) desc = /^[>|][-+]?\s*$/.test(m[1]) ? '' : m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return (desc || '').trim();
}
const firstSentence = (s) => String(s).split(/[。！？!?\n]/)[0].replace(/（[^）]*）|\([^)]*\)/g, '').trim();
// 技能的名字用说明的第一句里冒号、逗号前那一段（"B站视频：读字幕…" → "B站视频"）
function skillTitle(desc) {
  const s = firstSentence(desc);
  const short = s.split(/[：:；;，,]/)[0].trim();
  return short && charLen(short) <= 20 ? short : clip(s, 20);
}

// 装上的官方技能（软链接）的说明：只读官方技能目录里的。链接是机器人自己能改的，指向别处（比如别的机器人的技能）的不读
function linkedSkillMd(repo, commit, rel, botRoot) {
  const target = git(repo, ['show', `${commit}:${rel}`], { allowFail: true });
  if (!target) return '';
  let real;
  try { real = fs.realpathSync(path.resolve(path.dirname(path.join(botRoot, rel)), target.trim())); } catch { return ''; }
  const trusted = TRUSTED_SKILL_DIRS.some((d) => {
    try {
      const r = fs.realpathSync(d);
      return real.startsWith(r + path.sep);
    } catch {
      return false;
    }
  });
  if (!trusted) return '';
  try {
    const p = path.join(real, 'SKILL.md');
    const st = fs.lstatSync(p);
    return st.isFile() && st.size <= 64 * 1024 ? fs.readFileSync(p, 'utf-8') : '';
  } catch {
    return '';
  }
}

// 小工具（脚本）的名字：开头注释、文档字符串里第一句带中文的话；没有就用文件名
function scriptTitle(text, name) {
  let doc = false;
  for (const l of String(text || '').split('\n').slice(0, 25)) {
    const t = l.trim();
    if (/^("""|''')$/.test(t)) {
      doc = !doc;
      continue;
    }
    const m = doc ? [null, t] : t.match(/^(?:#(?!!)|\/\/+|\/\*+|\*|"""|''')\s*(.*?)\s*(?:"""|'''|\*\/)?$/);
    if (m && HAN.test(m[1])) return clip(m[1].replace(/^[-*•]\s*/, ''), 20);
  }
  return path.basename(name).replace(/\.[^.]+$/, '');
}

// 定时任务：每个任务以 id: '…' 开头，到下一个任务为止；只认 id、name、hour、minute、workdaysOnly。
// 任务是 TASKS 数组里的对象：只取括号层数最浅的那些 id（写在一行里的也认），任务代码里更深的 id 不算
function parseTasks(src) {
  const text = String(src || '');
  const marks = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const end = text[i + 1] === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2) + 1;
      i = end <= 0 ? text.length : end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      i = j;
    } else if ('{[('.includes(c)) {
      depth++;
    } else if ('}])'.includes(c)) {
      depth--;
    } else if (c === 'i' && !/[\w$]/.test(text[i - 1] || '')) {
      const m = text.slice(i, i + 200).match(/^id\s*:\s*(['"`])([^'"`\n]+)\1/);
      if (m) marks.push({ id: m[2], at: i, depth });
    }
  }
  // 像任务的（后面跟着 name 或 hour）才算：别的函数里返回的 { id: … } 不算
  const taskLike = marks.filter((m, k) => /\b(?:name|hour)\s*:/.test(text.slice(m.at, marks[k + 1]?.at ?? text.length)));
  const top = Math.min(...taskLike.map((m) => m.depth));
  const tasks = taskLike.filter((m) => m.depth === top);
  return tasks.map((mk, k) => {
    const body = text.slice(mk.at, k + 1 < tasks.length ? tasks[k + 1].at : text.length);
    const str = (key) => body.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`\\n]+)\\1`))?.[2];
    const num = (key) => {
      const v = body.match(new RegExp(`\\b${key}\\s*:\\s*(\\d{1,2})\\b`))?.[1];
      return v === undefined ? null : Number(v);
    };
    return { id: mk.id, name: str('name') || mk.id, hour: num('hour'), minute: num('minute'), workdays: /\bworkdaysOnly\s*:\s*true\b/.test(body), body };
  });
}
function describeTasks(before, after) {
  const a = parseTasks(before);
  const b = parseTasks(after);
  const when = (t) => (t.hour === null ? '' : `${t.workdays ? '工作日' : '每天'} ${t.hour}:${String(t.minute ?? 0).padStart(2, '0')}`);
  const out = [];
  for (const t of b) {
    const o = a.find((x) => x.id === t.id);
    if (!o) out.push(`新加了定时任务「${t.name}」${when(t) ? `（${when(t)}）` : ''}`);
    else if (o.body !== t.body) {
      const moved = when(o) !== when(t) && when(t);
      out.push(moved ? `定时任务「${t.name}」改到了${when(t)}` : `改了定时任务「${t.name}」的内容`);
    }
  }
  for (const o of a) if (!b.some((x) => x.id === o.id)) out.push(`取消了定时任务「${o.name}」`);
  return out.length ? out.join('；') : '定时任务有改动';
}

function describeTopics(before, after) {
  const parse = (s) => {
    if (s === null || s === undefined) return [];
    try {
      const t = JSON.parse(s).topics;
      return Array.isArray(t) ? t : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return '专题设置有改动';
  const nm = (t) => String(t?.name || t?.file || '').replace(/分卷$/, '');
  const out = [];
  for (const t of b) {
    const o = a.find((x) => x?.file === t?.file);
    if (!o) out.push(`新开了一个专题「${nm(t)}」`);
    else if (nm(o) !== nm(t)) out.push(`专题「${nm(o)}」改名叫「${nm(t)}」`);
    else if (JSON.stringify(o.keywords) !== JSON.stringify(t.keywords)) out.push(`专题「${nm(t)}」调整了关键词`);
  }
  for (const o of a) if (!b.some((x) => x?.file === o?.file)) out.push(`去掉了专题「${nm(o)}」`);
  return out.length ? out.join('；') : '专题设置有改动';
}

function describeProfile(before, after) {
  const parse = (s) => {
    if (s === null || s === undefined) return {};
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  if (!a || !b) return '称呼和人设有改动';
  const val = (v) => clip(typeof v === 'string' ? v : JSON.stringify(v), 20);
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    const gone = b[k] === undefined || b[k] === null || b[k] === '';
    if (k === 'bot_name') out.push(gone ? '去掉了名字设置' : `名字改成了「${val(b[k])}」`);
    else if (k === 'user_nickname') out.push(gone ? '去掉了对你的称呼' : `改了对你的称呼：「${val(b[k])}」`);
    else if (k === 'digest_style') out.push(`记忆复盘改成${b[k] === 'plain' ? '不带编号' : '带编号'}的样子`);
    else if (k === 'forbidden_persona') out.push('改了不扮演的角色设定');
    else out.push(gone ? `去掉了「${k}」设置` : `改了「${k}」设置`);
  }
  return out.length ? out.join('；') : '称呼和人设有改动';
}

// 一项设置的改动用大白话怎么说：{ title（存进清单的短名字）, text, desc（「记忆改动」里多给的一句说明） }
function settingPlain({ botRoot, repo, start, to, rel, files, change, link }) {
  const at = change === '删除' ? start : to;
  const show = (c, r) => git(repo, ['show', `${c}:${r}`], { allowFail: true });
  const verb = (add, del, mod) => (change === '新增' ? add : change === '删除' ? del : mod);
  let m = rel.match(/^\.agents\/skills\/([^/]+)$/);
  if (m) {
    const desc = skillDescription(link ? linkedSkillMd(repo, at, rel, botRoot) : show(at, `${rel}/SKILL.md`));
    const title = desc ? skillTitle(desc) : m[1];
    return {
      title: `本事「${title}」`,
      text: verb(`学会了新本事「${title}」`, `不再用「${title}」这个本事了`, link ? `「${title}」这个本事换了个版本` : `改进了自己的本事「${title}」`),
      desc: desc ? clip(firstSentence(desc), 50) : '',
    };
  }
  m = rel.match(/^scripts\/(.+)$/);
  if (m) {
    const main = files.find((f) => /\.(py|m?js|sh|ts)$/.test(f)) || files[0];
    const title = scriptTitle(show(at, main), m[1]);
    return { title: `小工具「${title}」`, text: verb(`新做了一个小工具「${title}」`, `删掉了小工具「${title}」`, `改了小工具「${title}」`) };
  }
  if (/^\.agents\/rules\//.test(rel)) {
    const title = libraryTitle(show(at, rel), rel);
    return { title: `规矩「${title}」`, text: verb(`新定了一条规矩「${title}」`, `去掉了规矩「${title}」`, `改了规矩「${title}」`) };
  }
  if (rel === 'tasks.js') return { title: '定时任务', text: describeTasks(show(start, rel), show(to, rel)) };
  if (rel === 'topics.json') return { title: '专题设置', text: describeTopics(show(start, rel), show(to, rel)) };
  if (rel === 'profile.json') return { title: '称呼和人设', text: describeProfile(show(start, rel), show(to, rel)) };
  if (rel === '.agents/skills.json') return { title: '技能开关', text: '技能开关有改动' };
  const name = path.basename(rel);
  return { title: `设置「${name}」`, text: verb(`新加了设置「${name}」`, `删掉了设置「${name}」`, `改了设置「${name}」`) };
}

/**
 * from..to 之间设置的改动，一项一条：{ kind: 'setting', section: 'setting', bot, rel（这一项的路径）, files, from, to, label, change, link, text, desc }。
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
    if (!groups.has(key)) groups.set(key, { files: [], statuses: new Set() });
    groups.get(key).files.push(rel);
    groups.get(key).statuses.add(status[0]);
  }
  return [...groups].map(([rel, g]) => {
    const change = g.statuses.size === 1 && g.statuses.has('A') ? '新增' : g.statuses.size === 1 && g.statuses.has('D') ? '删除' : '修改';
    const link = g.files.length === 1 && treeMode(repo, change === '删除' ? start : to, g.files[0]) === '120000';
    const plain = settingPlain({ botRoot, repo, start, to, rel, files: g.files, change, link });
    return { kind: 'setting', section: 'setting', bot, rel, files: g.files, from: start, to, label: plain.title, change, link, text: plain.text, desc: plain.desc || '' };
  });
}

// ---------- 汇报的样子 ----------
const SECTIONS = [
  ['new', '🆕 新记住的'],
  ['update', '🔄 更新的'],
  ['gone', '🗑 不再记的'],
  ['event', '📅 昨天的事'],
  ['library', '📚 存进资料的'],
  ['tidy', '🧹 收拾了一下'],
  ['setting', '⚙️ 新本事和设置'],
];
const SECTION_ORDER = Object.fromEntries(SECTIONS.map(([k], i) => [k, i]));

// 记忆里给智能体自己看的引用（"（细节见资料库 ai_tools/xxx.md）"、data/memory/… 路径）：汇报里去掉，用户不需要看到文件路径。
// 只去掉显示的字，记忆文件不动
const MEMORY_REFS = [
  /\s*[（(][^（）()]*(?:资料库|data\/memory\/)[^（）()]*[）)]/g,
  /[，,；;]?\s*(?:细节|详情|全文|原文)?\s*(?:详见|参见|见|存在|放在|在)?\s*资料库\s*[\w一-鿿.\-/]+\.md/g,
  /\s*\S*data\/memory\/\S*/g,
];
const showText = (s) => {
  const t = MEMORY_REFS.reduce((x, re) => x.replace(re, ''), String(s)).trim();
  return t || '（一句指向资料的备注）';
};

// 一条改动在汇报里怎么说。full：「记忆改动」里，写得全一些
function describe(it, { full = false, multiDay = false } = {}) {
  const max = full ? 150 : 60;
  if (it.section === 'update') {
    const [o, n] = [showText(it.oldText), showText(it.newText)];
    // 只改了指向资料的那句备注（比如换了一份资料）：内容没变，就这么说
    return o === n && it.oldText !== it.newText ? `${clip(n, max)}（改了一处指向资料的备注）` : updateText(o, n, max);
  }
  if (it.section === 'event') return `${multiDay && it.date ? `${it.date} ` : ''}${clip(showText(it.text), max)}`;
  if (it.section === 'new' || it.section === 'gone') return clip(showText(it.text), max);
  return clip(it.text, full ? 200 : 80);
}

// 「记忆改动」里一条下面多给的几行：搬走的是哪几条、资料里加了什么、技能是做什么的
function detailLines(it) {
  const list = (xs, more) => [...xs.slice(0, 3).map((t) => `· ${clip(showText(t), 60)}`), ...(xs.length > 3 ? [more(xs.length)] : [])];
  if (it.section === 'tidy') return [...list(it.examples, (n) => `…一共 ${n} 条`), ...it.leave.slice(0, 1).map((t) => `原处留了一句：${clip(showText(t), 60)}`)];
  if (it.section === 'gone' && it.kind === 'file') return list(it.examples || [], (n) => `…一共 ${n} 条`);
  if (it.section === 'library') return list(it.examples, (n) => `…一共加了 ${n} 条`);
  if (it.section === 'setting' && it.desc) return [`（${it.desc}）`];
  return [];
}

// 按分类排好的一行行：[{ text, n }]，分类的标题没有 n
function digestRows(items, { numbered = true, full = false, yesterday = false } = {}) {
  const multiDay = new Set(items.filter((i) => i.section === 'event' && i.date).map((i) => i.date)).size > 1;
  const rows = [];
  for (const [key, title] of SECTIONS) {
    const list = items.filter((i) => i.section === key);
    if (!list.length) continue;
    rows.push({ text: key === 'event' && !yesterday ? '📅 记下的事' : title });
    for (const it of list) {
      const lines = [`${numbered ? `${it.n}.` : '•'} ${describe(it, { full, multiDay })}`];
      if (full) lines.push(...detailLines(it).map((l) => `   ${l}`));
      rows.push({ text: lines.join('\n'), n: it.n });
    }
  }
  return rows;
}

function sinceText(ms) {
  if (!ms) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const bjDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(ms));
// 上一份是昨天发的（北京时间）：这一份就是"昨天的记忆复盘"
const isYesterday = (since, now = Date.now()) => Boolean(since) && bjDay(since) === bjDay(now - 86400_000);

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

// 一个实例从 from 到最新一版的改动，按分类排好，编号从 1 开始
function botItems(botRoot, from) {
  const repo = ensureRepo(path.basename(botRoot));
  const to = head(repo);
  const start = isCommit(repo, from) ? from : to;
  const botName = displayName(botRoot);
  const items = diffItems(botRoot, start, to).map((it, i) => ({ ...it, botName, n: i + 1 }));
  return { items, range: { from: start, to } };
}

// 超上限的核心档案和专题：如实说聊天时有没有被截断、夜里会怎么处理（资料库、大事记没有上限）
function overLimitNotes(botRoot) {
  const notes = [];
  for (const f of listMemoryFiles(botRoot)) {
    if (!Number.isFinite(f.max)) continue;
    let n = 0;
    try { n = charCount(readBotFile(botRoot, f.abs).toString('utf-8')); } catch { continue; }
    if (n <= f.max) continue;
    const name = f.kind === 'core' ? '常用记忆' : `「${f.label}」专题`;
    const cut = n > f.max * 2 ? `现在聊天时只带得上前 ${f.max * 2} 字，` : '';
    notes.push(`⚠️ ${name}有点多了（${n} 字，上限 ${f.max} 字）。${cut}夜里整理时会把旧的、细节的挪进资料，不会丢。`);
  }
  return notes;
}

// 存进 review.json 的清单只留定位用的字段，不存内容
const storedItem = ({ n, bot, rel, from, to, hunk, op, label, botName, kind, files, section }) => ({ n, bot, rel, from, to, hunk, op, label, botName, kind, files, section });
// 整个文件退回改之前（设置、资料库，还有 11-18 以前清单里的大事记）；其余逐行撤（以前的清单按段反向打补丁）
const fileLevel = (it) => it.kind === 'setting' || it.kind === 'file';

/**
 * 早间的记忆复盘：按分类列，带编号的可以「撤销 N」；不带编号的（digest_style: plain）用 • 列，记错了直接跟机器人说。
 * notes 附在后面（超上限的提醒、管理员看到的"别的机器人有设置变化"）
 */
function digestText(items, since, notes = [], { numbered = true, botName = '' } = {}) {
  const yesterday = isYesterday(since);
  const cap = numbered ? DIGEST_MAX_ITEMS : PLAIN_MAX_ITEMS;
  const lines = [yesterday ? `📝 昨天的记忆复盘（${sinceText(since).slice(0, 5)}）` : since ? `📝 记忆复盘（${sinceText(since)} 以来）` : '📝 记忆复盘'];
  lines.push(...digestRows(items.slice(0, cap), { numbered, yesterday }).map((r) => r.text));
  if (items.length > cap) lines.push(numbered ? `还有 ${items.length - cap} 条，回「记忆改动」看全部。` : `另外还有 ${items.length - cap} 条小改动，就不一一列了。`);
  lines.push(...notes);
  if (!numbered) lines.push(`哪里记得不对，直接告诉${botName}是哪件事就行～`);
  else lines.push(items.length > 1 ? '哪条记错了，回「撤销 2」这样撤回。' : '记错了的话，回「撤销 1」撤回。');
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
    return { bot, text: digestText(items, since, overLimitNotes(botRoot)), items: items.map(storedItem), range };
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
 * 按分类列、带编号，接着回「撤销 N」就按这份的编号撤。
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
    if (!items.length) return `最近一份复盘以来，${whose}记忆没有变化（或者改动都已经撤销了）。`;
    // 从哪一版列起，就写那一版的时间（以前写的是早间汇报发出的时间，可清单里还有发之前的改动）
    const since = last?.from ? commitTime(repoDir(bot), last.from) : state.reported_at?.[bot] || commitTime(repoDir(bot), range.from);
    const out = [`📝 ${whose}记忆改动（${since ? `${sinceText(since)} 以来，` : ''}共 ${items.length} 条）`];
    // 和早间复盘一样按分类列，写得全一些（搬走的是哪几条、资料里加了什么）；太长就不写细节，还长就列到放得下为止
    const size = (rows) => rows.reduce((n, r) => n + charLen(r.text) + 1, 0);
    let rows = digestRows(items, { full: true });
    if (size(rows) > LIST_MAX_CHARS) rows = digestRows(items);
    let used = 0;
    for (const r of rows) {
      if (r.n && used + charLen(r.text) > LIST_MAX_CHARS) {
        if (out.length > 1 && !/^\d+\./.test(out[out.length - 1])) out.pop();
        out.push(`……后面还有 ${items.length - r.n + 1} 条没列出来，「撤销 全部」也会撤销它们。`);
        break;
      }
      out.push(r.text);
      used += charLen(r.text) + 1;
    }
    out.push(...overLimitNotes(botRoot));
    out.push('回「撤销 编号」撤回（可以写多个，比如「撤销 1 3」），「撤销 全部」全部撤回。编号以这份清单为准。');
    return out.join('\n');
  });
}

// ---------- 沙箱实例的早间汇报 ----------
// 沙箱里被代管的实例读不到记忆历史：主人的机器人把它还没汇报过的改动整理成一段文字，放进它自己的
// data/state/memory_digest.json（归它自己的账号）；它的早间播报附上这段，发出去后写 memory_digest_ack.json
const pendingFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest.json');
const ackFile = (botRoot) => path.join(botRoot, 'data', 'state', 'memory_digest_ack.json');

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
      // id 开头的 r2：11-18 换成大白话的复盘以后重新写一份（升级前写好、还没发的那份是旧样子）
      const id = `r2-${from.slice(0, 10)}-${to.slice(0, 10)}${pointers.map((p) => `-${p.bot}${p.to.slice(0, 6)}`).join('')}`;
      if (current?.id === id) continue;
      const { items } = from === to ? { items: [] } : botItems(botRoot, from);
      if (!items.length && !pointers.length) {
        if (current) fs.rmSync(file, { force: true });
        continue;
      }
      const since = state.reported_at?.[bot] || commitTime(repo, from);
      const pointerLines = pointers.map((p) => `⚙️ ${p.name}有 ${p.n} 处新本事或设置变化，回「${p.name}改动」看。`);
      const text = items.length
        ? digestText(items, since, [...overLimitNotes(botRoot), ...pointerLines], { numbered, botName: displayName(botRoot) })
        : pointerLines.join('\n');
      writeJsonForBot(botRoot, file, { id, at: Date.now(), count: items.length, text });
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

// ---------- 逐行撤销（11-18 起的清单） ----------
// 在现在的内容里找一行：先找一模一样的，没有再按"去掉日期标记、列表符号以后相同"找；有好几处取离原来位置最近的。
// skip 里的位置不算（同一条里有两行一样时，别找到同一处）
function findLine(cur, raw, near, skip = null) {
  const hits = [];
  for (let x = 0; x < cur.length; x++) if (!skip?.has(x) && cur[x] === raw) hits.push(x);
  if (!hits.length && !isStructural(raw)) {
    const n = normalizeLine(raw);
    for (let x = 0; x < cur.length; x++) if (!skip?.has(x) && normalizeLine(cur[x]) === n) hits.push(x);
  }
  if (!hits.length) return -1;
  return hits.reduce((b, x) => (Math.abs(x - near) < Math.abs(b - near) ? x : b));
}
const headingAbove = (cur, x) => {
  for (let k = x - 1; k >= 0; k--) if (HEADING.test(cur[k])) return k;
  return -1;
};

// 把改之后的几行（toLines 里的行号）从现在的内容里拿掉；有一行找不到就返回 null（不改）。拿掉的行上面最近的标题记进 heads
function removeLines(cur, toLines, js, heads) {
  const xs = new Set();
  for (const j of js) {
    const x = findLine(cur, toLines[j], j, xs);
    if (x < 0) return null;
    xs.add(x);
  }
  for (const x of xs) {
    const h = headingAbove(cur, x);
    if (h >= 0 && !xs.has(h)) heads.add(cur[h]);
  }
  return cur.filter((_, x) => !xs.has(x));
}

// 把改之前的第 a..b 行放回去：往上找改之前在它前面、现在还在的一行，放在它后面（原来中间隔着空行、现在也有的话跳过）；
// 上面都找不到就往下找，放在它前面；原来就在开头的放回开头；文件现在是空的直接放进去。都不行返回 false
function insertRun(cur, fromLines, a, b) {
  const lines = fromLines.slice(a, b + 1);
  let blanks = 0;
  let above = false;
  for (let k = a - 1; k >= 0 && a - k <= 80; k--) {
    if (!fromLines[k].trim()) {
      blanks++;
      continue;
    }
    above = true;
    const x = findLine(cur, fromLines[k], k);
    if (x < 0) {
      blanks = 0;
      continue;
    }
    let pos = x + 1;
    for (let s = 0; s < blanks && pos < cur.length && !cur[pos].trim(); s++) pos++;
    cur.splice(pos, 0, ...lines);
    return true;
  }
  if (!above) {
    cur.splice(0, 0, ...lines);
    return true;
  }
  let after = 0;
  for (let k = b + 1; k < fromLines.length && k - b <= 80; k++) {
    if (!fromLines[k].trim()) {
      after++;
      continue;
    }
    const x = findLine(cur, fromLines[k], k);
    if (x < 0) {
      after = 0;
      continue;
    }
    let pos = x;
    for (let s = 0; s < after && pos > 0 && !cur[pos - 1].trim(); s++) pos--;
    cur.splice(pos, 0, ...lines);
    return true;
  }
  if (!cur.some((l) => l.trim())) {
    cur.splice(0, 0, ...lines);
    return true;
  }
  return false;
}

const runsOf = (idxs) => {
  const runs = [];
  for (const i of [...new Set(idxs)].sort((x, y) => x - y)) {
    const r = runs[runs.length - 1];
    if (r && i === r[1] + 1) r[1] = i;
    else runs.push([i, i]);
  }
  return runs;
};

// 撤销以后空了的标题（这一段改动里新加的、下面已经没有内容了）连同它下面的空行一起拿掉；它上一级的标题也再看一遍
function dropEmptyHeadings(cur, heads, added) {
  for (let again = true; again;) {
    again = false;
    for (let x = 0; x < cur.length; x++) {
      if (!heads.has(cur[x]) || !added.has(cur[x])) continue;
      let k = x + 1;
      while (k < cur.length && !cur[k].trim()) k++;
      if (k < cur.length && !(HEADING.test(cur[k]) && headingLevel(cur[k]) <= headingLevel(cur[x]))) continue;
      const up = headingAbove(cur, x);
      if (up >= 0) heads.add(cur[up]);
      cur.splice(x, k - x);
      again = true;
      break;
    }
  }
  return cur;
}

// 撤销以后的空行：原来没有连着的两个空行，就把撤出来的连着的空行并成一个；开头、结尾跟原来一样
function tidyBlank(text, fd) {
  const ref = fd.fromText ?? fd.toText ?? '';
  let t = text;
  if (!/\n[ \t]*\n[ \t]*\n/.test(ref)) t = t.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n');
  if (!/^[ \t]*\n/.test(ref)) t = t.replace(/^(?:[ \t]*\n)+/, '');
  t = t.replace(/(?:\n[ \t]*)+$/, '');
  return t && (!ref || ref.endsWith('\n')) ? `${t}\n` : t;
}

/**
 * 在一个文件现在的内容里撤销几条（同一个 from..to 重新算出来的 cs）：先把改了的换回去、新加的拿掉，
 * 再把删掉的、搬走的按改之前的位置放回去（从上往下）。返回 { text, ok: Set(这个文件里的第几处) }
 */
function undoInFile(text, cs) {
  const { fd } = cs[0];
  let cur = text.split('\n');
  const ok = new Set();
  const heads = new Set();
  for (const c of cs.filter((x) => x.lineOp.type === 'update')) {
    const [i] = c.lineOp.del;
    const [j] = c.lineOp.add;
    const x = findLine(cur, fd.toLines[j], j);
    if (x >= 0) {
      cur[x] = fd.fromLines[i];
      ok.add(c.op);
    } else if (findLine(cur, fd.fromLines[i], i) >= 0) {
      ok.add(c.op); // 已经是改之前的样子了
    }
  }
  for (const c of cs.filter((x) => x.lineOp.type === 'new' || x.lineOp.type === 'event')) {
    const next = removeLines(cur, fd.toLines, c.lineOp.add, heads);
    if (next) {
      cur = next;
      ok.add(c.op);
    }
  }
  const back = cs.filter((x) => ['gone', 'move', 'dup'].includes(x.lineOp.type))
    .sort((x, y) => Math.min(...x.lineOp.del) - Math.min(...y.lineOp.del));
  for (const c of back) {
    let next = cur.slice();
    // 原处留的一句结论拿掉（后来改过、找不到就算了）
    for (const j of c.lineOp.leave || []) next = removeLines(next, fd.toLines, [j], heads) || next;
    // 内容都已经在了（后来又加回来了）就不用再放
    const content = c.lineOp.del.filter((i) => !isStructural(fd.fromLines[i]));
    if (!content.every((i) => findLine(next, fd.fromLines[i], i) >= 0)
      && !runsOf(c.lineOp.del).every(([a, b]) => insertRun(next, fd.fromLines, a, b))) continue;
    cur = next;
    ok.add(c.op);
  }
  dropEmptyHeadings(cur, heads, fd.addedHeads);
  return { text: tidyBlank(cur.join('\n'), fd), ok };
}

/**
 * 逐行的那几条（11-18 起的清单）：按清单那一版（from..to）重新算出每一条，在现在的文件里撤；对不上、找不到的不硬改。
 * 搬去别的专题的，那边原样多出来的行也拿掉。done / failed 收结果，desc 记每条撤的是什么（回复里用）
 */
function undoLineItems(botsDir, todo, { done, failed, touch, desc }) {
  const groups = new Map();
  for (const it of todo) {
    const key = `${it.bot}\n${it.from}\n${it.to}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  for (const list of groups.values()) {
    const { bot, from, to } = list[0];
    const repo = repoDir(bot);
    if (!isCommit(repo, from) || !isCommit(repo, to)) {
      failed.push(...list);
      continue;
    }
    const computed = diffItems(path.join(botsDir, bot), from, to, { memoryOnly: true });
    const byRel = new Map();
    for (const it of list) {
      const c = computed.find((x) => x.rel === it.rel && x.op === it.op && x.kind === it.kind);
      if (!c) {
        failed.push(it);
        continue;
      }
      desc.set(it, c);
      if (!byRel.has(it.rel)) byRel.set(it.rel, []);
      byRel.get(it.rel).push({ it, c });
    }
    const receivers = [];
    for (const [rel, pairs] of byRel) {
      const file = path.join(repo, rel);
      let text = null;
      try { text = fs.readFileSync(file, 'utf-8'); } catch {}
      if (text === null) {
        failed.push(...pairs.map((p) => p.it));
        continue;
      }
      const res = undoInFile(text, pairs.map((p) => p.c));
      for (const p of pairs) {
        if (!res.ok.has(p.c.op)) {
          failed.push(p.it);
          continue;
        }
        done.push(p.it);
        receivers.push(...(p.c.lineOp.receivers || []));
      }
      if (res.text === text) continue;
      if (!res.text.trim() && pairs[0].c.fd.fromText === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, res.text);
      touch(bot, rel);
    }
    // 搬去别的专题、核心档案的：那边原样多出来的同样的行一起拿掉（后来改过、找不到就算了）
    const byDest = new Map();
    for (const r of receivers) {
      if (!byDest.has(r.rel)) byDest.set(r.rel, []);
      byDest.get(r.rel).push(r.j);
    }
    for (const [rel, js] of byDest) {
      const fd = computed.fds.get(rel);
      const file = path.join(repo, rel);
      let text = null;
      try { text = fs.readFileSync(file, 'utf-8'); } catch {}
      if (!fd || text === null) continue;
      let cur = text.split('\n');
      const heads = new Set();
      for (const j of js) cur = removeLines(cur, fd.toLines, [j], heads) || cur;
      dropEmptyHeadings(cur, heads, fd.addedHeads);
      const next = tidyBlank(cur.join('\n'), fd);
      if (next === text) continue;
      fs.writeFileSync(file, next);
      touch(bot, rel);
    }
  }
}

/**
 * 撤销最近一份清单里的几条（selection 是编号数组，或 'all'）。返回给主人的回复。
 * 先把线上现状存一版；逐行的按清单那一版重新算出来撤，资料和设置整个文件退回改之前；后来又被改过的不硬改，告诉主人。
 */
// scope：「撤销记忆 全部」只撤记忆那几条（'memory'，默认），「撤销 全部」连设置一起撤（'all'）；写了编号的按编号撤
export function undoItems(selection, { botsDir = DEFAULT_BOTS_DIR, viewer = null, scope = 'memory' } = {}) {
  return withLock(() => {
    const state = loadReview();
    const who = viewer || settings.only || ownerBotName();
    const shown = shownFor(state, who);
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
    const desc = new Map();
    if (todo.length) {
      snapshotAllUnlocked(botsDir, { force: true });
      const touched = new Map();
      const touch = (bot, rel) => {
        if (!touched.has(bot)) touched.set(bot, new Set());
        touched.get(bot).add(rel);
      };
      // 升级前发出的清单（按段算的）：反向打补丁，同一个文件从后往前撤，前面那些段的行号不受影响
      const order = todo.filter((i) => !fileLevel(i) && i.op === undefined)
        .sort((a, b) => a.bot.localeCompare(b.bot) || a.rel.localeCompare(b.rel) || b.hunk - a.hunk);
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
        touch(it.bot, it.rel);
      }
      undoLineItems(botsDir, todo.filter((i) => !fileLevel(i) && i.op !== undefined), { done, failed, touch, desc });
      // 设置按项、资料库（还有以前清单里的大事记）按文件，整个退回改之前的样子（新增的就删掉）；后来又改过就不硬改
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
          touch(it.bot, rel);
        }
        done.push(it);
      }
      for (const [bot, rels] of touched) {
        const botRoot = path.join(botsDir, bot);
        const repo = repoDir(bot);
        for (const rel of rels) writeBack(botRoot, repo, rel);
        git(repo, ['add', '-A']);
        if (!git(repo, ['status', '--porcelain']).trim()) continue;
        const nums = done.filter((d) => d.bot === bot).map((d) => d.n).sort((a, b) => a - b);
        git(repo, ['commit', '-q', '-m', '撤销', '-m', `撤销清单第 ${nums.join('、')} 条`]);
      }
      for (const it of shown.items) if (done.some((d) => d.n === it.n)) it.undone = true;
      saveReview(state);
    }
    // 撤的是哪一条：逐行的说内容，资料、设置说名字；别的机器人的加上它的名字
    const what = (d) => {
      const c = desc.get(d);
      const s = c ? `「${clip(showText(c.section === 'update' ? c.newText : c.text), 24)}」` : d.op === undefined && !fileLevel(d) ? `「${d.label}」` : d.label;
      return d.botName && d.bot !== who ? `${d.botName}的${s}` : s;
    };
    const parts = [];
    if (done.length === 1) parts.push(`已撤销第 ${done[0].n} 条：${what(done[0])}。`);
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
