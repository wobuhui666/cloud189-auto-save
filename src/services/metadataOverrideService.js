const crypto = require('crypto');
const path = require('path');
const { In } = require('typeorm');
const { AppDataSource } = require('../database');
const { collectLocalFiles, safeJsonParse } = require('./ptUtils');
const {
    MetadataPlanStore,
    normalizeMetadataOverride,
    mergeMetadataOverrides,
    inspectFiles,
    buildMetadataPlan,
    buildPreview,
    parseJson
} = require('./metadataOverride');

class MetadataOverrideService {
    constructor(options = {}) {
        this.taskRepo = options.taskRepo || null;
        this.ptSubscriptionRepo = options.ptSubscriptionRepo || null;
        this.ptReleaseRepo = options.ptReleaseRepo || null;
        this.taskService = options.taskService || null;
        this.organizerService = options.organizerService || null;
        this.ptService = options.ptService || null;
        this.planStore = options.planStore || new MetadataPlanStore();
        this.targetRefs = new Map();
        this.targetRefTtlMs = Number(options.targetRefTtlMs || 10 * 60 * 1000);
        this.applyLocks = new Map();
    }

    _repo(type) {
        if (type === 'task') return this.taskRepo || AppDataSource.getRepository('Task');
        if (type === 'pt_subscription') return this.ptSubscriptionRepo || AppDataSource.getRepository('PtSubscription');
        if (type === 'pt_release') return this.ptReleaseRepo || AppDataSource.getRepository('PtRelease');
        throw new Error('不支持的元数据目标类型');
    }

    async getTarget(type, id) {
        const numericId = Number(id);
        if (!Number.isSafeInteger(numericId) || numericId < 1) throw new Error('元数据目标编号无效');
        const target = await this._repo(type).findOneBy({ id: numericId });
        if (!target) throw new Error('元数据目标不存在');
        return target;
    }

    _jsonField(type) {
        return type === 'pt_subscription' ? 'metadataTemplateJson' : 'metadataOverrideJson';
    }

    async read(type, id, options = {}) {
        const target = await this.getTarget(type, id);
        const inspection = options.inspect === false ? null : await this.inspect(type, target);
        const field = this._jsonField(type);
        return {
            type,
            id: target.id,
            override: parseJson(target[field], null),
            appliedOverride: type === 'pt_subscription' ? null : parseJson(target.metadataAppliedOverrideJson, null),
            templateSnapshot: type === 'pt_release' ? parseJson(target.metadataTemplateSnapshotJson, null) : null,
            inspection
        };
    }

    async inspect(type, targetOrId) {
        const target = typeof targetOrId === 'object' ? targetOrId : await this.getTarget(type, targetOrId);
        let rawFiles = [];
        if (type === 'task') rawFiles = await this._inspectTaskFiles(target);
        if (type === 'pt_release') rawFiles = await this._inspectReleaseFiles(target);
        const template = type === 'pt_subscription'
            ? parseJson(target.metadataTemplateJson, {})
            : (type === 'pt_release' ? parseJson(target.metadataTemplateSnapshotJson, {}) : parseJson(target.metadataOverrideJson, {}));
        const inspection = inspectFiles(rawFiles, template?.template || {});
        return {
            ...inspection,
            automaticWork: this._automaticWork(type, target),
            override: parseJson(target[this._jsonField(type)], null),
            appliedOverride: parseJson(target.metadataAppliedOverrideJson, null),
            files: inspection.files
        };
    }

    async _inspectTaskFiles(task) {
        if (!this.taskService) return [];
        const files = task.enableLazyStrm && this.taskService.getLazyStrmFilesByTask
            ? await this.taskService.getLazyStrmFilesByTask(task)
            : await this.taskService.getFilesByTask(task);
        return (files || []).filter(file => !file.isFolder).map(file => ({
            id: file.id || file.fileId,
            size: file.size || file.fileSize,
            relativePath: String(file.relativePath || (file.relativeDir ? path.posix.join(String(file.relativeDir).replace(/\\/g, '/'), file.name) : file.name) || '')
        }));
    }

    async _inspectReleaseFiles(release) {
        const torrentFiles = safeJsonParse(release.torrentFilesJson, []);
        if (torrentFiles.length) return torrentFiles.map(file => ({ ...file, relativePath: file.relativePath || file.name }));
        const localPath = String(release.downloadPath || '').trim();
        if (localPath) {
            try { return await collectLocalFiles(localPath); } catch (_) {}
        }
        return safeJsonParse(release.manifestJson, []).map(file => ({
            id: file.cloudFileId || file.casFileId,
            size: file.size,
            relativePath: file.sourceRelativePath || file.relativePath || file.cloudRelativePath
        }));
    }

    _automaticWork(type, target) {
        if (type === 'task') return {
            tmdbId: String(target.tmdbId || ''), title: target.tmdbTitle || target.resourceName || '',
            mediaType: target.videoType || '', seasonNumber: target.tmdbSeasonNumber ?? target.manualSeason ?? null,
            seasonName: target.tmdbSeasonName || '', totalEpisodes: target.tmdbSeasonEpisodes ?? target.totalEpisodes ?? null
        };
        if (type === 'pt_subscription') return { title: target.name || '', seasonNumber: null, totalEpisodes: target.totalEpisodeNumber ?? null };
        return { title: target.title || '', seasonNumber: target.seasonNumber ?? null, totalEpisodes: null };
    }

    async preview(type, id, proposed, options = {}) {
        const target = await this.getTarget(type, id);
        const field = this._jsonField(type);
        const current = options.compareApplied && type !== 'pt_subscription'
            ? parseJson(target.metadataAppliedOverrideJson, null)
            : parseJson(target[field], null);
        const template = type === 'pt_release' ? parseJson(target.metadataTemplateSnapshotJson, null) : null;
        const inspection = type === 'pt_subscription' ? { fingerprint: '', files: [] } : await this.inspect(type, target);
        return buildMetadataPlan({
            targetType: type,
            targetId: target.id,
            targetRef: options.targetRef || '',
            current,
            proposed,
            template,
            fingerprint: options.fingerprint || inspection.fingerprint,
            inspectedFiles: inspection.files
        });
    }

    async save(type, id, proposed, options = {}) {
        const plan = await this.preview(type, id, proposed, options);
        if (plan.noop) return { noop: true, preview: plan.preview };
        const target = await this.getTarget(type, id);
        target[this._jsonField(type)] = JSON.stringify(plan.override);
        await this._repo(type).save(target);
        if (type === 'pt_subscription') return { noop: false, preview: plan.preview, override: plan.override };
        const planToken = this.planStore.issue(plan, {});
        return { noop: false, preview: plan.preview, override: plan.override, planToken, requiresApply: true };
    }

    async reset(type, id) {
        const target = await this.getTarget(type, id);
        target[this._jsonField(type)] = '';
        if (type !== 'pt_subscription') target.metadataAppliedOverrideJson = '';
        await this._repo(type).save(target);
        return { reset: true };
    }

    async createPlan(type, id, proposed, options = {}) {
        const plan = await this.preview(type, id, proposed, { ...options, compareApplied: options.compareApplied !== false });
        if (plan.noop) return plan;
        return { ...plan, planToken: this.planStore.issue(plan, options.scope || {}) };
    }

    async applyPlan(planToken, options = {}) {
        const plan = this.planStore.consume(planToken, options.scope || {});
        return this._withTargetLock(`${plan.targetType}:${plan.targetId}`, async () => {
            const target = await this.getTarget(plan.targetType, plan.targetId);
            if (plan.targetType !== 'pt_subscription') {
                const inspection = await this.inspect(plan.targetType, target);
                if (plan.fingerprint && inspection.fingerprint !== plan.fingerprint) throw new Error('文件指纹已变化，请重新预演元数据计划');
            }
            target[this._jsonField(plan.targetType)] = JSON.stringify(plan.override);
            this._applyWorkFields(plan.targetType, target, plan.override);
            if (plan.targetType !== 'pt_subscription') target.metadataAppliedOverrideJson = JSON.stringify(plan.override);
            await this._repo(plan.targetType).save(target);
            const execution = await this._executeAppliedPlan(plan.targetType, target);
            return { applied: true, preview: plan.preview, override: plan.override, execution };
        });
    }

    async _executeAppliedPlan(type, target) {
        if (type === 'task' && this.organizerService) {
            return this.organizerService.organizeTaskById(target.id, {
                triggerStrm: true,
                force: true,
                forceRefresh: true,
                organizeCloud: !target.enableLazyStrm
            });
        }
        if (type === 'pt_release' && target.status === 'completed' && this.ptService) {
            return this.ptService.rebuildStrm(target.id);
        }
        return { deferred: type === 'pt_release', status: target.status || '' };
    }

    async applySaved(type, id) {
        const target = await this.getTarget(type, id);
        const saved = parseJson(target[this._jsonField(type)], null);
        if (!saved) throw new Error('尚未保存元数据覆盖');
        const inspection = type === 'pt_subscription' ? { fingerprint: '', files: [] } : await this.inspect(type, target);
        const template = type === 'pt_release' ? parseJson(target.metadataTemplateSnapshotJson, null) : null;
        const effective = saved.source === 'agent'
            ? mergeMetadataOverrides({ template, agent: saved })
            : mergeMetadataOverrides({ template, user: saved });
        const plan = {
            targetType: type,
            targetId: target.id,
            targetRef: '',
            fingerprint: inspection.fingerprint,
            override: effective,
            preview: buildPreview(parseJson(target.metadataAppliedOverrideJson, null), effective)
        };
        if (type !== 'pt_subscription' && plan.preview.changeCount === 0 && target.metadataAppliedOverrideJson) return { noop: true, preview: plan.preview };
        const planToken = this.planStore.issue(plan, {});
        return this.applyPlan(planToken);
    }

    _applyWorkFields(type, target, override) {
        const work = override?.work || {};
        if (type === 'task') {
            if (work.tmdbId) target.tmdbId = work.tmdbId;
            if (work.title) target.tmdbTitle = work.title;
            if (work.mediaType) target.videoType = work.mediaType;
            if (work.seasonNumber != null) {
                target.tmdbSeasonNumber = work.seasonNumber;
                if (override.source === 'user') target.manualSeason = work.seasonNumber;
            }
            if (work.seasonName) target.tmdbSeasonName = work.seasonName;
            if (work.totalEpisodes != null) {
                target.tmdbSeasonEpisodes = work.totalEpisodes;
                target.totalEpisodes = work.totalEpisodes;
            }
            if (override.source === 'user') target.manualTmdbBound = Boolean(work.tmdbId);
        } else if (type === 'pt_subscription' && work.totalEpisodes != null) {
            target.totalEpisodeNumber = work.totalEpisodes;
        } else if (type === 'pt_release') {
            if (work.seasonNumber != null) target.seasonNumber = work.seasonNumber;
        }
    }

    async listIntentTargets(intentId) {
        const id = String(intentId || '').trim();
        if (!id) throw new Error('Intent 编号不能为空');
        const [tasks, subscriptions] = await Promise.all([
            this._repo('task').find({ where: { autoSeriesIntentId: id } }),
            this._repo('pt_subscription').find({ where: { autoSeriesIntentId: id } })
        ]);
        const subscriptionIds = subscriptions.map(item => item.id);
        const releases = subscriptionIds.length
            ? await this._repo('pt_release').find({ where: { subscriptionId: In(subscriptionIds) } })
            : [];
        return [...tasks.map(target => this._issueTargetRef(id, 'task', target)),
            ...subscriptions.map(target => this._issueTargetRef(id, 'pt_subscription', target)),
            ...releases.map(target => this._issueTargetRef(id, 'pt_release', target))];
    }

    _issueTargetRef(intentId, type, target) {
        const targetRef = crypto.randomUUID();
        this.targetRefs.set(targetRef, { intentId, type, id: target.id, expiresAt: Date.now() + this.targetRefTtlMs });
        return { targetRef, type, label: type === 'task' ? (target.resourceName || `任务 ${target.id}`) : (target.name || target.title || `${type} ${target.id}`) };
    }

    resolveTargetRef(targetRef, intentId) {
        const ref = String(targetRef || '');
        const entry = this.targetRefs.get(ref);
        if (!entry || entry.expiresAt <= Date.now()) {
            this.targetRefs.delete(ref);
            throw new Error('元数据目标引用不存在或已失效');
        }
        if (String(entry.intentId) !== String(intentId)) throw new Error('元数据目标不属于当前 Intent');
        return entry;
    }

    async _withTargetLock(key, worker) {
        const existing = this.applyLocks.get(key);
        if (existing) await existing;
        let release;
        const lock = new Promise(resolve => { release = resolve; });
        this.applyLocks.set(key, lock);
        try { return await worker(); }
        finally { if (this.applyLocks.get(key) === lock) this.applyLocks.delete(key); release(); }
    }

    buildEffectiveOverride(type, target) {
        const userOrAgent = parseJson(target[this._jsonField(type)], null);
        const template = type === 'pt_release' ? parseJson(target.metadataTemplateSnapshotJson, null) : null;
        return mergeMetadataOverrides({ template, [userOrAgent?.source === 'agent' ? 'agent' : 'user']: userOrAgent });
    }

    buildPreview(current, next) { return buildPreview(current, next); }
    normalize(value, options) { return normalizeMetadataOverride(value, options); }
}

module.exports = { MetadataOverrideService };
