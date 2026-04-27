const got = require('got');
const { logTaskEvent } = require('../utils/logUtils');
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

        const response = await got(rssUrl, {
            method: 'GET',
            responseType: 'text',
            headers: DEFAULT_HEADERS,
            timeout: { request: 30000 },
            retry: { limit: 1 }
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
        const infoHashTag = normalizeWhitespace(this._getFirstTagText(block, ['infoHash', 'nyaa:infoHash']));
        const publishedRaw = this._getFirstTagText(block, ['pubDate', 'published', 'updated']);
        const linkCandidates = this._collectLinkCandidates(block, description, baseUrl);
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
}

module.exports = { PtSourceService, PT_SOURCE_PRESETS: PRESETS };
