const assert = require('node:assert/strict');
const test = require('node:test');
const { AniListService, normalizeMedia } = require('../src/services/aniList');
const { TMDBService, STREAMING_PROVIDERS } = require('../src/services/tmdb');

test('AniList media is normalized to a poster wall anime item', () => {
    const item = normalizeMedia({
        id: 42,
        title: { userPreferred: '示例动画' },
        averageScore: 87,
        startDate: { year: 2026 },
        coverImage: { large: 'https://example.test/poster.jpg' },
        description: '<p>简介</p>',
        genres: ['Action']
    });
    assert.deepEqual(item, {
        id: '42',
        title: '示例动画',
        originalTitle: '',
        poster: 'https://example.test/poster.jpg',
        rate: '8.7',
        year: '2026',
        overview: '简介',
        type: 'anime',
        source: 'anilist',
        genres: ['Action']
    });
});

test('AniList rejects unsupported sort values before network access', async () => {
    const service = new AniListService();
    await assert.rejects(service.list({ sort: 'INVALID' }), /无效的 AniList 排序/);
});

test('TMDB exposes exactly the eight supported streaming providers', () => {
    assert.deepEqual(Object.keys(STREAMING_PROVIDERS), [
        'netflix', 'hbo', 'apple', 'disney', 'crunchyroll', 'prime', 'amazon', 'hulu'
    ]);
});

test('TMDB streaming ranking and popular actors are normalized for the poster wall', async () => {
    const service = new TMDBService();
    service._request = async (endpoint) => endpoint === '/person/popular'
        ? {
            results: [{ id: 7, name: '示例演员', known_for_department: 'Acting', known_for: [{ title: '代表作' }], profile_path: '/actor.jpg' }],
            total_pages: 2,
            total_results: 21
        }
        : {
            results: [{ id: 8, name: '示例剧集', first_air_date: '2025-01-01', poster_path: '/show.jpg', vote_average: 8.2 }],
            total_pages: 1,
            total_results: 1
        };
    const people = await service.getPopularPeople(1);
    assert.equal(people.results[0].type, 'person');
    assert.equal(people.results[0].knownFor, 'Acting');
    service.discover = async () => ({
        results: [{ id: 8, name: '示例剧集', first_air_date: '2025-01-01', poster_path: '/show.jpg', vote_average: 8.2, type: 'tv' }],
        totalResults: 1
    });
    const ranking = await service.getStreamingRanking('netflix', { mediaType: 'tv', region: 'US' });
    assert.equal(ranking.results[0].provider, 'Netflix');
    assert.equal(ranking.results[0].source, 'streaming');
});

test('TMDB streaming ranking rejects unknown providers and regions', async () => {
    const service = new TMDBService();
    await assert.rejects(service.getStreamingRanking('unknown'), /无效的流媒体平台/);
    await assert.rejects(service.getStreamingRanking('netflix', { region: 'USA' }), /无效的流媒体地区/);
});

test('TMDB streaming ranking queries media types sequentially and retries request failures', async () => {
    const service = new TMDBService();
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const attempts = { movie: 0, tv: 0 };
    service.discover = async (type) => {
        attempts[type]++;
        activeRequests++;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise(resolve => setImmediate(resolve));
        activeRequests--;
        if (attempts[type] === 1) {
            return { results: [], totalPages: 0, totalResults: 0 };
        }
        return {
            results: [{ id: type, title: type, type }],
            totalPages: 1,
            totalResults: 1
        };
    };

    const ranking = await service.getStreamingRanking('netflix', { mediaType: 'all', region: 'US' });
    assert.equal(maxActiveRequests, 1);
    assert.deepEqual(attempts, { movie: 2, tv: 2 });
    assert.equal(ranking.results.length, 2);
});
