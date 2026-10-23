process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

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
import { RESET_MARKER, loadTopicsConfig, capForLoading, MEMORY_MAX_CHARS, TOPIC_MAX_CHARS, TOPIC_ALWAYS_BUDGET } from './memory_config.js';
import { memoryMode, useStandaloneHistory, parseMemoryCommand, findBotByName, showChanges, undoItems } from './memory_history.js';
import { raiseAlert } from './alert.js';
import { AGY_STREAM_ARGS, agyInputLine, agyOutcome, recordAgentResult } from './agent_health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = process.cwd();
// 自己管记忆历史的实例（默认每个实例自己管；统一管理时只有主人的机器人）才处理「记忆改动」「撤销记忆 N」，
// 被代管的实例照常交给智能体
const MEMORY_MODE = memoryMode(botRoot);
if (MEMORY_MODE === 'standalone') useStandaloneHistory(botRoot);
const MEMORY_REVIEW = MEMORY_MODE === 'owner' || MEMORY_MODE === 'standalone';

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
const LOG_FILE = fs.existsSync(dataDir)
  ? path.join(dataDir, 'chat_history.log')
  : path.join(botRoot, 'chat_history.log');

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
const ALLOWED_DELIVERY_DOCS = /\.(md|html|htm|pdf|docx|xlsx|csv|zip|tar\.gz)$/i;
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
  if (!text) return { images: [], files: [], videos: [] };
  const images = new Set();
  const files = new Set();
  const videos = new Set();

  const fileUrlRegex = /file:\/\/(\/[^\s\)\"\'\<\>]+)/gi;
  for (const m of text.matchAll(fileUrlRegex)) {
    const p = m[1];
    if (!isPathAllowedForThisBot(p)) continue;
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

  const absPathRegex = /(\/(?:srv|root|tmp)[^\s\)\"\'\<\>]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|xlsx|zip|tar\.gz|md|html|htm|mp4|mov|m4v))/gi;
  for (const m of text.matchAll(absPathRegex)) {
    const p = m[1];
    if (!isPathAllowedForThisBot(p)) continue;
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
  const quotedPathRegex = /[`"'](\/(?:srv|root|tmp)[^`"'\r\n]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|xlsx|zip|tar\.gz|md|html|htm|mp4|mov|m4v))[`"']/gi;
  for (const m of text.matchAll(quotedPathRegex)) {
    const p = m[1].trim();
    if (!isPathAllowedForThisBot(p)) continue;
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
  if (videos.size === 0) {
    const downloadDirs = [
      path.join(botRoot, 'data', 'downloads'),
      path.join(botRoot, 'downloads'),
    ];
    for (const baseD of downloadDirs) {
      if (fs.existsSync(baseD)) {
        try {
          const subdirs = ['', 'douyin', 'bilibili', 'xiaohongshu', 'wechat'];
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

function runAgent(promptText, conversationId = null) {
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
        timeout: 600000,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        activeAgents--;
        // 退出码为 0 但输出里 status 是 ERROR 的也算失败（比如登录失效）；没有 result 事件也算失败
        const outcome = agyOutcome(error, stdout, stderr);
        if (!outcome.ok) {
          // 会话本身接不上才值得换新会话重试；登录失效、超时，重试也一样失败，只会让用户多等
          if (conversationId && outcome.kind === 'error') {
            console.warn(`[agy] 会话 ${conversationId} 恢复失败，自动创建全新会话重试...`);
            // 标记 resumeFailed，回复里会告诉用户"原来的会话没接上"
            return runAgent(promptText, null)
              .then((res) => resolve({ ...res, resumeFailed: true }))
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
          return reject(err);
        }

        recordAgentResult('routine', outcome);
        if (outcome.warning) console.warn(`[agy 提示] 有回复，但带着提示（照常使用回复）：${outcome.warning}`);
        const usage = outcome.json.usage;
        if (usage) console.log(`[agy 用量]: 输入 ${usage.input_tokens ?? '?'} tokens，输出 ${usage.output_tokens ?? '?'} tokens`);
        resolve({ reply: outcome.json.response || '', conversationId: outcome.json.conversation_id || conversationId });
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

// 同时最多运行的智能体数量（含转入后台的任务），超出的消息留在收件箱里排队
const MAX_ACTIVE_AGENTS = 2;
// 超过这个时间还没出结果，先回一句"转入后台"，任务继续在后台跑（环境变量仅供测试缩短）。
// 原来是 35 秒：实测一条消息中位数就要 48 秒，七成消息都会先收到这句；改成 90 秒后大约一成多
const SOFT_TIMEOUT_MS = Number(process.env.ROUTINE_SOFT_TIMEOUT_MS) || 90000;
// 等结果期间每隔多久重发一次"正在输入"，免得对方以为没反应（环境变量仅供测试）
const TYPING_REFRESH_MS = Number(process.env.ROUTINE_TYPING_REFRESH_MS) || 20000;
// 主会话每天换一次：北京时间 03:30（凌晨整理完记忆）以后的第一条消息开新会话；会话库太大时也提前换。
// 不写重置标记：最近几轮聊天和长期记忆照常带上，只是 agy 不再背着越来越长的历史（环境变量仅供测试）
const ROTATE_AT_MINUTES = Number(process.env.ROUTINE_ROTATE_AT_MINUTES || 210);
const ROTATE_MAX_BYTES = Number(process.env.ROUTINE_ROTATE_MAX_BYTES) || 20 * 1024 * 1024;

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
  if (!startedAt) {
    // 以前存下的会话没有开始时间：从现在算起，过了下一个 03:30 再换
    saveRuntimeState('routine', { conversation_started_at: Date.now() });
    return null;
  }
  if (startedAt < lastRotationBoundary()) return '已经过了凌晨整理记忆的时间';
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

const CONVERSATION_LOST_NOTICE = '（提示：原来的会话没能接上，已经开了一个新会话，之前聊过的细节可能记不全了。）';
// 智能体登录失效时回给用户的话（监控会同时通知主人去重新登录）
const agentLoginNotice = (botName) => `${botName}这会儿连不上智能体（登录失效了），已经通知去处理了，稍后再试哦～`;

/**
 * 聚合交付下发引擎：将文本回复与附带媒体（图片/原生视频卡片/文件）安全推送到微信
 */
async function deliverResultToWechat(toUserId, contextToken, textReply, rawAgentReply, isAsyncCallback = false) {
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

  // 2. 检查是否有新鲜生成的媒体 (图片 / 视频 / 文件)
  const media = extractMediaPaths(rawAgentReply || textReply);

  // 2.1 图片 (仅推 1 张最新图片)
  if (media.images && media.images.length > 0) {
    const latestImg = media.images[media.images.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送图片至微信]: ${describePath(latestImg)}`);
      await uploadAndSendWechatImage(toUserId, contextToken, latestImg, config);
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
      await uploadAndSendWechatVideo(toUserId, contextToken, latestVideo, config);
      console.log(`[已成功将原生视频卡片发送至微信]: ${describePath(latestVideo)}`);
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

      if (block.includes(RESET_MARKER)) {
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
          parsedTurns.unshift({ role: '助手', text: condensed + (text.length > 200 ? '...' : '') });
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
 * 提取最近几轮真实对话上下文 (跨天无缝缝合滑窗防失忆护栏)；遇到"会话已重置"标记就不再往前读
 */
function getRecentChatContext(maxRounds = 5) {
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
    const formatted = turns.map(t => `- ${t.role}: ${t.text}`).join('\n');
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

/**
 * 加载当前 Bot 的专题分卷：小专题每条消息都带（从小到大放，合计不超过 TOPIC_ALWAYS_BUDGET 字）；
 * 放不下的大专题，这条消息或之前两条用户消息里提到关键词才带，聊着聊着不会突然丢掉。
 * 专题和关键词写在各实例自己的 topics.json 里，核心代码不写死任何个人信息。
 */
function loadTopicMemory(messageText) {
  const topicsDir = path.join(botRoot, 'data', 'memory', 'topics');
  const topics = [];
  for (const topic of loadTopicsConfig(botRoot)) {
    try {
      const content = fs.readFileSync(path.join(topicsDir, topic.file), 'utf-8').trim();
      if (content) topics.push({ ...topic, content, size: [...content].length });
    } catch {}
  }
  if (!topics.length) return '';

  const always = new Set();
  let used = 0;
  for (const t of [...topics].sort((a, b) => a.size - b.size)) {
    if (used + t.size > TOPIC_ALWAYS_BUDGET) break;
    always.add(t.file);
    used += t.size;
  }
  const text = [messageText || '', ...recentUserTexts(2, messageText)].join('\n').toLowerCase();
  const sections = topics
    .filter((t) => always.has(t.file) || t.keywords.some((k) => matchesKeyword(text, k)))
    .map((t) => {
      const { text: content, truncated } = capForLoading(t.content, TOPIC_MAX_CHARS);
      if (truncated) console.warn(`[专题分卷] ${t.file} 超过上限太多，这次只带了前 ${TOPIC_MAX_CHARS * 2} 字`);
      return `【${t.name} (${t.file})】：\n${content}`;
    });
  return sections.length ? `\n\n${sections.join('\n\n')}\n` : '';
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

  // 2. 专题分卷：小的常驻，大的按关键词（这条消息和之前两条）
  const topicContent = loadTopicMemory(messageText);
  if (topicContent) {
    result += topicContent;
  }

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
  appendLog(`微信接收 (${from_user_id}): ${message_text}`);

  // 快捷重置会话指令判断
  const isResetCommand = /^\s*(\/reset|\/clear|\/new|新会话|重置会话|清除记忆)\s*$/i.test(message_text);
  if (isResetCommand) {
    mainConversationGeneration++;
    saveRuntimeState('routine', { conversation_id: null });
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
  const isUpgradeCommand = /^\s*(\/upgrade|\/update|更新系统|系统更新|升级系统|检查更新|更新机器人|升级机器人|机器人更新)\s*$/i.test(message_text);
  if (isUpgradeCommand) {
    const upgradeNotice = '⚙️ 微信里的一键升级已经关闭。需要更新时，请在服务器上更新代码后重启服务。';
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, upgradeNotice, config);
    }
    console.log(`[升级指令] 微信一键升级已关闭，已提示用户。`);
    console.log(`====================================================\n`);
    return null;
  }

  // 主人的记忆命令：程序直接处理，不经过智能体；回复里有记忆内容，不写进聊天日志（免得被整理进机器人自己的记忆）。
  // 「记忆改动」看自己的；统一管理时主人还能用「X记忆改动」看实例 X 的——名字对不上任何机器人，就当普通消息交给智能体
  const botsDir = path.dirname(botRoot);
  let memoryCommand = MEMORY_REVIEW ? parseMemoryCommand(message_text) : null;
  let showBot = null;
  if (memoryCommand?.type === 'show') {
    showBot = memoryCommand.name ? findBotByName(memoryCommand.name, { botsDir }) : path.basename(botRoot);
    if (!showBot) memoryCommand = null;
  }
  if (memoryCommand) {
    let reply;
    try {
      reply = memoryCommand.type === 'show'
        ? showChanges({ botsDir, bot: showBot })
        : undoItems(memoryCommand.items, { botsDir });
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
  if (from_user_id && context_token) {
    await sendWechatTyping(from_user_id, context_token, 1, config);
  }

  // 2. 调用 Antigravity 生成回复（带多轮会话记忆、长期记忆库与最近对话滑窗护栏）
  console.log(`[Antigravity 思考中...]`);
  // 会话占用锁：主会话空闲就用主会话；正被转入后台的任务占着时，改用临时会话，结果也不回写主会话 ID
  const useMainConversation = !mainConversationBusy;
  const generation = mainConversationGeneration;
  const routineState = useMainConversation ? loadRuntimeState('routine') : {};
  let currentConvId = useMainConversation ? routineState.conversation_id || null : null;
  if (!useMainConversation) {
    console.log('[会话占用] 主会话正被后台任务使用，本条消息改用临时会话处理。');
  }
  const rotateReason = conversationRotationReason(routineState, currentConvId);
  if (rotateReason) {
    console.log(`[会话轮换] ${rotateReason}，这条消息开新会话（最近的聊天和长期记忆照常带上）。`);
    currentConvId = null;
  }
  const rememberConversation = (res) => {
    if (!useMainConversation || !res.conversationId || res.conversationId === currentConvId) return;
    if (generation !== mainConversationGeneration) {
      console.log('[会话已重置] 任务期间用户重置了会话，不再回写这次的会话 ID。');
      return;
    }
    saveRuntimeState('routine', { conversation_id: res.conversationId, conversation_started_at: Date.now() });
    console.log(`[已持久化会话记忆 ID]: ${res.conversationId}`);
  };
  const withConversationNotice = (res, text) => (res.resumeFailed ? `${text}\n\n${CONVERSATION_LOST_NOTICE}` : text);
  const memorySection = loadBotMemory(message_text);
  const recentChatSection = getRecentChatContext(5);
  const fullMessage = `[系统备注：当前微信对话用户为【${userNickname}】，助手身份为${personaDesc}。在所有回复中直接称呼用户为“${userNickname}”。${forbiddenPrompt}严禁修改全局AGENTS.md。若用户要求记住长期偏好、习惯或专业知识，请主动更新沉淀到当前目录的 MEMORY.md 或 data/memory/topics/ 对应专题分卷中（MEMORY.md 不超过 ${MEMORY_MAX_CHARS} 字，每个专题分卷不超过 ${TOPIC_MAX_CHARS} 字，写之前先看有没有重复的条目）。]${memorySection}${recentChatSection}\n[微信用户 ${userNickname}]: ${message_text}`;

  // 标记活跃后台任务
  activeBackgroundTasks.add(taskKey);

  // 启动智能体执行 (10分钟超时保护)
  const agentPromise = runAgent(fullMessage, currentConvId);

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
      // 登录失效时如实说明（监控已经通知主人），不再说成"网络波动"
      plainReply = raceResult.err.agentFailure === 'auth'
        ? agentLoginNotice(botName)
        : '小助理刚才正在处理上一条重度任务或网络发生波动，未能及时响应，请稍候重试一下～';
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

    console.log(`[Antigravity 回复]: ${describeText(plainReply)}`);

    if (from_user_id && context_token) {
      await deliverResultToWechat(from_user_id, context_token, plainReply, rawReply, false);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
  } else {
    // -------------------------------------------------------------
    // 场景 B: 重度长任务（超过 SOFT_TIMEOUT_MS）- 两段式转入后台
    // -------------------------------------------------------------
    console.log(`⏳ [任务处理中 (>${SOFT_TIMEOUT_MS / 1000}s)，转入后台异步托管]: ${taskLabel}`);
    if (useMainConversation) {
      mainConversationBusy = true;
    }

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

    // 后台继续监听执行结果，彻底释放当前消息队列 handleWechatTask，后续进线消息不再被阻塞！
    backgroundDone = agentPromise
      .then(async (agentRes) => {
        try {
          console.log(`\n🎉 [后台长任务执行成功]: ${taskLabel}`);
          const rawReply = agentRes.reply;
          rememberConversation(agentRes);

          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          const targetToken = loadRuntimeState('forwarder').last_context_token || context_token;

          // 【第 2 段消息】：终结结果推送，单任务一生仅发这最后一条，杜绝任何碎片骚扰
          const headerPrefix = `🔔 【后台任务完成通知】\n${userNickname}，您交办的长任务已全部处理完成：\n\n`;
          const finalReply = headerPrefix + withConversationNotice(agentRes, rawReply);

          await deliverResultToWechat(toUser, targetToken, finalReply, rawReply, true);
          console.log(`✅ [后台长任务结果已成功推送至微信 (第 2 条消息)]\n`);
        } catch (postErr) {
          console.error(`[后台任务结果交付异常]:`, postErr.message);
        } finally {
          activeBackgroundTasks.delete(taskKey);
        }
      })
      .catch(async (execErr) => {
        try {
          console.error(`❌ [后台长任务执行异常]: ${taskLabel}`, execErr.message);
          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          const targetToken = loadRuntimeState('forwarder').last_context_token || context_token;

          let friendlyReason = execErr.message || '未知异常';
          if (friendlyReason.includes('timeout') || friendlyReason.includes('SIGTERM')) {
            friendlyReason = '执行耗时超过系统最大保护上限 (10分钟)';
          }

          const errorNotice = execErr.agentFailure === 'auth'
            ? `🔔 【后台任务执行提醒】\n${userNickname}，${agentLoginNotice(botName)}`
            : `🔔 【后台任务执行提醒】\n${userNickname}，刚才在后台处理的任务遇到异常中断：${friendlyReason}。稍候可精简任务内容后重试～`;
          await deliverResultToWechat(toUser, targetToken, errorNotice, '', true);
        } catch (postErr) {
          console.error(`[后台异常通知发送失败]:`, postErr.message);
        } finally {
          activeBackgroundTasks.delete(taskKey);
        }
      })
      .finally(() => {
        // 后台任务结束，释放主会话
        if (useMainConversation) {
          mainConversationBusy = false;
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

/**
 * 按时间顺序从收件箱取消息处理。同时运行的智能体达到上限时先不取，等有空位再继续。
 * 处理完（含后台任务结束）才记为已处理并删除文件；中途崩溃的消息会在下次启动时重新处理。
 */
async function pumpInbox() {
  if (pumping) return;
  pumping = true;
  const skipped = new Set();
  try {
    while (activeAgents < MAX_ACTIVE_AGENTS) {
      const fileName = listPending().find((f) => !skipped.has(f) && !inFlightMessageIds.has(messageIdFromFileName(f)));
      if (!fileName) break;
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

      inFlightMessageIds.add(messageId);
      const complete = () => {
        rememberHandled(messageId);
        finishInbox(claimedPath);
        inFlightMessageIds.delete(messageId);
      };
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
        inFlightMessageIds.delete(messageId);
        const outcome = retryOrFailInbox(claimedPath, task);
        console.error(`[收件箱] 处理消息 ${messageId} 出错（${outcome === 'retry' ? '稍后重试' : '已移到 failed/'}）:`, err.message);
        if (outcome === 'failed') {
          raiseAlert('message_failed', `一条消息处理 3 次都失败，已移到 failed/（${messageId}）：${err.message}`);
        }
      }
    }
  } finally {
    pumping = false;
  }
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
});
