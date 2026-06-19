const cloud189Utils = require('../utils/Cloud189Utils');
const { Cloud189Service } = require('./cloud189');
const ConfigService = require('./ConfigService');
const got = require('got');

const DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG = {
    accountId: '',
    targetFolderId: '',
    targetFolder: '',
    taskGroup: '订阅任务',
    remark: '订阅自动任务',
    enableCron: false,
    cronExpression: '',
    enableTaskScraper: false,
    enableLazyStrm: true,
    enableOrganizer: true
};

class SubscriptionService {
    constructor(subscriptionRepo, resourceRepo, accountRepo, taskService = null) {
        this.subscriptionRepo = subscriptionRepo;
        this.resourceRepo = resourceRepo;
        this.accountRepo = accountRepo;
        this.taskService = taskService;
    }

    async listSubscriptions() {
        const subscriptions = await this.subscriptionRepo.find({
            order: { id: 'DESC' }
        });
        const resourceCounts = await Promise.all(
            subscriptions.map(subscription => this.resourceRepo.count({
                where: { subscriptionId: subscription.id }
            }))
        );
        return subscriptions.map((subscription, index) => this._serializeSubscription(
            subscription,
            resourceCounts[index]
        ));
    }

    async createSubscription(data) {
        const uuid = this._normalizeSubscriptionUuid(data.uuid);
        const selectedShareCodes = this._normalizeSelectedShareCodes(data.selectedShareCodes);
        const autoCreateTasks = !!data.autoCreateTasks;
        const autoTaskConfig = this._normalizeAutoTaskConfig(data.autoTaskConfig);
        const exist = await this.subscriptionRepo.findOneBy({ uuid });
        if (exist) {
            throw new Error('该 UUID 已存在');
        }
        if (autoCreateTasks) {
            this._validateAutoTaskConfig(autoTaskConfig);
        }
        const subscription = this.subscriptionRepo.create({
            uuid,
            name: data.name?.trim() || `订阅-${uuid.slice(0, 8)}`,
            remark: data.remark?.trim() || '',
            enabled: data.enabled !== false,
            lastRefreshStatus: 'unknown',
            lastRefreshMessage: '',
            validResourceCount: 0,
            invalidResourceCount: 0,
            availableAccountCount: 0,
            totalAccountCount: 0,
            selectedShareCodes: JSON.stringify(selectedShareCodes),
            autoCreateTasks,
            autoTaskConfig: JSON.stringify(autoTaskConfig)
        });
        let savedSubscription = await this.subscriptionRepo.save(subscription);

        const syncResult = await this._syncRemoteResources(savedSubscription);
        let autoTaskSummary = this._createEmptyAutoTaskSummary();
        if (autoCreateTasks) {
            const resources = await this.resourceRepo.find({
                where: { subscriptionId: savedSubscription.id },
                order: { id: 'ASC' }
            });
            autoTaskSummary = await this._autoCreateTasksForSubscription(savedSubscription, resources);
        }
        if (syncResult?.synced) {
            savedSubscription.lastRefreshMessage = this._joinSummaryParts(
                syncResult.totalRemoteCount > 0
                ? (
                    syncResult.selectionActive
                        ? `已按选择同步 ${syncResult.matchedRemoteCount} / ${syncResult.totalRemoteCount} 个订阅资源，待校验`
                        : `已同步 ${syncResult.totalRemoteCount} 个订阅资源，待校验`
                )
                : '订阅已创建，但远程订阅暂无资源',
                this._buildAutoTaskSummary(autoTaskSummary)
            );
            savedSubscription = await this.subscriptionRepo.save(savedSubscription);
        }

        return {
            ...this._serializeSubscription(savedSubscription),
            autoTaskSummary
        };
    }

    async previewSubscriptionCreation(data) {
        const uuid = this._normalizeSubscriptionUuid(data.uuid);

        const exist = await this.subscriptionRepo.findOneBy({ uuid });
        const accounts = await this._getAvailableAccounts();
        const defaultAccount = accounts.find(account => account.isDefault);
        const normalizedAccounts = accounts.map(account => ({
            id: account.id,
            name: account.alias?.trim() || account.username,
            isDefault: !!account.isDefault
        }));

        const looksLikeUuid = /^[a-zA-Z0-9_-]{6,}$/.test(uuid);
        const subscriptionStats = await this._fetchRemoteResourceSummary(uuid);
        const defaultAutoTaskConfig = this._normalizeAutoTaskConfig();
        const autoTaskReadyState = this._getAutoTaskReadyState(defaultAutoTaskConfig);
        const canCreate = !exist && normalizedAccounts.length > 0 && looksLikeUuid;
        let recommendation = '';
        if (exist) {
            recommendation = '该 UUID 已存在于订阅列表中，建议直接刷新已有订阅。';
        } else if (!normalizedAccounts.length) {
            recommendation = '当前没有可用账号，无法进行订阅资源校验。';
        } else if (!looksLikeUuid) {
            recommendation = 'UUID 格式看起来不太正确，请确认后再保存。';
        } else if (subscriptionStats?.available) {
            recommendation = `识别到真实订阅，预计可同步 ${subscriptionStats.count} 个资源。创建后建议立即执行一次校验。`;
        } else {
            recommendation = '可以创建订阅。创建后建议立即添加资源并执行一次校验。';
        }

        return {
            uuid,
            looksLikeUuid,
            canCreate,
            hasAccounts: normalizedAccounts.length > 0,
            accountCount: normalizedAccounts.length,
            defaultAccount: defaultAccount ? {
                id: defaultAccount.id,
                name: defaultAccount.alias?.trim() || defaultAccount.username
            } : null,
            accounts: normalizedAccounts,
            existingSubscription: exist ? {
                id: exist.id,
                name: exist.name,
                enabled: exist.enabled,
                lastRefreshStatus: exist.lastRefreshStatus,
                lastRefreshTime: exist.lastRefreshTime
            } : null,
            remoteResourceCount: subscriptionStats?.count ?? null,
            remoteSubscriptionDetected: !!subscriptionStats?.available,
            recommendation,
            defaultAutoTaskConfig,
            autoTaskReady: autoTaskReadyState.ready,
            autoTaskReadyMessage: autoTaskReadyState.message
        };
    }

    async previewAutoTaskCreation(data) {
        const uuid = this._normalizeSubscriptionUuid(data.uuid);
        const selectedShareCodes = this._normalizeSelectedShareCodes(data.selectedShareCodes);
        const taskConfig = this._normalizeAutoTaskConfig(data.autoTaskConfig);
        const autoTaskReadyState = this._getAutoTaskReadyState(taskConfig);
        let remoteData = { totalRemoteCount: 0, fileList: [] };
        if (uuid) {
            try {
                remoteData = await this._fetchAllRemoteResourceEntries(uuid);
            } catch (error) {
                return {
                    canAutoCreateTasks: false,
                    estimatedResourceCount: 0,
                    estimatedTaskCount: 0,
                    failedEstimateCount: 0,
                    taskConfig,
                    warningMessages: [],
                    recommendation: error.message
                };
            }
        }
        const matchedRemoteEntries = this._filterRemoteEntriesBySelection(remoteData.fileList, new Set(selectedShareCodes));

        if (!uuid) {
            return {
                canAutoCreateTasks: false,
                estimatedResourceCount: 0,
                estimatedTaskCount: 0,
                failedEstimateCount: 0,
                taskConfig,
                warningMessages: [],
                recommendation: '请先填写有效的 UUID。'
            };
        }

        if (!autoTaskReadyState.ready) {
            return {
                canAutoCreateTasks: false,
                estimatedResourceCount: matchedRemoteEntries.length,
                estimatedTaskCount: 0,
                failedEstimateCount: 0,
                taskConfig,
                warningMessages: [],
                recommendation: autoTaskReadyState.message
            };
        }

        if (!this.taskService) {
            return {
                canAutoCreateTasks: false,
                estimatedResourceCount: matchedRemoteEntries.length,
                estimatedTaskCount: 0,
                failedEstimateCount: 0,
                taskConfig,
                warningMessages: [],
                recommendation: '任务服务未初始化，暂时无法预估。'
            };
        }

        let estimatedTaskCount = 0;
        const warningMessages = [];
        for (const entry of matchedRemoteEntries) {
            const item = this._buildRemoteResourceItem(entry);
            if (!item.shareLink) {
                continue;
            }
            try {
                const result = await this.taskService.estimateTaskCount({
                    accountId: taskConfig.accountId,
                    shareLink: item.shareLink,
                    accessCode: '',
                    selectedFolders: []
                });
                estimatedTaskCount += Number(result?.taskCount || 0);
            } catch (error) {
                warningMessages.push(`${item.title}: ${error.message}`);
            }
        }

        const summaryText = matchedRemoteEntries.length
            ? `预计会自动创建 ${estimatedTaskCount} 个任务，覆盖 ${matchedRemoteEntries.length} 个订阅资源。`
            : '当前没有可用于自动建任务的订阅资源。';

        return {
            canAutoCreateTasks: true,
            estimatedResourceCount: matchedRemoteEntries.length,
            estimatedTaskCount,
            failedEstimateCount: warningMessages.length,
            taskConfig,
            warningMessages: warningMessages.slice(0, 5),
            recommendation: warningMessages.length > 0
                ? `${summaryText} 其中有 ${warningMessages.length} 个资源暂时无法完成预估。`
                : summaryText
        };
    }

    async listRemoteSubscriptionResources(data) {
        const uuid = this._normalizeSubscriptionUuid(data.uuid);
        const pageNum = Math.max(parseInt(data.pageNum, 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(data.pageSize, 10) || 20, 1), 200);
        const keyword = String(data.keyword || '').trim();
        const pageData = await this._fetchRemoteResourcePage(uuid, pageNum, pageSize, keyword);

        return {
            uuid,
            count: pageData.totalRemoteCount,
            pageNum,
            pageSize,
            totalPages: pageData.totalRemoteCount > 0 ? Math.ceil(pageData.totalRemoteCount / pageSize) : 0,
            keyword,
            items: pageData.fileList
                .map(entry => this._buildRemoteResourceItem(entry))
                .filter(item => item.shareCode)
        };
    }

    async updateSubscription(id, updates) {
        const subscription = await this.subscriptionRepo.findOneBy({ id });
        if (!subscription) {
            throw new Error('订阅不存在');
        }
        let shouldSyncResources = false;
        let shouldAttemptAutoCreate = false;
        if (updates.uuid !== undefined) {
            const nextUuid = this._normalizeSubscriptionUuid(updates.uuid);
            const exist = await this.subscriptionRepo.findOneBy({ uuid: nextUuid });
            if (exist && exist.id !== id) {
                throw new Error('该 UUID 已存在');
            }
            shouldSyncResources = shouldSyncResources || subscription.uuid !== nextUuid;
            subscription.uuid = nextUuid;
        }
        if (updates.name !== undefined) {
            subscription.name = updates.name.trim() || subscription.name;
        }
        if (updates.remark !== undefined) {
            subscription.remark = updates.remark.trim();
        }
        if (updates.enabled !== undefined) {
            subscription.enabled = !!updates.enabled;
        }
        if (updates.selectedShareCodes !== undefined) {
            const normalizedSelectedShareCodes = this._normalizeSelectedShareCodes(updates.selectedShareCodes);
            const serializedSelectedShareCodes = JSON.stringify(normalizedSelectedShareCodes);
            shouldSyncResources = shouldSyncResources || subscription.selectedShareCodes !== serializedSelectedShareCodes;
            subscription.selectedShareCodes = serializedSelectedShareCodes;
        }
        if (updates.autoCreateTasks !== undefined) {
            subscription.autoCreateTasks = !!updates.autoCreateTasks;
            shouldAttemptAutoCreate = shouldAttemptAutoCreate || subscription.autoCreateTasks;
        }
        if (updates.autoTaskConfig !== undefined) {
            const normalizedAutoTaskConfig = this._normalizeAutoTaskConfig(updates.autoTaskConfig);
            if (subscription.autoCreateTasks) {
                this._validateAutoTaskConfig(normalizedAutoTaskConfig);
            }
            subscription.autoTaskConfig = JSON.stringify(normalizedAutoTaskConfig);
            shouldAttemptAutoCreate = true;
        }
        if (subscription.autoCreateTasks && (updates.autoCreateTasks !== undefined || updates.autoTaskConfig !== undefined)) {
            subscription.autoTaskConfig = JSON.stringify(this._validateAutoTaskConfig(subscription.autoTaskConfig));
        }

        let savedSubscription = await this.subscriptionRepo.save(subscription);
        let autoTaskSummary = this._createEmptyAutoTaskSummary();
        if (shouldSyncResources) {
            const syncResult = await this._syncRemoteResources(savedSubscription);
            await this._refreshSubscriptionSummary(savedSubscription.id);
            if (syncResult?.synced) {
                savedSubscription.lastRefreshMessage = this._buildSyncSummary(syncResult) || savedSubscription.lastRefreshMessage;
                savedSubscription = await this.subscriptionRepo.save(savedSubscription);
            }
        }
        if (savedSubscription.autoCreateTasks && (shouldSyncResources || shouldAttemptAutoCreate)) {
            const resources = await this.resourceRepo.find({
                where: { subscriptionId: savedSubscription.id },
                order: { id: 'ASC' }
            });
            autoTaskSummary = await this._autoCreateTasksForSubscription(savedSubscription, resources);
        }

        return {
            ...this._serializeSubscription(savedSubscription),
            autoTaskSummary
        };
    }

    async deleteSubscription(id) {
        const subscription = await this.subscriptionRepo.findOneBy({ id });
        if (!subscription) {
            throw new Error('订阅不存在');
        }
        await this.resourceRepo.delete({ subscriptionId: id });
        await this.subscriptionRepo.remove(subscription);
    }

    async listResources(subscriptionId) {
        await this._ensureSubscription(subscriptionId);
        const resources = await this.resourceRepo.find({
            where: { subscriptionId },
            order: { id: 'DESC' }
        });
        return await this._decorateResources(resources);
    }

    async createResource(subscriptionId, data) {
        const subscription = await this._ensureSubscription(subscriptionId);
        const account = await this._getAvailableAccount();
        const shareData = await this._resolveShare(data.shareLink, data.accessCode, account);
        const duplicate = await this.resourceRepo.findOneBy({
            subscriptionId,
            shareLink: shareData.shareLink
        });
        if (duplicate) {
            throw new Error('该分享链接已经存在');
        }

        const resource = this.resourceRepo.create({
            subscriptionId,
            title: data.title?.trim() || shareData.shareInfo.fileName,
            shareLink: shareData.shareLink,
            accessCode: shareData.accessCode || '',
            shareId: shareData.shareInfo.shareId,
            shareMode: shareData.shareInfo.shareMode,
            shareFileId: shareData.shareInfo.fileId,
            shareFileName: shareData.shareInfo.fileName,
            isFolder: !!shareData.shareInfo.isFolder,
            verifyStatus: 'unknown',
            lastVerifyError: '',
            availableAccountIds: '',
            verifyDetails: '',
            autoTaskTaskCount: 0,
            autoTaskTaskIds: '',
            autoTaskLastError: ''
        });
        const savedResource = await this.resourceRepo.save(resource);
        const accounts = await this._getAvailableAccounts();
        await this._validateResourceAgainstAccounts(savedResource, accounts);
        let autoTaskSummary = this._createEmptyAutoTaskSummary();
        if (subscription.autoCreateTasks) {
            autoTaskSummary = await this._autoCreateTasksForSubscription(subscription, [savedResource]);
        }
        await this._refreshSubscriptionSummary(subscriptionId);
        await this._markSingleResourceRefresh(subscriptionId, savedResource, autoTaskSummary);
        const refreshedResource = await this.resourceRepo.findOneBy({ id: savedResource.id });
        return refreshedResource || savedResource;
    }

    async deleteResource(id) {
        const resource = await this.resourceRepo.findOneBy({ id });
        if (!resource) {
            throw new Error('资源不存在');
        }
        const { subscriptionId } = resource;
        await this.resourceRepo.remove(resource);
        await this._refreshSubscriptionSummary(subscriptionId);
    }

    async refreshSubscription(subscriptionId) {
        const subscription = await this._ensureSubscription(subscriptionId);
        const syncResult = await this._syncRemoteResources(subscription);
        const resources = await this.resourceRepo.find({
            where: { subscriptionId },
            order: { id: 'DESC' }
        });
        const accounts = await this._getAvailableAccounts();
        const allAvailableAccountIds = new Set();
        let validResourceCount = 0;
        let invalidResourceCount = 0;
        const failedResources = [];
        let autoTaskSummary = this._createEmptyAutoTaskSummary();

        for (const resource of resources) {
            const result = await this._validateResourceAgainstAccounts(resource, accounts);
            result.availableAccountIds.forEach(id => allAvailableAccountIds.add(id));
            if (result.verifyStatus === 'valid') {
                validResourceCount += 1;
            } else {
                invalidResourceCount += 1;
                failedResources.push(`${resource.title}: ${result.lastVerifyError || '校验失败'}`);
            }
        }
        if (subscription.autoCreateTasks) {
            autoTaskSummary = await this._autoCreateTasksForSubscription(subscription, resources);
        }

        subscription.lastRefreshTime = new Date();
        subscription.validResourceCount = validResourceCount;
        subscription.invalidResourceCount = invalidResourceCount;
        subscription.availableAccountCount = allAvailableAccountIds.size;
        subscription.totalAccountCount = accounts.length;
        const syncSummary = this._buildSyncSummary(syncResult);
        const autoTaskSummaryText = this._buildAutoTaskSummary(autoTaskSummary);
        if (!resources.length) {
            subscription.lastRefreshStatus = 'success';
            subscription.lastRefreshMessage = this._joinSummaryParts(
                syncSummary ? `${syncSummary} | 暂无订阅资源，已更新账号状态` : '暂无订阅资源，已更新账号状态',
                autoTaskSummaryText
            );
        } else if (invalidResourceCount > 0) {
            subscription.lastRefreshStatus = validResourceCount > 0 ? 'warning' : 'failed';
            subscription.lastRefreshMessage = this._joinSummaryParts(
                [syncSummary, failedResources.slice(0, 3).join(' | ')].filter(Boolean).join(' | '),
                autoTaskSummaryText
            );
        } else {
            subscription.lastRefreshStatus = 'success';
            subscription.lastRefreshMessage = this._joinSummaryParts(
                [syncSummary, `全部 ${validResourceCount} 个资源校验成功`].filter(Boolean).join(' | '),
                autoTaskSummaryText
            );
        }
        await this.subscriptionRepo.save(subscription);
        return {
            subscriptionId,
            validResourceCount,
            invalidResourceCount,
            availableAccountCount: allAvailableAccountIds.size,
            totalAccountCount: accounts.length,
            failedResources,
            syncResult,
            autoTaskSummary
        };
    }

    async browseResource(resourceId, folderId, keyword = '') {
        const resource = await this.resourceRepo.findOneBy({ id: resourceId });
        if (!resource) {
            throw new Error('资源不存在');
        }

        const account = await this._getAvailableAccount();
        const cloud189 = Cloud189Service.getInstance(account);
        const currentFolderId = folderId || resource.shareFileId;
        const isRoot = currentFolderId === resource.shareFileId;

        if (!resource.isFolder) {
            return [{
                id: resource.shareFileId,
                name: resource.title || resource.shareFileName,
                type: 'file',
                isFolder: false,
                canSave: true,
                currentFolderId
            }];
        }

        const resp = await cloud189.listShareDir(
            resource.shareId,
            currentFolderId,
            resource.shareMode,
            resource.accessCode
        );

        if (!resp?.fileListAO) {
            return [];
        }

        const normalizedKeyword = keyword?.trim().toLowerCase();
        const folderList = (resp.fileListAO.folderList || []).map(folder => ({
            id: folder.id,
            name: folder.name,
            type: 'folder',
            isFolder: true,
            canSave: isRoot,
            currentFolderId
        }));
        const fileList = (resp.fileListAO.fileList || []).map(file => ({
            id: file.id,
            name: file.name,
            type: 'file',
            isFolder: false,
            canSave: false,
            size: file.size,
            lastOpTime: file.lastOpTime,
            currentFolderId
        }));

        const entries = [...folderList, ...fileList];
        if (!normalizedKeyword) {
            return entries;
        }
        return entries.filter(entry => entry.name.toLowerCase().includes(normalizedKeyword));
    }

    async _ensureSubscription(id) {
        const subscription = await this.subscriptionRepo.findOneBy({ id });
        if (!subscription) {
            throw new Error('订阅不存在');
        }
        return subscription;
    }

    async _getAvailableAccounts() {
        return await this.accountRepo.find({
            order: {
                isDefault: 'DESC',
                id: 'ASC'
            }
        });
    }

    async _getAvailableAccount() {
        const defaultAccount = await this.accountRepo.findOneBy({ isDefault: true });
        if (defaultAccount) {
            return defaultAccount;
        }
        const account = await this.accountRepo.findOne({
            order: { id: 'ASC' }
        });
        if (!account) {
            throw new Error('请先添加账号');
        }
        return account;
    }

    async _decorateResources(resources) {
        if (!resources.length) {
            return resources;
        }
        const accounts = await this._getAvailableAccounts();
        const accountMap = new Map(accounts.map(account => [
            account.id,
            account.alias?.trim() || account.username
        ]));
        return resources.map(resource => {
            let availableAccounts = [];
            let verifyDetails = [];
            try {
                const ids = resource.availableAccountIds ? JSON.parse(resource.availableAccountIds) : [];
                if (Array.isArray(ids)) {
                    availableAccounts = ids.map(id => ({
                        id,
                        name: accountMap.get(Number(id)) || `账号${id}`
                    }));
                }
            } catch (error) {
                availableAccounts = [];
            }
            try {
                const details = resource.verifyDetails ? JSON.parse(resource.verifyDetails) : [];
                if (Array.isArray(details)) {
                    verifyDetails = details;
                }
            } catch (error) {
                verifyDetails = [];
            }
            return {
                ...resource,
                availableAccounts,
                verifyDetails,
                autoTaskTaskIds: this._normalizeJsonArray(resource.autoTaskTaskIds),
                autoTaskTaskCount: Number(resource.autoTaskTaskCount || 0)
            };
        });
    }

    _serializeSubscription(subscription, resourceCount = null) {
        return {
            ...subscription,
            ...(resourceCount === null ? {} : { resourceCount }),
            selectedShareCodes: this._normalizeSelectedShareCodes(subscription?.selectedShareCodes),
            autoCreateTasks: !!subscription?.autoCreateTasks,
            autoTaskConfig: this._normalizeAutoTaskConfig(subscription?.autoTaskConfig)
        };
    }

    _normalizeAutoTaskConfig(input) {
        let values = input;
        if (typeof input === 'string') {
            const rawText = input.trim();
            if (!rawText) {
                values = {};
            } else {
                try {
                    values = JSON.parse(rawText);
                } catch (error) {
                    values = {};
                }
            }
        }

        const autoCreateConfig = ConfigService.getConfigValue('task.autoCreate', {});
        const merged = {
            ...DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG,
            accountId: String(autoCreateConfig.accountId || '').trim(),
            targetFolderId: String(autoCreateConfig.targetFolderId || '').trim(),
            targetFolder: String(autoCreateConfig.targetFolder || '').trim(),
            ...(values && typeof values === 'object' ? values : {})
        };

        return {
            accountId: String(merged.accountId || '').trim(),
            targetFolderId: String(merged.targetFolderId || '').trim(),
            targetFolder: String(merged.targetFolder || '').trim(),
            taskGroup: String(merged.taskGroup || DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG.taskGroup).trim() || DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG.taskGroup,
            remark: String(merged.remark || DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG.remark).trim() || DEFAULT_SUBSCRIPTION_AUTO_TASK_CONFIG.remark,
            enableCron: !!merged.enableCron,
            cronExpression: String(merged.cronExpression || '').trim(),
            enableTaskScraper: !!merged.enableTaskScraper,
            enableLazyStrm: !!merged.enableLazyStrm,
            enableOrganizer: !!merged.enableOrganizer
        };
    }

    _validateAutoTaskConfig(taskConfig) {
        const normalizedTaskConfig = this._normalizeAutoTaskConfig(taskConfig);
        if (!normalizedTaskConfig.accountId) {
            throw new Error('请先在系统设置中配置自动追剧默认账号');
        }
        if (!normalizedTaskConfig.targetFolderId || !normalizedTaskConfig.targetFolder) {
            throw new Error('请先在系统设置中配置自动追剧默认保存目录');
        }
        if (normalizedTaskConfig.enableCron && !normalizedTaskConfig.cronExpression) {
            throw new Error('启用定时任务后必须填写 Cron 表达式');
        }
        return normalizedTaskConfig;
    }

    _getAutoTaskReadyState(taskConfig) {
        try {
            this._validateAutoTaskConfig(taskConfig);
            return { ready: true, message: '自动建任务配置已就绪。' };
        } catch (error) {
            return { ready: false, message: error.message };
        }
    }

    _normalizeJsonArray(input) {
        if (!input) {
            return [];
        }
        try {
            const parsed = typeof input === 'string' ? JSON.parse(input) : input;
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    _createEmptyAutoTaskSummary() {
        return {
            createdTaskCount: 0,
            createdResourceCount: 0,
            failedResources: [],
            skippedResourceCount: 0
        };
    }

    _buildAutoTaskSummary(autoTaskSummary) {
        if (!autoTaskSummary) {
            return '';
        }
        const summaryParts = [];
        if (autoTaskSummary.createdTaskCount > 0) {
            summaryParts.push(`自动创建 ${autoTaskSummary.createdTaskCount} 个任务`);
        }
        if (autoTaskSummary.failedResources?.length) {
            summaryParts.push(`自动建任务失败 ${autoTaskSummary.failedResources.length} 个资源`);
        }
        return summaryParts.join('，');
    }

    _joinSummaryParts(...parts) {
        return parts.filter(Boolean).join(' | ');
    }

    _normalizeSelectedShareCodes(input) {
        if (input == null || input === '') {
            return [];
        }

        let values = input;
        if (typeof input === 'string') {
            const rawText = input.trim();
            if (!rawText) {
                return [];
            }
            try {
                values = JSON.parse(rawText);
            } catch (error) {
                values = rawText.split(/[\n,]/);
            }
        }

        const normalizedValues = [];
        const seenShareCodes = new Set();
        const valueList = Array.isArray(values) ? values : [values];
        for (const value of valueList) {
            const rawValue = String(value || '').trim();
            if (!rawValue) {
                continue;
            }

            let shareCode = '';
            try {
                shareCode = cloud189Utils.parseShareCode(rawValue);
            } catch (error) {
                shareCode = rawValue;
            }

            if (!shareCode || seenShareCodes.has(shareCode)) {
                continue;
            }

            seenShareCodes.add(shareCode);
            normalizedValues.push(shareCode);
        }

        return normalizedValues;
    }

    _getSelectedShareCodeSet(subscriptionOrSelectedShareCodes) {
        if (Array.isArray(subscriptionOrSelectedShareCodes)) {
            return new Set(this._normalizeSelectedShareCodes(subscriptionOrSelectedShareCodes));
        }
        return new Set(this._normalizeSelectedShareCodes(subscriptionOrSelectedShareCodes?.selectedShareCodes));
    }

    async _validateResourceAgainstAccounts(resource, accounts) {
        const availableAccountIds = [];
        const errors = [];
        const verifyDetails = [];
        let shareData = null;

        for (const account of accounts) {
            try {
                const result = await this._resolveShare(resource.shareLink, resource.accessCode, account);
                availableAccountIds.push(account.id);
                verifyDetails.push({
                    accountId: account.id,
                    accountName: account.alias?.trim() || account.username,
                    status: 'valid',
                    error: ''
                });
                if (!shareData) {
                    shareData = result;
                }
            } catch (error) {
                const accountName = account.alias?.trim() || account.username;
                errors.push(`${accountName}: ${error.message}`);
                verifyDetails.push({
                    accountId: account.id,
                    accountName,
                    status: 'invalid',
                    error: error.message
                });
            }
        }

        const originalShareFileName = resource.shareFileName;
        if (shareData) {
            resource.shareLink = shareData.shareLink;
            resource.accessCode = shareData.accessCode || '';
            resource.shareId = shareData.shareInfo.shareId;
            resource.shareMode = shareData.shareInfo.shareMode;
            resource.shareFileId = shareData.shareInfo.fileId;
            resource.shareFileName = shareData.shareInfo.fileName;
            resource.isFolder = !!shareData.shareInfo.isFolder;
            if (!resource.title || resource.title === originalShareFileName) {
                resource.title = shareData.shareInfo.fileName;
            }
        }

        resource.verifyStatus = availableAccountIds.length > 0 ? 'valid' : 'invalid';
        resource.lastVerifiedAt = new Date();
        resource.lastVerifyError = availableAccountIds.length > 0 ? '' : (errors[0] || '资源校验失败');
        resource.availableAccountIds = JSON.stringify(availableAccountIds);
        resource.verifyDetails = JSON.stringify(verifyDetails);
        await this.resourceRepo.save(resource);

        return {
            verifyStatus: resource.verifyStatus,
            availableAccountIds,
            lastVerifyError: resource.lastVerifyError,
            verifyDetails
        };
    }

    async _refreshSubscriptionSummary(subscriptionId) {
        const subscription = await this._ensureSubscription(subscriptionId);
        const resources = await this.resourceRepo.find({
            where: { subscriptionId }
        });
        let validResourceCount = 0;
        let invalidResourceCount = 0;
        const availableAccountIds = new Set();

        resources.forEach(resource => {
            if (resource.verifyStatus === 'valid') {
                validResourceCount += 1;
            }
            if (resource.verifyStatus === 'invalid') {
                invalidResourceCount += 1;
            }
            try {
                const ids = resource.availableAccountIds ? JSON.parse(resource.availableAccountIds) : [];
                if (Array.isArray(ids)) {
                    ids.forEach(id => availableAccountIds.add(id));
                }
            } catch (error) {
                // ignore malformed historical data
            }
        });

        const accounts = await this._getAvailableAccounts();
        subscription.validResourceCount = validResourceCount;
        subscription.invalidResourceCount = invalidResourceCount;
        subscription.availableAccountCount = availableAccountIds.size;
        subscription.totalAccountCount = accounts.length;
        await this.subscriptionRepo.save(subscription);
    }

    async _markSingleResourceRefresh(subscriptionId, resource, autoTaskSummary = null) {
        const subscription = await this._ensureSubscription(subscriptionId);
        const title = resource.title || resource.shareFileName || '新增资源';
        const autoTaskSummaryText = autoTaskSummary ? this._buildAutoTaskSummary(autoTaskSummary) : '';
        subscription.lastRefreshTime = new Date();
        subscription.lastRefreshStatus = resource.verifyStatus === 'valid' ? 'success' : 'warning';
        subscription.lastRefreshMessage = this._joinSummaryParts(
            resource.verifyStatus === 'valid'
                ? `新增资源 ${title} 校验成功`
                : `新增资源 ${title} 校验失败: ${resource.lastVerifyError || '资源校验失败'}`,
            autoTaskSummaryText
        );
        await this.subscriptionRepo.save(subscription);
    }

    async _resolveShare(shareLink, accessCode, account) {
        if (!shareLink?.trim()) {
            throw new Error('分享链接不能为空');
        }
        const { url, accessCode: parsedAccessCode } = cloud189Utils.parseCloudShare(shareLink.trim());
        if (!url) {
            throw new Error('无效的分享链接');
        }
        const finalAccessCode = accessCode?.trim() || parsedAccessCode || '';
        const shareCode = cloud189Utils.parseShareCode(url);
        const cloud189 = Cloud189Service.getInstance(account);
        const shareInfo = await cloud189.getShareInfo(shareCode);

        if (!shareInfo) {
            throw new Error('获取分享信息失败');
        }
        if (shareInfo.shareMode == 1) {
            if (!finalAccessCode) {
                throw new Error('分享链接为私密链接, 请输入访问码');
            }
            const accessCodeResponse = await cloud189.checkAccessCode(shareCode, finalAccessCode);
            if (!accessCodeResponse?.shareId) {
                throw new Error('访问码无效');
            }
            shareInfo.shareId = accessCodeResponse.shareId;
        }
        if (!shareInfo.shareId) {
            throw new Error('获取分享信息失败');
        }
        return {
            shareLink: cloud189Utils.buildSubscriptionDetailsUrl(shareCode),
            accessCode: finalAccessCode,
            shareInfo
        };
    }

    _normalizeSubscriptionUuid(input) {
        return cloud189Utils.parseSubscriptionUuid(String(input || '').trim());
    }

    async _fetchRemoteResourceSummary(uuid) {
        try {
            const page = await this._fetchRemoteResourcePage(uuid, 1, 1);
            return {
                available: true,
                count: page.totalRemoteCount
            };
        } catch (error) {
            return null;
        }
    }

    async _fetchAllRemoteResourceEntries(uuid) {
        const firstPage = await this._fetchRemoteResourcePage(uuid, 1, 200);
        const remoteEntries = [...firstPage.fileList];
        const totalRemoteCount = firstPage.totalRemoteCount;
        const totalPages = totalRemoteCount > 0 ? Math.ceil(totalRemoteCount / 200) : 0;

        for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
            const pageData = await this._fetchRemoteResourcePage(uuid, pageNum, 200);
            remoteEntries.push(...pageData.fileList);
        }

        return {
            totalRemoteCount,
            fileList: remoteEntries
        };
    }

    async _fetchRemoteResourcePage(uuid, pageNum = 1, pageSize = 200, keyword = '') {
        const response = await got('https://api.cloud.189.cn/open/share/getUpResourceShare.action', {
            method: 'GET',
            searchParams: {
                upUserId: uuid,
                pageNum,
                pageSize,
                ...(keyword ? { fileName: keyword } : {})
            },
            responseType: 'json',
            timeout: {
                request: 20000
            },
            retry: {
                limit: 0
            },
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Referer': cloud189Utils.buildSubscriptionHomeUrl(uuid),
                'User-Agent': 'Mozilla/5.0'
            }
        });

        const payload = response.body || {};
        if (payload.code !== 'success' || !payload.data) {
            const errorMessage = payload.message || payload.msg || '获取远程订阅资源失败';
            throw new Error(errorMessage);
        }

        return {
            totalRemoteCount: Number(payload.data.count) || 0,
            fileList: Array.isArray(payload.data.fileList) ? payload.data.fileList : []
        };
    }

    _buildRemoteResourceItem(entry) {
        const shareCode = String(entry?.accessURL || '').trim();
        const title = String(entry?.name || entry?.fileName || '').trim() || `订阅资源-${entry?.id || shareCode}`;
        return {
            id: String(entry?.id || shareCode || ''),
            title,
            shareCode,
            shareLink: shareCode ? cloud189Utils.buildSubscriptionDetailsUrl(shareCode) : '',
            isFolder: !!entry?.folder,
            shareId: entry?.shareId ? String(entry.shareId) : '',
            shareType: entry?.shareType != null ? String(entry.shareType) : '',
            createDate: entry?.createDate || null,
            lastOpTime: entry?.lastOpTime || null
        };
    }

    _filterRemoteEntriesBySelection(remoteEntries, selectedShareCodeSet) {
        if (!selectedShareCodeSet?.size) {
            return remoteEntries;
        }
        return remoteEntries.filter(entry => selectedShareCodeSet.has(String(entry?.accessURL || '').trim()));
    }

    _buildResourceIdentityKey(shareLink) {
        try {
            const shareCode = cloud189Utils.parseShareCode(String(shareLink || '').trim());
            return `share:${shareCode}`;
        } catch (error) {
            const normalizedLink = String(shareLink || '').trim();
            return normalizedLink ? `raw:${normalizedLink}` : '';
        }
    }

    _extractResourceShareCode(resource) {
        try {
            return cloud189Utils.parseShareCode(String(resource?.shareLink || '').trim());
        } catch (error) {
            return '';
        }
    }

    async _pruneUnselectedResources(subscriptionId, selectedShareCodeSet) {
        if (!selectedShareCodeSet?.size) {
            return 0;
        }

        const resources = await this.resourceRepo.find({
            where: { subscriptionId }
        });
        const resourcesToDelete = resources.filter(resource => {
            const shareCode = this._extractResourceShareCode(resource);
            return shareCode && !selectedShareCodeSet.has(shareCode);
        });

        if (!resourcesToDelete.length) {
            return 0;
        }

        await this.resourceRepo.remove(resourcesToDelete);
        return resourcesToDelete.length;
    }

    async _autoCreateTasksForSubscription(subscription, resources) {
        const summary = this._createEmptyAutoTaskSummary();
        if (!subscription?.autoCreateTasks || !this.taskService || !Array.isArray(resources) || resources.length === 0) {
            return summary;
        }

        let taskConfig;
        try {
            taskConfig = this._validateAutoTaskConfig(subscription.autoTaskConfig);
        } catch (error) {
            summary.failedResources.push(`自动建任务配置错误: ${error.message}`);
            return summary;
        }
        for (const resource of resources) {
            if (resource.autoTaskCreatedAt || Number(resource.autoTaskTaskCount || 0) > 0) {
                summary.skippedResourceCount += 1;
                continue;
            }

            try {
                const tasks = await this.taskService.createTask({
                    accountId: taskConfig.accountId,
                    shareLink: resource.shareLink,
                    accessCode: resource.accessCode || '',
                    totalEpisodes: 0,
                    targetFolderId: taskConfig.targetFolderId,
                    targetFolder: taskConfig.targetFolder,
                    matchPattern: '',
                    matchOperator: '',
                    matchValue: '',
                    overwriteFolder: 0,
                    remark: taskConfig.remark,
                    taskGroup: taskConfig.taskGroup,
                    enableCron: taskConfig.enableCron,
                    cronExpression: taskConfig.cronExpression,
                    selectedFolders: [],
                    sourceRegex: '',
                    targetRegex: '',
                    taskName: resource.title || resource.shareFileName || '',
                    enableTaskScraper: taskConfig.enableTaskScraper,
                    enableLazyStrm: taskConfig.enableLazyStrm,
                    enableOrganizer: taskConfig.enableOrganizer
                });
                resource.autoTaskCreatedAt = new Date();
                resource.autoTaskTaskCount = tasks?.length || 0;
                resource.autoTaskTaskIds = JSON.stringify((tasks || []).map(task => task.id));
                resource.autoTaskLastError = '';
                summary.createdTaskCount += tasks?.length || 0;
                summary.createdResourceCount += 1;
            } catch (error) {
                resource.autoTaskLastError = error.message;
                summary.failedResources.push(`${resource.title}: ${error.message}`);
            }

            await this.resourceRepo.save(resource);
        }

        return summary;
    }

    async _syncRemoteResources(subscription) {
        const uuid = String(subscription?.uuid || '').trim();
        if (!uuid) {
            return {
                synced: false,
                totalRemoteCount: 0,
                createdCount: 0,
                updatedCount: 0,
                prunedCount: 0,
                matchedRemoteCount: 0,
                selectionActive: false
            };
        }
        const selectedShareCodeSet = this._getSelectedShareCodeSet(subscription);

        let remoteData = null;
        try {
            remoteData = await this._fetchAllRemoteResourceEntries(uuid);
        } catch (error) {
            return {
                synced: false,
                totalRemoteCount: 0,
                createdCount: 0,
                updatedCount: 0,
                prunedCount: 0,
                matchedRemoteCount: 0,
                selectionActive: selectedShareCodeSet.size > 0,
                error: error.message
            };
        }

        const remoteEntries = remoteData.fileList;
        const totalRemoteCount = remoteData.totalRemoteCount;
        const matchedRemoteEntries = this._filterRemoteEntriesBySelection(remoteEntries, selectedShareCodeSet);

        const existingResources = await this.resourceRepo.find({
            where: { subscriptionId: subscription.id }
        });
        const existingResourceMap = new Map();
        for (const resource of existingResources) {
            const key = this._buildResourceIdentityKey(resource.shareLink);
            if (key && !existingResourceMap.has(key)) {
                existingResourceMap.set(key, resource);
            }
        }

        const resourcesToSave = [];
        let createdCount = 0;
        let updatedCount = 0;

        for (const entry of matchedRemoteEntries) {
            const shareCode = String(entry.accessURL || '').trim();
            if (!shareCode) {
                continue;
            }

            const shareLink = cloud189Utils.buildSubscriptionDetailsUrl(shareCode);
            const title = String(entry.name || '').trim() || `订阅资源-${entry.id || shareCode}`;
            const resourceKey = this._buildResourceIdentityKey(shareLink);
            const existingResource = existingResourceMap.get(resourceKey);

            if (!existingResource) {
                resourcesToSave.push(this.resourceRepo.create({
                    subscriptionId: subscription.id,
                    title,
                    shareLink,
                    accessCode: '',
                    shareId: entry.shareId ? String(entry.shareId) : '',
                    shareMode: entry.shareType != null ? String(entry.shareType) : '',
                    shareFileId: entry.id ? String(entry.id) : '',
                    shareFileName: title,
                    isFolder: !!entry.folder,
                    verifyStatus: 'unknown',
                    lastVerifyError: '',
                    availableAccountIds: '',
                    verifyDetails: '',
                    autoTaskTaskCount: 0,
                    autoTaskTaskIds: '',
                    autoTaskLastError: ''
                }));
                createdCount += 1;
                continue;
            }

            let changed = false;
            if (existingResource.shareLink !== shareLink) {
                existingResource.shareLink = shareLink;
                changed = true;
            }
            if (existingResource.accessCode !== '') {
                existingResource.accessCode = '';
                changed = true;
            }
            if (String(existingResource.shareId || '') !== String(entry.shareId || '')) {
                existingResource.shareId = entry.shareId ? String(entry.shareId) : '';
                changed = true;
            }
            if (String(existingResource.shareMode || '') !== String(entry.shareType || '')) {
                existingResource.shareMode = entry.shareType != null ? String(entry.shareType) : '';
                changed = true;
            }
            if (String(existingResource.shareFileId || '') !== String(entry.id || '')) {
                existingResource.shareFileId = entry.id ? String(entry.id) : '';
                changed = true;
            }
            if (existingResource.shareFileName !== title) {
                const shouldUpdateTitle = !existingResource.title || existingResource.title === existingResource.shareFileName;
                existingResource.shareFileName = title;
                if (shouldUpdateTitle) {
                    existingResource.title = title;
                }
                changed = true;
            }
            if (!!existingResource.isFolder !== !!entry.folder) {
                existingResource.isFolder = !!entry.folder;
                changed = true;
            }

            if (changed) {
                resourcesToSave.push(existingResource);
                updatedCount += 1;
            }
        }

        if (resourcesToSave.length) {
            await this.resourceRepo.save(resourcesToSave);
        }
        const prunedCount = await this._pruneUnselectedResources(subscription.id, selectedShareCodeSet);

        return {
            synced: true,
            totalRemoteCount,
            matchedRemoteCount: matchedRemoteEntries.length,
            createdCount,
            updatedCount,
            prunedCount,
            selectionActive: selectedShareCodeSet.size > 0
        };
    }

    _buildSyncSummary(syncResult) {
        if (!syncResult?.synced) {
            return '';
        }
        const parts = [];
        if (syncResult.selectionActive) {
            parts.push(`按选择保留 ${syncResult.matchedRemoteCount} / ${syncResult.totalRemoteCount} 个资源`);
        }
        if (syncResult.createdCount > 0) {
            parts.push(`同步新增 ${syncResult.createdCount} 个资源`);
        }
        if (syncResult.updatedCount > 0) {
            parts.push(`同步更新 ${syncResult.updatedCount} 个资源`);
        }
        if (syncResult.prunedCount > 0) {
            parts.push(`移除 ${syncResult.prunedCount} 个未选资源`);
        }
        return parts.join('，');
    }
}

module.exports = { SubscriptionService };
