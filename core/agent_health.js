import { loadRuntimeState, saveRuntimeState } from './wechat_reply.js';

/**
 * 智能体（agy）调用结果：判断每次调用成功还是失败、失败属于哪一类，并记下来，供 clawbot-monitor 告警。
 * 每个进程写自己的文件：data/state/agent_routine.json、data/state/agent_scheduler.json。
 * 只记时间、类型和一句简短的原因，不记 prompt、消息或回复内容。
 */

// agy 登录失效时不会马上报错：它打印 Google 登录链接，等 60 秒授权，然后以退出码 1 结束，
// 输出里 status 为 ERROR、error 为 "authentication failed or timed out"
const AUTH_PATTERN = /Waiting for authentication|authentication (failed|timed out|interrupted)|paste the authorization code|accounts\.google\.com\/o\/oauth2/i;

/**
 * 判断一次 agy 调用的结果（参数就是 execFile 回调的 error、stdout、stderr）。
 * 返回 { ok, kind: 'auth' | 'timeout' | 'error', reason, json, warning }；json 是解析出来的输出（不是 JSON 时为 null）。
 */
export function agentOutcome(error, stdout, stderr) {
  let json = null;
  try { json = JSON.parse(String(stdout || '').trim()); } catch {}
  if (!error && json?.status !== 'ERROR') return { ok: true, json };
  // 退出码 0、状态 ERROR，但已经给出了回复：照常用这条回复，只把提示记下来。
  // 例如会话里之前有一条回复被 Google 内容安全过滤拦过，之后这个会话每次都会带着"blocked by content safety filters"
  if (!error && String(json?.response || '').trim() && !AUTH_PATTERN.test(String(json?.error || ''))) {
    return { ok: true, json, warning: String(json.error || '状态 ERROR').split('\n')[0].slice(0, 120) };
  }
  if (AUTH_PATTERN.test(`${stderr || ''}\n${json?.error || ''}`)) {
    return { ok: false, kind: 'auth', reason: 'agy 在等 Google 重新授权（登录失效）', json };
  }
  if (error && (error.killed || error.signal === 'SIGTERM')) return { ok: false, kind: 'timeout', reason: '超时没有完成', json };
  const last = String(json?.error || stderr || '').trim().split('\n').filter(Boolean).pop() || '';
  const code = error ? `退出码 ${error.code ?? error.signal ?? '未知'}` : '返回状态 ERROR';
  return { ok: false, kind: 'error', reason: `${code}${last ? `：${last.slice(0, 100)}` : ''}`, json };
}

// proc：'routine' 或 'scheduler'，各写各的文件，两个进程不会互相覆盖
export function recordAgentResult(proc, outcome) {
  try {
    const name = `agent_${proc}`;
    const now = Date.now();
    if (outcome.ok) {
      saveRuntimeState(name, { last_ok_at: now, fail_streak: 0 });
      return;
    }
    saveRuntimeState(name, {
      last_fail_at: now,
      fail_streak: (loadRuntimeState(name).fail_streak || 0) + 1,
      last_error_kind: outcome.kind,
      last_error: outcome.reason,
      ...(outcome.kind === 'auth' ? { auth_failed_at: now } : {}),
    });
  } catch (e) {
    console.error('[记录智能体调用结果失败]:', e.message);
  }
}
