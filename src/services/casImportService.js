/**
 * CAS 存根导入服务
 * - 上传 .cas / zip / rar(含 .cas 树)
 * - 秒传还原到网盘
 * - 生成正常 / 懒 STRM
 * - 导入任务与缓存管理
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { createExtractorFromData } = require('node-unrar-js');

const { logTaskEvent } = require('../utils/logUtils');
const { CasFileService } = require('./casFileService');
const { CasService } = require('./casService');
const { CasMetadataCacheService } = require('./casMetadataCache');
const { Cloud189Service } = require('./cloud189');
const { StrmService } = require('./strm');
const { StreamProxyService } = require('./streamProxy');
const ConfigService = require('./ConfigService');
const { MediaLibraryLayoutService, normalizeRelativePath: layoutNormalize } = require('./mediaLibraryLayout');
const { TMDBService } = require('./tmdb');

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 2;
const CAS_IMPORT_ROOT = 'CAS导入';

function safeFileName(fileName = '', fallback = 'untitled') {
    const normalized = String(fileName || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\.+$/g, '')
        .trim();
    return normalized || fallback;
}

function normalizeRelativePath(value = '') {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\/+/, '')
        .replace(/^\/+/, '')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');
}

function assertSafeRelativePath(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
        throw new Error('无效的相对路径');
    }
    const segments = normalized.split('/');
    if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
        throw new Error(`非法路径: ${relativePath}`);
    }
    if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
        throw new Error(`非法绝对路径: ${relativePath}`);
    }
    return normalized;
}

function buildEntryKey(relativePath, casInfo = {}) {
    const basis = [
        normalizeRelativePath(relativePath),
        String(casInfo.md5 || '').toLowerCase(),
        String(casInfo.size || '')
    ].join('|');
    return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
}

function stripExtension(fileName = '') {
    const base = path.basename(String(fileName || ''));
    const ext = path.extname(base);
    return ext ? base.slice(0, -ext.length) : base;
}

function buildCasEntryFromContent(relativePath, content) {
    const casInfo = CasFileService.parse(content);
    const casFileName = path.basename(relativePath);
    const restoreName = CasFileService.getOriginalFileName(casFileName, casInfo);
    const relativeDir = normalizeRelativePath(path.posix.dirname(relativePath));
    return {
        relativePath,
        relativeDir: relativeDir === '.' ? '' : relativeDir,
        casFileName,
        restoreName,
        casInfo: {
            name: casInfo.name,
            size: casInfo.size,
            md5: String(casInfo.md5).toLowerCase(),
            sliceMd5: String(casInfo.sliceMd5).toLowerCase()
        },
        casContent: CasFileService.marshalBase64(casInfo),
        entryKey: buildEntryKey(relativePath, casInfo)
    };
}

function isArchiveNoisePath(rawName = '') {
    return rawName.includes('__MACOSX/') || path.basename(rawName).startsWith('._');
}

function readZipEntries(filePath, options = {}) {
    const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
    const maxTotalBytes = Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES);

    return new Promise((resolve, reject) => {
        yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openErr, zipfile) => {
            if (openErr) {
                reject(openErr);
                return;
            }

            const entries = [];
            let totalBytes = 0;
            let settled = false;

            const fail = (error) => {
                if (settled) return;
                settled = true;
                try { zipfile.close(); } catch (_) {}
                reject(error);
            };

            const done = () => {
                if (settled) return;
                settled = true;
                resolve(entries);
            };

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                const rawName = String(entry.fileName || '');
                if (/\/$/.test(rawName)) {
                    zipfile.readEntry();
                    return;
                }
                if (isArchiveNoisePath(rawName)) {
                    zipfile.readEntry();
                    return;
                }
                if (!CasFileService.isCasFile(rawName)) {
                    zipfile.readEntry();
                    return;
                }

                let relativePath;
                try {
                    relativePath = assertSafeRelativePath(rawName);
                } catch (error) {
                    fail(error);
                    return;
                }

                if (entries.length >= maxEntries) {
                    fail(new Error(`CAS 条目超过上限 ${maxEntries}`));
                    return;
                }

                const uncompressedSize = Number(entry.uncompressedSize || 0);
                totalBytes += uncompressedSize;
                if (totalBytes > maxTotalBytes) {
                    fail(new Error(`CAS 包解压体积超过上限 ${Math.round(maxTotalBytes / 1024 / 1024)}MB`));
                    return;
                }

                zipfile.openReadStream(entry, (streamErr, readStream) => {
                    if (streamErr) {
                        fail(streamErr);
                        return;
                    }
                    const chunks = [];
                    readStream.on('data', (chunk) => chunks.push(chunk));
                    readStream.on('error', fail);
                    readStream.on('end', () => {
                        try {
                            entries.push(buildCasEntryFromContent(relativePath, Buffer.concat(chunks).toString('utf8')));
                            zipfile.readEntry();
                        } catch (error) {
                            fail(new Error(`解析 ${relativePath} 失败: ${error.message}`));
                        }
                    });
                });
            });

            zipfile.on('end', done);
            zipfile.on('error', fail);
        });
    });
}

async function readRarEntries(filePath, options = {}) {
    const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
    const maxTotalBytes = Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES);

    let extractor;
    try {
        const data = await fsp.readFile(filePath);
        // node-unrar-js 需要 ArrayBuffer（不能是 SharedArrayBuffer 视图）
        const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        extractor = await createExtractorFromData({ data: arrayBuffer });
    } catch (error) {
        throw new Error(`读取 rar 失败: ${error.message || error}`);
    }

    let fileHeaders;
    try {
        const list = extractor.getFileList();
        fileHeaders = [...(list.fileHeaders || [])];
    } catch (error) {
        throw new Error(`读取 rar 列表失败: ${error.message || error}`);
    }

    const casHeaders = fileHeaders.filter((header) => {
        const name = String(header.name || '').replace(/\\/g, '/');
        const isDir = !!(header.flags && header.flags.directory) || /\/$/.test(name);
        return !isDir && CasFileService.isCasFile(name) && !isArchiveNoisePath(name);
    });

    if (!casHeaders.length) {
        return [];
    }
    if (casHeaders.length > maxEntries) {
        throw new Error(`CAS 条目超过上限 ${maxEntries}`);
    }

    let totalBytes = 0;
    for (const header of casHeaders) {
        totalBytes += Number(header.unpSize || header.packSize || 0);
        if (totalBytes > maxTotalBytes) {
            throw new Error(`CAS 包解压体积超过上限 ${Math.round(maxTotalBytes / 1024 / 1024)}MB`);
        }
    }

    const wanted = new Set(
        casHeaders.map((header) => String(header.name || '').replace(/\\/g, '/'))
    );

    let extractedFiles;
    try {
        // files 过滤器比路径数组更稳：兼容 rar 内反斜杠路径
        const extracted = extractor.extract({
            files: (header) => wanted.has(String(header.name || '').replace(/\\/g, '/'))
        });
        extractedFiles = [...(extracted.files || [])];
    } catch (error) {
        throw new Error(`解压 rar 失败: ${error.message || error}`);
    }

    const entries = [];
    for (const file of extractedFiles) {
        const fileHeader = file.fileHeader || {};
        const rawName = String(fileHeader.name || '').replace(/\\/g, '/');
        if (!wanted.has(rawName)) continue;
        if (fileHeader.flags && fileHeader.flags.directory) continue;

        let relativePath;
        try {
            relativePath = assertSafeRelativePath(rawName);
        } catch (error) {
            throw error;
        }

        const extraction = file.extraction;
        if (!extraction) {
            throw new Error(`解压 rar 条目失败 ${relativePath}: 无文件内容`);
        }
        const content = Buffer.from(extraction).toString('utf8');
        try {
            entries.push(buildCasEntryFromContent(relativePath, content));
        } catch (error) {
            throw new Error(`解析 ${relativePath} 失败: ${error.message}`);
        }
    }
    return entries;
}

async function parseArchiveEntries(filePath, originalName = '') {
    const lower = String(originalName || filePath || '').toLowerCase();
    if (lower.endsWith('.zip')) {
        return {
            sourceType: 'zip',
            entries: await readZipEntries(filePath)
        };
    }
    if (lower.endsWith('.rar')) {
        return {
            sourceType: 'rar',
            entries: await readRarEntries(filePath)
        };
    }
    throw new Error('仅支持 .cas / .zip / .rar 文件');
}

async function parseSingleCasFile(filePath, originalName = '') {
    const content = await fsp.readFile(filePath, 'utf8');
    const casInfo = CasFileService.parse(content);
    const casFileName = path.basename(originalName || filePath);
    const safeCasName = CasFileService.isCasFile(casFileName)
        ? casFileName
        : `${casFileName || casInfo.name || 'file'}.cas`;
    const restoreName = CasFileService.getOriginalFileName(safeCasName, casInfo);
    const relativePath = safeCasName;
    return [{
        relativePath,
        relativeDir: '',
        casFileName: safeCasName,
        restoreName,
        casInfo: {
            name: casInfo.name,
            size: casInfo.size,
            md5: String(casInfo.md5).toLowerCase(),
            sliceMd5: String(casInfo.sliceMd5).toLowerCase()
        },
        casContent: CasFileService.marshalBase64(casInfo),
        entryKey: buildEntryKey(relativePath, casInfo)
    }];
}

class CasImportService {
    constructor(accountRepo) {
        this.accountRepo = accountRepo || null;
        this.casService = new CasService();
        this.metadataCache = new CasMetadataCacheService();
        this.streamProxyService = new StreamProxyService(accountRepo);
        this.layoutService = new MediaLibraryLayoutService({
            tmdbService: new TMDBService()
        });
        this.baseDir = path.join(__dirname, '../../data/cas-import');
        this.jobsDir = path.join(this.baseDir, 'jobs');
        this.tmpDir = path.join(this.baseDir, 'tmp');
        this.running = new Set();
        this._folderCaches = new Map();
    }

    async init() {
        await fsp.mkdir(this.jobsDir, { recursive: true });
        await fsp.mkdir(this.tmpDir, { recursive: true });
    }

    _stripCommonRoot(entries = []) {
        if (!Array.isArray(entries) || entries.length < 2) {
            return { titleHint: '', entries };
        }
        const firstSegments = entries.map((entry) => normalizeRelativePath(entry.relativePath).split('/')[0] || '');
        const root = firstSegments[0];
        if (!root || firstSegments.some((seg) => seg !== root)) {
            return { titleHint: '', entries };
        }

        const stripped = entries.map((entry) => {
            const relativePath = normalizeRelativePath(entry.relativePath).split('/').slice(1).join('/');
            if (!relativePath) {
                return entry;
            }
            const relativeDir = normalizeRelativePath(path.posix.dirname(relativePath));
            return {
                ...entry,
                relativePath,
                relativeDir: relativeDir === '.' ? '' : relativeDir,
                entryKey: buildEntryKey(relativePath, entry.casInfo)
            };
        });
        return { titleHint: root, entries: stripped };
    }

    async parseUpload(filePath, originalName = '') {
        const lower = String(originalName || filePath || '').toLowerCase();
        if (lower.endsWith('.zip') || lower.endsWith('.rar')) {
            const archive = await parseArchiveEntries(filePath, originalName);
            let entries = archive.entries || [];
            if (!entries.length) {
                throw new Error(`${archive.sourceType} 中未找到有效的 .cas 文件`);
            }
            const stripped = this._stripCommonRoot(entries);
            entries = stripped.entries;
            entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN'));
            const title = safeFileName(
                stripped.titleHint || stripExtension(originalName || path.basename(filePath)),
                'cas-import'
            );
            return {
                sourceType: archive.sourceType,
                title,
                entries
            };
        }

        if (!lower.endsWith('.cas')) {
            throw new Error('仅支持 .cas / .zip / .rar 文件');
        }
        const entries = await parseSingleCasFile(filePath, originalName);
        return {
            sourceType: 'cas',
            title: safeFileName(stripExtension(originalName || entries[0].restoreName), 'cas-import'),
            entries
        };
    }

    _jobPath(jobId) {
        return path.join(this.jobsDir, `${jobId}.json`);
    }

    async _saveJob(job) {
        job.updatedAt = new Date().toISOString();
        await fsp.mkdir(this.jobsDir, { recursive: true });
        await fsp.writeFile(this._jobPath(job.id), JSON.stringify(job, null, 2), 'utf8');
        return job;
    }

    async _loadJob(jobId) {
        const content = await fsp.readFile(this._jobPath(jobId), 'utf8');
        return JSON.parse(content);
    }

    async listJobs() {
        await this.init();
        let files = [];
        try {
            files = await fsp.readdir(this.jobsDir);
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const jobs = [];
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const job = JSON.parse(await fsp.readFile(path.join(this.jobsDir, file), 'utf8'));
                jobs.push(this._summarizeJob(job));
            } catch (_) {}
        }
        jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return jobs;
    }

    async getJob(jobId, { full = true } = {}) {
        const job = await this._loadJob(jobId);
        return full ? job : this._summarizeJob(job);
    }

    _summarizeJob(job = {}) {
        const entries = Array.isArray(job.entries) ? job.entries : [];
        return {
            id: job.id,
            title: job.title,
            sourceName: job.sourceName,
            sourceType: job.sourceType,
            accountId: job.accountId,
            folderId: job.folderId,
            folderName: job.folderName || '',
            mode: job.mode,
            strmMode: job.strmMode,
            organizeMode: job.organizeMode || 'library',
            uploadCasStub: !!job.uploadCasStub,
            status: job.status,
            total: job.total || entries.length,
            success: job.success || 0,
            failed: job.failed || 0,
            skipped: job.skipped || 0,
            strmRoot: job.strmRoot || '',
            message: job.message || '',
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            finishedAt: job.finishedAt || null
        };
    }

    async createJobFromUpload({
        filePath,
        originalName,
        accountId,
        folderId,
        folderName = '',
        mode = 'restore',
        strmMode = 'normal',
        uploadCasStub = false,
        overwriteStrm = false,
        title = '',
        organizeMode = 'library'
    }) {
        await this.init();
        if (!accountId) throw new Error('账号不能为空');
        if (!folderId) throw new Error('目标目录不能为空');

        const normalizedMode = mode === 'lazy' ? 'lazy' : 'restore';
        let normalizedStrmMode = String(strmMode || '').trim();
        if (!['none', 'normal', 'lazy'].includes(normalizedStrmMode)) {
            normalizedStrmMode = normalizedMode === 'lazy' ? 'lazy' : 'normal';
        }
        if (normalizedMode === 'lazy' && normalizedStrmMode === 'normal') {
            normalizedStrmMode = 'lazy';
        }
        const normalizedOrganizeMode = String(organizeMode || 'library').trim() === 'mirror' ? 'mirror' : 'library';

        const account = await this._getAccount(accountId);
        const parsed = await this.parseUpload(filePath, originalName);
        const jobId = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
        const jobTitle = safeFileName(title || parsed.title, 'cas-import');
        // 与 MediaLibraryLayout 一致：裸 /strm 前缀视为空，避免 strm/strm
        const localPrefix = this.layoutService.normalizeLocalStrmPrefix(account.localStrmPrefix || '');

        // 先用镜像路径；library 模式解析锁定 layout 后覆盖 strmRoot
        let strmRoot = localPrefix
            ? path.posix.join(localPrefix, CAS_IMPORT_ROOT, jobTitle)
            : path.posix.join(CAS_IMPORT_ROOT, jobTitle);

        let libraryLayout = null;
        let entries = parsed.entries;
        if (normalizedOrganizeMode === 'library') {
            try {
                libraryLayout = await this.layoutService.resolveLibraryInfo({
                    resourceName: jobTitle,
                    files: parsed.entries.map((e) => ({
                        id: e.entryKey,
                        name: e.restoreName
                    })),
                    forceRefresh: false,
                    useAi: false // 导入默认确定性，避免 AI 漂移；需要时可后续加 force
                });
                // 标准化 season 目录
                entries = parsed.entries.map((entry) => {
                    const parts = normalizeRelativePath(entry.relativeDir).split('/').filter(Boolean);
                    const normalizedParts = parts.map((part) => this.layoutService.normalizeSeasonDirName(part) || part);
                    // 若只有一层 season，直接用标准 season；多层保留标准化后的相对路径
                    let relativeDir = normalizedParts.join('/');
                    if (!relativeDir && libraryLayout.seasonBased) {
                        relativeDir = this.layoutService.buildRelativeDir(
                            { name: entry.restoreName, relativeDir: entry.relativeDir },
                            null,
                            libraryLayout
                        );
                    }
                    return {
                        ...entry,
                        relativeDir,
                        // 媒体库模式下文件名可保持 restoreName（存根原名通常已带 SxxExx）
                    };
                });
                strmRoot = this.layoutService.buildStrmRoot(localPrefix, libraryLayout);
            } catch (error) {
                logTaskEvent(`[CAS导入] library 布局解析失败，回退 mirror: ${error.message}`);
            }
        }

        const job = {
            id: jobId,
            title: jobTitle,
            sourceName: originalName || path.basename(filePath),
            sourceType: parsed.sourceType,
            accountId: Number(accountId),
            folderId: String(folderId),
            folderName: String(folderName || ''),
            mode: normalizedMode,
            strmMode: normalizedStrmMode,
            organizeMode: normalizedOrganizeMode,
            libraryLayout,
            uploadCasStub: !!uploadCasStub,
            overwriteStrm: !!overwriteStrm,
            status: 'pending',
            total: entries.length,
            success: 0,
            failed: 0,
            skipped: 0,
            strmRoot,
            message: '',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            finishedAt: null,
            entries: entries.map((entry) => ({
                ...entry,
                status: 'pending',
                error: '',
                restoredFileId: '',
                parentFolderId: ''
            }))
        };

        await this._saveJob(job);
        this._queueRun(jobId);
        return this._summarizeJob(job);
    }

    _queueRun(jobId) {
        if (this.running.has(jobId)) {
            return;
        }
        this.running.add(jobId);
        setImmediate(() => {
            this.runJob(jobId)
                .catch((error) => {
                    logTaskEvent(`[CAS导入] 任务执行失败 ${jobId}: ${error.message || error}`);
                })
                .finally(() => {
                    this.running.delete(jobId);
                });
        });
    }

    async runJob(jobId, { retryFailedOnly = false } = {}) {
        const job = await this._loadJob(jobId);
        if (job.status === 'running' && !retryFailedOnly) {
            return this._summarizeJob(job);
        }

        const account = await this._getAccount(job.accountId);
        const cloud189 = Cloud189Service.getInstance(account);
        const folderCache = new Map();
        this._folderCaches.set(job.id, folderCache);

        job.status = 'running';
        job.message = retryFailedOnly ? '重试失败项中' : '执行中';
        await this._saveJob(job);

        const targets = job.entries.filter((entry) => {
            if (retryFailedOnly) {
                return entry.status === 'failed';
            }
            return entry.status === 'pending' || entry.status === 'failed';
        });

        const concurrency = Math.max(1, Math.min(
            DEFAULT_CONCURRENCY,
            Number(ConfigService.getConfigValue('cas.importConcurrency', DEFAULT_CONCURRENCY)) || DEFAULT_CONCURRENCY
        ));

        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, targets.length || 1) }, async () => {
            while (cursor < targets.length) {
                const index = cursor;
                cursor += 1;
                const entry = targets[index];
                await this._processEntry(job, entry, cloud189, folderCache);
                // 周期性落盘，便于前端轮询进度
                if (index % 3 === 0) {
                    this._refreshCounters(job);
                    await this._saveJob(job);
                }
            }
        });
        await Promise.all(workers);

        this._refreshCounters(job);

        // 生成 STRM
        if (job.strmMode === 'normal' || job.strmMode === 'lazy') {
            try {
                await this._generateStrm(job, account, cloud189);
            } catch (error) {
                job.message = `恢复完成，但 STRM 生成失败: ${error.message}`;
                logTaskEvent(`[CAS导入] STRM 生成失败 ${job.id}: ${error.message}`);
            }
        }

        this._refreshCounters(job);
        job.status = job.failed > 0 && job.success === 0
            ? 'failed'
            : (job.failed > 0 ? 'partial' : 'completed');
        if (!job.message || job.message === '执行中' || job.message === '重试失败项中') {
            job.message = `完成: 成功 ${job.success}, 失败 ${job.failed}, 跳过 ${job.skipped}`;
        }
        job.finishedAt = new Date().toISOString();
        await this._saveJob(job);
        this._folderCaches.delete(job.id);
        return this._summarizeJob(job);
    }

    _refreshCounters(job) {
        const entries = job.entries || [];
        job.total = entries.length;
        job.success = entries.filter((e) => e.status === 'success').length;
        job.failed = entries.filter((e) => e.status === 'failed').length;
        job.skipped = entries.filter((e) => e.status === 'skipped').length;
    }

    async _processEntry(job, entry, cloud189, folderCache) {
        entry.status = 'running';
        entry.error = '';
        try {
            // library 模式：网盘落点 = 分类/作品/相对季目录
            let restoreRootId = job.folderId;
            let entryRelativeDir = entry.relativeDir || '';
            if (job.organizeMode === 'library' && job.libraryLayout) {
                const info = this.layoutService.normalizeLibraryInfo(job.libraryLayout);
                const archiveRelative = [info.categoryName, info.resourceFolderName, entryRelativeDir]
                    .filter(Boolean)
                    .join('/');
                restoreRootId = job.folderId;
                entryRelativeDir = archiveRelative;
            }

            const parentFolderId = await this._ensureDirectoryPath(
                cloud189,
                restoreRootId,
                entryRelativeDir,
                folderCache
            );
            entry.parentFolderId = parentFolderId;

            // 可选：上传 .cas 存根到同目录
            if (job.uploadCasStub) {
                try {
                    await this.casService.uploadTextFile(
                        cloud189,
                        parentFolderId,
                        entry.casFileName,
                        entry.casContent,
                        { overwrite: true }
                    );
                } catch (error) {
                    logTaskEvent(`[CAS导入] 上传存根失败 ${entry.casFileName}: ${error.message}`);
                }
            }

            // 懒模式：仅写 metadata，播放时再 restore
            if (job.mode === 'lazy') {
                await this.metadataCache.setImport(
                    {
                        accountId: job.accountId,
                        importId: job.id,
                        entryKey: entry.entryKey
                    },
                    {
                        name: entry.casInfo.name || entry.restoreName,
                        size: entry.casInfo.size,
                        md5: entry.casInfo.md5,
                        sliceMd5: entry.casInfo.sliceMd5
                    },
                    {
                        restoreName: entry.restoreName,
                        relativeDir: entry.relativeDir,
                        targetFolderId: job.folderId,
                        parentFolderId,
                        casFileName: entry.casFileName
                    }
                );
                entry.status = 'success';
                return;
            }

            // 立即还原
            const existing = await this._findFileByName(cloud189, parentFolderId, entry.restoreName);
            if (existing?.id) {
                entry.restoredFileId = String(existing.id);
                entry.status = 'skipped';
                entry.error = '目标文件已存在，跳过秒传';
            } else {
                await this.casService.restoreFromCas(
                    cloud189,
                    parentFolderId,
                    {
                        name: entry.casInfo.name || entry.restoreName,
                        size: entry.casInfo.size,
                        md5: entry.casInfo.md5,
                        sliceMd5: entry.casInfo.sliceMd5
                    },
                    entry.restoreName
                );
                const restored = await this._findFileByName(cloud189, parentFolderId, entry.restoreName);
                entry.restoredFileId = restored?.id ? String(restored.id) : '';
                entry.status = 'success';
            }

            // 正常模式下也缓存 metadata，便于后续转懒 STRM / 重建
            await this.metadataCache.setImport(
                {
                    accountId: job.accountId,
                    importId: job.id,
                    entryKey: entry.entryKey
                },
                {
                    name: entry.casInfo.name || entry.restoreName,
                    size: entry.casInfo.size,
                    md5: entry.casInfo.md5,
                    sliceMd5: entry.casInfo.sliceMd5
                },
                {
                    restoreName: entry.restoreName,
                    relativeDir: entry.relativeDir,
                    targetFolderId: job.folderId,
                    parentFolderId,
                    casFileName: entry.casFileName,
                    restoredFileId: entry.restoredFileId || ''
                }
            );
        } catch (error) {
            entry.status = 'failed';
            entry.error = error.message || String(error);
            logTaskEvent(`[CAS导入] 条目失败 ${entry.relativePath}: ${entry.error}`);
        }
    }

    async _generateStrm(job, account, cloud189) {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM生成未启用, 请在媒体设置中启用');
        }
        if (!account.localStrmPrefix && !job.strmRoot) {
            throw new Error('账号未配置 STRM 本地前缀');
        }

        const successEntries = (job.entries || []).filter((entry) => (
            entry.status === 'success' || entry.status === 'skipped'
        ));
        if (!successEntries.length) {
            throw new Error('没有可生成 STRM 的成功条目');
        }

        const strmService = new StrmService();
        const useProxy = !!ConfigService.getConfigValue('strm.useStreamProxy');
        const files = successEntries.map((entry) => ({
            id: entry.restoredFileId || entry.entryKey,
            name: entry.restoreName,
            relativeDir: entry.relativeDir || '',
            entryKey: entry.entryKey,
            parentFolderId: entry.parentFolderId || job.folderId,
            sourceFileName: entry.casFileName,
            originalFileName: entry.restoreName,
            isCas: job.strmMode === 'lazy'
        }));

        await strmService.generateCustom(
            job.strmRoot,
            files,
            async (file) => {
                if (job.strmMode === 'lazy') {
                    return this.streamProxyService.buildStreamUrl({
                        type: 'casLazy',
                        accountId: job.accountId,
                        fileId: file.id || file.entryKey,
                        fileName: file.sourceFileName || file.name,
                        targetFolderId: job.folderId,
                        relativeDir: file.relativeDir || '',
                        isCas: true,
                        originalFileName: file.originalFileName || file.name,
                        importId: job.id,
                        entryKey: file.entryKey
                    });
                }

                // 正常 STRM：优先用已还原 fileId；缺失时按名查找
                let fileId = file.id;
                if (!fileId || String(fileId).length < 5) {
                    const found = await this._findFileByName(
                        cloud189,
                        file.parentFolderId || job.folderId,
                        file.name
                    );
                    fileId = found?.id ? String(found.id) : '';
                }
                if (!fileId) {
                    throw new Error(`未找到已还原文件: ${file.name}`);
                }

                if (useProxy) {
                    return this.streamProxyService.buildStreamUrl({
                        type: 'casImport',
                        accountId: job.accountId,
                        fileId,
                        fileName: file.name,
                        targetFolderId: job.folderId,
                        relativeDir: file.relativeDir || '',
                        isCas: false,
                        originalFileName: file.name
                    });
                }

                const directUrl = await cloud189.getDownloadLink(fileId);
                if (!directUrl) {
                    throw new Error(`获取直链失败: ${file.name}`);
                }
                return directUrl;
            },
            !!job.overwriteStrm,
            false,
            'default'
        );
    }

    async retryJob(jobId) {
        const job = await this._loadJob(jobId);
        const hasFailed = (job.entries || []).some((entry) => entry.status === 'failed');
        if (!hasFailed) {
            throw new Error('没有失败项可重试');
        }
        if (this.running.has(jobId)) {
            throw new Error('任务正在执行中');
        }
        this.running.add(jobId);
        try {
            return await this.runJob(jobId, { retryFailedOnly: true });
        } finally {
            this.running.delete(jobId);
        }
    }

    async deleteJob(jobId, { deleteStrm = false, deleteMetadata = true } = {}) {
        const job = await this._loadJob(jobId);
        if (deleteStrm && job.strmRoot) {
            try {
                const strmService = new StrmService();
                await strmService.deleteDir(job.strmRoot);
            } catch (error) {
                logTaskEvent(`[CAS导入] 删除 STRM 失败 ${job.strmRoot}: ${error.message}`);
            }
        }
        if (deleteMetadata) {
            await this.metadataCache.deleteImportJob(job.accountId, job.id);
        }
        await fsp.unlink(this._jobPath(jobId)).catch(() => {});
        return { id: jobId, deleted: true };
    }

    async listImportStrm(dirPath = '') {
        const strmService = new StrmService();
        const relative = normalizeRelativePath(dirPath);
        // 默认从各账号前缀下的 CAS导入 不够统一；这里直接从 strm root 列，前端可传完整相对路径
        // 若空路径，尝试列出常见 CAS导入 根
        if (!relative) {
            const rootItems = await strmService.listStrmFiles('');
            // 同时尝试直接列出 CAS导入（当 localStrmPrefix 为空时）
            const direct = await strmService.listStrmFiles(CAS_IMPORT_ROOT).catch(() => []);
            return {
                path: '',
                items: rootItems,
                casImportItems: direct
            };
        }
        const items = await strmService.listStrmFiles(relative);
        return { path: relative, items };
    }

    async deleteImportStrm(dirPath = '') {
        const relative = normalizeRelativePath(dirPath);
        if (!relative) {
            throw new Error('路径不能为空');
        }
        // 安全：只允许删除包含 CAS导入 的路径，或明确的相对路径
        if (!relative.includes(CAS_IMPORT_ROOT) && !relative.startsWith(CAS_IMPORT_ROOT)) {
            // 仍允许删除用户点选的导入任务 strmRoot（可能带账号前缀）
            const jobs = await this.listJobs();
            const allowed = jobs.some((job) => job.strmRoot && (
                relative === job.strmRoot || relative.startsWith(`${job.strmRoot}/`)
            ));
            if (!allowed) {
                throw new Error('只能删除 CAS 导入相关的 STRM 目录');
            }
        }
        const strmService = new StrmService();
        await strmService.deleteDir(relative);
        return { path: relative, deleted: true };
    }

    async listShareMetadata() {
        return this.metadataCache.listShareCaches();
    }

    async clearShareMetadata(params = {}) {
        return this.metadataCache.clearShareCache(params);
    }

    async resolveLazyPlayback(payload = {}) {
        const accountId = Number(payload.accountId);
        const importId = String(payload.importId || '').trim();
        const entryKey = String(payload.entryKey || '').trim();
        const targetFolderId = String(payload.targetFolderId || '').trim();
        const relativeDir = normalizeRelativePath(payload.relativeDir || '');
        const originalFileName = String(payload.originalFileName || payload.fileName || '').replace(/\.cas$/i, '');

        if (!accountId) throw new Error('播放账号无效');
        if (!importId || !entryKey) throw new Error('懒 STRM 元数据键缺失');

        const cacheKey = this.streamProxyService._getCacheKey(payload);
        const cached = this.streamProxyService.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.url;
        }

        const account = await this._getAccount(accountId);
        const cloud189 = Cloud189Service.getInstance(account);

        const metadata = await this.metadataCache.getImport({ accountId, importId, entryKey });
        if (!metadata) {
            throw new Error('未找到 CAS 导入元数据，请重新导入或重建懒 STRM');
        }

        const restoreName = originalFileName || metadata.name;
        const folderCache = new Map();
        const parentFolderId = await this._ensureDirectoryPath(
            cloud189,
            targetFolderId || '-11',
            relativeDir,
            folderCache
        );

        let targetFile = await this._findFileByName(cloud189, parentFolderId, restoreName);
        if (!targetFile) {
            await this.casService.restoreFromCas(
                cloud189,
                parentFolderId,
                {
                    name: metadata.name || restoreName,
                    size: metadata.size,
                    md5: metadata.md5,
                    sliceMd5: metadata.sliceMd5
                },
                restoreName
            );
            targetFile = await this._findFileByName(cloud189, parentFolderId, restoreName);
        }
        if (!targetFile?.id) {
            throw new Error(`懒恢复后未找到文件: ${restoreName}`);
        }

        const latestUrl = await cloud189.getDownloadLink(String(targetFile.id));
        if (!latestUrl) {
            throw new Error('未获取到播放直链');
        }

        this.streamProxyService.cache.set(cacheKey, {
            url: latestUrl,
            expiresAt: Date.now() + this.streamProxyService.cacheTtlMs
        });
        return latestUrl;
    }

    async _getAccount(accountId) {
        if (!this.accountRepo) {
            throw new Error('账号仓库未配置');
        }
        const account = await this.accountRepo.findOneBy({ id: Number(accountId) });
        if (!account) {
            throw new Error('账号不存在');
        }
        return account;
    }

    async _ensureDirectoryPath(cloud189, rootFolderId, relativeDir, folderCache = new Map()) {
        const normalized = normalizeRelativePath(relativeDir);
        if (!normalized) {
            return String(rootFolderId);
        }
        let current = String(rootFolderId);
        for (const segment of normalized.split('/').filter(Boolean)) {
            current = await this._ensureSubFolder(cloud189, current, segment, folderCache);
        }
        return current;
    }

    async _ensureSubFolder(cloud189, parentFolderId, folderName, folderCache = new Map()) {
        const safeName = safeFileName(folderName);
        const cacheKey = `${String(parentFolderId)}:${safeName}`;
        if (folderCache.has(cacheKey)) {
            return folderCache.get(cacheKey);
        }

        const listing = await cloud189.listFiles(parentFolderId);
        const folders = listing?.fileListAO?.folderList || [];
        const existing = folders.find((folder) => folder.name === safeName);
        if (existing?.id) {
            const id = String(existing.id);
            folderCache.set(cacheKey, id);
            return id;
        }

        const created = await cloud189.createFolder(safeName, parentFolderId);
        if (!created?.id) {
            throw new Error(`创建文件夹失败: ${safeName}`);
        }
        const id = String(created.id);
        folderCache.set(cacheKey, id);
        return id;
    }

    async _findFileByName(cloud189, folderId, fileName) {
        if (!folderId || !fileName) return null;
        const listing = await cloud189.listFiles(folderId);
        const files = listing?.fileListAO?.fileList || [];
        return files.find((file) => file.name === fileName) || null;
    }
}

module.exports = {
    CasImportService,
    CAS_IMPORT_ROOT,
    parseSingleCasFile,
    readZipEntries,
    safeFileName,
    normalizeRelativePath
};
