process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadRuntimeState, saveRuntimeState, describeText, describePath, LOG_CONTENT } from './wechat_reply.js';
import { enqueueInbox } from './inbox.js';
import { raiseAlert } from './alert.js';

// 凭证过期后多久再试一次：退出重启只会每几秒撞一次接口，没有意义（环境变量仅供测试缩短）
const CREDENTIAL_RETRY_MS = Number(process.env.FORWARDER_CREDENTIAL_RETRY_MS) || 10 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botRoot = process.cwd();

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token.trim()}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '132106',
  };
}

function decryptAesEcb(ciphertext, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    const rawDecipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    rawDecipher.setAutoPadding(false);
    return Buffer.concat([rawDecipher.update(ciphertext), rawDecipher.final()]);
  }
}

function parseAesKey(aesKeyStr) {
  if (!aesKeyStr) return null;
  const str = String(aesKeyStr).trim();
  if (str.length === 32 && /^[0-9a-fA-F]{32}$/.test(str)) {
    return Buffer.from(str, 'hex');
  }
  const decoded = Buffer.from(str, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  return null;
}

/**
 * Universal media downloader & decryptor for images, files, videos, and voices.
 */
async function downloadAndDecryptMedia(itemObj, defaultExt = '.bin', customFileName = null) {
  try {
    const baseDir = fs.existsSync(path.join(botRoot, 'data', 'downloads'))
      ? path.join(botRoot, 'data', 'downloads')
      : path.join(botRoot, 'downloads');
    const destDir = path.join(baseDir, 'wechat');
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const media = itemObj.media || itemObj.thumb_media;
    if (!media) return null;

    const rawAesKey = itemObj.aeskey || media.aes_key;
    const key = parseAesKey(rawAesKey);
    if (!key) {
      console.error(`[下载解密媒体] 无法解析 AES Key（长度 ${String(rawAesKey || '').length}）`);
      return null;
    }

    let downloadUrl = media.full_url;
    if (!downloadUrl && media.encrypt_query_param) {
      downloadUrl = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    }
    if (!downloadUrl) {
      console.error('[下载解密媒体] 缺少下载 URL 与参数');
      return null;
    }

    console.log(`[正在从腾讯 CDN 下载媒体]: ${URL.canParse(downloadUrl) ? new URL(downloadUrl).host : '（地址无法解析）'}`);
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      console.error('[下载媒体失败]: HTTP', res.status);
      return null;
    }

    const encryptedBytes = Buffer.from(await res.arrayBuffer());
    const decryptedBytes = decryptAesEcb(encryptedBytes, key);

    const safeName = customFileName
      ? `wx_${Date.now()}_${customFileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      : `wx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${defaultExt}`;
    const filePath = path.join(destDir, safeName);
    fs.writeFileSync(filePath, decryptedBytes);
    console.log(`[媒体已成功解密落盘]: ${describePath(filePath)} (${decryptedBytes.length} 字节)`);
    return filePath;
  } catch (err) {
    console.error('[下载解密媒体异常]:', err.message);
    return null;
  }
}

async function startPolling() {
  let config = loadConfig();

  // 没有凭证也不退出（退出只会被 systemd 每几秒拉起一次）：下面的循环会告警，并每 10 分钟检查一次
  if (!config.bot_token) {
    console.error('❌ 未检测到登录凭证 (bot_token)！请先运行 "node login.js" 进行扫码绑定。');
  }

  const baseUrl = (config.base_url || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');

  console.log(`[转发程序已启动] 正在通过 iLink 长轮询监听微信消息...`);
  console.log(`已绑定用户: ${config.authorized_user_id || '（未绑定，将拒收所有消息，请运行 login.js 扫码绑定）'}`);
  console.log(`消息收件箱: ${path.join(botRoot, 'data', 'inbox', 'pending')}`);

  let getUpdatesBuf = loadRuntimeState('forwarder').get_updates_buf || '';
  // 登录状态：unknown（刚启动）/ ok / expired。变成 expired 时告警一次；之后第一次拉取成功就报"正常"。
  // 刚启动时也报一次"正常"：主人重新扫码后服务会重启，监控靠这一条知道已经恢复
  let credentialState = 'unknown';

  while (true) {
    try {
      config = loadConfig(); // 每次轮询前刷新配置
      const token = config.bot_token;
      if (!token) {
        console.error('❌ 配置里没有登录凭证，请重新扫码登录。稍后再检查。');
        if (credentialState !== 'expired') {
          credentialState = 'expired';
          raiseAlert('credential_expired', '配置里没有登录凭证（bot_token）');
        }
        await new Promise((r) => setTimeout(r, CREDENTIAL_RETRY_MS));
        continue;
      }

      const endpoint = `${baseUrl}/ilink/bot/getupdates`;
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: buildHeaders(token),
          body: JSON.stringify({ get_updates_buf: getUpdatesBuf }),
          signal: AbortSignal.timeout(45000),
        });
      } catch (fetchErr) {
        if (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError') {
          // 长轮询正常超时，进入下一次轮询
          continue;
        }
        throw fetchErr;
      }

      if (!res.ok) {
        console.warn(`[getupdates HTTP 错误]: ${res.status}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const data = await res.json();

      // 检查错误码：凭证过期时发一次告警，然后放慢到每 10 分钟试一次，等主人重新扫码
      if (data.errcode === -14) {
        console.error(`\n⚠️ [凭证过期] 接口返回错误码 -14（Session 已过期或未授权），请重新扫码登录。${Math.round(CREDENTIAL_RETRY_MS / 1000)} 秒后再试。`);
        if (credentialState !== 'expired') {
          credentialState = 'expired';
          raiseAlert('credential_expired', '微信接口返回 -14（登录已过期）');
        }
        await new Promise((r) => setTimeout(r, CREDENTIAL_RETRY_MS));
        continue;
      }

      if (data.ret !== 0 && data.errcode) {
        console.warn(`[getupdates 接口警告]: ret=${data.ret} errcode=${data.errcode} errmsg=${data.errmsg}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      if (credentialState !== 'ok') {
        if (credentialState === 'expired') console.log('[凭证恢复] 微信接口恢复正常');
        credentialState = 'ok';
        raiseAlert('credential_ok', '微信接口正常');
      }

      // 处理收到的消息：每条先落进收件箱，整批都落盘后才推进同步游标（见循环后）
      const msgs = data.msgs || [];
      const seenIds = new Set(loadRuntimeState('forwarder').recent_message_ids || []);
      let latestContextToken = null;
      let latestUserMessageAt = 0;
      for (const msg of msgs) {
        // 默认只记事件概要；完整事件里有消息原文、context_token 和媒体解密密钥
        const itemTypes = (msg.item_list || []).map((i) => i.type).join(',') || '无';
        console.log(`[iLink 收到事件] message_id=${msg.message_id} from=${msg.from_user_id} 内容类型=${itemTypes}`);
        if (LOG_CONTENT) console.log(`[iLink 完整事件]:`, JSON.stringify(msg, null, 2));

        const fromUser = msg.from_user_id;
        if (!fromUser) {
          continue;
        }

        // 仅处理扫码登录时绑定的用户；未绑定时一律拒收，不再把第一个发消息的人自动设为主人
        const authorizedUser = config.authorized_user_id;
        if (!authorizedUser) {
          console.warn(`[拒收消息] 当前实例未绑定授权用户，已忽略 ${fromUser} 的消息。请在实例目录运行 node ../../core/login.js 重新扫码绑定。`);
          continue;
        }
        if (fromUser !== authorizedUser) {
          console.log(`[过滤非绑定用户] 收到非授权用户 (${fromUser}) 的消息，已安全忽略。`);
          continue;
        }

        // 同一条消息（重新拉取时可能再来一次）只收一次。message_id 超出 JS 安全整数范围，
        // 解析后低位会丢精度，所以和 create_time_ms 拼在一起作为去重键
        const messageId = `${msg.message_id ?? fromUser}-${msg.create_time_ms ?? ''}`;
        if (seenIds.has(messageId)) {
          console.log(`[去重] 消息 ${messageId} 已经收过，跳过。`);
          continue;
        }

        if (msg.context_token) {
          latestContextToken = msg.context_token;
        }
        // 对方最近一次发消息的时间：微信只允许机器人在这之后约 24 小时内主动发消息，调度器据此提醒对方回一句
        latestUserMessageAt = Math.max(latestUserMessageAt, Number(msg.create_time_ms) || Date.now());

        // 提取文本内容与各类媒体（图片、语音、文档文件、视频）
        const items = msg.item_list || [];
        let text = '';
        const imagePaths = [];
        const filePaths = [];
        const voiceTexts = [];

        for (const item of items) {
          // 1: 纯文本
          if (item.type === 1 && item.text_item && item.text_item.text) {
            text += item.text_item.text;
          }
          // 2: 图片
          else if (item.type === 2 && item.image_item) {
            const imgPath = await downloadAndDecryptMedia(item.image_item, '.jpg');
            if (imgPath) {
              imagePaths.push(imgPath);
            }
          }
          // 3: 语音 (带腾讯官方微信高精度 ASR 识别文本)
          else if (item.type === 3 && item.voice_item) {
            if (item.voice_item.text) {
              voiceTexts.push(item.voice_item.text.trim());
              console.log(`[微信语音识别 ASR]: ${describeText(item.voice_item.text)}`);
            }
            const voicePath = await downloadAndDecryptMedia(item.voice_item, '.silk');
            if (voicePath && !item.voice_item.text) {
              filePaths.push({ path: voicePath, name: path.basename(voicePath) });
            }
          }
          // 4: 文件 / 文档 (代码、PDF、Word、Excel、Zip、Txt 等)
          else if (item.type === 4 && item.file_item) {
            const fileName = item.file_item.file_name || 'document.bin';
            const ext = path.extname(fileName) || '.bin';
            const filePath = await downloadAndDecryptMedia(item.file_item, ext, fileName);
            if (filePath) {
              filePaths.push({ path: filePath, name: fileName });
              console.log(`[微信接收文件]: ${describePath(filePath)}`);
            }
          }
          // 5: 视频
          else if (item.type === 5 && item.video_item) {
            const videoPath = await downloadAndDecryptMedia(item.video_item, '.mp4');
            if (videoPath) {
              filePaths.push({ path: videoPath, name: 'video.mp4' });
            }
          }

          // 引用消息解析
          if (item.ref_msg) {
            const refTitle = item.ref_msg.title || '';
            if (refTitle) {
              text = `[引用微信消息: ${refTitle}]\n${text}`;
            }
          }
        }

        // 拼接语音转写文本
        if (voiceTexts.length > 0) {
          const vText = voiceTexts.join(' ');
          text = text.trim() ? `${text}\n[用户微信语音内容]: ${vText}` : vText;
        }

        // 拼接图片提示
        if (imagePaths.length > 0) {
          const imgPrompt = imagePaths.map((p) => `[已接收用户发送的图片文件: ${p}，请查看此图片进行识别分析]`).join(' ');
          text = text.trim() ? `${text}\n${imgPrompt}` : `请查看并详细分析用户在微信发送的这张图片: ${imagePaths.join(', ')}`;
        }

        // 拼接文件提示
        if (filePaths.length > 0) {
          const filePrompt = filePaths
            .map((f) => `[已接收用户在微信发送的文件: ${f.path} (原文件名: ${f.name})，请根据需要阅读或处理该文件]`)
            .join('\n');
          text = text.trim() ? `${text}\n${filePrompt}` : filePrompt;
        }

        if (!text.trim()) {
          console.log('[收到空消息或未支持的媒体类型，暂不处理]');
          seenIds.add(messageId);
          continue;
        }

        console.log(`\n[微信收到用户指令] ${describeText(text)}（图片 ${imagePaths.length}，文件 ${filePaths.length}）`);

        // 落进收件箱，由 routine 按顺序取走处理；routine 暂时不在线也不会丢
        enqueueInbox({
          message_id: messageId,
          create_time_ms: msg.create_time_ms || Date.now(),
          from_user_id: fromUser,
          message_text: text,
          context_token: msg.context_token,
        });
        seenIds.add(messageId);
      }

      // 整批消息都已落盘，才推进同步游标；中途崩溃会重新拉到这批，靠 message_id 去重
      const cursorChanged = Boolean(data.get_updates_buf) && data.get_updates_buf !== getUpdatesBuf;
      if (msgs.length > 0 || cursorChanged) {
        const stateUpdates = { recent_message_ids: [...seenIds].slice(-500) };
        if (data.get_updates_buf) stateUpdates.get_updates_buf = data.get_updates_buf;
        if (latestContextToken) stateUpdates.last_context_token = latestContextToken;
        if (latestUserMessageAt) stateUpdates.last_user_message_at = latestUserMessageAt;
        saveRuntimeState('forwarder', stateUpdates);
      }
      if (data.get_updates_buf) {
        getUpdatesBuf = data.get_updates_buf;
      }
    } catch (err) {
      console.error('[轮询异常中断，3秒后重试]:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

startPolling();
