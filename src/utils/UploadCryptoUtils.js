/**
 * 天翼云盘上传 API 加密签名工具
 * 用于秒传等 upload.cloud.189.cn 接口的请求签名
 * 包含: RSA 加密、AES-128-ECB 加密、HMAC-SHA1 签名
 *
 * 加密流程参考 OpenList-CAS 项目:
 * 1. 生成随机字符串 l (16~32位), 取前16字节作为 AES 密钥
 * 2. AES-128-ECB 加密业务参数 → 大写 hex
 * 3. RSA 加密随机字符串 l → base64
 * 4. HMAC-SHA1 签名: SessionKey=xxx&Operate=GET&RequestURI=xxx&Date=xxx&params=xxx → 大写 hex
 */
const crypto = require('crypto');
const got = require('got');
const ProxyUtil = require('./ProxyUtil');

const UPLOAD_URL = 'https://upload.cloud.189.cn';
const WEB_URL = 'https://cloud.189.cn';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';

class UploadCryptoUtils {
    /**
     * 获取上传用 RSA 公钥
     * @param {string} sessionKey 会话密钥
     * @returns {Promise<{pubKey: string, pkId: string, expire: number, ver?: string}>}
     */
    static async generateRsaKey(sessionKey) {
        const ts = Date.now().toString();
        const signParams = { AppKey: '600100422', Timestamp: ts };
        const paramStr = Object.entries(signParams)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        const signature = crypto.createHash('md5').update(paramStr).digest('hex');

        const noCache = Math.random().toString();
        const url = `${WEB_URL}/api/security/generateRsaKey.action?sessionKey=${encodeURIComponent(sessionKey)}&noCache=${noCache}`;

        const proxyUrl = ProxyUtil.getProxy('cloud189');
        const options = {
            headers: {
                'Sign-Type': '1',
                'Signature': signature,
                'Timestamp': ts,
                'AppKey': '600100422',
                'SessionKey': sessionKey,
                'Accept': 'application/json;charset=UTF-8',
                'User-Agent': DEFAULT_UA
            },
            timeout: { request: 15000 }
        };
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            options.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }

        const resp = await got(url, options).json();
        if (resp.errorCode) {
            throw new Error(resp.errorMsg || resp.errorCode);
        }
        if (!resp.pubKey) {
            throw new Error('RSA 密钥无效');
        }

        return {
            pubKey: resp.pubKey,
            pkId: resp.pkId,
            expire: resp.expire ? (Date.now() + Number(resp.expire) * 1000) : (Date.now() + 300000),
            ver: resp.ver
        };
    }

    /**
     * RSA 加密（PKCS1 padding，base64 输出）
     */
    static rsaEncrypt(publicKey, data) {
        const formattedKey = UploadCryptoUtils._formatPublicKey(publicKey);
        const encrypted = crypto.publicEncrypt(
            { key: formattedKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(data, 'utf-8')
        );
        return encrypted.toString('base64');
    }

    /**
     * AES-128-ECB 加密（大写 hex 输出）
     * 密钥取 key 的前 16 字节（128位），与 OpenList-CAS 一致
     */
    static aesEncrypt(data, key) {
        const params = typeof data === 'string'
            ? data
            : Object.entries(data).map(([k, v]) => `${k}=${v}`).join('&');

        const aesKey = Buffer.from(key.substring(0, 16), 'utf-8');
        const cipher = crypto.createCipheriv('aes-128-ecb', aesKey, null);
        let encrypted = cipher.update(params, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted.toUpperCase();
    }

    /**
     * HMAC-SHA1 签名（大写 hex 输出）
     * 签名原文: SessionKey=xxx&Operate=GET&RequestURI=xxx&Date=xxx&params=xxx
     */
    static hmacSha1(signText, key) {
        return crypto.createHmac('sha1', key).update(signText).digest('hex').toUpperCase();
    }

    /**
     * 构建上传请求（签名 + 加密）
     * @param {object|string} params 请求参数
     * @param {string} requestUri 请求路径 (如 /person/initMultiUpload)
     * @param {object} rsaKey RSA 密钥信息 { pubKey, pkId }
     * @param {string} sessionKey 会话密钥
     * @param {string} method HTTP 方法（签名用，默认 GET）
     * @returns {{url: string, headers: object}}
     */
    static buildUploadRequest(params, requestUri, rsaKey, sessionKey, method = 'GET') {
        // 随机字符串 l，长度 16~32 位，与 OpenList-CAS 一致
        const l = UploadCryptoUtils._randomString(16 + Math.floor(Math.random() * 17));
        const ts = Date.now().toString();
        const uuid = UploadCryptoUtils._randomUUID();

        const encryptedParams = UploadCryptoUtils.aesEncrypt(params, l);
        const encryptionText = UploadCryptoUtils.rsaEncrypt(rsaKey.pubKey, l);

        const signText = `SessionKey=${sessionKey}&Operate=${method}&RequestURI=${requestUri}&Date=${ts}&params=${encryptedParams}`;
        const signature = UploadCryptoUtils.hmacSha1(signText, l);

        return {
            url: `${UPLOAD_URL}${requestUri}?params=${encryptedParams}`,
            headers: {
                'Accept': 'application/json;charset=UTF-8',
                'SessionKey': sessionKey,
                'Signature': signature,
                'X-Request-Date': ts,
                'X-Request-ID': uuid,
                'EncryptionText': encryptionText,
                'PkId': rsaKey.pkId,
                'User-Agent': DEFAULT_UA
            }
        };
    }

    static _formatPublicKey(publicKey) {
        if (!publicKey) return publicKey;
        if (publicKey.includes('-----BEGIN PUBLIC KEY-----')) return publicKey;
        return `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`;
    }

    static _randomString(length) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    static _randomUUID() {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        // Node 14 回退
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
}

module.exports = UploadCryptoUtils;
