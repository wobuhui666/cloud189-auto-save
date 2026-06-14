# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库总览

天翼云盘自动转存系统 —— Node.js Express 单体后端 + React 19 (Vite) 单页前端。整套服务围绕「分享链接 → 转存 → STRM/CAS → Emby/Jellyfin 联动」这条数据链路展开，所有运行时状态写入 `data/`（SQLite + JSON + 文件 session）。

## 常用命令

### 后端（仓库根）
```bash
yarn dev                              # ts-node 直跑 src/index.js（开发，热配置生效）
yarn build                            # tsc 编译 src -> dist
yarn start                            # node dist/index.js（生产入口，由 Dockerfile CMD 使用）
```

### 前端（`frontend/`）
```bash
cd frontend && npm run dev            # Vite 5173，自动代理 /api -> http://localhost:3000
cd frontend && npm run build          # vite build -> ../src/public，再 sync 到 ../dist/public
cd frontend && npm run lint           # tsc --noEmit，只做类型检查
```

### 厂商 SDK 子模块
`vender/cloud189-sdk` 是 git submodule，需要单独构建（否则 `require('../../vender/cloud189-sdk/dist')` 会失败）：
```bash
git submodule update --init --recursive
cd vender/cloud189-sdk && yarn install && yarn build
```

### 内置 SDK 子树 `src/sdk/`（≠ 子模块，无需单独构建）
`src/sdk/hdhive/`（影巢）和 `src/sdk/cloudsaver/` 是**内置 vendored TS SDK**，和上面的 `vender/cloud189-sdk` 子模块**完全是两码事**：它们落在 `src/` 下，被 `tsconfig.json` 的 `include: ["src/**/*"]` 覆盖（子模块则被 `exclude`，所以才需要单独 build），根 `yarn build` 会把它们直接编译到 `dist/sdk/...`。调用方一律用**无扩展名** `require('./sdk/hdhive')`，dev 走 ts-node 解析 `.ts`、生产解析 `dist/sdk/*.js` —— **与 `src/entities/index.ts` 同一机制，编辑后同样必须 `yarn build`（生产）或用 `yarn dev`（ts-node），否则生产入口跑旧编译产物。**

### 整体一次性构建（Docker 的等价步骤）
```bash
cd vender/cloud189-sdk && yarn install --frozen-lockfile && yarn build && cd -
cd frontend && npm ci && npm run build && cd -
yarn install --frozen-lockfile && yarn build
```

仓库**没有单测/Lint 命令**（`scripts` 里只有 `start/build/dev`，前端只有 `lint`/tsc 类型检查）。改完代码请至少跑一次 `yarn build` + `cd frontend && npm run lint` 验证。

## 顶层架构

### 单体 Express 入口（`src/index.js`，~3200 行）
- **约 132 个 REST 端点集中在这里**，按业务域排序（账号 → 任务 → 文件夹 → 订阅 → STRM/CAS/PT/Emby …）。但并非「全部」端点都在 index.js：影巢 `/api/hdhive/*`（约 17 个，`setupHdhiveRoutes`，路由实体在 `src/sdk/hdhive/index.ts`）、CloudSaver `/api/cloudsaver/search`（`setupCloudSaverRoutes`）、SSE 日志 `/api/logs/events`（`initSSE`）这三组在 `app.listen` 前单独注册（`src/index.js:3189-3193`），且落在全局错误中间件之后，各自靠自身 try/catch 兜底。新增 index.js 内端点放进对应分区；影巢端点改 `src/sdk/hdhive/index.ts`。
- 顺序敏感：登录/静态资源中间件 → `authenticateSession` 鉴权中间件（定义 `src/index.js:635`，挂载 `:771`）→ `AppDataSource.initialize().then(...)` 内注册业务路由 → 全局错误中间件（`:3183`）→ `initSSE/setupCloudSaverRoutes/setupHdhiveRoutes`（`:3189-3193`）→ `app.listen`。新路由必须落在 `initialize().then` 回调内，否则取不到 Repository。
- 鉴权白名单：`/`、`/login`、`/api/auth/login`、`/api/stream/*`、`/emby-proxy*`、`/emby/notify`、`/assets/*` 及静态后缀。会话用 `session-file-store`（目录 `data/sessions/`）。**白名单之外还有一条全局旁路**：请求带 `x-api-key` 头且经 `timingSafeCompare` 匹配配置 `system.apiKey` 时，`authenticateSession` 直接放行（`src/index.js:636`），等同 API Key 鉴权——改鉴权逻辑勿遗漏。
- Emby 反代有两种入口：主端口下的 `/emby-proxy` 中间件 + 独立端口（默认 8097）的 `createStandaloneEmbyProxyApp`，两者通过 `syncStandaloneEmbyProxyServer` 按配置开关，且分别处理 WebSocket upgrade。

### 数据层（TypeORM + SQLite）
- DataSource 在 `src/database/index.js`，库文件 `data/database.sqlite`，启用 WAL。
- `synchronize` 默认 = `NODE_ENV !== 'production'`，可由 `TYPEORM_SYNCHRONIZE` 覆盖。**没有 migration 体系**，schema 全靠 entity 自动同步 + `ensureDatabaseIndexes()` 里手写的 `CREATE INDEX IF NOT EXISTS`。改字段要兼容 SQLite 的有限 ALTER 能力，并视情况补一条索引。
- 所有实体定义集中在 **TS 单文件** `src/entities/index.ts`，共 12 个 `@Entity()` 类，但只有 **11 个被真正注册**：`Account/Task/TaskProcessedFile/CommonFolder/Subscription/SubscriptionResource/StrmConfig/WorkflowRun/TmdbCache/PtSubscription/PtRelease`。第 12 个 `SystemLog`（`index.ts:626`）虽带 `@Entity()`，却既不在 `export default` 也不在 `src/database/index.js` 的 `entities` 数组里，是**孤儿实体** —— synchronize 不会为它建表。新增实体务必同时登记到 `export default` 和 `database/index.js` 的 `entities` 数组。
- `src/entities/index.js` 是运行时桥接：若检测到 ts-node 注册（`process[Symbol.for('ts-node.register.instance')]`）就直接 `require('./index.ts')`，否则用 `dist/entities`。**所以编辑 `index.ts` 后必须 `yarn build`（生产路径）或保证用 `yarn dev` 启动（ts-node 路径）。**
- 时区约定：几乎所有 `@CreateDateColumn`/`@UpdateDateColumn`/`@Column('datetime')` 都挂了 `transformer: from: date => new Date(date.getTime() + 8h)`，把 UTC 读取强转为 `+08:00`。新增日期字段务必沿用同样的 transformer，否则前端会偏 8 小时。
- 敏感字段加密：`Account.password` 通过 `PasswordCrypto`（AES-256-CBC）做透明 to/from transformer；密钥优先取环境变量 `PASSWORD_ENCRYPTION_KEY`，否则从 `system.passwordEncryptionKey` 配置项读取或自动生成。系统登录密码独立走 PBKDF2-SHA256（`hashPassword`/`verifyPassword`），与账号密码加密体系**不共用**。

### 配置层（`ConfigService`）
- 单例（`src/services/ConfigService.js`），构造函数里写死了完整的默认配置树，启动时与 `data/config.json` 深合并，落盘也走它。
- 跨服务的「特性开关 + cron 表达式 + 第三方凭据」几乎都在这里：`task.*` / `cas.*` / `pt.*` / `telegram.*` / `wecom.*` / `wxpusher.*` / `bark.*` / `pushplus.*` / `proxy.*` / `emby.*` / `strm.*` / `tmdb.*` / `openai.*` / `alist.*` / `cloudSaver.*` / `hdhive.*` / `system.*` / `organizer.*`，外加两个数组型顶层项 `regexPresets` / `customPush`。
- 取值用 `getConfigValue('a.b.c', defaultValue)`，写值用 `setConfigValue('a.b.c', v)`，立即落盘。
- 修改 cron 类配置后必须调用 `SchedulerService.handleScheduleTasks(settings, taskService)` 让现存定时任务跟着切换，否则旧 job 不会卸载。注意它须在 `ConfigService.setConfig` 落盘**之前**调用 —— 内部用 `getConfigValue` 取到的旧值与传入的 `settings` 新值对比来增删 job（`scheduler.js:291`）。

### 调度层（`SchedulerService`）
- 静态类，`taskJobs: Map<id|name, cronJob>`。
- 启动时 `initTaskJobs` 加载每个 `Task.enableCron=true` 的自定义 cron + 7 类内置默认 job：任务巡检、重试、回收站、懒文件清理、**账号 Session 保活**（`task.enableSessionKeepAlive` / `sessionKeepAliveCron`）、PT 轮询/处理/清理、**影巢自动签到**（`hdhive.checkin`）。其中回收站/懒文件/Session 保活/PT 清理/影巢签到都是条件注册（对应开关开启才挂）。
- 任务巡检 cron 支持 `|` 分隔多表达式，会自动展开成 `任务定时检查-0/1/...` 多个 job。
- 任何新增的"周期性后台逻辑"都应该通过 `saveDefaultTaskJob(name, cron, fn)` 注册，不要在业务代码里直接 `cron.schedule`。

### 事件层（`EventService`）
- `src/services/eventService.js` 是单例化的 Node `EventEmitter`。当前主要事件是 `taskComplete`，由 `TaskService` 构造时挂载 `TaskEventHandler`（避免重复挂载用 `hasListeners('taskComplete')` 守卫）。
- 新增跨服务通知（推送、刮削、STRM 重建）建议复用这个总线，不要让 service 之间相互直接 require。

### 天翼云盘 SDK 封装（`Cloud189Service`）
- `src/services/cloud189.js`：实例缓存键 `username::accountType::familyId`，对外 `Cloud189Service.getInstance(account)`。改账号字段后需要 `invalidateByUsername` 清缓存。
- 代理来自 `ProxyUtil.getProxy('cloud189')`（基于 ConfigService 的 `proxy.*`）。统一封装 `request(action, body)`，会处理 `ShareAuditWaiting` 之类的业务返回码。
- SDK token 写入 `data/${account.username}.json`（`FileTokenStore`）。

### 外部资源源：影巢 HDHive + CloudSaver（`src/sdk/`）
转存数据链的上游除了分享链接 / 订阅，还有两个内置 SDK 资源源（路由都在 `app.listen` 前由各自的 `setupXxxRoutes` 注册）：
- **影巢 HDHive**（`src/sdk/hdhive/`）：第三方影视资源站，按 TMDB ID 查天翼云盘资源 → 解锁 → 把分享链接 / 访问码 / 标题带入 `TaskService` 建转存任务。约 17 个 `/api/hdhive/*` 端点在 `src/sdk/hdhive/index.ts`，SDK 实现在 `src/sdk/hdhive/sdk.ts`，前端是 `HdhiveTab.tsx`，配置 `hdhive.*`，签到 job `SchedulerService.runHdhiveCheckin()`。三种接入按优先级回退：OpenAPI OAuth → **Browser Bridge 签名模式（推荐）** → Cookie 网页解析兜底。**Browser Bridge 是一个独立部署的常驻 Chromium 服务**（外部仓库 `hdhive-browser-bridge`，默认端口 10000），主项目用 `hdhive.browserBridge.{baseUrl,token}` 经 `x-bridge-token` 反向调用它执行影巢网页里的签名 / 人机校验接口（Node 侧无法复现）。详见 `wiki/HDHive.md` / `wiki/HDHiveBridge.md`。**敏感字段（`cookie`/`password`/`apiKey`/`browserBridge.token`）在 `src/index.js:248-294` 有专门的响应脱敏与「空输入保留旧值」逻辑，改设置端点勿绕过。**
- **CloudSaver**（`src/sdk/cloudsaver/`）：聚合网盘搜索源，对外 `/api/cloudsaver/search`，被 `AutoSeriesService` 追剧搜索与 `TaskService` 转存失败「自动换源」复用；凭据走 `cloudSaver.*`，改配置后 `index.js` 会 `clearCloudSaverToken()` 清 token。

### 业务服务（`src/services/*`，按依赖方向看）
- `TaskService`（~3000 行）：转存核心，含分享解析、目录扫描、增量比对、追更、组织、STRM/CAS 后处理。被 `LazyShareStrmService`、`SubscriptionService`、`OrganizerService`、`AutoSeriesService`、Telegram bot 共同复用。
- `LazyShareStrmService`：懒 STRM（用户播放时再触发转存，返回直链）。组合 `StrmService` + `StreamProxyService` + `OrganizerService` + `CasService`。
- `StrmService` / `StrmConfigService`：生成与刷新本地 `.strm` 文件，规则化路径替换。
- `CasService` + `casFileService`/`casMonitorService`/`casPlaybackService`/`casCleanupService`/`casMetadataCache`：内容寻址秒传体系。
- `EmbyService` + `EmbyPrewarmService`：反代、刷库通知、下一集预热。
- `SubscriptionService` / `listSubscription`：分享订阅 + 榜单订阅。
- `PtService` + `PtSource`/`PtRename`/`PtUtils` + `downloader/qbittorrent.js`：RSS PT 订阅 → qBittorrent → 上传 → STRM。
- `MessageUtil` (`src/services/message.js` + `src/services/message/*`)：聚合 WeCom/Telegram/Bark/PushPlus/WxPusher/Custom 推送。
- `AIService` / `TMDBService` / `DoubanService` / `ScrapeService`：智能重命名、刮削。
- `AlistService` / `StreamProxyService` / `OrganizerService` / `AutoSeriesService` / `TaskEventHandler` / `CacheManager`。

### 前端（`frontend/`）
- React 19 + Vite 6 + TailwindCSS 4 + motion + lucide-react。
- 入口 `src/App.tsx`，Tab 切分在 `src/components/tabs/*Tab.tsx`，一个 Tab 对应一个业务域（共 13 个：Account/Task/FileManager/AutoSeries/**Hdhive(影巢)**/Organizer/Subscription/StrmConfig/Media/Cas/Pt/PosterWall/Settings）。
- `vite.config.ts` 把 `__APP_VERSION__` 注入为根 `package.json.version`，并在 dev 时把 `/api` 代理到本机 3000；构建时 `outDir: '../src/public'`，再由 `scripts/sync-dist-public.mjs` 同步到 `dist/public`，所以**后端的静态目录始终是 `src/public`（dev/源码）和 `dist/public`（生产）**。
- `frontend/src/public/login.html` 是手写登录页（gitignore 中明确保留追踪），同时 `src/index.js` 内置了一份 `loginPageFallbackHtml`，找不到打包产物时使用。

## 运行时目录约定
- `data/database.sqlite[-wal/-shm]`：主库
- `data/config.json`：ConfigService 落盘
- `data/sessions/`：express-session 文件存储
- `data/{username}.json`：cloud189-sdk 的 token
- `strm/`：默认 STRM 输出（启动时会 `chmod 777`，若以 root 跑还会 `chown $PUID:$PGID`）
- `dist/public/`：构建后服务于 Express static 的前端 bundle
- `src/public_bak/`：React 重写前的旧版手写前端（vanilla JS/CSS），仍被 git 跟踪但已无任何代码引用，纯历史残留 —— 改前端别碰它
- `.playwright-mcp/`、`/转存助手/`、`/转存助手.crx`：与代码无关的附件资产

## 关键环境变量
| 变量 | 作用 |
|---|---|
| `PORT` | 主服务端口（默认 3000） |
| `EMBY_PROXY_PORT` | Emby 独立反代端口（默认 8097，可被配置 `emby.proxy.port` 覆盖） |
| `PUID` / `PGID` | 容器内 strm 目录 chown 目标 |
| `DNS_LOOKUP_IP_VERSION` | `auto`/`ipv4`/`ipv6`，规避天翼接口双栈 InvalidSessionKey。真正读取点在子模块 `vender/cloud189-sdk/src/CloudClient.ts`，`src/` 里 grep 不到（排查时别只搜 `src/`） |
| `JSON_BODY_LIMIT` | Express JSON body 上限（默认 2mb） |
| `SESSION_SECRET` | session 加密；不设则首次启动生成并写回配置 |
| `CORS_ORIGINS` / `PUBLIC_BASE_URL` | CORS 白名单（生产以外还会自动放过 localhost） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 仅作为 ConfigService 初始默认值，落库后以配置文件为准 |
| `PASSWORD_ENCRYPTION_KEY` | 账号密码 AES 密钥（hex），优先级高于配置文件 |
| `TYPEORM_SYNCHRONIZE` | 显式覆盖 schema 同步开关 |
| `LOGIN_FAILURE_DELAY_MS` / `LOGIN_RATE_LIMIT_WINDOW_MS` / `LOGIN_RATE_LIMIT_MAX` | 登录限流参数 |
| `NODE_ENV` | 影响 cookie secure、CORS dev fallback、schema 同步默认值 |

## 修改时容易踩的雷
- 改 `src/entities/index.ts` 或 `src/sdk/**/*.ts`（hdhive/cloudsaver）后没 rebuild → 生产入口仍跑老编译产物；要么 `yarn build`，要么改用 `yarn dev`（ts-node）。
- 把新增端点写到鉴权中间件之前 → 整个 API 失鉴权；务必放进 `AppDataSource.initialize().then` 回调里。
- 直接 `cron.schedule(...)` 而不走 `SchedulerService` → 重启/配置变更后无法停掉，会泄漏 job。
- 改 Account/敏感字段时绕过 transformer 直接写 `update({password})` → 写入明文，破坏加密一致性。请走 `repository.save(entity)` 路径。
- 前端改了组件没跑 `npm run build` → `src/public/` 仍是旧 bundle，后端 static 中间件返回过期页面。
- 不留意 `+08:00` transformer → 新加 `datetime` 字段读出来会落后 8 小时；沿用现有 `Task`/`Account` 的写法即可。

## 文档
仓库内有 `wiki/`（主文档，~24 页，导航见 `wiki/_Sidebar.md`）和 `doc/`（精简手册：`api`/`bot`/`features`/`setup`）两套 Markdown。wiki 按子系统拆分：核心 `Tasks`/`AutoSeries`/`CAS`/`Organizer`/`Subscription`/`PT`，媒体 `Emby`/`StrmGuide`/`Alist`，系统 `MediaSettings`/`SystemSettings`/`HDHive`/`HDHiveBridge`，扩展 `Bot`/`API`/`Regex`/`CloudSaver`，以及 `SystemDesign`（解释「单层目录」哲学）/`FAQ`。改动核心策略前先读对应 wiki 页面再动手。
