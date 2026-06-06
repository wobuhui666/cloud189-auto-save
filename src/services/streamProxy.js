const crypto = require('crypto');
const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');

class StreamProxyService {
    constructor(accountRepo) {
        this.accountRepo = accountRepo || null;
        this.cache = new Map();
        this.cacheTtlMs = 60 * 1000;
    }

    _getSecret() {
        let secret = ConfigService.getConfigValue('system.streamProxySecret');
        if (!secret) {
            secret = crypto.randomBytes(32).toString('hex');
            ConfigService.setConfigValue('system.streamProxySecret', secret);
        }
        return secret;
    }

    _encodePayload(payload) {
        return Buffer.from(JSON.stringify(payload)).toString('base64url');
    }

    _decodePayload(payload) {
        return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    }

    _sign(encodedPayload) {
        return crypto.createHmac('sha256', this._getSecret()).update(encodedPayload).digest('base64url');
    }

    _safeCompare(left, right) {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);
        if (leftBuffer.length !== rightBuffer.length) {
            return false;
        }
        return crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }

    buildToken(payload) {
        const normalizedPayload = {
            v: 1,
            type: payload.type || 'subscription',
            accountId: Number(payload.accountId),
            fileId: String(payload.fileId),
            shareId: payload.shareId ? String(payload.shareId) : '',
            fileName: payload.fileName ? String(payload.fileName) : '',
            targetFolderId: payload.targetFolderId ? String(payload.targetFolderId) : '',
            rootName: payload.rootName ? String(payload.rootName) : '',
            relativeDir: payload.relativeDir ? String(payload.relativeDir) : '',
            isCas: !!payload.isCas,
            originalFileName: payload.originalFileName ? String(payload.originalFileName) : ''
        };
        const encodedPayload = this._encodePayload(normalizedPayload);
        return `${encodedPayload}.${this._sign(encodedPayload)}`;
    }

    parseToken(token) {
        const normalizedToken = String(token || '').replace(/\s+/g, '');
        const [encodedPayload, signature] = normalizedToken.split('.');
        if (!encodedPayload || !signature) {
            throw new Error('播放令牌格式无效');
        }
        const expectedSignature = this._sign(encodedPayload);
        if (!this._safeCompare(signature, expectedSignature)) {
            throw new Error('播放令牌签名无效');
        }
        return this._decodePayload(encodedPayload);
    }

    getBaseUrl() {
        const configuredBaseUrl = (ConfigService.getConfigValue('system.baseUrl') || process.env.PUBLIC_BASE_URL || '').trim();
        if (configuredBaseUrl) {
            const normalizedBaseUrl = /^https?:\/\//.test(configuredBaseUrl)
                ? configuredBaseUrl
                : `http://${configuredBaseUrl}`;
            return normalizedBaseUrl.replace(/\/+$/g, '');
        }
        const port = process.env.PORT || 3000;
        return `http://127.0.0.1:${port}`;
    }

    buildStreamUrl(payload) {
        const token = this.buildToken(payload);
        return `${this.getBaseUrl()}/api/stream/${token}`;
    }

    _getCacheKey(payload) {
        return `${payload.accountId}:${payload.shareId || 'direct'}:${payload.fileId}`;
    }

    async resolveLatestUrl(token) {
        const payload = this.parseToken(token);
        return this.resolveLatestUrlByPayload(payload);
    }

    async resolveLatestUrlByPayload(payload) {
        const cacheKey = this._getCacheKey(payload);
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.url;
        }
        if (!this.accountRepo) {
            throw new Error('播放代理未配置账号仓库');
        }

        const account = await this.accountRepo.findOneBy({ id: Number(payload.accountId) });
        if (!account) {
            throw new Error('播放账号不存在');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const latestUrl = await cloud189.getDownloadLink(payload.fileId, payload.shareId || null);
        if (!latestUrl) {
            throw new Error('未获取到播放直链');
        }

        this.cache.set(cacheKey, {
            url: latestUrl,
            expiresAt: Date.now() + this.cacheTtlMs
        });
        return latestUrl;
    }
}

module.exports = { StreamProxyService };
