const path = require('path');
const crypto = require('crypto');
const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ProxyUtil = require('../utils/ProxyUtil');
const UploadCryptoUtils = require('../utils/UploadCryptoUtils');
const ConfigService = require('./ConfigService');
const { CasFileService } = require('./casFileService');
const { CasCleanupService } = require('./casCleanupService');

const CAS_SLICE_SIZE = 10 * 1024 * 1024; // 10MB（默认分片；超大文件自动放大）
const MAX_COMMIT_RETRY = 3;

// 与 OpenList-CAS 189pc 对齐的动态分片策略：
function calcCasSliceSize(fileSize) {
    const DEFAULT = CAS_SLICE_SIZE;
    const size = Number(fileSize) || 0;
    if (size > DEFAULT * 2 * 999) {
        const mult = Math.max(Math.ceil(size / 1999 / DEFAULT), 5);
        return mult * DEFAULT;
    }
    if (size > DEFAULT * 999) {
        return DEFAULT * 2;
    }
    return DEFAULT;
}
const RSA_KEY_TTL_MS = 5 * 60 * 1000;
const FAMILY_API_BASE = 'https://api.cloud.189.cn';
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36';

class CasService {
    constructor() {
        this._rsaCache = new Map(); // accountKey -> { pubKey, pkId, expire }
        this._cleanupService = new CasCleanupService();
    }

    // ==================== CAS 文件判断与解析 ====================

    static isCasFile(fileName) {
        return CasFileService.isCasFile(fileName);
    }

    static getOriginalFileName(casFileName, casInfo = null) {
        return CasFileService.getOriginalFileName(casFileName, casInfo);
    }

    static parseCasContent(content) {
        return CasFileService.parse(content);
    }

    static generateCasContent(fileInfo, format = 'base64') {
        return CasFileService.generate(fileInfo, format);
    }

    static parseBatchSourceContent(content) {
        return CasFileService.parseBatchSource(content);
    }

    // ==================== CAS 文件下载与解析 ====================

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
        return CasFileService.parse(response.body);
    }

    async generateCasFilesToCloud(cloud189, jobs, options = {}) {
        if (!Array.isArray(jobs) || jobs.length === 0) {
            throw new Error('请至少提供一组目录和内容');
        }

        const format = options.format === 'json' ? 'json' : 'base64';
        const overwrite = options.overwrite !== false;
        const result = {
            totalFiles: 0,
            uploadedCount: 0,
            failedCount: 0,
            groups: []
        };

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i] || {};
            const folderId = String(job.folderId || '').trim();
            if (!folderId) {
                throw new Error(`第 ${i + 1} 组未选择目标目录`);
            }

            const files = CasFileService.parseBatchSource(job.content || job.files || []);
            const group = {
                index: i + 1,
                folderId,
                folderName: job.folderName || '',
                parsedCount: files.length,
                uploaded: [],
                failed: []
            };
            result.totalFiles += files.length;

            for (const file of files) {
                const casName = this._buildCasFileName(file.name);
                try {
                    const content = CasFileService.generate(file, format);
                    const uploadResult = await this.uploadTextFile(cloud189, folderId, casName, content, { overwrite });
                    group.uploaded.push({ name: casName, fileId: uploadResult?.fileId || uploadResult?.id || '' });
                    result.uploadedCount++;
                } catch (error) {
                    group.failed.push({ name: casName, error: error.message });
                    result.failedCount++;
                    logTaskEvent(`[CAS生成] 失败: ${casName} - ${error.message}`);
                }
            }

            result.groups.push(group);
        }

        logTaskEvent(`[CAS生成] 完成: 成功 ${result.uploadedCount}/${result.totalFiles}, 失败 ${result.failedCount}`);
        return result;
    }

    async uploadTextFile(cloud189, parentFolderId, fileName, content, options = {}) {
        const buffer = Buffer.from(String(content || ''), 'utf8');
        if (buffer.length === 0) {
            throw new Error('上传内容为空');
        }
        return await this._uploadBufferFile(cloud189, parentFolderId, fileName, buffer, options);
    }

    async exportFolderCasFilesToCloud(cloud189, sourceFolderId, targetFolderId, options = {}) {
        const sourceId = String(sourceFolderId || '').trim();
        const targetId = String(targetFolderId || '').trim();
        if (!sourceId) {
            throw new Error('请选择要转换的源目录');
        }
        if (!targetId) {
            throw new Error('请选择 .cas 保存目录');
        }

        const stubs = await this.collectFolderCasStubs(cloud189, sourceId, {
            recursive: options.recursive !== false,
            mediaOnly: options.mediaOnly !== false
        });
        const result = {
            totalFiles: stubs.length,
            uploadedCount: 0,
            failedCount: 0,
            uploaded: [],
            failed: []
        };

        for (const stub of stubs) {
            const casName = this._buildCasFileName(stub.name);
            try {
                const uploadResult = await this.uploadTextFile(cloud189, targetId, casName, stub.content, {
                    overwrite: options.overwrite !== false
                });
                result.uploaded.push({ name: casName, fileId: uploadResult?.fileId || uploadResult?.id || '' });
                result.uploadedCount++;
            } catch (error) {
                result.failed.push({ name: casName, error: error.message });
                result.failedCount++;
                logTaskEvent(`[CAS另存] 失败: ${casName} - ${error.message}`);
            }
        }

        logTaskEvent(`[CAS另存] 完成: 成功 ${result.uploadedCount}/${result.totalFiles}, 失败 ${result.failedCount}`);
        return result;
    }

    async collectFolderCasStubs(cloud189, folderId, options = {}) {
        const mediaOnly = options.mediaOnly !== false;
        const result = await cloud189.listFiles(folderId || '-11', {
            recursive: options.recursive !== false,
            maxPages: options.maxPages || 10
        });

        const listAO = result?.fileListAO || {};
        const files = Array.isArray(listAO.fileList) ? listAO.fileList : (Array.isArray(result?.fileList) ? result.fileList : []);
        const exportData = [];
        for (const file of files) {
            const name = file.name || file.fileName || '';
            if (!name || CasFileService.isCasFile(name)) {
                continue;
            }
            if (mediaOnly && !this._isMediaFileName(name)) {
                continue;
            }

            try {
                let md5 = file.md5 || file.fileMd5 || file.md5Sum;
                let sliceMd5 = file.sliceMd5 || file.slice_md5 || file.slice_md5_hash;
                let size = file.size || file.fileSize;

                if (!md5 || !sliceMd5 || !size) {
                    const detail = await cloud189.getFileInfo(file.id || file.fileId);
                    if (detail) {
                        md5 = md5 || detail.md5 || detail.fileMd5;
                        sliceMd5 = sliceMd5 || detail.sliceMd5 || detail.slice_md5;
                        size = size || detail.size || detail.fileSize;
                    }
                }

                if (!md5) {
                    logTaskEvent(`[CAS另存] 跳过无MD5文件: ${name}`);
                    continue;
                }

                const content = CasFileService.generate({
                    name,
                    size,
                    md5,
                    sliceMd5: sliceMd5 || md5
                }, options.format === 'json' ? 'json' : 'base64');
                exportData.push({ name, content });
            } catch (error) {
                logTaskEvent(`[CAS另存] 处理文件失败 ${name}: ${error.message}`);
            }
        }
        return exportData;
    }

    // ==================== 删除源文件（Generate后） ====================

    /**
     * CAS生成后删除源文件
     * @param {Cloud189Service} cloud189
     * @param {string} sourceFileId - 源文件ID
     * @param {string} sourceFileName - 源文件名
     * @param {boolean} isFamily - 是否为家庭云
     */
    async deleteSourceFileAfterGenerate(cloud189, sourceFileId, sourceFileName = '', isFamily = false) {
        const deleteCasSource = ConfigService.getConfigValue('cas.deleteSourceAfterGenerate', false);
        if (!deleteCasSource) {
            logTaskEvent(`[CAS] 配置未启用生成后删除源文件，跳过: ${sourceFileName || sourceFileId}`);
            return false;
        }
        
        logTaskEvent(`[CAS] 生成CAS后删除源文件: ${sourceFileName || sourceFileId}`);
        return await this._cleanupService.deleteSourceFileAfterGenerate(cloud189, sourceFileId, sourceFileName, isFamily);
    }

    // ==================== 恢复后删除CAS ====================

    /**
     * 恢复后删除CAS文件
     * @param {Cloud189Service} cloud189
     * @param {string} casFileId - CAS文件ID
     * @param {string} casFileName - CAS文件名
     * @param {boolean} isFamily - 是否为家庭云
     */
    async deleteCasFileAfterRestore(cloud189, casFileId, casFileName = '', isFamily = false) {
        const deleteAfterRestore = ConfigService.getConfigValue('cas.deleteCasAfterRestore', true);
        if (!deleteAfterRestore) {
            logTaskEvent(`[CAS] 配置未启用恢复后删除CAS，跳过: ${casFileName || casFileId}`);
            return false;
        }

        logTaskEvent(`[CAS] 恢复后删除CAS文件: ${casFileName || casFileId}`);
        return await this._cleanupService.deleteCasFileAfterRestore(cloud189, casFileId, casFileName, isFamily);
    }

    // ==================== 秒传恢复 ====================

    async restoreFromCas(cloud189, parentFolderId, casInfo, restoreName) {
        logTaskEvent(`[CAS秒传] 开始: ${restoreName} 大小=${casInfo.size} md5=${casInfo.md5}`);
        const strategy = this._resolveRestoreStrategy(cloud189);
        const result = await this._executeRestoreStrategy(strategy, cloud189, parentFolderId, casInfo, restoreName);
        
        // 返回结果包含恢复的文件信息
        return result;
    }

    _resolveRestoreStrategy(cloud189) {
        const transitFirst = ConfigService.getConfigValue('cas.familyTransitFirst', false);
        const transitEnabled = ConfigService.getConfigValue('cas.enableFamilyTransit', true);
        const isFamilyTarget = typeof cloud189?.isFamilyAccount === 'function' && cloud189.isFamilyAccount();

        if (isFamilyTarget) {
            return {
                mode: 'family-direct',
                logMessage: '[CAS秒传] 当前为家庭目录任务，直接走家庭秒传'
            };
        }
        if (!isFamilyTarget && transitEnabled) {
            return {
                mode: 'family-first-personal-target',
                logMessage: '[CAS秒传] 当前为个人目录任务，默认先走家庭中转'
            };
        }
        if (transitFirst && transitEnabled) {
            return {
                mode: 'family-first',
                logMessage: '[CAS秒传] 已开启优先家庭中转'
            };
        }
        return {
            mode: 'personal-first',
            logMessage: ''
        };
    }

    async _executeRestoreStrategy(strategy, cloud189, parentFolderId, casInfo, restoreName) {
        if (strategy?.logMessage) {
            logTaskEvent(strategy.logMessage);
        }
        switch (strategy?.mode) {
            case 'family-direct':
                return await this._restoreFamilyDirect(cloud189, parentFolderId, casInfo, restoreName);
            case 'family-first-personal-target':
                return await this._restoreFamilyThenPersonal(cloud189, parentFolderId, casInfo, restoreName);
            case 'family-first':
                return await this._restoreViaFamily(cloud189, parentFolderId, casInfo, restoreName, null);
            case 'personal-first':
            default:
                return await this._restorePersonalThenMaybeFamily(cloud189, parentFolderId, casInfo, restoreName);
        }
    }

    async _restoreFamilyThenPersonal(cloud189, parentFolderId, casInfo, restoreName) {
        try {
            return await this._restoreViaFamily(cloud189, parentFolderId, casInfo, restoreName, null);
        } catch (familyErr) {
            // 如果是流量超限，直接抛出，不再回退到个人秒传（因为个人大概率也超限）
            if (this._isTrafficLimitError(familyErr)) {
                throw familyErr;
            }
            logTaskEvent(`[CAS秒传] 家庭中转失败(${familyErr.message || familyErr})，回退个人秒传`);
            return await this._restorePersonal(cloud189, parentFolderId, casInfo, restoreName);
        }
    }

    async _restoreFamilyDirect(cloud189, parentFolderId, casInfo, restoreName) {
        const familyInfo = await cloud189.getFamilyInfo();
        if (!familyInfo?.familyId) {
            throw new Error('家庭秒传不可用: 当前账号没有家庭组');
        }
        const familyId = String(familyInfo.familyId);
        const familyFolderId = parentFolderId === '-11' ? '' : String(parentFolderId || '');

        logTaskEvent(`[家庭秒传] familyId=${familyId} targetFolderId=${familyFolderId || '(根)'}`);
        await this._familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, restoreName);
        logTaskEvent(`[家庭秒传] 成功: ${restoreName}`);
        return { name: restoreName, size: casInfo.size };
    }

    async _restorePersonalThenMaybeFamily(cloud189, parentFolderId, casInfo, restoreName) {
        const transitEnabled = ConfigService.getConfigValue('cas.enableFamilyTransit', true);
        try {
            return await this._restorePersonal(cloud189, parentFolderId, casInfo, restoreName);
        } catch (personalErr) {
            const shouldFallback = transitEnabled && this._shouldFallbackToFamily(personalErr);
            if (!shouldFallback) {
                throw personalErr;
            }
            logTaskEvent(`[CAS秒传] 个人秒传失败(${personalErr.message || personalErr})，切换家庭中转`);
            return await this._restoreViaFamily(cloud189, parentFolderId, casInfo, restoreName, personalErr);
        }
    }

    _isTrafficLimitError(err) {
        if (!err) return false;
        const msg = String(err.message || '');
        // UserDayFlowOverLimited: 用户当天流量超限
        // data flow is out: 流量已用完
        // FlowOverLimited: 流量超限
        return /UserDayFlowOverLimited|data flow is out|FlowOverLimited|流量超限/i.test(msg);
    }

    _shouldFallbackToFamily(err) {
        if (!err) return false;
        if (err.isBlacklisted) return true;
        if (this._isTrafficLimitError(err)) return true;
        const msg = String(err.message || '');
        if (/InfoSecurityErrorCode|black list|风控|黑名单|InvalidPartSize|invalid part ?size/i.test(msg)) return true;
        const status = err?.response?.statusCode;
        if (status === 403) return true;
        return false;
    }

    // ==================== 个人秒传 ====================

    async _restorePersonal(cloud189, parentFolderId, casInfo, restoreName) {
        const sessionKey = await cloud189.getSessionKeyForUpload();
        const sliceSize = calcCasSliceSize(casInfo.size);

        const initRes = await this._uploadRequest(cloud189, sessionKey, '/person/initMultiUpload', {
            parentFolderId: String(parentFolderId),
            fileName: encodeURIComponent(restoreName),
            fileSize: String(casInfo.size),
            sliceSize: String(sliceSize),
            lazyCheck: '1'
        });

        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error(`CAS秒传初始化失败: 缺少uploadFileId`);
        }

        let fileDataExists = this._jsonGet(initRes, 'data', 'fileDataExists') === 1;

        await this._sleep(500);

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
        rsaKey.expire = Math.min(rsaKey.expire, Date.now() + RSA_KEY_TTL_MS);
        this._rsaCache.set(key, rsaKey);
        return rsaKey;
    }

    _accountKey(cloud189) {
        return cloud189?.account?.username || cloud189?.username || 'default';
    }

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
                const msg = response?.msg || response?.message || response?.code || 'unknown';
                if (/UserDayFlowOverLimited|data flow is out|FlowOverLimited|流量超限/i.test(msg)) {
                    throw new Error('天翼云盘当天上传/秒传流量已用完，请等额度恢复或换账号后再试');
                }
                throw new Error(`CAS上传请求失败 ${uri}: ${msg}`);
            }
            if (response.errorCode) {
                const msg = response.errorMsg || response.errorCode;
                if (/UserDayFlowOverLimited|data flow is out|FlowOverLimited|流量超限/i.test(msg)) {
                    throw new Error('天翼云盘当天上传/秒传流量已用完，请等额度恢复或换账号后再试');
                }
                throw new Error(`CAS上传请求失败 ${uri}: ${response.errorMsg || response.errorCode}`);
            }
            return response;
        } catch (err) {
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
                const msg = `${body.code || ''} ${body.msg || body.message || ''}`.trim();
                if (/UserDayFlowOverLimited|data flow is out|FlowOverLimited|流量超限/i.test(msg)) {
                    throw new Error('天翼云盘当天上传/秒传流量已用完，请等额度恢复或换账号后再试');
                }
                throw new Error(`CAS上传请求失败 ${uri}: ${body.code || ''} ${body.msg || ''}`.trim());
            }
            throw err;
        }
    }

    async _uploadBufferFile(cloud189, parentFolderId, fileName, buffer, options = {}) {
        const isFamily = typeof cloud189?.isFamilyAccount === 'function' && cloud189.isFamilyAccount();
        const sessionKey = await cloud189.getSessionKeyForUpload();
        const sliceSize = calcCasSliceSize(buffer.length);
        const uploadPath = isFamily ? '/family' : '/person';
        const initForm = {
            parentFolderId: String(parentFolderId),
            fileName: encodeURIComponent(fileName),
            fileSize: String(buffer.length),
            sliceSize: String(sliceSize),
            lazyCheck: '1'
        };
        if (isFamily) {
            initForm.familyId = await cloud189.resolveFamilyId();
        }

        const initRes = await this._uploadRequest(cloud189, sessionKey, `${uploadPath}/initMultiUpload`, initForm);
        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error(`初始化上传失败: ${fileName}`);
        }

        const fileMd5Hex = crypto.createHash('md5').update(buffer).digest('hex').toUpperCase();
        const sliceMd5Hexs = [];
        const partCount = Math.max(1, Math.ceil(buffer.length / sliceSize));

        for (let partNumber = 1; partNumber <= partCount; partNumber++) {
            const start = (partNumber - 1) * sliceSize;
            const end = Math.min(start + sliceSize, buffer.length);
            const chunk = buffer.subarray(start, end);
            const chunkMd5 = crypto.createHash('md5').update(chunk).digest();
            sliceMd5Hexs.push(chunkMd5.toString('hex').toUpperCase());

            const uploadUrls = await this._getMultiUploadUrls(
                cloud189,
                sessionKey,
                uploadPath,
                uploadFileId,
                [`${partNumber}-${chunkMd5.toString('base64')}`]
            );
            const uploadUrl = uploadUrls[0];
            if (!uploadUrl?.requestURL) {
                throw new Error(`获取上传分片地址失败: ${fileName}`);
            }
            await this._putUploadPart(uploadUrl.requestURL, uploadUrl.headers, chunk);
        }

        const sliceMd5Hex = partCount > 1
            ? crypto.createHash('md5').update(sliceMd5Hexs.join('\n')).digest('hex').toUpperCase()
            : fileMd5Hex;

        const commitRes = await this._uploadRequest(cloud189, sessionKey, `${uploadPath}/commitMultiUploadFile`, {
            uploadFileId: String(uploadFileId),
            fileMd5: fileMd5Hex,
            sliceMd5: sliceMd5Hex,
            lazyCheck: '1',
            isLog: '0',
            opertype: options.overwrite === false ? '1' : '3'
        });

        const file = this._jsonGet(commitRes, 'file') || this._jsonGet(commitRes, 'data') || {};
        logTaskEvent(`[CAS生成] 已上传: ${fileName}`);
        return {
            id: file.userFileId || file.fileId || file.id || '',
            fileId: file.userFileId || file.fileId || file.id || '',
            name: file.fileName || file.name || fileName,
            size: file.fileSize || buffer.length,
            md5: file.fileMd5 || fileMd5Hex
        };
    }

    async _getMultiUploadUrls(cloud189, sessionKey, uploadPath, uploadFileId, partInfoList) {
        const response = await this._uploadRequest(cloud189, sessionKey, `${uploadPath}/getMultiUploadUrls`, {
            uploadFileId: String(uploadFileId),
            partInfo: partInfoList.join(',')
        });
        const uploadUrls = response?.uploadUrls || response?.data?.uploadUrls || response?.data || {};
        return Object.entries(uploadUrls)
            .map(([key, value]) => ({
                partNumber: Number(String(key).replace('partNumber_', '')) || 0,
                requestURL: value?.requestURL || value?.requestUrl || value?.url,
                headers: this._parseUploadHeaders(value?.requestHeader || '')
            }))
            .sort((a, b) => a.partNumber - b.partNumber);
    }

    async _putUploadPart(requestURL, headers, chunk) {
        const proxyUrl = ProxyUtil.getProxy('cloud189');
        const requestOptions = {
            method: 'PUT',
            headers: {
                ...(headers || {}),
                'Content-Length': String(chunk.length)
            },
            body: chunk,
            timeout: { request: 30000 }
        };
        if (proxyUrl) {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            requestOptions.agent = { https: new HttpsProxyAgent(proxyUrl) };
        }
        await got(requestURL, requestOptions);
    }

    _parseUploadHeaders(headerText) {
        const headers = {};
        for (const item of String(headerText || '').split('&')) {
            const [key, ...rest] = item.split('=');
            if (!key || rest.length === 0) continue;
            const value = rest.join('=');
            if (value === '') continue;
            headers[key] = value;
        }
        return headers;
    }

    _buildCasFileName(fileName) {
        const clean = String(fileName || 'unknown').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'unknown';
        return clean.toLowerCase().endsWith('.cas') ? clean : `${clean}.cas`;
    }

    _isMediaFileName(fileName) {
        const lower = String(fileName || '').toLowerCase();
        return ['.mp4', '.mkv', '.ts', '.iso', '.rmvb', '.avi', '.mp3', '.flac', '.mov', '.wmv', '.m2ts', '.mpg', '.flv', '.rm']
            .some(ext => lower.endsWith(ext));
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

        const familyFileId = await this._familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, restoreName);
        if (!familyFileId) {
            throw new Error('家庭中转失败: 未获取到家庭文件ID');
        }

        try {
            await this._copyFamilyFileToPersonal(cloud189, familyId, familyFileId, personalFolderId, familyFolderId, restoreName);
        } catch (copyErr) {
            await this._safeDeleteFamilyFile(cloud189, familyId, familyFileId, restoreName);
            throw copyErr;
        }

        await this._safeDeleteFamilyFile(cloud189, familyId, familyFileId, restoreName);

        logTaskEvent(`[家庭中转] 成功: ${restoreName}`);
        return { name: restoreName, size: casInfo.size };
    }

    async _familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, fileName) {
        const sessionKey = await cloud189.getSessionKeyForUpload();
        const sliceSize = calcCasSliceSize(casInfo.size);

        const initRes = await this._uploadRequest(cloud189, sessionKey, '/family/initMultiUpload', {
            parentFolderId: String(familyFolderId || ''),
            familyId: String(familyId),
            fileName: encodeURIComponent(fileName),
            fileSize: String(casInfo.size),
            sliceSize: String(sliceSize),
            lazyCheck: '1'
        });
        const uploadFileId = this._jsonGet(initRes, 'data', 'uploadFileId');
        if (!uploadFileId) {
            throw new Error(`家庭秒传init失败: 缺少uploadFileId`);
        }
        let fileDataExists = this._jsonGet(initRes, 'data', 'fileDataExists') === 1;

        await this._sleep(500);

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
            throw new Error(`家庭秒传commit响应缺少文件ID`);
        }
        logTaskEvent(`[家庭中转] 家庭秒传完成, 家庭文件ID=${familyFileId}`);
        return String(familyFileId);
    }

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
            const accessToken = accessTokenInit;
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
            const successedCount = Number(result?.successedCount ?? result?.data?.successedCount ?? 0);
            const failedCount = Number(result?.failedCount ?? result?.data?.failedCount ?? 0);
            const skipCount = Number(result?.skipCount ?? result?.data?.skipCount ?? 0);
            const subTaskCount = Number(result?.subTaskCount ?? result?.data?.subTaskCount ?? 0);

            if (lastStatus === 4) {
                return;
            }
            if (subTaskCount > 0 && successedCount + failedCount + skipCount >= subTaskCount) {
                if (failedCount > 0) {
                    throw new Error(`家庭中转批量任务失败 type=${type} failedCount=${failedCount}`);
                }
                return;
            }
            if (lastStatus === 2) {
                throw new Error(`家庭中转批量任务冲突 type=${type}: 目标目录存在同名文件`);
            }
            if (lastStatus != null && lastStatus < 0) {
                throw new Error(`家庭中转批量任务失败 type=${type} taskStatus=${lastStatus}`);
            }
        }
        throw new Error(`家庭中转批量任务超时 taskStatus=${lastStatus}`);
    }

    async _safeDeleteFamilyFile(cloud189, familyId, fileId, fileName = '') {
        try {
            const deleteResult = await cloud189.request('/api/open/batch/createBatchTask.action', {
                method: 'POST',
                form: {
                    type: 'DELETE',
                    taskInfos: JSON.stringify([{ fileId: String(fileId), fileName: fileName || '', isFolder: 0 }]),
                    targetFolderId: '',
                    familyId: String(familyId)
                }
            });
            const deleteTaskId = deleteResult?.taskId || deleteResult?.data?.taskId;
            if (deleteTaskId) {
                await this._waitForBatchTask(cloud189, 'DELETE', deleteTaskId);
            }

            const clearResult = await cloud189.request('/api/open/batch/createBatchTask.action', {
                method: 'POST',
                form: {
                    type: 'CLEAR_RECYCLE',
                    taskInfos: JSON.stringify([{ fileId: String(fileId), fileName: fileName || '', isFolder: 0 }]),
                    targetFolderId: '',
                    familyId: String(familyId)
                }
            });
            const clearTaskId = clearResult?.taskId || clearResult?.data?.taskId;
            if (clearTaskId) {
                await this._waitForBatchTask(cloud189, 'CLEAR_RECYCLE', clearTaskId);
            }
            logTaskEvent(`[家庭中转] 已清理家庭残留文件: ${fileName || fileId}`);
        } catch (err) {
            logTaskEvent(`[家庭中转] 清理家庭残留失败(${fileId}): ${err.message}`);
        }
    }

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
