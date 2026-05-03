// 豆瓣 API 客户端 - 支持 CORS 代理和后端代理双轨模式

interface DoubanItem {
  id: string;
  title: string;
  poster: string;
  rate: string;
  year: string;
  source: 'douban';
  type: 'movie' | 'tv';
}

interface DoubanSearchResult {
  rate: string;
  cover_xl: string;
  cover: string;
  is_new: boolean;
  url: string;
  playable: boolean;
  cover_url: string;
  id: string;
  title: string;
}

interface DoubanCategoryItem {
  id: string;
  title: string;
  pic: {
    large: string;
    normal: string;
  };
  rating: {
    count: number;
    max: number;
    star_count: number;
    value: number;
  };
  card_subtitle: string;
}

// 代理模式配置
type ProxyMode = 'cors' | 'backend';

const CORS_PROXY = 'https://cors.jsdelivr.fyi/?proxy_url=';
const DEFAULT_HEADERS = {
  'Referer': 'https://movie.douban.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
};

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

// 获取代理模式
function getProxyMode(): ProxyMode {
  const saved = localStorage.getItem('doubanProxyMode');
  return saved === 'backend' ? 'backend' : 'cors';
}

// 通用请求函数
async function fetchDoubanAPI<T>(url: string, cacheKey: string): Promise<T> {
  const cached = getCached<T>(cacheKey);
  if (cached) return cached;

  const mode = getProxyMode();
  let fetchUrl: string;
  let options: RequestInit = {};

  if (mode === 'cors') {
    fetchUrl = CORS_PROXY + encodeURIComponent(url);
    options = { headers: DEFAULT_HEADERS };
  } else {
    // 后端代理模式：将 URL 作为参数传递
    fetchUrl = `/api/douban/proxy?url=${encodeURIComponent(url)}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(fetchUrl, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// 将豆瓣数据转换为统一格式
function normalizeSearchItem(item: DoubanSearchResult, type: 'movie' | 'tv' = 'movie'): DoubanItem {
  return {
    id: item.id,
    title: item.title,
    poster: item.cover || item.cover_xl || '',
    rate: item.rate || '',
    year: '',
    source: 'douban',
    type,
  };
}

function normalizeCategoryItem(item: DoubanCategoryItem, type: 'movie' | 'tv' = 'movie'): DoubanItem {
  const yearMatch = item.card_subtitle?.match(/(\d{4})/);
  return {
    id: item.id,
    title: item.title,
    poster: item.pic?.normal || item.pic?.large || '',
    rate: item.rating?.value?.toFixed(1) || '',
    year: yearMatch ? yearMatch[1] : '',
    source: 'douban',
    type,
  };
}

// === 公开 API ===

/**
 * 获取热门电影
 */
export async function getDoubanHotMovies(start = 0, count = 40): Promise<DoubanItem[]> {
  const cacheKey = `douban_hot_movies_${start}_${count}`;
  const cached = getCached<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  // 优先走后端代理（已 normalize，含 source/type，规避 CORS 与防盗链问题）
  try {
    const r = await fetch(`/api/douban/recent_hot/movie?start=${start}&limit=${count}`);
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items = json.data.map((it: any): DoubanItem => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          source: 'douban',
          type: 'movie',
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('豆瓣热门电影后端代理失败，回退到 CORS 代理:', e);
  }

  // 回退：CORS 代理直连豆瓣
  const url = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/movie?start=${start}&limit=${count}&category=%E7%83%AD%E9%97%A8&type=%E5%85%A8%E9%83%A8`;
  try {
    const data = await fetchDoubanAPI<{ items: DoubanCategoryItem[] }>(url, cacheKey);
    return (data.items || []).map((item) => normalizeCategoryItem(item, 'movie'));
  } catch (error) {
    console.error('获取豆瓣热门电影失败:', error);
    return [];
  }
}

/**
 * 获取热门剧集
 */
export async function getDoubanHotTV(start = 0, count = 40): Promise<DoubanItem[]> {
  const cacheKey = `douban_hot_tv_${start}_${count}`;
  const cached = getCached<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const r = await fetch(`/api/douban/recent_hot/tv?start=${start}&limit=${count}`);
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items = json.data.map((it: any): DoubanItem => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          source: 'douban',
          type: 'tv',
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('豆瓣热门剧集后端代理失败，回退到 CORS 代理:', e);
  }

  const url = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/tv?start=${start}&limit=${count}&category=%E7%83%AD%E9%97%A8&type=%E5%85%A8%E9%83%A8`;
  try {
    const data = await fetchDoubanAPI<{ items: DoubanCategoryItem[] }>(url, cacheKey);
    return (data.items || []).map((item) => normalizeCategoryItem(item, 'tv'));
  } catch (error) {
    console.error('获取豆瓣热门剧集失败:', error);
    return [];
  }
}

/**
 * 搜索豆瓣（按标签）
 */
export async function searchDouban(
  tag: string,
  type: 'movie' | 'tv' = 'movie',
  start = 0,
  count = 40
): Promise<DoubanItem[]> {
  const cacheKey = `douban_search_${tag}_${type}_${start}_${count}`;
  const cached = getCached<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  try {
    const r = await fetch(
      `/api/douban/search?tag=${encodeURIComponent(tag)}&type=${type}&start=${start}&count=${count}`
    );
    if (r.ok) {
      const json = await r.json();
      if (json?.success && Array.isArray(json.data)) {
        const items = json.data.map((it: any): DoubanItem => ({
          id: String(it.id),
          title: it.title || '',
          poster: it.poster || '',
          rate: it.rate || '',
          year: it.year || '',
          source: 'douban',
          type,
        }));
        setCache(cacheKey, items);
        return items;
      }
    }
  } catch (e) {
    console.warn('豆瓣搜索后端代理失败，回退到 CORS 代理:', e);
  }

  const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=${count}&page_start=${start}`;
  try {
    const data = await fetchDoubanAPI<{ subjects: DoubanSearchResult[] }>(url, cacheKey);
    return (data.subjects || []).map((item) => normalizeSearchItem(item, type));
  } catch (error) {
    console.error('豆瓣搜索失败:', error);
    return [];
  }
}

/**
 * 获取豆瓣 Top250
 */
export async function getDoubanTop250(start = 0, count = 25): Promise<DoubanItem[]> {
  const page = Math.floor(start / 25) + 1;
  const url = `https://movie.douban.com/top250?start=${(page - 1) * 25}&filter=`;
  const cacheKey = `douban_top250_${page}`;

  try {
    const mode = getProxyMode();
    let html: string;

    if (mode === 'cors') {
      const fetchUrl = CORS_PROXY + encodeURIComponent(url);
      const response = await fetch(fetchUrl, { headers: DEFAULT_HEADERS });
      html = await response.text();
    } else {
      const response = await fetch(`/api/douban/top250?page=${page}`);
      const data = await response.json();
      return data.data || [];
    }

    // 解析 HTML 提取电影信息
    const items: DoubanItem[] = [];
    const itemRegex = /<div class="item">[\s\S]*?<div class="hd">[\s\S]*?<a href="[^"]*\/subject\/(\d+)\/"[^>]*>[\s\S]*?<span class="title">([^<]+)<\/span>[\s\S]*?<div class="bd">[\s\S]*?<span class="rating_num">([^<]*)<\/span>[\s\S]*?<span>(\d{4})/g;

    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      items.push({
        id: match[1],
        title: match[2],
        poster: '',
        rate: match[3],
        year: match[4],
        source: 'douban',
        type: 'movie',
      });
    }

    setCache(cacheKey, items);
    return items.slice(start % 25, (start % 25) + count);
  } catch (error) {
    console.error('获取豆瓣 Top250 失败:', error);
    return [];
  }
}

/**
 * 清除缓存
 */
export function clearDoubanCache(): void {
  cache.clear();
}
