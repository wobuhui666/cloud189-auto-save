# 安装与配置指南

本指南将帮助您完成 Cloud189 Auto Save 的安装、基础配置以及账号接入。

## 1. 部署方式

### Docker 部署 (推荐)

使用 Docker 部署是最简单且推荐的方式，支持自动更新与环境隔离。

```bash
docker run -d \
  --name cloud189 \
  --restart unless-stopped \
  -v /opt/cloud189/data:/home/data \
  -v /opt/cloud189/strm:/home/strm \
  -p 3000:3000 \
  -p 8097:8097 \
  -e PUID=0 \
  -e PGID=0 \
  -e DNS_LOOKUP_IP_VERSION=ipv4 \
  ghcr.io/wobuhui666/cloud189-auto-save:latest
```

#### 环境变量说明
- `PUID`/`PGID`：指定运行用户 ID 和组 ID，确保映射目录的读写权限。
- `DNS_LOOKUP_IP_VERSION`：在双栈（IPv4/IPv6）网络环境下，若出现登录失败，建议固定为 `ipv4`。
- `EMBY_PROXY_PORT`：Emby 独立流代理端口，默认 `8097`。

---

## 2. 账号配置

系统支持通过 **账号密码** 或 **Cookie (SSON)** 两种方式添加天翼云盘账号。

### 账号密码登录
1. 在“账号管理”页面点击“添加账号”。
2. 输入手机号/用户名及密码。
3. 若提示需要验证码，请在界面输入显示的图形验证码。

### Cookie (SSON) 登录 (更稳定)
如果账号开启了二次验证或密码登录频繁失败，推荐使用 SSON：
1. 打开天翼云盘官网并在浏览器登录。
2. 按 `F12` 打开开发者工具，切换到 `Network` (网络) 标签。
3. 刷新页面，在请求中找到包含 `cloud.189.cn` 的请求。
4. 在 `Cookie` 字段中找到 `SSON=xxxxxxx`，复制 `xxxxxxx` 部分。
5. 在系统中添加账号时，填入该 SSON 值。

---

## 3. 基础设置

### 系统基础地址
在“系统设置”中，建议填写您的外部访问地址（如 `http://192.168.1.10:3000` 或域名）。这对于生成 STRM 文件和 Lazy STRM 回源至关重要。

### 定时检查任务
支持标准的 Cron 表达式（如 `0 0 * * *` 表示每天凌晨执行）。系统会根据此配置自动扫描所有任务的更新情况。

---

## 4. 反向代理建议 (Nginx)

为了安全访问，建议配置 Nginx 反向代理并启用 HTTPS：

```nginx
server {
    listen 443 ssl;
    server_name cloud.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 如果需要使用 Emby 代理端口
    location /emby-proxy/ {
        proxy_pass http://127.0.0.1:8097/;
        proxy_set_header Host $host;
        # ... 其他配置
    }
}
```

## 5. 初始认证
- **没有**内置默认口令 `admin/admin`。
- 若未设置环境变量 `ADMIN_PASSWORD`，首次访问登录页会要求**自行设置用户名和密码**（密码至少 6 位）。
- 设置完成后请在系统设置中生成 **API Key**。
- 完整文档见仓库 `wiki/Setup.md`。
