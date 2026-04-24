const got = require('got');
const http = require('http');
const https = require('https');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { MessageUtil } = require('./message');
const { AppDataSource } = require('../database'); 
const { Task, Account } = require('../entities'); 
const { Cloud189Service } = require('./cloud189');
const path = require('path');
const querystring = require('querystring');
const { StrmService } = require('./strm');
const { StreamProxyService } = require('./streamProxy');
const { LazyShareStrmService } = require('./lazyShareStrm');

const { Not, IsNull, Like } = require('typeorm');

// emby接口
class EmbyService {
    constructor(taskService) {
        this.enable = false;
        this.embyUrl = '';
        this.embyApiKey = '';
        this.proxyEnabled = false;
        this.embyPathReplace = ''
        this.messageUtil = new MessageUtil();

        this._taskRepo = AppDataSource.getRepository(Task);
        this._accountRepo = AppDataSource.getRepository(Account);
        this._taskService = taskService;
        this._strmService = new StrmService();
        this._streamProxyService = new StreamProxyService(this._accountRepo);
        this._lazyShareStrmService = new LazyShareStrmService(this._accountRepo, taskService);
        this._prewarmService = null;
        this._refreshConfig();
    }

    _refreshConfig() {
        this.enable = !!ConfigService.getConfigValue('emby.enable');
        this.embyUrl = String(ConfigService.getConfigValue('emby.serverUrl') || '').trim().replace(/\/+$/g, '');
        this.embyApiKey = String(ConfigService.getConfigValue('emby.apiKey') || '').trim();
        this.proxyEnabled = !!ConfigService.getConfigValue('emby.proxy.enable');
    }

    getProxyBasePath(options = {}) {
        if (typeof options === 'string') {
            return options || '';
        }
        return options.basePath || '/emby-proxy';
    }

    isProxyEnabled() {
        this._refreshConfig();
        return this.proxyEnabled;
    }

    attachPrewarmService(prewarmService) {
        this._prewarmService = prewarmService || null;
    }

    triggerPrewarm(context = {}) {
        if (!this._prewarmService) {
            return;
        }
        void this._prewarmService.schedulePrewarm(context);
    }

    async handleProxyRequest(req, res, options = {}) {
        this._refreshConfig();
        if (!this.embyUrl) {
            res.status(503).json({ success: false, error: 'Emby 服务器地址未配置' });
            return;
        }

        const proxyBasePath = this.getProxyBasePath(options);
        const currentUrl = req.originalUrl || req.url || '/';
        if (proxyBasePath && (currentUrl === proxyBasePath || currentUrl === `${proxyBasePath}/`)) {
            res.redirect(302, `${proxyBasePath}/web/index.html`);
            return;
        }
        const relativePath = this._buildRelativePath(currentUrl, proxyBasePath);

        if (this.proxyEnabled && this._isPlaybackRequest(relativePath)) {
            try {
                const directUrl = await this._resolvePlaybackDirectUrl(relativePath, req.query || {});
                if (directUrl) {
                    res.set('Cache-Control', 'no-store');
                    res.redirect(302, directUrl);
                    this.triggerPrewarm({
                        itemId: this._extractItemId(relativePath),
                        userId: req.query?.UserId || req.query?.userId || '',
                        source: 'proxy'
                    });
                    return;
                }
            } catch (error) {
                logTaskEvent(`Emby反代直链失败，回退Emby原始播放: ${error.message}`);
            }
        }

        await this._forwardToEmby(req, res, relativePath, proxyBasePath);
    }

    async handleProxyUpgrade(req, socket, head, options = {}) {
        this._refreshConfig();
        if (!this.embyUrl) {
            this._writeUpgradeError(socket, 503, 'Emby 服务器地址未配置');
            return;
        }

        const proxyBasePath = this.getProxyBasePath(options);
        const relativePath = this._buildRelativePath(req.url || '/', proxyBasePath);

        try {
            await this._forwardWebSocket(req, socket, head, relativePath);
        } catch (error) {
            logTaskEvent(`Emby反代 WebSocket 失败: ${error.message}`);
            this._writeUpgradeError(socket, 502, `Emby反代 WebSocket 失败: ${error.message}`);
        }
    }


    async notify(task) {
        this._refreshConfig();
        if (!this.enable){
            logTaskEvent(`Emby通知未启用, 请启用后执行`);
            return;
        }
        const taskName = task.resourceName
        logTaskEvent(`执行Emby通知: ${taskName}`);
        // 处理路径
        this.embyPathReplace = task.account.embyPathReplace
        const path = this._replacePath(task.realFolderName)
        const item = await this.searchItemsByPathRecursive(path);
        logTaskEvent(`Emby搜索结果: ${ JSON.stringify(item)}`);
        if (item) {
            await this.refreshItemById(item.Id);
            this.messageUtil.sendMessage(`🎉 Emby 入库通知成功\n资源名：${task.resourceName}`, { level: 'success' });
            return item.Id
        }else{
            logTaskEvent(`Emby未搜索到电影/剧集: ${taskName}, 执行全库扫描`);
            await this.refreshAllLibraries();
            this.messageUtil.sendMessage(`🎉 Emby 入库通知成功\n资源名：${task.resourceName}`, { level: 'success' });
            return null;
        }
    }

    // 1. /emby/Items 根据名称搜索
    async searchItemsByName(name) {
        name = this._cleanMediaName(name);
        const url = `${this.embyUrl}/emby/Items`;
        const params = {
            SearchTerm: name,
            IncludeItemTypes: 'Movie,Series',
            Recursive: true,
            Fields: "Name",
        }
        const response = await this.request(url, {
            method: 'GET',
            searchParams: params,
        })
        return response;
    }

    // 2. /emby/Items/{ID}/Refresh 刷新指定ID的剧集/电影
    async refreshItemById(id) {
        const url = `${this.embyUrl}/emby/Items/${id}/Refresh`;
        await this.request(url, {
            method: 'POST',
        })
        return true;
    }

    // 3. 刷新所有库
    async refreshAllLibraries() {
        const url = `${this.embyUrl}/emby/Library/Refresh`;
        await this.request(url, {
            method: 'POST',
        })
        return true;
    }
    // 4. 根据路径搜索 /Items
    async searchItemsByPath(path) {
        const url = `${this.embyUrl}/Items`;
        const params = {
            Path: path,
            Recursive: true,
        }
        const response = await this.request(url, {
            method: 'GET',
            searchParams: params,
        })
        return response;
    }

    // 传入path, 调用searchItemsByPath, 如果返回结果为空, 则递归调用searchItemsByPath, 直到返回结果不为空
    async searchItemsByPathRecursive(path) {
        try {
            // 防止空路径
            if (!path) return null;
            // 移除路径末尾的斜杠
            const normalizedPath = path.replace(/\/+$/, '');
            // 搜索当前路径
            const result = await this.searchItemsByPath(normalizedPath);
            if (result?.Items?.[0]) {
                logTaskEvent(`在路径 ${normalizedPath} 找到媒体项`);
                return result.Items[0];
            }
            // 获取父路径
            const parentPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
            if (!parentPath) {
                logTaskEvent('已搜索到根路径，未找到媒体项');
                return null;
            }
            // 递归搜索父路径
            logTaskEvent(`在路径 ${parentPath} 继续搜索`);
            return await this.searchItemsByPathRecursive(parentPath);
        } catch (error) {
            logTaskEvent(`路径搜索出错: ${error.message}`);
            return null;
        }
    }

    async getItemById(id) {
        const url = `${this.embyUrl}/Items`;
        const response = await this.request(url, {
            method: 'GET',
            searchParams: {
                Ids: id,
                Recursive: true,
                Fields: 'Path,MediaSources,ProviderIds,Name,SeriesId,ParentIndexNumber,IndexNumber,SeriesName,SeasonId'
            },
        });
        return response?.Items?.[0] || null;
    }

    _isPlaybackRequest(requestPath = '') {
        const normalizedPath = String(requestPath || '').split('?')[0];
        return /\/(?:emby\/)?(?:Videos|Audio)\/[^/]+\/.+/i.test(normalizedPath);
    }

    _extractItemId(requestPath = '') {
        const normalizedPath = String(requestPath || '').split('?')[0];
        const match = normalizedPath.match(/\/(?:emby\/)?(?:Videos|Audio)\/([^/]+)/i);
        return match?.[1] || null;
    }

    _normalizeSlashPath(value = '') {
        return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/');
    }

    _trimSlashPath(value = '') {
        return this._normalizeSlashPath(value).replace(/^\/+|\/+$/g, '');
    }

    _escapeRegex(value = '') {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _buildRelativePath(currentUrl = '/', proxyBasePath = '') {
        if (!proxyBasePath) {
            return currentUrl || '/';
        }

        const normalizedUrl = String(currentUrl || '/');
        return normalizedUrl.replace(new RegExp(`^${this._escapeRegex(proxyBasePath)}`), '') || '/';
    }

    _readForwardedHeader(req, headerName) {
        const headerValue = req?.headers?.[headerName];
        if (Array.isArray(headerValue)) {
            return String(headerValue[0] || '').split(',')[0].trim();
        }
        return String(headerValue || '').split(',')[0].trim();
    }

    _getForwardedProto(req) {
        const forwardedProto = this._readForwardedHeader(req, 'x-forwarded-proto');
        if (forwardedProto) {
            return forwardedProto;
        }
        if (req?.protocol) {
            return req.protocol;
        }
        return req?.socket?.encrypted ? 'https' : 'http';
    }

    _getForwardedHost(req) {
        return this._readForwardedHeader(req, 'x-forwarded-host')
            || this._readForwardedHeader(req, 'host')
            || '';
    }

    _getForwardedFor(req) {
        const forwardedFor = req?.headers?.['x-forwarded-for'];
        if (Array.isArray(forwardedFor)) {
            return forwardedFor.join(', ');
        }
        return String(forwardedFor || req?.ip || req?.socket?.remoteAddress || '').trim();
    }

    _getUpstreamHttpClient(targetUrl) {
        return targetUrl.protocol === 'https:' ? https : http;
    }

    _buildProxyTargetUrl(relativePath = '', query = {}) {
        const upstream = new URL(this.embyUrl);
        const [pathnamePart, queryString = ''] = String(relativePath || '/').split('?');
        upstream.pathname = path.posix.join(upstream.pathname || '/', pathnamePart || '/');
        const searchParams = new URLSearchParams(queryString);
        for (const [key, value] of Object.entries(query || {})) {
            if (value == null) {
                continue;
            }
            if (Array.isArray(value)) {
                for (const item of value) {
                    searchParams.append(key, item);
                }
                continue;
            }
            if (!searchParams.has(key)) {
                searchParams.set(key, String(value));
            }
        }
        upstream.search = searchParams.toString();
        return upstream.toString();
    }

    async _readRequestBody(req) {
        if (['GET', 'HEAD'].includes(String(req.method || 'GET').toUpperCase())) {
            return null;
        }

        if (Buffer.isBuffer(req.body)) {
            return req.body;
        }

        if (typeof req.body === 'string') {
            return Buffer.from(req.body);
        }

        if (req.body && typeof req.body === 'object' && !req.readable) {
            const contentType = String(req.headers['content-type'] || '').toLowerCase();
            if (contentType.includes('application/json')) {
                return Buffer.from(JSON.stringify(req.body));
            }
            if (contentType.includes('application/x-www-form-urlencoded')) {
                return Buffer.from(querystring.stringify(req.body));
            }
        }

        const chunks = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (!chunks.length) {
            return Buffer.alloc(0);
        }
        return Buffer.concat(chunks);
    }

    async _forwardToEmby(req, res, relativePath, proxyBasePath = '/emby-proxy') {
        const targetUrl = this._buildProxyTargetUrl(relativePath);
        const body = await this._readRequestBody(req);
        const headers = {
            ...req.headers,
            host: undefined,
            connection: undefined,
            'content-length': undefined,
            'transfer-encoding': undefined,
            'x-forwarded-host': this._getForwardedHost(req),
            'x-forwarded-proto': this._getForwardedProto(req),
            'x-forwarded-for': this._getForwardedFor(req)
        };
        if (body) {
            headers['content-length'] = String(body.length);
        }
        const options = {
            method: req.method,
            headers,
            throwHttpErrors: false,
            followRedirect: false,
            decompress: false
        };
        if (body) {
            options.body = body;
        }

        const upstream = got.stream(targetUrl, options);
        upstream.on('response', (response) => {
            res.status(response.statusCode || 502);
            for (const [key, value] of Object.entries(response.headers)) {
                if (value == null || key.toLowerCase() === 'content-length') {
                    continue;
                }
                if (key.toLowerCase() === 'location') {
                    res.setHeader(key, this._rewriteProxyLocation(this._resolveUpstreamLocation(String(value), targetUrl), proxyBasePath));
                    continue;
                }
                res.setHeader(key, value);
            }
        });
        upstream.on('error', (error) => {
            if (!res.headersSent) {
                res.status(502).json({ success: false, error: `Emby反代请求失败: ${error.message}` });
            }
        });
        upstream.pipe(res);
    }

    _resolveUpstreamLocation(location, targetUrl) {
        try {
            return new URL(location, targetUrl).toString();
        } catch (error) {
            return location;
        }
    }

    async _forwardWebSocket(req, socket, head, relativePath) {
        const targetUrl = new URL(this._buildProxyTargetUrl(relativePath));
        const upstreamClient = this._getUpstreamHttpClient(targetUrl);
        const headers = {
            ...req.headers,
            host: targetUrl.host,
            'x-forwarded-host': this._getForwardedHost(req),
            'x-forwarded-proto': this._getForwardedProto(req),
            'x-forwarded-for': this._getForwardedFor(req)
        };

        const requestOptions = {
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            method: req.method || 'GET',
            path: `${targetUrl.pathname}${targetUrl.search}`,
            headers
        };

        await new Promise((resolve, reject) => {
            const upstreamRequest = upstreamClient.request(requestOptions);
            let upgraded = false;

            upstreamRequest.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
                upgraded = true;
                const statusCode = upstreamResponse.statusCode || 101;
                const statusMessage = upstreamResponse.statusMessage || 'Switching Protocols';
                const responseHeaders = [`HTTP/1.1 ${statusCode} ${statusMessage}`];

                for (const [key, value] of Object.entries(upstreamResponse.headers || {})) {
                    if (value == null) {
                        continue;
                    }
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            responseHeaders.push(`${key}: ${item}`);
                        }
                        continue;
                    }
                    responseHeaders.push(`${key}: ${value}`);
                }

                socket.write(`${responseHeaders.join('\r\n')}\r\n\r\n`);
                if (head?.length) {
                    upstreamSocket.write(head);
                }
                if (upstreamHead?.length) {
                    socket.write(upstreamHead);
                }

                upstreamSocket.pipe(socket);
                socket.pipe(upstreamSocket);

                upstreamSocket.on('error', (error) => {
                    logTaskEvent(`Emby上游 WebSocket 异常: ${error.message}`);
                    socket.destroy(error);
                });
                socket.on('error', () => {
                    upstreamSocket.destroy();
                });
                resolve();
            });

            upstreamRequest.on('response', (upstreamResponse) => {
                if (upgraded) {
                    return;
                }
                const statusCode = upstreamResponse.statusCode || 502;
                const statusMessage = upstreamResponse.statusMessage || 'Bad Gateway';
                const responseHeaders = [`HTTP/1.1 ${statusCode} ${statusMessage}`];

                for (const [key, value] of Object.entries(upstreamResponse.headers || {})) {
                    if (value == null) {
                        continue;
                    }
                    if (Array.isArray(value)) {
                        for (const item of value) {
                            responseHeaders.push(`${key}: ${item}`);
                        }
                        continue;
                    }
                    responseHeaders.push(`${key}: ${value}`);
                }

                socket.write(`${responseHeaders.join('\r\n')}\r\n\r\n`);
                upstreamResponse.pipe(socket);
                resolve();
            });

            upstreamRequest.on('error', reject);
            upstreamRequest.end();
        });
    }

    _writeUpgradeError(socket, statusCode, message) {
        if (!socket || socket.destroyed) {
            return;
        }
        const body = String(message || 'Bad Gateway');
        const statusText = statusCode >= 500 ? 'Bad Gateway' : 'Service Unavailable';
        socket.end(
            `HTTP/1.1 ${statusCode} ${statusText}\r\n`
            + 'Connection: close\r\n'
            + 'Content-Type: text/plain; charset=utf-8\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\n`
            + '\r\n'
            + body
        );
    }

    _rewriteProxyLocation(location, proxyBasePath = '/emby-proxy') {
        if (!location || !this.embyUrl) {
            return location;
        }
        if (location.startsWith(this.embyUrl)) {
            return `${proxyBasePath}${location.substring(this.embyUrl.length) || '/'}`;
        }
        if (location.startsWith('/') && proxyBasePath && !location.startsWith(proxyBasePath)) {
            return `${proxyBasePath}${location}`;
        }
        return location;
    }

    async _resolvePlaybackDirectUrl(requestPath, query = {}) {
        const itemId = this._extractItemId(requestPath);
        if (!itemId) {
            throw new Error('未解析到 Emby 媒体项 ID');
        }
        return await this.resolveDirectUrlByItemId(itemId, query.MediaSourceId || query.mediaSourceId || '');
    }

    async resolveDirectUrlByItemId(itemId, mediaSourceId = '') {
        const item = await this.getItemById(itemId);
        if (!item) {
            throw new Error(`未获取到 Emby 媒体项: ${itemId}`);
        }

        const mediaPath = this._resolveMediaPath(item, mediaSourceId);
        if (!mediaPath) {
            throw new Error(`Emby 媒体项缺少可用路径: ${itemId}`);
        }

        const streamProxyUrl = await this._resolveStreamProxyMediaUrl(mediaPath);
        if (streamProxyUrl) {
            return streamProxyUrl;
        }

        const matchedTask = await this._findTaskByItemPath(mediaPath);
        if (!matchedTask) {
            throw new Error(`未找到与 Emby 路径对应的任务: ${mediaPath}`);
        }

        const cloud189 = Cloud189Service.getInstance(matchedTask.task.account);
        const allFiles = await this._taskService.getAllFolderFiles(cloud189, matchedTask.task);
        const targetFile = this._matchCloudFile(allFiles, matchedTask.relativePath, mediaPath);
        if (!targetFile?.id) {
            throw new Error(`未找到对应的网盘文件: ${mediaPath}`);
        }

        logTaskEvent(`Emby反代命中任务[${matchedTask.task.resourceName}]，文件: ${targetFile.name}`);
        return await cloud189.getDownloadLink(targetFile.id);
    }

    _resolveMediaPath(item, mediaSourceId = '') {
        const mediaSources = Array.isArray(item?.MediaSources) ? item.MediaSources : [];
        if (mediaSourceId) {
            const matchedSource = mediaSources.find((source) => String(source.Id) === String(mediaSourceId));
            if (matchedSource?.Path) {
                return this._normalizeMediaPath(matchedSource.Path);
            }
        }
        if (mediaSources[0]?.Path) {
            return this._normalizeMediaPath(mediaSources[0].Path);
        }
        return item?.Path ? this._normalizeMediaPath(item.Path) : '';
    }

    _normalizeMediaPath(value = '') {
        const rawValue = String(value || '').trim();
        if (/^https?:\/\//i.test(rawValue)) {
            return rawValue;
        }
        return this._normalizeSlashPath(rawValue);
    }

    _extractStreamProxyToken(mediaPath = '') {
        const normalizedMediaPath = String(mediaPath || '').trim();
        const match = normalizedMediaPath.match(/\/api\/stream\/([^/?#]+)/i);
        return match?.[1] || null;
    }

    async _resolveStreamProxyMediaUrl(mediaPath = '') {
        const token = this._extractStreamProxyToken(mediaPath);
        if (!token) {
            return '';
        }

        const payload = this._streamProxyService.parseToken(token);
        if (payload.type === 'lazyShare') {
            return await this._lazyShareStrmService.resolveLatestUrlByPayload(payload);
        }
        return await this._streamProxyService.resolveLatestUrlByPayload(payload);
    }

    async _findTaskByItemPath(itemPath) {
        const accounts = await this._accountRepo.find({
            where: [
                { embyPathReplace: Not(IsNull()) }
            ]
        });

        for (const account of accounts) {
            const mappedPath = this._mapEmbyPathToCloudPath(itemPath, account.embyPathReplace);
            if (!mappedPath) {
                continue;
            }

            const tasks = await this._taskRepo.find({
                where: {
                    accountId: account.id
                },
                relations: {
                    account: true
                },
                select: {
                    account: {
                        username: true,
                        password: true,
                        cookies: true,
                        localStrmPrefix: true,
                        cloudStrmPrefix: true,
                        embyPathReplace: true,
                        accountType: true,
                        familyId: true
                    }
                }
            });

            const matchedTask = this._pickBestTask(tasks, mappedPath);
            if (matchedTask) {
                return matchedTask;
            }
        }

        return null;
    }

    _mapEmbyPathToCloudPath(itemPath, embyPathReplace = '') {
        const normalizedItemPath = this._normalizeSlashPath(itemPath);
        const replaceRules = String(embyPathReplace || '').split(';').map(rule => rule.trim()).filter(Boolean);
        for (const rule of replaceRules) {
            const parts = rule.split(':');
            if (parts.length < 2) {
                continue;
            }
            const cloudPrefix = this._normalizeSlashPath(parts[0]);
            const embyPrefix = this._normalizeSlashPath(parts.slice(1).join(':'));
            if (!embyPrefix || !normalizedItemPath.startsWith(embyPrefix)) {
                continue;
            }
            return this._trimSlashPath(normalizedItemPath.replace(embyPrefix, cloudPrefix));
        }
        return '';
    }

    _pickBestTask(tasks, mappedPath) {
        const normalizedMappedPath = this._trimSlashPath(mappedPath);
        const candidates = tasks
            .map((task) => {
                const normalizedTaskPath = this._trimSlashPath(task.realFolderName || '');
                if (!normalizedTaskPath) {
                    return null;
                }
                if (
                    normalizedMappedPath === normalizedTaskPath
                    || normalizedMappedPath.startsWith(`${normalizedTaskPath}/`)
                ) {
                    const relativePath = normalizedMappedPath
                        .substring(normalizedTaskPath.length)
                        .replace(/^\/+/, '');
                    return {
                        task,
                        relativePath,
                        matchLength: normalizedTaskPath.length
                    };
                }
                return null;
            })
            .filter(Boolean)
            .sort((left, right) => right.matchLength - left.matchLength);

        return candidates[0] || null;
    }

    _matchCloudFile(files, relativePath, itemPath) {
        const normalizedRelativePath = this._trimSlashPath(relativePath);
        if (normalizedRelativePath) {
            const exactFile = files.find((file) => this._trimSlashPath(file.relativePath || '') === normalizedRelativePath);
            if (exactFile) {
                return exactFile;
            }
        }

        const itemFileName = path.basename(this._normalizeSlashPath(itemPath));
        return files.find((file) => file.name === itemFileName)
            || files.find((file) => path.parse(file.name).name === path.parse(itemFileName).name)
            || null;
    }

    // 统一请求接口
    async request(url, options) {
        this._refreshConfig();
        try {
            const headers = {
                'Authorization': 'MediaBrowser Token="' + this.embyApiKey + '"',
            }
            const response = await got(url, {
                method: options.method,
                headers: headers,
                responseType: 'json',
                searchParams: options?.searchParams,
                form: options?.form,
                json: options?.json,
                throwHttpErrors: false // 禁用自动抛出HTTP错误
            });

            if (response.statusCode === 401) {
                logTaskEvent(`Emby认证失败: API Key无效`);
                return null;
            } else if (response.statusCode < 200 || response.statusCode >= 300) {
                logTaskEvent(`Emby接口请求失败: 状态码 ${response.statusCode}`);
                return null;
            }
            return response.body;
        } catch (error) {
            logTaskEvent(`Emby接口请求异常: ${error.message}`);
            return null;
        }
    }

    // 处理媒体名称，去除年份、清晰度等信息
    _cleanMediaName(name) {
        return name
            // 移除括号内的年份，如：沙尘暴 (2025)
            .replace(/\s*[\(\[【］\[]?\d{4}[\)\]】］\]]?\s*/g, '')
            // 移除清晰度标识，如：4K、1080P、720P等
            .replace(/\s*[0-9]+[Kk](?![a-zA-Z])/g, '')
            .replace(/\s*[0-9]+[Pp](?![a-zA-Z])/g, '')
            // 移除其他常见标识，如：HDR、HEVC等
            .replace(/\s*(HDR|HEVC|H265|H264|X265|X264|REMUX)\s*/gi, '')
            // 移除额外的空格
            .trim();
    }
    // 路径替换
    _replacePath(path) {
        if (!path.startsWith('/')) {
            path = '/' + path;
        }
        if (this.embyPathReplace) {
            const pathReplaceArr = this.embyPathReplace.split(';');
            for (let i = 0; i < pathReplaceArr.length; i++) {
                const pathReplace = pathReplaceArr[i].split(':');
                path = path.replace(pathReplace[0], pathReplace[1]);
            }
        }
        // 如果结尾有斜杠, 则移除
        path = path.replace(/\/+$/, '');
        return path;
    }


    /**
     * 处理来自 Emby 的 Webhook 通知
     * @param {object} payload - Webhook 的 JSON 数据
     */
    async handleWebhookNotification(payload) {
        logTaskEvent(`收到 Emby Webhook 通知: ${payload.Event}`);

        // 我们只关心删除事件
        // Emby 原生删除事件: library.deleted library.new(新剧集入库)
        const supportedEvents = ['library.deleted'];

        if (!supportedEvents.includes(payload.Event?.toLowerCase())) {
            // logTaskEvent(`忽略不相关的 Emby 事件: ${payload.Event}`);
            return;
        }

        let itemPath = payload.Item?.Path;
        if (!itemPath) {
            logTaskEvent('Webhook 通知中缺少有效的 Item.Path');
            return;
        }
        const isFolder = payload.Item?.IsFolder;
        const type = payload.Item?.Type;

        logTaskEvent(`检测到删除事件，路径: ${itemPath}, 类型: ${type}, 是否文件夹: ${isFolder}`);

        try {
            // 根据path获取对应的task
            // 1. 首先获取所有embyPathReplacex不为空的account
            const accounts = await this._accountRepo.find({
                where: [
                    { embyPathReplace: Not(IsNull()) }
                ]
            })
            // 2. 遍历accounts, 检查path是否包含embyPathReplace(本地路径) embyPathReplace的内容为: xx(网盘路径):xxx(本地路径)
            const tasks = [];
            for (const account of accounts) {
                let embyPathReplace = account.embyPathReplace.split(':');
                let embyPath = ""
                let cloudPath = embyPathReplace[0]
                if (embyPathReplace.length === 2) {
                    embyPath = embyPathReplace[1]
                }
                // 检查itemPath是否是embyPath开头
                if (itemPath.startsWith(embyPath)) {
                    // 将itemPath中的embyPath替换为cloudPath 并且去掉首尾的/
                    itemPath = itemPath.replace(embyPath, cloudPath).replace(/^\/+|\/+$/g, '');
                    if (!isFolder) {
                        // 剧集, 需要去掉文件名
                        itemPath = path.dirname(itemPath);
                    }
                    const task = await this._taskRepo.findOne({
                        where: {
                            accountId: account.id,
                            realFolderName: Like(`%${itemPath}%`)
                        },
                        relations: {
                            account: true
                        },
                        select: {
                            account: {
                                username: true,
                                password: true,
                                cookies: true,
                                localStrmPrefix: true,
                                cloudStrmPrefix: true,
                                embyPathReplace: true
                            }
                        }
                    })
                    if (task) {
                        tasks.push(task);
                    }   
                }
            }
            if (tasks.length === 0) {
                logTaskEvent(`未找到对应的任务, 路径: ${itemPath}`);
                return;
            }
            logTaskEvent(`找到对应的任务, 任务数量: ${tasks.length}, 任务名称: ${tasks.map(task => task.resourceName).join(', ')}`);
            // 4. 遍历tasks, 删除本地strm, 删除任务和网盘
            for (const task of tasks) {
                if (!isFolder) {
                    // 如果是剧集文件，只删除对应的单个文件
                    logTaskEvent(`删除单个剧集文件, 任务id: ${task.id}, 文件路径: ${itemPath}`);
                    const cloud189 = Cloud189Service.getInstance(task.account);
                    const folderInfo = await cloud189.listFiles(task.realFolderId);
                    if (!folderInfo || !folderInfo.fileListAO) {
                        logTaskEvent(`未找到对应的网盘文件列表: 跳过删除`);
                        continue;
                    }
                    const fileList = [...(folderInfo.fileListAO.fileList || [])];
                    const fileName = path.basename(itemPath);
                    const fileNameWithoutExt = path.parse(fileName).name;
                    const targetFile = fileList.find(file => path.parse(file.name).name === fileNameWithoutExt);
                    if (targetFile) {
                        await this._taskService.deleteCloudFile(cloud189, {
                            id: targetFile.id,
                            name: targetFile.name
                        }, false)
                        logTaskEvent(`成功删除文件: ${fileName}`);
                    } else {
                        logTaskEvent(`未找到对应的网盘文件: ${fileName}`);
                    }
                }else{
                    logTaskEvent(`删除任务和网盘, 任务id: ${task.id}`);
                    // 删掉任务并且删掉网盘
                    this._taskService.deleteTasks(tasks.map(task => task.id), true)
                }
            }


        } catch (error) {
            logTaskEvent(`处理 Emby Webhook 时发生错误: ${error.message}`);
            console.error('处理 Emby Webhook 异常:', error);
        }
    }

}
module.exports = { EmbyService };
