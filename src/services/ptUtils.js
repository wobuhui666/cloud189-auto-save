const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAS_SLICE_SIZE = 10 * 1024 * 1024;

function normalizeRelativePath(targetPath = '') {
    return String(targetPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/');
}

function normalizeWhitespace(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeFileName(fileName = '', fallback = 'untitled') {
    const normalized = normalizeWhitespace(fileName)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\.+$/g, '')
        .trim();
    return normalized || fallback;
}

function decodeHtmlEntities(value = '') {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: '\'',
        nbsp: ' '
    };
    return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
        const lowered = String(entity || '').toLowerCase();
        if (named[lowered]) {
            return named[lowered];
        }
        if (lowered.startsWith('#x')) {
            const code = parseInt(lowered.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        if (lowered.startsWith('#')) {
            const code = parseInt(lowered.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        return _;
    });
}

function stripHtml(value = '') {
    return normalizeWhitespace(
        decodeHtmlEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, ' '))
    );
}

function safeJsonParse(value, fallback = null) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function parseRegex(pattern = '', defaultFlags = 'i') {
    const normalized = String(pattern || '').trim();
    if (!normalized) {
        return null;
    }
    const literal = normalized.match(/^\/([\s\S]+)\/([a-z]*)$/i);
    try {
        if (literal) {
            const flags = [...new Set(String(literal[2] || defaultFlags).replace(/g/g, '').split(''))].join('');
            return new RegExp(literal[1], flags);
        }
        return new RegExp(normalized, defaultFlags);
    } catch (_) {
        return null;
    }
}

function buildPatternMatcher(pattern = '') {
    const normalized = String(pattern || '').trim();
    if (!normalized) {
        return null;
    }
    const regex = parseRegex(normalized, 'i');
    if (regex) {
        return (value = '') => regex.test(String(value || ''));
    }
    const lowered = normalized.toLowerCase();
    return (value = '') => String(value || '').toLowerCase().includes(lowered);
}

function parseScopedRule(rule = '') {
    const text = String(rule || '').trim();
    const scoped = text.match(/^\{\{([^}]+)\}\}\s*:\s*([\s\S]+)$/);
    if (!scoped) {
        return { subgroup: '', pattern: text };
    }
    return {
        subgroup: normalizeWhitespace(scoped[1]).toLowerCase(),
        pattern: normalizeWhitespace(scoped[2])
    };
}

function getPatternRules(pattern = '') {
    return String(pattern || '')
        .split(/\r?\n/)
        .map(normalizeWhitespace)
        .filter(Boolean)
        .map(parseScopedRule)
        .filter(rule => rule.pattern);
}

function isRuleApplicable(rule, item = {}) {
    if (!rule.subgroup) {
        return true;
    }
    const subgroup = normalizeWhitespace(item.subgroup || item.author || '').toLowerCase();
    return subgroup === rule.subgroup;
}

function matchRule(rule, value = '') {
    const matcher = buildPatternMatcher(rule.pattern);
    return !matcher || matcher(value);
}

function matchIncludeRules(pattern = '', value = '', item = {}) {
    const activeRules = getPatternRules(pattern).filter(rule => isRuleApplicable(rule, item));
    if (!activeRules.length) {
        return true;
    }
    return activeRules.every(rule => matchRule(rule, value));
}

function matchExcludeRules(pattern = '', value = '', item = {}) {
    return getPatternRules(pattern)
        .filter(rule => isRuleApplicable(rule, item))
        .some(rule => matchRule(rule, value));
}

function matchReleaseTitle(title = '', includePattern = '', excludePattern = '', item = {}) {
    const text = String(title || '');
    if (!matchIncludeRules(includePattern, text, item)) {
        return false;
    }
    if (matchExcludeRules(excludePattern, text, item)) {
        return false;
    }
    return true;
}

function parseNumber(value, fallback = null) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function isExplicitFalse(value) {
    return value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false';
}

function parseSizeToBytes(value = '') {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    const raw = normalizeWhitespace(value);
    if (!raw) {
        return 0;
    }
    const compact = raw.replace(/,/g, '');
    if (/^\d+$/.test(compact)) {
        return Number(compact);
    }
    const match = compact.match(/([\d.]+)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)/i);
    if (!match) {
        return 0;
    }
    const size = Number(match[1]);
    if (!Number.isFinite(size)) {
        return 0;
    }
    const unit = match[2].toLowerCase();
    const map = {
        b: 1,
        kb: 1024,
        kib: 1024,
        mb: 1024 ** 2,
        mib: 1024 ** 2,
        gb: 1024 ** 3,
        gib: 1024 ** 3,
        tb: 1024 ** 4,
        tib: 1024 ** 4
    };
    return Math.round(size * (map[unit] || 1));
}

function getReleaseContent(item = {}) {
    return normalizeWhitespace([
        item.rawTitle,
        item.title,
        item.description,
        Array.isArray(item.labels) ? item.labels.join(' ') : '',
        Array.isArray(item.tags) ? item.tags.join(' ') : '',
        item.subgroup,
        item.resolution,
        item.quality,
        item.effect,
        item.codec,
        item.subtitleType,
        item.container,
        item.volumeFactor
    ].filter(Boolean).join(' '));
}

function isFreeRelease(item = {}) {
    const downloadFactor = parseNumber(item.downloadVolumeFactor, null);
    if (downloadFactor === 0) {
        return true;
    }
    const labels = Array.isArray(item.labels) ? item.labels : [];
    if (labels.some(label => /free|免费|0x|2x免费/i.test(String(label)))) {
        return true;
    }
    return /(^|[\s\[\(【])(?:free|免费|0x|2x免费)(?=$|[\s\]\)】])/i.test(getReleaseContent(item));
}

function matchPatternValue(pattern = '', value = '') {
    const matcher = buildPatternMatcher(pattern);
    return !matcher || matcher(value);
}

function parseEpisodeList(value = '') {
    return String(value || '')
        .split(/[\s,，、]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => {
            const range = item.match(/^(\d+(?:\.5)?)\s*-\s*(\d+(?:\.5)?)$/);
            if (range) {
                const start = Number(range[1]);
                const end = Number(range[2]);
                if (Number.isFinite(start) && Number.isFinite(end)) {
                    return { start: Math.min(start, end), end: Math.max(start, end) };
                }
            }
            const episode = Number(item);
            return Number.isFinite(episode) ? { start: episode, end: episode } : null;
        })
        .filter(Boolean);
}

function episodeInRanges(episodeNumber, ranges = []) {
    const episode = Number(episodeNumber);
    if (!Number.isFinite(episode)) {
        return false;
    }
    return ranges.some(range => episode >= range.start && episode <= range.end);
}

function matchReleaseFilters(item = {}, subscription = {}) {
    const title = normalizeWhitespace([item.rawTitle, item.title].filter(Boolean).join(' '));
    if (!matchReleaseTitle(title, subscription.includePattern, subscription.excludePattern, item)) {
        return false;
    }

    const content = getReleaseContent(item);
    if (!matchIncludeRules(subscription.qualityPattern, content, item)) {
        return false;
    }
    if (!matchIncludeRules(subscription.resolutionPattern, content, item)) {
        return false;
    }
    if (!matchIncludeRules(subscription.effectPattern, content, item)) {
        return false;
    }
    if (!isExplicitFalse(subscription.globalExclude) && matchExcludeRules(subscription.globalExcludePattern, content, item)) {
        return false;
    }

    const sizeBytes = parseNumber(item.size, 0) || 0;
    const sizeMB = sizeBytes > 0 ? sizeBytes / 1024 / 1024 : 0;
    const minMB = parseNumber(subscription.sizeMinMB, 0) || 0;
    const maxMB = parseNumber(subscription.sizeMaxMB, 0) || 0;
    if (minMB > 0 && sizeMB > 0 && sizeMB < minMB) {
        return false;
    }
    if (maxMB > 0 && sizeMB > 0 && sizeMB > maxMB) {
        return false;
    }
    if ((minMB > 0 || maxMB > 0) && sizeMB <= 0) {
        return false;
    }

    const seedersMin = parseNumber(subscription.seedersMin, 0) || 0;
    const seeders = parseNumber(item.seeders, 0) || 0;
    if (seedersMin > 0 && seeders < seedersMin) {
        return false;
    }

    if (subscription.freeOnly && !isFreeRelease(item)) {
        return false;
    }

    const episode = parseNumber(item.episodeNumber, null);
    if (subscription.skipHalfEpisode && episode != null && Math.abs(episode - Math.trunc(episode)) >= 0.5) {
        return false;
    }
    const blockedEpisodes = parseEpisodeList(subscription.notDownloadEpisodes);
    if (blockedEpisodes.length && episodeInRanges(episode, blockedEpisodes)) {
        return false;
    }

    return true;
}

function parseStandbyRssLine(line = '', index = 0) {
    const text = String(line || '').trim();
    if (!text || text.startsWith('#')) {
        return null;
    }
    const parts = text.split('|').map(part => part.trim()).filter(Boolean);
    if (!parts.length) {
        return null;
    }

    let label = '';
    let url = '';
    let offset = 0;
    if (/^https?:\/\//i.test(parts[0])) {
        url = parts[0];
        label = parts[1] || '';
        offset = parseNumber(parts[2], 0) || 0;
    } else {
        label = parts[0] || '';
        url = parts[1] || '';
        offset = parseNumber(parts[2], 0) || 0;
    }
    if (!url) {
        return null;
    }
    return {
        label: label || `备用 RSS ${index + 1}`,
        url,
        offset
    };
}

function normalizeStandbyRssEntry(entry, index = 0) {
    if (!entry) {
        return null;
    }
    if (typeof entry === 'string') {
        return parseStandbyRssLine(entry, index);
    }
    if (typeof entry !== 'object') {
        return null;
    }
    const url = normalizeWhitespace(entry.url || entry.rssUrl || entry.feedUrl || '');
    if (!url) {
        return null;
    }
    return {
        label: normalizeWhitespace(entry.label || entry.name || entry.subgroup || `备用 RSS ${index + 1}`),
        url,
        offset: parseNumber(entry.offset ?? entry.episodeOffset, 0) || 0
    };
}

function parseStandbyRssList(value = '') {
    if (!value) {
        return [];
    }
    const parsed = typeof value === 'string' ? safeJsonParse(value, null) : value;
    const source = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object')
            ? [parsed]
            : String(value || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
    const seen = new Set();
    const result = [];
    source.forEach((entry, index) => {
        const normalized = normalizeStandbyRssEntry(entry, index);
        if (!normalized || seen.has(normalized.url)) {
            return;
        }
        seen.add(normalized.url);
        result.push(normalized);
    });
    return result;
}

function extractCustomEpisodeNumber(title = '', regexPattern = '', groupIndex = 1) {
    const regex = parseRegex(regexPattern, 'i');
    if (!regex) {
        return null;
    }
    const match = String(title || '').match(regex);
    if (!match) {
        return null;
    }
    const index = Math.max(0, Math.trunc(parseNumber(groupIndex, 1) || 1));
    const value = match.groups?.episode
        || match.groups?.ep
        || match[index]
        || match[1]
        || match[0];
    const numberMatch = String(value || '').match(/\d+(?:\.5)?/);
    if (!numberMatch) {
        return null;
    }
    const episode = Number(numberMatch[0]);
    return Number.isFinite(episode) && episode > 0 ? episode : null;
}

function applySubscriptionEpisodeRules(item = {}, subscription = {}, source = {}) {
    const next = { ...item };
    const title = normalizeWhitespace([item.rawTitle, item.title].filter(Boolean).join(' '));
    let episode = parseNumber(item.episodeNumber, null);

    if (subscription.customEpisode && subscription.customEpisodeRegex) {
        const customEpisode = extractCustomEpisodeNumber(
            title,
            subscription.customEpisodeRegex,
            subscription.customEpisodeGroupIndex
        );
        if (customEpisode != null) {
            episode = customEpisode;
        }
    }

    const offset = (parseNumber(subscription.episodeOffset, 0) || 0)
        + (parseNumber(source.offset, 0) || 0);
    if (episode != null && offset) {
        episode += offset;
    }
    if (episode != null && episode > 0) {
        next.episodeNumber = episode;
        next.episodeLabel = formatEpisodeNumber(episode);
    }

    if (source.master != null) {
        next.master = !!source.master;
    }
    if (source.label) {
        next.standbyLabel = source.label;
        if (!next.subgroup && !source.master) {
            next.subgroup = source.label;
        }
    }
    return next;
}

function resolveUrl(baseUrl = '', targetUrl = '') {
    const normalized = String(targetUrl || '').trim();
    if (!normalized) {
        return '';
    }
    try {
        return new URL(normalized, baseUrl || undefined).toString();
    } catch (_) {
        return normalized;
    }
}

function extractUrlCandidates(text = '', baseUrl = '') {
    const content = decodeHtmlEntities(String(text || ''));
    const result = [];
    const patterns = [
        /(magnet:\?[^\s"'<>]+)/gi,
        /(https?:\/\/[^\s"'<>]+)/gi,
        /href=["']([^"']+)["']/gi,
        /url=["']([^"']+)["']/gi
    ];
    for (const pattern of patterns) {
        let match = null;
        while ((match = pattern.exec(content)) !== null) {
            const candidate = resolveUrl(baseUrl, match[1] || match[0]);
            if (candidate) {
                result.push(candidate);
            }
        }
    }
    return [...new Set(result)];
}

function base32ToHex(value = '') {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of String(value || '').toUpperCase()) {
        const index = alphabet.indexOf(char);
        if (index < 0) {
            return '';
        }
        bits += index.toString(2).padStart(5, '0');
    }
    let hex = '';
    for (let index = 0; index + 4 <= bits.length; index += 4) {
        hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex.toUpperCase();
}

function extractInfoHashFromMagnet(magnetUrl = '') {
    const match = String(magnetUrl || '').match(/xt=urn:btih:([^&]+)/i);
    if (!match) {
        return '';
    }
    const rawHash = decodeURIComponent(match[1]).trim();
    if (/^[a-f0-9]{40}$/i.test(rawHash)) {
        return rawHash.toUpperCase();
    }
    if (/^[a-z2-7]{32}$/i.test(rawHash)) {
        return base32ToHex(rawHash);
    }
    return rawHash.toUpperCase();
}

function normalizeInfoHash(infoHash = '') {
    const normalized = String(infoHash || '').trim();
    if (!normalized) {
        return '';
    }
    if (/^[a-z2-7]{32}$/i.test(normalized)) {
        return base32ToHex(normalized);
    }
    return normalized.toUpperCase();
}

const RELEASE_TAG_PATTERNS = [
    { key: 'resolution', label: '2160p', regex: /\b(?:2160p|4k|3840\s*[xX]\s*2160)\b/i, value: '2160p' },
    { key: 'resolution', label: '1080p', regex: /\b(?:1080p|1920\s*[xX]\s*1080)\b/i, value: '1080p' },
    { key: 'resolution', label: '720p', regex: /\b(?:720p|1280\s*[xX]\s*720)\b/i, value: '720p' },
    { key: 'quality', label: 'BluRay', regex: /\b(?:blu[-\s]?ray|bdrip|bdremux|remux)\b/i, value: 'BluRay' },
    { key: 'quality', label: 'WEB-DL', regex: /\b(?:web[-\s]?dl|webrip|web)\b/i, value: 'WEB-DL' },
    { key: 'quality', label: 'HDTV', regex: /\b(?:hdtv|tv rip)\b/i, value: 'HDTV' },
    { key: 'codec', label: 'HEVC', regex: /\b(?:hevc|h\.?265|x265)\b/i, value: 'HEVC' },
    { key: 'codec', label: 'AVC', regex: /\b(?:avc|h\.?264|x264)\b/i, value: 'AVC' },
    { key: 'codec', label: 'AV1', regex: /\bav1\b/i, value: 'AV1' },
    { key: 'effect', label: 'Dolby Vision', regex: /\b(?:dolby\s*vision|dovi|dv)\b/i, value: 'Dolby Vision' },
    { key: 'effect', label: 'HDR', regex: /\b(?:hdr10\+?|hdr)\b/i, value: 'HDR' },
    { key: 'bitDepth', label: '10bit', regex: /\b(?:10bit|10-bit|hi10p)\b/i, value: '10bit' },
    { key: 'audio', label: 'FLAC', regex: /\bflac\b/i, value: 'FLAC' },
    { key: 'audio', label: 'AAC', regex: /\baac\b/i, value: 'AAC' },
    { key: 'audio', label: 'Atmos', regex: /\batmos\b/i, value: 'Atmos' },
    { key: 'subtitleType', label: '内嵌', regex: /内嵌|硬字幕|hardsub/i, value: '内嵌' },
    { key: 'subtitleType', label: '内封', regex: /内封|软字幕|softsub/i, value: '内封' },
    { key: 'subtitleType', label: '外挂', regex: /外挂/i, value: '外挂' },
    { key: 'language', label: '简繁', regex: /简繁|简日|繁日|简体|繁体|chs|cht|sc|tc/i, value: '简繁' },
    { key: 'container', label: 'MKV', regex: /\bmkv\b/i, value: 'MKV' },
    { key: 'container', label: 'MP4', regex: /\bmp4\b/i, value: 'MP4' }
];

const NON_SUBGROUP_TAG_PATTERN = /^(?:hevc|avc|aac|flac|dts|atmos|webrip|web-dl|bdrip|bluray|mkv|mp4|1080p|720p|2160p|4k|10bit|hi10p|简|繁|日|内封|内嵌|外挂|gb|big5)$/i;

function extractBracketTokens(title = '') {
    const tokens = [];
    const pattern = /[\[【]([^\]】]{1,60})[\]】]/g;
    let match = null;
    while ((match = pattern.exec(String(title || ''))) !== null) {
        const token = normalizeWhitespace(match[1]);
        if (token) {
            tokens.push(token);
        }
    }
    return tokens;
}

function extractSubgroupFromTitle(title = '') {
    const match = String(title || '').match(/^\s*[\[【]([^\]】]{1,60})[\]】]/);
    if (!match) {
        return '';
    }
    const candidate = normalizeWhitespace(match[1]);
    if (!candidate || NON_SUBGROUP_TAG_PATTERN.test(candidate) || /^\d+$/.test(candidate)) {
        return '';
    }
    return candidate;
}

function cnNumberToInt(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw === '十') return 10;
    if (raw.startsWith('十')) {
        return 10 + (map[raw.slice(1)] || 0);
    }
    if (raw.includes('十')) {
        const [left, right] = raw.split('十');
        return (map[left] || 0) * 10 + (map[right] || 0);
    }
    return map[raw] || 0;
}

function pickEpisodeNumber(title = '') {
    const text = normalizeWhitespace(title);
    const patterns = [
        /\bS\d{1,2}E(\d{1,3}(?:\.5)?)(?:v\d+)?\b/i,
        /(?:^|[\s_\-.\[【])(?:第\s*)?(\d{1,3}(?:\.5)?)\s*[话話集](?:\s|$|[\]】]).*/i,
        /(?:^|[\s_\-.\[【])(?:EP?|Episode)\s*\.?\s*(\d{1,3}(?:\.5)?)(?:v\d+)?(?:\s|$|[\]】]).*/i,
        /\s-\s*(\d{1,3}(?:\.5)?)(?:\s|$|[\]】(])/i,
        /[\[【]\s*(\d{1,3}(?:\.5)?)(?:\s*(?:v\d+|END|完|FIN))?\s*[\]】]/i,
        /(?:^|[\s_\-.])(\d{1,3}(?:\.5)?)(?:v\d+)?(?:\s*\[[^\]]+\])?(?:\s|$)/i
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) {
            continue;
        }
        const episode = Number(match[1]);
        if (Number.isFinite(episode) && episode > 0 && episode < 1000) {
            return episode;
        }
    }
    return null;
}

function pickSeasonNumber(title = '') {
    const text = normalizeWhitespace(title);
    const match = text.match(/\bS(\d{1,2})E\d{1,3}/i)
        || text.match(/\bS(\d{1,2})\b/i)
        || text.match(/\bSeason\s*(\d{1,2})\b/i)
        || text.match(/第\s*([一二两三四五六七八九十\d]{1,3})\s*季/i);
    if (!match) {
        return null;
    }
    const season = cnNumberToInt(match[1]);
    return season > 0 ? season : null;
}

function formatEpisodeNumber(episodeNumber) {
    const value = Number(episodeNumber);
    if (!Number.isFinite(value) || value <= 0) {
        return '';
    }
    const whole = Math.trunc(value);
    const suffix = Math.abs(value - whole) >= 0.5 ? '.5' : '';
    return `${String(whole).padStart(2, '0')}${suffix}`;
}

function extractReleaseMetadata(title = '', description = '', labels = []) {
    const content = normalizeWhitespace([
        title,
        description,
        Array.isArray(labels) ? labels.join(' ') : ''
    ].filter(Boolean).join(' '));
    const metadata = {
        subgroup: extractSubgroupFromTitle(title),
        seasonNumber: pickSeasonNumber(title),
        episodeNumber: pickEpisodeNumber(title),
        episodeLabel: '',
        resolution: '',
        quality: '',
        codec: '',
        effect: '',
        audio: '',
        bitDepth: '',
        subtitleType: '',
        language: '',
        container: '',
        tags: []
    };
    if (metadata.episodeNumber != null) {
        metadata.episodeLabel = formatEpisodeNumber(metadata.episodeNumber);
    }

    const tags = new Set([
        ...extractBracketTokens(title),
        ...(Array.isArray(labels) ? labels : [])
    ].map(normalizeWhitespace).filter(Boolean));

    for (const pattern of RELEASE_TAG_PATTERNS) {
        if (!pattern.regex.test(content)) {
            continue;
        }
        if (!metadata[pattern.key]) {
            metadata[pattern.key] = pattern.value;
        }
        tags.add(pattern.label);
    }

    metadata.tags = [...tags].slice(0, 30);
    return metadata;
}

function buildEpisodeDedupKey(item = {}) {
    const episode = parseNumber(item.episodeNumber, null);
    if (episode == null || episode <= 0) {
        return '';
    }
    const season = parseNumber(item.seasonNumber, 1) || 1;
    return `${season}:${episode}`;
}

function calcCasSliceSize(fileSize) {
    const size = Number(fileSize) || 0;
    if (size > CAS_SLICE_SIZE * 2 * 999) {
        const multiplier = Math.max(Math.ceil(size / 1999 / CAS_SLICE_SIZE), 5);
        return multiplier * CAS_SLICE_SIZE;
    }
    if (size > CAS_SLICE_SIZE * 999) {
        return CAS_SLICE_SIZE * 2;
    }
    return CAS_SLICE_SIZE;
}

async function computeFileHashes(filePath) {
    const stat = await fs.promises.stat(filePath);
    const fileSize = Number(stat.size || 0);
    const sliceSize = calcCasSliceSize(fileSize);
    const fileMd5 = crypto.createHash('md5');
    let currentSliceHash = crypto.createHash('md5');
    let currentSliceBytes = 0;
    const partMd5Hexs = [];
    const partInfos = [];
    let partNumber = 1;

    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => {
            fileMd5.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const remainingSliceBytes = sliceSize - currentSliceBytes;
                const end = Math.min(offset + remainingSliceBytes, chunk.length);
                const sliceChunk = chunk.subarray(offset, end);
                currentSliceHash.update(sliceChunk);
                currentSliceBytes += sliceChunk.length;
                offset = end;

                if (currentSliceBytes === sliceSize) {
                    const sliceDigest = currentSliceHash.digest();
                    const sliceHex = sliceDigest.toString('hex').toUpperCase();
                    partMd5Hexs.push(sliceHex);
                    partInfos.push(`${partNumber}-${sliceDigest.toString('base64')}`);
                    partNumber += 1;
                    currentSliceHash = crypto.createHash('md5');
                    currentSliceBytes = 0;
                }
            }
        });
        stream.once('error', reject);
        stream.once('end', () => {
            if (currentSliceBytes > 0 || partMd5Hexs.length === 0) {
                const sliceDigest = currentSliceHash.digest();
                const sliceHex = sliceDigest.toString('hex').toUpperCase();
                partMd5Hexs.push(sliceHex);
                partInfos.push(`${partNumber}-${sliceDigest.toString('base64')}`);
            }
            resolve();
        });
    });

    const fileMd5Hex = fileMd5.digest('hex').toUpperCase();
    let sliceMd5Hex = fileMd5Hex;
    if (fileSize > sliceSize && partMd5Hexs.length > 1) {
        sliceMd5Hex = crypto.createHash('md5').update(partMd5Hexs.join('\n')).digest('hex').toUpperCase();
    }

    return {
        size: fileSize,
        sliceSize,
        md5: fileMd5Hex,
        sliceMd5: sliceMd5Hex,
        partMd5Hexs,
        partInfos
    };
}

async function collectLocalFiles(rootPath) {
    const stat = await fs.promises.stat(rootPath);
    if (!stat.isDirectory()) {
        return [{
            fullPath: rootPath,
            name: path.basename(rootPath),
            relativePath: path.basename(rootPath),
            relativeDir: '',
            size: Number(stat.size || 0)
        }];
    }

    const result = [];
    const walk = async (currentPath) => {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const fileStat = await fs.promises.stat(fullPath);
            const relativePath = normalizeRelativePath(path.relative(rootPath, fullPath));
            const relativeDir = path.dirname(relativePath);
            result.push({
                fullPath,
                name: entry.name,
                relativePath,
                relativeDir: relativeDir === '.' ? '' : normalizeRelativePath(relativeDir),
                size: Number(fileStat.size || 0)
            });
        }
    };

    await walk(rootPath);
    result.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
    return result;
}

function buildCasContent(casInfo = {}) {
    const payload = {
        name: String(casInfo.name || '').trim(),
        size: Number(casInfo.size || 0) || 0,
        md5: String(casInfo.md5 || '').trim().toUpperCase(),
        sliceMd5: String(casInfo.sliceMd5 || '').trim().toUpperCase(),
        createTime: casInfo.createTime || new Date().toISOString()
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function buildMultipartBody(fields = {}, files = []) {
    const boundary = `----Cloud189AutoSave${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const chunks = [];
    const push = (value) => {
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    };

    Object.entries(fields || {}).forEach(([name, value]) => {
        if (value == null) {
            return;
        }
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
        push(`${value}\r\n`);
    });

    for (const file of files || []) {
        if (!file || file.content == null) {
            continue;
        }
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${file.fieldName || 'file'}"; filename="${file.fileName || 'file.bin'}"\r\n`);
        push(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
        push(file.content);
        push('\r\n');
    }

    push(`--${boundary}--\r\n`);
    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

function tryExtractCasMetadataFromText(text = '', fileName = '', size = 0) {
    const rawText = decodeHtmlEntities(String(text || ''));
    const md5Match = rawText.match(/(?:^|[^a-z])(md5|filemd5)[^a-f0-9]{0,12}([a-f0-9]{32})(?:[^a-z0-9]|$)/i);
    const sliceMd5Match = rawText.match(/(?:slice[_\s-]?md5|slicemd5)[^a-f0-9]{0,12}([a-f0-9]{32})(?:[^a-z0-9]|$)/i);
    if (!md5Match || !sliceMd5Match) {
        return null;
    }
    return {
        name: fileName || '',
        size: Number(size || 0) || 0,
        md5: md5Match[2].toUpperCase(),
        sliceMd5: sliceMd5Match[1].toUpperCase()
    };
}

module.exports = {
    buildCasContent,
    buildMultipartBody,
    buildPatternMatcher,
    calcCasSliceSize,
    collectLocalFiles,
    computeFileHashes,
    decodeHtmlEntities,
    applySubscriptionEpisodeRules,
    buildEpisodeDedupKey,
    episodeInRanges,
    extractInfoHashFromMagnet,
    extractReleaseMetadata,
    extractUrlCandidates,
    formatEpisodeNumber,
    getReleaseContent,
    isFreeRelease,
    matchReleaseFilters,
    matchReleaseTitle,
    normalizeInfoHash,
    normalizeRelativePath,
    normalizeWhitespace,
    parseEpisodeList,
    parseNumber,
    parseStandbyRssList,
    parseSizeToBytes,
    resolveUrl,
    safeFileName,
    safeJsonParse,
    stripHtml,
    tryExtractCasMetadataFromText
};
