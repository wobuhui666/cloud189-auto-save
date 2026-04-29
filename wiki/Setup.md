# 安装与配置指南

本指南将帮助您完成 Cloud189 Auto Save 的安装、基础配置以及账号接入。

---

## 1. 部署方式

### Docker 部署 (推荐)

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

| 变量 | 说明 |
| :--- | :--- |
| `PUID` / `PGID` | 指定运行用户 ID 和组 ID，确保映射目录的读写权限 |
| `DNS_LOOKUP_IP_VERSION` | 双栈网络环境下，若登录失败建议固定为 `ipv4` |
| `EMBY_PROXY_PORT` | Emby 独立流代理端口，默认 `8097` |
| `PUBLIC_BASE_URL` | 外部访问地址，用于生成代理播放链接 |

---

## 2. 账号配置

系统支持通过 **账号密码** 或 **Cookie** 两种方式添加天翼云盘账号。

### 账号密码登录

1. 在 **账号** 页点击 **添加账号**。
2. 输入手机号/用户名及密码。
3. 若提示需要验证码，在弹窗中输入图形验证码后重新提交。

### Cookie 登录

如果账号开启了二次验证或密码登录频繁失败，推荐使用 Cookie 方式：

1. 打开天翼云盘官网并在浏览器登录。
2. 按 `F12` 打开开发者工具，切换到 **Network** 标签。
3. 刷新页面，在请求中找到包含 `cloud.189.cn` 的请求。
4. 在 **Cookie** 字段中找到 `SSON=xxxxxxx`，复制完整 Cookie 值。
5. 在 **添加账号** 弹窗的 **Cookie (可选)** 中填入。

密码和 Cookie 至少填写一个，如果都填写，则只有账号密码生效。

### 家庭云账号

添加账号时，在 **账号类型** 中可以选择：

- **个人云**：默认类型
- **家庭云**：选择后需要填写 **Family ID**

---

## 3. 初始认证

- **默认用户名**：`admin`
- **默认密码**：`admin`
- 首次登录后请在 **系统** 页 **访问认证** 中修改密码。
- 建议同时生成 **系统 API Key**，用于 REST API 调用。

---

## 4. 基础设置

### 系统基础地址

系统内部会根据 `system.baseUrl` 配置或 `PUBLIC_BASE_URL` 环境变量生成代理播放链接。如果未配置，默认使用 `http://127.0.0.1:3000`。

在 Docker 部署时，建议通过环境变量 `PUBLIC_BASE_URL` 指定外部可访问的地址，例如：

```bash
-e PUBLIC_BASE_URL=http://192.168.1.10:3000
```

### 定时检查任务

进入 **系统** 页 **任务设置**，支持标准 Cron 表达式：

| 配置项 | 默认值 | 说明 |
| :--- | :--- | :--- |
| 任务检查定时 | `0 19-23 * * *` | 自动扫描所有任务更新 |
| 回收站清理定时 | `0 */8 * * *` | 定期清理回收站 |
| 懒转存清理定时 | `0 */6 * * *` | 定期清理过期懒转存文件 |

---

## 5. 反向代理建议 (Nginx)

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

    # Emby 代理端口
    location /emby-proxy/ {
        proxy_pass http://127.0.0.1:8097/;
        proxy_set_header Host $host;
    }
}
```

---

## 使用建议

- 首次部署后先配置一个账号，确认登录正常。
- 如果需要使用 Emby 代理播放，确保 `8097` 端口已在 Docker 中映射。
- 遇到双栈网络登录问题时，优先设置 `DNS_LOOKUP_IP_VERSION=ipv4`。
