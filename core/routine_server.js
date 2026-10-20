process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

import http from 'node:http';
import { execFile, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
import {
  sendWechatReply,
  sendWechatTyping,
  uploadAndSendWechatImage,
  uploadAndSendWechatFile,
  uploadAndSendWechatVideo,
  loadConfig,
  saveConfig,
  stripMarkdown,
} from './wechat_reply.js';
import { loadTopicsConfig } from './memory_config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = process.cwd();

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

// 检查文件是否安全属于当前 Bot 作用域（只允许本实例目录或 /tmp 临时交付物，杜绝跨号串发）
function isPathAllowedForThisBot(p) {
  const norm = path.normalize(p);
  if (norm.startsWith('/tmp/')) return true;
  if (norm.startsWith(botRoot)) return true;
  return false;
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

  const absPathRegex = /(\/(?:root|tmp)[^\s\)\"\'\<\>]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|xlsx|zip|tar\.gz|md|html|htm|mp4|mov|m4v))/gi;
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
  const quotedPathRegex = /[`"'](\/(?:root|tmp)[^`"'\r\n]+?\.(?:jpg|jpeg|png|gif|webp|pdf|docx|xlsx|zip|tar\.gz|md|html|htm|mp4|mov|m4v))[`"']/gi;
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
            console.log(`[自动兜底捕获到新鲜下载的视频]: ${latestVideo}`);
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
function runAgent(promptText, conversationId = null) {
  return new Promise((resolve, reject) => {
    const args = ['--dangerously-skip-permissions'];
    if (conversationId) {
      args.push('--conversation', conversationId);
    }
    args.push('-p', promptText, '--output-format', 'json');

    console.log(`[调用 agy]: 会话ID=${conversationId || '(全新会话)'}`);

    execFile(
      'agy',
      args,
      {
        cwd: botRoot,
        timeout: 600000,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const isTimeout = error.killed || error.signal === 'SIGTERM';
          if (conversationId && !isTimeout) {
            console.warn(`[agy] 会话 ${conversationId} 恢复失败，自动创建全新会话重试...`);
            return runAgent(promptText, null).then(resolve).catch(reject);
          }
          console.error('[agy exec error]:', error, stderr);
          return reject(new Error(`Agent processing failed: ${stderr || error.message}`));
        }

        try {
          const res = JSON.parse(stdout.trim());
          resolve({
            reply: res.response || '',
            conversationId: res.conversation_id || conversationId,
          });
        } catch {
          resolve({
            reply: stdout.trim(),
            conversationId: conversationId,
          });
        }
      }
    );
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

const messageQueue = [];
let isProcessingQueue = false;

/**
 * 聚合交付下发引擎：将文本回复与附带媒体（图片/原生视频卡片/文件）安全推送到微信
 */
async function deliverResultToWechat(toUserId, contextToken, textReply, rawAgentReply, isAsyncCallback = false) {
  const config = loadConfig();
  const plainReply = stripMarkdown(textReply);

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
  }

  // 2. 检查是否有新鲜生成的媒体 (图片 / 视频 / 文件)
  const media = extractMediaPaths(rawAgentReply || textReply);

  // 2.1 图片 (仅推 1 张最新图片)
  if (media.images && media.images.length > 0) {
    const latestImg = media.images[media.images.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送图片至微信]: ${latestImg}`);
      await uploadAndSendWechatImage(toUserId, contextToken, latestImg, config);
      console.log(`[已成功将图片卡片发送至微信]: ${latestImg}`);
    } catch (imgErr) {
      console.error(`[发送微信图片卡片失败]:`, imgErr.message);
    }
  }

  // 2.2 视频 (原生 Type 5 视频卡片)
  if (media.videos && media.videos.length > 0) {
    const latestVideo = media.videos[media.videos.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送原生视频卡片至微信]: ${latestVideo}`);
      await uploadAndSendWechatVideo(toUserId, contextToken, latestVideo, config);
      console.log(`[已成功将原生视频卡片发送至微信]: ${latestVideo}`);
    } catch (vidErr) {
      console.error(`[发送微信原生视频卡片失败]:`, vidErr.message);
    }
  }

  // 2.3 文件
  if (media.files && media.files.length > 0) {
    const latestFile = media.files[media.files.length - 1];
    try {
      if (isAsyncCallback) await pushRateLimiter.acquirePermission();
      console.log(`[正在上传并发送文件至微信]: ${latestFile}`);
      await uploadAndSendWechatFile(toUserId, contextToken, latestFile, config);
      console.log(`[已成功将文件发送至微信]: ${latestFile}`);
    } catch (fileErr) {
      console.error(`[发送微信文件失败]:`, fileErr.message);
    }
  }
}

/**
 * 微信端一键空中升级 (OTA Air-Upgrade)
 * 支持指令：更新系统 / 系统更新 / 升级系统 / 检查更新 / /upgrade / /update
 */
async function handleSystemUpgradeTask({ from_user_id, context_token, config }) {
  const userNickname = config.user_nickname || '主人';

  // 1. 权限拦截：仅限当前实例授权绑定的主人操作
  if (config.authorized_user_id && from_user_id !== config.authorized_user_id) {
    console.log(`[升级拦截]: 非授权微信用户尝试触发升级: ${from_user_id}`);
    const unauthorizedNotice = `抱歉，只有【${userNickname}】才能执行系统空中升级指令哦～`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, unauthorizedNotice, config);
    }
    return;
  }

  // 2. 检查 Git 仓库环境
  const repoRoot = path.resolve(__dirname, '..');
  const gitDir = path.join(repoRoot, '.git');
  if (!fs.existsSync(gitDir)) {
    console.warn(`[升级拦截]: 当前目录未检测到 .git 仓库: ${repoRoot}`);
    const noGitNotice = `⚠️ 【无法空中升级】\n当前运行环境未检测到 Git 仓库版本管理。\n若为源码部署，请确认是否通过 git clone 获取完整工程。`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, noGitNotice, config);
    }
    return;
  }

  // 3. 秒级回执接单提示
  const startNotice = `🔄 【空中升级进行中】\n${userNickname}，正在连接云端拉取最新系统核心与技能代码，请稍候...`;
  if (from_user_id && context_token) {
    try {
      await sendWechatReply(from_user_id, context_token, startNotice, config);
      await sendWechatTyping(from_user_id, context_token, 1, config);
    } catch (e) {
      console.warn(`[发送升级接单提示异常]:`, e.message);
    }
  }

  // 4. 执行 git pull
  try {
    const { stdout } = await execAsync('git pull', { cwd: repoRoot, timeout: 60000 });
    console.log(`[Git Pull 结果]:`, stdout);

    if (stdout.includes('Already up to date') || stdout.includes('已经是最新')) {
      let commitInfo = '';
      try {
        const { stdout: logOut } = await execAsync('git log -1 --pretty=format:"%h - %s (%cr)"', { cwd: repoRoot });
        commitInfo = `\n📌 当前版本: ${logOut.trim()}`;
      } catch {}
      const alreadyLatestNotice = `✅ 【系统已是最新版本】\n${userNickname}，当前机器人系统已与云端代码完全同步，无需重复更新！${commitInfo}`;
      if (from_user_id && context_token) {
        await sendWechatReply(from_user_id, context_token, alreadyLatestNotice, config);
        await sendWechatTyping(from_user_id, context_token, 2, config);
      }
      return;
    }

    // 成功拉取到新更新
    let latestCommit = '';
    try {
      const { stdout: logOut } = await execAsync('git log -1 --pretty=format:"%h - %s (%cr)"', { cwd: repoRoot });
      latestCommit = logOut.trim();
    } catch {}

    const successNotice = `🎉 【系统空中升级成功】\n${userNickname}，已成功从云端拉取最新工程代码！\n\n📌 最新版本: ${latestCommit}\n\n⚙️ 正在为您平滑热重载后台服务，请稍候 3 秒...`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, successNotice, config);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }

    // 延迟 2 秒执行平滑热重载，确保回复已安全下发到微信
    setTimeout(async () => {
      try {
        const ecoFile = path.join(botRoot, 'ecosystem.config.cjs');
        const reloadCmd = fs.existsSync(ecoFile)
          ? `pm2 startOrReload "${ecoFile}" && pm2 save`
          : `pm2 reload all`;
        console.log(`[执行服务热重载]: ${reloadCmd}`);
        await execAsync(reloadCmd, { cwd: botRoot });
        console.log(`[服务热重载完成]`);
      } catch (reloadErr) {
        console.error(`[服务热重载异常]:`, reloadErr.message);
      }
    }, 2000);

  } catch (err) {
    console.error(`[空中升级异常]:`, err);
    const failReason = (err.stderr || err.message || '网络连接超时').slice(0, 300);
    const failNotice = `⚠️ 【系统空中升级失败】\n拉取云端更新时遇到异常：\n${failReason}\n\n请稍候重试或检查服务器 Git 状态。`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, failNotice, config);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
  }
}

/**
 * 从单个日志文件中提取有效对话轮次
 */
function parseTurnsFromLog(filePath, maxTurns = 10) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const lines = raw.split(/\n(?=\[\d{4}-\d{2}-\d{2}T)/);
    const parsedTurns = [];

    for (let i = lines.length - 1; i >= 0 && parsedTurns.length < maxTurns; i--) {
      const block = lines[i].trim();
      if (!block) continue;

      if (block.includes('[后台接管预告]') || block.includes('[会话已重置]')) {
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
    return parsedTurns;
  } catch {
    return [];
  }
}

/**
 * 提取最近几轮真实对话上下文 (跨天无缝缝合滑窗防失忆护栏)
 */
function getRecentChatContext(maxRounds = 5) {
  const neededTurns = maxRounds * 2;
  const todayFile = getDailyLogPath(0);
  const yesterdayFile = getDailyLogPath(-1);

  // 1. 优先读取今天的切片日志
  let turns = parseTurnsFromLog(todayFile, neededTurns);

  // 2. 如果今天刚过零点对话较少，向前无缝补齐昨天的对话记录
  if (turns.length < neededTurns && fs.existsSync(yesterdayFile)) {
    const remaining = neededTurns - turns.length;
    const yesterdayTurns = parseTurnsFromLog(yesterdayFile, remaining);
    turns = [...yesterdayTurns, ...turns];
  }

  // 3. 向下兼容：如果按天切片尚未沉淀，保底读取旧单文件
  if (turns.length === 0 && fs.existsSync(LOG_FILE)) {
    turns = parseTurnsFromLog(LOG_FILE, neededTurns);
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

/**
 * 动态加载当前 Bot 的专属专题知识分卷 (命中关键词才挂载，平时 0 消耗)。
 * 专题和关键词写在各实例自己的 topics.json 里（参考 bots/starter-bot/topics.example.json）。
 */
function loadTopicMemory(messageText) {
  const topicsDir = path.join(botRoot, 'data', 'memory', 'topics');
  const text = (messageText || '').toLowerCase();
  const matchedSections = [];

  for (const topic of loadTopicsConfig(botRoot)) {
    if (!topic.keywords.some((k) => matchesKeyword(text, k))) continue;
    try {
      const content = fs.readFileSync(path.join(topicsDir, topic.file), 'utf-8').trim();
      if (content) matchedSections.push(`【${topic.name} (${topic.file})】：\n${content}`);
    } catch {}
  }

  if (matchedSections.length > 0) {
    return '\n\n' + matchedSections.join('\n\n') + '\n';
  }
  return '';
}

/**
 * 读取当前 Bot 专属的核心档案 (MEMORY.md) + 动态按需专题库
 */
function loadBotMemory(messageText = '') {
  let result = '';
  // 1. 核心常驻档案 (严格保持在 3KB 以内，仅包含人设、禁忌、称呼、核心准则)
  const memoryPath = path.join(botRoot, 'MEMORY.md');
  if (fs.existsSync(memoryPath)) {
    try {
      const content = fs.readFileSync(memoryPath, 'utf-8').trim();
      if (content) {
        const safeContent = content.length > 4000 ? content.slice(0, 4000) + '\n...(部分超长历史已沉淀至 data/memory/)' : content;
        result += `\n\n【核心记忆档案与人设 (MEMORY.md)】：\n${safeContent}\n`;
      }
    } catch (e) {
      console.warn('[读取 MEMORY.md 异常]:', e.message);
    }
  }

  // 2. 动态激活匹配的专题分卷（命中关键词才带入，平时不加载，极度节省 token）
  const topicContent = loadTopicMemory(messageText);
  if (topicContent) {
    result += topicContent;
  }

  return result;
}

async function handleWechatTask(task) {
  const { from_user_id, message_text, context_token } = task;
  const config = loadConfig();

  console.log(`\n================== [微信消息开始处理] ==================`);
  console.log(`用户ID: ${from_user_id}`);
  console.log(`消息内容: ${message_text}`);
  appendLog(`微信接收 (${from_user_id}): ${message_text}`);

  // 快捷重置会话指令判断
  const isResetCommand = /^\s*(\/reset|\/clear|\/new|新会话|重置会话|清除记忆)\s*$/i.test(message_text);
  if (isResetCommand) {
    saveConfig({ conversation_id: null });
    const resetNotice = '已为您开启全新会话，之前的对话记忆已清空。您可以随时提出新任务！';
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, resetNotice, config);
    }
    console.log(`[会话已重置] 用户请求清除上下文。`);
    console.log(`====================================================\n`);
    return;
  }

  // 系统空中升级指令判断 (OTA Air-Upgrade)
  const isUpgradeCommand = /^\s*(\/upgrade|\/update|更新系统|系统更新|升级系统|检查更新|更新机器人|升级机器人|机器人更新)\s*$/i.test(message_text);
  if (isUpgradeCommand) {
    await handleSystemUpgradeTask({ from_user_id, context_token, config });
    console.log(`====================================================\n`);
    return;
  }

  const userNickname = config.user_nickname || '主人';
  const botName = config.bot_name || '小助理';
  const personaDesc = config.persona_description || `【${botName}】`;
  const forbiddenPrompt = config.forbidden_persona ? `严禁称呼用户为“${config.forbidden_persona}”。` : '';

  // 幂等防重检查：如果同一个任务正在后台运行，直接温和提示，不重复启动
  const taskKey = `${from_user_id}:${message_text.trim()}`;
  if (activeBackgroundTasks.has(taskKey)) {
    console.log(`[防重幂等拦截]: 任务正在后台运行中，跳过重复拉起: ${taskKey}`);
    const dupNotice = `${userNickname}，该任务已经在后台全力运转中啦，请稍候片刻，处理完成后【${botName}】会第一时间主动发给您～`;
    if (from_user_id && context_token) {
      await sendWechatReply(from_user_id, context_token, dupNotice, config);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
    console.log(`====================================================\n`);
    return;
  }

  // 1. 发送输入中状态
  if (from_user_id && context_token) {
    await sendWechatTyping(from_user_id, context_token, 1, config);
  }

  // 2. 调用 Antigravity 生成回复（带多轮会话记忆、长期记忆库与最近对话滑窗护栏）
  console.log(`[Antigravity 思考中...]`);
  let currentConvId = config.conversation_id || null;
  const memorySection = loadBotMemory(message_text);
  const recentChatSection = getRecentChatContext(5);
  const fullMessage = `[系统备注：当前微信对话用户为【${userNickname}】，助手身份为${personaDesc}。在所有回复中直接称呼用户为“${userNickname}”。${forbiddenPrompt}严禁修改全局AGENTS.md。若用户要求记住长期偏好、习惯或专业知识，请主动更新沉淀到当前目录的 MEMORY.md 或 data/memory/topics/ 对应专题分卷中。]${memorySection}${recentChatSection}\n[微信用户 ${userNickname}]: ${message_text}`;

  // 标记活跃后台任务
  activeBackgroundTasks.add(taskKey);

  // 启动智能体执行 (10分钟超时保护)
  const agentPromise = runAgent(fullMessage, currentConvId);

  // 软超时定时器 (35秒)：若 35 秒内未能完成，无缝切入后台静默运行并回执第 1 条接单消息
  const SOFT_TIMEOUT_MS = 35000;
  let softTimer = null;
  const softTimeoutPromise = new Promise((resolve) => {
    softTimer = setTimeout(() => {
      resolve({ isSlowTask: true });
    }, SOFT_TIMEOUT_MS);
  });

  const raceResult = await Promise.race([
    agentPromise.then((res) => ({ isSlowTask: false, res })).catch((err) => ({ isSlowTask: false, err })),
    softTimeoutPromise,
  ]);

  if (!raceResult.isSlowTask) {
    // -------------------------------------------------------------
    // 场景 A: 快速任务（35 秒内完成）- 保持原汁原味单条极速回复
    // -------------------------------------------------------------
    clearTimeout(softTimer);
    activeBackgroundTasks.delete(taskKey);

    let plainReply = '';
    let rawReply = '';
    if (raceResult.err) {
      console.error('[runAgent 异常]:', raceResult.err.message);
      plainReply = '小助理刚才正在处理上一条重度任务或网络发生波动，未能及时响应，请稍候重试一下～';
    } else {
      rawReply = raceResult.res.reply;
      plainReply = rawReply;
      if (raceResult.res.conversationId && raceResult.res.conversationId !== currentConvId) {
        saveConfig({ conversation_id: raceResult.res.conversationId });
        console.log(`[已持久化会话记忆 ID]: ${raceResult.res.conversationId}`);
      }
    }

    if (!plainReply || !plainReply.trim()) {
      plainReply = '收到你的消息了，正在处理中。';
    }

    console.log(`[Antigravity 回复]:\n${plainReply}`);

    if (from_user_id && context_token) {
      await deliverResultToWechat(from_user_id, context_token, plainReply, rawReply, false);
      await sendWechatTyping(from_user_id, context_token, 2, config);
    }
  } else {
    // -------------------------------------------------------------
    // 场景 B: 重度长任务（超过 35 秒）- 两段式优雅转入后台
    // -------------------------------------------------------------
    console.log(`⏳ [任务处理中 (>35s)，转入后台异步托管]: ${taskKey}`);

    // 【第 1 段消息】：使用当前新鲜有效的 context_token 秒级接单预告
    const handoverNotice = `${userNickname}，当前任务计算量较大（正在后台深度处理中），为避免微信等待超时，已自动转入【后台静默运行】。稍后处理完毕【${botName}】会自动把最终结果推送给您，${userNickname}可以先忙别的～`;
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
    agentPromise
      .then(async (agentRes) => {
        try {
          console.log(`\n🎉 [后台长任务执行成功]: ${taskKey}`);
          const rawReply = agentRes.reply;
          if (agentRes.conversationId && agentRes.conversationId !== currentConvId) {
            saveConfig({ conversation_id: agentRes.conversationId });
            console.log(`[后台长任务已更新会话记忆 ID]: ${agentRes.conversationId}`);
          }

          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          const targetToken = latestConfig.last_context_token || context_token;

          // 【第 2 段消息】：终结结果推送，单任务一生仅发这最后一条，杜绝任何碎片骚扰
          const headerPrefix = `🔔 【后台任务完成通知】\n${userNickname}，您交办的长任务已全部处理完成：\n\n`;
          const finalReply = headerPrefix + rawReply;

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
          console.error(`❌ [后台长任务执行异常]: ${taskKey}`, execErr.message);
          const latestConfig = loadConfig();
          const toUser = latestConfig.authorized_user_id || from_user_id;
          const targetToken = latestConfig.last_context_token || context_token;

          let friendlyReason = execErr.message || '未知异常';
          if (friendlyReason.includes('timeout') || friendlyReason.includes('SIGTERM')) {
            friendlyReason = '执行耗时超过系统最大保护上限 (10分钟)';
          }

          const errorNotice = `🔔 【后台任务执行提醒】\n${userNickname}，刚才在后台处理的任务遇到异常中断：${friendlyReason}。稍候可精简任务内容后重试～`;
          await deliverResultToWechat(toUser, targetToken, errorNotice, '', true);
        } catch (postErr) {
          console.error(`[后台异常通知发送失败]:`, postErr.message);
        } finally {
          activeBackgroundTasks.delete(taskKey);
        }
      });
  }

  console.log(`====================================================\n`);
}

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    const task = messageQueue.shift();
    try {
      await handleWechatTask(task);
    } catch (err) {
      console.error('[队列任务执行异常]:', err);
    }
  }

  isProcessingQueue = false;
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
    const config = loadConfig();
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
        const { from_user_id, message_text, context_token } = payload;

        if (!message_text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing message_text' }));
        }

        // 立即确认应答，避免 HTTP 挂死/超时断开
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, queued: true }));

        // 压入排队队列按序执行，彻底规避 agy 并发会话死锁
        messageQueue.push({ from_user_id, message_text, context_token });
        processQueue().catch((err) => {
          console.error('[processQueue 异常]:', err);
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
});
