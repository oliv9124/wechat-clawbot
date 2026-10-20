process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './wechat_reply.js';

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
      console.error('[下载解密媒体] 无法解析 AES Key:', rawAesKey);
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

    console.log(`[正在从腾讯 CDN 下载媒体]: ${downloadUrl.slice(0, 80)}...`);
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
    console.log(`[媒体已成功解密落盘]: ${filePath} (${decryptedBytes.length} 字节)`);
    return filePath;
  } catch (err) {
    console.error('[下载解密媒体异常]:', err.message);
    return null;
  }
}

async function forwardToRoutine(webhookUrl, webhookKey, payload, maxRetries = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${webhookKey}`,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Webhook POST failed (${res.status}): ${errText}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      const detail = err.cause ? (err.cause.code || err.cause.message) : err.message;
      if (attempt < maxRetries) {
        console.warn(`[转发至 Routine 重试 ${attempt}/${maxRetries}] 遇到: ${detail}，2秒后重试...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastErr;
}

async function startPolling() {
  let config = loadConfig();

  if (!config.bot_token) {
    console.error('❌ 未检测到登录凭证 (bot_token)！请先运行 "node login.js" 进行扫码绑定。');
    process.exit(1);
  }

  const baseUrl = (config.base_url || 'https://ilinkai.weixin.qq.com').replace(/\/+$/, '');
  const webhookUrl = config.webhook_url || 'http://127.0.0.1:18888/webhook/wechat';
  const webhookKey = config.webhook_key || '';

  console.log(`[转发程序已启动] 正在通过 iLink 长轮询监听微信消息...`);
  console.log(`已绑定用户: ${config.authorized_user_id || '等待首位用户消息自动锁定'}`);
  console.log(`下旨入口 Webhook: ${webhookUrl}`);

  let getUpdatesBuf = config.get_updates_buf || '';

  while (true) {
    try {
      config = loadConfig(); // 每次轮询前刷新配置
      const token = config.bot_token;
      if (!token) {
        console.error('❌ 凭证丢失，停止轮询。');
        break;
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

      // 检查错误码
      if (data.errcode === -14) {
        console.error('\n⚠️ [凭证过期] 接口返回错误码 -14（Session 已过期或未授权）。');
        console.error('请重新执行扫码命令刷新凭证！');
        break;
      }

      if (data.ret !== 0 && data.errcode) {
        console.warn(`[getupdates 接口警告]: ret=${data.ret} errcode=${data.errcode} errmsg=${data.errmsg}`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // 更新同步游标
      if (data.get_updates_buf) {
        getUpdatesBuf = data.get_updates_buf;
        saveConfig({ get_updates_buf: getUpdatesBuf });
      }

      // 处理收到的消息
      const msgs = data.msgs || [];
      for (const msg of msgs) {
        console.log(`[iLink 接收到完整事件]:`, JSON.stringify(msg, null, 2));

        const fromUser = msg.from_user_id;
        if (!fromUser) {
          continue;
        }

        // 仅处理绑定的用户
        let authorizedUser = config.authorized_user_id;
        if (!authorizedUser) {
          authorizedUser = fromUser;
          saveConfig({ authorized_user_id: fromUser });
          console.log(`[首次绑定] 成功锁定授权用户: ${fromUser}`);
        } else if (fromUser !== authorizedUser) {
          console.log(`[过滤非绑定用户] 收到非授权用户 (${fromUser}) 的消息，已安全忽略。`);
          continue;
        }

        // 保存最新的 context_token
        if (msg.context_token) {
          saveConfig({ last_context_token: msg.context_token });
        }

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
              console.log(`[微信语音识别 ASR]: "${item.voice_item.text}"`);
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
              console.log(`[微信接收文件]: ${fileName} -> ${filePath}`);
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
          continue;
        }

        console.log(`\n[微信收到用户指令]: ${text}`);

        // 异步转发给 routine「微信下旨入口」，不阻塞后续长轮询
        forwardToRoutine(webhookUrl, webhookKey, {
          from_user_id: fromUser,
          message_text: text,
          context_token: msg.context_token,
        }).catch((fwdErr) => {
          console.error(`[转发至 Routine 失败]:`, fwdErr.message);
        });
      }
    } catch (err) {
      console.error('[轮询异常中断，3秒后重试]:', err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

startPolling();
