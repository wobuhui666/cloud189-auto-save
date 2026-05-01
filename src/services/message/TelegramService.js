const got = require('got');
const MessageService = require('./MessageService');
const ProxyUtil = require('../../utils/ProxyUtil');

/**
 * HTML 转义（消息推送专用）
 */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

class TelegramService extends MessageService {
    /**
     * 检查服务是否启用
     * @returns {boolean}
     */
    checkEnabled() {
        return !!(this.config.botToken && this.config.chatId);
    }

    _shouldSendByLevel(level = 'success') {
        if (level === 'failure') {
            return this.config.notifyOnFailure ?? true;
        }
        return this.config.notifyOnSuccess ?? true;
    }
    /**
     * 配置代理信息
     */
    _proxy() {
        return ProxyUtil.getProxyAgent('telegram');
    }


    /**
     * 实际发送消息
     * @param {string} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message, options = {}) {
        try {
            const level = options.level || 'success';
            if (!this._shouldSendByLevel(level)) {
                return false;
            }
            const msg = await this.convertToHtml(message);
            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    text: msg,
                    parse_mode: 'HTML'
                },
                timeout: {
                    request: 5000
                },
                ...this._proxy()
            };

            let apiUrl = 'https://api.telegram.org';
            if (this.config.cfProxyDomain) {
                requestOptions.proxy = false;
                apiUrl = this.config.cfProxyDomain;
            }

            await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
            return true;
        } catch (error) {
            console.error('Telegram消息推送异常:', error);
            return false;
        }
    }
     // 发送刮削结果
     async _sendScrapeMessage(message, options = {}) {
        try {
            if (!(this.config.notifyOnScrape ?? false)) {
                return false;
            }
            const title = escapeHtml(message.title || '刮削结果');
            const typeText = message.type === 'tv' ? '电视剧' : '电影';
            const ratingText = message.rating ? `评分：${message.rating}` : '评分：暂无';
            const descText = message.description
                ? escapeHtml(message.description.split('\n').slice(0, 2).join('\n') +
                    (message.description.split('\n').length > 2 ? '...' : ''))
                : '暂无简介';

            const caption = [
                `🧩 <b>${title}</b>`,
                `\n类型：${typeText}`,
                `\n${ratingText}`,
                `\n${descText}`,
            ].join('');

            const requestOptions = {
                json: {
                    chat_id: this.config.chatId,
                    photo: message.image,
                    caption: caption,
                    parse_mode: 'HTML'
                },
                timeout: {
                    request: 5000
                },
                ...this._proxy()
            };

            let apiUrl = 'https://api.telegram.org';
            if (this.config.cfProxyDomain) {
                requestOptions.proxy = false;
                apiUrl = this.config.cfProxyDomain;
            }

            // 如果有图片则发送图片+描述，否则只发送文本
            if (message.image) {
                await got.post(`${apiUrl}/bot${this.config.botToken}/sendPhoto`, requestOptions).json();
            } else {
                requestOptions.json.text = caption;
                delete requestOptions.json.photo;
                await got.post(`${apiUrl}/bot${this.config.botToken}/sendMessage`, requestOptions).json();
            }
            return true;
        } catch (error) {
            console.error('Telegram消息推送异常:', error);
            return false;
        }
    }
}

module.exports = TelegramService;
