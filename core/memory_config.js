import fs from 'node:fs';
import path from 'node:path';

// 聊天日志里的"会话已重置"标记：组装最近对话和凌晨记忆整理都只看它之后的内容
export const RESET_MARKER = '[会话已重置]';

// 记忆长度上限（字数）：白天对话、凌晨整理、加载记忆都用这一套
export const MEMORY_MAX_CHARS = 3000; // MEMORY.md
export const TOPIC_MAX_CHARS = 8000; // 每个专题分卷
export const TOPIC_ALWAYS_BUDGET = 4000; // 每条消息都带上的小专题，合计不超过这么多；放不下的专题按关键词带

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

// 只保留最后一次"会话已重置"之后的日志内容
export function textAfterLastReset(text) {
  const i = text.lastIndexOf(RESET_MARKER);
  return i < 0 ? text : text.slice(i + RESET_MARKER.length);
}

export const charCount = (text) => [...String(text ?? '')].length;

/**
 * 加载进上下文的记忆：超过上限也照常全部带上（早上的汇报会提醒，当晚整理时合并精简）；
 * 超过上限两倍才截断，防止一个写坏的文件拖累每条消息。返回 { text, truncated }
 */
export function capForLoading(text, maxChars) {
  const chars = [...String(text ?? '')];
  if (chars.length <= maxChars * 2) return { text: chars.join(''), truncated: false };
  return { text: `${chars.slice(0, maxChars * 2).join('')}\n...（超出上限太多，后面的部分这次没有带上）`, truncated: true };
}

/**
 * 一个实例的全部记忆文件：MEMORY.md + data/memory/topics/ 下的 .md（含 topics.json 里没登记的）。
 * 返回 [{ rel, abs, label, max }]，rel 是相对实例目录的路径；文件不存在的 MEMORY.md 也列出来（记忆历史要知道它被删了）。
 */
export function listMemoryFiles(botRoot) {
  const names = new Map(loadTopicsConfig(botRoot).map((t) => [t.file, t.name.replace(/分卷$/, '')]));
  const files = [{ rel: 'MEMORY.md', label: '核心档案', max: MEMORY_MAX_CHARS }];
  let topicFiles = [];
  try {
    topicFiles = fs.readdirSync(path.join(botRoot, 'data', 'memory', 'topics')).filter((f) => f.endsWith('.md')).sort();
  } catch {}
  for (const f of topicFiles) {
    files.push({ rel: `data/memory/topics/${f}`, label: names.get(f) || f.replace(/\.md$/, ''), max: TOPIC_MAX_CHARS });
  }
  return files.map((f) => ({ ...f, abs: path.join(botRoot, f.rel) }));
}

export function memoryLabel(botRoot, rel) {
  if (rel === 'MEMORY.md') return '核心档案';
  const file = path.basename(rel);
  const topic = loadTopicsConfig(botRoot).find((t) => t.file === file);
  return topic ? topic.name.replace(/分卷$/, '') : file.replace(/\.md$/, '');
}
