const { LessThan, In, IsNull, Like } = require('typeorm');
const { Cloud189Service } = require('./cloud189');
const { MessageUtil } = require('./message');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { CreateTaskDto } = require('../dto/TaskDto');
const { BatchTaskDto } = require('../dto/BatchTaskDto');
const { TaskCompleteEventDto } = require('../dto/TaskCompleteEventDto');
const { SchedulerService } = require('./scheduler');

const path = require('path');
const { StrmService } = require('./strm');
const { EventService } = require('./eventService');
const { TaskEventHandler } = require('./taskEventHandler');
const AIService = require('./ai');
const harmonizedFilter = require('../utils/BloomFilter');
const cloud189Utils = require('../utils/Cloud189Utils');
const alistService = require('./alistService');
const { LazyShareStrmService } = require('./lazyShareStrm');
const { CasService } = require('./casService');
const { AppDataSource } = require('../database');
const { TaskProcessedFile } = require('../entities');
const { parseMediaTitle } = require('../utils/mediaTitleParser');

class TaskService {
    constructor(taskRepo, accountRepo, taskProcessedFileRepo) {
        this.taskRepo = taskRepo;
        this.accountRepo = accountRepo;
        this.taskProcessedFileRepo = taskProcessedFileRepo || (AppDataSource.isInitialized
            ? AppDataSource.getRepository(TaskProcessedFile)
            : null);
        this.autoSeriesService = null;
        this.messageUtil = new MessageUtil();
        this.eventService = EventService.getInstance();
        // 如果还没有taskComplete事件的监听器，则添加
        if (!this.eventService.hasListeners('taskComplete')) {
            const taskEventHandler = new TaskEventHandler(this.messageUtil);
            this.eventService.on('taskComplete', async (eventDto) => {
                eventDto.taskService = this;
                eventDto.taskRepo = this.taskRepo;
                taskEventHandler.handle(eventDto);
            });
        }
    }

    _getTaskProcessedFileRepo() {
        if (this.taskProcessedFileRepo) {
            return this.taskProcessedFileRepo;
        }
        if (AppDataSource.isInitialized) {
            this.taskProcessedFileRepo = AppDataSource.getRepository(TaskProcessedFile);
            return this.taskProcessedFileRepo;
        }
        throw new Error('TaskProcessedFile 仓库未初始化');
    }

    _getSeasonExpectedEpisodes(task) {
        const seasonNumber = Number(task?.tmdbSeasonNumber || 0);
        const seasonEpisodes = Number(task?.tmdbSeasonEpisodes || 0);
        if (seasonNumber > 0 && seasonEpisodes > 0) {
            return seasonEpisodes;
        }
        return Number(task?.totalEpisodes || 0);
    }

    _alignTaskTotalEpisodesToSeason(task) {
        if (!task?.id) {
            return false;
        }
        const seasonEpisodes = this._getSeasonExpectedEpisodes(task);
        if (seasonEpisodes > 0 && Number(task.totalEpisodes || 0) !== seasonEpisodes) {
            task.totalEpisodes = seasonEpisodes;
            return true;
        }
        return false;
    }

    _syncTaskCompletionState(task) {
        if (!task?.id) {
            return false;
        }
        const totalEpisodes = this._getSeasonExpectedEpisodes(task);
        const currentEpisodes = Number(task.currentEpisodes || 0);
        if (totalEpisodes > 0 && currentEpisodes >= totalEpisodes && task.status !== 'completed') {
            task.status = 'completed';
            return true;
        }
        return false;
    }

    async refreshTaskCompletionState(task) {
        if (!task?.id) {
            return false;
        }
        const changed = this._alignTaskTotalEpisodesToSeason(task) || this._syncTaskCompletionState(task);
        if (changed) {
            await this.taskRepo.update(task.id, {
                totalEpisodes: task.totalEpisodes,
                status: task.status
            });
        }
        return changed;
    }

    _getAiMode() {
        if (!AIService.isEnabled()) {
            return 'disabled';
        }
        const mode = String(ConfigService.getConfigValue('openai.mode', 'fallback') || 'fallback').trim().toLowerCase();
        return ['advanced', 'fallback'].includes(mode) ? mode : 'fallback';
    }

    _isAiAdvancedMode() {
        return this._getAiMode() === 'advanced';
    }

    _isAiFallbackMode() {
        return this._getAiMode() === 'fallback';
    }

    // 解析分享链接
    async getShareInfo(cloud189, shareCode) {
         const shareInfo = await cloud189.getShareInfo(shareCode);
         if (!shareInfo) throw new Error('获取分享信息失败');
         if(shareInfo.res_code == "ShareAuditWaiting") {
            throw new Error('分享链接审核中, 请稍后再试');
         }
         return shareInfo;
    }

    // 创建任务的基础配置
    _createTaskConfig(taskDto, shareInfo, realFolder, resourceName, currentEpisodes = 0, shareFolderId = null, shareFolderName = "") {
        const seasonTotalEpisodes = Number(taskDto.tmdbSeasonNumber || 0) > 0 && Number(taskDto.tmdbSeasonEpisodes || 0) > 0
            ? Number(taskDto.tmdbSeasonEpisodes)
            : Number(taskDto.totalEpisodes || 0);

        return {
            accountId: taskDto.accountId,
            shareLink: taskDto.shareLink,
            targetFolderId: taskDto.targetFolderId,
            targetFolderName: taskDto.targetFolder || taskDto.targetFolderName || '',
            organizerTargetFolderId: taskDto.organizerTargetFolderId || taskDto.targetFolderId,
            organizerTargetFolderName: taskDto.organizerTargetFolderName || taskDto.targetFolder || '',
            realFolderId:realFolder.id,
            realFolderName:realFolder.name,
            status: 'pending',
            totalEpisodes: seasonTotalEpisodes,
            resourceName,
            currentEpisodes,
            shareFileId: shareInfo.fileId,
            shareFolderId: shareFolderId || shareInfo.fileId,
            shareFolderName,
            shareId: shareInfo.shareId,
            shareMode: shareInfo.shareMode,
            accessCode: taskDto.accessCode,
            matchPattern: taskDto.matchPattern,
            matchOperator: taskDto.matchOperator,
            matchValue: taskDto.matchValue,
            remark: taskDto.remark,
            taskGroup: taskDto.taskGroup,
            tmdbId: taskDto.tmdbId,
            tmdbSeasonNumber: taskDto.tmdbSeasonNumber || null,
            tmdbSeasonName: taskDto.tmdbSeasonName || null,
            tmdbSeasonEpisodes: taskDto.tmdbSeasonEpisodes || null,
            realRootFolderId: taskDto.realRootFolderId,
            enableCron: taskDto.enableCron,
            cronExpression: taskDto.cronExpression,
            sourceRegex: taskDto.sourceRegex,
            targetRegex: taskDto.targetRegex,
            enableTaskScraper: taskDto.enableTaskScraper,
            enableLazyStrm: taskDto.enableLazyStrm,
            enableOrganizer: taskDto.enableOrganizer,
            isFolder: taskDto.isFolder
        };
    }

    _safeJoinPath(...parts) {
        const validParts = parts
            .map(part => typeof part === 'string' ? part : (part == null ? '' : String(part)))
            .filter(part => part !== '');
        if (validParts.length === 0) {
            return '';
        }
        return path.join(...validParts);
    }

    async _ensureTaskNotExists(taskDto, shareInfo) {
        const normalizedTargetFolderId = String(taskDto.targetFolderId || '').trim();
        const normalizedShareId = String(shareInfo?.shareId || '').trim();
        const rootShareFolderId = String(shareInfo?.fileId || '').trim();
        const selectedFolders = Array.isArray(taskDto.selectedFolders)
            ? taskDto.selectedFolders.map(item => String(item || '').trim()).filter(Boolean)
            : [];
        const rootSelected = this.checkFolderInList(taskDto, '-1') || selectedFolders.length === 0;

        const existingTasks = await this.taskRepo.find({
            where: {
                accountId: taskDto.accountId,
                targetFolderId: normalizedTargetFolderId,
                shareId: normalizedShareId
            }
        });

        if (!existingTasks.length) {
            return;
        }

        const hasRootTask = existingTasks.some(task => String(task.shareFolderId || task.shareFileId || '').trim() === rootShareFolderId);
        if (rootSelected && hasRootTask) {
            throw new Error('任务已存在，需删除后重新订阅');
        }

        if (selectedFolders.length > 0) {
            const existingFolderIds = new Set(existingTasks.map(task => String(task.shareFolderId || '').trim()).filter(Boolean));
            const duplicatedFolder = selectedFolders.find(folderId => existingFolderIds.has(folderId));
            if (duplicatedFolder) {
                throw new Error('任务已存在，需删除后重新订阅');
            }
        }
    }

    _buildTaskTitleContext(task) {
        const primaryTitle = String(task?.resourceName || task?.realFolderName || task?.shareFolderName || '').replace(/\(根\)$/g, '').trim();
        const seasonHintTitle = String(task?.shareFolderName || task?.realFolderName || task?.resourceName || '').replace(/\(根\)$/g, '').trim();
        const parsedPrimary = parseMediaTitle(primaryTitle);
        const parsedSeasonHint = seasonHintTitle === primaryTitle ? parsedPrimary : parseMediaTitle(seasonHintTitle);
        const mergedSeason = parsedPrimary.season || parsedSeasonHint.season || null;
        const year = parsedPrimary.year
            ? String(parsedPrimary.year)
            : ((primaryTitle.match(/(19|20)\d{2}/) || [])[0] || (parsedSeasonHint.year ? String(parsedSeasonHint.year) : ''));
        return {
            rawTitle: primaryTitle,
            parsed: {
                ...parsedPrimary,
                season: mergedSeason
            },
            year
        };
    }

    _buildEpisodeIdentity(file, task = null) {
        const restoredName = CasService.isCasFile(file?.name) ? CasService.getOriginalFileName(file.name) : file?.name;
        const parsed = parseMediaTitle(restoredName || file?.restoredFileName || file?.sourceFileName || '');
        const fallbackSeason = Number(task?.tmdbSeasonNumber || 0) || Number(parseMediaTitle(String(task?.shareFolderName || task?.realFolderName || task?.resourceName || '')).season || 0) || 1;
        if (parsed?.episode != null) {
            return {
                key: `S${String(parsed.season || fallbackSeason).padStart(2, '0')}E${String(parsed.episode).padStart(2, '0')}`,
                season: Number(parsed.season || fallbackSeason),
                episode: Number(parsed.episode),
                parsedName: restoredName || file?.restoredFileName || file?.sourceFileName || file?.name || ''
            };
        }
        return null;
    }

    _getQualityScoreByName(fileName = '') {
        const normalized = String(fileName || '').toLowerCase();
        const resolutionMatch = normalized.match(/\b(4320|2160|1080|720|480)p\b/);
        const resolution = Number(resolutionMatch?.[1] || 0);
        const sourceScore = /remux|blu[\s.-]?ray/.test(normalized)
            ? 30
            : (/web[\s.-]?dl|webrip/.test(normalized) ? 20 : 0);
        const codecScore = /hevc|x265|h\s*265/.test(normalized) ? 5 : 0;
        return resolution * 100 + sourceScore + codecScore;
    }

    _dedupeFilesByEpisode(files = [], task = null) {
        const selectedByEpisode = new Map();
        const duplicates = [];
        const uniqueFiles = [];

        for (const file of files || []) {
            const identity = this._buildEpisodeIdentity(file, task);
            if (!identity) {
                uniqueFiles.push(file);
                continue;
            }
            const score = this._getQualityScoreByName(identity.parsedName);
            const current = selectedByEpisode.get(identity.key);
            if (!current) {
                selectedByEpisode.set(identity.key, { file, score, identity });
                continue;
            }
            if (score > current.score) {
                duplicates.push(current.file);
                selectedByEpisode.set(identity.key, { file, score, identity });
            } else {
                duplicates.push(file);
            }
        }

        uniqueFiles.push(...Array.from(selectedByEpisode.values()).map(item => item.file));
        return { uniqueFiles, duplicates };
    }

    _countUniqueEpisodes(files = [], task = null) {
        const episodeKeys = new Set();
        let fallbackCount = 0;
        for (const file of files || []) {
            const identity = this._buildEpisodeIdentity(file, task);
            if (identity?.key) {
                episodeKeys.add(identity.key);
            } else {
                fallbackCount += 1;
            }
        }
        return episodeKeys.size + fallbackCount;
    }

    _countMergedUniqueEpisodes(existingFiles = [], incomingFiles = [], task = null) {
        const selectedByEpisode = new Map();
        let fallbackCount = 0;

        for (const file of [...(existingFiles || []), ...(incomingFiles || [])]) {
            const identity = this._buildEpisodeIdentity(file, task);
            if (!identity?.key) {
                fallbackCount += 1;
                continue;
            }
            const score = this._getQualityScoreByName(identity.parsedName || file?.name || file?.restoredFileName || file?.sourceFileName || '');
            const current = selectedByEpisode.get(identity.key);
            if (!current || score > current.score) {
                selectedByEpisode.set(identity.key, { score });
            }
        }

        return selectedByEpisode.size + fallbackCount;
    }

    async resolveTmdbSeasonInfo(task, { updateTask = false } = {}) {
        if (!task?.id) {
            throw new Error('任务不存在');
        }

        const { rawTitle, parsed, year } = this._buildTaskTitleContext(task);
        const { TMDBService } = require('./tmdb');
        const tmdb = new TMDBService();
        let tmdbInfo = null;

        const preferredSeasonNumber = Number(task.tmdbSeasonNumber || parsed.season || 0) || null;

        if (task.tmdbId) {
            tmdbInfo = await tmdb.getTVDetails(task.tmdbId);
            if (tmdbInfo && preferredSeasonNumber) {
                const seasonDetail = await tmdb.getTVSeasonDetails(task.tmdbId, preferredSeasonNumber);
                if (seasonDetail) {
                    tmdbInfo = {
                        ...tmdbInfo,
                        seasonNumber: preferredSeasonNumber,
                        seasonName: seasonDetail.name || '',
                        seasonEpisodes: seasonDetail.episodeCount || 0,
                        totalEpisodes: seasonDetail.episodeCount || tmdbInfo.totalEpisodes || 0,
                        tmdbSeasonUrl: seasonDetail.tmdbUrl
                    };
                }
            }
        }

        if (!tmdbInfo) {
            tmdbInfo = await tmdb.searchTV(rawTitle, year, task.currentEpisodes || 0);
        }

        if (!tmdbInfo) {
            throw new Error('未匹配到 TMDB 剧集');
        }

        const seasonNumber = Number(tmdbInfo.seasonNumber || preferredSeasonNumber || 0) || null;
        const seasonEpisodes = Number(tmdbInfo.seasonEpisodes || 0);
        const totalEpisodes = seasonEpisodes || Number(tmdbInfo.totalEpisodes || 0);
        const result = {
            taskId: task.id,
            rawTitle,
            cleanTitle: parsed.cleanTitle || rawTitle,
            year,
            tmdbId: tmdbInfo.id || task.tmdbId || null,
            title: tmdbInfo.title || '',
            seasonNumber,
            seasonName: tmdbInfo.seasonName || '',
            seasonEpisodes,
            totalEpisodes,
            tmdbUrl: tmdbInfo.id ? `https://www.themoviedb.org/tv/${tmdbInfo.id}` : '',
            tmdbSeasonUrl: tmdbInfo.tmdbSeasonUrl || (tmdbInfo.id && seasonNumber ? `https://www.themoviedb.org/tv/${tmdbInfo.id}/season/${seasonNumber}` : '')
        };

        if (updateTask && totalEpisodes > 0) {
            const updates = {
                totalEpisodes,
                tmdbId: result.tmdbId ? String(result.tmdbId) : task.tmdbId,
                tmdbSeasonNumber: seasonNumber,
                tmdbSeasonName: result.seasonName,
                tmdbSeasonEpisodes: seasonEpisodes || totalEpisodes
            };
            await this.taskRepo.update(task.id, updates);
            Object.assign(task, updates);
            this._alignTaskTotalEpisodesToSeason(task);
            this._syncTaskCompletionState(task);
            if (task.status === 'completed') {
                await this.taskRepo.update(task.id, {
                    totalEpisodes: task.totalEpisodes,
                    status: task.status
                });
            }
        }

        return result;
    }

     // 验证并创建目标目录
     async _validateAndCreateTargetFolder(cloud189, taskDto, shareInfo) {
        const rootSelected = this.checkFolderInList(taskDto, '-1');
        const existingFolder = await cloud189.listFiles(taskDto.targetFolderId);
        const folderList = existingFolder?.fileListAO?.folderList || [];
        const matchedFolder = folderList.find(folder => folder.name === shareInfo.fileName);

        if (matchedFolder?.id) {
            await logTaskEvent(`目标目录已存在同名文件夹，复用目录: ${matchedFolder.name} (${matchedFolder.id})`, 'info', 'task');
            return {
                ...matchedFolder,
                oldFolder: true
            };
        }

        if (!rootSelected) {
            await logTaskEvent(`未选择根目录，后续将仅为子目录创建任务: ${shareInfo.fileName}`, 'info', 'task');
        }
        // 检查目标文件夹是否存在
        await this.checkFolderExists(cloud189, taskDto.targetFolderId, shareInfo.fileName, taskDto.overwriteFolder);
        const targetFolder = await cloud189.createFolder(shareInfo.fileName, taskDto.targetFolderId);
        if (!targetFolder || !targetFolder.id) throw new Error('创建目录失败');
        if (!rootSelected) {
            targetFolder.oldFolder = true;
        }
        return targetFolder;
    }

    // 处理文件夹分享
    async _handleFolderShare(cloud189, shareInfo, taskDto, rootFolder, tasks) {
        const result = await cloud189.listShareDir(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, taskDto.accessCode);
        if (!result?.fileListAO) return;
        const { fileList: rootFiles = [], folderList: subFolders = [] } = result.fileListAO;
        const selectedSubFolders = subFolders.filter(folder => this.checkFolderInList(taskDto, folder.id));
        // 处理根目录文件 如果用户选择了根目录, 则生成根目录任务
        if (rootFiles.length > 0) {
            const enableOnlySaveMedia = ConfigService.getConfigValue('task.enableOnlySaveMedia');
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            // 校验文件是否一个满足条件的都没有, 如果都没有 直接跳过
            let shouldContinue = false;
            if (enableOnlySaveMedia && !rootFiles.some(file => this._checkFileSuffix(file, true, mediaSuffixs))) {
                shouldContinue = true
            }
            if (!shouldContinue) {
                taskDto.realRootFolderId = rootFolder.id;
                await logTaskEvent(`创建根目录任务: rootFolderId=${rootFolder.id}, rootFolderName=${rootFolder.name}, reused=${!!rootFolder?.oldFolder}, rootFiles=${rootFiles.length}`, 'info', 'task');
                const rootTask = this.taskRepo.create(
                    this._createTaskConfig(
                        taskDto,
                        shareInfo, rootFolder, `${shareInfo.fileName}(根)`, 0
                    )
                );
                tasks.push(await this.taskRepo.save(rootTask));
            } else {
                await logTaskEvent(`根目录任务已跳过: rootFolderId=${rootFolder.id}, reason=没有匹配媒体文件`, 'warn', 'task');
            }
        }
        if (subFolders.length > 0) {
            taskDto.realRootFolderId = rootFolder.id;
            // 如果启用了 AI 分析，分析子文件夹
            if (this._isAiAdvancedMode() && subFolders.length > 0) {
                try {
                    const resourceInfo = await this._analyzeResourceInfo(
                        shareInfo.fileName,
                        subFolders.map(f => ({ id:f.id, name: f.name })),
                        'folder'
                    );
                    // 遍历子文件夹，使用 AI 分析结果更新文件夹名称
                    const aiFolders = Array.isArray(resourceInfo?.folders) ? resourceInfo.folders : [];
                    for (const folder of subFolders) {
                        // 在 AI 分析结果中查找对应的文件夹
                        const aiFolder = aiFolders.find(f => f.id === folder.id);
                        if (aiFolder) {
                            folder.name = aiFolder.name;
                        }
                    }
                } catch (error) {
                    logTaskEvent('子文件夹 AI 分析失败，使用原始文件名: ' + error.message, 'error', 'transfer');
                }
            }
            const shouldReuseRootFolder = selectedSubFolders.length === 1
                && !this.checkFolderInList(taskDto, '-1')
                && String(rootFolder.name || '').trim() === String(selectedSubFolders[0]?.name || '').trim();

             // 处理子文件夹
            for (const folder of subFolders) {
                if (!selectedSubFolders.some(item => item.id === folder.id)) {
                    continue;
                }
                const subFolderContent = await cloud189.listShareDir(shareInfo.shareId, folder.id, shareInfo.shareMode, taskDto.accessCode);
                const hasFiles = subFolderContent?.fileListAO?.fileList?.length > 0;
                if (!hasFiles) {
                    logTaskEvent(`子文件夹 "${folder.name}" (ID: ${folder.id}) 为空，跳过目录。`, 'warn', 'transfer');
                    continue; // 跳到下一个子文件夹
                }
                let realFolder;
                if (shouldReuseRootFolder) {
                    realFolder = {
                        ...rootFolder,
                        name: rootFolder.name
                    };
                } else {
                    await this.checkFolderExists(cloud189, rootFolder.id, folder.fileName, taskDto.overwriteFolder);
                    realFolder = await cloud189.createFolder(folder.name, rootFolder.id);
                    if (!realFolder?.id) throw new Error('创建目录失败');
                    realFolder.name = this._safeJoinPath(rootFolder.name, realFolder.name);
                }
                const subTask = this.taskRepo.create(
                    this._createTaskConfig(
                        taskDto,
                        shareInfo, realFolder, shareInfo.fileName, 0, folder.id, folder.name
                    )
                );
                tasks.push(await this.taskRepo.save(subTask));
            }
        }
    }

    // 处理单文件分享
    async _handleSingleShare(cloud189, shareInfo, taskDto, rootFolder, tasks) {
        const shareFiles = await cloud189.getShareFiles(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, taskDto.accessCode, false);
        if (!shareFiles?.length) throw new Error('获取文件列表失败');
        taskDto.realRootFolderId = rootFolder.id;
        const task = this.taskRepo.create(
            this._createTaskConfig(
                taskDto,
                shareInfo, rootFolder, shareInfo.fileName, 0
            )
        );
        tasks.push(await this.taskRepo.save(task));
    }

    async _analyzeResourceInfo(resourcePath, files, type = 'folder') {
        try {
            if (type == 'folder') {
                const result = await AIService.folderAnalysis(resourcePath, files);
                if (!result.success) {
                    throw new Error('AI 分析失败:'+ result.error);
                }
                return result.data;
            }
            const result = await AIService.simpleChatCompletion(resourcePath, files);
            if (!result.success) {
                throw new Error('AI 分析失败: ' + result.error);
            }
            return result.data;
        } catch (error) {
            throw new Error('AI 分析失败: ' + error.message);
        }
    }

    // 创建新任务
    async createTask(params) {
        const taskDto = new CreateTaskDto(params);
        taskDto.validate();
        await logTaskEvent(`开始创建任务: accountId=${taskDto.accountId}, shareLink=${taskDto.shareLink}, targetFolderId=${taskDto.targetFolderId}, targetFolderName=${taskDto.targetFolderName || ''}, selectedFolders=${JSON.stringify(taskDto.selectedFolders || [])}`, 'info', 'task');
        // 获取分享信息
        const account = await this.accountRepo.findOneBy({ id: taskDto.accountId });
        if (!account) throw new Error('账号不存在');
        
        // 解析url
        const {url: parseShareLink, accessCode} = cloud189Utils.parseCloudShare(taskDto.shareLink)
        if (accessCode) {
            taskDto.accessCode = accessCode;
        }
        taskDto.shareLink = parseShareLink;
        const cloud189 = Cloud189Service.getInstance(account);
        const shareCode = cloud189Utils.parseShareCode(taskDto.shareLink);
        const shareInfo = await this.getShareInfo(cloud189, shareCode);
        await logTaskEvent(`分享信息解析完成: shareId=${shareInfo.shareId || ''}, fileId=${shareInfo.fileId || ''}, fileName=${shareInfo.fileName || ''}, isFolder=${!!shareInfo.isFolder}, shareMode=${shareInfo.shareMode}`, 'info', 'task');
        await this._ensureTaskNotExists(taskDto, shareInfo);
        // 如果分享链接是加密链接, 且没有提供访问码, 则抛出错误
        if (shareInfo.shareMode == 1 ) {
            if (!taskDto.accessCode) {
                throw new Error('分享链接为加密链接, 请提供访问码');
            }
            // 校验访问码是否有效
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, taskDto.accessCode);
            if (!accessCodeResponse) {
                throw new Error('校验访问码失败');
            }
            if (!accessCodeResponse.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        if (!shareInfo.shareId) {
            throw new Error('获取分享信息失败');
        }
        // 如果启用了 AI 分析 如果任务名和分享名相同, 则使用AI分析结果更新任务名称
        if (this._isAiAdvancedMode() && taskDto.taskName == shareInfo.fileName) {
            try {
                const resourceInfo = await this._analyzeResourceInfo(shareInfo.fileName, [], 'folder');
                // 使用 AI 分析结果更新任务名称
                shareInfo.fileName = resourceInfo.year?`${resourceInfo.name} (${resourceInfo.year})`:resourceInfo.name;
                taskDto.taskName = shareInfo.fileName;
            } catch (error) {
                logTaskEvent('AI 分析失败，使用原始文件名: ' + error.message, 'error', 'transfer');
            }
        }
        // 如果任务名称存在 且和shareInfo的name不一致
        if (taskDto.taskName && taskDto.taskName != shareInfo.fileName) {
            shareInfo.fileName = taskDto.taskName;
        }
        taskDto.isFolder = true
        await this.increaseShareFileAccessCount(cloud189, shareInfo.shareId)
        // 检查并创建目标目录
        const rootFolder = await this._validateAndCreateTargetFolder(cloud189, taskDto, shareInfo);
        await logTaskEvent(`目标目录准备完成: rootFolderId=${rootFolder?.id || ''}, rootFolderName=${rootFolder?.name || ''}, oldFolder=${!!rootFolder?.oldFolder}`, 'info', 'task');
        const tasks = [];
        const targetFolderBase = taskDto.targetFolder || taskDto.targetFolderName || '';
        rootFolder.name = this._safeJoinPath(targetFolderBase, rootFolder.name);
        await logTaskEvent(`任务根目录映射完成: targetFolderBase=${targetFolderBase || '空'}, mappedRoot=${rootFolder.name || ''}`, 'info', 'task');
        if (shareInfo.isFolder) {
            await this._handleFolderShare(cloud189, shareInfo, taskDto, rootFolder, tasks);
        }

         // 处理单文件
         if (!shareInfo.isFolder) {
            taskDto.isFolder = false
            await this._handleSingleShare(cloud189, shareInfo, taskDto, rootFolder, tasks);
        }
        if (taskDto.enableCron) {
            for(const task of tasks) {
                SchedulerService.saveTaskJob(task, this)   
            }
        }
        await logTaskEvent(`任务创建完成: created=${tasks.length}, resource=${shareInfo.fileName || taskDto.taskName || ''}`, 'info', 'task');
        return tasks;
    }

    async createTasksBatch(taskList = []) {
        if (!Array.isArray(taskList) || taskList.length === 0) {
            throw new Error('批量任务不能为空');
        }
        const createdTasks = [];
        const failedTasks = [];
        for (const taskParams of taskList) {
            try {
                const tasks = await this.createTask(taskParams);
                createdTasks.push(...tasks);
            } catch (error) {
                failedTasks.push({
                    shareLink: taskParams.shareLink,
                    error: error.message
                });
            }
        }
        return {
            createdTasks,
            failedTasks
        };
    }
    async increaseShareFileAccessCount(cloud189, shareId ) {
        await cloud189.increaseShareFileAccessCount(shareId)
    }

    async getProcessedRecords(taskId, options = {}) {
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const where = { taskId };
        if (options.status && options.status !== 'all') {
            where.status = options.status;
        }
        if (options.search) {
            return await taskProcessedFileRepo.find({
                where: [
                    { ...where, sourceFileName: Like(`%${options.search}%`) },
                    { ...where, restoredFileName: Like(`%${options.search}%`) },
                    { ...where, sourceMd5: Like(`%${options.search}%`) }
                ],
                order: {
                    updatedAt: 'DESC',
                    id: 'DESC'
                }
            });
        }
        return await taskProcessedFileRepo.find({
            where,
            order: {
                updatedAt: 'DESC',
                id: 'DESC'
            }
        });
    }

    async getProcessedRecordsByTaskIds(taskIds, options = {}) {
        const normalizedTaskIds = Array.from(new Set(
            (Array.isArray(taskIds) ? taskIds : [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        ));
        if (normalizedTaskIds.length === 0) {
            throw new Error('任务ID不能为空');
        }

        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const where = { taskId: In(normalizedTaskIds) };
        if (options.status && options.status !== 'all') {
            where.status = options.status;
        }
        if (options.search) {
            return await taskProcessedFileRepo.find({
                where: [
                    { ...where, sourceFileName: Like(`%${options.search}%`) },
                    { ...where, restoredFileName: Like(`%${options.search}%`) },
                    { ...where, sourceMd5: Like(`%${options.search}%`) }
                ],
                order: {
                    updatedAt: 'DESC',
                    id: 'DESC'
                }
            });
        }
        return await taskProcessedFileRepo.find({
            where,
            order: {
                updatedAt: 'DESC',
                id: 'DESC'
            }
        });
    }

    async syncProcessedRecordsWithActualFilesByTaskIds(taskIds) {
        const normalizedTaskIds = Array.from(new Set(
            (Array.isArray(taskIds) ? taskIds : [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        ));
        if (normalizedTaskIds.length === 0) {
            throw new Error('任务ID不能为空');
        }

        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const pendingCount = await taskProcessedFileRepo.count({
            where: {
                taskId: In(normalizedTaskIds),
                status: In(['pending', 'processing', 'failed'])
            }
        });
        if (pendingCount === 0) {
            return 0;
        }

        const tasks = await this.taskRepo.find({
            where: {
                id: In(normalizedTaskIds)
            },
            relations: {
                account: true
            }
        });

        let updatedCount = 0;
        for (const task of tasks) {
            updatedCount += await this._syncTaskDetailRecordsWithActualFiles(task);
        }
        if (updatedCount > 0) {
            await this.syncTaskProgressFromProcessedRecords(tasks);
        }
        return updatedCount;
    }

    async resetProcessedRecords(taskId) {
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        await taskProcessedFileRepo.delete({ taskId });
    }

    async resetProcessedRecordsByTaskIds(taskIds) {
        const normalizedTaskIds = Array.from(new Set(
            (Array.isArray(taskIds) ? taskIds : [])
                .map(id => Number(id))
                .filter(id => Number.isInteger(id) && id > 0)
        ));
        if (normalizedTaskIds.length === 0) {
            throw new Error('任务ID不能为空');
        }

        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        await taskProcessedFileRepo.delete({
            taskId: In(normalizedTaskIds)
        });
    }

    async deleteProcessedRecord(taskId, recordId) {
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const record = await taskProcessedFileRepo.findOneBy({
            id: recordId,
            taskId
        });
        if (!record) {
            throw new Error('已转存记录不存在');
        }
        await taskProcessedFileRepo.remove(record);
    }

    async deleteProcessedRecordsByIds(recordIds) {
        if (!Array.isArray(recordIds) || recordIds.length === 0) {
            throw new Error('未选择要删除的记录');
        }
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        await taskProcessedFileRepo.delete({
            id: In(recordIds)
        });
    }

    async _getDoneProcessedSourceFileIds(taskId) {
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const records = await taskProcessedFileRepo.find({
            select: {
                sourceFileId: true
            },
            where: {
                taskId,
                status: In(['done', 'completed', 'success'])
            }
        });
        return new Set(records.map(record => String(record.sourceFileId)));
    }

    async _saveProcessedFileRecord(task, file, status, errorMessage = '') {
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const restoredFileName = CasService.isCasFile(file.name)
            ? CasService.getOriginalFileName(file.name)
            : file.name;
        
        // 1. 查找现有记录
        const existingRecord = await taskProcessedFileRepo.findOneBy({
            taskId: task.id,
            sourceFileId: String(file.id)
        });

        const oldStatus = existingRecord?.status || 'none';

        // 2. 【核心保护逻辑】：禁止已成功的记录被覆盖为失败
        if (existingRecord && ['done', 'completed', 'success'].includes(existingRecord.status) && status === 'failed') {
            logTaskEvent(`[状态保护] 拦截到覆盖尝试: ${file.name} (当前:${existingRecord.status}, 尝试写入:${status})`, 'warn', 'transfer');
            // 打印堆栈以便排查是谁在尝试回滚状态
            console.warn(`[状态保护堆栈] 文件: ${file.name}`);
            console.trace(); 
            return existingRecord;
        }

        // 3. 打印详细日志
        if (status === 'failed') {
            console.error(`[Record写入] 任务ID:${task.id} | 文件:${file.name} | 状态:${oldStatus} -> ${status} | 错误:${errorMessage}`);
            console.trace('[失败状态写入堆栈]'); 
        } else {
            console.log(`[Record写入] 任务ID:${task.id} | 文件:${file.name} | 状态:${oldStatus} -> ${status}`);
        }

        // 4. 执行 UPSERT
        await taskProcessedFileRepo.upsert({
            taskId: task.id,
            sourceFileId: String(file.id),
            sourceFileName: file.name,
            sourceMd5: file.md5 || '',
            sourceShareId: task.shareId || '',
            restoredFileName,
            status,
            lastError: (status === 'done' || status === 'completed') ? null : (errorMessage || null)
        }, ['taskId', 'sourceFileId']);
    }

    async _saveProcessedFileRecords(task, files, status, errorMessage = '') {
        for (const file of files || []) {
            await this._saveProcessedFileRecord(task, file, status, errorMessage);
        }
    }

    // 删除任务
    async deleteTask(taskId, deleteCloud) {
        const task = await this.getTaskById(taskId);
        if (!task) throw new Error('任务不存在');
        await logTaskEvent(`开始删除任务: taskId=${taskId}, deleteCloud=${!!deleteCloud}, resourceName=${task.resourceName || ''}`, 'info', 'task');
        const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        if (!task.enableSystemProxy && deleteCloud) {
            const account = await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);
            await this.deleteCloudFile(cloud189,await this.getRootFolder(task), 1);
            // 删除strm
            new StrmService().deleteDir(path.join(task.account.localStrmPrefix, folderName))
            // 刷新Alist缓存
            await this.refreshAlistCache(task, true)
        }
        if (task.enableSystemProxy) {
            // 删除strm
            new StrmService().deleteDir(path.join(task.account.localStrmPrefix, folderName))
        }
        // 删除定时任务
        if (task.enableCron) {
            SchedulerService.removeTaskJob(task.id)
        }
        await this.resetProcessedRecords(task.id);
        await this.taskRepo.remove(task);
        await logTaskEvent(`任务删除完成: taskId=${taskId}, resourceName=${task.resourceName || ''}`, 'info', 'task');
    }

    // 批量删除
    async deleteTasks(taskIds, deleteCloud) {
        for(const taskId of taskIds) {
            try{
                await this.deleteTask(taskId, deleteCloud)
            }catch (error){

            }
        }
    }

    // 获取文件夹下的所有文件
    async getAllFolderFiles(cloud189, task) {
        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        }
        const folderId = task.realFolderId;
        const folderInfo = await cloud189.listFiles(folderId);
        // 如果folderInfo.res_code == FileNotFound 需要重新创建目录
        if (folderInfo?.res_code == "FileNotFound") {
            logTaskEvent('文件夹不存在!', 'warn', 'transfer')
            if (!task) {
                throw new Error('文件夹不存在!');
            }
            logTaskEvent('正在重新创建目录', 'info', 'transfer');
            const enableAutoCreateFolder = ConfigService.getConfigValue('task.enableAutoCreateFolder');
            if (enableAutoCreateFolder) {
                await this._autoCreateFolder(cloud189, task);
                return await this.getAllFolderFiles(cloud189, task);
            }
        }
        if (!folderInfo || !folderInfo.fileListAO) {
            return [];
        }
        return await this._collectFolderFilesRecursive(cloud189, folderId, '');
    }

    async _collectFolderFilesRecursive(cloud189, folderId, relativeDir = '') {
        const folderInfo = await cloud189.listFiles(folderId);
        if (!folderInfo?.fileListAO) {
            return [];
        }
        const currentRelativeDir = relativeDir ? relativeDir.replace(/^\/+|\/+$/g, '') : '';
        const fileList = (folderInfo.fileListAO.fileList || []).map(file => ({
            ...file,
            parentFolderId: String(folderId),
            relativeDir: currentRelativeDir,
            relativePath: currentRelativeDir ? path.join(currentRelativeDir, file.name) : file.name
        }));
        const folderList = folderInfo.fileListAO.folderList || [];
        for (const folder of folderList) {
            const nextRelativeDir = currentRelativeDir ? path.join(currentRelativeDir, folder.name) : folder.name;
            const childFiles = await this._collectFolderFilesRecursive(cloud189, folder.id, nextRelativeDir);
            fileList.push(...childFiles);
        }
        return fileList;
    }

    // 自动创建目录
    async _autoCreateFolder(cloud189, task) {
         // 检查 targetFolderId 是否存在
         const targetFolderInfo = await cloud189.listFiles(task.targetFolderId);
         if (targetFolderInfo.res_code === "FileNotFound") {
             throw new Error('保存目录不存在，无法自动创建目录');
         }

        // 如果 realRootFolderId 存在，先检查是否可用
        if (task.realRootFolderId) {
            const rootFolderInfo = await cloud189.listFiles(task.realRootFolderId);
            if (rootFolderInfo.res_code === "FileNotFound") {
                // realRootFolderId 不存在或不可用，需要创建
                const rootFolderName = task.resourceName.replace('(根)', '').trim();
                logTaskEvent(`正在创建根目录: ${rootFolderName}`, 'info', 'transfer');
                const rootFolder = await cloud189.createFolder(rootFolderName, task.targetFolderId);
                if (!rootFolder?.id) throw new Error('创建根目录失败');
                task.realRootFolderId = rootFolder.id;
                logTaskEvent(`根目录创建成功: ${rootFolderName}`, 'info', 'transfer');
            }
        }

        const shareFolderName = String(task.shareFolderName || '').trim();
        const hasSubFolder = shareFolderName.length > 0;

        // 只有明确存在子目录名称时，才按子目录任务处理。
        // 根目录任务在某些场景下 realFolderId 可能与 realRootFolderId 不一致，
        // 但 shareFolderName 为空，此时不能再尝试创建空名称目录。
        if (hasSubFolder && task.realRootFolderId !== task.realFolderId) {
            logTaskEvent(`正在创建子目录: ${shareFolderName}`, 'info', 'transfer');
            const subFolder = await cloud189.createFolder(shareFolderName, task.realRootFolderId);
            if (!subFolder?.id) throw new Error('创建子目录失败');
            task.realFolderId = subFolder.id;
            logTaskEvent(`子目录创建成功: ${shareFolderName}`, 'info', 'transfer');
        } else {
            // 根目录任务或缺少子目录名时，直接将 realFolderId 指向根目录。
            task.realFolderId = task.realRootFolderId;
        }

        await this.taskRepo.save(task);
        logTaskEvent('目录创建完成', 'info', 'transfer');
    }

    // 处理新文件
    async _handleNewFiles(task, newFiles, cloud189, mediaSuffixs) {
        const deduped = this._dedupeFilesByEpisode(newFiles, task);
        const effectiveNewFiles = deduped.uniqueFiles;
        const duplicateFiles = deduped.duplicates;
        const taskInfoList = [];
        const fileNameList = [];
        const casService = new CasService();
        const normalFiles = [];
        const casFiles = [];

        for (const duplicate of duplicateFiles) {
            await this._saveProcessedFileRecord(task, duplicate, 'deduped');
            logTaskEvent(`转存前去重: 标记重复版本 ${duplicate.name}，保留更高画质版本`, 'info', 'transfer');
        }

        for (const file of effectiveNewFiles) {
            if (task.enableSystemProxy) {
                throw new Error('系统代理模式已移除');
            } else {
                // 普通模式：添加到转存任务
                taskInfoList.push({
                    fileId: file.id,
                    fileName: file.name,
                    isFolder: 0,
                    md5: file.md5,
                });
            }
            if (CasService.isCasFile(file.name)) {
                casFiles.push(file);
            } else {
                normalFiles.push(file);
            }
            const displayName = CasService.isCasFile(file.name)
                ? `${file.name} -> ${CasService.getOriginalFileName(file.name)}`
                : file.name;
            fileNameList.push(`├─ ${displayName}`);
        }
        // 如果有多个文件，最后一个文件使用└─
        if (fileNameList.length > 0) {
            const lastItem = fileNameList.pop();
            fileNameList.push(lastItem.replace('├─', '└─'));
        }
        if (taskInfoList.length > 0) {
            if (!task.enableSystemProxy) {
                await this._saveProcessedFileRecords(task, effectiveNewFiles, 'processing');
                const batchTaskDto = new BatchTaskDto({
                    taskInfos: JSON.stringify(taskInfoList),
                    type: 'SHARE_SAVE',
                    targetFolderId: task.realFolderId,
                    shareId: task.shareId
                });
                await this.createBatchTask(cloud189, batchTaskDto);
                if (normalFiles.length > 0) {
                    await this._saveProcessedFileRecords(task, normalFiles, 'done');
                }
                await this._restoreTransferredCasFiles(task, casFiles, cloud189, casService);
            } else {
                throw new Error('系统代理模式已移除');
            }
        }
        // 修改省略号的显示格式
        if (fileNameList.length > 20) {
            fileNameList.splice(5, fileNameList.length - 10, '├─ ...');
        }

        return { fileNameList, fileCount: this._countUniqueEpisodes(effectiveNewFiles, task), effectiveNewFiles };
    }

    async _restoreTransferredCasFiles(task, newFiles, cloud189, casService = new CasService()) {
        const casFiles = (newFiles || []).filter((file) => CasService.isCasFile(file.name));
        if (!casFiles.length) {
            return;
        }

        for (const casFile of casFiles) {
            try {
                const transferredCasFile = await this._waitForFileByName(cloud189, task.realFolderId, casFile.name);
                if (!transferredCasFile) {
                    throw new Error(`未找到已转存CAS文件: ${casFile.name}`);
                }
                const casInfo = await casService.downloadAndParseCas(cloud189, transferredCasFile.id);
                const restoreName = CasService.getOriginalFileName(casFile.name, casInfo);
                
                // 核心：秒传恢复
                await casService.restoreFromCas(cloud189, task.realFolderId, casInfo, restoreName);
                
                // 非核心：物理确认 (降级)
                try {
                    await this._waitForFileByName(cloud189, task.realFolderId, restoreName, 10, 1000);
                } catch (e) {
                    logTaskEvent(`[警告] 等待恢复文件落盘确认超时: ${restoreName}`, 'warn', 'transfer');
                }

                await this._saveProcessedFileRecord(task, casFile, 'done');

                // 非核心：清理源文件 (降级)
                try {
                    await cloud189.deleteFile(transferredCasFile.id, transferredCasFile.name);
                    logTaskEvent(`普通任务已删除CAS文件: ${transferredCasFile.name}`, 'info', 'transfer');
                } catch (deleteError) {
                    logTaskEvent(`[警告] 清理CAS临时文件失败: ${transferredCasFile.name}, 错误: ${deleteError.message}`, 'warn', 'transfer');
                }
            } catch (error) {
                await this._saveProcessedFileRecord(task, casFile, 'failed', error.message);
                logTaskEvent(`普通任务恢复CAS文件失败: ${casFile.name}, 错误: ${error.message}`, 'error', 'transfer');
                throw error;
            }
        }
    }

    async _waitForFileByName(cloud189, folderId, fileName, maxAttempts = 120, intervalMs = 1000) {
        for (let index = 0; index < maxAttempts; index++) {
            const folderInfo = await cloud189.listFiles(folderId);
            const files = folderInfo?.fileListAO?.fileList || [];
            const file = files.find((item) => item.name === fileName);
            if (file) {
                return file;
            }
            if (index < maxAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs));
            }
        }
        return null;
    }

    async _getLazyStrmFiles(task, shareFiles) {
        let filteredFiles = [...shareFiles];
        let aiFiltered = false;
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase());

        if (this._isAiAdvancedMode() && task.matchPattern && task.matchOperator && task.matchValue) {
            const aiResult = await this._filterFilesWithAI(task, filteredFiles);
            if (aiResult != null) {
                filteredFiles = aiResult;
                aiFiltered = true;
            }
        }

        return filteredFiles.filter(file =>
            !file.isFolder
            && this._checkFileSuffix(file, true, mediaSuffixs)
            && (aiFiltered || this._handleMatchMode(task, file))
            && !this.isHarmonized(file)
        );
    }

    // 使用 AI 过滤文件列表
    async _filterFilesWithAI(task, fileList) {
        logTaskEvent(`任务 ${task.id}: 尝试使用 AI 进行文件过滤...`, 'info', 'transfer');

        // 1. 构建中文过滤描述
        let filterDescription = '';
        const pattern = task.matchPattern; // 例如: "剧集", "文件名"
        const operator = task.matchOperator; // 例如: "lt", "gt", "eq", "contains", "not contains"
        const value = task.matchValue; // 例如: "8", "特效", "1080p"

        if (!pattern || !operator || !value) {
            logTaskEvent(`任务 ${task.id}: AI 过滤条件不完整，跳过 AI 过滤。`, 'warn', 'transfer');
            return null; // 条件不完整，无法生成描述
        }

        let operatorText = '';
        switch (operator) {
            case 'gt': operatorText = '大于'; break;
            case 'lt': operatorText = '小于'; break;
            case 'eq': operatorText = '等于'; break;
            case 'contains': operatorText = '包含'; break;
            case 'notContains':
            case 'not contains':
                operatorText = '不包含';
                break;
            default:
                logTaskEvent(`任务 ${task.id}: 未知的过滤操作符 "${operator}"，跳过 AI 过滤。`, 'warn', 'transfer');
                return null;
        }

        // 根据 pattern 生成更自然的描述
        filterDescription = `筛选出 ${pattern} ${operatorText} "${value}" 的文件。请根据文件名判断。`;
        logTaskEvent(`任务 ${task.id}: 生成 AI 过滤描述: "${filterDescription}"`, 'info', 'transfer');


        // 2. 准备给 AI 的文件列表 (仅含 id 和 name)
        const filesForAI = fileList.map(f => ({ id: f.id, name: f.name }));

        // 3. 调用 AI 服务
        try {
            const aiResponse = await AIService.filterMediaFiles(task.resourceName, filesForAI, filterDescription);

            if (aiResponse.success && Array.isArray(aiResponse.data)) {
                logTaskEvent(`任务 ${task.id}: AI 文件过滤成功，保留 ${aiResponse.data.length} 个文件。`, 'info', 'transfer');
                // 使用 AI 返回的 id 列表来过滤原始的完整文件列表
                const keptFileIds = new Set(aiResponse.data);
                // 先应用后缀过滤，再应用AI过滤结果
                const filteredList = fileList.filter(file => keptFileIds.has(file.id));
                return filteredList; 
            } else {
                logTaskEvent(`任务 ${task.id}: AI 文件过滤失败: ${aiResponse.error || '未知错误'}。`, 'error', 'transfer');
                return null;
            }
        } catch (error) {
            logTaskEvent(`任务 ${task.id}: 调用 AI 文件过滤时发生错误: ${error.message}`, 'error', 'transfer');
            console.error(`AI filter error for task ${task.id}:`, error);
            return null; 
        }
    }

    _canAutoRefreshTaskSource(task) {
        if (!this.autoSeriesService) {
            return false;
        }
        return String(task?.taskGroup || '').includes('自动追剧') && !task?.enableLazyStrm;
    }

    _shouldOnlySaveMedia(task) {
        return ConfigService.getConfigValue('task.enableOnlySaveMedia')
            || String(task?.taskGroup || '').includes('自动追剧')
            || !!task?.enableLazyStrm;
    }

    async _tryAutoRefreshTaskSource(task, reason) {
        if (!this._canAutoRefreshTaskSource(task)) {
            return { updated: false, skipped: true };
        }

        const reasonText = reason === 'share_invalid' ? '当前分享源失效' : '当前分享源无增量';
        logTaskEvent(`任务[${task.resourceName}]${reasonText}，尝试通过 CloudSaver 自动换源...`, 'info', 'transfer');
        const result = await this.autoSeriesService.maybeRefreshTaskSource(task, reason);
        if (result?.updated) {
            const resourceTitle = result.resourceTitle ? `，匹配资源: ${result.resourceTitle}` : '';
            logTaskEvent(`任务[${task.resourceName}]已自动切换资源源${resourceTitle}，新链接: ${result.shareLink}`, 'info', 'transfer');
        } else if (!result?.skipped) {
            logTaskEvent(`任务[${task.resourceName}]自动换源未找到更合适的资源`, 'info', 'transfer');
        }
        return result || { updated: false };
    }

    // 执行任务
    async processTask(task, options = {}) {
        const { allowSourceRefresh = true } = options;

        // 增强：转存开始的同时，自动尝试通过 TMDB 获取总集数
        if (task && (!task.totalEpisodes || task.totalEpisodes === 0)) {
            try {
                const seasonInfo = await this.resolveTmdbSeasonInfo(task, { updateTask: true });
                if (seasonInfo?.totalEpisodes) {
                    const seasonText = seasonInfo.seasonNumber ? ` S${String(seasonInfo.seasonNumber).padStart(2, '0')}` : '';
                    console.log(`[TaskService] 转存时自动对齐 TMDB 集数: ${task.resourceName}${seasonText} -> ${seasonInfo.totalEpisodes}集`);
                }
            } catch (e) {
                console.warn(`[TaskService] 自动补全集数由于网络或名称问题跳过: ${e.message}`);
            }
        }
        this._alignTaskTotalEpisodesToSeason(task);

        let saveResults = [];
        let attemptedNewFiles = [];
        try {
            const account = await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) {
                logTaskEvent(`账号不存在，accountId: ${task.accountId}`, 'warn', 'transfer');
                throw new Error('账号不存在');
            }
            task.account = account;
            const cloud189 = Cloud189Service.getInstance(account);
             // 获取分享文件列表并进行增量转存
             const shareDir = await cloud189.listShareDir(task.shareId, task.shareFolderId, task.shareMode,task.accessCode, task.isFolder);
             if(shareDir.res_code == "ShareAuditWaiting") {
                logTaskEvent("分享链接审核中, 等待下次执行", 'info', 'transfer')
                return ''
             }
             if (!shareDir?.fileListAO?.fileList) {
                if (allowSourceRefresh) {
                    const refreshResult = await this._tryAutoRefreshTaskSource(task, 'share_invalid');
                    if (refreshResult?.updated) {
                        return await this.processTask(task, { allowSourceRefresh: false });
                    }
                }
                logTaskEvent("获取文件列表失败: " + JSON.stringify(shareDir), 'error', 'transfer');
                throw new Error('获取文件列表失败');
            }
            let shareFiles = [...shareDir.fileListAO.fileList];
            const enableOnlySaveMedia = this._shouldOnlySaveMedia(task);
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            if (task.enableLazyStrm) {
                const lazyFiles = await this._getLazyStrmFiles(task, shareFiles);
                const previousEpisodes = task.currentEpisodes || 0;
                const firstExecution = !task.lastFileUpdateTime;
                const resourceName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;

                if (lazyFiles.length > 0) {
                    task.status = 'processing';
                    task.retryCount = 0;
                    task.currentEpisodes = lazyFiles.length;
                    if (firstExecution || lazyFiles.length !== previousEpisodes) {
                        task.lastFileUpdateTime = new Date();
                        saveResults.push(`${resourceName}同步懒转存STRM ${lazyFiles.length} 个文件`);
                    }
                    process.nextTick(() => {
                        this.eventService.emit('taskComplete', new TaskCompleteEventDto({
                            task,
                            cloud189,
                            fileList: lazyFiles,
                            overwriteStrm: false,
                            firstExecution: firstExecution
                        }));
                    });
                } else if (task.lastFileUpdateTime) {
                    const now = new Date();
                    const lastUpdate = new Date(task.lastFileUpdateTime);
                    const daysDiff = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
                    if (daysDiff >= ConfigService.getConfigValue('task.taskExpireDays')) {
                        task.status = 'completed';
                        await this._syncTaskDetailRecordsWithActualFiles(task);
                    }
                    task.currentEpisodes = 0;
                    logTaskEvent(`${task.resourceName} 当前没有可生成懒转存STRM的媒体文件`, 'info', 'transfer');
                }

                const expectedEpisodes = this._getSeasonExpectedEpisodes(task);
                if (expectedEpisodes && task.currentEpisodes >= expectedEpisodes) {
                    task.status = 'completed';
                    await this._syncTaskDetailRecordsWithActualFiles(task);
                    logTaskEvent(`${task.resourceName} 已完结`, 'info', 'transfer');
                }
                task.lastCheckTime = new Date();
                await this.taskRepo.save(task);
                return saveResults.join('\n');
            }

            const folderFiles = await this.getAllFolderFiles(cloud189, task);
            const { existingFiles, existingFileNames, existingMediaFiles } = folderFiles.reduce((acc, file) => {
                if (!file.isFolder) {
                    acc.existingFiles.add(file.md5);
                    acc.existingFileNames.add(file.name);
                    // CAS 任务转存后会恢复为原始文件名，补充一份 .cas 对应名，避免后续把同一集重复识别成新增。
                    if (!CasService.isCasFile(file.name)) {
                        acc.existingFileNames.add(`${file.name}.cas`);
                    } else {
                        acc.existingFileNames.add(CasService.getOriginalFileName(file.name));
                    }
                    if ((task.totalEpisodes == null || task.totalEpisodes <= 0) || this._checkFileSuffix(file, true, mediaSuffixs)) {
                        acc.existingMediaFiles.push(file);
                    }
                }
                return acc;
            }, { 
                existingFiles: new Set(), 
                existingFileNames: new Set(), 
                existingMediaFiles: [] 
            });
            // 始终以目标目录中的现有媒体文件数回填进度，避免首次执行但无新增时进度不刷新。
            const existingMediaCount = this._countUniqueEpisodes(existingMediaFiles, task);
            task.currentEpisodes = existingMediaCount;
            let aiFiltered = false;
            if (this._isAiAdvancedMode() && task.matchPattern && task.matchOperator && task.matchValue) {
                const aiResult = await this._filterFilesWithAI(task, shareFiles)
                if (aiResult != null) {
                    shareFiles = aiResult;
                    aiFiltered = true;
                }
            }
            const doneProcessedIds = await this._getDoneProcessedSourceFileIds(task.id);
            
            const newFiles = shareFiles
                .filter(file => 
                    !file.isFolder && !existingFiles.has(file.md5) 
                   && !existingFileNames.has(file.name)
                   && !doneProcessedIds.has(String(file.id))
                   && this._checkFileSuffix(file, enableOnlySaveMedia, mediaSuffixs)
                   && (aiFiltered || this._handleMatchMode(task, file))
                   && !this.isHarmonized(file)
                );
            attemptedNewFiles = newFiles;

            // 处理新文件并保存到数据库和云盘
            if (newFiles.length > 0) {
                const { fileNameList, fileCount, effectiveNewFiles } = await this._handleNewFiles(task, newFiles, cloud189, mediaSuffixs);
                const resourceName = task.shareFolderName? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;
                saveResults.push(`${resourceName}追更${fileCount}集: \n${fileNameList.join('\n')}`);
                const firstExecution = !task.lastFileUpdateTime;
                task.status = 'processing';
                task.lastFileUpdateTime = new Date();
                task.currentEpisodes = this._countMergedUniqueEpisodes(existingMediaFiles, effectiveNewFiles, task);
                task.retryCount = 0;
                process.nextTick(() => {
                    this.eventService.emit('taskComplete', new TaskCompleteEventDto({
                        task,
                        cloud189,
                        fileList: effectiveNewFiles,
                        overwriteStrm: false,
                        firstExecution: firstExecution
                    }));
                })
            } else {
                if (allowSourceRefresh) {
                    const refreshResult = await this._tryAutoRefreshTaskSource(task, 'no_increment');
                    if (refreshResult?.updated) {
                        return await this.processTask(task, { allowSourceRefresh: false });
                    }
                }
                if (task.lastFileUpdateTime) {
                    // 检查是否超过3天没有新文件
                    const now = new Date();
                    const lastUpdate = new Date(task.lastFileUpdateTime);
                    const daysDiff = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
                    if (daysDiff >= ConfigService.getConfigValue('task.taskExpireDays')) {
                        task.status = 'completed';
                        await this._syncTaskDetailRecordsWithActualFiles(task);
                    }
                    logTaskEvent(`${task.resourceName} 没有增量剧集`, 'info', 'transfer')
                }
            }
            // 检查是否达到总数
            const expectedEpisodes = this._getSeasonExpectedEpisodes(task);
            if (expectedEpisodes && task.currentEpisodes >= expectedEpisodes) {
                task.status = 'completed';
                logTaskEvent(`${task.resourceName} 已完结`, 'info', 'transfer')
            }

            task.lastCheckTime = new Date();
            await this.taskRepo.save(task);
            return saveResults.join('\n');
        } catch (error) {
            if (attemptedNewFiles.length > 0) {
                await this._saveProcessedFileRecords(task, attemptedNewFiles, 'failed', error.message);
            }
            return await this._handleTaskFailure(task, error);
        }
    }

    // 获取所有任务
    async getTasks() {
        return await this.taskRepo.find({
            order: {
                id: 'DESC'
            }
        });
    }

    async syncTaskProgressFromProcessedRecords(tasks = []) {
        const taskList = Array.isArray(tasks) ? tasks.filter(task => task?.id) : [];
        if (taskList.length === 0) {
            return taskList;
        }

        const taskIds = taskList.map(task => task.id);
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const records = await taskProcessedFileRepo.find({
            select: {
                taskId: true,
                restoredFileName: true,
                updatedAt: true
            },
            where: {
                taskId: In(taskIds),
                status: In(['processing', 'done', 'completed', 'success'])
            }
        });

        const statsByTaskId = new Map();
        for (const record of records) {
            const taskId = Number(record.taskId);
            if (!statsByTaskId.has(taskId)) {
                statsByTaskId.set(taskId, {
                    restoredFileNames: [],
                    lastUpdatedAt: null
                });
            }
            const stats = statsByTaskId.get(taskId);
            if (record.restoredFileName) {
                stats.restoredFileNames.push(record.restoredFileName);
            }
            if (record.updatedAt && (!stats.lastUpdatedAt || new Date(record.updatedAt) > stats.lastUpdatedAt)) {
                stats.lastUpdatedAt = new Date(record.updatedAt);
            }
        }

        const pendingUpdates = [];

        for (const task of taskList) {
            const stats = statsByTaskId.get(task.id);
            let changed = this._alignTaskTotalEpisodesToSeason(task);

            if (stats) {
                const currentEpisodes = Number(task.currentEpisodes) || 0;
                const uniqueCount = this._countUniqueEpisodes(stats.restoredFileNames.map(name => ({ restoredFileName: name })), task);
                const nextEpisodes = Math.max(currentEpisodes, uniqueCount);

                if (nextEpisodes !== currentEpisodes) {
                    task.currentEpisodes = nextEpisodes;
                    changed = true;
                }

                if (!task.lastFileUpdateTime && stats.lastUpdatedAt) {
                    task.lastFileUpdateTime = stats.lastUpdatedAt;
                    changed = true;
                }
            }

            changed = this._syncTaskCompletionState(task) || changed;

            if (changed) {
                pendingUpdates.push({
                    id: task.id,
                    totalEpisodes: task.totalEpisodes,
                    currentEpisodes: task.currentEpisodes,
                    lastFileUpdateTime: task.lastFileUpdateTime,
                    status: task.status
                });
            }
        }

        if (pendingUpdates.length > 0) {
            await this.taskRepo.save(pendingUpdates);
        }

        return taskList;
    }

    // 获取待处理任务
    async getPendingTasks(ignore = false, taskIds = []) {
        const conditions = [
            {
                status: 'pending',
                nextRetryTime: null,
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            },
            {
                status: 'processing',
                enableSystemProxy: IsNull(),
                ...(ignore ? {} : { enableCron: false })
            }
        ];
        return await this.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
            where: [
                ...(taskIds.length > 0 
                    ? [{ id: In(taskIds) }] 
                    : conditions)
            ]
        });
    }

    // 更新任务
    async updateTask(taskId, updates) {
        const task = await this.taskRepo.findOne({
            where: { id: taskId },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            }
        });
        if (!task) throw new Error('任务不存在');
        const hasExplicitStatusUpdate = updates.status !== undefined;
        const previousTaskSnapshot = {
            resourceName: task.resourceName,
            remark: task.remark,
            status: task.status,
            currentEpisodes: task.currentEpisodes,
            totalEpisodes: task.totalEpisodes,
            realFolderName: task.realFolderName,
            targetFolderName: task.targetFolderName,
            tmdbId: task.tmdbId,
            tmdbSeasonNumber: task.tmdbSeasonNumber,
            tmdbSeasonEpisodes: task.tmdbSeasonEpisodes,
            enableCron: task.enableCron,
            cronExpression: task.cronExpression,
            enableTaskScraper: task.enableTaskScraper,
            enableLazyStrm: task.enableLazyStrm,
            enableOrganizer: task.enableOrganizer
        };

        // 如果原realFolderName和现realFolderName不一致 则需要删除原strm
        if (updates.realFolderName && updates.realFolderName !== task.realFolderName && ConfigService.getConfigValue('strm.enable')) {
            // 删除原strm
            // 从realFolderName中获取文件夹名称
            const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
            new StrmService().deleteDir(path.join(task.account.localStrmPrefix, folderName))
        }
        // 只允许更新特定字段
        const allowedFields = ['resourceName', 'targetFolderId', 'targetFolderName', 'organizerTargetFolderId', 'organizerTargetFolderName', 'realFolderId', 'currentEpisodes', 'totalEpisodes', 'status','realFolderName', 'shareFolderName', 'shareFolderId', 'sourceRegex', 'targetRegex', 'matchPattern','matchOperator','matchValue','remark', 'taskGroup', 'tmdbId', 'tmdbSeasonNumber', 'tmdbSeasonName', 'tmdbSeasonEpisodes', 'enableCron', 'cronExpression', 'enableTaskScraper', 'enableLazyStrm', 'enableOrganizer'];
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                task[field] = updates[field];
            }
        }
        // 如果currentEpisodes和totalEpisodes为null 则设置为0
        if (task.currentEpisodes === null) {
            task.currentEpisodes = 0;
        }
        if (task.totalEpisodes === null) {
            task.totalEpisodes = 0;
        }
        
        // 验证状态值
        const validStatuses = ['pending', 'processing', 'completed', 'failed'];
        if (!validStatuses.includes(task.status)) {
            throw new Error('无效的状态值');
        }

        // 验证数值字段
        if (task.currentEpisodes !== null && task.currentEpisodes < 0) {
            throw new Error('更新数不能为负数');
        }
        if (task.totalEpisodes !== null && task.totalEpisodes < 0) {
            throw new Error('总数不能为负数');
        }
        if (task.matchPattern && !task.matchValue) {
            throw new Error('匹配模式需要提供匹配值');
        }
        this._alignTaskTotalEpisodesToSeason(task);
        // 手动修改状态时，以用户选择为准，避免被自动完结逻辑立即改回 completed。
        if (!hasExplicitStatusUpdate) {
            this._syncTaskCompletionState(task);
        }
        const changeMessages = [];
        const trackedFields = [
            ['resourceName', '任务名'],
            ['remark', '备注'],
            ['status', '状态'],
            ['currentEpisodes', '当前集数'],
            ['totalEpisodes', '总集数'],
            ['realFolderName', '资源目录'],
            ['targetFolderName', '目标目录'],
            ['tmdbId', 'TMDB ID'],
            ['tmdbSeasonNumber', 'TMDB 季号'],
            ['tmdbSeasonEpisodes', 'TMDB 该季集数'],
            ['enableCron', '定时执行'],
            ['cronExpression', 'Cron 表达式'],
            ['enableTaskScraper', '任务刮削'],
            ['enableLazyStrm', '懒转存 STRM'],
            ['enableOrganizer', '自动整理']
        ];
        for (const [field, label] of trackedFields) {
            const beforeValue = previousTaskSnapshot[field];
            const afterValue = task[field];
            if (String(beforeValue ?? '') !== String(afterValue ?? '')) {
                changeMessages.push(`${label}: ${beforeValue ?? '空'} -> ${afterValue ?? '空'}`);
            }
        }

        const newTask = await this.taskRepo.save(task)
        if (changeMessages.length > 0) {
            await logTaskEvent(`任务[${task.resourceName || task.id}]配置已更新: ${changeMessages.join('；')}`, 'info', 'system');
        }
        SchedulerService.removeTaskJob(task.id)
        if (task.enableCron && task.cronExpression) {
            SchedulerService.saveTaskJob(newTask, this)
        }
        return newTask;
    }

    async replaceTaskSource(taskId, params = {}) {
        const task = await this.taskRepo.findOneBy({ id: taskId });
        if (!task) {
            throw new Error('任务不存在');
        }

        const account = await this.accountRepo.findOneBy({ id: task.accountId });
        if (!account) {
            throw new Error('账号不存在');
        }

        const rawShareLink = String(params.shareLink || '').trim();
        if (!rawShareLink) {
            throw new Error('分享链接不能为空');
        }

        const { url: parsedShareLink, accessCode: parsedAccessCode } = cloud189Utils.parseCloudShare(rawShareLink);
        const nextAccessCode = String(params.accessCode || parsedAccessCode || '').trim();
        const cloud189 = Cloud189Service.getInstance(account);
        const shareCode = cloud189Utils.parseShareCode(parsedShareLink);
        const shareInfo = await this.getShareInfo(cloud189, shareCode);

        if (shareInfo.shareMode == 1) {
            if (!nextAccessCode) {
                throw new Error('新分享链接为加密链接，请提供访问码');
            }
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, nextAccessCode);
            if (!accessCodeResponse?.shareId) {
                throw new Error('新分享链接访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }

        let nextShareFolderId = shareInfo.fileId;
        let nextShareFolderName = '';
        if (task.shareFolderName) {
            const shareDir = await cloud189.listShareDir(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, nextAccessCode || '');
            const folderList = shareDir?.fileListAO?.folderList || [];
            const matchedFolder = folderList.find(folder => String(folder.name || '').trim() === String(task.shareFolderName || '').trim());
            if (!matchedFolder?.id) {
                throw new Error(`新分享链接中未找到目录: ${task.shareFolderName}`);
            }
            nextShareFolderId = matchedFolder.id;
            nextShareFolderName = matchedFolder.name;
        }

        task.shareLink = parsedShareLink;
        task.accessCode = nextAccessCode;
        task.shareId = shareInfo.shareId;
        task.shareMode = shareInfo.shareMode;
        task.shareFileId = shareInfo.fileId;
        task.shareFolderId = nextShareFolderId;
        task.shareFolderName = nextShareFolderName;

        const savedTask = await this.taskRepo.save(task);
        if (params.executeNow) {
            const taskWithAccount = await this.getTaskById(taskId);
            if (!taskWithAccount) {
                throw new Error('任务不存在');
            }
            await this.processTask(taskWithAccount, { allowSourceRefresh: false });
        }

        return await this.getTaskById(taskId);
    }

    // 自动重命名
    async autoRename(cloud189, task) {
        let message = []
        let newFiles = [];
        let files = [];

        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        } else {
            files = await this.getFilesByTask(task);
        }
        if (!files || files.length === 0) return [];
        
        // 过滤掉文件夹
        files = files.filter(file => !file.isFolder);
        if (files.length === 0) return [];

        // 用户写了正则时，始终以正则为准
        if (task.sourceRegex && task.targetRegex) {
            logTaskEvent(` ${task.resourceName} 开始使用正则表达式重命名`, 'info', 'transfer');
            await this._processRegexRename(cloud189, task, files, message, newFiles);
        } else {
            const aiMode = this._getAiMode();
            const fallbackResourceInfo = this._buildLocalRenameResourceInfo(task, files);

            if (aiMode === 'advanced') {
                logTaskEvent(` ${task.resourceName} 开始使用 AI 高级重命名`, 'info', 'transfer');
                try {
                    const resourceInfo = await this._analyzeResourceInfo(
                        task.resourceName,
                        files.map(f => ({ id: f.id, name: f.name })),
                        'file'
                    );
                    await this._processRename(cloud189, task, files, resourceInfo, message, newFiles);
                } catch (error) {
                    logTaskEvent(`AI 高级重命名失败，已回退 TMDB 顺序编号: ${error.message}`, 'error', 'transfer');
                    await this._processRename(cloud189, task, files, fallbackResourceInfo, message, newFiles);
                }
            } else {
                logTaskEvent(` ${task.resourceName} 开始使用 TMDB 顺序编号重命名`, 'info', 'transfer');
                await this._processRename(cloud189, task, files, fallbackResourceInfo, message, newFiles);
                if (aiMode === 'fallback') {
                    logTaskEvent(`TMDB 顺序编号仅作基础回退，尝试使用 AI 兜底`, 'info', 'transfer');
                    try {
                        const aiResourceInfo = await this._analyzeResourceInfo(
                            task.resourceName,
                            files.map(f => ({ id: f.id, name: f.name })),
                            'file'
                        );
                        message = [];
                        newFiles = [];
                        await this._processRename(cloud189, task, files, aiResourceInfo, message, newFiles);
                    } catch (error) {
                        logTaskEvent(`AI 兜底重命名失败，保留 TMDB 顺序编号结果: ${error.message}`, 'error', 'transfer');
                        message = [];
                        newFiles = [];
                        await this._processRename(cloud189, task, files, fallbackResourceInfo, message, newFiles);
                    }
                }
            }
        }

        // 处理消息和保存结果
        await this._handleRenameResults(task, message, newFiles);
        return newFiles;
    }


    // 处理重命名结果
    async _handleRenameResults(task, message, newFiles) {
        if (message.length > 0) {
            const lastMessage = message[message.length - 1];
            message[message.length - 1] = lastMessage.replace('├─', '└─');
        }
        if (task.enableSystemProxy && newFiles.length > 0) {
            throw new Error('系统代理模式已移除');
        }
        // 修改省略号的显示格式
        if (message.length > 20) {
            message.splice(5, message.length - 10, '├─ ...');
        }
        message.length > 0 && logTaskEvent(`${task.resourceName}自动重命名完成: \n${message.join('\n')}`, 'info', 'transfer')
        message.length > 0 && this.messageUtil.sendMessage(`${task.resourceName}自动重命名: \n${message.join('\n')}`);
    }

    // 根据AI分析结果生成新文件名
    _generateFileName(file, aiFile, resourceInfo, template) {
        if (!aiFile) return file.name;
        
        // 构建文件名替换映射
        const replaceMap = {
            '{name}': aiFile.name || resourceInfo.name,
            '{year}': resourceInfo.year || '',
            '{s}': aiFile.season?.padStart(2, '0') || '01',
            '{e}': aiFile.episode?.padStart(2, '0') || '01',
            '{sn}': parseInt(aiFile.season) || '1',                    // 不补零的季数
            '{en}': parseInt(aiFile.episode) || '1',                   // 不补零的集数
            '{ext}': aiFile.extension || path.extname(file.name),
            '{se}': `S${aiFile.season?.padStart(2, '0') || '01'}E${aiFile.episode?.padStart(2, '0') || '01'}`
        };

        // 替换模板中的占位符
        let newName = template;
        for (const [key, value] of Object.entries(replaceMap)) {
            newName = newName.replace(new RegExp(key, 'g'), value);
        }
        // 清理文件名中的非法字符
        return this._sanitizeFileName(newName);
    }

    _buildLocalRenameResourceInfo(task, files) {
        const sortedFiles = [...files].sort((left, right) =>
            String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' })
        );
        const title = this._sanitizeMediaTitle(task.resourceName || '');
        const year = this._extractYear(task.resourceName || '');
        const parsedEpisodes = sortedFiles.map((file, index) => ({
            id: String(file.id),
            name: title,
            season: '01',
            episode: String(index + 1).padStart(2, '0'),
            extension: path.extname(file.name) || ''
        }));
        return {
            name: title,
            year,
            type: sortedFiles.length > 1 ? 'tv' : 'movie',
            season: '01',
            episode: parsedEpisodes
        };
    }

    _sanitizeMediaTitle(value = '') {
        return String(value || '')
            .replace(/\(根\)$/g, '')
            .replace(/[\[【(（](19|20)\d{2}[\]】)）]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _extractYear(value = '') {
        const matched = String(value || '').match(/(19|20)\d{2}/);
        return matched ? matched[0] : '';
    }

    buildOrganizerDirectoryName(aiFile, resourceInfo) {
        if (!aiFile || resourceInfo?.type !== 'tv') {
            return '';
        }
        const seasonValue = String(aiFile.season || '').trim();
        if (!seasonValue) {
            return '';
        }
        if (/^\d+$/.test(seasonValue)) {
            return `Season ${seasonValue.padStart(2, '0')}`;
        }
        return seasonValue;
    }
    // 处理重命名过程
    async _processRename(cloud189, task, files, resourceInfo, message, newFiles) {
        const newNames = Array.isArray(resourceInfo?.episode) ? resourceInfo.episode : [];
        // 处理aiFilename, 文件命名通过配置文件的占位符获取
        // 获取用户配置的文件名模板，如果没有配置则使用默认模板
        const template = resourceInfo.type === 'movie' 
        ? ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}'  // 电影模板
        : ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}';  // 剧集模板
        for (const file of files) {
            try {
                const aiFile = newNames.find(f => f.id === file.id);
                if (!aiFile) {
                    newFiles.push(file);
                    continue;
                }
                const newName = this._generateFileName(file, aiFile, resourceInfo, template);
                // 判断文件名是否已存在
                if (file.name === newName) {
                    newFiles.push(file);
                    continue;   
                }
                await this._renameFile(cloud189, task, file, newName, message, newFiles);
            } catch (error) {
                logTaskEvent(`${file.name}重命名失败: ${error.message}`, 'error', 'transfer');
                newFiles.push(file);
            }
        }
    }

    // 清理文件名中的非法字符
    _sanitizeFileName(fileName) {
        // 移除文件名中的非法字符
        return fileName.replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')  // 合并多个空格
            .trim();
    }
    // 处理正则表达式重命名
    async _processRegexRename(cloud189, task, files, message, newFiles) {
        if (!task.sourceRegex || !task.targetRegex) return [];
        for (const file of files) {
            try {
                const destFileName = file.name.replace(new RegExp(task.sourceRegex), task.targetRegex);
                if (destFileName === file.name) {
                    newFiles.push(file);
                    continue;
                }
                await this._renameFile(cloud189, task, file, destFileName, message, newFiles);
            } catch (error) {
                logTaskEvent(`${file.name}重命名失败: ${error.message}`, 'error', 'transfer');
                newFiles.push(file);
            }
        }
    }

    // 执行单个文件重命名
    async _renameFile(cloud189, task, file, newName, message, newFiles) {
        let renameResult;
        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        } else {
            renameResult = await cloud189.renameFile(file.id, newName);
        }

        if (!task.enableSystemProxy && (!renameResult || renameResult.res_code != 0)) {
            // message.push(`├─ ${file.name} → ${newName}失败, 原因:${newName}${renameResult?.res_msg}`);
            newFiles.push(file);
        } else {
            message.push(`├─ ${file.name} → ${newName}`);
            newFiles.push({
                ...file,
                name: newName
            });
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }

    // 检查任务状态
    async _checkBatchTaskFilesExist(cloud189, batchTaskDto) {
        if (!batchTaskDto?.targetFolderId || !batchTaskDto?.taskInfos) {
            return false;
        }
        let taskInfos = [];
        try {
            taskInfos = JSON.parse(batchTaskDto.taskInfos || '[]');
        } catch (error) {
            logTaskEvent(`批量任务目录校验失败: taskInfos 解析异常 ${error.message}`, 'error', 'transfer');
            return false;
        }
        const fileList = await this.getAllFolderFiles(cloud189, {
            enableSystemProxy: false,
            realFolderId: batchTaskDto.targetFolderId
        });
        const existingMd5Set = new Set(
            (fileList || [])
                .filter(file => !file.isFolder && file.md5)
                .map(file => String(file.md5))
        );
        const pendingFiles = taskInfos.filter(taskInfo => !existingMd5Set.has(String(taskInfo.md5 || '')));
        if (pendingFiles.length === 0) {
            logTaskEvent(`批量任务目录校验通过: 目标目录已存在 ${taskInfos.length} 个文件，按成功处理`, 'info', 'transfer');
            return true;
        }
        logTaskEvent(`批量任务目录校验未通过: 仍缺少 ${pendingFiles.length} 个文件`, 'info', 'transfer');
        return false;
    }

    async checkTaskStatus(cloud189, taskId, count = 0, batchTaskDto, lastTaskStatus = null, minusOneCount = 0) {
        const maxAttempts = 180;
        const pollIntervalMs = 1000;
        if (count > maxAttempts) {
             logTaskEvent(`任务编号: ${taskId} 状态轮询超时，开始校验目标目录结果...`, 'info', 'transfer');
             return await this._checkBatchTaskFilesExist(cloud189, batchTaskDto);
        }
        let type = batchTaskDto.type || 'SHARE_SAVE';
        // 轮询任务状态
        const task = await cloud189.checkTaskStatus(taskId, batchTaskDto)
        if (!task) {
            return await this._checkBatchTaskFilesExist(cloud189, batchTaskDto);
        }
        const taskStatus = Number(task.taskStatus);
        if (lastTaskStatus !== taskStatus || count % 10 === 0) {
            logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}`, 'info', 'transfer');
        }
        // -1 在云端通常是失败/异常终态，不应继续高频轮询
        if (taskStatus === -1) {
            const nextMinusOneCount = minusOneCount + 1;
            if (nextMinusOneCount >= 3) {
                logTaskEvent(`任务编号: ${task.taskId} 连续 ${nextMinusOneCount} 次返回状态(-1)，停止轮询并校验目标目录结果`, 'warn', 'transfer');
                return await this._checkBatchTaskFilesExist(cloud189, batchTaskDto);
            }
            logTaskEvent(`任务编号: ${task.taskId} 返回状态(-1)，第 ${nextMinusOneCount}/3 次，继续短暂重试`, 'warn', 'transfer');
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            return await this.checkTaskStatus(cloud189, taskId, count + 1, batchTaskDto, taskStatus, nextMinusOneCount);
        }
        if (taskStatus === 3 || taskStatus === 1) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            return await this.checkTaskStatus(cloud189, taskId, count + 1, batchTaskDto, taskStatus, 0)
        }
        if (taskStatus === 4) {
            // 如果failedCount > 0 说明有失败或者被和谐的文件, 需要查一次文件列表
            if (task.failedCount > 0 && type == 'SHARE_SAVE') {
                const targetFolderId = batchTaskDto.targetFolderId;
                const fileList = await this.getAllFolderFiles(cloud189, {
                    enableSystemProxy: false,
                    realFolderId: targetFolderId
                });
                //  当前转存的文件列表为taskInfos 需反序列化
                const taskInfos = JSON.parse(batchTaskDto.taskInfos);
                // fileList和taskInfos进行对比 拿到不在fileList中的文件
                const conflictFiles = taskInfos.filter(taskInfo => {
                    return !fileList.some(file => file.md5 === taskInfo.md5);
                });
                if (conflictFiles.length > 0) {
                    // 打印日志
                    logTaskEvent(`任务编号: ${task.taskId}, 任务状态: ${task.taskStatus}, 有${conflictFiles.length}个文件冲突, 已忽略: ${conflictFiles.map(file => file.fileName).join(',')}`, 'info', 'transfer');
                    // 加入和谐文件中
                    harmonizedFilter.addHarmonizedList(conflictFiles.map(file => file.md5))
                }
            }
            return true;
        }
        // 如果status == 2 说明有冲突
        if (taskStatus === 2) {
            const conflictTaskInfo = await cloud189.getConflictTaskInfo(taskId, batchTaskDto);
            if (!conflictTaskInfo) {
                return await this._checkBatchTaskFilesExist(cloud189, batchTaskDto);
            }
            // 忽略冲突
            const taskInfos = conflictTaskInfo.taskInfos;
            for (const taskInfo of taskInfos) {
                taskInfo.dealWay = 1;
            }
            await cloud189.manageBatchTask(taskId, conflictTaskInfo.targetFolderId, taskInfos, batchTaskDto);
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            return await this.checkTaskStatus(cloud189, taskId, count + 1, batchTaskDto, taskStatus, 0)
        }
        return await this._checkBatchTaskFilesExist(cloud189, batchTaskDto);
    }

    // 执行所有任务
    async processAllTasks(ignore = false, taskIds = []) {
        const tasks = await this.getPendingTasks(ignore, taskIds);
        if (tasks.length === 0) {
            logTaskEvent('没有待处理的任务', 'info', 'transfer');
            return;
        }
        let saveResults = []
        logTaskEvent(`================================`, 'info', 'transfer');
        for (const task of tasks) {
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始执行`, 'info', 'transfer');
            try {
                const result = await this.processTask(task);
            if (result) {
                saveResults.push(result)
            }
            } catch (error) {
                logTaskEvent(`任务${task.id}执行失败: ${error.message}`, 'error', 'transfer');
            }finally {
                logTaskEvent(`任务[${taskName}]执行完成`, 'info', 'transfer');
            }
            // 暂停500ms
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (saveResults.length > 0) {
            this.messageUtil.sendMessage(saveResults.join("\n\n"))
        }
        logTaskEvent(`================================`, 'info', 'transfer');
        return saveResults
    }
    // 处理匹配模式
    _handleMatchMode(task, file) {
        if (!task.matchPattern || !task.matchValue) {
            return true;
        } 
        const matchPattern = task.matchPattern;
        const matchOperator = task.matchOperator; // lt eq gt
        const matchValue = task.matchValue;
        const regex = new RegExp(matchPattern);
        // 根据正则表达式提取文件名中匹配上的值 然后根据matchOperator判断是否匹配
        const match = file.name.match(regex);
        if (match) {
            const matchResult = match[0];
            const values = this._handleMatchValue(matchOperator, matchResult, matchValue);
            if (matchOperator === 'lt' && values[0] < values[1]) {
                return true;
            }
            if (matchOperator === 'eq' && values[0] === values[1]) {
                return true;
            }
            if (matchOperator === 'gt' && values[0] > values[1]) {
                return true;
            }
            if (matchOperator === 'contains' && matchResult.includes(matchValue)) {
                return true;
            }
            if (matchOperator === 'notContains' && !matchResult.includes(matchValue)) {
                return true;
            }
        }
        return false;
    }

    // 根据matchOperator判断值是否要转换为数字
    _handleMatchValue(matchOperator, matchResult, matchValue) {    
        if (matchOperator === 'lt' || matchOperator === 'gt') {
            return [parseFloat(matchResult), parseFloat(matchValue)];
        }
        return [matchResult, matchValue];
    }

    // 任务失败处理逻辑
    async _handleTaskFailure(task, error) {
        logTaskEvent(error, 'error', 'transfer');
        const maxRetries = ConfigService.getConfigValue('task.maxRetries');
        let retryInterval = ConfigService.getConfigValue('task.retryInterval');
        
        // 如果是流量超限错误，增加重试间隔（至少600秒）
        const isTrafficLimit = /UserDayFlowOverLimited|data flow is out|FlowOverLimited|流量超限/i.test(error.message);
        if (isTrafficLimit) {
            retryInterval = Math.max(retryInterval, 600);
            logTaskEvent(`检测到流量超限，将增加重试间隔至 ${retryInterval} 秒`, 'warn', 'transfer');
        }

        // 初始化重试次数
        if (!task.retryCount) {
            task.retryCount = 0;
        }
        
        const errorMsg = error.message || String(error);

        if (task.retryCount < maxRetries) {
            task.retryCount++;
            await this._syncTaskDetailRecordsWithActualFiles(task);
            task.status = 'pending';
            task.lastError = `${errorMsg} (重试 ${task.retryCount}/${maxRetries})`;
            // 设置下次重试时间
            task.nextRetryTime = new Date(Date.now() + retryInterval * 1000);
            
            const retryLog = `任务将在 ${retryInterval} 秒后重试 (${task.retryCount}/${maxRetries})`;
            logTaskEvent(retryLog, 'info', 'transfer');

            // 推送失败重试日志
            const pushMsg = `❌ 任务执行失败: ${task.resourceName}\n原因: ${errorMsg}\n状态: ${retryLog}`;
            this.messageUtil.sendMessage(pushMsg).catch(e => console.error('推送失败:', e));
        } else {
            // 在最终标记失败前，二次确认目标文件是否已存在（防止假失败）
            try {
                const isActuallySuccess = await this._verifyIfFilesActuallyExist(task);
                if (isActuallySuccess) {
                    await this._syncTaskDetailRecordsWithActualFiles(task);
                    task.status = 'completed';
                    task.lastError = `检测到文件已实际全部落盘，自动修正状态 (原错误: ${errorMsg})`;
                    logTaskEvent(`任务[${task.resourceName}]物理校验成功，自动从 FAILED 修正为 COMPLETED`, 'info', 'transfer');
                    await this.taskRepo.save(task);
                    
                    const pushMsg = `✅ 任务状态已自动修正: ${task.resourceName}\n检测到文件已实际全部落盘，状态已由失败修正为完成。`;
                    this.messageUtil.sendMessage(pushMsg).catch(e => {});
                    return '';
                }
            } catch (verifyErr) {
                logTaskEvent(`状态二次确认过程异常: ${verifyErr.message}`, 'warn', 'transfer');
            }

            await this._syncTaskDetailRecordsWithActualFiles(task);
            task.status = 'failed';
            task.lastError = `${errorMsg} (已达到最大重试次数 ${maxRetries})`;
            logTaskEvent(`任务达到最大重试次数 ${maxRetries}，标记为失败`, 'error', 'transfer');

            // 推送最终失败日志
            const pushMsg = `🚨 任务彻底失败: ${task.resourceName}\n原因: ${errorMsg}\n已重试 ${maxRetries} 次，停止重试。`;
            this.messageUtil.sendMessage(pushMsg).catch(e => console.error('推送失败:', e));
        }
        
        await this.taskRepo.save(task);
        return '';
    }

     // 获取需要重试的任务
     async getRetryTasks() {
        const now = new Date();
        return await this.taskRepo.find({
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
            where: {
                status: 'pending',
                nextRetryTime: LessThan(now),
                retryCount: LessThan(ConfigService.getConfigValue('task.maxRetries')),
                enableSystemProxy: IsNull()
            }
        });
    }

    // 处理重试任务
    async processRetryTasks() {
        const retryTasks = await this.getRetryTasks();
        if (retryTasks.length === 0) {
            return [];
        }
        let saveResults = [];
        logTaskEvent(`================================`, 'info', 'transfer');
        for (const task of retryTasks) {
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始重试`, 'info', 'transfer');
            try {
                const result = await this.processTask(task);
                if (result) {
                    saveResults.push(result);
                }
            } catch (error) {
                console.error(`重试任务${task.name}执行失败:`, error);
            }finally {
                logTaskEvent(`任务[${taskName}]重试完成`, 'info', 'transfer');
            }
            // 任务间隔
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (saveResults.length > 0) {
            this.messageUtil.sendMessage(saveResults.join("\n\n"));
        }
        logTaskEvent(`================================`, 'info', 'transfer');
        return saveResults;
    }
    // 创建批量任务
    async createBatchTask(cloud189, batchTaskDto) {
        const resp = await cloud189.createBatchTask(batchTaskDto);
        if (!resp) {
            throw new Error('批量任务处理失败');
        }
        if (resp.res_code != 0) {
            const error = new Error(resp.res_msg || '批量任务处理失败');
            error.code = resp.res_code;
            error.response = resp;
            throw error;
        }
        logTaskEvent(`批量任务处理中: ${JSON.stringify(resp)}`, 'info', 'transfer')
        if (!await this.checkTaskStatus(cloud189,resp.taskId, 0 , batchTaskDto)) {
            throw new Error('检查批量任务状态: 批量任务处理失败');
        }
        logTaskEvent(`批量任务处理完成`, 'info', 'transfer')
    }
    // 定时清空回收站
    async clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const accounts = await this.accountRepo.find()
        if (accounts) {
            for (const account of accounts) {
                let username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                try {
                    const cloud189 = Cloud189Service.getInstance(account); 
                    await this._clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle)
                } catch (error) {
                    logTaskEvent(`定时[${username}]清空回收站任务执行失败:${error.message}`, 'error', 'transfer');
                }
            }
        }
    }

    async cleanupLazyTransferredFiles() {
        const enabled = ConfigService.getConfigValue('task.enableAutoCleanLazyFiles');
        const retentionHours = Number(ConfigService.getConfigValue('task.lazyFileRetentionHours'));
        if (!enabled) {
            return [];
        }
        if (!Number.isFinite(retentionHours) || retentionHours <= 0) {
            logTaskEvent('自动清理懒转存文件已跳过: 保留时长配置无效', 'warn', 'transfer');
            return [];
        }

        const tasks = await this.taskRepo.find({
            where: {
                enableLazyStrm: true
            },
        });
        if (!tasks.length) {
            return [];
        }

        const cutoffTime = Date.now() - retentionHours * 60 * 60 * 1000;
        const messages = [];
        logTaskEvent(`开始自动清理懒转存文件, 保留时长: ${retentionHours} 小时, 任务数: ${tasks.length}`, 'info', 'transfer');

        for (const task of tasks) {
            try {
                const result = await this._cleanupLazyTransferredFilesByTask(task, cutoffTime);
                if (result) {
                    messages.push(result);
                }
            } catch (error) {
                logTaskEvent(`任务[${task.resourceName}]自动清理懒转存文件失败: ${error.message}`, 'error', 'transfer');
            }
        }

        if (messages.length > 0) {
            this.messageUtil.sendMessage(messages.join('\n\n'));
        }
        return messages;
    }

    async _cleanupLazyTransferredFilesByTask(task, cutoffTime) {
        if (!task?.enableLazyStrm || !task?.realFolderId) {
            return '';
        }
        const account = await this._getAccountById(task.accountId);
        if (!account) {
            throw new Error('账号不存在');
        }
        task.account = account;
        const cloud189 = Cloud189Service.getInstance(account);
        const allFiles = await this.getAllFolderFiles(cloud189, task);
        if (!allFiles.length) {
            return '';
        }

        const expiredFiles = allFiles.filter(file => this._isLazyTransferredFileExpired(file, cutoffTime));
        if (!expiredFiles.length) {
            return '';
        }

        await this.deleteCloudFile(cloud189, expiredFiles, 0);
        await this._cleanupEmptyLazyFolders(cloud189, task.realFolderId, true);
        const taskName = task.shareFolderName ? `${task.resourceName}/${task.shareFolderName}` : task.resourceName;
        const message = `任务[${taskName}]自动清理懒转存文件 ${expiredFiles.length} 个`;
        logTaskEvent(message, 'info', 'transfer');
        return message;
    }

    _isLazyTransferredFileExpired(file, cutoffTime) {
        const timeValue = file.lastOpTime || file.lastUpdateTime || file.updateTime || file.createTime;
        if (!timeValue) {
            return false;
        }
        const fileTime = new Date(timeValue).getTime();
        if (Number.isNaN(fileTime)) {
            return false;
        }
        return fileTime < cutoffTime;
    }

    async _cleanupEmptyLazyFolders(cloud189, folderId, preserveCurrent = false) {
        const folderInfo = await cloud189.listFiles(folderId);
        if (!folderInfo?.fileListAO) {
            return false;
        }

        const folders = folderInfo.fileListAO.folderList || [];
        for (const folder of folders) {
            await this._cleanupEmptyLazyFolders(cloud189, folder.id, false);
        }

        const refreshedInfo = await cloud189.listFiles(folderId);
        if (!refreshedInfo?.fileListAO) {
            return false;
        }
        const hasFiles = (refreshedInfo.fileListAO.fileList || []).length > 0;
        const hasFolders = (refreshedInfo.fileListAO.folderList || []).length > 0;
        if (!preserveCurrent && !hasFiles && !hasFolders) {
            await this.deleteCloudFile(cloud189, { id: folderId, name: '' }, 1);
            return true;
        }
        return false;
    }

    // 执行清空回收站
    async _clearRecycleBin(cloud189, username, enableAutoClearRecycle, enableAutoClearFamilyRecycle) {
        const params = {
            taskInfos: '[]',
            type: 'EMPTY_RECYCLE',
        }   
        const batchTaskDto = new BatchTaskDto(params);
        if (enableAutoClearRecycle) {
            logTaskEvent(`开始清空[${username}]个人回收站`, 'info', 'transfer')
            await this.createBatchTask(cloud189, batchTaskDto)
            logTaskEvent(`清空[${username}]个人回收站完成`, 'info', 'transfer')
            // 延迟10秒
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
        if (enableAutoClearFamilyRecycle) {
            // 获取家庭id
            const familyInfo = await cloud189.getFamilyInfo()
            if (familyInfo == null) {
                logTaskEvent(`用户${username}没有家庭主账号, 跳过`, 'warn', 'transfer')
                return
            }
            logTaskEvent(`开始清空[${username}]家庭回收站`, 'info', 'transfer')
            batchTaskDto.familyId = familyInfo.familyId
            await this.createBatchTask(cloud189, batchTaskDto)
            logTaskEvent(`清空[${username}]家庭回收站完成`, 'info', 'transfer')
        }
    }
    // 校验文件后缀
    _checkFileSuffix(file,enableOnlySaveMedia, mediaSuffixs) {
        if (CasService.isCasFile(file.name)) {
            return true;
        }
        // 获取文件后缀
        const fileExt = '.' + file.name.split('.').pop().toLowerCase();
        const isMedia = mediaSuffixs.includes(fileExt)
        // 如果启用了只保存媒体文件, 则检查文件后缀是否在配置中
        if (enableOnlySaveMedia && !isMedia) {
            return false
        }
        return true
    }
    // 根据realRootFolderId获取根目录
    async getRootFolder(task) {
        if (task.realRootFolderId) {
            // 判断realRootFolderId下是否还有其他目录, 通过任务查询 查询realRootFolderId是否有多个任务, 如果存在多个 则使用realFolderId
            const tasks = await this.taskRepo.find({
                where: {
                    realRootFolderId: task.realRootFolderId
                }
            })
            if (tasks.length > 1) {
                return {id: task.realFolderId, name: task.realFolderName}    
            }
            return {id: task.realRootFolderId, name: task.shareFolderName}
        }
        logTaskEvent(`任务[${task.resourceName}]为老版本系统创建, 无法删除网盘内容, 跳过`, 'warn', 'transfer')
        return null
    }
    // 删除网盘文件
    async deleteCloudFile(cloud189, file, isFolder) {
        if (!file) return;
        const taskInfos = []
        // 如果file是数组, 则遍历删除
        if (Array.isArray(file)) {
            for (const f of file) {
                taskInfos.push({
                    fileId: f.id,
                    fileName: f.name,
                    isFolder: isFolder
                })
            }
        }else{
            taskInfos.push({
                fileId: file.id,
                fileName: file.name,
                isFolder: isFolder
            })
        }
        console.log(taskInfos)
        
        const batchTaskDto = new BatchTaskDto({
            taskInfos: JSON.stringify(taskInfos),
            type: 'DELETE',
            targetFolderId: ''
        });
        await this.createBatchTask(cloud189, batchTaskDto)
    }

    // 移动网盘文件
    async moveCloudFile(cloud189, file, targetFolderId) {
        if (!file) return;
        if (!targetFolderId) {
            throw new Error('目标目录不能为空');
        }
        const taskInfos = [];
        if (Array.isArray(file)) {
            for (const f of file) {
                taskInfos.push({
                    fileId: f.id,
                    fileName: f.name,
                    isFolder: f.isFolder ? 1 : 0
                });
            }
        } else {
            taskInfos.push({
                fileId: file.id,
                fileName: file.name,
                isFolder: file.isFolder ? 1 : 0
            });
        }

        const batchTaskDto = new BatchTaskDto({
            taskInfos: JSON.stringify(taskInfos),
            type: 'MOVE',
            targetFolderId
        });
        await this.createBatchTask(cloud189, batchTaskDto);
    }

    // 根据任务创建STRM文件
    async createStrmFileByTask(taskIds, overwrite) {
        const tasks = await this.taskRepo.find({
            where: {
                id: In(taskIds)
            },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            },
        })
        if (tasks.length == 0) {
            throw new Error('任务不存在')
        }
        for (const task of tasks) {
            try {
                await this._createStrmFileByTask(task, overwrite)   
            }catch (error) {
                logTaskEvent(`任务[${task.resourceName}]生成strm失败: ${error.message}`, 'error', 'transfer')
            }
        }
    }
    // 根据任务执行生成strm
    async _createStrmFileByTask(task, overwrite) {
        if (!task) {
            throw new Error('任务不存在')
        }
        let account = await this._getAccountById(task.accountId)
        if (!account) {
            logTaskEvent(`任务[${task.resourceName}]账号不存在, 跳过`, 'warn', 'transfer')
            return
        }
        task.account = account;
        if (task.enableLazyStrm) {
            const fileList = await this.getLazyStrmFilesByTask(task);
            if (fileList.length == 0) {
                throw new Error('分享目录中没有可生成懒转存STRM的媒体文件');
            }
            const lazyShareStrmService = new LazyShareStrmService(this.accountRepo, this);
            const message = await lazyShareStrmService.generateFromTask(task, fileList, overwrite);
            this.messageUtil.sendMessage(message);
            return;
        }
        const cloud189 = Cloud189Service.getInstance(account);
        // 获取文件列表
        const fileList = await this.getAllFolderFiles(cloud189, task)
        if (fileList.length == 0) {
            throw new Error('文件列表为空')
        }
        const strmService = new StrmService()
        const message = await strmService.generate(task, fileList, overwrite);
        this.messageUtil.sendMessage(message);
    }
    // 根据accountId获取账号
    async _getAccountById(accountId) {
        return await this.accountRepo.findOne({
            where: {
                id: accountId
            }
        })
    }

    // 根据分享链接获取文件目录组合 资源名 资源名/子目录1 资源名/子目录2
    async parseShareFolderByShareLink(shareLink, accountId, accessCode) {
        const account = await this._getAccountById(accountId)
        if (!account) {
            throw new Error('账号不存在')
        }
        const cloud189 = Cloud189Service.getInstance(account);
        const shareCode = cloud189Utils.parseShareCode(shareLink)
        const shareInfo = await this.getShareInfo(cloud189, shareCode)
        if (shareInfo.shareMode == 1) {
            if (!accessCode) {
                throw new Error('分享链接为私密链接, 请输入提取码')
            }
            // 校验访问码是否有效
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, accessCode);
            if (!accessCodeResponse) {
                throw new Error('校验访问码失败');
            }
            if (!accessCodeResponse.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        const folders = []
        // 根目录为分享链接的名称
        folders.push({id: -1 ,name: shareInfo.fileName})
        if (!shareInfo.isFolder) {
            return folders;
        }
        // 遍历分享链接的目录
        const result = await cloud189.listShareDir(shareInfo.shareId, shareInfo.fileId, shareInfo.shareMode, accessCode);
        if (!result?.fileListAO) return folders;
        const { folderList: subFolders = [] } = result.fileListAO;
        subFolders.forEach(folder => {
            folders.push({id: folder.id, name: path.join(shareInfo.fileName, folder.name)});
        });
        return folders;
    }

    // 校验目录是否在目录列表中
    checkFolderInList(taskDto, folderId) {
        if (!taskDto.selectedFolders || taskDto.selectedFolders.length === 0) return true;
        if (taskDto.tgbot) return true;
        // 统一转字符串比较, 避免前端传数字 -1 与后端字符串 '-1' 不匹配
        const target = String(folderId);
        return taskDto.selectedFolders.some(id => String(id) === target);
    }

    // 校验云盘中是否存在同名目录
    async checkFolderExists(cloud189, targetFolderId, folderName, overwriteFolder = false) {
        const folderInfo = await cloud189.listFiles(targetFolderId);
        if (!folderInfo) {
            throw new Error('获取文件列表失败: 云盘接口无返回');
        }
        if (!folderInfo.fileListAO) {
            const errorMessage = folderInfo.res_msg || folderInfo.res_message || folderInfo.errorMsg || folderInfo.errorCode || '未知错误';
            throw new Error(`获取文件列表失败: ${errorMessage}`);
        }

        // 检查目标文件夹是否存在
        const { folderList = [] } = folderInfo.fileListAO;
        const existFolder = folderList.find(folder => folder.name === folderName);
        if (existFolder) {
            if (!overwriteFolder) {
                throw new Error('folder already exists');
            }
            // 如果用户需要覆盖, 则删除目标目录
            await this.deleteCloudFile(cloud189, existFolder, 1)
        }
    }

    // 根据id获取任务
    async getTaskById(id) {
        return await this.taskRepo.findOne({
            where: { id: parseInt(id) },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    localStrmPrefix: true,
                    cloudStrmPrefix: true,
                    embyPathReplace: true
                }
            }
        });
    }
    // ai命名处理
    async handleAiRename(files, resourceInfo) {
        const template = resourceInfo.type === 'movie' 
        ? ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}'  // 电影模板
        : ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}';  // 剧集模板
        const aiNames = Array.isArray(resourceInfo?.episode) ? resourceInfo.episode : [];
        const newFiles = [];
        for (const file of files) {
            try {
                const aiFile = aiNames.find(f => f.id === file.id);
                if (!aiFile) {
                    continue;
                }
                const newName = this._generateFileName(file, aiFile, resourceInfo, template);
                // 判断文件名是否已存在
                if (file.name === newName) {
                    continue;   
                }
                newFiles.push({
                    ...file,
                    fileId: file.id,
                    oldName: file.name,
                    destFileName: newName
                });
            } catch (error) {
                logTaskEvent(`${file.name}AI重命名处理失败: ${error.message}`, 'error', 'transfer');
            }
        }
        return newFiles;
    }
    // 根据布隆过滤器判断是否被和谐
    isHarmonized(file) {
        // 检查资源是否被和谐
        if (harmonizedFilter.isHarmonized(file.md5)) {
            logTaskEvent(`文件 ${file.name} 被和谐`, 'info', 'transfer');
            return true;
        }    
        return false
    }

    // 根据文件id批量删除文件
    async deleteFiles(taskId, files) {
        const task = await this.getTaskById(taskId)
        if (!task) {
            throw new Error('任务不存在')
        }
        const strmService = new StrmService()
        const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        let strmList = []
        strmList = files.map(file => path.join(folderName, file.relativeDir || '', file.name));
        // 判断是否启用了系统代理
        if (task.enableSystemProxy) {
            // 代理文件
        }else{
            // 删除网盘文件
            const cloud189 = Cloud189Service.getInstance(task.account);
            await this.deleteCloudFile(cloud189,files, 0);
            await this.refreshAlistCache(task)
        }
        for (const strm of strmList) {
            // 删除strm文件
            await strmService.delete(path.join(task.account.localStrmPrefix, strm));
        }
    }

    // 根据任务刷新Alist缓存
    async refreshAlistCache(task, firstExecution = false) {
        try{
            if (ConfigService.getConfigValue('alist.enable') && !task.enableSystemProxy && task.account.cloudStrmPrefix) {
                const pathParts = task.realFolderName.split('/');
                let alistPath = pathParts.slice(1).join('/');
                let currentPath = task.account.cloudStrmPrefix.includes('/d/') 
                    ? task.account.cloudStrmPrefix.split('/d/')[1] 
                    : path.basename(task.account.cloudStrmPrefix);
                let refreshPath = "";
                // 首次执行任务需要刷新所有目录缓存
                if (firstExecution) {
                    alistPath = pathParts.slice(1, -1).join('/');
                    const taskName = task.resourceName;
                    // 替换alistPath中的taskName为空, 然后去掉最后一个/
                    alistPath = alistPath.replace(taskName, '').replace(/\/$/, '');
                    refreshPath = path.join(currentPath, alistPath);
                } else {
                    // 非首次只刷新当前目录
                    refreshPath = path.join(currentPath, alistPath);
                }
                logTaskEvent(`刷新alist目录缓存: ${refreshPath}`, 'info', 'transfer');
                await alistService.listFiles(refreshPath);
            }
        }catch (error) {
            logTaskEvent(`刷新Alist缓存失败: ${error.message}`, 'error', 'transfer');
        }
    }

    // 根据task获取文件列表
    async getFilesByTask(task) {
        if (task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        }
        const cloud189 = Cloud189Service.getInstance(task.account);
        return await this.getAllFolderFiles(cloud189, task)
    }

    async getLazyStrmFilesByTask(task) {
        const account = task.account || await this._getAccountById(task.accountId);
        if (!account) {
            throw new Error('账号不存在');
        }
        task.account = account;
        const cloud189 = Cloud189Service.getInstance(account);
        const shareDir = await cloud189.listShareDir(task.shareId, task.shareFolderId, task.shareMode, task.accessCode, task.isFolder);
        if (shareDir?.res_code == 'ShareAuditWaiting') {
            throw new Error('分享链接审核中, 请稍后重试');
        }
        if (!shareDir?.fileListAO?.fileList) {
            throw new Error('获取分享目录失败');
        }
        return await this._getLazyStrmFiles(task, [...shareDir.fileListAO.fileList]);
    }

    /**
     * 手动修复任务状态：基于物理文件扫描，强行同步子记录与主任务状态。
     */
    async repairTaskStatus(taskId) {
        const task = await this.getTaskById(taskId);
        if (!task) throw new Error('任务不存在');

        logTaskEvent(`[强制修复] 开始物理校准任务: ${task.resourceName} (${taskId})`, 'info', 'transfer');

        const account = task.account || await this.accountRepo.findOneBy({ id: task.accountId });
        const cloud189 = Cloud189Service.getInstance(account);

        // 1. 获取目标目录物理文件状况
        const folderFiles = await this.getAllFolderFiles(cloud189, task);
        const existingMD5s = new Set(folderFiles.map(f => String(f.md5 || '').toUpperCase()));
        const existingNames = new Set(folderFiles.map(f => f.name));

        // 2. 获取分享源文件，用于比对
        const shareDir = await cloud189.listShareDir(task.shareId, task.shareFolderId, task.shareMode, task.accessCode, task.isFolder);
        const shareFiles = (shareDir?.fileListAO?.fileList || []).filter(f => !f.isFolder);

        // 3. 同步子记录 (Detail) - 该方法已包含对 .cas/restoreName 的多重匹配
        const repairedCount = await this._syncTaskDetailRecordsWithActualFiles(task);

        // 4. 重新读取修复后的子记录进行统计
        const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
        const records = await taskProcessedFileRepo.find({ where: { taskId: task.id } });
        
        const successStatuses = new Set(['done', 'completed', 'success']);
        const doneRecords = records.filter(r => successStatuses.has(r.status));
        const failedRecords = records.filter(r => r.status === 'failed');
        const missingFiles = [];

        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(s => s.toLowerCase());
        const enableOnlySaveMedia = this._shouldOnlySaveMedia(task);
        const requiredShareFiles = shareFiles.filter(sFile =>
            this._checkFileSuffix(sFile, enableOnlySaveMedia, mediaSuffixs) &&
            !this.isHarmonized(sFile)
        );

        for (const sFile of requiredShareFiles) {
            const fileMd5 = String(sFile.md5 || '').toUpperCase();
            const originalName = CasService.isCasFile(sFile.name) ? CasService.getOriginalFileName(sFile.name) : sFile.name;
            
            const isFound = (fileMd5.length > 20 && existingMD5s.has(fileMd5)) || 
                            existingNames.has(originalName) || 
                            existingNames.has(sFile.name);

            if (!isFound) {
                missingFiles.push(originalName);
            }
        }

        // 5. 如果物理确认全部存在，修正主任务状态
        let mainStatusUpdated = false;
        if (missingFiles.length === 0 && requiredShareFiles.length > 0) {
            task.status = 'completed';
            task.lastError = '通过手动修复成功物理校准状态';
            await this.taskRepo.save(task);
            mainStatusUpdated = true;
        }

        return {
            taskId: task.id,
            resourceName: task.resourceName,
            repairedCount: repairedCount,
            doneCount: doneRecords.length,
            totalCount: records.length,
            failedCount: failedRecords.length,
            failedList: failedRecords.map(r => r.sourceFileName),
            missingCount: missingFiles.length,
            missingFiles,
            status: mainStatusUpdated ? 'SUCCESS_FIXED' : 'PARTIAL_FIXED'
        };
    }

    /**
     * 根据目标目录真实的物理文件，同步修正任务子记录（转存详情）状态。
     * "MD5结果优先"：只要目标 MD5 已存在，子记录就必须从 failed/pending 修正为 done。
     */
    async _syncTaskDetailRecordsWithActualFiles(task) {
        try {
            const account = task.account || await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) return 0;
            const cloud189 = Cloud189Service.getInstance(account);

            // 1. 获取目标目录物理文件并建立 MD5 集合 (真理来源)
            const folderFiles = await this.getAllFolderFiles(cloud189, task);
            const targetMd5Set = new Set(
                folderFiles
                    .map(f => String(f.md5 || '').toUpperCase())
                    .filter(m => m && m.length > 20)
            );
            const targetNameSet = new Set(folderFiles.map(f => f.name));

            // 2. 读取所有非完成状态的子记录 (包括 failed 和 processing)
            const taskProcessedFileRepo = this._getTaskProcessedFileRepo();
            const records = await taskProcessedFileRepo.find({ where: { taskId: task.id } });
            
            let updatedCount = 0;
            for (const record of records) {
                // 如果已经是成功状态，跳过
                if (['done', 'completed', 'success', 'deduped'].includes(record.status)) continue;

                const recordMd5 = String(record.sourceMd5 || '').toUpperCase();
                const sourceName = record.sourceFileName || '';
                const originalName = CasService.isCasFile(sourceName) ? CasService.getOriginalFileName(sourceName) : sourceName;
                const restoreName = record.restoredFileName || originalName;

                let found = false;
                // A. 物理 MD5 匹配 (第一优先级)
                if (recordMd5 && recordMd5.length > 20 && targetMd5Set.has(recordMd5)) {
                    found = true;
                } 
                // B. 物理文件名匹配 (第二优先级)
                else if (targetNameSet.has(restoreName) || targetNameSet.has(originalName) || targetNameSet.has(sourceName.replace('.cas', ''))) {
                    found = true;
                }

                if (found) {
                    record.status = 'done';
                    record.lastError = null;
                    await taskProcessedFileRepo.save(record);
                    updatedCount++;
                }
            }

            if (updatedCount > 0) {
                logTaskEvent(`[物理同步] 任务[${task.resourceName}]通过 MD5/文件名校准修正了 ${updatedCount} 条记录`, 'info', 'transfer');
                // 同步主任务进度
                await this.syncTaskProgressFromProcessedRecords([task]);
            }
            return updatedCount;
        } catch (e) {
            logTaskEvent(`同步子记录状态异常: ${e.message}`, 'warn', 'transfer');
            return 0;
        }
    }

    /**
     * 在标记失败前，通过扫描云盘目录二次确认文件是否真的不存在。
     * 只有当所有要求的媒体文件都已物理落盘（MD5匹配或还原名匹配）时，才返回 true。
     */
    async _verifyIfFilesActuallyExist(task) {
        try {
            const account = task.account || await this.accountRepo.findOneBy({ id: task.accountId });
            if (!account) return false;
            const cloud189 = Cloud189Service.getInstance(account);
            
            // 1. 获取分享源文件列表，确定“应该”有哪些文件
            const shareDir = await cloud189.listShareDir(task.shareId, task.shareFolderId, task.shareMode, task.accessCode, task.isFolder);
            const shareFiles = shareDir?.fileListAO?.fileList || [];
            if (shareFiles.length === 0) return false;

            // 2. 扫描目标目录真实存储状况
            const folderFiles = await this.getAllFolderFiles(cloud189, task);
            const existingMD5s = new Set(folderFiles.map(f => String(f.md5 || '').toUpperCase()));
            const existingNames = new Set(folderFiles.map(f => f.name));

            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(s => s.toLowerCase());
            const enableOnlySaveMedia = this._shouldOnlySaveMedia(task);

            // 3. 筛选出本次任务“要求”转存的媒体文件
            const requiredFiles = shareFiles.filter(file => 
                !file.isFolder && 
                this._checkFileSuffix(file, enableOnlySaveMedia, mediaSuffixs) &&
                !this.isHarmonized(file)
            );

            if (requiredFiles.length === 0) return false;

            // 4. 严格逐一比对：任何一个文件缺失即判定为不完整
            for (const file of requiredFiles) {
                const fileMd5 = String(file.md5 || '').toUpperCase();
                const originalName = CasService.isCasFile(file.name) ? CasService.getOriginalFileName(file.name) : file.name;
                
                let found = false;
                // A. 优先 MD5 校验 (强标准)
                if (fileMd5.length > 20 && existingMD5s.has(fileMd5)) {
                    found = true;
                } 
                // B. 次选还原后的文件名校验
                else if (existingNames.has(originalName)) {
                    found = true;
                }
                
                // 如果以上标准都不满足，说明该文件未落盘
                if (!found) {
                    return false;
                }
            }

            return true; // 只有全部应转存文件都已存在，才允许 Completed
        } catch (e) {
            logTaskEvent(`二次校验逻辑执行异常: ${e.message}`, 'warn', 'transfer');
            return false;
        }
    }
}

module.exports = { TaskService };
