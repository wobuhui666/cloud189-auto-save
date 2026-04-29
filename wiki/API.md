# REST API 文档

Cloud189 Auto Save 提供一组面向自动化脚本和第三方工具的 REST API。本文档列出当前项目中较常用的接口分组和调用方式。

---

## 1. 认证要求

所有请求都需要在 Header 中带上系统 API Key：

```http
x-api-key: YOUR_SYSTEM_API_KEY
```

系统 API Key 可在 [[SystemSettings]] 中查看或重新生成。

---

## 2. 返回格式

接口统一返回 JSON：

```json
{
  "success": true,
  "data": {},
  "error": "若失败则为错误信息"
}
```

一般来说：

- `success: true` 表示请求成功。
- `data` 为返回结果。
- `success: false` 时，优先查看 `error` 字段。

---

## 3. 账号管理

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/accounts` | 获取账号列表 |
| POST | `/api/accounts` | 添加账号 |
| DELETE | `/api/accounts/:id` | 删除账号 |
| PUT | `/api/accounts/:id/alias` | 修改账号别名 |
| PUT | `/api/accounts/:id/strm-prefix` | 修改云端/本地路径前缀或 Emby 替换路径 |
| PUT | `/api/accounts/:id/default` | 设置默认账号 |
| DELETE | `/api/accounts/recycle` | 清空回收站 |

### `PUT /api/accounts/:id/strm-prefix`

请求体示例：

```json
{
  "strmPrefix": "/home/strm",
  "type": "local"
}
```

`type` 支持：

- `cloud`：云端媒体目录前缀
- `local`：本地目录前缀
- `emby`：Emby 替换路径

---

## 4. 任务管理

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/tasks` | 获取任务列表，可按状态和关键字过滤 |
| POST | `/api/tasks` | 创建任务 |
| POST | `/api/tasks/batch-create` | 批量创建任务 |
| PUT | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| POST | `/api/tasks/:id/execute` | 执行指定任务 |
| POST | `/api/tasks/executeAll` | 执行所有任务 |
| POST | `/api/tasks/strm` | 根据任务批量生成 STRM |
| PUT | `/api/tasks/batch/status` | 批量修改任务状态 |
| DELETE | `/api/tasks/batch` | 批量删除任务 |
| DELETE | `/api/tasks/files` | 批量删除任务相关文件 |

---

## 5. 文件管理

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/file-manager/list` | 列出目录内容 |
| POST | `/api/file-manager/folder` | 新建目录 |
| POST | `/api/file-manager/rename` | 重命名文件或目录 |
| POST | `/api/file-manager/delete` | 删除文件或目录 |
| POST | `/api/file-manager/move` | 移动文件或目录 |
| GET | `/api/file-manager/download-link` | 获取文件直链 |

示例：

```http
GET /api/file-manager/list?accountId=1&folderId=-11
```

---

## 6. 自动追剧

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/auto-series/search` | 搜索自动追剧候选资源 |
| POST | `/api/auto-series` | 创建自动追剧任务 |

### 创建自动追剧示例

```json
{
  "title": "庆余年",
  "year": "2024",
  "mode": "lazy"
}
```

`mode` 支持：

- `normal`
- `lazy`

如果手动选择资源后创建，还可以附带：

```json
{
  "shareLink": "https://cloud.189.cn/...",
  "resourceTitle": "资源标题"
}
```

---

## 7. 订阅

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/subscriptions` | 获取订阅列表 |
| GET | `/api/subscriptions/preview` | 预览订阅创建信息 |
| GET | `/api/subscriptions/remote-resources` | 获取远程订阅资源 |
| POST | `/api/subscriptions/task-preview` | 预估自动创建任务结果 |
| POST | `/api/subscriptions` | 创建订阅 |
| PUT | `/api/subscriptions/:id` | 更新订阅 |
| POST | `/api/subscriptions/:id/refresh` | 刷新订阅 |
| DELETE | `/api/subscriptions/:id` | 删除订阅 |
| GET | `/api/subscriptions/:id/resources` | 获取订阅资源 |
| POST | `/api/subscriptions/:id/resources` | 添加订阅资源 |
| DELETE | `/api/subscriptions/resources/:id` | 删除订阅资源 |
| GET | `/api/subscriptions/resources/:id/browse` | 浏览订阅资源目录 |

---

## 8. STRM

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/strm/lazy-share/generate` | 根据分享链接生成懒转存 STRM |
| GET | `/api/strm/list` | 查看 STRM 文件列表 |
| GET | `/api/strm/configs` | 获取 STRM 配置列表 |
| POST | `/api/strm/configs` | 创建 STRM 配置 |
| PUT | `/api/strm/configs/:id` | 更新 STRM 配置 |
| DELETE | `/api/strm/configs/:id` | 删除 STRM 配置 |
| POST | `/api/strm/configs/:id/run` | 立即执行 STRM 配置 |
| POST | `/api/strm/configs/:id/reset` | 重置订阅型 STRM 配置的增量时间 |
| POST | `/api/strm/generate-all` | 为具备路径配置的账号批量生成 STRM |

---

## 9. CAS 秒传

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/cas/restore` | 通过 CAS 内容恢复文件 |
| POST | `/api/cas/restore-file` | 通过云端 `.cas` 文件恢复 |
| POST | `/api/cas/restore-and-play` | 临时恢复并返回播放地址 |
| GET | `/api/cas/auto-restart-config` | 获取 CAS 配置 |
| POST | `/api/cas/auto-restart-config` | 保存 CAS 配置 |
| POST | `/api/cas/trigger-scan` | 手动触发 CAS 扫描 |
| GET | `/api/cas/monitor-status` | 获取 CAS 监控状态 |
| POST | `/api/cas/batch-cleanup` | 批量清理 CAS 文件 |
| POST | `/api/cas/create` | 生成单个文件的 CAS 内容 |
| POST | `/api/cas/generate-folder-files` | 批量生成云端 CAS 文件 |
| POST | `/api/cas/export-folder-to-cloud` | 将文件夹导出为云端 CAS 文件 |
| POST | `/api/cas/export-folder` | 导出文件夹 CAS 信息 |

---

## 10. 系统与媒体设置

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/settings` | 获取系统设置 |
| POST | `/api/settings` | 保存系统设置 |
| POST | `/api/settings/telegram/test` | 测试 Telegram 配置 |
| POST | `/api/settings/media` | 保存媒体设置 |
| GET | `/api/settings/regex-presets` | 获取正则预设 |
| POST | `/api/settings/regex-presets` | 保存正则预设 |

---

## 11. CloudSaver

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/cloudsaver/search` | 搜索 CloudSaver 资源 |

示例：

```http
GET /api/cloudsaver/search?keyword=庆余年
```

---

## 12. 其他常用接口

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/folders/:accountId` | 获取目录树 |
| POST | `/api/share/parse` | 解析分享链接 |
| GET | `/api/tmdb/search` | 搜索 TMDB 信息 |
| GET | `/api/version` | 获取当前版本 |
| GET | `/api/folder/files` | 获取任务相关目录文件列表 |

---

## 调用建议

- 先用 `/api/settings` 和 `/api/accounts` 校验系统基础状态，再调用任务、STRM 或 CAS 相关接口。
- 对于会触发真实转存、删除、移动的接口，建议先在 Web 端确认参数，再接入自动化脚本。
- 如果接口返回失败，优先查看 `error`，再结合实时日志定位问题。
