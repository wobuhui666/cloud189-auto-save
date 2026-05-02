# CloudSaver 搜索

[CloudSaver](https://github.com/wobuhui666/CloudSaver) 是本项目的**外部依赖服务**，用于搜索公开的天翼云盘分享资源。推荐使用二开版本，支持搜索 **Telegram 频道**、**影巢** 和 **雷鲸小站** 的资源。

---

## 1. 功能概述

- **资源搜索**：按关键字搜索公开分享资源，结果自动过滤为 `cloud.189.cn` 链接。
- **快速建任务**：搜索结果可一键带入创建任务弹窗（含分享链接、访问码、标题）。
- **自动追剧候选资源**：自动追剧流程会调用 CloudSaver 搜索候选剧集。
- **Telegram Bot 搜索**：通过 `/search_cs` 命令在 Telegram 中搜索并转存。

CloudSaver 只负责搜索和返回分享链接，资源是否可用取决于分享状态和账号情况。

---

## 2. 部署 CloudSaver

CloudSaver 是独立服务，需要单独部署。二开版本镜像地址：

```
ghcr.io/wobuhui666/cloudsaver
```

### 2.1 Docker 部署（推荐）

```bash
docker run -d \
  --name cloudsaver \
  --restart unless-stopped \
  -v /opt/cloudsaver/config:/app/config \
  -p 8009:8008 \
  -e CLOUDSAVER_USERNAME=admin \
  -e CLOUDSAVER_PASSWORD=your_password \
  ghcr.io/wobuhui666/cloudsaver:latest
```

> **注意**：
> - 容器内部端口为 `8008`，宿主机映射端口可自定义（如 `8009`）。
> - 配置文件挂载到 `/opt/cloudsaver/config`，首次启动会自动生成。
> - 请务必修改默认密码。

### 2.2 Docker Compose 部署

与 cloud189-auto-save 一起部署的完整 `docker-compose.yml` 示例：

```yaml
version: '3.8'

services:
  # 天翼云盘自动转存系统
  cloud189:
    image: ghcr.io/wobuhui666/cloud189-auto-save:latest
    container_name: cloud189
    restart: unless-stopped
    ports:
      - "3000:3000"
      - "8097:8097"
    volumes:
      - /opt/cloud189/data:/home/data
      - /opt/cloud189/strm:/home/strm
    environment:
      - PUID=0
      - PGID=0
      - DNS_LOOKUP_IP_VERSION=ipv4

  # CloudSaver 资源搜索服务（二开版本）
  cloudsaver:
    image: ghcr.io/wobuhui666/cloudsaver:latest
    container_name: cloudsaver
    restart: unless-stopped
    ports:
      - "8009:8008"
    volumes:
      - /opt/cloudsaver/config:/app/config
    environment:
      - CLOUDSAVER_USERNAME=admin
      - CLOUDSAVER_PASSWORD=your_password
      - JWT_SECRET=replace_with_random_string
      # Telegram 频道搜索（可选）
      - TELE_CHANNELS=[]
      # 影巢搜索（可选，需申请 API Key）
      - HDHIVE_ENABLED=true
      - HDHIVE_API_KEY=
      # 代理设置（访问 Telegram 需要时开启）
      - PROXY_ENABLED=false
      # - HTTP_PROXY_HOST=127.0.0.1
      # - HTTP_PROXY_PORT=7890
```

启动：

```bash
docker compose up -d
```

### 2.3 环境变量参考

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `CLOUDSAVER_USERNAME` | 登录用户名 | `admin` |
| `CLOUDSAVER_PASSWORD` | 登录密码 | `admin123456` |
| `JWT_SECRET` | JWT 签名密钥，建议修改 | `replace_me` |
| `TELE_CHANNELS` | Telegram 频道列表（JSON 数组），留空使用内置天翼频道 | `[]` |
| `PROXY_ENABLED` | 是否启用代理访问 Telegram | `false` |
| `HTTP_PROXY_HOST` | 代理主机 | `127.0.0.1` |
| `HTTP_PROXY_PORT` | 代理端口 | `7890` |
| `HDHIVE_ENABLED` | 是否启用影巢搜索 | `true` |
| `HDHIVE_API_KEY` | 影巢 Open API 密钥（未配置则跳过影巢搜索） | 空 |
| `HDHIVE_TMDB_SEARCH_LIMIT` | TMDB 搜索结果限制 | `5` |
| `HDHIVE_RESOURCE_LIMIT` | 影巢资源限制 | `3` |

### 2.4 Telegram 频道配置

`TELE_CHANNELS` 留空或设为 `[]` 时，自动使用内置天翼频道：

- `tianyirigeng`、`cloudtianyi`、`tyypzhpd`、`tianyiDrive`、`tianyifc`、`tianyiyunpanpindao`、`yunpan189`

如需自定义频道：

```json
[{"id":"your_channel_id","name":"频道名称"}]
```

> 服务器无法直连 Telegram 时，需开启 `PROXY_ENABLED` 并配置代理。

### 2.5 影巢配置（可选）

影巢仅返回**免费资源**或已解锁资源，不会自动消耗积分。

1. 前往影巢申请 Open API 密钥。
2. 设置 `HDHIVE_API_KEY` 为你的密钥。
3. 搜索时会先通过 TMDB 匹配，再调用影巢接口获取资源。

---

## 3. 接入 cloud189-auto-save

部署完成后，在 cloud189-auto-save 中配置连接：

1. 打开 Web 管理界面，进入 **媒体** 页。
2. 找到 **CloudSaver 设置** 区域。
3. 填写以下信息：

| 配置项 | 说明 | 示例 |
| :--- | :--- | :--- |
| 服务地址 | CloudSaver 的访问地址 | `http://192.168.1.10:8009` |
| 用户名 | 与 CloudSaver 环境变量一致 | `admin` |
| 密码 | 与 CloudSaver 环境变量一致 | `your_password` |

> **提示**：
> - 如果 CloudSaver 和 cloud189-auto-save 部署在同一 Docker 网络中，可使用容器名作为地址，如 `http://cloudsaver:8008`。
> - 修改配置后，系统会自动清除旧的登录 Token 并重新认证。
> - 未配置时，Bot 搜索会提示：`未开启CloudSaver，请先在网页端配置CloudSaver`。

---

## 4. Web 端使用

CloudSaver 在 Web 端以全局浮动入口提供：

1. 点击右下角浮动按钮。
2. 选择 **CloudSaver**。
3. 在弹窗中输入关键字，点击 **搜索**（或按回车）。
4. 结果列表显示标题、大小和日期。
5. 点击右侧的一键转存按钮，系统自动打开创建任务弹窗并填入：
   - `shareLink` — 分享链接
   - `accessCode` — 访问码（如有）
   - `taskName` — 资源标题

---

## 5. Telegram Bot 使用

在 Telegram 中发送：

```
/search_cs
```

操作流程：

1. 输入关键字（如 `庆余年`）。
2. Bot 返回编号列表。
3. 发送编号（如 `1`），Bot 自动将对应链接带入转存流程。

注意事项：

- 需先用 `/accounts` 选择转存账号。
- 3 分钟无操作自动退出搜索模式。
- `/cancel` 可主动退出。
- 搜索模式中直接发送分享链接，会先退出搜索模式再按链接创建任务。

---

## 6. 与自动追剧的关系

自动追剧流程中，CloudSaver 负责搜索候选资源：

```
输入剧名 → TMDB 匹配剧集信息 → CloudSaver 搜索候选资源 → 选择最佳资源 → 创建任务
```

如果自动追剧搜索不到候选资源，优先检查：

1. CloudSaver 服务是否正常运行。
2. 服务地址、用户名、密码是否正确。
3. CloudSaver 日志中是否有登录失败或搜索异常。

---

## 7. API 接口

cloud189-auto-save 暴露的搜索代理接口（需携带系统 API Key）：

```http
GET /api/cloudsaver/search?keyword=关键词
x-api-key: YOUR_API_KEY
```

返回结果中包含资源标题和可用的 `cloud.189.cn` 分享链接。

---

## 8. 常见问题

### CloudSaver 登录失败

- 检查服务地址是否可达（可 `curl http://地址:端口/api/health` 测试）。
- 确认用户名和密码与 CloudSaver 环境变量一致。
- 修改配置后系统会自动重新登录。

### 搜索无结果

- 确认关键字是否准确，尝试不同关键词。
- 检查 CloudSaver 日志是否有网络错误。
- 如果使用了代理，确认代理配置正确。

### 搜索电影/剧集建议

- 搜索电影时加年份，如 `阿凡达 2009`。
- 搜索剧集用官方中文名；结果不佳时尝试原始标题。
- 结果过多时，结合年份、分辨率或制作组关键词缩小范围。
