// 定时任务：每个任务到点调用 generateCopy() 生成文案，发给绑定的微信。改完执行 ./start.sh 重新加载。
//   hour / minute：北京时间；workdaysOnly：只在周一到周五发
//   memoryDigest: true：这条后面附上"记忆变动"（上次汇报以来记住、改了什么，可以回「撤销记忆 N」撤销）
import { fetchWeather } from '../../core/weather.js';
import { callAiCopy } from '../../core/ai_copy.js';
import { loadConfig } from '../../core/wechat_reply.js';

// 早间天气的城市：改成你所在城市的纬度、经度和名字
const CITY = { lat: '39.9042', lon: '116.4074', name: '北京' };

const { user_nickname: nick = '主人', bot_name: me = '小助理' } = loadConfig();

// 先让智能体写文案，写不出来（超时、出错）就从预设里挑一条
async function copy(prompt, fallbacks) {
  try {
    const text = await callAiCopy(prompt);
    if (text) return text;
  } catch {}
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

export const TASKS = [
  {
    id: 'weather_morning',
    name: '早间天气',
    hour: 8,
    minute: 30,
    workdaysOnly: false,
    memoryDigest: true,
    generateCopy: async () => {
      const weather = await fetchWeather(CITY.lat, CITY.lon, CITY.name);
      // 拿不到天气就直说，不让智能体照着空数据编
      if (!weather.success) return `🌅 ${nick}早上好！今天暂时没拿到${CITY.name}的天气数据，出门前看一眼手机天气吧～`;
      return copy(
        `你是${nick}的微信助理【${me}】，请根据实时天气写一条早上 8:30 的天气播报问候。天气数据：${weather.summary}。要求：俏皮灵动、充满元气，包含穿衣与出行建议，称呼用户为"${nick}"，60~90 字，直接输出内容。`,
        [
          `🌅 ${nick}早上好！今日天气：${weather.summary} 记得吃顿营养早餐，保持好心情出发！✨`,
          `叮咚！${me}的天气播报来啦～☀️ ${weather.summary} 愿你今天顺顺利利！🚀`,
        ],
      );
    },
  },
  {
    id: 'lunch_reminder',
    name: '工作日午餐提醒',
    hour: 11,
    minute: 30,
    workdaysOnly: true,
    generateCopy: () => copy(
      `你是${nick}的微信助理【${me}】，现在是工作日上午 11:30，提醒${nick}该准备吃午餐了。文案幽默、接地气，称呼用户为"${nick}"，40~60 字，直接输出。`,
      [
        `🍱 ${nick}，干饭时间到！上午辛苦啦，去吃顿好的犒劳一下自己吧～`,
        `🔔 午餐信号已送达！劳逸结合效率更高，${nick}快去补充能量～`,
      ],
    ),
  },
  {
    id: 'night_rest',
    name: '晚间早睡提醒',
    hour: 23,
    minute: 0,
    workdaysOnly: false,
    generateCopy: () => copy(
      `你是${nick}的微信助理【${me}】，现在是晚上 23:00，提醒${nick}早点休息。语气温柔治愈，称呼用户为"${nick}"，40~60 字，直接输出。`,
      [
        `🌙 ${nick}，夜深啦！放下手机，让眼睛和身体休息一下吧，晚安好梦～`,
        `✨ 今日电量已用完，请及时充电睡觉～祝${nick}一夜好眠，明天见！`,
      ],
    ),
  },
];
