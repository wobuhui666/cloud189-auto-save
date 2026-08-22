const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const { matchReleaseFilters, normalizeWhitespace } = require('./ptUtils');
const { parseMediaTitle } = require('../utils/mediaTitleParser');

const FILTER_FIELDS = ['includePattern', 'excludePattern', 'qualityPattern', 'resolutionPattern', 'effectPattern'];

function mergeFilterPatterns(...patterns) {
    return [...new Set(patterns
        .flatMap(pattern => String(pattern || '').split(/\r?\n/))
        .map(pattern => pattern.trim().replace(/^\(\?i\)/, ''))
        .filter(Boolean))]
        .join('\n');
}

function mergeCandidateFilters(candidate = {}, filters = {}) {
    return FILTER_FIELDS.reduce((result, field) => {
        result[field] = mergeFilterPatterns(candidate[field], filters[field]);
        return result;
    }, {});
}

function compileFilterPatterns(filters = {}) {
    for (const field of FILTER_FIELDS) {
        const value = String(filters[field] || '').trim();
        if (!value) continue;
        for (const line of value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
            const scoped = line.match(/^\{\{[^}]+\}\}\s*:\s*([\s\S]+)$/);
            new RegExp(scoped?.[1] || line, 'i');
        }
    }
    return true;
}

function normalizeTitle(value = '') {
    return normalizeWhitespace(value)
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function longestCommonSubsequenceLength(left, right) {
    const row = new Uint16Array(right.length + 1);
    for (const leftChar of left) {
        let diagonal = 0;
        for (let index = 1; index <= right.length; index += 1) {
            const previous = row[index];
            row[index] = leftChar === right[index - 1]
                ? diagonal + 1
                : Math.max(row[index], row[index - 1]);
            diagonal = previous;
        }
    }
    return row[right.length];
}

function titleMatches(actualTitle, expectedTitle) {
    const actual = normalizeTitle(actualTitle);
    const expected = normalizeTitle(expectedTitle);
    if (!actual || !expected) return false;
    if (actual.includes(expected)) return true;
    if (expected.length < 8) return false;
    return longestCommonSubsequenceLength(expected, actual) / expected.length >= 0.85;
}

function isWrongTitle(item, expectedTitles) {
    const title = normalizeTitle(item.rawTitle || item.title || '');
    return expectedTitles.length > 0 && !expectedTitles.some(expected => titleMatches(title, expected));
}

function resolveMediaType(mediaType = '', title = '') {
    const explicit = String(mediaType || '').trim().toLowerCase();
    if (explicit === 'movie' || explicit === 'tv') return explicit;
    return /剧场版|大电影|电影版|\b(?:the\s+movie|movie|film)\b/i.test(String(title || '')) ? 'movie' : 'tv';
}

function resolveValidationSeasonNumber({ title = '', mediaType = '', tmdbInfo = null, seasonNumber = null } = {}) {
    if (resolveMediaType(mediaType || tmdbInfo?.type || tmdbInfo?.mediaType, title) === 'movie') return null;
    const tmdbSeasons = (tmdbInfo?.seasons || [])
        .map(season => Number(season?.seasonNumber ?? season?.season_number))
        .filter(season => Number.isInteger(season) && season > 0);
    if (tmdbSeasons.length === 1) return tmdbSeasons[0];
    const titleSeason = Number(parseMediaTitle(title)?.season);
    if (Number.isInteger(titleSeason) && titleSeason > 0 && (!tmdbSeasons.length || tmdbSeasons.includes(titleSeason))) {
        return titleSeason;
    }
    const requestedSeason = Number(seasonNumber);
    if (Number.isInteger(requestedSeason) && requestedSeason > 0) {
        if (tmdbSeasons.length && !tmdbSeasons.includes(requestedSeason)) throw new Error('PT 校验季号不在 TMDB 季度范围内');
        return requestedSeason;
    }
    return null;
}

function validatePtFilters({ filters = {}, samples = [], title = '', aliases = [], seasonNumber = null, mediaType = '' }) {
    compileFilterPatterns(filters);
    const expectedTitles = [title, ...aliases].filter(Boolean);
    const expectedMediaType = resolveMediaType(mediaType, title);
    const expectedSeasonNumber = expectedMediaType === 'movie' ? null : seasonNumber;
    const subscription = { ...filters, globalExclude: false };
    const limitedSamples = (samples || []).slice(0, 50);
    const matched = limitedSamples.filter(item => matchReleaseFilters(item, subscription));
    const validMatches = matched.filter(item => {
        if (isWrongTitle(item, expectedTitles)) return false;
        if (expectedSeasonNumber != null && item.seasonNumber != null && Number(item.seasonNumber) !== Number(expectedSeasonNumber)) return false;
        if (/预告|trailer|teaser|样片|sample/i.test(item.rawTitle || item.title || '')) return false;
        return expectedMediaType === 'movie' || Number(item.episodeNumber || 0) > 0;
    });
    const falsePositives = matched.filter(item => !validMatches.includes(item));
    if (!validMatches.length) {
        throw new Error(expectedMediaType === 'movie'
            ? 'PT 正则未命中正确电影标题的真实样本'
            : 'PT 正则未命中正确标题、季度和集号的真实样本');
    }
    if (falsePositives.length) throw new Error(`PT 正则误命中 ${falsePositives.length} 条错误样本`);
    const tokenPayload = JSON.stringify({ filters: FILTER_FIELDS.reduce((result, field) => ({ ...result, [field]: filters[field] || '' }), {}), sampleGuids: limitedSamples.map(item => item.guid || item.title), title, seasonNumber: expectedSeasonNumber, mediaType: expectedMediaType });
    const configuredSecret = String(ConfigService.getConfigValue('system.encryptKey', '') || '').trim();
    const tokenSecret = configuredSecret || process.env.ENCRYPT_KEY || 'cloud189-auto-save-pt-filter-validation';
    return {
        token: crypto.createHmac('sha256', tokenSecret).update(tokenPayload).digest('hex'),
        filters: FILTER_FIELDS.reduce((result, field) => ({ ...result, [field]: filters[field] || '' }), {}),
        summary: { mediaType: expectedMediaType, sampleCount: limitedSamples.length, matchedCount: matched.length, validMatchCount: validMatches.length, falsePositiveCount: falsePositives.length }
    };
}

module.exports = { FILTER_FIELDS, compileFilterPatterns, mergeFilterPatterns, mergeCandidateFilters, normalizeTitle, titleMatches, resolveMediaType, resolveValidationSeasonNumber, validatePtFilters };
