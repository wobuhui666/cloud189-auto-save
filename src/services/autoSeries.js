const ConfigService = require('./ConfigService');
const { TMDBService } = require('./tmdb');
const { AppDataSource } = require('../database');
const { InvalidResourceService } = require('./invalidResource');
const { createNoCoverageError } = require('./operationError');
const { DEFAULT_MEDIA_PREFERENCE, normalizeMediaPreference } = require('./mediaPreference');
const { buildMetadataTemplate } = require('./metadataOverride');

const AUTO_SERIES_SOURCES = ['cloudsaver', 'hdhive', 'pt', 'subscription'];
const DEFAULT_SOURCE_PREFERENCES = AUTO_SERIES_SOURCES.map(source => ({ source, enabled: true }));
const AUTO_SERIES_SOURCE_TIMEOUT_MS = 45000;
const DEFAULT_AUTO_SERIES_SETTINGS = Object.freeze({
    accountId: '',
    targetFolderId: '',
    targetFolder: '',
    mode: 'lazy',
    sourcePreferences: DEFAULT_SOURCE_PREFERENCES,
    keepCasAfterRestore: false,
    allowHdhivePoints: false,
    hdhiveMaxPoints: 10,
    agentEnabled: false,
    toolCallMode: 'auto',
    mediaPreference: DEFAULT_MEDIA_PREFERENCE
});

function withTimeout(promise, timeoutMs, message) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

function normalizeHdhivePointPolicy({ allowHdhivePoints = false, hdhiveMaxPoints = 0 } = {}) {
    const allowPoints = allowHdhivePoints === true
        || allowHdhivePoints === 1
        || String(allowHdhivePoints || '').trim().toLowerCase() === 'true'
        || String(allowHdhivePoints || '').trim() === '1';
    if (!allowPoints) {
        return { allowPoints: false, maxPoints: 0 };
    }

    const maxPoints = Number(hdhiveMaxPoints);
    if (!Number.isSafeInteger(maxPoints) || maxPoints < 0) {
        throw new Error('影巢单个资源积分上限必须是大于或等于 0 的整数');
    }
    return { allowPoints: true, maxPoints };
}

function canUseHdhiveResource(resource, pointPolicy) {
    if (!resource || resource.expired) return false;
    if (resource.isUnlocked || resource.isFree) return true;
    if (!pointPolicy?.allowPoints) return false;
    if (resource.points === null || resource.points === undefined || resource.points === '') return false;

    const points = Number(resource.points);
    return Number.isSafeInteger(points) && points >= 0 && points <= pointPolicy.maxPoints;
}

function validateHdhiveResourceBeforeUnlock(resource, pointPolicy) {
    if (!resource || resource.expired) {
        return '影巢资源不存在或已失效，已取消解锁';
    }
    if (resource.isUnlocked || resource.isFree) return '';
    if (!pointPolicy?.allowPoints) {
        return '该影巢资源需要积分，当前未允许消耗积分';
    }
    if (resource.points === null || resource.points === undefined || resource.points === '') {
        return '该影巢资源积分未知，为避免误扣积分已取消解锁';
    }

    const points = Number(resource.points);
    if (!Number.isSafeInteger(points) || points < 0) {
        return '该影巢资源积分未知，为避免误扣积分已取消解锁';
    }
    if (points > pointPolicy.maxPoints) {
        return `该影巢资源需要 ${points} 积分，超过单个资源上限 ${pointPolicy.maxPoints} 积分`;
    }
    return '';
}

function normalizeResourceSlug(value) {
    const normalized = String(value || '').trim();
    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}

function inferAutoSeriesMediaType(title = '') {
    return /剧场版|大电影|电影版|\b(?:the\s+movie|movie|film)\b/i.test(String(title || '')) ? 'movie' : 'tv';
}

function normalizeTmdbLookupTitle(title = '', mediaType = inferAutoSeriesMediaType(title)) {
    const normalized = String(title || '').trim();
    const suffix = mediaType === 'movie'
        ? /\s*(?:剧场版|大电影|电影版|the\s+movie|movie|film)\s*$/i
        : /\s*(?:第\s*[一二两三四五六七八九十百\d]+\s*季|S\d{1,3}|Season\s*\d{1,3})\s*$/i;
    return normalized.replace(suffix, '').trim() || normalized;
}

function normalizeSourcePreferences(input) {
    const items = Array.isArray(input) ? input : [];
    const normalized = [];
    const seen = new Set();
    for (const item of items) {
        const source = String(item?.source || '').trim().toLowerCase();
        if (!AUTO_SERIES_SOURCES.includes(source) || seen.has(source)) continue;
        seen.add(source);
        normalized.push({ source, enabled: item?.enabled !== false });
    }
    for (const source of AUTO_SERIES_SOURCES) {
        if (!seen.has(source)) normalized.push({ source, enabled: true });
    }
    return normalized;
}

function normalizeAutoSeriesSettings(input = {}) {
    const settings = input && typeof input === 'object' ? input : {};
    const mode = String(settings.mode || DEFAULT_AUTO_SERIES_SETTINGS.mode).trim().toLowerCase();
    const toolCallMode = String(settings.toolCallMode || DEFAULT_AUTO_SERIES_SETTINGS.toolCallMode).trim().toLowerCase();
    const hdhiveMaxPoints = Number(settings.hdhiveMaxPoints ?? DEFAULT_AUTO_SERIES_SETTINGS.hdhiveMaxPoints);
    if (!['lazy', 'normal', 'auto'].includes(mode)) {
        throw new Error('自动追剧模式必须是 lazy 或 normal');
    }
    if (!['auto', 'native', 'json'].includes(toolCallMode)) {
        throw new Error('工具协议必须是 auto、native 或 json');
    }
    if (!Number.isSafeInteger(hdhiveMaxPoints) || hdhiveMaxPoints < 0) {
        throw new Error('影巢单个资源积分上限必须是大于或等于 0 的整数');
    }
    return {
        accountId: String(settings.accountId || '').trim(),
        targetFolderId: String(settings.targetFolderId || '').trim(),
        targetFolder: String(settings.targetFolder || '').trim(),
        mode: mode === 'auto' ? 'normal' : mode,
        sourcePreferences: normalizeSourcePreferences(settings.sourcePreferences),
        keepCasAfterRestore: settings.keepCasAfterRestore === true,
        allowHdhivePoints: settings.allowHdhivePoints === true,
        hdhiveMaxPoints,
        agentEnabled: settings.agentEnabled === true,
        toolCallMode,
        mediaPreference: normalizeMediaPreference(settings.mediaPreference || DEFAULT_MEDIA_PREFERENCE)
    };
}

class AutoSeriesService {
    constructor(taskService, accountRepo, lazyShareStrmService) {
        this.taskService = taskService;
        this.accountRepo = accountRepo;
        this.lazyShareStrmService = lazyShareStrmService;
        this.tmdbService = new TMDBService();
        this.invalidResourceService = new InvalidResourceService();
    }

    getSourcePreferences() {
        return this.getSettings().sourcePreferences;
    }

    saveSourcePreferences(preferences) {
        const normalized = normalizeSourcePreferences(preferences);
        ConfigService.setConfigValue('task.autoCreate.sourcePreferences', normalized);
        return normalized;
    }

    getSettings() {
        return normalizeAutoSeriesSettings(
            ConfigService.getConfigValue('task.autoCreate', DEFAULT_AUTO_SERIES_SETTINGS)
        );
    }

    async saveSettings(input = {}) {
        const normalized = normalizeAutoSeriesSettings(input);
        if (!normalized.accountId) throw new Error('请选择自动追剧默认账号');
        if (!normalized.targetFolderId || !normalized.targetFolder) throw new Error('请选择自动追剧默认保存目录');
        if (!normalized.sourcePreferences.some(item => item.enabled)) throw new Error('请至少启用一个自动追剧来源');
        const account = await this.accountRepo.findOneBy({ id: Number(normalized.accountId) });
        if (!account) throw new Error('自动追剧默认账号不存在');

        const current = ConfigService.getConfigValue('task.autoCreate', {});
        ConfigService.setConfigValue('task.autoCreate', { ...current, ...normalized });
        return normalized;
    }

    async createByTitle({
        title,
        year = '',
        mode,
        shareLink = '',
        resourceTitle = '',
        resourceSlug = '',
        source = '',
        sources = null,
        keepCasAfterRestore,
        allowHdhivePoints,
        hdhiveMaxPoints,
        accountId: requestedAccountId = null,
        targetFolderId: requestedTargetFolderId = '',
        targetFolder: requestedTargetFolder = '',
        mediaPreference,
        subscriptionResourceId = 0,
        coverageScope = null,
        metadataOverride = null,
        autoSeriesIntentId = ''
    }) {
        const autoCreateConfig = this.getSettings();
        const normalizedTitle = String(title || '').trim();
        const normalizedYear = String(year || '').trim();
        const normalizedMode = this._normalizeMode(mode ?? autoCreateConfig.mode);
        const manualShareLink = String(shareLink || '').trim();
        const manualResourceTitle = String(resourceTitle || '').trim();
        const shouldKeepCasAfterRestore = Boolean(keepCasAfterRestore ?? autoCreateConfig.keepCasAfterRestore);
        const resolvedAllowHdhivePoints = allowHdhivePoints ?? autoCreateConfig.allowHdhivePoints;
        const resolvedHdhiveMaxPoints = hdhiveMaxPoints ?? autoCreateConfig.hdhiveMaxPoints;
        const resolvedMediaPreference = normalizeMediaPreference(mediaPreference || autoCreateConfig.mediaPreference);
        const hdhivePointPolicy = normalizeHdhivePointPolicy({
            allowHdhivePoints: resolvedAllowHdhivePoints,
            hdhiveMaxPoints: resolvedHdhiveMaxPoints
        });
        if (!normalizedTitle) {
            throw new Error('剧名不能为空');
        }
        if (!['normal', 'lazy'].includes(normalizedMode)) {
            throw new Error('无效的自动追剧模式');
        }

        const accountId = parseInt(requestedAccountId || autoCreateConfig.accountId);
        const targetFolderId = String(requestedTargetFolderId || autoCreateConfig.targetFolderId || '').trim();
        const targetFolder = String(requestedTargetFolder || autoCreateConfig.targetFolder || '').trim();

        if (!accountId) {
            throw new Error('请先在系统设置中配置自动追剧默认账号');
        }
        if (!targetFolderId || !targetFolder) {
            throw new Error('请先在系统设置中配置自动追剧默认保存目录');
        }

        const account = await this.accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('自动追剧默认账号不存在');
        }

        const tmdbInfo = await this._resolveTmdb(normalizedTitle, normalizedYear);
        let selectedShareLink = manualShareLink;
        if (!selectedShareLink && source === 'hdhive' && resourceSlug) {
            const unlocked = await this._unlockHdhiveResource(
                String(resourceSlug),
                tmdbInfo,
                hdhivePointPolicy
            );
            if (!unlocked?.success || !unlocked.data?.link) {
                throw new Error(unlocked?.error || '影巢资源解锁失败');
            }
            selectedShareLink = unlocked.data.link;
        }
        if (!selectedShareLink && source === 'subscription' && Number(subscriptionResourceId) > 0) {
            if (!AppDataSource.isInitialized) throw new Error('订阅资源库未初始化');
            const resource = await AppDataSource.getRepository('SubscriptionResource').findOneBy({ id: Number(subscriptionResourceId) });
            if (!resource || resource.verifyStatus !== 'valid' || !resource.shareLink) throw new Error('手动选择的订阅资源已失效');
            selectedShareLink = String(resource.shareLink);
        }
        if (selectedShareLink) {
            if (await this.invalidResourceService.isInvalid(selectedShareLink, 'cloud_share')) {
                throw new Error('该分享资源处于失效缓存中，请稍后重试或人工解除');
            }
            return await this._createCloudTask({
                account,
                targetFolderId,
                targetFolder,
                mode: normalizedMode,
                resource: { title: manualResourceTitle || normalizedTitle, cloudLinks: [{ link: selectedShareLink }] },
                taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                tmdbInfo,
                source: AUTO_SERIES_SOURCES.includes(source) ? source : 'manual',
                keepCasAfterRestore: shouldKeepCasAfterRestore,
                coverageScope,
                metadataOverride,
                autoSeriesIntentId
            });
        }

        const requestedSources = Array.isArray(sources)
            ? new Set(sources.map(item => String(item).trim().toLowerCase()))
            : null;
        const activePreferences = this.getSourcePreferences()
            .filter(item => item.enabled && (!requestedSources || requestedSources.has(item.source)));
        const errors = [];
        for (const preference of activePreferences) {
            try {
                if (preference.source === 'cloudsaver') {
                    const resource = await this._findBestResource(normalizedTitle, normalizedYear, tmdbInfo);
                    if (!resource?.cloudLinks?.[0]?.link) throw new Error('未找到可用资源');
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'cloudsaver',
                        keepCasAfterRestore: shouldKeepCasAfterRestore,
                        metadataOverride,
                        autoSeriesIntentId
                    });
                }
                if (preference.source === 'hdhive') {
                    const resource = await this._findBestHdhiveResource(
                        normalizedTitle,
                        normalizedYear,
                        tmdbInfo,
                        hdhivePointPolicy
                    );
                    if (!resource?.cloudLinks?.[0]?.link) {
                        throw new Error(hdhivePointPolicy.allowPoints
                            ? `未找到免费、已解锁或不超过 ${hdhivePointPolicy.maxPoints} 积分的资源`
                            : '未找到免费或已解锁资源');
                    }
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'hdhive',
                        keepCasAfterRestore: shouldKeepCasAfterRestore,
                        metadataOverride,
                        autoSeriesIntentId
                    });
                }
                if (preference.source === 'pt') {
                    const { ptService } = require('./ptService');
                    return await ptService.createAutoSeriesSubscription({
                        title: normalizedTitle,
                        year: normalizedYear,
                        tmdbInfo,
                        accountId: account.id,
                        targetFolderId,
                        targetFolder,
                        mediaPreference: resolvedMediaPreference,
                        filterManagedBy: 'manual',
                        metadataTemplate: metadataOverride || buildMetadataTemplate(tmdbInfo || {}, 'template'),
                        autoSeriesIntentId
                    });
                }
                if (preference.source === 'subscription') {
                    const resource = await this._findBestSubscriptionResource(normalizedTitle, normalizedYear, tmdbInfo);
                    if (!resource?.cloudLinks?.[0]?.link) throw new Error('订阅中未找到匹配资源');
                    return await this._createCloudTask({
                        account,
                        targetFolderId,
                        targetFolder,
                        mode: normalizedMode,
                        resource,
                        taskName: this._buildTaskName(normalizedTitle, tmdbInfo),
                        tmdbInfo,
                        source: 'subscription',
                        keepCasAfterRestore: shouldKeepCasAfterRestore,
                        metadataOverride,
                        autoSeriesIntentId
                    });
                }
            } catch (error) {
                errors.push(`${preference.source}: ${error.message || error}`);
            }
        }
        if (!activePreferences.length) {
            throw new Error('请至少启用一个自动追剧来源');
        }
        throw createNoCoverageError(`所有自动追剧来源均无覆盖：${errors.join('；')}`, {
            source: 'auto_series',
            operation: 'search_sources'
        });
    }

    _buildTaskName(title, tmdbInfo) {
        return tmdbInfo?.title
            ? `${tmdbInfo.title}${tmdbInfo.releaseDate ? ` (${new Date(tmdbInfo.releaseDate).getFullYear()})` : ''}`
            : title;
    }

    async _createCloudTask({ account, targetFolderId, targetFolder, mode, resource, taskName, tmdbInfo, source, keepCasAfterRestore, coverageScope = null, metadataOverride = null, autoSeriesIntentId = '' }) {
        const totalEpisodes = Number(tmdbInfo?.totalEpisodes || 0) > 0
            ? Number(tmdbInfo.totalEpisodes)
            : (tmdbInfo?.status === 'Ended'
                ? Number(tmdbInfo?.lastEpisodeToAir?.episode_number || 0)
                : 0);

        if (mode === 'lazy') {
            const result = await this._createLazySeries({
                account,
                targetFolderId,
                targetFolder,
                resource,
                taskName,
                tmdbInfo,
                keepCasAfterRestore: Boolean(keepCasAfterRestore),
                coverageScope,
                metadataOverride,
                autoSeriesIntentId
            });
            return { ...result, source };
        }

        const tasks = await this.taskService.createTask({
            accountId: account.id,
            shareLink: resource.cloudLinks[0].link,
            totalEpisodes,
            targetFolderId,
            targetFolder,
            matchPattern: '',
            matchOperator: 'lt',
            matchValue: '',
            overwriteFolder: 0,
            remark: '自动追剧',
            taskGroup: '自动追剧',
            enableCron: false,
            cronExpression: '',
            selectedFolders: [],
            sourceRegex: '',
            targetRegex: '',
            taskName,
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : null,
            enableTaskScraper: true,
            enableLazyStrm: false,
            enableOrganizer: true,
            keepCasAfterRestore: Boolean(keepCasAfterRestore),
            coverageScope,
            metadataOverride: metadataOverride || buildMetadataTemplate(tmdbInfo || {}, 'agent'),
            autoSeriesIntentId
        });

        // createTask 内部已异步触发首次执行，这里不再阻塞等待

        return {
            taskCount: tasks?.length || 0,
            resourceTitle: resource.title,
            shareLink: resource.cloudLinks[0].link,
            taskName,
            tmdbId: tmdbInfo?.id || null,
            mode: 'normal',
            source,
            taskIds: (tasks || []).map(task => task.id)
        };
    }

    async _createLazySeries({ account, targetFolderId, targetFolder = '', resource, taskName, tmdbInfo, keepCasAfterRestore = false, coverageScope = null, metadataOverride = null, autoSeriesIntentId = '' }) {
        if (!this.lazyShareStrmService) {
            throw new Error('懒转存服务未初始化');
        }
        if (!account.localStrmPrefix) {
            throw new Error('默认账号未配置本地STRM目录，无法执行懒转存模式');
        }

        const resolvedTargetFolder = String(targetFolder || '').trim();
        const totalEpisodes = Number(tmdbInfo?.totalEpisodes || 0) > 0
            ? Number(tmdbInfo.totalEpisodes)
            : (tmdbInfo?.status === 'Ended'
                ? Number(tmdbInfo?.lastEpisodeToAir?.episode_number || 0)
                : 0);

        const tasks = await this.taskService.createTask({
            accountId: account.id,
            shareLink: resource.cloudLinks[0].link,
            totalEpisodes,
            targetFolderId,
            targetFolder: resolvedTargetFolder,
            matchPattern: '',
            matchOperator: 'lt',
            matchValue: '',
            overwriteFolder: 0,
            remark: '自动追剧',
            taskGroup: '自动追剧',
            enableCron: false,
            cronExpression: '',
            selectedFolders: [],
            sourceRegex: '',
            targetRegex: '',
            taskName,
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : null,
            enableTaskScraper: false,
            enableLazyStrm: true,
            enableOrganizer: true,
            keepCasAfterRestore: Boolean(keepCasAfterRestore),
            coverageScope,
            metadataOverride: metadataOverride || buildMetadataTemplate(tmdbInfo || {}, 'agent'),
            autoSeriesIntentId
        });

        // createTask 内部已异步触发首次执行，这里不再阻塞等待

        return {
            taskCount: tasks?.length || 0,
            resourceTitle: resource.title,
            shareLink: resource.cloudLinks[0].link,
            taskName,
            tmdbId: tmdbInfo?.id || null,
            mode: 'lazy',
            taskIds: (tasks || []).map(task => task.id)
        };
    }

    async _resolveTmdb(title, year) {
        const mediaType = inferAutoSeriesMediaType(title);
        const lookupTitle = normalizeTmdbLookupTitle(title, mediaType);
        try {
            const lookup = mediaType === 'movie'
                ? this.tmdbService.searchMovie(lookupTitle, year)
                : this.tmdbService.searchTV(lookupTitle, year, 0);
            const resolved = await withTimeout(
                lookup,
                AUTO_SERIES_SOURCE_TIMEOUT_MS,
                'TMDB 查询超时'
            );
            if (resolved || lookupTitle === String(title || '').trim()) return resolved;
            const fallback = mediaType === 'movie'
                ? this.tmdbService.searchMovie(title, year)
                : this.tmdbService.searchTV(title, year, 0);
            return await withTimeout(fallback, AUTO_SERIES_SOURCE_TIMEOUT_MS, 'TMDB 查询超时');
        } catch (error) {
            return null;
        }
    }

    async searchResources({
        title,
        year = '',
        sources = null,
        allowHdhivePoints = false,
        hdhiveMaxPoints = 0
    }) {
        const normalizedTitle = String(title || '').trim();
        const normalizedYear = String(year || '').trim();
        if (!normalizedTitle) {
            throw new Error('剧名不能为空');
        }

        const tmdbInfo = await this._resolveTmdb(normalizedTitle, normalizedYear);
        const requestedSources = this._normalizeSearchSources(sources);
        const hdhivePointPolicy = normalizeHdhivePointPolicy({ allowHdhivePoints, hdhiveMaxPoints });

        const titleCandidates = [
            normalizedTitle,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = normalizedYear
            || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const resources = [];
        if (requestedSources.includes('cloudsaver')) {
            const cloudResources = await this._fetchResources(normalizedTitle, tmdbInfo).catch(() => []);
            resources.push(...cloudResources
            .map(resource => ({
                messageId: resource.messageId,
                title: resource.title,
                shareLink: resource.cloudLinks?.[0]?.link || '',
                score: this._scoreResource(resource, titleCandidates, targetYear),
                source: 'cloudsaver'
            }))
            .filter(item => item.shareLink));
        }
        if (requestedSources.includes('hdhive')) {
            const hdhiveResources = await this._searchHdhiveResources(
                titleCandidates,
                targetYear,
                tmdbInfo,
                hdhivePointPolicy
            ).catch(() => []);
            resources.push(...hdhiveResources);
        }
        if (requestedSources.includes('subscription')) {
            const subscriptionResources = await this._searchSubscriptionResources(titleCandidates, targetYear).catch(() => []);
            resources.push(...subscriptionResources);
        }

        return {
            tmdbInfo: this._pickTmdbBrief(tmdbInfo),
            resources: resources.sort((left, right) => right.score - left.score)
        };
    }

    _normalizeSearchSources(sources) {
        const requested = Array.isArray(sources)
            ? sources
            : String(sources || '').split(',');
        const valid = requested.map(item => String(item).trim().toLowerCase())
            .filter(item => ['cloudsaver', 'hdhive', 'subscription'].includes(item));
        return valid.length ? [...new Set(valid)] : ['cloudsaver', 'hdhive', 'subscription'];
    }

    /**
     * 搜索订阅资源库，返回供手动选择模式展示的候选列表。
     */
    async _searchSubscriptionResources(titleCandidates, targetYear) {
        if (!AppDataSource.isInitialized) {
            return [];
        }
        const resourceRepo = AppDataSource.getRepository('SubscriptionResource');
        const resources = await resourceRepo.find({ where: { verifyStatus: 'valid' } });
        return resources
            .map(resource => ({
                id: String(resource.id),
                title: this._cleanSubscriptionTitle(resource.title),
                shareLink: resource.shareLink || '',
                score: this._scoreSubscriptionResource(resource, titleCandidates, targetYear),
                source: 'subscription'
            }))
            .filter(item => item.shareLink && item.score > 0);
    }

    async _searchHdhiveResources(titleCandidates, targetYear, tmdbInfo, pointPolicy = { allowPoints: false, maxPoints: 0 }) {
        if (!tmdbInfo?.id || !ConfigService.getConfigValue('hdhive.enabled')) return [];
        const hdhiveSDK = require('../sdk/hdhive/sdk').default;
        const result = await hdhiveSDK.getResources('tv', tmdbInfo.id);
        if (!result?.success) return [];
        return (Array.isArray(result.data) ? result.data : [])
            .filter(resource => canUseHdhiveResource(resource, pointPolicy))
            .map(resource => ({
                id: resource.id,
                slug: resource.slug || resource.id,
                title: resource.title || tmdbInfo.title || '影巢资源',
                shareLink: resource.link || '',
                accessCode: resource.code || '',
                score: this._scoreResource(resource, titleCandidates, targetYear) + this._scoreQuality(resource.title),
                source: 'hdhive',
                quality: resource.quality || '',
                sizeFormatted: resource.sizeFormatted || '',
                isUnlocked: Boolean(resource.isUnlocked),
                isFree: Boolean(resource.isFree),
                points: resource.points
            }));
    }

    async _findBestHdhiveResource(title, year, tmdbInfo, pointPolicy) {
        const titleCandidates = [title, tmdbInfo?.title, tmdbInfo?.originalTitle]
            .filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');
        const candidates = await this._searchHdhiveResources(titleCandidates, targetYear, tmdbInfo, pointPolicy);
        for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
            if (candidate.shareLink) {
                return { title: candidate.title, cloudLinks: [{ link: candidate.shareLink }] };
            }
            const unlocked = await this._unlockHdhiveResource(candidate.slug, tmdbInfo, pointPolicy);
            if (unlocked?.success && unlocked.data?.link) {
                return { title: candidate.title, cloudLinks: [{ link: unlocked.data.link }] };
            }
        }
        return null;
    }

    async _unlockHdhiveResource(resourceSlug, tmdbInfo, pointPolicy) {
        if (!tmdbInfo?.id) {
            return { success: false, error: '无法确认影巢资源积分，已取消解锁' };
        }
        const hdhiveSDK = require('../sdk/hdhive/sdk').default;
        const resourcesResult = await hdhiveSDK.getResources('tv', tmdbInfo.id);
        if (!resourcesResult?.success) {
            return { success: false, error: resourcesResult?.error || '影巢资源信息读取失败，已取消解锁' };
        }
        const normalizedSlug = String(resourceSlug || '').trim();
        const decodedSlug = normalizeResourceSlug(normalizedSlug);
        const resource = (Array.isArray(resourcesResult.data) ? resourcesResult.data : [])
            .find(item => {
                const candidateSlug = String(item.slug || item.id || '').trim();
                return candidateSlug === normalizedSlug
                    || normalizeResourceSlug(candidateSlug) === decodedSlug;
            });
        if (!resource) {
            return { success: false, error: '未找到待解锁的影巢资源，已取消解锁' };
        }
        const validationError = validateHdhiveResourceBeforeUnlock(resource, pointPolicy);
        if (validationError) {
            return { success: false, error: validationError };
        }
        return hdhiveSDK.unlockResource(normalizedSlug);
    }

    _scoreQuality(value) {
        const title = String(value || '').toLowerCase();
        let score = 0;
        if (/2160p|\b4k\b/.test(title)) score += 30;
        else if (/1080p/.test(title)) score += 15;
        if (/dolby[ ._-]?vision|\bdv\b|hdr10|\bhdr\b/.test(title)) score += 8;
        if (/remux|blu[ ._-]?ray/.test(title)) score += 5;
        return score;
    }

    _pickTmdbBrief(tmdbInfo) {
        if (!tmdbInfo) {
            return null;
        }
        return {
            id: tmdbInfo.id || null,
            title: tmdbInfo.title || '',
            originalTitle: tmdbInfo.originalTitle || '',
            type: tmdbInfo.type === 'movie' ? 'movie' : 'tv',
            releaseDate: tmdbInfo.releaseDate || '',
            status: tmdbInfo.status || '',
            totalSeasons: Number(tmdbInfo.totalSeasons || 0) || 0,
            totalEpisodes: Number(tmdbInfo.totalEpisodes || 0) || 0,
            seasons: (Array.isArray(tmdbInfo.seasons) ? tmdbInfo.seasons : [])
                .map(season => ({
                    seasonNumber: Number(season?.seasonNumber ?? season?.season_number ?? 0) || 0,
                    episodeCount: Number(season?.episodeCount ?? season?.episode_count ?? 0) || 0,
                    name: String(season?.name || '')
                }))
                .filter(season => season.seasonNumber > 0 && season.episodeCount > 0),
            lastEpisodeToAir: tmdbInfo.lastEpisodeToAir
                ? { episode_number: Number(tmdbInfo.lastEpisodeToAir.episode_number || 0) || 0 }
                : null
        };
    }

    async _fetchResources(title, tmdbInfo) {
        const cloudSaverSDK = require('../sdk/cloudsaver/sdk').default;
        const searchKeywords = [];
        if (tmdbInfo?.title) {
            searchKeywords.push(tmdbInfo.title);
        }
        if (title) {
            searchKeywords.push(title);
        }
        if (tmdbInfo?.originalTitle) {
            searchKeywords.push(tmdbInfo.originalTitle);
        }

        const uniqueKeywords = [...new Set(searchKeywords.filter(Boolean))];
        for (const keyword of uniqueKeywords) {
            // 列表模式: 拿全部结果(含无链接的 hide 帖)
            const result = await withTimeout(
                cloudSaverSDK.searchList(keyword),
                AUTO_SERIES_SOURCE_TIMEOUT_MS,
                'CloudSaver 搜索超时'
            );
            if (result?.length) {
                return result;
            }
        }
        return [];
    }

    async _findBestResource(title, year, tmdbInfo) {
        const resources = await this._fetchResources(title, tmdbInfo);
        if (!resources.length) {
            return null;
        }

        const titleCandidates = [
            title,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const scored = resources
            .map(resource => ({
                ...resource,
                _score: this._scoreResource(resource, titleCandidates, targetYear)
            }))
            .sort((left, right) => right._score - left._score);

        const available = [];
        for (const item of scored) {
            const link = item.cloudLinks?.[0]?.link || '';
            if (link && await this.invalidResourceService.isInvalid(link, 'cloud_share')) continue;
            available.push(item);
        }

        // 按评分从高到低: 有链接直接用, 没链接的调 detail 解析 (最多 5 个)
        const cloudSaverSDK = require('../sdk/cloudsaver/sdk').default;
        for (const item of available.slice(0, 5)) {
            if (item.cloudLinks?.length) {
                return item;
            }
            if (item.topicId) {
                const detail = await cloudSaverSDK.getDetail(item.topicId);
                if (detail?.cloudLinks?.length) {
                    return { ...item, ...detail };
                }
            }
        }
        return null;
    }

    _scoreResource(resource, titleCandidates, targetYear) {
        const title = String(resource.title || '').toLowerCase();
        let score = 0;

        for (const candidate of titleCandidates) {
            if (!candidate) {
                continue;
            }
            if (title === candidate) {
                score += 120;
                continue;
            }
            if (title.includes(candidate)) {
                score += 80;
                continue;
            }
            const normalizedCandidate = candidate.replace(/\s+/g, '');
            const normalizedTitle = title.replace(/\s+/g, '');
            if (normalizedTitle.includes(normalizedCandidate)) {
                score += 60;
            }
        }

        if (targetYear && title.includes(targetYear)) {
            score += 20;
        }
        if (/完结|全集|全\d+集/.test(resource.title || '')) {
            score += 10;
        }
        return score;
    }

    /**
     * 从订阅资源库中按标题匹配最佳资源。
     * 订阅资源标题通常带「首字母+片名(年份)...」格式，匹配时去掉首字母前缀与年份噪音。
     * 仅返回校验通过（verifyStatus=valid）且有分享链接的资源。
     */
    async _findBestSubscriptionResource(title, year, tmdbInfo) {
        if (!AppDataSource.isInitialized) {
            return null;
        }
        const resourceRepo = AppDataSource.getRepository('SubscriptionResource');
        const resources = await resourceRepo.find({
            where: { verifyStatus: 'valid' }
        });
        if (!resources.length) {
            return null;
        }

        const titleCandidates = [
            title,
            tmdbInfo?.title,
            tmdbInfo?.originalTitle
        ].filter(Boolean).map(item => String(item).toLowerCase());
        const targetYear = year || (tmdbInfo?.releaseDate ? String(new Date(tmdbInfo.releaseDate).getFullYear()) : '');

        const available = [];
        for (const resource of resources) {
            if (resource.shareLink && await this.invalidResourceService.isInvalid(resource.shareLink, 'cloud_share')) continue;
            available.push(resource);
        }
        const scored = available
            .map(resource => ({
                resource,
                _score: this._scoreSubscriptionResource(resource, titleCandidates, targetYear)
            }))
            .filter(item => item._score > 0)
            .sort((left, right) => right._score - left._score);

        const best = scored[0];
        if (!best?.resource?.shareLink) {
            return null;
        }
        return {
            title: this._cleanSubscriptionTitle(best.resource.title),
            cloudLinks: [{ link: best.resource.shareLink }]
        };
    }

    /**
     * 订阅资源标题评分：标题常为「F疯狂动物城2(2025)美国 喜剧...」格式，
     * 首字符可能是分类字母前缀，需剥离后再做包含匹配。
     */
    _scoreSubscriptionResource(resource, titleCandidates, targetYear) {
        const rawTitle = String(resource.title || '');
        const cleaned = this._cleanSubscriptionTitle(rawTitle).toLowerCase();
        const title = rawTitle.toLowerCase();
        let score = 0;

        for (const candidate of titleCandidates) {
            if (!candidate) {
                continue;
            }
            const normalizedCandidate = candidate.replace(/\s+/g, '');
            if (cleaned === candidate || title === candidate) {
                score += 120;
                continue;
            }
            if (cleaned.includes(candidate) || title.includes(candidate)) {
                score += 80;
                continue;
            }
            if (cleaned.replace(/\s+/g, '').includes(normalizedCandidate)) {
                score += 60;
            }
        }

        // 仅在已有标题匹配时叠加年份/完结加分，避免零相关资源仅靠完结标记混入结果
        if (score > 0) {
            if (targetYear && (title.includes(targetYear) || cleaned.includes(targetYear))) {
                score += 20;
            }
            if (/完结|全集|全\d+集|\d+集全/.test(rawTitle)) {
                score += 10;
            }
        }
        return score;
    }

    /**
     * 清理订阅资源标题：去掉首字母分类前缀（如「F疯狂动物城2」的 F）与括号内的年份/标签噪音。
     */
    _cleanSubscriptionTitle(title = '') {
        let cleaned = String(title || '').trim();
        // 去掉「(2025)美国 喜剧...」这类括号及其后的标签描述
        cleaned = cleaned.replace(/[（(].*$/, '').trim();
        // 去掉开头的单个 ASCII 字母分类前缀（紧跟中文字符时）
        cleaned = cleaned.replace(/^[A-Za-z](?=[一-龥])/, '').trim();
        return cleaned || String(title || '').trim();
    }

    _normalizeMode(mode) {
        const normalizedMode = String(mode || 'lazy').trim().toLowerCase();
        return normalizedMode === 'auto' ? 'normal' : normalizedMode;
    }
}

module.exports = {
    AutoSeriesService,
    AUTO_SERIES_SOURCES,
    DEFAULT_SOURCE_PREFERENCES,
    DEFAULT_AUTO_SERIES_SETTINGS,
    normalizeSourcePreferences,
    normalizeAutoSeriesSettings,
    normalizeHdhivePointPolicy,
    canUseHdhiveResource,
    validateHdhiveResourceBeforeUnlock,
    inferAutoSeriesMediaType,
    normalizeTmdbLookupTitle,
    withTimeout
};
