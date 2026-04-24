const { TelegramBotService } = require('../services/telegramBot');
const { logTaskEvent } = require('./logUtils');

class TelegramBotManager {
    static instance = null;
    static bot = null;
    static chatId = null;

    static getInstance() {
        if (!TelegramBotManager.instance) {
            TelegramBotManager.instance = new TelegramBotManager();
        }
        return TelegramBotManager.instance;
    }

    /**
     * 处理 Bot 启停
     * 兼容旧签名: handleBotStatus(botToken, chatId, enable)
     * 新签名: handleBotStatus(botToken, chatId, enable, botConfig)
     * @param {string} botToken
     * @param {string} chatId
     * @param {boolean} enable
     * @param {object} [botConfig] - 可选，完整 bot 配置 { allowedChatIds, adminChatIds }
     */
    async handleBotStatus(botToken, chatId, enable, botConfig = {}) {
        const normalizedBotConfig = {
            allowedChatIds: botConfig.allowedChatIds || [],
            adminChatIds: botConfig.adminChatIds || [],
        };
        const shouldEnableBot = !!(enable && botToken && chatId);
        const botTokenChanged = TelegramBotManager.bot?.token !== botToken;
        const chatIdChanged = TelegramBotManager.bot?.chatId !== chatId;
        const configChanged = JSON.stringify(TelegramBotManager.bot?.botConfig || {}) !== JSON.stringify({
            chatId,
            ...normalizedBotConfig,
        });

        if (TelegramBotManager.bot && (!shouldEnableBot || botTokenChanged || chatIdChanged)) {
            await TelegramBotManager.bot.stop();
            TelegramBotManager.bot = null;
            logTaskEvent(`Telegram机器人已停用`);
        }

        if (shouldEnableBot && (!TelegramBotManager.bot || botTokenChanged || chatIdChanged)) {
            TelegramBotManager.bot = new TelegramBotService(botToken, chatId, normalizedBotConfig);
            TelegramBotManager.bot.start()
            .then(() => {
                logTaskEvent(`Telegram机器人已启动`);
            })
            .catch(error => {
                logTaskEvent(`Telegram机器人启动失败: ${error.message}`);
            });
            return;
        }

        if (shouldEnableBot && TelegramBotManager.bot && configChanged) {
            TelegramBotManager.bot.botConfig = {
                chatId,
                ...normalizedBotConfig,
            };
            logTaskEvent(`Telegram机器人权限配置已更新`);
        }
    }

    getBot() {
        return TelegramBotManager.bot;
    }
}

module.exports = TelegramBotManager;
