const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CAS_SLICE_SIZE = 10 * 1024 * 1024;

function normalizeRelativePath(targetPath = '') {
    return String(targetPath || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/');
}

function normalizeWhitespace(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeFileName(fileName = '', fallback = 'untitled') {
    const normalized = normalizeWhitespace(fileName)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\.+$/g, '')
        .trim();
    return normalized || fallback;
}

function decodeHtmlEntities(value = '') {
    const named = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: '\'',
        nbsp: ' '
    };
    return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
        const lowered = String(entity || '').toLowerCase();
        if (named[lowered]) {
            return named[lowered];
        }
        if (lowered.startsWith('#x')) {
            const code = parseInt(lowered.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        if (lowered.startsWith('#')) {
            const code = parseInt(lowered.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        }
        return _;
    });
}

function stripHtml(value = '') {
    return normalizeWhitespace(
        decodeHtmlEntities(String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1').replace(/<[^>]+>/g, ' '))
    );
}

function safeJsonParse(value, fallback = null) {
    if (!value) {
        return fallback;
    }
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function buildPatternMatcher(pattern = '') {
    const normalized = String(pattern || '').trim();
    if (!normalized) {
        return null;
    }
    try {
        const regex = new RegExp(normalized, 'i');
        return (value = '') => regex.test(String(value || ''));
    } catch (_) {
        const lowered = normalized.toLowerCase();
        return (value = '') => String(value || '').toLowerCase().includes(lowered);
    }
}

function matchReleaseTitle(title = '', includePattern = '', excludePattern = '') {
    const text = String(title || '');
    const includeMatcher = buildPatternMatcher(includePattern);
    const excludeMatcher = buildPatternMatcher(excludePattern);
    if (includeMatcher && !includeMatcher(text)) {
        return false;
    }
    if (excludeMatcher && excludeMatcher(text)) {
        return false;
    }
    return true;
}

function resolveUrl(baseUrl = '', targetUrl = '') {
    const normalized = String(targetUrl || '').trim();
    if (!normalized) {
        return '';
    }
    try {
        return new URL(normalized, baseUrl || undefined).toString();
    } catch (_) {
        return normalized;
    }
}

function extractUrlCandidates(text = '', baseUrl = '') {
    const content = decodeHtmlEntities(String(text || ''));
    const result = [];
    const patterns = [
        /(magnet:\?[^\s"'<>]+)/gi,
        /(https?:\/\/[^\s"'<>]+)/gi,
        /href=["']([^"']+)["']/gi,
        /url=["']([^"']+)["']/gi
    ];
    for (const pattern of patterns) {
        let match = null;
        while ((match = pattern.exec(content)) !== null) {
            const candidate = resolveUrl(baseUrl, match[1] || match[0]);
            if (candidate) {
                result.push(candidate);
            }
        }
    }
    return [...new Set(result)];
}

function base32ToHex(value = '') {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of String(value || '').toUpperCase()) {
        const index = alphabet.indexOf(char);
        if (index < 0) {
            return '';
        }
        bits += index.toString(2).padStart(5, '0');
    }
    let hex = '';
    for (let index = 0; index + 4 <= bits.length; index += 4) {
        hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex.toUpperCase();
}

function extractInfoHashFromMagnet(magnetUrl = '') {
    const match = String(magnetUrl || '').match(/xt=urn:btih:([^&]+)/i);
    if (!match) {
        return '';
    }
    const rawHash = decodeURIComponent(match[1]).trim();
    if (/^[a-f0-9]{40}$/i.test(rawHash)) {
        return rawHash.toUpperCase();
    }
    if (/^[a-z2-7]{32}$/i.test(rawHash)) {
        return base32ToHex(rawHash);
    }
    return rawHash.toUpperCase();
}

function calcCasSliceSize(fileSize) {
    const size = Number(fileSize) || 0;
    if (size > CAS_SLICE_SIZE * 2 * 999) {
        const multiplier = Math.max(Math.ceil(size / 1999 / CAS_SLICE_SIZE), 5);
        return multiplier * CAS_SLICE_SIZE;
    }
    if (size > CAS_SLICE_SIZE * 999) {
        return CAS_SLICE_SIZE * 2;
    }
    return CAS_SLICE_SIZE;
}

async function computeFileHashes(filePath) {
    const stat = await fs.promises.stat(filePath);
    const fileSize = Number(stat.size || 0);
    const sliceSize = calcCasSliceSize(fileSize);
    const fileMd5 = crypto.createHash('md5');
    let currentSliceHash = crypto.createHash('md5');
    let currentSliceBytes = 0;
    const partMd5Hexs = [];
    const partInfos = [];
    let partNumber = 1;

    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => {
            fileMd5.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const remainingSliceBytes = sliceSize - currentSliceBytes;
                const end = Math.min(offset + remainingSliceBytes, chunk.length);
                const sliceChunk = chunk.subarray(offset, end);
                currentSliceHash.update(sliceChunk);
                currentSliceBytes += sliceChunk.length;
                offset = end;

                if (currentSliceBytes === sliceSize) {
                    const sliceDigest = currentSliceHash.digest();
                    const sliceHex = sliceDigest.toString('hex').toUpperCase();
                    partMd5Hexs.push(sliceHex);
                    partInfos.push(`${partNumber}-${sliceDigest.toString('base64')}`);
                    partNumber += 1;
                    currentSliceHash = crypto.createHash('md5');
                    currentSliceBytes = 0;
                }
            }
        });
        stream.once('error', reject);
        stream.once('end', () => {
            if (currentSliceBytes > 0 || partMd5Hexs.length === 0) {
                const sliceDigest = currentSliceHash.digest();
                const sliceHex = sliceDigest.toString('hex').toUpperCase();
                partMd5Hexs.push(sliceHex);
                partInfos.push(`${partNumber}-${sliceDigest.toString('base64')}`);
            }
            resolve();
        });
    });

    const fileMd5Hex = fileMd5.digest('hex').toUpperCase();
    let sliceMd5Hex = fileMd5Hex;
    if (fileSize > sliceSize && partMd5Hexs.length > 1) {
        sliceMd5Hex = crypto.createHash('md5').update(partMd5Hexs.join('\n')).digest('hex').toUpperCase();
    }

    return {
        size: fileSize,
        sliceSize,
        md5: fileMd5Hex,
        sliceMd5: sliceMd5Hex,
        partMd5Hexs,
        partInfos
    };
}

async function collectLocalFiles(rootPath) {
    const stat = await fs.promises.stat(rootPath);
    if (!stat.isDirectory()) {
        return [{
            fullPath: rootPath,
            name: path.basename(rootPath),
            relativePath: path.basename(rootPath),
            relativeDir: '',
            size: Number(stat.size || 0)
        }];
    }

    const result = [];
    const walk = async (currentPath) => {
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const fileStat = await fs.promises.stat(fullPath);
            const relativePath = normalizeRelativePath(path.relative(rootPath, fullPath));
            const relativeDir = path.dirname(relativePath);
            result.push({
                fullPath,
                name: entry.name,
                relativePath,
                relativeDir: relativeDir === '.' ? '' : normalizeRelativePath(relativeDir),
                size: Number(fileStat.size || 0)
            });
        }
    };

    await walk(rootPath);
    result.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'zh-CN'));
    return result;
}

function buildCasContent(casInfo = {}) {
    const payload = {
        name: String(casInfo.name || '').trim(),
        size: Number(casInfo.size || 0) || 0,
        md5: String(casInfo.md5 || '').trim().toUpperCase(),
        sliceMd5: String(casInfo.sliceMd5 || '').trim().toUpperCase(),
        createTime: casInfo.createTime || new Date().toISOString()
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64');
}

function buildMultipartBody(fields = {}, files = []) {
    const boundary = `----Cloud189AutoSave${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const chunks = [];
    const push = (value) => {
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    };

    Object.entries(fields || {}).forEach(([name, value]) => {
        if (value == null) {
            return;
        }
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
        push(`${value}\r\n`);
    });

    for (const file of files || []) {
        if (!file || file.content == null) {
            continue;
        }
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="${file.fieldName || 'file'}"; filename="${file.fileName || 'file.bin'}"\r\n`);
        push(`Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`);
        push(file.content);
        push('\r\n');
    }

    push(`--${boundary}--\r\n`);
    return {
        body: Buffer.concat(chunks),
        contentType: `multipart/form-data; boundary=${boundary}`
    };
}

function tryExtractCasMetadataFromText(text = '', fileName = '', size = 0) {
    const rawText = decodeHtmlEntities(String(text || ''));
    const md5Match = rawText.match(/(?:^|[^a-z])(md5|filemd5)[^a-f0-9]{0,12}([a-f0-9]{32})(?:[^a-z0-9]|$)/i);
    const sliceMd5Match = rawText.match(/(?:slice[_\s-]?md5|slicemd5)[^a-f0-9]{0,12}([a-f0-9]{32})(?:[^a-z0-9]|$)/i);
    if (!md5Match || !sliceMd5Match) {
        return null;
    }
    return {
        name: fileName || '',
        size: Number(size || 0) || 0,
        md5: md5Match[2].toUpperCase(),
        sliceMd5: sliceMd5Match[1].toUpperCase()
    };
}

module.exports = {
    buildCasContent,
    buildMultipartBody,
    buildPatternMatcher,
    calcCasSliceSize,
    collectLocalFiles,
    computeFileHashes,
    decodeHtmlEntities,
    extractInfoHashFromMagnet,
    extractUrlCandidates,
    matchReleaseTitle,
    normalizeRelativePath,
    normalizeWhitespace,
    resolveUrl,
    safeFileName,
    safeJsonParse,
    stripHtml,
    tryExtractCasMetadataFromText
};
