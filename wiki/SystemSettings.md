# 系统设置

**系统** 页管理访问认证、任务调度、自动追剧默认配置、Telegram、消息推送、网络代理、影巢完整配置和正则预设等基础配置。

保存走 `POST /api/settings`，会同步调度任务、Bot 状态与消息推送实例。

---

## 1. 访问认证

| 配置项 | 说明 |
| :--- | :--- |
| 管理员用户名 | Web 控制台登录用户名 |
| 管理员密码 | Web 控制台登录密码（空则保留原密码；首次未设置时见 [[Setup]]） |
| 系统 API Key | 第三方脚本、Bot 旁路或 API 调用使用的密钥 |
| 基础地址 baseUrl | 生成代理播放链接时的公网/局域网根地址；也可用环境变量 `PUBLIC_BASE_URL` |

可以点击 **生成** 生成新的系统 API Key。修改认证信息后请妥善保存。

---

## 2. 任务设置

| 配置项 | 说明 |
| :--- | :--- |
| 任务过期天数 | 超过指定天数的任务可被清理或视为过期 |
| 最大重试次数 | 任务失败后的最大重试次数 |
| 重试间隔 (秒) | 两次重试之间的等待时间 |
| 任务检查定时 (Cron) | 自动检查任务更新；支持 `\|` 分隔多表达式 |
| 回收站清理定时 (Cron) | 自动清理回收站 |
| 懒转存清理定时 (Cron) | 自动清理懒转存文件 |
| 懒转存保留时间 (小时) | 懒转存临时文件保留时长 |
| 媒体文件后缀 | 被识别为媒体文件的扩展名列表 |
| 自动清空回收站 | 定时清空个人云回收站 |
| 自动清理家庭云回收站 | 定时清理家庭云回收站 |
| 自动清理懒转存文件 | 定时删除过期懒转存文件 |
| 仅转存媒体文件 | 创建任务时只处理媒体后缀文件 |
| 目标文件夹自动创建 | 目标目录不存在时自动创建 |
| 账号容量聚合 | 账号页显示多账号容量汇总 |
| 账号 Session 保活 | 定时刷新账号会话 |
| 账号 Session 保活 Cron | 默认 `0 */4 * * *` |

可以点击 **立即执行账号保活** 手动触发一次保活。

配置文件中还有 `task.enableAutoDeleteCompletedTask`（任务完结后删除任务记录）等项，当前 Web 表单可能未全部暴露，可直接编辑 `data/config.json`。

### Cron 示例

| 表达式 | 说明 |
| :--- | :--- |
| `0 */2 * * *` | 每 2 小时 |
| `0 0 * * *` | 每天凌晨 |
| `0 8,20 * * *` | 每天 8 点和 20 点 |
| `*/30 * * * *` | 每 30 分钟 |

---

## 3. 自动追剧默认配置

| 配置项 | 说明 |
| :--- | :--- |
| 默认追剧账号 | 自动追剧、部分订阅/榜单自动任务默认使用的账号 |
| 默认保存目录 | 自动创建任务时使用的目标目录 |

配置键：`task.autoCreate.*`。默认模式在配置中为 `lazy`（懒转存），以创建入口实际选择为准。

自动追剧页如果提示未配置，通常就是这里缺少账号或目录。

---

## 4. Telegram 机器人

| 配置项 | 说明 |
| :--- | :--- |
| Bot Token | 从 Telegram @BotFather 获取 |
| 默认 Chat ID | 默认接收通知和交互的 Chat ID |
| 反代 API 域名 (可选) | Telegram API 反代地址 |
| 允许使用的 Chat ID 列表 | 可使用 Bot 的用户或群组 |
| 管理员 Chat ID 列表 | 具备管理权限的 Chat ID |
| 成功通知 | `notifyOnSuccess` |
| 失败通知 | `notifyOnFailure` |
| 刮削通知 | `notifyOnScrape` |

配置后可点击 **测试配置**。更多指令见 [[Bot]]（含 PT 命令）。

---

## 5. 消息推送

系统页支持以下独立渠道（与 README 一致）：

### 企业微信

| 配置项 | 说明 |
| :--- | :--- |
| 启用 | `wecom.enable` |
| Webhook URL | 企业微信机器人 Webhook |

### Bark

| 配置项 | 说明 |
| :--- | :--- |
| 启用 | `bark.enable` |
| Server URL | 如 `https://api.day.app` |
| Key | Bark 设备 Key |

### WxPusher

| 配置项 | 说明 |
| :--- | :--- |
| 启用 | `wxpusher.enable` |
| SPT | 简单推送 SPT |

### PushPlus

| 配置项 | 说明 |
| :--- | :--- |
| 启用 | `pushplus.enable` |
| Token | PushPlus token |
| Topic / Channel / Webhook / To | 群组、渠道、webhook、指定接收者（可选） |

### 自定义推送列表

点击 **添加推送** 可新增任意 Webhook：

| 字段 | 说明 |
| :--- | :--- |
| 名称 | 推送配置名称 |
| 方法 | HTTP 方法 |
| Webhook URL | 接收地址 |
| 字段配置 (支持 `{{content}}`) | 自定义请求体字段 |
| 启用此推送 | 是否启用 |

后端由 `MessageUtil` → `MessageManager` 聚合多渠道发送。

---

## 6. 网络代理

| 配置项 | 说明 |
| :--- | :--- |
| 代理地址 / 端口 | HTTP 代理 |
| 代理用户名 / 密码 | 需要认证时填写 |

前端可勾选走代理的服务（与 Settings 页一致）：

- Telegram
- TMDB
- OpenAI
- 天翼网盘
- 影巢
- 自定义推送

配置文件 `proxy.services` 中还可能存在 PT 站点键（`ptMikan`、`ptAnibt`、`ptAnimegarden`、`ptNyaa`、`ptDmhy` 等），用于后端按源代理；若 UI 未展示，可直接改 `data/config.json`。

---

## 7. 影巢资源（完整配置）

系统页维护影巢的**完整**配置（媒体页只有 Cookie 兜底，见 [[MediaSettings]] / [[HDHive]]）：

| 配置项 | 说明 |
| :--- | :--- |
| 启用影巢 | `hdhive.enabled` |
| 站点地址 | 默认 `https://hdhive.com` |
| 网页登录账号 / 密码 | Bridge 登录取 Cookie |
| Cookie | 网页解析兜底 |
| Browser Bridge 地址 / Token | 独立 Bridge 服务 |
| 启用 Browser Bridge 签名模式 | `/api/customer/*`、签到、解锁 |
| Client ID / API Key | OpenAPI |
| 资源解锁 Action ID | 影巢部署轮换后可更新 |
| 每日自动签到 | Cron 或随机时间窗口、自动过人机 |

---

## 8. 正则预设列表

系统页也提供正则预设维护入口，用于创建任务时复用。更多写法见 [[Regex]]。

---

## 9. API 接口

所有自动化接口推荐带上系统 API Key：

```http
x-api-key: YOUR_API_KEY
```

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/settings` | 获取系统设置 |
| POST | `/api/settings` | 保存系统设置 |
| POST | `/api/settings/telegram/test` | 测试 Telegram 配置 |
| POST | `/api/settings/media` | 保存媒体设置 |
| GET | `/api/settings/regex-presets` | 获取正则预设 |
| POST | `/api/settings/regex-presets` | 保存正则预设 |
| GET | `/api/accounts/storage-summary` | 账号容量聚合 |
| POST | `/api/accounts/refresh-capacity` | 刷新容量缓存 |
| POST | `/api/accounts/keep-alive` | 手动 Session 保活 |

完整列表见 [[API]]。

---

## 安全建议

- 首次登录后使用强密码；不要依赖不存在的默认口令。
- 不要把 Web 控制台无保护地暴露到公网。
- 妥善保管系统 API Key、Bot Token、Cookie 和各类 Webhook 地址。
- 定期备份 `/home/data`，STRM 用户也建议备份 `/home/strm`。
