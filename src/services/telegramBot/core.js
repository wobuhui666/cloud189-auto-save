/**
 * TelegramBotService 核心类
 * 保留构造函数、start、stop —— 命令/回调委托给 router
 */
const TelegramBot = require('node-telegram-bot-api');
const { AppDataSource } = require('../../database');
const { Task, Account, CommonFolder, Subscription } = require('../../entities');
const { TaskService } = require('../task');
const { EmbyService } = require('../emby');
const { Cloud189Service } = require('../cloud189');
const { TMDBService } = require('../tmdb');
const { AutoSeriesService } = require('../autoSeries');
const { LazyShareStrmService } = require('../lazyShareStrm');
const { default: cloudSaverSDK } = require('../../sdk/cloudsaver/sdk');
const ProxyUtil = require('../../utils/ProxyUtil');
const cloud189Utils = require('../../utils/Cloud189Utils');
const path = require('path');
const { logTaskEvent } = require('../../utils/logUtils');

const { SessionStore } = require('./session');
const { isAllowed, isAdmin } = require('./auth');
const { registerCommands } = require('./router');

class TelegramBotService {
    constructor(token, chatId, botConfig = {}) {
        this.token = token;
        this.chatId = chatId;
        // 完整 bot 配置（含白名单）
        this.botConfig = {
            chatId,
            allowedChatIds: botConfig.allowedChatIds || [],
            adminChatIds: botConfig.adminChatIds || [],
        };

        this.bot = null;
        this.accountRepo = AppDataSource.getRepository(Account);
        this.commonFolderRepo = AppDataSource.getRepository(CommonFolder);
        this.taskRepo = AppDataSource.getRepository(Task);
        this.taskService = new TaskService(this.taskRepo, this.accountRepo);
        this.lazyShareStrmService = new LazyShareStrmService(this.accountRepo, this.taskService);
        this.autoSeriesService = new AutoSeriesService(this.taskService, this.accountRepo, this.lazyShareStrmService);
        this.cloudSaverSdk = cloudSaverSDK;
        this.tmdbService = new TMDBService();
        this.cloud189Utils = cloud189Utils;
        this.Cloud189Service = Cloud189Service;
        this.EmbyService = EmbyService;
        this.path = path;

        // 会话状态（per-chatId）
        this.sessionStore = new SessionStore();

        // 订阅仓库（可选，仅在需要时查询）
        try {
            this.subscriptionRepo = AppDataSource.getRepository(Subscription);
        } catch {
            this.subscriptionRepo = null;
        }
    }

    async start() {
        if (this.bot) {
            return;
        }

        // 代理
        const proxy = ProxyUtil.getProxy('telegram');
        this.bot = new TelegramBot(this.token, {
            polling: true,
            request: {
                proxy: proxy,
                agentOptions: {
                    keepAlive: true,
                    family: 4,
                    timeout: 30000,
                },
                timeout: 30000,
                forever: true,
                retries: 3,
            },
        });

        // 错误处理
        this.bot.on('polling_error', (error) => {
            console.error('Telegram Bot polling error:', error.message);
            logTaskEvent(`Telegram Bot polling error: ${error.message}`).catch(() => {});
        });
        this.bot.on('error', (error) => {
            console.error('Telegram Bot error:', error.message);
            logTaskEvent(`Telegram Bot error: ${error.message}`).catch(() => {});
        });

        // 设置命令菜单
        await this.bot.setMyCommands([
            { command: 'start', description: '首次使用引导' },
            { command: 'help', description: '帮助信息' },
            { command: 'search_cs', description: '搜索CloudSaver资源' },
            { command: 'pt_search', description: '搜索PT站点资源' },
            { command: 'series', description: '自动追剧(正常任务)' },
            { command: 'lazy_series', description: '自动追剧(懒转存STRM)' },
            { command: 'accounts', description: '账号列表' },
            { command: 'tasks', description: '任务列表' },
            { command: 'execute_all', description: '执行所有任务' },
            { command: 'fl', description: '常用目录列表' },
            { command: 'fs', description: '添加常用目录' },
            { command: 'stats', description: '系统统计' },
            { command: 'detail', description: '任务详情' },
            { command: 'logs', description: '查看日志' },
            { command: 'subs', description: '订阅列表' },
            { command: 'cancel', description: '取消当前操作' },
        ]);

        // 加载默认账号
        const account = await this.accountRepo.findOne({
            where: { tgBotActive: true },
        });
        if (account) {
            // 为默认 chatId 设置默认账号
            const session = this.sessionStore.get(this.chatId);
            session.account.id = account.id;
            session.account.entity = account;
        }

        // 注册所有命令和回调
        registerCommands(this);

        // 启动会话清理
        this.sessionStore.startCleanup();

        return true;
    }

    async stop() {
        if (!this.bot) {
            return;
        }
        try {
            await this.bot.stopPolling();
            this.bot = null;
            this.sessionStore.clearAll();
            this.sessionStore.stopCleanup();
            return true;
        } catch (error) {
            console.error('停止机器人失败:', error);
            return false;
        }
    }

    /**
     * 校验 chatId 是否被允许
     */
    checkChatId(chatId) {
        return isAllowed(chatId, this.botConfig);
    }

    /**
     * 校验 chatId 是否具有管理员权限
     */
    checkAdmin(chatId) {
        return isAdmin(chatId, this.botConfig);
    }

    /**
     * 校验当前会话是否有选中账号
     */
    checkAccount(chatId) {
        const session = this.sessionStore.get(chatId);
        return !!session.account.id;
    }

    /**
     * 获取会话中的脱敏用户名
     */
    getSessionUsername(chatId) {
        const session = this.sessionStore.get(chatId);
        const { desensitizeUsername } = require('./templates');
        return desensitizeUsername(session.account.entity?.username);
    }
}

module.exports = { TelegramBotService };
