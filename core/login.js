import crypto from 'node:crypto';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from './wechat_reply.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders() {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': '132106',
  };
}

async function getQRCode() {
  const url = 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3';
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ local_token_list: [] }),
  });
  if (!res.ok) {
    throw new Error(`获取二维码失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.ret !== 0) {
    throw new Error(`获取二维码返回异常: ${JSON.stringify(data)}`);
  }
  return data;
}

async function checkStatus(qrcode) {
  const url = `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
  });
  if (!res.ok) {
    return { status: 'wait' };
  }
  return await res.json();
}

async function main() {
  console.log('正在向腾讯微信 iLink 服务端请求绑定二维码...');
  const qrData = await getQRCode();
  const { qrcode, qrcode_img_content } = qrData;

  // 生成本地 PNG 二维码图片供用户直接扫码
  const botRoot = process.cwd();
  const qrImgPath = fs.existsSync(path.join(botRoot, 'data'))
    ? path.join(botRoot, 'data', 'qrcode.png')
    : path.join(botRoot, 'qrcode.png');
  try {
    await QRCode.toFile(qrImgPath, qrcode_img_content, { width: 400 });
    console.log(`[二维码已生成为图片]: ${qrImgPath}`);
  } catch (qrErr) {
    console.warn('[生成二维码图片异常]:', qrErr.message);
  }

  console.log('\n================== 微信扫码绑定 ==================');
  console.log('请使用已开启「ClawBot 插件」的微信扫描下方二维码：\n');
  qrcodeTerminal.generate(qrcode_img_content, { small: true });

  console.log('\n备用链接（如无法扫码，可复制至微信内直接打开）：');
  console.log(qrcode_img_content);
  console.log('\n[注意] 二维码约 5 分钟有效，正在等待手机确认授权...\n');

  const startTime = Date.now();
  const timeoutMs = 5 * 60 * 1000;
  let hasLoggedScan = false;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const statusRes = await checkStatus(qrcode);
      const status = statusRes.status;

      if (status === 'scaned' && !hasLoggedScan) {
        console.log('-> 手机微信已扫码，请在手机上点击「确认登录/授权」...');
        hasLoggedScan = true;
      } else if (status === 'confirmed') {
        console.log('\n==================================================');
        console.log('🎉 扫码授权成功！');
        console.log('用户 ID:', statusRes.ilink_user_id || '已获取');
        console.log('网关节点:', statusRes.baseurl || '默认节点');
        console.log('==================================================\n');

        saveConfig({
          bot_token: statusRes.bot_token,
          base_url: statusRes.baseurl || 'https://ilinkai.weixin.qq.com',
          authorized_user_id: statusRes.ilink_user_id || '',
          get_updates_buf: '',
          last_context_token: '',
        });

        console.log('凭证已安全保存至 config.json，正在自动重启后台服务...');
        try {
          if (fs.existsSync(path.join(botRoot, 'ecosystem.config.cjs'))) {
            execSync('pm2 startOrReload ecosystem.config.cjs && pm2 save', { stdio: 'inherit', cwd: botRoot });
            console.log('✅ 后台服务已自动热加载全新会话与凭证！');
          }
        } catch (pm2Err) {
          console.warn('[PM2 重启提示]:', pm2Err.message);
        }
        console.log('提示：绑定成功后，请先在手机微信 ClawBot 对话里发送任意一句话（例如“你好”或“1”），以激活新的上下文！');
        return;
      } else if (status === 'expired') {
        console.error('❌ 二维码已过期，请重新执行登录命令！');
        process.exit(1);
      }
    } catch (err) {
      // 网络波动重试
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.error('❌ 扫码超时（5 分钟），请重新获取二维码！');
  process.exit(1);
}

main().catch((err) => {
  console.error('发生错误:', err);
  process.exit(1);
});
