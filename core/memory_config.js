import fs from 'node:fs';
import path from 'node:path';

// 聊天日志里的"会话已重置"标记：组装最近对话和凌晨记忆整理都只看它之后的内容
export const RESET_MARKER = '[会话已重置]';
// 只有一整条日志就是这个标记（前面是日志时间）才算重置；用户在聊天里引用这几个字不算
const RESET_ENTRY = /^\[\d{4}-\d{2}-\d{2}T[^\]\n]*\]\s*\[会话已重置\][ \t]*$/;
export const isResetEntry = (block) => RESET_ENTRY.test(String(block ?? '').trim());

/*
 * 记忆分四块（都在实例目录里，字数按字符算）：
 *   核心档案 MEMORY.md：每条消息都带，上限 MEMORY_MAX_CHARS；
 *   专题 data/memory/topics/*.md：聊到才带，每条消息最多带 MAX_TOPICS_PER_MESSAGE 本，每本上限 TOPIC_MAX_CHARS；
 *   资料库 data/memory/library/**.md：调研资料、参数、原文，平时不带，智能体需要细节时自己去读，不限量；
 *   大事记 data/memory/timeline/YYYY-MM.md：每天几行，平时不带，问到以前的事才带，永久保留。
 * 核心档案和专题超上限时，凌晨整理把旧的、细节的条目原样搬去资料库（只搬不删，程序核对，见 memory_slim.js）。
 */
export const MEMORY_MAX_CHARS = 3000;
export const TOPIC_MAX_CHARS = 5000;
export const MAX_TOPICS_PER_MESSAGE = 2;
export const TIMELINE_LOAD_MAX_CHARS = 3000;
// 已取消"小专题每条消息都带"：专题只在聊到时带。留着这个名字只为兼容旧代码
export const TOPIC_ALWAYS_BUDGET = 0;
export const TOPICS_DIR = 'data/memory/topics';
export const LIBRARY_DIR = 'data/memory/library';
export const TIMELINE_DIR = 'data/memory/timeline';
// 资料库最多列多少个文件、往下几层（防止写坏的目录拖慢每次存版本）
const LIBRARY_MAX_FILES = 2000;
const LIBRARY_MAX_DEPTH = 3;

/**
 * 读取实例自己的专题分卷配置 <实例目录>/topics.json：
 *   { "topics": [ { "name": "专题名", "file": "xxx.md", "keywords": ["关键词", ...] } ] }
 * 专题文件放在 <实例目录>/data/memory/topics/ 下。没有这个文件时返回 []（不加载任何专题）。
 */
export function loadTopicsConfig(botRoot) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(botRoot, 'topics.json'), 'utf-8');
  } catch {
    return [];
  }
  try {
    return (JSON.parse(raw).topics || [])
      .filter((t) => t && typeof t.file === 'string' && Array.isArray(t.keywords))
      .map((t) => ({ name: t.name || t.file, file: path.basename(t.file), keywords: t.keywords.map(String) }));
  } catch (err) {
    console.warn(`[topics.json] 内容不是合法的 JSON，本次不加载专题分卷: ${err.message}`);
    return [];
  }
}

// 只保留最后一次"会话已重置"之后的日志内容（只认整条日志就是重置标记的那种）
export function textAfterLastReset(text) {
  const s = String(text ?? '');
  const re = /^\[\d{4}-\d{2}-\d{2}T[^\]\n]*\]\s*\[会话已重置\][ \t]*$/gm;
  let last = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) last = m.index + m[0].length;
  return last < 0 ? s : s.slice(last);
}

export const charCount = (text) => [...String(text ?? '')].length;

/**
 * 加载进上下文的记忆：超过上限也照常全部带上（当晚整理时搬走旧条目）；
 * 超过上限两倍才截断，防止一个写坏的文件拖累每条消息，并且如实写明少带了多少。返回 { text, truncated }
 */
export function capForLoading(text, maxChars) {
  const chars = [...String(text ?? '')];
  if (chars.length <= maxChars * 2) return { text: chars.join(''), truncated: false };
  const kept = maxChars * 2;
  return {
    text: `${chars.slice(0, kept).join('')}\n...（这份记忆有 ${chars.length} 字，超出上限太多，这次只带了前 ${kept} 字，后面 ${chars.length - kept} 字没带上）`,
    truncated: true,
  };
}

// 条目末尾的日期标记〔11-05〕〔2026-11-05〕：最后一次聊到这条的日期
export const DATE_TAG = /\s*〔(?:\d{4}-)?\d{1,2}-\d{1,2}〕/g;

// 核对"原样搬走"用的规范化：去掉列表符号、日期标记、加粗和行内代码记号，空白压成一个
export function normalizeLine(line) {
  return String(line ?? '')
    .replace(DATE_TAG, '')
    .replace(/^\s*(?:[-*+•]|\d+[.)、])\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function listDir(botRoot, rel, recursive) {
  const out = [];
  const walk = (sub, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(botRoot, rel, sub), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= LIBRARY_MAX_FILES || e.name.startsWith('.')) continue;
      const name = sub ? `${sub}/${e.name}` : e.name;
      // Dirent 看的是链接本身：软链接既不当文件也不当目录，不会跟着走出实例目录
      if (e.isDirectory()) {
        if (recursive && depth < LIBRARY_MAX_DEPTH) walk(name, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(name);
      }
    }
  };
  walk('', 0);
  return out;
}

/**
 * 一个实例的全部记忆文件：核心档案、专题（含 topics.json 里没登记的）、大事记、资料库。
 * 返回 [{ rel, abs, label, max, kind }]，kind 是 core / topic / timeline / library；资料库和大事记没有上限（max 为 Infinity）。
 * 文件不存在的 MEMORY.md 也列出来（记忆历史要知道它被删了）。
 */
export function listMemoryFiles(botRoot) {
  const names = new Map(loadTopicsConfig(botRoot).map((t) => [t.file, t.name.replace(/分卷$/, '')]));
  const files = [{ rel: 'MEMORY.md', label: '核心档案', max: MEMORY_MAX_CHARS, kind: 'core' }];
  for (const f of listDir(botRoot, TOPICS_DIR, false)) {
    files.push({ rel: `${TOPICS_DIR}/${f}`, label: names.get(f) || f.replace(/\.md$/, ''), max: TOPIC_MAX_CHARS, kind: 'topic' });
  }
  for (const f of listDir(botRoot, TIMELINE_DIR, false)) {
    files.push({ rel: `${TIMELINE_DIR}/${f}`, label: `大事记 ${f.replace(/\.md$/, '')}`, max: Infinity, kind: 'timeline' });
  }
  for (const f of listDir(botRoot, LIBRARY_DIR, true)) {
    files.push({ rel: `${LIBRARY_DIR}/${f}`, label: `资料库 ${f.replace(/\.md$/, '')}`, max: Infinity, kind: 'library' });
  }
  return files.map((f) => ({ ...f, abs: path.join(botRoot, f.rel) }));
}

/** 记忆文件属于哪一块：core / topic / timeline / library；不是记忆文件返回 null */
export function memoryKind(rel) {
  if (rel === 'MEMORY.md') return 'core';
  if (rel.startsWith(`${TOPICS_DIR}/`)) return 'topic';
  if (rel.startsWith(`${TIMELINE_DIR}/`)) return 'timeline';
  if (rel.startsWith(`${LIBRARY_DIR}/`)) return 'library';
  return rel.startsWith('data/memory/') ? 'other' : null;
}

export function memoryLabel(botRoot, rel) {
  const kind = memoryKind(rel);
  if (kind === 'core') return '核心档案';
  if (kind === 'timeline') return `大事记 ${path.basename(rel, '.md')}`;
  if (kind === 'library') return `资料库 ${rel.slice(LIBRARY_DIR.length + 1).replace(/\.md$/, '')}`;
  const file = path.basename(rel);
  const topic = loadTopicsConfig(botRoot).find((t) => t.file === file);
  return topic ? topic.name.replace(/分卷$/, '') : file.replace(/\.md$/, '');
}
