# Cloud189 Auto Save Wiki 站点

本目录是 Wiki 站点工程，基于 [VitePress](https://vitepress.dev/) 构建，通过 [GitHub Actions](.github/workflows/deploy-wiki.yml) 自动部署到 [GitHub Pages](https://pages.github.com/)。

## 目录结构

```
docs-site/
├─ public/
│  └─ CNAME              # 自定义域名 wiki.heihei.eu.org
├─ .vitepress/
│  └─ config.ts          # 站点配置（sidebar/nav/search/插件）
├─ package.json
├─ .gitignore
└─ README.md
```

- 源 Markdown 文档：`../wiki/`（仓库根的 wiki 目录，**不要在本目录里放文档**）
- 部署工作流：`../.github/workflows/deploy-wiki.yml`

## 本地开发

```bash
cd docs-site
npm install
npm run dev          # 启动开发服务器，默认 http://localhost:5173
```

修改 `../wiki/*.md` 后会自动热更新。

## 本地构建

```bash
npm run build        # 构建静态产物到 .vitepress/dist
npm run preview      # 预览构建产物
```

## GitHub Pages 部署

### 自动部署（已配置）

每次 push 到 `master` 且 `wiki/` 或 `docs-site/` 目录有变更时，GitHub Actions 自动构建并部署。

### 仓库设置（仅一次性）

在 GitHub 仓库 → Settings → Pages：
1. **Source** 选择 **GitHub Actions**
2. **Custom domain** 填入 `wiki.heihei.eu.org`
3. 勾选 **Enforce HTTPS**

### 自定义域名

`docs-site/public/CNAME` 文件已配置 `wiki.heihei.eu.org`，构建时会自动复制到产物根目录。

DNS 配置（在 Cloudflare）：
- 添加 CNAME 记录：`wiki` → `oceanxux.github.io`
- 开启代理（橙色云朵）可加速访问

### 无自定义域名时

如果不用自定义域名，需要：
1. 删除 `docs-site/public/CNAME`
2. 修改 `config.ts` 中 `BASE` 为 `'/cloud189-auto-save/'`
3. 站点地址变为 `https://oceanxux.github.io/cloud189-auto-save/`

## 添加新文档

1. 在 `../wiki/` 下新建 `NewPage.md`
2. 在 `.vitepress/config.ts` 的 `themeConfig.sidebar` 对应分组加一项
3. push 到 master，GitHub Actions 自动重新部署

## Wiki 链接语法

源文档使用 GitHub Wiki 风格的 `[[PageName]]` 链接，构建时由 `.vitepress/config.ts` 中的 `wiki-link-transform` Vite 插件自动转换为标准 markdown 链接，源文件保持原样以便同时在 GitHub 仓库内浏览。
