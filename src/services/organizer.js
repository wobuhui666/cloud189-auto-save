const path = require('path');
const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');
const { StrmService } = require('./strm');
const { TMDBService } = require('./tmdb');
const { logTaskEvent } = require('../utils/logUtils');
const { MediaLibraryLayoutService, normalizeRelativePath } = require('./mediaLibraryLayout');

class OrganizerService {
    constructor(taskService, taskRepo = null) {
        this.taskService = taskService || null;
        this.taskRepo = taskRepo || (taskService && taskService.taskRepo) || null;
        this.tmdbService = new TMDBService();
        this.layoutService = new MediaLibraryLayoutService({
            taskService: this.taskService,
            tmdbService: this.tmdbService
        });
    }

    async organizeTaskById(taskId, options = {}) {
        const task = await this.taskService.getTaskById(taskId);
        if (!task) {
            throw new Error('任务不存在');
        }
        return await this.organizeTask(task, options);
    }

    async organizeTask(task, options = {}) {
        const {
            triggerStrm = false,
            organizeCloud = true,
            forceRefresh = false
        } = options;

        if (!task.account) {
            const account = await this.taskService._getAccountById(task.accountId);
            if (!account) {
                throw new Error('账号不存在');
            }
            task.account = account;
        }
        if (!task.enableOrganizer && !options.force) {
            return {
                message: `任务[${task.resourceName}]未启用整理器，跳过`,
                files: await this.taskService.getFilesByTask(task)
            };
        }

        // 懒任务：默认只解析/锁定 layout，不移动网盘实体
        const isLazy = !!task.enableLazyStrm;
        const shouldOrganizeCloud = organizeCloud && !isLazy;
        if (isLazy && organizeCloud && !options.forceCloud) {
            logTaskEvent(`任务[${task.resourceName}]为懒STRM，仅锁定媒体库布局（不移动网盘文件）`);
        }

        const allFiles = (await this.taskService.getFilesByTask(task)).filter(file => !file.isFolder);
        if (!allFiles.length) {
            throw new Error('当前任务目录没有可整理的文件');
        }

        logTaskEvent(`任务[${task.resourceName}]开始执行整理器`);
        this.layoutService.taskService = this.taskService;
        const libraryInfo = await this.layoutService.resolveLibraryInfo({
            resourceName: task.resourceName,
            files: allFiles.map(file => ({ id: file.id, name: file.name })),
            task,
            forceRefresh: !!forceRefresh,
            useAi: true
        });
        const resourceInfo = libraryInfo.resourceInfo || {
            name: libraryInfo.canonicalTitle,
            year: libraryInfo.year,
            type: libraryInfo.mediaType,
            episode: []
        };

        // 锁定 layout（防 AI 漂移）
        const layoutJson = this.layoutService.serializeLibraryLayout(libraryInfo);
        task.libraryLayout = layoutJson;

        if (!shouldOrganizeCloud) {
            if (this.taskRepo) {
                await this.taskRepo.update(task.id, {
                    libraryLayout: layoutJson,
                    lastOrganizedAt: new Date(),
                    lastOrganizeError: '',
                    ...(libraryInfo.tmdbId ? { tmdbId: String(libraryInfo.tmdbId) } : {})
                });
            }
            // 为 STRM 侧准备 relativeDir/name（不改网盘）
            const applied = this.layoutService.applyLayoutToFiles({
                localStrmPrefix: task.account?.localStrmPrefix || '',
                libraryInfo,
                resourceInfo,
                files: allFiles,
                renameFiles: true
            });
            return {
                message: `${task.resourceName}已锁定媒体库布局 ${libraryInfo.categoryName}/${libraryInfo.resourceFolderName}（懒模式未移动网盘）`,
                files: applied.files,
                operations: [],
                libraryInfo
            };
        }

        const cloud189 = Cloud189Service.getInstance(task.account);
        const baseFolderPath = this._resolveBaseFolderPath(task);
        const categoryCache = new Map();
        const resourceFolderPath = this._joinPosix(baseFolderPath, libraryInfo.categoryName, libraryInfo.resourceFolderName);
        const categoryFolderId = await this._ensureFolderByName(cloud189, String(task.targetFolderId), libraryInfo.categoryName, categoryCache);
        const resourceFolderId = await this._ensureFolderByName(cloud189, categoryFolderId, libraryInfo.resourceFolderName, categoryCache);

        const originalFolderId = String(task.realFolderId);
        const originalFolderName = this._normalizePath(task.realFolderName || '');
        const messages = [];
        const targetSummary = `${libraryInfo.categoryName}/${libraryInfo.resourceFolderName}`;
        if (originalFolderName !== resourceFolderPath) {
            messages.push(`├─ 媒体库归档 ${targetSummary}`);
        }

        const nestedFolderCache = new Map();
        const fileMap = new Map((resourceInfo.episode || []).map(item => [String(item.id), item]));

        for (const file of allFiles) {
            const aiFile = fileMap.get(String(file.id));
            const targetFileName = this.layoutService.buildFileName(file, aiFile, resourceInfo, libraryInfo);
            const targetRelativeDir = this.layoutService.buildRelativeDir(file, aiFile, libraryInfo);
            const targetFolderId = await this._ensureDirectoryPath(cloud189, resourceFolderId, targetRelativeDir, nestedFolderCache);

            if (file.name !== targetFileName) {
                const renameResult = await cloud189.renameFile(file.id, targetFileName);
                if (!renameResult || (renameResult.res_code && renameResult.res_code !== 0)) {
                    throw new Error(`重命名失败: ${file.name} -> ${targetFileName}`);
                }
                messages.push(`├─ 重命名 ${file.name} -> ${targetFileName}`);
                file.name = targetFileName;
            }

            if (String(file.parentFolderId || originalFolderId) !== String(targetFolderId)) {
                await this.taskService.moveCloudFile(cloud189, {
                    id: file.id,
                    name: file.name,
                    isFolder: false
                }, targetFolderId);
                messages.push(`├─ 移动 ${file.name} -> ${targetRelativeDir || '媒体根目录'}`);
                file.parentFolderId = String(targetFolderId);
                file.relativeDir = targetRelativeDir;
                file.relativePath = targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name;
            } else {
                file.relativeDir = targetRelativeDir;
                file.relativePath = targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name;
            }
        }

        const taskUpdates = {
            lastOrganizedAt: new Date(),
            lastOrganizeError: '',
            libraryLayout: layoutJson
        };

        if (String(originalFolderId) !== String(resourceFolderId) || originalFolderName !== resourceFolderPath) {
            taskUpdates.realFolderId = String(resourceFolderId);
            taskUpdates.realRootFolderId = String(resourceFolderId);
            taskUpdates.realFolderName = resourceFolderPath;
            task.realFolderId = String(resourceFolderId);
            task.realRootFolderId = String(resourceFolderId);
            task.realFolderName = resourceFolderPath;

            if (ConfigService.getConfigValue('strm.enable') && originalFolderName && originalFolderName !== resourceFolderPath) {
                const strmService = new StrmService();
                const oldRoot = strmService.resolveTaskStrmRoot({
                    ...task,
                    realFolderName: originalFolderName,
                    libraryLayout: null,
                    account: task.account
                });
                // 仅当旧路径不是新媒体库路径时清理
                const newRoot = strmService.resolveTaskStrmRoot(task);
                if (oldRoot && oldRoot !== newRoot) {
                    await strmService.deleteDir(oldRoot);
                }
            }
        }

        if (libraryInfo.tmdbId && (!task.tmdbId || String(task.tmdbId) !== String(libraryInfo.tmdbId))) {
            taskUpdates.tmdbId = String(libraryInfo.tmdbId);
            task.tmdbId = String(libraryInfo.tmdbId);
        }

        await this.taskRepo.update(task.id, taskUpdates);

        const refreshedFiles = await this.taskService.getFilesByTask(task);
        // 补 relativeDir
        for (const file of refreshedFiles) {
            const aiFile = fileMap.get(String(file.id));
            file.relativeDir = this.layoutService.buildRelativeDir(file, aiFile, libraryInfo);
        }

        let strmMessage = '';
        if (triggerStrm && ConfigService.getConfigValue('strm.enable')) {
            const strmService = new StrmService();
            strmMessage = await strmService.generate(task, refreshedFiles, false, true);
        }

        if (messages.length > 0) {
            messages[messages.length - 1] = messages[messages.length - 1].replace(/^├─/, '└─');
            logTaskEvent(`${task.resourceName}整理完成(${targetSummary}):\n${messages.join('\n')}`);
        } else {
            logTaskEvent(`${task.resourceName}整理完成，无需调整`);
        }

        return {
            message: strmMessage || `${task.resourceName}整理完成，已归档到 ${targetSummary}`,
            files: refreshedFiles,
            operations: messages,
            libraryInfo
        };
    }

    async markError(taskId, error) {
        if (!this.taskRepo) {
            return;
        }
        await this.taskRepo.update(taskId, {
            lastOrganizeError: error.message,
            lastOrganizedAt: new Date()
        });
    }

    async _resolveTmdbInfo(task, resourceInfo) {
        const cachedTmdb = this._parseTaskTmdbContent(task.tmdbContent);
        if (cachedTmdb?.id && cachedTmdb?.type) {
            return cachedTmdb;
        }

        const apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
        if (!apiKey) {
            return cachedTmdb || null;
        }

        const preferredType = this._resolvePreferredMediaType(resourceInfo, cachedTmdb);
        if (task.tmdbId) {
            const details = await this._fetchTmdbDetailsById(task.tmdbId, preferredType);
            if (details) {
                return details;
            }
        }

        const title = this._sanitizeTitle(resourceInfo?.name || task.resourceName || '');
        const year = resourceInfo?.year || this._extractYear(task.resourceName) || '';
        if (!title) {
            return cachedTmdb || null;
        }

        try {
            if (preferredType === 'movie') {
                return await this.tmdbService.searchMovie(title, year);
            }
            if (preferredType === 'tv') {
                return await this.tmdbService.searchTV(title, year, task.currentEpisodes || 0);
            }

            const tvDetails = await this.tmdbService.searchTV(title, year, task.currentEpisodes || 0);
            if (tvDetails) {
                return tvDetails;
            }
            return await this.tmdbService.searchMovie(title, year);
        } catch (error) {
            logTaskEvent(`TMDB分类信息获取失败，已回退AI结果: ${error.message}`);
            return cachedTmdb || null;
        }
    }

    async _fetchTmdbDetailsById(tmdbId, preferredType = '') {
        const typeOrder = preferredType === 'movie'
            ? ['movie', 'tv']
            : preferredType === 'tv'
                ? ['tv', 'movie']
                : ['tv', 'movie'];

        for (const type of typeOrder) {
            const detail = type === 'movie'
                ? await this.tmdbService.getMovieDetails(tmdbId)
                : await this.tmdbService.getTVDetails(tmdbId);
            if (detail?.id) {
                return detail;
            }
        }
        return null;
    }

    _resolveLibraryInfo(task, resourceInfo, tmdbInfo) {
        const mediaType = this._resolvePreferredMediaType(resourceInfo, tmdbInfo);
        const year = this._extractYear(tmdbInfo?.releaseDate) || resourceInfo?.year || this._extractYear(task.resourceName) || '';
        const canonicalTitle = this._sanitizePathSegment(
            tmdbInfo?.title
            || resourceInfo?.name
            || this._sanitizeTitle(task.resourceName)
            || task.resourceName
        );
        const categoryName = this._resolveCategoryName(mediaType, tmdbInfo);
        const resourceFolderName = year ? `${canonicalTitle} (${year})` : canonicalTitle;
        const seasonBased = mediaType !== 'movie';

        return {
            mediaType,
            isAnime: categoryName === this._getCategoryMap().anime,
            categoryName,
            canonicalTitle,
            year: year ? String(year) : '',
            resourceFolderName,
            seasonBased
        };
    }

    _resolvePreferredMediaType(resourceInfo, tmdbInfo) {
        return tmdbInfo?.type || resourceInfo?.type || 'tv';
    }

    _resolveCategoryName(mediaType, tmdbInfo) {
        const categories = this._getCategoryMap();
        const genreIds = Array.isArray(tmdbInfo?.genres)
            ? tmdbInfo.genres.map(item => Number(item.id)).filter(Number.isFinite)
            : [];

        if (mediaType === 'movie') {
            return genreIds.includes(99) ? categories.documentary : categories.movie;
        }
        if (genreIds.includes(16)) {
            return categories.anime;
        }
        if (genreIds.includes(99)) {
            return categories.documentary;
        }
        if (genreIds.includes(10764) || genreIds.includes(10767)) {
            return categories.variety;
        }
        return categories.tv;
    }

    _buildTargetRelativeDir(file, aiFile, resourceInfo, libraryInfo) {
        if (!libraryInfo.seasonBased) {
            return '';
        }
        const seasonDir = this.taskService.buildOrganizerDirectoryName(aiFile, resourceInfo);
        if (seasonDir) {
            return seasonDir;
        }

        const relativeDir = this._normalizePath(file.relativeDir || '');
        const normalizedParts = relativeDir ? relativeDir.split('/').filter(Boolean) : [];
        const seasonPart = normalizedParts.find(part => /^(season\s*\d+|s\d+|specials?)$/i.test(part));
        if (seasonPart) {
            return seasonPart;
        }
        return 'Season 01';
    }

    async _ensureDirectoryPath(cloud189, rootFolderId, relativeDir, folderCache = new Map()) {
        const normalizedRelativeDir = this._normalizePath(relativeDir);
        if (!normalizedRelativeDir) {
            return String(rootFolderId);
        }

        let currentParentId = String(rootFolderId);
        const segments = normalizedRelativeDir.split('/').filter(Boolean);

        for (const segment of segments) {
            const cacheKey = `${currentParentId}:${segment}`;
            if (folderCache.has(cacheKey)) {
                currentParentId = folderCache.get(cacheKey);
                continue;
            }
            const nextFolderId = await this._ensureFolderByName(cloud189, currentParentId, segment, folderCache);
            currentParentId = nextFolderId;
        }

        return currentParentId;
    }

    async _ensureFolderByName(cloud189, parentFolderId, folderName, folderCache = new Map()) {
        const safeFolderName = this._sanitizePathSegment(folderName);
        const cacheKey = `${String(parentFolderId)}:${safeFolderName}`;
        if (folderCache.has(cacheKey)) {
            return folderCache.get(cacheKey);
        }

        const folderInfo = await cloud189.listFiles(parentFolderId);
        const folderList = folderInfo?.fileListAO?.folderList || [];
        let folder = folderList.find(item => item.name === safeFolderName);
        if (!folder) {
            folder = await cloud189.createFolder(safeFolderName, parentFolderId);
            if (!folder?.id) {
                throw new Error(`创建整理目录失败: ${safeFolderName}`);
            }
        }

        const folderId = String(folder.id);
        folderCache.set(cacheKey, folderId);
        return folderId;
    }

    _resolveBaseFolderPath(task) {
        const normalizedFolderName = this._normalizePath(task.realFolderName || '');
        if (!normalizedFolderName) {
            return '';
        }

        const categories = Object.values(this._getCategoryMap()).map(item => this._normalizePath(item));
        let basePath = this._normalizePath(path.posix.dirname(normalizedFolderName));
        if (!basePath || basePath === '.') {
            return '';
        }
        if (categories.includes(this._normalizePath(path.posix.basename(basePath)))) {
            return this._normalizePath(path.posix.dirname(basePath));
        }

        if (task.shareFolderName) {
            const normalizedShareFolderName = this._normalizePath(task.shareFolderName);
            if (normalizedFolderName === normalizedShareFolderName || normalizedFolderName.endsWith(`/${normalizedShareFolderName}`)) {
                const rootPath = this._normalizePath(path.posix.dirname(normalizedFolderName));
                const rootBasePath = this._normalizePath(path.posix.dirname(rootPath));
                if (rootBasePath) {
                    return rootBasePath;
                }
            }
        }

        return basePath;
    }

    _parseTaskTmdbContent(tmdbContent) {
        if (!tmdbContent) {
            return null;
        }
        try {
            const parsed = JSON.parse(tmdbContent);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    _extractYear(value = '') {
        const matched = String(value || '').match(/(19|20)\d{2}/);
        return matched ? matched[0] : '';
    }

    _sanitizeTitle(title = '') {
        return String(title || '')
            .replace(/\(根\)$/g, '')
            .replace(/[\[【(（](19|20)\d{2}[\]】)）]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _sanitizePathSegment(value = '') {
        return String(value || '')
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _normalizePath(targetPath = '') {
        const normalizedPath = String(targetPath || '')
            .replace(/\\/g, '/')
            .replace(/^\.\//, '')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/{2,}/g, '/');
        return normalizedPath === '.' ? '' : normalizedPath;
    }

    _joinPosix(...parts) {
        return this._normalizePath(parts.filter(Boolean).join('/'));
    }

    _getTaskRelativeRootPath(realFolderName = '') {
        const normalizedPath = this._normalizePath(realFolderName);
        const index = normalizedPath.indexOf('/');
        return index >= 0 ? normalizedPath.substring(index + 1) : normalizedPath;
    }

    _getCategoryMap() {
        return {
            tv: ConfigService.getConfigValue('organizer.categories.tv', '电视剧'),
            anime: ConfigService.getConfigValue('organizer.categories.anime', '动漫'),
            movie: ConfigService.getConfigValue('organizer.categories.movie', '电影'),
            variety: ConfigService.getConfigValue('organizer.categories.variety', '综艺'),
            documentary: ConfigService.getConfigValue('organizer.categories.documentary', '纪录片')
        };
    }
}

module.exports = { OrganizerService };
