<div align="center">
    <img src="img/cloud189.png" alt="Logo" width="160">
    <h1>Cloud189 Auto Save</h1>
    <p><strong>天翼云盘全自动转存与媒体管理系统</strong></p>
    <p>自动化监控更新、智能重命名、STRM 生成、Emby/Jellyfin 完美联动</p>
    <p align="center">
        <a href="https://github.com/wobuhui666/cloud189-auto-save/releases/latest">
            <img src="https://img.shields.io/github/v/release/wobuhui666/cloud189-auto-save?style=flat-square&color=blue" alt="GitHub release">
        </a>
        <a href="https://github.com/wobuhui666/cloud189-auto-save/pkgs/container/cloud189-auto-save">
            <img src="https://img.shields.io/badge/ghcr.io-wobuhui666-blue?style=flat-square&logo=github" alt="GHCR">
        </a>
        <a href="https://github.com/wobuhui666/cloud189-auto-save/stargazers">
            <img src="https://img.shields.io/github/stars/wobuhui666/cloud189-auto-save?style=flat-square" alt="GitHub Stars">
        </a>
        <a href="https://github.com/wobuhui666/cloud189-auto-save/blob/main/LICENSE">
            <img src="https://img.shields.io/github/license/wobuhui666/cloud189-auto-save?style=flat-square" alt="License">
        </a>
    </p>
</div>

---
本项目仅供学习交流，请勿用于非法用途。开发者不对任何资源内容负责。
精力有限，更新速度可能不是很快，敬请谅解。
问题反馈与功能请求，请提交 [Issues](https://github.com/wobuhui666/cloud189-auto-save/issues) 

## 核心亮点

**Cloud189 Auto Save** 是一款专为影音爱好者打造的天翼云盘辅助工具。它能够自动监控分享链接的更新并转存到您的网盘，同时生成 `.strm` 文件，让您的本地媒体服务器（如 Emby, Jellyfin, Plex）像播放本地文件一样播放云端资源。

推荐使用修改过的cloudsaver https://github.com/wobuhui666/CloudSaver 支持搜索雷鲸小站和云巢的资源

### 自动化与智能
- **全自动转存**：支持 Cron 定时规则，自动检查分享链接更新并执行转存。
- **智能重命名**：支持正则表达式与 AI 辅助（OpenAI/智谱等），自动识别并美化文件名。
- **追更系统**：自动识别剧集更新，智能匹配集数，支持全自动刮削媒体信息。
- **媒体中心联动**：支持自动刷新 Emby/Jellyfin 媒体库，发送入库通知。

### 极致媒体体验
- **STRM 矩阵**：
  - **实时生成**：任务更新后秒级生成 `.strm`。
  - **Lazy STRM**：无需提前转存，播放时自动触发转存并返回最新直链。支持cas秒传
  - **Alist 联动**：支持根据 Alist 全量生成 STRM 结构。
- **高性能代理**：内置流媒体代理，解决临时直链过期问题，支持反向代理部署。

### 多端管理与通知
- **Web 控制台**：直观的 Web 管理界面，支持暗黑模式，多用户权限管理。
- **Telegram Bot**：全功能机器人，支持远程搜资源、加任务、查进度、收推送。
- **全平台通知**：支持企业微信、Telegram、Bark、WxPusher 等多种推送渠道。

---

## 快速部署

### 🐳 使用 Docker (推荐)

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

> **注意**：
> 1. 请将 `/opt/cloud189` 替换为您宿主机的实际目录。
> 2. `8097` 端口用于 Emby/Jellyfin 的独立流代理（可选）。
> 3. 初始账号密码为 `admin` / `admin`。

### 安全提示
- **私有化部署**：严禁将服务无保护暴露于公网。
- **信息保护**：本项目涉及账号 Cookie 等敏感信息，请务必开启登录密码保护并使用反向代理（HTTPS）。

---

## 详细指南

请查看项目内置文档以获取更多深度使用教程：

- [🚀 安装与配置](./doc/setup.md) - 详细的环境变量与基础设置。
- [🔑 账号管理](./doc/setup.md#账号配置) - 如何安全地获取 Cookie 登录。
- [📺 媒体中心配置](./doc/features.md#媒体中心联动) - Emby/Jellyfin 的路径替换与通知。
- [🤖 Telegram 机器人](./doc/bot.md) - 机器人功能详解与指令列表。
- [🔌 API 文档](./doc/api.md) - 为开发者提供的 REST 接口参考。

---

## 社区与支持

- **问题反馈**：请提交 [Issues](https://github.com/wobuhui666/cloud189-auto-save/issues)

---

## ❤️
 贡献与致谢

如果这个项目帮到了你，请给一个 ⭐️ **Star** 以示支持！

- 感谢所有贡献者与用户提供的宝贵建议。
- 感谢 Claude Codex GeminiCLI
- [oceanxux/cloud189-auto-save](https://github.com/oceanxux/cloud189-auto-save)
- [原版项目](https://github.com/1307super/cloud189-auto-save)
- [my-cloud189-auto-save](https://github.com/ymting/my-cloud189-auto-save)
- [OpenList](https://github.com/OpenListTeam/OpenList) - 家庭转存参考实现
- [OpenList-CAS](https://github.com/GitYuA/OpenList-CAS) - CAS 功能参考
---

**Disclaimer**: 本项目仅供学习交流，请勿用于非法用途。开发者不对任何资源内容负责。
