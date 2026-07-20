require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { AppDataSource, ensureDatabaseColumns, ensureDatabaseIndexes } = require('./database');
const { Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig, TaskProcessedFile, WorkflowRun } = require('./entities');
const { TaskService } = require('./services/task');
const { Cloud189Service } = require('./services/cloud189');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager')
const ConfigService = require('./services/ConfigService');
const packageJson = require('../package.json');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { SchedulerService } = require('./services/scheduler');
const { logTaskEvent, initSSE, sendAIMessage } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const fs = require('fs').promises;
const path = require('path');
const { setupCloudSaverRoutes, clearCloudSaverToken } = require('./sdk/cloudsaver');
const { setupHdhiveRoutes } = require('./sdk/hdhive');
const { Like, Not, IsNull, In, Or } = require('typeorm');
const cors = require('cors'); 
const { EmbyService } = require('./services/emby');
const { EmbyPrewarmService } = require('./services/embyPrewarm');
const { StrmService } = require('./services/strm');
const AIService = require('./services/ai');
const CustomPushService = require('./services/message/CustomPushService');
const { SubscriptionService } = require('./services/subscription');
const { StrmConfigService } = require('./services/strmConfig');
const { TMDBService } = require('./services/tmdb');
const { StreamProxyService } = require('./services/streamProxy');
const { LazyShareStrmService } = require('./services/lazyShareStrm');
const { OrganizerService } = require('./services/organizer');
const { AutoSeriesService } = require('./services/autoSeries');
const TelegramService = require('./services/message/TelegramService');
const { CasService } = require('./services/casService');
const { CasImportService } = require('./services/casImportService');
const { DoubanService } = require('./services/douban');
const multer = require('multer');

const appPort = Number(process.env.PORT || 3000);
let embyStandaloneProxyServer = null;
const publicDir = path.join(__dirname, 'public');
const PASSWORD_HASH_ALGORITHM = 'pbkdf2_sha256';
const PASSWORD_HASH_ITERATIONS = 210000;
const PASSWORD_HASH_KEY_LENGTH = 32;
const PASSWORD_HASH_DIGEST = 'sha256';
const LOGIN_FAILURE_DELAY_MS = Number(process.env.LOGIN_FAILURE_DELAY_MS || 500);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX || 10);
const LOGIN_FAILURE_CLEANUP_INTERVAL_MS = 60 * 1000;
const loginFailures = new Map();
let lastLoginFailureCleanupAt = 0;

const normalizeTelegramSettings = (settings = {}) => {
    const normalized = JSON.parse(JSON.stringify(settings || {}));
    normalized.telegram = normalized.telegram || {};
    normalized.telegram.bot = normalized.telegram.bot || {};

    if (normalized.telegram.enable != null && normalized.telegram.bot.enable == null) {
        normalized.telegram.bot.enable = normalized.telegram.enable;
    }
    if (normalized.telegram.botToken && !normalized.telegram.bot.botToken) {
        normalized.telegram.bot.botToken = normalized.telegram.botToken;
    }
    if (normalized.telegram.chatId && !normalized.telegram.bot.chatId) {
        normalized.telegram.bot.chatId = normalized.telegram.chatId;
    }

    normalized.telegram.bot.enable = !!normalized.telegram.bot.enable;
    normalized.telegram.bot.botToken = normalized.telegram.bot.botToken || '';
    normalized.telegram.bot.chatId = normalized.telegram.bot.chatId || '';
    normalized.telegram.notifyOnSuccess = normalized.telegram.notifyOnSuccess ?? true;
    normalized.telegram.notifyOnFailure = normalized.telegram.notifyOnFailure ?? true;
    normalized.telegram.notifyOnScrape = normalized.telegram.notifyOnScrape ?? false;
    normalized.telegram.bot.allowedChatIds = Array.isArray(normalized.telegram.bot.allowedChatIds)
        ? [...new Set(normalized.telegram.bot.allowedChatIds.map(id => String(id).trim()).filter(Boolean))]
        : [];
    normalized.telegram.bot.adminChatIds = Array.isArray(normalized.telegram.bot.adminChatIds)
        ? [...new Set(normalized.telegram.bot.adminChatIds.map(id => String(id).trim()).filter(Boolean))]
        : [];

    return normalized;
};

const parseOrigin = (value = '') => {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return '';
    }
    try {
        return new URL(/^https?:\/\//i.test(normalized) ? normalized : `http://${normalized}`).origin;
    } catch {
        return '';
    }
};

const getAllowedCorsOrigins = () => {
    const envOrigins = String(process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || '')
        .split(',')
        .map(parseOrigin)
        .filter(Boolean);
    const configuredBaseUrl = parseOrigin(ConfigService.getConfigValue('system.baseUrl') || process.env.PUBLIC_BASE_URL || '');
    return new Set([
        ...envOrigins,
        configuredBaseUrl
    ].filter(Boolean));
};

const isDevelopmentCorsOrigin = (origin = '') => {
    if (process.env.NODE_ENV === 'production') {
        return false;
    }
    return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
};

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) {
            callback(null, true);
            return;
        }
        if (getAllowedCorsOrigins().has(origin) || isDevelopmentCorsOrigin(origin)) {
            callback(null, true);
            return;
        }
        callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
    credentials: true
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const pbkdf2 = (password, salt, iterations) => new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, PASSWORD_HASH_KEY_LENGTH, PASSWORD_HASH_DIGEST, (error, derivedKey) => {
        if (error) {
            reject(error);
            return;
        }
        resolve(derivedKey);
    });
});

const timingSafeCompare = (left = '', right = '') => {
    const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
    const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
};

const isPasswordHash = (value = '') => String(value || '').startsWith(`${PASSWORD_HASH_ALGORITHM}$`);

const hashPassword = async (password) => {
    const salt = crypto.randomBytes(16).toString('base64url');
    const derivedKey = await pbkdf2(String(password), salt, PASSWORD_HASH_ITERATIONS);
    return `${PASSWORD_HASH_ALGORITHM}$${PASSWORD_HASH_ITERATIONS}$${salt}$${derivedKey.toString('base64url')}`;
};

const verifyPassword = async (password, storedPassword) => {
    if (!password || !storedPassword) {
        return false;
    }
    if (!isPasswordHash(storedPassword)) {
        return timingSafeCompare(password, storedPassword);
    }

    const parts = String(storedPassword).split('$');
    if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_ALGORITHM) {
        return false;
    }
    const iterations = Number(parts[1]);
    const salt = parts[2];
    const storedKey = parts[3];
    if (!Number.isInteger(iterations) || iterations <= 0 || !salt || !storedKey) {
        return false;
    }
    const derivedKey = await pbkdf2(String(password), salt, iterations);
    return timingSafeCompare(derivedKey.toString('base64url'), storedKey);
};

const getLoginRateLimitKey = (req) => {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
};

const getLoginFailureState = (key) => {
    const now = Date.now();
    const state = loginFailures.get(key);
    if (!state || state.resetAt <= now) {
        if (state) {
            loginFailures.delete(key);
        }
        return { count: 0, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS };
    }
    return state;
};

const cleanupExpiredLoginFailures = () => {
    const now = Date.now();
    if (now - lastLoginFailureCleanupAt < LOGIN_FAILURE_CLEANUP_INTERVAL_MS) {
        return;
    }
    lastLoginFailureCleanupAt = now;
    for (const [key, state] of loginFailures.entries()) {
        if (!state || state.resetAt <= now) {
            loginFailures.delete(key);
        }
    }
};

const getLoginRetryAfterSeconds = (req) => {
    if (LOGIN_RATE_LIMIT_MAX <= 0) {
        return 0;
    }
    cleanupExpiredLoginFailures();
    const state = getLoginFailureState(getLoginRateLimitKey(req));
    if (state.count < LOGIN_RATE_LIMIT_MAX) {
        return 0;
    }
    return Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
};

const recordLoginFailure = (req) => {
    if (LOGIN_RATE_LIMIT_MAX <= 0) {
        return;
    }
    const key = getLoginRateLimitKey(req);
    const state = getLoginFailureState(key);
    loginFailures.set(key, {
        count: state.count + 1,
        resetAt: state.resetAt
    });
};

const clearLoginFailures = (req) => {
    loginFailures.delete(getLoginRateLimitKey(req));
};

const getBearerToken = (authorization = '') => {
    const value = String(authorization || '').trim();
    const match = value.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
};

const getEmbyWebhookSecret = () => String(
    process.env.EMBY_WEBHOOK_SECRET || ConfigService.getConfigValue('emby.webhookSecret', '')
).trim();

const getEmbyWebhookToken = (req) => String(
    req.headers['x-emby-token']
    || req.headers['x-webhook-token']
    || req.headers['x-cloud189-webhook-token']
    || getBearerToken(req.headers.authorization)
    || req.query?.token
    || ''
).trim();

const authenticateEmbyWebhook = (req, res, next) => {
    const secret = getEmbyWebhookSecret();
    if (!secret) {
        if (ConfigService.getConfigValue('emby.allowUnauthenticatedWebhook', false) === true) {
            return next();
        }
        logTaskEvent('Emby Webhook 已拒绝: 未配置 emby.webhookSecret 或 EMBY_WEBHOOK_SECRET');
        return res.status(403).send('Forbidden');
    }

    const token = getEmbyWebhookToken(req);
    if (token && timingSafeCompare(token, secret)) {
        return next();
    }

    logTaskEvent('Emby Webhook 已拒绝: 凭据无效');
    return res.status(403).send('Forbidden');
};

const sendLoginFailure = async (req, res, extra = {}) => {
    recordLoginFailure(req);
    await delay(LOGIN_FAILURE_DELAY_MS);
    res.json({ success: false, error: '用户名或密码错误', ...extra });
};

const prepareSettingsForSave = async (settings) => {
    if (!settings.system) {
        return settings;
    }
    const incomingPassword = settings.system.password;
    const currentPassword = ConfigService.getConfigValue('system.password') || '';
    if (!incomingPassword) {
        settings.system.password = currentPassword && !isPasswordHash(currentPassword)
            ? await hashPassword(currentPassword)
            : currentPassword;
        return settings;
    }
    if (!isPasswordHash(incomingPassword)) {
        settings.system.password = await hashPassword(incomingPassword);
    }
    return settings;
};

const redactSettingsForClient = (settings = {}) => {
    const redacted = JSON.parse(JSON.stringify(settings || {}));
    if (redacted.system?.password) {
        redacted.system.password = '';
    }
    if (redacted.hdhive?.cookie) {
        redacted.hdhive.cookie = '';
        redacted.hdhive.hasCookie = true;
    } else if (redacted.hdhive) {
        redacted.hdhive.hasCookie = false;
    }
    if (redacted.hdhive?.password) {
        redacted.hdhive.password = '';
        redacted.hdhive.hasPassword = true;
    } else if (redacted.hdhive) {
        redacted.hdhive.hasPassword = false;
    }
    if (redacted.hdhive?.apiKey) {
        redacted.hdhive.apiKey = '';
        redacted.hdhive.hasApiKey = true;
    } else if (redacted.hdhive) {
        redacted.hdhive.hasApiKey = false;
    }
    if (redacted.hdhive?.browserBridge?.token) {
        redacted.hdhive.browserBridge.token = '';
        redacted.hdhive.browserBridge.hasToken = true;
    } else if (redacted.hdhive?.browserBridge) {
        redacted.hdhive.browserBridge.hasToken = false;
    }
    if (redacted.emby?.webhookSecret) {
        redacted.emby.webhookSecret = '';
        redacted.emby.hasWebhookSecret = true;
    } else if (redacted.emby) {
        redacted.emby.hasWebhookSecret = false;
    }
    return redacted;
};

const preserveHdhiveSensitiveOnEmptyInput = (settings = {}) => {
    if (settings.hdhive) {
        const currentHdhive = ConfigService.getConfigValue('hdhive', {}) || {};
        const nextCookie = String(settings.hdhive.cookie || '').trim();
        const nextApiKey = String(settings.hdhive.apiKey || '').trim();
        const nextPassword = String(settings.hdhive.password || '').trim();
        const nextBridgeToken = String(settings.hdhive.browserBridge?.token || '').trim();
        settings.hdhive = {
            ...currentHdhive,
            ...settings.hdhive,
            cookie: nextCookie || ConfigService.getConfigValue('hdhive.cookie', ''),
            apiKey: nextApiKey || ConfigService.getConfigValue('hdhive.apiKey', ''),
            password: nextPassword || ConfigService.getConfigValue('hdhive.password', ''),
            browserBridge: {
                ...(currentHdhive.browserBridge || {}),
                ...(settings.hdhive.browserBridge || {}),
                token: nextBridgeToken || ConfigService.getConfigValue('hdhive.browserBridge.token', '')
            }
        };
    }
    return settings;
};

const preserveEmbySensitiveOnEmptyInput = (settings = {}) => {
    if (settings.emby) {
        const currentEmby = ConfigService.getConfigValue('emby', {}) || {};
        const nextWebhookSecret = String(settings.emby.webhookSecret || '').trim();
        settings.emby = {
            ...currentEmby,
            ...settings.emby,
            webhookSecret: nextWebhookSecret || ConfigService.getConfigValue('emby.webhookSecret', '')
        };
    }
    return settings;
};

const maskUsername = (username = '') => String(username || '').replace(/(.{3}).*(.{4})/, '$1****$2');

const normalizeCapacity = (capacity = {}) => ({
    cloudCapacityInfo: capacity.cloudCapacityInfo || { usedSize: 0, totalSize: 0 },
    familyCapacityInfo: capacity.familyCapacityInfo || { usedSize: 0, totalSize: 0 }
});

const parsePaginationInt = (value, fallback, maxValue = 200) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.min(parsed, maxValue);
};

const getStandaloneEmbyProxyPort = () => {
    const configuredPort = Number(
        ConfigService.getConfigValue('emby.proxy.port')
        || process.env.EMBY_PROXY_PORT
        || 8097
    );
    return Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 8097;
};

const closeStandaloneEmbyProxyServer = async () => {
    if (!embyStandaloneProxyServer) {
        return;
    }

    const server = embyStandaloneProxyServer;
    embyStandaloneProxyServer = null;
    await new Promise((resolve) => {
        server.close((error) => {
            if (error) {
                console.error('关闭 Emby 独立反代端口失败:', error.message);
            } else {
                console.log('Emby 独立反代端口已关闭');
            }
            resolve();
        });
    });
};

const isEmbyProxyRequestPath = (requestUrl = '', basePath = '/emby-proxy') => {
    const pathname = String(requestUrl || '/').split('?')[0];
    if (!basePath) {
        return true;
    }
    return pathname === basePath || pathname.startsWith(`${basePath}/`);
};

const loginPageFallbackHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - 天翼云盘自动转存系统</title>
    <style>
        :root {
            --bg: #f8fafc;
            --card: #ffffff;
            --border: #dbe3f0;
            --text: #0f172a;
            --muted: #475569;
            --primary: #0b57d0;
            --primary-hover: #0948ad;
            --danger: #dc2626;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0f172a;
                --card: #1e293b;
                --border: #334155;
                --text: #f8fafc;
                --muted: #94a3b8;
            }
        }

        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: var(--bg);
            color: var(--text);
            transition: background-color 0.3s, color 0.3s;
        }
        .card {
            width: 100%;
            max-width: 420px;
            padding: 40px;
            border-radius: 28px;
            background: var(--card);
            border: 1px solid var(--border);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
        }
        .eyebrow {
            margin: 0 0 12px;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.1em;
            color: var(--primary);
            text-transform: uppercase;
        }
        h1 {
            margin: 0 0 8px;
            font-size: 32px;
            font-weight: 600;
            color: var(--text);
        }
        p {
            margin: 0 0 32px;
            color: var(--muted);
            line-height: 1.6;
            font-size: 15px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            font-size: 14px;
            font-weight: 600;
            color: var(--text);
        }
        input {
            width: 100%;
            height: 52px;
            padding: 0 16px;
            margin-bottom: 20px;
            border: 1px solid var(--border);
            border-radius: 16px;
            font-size: 16px;
            background: var(--bg);
            color: var(--text);
            outline: none;
            transition: all 0.2s;
        }
        input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 4px rgba(11, 87, 208, 0.1);
        }
        button {
            width: 100%;
            height: 52px;
            border: 0;
            border-radius: 16px;
            background: var(--primary);
            color: #ffffff;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
            margin-top: 8px;
        }
        button:hover { 
            background: var(--primary-hover);
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(11, 87, 208, 0.2);
        }
        button:active {
            transform: translateY(0);
        }
        button:disabled { 
            opacity: 0.6; 
            cursor: not-allowed; 
            transform: none;
        }
        .error {
            min-height: 20px;
            margin-top: 16px;
            color: var(--danger);
            font-size: 14px;
            text-align: center;
            font-weight: 500;
        }
    </style>
</head>
<body>
    <main class="card">
        <div class="eyebrow">Cloud189 Auto Save</div>
        <h1>登录</h1>
        <p>输入系统账号后进入控制台。</p>
        <form id="loginForm">
            <label for="username">用户名</label>
            <input id="username" name="username" type="text" autocomplete="username" required />
            <label for="password">密码</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
            <button id="submitButton" type="submit">登录</button>
            <div id="errorMessage" class="error"></div>
        </form>
    </main>
    <script>
        const form = document.getElementById('loginForm');
        const submitButton = document.getElementById('submitButton');
        const errorMessage = document.getElementById('errorMessage');
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            errorMessage.textContent = '';
            submitButton.disabled = true;
            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: document.getElementById('username').value,
                        password: document.getElementById('password').value
                    })
                });
                const data = await response.json();
                if (data.success) {
                    window.location.href = '/';
                    return;
                }
                errorMessage.textContent = data.error || '登录失败';
            } catch (error) {
                errorMessage.textContent = '登录请求失败';
            } finally {
                submitButton.disabled = false;
            }
        });
    </script>
</body>
</html>`;

const sendPublicFileOrFallback = async (res, fileName, fallbackHtml) => {
    const filePath = path.join(publicDir, fileName);
    try {
        await fs.access(filePath);
        res.sendFile(filePath);
    } catch (error) {
        if (fallbackHtml) {
            res.type('html').send(fallbackHtml);
            return;
        }
        throw error;
    }
};

const createStandaloneEmbyProxyApp = (embyService) => {
    const proxyApp = express();
    proxyApp.set('trust proxy', true);
    proxyApp.use(cors(corsOptions));
    proxyApp.use(async (req, res) => {
        await embyService.handleProxyRequest(req, res, { basePath: '' });
    });
    return proxyApp;
};

const syncStandaloneEmbyProxyServer = async (embyService) => {
    const shouldEnableStandaloneProxy = !!ConfigService.getConfigValue('emby.proxy.enable');
    const proxyPort = getStandaloneEmbyProxyPort();

    if (!shouldEnableStandaloneProxy) {
        await closeStandaloneEmbyProxyServer();
        return;
    }

    if (proxyPort === appPort) {
        console.warn(`Emby 独立反代端口 ${proxyPort} 与主服务端口冲突，已跳过启动`);
        await closeStandaloneEmbyProxyServer();
        return;
    }

    if (embyStandaloneProxyServer) {
        const currentPort = embyStandaloneProxyServer.address()?.port;
        if (currentPort === proxyPort) {
            return;
        }
        await closeStandaloneEmbyProxyServer();
    }

    const proxyApp = createStandaloneEmbyProxyApp(embyService);
    await new Promise((resolve, reject) => {
        const server = proxyApp.listen(proxyPort, () => {
            embyStandaloneProxyServer = server;
            console.log(`Emby 独立反代运行在 http://localhost:${proxyPort}`);
            resolve();
        });
        server.on('upgrade', (req, socket, head) => {
            embyService.handleProxyUpgrade(req, socket, head, { basePath: '' }).catch((error) => {
                console.error('Emby 独立反代 WebSocket 失败:', error.message);
                socket.destroy();
            });
        });
        server.once('error', reject);
    });
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors(corsOptions));
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));

// 生成或读取会话密钥
const getSessionSecret = () => {
    // 优先从环境变量读取
    if (process.env.SESSION_SECRET) {
        return process.env.SESSION_SECRET;
    }
    // 从配置文件读取或生成随机密钥
    const configSecret = ConfigService.getConfigValue('system.sessionSecret');
    if (configSecret) {
        return configSecret;
    }
    // 生成随机密钥并保存到配置
    const newSecret = crypto.randomBytes(32).toString('hex');
    ConfigService.setConfigValue('system.sessionSecret', newSecret);
    return newSecret;
};

app.use(session({
    store: new FileStore({
        path: './data/sessions',  // session文件存储路径
        ttl: 30 * 24 * 60 * 60,  // session过期时间，单位秒
        reapInterval: 3600,       // 清理过期session间隔，单位秒
        retries: 0,           // 设置重试次数为0
        logFn: () => {},      // 禁用内部日志
        reapAsync: true,      // 异步清理过期session
    }),
    secret: getSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 * 30, // 30天
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    }
}));


// 验证会话的中间件
const authenticateSession = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const configApiKey = ConfigService.getConfigValue('system.apiKey');
    if (apiKey && configApiKey && timingSafeCompare(apiKey, configApiKey)) {
        return next();
    }
    if (req.session.authenticated) {
        next();
    } else {
        // API 请求返回 401，页面请求重定向到登录页
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ success: false, error: '未登录' });
        } else {
            res.redirect('/login');
        }
    }
};

// 添加根路径处理
app.get('/', async (req, res) => {
    if (!req.session.authenticated) {
        res.redirect('/login');
        return;
    }
    await sendPublicFileOrFallback(res, 'index.html');
});


// 登录页面
app.get('/login', async (req, res) => {
    await sendPublicFileOrFallback(res, 'login.html', loginPageFallbackHtml);
});

// 登录接口
app.post('/api/auth/login', async (req, res) => {
    try {
        const retryAfterSeconds = getLoginRetryAfterSeconds(req);
        if (retryAfterSeconds > 0) {
            res.set('Retry-After', String(retryAfterSeconds));
            res.status(429).json({ success: false, error: `登录失败次数过多，请 ${retryAfterSeconds} 秒后再试` });
            return;
        }

        const { username, password, newUsername, newPassword } = req.body || {};
        const configUsername = ConfigService.getConfigValue('system.username');
        const configPassword = ConfigService.getConfigValue('system.password');

        // 检查是否为首次设置（密码为空）
        if (!configPassword) {
            // 首次登录，需要设置用户名和密码
            const usernameToSet = newUsername || username;
            const passwordToSet = newPassword || password;

            // 验证用户名
            if (!usernameToSet || usernameToSet.trim().length === 0) {
                res.json({ success: false, error: '请设置用户名', requireSetCredentials: true });
                return;
            }

            // 验证密码
            if (!passwordToSet || passwordToSet.length < 6) {
                res.json({ success: false, error: '请设置密码（至少6位）', requireSetCredentials: true });
                return;
            }

            // 保存用户名和密码
            ConfigService.setConfigValue('system.username', usernameToSet.trim());
            ConfigService.setConfigValue('system.password', await hashPassword(passwordToSet));
            clearLoginFailures(req);
            req.session.authenticated = true;
            req.session.username = usernameToSet.trim();
            res.json({ success: true, message: '用户名和密码设置成功' });
            return;
        }

        // 检查用户名是否匹配
        if (!timingSafeCompare(username || '', configUsername || '')) {
            await sendLoginFailure(req, res);
            return;
        }

        // 验证密码
        if (await verifyPassword(password || '', configPassword)) {
            if (!isPasswordHash(configPassword)) {
                ConfigService.setConfigValue('system.password', await hashPassword(password));
            }
            clearLoginFailures(req);
            req.session.authenticated = true;
            req.session.username = username;
            res.json({ success: true });
        } else {
            await sendLoginFailure(req, res);
        }
    } catch (error) {
        console.error('登录处理失败:', error);
        res.status(500).json({ success: false, error: '登录失败' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((error) => {
        if (error) {
            res.status(500).json({ success: false, error: '退出登录失败' });
            return;
        }
        res.clearCookie('connect.sid');
        res.json({ success: true });
    });
});

app.get('/api/auth/me', (req, res) => {
    const configPassword = ConfigService.getConfigValue('system.password');
    if (!req.session.authenticated) {
        res.json({
            success: false,
            error: '未登录',
            requireSetCredentials: !configPassword
        });
        return;
    }
    res.json({ success: true, username: req.session.username || '' });
});

app.use(express.static(publicDir));
// 为所有路由添加认证（除了登录页和登录接口）
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/login' 
        || req.path === '/api/auth/login' 
        || req.path.startsWith('/api/stream/')
        || req.path === '/emby-proxy'
        || req.path.startsWith('/emby-proxy/')
        || req.path === '/emby/notify'
        || req.path.startsWith('/assets/')
        || req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2|woff|ttf)$/)) {
        return next();
    }
    authenticateSession(req, res, next);
});
// 初始化数据库连接
AppDataSource.initialize().then(async () => {
    // 当前版本:
    const currentVersion = packageJson.version;
    console.log(`当前系统版本: ${currentVersion}`);
    console.log('数据库连接成功');
    await ensureDatabaseColumns();
    await ensureDatabaseIndexes();

    // 初始化 STRM 目录权限
    const strmBaseDir = path.join(__dirname, '../strm');
    try {
        await fs.mkdir(strmBaseDir, { recursive: true });
        if (process.getuid && process.getuid() === 0) {
            await fs.chown(strmBaseDir, parseInt(process.env.PUID || 0), parseInt(process.env.PGID || 0));
        }
        await fs.chmod(strmBaseDir, 0o777);
        console.log('STRM目录权限初始化完成');
    } catch (error) {
        console.error('STRM目录权限初始化失败:', error);
    }

    const accountRepo = AppDataSource.getRepository(Account);
    const taskRepo = AppDataSource.getRepository(Task);
    const commonFolderRepo = AppDataSource.getRepository(CommonFolder);
    const subscriptionRepo = AppDataSource.getRepository(Subscription);
    const subscriptionResourceRepo = AppDataSource.getRepository(SubscriptionResource);
    const strmConfigRepo = AppDataSource.getRepository(StrmConfig);
    const taskService = new TaskService(taskRepo, accountRepo);
    const organizerService = new OrganizerService(taskService, taskRepo);
    const subscriptionService = new SubscriptionService(subscriptionRepo, subscriptionResourceRepo, accountRepo, taskService);
    const strmConfigService = new StrmConfigService(strmConfigRepo, accountRepo, subscriptionRepo, subscriptionResourceRepo);
    const streamProxyService = new StreamProxyService(accountRepo);
    const lazyShareStrmService = new LazyShareStrmService(accountRepo, taskService);
    const casImportService = new CasImportService(accountRepo);
    await casImportService.init();
    const casImportUpload = multer({
        storage: multer.diskStorage({
            destination: async (req, file, cb) => {
                try {
                    await require('fs').promises.mkdir(casImportService.tmpDir, { recursive: true });
                    cb(null, casImportService.tmpDir);
                } catch (error) {
                    cb(error);
                }
            },
            filename: (req, file, cb) => {
                const safe = String(file.originalname || 'upload.bin').replace(/[\/\\]/g, '_');
                cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
            }
        }),
        limits: {
            fileSize: 100 * 1024 * 1024,
            files: 1
        },
        fileFilter: (req, file, cb) => {
            const name = String(file.originalname || '').toLowerCase();
            if (name.endsWith('.cas') || name.endsWith('.zip')) {
                cb(null, true);
                return;
            }
            cb(new Error('仅支持上传 .cas 或 .zip 文件'));
        }
    });
    const autoSeriesService = new AutoSeriesService(taskService, accountRepo, lazyShareStrmService);
    const tmdbService = new TMDBService();
    const doubanService = new DoubanService();
    const embyService = new EmbyService(taskService)
    const embyPrewarmService = new EmbyPrewarmService(embyService);
    embyService.attachPrewarmService(embyPrewarmService);
    const messageUtil = new MessageUtil();
    // 机器人管理
    const botManager = TelegramBotManager.getInstance();
    // 初始化机器人
    await botManager.handleBotStatus(
        ConfigService.getConfigValue('telegram.bot.botToken'),
        ConfigService.getConfigValue('telegram.bot.chatId'),
        ConfigService.getConfigValue('telegram.bot.enable'),
        {
            allowedChatIds: ConfigService.getConfigValue('telegram.bot.allowedChatIds') || [],
            adminChatIds: ConfigService.getConfigValue('telegram.bot.adminChatIds') || [],
        }
    );
    // 初始化缓存管理器
    const folderCache = new CacheManager(parseInt(600));
    // 初始化任务定时器
    await SchedulerService.initTaskJobs(taskRepo, taskService);
    await SchedulerService.initStrmConfigJobs(strmConfigRepo, strmConfigService);
    await embyPrewarmService.reload();

    app.use('/emby-proxy', async (req, res) => {
        await embyService.handleProxyRequest(req, res, { basePath: '/emby-proxy' });
    });
    
    // 账号相关API
    app.get('/api/accounts', async (req, res) => {
        const accounts = await accountRepo.find();
        // 获取容量
        for (const account of accounts) {
            
            account.capacity = {
                cloudCapacityInfo: {usedSize:0,totalSize:0},
                familyCapacityInfo: {usedSize:0,totalSize:0}
            }
            // 如果账号名是s打头 则不获取容量
            if (!account.username.startsWith('n_')) {
                const cloud189 = Cloud189Service.getInstance(account);
                const capacity = await cloud189.getUserSizeInfo()
                if (capacity && capacity.res_code == 0) {
                    account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                    account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                }
            }
            account.original_username = account.username;
            account.accountType = account.accountType || 'personal';
            account.familyId = account.familyId || '';
            account.driveLabel = account.accountType === 'family' ? '家庭云' : '个人云';
            // username脱敏
            account.username = maskUsername(account.username);
        }
        res.json({ success: true, data: accounts });
    });

    app.get('/api/accounts/storage-summary', async (req, res) => {
        try {
            if (!ConfigService.getConfigValue('task.enableStorageAggregation', true)) {
                return res.json({ success: true, data: { enabled: false, cloud: { used: 0, total: 0 }, family: { used: 0, total: 0 }, accounts: [] } });
            }
            const accounts = await accountRepo.find();
            const summary = {
                enabled: true,
                cloud: { used: 0, total: 0 },
                family: { used: 0, total: 0 },
                accounts: []
            };
            for (const account of accounts) {
                if (!account.username || account.username.startsWith('n_')) {
                    continue;
                }
                let capacity = Cloud189Service.getCachedCapacity(account);
                if (!capacity) {
                    const cloud189 = Cloud189Service.getInstance(account);
                    capacity = await cloud189.getUserSizeInfo();
                }
                if (!capacity || capacity.res_code != 0) {
                    continue;
                }
                const normalized = normalizeCapacity(capacity);
                summary.cloud.used += Number(normalized.cloudCapacityInfo.usedSize || 0);
                summary.cloud.total += Number(normalized.cloudCapacityInfo.totalSize || 0);
                summary.family.used += Number(normalized.familyCapacityInfo.usedSize || 0);
                summary.family.total += Number(normalized.familyCapacityInfo.totalSize || 0);
                summary.accounts.push({
                    id: account.id,
                    username: maskUsername(account.username),
                    alias: account.alias || '',
                    accountType: account.accountType || 'personal',
                    cloud: normalized.cloudCapacityInfo,
                    family: normalized.familyCapacityInfo
                });
            }
            res.json({ success: true, data: summary });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/accounts/refresh-capacity', async (req, res) => {
        try {
            const accountId = req.body?.accountId ? Number(req.body.accountId) : null;
            const accounts = accountId
                ? await accountRepo.find({ where: { id: accountId } })
                : await accountRepo.find();
            let refreshed = 0;
            const errors = [];
            for (const account of accounts) {
                if (!account.username || account.username.startsWith('n_')) {
                    continue;
                }
                try {
                    const cloud189 = Cloud189Service.getInstance(account);
                    const capacity = await cloud189.getUserSizeInfo({ forceRefresh: true });
                    if (capacity && capacity.res_code == 0) {
                        refreshed++;
                    }
                } catch (error) {
                    errors.push({ accountId: account.id, username: maskUsername(account.username), error: error.message });
                }
            }
            res.json({ success: true, data: { refreshed, errors } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/accounts/qr-code', async (req, res) => {
        try {
            const qrAuth = Cloud189Service.createQRAuthService();
            const qrData = await qrAuth.getQRCode();
            res.json({ success: true, data: qrData });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/accounts/qr-status', async (req, res) => {
        try {
            const qrAuth = Cloud189Service.createQRAuthService();
            const qrStatus = await qrAuth.checkQRCodeStatus(req.body || {});
            if (qrStatus?.status === 0 && qrStatus.redirectUrl) {
                const loginToken = await qrAuth.exchangeQRCodeSession(qrStatus.redirectUrl);
                if (!loginToken?.loginName || !loginToken?.accessToken) {
                    throw new Error('扫码登录成功但未返回有效会话');
                }
                const dataDir = path.join(process.cwd(), 'data');
                await fs.mkdir(dataDir, { recursive: true });
                await fs.writeFile(path.join(dataDir, `${loginToken.loginName}.json`), JSON.stringify({
                    accessToken: loginToken.accessToken,
                    refreshToken: loginToken.refreshToken,
                    expiresIn: Date.now() + 6 * 24 * 60 * 60 * 1000
                }), 'utf-8');

                let account = await accountRepo.findOne({ where: { username: loginToken.loginName } });
                if (!account) {
                    account = accountRepo.create({
                        username: loginToken.loginName,
                        password: '',
                        cookies: '',
                        accountType: 'personal',
                        familyId: ''
                    });
                }
                Cloud189Service.invalidateByUsername(account.username);
                try {
                    const cloud189 = Cloud189Service.getInstance(account);
                    const familyInfo = await cloud189.getFamilyInfo();
                    if (familyInfo?.familyId) {
                        account.familyId = String(familyInfo.familyId);
                    }
                } catch (error) {
                    logTaskEvent(`[扫码登录] 获取家庭信息失败: ${error.message}`);
                }
                account.accountType = account.accountType || 'personal';
                await accountRepo.save(account);
                return res.json({
                    success: true,
                    status: 0,
                    data: {
                        accountId: account.id,
                        username: maskUsername(loginToken.loginName),
                        familyId: account.familyId || ''
                    }
                });
            }
            res.json({
                success: true,
                status: qrStatus?.status,
                data: qrStatus,
                message: qrStatus?.status === -106 ? '等待扫码'
                    : qrStatus?.status === -11002 ? '已扫码，请在手机端确认'
                    : qrStatus?.status === -11001 ? '二维码已过期'
                    : qrStatus?.msg || qrStatus?.message || '等待确认'
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const account = accountRepo.create(req.body);
            account.accountType = account.accountType || 'personal';
            account.familyId = account.accountType === 'family' ? (account.familyId || '') : null;
            account.familyFolderId = account.accountType === 'family' ? (req.body.familyFolderId || account.familyFolderId || '') : '';
            Cloud189Service.invalidateByUsername(account.username);
            // 尝试登录, 登录成功写入store, 如果需要验证码, 则返回用户验证码图片
            if (!account.username.startsWith('n_') && account.password) {
                // 尝试登录
                const cloud189 = Cloud189Service.getInstance(account);
                const loginResult = await cloud189.login(account.username, account.password, req.body.validateCode);
                if (!loginResult.success) {
                    if (loginResult.code == "NEED_CAPTCHA") {
                        res.json({
                            success: false,
                            code: "NEED_CAPTCHA",
                            data: {
                                captchaUrl: loginResult.data
                            }
                        });
                        return;
                    }
                    res.json({ success: false, error: loginResult.message });
                    return;
                }
            }
            if (!account.username.startsWith('n_') && account.accountType === 'family') {
                const cloud189 = Cloud189Service.getInstance(account);
                account.familyId = await cloud189.resolveFamilyId(account.familyId || null);
            }
            await accountRepo.save(account);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

     // 清空回收站
     app.delete('/api/accounts/recycle', async (req, res) => {
        try {
            taskService.clearRecycleBin(true, true);
            res.json({ success: true, data: "ok" });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.delete('/api/accounts/:id', async (req, res) => {
        try {
            const account = await accountRepo.findOneBy({ id: parseInt(req.params.id) });
            if (!account) throw new Error('账号不存在');
            Cloud189Service.invalidateByUsername(account.username);
            await accountRepo.remove(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    app.put('/api/accounts/:id/strm-prefix', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { strmPrefix, type } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            if (type == 'local') {
                account.localStrmPrefix = strmPrefix;
            }
            if (type == 'cloud') {
                account.cloudStrmPrefix = strmPrefix;
            }
            if (type == 'emby') {
                account.embyPathReplace = strmPrefix;
            }
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    // 修改别名
    app.put('/api/accounts/:id/alias', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { alias } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            account.alias = alias;
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    app.put('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            // 清除所有账号的默认状态
            await accountRepo.update({}, { isDefault: false });
            // 设置指定账号为默认
            await accountRepo.update({ id: accountId }, { isDefault: true });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.get('/api/accounts/:id/family/folders', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const folderId = req.query.folderId || '';
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);
            const familyInfo = await cloud189.getFamilyInfo();
            if (!familyInfo?.familyId) throw new Error('该账号没有可用家庭空间');
            const folders = await cloud189.listFamilyFolderNodes(familyInfo.familyId, folderId);
            res.json({ success: true, data: { familyId: String(familyInfo.familyId), folders } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/accounts/:id/family-folder', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const familyFolderId = String(req.body?.familyFolderId || '').trim();
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            account.familyFolderId = familyFolderId;
            await accountRepo.save(account);
            Cloud189Service.invalidateByUsername(account.username);
            res.json({ success: true, data: { familyFolderId } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/accounts/keep-alive', async (req, res) => {
        try {
            const result = await taskService.runAccountsKeepAlive();
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // 任务相关API
    app.get('/api/tasks', async (req, res) => {
        const { status } = req.query;
        const search = String(req.query.search || '').trim().slice(0, 100);
        const shouldPaginate = req.query.page != null || req.query.pageSize != null || req.query.limit != null;
        const page = parsePaginationInt(req.query.page, 1, Number.MAX_SAFE_INTEGER);
        const pageSize = parsePaginationInt(req.query.pageSize || req.query.limit, 50, 200);
        let whereClause = { }; // 用于构建最终的 where 条件

        // 基础条件（AND）
        if (status && status !== 'all') {
            whereClause.status = status;
        }
        whereClause.enableSystemProxy = Or(IsNull(), false);

        // 添加搜索过滤
        if (search) {
            const searchConditions = [
                { resourceName: Like(`%${search}%`) },
                { shareFolderName: Like(`%${search}%`) },
                { realFolderName: Like(`%${search}%`) },
                { remark: Like(`%${search}%`) },
                { taskGroup: Like(`%${search}%`) },
                { account: { username: Like(`%${search}%`) } }
            ];
            if (Object.keys(whereClause).length > 0) {
                whereClause = searchConditions.map(searchCond => ({
                    ...whereClause, // 包含基础条件 (如 status)
                    ...searchCond   // 包含一个搜索条件
                }));
            }else{
                whereClause = searchConditions;
            }
        }
        const findOptions = {
            order: { id: 'DESC' },
            relations: {
                account: true
            },
            select: {
                account: {
                    id: true,
                    username: true,
                    accountType: true
                }
            },
            where: whereClause,
            ...(shouldPaginate ? {
                skip: (page - 1) * pageSize,
                take: pageSize
            } : {})
        };
        const [tasks, total] = shouldPaginate
            ? await taskRepo.findAndCount(findOptions)
            : [await taskRepo.find(findOptions), undefined];
        // username脱敏
        tasks.forEach(task => {
            if (task.account?.username) {
                task.account.username = task.account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
            }
            if (task.account) {
                task.account.accountType = task.account.accountType || 'personal';
            }
        });
        res.json({
            success: true,
            data: tasks,
            ...(shouldPaginate ? {
                pagination: {
                    page,
                    pageSize,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / pageSize))
                }
            } : {})
        });
    });

    app.get('/api/organizer/tasks', async (req, res) => {
        try {
            const search = String(req.query.search || '').trim();
            let tasks = await taskRepo.find({
                relations: {
                    account: true
                },
                select: {
                    account: {
                        username: true,
                        alias: true,
                        accountType: true
                    }
                },
                order: {
                    id: 'DESC'
                }
            });

            if (search) {
                const normalizedSearch = search.toLowerCase();
                tasks = tasks.filter(task => [
                    task.resourceName,
                    task.remark,
                    task.taskGroup,
                    task.account?.username,
                    task.account?.alias
                ].some(value => String(value || '').toLowerCase().includes(normalizedSearch)));
            }

            tasks.forEach(task => {
                if (task.account?.username) {
                    task.account.username = task.account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                }
                task.account && (task.account.accountType = task.account.accountType || 'personal');
            });
            res.json({ success: true, data: tasks });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const task = await taskService.createTask(req.body);
            res.json({ success: true, data: task });
        } catch (error) {
            console.log(error)
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/batch-create', async (req, res) => {
        try {
            const result = await taskService.createTasksBatch(req.body.tasks);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/tasks/batch/status', async (req, res) => {
        try {
            const { taskIds, status } = req.body;
            const updatedTasks = await taskService.updateTasksStatus(taskIds, status);
            res.json({ success: true, data: updatedTasks });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tasks/batch', async (req, res) => {
        try {
            const taskIds = req.body.taskIds;
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTasks(taskIds, deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 删除任务文件
    app.delete('/api/tasks/files', async (req, res) => {
        try{
            const { taskId, files } = req.body;
            if (!files || files.length === 0) {
                throw new Error('未选择要删除的文件');
            }
            await taskService.deleteFiles(taskId, files);
            res.json({ success: true, data: null });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.delete('/api/tasks/:id', async (req, res) => {
        try {
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTask(parseInt(req.params.id), deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });


    app.put('/api/tasks/:id', async (req, res) => {
        try {
            const taskId = parseInt(req.params.id);
            const updatedTask = await taskService.updateTask(taskId, req.body);
            res.json({ success: true, data: updatedTask });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/:id/clear-cache', async (req, res) => {
        try {
            const result = await taskService.clearTaskCache(parseInt(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/:id/manual-tmdb', async (req, res) => {
        try {
            const result = await taskService.bindManualTmdb(parseInt(req.params.id), req.body || {});
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/:id/execute', async (req, res) => {
        try {
            const task = await taskRepo.findOne({
                where: { id: parseInt(req.params.id) },
                relations: {
                    account: true
                },
                select: {
                    account: {
                        username: true,
                        localStrmPrefix: true,
                        cloudStrmPrefix: true,
                        embyPathReplace: true,
                        familyId: true,
                        familyFolderId: true
                    }
                }
            });
            if (!task) throw new Error('任务不存在');
            logTaskEvent(`================================`);
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始执行`);
            const result = await taskService.processTask(task);
            if (result) {
                messageUtil.sendMessage(result)
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/organizer/tasks/:id/run', async (req, res) => {
        try {
            const taskId = parseInt(req.params.id);
            const result = await organizerService.organizeTaskById(taskId, {
                triggerStrm: true,
                force: true
            });
            res.json({ success: true, data: result });
        } catch (error) {
            const taskId = parseInt(req.params.id);
            if (!Number.isNaN(taskId)) {
                await organizerService.markError(taskId, error);
            }
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/auto-series', async (req, res) => {
        try {
            const result = await autoSeriesService.createByTitle(req.body || {});
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 手动模式：先搜索候选资源，由前端选择后再调用 /api/auto-series 创建
    app.get('/api/auto-series/search', async (req, res) => {
        try {
            const result = await autoSeriesService.searchResources({
                title: req.query.title,
                year: req.query.year
            });
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // 根据任务生成STRM文件
    app.post('/api/tasks/strm', async (req, res) => {
        try {
            const taskIds = req.body.taskIds;
            if (!taskIds || taskIds.length == 0) {
                throw new Error('任务ID不能为空');
            }
            const overwrite = req.body.overwrite || false;
            taskService.createStrmFileByTask(taskIds, overwrite);
            return res.json({ success: true, data: 'ok' });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    // 按任务重建 STRM（按当前媒体库 layout 规则重算路径；可选刷新 layout）
    app.post('/api/tasks/strm/rebuild', async (req, res) => {
        try {
            const taskIds = req.body.taskIds;
            if (!taskIds || taskIds.length == 0) {
                throw new Error('任务ID不能为空');
            }
            const overwrite = req.body.overwrite !== false;
            const refreshLayout = !!req.body.refreshLayout;
            const deleteOld = req.body.deleteOld !== false;
            // 后台执行，避免大批量阻塞
            taskService.rebuildStrmFileByTask(taskIds, {
                overwrite,
                refreshLayout,
                deleteOld
            }).catch((error) => {
                logTaskEvent(`批量重建STRM失败: ${error.message}`, 'error', 'transfer');
            });
            return res.json({
                success: true,
                data: {
                    message: '重建任务已开始后台执行',
                    count: taskIds.length,
                    refreshLayout,
                    deleteOld
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
     // 获取目录树
     app.get('/api/folders/:accountId', async (req, res) => {
        try {
            const accountId = parseInt(req.params.accountId);
            const folderId = req.query.folderId || '-11';
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `folders_${accountId}_${folderId}`;
            // forceRefresh 为true 则清空所有folders_开头的缓存
            if (forceRefresh) {
                folderCache.clearPrefix("folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }

            const cloud189 = Cloud189Service.getInstance(account);
            const folders = await cloud189.getFolderNodes(folderId);
            if (!folders) {
                throw new Error('获取目录失败');
            }
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 根据分享链接获取文件目录
    app.get('/api/share/folders/:accountId', async (req, res) => {
        try {
            const taskId = parseInt(req.query.taskId);
            const folderId = req.query.folderId;
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `share_folders_${taskId}_${folderId}`;
            if (forceRefresh) {
                folderCache.clearPrefix("share_folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
            if (!task) {
                throw new Error('任务不存在');
            }
            if (folderId == -11) {
                // 返回顶级目录
                res.json({success: true, data: [{id: task.shareFileId, name: task.resourceName}]});
                return 
            }
            const account = await accountRepo.findOneBy({ id: req.params.accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            // 查询分享目录
            const shareDir = await cloud189.listShareDir(task.shareId, req.query.folderId, task.shareMode);
            if (!shareDir || !shareDir.fileListAO) {
                res.json({ success: true, data: [] });    
            }
            const folders = shareDir.fileListAO.folderList;
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

     // 获取目录下的文件
     app.get('/api/folder/files', async (req, res) => {
        const { accountId, taskId } = req.query;
        const account = await accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }
        const task = await taskRepo.findOneBy({ id: taskId });
        if (!task) {
            throw new Error('任务不存在');
        }
        const cloud189 = Cloud189Service.getInstance(account);
        try {
            const fileList =  await taskService.getAllFolderFiles(cloud189, task);    
            res.json({ success: true, data: fileList });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/file-manager/list', async (req, res) => {
        try {
            const accountId = parseInt(req.query.accountId);
            const folderId = req.query.folderId || '-11';
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const result = await cloud189.listFiles(folderId);
            if (!result?.fileListAO) {
                return res.json({
                    success: true,
                    data: {
                        currentFolderId: folderId,
                        entries: []
                    }
                });
            }

            const folderList = (result.fileListAO.folderList || []).map((folder) => ({
                id: String(folder.id),
                name: folder.name,
                isFolder: true,
                size: Number(folder.size || 0),
                lastOpTime: folder.lastOpTime || folder.lastModifyTime || folder.createDate || ''
            }));
            const fileList = (result.fileListAO.fileList || []).map((file) => ({
                id: String(file.id),
                name: file.name,
                isFolder: false,
                size: Number(file.size || 0),
                lastOpTime: file.lastOpTime || file.lastModifyTime || file.createDate || '',
                ext: path.extname(file.name || '').toLowerCase()
            }));
            const entries = [...folderList, ...fileList].sort((left, right) => {
                if (left.isFolder !== right.isFolder) {
                    return left.isFolder ? -1 : 1;
                }
                return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
            });

            res.json({
                success: true,
                data: {
                    currentFolderId: folderId,
                    accountType: account.accountType || 'personal',
                    driveLabel: account.accountType === 'family' ? '家庭云' : '个人云',
                    entries
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/folder', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const parentFolderId = req.body.parentFolderId || '-11';
            const folderName = String(req.body.folderName || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!folderName) {
                throw new Error('目录名称不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const createResult = await cloud189.createFolder(folderName, parentFolderId);
            if (!createResult || createResult.res_code && createResult.res_code !== 0) {
                throw new Error(createResult?.res_msg || '创建目录失败');
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: createResult });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/rename', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const fileId = String(req.body.fileId || '').trim();
            const destFileName = String(req.body.destFileName || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!fileId) {
                throw new Error('文件ID不能为空');
            }
            if (!destFileName) {
                throw new Error('新名称不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const renameResult = await cloud189.renameFile(fileId, destFileName);
            if (!renameResult || renameResult.res_code && renameResult.res_code !== 0) {
                throw new Error(renameResult?.res_msg || '重命名失败');
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: renameResult });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/delete', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!entries.length) {
                throw new Error('未选择需要删除的文件');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const folders = entries.filter((entry) => entry.isFolder);
            const files = entries.filter((entry) => !entry.isFolder);
            if (folders.length) {
                await taskService.deleteCloudFile(cloud189, folders, 1);
            }
            if (files.length) {
                await taskService.deleteCloudFile(cloud189, files, 0);
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/move', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const targetFolderId = String(req.body.targetFolderId || '').trim();
            const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!targetFolderId) {
                throw new Error('目标目录不能为空');
            }
            if (!entries.length) {
                throw new Error('未选择需要移动的文件');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            await taskService.moveCloudFile(cloud189, entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                isFolder: entry.isFolder
            })), targetFolderId);
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/file-manager/download-link', async (req, res) => {
        try {
            const accountId = parseInt(req.query.accountId);
            const fileId = String(req.query.fileId || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!fileId) {
                throw new Error('文件ID不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const downloadUrl = await cloud189.getDownloadLink(fileId);
            res.json({ success: true, data: { url: downloadUrl } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/files/rename', async (req, res) => {
        const {taskId, accountId, files, sourceRegex, targetRegex } = req.body;
        if (files.length == 0) {
            throw new Error('未获取到需要修改的文件');
        }
        const account = await accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }
        const task = await taskService.getTaskById(taskId);
        if (!task) {
            throw new Error('任务不存在');
        }
        // 从realFolderName中获取文件夹名称 删除对应的本地文件
        const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        const strmService = new StrmService();
        const strmEnabled = ConfigService.getConfigValue('strm.enable') && task.account.localStrmPrefix
        if (strmEnabled && task.enableSystemProxy){
            throw new Error('系统代理模式已移除');
        }
        const newFiles = files.map(file => ({id: file.fileId, name: file.destFileName}))
        if(task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        }
        const cloud189 = Cloud189Service.getInstance(account);
        const result = []
        const successFiles = []
        for (const file of files) {
            const renameResult = await cloud189.renameFile(file.fileId, file.destFileName);
            if (!renameResult) {
                throw new Error('重命名失败');
            }
            if (renameResult.res_code != 0) {
                result.push(`文件${file.destFileName} ${renameResult.res_msg}`)
            }else{
                if (strmEnabled){
                    // 从realFolderName中获取文件夹名称 删除对应的本地文件
                    const oldFile = path.join(folderName, file.oldName);
                    await strmService.delete(path.join(task.account.localStrmPrefix, oldFile))
                }
                successFiles.push({id: file.fileId, name: file.destFileName})
            }
        }
        // 重新生成STRM文件
        if (strmEnabled){
            strmService.generate(task, successFiles, false, false)
        }
        if (sourceRegex && targetRegex) {
            task.sourceRegex = sourceRegex
            task.targetRegex = targetRegex
            taskRepo.save(task)
        }
        if (result.length > 0) {
            logTaskEvent(result.join('\n'));
        }
        res.json({ success: true, data: result });
    });

    app.post('/api/tasks/executeAll', async (req, res) => {
        taskService.processAllTasks(true);
        res.json({ success: true, data: null });
    });

    app.get('/api/subscriptions', async (req, res) => {
        try {
            const subscriptions = await subscriptionService.listSubscriptions();
            res.json({ success: true, data: subscriptions });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/preview', async (req, res) => {
        try {
            const preview = await subscriptionService.previewSubscriptionCreation(req.query);
            res.json({ success: true, data: preview });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/remote-resources', async (req, res) => {
        try {
            const resources = await subscriptionService.listRemoteSubscriptionResources(req.query);
            res.json({ success: true, data: resources });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions/task-preview', async (req, res) => {
        try {
            const preview = await subscriptionService.previewAutoTaskCreation(req.body || {});
            res.json({ success: true, data: preview });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions', async (req, res) => {
        try {
            const subscription = await subscriptionService.createSubscription(req.body);
            res.json({ success: true, data: subscription });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/subscriptions/:id', async (req, res) => {
        try {
            const subscription = await subscriptionService.updateSubscription(parseInt(req.params.id), req.body);
            res.json({ success: true, data: subscription });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions/:id/refresh', async (req, res) => {
        try {
            const result = await subscriptionService.refreshSubscription(parseInt(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/subscriptions/:id', async (req, res) => {
        try {
            await subscriptionService.deleteSubscription(parseInt(req.params.id));
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/:id/resources', async (req, res) => {
        try {
            const resources = await subscriptionService.listResources(parseInt(req.params.id));
            res.json({ success: true, data: resources });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions/:id/resources', async (req, res) => {
        try {
            const resource = await subscriptionService.createResource(parseInt(req.params.id), req.body);
            res.json({ success: true, data: resource });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/subscriptions/resources/:id', async (req, res) => {
        try {
            await subscriptionService.deleteResource(parseInt(req.params.id));
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/resources/:id/browse', async (req, res) => {
        try {
            const entries = await subscriptionService.browseResource(
                parseInt(req.params.id),
                req.query.folderId,
                req.query.keyword
            );
            res.json({ success: true, data: entries });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 系统设置
    app.get('/api/settings', async (req, res) => {
        res.json({success: true, data: redactSettingsForClient(normalizeTelegramSettings(ConfigService.getConfig()))})
    })

    app.post('/api/settings', async (req, res) => {
        const settings = preserveEmbySensitiveOnEmptyInput(
            preserveHdhiveSensitiveOnEmptyInput(
                await prepareSettingsForSave(normalizeTelegramSettings(req.body))
            )
        );
        SchedulerService.handleScheduleTasks(settings,taskService);
        ConfigService.setConfig(settings)
        await botManager.handleBotStatus(
            settings.telegram?.bot?.botToken,
            settings.telegram?.bot?.chatId,
            settings.telegram?.bot?.enable,
            {
                allowedChatIds: settings.telegram?.bot?.allowedChatIds || [],
                adminChatIds: settings.telegram?.bot?.adminChatIds || [],
            }
        );
        // 修改配置, 重新实例化消息推送
        messageUtil.updateConfig()
        Cloud189Service.setProxy()
        await embyPrewarmService.reload();
        res.json({success: true, data: null})
    })

    app.post('/api/settings/telegram/test', async (req, res) => {
        try {
            const settings = normalizeTelegramSettings({ telegram: req.body?.telegram || req.body || {} });
            const botToken = settings.telegram?.bot?.botToken;
            const chatId = settings.telegram?.bot?.chatId;
            const proxyDomain = settings.telegram?.proxyDomain || '';
            if (!botToken || !chatId) {
                return res.json({ success: false, error: 'Bot Token 和 Chat ID 不能为空' });
            }
            const telegramService = new TelegramService({
                botToken,
                chatId,
                cfProxyDomain: proxyDomain,
                proxy: {
                    type: 'http',
                    host: ConfigService.getConfigValue('proxy.host') || '',
                    port: ConfigService.getConfigValue('proxy.port') || '',
                    username: ConfigService.getConfigValue('proxy.username') || '',
                    password: ConfigService.getConfigValue('proxy.password') || '',
                }
            });
            telegramService.initialize();
            const ok = await telegramService.sendMessage('✅ Telegram 配置测试成功\n\n如果你收到这条消息，说明 Bot Token、Chat ID 和网络配置均可用。');
            if (!ok) {
                return res.json({ success: false, error: '发送测试消息失败，请检查 Bot Token、Chat ID 或网络配置' });
            }
            return res.json({ success: true, data: null });
        } catch (error) {
            return res.json({ success: false, error: error.message || '测试失败' });
        }
    })


    // 保存媒体配置
    app.post('/api/settings/media', async (req, res) => {
        try {
            const settings = preserveEmbySensitiveOnEmptyInput(
                preserveHdhiveSensitiveOnEmptyInput(req.body || {})
            );
            // 如果cloudSaver的配置变更 就清空cstoken.json
            if (settings.cloudSaver?.baseUrl != ConfigService.getConfigValue('cloudSaver.baseUrl')
            || settings.cloudSaver?.username != ConfigService.getConfigValue('cloudSaver.username')
            || settings.cloudSaver?.password != ConfigService.getConfigValue('cloudSaver.password')
        ) {
                clearCloudSaverToken();
            }
            ConfigService.setConfig(settings)
            await syncStandaloneEmbyProxyServer(embyService);
            await embyPrewarmService.reload();
            res.json({success: true, data: null})
        } catch (error) {
            res.json({success: false, error: error.message})
        }
    })

    app.get('/api/settings/regex-presets', async (req, res) => {
        try {
            res.json({ success: true, data: ConfigService.getConfigValue('regexPresets', []) });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.post('/api/settings/regex-presets', async (req, res) => {
        try {
            const regexPresets = Array.isArray(req.body.regexPresets) ? req.body.regexPresets : [];
            ConfigService.setConfigValue('regexPresets', regexPresets);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.get('/api/version', (req, res) => {
        res.json({ version: currentVersion });
    });

    app.post('/api/strm/lazy-share/generate', async (req, res) => {
        try {
            const result = await lazyShareStrmService.generateFromShare(req.body || {});
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/stream/:token', async (req, res) => {
        try {
            const payload = streamProxyService.parseToken(req.params.token);
            let latestUrl;
            if (payload.type === 'lazyShare') {
                latestUrl = await lazyShareStrmService.resolveLatestUrlByPayload(payload);
            } else if (payload.type === 'casLazy') {
                latestUrl = await casImportService.resolveLazyPlayback(payload);
            } else {
                latestUrl = await streamProxyService.resolveLatestUrlByPayload(payload);
            }
            res.set('Cache-Control', 'no-store');
            res.redirect(302, latestUrl);
        } catch (error) {
            res.status(403).json({ success: false, error: error.message });
        }
    });

    // 解析分享链接
    app.post('/api/share/parse', async (req, res) => {
        try{
            const shareLink = req.body.shareLink;
            const accountId = req.body.accountId;
            const accessCode = req.body.accessCode;
            const shareFolders = await taskService.parseShareFolderByShareLink(shareLink, accountId, accessCode);
            res.json({success: true, data: shareFolders})
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 保存常用目录
    app.post('/api/saveFavorites', async (req, res) => {
        try{
            const favorites = req.body.favorites;
            const accountId = req.body.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            // 先删除该账号下的所有常用目录
            await commonFolderRepo.delete({ accountId: accountId });
            // 构建新的常用目录数据
            const commonFolders = favorites.map(favorite => ({
                accountId: accountId,
                name: favorite.name,
                path: favorite.path,
                id: favorite.id
            }));
            if (commonFolders.length == 0) {
                res.json({ success: true, data: [] });
                return;
            }
            // 批量保存新的常用目录
            const result = await commonFolderRepo.save(commonFolders);
            res.json({ success: true, data: result });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 获取常用目录
    app.get('/api/favorites/:accountId', async (req, res) => {
        try{
            const accountId = req.params.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const favorites = await commonFolderRepo.find({
                where: { accountId: accountId },
                order: { id: 'ASC' }
            });
            res.json({ success: true, data: favorites });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    
    // emby 回调
    app.post('/emby/notify', authenticateEmbyWebhook, async (req, res) => {
        try {
            await embyService.handleWebhookNotification(req.body);
            res.status(200).send('OK');
        }catch (error) {
            console.log(error);
            res.status(500).send('Error');
        }
    })

    app.post('/api/chat', async (req, res) => {
        const { message } = req.body;
        try {
            let userMessage = message.trim();
            if(!userMessage) {
                res.json({ success: true });
                return
            }
            
            AIService.streamChat(userMessage, async (chunk) => {
                sendAIMessage(chunk);
            })
            res.json({ success: true });
        } catch (error) {
            console.error('处理聊天消息失败:', error);
            res.status(500).json({ success: false, error: '处理消息失败' });
        }
    })

    app.post('/api/chat/enhanced', async (req, res) => {
        try {
            const message = String(req.body?.message || '').trim();
            if (!message) {
                return res.json({ success: false, error: '消息不能为空' });
            }
            const tools = [
                { name: 'list_accounts', description: '查看账号与容量概况', readonly: true, params: {} },
                { name: 'storage_summary', description: '查看多账号容量聚合', readonly: true, params: {} },
                { name: 'refresh_capacity', description: '刷新账号容量缓存', readonly: false, params: { accountId: '可选账号ID' } },
                { name: 'run_keep_alive', description: '执行账号Session保活检测', readonly: false, params: {} },
                { name: 'execute_task', description: '立即执行指定任务', readonly: false, params: { taskId: '任务ID' } },
                { name: 'clear_task_cache', description: '清理指定任务转存记录缓存', readonly: false, params: { taskId: '任务ID' } },
                { name: 'search_tmdb', description: '搜索 TMDB 媒体', readonly: true, params: { keyword: '关键词', year: '可选年份' } },
                { name: 'create_task', description: '按分享链接创建任务', readonly: false, params: { accountId: '账号ID', shareLink: '分享链接', targetFolderId: '目标目录ID' } }
            ];
            const lowered = message.toLowerCase();
            const suggestions = tools.filter(tool => {
                if (/容量|空间|storage/.test(lowered)) return ['storage_summary', 'refresh_capacity', 'list_accounts'].includes(tool.name);
                if (/保活|session|登录态|心跳/.test(lowered)) return tool.name === 'run_keep_alive';
                if (/执行|运行/.test(lowered)) return tool.name === 'execute_task';
                if (/缓存|清理/.test(lowered)) return tool.name === 'clear_task_cache';
                if (/tmdb|刮削|影视|电影|剧/.test(lowered)) return tool.name === 'search_tmdb';
                if (/创建|转存|分享/.test(lowered)) return tool.name === 'create_task';
                return tool.readonly;
            });
            res.json({
                success: true,
                data: {
                    message: '已根据当前系统能力生成可执行建议。写操作需要前端二次确认后调用 /api/chat/execute-function。',
                    suggestions: suggestions.length ? suggestions : tools.filter(tool => tool.readonly),
                    tools
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/chat/execute-function', async (req, res) => {
        try {
            const functionName = String(req.body?.name || req.body?.functionName || '').trim();
            const args = req.body?.arguments || req.body?.args || {};
            let result;
            switch (functionName) {
                case 'list_accounts':
                    result = (await accountRepo.find()).map(account => ({
                        id: account.id,
                        username: maskUsername(account.username),
                        alias: account.alias || '',
                        accountType: account.accountType || 'personal',
                        familyId: account.familyId || ''
                    }));
                    break;
                case 'storage_summary': {
                    const accounts = await accountRepo.find();
                    const summary = { cloud: { used: 0, total: 0 }, family: { used: 0, total: 0 }, accounts: [] };
                    for (const account of accounts) {
                        if (!account.username || account.username.startsWith('n_')) continue;
                        const cloud189 = Cloud189Service.getInstance(account);
                        const capacity = await cloud189.getUserSizeInfo();
                        if (!capacity || capacity.res_code != 0) continue;
                        const normalized = normalizeCapacity(capacity);
                        summary.cloud.used += Number(normalized.cloudCapacityInfo.usedSize || 0);
                        summary.cloud.total += Number(normalized.cloudCapacityInfo.totalSize || 0);
                        summary.family.used += Number(normalized.familyCapacityInfo.usedSize || 0);
                        summary.family.total += Number(normalized.familyCapacityInfo.totalSize || 0);
                        summary.accounts.push({ id: account.id, username: maskUsername(account.username), cloud: normalized.cloudCapacityInfo, family: normalized.familyCapacityInfo });
                    }
                    result = summary;
                    break;
                }
                case 'refresh_capacity': {
                    const accounts = args.accountId ? await accountRepo.find({ where: { id: Number(args.accountId) } }) : await accountRepo.find();
                    let refreshed = 0;
                    for (const account of accounts) {
                        if (!account.username || account.username.startsWith('n_')) continue;
                        const capacity = await Cloud189Service.getInstance(account).getUserSizeInfo({ forceRefresh: true });
                        if (capacity && capacity.res_code == 0) refreshed++;
                    }
                    result = { refreshed };
                    break;
                }
                case 'run_keep_alive':
                    result = await taskService.runAccountsKeepAlive();
                    break;
                case 'execute_task': {
                    const task = await taskService.getTaskById(Number(args.taskId));
                    if (!task) throw new Error('任务不存在');
                    result = await taskService.processTask(task);
                    break;
                }
                case 'clear_task_cache':
                    result = await taskService.clearTaskCache(Number(args.taskId));
                    break;
                case 'search_tmdb': {
                    const keyword = String(args.keyword || '').trim();
                    if (!keyword) throw new Error('关键词不能为空');
                    const data = await tmdbService.search(keyword, String(args.year || ''));
                    result = [...(data.movies || []), ...(data.tvShows || [])];
                    break;
                }
                case 'create_task':
                    result = await taskService.createTask(args);
                    break;
                default:
                    throw new Error('不支持的工具函数');
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });


    // STRM相关API
    app.post('/api/strm/generate-all', async (req, res) => {
        try {
            const overwrite = req.body.overwrite || false;
            const accountIds = req.body.accountIds;
            if (!accountIds || accountIds.length == 0) {
                throw new Error('账号ID不能为空');
            }
            const accounts = await accountRepo.find({
                where: {
                    localStrmPrefix: Not(IsNull()),
                    cloudStrmPrefix: Not(IsNull()),
                    id: In(accountIds)
                }
            });
            const strmService = new StrmService();
            strmService.generateAll(accounts, overwrite);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/strm/list', async (req, res) => {
        try {
            const path = req.query.path || '';
            const strmService = new StrmService();
            const files = await strmService.listStrmFiles(path);
            res.json({ success: true, data: files });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/strm/configs', async (req, res) => {
        try {
            const configs = await strmConfigService.listConfigs();
            res.json({ success: true, data: configs });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs', async (req, res) => {
        try {
            const config = await strmConfigService.createConfig(req.body);
            await SchedulerService.refreshStrmConfigJob(config, strmConfigService);
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/strm/configs/:id', async (req, res) => {
        try {
            const config = await strmConfigService.updateConfig(parseInt(req.params.id), req.body);
            await SchedulerService.refreshStrmConfigJob(config, strmConfigService);
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/strm/configs/:id', async (req, res) => {
        try {
            await strmConfigService.deleteConfig(parseInt(req.params.id));
            SchedulerService.removeTaskJob(`strm-config-${parseInt(req.params.id)}`);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs/:id/run', async (req, res) => {
        try {
            const result = await strmConfigService.runConfig(parseInt(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs/:id/reset', async (req, res) => {
        try {
            const config = await strmConfigService.resetSubscriptionConfig(parseInt(req.params.id));
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/tmdb/search', async (req, res) => {
        try {
            const keyword = req.query.keyword?.trim();
            const year = req.query.year?.trim() || '';
            if (!keyword) {
                throw new Error('搜索关键字不能为空');
            }
            const result = await tmdbService.search(keyword, year);
            res.json({
                success: true,
                data: [
                    ...(result.movies || []),
                    ...(result.tvShows || [])
                ].slice(0, 10)
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // TMDB 扩展路由（必须放在 :type/:id 通配路由之前，否则会被吞掉）
    app.get('/api/tmdb/trending/:mediaType/:timeWindow', async (req, res) => {
        try {
            const { mediaType, timeWindow } = req.params;
            const page = parseInt(req.query.page) || 1;
            const data = await tmdbService.getTrending(mediaType, timeWindow, page);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/tmdb/discover/:mediaType', async (req, res) => {
        try {
            const { mediaType } = req.params;
            const data = await tmdbService.discover(mediaType, req.query);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/tmdb/:mediaType/top_rated', async (req, res) => {
        try {
            const { mediaType } = req.params;
            const page = parseInt(req.query.page) || 1;
            const data = await tmdbService.getTopRated(mediaType, page);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 通配详情路由 — 必须放在所有具体子路径之后
    app.get('/api/tmdb/:type/:id', async (req, res) => {
        try {
            const { type, id } = req.params;
            if (!id) {
                throw new Error('TMDB ID 不能为空');
            }
            if (!['tv', 'movie'].includes(type)) {
                throw new Error('无效的 TMDB 类型');
            }
            const data = type === 'tv'
                ? await tmdbService.getTVDetails(id)
                : await tmdbService.getMovieDetails(id);
            if (!data) {
                throw new Error('获取 TMDB 详情失败');
            }
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ==================== 豆瓣代理 API ====================
    app.get('/api/douban/recent_hot/:kind', async (req, res) => {
        try {
            const { kind } = req.params;
            const start = parseInt(req.query.start) || 0;
            const limit = parseInt(req.query.limit) || 20;
            const data = await doubanService.getRecentHot(kind, start, limit);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/douban/search', async (req, res) => {
        try {
            const { tag, type = 'movie', start = 0, count = 20 } = req.query;
            if (!tag) {
                return res.json({ success: false, error: '缺少 tag 参数' });
            }
            const data = await doubanService.searchSubjects(tag, type, parseInt(start), parseInt(count));
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/douban/top250', async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const data = await doubanService.getTop250(page);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ==================== 图片代理 API（解决豆瓣防盗链） ====================
    app.get('/api/image-proxy', async (req, res) => {
        try {
            const { url } = req.query;
            if (!url) {
                return res.status(400).json({ success: false, error: '缺少 url 参数' });
            }

            // 安全检查：只允许代理豆瓣图片
            const allowedHosts = ['img1.doubanio.com', 'img2.doubanio.com', 'img3.doubanio.com', 'img9.doubanio.com'];
            try {
                const parsedUrl = new URL(url);
                if (!allowedHosts.includes(parsedUrl.hostname)) {
                    return res.status(403).json({ success: false, error: '不允许的图片源' });
                }
            } catch {
                return res.status(400).json({ success: false, error: '无效的 URL' });
            }

            const proxy = ProxyUtil.getProxyAgent('douban');
            const response = await got(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Referer': 'https://movie.douban.com/',
                },
                timeout: { request: 10000 },
                ...proxy,
                responseType: 'buffer',
            });

            // 设置正确的 Content-Type 和缓存头
            const contentType = response.headers['content-type'] || 'image/jpeg';
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=86400'); // 缓存 24 小时
            res.send(response.body);
        } catch (error) {
            console.error('图片代理请求失败:', error.message);
            res.status(500).json({ success: false, error: '图片加载失败' });
        }
    });

    // ==================== Bangumi 代理 API ====================
    app.get('/api/bangumi/calendar', async (req, res) => {
        try {
            const data = await doubanService.getBangumiCalendar();
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/bangumi/today', async (req, res) => {
        try {
            const data = await doubanService.getBangumiToday();
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/bangumi/ranking', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit) || 30;
            const data = await doubanService.getBangumiRanking(limit);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/bangumi/weekday/:id', async (req, res) => {
        try {
            const id = parseInt(req.params.id);
            if (Number.isNaN(id) || id < 1 || id > 7) {
                return res.json({ success: false, error: '无效的星期 id' });
            }
            const data = await doubanService.getBangumiByWeekday(id);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/bangumi/search', async (req, res) => {
        try {
            const { keyword } = req.query;
            if (!keyword) {
                return res.json({ success: false, error: '缺少 keyword 参数' });
            }
            const data = await doubanService.searchBangumi(keyword);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ai重命名
    app.post('/api/files/ai-rename', async (req, res) => {
        try {
            const { taskId, files } = req.body;
            if (files.length == 0) {
                throw new Error('未获取到需要修改的文件');
            }
            const task = await taskService.getTaskById(taskId);
            if (!task) {
                throw new Error('任务不存在');
            }
            // 开始ai分析
            const resourceInfo = await taskService._analyzeResourceInfo(
                task.resourceName,
                files,
                'file'
            )
            return res.json({ success: true, data: await taskService.handleAiRename(files, resourceInfo) });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.post('/api/custom-push/test', async (req, res) => {
        try{
            const configTest = req.body
            if (await new CustomPushService([]).testPush(configTest)){
                res.json({ success: true, data: null });
            }else{
                res.json({ success: false, error: '推送测试失败' });
            }

        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    // ==================== CAS 秒传相关 API ====================
    const casService = new CasService();

    // CAS 秒传恢复
    app.post('/api/cas/restore', async (req, res) => {
        try {
            const { accountId, folderId, casContent, fileName } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);
            const casInfo = CasService.parseCasContent(casContent);
            const result = await casService.restoreFromCas(cloud189, folderId, casInfo, fileName || casInfo.name);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 云端CAS文件恢复 - 下载并解析云端CAS文件后恢复
    app.post('/api/cas/restore-file', async (req, res) => {
        try {
            const { accountId, folderId, casFileId, casFileName } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);

            // 下载并解析CAS文件
            const casInfo = await casService.downloadAndParseCas(cloud189, casFileId);
            const restoreName = CasService.getOriginalFileName(casFileName, casInfo);

            // 执行恢复
            const result = await casService.restoreFromCas(cloud189, folderId, casInfo, restoreName);

            // 恢复后删除CAS文件（如果配置启用）
            await casService.deleteCasFileAfterRestore(cloud189, casFileId, casFileName, account.accountType === 'family');

            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 恢复并播放 - 临时恢复文件用于播放
    app.post('/api/cas/restore-and-play', async (req, res) => {
        try {
            const { CasPlaybackService } = require('./services/casPlaybackService');
            const { accountId, casFileId, casFileName, folderId } = req.body;

            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);

            const playbackService = new CasPlaybackService();
            const result = await playbackService.restoreAndGetPlaybackUrl(
                cloud189, casFileId, casFileName, folderId || '-11'
            );

            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // CAS自动恢复配置管理
    app.get('/api/cas/auto-restart-config', async (req, res) => {
        try {
            const config = ConfigService.getConfigValue('cas', {});
            res.json({
                success: true,
                data: {
                    enableAutoRestore: config.enableAutoRestore || false,
                    autoRestorePaths: config.autoRestorePaths || [],
                    deleteCasAfterRestore: config.deleteCasAfterRestore !== false,
                    deleteSourceAfterGenerate: config.deleteSourceAfterGenerate || false,
                    enableFamilyTransit: config.enableFamilyTransit !== false,
                    familyTransitFirst: config.familyTransitFirst || false,
                    scanInterval: config.scanInterval || 300
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/cas/auto-restart-config', async (req, res) => {
        try {
            const {
                enableAutoRestore,
                autoRestorePaths,
                deleteCasAfterRestore,
                deleteSourceAfterGenerate,
                enableFamilyTransit,
                familyTransitFirst,
                scanInterval
            } = req.body;

            ConfigService.setConfigValue('cas.enableAutoRestore', enableAutoRestore);
            ConfigService.setConfigValue('cas.autoRestorePaths', autoRestorePaths || []);
            ConfigService.setConfigValue('cas.deleteCasAfterRestore', deleteCasAfterRestore !== false);
            ConfigService.setConfigValue('cas.deleteSourceAfterGenerate', deleteSourceAfterGenerate || false);
            ConfigService.setConfigValue('cas.enableFamilyTransit', enableFamilyTransit !== false);
            ConfigService.setConfigValue('cas.familyTransitFirst', familyTransitFirst || false);
            ConfigService.setConfigValue('cas.scanInterval', scanInterval || 300);

            // 重启监控服务
            const { casMonitorService } = require('./services/casMonitorService');
            if (enableAutoRestore) {
                casMonitorService.reload();
            } else {
                casMonitorService.stop();
            }

            res.json({ success: true, data: '配置已保存' });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 手动触发CAS扫描
    app.post('/api/cas/trigger-scan', async (req, res) => {
        try {
            const { accountId, folderId } = req.body;
            const { casMonitorService } = require('./services/casMonitorService');
            const result = await casMonitorService.triggerScan(accountId, folderId);
            res.json(result);
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 获取CAS监控状态
    app.get('/api/cas/monitor-status', async (req, res) => {
        try {
            const { casMonitorService } = require('./services/casMonitorService');
            const status = casMonitorService.getStatus();
            res.json({ success: true, data: status });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 批量清理CAS文件
    app.post('/api/cas/batch-cleanup', async (req, res) => {
        try {
            const { CasCleanupService } = require('./services/casCleanupService');
            const { accountId, folderId, options } = req.body;

            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);

            const cleanupService = new CasCleanupService();
            const result = await cleanupService.batchPermanentDelete(cloud189, folderId, options);

            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 创建CAS文件
    app.post('/api/cas/create', async (req, res) => {
        try {
            const { accountId, fileId, parentId } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);

            const result = await cloud189.listFiles(parentId || '-11');
            const file = (result?.fileListAO?.fileList || []).find(f => String(f.id) === String(fileId));

            if (!file) throw new Error('未找到文件或文件信息不完整(需MD5)');

            const casContent = CasService.generateCasContent(file, 'base64');

            // 生成CAS后删除源文件（如果配置启用）
            await casService.deleteSourceFileAfterGenerate(cloud189, fileId, file.name || file.fileName, account.accountType === 'family');

            res.json({ success: true, data: { casContent, fileName: (file.name || file.fileName) + '.cas' } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 批量生成CAS文件到云端
    app.post('/api/cas/generate-folder-files', async (req, res) => {
        try {
            const { accountId, jobs, format, overwrite } = req.body || {};
            const account = await accountRepo.findOneBy({ id: Number(accountId) });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);
            const result = await casService.generateCasFilesToCloud(cloud189, jobs, {
                format,
                overwrite: overwrite !== false
            });
            res.json({ success: true, data: result });
        } catch (error) {
            console.error('生成云端CAS文件失败:', error);
            res.json({ success: false, error: error.message });
        }
    });

    // 导出文件夹CAS文件到云端
    app.post('/api/cas/export-folder-to-cloud', async (req, res) => {
        try {
            const { accountId, sourceFolderId, targetFolderId, recursive, overwrite } = req.body || {};
            const account = await accountRepo.findOneBy({ id: Number(accountId) });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);
            const result = await casService.exportFolderCasFilesToCloud(cloud189, sourceFolderId, targetFolderId, {
                recursive: recursive !== false,
                overwrite: overwrite !== false,
                mediaOnly: true
            });
            res.json({ success: true, data: result });
        } catch (error) {
            console.error('网盘文件另存为CAS失败:', error);
            res.json({ success: false, error: error.message });
        }
    });

    // 导出文件夹CAS信息
    app.post('/api/cas/export-folder', async (req, res) => {
        try {
            const { accountId, folderId } = req.body;
            const account = await accountRepo.findOneBy({ id: Number(accountId) });
            if (!account) throw new Error('账号不存在');
            const cloud189 = Cloud189Service.getInstance(account);

            const exportData = await casService.collectFolderCasStubs(cloud189, folderId, { mediaOnly: true });
            res.json({ success: true, data: exportData });
        } catch (error) {
            console.error('导出文件夹CAS信息失败:', error);
            res.json({ success: false, error: error.message });
        }
    });

    // CAS 存根包导入：上传 .cas / zip → 秒传还原 → 正常/懒 STRM
    app.post('/api/cas/import', (req, res) => {
        casImportUpload.single('file')(req, res, async (uploadErr) => {
            const uploadedPath = req.file?.path;
            try {
                if (uploadErr) {
                    throw uploadErr;
                }
                if (!req.file) {
                    throw new Error('请上传 .cas 或 .zip 文件');
                }

                const accountId = Number(req.body.accountId);
                const folderId = String(req.body.folderId || '').trim();
                if (!accountId) throw new Error('账号不能为空');
                if (!folderId) throw new Error('目标目录不能为空');

                const bool = (value, defaultValue = false) => {
                    if (value === undefined || value === null || value === '') return defaultValue;
                    if (typeof value === 'boolean') return value;
                    const normalized = String(value).trim().toLowerCase();
                    return ['1', 'true', 'yes', 'on'].includes(normalized);
                };

                const rawName = String(req.file.originalname || 'upload.bin');
                let originalName = rawName;
                try {
                    // multer 常把非 latin1 文件名按 latin1 传入，这里尽量还原中文名
                    const decoded = Buffer.from(rawName, 'latin1').toString('utf8');
                    if (decoded && !decoded.includes('�')) {
                        originalName = decoded;
                    }
                } catch (_) {}

                const job = await casImportService.createJobFromUpload({
                    filePath: req.file.path,
                    originalName,
                    accountId,
                    folderId,
                    folderName: String(req.body.folderName || '').trim(),
                    mode: String(req.body.mode || 'restore').trim(),
                    strmMode: String(req.body.strmMode || '').trim(),
                    uploadCasStub: bool(req.body.uploadCasStub, false),
                    overwriteStrm: bool(req.body.overwriteStrm, false),
                    title: String(req.body.title || '').trim(),
                    organizeMode: String(req.body.organizeMode || 'library').trim()
                });
                res.json({ success: true, data: job });
            } catch (error) {
                console.error('CAS导入失败:', error);
                res.json({ success: false, error: error.message });
            } finally {
                if (uploadedPath) {
                    require('fs').promises.unlink(uploadedPath).catch(() => {});
                }
            }
        });
    });

    app.get('/api/cas/import/jobs', async (req, res) => {
        try {
            const jobs = await casImportService.listJobs();
            res.json({ success: true, data: jobs });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/cas/import/jobs/:id', async (req, res) => {
        try {
            const full = String(req.query.full || '1') !== '0';
            const job = await casImportService.getJob(req.params.id, { full });
            res.json({ success: true, data: job });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/cas/import/jobs/:id/retry', async (req, res) => {
        try {
            const job = await casImportService.retryJob(req.params.id);
            res.json({ success: true, data: job });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/cas/import/jobs/:id', async (req, res) => {
        try {
            const deleteStrm = String(req.query.deleteStrm || '0') === '1';
            const result = await casImportService.deleteJob(req.params.id, { deleteStrm });
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/cas/import/strm', async (req, res) => {
        try {
            const data = await casImportService.listImportStrm(String(req.query.path || ''));
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/cas/import/strm', async (req, res) => {
        try {
            const targetPath = String(req.body?.path || req.query.path || '').trim();
            const data = await casImportService.deleteImportStrm(targetPath);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/cas/metadata/share', async (req, res) => {
        try {
            const data = await casImportService.listShareMetadata();
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/cas/metadata/share', async (req, res) => {
        try {
            const all = String(req.body?.all || req.query.all || '0') === '1';
            const data = await casImportService.clearShareMetadata({
                accountId: req.body?.accountId || req.query.accountId || '',
                shareId: req.body?.shareId || req.query.shareId || '',
                all
            });
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ==================== END CAS API ====================

    // ==================== PT 订阅 API ====================
    const { ptService } = require('./services/ptService');
    const { getPtSubscriptionRepository, getPtReleaseRepository } = require('./database');
    const ptSubscriptionRepo = getPtSubscriptionRepository();
    const ptReleaseRepo = getPtReleaseRepository();

    app.get('/api/pt/sources/presets', (req, res) => {
        try {
            res.json({ success: true, data: ptService.getSourcePresets() });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/sources/search', async (req, res) => {
        try {
            const { preset, keyword } = req.query;
            if (!preset || !keyword) {
                return res.json({ success: false, error: '缺少 preset 或 keyword 参数' });
            }
            const results = await ptService.searchSource(String(preset), String(keyword));
            res.json({ success: true, data: results });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // PT 聚合搜索 - 同时搜索所有支持搜索的源，单源超时跳过
    app.get('/api/pt/sources/search-all', async (req, res) => {
        try {
            const { keyword } = req.query;
            if (!keyword) {
                return res.json({ success: false, error: '缺少 keyword 参数' });
            }
            const searchablePresets = ['mikan', 'anibt', 'animegarden', 'nyaa', 'dmhy'];
            const PER_SOURCE_TIMEOUT = 25000;
            // 每个 preset 单独一个 AbortController，超时时真正取消底层 HTTP 请求
            const searchOne = (preset) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(
                    () => controller.abort(new Error(`${preset} timeout`)),
                    PER_SOURCE_TIMEOUT
                );
                return ptService
                    .searchSource(preset, String(keyword), { signal: controller.signal })
                    .finally(() => clearTimeout(timeoutId));
            };
            const results = await Promise.allSettled(searchablePresets.map(searchOne));
            const aggregated = results.flatMap((r, i) =>
                r.status === 'fulfilled'
                    ? r.value.map(item => ({ ...item, source: searchablePresets[i] }))
                    : []
            );
            res.json({ success: true, data: aggregated });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/sources/groups', async (req, res) => {
        try {
            const { preset, bgmId, bangumiUrl } = req.query;
            if (!preset) {
                return res.json({ success: false, error: '缺少 preset 参数' });
            }
            const results = await ptService.getSourceGroups(String(preset), { bgmId, bangumiUrl });
            res.json({ success: true, data: results });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/sources/group-items', async (req, res) => {
        try {
            const { rssUrl, preset } = req.query;
            if (!rssUrl) {
                return res.json({ success: false, error: '缺少 rssUrl 参数' });
            }
            const items = await ptService.getSourceGroupItems(String(rssUrl), String(preset || 'generic'));
            res.json({ success: true, data: items });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/pt/downloader/test', async (req, res) => {
        try {
            const result = await ptService.testDownloader();
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/subscriptions', async (req, res) => {
        try {
            const subs = await ptSubscriptionRepo.find({ order: { id: 'DESC' } });
            res.json({ success: true, data: subs });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/pt/subscriptions', async (req, res) => {
        try {
            const name = String(req.body.name || '').trim();
            const sourcePreset = req.body.sourcePreset || 'generic';
            const rssUrl = String(req.body.rssUrl || '').trim();
            const accountId = Number(req.body.accountId);
            const targetFolderId = String(req.body.targetFolderId || '');
            const targetFolder = req.body.targetFolder || '';

            if (!name) throw new Error('订阅名称不能为空');
            if (!rssUrl && sourcePreset === 'generic') throw new Error('通用 RSS 必须填写 RSS URL');
            if (!accountId) throw new Error('未选择账号');
            if (!targetFolderId) throw new Error('未选择目标目录');

            // 防重复:同一天翼账号下,RSS URL 不可重复(空 URL 跳过此检查)
            if (rssUrl) {
                const dup = await ptSubscriptionRepo.findOne({ where: { accountId, rssUrl } });
                if (dup) {
                    return res.json({
                        success: false,
                        error: `该 RSS 已在该账号下创建过订阅(#${dup.id} ${dup.name}),请勿重复添加`,
                        existingId: dup.id
                    });
                }
            }

            const sub = ptSubscriptionRepo.create({
                name,
                sourcePreset,
                rssUrl,
                includePattern: req.body.includePattern || '',
                excludePattern: req.body.excludePattern || '',
                qualityPattern: req.body.qualityPattern || '',
                resolutionPattern: req.body.resolutionPattern || '',
                effectPattern: req.body.effectPattern || '',
                sizeMinMB: Number(req.body.sizeMinMB) || 0,
                sizeMaxMB: Number(req.body.sizeMaxMB) || 0,
                seedersMin: Number(req.body.seedersMin) || 0,
                freeOnly: !!req.body.freeOnly,
                episodeDedup: !!req.body.episodeDedup,
                standbyRssJson: req.body.standbyRssJson || '',
                coexist: !!req.body.coexist,
                downloadNew: !!req.body.downloadNew,
                delayedDownloadMinutes: Number(req.body.delayedDownloadMinutes) || 0,
                notDownloadEpisodes: req.body.notDownloadEpisodes || '',
                skipHalfEpisode: !!req.body.skipHalfEpisode,
                customEpisode: !!req.body.customEpisode,
                customEpisodeRegex: req.body.customEpisodeRegex || '',
                customEpisodeGroupIndex: Number(req.body.customEpisodeGroupIndex) || 1,
                episodeOffset: Number(req.body.episodeOffset) || 0,
                omit: !!req.body.omit,
                totalEpisodeNumber: Number(req.body.totalEpisodeNumber) || 0,
                autoDisabled: !!req.body.autoDisabled,
                globalExclude: req.body.globalExclude !== false,
                accountId,
                targetFolderId,
                targetFolder,
                enabled: req.body.enabled !== false
            });
            await ptSubscriptionRepo.save(sub);
            // 新增订阅后自动触发一次 RSS 轮询
            let refreshResult = null;
            try {
                refreshResult = await ptService.runPoll(sub.id);
            } catch (refreshErr) {
                refreshResult = { processed: 0, error: refreshErr.message };
            }
            res.json({ success: true, data: sub, refreshResult });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/pt/subscriptions/:id', async (req, res) => {
        try {
            const sub = await ptSubscriptionRepo.findOneBy({ id: Number(req.params.id) });
            if (!sub) throw new Error('订阅不存在');
            const fields = [
                'name', 'sourcePreset', 'rssUrl',
                'includePattern', 'excludePattern',
                'qualityPattern', 'resolutionPattern', 'effectPattern',
                'sizeMinMB', 'sizeMaxMB', 'seedersMin', 'freeOnly', 'episodeDedup',
                'standbyRssJson', 'coexist', 'downloadNew', 'delayedDownloadMinutes',
                'notDownloadEpisodes', 'skipHalfEpisode', 'customEpisode', 'customEpisodeRegex',
                'customEpisodeGroupIndex', 'episodeOffset', 'omit', 'totalEpisodeNumber',
                'autoDisabled', 'globalExclude',
                'accountId', 'targetFolderId', 'targetFolder', 'enabled'
            ];
            const numericFields = new Set(['sizeMinMB', 'sizeMaxMB', 'seedersMin', 'delayedDownloadMinutes', 'customEpisodeGroupIndex', 'episodeOffset', 'totalEpisodeNumber']);
            const booleanFields = new Set(['freeOnly', 'episodeDedup', 'coexist', 'downloadNew', 'skipHalfEpisode', 'customEpisode', 'omit', 'autoDisabled', 'globalExclude', 'enabled']);
            fields.forEach((f) => {
                if (req.body[f] === undefined) return;
                if (numericFields.has(f)) {
                    sub[f] = f === 'customEpisodeGroupIndex'
                        ? (Number(req.body[f]) || 1)
                        : (Number(req.body[f]) || 0);
                } else if (booleanFields.has(f)) {
                    sub[f] = !!req.body[f];
                } else {
                    sub[f] = req.body[f];
                }
            });
            await ptSubscriptionRepo.save(sub);
            res.json({ success: true, data: sub });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/pt/subscriptions/:id', async (req, res) => {
        try {
            const id = Number(req.params.id);
            // 同时清理该订阅下的 release（不删 qb 任务，避免误删尚未完成的下载）
            await ptReleaseRepo.delete({ subscriptionId: id });
            await ptSubscriptionRepo.delete({ id });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/pt/subscriptions/:id/refresh', async (req, res) => {
        try {
            const result = await ptService.runPoll(Number(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/subscriptions/:id/releases', async (req, res) => {
        try {
            const releases = await ptReleaseRepo.find({
                where: { subscriptionId: Number(req.params.id) },
                order: { id: 'DESC' }
            });
            res.json({ success: true, data: releases });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/pt/releases', async (req, res) => {
        try {
            const limit = Math.min(Number(req.query.limit || 100), 500);
            const releases = await ptReleaseRepo.find({ order: { id: 'DESC' }, take: limit });
            res.json({ success: true, data: releases });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/pt/releases/:id/retry', async (req, res) => {
        try {
            const release = await ptService.retryRelease(Number(req.params.id));
            res.json({ success: true, data: release });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 重建单个 release 的 STRM（不重新下载/上传，仅从已存清单重生成）
    app.post('/api/pt/releases/:id/rebuild-strm', async (req, res) => {
        try {
            const result = await ptService.rebuildStrm(Number(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 批量重建所有已完成 release 的 STRM
    app.post('/api/pt/releases/rebuild-strm-all', async (req, res) => {
        try {
            const result = await ptService.rebuildAllStrm();
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/pt/releases/:id', async (req, res) => {
        try {
            const deleteFiles = req.query.deleteFiles !== 'false';
            await ptService.deleteRelease(Number(req.params.id), deleteFiles);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/pt/process', async (req, res) => {
        try {
            const result = await ptService.runProcessing();
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 一键去重:合并 (accountId + rssUrl) 完全相同的订阅,保留最早一条,迁移其 release
    app.post('/api/pt/subscriptions/dedupe', async (req, res) => {
        try {
            const all = await ptSubscriptionRepo.find({ order: { id: 'ASC' } });
            const groups = new Map();
            for (const sub of all) {
                if (!sub.rssUrl) continue; // 空 RSS URL 无法用于判定,跳过
                const key = `${sub.accountId}::${sub.rssUrl}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(sub);
            }

            let removed = 0;
            let mergedReleases = 0;
            for (const list of groups.values()) {
                if (list.length <= 1) continue;
                const keep = list[0]; // id 最小者保留
                const victimIds = list.slice(1).map(s => s.id);

                // 把 victims 的 release 迁移到 keep,(subscriptionId, guid) 已存在则丢弃
                const victimReleases = await ptReleaseRepo.find({ where: { subscriptionId: In(victimIds) } });
                for (const rel of victimReleases) {
                    const exists = await ptReleaseRepo.findOne({
                        where: { subscriptionId: keep.id, guid: rel.guid }
                    });
                    if (exists) {
                        await ptReleaseRepo.delete({ id: rel.id });
                    } else {
                        rel.subscriptionId = keep.id;
                        await ptReleaseRepo.save(rel);
                        mergedReleases++;
                    }
                }

                await ptSubscriptionRepo.delete({ id: In(victimIds) });
                removed += victimIds.length;
            }

            res.json({ success: true, data: { removed, mergedReleases } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // ==================== END PT API ====================

    // ==================== 榜单订阅 API ====================
    const { ListSubscriptionService } = require('./services/listSubscription');
    const listSubscriptionService = new ListSubscriptionService({
        doubanService,
        tmdbService,
        autoSeriesService,
        ptService,
        ptSubscriptionRepo
    });
    listSubscriptionService.initAll();

    app.get('/api/list-subscriptions', (req, res) => {
        try {
            res.json({ success: true, data: listSubscriptionService.list() });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/list-subscriptions', (req, res) => {
        try {
            const created = listSubscriptionService.create(req.body || {});
            res.json({ success: true, data: created });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/list-subscriptions/:id', (req, res) => {
        try {
            const updated = listSubscriptionService.update(req.params.id, req.body || {});
            res.json({ success: true, data: updated });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/list-subscriptions/:id', (req, res) => {
        try {
            listSubscriptionService.remove(req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/list-subscriptions/:id/run', async (req, res) => {
        try {
            const result = await listSubscriptionService.run(req.params.id);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // ==================== END 榜单订阅 API ====================

    // 全局错误处理中间件
    app.use((err, req, res, next) => {
        console.error('捕获到全局异常:', err.message);
        res.status(500).json({ success: false, error: err.message });
    });


    initSSE(app)

    // 初始化cloudsaver
    setupCloudSaverRoutes(app);
    setupHdhiveRoutes(app);
    // 启动服务器
    const server = app.listen(appPort, '0.0.0.0', async () => {
        console.log(`服务器运行在 http://0.0.0.0:${appPort}`);
        try {
            await syncStandaloneEmbyProxyServer(embyService);
        } catch (error) {
            console.error('启动 Emby 独立反代端口失败:', error.message);
        }
        // CAS 监控服务默认禁用，通过前端配置开启
        // try {
        //     const { casMonitorService } = require('./services/casMonitorService');
        //     casMonitorService.start();
        // } catch (error) {
        //     console.error('启动 CAS 监控服务失败:', error.message);
        // }
    });
    server.on('upgrade', (req, socket, head) => {
        if (!isEmbyProxyRequestPath(req.url, '/emby-proxy')) {
            socket.destroy();
            return;
        }
        embyService.handleProxyUpgrade(req, socket, head, { basePath: '/emby-proxy' }).catch((error) => {
            console.error('Emby 内置反代 WebSocket 失败:', error.message);
            socket.destroy();
        });
    });
}).catch(error => {
    console.error('数据库连接失败:', error);
});
