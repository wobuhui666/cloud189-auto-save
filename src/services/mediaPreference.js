const DEFAULT_MEDIA_PREFERENCE = Object.freeze({
    resolutionPriority: ['2160p', '1080p', '720p'],
    sourcePriority: ['Remux', 'BluRay', 'WEB-DL', 'WEBRip', 'HDTV'],
    dynamicRangePriority: ['Dolby Vision', 'HDR10+', 'HDR10/HDR', 'SDR'],
    codecPriority: ['HEVC/H265', 'AVC/H264'],
    audioPriority: ['Atmos/DTS:X', 'TrueHD/DTS-HD MA', 'EAC3/AC3', 'AAC'],
    preferredGroups: [],
    blockedKeywords: ['预告', 'trailer', 'teaser', '样片', 'sample', 'CAM', 'TS'],
    extraRequirement: '',
    fallbackMode: 'next_tier',
    upgradePolicy: 'higher_score'
});

function normalizeStringList(value, fallback = []) {
    const list = Array.isArray(value) ? value : fallback;
    return [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
}

function normalizeMediaPreference(input = {}, defaults = DEFAULT_MEDIA_PREFERENCE) {
    const preference = input && typeof input === 'object' ? input : {};
    return {
        resolutionPriority: normalizeStringList(preference.resolutionPriority, defaults.resolutionPriority),
        sourcePriority: normalizeStringList(preference.sourcePriority, defaults.sourcePriority),
        dynamicRangePriority: normalizeStringList(preference.dynamicRangePriority, defaults.dynamicRangePriority),
        codecPriority: normalizeStringList(preference.codecPriority, defaults.codecPriority),
        audioPriority: normalizeStringList(preference.audioPriority, defaults.audioPriority),
        preferredGroups: normalizeStringList(preference.preferredGroups, defaults.preferredGroups),
        blockedKeywords: normalizeStringList(preference.blockedKeywords, defaults.blockedKeywords),
        extraRequirement: String(preference.extraRequirement || defaults.extraRequirement || '').trim().slice(0, 500),
        fallbackMode: ['strict', 'next_tier'].includes(preference.fallbackMode) ? preference.fallbackMode : defaults.fallbackMode,
        upgradePolicy: ['none', 'higher_score'].includes(preference.upgradePolicy) ? preference.upgradePolicy : defaults.upgradePolicy
    };
}

function rankFromPriority(text, priorities, patterns) {
    const matchedIndex = priorities.findIndex(item => (patterns[item] || []).some(pattern => pattern.test(text)));
    return matchedIndex < 0 ? 0 : (priorities.length - matchedIndex) * 100;
}

function matchesBlockedKeyword(text, keyword) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return false;
    if (/^[a-z0-9]+$/i.test(normalizedKeyword)) {
        const escaped = normalizedKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
    }
    return text.includes(normalizedKeyword);
}

function scoreMediaTitle(value = '', preferenceInput = {}) {
    const preference = normalizeMediaPreference(preferenceInput);
    const text = String(value || '').toLowerCase();
    if (preference.blockedKeywords.some(keyword => matchesBlockedKeyword(text, keyword))) {
        return { score: -100000, blocked: true, reasons: ['命中排除关键词'] };
    }
    const resolutionPatterns = {
        '2160p': [/2160p|\b4k\b/i], '1080p': [/1080p/i], '720p': [/720p/i]
    };
    const sourcePatterns = {
        Remux: [/remux/i], BluRay: [/blu[ ._-]?ray|bdrip/i], 'WEB-DL': [/web[ ._-]?dl/i], WEBRip: [/webrip/i], HDTV: [/hdtv/i]
    };
    const rangePatterns = {
        'Dolby Vision': [/dolby[ ._-]?vision|\bdv\b/i], 'HDR10+': [/hdr10\+/i], 'HDR10/HDR': [/hdr10|\bhdr\b/i], SDR: [/\bsdr\b/i]
    };
    const codecPatterns = { 'HEVC/H265': [/hevc|h[ ._-]?265|x265/i], 'AVC/H264': [/avc|h[ ._-]?264|x264/i] };
    const audioPatterns = {
        'Atmos/DTS:X': [/atmos|dts[ ._-]?x/i], 'TrueHD/DTS-HD MA': [/truehd|dts[ ._-]?hd[ ._-]?ma/i], 'EAC3/AC3': [/e[ ._-]?ac3|ddp|\bac3\b/i], AAC: [/\baac\b/i]
    };
    const score = rankFromPriority(text, preference.resolutionPriority, resolutionPatterns) * 1000
        + rankFromPriority(text, preference.sourcePriority, sourcePatterns) * 100
        + rankFromPriority(text, preference.dynamicRangePriority, rangePatterns) * 10
        + rankFromPriority(text, preference.codecPriority, codecPatterns) * 5
        + rankFromPriority(text, preference.audioPriority, audioPatterns)
        + preference.preferredGroups.reduce((total, group, index) => text.includes(group.toLowerCase()) ? total + (preference.preferredGroups.length - index) * 20 : total, 0);
    return { score, blocked: false, reasons: [] };
}

function selectBestTier(candidates = [], preference = {}) {
    const scored = candidates.map(candidate => ({ ...candidate, mediaScore: scoreMediaTitle(candidate.title || candidate.rawTitle || '', preference).score }))
        .filter(candidate => candidate.mediaScore > -100000);
    return scored.sort((left, right) => right.mediaScore - left.mediaScore)[0] || null;
}

module.exports = { DEFAULT_MEDIA_PREFERENCE, normalizeMediaPreference, scoreMediaTitle, selectBestTier };
