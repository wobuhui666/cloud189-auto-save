import { defineConfig } from 'vitepress'

// 自定义域名已配置，base 为 '/'；若去掉自定义域名改用子路径部署，改为 '/cloud189-auto-save/'
const BASE = '/'
const SITE_URL = 'https://wiki.heihei.eu.org'
const REPO_URL = 'https://github.com/oceanxux/cloud189-auto-save'

/**
 * Vite 插件：把 GitHub Wiki 的 `[[PageName]]` / `[[PageName|Display]]`
 * 转成标准 markdown 链接 `[Display](/PageName)`。
 * Home → /，其他 → /PageName（cleanUrls 模式）。
 * 在 markdown 进入 vitepress markdown-it 之前完成转换，源文件不动。
 */
const wikiLinkTransform = {
  name: 'wiki-link-transform',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.endsWith('.md')) return null
    const out = code.replace(/\[\[([^\[\]]+)\]\]/g, (_match, raw: string) => {
      const [pageRaw, displayRaw] = raw.split('|')
      const page = pageRaw.trim()
      const display = (displayRaw ?? page).trim()
      const target = page === 'Home' ? '/' : `/${encodeURIComponent(page)}`
      return `[${display}](${target})`
    })
    return out === code ? null : out
  }
}

export default defineConfig({
  // GitHub Pages 子路径（自定义域名时为 '/'，无自定义域名改为 '/cloud189-auto-save/'）
  base: BASE,

  // 源 markdown 在仓库根的 wiki/ 目录
  srcDir: '../wiki',

  // 站点元信息
  lang: 'zh-CN',
  title: 'Cloud189 Auto Save',
  description: '天翼云盘自动转存系统 · 官方文档',

  // URL 不带 .html
  cleanUrls: true,

  // 显示最后修改时间（基于 git 历史）
  lastUpdated: true,

  // GitHub Wiki 约定文件不参与构建
  srcExclude: ['_Sidebar.md', '_Footer.md'],

  // Home.md 映射为站点首页
  rewrites: {
    'Home.md': 'index.md'
  },

  // 死链不阻塞构建（首次上线允许个别链接漏转换，先跑通）
  ignoreDeadLinks: true,

  // sitemap.xml 用自定义域名
  sitemap: {
    hostname: SITE_URL
  },

  // <head> 元数据
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#3eaf7c' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: SITE_URL }],
    ['meta', { property: 'og:title', content: 'Cloud189 Auto Save Wiki' }],
    ['meta', { property: 'og:description', content: '天翼云盘自动转存系统 · 官方文档' }]
  ],

  // 注入自定义 vite 插件（处理 wiki 链接）
  vite: {
    plugins: [wikiLinkTransform]
  },

  themeConfig: {
    siteTitle: 'Cloud189 Auto Save',

    // 顶部导航
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/Setup' },
      { text: '功能', link: '/Features' },
      { text: 'FAQ', link: '/FAQ' },
      { text: 'GitHub', link: REPO_URL }
    ],

    // 侧边栏（对照 wiki/_Sidebar.md 手动维护）
    sidebar: [
      {
        text: '入门指南',
        collapsed: false,
        items: [
          { text: '介绍', link: '/' },
          { text: '安装与配置', link: '/Setup' }
        ]
      },
      {
        text: '核心功能',
        collapsed: false,
        items: [
          { text: '功能深度解析', link: '/Features' },
          { text: '自动追剧', link: '/AutoSeries' },
          { text: 'CAS 秒传', link: '/CAS' },
          { text: '整理器', link: '/Organizer' },
          { text: '订阅', link: '/Subscription' },
          { text: 'PT 订阅', link: '/PT' }
        ]
      },
      {
        text: '媒体中心',
        collapsed: false,
        items: [
          { text: 'Emby / Jellyfin / Plex', link: '/Emby' },
          { text: 'STRM 指南', link: '/StrmGuide' },
          { text: 'Alist 集成', link: '/Alist' }
        ]
      },
      {
        text: '系统配置',
        collapsed: false,
        items: [
          { text: '媒体设置', link: '/MediaSettings' },
          { text: '系统设置', link: '/SystemSettings' }
        ]
      },
      {
        text: '开发者与扩展',
        collapsed: false,
        items: [
          { text: 'Telegram Bot', link: '/Bot' },
          { text: 'REST API', link: '/API' },
          { text: '正则与 AI 重命名', link: '/Regex' }
        ]
      },
      {
        text: '其他',
        collapsed: false,
        items: [
          { text: 'CloudSaver', link: '/CloudSaver' },
          { text: '常见问题', link: '/FAQ' },
          { text: '系统设计', link: '/SystemDesign' }
        ]
      }
    ],

    // 仓库链接
    socialLinks: [
      { icon: 'github', link: REPO_URL }
    ],

    // 编辑此页（链接到 GitHub 仓库的 wiki/ 目录）
    editLink: {
      pattern: ({ filePath }) => {
        // filePath 是相对 srcDir 的路径，srcDir 是 ../wiki
        // index.md 实际对应 wiki/Home.md
        const realPath = filePath === 'index.md' ? 'Home.md' : filePath
        return `${REPO_URL}/edit/master/wiki/${realPath}`
      },
      text: '在 GitHub 上编辑此页'
    },

    // 页脚
    footer: {
      message: '基于 MIT 许可发布',
      copyright: 'Copyright © Cloud189 Auto Save'
    },

    // 文档大纲
    outline: {
      level: [2, 3],
      label: '本页目录'
    },

    // 中文界面文案
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },
    lastUpdatedText: '最后更新于',
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',

    // 本地全文搜索
    search: {
      provider: 'local',
      options: {
        locales: {
          root: {
            translations: {
              button: {
                buttonText: '搜索文档',
                buttonAriaLabel: '搜索文档'
              },
              modal: {
                displayDetails: '显示详细列表',
                resetButtonTitle: '重置搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有结果',
                footer: {
                  selectText: '选择',
                  selectKeyAriaLabel: '输入',
                  navigateText: '导航',
                  navigateUpKeyAriaLabel: '上箭头',
                  navigateDownKeyAriaLabel: '下箭头',
                  closeText: '关闭',
                  closeKeyAriaLabel: 'esc'
                }
              }
            }
          }
        }
      }
    }
  }
})
