import express from 'express';
import { chromium } from 'playwright';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';

const config = {
  port: Number(process.env.PORT || 10000),
  baseUrl: trimTrailingSlash(process.env.HDHIVE_BASE_URL || 'https://hdhive.com'),
  cookie: String(process.env.HDHIVE_COOKIE || ''),
  username: String(process.env.HDHIVE_USERNAME || ''),
  password: String(process.env.HDHIVE_PASSWORD || ''),
  bridgeToken: String(process.env.BRIDGE_TOKEN || ''),
  profileDir: String(process.env.BROWSER_PROFILE_DIR || '/data/hdhive-profile'),
  headless: process.env.BROWSER_HEADLESS !== 'false',
  keepAliveIntervalMs: Number(process.env.KEEPALIVE_INTERVAL_MS || 25_000),
  warmupIntervalMs: Number(process.env.WARMUP_INTERVAL_MS || 300_000),
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS || 30_000),
  loginTimeoutMs: Number(process.env.LOGIN_TIMEOUT_MS || 45_000),
  customerApiTimeoutMs: Number(process.env.CUSTOMER_API_TIMEOUT_MS || 30_000),
  actionTimeoutMs: Number(process.env.ACTION_TIMEOUT_MS || 120_000),
  idlePageUrl: process.env.IDLE_PAGE_URL || '/',
  warmupUrls: parseWarmupUrls(process.env.WARMUP_URLS || '/,/search'),
  maxHtmlChars: Number(process.env.MAX_HTML_CHARS || 0),
  stateDatabaseUrl: String(process.env.BRIDGE_STATE_DATABASE_URL || process.env.DATABASE_URL || ''),
  stateDatabaseSsl: String(process.env.BRIDGE_STATE_DATABASE_SSL || ''),
  stateKey: String(process.env.BRIDGE_STATE_KEY || 'hdhive-default'),
  stateSecret: String(process.env.BRIDGE_STATE_SECRET || process.env.BRIDGE_TOKEN || '')
};

const state = {
  startedAt: Date.now(),
  context: null,
  page: null,
  browserLaunchAt: 0,
  browserLaunchMs: 0,
  lastWarmupAt: 0,
  lastWarmupMs: 0,
  lastWarmupOk: false,
  lastWarmupError: '',
  warmupCount: 0,
  restartCount: 0,
  activeAction: null,
  actionQueue: Promise.resolve(),
  stateDbPool: null,
  stateDbInitialized: false,
  stateLoadedAt: 0,
  statePersistedAt: 0,
  stateLoadOk: false,
  statePersistOk: false,
  stateLastError: '',
  shuttingDown: false
};

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (!config.bridgeToken || req.path === '/health') {
    next();
    return;
  }

  const provided = req.get('x-bridge-token') || req.query.token;
  if (provided !== config.bridgeToken) {
    res.status(401).json({ success: false, error: 'unauthorized' });
    return;
  }
  next();
});

app.get('/health', async (req, res) => {
  const ready = Boolean(state.context && state.page);
  res.status(ready ? 200 : 503).json({
    success: ready,
    data: await buildStatus()
  });
});

app.get('/metrics', async (req, res) => {
  res.json({ success: true, data: await buildStatus() });
});

app.post('/warmup', async (req, res) => {
  const urls = Array.isArray(req.body?.urls) && req.body.urls.length > 0
    ? req.body.urls.map(String)
    : config.warmupUrls;
  const result = await enqueueAction('warmup', () => warmup(urls));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/warmup', async (req, res) => {
  const urls = typeof req.query.url === 'string' ? [req.query.url] : config.warmupUrls;
  const result = await enqueueAction('warmup', () => warmup(urls));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/status', async (req, res) => {
  const result = await enqueueAction('hdhive-status', async () => {
    const page = await ensurePage();
    const startedAt = Date.now();
    await page.goto(toAbsoluteUrl(config.idlePageUrl), {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs
    });
    const pageStatus = await page.evaluate(() => ({
      title: document.title,
      href: location.href,
      cookiesEnabled: navigator.cookieEnabled,
      localStorageKeys: Object.keys(localStorage || {}),
      sessionStorageKeys: Object.keys(sessionStorage || {})
    }));
    return {
      success: true,
      data: {
        ...pageStatus,
        elapsedMs: Date.now() - startedAt
      }
    };
  });
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/open', async (req, res) => {
  const url = String(req.body?.url || req.body?.path || config.idlePageUrl);
  const result = await enqueueAction('hdhive-open', () => openPage(url, Boolean(req.body?.includeHtml)));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/open', async (req, res) => {
  const url = String(req.query.url || req.query.path || config.idlePageUrl);
  const includeHtml = req.query.html === '1' || req.query.html === 'true';
  const result = await enqueueAction('hdhive-open', () => openPage(url, includeHtml));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/cookies', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-cookies', () => getCookieSnapshot());
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/login', requireSensitiveEndpoint, async (req, res) => {
  const username = String(req.body?.username || config.username || '').trim();
  const password = String(req.body?.password || config.password || '');
  const result = await enqueueAction('hdhive-login', () => loginWithPassword(username, password));
  res.status(result.success ? 200 : 400).json(result);
});

app.get('/hdhive/customer/current', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-current', () => customerRequest('/api/customer/user/current', {
    allowUnsignedResponseFallback: true
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/checkin', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-checkin', () => customerRequest('/api/customer/user/checkin', {
    method: 'POST',
    allowUnsignedResponseFallback: true
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/customer/points-logs', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-points-logs', () => customerRequest('/api/customer/points-logs', {
    query: pickPrimitiveQuery(req.query),
    allowUnsignedResponseFallback: true
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/resources', requireSensitiveEndpoint, async (req, res) => {
  const method = String(req.body?.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
  const result = await enqueueAction('hdhive-customer-resources', () => customerRequest('/api/customer/resources', {
    method,
    query: pickPrimitiveQuery(req.body?.query),
    body: req.body?.body
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/check-resource', requireSensitiveEndpoint, async (req, res) => {
  const result = await enqueueAction('hdhive-customer-check-resource', () => customerRequest('/api/customer/check/resource', {
    method: 'POST',
    body: req.body?.body || req.body
  }));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/media-resources', requireSensitiveEndpoint, async (req, res) => {
  const type = String(req.body?.type || '').trim();
  const tmdbId = String(req.body?.tmdbId || '').trim();
  const result = await enqueueAction('hdhive-customer-media-resources', () => getMediaResources(type, tmdbId));
  res.status(result.success ? 200 : 500).json(result);
});

app.get('/hdhive/customer/resources/:resourceId', requireSensitiveEndpoint, async (req, res) => {
  const resourceId = normalizeResourceId(req.params.resourceId);
  const result = await enqueueAction('hdhive-customer-resource', () => getResourceDetail(resourceId));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/hdhive/customer/resources/:resourceId/unlock', requireSensitiveEndpoint, async (req, res) => {
  const resourceId = normalizeResourceId(req.params.resourceId);
  const result = await enqueueAction('hdhive-customer-resource-unlock', () => unlockResource(resourceId, req.body?.body));
  res.status(result.success ? 200 : 500).json(result);
});

app.post('/browser/restart', async (req, res) => {
  const result = await enqueueAction('browser-restart', async () => {
    await closeBrowser('restart');
    await ensurePage();
    return { success: true, data: await buildStatus() };
  });
  res.status(result.success ? 200 : 500).json(result);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[browser-bridge] listening on ${config.port}`);
  console.log(`[browser-bridge] baseUrl=${config.baseUrl} headless=${config.headless} profile=${config.profileDir}`);
  if (!config.bridgeToken) {
    console.warn('[browser-bridge] BRIDGE_TOKEN is empty; public endpoints are not protected.');
  }

  await enqueueAction('startup-warmup', () => warmup(config.warmupUrls));
  if (config.username && config.password) {
    await enqueueAction('startup-login', () => ensureLoggedIn(state.page)).catch((error) => {
      console.error('[browser-bridge] startup login failed', error);
    });
  }
  setInterval(() => {
    enqueueAction('interval-keepalive', () => keepAlive()).catch((error) => {
      console.error('[browser-bridge] keepalive failed', error);
    });
  }, config.keepAliveIntervalMs).unref();
  setInterval(() => {
    enqueueAction('interval-warmup', () => warmup(config.warmupUrls)).catch((error) => {
      console.error('[browser-bridge] warmup failed', error);
    });
  }, config.warmupIntervalMs).unref();
});

async function enqueueAction(name, action) {
  const id = randomUUID();
  const run = async () => {
    state.activeAction = { id, name, startedAt: Date.now() };
    try {
      return await runActionWithTimeout(name, action);
    } catch (error) {
      if (error instanceof ActionTimeoutError) {
        await closeBrowser(`timeout:${name}`, { persist: false });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        data: await buildStatus()
      };
    } finally {
      state.activeAction = null;
    }
  };

  const next = state.actionQueue.then(run, run);
  state.actionQueue = next.then(() => undefined, () => undefined);
  return next;
}

class ActionTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`Bridge action ${name} timed out after ${timeoutMs}ms`);
    this.name = 'ActionTimeoutError';
  }
}

async function runActionWithTimeout(name, action) {
  const actionPromise = Promise.resolve().then(action);
  actionPromise.catch(() => undefined);
  return await Promise.race([
    actionPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new ActionTimeoutError(name, config.actionTimeoutMs)), config.actionTimeoutMs).unref();
    })
  ]);
}

async function ensurePage(retry = 0) {
  if (state.page && !state.page.isClosed()) {
    return state.page;
  }

  if (!state.context) {
    const startedAt = Date.now();
    state.context = await chromium.launchPersistentContext(config.profileDir, {
      headless: config.headless,
      viewport: { width: 1366, height: 768 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=Translate,BackForwardCache'
      ]
    });
    state.browserLaunchAt = startedAt;
    state.browserLaunchMs = Date.now() - startedAt;
    state.restartCount += 1;
    // context 崩溃/关闭时主动置空，使下次 ensurePage 能重建（避免在已死的 context 上反复 newPage 失败）
    state.context.on('close', () => {
      state.context = null;
      state.page = null;
    });
    await installStealthInitScript(state.context);
    await restoreBrowserState(state.context);
    await seedCookies(state.context);
  }

  try {
    state.page = state.context.pages()[0] || await state.context.newPage();
  } catch (error) {
    // context 已崩溃但引用残留（Target page/context closed）：置空重建，最多重试 2 次
    state.context = null;
    state.page = null;
    if (retry >= 2) {
      throw error;
    }
    return ensurePage(retry + 1);
  }
  state.page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  state.page.setDefaultTimeout(config.navigationTimeoutMs);
  state.page.on('close', () => {
    state.page = null;
  });
  return state.page;
}

async function seedCookies(context) {
  const cookies = parseCookieHeader(config.cookie, config.baseUrl);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }
}

async function installStealthInitScript(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
    if (navigator.userAgentData) {
      Object.defineProperty(navigator, 'userAgentData', {
        get: () => ({
          brands: [
            { brand: 'Google Chrome', version: '125' },
            { brand: 'Chromium', version: '125' },
            { brand: 'Not.A/Brand', version: '24' }
          ],
          mobile: false,
          platform: 'Windows',
          getHighEntropyValues: async () => ({
            brands: [
              { brand: 'Google Chrome', version: '125' },
              { brand: 'Chromium', version: '125' },
              { brand: 'Not.A/Brand', version: '24' }
            ],
            fullVersionList: [
              { brand: 'Google Chrome', version: '125.0.0.0' },
              { brand: 'Chromium', version: '125.0.0.0' },
              { brand: 'Not.A/Brand', version: '24.0.0.0' }
            ],
            mobile: false,
            platform: 'Windows',
            platformVersion: '15.0.0',
            architecture: 'x86',
            bitness: '64',
            model: '',
            uaFullVersion: '125.0.0.0',
            wow64: false
          })
        }),
        configurable: true
      });
    }
    const patchWebGL = (prototype) => {
      if (!prototype?.getParameter) {
        return;
      }
      const originalGetParameter = prototype.getParameter;
      Object.defineProperty(prototype, 'getParameter', {
        value(parameter) {
          if (parameter === 37445) {
            return 'Google Inc. (Intel)';
          }
          if (parameter === 37446) {
            return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          }
          return originalGetParameter.call(this, parameter);
        },
        configurable: true
      });
    };
    patchWebGL(window.WebGLRenderingContext?.prototype);
    patchWebGL(window.WebGL2RenderingContext?.prototype);
    window.chrome = window.chrome || { runtime: {} };
    for (const key of ['__playwright__binding__', '__pwInitScripts']) {
      try {
        delete window[key];
      } catch {
        // ignore
      }
      try {
        Object.defineProperty(window, key, {
          get: () => undefined,
          set: () => undefined,
          configurable: true
        });
      } catch {
        // ignore
      }
    }
  });
}

async function warmup(urls) {
  const startedAt = Date.now();
  const page = await ensurePage();
  const results = [];
  for (const value of urls) {
    const url = toAbsoluteUrl(value);
    const itemStartedAt = Date.now();
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: config.navigationTimeoutMs
      });
      results.push({
        url,
        status: response?.status() || 0,
        ok: response ? response.ok() : true,
        title: await page.title().catch(() => ''),
        elapsedMs: Date.now() - itemStartedAt
      });
    } catch (error) {
      results.push({
        url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - itemStartedAt
      });
    }
  }

  const failed = results.find((item) => item.ok === false);
  state.lastWarmupAt = Date.now();
  state.lastWarmupMs = Date.now() - startedAt;
  state.lastWarmupOk = !failed;
  state.lastWarmupError = failed?.error || '';
  state.warmupCount += 1;

  return {
    success: !failed,
    data: {
      results,
      status: await buildStatus()
    },
    ...(failed ? { error: failed.error || 'warmup failed' } : {})
  };
}

let loggingIn = null;

async function ensureLoggedIn(page) {
  if (!config.username || !config.password) {
    return false;
  }
  const targetPage = page && !page.isClosed() ? page : await ensurePage();
  const cookies = await readContextCookies(targetPage.context()).catch(() => []);
  const loginCookieNames = ['token', 'csrf_access_token', 'hdh_uid'];
  if (cookies.some((cookie) => loginCookieNames.includes(cookie.name))) {
    return true;
  }
  if (loggingIn) {
    return loggingIn;
  }
  console.log('[browser-bridge] 登录态缺失，自动使用环境变量账号重新登录');
  loggingIn = loginWithPassword(config.username, config.password)
    .then((result) => {
      if (!result.success) {
        console.warn('[browser-bridge] 自动登录失败:', result.error || '未知错误');
      }
      return Boolean(result.success);
    })
    .catch((error) => {
      console.warn('[browser-bridge] 自动登录异常:', error instanceof Error ? error.message : String(error));
      return false;
    })
    .finally(() => {
      loggingIn = null;
    });
  return loggingIn;
}

async function keepAlive() {
  let page = await ensurePage();
  if (page.isClosed()) {
    state.page = null;
    page = await ensurePage();
  }
  const alive = await page.evaluate(() => Date.now()).then(() => true).catch(() => false);
  if (!alive) {
    // 软恢复：先尝试重新导航到空闲页，避免轻易销毁重建上下文（会丢失登录态）
    const recovered = await page
      .goto(toAbsoluteUrl(config.idlePageUrl), { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!recovered) {
      await closeBrowser();
      page = await ensurePage();
    }
  }
  // 续签登录态：仅在登录 cookie 缺失时才真正重登，正常只读 cookie，开销极小
  await ensureLoggedIn(page).catch(() => false);
  return { success: true, data: await buildStatus() };
}

async function openPage(urlOrPath, includeHtml = false) {
  const page = await ensurePage();
  const startedAt = Date.now();
  const response = await page.goto(toAbsoluteUrl(urlOrPath), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  const data = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    status: response?.status() || 0,
    ok: response ? response.ok() : true,
    elapsedMs: Date.now() - startedAt
  };
  if (includeHtml && config.maxHtmlChars > 0) {
    data.html = (await page.content()).slice(0, config.maxHtmlChars);
  }
  return { success: true, data };
}

async function getCookieSnapshot() {
  const page = await ensurePage();
  const cookies = await page.context().cookies(config.baseUrl);
  await persistBrowserState(page.context(), 'cookies');
  return {
    success: true,
    data: {
      cookieHeader: cookiesToHeader(cookies),
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }))
    }
  };
}

async function loginWithPassword(username, password) {
  if (!username || !password) {
    return { success: false, error: 'HDHIVE_USERNAME/HDHIVE_PASSWORD 未配置，或请求体缺少 username/password' };
  }

  const page = await ensurePage();
  const startedAt = Date.now();
  await page.goto(toAbsoluteUrl('/login'), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

  const loginBlocked = await page.locator('text=出现了很奇怪的错误').count().catch(() => 0);
  if (loginBlocked > 0) {
    return {
      success: false,
      error: '影巢登录页拒绝当前浏览器环境，请尝试关闭 Headless 或调整浏览器指纹参数',
      data: await safePageSummary(page, startedAt)
    };
  }

  const usernameInput = page.locator('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"], input[type="text"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
  // 显式等待登录表单异步渲染出现，容忍 SPA 渲染时机（networkidle 后表单可能尚未挂载，避免误判“未找到表单”）
  await usernameInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);
  await passwordInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
  if (await usernameInput.count() === 0 || await passwordInput.count() === 0) {
    const blockedAgain = await page.locator('text=出现了很奇怪的错误').count().catch(() => 0);
    return {
      success: false,
      error: blockedAgain > 0
        ? '影巢登录页拒绝当前浏览器环境，请尝试关闭 Headless 或调整浏览器指纹参数'
        : '未找到影巢登录表单，可能需要验证码、二次验证或页面结构已变化',
      data: await safePageSummary(page, startedAt)
    };
  }

  await usernameInput.fill(username, { timeout: config.navigationTimeoutMs });
  await passwordInput.fill(password, { timeout: config.navigationTimeoutMs });
  const submitButton = page.locator('button[type="submit"], button:has-text("登录"), [role="button"]:has-text("登录")').first();
  if (await submitButton.count() > 0) {
    await submitButton.click({ timeout: config.navigationTimeoutMs });
  } else {
    await passwordInput.press('Enter', { timeout: config.navigationTimeoutMs });
  }

  const loginResult = await waitForLoggedIn(page, startedAt);
  if (!loginResult.success) {
    return loginResult;
  }
  const statePersisted = await persistBrowserState(page.context(), 'login');

  return {
    success: true,
    data: {
      ...loginResult.data,
      statePersisted,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function waitForLoggedIn(page, startedAt) {
  const deadline = Date.now() + config.loginTimeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const cookies = await page.context().cookies(config.baseUrl);
    const cookieHeader = cookiesToHeader(cookies);
    if (cookieHeader && cookies.some((cookie) => ['token', 'csrf_access_token', 'hdh_uid'].includes(cookie.name))) {
      const current = await customerRequest('/api/customer/user/current', { allowUnsignedResponseFallback: true }).catch((error) => ({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }));
      const currentPayload = current.data?.payload || current.data;
      const currentFailure = getCustomerPayloadFailure(currentPayload);
      if (current.success && !currentFailure) {
        return {
          success: true,
          data: {
            cookieHeader,
            cookieNames: cookies.map((cookie) => cookie.name),
            currentUser: currentPayload
          }
        };
      }
      lastError = current.error || currentFailure || '';
    }
    const pageText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    if (/验证码|二次验证|两步验证|错误|失败|不存在|密码/.test(pageText)) {
      lastError = pageText.slice(0, 300);
    }
  }
  return {
    success: false,
    error: lastError || '登录超时，未获得有效网页登录态',
    data: await safePageSummary(page, startedAt)
  };
}

async function customerRequest(pathname, options = {}) {
  const page = await ensureRuntimePage();
  const startedAt = Date.now();
  const observedResponses = [];
  const observedResponsePromises = [];
  const targetPathname = normalizeUrlPathname(pathname);
  const onResponse = (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== config.baseUrl || url.pathname !== targetPathname) {
      return;
    }
    const promise = (async () => {
      const headers = response.headers();
      const text = await response.text().catch(() => '');
      observedResponses.push({
        url: response.url(),
        status: response.status(),
        ok: response.ok(),
        headers: pickHeaders(headers, ['content-type', 'x-hdh-rsig', 'x-hdh-rts']),
        body: parseMaybeJson(text)
      });
    })();
    observedResponsePromises.push(promise);
  };
  const payload = {
    path: pathname,
    method: options.method || 'GET',
    query: options.query || null,
    body: options.body === undefined ? null : options.body,
    timeoutMs: config.customerApiTimeoutMs,
    targetPathname
  };
  page.on('response', onResponse);
  let result;
  try {
    result = await page.evaluate(async (request) => {
    const getWebpackRequire = () => {
      let webpackRequire = null;
      const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      chunk.push([[`hdhive-bridge-${Date.now()}`], {}, (require) => {
        webpackRequire = require;
      }]);
      return webpackRequire;
    };

    const findClient = () => {
      const webpackRequire = getWebpackRequire();
      if (!webpackRequire) {
        return null;
      }
      const readClient = (exports) => {
        const axiosClient = exports?.A;
        if (axiosClient?.get && axiosClient?.post && axiosClient?.interceptors?.request) {
          return axiosClient;
        }
        return null;
      };
      const tryRequire = (id) => {
        try {
          return readClient(webpackRequire(id));
        } catch {
          return null;
        }
      };
      const knownClient = tryRequire(41263);
      if (knownClient) {
        return knownClient;
      }
      const cache = webpackRequire.c || {};
      for (const module of Object.values(cache)) {
        const client = readClient(module?.exports);
        if (client) {
          return client;
        }
      }
      const factories = webpackRequire.m || {};
      for (const [id, factory] of Object.entries(factories)) {
        const source = String(factory || '');
        if (!source.includes('X-CSRF-TOKEN') || !source.includes('/api/public/auth/refresh')) {
          continue;
        }
        const client = tryRequire(id);
        if (client) {
          return client;
        }
      }
      return null;
    };

    const client = findClient();
    if (!client) {
      throw new Error('未找到影巢签名 API 客户端，请先打开影巢首页完成运行时加载');
    }

    const query = request.query && typeof request.query === 'object' ? request.query : undefined;
    const method = String(request.method || 'GET').toUpperCase();
    const config = query ? { params: query } : undefined;
    const capturedFetchResponses = [];
    const parseMaybeJsonInPage = (value) => {
      if (!value) {
        return null;
      }
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    };
    const pickHeaderInPage = (headers, names) => {
      const picked = {};
      for (const name of names) {
        const value = headers?.get?.(name);
        if (value) {
          picked[name] = value;
        }
      }
      return picked;
    };
    const matchesTargetUrl = (value) => {
      let url;
      try {
        url = new URL(value?.url || value || '', location.origin);
      } catch {
        return false;
      }
      const target = request.targetPathname || request.path;
      return url.origin === location.origin && (
        url.pathname === target
        || url.pathname === `${target}/`
        || (
          String(target).startsWith('/api/customer/resources/')
          && url.pathname.startsWith('/api/customer/resources/')
        )
      );
    };
    const originalFetch = window.fetch?.bind(window);
    if (originalFetch) {
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (matchesTargetUrl(response.url || args[0])) {
          const text = await response.clone().text().catch(() => '');
          capturedFetchResponses.push({
            url: response.url || String(args[0] || ''),
            status: response.status,
            ok: response.ok,
            headers: pickHeaderInPage(response.headers, ['content-type', 'x-hdh-rsig', 'x-hdh-rts']),
            body: parseMaybeJsonInPage(text)
          });
        }
        return response;
      };
    }
    const call = (async () => {
      try {
        const response = method === 'GET'
          ? await client.get(request.path, config)
          : await client.post(request.path, request.body ?? undefined, config);
        if (response?.error) {
          return { ok: false, payload: response.error };
        }
        return { ok: true, payload: response?.response ?? response };
      } catch (error) {
        return {
          ok: false,
          payload: {
            name: error?.name || '',
            code: error?.code || '',
            httpStatus: error?.httpStatus || error?.status || 0,
            message: error?.message || error?.description || String(error),
            responseStatus: error?.response?.status || 0,
            responseData: error?.response?.data ?? null
          }
        };
      }
    })();
    const timeoutMs = Number(request.timeoutMs || 30_000);
    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({
        ok: false,
        payload: {
          name: 'TimeoutError',
          code: 'customer_api_timeout',
          httpStatus: 0,
          message: `影巢 customer API 调用超时: ${timeoutMs}ms`
        }
      }), timeoutMs);
    });
      try {
        const callResult = await Promise.race([call, timeout]);
        return { ...callResult, capturedFetchResponses };
      } finally {
        if (originalFetch) {
          window.fetch = originalFetch;
        }
      }
    }, payload);
    await Promise.race([
      Promise.allSettled(observedResponsePromises),
      delay(1000)
    ]);
  } finally {
    page.off('response', onResponse);
  }

  const allObservedResponses = [
    ...observedResponses,
    ...(Array.isArray(result.capturedFetchResponses) ? result.capturedFetchResponses : [])
  ];
  const observedResponse = allObservedResponses[allObservedResponses.length - 1] || null;
  const responseSignatureMissing = isMissingResponseSignaturePayload(result.payload);
  const responseDataFallback = result.payload?.responseData !== undefined && result.payload?.responseData !== null
    ? {
        status: result.payload.responseStatus || 0,
        ok: !result.payload.responseStatus || Number(result.payload.responseStatus) < 400,
        headers: {},
        body: result.payload.responseData
      }
    : null;
  const fallbackResponse = observedResponse || responseDataFallback;
  const unsignedResponseFallback = Boolean(
    options.allowUnsignedResponseFallback
    && !result.ok
    && responseSignatureMissing
    && fallbackResponse?.ok
    && fallbackResponse.body !== undefined
  );
  if (unsignedResponseFallback) {
    const fallbackPayload = fallbackResponse.body ?? { success: true, message: '影巢请求已完成但响应体为空' };
    const fallbackFailure = getCustomerPayloadFailure(fallbackPayload);
    result = {
      ok: !fallbackFailure,
      payload: fallbackPayload,
      warning: fallbackFailure
        ? '影巢响应缺少 X-HDH-RSig，且同源网络响应为业务失败状态'
        : '影巢响应缺少 X-HDH-RSig，已使用 Bridge 捕获到的同源网络响应正文'
    };
  }

  const payloadFailure = getCustomerPayloadFailure(result.payload);
  const requestSucceeded = Boolean(result.ok && !payloadFailure);
  const statePersisted = requestSucceeded ? await persistBrowserState(page.context(), `customer:${pathname}`) : false;
  return {
    success: requestSucceeded,
    data: {
      path: pathname,
      method: payload.method,
      payload: result.payload,
      statePersisted,
      responseSignatureMissing,
      unsignedResponseFallback,
      observedResponse: observedResponse ? {
        status: observedResponse.status,
        ok: observedResponse.ok,
        hasResponseSignature: Boolean(observedResponse.headers?.['x-hdh-rsig'])
      } : null,
      elapsedMs: Date.now() - startedAt
    },
    ...(result.warning ? { warning: result.warning } : {}),
    ...(requestSucceeded ? {} : { error: payloadFailure || result.payload?.message || result.payload?.description || '影巢 customer API 调用失败' })
  };
}

async function ensureRuntimePage() {
  const page = await ensurePage();
  if (!page.url().startsWith(config.baseUrl)) {
    await page.goto(toAbsoluteUrl(config.idlePageUrl), {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs
    });
  }
  await page.waitForFunction(() => {
    const chunk = window.webpackChunk_N_E = window.webpackChunk_N_E || [];
    let found = false;
    chunk.push([[`hdhive-bridge-probe-${Date.now()}`], {}, (require) => {
      const hasClient = (exports) => {
        const axiosClient = exports?.A;
        return Boolean(axiosClient?.get && axiosClient?.post && axiosClient?.interceptors?.request);
      };
      const tryRequire = (id) => {
        try {
          return hasClient(require(id));
        } catch {
          return false;
        }
      };
      found = tryRequire(41263);
      if (found) {
        return;
      }
      const cache = require?.c || {};
      found = Object.values(cache).some((module) => hasClient(module?.exports));
      if (found) {
        return;
      }
      const factories = require?.m || {};
      for (const [id, factory] of Object.entries(factories)) {
        const source = String(factory || '');
        if (source.includes('X-CSRF-TOKEN') && source.includes('/api/public/auth/refresh') && tryRequire(id)) {
          found = true;
          return;
        }
      }
    }]);
    return found;
  }, { timeout: config.customerApiTimeoutMs });
  return page;
}

async function getResourceDetail(resourceId) {
  const resourcePath = `/resource/189/${encodeURIComponent(resourceId)}`;
  const apiResult = await customerRequest(`/api/customer/resources/${resourceId}`, {
    allowUnsignedResponseFallback: true
  }).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const pageResult = await readResourcePage(resourceId, resourcePath).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const payloadResources = extractResourceCandidates(apiResult.data?.payload || apiResult.data);
  const resources = mergeResources([
    ...payloadResources,
    ...(pageResult.data?.resources || [])
  ]);
  const payload = {
    success: true,
    data: resources,
    message: resources.length ? 'success' : '未解析到资源详情',
    code: '200'
  };
  return {
    success: apiResult.success || pageResult.success,
    data: {
      resourcePath,
      payload,
      resources,
      api: apiResult,
      page: pageResult.success ? pageResult.data : null,
      source: 'resource-detail'
    },
    ...(apiResult.success || pageResult.success ? {} : {
      error: apiResult.error || pageResult.error || '影巢资源详情读取失败'
    })
  };
}

async function unlockResource(resourceId, body) {
  const unlockResult = await customerRequest(`/api/customer/resources/${resourceId}/unlock`, {
    method: 'POST',
    body,
    allowUnsignedResponseFallback: true
  });
  if (!unlockResult.success) {
    return unlockResult;
  }
  const detailResult = await getResourceDetail(resourceId).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  const unlockPayload = unlockResult.data?.payload || unlockResult.data;
  const resources = mergeResources([
    ...extractResourceCandidates(unlockPayload),
    ...(detailResult.data?.resources || [])
  ]);
  return {
    success: true,
    data: {
      ...unlockResult.data,
      payload: unlockPayload,
      resources,
      detail: detailResult.success ? detailResult.data : null,
      source: 'resource-unlock'
    },
    ...(detailResult.success ? {} : { warning: detailResult.error || '解锁成功，但详情页回读失败' })
  };
}

async function readResourcePage(resourceId, resourcePath) {
  const page = await ensurePage();
  const startedAt = Date.now();
  const response = await page.goto(toAbsoluteUrl(resourcePath), {
    waitUntil: 'domcontentloaded',
    timeout: config.navigationTimeoutMs
  });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await dismissKnownNotice(page);

  const pageText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  if (/出现了很奇怪的错误/.test(pageText)) {
    return {
      success: false,
      error: '影巢资源页拒绝当前浏览器环境，请重启 Bridge 或尝试关闭 Headless',
      data: await safePageSummary(page, startedAt)
    };
  }
  if (/\/login(?:\?|$)/i.test(page.url())) {
    return {
      success: false,
      error: '影巢登录态已失效，请重新登录或同步 Cookie',
      data: await safePageSummary(page, startedAt)
    };
  }

  const domResource = await scrapeCurrentCloud189Resource(page, resourceId);
  const html = await page.content();
  const htmlResources = extractResourceEntriesFromHtml(html, page.url());
  const resources = mergeResources([
    ...(domResource ? [domResource] : []),
    ...htmlResources
  ]);
  const statePersisted = await persistBrowserState(page.context(), `resource-detail:${resourceId}`);
  return {
    success: true,
    data: {
      pageUrl: page.url(),
      status: response?.status() || 0,
      ok: response ? response.ok() : true,
      resources,
      statePersisted,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function getMediaResources(type, tmdbId) {
  if (!['movie', 'tv'].includes(type) || !tmdbId) {
    return { success: false, error: 'type 必须是 movie/tv，tmdbId 不能为空' };
  }
  const page = await ensurePage();
  const mediaPath = `/tmdb/${type}/${encodeURIComponent(tmdbId)}`;
  const capturedTargets = [];
  const observedCustomerRequests = [];
  const capturedResponses = [];
  const onRequest = (request) => {
    try {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/customer/')) {
        return;
      }
      const query = Object.fromEntries(url.searchParams.entries());
      observedCustomerRequests.push({
        pathname: url.pathname,
        method: request.method(),
        query,
        postData: parseMaybeJson(request.postData())
      });
      if (url.pathname === '/api/customer/subscriptions/check') {
        const targetType = query.target_type || '';
        const targetKey = query.target_key || '';
        if (targetType && targetKey) {
          capturedTargets.push({ target_type: targetType, target_key: targetKey });
        }
      }
    } catch {
      // Ignore observer errors; resource scraping below still runs.
    }
  };
  const onResponse = async (response) => {
    try {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/customer/')) {
        return;
      }
      const request = response.request();
      const contentType = response.headers()['content-type'] || '';
      let body = null;
      if (contentType.includes('application/json')) {
        body = await response.json().catch(() => null);
      } else {
        body = await response.text().catch(() => '');
      }
      capturedResponses.push({
        url: response.url(),
        status: response.status(),
        ok: response.ok(),
        request: {
          method: request.method(),
          postData: parseMaybeJson(request.postData()),
          headers: pickHeaders(request.headers(), ['content-type'])
        },
        body
      });
    } catch {
      // Ignore observer errors; manual fallback below still runs.
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  try {
    await page.goto(toAbsoluteUrl(mediaPath), {
      waitUntil: 'domcontentloaded',
      timeout: config.navigationTimeoutMs
    });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await dismissKnownNotice(page);
    await scrollPage(page, 6, 900, 400);

    const pageText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
    if (/出现了很奇怪的错误/.test(pageText)) {
      return {
        success: false,
        error: '影巢详情页拒绝当前浏览器环境，请重启 Bridge 或尝试关闭 Headless',
        data: await safePageSummary(page, Date.now())
      };
    }
    if (/\/login(?:\?|$)/i.test(page.url())) {
      return {
        success: false,
        error: '影巢登录态已失效，请重新登录或同步 Cookie',
        data: await safePageSummary(page, Date.now())
      };
    }

    const clickedCloud189Tab = await clickCloud189Tab(page);
    if (clickedCloud189Tab) {
      await page.waitForTimeout(1500);
      await scrollPage(page, 4, 700, 250);
    }

    const html = await page.content();
    const target = extractMediaResourceTarget(html, type, tmdbId, capturedTargets);
    const domResources = await scrapeCloud189Resources(page);
    const htmlResources = extractResourceEntriesFromHtml(html, page.url());
    const resources = mergeResources([...domResources, ...htmlResources]);
    const statePersisted = await persistBrowserState(page.context(), 'media-resources');
    const payload = {
      success: true,
      data: resources,
      message: resources.length ? 'success' : '未找到天翼云盘资源',
      code: '200'
    };
    return {
      success: true,
      data: {
        mediaPath,
        pageUrl: page.url(),
        target,
        payload,
        resources,
        captured: true,
        source: 'page-rendered-resources',
        statePersisted,
        clickedCloud189Tab,
        observedCustomerRequests: observedCustomerRequests.slice(-20),
        capturedResponses: capturedResponses.slice(-20)
      }
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

async function dismissKnownNotice(page) {
  await page.getByText(/我知道了/).click({ timeout: 2000 }).catch(() => undefined);
}

async function scrollPage(page, times, deltaY, waitMs) {
  for (let index = 0; index < times; index += 1) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(waitMs);
  }
}

async function clickCloud189Tab(page) {
  for (let index = 0; index < 12; index += 1) {
    const clicked = await page.evaluate(() => {
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const textOf = (node) => (node.innerText || node.textContent || '').trim();
      const candidates = Array.from(document.querySelectorAll('button,[role="tab"],[role="button"],a'));
      const exact = candidates.find((node) => isVisible(node) && /天翼云盘/.test(textOf(node)));
      const fallback = candidates.find((node) => isVisible(node) && (/\b189\b/.test(textOf(node)) || /天翼/.test(textOf(node))));
      const target = exact || fallback;
      if (!target) {
        return false;
      }
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    }).catch(() => false);
    if (clicked) {
      return true;
    }
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(350);
  }
  return false;
}

async function scrapeCloud189Resources(page) {
  return await page.evaluate(() => {
    const parseSize = (value) => {
      const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)/i);
      if (!match) {
        return 0;
      }
      const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
      return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
    };
    const parseTitle = (lines) => {
      const pointsIndex = lines.findIndex((line) => /免费|\d+\s*积分/.test(line));
      const startIndex = pointsIndex >= 0 ? pointsIndex + 1 : 0;
      const skipPattern = /^(发布于|免费|\d+\s*积分|疑似失效|加入片单|4K|1080P|720P|简中|简英双语|内封|外挂|WEB-DL\/WEBRip|蓝光原盘\/REMUX|\d+(?:\.\d+)?\s*(TB|GB|MB|KB|B))$/i;
      const title = lines.slice(startIndex).find((line) => line.length > 3 && !skipPattern.test(line));
      return title || lines[0] || '影巢天翼资源';
    };
    const resourceSlugFromAnchor = (anchor) => {
      try {
        const href = new URL(anchor.href, location.href);
        const parts = href.pathname.split('/').filter(Boolean);
        return decodeURIComponent(parts[2] || '');
      } catch {
        return '';
      }
    };
    const resourceSlugsIn = (node) => [...new Set(Array.from(node.querySelectorAll('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]'))
      .map(resourceSlugFromAnchor)
      .filter(Boolean))];
    const findResourceCard = (anchor, slug) => {
      let card = anchor;
      let best = anchor;
      for (let index = 0; index < 8 && card?.parentElement; index += 1) {
        const parent = card.parentElement;
        const slugs = resourceSlugsIn(parent);
        if (slugs.length > 1 || (slugs.length === 1 && slugs[0] !== slug)) {
          break;
        }
        const text = (parent.innerText || '').trim();
        if (/发布于|积分|免费|疑似失效|\d+(?:\.\d+)?\s*(TB|GB|MB|KB|B)/i.test(text)) {
          best = parent;
        }
        card = parent;
      }
      return best;
    };
    const parseResource = (anchor) => {
      const href = new URL(anchor.href, location.href);
      const parts = href.pathname.split('/').filter(Boolean);
      const slug = decodeURIComponent(parts[2] || '');
      if (!slug) {
        return null;
      }
      const card = findResourceCard(anchor, slug);
      const text = (card?.innerText || anchor.innerText || anchor.textContent || '').trim();
      const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const pointsMatch = text.match(/(\d+)\s*积分/);
      const isFree = /(^|\n|\s)免费($|\n|\s)/.test(text);
      const cloudLink = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
      return {
        id: slug,
        slug,
        title: parseTitle(lines),
        pan_type: '189',
        share_size: parseSize(text),
        unlock_points: pointsMatch ? Number(pointsMatch[1]) : 0,
        is_free: isFree,
        expired: /疑似失效/.test(text),
        is_unlocked: /已解锁|查看链接|复制链接/.test(text) || Boolean(cloudLink),
        media_url: cloudLink?.[0] || '',
        pageUrl: href.href,
        user: lines[0] ? { name: lines[0] } : {},
        publishedAt: (text.match(/发布于\s*([0-9/-]+)/) || [])[1] || '',
        source: 'dom'
      };
    };
    const anchors = Array.from(document.querySelectorAll('a[href*="/resource/189/"],a[href*="/resource/cloud189/"],a[href*="/resource/8/"]'));
    return anchors.map(parseResource).filter(Boolean);
  }).catch(() => []);
}

async function scrapeCurrentCloud189Resource(page, resourceId) {
  return await page.evaluate((slug) => {
    const text = (document.body?.innerText || '').trim();
    const parseSize = (value) => {
      const match = String(value || '').match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB|B)/i);
      if (!match) {
        return 0;
      }
      const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
      return Math.round(Number(match[1]) * units[match[2].toUpperCase()]);
    };
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const title = lines.find((line) => line.length > 3 && !/^(发布于|免费|\d+\s*积分|疑似失效|查看链接|复制链接|\d+(?:\.\d+)?\s*(TB|GB|MB|KB|B))$/i.test(line))
      || document.title
      || '影巢天翼资源';
    const cloudLink = text.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
    const accessCode = (text.match(/(?:访问码|提取码)[：:\s]*([A-Za-z0-9]{4})/) || [])[1] || '';
    const pointsMatch = text.match(/(\d+)\s*积分/);
    return {
      id: slug,
      slug,
      title,
      pan_type: '189',
      share_size: parseSize(text),
      unlock_points: pointsMatch ? Number(pointsMatch[1]) : 0,
      expired: /疑似失效/.test(text),
      is_unlocked: /已解锁|查看链接|复制链接/.test(text) || Boolean(cloudLink),
      media_url: cloudLink?.[0] || '',
      access_code: accessCode,
      pageUrl: location.href,
      source: 'resource-page'
    };
  }, resourceId).catch(() => null);
}

async function getStateDbPool() {
  if (!config.stateDatabaseUrl) {
    return null;
  }
  if (state.stateDbPool) {
    return state.stateDbPool;
  }
  const { Pool } = await import('pg');
  state.stateDbPool = new Pool({
    connectionString: normalizeStateDatabaseUrl(config.stateDatabaseUrl),
    ssl: resolveStateDatabaseSsl(config.stateDatabaseUrl, config.stateDatabaseSsl),
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  return state.stateDbPool;
}

async function ensureStateTable() {
  const pool = await getStateDbPool();
  if (!pool || state.stateDbInitialized) {
    return pool;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS browser_bridge_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  state.stateDbInitialized = true;
  return pool;
}

async function restoreBrowserState(context) {
  if (!config.stateDatabaseUrl) {
    return false;
  }
  try {
    const pool = await ensureStateTable();
    const result = await pool.query('SELECT value, updated_at FROM browser_bridge_state WHERE key = $1', [config.stateKey]);
    const rawValue = result.rows[0]?.value;
    if (!rawValue) {
      state.stateLoadOk = true;
      state.stateLoadedAt = Date.now();
      state.stateLastError = '';
      return false;
    }
    const snapshot = decodeStateValue(rawValue);
    const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
    const origins = Array.isArray(snapshot?.origins) ? snapshot.origins : [];
    if (origins.length > 0) {
      await context.addInitScript((storedOrigins) => {
        const matched = storedOrigins.find((origin) => origin.origin === window.location.origin);
        if (!matched?.localStorage) {
          return;
        }
        for (const item of matched.localStorage) {
          try {
            window.localStorage.setItem(item.name, item.value);
          } catch {
            // ignore
          }
        }
      }, origins);
    }
    state.stateLoadOk = true;
    state.stateLoadedAt = Date.now();
    state.stateLastError = '';
    return true;
  } catch (error) {
    state.stateLoadOk = false;
    state.stateLastError = `restore: ${error instanceof Error ? error.message : String(error)}`;
    console.warn('[browser-bridge] restore state skipped:', state.stateLastError);
    return false;
  }
}

async function persistBrowserState(context, reason = 'manual') {
  if (!config.stateDatabaseUrl || !context) {
    return false;
  }
  try {
    const pool = await ensureStateTable();
    const snapshot = await readBrowserStorageState(context);
    const encoded = encodeStateValue({
      ...snapshot,
      meta: {
        reason,
        baseUrl: config.baseUrl,
        savedAt: new Date().toISOString(),
        hostname: os.hostname()
      }
    });
    await pool.query(`
      INSERT INTO browser_bridge_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [config.stateKey, encoded]);
    state.statePersistOk = true;
    state.statePersistedAt = Date.now();
    state.stateLastError = '';
    return true;
  } catch (error) {
    state.statePersistOk = false;
    state.stateLastError = `persist: ${error instanceof Error ? error.message : String(error)}`;
    if (state.shuttingDown && isBrowserContextUnavailableError(error)) {
      console.warn('[browser-bridge] persist state skipped during shutdown:', state.stateLastError);
    } else {
      console.warn('[browser-bridge] persist state failed:', state.stateLastError);
    }
    return false;
  }
}

async function readBrowserStorageState(context) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForContextPagesSettled(context);
      return await context.storageState();
    } catch (error) {
      lastError = error;
      if (!isRetryableStorageStateError(error)) {
        break;
      }
      await delay(350 * attempt);
    }
  }
  return await readBrowserStorageStateFallback(context, lastError);
}

async function readBrowserStorageStateFallback(context, cause) {
  const cookies = await readContextCookies(context).catch(() => []);
  const origins = await readContextOrigins(context).catch(() => []);
  if (cookies.length > 0 || origins.length > 0) {
    return { cookies, origins };
  }
  throw cause || new Error('browser storage state is empty');
}

async function waitForContextPagesSettled(context) {
  const pages = context.pages().filter((page) => !page.isClosed());
  await Promise.all(pages.map(async (page) => {
    await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => undefined);
  }));
}

async function readContextCookies(context) {
  try {
    return await context.cookies(config.baseUrl);
  } catch (error) {
    const page = context.pages().find((candidate) => !candidate.isClosed() && candidate.url().startsWith(config.baseUrl));
    if (!page) {
      throw error;
    }
    const header = await page.evaluate(() => document.cookie || '');
    return parseCookieHeader(header, config.baseUrl);
  }
}

async function readContextOrigins(context) {
  const origins = [];
  const seen = new Set();
  for (const page of context.pages()) {
    if (page.isClosed() || !/^https?:\/\//i.test(page.url())) {
      continue;
    }
    const origin = await page.evaluate(() => ({
      origin: window.location.origin,
      localStorage: Array.from({ length: window.localStorage.length }, (_, index) => {
        const name = window.localStorage.key(index);
        return name ? { name, value: window.localStorage.getItem(name) || '' } : null;
      }).filter(Boolean)
    })).catch(() => null);
    if (!origin?.origin || seen.has(origin.origin)) {
      continue;
    }
    seen.add(origin.origin);
    origins.push(origin);
  }
  return origins;
}

function isRetryableStorageStateError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|navigation|Storage\.getCookies|Browser context management is not supported|Target page, context or browser has been closed|Protocol error/i.test(message);
}

function isBrowserContextUnavailableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Browser context management is not supported|Target page, context or browser has been closed|browser has been closed|Protocol error/i.test(message);
}

async function closeStateDatabase() {
  if (!state.stateDbPool) {
    return;
  }
  await state.stateDbPool.end().catch(() => undefined);
  state.stateDbPool = null;
  state.stateDbInitialized = false;
}

function resolveStateDatabaseSsl(databaseUrl, sslMode) {
  const normalizedMode = String(sslMode || '').trim().toLowerCase();
  if (['false', '0', 'off', 'disable'].includes(normalizedMode)) {
    return false;
  }
  if (['verify-full'].includes(normalizedMode)) {
    return true;
  }
  if (['true', '1', 'on', 'require', 'prefer', 'verify-ca'].includes(normalizedMode)) {
    return { rejectUnauthorized: false };
  }
  try {
    const url = new URL(databaseUrl);
    const urlSslMode = String(url.searchParams.get('sslmode') || '').trim().toLowerCase();
    if (['disable', 'false', '0', 'off'].includes(urlSslMode)) {
      return false;
    }
    if (urlSslMode === 'verify-full') {
      return true;
    }
    if (['require', 'prefer', 'verify-ca'].includes(urlSslMode)) {
      return { rejectUnauthorized: false };
    }
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      return false;
    }
  } catch {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: false };
}

function normalizeStateDatabaseUrl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function normalizeUrlPathname(value) {
  try {
    return new URL(String(value || '/'), config.baseUrl).pathname;
  } catch {
    return String(value || '/').split('?')[0] || '/';
  }
}

function isMissingResponseSignaturePayload(payload) {
  const message = [
    payload?.message,
    payload?.description,
    payload?.error,
    payload?.name,
    typeof payload === 'string' ? payload : ''
  ].filter(Boolean).join(' ');
  return /X-HDH-RSig|RSig|响应携带.*签名头|未收到.*签名头|Missing X-HDH-RSig/i.test(message);
}

function getCustomerPayloadFailure(payload, depth = 0) {
  if (!payload || depth > 4) {
    return '';
  }
  if (typeof payload === 'string') {
    return isMissingResponseSignaturePayload(payload) ? payload : '';
  }
  if (Array.isArray(payload) || typeof payload !== 'object') {
    return '';
  }

  const message = [
    payload.message,
    payload.description,
    payload.error,
    payload.name
  ].filter((item) => typeof item === 'string' && item.trim()).join(' ');
  if (isMissingResponseSignaturePayload(payload)) {
    return message || '影巢响应签名校验失败';
  }
  if (payload.success === false || payload.ok === false) {
    return message || '影巢业务响应失败';
  }

  const code = String(payload.code || payload.errorCode || payload.errCode || payload.httpStatus || '').trim();
  if (/^(ERR_|ERROR|FAIL|FAILED)/i.test(code) || (/^\d+$/.test(code) && Number(code) >= 400)) {
    return message || `影巢业务响应失败: ${code}`;
  }
  if (/未登录|登录态.*失效|unauthorized|forbidden|鉴权|权限不足/i.test(message)) {
    return message;
  }

  return getCustomerPayloadFailure(payload.response, depth + 1)
    || getCustomerPayloadFailure(payload.payload, depth + 1);
}

function encodeStateValue(value) {
  const json = JSON.stringify(value);
  if (!config.stateSecret) {
    return JSON.stringify({ version: 1, encoding: 'plain-json', data: json });
  }
  const iv = randomBytes(12);
  const key = createHash('sha256').update(config.stateSecret).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    encoding: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  });
}

function decodeStateValue(value) {
  const parsed = JSON.parse(String(value || '{}'));
  if (parsed.encoding === 'plain-json') {
    return JSON.parse(parsed.data || '{}');
  }
  if (parsed.encoding !== 'aes-256-gcm') {
    return parsed;
  }
  if (!config.stateSecret) {
    throw new Error('BRIDGE_STATE_SECRET/BRIDGE_TOKEN 未配置，无法解密云端浏览器状态');
  }
  const key = createHash('sha256').update(config.stateSecret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

async function safePageSummary(page, startedAt) {
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 500),
    elapsedMs: Date.now() - startedAt
  };
}

async function closeBrowser(reason = 'close', options = {}) {
  if (state.context) {
    if (options.persist !== false) {
      await persistBrowserState(state.context, reason).catch(() => false);
    }
    await state.context.close().catch(() => undefined);
  }
  state.context = null;
  state.page = null;
}

async function shutdown() {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  console.log('[browser-bridge] shutting down');
  await closeBrowser('shutdown');
  await closeStateDatabase();
  process.exit(0);
}

async function buildStatus() {
  const memory = process.memoryUsage();
  const cookieStatus = await buildCookieStatus();
  return {
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    browserReady: Boolean(state.context && state.page && !state.page.isClosed()),
    browserLaunchMs: state.browserLaunchMs,
    browserAgeSec: state.browserLaunchAt ? Math.round((Date.now() - state.browserLaunchAt) / 1000) : 0,
    lastWarmupAt: state.lastWarmupAt ? new Date(state.lastWarmupAt).toISOString() : null,
    lastWarmupMs: state.lastWarmupMs,
    lastWarmupOk: state.lastWarmupOk,
    lastWarmupError: state.lastWarmupError,
    warmupCount: state.warmupCount,
    restartCount: state.restartCount,
    activeAction: state.activeAction,
    baseUrl: config.baseUrl,
    hasCookie: cookieStatus.hasCookie,
    hasConfiguredCookie: cookieStatus.hasConfiguredCookie,
    hasRuntimeCookie: cookieStatus.hasRuntimeCookie,
    hasLoginCookie: cookieStatus.hasLoginCookie,
    runtimeCookieCount: cookieStatus.runtimeCookieCount,
    hasUsername: Boolean(config.username),
    protectedEndpoints: Boolean(config.bridgeToken),
    cloudState: {
      enabled: Boolean(config.stateDatabaseUrl),
      key: config.stateDatabaseUrl ? config.stateKey : '',
      encrypted: Boolean(config.stateDatabaseUrl && config.stateSecret),
      loadedAt: state.stateLoadedAt ? new Date(state.stateLoadedAt).toISOString() : null,
      persistedAt: state.statePersistedAt ? new Date(state.statePersistedAt).toISOString() : null,
      loadOk: state.stateLoadOk,
      persistOk: state.statePersistOk,
      lastError: state.stateLastError
    },
    hostname: os.hostname(),
    memory: {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal
    }
  };
}

async function buildCookieStatus() {
  const configuredCookies = parseCookieHeader(config.cookie, config.baseUrl);
  let runtimeCookies = [];
  if (state.context) {
    runtimeCookies = await readContextCookies(state.context).catch(() => []);
  }
  const cookieNames = new Set([
    ...configuredCookies.map((cookie) => cookie.name),
    ...runtimeCookies.map((cookie) => cookie.name)
  ]);
  const loginCookieNames = ['token', 'csrf_access_token', 'hdh_uid'];
  return {
    hasCookie: configuredCookies.length > 0 || runtimeCookies.length > 0,
    hasConfiguredCookie: configuredCookies.length > 0,
    hasRuntimeCookie: runtimeCookies.length > 0,
    hasLoginCookie: loginCookieNames.some((name) => cookieNames.has(name)),
    runtimeCookieCount: runtimeCookies.length
  };
}

function requireSensitiveEndpoint(req, res, next) {
  if (!config.bridgeToken) {
    res.status(403).json({
      success: false,
      error: 'BRIDGE_TOKEN 未配置，敏感接口已拒绝执行'
    });
    return;
  }
  next();
}

function parseWarmupUrls(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function toAbsoluteUrl(value) {
  const url = String(value || '/');
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${config.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCookieHeader(cookieHeader, baseUrl) {
  if (!cookieHeader) {
    return [];
  }
  const url = new URL(baseUrl);
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...valueParts] = part.split('=');
      if (!name || valueParts.length === 0) {
        return null;
      }
      return {
        name,
        value: valueParts.join('='),
        domain: url.hostname,
        path: '/',
        httpOnly: false,
        secure: url.protocol === 'https:',
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);
}

function cookiesToHeader(cookies) {
  return cookies
    .filter((cookie) => cookie.name && cookie.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function pickPrimitiveQuery(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const query = {};
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item)) {
      query[key] = String(item);
    }
  }
  return query;
}

function pickHeaders(headers, names) {
  const result = {};
  for (const name of names) {
    if (headers[name]) {
      result[name] = headers[name];
    }
  }
  return result;
}

function parseMaybeJson(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mergeResources(resources) {
  const seen = new Set();
  return resources.filter((resource) => {
    const key = resource?.slug || resource?.id || resource?.pageUrl || resource?.media_url;
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractResourceCandidates(value, depth = 0) {
  if (!value || depth > 6) {
    return [];
  }
  const unwrapped = unwrapResourcePayload(value);
  if (typeof unwrapped === 'string') {
    const link = extractCloudLinkFromText(unwrapped);
    if (!link) {
      return [];
    }
    return [{
      id: link,
      slug: '',
      title: '影巢天翼资源',
      pan_type: '189',
      media_url: link,
      access_code: extractAccessCodeFromText(unwrapped),
      is_unlocked: true,
      source: 'payload-text'
    }];
  }
  if (Array.isArray(unwrapped)) {
    return unwrapped.flatMap((item) => extractResourceCandidates(item, depth + 1));
  }
  if (typeof unwrapped !== 'object') {
    return [];
  }

  const nestedResources = Object.values(unwrapped).flatMap((item) => extractResourceCandidates(item, depth + 1));
  if (!looksLikeResourceCandidate(unwrapped)) {
    return nestedResources;
  }
  return [
    normalizeResourceCandidate(unwrapped),
    ...nestedResources
  ];
}

function unwrapResourcePayload(value) {
  let current = value;
  for (let index = 0; index < 6; index += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || looksLikeResourceCandidate(current)) {
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

function looksLikeResourceCandidate(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Boolean(
    value.slug
    || value.id
    || value.resourceId
    || value.resource_id
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

function normalizeResourceCandidate(resource) {
  const link = extractResourceLink(resource);
  const resourceId = resource.slug || resource.id || resource.resourceId || resource.resource_id || link;
  const accessCode = String(
    resource.access_code
    || resource.accessCode
    || resource.code
    || resource.password
    || resource.passwd
    || extractAccessCodeFromText(JSON.stringify(resource))
    || ''
  );
  return {
    ...resource,
    id: String(resourceId || ''),
    slug: resource.slug || resource.id || resource.resourceId || resource.resource_id || '',
    title: resource.title || resource.name || resource.resource_name || resource.media_name || '影巢天翼资源',
    pan_type: resource.pan_type || resource.netdisk_website_id || resource.net_disk_website_id || resource.website_id || resource.cloudType || '189',
    media_url: link || resource.media_url || '',
    access_code: accessCode,
    is_unlocked: Boolean(resource.is_unlocked || resource.isUnlocked || link),
    source: resource.source || 'payload'
  };
}

function extractResourceLink(resource) {
  const values = [
    resource.media_url,
    resource.mediaUrl,
    resource.full_url,
    resource.fullUrl,
    resource.shareLink,
    resource.share_link,
    resource.link,
    resource.url
  ];
  for (const value of values) {
    const link = extractCloudLinkFromText(value);
    if (link) {
      return link;
    }
  }
  return extractCloudLinkFromText(JSON.stringify(resource));
}

function extractCloudLinkFromText(value) {
  const match = String(value || '').match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
  return match?.[0] || '';
}

function extractAccessCodeFromText(value) {
  const match = String(value || '').match(/(?:访问码|提取码|access_code|accessCode|code|password)["'：:\s=]+([A-Za-z0-9]{4})/i);
  return match?.[1] || '';
}

function extractResourceEntriesFromHtml(html, pageUrl = config.baseUrl) {
  const text = decodeFlightText(html);
  const resources = [];
  const seen = new Set();
  const pathRegex = /\/resource\/(?:189|cloud189|8)\/([A-Za-z0-9._~-]+)/g;
  let pathMatch;
  while ((pathMatch = pathRegex.exec(text)) !== null) {
    const start = Math.max(0, pathMatch.index - 1500);
    const end = Math.min(text.length, pathMatch.index + 3500);
    addResourceEntry(resources, seen, decodeURIComponent(pathMatch[1]), text.slice(start, end), pageUrl);
  }

  const slugRegex = /"slug"\s*:\s*"([^"]+)"/g;
  let slugMatch;
  while ((slugMatch = slugRegex.exec(text)) !== null) {
    const start = Math.max(0, slugMatch.index - 2000);
    const end = Math.min(text.length, slugMatch.index + 4500);
    const block = text.slice(start, end);
    if (!/(?:"(?:website|website_id|netdisk_website_id|net_disk_website_id|pan_type|cloudType)"\s*:\s*"?189"?|天翼|cloud189|\/resource\/189\/)/i.test(block)) {
      continue;
    }
    addResourceEntry(resources, seen, decodeJsonString(slugMatch[1]), block, pageUrl);
  }
  return resources;
}

function addResourceEntry(resources, seen, slug, block, pageUrl) {
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedSlug || seen.has(normalizedSlug)) {
    return;
  }
  seen.add(normalizedSlug);
  const linkMatch = block.match(/https?:\/\/(?:cloud\.189\.cn|h5\.cloud\.189\.cn|content\.21cn\.com)[^\s"'<>\\)）]+/i);
  resources.push({
    id: normalizedSlug,
    slug: normalizedSlug,
    title: extractResourceTitle(block, `影巢天翼资源 ${resources.length + 1}`),
    pan_type: '189',
    share_size: getNumberField(block, 'share_size') || getNumberField(block, 'size') || getNumberField(block, 'file_size'),
    unlock_points: getNumberField(block, 'unlock_points') || getNumberField(block, 'points') || getNumberField(block, 'cost'),
    is_free: /(^|[\s"'([{,，:：])免费($|[\s"'\])},，。:：])/.test(block),
    expired: /"expired"\s*:\s*true|"isExpired"\s*:\s*true|疑似失效/i.test(block),
    is_unlocked: /"is_unlocked"\s*:\s*true|"isUnlocked"\s*:\s*true|已解锁|查看链接|复制链接/i.test(block),
    media_url: linkMatch?.[0] || '',
    pageUrl: `${config.baseUrl}/resource/189/${encodeURIComponent(normalizedSlug)}`,
    sourcePageUrl: pageUrl,
    source: 'html'
  });
}

function extractResourceTitle(block, fallback) {
  return getStringField(block, 'title')
    || getStringField(block, 'name')
    || getStringField(block, 'resource_name')
    || getStringField(block, 'media_name')
    || fallback;
}

function getStringField(block, field) {
  const escapedField = escapeRegExp(field);
  const match = block.match(new RegExp(`"${escapedField}"\\s*:\\s*"([^"]*)"`, 'i'));
  return match?.[1] ? decodeJsonString(match[1]) : '';
}

function getNumberField(block, field) {
  const escapedField = escapeRegExp(field);
  const match = block.match(new RegExp(`"${escapedField}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
  return match ? Number(match[1]) : 0;
}

function decodeJsonString(value) {
  try {
    return JSON.parse(`"${String(value || '').replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function normalizeResourceId(value) {
  const resourceId = String(value || '').trim();
  if (!/^[A-Za-z0-9._~-]+$/.test(resourceId)) {
    throw new Error('resourceId 包含非法字符');
  }
  return resourceId;
}

function extractMediaResourceTarget(html, type, tmdbId, observedTargets = []) {
  const observedTarget = observedTargets.find((target) => (
    target?.target_type === 'media_resource'
    && typeof target?.target_key === 'string'
    && target.target_key.startsWith(`${type}:`)
  ));
  if (observedTarget) {
    return observedTarget;
  }
  const text = decodeFlightText(html);
  const escapedType = escapeRegExp(type);
  const escapedTmdbId = escapeRegExp(String(tmdbId));
  const targetKeyPattern = new RegExp(`"target_key"\\s*:\\s*"(${escapedType}:${escapedTmdbId})"[\\s\\S]{0,600}?"target_id"\\s*:\\s*(\\d+)`, 'i');
  const targetKeyMatch = text.match(targetKeyPattern);
  if (targetKeyMatch) {
    return {
      target_type: 'media_resource',
      target_id: Number(targetKeyMatch[2]),
      target_key: targetKeyMatch[1]
    };
  }
  const reversePattern = new RegExp(`"target_id"\\s*:\\s*(\\d+)[\\s\\S]{0,600}?"target_key"\\s*:\\s*"(${escapedType}:${escapedTmdbId})"`, 'i');
  const reverseMatch = text.match(reversePattern);
  if (reverseMatch) {
    return {
      target_type: 'media_resource',
      target_id: Number(reverseMatch[1]),
      target_key: reverseMatch[2]
    };
  }
  const genericTargetPattern = new RegExp(`"target_key"\\s*:\\s*"(${escapedType}:\\d+)"[\\s\\S]{0,800}?"target_type"\\s*:\\s*"media_resource"`, 'i');
  const genericTargetMatch = text.match(genericTargetPattern);
  if (genericTargetMatch) {
    return {
      target_type: 'media_resource',
      target_key: genericTargetMatch[1]
    };
  }
  const genericReversePattern = new RegExp(`"target_type"\\s*:\\s*"media_resource"[\\s\\S]{0,800}?"target_key"\\s*:\\s*"(${escapedType}:\\d+)"`, 'i');
  const genericReverseMatch = text.match(genericReversePattern);
  if (genericReverseMatch) {
    return {
      target_type: 'media_resource',
      target_key: genericReverseMatch[1]
    };
  }
  return {
    target_type: 'media_resource',
    target_key: `${type}:${tmdbId}`
  };
}

function decodeFlightText(html) {
  return String(html || '')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
