const path = require('path');
const { In } = require('typeorm');
const { StrmService } = require('./strm');
const { logTaskEvent } = require('../utils/logUtils');
const { Cloud189Service } = require('./cloud189');

class StrmConfigService {
    constructor(strmConfigRepo, accountRepo, subscriptionRepo, subscriptionResourceRepo) {
        this.strmConfigRepo = strmConfigRepo;
        this.accountRepo = accountRepo;
        this.subscriptionRepo = subscriptionRepo;
        this.subscriptionResourceRepo = subscriptionResourceRepo;
    }

    async listConfigs() {
        const configs = await this.strmConfigRepo.find({
            order: { id: 'DESC' }
        });
        return configs.map(config => this._normalizeConfig(config));
    }

    async createConfig(data) {
        const config = this.strmConfigRepo.create(this._buildPayload(data));
        return this._normalizeConfig(await this.strmConfigRepo.save(config));
    }

    async updateConfig(id, updates) {
        const config = await this.strmConfigRepo.findOneBy({ id });
        if (!config) {
            throw new Error('STRM 配置不存在');
        }
        Object.assign(config, this._buildPayload({ ...config, ...updates }));
        return this._normalizeConfig(await this.strmConfigRepo.save(config));
    }

    async deleteConfig(id) {
        const config = await this.strmConfigRepo.findOneBy({ id });
        if (!config) {
            throw new Error('STRM 配置不存在');
        }
        await this.strmConfigRepo.remove(config);
    }

    async runConfig(id) {
        const config = await this.strmConfigRepo.findOneBy({ id });
        if (!config) {
            throw new Error('STRM 配置不存在');
        }
        const result = await this._runConfigRecord(config);
        config.lastRunAt = result.lastRunAt || new Date();
        if (result.lastCheckTime !== undefined) {
            config.lastCheckTime = result.lastCheckTime;
        }
        await this.strmConfigRepo.save(config);
        return result.message;
    }

    async runConfigByRecord(config) {
        return await this._runConfigRecord(config);
    }

    async resetSubscriptionConfig(id) {
        const config = await this.strmConfigRepo.findOneBy({ id });
        if (!config) {
            throw new Error('STRM 配置不存在');
        }
        if (config.type !== 'subscription') {
            throw new Error('只有订阅配置支持重置时间');
        }
        config.lastCheckTime = null;
        await this.strmConfigRepo.save(config);
        return this._normalizeConfig(config);
    }

    async _runConfigRecord(config) {
        const normalized = this._normalizeConfig(config);
        if (!normalized.enabled) {
            logTaskEvent(`STRM配置[${normalized.name}]已停用，跳过执行`);
            return {
                message: '配置已停用',
                lastRunAt: new Date()
            };
        }
        if (normalized.type === 'normal') {
            return await this._runNormalConfig(normalized);
        }
        return await this._runSubscriptionConfig(normalized);
    }

    async _runNormalConfig(config) {
        const accountIds = config.accountIds;
        if (!accountIds.length) {
            throw new Error('普通 STRM 配置至少需要选择一个账号');
        }
        const accounts = await this.accountRepo.find({ where: { id: In(accountIds) } });
        if (!accounts.length) {
            throw new Error('未找到可用账号');
        }
        const service = new StrmService();
        const accountMap = new Map(accounts.map(account => [account.id, account]));
        const directoriesByAccount = this._groupDirectoriesByAccount(config.directories);

        if (!config.directories.length) {
            await service.generateAll(accounts, config.overwriteExisting);
        } else {
            const messages = [];
            for (const accountId of Object.keys(directoriesByAccount)) {
                const account = accountMap.get(Number(accountId));
                if (!account) {
                    continue;
                }
                const message = await service.generateSelectedDirectories(account, directoriesByAccount[accountId], {
                    overwriteExisting: config.overwriteExisting,
                    localPathPrefix: config.localPathPrefix,
                    excludePattern: config.excludePattern
                });
                messages.push(message);
            }
            if (!messages.length) {
                throw new Error('普通配置未找到可处理的目录');
            }
        }
        return {
            message: `普通STRM配置[${config.name}]执行完成`,
            lastRunAt: new Date()
        };
    }

    async _runSubscriptionConfig(config) {
        if (!config.subscriptionId) {
            throw new Error('订阅 STRM 配置必须绑定订阅');
        }
        const subscription = await this.subscriptionRepo.findOneBy({ id: config.subscriptionId });
        if (!subscription || !subscription.enabled) {
            throw new Error('订阅不存在或已停用');
        }

        const resources = await this.subscriptionResourceRepo.find({
            where: {
                subscriptionId: config.subscriptionId,
                ...(config.resourceIds.length ? { id: In(config.resourceIds) } : {})
            }
        });

        if (!resources.length) {
            throw new Error('订阅配置没有可处理的资源');
        }

        const account = await this.accountRepo.findOneBy({ isDefault: true }) || await this.accountRepo.findOne({ order: { id: 'ASC' } });
        if (!account) {
            throw new Error('请先添加账号');
        }

        const cloud189 = Cloud189Service.getInstance(account);
        const service = new StrmService();
        let processedCount = 0;
        let processedFiles = 0;
        const runStartedAt = new Date();

        for (const resource of resources) {
            const entries = await this._collectSubscriptionEntries(
                cloud189,
                resource,
                config.excludePattern,
                config.lastCheckTime
            );
            if (!entries.length) {
                continue;
            }
            const groupedEntries = this._groupEntriesByRelativeDir(entries);
            const targetBase = path.join(config.localPathPrefix || `订阅strm/${subscription.name}`, resource.title);

            for (const [relativeDir, files] of Object.entries(groupedEntries)) {
                const targetRoot = path.join(targetBase, relativeDir);
                await service.generateCustom(
                    targetRoot,
                    files,
                    async (file) => await cloud189.getDownloadLink(file.id, resource.shareId),
                    config.overwriteExisting,
                    false
                );
                processedFiles += files.length;
            }
            processedCount++;
        }

        const message = `订阅STRM配置[${config.name}]执行完成，处理资源数: ${processedCount}，处理文件数: ${processedFiles}`;
        logTaskEvent(message);
        return {
            message,
            lastRunAt: runStartedAt,
            lastCheckTime: runStartedAt
        };
    }

    async _collectSubscriptionEntries(cloud189, resource, excludePattern, lastCheckTime, folderId = null, relativeDir = '') {
        if (!resource.isFolder) {
            if (lastCheckTime) {
                return [];
            }
            return [{
                id: resource.shareFileId,
                name: resource.shareFileName || resource.title,
                relativeDir: ''
            }];
        }

        const currentFolderId = folderId || resource.shareFileId;
        const resp = await cloud189.listShareDir(
            resource.shareId,
            currentFolderId,
            resource.shareMode,
            resource.accessCode
        );
        if (!resp?.fileListAO) {
            return [];
        }

        const regex = this._buildRegex(excludePattern);
        const result = [];
        const folderList = resp.fileListAO.folderList || [];
        const fileList = resp.fileListAO.fileList || [];

        for (const folder of folderList) {
            if (regex && regex.test(folder.name)) {
                continue;
            }
            const nextRelativeDir = path.join(relativeDir, folder.name);
            const children = await this._collectSubscriptionEntries(
                cloud189,
                resource,
                excludePattern,
                lastCheckTime,
                folder.id,
                nextRelativeDir
            );
            result.push(...children);
        }

        for (const file of fileList) {
            if (regex && regex.test(file.name)) {
                continue;
            }
            if (!this._shouldIncludeSubscriptionFile(file, lastCheckTime)) {
                continue;
            }
            result.push({
                id: file.id,
                name: file.name,
                relativeDir
            });
        }

        return result;
    }

    _buildPayload(data) {
        const type = data.type || 'normal';
        const directories = this._parseDirectories(data.directories);
        const accountIds = Array.isArray(data.accountIds) ? data.accountIds.map(Number).filter(Boolean) : this._parseJsonArray(data.accountIds).map(Number).filter(Boolean);
        const finalAccountIds = Array.from(new Set([...accountIds, ...directories.map(item => Number(item.accountId)).filter(Boolean)]));
        const resourceIds = Array.isArray(data.resourceIds) ? data.resourceIds.map(Number).filter(Boolean) : this._parseJsonArray(data.resourceIds).map(Number).filter(Boolean);
        const payload = {
            name: data.name?.trim(),
            type,
            accountIds: JSON.stringify(finalAccountIds),
            directories: JSON.stringify(directories),
            subscriptionId: data.subscriptionId ? parseInt(data.subscriptionId) : null,
            resourceIds: JSON.stringify(resourceIds),
            localPathPrefix: data.localPathPrefix?.trim() || '',
            excludePattern: data.excludePattern?.trim() || '',
            overwriteExisting: !!data.overwriteExisting,
            enableCron: !!data.enableCron,
            cronExpression: data.cronExpression?.trim() || '',
            enabled: data.enabled !== false
        };

        if (!payload.name) {
            throw new Error('STRM 配置名称不能为空');
        }
        if (payload.enableCron && !payload.cronExpression) {
            throw new Error('启用定时后必须填写 Cron 表达式');
        }
        if (type === 'normal' && !finalAccountIds.length) {
            throw new Error('普通配置至少需要选择一个账号');
        }
        if (type === 'subscription' && !payload.subscriptionId) {
            throw new Error('订阅配置必须选择订阅');
        }
        return payload;
    }

    _normalizeConfig(config) {
        return {
            ...config,
            accountIds: this._parseJsonArray(config.accountIds).map(Number).filter(Boolean),
            directories: this._parseDirectories(config.directories),
            resourceIds: this._parseJsonArray(config.resourceIds).map(Number).filter(Boolean)
        };
    }

    _parseJsonArray(value) {
        if (!value) {
            return [];
        }
        if (Array.isArray(value)) {
            return value;
        }
        try {
            return JSON.parse(value);
        } catch (error) {
            return [];
        }
    }

    _parseDirectories(value) {
        const rawItems = this._parseJsonArray(value);
        return rawItems
            .map(item => ({
                accountId: Number(item.accountId),
                folderId: item.folderId ? String(item.folderId) : '',
                name: item.name ? String(item.name).trim() : '',
                path: item.path ? String(item.path).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : ''
            }))
            .filter(item => item.accountId && item.path);
    }

    _groupDirectoriesByAccount(directories) {
        return directories.reduce((accumulator, directory) => {
            const key = String(directory.accountId);
            if (!accumulator[key]) {
                accumulator[key] = [];
            }
            accumulator[key].push(directory);
            return accumulator;
        }, {});
    }

    _groupEntriesByRelativeDir(entries) {
        return entries.reduce((accumulator, entry) => {
            const key = entry.relativeDir || '';
            if (!accumulator[key]) {
                accumulator[key] = [];
            }
            accumulator[key].push(entry);
            return accumulator;
        }, {});
    }

    _buildRegex(pattern) {
        if (!pattern) {
            return null;
        }
        try {
            return new RegExp(pattern, 'i');
        } catch (error) {
            return null;
        }
    }

    _shouldIncludeSubscriptionFile(file, lastCheckTime) {
        if (!lastCheckTime) {
            return true;
        }
        const timeValue = file.lastOpTime || file.lastUpdateTime || file.updateTime || file.createTime;
        if (!timeValue) {
            return true;
        }
        const currentTime = new Date(timeValue);
        if (Number.isNaN(currentTime.getTime())) {
            return true;
        }
        return currentTime > new Date(lastCheckTime);
    }
}

module.exports = { StrmConfigService };
