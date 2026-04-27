const { CloudClient, FileTokenStore } = require('../../vender/cloud189-sdk/dist');
const { logTaskEvent } = require('../utils/logUtils');
const crypto = require('crypto');
const got = require('got');
const ProxyUtil = require('../utils/ProxyUtil');
class Cloud189Service {
    static instances = new Map();
    static CLOUD_WEB_BASE_URL = 'https://cloud.189.cn';
    static CLOUD_API_BASE_URL = 'https://api.cloud.189.cn';

    static buildInstanceKey(account) {
        return `${account.username}::${account.accountType || 'personal'}::${account.familyId || ''}`;
    }

    static getInstance(account) {
        const key = this.buildInstanceKey(account);
        if (!this.instances.has(key)) {
            this.instances.set(key, new Cloud189Service(account));
        }
        return this.instances.get(key);
    }

    static invalidateByUsername(username) {
        for (const key of this.instances.keys()) {
            if (key.startsWith(`${username}::`)) {
                this.instances.delete(key);
            }
        }
    }

    constructor(account) {
        this.account = {
            ...account,
            accountType: account.accountType || 'personal',
            familyId: account.familyId ? String(account.familyId) : ''
        };
        const _options = {
            username: account.username,
            password: account.password,
            token: new FileTokenStore(`data/${account.username}.json`)
        }
        if (!account.password && account.cookies) {
            _options.ssonCookie = account.cookies
            _options.password = null   
        }
        _options.proxy = ProxyUtil.getProxy('cloud189')
        this.client = new CloudClient(_options);
    }

    // 重新给所有实例设置代理
    static setProxy() {
        const proxyUrl = ProxyUtil.getProxy('cloud189')
        this.instances.forEach(instance => {
            instance.client.setProxy(proxyUrl);
        });
    }

    // 封装统一请求
    async request(action, body = {}) {
        const method = String(body?.method || 'GET').toUpperCase();
        body.headers = {
            'Accept': 'application/json;charset=UTF-8',
            ...(body.headers || {})
        };
        try {
            const requestUrl = this.buildRequestUrl(action);
            return await this.client.request(requestUrl, body).json();
        }catch (error) {
            const statusCode = Number(error?.response?.statusCode || 0);
            if (error?.name === 'HTTPError' || statusCode > 0) {
                let responseBody = null;
                try {
                    responseBody = JSON.parse(error?.response?.body);
                } catch (parseError) {
                    responseBody = null;
                }
                if (responseBody) {
                    if (responseBody.res_code === "ShareAuditWaiting") {
                        return responseBody;
                    }
                    const repeatTaskId = responseBody.taskId || responseBody.taskID || responseBody.task_id || null;
                    const isReusableRepeatTask = responseBody.res_code === "RequestResubmit"
                        || (responseBody.res_message === 'ShareSaveTaskIsAlreadyExist' && repeatTaskId);
                    if (isReusableRepeatTask) {
                        return {
                            ...responseBody,
                            res_code: "RequestResubmit",
                            res_msg: responseBody.res_message || responseBody.res_msg || "重复提交请求"
                        };
                    }
                    if (responseBody.res_code === "FileAlreadyExists") {
                        return {
                            res_code: "FileAlreadyExists",
                            res_msg: "文件已存在"
                        };
                    }
                    if (responseBody.res_code === "FileNotFound") {
                        return {
                            res_code: "FileNotFound",
                            res_msg: "文件不存在"
                        };
                    }
                    if (responseBody.errorCode === 'InvalidSessionKey' && /check ip error/i.test(responseBody.errorMsg || '')) {
                        logTaskEvent('天翼云盘会话失效: 当前出口 IP 与 Cookie 绑定 IP 不一致。若为双栈网络，建议为容器添加环境变量 DNS_LOOKUP_IP_VERSION=ipv4；如账号仅使用 Cookie 登录，请改用账号密码登录或固定代理出口。');
                    }
                    const message = responseBody.res_msg || responseBody.res_message || responseBody.errorMsg || error.message;
                    logTaskEvent(`请求天翼云盘接口失败 [HTTP ${statusCode || '未知'} ${method} ${action}]: ${message}`);
                    return {
                        ...responseBody,
                        _requestFailed: true,
                        _retriable: statusCode >= 500 || statusCode === 429,
                        _httpStatusCode: statusCode || undefined
                    };
                } else {
                    const responseBodyText = String(error?.response?.body || '').slice(0, 500);
                    const fallbackMessage = responseBodyText || error.message || 'HTTP请求失败';
                    logTaskEvent(`请求天翼云盘接口失败 [HTTP ${statusCode || '未知'} ${method} ${action}]: ${fallbackMessage}`);
                    return {
                        res_code: `HTTP_${statusCode || 'UNKNOWN'}`,
                        res_msg: fallbackMessage,
                        _requestFailed: true,
                        _retriable: statusCode >= 500 || statusCode === 429,
                        _httpStatusCode: statusCode || undefined
                    };
                }
            }else if (error?.name === 'TimeoutError' || error instanceof got.TimeoutError) {
                logTaskEvent('请求天翼云盘接口失败: 请求超时, 请检查是否能访问天翼云盘');
            }else if(error?.name === 'RequestError' || error instanceof got.RequestError) {
                logTaskEvent('请求天翼云盘接口异常: ' + error.message);
            }else{
                logTaskEvent('其他异常:' + error.message)
            }
            console.log(error)
            return null
        }
    }

    async requestWithRetry(action, body = {}, options = {}) {
        const retries = Number(options.retries ?? 0);
        const retryDelayMs = Number(options.retryDelayMs ?? 800);
        const shouldRetry = typeof options.shouldRetry === 'function'
            ? options.shouldRetry
            : (result) => {
                if (result == null) {
                    return true;
                }
                if (result?._requestFailed) {
                    return Boolean(result._retriable);
                }
                return false;
            };

        for (let attempt = 0; attempt <= retries; attempt++) {
            const result = await this.request(action, body);
            if (!shouldRetry(result) || attempt === retries) {
                return result;
            }
            logTaskEvent(`天翼云盘接口请求失败 [${action}]，${Math.round(retryDelayMs / 1000 * 10) / 10} 秒后重试 (${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }

        return null;
    }

    buildRequestUrl(action) {
        const baseUrl = /^https?:\/\//.test(action) ? action : `${Cloud189Service.CLOUD_WEB_BASE_URL}${action}`;
        const url = new URL(baseUrl);
        url.searchParams.set('noCache', Math.random().toString());
        return url.toString();
    }

    isFamilyAccount() {
        return (this.account.accountType || 'personal') === 'family';
    }

    async resolveFamilyId(preferredFamilyId = null) {
        if (preferredFamilyId) {
            return String(preferredFamilyId);
        }
        if (this.account.familyId) {
            return String(this.account.familyId);
        }
        const familyInfo = await this.getFamilyInfo();
        if (!familyInfo?.familyId) {
            throw new Error('未获取到家庭ID，请手动填写 familyId');
        }
        this.account.familyId = String(familyInfo.familyId);
        return this.account.familyId;
    }
    
    async getUserSizeInfo() {
        try {
            return await this.client.getUserSizeInfo()    
        }catch(error) {
            if (error instanceof got.HTTPError) {
                const responseBody = error.response.body;
                logTaskEvent('请求天翼云盘接口失败:'+ responseBody);
            }else if (error instanceof got.TimeoutError) {
                logTaskEvent('请求天翼云盘接口失败: 请求超时, 请检查是否能访问天翼云盘');
            }else if(error instanceof got.RequestError) {
                logTaskEvent('请求天翼云盘接口异常: ' + error.message);
            } else {
                // 捕获其他类型的错误
                logTaskEvent('获取用户空间信息失败:' +  error.message);
            }
            console.log(error)
            return null
        }
    
    }
    // 解析分享链接获取文件信息
    async getShareInfo(shareCode) {
        return await this.request('/api/open/share/getShareInfoByCodeV2.action' , {
            method: 'GET',
            searchParams: { shareCode }
        })
    }

    // 获取分享目录下的文件列表
    async listShareDir(shareId, fileId, shareMode, accessCode, isFolder = true) {
        return await this.request('/api/open/share/listShareDir.action', {
            method: 'GET',
            searchParams: {
                shareId,
                isFolder: isFolder,
                fileId: fileId,
                orderBy: 'lastOpTime',
                descending: true,
                shareMode: shareMode,
                pageNum: 1,
                pageSize: 1000,
                accessCode
            }
        })
    }

    // 递归获取所有文件列表
    async getShareFiles(shareId, fileId, shareMode, accessCode, isFolder = true) {
        const result = await this.listShareDir(shareId, fileId, shareMode, accessCode, isFolder);
        if (!result || !result.fileListAO.fileList) {
            return [];
        }
        return result.fileListAO.fileList;
    }

    // 搜索个人网盘文件
    async searchFiles(filename) {
        return await this.request('/api/open/share/getShareInfoByCodeV2.action' , {
            method: 'GET',
            searchParams: { 
                folderId: '-11',
                pageSize: '1000',
                pageNum: '1',
                recursive: 1,
                mediaType: 0,
                filename
             }
        })
    }

    // 获取个人网盘文件列表
    async listFiles(folderId, options = {}) {
        const { recursive = false, maxPages = 10 } = options;
        
        if (this.isFamilyAccount()) {
            return await this.listFamilyFiles(folderId, options);
        }
        
        // 分页获取所有文件
        const allFiles = [];
        const allFolders = [];
        let pageNum = 1;
        let hasMore = true;
        
        while (hasMore && pageNum <= maxPages) {
            const result = await this.requestWithRetry('/api/open/file/listFiles.action', {
                method: 'GET',
                searchParams: {
                    folderId,
                    mediaType: 0,
                    orderBy: 'lastOpTime',
                    descending: true,
                    pageNum,
                    pageSize: 1000
                }
            }, {
                retries: 2,
                retryDelayMs: 1200
            });
            
            const fileListAO = result?.fileListAO || {};
            const files = fileListAO.fileList || [];
            const folders = fileListAO.folderList || [];
            
            allFiles.push(...files);
            allFolders.push(...folders);
            
            // 检查是否还有更多
            const totalCount = fileListAO.count || 0;
            hasMore = (pageNum * 1000) < totalCount && files.length === 1000;
            pageNum++;
        }
        
        // 递归获取子目录文件
        if (recursive) {
            for (const folder of allFolders) {
                const subResult = await this.listFiles(folder.id, { recursive, maxPages });
                allFiles.push(...(subResult.fileListAO?.fileList || []));
                allFolders.push(...(subResult.fileListAO?.folderList || []));
            }
        }
        
        return {
            fileListAO: {
                fileList: allFiles,
                folderList: allFolders,
                count: allFiles.length
            }
        };
    }

    async listFamilyFiles(folderId = '', options = {}) {
        const { recursive = false, maxPages = 10 } = options;
        const familyId = await this.resolveFamilyId();
        const normalizedFolderId = folderId === '-11' ? '' : (folderId || '');
        
        // 分页获取所有文件
        const allFiles = [];
        const allFolders = [];
        let pageNum = 1;
        let hasMore = true;
        
        while (hasMore && pageNum <= maxPages) {
            const result = await this.requestWithRetry('/api/open/family/file/listFiles.action', {
                method: 'GET',
                searchParams: {
                    folderId: normalizedFolderId,
                    fileType: '0',
                    mediaAttr: '0',
                    iconOption: '5',
                    pageNum: String(pageNum),
                    pageSize: '1000',
                    familyId,
                    orderBy: '1',
                    descending: 'false'
                }
            }, {
                retries: 2,
                retryDelayMs: 1200
            });
            
            const fileListAO = result?.fileListAO || {};
            const files = fileListAO.fileList || [];
            const folders = fileListAO.folderList || [];
            
            allFiles.push(...files);
            allFolders.push(...folders);
            
            // 检查是否还有更多
            const totalCount = fileListAO.count || 0;
            hasMore = (pageNum * 1000) < totalCount && files.length === 1000;
            pageNum++;
        }
        
        // 递归获取子目录文件
        if (recursive) {
            for (const folder of allFolders) {
                const subResult = await this.listFamilyFiles(folder.id, { recursive, maxPages });
                allFiles.push(...(subResult.fileListAO?.fileList || []));
                allFolders.push(...(subResult.fileListAO?.folderList || []));
            }
        }
        
        return {
            fileListAO: {
                fileList: allFiles,
                folderList: allFolders,
                count: allFiles.length
            }
        };
    }

    // 创建批量执行任务
    async createBatchTask(batchTaskDto) {
        logTaskEvent("创建批量任务")
        let taskInfos = [];
        try {
            taskInfos = JSON.parse(batchTaskDto.taskInfos || '[]');
        } catch {
            taskInfos = [];
        }
        logTaskEvent(`batchTaskDto摘要: type=${batchTaskDto.type}, targetFolderId=${batchTaskDto.targetFolderId}, shareId=${batchTaskDto.shareId}, familyId=${batchTaskDto.familyId || 'null'}, taskCount=${taskInfos.length}, sample=${taskInfos.slice(0, 3).map(item => item.fileName).join(' | ')}`)
        const payload = { ...batchTaskDto };
        // 去除 null/undefined 字段，避免 form 里出现 "null" 字符串
        for (const key of Object.keys(payload)) {
            if (payload[key] == null) delete payload[key];
        }
        if (this.isFamilyAccount() && !payload.familyId) {
            payload.familyId = await this.resolveFamilyId();
        }
        const action = '/api/open/batch/createBatchTask.action';
        return await this.request(action, {
            method: 'POST',
            form: payload
        });
    }
    // 查询转存任务状态
    async checkTaskStatus(taskId, batchTaskDto = {}) {
        const params = { taskId, type: batchTaskDto.type || "SHARE_SAVE" };
        const action = '/api/open/batch/checkBatchTask.action';
        return await this.request(action, {
            method: 'POST',
            form: params,
        });
    }

    // 获取目录树节点
    async getFolderNodes(folderId = '-11') {
        if (this.isFamilyAccount()) {
            const resp = await this.listFamilyFiles(folderId);
            return resp?.fileListAO?.folderList || [];
        }
        return await this.request('/api/portal/getObjectFolderNodes.action' , {
            method: 'POST',
            form: {
                id: folderId,
                orderBy: 1,
                order: 'ASC'
            },
        })
    }

    // 新建目录
    async createFolder(folderName, parentFolderId) {
        if (this.isFamilyAccount()) {
            const familyId = await this.resolveFamilyId();
            return await this.requestWithRetry('/api/open/family/file/createFolder.action', {
                method: 'POST',
                searchParams: {
                    folderName,
                    relativePath: '',
                    familyId,
                    parentId: parentFolderId === '-11' ? '' : (parentFolderId || '')
                }
            }, {
                retries: 2,
                retryDelayMs: 1200,
                shouldRetry: (result) => result == null || result?.res_code === 'FileNotFound'
            });
        }
        return await this.requestWithRetry('/api/open/file/createFolder.action' , {
            method: 'POST',
            form: {
                parentFolderId: parentFolderId,
                folderName: folderName
            },
        }, {
            retries: 2,
            retryDelayMs: 1200,
            shouldRetry: (result) => result == null || result?.res_code === 'FileNotFound'
        })
    }

     // 验证分享链接访问码
     async checkAccessCode(shareCode, accessCode) {
        return await this.request('/api/open/share/checkAccessCode.action' , {
            method: 'GET',
            searchParams: {
                shareCode,
                accessCode,
                uuid: crypto.randomUUID()
            },
        })
    }
    // 获取冲突的文件
    async getConflictTaskInfo(taskId, batchTaskDto = {}) {
        const action = '/api/open/batch/getConflictTaskInfo.action';
        return await this.request(action , {
            method: 'POST',
            form: {
                taskId,
                type: batchTaskDto.type || 'SHARE_SAVE'
            },
        });
    }

    // 处理冲突 taskInfos: [{"fileId":"","fileName":"","isConflict":1,"isFolder":0,"dealWay":1}]
    async manageBatchTask(taskId,targetFolderId, taskInfos, batchTaskDto = {}) {
        const action = '/api/open/batch/manageBatchTask.action';
        return await this.request(action , {
            method: 'POST',
            form: {
                taskId,
                type: batchTaskDto.type || 'SHARE_SAVE',
                targetFolderId,
                taskInfos: JSON.stringify(taskInfos)
            },
        });
    }

    // 获取单个文件详细信息（含MD5）
    async getFileInfo(fileId) {
        if (this.isFamilyAccount()) {
            const familyId = await this.resolveFamilyId();
            const resp = await this.request('/api/open/family/file/getFileInfo.action', {
                method: 'GET',
                searchParams: { fileId, familyId }
            });
            return resp?.fileInfo || null;
        }
        const resp = await this.request('/api/open/file/getFileInfo.action', {
            method: 'GET',
            searchParams: { fileId }
        });
        return resp?.fileInfo || null;
    }

    // 重命名文件
    async renameFile(fileId, destFileName) {
        if (this.isFamilyAccount()) {
            const familyId = await this.resolveFamilyId();
            return await this.requestWithRetry('/api/open/family/file/renameFile.action', {
                method: 'GET',
                searchParams: {
                    fileId,
                    destFileName,
                    familyId
                }
            }, {
                retries: 2,
                retryDelayMs: 1000
            });
        }
        const response = await this.requestWithRetry('/api/open/file/renameFile.action', {
            method: 'POST',
            form: {
                fileId,
                destFileName
            },
        }, {
            retries: 2,
            retryDelayMs: 1000
        })
        return response
    }
    // 获取家庭信息
    async getFamilyInfo() {
        const familyList = await this.client.getFamilyList()
        if (!familyList || !familyList.familyInfoResp) {
            return null
        }
        const resp = familyList.familyInfoResp
        for (const family of resp) {
            if (family.userRole == 1) {
                return family
            }
        }
        return null
    }

    // 获取家庭空间根目录ID（用作家庭秒传中转目录）
    async getFamilyRootFolderId(familyId) {
        try {
            const result = await this.request('/api/open/family/file/listFiles.action', {
                method: 'GET',
                searchParams: { familyId, folderId: '', needPath: true, pageNum: 1, pageSize: 1 }
            });
            const pathItems = Array.isArray(result?.path) ? result.path : [];
            const familyRoot = [...pathItems].reverse().find((item) =>
                item && item.fileId && item.fileId !== '-11' && item.fileId !== '-16'
            );
            if (familyRoot?.fileId) {
                return String(familyRoot.fileId);
            }
            if (result?.fileListAO?.path?.length > 0) {
                return String(result.fileListAO.path[0].fileId);
            }
            return '';
        } catch (error) {
            logTaskEvent(`[家庭中转] 获取家庭根目录ID失败: ${error.message}`);
            return '';
        }
    }
    // 获取网盘直链
    async getDownloadLink(fileId, shareId = null) {
        if (this.isFamilyAccount() && !shareId) {
            const familyId = await this.resolveFamilyId();
            const response = await this.request('/api/open/family/file/getFileDownloadUrl.action', {
                method: 'GET',
                searchParams: {
                    fileId,
                    familyId
                },
            });
            const url = response?.fileDownloadUrl;
            if (!url) {
                throw new Error(response?.res_msg || '获取家庭云直链失败');
            }
            const res = await got(String(url).replace('http://', 'https://'), {
                followRedirect: false,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0'
                }
            });
            return res.headers.location || url;
        }
        const type = shareId? 4: 2
        const response = await this.request('/api/portal/getNewVlcVideoPlayUrl.action', {
            method: 'GET',
            searchParams: {
                fileId,
                shareId,
                type,
                dt: 1
            },
        })
        if (!response || response.res_code != 0) {
            throw new Error(response.res_msg)
        }
        const code = response.normal.code
        if (code != 1) {
            throw new Error(response.normal.message)
        }
        const url = response.normal.url
        const res = await got(url, {
            followRedirect: false,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0'
            }
        })
        return res.headers.location
    }
    // 获取 sessionKey（用于 upload 域名的加密请求）
    async getSessionKeyForUpload() {
        const resp = await this.request('/v2/getUserBriefInfo.action', {
            method: 'GET'
        });
        if (!resp?.sessionKey) {
            throw new Error('获取上传SessionKey失败');
        }
        return resp.sessionKey;
    }

    // 获取 RSA 公钥（用于 upload 域名的加密请求）
    async getRsaKey() {
        const resp = await this.request('/api/security/generateRsaKey.action', {
            method: 'GET'
        });
        if (!resp?.pubKey || !resp?.pkId) {
            throw new Error('获取RSA公钥失败');
        }
        return {
            pubKey: resp.pubKey,
            pkId: resp.pkId,
            expire: resp.expire || 0
        };
    }

    // 获取文件下载URL（用于下载 .cas 文件内容）
    async getFileDownloadUrl(fileId) {
        if (this.isFamilyAccount()) {
            const familyId = await this.resolveFamilyId();
            const response = await this.request('/api/open/family/file/getFileDownloadUrl.action', {
                method: 'GET',
                searchParams: { fileId, familyId }
            });
            return response?.fileDownloadUrl || null;
        }
        const response = await this.request('/api/open/file/getFileDownloadUrl.action', {
            method: 'GET',
            searchParams: { fileId, dt: 3 }
        });
        return response?.fileDownloadUrl || null;
    }

    // 删除文件
    async deleteFile(fileId, fileName) {
        const batchTaskDto = {
            taskInfos: JSON.stringify([{
                fileId: String(fileId),
                fileName: String(fileName),
                isFolder: 0
            }]),
            type: 'DELETE',
            targetFolderId: ''
        };
        if (this.isFamilyAccount()) {
            batchTaskDto.familyId = await this.resolveFamilyId();
        }
        const action = '/api/open/batch/createBatchTask.action';
        return await this.request(action, {
            method: 'POST',
            form: batchTaskDto
        });
    }

    // 记录转存量
    async increaseShareFileAccessCount(shareId) {
        const response = await this.request(`${Cloud189Service.CLOUD_WEB_BASE_URL}/api/portal//share/increaseShareFileAccessCount.action`, {
            method: 'GET',
            searchParams: {
                shareId,
                view: false,
                download: false,
                dump: true
            },
        })
        return response
    }
    async login(username, password, validateCode) {
        try {
            const loginToken = await this.client.authClient.loginByPassword(username, password, validateCode)
            await this.client.tokenStore.update({
                accessToken: loginToken.accessToken,
                refreshToken: loginToken.refreshToken,
                expiresIn: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).getTime()
            })
            return {
                success: true
            }
        } catch (error) {
            // 处理需要验证码的情况
            if (error.code === 'NEED_CAPTCHA') {
                return {
                    success: false,
                    code: 'NEED_CAPTCHA',
                    data: error.data.image // 包含验证码图片和相关token信息
                }
            }
            console.log(error)
            // 处理其他错误
            return {
                success: false,
                code: 'LOGIN_ERROR',
                message: error.message || '登录失败'
            }
        }
    }
}

module.exports = { Cloud189Service };
