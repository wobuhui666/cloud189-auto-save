# PT 订阅

PT（Private Tracker）订阅功能支持从动漫资源站自动拉取 RSS、下载、秒传到天翼云盘，并生成 STRM 文件供媒体服务器播放。

---

## 1. 功能概述

PT 订阅系统支持：

- **多站点支持**：AniBT、Mikan（蜜柑计划）、AnimeGarden、Nyaa、动漫花园。
- **站点搜索**：直接在系统内搜索番剧，自动获取字幕组 RSS。
- **自动下载**：通过 qBittorrent 自动下载资源。
- **秒传上传**：下载完成后自动秒传到天翼云盘。
- **STRM 生成**：自动生成 STRM 文件，支持文件名和目录整理。
- **状态管理**：完整的 release 生命周期管理（排队→下载→上传→完成）。

---

## 2. 前置准备

### 2.1 qBittorrent 配置

1. 安装并启动 qBittorrent，开启 WebUI。
2. 在 **PT 设置** 中填写：
   - WebUI 地址（如 `http://192.168.1.10:8080`）
   - 用户名和密码
3. 点击 **测试连接** 确认可用。

### 2.2 下载目录

在 **PT 设置** 中配置 **下载根目录**，这是 qBittorrent 下载文件的容器内路径（如 `/downloads/pt`）。

### 2.3 天翼云盘账号

确保已添加天翼云盘账号，并配置好目标文件夹。

---

## 3. 添加 PT 订阅

进入 **PT** 页，点击 **添加 PT 订阅**。

### 3.1 基础字段

| 字段 | 说明 |
| :--- | :--- |
| 订阅名称 | 自定义名称，如"间谍过家家" |
| RSS 来源 | 选择站点预设（AniBT、Mikan 等） |
| RSS URL | 资源的 RSS 地址 |
| 包含正则 | 只下载匹配的资源（如 `1080p\|2160p`） |
| 排除正则 | 排除匹配的资源（如 `cam\|ts.x264`） |
| 天翼云盘账号 | 选择上传目标账号 |
| 目标目录 | 选择云盘中的目标文件夹 |
| 启用此订阅 | 是否启用自动拉取 |

### 3.2 搜索功能

点击 **搜索** 按钮可以直接搜索番剧：

1. 输入番剧名称（支持中英文）
2. 从搜索结果中选择番剧
3. 选择字幕组（或"全部资源"）
4. 系统自动填充 RSS URL 和订阅名称

**支持的站点搜索**：

| 站点 | 搜索范围 | 说明 |
| :--- | :--- | :--- |
| AniBT | 2024春~当前季度 | 支持按季度搜索 |
| Mikan | 全站 | 需要番剧页面 URL |
| AnimeGarden | 全站 | 基于 Bangumi ID |
| Nyaa | 全站 | RSS 搜索，支持字幕组筛选 |
| 动漫花园 | 全站 | RSS 搜索，支持字幕组筛选 |

---

## 4. PT 设置

点击 **PT 设置** 按钮配置全局参数。

### 4.1 下载客户端

| 字段 | 说明 |
| :--- | :--- |
| 类型 | 目前仅支持 qBittorrent |
| WebUI 地址 | qBittorrent WebUI 地址 |
| 用户名 | 登录用户名 |
| 密码 | 登录密码 |
| 分类前缀 | qb 中的分类前缀（默认 `pt-sub-`） |
| 标签前缀 | qb 中的标签前缀（默认 `pt-rel-`） |
| 允许自签 HTTPS | 跳过证书校验 |

### 4.2 下载与定时

| 字段 | 说明 |
| :--- | :--- |
| 下载根目录 | qBittorrent 下载路径（容器内） |
| RSS 拉取 cron | 检查 RSS 更新的频率（默认每 15 分钟） |
| 清理 cron | 清理已完成 release 的频率 |
| 自动清理 | 完成后自动删除 qb 任务和本地文件 |
| 自动删除源文件 | 生成 .cas 后删除本地源文件 |
| 自动生成 STRM | 上传完成后自动生成 STRM 文件 |

### 4.3 STRM 文件整理

启用后会对生成的 STRM 文件进行重命名和目录整理。

**整理模式**：

| 模式 | 说明 |
| :--- | :--- |
| 正则解析 | 轻量级方案，不依赖 AI，从标题解析季度和集数 |
| AI+TMDB | 依赖 AI 和 TMDB，自动识别番剧信息 |

**正则模式配置**：

| 字段 | 说明 | 默认值 |
| :--- | :--- | :--- |
| 分类目录名 | 根分类目录 | `动漫` |
| 文件名模板 | STRM 文件名格式 | `{title} S{season}E{episode}` |
| 季度提取正则 | 从标题提取季度 | 自动识别 S2、第二季 等 |
| 集数提取正则 | 从标题提取集数 | 自动识别 EP01、第5话 等 |
| 默认季度 | 无法识别时的默认值 | `1` |

**模板变量**：

| 变量 | 说明 | 示例 |
| :--- | :--- | :--- |
| `{title}` | 订阅名称 | 间谍过家家 |
| `{season}` | 季度（两位数） | 01 |
| `{episode}` | 集数（两位数） | 05 |
| `{subgroup}` | 字幕组名 | ANi |
| `{resolution}` | 分辨率 | 1080p |
| `{original}` | 原始文件名 | [ANi] SPY x FAMILY - 05.mkv |

**整理后的目录结构**：

```
{localStrmPrefix}/
  动漫/
    间谍过家家/
      Season 01/
        间谍过家家 S01E01.strm
        间谍过家家 S01E02.strm
        ...
      Season 02/
        间谍过家家 S02E01.strm
        ...
```

### 4.4 站点代理

如果站点访问需要代理，勾选对应站点，并在系统设置中配置代理服务器。

---

## 5. 订阅管理

### 5.1 订阅列表

| 字段 | 说明 |
| :--- | :--- |
| 名称 | 订阅名称 |
| 来源 | 站点预设和 RSS URL |
| 目标 | 云盘目标目录和 release 数量 |
| 状态 | 最近一次拉取结果 |
| 最后检查 | 最近一次检查时间 |

### 5.2 操作说明

| 操作 | 说明 |
| :--- | :--- |
| 查看 release | 查看该订阅的所有 release 记录 |
| 立即拉取 | 手动触发一次 RSS 拉取 |
| 启用/停用 | 控制订阅是否参与定时拉取 |
| 编辑 | 修改订阅配置 |
| 删除 | 删除订阅和相关 release 记录 |

---

## 6. Release 管理

### 6.1 状态流转

```
pending → downloading → downloaded → uploading → completed
                ↓                        ↓
             failed                   upload_failed
```

| 状态 | 说明 |
| :--- | :--- |
| pending | 排队中，等待投递到下载器 |
| downloading | 下载中 |
| downloaded | 下载完成，等待上传 |
| uploading | 秒传上传中 |
| completed | 上传完成 |
| failed | 下载失败 |
| upload_failed | 上传失败 |

### 6.2 Release 操作

| 操作 | 说明 |
| :--- | :--- |
| 重试 | 重新执行当前阶段（下载/上传） |
| 删除 | 删除 release 记录，同时删除 qb 任务和本地文件 |

---

## 7. 工作流程

### 7.1 自动流程

1. **定时轮询**（每 15 分钟）：
   - 拉取所有启用订阅的 RSS
   - 过滤新 release（去重 + 正则匹配）
   - 投递到 qBittorrent

2. **状态检查**（每 2 分钟）：
   - 查询 qb 中的下载进度
   - 下载完成的标记为 `downloaded`

3. **上传处理**（每 2 分钟）：
   - 对 `downloaded` 的 release 执行秒传
   - 计算文件哈希 → 秒传 → 失败则真传
   - 上传完成生成 .cas 和 .strm 文件

4. **清理**（每 6 小时）：
   - 删除已完成的 qb 任务和本地文件

### 7.2 手动流程

1. 添加订阅 → 搜索番剧 → 选择字幕组
2. 点击 **立即拉取**
3. 在 release 列表查看进度
4. 失败的 release 可以点击 **重试**

---

## 8. 配置文件

PT 相关配置存储在 `data/config.json` 的 `pt` 节点：

```json
{
  "pt": {
    "downloadRoot": "/downloads/pt",
    "pollCron": "*/15 * * * *",
    "cleanupEnabled": true,
    "cleanupCron": "0 */6 * * *",
    "retryIntervalSec": 300,
    "autoDeleteSource": true,
    "enableStrm": true,
    "strmOrganize": {
      "enabled": false,
      "mode": "regex",
      "categoryFolder": "动漫",
      "fileTemplate": "{title} S{season}E{episode}",
      "seasonRegex": "",
      "episodeRegex": "",
      "defaultSeason": 1
    },
    "downloader": {
      "type": "qbittorrent",
      "baseUrl": "http://192.168.1.10:8080",
      "username": "admin",
      "password": "******",
      "categoryPrefix": "pt-sub-",
      "tagPrefix": "pt-rel-",
      "insecureSkipTlsVerify": false
    }
  }
}
```

---

## 9. API 接口

### 订阅管理

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/pt/subscriptions` | 获取订阅列表 |
| POST | `/api/pt/subscriptions` | 创建订阅 |
| PUT | `/api/pt/subscriptions/:id` | 更新订阅 |
| DELETE | `/api/pt/subscriptions/:id` | 删除订阅 |
| POST | `/api/pt/subscriptions/:id/refresh` | 立即拉取 |
| GET | `/api/pt/subscriptions/:id/releases` | 获取 release 列表 |

### Release 管理

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/pt/releases/:id/retry` | 重试 release |
| DELETE | `/api/pt/releases/:id` | 删除 release |

### 搜索与配置

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/pt/sources/presets` | 获取站点预设列表 |
| GET | `/api/pt/sources/search` | 搜索番剧 |
| GET | `/api/pt/sources/groups` | 获取字幕组列表 |
| POST | `/api/pt/downloader/test` | 测试下载器连接 |

---

## 10. 常见问题

### Q: 搜索时提示"未找到字幕组"？

A: 部分番剧在站点上没有字幕组资源，会显示"全部资源"选项。选择后可订阅该番剧的所有资源。

### Q: 下载一直卡在 downloading？

A: 检查 qBittorrent 是否正常运行，种子是否有做种。部分冷门资源可能下载缓慢。

### Q: 秒传失败怎么办？

A: 秒传失败会自动降级为真传。如果真传也失败，可在 release 列表点击重试。

### Q: 如何修改 STRM 文件的目录结构？

A: 在 PT 设置中启用 STRM 整理，配置分类目录名和文件名模板。支持的模板变量见上方说明。
