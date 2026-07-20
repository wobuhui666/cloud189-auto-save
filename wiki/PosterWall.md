# 海报墙与榜单订阅

**海报墙** 页用于浏览 TMDB / 豆瓣 / Bangumi 等公开榜单与搜索结果，并支持把某个榜单订阅成周期性「发现 → 自动追剧 / PT」流水线。

---

## 1. 海报墙浏览

入口：Web 顶栏 **海报墙**。

能力概览：

- 浏览 TMDB 趋势、高分、发现分类。
- 浏览豆瓣热门、搜索、Top250。
- 浏览 Bangumi 放送表、排行与搜索。
- 封面图经 `/api/image-proxy` 代理，减少跨域与防盗链问题。
- 从条目跳转到自动追剧或创建任务流程（依赖系统默认追剧账号/目录与 TMDB 配置）。

相关接口见 [[API]]「媒体发现」一节。

---

## 2. 榜单订阅

在海报墙中可对当前榜单打开 **榜单订阅** 管理：

| 字段 | 说明 |
| :--- | :--- |
| 名称 | 订阅显示名 |
| 来源 `source` | `douban` / `tmdb` / `bangumi` |
| 分类 `category` | 如豆瓣关键词、`热门`；TMDB 的 `trending` / `top_rated` / `genre:...` 等 |
| Cron | 拉取周期，默认 `0 8 * * *` |
| limit | 每次拉取条数（1–100） |
| mode | `lazy` 或 `normal`，交给自动追剧创建任务 |
| fallbackToPt | 追剧失败时是否回退 PT |
| ptPreset | PT 回退站点预设（如 `nyaa`、`dmhy`、`mikan` 等） |
| enabled | 是否启用 |

### 执行逻辑

1. 按 Cron 或手动 **立即运行** 拉取榜单。
2. 与 `seenIds` 比对，只处理新条目。
3. **优先**调用自动追剧（需系统页默认账号与目录、TMDB/CloudSaver 等）。
4. 若失败且 `fallbackToPt=true`，则聚合搜索 PT，取可用 `directRss` 创建 PT 订阅。

数据持久化在配置项 `listSubscriptions`（`data/config.json`），不是独立 SQLite 表。

### API

| 方法 | 路径 |
| :--- | :--- |
| GET | `/api/list-subscriptions` |
| POST | `/api/list-subscriptions` |
| PUT | `/api/list-subscriptions/:id` |
| DELETE | `/api/list-subscriptions/:id` |
| POST | `/api/list-subscriptions/:id/run` |

---

## 3. 前置条件

- **系统** 页配置好自动追剧默认账号与保存目录。
- **媒体** 页配置 TMDB API Key，并按需启用刮削。
- 若使用 PT 回退：配置 [[PT]] 下载器与账号。
- 若使用 CloudSaver 追剧搜源：配置 CloudSaver。

---

## 4. 与「订阅」页的区别

| | 订阅页 [[Subscription]] | 榜单订阅（本页） |
| :--- | :--- | :--- |
| 数据源 | 外部资源集合 UUID / 主页 | 豆瓣 / TMDB / Bangumi 榜单 |
| 产物 | 天翼分享资源 → 转存任务 | 自动追剧任务，可选 PT 订阅 |
| 存储 | SQLite 实体 | `config.json` 数组 |

---

## 使用建议

- 先小 limit、长 cron 试跑，确认不会刷爆 CloudSaver / PT。
- 动漫向榜单更适合开 `fallbackToPt`；电影向优先保证 CloudSaver 与影巢可用。
