# CAS 秒传

CAS 秒传通过文件名、大小、MD5 与分片 MD5 等特征信息在天翼云盘中恢复文件。命中云端已有文件时，系统无需重新上传文件数据即可创建文件副本。

---

## 1. 功能概述

CAS 秒传适合以下场景：

- 大文件快速恢复，减少上传等待。
- 用 `.cas` 存根保存文件特征信息。
- 在个人云和家庭云之间使用中转策略提升成功率。
- 配合懒 STRM，在播放触发转存时尝试秒传恢复。

如果 Hash 未命中，秒传恢复会失败，这是天翼云盘侧去重机制决定的结果。

---

## 2. CAS 存根格式

系统支持粘贴 Base64 或 JSON 格式的 CAS 内容。

### Base64 格式

```text
Base64 编码后的文件元数据
```

### JSON 格式

```json
{
  "name": "视频文件名.mkv",
  "size": 1234567890,
  "md5": "文件MD5哈希",
  "sliceMd5": "分片MD5"
}
```

常见 `.cas` 文件就是保存上述信息的秒传存根。

---

## 3. Web 端秒传恢复

进入 **秒传** 页，在 **秒传恢复** 区域操作：

1. 选择 **执行账号**。
2. 在 **存根内容 (Base64 或 JSON)** 中粘贴 CAS 内容。
3. 可选填写 **自定义文件名 (可选)**。
4. 点击 **存入目录**，选择目标目录。
5. 点击 **立即恢复**。

恢复成功后，系统会提示恢复出的文件名。

---

## 4. 秒传设置

进入 **媒体** 页，在 **秒传设置** 中配置：

| 配置项 | 说明 |
| :--- | :--- |
| 启用家庭中转 | 秒传时通过家庭云中转，适用于个人云被风控或黑名单的情况 |
| 优先使用家庭中转 | 默认先尝试家庭云秒传，失败后再回退个人云 |
| 恢复后删除 CAS 文件 | 恢复云端 `.cas` 存根成功后自动删除该存根文件 |
| 生成后删除源文件 | 生成 CAS 后自动删除源文件 |

秒传页右上角的设置按钮会跳转到媒体设置中的相关配置。

---

## 5. 家庭中转流程

启用家庭中转后，恢复流程大致为：

1. 先尝试在家庭云中秒传恢复。
2. 成功后再转存到目标位置。
3. 如果家庭中转失败，按配置回退到个人云恢复。
4. 根据配置决定是否删除 `.cas` 存根或源文件。

家庭中转适合用于提升部分资源的秒传成功率，但最终成功仍取决于天翼云盘接口和 Hash 命中情况。

---

## 6. API 接口

所有接口都需要带上系统 API Key：

```http
x-api-key: YOUR_API_KEY
```

### 6.1 粘贴 CAS 内容恢复

```http
POST /api/cas/restore
```

请求体示例：

```json
{
  "accountId": 1,
  "folderId": "目标文件夹ID",
  "casContent": "CAS存根内容",
  "fileName": "可选自定义文件名"
}
```

### 6.2 云端 CAS 文件恢复

```http
POST /api/cas/restore-file
```

请求体示例：

```json
{
  "accountId": 1,
  "folderId": "目标文件夹ID",
  "casFileId": "CAS文件ID",
  "casFileName": "xxx.cas"
}
```

### 6.3 生成单个文件 CAS

```http
POST /api/cas/create
```

请求体示例：

```json
{
  "accountId": 1,
  "fileId": "文件ID",
  "parentId": "父目录ID"
}
```

### 6.4 批量生成或导出

| 接口 | 说明 |
| :--- | :--- |
| `POST /api/cas/generate-folder-files` | 批量生成 CAS 文件到云端 |
| `POST /api/cas/export-folder-to-cloud` | 将文件夹内媒体文件导出为云端 CAS 文件 |
| `POST /api/cas/export-folder` | 导出文件夹 CAS 信息 |

### 6.5 自动恢复相关接口

后端提供自动恢复配置和扫描接口：

| 接口 | 说明 |
| :--- | :--- |
| `GET /api/cas/auto-restart-config` | 获取 CAS 自动恢复与中转配置 |
| `POST /api/cas/auto-restart-config` | 保存 CAS 自动恢复与中转配置 |
| `POST /api/cas/trigger-scan` | 手动触发 CAS 扫描 |
| `GET /api/cas/monitor-status` | 查看 CAS 监控状态 |

### 6.6 存根包导入（.cas / zip）

在 **秒传** 页的 **存根导入** 区域，可上传单个 `.cas` 或包含 `.cas` 目录树的 zip 包（例如整季剧集）。系统会解析存根、按相对路径镜像到目标网盘目录，并可选生成正常 / 懒 STRM。

| 接口 | 说明 |
| :--- | :--- |
| `POST /api/cas/import` | multipart 上传 `.cas`/`.zip`，创建导入任务（异步执行） |
| `GET /api/cas/import/jobs` | 导入任务列表 |
| `GET /api/cas/import/jobs/:id` | 任务详情（含每文件结果） |
| `POST /api/cas/import/jobs/:id/retry` | 重试失败项 |
| `DELETE /api/cas/import/jobs/:id` | 删除任务；`?deleteStrm=1` 同时删除 STRM |
| `GET /api/cas/import/strm` | 浏览导入 STRM 目录 |
| `DELETE /api/cas/import/strm` | 删除导入相关 STRM 目录 |
| `GET /api/cas/metadata/share` | 列出分享懒 STRM 的 cas-metadata 缓存 |
| `DELETE /api/cas/metadata/share` | 清理分享 cas-metadata 缓存 |

`POST /api/cas/import` 表单字段：

| 字段 | 说明 |
| :--- | :--- |
| `file` | `.cas` 或 `.zip` 文件 |
| `accountId` | 执行账号 |
| `folderId` | 网盘目标目录 |
| `mode` | `restore`（立即秒传）或 `lazy`（播放时再秒传） |
| `strmMode` | `none` / `normal` / `lazy` |
| `uploadCasStub` | 是否同时上传 `.cas` 到网盘同目录 |
| `overwriteStrm` | 是否覆盖已有 STRM |
| `title` | 可选任务标题 |
| `organizeMode` | `library`（默认，媒体库归档）或 `mirror`（镜像 zip） |

导入后的 STRM 落点：

```text
# organizeMode=library（默认）
{账号 localStrmPrefix}/{分类}/{作品名 (年)}/Season XX/...

# organizeMode=mirror
{账号 localStrmPrefix}/CAS导入/{标题}/...
```

懒 STRM 使用播放令牌类型 `casLazy`，元数据缓存在 `data/cas-metadata/import/{accountId}/{importId}/`。

当前 Web 的 **秒传** 页提供：粘贴恢复、存根包导入、导入任务管理、导入 STRM 浏览，以及分享懒 STRM 缓存清理。

---

## 使用建议

- 大文件优先尝试 CAS 秒传，小文件直接转存通常更简单。
- 重要资源建议同时保留原分享链接和 `.cas` 存根。
- 如果频繁失败，优先确认存根内容是否完整、目标账号是否可用，以及 Hash 是否可能已失效。
- 批量导入 zip 时优先用「立即还原 + 正常 STRM」做实体入库；仅想先挂媒体库再按需恢复时用「懒还原 + 懒 STRM」。
