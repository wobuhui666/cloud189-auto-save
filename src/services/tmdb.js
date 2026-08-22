const got = require('got');
const ConfigService = require('./ConfigService');
const ProxyUtil = require('../utils/ProxyUtil');
const { getTmdbCacheRepository } = require('../database');

const TMDB_CACHE_TTL = {
    SEARCH: 6 * 60 * 60 * 1000,
    LIST: 2 * 60 * 60 * 1000,
    DETAILS: 7 * 24 * 60 * 60 * 1000,
    DEFAULT: 12 * 60 * 60 * 1000
};

const STREAMING_PROVIDERS = Object.freeze({
    netflix: { label: 'Netflix', id: '8' },
    hbo: { label: 'HBO', id: '118|1899' },
    apple: { label: 'Apple TV+', id: '350' },
    disney: { label: 'Disney+', id: '337' },
    crunchyroll: { label: 'Crunchyroll', id: '283' },
    prime: { label: 'Amazon Prime', id: '9' },
    amazon: { label: 'Amazon', id: '10' },
    hulu: { label: 'Hulu', id: '15' },
});

function normalizeMediaTitle(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function getMediaYear(media = {}) {
    const date = media.release_date || media.first_air_date || media.releaseDate || '';
    const matched = String(date).match(/^(\d{4})/);
    return matched ? Number(matched[1]) : null;
}

function scoreSearchResult(media, title, year = '') {
    const query = normalizeMediaTitle(title);
    const localizedTitle = normalizeMediaTitle(media.title || media.name);
    const originalTitle = normalizeMediaTitle(media.original_title || media.original_name);
    let score = 0;

    if (query && (localizedTitle === query || originalTitle === query)) {
        score += 1000;
    } else if (query && (localizedTitle.startsWith(query) || originalTitle.startsWith(query))) {
        // A sequel or spin-off must not outrank an exact title match.
        score += 100;
    } else if (query && (localizedTitle.includes(query) || originalTitle.includes(query))) {
        score += 50;
    }

    const expectedYear = Number(year);
    const mediaYear = getMediaYear(media);
    if (Number.isInteger(expectedYear) && expectedYear > 0) {
        score += mediaYear
            ? (mediaYear === expectedYear ? 200 : -Math.min(Math.abs(mediaYear - expectedYear), 50))
            : -100;
    }

    return score;
}

function rankSearchResults(results = [], title, year = '') {
    return results
        .map((media, index) => ({ media, index, score: scoreSearchResult(media, title, year) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
}

class TMDBService {
    constructor() {
        this.apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        this.baseURL = 'https://api.themoviedb.org/3';
        this.language = 'zh-CN';
    }

    async _request(endpoint, params = {}) {
        const cacheParams = {
            language: params.language ?? this.language,
            ...params
        };
        const cacheKey = this._buildCacheKey(endpoint, cacheParams);
        const cachedResponse = await this._getCachedResponse(cacheKey);
        if (cachedResponse) {
            return cachedResponse;
        }
        const proxy = ProxyUtil.getProxyAgent('tmdb');
        try {
            // DNS解析开始
            const response = await got(`${this.baseURL}${endpoint}`, {
                searchParams:{
                    api_key: this.apiKey,
                    language: this.language,
                    ...params
                },
                ...proxy
            }).json();
            await this._saveCachedResponse(cacheKey, endpoint, response);
            return response;
        } catch (error) {
            console.error(`TMDB请求失败 [${endpoint}]:`, {
                message: error.message
            });
            throw error;
        }
    }

    _buildCacheKey(endpoint, params = {}) {
        return `${endpoint}:${this._stableStringify(params)}`;
    }

    _stableStringify(value) {
        if (Array.isArray(value)) {
            return `[${value.map(item => this._stableStringify(item)).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this._stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    _getCacheCategory(endpoint) {
        if (/^\/(movie|tv)\/\d+/.test(endpoint) || /\/images$/.test(endpoint)) {
            return 'details';
        }
        if (endpoint.startsWith('/search/')) {
            return 'search';
        }
        if (endpoint.includes('/trending') || endpoint.includes('/discover') || endpoint.includes('/top_rated')) {
            return 'list';
        }
        return 'default';
    }

    _getCacheTtlMs(endpoint) {
        const category = this._getCacheCategory(endpoint);
        if (category === 'details') return TMDB_CACHE_TTL.DETAILS;
        if (category === 'search') return TMDB_CACHE_TTL.SEARCH;
        if (category === 'list') return TMDB_CACHE_TTL.LIST;
        return TMDB_CACHE_TTL.DEFAULT;
    }

    async _getCachedResponse(cacheKey) {
        try {
            const repo = getTmdbCacheRepository();
            const cached = await repo.findOneBy({ cacheKey });
            if (!cached) {
                return null;
            }
            if (cached.expiresAt && new Date(cached.expiresAt).getTime() <= Date.now()) {
                await repo.delete({ id: cached.id });
                return null;
            }
            return JSON.parse(cached.content);
        } catch (error) {
            return null;
        }
    }

    async _saveCachedResponse(cacheKey, endpoint, response) {
        try {
            const repo = getTmdbCacheRepository();
            const existing = await repo.findOneBy({ cacheKey });
            const category = this._getCacheCategory(endpoint);
            const payload = {
                ...(existing || {}),
                cacheKey,
                category,
                content: JSON.stringify(response),
                expiresAt: new Date(Date.now() + this._getCacheTtlMs(endpoint))
            };
            await repo.save(existing ? payload : repo.create(payload));
        } catch (error) {
            // 缓存失败不影响 TMDB 主流程
        }
    }
    
    async search(title, year = '') {
        try {
            console.log(`TMDB搜索：${title}，年份：${year}`);
            const response = await this._request('/search/multi', {
                query: title,
                year: year
            });

            console.log(`TMDB搜索结果数量：${response.results.length}`);
            
            // 分离电影和电视剧结果
            const movies = response.results
                .filter(item => item.media_type === 'movie')
                .map(item => ({
                    id: item.id,
                    title: item.title,
                    originalTitle: item.original_title,
                    overview: item.overview,
                    releaseDate: item.release_date,
                    posterPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : '',
                    voteAverage: item.vote_average,
                    type: 'movie'
                }));

            const tvShows = response.results
                .filter(item => item.media_type === 'tv')
                .map(item => ({
                    id: item.id,
                    title: item.name,
                    originalTitle: item.original_name,
                    overview: item.overview,
                    releaseDate: item.first_air_date,
                    posterPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : '',
                    voteAverage: item.vote_average,
                    type: 'tv'
                }));

            return {
                movies: movies.slice(0, 5),
                tvShows: tvShows.slice(0, 5)
            };
        } catch (error) {
            throw new Error(`TMDB搜索失败: ${error.message}`);
        }
    }

    async searchMovie(title, year = '') {
        try {
            const movies = await this._searchMedia('movie', title, year, 1);
            return movies;
        } catch (error) {
            throw new Error(`TMDB电影搜索失败: ${error.message}`);
        }
    }

    async searchTV(title, year = '', currentEpisodes) {
        try {
            const tvShows = await this._searchMedia('tv', title, year, currentEpisodes);
            return tvShows;
        } catch (error) {
            throw new Error(`TMDB电视剧搜索失败: ${error.message}`);
        }
    }

    async _searchMedia(type, title, year, currentEpisodes = 0) {
        console.log(`TMDB搜索${type}：${title}，年份：${year}，已有集数：${currentEpisodes}`);
        // 发起搜索请求
        const response = await this._request(`/search/${type}`, {
            query: title,
            year: year
        });
        
        const count = response.results.length;
        console.log(`TMDB搜索${type}结果数量：${count}`);
        if (!count) {
            return  null;
        }

        // TMDB 默认按相关度返回。先按标题和年份重排，避免旧作品被较新的衍生作挤出候选集。
        const rankedResults = rankSearchResults(response.results, title, year);
        const candidates = rankedResults.slice(0, 10);

        const detailPromises = candidates.map(async ({ media }) => {
            if (type === 'tv') {
                return await this.getTVDetails(media.id);
            }
            return await this.getMovieDetails(media.id);
        });

        const details = await Promise.all(detailPromises);
        
        // 分析最匹配的结果
        const bestMatch = details.reduce((best, current, index) => {
            if (!current) return best;
            let score = candidates[index]?.score || 0;
            
            // 3. TV剧集特殊处理
            if (type === 'tv' && currentEpisodes > 0) {
                // 如果是连载中的剧集，且已有集数小于总集数，优先级更高
                if (current.status === 'Returning Series' && currentEpisodes <= current.lastEpisodeToAir.episode_number) {
                    score += 5;
                }
                // 如果已完结，且已有集数接近或等于总集数
                if (current.status === 'Ended' && Math.abs(current.lastEpisodeToAir.episode_number - currentEpisodes) <= 2) {
                    score += 5;
                }
                // 如果已有集数大于总集数，降低优先级
                if (currentEpisodes > current.lastEpisodeToAir.episode_number) {
                    score -= 3;
                }
                console.log(`匹配分析 - ${current.title}: 分数=${score}, 最近一次集数=${current.lastEpisodeToAir.episode_number}, 已有集数=${currentEpisodes}, 状态=${current.status}`);
            }

            return (!best || score > best.score) ? {...current, score} : best;
        }, null);

        console.log(`最佳匹配结果: ${bestMatch?.title}, 分数: ${bestMatch?.score}`);
        
        console.log("根据TMDBID获取详情")
        if (!bestMatch?.id) return null;
        if (type == 'tv') {
            return this.getTVDetails(bestMatch.id)
        }
        return this.getMovieDetails(bestMatch.id);
    }

    async getTVDetails(id) {
        try {
            const response = await this._request(`/tv/${id}`, {
                append_to_response: 'credits,images'
            });
            // 如果没有图片信息，使用英文重新获取
            if (!response.images?.logos?.length) {
                const imagesResponse = await this._request(`/tv/${id}/images`, {
                    language: '' // 置空语言以获取所有图片
                });
                response.images = imagesResponse;
            }
            return {
                id: response.id,
                title: response.name,
                originalTitle: response.original_name,
                overview: response.overview,
                releaseDate: response.first_air_date,
                posterPath: response.poster_path ? `https://image.tmdb.org/t/p/w500${response.poster_path}` : null,
                backdropPath: response.backdrop_path? `https://image.tmdb.org/t/p/w500${response.backdrop_path}` : null,
                logoPath: response.images?.logos?.[0]?.file_path ? `https://image.tmdb.org/t/p/w500${response.images.logos[0].file_path}` : null,
                voteAverage: response.vote_average,
                cast: response.credits?.cast || [],
                type: 'tv',
                totalSeasons: response.number_of_seasons || 0,
                totalEpisodes: response.number_of_episodes || 0,
                seasons: response.seasons,
                lastEpisodeToAir: response.last_episode_to_air,
                status: response.status,
                genres: response.genres || []
            };
            
        } catch (error) {
            console.error(`获取电视剧详情失败: ${error.message}`);
            return null;
        }
    }

    async getMovieDetails(id) {
        try {
            const response = await this._request(`/movie/${id}`, {
                append_to_response: 'credits,images'
            });
            // 如果没有图片信息，使用英文重新获取
            if (!response.images?.logos?.length) {
                const imagesResponse = await this._request(`/movie/${id}/images`, {
                    language: '' // 置空语言以获取所有图片
                });
                response.images = imagesResponse;
            }
            return {
                id: response.id,
                title: response.title,
                originalTitle: response.original_title,
                overview: response.overview,
                releaseDate: response.release_date,
                posterPath: response.poster_path ? `https://image.tmdb.org/t/p/w500${response.poster_path}` : null,
                logoPath: response.images?.logos?.[0]?.file_path ? `https://image.tmdb.org/t/p/w500${response.images.logos[0].file_path}` : null,
                voteAverage: response.vote_average,
                cast: response.credits?.cast || [],
                genres: response.genres || [],
                type: 'movie'
            };
        } catch (error) {
            console.error(`获取电影详情失败: ${error.message}`);
            return null;
        }
    }

    async getEpisodeDetails(showId, season, episode) {
        try {
            console.log('获取剧集信息:', showId, season, episode);
            const response = await this._request(
                `/tv/${showId}/season/${season}/episode/${episode}`,
                { append_to_response: 'credits' }
            );
            return {
                ...response,
                stillPath: response.still_path?`https://image.tmdb.org/t/p/w500${response.still_path}` : null,
                cast: response.credits?.cast || []
            };
        } catch (error) {
            console.error(`获取剧集详情失败: ${error.message}`);
            return null;
        }
    }

    /**
     * 获取趋势内容
     * @param {string} mediaType - 'all' | 'movie' | 'tv'
     * @param {string} timeWindow - 'day' | 'week'
     */
    async getTrending(mediaType = 'all', timeWindow = 'week', page = 1) {
        try {
            const response = await this._request(`/trending/${mediaType}/${timeWindow}`, { page });
            return (response.results || []).map(item => ({
                id: item.id,
                title: item.title || item.name,
                originalTitle: item.original_title || item.original_name,
                overview: item.overview,
                releaseDate: item.release_date || item.first_air_date,
                posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
                backdropPath: item.backdrop_path ? `https://image.tmdb.org/t/p/w500${item.backdrop_path}` : '',
                voteAverage: item.vote_average,
                type: item.media_type || mediaType,
            }));
        } catch (error) {
            console.error(`获取趋势内容失败: ${error.message}`);
            return [];
        }
    }

    /**
     * 发现内容（支持筛选）
     * @param {string} mediaType - 'movie' | 'tv'
     * @param {object} params - 筛选参数
     */
    async discover(mediaType = 'movie', params = {}) {
        try {
            const response = await this._request(`/discover/${mediaType}`, {
                sort_by: params.sortBy || 'popularity.desc',
                with_genres: params.genres || '',
                page: params.page || 1,
                ...params,
            });
            return {
                results: (response.results || []).map(item => ({
                    id: item.id,
                    title: item.title || item.name,
                    originalTitle: item.original_title || item.original_name,
                    overview: item.overview,
                    releaseDate: item.release_date || item.first_air_date,
                    posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
                    voteAverage: item.vote_average,
                    type: mediaType,
                })),
                totalPages: response.total_pages || 1,
                totalResults: response.total_results || 0,
            };
        } catch (error) {
            console.error(`发现内容失败: ${error.message}`);
            return { results: [], totalPages: 0, totalResults: 0 };
        }
    }

    /**
     * 获取高分内容
     * @param {string} mediaType - 'movie' | 'tv'
     * @param {number} page - 页码
     */
    async getTopRated(mediaType = 'movie', page = 1) {
        try {
            const response = await this._request(`/${mediaType}/top_rated`, { page });
            return {
                results: (response.results || []).map(item => ({
                    id: item.id,
                    title: item.title || item.name,
                    originalTitle: item.original_title || item.original_name,
                    overview: item.overview,
                    releaseDate: item.release_date || item.first_air_date,
                    posterPath: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
                    voteAverage: item.vote_average,
                    type: mediaType,
                })),
                totalPages: response.total_pages || 1,
                totalResults: response.total_results || 0,
            };
        } catch (error) {
            console.error(`获取高分内容失败: ${error.message}`);
            return { results: [], totalPages: 0, totalResults: 0 };
        }
    }

    async getPopularPeople(page = 1) {
        try {
            const response = await this._request('/person/popular', {
                page: Math.min(Math.max(Number.parseInt(page, 10) || 1, 1), 100)
            });
            return {
                results: (response.results || []).map(person => ({
                    id: person.id,
                    title: person.name || '未命名演员',
                    originalTitle: person.original_name || person.name || '',
                    overview: (person.known_for || [])
                        .map(item => item.title || item.name)
                        .filter(Boolean)
                        .slice(0, 3)
                        .join(' · '),
                    posterPath: person.profile_path ? `https://image.tmdb.org/t/p/w500${person.profile_path}` : '',
                    voteAverage: 0,
                    type: 'person',
                    knownFor: person.known_for_department || '演员',
                })),
                totalPages: response.total_pages || 1,
                totalResults: response.total_results || 0,
            };
        } catch (error) {
            console.error(`获取热门演员失败: ${error.message}`);
            return { results: [], totalPages: 0, totalResults: 0 };
        }
    }

    async getStreamingRanking(provider, params = {}) {
        const providerConfig = STREAMING_PROVIDERS[String(provider || '').toLowerCase()];
        if (!providerConfig) throw new Error('无效的流媒体平台');
        const mediaType = ['movie', 'tv'].includes(params.mediaType) ? params.mediaType : 'all';
        const limit = Math.min(Math.max(Number.parseInt(params.limit, 10) || 30, 1), 100);
        const region = String(params.region || 'US').toUpperCase();
        if (!/^[A-Z]{2}$/.test(region)) throw new Error('无效的流媒体地区');
        const page = Math.min(Math.max(Number.parseInt(params.page, 10) || 1, 1), 100);
        const sortBy = ['popularity.desc', 'vote_average.desc', 'first_air_date.desc', 'primary_release_date.desc'].includes(params.sortBy)
            ? params.sortBy
            : 'popularity.desc';
        const shared = {
            with_watch_providers: providerConfig.id,
            watch_region: region,
            with_watch_monetization_types: 'flatrate|free|ads|rent|buy',
            sort_by: sortBy,
            page,
        };
        if (params.withGenres) shared.with_genres = String(params.withGenres).replace(/[^0-9,|]/g, '').slice(0, 80);
        if (params.year && /^\d{4}$/.test(String(params.year))) {
            if (mediaType === 'movie') shared.primary_release_year = String(params.year);
            if (mediaType === 'tv') shared.first_air_date_year = String(params.year);
        }
        if (params.minRating && Number.isFinite(Number(params.minRating))) {
            shared['vote_average.gte'] = Math.min(Math.max(Number(params.minRating), 0), 10);
        }
        const types = mediaType === 'all' ? ['movie', 'tv'] : [mediaType];
        const responses = [];
        const failedTypes = [];
        for (const type of types) {
            let result;
            for (let attempt = 0; attempt < 2; attempt++) {
                result = await this.discover(type, shared);
                // discover() uses totalPages=0 specifically for request failures.
                if (result?.totalPages !== 0) break;
            }
            if (result?.totalPages === 0) {
                failedTypes.push(type);
            } else {
                responses.push(result || { results: [], totalResults: 0 });
            }
        }
        if (responses.length === 0 && failedTypes.length > 0) {
            throw new Error('TMDB 流媒体榜单请求失败，请稍后重试');
        }
        const results = responses.flatMap(result => result.results || []).map(item => ({
            ...item,
            source: 'streaming',
            provider: providerConfig.label,
            providerKey: String(provider).toLowerCase(),
        }));
        return { results: results.slice(0, limit), provider: providerConfig, totalResults: responses.reduce((sum, item) => sum + (item.totalResults || 0), 0) };
    }
}

module.exports = { TMDBService, normalizeMediaTitle, rankSearchResults, scoreSearchResult, STREAMING_PROVIDERS };
