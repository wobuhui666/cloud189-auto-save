const path = require('path');
const { CasService } = require('./casService');
const { logTaskEvent } = require('../utils/logUtils');
const { CloudMutationExecutor } = require('./cloudMutationExecutor');

const CAS_ARCHIVE_DIR = '_cas';

function normalizeRelativePath(value = '') {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .replace(/\/{2,}/g, '/');
}

function safeSegment(value = '') {
    return String(value || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim();
}

function pathsOverlap(left = '', right = '') {
    const a = normalizeRelativePath(left);
    const b = normalizeRelativePath(right);
    if (!a || !b) {
        return false;
    }
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function buildCasArchiveRelativePath(mediaRelativePath = '') {
    const normalized = normalizeRelativePath(mediaRelativePath);
    if (!normalized || normalized.split('/').some(part => part === CAS_ARCHIVE_DIR || part === '..')) {
        return '';
    }
    return `${CAS_ARCHIVE_DIR}/${normalized}.cas`;
}

function buildCasArchiveFileName(mediaFileName = '') {
    const name = safeSegment(mediaFileName);
    return name.toLowerCase().endsWith('.cas') ? name : `${name}.cas`;
}

function isCasArchivePath(relativePath = '') {
    const normalized = normalizeRelativePath(relativePath);
    return normalized === CAS_ARCHIVE_DIR || normalized.startsWith(`${CAS_ARCHIVE_DIR}/`);
}

class CasArchiveService {
    static get rootName() {
        return CAS_ARCHIVE_DIR;
    }

    static isReservedDirectory(name = '') {
        return String(name || '').trim() === CAS_ARCHIVE_DIR;
    }

    static buildRelativePath(mediaRelativePath = '') {
        return buildCasArchiveRelativePath(mediaRelativePath);
    }

    static buildFileName(mediaFileName = '') {
        return buildCasArchiveFileName(mediaFileName);
    }

    static isArchivePath(relativePath = '') {
        return isCasArchivePath(relativePath);
    }

    static pathsOverlap(left = '', right = '') {
        return pathsOverlap(left, right);
    }

    constructor() {
        this._folderCache = new Map();
        this._mutationExecutor = new CloudMutationExecutor();
    }

    async ensureFolder(cloud189, parentFolderId, folderName) {
        const safeName = safeSegment(folderName);
        if (!safeName) {
            throw new Error('CAS归档目录名不能为空');
        }
        const cacheKey = `${String(parentFolderId)}:${safeName}`;
        if (this._folderCache.has(cacheKey)) {
            return this._folderCache.get(cacheKey);
        }
        const pending = (async () => {
            const listing = await cloud189.listFiles(parentFolderId);
            const existing = (listing?.fileListAO?.folderList || []).find(folder => folder.name === safeName);
            const folderId = existing?.id || existing?.fileId
                || (await this._mutationExecutor.createFolder(cloud189, parentFolderId, safeName)).value?.id;
            if (!folderId) {
                throw new Error(`创建CAS归档目录失败: ${safeName}`);
            }
            return String(folderId);
        })();
        this._folderCache.set(cacheKey, pending);
        try {
            return await pending;
        } catch (error) {
            this._folderCache.delete(cacheKey);
            throw error;
        }
    }

    async ensurePath(cloud189, targetFolderId, relativePath = '') {
        const normalized = normalizeRelativePath(relativePath);
        let current = String(targetFolderId);
        for (const segment of normalized.split('/').filter(Boolean)) {
            current = await this.ensureFolder(cloud189, current, segment);
        }
        return current;
    }

    async ensureArchiveFolder(cloud189, targetFolderId, mediaRelativeDir = '') {
        const normalizedDir = normalizeRelativePath(mediaRelativeDir);
        return this.ensurePath(
            cloud189,
            targetFolderId,
            [CAS_ARCHIVE_DIR, normalizedDir].filter(Boolean).join('/')
        );
    }

    async uploadStub(cloud189, targetFolderId, mediaRelativePath, casInfo, options = {}) {
        const normalized = normalizeRelativePath(mediaRelativePath);
        const archiveRelativePath = buildCasArchiveRelativePath(normalized);
        if (!archiveRelativePath) {
            throw new Error('CAS归档媒体路径无效');
        }
        const mediaName = path.posix.basename(normalized);
        const mediaDir = path.posix.dirname(normalized);
        const parentFolderId = await this.ensureArchiveFolder(
            cloud189,
            targetFolderId,
            mediaDir === '.' ? '' : mediaDir
        );
        const fileName = buildCasArchiveFileName(mediaName);
        const content = CasService.generateCasContent({ ...casInfo, name: mediaName }, 'base64');
        const result = await (options.casService || new CasService()).uploadTextFile(
            cloud189,
            parentFolderId,
            fileName,
            content,
            { overwrite: options.overwrite !== false }
        );
        return {
            fileId: String(result?.fileId || result?.id || ''),
            parentFolderId,
            fileName,
            relativePath: archiveRelativePath
        };
    }

    async moveToArchive(cloud189, taskService, file, targetFolderId, mediaRelativePath) {
        const normalized = normalizeRelativePath(mediaRelativePath);
        const archiveRelativePath = buildCasArchiveRelativePath(normalized);
        if (!file?.id || !archiveRelativePath) {
            throw new Error('CAS归档缺少源文件或媒体路径');
        }
        const parentFolderId = await this.ensureArchiveFolder(
            cloud189,
            targetFolderId,
            path.posix.dirname(normalized) === '.' ? '' : path.posix.dirname(normalized)
        );
        const targetFileName = buildCasArchiveFileName(path.posix.basename(normalized));
        let listing = await cloud189.listFiles(parentFolderId);
        let archivedFile = (listing?.fileListAO?.fileList || []).find(item =>
            String(item.id || item.fileId) === String(file.id)
        );
        const nameConflict = (listing?.fileListAO?.fileList || []).find(item =>
            item.name === targetFileName
            && String(item.id || item.fileId) !== String(file.id)
        );
        if (nameConflict) {
            throw new Error(`CAS归档目标已存在其他文件: ${targetFileName}`);
        }
        if (!archivedFile) {
            await taskService.moveCloudFile(cloud189, {
                id: file.id,
                name: file.name,
                isFolder: false
            }, parentFolderId);
            archivedFile = await this._waitForFile(cloud189, parentFolderId, file.id, file.name);
            if (!archivedFile) {
                throw new Error(`移动CAS存根后未在目标目录找到文件: ${file.name}`);
            }
        }
        if (String(archivedFile.name || file.name || '') !== targetFileName) {
            await this._mutationExecutor.rename(cloud189, file.id, targetFileName);
            const confirmed = await this._waitForFile(cloud189, parentFolderId, file.id, targetFileName);
            if (!confirmed || confirmed.name !== targetFileName) {
                throw new Error(`重命名CAS存根后校验失败: ${targetFileName}`);
            }
        }
        return {
            fileId: String(file.id),
            parentFolderId,
            fileName: targetFileName,
            relativePath: archiveRelativePath
        };
    }

    async _waitForFile(cloud189, folderId, fileId, fileName, maxAttempts = 30, intervalMs = 500) {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const listing = await cloud189.listFiles(folderId);
            const files = listing?.fileListAO?.fileList || [];
            const found = files.find(item =>
                String(item.id || item.fileId) === String(fileId)
                || (!!fileName && item.name === fileName)
            );
            if (found) {
                return found;
            }
            if (attempt < maxAttempts - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        return null;
    }
}

module.exports = {
    CAS_ARCHIVE_DIR,
    CasArchiveService,
    buildCasArchiveRelativePath,
    buildCasArchiveFileName,
    isCasArchivePath,
    pathsOverlap
};
