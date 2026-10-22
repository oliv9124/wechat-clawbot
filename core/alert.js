import path from 'node:path';
import { writeJsonAtomic } from './wechat_reply.js';

/**
 * 记录一条告警事件到 <实例目录>/data/alerts/，由 clawbot-monitor 统一去重、发送（微信 + 邮件）。
 * 沙箱里的实例也能写自己的 data/ 目录。只写问题类型和简短原因，不写任何消息内容。
 *   kind: credential_expired / credential_ok / task_failed / reminder_failed /
 *         memory_consolidation_failed / message_failed / reply_failed
 */
export function raiseAlert(kind, detail = '') {
  try {
    const file = path.join(process.cwd(), 'data', 'alerts', `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeJsonAtomic(file, { kind, detail: String(detail).slice(0, 300), at: Date.now() });
    console.log(`[告警事件] 已记录: ${kind}`);
  } catch (err) {
    console.error('[告警] 写入告警事件失败:', err.message);
  }
}
