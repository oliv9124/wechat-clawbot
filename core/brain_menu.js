// 微信里切大脑、切模型（11-19）：发「大脑」「模型」「GPT 模型」「推理」弹出菜单，回序号切换。
// 选了什么都记在这个机器人自己的运行状态 data/state/brain.json，各号各管各的，重启不丢：
//   mode：agy / codex；agy_model、agy_model_name：Antigravity 自己选的模型（没有 = 跟着账号设置走）；
//   gpt_model、gpt_model_name、gpt_effort：GPT 自己选的模型和推理强度（没有 = 跟着 Codex 的默认走）；menu：刚弹出、还没选的菜单。
// 不改任何账号的 settings.json、Codex 的 config.toml；定时任务、凌晨整理记忆不看这里，照旧用它们自己的模型。
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
    const child = execFile(exe, ['models'], { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const all = parseAgyModels(stdout);
      if (!all.length) return resolve({ ok: false, models: [], hidden: 0, why: failWhy(error), detail: String(stderr || '').trim().slice(-200) });
      const models = all.filter((m) => !HIDDEN_MODEL.test(m.id));
      resolve({ ok: true, models, hidden: all.length - models.length });
    });
    child.stdin?.end();
  });
}
const failWhy = (error) => (error?.killed ? '超时了' : error ? `出错了（退出码 ${error.code ?? '?'}）` : '给的列表是空的');

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

// 菜单的种类：大脑、Antigravity 的模型、GPT 的模型、GPT 的推理强度
const MENU_KINDS = ['brain', 'model', 'gpt_model', 'effort'];
// 还在有效期里的菜单；没有、过期了返回 null
export function activeMenu(brain, now = Date.now()) {
  const m = brain?.menu;
  if (!m || !MENU_KINDS.includes(m.kind) || !Array.isArray(m.items) || !m.items.length) return null;
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
    codexEnabled
      ? `回 1 或 2 切换（${TTL_TEXT}内有效）。换模型回「模型」或「GPT 模型」，GPT 的推理强度回「推理」。`
      : `回 1 或 2 切换（${TTL_TEXT}内有效）。换 Antigravity 的模型，回「模型」。`,
  ].join('\n');
}

// 「模型」菜单：这个号能用的模型，最后一项是"恢复默认"
export const modelMenuItems = (models) => [...models.map((m) => ({ id: m.id, name: m.name })), { reset: true, name: '恢复默认' }];
export function modelMenuText({ models, chosen = null, defaultName = '' }) {
  const lines = ['Antigravity 能用的模型：'];
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

// ---------- GPT（Codex）的模型和推理强度 ----------
// 推理强度：Codex 的档位和大白话说明（不同模型支持的档位不一样，以模型目录为准）
export const EFFORTS = {
  low: { name: '低', hint: '回得快，想得浅' },
  medium: { name: '中', hint: '日常够用' },
  high: { name: '高', hint: '复杂问题' },
  xhigh: { name: '极高', hint: '更复杂的问题' },
  max: { name: '最高', hint: '最难的问题' },
  ultra: { name: '超高', hint: '最深，还会自动分派子任务，最费额度' },
};
export const effortName = (e) => EFFORTS[e]?.name || String(e || '');

// 「codex debug models」打印的模型目录（JSON）：只要 Codex 自己菜单里显示的（visibility 是 list），按 priority 排
export function parseCodexModels(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout || ''));
  } catch {
    return [];
  }
  const list = Array.isArray(data?.models) ? data.models : [];
  return list
    .filter((m) => m && typeof m.slug === 'string' && m.slug && m.visibility === 'list')
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))
    .map((m) => ({
      id: m.slug,
      name: String(m.display_name || m.slug),
      levels: (Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [])
        .map((x) => (typeof x === 'string' ? x : x?.effort))
        .filter((x) => typeof x === 'string' && /^[a-z]+$/.test(x)),
      defaultLevel: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : '',
    }));
}

// 用这个号自己的 GPT 登录（CODEX_HOME）拉一次模型目录（服务器上几个号共用一个登录的，看到的一样）
export function listCodexModels({ exe = 'codex', cwd, env = process.env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(exe, ['debug', 'models'], { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const models = parseCodexModels(stdout);
      if (!models.length) return resolve({ ok: false, models: [], why: failWhy(error), detail: String(stderr || '').trim().slice(-200) });
      resolve({ ok: true, models });
    });
    child.stdin?.end();
  });
}

// Codex 设置里写死的模型、推理强度（config.toml 开头那几行，[段落] 前面的才算）。只读，没写返回 ''
export function codexConfig(codexHome) {
  const out = { model: '', effort: '' };
  if (!codexHome) return out;
  let text = '';
  try {
    text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*(model|model_reasoning_effort)\s*=\s*"([^"]*)"/);
    if (m) out[m[1] === 'model' ? 'model' : 'effort'] = m[2].trim();
  }
  return out;
}

// GPT 现在默认用哪个：设置里写死的，否则是模型目录里排第一的（11-19 看到的是 GPT-6.2-Sol）
export function codexDefaultModel(models, cfg = {}) {
  return models.find((m) => m.id === cfg.model) || (cfg.model ? { id: cfg.model, name: cfg.model, levels: [], defaultLevel: '' } : models[0] || null);
}
// 默认的推理强度：设置里写死的，否则是那个模型自己的默认档
export const codexDefaultEffort = (model, cfg = {}) => cfg.effort || model?.defaultLevel || '';

// 自己选的 GPT 模型 { id, name } / 推理强度；没选返回 null
export function chosenCodexModel(brain) {
  const id = typeof brain?.gpt_model === 'string' ? brain.gpt_model.trim() : '';
  return id ? { id, name: String(brain.gpt_model_name || id) } : null;
}
export function chosenEffort(brain) {
  const e = typeof brain?.gpt_effort === 'string' ? brain.gpt_effort.trim() : '';
  return /^[a-z]+$/.test(e) ? e : null;
}

// 「GPT 模型」菜单：GPT 能用的模型，最后一项是"恢复默认"
export const codexModelMenuItems = (models, def) => [
  ...models.map((m) => ({ id: m.id, name: m.name, levels: m.levels, defaultLevel: m.defaultLevel })),
  { reset: true, name: '恢复默认', levels: def?.levels || [], defaultLevel: def?.defaultLevel || '' },
];
export function codexModelMenuText({ models, chosen = null, def = null }) {
  const lines = ['GPT 能用的模型：'];
  const defaultIdx = chosen || !def ? -1 : models.findIndex((m) => m.id === def.id);
  models.forEach((m, i) => {
    const mark = chosen ? (m.id === chosen.id ? ' 👈 正在用' : '') : i === defaultIdx ? ' 👈 正在用（默认）' : '';
    lines.push(`${i + 1}. ${m.name}${mark}`);
  });
  const resetMark = !chosen && defaultIdx < 0 ? ' 👈 正在用' : '';
  lines.push(`${models.length + 1}. 恢复默认（跟着 GPT 自己的默认走${def ? `：${def.name}` : ''}）${resetMark}`);
  if (chosen && !models.some((m) => m.id === chosen.id)) lines.push(`（现在选的「${chosen.name}」不在这个列表里了，换一个或恢复默认吧）`);
  lines.push(`回序号切换，比如回「${Math.min(3, models.length + 1)}」（${TTL_TEXT}内有效）。推理强度回「推理」改。`);
  return lines.join('\n');
}

// 「推理」菜单：这个 GPT 模型支持的推理强度
export const effortMenuItems = (levels) => levels.map((e) => ({ effort: e }));
export function effortMenuText({ levels, chosen = null, defaultEffort = '', modelName = '' }) {
  const lines = [`GPT 的推理强度${modelName ? `（模型：${modelName}）` : ''}：`];
  const current = chosen || defaultEffort;
  levels.forEach((e, i) => {
    const mark = e === current ? (chosen ? ' 👈 正在用' : ' 👈 正在用（默认）') : '';
    lines.push(`${i + 1}. ${effortName(e)}：${EFFORTS[e]?.hint || e}${mark}`);
  });
  lines.push(`回序号切换（${TTL_TEXT}内有效）。`);
  return lines.join('\n');
}

// Codex 不认这个模型（下线了、这个账号用不了）："The 'x' model is not supported when using Codex with a ChatGPT account."
export function isCodexModelError(text) {
  return /model is not supported when using Codex|model_not_found|does not have access to (the )?model/i.test(String(text || ''));
}
