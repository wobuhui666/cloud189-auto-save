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
const { parseMediaTitle, detectMovieCollection, resolveTitleMeta } = require('../utils/mediaTitleParser');
const { renderFileName } = require('../utils/templateRenderer');
const { logTaskEvent } = require('../utils/logUtils');
const AIService = require('./ai');

const PROMPT_VERSION = 'v3-path-aware';

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
    const num = parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(num) || num < 0) {
        return '01';
    }
    return String(num).padStart(2, '0');
}

/**
 * 特别篇确定性兜底检测（NCOP/NCED/SP/Non-Credit）。
 * 全仓库唯一入口——AI 是主检测器，此函数仅作安全网；禁止再复制这份正则。
 * 故意不收 OVA/OAD：那类形态交给 AI 判定，兜底只覆盖最高频的字面模式以保持零回归。
 */
const SPECIAL_FILE_PATTERNS = [/\bNC(OP|ED|IN)/i, /\bSP\d/i, /Non-Credit/i, /\[\d+\.5\]/];
function isSpecialEpisodeName(name = '') {
    const text = String(name || '');
    return !!text && SPECIAL_FILE_PATTERNS.some((re) => re.test(text));
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
            locked: info.locked !== false,
            // 默认季号：目录名/任务名解析出的季号（如"第二季"→"02"），
            // 序列化后保留，供 buildRelativeDir 在无 aiFile 时做最终 fallback。
            ...(info.defaultSeason ? { defaultSeason: String(info.defaultSeason) } : {}),
            // 电影合集逐文件 TMDB 数据（非合集为 undefined，不影响现有序列化）
            ...(Array.isArray(info.files) && info.files.length ? { files: info.files } : {})
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
        // 并集语义：AI 判为 S00（覆盖 OVA/PV 等正则不认识的形式）或确定性兜底命中（防 AI 漏判 NCOP）→ Season 00
        const originalName = file.originalFileName || file.restoreName || file.name || '';
        const aiSeasonRaw = String(aiFile?.season || '').trim();
        const aiSeasonDir = /^\d+$/.test(aiSeasonRaw)
            ? `Season ${aiSeasonRaw.padStart(2, '0')}`
            : (aiSeasonRaw ? sanitizePathSegment(aiSeasonRaw) : null);
        if (aiSeasonDir === 'Season 00' || isSpecialEpisodeName(originalName)) {
            return 'Season 00';
        }
        if (aiSeasonDir) {
            return aiSeasonDir;
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
        // 最终 fallback：用 layout 里保留的默认季号（如"第二季"→"02"），否则 Season 01
        return info.defaultSeason ? `Season ${info.defaultSeason}` : 'Season 01';
    }

    buildFileName(file, aiFile, resourceInfo, libraryInfo) {
        const info = this.normalizeLibraryInfo(libraryInfo || {});
        if (aiFile?.targetFileName) {
            const requested = sanitizePathSegment(String(aiFile.targetFileName));
            const sourceExt = path.extname(file.name || file.restoreName || '');
            return requested && path.extname(requested) ? requested : `${requested}${sourceExt}`;
        }
        const isMovie = (resourceInfo?.type || info.mediaType) === 'movie';
        const template = isMovie
            ? (ConfigService.getConfigValue('openai.rename.movieTemplate') || '{{name}}{% if year %} ({{year}}){% endif %}{{ext}}')
            : (ConfigService.getConfigValue('openai.rename.template') || '{{name}} - {{se}}{{ext}}');

        const name = aiFile?.name || info.canonicalTitle || resourceInfo?.name || sanitizeTitle(file.name);
        // 电影合集场景每个文件带独立年份（aiFile.year），优先于合集级年份
        const year = String(aiFile?.year || resourceInfo?.year || info.year || '');
        // 并集语义：AI 判为 S00 或确定性兜底命中 → Season 00，与 buildRelativeDir 保持一致
        const originalName = file.originalFileName || file.restoreName || file.name || '';
        const aiSeason = pad2(aiFile?.season || info.defaultSeason || '01');
        const season = (aiSeason === '00' || isSpecialEpisodeName(originalName)) ? '00' : aiSeason;
        const episode = (() => {
            const raw = String(aiFile?.episode || '01');
            const num = parseInt(raw, 10);
            if (!Number.isFinite(num)) return '01';
            return num >= 100 ? String(num) : String(num).padStart(2, '0');
        })();
        const ext = aiFile?.extension || path.extname(file.name || file.restoreName || '') || '';
        const vars = {
            name,
            year,
            s: season,
            e: episode,
            sn: String(parseInt(season, 10) || 1),
            en: String(parseInt(episode, 10) || 1),
            ext: ext.startsWith('.') || !ext ? ext : `.${ext}`,
            se: `S${season}E${episode}`
        };
        const newName = renderFileName(template, vars);
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

        // 确定性：从文件列表补季集
        const sortedFiles = [...(files || [])].sort((a, b) =>
            String(a.name || a.restoreName || '').localeCompare(String(b.name || b.restoreName || ''), 'zh-CN', {
                numeric: true,
                sensitivity: 'base'
            })
        );

        // 标题层级补全：文件名（最精确）→ 选中目录名 → 父级标题。
        // title 取中文来源（适合做文件夹名），year/season/episode 取文件名优先。
        const titleMeta = resolveTitleMeta(
            { resourceName: resourceName || task?.resourceName || '', shareFolderName: task?.shareFolderName || '' },
            sortedFiles
        );
        // 源文件名解析标题（英文规范命名），用于 TMDB 搜索主候选
        const firstFileParsed = sortedFiles.length
            ? parseMediaTitle(sortedFiles[0].name || sortedFiles[0].restoreName || '')
            : null;
        const fileSearchTitle = firstFileParsed?.cleanTitle || '';
        const fileSearchYear = firstFileParsed?.year != null ? firstFileParsed.year : '';

        let resourceInfo = {
            name: sanitizeTitle(titleMeta.title || resourceName || task?.resourceName || '未命名') || '未命名',
            year: titleMeta.year != null ? titleMeta.year : (extractYear(resourceName || task?.resourceName) || ''),
            season: titleMeta.season != null ? titleMeta.season : null,
            type: 'tv',
            episode: []
        };

        // 电影合集判定：AI 主判（useAi 且文件数 > 1），确定性规则 fallback。
        // 选了子目录时用子目录名判定（它才是实际内容），父级"合集"标题不代表子目录也是合集。
        const parentTitle = resourceName || task?.resourceName || '';
        const selectedDirName = task?.shareFolderName || '';
        const hasSelectedSubDir = !!(selectedDirName && selectedDirName !== parentTitle);
        const titleForDetect = hasSelectedSubDir ? selectedDirName : (parentTitle || titleMeta.title);
        const deterministic = detectMovieCollection(titleForDetect, sortedFiles);
        let isMovieCollection = false;
        if (sortedFiles.length > 1) {
            if (useAi && this.taskService) {
                const aiVerdict = await AIService.detectCollectionWithAI(titleForDetect, sortedFiles);
                if (aiVerdict) {
                    isMovieCollection = aiVerdict.isCollection;
                    logTaskEvent(`[Layout] AI 合集判定: ${isMovieCollection ? '是' : '否'}（${aiVerdict.reason}）`);
                } else {
                    isMovieCollection = deterministic.isMovieCollection; // AI 不可用/失败 → fallback
                }
            } else {
                isMovieCollection = deterministic.isMovieCollection;
            }
        }
        const collection = { isMovieCollection, perFileNames: deterministic.perFileNames };

        // AI（可选，带缓存）；AI 未启用 / 返回空 / 抛错时回退到确定性规则
        let resolvedByAi = false;
        if (useAi && this.taskService && sortedFiles.length) {
            try {
                const aiInfo = await this._analyzeWithCache(
                    titleMeta.title || resourceName || task?.resourceName || '',
                    sortedFiles.map((f) => ({
                        id: String(f.id || f.entryKey || f.name),
                        name: f.name || f.restoreName || '',
                        relativePath: normalizeRelativePath(f.relativePath || (
                            f.relativeDir ? path.posix.join(String(f.relativeDir).replace(/\\/g, '/'), f.name || f.restoreName || '') : (f.name || f.restoreName || '')
                        ))
                    }))
                );
                if (aiInfo?.name) {
                    resourceInfo = {
                        ...resourceInfo,
                        name: sanitizeTitle(aiInfo.name) || resourceInfo.name,
                        year: aiInfo.year || resourceInfo.year,
                        type: isMovieCollection ? 'movie' : (aiInfo.type === 'movie' ? 'movie' : 'tv'),
                        season: aiInfo.season,
                        episode: Array.isArray(aiInfo.episode) ? aiInfo.episode : [],
                        isMovieCollection,
                        // 源文件名标题始终可用，供 TMDB 搜索主候选
                        searchTitle: fileSearchTitle || undefined,
                        searchYear: fileSearchYear || undefined
                    };
                    resolvedByAi = true;
                }
            } catch (error) {
                logTaskEvent(`[Layout] AI 分析失败，使用确定性回退: ${error.message}`);
            }
        }
        if (!resolvedByAi && sortedFiles.length) {
            resourceInfo = this._buildDeterministicResourceInfo(
                resourceInfo,
                titleMeta.title || resourceName || task?.resourceName || '',
                sortedFiles,
                collection
            );
        }

        // 后处理：无论 AI 还是确定性路径，强制把特别篇文件（NCOP/NCED/SP/Non-Credit）改到 Season 00。
        // AI 可能不遵守 prompt 里的规则，确定性路径已内置检测但 AI 路径没有——统一兜底。
        if (Array.isArray(resourceInfo.episode) && resourceInfo.episode.length) {
            const fileById = new Map(sortedFiles.map((f) => [String(f.id || f.entryKey || f.name), f.name || f.restoreName || '']));
            // 合集逐文件标题和年份以确定性文件名解析为准，避免 AI 分块后把后续电影统一成合集标题。
            if (resourceInfo.isMovieCollection) {
                for (const ep of resourceInfo.episode) {
                    const fileName = fileById.get(String(ep.id)) || '';
                    const perFile = collection.perFileNames.get(fileName);
                    if (perFile?.title) ep.name = perFile.title;
                    if (perFile?.year != null) ep.year = perFile.year;
                }
            }
            let s00Max = 0;
            for (const ep of resourceInfo.episode) {
                if (ep.season === '00' || ep.season === 0) {
                    const num = parseInt(ep.episode, 10);
                    if (Number.isFinite(num) && num > s00Max) s00Max = num;
                }
            }
            for (const ep of resourceInfo.episode) {
                const fileName = fileById.get(String(ep.id)) || '';
                if (fileName && isSpecialEpisodeName(fileName)) {
                    if (ep.season !== '00' && ep.season !== 0) {
                        ep.season = '00';
                        ep.episode = pad2(++s00Max);
                    }
                }
            }
            // 季号覆盖：目录名/任务名解析出明确季号（如"第二季"→2）时，
            // AI 可能仍返回默认 "01"——用 titleMeta.season 覆盖非特别篇的 season。
            if (titleMeta.season != null && titleMeta.season > 0) {
                const metaSeason = pad2(titleMeta.season);
                for (const ep of resourceInfo.episode) {
                    if (ep.season !== '00' && ep.season !== 0) {
                        ep.season = metaSeason;
                    }
                }
            }
        }

        // 统一注入源文件名标题（无论 AI 还是确定性分支），供 TMDB 搜索主候选
        if (fileSearchTitle && !resourceInfo.searchTitle) {
            resourceInfo = { ...resourceInfo, searchTitle: fileSearchTitle, searchYear: fileSearchYear || undefined };
        }

        // TMDB 锚定
        let resolvedTmdb = tmdbInfo || this.parseTaskTmdbContent(task?.tmdbContent);
        // 电影合集不是单一 TMDB 实体：除非任务已显式绑定 tmdbId，否则跳过搜索锚定，
        // 避免 searchMovie 碰巧命中其中某一部而把合集文件夹名改成那一部的标题。
        const skipTmdbSearch = !!resourceInfo.isMovieCollection && !task?.tmdbId;
        if (!resolvedTmdb && !skipTmdbSearch && this.tmdbService && (task?.tmdbId || resourceInfo.name)) {
            try {
                resolvedTmdb = await this._resolveTmdb(task, resourceInfo);
            } catch (error) {
                logTaskEvent(`[Layout] TMDB 解析失败: ${error.message}`);
            }
        }

        const libraryInfo = this._composeLibraryInfo(task, resourceInfo, resolvedTmdb);
        libraryInfo.locked = true;
        // 保留目录名/任务名解析出的季号，序列化后供 buildRelativeDir fallback 使用
        if (titleMeta.season != null && titleMeta.season > 0) {
            libraryInfo.defaultSeason = pad2(titleMeta.season);
        }
        libraryInfo.resourceInfo = {
            name: resourceInfo.name,
            year: resourceInfo.year,
            type: resourceInfo.type,
            season: resourceInfo.season,
            episode: resourceInfo.episode
        };

        // 电影合集：逐文件匹配 TMDB，写入 files 数组（供刮削 + UI 使用）。
        // 合集不锚定单一实体（skipTmdbSearch），但每个文件独立 searchMovie。
        if (resourceInfo.isMovieCollection && Array.isArray(resourceInfo.episode)) {
            const collectionFiles = await this._resolveCollectionFilesTmdb(resourceInfo.episode);
            libraryInfo.files = collectionFiles.map((entry) => ({
                ...entry,
                organizedFileName: this.buildFileName(
                    { name: `${entry.name || 'file'}${entry.extension || ''}` },
                    entry,
                    resourceInfo,
                    libraryInfo
                )
            }));
        }
        return libraryInfo;
    }

    /**
     * 电影合集逐文件 TMDB 匹配：对每个文件的独立标题/年份调 searchMovie，
     * 返回带 tmdbId/tmdbTitle/posterPath 的 files 数组。搜索失败的文件 tmdbId 为空。
     * 复用 TMDBService 的 DB 缓存（details 7天 TTL），逐文件调用无额外架构成本。
     */
    async _resolveCollectionFilesTmdb(episodes = []) {
        if (!this.tmdbService) {
            return episodes.map((ep) => ({ ...ep, tmdbId: '', tmdbTitle: '', posterPath: '' }));
        }
        // 清洗标题里的集号噪声（"剧场版01："、"Movie10" 等），TMDB 搜索对此敏感
        const cleanSearchTitle = (raw) => String(raw || '')
            .replace(/剧场版\s*\d+\s*[:：]?/g, ' ')
            .replace(/\bmovie\s*\d+\b/gi, ' ')
            .replace(/第\s*\d+\s*部/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        const results = [];
        for (const ep of episodes) {
            const title = ep.name || '';
            const year = ep.year || '';
            let tmdbId = '', tmdbTitle = '', posterPath = '';
            if (title) {
                // 第一次：用清洗后的完整标题搜索
                const candidates = [cleanSearchTitle(title)];
                // 兜底：截断到冒号前的主标题（如"名侦探柯南：黑铁的鱼影"→ 都试）
                const colonPart = title.split(/[:：]/).map((s) => cleanSearchTitle(s)).filter(Boolean);
                candidates.push(...colonPart);
                for (const q of [...new Set(candidates)]) {
                    try {
                        const detail = await this.tmdbService.searchMovie(q, year);
                        if (detail?.id) {
                            tmdbId = String(detail.id);
                            tmdbTitle = detail.title || '';
                            posterPath = detail.posterPath || '';
                            break;
                        }
                    } catch (error) {
                        logTaskEvent(`[Layout] 合集文件 TMDB 匹配失败「${q}」: ${error.message}`);
                    }
                }
            }
            results.push({ ...ep, tmdbId, tmdbTitle, posterPath });
        }
        const matched = results.filter((r) => r.tmdbId).length;
        logTaskEvent(`[Layout] 合集逐文件 TMDB 匹配完成: ${matched}/${results.length}`);
        return results;
    }

    /**
     *确定性分类：无 AI 时从标题 + 文件列表推断 movie/tv 并补季集。
     * 规则：
     * - 多文件电影合集（标题含剧场版/电影/Movie，或"合集"+文件级证据）→ movie，
     *   每个文件用自己解析出的独立标题/年份，供 Emby 刮削为独立电影条目；
     * - 有 SxxExx/第x季 等季集线索 → tv；
     * - 其余多文件 → tv（沿用原启发式）；单文件无线索 → movie。
     */
    _buildDeterministicResourceInfo(resourceInfo, resourceName, sortedFiles, collection = null) {
        const parsedResource = parseMediaTitle(resourceName || '');
        let hasSeasonEpisodeHint = parsedResource.season != null || parsedResource.episode != null;
        const collectionInfo = collection || detectMovieCollection(resourceName, sortedFiles);
        const isMovieCollection = collectionInfo.isMovieCollection;

        // 预扫：原生 S00 文件（如 Show.S00E01.mkv）的最大集号，特别篇文件从后面接着编，避免撞号
        let maxS00Episode = 0;
        for (const f of sortedFiles) {
            const p = parseMediaTitle(f.name || f.restoreName || '');
            if (p.season === 0 && p.episode != null && p.episode > maxS00Episode) {
                maxS00Episode = p.episode;
            }
        }
        // 默认季号：优先用 resourceInfo.season（来自 resolveTitleMeta 的目录名/任务名解析，
        // 如"第二季"→ season=2），否则回退 '01'
        const defaultSeason = resourceInfo.season != null ? pad2(resourceInfo.season) : '01';
        let specialCounter = maxS00Episode;
        const episode = sortedFiles.map((file, index) => {
            const fileName = file.name || file.restoreName || '';
            const parsed = parseMediaTitle(fileName);
            if (parsed.season != null || parsed.episode != null) {
                hasSeasonEpisodeHint = true;
            }
            // 特别篇检测 → Season 00（Emby Specials），不占正片集号：
            // - NCOP/NCED：无字幕片头片尾。不要求尾部词边界（[NCED03] 里 D 和 0 之间无 \b），
            //   也不检查 parsed.episode（anitomy 可能把 NCED03 的 03 解析成集号）。
            // - SP：特别篇（如 [SP01]），anitomy 会把 01 解析成正片集号导致撞号。
            // - Non-Credit：无字幕版（如 [EP23 C-Part Non-Credit Ver.]），本质也是 NCED/NCOP。
            const isSpecial = isSpecialEpisodeName(fileName);
            if (isSpecial) specialCounter++;
            const perFile = isMovieCollection ? collectionInfo.perFileNames.get(fileName) : null;
            return {
                id: String(file.id || file.entryKey || index),
                // 电影合集：每个文件用自己的独立标题/年份；否则沿用合集标题
                name: perFile?.title || resourceInfo.name,
                year: perFile?.year != null ? perFile.year : resourceInfo.year,
                season: isSpecial ? '00' : (parsed.season != null ? pad2(parsed.season) : defaultSeason),
                episode: isSpecial
                    ? pad2(specialCounter)
                    : (parsed.episode != null
                        ? (parsed.episode >= 100 ? String(parsed.episode) : pad2(parsed.episode))
                        : pad2(index + 1)),
                extension: path.extname(fileName) || ''
            };
        });

        // 电影合集优先判 movie；否则单文件也可能是剧集（如 光阴之外.S01E31.mp4），有季集线索时优先 tv
        const type = isMovieCollection
            ? 'movie'
            : ((sortedFiles.length > 1 || hasSeasonEpisodeHint) ? 'tv' : 'movie');

        return { ...resourceInfo, type, episode, isMovieCollection };
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
        // 多候选搜索：文件名标题（英文规范命名）优先，目录名/任务名（中文标题）兜底。
        // 如"浪浪山小妖怪"任务名本身就是精确中文标题，文件名可能是乱码编码名，此时回退命中。
        // 搜索标题清洗：去掉 "Movie 1/2/3" 编号（TMDB 标题不含编号）
        const cleanForSearch = (t) => sanitizeTitle(t).replace(/\bmovie\s*\d+\b/gi, '').replace(/\s+/g, ' ').trim();
        const candidates = [];
        if (resourceInfo?.searchTitle) {
            candidates.push({ title: cleanForSearch(resourceInfo.searchTitle), year: resourceInfo.searchYear || resourceInfo.year || '' });
        }
        const dirTitle = cleanForSearch(resourceInfo?.name || task?.resourceName || '');
        if (dirTitle && dirTitle !== candidates[0]?.title) {
            candidates.push({ title: dirTitle, year: resourceInfo?.year || '' });
        }
        if (!candidates.length) return null;
        for (const c of candidates) {
            const result = preferredType === 'movie'
                ? await this.tmdbService.searchMovie(c.title, c.year)
                : await this.tmdbService.searchTV(c.title, c.year, task?.currentEpisodes || 0);
            if (result?.id) return result;
            // 带年份未命中时去掉年份重试（合集子目录的年份常来自父级标题，与单部实际上映年不符）
            if (c.year) {
                const retry = preferredType === 'movie'
                    ? await this.tmdbService.searchMovie(c.title, '')
                    : await this.tmdbService.searchTV(c.title, '', task?.currentEpisodes || 0);
                if (retry?.id) return retry;
            }
        }
        return null;
    }

    async _analyzeWithCache(resourcePath, files) {
        const sorted = [...files].sort((a, b) =>
            String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' })
        );
        const keyBasis = JSON.stringify({
            v: PROMPT_VERSION,
            resourcePath: String(resourcePath || ''),
            files: sorted.map((f) => ({
                id: String(f.id || ''),
                name: String(f.name || ''),
                relativePath: normalizeRelativePath(f.relativePath || f.name || '')
            }))
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
                const sourceName = file.name || file.restoreName || file.originalFileName || '';
                const parsed = parseMediaTitle(sourceName);
                // 电影（非剧集）：每个文件用自己解析出的独立标题/年份，使电影合集的各部能独立命名；
                // 同名多版本（标准版/HDR）会碰撞，交由下方 _disambiguateCollidingNames 追加版本标识。
                // 剧集仍用合集标题 + 季集号（保持原行为）。
                const isMovie = !info.seasonBased;
                return {
                    id: key,
                    name: isMovie && parsed.cleanTitle ? parsed.cleanTitle : info.canonicalTitle,
                    year: isMovie && parsed.year != null ? parsed.year : info.year,
                    season: parsed.season != null ? pad2(parsed.season) : (info.defaultSeason || '01'),
                    episode: parsed.episode != null
                        ? (parsed.episode >= 100 ? String(parsed.episode) : pad2(parsed.episode))
                        : pad2(index + 1),
                    extension: path.extname(sourceName) || ''
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
                sourceFileName: file.sourceFileName || file.name || file.restoreName,
                originalFileName: file.originalFileName || file.restoreName || file.name
            };
        });
        // 电影多版本（如 标准版/HDR10/杜比视界）会映射到同一目标名，导致 STRM 互相覆盖、
        // 最终只保留一个。这里按目标路径分组，对冲突项追加从原始文件名提取的版本标识以消歧。
        this._disambiguateCollidingNames(out);
        for (const file of out) {
            const relativeDir = file.relativeDir || '';
            file.organizedDir = joinPosix(info.categoryName, info.resourceFolderName, relativeDir);
            file.organizedFileName = relativeDir
                ? path.posix.join(relativeDir, file.name.replace(/\.[^.]+$/, '') + '.strm')
                : null;
        }
        return { targetRoot, files: out, libraryInfo: info };
    }

    /**
     * 检测映射到同一目标 STRM 路径的文件（同目录 + 同主名），为冲突项追加版本标识。
     * 第一个保持原名，其余追加从原始文件名提取的版本标签；标签重复时退化为「版本N」。
     */
    _disambiguateCollidingNames(files) {
        const groups = new Map();
        for (const file of files) {
            const base = path.parse(file.name || '').name;
            const key = `${normalizeRelativePath(file.relativeDir || '')}/${base}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(file);
        }
        for (const group of groups.values()) {
            if (group.length < 2) {
                continue;
            }
            const usedTags = new Set();
            group.forEach((file, index) => {
                if (index === 0) {
                    return;
                }
                let tag = this._extractVersionTag(file.originalFileName || file.sourceFileName || file.name);
                if (!tag || usedTags.has(tag)) {
                    let n = 1;
                    while (usedTags.has(`版本${n}`)) {
                        n++;
                    }
                    tag = `版本${n}`;
                }
                usedTags.add(tag);
                const parsed = path.parse(file.name);
                file.name = `${parsed.name} - ${tag}${parsed.ext}`;
            });
        }
    }

    /**
     * 从原始文件名提取可区分的版本/画质标识（杜比视界、HDR10、REMUX、分辨率等）。
     */
    _extractVersionTag(sourceName = '') {
        const name = String(sourceName || '');
        if (!name) {
            return '';
        }
        const patterns = [
            [/杜比视界|Dolby\s*Vision|(?<![A-Za-z])DV(?![A-Za-z])/i, '杜比视界'],
            [/\bHDR10\+?/i, 'HDR10'],
            [/\bHDR\b/i, 'HDR'],
            [/\bREMUX\b/i, 'REMUX'],
            [/\bBlu-?Ray\b|\bBD\b/i, 'BluRay'],
            [/\bWEB-?DL\b/i, 'WEB-DL'],
            [/\bWEBRip\b/i, 'WEBRip'],
            [/\b2160p\b|\b4K\b|\bUHD\b/i, '2160p'],
            [/\b1080p\b/i, '1080p'],
            [/\b720p\b/i, '720p'],
            [/60\s*FPS/i, '60FPS'],
        ];
        const tags = [];
        for (const [regex, label] of patterns) {
            if (regex.test(name)) {
                tags.push(label);
            }
        }
        return tags.slice(0, 2).join(' ');
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
    sanitizeTitle,
    extractYear,
    joinPosix,
    pad2,
    isSpecialEpisodeName
};
