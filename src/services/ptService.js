const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { In } = require('typeorm');

const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');
const { CasService } = require('./casService');
const { StrmService } = require('./strm');
const { StreamProxyService } = require('./streamProxy');
const { OrganizerService } = require('./organizer');
const { MediaLibraryLayoutService, joinLocalStrmPath } = require('./mediaLibraryLayout');
const { logTaskEvent } = require('../utils/logUtils');
const { getDownloader, resetDownloader } = require('./downloader');
const { PtSourceService } = require('./ptSource');
const { ptRenameService } = require('./ptRename');
const { ptTorrentService } = require('./ptTorrent');
const { CasArchiveService } = require('./casArchiveService');
const aiService = require('./ai');
const { CloudMutationExecutor } = require('./cloudMutationExecutor');
const { normalizeMediaPreference, scoreMediaTitle } = require('./mediaPreference');
const { mergeCandidateFilters, resolveMediaType, resolveValidationSeasonNumber, validatePtFilters } = require('./ptFilterValidation');
const { InvalidResourceService } = require('./invalidResource');
const { TMDBService } = require('./tmdb');
const { buildMetadataTemplate, parseJson, normalizeMetadataOverride } = require('./metadataOverride');
const { auditService } = require('./auditService');
const {
    buildEpisodeDedupKey,
    computeFileHashes,
    collectLocalFiles,
    normalizeWhitespace,
    matchReleaseFilters,
    extractInfoHashFromMagnet,
    normalizeInfoHash,
    parseNumber,
    safeJsonParse,
    safeFileName
} = require('./ptUtils');
const {
    AppDataSource,
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

function buildPtCollisionCandidates(requestedName, release = {}) {
    const extension = path.extname(requestedName);
    const stem = path.basename(requestedName, extension);
    const subgroup = safeFileName(
        release.subgroup || ptRenameService.extractSubgroup(release.title || ''),
        ''
    );
    const resolution = safeFileName(
        release.resolution || ptRenameService.extractResolution(release.title || ''),
        ''
    );
    const variant = [subgroup, resolution].filter(Boolean).join(' ');
    const suffixes = ['', variant, [variant, `release-${release.id}`].filter(Boolean).join(' ')];
    return [...new Set(suffixes)].map(suffix =>
        suffix ? `${stem} [${suffix}]${extension}` : requestedName
    );
}

const PT_FILTER_FIELDS = ['includePattern', 'excludePattern', 'qualityPattern', 'resolutionPattern', 'effectPattern'];

function getCandidateFilters(candidate = {}) {
    return PT_FILTER_FIELDS.reduce((filters, field) => {
        filters[field] = String(candidate[field] || '').trim();
        return filters;
    }, {});
}

function hasCandidateFilters(candidate = {}) {
    return PT_FILTER_FIELDS.some(field => String(candidate[field] || '').trim());
}

function sameStringList(left = [], right = []) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
}

function mediaPreferenceSatisfies(existingInput = {}, requestedInput = {}) {
    const existing = normalizeMediaPreference(existingInput || {});
    const requested = normalizeMediaPreference(requestedInput || {});
    return sameStringList(existing.resolutionPriority, requested.resolutionPriority)
        && sameStringList(existing.sourcePriority, requested.sourcePriority)
        && sameStringList(existing.dynamicRangePriority, requested.dynamicRangePriority)
        && sameStringList(existing.codecPriority, requested.codecPriority)
        && sameStringList(existing.audioPriority, requested.audioPriority)
        && sameStringList(existing.preferredGroups, requested.preferredGroups)
        && sameStringList(existing.blockedKeywords, requested.blockedKeywords)
        && existing.extraRequirement === requested.extraRequirement
        && existing.fallbackMode === requested.fallbackMode
        && existing.upgradePolicy === requested.upgradePolicy;
}

class PtService {
    constructor(options = {}) {
        this.casService = options.casService || new CasService();
        this.layoutService = options.layoutService || new MediaLibraryLayoutService();
        this.sourceService = options.sourceService || new PtSourceService();
        this.casArchiveService = options.casArchiveService || new CasArchiveService();
        this.mutationExecutor = options.mutationExecutor || new CloudMutationExecutor();
        this.invalidResourceService = options.invalidResourceService || new InvalidResourceService();
        this.repositories = options.repositories || {};
        this.cloud189Factory = options.cloud189Factory || (account => Cloud189Service.getInstance(account));
        this.downloaderFactory = options.downloaderFactory || getDownloader;
        this._processingLock = false;
        this._cloudUploadTransfers = new Map();
    }

    _ptSubscriptionRepository() {
        return this.repositories.ptSubscription || getPtSubscriptionRepository();
    }

    _ptReleaseRepository() {
        return this.repositories.ptRelease || getPtReleaseRepository();
    }

    _accountRepository() {
        return this.repositories.account || getAccountRepository();
    }

    _startCloudUploadTransfer(releaseId) {
        if (releaseId == null) return;
        this._cloudUploadTransfers.set(String(releaseId), { speed: 0 });
    }

    _updateCloudUploadTransfer(releaseId, progress = {}) {
        if (releaseId == null) return;
        const durationMs = Math.max(Number(progress.durationMs || 0), 1);
        const chunkBytes = Math.max(Number(progress.chunkBytes || 0), 0);
        this._cloudUploadTransfers.set(String(releaseId), {
            speed: chunkBytes * 1000 / durationMs
        });
    }

    _finishCloudUploadTransfer(releaseId) {
        if (releaseId == null) return;
        this._cloudUploadTransfers.delete(String(releaseId));
    }

    getTransferStats(releases = []) {
        const downloadSpeed = releases.reduce((total, release) => {
            const speed = Number(release?.downloader?.downloadSpeed || 0);
            return total + (Number.isFinite(speed) && speed > 0 ? speed : 0);
        }, 0);
        const cloudUploadSpeed = [...this._cloudUploadTransfers.values()].reduce((total, transfer) => {
            const speed = Number(transfer?.speed || 0);
            return total + (Number.isFinite(speed) && speed > 0 ? speed : 0);
        }, 0);
        return { downloadSpeed, cloudUploadSpeed };
    }

    // ==================== 测试 / 工具 ====================

    async testDownloader() {
        try {
            resetDownloader();
            const downloader = this.downloaderFactory();
            return await downloader.testConnection();
        } catch (err) {
            return { ok: false, message: err && err.message ? err.message : String(err) };
        }
    }

    getSourcePresets() {
        return this.sourceService.getPresets();
    }

    async searchSource(preset, keyword, options = {}) {
        return this.sourceService.searchSource(preset, keyword, options);
    }

    async getSourceGroups(preset, params) {
        return this.sourceService.getGroups(preset, params);
    }

    async getSourceGroupItems(rssUrl, preset) {
        return this.sourceService.getGroupItems(rssUrl, preset);
    }

    async generateFilterPatterns({ name = '', requirement = '', titles = [] } = {}) {
        const normalizedTitles = Array.isArray(titles)
            ? titles.map(title => String(title || '').trim()).filter(Boolean).slice(0, 50)
            : [];
        if (!normalizedTitles.length) {
            throw new Error('RSS 文件列表为空，无法生成正则');
        }

        const response = await aiService.chat([
            {
                role: 'system',
                content: [
                    '你是 PT/RSS 标题过滤正则生成器。根据订阅名称、用户要求和真实标题样本生成 JavaScript 正则。',
                    '只返回 JSON：{"includePattern":"...","excludePattern":"...","explanation":"..."}。',
                    '正则不要带 /.../ 包裹或 flags；使用兼容 JavaScript RegExp 的语法；不要使用全局 g 标志。',
                    'includePattern 用于保留标题，excludePattern 用于排除标题；不需要的字段返回空字符串。',
                    '优先生成短且可读的规则，不要把整条标题原样拼接。'
                ].join('\n')
            },
            {
                role: 'user',
                content: `订阅名称：${String(name || '').trim() || '未命名'}\n用户要求：${String(requirement || '').trim() || '根据样本生成合理的过滤规则'}\n标题样本：\n${normalizedTitles.map((title, index) => `${index + 1}. ${title}`).join('\n')}`
            }
        ], { temperature: 0, max_tokens: 1000 });
        if (!response.success) {
            throw new Error(response.error || 'AI 生成失败');
        }

        const cleaned = String(response.data || '')
            .replace(/```(?:json)?\s*|\s*```/gi, '')
            .trim();
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            throw new Error('AI 返回的正则格式无法解析');
        }
        const includePattern = String(parsed.includePattern || '').trim();
        const excludePattern = String(parsed.excludePattern || '').trim();
        for (const [label, pattern] of [['包含', includePattern], ['排除', excludePattern]]) {
            if (!pattern) continue;
            try {
                new RegExp(pattern, 'i');
            } catch (error) {
                throw new Error(`AI 生成的${label}正则无效: ${error.message}`);
            }
        }
        return {
            includePattern,
            excludePattern,
            explanation: String(parsed.explanation || '').trim()
        };
    }

    async testMikanBaseUrl(baseUrl) {
        return this.sourceService.testMikanBaseUrl(baseUrl);
    }

    async createAutoSeriesSubscription({ title, year = '', tmdbInfo = null, accountId, targetFolderId, targetFolder, selectedCandidate = null, mediaPreference = null, filterManagedBy = 'manual', metadataTemplate = null, autoSeriesIntentId = '' }) {
        const candidates = selectedCandidate ? [selectedCandidate] : await this._collectAutoSeriesCandidates(title);
        if (!candidates.length) throw new Error('PT 聚合搜索未找到可用 RSS');

        const ranked = candidates
            .map(candidate => ({ ...candidate, score: this._scoreAutoSeriesCandidate(candidate, title, tmdbInfo) }))
            .sort((left, right) => right.score - left.score);
        const bestDeterministic = ranked[0];
        const selected = selectedCandidate || bestDeterministic;
        const selectionReason = selectedCandidate ? '按 Agent 已验证候选创建' : `确定性评分 ${selected.score}`;
        const validationMediaType = resolveMediaType(tmdbInfo?.type || tmdbInfo?.mediaType || '', title);
        const validationSeasonNumber = resolveValidationSeasonNumber({
            title,
            mediaType: validationMediaType,
            tmdbInfo,
            seasonNumber: selected.seasonNumber ?? null
        });

        const repo = getPtSubscriptionRepository();
        const requestedPreference = normalizeMediaPreference(mediaPreference || {});
        const existing = await repo.findOne({ where: { accountId: Number(accountId), rssUrl: selected.rssUrl } });
        if (existing) {
            let filtersValid = true;
            if (existing.filterManagedBy === 'agent') {
                try {
                    const expected = validatePtFilters({
                        filters: getCandidateFilters(existing),
                        samples: (selected.items || []).slice(0, 50),
                        title,
                        aliases: [tmdbInfo?.title, tmdbInfo?.originalTitle],
                        seasonNumber: validationSeasonNumber,
                        mediaType: validationMediaType
                    }).token;
                    filtersValid = Boolean(existing.filterValidationHash) && existing.filterValidationHash === expected;
                } catch (_) {
                    filtersValid = false;
                }
            }
            const reusable = filtersValid
                && mediaPreferenceSatisfies(safeJsonParse(existing.mediaPreferenceJson, {}), requestedPreference);
            if (!reusable) {
                throw new Error('现有人工 PT 订阅的正则或媒体偏好不满足当前追剧意图，已拒绝复用');
            }
            if (autoSeriesIntentId && !existing.autoSeriesIntentId) {
                existing.autoSeriesIntentId = String(autoSeriesIntentId);
                if (!existing.metadataTemplateJson) existing.metadataTemplateJson = JSON.stringify(metadataTemplate || buildMetadataTemplate(tmdbInfo || {}, 'template'));
                await repo.save(existing);
            }
            return this._buildAutoSeriesPtResult(existing, selected, selectionReason, true);
        }

        let filterValidationHash = '';
        if (filterManagedBy === 'agent') {
            if (!hasCandidateFilters(selected)) {
                throw new Error('Agent PT 候选缺少经服务端验证的正则');
            }
            filterValidationHash = validatePtFilters({
                filters: getCandidateFilters(selected),
                samples: (selected.items || []).slice(0, 50),
                title,
                aliases: [tmdbInfo?.title, tmdbInfo?.originalTitle],
                seasonNumber: validationSeasonNumber,
                mediaType: validationMediaType
            }).token;
        }

        const subscription = repo.create({
            name: `${tmdbInfo?.title || title}${year ? ` (${year})` : ''}`.trim(),
            sourcePreset: selected.preset,
            rssUrl: selected.rssUrl,
            includePattern: selected.includePattern || '',
            excludePattern: selected.excludePattern || '',
            qualityPattern: selected.qualityPattern || '',
            resolutionPattern: selected.resolutionPattern || '',
            effectPattern: selected.effectPattern || '',
            sizeMinMB: 0,
            sizeMaxMB: 0,
            seedersMin: 0,
            freeOnly: false,
            episodeDedup: true,
            standbyRssJson: '',
            coexist: false,
            downloadNew: false,
            delayedDownloadMinutes: 0,
            notDownloadEpisodes: '',
            skipHalfEpisode: false,
            customEpisode: false,
            customEpisodeRegex: '',
            customEpisodeGroupIndex: 1,
            episodeOffset: 0,
            omit: false,
            totalEpisodeNumber: Number(tmdbInfo?.totalEpisodes || 0) || 0,
            autoDisabled: false,
            globalExclude: true,
            filterManagedBy,
            filterValidationHash,
            mediaPreferenceJson: JSON.stringify(requestedPreference),
            upgradePolicy: requestedPreference.upgradePolicy,
            metadataTemplateJson: JSON.stringify(metadataTemplate
                ? normalizeMetadataOverride(metadataTemplate, { source: metadataTemplate.source || (filterManagedBy === 'agent' ? 'agent' : 'template') })
                : buildMetadataTemplate(tmdbInfo || {}, filterManagedBy === 'agent' ? 'agent' : 'template')),
            autoSeriesIntentId: String(autoSeriesIntentId || ''),
            accountId: Number(accountId),
            targetFolderId: String(targetFolderId || ''),
            targetFolder: String(targetFolder || ''),
            enabled: true
        });
        await repo.save(subscription);
        this.runPoll(subscription.id).catch((error) => {
            logTaskEvent(`[PT] 自动追剧订阅首次轮询失败 ${subscription.name}: ${error.message || error}`);
        });
        return this._buildAutoSeriesPtResult(subscription, selected, selectionReason, false);
    }

    async _collectAutoSeriesCandidates(title) {
        const presets = ['mikan', 'anibt', 'animegarden', 'nyaa', 'dmhy'];
        const settled = await Promise.allSettled(presets.map(preset => this.searchSource(preset, title)));
        const rawCandidates = [];
        for (let index = 0; index < settled.length; index += 1) {
            if (settled[index].status !== 'fulfilled') continue;
            const preset = presets[index];
            for (const result of settled[index].value || []) {
                let feeds = [];
                if (Array.isArray(result.groups) && result.groups.length) {
                    feeds = result.groups;
                } else if (result.directRss && result.url) {
                    feeds = [{ name: result.title, rssUrl: result.url }];
                } else {
                    try {
                        feeds = await this.getSourceGroups(preset, {
                            bgmId: result.id,
                            bangumiId: result.id,
                            bangumiUrl: result.url
                        });
                    } catch (_) {}
                }
                for (const feed of feeds.slice(0, 8)) {
                    if (!feed?.rssUrl) continue;
                    rawCandidates.push({
                        id: `${preset}:${rawCandidates.length}`,
                        preset: feed.source || preset,
                        title: result.title || title,
                        groupName: feed.name || '',
                        rssUrl: feed.rssUrl,
                        includePattern: feed.includePattern || '',
                        itemCount: Number(feed.itemCount || result.itemCount || 0),
                        preview: Array.isArray(result.preview) ? result.preview : []
                    });
                }
            }
        }
        const preRanked = rawCandidates
            .map(candidate => ({
                ...candidate,
                preScore: candidate.itemCount
                    + candidate.preview.filter(value => String(value).toLowerCase().includes(String(title).toLowerCase())).length * 20
            }))
            .sort((left, right) => right.preScore - left.preScore)
            .slice(0, 16);
        return await Promise.all(preRanked.map(async candidate => {
            let items = [];
            try {
                items = await this.getSourceGroupItems(candidate.rssUrl, candidate.preset);
            } catch (_) {}
            return { ...candidate, items: items.slice(0, 20) };
        }));
    }

    _scoreAutoSeriesCandidate(candidate, title, tmdbInfo) {
        const samples = candidate.items || [];
        const text = samples.map(item => item.title).join('\n').toLowerCase();
        const names = [title, tmdbInfo?.title, tmdbInfo?.originalTitle]
            .filter(Boolean).map(value => normalizeWhitespace(value).toLowerCase());
        let score = Math.min(samples.length, 20);
        for (const name of names) if (text.includes(name)) score += 25;
        const count = pattern => samples.filter(item => pattern.test(String(item.title || ''))).length;
        score += count(/2160p|\b4k\b/i) * 7;
        score += count(/dolby[ ._-]?vision|\bdv\b|hdr10|\bhdr\b/i) * 3;
        score += count(/remux|blu[ ._-]?ray/i) * 2;
        score += count(/1080p/i) * 2;
        score -= count(/预告|trailer|teaser|sample|合集|全集打包|480p|720p/i) * 8;
        score += samples.filter(item => Number(item.episodeNumber) > 0).length;
        return score;
    }

    async _selectAutoSeriesCandidateWithAi(candidates, title, year, tmdbInfo) {
        if (!aiService.isEnabled() || !candidates.length) return null;
        const payload = candidates.slice(0, 12).map(candidate => ({
            id: candidate.id,
            source: candidate.preset,
            group: candidate.groupName,
            deterministicScore: candidate.score,
            samples: candidate.items.slice(0, 12).map(item => ({
                title: item.title,
                size: item.size,
                resolution: item.resolution,
                quality: item.quality,
                season: item.seasonNumber,
                episode: item.episodeNumber
            }))
        }));
        const response = await aiService.chat([
            {
                role: 'system',
                content: '从 PT RSS 候选中选择持续追剧源。优先标题和季度正确、集数连续、2160p/4K、HDR/Dolby Vision、Remux/BluRay，其次 1080p；排除预告、样片、错误剧集和无关合集。只返回 JSON：{"candidateId":"...","reason":"..."}，candidateId 必须来自输入。'
            },
            {
                role: 'user',
                content: JSON.stringify({ title, year, tmdb: tmdbInfo ? { title: tmdbInfo.title, originalTitle: tmdbInfo.originalTitle, totalEpisodes: tmdbInfo.totalEpisodes } : null, candidates: payload })
            }
        ], { temperature: 0, max_tokens: 600 });
        if (!response.success) return null;
        try {
            const parsed = JSON.parse(String(response.data || '').replace(/```(?:json)?\s*|\s*```/gi, '').trim());
            const candidate = candidates.find(item => item.id === parsed.candidateId);
            return candidate ? { candidate, reason: String(parsed.reason || 'AI 根据文件样本选择').slice(0, 300) } : null;
        } catch (_) {
            return null;
        }
    }

    _buildAutoSeriesPtResult(subscription, selected, selectionReason, reused) {
        return {
            source: 'pt',
            mode: 'pt',
            taskCount: 0,
            taskIds: [],
            taskName: subscription.name,
            resourceTitle: selected.groupName || selected.title,
            subscriptionId: subscription.id,
            preset: selected.preset,
            rssUrl: selected.rssUrl,
            selectionReason,
            reused
        };
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
            const auditRun = await auditService.startRun({
                correlationId: sub.autoSeriesIntentId ? `intent:${sub.autoSeriesIntentId}` : `pt:${sub.id}`,
                module: 'pt', trigger: subscriptionId ? 'manual' : 'scheduler',
                subjectType: 'pt_subscription', subjectId: sub.id, subjectName: sub.name,
                accountId: sub.accountId,
                metadata: { subscriptionId: sub.id, phase: 'poll' }
            });
            try {
                const added = auditRun
                    ? await auditService.runInContext(auditRun, () => this._pollSubscription(sub))
                    : await this._pollSubscription(sub);
                total += added;
                await auditService.finishRun(auditRun, 'completed', {
                    summary: `PT 轮询完成，新增 ${added} 条`
                });
            } catch (err) {
                logTaskEvent(`[PT] 订阅 ${sub.name} 轮询失败: ${err.message || err}`);
                sub.lastStatus = 'error';
                sub.lastMessage = String(err.message || err).slice(0, 500);
                sub.lastCheckTime = new Date();
                await repo.save(sub);
                await auditService.finishRun(auditRun, 'failed', {
                    summary: 'PT 订阅轮询失败', error: err.message || err
                });
            }
        }
        return { processed: total };
    }

    async _pollSubscription(subscription) {
        const repo = this._ptSubscriptionRepository();
        const releaseRepo = this._ptReleaseRepository();
        const pollingSubscription = this._preparePollingSubscription(subscription);
        logTaskEvent(`[PT] 开始拉取订阅: ${subscription.name}`);

        if (subscription.rssUrl && await this.invalidResourceService.isInvalid(subscription.rssUrl, 'pt_feed')) {
            throw new Error('PT RSS 处于失效缓存中，请人工解除后再试');
        }

        let feedItems;
        try {
            feedItems = await this.sourceService.fetchFeedItems(pollingSubscription);
        } catch (error) {
            await this.invalidResourceService.record(subscription.rssUrl, { resourceType: 'pt_feed', source: 'pt', operation: 'fetch_feed', error, metadata: { subscriptionId: subscription.id } }).catch(() => {});
            throw error;
        }
        const fetchedItems = feedItems.map(item => ({
            ...item,
            infoHash: normalizeInfoHash(item.infoHash || extractInfoHashFromMagnet(item.magnetUrl || ''))
        }));
        const filteredItems = this._filterDelayedItems(
            this._selectDownloadNewItems(fetchedItems, pollingSubscription),
            pollingSubscription
        );

        const guids = [...new Set(filteredItems.map(item => item.guid).filter(Boolean))];
        const infoHashes = [...new Set(filteredItems.map(item => item.infoHash).filter(Boolean))];
        const shouldLoadExisting = guids.length || infoHashes.length || pollingSubscription.episodeDedup;
        const existingReleases = shouldLoadExisting
            ? await releaseRepo.find({ where: { subscriptionId: subscription.id } })
            : [];
        const seenGuids = new Set(existingReleases.map(release => release.guid));
        const seenInfoHashes = new Set(existingReleases.map(release => normalizeInfoHash(release.infoHash)).filter(Boolean));
        const seenEpisodes = new Set(existingReleases.map(release => this._buildEpisodeDedupeKey(release, pollingSubscription)).filter(Boolean));
        const eligibleItems = filteredItems.filter(item => matchReleaseFilters(item, pollingSubscription));
        const selectedItems = this._selectBestEpisodeVersions(eligibleItems, pollingSubscription, existingReleases);
        const newReleases = [];
        for (const item of selectedItems) {
            if (!item.guid) continue;
            if (seenGuids.has(item.guid)) continue;
            if (item.infoHash && seenInfoHashes.has(item.infoHash)) continue;
            const episodeKey = pollingSubscription.episodeDedup ? this._buildEpisodeDedupeKey(item, pollingSubscription) : '';
            const upgradeFrom = item._upgradeFrom || null;
            if (episodeKey && seenEpisodes.has(episodeKey) && !upgradeFrom) {
                continue;
            }
            seenGuids.add(item.guid);
            if (item.infoHash) seenInfoHashes.add(item.infoHash);
            if (episodeKey) seenEpisodes.add(episodeKey);
            newReleases.push(item);
        }
        const skippedCount = Math.max(0, fetchedItems.length - newReleases.length);
        await auditService.event('pt_candidates', 'PT 候选过滤与评分完成', {
            phase: 'filter',
            data: {
                fetched: fetchedItems.length,
                delayedOrLatestFiltered: fetchedItems.length - filteredItems.length,
                ruleFiltered: filteredItems.length - eligibleItems.length,
                versionFiltered: eligibleItems.length - selectedItems.length,
                duplicateOrExisting: selectedItems.length - newReleases.length,
                selected: newReleases.length,
                samples: newReleases.slice(0, 20).map(item => ({
                    title: item.title, episode: item.episodeNumber, qualityScore: item._qualityScore || 0
                }))
            }
        });
        if (skippedCount > 0) {
            await auditService.recordOperation('skip', 'skipped', {
                reason: '延迟、规则、质量评分或重复项过滤',
                before: { total: fetchedItems.length, skipped: skippedCount },
                after: { selected: newReleases.length },
                decisionSource: 'pt_filter'
            });
        }

        let addedCount = 0;
        for (const item of newReleases) {
            try {
                const upgradeFrom = item._upgradeFrom || null;
                const release = releaseRepo.create({
                    subscriptionId: subscription.id,
                    guid: item.guid,
                    rawTitle: item.rawTitle || item.title || '',
                    title: item.title || '',
                    infoHash: item.infoHash || '',
                    subgroup: item.subgroup || item.author || '',
                    seasonNumber: item.seasonNumber != null ? Number(item.seasonNumber) : null,
                    episodeNumber: item.episodeNumber != null ? Number(item.episodeNumber) : null,
                    episodeLabel: item.episodeLabel || '',
                    resolution: item.resolution || '',
                    quality: item.quality || '',
                    releaseTagsJson: JSON.stringify(item.tags || []),
                    qualityScore: Number(item._qualityScore || 0),
                    upgradeFromReleaseId: upgradeFrom?.id || null,
                    activeVersion: upgradeFrom ? false : true,
                    magnetUrl: item.magnetUrl || '',
                    torrentUrl: item.torrentUrl || '',
                    detailsUrl: item.detailsUrl || '',
                    size: Number(item.size || 0) || 0,
                    seeders: Number(item.seeders || 0) || 0,
                    peers: Number(item.peers || 0) || 0,
                    grabs: Number(item.grabs || 0) || 0,
                    downloadVolumeFactor: item.downloadVolumeFactor != null ? Number(item.downloadVolumeFactor) : null,
                    uploadVolumeFactor: item.uploadVolumeFactor != null ? Number(item.uploadVolumeFactor) : null,
                    publishedAt: item.publishedAt || null,
                    metadataTemplateSnapshotJson: subscription.metadataTemplateJson || '',
                    status: STATUS.PENDING
                });
                await releaseRepo.save(release);

                await this._dispatchToDownloader(subscription, release);
                await auditService.event('pt_download', 'PT Release 已提交下载', {
                    phase: 'download',
                    data: { releaseId: release.id, title: release.title, qualityScore: release.qualityScore || 0 }
                });
                addedCount += 1;
            } catch (err) {
                logTaskEvent(`[PT] release 入队失败 [${item.title}]: ${err.message || err}`);
            }
        }

        await this._updateSubscriptionProgress(subscription, fetchedItems);
        subscription.lastCheckTime = new Date();
        subscription.lastStatus = 'ok';
        subscription.lastMessage = this._buildPollMessage(addedCount, fetchedItems.length, filteredItems.length, subscription);
        subscription.releaseCount = (subscription.releaseCount || 0) + addedCount;
        await repo.save(subscription);

        logTaskEvent(`[PT] 订阅 ${subscription.name} 拉取完成，新增 ${addedCount}/${fetchedItems.length}`);
        return addedCount;
    }

    _preparePollingSubscription(subscription = {}) {
        const globalExcludePattern = String(
            ConfigService.getConfigValue('pt.globalExcludePattern', '')
            || ConfigService.getConfigValue('pt.excludePattern', '')
            || ''
        );
        return {
            ...subscription,
            globalExcludePattern
        };
    }

    _selectBestEpisodeVersions(items = [], subscription = {}, existingReleases = []) {
        const preference = normalizeMediaPreference(safeJsonParse(subscription.mediaPreferenceJson, {}));
        const selected = new Map();
        for (const item of items) {
            const episodeKey = buildEpisodeDedupKey(item) || `guid:${item.guid}`;
            const quality = scoreMediaTitle(item.rawTitle || item.title || '', preference);
            if (quality.blocked) continue;
            const scored = { ...item, _qualityScore: quality.score };
            const current = selected.get(episodeKey);
            if (!current || scored._qualityScore > current._qualityScore) selected.set(episodeKey, scored);
        }
        return [...selected.entries()].map(([episodeKey, item]) => {
            if (subscription.upgradePolicy !== 'higher_score') return item;
            const completed = existingReleases.filter(release => buildEpisodeDedupKey(release) === episodeKey && release.status === STATUS.COMPLETED)
                .sort((left, right) => Number(right.qualityScore || 0) - Number(left.qualityScore || 0))[0];
            return completed && item._qualityScore > Number(completed.qualityScore || 0)
                ? { ...item, _upgradeFrom: completed }
                : item;
        });
    }

    async validateAutoSeriesFilters({ candidate, filters, title, aliases = [], seasonNumber = null, mediaType = '', tmdbInfo = null }) {
        const samples = (candidate?.items || []).slice(0, 50);
        const effectiveFilters = mergeCandidateFilters(candidate, filters);
        if (!hasCandidateFilters(effectiveFilters)) {
            throw new Error('PT Agent 必须提供至少一个正则字段');
        }
        const validationMediaType = resolveMediaType(mediaType || tmdbInfo?.type || tmdbInfo?.mediaType, title);
        const validationSeasonNumber = resolveValidationSeasonNumber({ title, mediaType: validationMediaType, tmdbInfo, seasonNumber });
        return validatePtFilters({ filters: effectiveFilters, samples, title, aliases, seasonNumber: validationSeasonNumber, mediaType: validationMediaType });
    }

    _buildEpisodeDedupeKey(item = {}, subscription = {}) {
        const baseKey = buildEpisodeDedupKey(item);
        if (!baseKey || !subscription.coexist) {
            return baseKey;
        }
        const variant = normalizeWhitespace(
            item.subgroup
            || item.author
            || item.standbyLabel
            || item.resolution
            || item.quality
            || item.title
            || ''
        ).toLowerCase();
        return `${baseKey}:${variant || 'default'}`;
    }

    _filterDelayedItems(items = [], subscription = {}) {
        const minutes = Math.max(0, Math.trunc(parseNumber(subscription.delayedDownloadMinutes, 0) || 0));
        if (!minutes) {
            return items;
        }
        const threshold = Date.now() - minutes * 60 * 1000;
        return items.filter(item => {
            if (!item.publishedAt) {
                return true;
            }
            const time = new Date(item.publishedAt).getTime();
            return !Number.isFinite(time) || time <= threshold;
        });
    }

    _selectDownloadNewItems(items = [], subscription = {}) {
        if (!subscription.downloadNew || items.length <= 1) {
            return items;
        }
        const datedItems = items
            .map(item => ({ item, time: item.publishedAt ? new Date(item.publishedAt).getTime() : 0 }))
            .filter(entry => Number.isFinite(entry.time) && entry.time > 0);
        if (datedItems.length) {
            const latest = datedItems.reduce((best, entry) => entry.time > best.time ? entry : best, datedItems[0]);
            const latestDay = new Date(latest.time).toISOString().slice(0, 10);
            return items.filter(item => {
                if (!item.publishedAt) {
                    return false;
                }
                const time = new Date(item.publishedAt).getTime();
                return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === latestDay;
            });
        }

        const episodeItems = items
            .map(item => ({ item, episode: parseNumber(item.episodeNumber, null) }))
            .filter(entry => entry.episode != null);
        if (episodeItems.length) {
            const latestEpisode = Math.max(...episodeItems.map(entry => entry.episode));
            return items.filter(item => parseNumber(item.episodeNumber, null) === latestEpisode);
        }
        return [items[0]];
    }

    async _updateSubscriptionProgress(subscription, fetchedItems = []) {
        const releaseRepo = this._ptReleaseRepository();
        const releases = await releaseRepo.find({ where: { subscriptionId: subscription.id } });
        subscription.currentEpisodeNumber = this._computeCurrentEpisodeNumber(subscription, releases);
        subscription.missingEpisodesJson = subscription.omit
            ? JSON.stringify(this._computeMissingEpisodes(fetchedItems))
            : '';

        const totalEpisodeNumber = Math.max(0, Math.trunc(parseNumber(subscription.totalEpisodeNumber, 0) || 0));
        if (subscription.autoDisabled && totalEpisodeNumber > 0 && subscription.currentEpisodeNumber >= totalEpisodeNumber) {
            subscription.enabled = false;
        }
    }

    _computeCurrentEpisodeNumber(subscription = {}, releases = []) {
        const episodes = releases
            .filter(release => Number(release.seasonNumber ?? 1) !== 0)
            .map(release => parseNumber(release.episodeNumber, null))
            .filter(episode => episode != null && episode > 0 && Math.trunc(episode) === episode);
        if (!episodes.length) {
            return 0;
        }
        if (subscription.downloadNew) {
            return Math.max(...episodes);
        }
        return new Set(episodes).size;
    }

    _computeMissingEpisodes(items = []) {
        const episodes = [...new Set(items
            .map(item => parseNumber(item.episodeNumber, null))
            .filter(episode => episode != null && episode > 0 && Math.trunc(episode) === episode)
            .map(Number)
        )].sort((a, b) => a - b);
        if (episodes.length <= 1) {
            return [];
        }
        const min = episodes[0];
        const max = episodes[episodes.length - 1];
        if (min === max) {
            return [];
        }
        const present = new Set(episodes);
        const missing = [];
        for (let episode = min; episode <= max; episode += 1) {
            if (!present.has(episode)) {
                missing.push(episode);
                if (missing.length >= 50) {
                    break;
                }
            }
        }
        return missing;
    }

    _buildPollMessage(addedCount, fetchedCount, eligibleCount, subscription = {}) {
        const parts = [`本次新增 ${addedCount} 条`];
        if (eligibleCount !== fetchedCount) {
            parts.push(`符合下载 ${eligibleCount}/${fetchedCount} 条`);
        }
        const missing = safeJsonParse(subscription.missingEpisodesJson, []);
        if (Array.isArray(missing) && missing.length) {
            parts.push(`缺集 ${missing.slice(0, 10).join(', ')}`);
        }
        if (subscription.autoDisabled && subscription.enabled === false) {
            parts.push('已达到总集数，自动停用');
        }
        return parts.join('；');
    }

    async _dispatchToDownloader(subscription, release) {
        const releaseRepo = this._ptReleaseRepository();
        const downloader = this.downloaderFactory();
        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        if (!downloadRoot) {
            throw new Error('未配置 PT 下载根目录');
        }
        const categoryPrefix = ConfigService.getConfigValue('pt.downloader.categoryPrefix', 'pt-sub-');
        const tagPrefix = ConfigService.getConfigValue('pt.downloader.tagPrefix', 'pt-rel-');
        const category = `${categoryPrefix}${subscription.id}`;
        const tag = `${tagPrefix}${release.id}`;
        const subscriptionSavePath = path.join(downloadRoot, `sub-${subscription.id}`);
        const savePath = path.join(subscriptionSavePath, `rel-${release.id}`);
        const torrentSource = await this._prepareTorrentSource(subscription, release);
        const previousHash = String(release.qbTorrentHash || '').trim();
        let lookupInfoHash = torrentSource.infoHash || release.infoHash || undefined;

        if (previousHash) {
            const existingTorrent = await downloader.getTorrent(previousHash).catch(() => null);
            if (!existingTorrent) {
                release.infoHash = release.infoHash || previousHash;
                release.qbTorrentHash = '';
                lookupInfoHash = undefined;
            }
        }

        const torrent = await downloader.addTorrent({
            magnetUrl: release.magnetUrl || undefined,
            url: torrentSource.url || release.torrentUrl || undefined,
            torrentBuffer: torrentSource.buffer || undefined,
            torrentFileName: torrentSource.fileName || undefined,
            savePath,
            categorySavePath: subscriptionSavePath,
            category,
            tag,
            infoHash: lookupInfoHash,
            forceStart: ConfigService.getConfigValue('pt.downloader.forceStart', true) !== false
        });

        if (!torrent || !torrent.hash) {
            throw new Error('种子添加超时，未能获取到种子哈希');
        }

        release.qbTorrentHash = torrent.hash;
        release.downloadPath = torrent.savePath || savePath;
        if (torrentSource.infoHash) {
            release.infoHash = torrentSource.infoHash;
        }
        if (torrentSource.rootName) {
            release.localRootName = torrentSource.rootName;
        }
        if (torrentSource.files && torrentSource.files.length) {
            release.torrentFilesJson = JSON.stringify(torrentSource.files.slice(0, 500));
            if (!release.size && torrentSource.totalSize) {
                release.size = torrentSource.totalSize;
            }
        }
        release.status = STATUS.DOWNLOADING;
        await releaseRepo.save(release);
        logTaskEvent(`[PT] 已投递到下载器: ${release.title} (tag=${tag})`);
    }

    async _prepareTorrentSource(subscription, release) {
        if (!release.torrentUrl) {
            return {
                url: release.magnetUrl || '',
                infoHash: release.infoHash || '',
                buffer: null,
                fileName: '',
                rootName: '',
                files: [],
                totalSize: 0
            };
        }

        try {
            const proxyService = this.sourceService.getProxyService(subscription.sourcePreset || 'generic');
            const result = await ptTorrentService.downloadTorrent(release.torrentUrl, { proxyService });
            if (result.type === 'magnet') {
                return {
                    url: result.magnetUrl,
                    infoHash: result.infoHash || release.infoHash || '',
                    buffer: null,
                    fileName: '',
                    rootName: '',
                    files: [],
                    totalSize: 0
                };
            }
            return {
                url: '',
                infoHash: result.infoHash || release.infoHash || '',
                buffer: result.buffer,
                fileName: `${safeFileName(release.title || `release-${release.id}`)}.torrent`,
                rootName: result.rootName || '',
                files: result.files || [],
                totalSize: result.totalSize || 0
            };
        } catch (err) {
            logTaskEvent(`[PT] 种子预下载失败，回退给下载器处理: ${release.title} ${err.message || err}`);
            return {
                url: release.torrentUrl,
                infoHash: release.infoHash || '',
                buffer: null,
                fileName: '',
                rootName: '',
                files: [],
                totalSize: 0
            };
        }
    }

    // ==================== 处理（轮询 release 状态机） ====================

    async runProcessing() {
        if (this._processingLock) {
            return { skipped: true };
        }
        this._processingLock = true;
        try {
            const releaseRepo = this._ptReleaseRepository();
            const releases = await releaseRepo.find({
                where: { status: In([STATUS.PENDING, STATUS.DOWNLOADING, STATUS.DOWNLOADED, STATUS.UPLOADING]) }
            });
            for (const release of releases) {
                const auditAvailable = auditService.isAvailable();
                // pending 任务需要订阅配置重新投递；其他状态仅在审计可用时读取关联信息。
                const subscription = (release.status === STATUS.PENDING || auditAvailable)
                    ? await this._ptSubscriptionRepository().findOneBy({ id: release.subscriptionId })
                    : null;
                const auditRun = auditAvailable ? await auditService.startRun({
                    correlationId: subscription?.autoSeriesIntentId ? `intent:${subscription.autoSeriesIntentId}` : `pt:${release.subscriptionId}`,
                    module: 'pt', trigger: 'scheduler', subjectType: 'pt_release', subjectId: release.id,
                    subjectName: release.title, accountId: subscription?.accountId,
                    metadata: {
                        subscriptionId: release.subscriptionId,
                        status: release.status,
                        qualityScore: release.qualityScore || 0,
                        upgradeFromReleaseId: release.upgradeFromReleaseId || null
                    }
                }) : null;
                try {
                    const processRelease = async () => {
                        if (release.status === STATUS.PENDING) {
                            if (!subscription) {
                                throw new Error(`找不到订阅 ${release.subscriptionId}`);
                            }
                            await this._dispatchToDownloader(subscription, release);
                        }
                        if (release.status === STATUS.DOWNLOADING) {
                            await this._refreshDownloadStatus(release);
                        }
                        // UPLOADING 可能是进程在秒传中途退出后遗留的状态；上传流程本身会
                        // 校验同名同哈希云端文件，可以安全地从本地完整文件继续执行。
                        if ([STATUS.DOWNLOADED, STATUS.UPLOADING].includes(release.status)) {
                            await this._uploadRelease(release);
                        }
                    };
                    if (auditRun) await auditService.runInContext(auditRun, processRelease);
                    else await processRelease();
                    await auditService.finishRun(auditRun, 'completed', {
                        summary: release.status === STATUS.COMPLETED ? 'PT Release 上传、验证和入库完成' : `PT Release 状态检查完成：${release.status}`
                    });
                } catch (err) {
                    logTaskEvent(`[PT] release ${release.id} 处理出错: ${err.message || err}`);
                    release.lastError = String(err.message || err).slice(0, 500);
                    if (release.status === STATUS.PENDING) {
                        release.status = STATUS.FAILED;
                    } else if (release.status === STATUS.DOWNLOADING) {
                        // 下载阶段错误不切失败状态，避免被一次性问题永久标失败
                    } else if (release.status === STATUS.UPLOADING) {
                        release.status = STATUS.UPLOAD_FAILED;
                    }
                    await releaseRepo.save(release);
                    await auditService.finishRun(auditRun, 'failed', {
                        summary: `PT Release 处理失败：${release.status}`, error: err.message || err
                    });
                }
            }
            return { processed: releases.length };
        } finally {
            this._processingLock = false;
        }
    }

    async _refreshDownloadStatus(release) {
        const releaseRepo = this._ptReleaseRepository();
        const downloader = this.downloaderFactory();
        if (!release.qbTorrentHash) {
            return;
        }
        const torrent = await downloader.getTorrent(release.qbTorrentHash);
        if (!torrent) {
            const completedPath = this._findCompletedLocalDownload(release);
            if (completedPath) {
                release.downloadPath = completedPath;
                release.status = STATUS.DOWNLOADED;
                release.progress = 100;
                release.lastError = '';
                await releaseRepo.save(release);
                logTaskEvent(`[PT] 下载任务已移除，已通过本地完整文件恢复: ${release.title}`);
                return;
            }

            release.infoHash = release.infoHash || release.qbTorrentHash;
            release.qbTorrentHash = '';
            release.status = STATUS.FAILED;
            release.lastError = 'qBittorrent 下载任务不存在，且未找到完整的本地下载文件，请重试';
            await releaseRepo.save(release);
            logTaskEvent(`[PT] 下载任务不存在，已停止等待: ${release.title}`);
            return;
        }
        const brokenStateMessage = {
            error: 'qBittorrent 下载任务发生错误',
            missingFiles: 'qBittorrent 下载文件丢失'
        }[torrent.state];
        if (brokenStateMessage) {
            const brokenHash = release.qbTorrentHash;
            release.infoHash = release.infoHash || brokenHash;
            release.status = STATUS.FAILED;
            try {
                await downloader.deleteTorrent(brokenHash, false);
                release.qbTorrentHash = '';
                release.lastError = `${brokenStateMessage}，已移除坏任务但保留本地文件，请重试`;
            } catch (err) {
                release.lastError = `${brokenStateMessage}；自动移除 qB 任务失败：${String(err.message || err)}`.slice(0, 500);
            }
            await releaseRepo.save(release);
            logTaskEvent(`[PT] 下载器任务异常，已停止等待: ${release.title} (${torrent.state})`);
            return;
        }
        const forceStart = ConfigService.getConfigValue('pt.downloader.forceStart', true) !== false;
        if (forceStart && !torrent.isCompleted && (torrent.isStopped || torrent.isQueued) && typeof downloader.forceStartTorrent === 'function') {
            await downloader.forceStartTorrent(release.qbTorrentHash);
            release.lastError = '';
            logTaskEvent(`[PT] 下载任务已强制启动: ${release.title} (${torrent.state || 'unknown'})`);
        } else if (torrent.isStopped && !torrent.isCompleted && typeof downloader.startTorrent === 'function') {
            await downloader.startTorrent(release.qbTorrentHash);
            release.lastError = '';
            logTaskEvent(`[PT] 下载任务已恢复: ${release.title}`);
        }
        release.downloadPath = torrent.contentPath || torrent.savePath || release.downloadPath;
        release.progress = Math.round((torrent.progress || 0) * 100);
        if (torrent.isCompleted) {
            release.status = STATUS.DOWNLOADED;
            release.progress = 100;
            await releaseRepo.save(release);
            logTaskEvent(`[PT] 下载完成: ${release.title}`);
        } else {
            await releaseRepo.save(release);
        }
    }

    _findCompletedLocalDownload(release) {
        const expectedFiles = safeJsonParse(release.torrentFilesJson, [])
            .filter(file => file && String(file.relativePath || file.name || '').trim());
        if (!expectedFiles.length) {
            return '';
        }

        const downloadRoot = String(ConfigService.getConfigValue('pt.downloadRoot', '') || '').trim();
        const deterministicPath = downloadRoot
            ? path.join(downloadRoot, `sub-${release.subscriptionId}`, `rel-${release.id}`)
            : '';
        const candidates = [release.downloadPath, release.savePath, deterministicPath];
        if (downloadRoot && release.localRootName) {
            candidates.push(path.join(downloadRoot, String(release.localRootName)));
        }

        for (const candidate of [...new Set(candidates.filter(Boolean).map(value => path.resolve(String(value))))]) {
            const roots = [candidate];
            if (release.localRootName && path.basename(candidate) !== String(release.localRootName)) {
                roots.push(path.join(candidate, String(release.localRootName)));
            }
            for (const root of roots) {
                if (this._hasCompleteTorrentFiles(root, expectedFiles)) {
                    return root;
                }
            }
        }
        return '';
    }

    _hasCompleteTorrentFiles(rootPath, expectedFiles) {
        if (!fs.existsSync(rootPath)) {
            return false;
        }
        const rootStat = fs.statSync(rootPath);
        if (rootStat.isFile()) {
            return expectedFiles.length === 1
                && rootStat.size === Number(expectedFiles[0].size || rootStat.size);
        }
        if (!rootStat.isDirectory()) {
            return false;
        }

        return expectedFiles.every(file => {
            const relativePath = String(file.relativePath || file.name || '').replace(/\\/g, '/');
            const filePath = path.resolve(rootPath, relativePath);
            const relativeToRoot = path.relative(rootPath, filePath);
            if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
                return false;
            }
            try {
                const stat = fs.statSync(filePath);
                const expectedSize = Number(file.size || 0);
                return stat.isFile() && (!expectedSize || stat.size === expectedSize);
            } catch (_) {
                return false;
            }
        });
    }

    async _uploadRelease(release) {
        const releaseRepo = this._ptReleaseRepository();
        const subRepo = this._ptSubscriptionRepository();
        const accountRepo = this._accountRepository();

        const subscription = await subRepo.findOneBy({ id: release.subscriptionId });
        if (!subscription) {
            throw new Error(`找不到订阅 ${release.subscriptionId}`);
        }
        const account = await accountRepo.findOneBy({ id: subscription.accountId });
        if (!account) {
            throw new Error(`找不到账号 ${subscription.accountId}`);
        }

        const localPath = await this._resolveReleaseLocalPath(release);
        if (!localPath || !fs.existsSync(localPath)) {
            throw new Error(`本地文件不存在: ${localPath || '(空)'}`);
        }

        const cloud189 = this.cloud189Factory(account);

        const localFiles = await collectLocalFiles(localPath);
        if (!localFiles.length) {
            throw new Error('本地下载目录为空');
        }

        // Agent 创建的 PT 订阅必须在拿到真实文件树后完成逐文件审计，审计失败不得进入上传。
        if (subscription.autoSeriesIntentId) {
            await this._auditReleaseMetadata(subscription, release, localFiles);
        }

        release.status = STATUS.UPLOADING;
        release.lastError = '';
        await releaseRepo.save(release);

        const uploadPlan = await this._buildPtUploadPlan(subscription, release, localFiles);
        await auditService.event('pt_upload_plan', 'PT 上传与媒体目录规划完成', {
            phase: 'classify',
            data: {
                organizeEnabled: uploadPlan.organizeEnabled,
                rootRelativePath: uploadPlan.rootRelativePath,
                fileCount: uploadPlan.files.length,
                mappings: uploadPlan.files.slice(0, 100).map(item => ({
                    sourcePath: item.source?.relativePath,
                    targetPath: item.cloudRelativePath
                }))
            }
        });
        const releaseRootPath = uploadPlan.rootRelativePath;
        const releaseFolderId = await this._ensureNestedFolder(
            cloud189,
            subscription.targetFolderId,
            releaseRootPath
        );
        release.cloudFolderId = releaseFolderId;
        release.cloudFolderName = releaseRootPath;
        await releaseRepo.save(release);

        const manifest = [];
        const enableFamilyTransit = !!ConfigService.getConfigValue('cas.enableFamilyTransit', true);
        const familyTransitFirst = !!ConfigService.getConfigValue('cas.familyTransitFirst', false);
        const totalFiles = localFiles.length;
        let uploadedFiles = 0;

        for (const planned of uploadPlan.files) {
            const file = planned.source;
            const cloudDir = path.posix.dirname(planned.cloudRelativePath);
            const subDirId = await this._ensureNestedFolder(
                cloud189,
                subscription.targetFolderId,
                cloudDir === '.' ? '' : cloudDir
            );
            logTaskEvent(`[PT] 哈希中: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)}MB)`);
            const hashes = await computeFileHashes(file.fullPath);
            const destination = await this._resolvePtUploadDestination(
                cloud189,
                subDirId,
                planned.fileName,
                hashes,
                release
            );
            const casInfo = {
                name: destination.fileName,
                size: hashes.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5
            };

            const uploadResult = destination.existing
                ? { fileId: destination.fileId, via: 'existing' }
                : await this.mutationExecutor.upload(
                    cloud189,
                    subDirId,
                    destination.fileName,
                    () => this._rapidUploadWithFallback(
                        cloud189,
                        subDirId,
                        casInfo,
                        destination.fileName,
                        file.fullPath,
                        enableFamilyTransit,
                        familyTransitFirst,
                        release.id
                    ),
                    { size: hashes.size }
                ).then(result => ({
                    fileId: String(result.value?.id || result.value?.fileId || result.response?.fileId || ''),
                    via: result.response?.via || 'verified-upload'
                }));
            const cloudRelativePath = path.posix.join(
                cloudDir === '.' ? '' : cloudDir,
                destination.fileName
            );
            const casResult = await this.casArchiveService.uploadStub(
                cloud189,
                subscription.targetFolderId,
                cloudRelativePath,
                casInfo,
                { casService: this.casService, overwrite: true }
            );

            manifest.push({
                relativePath: file.relativePath,
                sourceRelativePath: file.relativePath,
                cloudRelativePath,
                cloudFileName: destination.fileName,
                isMedia: planned.isMedia,
                organized: uploadPlan.organizeEnabled,
                size: file.size,
                md5: hashes.md5,
                sliceMd5: hashes.sliceMd5,
                cloudFileId: uploadResult.fileId,
                casFileId: casResult.fileId || '',
                casRelativePath: casResult.relativePath || '',
                via: uploadResult.via
            });
            uploadedFiles++;
            release.progress = Math.round((uploadedFiles / totalFiles) * 100);
            await releaseRepo.save(release);
        }

        release.manifestJson = JSON.stringify(manifest);
        release.casMetadataJson = JSON.stringify({ uploadedAt: new Date().toISOString(), count: manifest.length });
        release.lastError = '';
        await releaseRepo.save(release);

        // 生成 STRM 文件
        if (ConfigService.getConfigValue('pt.enableStrm', true)) {
            await this._generateStrmForRelease(account, subscription, release, manifest, {
                overwrite: Boolean(release.upgradeFromReleaseId)
            });
        }

        try {
            await this._activateUploadedRelease(release, releaseRepo);
        } catch (error) {
            release.status = STATUS.UPLOAD_FAILED;
            throw error;
        }
        logTaskEvent(`[PT] release 上传并校验完成: ${release.title} (共 ${manifest.length} 个文件)`);

        // 删除网盘源文件（复用 cas.deleteSourceAfterGenerate 配置）
        if (ConfigService.getConfigValue('cas.deleteSourceAfterGenerate', false)) {
            const isFamily = account.accountType === 'family';
            for (const entry of manifest) {
                if (entry.cloudFileId) {
                    try {
                        await this.casService.deleteSourceFileAfterGenerate(cloud189, entry.cloudFileId, entry.cloudRelativePath || entry.relativePath, isFamily);
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

    async _activateUploadedRelease(release, releaseRepo) {
        if (!release.upgradeFromReleaseId) {
            release.status = STATUS.COMPLETED;
            release.activeVersion = true;
            await releaseRepo.save(release);
            return;
        }

        const previous = await releaseRepo.findOneBy({ id: Number(release.upgradeFromReleaseId) });
        const previousActiveVersion = previous ? Boolean(previous.activeVersion) : null;
        release.status = STATUS.COMPLETED;
        release.activeVersion = true;
        await releaseRepo.save(release);
        if (!previous) return;

        previous.activeVersion = false;
        try {
            await releaseRepo.save(previous);
        } catch (error) {
            release.activeVersion = false;
            try {
                await releaseRepo.save(release);
            } catch (_) {}
            previous.activeVersion = previousActiveVersion;
            throw error;
        }
        await auditService.recordOperation('upgrade', 'completed', {
            before: { releaseId: previous.id, qualityScore: previous.qualityScore, activeVersion: previousActiveVersion },
            after: { releaseId: release.id, qualityScore: release.qualityScore, activeVersion: true },
            verification: { oldInactive: true, newActive: true },
            reason: '新版本上传与 STRM 回读验证成功',
            decisionSource: 'pt_quality_score'
        });
    }

    async _buildPtUploadPlan(subscription, release, localFiles) {
        const config = ConfigService.getConfigValue('pt.strmOrganize', {});
        const organizeEnabled = !!config.enabled && ['regex', 'ai'].includes(config.mode);
        const mediaSuffixes = new Set(
            String(ConfigService.getConfigValue('task.mediaSuffix', '') || '')
                .split(';')
                .map(value => value.trim().toLowerCase())
                .filter(value => value && value !== '.cas')
        );
        const isMedia = file => mediaSuffixes.has(path.extname(file.name || '').toLowerCase());
        const mediaFiles = localFiles.filter(isMedia);
        const releaseFolderName = safeFileName(release.title || `release-${release.id}`);

        const metadataOverride = parseJson(release.metadataAppliedOverrideJson || release.metadataOverrideJson, null);
        if (metadataOverride?.version === 1 && Array.isArray(metadataOverride.files) && metadataOverride.files.length) {
            return this._buildMetadataUploadPlan(subscription, release, localFiles, isMedia, metadataOverride);
        }

        if (!organizeEnabled || !mediaFiles.length) {
            return {
                organizeEnabled: false,
                rootRelativePath: releaseFolderName,
                files: localFiles.map(file => ({
                    source: file,
                    isMedia: isMedia(file),
                    fileName: file.name,
                    cloudRelativePath: path.posix.join(releaseFolderName, file.relativePath)
                }))
            };
        }

        let aiBase = null;
        let aiEpisodeMap = new Map();
        let libraryInfo = null;
        if (config.mode === 'ai') {
            try {
                if (!aiService.isEnabled()) {
                    throw new Error('AI 服务未启用');
                }
                const filesForAi = mediaFiles.map(file => ({ id: file.relativePath, name: file.name }));
                const response = await aiService.simpleChatCompletion(
                    release.title || subscription.name || `release-${release.id}`,
                    filesForAi
                );
                if (!response.success) {
                    throw new Error(response.error || 'AI 解析失败');
                }
                const data = response.data || {};
                aiBase = {
                    name: data.name || this._extractRegexSeriesTitle(subscription, release),
                    year: Number(data.year) || 0,
                    type: data.type === 'movie' ? 'movie' : 'tv',
                    season: data.season || ''
                };
                aiEpisodeMap = new Map(
                    (Array.isArray(data.episode) ? data.episode : []).map(item => [String(item.id), item])
                );
                libraryInfo = await this._resolveLibraryInfoByTmdb(aiBase);
                logTaskEvent(`[PT] AI 网盘整理: ${libraryInfo.categoryName}/${libraryInfo.resourceFolderName}`);
            } catch (error) {
                logTaskEvent(`[PT] AI 整理失败，降级正则: ${error.message || error}`);
            }
        }
        if (!libraryInfo) {
            const title = this._extractRegexSeriesTitle(subscription, release)
                || subscription.name
                || release.title;
            libraryInfo = await this._resolveLibraryInfoByTmdb({ name: title, year: 0, type: 'tv' });
        }

        const category = safeFileName(libraryInfo.categoryName || config.categoryFolder || '动漫');
        const resource = safeFileName(libraryInfo.resourceFolderName || subscription.name || releaseFolderName);
        const rootRelativePath = path.posix.join(category, resource);
        const plannedFiles = localFiles.map(file => {
            if (!isMedia(file)) {
                return {
                    source: file,
                    isMedia: false,
                    fileName: file.name,
                    cloudRelativePath: path.posix.join(rootRelativePath, file.relativePath)
                };
            }
            const input = { ...file, id: file.relativePath, originalFileName: file.name };
            const organized = aiBase
                ? ptRenameService.organizePathByAi(
                    subscription,
                    release,
                    input,
                    config,
                    aiBase,
                    aiEpisodeMap.get(String(file.relativePath)) || null,
                    libraryInfo.categoryName,
                    libraryInfo
                )
                : ptRenameService.organizePath(subscription, release, input, config, libraryInfo);
            const dirParts = String(organized.dirName || '').replace(/\\/g, '/').split('/').filter(Boolean);
            const relativeDir = dirParts.slice(2).join('/');
            const extension = path.extname(file.name || '');
            const baseName = String(organized.fileName || '').replace(/\.strm$/i, '')
                || path.basename(file.name, extension);
            const fileName = `${safeFileName(baseName)}${extension}`;
            return {
                source: file,
                isMedia: true,
                fileName,
                cloudRelativePath: path.posix.join(rootRelativePath, relativeDir, fileName)
            };
        });
        return { organizeEnabled: true, rootRelativePath, files: plannedFiles, libraryInfo };
    }

    async _auditReleaseMetadata(subscription, release, localFiles) {
        const releaseRepo = this._ptReleaseRepository();
        if (!this.metadataAuditExecutor) {
            throw new Error('metadata_audit Agent 未初始化，已阻止 PT release 上传');
        }
        const targets = await this.metadataAuditExecutor.metadataService.listIntentTargets(subscription.autoSeriesIntentId);
        let targetRef = '';
        for (const target of targets) {
            if (target.type !== 'pt_release') continue;
            const resolved = this.metadataAuditExecutor.metadataService.resolveTargetRef(target.targetRef, subscription.autoSeriesIntentId);
            if (Number(resolved.id) === Number(release.id)) {
                targetRef = target.targetRef;
                break;
            }
        }
        if (!targetRef) throw new Error('metadata_audit 无法取得当前 release 的受控引用');
        const audit = await this.metadataAuditExecutor.runMetadataAudit({
            intentId: subscription.autoSeriesIntentId,
            metadataTemplate: parseJson(release.metadataTemplateSnapshotJson || subscription.metadataTemplateJson, null)
        }, {
            targetRef,
            toolCallMode: 'auto'
        });
        const refreshed = await releaseRepo.findOneBy({ id: release.id });
        if (!refreshed?.metadataAppliedOverrideJson) throw new Error('metadata_audit 未产生可应用的 release 覆盖');
        release.metadataOverrideJson = refreshed.metadataOverrideJson;
        release.metadataAppliedOverrideJson = refreshed.metadataAppliedOverrideJson;
        await this._recordMetadataAudit(subscription, release, {
            changed: !audit.noop,
            fingerprint: audit.inspection?.fingerprint || '',
            mappedFiles: parseJson(refreshed.metadataAppliedOverrideJson, {})?.files?.length || 0,
            protocol: audit.protocol
        });
        return { changed: !audit.noop, override: parseJson(refreshed.metadataAppliedOverrideJson, null) };
    }

    _buildMetadataUploadPlan(subscription, release, localFiles, isMedia, override) {
        const work = override.work || {};
        const title = safeFileName(work.title || subscription.name || release.title || `release-${release.id}`);
        const year = String(work.year || '').trim();
        const category = safeFileName(work.category || (work.mediaType === 'movie' ? '电影' : '电视剧'));
        const resource = safeFileName(year && !title.includes(`(${year})`) ? `${title} (${year})` : title);
        const rootRelativePath = path.posix.join(category, resource);
        const mappings = new Map((override.files || []).map(item => [String(item.relativePath).replace(/\\/g, '/'), item]));
        const plannedFiles = localFiles.map(file => {
            const relativePath = String(file.relativePath || file.name || '').replace(/\\/g, '/');
            const mapping = mappings.get(relativePath);
            if (!isMedia(file) || !mapping) {
                return { source: file, isMedia: isMedia(file), fileName: file.name, cloudRelativePath: path.posix.join(rootRelativePath, relativePath) };
            }
            const season = mapping.special ? 0 : Number(mapping.seasonNumber ?? override.template?.defaultSeasonNumber ?? work.seasonNumber ?? 1);
            const episode = mapping.episodeNumber;
            const extension = path.extname(file.name || '');
            let fileName = String(mapping.targetFileName || '').trim();
            if (fileName && !path.extname(fileName)) fileName += extension;
            if (!fileName) {
                const episodeLabel = episode == null ? '' : ` - S${String(season).padStart(2, '0')}E${Number.isInteger(episode) ? String(episode).padStart(2, '0') : episode}`;
                const episodeTitle = mapping.episodeTitle ? ` - ${safeFileName(mapping.episodeTitle)}` : '';
                fileName = `${title}${episodeLabel}${episodeTitle}${extension}`;
            }
            fileName = safeFileName(fileName);
            const relativeDir = work.mediaType === 'movie' ? '' : `Season ${String(season).padStart(2, '0')}`;
            return { source: file, isMedia: true, fileName, cloudRelativePath: path.posix.join(rootRelativePath, relativeDir, fileName) };
        });
        const destinations = new Set();
        for (const planned of plannedFiles) {
            const key = planned.cloudRelativePath.toLowerCase();
            if (destinations.has(key)) throw new Error(`元数据计划产生目标路径冲突: ${planned.cloudRelativePath}`);
            destinations.add(key);
        }
        return { organizeEnabled: true, rootRelativePath, files: plannedFiles, metadataOverride: override };
    }

    async _recordMetadataAudit(subscription, release, summary) {
        if (!AppDataSource.isInitialized) return;
        try {
            const repo = AppDataSource.getRepository('WorkflowRun');
            const run = repo.create({
                id: require('crypto').randomUUID(), type: 'metadata_audit', status: 'completed',
                steps: [], current: 0, context: { ptSubscriptionId: subscription.id, releaseId: release.id, metadataAudit: summary },
                subjectType: 'auto_series_intent', subjectId: subscription.autoSeriesIntentId,
                protocol: 'metadata_audit', summary: summary.changed ? `自动应用 ${summary.mappedFiles} 个文件映射` : '元数据检查无差异', source: 'auto_series'
            });
            await repo.save(run);
        } catch (_) {}
    }

    async _resolvePtUploadDestination(cloud189, folderId, requestedName, hashes, release) {
        const listing = await cloud189.listFiles(folderId);
        const files = listing?.fileListAO?.fileList || [];
        const extension = path.extname(requestedName);
        const stem = path.basename(requestedName, extension);

        for (const fileName of buildPtCollisionCandidates(requestedName, release)) {
            const existing = files.find(file => file.name === fileName);
            if (!existing) {
                return { fileName, existing: false, fileId: '' };
            }
            if (await this._isSamePtCloudFile(cloud189, existing, hashes)) {
                return { fileName, existing: true, fileId: String(existing.id || existing.fileId) };
            }
        }

        let sequence = 2;
        while (sequence < 1000) {
            const fileName = `${stem} [release-${release.id}-${sequence}]${extension}`;
            const existing = files.find(file => file.name === fileName);
            if (!existing) {
                return { fileName, existing: false, fileId: '' };
            }
            if (await this._isSamePtCloudFile(cloud189, existing, hashes)) {
                return { fileName, existing: true, fileId: String(existing.id || existing.fileId) };
            }
            sequence++;
        }
        throw new Error(`无法为同名文件生成可用版本名: ${requestedName}`);
    }

    async _isSamePtCloudFile(cloud189, file, hashes) {
        let size = Number(file.size || file.fileSize || 0);
        let md5 = String(file.md5 || file.fileMd5 || '').toUpperCase();
        if (!md5 || !size) {
            const detail = await cloud189.getFileInfo(file.id || file.fileId).catch(() => null);
            size = size || Number(detail?.size || detail?.fileSize || 0);
            md5 = md5 || String(detail?.md5 || detail?.fileMd5 || '').toUpperCase();
        }
        return size === Number(hashes.size)
            && !!md5
            && md5 === String(hashes.md5 || '').toUpperCase();
    }

    async _resolveReleaseLocalPath(release) {
        let localPath = release.downloadPath || release.savePath || '';
        if ((!localPath || !fs.existsSync(localPath)) && release.qbTorrentHash) {
            const torrent = await this.downloaderFactory().getTorrent(release.qbTorrentHash).catch(() => null);
            const livePath = torrent?.contentPath || torrent?.savePath || '';
            if (livePath && fs.existsSync(livePath)) {
                localPath = livePath;
                release.downloadPath = livePath;
                await this._ptReleaseRepository().save(release);
                logTaskEvent(`[PT] 已从下载器修正本地路径: ${livePath}`);
            }
        }
        if (!localPath || !fs.existsSync(localPath)) {
            return localPath;
        }

        const stat = fs.statSync(localPath);
        if (!stat.isDirectory()) {
            return localPath;
        }

        const rootName = String(release.localRootName || '').trim();
        if (!rootName || path.basename(localPath) === rootName) {
            return localPath;
        }

        const rootedPath = path.join(localPath, rootName);
        return fs.existsSync(rootedPath) ? rootedPath : localPath;
    }

    async _rapidUploadWithFallback(cloud189, parentFolderId, casInfo, fileName, localFilePath, enableFamilyTransit, familyTransitFirst, releaseId = null) {
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
            this._startCloudUploadTransfer(releaseId);
            try {
                const result = await this.casService._uploadStreamFile(cloud189, parentFolderId, fileName, localFilePath, {
                    onProgress: progress => this._updateCloudUploadTransfer(releaseId, progress)
                });
                return { fileId: result.fileId, via: 'real-upload' };
            } finally {
                this._finishCloudUploadTransfer(releaseId);
            }
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
        const created = (await this.mutationExecutor.createFolder(cloud189, parentFolderId, safeName)).value;
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

    async _generateStrmForRelease(account, subscription, release, manifest, options = {}) {
        if (!account.localStrmPrefix) {
            logTaskEvent(`[PT] 账号未配置 STRM 本地前缀，跳过 STRM 生成`);
            return;
        }

        const strmService = new StrmService();
        const streamProxyService = new StreamProxyService();
        const organizeEnabled = manifest.some(entry => entry.organized === true);
        const files = manifest
            .filter(m => m.cloudFileId && m.isMedia !== false)
            .map(m => {
                const originalFileName = m.cloudFileName || path.basename(m.cloudRelativePath || m.relativePath);
                return {
                    name: originalFileName,
                    relativeDir: path.posix.dirname(m.cloudRelativePath || m.relativePath) === '.'
                        ? ''
                        : path.posix.dirname(m.cloudRelativePath || m.relativePath),
                    id: m.cloudFileId,
                    originalFileName,
                    sourceFileName: m.cloudFileName || originalFileName,
                    sourceRelativeDir: path.posix.dirname(m.cloudRelativePath || m.relativePath) === '.'
                        ? ''
                        : path.posix.dirname(m.cloudRelativePath || m.relativePath)
                };
            });

        if (!files.length) {
            logTaskEvent(`[PT] manifest 中没有已上传的文件，跳过 STRM 生成`);
            return;
        }

        const accountId = Number(account.id);
        const targetFolderId = String(subscription.targetFolderId || '');

        // 确定目标根目录（剥裸 strm 前缀，避免 strm/strm）
        let targetRoot;
        if (organizeEnabled) {
            const firstParts = String(files[0].relativeDir || '').split('/').filter(Boolean);
            targetRoot = joinLocalStrmPath(account.localStrmPrefix, ...firstParts.slice(0, 2));
            for (const file of files) {
                const parts = String(file.relativeDir || '').split('/').filter(Boolean);
                file.relativeDir = parts.slice(2).join('/');
            }
        } else {
            // 原始模式：使用 {normalizedPrefix}/PT/{subName}/{relName}
            const subName = safeFileName(subscription.name || `sub-${subscription.id}`);
            const relName = safeFileName(release.title || `release-${release.id}`);
            targetRoot = joinLocalStrmPath(account.localStrmPrefix, 'PT', subName, relName);
            const releaseFolderName = String(release.cloudFolderName || relName).replace(/\\/g, '/');
            for (const file of files) {
                if (file.relativeDir === releaseFolderName) {
                    file.relativeDir = '';
                    continue;
                }
                if (file.relativeDir.startsWith(`${releaseFolderName}/`)) {
                    file.relativeDir = file.relativeDir.slice(releaseFolderName.length + 1);
                }
            }
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
            Boolean(options.overwrite),
            false,
            'default'
        );

        if (options.overwrite) {
            await this._verifyGeneratedStrmTargets(strmService, targetRoot, files);
        }

        logTaskEvent(`[PT] STRM 生成完成: ${targetRoot} (共 ${files.length} 个文件)`);
    }

    async _verifyGeneratedStrmTargets(strmService, targetRoot, files) {
        const targetDir = strmService._resolveBasePath(targetRoot);
        for (const file of files) {
            const relativePath = strmService._buildRelativeStrmPath(file.relativeDir || '', file.name);
            const content = await fsp.readFile(path.join(targetDir, relativePath), 'utf8');
            let payload = null;
            try {
                const token = new URL(String(content || '').trim()).pathname.split('/').filter(Boolean).at(-1);
                payload = new StreamProxyService().parseToken(token);
            } catch (_) {}
            if (String(payload?.fileId || '') !== String(file.id || '')) {
                throw new Error(`STRM 升级验证失败: ${relativePath}`);
            }
        }
    }

    // ==================== AI/TMDB 媒体库目录 ====================

    /**
     * 按 OrganizerService 的规则，调 TMDB 决定媒体库目录
     * @param {{name:string, year:number, type:'tv'|'movie'}} aiBase
     * @returns {Promise<object>} 媒体库目录信息，失败回退 AI 结果
     */
    async _resolveLibraryInfoByTmdb(aiBase) {
        const organizerService = new OrganizerService(null);
        const resourceInfo = {
            name: aiBase?.name || '',
            year: Number(aiBase?.year) || 0,
            type: aiBase?.type || 'tv'
        };
        try {
            if (!aiBase || !aiBase.name) {
                return organizerService._resolveLibraryInfo({ resourceName: '' }, resourceInfo, null);
            }

            const apiKey = ConfigService.getConfigValue('tmdb.tmdbApiKey') || ConfigService.getConfigValue('tmdb.apiKey');
            if (!apiKey) {
                logTaskEvent(`[PT] TMDB API Key 未配置，按 AI 结果生成媒体库目录`);
                return organizerService._resolveLibraryInfo({ resourceName: aiBase.name }, resourceInfo, null);
            }

            const tmdb = new TMDBService();
            const year = aiBase.year && aiBase.year > 0 ? aiBase.year : '';
            let tmdbInfo;
            if (aiBase.type === 'movie') {
                tmdbInfo = await tmdb.searchMovie(aiBase.name, year);
            } else {
                tmdbInfo = await tmdb.searchTV(aiBase.name, year, 0);
            }

            return organizerService._resolveLibraryInfo({ resourceName: aiBase.name }, resourceInfo, tmdbInfo || null);
        } catch (err) {
            logTaskEvent(`[PT] TMDB 媒体库目录查询失败，按 AI 结果生成目录: ${err.message || err}`);
            return organizerService._resolveLibraryInfo({ resourceName: aiBase?.name || '' }, resourceInfo, null);
        }
    }

    _extractRegexSeriesTitle(subscription, release) {
        const candidates = [
            subscription?.name,
            release?.title
        ];
        for (const candidate of candidates) {
            const title = this._cleanRegexSeriesTitle(candidate);
            if (title) {
                return title;
            }
        }
        return '';
    }

    _cleanRegexSeriesTitle(value = '') {
        let title = String(value || '').trim();
        if (!title) {
            return '';
        }
        title = title
            .replace(/\[[^\]]+\]/g, ' ')
            .replace(/【[^】]+】/g, ' ')
            .replace(/（[^）]*(字幕组|字幕|发布|發佈|组|組)[^）]*）/gi, ' ')
            .replace(/\([^)]*(字幕组|字幕|发布|發佈|组|組)[^)]*\)/gi, ' ')
            .replace(/[._]+/g, ' ')
            .replace(/從/g, '从')
            .replace(/異/g, '异')
            .replace(/開始/g, '开始')
            .replace(/第[一二三四五六七八九十百0-9]+[季期部].*$/i, '')
            .replace(/\b\d+(?:st|nd|rd|th)\s+Season.*$/i, '')
            .replace(/\bSeason\s*\d+.*$/i, '')
            .replace(/\bS\d{1,2}\b.*$/i, '')
            .replace(/\s+-\s+\d{1,3}(?:\.\d+)?\b.*$/i, '')
            .replace(/\s+-\s*(ANi|Skymoon.*|天月.*|.*字幕.*|.*发布.*|.*發佈.*)$/i, '')
            .replace(/\s+/g, ' ')
            .trim();
        return title;
    }

    // ==================== 清理 ====================

    async runCleanup() {
        if (!ConfigService.getConfigValue('pt.cleanupEnabled', true)) {
            return { skipped: true };
        }
        const releaseRepo = getPtReleaseRepository();
        const completed = await releaseRepo.find({ where: { status: STATUS.COMPLETED } });
        const downloader = this.downloaderFactory();
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
        const releaseRepo = this._ptReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            throw new Error('release 不存在');
        }
        let shouldDispatch = false;
        if ([STATUS.FAILED, STATUS.UPLOAD_FAILED].includes(release.status)) {
            release.status = release.qbTorrentHash ? STATUS.DOWNLOADING : STATUS.PENDING;
            shouldDispatch = !release.qbTorrentHash;
        } else if (release.status === STATUS.PENDING) {
            shouldDispatch = true;
        } else if (release.status === STATUS.DOWNLOADING) {
            release.lastError = '';
            await releaseRepo.save(release);
            await this._refreshDownloadStatus(release);
            return release;
        } else {
            // downloaded/uploading 直接重新跑上传
            release.status = STATUS.DOWNLOADED;
        }
        release.lastError = '';
        await releaseRepo.save(release);
        if (shouldDispatch) {
            const subscription = await this._ptSubscriptionRepository().findOneBy({ id: release.subscriptionId });
            if (!subscription) {
                throw new Error(`找不到订阅 ${release.subscriptionId}`);
            }
            await this._dispatchToDownloader(subscription, release);
        }
        // 立即触发一次处理
        this.runProcessing().catch((err) => logTaskEvent(`[PT] retry 后处理失败: ${err.message || err}`));
        return release;
    }

    async listReleasesWithDownloader({ subscriptionId = null, limit = 500 } = {}) {
        const releaseRepo = this._ptReleaseRepository();
        const findOptions = {
            order: { id: 'DESC' },
            take: Math.min(Math.max(Number(limit) || 100, 1), 500)
        };
        if (subscriptionId != null) {
            findOptions.where = { subscriptionId: Number(subscriptionId) };
        }
        const releases = await releaseRepo.find(findOptions);
        const hashes = new Set(releases.map(release => String(release.qbTorrentHash || '').toLowerCase()).filter(Boolean));
        if (!hashes.size) {
            return releases.map(release => ({ ...release, downloader: null }));
        }

        try {
            const downloader = this.downloaderFactory();
            if (typeof downloader.listNormalizedTorrents !== 'function') {
                return releases.map(release => ({ ...release, downloader: null }));
            }
            const torrents = await downloader.listNormalizedTorrents();
            const torrentByHash = new Map(torrents.map(torrent => [String(torrent.hash || '').toLowerCase(), torrent]));
            return releases.map(release => {
                const hash = String(release.qbTorrentHash || '').toLowerCase();
                const torrent = hash ? torrentByHash.get(hash) : null;
                return {
                    ...release,
                    downloader: torrent ? {
                        state: torrent.state,
                        progress: Math.round((torrent.progress || 0) * 100),
                        downloadSpeed: torrent.downloadSpeed,
                        uploadSpeed: torrent.uploadSpeed,
                        eta: torrent.eta,
                        seeds: torrent.seeds,
                        peers: torrent.peers,
                        availability: torrent.availability,
                        amountLeft: torrent.amountLeft,
                        isQueued: torrent.isQueued,
                        isStopped: torrent.isStopped
                    } : (hash ? { state: release.status === STATUS.COMPLETED ? 'cleaned' : 'missing' } : null)
                };
            });
        } catch (err) {
            logTaskEvent(`[PT] 获取下载器快照失败: ${err.message || err}`);
            return releases.map(release => ({ ...release, downloader: null }));
        }
    }

    // ==================== STRM 重建（不重新下载/上传，仅从已存清单重生成） ====================

    // 重建单个 release 的 STRM
    async rebuildStrm(releaseId) {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM 功能未启用，请先在「媒体设置」开启 STRM 后再重建');
        }
        const release = await getPtReleaseRepository().findOneBy({ id: Number(releaseId) });
        if (!release) {
            throw new Error('release 不存在');
        }
        const result = await this._rebuildStrmForRelease(release);
        if (result.status !== 'ok') {
            // 单个重建：把跳过原因直接抛给前端
            throw new Error(result.reason);
        }
        return result;
    }

    // 批量重建所有已完成 release 的 STRM
    async rebuildAllStrm() {
        if (!ConfigService.getConfigValue('strm.enable')) {
            throw new Error('STRM 功能未启用，请先在「媒体设置」开启 STRM 后再重建');
        }
        const releases = await getPtReleaseRepository().find({
            where: { status: STATUS.COMPLETED },
            order: { id: 'ASC' }
        });
        const summary = { total: releases.length, ok: 0, skipped: 0, failed: 0, details: [] };
        for (const release of releases) {
            try {
                const r = await this._rebuildStrmForRelease(release);
                summary[r.status === 'ok' ? 'ok' : 'skipped']++;
                summary.details.push({ id: release.id, title: release.title, ...r });
            } catch (err) {
                summary.failed++;
                const reason = String(err.message || err).slice(0, 300);
                summary.details.push({ id: release.id, title: release.title, status: 'failed', reason });
                logTaskEvent(`[PT] 重建 STRM 失败 release ${release.id}: ${reason}`);
            }
        }
        logTaskEvent(`[PT] 批量重建 STRM 完成: 共${summary.total} 成功${summary.ok} 跳过${summary.skipped} 失败${summary.failed}`);
        return summary;
    }

    // 内部复用：从 manifest 重建单个 release 的 STRM。返回 {status:'ok'|'skipped', reason?, files?}；硬错误向上抛
    async _rebuildStrmForRelease(release) {
        if (!release.manifestJson) {
            return { status: 'skipped', reason: '无 manifest（可能从未上传完成）' };
        }
        let manifest;
        try {
            manifest = JSON.parse(release.manifestJson);
        } catch (err) {
            return { status: 'skipped', reason: 'manifest 解析失败' };
        }
        const valid = Array.isArray(manifest) ? manifest.filter(m => m.cloudFileId) : [];
        if (!valid.length) {
            return { status: 'skipped', reason: 'manifest 中无有效云盘文件' };
        }
        const subscription = await getPtSubscriptionRepository().findOneBy({ id: release.subscriptionId });
        if (!subscription) {
            return { status: 'skipped', reason: `找不到订阅 ${release.subscriptionId}` };
        }
        const account = await getAccountRepository().findOneBy({ id: subscription.accountId });
        if (!account) {
            return { status: 'skipped', reason: `找不到账号 ${subscription.accountId}` };
        }
        if (!account.localStrmPrefix) {
            return { status: 'skipped', reason: '账号未配置本地 STRM 前缀' };
        }
        await this._generateStrmForRelease(account, subscription, release, manifest);
        return { status: 'ok', files: valid.length };
    }

    async deleteRelease(releaseId, deleteLocalFiles = true) {
        const releaseRepo = getPtReleaseRepository();
        const release = await releaseRepo.findOneBy({ id: Number(releaseId) });
        if (!release) {
            return;
        }
        if (release.qbTorrentHash) {
            try {
                const downloader = this.downloaderFactory();
                await downloader.deleteTorrent(release.qbTorrentHash, deleteLocalFiles);
            } catch (err) {
                logTaskEvent(`[PT] 删除 qb 任务失败: ${err.message || err}`);
            }
        }
        await releaseRepo.delete({ id: release.id });
    }
}

const ptService = new PtService();
module.exports = { PtService, ptService, PT_STATUS: STATUS, buildPtCollisionCandidates, mediaPreferenceSatisfies, getCandidateFilters, hasCandidateFilters };
