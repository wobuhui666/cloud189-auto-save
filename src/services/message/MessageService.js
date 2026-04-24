/**
 * 消息推送服务接口基类
 */
class MessageService {
    constructor(config) {
        this.config = config;
        this.enabled = false;
    }

    /**
     * 初始化服务
     */
    initialize() {
        this.enabled = this.checkEnabled();
    }

    /**
     * 检查服务是否启用
     * @returns {boolean}
     */
    checkEnabled() {
        return false;
    }

    /**
     * 发送消息
     * @param {string} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async sendMessage(message, options = {}) {
        if (!this.enabled) {
            return false;
        }
        return await this._send(message, options);
    }

    /**
     * 发送刮削消息
     * @param {object} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async sendScrapeMessage(message, options = {}) {
        if (!this.enabled) {
            return false;
        }
        return await this._sendScrapeMessage(message, options);
    }
    /**
     * 实际发送消息的方法，需要被子类实现
     * @param {string} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async _send(message) {
        throw new Error('_send method must be implemented by subclass');
    }

    /**
     * 实际发送刮削消息的方法，需要被子类实现
     * @param {object} message - 要发送的消息内容
     * @returns {Promise<boolean>} - 发送结果
     */
    async _sendScrapeMessage(message) {
        throw new Error('_sendScrapeMessage method must be implemented by subclass');
    }

    /**
     * 转换消息为 HTML 格式（Telegram 推送用）
     * @param {string} message - 要转换的消息内容
     * @returns {string} - 转换后的消息内容
     */
    async convertToHtml(message) {
        return message
                // 转义 HTML 特殊字符
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                // 加粗标题
                .replace(/^(.*?)更新/gm, '🎉<b>$1</b>更新')
                // 替换引用格式为列表项
                .replace(/&gt;s*/g, '   - ');
    }

    /**
     * 转换消息为标准的 Markdown 格式（非 TG 推送渠道用）
     * @param {string} message - 要转换的消息内容
     * @returns {string} - 转换后的消息内容
     */
    async convertToMarkdown(message) {
        return message
                // 加粗标题
                .replace(/^(.*?)更新/gm, '🎉*$1*更新')
                // 移除 HTML 标签并转换为代码格式
                .replace(/<font color="warning">/g, '`')
                .replace(/<font color="info">/g, '`')
                .replace(/<\/font>/g, '`')
                // 替换引用格式为列表项
                .replace(/>s*/g, '   - ');
    }

}

module.exports = MessageService;