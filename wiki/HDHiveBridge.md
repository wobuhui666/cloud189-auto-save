# 影巢 Browser Bridge 部署指南

影巢 Browser Bridge 是独立常驻 Chromium 服务，用于调用影巢网页运行时里的签名接口，支持网页登录取 Cookie、签到、积分日志、天翼资源查询和资源解锁。

项目地址：`https://github.com/wobuhui666/hdhive-browser-bridge`

---

## 1. 适用场景

建议在以下场景部署：

- 需要使用影巢 `/api/customer/*` 网页签名能力。
- 希望影巢资源查询和解锁不受主项目容器冷启动影响。
- 使用 Render、VPS、NAS 或自建 Docker 环境运行常驻浏览器。
- 希望把影巢登录态持久化到云端数据库，容器重启后自动恢复。

账号密码不建议配置在 Bridge 容器里。推荐只在主项目 **媒体设置 → 影巢资源** 中填写影巢网页登录账号和密码，由主项目调用 Bridge 完成登录。

---

## 2. Docker 部署

### 2.1 构建镜像

```bash
git clone https://github.com/wobuhui666/hdhive-browser-bridge.git
cd hdhive-browser-bridge

docker build -t hdhive-browser-bridge .
```

### 2.2 使用云数据库持久化登录态（推荐）

推荐使用 Neon、Supabase 或其他免费 Postgres。复制数据库连接串后填入 `DATABASE_URL`。

```bash
docker run -d \
  --name hdhive-browser-bridge \
  --restart unless-stopped \
  -p 10000:10000 \
  -e BRIDGE_TOKEN="换成随机长密码" \
  -e DATABASE_URL="从 Neon 或 Supabase 复制的 Postgres 连接串" \
  -e BRIDGE_STATE_SECRET="换成另一串随机长密码" \
  -e BROWSER_HEADLESS=true \
  hdhive-browser-bridge
```

说明：

- `BRIDGE_TOKEN` 用于保护公开接口，主项目配置的 Browser Bridge Token 必须与它一致。
- `DATABASE_URL` 用于保存加密后的浏览器 Cookie / StorageState。
- `BRIDGE_STATE_SECRET` 用于加密云端状态；不填时会使用 `BRIDGE_TOKEN` 派生密钥。
- `BROWSER_HEADLESS=true` 是默认值；如果影巢登录页拒绝当前浏览器环境，可临时改为 `false` 排查。

### 2.3 使用本地 Docker Volume 持久化

如果不想配置云数据库，可以使用本地 volume 保存浏览器 profile：

```bash
docker run -d \
  --name hdhive-browser-bridge \
  --restart unless-stopped \
  -p 10000:10000 \
  -e BRIDGE_TOKEN="换成随机长密码" \
  -v hdhive-profile:/data/hdhive-profile \
  hdhive-browser-bridge
```

本地 volume 只适合同一台机器长期运行。Render 等无持久磁盘或易重建容器的环境，更推荐 `DATABASE_URL` 云端持久化。

---

## 3. Docker Compose 示例

```yaml
services:
  hdhive-browser-bridge:
    image: hdhive-browser-bridge
    container_name: hdhive-browser-bridge
    restart: unless-stopped
    ports:
      - "10000:10000"
    environment:
      BRIDGE_TOKEN: "换成随机长密码"
      DATABASE_URL: "从 Neon 或 Supabase 复制的 Postgres 连接串"
      BRIDGE_STATE_SECRET: "换成另一串随机长密码"
      BROWSER_HEADLESS: "true"
```

如果使用 Compose 直接构建：

```yaml
services:
  hdhive-browser-bridge:
    build: .
    container_name: hdhive-browser-bridge
    restart: unless-stopped
    ports:
      - "10000:10000"
    environment:
      BRIDGE_TOKEN: "换成随机长密码"
      DATABASE_URL: "从 Neon 或 Supabase 复制的 Postgres 连接串"
      BRIDGE_STATE_SECRET: "换成另一串随机长密码"
```

---

## 4. 主项目配置

在 cloud189-auto-save 的 **媒体设置 → 影巢资源** 中配置：

| 配置项 | 示例 | 说明 |
| :--- | :--- | :--- |
| 启用影巢 | 开启 | 启用影巢资源功能 |
| Browser Bridge 地址 | `http://服务器IP:10000` | 有反向代理时填写 HTTPS 域名 |
| Browser Bridge Token | 与 `BRIDGE_TOKEN` 一致 | 用于访问 Bridge 受保护接口 |
| 启用 Browser Bridge 签名模式 | 开启 | 使用网页签名接口调用 `/api/customer/*` |
| 网页登录账号 | 影巢邮箱或用户名 | 只保存在主项目配置中 |
| 网页登录密码 | 影巢密码 | 只保存在主项目配置中 |

保存设置后，进入主项目 **影巢** 页点击 **网页登录取 Cookie**。登录成功后：

1. Bridge 会把登录态写入浏览器上下文。
2. 配置了 `DATABASE_URL` 时，Bridge 会把登录态加密保存到云数据库。
3. 主项目会同步 Cookie，用于 Cookie 兜底解析。

---

## 5. 健康检查和验证

### 5.1 基础健康检查

```bash
curl http://127.0.0.1:10000/health
```

正常结果中应看到：

```json
{
  "success": true,
  "data": {
    "browserReady": true,
    "protectedEndpoints": true,
    "cloudState": {
      "enabled": true
    }
  }
}
```

如果没有配置数据库，`cloudState.enabled` 会是 `false`，但服务仍可用。

### 5.2 Token 验证

```bash
curl -H "x-bridge-token: 换成BRIDGE_TOKEN" \
  http://127.0.0.1:10000/metrics
```

### 5.3 主项目功能验证

在主项目影巢页依次测试：

1. **网页登录取 Cookie**
2. **同步 Cookie**
3. **签到**
4. **查询 TMDB 天翼资源**
5. **解锁并转存**

---

## 6. 环境变量

| 环境变量 | 必填 | 说明 |
| :--- | :--- | :--- |
| `BRIDGE_TOKEN` | 推荐 | 保护除 `/health` 外的接口；敏感接口强制要求配置 |
| `DATABASE_URL` | 可选 | Postgres 连接串，用于云端持久化浏览器状态 |
| `BRIDGE_STATE_DATABASE_URL` | 可选 | 与 `DATABASE_URL` 等价，优先级更高 |
| `BRIDGE_STATE_SECRET` | 可选 | 云端状态加密密钥 |
| `BRIDGE_STATE_KEY` | 可选 | 同一数据库区分多个 Bridge 实例，默认 `hdhive-default` |
| `BRIDGE_STATE_DATABASE_SSL` | 可选 | 设置为 `false` 可关闭数据库 SSL |
| `HDHIVE_BASE_URL` | 可选 | 默认 `https://hdhive.com` |
| `HDHIVE_COOKIE` | 可选 | 启动时注入 Cookie；通常不需要 |
| `BROWSER_PROFILE_DIR` | 可选 | 默认 `/data/hdhive-profile` |
| `BROWSER_HEADLESS` | 可选 | 默认 `true` |
| `WARMUP_URLS` | 可选 | 默认 `/,/search` |
| `WARMUP_INTERVAL_MS` | 可选 | 默认 `300000` |
| `KEEPALIVE_INTERVAL_MS` | 可选 | 默认 `25000` |

---

## 7. 常见问题

### 7.1 Render 上部署后还是不能保存登录态

检查是否已配置：

- `DATABASE_URL`
- `BRIDGE_TOKEN`
- `BRIDGE_STATE_SECRET`（推荐）

然后访问 `/health`，确认 `cloudState.enabled=true`，登录后 `cloudState.persistOk=true`。

### 7.2 主项目提示 Bridge 未授权

确认主项目中的 Browser Bridge Token 与 Bridge 容器的 `BRIDGE_TOKEN` 完全一致。

### 7.3 登录页提示“出现了很奇怪的错误”

这是影巢对浏览器环境的拦截。可以尝试：

- 重启 Bridge 容器。
- 临时设置 `BROWSER_HEADLESS=false` 排查。
- 避免频繁账号密码登录，优先复用已持久化的登录态。

### 7.4 数据库应该用哪个免费方案

推荐顺序：

1. Neon 免费 Postgres
2. Supabase 免费 Postgres
3. Render PostgreSQL（注意免费策略和到期规则）

只需要一个很小的表保存浏览器状态，免费额度通常足够。
