const { StrmService } = require('./strm');
const { EmbyService } = require('./emby');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { ScrapeService } = require('./ScrapeService');
const { LazyShareStrmService } = require('./lazyShareStrm');
const { OrganizerService } = require('./organizer');
const { auditService } = require('./auditService');

class TaskEventHandler {
    constructor(messageUtil) {
        this.messageUtil = messageUtil;
    }

    async handle(taskCompleteEventDto) {
        if (!taskCompleteEventDto.fileList?.length && !taskCompleteEventDto.task?.keepCasAfterRestore) {
            return;
        }
        const task = taskCompleteEventDto.task;
        logTaskEvent(` ${task.resourceName} 触发事件:`);
        await auditService.event('post_process', '开始任务后处理', {
            phase: 'post_process', data: { fileCount: taskCompleteEventDto.fileList?.length || 0 }
        });
        try {
            await this._handleAutoRename(taskCompleteEventDto);
            await this._handleCasArchive(taskCompleteEventDto);
            await this._handleStrmGeneration(taskCompleteEventDto);
            await this._handleAlistCache(taskCompleteEventDto);
            await this._handleMediaScraping(taskCompleteEventDto);
            this._handleEmbyNotification(taskCompleteEventDto)
        } catch (error) {
            console.error(error);
            logTaskEvent(`任务完成后处理失败: ${error.message}`);
            await auditService.event('post_process_failed', '任务完成后处理失败', {
                phase: 'post_process', level: 'error', error: error.message
            });
        }
        logTaskEvent(`================事件处理完成================`);
    }

    async _handleCasArchive(eventDto) {
        const task = eventDto.task;
        if (!task?.keepCasAfterRestore) {
            return;
        }
        try {
            await auditService.event('cas_archive', '开始 CAS 归档', { phase: 'cas' });
            await eventDto.taskService.archivePendingCasFiles(task, eventDto.cloud189);
        } catch (error) {
            logTaskEvent(`CAS归档失败，等待下次重试: ${error.message}`);
            await auditService.event('cas_archive_failed', 'CAS 归档失败，等待下次重试', {
                phase: 'cas', level: 'error', error: error.message
            });
        }
    }
    async _handleAutoRename(taskCompleteEventDto) {
        try {
            // 懒 STRM：只锁定 layout / 准备 STRM 命名，不移动网盘
            if (taskCompleteEventDto.task?.enableOrganizer) {
                await auditService.event('organizer', '开始媒体识别与整理', { phase: 'organizer' });
                const organizerService = new OrganizerService(taskCompleteEventDto.taskService, taskCompleteEventDto.taskRepo);
                const result = await organizerService.organizeTask(taskCompleteEventDto.task, {
                    triggerStrm: false,
                    organizeCloud: !taskCompleteEventDto.task?.enableLazyStrm
                });
                if (Array.isArray(result?.files) && result.files.length > 0) {
                    taskCompleteEventDto.fileList = result.files;
                }
                return;
            }
            if (taskCompleteEventDto.task?.enableLazyStrm) {
                return;
            }
            const newFiles = await taskCompleteEventDto.taskService.autoRename(taskCompleteEventDto.cloud189, taskCompleteEventDto.task);
            if (newFiles.length > 0) {
                taskCompleteEventDto.fileList = newFiles;
            }
        } catch (error) {
            console.error(error);
            if (taskCompleteEventDto.task?.enableOrganizer) {
                const organizerService = new OrganizerService(taskCompleteEventDto.taskService, taskCompleteEventDto.taskRepo);
                await organizerService.markError(taskCompleteEventDto.task.id, error);
            }
            logTaskEvent(`${taskCompleteEventDto.task?.enableOrganizer ? '整理器' : '自动重命名'}失败: ${error.message}`);
            await auditService.event('organizer_failed', '媒体整理失败', {
                phase: 'organizer', level: 'error', error: error.message
            });
        }
    }

    async _handleStrmGeneration(taskCompleteEventDto) {
        try {
            const {task,taskService, overwriteStrm} = taskCompleteEventDto;
            if (!ConfigService.getConfigValue('strm.enable')) {
                await auditService.recordOperation('skip', 'skipped', { reason: 'STRM 未启用', decisionSource: 'config' });
                return;
            }
            if (task.enableLazyStrm) {
                const lazyShareStrmService = new LazyShareStrmService(taskService.accountRepo, taskService);
                const message = await lazyShareStrmService.generateFromTask(task, taskCompleteEventDto.fileList, overwriteStrm);
                this.messageUtil.sendMessage(message, { level: 'success' });
                return;
            }
            const strmService = new StrmService();
            // 获取文件列表
            const fileList = await taskService.getFilesByTask(task)
            const message = await strmService.generate(task, fileList, overwriteStrm);
            this.messageUtil.sendMessage(message, { level: 'success' });
        } catch (error) {
            console.error(error);
            logTaskEvent(`生成STRM文件失败: ${error.message}`);
            await auditService.event('strm_failed', 'STRM 生成失败', {
                phase: 'strm', level: 'error', error: error.message
            });
        }
    }

    async _handleAlistCache(taskCompleteEventDto) {
        try {
            const {task, taskService, firstExecution} = taskCompleteEventDto;
            await taskService.refreshAlistCache(task, firstExecution)
        } catch (error) {
            console.error(error);
            logTaskEvent(`刷新Alist缓存失败: ${error.message}`);
        }
    }

    async _handleMediaScraping(taskCompleteEventDto) {
        try {
            const {task, taskRepo} = taskCompleteEventDto;
            if (ConfigService.getConfigValue('tmdb.enableScraper') && task?.enableTaskScraper) {
                const strmService = new StrmService();
                const strmPath = strmService.getStrmPath(task);
                if (strmPath) {
                    const scrapeService = new ScrapeService();
                    // 电影合集：从锁定布局读取逐文件 TMDB 数据，逐文件独立刮削
                    let collectionFiles = null;
                    try {
                        const layout = task.libraryLayout ? JSON.parse(task.libraryLayout) : null;
                        if (layout?.mediaType === 'movie' && Array.isArray(layout.files) && layout.files.length > 1) {
                            collectionFiles = layout.files;
                        }
                    } catch (_) {}
                    logTaskEvent(`开始刮削${collectionFiles ? '合集(' + collectionFiles.length + '部)' : ' tmdbId: ' + task.tmdbId}的媒体信息, 路径: ${strmPath}`);
                    const mediaDetails = await scrapeService.scrapeFromDirectory(strmPath, task.tmdbId, collectionFiles);
                    if (mediaDetails?.collection) {
                        // 合集刮削：逐文件独立，不写任务级 tmdbId，推送汇总消息
                        this.messageUtil.sendScrapeMessage({
                            title: `✅ 合集刮削成功：${mediaDetails.scraped} 部`,
                            description: `跳过 ${mediaDetails.skipped} 部（未匹配 TMDB）`,
                            type: 'movie'
                        }, { level: 'scrape' });
                    } else if (mediaDetails) {
                        if (task.tmdbId != mediaDetails.tmdbId) {
                            await taskRepo.update(task.id, {
                                tmdbId: mediaDetails.tmdbId,
                                tmdbContent: JSON.stringify(mediaDetails)
                            });
                        }
                        const shortOverview = mediaDetails.overview ? 
                            (mediaDetails.overview.length > 20 ? mediaDetails.overview.substring(0, 50) + '...' : mediaDetails.overview) : 
                            '暂无';
                        const message = {
                            title: `✅ 刮削成功：${mediaDetails.title}`,
                            image: mediaDetails.backdropPath,
                            description: shortOverview,
                            rating: mediaDetails.voteAverage,
                            type: mediaDetails.type
                        }
                        this.messageUtil.sendScrapeMessage(message, { level: 'scrape' });
                    }
                }
            }
        } catch (error) {
            console.error(error);
            logTaskEvent(`媒体刮削失败: ${error.message}`);
        }
    }

    async _handleEmbyNotification(taskCompleteEventDto) {
        try {
            const {task, taskService} = taskCompleteEventDto;
            if (ConfigService.getConfigValue('emby.enable')) {
                const embyService = new EmbyService(taskService);
                const itemId = await embyService.notify(task);
                await auditService.recordOperation('notify', 'completed', {
                    targetPath: embyService._resolveNotifyPath(task),
                    after: { itemId, fullLibraryRefresh: !itemId },
                    verification: { accepted: true },
                    decisionSource: 'emby'
                });
            }
        } catch (error) {
            console.error(error);
            logTaskEvent(`通知Emby失败: ${error.message}`);
            await auditService.recordOperation('notify', 'failed', {
                reason: 'Emby 入库通知失败', decisionSource: 'emby', error: error.message,
                verification: { accepted: false }
            });
        }
    }
}

module.exports = { TaskEventHandler };
