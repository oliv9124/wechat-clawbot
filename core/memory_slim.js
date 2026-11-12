/**
 * 记忆整理的公共部分（凌晨整理、一次性迁移都用它）：
 *
 * 1. 在副本上整理：prepareWorkCopy → 智能体交一张改动清单（numberMemory 给条目编号、parseChangeList 解析）→ applyChangeList 照清单改副本
 *    → collectChanges → checkChanges 核对 → applyChanges 合并回线上。一段聊天只调一次智能体，它不碰任何文件。
 *    整理失败就丢掉副本，线上不会留下改了一半的文件。整理期间线上文件又被白天的对话改过的，用 git merge-file 三方合并；
 *    合并不了就保留线上的，把整理结果另存到 data/state/consolidation-conflicts/ 并告警。
 * 2. 腾地方 slimFile：核心档案或某本专题超上限时，智能体只出一份"搬家清单"（哪些条目搬去资料库哪个文件），
 *    由程序把条目原样搬过去，一个字不改，所以不会丢；📌 置顶的条目不搬。搬完再核对一遍：搬走的每一行都要在目的地找得到。
 * 3. 命令行（管理员用）：
 *      node memory_slim.js migrate <实例目录或它的副本> [--rounds 4]   超上限的文件一个个腾地方，直到都在上限以内
 *      node memory_slim.js apply <线上实例目录> --base <迁移前的副本> --new <迁移后的副本>   把迁移结果合并回线上
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listMemoryFiles, loadTopicsConfig, normalizeLine, charCount, memoryKind,
  TOPICS_DIR, LIBRARY_DIR, TIMELINE_DIR,
} from './memory_config.js';
import { AGY_STREAM_ARGS, agyInputLine, agyOutcome } from './agent_health.js';

export const WORK_DIR = 'data/state/consolidation-work';
const CONFLICT_DIR = 'data/state/consolidation-conflicts';
const SLIM_STATE = 'data/state/memory_slim.json';
const LIBRARY_MAX_DEPTH = 3;

const linesOf = (text) => String(text ?? '').split('\n');

function readOrNull(abs) {
  try {
    if (!fs.lstatSync(abs).isFile()) return null; // 软链接、目录都当没有
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

// ---------- 安全写文件 ----------
// 写进实例目录：目的地（含新建的上级目录）必须真的在实例目录里，不跟着软链接走出去；
// 先写临时文件再改名，读的人永远看不到写了一半的内容。root 运行时（管理员迁移）新文件归这个机器人自己的账号
function ownerOfData(botRoot) {
  try { return fs.statSync(path.join(botRoot, 'data')); } catch { return fs.statSync(botRoot); }
}

function ensureParent(botRoot, abs) {
  const rootReal = fs.realpathSync(botRoot);
  const missing = [];
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) {
    missing.unshift(dir);
    dir = path.dirname(dir);
  }
  const real = fs.realpathSync(dir);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error(`${path.relative(botRoot, abs)} 的位置不在实例目录里，不写`);
  }
  const owner = ownerOfData(botRoot);
  for (const d of missing) {
    fs.mkdirSync(d);
    if (process.getuid?.() === 0) fs.chownSync(d, owner.uid, owner.gid);
  }
}

export function writeFileSafe(botRoot, rel, content) {
  const abs = path.join(botRoot, rel);
  ensureParent(botRoot, abs);
  let st = null;
  try { st = fs.lstatSync(abs); } catch {}
  const old = st && st.isFile() ? st : null;
  const owner = old || ownerOfData(botRoot);
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: old ? old.mode & 0o777 : 0o640 });
  if (process.getuid?.() === 0) fs.chownSync(tmp, owner.uid, owner.gid);
  fs.renameSync(tmp, abs);
}

// ---------- 副本 ----------
const memorySet = (botRoot) => [...listMemoryFiles(botRoot).map((f) => f.rel), 'topics.json'];

/** 把记忆（含 topics.json）复制到 data/state/consolidation-work/；返回 { dir, base }，base：rel → 复制时的内容（没有为 null） */
export function prepareWorkCopy(botRoot) {
  const dir = path.join(botRoot, WORK_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const base = new Map();
  for (const rel of memorySet(botRoot)) {
    const content = readOrNull(path.join(botRoot, rel));
    base.set(rel, content);
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  for (const d of [TOPICS_DIR, LIBRARY_DIR, TIMELINE_DIR]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  return { dir, base };
}

export function discardWorkCopy(work) {
  if (work?.dir) fs.rmSync(work.dir, { recursive: true, force: true });
}

/** 副本里改了什么：[{ rel, before, after }]，after 为 null 表示删掉了 */
export function collectChanges(work) {
  const files = [];
  const walk = (sub, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(work.dir, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 8) walk(rel, depth + 1);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk('', 0);
  const changes = [];
  const seen = new Set(files);
  for (const rel of files) {
    const after = fs.readFileSync(path.join(work.dir, rel), 'utf-8');
    const before = work.base.has(rel) ? work.base.get(rel) : null;
    if (after !== before) changes.push({ rel, before, after });
  }
  for (const [rel, before] of work.base) {
    if (before !== null && !seen.has(rel)) changes.push({ rel, before, after: null });
  }
  return changes;
}

// 整理只能动这些文件：核心档案、topics.json、专题、大事记（按月）、资料库（最多往下 3 层）
const SAFE_PART = /^[\p{L}\p{N}_\-. ()（）]+$/u;
export function allowedRel(rel) {
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.') || !SAFE_PART.test(p))) return false;
  if (rel === 'MEMORY.md' || rel === 'topics.json') return true;
  if (/^data\/memory\/topics\/[^/]+\.md$/.test(rel)) return true;
  if (/^data\/memory\/timeline\/\d{4}-\d{2}\.md$/.test(rel)) return true;
  // data/memory/library/ 下最多 3 层目录，再加文件名
  return rel.startsWith(`${LIBRARY_DIR}/`) && rel.endsWith('.md') && parts.length <= 4 + LIBRARY_MAX_DEPTH;
}

/**
 * 核对一次整理的改动。返回 { ok, reason, changes, notes }：
 *  - 记忆目录以外的、删掉整个文件的、改坏 topics.json 的，不采用（记在 notes 里），其余照常；
 *  - 大事记和资料库只能往里加：原有的行被删改了，整次不采用；
 *  - 核心档案和专题里删掉的内容，在整理后的全部记忆里都找不到的算"丢失"：丢了超过 1500 字、或者丢了 4 行以上并且超过这个文件一半的行、
 *    或者 📌 置顶的行变少了，整次不采用（置顶的内容可以改，不能少；要删置顶的，用户白天当面说）。
 */
export function checkChanges(work, changes, { maxLost = 1500 } = {}) {
  const notes = [];
  const kept = [];
  for (const c of changes) {
    // 智能体自己留下的隐藏文件（缓存之类）不算改动，不提
    if (c.rel.split('/').some((p) => p.startsWith('.'))) continue;
    if (!allowedRel(c.rel)) { notes.push(`${c.rel} 不在记忆目录里，没有采用`); continue; }
    if (c.after === null) { notes.push(`整理时删掉了 ${c.rel}，没有采用`); continue; }
    if (c.rel === 'topics.json') {
      try {
        if (!Array.isArray(JSON.parse(c.after).topics)) throw new Error('没有 topics 列表');
      } catch (e) {
        notes.push(`topics.json 改坏了（${e.message}），没有采用`);
        continue;
      }
    }
    const kind = memoryKind(c.rel);
    if ((kind === 'timeline' || kind === 'library') && c.before) {
      const now = new Set(linesOf(c.after).map(normalizeLine));
      const gone = linesOf(c.before).map(normalizeLine).filter((l) => l && !now.has(l));
      if (gone.length) {
        return { ok: false, reason: `${kind === 'timeline' ? '大事记' : '资料库'} ${c.rel} 里原有的 ${gone.length} 行被删改了（这里只能往里加）`, changes: [], notes };
      }
    }
    kept.push(c);
  }
  const after = new Map(work.base);
  for (const c of kept) after.set(c.rel, c.after);
  const haystack = [...after.entries()]
    .filter(([rel, text]) => text !== null && rel !== 'topics.json')
    .map(([, text]) => linesOf(text).map(normalizeLine).join('\n'))
    .join('\n');
  for (const c of kept) {
    const kind = memoryKind(c.rel);
    if ((kind !== 'core' && kind !== 'topic') || !c.before) continue;
    const pins = (t) => linesOf(t).filter((l) => l.includes('📌')).length;
    if (pins(c.after) < pins(c.before)) {
      return { ok: false, reason: `${c.rel} 里 📌 置顶的条目少了 ${pins(c.before) - pins(c.after)} 条`, changes: [], notes };
    }
    const nowLines = new Set(linesOf(c.after).map(normalizeLine));
    const content = linesOf(c.before).filter((l) => normalizeLine(l) && !/^#/.test(l.trim()));
    let lost = 0;
    let lostLines = 0;
    for (const l of content) {
      const n = normalizeLine(l);
      if (charCount(n) < 6 || nowLines.has(n) || haystack.includes(n)) continue;
      lost += charCount(n);
      lostLines++;
    }
    if (lost > maxLost || (lostLines >= 4 && lostLines > content.length / 2)) {
      return { ok: false, reason: `${c.rel} 有 ${lostLines} 行（${lost} 字）删掉以后在记忆里哪都找不到`, changes: [], notes };
    }
  }
  return { ok: true, reason: '', changes: kept, notes };
}

// 三方合并：ours 是现在线上的，base 是整理开始时的，theirs 是整理结果。合并不了返回 null
function merge3(ours, base, theirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-merge-'));
  try {
    const p = (n, t) => { const f = path.join(dir, n); fs.writeFileSync(f, t); return f; };
    const args = ['merge-file', '-p', '-q', p('ours', ours), p('base', base), p('theirs', theirs)];
    try {
      return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
    } catch (e) {
      return null; // 退出码大于 0：有冲突
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

/**
 * 把改动写回线上：线上文件没变过就直接换上；变过就三方合并；合并不了保留线上的，把整理结果另存。
 * 返回 { applied: [rel], conflicts: [{ rel, saved }] }
 */
export function applyChanges(botRoot, changes) {
  const applied = [];
  const conflicts = [];
  const conflictDir = path.join(CONFLICT_DIR, stamp());
  for (const c of changes) {
    if (c.after === null) continue;
    const live = readOrNull(path.join(botRoot, c.rel));
    let next = c.after;
    if (live !== c.before) {
      if (live === c.after) continue;
      next = merge3(live ?? '', c.before ?? '', c.after);
      if (next === null) {
        const saved = path.join(conflictDir, c.rel);
        try { writeFileSafe(botRoot, saved, c.after); } catch {}
        conflicts.push({ rel: c.rel, saved });
        continue;
      }
    }
    writeFileSafe(botRoot, c.rel, next);
    applied.push(c.rel);
  }
  return { applied, conflicts };
}

// ---------- 凌晨整理：改动清单 ----------
// 智能体不再自己改文件（一段聊天要和模型来回十几到几十次，模型一慢就超时、整段作废）：
// 一段只调一次智能体，它交一张改动清单（JSON），程序照着改副本，再走上面的核对、合并。

const ITEM_START = /^\s*(?:[-*+•]|\d+[.)、])\s+/;
const asId = (x) => {
  const m = String(x ?? '').match(/\d+/);
  return m ? `#${m[0]}` : '';
};

/**
 * 核心档案和各本专题按条目编号给智能体看：编号全局唯一（#1、#2…），标题、空行照原样。
 * files：[{ rel, label, kind }]。返回 { parts: [{ file, listing, size }], index: Map(编号 → { rel, i }), segsByRel: Map(rel → 段) }
 */
export function numberMemory(dir, files) {
  let n = 0;
  const index = new Map();
  const segsByRel = new Map();
  const parts = [];
  for (const f of files) {
    const text = readOrNull(path.join(dir, f.rel)) ?? '';
    const segs = splitBlocks(text);
    segsByRel.set(f.rel, segs);
    const lines = segs.map((s, i) => {
      if (s.type === 'heading') return s.lines[0];
      if (s.type === 'gap') return '';
      const id = `#${++n}`;
      index.set(id, { rel: f.rel, i });
      return `[${id}] ${s.text}`;
    });
    parts.push({ file: f, listing: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), size: charCount(text) });
  }
  return { parts, index, segsByRel };
}

/** 从智能体的回复里取出改动清单 { replace, insert, library, timeline, newTopics }；没有能用的 JSON 就报错 */
export function parseChangeList(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON');
  let j;
  try {
    j = JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error(`JSON 解析不了：${e.message}`);
  }
  if (!j || typeof j !== 'object' || !['replace', 'insert', 'library', 'timeline', 'new_topics'].some((k) => Array.isArray(j[k]))) {
    throw new Error('JSON 里没有 replace / insert / library / timeline');
  }
  const arr = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
  const str = (x) => (typeof x === 'string' ? x : '');
  return {
    replace: arr(j.replace).filter((x) => asId(x.id) && typeof x.text === 'string').map((x) => ({ id: asId(x.id), text: x.text })),
    insert: arr(j.insert).filter((x) => str(x.text).trim()).map((x) => ({ after: String(x.after ?? '').trim(), text: x.text })),
    library: arr(j.library).filter((x) => str(x.file).trim() && str(x.text).trim()).map((x) => ({ file: x.file.trim(), text: x.text })),
    timeline: (Array.isArray(j.timeline) ? j.timeline : []).map((x) => str(x).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean),
    newTopics: arr(j.new_topics).filter((x) => str(x.name).trim() && str(x.file).trim()).map((x) => ({
      name: x.name.trim(),
      file: x.file.trim(),
      keywords: (Array.isArray(x.keywords) ? x.keywords : []).map((k) => String(k).trim()).filter(Boolean).slice(0, 20),
      text: str(x.text),
    })),
  };
}

const textLines = (text) => {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
};
// 新加的条目：没有列表符号的行补上"- "（标题、表格、缩进的子项、空行、已有列表符号的照旧）
const asItemLines = (text) => textLines(text).map((l) => (!l || /^\s/.test(l) || /^#{1,6}\s/.test(l) || l.startsWith('|') || ITEM_START.test(l) ? l : `- ${l}`));

/**
 * 照改动清单改副本（dir）。不合规的项跳过、记进 notes，其余照改：
 *  - replace：编号要存在；带 📌 的条目不删，改写后也要留着 📌；text 为空表示删掉这一条（用户要求忘掉时用）；
 *  - insert：加在某一条后面（after 写编号），或者加到某个文件末尾（after 写 MEMORY.md 或专题文件名）；
 *  - library：只往资料库文件末尾追加，没有就新建，路径必须在资料库里；
 *  - timeline：加在当月大事记「## 月-日」下面（同一天已经有这一节就接着写）；
 *  - newTopics：建专题文件、登记到 topics.json；已经有的专题，内容加到它末尾。
 * 返回 { notes, counts }
 */
export function applyChangeList(dir, list, { day, numbered }) {
  const notes = [];
  const counts = { replace: 0, delete: 0, insert: 0, library: 0, timeline: 0, newTopics: 0 };
  const edits = new Map();
  const editOf = (rel) => {
    if (!edits.has(rel)) edits.set(rel, { replaced: new Map(), after: new Map(), tail: [] });
    return edits.get(rel);
  };
  const relOfName = (name) => {
    const s = String(name || '').trim().replace(/\\/g, '/').replace(/^[[【「"']+|[\]】」"']+$/g, '');
    if (!s) return null;
    if (/^(?:MEMORY(?:\.md)?|核心档案|核心)$/i.test(s)) return 'MEMORY.md';
    const base = path.basename(s);
    const file = base.endsWith('.md') ? base : `${base}.md`;
    for (const rel of numbered.segsByRel.keys()) if (rel !== 'MEMORY.md' && path.basename(rel) === file) return rel;
    const label = s.replace(/^专题[:：]?\s*/, '');
    const hit = numbered.parts.find((p) => p.file.kind === 'topic' && p.file.label === label);
    return hit ? hit.file.rel : null;
  };

  for (const r of list.replace) {
    const at = numbered.index.get(r.id);
    if (!at) { notes.push(`没有 ${r.id} 这一条，改不了`); continue; }
    const seg = numbered.segsByRel.get(at.rel)[at.i];
    const e = editOf(at.rel);
    if (e.replaced.has(at.i)) { notes.push(`${r.id} 改了不止一次，只用第一次的`); continue; }
    const lines = textLines(r.text);
    if (!lines.length) {
      if (seg.pinned) { notes.push(`${r.id} 是 📌 置顶的，不删`); continue; }
      e.replaced.set(at.i, null);
      counts.delete++;
      continue;
    }
    if (seg.pinned && !lines.join('\n').includes('📌')) { notes.push(`${r.id} 是 📌 置顶的，改写后没有 📌，没有采用`); continue; }
    // 原来是列表项，新写的第一行没有列表符号：补上，保持文件格式
    if (ITEM_START.test(seg.lines[0]) && !ITEM_START.test(lines[0]) && !/^#{1,6}\s/.test(lines[0])) lines[0] = `- ${lines[0]}`;
    e.replaced.set(at.i, lines);
    counts.replace++;
  }

  for (const ins of list.insert) {
    const lines = asItemLines(ins.text);
    if (!lines.length) continue;
    if (/^\[?#?\d+\]?$/.test(ins.after)) {
      const at = numbered.index.get(asId(ins.after));
      if (!at) { notes.push(`没有 ${asId(ins.after)} 这一条，"${oneLine(ins.text, 20)}"不知道加在哪`); continue; }
      const e = editOf(at.rel);
      if (!e.after.has(at.i)) e.after.set(at.i, []);
      e.after.get(at.i).push(...lines);
      counts.insert++;
      continue;
    }
    const rel = relOfName(ins.after);
    if (!rel) { notes.push(`不知道加到哪：「${oneLine(ins.after, 30)}」`); continue; }
    editOf(rel).tail.push(...lines);
    counts.insert++;
  }

  // 新专题：已经有的（按文件名或名字）就把内容加到它末尾；真正新建的最后再写
  const created = [];
  let cfg = null;
  for (const t of list.newTopics) {
    const file = `${path.basename(t.file.replace(/\\/g, '/')).replace(/\.md$/i, '')}.md`;
    const existing = relOfName(file) || relOfName(t.name);
    if (existing && existing !== 'MEMORY.md') {
      const lines = asItemLines(t.text);
      if (lines.length) { editOf(existing).tail.push(...lines); counts.insert++; }
      notes.push(`专题「${t.name}」已经有了，内容加到了它末尾`);
      continue;
    }
    if (!/^[A-Za-z0-9_-]+\.md$/.test(file)) { notes.push(`新专题的文件名「${oneLine(t.file, 30)}」不合规（只能用英文字母、数字、_ 和 -）`); continue; }
    if (cfg === null) {
      try {
        cfg = JSON.parse(readOrNull(path.join(dir, 'topics.json')) ?? '{"topics":[]}');
        if (!Array.isArray(cfg.topics)) cfg.topics = [];
      } catch {
        notes.push('topics.json 读不出来，没有新建专题');
        cfg = false;
      }
    }
    if (!cfg) continue;
    const rel = `${TOPICS_DIR}/${file}`;
    if (cfg.topics.some((x) => x?.file === file || x?.name === t.name) || readOrNull(path.join(dir, rel)) !== null) {
      notes.push(`专题「${t.name}」（${file}）已经登记过，没有重复新建`);
      continue;
    }
    cfg.topics.push({ name: t.name, file, keywords: t.keywords.length ? t.keywords : [t.name] });
    created.push({ rel, text: `# ${t.name}\n${asItemLines(t.text).length ? `\n${asItemLines(t.text).join('\n')}\n` : ''}` });
    counts.newTopics++;
  }

  // 核心档案和专题：按段重新拼，没改的行原样保留
  for (const [rel, e] of edits) {
    const out = [];
    numbered.segsByRel.get(rel).forEach((s, i) => {
      if (s.type === 'item' && e.replaced.has(i)) {
        const r = e.replaced.get(i);
        if (r) out.push(...r);
      } else {
        out.push(...s.lines);
      }
      if (e.after.has(i)) out.push(...e.after.get(i));
    });
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push(...e.tail);
    writeFileSafe(dir, rel, `${out.join('\n')}\n`);
  }

  for (const lib of list.library) {
    let t = lib.file.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(?:data\/memory\/library|资料库)\/+/, '');
    if (t && !t.endsWith('.md')) t = `${t}.md`;
    const rel = `${LIBRARY_DIR}/${t}`;
    if (!t || !allowedRel(rel)) { notes.push(`资料库路径「${oneLine(lib.file, 40)}」不合规`); continue; }
    const old = readOrNull(path.join(dir, rel));
    const body = textLines(lib.text).join('\n');
    const next = old === null
      ? `${body.startsWith('#') ? '' : `# ${path.basename(rel, '.md')}\n\n`}${body}\n`
      : `${old.replace(/\s+$/, '')}\n\n${body}\n`;
    writeFileSafe(dir, rel, next);
    counts.library++;
  }

  if (list.timeline.length) {
    const rel = `${TIMELINE_DIR}/${day.slice(0, 7)}.md`;
    const md = day.slice(5);
    let text = (readOrNull(path.join(dir, rel)) ?? `# ${day.slice(0, 7)} 大事记\n`).replace(/\s+$/, '');
    const heads = text.match(/^## .*$/gm) || [];
    if (heads[heads.length - 1]?.trim() !== `## ${md}`) text += `\n\n## ${md}`;
    text += `\n${list.timeline.map((l) => (ITEM_START.test(l) ? l : `- ${l}`)).join('\n')}\n`;
    writeFileSafe(dir, rel, text);
    counts.timeline += list.timeline.length;
  }

  for (const c of created) writeFileSafe(dir, c.rel, c.text);
  if (created.length) writeFileSafe(dir, 'topics.json', `${JSON.stringify(cfg, null, 2)}\n`);
  return { notes, counts };
}

// ---------- 腾地方 ----------
/**
 * 把记忆文件拆成段：标题（# 开头）、空行、条目（列表项连同下面缩进的子项和续行；普通段落、表格也各算一条）。
 * 条目有编号 B1、B2…，记下所在的标题、是否置顶（含 📌）、最后一次聊到的日期（末尾的〔月-日〕）
 */
export function splitBlocks(text) {
  const segs = [];
  const headings = [];
  let cur = null;
  const flush = () => { if (cur) segs.push(cur); cur = null; };
  for (const line of linesOf(text)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, title: h[2].trim() });
      segs.push({ type: 'heading', lines: [line], level });
      continue;
    }
    if (!line.trim()) {
      flush();
      segs.push({ type: 'gap', lines: [line] });
      continue;
    }
    const itemStart = /^\s*(?:[-*+•]|\d+[.)、])\s+/.test(line);
    const indented = /^(?:\s{2,}|\t)\S/.test(line);
    if (cur && (!itemStart || indented)) {
      cur.lines.push(line);
      continue;
    }
    flush();
    cur = { type: 'item', lines: [line], path: headings.map((x) => x.title) };
  }
  flush();
  let n = 0;
  for (const s of segs) {
    if (s.type !== 'item') continue;
    s.id = `B${++n}`;
    s.text = s.lines.join('\n');
    s.pinned = s.text.includes('📌');
    const dates = [...s.text.matchAll(/〔((?:\d{4}-)?\d{1,2}-\d{1,2})〕/g)].map((m) => m[1]);
    s.date = dates.length ? dates[dates.length - 1] : null;
  }
  return segs;
}

const joinSegs = (segs) => segs.map((s) => s.lines.join('\n')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');

function clipText(text, n) {
  const c = [...text];
  return c.length > n ? `${c.slice(0, n).join('')}…（这一条共 ${c.length} 字）` : text;
}

export function slimPrompt({ label, rel, kind, segs, size, cap, target, stem, topicFiles, libraryFiles }) {
  const listing = segs.map((s) => {
    if (s.type === 'heading') return s.lines[0];
    if (s.type === 'gap') return '';
    return `[${s.id}]${s.pinned ? '（📌 置顶，不能搬）' : ''} ${clipText(s.text, 1500)}`;
  }).join('\n').replace(/\n{3,}/g, '\n\n');
  const coreNote = kind === 'core'
    ? `\n这是核心档案，只留每次聊天都要用的（身份、称呼、偏好、底线、正在进行的事）。属于某个专题的条目搬进那个专题，to 写 "topic:文件名"（现有专题：${topicFiles.join('、') || '无'}）；资料性的搬进资料库。`
    : '';
  const existing = libraryFiles.length ? libraryFiles.slice(0, 80).map((f) => `- ${f}`).join('\n') : '（资料库还是空的）';
  return `你在帮一个微信助理整理它的记忆文件「${label}」（${rel}）。它现在 ${size} 字，上限 ${cap} 字。
任务：选出一些条目搬到资料库，让这个文件降到 ${target} 字以内。你只要给出"搬家清单"，搬运由程序完成：条目会一字不改地搬过去，不会丢，以后需要时还能查到。

怎么选（按顺序考虑）：
1. 资料性的细节：参数、价格、型号、步骤、对比、教程、长篇解释。搬到资料库，原处可以留一句结论（leave）。
2. 很久没聊到的条目：条目末尾的〔月-日〕是最后一次聊到的日期，没有日期的算最旧。
3. 意思重复的几条：一起搬走，leave 写一句合并后的结论。
不能搬：标了 📌 的条目；用户的身份、称呼、底线；正在进行、还没结束的事。${coreNote}

资料库的文件按主题分，to 写相对资料库的路径，比如 "${stem}/某个主题.md"，一个文件一个主题，可以用已有的文件：
${existing}

只输出一个 JSON，不要任何别的文字：
{"moves":[{"blocks":["B3","B4"],"to":"${stem}/某个主题.md","leave":"可选：留在原处的一句结论，40 字以内"}]}

下面是这个文件的全部条目，[编号] 后面是原文：
${listing}`;
}

/** 从智能体的回复里取出搬家清单 { moves: [{ blocks, to, leave }] } */
export function parsePlan(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON');
  const plan = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(plan?.moves)) throw new Error('JSON 里没有 moves');
  return {
    moves: plan.moves
      .filter((m) => m && Array.isArray(m.blocks) && typeof m.to === 'string')
      .map((m) => ({ blocks: m.blocks.map(String), to: m.to.trim(), leave: typeof m.leave === 'string' ? m.leave : '' })),
  };
}

// 搬到哪：资料库里的相对路径（最多 3 层，只能用文字、数字和 _-.()），核心档案还可以搬进某本专题（topic:文件名）
function destinationOf(to, { kind, topicFiles }) {
  let t = String(to || '').trim().replace(/\\/g, '/');
  const topic = t.match(/^topic:\s*(.+)$/i);
  if (topic) {
    if (kind !== 'core') return null;
    const file = path.basename(topic[1].trim().replace(/^data\/memory\/topics\//, ''));
    const name = file.endsWith('.md') ? file : `${file}.md`;
    return topicFiles.includes(name) ? `${TOPICS_DIR}/${name}` : null;
  }
  t = t.replace(/^\/+/, '').replace(/^(?:data\/memory\/library|资料库)\/+/, '');
  if (!t) return null;
  if (!t.endsWith('.md')) t = `${t}.md`;
  const rel = `${LIBRARY_DIR}/${t}`;
  return allowedRel(rel) ? rel : null;
}

const oneLine = (s, n) => [...String(s || '').replace(/\s+/g, ' ').trim()].slice(0, n).join('');

/**
 * 按搬家清单搬：返回 { text（搬完的原文件）, appends: Map(目的地 → 追加的文字), moved: [{ to, ids, chars }], skipped: [说明] }。
 * 置顶的、编号不存在的、重复的条目不搬；目的地不合规的整项不搬。追加的内容按原来所在的标题分组，原文照抄。
 */
export function applyPlan(segs, plan, { label, kind, today, topicFiles = [] }) {
  const items = new Map(segs.filter((s) => s.type === 'item').map((s) => [s.id, s]));
  const taken = new Map();
  const appends = new Map();
  const moved = [];
  const skipped = [];
  for (const mv of plan.moves) {
    const dest = destinationOf(mv.to, { kind, topicFiles });
    if (!dest) { skipped.push(`目的地「${mv.to}」不合规`); continue; }
    const ids = mv.blocks.filter((id) => {
      const s = items.get(id);
      if (!s) { skipped.push(`没有 ${id}`); return false; }
      if (s.pinned) { skipped.push(`${id} 是置顶的`); return false; }
      if (taken.has(id)) return false;
      return true;
    });
    if (!ids.length) continue;
    const parts = [];
    let lastPath = null;
    for (const id of ids) {
      const s = items.get(id);
      taken.set(id, dest);
      const where = s.path.join(' / ');
      if (where && where !== lastPath) parts.push(`### ${where}`);
      lastPath = where;
      parts.push(s.text);
    }
    if (!appends.has(dest)) appends.set(dest, [`## 从「${label}」搬来（${today}）`]);
    appends.get(dest).push(...parts);
    const leave = oneLine(mv.leave, 80);
    if (leave) {
      const short = dest.startsWith(`${TOPICS_DIR}/`) ? `专题 ${path.basename(dest)}` : `资料库 ${dest.slice(LIBRARY_DIR.length + 1)}`;
      items.get(ids[0]).replacement = `- ${leave}（细节见${short}）`;
    }
    moved.push({ to: dest, ids, chars: ids.reduce((n, id) => n + charCount(items.get(id).text), 0) });
  }
  let rest = segs
    .filter((s) => s.type !== 'item' || !taken.has(s.id) || s.replacement)
    .map((s) => (s.type === 'item' && taken.has(s.id) ? { type: 'item', lines: [s.replacement] } : s));
  // 搬空了的标题去掉（标题已经跟着条目写到目的地了）
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].type !== 'heading') continue;
      let j = i + 1;
      let hasItem = false;
      for (; j < rest.length && !(rest[j].type === 'heading' && rest[j].level <= rest[i].level); j++) {
        if (rest[j].type !== 'gap') { hasItem = true; break; }
      }
      if (!hasItem) {
        rest = [...rest.slice(0, i), ...rest.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return {
    text: `${joinSegs(rest).replace(/\s+$/, '')}\n`,
    appends: new Map([...appends].map(([k, v]) => [k, `\n\n${v.join('\n')}\n`])),
    moved,
    skipped,
  };
}

/** 核对：原文件里少掉的每一行（标题、空行、搬走后留下的结论行除外）都要原样出现在目的地；置顶的行一行都不能少。有问题返回说明 */
export function verifySlim(oldText, newText, destTexts) {
  const now = new Set(linesOf(newText).map(normalizeLine));
  // 按整行比：目的地要有一模一样的一行（只忽略列表符号、日期标记和空白），改写过的不算
  const dest = new Set(destTexts.flatMap((t) => linesOf(t).map(normalizeLine)));
  for (const l of linesOf(oldText)) {
    const n = normalizeLine(l);
    if (!n || /^#/.test(l.trim()) || now.has(n)) continue;
    if (l.includes('📌')) return `置顶的一行不见了：${oneLine(n, 30)}`;
    if (!dest.has(n)) return `有一行搬走后在目的地找不到：${oneLine(n, 30)}`;
  }
  return null;
}

/** 用 agy 出搬家清单：在一个空目录里跑，只要它的文字回复 */
export function agyPlanAgent(botRoot, { timeoutMs = Number(process.env.CLAWBOT_SLIM_TIMEOUT_MS) || 1_200_000 } = {}) {
  return (prompt) => new Promise((resolve, reject) => {
    const cwd = path.join(botRoot, 'data', 'state', 'slim-agent');
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    const child = execFile('agy', ['--dangerously-skip-permissions', ...AGY_STREAM_ARGS],
      { cwd, timeout: timeoutMs, env: process.env, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.rmSync(cwd, { recursive: true, force: true });
        const outcome = agyOutcome(err, stdout, stderr);
        if (!outcome.ok) return reject(Object.assign(new Error(outcome.reason), { outcome }));
        resolve(String(outcome.json?.response || ''));
      });
    child.stdin.on('error', () => {});
    child.stdin.end(agyInputLine(prompt));
  });
}

function recordSlim(botRoot, entry) {
  const file = path.join(botRoot, SLIM_STATE);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  const entries = [...(Array.isArray(state.entries) ? state.entries : []), entry].slice(-30);
  try { writeFileSafe(botRoot, SLIM_STATE, JSON.stringify({ entries }, null, 2)); } catch (e) { console.warn('[腾地方] 记录写不进去:', e.message); }
}

/**
 * 给一个超上限的文件腾地方。runPlanAgent(prompt) 返回智能体的文字回复（里面有搬家清单）。
 * 返回 { ok, rel, label, before, after, moved: [{ to, count, chars }], conflicts, reason }
 */
export async function slimFile(botRoot, rel, { runPlanAgent, today, targetRatio = 0.8 } = {}) {
  const files = listMemoryFiles(botRoot);
  const f = files.find((x) => x.rel === rel);
  const before = readOrNull(path.join(botRoot, rel));
  if (!f || before === null || !Number.isFinite(f.max)) return { ok: false, rel, reason: '这个文件不需要腾地方' };
  const size = charCount(before);
  if (size <= f.max) return { ok: true, rel, label: f.label, before: size, after: size, moved: [], skipped: true };
  const segs = splitBlocks(before);
  const topicFiles = [...new Set([...loadTopicsConfig(botRoot).map((t) => t.file), ...files.filter((x) => x.kind === 'topic').map((x) => path.basename(x.rel))])];
  const libraryFiles = files.filter((x) => x.kind === 'library').map((x) => x.rel.slice(LIBRARY_DIR.length + 1));
  const stem = f.kind === 'core' ? '核心档案' : path.basename(rel, '.md');
  const target = Math.floor(f.max * targetRatio);
  const prompt = slimPrompt({ label: f.label, rel, kind: f.kind, segs, size, cap: f.max, target, stem, topicFiles, libraryFiles });
  let plan;
  try {
    plan = parsePlan(await runPlanAgent(prompt));
  } catch (e) {
    return { ok: false, rel, label: f.label, reason: `没拿到能用的搬家清单：${e.message}` };
  }
  const res = applyPlan(segs, plan, { label: f.label, kind: f.kind, today, topicFiles });
  if (!res.moved.length) return { ok: false, rel, label: f.label, reason: `搬家清单里没有能搬的条目${res.skipped.length ? `（${res.skipped.slice(0, 3).join('；')}）` : ''}` };
  const writes = [{ rel, before, after: res.text }];
  for (const [dest, add] of res.appends) {
    const old = readOrNull(path.join(botRoot, dest));
    const head = old ?? (dest.startsWith(`${LIBRARY_DIR}/`) ? `# ${path.basename(dest, '.md')}（资料，从记忆里原样搬来）\n` : '');
    writes.push({ rel: dest, before: old, after: `${head.replace(/\s+$/, '')}${add}` });
  }
  const problem = verifySlim(before, res.text, writes.slice(1).map((w) => w.after));
  if (problem) return { ok: false, rel, label: f.label, reason: `核对没通过：${problem}` };
  // 先写目的地、再改原文件：中途出错最多是资料库里多一份，不会丢
  let applied;
  let conflicts;
  try {
    ({ applied, conflicts } = applyChanges(botRoot, [...writes.slice(1), writes[0]]));
  } catch (e) {
    return { ok: false, rel, label: f.label, reason: `写文件出错：${e.message}` };
  }
  const after = charCount(readOrNull(path.join(botRoot, rel)) ?? res.text);
  const moved = res.moved.map((m) => ({ to: m.to, count: m.ids.length, chars: m.chars }));
  const result = { ok: !conflicts.some((c) => c.rel === rel), rel, label: f.label, before: size, after, moved, applied, conflicts, skipped: res.skipped };
  if (result.ok) recordSlim(botRoot, { at: Date.now(), rel, label: f.label, before: size, after, moved });
  return result;
}

/** 超上限的核心档案和专题，按"核心档案先、其余从大到小"排 */
export function overLimitFiles(botRoot) {
  return listMemoryFiles(botRoot)
    .filter((f) => f.kind === 'core' || f.kind === 'topic')
    .map((f) => ({ ...f, size: charCount(readOrNull(f.abs) ?? '') }))
    .filter((f) => f.size > f.max)
    .sort((a, b) => (a.kind === 'core' ? -1 : b.kind === 'core' ? 1 : b.size - a.size));
}

// ---------- 命令行 ----------
const beijingToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

async function migrate(botRoot, { rounds = 4, quiet = false } = {}) {
  const agent = agyPlanAgent(botRoot);
  const report = [];
  for (let r = 1; r <= rounds; r++) {
    const over = overLimitFiles(botRoot);
    if (!over.length) break;
    for (const f of over) {
      if (!quiet) console.log(`[第 ${r} 轮] ${f.label}（${f.rel}）${f.size} 字，上限 ${f.max}…`);
      const res = await slimFile(botRoot, f.rel, { runPlanAgent: agent, today: beijingToday() });
      report.push({ round: r, ...res });
      if (!quiet) console.log(res.ok ? `   → ${res.after} 字，搬了 ${res.moved.reduce((n, m) => n + m.count, 0)} 条到 ${res.moved.map((m) => m.to).join('、')}` : `   → 没有完成：${res.reason}`);
    }
  }
  return { report, remaining: overLimitFiles(botRoot).map((f) => ({ rel: f.rel, size: f.size, max: f.max })) };
}

function applyMigration(botRoot, baseDir, newDir) {
  const rels = new Set([...memorySet(baseDir), ...memorySet(newDir)]);
  const changes = [];
  for (const rel of rels) {
    if (!allowedRel(rel)) continue;
    const before = readOrNull(path.join(baseDir, rel));
    const after = readOrNull(path.join(newDir, rel));
    if (after !== null && after !== before) changes.push({ rel, before, after });
  }
  // 资料库、专题先写，核心档案和被搬空的文件最后写
  changes.sort((a, b) => Number(memoryKind(a.rel) !== 'library') - Number(memoryKind(b.rel) !== 'library'));
  return applyChanges(botRoot, changes);
}

async function main(argv) {
  const [cmd, target, ...rest] = argv;
  const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === 'migrate' && target) {
    const out = await migrate(path.resolve(target), { rounds: Number(opt('--rounds')) || 4 });
    if (opt('--report')) fs.writeFileSync(opt('--report'), JSON.stringify(out, null, 2));
    console.log(out.remaining.length ? `还有 ${out.remaining.length} 个文件超上限：${out.remaining.map((r) => `${r.rel} ${r.size}`).join('、')}` : '全部在上限以内');
    return;
  }
  if (cmd === 'apply' && target && opt('--base') && opt('--new')) {
    // 管理服务存版本时据此标成"一次性搬家"
    writeFileSafe(path.resolve(target), 'data/state/memory_migration.json', JSON.stringify({ at: Date.now() }));
    const res = applyMigration(path.resolve(target), path.resolve(opt('--base')), path.resolve(opt('--new')));
    console.log(JSON.stringify(res));
    if (res.conflicts.length) process.exitCode = 2;
    return;
  }
  console.log('用法：node memory_slim.js migrate <实例目录> [--rounds 4] [--report out.json]\n      node memory_slim.js apply <线上实例目录> --base <迁移前副本> --new <迁移后副本>');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
