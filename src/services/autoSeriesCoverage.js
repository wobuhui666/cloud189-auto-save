const path = require('path');
const { parseMediaTitle } = require('../utils/mediaTitleParser');

const DEFAULT_SEASON = 1;
const VIDEO_EXTENSIONS = new Set([
    '.3g2', '.3gp', '.asf', '.avi', '.divx', '.f4v', '.flv', '.m2ts', '.m4v',
    '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.mts', '.rm', '.rmvb', '.ts',
    '.vob', '.webm', '.wmv'
]);
const COMPANION_EXTENSIONS = new Set(['.ass', '.srt', '.ssa', '.sub', '.sup', '.vtt']);

function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function coverageKey(seasonNumber, episodeNumber) {
    const season = positiveInteger(seasonNumber);
    const episode = positiveInteger(episodeNumber);
    return season && episode ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(3, '0')}` : '';
}

function parseCoverageKey(value) {
    const matched = String(value || '').match(/^S(\d{1,3})E(\d{1,4})$/i);
    if (!matched) return null;
    const seasonNumber = positiveInteger(matched[1]);
    const episodeNumber = positiveInteger(matched[2]);
    return seasonNumber && episodeNumber ? { seasonNumber, episodeNumber } : null;
}

function uniqueSortedNumbers(values = []) {
    return [...new Set(values.map(positiveInteger).filter(Boolean))].sort((left, right) => left - right);
}

function buildExpectedCoverage(tmdbInfo = null) {
    const seasons = (Array.isArray(tmdbInfo?.seasons) ? tmdbInfo.seasons : [])
        .map(season => ({
            seasonNumber: positiveInteger(season?.seasonNumber ?? season?.season_number),
            episodeCount: positiveInteger(season?.episodeCount ?? season?.episode_count) || 0
        }))
        .filter(season => season.seasonNumber && season.episodeCount > 0)
        .sort((left, right) => left.seasonNumber - right.seasonNumber);

    if (!seasons.length) {
        const totalEpisodes = positiveInteger(tmdbInfo?.totalEpisodes) || 0;
        if (totalEpisodes > 0) seasons.push({ seasonNumber: DEFAULT_SEASON, episodeCount: totalEpisodes });
    }

    const keys = [];
    for (const season of seasons) {
        for (let episodeNumber = 1; episodeNumber <= season.episodeCount; episodeNumber++) {
            keys.push(coverageKey(season.seasonNumber, episodeNumber));
        }
    }
    return { seasons, keys };
}

function extractSeasonHint(value = '') {
    const normalized = String(value || '').replace(/[\\/]+/g, ' ');
    const parsed = parseMediaTitle(normalized);
    if (positiveInteger(parsed?.season)) return Number(parsed.season);
    const matched = normalized.match(/(?:^|[\s._-])(?:S|Season\s*)(\d{1,3})(?=[\s._-]|$)/i)
        || normalized.match(/第\s*(\d{1,3})\s*季/i);
    return positiveInteger(matched?.[1]);
}

function extractEpisodeHint(value = '') {
    const normalized = String(value || '').replace(/[\\/]+/g, ' ');
    const parsed = parseMediaTitle(normalized);
    if (positiveInteger(parsed?.episode)) return Number(parsed.episode);
    const matched = normalized.match(/(?:^|[\s._-])(?:E|EP)(\d{1,4})(?=[\s._-]|$)/i)
        || normalized.match(/第\s*(\d{1,4})\s*(?:集|话)/i)
        || normalized.match(/[\[【](\d{1,4})[\]】]/);
    return positiveInteger(matched?.[1]);
}

function fileExtension(fileName = '') {
    const normalized = String(fileName || '').replace(/\.cas$/i, '');
    return path.extname(normalized).toLowerCase();
}

function isCoverageMediaFile(fileName = '') {
    return VIDEO_EXTENSIONS.has(fileExtension(fileName));
}

function isCoverageCompanionFile(fileName = '') {
    return COMPANION_EXTENSIONS.has(fileExtension(fileName));
}

function inferCompleteSeasonsFromTitle(title = '', expectedCoverage = { seasons: [] }) {
    const value = String(title || '');
    const expectedSeasons = new Set((expectedCoverage.seasons || []).map(item => item.seasonNumber));
    const result = new Set();
    const totalMatch = value.match(/(?:全|Complete\s*)(\d{1,3})\s*季/i);
    if (totalMatch) {
        const total = positiveInteger(totalMatch[1]) || 0;
        for (let season = 1; season <= total; season++) result.add(season);
    }
    const rangeMatch = value.match(/(?:S|Season\s*|第\s*)(\d{1,3})\s*(?:-|~|至|到)\s*(?:S|Season\s*|第\s*)?(\d{1,3})\s*(?:季)?/i);
    if (rangeMatch) {
        const start = positiveInteger(rangeMatch[1]) || 0;
        const end = positiveInteger(rangeMatch[2]) || 0;
        for (let season = start; season > 0 && season <= end; season++) result.add(season);
    }
    const singlePatterns = [/(?:^|[\s._-])S(\d{1,3})(?=[\s._-]|$)/ig, /Season\s*(\d{1,3})/ig, /第\s*(\d{1,3})\s*季/ig];
    if (/全|全集|Complete|Pack/i.test(value)) {
        for (const pattern of singlePatterns) {
            let match;
            while ((match = pattern.exec(value))) result.add(Number(match[1]));
        }
    }
    return [...result].filter(season => !expectedSeasons.size || expectedSeasons.has(season)).sort((a, b) => a - b);
}

function analyzeCoverageFiles(files = [], options = {}) {
    const expectedCoverage = options.expectedCoverage || buildExpectedCoverage(options.tmdbInfo);
    const expectedSeasons = new Set((expectedCoverage.seasons || []).map(item => item.seasonNumber));
    const titleSeason = extractSeasonHint(options.candidateTitle);
    const onlyExpectedSeason = expectedSeasons.size === 1 ? [...expectedSeasons][0] : null;
    const keys = new Set();
    let mediaFileCount = 0;
    let unknownMediaCount = 0;

    for (const file of files) {
        const name = String(file?.name || file?.fileName || '');
        if (!isCoverageMediaFile(name)) continue;
        mediaFileCount++;
        const relativePath = String(file?.relativePath || path.posix.join(String(file?.relativeDir || ''), name)).replace(/\\/g, '/');
        const seasonNumber = extractSeasonHint(relativePath) || extractSeasonHint(file?.relativeDir) || titleSeason || onlyExpectedSeason || DEFAULT_SEASON;
        const bareEpisode = seasonNumber
            ? positiveInteger(path.basename(name.replace(/\.cas$/i, ''), fileExtension(name)).match(/^(\d{1,4})$/)?.[1])
            : null;
        const episodeNumber = extractEpisodeHint(relativePath) || extractEpisodeHint(name) || bareEpisode;
        const key = coverageKey(seasonNumber, episodeNumber);
        if (!key || (expectedSeasons.size && !expectedSeasons.has(seasonNumber))) {
            unknownMediaCount++;
            continue;
        }
        keys.add(key);
    }

    const claimedCompleteSeasons = inferCompleteSeasonsFromTitle(options.candidateTitle, expectedCoverage);
    return summarizeCoverage([...keys], expectedCoverage, { mediaFileCount, unknownMediaCount, claimedCompleteSeasons });
}

function summarizeCoverage(keys = [], expectedCoverage = { seasons: [], keys: [] }, extra = {}) {
    const normalizedKeys = [...new Set(keys.map(String).filter(key => parseCoverageKey(key)))].sort();
    const expectedKeys = new Set(expectedCoverage.keys || []);
    const relevantKeys = expectedKeys.size ? normalizedKeys.filter(key => expectedKeys.has(key)) : normalizedKeys;
    const bySeason = new Map();
    for (const key of relevantKeys) {
        const parsed = parseCoverageKey(key);
        if (!parsed) continue;
        if (!bySeason.has(parsed.seasonNumber)) bySeason.set(parsed.seasonNumber, []);
        bySeason.get(parsed.seasonNumber).push(parsed.episodeNumber);
    }
    const seasons = (expectedCoverage.seasons || []).map(expected => {
        const episodes = uniqueSortedNumbers(bySeason.get(expected.seasonNumber) || []);
        return {
            seasonNumber: expected.seasonNumber,
            expectedEpisodes: expected.episodeCount,
            episodes,
            coveredEpisodes: episodes.length,
            complete: expected.episodeCount > 0 && episodes.length >= expected.episodeCount
        };
    });
    for (const [seasonNumber, episodes] of bySeason.entries()) {
        if (!seasons.some(item => item.seasonNumber === seasonNumber)) {
            const normalizedEpisodes = uniqueSortedNumbers(episodes);
            seasons.push({ seasonNumber, expectedEpisodes: 0, episodes: normalizedEpisodes, coveredEpisodes: normalizedEpisodes.length, complete: false });
        }
    }
    seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
    return {
        keys: relevantKeys,
        coveredEpisodes: relevantKeys.length,
        expectedEpisodes: expectedKeys.size,
        seasons,
        ...extra
    };
}

function normalizeCoverageState(value, expectedCoverage) {
    const keys = Array.isArray(value?.keys)
        ? value.keys
        : (Array.isArray(value?.coveredKeys) ? value.coveredKeys : []);
    return summarizeCoverage(keys, expectedCoverage);
}

function buildCoverageScope(keys = [], expectedCoverage = { seasons: [] }) {
    const summary = summarizeCoverage(keys, expectedCoverage);
    return {
        keys: summary.keys,
        seasons: summary.seasons
            .filter(item => item.episodes.length)
            .map(item => ({ seasonNumber: item.seasonNumber, episodes: item.episodes }))
    };
}

function mergeCoverageScopes(left = null, right = null, expectedCoverage = { seasons: [] }) {
    return buildCoverageScope([...(left?.keys || []), ...(right?.keys || [])], expectedCoverage);
}

function buildGreedyCoveragePlan(candidates = [], expectedCoverage, alreadyCoveredKeys = []) {
    const expectedKeys = new Set(expectedCoverage?.keys || []);
    const covered = new Set((alreadyCoveredKeys || []).filter(key => !expectedKeys.size || expectedKeys.has(key)));
    const remainingCandidates = candidates.map(candidate => ({
        ...candidate,
        coverageKeys: [...new Set(candidate.coverageKeys || [])].filter(key => !expectedKeys.size || expectedKeys.has(key))
    }));
    const assignments = [];

    while (remainingCandidates.length) {
        const ranked = remainingCandidates
            .map((candidate, index) => ({
                candidate,
                index,
                newKeys: candidate.coverageKeys.filter(key => !covered.has(key))
            }))
            .filter(item => item.newKeys.length)
            .sort((left, right) => right.newKeys.length - left.newKeys.length
                || Number(right.candidate.score || 0) - Number(left.candidate.score || 0));
        if (!ranked.length) break;
        const selected = ranked[0];
        assignments.push({ candidateId: selected.candidate.candidateId, keys: selected.newKeys });
        selected.newKeys.forEach(key => covered.add(key));
        remainingCandidates.splice(selected.index, 1);
        if (expectedKeys.size && covered.size >= expectedKeys.size) break;
    }

    const missingKeys = [...expectedKeys].filter(key => !covered.has(key)).sort();
    return {
        assignments,
        coverage: summarizeCoverage([...covered], expectedCoverage),
        missingKeys,
        complete: expectedKeys.size > 0 && missingKeys.length === 0
    };
}

function matchesCoverageScope(file, scope = null, options = {}) {
    if (!scope?.keys?.length) return true;
    const name = String(file?.name || file?.fileName || '');
    if (!isCoverageMediaFile(name) && !isCoverageCompanionFile(name)) return false;
    const relativePath = String(file?.relativePath || path.posix.join(String(file?.relativeDir || ''), name)).replace(/\\/g, '/');
    const episodeNumber = extractEpisodeHint(relativePath) || extractEpisodeHint(name);
    const seasonNumber = extractSeasonHint(relativePath)
        || extractSeasonHint(file?.relativeDir)
        || positiveInteger(options.defaultSeason)
        || DEFAULT_SEASON;
    return scope.keys.includes(coverageKey(seasonNumber, episodeNumber));
}

module.exports = {
    VIDEO_EXTENSIONS,
    buildExpectedCoverage,
    buildCoverageScope,
    buildGreedyCoveragePlan,
    mergeCoverageScopes,
    analyzeCoverageFiles,
    summarizeCoverage,
    normalizeCoverageState,
    coverageKey,
    parseCoverageKey,
    extractSeasonHint,
    extractEpisodeHint,
    inferCompleteSeasonsFromTitle,
    isCoverageMediaFile,
    matchesCoverageScope
};
