import { fetchWeather } from '../../core/weather.js';
import { callAiCopy } from '../../core/scheduler.js';
import { stripMarkdown } from '../../core/wechat_reply.js';

export const TASKS = [
  {
    id: 'weather_morning',
    name: '早间天气播报',
    hour: 8,
    minute: 30,
    workdaysOnly: false,
    generateCopy: async () => {
      // 默认城市：北京 (经纬度: 39.9042, 116.4074)。可根据需要自由修改城市与经纬度。
      const weather = await fetchWeather('39.9042', '116.4074', '北京');
      const prompt = `你是微信专属助理，请根据实时天气给主人写一条早上8:30的天气播报问候。天气数据：${weather.summary}。要求：俏皮灵动、充满元气，包含穿衣与出行建议，60~90字，直接输出内容。`;
      try {
        const aiText = await callAiCopy(prompt);
        if (aiText) return stripMarkdown(aiText);
      } catch (e) {
        console.warn('[AI文案生成超时，使用精选预设]');
      }
      const fallbacks = [
        `🌅 早上好！今日天气播报：${weather.summary} 新的一天元气开启，记得吃顿营养早餐，保持好心情出发！✨`,
        `叮咚！天气管家已上线～☀️ ${weather.summary} 愿你今天工作顺利，事事舒心，幸运值拉满！🚀`,
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    },
  },
  {
    id: 'lunch_reminder',
    name: '工作日午餐提醒',
    hour: 11,
    minute: 30,
    workdaysOnly: true, // 仅周一至周五触发
    generateCopy: async () => {
      const prompt = `你是微信专属助理，现在是工作日上午11:30，提醒主人该准备吃午餐了。文案幽默、干饭人风格、接地气，40~60字，直接输出。`;
      try {
        const aiText = await callAiCopy(prompt);
        if (aiText) return stripMarkdown(aiText);
      } catch (e) {}
      const fallbacks = [
        '🍱 干饭时间到！上午辛苦啦，赶紧放下手中的工作，去吃顿美味的午餐犒劳一下自己吧！🥢😋',
        '🔔 叮咚！午餐信号已送达！劳逸结合效率更高，快去享受今天的美食能量补充～🍲✨',
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    },
  },
  {
    id: 'night_rest',
    name: '晚间早睡关怀',
    hour: 23,
    minute: 0,
    workdaysOnly: false,
    generateCopy: async () => {
      const prompt = `你是微信专属助理，现在是深夜23:00，提醒主人该准备早点休息了。语气温柔贴心治愈，40~60字，直接输出。`;
      try {
        const aiText = await callAiCopy(prompt);
        if (aiText) return stripMarkdown(aiText);
      } catch (e) {}
      const fallbacks = [
        '🌙 夜深啦！今天辛苦了一整天，放下手机，给眼睛和身体放个假吧，晚安好梦～😴🛌',
        '✨ 叮咚！今日电量已消耗完毕，请及时回充睡眠能源～祝你今晚一夜好眠，明天见！💤🌟',
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    },
  },
];
