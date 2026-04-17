const crypto = require('crypto');
const got = require('got');
const path = require('path');
const { logTaskEvent } = require('../utils/logUtils');
const ProxyUtil = require('../utils/ProxyUtil');

const UPLOAD_BASE_URL = 'https://upload.cloud.189.cn';
const CAS_SLICE_SIZE = 10 * 1024 * 1024; // 10MB

class CasService {
    constructor() {
        this._rsaCache = new Map(); // accountKey -> { pubKey, pkId, expire }
    }

    // ==================== CAS 文件判断与解析 ====================

    /**
     * 判断文件是否为 .cas 文件
     */
    static isCasFile(fileName) {
        return String(fileName || '').toLowerCase().endsWith('.cas');
    }

    /**
     * 从 .cas 文件名推导原始文件名
     * 例如: "S01E01.mkv.cas" -> "S01E01.mkv"
     * 例如: "S01E01.cas" -> "S01E01"（无扩展名，需从 casInfo 补全）
     */
    static getOriginalFileName(casFileName, casInfo = null) {
        const trimmed = String(casFileName || '').replace(/\.cas$/i, '');
        if (!trimmed) {
            return casInfo?.name || casFileName;
        }
        // 检查去掉 .cas 后是否有有效扩展名
        const ext = path.extname(trimmed);
        if (ext && ext !== '.') {
            return trimmed;
        }
        // 没有扩展名，尝试从 casInfo.name 补全
        if (casInfo?.name) {
            const sourceExt = path.extname(casInfo.name);
            if (sourceExt && sourceExt !== '.') {
                return trimmed + sourceExt;
            }
        }
        return trimmed;
    }

    /**
     * 解析 CAS 文件内容（支持 base64 编码和纯 JSON 两种格式）
     * @param {string|Buffer} content - CAS 文件内容
     * @returns {{ name: string, size: number, md5: string, sliceMd5: string, createTime?: string }}
     */
    static parseCasContent(content) {
        let raw = String(content || '').trim();
        // 去掉 BOM
        if (raw.startsWith('\ufeff')) {
            raw = raw.substring(1);
        }
        if (!raw) {
            throw new Error('CAS文件内容为空');
        }

        // 尝试直接解析 JSON
        if (raw.startsWith('{') && raw.endsWith('}')) {
            try {
                return CasService._parsePayload(raw);
            } catch (jsonErr) {
                // 不是有效 JSON，继续尝试 base64
            }
        }

        // 尝试 base64 解码
        try {
            const decoded = Buffer.from(raw, 'base64').toString('utf8');
            return CasService._parsePayload(decoded);
        } catch (err) {
            throw new Error(`CAS文件解析失败: ${err.message}`);
        }
    }

    static _parsePayload(jsonStr) {
        const p = JSON.parse(jsonStr);
        const sliceMd5 = String(p.sliceMd5 || p.slice_md5 || '').trim();
        const info = {
            name: String(p.name || '').trim(),
            size: Number(p.size) || 0,
            md5: String(p.md5 || '').trim(),
            sliceMd5,
            createTime: String(p.create_time || '').trim()
        };
        if (!info.name) throw new Error('CAS缺少文件名');
        if (info.size < 0) throw new Error('CAS文件大小无效');
        if (!info.md5) throw new Error('CAS缺少MD5');
        if (!info.sliceMd5) throw new Error('CAS缺少SliceMD5');
        return info;
    }

    // ==================== CAS 文件下载与解析 ====================

    /**
     * 下载并解析 CAS 文件
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     * @param {string} fileId - CAS 文件ID
     * @returns {Promise<object>} CAS 信息
     */
    async downloadAndParseCas(cloud189, fileId) {
        const downloadUrl = await cloud189.getFileDownloadUrl(fileId);
        if (!downloadUrl) {
            throw new Error('获取CAS文件下载链接失败');
        }

        const normalizedUrl = String(downloadUrl).replace('http://', 'https://');
        const proxyUrl = ProxyUtil.getProxy('cloud189');
        const requestOptions = {
            followRedirect: true,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: { request: 30000 }
        };
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }

        const response = await got(normalizedUrl, requestOptions);
        return CasService.parseCasContent(response.body);
    }

    // ==================== 秒传恢复 ====================

    /**
     * 通过秒传 API 恢复 CAS 文件对应的原始文件
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     * @param {string} parentFolderId - 目标目录ID
     * @param {object} casInfo - CAS 解析信息 { name, size, md5, sliceMd5 }
     * @param {string} restoreName - 恢复后的文件名
     * @returns {Promise<object|null>} 恢复后的文件信息
     */
    async restoreFromCas(cloud189, parentFolderId, casInfo, restoreName) {
        logTaskEvent(`CAS秒传恢复开始: ${restoreName}`);

        const sessionKey = await cloud189.getSessionKeyForUpload();
        const rsaKey = await this._getRsaKeyWithCache(cloud189);

        // 1. initMultiUpload
        const initRes = await this._uploadRequest(cloud189, sessionKey, rsaKey, '/person/initMultiUpload', {
            parentFolderId,
            fileName: encodeURIComponent(restoreName),
            fileSize: String(casInfo.size),
            sliceSize: String(CAS_SLICE_SIZE),
            fileMd5: casInfo.md5,
            sliceMd5: casInfo.sliceMd5
        });

        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error('CAS秒传初始化失败: 缺少uploadFileId');
        }

        let fileDataExists = this._jsonGet(initRes, 'data', 'fileDataExists') === 1;

        // 2. checkTransSecond（如果 initMultiUpload 没有直接命中）
        if (!fileDataExists) {
            const checkRes = await this._uploadRequest(cloud189, sessionKey, rsaKey, '/person/checkTransSecond', {
                fileMd5: casInfo.md5,
                sliceMd5: casInfo.sliceMd5,
                uploadFileId
            });
            fileDataExists = this._jsonGet(checkRes, 'data', 'fileDataExists') === 1;
        }

        if (!fileDataExists) {
            throw new Error(`CAS秒传失败: 云端不存在该文件数据 (${restoreName})`);
        }

        // 3. commitMultiUploadFile
        await this._uploadRequest(cloud189, sessionKey, rsaKey, '/person/commitMultiUploadFile', {
            uploadFileId,
            fileMd5: casInfo.md5,
            sliceMd5: casInfo.sliceMd5,
            lazyCheck: '1',
            opertype: '3'
        });

        logTaskEvent(`CAS秒传恢复成功: ${restoreName}`);
        return { name: restoreName, size: casInfo.size };
    }

    // ==================== upload.cloud.189.cn 加密请求 ====================

    async _getRsaKeyWithCache(cloud189) {
        const key = cloud189.account?.username || 'default';
        const cached = this._rsaCache.get(key);
        if (cached && cached.expire > Date.now()) {
            return cached;
        }
        const rsaKey = await cloud189.getRsaKey();
        this._rsaCache.set(key, rsaKey);
        return rsaKey;
    }

    /**
     * 封装对 upload.cloud.189.cn 的加密请求
     * 参考 OpenList-CAS drivers/189/util.go uploadRequest
     */
    async _uploadRequest(cloud189, sessionKey, rsaKey, uri, form) {
        const timestamp = String(Date.now());
        const requestId = this._randomUUID();
        const encryptionSeed = this._buildEncryptionSeed();

        // AES-ECB 加密参数（仅使用前 16 位作为 AES key）
        const queryString = this._buildQueryString(form);
        const encrypted = this._aesEcbEncrypt(queryString, encryptionSeed.slice(0, 16));
        const params = encrypted.toString('hex');

        // HMAC-SHA1 签名（使用完整 seed）
        const signData = `SessionKey=${sessionKey}&Operate=GET&RequestURI=${uri}&Date=${timestamp}&params=${params}`;
        const signature = this._hmacSha1(signData, encryptionSeed);

        // RSA 加密 seed
        const encryptionText = this._rsaEncrypt(encryptionSeed, rsaKey.pubKey);

        const proxyUrl = ProxyUtil.getProxy('cloud189');
        const requestOptions = {
            method: 'GET',
            headers: {
                'Accept': 'application/json;charset=UTF-8',
                'SessionKey': sessionKey,
                'Signature': signature,
                'X-Request-Date': timestamp,
                'X-Request-ID': requestId,
                'EncryptionText': encryptionText,
                'PkId': rsaKey.pkId
            },
            timeout: { request: 30000 }
        };
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }

        const url = `${UPLOAD_BASE_URL}${uri}?params=${params}`;
        let response;
        try {
            response = await got(url, requestOptions).json();
        } catch (err) {
            // 尝试解析 4xx/5xx 响应体，给出清晰错误（如 InfoSecurityErrorCode）
            let body = null;
            try { body = err.response && JSON.parse(err.response.body); } catch (_) {}
            if (body && body.code === 'InfoSecurityErrorCode') {
                throw new Error(`CAS秒传被天翼云盘风控拦截(文件MD5黑名单): ${uri}`);
            }
            if (body && (body.code || body.msg)) {
                throw new Error(`CAS上传请求失败 ${uri}: ${body.code || ''} ${body.msg || ''}`.trim());
            }
            throw err;
        }

        if (!response || response.code !== 'SUCCESS') {
            const msg = response?.msg || response?.code || 'unknown';
            throw new Error(`CAS上传请求失败 ${uri}: ${msg}`);
        }

        return response;
    }

    // ==================== 加密工具方法 ====================

    /**
     * AES-ECB 加密（PKCS7 填充）
     */
    _aesEcbEncrypt(data, key) {
        const keyBuffer = Buffer.from(key, 'utf8');
        const cipher = crypto.createCipheriv('aes-128-ecb', keyBuffer, null);
        cipher.setAutoPadding(true);
        return Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    }

    /**
     * HMAC-SHA1 签名
     */
    _hmacSha1(data, secret) {
        return crypto.createHmac('sha1', secret).update(data).digest('hex');
    }

    /**
     * RSA 加密（PKCS1 填充，base64 输出）
     */
    _rsaEncrypt(data, pubKey) {
        const publicKey = `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`;
        const encrypted = crypto.publicEncrypt(
            { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(data, 'utf8')
        );
        return encrypted.toString('base64');
    }

    /**
     * 构建查询字符串
     */
    _buildQueryString(form) {
        return Object.entries(form)
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
    }

    _randomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    _randomPattern(pattern) {
        return String(pattern).replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    _buildEncryptionSeed() {
        let seed = this._randomPattern('xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx');
        const extraLength = Math.floor(16 * Math.random());
        return seed.slice(0, 16 + extraLength);
    }

    _jsonGet(obj, ...keys) {
        let current = obj;
        for (const key of keys) {
            if (current == null || typeof current !== 'object') return undefined;
            current = current[key];
        }
        return current;
    }
}

module.exports = { CasService };
