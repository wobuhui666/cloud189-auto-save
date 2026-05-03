const got = require('got');
const ProxyUtil = require('../utils/ProxyUtil');
const { CacheManager } = require('./CacheManager');

class DoubanService {
    constructor() {
        this.cache = new CacheManager(1800); // 30 分钟缓存
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Referer': 'https://movie.douban.com/',
            'Accept': 'application/json, text/plain, */*',
        };
    }

    /**
     * 通用请求方法
     */
    async _fetch(url, options = {}) {
        const proxy = ProxyUtil.getProxyAgent('douban');
        try {
            const response = await got(url, {
                headers: this.headers,
                timeout: { request: 10000 },
                ...proxy,
                ...options,
            });
            return JSON.parse(response.body);
        } catch (error) {
            console.error(`豆瓣请求失败 [${url}]:`, error.message);
            throw error;
        }
    }

    /**
     * 获取近期热门
     * @param {string} kind - 'movie' | 'tv'
     */
    async getRecentHot(kind = 'movie', start = 0, limit = 20) {
        const cacheKey = `douban_recent_hot_${kind}_${start}_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const category = encodeURIComponent('热门');
        const type = encodeURIComponent('全部');
        const url = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${start}&limit=${limit}&category=${category}&type=${type}`;

        const data = await this._fetch(url);
        const result = (data.items || []).map(item => ({
            id: item.id,
            title: item.title,
            poster: item.pic?.normal || item.pic?.large || '',
            rate: item.rating?.value?.toFixed(1) || '',
            year: this._extractYear(item.card_subtitle),
            type: kind === 'tv' ? 'tv' : 'movie',
            source: 'douban',
        }));

        this.cache.set(cacheKey, result);
        return result;
    }

    /**
     * 搜索（按标签）
     */
    async searchSubjects(tag, type = 'movie', start = 0, count = 20) {
        const cacheKey = `douban_search_${tag}_${type}_${start}_${count}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=${count}&page_start=${start}`;

        const data = await this._fetch(url);
        const result = (data.subjects || []).map(item => ({
            id: item.id,
            title: item.title,
            poster: item.cover || '',
            rate: item.rate || '',
            year: '',
            type: type === 'tv' ? 'tv' : 'movie',
            source: 'douban',
        }));

        this.cache.set(cacheKey, result);
        return result;
    }

    /**
     * 获取 Top250
     */
    async getTop250(page = 1) {
        const cacheKey = `douban_top250_${page}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const start = (page - 1) * 25;
        const url = `https://movie.douban.com/top250?start=${start}&filter=`;

        const proxy = ProxyUtil.getProxyAgent('douban');
        const response = await got(url, {
            headers: this.headers,
            timeout: { request: 10000 },
            ...proxy,
        });

        const html = response.body;
        const items = [];
        const regex = /<div class="item">[\s\S]*?<div class="hd">[\s\S]*?<a href="[^"]*\/subject\/(\d+)\/"[^>]*>[\s\S]*?<span class="title">([^<]+)<\/span>[\s\S]*?<div class="bd">[\s\S]*?<span class="rating_num">([^<]*)<\/span>[\s\S]*?<span>(\d{4})/g;

        let match;
        while ((match = regex.exec(html)) !== null) {
            items.push({
                id: match[1],
                title: match[2],
                poster: '',
                rate: match[3],
                year: match[4],
                type: 'movie',
                source: 'douban',
            });
        }

        this.cache.set(cacheKey, items);
        return items;
    }

    /**
     * 获取热门电影
     */
    async getHotMovies(count = 20) {
        return this.getRecentHot('movie', 0, count);
    }

    /**
     * 获取热门剧集
     */
    async getHotTVShows(count = 20) {
        return this.getRecentHot('tv', 0, count);
    }

    // === Bangumi API ===

    /**
     * 获取 Bangumi 每日放送
     */
    async getBangumiCalendar() {
        const cacheKey = 'bangumi_calendar';
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const url = 'https://api.bgm.tv/calendar';
        const proxy = ProxyUtil.getProxyAgent('bangumi');

        const response = await got(url, {
            headers: {
                'User-Agent': 'cloud189-auto-save/1.0',
            },
            timeout: { request: 10000 },
            ...proxy,
        });

        const data = JSON.parse(response.body);
        this.cache.set(cacheKey, data);
        return data;
    }

    /**
     * 获取今日放送
     */
    async getBangumiToday() {
        const calendar = await this.getBangumiCalendar();
        const today = new Date().getDay();
        const bangumiDayId = today === 0 ? 7 : today;

        const todayData = calendar.find(d => d.weekday.id === bangumiDayId);
        return (todayData?.items || []).map(item => ({
            id: String(item.id),
            title: item.name_cn || item.name,
            poster: item.images?.large || item.images?.medium || '',
            rate: item.rating?.score?.toFixed(1) || '',
            year: this._extractYear(item.air_date || item.date),
            overview: item.summary || '',
            type: 'anime',
            source: 'bangumi',
        }));
    }

    /**
     * 搜索 Bangumi
     */
    async searchBangumi(keyword) {
        const cacheKey = `bangumi_search_${keyword}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const url = `https://api.bgm.tv/search/subject/anime?keyword=${encodeURIComponent(keyword)}&limit=20`;
        const proxy = ProxyUtil.getProxyAgent('bangumi');

        const response = await got(url, {
            headers: {
                'User-Agent': 'cloud189-auto-save/1.0',
            },
            timeout: { request: 10000 },
            ...proxy,
        });

        const data = JSON.parse(response.body);
        const result = (data.data || []).map(item => ({
            id: String(item.id),
            title: item.name_cn || item.name,
            poster: item.images?.large || item.images?.medium || '',
            rate: item.rating?.score?.toFixed(1) || '',
            year: this._extractYear(item.air_date || item.date),
            overview: item.summary || '',
            type: 'anime',
            source: 'bangumi',
        }));

        this.cache.set(cacheKey, result);
        return result;
    }

    /**
     * 获取 Bangumi 动画排行榜（v0 API，按 rank 升序）
     */
    async getBangumiRanking(limit = 30) {
        const cacheKey = `bangumi_ranking_${limit}`;
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        const url = `https://api.bgm.tv/v0/subjects?type=2&sort=rank&limit=${limit}`;
        const proxy = ProxyUtil.getProxyAgent('bangumi');

        const response = await got(url, {
            headers: {
                'User-Agent': 'cloud189-auto-save/1.0',
                'Accept': 'application/json',
            },
            timeout: { request: 10000 },
            ...proxy,
        });

        const data = JSON.parse(response.body);
        const result = (data.data || [])
            .filter(item => item && (item.rating?.rank || item.rank))
            .map(item => ({
                id: String(item.id),
                title: item.name_cn || item.name,
                poster: item.images?.large || item.images?.common || item.images?.medium || '',
                rate: item.rating?.score ? Number(item.rating.score).toFixed(1) : '',
                year: this._extractYear(item.date),
                overview: item.summary || '',
                type: 'anime',
                source: 'bangumi',
            }));

        this.cache.set(cacheKey, result);
        return result;
    }

    /**
     * 按星期获取放送（沿用 calendar 数据）
     */
    async getBangumiByWeekday(weekdayId) {
        const calendar = await this.getBangumiCalendar();
        const dayData = calendar.find(d => d.weekday.id === weekdayId);
        return (dayData?.items || []).map(item => ({
            id: String(item.id),
            title: item.name_cn || item.name,
            poster: item.images?.large || item.images?.medium || '',
            rate: item.rating?.score?.toFixed(1) || '',
            year: this._extractYear(item.air_date || item.date),
            overview: item.summary || '',
            type: 'anime',
            source: 'bangumi',
        }));
    }

    // === 工具方法 ===

    _extractYear(str) {
        if (!str) return '';
        const match = str.match(/(\d{4})/);
        return match ? match[1] : '';
    }
}

module.exports = { DoubanService };
