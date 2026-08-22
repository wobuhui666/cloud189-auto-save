const crypto = require('crypto');
const { In, IsNull, LessThanOrEqual } = require('typeorm');
const ConfigService = require('./ConfigService');
const { AppDataSource } = require('../database');
const { classifyOperationError, ERROR_CATEGORIES } = require('./operationError');
const { normalizeMediaPreference, DEFAULT_MEDIA_PREFERENCE } = require('./mediaPreference');
const { normalizeToolCallMode, DEFAULT_AGENT_BUDGET } = require('./autoSeriesAgent');
const { sanitizeWorkflowText, sanitizeWorkflowValue } = require('./workflowRunSanitizer');
const { buildExpectedCoverage, normalizeCoverageState } = require('./autoSeriesCoverage');
const { buildMetadataTemplate } = require('./metadataOverride');
const { auditService } = require('./auditService');

const INTENT_STATUSES = Object.freeze(['pending', 'searching', 'active', 'no_coverage', 'retry_wait', 'failed', 'paused']);
const SYSTEM_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];
const RATE_LIMIT_BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];

function selectRetryBackoffMs(operationError, failureCount) {
    if (operationError?.category === ERROR_CATEGORIES.RATE_LIMIT) {
        const retryAfterMs = Number(operationError.retryAfterMs || 0);
        if (retryAfterMs > 0) return retryAfterMs;
        return RATE_LIMIT_BACKOFF_MS[Math.min(Math.max(Number(failureCount || 1), 1) - 1, RATE_LIMIT_BACKOFF_MS.length - 1)];
    }
    return SYSTEM_BACKOFF_MS[Math.min(Math.max(Number(failureCount || 1), 1) - 1, SYSTEM_BACKOFF_MS.length - 1)];
}

function nextBeijingDailyRun(now = new Date()) {
    const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const utc = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3 - 8, 15, 0, 0));
    if (utc <= now) utc.setUTCDate(utc.getUTCDate() + 1);
    return utc;
}

class AutoSeriesIntentService {
    constructor(options = {}) {
        this.intentRepo = options.intentRepo;
        this.workflowRunRepo = options.workflowRunRepo;
        this.accountRepo = options.accountRepo;
        this.autoSeriesService = options.autoSeriesService;
        this.agentExecutor = options.agentExecutor;
        this.taskService = options.taskService;
        this.taskRepo = options.taskRepo;
        this.ptSubscriptionRepo = options.ptSubscriptionRepo;
        this.ptReleaseRepo = options.ptReleaseRepo;
        this.activeRuns = new Map();
    }

    async create(input = {}) {
        const title = String(input.title || '').trim();
        if (!title) throw new Error('剧名不能为空');
        const autoCreate = this.autoSeriesService.getSettings();
        const accountId = Number(input.accountId || autoCreate.accountId);
        const targetFolderId = String(input.targetFolderId || autoCreate.targetFolderId || '').trim();
        const targetFolder = String(input.targetFolder || autoCreate.targetFolder || '').trim();
        if (!accountId || !targetFolderId || !targetFolder) throw new Error('请先配置自动追剧默认账号和目录');
        const tmdbInfo = await this.autoSeriesService._resolveTmdb(title, String(input.year || ''));
        const requestedSources = Array.isArray(input.sources)
            ? new Set(input.sources.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))
            : null;
        const sourcePreferences = this.autoSeriesService.getSourcePreferences().map(item => ({
            ...item,
            enabled: Boolean(item.enabled && (!requestedSources || requestedSources.has(item.source)))
        }));
        if (!sourcePreferences.some(item => item.enabled)) throw new Error('请至少启用一个自动追剧来源');
        const selected = await this._resolveSelectedResource(input);
        const intent = this.intentRepo.create({
            id: crypto.randomUUID(),
            title,
            year: String(input.year || ''),
            tmdbId: tmdbInfo?.id ? String(tmdbInfo.id) : '',
            tmdbJson: JSON.stringify(this.autoSeriesService._pickTmdbBrief(tmdbInfo) || null),
            accountId,
            targetFolderId,
            targetFolder,
            mode: this.autoSeriesService._normalizeMode(input.mode || autoCreate.mode),
            sourcePreferencesJson: JSON.stringify(sourcePreferences),
            agentEnabled: Boolean(input.agentEnabled ?? autoCreate.agentEnabled),
            toolCallMode: normalizeToolCallMode(input.toolCallMode || autoCreate.toolCallMode || ConfigService.getConfigValue('openai.toolCallMode', 'auto')),
            agentBudgetJson: JSON.stringify({ ...DEFAULT_AGENT_BUDGET, ...(input.agentBudget || {}) }),
            mediaPreferenceJson: JSON.stringify(normalizeMediaPreference(input.mediaPreference || autoCreate.mediaPreference || DEFAULT_MEDIA_PREFERENCE)),
            selectedSource: selected.source,
            selectedResourceId: selected.resourceId,
            selectedShareLink: selected.shareLink,
            selectedResourceTitle: selected.resourceTitle,
            allowHdhivePoints: Boolean(input.allowHdhivePoints ?? autoCreate.allowHdhivePoints),
            hdhiveMaxPoints: Number(input.hdhiveMaxPoints ?? autoCreate.hdhiveMaxPoints),
            keepCasAfterRestore: Boolean(input.keepCasAfterRestore ?? autoCreate.keepCasAfterRestore),
            taskIdsJson: '[]',
            ptSubscriptionIdsJson: '[]',
            coverageJson: JSON.stringify(normalizeCoverageState({}, buildExpectedCoverage(this.autoSeriesService._pickTmdbBrief(tmdbInfo) || null))),
            metadataTemplateJson: JSON.stringify(buildMetadataTemplate(tmdbInfo || {}, 'agent')),
            status: 'pending',
            nextRunAt: new Date(),
            lastError: ''
        });
        await this.intentRepo.save(intent);
        const workflowRunId = crypto.randomUUID();
        const run = this.workflowRunRepo.create({
            id: workflowRunId,
            type: 'auto_series_agent',
            status: 'pending',
            steps: [],
            current: 0,
            context: { title: intent.title, degraded: false },
            subjectType: 'auto_series_intent',
            subjectId: intent.id,
            protocol: intent.agentEnabled ? intent.toolCallMode : 'deterministic',
            summary: '',
            source: 'auto_series'
        });
        await this.workflowRunRepo.save(run);
        intent.lastWorkflowRunId = workflowRunId;
        await this.intentRepo.save(intent);
        setImmediate(() => this.runNow(intent.id).catch(() => {}));
        return { intentId: intent.id, workflowRunId, status: intent.status };
    }

    async _resolveSelectedResource(input = {}) {
        const source = String(input.source || '').trim().toLowerCase();
        const shareLink = String(input.shareLink || '').trim();
        const resourceSlug = String(input.resourceSlug || '').trim();
        if (!source && !shareLink && !resourceSlug) return { source: '', resourceId: '', shareLink: '', resourceTitle: '' };
        if (source === 'subscription') {
            const resource = await AppDataSource.getRepository('SubscriptionResource').findOne({ where: { shareLink, verifyStatus: 'valid' } });
            if (!resource) throw new Error('手动选择的订阅资源不存在或未通过校验');
            return { source, resourceId: String(resource.id), shareLink: '', resourceTitle: '' };
        }
        if (source === 'hdhive') {
            if (!resourceSlug) throw new Error('手动选择的影巢资源缺少服务端标识');
            return { source, resourceId: resourceSlug, shareLink: '', resourceTitle: '' };
        }
        if (source === 'cloudsaver' && shareLink) {
            if (!/^https?:\/\/cloud\.189\.cn\/t\/[A-Za-z0-9_-]+/i.test(shareLink)) throw new Error('手动选择的 CloudSaver 候选不是有效天翼分享链接');
            return { source, resourceId: '', shareLink, resourceTitle: String(input.resourceTitle || '').trim() };
        }
        throw new Error('手动选择资源无法服务端验证，请改用自动选源');
    }

    async list() {
        const intents = await this.intentRepo.find({ order: { updatedAt: 'DESC' } });
        return intents.map(intent => this._publicIntent(intent));
    }

    async pause(id) { return this._setStatus(id, 'paused', null); }
    async resume(id) { return this._setStatus(id, 'pending', new Date()); }

    async delete(id, options = {}) {
        const key = String(id);
        if (this.activeRuns.has(key)) throw new Error('追剧 Intent 正在运行，请稍后再删除');
        const intent = await this.intentRepo.findOneBy({ id: key });
        if (!intent) throw new Error('追剧 Intent 不存在');

        const deleteTasks = options.deleteTasks === true;
        const deleteCloud = options.deleteCloud === true;
        const deletePtSubscriptions = options.deletePtSubscriptions === true;
        const taskIds = await this._relatedTaskIds(intent);
        const ptSubscriptionIds = await this._relatedPtSubscriptionIds(intent);
        const result = {
            intentId: key,
            deletedIntent: false,
            taskIds,
            ptSubscriptionIds,
            deletedTaskIds: [],
            detachedTaskIds: [],
            deletedPtSubscriptionIds: [],
            detachedPtSubscriptionIds: [],
            deletedWorkflowRuns: 0
        };

        if (deleteTasks) {
            if (taskIds.length && !this.taskService?.deleteTask) throw new Error('任务删除服务未初始化');
            for (const taskId of taskIds) {
                await this.taskService.deleteTask(taskId, deleteCloud);
                result.deletedTaskIds.push(taskId);
            }
        } else if (taskIds.length) {
            const taskRepo = this._taskRepo();
            if (taskRepo?.update) {
                await taskRepo.update({ id: In(taskIds) }, { autoSeriesIntentId: '' });
                result.detachedTaskIds = taskIds;
            }
        }

        if (deletePtSubscriptions) {
            const ptSubscriptionRepo = this._ptSubscriptionRepo();
            if (ptSubscriptionIds.length && !ptSubscriptionRepo?.delete) throw new Error('PT 订阅仓库未初始化');
            const ptReleaseRepo = this._ptReleaseRepo();
            if (ptSubscriptionIds.length && ptReleaseRepo?.delete) {
                await ptReleaseRepo.delete({ subscriptionId: In(ptSubscriptionIds) });
            }
            if (ptSubscriptionIds.length) {
                await ptSubscriptionRepo.delete({ id: In(ptSubscriptionIds) });
                result.deletedPtSubscriptionIds = ptSubscriptionIds;
            }
        } else if (ptSubscriptionIds.length) {
            const ptSubscriptionRepo = this._ptSubscriptionRepo();
            if (ptSubscriptionRepo?.update) {
                await ptSubscriptionRepo.update({ id: In(ptSubscriptionIds) }, { autoSeriesIntentId: '' });
                result.detachedPtSubscriptionIds = ptSubscriptionIds;
            }
        }

        if (this.workflowRunRepo?.delete) {
            const deleted = await this.workflowRunRepo.delete({ subjectType: 'auto_series_intent', subjectId: key });
            result.deletedWorkflowRuns = Number(deleted?.affected || 0);
        }
        if (this.intentRepo.delete) {
            await this.intentRepo.delete({ id: key });
        } else if (this.intentRepo.remove) {
            await this.intentRepo.remove(intent);
        } else {
            throw new Error('追剧 Intent 仓库不支持删除');
        }
        result.deletedIntent = true;
        return result;
    }

    async _setStatus(id, status, nextRunAt) {
        if (!INTENT_STATUSES.includes(status)) throw new Error('无效 Intent 状态');
        const intent = await this.intentRepo.findOneBy({ id: String(id) });
        if (!intent) throw new Error('追剧 Intent 不存在');
        intent.status = status;
        intent.nextRunAt = nextRunAt;
        await this.intentRepo.save(intent);
        return this._publicIntent(intent);
    }

    async runNow(id) {
        const key = String(id);
        if (this.activeRuns.has(key)) return this.activeRuns.get(key);
        const runner = this._run(key).finally(() => this.activeRuns.delete(key));
        this.activeRuns.set(key, runner);
        return runner;
    }

    async _run(id) {
        const intent = await this.intentRepo.findOneBy({ id });
        if (!intent) throw new Error('追剧 Intent 不存在');
        if (intent.status === 'paused') throw new Error('追剧 Intent 已暂停');
        intent.status = 'searching';
        intent.lastRunAt = new Date();
        intent.nextRunAt = null;
        let run = intent.lastWorkflowRunId ? await this.workflowRunRepo.findOneBy({ id: intent.lastWorkflowRunId }) : null;
        if (!run || run.status !== 'pending') {
            run = this.workflowRunRepo.create({ id: crypto.randomUUID(), type: 'auto_series_agent', status: 'running', steps: [], current: 0, context: { title: intent.title, degraded: false }, subjectType: 'auto_series_intent', subjectId: intent.id, protocol: intent.agentEnabled ? intent.toolCallMode : 'deterministic', summary: '', source: 'auto_series' });
        } else {
            run.status = 'running';
        }
        await this.workflowRunRepo.save(run);
        intent.lastWorkflowRunId = run.id;
        await this.intentRepo.save(intent);

        const auditRun = await auditService.mirrorWorkflowRun(run, {
            correlationId: `intent:${intent.id}`,
            module: 'auto_series',
            trigger: run.source || 'auto_series',
            subjectName: intent.title,
            accountId: intent.accountId
        });
        const execute = async () => {
        try {
            await auditService.event('source_search', '开始搜索追剧来源', {
                phase: 'search',
                data: {
                    sources: this._parseJson(intent.sourcePreferencesJson, []).filter(item => item.enabled).map(item => item.source),
                    mode: intent.mode,
                    agentEnabled: intent.agentEnabled,
                    tmdbId: intent.tmdbId || ''
                }
            });
            await this._hydrateTmdbIfMissing(intent);
            const context = this._context(intent);
            let result;
            if (intent.agentEnabled) {
                let budget = {};
                try { budget = JSON.parse(intent.agentBudgetJson || '{}'); } catch (_) {}
                // Agent 模式禁止退回未审计的确定性提交；失败交由 Intent 现有退避策略重试。
                result = await this.agentExecutor.run(context, { toolCallMode: intent.toolCallMode, budget });
            } else {
                result = { status: 'completed', result: await this.autoSeriesService.createByTitle(context) };
            }
            const payload = result.result || result;
            await auditService.event('candidate_decision', '候选评分与来源决策完成', {
                phase: 'decision',
                data: {
                    tools: (result.actions || []).map(action => ({ name: action.name, protocol: action.protocol })),
                    preferenceScore: result.preferenceScore ?? null,
                    protocol: result.protocol || run.protocol,
                    selectedSource: payload.source || intent.selectedSource || '',
                    degraded: Boolean(result.degraded),
                    degradedReason: result.degradedReason || '',
                    candidateSummary: result.candidateSummary || null
                }
            });
            if (intent.agentEnabled && this.agentExecutor?.metadataService) {
                const audits = await this._auditExistingMetadataTargets(intent, context, run);
                if (audits.length) {
                    run.context = { ...(run.context || {}), metadataAudits: audits };
                }
            }
            if (result.status === 'no_coverage') {
                intent.status = 'no_coverage';
                intent.nextRunAt = nextBeijingDailyRun();
                intent.failureCount = 0;
                intent.lastError = '';
                run.status = 'no_coverage';
                run.summary = sanitizeWorkflowText(result.reason || '无覆盖资源');
                await auditService.recordOperation('skip', 'skipped', {
                    reason: result.reason || '无覆盖资源',
                    decisionSource: intent.agentEnabled ? 'agent' : 'deterministic'
                });
            } else {
                const previousTaskIds = this._parseIdList(intent.taskIdsJson, intent.taskId);
                const previousSubscriptionIds = this._parseIdList(intent.ptSubscriptionIdsJson, intent.ptSubscriptionId);
                const taskIds = [...new Set([...previousTaskIds, ...(payload.taskIds || [])].map(Number).filter(Boolean))];
                const subscriptionIds = [...new Set([
                    ...previousSubscriptionIds,
                    ...(payload.subscriptionIds || []),
                    payload.subscriptionId
                ].map(Number).filter(Boolean))];
                intent.taskIdsJson = JSON.stringify(taskIds);
                intent.ptSubscriptionIdsJson = JSON.stringify(subscriptionIds);
                intent.taskId = taskIds[0] || null;
                intent.ptSubscriptionId = subscriptionIds[0] || null;
                const expectedCoverage = buildExpectedCoverage(context.tmdbInfo);
                const coverage = normalizeCoverageState(payload.coverage || result.coverage || this._parseJson(intent.coverageJson, {}), expectedCoverage);
                intent.coverageJson = JSON.stringify(coverage);
                intent.status = payload.coverageComplete === false
                    ? 'no_coverage'
                    : 'active';
                intent.nextRunAt = intent.status === 'no_coverage' ? nextBeijingDailyRun() : null;
                intent.failureCount = 0;
                intent.lastError = '';
                run.status = intent.status === 'no_coverage' ? 'no_coverage' : 'completed';
                run.summary = intent.status === 'no_coverage'
                    ? `已覆盖 ${coverage.coveredEpisodes}/${coverage.expectedEpisodes} 集，等待补齐`
                    : `已关联 ${taskIds.length} 个任务、${subscriptionIds.length} 个 PT 订阅`;
                if (intent.ptSubscriptionId) {
                    const subscription = await AppDataSource.getRepository('PtSubscription').findOneBy({ id: Number(intent.ptSubscriptionId) });
                    if (subscription) {
                        if (subscription.filterManagedBy === 'agent') {
                            run.context = {
                                ...(run.context || {}),
                                regexValidation: {
                                    hash: subscription.filterValidationHash || '',
                                    managedBy: subscription.filterManagedBy
                                }
                            };
                        }
                    }
                }
            }
            run.protocol = result.protocol || run.protocol;
            run.context = sanitizeWorkflowValue({
                ...(run.context || {}),
                tools: (result.actions || []).map(action => ({ callId: action.callId, name: action.name, protocol: action.protocol })),
                preferenceScore: result.preferenceScore ?? null,
                regexValidation: result.regexValidation || null,
                coverage: this._parseJson(intent.coverageJson, null),
                missingKeys: result.missingKeys || payload.missingKeys || []
            });
            run.context = sanitizeWorkflowValue({
                ...(run.context || {}),
                taskId: intent.taskId,
                ptSubscriptionId: intent.ptSubscriptionId,
                taskIds: this._parseIdList(intent.taskIdsJson, intent.taskId),
                ptSubscriptionIds: this._parseIdList(intent.ptSubscriptionIdsJson, intent.ptSubscriptionId)
            });
            await this.workflowRunRepo.save(run);
            await this.intentRepo.save(intent);
            await auditService.finishRun(auditRun, run.status, {
                summary: run.summary,
                metadata: {
                    workflowRunId: run.id,
                    protocol: run.protocol,
                    taskIds: this._parseIdList(intent.taskIdsJson, intent.taskId),
                    ptSubscriptionIds: this._parseIdList(intent.ptSubscriptionIdsJson, intent.ptSubscriptionId),
                    coverage: this._parseJson(intent.coverageJson, null)
                }
            });
            return { workflowRunId: run.id, status: intent.status, result };
        } catch (error) {
            const operationError = classifyOperationError(error, { source: 'auto_series_intent', operation: 'run' });
            if (Array.isArray(error.agentActions) || Array.isArray(error.agentTrace)) {
                run.context = sanitizeWorkflowValue({
                    ...(run.context || {}),
                    tools: (error.agentActions || []).map(action => ({ callId: action.callId, name: action.name, protocol: action.protocol })),
                    trace: error.agentTrace || []
                });
            }
            intent.failureCount = Number(intent.failureCount || 0) + 1;
            intent.lastError = sanitizeWorkflowText(operationError.message).slice(0, 1000);
            if ([ERROR_CATEGORIES.AUTH, ERROR_CATEGORIES.PERMISSION, ERROR_CATEGORIES.PARAMETER].includes(operationError.category)) {
                intent.status = 'failed';
                intent.nextRunAt = null;
            } else if (operationError.category === ERROR_CATEGORIES.RESOURCE_INVALID) {
                intent.status = 'no_coverage';
                intent.nextRunAt = nextBeijingDailyRun();
            } else {
                intent.status = 'retry_wait';
                intent.nextRunAt = new Date(Date.now() + selectRetryBackoffMs(operationError, intent.failureCount));
            }
            run.status = intent.status === 'no_coverage' ? 'no_coverage' : 'failed';
            run.summary = sanitizeWorkflowText(intent.lastError);
            await this.workflowRunRepo.save(run);
            await this.intentRepo.save(intent);
            await auditService.finishRun(auditRun, 'failed', {
                summary: run.summary || '自动追剧执行失败',
                error: operationError.message,
                metadata: {
                    workflowRunId: run.id,
                    category: operationError.category,
                    retryAt: intent.nextRunAt
                }
            });
            throw error;
        }
        };
        return auditRun ? auditService.runInContext(auditRun, execute) : execute();
    }

    async _hydrateTmdbIfMissing(intent) {
        const existing = this._parseJson(intent.tmdbJson, null);
        if (existing || typeof this.autoSeriesService?._resolveTmdb !== 'function') return existing;
        try {
            const resolved = await this.autoSeriesService._resolveTmdb(intent.title, intent.year);
            const brief = this.autoSeriesService._pickTmdbBrief(resolved);
            if (!brief) return null;
            intent.tmdbId = brief.id ? String(brief.id) : '';
            intent.tmdbJson = JSON.stringify(brief);
            intent.coverageJson = JSON.stringify(normalizeCoverageState(
                this._parseJson(intent.coverageJson, {}),
                buildExpectedCoverage(brief)
            ));
            const currentTemplate = this._parseJson(intent.metadataTemplateJson, null);
            if (!currentTemplate || currentTemplate.source !== 'user') {
                intent.metadataTemplateJson = JSON.stringify(buildMetadataTemplate(resolved, 'agent'));
            }
            await this.intentRepo.save(intent);
            return brief;
        } catch (_) {
            return null;
        }
    }

    _context(intent) {
        const selectedSource = String(intent.selectedSource || '');
        const parseJson = (value, fallback) => {
            try { return JSON.parse(value || ''); } catch (_) { return fallback; }
        };
        return {
            intentId: intent.id,
            autoSeriesIntentId: intent.id,
            title: intent.title,
            year: intent.year,
            mode: intent.mode,
            sources: parseJson(intent.sourcePreferencesJson, []).filter(item => item.enabled).map(item => item.source),
            accountId: intent.accountId,
            targetFolderId: intent.targetFolderId,
            targetFolder: intent.targetFolder,
            tmdbInfo: parseJson(intent.tmdbJson, null),
            agentEnabled: intent.agentEnabled,
            mediaPreference: parseJson(intent.mediaPreferenceJson, {}),
            allowHdhivePoints: intent.allowHdhivePoints,
            hdhiveMaxPoints: intent.hdhiveMaxPoints,
            keepCasAfterRestore: intent.keepCasAfterRestore,
            source: selectedSource,
            shareLink: String(intent.selectedShareLink || ''),
            resourceTitle: String(intent.selectedResourceTitle || ''),
            resourceSlug: selectedSource === 'hdhive' ? String(intent.selectedResourceId || '') : '',
            subscriptionResourceId: selectedSource === 'subscription' ? Number(intent.selectedResourceId || 0) : 0,
            coverageState: parseJson(intent.coverageJson, {}),
            metadataTemplate: parseJson(intent.metadataTemplateJson, null)
        };
    }

    async _auditExistingMetadataTargets(intent, context, run) {
        const service = this.agentExecutor.metadataService;
        const targets = await service.listIntentTargets(intent.id);
        const audits = [];
        for (const target of targets) {
            try {
                const resolved = service.resolveTargetRef(target.targetRef, intent.id);
                if (resolved.type === 'pt_subscription') continue;
                const targetObject = await service.getTarget(resolved.type, resolved.id);
                const inspection = await service.inspect(resolved.type, targetObject);
                const existing = service.buildEffectiveOverride(resolved.type, targetObject);
                const tmdbChanged = existing?.work?.tmdbId && context.tmdbInfo?.id
                    && String(existing.work.tmdbId) !== String(context.tmdbInfo.id);
                const fingerprintChanged = existing?.fingerprint && inspection.fingerprint
                    && existing.fingerprint !== inspection.fingerprint;
                if (!tmdbChanged && !fingerprintChanged) {
                    audits.push({ targetRef: target.targetRef, type: resolved.type, changed: false, fingerprint: inspection.fingerprint });
                    continue;
                }
                // 巡检发现真实文件树或 TMDB 锚点变化时，不绕过 Agent 决策；下一轮上下文会要求重新规划。
                audits.push({ targetRef: target.targetRef, type: resolved.type, changed: true, reason: tmdbChanged ? 'tmdb_changed' : 'fingerprint_changed' });
            } catch (error) {
                audits.push({ targetRef: target.targetRef, type: target.type, changed: false, error: sanitizeWorkflowText(error.message || error) });
            }
        }
        return audits;
    }

    _parseJson(value, fallback) {
        try { return JSON.parse(value || ''); } catch (_) { return fallback; }
    }

    _parseIdList(value, legacyId = null) {
        const ids = this._parseJson(value, []);
        return [...new Set([...(Array.isArray(ids) ? ids : []), legacyId].map(Number).filter(Boolean))];
    }

    _taskRepo() {
        return this.taskRepo || this.taskService?.taskRepo || (AppDataSource.isInitialized ? AppDataSource.getRepository('Task') : null);
    }

    _ptSubscriptionRepo() {
        return this.ptSubscriptionRepo || (AppDataSource.isInitialized ? AppDataSource.getRepository('PtSubscription') : null);
    }

    _ptReleaseRepo() {
        return this.ptReleaseRepo || (AppDataSource.isInitialized ? AppDataSource.getRepository('PtRelease') : null);
    }

    async _relatedTaskIds(intent) {
        const ids = new Set(this._parseIdList(intent.taskIdsJson, intent.taskId));
        const taskRepo = this._taskRepo();
        if (taskRepo?.find) {
            const tasks = await taskRepo.find({ where: { autoSeriesIntentId: intent.id } });
            for (const task of tasks || []) {
                const taskId = Number(task?.id || 0);
                if (taskId) ids.add(taskId);
            }
        }
        return [...ids].sort((left, right) => left - right);
    }

    async _relatedPtSubscriptionIds(intent) {
        const ids = new Set(this._parseIdList(intent.ptSubscriptionIdsJson, intent.ptSubscriptionId));
        const ptSubscriptionRepo = this._ptSubscriptionRepo();
        if (ptSubscriptionRepo?.find) {
            const subscriptions = await ptSubscriptionRepo.find({ where: { autoSeriesIntentId: intent.id } });
            for (const subscription of subscriptions || []) {
                const subscriptionId = Number(subscription?.id || 0);
                if (subscriptionId) ids.add(subscriptionId);
            }
        }
        return [...ids].sort((left, right) => left - right);
    }

    _publicIntent(intent) {
        const { selectedShareLink, ...publicIntent } = intent || {};
        if (publicIntent.lastError) publicIntent.lastError = sanitizeWorkflowText(publicIntent.lastError);
        return publicIntent;
    }

    async runDue() {
        const ready = await this.intentRepo.find({ where: { status: In(['pending', 'no_coverage', 'retry_wait']), nextRunAt: LessThanOrEqual(new Date()) } });
        const unplanned = await this.intentRepo.find({ where: { status: In(['pending', 'retry_wait']), nextRunAt: IsNull() } });
        const due = [...new Map([...ready, ...unplanned].map(intent => [intent.id, intent])).values()];
        for (const intent of due) this.runNow(intent.id).catch(() => {});
        return { scheduled: due.length };
    }

    async recoverStaleSearching() {
        const threshold = new Date(Date.now() - 10 * 60 * 1000);
        const stale = await this.intentRepo.find({ where: { status: 'searching', updatedAt: LessThanOrEqual(threshold) } });
        for (const intent of stale) {
            intent.status = 'retry_wait';
            intent.nextRunAt = new Date();
            intent.lastError = '服务重启后恢复异常 searching 状态';
            await this.intentRepo.save(intent);
        }
        return stale.length;
    }
}

module.exports = { AutoSeriesIntentService, INTENT_STATUSES, SYSTEM_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS, selectRetryBackoffMs, nextBeijingDailyRun };
