const got = require('got');
const crypto = require('crypto');
const ConfigService = require('../../services/ConfigService');
const Cloud189Utils = require('../../utils/Cloud189Utils');
const ProxyUtil = require('../../utils/ProxyUtil');
const { logTaskEvent } = require('../../utils/logUtils');
const { TMDBService } = require('../../services/tmdb');

type HdhiveMediaType = 'movie' | 'tv' | 'unknown';

interface HdhiveSearchItem {
    id: string;
    title: string;
    originalTitle: string;
    year: string;
    type: HdhiveMediaType;
    overview: string;
    posterPath: string;
    backdropPath: string;
    videoResolution: string;
    shareNum: number;
    pageUrl: string;
    shareLink: string;
    accessCode: string;
    source: 'hdhive' | 'tmdb';
    tmdbId?: string;
}

interface HdhiveSearchResult {
    items: HdhiveSearchItem[];
    directLinkCount: number;
    loginRequired: boolean;
    warning: string;
}

interface HdhiveCookieRequestOptions {
    method?: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    json?: any;
    accept?: string;
    responseType?: 'json' | 'text';
    followRedirect?: boolean;
    skipRefresh?: boolean;
}

interface HdhiveBridgeRequestOptions {
    method?: 'GET' | 'POST';
    json?: any;
    searchParams?: Record<string, string | number | boolean>;
}

const AUTH_ENDPOINTS = {
    refresh: '/api/public/auth/refresh'
};

const SERVER_ACTIONS = {
    resourceUnlock: {
        id: '601a2054beb3034dd490287f5aa0d7c801f9e650c7',
        name: 'resourceUnlock'
    }
};

const CLOUD_TYPE_MAP: Record<string, { name: string; icon: string; color: string }> = {
    '115': { name: '115网盘', icon: '115', color: '#2196F3' },
    '123': { name: '123云盘', icon: '123', color: '#FF9800' },
    quark: { name: '夸克网盘', icon: 'quark', color: '#9C27B0' },
    baidu: { name: '百度网盘', icon: 'baidu', color: '#06A7FF' },
    ali: { name: '阿里云盘', icon: 'ali', color: '#FF6A00' },
    xunlei: { name: '迅雷云盘', icon: 'xunlei', color: '#0D47A1' },
    pikpak: { name: 'PikPak', icon: 'pikpak', color: '#E91E63' },
    cloud189: { name: '天翼云盘', icon: 'cloud189', color: '#FF6B00' },
    lenovo: { name: '联想云盘', icon: 'lenovo', color: '#E31837' },
    unknown: { name: '未知网盘', icon: 'default', color: '#666' }
};

class HdhiveCookieJar {
    private readonly cookies = new Map<string, string>();

    constructor(cookieHeader = '') {
        if (cookieHeader) {
            this.seed(cookieHeader);
        }
    }

    seed(cookieHeader: string): void {
        for (const part of String(cookieHeader || '').split(';')) {
            const [name, ...valueParts] = part.trim().split('=');
            if (!name || valueParts.length === 0) continue;
            this.cookies.set(name, valueParts.join('='));
        }
    }

    get(name: string): string {
        return this.cookies.get(name) || '';
    }

    mergeSetCookie(setCookie: string | string[] | undefined): void {
        const values = Array.isArray(setCookie) ? setCookie : this.splitSetCookieHeader(setCookie);
        for (const value of values) {
            const [pair] = String(value || '').split(';');
            const [name, ...valueParts] = pair.trim().split('=');
            if (!name || valueParts.length === 0) continue;
            this.cookies.set(name, valueParts.join('='));
        }
    }

    toHeader(): string {
        return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    private splitSetCookieHeader(header?: string): string[] {
        if (!header) return [];
        const result: string[] = [];
        let start = 0;
        let inExpires = false;
        for (let index = 0; index < header.length; index += 1) {
            const chunk = header.slice(index, index + 8).toLowerCase();
            if (chunk === 'expires=') {
                inExpires = true;
            }
            const char = header[index];
            if (char === ';' && inExpires) {
                inExpires = false;
            }
            if (char === ',' && !inExpires) {
                result.push(header.slice(start, index).trim());
                start = index + 1;
            }
        }
        result.push(header.slice(start).trim());
        return result.filter(Boolean);
    }
}

class HdhiveSDK {
    private cache = new Map<string, { data: any; expireAt: number }>();
    private oauthStates = new Map<string, { redirectUri: string; expireAt: number }>();
    private readonly cacheTTL = 5 * 60 * 1000;
    private readonly stateTTL = 10 * 60 * 1000;

    private get baseUrl(): string {
        const configured = ConfigService.getConfigValue('hdhive.baseUrl') || process.env.HDHIVE_BASE_URL || 'https://hdhive.com';
        return String(configured || '').replace(/\/+$/, '') || 'https://hdhive.com';
    }

    private get cookie(): string {
        return String(ConfigService.getConfigValue('hdhive.cookie') || process.env.HDHIVE_COOKIE || '').trim();
    }

    private get username(): string {
        return String(ConfigService.getConfigValue('hdhive.username') || process.env.HDHIVE_USERNAME || '').trim();
    }

    private get password(): string {
        return String(ConfigService.getConfigValue('hdhive.password') || process.env.HDHIVE_PASSWORD || '');
    }

    private get clientId(): string {
        return String(ConfigService.getConfigValue('hdhive.clientId') || process.env.HDHIVE_CLIENT_ID || '').trim();
    }

    private get apiKey(): string {
        return String(ConfigService.getConfigValue('hdhive.apiKey') || process.env.HDHIVE_API_KEY || '').trim();
    }

    private get resourceUnlockActionId(): string {
        return String(
            ConfigService.getConfigValue('hdhive.resourceUnlockActionId')
            || process.env.HDHIVE_RESOURCE_UNLOCK_ACTION_ID
            || SERVER_ACTIONS.resourceUnlock.id
        ).trim();
    }

    private get accessToken(): string {
        return String(ConfigService.getConfigValue('hdhive.accessToken') || '').trim();
    }

    private get refreshToken(): string {
        return String(ConfigService.getConfigValue('hdhive.refreshToken') || '').trim();
    }

    private get tokenExpiresAt(): number {
        return Number(ConfigService.getConfigValue('hdhive.tokenExpiresAt') || 0);
    }

    private get browserBridgeBaseUrl(): string {
        return String(ConfigService.getConfigValue('hdhive.browserBridge.baseUrl') || process.env.HDHIVE_BROWSER_BRIDGE_URL || '').replace(/\/+$/, '').trim();
    }

    private get browserBridgeToken(): string {
        return String(ConfigService.getConfigValue('hdhive.browserBridge.token') || process.env.HDHIVE_BROWSER_BRIDGE_TOKEN || '').trim();
    }

    private get browserBridgeEnabled(): boolean {
        const configured = ConfigService.getConfigValue('hdhive.browserBridge.enabled');
        return (configured === true || process.env.HDHIVE_BROWSER_BRIDGE_ENABLED === 'true' || !!this.browserBridgeBaseUrl) && !!this.browserBridgeBaseUrl;
    }

    get enabled(): boolean {
        return !!ConfigService.getConfigValue('hdhive.enabled') && !!this.baseUrl;
    }

    get isAuthorized(): boolean {
        return !!this.accessToken && this.tokenExpiresAt > Date.now();
    }

    get needsOAuth(): boolean {
        return !!this.clientId && !!this.apiKey && !this.isAuthorized;
    }

    clearCache(): void {
        this.cache.clear();
    }

    getAuthStatus() {
        return {
            enabled: this.enabled,
            baseUrl: this.baseUrl,
            hasCookie: !!this.cookie,
            hasCsrfToken: !!this.createCookieJar().get('csrf_access_token'),
            hasUsername: !!this.username,
            hasPassword: !!this.password,
            hasClient: !!this.clientId,
            hasApiKey: !!this.apiKey,
            cookieModeAvailable: !!this.cookie,
            browserBridge: {
                enabled: this.browserBridgeEnabled,
                baseUrl: this.browserBridgeBaseUrl,
                hasToken: !!this.browserBridgeToken,
                canLogin: this.browserBridgeEnabled && !!this.browserBridgeToken && !!this.username && !!this.password
            },
            signedCustomerApiAvailable: this.browserBridgeEnabled && !!this.browserBridgeToken,
            resourceUnlockActionConfigured: !!this.resourceUnlockActionId,
            isAuthorized: this.isAuthorized,
            needsOAuth: this.needsOAuth,
            tokenExpiresAt: this.tokenExpiresAt || null
        };
    }

    private getProxyAgent(): any {
        return ProxyUtil.getProxyAgent('hdhive');
    }

    private buildUrl(pathname: string): string {
        if (/^https?:\/\//i.test(pathname)) {
            return pathname;
        }
        return `${this.baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
    }

    private buildBridgeUrl(pathname: string): string {
        if (!this.browserBridgeBaseUrl) {
            throw new Error('影巢 Browser Bridge 地址未配置');
        }
        return `${this.browserBridgeBaseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
    }

    private async bridgeRequest(pathname: string, options: HdhiveBridgeRequestOptions = {}): Promise<any> {
        if (!this.browserBridgeEnabled) {
            return { success: false, error: '影巢 Browser Bridge 未启用' };
        }
        if (!this.browserBridgeToken) {
            return { success: false, error: '影巢 Browser Bridge Token 未配置' };
        }
        const requestOptions: any = {
            method: options.method || 'GET',
            headers: {
                'x-bridge-token': this.browserBridgeToken
            },
            responseType: 'json',
            timeout: { request: 60000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        };
        if (options.json !== undefined) {
            requestOptions.json = options.json;
        }
        if (options.searchParams !== undefined) {
            requestOptions.searchParams = options.searchParams;
        }
        const response = await got(this.buildBridgeUrl(pathname), requestOptions);
        const body: any = response.body || {};
        if (response.statusCode >= 400 || body.success === false) {
            return { success: false, error: body.error || body.message || `Browser Bridge HTTP ${response.statusCode}`, data: body.data };
        }
        return body;
    }

    private persistCookieHeader(cookieHeader: string): void {
        const nextCookie = String(cookieHeader || '').trim();
        if (!nextCookie || nextCookie === this.cookie || process.env.HDHIVE_COOKIE) {
            return;
        }
        ConfigService.setConfigValue('hdhive.cookie', nextCookie);
    }

    async loginWithPassword(username = this.username, password = this.password) {
        if (!this.browserBridgeEnabled) {
            return { success: false, error: '影巢 Browser Bridge 未启用，无法使用账号密码网页登录' };
        }
        const normalizedUsername = String(username || '').trim();
        const normalizedPassword = String(password || '');
        if (!normalizedUsername || !normalizedPassword) {
            return { success: false, error: '影巢账号或密码未配置' };
        }
        const result = await this.bridgeRequest('/hdhive/login', {
            method: 'POST',
            json: {
                username: normalizedUsername,
                password: normalizedPassword
            }
        });
        if (!result.success) {
            return result;
        }
        this.persistCookieHeader(result.data?.cookieHeader || '');
        this.cache.clear();
        return {
            success: true,
            data: {
                hasCookie: !!result.data?.cookieHeader,
                cookieNames: result.data?.cookieNames || [],
                currentUser: result.data?.currentUser || null,
                elapsedMs: result.data?.elapsedMs || 0
            }
        };
    }

    async syncCookieFromBridge() {
        const result = await this.bridgeRequest('/hdhive/cookies');
        if (!result.success) {
            return result;
        }
        this.persistCookieHeader(result.data?.cookieHeader || '');
        this.cache.clear();
        return {
            success: true,
            data: {
                hasCookie: !!result.data?.cookieHeader,
                cookies: result.data?.cookies || []
            }
        };
    }

    private async getCurrentUserByBridge() {
        const result = await this.bridgeRequest('/hdhive/customer/current');
        if (!result.success) {
            return result;
        }
        return { success: true, data: this.unwrapBridgePayload(result.data?.payload) };
    }

    async checkinByBridge() {
        const result = await this.bridgeRequest('/hdhive/customer/checkin', { method: 'POST' });
        if (!result.success) {
            return result;
        }
        return { success: true, data: this.unwrapBridgePayload(result.data?.payload) };
    }

    async getPointsLogsByBridge(searchParams: Record<string, string | number | boolean> = {}) {
        const result = await this.bridgeRequest('/hdhive/customer/points-logs', { searchParams });
        if (!result.success) {
            return result;
        }
        return { success: true, data: this.unwrapBridgePayload(result.data?.payload) };
    }

    private getCache(key: string): any | null {
        const cached = this.cache.get(key);
        if (cached && cached.expireAt > Date.now()) {
            return cached.data;
        }
        this.cache.delete(key);
        return null;
    }

    private setCache(key: string, data: any): void {
        this.cache.set(key, { data, expireAt: Date.now() + this.cacheTTL });
    }

    private buildApiHeaders(auth = false): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }
        if (auth && this.accessToken) {
            headers.Authorization = `Bearer ${this.accessToken}`;
        }
        return headers;
    }

    private createCookieJar(): HdhiveCookieJar {
        return new HdhiveCookieJar(this.cookie);
    }

    private persistCookieJar(jar: HdhiveCookieJar): void {
        const nextCookie = jar.toHeader();
        if (!nextCookie || nextCookie === this.cookie || process.env.HDHIVE_COOKIE) {
            return;
        }
        ConfigService.setConfigValue('hdhive.cookie', nextCookie);
    }

    private buildCookieHeaders(jar: HdhiveCookieJar, accept = 'application/json, text/plain, */*'): Record<string, string> {
        const headers: Record<string, string> = {
            Accept: accept,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7'
        };
        const cookieHeader = jar.toHeader();
        if (cookieHeader) {
            headers.Cookie = cookieHeader;
        }
        const csrfToken = jar.get('csrf_access_token');
        if (csrfToken) {
            headers['X-CSRF-TOKEN'] = csrfToken;
        }
        return headers;
    }

    private mergeResponseCookies(jar: HdhiveCookieJar, response: any): void {
        jar.mergeSetCookie(response.headers?.['set-cookie']);
        this.persistCookieJar(jar);
    }

    private async refreshCookieAuth(jar: HdhiveCookieJar): Promise<boolean> {
        if (!jar.toHeader()) {
            return false;
        }
        const response = await got.post(this.buildUrl(AUTH_ENDPOINTS.refresh), {
            headers: {
                ...this.buildCookieHeaders(jar),
                'x-skip-auth-refresh': 'true'
            },
            responseType: 'json',
            timeout: { request: 15000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        this.mergeResponseCookies(jar, response);
        return response.statusCode >= 200 && response.statusCode < 300;
    }

    private async cookieRequest(pathname: string, options: HdhiveCookieRequestOptions = {}, retryOn401 = true): Promise<any> {
        const jar = this.createCookieJar();
        const headers = {
            ...this.buildCookieHeaders(jar, options.accept),
            ...(options.headers || {})
        };
        const requestOptions: any = {
            method: options.method || 'GET',
            headers,
            responseType: options.responseType || 'json',
            timeout: { request: 30000 },
            followRedirect: options.followRedirect ?? false,
            throwHttpErrors: false,
            ...this.getProxyAgent()
        };
        if (options.json !== undefined) {
            requestOptions.json = options.json;
        }
        if (options.body !== undefined) {
            requestOptions.body = options.body;
        }
        const response = await got(this.buildUrl(pathname), requestOptions);
        this.mergeResponseCookies(jar, response);
        const body = response.body;
        const code = body && typeof body === 'object' ? body.code : '';
        if (response.statusCode === 401 && retryOn401 && !options.skipRefresh && code !== 'missing_signature') {
            const refreshed = await this.refreshCookieAuth(jar);
            if (refreshed) {
                return this.cookieRequest(pathname, { ...options, skipRefresh: true }, false);
            }
        }
        return response;
    }

    private saveTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
        ConfigService.setConfigValue('hdhive.accessToken', accessToken || '');
        ConfigService.setConfigValue('hdhive.refreshToken', refreshToken || '');
        ConfigService.setConfigValue('hdhive.tokenExpiresAt', Date.now() + Number(expiresIn || 0) * 1000);
    }

    clearTokens(): void {
        ConfigService.setConfigValue('hdhive.accessToken', '');
        ConfigService.setConfigValue('hdhive.refreshToken', '');
        ConfigService.setConfigValue('hdhive.tokenExpiresAt', null);
    }

    getOAuthUrl(redirectUri: string, scope = 'query unlock') {
        if (!this.clientId) {
            throw new Error('影巢 Client ID 未配置');
        }
        const state = crypto.randomBytes(16).toString('hex');
        this.oauthStates.set(state, { redirectUri, expireAt: Date.now() + this.stateTTL });
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: redirectUri,
            scope,
            state,
            response_mode: 'redirect'
        });
        return { url: this.buildUrl(`/openapi/authorize?${params.toString()}`), state };
    }

    validateOAuthState(state: string): boolean {
        const cached = this.oauthStates.get(state);
        this.oauthStates.delete(state);
        return Boolean(cached && cached.expireAt > Date.now());
    }

    async exchangeCodeForToken(code: string, redirectUri: string) {
        if (!this.apiKey) {
            return { success: false, error: '影巢 API Key 未配置' };
        }
        const response = await got.post(this.buildUrl('/api/public/openapi/oauth/token'), {
            headers: this.buildApiHeaders(),
            json: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
            responseType: 'json',
            timeout: { request: 30000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode !== 200 || !body.success) {
            return { success: false, error: body.description || body.message || '授权码换取 Token 失败' };
        }
        this.saveTokens(body.data?.access_token, body.data?.refresh_token, body.data?.expires_in);
        return { success: true };
    }

    async refreshAccessToken() {
        if (!this.refreshToken) {
            return { success: false, error: 'Refresh Token 未配置，请重新授权' };
        }
        const response = await got.post(this.buildUrl('/api/public/openapi/oauth/refresh'), {
            headers: this.buildApiHeaders(),
            json: { refresh_token: this.refreshToken },
            responseType: 'json',
            timeout: { request: 30000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode === 401 || body.code === 'OPENAPI_REAUTH_REQUIRED') {
            this.clearTokens();
            return { success: false, error: '授权已过期，请重新授权', needsOAuth: true };
        }
        if (response.statusCode !== 200 || !body.success) {
            return { success: false, error: body.description || body.message || '刷新 Token 失败' };
        }
        this.saveTokens(body.data?.access_token, body.data?.refresh_token, body.data?.expires_in);
        return { success: true };
    }

    async revokeAuth() {
        try {
            if (this.refreshToken) {
                await got.post(this.buildUrl('/api/public/openapi/oauth/revoke'), {
                    headers: this.buildApiHeaders(),
                    json: { refresh_token: this.refreshToken },
                    responseType: 'json',
                    timeout: { request: 10000 },
                    throwHttpErrors: false,
                    ...this.getProxyAgent()
                });
            }
        } catch (error: any) {
            logTaskEvent(`影巢撤销授权请求失败: ${error.message}`);
        }
        this.clearTokens();
        return { success: true };
    }

    async ping() {
        if (!this.apiKey) {
            return { success: false, message: '影巢 API Key 未配置' };
        }
        const response = await got.get(this.buildUrl('/api/open/ping'), {
            headers: this.buildApiHeaders(),
            responseType: 'json',
            timeout: { request: 10000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode === 401) {
            return { success: false, message: '影巢 API Key 无效或已过期' };
        }
        return { success: true, message: body.data?.message || body.message || 'pong' };
    }

    async getQuota() {
        if (!this.apiKey) {
            return { success: false, error: '影巢 API Key 未配置' };
        }
        const response = await got.get(this.buildUrl('/api/open/quota'), {
            headers: this.buildApiHeaders(),
            responseType: 'json',
            timeout: { request: 10000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode === 401) {
            return { success: false, error: '影巢 API Key 无效或已过期' };
        }
        return { success: true, data: body.data || body };
    }

    private async authedGet(pathname: string, retryOn401 = true): Promise<any> {
        if (!this.isAuthorized) {
            return { success: false, error: '请先进行 OAuth 授权', needsOAuth: true };
        }
        const response = await got.get(this.buildUrl(pathname), {
            headers: this.buildApiHeaders(true),
            responseType: 'json',
            timeout: { request: 30000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode === 401 && retryOn401) {
            const refreshResult = await this.refreshAccessToken();
            if (!refreshResult.success) {
                return refreshResult;
            }
            return this.authedGet(pathname, false);
        }
        if (response.statusCode >= 400) {
            return { success: false, error: body.description || body.message || `HTTP ${response.statusCode}` };
        }
        return { success: true, data: body.data || body };
    }

    async getMe() {
        const openApiResult = await this.authedGet('/api/open/me');
        if (openApiResult.success || !this.browserBridgeEnabled || !this.browserBridgeToken) {
            return openApiResult;
        }
        return await this.getCurrentUserByBridge();
    }

    private async getResourcesByOpenApi(type: 'movie' | 'tv', tmdbId: string | number) {
        if (!this.apiKey) {
            return { success: false, error: '影巢 API Key 未配置' };
        }
        const result = await this.authedGet(`/api/open/resources/${type}/${encodeURIComponent(String(tmdbId))}`);
        if (!result.success) {
            return result;
        }
        const resources = Array.isArray(result.data) ? result.data : [];
        const normalized = this.normalizeResources(resources).filter((item: any) => item.cloudType === 'cloud189');
        return { success: true, data: normalized };
    }

    private async getResourcesByCookie(type: 'movie' | 'tv', tmdbId: string | number) {
        if (!this.cookie) {
            return { success: false, error: '影巢 Cookie 未配置' };
        }
        const page = await this.fetchPage(`/tmdb/${type}/${encodeURIComponent(String(tmdbId))}`);
        if (this.isLoginRedirect(page.url, page.html)) {
            return { success: false, error: '影巢 Cookie 已失效或无权访问资源页', needsCookie: true };
        }
        const directResources = this.extractCloudLinks(page.html, page.url).map((item, index) => ({
            id: item.id,
            slug: item.id,
            title: item.title || `影巢天翼直链 ${index + 1}`,
            pan_type: '189',
            media_url: item.shareLink,
            access_code: item.accessCode,
            is_unlocked: true
        }));
        const pageResources = this.extractResourceEntries(page.html, page.url);
        const normalized = this.normalizeResources([...directResources, ...pageResources])
            .filter((item: any) => item.cloudType === 'cloud189');
        return { success: true, data: normalized };
    }

    private async getResourcesByBridge(type: 'movie' | 'tv', tmdbId: string | number) {
        const result = await this.bridgeRequest('/hdhive/customer/media-resources', {
            method: 'POST',
            json: { type, tmdbId }
        });
        if (!result.success) {
            return result;
        }
        const normalized = this.normalizeBridgeResources(result.data);
        const enriched = await this.enrichBridgeResourcesWithDetails(normalized);
        return { success: true, data: enriched, raw: result.data };
    }

    private async enrichBridgeResourcesWithDetails(resources: any[]): Promise<any[]> {
        const enriched: any[] = [];
        for (const resource of resources) {
            const slug = resource.slug || resource.id;
            if (resource.link || !slug || !resource.isUnlocked) {
                enriched.push(resource);
                continue;
            }
            const detailResult = await this.getResourceDetailByBridge(slug).catch(() => null);
            const detailResources = detailResult?.success ? this.normalizeBridgeResources(detailResult.data) : [];
            const detail = detailResources.find((item: any) => item.slug && item.slug === resource.slug)
                || detailResources.find((item: any) => item.link)
                || detailResources[0];
            if (!detail) {
                enriched.push(resource);
                continue;
            }
            enriched.push({
                ...resource,
                ...detail,
                id: resource.id || detail.id,
                slug: resource.slug || detail.slug,
                title: detail.title && detail.title !== '未命名资源' ? detail.title : resource.title,
                size: detail.size || resource.size,
                sizeFormatted: detail.size ? detail.sizeFormatted : resource.sizeFormatted,
                points: detail.points ?? resource.points ?? null,
                isFree: detail.isFree ?? resource.isFree,
                link: detail.link || resource.link,
                code: detail.code || resource.code,
                isUnlocked: Boolean(resource.isUnlocked || detail.isUnlocked || detail.link || resource.link)
            });
        }
        return enriched;
    }

    private async getResourceDetailByBridge(slug: string): Promise<any> {
        const resourceId = this.extractResourceSlug(this.normalizeResourcePath(slug));
        return await this.bridgeRequest(`/hdhive/customer/resources/${encodeURIComponent(resourceId)}`);
    }

    private formatBridgeUnlockData(payload: any): { success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string } {
        const normalizedResources = this.dedupeResources([
            ...this.normalizeBridgeResources(payload?.resources || []),
            ...this.normalizeBridgeResources(payload?.detail || []),
            ...this.normalizeBridgeResources(payload?.payload || payload)
        ]);
        const firstResource = normalizedResources.find((item: any) => item.link);
        if (firstResource?.link) {
            return {
                success: true,
                data: {
                    link: firstResource.link,
                    code: firstResource.code || '',
                    fullUrl: firstResource.link,
                    points: firstResource.points || 0
                }
            };
        }
        const share = this.findFirstCloud189Share(payload);
        if (share.link) {
            return { success: true, data: { link: share.link, code: share.code, fullUrl: share.link, points: 0 } };
        }
        return { success: false, error: 'Browser Bridge 未解析到天翼分享链接' };
    }

    private dedupeResources(resources: any[]): any[] {
        const seen = new Set<string>();
        return resources.filter((item) => {
            const key = item.slug || item.id || item.link || `${item.title}:${item.size}`;
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    private async getUnlockedResourceByBridge(slug: string): Promise<{ success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string }> {
        const detailResult = await this.getResourceDetailByBridge(slug);
        if (!detailResult.success) {
            return detailResult;
        }
        const formatted = this.formatBridgeUnlockData(detailResult.data);
        if (formatted.success) {
            return formatted;
        }
        return { success: false, error: '资源尚未解锁或详情页未返回天翼链接' };
    }

    async getResources(type: 'movie' | 'tv', tmdbId: string | number) {
        const cacheMode = this.isAuthorized ? 'openapi' : this.browserBridgeEnabled ? 'bridge' : 'cookie';
        const cacheKey = `resources:${type}:${tmdbId}:${cacheMode}`;
        const cached = this.getCache(cacheKey);
        if (cached) {
            return { success: true, data: cached };
        }

        let openApiResult: any = null;
        if (this.apiKey && this.isAuthorized) {
            openApiResult = await this.getResourcesByOpenApi(type, tmdbId);
            if (openApiResult.success) {
                this.setCache(cacheKey, openApiResult.data);
                return openApiResult;
            }
        }

        let bridgeResult: any = null;
        if (this.browserBridgeEnabled && this.browserBridgeToken) {
            bridgeResult = await this.getResourcesByBridge(type, tmdbId);
            if (bridgeResult.success) {
                this.setCache(cacheKey, bridgeResult.data);
                return bridgeResult;
            }
        }

        if (this.cookie) {
            const cookieResult = await this.getResourcesByCookie(type, tmdbId);
            if (cookieResult.success) {
                this.setCache(cacheKey, cookieResult.data);
            }
            return cookieResult;
        }

        if (bridgeResult) {
            return bridgeResult;
        }
        if (openApiResult) {
            return openApiResult;
        }
        if (this.apiKey && !this.isAuthorized) {
            return { success: false, error: '请先进行 OAuth 授权，或配置影巢 Cookie/Browser Bridge 使用网页模式', needsOAuth: true };
        }
        return { success: false, error: '影巢 Cookie、OpenAPI 凭证或 Browser Bridge 未配置' };
    }

    private async unlockResourceByOpenApi(slug: string): Promise<{ success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string; needsOAuth?: boolean }> {
        if (!this.apiKey) {
            return { success: false, error: '影巢 API Key 未配置' };
        }
        if (!this.isAuthorized) {
            return { success: false, error: '请先进行 OAuth 授权', needsOAuth: true };
        }
        const response = await got.post(this.buildUrl('/api/open/resources/unlock'), {
            headers: this.buildApiHeaders(true),
            json: { slug },
            responseType: 'json',
            timeout: { request: 30000 },
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        const body: any = response.body || {};
        if (response.statusCode === 401) {
            const refreshResult = await this.refreshAccessToken();
            if (!refreshResult.success) {
                return refreshResult;
            }
            return this.unlockResource(slug);
        }
        if (response.statusCode === 402) {
            return { success: false, error: '积分不足，无法解锁该资源' };
        }
        if (response.statusCode >= 400 || (body.success === false)) {
            return { success: false, error: body.description || body.message || '解锁失败' };
        }
        this.cache.clear();
        const data = body.data || body;
        const parsed = Cloud189Utils.parseCloudShare(data.full_url || data.url || data.link || '');
        return {
            success: true,
            data: {
                link: parsed.url || data.url || data.link || '',
                code: parsed.accessCode || data.access_code || data.code || '',
                fullUrl: data.full_url || '',
                points: data.points || 0
            }
        };
    }

    private async unlockResourceByBridge(slug: string): Promise<{ success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string }> {
        const resourceId = this.extractResourceSlug(this.normalizeResourcePath(slug));
        const existing = await this.getUnlockedResourceByBridge(resourceId).catch(() => null);
        if (existing?.success) {
            return existing;
        }
        const result = await this.bridgeRequest(`/hdhive/customer/resources/${encodeURIComponent(resourceId)}/unlock`, {
            method: 'POST'
        });
        if (!result.success) {
            return result;
        }
        this.cache.clear();
        const formatted = this.formatBridgeUnlockData(result.data);
        if (formatted.success) {
            return formatted;
        }
        return { success: false, error: 'Browser Bridge 解锁成功但未解析到天翼分享链接' };
    }

    private normalizeResourcePath(slug: string): string {
        const value = String(slug || '').trim();
        if (/^https?:\/\//i.test(value)) {
            const url = new URL(value);
            return url.pathname;
        }
        if (value.startsWith('/resource/')) {
            return value;
        }
        return `/resource/189/${encodeURIComponent(value)}`;
    }

    private extractResourceSlug(resourcePath: string): string {
        const match = resourcePath.match(/\/resource\/[^/]+\/([^/?#]+)/);
        return decodeURIComponent(match?.[1] || resourcePath);
    }

    private discoverResourceUnlockActionId(html: string): string {
        const text = this.decodeFlightText(html);
        const namedMatch = text.match(/resourceUnlock[\s\S]{0,300}?([a-f0-9]{40})/i)
            || text.match(/([a-f0-9]{40})[\s\S]{0,300}?resourceUnlock/i);
        return namedMatch?.[1] || '';
    }

    private async unlockResourceByCookie(slug: string): Promise<{ success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string; needsCookie?: boolean }> {
        if (!this.cookie) {
            return { success: false, error: '影巢 Cookie 未配置', needsCookie: true };
        }
        const resourcePath = this.normalizeResourcePath(slug);
        const resourceSlug = this.extractResourceSlug(resourcePath);
        const beforePage = await this.fetchPage(resourcePath);
        if (this.isLoginRedirect(beforePage.url, beforePage.html)) {
            return { success: false, error: '影巢 Cookie 已失效，请更新 Cookie', needsCookie: true };
        }

        const beforeLinks = this.extractCloudLinks(beforePage.html, beforePage.url);
        if (beforeLinks.length > 0) {
            const first = beforeLinks[0];
            return { success: true, data: { link: first.shareLink, code: first.accessCode, fullUrl: first.shareLink, points: 0 } };
        }

        const actionId = this.discoverResourceUnlockActionId(beforePage.html) || this.resourceUnlockActionId;
        if (!actionId) {
            return { success: false, error: '影巢资源解锁 Action ID 未配置' };
        }

        const response = await this.cookieRequest(resourcePath, {
            method: 'POST',
            accept: 'text/x-component',
            responseType: 'text',
            body: JSON.stringify([resourceSlug, '$T']),
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Next-Action': actionId,
                Origin: this.baseUrl,
                Referer: this.buildUrl(resourcePath)
            }
        });

        if (response.statusCode === 401) {
            return { success: false, error: '影巢 Cookie 已失效，请更新 Cookie', needsCookie: true };
        }
        if (response.statusCode >= 400) {
            return { success: false, error: `影巢 Cookie 解锁失败: HTTP ${response.statusCode}；如果 Action ID 已轮换，请更新 hdhive.resourceUnlockActionId` };
        }

        const actionLinks = this.extractCloudLinks(String(response.body || ''), this.buildUrl(resourcePath));
        if (actionLinks.length > 0) {
            const first = actionLinks[0];
            this.cache.clear();
            return { success: true, data: { link: first.shareLink, code: first.accessCode, fullUrl: first.shareLink, points: 0 } };
        }

        const afterPage = await this.fetchPage(resourcePath);
        const afterLinks = this.extractCloudLinks(afterPage.html, afterPage.url);
        if (afterLinks.length > 0) {
            const first = afterLinks[0];
            this.cache.clear();
            return { success: true, data: { link: first.shareLink, code: first.accessCode, fullUrl: first.shareLink, points: 0 } };
        }

        return { success: false, error: '影巢 Cookie 解锁完成但未解析到天翼分享链接' };
    }

    async unlockResource(slug: string): Promise<{ success: boolean; data?: { link: string; code: string; fullUrl: string; points: number }; error?: string; needsOAuth?: boolean; needsCookie?: boolean }> {
        let openApiResult: any = null;
        if (this.apiKey && this.isAuthorized) {
            openApiResult = await this.unlockResourceByOpenApi(slug);
            if (openApiResult.success) {
                return openApiResult;
            }
        }

        let bridgeResult: any = null;
        if (this.browserBridgeEnabled && this.browserBridgeToken) {
            bridgeResult = await this.unlockResourceByBridge(slug);
            if (bridgeResult.success) {
                return bridgeResult;
            }
        }

        if (this.cookie) {
            return await this.unlockResourceByCookie(slug);
        }

        if (bridgeResult) {
            return bridgeResult;
        }
        if (openApiResult) {
            return openApiResult;
        }
        if (this.apiKey && !this.isAuthorized) {
            return { success: false, error: '请先进行 OAuth 授权，或配置影巢 Cookie/Browser Bridge 使用网页解锁模式', needsOAuth: true };
        }
        return { success: false, error: '影巢 Cookie、OpenAPI 凭证或 Browser Bridge 未配置' };
    }

    private mapCloudType(type: string | number): string {
        if (typeof type === 'number') {
            return ({ 1: '115', 2: 'quark', 3: 'ali', 4: 'baidu', 5: '123', 6: 'xunlei', 7: 'pikpak', 8: 'cloud189', 9: 'lenovo' } as Record<number, string>)[type] || 'unknown';
        }
        const text = String(type || '').toLowerCase();
        if (!text) return 'unknown';
        if (text === '189' || text === '8') return 'cloud189';
        if (text.includes('115')) return '115';
        if (text.includes('123')) return '123';
        if (text.includes('quark') || text.includes('夸克')) return 'quark';
        if (text.includes('baidu') || text.includes('百度')) return 'baidu';
        if (text.includes('ali') || text.includes('阿里')) return 'ali';
        if (text.includes('xunlei') || text.includes('迅雷')) return 'xunlei';
        if (text.includes('pikpak')) return 'pikpak';
        if (text.includes('cloud189') || text.includes('天翼') || text.includes('电信')) return 'cloud189';
        if (text.includes('lenovo') || text.includes('联想')) return 'lenovo';
        return text;
    }

    private extractQuality(title: string): string[] {
        const text = String(title || '');
        const qualities = [
            [/4k|2160p/i, '4K'],
            [/1080p/i, '1080P'],
            [/720p/i, '720P'],
            [/remux/i, 'REMUX'],
            [/hdr|hdr10|dolby\s*vision/i, 'HDR'],
            [/web-dl/i, 'WEB-DL'],
            [/bluray|blu-ray|蓝光/i, 'BluRay'],
            [/简中|简体|中字|中英/i, '中字']
        ];
        return qualities.filter(([pattern]) => (pattern as RegExp).test(text)).map(([, label]) => label as string);
    }

    private formatSize(bytes: number | string): string {
        const size = Number(bytes || 0);
        if (!Number.isFinite(size) || size <= 0) return '未知';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = size;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex++;
        }
        return `${value.toFixed(1)} ${units[unitIndex]}`;
    }

    private unwrapBridgePayload(payload: any): any {
        let current = payload;
        for (let index = 0; index < 6; index += 1) {
            if (!current || typeof current !== 'object' || Array.isArray(current)) {
                return current;
            }
            if (current.response !== undefined) {
                current = current.response;
                continue;
            }
            if (current.payload !== undefined) {
                current = current.payload;
                continue;
            }
            if (current.success !== undefined && current.data !== undefined) {
                current = current.data;
                continue;
            }
            return current;
        }
        return current;
    }

    private collectResourceCandidates(value: any, depth = 0): any[] {
        if (!value || depth > 6) {
            return [];
        }
        const unwrapped = this.unwrapBridgePayload(value);
        if (Array.isArray(unwrapped)) {
            const direct = unwrapped.filter((item) => item && typeof item === 'object' && this.looksLikeResource(item));
            if (direct.length > 0) {
                return direct;
            }
            return unwrapped.flatMap((item) => this.collectResourceCandidates(item, depth + 1));
        }
        if (typeof unwrapped !== 'object') {
            return [];
        }
        if (this.looksLikeResource(unwrapped)) {
            return [unwrapped];
        }
        return Object.values(unwrapped).flatMap((item) => this.collectResourceCandidates(item, depth + 1));
    }

    private looksLikeResource(value: any): boolean {
        if (!value || typeof value !== 'object') {
            return false;
        }
        return Boolean(
            value.slug
            || value.resourceId
            || value.media_url
            || value.mediaUrl
            || value.full_url
            || value.fullUrl
            || value.shareLink
            || value.share_link
            || value.link
            || value.url
            || value.access_code
            || value.accessCode
            || value.netdisk_website_id
            || value.net_disk_website_id
            || value.website_id
            || value.pan_type
            || value.cloudType
            || value.unlock_points !== undefined
            || value.is_free !== undefined
            || value.isFree !== undefined
        );
    }

    private normalizeBridgeResources(payload: any): any[] {
        const candidates = this.collectResourceCandidates(payload);
        return this.dedupeResources(this.normalizeResources(candidates)
            .filter((item: any) => item.cloudType === 'cloud189')
        );
    }

    private findFirstCloud189Share(payload: any): { link: string; code: string } {
        const text = this.decodeFlightText(JSON.stringify(payload || ''));
        const linkMatch = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
        if (!linkMatch) {
            return { link: '', code: '' };
        }
        const parsed = Cloud189Utils.parseCloudShare(linkMatch[0]);
        return { link: parsed.url || linkMatch[0], code: parsed.accessCode || '' };
    }

    private normalizeResources(resources: any[]): any[] {
        return resources.map((resource) => {
            const cloudType = this.mapCloudType(resource.pan_type || resource.cloudType || resource.drive || resource.netdisk_website_id || resource.net_disk_website_id || resource.website_id || resource.website || resource.type);
            const cloudMeta = CLOUD_TYPE_MAP[cloudType] || CLOUD_TYPE_MAP.unknown;
            const shareText = resource.full_url || resource.fullUrl || resource.media_url || resource.mediaUrl || resource.shareLink || resource.share_link || resource.link || resource.url || '';
            const parsed = Cloud189Utils.parseCloudShare(shareText);
            const resourceId = resource.slug || resource.id || resource.resourceId || resource.resource_id || '';
            const hasPointField = resource.unlock_points !== undefined || resource.points !== undefined || resource.cost !== undefined;
            const points = hasPointField ? resource.unlock_points ?? resource.points ?? resource.cost ?? 0 : null;
            const explicitFree = resource.is_free === true || resource.isFree === true;
            return {
                id: String(resourceId),
                slug: resource.slug || resource.id || resource.resourceId || resource.resource_id || '',
                title: resource.title || resource.name || resource.resource_name || resource.media_name || '未命名资源',
                cloudType,
                cloudTypeName: cloudMeta.name,
                cloudTypeIcon: cloudMeta.icon,
                cloudTypeColor: cloudMeta.color,
                size: resource.share_size || resource.size || resource.fileSize || 0,
                sizeFormatted: this.formatSize(resource.share_size || resource.size || resource.fileSize),
                points,
                isFree: explicitFree || (points !== null && Number(points) === 0),
                expired: !!(resource.expired || resource.isExpired),
                quality: this.extractQuality(resource.title || resource.name || ''),
                uploader: resource.user || resource.uploader || resource.publisher || {},
                publishedAt: resource.publishedAt || resource.createTime || '',
                link: parsed.url || resource.media_url || resource.mediaUrl || resource.shareLink || resource.share_link || resource.link || resource.url || '',
                code: parsed.accessCode || resource.access_code || resource.accessCode || resource.code || resource.password || resource.passwd || '',
                isUnlocked: !!(resource.is_unlocked || resource.isUnlocked || parsed.url)
            };
        });
    }

    private extractResourceTitle(block: string, fallback: string): string {
        return this.getStringField(block, 'title')
            || this.getStringField(block, 'name')
            || this.getStringField(block, 'resource_name')
            || this.getStringField(block, 'media_name')
            || fallback;
    }

    private addResourceEntry(resources: any[], seen: Set<string>, slug: string, block: string, pageUrl: string): void {
        const normalizedSlug = String(slug || '').trim();
        if (!normalizedSlug || seen.has(normalizedSlug)) return;
        seen.add(normalizedSlug);
        const linkMatch = block.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
        resources.push({
            id: normalizedSlug,
            slug: normalizedSlug,
            title: this.extractResourceTitle(block, `影巢天翼资源 ${resources.length + 1}`),
            pan_type: '189',
            share_size: this.getNumberField(block, 'share_size') || this.getNumberField(block, 'size') || this.getNumberField(block, 'file_size'),
            unlock_points: this.getNumberField(block, 'unlock_points') || this.getNumberField(block, 'points') || this.getNumberField(block, 'cost'),
            is_free: /(^|[\s"'([{,，:：])免费($|[\s"'\])},，。:：])/.test(block),
            expired: /"expired"\s*:\s*true|"isExpired"\s*:\s*true|疑似失效/i.test(block),
            is_unlocked: /"is_unlocked"\s*:\s*true|"isUnlocked"\s*:\s*true|已解锁|查看链接|复制链接/i.test(block),
            media_url: linkMatch?.[0] || '',
            pageUrl: `${this.baseUrl}/resource/189/${encodeURIComponent(normalizedSlug)}`,
            sourcePageUrl: pageUrl
        });
    }

    private extractResourceEntries(html: string, pageUrl = this.baseUrl): any[] {
        const text = this.decodeFlightText(html);
        const resources: any[] = [];
        const seen = new Set<string>();
        const pathRegex = /\/resource\/(?:189|cloud189|8)\/([A-Za-z0-9._~-]+)/g;
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = pathRegex.exec(text)) !== null) {
            const start = Math.max(0, pathMatch.index - 1500);
            const end = Math.min(text.length, pathMatch.index + 3500);
            this.addResourceEntry(resources, seen, decodeURIComponent(pathMatch[1]), text.slice(start, end), pageUrl);
        }

        const slugRegex = /"slug"\s*:\s*"([^"]+)"/g;
        let slugMatch: RegExpExecArray | null;
        while ((slugMatch = slugRegex.exec(text)) !== null) {
            const start = Math.max(0, slugMatch.index - 2000);
            const end = Math.min(text.length, slugMatch.index + 4500);
            const block = text.slice(start, end);
            if (!/(?:"(?:website|website_id|netdisk_website_id|net_disk_website_id|pan_type|cloudType)"\s*:\s*"?189"?|天翼|cloud189|\/resource\/189\/)/i.test(block)) {
                continue;
            }
            this.addResourceEntry(resources, seen, this.decodeJsonString(slugMatch[1]), block, pageUrl);
        }
        return resources;
    }

    private async fetchPage(pathname: string): Promise<{ html: string; url: string }> {
        const jar = this.createCookieJar();
        const response = await got.get(this.buildUrl(pathname), {
            headers: this.buildCookieHeaders(jar, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
            timeout: { request: 20000 },
            followRedirect: true,
            throwHttpErrors: false,
            ...this.getProxyAgent()
        });
        this.mergeResponseCookies(jar, response);
        return { html: String(response.body || ''), url: response.url || this.buildUrl(pathname) };
    }

    private isLoginRedirect(url: string, html: string): boolean {
        return /\/login(?:\?|$)/i.test(url) || /\/login\?redirect=/.test(html);
    }

    private decodeFlightText(html: string): string {
        return html
            .replace(/&quot;/g, '"')
            .replace(/&#x2F;/g, '/')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/\\"/g, '"')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');
    }

    private decodeJsonString(value: string): string {
        try {
            return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
        } catch {
            return value;
        }
    }

    private getStringField(block: string, field: string): string {
        const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = block.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]*)"`, 'i'));
        return match?.[1] ? this.decodeJsonString(match[1]) : '';
    }

    private getNumberField(block: string, field: string): number {
        const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = block.match(new RegExp(`"${escapedField}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
        return match ? Number(match[1]) : 0;
    }

    private inferYear(block: string): string {
        const date = this.getStringField(block, 'release_date') || this.getStringField(block, 'first_air_date') || this.getStringField(block, 'air_date');
        return (date.match(/\d{4}/) || [])[0] || '';
    }

    private inferType(block: string): HdhiveMediaType {
        const type = this.getStringField(block, 'type') || this.getStringField(block, 'record_type');
        return type === 'movie' || type === 'tv' ? type : 'unknown';
    }

    private buildMediaPageUrl(type: HdhiveMediaType, tmdbId: string, id: string): string {
        const pathType = type === 'tv' ? 'tv' : 'movie';
        const pageId = tmdbId || id;
        return pageId ? `${this.baseUrl}/tmdb/${pathType}/${encodeURIComponent(pageId)}` : this.baseUrl;
    }

    private extractMediaItems(html: string, keyword: string, limit: number): HdhiveSearchItem[] {
        const text = this.decodeFlightText(html);
        const blocks = text.match(/\{"id":\d+,"slug":"[^"]+"[\s\S]{0,9000}?"type":"(?:movie|tv)"\}/g) || [];
        const seen = new Set<string>();
        const normalizedKeyword = keyword.trim().toLowerCase();
        const items: HdhiveSearchItem[] = [];
        for (const block of blocks) {
            const id = String(this.getNumberField(block, 'id') || '');
            const tmdbId = this.getStringField(block, 'tmdb_id');
            const title = this.getStringField(block, 'title');
            if (!title) continue;
            const originalTitle = this.getStringField(block, 'original_title');
            if (normalizedKeyword && !title.toLowerCase().includes(normalizedKeyword) && !originalTitle.toLowerCase().includes(normalizedKeyword)) {
                continue;
            }
            const type = this.inferType(block);
            const key = `${type}:${tmdbId || id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push({
                id: tmdbId || id,
                tmdbId: tmdbId || id,
                title,
                originalTitle,
                year: this.inferYear(block),
                type,
                overview: this.getStringField(block, 'overview'),
                posterPath: this.getStringField(block, 'poster_path'),
                backdropPath: this.getStringField(block, 'backdrop_path'),
                videoResolution: this.getStringField(block, 'video_resolution'),
                shareNum: this.getNumberField(block, 'share_num'),
                pageUrl: this.buildMediaPageUrl(type, tmdbId, id),
                shareLink: '',
                accessCode: '',
                source: 'hdhive'
            });
            if (items.length >= limit) break;
        }
        return items;
    }

    private toHdhiveSearchItemFromTmdb(item: any): HdhiveSearchItem | null {
        if (!item || !item.id || !['movie', 'tv'].includes(item.type)) {
            return null;
        }
        const releaseDate = String(item.releaseDate || item.release_date || item.first_air_date || '');
        const year = (releaseDate.match(/\d{4}/) || [])[0] || '';
        return {
            id: String(item.id),
            tmdbId: String(item.id),
            title: String(item.title || item.name || ''),
            originalTitle: String(item.originalTitle || item.original_title || item.original_name || ''),
            year,
            type: item.type,
            overview: String(item.overview || ''),
            posterPath: String(item.posterPath || item.poster_path || ''),
            backdropPath: String(item.backdropPath || item.backdrop_path || ''),
            videoResolution: '',
            shareNum: 0,
            pageUrl: this.buildMediaPageUrl(item.type, String(item.id), String(item.id)),
            shareLink: '',
            accessCode: '',
            source: 'tmdb'
        };
    }

    private getTmdbApiKey(): string {
        return String(ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey') || '').trim();
    }

    private async searchTmdbMedia(keyword: string, limit: number): Promise<HdhiveSearchItem[]> {
        if (!this.getTmdbApiKey()) {
            return [];
        }
        const tmdbService = new TMDBService();
        const result = await tmdbService.search(keyword);
        const candidates = [
            ...(Array.isArray(result?.movies) ? result.movies : []),
            ...(Array.isArray(result?.tvShows) ? result.tvShows : [])
        ];
        const seen = new Set<string>();
        const items: HdhiveSearchItem[] = [];
        for (const candidate of candidates) {
            const item = this.toHdhiveSearchItemFromTmdb(candidate);
            if (!item) continue;
            const key = `${item.type}:${item.tmdbId || item.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
            if (items.length >= limit) break;
        }
        return items;
    }

    private extractCloudLinks(html: string, pageUrl = this.baseUrl): HdhiveSearchItem[] {
        const text = this.decodeFlightText(html);
        const urlMatches = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/gi) || [];
        const seen = new Set<string>();
        const items: HdhiveSearchItem[] = [];
        for (const rawUrl of urlMatches) {
            const parsed = Cloud189Utils.parseCloudShare(rawUrl);
            const shareLink = parsed.url || rawUrl;
            if (!shareLink || seen.has(shareLink)) continue;
            seen.add(shareLink);
            items.push({
                id: shareLink,
                title: `影巢分享 ${items.length + 1}`,
                originalTitle: '',
                year: '',
                type: 'unknown',
                overview: '',
                posterPath: '',
                backdropPath: '',
                videoResolution: '',
                shareNum: 1,
                pageUrl,
                shareLink,
                accessCode: parsed.accessCode || '',
                source: 'hdhive'
            });
        }
        return items;
    }

    async search(keyword: string, limit = 20): Promise<HdhiveSearchResult> {
        const normalizedKeyword = String(keyword || '').trim();
        const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const tmdbConfigured = !!this.getTmdbApiKey();
        let tmdbSearchError = '';

        if (normalizedKeyword && tmdbConfigured) {
            try {
                const tmdbItems = await this.searchTmdbMedia(normalizedKeyword, normalizedLimit);
                if (tmdbItems.length > 0) {
                    return {
                        items: tmdbItems,
                        directLinkCount: 0,
                        loginRequired: false,
                        warning: '已优先使用 TMDB 搜索结果；请点击“查天翼”查询影巢天翼资源。'
                    };
                }
            } catch (error) {
                tmdbSearchError = error instanceof Error ? error.message : String(error);
                logTaskEvent(`影巢搜索 TMDB 优先搜索失败: ${tmdbSearchError}`, 'warn', 'hdhive');
            }
        }

        const pathname = normalizedKeyword ? `/search?query=${encodeURIComponent(normalizedKeyword)}&type=multi&page=1` : '/';
        const page = await this.fetchPage(pathname);
        const loginRequired = this.isLoginRedirect(page.url, page.html);
        if (loginRequired && normalizedKeyword && !this.cookie) {
            const tmdbWarning = tmdbConfigured
                ? tmdbSearchError
                    ? `TMDB 优先搜索失败：${tmdbSearchError}`
                    : 'TMDB 未返回匹配结果'
                : 'TMDB API Key 未配置';
            return { items: [], directLinkCount: 0, loginRequired: true, warning: `${tmdbWarning}；影巢搜索页需要有效网页登录 Cookie，或配置 OpenAPI 凭证后按 TMDB ID 查询。` };
        }
        const directItems = this.extractCloudLinks(page.html, page.url);
        let mediaItems = this.extractMediaItems(page.html, normalizedKeyword, normalizedLimit);
        const items = [...directItems, ...mediaItems].slice(0, normalizedLimit);
        const directLinkCount = items.filter(item => item.shareLink).length;
        const warning = directLinkCount > 0
            ? ''
            : normalizedKeyword && tmdbConfigured
                ? tmdbSearchError
                    ? `TMDB 优先搜索失败：${tmdbSearchError}；当前搜索页未直接暴露天翼分享链接，可进入详情页或使用 OpenAPI 解锁天翼资源。`
                    : 'TMDB 未返回匹配结果，已回退影巢搜索页；可进入详情页或使用 OpenAPI 解锁天翼资源。'
                : normalizedKeyword
                    ? 'TMDB API Key 未配置，已回退影巢搜索页；可进入详情页或使用 OpenAPI 解锁天翼资源。'
                    : '当前搜索页未直接暴露天翼分享链接；可进入详情页或使用 OpenAPI 解锁天翼资源。';
        return {
            items,
            directLinkCount,
            loginRequired,
            warning
        };
    }

    async detail(url: string) {
        const page = await this.fetchPage(url);
        const links = this.extractCloudLinks(page.html, page.url);
        const resources = this.normalizeResources(this.extractResourceEntries(page.html, page.url))
            .filter((item: any) => item.cloudType === 'cloud189');
        return { success: true, data: { links, resources, loginRequired: this.isLoginRedirect(page.url, page.html) } };
    }
}

export default new HdhiveSDK();
