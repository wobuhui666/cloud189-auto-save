const got = require('got');
const ConfigService = require('./ConfigService');
const { buildMultipartBody, normalizeWhitespace, safeFileName } = require('./ptUtils');

class QbittorrentService {
    constructor() {
        this.sid = '';
    }

    getConfig() {
        return ConfigService.getConfigValue('pt.qbittorrent', {}) || {};
    }

    getBaseUrl() {
        const baseUrl = String(this.getConfig().baseUrl || '').trim();
        if (!baseUrl) {
            throw new Error('qBittorrent 地址未配置');
        }
        const normalized = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`;
        return normalized.replace(/\/+$/g, '');
    }

    _getCommonHeaders(extraHeaders = {}) {
        const baseUrl = this.getBaseUrl();
        return {
            Referer: `${baseUrl}/`,
            Origin: baseUrl,
            Cookie: this.sid ? `SID=${this.sid}` : '',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            ...extraHeaders
        };
    }

    _getRequestOptions(extraOptions = {}) {
        return {
            throwHttpErrors: false,
            timeout: { request: 15000 },
            https: {
                rejectUnauthorized: !this.getConfig().insecureSkipTlsVerify
            },
            ...extraOptions
        };
    }

    async login(force = false) {
        if (this.sid && !force) {
            return this.sid;
        }
        const { username, password } = this.getConfig();
        if (!username || !password) {
            throw new Error('qBittorrent 用户名或密码未配置');
        }
        const response = await got.post(`${this.getBaseUrl()}/api/v2/auth/login`, this._getRequestOptions({
            form: { username, password },
            headers: this._getCommonHeaders()
        }));
        const setCookie = response.headers['set-cookie'];
        const body = String(response.body || '').trim();
        if (response.statusCode === 403) {
            throw new Error('qBittorrent 登录被拒绝，可能触发了 WebUI 登录封禁');
        }
        if (!setCookie || !Array.isArray(setCookie)) {
            if (/Fails/i.test(body)) {
                throw new Error('qBittorrent 登录失败');
            }
            throw new Error('qBittorrent 登录未返回 SID');
        }
        const sidCookie = setCookie.find((cookie) => cookie.startsWith('SID='));
        if (!sidCookie) {
            throw new Error('qBittorrent 登录未返回有效 SID');
        }
        this.sid = sidCookie.split(';')[0].slice(4);
        return this.sid;
    }

    async _request(method, apiPath, options = {}, retryOnAuthError = true) {
        await this.login();
        const response = await got(`${this.getBaseUrl()}${apiPath}`, this._getRequestOptions({
            method,
            headers: this._getCommonHeaders(options.headers),
            searchParams: options.searchParams,
            form: options.form,
            body: options.body,
            responseType: options.responseType || 'text'
        }));
        if ((response.statusCode === 401 || response.statusCode === 403) && retryOnAuthError) {
            await this.login(true);
            return this._request(method, apiPath, options, false);
        }
        if (response.statusCode >= 400) {
            throw new Error(`qBittorrent 请求失败(${response.statusCode}): ${String(response.body || '').trim() || apiPath}`);
        }
        return response;
    }

    async testConnection() {
        await this.login(true);
        const versionResponse = await this._request('GET', '/api/v2/app/version');
        const apiVersionResponse = await this._request('GET', '/api/v2/app/webapiVersion');
        return {
            version: String(versionResponse.body || '').trim(),
            apiVersion: String(apiVersionResponse.body || '').trim()
        };
    }

    async listTorrents(searchParams = {}) {
        const response = await this._request('GET', '/api/v2/torrents/info', {
            responseType: 'json',
            searchParams
        });
        return Array.isArray(response.body) ? response.body : [];
    }

    async getTorrent(hash) {
        if (!hash) {
            return null;
        }
        const torrents = await this.listTorrents();
        return torrents.find((torrent) => String(torrent.hash || '').toUpperCase() === String(hash).toUpperCase()) || null;
    }

    async getTorrentFiles(hash) {
        const response = await this._request('GET', '/api/v2/torrents/files', {
            responseType: 'json',
            searchParams: { hash }
        });
        return Array.isArray(response.body) ? response.body : [];
    }

    async ensureCategory(category, savePath = '') {
        if (!category) {
            return;
        }
        const existingCategories = await this._request('GET', '/api/v2/torrents/categories', {
            responseType: 'json'
        });
        const categoryMap = existingCategories.body || {};
        const current = categoryMap[category];
        if (!current) {
            await this._request('POST', '/api/v2/torrents/createCategory', {
                form: { category, savePath }
            });
            return;
        }
        const currentSavePath = String(current.savePath || '').trim();
        if (savePath && currentSavePath !== savePath) {
            await this._request('POST', '/api/v2/torrents/editCategory', {
                form: { category, savePath }
            });
        }
    }

    async ensureTag(tag) {
        if (!tag) {
            return;
        }
        await this._request('POST', '/api/v2/torrents/createTags', {
            form: { tags: tag }
        });
    }

    async addTorrent(options = {}) {
        const urls = Array.isArray(options.urls)
            ? options.urls.filter(Boolean)
            : (options.url ? [options.url] : []);
        if (!urls.length && !options.torrentBuffer) {
            throw new Error('缺少可添加的种子来源');
        }

        if (options.category) {
            await this.ensureCategory(options.category, options.savePath || '');
        }
        if (options.tag) {
            await this.ensureTag(options.tag);
        }

        const fields = {
            savepath: options.savePath || '',
            category: options.category || '',
            tags: options.tag || '',
            paused: 'false',
            autoTMM: 'false',
            sequentialDownload: options.sequentialDownload === false ? 'false' : 'true',
            firstLastPiecePrio: options.firstLastPiecePrio === false ? 'false' : 'true',
            root_folder: options.rootFolder === false ? 'false' : 'true',
            rename: options.rename || ''
        };
        if (urls.length) {
            fields.urls = urls.join('\n');
        }

        const files = [];
        if (options.torrentBuffer) {
            files.push({
                fieldName: 'torrents',
                fileName: safeFileName(options.torrentFileName || 'release.torrent'),
                contentType: 'application/x-bittorrent',
                content: options.torrentBuffer
            });
        }

        const multipart = buildMultipartBody(fields, files);
        const response = await this._request('POST', '/api/v2/torrents/add', {
            body: multipart.body,
            headers: {
                'Content-Type': multipart.contentType
            }
        });
        const body = String(response.body || '').trim();
        if (/Fails/i.test(body)) {
            throw new Error(`qBittorrent 加种失败: ${body}`);
        }

        let torrent = null;
        if (options.infoHash) {
            torrent = await this.waitForTorrentByHash(options.infoHash, 10000);
        }
        if (!torrent && options.tag) {
            torrent = await this.waitForTorrentByTag(options.tag, 10000);
        }
        return torrent;
    }

    async waitForTorrentByHash(hash, timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const torrent = await this.getTorrent(hash);
            if (torrent) {
                return torrent;
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
        }
        return null;
    }

    async waitForTorrentByTag(tag, timeoutMs = 10000) {
        const normalizedTag = normalizeWhitespace(tag);
        if (!normalizedTag) {
            return null;
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const torrents = await this.listTorrents({ tag: normalizedTag });
            if (torrents.length > 0) {
                torrents.sort((left, right) => Number(right.added_on || 0) - Number(left.added_on || 0));
                return torrents[0];
            }
            await new Promise((resolve) => setTimeout(resolve, 800));
        }
        return null;
    }

    async deleteTorrent(hash, deleteFiles = true) {
        if (!hash) {
            return;
        }
        await this._request('POST', '/api/v2/torrents/delete', {
            form: {
                hashes: hash,
                deleteFiles: deleteFiles ? 'true' : 'false'
            }
        });
    }
}

module.exports = { QbittorrentService };
