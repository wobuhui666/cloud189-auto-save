const { StrmService } = require('./strm');
const { EmbyService } = require('./emby');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { ScrapeService } = require('./ScrapeService');
const { LazyShareStrmService } = require('./lazyShareStrm');
const { OrganizerService } = require('./organizer');

class TaskEventHandler {
    constructor(messageUtil) {
        this.messageUtil = messageUtil;
    }

    async handle(taskCompleteEventDto) {
        if (taskCompleteEventDto.fileList.length === 0) {
            return;
        }
        const task = taskCompleteEventDto.task;
        logTaskEvent(` ${task.resourceName} 触发事件:`);
        try {
            await this._handleAutoRename(taskCompleteEventDto);
            await this._handleStrmGeneration(taskCompleteEventDto);
            await this._handleAlistCache(taskCompleteEventDto);
            await this._handleMediaScraping(taskCompleteEventDto);
            this._handleEmbyNotification(taskCompleteEventDto)
        } catch (error) {
            console.error(error);
            logTaskEvent(`任务完成后处理失败: ${error.message}`);
        }
        logTaskEvent(`================事件处理完成================`);
    }
    async _handleAutoRename(taskCompleteEventDto) {
        try {
            if (taskCompleteEventDto.task?.enableLazyStrm) {
                return;
            }
            if (taskCompleteEventDto.task?.enableOrganizer) {
                const organizerService = new OrganizerService(taskCompleteEventDto.taskService, taskCompleteEventDto.taskRepo);
                const result = await organizerService.organizeTask(taskCompleteEventDto.task, {
                    triggerStrm: false
                });
                if (Array.isArray(result?.files) && result.files.length > 0) {
                    taskCompleteEventDto.fileList = result.files;
                }
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
        }
    }

    async _handleStrmGeneration(taskCompleteEventDto) {
        try {
            const {task,taskService, overwriteStrm} = taskCompleteEventDto;
            if (!ConfigService.getConfigValue('strm.enable')) {
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
                    logTaskEvent(`开始刮削tmdbId: ${task.tmdbId}的媒体信息, 路径: ${strmPath}`);
                    const mediaDetails = await scrapeService.scrapeFromDirectory(strmPath, task.tmdbId);
                    if (mediaDetails) {
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
                await embyService.notify(task);
            }
        } catch (error) {
            console.error(error);
            logTaskEvent(`通知Emby失败: ${error.message}`);
        }
    }
}

module.exports = { TaskEventHandler };
