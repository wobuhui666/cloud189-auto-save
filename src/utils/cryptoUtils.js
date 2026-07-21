const crypto = require('crypto');

class CryptoUtils {
    static _getKey() {
        const raw = process.env.ENCRYPTION_KEY;
        if (!raw || !String(raw).trim()) {
            throw new Error('ENCRYPTION_KEY is required (no default secret)');
        }
        // 支持 32 字节 hex，或任意字符串经 sha256 派生为 32 字节
        const trimmed = String(raw).trim();
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
            return Buffer.from(trimmed, 'hex');
        }
        return crypto.createHash('sha256').update(trimmed).digest();
    }

    static encryptIds(taskId, fileId) {
        const key = CryptoUtils._getKey();
        const iv = crypto.randomBytes(16);
        const data = `${taskId}:${fileId}`;
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString('hex')}:${encrypted}`;
    }

    static decryptIds(encrypted) {
        const key = CryptoUtils._getKey();
        const [ivHex, payload] = String(encrypted || '').split(':');
        if (!ivHex || !payload) {
            throw new Error('Invalid encrypted payload');
        }
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(payload, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        const [taskId, fileId] = decrypted.split(':');
        return { taskId, fileId };
    }
}

module.exports = CryptoUtils;
