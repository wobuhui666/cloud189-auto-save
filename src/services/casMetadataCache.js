const fs = require('fs').promises;
const path = require('path');

class CasMetadataCacheService {
    constructor() {
        this.baseDir = path.join(__dirname, '../../data/cas-metadata');
    }

    _normalizeKey(payload = {}) {
        return {
            accountId: String(payload.accountId || '').trim(),
            shareId: String(payload.shareId || '').trim(),
            fileId: String(payload.fileId || '').trim()
        };
    }

    _buildFilePath(payload = {}) {
        const key = this._normalizeKey(payload);
        if (!key.accountId || !key.shareId || !key.fileId) {
            return '';
        }
        return path.join(this.baseDir, key.accountId, key.shareId, `${key.fileId}.json`);
    }

    _buildImportFilePath(payload = {}) {
        const accountId = String(payload.accountId || '').trim();
        const importId = String(payload.importId || '').trim();
        const entryKey = String(payload.entryKey || '').trim();
        if (!accountId || !importId || !entryKey) {
            return '';
        }
        const safeKey = entryKey.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(this.baseDir, 'import', accountId, importId, `${safeKey}.json`);
    }

    _normalizeMetadata(metadata = {}) {
        const normalized = {
            name: String(metadata.name || '').trim(),
            size: Number(metadata.size || 0) || 0,
            md5: String(metadata.md5 || '').trim().toUpperCase(),
            sliceMd5: String(metadata.sliceMd5 || '').trim().toUpperCase()
        };
        if (!normalized.name || !normalized.size || !normalized.md5 || !normalized.sliceMd5) {
            return null;
        }
        return normalized;
    }

    async _readMetadataFile(filePath) {
        if (!filePath) {
            return null;
        }
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(content);
            return this._normalizeMetadata(parsed?.metadata || parsed);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            return null;
        }
    }

    async get(payload = {}) {
        return this._readMetadataFile(this._buildFilePath(payload));
    }

    async set(payload = {}, metadata = {}) {
        const filePath = this._buildFilePath(payload);
        const normalizedMetadata = this._normalizeMetadata(metadata);
        if (!filePath || !normalizedMetadata) {
            return null;
        }

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify({
            metadata: normalizedMetadata,
            updatedAt: new Date().toISOString()
        }), 'utf8');
        return normalizedMetadata;
    }

    async getImport(payload = {}) {
        return this._readMetadataFile(this._buildImportFilePath(payload));
    }

    async setImport(payload = {}, metadata = {}, extra = {}) {
        const filePath = this._buildImportFilePath(payload);
        const normalizedMetadata = this._normalizeMetadata(metadata);
        if (!filePath || !normalizedMetadata) {
            return null;
        }

        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify({
            metadata: normalizedMetadata,
            extra: extra || {},
            updatedAt: new Date().toISOString()
        }), 'utf8');
        return normalizedMetadata;
    }

    async deleteImport(payload = {}) {
        const filePath = this._buildImportFilePath(payload);
        if (!filePath) {
            return false;
        }
        try {
            await fs.unlink(filePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }

    async deleteImportJob(accountId, importId) {
        const dir = path.join(this.baseDir, 'import', String(accountId || ''), String(importId || ''));
        try {
            await fs.rm(dir, { recursive: true, force: true });
            return true;
        } catch (_) {
            return false;
        }
    }

    async listShareCaches() {
        const results = [];
        let accountDirs = [];
        try {
            accountDirs = await fs.readdir(this.baseDir, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') {
                return results;
            }
            throw error;
        }

        for (const accountDir of accountDirs) {
            if (!accountDir.isDirectory() || accountDir.name === 'import') {
                continue;
            }
            const accountPath = path.join(this.baseDir, accountDir.name);
            let shareDirs = [];
            try {
                shareDirs = await fs.readdir(accountPath, { withFileTypes: true });
            } catch (_) {
                continue;
            }
            for (const shareDir of shareDirs) {
                if (!shareDir.isDirectory()) {
                    continue;
                }
                const sharePath = path.join(accountPath, shareDir.name);
                let files = [];
                try {
                    files = await fs.readdir(sharePath);
                } catch (_) {
                    continue;
                }
                const jsonFiles = files.filter((name) => name.endsWith('.json'));
                if (!jsonFiles.length) {
                    continue;
                }
                let updatedAt = '';
                try {
                    const stat = await fs.stat(sharePath);
                    updatedAt = stat.mtime.toISOString();
                } catch (_) {}
                results.push({
                    accountId: accountDir.name,
                    shareId: shareDir.name,
                    fileCount: jsonFiles.length,
                    updatedAt
                });
            }
        }

        results.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        return results;
    }

    async clearShareCache({ accountId = '', shareId = '', all = false } = {}) {
        if (all) {
            let accountDirs = [];
            try {
                accountDirs = await fs.readdir(this.baseDir, { withFileTypes: true });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return { deleted: 0 };
                }
                throw error;
            }
            let deleted = 0;
            for (const accountDir of accountDirs) {
                if (!accountDir.isDirectory() || accountDir.name === 'import') {
                    continue;
                }
                await fs.rm(path.join(this.baseDir, accountDir.name), { recursive: true, force: true });
                deleted += 1;
            }
            return { deleted };
        }

        const normalizedAccountId = String(accountId || '').trim();
        const normalizedShareId = String(shareId || '').trim();
        if (!normalizedAccountId) {
            throw new Error('accountId 不能为空');
        }

        const target = normalizedShareId
            ? path.join(this.baseDir, normalizedAccountId, normalizedShareId)
            : path.join(this.baseDir, normalizedAccountId);
        await fs.rm(target, { recursive: true, force: true });
        return { deleted: 1, accountId: normalizedAccountId, shareId: normalizedShareId || null };
    }
}

module.exports = { CasMetadataCacheService };
