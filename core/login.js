import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigPath, getRuntimeStatePath, saveConfig, saveRuntimeState } from './wechat_reply.js';

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
        });
        // 新凭证对应新的同步进度和上下文，清空 forwarder 的运行时状态
        saveRuntimeState('forwarder', { get_updates_buf: '', last_context_token: '' });
        if (!statusRes.ilink_user_id) {
          console.warn('⚠️ 扫码结果里没有用户 ID：机器人会拒收所有消息，请重新扫码绑定。');
        }

        // 以 root 运行时，把配置和状态文件交还给实例目录的运行账号（受限账号要能读配置、能写状态）
        const dataDir = path.join(botRoot, 'data');
        if (process.getuid && process.getuid() === 0 && fs.existsSync(dataDir)) {
          const owner = fs.statSync(dataDir);
          fs.chownSync(getConfigPath(), 0, owner.gid);
          fs.chmodSync(getConfigPath(), 0o640);
          fs.chownSync(getRuntimeStatePath('forwarder'), owner.uid, owner.gid);
        }

        // 让新凭证生效：systemd 托管的重启 3 个服务，PM2 托管的重启 3 个进程，还没启动过就提示怎么启动
        const bot = path.basename(botRoot);
        const units = ['routine', 'forwarder', 'scheduler'].map((s) => `clawbot-${s}@${bot}`);
        const pm2Apps = ['routine', 'forwarder', 'scheduler'].map((s) => `${bot}-${s}`);
        console.log('凭证已安全保存至 config.json。');
        if (systemdManaged(units[0])) {
          try {
            execFileSync('systemctl', ['restart', ...units], { stdio: 'inherit' });
            console.log('✅ 后台服务已重启，新凭证已生效！');
          } catch {
            console.warn(`[重启提示] 自动重启失败，请手动执行: systemctl restart ${units.join(' ')}`);
          }
        } else if (pm2Has(pm2Apps[0])) {
          try {
            execFileSync('pm2', ['restart', ...pm2Apps], { stdio: 'inherit' });
            console.log('✅ PM2 进程已重启，新凭证已生效！');
          } catch {
            console.warn(`[重启提示] 自动重启失败，请手动执行: pm2 restart ${pm2Apps.join(' ')}`);
          }
        } else {
          console.log('下一步：在本目录执行 ./start.sh 启动机器人。');
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

// 这个机器人用 systemd 托管：服务在运行或已启用（只装了服务模板、实际用 PM2 的不算）
function systemdManaged(unit) {
  try {
    const out = execFileSync('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'UnitFileState'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const kv = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return kv.LoadState === 'loaded' && (kv.ActiveState !== 'inactive' || (kv.UnitFileState || '').startsWith('enabled'));
  } catch {
    return false;
  }
}

function pm2Has(name) {
  try {
    return JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })).some((p) => p.name === name);
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error('发生错误:', err);
  process.exit(1);
});
