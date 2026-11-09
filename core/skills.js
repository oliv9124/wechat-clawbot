/**
 * 技能商店（skills-store/）：列出、查看、安装、卸载官方技能，存技能凭证。
 *   官方技能的代码大家共用、只读；装上 = 在机器人自己的 .agents/skills/ 里放一个指向商店的链接（智能体自动认得）；
 *   凭证 = 机器人自己的 data/skills/<技能>/cookie.txt（0600，只有它自己能读）。
 * 机器人在自己的目录里运行（智能体执行命令时的工作目录就是机器人目录）：
 *   node core/skills.js list | info <名字> | install <名字> | remove <名字>
 * 管理员在服务器上替某个机器人存凭证（从标准输入读，不出现在命令行和进程列表里）：
 *   node core/skills.js set-credential <机器人目录名> <技能>  < cookie.txt
 * 用户在微信里发「设置凭证 B站 <cookie>」时，消息服务直接调这里的 saveSkillCredential，不经过智能体、不写聊天日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { insideBot } from './memory_history.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORE_DIR = process.env.CLAWBOT_SKILLS_STORE || path.join(PROJECT_DIR, 'skills-store');
const BOTS_DIR = process.env.CLAWBOT_BOTS_DIR || path.join(PROJECT_DIR, 'bots');

// 「设置凭证 <技能> <内容>」里技能的叫法
const CREDENTIAL_SKILLS = [
  { skill: 'bilibili', label: 'B站', names: /^(b站|bilibili|哔哩哔哩|b站视频)$/i },
  { skill: 'douyin', label: '抖音', names: /^(抖音|douyin)$/i },
  { skill: 'xiaohongshu', label: '小红书', names: /^(小红书|xiaohongshu|xhs)$/i },
];

export function storeSkills() {
  let names = [];
  try { names = fs.readdirSync(STORE_DIR); } catch {}
  return names.filter((n) => !/^[._]/.test(n) && fs.existsSync(path.join(STORE_DIR, n, 'skill.json'))).sort();
}

export function manifest(name) {
  try { return JSON.parse(fs.readFileSync(path.join(STORE_DIR, name, 'skill.json'), 'utf-8')); } catch { return null; }
}

const linkPath = (botRoot, name) => path.join(botRoot, '.agents', 'skills', name);
const credentialPath = (botRoot, skill) => path.join(botRoot, 'data', 'skills', skill, 'cookie.txt');

/** 装上了吗：自己的 .agents/skills/<名字> 是指向商店里这个技能的链接 */
export function isInstalled(botRoot, name) {
  try {
    const p = linkPath(botRoot, name);
    return fs.lstatSync(p).isSymbolicLink() && path.resolve(path.dirname(p), fs.readlinkSync(p)) === path.join(STORE_DIR, name);
  } catch {
    return false;
  }
}

const hasCredential = (botRoot, skill) => {
  try { return fs.statSync(credentialPath(botRoot, skill)).size > 0; } catch { return false; }
};

// 这个进程所在 cgroup（一路往上）里最小的内存上限，MB；没有上限是 Infinity
function memoryLimitMb() {
  try {
    const rel = fs.readFileSync('/proc/self/cgroup', 'utf-8').split('\n').find((l) => l.startsWith('0::'))?.slice(3).trim();
    let min = Infinity;
    for (let p = rel; p && p !== '/'; p = path.dirname(p)) {
      try {
        const v = fs.readFileSync(path.join('/sys/fs/cgroup', p, 'memory.max'), 'utf-8').trim();
        if (v !== 'max') min = Math.min(min, Number(v) / 1048576);
      } catch {}
    }
    return min;
  } catch {
    return Infinity;
  }
}

/** 这个技能还缺什么（命令、Python 包、语音模型、家目录里的程序），返回一句一句的说明 */
export function missingRequirements(m) {
  const req = m?.requires || {};
  const out = [];
  for (const cmd of req.commands || []) {
    if (spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status !== 0) out.push(`缺命令 ${cmd}`);
  }
  for (const mod of req.python || []) {
    if (spawnSync('python3', ['-c', `import ${mod}`], { stdio: 'ignore' }).status !== 0) out.push(`缺 Python 包 ${mod}`);
  }
  if (req.whisper_model) {
    const hf = process.env.HF_HOME || path.join(process.env.HOME || '/root', '.cache', 'huggingface');
    if (!fs.existsSync(path.join(hf, 'hub', `models--Systran--faster-whisper-${req.whisper_model}`))) out.push(`缺语音模型 faster-whisper-${req.whisper_model}`);
  }
  for (const bin of req.home_bin || []) {
    if (!fs.existsSync(path.join(process.env.HOME || '/root', '.local', 'bin', bin))) out.push(`缺程序 ~/.local/bin/${bin}`);
  }
  return out;
}

function botRootFrom(args) {
  const i = args.indexOf('--bot');
  const root = path.resolve(i >= 0 ? args[i + 1] : process.cwd());
  if (!fs.existsSync(path.join(root, 'config.json'))) throw new Error(`${root} 不是机器人目录（没有 config.json）。请在机器人目录里运行，或者加 --bot <机器人目录>`);
  return root;
}

function describe(botRoot, name) {
  const m = manifest(name);
  const installed = isInstalled(botRoot, name);
  const cred = m.credential ? (hasCredential(botRoot, name) ? '凭证：有' : `凭证：没有${m.credential.required ? '（必须）' : '（可选）'}`) : '不用凭证';
  return `• ${name}（${m.title}）${m.version}  ${installed ? '已装' : '没装'}  ${cred}\n  ${m.description}`;
}

function install(botRoot, name) {
  const m = manifest(name);
  if (!m) return `商店里没有「${name}」。有这些：${storeSkills().join('、')}`;
  const target = linkPath(botRoot, name);
  if (isInstalled(botRoot, name)) return `${m.title}（${name}）已经装过了。`;
  if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) {
    return `自己目录里已经有一个叫 ${name} 的技能（.agents/skills/${name}），先改名或删掉它，再装官方的。`;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(path.join(STORE_DIR, name), target);
  if (m.credential) fs.mkdirSync(path.dirname(credentialPath(botRoot, name)), { recursive: true, mode: 0o700 });
  const lines = [`已装上 ${m.title}（${name} ${m.version}），下一条消息起就能用。`];
  const missing = missingRequirements(m);
  if (missing.length) lines.push(`还缺：${missing.join('、')}。这些要管理员在服务器上装，装好之前这个技能用不了。`);
  if (m.credential && !hasCredential(botRoot, name)) {
    lines.push(`${m.credential.required ? '要先' : '可以'}设置${m.credential.label}的凭证（${m.credential.note}）：让用户在微信里发「设置凭证 ${m.credential.label} <cookie>」。`);
  }
  const limit = memoryLimitMb();
  if (m.memory_mb && m.memory_mb > limit) lines.push(`注意：这个技能大约要 ${m.memory_mb}MB 内存，这个机器人的上限是 ${Math.round(limit)}MB，可能跑不动。`);
  return lines.join('\n');
}

function remove(botRoot, name) {
  if (!isInstalled(botRoot, name)) return `${name} 没装过（或者不是商店里的官方技能，自己写的技能直接删 .agents/skills/${name} 就行）。`;
  fs.unlinkSync(linkPath(botRoot, name));
  return `已卸掉 ${manifest(name)?.title || name}（${name}）。凭证还留着，重新装上就能接着用。`;
}

/**
 * 「设置凭证 B站 <cookie>」：消息服务在写聊天日志之前调用。不是这个开头返回 null；
 * 是的话一律当指令处理（就算技能名不认识、内容不对，也不能把内容写进日志）
 */
export function parseCredentialCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('设置凭证')) return null;
  const m = t.slice(4).trim().match(/^(\S+?)\s+([\s\S]+)$/) || t.slice(4).trim().match(/^(b站|B站|抖音|小红书)([\s\S]+)$/);
  if (!m) return { skill: null, label: '', value: '' };
  const hit = CREDENTIAL_SKILLS.find((s) => s.names.test(m[1].trim()));
  return { skill: hit?.skill || null, label: hit?.label || m[1].trim().slice(0, 12), value: m[2].trim() };
}

export const credentialHelp = () => `可以设置的有：${CREDENTIAL_SKILLS.map((s) => s.label).join('、')}。格式：设置凭证 B站 <cookie>（cookie 是"名字=值; 名字=值"这样的一串，从浏览器里复制）。`;

/** 存凭证：data/skills/<技能>/cookie.txt（0600）。root 替机器人存时改成机器人自己的属主 */
export function saveSkillCredential(botRoot, { skill, value }) {
  const v = String(value || '').replace(/^cookie\s*[:：]\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!v.includes('=') || v.length < 10 || v.length > 10_000) throw new Error('看起来不像 cookie（应该是"名字=值; 名字=值"这样的一串）');
  const file = credentialPath(botRoot, skill);
  if (!insideBot(botRoot, file)) throw new Error('凭证目录不对（路径经过软链接）');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.cookie.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${v}\n`, { mode: 0o600 });
  if (process.getuid?.() === 0) {
    const owner = fs.statSync(path.join(botRoot, 'data'));
    for (const d of [path.dirname(dir), dir]) fs.chownSync(d, owner.uid, owner.gid);
    fs.chownSync(tmp, owner.uid, owner.gid);
  }
  fs.chmodSync(dir, 0o700);
  fs.renameSync(tmp, file);
}

function main(argv) {
  const [cmd, name, extra] = argv;
  if (cmd === 'list') {
    const botRoot = botRootFrom(argv);
    const names = storeSkills();
    console.log(names.length ? `官方技能（${names.length} 个）：\n${names.map((n) => describe(botRoot, n)).join('\n')}` : '商店里还没有技能。');
  } else if (cmd === 'info' && name) {
    const m = manifest(name);
    if (!m) throw new Error(`商店里没有「${name}」。有这些：${storeSkills().join('、')}`);
    const botRoot = botRootFrom(argv);
    const missing = missingRequirements(m);
    console.log([describe(botRoot, name), `  需要：${missing.length ? missing.join('、') : '都齐了'}`, `  内存：大约 ${m.memory_mb || '?'}MB；沙箱里能用：${m.sandbox ? '能' : '不能'}`,
      `  用法看：${path.join(STORE_DIR, name, 'SKILL.md')}`].join('\n'));
  } else if (cmd === 'install' && name) {
    console.log(install(botRootFrom(argv), name));
  } else if (cmd === 'remove' && name) {
    console.log(remove(botRootFrom(argv), name));
  } else if (cmd === 'set-credential' && name && extra) {
    if (!CREDENTIAL_SKILLS.some((s) => s.skill === extra)) throw new Error(`不认识技能 ${extra}（${CREDENTIAL_SKILLS.map((s) => s.skill).join('、')}）`);
    const botRoot = path.join(BOTS_DIR, name);
    if (!fs.existsSync(path.join(botRoot, 'config.json'))) throw new Error(`没有机器人 ${name}`);
    saveSkillCredential(botRoot, { skill: extra, value: fs.readFileSync(0, 'utf-8') });
    console.log(`已给 ${name} 存好 ${extra} 的凭证（${credentialPath(botRoot, extra)}，0600）`);
  } else {
    console.log('用法：node core/skills.js list | info <名字> | install <名字> | remove <名字>（在机器人目录里运行，或加 --bot <目录>）\n'
      + '      node core/skills.js set-credential <机器人目录名> <技能>  < 凭证文件（管理员用）');
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
