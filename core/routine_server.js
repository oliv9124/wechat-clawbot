// 本机接口不走代理；服务配置里另外写了不走代理的（比如装 Python 包用的 pypi.org）一起留着，智能体执行的命令也用得上
const keepNoProxy = (v) => [...new Set(['127.0.0.1', 'localhost', ...String(v || '').split(',').map((x) => x.trim()).filter(Boolean)])].join(',');
process.env.NO_PROXY = keepNoProxy(process.env.NO_PROXY);
process.env.no_proxy = keepNoProxy(process.env.no_proxy);

import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sendWechatReply,
  sendWechatTyping,
  uploadAndSendWechatImage,
  uploadAndSendWechatFile,
  uploadAndSendWechatVideo,
  loadConfig,
  loadRuntimeState,
  saveRuntimeState,
  describeText,
  describePath,
  writeJsonAtomic,
} from './wechat_reply.js';
import {
  enqueueInbox,
  listPending,
  claimInbox,
  finishInbox,
  retryOrFailInbox,
  failInbox,
  requeueProcessing,
  messageIdFromFileName,
} from './inbox.js';
import {
  RESET_MARKER, isResetEntry, loadTopicsConfig, capForLoading, charCount, MEMORY_MAX_CHARS, TOPIC_MAX_CHARS,
  MAX_TOPICS_PER_MESSAGE, TIMELINE_LOAD_MAX_CHARS, LIBRARY_DIR, TIMELINE_DIR,
} from './memory_config.js';
import { memoryMode, useStandaloneHistory, parseMemoryCommand, findBotByName, showChanges, undoItems } from './memory_history.js';
import { parseCredentialCommand, saveSkillCredential, credentialHelp, isInstalled } from './skills.js';
import { raiseAlert } from './alert.js';
import { cleanupOldSessions, referencedIds, describeCleanup } from './session_cleanup.js';
import { AGY_STREAM_ARGS, agyInputLine, agyOutcome, agyContextTokens, recordAgentResult } from './agent_health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = process.cwd();
// 自己管记忆历史的实例（默认每个实例自己管；统一管理时只有主人的机器人）才处理「记忆改动」「撤销记忆 N」，
// 被代管的实例照常交给智能体
const MEMORY_MODE = memoryMode(botRoot);
if (MEMORY_MODE === 'standalone') useStandaloneHistory(botRoot);
const MEMORY_REVIEW = MEMORY_MODE === 'standalone';
// 统一管理（managed）：管理指令写成请求交给管理服务，它处理完直接经这个机器人的微信回复
const MANAGED = MEMORY_MODE === 'managed';
const REQUEST_WAIT_MS = Number(process.env.CLAWBOT_REQUEST_WAIT_MS) || 20_000;

// 自动检测监听端口（优先配置项 port -> webhook_url 端口 -> 环境变量 -> 默认 18888）
function resolvePort() {
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  const cfg = loadConfig();
  if (cfg.port) return parseInt(cfg.port, 10);
  if (cfg.webhook_url) {
    const m = cfg.webhook_url.match(/:(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return 18888;
}

const PORT = resolvePort();
const HOST = '127.0.0.1'; // 纯本地监听，绝不暴露公网

// 数据与历史日志目录支持
const dataDir = path.join(botRoot, 'data');
const historyDir = path.join(dataDir, 'history');
if (!fs.existsSync(historyDir)) {
  try { fs.mkdirSync(historyDir, { recursive: true }); } catch {}
}
const LOG_FILE = path.join(dataDir, 'chat_history.log');

function getBeijingDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const obj = {};
  for (const p of parts) obj[p.type] = p.value;
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function getDailyLogPath(offsetDays = 0) {
  const dateStr = getBeijingDateStr(offsetDays);
  return path.join(historyDir, `chat_${dateStr}.log`);
}

function appendLog(line) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${line}\n`;

  // 1. 写入今日按天切片日志 (data/history/chat_YYYY-MM-DD.log)
  try {
    fs.appendFileSync(getDailyLogPath(0), entry, 'utf-8');
  } catch (err) {
    console.warn('[写入按天切片日志失败]:', err.message);
  }

  // 2. 向下兼容老单文件（限制最大 3MB，防止无限堆积）
  try {
    fs.appendFileSync(LOG_FILE, entry, 'utf-8');
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 3 * 1024 * 1024) {
      const content = fs.readFileSync(LOG_FILE, 'utf-8');
      const lines = content.split('\n');
      const trimmed = lines.slice(Math.floor(lines.length / 2)).join('\n');
      fs.writeFileSync(LOG_FILE, trimmed, 'utf-8');
    }
  } catch {}
}

// 允许作为微信文件/原生视频卡片投递的交付物格式
const ALLOWED_DELIVERY_DOCS = /\.(md|html|htm|pdf|docx|doc|xlsx|xls|pptx|ppt|csv|txt|zip|tar\.gz|mp3|m4a|wav)$/i;
const ALLOWED_DELIVERY_VIDEOS = /\.(mp4|mov|m4v)$/i;

function isDeliverableFile(filePath) {
  if (!ALLOWED_DELIVERY_DOCS.test(filePath)) return false;
  const lower = filePath.toLowerCase();
  // 严格过滤系统配置、内部源码、临时日志
  if (
    lower.includes('/.system_generated/') ||
    lower.includes('/node_modules/') ||
    lower.includes('/.git/') ||
    lower.includes('config.') ||
    lower.includes('package.json') ||
    lower.endsWith('gemini.md') ||
    lower.endsWith('agents.md') ||
    lower.endsWith('soul.md') ||
    lower.endsWith('identity.md') ||
    lower.endsWith('user.md') ||
    lower.endsWith('tools.md') ||
    lower.endsWith('memory.md') ||
    lower.endsWith('heartbeat.md') ||
    lower.endsWith('readme.md') ||
    lower.endsWith('skill.md')
  ) {
    return false;
  }
  return true;
}

// 机器人自己的记忆、记忆历史、运行状态、聊天记录、转给管理服务的请求、规则和技能：回复里写了路径也不当成交付物发。
// 11-18 一个机器人回抖音链接时顺口说了刚改的专题笔记的路径，那份 .md 就被当文件发给了用户
const INTERNAL_DIRS = ['data/memory', 'data/memory-history', 'data/state', 'data/history', 'data/requests', '.agents'];
function isInternalPath(p) {
  let real = p;
  try { real = fs.realpathSync(p); } catch {}
  return INTERNAL_DIRS.some((d) => real.startsWith(path.join(botRoot, d) + path.sep));
}

// 检查文件是否安全属于当前 Bot 作用域：只允许本实例目录，或 /tmp 里由本进程用户创建的临时交付物，杜绝跨号串发。
// 先解析软链接，防止用链接指到实例目录以外；前缀比较带上分隔符，避免 bots/bot2 被当成 bots/bot。
function isPathAllowedForThisBot(p) {
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  if (real.startsWith('/tmp/')) {
    try {
      return fs.statSync(real).uid === process.getuid();
    } catch {
      return false;
    }
  }
  return real.startsWith(botRoot + path.sep);
}

/**
 * Scan agent reply for generated image files, video files, or document files.
 */
function extractMediaPaths(text) {
  const isIncomingWechatMedia = (filepath) => /\/downloads\/wechat\//i.test(filepath);
  if (!text) return { images: [], files: [], videos: [] };
  const images = new Set();
  const files = new Set();
  const videos = new Set();

  const fileUrlRegex = /file:\/\/(\/[^\s\)\"\'\<\>]+)/gi;
  for (const m of text.matchAll(fileUrlRegex)) {
    const p = m[1];
    if (!isPathAllowedForThisBot(p) || isIncomingWechatMedia(p) || isInternalPath(p)) continue;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const stats = fs.statSync(p);
      const isRecent = (Date.now() - stats.mtimeMs) < 600000; // 仅推送10分钟内生成的文件
      if (isRecent) {
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(p)) {
          images.add(p);
        } else if (ALLOWED_DELIVERY_VIDEOS.test(p)) {
          videos.add(p);
        } else if (isDeliverableFile(p)) {
          files.add(p);
        }
      }
    }
  }

  const absPathRegex = /(\/(?:srv|root|tmp)[^\s\)\"\'\<\>]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|doc|xlsx|xls|pptx|ppt|csv|txt|zip|tar\.gz|md|html|htm|mp4|mov|m4v|mp3|m4a|wav))/gi;
  for (const m of text.matchAll(absPathRegex)) {
    const p = m[1];
    if (!isPathAllowedForThisBot(p) || isIncomingWechatMedia(p) || isInternalPath(p)) continue;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const stats = fs.statSync(p);
      const isRecent = (Date.now() - stats.mtimeMs) < 600000; // 仅推送10分钟内生成的文件
      if (isRecent) {
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(p)) {
          images.add(p);
        } else if (ALLOWED_DELIVERY_VIDEOS.test(p)) {
          videos.add(p);
        } else if (isDeliverableFile(p)) {
          files.add(p);
        }
      }
    }
  }

  // 兼容带空格或被引号/反引号包裹的文件路径
  const quotedPathRegex = /[`"'](\/(?:srv|root|tmp)[^`"'\r\n]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|doc|xlsx|xls|pptx|ppt|csv|txt|zip|tar\.gz|md|html|htm|mp4|mov|m4v|mp3|m4a|wav))[`"']/gi;
  for (const m of text.matchAll(quotedPathRegex)) {
    const p = m[1].trim();
    if (!isPathAllowedForThisBot(p) || isIncomingWechatMedia(p) || isInternalPath(p)) continue;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const stats = fs.statSync(p);
      const isRecent = (Date.now() - stats.mtimeMs) < 600000;
      if (isRecent) {
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(p)) {
          images.add(p);
        } else if (ALLOWED_DELIVERY_VIDEOS.test(p)) {
          videos.add(p);
        } else if (isDeliverableFile(p)) {
          files.add(p);
        }
      }
    }
  }


  // 智能兜底探测：如果 Agent 在回复中路径书写有偏差或被截断，但本 Bot 的 downloads 目录下近 3 分钟内有新下载的视频，自动保底推送！
  // 只在回复说的是视频、下载这类事时兜底：后台下载还没交付时，另一条不相干的回复（比如问天气）不会把视频顺手带走
  if (videos.size === 0 && /视频|下载|原画|卡片|抖音|B站|小红书|mp4/i.test(text)) {
    const downloadDirs = [
      path.join(botRoot, 'data', 'downloads'),
      path.join(botRoot, 'downloads'),
    ];
    for (const baseD of downloadDirs) {
      if (fs.existsSync(baseD)) {
        try {
          const subdirs = ['', 'douyin', 'bilibili', 'xiaohongshu'];
          let latestVideo = null;
          let latestMtime = 0;
          for (const sub of subdirs) {
            const d = path.join(baseD, sub);
            if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
            const entries = fs.readdirSync(d);
            for (const f of entries) {
              if (ALLOWED_DELIVERY_VIDEOS.test(f)) {
                const fullP = path.join(d, f);
                const st = fs.statSync(fullP);
                if ((Date.now() - st.mtimeMs) < 180000 && st.mtimeMs > latestMtime) {
                  latestMtime = st.mtimeMs;
                  latestVideo = fullP;
                }
              }
            }
          }
          if (latestVideo) {
            console.log(`[自动兜底捕获到新鲜下载的视频]: ${describePath(latestVideo)}`);
            videos.add(latestVideo);
            break;
          }
        } catch {}
      }
    }
  }

  return {
    images: Array.from(images),
    files: Array.from(files),
    videos: Array.from(videos),
  };
}

/**
 * Run Antigravity CLI (agy) to process user prompt and generate an answer.
 * Seamlessly supports multi-turn conversation memory with --conversation <id>.
 */
// 正在运行的 agy 进程数（含转入后台的任务），用来限制同时跑的智能体数量
let activeAgents = 0;
// 一次智能体运行最长多久，到点停掉（超过 90 秒的早已转进后台，所以这其实是后台任务的上限）。
// 原来 10 分钟：11-13 一个改网页的大任务做到一半被停掉；改成 60 分钟（环境变量仅供测试）
const AGENT_TIMEOUT_MS = Number(process.env.ROUTINE_AGENT_TIMEOUT_MS) || 60 * 60_000;
const durationLabel = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
// 到时间上限被停掉：如实说，不说成"中断了、换个问法"
const timeoutNotice = (userNickname) => `${userNickname}，这个任务做了 ${durationLabel(AGENT_TIMEOUT_MS)}还没做完，按时间上限停掉了。停之前可能已经改了一部分文件、做了一部分事；要接着做，跟我说"接着做完"就行，也可以把任务拆小一点再发。`;

// 回复标签：每次运行智能体给它一个专属文件（环境变量 CLAWBOT_REPLY_TAGS），工具在里面写一行标签
// （比如 clawbot-cap 调用了 GPT 就写 GPT）；发回复时按标签在开头加【GPT】，没有标签就不加。
// 一次运行一个文件，所以忙时并行的临时会话不会串标；读完就删
const REPLY_TAGS_DIR = path.join(botRoot, 'data', 'state', 'reply-tags');
function newReplyTagsFile() {
  try { fs.mkdirSync(REPLY_TAGS_DIR, { recursive: true }); } catch {}
  return path.join(REPLY_TAGS_DIR, `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
}
function peekReplyTags(file) {
  try {
    const tags = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const tag = line.trim();
      if (/^[A-Za-z0-9一-龥_-]{1,12}$/.test(tag) && !tags.includes(tag)) tags.push(tag);
    }
    return tags.slice(0, 3);
  } catch {
    return [];
  }
}
function takeReplyTags(file) {
  const tags = peekReplyTags(file);
  try { fs.unlinkSync(file); } catch {}
  return tags;
}
const withReplyTags = (tags, text) => (tags && tags.length ? `${tags.map((t) => `【${t}】`).join('')}${text}` : text);
// 上次异常退出留下的标签文件（超过一天的）清掉
try {
  for (const f of fs.readdirSync(REPLY_TAGS_DIR)) {
    const p = path.join(REPLY_TAGS_DIR, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 86400_000) fs.unlinkSync(p);
  }
} catch {}

// ---------- GPT 大脑（Codex CLI） ----------
// config.json 里 codex_brain:true 的机器人可以把消息交给 Codex：「用 GPT …」只这一条，「切到 GPT」之后都用，「切回来」换回 Antigravity。
// Codex 用这个机器人自己的登录（CLAWBOT_CODEX_HOME，一个机器人一份，不复制别人的）；会话 ID 和 Antigravity 的分开记（运行状态 codex）。
// 用哪个 Codex：服务里用 CLAWBOT_CODEX_EXE 指定；不指定就用 PATH 里的 codex
const CODEX_EXE = process.env.CLAWBOT_CODEX_EXE || 'codex';
const CODEX_HOME_DIR = process.env.CLAWBOT_CODEX_HOME || path.join(process.env.HOME || botRoot, '.codex');
// GPT 会话现在多大（最近一次请求的输入 token）超过这个数就开新会话；另外和 Antigravity 一样，过了凌晨整理记忆的时间也开新会话。
// 原来 8 万：会话越大，每一步都要把整段会话重发一遍，越用越贵，改成 6 万
const CODEX_ROTATE_TOKENS = Number(process.env.ROUTINE_CODEX_ROTATE_TOKENS) || 60000;
// GPT 会话隔这么久没用，下一条消息开新会话：缓存早过期了，接着用旧会话每一步都按原价重发整段历史；新会话照样带最近的聊天和长期记忆
const CODEX_IDLE_ROTATE_MS = (Number(process.env.ROUTINE_CODEX_IDLE_ROTATE_MINUTES) || 120) * 60_000;
function parseBrainCommand(text) {
  const raw = String(text || '').trim();
  // 命令前面先叫一声名字也认：「小助，切到 GPT」「阿福 用 GPT 写首诗」（去掉开头 6 个字以内的称呼和后面的逗号、冒号或空格再判断）
  const named = raw.replace(/^[@＠]?[^\s，,：:。.!！?？]{1,6}[，,：:\s]+/, '');
  for (const t of named === raw ? [raw] : [raw, named]) {
    if (/^(切到|切换到|换成|改用)\s*(gpt|codex)(\s*模式)?[。.!！]?$/i.test(t)) return { kind: 'on' };
    if (/^(切回来|切回去|换回来|退出\s*gpt(\s*模式)?)[。.!！]?$/i.test(t)) return { kind: 'off' };
    if (/^(查(一下|下)?|看(一下|下)?)?\s*gpt\s*的?\s*(额度|用量|余量|配额)(还剩多少|还有多少|剩多少|怎么样|多少)?[？?。.!！]?$/i.test(t)) return { kind: 'quota' };
    if (/^(用|让|请|叫)?\s*gpt\s*[，,:：]?\s*\S/i.test(t)) return { kind: 'once' };
  }
  return null;
}
// 技能清单写进给 Codex 的提示词（它不会自己去 .agents/skills 里找）
function codexSkillsIndex() {
  const dir = path.join(botRoot, '.agents', 'skills');
  const lines = [];
  try {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'codex-work') continue; // GPT 自己就是 GPT，不用再把活转给共享服务里的另一个
      const md = path.join(dir, name, 'SKILL.md');
      let text = '';
      try { text = fs.readFileSync(md, 'utf8'); } catch { continue; }
      const desc = ((text.match(/^description:\s*(.+)$/m) || [])[1] || '').trim().slice(0, 120);
      lines.push(`- ${name}：${desc}（说明书 ${path.relative(botRoot, md)}）`);
    }
  } catch {}
  return (lines.length ? `\n[可用技能：要用哪个，先读它的说明书，再照着做]\n${lines.join('\n')}\n` : '') + CODEX_WORK_NOTE;
}
// Codex 每轮结束给的用量是整个会话的累计数（每次请求都把整段会话重新算一遍），不是会话现在多大。
// 会话现在多大看它自己的会话记录 CODEX_HOME/sessions/年/月/日/rollout-…-<会话ID>.jsonl 里最后一次 token_count；找不到算 0（只按天换会话）。
// 同一种 token_count 里还有账号的额度（rate_limits），一起取出来
function codexTokenInfo(threadId) {
  const out = { context: 0, rateLimits: null };
  if (!threadId) return out;
  const ls = (p) => { try { return fs.readdirSync(p).sort(); } catch { return []; } };
  const base = path.join(CODEX_HOME_DIR, 'sessions');
  const dirs = [];
  for (const y of ls(base).slice(-2)) {
    for (const m of ls(path.join(base, y)).slice(-2)) {
      for (const d of ls(path.join(base, y, m)).slice(-3)) dirs.push(path.join(base, y, m, d));
    }
  }
  for (const dir of dirs.reverse()) {
    const name = ls(dir).find((n) => n.endsWith(`-${threadId}.jsonl`));
    if (!name) continue;
    try {
      const file = path.join(dir, name);
      const size = fs.statSync(file).size;
      const len = Math.min(size, 1024 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && !(out.context && out.rateLimits); i--) {
        if (!lines[i].includes('"token_count"')) continue;
        try {
          const p = JSON.parse(lines[i]).payload || {};
          const u = p.info?.last_token_usage;
          if (!out.context && u && Number.isFinite(u.input_tokens)) out.context = u.input_tokens + (Number(u.output_tokens) || 0);
          if (!out.rateLimits && p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) out.rateLimits = p.rate_limits;
        } catch {}
      }
    } catch {}
    if (!out.context) console.warn(`[Codex] 会话 ${threadId} 的记录里没有用量，这次不按大小换会话`);
    return out;
  }
  console.warn(`[Codex] 没找到会话 ${threadId} 的用量记录，这次不按大小换会话`);
  return out;
}
// GPT 这一轮画的图：它自带的生图工具固定存在 CODEX_HOME/generated_images/<会话ID>/（不在机器人目录里，系统发不出去），
// clawbot-cap 画的在 data/cap/images/。回复里没带图时，取这一轮最新的一张复制到机器人自己的 data/gpt-images/（刚复制的文件才会被发送）
const CODEX_IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
function codexTurnImage(threadId, sinceMs) {
  const found = [];
  const scan = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!CODEX_IMAGE_RE.test(n)) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs >= sinceMs) found.push({ p, t: st.mtimeMs });
      } catch {}
    }
  };
  if (threadId) scan(path.join(CODEX_HOME_DIR, 'generated_images', threadId));
  scan(path.join(botRoot, 'data', 'cap', 'images'));
  if (!found.length) return null;
  const latest = found.sort((a, b) => a.t - b.t).pop().p;
  const dir = path.join(botRoot, 'data', 'gpt-images');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = path.join(dir, `${stamp}-${crypto.randomBytes(2).toString('hex')}${path.extname(latest).toLowerCase()}`);
  fs.copyFileSync(latest, dest);
  return dest;
}
const CODEX_WORK_NOTE = `
[干活提示]
1. 画图、改照片都用你自带的生图工具（改照片时把主人发来的照片当参考图）。画好后系统会自动发给主人，回复里不用写路径。
2. clawbot-cap 这类命令要跑几十秒到几分钟：等它跑完、看到输出再决定下一步，没跑完就接着等，不要当成失败另想办法。
3. 做好的文件（Word、PDF、表格、视频等）放在你的文件夹里，回复里单独一行写 file:// 加完整路径，系统才会发给主人，比如 file://${botRoot}/data/docs/周报.docx
4. 写文章、写代码、做文档、写网页都自己直接做。做 PDF 照 documents 技能，发布网站照 website 技能。
5. 主人让你做新东西，就这次新做一份；文件夹里已有的文件（可能是默认大脑刚做的）不能当成你这次做好的。只有主人要"再发一次"以前的东西，才发旧文件。
`;
// ---------- 漏写路径时补发（两个大脑都管） ----------
// 系统只发回复里写了完整路径的文件。模型有时只写文件名（"red_heart.jpg"），或者画了图却没写，这里按"这一轮新生成的文件"补上。
const MENTION_RE = /([^\s/\\`'"<>()（）【】「」《》：:，,；;]+\.(?:png|jpe?g|webp|gif|pdf|docx?|xlsx?|pptx?|csv|txt|zip|mp3|m4a|wav|mp4|mov|m4v))/gi;
const MENTION_SKIP_DIRS = new Set(['.venv', 'node_modules', '.git', '.agents', 'state', 'history', 'downloads', 'memory', 'inbox', 'alerts', 'reply-tags']);
function findTurnFilesByName(names, sinceMs) {
  const found = new Map();
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!MENTION_SKIP_DIRS.has(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile() || !names.has(e.name)) continue;
      try {
        const t = fs.statSync(p).mtimeMs;
        if (t >= sinceMs && (!found.has(e.name) || found.get(e.name).t < t)) found.set(e.name, { p, t });
      } catch {}
    }
  };
  walk(botRoot, 0);
  return [...found.values()].map((x) => x.p);
}
// Antigravity 这一轮画的图：自带工具存在 $HOME/.gemini/antigravity-cli/brain/<会话>/<名字>_<13位时间>.<扩展名>，技能让它再复制进 data/images/
function agyTurnImages(conversationId, sinceMs) {
  const out = [];
  const scan = (dir, re) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (!re.test(n)) continue;
      const p = path.join(dir, n);
      try { const st = fs.statSync(p); if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ p, t: st.mtimeMs }); } catch {}
    }
  };
  if (conversationId) scan(path.join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'brain', String(conversationId)), /_\d{13}\.(png|jpe?g|webp)$/i);
  scan(path.join(botRoot, 'data', 'images'), CODEX_IMAGE_RE);
  return out;
}
function attachTurnMedia(reply, sinceMs, drawnImages = []) {
  const text = String(reply || '');
  const have = extractMediaPaths(text);
  const haveAll = new Set([...have.images, ...have.files, ...have.videos]);
  const add = [];
  const names = new Set();
  for (const m of text.matchAll(MENTION_RE)) {
    if (m.index > 0 && /[\/\\]/.test(text[m.index - 1])) continue;  // 前面带路径的，系统自己认得
    names.add(m[1]);
  }
  if (names.size) for (const p of findTurnFilesByName(names, sinceMs)) if (!haveAll.has(p)) add.push(p);
  if (!have.images.length && !add.some((p) => CODEX_IMAGE_RE.test(p)) && drawnImages.length) {
    const latest = drawnImages.sort((a, b) => a.t - b.t).pop().p;
    if (latest.startsWith(botRoot + path.sep)) add.push(latest);
    else {
      const dir = path.join(botRoot, 'data', 'images');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, path.basename(latest).replace(/_\d{13}(\.[a-z]+)$/i, '$1'));
      fs.copyFileSync(latest, dest);
      add.push(dest);
    }
  }
  if (!add.length) return text;
  console.log(`[补发] 回复里没写完整路径，系统补上：${add.map((p) => describePath(p)).join('、')}`);
  return `${text}\n${add.map((p) => `file://${p}`).join('\n')}`;
}
// ---------- GPT 额度 ----------
// Codex 每次请求后在会话记录里写下账号的额度：primary 是 5 小时窗口，secondary 是每周窗口（used_percent 已用百分比，resets_at 重置时间，秒）。
// 每轮 GPT 结束记进运行状态 codex_quota（问「GPT 额度」直接回这个数，不调用 GPT）。本周用到 70%、90% 各在回复末尾提醒主人一次，
// 5 小时窗口用到 90% 提醒一次；本周用到 80% 告诉管理员一次（用同一个账号的几个机器人谁先看到谁报，监控整台服务器只发一次）。
// 额度用完：这条改用默认大脑回答，GPT 模式也切回去，告诉主人什么时候恢复
// 提醒的几档（环境变量可以改，测试用）
const QUOTA_WEEK_WARN = String(process.env.ROUTINE_QUOTA_WEEK_WARN || '70,90').split(',').map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const QUOTA_5H_WARN = Number(process.env.ROUTINE_QUOTA_5H_WARN) || 90;
const QUOTA_ADMIN_WARN = Number(process.env.ROUTINE_QUOTA_ADMIN_WARN) || 80;
const CODEX_QUOTA_ERROR = /usage.?limit|hit your (usage )?limit|rate.?limit|too many requests|\b429\b|quota/i;
const quotaPct = (w) => Math.round(Number(w?.used_percent) || 0);
// 北京时间：今天 14:30 / 明天 08:00 / 11月20日 08:00（sec 是秒）
function bjWhen(sec) {
  const ms = Number(sec) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms + 8 * 3600_000);
  const t = new Date(Date.now() + 8 * 3600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / 86400_000);
  return days === 0 ? `今天 ${hm}` : days === 1 ? `明天 ${hm}` : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hm}`;
}
// 记下这一轮看到的额度；该提醒主人时返回一句提醒（加在回复末尾），不用提醒返回空串
function noteCodexQuota(limits) {
  if (!limits || (!limits.primary && !limits.secondary)) return '';
  const prev = loadRuntimeState('codex_quota');
  const week = limits.secondary || null;
  const h5 = limits.primary || null;
  // 还是同一周、同一个 5 小时窗口：重置时间差不多（每次报的可能差几秒）
  const sameWeek = week && Math.abs(Number(week.resets_at) - Number(prev.week_resets_at || 0)) < 6 * 3600;
  const same5h = h5 && Math.abs(Number(h5.resets_at) - Number(prev.h5_resets_at || 0)) < 600;
  let weekWarned = sameWeek ? Number(prev.week_warned) || 0 : 0;
  let adminWarned = sameWeek ? Boolean(prev.week_admin_warned) : false;
  let h5Warned = same5h ? Boolean(prev.h5_warned) : false;
  const notes = [];
  const wp = quotaPct(week);
  const level = week ? [...QUOTA_WEEK_WARN].reverse().find((l) => wp >= l) || 0 : 0;
  if (level > weekWarned) {
    notes.push(level >= QUOTA_WEEK_WARN[QUOTA_WEEK_WARN.length - 1]
      ? `GPT 本周额度已经用了 ${wp}%，快用完了，${bjWhen(week.resets_at)} 重置；用完会自动换回默认大脑`
      : `GPT 本周额度已经用了 ${wp}%，${bjWhen(week.resets_at)} 重置，省着点用`);
    weekWarned = level;
  }
  const hp = quotaPct(h5);
  if (h5 && hp >= QUOTA_5H_WARN && !h5Warned) {
    if (!notes.length) notes.push(`GPT 这 5 小时的额度已经用了 ${hp}%，${bjWhen(h5.resets_at)} 恢复`);
    h5Warned = true;
  }
  if (week && wp >= QUOTA_ADMIN_WARN && !adminWarned) {
    raiseAlert('gpt_quota', `GPT 本周额度已用 ${wp}%，${bjWhen(week.resets_at)} 重置`);
    adminWarned = true;
  }
  saveRuntimeState('codex_quota', {
    primary: h5, secondary: week, plan_type: limits.plan_type || null, reached: limits.rate_limit_reached_type || null, at: Date.now(),
    week_resets_at: week ? Number(week.resets_at) : prev.week_resets_at ?? null, week_warned: weekWarned, week_admin_warned: adminWarned,
    h5_resets_at: h5 ? Number(h5.resets_at) : prev.h5_resets_at ?? null, h5_warned: h5Warned,
  });
  return notes.length ? `（提醒：${notes.join('；')}。）` : '';
}
// 记下的额度显示某个窗口已经用满、还没到重置时间：返回那个窗口（不用再去调 GPT）
function codexQuotaExhausted() {
  const q = loadRuntimeState('codex_quota');
  const nowSec = Date.now() / 1000;
  return [q.secondary, q.primary].find((w) => w && quotaPct(w) >= 100 && Number(w.resets_at) > nowSec) || null;
}
// 「GPT 额度」：回上次用 GPT 时记下的数
function codexQuotaReport(mode) {
  const q = loadRuntimeState('codex_quota');
  const brainNow = mode === 'codex' ? '现在用的是 GPT。' : '现在用的是默认大脑。';
  if (!q.at || (!q.primary && !q.secondary)) return `还没记下 GPT 的额度（用过一次 GPT 以后再问就有了）。${brainNow}`;
  const mins = Math.round((Date.now() - q.at) / 60000);
  const ago = mins < 1 ? '刚才' : mins < 60 ? `${mins} 分钟前` : mins < 48 * 60 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
  const nowSec = Date.now() / 1000;
  const line = (w, name, verb) => (Number(w.resets_at) <= nowSec
    ? `${name}的额度 ${bjWhen(w.resets_at)} 已经${verb}过了（之前用了 ${quotaPct(w)}%）`
    : `${name}已用 ${quotaPct(w)}%，${bjWhen(w.resets_at)} ${verb}`);
  const lines = [`GPT 额度（${ago}用 GPT 时看到的）：`];
  if (q.secondary) lines.push(line(q.secondary, '本周', '重置'));
  if (q.primary) lines.push(line(q.primary, '这 5 小时', '恢复'));
  lines.push(brainNow);
  return lines.join('\n');
}
// 正在跑的 GPT 任务数（GPT 长时间不用自动切回时，有任务在跑就不切）
let codexBusy = 0;
function runCodex(promptText, threadId = null, freshPrompt = null, tagsFile = null) {
  const tagsPath = tagsFile || newReplyTagsFile();
  try { fs.appendFileSync(tagsPath, 'GPT\n'); } catch {}
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const args = ['exec', ...(threadId ? ['resume'] : []), '--json', '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox', ...(threadId ? [threadId] : []), '-'];
    console.log(`[调用 Codex]: 会话ID=${threadId || '(全新会话)'}`);
    activeAgents++;
    const child = execFile(CODEX_EXE, args, {
      cwd: botRoot,
      timeout: AGENT_TIMEOUT_MS,
      env: { ...process.env, CODEX_HOME: CODEX_HOME_DIR, CLAWBOT_REPLY_TAGS: tagsPath },
      maxBuffer: 50 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      activeAgents--;
      const tags = takeReplyTags(tagsPath);
      let thread = threadId;
      const texts = [];
      let usage = null;
      let failure = '';
      for (const line of String(stdout || '').split('\n')) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'thread.started' && ev.thread_id) thread = ev.thread_id;
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) texts.push(ev.item.text);
        else if (ev.type === 'turn.completed') usage = ev.usage || null;
        else if (ev.type === 'turn.failed' || ev.type === 'error') failure = String(ev.error?.message || ev.message || 'Codex 出错');
      }
      // 只发最后一条（前面几条是"我先核对一下"这类干活前的过程话）
      const reply = String(texts[texts.length - 1] || '').trim();
      if (error || failure || !reply) {
        const tail = String(stderr || '').trim().slice(-300);
        const kind = error?.killed ? 'timeout'
          : /log ?in|401|unauthori[sz]ed|refresh.?token/i.test(`${tail} ${failure}`) ? 'auth'
            : CODEX_QUOTA_ERROR.test(`${tail} ${failure}`) ? 'quota' : 'error';
        // 额度用完：记下这时的额度（之后几条不用再去调 GPT）
        if (kind === 'quota') { try { noteCodexQuota(codexTokenInfo(thread).rateLimits); } catch {} }
        if (threadId && kind === 'error') {
          console.warn(`[Codex] 会话 ${threadId} 接不上，开新会话重试`);
          return runCodex(freshPrompt || promptText, null, null, tagsPath)
            .then((res) => resolve({ ...res, resumeFailed: true, tags: [...new Set([...tags, ...(res.tags || [])])] }))
            .catch(reject);
        }
        console.error(`[Codex exec error]: ${kind} ${failure || tail || `exit ${error?.code ?? '-'}`}`);
        const err = new Error(`Codex processing failed: ${failure || tail || 'no reply'}`);
        err.agentFailure = kind;
        err.tags = tags;
        return reject(err);
      }
      // 回复里没带图、这一轮却画了图（GPT 自带工具的图存在它自己的目录，系统发不出去）：取最新一张放进机器人目录，自动发
      let finalReply = reply;
      try {
        if (!extractMediaPaths(reply).images.length) {
          const img = codexTurnImage(thread, startedAt);
          if (img) {
            finalReply = `${reply}\nfile://${img}`;
            console.log(`[GPT 画的图] 回复里没带，自动补发：${describePath(img)}`);
          }
        }
      } catch (e) {
        console.warn(`[GPT 画的图] 没能补发：${e.message}`);
      }
      try { finalReply = attachTurnMedia(finalReply, startedAt); } catch (e) { console.warn(`[补发] 没能补发：${e.message}`); }
      const info = codexTokenInfo(thread);
      const context = info.context;
      if (usage) console.log(`[Codex 用量]: 会话累计输入 ${usage.input_tokens ?? '?'}（其中缓存 ${usage.cached_input_tokens ?? '?'}），输出 ${usage.output_tokens ?? '?'}；会话现在约 ${context} tokens`);
      let notice = '';
      try { notice = noteCodexQuota(info.rateLimits); } catch (e) { console.warn(`[GPT 额度] 没记下：${e.message}`); }
      if (info.rateLimits) console.log(`[GPT 额度] 本周已用 ${quotaPct(info.rateLimits.secondary)}%，这 5 小时已用 ${quotaPct(info.rateLimits.primary)}%${notice ? '（这次提醒主人）' : ''}`);
      resolve({ reply: finalReply, conversationId: thread, contextTokens: context, tags, brain: 'codex', notice });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(promptText);
  });
}

// freshPrompt：原会话接不上、改开新会话重试时用的提示词（带最近几条回复的全文）；不给就用原来的
// tagsFile：这次运行的回复标签文件（不给就新建一个）
function runAgent(promptText, conversationId = null, freshPrompt = null, tagsFile = null) {
  const tagsPath = tagsFile || newReplyTagsFile();
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const args = ['--dangerously-skip-permissions'];
    if (conversationId) {
      args.push('--conversation', conversationId);
    }
    args.push(...AGY_STREAM_ARGS);

    console.log(`[调用 agy]: 会话ID=${conversationId || '(全新会话)'}`);

    activeAgents++;
    const child = execFile(
      'agy',
      args,
      {
        cwd: botRoot,
        timeout: AGENT_TIMEOUT_MS,
        env: { ...process.env, CLAWBOT_REPLY_TAGS: tagsPath },
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        activeAgents--;
        const tags = takeReplyTags(tagsPath);
        // 退出码为 0 但输出里 status 是 ERROR 的也算失败（比如登录失效）；没有 result 事件也算失败
        const outcome = agyOutcome(error, stdout, stderr);
        if (!outcome.ok) {
          // 会话本身接不上才值得换新会话重试；登录失效、超时，重试也一样失败，只会让用户多等
          if (conversationId && outcome.kind === 'error') {
            console.warn(`[agy] 会话 ${conversationId} 恢复失败，自动创建全新会话重试...`);
            // 标记 resumeFailed，回复里会告诉用户"原来的会话没接上"
            return runAgent(freshPrompt || promptText, null, null, tagsPath)
              .then((res) => resolve({ ...res, resumeFailed: true, tags: [...new Set([...tags, ...(res.tags || [])])] }))
              .catch(reject);
          }
          recordAgentResult('routine', outcome);
          // 日志和报错只用退出码和错误输出的末尾，不用 error.message（里面是完整命令行）
          const detail = outcome.kind === 'auth'
            ? outcome.reason
            : String(stderr || '').trim().slice(-300) || `exit ${error?.code ?? error?.signal ?? 'status ERROR'}`;
          console.error(`[agy exec error]: code=${error?.code ?? '-'} signal=${error?.signal ?? '-'} ${detail}`);
          const err = new Error(`Agent processing failed: ${detail}`);
          err.agentFailure = outcome.kind;
          err.tags = tags;
          return reject(err);
        }

        recordAgentResult('routine', outcome);
        if (outcome.warning) console.warn(`[agy 提示] 有回复，但带着提示（照常使用回复）：${outcome.warning}`);
        const usage = outcome.json.usage;
        if (usage) console.log(`[agy 用量]: 输入 ${usage.input_tokens ?? '?'} tokens，输出 ${usage.output_tokens ?? '?'} tokens`);
        const agyConv = outcome.json.conversation_id || conversationId;
        let agyReply = outcome.json.response || '';
        try { agyReply = attachTurnMedia(agyReply, startedAt, agyTurnImages(agyConv, startedAt)); } catch (e) { console.warn(`[补发] 没能补发：${e.message}`); }
        resolve({ reply: agyReply, conversationId: agyConv, contextTokens: agyContextTokens(stdout), tags });
      }
    );
    // 提示词从标准输入交过去；agy 提前退出时写入会报 EPIPE，忽略即可（结果由上面的回调处理）
    child.stdin.on('error', () => {});
    child.stdin.end(agyInputLine(promptText));
  });
}

/**
 * 全局主动推送防封流控熔断器 (PushRateLimiter)
 * 铁律护栏：
 * 1. 强制相邻两次主动推送必须间隔 >= minIntervalMs (12秒)，杜绝脉冲高频发送触发微信风控；
 * 2. 5 分钟滑动窗口内最多允许 maxPerWindow (3次) 主动推送；
 * 3. 超限自动推迟排队，保证平滑投递，永不打爆腾讯频率限制。
 */
class PushRateLimiter {
  constructor() {
    this.lastPushTime = 0;
    this.pushTimestamps = [];
    this.minIntervalMs = 12000; // 强制最小间隔 12 秒
    this.maxPerWindow = 3;       // 5分钟内最多 3 次
    this.windowMs = 5 * 60 * 1000;
  }

  isCoolingDown() {
    const now = Date.now();
    this.pushTimestamps = this.pushTimestamps.filter((t) => now - t < this.windowMs);
    if (this.pushTimestamps.length >= this.maxPerWindow) {
      const oldest = this.pushTimestamps[0];
      return Math.max(0, Math.ceil((this.windowMs - (now - oldest) + 1500) / 1000));
    }
    return 0;
  }

  async acquirePermission() {
    const now = Date.now();
    // 清理窗口外的历史时间戳
    this.pushTimestamps = this.pushTimestamps.filter((t) => now - t < this.windowMs);

    // 检查 5 分钟频控上限
    if (this.pushTimestamps.length >= this.maxPerWindow) {
      const oldest = this.pushTimestamps[0];
      const waitTime = this.windowMs - (now - oldest) + 1500;
      console.warn(`[防封流控触发]: 5分钟内主动推送已达上限(${this.maxPerWindow}条)，安全冷却 ${Math.ceil(waitTime / 1000)} 秒...`);
      await new Promise((r) => setTimeout(r, waitTime));
    }

    // 检查相邻间隔频控
    const elapsed = Date.now() - this.lastPushTime;
    if (elapsed < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - elapsed;
      console.log(`[防封冷却]: 间隔保护，等待 ${waitTime}ms 后再下发微信消息...`);
      await new Promise((r) => setTimeout(r, waitTime));
    }

    this.lastPushTime = Date.now();
    this.pushTimestamps.push(this.lastPushTime);
  }
}

const pushRateLimiter = new PushRateLimiter();

// 活跃后台任务集合（存储 key: "userId:messageText"），实现防重与幂等
const activeBackgroundTasks = new Set();
// 已经转入后台、还没跑完的任务：key → 这条消息开始处理的时间。期间问进度直接回，不再开一个新的智能体会话
// （新会话看不到后台任务做到哪了，还要花一两分钟和十几万 tokens）
const backgroundTasks = new Map();
const STATUS_QUESTION = /^(咋样了?|怎么样了?|好了吗|好了没有?|好了么|好没好|进度(呢|如何|怎么样)?|还没好吗?|还要多久|要多久|多久|完成了吗|完成了没|弄好了吗|弄好了没|搞定了吗|搞定了没|搞定没|还在弄吗|到哪了|到哪一步了|在吗|在不在|还在线吗|在线吗|人呢|还在吗|有在吗|你还在吗|人还在吗)[\s啊呀呢吧嘛哈～~。.!！?？…]*$/;

// 同时最多运行的智能体数量（含转入后台的任务），超出的消息留在收件箱里排队
const MAX_ACTIVE_AGENTS = 2;
// 超过这个时间还没出结果，先回一句"转入后台"，任务继续在后台跑（环境变量仅供测试缩短）。
// 原来是 35 秒：实测一条消息中位数就要 48 秒，七成消息都会先收到这句；改成 90 秒后大约一成多
const SOFT_TIMEOUT_MS = Number(process.env.ROUTINE_SOFT_TIMEOUT_MS) || 90000;
// 转入后台以后，每隔多久报一次"还在做"、最多报几次（环境变量用来测试和调整）
const PROGRESS_PING_MS = Number(process.env.ROUTINE_PROGRESS_PING_MS) || 15 * 60_000;
const PROGRESS_PING_MAX = process.env.ROUTINE_PROGRESS_PING_MAX !== undefined ? Number(process.env.ROUTINE_PROGRESS_PING_MAX) : 3;
// 等结果期间每隔多久重发一次"正在输入"，免得对方以为没反应（环境变量仅供测试）
const TYPING_REFRESH_MS = Number(process.env.ROUTINE_TYPING_REFRESH_MS) || 20000;
// 主会话每天换一次：北京时间 03:30（凌晨整理完记忆）以后的第一条消息开新会话；会话库太大、或者上一次回复时会话已经超过
// ROTATE_MAX_TOKENS 时也提前换。
// 不写重置标记：最近几轮聊天和长期记忆照常带上，只是 agy 不再背着越来越长的历史（环境变量仅供测试）
const ROTATE_AT_MINUTES = Number(process.env.ROUTINE_ROTATE_AT_MINUTES || 210);
const ROTATE_MAX_BYTES = Number(process.env.ROUTINE_ROTATE_MAX_BYTES) || 20 * 1024 * 1024;
// 主会话上一次回复时带的上下文（agy 报的输入 token）超过这个数，下一条消息就开新会话：
// 一整天不换的话，晚上会涨到 25 万（模型上限），agy 自己压缩时会丢细节，每次调用也白白重发十几万 token
const ROTATE_MAX_TOKENS = Number(process.env.ROUTINE_ROTATE_MAX_TOKENS) || 80000;
// 开新会话时（换会话、后台占用期间的临时会话、原会话接不上），最近几条助手回复带全文、每条最多多少字；平时只带前 200 字
const FULL_REPLIES_ON_NEW_SESSION = 2;
const FULL_REPLY_MAX_CHARS = 2000;

// 最近一次已经过去的北京时间 03:30（毫秒时间戳）
function lastRotationBoundary(now = Date.now()) {
  const bj = new Date(now + 8 * 3600000);
  let boundary = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000 + ROTATE_AT_MINUTES * 60000;
  if (boundary > now) boundary -= 86400000;
  return boundary;
}

// 主会话该不该换：返回原因，不用换返回 null
function conversationRotationReason(state, convId) {
  if (!convId) return null;
  const startedAt = Number(state.conversation_started_at) || 0;
  if (startedAt < lastRotationBoundary()) return '已经过了凌晨整理记忆的时间';
  const tokens = Number(state.conversation_tokens) || 0;
  if (tokens > ROTATE_MAX_TOKENS) return `会话已经有 ${(tokens / 10000).toFixed(1)} 万 token`;
  try {
    const db = path.join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'conversations', `${convId}.db`);
    const size = fs.statSync(db).size;
    if (size > ROTATE_MAX_BYTES) return `会话库已经有 ${(size / 1048576).toFixed(1)}MB`;
  } catch {}
  return null;
}

// 会话占用锁：主会话被转入后台的任务占着时，新消息改用临时会话，避免两个 agy 同时写同一个会话
let mainConversationBusy = false;
// 每次"重置会话"加一；后台任务结束时只有代数没变才回写会话 ID，不会把重置覆盖掉
let mainConversationGeneration = 0;
// 主会话被后台任务占着的这一段时间（一个"占用期"），后面来的消息共用一个临时会话，聊得连贯；
// 占用期结束（后台任务做完）或者用户重置会话就丢掉。上一条临时消息还在跑时，新消息另开一个，不同时写同一个会话
let mainBusyEpoch = 0;
let sideConversation = { epoch: -1, generation: -1, id: null, running: false };
const resetSideConversation = (epoch = -1) => {
  sideConversation = { epoch, generation: mainConversationGeneration, id: null, running: false };
};

const CONVERSATION_LOST_NOTICE = '（提示：原来的会话没能接上，已经开了一个新会话，之前聊过的细节可能记不全了。）';
// 智能体登录失效时回给用户的话（监控会同时通知主人去重新登录）
const agentLoginNotice = (botName) => `${botName}这会儿连不上智能体（登录失效了），已经通知去处理了，稍后再试哦～`;

/**
 * 人性化错误转译器：彻底屏蔽底层代码中的 exit 1、JSON、模型代号等技术黑话
 */
function formatFriendlyError(execErr, botName, userNickname) {
  const msg = String(execErr?.message || execErr || '');
  // 1. 服务拥堵 / 503 / 负载过高
  if (/503|UNAVAILABLE|No capacity available|overloaded/i.test(msg)) {
    return `${userNickname}，AI 模型服务器当前网络负载较高（正在排队），小助理的大脑正在稍作缓冲～请您稍等 1~2 分钟再发我试下～`;
  }
  // 2. 限流 / 429 / 频控
  if (/429|RESOURCE_EXHAUSTED|rate limit|quota/i.test(msg)) {
    // 可能只是发得太快，也可能是智能体的用量到了上限（要等好几个小时）：不承诺"马上恢复"
    return `${userNickname}，智能体这会儿触发了用量或频率限制，这次没处理成，请稍后再发我一次试试～`;
  }
  // 3. 超时 / 耗时过长
  if (/stream idle timeout|context deadline exceeded|timeout|SIGTERM/i.test(msg)) {
    return `${userNickname}，由于该任务内容较长，处理耗时超过了网络保护上限，稍候您可以精简一下内容或分段发我试下～`;
  }
  // 4. 微信窗口已关闭
  if (/prepare failed/i.test(msg)) {
    return `${userNickname}，微信消息窗口已休眠，请您在微信中回复任意文字即可重新激活对话～`;
  }
  // 5. 进程退出或通用错误（完全过滤掉 exit 1、JSON、模型代号）
  if (/exit 1|exit [0-9]|status ERROR|Agent processing failed/i.test(msg)) {
    return `${userNickname}，刚才处理这段内容时中断了，这次没处理成。您换个更简洁的问法，或者稍后再发我一次试试～`;
  }
  // 6. 其他未知异常保底脱敏（只说没处理成，不说程序没做过的事）
  return `${userNickname}，刚才的任务没处理成，您稍后再发我一次试试～`;
}

// 自动发过的媒体：同一个文件（路径 + 修改时间 + 大小）1 小时内只自动发一次。后台任务的结果和接着问的一句常会提到同一个文件，
// 不记一下就会发两遍。记在 data/state/sent_media.json（只存哈希，不存文件名），重启也不丢；用户明确要再发时照发
const SENT_MEDIA_TTL_MS = 3600_000;
const RESEND_REQUEST = /再发|重发|重新发|没收到|收不到|发不出|打不开|看不了/;
function mediaKey(p) {
  try {
    const st = fs.statSync(p);
    return crypto.createHash('sha1').update(`${p}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
function recentSentMedia() {
  const now = Date.now();
  return (loadRuntimeState('sent_media').items || []).filter((x) => now - x.at < SENT_MEDIA_TTL_MS);
}
function unsentMedia(media, userText) {
  if (RESEND_REQUEST.test(userText || '')) return media;
  const sent = new Set(recentSentMedia().map((x) => x.key));
  const keep = (list = []) => list.filter((p) => {
    if (!sent.has(mediaKey(p))) return true;
    console.log(`[媒体去重]: ${describePath(p)} 1 小时内已经发过，这次只发文字`);
    return false;
  });
  return { images: keep(media.images), videos: keep(media.videos), files: keep(media.files) };
}
function markMediaSent(p) {
  const key = mediaKey(p);
  if (key) saveRuntimeState('sent_media', { items: [...recentSentMedia(), { key, at: Date.now() }].slice(-200) });
}

/**
 * 聚合交付下发引擎：将文本回复与附带媒体（图片/原生视频卡片/文件）安全推送到微信。
 * userText 是引出这条回复的用户消息：用户要"再发"时，1 小时内发过的媒体照样发
 */
async function deliverResultToWechat(toUserId, contextToken, textReply, rawAgentReply, isAsyncCallback = false, userText = '') {
  const config = loadConfig();
  // 去 Markdown 统一在 sendWechatReply 里做一次；这里再做一遍会伤到已经去掉反引号的代码内容
  const plainReply = textReply;

  if (isAsyncCallback) {
    // 异步回调受防封流控保护
    await pushRateLimiter.acquirePermission();
  }

  // 1. 发送文字内容
  try {
    await sendWechatReply(toUserId, contextToken, plainReply, config);
    console.log(`[已成功将${isAsyncCallback ? '异步' : '同步'}文本发送至微信]`);
    appendLog(`AI回复(${isAsyncCallback ? '后台回调' : '实时'}): ${plainReply}`);
  } catch (replyErr) {
    console.error(`[回复微信文本失败]:`, replyErr.message);
    raiseAlert('reply_failed', `一条回复没发出去：${replyErr.message}`);
  }

  // 2. 检查是否有新鲜生成的媒体 (图片 / 视频 / 文件)；1 小时内自动发过的同一个文件不再发
  const media = unsentMedia(extractMediaPaths(rawAgentReply || textReply), userText);

  // 2.1 图片 (仅推 1 张最新图片)
  if (media.images && media.images.length > 0) {
    const latestImg = media.images[media.images.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送图片至微信]: ${describePath(latestImg)}`);
      await uploadAndSendWechatImage(toUserId, contextToken, latestImg, config);
      markMediaSent(latestImg);
      console.log(`[已成功将图片卡片发送至微信]: ${describePath(latestImg)}`);
    } catch (imgErr) {
      console.error(`[发送微信图片卡片失败]:`, imgErr.message);
    }
  }

  // 2.2 视频 (原生 Type 5 视频卡片)
  if (media.videos && media.videos.length > 0) {
    const latestVideo = media.videos[media.videos.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送原生视频卡片至微信]: ${describePath(latestVideo)}`);
      const sent = await uploadAndSendWechatVideo(toUserId, contextToken, latestVideo, config);
      markMediaSent(latestVideo);
      if (sent?.fallback) {
        // 重试了几次还是没传上，按文件发的：跟用户说一声，不然看到的是一个 .mp4 文件，以为没按要求发
        console.log(`[视频卡片没发成，改成文件发了]: ${describePath(latestVideo)}`);
        const note = '（这个视频的播放卡片微信那边没传上去，先按文件发你了，点开一样能看。要卡片的话，过一会儿跟我说"再发一次"。）';
        try {
          if (isAsyncCallback) await pushRateLimiter.acquirePermission();
          await sendWechatReply(toUserId, contextToken, note, config);
          appendLog(`AI回复(提示): ${note}`);
        } catch (noteErr) {
          console.error('[视频改成文件发的提示没发出去]:', noteErr.message);
        }
      } else {
        console.log(`[已成功将原生视频卡片发送至微信]: ${describePath(latestVideo)}`);
      }
    } catch (vidErr) {
      console.error(`[发送微信原生视频卡片失败]:`, vidErr.message);
    }
  }

  // 2.3 文件
  if (media.files && media.files.length > 0) {
    const latestFile = media.files[media.files.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送文件至微信]: ${describePath(latestFile)}`);
      await uploadAndSendWechatFile(toUserId, contextToken, latestFile, config);
      markMediaSent(latestFile);
      console.log(`[已成功将文件发送至微信]: ${describePath(latestFile)}`);
    } catch (fileErr) {
      console.error(`[发送微信文件失败]:`, fileErr.message);
    }
  }
}

/**
 * 从单个日志文件中提取有效对话轮次（从新往旧读）。
 * 读到"会话已重置"标记就停：用户清除过记忆，更早的对话一律不再带入。返回 { turns, hitReset }。
 */
function parseTurnsFromLog(filePath, maxTurns = 10) {
  if (!fs.existsSync(filePath)) return { turns: [], hitReset: false };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/);
    const parsedTurns = [];

    for (let i = lines.length - 1; i >= 0 && parsedTurns.length < maxTurns; i--) {
      const block = lines[i].trim();
      if (!block) continue;

      // 只有整条日志就是重置标记才算；用户在聊天里引用"[会话已重置]"这几个字不算
      if (isResetEntry(block)) {
        return { turns: parsedTurns, hitReset: true };
      }
      if (block.includes('[后台接管预告]')) {
        continue;
      }

      const userMatch = block.match(/\[.*?\]\s*微信接收\s*\([^)]+\):\s*([\s\S]*)/);
      if (userMatch) {
        const text = userMatch[1].trim();
        if (text) parsedTurns.unshift({ role: '用户', text });
        continue;
      }

      const aiMatch = block.match(/\[.*?\]\s*AI回复(?:\([^)]*\))?:\s*([\s\S]*)/);
      if (aiMatch) {
        let text = aiMatch[1].trim();
        text = text.replace(/^🔔\s*【后台任务完成通知】\s*[\r\n]*/, '');
        text = text.replace(/^[^\n]*您交办的长任务已全部处理完成[^\n]*[\r\n]*/, '');
        const condensed = text.split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 200);
        if (condensed) {
          // full：回复原文，开新会话时最近几条带全文用
          parsedTurns.unshift({ role: '助手', text: condensed + (text.length > 200 ? '...' : ''), full: text.trim() });
        }
        continue;
      }
    }
    return { turns: parsedTurns, hitReset: false };
  } catch {
    return { turns: [], hitReset: false };
  }
}

/**
 * 提取最近几轮真实对话上下文 (跨天无缝缝合滑窗防失忆护栏)；遇到"会话已重置"标记就不再往前读。
 * 助手的话平时只带前 200 字；fullReplies > 0 时（开新会话），最近这么多条助手回复带全文（每条最多 FULL_REPLY_MAX_CHARS 字）
 */
function getRecentChatContext(maxRounds = 5, { fullReplies = 0 } = {}) {
  const neededTurns = maxRounds * 2;
  const todayFile = getDailyLogPath(0);
  const yesterdayFile = getDailyLogPath(-1);

  // 1. 优先读取今天的切片日志
  const today = parseTurnsFromLog(todayFile, neededTurns);
  let turns = today.turns;
  let hitReset = today.hitReset;

  // 2. 如果今天刚过零点对话较少，向前无缝补齐昨天的对话记录
  if (!hitReset && turns.length < neededTurns && fs.existsSync(yesterdayFile)) {
    const yesterday = parseTurnsFromLog(yesterdayFile, neededTurns - turns.length);
    turns = [...yesterday.turns, ...turns];
    hitReset = yesterday.hitReset;
  }

  // 3. 向下兼容：如果按天切片尚未沉淀，保底读取旧单文件
  if (!hitReset && turns.length === 0 && fs.existsSync(LOG_FILE)) {
    turns = parseTurnsFromLog(LOG_FILE, neededTurns).turns;
  }

  if (turns.length > 0) {
    const replyIdx = turns.map((t, i) => (t.full ? i : -1)).filter((i) => i >= 0);
    const fullIdx = new Set(fullReplies > 0 ? replyIdx.slice(-fullReplies) : []);
    const formatted = turns.map((t, i) => {
      if (!fullIdx.has(i) || t.full === t.text) return `- ${t.role}: ${t.text}`;
      const chars = [...t.full];
      const body = chars.length > FULL_REPLY_MAX_CHARS
        ? `${chars.slice(0, FULL_REPLY_MAX_CHARS).join('')}…（这条回复共 ${chars.length} 字，后面省略）`
        : t.full;
      return `- ${t.role}（回复全文）: ${body}`;
    }).join('\n');
    return `\n\n【最近对话历史上下文 (跨天连续记忆)】：\n${formatted}\n`;
  }
  return '';
}

// 英文关键词要求前后不紧挨着字母（gp 不会命中 gpt，但 1000gp 照样命中），中文关键词按包含匹配
function matchesKeyword(text, keyword) {
  const k = String(keyword).toLowerCase();
  if (!k) return false;
  if (/^[a-z0-9]+$/.test(k)) return new RegExp(`(^|[^a-z])${k}($|[^a-z])`).test(text);
  return text.includes(k);
}

// 之前几条用户消息（不含正在处理的这一条）；遇到"会话已重置"就不再往前找
function recentUserTexts(count, currentText) {
  const today = parseTurnsFromLog(getDailyLogPath(0), 30);
  let turns = today.turns;
  if (!today.hitReset && turns.filter((t) => t.role === '用户').length <= count) {
    turns = [...parseTurnsFromLog(getDailyLogPath(-1), 30).turns, ...turns];
  }
  const users = turns.filter((t) => t.role === '用户').map((t) => t.text);
  if (users.length && users[users.length - 1] === String(currentText || '').trim()) users.pop();
  return users.slice(-count);
}

// 「X改动」的 X 是哪个机器人：自己；独立模式下看 bots/ 下有哪些；统一管理时只认管理服务给管理员准备的名单
function resolveBotName(name, botsDir, config) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const self = path.basename(botRoot);
  if (want === self.toLowerCase() || want === String(config.bot_name || '').toLowerCase()) return self;
  if (!MANAGED) return findBotByName(name, { botsDir });
  let list = [];
  try { list = loadRuntimeState('manager_bots'); } catch {}
  const hit = (Array.isArray(list) ? list : []).find((b) => String(b.bot).toLowerCase() === want || String(b.name).toLowerCase() === want);
  return hit ? hit.bot : null;
}

// 转给管理服务的请求，10 分钟以前的（管理服务没处理的）清掉
function cleanOldRequests() {
  const dir = path.join(dataDir, 'requests');
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 600_000) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
}

/**
 * 加载当前 Bot 的专题：这条消息或之前两条用户消息里提到关键词才带（聊着聊着不会突然丢掉），
 * 每条消息最多带 MAX_TOPICS_PER_MESSAGE 本：这条消息提到的优先，关键词命中多的优先。
 * 提到了但没带上的，告诉智能体文件在哪，需要时自己读。
 * 专题和关键词写在各实例自己的 topics.json 里，核心代码不写死任何个人信息。
 */
function loadTopicMemory(messageText) {
  const topicsDir = path.join(botRoot, 'data', 'memory', 'topics');
  const current = String(messageText || '').toLowerCase();
  const earlier = recentUserTexts(2, messageText).join('\n').toLowerCase();
  const hits = [];
  for (const topic of loadTopicsConfig(botRoot)) {
    const now = topic.keywords.filter((k) => matchesKeyword(current, k)).length;
    const before = now ? 0 : topic.keywords.filter((k) => matchesKeyword(earlier, k)).length;
    if (!now && !before) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(topicsDir, topic.file), 'utf-8').trim(); } catch {}
    if (content) hits.push({ ...topic, content, score: now * 100 + before });
  }
  if (!hits.length) return '';
  const ranked = [...hits].sort((a, b) => b.score - a.score);
  const chosen = ranked.slice(0, MAX_TOPICS_PER_MESSAGE);
  const sections = chosen.map((t) => {
    const { text: content, truncated } = capForLoading(t.content, TOPIC_MAX_CHARS);
    if (truncated) console.warn(`[专题分卷] ${t.file} 超过上限太多，这次只带了前 ${TOPIC_MAX_CHARS * 2} 字`);
    return `【${t.name} (${t.file})】：\n${content}`;
  });
  const left = ranked.slice(MAX_TOPICS_PER_MESSAGE);
  if (left.length) {
    sections.push(`（这次也提到了${left.map((t) => `「${t.name}」`).join('')}，没有带上；需要时读 ${left.map((t) => `data/memory/topics/${t.file}`).join('、')}）`);
  }
  return `\n\n${sections.join('\n\n')}\n`;
}

// 问到以前的事（上个月、那天、几月几号……）才带大事记：提到某个月份就先带那个月，再从最近的月份往前补，合计不超过 TIMELINE_LOAD_MAX_CHARS 字
const TIME_QUESTION = /上上?个?月|上上?周|上个?星期|上次|那天|那次|当时|前几天|前阵子|前段时间|去年|几号|哪天|哪一天|什么时候|多久以前|(?:之前|以前)(?:说|聊|讲|定|提|问|做)|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*月份/;
function loadTimeline(messageText) {
  const text = String(messageText || '');
  if (!TIME_QUESTION.test(text)) return '';
  let files = [];
  try {
    files = fs.readdirSync(path.join(botRoot, TIMELINE_DIR)).filter((f) => /^\d{4}-\d{2}\.md$/.test(f)).sort().reverse();
  } catch {
    return '';
  }
  if (!files.length) return '';
  const month = text.match(/(\d{1,2})\s*月/);
  if (month) {
    const mm = `-${String(Number(month[1])).padStart(2, '0')}.md`;
    const hit = files.find((f) => f.endsWith(mm));
    if (hit) files = [hit, ...files.filter((f) => f !== hit)];
  }
  const parts = [];
  let left = TIMELINE_LOAD_MAX_CHARS;
  for (const f of files) {
    if (left <= 200) break;
    let content = '';
    try { content = fs.readFileSync(path.join(botRoot, TIMELINE_DIR, f), 'utf-8').trim(); } catch {}
    if (!content) continue;
    const chars = [...content];
    // 一个月的太长：只带最近的部分
    const piece = chars.length > left ? `…（前面省略）\n${chars.slice(chars.length - left).join('')}` : content;
    parts.push(`[${f.replace(/\.md$/, '')}]\n${piece}`);
    left -= Math.min(chars.length, left);
  }
  return parts.length ? `\n\n【大事记（data/memory/timeline/，按月）】：\n${parts.join('\n\n')}\n` : '';
}

// 资料库里有哪些（只列目录和文件数，不带内容）：让智能体知道去哪查细节
function libraryHint() {
  const root = path.join(botRoot, LIBRARY_DIR);
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  const shelves = [];
  let loose = 0;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      let n = 0;
      try { n = fs.readdirSync(path.join(root, e.name)).filter((f) => f.endsWith('.md')).length; } catch {}
      if (n) shelves.push(`${e.name}/（${n} 个文件）`);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      loose++;
    }
  }
  if (loose) shelves.push(`另有 ${loose} 个文件`);
  if (!shelves.length) return '';
  return `\n\n（资料库 ${LIBRARY_DIR}/：${shelves.slice(0, 12).join('、')}${shelves.length > 12 ? ' 等' : ''}。专题里写着"细节见资料库…"或回答需要细节时，用文件工具去读；以前聊天的原话在 data/history/，按天保存一年。）\n`;
}

/**
 * 读取当前 Bot 专属的核心档案 (MEMORY.md) + 专题分卷
 */
function loadBotMemory(messageText = '') {
  let result = '';
  // 1. 核心常驻档案（人设、禁忌、称呼、核心准则）：超过上限照常全部带上，超过两倍才截断
  const memoryPath = path.join(botRoot, 'MEMORY.md');
  if (fs.existsSync(memoryPath)) {
    try {
      const content = fs.readFileSync(memoryPath, 'utf-8').trim();
      if (content) {
        const { text, truncated } = capForLoading(content, MEMORY_MAX_CHARS);
        if (truncated) console.warn(`[MEMORY.md] 超过上限太多，这次只带了前 ${MEMORY_MAX_CHARS * 2} 字`);
        result += `\n\n【核心记忆档案与人设 (MEMORY.md)】：\n${text}\n`;
      }
    } catch (e) {
      console.warn('[读取 MEMORY.md 异常]:', e.message);
    }
  }

  // 2. 专题：按关键词（这条消息和之前两条），最多两本
  const topicContent = loadTopicMemory(messageText);
  if (topicContent) {
    result += topicContent;
  }
  // 3. 问到以前的事才带大事记；资料库只说有哪些，不带内容
  result += loadTimeline(messageText);
  result += libraryHint();

  return result;
}

/**
 * 处理一条消息。返回 null 表示已处理完；任务转入后台时返回 { background }，background 在后台结束时 resolve。
 * （不能直接返回 Promise：async 函数会自动等它完成，调用方就被卡到后台任务结束。）
 */
async function handleWechatTask(task) {
  const { from_user_id, message_text, context_token } = task;
  const config = loadConfig();

  // 第二道防线：forwarder 已经过滤过，这里再确认一次，防止有人绕过 forwarder 直接调用本地 webhook
  if (!config.authorized_user_id || from_user_id !== config.authorized_user_id) {
    console.warn(`[拒绝处理] 消息不是来自本实例绑定的授权用户 (${from_user_id || '未知'})，已忽略。`);
    return null;
  }

  console.log(`\n================== [微信消息开始处理] ==================`);
  console.log(`用户ID: ${from_user_id}`);
  console.log(`消息内容: ${describeText(message_text)}`);

  // 「设置凭证 B站 <cookie>」：程序直接存进这个机器人自己的 data/skills/<技能>/cookie.txt，不经过智能体；
  // 凭证不写进聊天日志（只记一句设了哪个），免得被整理进记忆、留在版本记录里
  const credential = parseCredentialCommand(message_text);
  if (credential) {
    appendLog(`微信接收 (${from_user_id}): 设置凭证 ${credential.label}（内容不记录）`);
    let reply;
    if (!credential.skill || !credential.value) {
      reply = `${credential.skill || !credential.label ? '' : `不认识「${credential.label}」。`}${credentialHelp()}`;
    } else {
      try {
        saveSkillCredential(botRoot, credential);
        reply = `已保存${credential.label}的凭证（只有${config.bot_name || '我'}自己能读，这条消息的内容不会记进聊天记录）。`
          + (isInstalled(botRoot, credential.skill) ? '' : `${credential.label}技能还没装，要用的话跟我说一声"装上${credential.label}技能"。`);
      } catch (err) {
        reply = `凭证没有保存：${err.message}`;
      }
    }
    console.log(`[设置凭证] ${credential.skill || '不认识的技能'}：${reply.startsWith('已保存') ? '已保存' : '没保存'}`);
    if (context_token) await sendWechatReply(from_user_id, context_token, reply, config);
    console.log(`====================================================\n`);
    return null;
  }

  appendLog(`微信接收 (${from_user_id}): ${message_text}`);

  // 快捷重置会话指令判断
  const isResetCommand = RESET_COMMAND.test(message_text);
  if (isResetCommand) {
    mainConversationGeneration++;
    // 后台占用期间的临时会话也一起丢掉：重置以后的消息不再接着它
    resetSideConversation(mainConversationBusy ? mainBusyEpoch : -1);
    saveRuntimeState('routine', { conversation_id: null, conversation_tokens: 0 });
    // 写进聊天日志：之后组装最近对话、凌晨整理记忆都只看这个标记之后的内容
    appendLog(RESET_MARKER);
    const resetNotice = '已开启全新对话：之前的聊天上下文已经清空。长期记忆档案仍然保留，如果要删掉某条长期记忆，直接告诉我就好。';
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, resetNotice, config);
    }
    console.log(`[会话已重置] 用户请求清除上下文。`);
    console.log(`====================================================\n`);
    return null;
  }

  // 微信一键升级已关闭：代码更新改在服务器上进行（git + systemctl restart），这里只回一句说明
  const isUpgradeCommand = UPGRADE_COMMAND.test(message_text);
  if (isUpgradeCommand) {
    const upgradeNotice = '⚙️ 微信里的一键升级已经关闭。需要更新时，请在服务器上更新代码后重启服务。';
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, upgradeNotice, config);
    }
    console.log(`[升级指令] 微信一键升级已关闭，已提示用户。`);
    console.log(`====================================================\n`);
    return null;
  }

  // 管理指令（「记忆改动」「撤销 N」，管理员还能「X改动」看别的机器人的）：程序直接认，不经过智能体；回复里有记忆内容，
  // 不写进聊天日志（免得被整理进机器人自己的记忆）。自己管版本的（独立模式）就在这里处理；统一管理时交给管理服务。
  // 汇报样式是 plain（只列记忆、不编号）的机器人不认这些，照常交给智能体；带名字的对不上任何机器人，也当普通消息
  const botsDir = path.dirname(botRoot);
  const numbered = (config.digest_style || (MEMORY_REVIEW ? 'numbered' : 'plain')) !== 'plain';
  let memoryCommand = (MEMORY_REVIEW || MANAGED) && numbered ? parseMemoryCommand(message_text) : null;
  let showBot = null;
  if (memoryCommand?.type === 'show') {
    showBot = memoryCommand.name ? resolveBotName(memoryCommand.name, botsDir, config) : path.basename(botRoot);
    if (!showBot) memoryCommand = null;
  }
  if (memoryCommand && MANAGED) {
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const file = path.join(dataDir, 'requests', `${id}.json`);
    try {
      cleanOldRequests();
      writeJsonAtomic(file, { id, type: memoryCommand.type, bot: showBot, items: memoryCommand.items, scope: memoryCommand.scope, from_user_id, context_token, at: Date.now() });
      console.log(`[管理指令] ${memoryCommand.type === 'show' ? '查看改动' : '撤销'}：已交给管理服务`);
      // 管理服务处理完会删掉请求；过一会儿还在，说明它没在运行，如实告诉用户（监控那边也会告警）
      setTimeout(() => {
        if (!fs.existsSync(file)) return;
        fs.rmSync(file, { force: true });
        sendWechatReply(from_user_id, context_token, '这条指令暂时没人处理（管理服务没在运行），管理员会收到告警。稍后再发一次试试。', config)
          .catch((err) => console.error('[回复管理指令失败]:', err.message));
      }, REQUEST_WAIT_MS).unref();
    } catch (err) {
      console.error('[管理指令转交失败]:', err.message);
      if (from_user_id && context_token) await sendWechatReply(from_user_id, context_token, '这条指令没有转交成功，原因记在日志里了，稍后再试一次。', config);
    }
    console.log(`====================================================\n`);
    return null;
  }
  if (memoryCommand) {
    let reply;
    try {
      reply = memoryCommand.type === 'show'
        ? showChanges({ botsDir, bot: showBot })
        : undoItems(memoryCommand.items, { botsDir, scope: memoryCommand.scope });
      console.log(`[记忆命令] ${memoryCommand.type === 'show' ? '查看改动' : '撤销'}：已处理`);
    } catch (err) {
      console.error('[记忆命令失败]:', err.message);
      reply = '这条记忆命令没有执行成功，原因记在日志里了，稍后再试一次。';
    }
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, reply, config);
    }
    console.log(`====================================================\n`);
    return null;
  }

  const userNickname = config.user_nickname || '主人';
  const botName = config.bot_name || '小助理';
  const personaDesc = config.persona_description || `【${botName}】`;
  const forbiddenPrompt = config.forbidden_persona ? `严禁称呼用户为“${config.forbidden_persona}”。` : '';

  // 状态询问与流控防连击：流控冷却中或后台任务运行中，直接秒回，不调用智能体
  const coolingSeconds = pushRateLimiter.isCoolingDown();
  const hasBackground = backgroundTasks.size > 0;
  if ((hasBackground || coolingSeconds > 0) && STATUS_QUESTION.test(message_text.trim())) {
    let statusReply = '';
    if (coolingSeconds > 5) {
      statusReply = `${userNickname}，在的在的！刚才发送较快触发了微信防频控保护，正在安全冷却中（预计还需 ${coolingSeconds} 秒），解冻后结果马上给您送达～`;
    } else if (hasBackground) {
      const minutes = Math.max(1, Math.round((Date.now() - Math.min(...backgroundTasks.values())) / 60000));
      const status = backgroundTasks.size > 1
        ? `还有 ${backgroundTasks.size} 个任务在后台全力整理中，最早的那个已经进行约 ${minutes} 分钟了`
        : `刚才那个任务还在后台全力整理中，已经进行约 ${minutes} 分钟了`;
      statusReply = `${userNickname}，在的在的！${status}，好了【${botName}】马上发您～`;
    } else {
      statusReply = `${userNickname}，在的在的！【${botName}】时刻在线，随时准备为您效劳～`;
    }
    console.log('[状态询问]: 直接温和回复当前状态，不调用智能体');
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, statusReply, config);
    }
    appendLog(`AI回复(状态): ${statusReply}`);
    console.log(`====================================================\n`);
    return null;
  }

  // 幂等防重检查：如果同一个任务正在后台运行，直接温和提示，不重复启动
  const taskKey = `${from_user_id}:${message_text.trim()}`;
  // 日志里用短哈希指代任务，不记消息原文
  const taskLabel = `任务#${crypto.createHash('sha1').update(taskKey).digest('hex').slice(0, 8)}`;
  if (activeBackgroundTasks.has(taskKey)) {
    console.log(`[防重幂等拦截]: 任务正在后台运行中，跳过重复拉起: ${taskLabel}`);
    const dupNotice = `${userNickname}，该任务已经在后台全力运转中啦，请稍候片刻，处理完成后【${botName}】会第一时间主动发给您～`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, dupNotice, config);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
    console.log(`====================================================\n`);
    return null;
  }

  // 1. 发送输入中状态
  // GPT 大脑：「切到 GPT」「切回来」程序直接切；「用 GPT …」只这一条交给 Codex（只有 config.json 开了 codex_brain 的机器人认）
  let brain = 'agy';
  if (config.codex_brain) {
    const cmd = parseBrainCommand(message_text);
    if (cmd?.kind === 'on' || cmd?.kind === 'off' || cmd?.kind === 'quota') {
      // （「微信接收」前面已经记过了，这里只记回复）
      let reply;
      const empty = cmd.kind === 'on' ? codexQuotaExhausted() : null;
      if (cmd.kind === 'quota') {
        reply = codexQuotaReport(loadRuntimeState('brain').mode);
        console.log('[GPT 额度] 直接回记下的额度，不调用 GPT');
      } else if (empty) {
        reply = `GPT 的额度用完了，${bjWhen(empty.resets_at)} 恢复，先接着用默认的大脑。`;
        console.log('[切换大脑] GPT 额度用完了，没切');
      } else {
        const now = Date.now();
        saveRuntimeState('brain', cmd.kind === 'on' ? { mode: 'codex', changed_at: now, last_used_at: now } : { mode: 'agy', changed_at: now });
        reply = cmd.kind === 'on' ? '好，接下来用 GPT 回答（说「切回来」换回）。' : '好，换回来了，接下来用默认的大脑回答。';
        console.log(`[切换大脑] ${cmd.kind === 'on' ? 'GPT（Codex）' : 'Antigravity'}`);
      }
      appendLog(`AI回复(实时): ${reply}`);
      if (context_token) await sendWechatReply(from_user_id, context_token, reply, config);
      console.log(`====================================================\n`);
      return null;
    }
    const parts = Array.isArray(task.parts) && task.parts.length ? task.parts : [message_text];
    if (parts.some((p) => parseBrainCommand(p)?.kind === 'once') || loadRuntimeState('brain').mode === 'codex') brain = 'codex';
  }

  if (from_user_id && context_token) {
    await sendWechatTyping(from_user_id, context_token, 1, config);
  }

  // 2. 调用 Antigravity 生成回复（带多轮会话记忆、长期记忆库与最近对话滑窗护栏）
  console.log(brain === 'codex' ? '[GPT 思考中...]' : '[Antigravity 思考中...]');
  // 会话占用锁：主会话空闲就用主会话；正被转入后台的任务占着时，改用临时会话，结果也不回写主会话 ID
  const useMainConversation = !mainConversationBusy;
  const generation = mainConversationGeneration;
  const routineState = useMainConversation ? loadRuntimeState('routine') : {};
  let currentConvId = useMainConversation ? routineState.conversation_id || null : null;
  // 后台占用期间：接着用这段时间的临时会话；上一条临时消息还在跑，就另开一个（不同时写同一个会话）
  const sideEpoch = mainBusyEpoch;
  const useSide = !useMainConversation && sideConversation.epoch === sideEpoch
    && sideConversation.generation === generation && !sideConversation.running;
  if (!useMainConversation) {
    if (useSide) {
      currentConvId = sideConversation.id;
      sideConversation.running = true;
    }
    console.log(currentConvId
      ? '[会话占用] 主会话正被后台任务使用，本条消息接着用这段时间的临时会话。'
      : '[会话占用] 主会话正被后台任务使用，本条消息开临时会话处理（这段时间后面的消息接着用它）。');
  }
  const rotateReason = useMainConversation && brain !== 'codex' ? conversationRotationReason(routineState, currentConvId) : null;
  if (rotateReason) {
    console.log(`[会话轮换] ${rotateReason}，这条消息开新会话（最近的聊天和长期记忆照常带上）。`);
    currentConvId = null;
  }
  // GPT 大脑：会话 ID 单独记（运行状态 codex）；忙时的临时消息每次开新会话（最近的聊天照常带上），不和 Antigravity 混用会话。
  // 和 Antigravity 一样：过了凌晨整理记忆的时间、或者会话太大，就开新会话
  let codexState = {};
  if (brain === 'codex') {
    codexState = useMainConversation ? loadRuntimeState('codex') : {};
    currentConvId = useMainConversation ? codexState.conversation_id || null : null;
    const codexTokens = Number(codexState.conversation_tokens) || 0;
    const codexIdle = Date.now() - (Number(codexState.last_used_at) || Number(codexState.conversation_started_at) || Date.now());
    const codexRotate = !currentConvId ? null
      : (Number(codexState.conversation_started_at) || 0) < lastRotationBoundary() ? '已经过了凌晨整理记忆的时间'
        : codexTokens > CODEX_ROTATE_TOKENS ? `GPT 会话已经有 ${(codexTokens / 10000).toFixed(1)} 万 token`
          : codexIdle > CODEX_IDLE_ROTATE_MS ? `GPT 会话已经 ${(codexIdle / 3600_000).toFixed(1)} 小时没用了` : null;
    if (codexRotate) {
      console.log(`[会话轮换] ${codexRotate}，这条消息开新的 GPT 会话（最近的聊天和长期记忆照常带上）。`);
      currentConvId = null;
    }
  }
  const rememberConversation = (res) => {
    if (!useMainConversation) return;
    if (generation !== mainConversationGeneration) {
      if (res.conversationId && res.conversationId !== currentConvId) console.log('[会话已重置] 任务期间用户重置了会话，不再回写这次的会话 ID。');
      return;
    }
    const patch = {};
    // 和这次用的那个会话比（GPT 额度用完、改用默认大脑时是默认大脑的会话）
    const baseConv = res.previousConversationId !== undefined ? res.previousConversationId : currentConvId;
    if (res.conversationId && res.conversationId !== baseConv) Object.assign(patch, { conversation_id: res.conversationId, conversation_started_at: Date.now() });
    // 记下会话现在多大，下一条消息据此决定要不要换新会话
    if (Number.isFinite(res.contextTokens)) patch.conversation_tokens = res.contextTokens;
    // GPT：记下这次会话里已经有的记忆，下一条记忆没变就不重复发；记下最后一次用的时间（隔太久没用就开新会话）
    if (res.brain === 'codex') Object.assign(patch, { memory_hash: memoryHash, last_used_at: Date.now() });
    if (!Object.keys(patch).length) return;
    saveRuntimeState(res.brain === 'codex' ? 'codex' : 'routine', patch);
    if (patch.conversation_id) console.log(`[已持久化${res.brain === 'codex' ? ' GPT' : ''}会话记忆 ID]: ${res.conversationId}`);
  };
  const withConversationNotice = (res, text) => (res.resumeFailed ? `${text}\n\n${CONVERSATION_LOST_NOTICE}` : text);
  const memorySection = loadBotMemory(message_text);
  // 开新会话（或原会话接不上、改开新会话重试）时，最近几条助手回复带全文；接着用原会话时只带前 200 字（会话里本来就有全文）
  const freshRecent = getRecentChatContext(5, { fullReplies: FULL_REPLIES_ON_NEW_SESSION });
  const recentChatSection = currentConvId ? getRecentChatContext(5) : freshRecent;
  const promptHead = `[系统备注：当前微信对话用户为【${userNickname}】，助手身份为${personaDesc}。在所有回复中直接称呼用户为“${userNickname}”。${forbiddenPrompt}严禁修改全局AGENTS.md。若用户要求记住什么，按规则第 8 节记：每次聊天都用得上的写进 MEMORY.md（不超过 ${MEMORY_MAX_CHARS} 字），某个领域的结论写进 data/memory/topics/ 对应专题（每本不超过 ${TOPIC_MAX_CHARS} 字），资料原文放 data/memory/library/；同一件事改原来那一条，不要另加一条。]${memorySection}`;
  const promptTail = `\n[微信用户 ${userNickname}]: ${message_text}`;
  // GPT：开新会话时带技能清单；接着原会话聊时不再重复发整份记忆（会话里已经有了），记忆变了才再带一次；身份提醒和最近的聊天照常带
  const codexSkills = brain === 'codex' ? codexSkillsIndex() : '';
  const memoryHash = crypto.createHash('sha1').update(memorySection).digest('hex').slice(0, 16);
  const codexResume = brain === 'codex' && Boolean(currentConvId);
  const memoryChanged = codexResume && codexState.memory_hash !== memoryHash;
  const codexResumeHead = `[系统备注：接着上面的对话。微信用户仍是【${userNickname}】，你的身份仍是${personaDesc}，直接称呼用户为“${userNickname}”。${forbiddenPrompt}要记东西照规则第 8 节记。]${memoryChanged ? `\n[记忆有更新，以下面这份为准]${memorySection}` : ''}`;
  const fullMessage = codexResume ? `${codexResumeHead}${recentChatSection}${promptTail}` : `${promptHead}${codexSkills}${recentChatSection}${promptTail}`;
  const freshMessage = `${promptHead}${codexSkills}${freshRecent}${promptTail}`;
  if (codexResume) console.log(`[GPT 接着聊] 记忆${memoryChanged ? '有更新，这次带上' : '没变，不重复发'}（这条提示词 ${[...fullMessage].length} 字）`);

  // 标记活跃后台任务
  activeBackgroundTasks.add(taskKey);
  const startedAt = Date.now();

  // 启动智能体执行（最长 AGENT_TIMEOUT_MS，默认 60 分钟）
  const replyTagsFile = newReplyTagsFile();
  // GPT 额度用完（记下的额度显示用满了，或者这次调用被拒）：这条改用默认大脑回答，GPT 模式也切回去，回复末尾告诉主人什么时候恢复
  const codexQuotaFallback = async (win) => {
    const q = loadRuntimeState('codex_quota');
    const w = win || [q.secondary, q.primary].find((x) => x && quotaPct(x) >= 100 && Number(x.resets_at) * 1000 > Date.now()) || null;
    const when = w ? bjWhen(w.resets_at) : '';
    const switched = loadRuntimeState('brain').mode === 'codex';
    if (switched) saveRuntimeState('brain', { mode: 'agy', changed_at: Date.now(), quota_off_at: Date.now() });
    console.log(`[GPT 额度用完] 这条改用 Antigravity${switched ? '，GPT 模式也切回去了' : ''}`);
    const agyState = useMainConversation ? loadRuntimeState('routine') : {};
    let agyConv = useMainConversation ? agyState.conversation_id || null : null;
    if (agyConv && conversationRotationReason(agyState, agyConv)) agyConv = null;
    // 不说明的话，Antigravity 看到「用 GPT …」可能会自己去找别的模型代答，或者把额度的事再说一遍
    const note = '\n[系统备注：主人这条本来要交给 GPT，但 GPT 的额度用完了，这条由你直接回答；不要去找别的模型或 GPT 代答，也不用提额度的事（系统会在回复末尾说明）。]';
    const res = await runAgent(`${promptHead}${agyConv ? getRecentChatContext(5) : freshRecent}${note}${promptTail}`, agyConv, `${promptHead}${freshRecent}${note}${promptTail}`, replyTagsFile);
    return {
      ...res,
      previousConversationId: agyConv,
      notice: `（GPT 额度用完了${when ? `，${when} 恢复` : ''}。这条先用默认大脑回答${switched ? '，也已经切回默认大脑' : ''}；${when ? '恢复以后' : '过一阵'}说「切到 GPT」再用。）`,
    };
  };
  let agentPromise;
  if (brain !== 'codex') {
    agentPromise = runAgent(fullMessage, currentConvId, freshMessage, replyTagsFile);
  } else if (codexQuotaExhausted()) {
    agentPromise = codexQuotaFallback(codexQuotaExhausted());
  } else {
    codexBusy++;
    agentPromise = runCodex(fullMessage, currentConvId, freshMessage, replyTagsFile)
      .catch((err) => (err.agentFailure === 'quota' ? codexQuotaFallback(null) : Promise.reject(err)))
      .finally(() => {
        codexBusy--;
        try { saveRuntimeState('brain', { last_used_at: Date.now() }); } catch {}
      });
  }
  if (useSide) {
    // 临时会话这一条跑完（成没成都算），记下会话 ID 给这段时间后面的消息接着用
    const releaseSide = (res) => {
      if (sideConversation.epoch !== sideEpoch || sideConversation.generation !== generation) return;
      sideConversation.running = false;
      if (res?.conversationId && res.brain !== 'codex') sideConversation.id = res.conversationId;
    };
    agentPromise.then(releaseSide, () => releaseSide(null));
  }

  // 软超时定时器：SOFT_TIMEOUT_MS 内没完成，就切入后台运行并先回一句"转入后台"
  let softTimer = null;
  const softTimeoutPromise = new Promise((resolve) => {
    softTimer = setTimeout(() => {
      resolve({ isSlowTask: true });
    }, SOFT_TIMEOUT_MS);
  });

  // 等结果期间定时重发"正在输入"；结束时等最后一次发完，免得它落在"停止输入"之后又亮起来
  let typingInFlight = Promise.resolve();
  const typingTimer = from_user_id && context_token
    ? setInterval(() => { typingInFlight = sendWechatTyping(from_user_id, context_token, 1, config, { quiet: true }); }, TYPING_REFRESH_MS)
    : null;

  const raceResult = await Promise.race([
    agentPromise.then((res) => ({ isSlowTask: false, res })).catch((err) => ({ isSlowTask: false, err })),
    softTimeoutPromise,
  ]);
  if (typingTimer) clearInterval(typingTimer);
  await typingInFlight;

  let backgroundDone = null;
  if (!raceResult.isSlowTask) {
    // -------------------------------------------------------------
    // 场景 A: 快速任务（SOFT_TIMEOUT_MS 内完成）- 直接回复一条
    // -------------------------------------------------------------
    clearTimeout(softTimer);
    activeBackgroundTasks.delete(taskKey);

    let plainReply = '';
    let rawReply = '';
    if (raceResult.err) {
      console.error('[runAgent 异常]:', raceResult.err.message);
      // 登录失效、到时间上限被停掉时如实说明（监控已经通知主人）；其他错误使用友好转译器脱敏
      plainReply = raceResult.err.agentFailure === 'auth'
        ? agentLoginNotice(botName)
        : raceResult.err.agentFailure === 'timeout'
          ? timeoutNotice(userNickname)
          : formatFriendlyError(raceResult.err, botName, userNickname);
    } else {
      rawReply = raceResult.res.reply;
      plainReply = rawReply;
      rememberConversation(raceResult.res);
    }

    if (!plainReply || !plainReply.trim()) {
      plainReply = '收到你的消息了，正在处理中。';
    }
    if (raceResult.res) {
      plainReply = withConversationNotice(raceResult.res, plainReply);
    }

    plainReply = withReplyTags(raceResult.res?.tags || raceResult.err?.tags, plainReply);
    if (raceResult.res?.notice) plainReply = `${plainReply.trimEnd()}\n\n${raceResult.res.notice}`;
    console.log(`[${brain === 'codex' ? 'GPT' : 'Antigravity'} 回复]: ${describeText(plainReply)}`);

    if (from_user_id && context_token) {
      await deliverResultToWechat(from_user_id, context_token, plainReply, rawReply, false, message_text);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
  } else {
    // -------------------------------------------------------------
    // 场景 B: 重度长任务（超过 SOFT_TIMEOUT_MS）- 两段式转入后台
    // -------------------------------------------------------------
    console.log(`⏳ [任务处理中 (>${SOFT_TIMEOUT_MS / 1000}s)，转入后台异步托管]: ${taskLabel}`);
    if (useMainConversation) {
      mainConversationBusy = true;
      // 新的占用期：这段时间后面的消息共用一个新的临时会话
      mainBusyEpoch++;
      resetSideConversation(mainBusyEpoch);
    }
    backgroundTasks.set(taskKey, startedAt);

    // 【第 1 段消息】：使用当前新鲜有效的 context_token 秒级接单预告
    const handoverNotice = `${userNickname}，这个要多花点时间，${botName}在后台接着弄，好了马上发你～`;
    if (from_user_id && context_token) {
      try {
        await sendWechatReply(from_user_id, context_token, handoverNotice, config);
        await sendWechatTyping(from_user_id, context_token, 2, config);
        appendLog(`[后台接管预告]: ${handoverNotice}`);
        console.log(`✅ [已向微信下发后台接管预告 (第 1 条消息)]`);
      } catch (e) {
        console.warn(`[发送接管预告异常]:`, e.message);
      }
    }

    // 转入后台以后定时报进度：每 PROGRESS_PING_MS 说一次"还在做"，最多 PROGRESS_PING_MAX 次；
    // 这次运行已经用到 GPT 的话带上【GPT】。发不出去（比如微信窗口关了）就不再报
    let pingsSent = 0;
    const pingTimer = PROGRESS_PING_MAX > 0 ? setInterval(async () => {
      if (pingsSent >= PROGRESS_PING_MAX) return clearInterval(pingTimer);
      pingsSent++;
      const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
      const text = withReplyTags(peekReplyTags(replyTagsFile), `${userNickname}，还在做，已经 ${minutes} 分钟了，好了马上发你～`);
      try {
        await pushRateLimiter.acquirePermission();
        const latestConfig = loadConfig();
        await sendWechatReply(latestConfig.authorized_user_id || from_user_id, context_token || loadRuntimeState('forwarder').last_context_token, text, latestConfig);
        appendLog(`[后台进度]: ${text}`);
        console.log(`⏳ [已报进度 ${pingsSent}/${PROGRESS_PING_MAX}]: ${minutes} 分钟`);
      } catch (e) {
        console.warn('[后台进度没发出去，这个任务不再报进度]:', e.message);
        clearInterval(pingTimer);
      }
    }, PROGRESS_PING_MS) : null;
    const stopPings = () => { if (pingTimer) clearInterval(pingTimer); };

    // 后台继续监听执行结果，彻底释放当前消息队列 handleWechatTask，后续进线消息不再被阻塞！
    backgroundDone = agentPromise
      .then(async (agentRes) => {
        stopPings();
        try {
          console.log(`\n🎉 [后台长任务执行成功]: ${taskLabel}`);
          const rawReply = agentRes.reply;
          rememberConversation(agentRes);

          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          // 先用这条消息自己的回复凭证（每个凭证只能用 8~10 次，别都挤在最新那条上）；用满了发送函数会换最近的其他凭证
          const targetToken = context_token || loadRuntimeState('forwarder').last_context_token;

          // 【第 2 段消息】：终结结果推送，单任务一生仅发这最后一条，杜绝任何碎片骚扰
          const headerPrefix = `🔔 【后台任务完成通知】\n${userNickname}，您交办的长任务已全部处理完成：\n\n`;
          let finalReply = withReplyTags(agentRes.tags, headerPrefix + withConversationNotice(agentRes, rawReply));
          if (agentRes.notice) finalReply = `${finalReply.trimEnd()}\n\n${agentRes.notice}`;

          await deliverResultToWechat(toUser, targetToken, finalReply, rawReply, true, message_text);
          console.log(`✅ [后台长任务结果已成功推送至微信 (第 2 条消息)]\n`);
        } catch (postErr) {
          console.error(`[后台任务结果交付异常]:`, postErr.message);
        } finally {
          activeBackgroundTasks.delete(taskKey);
        }
      })
      .catch(async (execErr) => {
        stopPings();
        try {
          console.error(`❌ [后台长任务执行异常]: ${taskLabel}`, execErr.message);
          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          const targetToken = context_token || loadRuntimeState('forwarder').last_context_token;

          const errorNotice = execErr.agentFailure === 'auth'
            ? `🔔 【后台任务执行提醒】\n${userNickname}，${agentLoginNotice(botName)}`
            : execErr.agentFailure === 'timeout'
              ? `🔔 【后台任务执行提醒】\n${timeoutNotice(userNickname)}`
              : `🔔 【后台任务执行提醒】\n${formatFriendlyError(execErr, botName, userNickname)}`;
          await deliverResultToWechat(toUser, targetToken, withReplyTags(execErr.tags, errorNotice), '', true, message_text);
        } catch (postErr) {
          console.error(`[后台异常通知发送失败]:`, postErr.message);
        } finally {
          activeBackgroundTasks.delete(taskKey);
        }
      })
      .finally(() => {
        // 后台任务结束，释放主会话；这段时间的临时会话不再用（聊过的内容在最近聊天里，回到主会话照样接得上）
        backgroundTasks.delete(taskKey);
        if (useMainConversation) {
          mainConversationBusy = false;
          resetSideConversation(-1);
        }
      });
  }

  console.log(`====================================================\n`);
  return backgroundDone ? { background: backgroundDone } : null;
}

// 正在处理（含转入后台）的消息 ID，防止同一条消息被重复拉起
const inFlightMessageIds = new Set();
let pumping = false;

function isHandled(messageId) {
  return (loadRuntimeState('routine').recent_handled_ids || []).includes(messageId);
}

function rememberHandled(messageId) {
  const handled = loadRuntimeState('routine').recent_handled_ids || [];
  if (handled.includes(messageId)) return;
  saveRuntimeState('routine', { recent_handled_ids: [...handled, messageId].slice(-500) });
}

// 智能体都在忙时，"咋样了"这类问进度的消息也先处理：它不调用智能体、马上回进度，不用排在长任务后面
function isQuickStatusMessage(fileName) {
  if (!(backgroundTasks.size > 0 || pushRateLimiter.isCoolingDown() > 0)) return false;
  try {
    const task = JSON.parse(fs.readFileSync(path.join(dataDir, 'inbox', 'pending', fileName), 'utf-8'));
    return STATUS_QUESTION.test(String(task.message_text || '').trim());
  } catch {
    return false;
  }
}

// ---------- 连着发的几条消息合成一条处理 ----------
// 主人常常一口气发好几条（先发图再说要干什么、一句话拆成几条发）。以前一条一条处理：第一条还没看到后面的就回了，后面的又各回一遍。
// 现在收到普通消息先等一小会儿（马上显示"正在输入"）：文字等 2 秒；只有图片或文件、还没说要干什么的，最多等 8 秒看后面有没有话。
// 这期间又来了就从最新那条重新算（最多等 20 秒）；等到了，或者智能体在忙、消息排了队，就把排在最前面、连着的普通消息合成一条交给大脑，只回一次。
// 程序直接处理的指令（切到 GPT、切回来、GPT 额度、重置会话、设置凭证、记忆改动；有任务在后台时问进度）不等、不合并，按顺序单独处理
const MERGE_TEXT_WAIT_MS = Number(process.env.ROUTINE_MERGE_TEXT_WAIT_MS ?? 2000);
const MERGE_MEDIA_WAIT_MS = Number(process.env.ROUTINE_MERGE_MEDIA_WAIT_MS ?? 8000);
const MERGE_MAX_WAIT_MS = 20_000;
const MERGE_MAX_MESSAGES = 10;
const RESET_COMMAND = /^\s*(\/reset|\/clear|\/new|新会话|重置会话|清除记忆)\s*$/i;
const UPGRADE_COMMAND = /^\s*(\/upgrade|\/update|更新系统|系统更新|升级系统|检查更新|更新机器人|升级机器人|机器人更新)\s*$/i;
// forwarder 收到只有图片的消息时写成这样（见 wechat_forwarder.js）
const IMAGE_ONLY_PREFIX = '请查看并详细分析用户在微信发送的这张图片: ';
function isInstantMessage(text) {
  const t = String(text || '').trim();
  if (RESET_COMMAND.test(t) || UPGRADE_COMMAND.test(t)) return true;
  if (STATUS_QUESTION.test(t) && (backgroundTasks.size > 0 || pushRateLimiter.isCoolingDown() > 0)) return true;
  const cmd = parseBrainCommand(t);
  if (cmd && cmd.kind !== 'once') return true;
  try {
    if (parseCredentialCommand(t) || parseMemoryCommand(t)) return true;
  } catch {}
  return false;
}
// 只有图片或文件、没说要干什么
function isMediaOnly(text) {
  const t = String(text || '');
  return t.startsWith(IMAGE_ONLY_PREFIX) || t.replace(/\[已接收用户在微信发送的文件: [^\n]*\]/g, '').trim() === '';
}
function peekPending(fileName) {
  const p = path.join(dataDir, 'inbox', 'pending', fileName);
  try {
    return { fileName, at: fs.statSync(p).mtimeMs, task: JSON.parse(fs.readFileSync(p, 'utf-8')) };
  } catch {
    return null;
  }
}
// 排在最前面的一批：指令单独一条、不等；普通消息连着取（最多 10 条），算出还要等多久
function pickBatch(pending) {
  const first = peekPending(pending[0]);
  if (!first || isInstantMessage(first.task.message_text)) return { files: [pending[0]], waitMs: 0 };
  const group = [first];
  for (const f of pending.slice(1, MERGE_MAX_MESSAGES)) {
    const item = peekPending(f);
    if (!item || item.task.from_user_id !== first.task.from_user_id || isInstantMessage(item.task.message_text)) break;
    group.push(item);
  }
  const newest = group.reduce((a, b) => (b.at >= a.at ? b : a));
  const oldest = Math.min(...group.map((g) => g.at));
  const wait = group.every((g) => isMediaOnly(g.task.message_text)) ? MERGE_MEDIA_WAIT_MS : MERGE_TEXT_WAIT_MS;
  const waitMs = group.length >= MERGE_MAX_MESSAGES ? 0 : Math.max(0, Math.min(newest.at + wait, oldest + MERGE_MAX_WAIT_MS) - Date.now());
  return { files: group.map((g) => g.fileName), waitMs, newest };
}
// 合成一条：按顺序编号，用最新那条的回复凭证；parts 留着原文（「用 GPT …」是哪一条说的都认）
function mergeTasks(tasks, nickname) {
  if (tasks.length === 1) return tasks[0];
  const last = tasks[tasks.length - 1];
  const parts = tasks.map((t) => String(t.message_text || ''));
  const lines = parts.map((p, i) => {
    const t = p.trim();
    return `${i + 1}. ${t.startsWith(IMAGE_ONLY_PREFIX) ? `[已接收用户发送的图片文件: ${t.slice(IMAGE_ONLY_PREFIX.length)}]` : t}`;
  });
  return {
    ...last,
    context_token: [...tasks].reverse().map((t) => t.context_token).find(Boolean) || last.context_token,
    message_text: `[${nickname}连着发了 ${tasks.length} 条消息，按顺序如下。请把它们当成一件事一起看，只回复一次]\n${lines.join('\n')}`,
    parts,
    merged_ids: tasks.map((t) => t.message_id),
  };
}
// 等的时候：先显示"正在输入"（每来一条新消息发一次），到点再处理
const typingShownFor = new Set();
let pumpWakeTimer = null;
function waitForBatch(batch) {
  const { fileName, task } = batch.newest;
  if (!typingShownFor.has(fileName)) {
    typingShownFor.add(fileName);
    if (typingShownFor.size > 100) typingShownFor.delete(typingShownFor.values().next().value);
    console.log(`[合并等待] 收到消息，先显示"正在输入"，${(batch.waitMs / 1000).toFixed(1)} 秒内没有新消息就开始处理`);
    try {
      if (task.from_user_id && task.context_token) sendWechatTyping(task.from_user_id, task.context_token, 1, loadConfig(), { quiet: true }).catch(() => {});
    } catch {}
  }
  if (pumpWakeTimer) clearTimeout(pumpWakeTimer);
  pumpWakeTimer = setTimeout(() => {
    pumpWakeTimer = null;
    pumpInbox().catch((e) => console.error('[收件箱处理异常]:', e));
  }, batch.waitMs + 20);
}

/**
 * 按时间顺序从收件箱取消息处理（连着发的普通消息合成一条，见上）。同时运行的智能体达到上限时先不取（问进度的除外），等有空位再继续。
 * 处理完（含后台任务结束）才记为已处理并删除文件；中途崩溃的消息会在下次启动时重新处理。
 */
async function pumpInbox() {
  if (pumping) return;
  pumping = true;
  const skipped = new Set();
  try {
    for (;;) {
      const pending = listPending().filter((f) => !skipped.has(f) && !inFlightMessageIds.has(messageIdFromFileName(f)));
      if (!pending.length) break;
      let files;
      if (activeAgents < MAX_ACTIVE_AGENTS) {
        const batch = pickBatch(pending);
        if (batch.waitMs > 0) {
          waitForBatch(batch);
          break;
        }
        files = batch.files;
      } else {
        const quick = pending.find(isQuickStatusMessage);
        if (!quick) break;
        files = [quick];
      }

      const claimed = [];
      for (const fileName of files) {
        const messageId = messageIdFromFileName(fileName);
        let claimedPath = null;
        let task;
        try {
          claimedPath = claimInbox(fileName);
          task = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
        } catch (err) {
          console.error(`[收件箱] 无法读取 ${fileName}，移到 failed/:`, err.message);
          skipped.add(fileName);
          try { failInbox(fileName, claimedPath ? 'processing' : 'pending'); } catch {}
          raiseAlert('message_failed', `收件箱里有一条消息文件读不出来（${fileName}），已移到 failed/`);
          continue;
        }
        if (isHandled(messageId)) {
          console.log(`[去重] 消息 ${messageId} 已经处理过，跳过。`);
          finishInbox(claimedPath);
          continue;
        }
        claimed.push({ messageId, claimedPath, task });
      }
      if (!claimed.length) continue;

      for (const c of claimed) inFlightMessageIds.add(c.messageId);
      const complete = () => {
        for (const c of claimed) {
          rememberHandled(c.messageId);
          finishInbox(c.claimedPath);
          inFlightMessageIds.delete(c.messageId);
        }
      };
      let task = claimed[0].task;
      if (claimed.length > 1) {
        let nickname = '主人';
        try { nickname = loadConfig().user_nickname || '主人'; } catch {}
        task = mergeTasks(claimed.map((c) => c.task), nickname);
        console.log(`[合并消息] ${claimed.length} 条连着发的消息合成一条处理`);
      }
      try {
        const result = await handleWechatTask(task);
        if (result && result.background) {
          result.background.finally(() => {
            complete();
            pumpInbox().catch((e) => console.error('[收件箱处理异常]:', e));
          });
        } else {
          complete();
        }
      } catch (err) {
        for (const c of claimed) {
          inFlightMessageIds.delete(c.messageId);
          const outcome = retryOrFailInbox(c.claimedPath, c.task);
          console.error(`[收件箱] 处理消息 ${c.messageId} 出错（${outcome === 'retry' ? '稍后重试' : '已移到 failed/'}）:`, err.message);
          if (outcome === 'failed') {
            raiseAlert('message_failed', `一条消息处理 3 次都失败，已移到 failed/（${c.messageId}）：${err.message}`);
          }
        }
      }
    }
  } finally {
    pumping = false;
  }
}

// ---------- GPT 长时间不用，自动切回默认大脑 ----------
// 切到 GPT 以后超过 codex_idle_minutes 分钟（config.json，默认 30；0 = 不自动切）没再用 GPT，就切回默认大脑并告诉主人，省 GPT 额度。
// 有 GPT 任务在跑、或者还有消息没处理完时不切
async function checkCodexIdle() {
  let config;
  try { config = loadConfig(); } catch { return; }
  if (!config.codex_brain) return;
  const minutes = Number(config.codex_idle_minutes ?? process.env.ROUTINE_CODEX_IDLE_MINUTES ?? 30);
  if (!(minutes > 0)) return;
  const st = loadRuntimeState('brain');
  if (st.mode !== 'codex') return;
  if (codexBusy > 0 || inFlightMessageIds.size > 0 || listPending().length > 0) return;
  const last = Math.max(Number(st.last_used_at) || 0, Number(st.changed_at) || 0);
  if (Date.now() - last < minutes * 60_000) return;
  saveRuntimeState('brain', { mode: 'agy', changed_at: Date.now(), auto_off_at: Date.now() });
  const span = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
  const text = `好一阵（${span}）没用 GPT 了，已经自动切回默认大脑，省点 GPT 额度。要接着用就说「切到 GPT」。`;
  console.log(`[切换大脑] ${span}没用 GPT，自动切回 Antigravity`);
  appendLog(`AI回复(系统): ${text}`);
  const to = config.authorized_user_id;
  const token = loadRuntimeState('forwarder').last_context_token;
  if (!to || !token) return;
  try {
    await pushRateLimiter.acquirePermission();
    await sendWechatReply(to, token, text, config);
  } catch (err) {
    console.warn('[切换大脑] 自动切回的提醒没发出去:', err.message);
  }
}

// ---------- 每天清理一次旧会话（见 session_cleanup.js）----------
// 北京时间 04:40 以后（凌晨 03:30 换完会话、整理完记忆；几个机器人错开最多 10 分钟）。超过 session_cleanup_days 天（config.json，默认 14；
// 0 = 不清会话）没动过的会话、超过 media_cleanup_days 天（默认 30；0 = 不清）的画图删掉；正在用的会话不动
const CLEANUP_AT_MINUTES = 280;
function runSessionCleanup() {
  let config = {};
  try { config = loadConfig(); } catch {}
  const r = cleanupOldSessions({
    botRoot,
    home: process.env.HOME || '',
    // GPT 只清这个机器人自己的登录目录（服务里设了 CLAWBOT_CODEX_HOME 的），不碰别的 Codex
    codexHome: config.codex_brain && process.env.CLAWBOT_CODEX_HOME ? CODEX_HOME_DIR : '',
    keepIds: referencedIds(botRoot, [sideConversation.id]),
    days: Number(config.session_cleanup_days ?? process.env.ROUTINE_SESSION_CLEANUP_DAYS ?? 14),
    mediaDays: Number(config.media_cleanup_days ?? 30),
    dryRun: process.env.ROUTINE_SESSION_CLEANUP_DRY_RUN === '1',
  });
  console.log(`[会话清理] ${describeCleanup(r)}`);
  return r;
}
function scheduleSessionCleanup() {
  const now = Date.now();
  const bj = new Date(now + 8 * 3600_000);
  let at = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600_000 + CLEANUP_AT_MINUTES * 60_000;
  if (at <= now) at += 86400_000;
  const timer = setTimeout(() => {
    try { runSessionCleanup(); } catch (err) { console.warn('[会话清理] 出错:', err.message); }
    scheduleSessionCleanup();
  }, at - now + Math.floor(Math.random() * 10 * 60_000));
  timer.unref?.();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', name: '微信下旨入口', botRoot }));
  }

  // Webhook endpoint
  if (req.method === 'POST' && url.pathname === '/webhook/wechat') {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      console.error('[Webhook 读取配置失败]:', err.message);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'config unavailable' }));
    }
    const expectedKey = config.webhook_key;

    // Verify webhook key
    const authHeader = req.headers['authorization'] || '';
    const keyHeader = req.headers['x-webhook-key'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : keyHeader.trim();

    if (expectedKey && token !== expectedKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized: invalid webhook key' }));
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { from_user_id, message_text, context_token, message_id } = payload;

        if (!message_text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing message_text' }));
        }

        // 先落进收件箱再应答：返回成功就代表这条消息已经安全落盘，不会丢
        enqueueInbox({
          message_id: message_id || `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          create_time_ms: Date.now(),
          from_user_id,
          message_text,
          context_token,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, queued: true }));

        pumpInbox().catch((err) => {
          console.error('[收件箱处理异常]:', err);
        });
      } catch (err) {
        console.error('[Webhook 处理异常]:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[微信下旨入口] 本地 Webhook Routine 正在监听: http://${HOST}:${PORT}/webhook/wechat (工作目录: ${botRoot})`);

  // 上次没处理完的消息放回队列，然后开始按顺序处理收件箱
  const requeued = requeueProcessing();
  if (requeued > 0) {
    console.log(`[收件箱] 上次有 ${requeued} 条消息没处理完，已放回队列重新处理。`);
  }
  const pump = () => pumpInbox().catch((err) => console.error('[收件箱处理异常]:', err));
  pump();
  setInterval(pump, 1000);
  // GPT 长时间不用自动切回；每天清理一次旧会话
  setInterval(() => checkCodexIdle().catch((err) => console.error('[切换大脑] 检查出错:', err.message)), Number(process.env.ROUTINE_CODEX_IDLE_CHECK_MS) || 60_000);
  scheduleSessionCleanup();
  if (process.env.ROUTINE_SESSION_CLEANUP_ON_START === '1') setTimeout(() => { try { runSessionCleanup(); } catch (err) { console.warn('[会话清理] 出错:', err.message); } }, 3000);
});
