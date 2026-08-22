const got = require('got');
const ProxyUtil = require('../utils/ProxyUtil');
const { CacheManager } = require('./CacheManager');

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const ANILIST_CACHE_TTL = 30 * 60;
const VALID_SORTS = new Set(['TRENDING_DESC', 'POPULARITY_DESC', 'SCORE_DESC', 'START_DATE_DESC']);
const VALID_FORMATS = new Set(['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);

const MEDIA_QUERY = `
  query ($page: Int, $perPage: Int, $sort: [MediaSort], $type: MediaType, $format: MediaFormat, $season: MediaSeason, $seasonYear: Int, $genre: String, $search: String) {
    Page(page: $page, perPage: $perPage) {
      media(sort: $sort, type: $type, format: $format, season: $season, seasonYear: $seasonYear, genre: $genre, search: $search) {
        id
        type
        format
        title { romaji english native userPreferred }
        description(asHtml: false)
        startDate { year }
        averageScore
        popularity
        coverImage { large extraLarge }
        genres
      }
      pageInfo { currentPage lastPage hasNextPage total }
    }
  }
`;

function normalizeMedia(item = {}) {
    const title = item.title || {};
    return {
        id: String(item.id || ''),
        title: title.userPreferred || title.native || title.english || title.romaji || '未命名动画',
        originalTitle: title.romaji || title.english || title.native || '',
        poster: item.coverImage?.extraLarge || item.coverImage?.large || '',
        rate: item.averageScore ? (Number(item.averageScore) / 10).toFixed(1) : '',
        year: item.startDate?.year ? String(item.startDate.year) : '',
        overview: String(item.description || '').replace(/<[^>]+>/g, '').trim(),
        type: 'anime',
        source: 'anilist',
        genres: Array.isArray(item.genres) ? item.genres : [],
    };
}

class AniListService {
    constructor() {
        this.cache = new CacheManager(ANILIST_CACHE_TTL);
    }

    async _request(variables) {
        const cacheKey = JSON.stringify(variables, Object.keys(variables).sort());
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;
        const proxy = ProxyUtil.getProxyAgent('anilist');
        const response = await got.post(ANILIST_ENDPOINT, {
            json: { query: MEDIA_QUERY, variables },
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'cloud189-auto-save/1.0',
            },
            timeout: { request: 15000 },
            ...proxy,
        }).json();
        if (Array.isArray(response.errors) && response.errors.length) {
            throw new Error(response.errors[0]?.message || 'AniList 请求失败');
        }
        const page = response.data?.Page;
        const result = {
            results: (page?.media || []).map(normalizeMedia),
            pageInfo: page?.pageInfo || {},
        };
        this.cache.set(cacheKey, result);
        return result;
    }

    async list(params = {}) {
        const page = Math.min(Math.max(Number.parseInt(params.page, 10) || 1, 1), 100);
        const perPage = Math.min(Math.max(Number.parseInt(params.limit, 10) || 30, 1), 50);
        const sort = String(params.sort || 'TRENDING_DESC').toUpperCase();
        if (!VALID_SORTS.has(sort)) throw new Error('无效的 AniList 排序');
        const format = params.format ? String(params.format).toUpperCase() : undefined;
        if (format && !VALID_FORMATS.has(format)) throw new Error('无效的 AniList 类型');
        const seasonYear = params.seasonYear ? Number.parseInt(params.seasonYear, 10) : undefined;
        if (seasonYear && (seasonYear < 1900 || seasonYear > 2200)) throw new Error('无效的 AniList 年份');
        return this._request({
            page,
            perPage,
            sort: [sort],
            type: 'ANIME',
            format,
            season: params.season ? String(params.season).toUpperCase() : undefined,
            seasonYear,
            genre: params.genre ? String(params.genre).slice(0, 40) : undefined,
            search: params.search ? String(params.search).slice(0, 100) : undefined,
        });
    }
}

module.exports = { AniListService, normalizeMedia, VALID_SORTS, VALID_FORMATS };
