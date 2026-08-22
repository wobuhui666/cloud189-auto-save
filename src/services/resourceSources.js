const crypto = require('crypto');
const { ptService } = require('./ptService');
const { Cloud189Service } = require('./cloud189');
const cloud189Utils = require('../utils/Cloud189Utils');
const {
    analyzeCoverageFiles,
    buildCoverageScope,
    buildExpectedCoverage,
    summarizeCoverage
} = require('./autoSeriesCoverage');
const { inspectFiles } = require('./metadataOverride');

class CandidateRegistry {
    constructor(options = {}) {
        this.ttlMs = Number(options.ttlMs || 10 * 60 * 1000);
        this.entries = new Map();
    }

    register(candidate, secret) {
        const candidateId = crypto.randomUUID();
        this.entries.set(candidateId, { candidate, secret, expiresAt: Date.now() + this.ttlMs });
        return candidateId;
    }

    get(candidateId) {
        const entry = this.entries.get(String(candidateId || ''));
        if (!entry || entry.expiresAt <= Date.now()) {
            this.entries.delete(String(candidateId || ''));
            return null;
        }
        return entry;
    }

    publicView(candidateId) {
        const entry = this.get(candidateId);
        if (!entry) return null;
        const candidate = entry.candidate || {};
        return {
            candidateId,
            source: candidate.source,
            type: candidate.type,
            title: candidate.title,
            mediaInfo: candidate.mediaInfo || {},
            coverage: candidate.coverage || null,
            fingerprint: candidate.fingerprint || '',
            files: candidate.files || [],
            score: Number(candidate.score || 0)
        };
    }
}

class CloudSaverSource {
    constructor(autoSeriesService, registry) { this.autoSeriesService = autoSeriesService; this.registry = registry; }
    async search(context, query) {
        const result = await this.autoSeriesService.searchResources({ ...query, sources: ['cloudsaver'] });
        return (result.resources || []).map(item => this._register(item));
    }
    async inspect(candidateId) { return this.registry.publicView(candidateId); }
    _register(item) {
        const candidateId = this.registry.register({ source: 'cloudsaver', type: 'cloud_share', title: item.title, score: item.score, mediaInfo: {} }, { shareLink: item.shareLink });
        return this.registry.publicView(candidateId);
    }
}

class HdhiveSource extends CloudSaverSource {
    async search(context, query) {
        const result = await this.autoSeriesService.searchResources({ ...query, sources: ['hdhive'], allowHdhivePoints: context.allowHdhivePoints, hdhiveMaxPoints: context.hdhiveMaxPoints });
        return (result.resources || []).map(item => {
            const candidateId = this.registry.register({ source: 'hdhive', type: 'cloud_share', title: item.title, score: item.score, mediaInfo: { quality: item.quality, points: item.points, isFree: Boolean(item.isFree), isUnlocked: Boolean(item.isUnlocked) } }, { shareLink: item.shareLink, resourceSlug: item.slug });
            return this.registry.publicView(candidateId);
        });
    }
}

class SubscriptionSource extends CloudSaverSource {
    async search(context, query) {
        const result = await this.autoSeriesService.searchResources({ ...query, sources: ['subscription'] });
        return (result.resources || []).map(item => {
            const candidateId = this.registry.register({ source: 'subscription', type: 'cloud_share', title: item.title, score: item.score, mediaInfo: {} }, { shareLink: item.shareLink });
            return this.registry.publicView(candidateId);
        });
    }
}

class PtSource {
    constructor(registry) { this.registry = registry; }
    async search(context, query) {
        const candidates = await ptService._collectAutoSeriesCandidates(query.title);
        return candidates.map(item => {
            const candidateId = this.registry.register({ source: 'pt', type: 'pt_feed', title: item.groupName || item.title, score: ptService._scoreAutoSeriesCandidate(item, query.title, context.tmdbInfo), mediaInfo: { preset: item.preset, sampleCount: item.items?.length || 0 } }, { candidate: item });
            return this.registry.publicView(candidateId);
        });
    }
    async inspect(candidateId) { return this.registry.publicView(candidateId); }
}

class CandidateExecutor {
    constructor(autoSeriesService, registry) { this.autoSeriesService = autoSeriesService; this.registry = registry; }

    async inspect(candidateId, context = {}) {
        const entry = this.registry.get(candidateId);
        if (!entry) throw new Error('候选不存在或已过期');
        if (entry.candidate.type === 'pt_feed') {
            const files = (entry.secret.candidate.items || []).map(item => ({
                name: item.seasonNumber && item.episodeNumber
                    ? `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')} ${item.rawTitle || item.title}`
                    : (item.rawTitle || item.title),
                relativeDir: item.seasonNumber ? `Season ${String(item.seasonNumber).padStart(2, '0')}` : '',
                relativePath: item.rawTitle || item.title
            }));
            return this._saveInspection(candidateId, entry, files, context);
        }
        if (entry.candidate.type !== 'cloud_share') throw new Error('不支持检查该候选');
        const account = await this.autoSeriesService.accountRepo.findOneBy({ id: Number(context.accountId) });
        if (!account) throw new Error('自动追剧账号不存在');
        const shareLink = String(entry.secret.shareLink || '').trim();
        if (!shareLink) throw new Error('候选尚未提供可检查的分享链接');
        const cloud189 = Cloud189Service.getInstance(account);
        const parsed = cloud189Utils.parseCloudShare(shareLink);
        const accessCode = String(parsed.accessCode || '').trim();
        const shareInfo = await this.autoSeriesService.taskService.getShareInfo(cloud189, cloud189Utils.parseShareCode(parsed.url));
        if (shareInfo.shareMode == 1) {
            if (!accessCode) throw new Error('候选分享需要访问码');
            const access = await cloud189.checkAccessCode(cloud189Utils.parseShareCode(parsed.url), accessCode);
            if (!access?.shareId) throw new Error('候选分享访问码无效');
            shareInfo.shareId = access.shareId;
        }
        if (!shareInfo.shareId) throw new Error('候选分享信息不完整');
        const files = await this._collectShareFiles(cloud189, shareInfo, accessCode);
        return this._saveInspection(candidateId, entry, files, context);
    }

    _saveInspection(candidateId, entry, files, context) {
        const coverage = analyzeCoverageFiles(files, {
            tmdbInfo: context.tmdbInfo,
            candidateTitle: entry.candidate.title
        });
        const inspection = inspectFiles(files, context.metadataTemplate?.template || {});
        entry.candidate.coverage = coverage;
        entry.candidate.fingerprint = inspection.fingerprint;
        entry.candidate.files = inspection.files;
        return { ...this.registry.publicView(candidateId), coverage, fingerprint: inspection.fingerprint, files: inspection.files };
    }

    _saveCoverage(candidateId, entry, coverage) {
        entry.candidate.coverage = coverage;
        return { ...this.registry.publicView(candidateId), coverage };
    }

    async _collectShareFiles(cloud189, shareInfo, accessCode, folderId = null, relativeDir = '') {
        if (!shareInfo.isFolder) return [{ name: shareInfo.fileName, relativeDir: '', relativePath: shareInfo.fileName }];
        const currentFolderId = folderId || shareInfo.fileId;
        const result = await cloud189.listShareDir(shareInfo.shareId, currentFolderId, shareInfo.shareMode, accessCode, true);
        if (!result?.fileListAO) return [];
        const files = (result.fileListAO.fileList || []).map(file => ({
            ...file,
            relativeDir,
            relativePath: relativeDir ? `${relativeDir}/${file.name}` : file.name
        }));
        const folders = result.fileListAO.folderList || [];
        const childFiles = await this._mapWithConcurrency(folders, 4, async folder => {
            const name = folder.name || folder.fileName || '';
            const nextDir = relativeDir ? `${relativeDir}/${name}` : name;
            return this._collectShareFiles(cloud189, shareInfo, accessCode, folder.id || folder.fileId, nextDir);
        });
        return files.concat(...childFiles);
    }

    async _mapWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const current = index++;
                results[current] = await worker(items[current], current);
            }
        }));
        return results;
    }

    async commit(candidateId, context, options = {}) {
        const entry = this.registry.get(candidateId);
        if (!entry) throw new Error('候选不存在或已过期');
        if (entry.candidate.type === 'cloud_share') {
            return this.autoSeriesService.createByTitle({
                ...context,
                source: entry.candidate.source,
                shareLink: entry.secret.shareLink || '',
                resourceSlug: entry.secret.resourceSlug || '',
                resourceTitle: entry.candidate.title,
                coverageScope: options.coverageScope || null,
                metadataOverride: options.metadataOverride || null,
                autoSeriesIntentId: context.intentId || ''
            });
        }
        if (entry.candidate.type === 'pt_feed') {
            return ptService.createAutoSeriesSubscription({
                title: context.title,
                year: context.year,
                tmdbInfo: context.tmdbInfo,
                accountId: context.accountId,
                targetFolderId: context.targetFolderId,
                targetFolder: context.targetFolder,
                selectedCandidate: entry.secret.candidate,
                mediaPreference: context.mediaPreference,
                filterManagedBy: context.agentEnabled ? 'agent' : 'manual',
                metadataTemplate: options.metadataOverride || context.metadataTemplate || null,
                autoSeriesIntentId: context.intentId || ''
            });
        }
        throw new Error('不支持的候选类型');
    }

    async commitPlan(assignments = [], context = {}) {
        if (!Array.isArray(assignments) || !assignments.length) throw new Error('覆盖方案不能为空');
        const results = [];
        const committedAssignments = [];
        const failures = [];
        for (const assignment of assignments) {
            try {
                const coverageScope = buildCoverageScope(assignment.keys || [], buildExpectedCoverage(context.tmdbInfo));
                results.push(await this.commit(assignment.candidateId, context, {
                    coverageScope,
                    metadataOverride: assignment.metadataOverride || null
                }));
                committedAssignments.push({ candidateId: assignment.candidateId, keys: coverageScope.keys });
            } catch (error) {
                failures.push({ candidateId: assignment.candidateId, error: String(error.message || error) });
            }
        }
        if (!results.length) throw new Error(`覆盖方案提交失败：${failures.map(item => item.error).join('；')}`);
        const taskIds = [...new Set(results.flatMap(item => item.taskIds || []))];
        const subscriptionIds = [...new Set(results.map(item => item.subscriptionId).filter(Boolean))];
        const expectedCoverage = buildExpectedCoverage(context.tmdbInfo);
        const existingKeys = context.coverageState?.keys || [];
        const coverage = summarizeCoverage([
            ...existingKeys,
            ...committedAssignments.flatMap(item => item.keys)
        ], expectedCoverage);
        const expectedKeys = new Set(expectedCoverage.keys);
        const missingKeys = [...expectedKeys].filter(key => !coverage.keys.includes(key));
        return {
            taskIds,
            subscriptionIds,
            subscriptionId: subscriptionIds[0] || null,
            taskCount: taskIds.length,
            results,
            committedAssignments,
            failures,
            coverage,
            missingKeys,
            coverageComplete: expectedKeys.size > 0 && missingKeys.length === 0
        };
    }
}

module.exports = { CandidateRegistry, CloudSaverSource, HdhiveSource, SubscriptionSource, PtSource, CandidateExecutor };
