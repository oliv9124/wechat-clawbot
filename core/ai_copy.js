import { execFile } from 'node:child_process';
import { loadConfig } from './wechat_reply.js';
import { agentOutcome, recordAgentResult } from './agent_health.js';

const botRoot = process.cwd();
// 文案最多等多久：一次正常调用就要 8～20 多秒，原来的 18 秒经常不够，只好退回预设文案（环境变量仅供测试）
const AI_COPY_TIMEOUT_MS = Number(process.env.AI_COPY_TIMEOUT_MS) || 90_000;

// 定时播报文案生成，供各实例 tasks.js 导入（在调度器进程里运行）。
// 单独成文件，是为了让 tasks.js 不再导入 scheduler.js 本身。
export function callAiCopy(promptText) {
  return new Promise((resolve, reject) => {
    const config = loadConfig();
    const userNickname = config.user_nickname || '主人';
    const botName = config.bot_name || '小助理';
    const forbiddenPrompt = config.forbidden_persona ? `严禁称呼用户为“${config.forbidden_persona}”。` : '';
    const personaPrefix = `【系统指令】：当前推送对象为【${userNickname}】，你的身份是专属助理【${botName}】。在文案中必须称呼用户为“${userNickname}”，语气自然亲切幽默，${forbiddenPrompt}严禁使用任何其他非指定称呼！\n\n`;
    const fullPrompt = personaPrefix + promptText;
    const args = ['--dangerously-skip-permissions', '-p', fullPrompt, '--output-format', 'json'];
    execFile(
      'agy',
      args,
      {
        cwd: botRoot,
        timeout: AI_COPY_TIMEOUT_MS,
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const outcome = agentOutcome(err, stdout, stderr);
        recordAgentResult('scheduler', outcome);
        if (!outcome.ok) {
          const reason = outcome.kind === 'timeout' ? `超过 ${Math.round(AI_COPY_TIMEOUT_MS / 1000)} 秒没完成` : outcome.reason;
          console.warn(`[AI 文案生成失败]: ${reason}，改用预设文案`);
          // 原来的 err.message 里带着整条命令行（含 prompt），这里只给原因
          return reject(new Error(`AI 文案生成失败：${reason}`));
        }
        const text = outcome.json ? String(outcome.json.response || '').trim() : String(stdout).trim();
        if (text) return resolve(text);
        reject(new Error('Empty AI response'));
      }
    );
  });
}
