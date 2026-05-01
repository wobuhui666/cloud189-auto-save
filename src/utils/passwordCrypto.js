const crypto = require('crypto');

class PasswordCrypto {
    /**
     * 获取加密密钥
     * 优先从环境变量读取，否则从配置文件读取或生成
     */
    static getEncryptionKey() {
        if (process.env.PASSWORD_ENCRYPTION_KEY) {
            return Buffer.from(process.env.PASSWORD_ENCRYPTION_KEY, 'hex');
        }
        // 返回 null，需要从配置文件读取
        return null;
    }

    /**
     * 生成随机加密密钥
     */
    static generateKey() {
        return crypto.randomBytes(32);
    }

    /**
     * 加密密码
     * @param {string} password - 明文密码
     * @param {Buffer} key - 32字节加密密钥
     * @returns {string} - 格式: iv:encrypted (hex)
     */
    static encrypt(password, key) {
        if (!password) return '';

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

        let encrypted = cipher.update(password, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        return `${iv.toString('hex')}:${encrypted}`;
    }

    /**
     * 解密密码
     * @param {string} encryptedData - 格式: iv:encrypted (hex)
     * @param {Buffer} key - 32字节加密密钥
     * @returns {string} - 明文密码
     */
    static decrypt(encryptedData, key) {
        if (!encryptedData) return '';

        const [ivHex, encrypted] = encryptedData.split(':');
        const iv = Buffer.from(ivHex, 'hex');

        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }

    /**
     * 检查密码是否已加密
     * @param {string} password - 密码字符串
     * @returns {boolean} - 是否已加密
     */
    static isEncrypted(password) {
        if (!password) return false;
        // 检查格式是否为 iv:encrypted (两个hex字符串用冒号分隔)
        const parts = password.split(':');
        return parts.length === 2 && /^[0-9a-f]+$/.test(parts[0]) && /^[0-9a-f]+$/.test(parts[1]);
    }
}

module.exports = PasswordCrypto;
