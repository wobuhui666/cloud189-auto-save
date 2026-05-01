const got = require('got');
const ConfigService = require('./ConfigService');
const ProxyUtil = require('../utils/ProxyUtil');
class TMDBService {
    constructor() {
        this.apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        this.baseURL = 'https://api.themoviedb.org/3';
        this.language = 'zh-CN';
    }

    async _request(endpoint, params = {}) {
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
            return response;
        } catch (error) {
            console.error(`TMDB请求失败 [${endpoint}]:`, {
                message: error.message
            });
            throw error;
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

        // 按年份倒序排序
        const sortedResults = response.results.sort((a, b) => {
            const dateA = type === 'movie' ? a.release_date : a.first_air_date;
            const dateB = type === 'movie' ? b.release_date : b.first_air_date;
            return new Date(dateB) - new Date(dateA);
        });

        // 获取前3个结果的详细信息
        const detailPromises = sortedResults.slice(0, 3).map(async media => {
            if (type === 'tv') {
                return await this.getTVDetails(media.id);
            }
            return await this.getMovieDetails(media.id);
        });

        const details = await Promise.all(detailPromises);
        
        // 分析最匹配的结果
        const bestMatch = details.reduce((best, current) => {
            if (!current) return best;
            let score = 0;
            
            // 1. 标题完全匹配加分
            if (current.title.toLowerCase() === title.toLowerCase()) {
                score += 10;
            }
            
            // 2. 年份匹配加分
            const mediaYear = new Date(current.releaseDate).getFullYear();
            if (year && mediaYear === parseInt(year)) {
                score += 5;
            }
            
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
}

module.exports = { TMDBService };