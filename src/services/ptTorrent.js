const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const got = require('got');

const ConfigService = require('./ConfigService');
const ProxyUtil = require('../utils/ProxyUtil');
const { extractInfoHashFromMagnet, normalizeRelativePath, safeFileName } = require('./ptUtils');

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

class BencodeReader {
    constructor(buffer) {
        this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
        this.offset = 0;
    }

    parse() {
        const value = this._parseValue();
        if (this.offset !== this.buffer.length) {
            throw new Error('种子文件包含多余数据');
        }
        return value;
    }

    _parseValue() {
        const start = this.offset;
        const token = this.buffer[this.offset];
        let value;
        if (token === 0x69) {
            value = this._parseInteger();
        } else if (token === 0x6c) {
            value = this._parseList();
        } else if (token === 0x64) {
            value = this._parseDictionary();
        } else if (token >= 0x30 && token <= 0x39) {
            value = this._parseBytes();
        } else {
            throw new Error(`无法解析 bencode token: ${String.fromCharCode(token || 0)}`);
        }
        Object.defineProperty(value, '__bencodeStart', { value: start, enumerable: false });
        Object.defineProperty(value, '__bencodeEnd', { value: this.offset, enumerable: false });
        return value;
    }

    _parseInteger() {
        this.offset += 1;
        const end = this.buffer.indexOf(0x65, this.offset);
        if (end < 0) throw new Error('整数缺少结束符');
        const raw = this.buffer.subarray(this.offset, end).toString('ascii');
        this.offset = end + 1;
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new Error(`非法整数: ${raw}`);
        return new Number(number);
    }

    _parseBytes() {
        let colon = this.offset;
        while (colon < this.buffer.length && this.buffer[colon] !== 0x3a) colon += 1;
        if (colon >= this.buffer.length) throw new Error('字符串缺少长度分隔符');
        const length = Number(this.buffer.subarray(this.offset, colon).toString('ascii'));
        if (!Number.isInteger(length) || length < 0) throw new Error('非法字符串长度');
        this.offset = colon + 1;
        const end = this.offset + length;
        if (end > this.buffer.length) throw new Error('字符串长度超出文件范围');
        const value = this.buffer.subarray(this.offset, end);
        this.offset = end;
        return value;
    }

    _parseList() {
        this.offset += 1;
        const result = [];
        while (this.offset < this.buffer.length && this.buffer[this.offset] !== 0x65) {
            result.push(this._parseValue());
        }
        if (this.buffer[this.offset] !== 0x65) throw new Error('列表缺少结束符');
        this.offset += 1;
        return result;
    }

    _parseDictionary() {
        this.offset += 1;
        const result = {};
        while (this.offset < this.buffer.length && this.buffer[this.offset] !== 0x65) {
            const key = this._parseBytes().toString('utf8');
            const value = this._parseValue();
            result[key] = value;
        }
        if (this.buffer[this.offset] !== 0x65) throw new Error('字典缺少结束符');
        this.offset += 1;
        return result;
    }
}

function bencodeValueToString(value = '') {
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof Number) return String(Number(value));
    return String(value || '');
}

function bencodeValueToNumber(value = 0) {
    if (value instanceof Number) return Number(value);
    if (Buffer.isBuffer(value)) return Number(value.toString('ascii'));
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function normalizeTorrentPath(parts = []) {
    const segments = (parts || [])
        .map(bencodeValueToString)
        .map(safeFileName)
        .filter(Boolean);
    return normalizeRelativePath(segments.join('/'));
}

class PtTorrentService {
    getCacheDir() {
        return path.join(__dirname, '../../data/pt-torrents');
    }

    getCachePath(url = '') {
        const digest = crypto.createHash('sha1').update(String(url || '')).digest('hex');
        return path.join(this.getCacheDir(), `${digest}.torrent`);
    }

    async downloadTorrent(url, options = {}) {
        const normalizedUrl = String(url || '').trim();
        if (!normalizedUrl) {
            throw new Error('种子下载地址不能为空');
        }
        if (/^magnet:/i.test(normalizedUrl)) {
            return {
                type: 'magnet',
                magnetUrl: normalizedUrl,
                infoHash: extractInfoHashFromMagnet(normalizedUrl),
                rootName: '',
                files: []
            };
        }

        await fsp.mkdir(this.getCacheDir(), { recursive: true });
        const cachePath = this.getCachePath(normalizedUrl);
        const cached = await this._readCachedTorrent(cachePath);
        if (cached) {
            return { ...cached, fromCache: true, cachePath };
        }

        const proxyService = options.proxyService || '';
        const proxyAgent = proxyService ? ProxyUtil.getProxyAgent(proxyService) : {};
        const response = await got(normalizedUrl, {
            method: 'GET',
            responseType: 'buffer',
            headers: {
                ...DEFAULT_HEADERS,
                ...(options.headers || {})
            },
            timeout: { request: Number(options.timeoutMs || 30000) },
            retry: { limit: 1 },
            followRedirect: true,
            ...proxyAgent
        });

        const body = Buffer.from(response.body || []);
        if (!body.length) {
            throw new Error('未下载到种子数据');
        }
        if (body.subarray(0, 7).toString('utf8').toLowerCase() === 'magnet:') {
            const magnetUrl = body.toString('utf8').trim();
            return {
                type: 'magnet',
                magnetUrl,
                infoHash: extractInfoHashFromMagnet(magnetUrl),
                rootName: '',
                files: []
            };
        }

        const parsed = this.parseTorrent(body);
        await fsp.writeFile(cachePath, body);
        return { ...parsed, buffer: body, fromCache: false, cachePath };
    }

    async _readCachedTorrent(cachePath) {
        try {
            const buffer = await fsp.readFile(cachePath);
            const parsed = this.parseTorrent(buffer);
            return { ...parsed, buffer };
        } catch (_) {
            return null;
        }
    }

    parseTorrent(buffer) {
        const reader = new BencodeReader(buffer);
        const root = reader.parse();
        const info = root.info;
        if (!info || info.__bencodeStart == null || info.__bencodeEnd == null) {
            throw new Error('种子缺少 info 字段');
        }
        const infoHash = crypto
            .createHash('sha1')
            .update(buffer.subarray(info.__bencodeStart, info.__bencodeEnd))
            .digest('hex')
            .toUpperCase();

        const rootName = safeFileName(
            bencodeValueToString(info['name.utf-8'] || info.name),
            ''
        );
        const files = [];
        if (Array.isArray(info.files)) {
            for (const file of info.files) {
                const relativePath = normalizeTorrentPath(file['path.utf-8'] || file.path);
                if (!relativePath) continue;
                files.push({
                    relativePath,
                    name: path.basename(relativePath),
                    size: bencodeValueToNumber(file.length)
                });
            }
        } else {
            files.push({
                relativePath: rootName,
                name: rootName,
                size: bencodeValueToNumber(info.length)
            });
        }

        return {
            type: 'torrent',
            infoHash,
            rootName,
            files,
            fileCount: files.length,
            totalSize: files.reduce((sum, file) => sum + (Number(file.size) || 0), 0)
        };
    }
}

const ptTorrentService = new PtTorrentService();

module.exports = { PtTorrentService, ptTorrentService };
