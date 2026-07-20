# REST API 文档

精简手册。完整、与代码对齐的接口列表请以仓库 **`wiki/API.md`** 为准（含 PT、榜单订阅、CAS 导入、影巢、扫码登录、媒体发现等）。

## 1. 认证要求

推荐在 HTTP Header 中包含 `x-api-key`：

```http
x-api-key: YOUR_SYSTEM_API_KEY
```

也可使用已登录 Web 的 Session Cookie。部分路径（stream / emby-proxy / 登录页等）在白名单内。

*API Key 可在系统设置中查看或生成。*

---

## 2. 常用分组（速查）

| 分组 | 路径前缀 | 说明 |
| :--- | :--- | :--- |
| 账号 | `/api/accounts` | 列表、扫码、容量、保活、路径前缀 |
| 任务 | `/api/tasks` | CRUD、执行、缓存清理、TMDB 绑定、STRM |
| 文件 | `/api/file-manager` | 列目录、新建、重命名、移动、删除、直链 |
| 订阅 | `/api/subscriptions` | 分享资源集合订阅 |
| 榜单订阅 | `/api/list-subscriptions` | 海报墙周期发现 |
| STRM | `/api/strm` | 配置与懒分享生成 |
| CAS | `/api/cas` | 恢复、导入、监控 |
| PT | `/api/pt` | 订阅、release、搜索、下载器 |
| 影巢 | `/api/hdhive` | 状态、签到、资源、解锁 |
| CloudSaver | `/api/cloudsaver/search` | 资源搜索 |
| 设置 | `/api/settings` | 系统/媒体/正则 |
| 媒体发现 | `/api/tmdb` `/api/douban` `/api/bangumi` | 海报墙数据源 |

---

## 3. 返回格式

```json
{
  "success": true,
  "data": {},
  "error": "失败时的错误信息"
}
```
