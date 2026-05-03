// Bangumi 番组计划 API 客户端

interface BangumiImage {
  large?: string;
  medium?: string;
  common?: string;
  small?: string;
  grid?: string;
}

interface BangumiRating {
  total: number;
  count: number;
  score: number;
}

interface BangumiCalendarItem {
  id: number;
  name: string;
  name_cn: string;
  summary: string;
  images?: BangumiImage;
  rating?: BangumiRating;
  date?: string;
  air_date?: string;
  eps?: number;
  url: string;
}

interface BangumiCalendarDay {
  weekday: {
    en: string;
    cn: string;
    ja: string;
    id: number;
  };
  items: BangumiCalendarItem[];
}

export interface BangumiItem {
  id: string;
  title: string;
  poster: string;
  rate: string;
  year: string;
  overview?: string;
  source: 'bangumi';
  type: 'anime';
}

// 内存缓存
const cache = new Map<string, { data: unknown; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data as T;
  }
  cache.delete(key);
  return null;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// 获取图片 URL
function getImageUrl(images?: BangumiImage): string {
  if (!images) return '';
  return images.large || images.medium || images.common || images.small || images.grid || '';
}

// 将年份从日期中提取
function extractYear(dateStr?: string): string {
  if (!dateStr) return '';
  const match = dateStr.match(/(\d{4})/);
  return match ? match[1] : '';
}

// 标准化数据
function normalizeCalendarItem(item: BangumiCalendarItem): BangumiItem {
  return {
    id: String(item.id),
    title: item.name_cn || item.name,
    poster: getImageUrl(item.images),
    rate: item.rating?.score?.toFixed(1) || '',
    year: extractYear(item.air_date || item.date),
    overview: item.summary || '',
    source: 'bangumi',
    type: 'anime',
  };
}

/**
 * 获取每日放送日历
 */
export async function getBangumiCalendar(): Promise<BangumiCalendarDay[]> {
  const cacheKey = 'bangumi_calendar';
  const cached = getCached<BangumiCalendarDay[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch('https://api.bgm.tv/calendar', {
      headers: {
        'User-Agent': 'cloud189-auto-save/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    return data;
  } catch (error) {
    console.error('获取 Bangumi 日历失败:', error);
    return [];
  }
}

/**
 * 获取今日放送
 */
export async function getBangumiToday(): Promise<BangumiItem[]> {
  const cacheKey = 'bangumi_today';
  const cached = getCached<BangumiItem[]>(cacheKey);
  if (cached) return cached;

  // 优先走后端代理（codespace 等出网受限环境无法直连 bgm.tv）
  try {
    const r = await fetch('/api/bangumi/today');
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items: BangumiItem[] = json.data.map((it: any) => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          overview: it.overview || '',
          source: 'bangumi',
          type: 'anime',
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('后端 bangumi 代理失败，回退直连:', e);
  }

  // 回退：直连 bgm.tv
  try {
    const calendar = await getBangumiCalendar();
    const today = new Date().getDay();
    const bangumiDayId = today === 0 ? 7 : today;
    const todayData = calendar.find((d) => d.weekday.id === bangumiDayId);
    const items = todayData?.items.map(normalizeCalendarItem) || [];
    setCache(cacheKey, items);
    return items;
  } catch (error) {
    console.error('获取今日放送失败:', error);
    return [];
  }
}

/**
 * 按星期获取放送
 */
export async function getBangumiByWeekday(weekdayId: number): Promise<BangumiItem[]> {
  const cacheKey = `bangumi_weekday_${weekdayId}`;
  const cached = getCached<BangumiItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const r = await fetch(`/api/bangumi/weekday/${weekdayId}`);
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items: BangumiItem[] = json.data.map((it: any) => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          overview: it.overview || '',
          source: 'bangumi',
          type: 'anime',
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('后端 bangumi 代理失败，回退直连:', e);
  }

  try {
    const calendar = await getBangumiCalendar();
    const dayData = calendar.find((d) => d.weekday.id === weekdayId);
    const items = dayData?.items.map(normalizeCalendarItem) || [];
    setCache(cacheKey, items);
    return items;
  } catch (error) {
    console.error('获取放送失败:', error);
    return [];
  }
}

/**
 * 获取动画排行榜（按 rank 升序）
 */
export async function getBangumiRanking(limit = 30): Promise<BangumiItem[]> {
  const cacheKey = `bangumi_ranking_${limit}`;
  const cached = getCached<BangumiItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const r = await fetch(`/api/bangumi/ranking?limit=${limit}`);
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items: BangumiItem[] = json.data.map((it: any) => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          overview: it.overview || '',
          source: 'bangumi',
          type: 'anime',
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('后端 bangumi ranking 失败，回退直连:', e);
  }

  // 回退：直连
  try {
    const response = await fetch(
      `https://api.bgm.tv/v0/subjects?type=2&sort=rank&limit=${limit}`,
      {
        headers: {
          'User-Agent': 'cloud189-auto-save/1.0',
          Accept: 'application/json',
        },
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const items: BangumiItem[] = (data.data || [])
      .filter((item: any) => item && (item.rank ?? item.rating?.rank))
      .map((item: any) => ({
        id: String(item.id),
        title: item.name_cn || item.name,
        poster: item.images?.large || item.images?.common || item.images?.medium || '',
        rate: item.rating?.score ? Number(item.rating.score).toFixed(1) : '',
        year: extractYear(item.date),
        overview: item.summary || '',
        source: 'bangumi',
        type: 'anime',
      }));
    setCache(cacheKey, items);
    return items;
  } catch (error) {
    console.error('获取 Bangumi 排行榜失败:', error);
    return [];
  }
}

/**
 * 搜索 Bangumi
 */
export async function searchBangumi(keyword: string): Promise<BangumiItem[]> {
  const cacheKey = `bangumi_search_${keyword}`;
  const cached = getCached<BangumiItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(
      `https://api.bgm.tv/search/subject/anime?keyword=${encodeURIComponent(keyword)}&limit=20`,
      {
        headers: {
          'User-Agent': 'cloud189-auto-save/1.0',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = (data.data || []).map((item: BangumiCalendarItem) => normalizeCalendarItem(item));

    setCache(cacheKey, items);
    return items;
  } catch (error) {
    console.error('Bangumi 搜索失败:', error);
    return [];
  }
}

/**
 * 清除缓存
 */
export function clearBangumiCache(): void {
  cache.clear();
}
