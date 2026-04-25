const path = require('path');
const cloud189Utils = require('../utils/Cloud189Utils');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { Cloud189Service } = require('./cloud189');
const { StrmService } = require('./strm');
const { BatchTaskDto } = require('../dto/BatchTaskDto');
const { StreamProxyService } = require('./streamProxy');
const AIService = require('./ai');
const { OrganizerService } = require('./organizer');
const { CasService } = require('./casService');
const { CasMetadataCacheService } = require('./casMetadataCache');

class LazyShareStrmService {
    constructor(accountRepo, taskService) {
        this.accountRepo = accountRepo;
        this.taskService = taskService;
        this.strmService = new StrmService();
        this.streamProxyService = new StreamProxyService();
        this.organizerService = new OrganizerService(taskService);
        this.casService = new CasService();
        this.casMetadataCache = new CasMetadataCacheService();
        this.cache = new Map();
        this.inflight = new Map();
        this.transferInflight = new Map();
        this.cleanupInflight = new Map();
        this.casMetadataInflight = new Map();
        this.casMetadataPrewarmInflight = new Map();
        this.casMetadataFolderCache = new Map();
        this.cacheTtlMs = 60 * 1000;
    }

    async generateFromShare(params) {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM生成未启用, 请启用后执行');
        }
        const accountId = Number(params.accountId);
        const targetFolderId = String(params.targetFolderId || '').trim();
        const shareLink = String(params.shareLink || '').trim();
        const localPathPrefix = String(params.localPathPrefix || '').trim();
        const overwriteExisting = !!params.overwriteExisting;

        if (!accountId) {
            throw new Error('账号不能为空');
        }
        if (!targetFolderId) {
            throw new Error('目标目录不能为空');
        }
        if (!shareLink) {
            throw new Error('分享链接不能为空');
        }
        if (!localPathPrefix) {
            throw new Error('本地STRM目录不能为空');
        }

        const account = await this.accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const shareData = await this._resolveShare(shareLink, params.accessCode, cloud189);
        const entries = await this._collectShareEntries(cloud189, shareData.shareInfo, shareData.accessCode);
        const mediaEntries = this._filterMediaEntries(entries);
        if (!mediaEntries.length) {
            throw new Error('分享目录中没有匹配媒体后缀的文件');
        }

        const rootName = shareData.shareInfo.isFolder ? shareData.shareInfo.fileName : '';
        const organized = await this._buildStrmLayout({
            localPathPrefix,
            resourceName: params.resourceName || shareData.shareInfo.fileName,
            rootName,
            files: mediaEntries,
            tmdbInfo: params.tmdbInfo || null,
            enableOrganizer: !!params.enableOrganizer,
            task: null
        });

        await this.strmService.generateCustom(
            organized.targetRoot,
            organized.files,
            async (file) => this.streamProxyService.buildStreamUrl({
                type: 'lazyShare',
                accountId,
                shareId: shareData.shareInfo.shareId,
                shareMode: shareData.shareInfo.shareMode,
                fileId: file.id,
                fileName: file.sourceFileName || file.name,
                targetFolderId,
                rootName,
                relativeDir: file.sourceRelativeDir || '',
                isCas: !!file.isCas,
                originalFileName: file.originalFileName || ''
            }),
            overwriteExisting,
            false
        );
        this._scheduleCasMetadataPrewarm(cloud189, {
            accountId,
            shareId: shareData.shareInfo.shareId,
            shareMode: shareData.shareInfo.shareMode,
            files: organized.files,
            resourceName: params.resourceName || shareData.shareInfo.fileName
        });

        const message = `懒转存STRM生成完成，资源: ${shareData.shareInfo.fileName}，文件数: ${mediaEntries.length}`;
        logTaskEvent(message);
        return {
            message,
            rootName: shareData.shareInfo.fileName,
            fileCount: mediaEntries.length
        };
    }

    async generateFromTask(task, files = [], overwriteExisting = false) {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM生成未启用, 请启用后执行');
        }
        const accountId = Number(task.accountId || task.account?.id);
        const targetFolderId = String(task.realFolderId || '').trim();
        const shareId = String(task.shareId || '').trim();
        const localPathPrefix = this._getTaskLocalPath(task);

        if (!accountId) {
            throw new Error('任务缺少账号信息');
        }
        if (!targetFolderId) {
            throw new Error('任务缺少目标目录');
        }
        if (!shareId) {
            throw new Error('任务缺少分享信息');
        }
        if (!localPathPrefix) {
            throw new Error('任务缺少STRM目录');
        }

        const mediaEntries = this._filterMediaEntries(
            (files || []).map((file) => ({
                id: String(file.id),
                name: file.name,
                relativeDir: ''
            }))
        );
        if (!mediaEntries.length) {
            throw new Error('任务当前没有可生成懒转存STRM的媒体文件');
        }

        const organized = await this._buildStrmLayout({
            localPathPrefix,
            resourceName: task.resourceName,
            rootName: '',
            files: mediaEntries,
            enableOrganizer: !!task.enableOrganizer,
            task
        });

        await this.strmService.generateCustom(
            organized.targetRoot,
            organized.files,
            async (file) => this.streamProxyService.buildStreamUrl({
                type: 'lazyShare',
                accountId,
                shareId,
                shareMode: task.shareMode,
                fileId: file.id,
                fileName: file.sourceFileName || file.name,
                targetFolderId,
                rootName: '',
                relativeDir: file.sourceRelativeDir || '',
                isCas: !!file.isCas,
                originalFileName: file.originalFileName || ''
            }),
            overwriteExisting,
            true
        );
        const account = task.account || await this.accountRepo.findOneBy({ id: accountId });
        if (account) {
            const cloud189 = Cloud189Service.getInstance(account);
            this._scheduleCasMetadataPrewarm(cloud189, {
                accountId,
                shareId,
                shareMode: task.shareMode,
                files: organized.files,
                resourceName: task.resourceName
            });
        }

        const message = `任务[${task.resourceName}]懒转存STRM生成完成，文件数: ${mediaEntries.length}`;
        logTaskEvent(message);
        return message;
    }

    async resolveLatestUrlByPayload(payload) {
        const cacheKey = this._getCacheKey(payload);
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.url;
        }
        if (this.inflight.has(cacheKey)) {
            return await this.inflight.get(cacheKey);
        }

        const pending = this._resolveAndCache(payload)
            .finally(() => this.inflight.delete(cacheKey));
        this.inflight.set(cacheKey, pending);
        return await pending;
    }

    async _resolveAndCache(payload) {
        const account = await this.accountRepo.findOneBy({ id: Number(payload.accountId) });
        if (!account) {
            throw new Error('播放账号不存在');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const targetFolderId = await this._resolveTransferTargetFolder(cloud189, payload);
        const expectedFileName = payload.isCas
            ? (payload.originalFileName || CasService.getOriginalFileName(payload.fileName))
            : payload.fileName;
        let targetFile = await this._findFileByName(cloud189, targetFolderId, expectedFileName);

        if (!targetFile) {
            targetFile = await this._ensureTransferredFile(cloud189, payload, targetFolderId);
        }

        if (!targetFile) {
            throw new Error('懒转存完成后未找到目标文件');
        }

        const latestUrl = await cloud189.getDownloadLink(targetFile.id);
        this.cache.set(this._getCacheKey(payload), {
            url: latestUrl,
            expiresAt: Date.now() + this.cacheTtlMs
        });
        return latestUrl;
    }

    async _resolveTransferTargetFolder(cloud189, payload) {
        const preferredFolderId = String(payload.targetFolderId || '').trim();
        const preferredFolder = await this._inspectFolder(cloud189, preferredFolderId);
        if (preferredFolder.exists) {
            return await this._ensureTargetFolder(
                cloud189,
                preferredFolderId,
                payload.rootName,
                payload.relativeDir
            );
        }
        if (!preferredFolder.missing) {
            throw new Error(preferredFolder.message || '获取懒转存目标目录失败');
        }

        const recoveredTaskFolderId = await this._recoverTaskTargetFolder(cloud189, payload);
        if (recoveredTaskFolderId) {
            return await this._ensureTargetFolder(
                cloud189,
                recoveredTaskFolderId,
                payload.rootName,
                payload.relativeDir
            );
        }

        const fallbackFolderId = await this._ensureFallbackTargetFolder(cloud189, payload);
        return await this._ensureTargetFolder(
            cloud189,
            fallbackFolderId,
            payload.rootName,
            payload.relativeDir
        );
    }

    async _resolveShare(shareLink, accessCode, cloud189) {
        const { url, accessCode: parsedAccessCode } = cloud189Utils.parseCloudShare(shareLink);
        const normalizedShareLink = url || shareLink;
        const finalAccessCode = String(accessCode || parsedAccessCode || '').trim();
        const shareCode = cloud189Utils.parseShareCode(normalizedShareLink);
        const shareInfo = await this.taskService.getShareInfo(cloud189, shareCode);
        if (shareInfo.shareMode == 1) {
            if (!finalAccessCode) {
                throw new Error('分享链接为加密链接，请提供访问码');
            }
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, finalAccessCode);
            if (!accessCodeResponse?.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        if (!shareInfo.shareId) {
            throw new Error('获取分享信息失败');
        }
        return {
            shareLink: normalizedShareLink,
            accessCode: finalAccessCode,
            shareInfo
        };
    }

    async _collectShareEntries(cloud189, shareInfo, accessCode, folderId = null, relativeDir = '') {
        if (!shareInfo.isFolder) {
            return [{
                id: String(shareInfo.fileId),
                name: shareInfo.fileName,
                relativeDir: ''
            }];
        }

        const currentFolderId = folderId || shareInfo.fileId;
        const resp = await cloud189.listShareDir(
            shareInfo.shareId,
            currentFolderId,
            shareInfo.shareMode,
            accessCode
        );
        if (!resp?.fileListAO) {
            return [];
        }

        const result = [];
        for (const folder of (resp.fileListAO.folderList || [])) {
            const nextRelativeDir = path.join(relativeDir, folder.name);
            const children = await this._collectShareEntries(
                cloud189,
                shareInfo,
                accessCode,
                folder.id,
                nextRelativeDir
            );
            result.push(...children);
        }

        for (const file of (resp.fileListAO.fileList || [])) {
            result.push({
                id: String(file.id),
                name: file.name,
                relativeDir
            });
        }

        return result;
    }

    _filterMediaEntries(entries) {
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix')
            .split(';')
            .map((suffix) => suffix.toLowerCase());
        return entries.filter((file) => {
            if (CasService.isCasFile(file.name)) {
                return true;
            }
            const fileExt = '.' + String(file.name).split('.').pop().toLowerCase();
            return mediaSuffixs.includes(fileExt);
        }).map((file) => {
            const isCas = CasService.isCasFile(file.name);
            const originalFileName = isCas
                ? CasService.getOriginalFileName(file.name)
                : file.name;
            return {
                ...file,
                isCas,
                originalFileName
            };
        });
    }

    _groupEntriesByRelativeDir(entries) {
        const groups = new Map();
        for (const entry of entries) {
            const relativeDir = this._normalizeRelativePath(entry.relativeDir || '');
            if (!groups.has(relativeDir)) {
                groups.set(relativeDir, []);
            }
            groups.get(relativeDir).push(entry);
        }
        return groups;
    }

    async _buildStrmLayout({ localPathPrefix, resourceName, rootName = '', files = [], tmdbInfo = null, enableOrganizer = false, task = null }) {
        const normalizedLocalPathPrefix = this._normalizeRelativePath(localPathPrefix);
        const fallbackRootName = this._normalizeRelativePath(rootName);
        const normalizedResourceName = String(resourceName || rootName || '').trim();
        const fallbackTargetRoot = this._resolveFallbackTargetRoot({
            localPathPrefix: normalizedLocalPathPrefix,
            rootName: fallbackRootName,
            resourceName: normalizedResourceName,
            enableOrganizer,
            task
        });
        const preparedFiles = files.map(file => ({
            ...file,
            relativeDir: this._normalizeRelativePath(file.relativeDir || ''),
            sourceRelativeDir: this._normalizeRelativePath(file.relativeDir || ''),
            sourceFileName: file.sourceFileName || file.name,
            originalFileName: file.originalFileName || (CasService.isCasFile(file.name) ? CasService.getOriginalFileName(file.name) : file.name)
        }));

        if (!enableOrganizer) {
            return {
                targetRoot: fallbackTargetRoot,
                files: preparedFiles
            };
        }

        let resourceInfo = null;
        if (AIService.isEnabled()) {
            try {
                resourceInfo = await this.taskService._analyzeResourceInfo(
                    normalizedResourceName,
                    preparedFiles.map(file => ({ id: file.id, name: file.name })),
                    'file'
                );
            } catch (error) {
                logTaskEvent(`懒转存整理分析失败，已回退基础分类: ${error.message}`);
            }
        }

        let resolvedTmdbInfo = tmdbInfo || this._parseTaskTmdbContent(task?.tmdbContent);
        if (!resolvedTmdbInfo && task?.tmdbId) {
            try {
                resolvedTmdbInfo = await this.organizerService._resolveTmdbInfo(task, resourceInfo || {
                    name: normalizedResourceName,
                    type: 'tv',
                    year: ''
                });
            } catch (error) {
                logTaskEvent(`懒转存整理获取TMDB失败，已回退基础分类: ${error.message}`);
            }
        }

        if (!resourceInfo && !resolvedTmdbInfo) {
            logTaskEvent(`懒转存整理回退到安全目录: ${fallbackTargetRoot || '(根目录)'}`);
            return {
                targetRoot: fallbackTargetRoot,
                files: preparedFiles
            };
        }

        const taskLike = {
            resourceName: normalizedResourceName || fallbackRootName || task?.resourceName || ''
        };
        const libraryInfo = this.organizerService._resolveLibraryInfo(taskLike, resourceInfo || null, resolvedTmdbInfo || null);
        const template = resourceInfo?.type === 'movie'
            ? ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}'
            : ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}';
        const episodeMap = new Map((resourceInfo?.episode || []).map(item => [String(item.id), item]));

        const organizedFiles = preparedFiles.map(file => {
            const aiFile = episodeMap.get(String(file.id));
            const baseFile = file.isCas
                ? { ...file, name: file.originalFileName || file.name }
                : file;
            const targetName = aiFile
                ? this.taskService._generateFileName(baseFile, aiFile, resourceInfo, template)
                : (file.originalFileName || file.name);
            const targetRelativeDir = this.organizerService._buildTargetRelativeDir(
                { ...file, name: targetName },
                aiFile,
                resourceInfo || { type: libraryInfo.mediaType || 'tv' },
                libraryInfo
            );
            return {
                ...file,
                name: targetName,
                relativeDir: this._normalizeRelativePath(targetRelativeDir)
            };
        });

        return {
            targetRoot: this._normalizeRelativePath(path.join(normalizedLocalPathPrefix, libraryInfo.categoryName, libraryInfo.resourceFolderName)),
            files: organizedFiles
        };
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

    _resolveFallbackTargetRoot({ localPathPrefix = '', rootName = '', resourceName = '', enableOrganizer = false, task = null }) {
        const normalizedLocalPathPrefix = this._normalizeRelativePath(localPathPrefix);
        if (enableOrganizer && task?.realFolderName) {
            const taskRelativeRoot = this._getTaskRelativeRootPath(task.realFolderName);
            if (taskRelativeRoot) {
                return this._normalizeRelativePath(path.join(normalizedLocalPathPrefix, taskRelativeRoot));
            }
        }

        const safeRootName = this._normalizeRelativePath(rootName || this._sanitizePathSegment(resourceName));
        return this._normalizeRelativePath(path.join(normalizedLocalPathPrefix, safeRootName));
    }

    _normalizeRelativePath(targetPath = '') {
        return String(targetPath || '')
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/{2,}/g, '/');
    }

    _getTaskRelativeRootPath(realFolderName = '') {
        const normalizedPath = this._normalizeRelativePath(realFolderName);
        const index = normalizedPath.indexOf('/');
        return index >= 0 ? normalizedPath.substring(index + 1) : normalizedPath;
    }

    _sanitizePathSegment(value = '') {
        return String(value || '')
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _getCacheKey(payload) {
        return [
            payload.accountId,
            payload.shareId,
            payload.fileId,
            payload.targetFolderId,
            payload.rootName || '',
            payload.relativeDir || ''
        ].join(':');
    }

    _getTaskLocalPath(task) {
        if (task?.enableOrganizer) {
            return this._normalizeRelativePath(task.account?.localStrmPrefix || '');
        }
        const realFolderName = String(task.realFolderName || '').replace(/\\/g, '/');
        const index = realFolderName.indexOf('/');
        const taskRelativePath = index >= 0 ? realFolderName.substring(index + 1) : realFolderName;
        return this._normalizeRelativePath(path.join(task.account?.localStrmPrefix || '', taskRelativePath));
    }

    async _inspectFolder(cloud189, folderId) {
        const normalizedFolderId = String(folderId || '').trim();
        if (!normalizedFolderId || normalizedFolderId === '-11') {
            return { exists: true, missing: false, id: '-11' };
        }

        const folderInfo = await cloud189.listFiles(normalizedFolderId);
        if (folderInfo?.fileListAO) {
            return { exists: true, missing: false, id: normalizedFolderId };
        }
        const missing = folderInfo?.res_code === 'FileNotFound'
            || folderInfo?.errorCode === 'FolderNotExist'
            || folderInfo?.res_message === 'FolderNotExist'
            || folderInfo?.res_msg === 'FolderNotExist';
        if (missing) {
            return { exists: false, missing: true, id: normalizedFolderId };
        }
        return {
            exists: false,
            missing: false,
            id: normalizedFolderId,
            message: folderInfo?.res_msg || folderInfo?.res_message || folderInfo?.errorMsg || '获取目录信息失败'
        };
    }

    async _recoverTaskTargetFolder(cloud189, payload) {
        const taskRepo = this.taskService?.taskRepo;
        const staleFolderId = String(payload.targetFolderId || '').trim();
        if (!taskRepo || !staleFolderId) {
            return '';
        }

        const task = await taskRepo.findOne({
            where: {
                realFolderId: staleFolderId,
                enableLazyStrm: true
            }
        });
        if (!task) {
            return '';
        }
        if (String(task.accountId || '') !== String(payload.accountId || '')) {
            return '';
        }
        if (String(task.shareId || '') !== String(payload.shareId || '')) {
            return '';
        }

        try {
            await this.taskService._autoCreateFolder(cloud189, task);
            const recoveredFolderId = String(task.realFolderId || '').trim();
            if (recoveredFolderId) {
                logTaskEvent(`懒转存目录已自动恢复: ${staleFolderId} -> ${recoveredFolderId}`);
                return recoveredFolderId;
            }
        } catch (error) {
            logTaskEvent(`懒转存目录自动恢复失败: ${staleFolderId}, 错误: ${error.message}`);
        }
        return '';
    }

    async _ensureFallbackTargetFolder(cloud189, payload) {
        const cacheFolderId = await this._ensureChildFolder(cloud189, '-11', '懒转存缓存');
        const shareFolderName = this._sanitizePathSegment(payload.shareId || payload.rootName || 'unknown');
        const fallbackFolderId = await this._ensureChildFolder(cloud189, cacheFolderId, shareFolderName || 'unknown');
        logTaskEvent(`懒转存目标目录不存在，已切换到回退目录: ${payload.targetFolderId || '(空)'} -> ${fallbackFolderId}`);
        return fallbackFolderId;
    }

    async _ensureTargetFolder(cloud189, baseFolderId, rootName, relativeDir) {
        let currentFolderId = String(baseFolderId || '-11');
        const segments = [];
        if (rootName) {
            segments.push(rootName);
        }
        const normalizedRelativeDir = this._normalizeRelativePath(relativeDir);
        if (normalizedRelativeDir) {
            segments.push(...normalizedRelativeDir.split('/'));
        }

        for (const segment of segments) {
            currentFolderId = await this._ensureChildFolder(cloud189, currentFolderId, segment);
        }
        return currentFolderId;
    }

    async _ensureChildFolder(cloud189, parentFolderId, folderName) {
        const folderInfo = await cloud189.listFiles(parentFolderId);
        const folders = folderInfo?.fileListAO?.folderList || [];
        const existFolder = folders.find((folder) => folder.name === folderName);
        if (existFolder?.id) {
            return String(existFolder.id);
        }
        const created = await cloud189.createFolder(folderName, parentFolderId);
        if (!created?.id) {
            throw new Error(`创建目录失败: ${folderName}`);
        }
        return String(created.id);
    }

    async _findFileByName(cloud189, folderId, fileName) {
        const folderInfo = await cloud189.listFiles(folderId);
        const files = folderInfo?.fileListAO?.fileList || [];
        return files.find((file) => file.name === fileName) || null;
    }

    _getTransferKey(payload, targetFolderId) {
        return [payload.accountId, payload.shareId, payload.fileId, targetFolderId, payload.fileName].join(':');
    }

    _getCasMetadataKey(payload = {}) {
        return [
            String(payload.accountId || '').trim(),
            String(payload.shareId || '').trim(),
            String(payload.fileId || '').trim()
        ].join(':');
    }

    _normalizeCasMetadata(casInfo = {}) {
        const normalized = {
            name: String(casInfo.name || '').trim(),
            size: Number(casInfo.size || 0) || 0,
            md5: String(casInfo.md5 || '').trim().toUpperCase(),
            sliceMd5: String(casInfo.sliceMd5 || '').trim().toUpperCase()
        };
        if (!normalized.name || !normalized.size || !normalized.md5 || !normalized.sliceMd5) {
            return null;
        }
        return normalized;
    }

    async _getCachedCasMetadata(payload = {}) {
        return await this.casMetadataCache.get({
            accountId: payload.accountId,
            shareId: payload.shareId,
            fileId: payload.fileId
        });
    }

    async _storeCasMetadata(payload = {}, casInfo = {}) {
        const normalized = this._normalizeCasMetadata(casInfo);
        if (!normalized) {
            throw new Error('CAS元数据无效');
        }
        return await this.casMetadataCache.set({
            accountId: payload.accountId,
            shareId: payload.shareId,
            fileId: payload.fileId
        }, normalized);
    }

    async _resolveCasMetadata(cloud189, payload, options = {}) {
        const cacheKey = this._getCasMetadataKey(payload);
        if (!cacheKey || cacheKey === '::') {
            throw new Error('CAS元数据缺少必要标识');
        }
        if (this.casMetadataInflight.has(cacheKey)) {
            return await this.casMetadataInflight.get(cacheKey);
        }

        const pending = (async () => {
            const cached = await this._getCachedCasMetadata(payload);
            if (cached) {
                return cached;
            }

            if (options.casFileId) {
                const casInfo = await this.casService.downloadAndParseCas(cloud189, options.casFileId);
                return await this._storeCasMetadata(payload, casInfo);
            }

            if (options.allowShareTransfer) {
                const casInfo = await this._downloadCasMetadataViaShareTransfer(cloud189, payload);
                return await this._storeCasMetadata(payload, casInfo);
            }

            throw new Error(`未命中CAS元数据缓存: ${payload.fileName || payload.fileId}`);
        })().finally(() => this.casMetadataInflight.delete(cacheKey));

        this.casMetadataInflight.set(cacheKey, pending);
        return await pending;
    }

    async _ensureTransferredFile(cloud189, payload, targetFolderId) {
        const transferKey = this._getTransferKey(payload, targetFolderId);
        if (this.transferInflight.has(transferKey)) {
            return await this.transferInflight.get(transferKey);
        }

        const pending = (async () => {
            if (payload.isCas) {
                const cachedCasInfo = await this._getCachedCasMetadata(payload);
                if (cachedCasInfo) {
                    try {
                        logTaskEvent(`懒转存CAS命中本地元数据缓存，直接秒传恢复: ${payload.fileName}`);
                        return await this._restoreCasFromMetadata(cloud189, targetFolderId, payload, cachedCasInfo);
                    } catch (error) {
                        logTaskEvent(`懒转存CAS直恢复失败，回退分享转存: ${payload.fileName}, 错误: ${error.message}`);
                    }
                }
            }

            const submitResult = await this._submitShareSaveTask(cloud189, payload, targetFolderId);
            const transferredFile = await this._waitForTransferredFile(cloud189, targetFolderId, payload.fileName, submitResult);
            if (!payload.isCas) {
                return transferredFile;
            }
            return await this._restoreCasTransferredFile(cloud189, targetFolderId, transferredFile, payload);
        })().finally(() => this.transferInflight.delete(transferKey));

        this.transferInflight.set(transferKey, pending);
        return await pending;
    }

    async _restoreCasFromMetadata(cloud189, targetFolderId, payload, casInfo) {
        const restoreName = payload.originalFileName || CasService.getOriginalFileName(payload.fileName, casInfo);
        let restoredFile = await this._findFileByName(cloud189, targetFolderId, restoreName);
        if (restoredFile) {
            return restoredFile;
        }

        await this.casService.restoreFromCas(cloud189, targetFolderId, casInfo, restoreName);
        restoredFile = await this._waitForTransferredFile(cloud189, targetFolderId, restoreName, {}, 30, 1000);
        return restoredFile;
    }

    async _restoreCasTransferredFile(cloud189, targetFolderId, casFile, payload) {
        const restoreName = payload.originalFileName || CasService.getOriginalFileName(payload.fileName);
        let restoredFile = await this._findFileByName(cloud189, targetFolderId, restoreName);
        if (restoredFile) {
            this._scheduleCasCleanup(cloud189, targetFolderId, casFile);
            return restoredFile;
        }

        const casInfo = await this._resolveCasMetadata(cloud189, payload, { casFileId: casFile.id });
        await this.casService.restoreFromCas(cloud189, targetFolderId, casInfo, restoreName);
        restoredFile = await this._waitForTransferredFile(cloud189, targetFolderId, restoreName, {}, 30, 1000);
        this._scheduleCasCleanup(cloud189, targetFolderId, casFile);
        return restoredFile;
    }

    async _waitForTransferredFile(cloud189, targetFolderId, fileName, submitResult = {}, maxAttempts = 120, intervalMs = 1000) {
        const totalAttempts = submitResult.canTrackTask === false ? 15 : maxAttempts;
        let lastTaskStatus = null;
        for (let index = 0; index < totalAttempts; index++) {
            const file = await this._findFileByName(cloud189, targetFolderId, fileName);
            if (file) {
                logTaskEvent(`懒转存完成: ${fileName}`);
                return file;
            }

            if (submitResult.taskId && (index === 0 || index % 3 === 2)) {
                lastTaskStatus = await this._syncShareSaveTask(cloud189, submitResult.taskId, submitResult.batchTaskDto);
            }

            if (index < totalAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }
        const statusMessage = submitResult.canTrackTask === false
            ? ', 云盘返回重复提交但未返回任务编号，无法跟踪现有任务状态'
            : (lastTaskStatus == null ? '' : `, 最后任务状态: ${lastTaskStatus}`);
        throw new Error(`懒转存完成后未找到目标文件${statusMessage}`);
    }

    _getCasCleanupKey(targetFolderId, casFile) {
        return [targetFolderId, casFile?.id || '', casFile?.name || ''].join(':');
    }

    _scheduleCasCleanup(cloud189, targetFolderId, casFile) {
        if (!casFile?.id) {
            return;
        }

        const cleanupKey = this._getCasCleanupKey(targetFolderId, casFile);
        if (this.cleanupInflight.has(cleanupKey)) {
            return;
        }

        const pending = this._deleteTransferredCasFile(cloud189, targetFolderId, casFile)
            .catch((error) => {
                logTaskEvent(`删除懒转存CAS文件失败: ${casFile.name}, 错误: ${error.message}`);
            })
            .finally(() => this.cleanupInflight.delete(cleanupKey));
        this.cleanupInflight.set(cleanupKey, pending);
    }

    _scheduleCasMetadataPrewarm(cloud189, params = {}) {
        const casFiles = (params.files || []).filter((file) => file?.isCas);
        if (!casFiles.length) {
            return;
        }

        const prewarmKey = `${params.accountId}:${params.shareId}`;
        if (this.casMetadataPrewarmInflight.has(prewarmKey)) {
            return;
        }

        const pending = this._prewarmCasMetadata(cloud189, {
            accountId: params.accountId,
            shareId: params.shareId,
            files: casFiles,
            resourceName: params.resourceName || ''
        }).catch((error) => {
            logTaskEvent(`懒转存CAS元数据预提取失败: ${params.resourceName || params.shareId}, 错误: ${error.message}`);
        }).finally(() => this.casMetadataPrewarmInflight.delete(prewarmKey));
        this.casMetadataPrewarmInflight.set(prewarmKey, pending);
    }

    async _prewarmCasMetadata(cloud189, params = {}) {
        const casFiles = params.files || [];
        if (!casFiles.length) {
            return;
        }

        let warmed = 0;
        let skipped = 0;
        let failed = 0;
        logTaskEvent(`开始预提取CAS元数据: ${params.resourceName || params.shareId}, 文件数: ${casFiles.length}`);
        for (const file of casFiles) {
            const payload = {
                accountId: params.accountId,
                shareId: params.shareId,
                shareMode: params.shareMode,
                fileId: file.id,
                fileName: file.sourceFileName || file.name,
                isCas: true,
                originalFileName: file.originalFileName || ''
            };

            try {
                const cached = await this._getCachedCasMetadata(payload);
                if (cached) {
                    skipped++;
                    continue;
                }
                await this._resolveCasMetadata(cloud189, payload, { allowShareTransfer: true });
                warmed++;
            } catch (error) {
                failed++;
                logTaskEvent(`CAS元数据预提取失败: ${payload.fileName}, 错误: ${error.message}`);
            }
        }
        logTaskEvent(`CAS元数据预提取完成: ${params.resourceName || params.shareId}, 成功: ${warmed}, 跳过: ${skipped}, 失败: ${failed}`);
    }

    async _ensureCasMetadataFolder(cloud189, payload = {}) {
        const accountId = String(payload.accountId || '').trim() || 'unknown';
        const shareId = String(payload.shareId || '').trim() || 'unknown';
        const cacheKey = `${accountId}:${shareId}`;
        const cachedFolderId = this.casMetadataFolderCache.get(cacheKey);
        if (cachedFolderId) {
            const inspectResult = await this._inspectFolder(cloud189, cachedFolderId);
            if (inspectResult.exists) {
                return cachedFolderId;
            }
            this.casMetadataFolderCache.delete(cacheKey);
        }

        const rootFolderId = await this._ensureChildFolder(cloud189, '-11', '懒转存元数据');
        const shareFolderId = await this._ensureChildFolder(cloud189, rootFolderId, this._sanitizePathSegment(shareId) || 'unknown');
        this.casMetadataFolderCache.set(cacheKey, shareFolderId);
        return shareFolderId;
    }

    async _downloadCasMetadataViaShareTransfer(cloud189, payload) {
        const metadataFolderId = await this._ensureCasMetadataFolder(cloud189, payload);
        const transferredCasFile = await this._ensureMetadataTransferredCasFile(cloud189, payload, metadataFolderId);
        const casInfo = await this.casService.downloadAndParseCas(cloud189, transferredCasFile.id);
        this._scheduleCasCleanup(cloud189, metadataFolderId, transferredCasFile);
        return casInfo;
    }

    async _ensureMetadataTransferredCasFile(cloud189, payload, targetFolderId) {
        const transferKey = `metadata:${this._getTransferKey(payload, targetFolderId)}`;
        if (this.transferInflight.has(transferKey)) {
            return await this.transferInflight.get(transferKey);
        }

        const pending = (async () => {
            let transferredCasFile = await this._findFileByName(cloud189, targetFolderId, payload.fileName);
            if (transferredCasFile) {
                return transferredCasFile;
            }

            const submitResult = await this._submitShareSaveTask(cloud189, payload, targetFolderId);
            return await this._waitForTransferredFile(cloud189, targetFolderId, payload.fileName, submitResult, 30, 1000);
        })().finally(() => this.transferInflight.delete(transferKey));

        this.transferInflight.set(transferKey, pending);
        return await pending;
    }

    async _deleteTransferredCasFile(cloud189, targetFolderId, casFile, maxAttempts = 30, intervalMs = 1000) {
        await cloud189.deleteFile(casFile.id, casFile.name);
        for (let index = 0; index < maxAttempts; index++) {
            const remainFile = await this._findFileByName(cloud189, targetFolderId, casFile.name);
            if (!remainFile) {
                logTaskEvent(`已删除懒转存CAS文件: ${casFile.name}`);
                return;
            }
            if (index < maxAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }
        throw new Error(`CAS文件仍存在于目标目录: ${casFile.name}`);
    }

    async _syncShareSaveTask(cloud189, taskId, batchTaskDto) {
        const task = await cloud189.checkTaskStatus(taskId, batchTaskDto);
        if (!task) {
            return null;
        }

        const taskStatus = Number(task.taskStatus);
        if (taskStatus === -1) {
            const errorMessage = task.errorCode || task.res_msg || task.res_message || task.errorMsg || '懒转存任务失败';
            throw new Error(`懒转存任务失败: ${errorMessage}`);
        }
        if (taskStatus === 2) {
            const conflictTaskInfo = await cloud189.getConflictTaskInfo(taskId, batchTaskDto);
            const taskInfos = conflictTaskInfo?.taskInfos || [];
            if (conflictTaskInfo?.targetFolderId && taskInfos.length) {
                for (const taskInfo of taskInfos) {
                    taskInfo.dealWay = 1;
                }
                await cloud189.manageBatchTask(taskId, conflictTaskInfo.targetFolderId, taskInfos, batchTaskDto);
                logTaskEvent(`懒转存任务检测到冲突，已自动忽略冲突项: ${taskId}`);
            }
        }

        if (taskStatus !== -1 && taskStatus !== 1 && taskStatus !== 3) {
            logTaskEvent(`懒转存任务状态同步: ${taskId} => ${task.taskStatus}`);
        }
        return taskStatus;
    }

    async _submitShareSaveTask(cloud189, payload, targetFolderId) {
        logTaskEvent(`懒转存开始: ${payload.fileName}`);
        const batchTaskDto = new BatchTaskDto({
            taskInfos: JSON.stringify([{
                fileId: payload.fileId,
                fileName: payload.fileName,
                isFolder: 0
            }]),
            type: 'SHARE_SAVE',
            targetFolderId,
            shareId: payload.shareId
        });
        if (payload.shareMode == 5) {
            batchTaskDto.copyType = '3';
        }
        const resp = await cloud189.createBatchTask(batchTaskDto);
        if (!resp) {
            throw new Error('懒转存任务提交失败');
        }
        const taskId = resp.taskId ? String(resp.taskId) : null;
        if (resp.res_code === 'RequestResubmit') {
            if (taskId) {
                logTaskEvent(`懒转存复用已有转存任务: ${payload.fileName}, 任务ID: ${taskId}`);
            } else {
                logTaskEvent(`懒转存收到重复提交响应但未返回任务ID: ${payload.fileName}`);
            }
            return {
                taskId,
                batchTaskDto,
                canTrackTask: !!taskId
            };
        }
        if (Number(resp.res_code) !== 0) {
            throw new Error(resp.res_msg || resp.res_message || '懒转存任务提交失败');
        }
        logTaskEvent(`懒转存任务已提交: ${JSON.stringify(resp)}`);
        return {
            taskId,
            batchTaskDto,
            canTrackTask: true
        };
    }
}

module.exports = { LazyShareStrmService };
