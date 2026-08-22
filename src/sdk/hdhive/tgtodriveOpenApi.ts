const got = require('got');
const crypto = require('crypto');
const ConfigService = require('../../services/ConfigService');
const ProxyUtil = require('../../utils/ProxyUtil');
const { logTaskEvent } = require('../../utils/logUtils');

const DEFAULT_BASE_URL = 'https://hdhive-open.tgtodrive.top';
const DEFAULT_SHARED_SECRET = 'd45WcKoZp6dk9bXKpHG-mndXIEGhug36f20jYo5jWeuL7MLEIIYavUGEmPHSxCqV7pBCJ3pOr24qAT8nu9bu_A';
const INSTALL_ID_PREFIX = 'inst_';

interface TgtodriveRequestOptions {
    json?: any;
    params?: Record<string, string | number | boolean>;
}

interface TgtodriveApiResult {
    success: boolean;
    data?: any;
    error?: string;
    needsOAuth?: boolean;
}

class TgtodriveOpenApiClient {
    private get baseUrl(): string {
        const configured = ConfigService.getConfigValue('hdhive.tgtodrive.baseUrl') || process.env.HDHIVE_TGTODRIVE_BASE_URL || DEFAULT_BASE_URL;
        return String(configured || '').replace(/\/+$/, '') || DEFAULT_BASE_URL;
    }

    private get sharedSecret(): string {
        const configured = ConfigService.getConfigValue('hdhive.tgtodrive.sharedSecret') || process.env.HDHIVE_TGTODRIVE_SHARED_SECRET || DEFAULT_SHARED_SECRET;
        return String(configured || '').trim() || DEFAULT_SHARED_SECRET;
    }

    private get installId(): string {
        return String(ConfigService.getConfigValue('hdhive.tgtodrive.installId') || process.env.HDHIVE_TGTODRIVE_INSTALL_ID || '').trim();
    }

    get configured(): boolean {
        return !!this.installId;
    }

    get oauthAvailable(): boolean {
        return Boolean(this.baseUrl && this.sharedSecret);
    }

    get authorized(): boolean {
        return ConfigService.getConfigValue('hdhive.tgtodrive.authorized') === true;
    }

    ensureInstallId(): string {
        if (this.installId) {
            return this.installId;
        }
        const installId = `${INSTALL_ID_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
        ConfigService.setConfigValue('hdhive.tgtodrive.installId', installId);
        return installId;
    }

    getStatus() {
        return {
            configured: this.configured,
            oauthAvailable: this.oauthAvailable,
            baseUrl: this.baseUrl,
            installId: this.configured ? `${this.installId.slice(0, 12)}…${this.installId.slice(-6)}` : '',
            authorized: this.authorized,
            checkedAt: ConfigService.getConfigValue('hdhive.tgtodrive.checkedAt') || null,
            expiresAt: ConfigService.getConfigValue('hdhive.tgtodrive.expiresAt') || null,
            hasUser: !!ConfigService.getConfigValue('hdhive.tgtodrive.user')
        };
    }

    buildAuthUrl(): string {
        const installId = this.ensureInstallId();
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomBytes(32).toString('base64url');
        const params: Record<string, string> = {
            install_id: installId,
            ts,
            nonce
        };
        const query = this.urlEncode(params);
        const canonical = this.canonicalRequest('GET', `/auth/start?${query}`, installId, ts, nonce, '');
        return `${this.baseUrl}/auth/start?${query}&sig=${this.sign(canonical)}`;
    }

    async ping(): Promise<TgtodriveApiResult> {
        return this.request('GET', '/api/ping');
    }

    async me(): Promise<TgtodriveApiResult> {
        return this.request('GET', '/api/me');
    }

    async tokenStatus(): Promise<TgtodriveApiResult> {
        return this.request('GET', '/api/token/status');
    }

    async getResources(mediaType: 'movie' | 'tv', tmdbId: string | number): Promise<TgtodriveApiResult> {
        return this.request('GET', `/api/resources/${mediaType}/${encodeURIComponent(String(tmdbId))}`);
    }

    async getShareDetail(slug: string): Promise<TgtodriveApiResult> {
        return this.request('GET', `/api/shares/${encodeURIComponent(slug)}`);
    }

    async unlock(slug: string): Promise<TgtodriveApiResult> {
        return this.request('POST', '/api/resources/unlock', { json: { slug } });
    }

    async checkin(isGambler = false): Promise<TgtodriveApiResult> {
        return this.request('POST', '/api/checkin', { json: { is_gambler: Boolean(isGambler) } });
    }

    async refreshStatus(): Promise<TgtodriveApiResult> {
        if (!this.configured) {
            return { success: false, error: '影巢 TgtoDrive 开放平台尚未配置 install_id，请先发起授权' };
        }
        const statusResult = await this.tokenStatus();
        if (!statusResult.success) {
            if (statusResult.needsOAuth) {
                this.resetAuth();
            }
            return statusResult;
        }
        const status = statusResult.data || {};
        const authorized = status.has_access_token === true || status.authorized === true;
        ConfigService.setConfigValue('hdhive.tgtodrive.authorized', authorized);
        ConfigService.setConfigValue('hdhive.tgtodrive.checkedAt', new Date().toISOString());
        if (status.expires_at) {
            const expiresAt = new Date(String(status.expires_at)).getTime();
            ConfigService.setConfigValue('hdhive.tgtodrive.expiresAt', Number.isFinite(expiresAt) ? expiresAt : null);
        }
        if (authorized) {
            const meResult = await this.me();
            if (meResult.success) {
                ConfigService.setConfigValue('hdhive.tgtodrive.user', meResult.data || null);
            }
        } else {
            ConfigService.setConfigValue('hdhive.tgtodrive.user', null);
        }
        return { success: true, data: status };
    }

    resetAuth(): void {
        ConfigService.setConfigValue('hdhive.tgtodrive.authorized', false);
        ConfigService.setConfigValue('hdhive.tgtodrive.user', null);
        ConfigService.setConfigValue('hdhive.tgtodrive.checkedAt', null);
        ConfigService.setConfigValue('hdhive.tgtodrive.expiresAt', null);
    }

    private async request(method: 'GET' | 'POST', pathname: string, options: TgtodriveRequestOptions = {}): Promise<TgtodriveApiResult> {
        const installId = this.installId;
        if (!installId) {
            return { success: false, error: '影巢 TgtoDrive 开放平台尚未生成 install_id，请先发起授权', needsOAuth: true };
        }
        const params = options.params || {};
        const path = Object.keys(params).length > 0
            ? `${pathname}${pathname.includes('?') ? '&' : '?'}${this.urlEncode(params)}`
            : pathname;
        const bodyBytes = options.json !== undefined ? Buffer.from(JSON.stringify(options.json), 'utf-8') : Buffer.alloc(0);
        const headers = this.makeAuthHeaders(method, path, installId, bodyBytes);
        headers['Content-Type'] = 'application/json';

        let response: any;
        try {
            response = await got(this.buildUrl(path), {
                method,
                headers,
                body: bodyBytes.length > 0 ? bodyBytes : undefined,
                responseType: 'json',
                timeout: { request: 30000 },
                throwHttpErrors: false,
                ...this.getProxyAgent()
            });
        } catch (error: any) {
            logTaskEvent(`影巢 TgtoDrive 开放平台请求异常: ${error.message}`);
            return { success: false, error: `影巢 TgtoDrive 开放平台请求异常: ${error.message}` };
        }
        return this.normalizeResponse(response);
    }

    private normalizeResponse(response: any): TgtodriveApiResult {
        const body: any = response?.body || {};
        const code = String(body?.code || '');
        if (response?.statusCode === 401 || code === 'REAUTH_REQUIRED' || body?.auth_required === true || body?.data?.auth_required === true) {
            return {
                success: false,
                error: body?.message || body?.description || '影巢授权已失效，请重新授权',
                needsOAuth: true
            };
        }
        if (response?.statusCode >= 400 || (body && typeof body === 'object' && body.success === false)) {
            return { success: false, error: body?.description || body?.message || `HTTP ${response?.statusCode || ''}` };
        }
        return { success: true, data: body?.data !== undefined ? body.data : body };
    }

    private makeAuthHeaders(method: 'GET' | 'POST', path: string, installId: string, bodyBytes: Buffer): Record<string, string> {
        const ts = String(Math.floor(Date.now() / 1000));
        const nonce = crypto.randomBytes(32).toString('base64url');
        const canonical = this.canonicalRequest(method, path, installId, ts, nonce, bodyBytes.toString('utf-8'));
        return {
            'X-Install-Id': installId,
            'X-Timestamp': ts,
            'X-Nonce': nonce,
            'X-Signature': this.sign(canonical)
        };
    }

    private canonicalRequest(method: 'GET' | 'POST', path: string, installId: string, ts: string, nonce: string, bodyText: string): string {
        const parsed = new URL(path, this.baseUrl);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        const query = this.canonicalQueryString(parsed.search.replace(/^\?/, ''));
        return [
            method.toUpperCase(),
            pathname,
            query,
            installId,
            ts,
            nonce,
            crypto.createHash('sha256').update(bodyText, 'utf-8').digest('hex')
        ].join('\n');
    }

    private canonicalQueryString(query: string): string {
        const params = new URLSearchParams(query);
        const items: Array<[string, string]> = [];
        for (const [key, value] of params.entries()) {
            if (value === '') continue;
            items.push([key, value]);
        }
        items.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
        return this.urlEncode(items);
    }

    private urlEncode(params: Record<string, string | number | boolean> | Array<[string, string]>): string {
        const searchParams = new URLSearchParams();
        const entries = Array.isArray(params) ? params : Object.entries(params);
        for (const [key, value] of entries) {
            if (value === '' || value === undefined || value === null) continue;
            searchParams.append(key, String(value));
        }
        return searchParams.toString();
    }

    private sign(canonical: string): string {
        return crypto.createHmac('sha256', this.sharedSecret).update(canonical, 'utf-8').digest('hex');
    }

    private buildUrl(pathname: string): string {
        if (/^https?:\/\//i.test(pathname)) {
            return pathname;
        }
        return `${this.baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`;
    }

    private getProxyAgent(): any {
        return ProxyUtil.getProxyAgent('hdhive');
    }
}

export default new TgtodriveOpenApiClient();
