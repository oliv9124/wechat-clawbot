// 微信里切大脑、切 Antigravity 模型（11-19）：发「大脑」「模型」弹出菜单，回序号切换。
// 选了什么都记在这个机器人自己的运行状态 data/state/brain.json，各号各管各的，重启不丢：
//   mode：agy / codex；agy_model、agy_model_name：自己选的模型（没有 = 跟着账号设置走）；menu：刚弹出、还没选的菜单。
// 不改任何账号的 settings.json；定时任务、凌晨整理记忆不看这里，照旧用它们自己的模型。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// 菜单弹出后多久内回数字算数；过了这个时间，单独一个数字照常交给 AI
export const MENU_TTL_MS = (Number(process.env.ROUTINE_MENU_TTL_SECONDS) || 300) * 1000;
const TTL_TEXT = MENU_TTL_MS % 60_000 === 0 ? `${MENU_TTL_MS / 60_000} 分钟` : `${Math.round(MENU_TTL_MS / 1000)} 秒`;

// 不放进菜单的模型：Claude 系列额度很少（几个机器人可能共用一个账号），不让随手选
export const HIDDEN_MODEL = /^claude-/i;

// 「agy models」的输出：第一行 "Fetching available models..."，后面每行 "<模型 ID><Tab><显示名>"
export function parseAgyModels(stdout) {
  const out = [];
  const seen = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9][\w.:-]*)\t+(\S.*?)\s*$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], name: m[2] });
  }
  return out;
}

// 用这个机器人自己的账号拉一次模型列表（不同账号看到的可能不一样）；Claude 不列
export function listAgyModels({ cwd, env = process.env, exe = 'agy', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(exe, ['models'], { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const all = parseAgyModels(stdout);
      if (!all.length) {
        const why = error?.killed ? '超时了' : error ? `出错了（退出码 ${error.code ?? '?'}）` : '给的列表是空的';
        return resolve({ ok: false, models: [], hidden: 0, why, detail: String(stderr || '').trim().slice(-200) });
      }
      const models = all.filter((m) => !HIDDEN_MODEL.test(m.id));
      resolve({ ok: true, models, hidden: all.length - models.length });
    });
  });
}

// 账号设置里的默认模型（显示名，比如 "Gemini 4 Hydrogen (High)"）。只读，读不到返回 ''
export function accountDefaultModel(home = process.env.HOME) {
  if (!home) return '';
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
    return typeof s.model === 'string' ? s.model.trim() : '';
  } catch {
    return '';
  }
}

// 自己选的模型 { id, name }；没选返回 null
export function chosenModel(brain) {
  const id = typeof brain?.agy_model === 'string' ? brain.agy_model.trim() : '';
  return id ? { id, name: String(brain.agy_model_name || id) } : null;
}

// 单独一个数字（半角、全角都行，前面可以叫一声名字，末尾可以带个句号）→ 这个数；别的返回 null
export function parseMenuNumber(text) {
  const raw = String(text || '').normalize('NFKC').trim();
  const named = raw.replace(/^[@＠]?[^\s，,：:。.!！?？\d]{1,6}[，,：:\s]+/, '');
  for (const t of [raw, named]) {
    const m = t.match(/^(\d{1,3})\s*[。.!！]?$/);
    if (m) return Number(m[1]);
  }
  return null;
}

// 还在有效期里的菜单；没有、过期了返回 null
export function activeMenu(brain, now = Date.now()) {
  const m = brain?.menu;
  if (!m || (m.kind !== 'brain' && m.kind !== 'model') || !Array.isArray(m.items) || !m.items.length) return null;
  const age = now - Number(m.at);
  return age >= 0 && age < MENU_TTL_MS ? m : null;
}

// 这条是不是在选菜单：有还没过期的菜单、这条又是单独一个数字才算。
// 返回 { menu, n, item }，item 为空表示菜单里没有这个数；不是在选菜单返回 null（照常交给 AI）
export function menuPick(text, brain, now = Date.now()) {
  const n = parseMenuNumber(text);
  if (n === null) return null;
  const menu = activeMenu(brain, now);
  if (!menu) return null;
  return { menu, n, item: n >= 1 ? menu.items[n - 1] || null : null };
}

// 「大脑」菜单
export const brainMenuItems = () => [{ brain: 'agy' }, { brain: 'codex' }];
export function brainMenuText({ mode, codexEnabled, codexNote = '', modelName = '' }) {
  const usingCodex = Boolean(codexEnabled) && mode === 'codex';
  return [
    '现在能用的大脑：',
    `1. Antigravity（模型：${modelName || '账号默认'}）${usingCodex ? '' : ' 👈 正在用'}`,
    `2. GPT（${codexEnabled ? codexNote || '已开启' : '这个号没开'}）${usingCodex ? ' 👈 正在用' : ''}`,
    `回 1 或 2 切换（${TTL_TEXT}内有效）。换 Antigravity 的模型，回「模型」。`,
  ].join('\n');
}

// 「模型」菜单：这个号能用的模型，最后一项是"恢复默认"
export const modelMenuItems = (models) => [...models.map((m) => ({ id: m.id, name: m.name })), { reset: true, name: '恢复默认' }];
export function modelMenuText({ models, chosen = null, defaultName = '' }) {
  const lines = ['这个号能用的模型：'];
  const defaultIdx = chosen ? -1 : models.findIndex((m) => m.name === defaultName);
  models.forEach((m, i) => {
    const mark = chosen ? (m.id === chosen.id ? ' 👈 正在用' : '') : i === defaultIdx ? ' 👈 正在用（默认）' : '';
    lines.push(`${i + 1}. ${m.name}${mark}`);
  });
  const resetMark = !chosen && defaultIdx < 0 ? ' 👈 正在用' : '';
  lines.push(`${models.length + 1}. 恢复默认（跟着账号设置走${defaultName ? `：${defaultName}` : ''}）${resetMark}`);
  if (chosen && !models.some((m) => m.id === chosen.id)) lines.push(`（现在选的「${chosen.name}」不在这个列表里了，换一个或恢复默认吧）`);
  lines.push(`回序号切换，比如回「${Math.min(3, models.length + 1)}」（${TTL_TEXT}内有效）。`);
  return lines.join('\n');
}

// agy 不认这个模型（下线了、这个号没有）：报错是 "invalid model selection … is not recognized as a known model"
export function isModelSelectionError(text) {
  return /invalid model selection|not recognized as a known model/i.test(String(text || ''));
}
export const modelUnavailableNotice = (name) => `「${name}」现在用不了（可能下线了，或者这个号没有权限）。回「切回默认」换回默认模型，或回「模型」重新选。`;
export const modelErrorHint = (name) => `（现在用的模型是「${name}」。如果一直出错，回「切回默认」换回默认模型。）`;
