import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 配置只认当前实例目录（cwd）下的 config.json，不再回退到 core/ 目录，避免多个实例共用一份凭证
export function getConfigPath(customPath = null) {
  if (customPath) return customPath;
  if (process.env.BOT_CONFIG_PATH) return process.env.BOT_CONFIG_PATH;
  return path.join(process.cwd(), 'config.json');
}

export function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

// 日志默认不记录消息原文、文件名和令牌；排查问题时设环境变量 CLAWBOT_LOG_CONTENT=1 才打印原文
export const LOG_CONTENT = process.env.CLAWBOT_LOG_CONTENT === '1';

export function describeText(text) {
  const s = String(text ?? '');
  return LOG_CONTENT ? JSON.stringify(s) : `${[...s].length} 字`;
}

export function describePath(p) {
  if (LOG_CONTENT) return p;
  return `${path.dirname(p)}/<${path.extname(p) || '无扩展名'}>`;
}

/**
 * 原子写 JSON：先写同目录下的临时文件再 rename，读的一方永远看不到写了一半的内容。
 */
export function writeJsonAtomic(targetPath, data) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, targetPath);
}

/**
 * 读 JSON：文件不存在返回 {}；内容损坏直接抛错，绝不能把 {} 当成真实内容再写回去。
 */
function readJsonStrict(targetPath) {
  let raw;
  try {
    raw = fs.readFileSync(targetPath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${targetPath} 不是合法的 JSON，已拒绝使用（${err.message}）`);
  }
}

// 称呼和人设放在实例目录的 profile.json（机器人自己能改，下一条消息生效）；config.json 只放微信凭证和端口（只由扫码登录写入）。
// 读配置时把 profile.json 里这几项盖到 config.json 上，凭证、端口这些 profile.json 改不了
export const PROFILE_KEYS = ['bot_name', 'user_nickname', 'forbidden_persona', 'persona_description', 'reply_nudge_hours', 'digest_style'];

function readProfile(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(path.dirname(configPath), 'profile.json'), 'utf-8');
  } catch {
    return {};
  }
  try {
    const obj = JSON.parse(raw) || {};
    return Object.fromEntries(PROFILE_KEYS.filter((k) => obj[k] !== undefined && obj[k] !== null).map((k) => [k, obj[k]]));
  } catch (err) {
    console.warn(`[profile.json] 不是合法的 JSON，这次按 config.json 里的称呼和人设：${err.message}`);
    return {};
  }
}

export function loadConfig(customPath = null) {
  const p = getConfigPath(customPath);
  return { ...readJsonStrict(p), ...readProfile(p) };
}

/** 某个实例目录的配置（含 profile.json）；读不到返回 {}。给监控、管理服务这些要看别的实例的地方用 */
export function loadBotSettings(botDir) {
  try {
    return loadConfig(path.join(botDir, 'config.json'));
  } catch {
    return {};
  }
}

// config.json 只放静态配置与凭证，只应由扫码登录（login.js）写入；运行中变化的数据请用 saveRuntimeState
export function saveConfig(updates, customPath = null) {
  const targetPath = getConfigPath(customPath);
  const next = { ...readJsonStrict(targetPath), ...updates };
  writeJsonAtomic(targetPath, next);
  return next;
}

/**
 * 运行时状态放在 <实例目录>/data/state/<name>.json，每个文件只由一个进程写：
 *   forwarder.json  → wechat_forwarder.js（get_updates_buf、last_context_token、last_user_message_at）
 *   routine.json    → routine_server.js（conversation_id）
 *   scheduler.json、reply_window.json → scheduler.js（心跳和任务表；微信窗口关闭 / 已提醒对方回消息）
 */
export function getRuntimeStatePath(name) {
  return path.join(process.cwd(), 'data', 'state', `${name}.json`);
}

export function loadRuntimeState(name) {
  return readJsonStrict(getRuntimeStatePath(name));
}

export function saveRuntimeState(name, updates) {
  const targetPath = getRuntimeStatePath(name);
  const next = { ...readJsonStrict(targetPath), ...updates };
  writeJsonAtomic(targetPath, next);
  return next;
}

/**
 * Remove markdown styling so WeChat displays clean plain text.
 */
export function stripMarkdown(text) {
  if (!text) return '';
  // 代码块和行内代码先原样保护起来，里面的 * _ 等符号一律不动，最后再放回（只去掉反引号）
  const codes = [];
  const keep = (code) => `\u0000${codes.push(code) - 1}\u0000`;
  let str = String(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => keep(code.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_, code) => keep(code));
  // Headings: remove #, ##, etc.
  str = str.replace(/^#{1,6}\s+(.*)$/gm, '$1');
  // 加粗 **text**；斜体 *text* 只认两侧不是英文字母或数字的星号，3*4*5 这类算式保持原样。
  // 下划线不当格式处理：wechat_routine_2、__init__.py 这类名字原样保留
  str = str.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '$1');
  str = str.replace(/(^|[^A-Za-z0-9*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![A-Za-z0-9*])/gm, '$1$2');
  // Blockquotes: remove >
  str = str.replace(/^>\s?(.*)$/gm, '$1');
  // Links: [text](url) -> text (url)
  str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Clean local file:/// URLs to prevent WeChat security filter dropping
  str = str.replace(/\(?file:\/\/\/[^\s\)\"\']+\)?/gi, '');
  // Bullet lists: * or - to standard bullet
  str = str.replace(/^[\*\-]\s+/gm, '• ');
  // 放回代码内容
  str = str.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return str.trim();
}

/**
 * Cache for typing_ticket per user to reduce redundant network calls.
 */
const cachedTypingTickets = {};

/**
 * Retrieve typing ticket from iLink server for given user.
 */
export async function getTypingTicket(userId, contextToken, overrideConfig) {
  if (cachedTypingTickets[userId]) {
    return cachedTypingTickets[userId];
  }
  const config = overrideConfig || loadConfig();
  const baseUrl = (config.base_url || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
  const token = config.bot_token;
  if (!token) return null;

  try {
    const res = await fetch(`${baseUrl}/ilink/bot/getconfig`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token.trim()}`,
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '132106',
      },
      body: JSON.stringify({
        ilink_user_id: userId,
        context_token: contextToken,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.typing_ticket) {
      cachedTypingTickets[userId] = data.typing_ticket;
      return data.typing_ticket;
    }
  } catch (err) {
    // Non-critical
  }
  return null;
}

/**
 * Send typing indicator ("对方正在输入...") to WeChat chat window.
 * status: 1 = start typing, 2 = stop typing；quiet: 定时重发时不写日志
 */
export async function sendWechatTyping(userId, contextToken, status = 1, overrideConfig, { quiet = false } = {}) {
  try {
    const config = overrideConfig || loadConfig();
    const baseUrl = (config.base_url || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
    const token = config.bot_token;
    if (!token || !userId) return;

    const ticket = await getTypingTicket(userId, contextToken, config);
    if (!ticket) return;

    const res = await fetch(`${baseUrl}/ilink/bot/sendtyping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token.trim()}`,
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '132106',
      },
      body: JSON.stringify({
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: status,
      }),
    });
    // status 1 = start typing, 2 = stop typing
    if (status === 1 && !quiet) {
      console.log(`[sendtyping] 已向微信发送“正在输入...”状态 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.warn('[sendtyping 警告]:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 回复凭证（context_token）
// 用户每发一条消息，微信给一个 context_token，机器人发任何消息都要带上一个。实测每个 token 大约 24 小时内有效，
// 而且只能用 8~10 次（文字、图片、文件各算一次）；用满了再用，微信返回 ret=-2 prepare failed。
// forwarder 把最近 24 小时每条消息的 token 记在 data/state/forwarder.json 的 recent_context_tokens 里；
// 发送时先用指定的 token，被拒（prepare failed）就换最近的其他 token 再试（新的在前），全被拒才算失败。
// 被拒过的 token 只存哈希，记在 data/state/used_up_tokens.<进程>.json：每个进程只写自己的文件，读的时候合在一起。
// ---------------------------------------------------------------------------
export const TOKEN_TTL_MS = Number(process.env.CLAWBOT_TOKEN_TTL_MS) || 24 * 3600_000 - 10 * 60_000;
export const RECENT_TOKENS_MAX = 30;
const tokenKey = (t) => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
export const isPrepareFailed = (err) => /prepare failed/i.test(String(err?.message || ''));
// 被拒（prepare failed）以后最多换几个凭证试、每次隔多久：被拒不一定是凭证用满了（文字太长、发得太快也是这个错），
// 再多试也一样被拒，还白白把好凭证记成用满；连着狂发还可能招来微信的发送频率限制
export const TOKEN_MAX_TRIES = Number(process.env.CLAWBOT_TOKEN_MAX_TRIES) || 3;
const TOKEN_RETRY_GAP_MS = Number(process.env.CLAWBOT_TOKEN_RETRY_GAP_MS ?? 1000);
const processRole = () => path.basename(process.argv[1] || 'process', '.js').replace(/[^A-Za-z0-9_-]/g, '_');
const tokenStateDir = (botDir) => path.join(botDir || process.cwd(), 'data', 'state');

// 合并新收到的 token：同一个只留一份，丢掉超过有效期的，最多留最近 30 个（forwarder 用）
export function mergeRecentTokens(list, added, now = Date.now()) {
  const byToken = new Map();
  for (const x of [...(Array.isArray(list) ? list : []), ...added]) {
    if (!x?.token) continue;
    const at = Number(x.at) || now;
    if (now - at >= TOKEN_TTL_MS) continue;
    if (!byToken.has(x.token) || byToken.get(x.token).at < at) byToken.set(x.token, { token: x.token, at });
  }
  return [...byToken.values()].sort((a, b) => a.at - b.at).slice(-RECENT_TOKENS_MAX);
}

// 读实例目录里的 JSON：不跟随软链接（监控、管理服务以 root 替别的机器人发时也会读，不能被链接指到别处）
function readBotJson(p) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return JSON.parse(fs.readFileSync(fd, 'utf-8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 最近 24 小时里还在有效期内的 token，新的在前；没有记录时退回 last_context_token
export function recentContextTokens(botDir = null) {
  const st = readBotJson(path.join(tokenStateDir(botDir), 'forwarder.json')) || {};
  const now = Date.now();
  const out = (Array.isArray(st.recent_context_tokens) ? st.recent_context_tokens : [])
    .filter((x) => x?.token && now - (Number(x.at) || 0) < TOKEN_TTL_MS)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .map((x) => x.token);
  if (st.last_context_token && !out.includes(st.last_context_token)) out.unshift(st.last_context_token);
  return out;
}

const usedUpInMemory = new Map(); // 实例目录 → 这个进程认定用满的 token 哈希
function usedUpKeys(botDir) {
  const dir = tokenStateDir(botDir);
  const keys = new Set(usedUpInMemory.get(dir) || []);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^used_up_tokens\..+\.json$/.test(f));
  } catch {}
  const now = Date.now();
  for (const f of names) {
    for (const [k, at] of Object.entries(readBotJson(path.join(dir, f)) || {})) {
      if (now - Number(at) < TOKEN_TTL_MS + 3600_000) keys.add(k);
    }
  }
  return keys;
}
function markTokenUsedUp(botDir, token) {
  const dir = tokenStateDir(botDir);
  const k = tokenKey(token);
  if (!usedUpInMemory.has(dir)) usedUpInMemory.set(dir, new Set());
  usedUpInMemory.get(dir).add(k);
  // 替别的机器人发（监控、管理服务，以 root 运行）：只记在内存里，不往那个机器人的目录写文件
  if (botDir) return;
  try {
    const file = path.join(dir, `used_up_tokens.${processRole()}.json`);
    let d = {};
    try {
      d = JSON.parse(fs.readFileSync(file, 'utf-8')) || {};
    } catch {}
    const now = Date.now();
    for (const [kk, at] of Object.entries(d)) if (now - Number(at) > TOKEN_TTL_MS + 3600_000) delete d[kk];
    d[k] = now;
    writeJsonAtomic(file, d);
  } catch {
    // 写不了（比如在只读的沙箱里）就只记在这个进程的内存里
  }
}

/**
 * 换着 token 发：先用 preferred，再用最近 24 小时里的其他 token（新的在前），跳过已知用满的。
 * send(token) 成功就返回；只有 prepare failed 才换下一个，其他错误直接抛出。
 * 全被拒时抛出最后那个 prepare failed，并带上 allTokensUsedUp = true、tried = 试了几个。
 */
export async function sendWithTokenFallback(preferred, send, { botDir = null, label = '消息' } = {}) {
  const all = [];
  for (const t of [preferred, ...recentContextTokens(botDir)]) if (t && !all.includes(t)) all.push(t);
  if (!all.length) throw new Error('缺少 context_token，无法回复微信消息！');
  const usedUp = usedUpKeys(botDir);
  const fresh = all.filter((t) => !usedUp.has(tokenKey(t)));
  // 都记成用满了：还是拿最新的试一次（记录可能过时），免得一直卡住；最多试 TOKEN_MAX_TRIES 个，每次隔一会儿
  const order = (fresh.length ? fresh : all.slice(0, 1)).slice(0, TOKEN_MAX_TRIES);
  let lastErr = null;
  let tried = 0;
  for (const t of order) {
    if (tried > 0 && TOKEN_RETRY_GAP_MS > 0) await new Promise((r) => setTimeout(r, TOKEN_RETRY_GAP_MS));
    tried += 1;
    try {
      const res = await send(t);
      if (t !== preferred) console.log(`[回复凭证] ${label}：${preferred ? '原来那个凭证用满了，' : ''}换用最近第 ${all.indexOf(t) + 1} 个凭证发出`);
      return res;
    } catch (err) {
      if (!isPrepareFailed(err)) throw err;
      lastErr = err;
      markTokenUsedUp(botDir, t);
    }
  }
  const err = lastErr || new Error('sendmessage failed: prepare failed');
  err.allTokensUsedUp = true;
  err.tried = tried;
  throw err;
}

function ilinkHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token.trim()}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '132106',
  };
}

// 发 sendmessage：返回不是 ret=0 就抛错（文字、图片、文件、视频共用，prepare failed 才能被发现、换凭证）
async function postSendmessage(config, req, label = 'sendmessage') {
  const baseUrl = (config.base_url || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: ilinkHeaders(config.bot_token),
    body: JSON.stringify(req),
  });
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }
  if (!res.ok || (json.ret !== undefined && json.ret !== 0) || (json.errcode !== undefined && json.errcode !== 0)) {
    console.error(`[${label} failed]`, res.status, raw.slice(0, 300));
    throw new Error(`${label} failed: HTTP ${res.status} ${raw.slice(0, 300)}`);
  }
  return json;
}

// 微信单条文字有大小上限：大约 16KB（UTF-8），超了也返回 prepare failed，和凭证用满分不出来
// （11-16 一条 7236 字、约 17KB 的回复就这样没发出去，还把最近的凭证全记成了用满）。
// 超过 TEXT_MAX_BYTES 的文字按段落（没有段落就按行、按句子，实在没有就硬切）拆成几条发，每条末尾标（1/2）（2/2）
export const TEXT_MAX_BYTES = Number(process.env.CLAWBOT_TEXT_MAX_BYTES) || 12000;
const TEXT_PART_GAP_MS = Number(process.env.CLAWBOT_TEXT_PART_GAP_MS ?? 1500);
// 不超过 maxBytes 字节的最长开头（按字符算，不会把一个字拆开）
function prefixWithinBytes(str, maxBytes) {
  let bytes = 0;
  let idx = 0;
  for (const ch of str) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    bytes += b;
    idx += ch.length;
  }
  return idx;
}
export function splitTextForWechat(text, maxBytes = TEXT_MAX_BYTES) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return [s];
  const budget = maxBytes - 32; // 留给末尾的（1/2）
  const parts = [];
  let rest = s;
  while (Buffer.byteLength(rest, 'utf8') > budget) {
    const limit = prefixWithinBytes(rest, budget);
    const window = rest.slice(0, limit);
    const floor = Math.floor(limit / 2); // 断点至少在后一半，免得拆出很短的一条
    let at = -1;
    for (const re of [/\n[ \t]*\n/g, /\n/g, /[。！？!?；;]/g, /[，,、 ]/g]) {
      for (const m of window.matchAll(re)) if (m.index + m[0].length >= floor) at = m.index + m[0].length;
      if (at > 0) break;
    }
    if (at <= 0) at = limit;
    const chunk = rest.slice(0, at).trimEnd();
    if (chunk) parts.push(chunk);
    rest = rest.slice(at).replace(/^\s*\n/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts.length > 1 ? parts.map((p, i) => `${p}\n（${i + 1}/${parts.length}）`) : parts;
}

/**
 * Send reply text message back to WeChat via iLink sendmessage API.
 * opts.botDir：用哪个实例目录里的回复凭证（默认当前目录；监控替别的机器人发时传它的目录）
 */
export async function sendWechatReply(toUserId, contextToken, replyText, overrideConfig, opts = {}) {
  const config = overrideConfig || loadConfig();
  if (!config.bot_token) {
    throw new Error('未配置 bot_token，请先完成扫码登录！');
  }

  const plainText = stripMarkdown(replyText);
  // 太长的拆成几条发（见 splitTextForWechat）
  const parts = splitTextForWechat(plainText);
  // 每次尝试都用新的 client_id：换了凭证的重发不能被当成同一条
  const payload = (ctx, text) => ({
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      message_type: 2,
      message_state: 2,
      context_token: ctx,
      item_list: [
        {
          type: 1,
          text_item: {
            text,
          },
        },
      ],
    },
    base_info: {
      channel_version: '2.4.10',
      bot_agent: 'OpenClaw',
    },
  });

  if (parts.length > 1) console.log(`[sendmessage] 这条文字 ${Buffer.byteLength(plainText, 'utf8')} 字节，超过单条上限，分成 ${parts.length} 条发`);
  let json = null;
  for (const [i, text] of parts.entries()) {
    if (i > 0 && TEXT_PART_GAP_MS > 0) await new Promise((r) => setTimeout(r, TEXT_PART_GAP_MS));
    console.log(`[sendmessage 发送给微信]: to=${toUserId} 文本 ${describeText(text)}${parts.length > 1 ? `（第 ${i + 1}/${parts.length} 条）` : ''}`);
    json = await sendWithTokenFallback(contextToken, (ctx) => postSendmessage(config, payload(ctx, text)), { botDir: opts.botDir, label: '文字' });
    console.log(`[sendmessage success] to=${toUserId} msg_id=${json.message_id || 'ok'}`);
  }
  return json;
}

/**
 * Upload a local image to Tencent Weixin C2C CDN and send as an image message.
 */
export async function uploadAndSendWechatImage(toUserId, contextToken, imagePath, overrideConfig, opts = {}) {
  const config = overrideConfig || loadConfig();

  if (!fs.existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  const buf = fs.readFileSync(imagePath);
  // 上传（没传上会重试）；aes_key 是 32 位 Hex 字符的 Base64 编码（微信客户端要求）
  const { downloadParam, aeskeyHex, aesKeyBase64OfHex, ciphertextLength } = await uploadBufferToCdn(buf, 1, toUserId, config);
  const clientId = `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const sendReq = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [
        {
          type: 2, // MessageItemType.IMAGE
          image_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: aesKeyBase64OfHex,
              encrypt_type: 1,
            },
            aeskey: aeskeyHex,
            mid_size: ciphertextLength,
            hd_size: ciphertextLength,
          },
        },
      ],
    },
    base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
  };

  // 只有最后这一步用到回复凭证：被拒就换凭证重发，不用重新上传
  const sendData = await sendWithTokenFallback(contextToken, (ctx) => {
    sendReq.msg.context_token = ctx;
    sendReq.msg.client_id = `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return postSendmessage(config, sendReq, 'sendImage');
  }, { botDir: opts.botDir, label: '图片' });
  console.log(`[sendImage success] to=${toUserId} msg_id=${sendData.message_id || 'ok'}`);
  return sendData;
}

/**
 * Upload a local document/file to Tencent Weixin C2C CDN and send as a file message.
 */
export async function uploadAndSendWechatFile(toUserId, contextToken, filePath, overrideConfig, opts = {}) {
  const config = overrideConfig || loadConfig();

  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const { downloadParam, aesKeyBase64OfHex, rawsize } = await uploadBufferToCdn(buf, 3, toUserId, config, { noNeedThumb: false });
  const clientId = `openclaw-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const fileName = path.basename(filePath);

  const sendReq = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [
        {
          type: 4, // ITEM_FILE
          file_item: {
            media: {
              encrypt_query_param: downloadParam,
              aes_key: aesKeyBase64OfHex,
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(rawsize),
          },
        },
      ],
    },
    base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
  };

  // 只有最后这一步用到回复凭证：被拒就换凭证重发，不用重新上传
  const sendData = await sendWithTokenFallback(contextToken, (ctx) => {
    sendReq.msg.context_token = ctx;
    sendReq.msg.client_id = `openclaw-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return postSendmessage(config, sendReq, 'sendFile');
  }, { botDir: opts.botDir, label: '文件' });
  console.log(`[sendFile success] to=${toUserId} file=${describePath(filePath)} msg_id=${sendData.message_id || 'ok'}`);
  return sendData;
}

// 微信 CDN 偶尔不回下载凭证：11-18 一个机器人发 4.7 MB 的抖音视频，第一次没回，直接降级成了 mp4 文件，
// 14 分钟后同一个文件一次就传上了。所以没传上就换一个上传链接重传，一共最多 3 次，中间等 2 秒、5 秒（环境变量仅供测试）
const CDN_RETRY_WAIT_MS = String(process.env.CLAWBOT_CDN_RETRY_WAIT_MS || '2000,5000').split(',').map(Number).filter((n) => n >= 0);

async function uploadBufferToCdnOnce(buf, media_type, toUserId, config, noNeedThumb) {
  const baseUrl = config.base_url || 'https://ilinkai.weixin.qq.com';
  const token = config.bot_token;

  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
  const filesize = Math.ceil((rawsize + 1) / 16) * 16;
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskeyBuffer = crypto.randomBytes(16);
  const aeskeyHex = aeskeyBuffer.toString('hex');

  const uploadUrlReq = {
    filekey,
    media_type,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    ...(noNeedThumb ? { no_need_thumb: true } : {}),
    aeskey: aeskeyHex,
    base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
  };

  const urlRes = await fetch(`${baseUrl}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token.trim()}`,
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132106',
    },
    body: JSON.stringify(uploadUrlReq),
  });

  const urlData = await urlRes.json();
  const targetUrl =
    urlData.upload_full_url?.trim() ||
    (urlData.upload_param
      ? `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(urlData.upload_param)}&filekey=${encodeURIComponent(filekey)}`
      : null);

  if (!targetUrl) {
    throw new Error(`无法获取 CDN 上传链接: ${JSON.stringify(urlData)}`);
  }

  // Encrypt with AES-128-ECB
  const cipher = crypto.createCipheriv('aes-128-ecb', aeskeyBuffer, null);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);

  const cdnRes = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  });

  const downloadParam = cdnRes.headers.get('x-encrypted-param');
  if (!downloadParam) {
    // 带上 HTTP 状态和 CDN 给的原因，下次再出现好查
    const why = String(cdnRes.headers.get('x-error-message') || '').slice(0, 100);
    throw new Error(`CDN 上传未返回 x-encrypted-param 下载凭证（HTTP ${cdnRes.status}${why ? `，${why}` : ''}）`);
  }

  const aesKeyBase64OfHex = Buffer.from(aeskeyHex).toString('base64');
  return {
    downloadParam,
    aesKeyBase64OfHex,
    aeskeyHex,
    rawsize,
    ciphertextLength: ciphertext.length,
  };
}

/**
 * Upload a buffer to Tencent Weixin C2C CDN; a failed upload is retried with a fresh upload link.
 * media_type: 1 = Image, 2 = Video, 3 = File。图片、文件、视频和封面都走这里
 */
export async function uploadBufferToCdn(buf, media_type, toUserId, overrideConfig, { noNeedThumb = true } = {}) {
  const config = overrideConfig || loadConfig();
  let lastErr = null;
  for (let attempt = 0; attempt <= CDN_RETRY_WAIT_MS.length; attempt++) {
    if (attempt > 0) {
      console.warn(`[CDN 上传没成功，${CDN_RETRY_WAIT_MS[attempt - 1] / 1000} 秒后换个上传链接再传（第 ${attempt + 1} 次）]: ${lastErr.message}`);
      await new Promise((r) => setTimeout(r, CDN_RETRY_WAIT_MS[attempt - 1]));
    }
    try {
      return await uploadBufferToCdnOnce(buf, media_type, toUserId, config, noNeedThumb);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Upload an MP4 video with an extracted thumbnail and send as a Native Video Card (type: 5, video_item).
 * Displays thumbnail + play button in WeChat chat window; tap to play directly in full screen.
 * Automatically falls back to file card (type: 4) if native video payload fails.
 */
export async function uploadAndSendWechatVideo(toUserId, contextToken, videoPath, overrideConfig, opts = {}) {
  const config = overrideConfig || loadConfig();
  const baseUrl = config.base_url || 'https://ilinkai.weixin.qq.com';
  const token = config.bot_token;

  if (!fs.existsSync(videoPath)) {
    throw new Error(`视频文件不存在: ${videoPath}`);
  }

  const tempThumb = path.join('/tmp', `thumb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  let duration = 10;
  let thumbBuf = null;

  try {
    const durStr = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (durStr && !isNaN(parseFloat(durStr))) {
      duration = Math.max(1, Math.round(parseFloat(durStr)));
    }
  } catch (e) {
    console.warn('[ffprobe 读取视频时长失败，使用默认值]:', e.message);
  }

  // 封面：截第 1 秒那一帧；截不到（视频不到 1 秒之类，11-09 有一次因为这个降级成了文件）就截第一帧
  for (const at of ['00:00:01', '00:00:00']) {
    try {
      execFileSync('ffmpeg', [
        '-y',
        '-ss', at,
        '-i', videoPath,
        '-vframes', '1',
        tempThumb,
      ], { stdio: 'ignore', timeout: 10000 });
      if (fs.existsSync(tempThumb) && fs.statSync(tempThumb).size > 0) thumbBuf = fs.readFileSync(tempThumb);
    } catch (e) {
      console.warn(`[ffmpeg 截取封面失败（${at}）]:`, e.message);
    } finally {
      if (fs.existsSync(tempThumb)) {
        try { fs.unlinkSync(tempThumb); } catch {}
      }
    }
    if (thumbBuf) break;
  }

  // 降级成文件发的，返回值带上 fallback（原因），消息服务据此如实说一声
  if (!thumbBuf) {
    console.log('[未生成封面图，降级走普通文件卡片通道发送]');
    const sent = await uploadAndSendWechatFile(toUserId, contextToken, videoPath, config, opts);
    return { ...sent, fallback: '截不到封面图' };
  }

  try {
    const videoBuf = fs.readFileSync(videoPath);
    console.log(`[正在上传原生视频本体至微信 CDN]: ${describePath(videoPath)} (${videoBuf.length} 字节)...`);
    const videoUp = await uploadBufferToCdn(videoBuf, 2, toUserId, config); // 2 = MEDIA_VIDEO（没传上会重试）

    console.log(`[正在上传原生视频封面图至微信 CDN]: (${thumbBuf.length} 字节)...`);
    const thumbUp = await uploadBufferToCdn(thumbBuf, 1, toUserId, config); // 1 = IMAGE

    const clientId = `openclaw-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const sendReq = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [
          {
            type: 5, // MessageItemType.VIDEO (原生直接点开播放)
            video_item: {
              media: {
                encrypt_query_param: videoUp.downloadParam,
                aes_key: videoUp.aesKeyBase64OfHex,
                encrypt_type: 1,
              },
              thumb_media: {
                encrypt_query_param: thumbUp.downloadParam,
                aes_key: thumbUp.aesKeyBase64OfHex,
                encrypt_type: 1,
              },
              video_length: duration,
              play_length: duration,
              video_size: videoUp.ciphertextLength,
            },
          },
        ],
      },
      base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
    };

    // 只有最后这一步用到回复凭证：被拒就换凭证重发，不用重新上传
    const sendData = await sendWithTokenFallback(contextToken, (ctx) => {
      sendReq.msg.context_token = ctx;
      sendReq.msg.client_id = `openclaw-weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      return postSendmessage(config, sendReq, 'sendVideo');
    }, { botDir: opts.botDir, label: '视频' });

    console.log(`[sendVideo success] 原生小视频发送成功！to=${toUserId} msg_id=${sendData.message_id || 'ok'}`);
    return sendData;
  } catch (err) {
    // 回复凭证全用满了：换成文件发也一样会被拒，直接报出去
    if (isPrepareFailed(err)) throw err;
    console.warn(`[原生视频消息发送异常，安全降级为文件卡片发送]:`, err.message);
    const sent = await uploadAndSendWechatFile(toUserId, contextToken, videoPath, config, opts);
    return { ...sent, fallback: err.message };
  }
}
