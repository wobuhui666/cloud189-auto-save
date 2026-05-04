const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
const ProxyUtil = require('../utils/ProxyUtil');
const {
    decodeHtmlEntities,
    extractInfoHashFromMagnet,
    extractUrlCandidates,
    matchReleaseTitle,
    normalizeWhitespace,
    resolveUrl,
    safeFileName,
    stripHtml
} = require('./ptUtils');

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const PRESETS = {
    generic: {
        key: 'generic',
        label: '通用 RSS',
        description: '适合任何返回 RSS/Atom 的 PT 或资源站',
        defaultRssUrl: ''
    },
    nyaa: {
        key: 'nyaa',
        label: 'Nyaa',
        description: '默认使用 Nyaa 全站 RSS，可自行替换筛选后的 RSS URL',
        defaultRssUrl: 'https://nyaa.si/?page=rss'
    },
    dmhy: {
        key: 'dmhy',
        label: '动漫花园',
        description: '默认使用动漫花园公开 RSS，若你有自定义筛选或授权 RSS 也可直接替换',
        defaultRssUrl: 'https://share.dmhy.org/topics/rss/rss.xml'
    },
    mikan: {
        key: 'mikan',
        label: '蜜柑计划',
        description: '从 mikanani.me 获取订阅 RSS，需在站点上复制对应番剧的 RSS 链接',
        defaultRssUrl: 'https://mikanani.me/RSS/Bangumi'
    },
    anibt: {
        key: 'anibt',
        label: 'AniBT',
        description: '从 anibt.net 获取订阅 RSS，需填入 bgmId 和字幕组 slug',
        defaultRssUrl: 'https://anibt.net/rss/anime.xml'
    },
    animegarden: {
        key: 'animegarden',
        label: 'AnimeGarden',
        description: '从 api.animes.garden 获取订阅 RSS，支持按番剧和字幕组筛选',
        defaultRssUrl: 'https://api.animes.garden/feed.xml'
    }
};

class PtSourceService {
    getPresets() {
        return Object.values(PRESETS);
    }

    getPreset(presetKey = 'generic') {
        return PRESETS[presetKey] || PRESETS.generic;
    }

    resolveFeedUrl(sourcePreset = 'generic', rssUrl = '') {
        const preset = this.getPreset(sourcePreset);
        return String(rssUrl || preset.defaultRssUrl || '').trim();
    }

    async fetchFeedItems(subscription = {}) {
        const rssUrl = this.resolveFeedUrl(subscription.sourcePreset, subscription.rssUrl);
        if (!rssUrl) {
            throw new Error('RSS 地址不能为空');
        }

        const proxyService = this._getProxyService(subscription.sourcePreset || 'generic');
        const proxyAgent = proxyService ? ProxyUtil.getProxyAgent(proxyService) : {};

        const response = await got(rssUrl, {
            method: 'GET',
            responseType: 'text',
            headers: DEFAULT_HEADERS,
            timeout: { request: 30000 },
            retry: { limit: 1 },
            ...proxyAgent
        });

        const items = this.parseFeedItems(response.body, rssUrl)
            .filter((item) => item.title)
            .filter((item) => matchReleaseTitle(item.title, subscription.includePattern, subscription.excludePattern));

        return items;
    }

    parseFeedItems(feedXml = '', baseUrl = '') {
        const xml = String(feedXml || '').trim();
        if (!xml) {
            return [];
        }

        const itemBlocks = [
            ...this._extractBlocks(xml, 'item'),
            ...this._extractBlocks(xml, 'entry')
        ];
        const seenGuids = new Set();
        const result = [];
        for (const block of itemBlocks) {
            const item = this._parseItemBlock(block, baseUrl);
            if (!item) {
                continue;
            }
            const guidKey = `${item.guid}::${item.infoHash}`;
            if (seenGuids.has(guidKey)) {
                continue;
            }
            seenGuids.add(guidKey);
            result.push(item);
        }
        return result;
    }

    _extractBlocks(xml = '', tagName = 'item') {
        const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`, 'gi');
        return String(xml || '').match(pattern) || [];
    }

    _parseItemBlock(block = '', baseUrl = '') {
        const rawTitle = this._getFirstTagText(block, ['title']);
        const title = safeFileName(normalizeWhitespace(rawTitle), '');
        if (!title) {
            return null;
        }

        const description = this._getFirstTagText(block, ['description', 'summary', 'content', 'content:encoded']);
        const guid = normalizeWhitespace(
            this._getFirstTagText(block, ['guid', 'id'])
            || ''
        );
        const infoHashTag = normalizeWhitespace(this._getFirstTagText(block, ['infoHash', 'nyaa:infoHash', 'torrent:infohash']));
        const publishedRaw = this._getFirstTagText(block, ['pubDate', 'published', 'updated']);
        const linkCandidates = this._collectLinkCandidates(block, description, baseUrl);
        // torrent:magneturi 自定义标签（AniBT 等站点使用）
        const torrentMagnet = normalizeWhitespace(this._getFirstTagText(block, ['torrent:magneturi']));
        if (torrentMagnet && /^magnet:/i.test(torrentMagnet)) {
            linkCandidates.push(torrentMagnet);
        }
        const magnetUrl = linkCandidates.find((link) => /^magnet:/i.test(link)) || '';
        const torrentUrl = linkCandidates.find((link) => this._looksLikeTorrentUrl(link)) || '';
        const detailsUrl = linkCandidates.find((link) => /^https?:/i.test(link) && !this._looksLikeTorrentUrl(link)) || '';
        const infoHash = infoHashTag || extractInfoHashFromMagnet(magnetUrl);

        const normalizedGuid = guid
            || infoHash
            || magnetUrl
            || torrentUrl
            || detailsUrl
            || title;

        return {
            guid: normalizedGuid,
            title,
            description: stripHtml(description),
            magnetUrl,
            torrentUrl,
            detailsUrl,
            infoHash,
            publishedAt: this._parseDate(publishedRaw),
            rawPublishedAt: normalizeWhitespace(publishedRaw),
            sourceLinks: linkCandidates
        };
    }

    _collectLinkCandidates(block = '', description = '', baseUrl = '') {
        const links = [];
        const linkText = this._getFirstTagText(block, ['link']);
        if (linkText) {
            links.push(resolveUrl(baseUrl, decodeHtmlEntities(linkText)));
        }

        const atomLinkPattern = /<link\b([^>]*?)\/?>/gi;
        let atomMatch = null;
        while ((atomMatch = atomLinkPattern.exec(block)) !== null) {
            const attrs = atomMatch[1] || '';
            const href = this._readAttribute(attrs, 'href');
            const rel = String(this._readAttribute(attrs, 'rel') || '').toLowerCase();
            const type = String(this._readAttribute(attrs, 'type') || '').toLowerCase();
            if (!href) {
                continue;
            }
            const resolved = resolveUrl(baseUrl, decodeHtmlEntities(href));
            if (!resolved) {
                continue;
            }
            links.push(resolved);
            if (rel === 'enclosure' || type.includes('torrent')) {
                links.push(resolved);
            }
        }

        // <enclosure> 标签（Mikan 等站点使用）
        const enclosurePattern = /<enclosure\b([^>]*?)\/?>/gi;
        let encMatch = null;
        while ((encMatch = enclosurePattern.exec(block)) !== null) {
            const attrs = encMatch[1] || '';
            const url = this._readAttribute(attrs, 'url');
            if (url) {
                const resolved = resolveUrl(baseUrl, decodeHtmlEntities(url));
                if (resolved) links.push(resolved);
            }
        }

        links.push(...extractUrlCandidates(description, baseUrl));
        return [...new Set(links.filter(Boolean))];
    }

    _looksLikeTorrentUrl(url = '') {
        const normalized = String(url || '').toLowerCase();
        return normalized.endsWith('.torrent')
            || normalized.includes('/download.php')
            || normalized.includes('/download/')
            || normalized.includes('download?')
            || normalized.includes('torrent/download');
    }

    _getFirstTagText(block = '', tagNames = []) {
        for (const tagName of tagNames) {
            const pattern = new RegExp(`<${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^>]*>([\\s\\S]*?)<\\/${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'i');
            const match = String(block || '').match(pattern);
            if (match && match[1] != null) {
                return stripHtml(match[1]);
            }
        }
        return '';
    }

    _readAttribute(attrs = '', attrName = '') {
        const pattern = new RegExp(`${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
        const match = String(attrs || '').match(pattern);
        return match ? match[1] : '';
    }

    _parseDate(value = '') {
        const normalized = String(value || '').trim();
        if (!normalized) {
            return null;
        }
        const date = new Date(normalized);
        if (Number.isNaN(date.getTime())) {
            logTaskEvent(`[PT] 无法解析发布时间: ${normalized}`);
            return null;
        }
        return date;
    }

    // ==================== 搜索 ====================

    async searchSource(preset, keyword, options = {}) {
        const signal = options.signal || null;
        switch (preset) {
            case 'mikan': return this._searchMikan(keyword, signal);
            case 'anibt': return this._searchAniBT(keyword, signal);
            case 'animegarden': return this._searchAnimeGarden(keyword, signal);
            case 'nyaa': return this._searchNyaa(keyword, signal);
            case 'dmhy': return this._searchDmhy(keyword, signal);
            default:
                throw new Error(`预设 ${preset} 不支持搜索`);
        }
    }

    async getGroups(preset, params) {
        switch (preset) {
            case 'mikan': return this._getMikanGroups(params.bangumiUrl || params.bangumiId || params.bgmId);
            case 'anibt': return this._getAniBTGroups(params.bgmId || params.bangumiId);
            case 'animegarden': return this._getAnimeGardenGroups(params.bgmId || params.bangumiId || params.subjectId);
            default:
                throw new Error(`预设 ${preset} 不支持获取字幕组`);
        }
    }

    async getGroupItems(rssUrl, preset) {
        const proxyService = this._getProxyService(preset || 'generic');
        const feedXml = await this._fetch(rssUrl, proxyService);
        const items = this.parseFeedItems(feedXml, rssUrl);
        return items.slice(0, 50).map(item => ({
            title: item.title,
            publishedAt: item.publishedAt || null
        }));
    }

    _getProxyService(preset) {
        const map = { mikan: 'ptMikan', anibt: 'ptAnibt', animegarden: 'ptAnimegarden', nyaa: 'ptNyaa', dmhy: 'ptDmhy' };
        return map[preset] || '';
    }

    // --- Mikan (HTML 爬取) ---

    async _searchMikan(keyword, externalSignal = null) {
        const MIRRORS = ['https://mikan.tangbai.cc', 'https://mikanani.me'];
        const searchPath = `/Home/Search?searchstr=${encodeURIComponent(keyword)}`;

        // 尝试多个镜像，流式读取前 60KB 足以覆盖搜索结果
        let html = '';
        let host = MIRRORS[0];
        for (const mirror of MIRRORS) {
            if (externalSignal?.aborted) throw new Error('请求已取消');
            try {
                html = await this._streamFetch(mirror + searchPath, 60000, 20000, 'ptMikan', externalSignal);
                if (html) { host = mirror; break; }
            } catch (e) {
                if (externalSignal?.aborted) throw e;
                /* 镜像超时，尝试下一个 */
            }
        }
        if (!html) return [];
        const results = [];

        // 搜索结果页：ul.an-ul > li > a[href=/Home/Bangumi/{id}]
        const itemPattern = /<li\b[^>]*>\s*<a\b[^>]*href="([^"]*\/Home\/Bangumi\/(\d+))"[^>]*>\s*<span\b[^>]*data-src="([^"]*)"[^>]*>[\s\S]*?<div\b[^>]*class="an-text"[^>]*>([\s\S]*?)<\/div>/gi;
        let match;
        while ((match = itemPattern.exec(html)) !== null) {
            const cover = match[3] || '';
            results.push({
                id: match[2],
                title: decodeHtmlEntities(stripHtml(match[4]).trim()),
                cover: cover.startsWith('http') ? cover : (cover ? host + cover : ''),
                url: match[1].startsWith('http') ? match[1] : host + match[1],
                source: 'mikan'
            });
        }

        // 备用：简化解析（兼容相对路径与绝对 URL）
        if (!results.length) {
            const linkPattern = /<a\b[^>]*href="([^"]*\/Home\/Bangumi\/(\d+))"[^>]*>/gi;
            const titlePattern = /<div\b[^>]*class="an-text"[^>]*>([\s\S]*?)<\/div>/gi;
            const titles = [];
            let tm;
            while ((tm = titlePattern.exec(html)) !== null) {
                titles.push(decodeHtmlEntities(stripHtml(tm[1]).trim()));
            }
            let idx = 0;
            while ((match = linkPattern.exec(html)) !== null) {
                if (idx < titles.length) {
                    results.push({
                        id: match[2],
                        title: titles[idx],
                        cover: '',
                        url: match[1].startsWith('http') ? match[1] : host + match[1],
                        source: 'mikan'
                    });
                }
                idx++;
            }
        }

        return results;
    }

    // 流式读取：拿到足够数据或超时就返回，不等完整响应
    async _streamFetch(url, maxBytes = 60000, timeoutMs = 20000, proxyService = null, externalSignal = null) {
        const proxyAgent = proxyService ? ProxyUtil.getProxyAgent(proxyService) : {};
        const { signal, cleanup } = this._combineSignals(timeoutMs, externalSignal);
        try {
            const stream = got.stream(url, {
                method: 'GET',
                headers: DEFAULT_HEADERS,
                signal,
                retry: { limit: 0 },
                ...proxyAgent
            });
            const chunks = [];
            let total = 0;
            for await (const chunk of stream) {
                chunks.push(chunk);
                total += chunk.length;
                if (total >= maxBytes) { stream.destroy(); break; }
            }
            return Buffer.concat(chunks).toString('utf8');
        } catch (e) {
            const isAbort = e?.name === 'AbortError'
                || e?.code === 'ERR_ABORTED'
                || e?.code === 'ABORT_ERR'
                || e?.cause?.name === 'AbortError';
            if (isAbort) {
                if (externalSignal?.aborted) return '';
                // 流式自身超时不视作错误（按原行为返回空串）
                return '';
            }
            throw e;
        } finally {
            cleanup();
        }
    }

    async _getMikanGroups(bangumiUrlOrId) {
        const MIRRORS = ['https://mikan.tangbai.cc', 'https://mikanani.me'];
        let bangumiId = String(bangumiUrlOrId || '');
        const idMatch = bangumiId.match(/(\d+)\/?$/);
        if (idMatch) bangumiId = idMatch[1];
        const path = `/Home/Bangumi/${bangumiId}`;
        let html = '';
        let host = MIRRORS[0];
        for (const mirror of MIRRORS) {
            try {
                html = await this._fetch(mirror + path, 'ptMikan', 30000);
                if (html) { host = mirror; break; }
            } catch { /* 镜像超时，尝试下一个 */ }
        }
        if (!html) return [];

        // 1. 从 sidebar 提取字幕组名和 ID：<a class="subgroup-name subgroup-{id}">name</a>
        const nameMap = new Map(); // subgroupId → groupName
        const namePattern = /<a\b[^>]*class="[^"]*subgroup-name\s+subgroup-(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        let nm;
        while ((nm = namePattern.exec(html)) !== null) {
            nameMap.set(nm[1], decodeHtmlEntities(stripHtml(nm[2]).trim()));
        }

        // 2. 从页面正文提取 RSS 链接：<a href="/RSS/Bangumi?bangumiId=...&subgroupid={id}" class="mikan-rss">
        const rssPattern = /<a\b[^>]*href="([^"]*\/RSS\/Bangumi\?[^"]*subgroupid=(\d+)[^"]*)"[^>]*class="[^"]*mikan-rss[^"]*"/gi;
        const rssMap = new Map(); // subgroupId → rssUrl
        let rm;
        while ((rm = rssPattern.exec(html)) !== null) {
            const rssPath = rm[1];
            rssMap.set(rm[2], rssPath.startsWith('http') ? rssPath : host + rssPath);
        }

        // 3. 配对
        const groups = [];
        for (const [subgroupId, name] of nameMap) {
            groups.push({
                name,
                rssUrl: rssMap.get(subgroupId) || `${host}/RSS/Bangumi?bangumiId=${bangumiId}&subgroupid=${subgroupId}`,
                source: 'mikan'
            });
        }

        return groups;
    }

    // --- AniBT (JSON API) ---

    async _searchAniBT(keyword, externalSignal = null) {
        const host = 'https://site.anibt.net';
        // 先获取当前季度和可用季度列表
        const currentBody = await this._fetchJSON(`${host}/api/seasons/anime`, {}, 'ptAnibt', 45000, externalSignal);
        const availableSeasons = currentBody?.data?.availableSeasons || [];
        const currentSeason = currentBody?.data?.currentSeason || '';

        // 收集 anime（先吃掉首次响应的数据，避免重复请求）
        const seenIds = new Set();
        const allAnime = [];
        const collectFromBody = (body) => {
            for (const day of (body?.data?.byWeekday || [])) {
                for (const anime of (day.animes || [])) {
                    const id = anime.bgmId || anime.animeId;
                    if (id && !seenIds.has(id)) {
                        seenIds.add(id);
                        allAnime.push(anime);
                    }
                }
            }
        };
        // 首次响应（无 season 参数）的数据通常即为当前季度
        collectFromBody(currentBody);

        // 并发获取剩余季度（排除已通过首次响应取到的当前季度）
        const seasonsToSearch = availableSeasons.filter(s => s && s !== currentSeason);
        const fetchSeason = async (season) => {
            try {
                const body = await this._fetchJSON(`${host}/api/seasons/anime?season=${encodeURIComponent(season)}`, {}, 'ptAnibt', 45000, externalSignal);
                collectFromBody(body);
            } catch (e) {
                if (externalSignal?.aborted) throw e;
            }
        };
        await Promise.all(seasonsToSearch.map(fetchSeason));

        const results = [];
        for (const anime of allAnime) {
            const rawTitle = anime.title;
            const title = typeof rawTitle === 'object'
                ? (rawTitle.chinese || rawTitle.primary || rawTitle.english || '')
                : (rawTitle || anime.name || '');
            if (keyword && !title.toLowerCase().includes(keyword.toLowerCase())) continue;
            results.push({
                id: String(anime.bgmId || anime.animeId || ''),
                title,
                cover: anime.cover || '',
                url: anime.bgmId ? `https://bgm.tv/subject/${anime.bgmId}` : '',
                source: 'anibt'
            });
        }
        return results;
    }

    async _getAniBTGroups(bgmId) {
        const host = 'https://site.anibt.net';
        const url = `${host}/api/anime/groups`;
        const body = await this._fetchJSON(url, { bgmId: String(bgmId || '') }, 'ptAnibt');
        const groups = [];
        for (const g of (body?.data?.groups || [])) {
            const slug = g.slug || '';
            groups.push({
                name: g.name || g.title || slug,
                rssUrl: `https://anibt.net/rss/anime.xml?bgmId=${encodeURIComponent(bgmId)}&groupSlug=${encodeURIComponent(slug)}`,
                source: 'anibt'
            });
        }
        // 如果没有字幕组，添加一个"全部资源"选项
        if (groups.length === 0 && bgmId) {
            groups.push({
                name: '全部资源',
                rssUrl: `https://anibt.net/rss/anime.xml?bgmId=${encodeURIComponent(bgmId)}`,
                source: 'anibt'
            });
        }
        return groups;
    }

    // --- AnimeGarden (JSON API) ---

    async _searchAnimeGarden(keyword, externalSignal = null) {
        const host = 'https://api.animes.garden';
        const url = `${host}/subjects`;
        const body = await this._fetchJSON(url, null, 'ptAnimegarden', 45000, externalSignal);
        const subjects = body?.subjects || body?.data?.subjects || [];
        const kw = (keyword || '').toLowerCase();
        const results = [];
        for (const s of subjects) {
            const title = s.name || s.title || '';
            // 同时匹配 name 和 keywords 数组（支持中/日/英文搜索）
            const nameMatch = title.toLowerCase().includes(kw);
            const keywordMatch = Array.isArray(s.keywords) && s.keywords.some(k => String(k).toLowerCase().includes(kw));
            if (kw && !nameMatch && !keywordMatch) continue;
            results.push({
                id: String(s.id || ''),
                title,
                cover: '',
                url: s.id ? `https://bgm.tv/subject/${s.id}` : '',
                source: 'animegarden'
            });
        }
        return results;
    }

    async _getAnimeGardenGroups(subjectId) {
        const host = 'https://api.animes.garden';
        const url = `${host}/resources?subject=${encodeURIComponent(subjectId)}&pageSize=200&duplicate=false`;
        const body = await this._fetchJSON(url, null, 'ptAnimegarden');
        const resources = body?.resources || body?.data?.resources || [];
        const groupMap = new Map();
        for (const r of resources) {
            const fansub = r.fansub || r.group || {};
            const groupId = fansub.id || fansub.name || 'unknown';
            if (!groupMap.has(groupId)) {
                groupMap.set(groupId, {
                    name: fansub.name || fansub.title || String(groupId),
                    items: []
                });
            }
            groupMap.get(groupId).items.push(r);
        }
        const groups = [];
        for (const [id, g] of groupMap) {
            groups.push({
                name: g.name,
                rssUrl: `${host}/feed.xml?subject=${encodeURIComponent(subjectId)}&fansub=${encodeURIComponent(g.name)}`,
                itemCount: g.items.length,
                source: 'animegarden'
            });
        }
        return groups;
    }

    // --- Nyaa (RSS 搜索) ---

    async _searchNyaa(keyword, externalSignal = null) {
        const rssUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(keyword)}`;
        let preview = [];
        let groups = [];
        let totalCount = 0;
        try {
            const feedXml = await this._fetch(rssUrl, 'ptNyaa', 45000, externalSignal);
            const items = this.parseFeedItems(feedXml, rssUrl);
            totalCount = items.length;
            preview = items.slice(0, 5).map(item => item.title);

            // 从标题提取 [字幕组名] 模式
            const teamMap = new Map();
            for (const item of items) {
                const m = item.title.match(/\[([^\]]{2,30})\]/);
                if (m) {
                    const team = m[1].trim();
                    // 过滤掉纯数字、编码格式等非字幕组标签
                    if (!/^\d+$/.test(team) && !/^(HEVC|AVC|AAC|FLAC|WebRip|BDRip|MKV|MP4|1080p|720p|2160p|4K|简|繁|日|内封|内嵌)$/i.test(team)) {
                        if (!teamMap.has(team)) teamMap.set(team, 0);
                        teamMap.set(team, teamMap.get(team) + 1);
                    }
                }
            }
            // 按出现次数排序，取前 10
            groups = [...teamMap.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([name, count]) => ({
                    name,
                    rssUrl: `https://nyaa.si/?page=rss&q=${encodeURIComponent(keyword + ' ' + name)}`,
                    itemCount: count,
                    source: 'nyaa'
                }));
        } catch (e) { if (externalSignal?.aborted) throw e; }
        return [{
            id: 'nyaa-search',
            title: `Nyaa 搜索: ${keyword}`,
            cover: '',
            url: rssUrl,
            source: 'nyaa',
            itemCount: totalCount,
            preview,
            groups,
            directRss: true
        }];
    }

    // --- 动漫花园 (RSS 搜索) ---

    async _searchDmhy(keyword, externalSignal = null) {
        const rssUrl = `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(keyword)}`;
        let preview = [];
        let groups = [];
        let totalCount = 0;
        try {
            const feedXml = await this._fetch(rssUrl, 'ptDmhy', 45000, externalSignal);
            const items = this.parseFeedItems(feedXml, rssUrl);
            totalCount = items.length;
            preview = items.slice(0, 5).map(item => item.title);

            // 从 RSS <author> 标签提取字幕组
            const authorPattern = /<author><!\[CDATA\[([^\]]+)\]\]><\/author>/gi;
            const teamMap = new Map();
            let am;
            while ((am = authorPattern.exec(feedXml)) !== null) {
                const name = am[1].trim();
                if (name) {
                    teamMap.set(name, (teamMap.get(name) || 0) + 1);
                }
            }
            groups = [...teamMap.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 15)
                .map(([name, count]) => ({
                    name,
                    rssUrl: `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(keyword + ' ' + name)}`,
                    itemCount: count,
                    source: 'dmhy'
                }));
        } catch (e) { if (externalSignal?.aborted) throw e; }
        return [{
            id: 'dmhy-search',
            title: `动漫花园搜索: ${keyword}`,
            cover: '',
            url: rssUrl,
            source: 'dmhy',
            itemCount: totalCount,
            preview,
            groups,
            directRss: true
        }];
    }

    // --- 通用 HTTP ---

    /**
     * 把外部 AbortSignal 与内部超时合并，得到一个可被任一方触发的 signal。
     * 调用方在 finally 里调 cleanup() 释放定时器与监听。
     */
    _combineSignals(timeoutMs, externalSignal) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        let externalListener = null;
        if (externalSignal) {
            if (externalSignal.aborted) {
                clearTimeout(timeoutId);
                controller.abort(externalSignal.reason || new Error('aborted'));
            } else {
                externalListener = () => controller.abort(externalSignal.reason || new Error('aborted'));
                externalSignal.addEventListener('abort', externalListener, { once: true });
            }
        }
        const cleanup = () => {
            clearTimeout(timeoutId);
            if (externalListener && externalSignal) {
                externalSignal.removeEventListener('abort', externalListener);
            }
        };
        return { signal: controller.signal, cleanup };
    }

    _abortToError(e, externalSignal, timeoutMs) {
        const isAbort = e?.name === 'AbortError'
            || e?.code === 'ERR_ABORTED'
            || e?.code === 'ABORT_ERR'
            || e?.cause?.name === 'AbortError';
        if (isAbort) {
            if (externalSignal?.aborted) {
                return new Error('请求已取消');
            }
            return new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s)`);
        }
        return e;
    }

    async _fetch(url, proxyService, timeoutMs = 45000, externalSignal = null) {
        const proxyAgent = proxyService ? ProxyUtil.getProxyAgent(proxyService) : {};
        const { signal, cleanup } = this._combineSignals(timeoutMs, externalSignal);
        try {
            const resp = await got(url, {
                method: 'GET',
                responseType: 'text',
                headers: DEFAULT_HEADERS,
                signal,
                retry: { limit: 0 },
                ...proxyAgent
            });
            return resp.body || '';
        } catch (e) {
            const wrapped = this._abortToError(e, externalSignal, timeoutMs);
            if (wrapped !== e) throw wrapped;
            throw e;
        } finally {
            cleanup();
        }
    }

    async _fetchJSON(url, params, proxyService, timeoutMs = 45000, externalSignal = null) {
        let reqUrl = url;
        if (params) {
            const qs = Object.entries(params)
                .filter(([, v]) => v !== '' && v != null)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
            if (qs) reqUrl += (url.includes('?') ? '&' : '?') + qs;
        }
        const proxyAgent = proxyService ? ProxyUtil.getProxyAgent(proxyService) : {};
        const { signal, cleanup } = this._combineSignals(timeoutMs, externalSignal);
        try {
            const resp = await got(reqUrl, {
                method: 'GET',
                responseType: 'text',
                headers: DEFAULT_HEADERS,
                signal,
                retry: { limit: 0 },
                ...proxyAgent
            });
            try { return JSON.parse(resp.body || '{}'); } catch { return {}; }
        } catch (e) {
            const wrapped = this._abortToError(e, externalSignal, timeoutMs);
            if (wrapped !== e) throw wrapped;
            throw e;
        } finally {
            cleanup();
        }
    }
}

module.exports = { PtSourceService, PT_SOURCE_PRESETS: PRESETS };
