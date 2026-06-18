const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const { MessageUtil } = require('./message');

class SchedulerService {
    static taskJobs = new Map();
    static messageUtil = new MessageUtil();
    static hdhiveCheckinState = {
        date: null,
        scheduledAt: null
    };

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

        // 5. 账号 Session 保活
        const enableSessionKeepAlive = ConfigService.getConfigValue('task.enableSessionKeepAlive');
        const sessionKeepAliveCron = ConfigService.getConfigValue('task.sessionKeepAliveCron');
        if (enableSessionKeepAlive && sessionKeepAliveCron) {
            this.saveDefaultTaskJob('账号Session保活', sessionKeepAliveCron, async () => {
                await taskService.runAccountsKeepAlive();
            });
        }

        // 6. PT 订阅相关
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

        // 7. 影巢自动签到
        try {
            const hdhiveEnabled = ConfigService.getConfigValue('hdhive.enabled');
            const checkinEnabled = ConfigService.getConfigValue('hdhive.checkin.enabled');
            if (hdhiveEnabled && checkinEnabled) {
                this.refreshHdhiveCheckinJob();
            }
        } catch (err) {
            logTaskEvent(`[影巢] 初始化自动签到失败: ${err.message || err}`);
        }
    }

    // 影巢自动签到执行体
    static async runHdhiveCheckin() {
        try {
            const hdhiveSDK = require('../sdk/hdhive/sdk').default;
            const result = await hdhiveSDK.checkinByBridge();
            const message = result.message || (result.success ? '影巢自动签到：签到成功' : `影巢自动签到失败：${result.error || '未知错误'}`);
            logTaskEvent(`[影巢] ${message}`);
            try {
                SchedulerService.messageUtil.sendMessage(message, { level: result.success ? 'success' : 'error' });
            } catch (pushErr) {
                logTaskEvent(`[影巢] 签到结果推送失败: ${pushErr.message || pushErr}`);
            }
            return result;
        } catch (err) {
            logTaskEvent(`[影巢] 自动签到异常: ${err.message || err}`);
            return { success: false, error: err.message || String(err) };
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

    static refreshHdhiveCheckinJob(snapshot = null) {
        const hdhiveEnabled = snapshot?.hdhiveEnabled ?? !!ConfigService.getConfigValue('hdhive.enabled');
        const checkinConfig = snapshot?.checkinConfig || ConfigService.getConfigValue('hdhive.checkin', {}) || {};
        const enabled = hdhiveEnabled && !!checkinConfig.enabled;
        const randomTimeEnabled = checkinConfig.randomTimeEnabled === true;
        const cronExpression = checkinConfig.cron;
        const randomWindowStart = checkinConfig.randomWindowStart;
        const randomWindowEnd = checkinConfig.randomWindowEnd;

        this.removeTaskJob('影巢自动签到');
        this.hdhiveCheckinState = {
            date: null,
            scheduledAt: null
        };

        if (!enabled) {
            return;
        }

        if (randomTimeEnabled) {
            const window = this.getHdhiveRandomWindow(randomWindowStart, randomWindowEnd);
            if (!window) {
                logTaskEvent('[影巢] 自动签到随机时间窗口无效，跳过设置');
                return;
            }
            this.saveDefaultTaskJob('影巢自动签到', '* * * * *', async () => {
                await SchedulerService.runHdhiveCheckinByRandomWindow(window);
            });
            logTaskEvent(`[影巢] 自动签到随机时间已启用，窗口: ${window.startLabel}-${window.endLabel}`);
            return;
        }

        if (!cronExpression) {
            logTaskEvent('[影巢] 自动签到 Cron 为空，跳过设置');
            return;
        }
        this.saveDefaultTaskJob('影巢自动签到', cronExpression, async () => {
            await SchedulerService.runHdhiveCheckin();
        });
    }

    static getTodayDateKey() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    static parseTimeWindowValue(value) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
        if (!match) {
            return null;
        }
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return null;
        }
        return {
            hour,
            minute,
            totalMinutes: hour * 60 + minute
        };
    }

    static getHdhiveRandomWindow(startValue, endValue) {
        const start = this.parseTimeWindowValue(startValue);
        const end = this.parseTimeWindowValue(endValue);
        if (!start || !end || end.totalMinutes < start.totalMinutes) {
            return null;
        }
        return {
            startMinutes: start.totalMinutes,
            endMinutes: end.totalMinutes,
            startLabel: `${String(start.hour).padStart(2, '0')}:${String(start.minute).padStart(2, '0')}`,
            endLabel: `${String(end.hour).padStart(2, '0')}:${String(end.minute).padStart(2, '0')}`
        };
    }

    static createRandomTimeForToday(totalMinutes) {
        const scheduledAt = new Date();
        scheduledAt.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
        return scheduledAt;
    }

    static getOrCreateTodayHdhiveCheckinTime(window) {
        const dateKey = this.getTodayDateKey();
        if (this.hdhiveCheckinState.date === dateKey && this.hdhiveCheckinState.scheduledAt instanceof Date) {
            return this.hdhiveCheckinState.scheduledAt;
        }
        const range = window.endMinutes - window.startMinutes;
        const offset = Math.floor(Math.random() * (range + 1));
        const scheduledAt = this.createRandomTimeForToday(window.startMinutes + offset);
        this.hdhiveCheckinState = {
            date: dateKey,
            scheduledAt
        };
        logTaskEvent(`[影巢] 今日自动签到随机时间: ${scheduledAt.toLocaleString('zh-CN', { hour12: false })}`);
        return scheduledAt;
    }

    static async runHdhiveCheckinByRandomWindow(window) {
        const scheduledAt = this.getOrCreateTodayHdhiveCheckinTime(window);
        const now = new Date();
        if (now < scheduledAt) {
            return { success: false, skipped: true, reason: 'not_due_yet' };
        }
        const result = await this.runHdhiveCheckin();
        this.hdhiveCheckinState = {
            date: this.getTodayDateKey(),
            scheduledAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
        };
        return result;
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
            // 先清理所有旧的"任务定时检查-N"任务，避免新 cron 列表变短时残留
            const stalePattern = /^任务定时检查-\d+$/;
            for (const jobName of [...this.taskJobs.keys()]) {
                if (typeof jobName === 'string' && stalePattern.test(jobName)) {
                    this.removeTaskJob(jobName);
                }
            }
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
        handleScheduleTask(
            ConfigService.getConfigValue('task.enableSessionKeepAlive'),
            settings.task.enableSessionKeepAlive,
            ConfigService.getConfigValue('task.sessionKeepAliveCron'),
            settings.task.sessionKeepAliveCron,
            '账号Session保活',
            async () => taskService.runAccountsKeepAlive()
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

        // 影巢自动签到 cron / 开关变更（注意：本方法在 ConfigService.setConfig 之前调用，getConfigValue 取到的是旧值）
        if (settings.hdhive) {
            const currentCheckin = ConfigService.getConfigValue('hdhive.checkin', {}) || {};
            const nextCheckin = settings.hdhive.checkin || {};
            const currentEnabled = !!ConfigService.getConfigValue('hdhive.enabled') && !!currentCheckin.enabled;
            const nextEnabled = !!settings.hdhive.enabled && !!nextCheckin.enabled;
            const currentRandom = currentCheckin.randomTimeEnabled === true;
            const nextRandom = nextCheckin.randomTimeEnabled === true;
            const currentStart = currentCheckin.randomWindowStart || '';
            const currentEnd = currentCheckin.randomWindowEnd || '';
            const nextStart = nextCheckin.randomWindowStart || '';
            const nextEnd = nextCheckin.randomWindowEnd || '';
            const currentCron = currentCheckin.cron || '';
            const nextCron = nextCheckin.cron || '';
            const shouldRefresh = currentEnabled !== nextEnabled
                || currentRandom !== nextRandom
                || (!nextRandom && currentCron !== nextCron)
                || (nextRandom && (currentStart !== nextStart || currentEnd !== nextEnd));

            if (!nextEnabled) {
                this.removeTaskJob('影巢自动签到');
                this.hdhiveCheckinState = {
                    date: null,
                    scheduledAt: null
                };
            } else if (shouldRefresh) {
                const mergedCheckin = {
                    ...currentCheckin,
                    ...nextCheckin
                };
                this.refreshHdhiveCheckinJob({
                    hdhiveEnabled: !!settings.hdhive.enabled,
                    checkinConfig: mergedCheckin
                });
            }
        }
        return true;
    }
}

module.exports = { SchedulerService };
