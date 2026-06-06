import { Application } from 'express';
import hdhiveSDK from './sdk';
const { logTaskEvent } = require('../../utils/logUtils');
const ConfigService = require('../../services/ConfigService');

const sendCallbackPage = (res: any, title: string, message: string, success: boolean) => {
    res.send(`
        <html>
            <head><title>${title}</title></head>
            <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h2 style="color: ${success ? '#27ae60' : '#e74c3c'};">${success ? '授权成功' : '授权失败'}</h2>
                <p>${message}</p>
                <script>
                    if (${success ? 'true' : 'false'} && window.opener) {
                        window.opener.postMessage({ type: 'hdhive_oauth_success' }, '*');
                    }
                    setTimeout(() => window.close(), 2500);
                </script>
            </body>
        </html>
    `);
};

export function setupHdhiveRoutes(app: Application) {
    app.get('/api/hdhive/status', async (req, res) => {
        try {
            res.json({ success: true, data: hdhiveSDK.getAuthStatus() });
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/auth/status', async (req, res) => {
        try {
            res.json({ success: true, data: hdhiveSDK.getAuthStatus() });
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/oauth/url', async (req, res) => {
        try {
            const configuredBaseUrl = ConfigService.getConfigValue('system.baseUrl') || '';
            const fallbackOrigin = `${req.protocol}://${req.get('host')}`;
            const redirectUri = typeof req.query.redirect_uri === 'string'
                ? req.query.redirect_uri
                : `${configuredBaseUrl || fallbackOrigin}/api/hdhive/oauth/callback`;
            res.json({ success: true, data: hdhiveSDK.getOAuthUrl(redirectUri) });
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/oauth/callback', async (req, res) => {
        try {
            const { code, state, error: oauthError, error_description } = req.query;
            if (oauthError) {
                return sendCallbackPage(res, '授权失败', String(error_description || oauthError), false);
            }
            if (!code || !state) {
                return sendCallbackPage(res, '授权失败', '缺少授权参数', false);
            }
            if (!hdhiveSDK.validateOAuthState(String(state))) {
                return sendCallbackPage(res, '授权失败', 'State 验证失败或授权链接已过期', false);
            }
            const configuredBaseUrl = ConfigService.getConfigValue('system.baseUrl') || '';
            const fallbackOrigin = `${req.protocol}://${req.get('host')}`;
            const redirectUri = `${configuredBaseUrl || fallbackOrigin}/api/hdhive/oauth/callback`;
            const result = await hdhiveSDK.exchangeCodeForToken(String(code), redirectUri);
            sendCallbackPage(res, result.success ? '授权成功' : '授权失败', result.success ? '您可以关闭此页面' : (result.error || '授权失败'), result.success);
        } catch (error) {
            sendCallbackPage(res, '授权失败', error instanceof Error ? error.message : String(error), false);
        }
    });

    app.post('/api/hdhive/oauth/revoke', async (req, res) => {
        try {
            res.json(await hdhiveSDK.revokeAuth());
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/ping', async (req, res) => {
        try {
            res.json(await hdhiveSDK.ping());
        } catch (error) {
            res.json({ success: false, message: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/quota', async (req, res) => {
        try {
            res.json(await hdhiveSDK.getQuota());
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/me', async (req, res) => {
        try {
            res.json(await hdhiveSDK.getMe());
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post('/api/hdhive/login', async (req, res) => {
        try {
            const username = typeof req.body?.username === 'string' ? req.body.username : undefined;
            const password = typeof req.body?.password === 'string' ? req.body.password : undefined;
            res.json(await hdhiveSDK.loginWithPassword(username, password));
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post('/api/hdhive/bridge/cookies', async (req, res) => {
        try {
            res.json(await hdhiveSDK.syncCookieFromBridge());
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post('/api/hdhive/checkin', async (req, res) => {
        try {
            res.json(await hdhiveSDK.checkinByBridge());
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/points-logs', async (req, res) => {
        try {
            res.json(await hdhiveSDK.getPointsLogsByBridge({
                page: typeof req.query.page === 'string' ? req.query.page : 1,
                page_size: typeof req.query.page_size === 'string' ? req.query.page_size : 20
            }));
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/resources', async (req, res) => {
        try {
            const type = typeof req.query.type === 'string' ? req.query.type : '';
            const tmdbId = typeof req.query.tmdbId === 'string' ? req.query.tmdbId : '';
            if (!['movie', 'tv'].includes(type) || !tmdbId) {
                return res.json({ success: false, error: 'type 和 tmdbId 参数不能为空' });
            }
            res.json(await hdhiveSDK.getResources(type as 'movie' | 'tv', tmdbId));
        } catch (error) {
            logTaskEvent('影巢资源查询失败:' + error);
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.post('/api/hdhive/unlock', async (req, res) => {
        try {
            const slug = String(req.body?.slug || '').trim();
            if (!slug) {
                return res.json({ success: false, error: 'slug 参数不能为空' });
            }
            res.json(await hdhiveSDK.unlockResource(slug));
        } catch (error) {
            logTaskEvent('影巢资源解锁失败:' + error);
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/detail', async (req, res) => {
        try {
            const url = typeof req.query.url === 'string' ? req.query.url : '';
            if (!url) {
                return res.json({ success: false, error: 'url 参数不能为空' });
            }
            res.json(await hdhiveSDK.detail(url));
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    app.get('/api/hdhive/search', async (req, res) => {
        try {
            const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
            const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 20;
            if (!hdhiveSDK.enabled) {
                return res.json({ success: false, error: '未启用影巢，请先在媒体设置中启用并配置 Cookie 或 OpenAPI 凭证' });
            }
            res.json({ success: true, data: await hdhiveSDK.search(keyword, limit) });
        } catch (error) {
            logTaskEvent('影巢搜索失败:' + error);
            res.json({ success: false, error: '影巢搜索失败:' + (error instanceof Error ? error.message : String(error)) });
        }
    });

    app.post('/api/hdhive/cache/clear', async (req, res) => {
        try {
            hdhiveSDK.clearCache();
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
}
