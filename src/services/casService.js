const path = require('path');
const crypto = require('crypto');
const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ProxyUtil = require('../utils/ProxyUtil');
const UploadCryptoUtils = require('../utils/UploadCryptoUtils');
const ConfigService = require('./ConfigService');

const CAS_SLICE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_COMMIT_RETRY = 3;
const RSA_KEY_TTL_MS = 5 * 60 * 1000;
const FAMILY_API_BASE = 'https://api.cloud.189.cn';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';

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
        const ext = path.extname(trimmed);
        if (ext && ext !== '.') {
            return trimmed;
        }
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
        if (raw.startsWith('\ufeff')) {
            raw = raw.substring(1);
        }
        if (!raw) {
            throw new Error('CAS文件内容为空');
        }

        // 尝试1: 直接 JSON
        if (raw.startsWith('{') && raw.endsWith('}')) {
            try {
                return CasService._parsePayload(raw);
            } catch (_) {
                // 不是有效 JSON，继续尝试 base64
            }
        }

        // 尝试2: base64 解码
        try {
            const decoded = Buffer.from(raw, 'base64').toString('utf8');
            if (decoded && decoded.trim().startsWith('{')) {
                return CasService._parsePayload(decoded.trim());
            }
        } catch (_) {}

        // 尝试3: 多行逐行解析
        const lines = raw.split(/[\n\r]+/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
            if (line.startsWith('{')) {
                try { return CasService._parsePayload(line); } catch (_) {}
            }
            try {
                const decoded = Buffer.from(line, 'base64').toString('utf8').trim();
                if (decoded.startsWith('{')) {
                    return CasService._parsePayload(decoded);
                }
            } catch (_) {}
        }

        throw new Error('CAS文件解析失败: 无法识别格式');
    }

    static _parsePayload(jsonStr) {
        const p = JSON.parse(jsonStr);
        const md5 = String(p.md5 || p.fileMd5 || '').trim();
        const sliceMd5 = String(p.sliceMd5 || p.slice_md5 || '').trim();
        const info = {
            name: String(p.name || p.fileName || '').trim(),
            size: Number(p.size || p.fileSize || 0) || 0,
            md5,
            sliceMd5,
            createTime: String(p.create_time || p.createTime || '').trim()
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
     * @param {Cloud189Service} cloud189
     * @param {string} fileId
     * @returns {Promise<object>} CAS 信息
     */
    async downloadAndParseCas(cloud189, fileId) {
        const downloadUrl = await cloud189.getFileDownloadUrl(fileId);
        if (!downloadUrl) {
            throw new Error('获取CAS文件下载链接失败');
        }

        const normalizedUrl = String(downloadUrl).replace('http://', 'https://').replace(/&amp;/g, '&');
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
     * 流程参考 OpenList-CAS / 油猴脚本:
     *   initMultiUpload(不带 md5, lazyCheck=1) → checkTransSecond → commitMultiUploadFile
     *
     * 关键点：init 阶段故意不携带 fileMd5/sliceMd5，使用 lazyCheck=1 规避天翼云盘的
     *        md5 黑名单风控（若 init 阶段命中黑名单，commit 会稳定返回 403 InfoSecurityErrorCode）
     *
     * @param {Cloud189Service} cloud189
     * @param {string} parentFolderId
     * @param {object} casInfo { name, size, md5, sliceMd5 }
     * @param {string} restoreName
     * @returns {Promise<object>} { name, size }
     */
    async restoreFromCas(cloud189, parentFolderId, casInfo, restoreName) {
        logTaskEvent(`[CAS秒传] 开始: ${restoreName} 大小=${casInfo.size} md5=${casInfo.md5}`);

        try {
            return await this._restorePersonal(cloud189, parentFolderId, casInfo, restoreName);
        } catch (personalErr) {
            const transitEnabled = ConfigService.getConfigValue('task.enableFamilyTransit', true);
            const shouldFallback = transitEnabled && this._shouldFallbackToFamily(personalErr);
            if (!shouldFallback) {
                throw personalErr;
            }
            logTaskEvent(`[CAS秒传] 个人秒传失败(${personalErr.message || personalErr})，切换家庭中转`);
            return await this._restoreViaFamily(cloud189, parentFolderId, casInfo, restoreName, personalErr);
        }
    }

    // 判断是否应触发家庭中转回退：黑名单/风控/403 情形
    _shouldFallbackToFamily(err) {
        if (!err) return false;
        if (err.isBlacklisted) return true;
        const msg = String(err.message || '');
        if (/InfoSecurityErrorCode|black list|风控|黑名单/i.test(msg)) return true;
        const status = err?.response?.statusCode;
        if (status === 403) return true;
        return false;
    }

    // ==================== 个人秒传 ====================

    async _restorePersonal(cloud189, parentFolderId, casInfo, restoreName) {
        const sessionKey = await cloud189.getSessionKeyForUpload();

        // 1. initMultiUpload（不传 md5，lazyCheck=1）
        const initRes = await this._uploadRequest(cloud189, sessionKey, '/person/initMultiUpload', {
            parentFolderId: String(parentFolderId),
            fileName: encodeURIComponent(restoreName),
            fileSize: String(casInfo.size),
            sliceSize: String(CAS_SLICE_SIZE),
            lazyCheck: '1'
        });

        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error(`CAS秒传初始化失败: 缺少uploadFileId (响应: ${JSON.stringify(initRes).substring(0, 300)})`);
        }

        let fileDataExists = this._jsonGet(initRes, 'data', 'fileDataExists') === 1;

        await this._sleep(500);

        // 2. checkTransSecond（若 init 未命中，再单独探测）
        if (!fileDataExists) {
            const checkRes = await this._uploadRequest(cloud189, sessionKey, '/person/checkTransSecond', {
                fileMd5: casInfo.md5,
                sliceMd5: casInfo.sliceMd5,
                uploadFileId: String(uploadFileId)
            });
            fileDataExists = this._jsonGet(checkRes, 'data', 'fileDataExists') === 1;
        }

        if (!fileDataExists) {
            throw new Error(`CAS秒传失败: 云端不存在该文件数据 (${restoreName})`);
        }

        await this._sleep(500);

        // 3. commitMultiUploadFile（含 403 重试）
        let retry = 0;
        let lastErr;
        while (retry < MAX_COMMIT_RETRY) {
            try {
                await this._uploadRequest(cloud189, sessionKey, '/person/commitMultiUploadFile', {
                    uploadFileId: String(uploadFileId),
                    fileMd5: casInfo.md5,
                    sliceMd5: casInfo.sliceMd5,
                    lazyCheck: '1',
                    opertype: '3'
                });
                logTaskEvent(`[CAS秒传] 成功: ${restoreName}`);
                return { name: restoreName, size: casInfo.size };
            } catch (err) {
                if (err && err.isBlacklisted) throw err;
                lastErr = err;
                retry++;
                const status = err?.response?.statusCode;
                if (status === 403 && retry < MAX_COMMIT_RETRY) {
                    const delay = retry * 2000;
                    logTaskEvent(`[CAS秒传] commit 403，第${retry}次重试，等待${delay}ms`);
                    // 403 时刷新 RSA 密钥
                    this._rsaCache.delete(this._accountKey(cloud189));
                    await this._sleep(delay);
                    continue;
                }
                throw err;
            }
        }
        throw lastErr || new Error('CAS秒传commit失败');
    }

    // ==================== upload.cloud.189.cn 加密请求 ====================

    async _getRsaKeyWithCache(cloud189, sessionKey) {
        const key = this._accountKey(cloud189);
        const cached = this._rsaCache.get(key);
        if (cached && cached.expire > Date.now()) {
            return cached;
        }
        const rsaKey = await UploadCryptoUtils.generateRsaKey(sessionKey);
        // 收紧本地缓存到 5 分钟，避免使用过期密钥
        rsaKey.expire = Math.min(rsaKey.expire, Date.now() + RSA_KEY_TTL_MS);
        this._rsaCache.set(key, rsaKey);
        return rsaKey;
    }

    _accountKey(cloud189) {
        return cloud189?.account?.username || cloud189?.username || 'default';
    }

    /**
     * 封装对 upload.cloud.189.cn 的加密请求
     */
    async _uploadRequest(cloud189, sessionKey, uri, form) {
        const rsaKey = await this._getRsaKeyWithCache(cloud189, sessionKey);
        const { url, headers } = UploadCryptoUtils.buildUploadRequest(form, uri, rsaKey, sessionKey);

        const proxyUrl = ProxyUtil.getProxy('cloud189');
        const requestOptions = {
            method: 'GET',
            headers,
            timeout: { request: 30000 }
        };
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }

        try {
            const response = await got(url, requestOptions).json();
            if (!response || (response.code && response.code !== 'SUCCESS')) {
                const msg = response?.msg || response?.code || 'unknown';
                throw new Error(`CAS上传请求失败 ${uri}: ${msg}`);
            }
            if (response.errorCode) {
                throw new Error(`CAS上传请求失败 ${uri}: ${response.errorMsg || response.errorCode}`);
            }
            return response;
        } catch (err) {
            // 尝试解析 4xx/5xx 响应体，给出清晰错误
            let body = null;
            const rawBody = err?.response?.body;
            if (typeof rawBody === 'string') {
                try { body = JSON.parse(rawBody); } catch (_) {}
                if (!body && (rawBody.includes('black list') || rawBody.includes('InfoSecurityErrorCode'))) {
                    const e = new Error(`CAS秒传被天翼云盘风控拦截(文件MD5黑名单): ${uri}`);
                    e.isBlacklisted = true;
                    throw e;
                }
            }
            if (body && body.code === 'InfoSecurityErrorCode') {
                const e = new Error(`CAS秒传被天翼云盘风控拦截(文件MD5黑名单): ${uri}`);
                e.isBlacklisted = true;
                throw e;
            }
            if (body && (body.code || body.msg)) {
                throw new Error(`CAS上传请求失败 ${uri}: ${body.code || ''} ${body.msg || ''}`.trim());
            }
            throw err;
        }
    }

    _jsonGet(obj, ...keys) {
        let current = obj;
        for (const key of keys) {
            if (current == null || typeof current !== 'object') return undefined;
            current = current[key];
        }
        return current;
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ==================== 家庭中转秒传 ====================

    /**
     * 家庭中转完整流程：
     *   1. 找到账号下的家庭（userRole=1）
     *   2. 家庭秒传 /family/initMultiUpload → checkTransSecond → commitMultiUploadFile
     *   3. 把家庭文件 COPY 到个人目标目录（手动 MD5 签名）
     *   4. 删除家庭中转残留
     */
    async _restoreViaFamily(cloud189, personalFolderId, casInfo, restoreName, personalErr) {
        const familyInfo = await cloud189.getFamilyInfo();
        if (!familyInfo?.familyId) {
            const e = new Error('家庭中转不可用: 当前账号没有家庭组');
            e.cause = personalErr;
            throw e;
        }
        const familyId = String(familyInfo.familyId);
        const familyFolderId = await cloud189.getFamilyRootFolderId(familyId);

        logTaskEvent(`[家庭中转] familyId=${familyId} familyFolderId=${familyFolderId || '(根)'}`);

        // 1. 家庭秒传
        const familyFileId = await this._familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, restoreName);
        if (!familyFileId) {
            throw new Error('家庭中转失败: 未获取到家庭文件ID');
        }

        // 2. 家庭 → 个人目录 COPY
        try {
            await this._copyFamilyFileToPersonal(cloud189, familyId, familyFileId, personalFolderId, familyFolderId, restoreName);
        } catch (copyErr) {
            // COPY 失败尽量清理家庭残留
            await this._safeDeleteFamilyFile(cloud189, familyId, familyFileId, restoreName);
            throw copyErr;
        }

        // 3. 清理家庭残留
        await this._safeDeleteFamilyFile(cloud189, familyId, familyFileId, restoreName);

        logTaskEvent(`[家庭中转] 成功: ${restoreName}`);
        return { name: restoreName, size: casInfo.size };
    }

    async _familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, fileName) {
        const sessionKey = await cloud189.getSessionKeyForUpload();

        // 1. /family/initMultiUpload（lazyCheck=1，不传 md5 规避黑名单）
        const initRes = await this._uploadRequest(cloud189, sessionKey, '/family/initMultiUpload', {
            parentFolderId: String(familyFolderId || ''),
            familyId: String(familyId),
            fileName: encodeURIComponent(fileName),
            fileSize: String(casInfo.size),
            sliceSize: String(CAS_SLICE_SIZE),
            lazyCheck: '1'
        });
        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error(`家庭秒传init失败: 缺少uploadFileId (响应: ${JSON.stringify(initRes).substring(0, 300)})`);
        }
        let fileDataExists = this._jsonGet(initRes, 'data', 'fileDataExists') === 1;

        await this._sleep(500);

        // 2. /family/checkTransSecond
        if (!fileDataExists) {
            const checkRes = await this._uploadRequest(cloud189, sessionKey, '/family/checkTransSecond', {
                fileMd5: String(casInfo.md5),
                sliceMd5: String(casInfo.sliceMd5),
                uploadFileId: String(uploadFileId)
            });
            fileDataExists = this._jsonGet(checkRes, 'data', 'fileDataExists') === 1;
        }
        if (!fileDataExists) {
            throw new Error(`家庭秒传失败: 云端不存在该文件数据 (${fileName})`);
        }

        await this._sleep(500);

        // 3. /family/commitMultiUploadFile（含 403 重试）
        let retry = 0;
        let lastErr;
        let commitRes;
        while (retry < MAX_COMMIT_RETRY) {
            try {
                commitRes = await this._uploadRequest(cloud189, sessionKey, '/family/commitMultiUploadFile', {
                    uploadFileId: String(uploadFileId),
                    fileMd5: String(casInfo.md5),
                    sliceMd5: String(casInfo.sliceMd5),
                    lazyCheck: '1',
                    opertype: '3'
                });
                break;
            } catch (err) {
                lastErr = err;
                retry++;
                const status = err?.response?.statusCode;
                if (status === 403 && retry < MAX_COMMIT_RETRY) {
                    const delay = retry * 2000;
                    logTaskEvent(`[家庭中转] commit 403，第${retry}次重试，等待${delay}ms`);
                    this._rsaCache.delete(this._accountKey(cloud189));
                    await this._sleep(delay);
                    continue;
                }
                throw err;
            }
        }
        if (!commitRes) {
            throw lastErr || new Error('家庭秒传commit失败');
        }

        const familyFileId = this._jsonGet(commitRes, 'file', 'userFileId')
            || this._jsonGet(commitRes, 'file', 'id')
            || this._jsonGet(commitRes, 'data', 'fileId')
            || null;
        if (!familyFileId) {
            throw new Error(`家庭秒传commit响应缺少文件ID: ${JSON.stringify(commitRes).substring(0, 300)}`);
        }
        logTaskEvent(`[家庭中转] 家庭秒传完成, 家庭文件ID=${familyFileId}`);
        return String(familyFileId);
    }

    /**
     * 家庭文件 COPY 到个人空间目录
     * 天翼云盘要求 POST 参数参与签名，SDK 默认只签 URL query，这里手动签名。
     */
    async _copyFamilyFileToPersonal(cloud189, familyId, familyFileId, personalFolderId, familyFolderId, fileName = '') {
        const accessToken = await cloud189.client.getAccessToken();
        if (!accessToken) {
            throw new Error('家庭中转COPY失败: 无法获取AccessToken');
        }

        const formParams = {
            type: 'COPY',
            taskInfos: JSON.stringify([{ fileId: String(familyFileId), fileName: fileName || '', isFolder: 0 }]),
            targetFolderId: String(personalFolderId),
            familyId: String(familyId),
            groupId: 'null',
            copyType: '2',
            shareId: 'null'
        };

        const { timestamp, signature } = this._buildAccessTokenSignature(accessToken, formParams);

        const headers = {
            'Accept': 'application/json;charset=UTF-8',
            'Sign-Type': '1',
            'Signature': signature,
            'Timestamp': timestamp,
            'AccessToken': accessToken,
            'User-Agent': DEFAULT_UA,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        const postBody = Object.entries(formParams)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');

        const requestOptions = {
            method: 'POST',
            headers,
            body: postBody,
            responseType: 'json',
            throwHttpErrors: false,
            timeout: { request: 30000 }
        };
        const proxyUrl = ProxyUtil.getProxy('cloud189');
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }

        const url = `${FAMILY_API_BASE}/open/batch/createBatchTask.action`;
        const response = await got(url, requestOptions);
        const result = response.body || {};

        if (response.statusCode >= 400) {
            throw new Error(`家庭中转COPY失败: HTTP ${response.statusCode} ${result?.res_message || ''}`);
        }
        if (result.res_code !== undefined && result.res_code !== 0) {
            throw new Error(`家庭中转COPY失败: ${result.res_message || result.res_code}`);
        }
        const taskId = result.taskId;
        if (!taskId) {
            throw new Error('家庭中转COPY失败: 缺少taskId');
        }

        logTaskEvent(`[家庭中转] 批量COPY任务已创建, taskId=${taskId}, 等待完成...`);
        await this._waitForBatchTask(cloud189, 'COPY', taskId);
    }

    async _waitForBatchTask(cloud189, type, taskId, maxWaitMs = 30000) {
        const accessTokenInit = await cloud189.client.getAccessToken();
        const start = Date.now();
        let lastStatus = 0;

        while (Date.now() - start < maxWaitMs) {
            await this._sleep(1000);
            const accessToken = accessTokenInit; // accessToken 有效期较长，此处不重复获取
            const checkParams = { type, taskId: String(taskId) };
            const { timestamp, signature } = this._buildAccessTokenSignature(accessToken, checkParams);

            const headers = {
                'Accept': 'application/json;charset=UTF-8',
                'Sign-Type': '1',
                'Signature': signature,
                'Timestamp': timestamp,
                'AccessToken': accessToken,
                'User-Agent': DEFAULT_UA,
                'Content-Type': 'application/x-www-form-urlencoded'
            };
            const postBody = Object.entries(checkParams)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');

            const requestOptions = {
                method: 'POST',
                headers,
                body: postBody,
                responseType: 'json',
                throwHttpErrors: false,
                timeout: { request: 15000 }
            };
            const proxyUrl = ProxyUtil.getProxy('cloud189');
            if (proxyUrl) {
                const { HttpsProxyAgent } = require('https-proxy-agent');
                requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
            }

            const url = `${FAMILY_API_BASE}/open/batch/checkBatchTask.action`;
            const response = await got(url, requestOptions);
            const result = response.body || {};
            lastStatus = result.taskStatus ?? lastStatus;

            if (lastStatus === 4) {
                return;
            }
            if (lastStatus === 2) {
                // 冲突，记录但继续等，由上层覆盖策略处理
                logTaskEvent(`[家庭中转] 批量任务检测到冲突(taskStatus=2), 继续等待...`);
            }
        }
        throw new Error(`家庭中转批量任务超时 taskStatus=${lastStatus}`);
    }

    async _safeDeleteFamilyFile(cloud189, familyId, fileId, fileName = '') {
        try {
            await cloud189.request('/api/open/batch/createBatchTask.action', {
                method: 'POST',
                form: {
                    type: 'DELETE',
                    taskInfos: JSON.stringify([{ fileId: String(fileId), fileName: fileName || '', isFolder: 0 }]),
                    targetFolderId: '',
                    familyId: String(familyId)
                }
            });
            logTaskEvent(`[家庭中转] 已清理家庭残留文件: ${fileName || fileId}`);
        } catch (err) {
            logTaskEvent(`[家庭中转] 清理家庭残留失败(${fileId}): ${err.message}`);
        }
    }

    /**
     * 构建 AccessToken 签名：
     *   AccessToken=xxx&Timestamp=xxx&key1=val1&key2=val2...（按 key 字典序）
     *   MD5 小写
     */
    _buildAccessTokenSignature(accessToken, params) {
        const timestamp = String(Date.now());
        const entries = Object.entries(params || {}).sort((a, b) => a[0].localeCompare(b[0]));
        const items = [`AccessToken=${accessToken}`, `Timestamp=${timestamp}`];
        for (const [k, v] of entries) items.push(`${k}=${v}`);
        const signature = crypto.createHash('md5').update(items.join('&')).digest('hex').toLowerCase();
        return { timestamp, signature };
    }
}

module.exports = { CasService };
