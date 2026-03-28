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
        body.headers = {
            'Accept': 'application/json;charset=UTF-8',
            ...(body.headers || {})
        };
        try {
            const requestUrl = this.buildRequestUrl(action);
            return await this.client.request(requestUrl, body).json();
        }catch (error) {
            if (error instanceof got.HTTPError) {
                let responseBody = null;
                try {
                    responseBody = JSON.parse(error.response.body);
                } catch (parseError) {
                    responseBody = null;
                }
                if (responseBody) {
                    if (responseBody.res_code === "ShareAuditWaiting") {
                        return responseBody;
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
                    logTaskEvent('请求天翼云盘接口失败:' + error.response.body);
                } else {
                    logTaskEvent('请求天翼云盘接口失败:' + error.response.body);
                }
            }else if (error instanceof got.TimeoutError) {
                logTaskEvent('请求天翼云盘接口失败: 请求超时, 请检查是否能访问天翼云盘');
            }else if(error instanceof got.RequestError) {
                logTaskEvent('请求天翼云盘接口异常: ' + error.message);
            }else{
                logTaskEvent('其他异常:' + error.message)
            }
            console.log(error)
            return null
        }
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
    async listFiles(folderId) {
        if (this.isFamilyAccount()) {
            return await this.listFamilyFiles(folderId);
        }
        return await this.request('/api/open/file/listFiles.action' , {
            method: 'GET',
            searchParams: { 
                folderId,
                mediaType: 0,
                orderBy: 'lastOpTime',
                descending: true,
                pageNum: 1,
                pageSize: 1000
             }
        })
    }

    async listFamilyFiles(folderId = '') {
        const familyId = await this.resolveFamilyId();
        const normalizedFolderId = folderId === '-11' ? '' : (folderId || '');
        return await this.request(`${Cloud189Service.CLOUD_API_BASE_URL}/family/file/listFiles.action`, {
            method: 'GET',
            searchParams: {
                folderId: normalizedFolderId,
                fileType: '0',
                mediaAttr: '0',
                iconOption: '5',
                pageNum: '1',
                pageSize: '1000',
                familyId,
                orderBy: '1',
                descending: 'false'
            }
        });
    }

    // 创建批量执行任务
    async createBatchTask(batchTaskDto) {
        logTaskEvent("创建批量任务")
        logTaskEvent(`batchTaskDto: ${batchTaskDto.toString()}`)
        const payload = { ...batchTaskDto };
        if ((this.isFamilyAccount() || payload.familyId) && !payload.familyId) {
            payload.familyId = await this.resolveFamilyId();
        }
        const action = payload.familyId
            ? `${Cloud189Service.CLOUD_API_BASE_URL}/batch/createBatchTask.action`
            : '/api/open/batch/createBatchTask.action';
        return await this.request(action, {
            method: 'POST',
            form: payload
        });
    }
    // 查询转存任务状态
    async checkTaskStatus(taskId, batchTaskDto = {}) {
        const params = { taskId, type: batchTaskDto.type || "SHARE_SAVE" };
        const action = (this.isFamilyAccount() || batchTaskDto.familyId)
            ? `${Cloud189Service.CLOUD_API_BASE_URL}/batch/checkBatchTask.action`
            : '/api/open/batch/checkBatchTask.action';
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
            return await this.request(`${Cloud189Service.CLOUD_API_BASE_URL}/family/file/createFolder.action`, {
                method: 'POST',
                searchParams: {
                    folderName,
                    relativePath: '',
                    familyId,
                    parentId: parentFolderId === '-11' ? '' : (parentFolderId || '')
                }
            });
        }
        return await this.request('/api/open/file/createFolder.action' , {
            method: 'POST',
            form: {
                parentFolderId: parentFolderId,
                folderName: folderName
            },
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
        const action = (this.isFamilyAccount() || batchTaskDto.familyId)
            ? `${Cloud189Service.CLOUD_API_BASE_URL}/batch/getConflictTaskInfo.action`
            : '/api/open/batch/getConflictTaskInfo.action';
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
        const action = (this.isFamilyAccount() || batchTaskDto.familyId)
            ? `${Cloud189Service.CLOUD_API_BASE_URL}/batch/manageBatchTask.action`
            : '/api/open/batch/manageBatchTask.action';
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

    // 重命名文件
    async renameFile(fileId, destFileName) { 
        if (this.isFamilyAccount()) {
            const familyId = await this.resolveFamilyId();
            return await this.request(`${Cloud189Service.CLOUD_API_BASE_URL}/family/file/renameFile.action`, {
                method: 'GET',
                searchParams: {
                    fileId,
                    destFileName,
                    familyId
                }
            });
        }
        const response = await this.request('/api/open/file/renameFile.action', {
            method: 'POST',
            form: {
                fileId,
                destFileName
            },
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
    // 获取网盘直链
    async getDownloadLink(fileId, shareId = null) {
        if (this.isFamilyAccount() && !shareId) {
            const familyId = await this.resolveFamilyId();
            const response = await this.request(`${Cloud189Service.CLOUD_API_BASE_URL}/family/file/getFileDownloadUrl.action`, {
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
