/**
 * 管理服务（clawbot-manager.service，root）：统一管所有机器人的版本记录和管理指令，机器人自己不需要任何多余的权限。
 *   - 每分钟检查一遍各机器人的记忆和设置文件，有改动、并且停了一会儿就存一版（/var/lib/clawbot/memory-history，只有 root 能读写）；
 *   - 替每个机器人把待发的早间"改动"汇报写进它自己的 data/state/memory_digest.json，它发出去后写回执，这里再记进度；
 *   - 处理各机器人的消息服务转来的管理指令（它自己目录的 data/requests/*.json）：「记忆改动」「撤销 N」，
 *     管理员还能「X改动」看、撤销别的机器人的改动。处理完直接经这个机器人的微信回给发指令的人：
 *     结果不经过任何机器人的智能体，也不写进聊天日志。
 * 管理员：告警配置（/etc/clawbot/alert.json）里 owner_bot 那个机器人的用户。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotAll, syncBotDigests, showChanges, undoItems, discoverBots, ownerBotName, insideBot, readBotFile, writeJsonForBot } from './memory_history.js';
import { sendWechatReply, loadBotSettings } from './wechat_reply.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOTS_DIR = process.env.CLAWBOT_BOTS_DIR || path.join(PROJECT_DIR, 'bots');
const SNAPSHOT_EVERY_MS = Number(process.env.CLAWBOT_MEMORY_SNAPSHOT_MS) || 60_000;
const REQUEST_POLL_MS = Number(process.env.CLAWBOT_REQUEST_POLL_MS) || 1500;
const REQUEST_MAX_AGE_MS = 5 * 60_000;
// 消息服务写的请求文件名：时间 + 8 位随机数。只认这个格式：以 root 删文件时，就算目录被人换成了软链接，也删不到别的文件
const REQUEST_NAME = /^\d{13}-[0-9a-f]{8}\.json$/;
const SEND_TIMEOUT_MS = 30_000;

// 管理服务自己出的问题，记成管理员那个机器人的告警事件，由监控统一去重、发送
function raiseAlert(kind, detail) {
  const admin = ownerBotName();
  const bots = discoverBots(BOTS_DIR);
  const botRoot = bots.find((b) => path.basename(b) === admin) || bots[0];
  if (!botRoot) return;
  try {
    writeJsonForBot(botRoot, path.join(botRoot, 'data', 'alerts', `${Date.now()}-manager.json`), { kind, detail: String(detail).slice(0, 300), at: Date.now() });
  } catch (err) {
    console.error('[告警] 写入告警事件失败:', err.message);
  }
}

// 管理员的消息服务认「X改动」时要知道有哪些机器人：只写进管理员自己的目录（别的机器人看不到彼此）
function writeBotNames(bots, admin) {
  const adminRoot = bots.find((b) => path.basename(b) === admin);
  if (!adminRoot) return;
  const names = bots.filter((b) => b !== adminRoot).map((b) => ({ bot: path.basename(b), name: loadBotSettings(b).bot_name || path.basename(b) }));
  const file = path.join(adminRoot, 'data', 'state', 'manager_bots.json');
  let old = null;
  try { old = fs.readFileSync(file, 'utf-8'); } catch {}
  if (old !== null && old === JSON.stringify(names, null, 2)) return;
  writeJsonForBot(adminRoot, file, names);
}

let lastSnapshotAlertAt = 0;
function snapshotCycle() {
  try {
    for (const s of snapshotAll({ botsDir: BOTS_DIR })) {
      console.log(`[版本记录] ${s.bot} 有改动，存了一版 ${s.commit.slice(0, 7)}`);
    }
    syncBotDigests({ botsDir: BOTS_DIR, includeOwner: true });
    writeBotNames(discoverBots(BOTS_DIR), ownerBotName());
  } catch (err) {
    console.error('[版本记录失败]:', err.message);
    if (Date.now() - lastSnapshotAlertAt > 3600_000) {
      lastSnapshotAlertAt = Date.now();
      raiseAlert('memory_snapshot_failed', `记忆历史存版本失败：${err.message}`);
    }
  }
}

const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${Math.round(ms / 1000)} 秒没有响应`)), ms).unref()),
]);

async function handleRequest(botRoot, req, admin, bots) {
  const bot = path.basename(botRoot);
  const cfg = loadBotSettings(botRoot);
  // 只认这个机器人绑定的那个用户发来的；太久以前的（比如管理服务停了一阵）不再处理
  if (!req.from_user_id || req.from_user_id !== cfg.authorized_user_id) {
    console.warn(`[管理指令] ${bot}：不是它绑定的用户发的，不处理`);
    return;
  }
  if (!(Date.now() - Number(req.at || 0) < REQUEST_MAX_AGE_MS)) {
    console.warn(`[管理指令] ${bot}：是 ${Math.round((Date.now() - Number(req.at || 0)) / 60000)} 分钟以前的，不再处理`);
    return;
  }
  let reply;
  if (req.type === 'show') {
    const target = req.bot || bot;
    if (target !== bot && bot !== admin) reply = '只有管理员能看别的机器人的改动。';
    else if (!bots.some((b) => path.basename(b) === target)) reply = '没有找到这个机器人。';
    else reply = showChanges({ botsDir: BOTS_DIR, bot: target, viewer: bot });
  } else if (req.type === 'undo') {
    const items = req.items === 'all' ? 'all' : (Array.isArray(req.items) ? req.items.map(Number).filter(Number.isInteger) : []);
    reply = items === 'all' || items.length ? undoItems(items, { botsDir: BOTS_DIR, viewer: bot, scope: req.scope === 'all' ? 'all' : 'memory' }) : '没看懂要撤销第几条。';
  } else {
    return;
  }
  await withTimeout(sendWechatReply(req.from_user_id, req.context_token, reply, cfg), SEND_TIMEOUT_MS);
  console.log(`[管理指令] ${bot}：${req.type === 'show' ? `查看${req.bot && req.bot !== bot ? ` ${req.bot} 的` : ''}改动` : '撤销'}，已回复`);
}

let requestsRunning = false;
async function requestCycle() {
  if (requestsRunning) return;
  requestsRunning = true;
  try {
    const admin = ownerBotName();
    const bots = discoverBots(BOTS_DIR);
    for (const botRoot of bots) {
      const dir = path.join(botRoot, 'data', 'requests');
      // data 或 requests 是软链接（指到别处）：不处理
      if (!insideBot(botRoot, path.join(dir, 'x.json'))) continue;
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => REQUEST_NAME.test(f)).sort(); } catch { continue; }
      for (const f of files) {
        const p = path.join(dir, f);
        let req = null;
        try { req = JSON.parse(readBotFile(botRoot, p).toString('utf-8')); } catch {}
        // 先删再处理：处理到一半出错也不会一遍遍重来
        fs.rmSync(p, { force: true });
        if (!req) continue;
        try {
          await handleRequest(botRoot, req, admin, bots);
        } catch (err) {
          console.error(`[管理指令失败] ${path.basename(botRoot)}:`, err.message);
          try {
            const cfg = loadBotSettings(botRoot);
            await withTimeout(sendWechatReply(req.from_user_id, req.context_token, '这条指令没有执行成功，原因记在管理服务的日志里了，稍后再试一次。', cfg), SEND_TIMEOUT_MS);
          } catch {}
        }
      }
    }
  } finally {
    requestsRunning = false;
  }
}

function main() {
  const admin = ownerBotName();
  const bots = discoverBots(BOTS_DIR).map((b) => path.basename(b));
  console.log(`[管理服务已启动] 管 ${bots.length} 个机器人：${bots.join('、') || '（还没有）'}；管理员：${admin ? `${admin} 的用户` : '没有配置（看不了别的机器人的改动）'}`);
  console.log(`  每 ${Math.round(SNAPSHOT_EVERY_MS / 1000)} 秒检查一遍记忆和设置的改动并存版本，每 ${REQUEST_POLL_MS / 1000} 秒处理一次管理指令`);
  snapshotCycle();
  setInterval(snapshotCycle, SNAPSHOT_EVERY_MS);
  setInterval(() => { requestCycle().catch((err) => console.error('[管理指令循环异常]:', err.message)); }, REQUEST_POLL_MS);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
