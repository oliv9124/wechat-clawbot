import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 清理两个大脑的旧会话。每个机器人的 routine 进程每天跑一次，只动它自己能动的文件：
 *   Antigravity：$HOME/.gemini/antigravity-cli/ 下 conversations/<会话>.db、brain/<会话>/、annotations/<会话>.pbtxt、presence/<会话>.lock
 *   GPT（Codex）：CODEX_HOME/sessions/年/月/日/rollout-…-<会话>.jsonl、generated_images/<会话>/（只在开了 GPT 大脑、
 *                 有自己的 CLAWBOT_CODEX_HOME 时才清，不碰别人的 Codex）
 *   画过的图：data/images/、data/gpt-images/ 里的图片（早就发给主人了）
 * 会话超过 days 天没动过、而且没被运行状态记着（正在用的会话 ID 一律保留）才删；图片超过 mediaDays 天才删。
 * 记忆、聊天记录、主人发来的文件、登录信息都不碰。dryRun 只统计、不删。
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(UUID, 'gi');
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

function ls(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// 文件或文件夹（往里看几层）最新的修改时间和总大小；不跟随软链接
function scan(p, depth = 0) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return { exists: false, mtime: 0, bytes: 0 };
  }
  if (!st.isDirectory()) return { exists: true, mtime: st.mtimeMs, bytes: st.size };
  let mtime = st.mtimeMs;
  let bytes = 0;
  if (depth < 8) {
    for (const e of ls(p)) {
      const r = scan(path.join(p, e.name), depth + 1);
      mtime = Math.max(mtime, r.mtime);
      bytes += r.bytes;
    }
  }
  return { exists: true, mtime, bytes };
}

/**
 * 运行状态里记着的会话 ID：这个机器人自己的 data/state/*.json，加上同一个 bots/ 目录下读得到的其他机器人的
 * （以 root 跑的几个机器人共用一个 HOME，别把别人的会话删了）；extra 是进程里正在用、还没写进状态的
 */
export function referencedIds(botRoot, extra = []) {
  const ids = new Set();
  const add = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(UUID_RE)) ids.add(m[0].toLowerCase());
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) add(x);
    }
  };
  const botsDir = path.dirname(botRoot);
  const roots = new Set([botRoot]);
  for (const e of ls(botsDir)) if (e.isDirectory()) roots.add(path.join(botsDir, e.name));
  for (const root of roots) {
    const dir = path.join(root, 'data', 'state');
    for (const e of ls(dir)) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      try {
        add(JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')));
      } catch {}
    }
  }
  add(extra);
  return ids;
}

// moveTo：不删，挪进这个目录（保留原来的完整路径），第一次清理时用，出了问题能放回去
export function cleanupOldSessions({
  botRoot, home = '', codexHome = '', keepIds = new Set(), days = 14, mediaDays = 30, dryRun = false, moveTo = '', now = Date.now(),
}) {
  const out = { agy: 0, codex: 0, images: 0, bytes: 0, errors: 0, dryRun, moveTo };
  const drop = (p, bytes) => {
    if (!dryRun) {
      try {
        if (moveTo) {
          const dest = path.join(moveTo, path.relative('/', p));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(p, dest);
        } else {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch {
        out.errors++;
        return false;
      }
    }
    out.bytes += bytes;
    return true;
  };

  if (days > 0) {
    const cutoff = now - days * 86400_000;

    // 1. Antigravity：会话库和它的附属文件一起看，最近一次改动早于 cutoff 才删
    if (home) {
      const base = path.join(home, '.gemini', 'antigravity-cli');
      const seen = new Set();
      for (const e of ls(path.join(base, 'conversations'))) {
        const m = e.name.match(new RegExp(`^(${UUID})\\.db$`, 'i'));
        if (!m || !e.isFile()) continue;
        const id = m[1];
        seen.add(id.toLowerCase());
        if (keepIds.has(id.toLowerCase())) continue;
        const parts = [
          path.join(base, 'conversations', e.name),
          path.join(base, 'brain', id),
          path.join(base, 'annotations', `${id}.pbtxt`),
          path.join(base, 'presence', `${id}.lock`),
        ].map((p) => ({ p, ...scan(p) }));
        if (Math.max(...parts.map((x) => x.mtime)) >= cutoff) continue;
        if (!drop(parts[0].p, parts[0].bytes)) continue;
        out.agy++;
        for (const x of parts.slice(1)) if (x.exists) drop(x.p, x.bytes);
      }
      // 会话库早就没了、只剩下的 brain/<会话>/
      for (const e of ls(path.join(base, 'brain'))) {
        const id = e.name.toLowerCase();
        if (!e.isDirectory() || seen.has(id) || keepIds.has(id) || !new RegExp(`^${UUID}$`, 'i').test(id)) continue;
        const x = scan(path.join(base, 'brain', e.name));
        if (x.mtime < cutoff && drop(path.join(base, 'brain', e.name), x.bytes)) out.agy++;
      }
    }

    // 2. GPT（Codex）：会话记录 rollout-…-<会话>.jsonl，和它自带生图工具存的图
    if (codexHome) {
      const sessions = path.join(codexHome, 'sessions');
      for (const y of ls(sessions)) {
        if (!y.isDirectory()) continue;
        for (const mo of ls(path.join(sessions, y.name))) {
          if (!mo.isDirectory()) continue;
          for (const d of ls(path.join(sessions, y.name, mo.name))) {
            if (!d.isDirectory()) continue;
            const dir = path.join(sessions, y.name, mo.name, d.name);
            for (const f of ls(dir)) {
              const m = f.name.match(new RegExp(`^rollout-.*-(${UUID})\\.jsonl$`, 'i'));
              if (!m || !f.isFile() || keepIds.has(m[1].toLowerCase())) continue;
              const x = scan(path.join(dir, f.name));
              if (x.mtime < cutoff && drop(path.join(dir, f.name), x.bytes)) out.codex++;
            }
            if (!dryRun && !ls(dir).length) try { fs.rmdirSync(dir); } catch {}
          }
          if (!dryRun && !ls(path.join(sessions, y.name, mo.name)).length) try { fs.rmdirSync(path.join(sessions, y.name, mo.name)); } catch {}
        }
      }
      const gen = path.join(codexHome, 'generated_images');
      for (const e of ls(gen)) {
        if (!e.isDirectory() || keepIds.has(e.name.toLowerCase())) continue;
        const x = scan(path.join(gen, e.name));
        if (x.mtime < cutoff) drop(path.join(gen, e.name), x.bytes);
      }
    }
  }

  // 3. 画过的图（已经发给主人了）
  if (mediaDays > 0 && botRoot) {
    const mediaCutoff = now - mediaDays * 86400_000;
    for (const sub of ['images', 'gpt-images']) {
      const dir = path.join(botRoot, 'data', sub);
      for (const e of ls(dir)) {
        if (!e.isFile() || !IMAGE_RE.test(e.name)) continue;
        const x = scan(path.join(dir, e.name));
        if (x.mtime < mediaCutoff && drop(path.join(dir, e.name), x.bytes)) out.images++;
      }
    }
  }
  return out;
}

export function describeCleanup(r) {
  const mb = (r.bytes / 1048576).toFixed(1);
  return `${r.dryRun ? '可以清理（只统计，没删）' : r.moveTo ? `挪走了（在 ${r.moveTo}）` : '清理了'}：Antigravity 旧会话 ${r.agy} 个、GPT 旧会话 ${r.codex} 个、旧图片 ${r.images} 张，共 ${mb} MB`
    + (r.errors ? `（${r.errors} 个没弄掉）` : '');
}

// 命令行（在机器人目录里跑，HOME 和 CLAWBOT_CODEX_HOME 跟机器人服务里一样）：
//   node ../../core/session_cleanup.js                    只统计、不删
//   node ../../core/session_cleanup.js --delete           真删
//   node ../../core/session_cleanup.js --move-to <目录>   不删，挪进这个目录
//   可加 --days 14 --media-days 30
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const num = (flag, dflt) => {
    const i = args.indexOf(flag);
    return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : dflt;
  };
  const botRoot = process.cwd();
  const mi = args.indexOf('--move-to');
  const moveTo = mi >= 0 && args[mi + 1] ? path.resolve(args[mi + 1]) : '';
  const r = cleanupOldSessions({
    botRoot,
    home: process.env.HOME || '',
    codexHome: process.env.CLAWBOT_CODEX_HOME || '',
    keepIds: referencedIds(botRoot),
    days: num('--days', 14),
    mediaDays: num('--media-days', 30),
    dryRun: !args.includes('--delete') && !moveTo,
    moveTo,
  });
  console.log(describeCleanup(r));
}
