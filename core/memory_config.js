import fs from 'node:fs';
import path from 'node:path';

// 聊天日志里的"会话已重置"标记：组装最近对话和凌晨记忆整理都只看它之后的内容
export const RESET_MARKER = '[会话已重置]';

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
