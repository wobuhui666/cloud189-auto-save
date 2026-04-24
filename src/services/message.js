const messageManager = require('./message/MessageManager');
const ConfigService = require('./ConfigService');


class MessageUtil {
    constructor() {
        this._init();
    }

    _init() {
        const settings = ConfigService.getConfig();
        const telegramBotSettings = settings.telegram?.bot || {};
        const telegramEnabled = telegramBotSettings.enable ?? settings.telegram?.enable ?? false;
        const telegramBotToken = telegramBotSettings.botToken || settings.telegram?.botToken || '';
        const telegramChatId = telegramBotSettings.chatId || settings.telegram?.chatId || '';

        messageManager.initialize({
            wework: {
                enabled: settings.wecom?.enable || false,
                webhook: settings.wecom?.webhook || '',
            },
            telegram: {
                enabled: telegramEnabled,
                botToken: telegramBotToken,
                chatId: telegramChatId,
                notifyOnSuccess: settings.telegram?.notifyOnSuccess ?? true,
                notifyOnFailure: settings.telegram?.notifyOnFailure ?? true,
                notifyOnScrape: settings.telegram?.notifyOnScrape ?? false,
                proxy: {
                    type: 'http',
                    host: settings.proxy?.host || '',
                    port: settings.proxy?.port || '',
                    username: settings.proxy?.username || '',
                    password: settings.proxy?.password || ''
                },
                cfProxyDomain: settings.telegram?.proxyDomain || ''
            },
            wxpusher: {
                enabled: settings.wxpusher?.enable || false,
                spt: settings.wxpusher?.spt || ''
            },
            bark: {
                enabled: settings.bark?.enable || false,
                serverUrl: settings.bark?.serverUrl || '',
                key: settings.bark?.key || '',
            },
            pushplus: {
                enabled: settings.pushplus?.enable || false,
                token: settings.pushplus?.token || '',
                topic: settings.pushplus?.topic || '',
                channel: settings.pushplus?.channel || '',
                webhook: settings.pushplus?.webhook || '',
                to: settings.pushplus?.to || '',
            },
            customPush: settings.customPush || []
        });
    }


    async updateConfig() {
        this._init();
    }

    // 发送消息
    async sendMessage(message, options = {}) {
        await messageManager.sendMessage(message, options);
    }
    // 发送刮削消息
    async sendScrapeMessage(message, options = {}) {
        await messageManager.sendScrapeMessage(message, options);
    }
}

module.exports = { MessageUtil };