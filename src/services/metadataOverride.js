const crypto = require('crypto');
const path = require('path');
const { parseMediaTitle } = require('../utils/mediaTitleParser');

const METADATA_VERSION = 1;
const SOURCES = new Set(['user', 'agent', 'template']);
const MEDIA_TYPES = new Set(['movie', 'tv']);
const TARGET_TYPES = new Set(['task', 'pt_subscription', 'pt_release']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.webm', '.strm']);

function parseJson(value, fallback = null) {
    if (value && typeof value === 'object') return value;
    try { return JSON.parse(value || ''); } catch (_) { return fallback; }
}

function normalizeRelativePath(value = '', { allowEmpty = false } = {}) {
    const raw = String(value || '').replace(/\\/g, '/').trim();
    if (!raw && allowEmpty) return '';
    if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\0')) {
        throw new Error('元数据文件路径必须是非空相对路径');
    }
    const normalized = path.posix.normalize(raw);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`元数据文件路径越界: ${raw}`);
    }
    return normalized;
}

function normalizeEpisode(value, { optional = true } = {}) {
    if ((value === '' || value === null || value === undefined) && optional) return null;
    const episode = Number(value);
    if (!Number.isFinite(episode) || episode < 0 || Math.round(episode * 2) !== episode * 2) {
        throw new Error('集号必须是非负整数或 .5 半集');
    }
    return episode;
}

function normalizeLocks(locks = {}, source = 'user') {
    const output = {};
    if (!locks || typeof locks !== 'object' || Array.isArray(locks)) return output;
    for (const [key, value] of Object.entries(locks)) {
        if (typeof value === 'boolean') output[String(key)] = value;
    }
    if (source === 'user' && !Object.keys(output).length) output['*'] = true;
    return output;
}

function normalizeMetadataOverride(input = {}, options = {}) {
    const data = parseJson(input, {}) || {};
    const source = String(options.source || data.source || 'user').toLowerCase();
    if (!SOURCES.has(source)) throw new Error('元数据来源必须是 user、agent 或 template');
    const workInput = data.work && typeof data.work === 'object' ? data.work : {};
    const templateInput = data.template && typeof data.template === 'object' ? data.template : {};
    const mediaType = String(workInput.mediaType || '').toLowerCase();
    if (mediaType && !MEDIA_TYPES.has(mediaType)) throw new Error('媒体类型必须是 movie 或 tv');
    const seasonNumber = workInput.seasonNumber === '' || workInput.seasonNumber == null
        ? null
        : Number(workInput.seasonNumber);
    if (seasonNumber != null && (!Number.isInteger(seasonNumber) || seasonNumber < 0)) throw new Error('季号必须是非负整数');
    const totalEpisodes = workInput.totalEpisodes === '' || workInput.totalEpisodes == null
        ? null
        : Number(workInput.totalEpisodes);
    if (totalEpisodes != null && (!Number.isInteger(totalEpisodes) || totalEpisodes < 0)) throw new Error('总集数必须是非负整数');
    const defaultSeasonNumber = templateInput.defaultSeasonNumber === '' || templateInput.defaultSeasonNumber == null
        ? null
        : Number(templateInput.defaultSeasonNumber);
    if (defaultSeasonNumber != null && (!Number.isInteger(defaultSeasonNumber) || defaultSeasonNumber < 0)) throw new Error('模板默认季号必须是非负整数');
    const episodeOffset = templateInput.episodeOffset === '' || templateInput.episodeOffset == null
        ? 0
        : Number(templateInput.episodeOffset);
    if (!Number.isFinite(episodeOffset) || Math.round(episodeOffset * 2) !== episodeOffset * 2) throw new Error('模板集号偏移必须是整数或 .5');

    const files = [];
    const seenPaths = new Set();
    for (const raw of Array.isArray(data.files) ? data.files : []) {
        if (!raw || typeof raw !== 'object') continue;
        const relativePath = normalizeRelativePath(raw.relativePath || raw.path || '');
        if (seenPaths.has(relativePath)) throw new Error(`元数据文件路径重复: ${relativePath}`);
        seenPaths.add(relativePath);
        const special = raw.special === true || raw.sp === true;
        const fileSeason = raw.seasonNumber === '' || raw.seasonNumber == null
            ? (special ? 0 : null)
            : Number(raw.seasonNumber);
        if (fileSeason != null && (!Number.isInteger(fileSeason) || fileSeason < 0)) throw new Error(`文件季号无效: ${relativePath}`);
        const episodeNumber = normalizeEpisode(raw.episodeNumber ?? raw.episode, { optional: true });
        const targetFileName = raw.targetFileName == null ? '' : String(raw.targetFileName).trim();
        if (targetFileName && (targetFileName.includes('/') || targetFileName.includes('\\') || targetFileName === '.' || targetFileName === '..')) {
            throw new Error(`目标主文件名不能包含路径: ${relativePath}`);
        }
        files.push({
            relativePath,
            seasonNumber: special ? 0 : fileSeason,
            episodeNumber,
            special,
            episodeTitle: String(raw.episodeTitle || '').trim(),
            targetFileName,
            locks: normalizeLocks(raw.locks, source)
        });
    }

    return {
        version: METADATA_VERSION,
        source,
        work: {
            tmdbId: String(workInput.tmdbId || '').trim(),
            title: String(workInput.title || '').trim(),
            year: workInput.year === '' || workInput.year == null ? '' : String(workInput.year).trim(),
            mediaType,
            category: String(workInput.category || '').trim(),
            seasonNumber,
            seasonName: String(workInput.seasonName || '').trim(),
            totalEpisodes,
            locks: normalizeLocks(workInput.locks, source)
        },
        template: { defaultSeasonNumber, episodeOffset },
        files,
        fingerprint: String(data.fingerprint || options.fingerprint || '').trim(),
        updatedAt: options.updatedAt || data.updatedAt || new Date().toISOString()
    };
}

function isLocked(locks, field) {
    return Boolean(locks && (locks['*'] || locks[field]));
}

function mergeMetadataOverrides({ template = null, agent = null, user = null } = {}) {
    const layerEntries = [[template, 'template'], [agent, 'agent'], [user, 'user']];
    const layers = layerEntries
        .filter(([value]) => Boolean(value))
        .map(([value, source]) => normalizeMetadataOverride(value, { source }));
    if (!layers.length) return null;
    const output = normalizeMetadataOverride({}, { source: layers.at(-1).source });
    const workLocks = {};
    const filesByPath = new Map();
    for (const layer of layers) {
        for (const field of ['tmdbId', 'title', 'year', 'mediaType', 'category', 'seasonNumber', 'seasonName', 'totalEpisodes']) {
            const value = layer.work[field];
            if (value !== '' && value !== null && value !== undefined && !isLocked(workLocks, field)) output.work[field] = value;
        }
        Object.assign(workLocks, layer.work.locks || {});
        if (layer.template.defaultSeasonNumber != null) output.template.defaultSeasonNumber = layer.template.defaultSeasonNumber;
        output.template.episodeOffset = Number(layer.template.episodeOffset || 0);
        for (const item of layer.files) {
            const current = filesByPath.get(item.relativePath) || {
                relativePath: item.relativePath, seasonNumber: null, episodeNumber: null,
                special: false, episodeTitle: '', targetFileName: '', locks: {}
            };
            for (const field of ['seasonNumber', 'episodeNumber', 'special', 'episodeTitle', 'targetFileName']) {
                const value = item[field];
                if (value !== '' && value !== null && value !== undefined && !isLocked(current.locks, field)) current[field] = value;
            }
            Object.assign(current.locks, item.locks || {});
            filesByPath.set(item.relativePath, current);
        }
        output.source = layer.source;
        output.fingerprint = layer.fingerprint || output.fingerprint;
        output.updatedAt = layer.updatedAt;
    }
    output.work.locks = workLocks;
    output.files = [...filesByPath.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true }));
    return output;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function comparableOverride(value) {
    if (!value) return null;
    const normalized = normalizeMetadataOverride(value, { source: parseJson(value, value)?.source || 'user', updatedAt: '' });
    delete normalized.updatedAt;
    return stableValue(normalized);
}

function overridesEqual(left, right) {
    return JSON.stringify(comparableOverride(left)) === JSON.stringify(comparableOverride(right));
}

function buildFileFingerprint(files = []) {
    const normalized = files.map(file => ({
        relativePath: normalizeRelativePath(file.relativePath || file.path || file.name || ''),
        size: Number(file.size || 0),
        id: String(file.id || file.fileId || file.md5 || '')
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function inspectFiles(files = [], defaults = {}) {
    const fingerprint = buildFileFingerprint(files);
    return {
        fingerprint,
        files: files.map(file => {
            const relativePath = normalizeRelativePath(file.relativePath || file.path || file.name || '');
            const parsed = parseMediaTitle(path.posix.basename(relativePath));
            const special = /(?:^|[\s._-])(?:SP|OVA|OAD|NCOP|NCED)(?:[\s._-]|\d|$)/i.test(relativePath);
            const halfMatch = path.posix.basename(relativePath).match(/(?:S\d{1,2})?E(?:P)?\s*(\d{1,3}\.5)|(?:^|[\s._-])(\d{1,3}\.5)(?=[\s._-]|\.[A-Za-z0-9]+$)/i);
            const parsedEpisode = halfMatch ? Number(halfMatch[1] || halfMatch[2]) : parsed.episode;
            return {
                fileRef: crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 24),
                relativePath,
                name: path.posix.basename(relativePath),
                size: Number(file.size || 0),
                automatic: {
                    seasonNumber: special ? 0 : (parsed.season ?? defaults.defaultSeasonNumber ?? null),
                    episodeNumber: parsedEpisode == null ? null : Number(parsedEpisode) + Number(defaults.episodeOffset || 0),
                    special
                }
            };
        })
    };
}

function validateOverrideFiles(override, inspectedFiles = []) {
    const available = new Set(inspectedFiles.map(file => normalizeRelativePath(file.relativePath || file.path || file.name || '')));
    for (const file of override.files || []) {
        if (!available.has(file.relativePath)) throw new Error(`元数据映射的文件已变化或不存在: ${file.relativePath}`);
    }
}

function buildMetadataPlan({ targetType, targetId, targetRef = '', current = null, proposed, template = null, fingerprint = '', inspectedFiles = [] }) {
    if (!TARGET_TYPES.has(targetType)) throw new Error('不支持的元数据目标类型');
    const normalized = normalizeMetadataOverride(proposed, { source: parseJson(proposed, proposed)?.source || 'user', fingerprint });
    validateOverrideFiles(normalized, inspectedFiles);
    const currentValue = parseJson(current, current);
    const currentUser = currentValue?.source === 'user' ? currentValue : null;
    const merged = normalized.source === 'agent'
        ? mergeMetadataOverrides({ template, agent: normalized, user: currentUser })
        : mergeMetadataOverrides({ template, user: normalized });
    if (overridesEqual(current, merged)) {
        return { noop: true, fingerprint: normalized.fingerprint || fingerprint, preview: buildPreview(current, merged) };
    }
    return {
        noop: false,
        targetType,
        targetId,
        targetRef,
        fingerprint: normalized.fingerprint || fingerprint,
        override: merged,
        preview: buildPreview(current, merged)
    };
}

function buildPreview(current, next) {
    const before = current ? normalizeMetadataOverride(current, { source: parseJson(current, current)?.source || 'user' }) : null;
    const after = next ? normalizeMetadataOverride(next, { source: parseJson(next, next)?.source || 'user' }) : null;
    const changes = [];
    for (const field of ['tmdbId', 'title', 'year', 'mediaType', 'category', 'seasonNumber', 'seasonName', 'totalEpisodes']) {
        if ((before?.work?.[field] ?? null) !== (after?.work?.[field] ?? null)) changes.push({ scope: 'work', field, before: before?.work?.[field] ?? null, after: after?.work?.[field] ?? null });
    }
    const oldFiles = new Map((before?.files || []).map(item => [item.relativePath, item]));
    for (const file of after?.files || []) {
        const old = oldFiles.get(file.relativePath);
        if (!old || JSON.stringify(stableValue(old)) !== JSON.stringify(stableValue(file))) changes.push({ scope: 'file', relativePath: file.relativePath, before: old || null, after: file });
    }
    return { changeCount: changes.length, changes, result: after };
}

class MetadataPlanStore {
    constructor(options = {}) {
        this.ttlMs = Number(options.ttlMs || 5 * 60 * 1000);
        this.plans = new Map();
    }

    issue(plan, scope = {}) {
        const planToken = crypto.randomUUID();
        this.plans.set(planToken, { plan, scope, expiresAt: Date.now() + this.ttlMs });
        return planToken;
    }

    consume(planToken, scope = {}) {
        const key = String(planToken || '');
        const entry = this.plans.get(key);
        this.plans.delete(key);
        if (!entry || entry.expiresAt <= Date.now()) throw new Error('元数据计划令牌不存在或已失效');
        for (const field of ['intentId', 'targetRef', 'candidateId']) {
            if (scope[field] != null && String(entry.scope[field] || '') !== String(scope[field] || '')) throw new Error('元数据计划令牌不属于当前作用域');
        }
        return entry.plan;
    }
}

function buildMetadataTemplate(tmdbInfo = {}, source = 'agent') {
    const seasonNumber = Number(tmdbInfo?.seasonNumber ?? tmdbInfo?.season_number ?? 1);
    return normalizeMetadataOverride({
        source,
        work: {
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : '',
            title: tmdbInfo?.title || tmdbInfo?.name || '',
            year: tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '',
            mediaType: tmdbInfo?.type === 'movie' ? 'movie' : 'tv',
            seasonNumber: Number.isInteger(seasonNumber) && seasonNumber >= 0 ? seasonNumber : 1,
            seasonName: tmdbInfo?.seasonName || '',
            totalEpisodes: Number(tmdbInfo?.totalEpisodes || 0) || null
        },
        template: { defaultSeasonNumber: Number.isInteger(seasonNumber) && seasonNumber >= 0 ? seasonNumber : 1, episodeOffset: 0 },
        files: []
    }, { source });
}

module.exports = {
    METADATA_VERSION,
    MetadataPlanStore,
    normalizeMetadataOverride,
    mergeMetadataOverrides,
    normalizeRelativePath,
    inspectFiles,
    buildFileFingerprint,
    buildMetadataPlan,
    buildMetadataTemplate,
    buildPreview,
    overridesEqual,
    parseJson
};
