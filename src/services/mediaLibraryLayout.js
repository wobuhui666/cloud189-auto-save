/**
 * 统一媒体库布局服务
 * 目标路径：{localStrmPrefix}/{分类}/{作品名 (年)}[/Season XX]/文件
 *
 * 命名优先级：
 * 已锁定 libraryLayout > TMDB > 确定性正则 > AI > 原名回退
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const { parseMediaTitle } = require('../utils/mediaTitleParser');
const { logTaskEvent } = require('../utils/logUtils');

const PROMPT_VERSION = 'v1';

function normalizeRelativePath(value = '') {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/');
}

function sanitizePathSegment(value = '') {
    return String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function sanitizeTitle(title = '') {
    return String(title || '')
        .replace(/\(根\)$/g, '')
        .replace(/[\[【(（](19|20)\d{2}[\]】)）]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractYear(value = '') {
    const matched = String(value || '').match(/(19|20)\d{2}/);
    return matched ? matched[0] : '';
}

function pad2(value) {
    const num = parseInt(String(value || ''), 10);
    if (!Number.isFinite(num) || num <= 0) {
        return '01';
    }
    return String(num).padStart(2, '0');
}

function joinPosix(...parts) {
    return normalizeRelativePath(parts.filter(Boolean).join('/'));
}

/**
 * 账号 localStrmPrefix 规范化（模块级，供 joinLocalStrmPath 等复用）：
 * - 去掉首尾斜杠
 * - 忽略裸挂载名 "strm"（物理根已是 strm 目录，再拼会变成 strm/strm）
 */
function normalizeLocalStrmPrefix(localStrmPrefix = '') {
    const prefix = normalizeRelativePath(localStrmPrefix || '');
    if (!prefix || prefix === 'strm' || prefix === '.') {
        return '';
    }
    if (prefix.startsWith('strm/')) {
        // 若用户把前缀写成 strm/emby，则保留 emby 段
        return prefix.replace(/^strm\//, '');
    }
    return prefix;
}

/**
 * 规范化 localStrmPrefix 后与业务相对段拼接（避免裸 path.join 叠出 strm/...）
 */
function joinLocalStrmPath(localStrmPrefix = '', ...parts) {
    return joinPosix(normalizeLocalStrmPrefix(localStrmPrefix), ...parts.map((p) => normalizeRelativePath(p)));
}

class MediaLibraryLayoutService {
    constructor(options = {}) {
        this.taskService = options.taskService || null;
        this.tmdbService = options.tmdbService || null;
        this.aiService = options.aiService || null;
        this.cacheDir = path.join(__dirname, '../../data/ai-cache');
    }

    getCategoryMap() {
        return {
            tv: ConfigService.getConfigValue('organizer.categories.tv', '电视剧'),
            anime: ConfigService.getConfigValue('organizer.categories.anime', '动漫'),
            movie: ConfigService.getConfigValue('organizer.categories.movie', '电影'),
            variety: ConfigService.getConfigValue('organizer.categories.variety', '综艺'),
            documentary: ConfigService.getConfigValue('organizer.categories.documentary', '纪录片')
        };
    }

    parseTaskTmdbContent(tmdbContent) {
        if (!tmdbContent) return null;
        try {
            const parsed = JSON.parse(tmdbContent);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    parseTaskLibraryLayout(task = {}) {
        if (task?.libraryLayout) {
            if (typeof task.libraryLayout === 'object') {
                return this.normalizeLibraryInfo(task.libraryLayout);
            }
            try {
                const parsed = JSON.parse(task.libraryLayout);
                return this.normalizeLibraryInfo(parsed);
            } catch (_) {}
        }
        // 兼容塞在 tmdbContent.libraryLayout
        const tmdb = this.parseTaskTmdbContent(task?.tmdbContent);
        if (tmdb?.libraryLayout) {
            return this.normalizeLibraryInfo(tmdb.libraryLayout);
        }
        return null;
    }

    normalizeLibraryInfo(info = {}) {
        const mediaType = info.mediaType || info.type || 'tv';
        const categories = this.getCategoryMap();
        const categoryName = sanitizePathSegment(
            info.categoryName || (mediaType === 'movie' ? categories.movie : categories.tv)
        );
        const canonicalTitle = sanitizePathSegment(
            info.canonicalTitle || info.title || info.name || '未命名'
        ) || '未命名';
        const year = String(info.year || '').trim();
        const resourceFolderName = sanitizePathSegment(
            info.resourceFolderName || (year ? `${canonicalTitle} (${year})` : canonicalTitle)
        );
        return {
            mediaType: mediaType === 'movie' ? 'movie' : 'tv',
            isAnime: !!info.isAnime || categoryName === categories.anime,
            categoryName,
            canonicalTitle,
            year: year ? String(year) : '',
            resourceFolderName,
            seasonBased: mediaType !== 'movie',
            tmdbId: info.tmdbId ? String(info.tmdbId) : (info.id ? String(info.id) : ''),
            locked: info.locked !== false
        };
    }

    /**
     * 账号 localStrmPrefix 规范化：
     * - 去掉首尾斜杠
     * - 忽略裸挂载名 "strm"（物理根已是 strm 目录，再拼会变成 strm/strm）
     */
    normalizeLocalStrmPrefix(localStrmPrefix = '') {
        return normalizeLocalStrmPrefix(localStrmPrefix);
    }

    /**
     * 规范化 localStrmPrefix 后拼接业务相对段
     */
    joinLocalStrmPath(localStrmPrefix = '', ...parts) {
        return joinLocalStrmPath(localStrmPrefix, ...parts);
    }

    buildStrmRoot(localStrmPrefix, libraryInfo) {
        const prefix = this.normalizeLocalStrmPrefix(localStrmPrefix);
        const info = this.normalizeLibraryInfo(libraryInfo);
        return joinPosix(prefix, info.categoryName, info.resourceFolderName);
    }

    buildRelativeDir(file = {}, aiFile = null, libraryInfo = {}) {
        const info = this.normalizeLibraryInfo(libraryInfo);
        if (!info.seasonBased) {
            return '';
        }
        if (aiFile) {
            const seasonValue = String(aiFile.season || '').trim();
            if (/^\d+$/.test(seasonValue)) {
                return `Season ${seasonValue.padStart(2, '0')}`;
            }
            if (seasonValue) {
                return sanitizePathSegment(seasonValue);
            }
        }
        const relativeDir = normalizeRelativePath(file.relativeDir || '');
        const parts = relativeDir ? relativeDir.split('/').filter(Boolean) : [];
        const seasonPart = parts.find((part) => /^(season\s*\d+|s\d+|specials?|特别篇\d*)$/i.test(part));
        if (seasonPart) {
            const m = String(seasonPart).match(/(\d{1,2})/);
            if (m) return `Season ${pad2(m[1])}`;
            if (/special|特别/i.test(seasonPart)) return '特别篇01';
            return sanitizePathSegment(seasonPart);
        }
        // 从文件名确定性解析
        const parsed = parseMediaTitle(file.name || file.restoreName || file.originalFileName || '');
        if (parsed.season != null) {
            return `Season ${pad2(parsed.season)}`;
        }
        return 'Season 01';
    }

    buildFileName(file, aiFile, resourceInfo, libraryInfo) {
        const info = this.normalizeLibraryInfo(libraryInfo || {});
        const isMovie = (resourceInfo?.type || info.mediaType) === 'movie';
        const template = isMovie
            ? (ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}')
            : (ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}');

        const name = aiFile?.name || info.canonicalTitle || resourceInfo?.name || sanitizeTitle(file.name);
        const year = String(resourceInfo?.year || info.year || '');
        const season = pad2(aiFile?.season || '01');
        const episode = (() => {
            const raw = String(aiFile?.episode || '01');
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num)) return '01';
            return num >= 100 ? String(num) : String(num).padStart(2, '0');
        })();
        const ext = aiFile?.extension || path.extname(file.name || file.restoreName || '') || '';
        const replaceMap = {
            '{name}': name,
            '{year}': year,
            '{s}': season,
            '{e}': episode,
            '{sn}': String(parseInt(season, 10) || 1),
            '{en}': String(parseInt(episode, 10) || 1),
            '{ext}': ext.startsWith('.') || !ext ? ext : `.${ext}`,
            '{se}': `S${season}E${episode}`
        };
        let newName = template;
        for (const [key, value] of Object.entries(replaceMap)) {
            newName = newName.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
        }
        return sanitizePathSegment(newName) || (file.name || file.restoreName || 'file');
    }

    serializeLibraryLayout(libraryInfo) {
        return JSON.stringify(this.normalizeLibraryInfo(libraryInfo));
    }

    /**
     * 解析媒体库信息。forceRefresh=true 时忽略已锁定 layout。
     */
    async resolveLibraryInfo({
        resourceName = '',
        files = [],
        tmdbInfo = null,
        task = null,
        forceRefresh = false,
        useAi = true
    } = {}) {
        const locked = !forceRefresh ? this.parseTaskLibraryLayout(task) : null;
        if (locked?.resourceFolderName) {
            return locked;
        }

        const parsedResource = parseMediaTitle(resourceName || task?.resourceName || '');
        let resourceInfo = {
            name: sanitizeTitle(parsedResource.cleanTitle || resourceName || task?.resourceName || '未命名') || '未命名',
            year: parsedResource.year || extractYear(resourceName) || '',
            type: 'tv',
            episode: []
        };

        // 确定性：从文件列表补季集
        const sortedFiles = [...(files || [])].sort((a, b) =>
            String(a.name || a.restoreName || '').localeCompare(String(b.name || b.restoreName || ''), 'zh-CN', {
                numeric: true,
                sensitivity: 'base'
            })
        );

        // AI（可选，带缓存）
        if (useAi && this.taskService && sortedFiles.length) {
            try {
                const aiInfo = await this._analyzeWithCache(
                    resourceName || task?.resourceName || '',
                    sortedFiles.map((f) => ({ id: String(f.id || f.entryKey || f.name), name: f.name || f.restoreName || '' }))
                );
                if (aiInfo?.name) {
                    resourceInfo = {
                        ...resourceInfo,
                        name: sanitizeTitle(aiInfo.name) || resourceInfo.name,
                        year: aiInfo.year || resourceInfo.year,
                        type: aiInfo.type === 'movie' ? 'movie' : 'tv',
                        season: aiInfo.season,
                        episode: Array.isArray(aiInfo.episode) ? aiInfo.episode : []
                    };
                }
            } catch (error) {
                logTaskEvent(`[Layout] AI 分析失败，使用确定性回退: ${error.message}`);
            }
        } else if (sortedFiles.length) {
            let hasSeasonEpisodeHint = parsedResource.season != null || parsedResource.episode != null;
            resourceInfo.episode = sortedFiles.map((file, index) => {
                const parsed = parseMediaTitle(file.name || file.restoreName || '');
                if (parsed.season != null || parsed.episode != null) {
                    hasSeasonEpisodeHint = true;
                }
                return {
                    id: String(file.id || file.entryKey || index),
                    name: resourceInfo.name,
                    season: parsed.season != null ? pad2(parsed.season) : '01',
                    episode: parsed.episode != null
                        ? (parsed.episode >= 100 ? String(parsed.episode) : pad2(parsed.episode))
                        : pad2(index + 1),
                    extension: path.extname(file.name || file.restoreName || '') || ''
                };
            });
            // 单文件也可能是剧集（如 光阴之外.S01E31.mp4）；有 SxxExx/第x集 等线索时优先 tv
            resourceInfo.type = (sortedFiles.length > 1 || hasSeasonEpisodeHint) ? 'tv' : 'movie';
        }

        // TMDB 锚定
        let resolvedTmdb = tmdbInfo || this.parseTaskTmdbContent(task?.tmdbContent);
        if (!resolvedTmdb && this.tmdbService && (task?.tmdbId || resourceInfo.name)) {
            try {
                resolvedTmdb = await this._resolveTmdb(task, resourceInfo);
            } catch (error) {
                logTaskEvent(`[Layout] TMDB 解析失败: ${error.message}`);
            }
        }

        const libraryInfo = this._composeLibraryInfo(task, resourceInfo, resolvedTmdb);
        libraryInfo.locked = true;
        libraryInfo.resourceInfo = {
            name: resourceInfo.name,
            year: resourceInfo.year,
            type: resourceInfo.type,
            season: resourceInfo.season,
            episode: resourceInfo.episode
        };
        return libraryInfo;
    }

    _composeLibraryInfo(task, resourceInfo, tmdbInfo) {
        const mediaType = tmdbInfo?.type || resourceInfo?.type || 'tv';
        const year = extractYear(tmdbInfo?.releaseDate) || resourceInfo?.year || extractYear(task?.resourceName) || '';
        const canonicalTitle = sanitizePathSegment(
            tmdbInfo?.title || resourceInfo?.name || sanitizeTitle(task?.resourceName) || '未命名'
        ) || '未命名';
        const categoryName = this._resolveCategoryName(mediaType, tmdbInfo);
        const resourceFolderName = year ? `${canonicalTitle} (${year})` : canonicalTitle;
        return this.normalizeLibraryInfo({
            mediaType,
            categoryName,
            canonicalTitle,
            year,
            resourceFolderName,
            tmdbId: tmdbInfo?.id || task?.tmdbId || '',
            isAnime: categoryName === this.getCategoryMap().anime,
            locked: true
        });
    }

    _resolveCategoryName(mediaType, tmdbInfo) {
        const categories = this.getCategoryMap();
        const genreIds = Array.isArray(tmdbInfo?.genres)
            ? tmdbInfo.genres.map((item) => Number(item.id)).filter(Number.isFinite)
            : [];
        if (mediaType === 'movie') {
            return genreIds.includes(99) ? categories.documentary : categories.movie;
        }
        if (genreIds.includes(16)) return categories.anime;
        if (genreIds.includes(99)) return categories.documentary;
        if (genreIds.includes(10764) || genreIds.includes(10767)) return categories.variety;
        return categories.tv;
    }

    async _resolveTmdb(task, resourceInfo) {
        if (!this.tmdbService) return null;
        const apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        if (!apiKey) return null;

        const preferredType = resourceInfo?.type || 'tv';
        if (task?.tmdbId) {
            const detail = preferredType === 'movie'
                ? await this.tmdbService.getMovieDetails(task.tmdbId)
                : await this.tmdbService.getTVDetails(task.tmdbId);
            if (detail?.id) return detail;
        }
        const title = sanitizeTitle(resourceInfo?.name || task?.resourceName || '');
        const year = resourceInfo?.year || '';
        if (!title) return null;
        if (preferredType === 'movie') {
            return await this.tmdbService.searchMovie(title, year);
        }
        return await this.tmdbService.searchTV(title, year, task?.currentEpisodes || 0);
    }

    async _analyzeWithCache(resourcePath, files) {
        const sorted = [...files].sort((a, b) =>
            String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' })
        );
        const keyBasis = JSON.stringify({
            v: PROMPT_VERSION,
            resourcePath: String(resourcePath || ''),
            files: sorted.map((f) => ({ id: String(f.id || ''), name: String(f.name || '') }))
        });
        const hash = crypto.createHash('sha1').update(keyBasis).digest('hex');
        const cachePath = path.join(this.cacheDir, `${hash}.json`);
        try {
            const cached = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
            if (cached?.data) {
                return cached.data;
            }
        } catch (_) {}

        if (!this.taskService?._analyzeResourceInfo) {
            return null;
        }
        const data = await this.taskService._analyzeResourceInfo(resourcePath, sorted, 'file');
        try {
            await fsp.mkdir(this.cacheDir, { recursive: true });
            await fsp.writeFile(cachePath, JSON.stringify({
                updatedAt: new Date().toISOString(),
                data
            }), 'utf8');
        } catch (_) {}
        return data;
    }

    /**
     * 为文件列表应用 layout：返回 { targetRoot, files: [{...file, name, relativeDir, organizedFileName}] }
     */
    applyLayoutToFiles({
        localStrmPrefix = '',
        libraryInfo,
        resourceInfo = null,
        files = [],
        renameFiles = true
    }) {
        const info = this.normalizeLibraryInfo(libraryInfo);
        const targetRoot = this.buildStrmRoot(localStrmPrefix, info);
        const episodeMap = new Map((resourceInfo?.episode || info.resourceInfo?.episode || []).map((ep) => [String(ep.id), ep]));
        const out = files.map((file, index) => {
            const key = String(file.id || file.entryKey || index);
            const aiFile = episodeMap.get(key) || null;
            // 若无 AI episode，用确定性解析补一份
            const effectiveAi = aiFile || (() => {
                const parsed = parseMediaTitle(file.name || file.restoreName || file.originalFileName || '');
                return {
                    id: key,
                    name: info.canonicalTitle,
                    season: parsed.season != null ? pad2(parsed.season) : '01',
                    episode: parsed.episode != null
                        ? (parsed.episode >= 100 ? String(parsed.episode) : pad2(parsed.episode))
                        : pad2(index + 1),
                    extension: path.extname(file.name || file.restoreName || '') || ''
                };
            })();
            const relativeDir = this.buildRelativeDir(file, effectiveAi, info);
            const newName = renameFiles
                ? this.buildFileName(file, effectiveAi, resourceInfo || info.resourceInfo || {
                    name: info.canonicalTitle,
                    year: info.year,
                    type: info.mediaType
                }, info)
                : (file.name || file.restoreName);
            return {
                ...file,
                name: newName,
                relativeDir,
                organizedDir: joinPosix(info.categoryName, info.resourceFolderName, relativeDir),
                organizedFileName: relativeDir ? path.posix.join(relativeDir, newName.replace(/\.[^.]+$/, '') + '.strm').replace(/\.strm$/, path.extname(newName) ? newName.replace(/\.[^.]+$/, '.strm') : `${newName}.strm`) : null,
                sourceFileName: file.sourceFileName || file.name || file.restoreName,
                originalFileName: file.originalFileName || file.restoreName || file.name
            };
        });
        return { targetRoot, files: out, libraryInfo: info };
    }

    /**
     * 从 realFolderName 推导相对媒体库路径（去掉账号云盘根首段的兼容逻辑）
     */
    fromRealFolderName(realFolderName = '', localStrmPrefix = '') {
        const normalized = normalizeRelativePath(realFolderName);
        if (!normalized) return '';
        const index = normalized.indexOf('/');
        const stripped = index >= 0 ? normalized.substring(index + 1) : normalized;
        // 必须剥裸 strm，避免 /strm + 业务段 叠成相对 strm/...
        return joinPosix(normalizeLocalStrmPrefix(localStrmPrefix), stripped);
    }

    /**
     * 标准化 zip/镜像中的 Season 目录名
     */
    normalizeSeasonDirName(dirName = '') {
        const raw = String(dirName || '').trim();
        if (!raw) return '';
        const m = raw.match(/(?:season|s)\s*(\d{1,2})/i) || raw.match(/第\s*(\d{1,2})\s*季/);
        if (m) return `Season ${pad2(m[1])}`;
        if (/special|特别/i.test(raw)) return '特别篇01';
        return sanitizePathSegment(raw);
    }
}

module.exports = {
    MediaLibraryLayoutService,
    normalizeRelativePath,
    normalizeLocalStrmPrefix,
    joinLocalStrmPath,
    sanitizePathSegment,
    joinPosix,
    pad2
};
