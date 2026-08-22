const path = require('path');
const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');
const { StrmService } = require('./strm');
const { TMDBService } = require('./tmdb');
const { logTaskEvent } = require('../utils/logUtils');
const { MediaLibraryLayoutService, normalizeRelativePath } = require('./mediaLibraryLayout');
const { CasService } = require('./casService');
const { CasArchiveService } = require('./casArchiveService');
const { CloudMutationExecutor } = require('./cloudMutationExecutor');
const { mergeMetadataOverrides, parseJson } = require('./metadataOverride');
const { auditService } = require('./auditService');

class OrganizerService {
    constructor(taskService, taskRepo = null) {
        this.taskService = taskService || null;
        this.taskRepo = taskRepo || (taskService && taskService.taskRepo) || null;
        this.tmdbService = new TMDBService();
        this.mutationExecutor = new CloudMutationExecutor();
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
            await auditService.recordOperation('skip', 'skipped', {
                reason: '任务未启用整理器', decisionSource: 'task_config'
            });
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

        // 懒任务的目标目录尚未转存，实体文件在分享侧：从分享目录列文件，
        // 否则 getFilesByTask 扫到空的目标目录会误报"没有可整理的文件"
        const sourceFiles = isLazy
            ? await this.taskService.getLazyStrmFilesByTask(task)
            : await this.taskService.getFilesByTask(task);
        const allFiles = sourceFiles
            .filter(file => !file.isFolder)
            .filter(file => !CasService.isCasFile(file.name))
            .filter(file => !CasArchiveService.isArchivePath(file.relativePath || file.relativeDir || ''));
        if (!allFiles.length) {
            throw new Error('当前任务目录没有可整理的文件');
        }

        const metadataOverride = mergeMetadataOverrides({
            [parseJson(task.metadataOverrideJson, {})?.source === 'agent' ? 'agent' : 'user']: parseJson(task.metadataOverrideJson, null)
        });

        logTaskEvent(`任务[${task.resourceName}]开始执行整理器`);
        this.layoutService.taskService = this.taskService;
        let libraryInfo = await this.layoutService.resolveLibraryInfo({
            resourceName: task.resourceName,
            files: allFiles.map(file => ({ id: file.id, name: file.name })),
            task,
            forceRefresh: !!forceRefresh,
            useAi: true
        });
        if (metadataOverride) {
            libraryInfo = this._applyMetadataOverrideToLibraryInfo(libraryInfo, metadataOverride, allFiles);
        }
        const resourceInfo = libraryInfo.resourceInfo || {
            name: libraryInfo.canonicalTitle,
            year: libraryInfo.year,
            type: libraryInfo.mediaType,
            episode: []
        };
        await auditService.event('identified', '媒体识别完成', {
            phase: 'identify',
            data: {
                source: metadataOverride?.source || libraryInfo.source || 'rules',
                title: libraryInfo.canonicalTitle,
                mediaType: libraryInfo.mediaType,
                tmdbId: libraryInfo.tmdbId || '',
                categoryName: libraryInfo.categoryName,
                resourceFolderName: libraryInfo.resourceFolderName,
                fileCount: allFiles.length
            }
        });
        await auditService.recordOperation('identify', 'completed', {
            before: { resourceName: task.resourceName, fileCount: allFiles.length },
            after: {
                title: libraryInfo.canonicalTitle,
                mediaType: libraryInfo.mediaType,
                tmdbId: libraryInfo.tmdbId || '',
                category: libraryInfo.categoryName
            },
            decisionSource: metadataOverride?.source || libraryInfo.source || 'rules'
        });

        // 锁定 layout（防 AI 漂移）
        const layoutJson = this.layoutService.serializeLibraryLayout(libraryInfo);
        task.libraryLayout = layoutJson;
        let canonicalMetadata = {};
        if (libraryInfo.tmdbId) {
            const tmdbDetails = await this._fetchTmdbDetailsById(libraryInfo.tmdbId, libraryInfo.mediaType);
            if (tmdbDetails?.id && tmdbDetails?.title) {
                const tmdbType = tmdbDetails.type === 'movie' ? 'movie' : 'tv';
                const tmdbYear = this._extractYear(tmdbDetails.releaseDate) || libraryInfo.year || '';
                const canonicalTitle = this._sanitizePathSegment(tmdbDetails.title);
                canonicalMetadata = {
                    resourceName: tmdbYear ? `${canonicalTitle} (${tmdbYear})` : canonicalTitle,
                    tmdbTitle: canonicalTitle,
                    videoType: tmdbType,
                    tmdbContent: JSON.stringify(tmdbDetails)
                };
                // 同步季集数到任务（自动路径之前漏了，导致前端显示不出集数，需手动重绑 TMDB 才行）
                if (tmdbType === 'tv') {
                    const seasonNumber = Number(task.manualSeason || task.tmdbSeasonNumber || 1) || 1;
                    const seasonEpisodes = this._getSeasonEpisodeCount(tmdbDetails, seasonNumber);
                    canonicalMetadata.tmdbSeasonNumber = seasonNumber;
                    canonicalMetadata.tmdbSeasonEpisodes = seasonEpisodes || Number(tmdbDetails.totalEpisodes || 0);
                    canonicalMetadata.totalEpisodes = seasonEpisodes || Number(tmdbDetails.totalEpisodes || task.totalEpisodes || 0);
                }
            }
        }
        Object.assign(task, canonicalMetadata);

        if (!shouldOrganizeCloud) {
            if (this.taskRepo) {
                await this.taskRepo.update(task.id, {
                    libraryLayout: layoutJson,
                    ...(metadataOverride ? { metadataAppliedOverrideJson: JSON.stringify(metadataOverride) } : {}),
                    lastOrganizedAt: new Date(),
                    lastOrganizeError: '',
                    ...canonicalMetadata,
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
            await auditService.recordOperation('classify', 'completed', {
                before: { fileCount: allFiles.length, lazy: true },
                after: {
                    category: libraryInfo.categoryName,
                    resourceFolder: libraryInfo.resourceFolderName,
                    mappedFiles: applied.files.length
                },
                reason: '懒 STRM 只锁定布局，不移动网盘',
                decisionSource: metadataOverride?.source || 'organizer'
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
                await this.mutationExecutor.rename(cloud189, file.id, targetFileName, {
                    sourcePath: file.relativePath || file.name,
                    targetPath: targetRelativeDir ? `${targetRelativeDir}/${targetFileName}` : targetFileName,
                    before: { fileId: file.id, name: file.name },
                    after: { fileId: file.id, name: targetFileName },
                    decisionSource: metadataOverride?.source || 'organizer'
                });
                messages.push(`├─ 重命名 ${file.name} -> ${targetFileName}`);
                file.name = targetFileName;
            }

            if (String(file.parentFolderId || originalFolderId) !== String(targetFolderId)) {
                await this.taskService.moveCloudFile(cloud189, {
                    id: file.id,
                    name: file.name,
                    isFolder: false
                }, targetFolderId, {
                    sourcePath: file.relativePath || file.name,
                    targetPath: targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name,
                    before: { fileId: file.id, parentFolderId: file.parentFolderId || originalFolderId },
                    after: { fileId: file.id, parentFolderId: targetFolderId },
                    decisionSource: metadataOverride?.source || 'organizer'
                });
                messages.push(`├─ 移动 ${file.name} -> ${targetRelativeDir || '媒体根目录'}`);
                file.parentFolderId = String(targetFolderId);
                file.relativeDir = targetRelativeDir;
                file.relativePath = targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name;
            } else {
                file.relativeDir = targetRelativeDir;
                file.relativePath = targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name;
                await auditService.recordOperation('skip', 'skipped', {
                    sourcePath: file.relativePath,
                    targetPath: file.relativePath,
                    reason: '文件名和目录无需调整',
                    decisionSource: 'organizer'
                });
            }
        }

        const taskUpdates = {
            lastOrganizedAt: new Date(),
            lastOrganizeError: '',
            libraryLayout: layoutJson,
            ...(metadataOverride ? { metadataAppliedOverrideJson: JSON.stringify(metadataOverride) } : {})
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
        Object.assign(taskUpdates, canonicalMetadata);

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

    _applyMetadataOverrideToLibraryInfo(libraryInfo, override, files) {
        const work = override.work || {};
        const info = { ...libraryInfo };
        if (work.title) info.canonicalTitle = work.title;
        if (work.year) info.year = String(work.year);
        if (work.mediaType) {
            info.mediaType = work.mediaType;
            info.seasonBased = work.mediaType === 'tv';
        }
        if (work.category) info.categoryName = work.category;
        if (work.tmdbId) info.tmdbId = work.tmdbId;
        if (work.seasonNumber != null) info.defaultSeason = String(work.seasonNumber).padStart(2, '0');
        const title = work.title || info.canonicalTitle || '';
        info.resourceFolderName = info.year && title && !title.includes(`(${info.year})`) ? `${title} (${info.year})` : (title || info.resourceFolderName);
        const mappings = new Map((override.files || []).map(item => [item.relativePath, item]));
        info.resourceInfo = {
            ...(info.resourceInfo || {}),
            name: title || info.resourceInfo?.name,
            year: work.year || info.resourceInfo?.year,
            type: work.mediaType || info.resourceInfo?.type,
            episode: files.map(file => {
                const relativePath = String(file.relativePath || (file.relativeDir ? path.posix.join(String(file.relativeDir).replace(/\\/g, '/'), file.name) : file.name) || '');
                const mapping = mappings.get(relativePath);
                if (!mapping) return null;
                return {
                    id: String(file.id || file.entryKey || file.name),
                    name: mapping.episodeTitle || title,
                    season: String(mapping.special ? 0 : (mapping.seasonNumber ?? work.seasonNumber ?? 1)).padStart(2, '0'),
                    episode: mapping.episodeNumber == null ? '' : String(mapping.episodeNumber),
                    extension: path.extname(file.name || ''),
                    targetFileName: mapping.targetFileName || ''
                };
            }).filter(Boolean)
        };
        return info;
    }

    /**
     * 文件管理页一次性整理：对任意选中的云盘文件/文件夹做媒体库归档 + 可选 STRM。
     * 每个顶层 item 独立识别为一部作品；不创建/更新 Task。
     *
     * @param {Object} options
     * @param {Object} options.account
     * @param {string} options.parentFolderId  当前浏览目录（分类目录创建在此之下）
     * @param {Array<{id:string,name:string,isFolder:boolean}>} options.items
     * @param {boolean} [options.useAi=true]
     * @param {boolean} [options.forceRefresh=false]
     * @param {boolean} [options.generateStrm=false]
     * @param {boolean} [options.deleteEmptySource=false] 源文件夹搬空后删除空壳
     */
    async organizeCloudSelection({
        account,
        parentFolderId,
        items = [],
        useAi = true,
        forceRefresh = false,
        generateStrm = false,
        deleteEmptySource = false
    } = {}) {
        if (!account?.id) {
            throw new Error('账号不存在');
        }
        if (!parentFolderId) {
            throw new Error('当前目录不能为空');
        }
        const normalizedItems = (Array.isArray(items) ? items : [])
            .map((item) => ({
                id: String(item?.id || '').trim(),
                name: String(item?.name || '').trim(),
                isFolder: !!item?.isFolder
            }))
            .filter((item) => item.id && item.name);
        if (!normalizedItems.length) {
            throw new Error('未选择需要整理的文件');
        }
        if (normalizedItems.some(item => CasArchiveService.isReservedDirectory(item.name))) {
            throw new Error('_cas 是系统保留目录，不能执行媒体整理');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        this.layoutService.taskService = this.taskService;

        let strmService = null;
        let streamProxyService = null;
        if (generateStrm) {
            strmService = new StrmService();
            const { StreamProxyService } = require('./streamProxy');
            streamProxyService = new StreamProxyService();
        }

        const categoryCache = new Map();
        const results = [];

        for (const item of normalizedItems) {
            try {
                const rawFiles = item.isFolder
                    ? await this.taskService._collectFolderFilesRecursive(cloud189, item.id, '', null)
                    : [{
                        id: item.id,
                        name: item.name,
                        isFolder: false,
                        relativeDir: '',
                        parentFolderId: String(parentFolderId)
                    }];

                const files = (rawFiles || []).filter((file) => file && !file.isFolder && file.id && file.name);
                const mediaFiles = files
                    .filter(file => !CasService.isCasFile(file.name))
                    .filter(file => !CasArchiveService.isArchivePath(file.relativePath || file.relativeDir || ''));
                if (!mediaFiles.length) {
                    results.push({
                        item,
                        skipped: true,
                        message: '目录为空或无可整理文件，跳过'
                    });
                    continue;
                }

                const resourceName = item.isFolder
                    ? item.name
                    : path.parse(item.name).name;
                logTaskEvent(`[文件整理] 开始: ${item.name}（${mediaFiles.length} 文件）`);

                const libraryInfo = await this.layoutService.resolveLibraryInfo({
                    resourceName,
                    files: mediaFiles.map((file) => ({ id: file.id, name: file.name })),
                    useAi: !!useAi,
                    forceRefresh: !!forceRefresh
                });
                const resourceInfo = libraryInfo.resourceInfo || {
                    name: libraryInfo.canonicalTitle,
                    year: libraryInfo.year,
                    type: libraryInfo.mediaType,
                    episode: []
                };
                const fileMap = new Map(
                    (resourceInfo.episode || []).map((entry) => [String(entry.id), entry])
                );

                const categoryFolderId = await this._ensureFolderByName(
                    cloud189,
                    String(parentFolderId),
                    libraryInfo.categoryName,
                    categoryCache
                );
                const resourceFolderId = await this._ensureFolderByName(
                    cloud189,
                    categoryFolderId,
                    libraryInfo.resourceFolderName,
                    categoryCache
                );

                const nestedCache = new Map();
                const movedFiles = [];
                let renamedCount = 0;
                let movedCount = 0;
                const operations = [];

                for (const file of mediaFiles) {
                    const aiFile = fileMap.get(String(file.id));
                    const targetFileName = this.layoutService.buildFileName(
                        file,
                        aiFile,
                        resourceInfo,
                        libraryInfo
                    );
                    const targetRelativeDir = this.layoutService.buildRelativeDir(
                        file,
                        aiFile,
                        libraryInfo
                    );
                    const targetFolderId = await this._ensureDirectoryPath(
                        cloud189,
                        resourceFolderId,
                        targetRelativeDir,
                        nestedCache
                    );

                    if (file.name !== targetFileName) {
                        await this.mutationExecutor.rename(cloud189, file.id, targetFileName, {
                            sourcePath: file.relativePath || file.name,
                            targetPath: targetRelativeDir ? `${targetRelativeDir}/${targetFileName}` : targetFileName,
                            before: { fileId: file.id, name: file.name },
                            after: { fileId: file.id, name: targetFileName },
                            decisionSource: 'organizer'
                        });
                        operations.push(`重命名 ${file.name} -> ${targetFileName}`);
                        renamedCount += 1;
                        file.name = targetFileName;
                    }

                    if (String(file.parentFolderId || '') !== String(targetFolderId)) {
                        await this.taskService.moveCloudFile(cloud189, {
                            id: file.id,
                            name: file.name,
                            isFolder: false
                        }, targetFolderId, {
                            sourcePath: file.relativePath || file.name,
                            targetPath: targetRelativeDir ? `${targetRelativeDir}/${file.name}` : file.name,
                            before: { fileId: file.id, parentFolderId: file.parentFolderId || parentFolderId },
                            after: { fileId: file.id, parentFolderId: targetFolderId },
                            decisionSource: 'organizer'
                        });
                        operations.push(`移动 ${file.name} -> ${targetRelativeDir || '媒体根目录'}`);
                        movedCount += 1;
                        file.parentFolderId = String(targetFolderId);
                    }

                    file.relativeDir = targetRelativeDir;
                    file.relativePath = targetRelativeDir
                        ? `${targetRelativeDir}/${file.name}`
                        : file.name;
                    movedFiles.push(file);
                }

                let strmMessage = '';
                if (generateStrm && strmService?.enable && streamProxyService) {
                    const targetRoot = this.layoutService.buildStrmRoot(
                        account.localStrmPrefix,
                        libraryInfo
                    );
                    strmMessage = await strmService.generateCustom(
                        targetRoot,
                        movedFiles,
                        async (file) => streamProxyService.buildStreamUrl({
                            type: 'task',
                            accountId: account.id,
                            fileId: file.id,
                            fileName: file.name
                        }),
                        false,
                        false
                    ) || '';
                } else if (generateStrm && strmService && !strmService.enable) {
                    strmMessage = 'STRM生成未启用，已跳过';
                }

                let deletedEmptySource = false;
                if (
                    deleteEmptySource
                    && item.isFolder
                    && String(item.id) !== String(resourceFolderId)
                    && String(item.id) !== String(categoryFolderId)
                    && String(item.id) !== String(parentFolderId)
                ) {
                    deletedEmptySource = await this._deleteFolderIfEmpty(
                        cloud189,
                        item.id,
                        item.name
                    );
                    if (deletedEmptySource) {
                        operations.push(`删除空目录 ${item.name}`);
                    }
                }

                const targetSummary = `${libraryInfo.categoryName}/${libraryInfo.resourceFolderName}`;
                logTaskEvent(
                    `[文件整理] 完成: ${item.name} -> ${targetSummary}`
                    + `（重命名 ${renamedCount}，移动 ${movedCount}`
                    + `${deletedEmptySource ? '，已删空源目录' : ''}）`
                );

                results.push({
                    item,
                    libraryInfo: {
                        mediaType: libraryInfo.mediaType,
                        categoryName: libraryInfo.categoryName,
                        resourceFolderName: libraryInfo.resourceFolderName,
                        canonicalTitle: libraryInfo.canonicalTitle,
                        year: libraryInfo.year,
                        tmdbId: libraryInfo.tmdbId || ''
                    },
                    fileCount: files.length,
                    renamedCount,
                    movedCount,
                    deletedEmptySource,
                    operations,
                    strmMessage,
                    message: `${item.name} → ${targetSummary}（${files.length} 文件`
                        + `${deletedEmptySource ? '，已删空源目录' : ''}）`
                });
            } catch (error) {
                logTaskEvent(`[文件整理] 失败: ${item.name}: ${error.message}`);
                results.push({
                    item,
                    error: error.message || String(error)
                });
            }
        }

        return { results };
    }

    /**
     * 若目录内无任何文件/子文件夹则删除（用于整理后清空壳源目录）
     * @returns {Promise<boolean>} 是否已删除
     */
    async _deleteFolderIfEmpty(cloud189, folderId, folderName = '') {
        if (!folderId || !this.taskService?.deleteCloudFile) {
            return false;
        }
        try {
            const listing = await cloud189.listFiles(String(folderId));
            if (!listing?.fileListAO) {
                // 列不出内容时保守跳过，避免误删
                return false;
            }
            const files = listing.fileListAO.fileList || [];
            const folders = listing.fileListAO.folderList || [];
            if (files.length || folders.length) {
                logTaskEvent(
                    `[文件整理] 源目录未清空，保留: ${folderName || folderId}`
                    + `（文件 ${files.length}，子目录 ${folders.length}）`
                );
                return false;
            }
            await this.taskService.deleteCloudFile(
                cloud189,
                { id: String(folderId), name: folderName || String(folderId) },
                1
            );
            logTaskEvent(`[文件整理] 已删除空源目录: ${folderName || folderId}`);
            return true;
        } catch (error) {
            logTaskEvent(
                `[文件整理] 删除空源目录失败 ${folderName || folderId}: ${error.message}`
            );
            return false;
        }
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
            folder = (await this.mutationExecutor.createFolder(cloud189, parentFolderId, safeFolderName)).value;
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

    _getSeasonEpisodeCount(detail, seasonNumber) {
        if (!seasonNumber || !Array.isArray(detail?.seasons)) {
            return 0;
        }
        const seasonInfo = detail.seasons.find(season => Number(season.season_number) === Number(seasonNumber));
        return Number(seasonInfo?.episode_count || 0);
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
