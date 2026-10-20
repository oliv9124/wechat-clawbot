/**
 * weather.js - 通用气象数据抓取模块
 * 基于 Open-Meteo 免费气象接口，无需 API Key，毫秒级响应。
 * 拿不到或拿不全数据时如实说明，绝不编造天气。
 */

// Open-Meteo 使用的 WMO 天气代码（完整列表）
export const WMO_MAP = {
  0: '晴天 ☀️',
  1: '大部晴朗 🌤',
  2: '局部多云 ⛅',
  3: '多云阴天 ☁️',
  45: '有雾 🌫',
  48: '有雾凇 🌫',
  51: '轻微毛毛雨 🌦',
  53: '中度毛毛雨 🌦',
  55: '浓密毛毛雨 🌧',
  56: '轻微冻毛毛雨 🧊',
  57: '浓密冻毛毛雨 🧊',
  61: '小雨 🌧',
  63: '中雨 🌧',
  65: '大雨 ⛈',
  66: '轻微冻雨 🧊',
  67: '强冻雨 🧊',
  71: '小雪 ❄️',
  73: '中雪 ❄️',
  75: '大雪 ❄️',
  77: '米雪 ❄️',
  80: '阵雨 🌦',
  81: '中阵雨 🌧',
  82: '强阵雨 ⛈',
  85: '阵雪 🌨',
  86: '强阵雪 🌨',
  95: '雷暴 ⚡',
  96: '雷暴伴冰雹 ⛈',
  99: '强雷暴伴冰雹 ⛈',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 抓取指定经纬度的实时与全天天气（失败自动重试一次）。
 * 返回 { success, cityName, summary, details }；success 为 false 时 summary 只说明"暂时没拿到"。
 * @param {string|number} lat 纬度
 * @param {string|number} lon 经度
 * @param {string} cityName 城市/区域名称
 */
export async function fetchWeather(lat, lon, cityName) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FShanghai`;

  let data = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 2 && !data; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !json.current) throw new Error('返回数据里没有 current');
      data = json;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }

  if (!data) {
    console.warn(`[天气] ${cityName} 获取失败: ${lastError ? lastError.message : '未知原因'}`);
    return { success: false, cityName, summary: `暂时没拿到${cityName}的天气数据` };
  }

  const cur = data.current;
  const daily = data.daily || {};
  const code = num(cur.weather_code);
  const weatherDesc = code === null ? '天气状况未知' : WMO_MAP[code] || `天气状况未知（代码 ${code}）`;
  const temp = num(cur.temperature_2m);
  const feel = num(cur.apparent_temperature);
  const minT = num(daily.temperature_2m_min?.[0]);
  const maxT = num(daily.temperature_2m_max?.[0]);
  const rainProb = num(daily.precipitation_probability_max?.[0]);
  const humidity = num(cur.relative_humidity_2m);
  const wind = num(cur.wind_speed_10m);

  // 缺哪项就不写哪项，不再用默认值顶替
  const parts = [`${cityName}今天${weatherDesc}`];
  if (temp !== null) parts.push(`当前气温 ${Math.round(temp)}℃${feel !== null ? `（体感 ${Math.round(feel)}℃）` : ''}`);
  if (minT !== null && maxT !== null) parts.push(`全天 ${Math.round(minT)}℃~${Math.round(maxT)}℃`);
  if (humidity !== null) parts.push(`相对湿度 ${Math.round(humidity)}%`);
  if (rainProb !== null) parts.push(`降水概率 ${Math.round(rainProb)}%`);
  if (wind !== null) parts.push(`风速 ${Math.round(wind)}km/h`);

  return {
    success: true,
    cityName,
    summary: `${parts.join('，')}。`,
    details: { weatherDesc, temp, feel, minT, maxT, rainProb, humidity, wind },
  };
}
