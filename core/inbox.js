import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './wechat_reply.js';

/**
 * 收件箱：forwarder 收到消息先落盘到 pending/，routine 处理时移到 processing/，处理完删除。
 * 进程重启或崩溃都不会丢消息；processing/ 里没处理完的会在 routine 启动时放回 pending/。
 *
 *   <实例目录>/data/inbox/pending/     等待处理
 *   <实例目录>/data/inbox/processing/  正在处理
 *   <实例目录>/data/inbox/failed/      反复出错、放弃处理的消息（需要人工查看）
 */
function inboxDir(name) {
  const dir = path.join(process.cwd(), 'data', 'inbox', name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// 文件名按时间排序：<13 位毫秒时间>-<message_id>.json；同一条消息永远是同一个文件名
export function inboxFileName(task) {
  const ts = String(task.create_time_ms || Date.now()).padStart(13, '0');
  const id = String(task.message_id).replace(/[^0-9A-Za-z_-]/g, '_');
  return `${ts}-${id}.json`;
}

export function messageIdFromFileName(fileName) {
  return fileName.replace(/\.json$/, '').split('-').slice(1).join('-');
}

export function enqueueInbox(task) {
  const file = path.join(inboxDir('pending'), inboxFileName(task));
  writeJsonAtomic(file, task);
  return file;
}

export function listPending() {
  return fs.readdirSync(inboxDir('pending')).filter((f) => f.endsWith('.json')).sort();
}

// pending → processing（同一文件系统内 rename 是原子的）
export function claimInbox(fileName) {
  const to = path.join(inboxDir('processing'), fileName);
  fs.renameSync(path.join(inboxDir('pending'), fileName), to);
  return to;
}

export function finishInbox(claimedPath) {
  fs.rmSync(claimedPath, { force: true });
}

// 处理出错：放回 pending 重试，超过次数就移到 failed/
export function retryOrFailInbox(claimedPath, task, maxAttempts = 3) {
  const attempts = (task.attempts || 0) + 1;
  const fileName = path.basename(claimedPath);
  if (attempts >= maxAttempts) {
    fs.renameSync(claimedPath, path.join(inboxDir('failed'), fileName));
    return 'failed';
  }
  writeJsonAtomic(path.join(inboxDir('pending'), fileName), { ...task, attempts });
  fs.rmSync(claimedPath, { force: true });
  return 'retry';
}

// 文件本身读不出来（损坏），直接移到 failed/
export function failInbox(fileName, fromDir = 'pending') {
  fs.renameSync(path.join(inboxDir(fromDir), fileName), path.join(inboxDir('failed'), fileName));
}

// routine 启动时调用：上次没处理完的消息放回 pending/
export function requeueProcessing() {
  const processing = inboxDir('processing');
  let count = 0;
  for (const f of fs.readdirSync(processing)) {
    if (!f.endsWith('.json')) continue;
    fs.renameSync(path.join(processing, f), path.join(inboxDir('pending'), f));
    count++;
  }
  return count;
}
