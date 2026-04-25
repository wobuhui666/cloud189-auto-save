const cloud189Utils = require('../utils/Cloud189Utils');
const { Cloud189Service } = require('./cloud189');
const got = require('got');

class SubscriptionService {
    constructor(subscriptionRepo, resourceRepo, accountRepo) {
        this.subscriptionRepo = subscriptionRepo;
        this.resourceRepo = resourceRepo;
        this.accountRepo = accountRepo;
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
        const exist = await this.subscriptionRepo.findOneBy({ uuid });
        if (exist) {
            throw new Error('该 UUID 已存在');
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
            selectedShareCodes: JSON.stringify(selectedShareCodes)
        });
        const savedSubscription = await this.subscriptionRepo.save(subscription);

        const syncResult = await this._syncRemoteResources(savedSubscription);
        if (syncResult?.synced) {
            savedSubscription.lastRefreshMessage = syncResult.totalRemoteCount > 0
                ? (
                    syncResult.selectionActive
                        ? `已按选择同步 ${syncResult.matchedRemoteCount} / ${syncResult.totalRemoteCount} 个订阅资源，待校验`
                        : `已同步 ${syncResult.totalRemoteCount} 个订阅资源，待校验`
                )
                : '订阅已创建，但远程订阅暂无资源';
            await this.subscriptionRepo.save(savedSubscription);
        }

        return this._serializeSubscription(savedSubscription);
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
            recommendation
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

        let savedSubscription = await this.subscriptionRepo.save(subscription);
        if (shouldSyncResources) {
            const syncResult = await this._syncRemoteResources(savedSubscription);
            await this._refreshSubscriptionSummary(savedSubscription.id);
            if (syncResult?.synced) {
                savedSubscription.lastRefreshMessage = this._buildSyncSummary(syncResult) || savedSubscription.lastRefreshMessage;
                savedSubscription = await this.subscriptionRepo.save(savedSubscription);
            }
        }

        return this._serializeSubscription(savedSubscription);
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
        await this._ensureSubscription(subscriptionId);
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
            verifyDetails: ''
        });
        const savedResource = await this.resourceRepo.save(resource);
        await this.refreshSubscription(subscriptionId);
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

        subscription.lastRefreshTime = new Date();
        subscription.validResourceCount = validResourceCount;
        subscription.invalidResourceCount = invalidResourceCount;
        subscription.availableAccountCount = allAvailableAccountIds.size;
        subscription.totalAccountCount = accounts.length;
        const syncSummary = this._buildSyncSummary(syncResult);
        if (!resources.length) {
            subscription.lastRefreshStatus = 'success';
            subscription.lastRefreshMessage = syncSummary
                ? `${syncSummary} | 暂无订阅资源，已更新账号状态`
                : '暂无订阅资源，已更新账号状态';
        } else if (invalidResourceCount > 0) {
            subscription.lastRefreshStatus = validResourceCount > 0 ? 'warning' : 'failed';
            subscription.lastRefreshMessage = [syncSummary, failedResources.slice(0, 3).join(' | ')].filter(Boolean).join(' | ');
        } else {
            subscription.lastRefreshStatus = 'success';
            subscription.lastRefreshMessage = [syncSummary, `全部 ${validResourceCount} 个资源校验成功`].filter(Boolean).join(' | ');
        }
        await this.subscriptionRepo.save(subscription);
        return {
            subscriptionId,
            validResourceCount,
            invalidResourceCount,
            availableAccountCount: allAvailableAccountIds.size,
            totalAccountCount: accounts.length,
            failedResources,
            syncResult
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
                verifyDetails
            };
        });
    }

    _serializeSubscription(subscription, resourceCount = null) {
        return {
            ...subscription,
            ...(resourceCount === null ? {} : { resourceCount }),
            selectedShareCodes: this._normalizeSelectedShareCodes(subscription?.selectedShareCodes)
        };
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

        let firstPage = null;
        try {
            firstPage = await this._fetchRemoteResourcePage(uuid, 1, 200);
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

        const remoteEntries = [...firstPage.fileList];
        const totalRemoteCount = firstPage.totalRemoteCount;
        const totalPages = totalRemoteCount > 0 ? Math.ceil(totalRemoteCount / 200) : 0;

        for (let pageNum = 2; pageNum <= totalPages; pageNum += 1) {
            const pageData = await this._fetchRemoteResourcePage(uuid, pageNum, 200);
            remoteEntries.push(...pageData.fileList);
        }
        const matchedRemoteEntries = selectedShareCodeSet.size > 0
            ? remoteEntries.filter(entry => selectedShareCodeSet.has(String(entry?.accessURL || '').trim()))
            : remoteEntries;

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
                    verifyDetails: ''
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
