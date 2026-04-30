const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { MessageUtil } = require('./message');

class SchedulerService {
    static taskJobs = new Map();
    static messageUtil = new MessageUtil();

    static async initTaskJobs(taskRepo, taskService) {
        // 初始化所有启用定时任务的任务
        const tasks = await taskRepo.find({ where: { enableCron: true } });
        tasks.forEach(task => {
            this.saveTaskJob(task, taskService);
        });

        logTaskEvent("初始化系统定时任务...")
        // 初始化系统定时任务
        // 1. 默认定时任务检查 默认19-23点执行一次
        let taskCheckCrons = ConfigService.getConfigValue('task.taskCheckCron')
        if (taskCheckCrons) {
            // 根据|分割
            taskCheckCrons = taskCheckCrons.split('|');
            // 遍历每个cron表达式
            taskCheckCrons.forEach((cronExpression, index) => {
                this.saveDefaultTaskJob(`任务定时检查-${index}`, cronExpression, async () => {
                    taskService.processAllTasks();
                });
            });
        }
        
        // 2. 重试任务检查 默认每分钟执行一次
        this.saveDefaultTaskJob('重试任务检查', '*/1 * * * *', async () => {
            await taskService.processRetryTasks();
        });
        // 3. 清空回收站 默认每8小时执行一次
        const enableAutoClearRecycle = ConfigService.getConfigValue('task.enableAutoClearRecycle');
        const enableAutoClearFamilyRecycle = ConfigService.getConfigValue('task.enableAutoClearFamilyRecycle');
        if (enableAutoClearRecycle || enableAutoClearFamilyRecycle) {
            this.saveDefaultTaskJob('自动清空回收站',  ConfigService.getConfigValue('task.cleanRecycleCron'), async () => {
                await taskService.clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle);
            })   
        }
        // 4. 定时清理懒转存文件
        const enableAutoCleanLazyFiles = ConfigService.getConfigValue('task.enableAutoCleanLazyFiles');
        if (enableAutoCleanLazyFiles) {
            this.saveDefaultTaskJob('自动清理懒转存文件', ConfigService.getConfigValue('task.lazyFileCleanupCron'), async () => {
                await taskService.cleanupLazyTransferredFiles();
            });
        }

        // 5. PT 订阅相关
        try {
            const { ptService } = require('./ptService');
            const ptPollCron = ConfigService.getConfigValue('pt.pollCron');
            if (ptPollCron) {
                this.saveDefaultTaskJob('PT-轮询', ptPollCron, async () => {
                    try { await ptService.runPoll(); } catch (err) { logTaskEvent(`[PT] 轮询失败: ${err.message || err}`); }
                });
            }
            this.saveDefaultTaskJob('PT-处理', '*/2 * * * *', async () => {
                try { await ptService.runProcessing(); } catch (err) { logTaskEvent(`[PT] 处理失败: ${err.message || err}`); }
            });
            const ptCleanupEnabled = ConfigService.getConfigValue('pt.cleanupEnabled', true);
            const ptCleanupCron = ConfigService.getConfigValue('pt.cleanupCron');
            if (ptCleanupEnabled && ptCleanupCron) {
                this.saveDefaultTaskJob('PT-清理', ptCleanupCron, async () => {
                    try { await ptService.runCleanup(); } catch (err) { logTaskEvent(`[PT] 清理失败: ${err.message || err}`); }
                });
            }
        } catch (err) {
            logTaskEvent(`[PT] 初始化定时任务失败: ${err.message || err}`);
        }
    }

    static async initStrmConfigJobs(strmConfigRepo, strmConfigService) {
        const configs = await strmConfigRepo.find({ where: { enableCron: true, enabled: true } });
        configs.forEach(config => {
            this.refreshStrmConfigJob(config, strmConfigService);
        });
    }

    static saveTaskJob(task, taskService) {
        if (this.taskJobs.has(task.id)) {
            this.taskJobs.get(task.id).stop();
        }
        const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
        // 校验表达式是否有效
        if (!cron.validate(task.cronExpression)) {
            logTaskEvent(`定时任务[${taskName}]表达式无效，跳过...`);
            return;
        }
        if (task.enableCron && task.cronExpression) {
            logTaskEvent(`创建定时任务 ${taskName}, 表达式: ${task.cronExpression}`)
            const job = cron.schedule(task.cronExpression, async () => {
                logTaskEvent(`================================`);
                logTaskEvent(`任务[${taskName}]自定义定时检查...`);
                // 重新获取最新的任务信息
                const latestTask = await taskService.getTaskById(task.id);
                if (!latestTask) {
                    logTaskEvent(`任务[${taskName}]已被删除，跳过执行`);
                    this.removeTaskJob(task.id);
                    return;
                }
                const result = await taskService.processTask(latestTask);
                if (result) {
                    this.messageUtil.sendMessage(result, { level: 'success' });
                }
                logTaskEvent(`================================`);
            });
            this.taskJobs.set(task.id, job);
            logTaskEvent(`定时任务 ${taskName}, 表达式: ${task.cronExpression} 已设置`)
        }
    }

    // 内置定时任务
    static saveDefaultTaskJob(name, cronExpression, task) {
        if (this.taskJobs.has(name)) {
            this.taskJobs.get(name).stop();
        }
        // 校验表达式是否有效
        if (!cron.validate(cronExpression)) {
            logTaskEvent(`定时任务[${name}]表达式无效，跳过...`);
            return;
        }
        const job = cron.schedule(cronExpression, task);
        this.taskJobs.set(name, job);
        logTaskEvent(`定时任务 ${name}, 表达式: ${cronExpression} 已设置`)
        return job;
    }

    static removeTaskJob(taskId) {
        if (this.taskJobs.has(taskId)) {
            this.taskJobs.get(taskId).stop();
            this.taskJobs.delete(taskId);
            logTaskEvent(`定时任务[${taskId}]已移除`);
        }
    }

    static refreshStrmConfigJob(config, strmConfigService) {
        const jobId = `strm-config-${config.id}`;
        this.removeTaskJob(jobId);
        if (!config.enableCron || !config.enabled || !config.cronExpression) {
            return;
        }
        if (!cron.validate(config.cronExpression)) {
            logTaskEvent(`STRM配置[${config.name}] Cron 无效，跳过设置`);
            return;
        }
        const job = cron.schedule(config.cronExpression, async () => {
            logTaskEvent(`STRM配置[${config.name}]开始定时执行`);
            try {
                await strmConfigService.runConfig(config.id);
            } catch (error) {
                logTaskEvent(`STRM配置[${config.name}]执行失败: ${error.message}`);
            }
        });
        this.taskJobs.set(jobId, job);
        logTaskEvent(`STRM配置[${config.name}]定时任务已设置: ${config.cronExpression}`);
    }

    // 处理默认定时任务配置
    static handleScheduleTasks(settings,taskService) {
        // 如果定时任务和清空回收站任务与配置文件不一致, 则修改定时任务
        if (settings.task.taskCheckCron && settings.task.taskCheckCron != ConfigService.getConfigValue('task.taskCheckCron')) {
            let taskCheckCrons = settings.task.taskCheckCron.split('|');
            // 遍历每个cron表达式
            taskCheckCrons.forEach((cronExpression, index) => {
                this.saveDefaultTaskJob(`任务定时检查-${index}`, cronExpression, async () => {
                    taskService.processAllTasks();
                });
            });
        }
        // 处理定时任务配置
        const handleScheduleTask = (currentEnabled, newEnabled, currentCron, newCron, jobName, taskFn) => {
            if (!currentEnabled && newEnabled && newCron) {
                // 情况1: 当前未开启 -> 开启
                this.saveDefaultTaskJob(jobName, newCron, taskFn);
            } else if (currentEnabled && newEnabled && currentCron !== newCron) {
                // 情况2: 当前开启 -> 开启，但cron不同
                this.saveDefaultTaskJob(jobName, newCron, taskFn);
            } else if (!newEnabled) {
                // 情况3: 提交为关闭
                this.removeTaskJob(jobName);
            }
        };
        const currentCron = ConfigService.getConfigValue('task.cleanRecycleCron');
        const enableAutoClearRecycle = settings.task.enableAutoClearRecycle
        const enableAutoClearFamilyRecycle = settings.task.enableAutoClearFamilyRecycle
        // 处理普通回收站任务
        handleScheduleTask(
            ConfigService.getConfigValue('task.enableAutoClearRecycle'),
            enableAutoClearRecycle || enableAutoClearFamilyRecycle,
            currentCron,
            settings.task.cleanRecycleCron,
            '自动清空回收站',
            async () => taskService.clearRecycleBin(enableAutoClearRecycle, enableAutoClearFamilyRecycle)
        );
        handleScheduleTask(
            ConfigService.getConfigValue('task.enableAutoCleanLazyFiles'),
            settings.task.enableAutoCleanLazyFiles,
            ConfigService.getConfigValue('task.lazyFileCleanupCron'),
            settings.task.lazyFileCleanupCron,
            '自动清理懒转存文件',
            async () => taskService.cleanupLazyTransferredFiles()
        );

        // PT 相关 cron 变更
        if (settings.pt) {
            const { ptService } = require('./ptService');
            const ptPollCronCurrent = ConfigService.getConfigValue('pt.pollCron');
            if (settings.pt.pollCron && settings.pt.pollCron !== ptPollCronCurrent) {
                this.saveDefaultTaskJob('PT-轮询', settings.pt.pollCron, async () => {
                    try { await ptService.runPoll(); } catch (err) { logTaskEvent(`[PT] 轮询失败: ${err.message || err}`); }
                });
            }
            const ptCleanupEnabledCurrent = !!ConfigService.getConfigValue('pt.cleanupEnabled', true);
            const ptCleanupCronCurrent = ConfigService.getConfigValue('pt.cleanupCron');
            handleScheduleTask(
                ptCleanupEnabledCurrent,
                !!settings.pt.cleanupEnabled,
                ptCleanupCronCurrent,
                settings.pt.cleanupCron,
                'PT-清理',
                async () => ptService.runCleanup()
            );
            // 下载客户端配置变更后清掉客户端缓存
            try {
                const { resetDownloader } = require('./downloader');
                resetDownloader();
            } catch (_) {}
        }
        return true;
    }
}

module.exports = { SchedulerService };
