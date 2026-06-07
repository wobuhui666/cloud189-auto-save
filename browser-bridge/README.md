# HDHive Browser Bridge

常驻 Chromium 的独立容器，用来降低影巢网页签名接口的冷启动成本，并通过白名单动作调用 `/api/customer/*`。

## 本地运行

```bash
cd browser-bridge
npm install
npm start
```

## 接口

- `GET /health`：Render 健康检查，不需要 token。
- `GET /metrics`：浏览器状态、内存、预热耗时。
- `POST /warmup`：立即预热，可传 `{ "urls": ["/", "/search"] }`。
- `GET /hdhive/status`：打开影巢首页并返回页面状态。
- `GET /hdhive/open?path=/movie/550`：打开指定路径，验证热浏览器导航耗时。
- `POST /hdhive/login`：使用请求体或环境变量里的账号密码登录影巢并返回 Cookie 摘要。
- `GET /hdhive/cookies`：读取当前浏览器影巢 Cookie，用于同步到主项目。
- `GET /hdhive/customer/current`：通过影巢网页签名客户端读取当前用户。
- `POST /hdhive/customer/checkin`：签到。
- `GET /hdhive/customer/points-logs`：积分日志。
- `POST /hdhive/customer/media-resources`：按 `{ "type": "movie|tv", "tmdbId": "..." }` 查询资源。
- `POST /hdhive/customer/resources/:resourceId/unlock`：解锁资源。
- `POST /browser/restart`：重启浏览器上下文。

如果设置了 `BRIDGE_TOKEN`，除 `/health` 外都需要请求头 `x-bridge-token: <token>`。敏感接口强制要求配置 `BRIDGE_TOKEN`，否则拒绝执行。

## Render 环境变量

- `PORT`：Render 自动注入。
- `BRIDGE_TOKEN`：建议必填，保护公开接口。
- `HDHIVE_BASE_URL`：默认 `https://hdhive.com`。
- `HDHIVE_COOKIE`：可选，浏览器启动时注入影巢 Cookie。
- `HDHIVE_USERNAME`：可选，不推荐在 Bridge 侧配置；优先在主项目设置页配置账号。
- `HDHIVE_PASSWORD`：可选，不推荐在 Bridge 侧配置；优先在主项目设置页配置密码。
- `DATABASE_URL` / `BRIDGE_STATE_DATABASE_URL`：可选，Postgres 连接串；配置后会把浏览器 Cookie/StorageState 加密持久化到云数据库，容器重启后自动恢复登录态。
- `BRIDGE_STATE_SECRET`：可选，云端状态加密密钥；不填时使用 `BRIDGE_TOKEN` 派生密钥。
- `BRIDGE_STATE_KEY`：可选，同一个数据库里区分不同 Bridge 实例，默认 `hdhive-default`。
- `BRIDGE_STATE_DATABASE_SSL`：可选，设为 `false` 可关闭 Postgres SSL，设为 `verify-full` 可启用证书校验；云数据库默认自动启用 SSL。
- `BROWSER_PROFILE_DIR`：默认 `/data/hdhive-profile`；有云数据库后不再必须配置 Render Disk。
- `BROWSER_HEADLESS`：默认 `true`；如登录页拒绝 Headless，可设为 `false` 做排查。
- `LOGIN_TIMEOUT_MS`：默认 `45000`。
- `CUSTOMER_API_TIMEOUT_MS`：默认 `30000`。
- `WARMUP_URLS`：默认 `/,/search`。
- `WARMUP_INTERVAL_MS`：默认 `300000`。
- `KEEPALIVE_INTERVAL_MS`：默认 `25000`。

## 说明

这个容器只开放固定白名单动作，不开放任意 JS 执行接口，避免公开部署后变成远程执行入口。`/api/customer/*` 调用通过影巢页面运行时已加载的签名 API 客户端完成，不在 Node 后端重实现 WASM 签名。

推荐部署方式：

1. Render 给 Bridge 配置 `BRIDGE_TOKEN` 和 Postgres `DATABASE_URL`，不要配置影巢账号密码。
2. 主项目设置页配置 Browser Bridge 地址、Token、影巢网页登录账号和密码。
3. 在主项目“影巢”页点击网页登录取 Cookie。Bridge 登录成功后会把登录态写入云数据库。
4. 后续 Render 容器冷启动或重启时，Bridge 会从云数据库恢复 Cookie/StorageState。

## 常见日志

- `Execution context was destroyed`：通常是页面正在跳转时保存登录态，Bridge 会自动重试并兜底读取 Cookie/localStorage。
- `Browser context management is not supported`：通常发生在 Render 关机或浏览器上下文关闭阶段，正常登录后的状态已提前保存；关机阶段失败不会影响服务启动。
- `SSL modes 'prefer', 'require', and 'verify-ca'...`：来自 Postgres 连接串里的 `sslmode=require`。新版 Bridge 会在内部规整连接串并用 `BRIDGE_STATE_DATABASE_SSL` 控制 SSL。
