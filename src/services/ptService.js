const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { In } = require('typeorm');

const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');
const { CasService } = require('./casService');
const { StrmService } = require('./strm');
const { StreamProxyService } = require('./streamProxy');
const { logTaskEvent } = require('../utils/logUtils');
const { getDownloader, resetDownloader } = require('./downloader');
const { PtSourceService } = require('./ptSource');
const { ptRenameService } = require('./ptRename');
const { computeFileHashes, collectLocalFiles, normalizeWhitespace, matchReleaseTitle, extractInfoHashFromMagnet, safeFileName } = require('./ptUtils');
const {
    getPtSubscriptionRepository,
    getPtReleaseRepository,
    getAccountRepository
} = require('../database');

const STATUS = {
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    UPLOADING: 'uploading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    UPLOAD_FAILED: 'upload_failed'
};

class PtService {
    constructor() {
        this.casService = new CasService();
        this.sourceService = new PtSourceService();
        this._processingLock = false;
    }

    // ==================== 测试 / 工具 ====================

    async testDownloader() {
        try {
            resetDownloader();
            const downloader = getDownloader();
            return await downloader.testConnection();
        } catch (err) {
            return { ok: false, message: err && err.message ? err.message : String(err) };
        }
    }

    getSourcePresets() {
        return this.sourceService.getPresets();
    }

    async searchSource(preset, keyword) {
        return this.sourceService.searchSource(preset, keyword);
    }

    async getSourceGroups(preset, params) {
        return this.sourceService.getGroups(preset, params);
    }

    // ==================== 轮询 ====================

    async runPoll(subscriptionId = null) {
        const repo = getPtSubscriptionRepository();
        const where = subscriptionId ? { id: Number(subscriptionId) } : { enabled: true };
        const subs = await repo.find({ where });
        if (!subs.length) {
            return { processed: 0 };
        }
        let total = 0;
        for (const sub of subs) {
            try {
                const added = await this._pollSubscription(sub);
                total += added;
            } catch (err) {
                logTaskEvent(`[PT] 订阅 ${sub.name} 轮询失败: ${err.message || err}`);
                sub.lastStatus = 'error';
                sub.lastMessage = String(err.message || err).slice(0, 500);
                sub.lastCheckTime = new Date();
                await repo.save(sub);
            }
        }
        return { processed: total };
    }

    async _pollSubscription(subscription) {
        const repo = getPtSubscriptionRepository();
        const releaseRepo = getPtReleaseRepository();
        logTaskEvent(`[PT] 开始拉取订阅: ${subscription.name}`);

        const items = await this.sourceService.fetchFeedItems({
            sourcePreset: subscription.sourcePreset,
            rssUrl: subscription.rssUrl
        });

        const newReleases = [];
        for (const item of items) {
            if (!item.guid) continue;
            const exists = await releaseRepo.findOneBy({ subscriptionId: subscription.id, guid: item.guid });
            if (exists) continue;
            if (!matchReleaseTitle(item.title || '', subscription.includePattern, subscription.excludePattern)) {
                continue;
            }
            newReleases.push(item);
        }

        let addedCount = 0;
        for (const item of newReleases) {
            try {
                const release = releaseRepo.create({
                    subscriptionId: subscription.id,
                    guid: item.guid,
                    title: item.title || '',
                    infoHash: extractInfoHashFromMagnet(item.magnetUrl || '') || '',
                    magnetUrl: item.magnetUrl || '',
                    torrentUrl: item.torrentUrl || '',
                    detailsUrl: item.detailsUrl || '',
                    publishedAt: item.publishedAt || null,
                    status: STATUS.PENDING
                });
                await releaseRepo.save(release);

                await this._dispatchToDownloader(subscription, release);
                addedCount += 1;
            } catch (err) {
                logTaskEvent(`[PT] release 入队失败 [${item.title}]: ${err.message || err}`);
            }
        }

        subscription.lastCheckTime = new Date();
        subscription.lastStatus = 'ok';
        subscription.lastMessage = `本次新增 ${addedCount} 条`;
        subscription.releaseCount = (subscription.releaseCount || 0) + addedCount;
        await repo.save(subscription);

        logTaskEvent(`[PT] 订阅 ${subscription.name} 拉取完成，新增 ${addedCount}/${items.length}`);
        return addedCount;
    }

    async _dispatchToDownloader(subscription, release) {
        const releaseRepo = getPtReleaseRepository();
        const downloader = getDownloader();
        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        if (!downloadRoot) {
            throw new Error('未配置 PT 下载根目录');
        }
        const categoryPrefix = ConfigService.getConfigValue('pt.downloader.categoryPrefix', 'pt-sub-');
        const tagPrefix = ConfigService.getConfigValue('pt.downloader.tagPrefix', 'pt-rel-');
        const category = `${categoryPrefix}${subscription.id}`;
        const tag = `${tagPrefix}${release.id}`;
        const savePath = path.join(downloadRoot, `sub-${subscription.id}`);

        const torrent = await downloader.addTorrent({
            magnetUrl: release.magnetUrl || undefined,
            url: release.torrentUrl || undefined,
            savePath,
            category,
            tag,
            infoHash: release.infoHash || undefined
        });

        if (!torrent || !torrent.hash) {
            throw new Error('种子添加超时，未能获取到种子哈希');
        }

        release.qbTorrentHash = torrent.hash;
        release.downloadPath = torrent.savePath || savePath;
        release.status = STATUS.DOWNLOADING;
        await releaseRepo.save(release);
        logTaskEvent(`[PT] 已投递到下载器: ${release.title} (tag=${tag})`);
    }

    // ==================== 处理（轮询 release 状态机） ====================

    async runProcessing() {
        if (this._processingLock) {
            return { skipped: true };
        }
        this._processingLock = true;
        try {
            const releaseRepo = getPtReleaseRepository();
            const releases = await releaseRepo.find({
                where: { status: In([STATUS.DOWNLOADING, STATUS.DOWNLOADED, STATUS.UPLOADING]) }
            });
            for (const release of releases) {
                try {
                    if (release.status === STATUS.DOWNLOADING) {
                        await this._refreshDownloadStatus(release);
                    }
                    if (release.status === STATUS.DOWNLOADED) {
                        await this._uploadRelease(release);
                    }
                } catch (err) {
                    logTaskEvent(`[PT] release ${release.id} 处理出错: ${err.message || err}`);
                    release.lastError = String(err.message || err).slice(0, 500);
                    if (release.status === STATUS.DOWNLOADING) {
                        // 下载阶段错误不切失败状态，避免被一次性问题永久标失败
                    } else if (release.status === STATUS.UPLOADING) {
                        release.status = STATUS.UPLOAD_FAILED;
                    }
                    await releaseRepo.save(release);
                }
            }
            return { processed: releases.length };
        } finally {
            this._processingLock = false;
        }
    }

    async _refreshDownloadStatus(release) {
        const releaseRepo = getPtReleaseRepository();
        const downloader = getDownloader();
        if (!release.qbTorrentHash) {
            return;
        }
        const torrent = await downloader.getTorrent(release.qbTorrentHash);
        if (!torrent) {
            return;
        }
        release.downloadPath = torrent.contentPath || torrent.savePath || release.downloadPath;
        if (torrent.isCompleted) {
            release.status = STATUS.DOWNLOADED;
            await releaseRepo.save(release);
            logTaskEvent(`[PT] 下载完成: ${release.title}`);
        }
    }

    async _uploadRelease(release) {
        const releaseRepo = getPtReleaseRepository();
        const subRepo = getPtSubscriptionRepository();
        const accountRepo = getAccountRepository();

        release.status = STATUS.UPLOADING;
        release.lastError = '';
        await releaseRepo.save(release);

        const subscription = await subRepo.findOneBy({ id: release.subscriptionId });
        if (!subscription) {
            throw new Error(`找不到订阅 ${release.subscriptionId}`);
        }
        const account = await accountRepo.findOneBy({ id: subscription.accountId });
        if (!account) {
            throw new Error(`找不到账号 ${subscription.accountId}`);
        }

        const localPath = release.downloadPath || release.savePath;
        if (!localPath || !fs.existsSync(localPath)) {
            throw new Error(`本地文件不存在: ${localPath || '(空)'}`);
        }

        const cloud189 = Cloud189Service.getInstance(account);

        // 在订阅 targetFolder 下创建 release 子文件夹（按 release 标题）
        const releaseFolderName = safeFileName(release.title || `release-${release.id}`);
        const releaseFolderId = await this._ensureSubFolder(cloud189, subscription.targetFolderId, releaseFolderName);
        release.cloudFolderId = releaseFolderId;
        release.cloudFolderName = releaseFolderName;
        await releaseRepo.save(release);

        const localFiles = await collectLocalFiles(localPath);
        if (!localFiles.length) {
            throw new Error('本地下载目录为空');
        }

        const manifest = [];
        const enableFamilyTransit = !!ConfigService.getConfigValue('cas.enableFamilyTransit', true);
        const familyTransitFirst = !!ConfigService.getConfigValue('cas.familyTransitFirst', false);

        for (const file of localFiles) {
            const subDirId = await this._ensureNestedFolder(cloud189, releaseFolderId, file.relativeDir);
            logTaskEvent(`[PT] 哈希中: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
            const hashes = await computeFileHashes(file.fullPath);
            const casInfo = {
                name: file.name,
                size: hashes.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5
            };

            const uploadResult = await this._rapidUploadWithFallback(cloud189, subDirId, casInfo, file.name, file.fullPath, enableFamilyTransit, familyTransitFirst);
            // 同目录写 .cas stub
            const casContent = CasService.generateCasContent(casInfo, 'base64');
            const casFileName = file.name.toLowerCase().endsWith('.cas') ? file.name : `${file.name}.cas`;
            try {
                await this.casService.uploadTextFile(cloud189, subDirId, casFileName, casContent, { overwrite: true });
            } catch (err) {
                logTaskEvent(`[PT] 写 .cas 失败（不影响整体）: ${casFileName} ${err.message || err}`);
            }

            manifest.push({
                relativePath: file.relativePath,
                size: file.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5,
                cloudFileId: uploadResult.fileId,
                via: uploadResult.via
            });
        }

        release.manifestJson = JSON.stringify(manifest);
        release.casMetadataJson = JSON.stringify({ uploadedAt: new Date().toISOString(), count: manifest.length });
        release.status = STATUS.COMPLETED;
        release.lastError = '';
        await releaseRepo.save(release);
        logTaskEvent(`[PT] release 上传完成: ${release.title} (共 ${manifest.length} 个文件)`);

        // 生成 STRM 文件
        if (ConfigService.getConfigValue('pt.enableStrm', true)) {
            try {
                await this._generateStrmForRelease(account, subscription, release, manifest);
            } catch (strmErr) {
                logTaskEvent(`[PT] STRM 生成失败（不影响整体）: ${strmErr.message || strmErr}`);
            }
        }

        // 删除网盘源文件（复用 cas.deleteSourceAfterGenerate 配置）
        if (ConfigService.getConfigValue('cas.deleteSourceAfterGenerate', false)) {
            const isFamily = account.accountType === 'family';
            for (const entry of manifest) {
                if (entry.cloudFileId) {
                    try {
                        await this.casService.deleteSourceFileAfterGenerate(cloud189, entry.cloudFileId, entry.relativePath, isFamily);
                    } catch (delErr) {
                        logTaskEvent(`[PT] 删除网盘源文件失败: ${entry.relativePath} ${delErr.message || delErr}`);
                    }
                }
            }
        }

        // 生成 .cas 后自动删除本地源文件
        if (ConfigService.getConfigValue('pt.autoDeleteSource', true)) {
            try {
                if (fs.statSync(localPath).isDirectory()) {
                    // 共享目录：检查同订阅其他 release 是否还在使用
                    const otherActive = await releaseRepo.findOne({
                        where: {
                            subscriptionId: release.subscriptionId,
                            status: In([STATUS.DOWNLOADING, STATUS.DOWNLOADED]),
                        }
                    });
                    if (otherActive) {
                        logTaskEvent(`[PT] 跳过删除共享目录（其他 release 仍在使用）: ${localPath}`);
                    } else {
                        for (const f of localFiles) {
                            await fsp.unlink(f.fullPath).catch(() => {});
                        }
                        await this._cleanupEmptyDirs(localPath);
                        logTaskEvent(`[PT] 已删除本地源文件: ${localPath}`);
                    }
                } else {
                    await fsp.unlink(localPath).catch(() => {});
                    await this._cleanupEmptyDirs(path.dirname(localPath));
                    logTaskEvent(`[PT] 已删除本地源文件: ${localPath}`);
                }
            } catch (delErr) {
                logTaskEvent(`[PT] 删除本地源文件失败（不影响整体）: ${delErr.message || delErr}`);
            }
        }
    }

    async _rapidUploadWithFallback(cloud189, parentFolderId, casInfo, fileName, localFilePath, enableFamilyTransit, familyTransitFirst) {
        const tryPersonal = async () => {
            const fileId = await this.casService._personalRapidUpload(cloud189, parentFolderId, casInfo, fileName);
            return { fileId, via: 'personal' };
        };

        const tryFamilyTransit = async () => {
            if (!enableFamilyTransit) return null;
            const familyInfo = await cloud189.getFamilyInfo();
            if (!familyInfo?.familyId) return null;
            const familyId = String(familyInfo.familyId);
            const familyFolderId = await cloud189.getFamilyRootFolderId(familyId);
            const familyFileId = await this.casService._familyRapidUpload(cloud189, familyId, familyFolderId, casInfo, fileName);
            try {
                await this.casService._copyFamilyFileToPersonal(cloud189, familyId, familyFileId, parentFolderId, familyFolderId, fileName);
            } catch (copyErr) {
                await this.casService._safeDeleteFamilyFile(cloud189, familyId, familyFileId, fileName);
                throw copyErr;
            }
            // 清理家庭临时文件
            await this.casService._safeDeleteFamilyFile(cloud189, familyId, familyFileId, fileName);
            // 查找拷贝到个人存储后的文件 ID
            const listing = await cloud189.listFiles(parentFolderId);
            const personalFile = (listing?.fileListAO?.fileList || []).find(f => f.name === fileName);
            if (!personalFile?.id) {
                throw new Error('家庭中转完成但未找到个人文件');
            }
            return { fileId: String(personalFile.id), via: 'family-transit' };
        };

        const tryRealUpload = async () => {
            logTaskEvent(`[PT] 秒传全部失败，开始真传: ${fileName}`);
            const result = await this.casService._uploadStreamFile(cloud189, parentFolderId, fileName, localFilePath);
            return { fileId: result.fileId, via: 'real-upload' };
        };

        // 根据秒传配置决定尝试顺序
        const strategies = familyTransitFirst && enableFamilyTransit
            ? [tryFamilyTransit, tryPersonal, tryRealUpload]
            : [tryPersonal, tryFamilyTransit, tryRealUpload];

        let lastErr = null;
        for (const strategy of strategies) {
            if (!strategy) continue;
            try {
                const result = await strategy();
                if (result) return result;
            } catch (err) {
                logTaskEvent(`[PT] 策略失败: ${err.message || err}`);
                lastErr = err;
                // 黑名单直接跳过后续秒传，走真传
                if (err.isBlacklisted) {
                    logTaskEvent(`[PT] 文件被风控黑名单，跳过秒传直接真传`);
                    break;
                }
            }
        }
        throw lastErr || new Error('所有上传策略均失败');
    }

    async _cleanupEmptyDirs(dirPath) {
        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        try {
            const entries = await fsp.readdir(dirPath);
            if (entries.length === 0 && dirPath !== downloadRoot) {
                await fsp.rmdir(dirPath);
                const parent = path.dirname(dirPath);
                if (parent !== dirPath) {
                    await this._cleanupEmptyDirs(parent);
                }
            }
        } catch {}
    }

    async _ensureSubFolder(cloud189, parentFolderId, folderName) {
        const safeName = safeFileName(folderName);
        const listing = await cloud189.listFiles(parentFolderId);
        const folders = (listing?.fileListAO?.folderList || []);
        const existing = folders.find((f) => f.name === safeName);
        if (existing?.id) {
            return String(existing.id);
        }
        const created = await cloud189.createFolder(safeName, parentFolderId);
        if (!created?.id) {
            throw new Error(`创建文件夹失败: ${safeName}`);
        }
        return String(created.id);
    }

    async _ensureNestedFolder(cloud189, rootFolderId, relativeDir) {
        if (!relativeDir) {
            return rootFolderId;
        }
        const segments = String(relativeDir).split('/').filter(Boolean);
        let current = rootFolderId;
        for (const seg of segments) {
            current = await this._ensureSubFolder(cloud189, current, seg);
        }
        return current;
    }

    // ==================== STRM 生成 ====================

    async _generateStrmForRelease(account, subscription, release, manifest) {
        if (!account.localStrmPrefix) {
            logTaskEvent(`[PT] 账号未配置 STRM 本地前缀，跳过 STRM 生成`);
            return;
        }

        const strmService = new StrmService();
        const streamProxyService = new StreamProxyService();
        const strmOrganize = ConfigService.getConfigValue('pt.strmOrganize', {});
        const organizeEnabled = strmOrganize.enabled && strmOrganize.mode === 'regex';

        // 从 manifest 构建文件列表，供 generateCustom 使用
        const files = manifest
            .filter(m => m.cloudFileId)
            .map(m => {
                const originalFileName = path.basename(m.relativePath);
                const file = {
                    name: originalFileName,
                    relativeDir: path.dirname(m.relativePath) || '',
                    id: m.cloudFileId,
                    originalFileName
                };

                // 如果启用了整理，计算整理后的路径
                if (organizeEnabled) {
                    const { dirName, fileName } = ptRenameService.organizePath(
                        subscription,
                        release,
                        file,
                        strmOrganize
                    );
                    file.organizedDir = dirName;
                    file.organizedFileName = fileName;
                }

                return file;
            });

        if (!files.length) {
            logTaskEvent(`[PT] manifest 中没有已上传的文件，跳过 STRM 生成`);
            return;
        }

        const accountId = Number(account.id);
        const targetFolderId = String(subscription.targetFolderId || '');

        // 确定目标根目录
        let targetRoot;
        if (organizeEnabled) {
            // 整理模式：使用 {localStrmPrefix}/{categoryFolder}/{title}/Season {season}
            // 目录结构由第一个文件的 organizedDir 决定
            targetRoot = path.join(account.localStrmPrefix, files[0].organizedDir || '');
        } else {
            // 原始模式：使用 {localStrmPrefix}/PT/{subName}/{relName}
            const subName = safeFileName(subscription.name || `sub-${subscription.id}`);
            const relName = safeFileName(release.title || `release-${release.id}`);
            targetRoot = path.join(account.localStrmPrefix, 'PT', subName, relName);
        }

        await strmService.generateCustom(
            targetRoot,
            files,
            async (file) => streamProxyService.buildStreamUrl({
                type: 'subscription',
                accountId,
                fileId: file.id,
                fileName: file.sourceFileName || file.name,
                targetFolderId,
                rootName: '',
                relativeDir: file.sourceRelativeDir || '',
                isCas: true,
                originalFileName: file.originalFileName || ''
            }),
            false,
            false,
            organizeEnabled ? 'organized' : 'default'  // 传递重命名模式
        );

        logTaskEvent(`[PT] STRM 生成完成: ${targetRoot} (共 ${files.length} 个文件)`);
    }

    // ==================== 清理 ====================

    async runCleanup() {
        if (!ConfigService.getConfigValue('pt.cleanupEnabled', true)) {
            return { skipped: true };
        }
        const releaseRepo = getPtReleaseRepository();
        const completed = await releaseRepo.find({ where: { status: STATUS.COMPLETED } });
        const downloader = getDownloader();
        let removed = 0;
        for (const release of completed) {
            if (release.qbTorrentHash) {
                try {
                    await downloader.deleteTorrent(release.qbTorrentHash, true);
                    removed += 1;
                } catch (err) {
                    logTaskEvent(`[PT] 清理 qb 任务失败 ${release.qbTorrentHash}: ${err.message || err}`);
                }
            }
        }
        return { removed };
    }

    // ==================== 重试 / 删除 release ====================

    async retryRelease(releaseId) {
        const releaseRepo = getPtReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            throw new Error('release 不存在');
        }
        if ([STATUS.FAILED, STATUS.UPLOAD_FAILED].includes(release.status)) {
            release.status = release.qbTorrentHash ? STATUS.DOWNLOADING : STATUS.PENDING;
        } else if (release.status === STATUS.PENDING) {
            const subscription = await getPtSubscriptionRepository().findOneBy({ id: release.subscriptionId });
            if (subscription) {
                await this._dispatchToDownloader(subscription, release);
            }
        } else {
            // downloaded/uploading 直接重新跑上传
            release.status = STATUS.DOWNLOADED;
        }
        release.lastError = '';
        await releaseRepo.save(release);
        // 立即触发一次处理
        this.runProcessing().catch((err) => logTaskEvent(`[PT] retry 后处理失败: ${err.message || err}`));
        return release;
    }

    async deleteRelease(releaseId, deleteLocalFiles = true) {
        const releaseRepo = getPtReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            return;
        }
        if (release.qbTorrentHash) {
            try {
                const downloader = getDownloader();
                await downloader.deleteTorrent(release.qbTorrentHash, deleteLocalFiles);
            } catch (err) {
                logTaskEvent(`[PT] 删除 qb 任务失败: ${err.message || err}`);
            }
        }
        await releaseRepo.delete({ id: release.id });
    }
}

const ptService = new PtService();
module.exports = { PtService, ptService, PT_STATUS: STATUS };
