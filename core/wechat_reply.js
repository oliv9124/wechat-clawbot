import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getConfigPath(customPath = null) {
  if (customPath) return customPath;
  if (process.env.BOT_CONFIG_PATH) return process.env.BOT_CONFIG_PATH;
  const cwdConfig = path.join(process.cwd(), 'config.json');
  if (fs.existsSync(cwdConfig)) return cwdConfig;
  return path.join(__dirname, 'config.json');
}

export function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

export function loadConfig(customPath = null) {
  const targetPath = getConfigPath(customPath);
  if (fs.existsSync(targetPath)) {
    try {
      return JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveConfig(updates, customPath = null) {
  const targetPath = getConfigPath(customPath);
  const current = loadConfig(targetPath);
  const next = { ...current, ...updates };
  fs.writeFileSync(targetPath, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/**
 * Remove markdown styling so WeChat displays clean plain text.
 */
export function stripMarkdown(text) {
  if (!text) return '';
  let str = text;
  // Code blocks: remove ```language and ```
  str = str.replace(/```[a-zA-Z0-9_\-\s]*\n([\s\S]*?)```/g, '$1');
  // Inline code: remove `
  str = str.replace(/`([^`]+)`/g, '$1');
  // Headings: remove #, ##, etc.
  str = str.replace(/^#{1,6}\s+(.*)$/gm, '$1');
  // Bold & Italic: **text**, *text*, __text__, _text_
  str = str.replace(/\*\*([^*]+)\*\*/g, '$1');
  str = str.replace(/\*([^*]+)\*/g, '$1');
  str = str.replace(/__([^_]+)__/g, '$1');
  str = str.replace(/_([^_]+)_/g, '$1');
  // Blockquotes: remove >
  str = str.replace(/^>\s?(.*)$/gm, '$1');
  // Links: [text](url) -> text (url)
  str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Clean local file:/// URLs to prevent WeChat security filter dropping
  str = str.replace(/\(?file:\/\/\/[^\s\)\"\']+\)?/gi, '');
  // Bullet lists: * or - to standard bullet
  str = str.replace(/^[\*\-]\s+/gm, '• ');
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
 * status: 1 = start typing, 2 = stop typing
 */
export async function sendWechatTyping(userId, contextToken, status = 1, overrideConfig) {
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
    if (status === 1) {
      console.log(`[sendtyping] 已向微信发送“正在输入...”状态 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.warn('[sendtyping 警告]:', err.message);
  }
}

/**
 * Send reply text message back to WeChat via iLink sendmessage API.
 */
export async function sendWechatReply(toUserId, contextToken, replyText, overrideConfig) {
  const config = overrideConfig || loadConfig();
  const baseUrl = config.base_url || 'https://ilinkai.weixin.qq.com';
  const token = config.bot_token;

  if (!token) {
    throw new Error('未配置 bot_token，请先完成扫码登录！');
  }
  if (!contextToken) {
    throw new Error('缺少 context_token，无法回复微信消息！');
  }

  const plainText = stripMarkdown(replyText);
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/sendmessage`;

  const clientId = `openclaw-weixin:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token.trim()}`,
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '132106',
  };

  const payload = {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [
        {
          type: 1,
          text_item: {
            text: plainText,
          },
        },
      ],
    },
    base_info: {
      channel_version: '2.4.10',
      bot_agent: 'OpenClaw',
    },
  };

  console.log(`[sendmessage 发送给微信]: to=${toUserId} text="${plainText}"`);
  console.log(`[sendmessage 完整 Payload]:`, JSON.stringify(payload));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.log(`[sendmessage 微信服务端原始返回]: HTTP ${res.status} Body: ${raw}`);
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { raw };
  }

  if (!res.ok || (json.ret !== undefined && json.ret !== 0) || (json.errcode !== undefined && json.errcode !== 0)) {
    console.error('[sendmessage failed]', res.status, raw);
    throw new Error(`sendmessage failed: ${raw}`);
  }

  console.log(`[sendmessage success] to=${toUserId} msg_id=${json.message_id || 'ok'}`);
  return json;
}

/**
 * Upload a local image to Tencent Weixin C2C CDN and send as an image message.
 */
export async function uploadAndSendWechatImage(toUserId, contextToken, imagePath, overrideConfig) {
  const config = overrideConfig || loadConfig();
  const baseUrl = config.base_url || 'https://ilinkai.weixin.qq.com';
  const token = config.bot_token;

  if (!fs.existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  const buf = fs.readFileSync(imagePath);
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
  const filesize = Math.ceil((rawsize + 1) / 16) * 16;
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskeyBuffer = crypto.randomBytes(16);
  const aeskeyHex = aeskeyBuffer.toString('hex');

  const uploadUrlReq = {
    filekey,
    media_type: 1, // IMAGE
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
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
    throw new Error('CDN 上传未返回 x-encrypted-param 下载凭证');
  }

  // 关键：微信客户端要求 aes_key 为 32 位 Hex 字符的 Base64 编码
  const aesKeyBase64OfHex = Buffer.from(aeskeyHex).toString('base64');
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
            mid_size: ciphertext.length,
            hd_size: ciphertext.length,
          },
        },
      ],
    },
    base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' },
  };

  const sendRes = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token.trim()}`,
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132106',
    },
    body: JSON.stringify(sendReq),
  });

  const sendData = await sendRes.json();
  console.log(`[sendImage success] to=${toUserId} msg_id=${sendData.message_id || 'ok'}`);
  return sendData;
}

/**
 * Upload a local document/file to Tencent Weixin C2C CDN and send as a file message.
 */
export async function uploadAndSendWechatFile(toUserId, contextToken, filePath, overrideConfig) {
  const config = overrideConfig || loadConfig();
  const baseUrl = config.base_url || 'https://ilinkai.weixin.qq.com';
  const token = config.bot_token;

  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const buf = fs.readFileSync(filePath);
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
  const filesize = Math.ceil((rawsize + 1) / 16) * 16;
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskeyBuffer = crypto.randomBytes(16);
  const aeskeyHex = aeskeyBuffer.toString('hex');

  const uploadUrlReq = {
    filekey,
    media_type: 3, // MEDIA_FILE
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
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
    throw new Error('CDN 上传未返回 x-encrypted-param 下载凭证');
  }

  const aesKeyBase64OfHex = Buffer.from(aeskeyHex).toString('base64');
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

  const sendRes = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${token.trim()}`,
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132106',
    },
    body: JSON.stringify(sendReq),
  });

  const sendData = await sendRes.json();
  console.log(`[sendFile success] to=${toUserId} file=${fileName} msg_id=${sendData.message_id || 'ok'}`);
  return sendData;
}

/**
 * Generic buffer upload to Tencent Weixin C2C CDN.
 * media_type: 1 = Image, 3 = File, 4 = Video
 */
export async function uploadBufferToCdn(buf, media_type, toUserId, overrideConfig) {
  const config = overrideConfig || loadConfig();
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
    no_need_thumb: true,
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
    throw new Error('CDN 上传未返回 x-encrypted-param 下载凭证');
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
 * Upload an MP4 video with an extracted thumbnail and send as a Native Video Card (type: 5, video_item).
 * Displays thumbnail + play button in WeChat chat window; tap to play directly in full screen.
 * Automatically falls back to file card (type: 4) if native video payload fails.
 */
export async function uploadAndSendWechatVideo(toUserId, contextToken, videoPath, overrideConfig) {
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

  try {
    execFileSync('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-ss', '00:00:01',
      '-vframes', '1',
      tempThumb,
    ], { stdio: 'ignore', timeout: 10000 });

    if (fs.existsSync(tempThumb)) {
      thumbBuf = fs.readFileSync(tempThumb);
    }
  } catch (e) {
    console.warn('[ffmpeg 截取封面失败]:', e.message);
  } finally {
    if (fs.existsSync(tempThumb)) {
      try { fs.unlinkSync(tempThumb); } catch {}
    }
  }

  if (!thumbBuf) {
    console.log('[未生成封面图，降级走普通文件卡片通道发送]');
    return await uploadAndSendWechatFile(toUserId, contextToken, videoPath, config);
  }

  try {
    const videoBuf = fs.readFileSync(videoPath);
    console.log(`[正在上传原生视频本体至微信 CDN]: ${videoPath} (${videoBuf.length} 字节)...`);
    const videoUp = await uploadBufferToCdn(videoBuf, 2, toUserId, config); // 2 = MEDIA_VIDEO

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

    const sendRes = await fetch(`${baseUrl}/ilink/bot/sendmessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token.trim()}`,
        'X-WECHAT-UIN': randomWechatUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': '132106',
      },
      body: JSON.stringify(sendReq),
    });

    const sendData = await sendRes.json();
    if ((sendData.ret !== undefined && sendData.ret !== 0) || (sendData.errcode !== undefined && sendData.errcode !== 0)) {
      throw new Error(`sendVideo failed: ${JSON.stringify(sendData)}`);
    }

    console.log(`[sendVideo success] 原生小视频发送成功！to=${toUserId} msg_id=${sendData.message_id || 'ok'}`);
    return sendData;
  } catch (err) {
    console.warn(`[原生视频消息发送异常，安全降级为文件卡片发送]:`, err.message);
    return await uploadAndSendWechatFile(toUserId, contextToken, videoPath, config);
  }
}
