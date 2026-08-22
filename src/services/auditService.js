const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const AUDIT_ACTIONS = Object.freeze([
    'identify', 'classify', 'rename', 'move', 'upgrade', 'upload', 'delete', 'strm', 'notify', 'skip'
]);
const FINAL_STATUSES = new Set(['completed', 'failed', 'partial', 'interrupted', 'skipped', 'no_coverage', 'retrying', 'retry_wait']);
const MAX_AUDIT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|passwd|secret|token|api.?key|access.?key|share.?link|magnet|rss.?url|torrent.?url|webhook)/i;
const URL_PATTERN = /(?:https?|ftp):\/\/[^\s"'<>]+/gi;
const MAGNET_PATTERN = /magnet:\?[^\s"'<>]+/gi;

const auditStorage = new AsyncLocalStorage();

function parseAuditDate(value) {
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value.trim())) {
        return new Date(`${value.trim().replace(' ', 'T')}Z`);
    }
    return new Date(value);
}

function normalizeAuditDate(value, fallback = new Date(), now = Date.now()) {
    if (value == null || value === '') return fallback;
    const date = parseAuditDate(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() > now + MAX_AUDIT_FUTURE_SKEW_MS) return fallback;
    return date;
}

function sanitizeAuditText(value = '') {
    return String(value)
        .replace(URL_PATTERN, '[REDACTED_URL]')
        .replace(MAGNET_PATTERN, '[REDACTED_MAGNET]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
        .replace(/((?:api[_ -]?key|token|secret|password|cookie)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function sanitizeAuditValue(value, key = '', seen = new WeakSet()) {
    const normalizedKey = String(key).toLowerCase().replace(/[_-]/g, '');
    if (normalizedKey && SENSITIVE_KEY_PATTERN.test(normalizedKey)) return '[REDACTED]';
    if (typeof value === 'string') return sanitizeAuditText(value);
    if (value == null || typeof value !== 'object' || value instanceof Date) return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 500).map(item => sanitizeAuditValue(item, '', seen));
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeAuditValue(child, childKey, seen)
    ]));
}

function safeJson(value, fallback = '') {
    if (value == null) return fallback;
    try {
        return JSON.stringify(sanitizeAuditValue(value));
    } catch (_) {
        return fallback;
    }
}

function parseJson(value, fallback = null) {
    if (!value) return fallback;
    try { return sanitizeAuditValue(JSON.parse(value)); } catch (_) { return fallback; }
}

function normalizeStatus(status, fallback = 'completed') {
    const value = String(status || '').trim().toLowerCase();
    if (value === 'success' || value === 'active') return 'completed';
    if (value === 'error') return 'failed';
    if (value === 'retrying' || value === 'retry_wait' || value === 'pending' || value === 'processing' || value === 'searching') return value;
    return value || fallback;
}

function moduleForWorkflow(type = '') {
    const value = String(type || '').toLowerCase();
    if (value.includes('auto_series') || value.includes('metadata')) return 'auto_series';
    if (value.includes('pt')) return 'pt';
    if (value.includes('organizer')) return 'organizer';
    if (value.includes('cas')) return 'cas';
    if (value.includes('strm')) return 'strm';
    return value === 'task_execution' ? 'transfer' : (value || 'workflow');
}

class AuditService {
    constructor(options = {}) {
        this.dataSource = options.dataSource || null;
        this.sequenceByRun = new Map();
    }

    _dataSource() {
        if (this.dataSource) return this.dataSource;
        try { return require('../database').AppDataSource; } catch (_) { return null; }
    }

    isAvailable() {
        return Boolean(this._dataSource()?.isInitialized);
    }

    _repo(entity) {
        return this._dataSource().getRepository(entity);
    }

    current() {
        return auditStorage.getStore() || null;
    }

    runInContext(run, callback) {
        if (!run?.id || typeof callback !== 'function') return callback();
        const parent = this.current();
        return auditStorage.run({
            runId: run.id,
            correlationId: run.correlationId,
            module: run.module,
            subjectType: run.subjectType,
            subjectId: run.subjectId,
            accountId: run.accountId,
            parentRunId: run.parentRunId || parent?.runId || ''
        }, callback);
    }

    async _safeWrite(label, callback, fallback = null) {
        if (!this.isAvailable()) return fallback;
        try {
            return await callback();
        } catch (error) {
            console.error(`[Audit] ${label}失败，原业务继续: ${error.message || error}`);
            return fallback;
        }
    }

    async startRun(options = {}) {
        return this._safeWrite('创建运行', async () => {
            const current = this.current();
            const id = String(options.id || crypto.randomUUID());
            const now = new Date();
            const startedAt = normalizeAuditDate(options.startedAt, now, now.getTime());
            const finishedAt = options.finishedAt == null
                ? null
                : normalizeAuditDate(options.finishedAt, startedAt, now.getTime());
            const run = this._repo('AuditRun').create({
                id,
                correlationId: String(options.correlationId || current?.correlationId || id),
                parentRunId: String(options.parentRunId || current?.runId || ''),
                module: sanitizeAuditText(options.module || current?.module || 'system').slice(0, 80),
                trigger: sanitizeAuditText(options.trigger || 'system').slice(0, 80),
                subjectType: sanitizeAuditText(options.subjectType || current?.subjectType || '').slice(0, 80),
                subjectId: sanitizeAuditText(options.subjectId ?? current?.subjectId ?? '').slice(0, 200),
                subjectName: sanitizeAuditText(options.subjectName || '').slice(0, 500),
                accountId: Number(options.accountId || current?.accountId || 0) || null,
                status: normalizeStatus(options.status, 'running'),
                summary: sanitizeAuditText(options.summary || '').slice(0, 2000),
                changeCount: Number(options.changeCount || 0),
                failureCount: Number(options.failureCount || 0),
                metadataJson: safeJson(options.metadata),
                legacyKey: options.legacyKey ? String(options.legacyKey) : null,
                startedAt,
                finishedAt
            });
            const saved = await this._repo('AuditRun').save(run);
            this.sequenceByRun.set(id, { event: 0, operation: 0 });
            if (options.message !== false) {
                await this.event('run_started', options.message || '运行开始', {
                    phase: 'start', runId: id, data: options.metadata
                });
            }
            return saved;
        });
    }

    async _nextSequence(runId, kind) {
        const cached = this.sequenceByRun.get(runId) || { event: 0, operation: 0 };
        if (!cached[kind]) {
            const table = kind === 'event' ? 'audit_event' : 'audit_operation';
            const rows = await this._dataSource().query(`SELECT COALESCE(MAX("sequence"), 0) AS value FROM "${table}" WHERE "runId" = ?`, [runId]);
            cached[kind] = Number(rows?.[0]?.value || 0);
        }
        cached[kind] += 1;
        this.sequenceByRun.set(runId, cached);
        return cached[kind];
    }

    async event(type, message, options = {}) {
        return this._safeWrite('写入事件', async () => {
            const runId = String(options.runId || this.current()?.runId || '');
            if (!runId) return null;
            const event = this._repo('AuditEvent').create({
                runId,
                sequence: await this._nextSequence(runId, 'event'),
                type: sanitizeAuditText(type || 'stage').slice(0, 80),
                level: sanitizeAuditText(options.level || (options.error ? 'error' : 'info')).slice(0, 20),
                phase: sanitizeAuditText(options.phase || '').slice(0, 80),
                message: sanitizeAuditText(message || '').slice(0, 2000),
                dataJson: safeJson(options.data),
                error: sanitizeAuditText(options.error || '').slice(0, 4000)
            });
            return await this._repo('AuditEvent').save(event);
        });
    }

    async planOperation(action, options = {}) {
        return this._safeWrite('写入操作计划', async () => {
            const runId = String(options.runId || this.current()?.runId || '');
            if (!runId) return null;
            const operation = this._repo('AuditOperation').create({
                runId,
                sequence: await this._nextSequence(runId, 'operation'),
                action: AUDIT_ACTIONS.includes(action) ? action : 'skip',
                status: 'planned',
                sourcePath: sanitizeAuditText(options.sourcePath || '').slice(0, 4096),
                targetPath: sanitizeAuditText(options.targetPath || '').slice(0, 4096),
                beforeJson: safeJson(options.before),
                afterJson: safeJson(options.after),
                reason: sanitizeAuditText(options.reason || '').slice(0, 2000),
                decisionSource: sanitizeAuditText(options.decisionSource || '').slice(0, 120),
                verificationJson: '',
                attempts: 1,
                error: '',
                completedAt: null
            });
            return await this._repo('AuditOperation').save(operation);
        });
    }

    async completeOperation(operation, status, options = {}) {
        return this._safeWrite('完成操作', async () => {
            if (!operation?.id) return null;
            const previousStatus = operation.status;
            operation.status = normalizeStatus(status, 'completed');
            operation.verificationJson = safeJson(options.verification);
            operation.afterJson = options.after === undefined ? operation.afterJson : safeJson(options.after);
            operation.attempts = Math.max(1, Number(options.attempts || operation.attempts || 1));
            operation.error = sanitizeAuditText(options.error || '').slice(0, 4000);
            operation.completedAt = new Date();
            const saved = await this._repo('AuditOperation').save(operation);
            if (previousStatus === 'planned') {
                const failed = saved.status === 'failed';
                const changed = saved.status === 'completed';
                if (failed || changed) {
                    await this._repo('AuditRun').createQueryBuilder()
                        .update()
                        .set(failed
                            ? { failureCount: () => '"failureCount" + 1' }
                            : { changeCount: () => '"changeCount" + 1' })
                        .where('id = :id', { id: saved.runId })
                        .execute();
                }
            }
            return saved;
        });
    }

    async recordOperation(action, status, options = {}) {
        const operation = await this.planOperation(action, options);
        if (!operation) return null;
        return this.completeOperation(operation, status, options);
    }

    async finishRun(runOrId, status, options = {}) {
        return this._safeWrite('结束运行', async () => {
            const id = String(runOrId?.id || runOrId || '');
            if (!id) return null;
            const repo = this._repo('AuditRun');
            const run = typeof runOrId === 'object' ? runOrId : await repo.findOneBy({ id });
            if (!run) return null;
            run.status = normalizeStatus(status, 'completed');
            run.summary = sanitizeAuditText(options.summary ?? run.summary ?? '').slice(0, 2000);
            run.metadataJson = options.metadata === undefined ? run.metadataJson : safeJson(options.metadata);
            run.finishedAt = FINAL_STATUSES.has(run.status)
                ? new Date()
                : normalizeAuditDate(options.finishedAt, run.finishedAt, Date.now());
            const saved = await repo.save(run);
            await this.event('run_finished', options.message || '运行结束', {
                runId: id,
                phase: 'complete',
                level: run.status === 'failed' ? 'error' : 'info',
                error: options.error,
                data: { status: run.status, summary: run.summary }
            });
            return saved;
        });
    }

    async markInterruptedRuns() {
        return this._safeWrite('标记中断运行', async () => {
            const rows = await this._repo('AuditRun').findBy({ status: 'running' });
            for (const run of rows) {
                run.status = 'interrupted';
                run.finishedAt = new Date();
                run.summary = run.summary || '服务重启，运行被中断';
                await this._repo('AuditRun').save(run);
                await this.event('interrupted', '服务重启，运行被中断', { runId: run.id, level: 'warn', phase: 'interrupted' });
            }
            return rows.length;
        }, 0);
    }

    async repairFutureDates() {
        return this._safeWrite('修复未来审计时间', async () => {
            const rows = await this._dataSource().query(`
                SELECT id
                FROM audit_run
                WHERE startedAt > datetime('now', '+1 day')
                   OR finishedAt > datetime('now', '+1 day')
            `);
            if (!rows.length) return 0;
            await this._dataSource().query(`
                UPDATE audit_run
                SET startedAt = CASE
                        WHEN startedAt > datetime('now', '+1 day') THEN createdAt
                        ELSE startedAt
                    END,
                    finishedAt = CASE
                        WHEN finishedAt > datetime('now', '+1 day')
                            THEN CASE
                                WHEN updatedAt <= datetime('now', '+1 day') THEN updatedAt
                                ELSE createdAt
                            END
                        ELSE finishedAt
                    END,
                    updatedAt = datetime('now')
                WHERE startedAt > datetime('now', '+1 day')
                   OR finishedAt > datetime('now', '+1 day')
            `);
            return rows.length;
        }, 0);
    }

    async mirrorWorkflowRun(workflowRun, options = {}) {
        if (!workflowRun?.id) return null;
        const existing = await this._safeWrite('查询关联运行', () => this._repo('AuditRun').findOneBy({ legacyKey: `workflow:${workflowRun.id}` }));
        if (existing) return existing;
        const context = sanitizeAuditValue(workflowRun.context || {});
        return this.startRun({
            correlationId: options.correlationId || context.correlationId || workflowRun.id,
            parentRunId: options.parentRunId,
            module: options.module || moduleForWorkflow(workflowRun.type),
            trigger: options.trigger || workflowRun.source || context.trigger || 'workflow',
            subjectType: options.subjectType || workflowRun.subjectType || '',
            subjectId: options.subjectId || workflowRun.subjectId || '',
            subjectName: options.subjectName || context.taskName || context.title || '',
            accountId: options.accountId || context.accountId,
            status: normalizeStatus(workflowRun.status, 'running'),
            summary: workflowRun.summary || '',
            metadata: { workflowRunId: workflowRun.id, protocol: workflowRun.protocol || '', legacy: false },
            legacyKey: `workflow:${workflowRun.id}`
        });
    }

    async syncWorkflowRun(workflowRun, options = {}) {
        const auditRun = await this.mirrorWorkflowRun(workflowRun, options);
        if (!auditRun) return null;
        const latestStep = Array.isArray(workflowRun.steps) ? workflowRun.steps[workflowRun.steps.length - 1] : null;
        if (latestStep) {
            await this.event('stage', latestStep.activity || latestStep.phase || '阶段更新', {
                runId: auditRun.id,
                phase: latestStep.phase,
                data: latestStep.details
            });
        }
        const status = normalizeStatus(workflowRun.status, 'running');
        if (status !== 'running' && status !== 'pending') {
            await this.finishRun(auditRun, status, {
                summary: workflowRun.summary || workflowRun.context?.activity || '',
                error: workflowRun.context?.error
            });
        }
        return auditRun;
    }

    _applyRunFilters(query, filters = {}) {
        const keyword = String(filters.keyword || '').trim();
        if (keyword) {
            query.andWhere('(run.subjectName LIKE :keyword OR run.summary LIKE :keyword OR run.subjectId LIKE :keyword OR run.correlationId LIKE :keyword)', { keyword: `%${keyword}%` });
        }
        if (filters.module) query.andWhere('run.module = :module', { module: String(filters.module) });
        if (filters.status) query.andWhere('run.status = :status', { status: String(filters.status) });
        if (filters.accountId) query.andWhere('run.accountId = :accountId', { accountId: Number(filters.accountId) });
        if (filters.subjectType) query.andWhere('run.subjectType = :subjectType', { subjectType: String(filters.subjectType) });
        if (filters.subjectId) query.andWhere('run.subjectId = :subjectId', { subjectId: String(filters.subjectId) });
        if (filters.correlationId) query.andWhere('run.correlationId = :correlationId', { correlationId: String(filters.correlationId) });
        if (filters.startAt) query.andWhere('run.startedAt >= :startAt', { startAt: new Date(filters.startAt) });
        if (filters.endAt) query.andWhere('run.startedAt <= :endAt', { endAt: new Date(filters.endAt) });
        if (filters.action) {
            query.andWhere('EXISTS (SELECT 1 FROM audit_operation op WHERE op.runId = run.id AND op.action = :action)', { action: String(filters.action) });
        }
        return query;
    }

    _publicRun(run) {
        return sanitizeAuditValue({
            ...run,
            metadata: parseJson(run.metadataJson, {}),
            metadataJson: undefined
        });
    }

    async listRuns(filters = {}) {
        const page = Math.max(1, Number(filters.page || 1));
        const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize || 50)));
        const base = this._applyRunFilters(this._repo('AuditRun').createQueryBuilder('run'), filters);
        const total = await base.clone().getCount();
        const aggregate = await base.clone()
            .select('COALESCE(SUM(run.changeCount), 0)', 'changes')
            .addSelect('COALESCE(SUM(run.failureCount), 0)', 'failures')
            .addSelect("COALESCE(SUM(CASE WHEN run.status = 'running' THEN 1 ELSE 0 END), 0)", 'running')
            .getRawOne();
        const items = await base.orderBy('run.startedAt', 'DESC').addOrderBy('run.createdAt', 'DESC')
            .skip((page - 1) * pageSize).take(pageSize).getMany();
        return {
            items: items.map(run => this._publicRun(run)),
            page,
            pageSize,
            total,
            pages: Math.max(1, Math.ceil(total / pageSize)),
            stats: {
                runs: total,
                changes: Number(aggregate?.changes || 0),
                failures: Number(aggregate?.failures || 0),
                running: Number(aggregate?.running || 0)
            }
        };
    }

    async getRunDetail(id) {
        const run = await this._repo('AuditRun').findOneBy({ id: String(id) });
        if (!run) return null;
        const [events, operations, relatedRuns] = await Promise.all([
            this._repo('AuditEvent').find({ where: { runId: run.id }, order: { sequence: 'ASC', id: 'ASC' } }),
            this._repo('AuditOperation').find({ where: { runId: run.id }, order: { sequence: 'ASC', id: 'ASC' } }),
            this._repo('AuditRun').find({ where: { correlationId: run.correlationId }, order: { startedAt: 'ASC' } })
        ]);
        return sanitizeAuditValue({
            run: this._publicRun(run),
            events: events.map(event => ({ ...event, data: parseJson(event.dataJson, {}), dataJson: undefined })),
            operations: operations.map(operation => ({
                ...operation,
                before: parseJson(operation.beforeJson),
                after: parseJson(operation.afterJson),
                verification: parseJson(operation.verificationJson),
                beforeJson: undefined,
                afterJson: undefined,
                verificationJson: undefined
            })),
            relatedRuns: relatedRuns.map(item => this._publicRun(item))
        });
    }

    async getFilterOptions() {
        const dataSource = this._dataSource();
        const [modules, actions, statuses, accounts] = await Promise.all([
            dataSource.query('SELECT DISTINCT module AS value FROM audit_run WHERE module <> \'\' ORDER BY module'),
            dataSource.query('SELECT DISTINCT action AS value FROM audit_operation WHERE action <> \'\' ORDER BY action'),
            dataSource.query('SELECT DISTINCT status AS value FROM audit_run WHERE status <> \'\' ORDER BY status'),
            dataSource.query('SELECT id, username, alias FROM account ORDER BY id')
        ]);
        return sanitizeAuditValue({
            modules: modules.map(item => item.value),
            actions: actions.map(item => item.value),
            statuses: statuses.map(item => item.value),
            accounts: accounts.map(item => ({ id: item.id, label: item.alias || item.username || `账号 ${item.id}` }))
        });
    }

    async backfillLegacy(options = {}) {
        const limit = Math.min(5000, Math.max(1, Number(options.limit || 1000)));
        return this._safeWrite('回填旧数据', async () => {
            let imported = 0;
            const workflowRows = await this._dataSource().query('SELECT * FROM workflow_run ORDER BY createdAt DESC LIMIT ?', [limit]);
            for (const row of workflowRows) {
                const existing = await this._repo('AuditRun').findOneBy({ legacyKey: `workflow:${row.id}` });
                if (existing) continue;
                const context = parseJson(row.context, {});
                const steps = parseJson(row.steps, []);
                const auditRun = await this.startRun({
                    correlationId: context.correlationId || row.id,
                    module: moduleForWorkflow(row.type),
                    trigger: row.source || 'legacy',
                    subjectType: row.subjectType || '',
                    subjectId: row.subjectId || '',
                    subjectName: context.taskName || context.title || '',
                    accountId: context.accountId,
                    status: normalizeStatus(row.status),
                    summary: row.summary || '历史数据，逐文件明细不完整',
                    metadata: { legacy: true, incomplete: true, workflowRunId: row.id, protocol: row.protocol || '' },
                    legacyKey: `workflow:${row.id}`,
                    startedAt: row.createdAt,
                    finishedAt: row.status === 'running' || row.status === 'pending' ? null : row.updatedAt,
                    message: false
                });
                if (!auditRun) continue;
                for (const step of (Array.isArray(steps) ? steps.slice(0, 100) : [])) {
                    await this.event('legacy_stage', step.activity || step.phase || '历史阶段', {
                        runId: auditRun.id, phase: step.phase, data: step.details
                    });
                }
                await this.event('legacy_notice', '历史数据，逐文件明细不完整', { runId: auditRun.id, level: 'warn' });
                imported++;
            }

            const taskRows = await this._dataSource().query(`SELECT id, resourceName, accountId, status, lastError, lastCheckTime, updatedAt
                FROM task WHERE lastCheckTime IS NOT NULL ORDER BY updatedAt DESC LIMIT ?`, [limit]);
            for (const task of taskRows) {
                const legacyKey = `task:last:${task.id}`;
                if (await this._repo('AuditRun').findOneBy({ legacyKey })) continue;
                await this.startRun({
                    correlationId: `legacy-task:${task.id}`,
                    module: 'task', trigger: 'legacy', subjectType: 'task', subjectId: task.id,
                    subjectName: task.resourceName, accountId: task.accountId,
                    status: normalizeStatus(task.status), summary: task.lastError || '历史任务最后执行状态',
                    metadata: { legacy: true, incomplete: true }, legacyKey,
                    startedAt: task.lastCheckTime || task.updatedAt,
                    finishedAt: task.updatedAt, message: false
                });
                imported++;
            }

            const releaseRows = await this._dataSource().query(`SELECT r.id, r.subscriptionId, r.title, r.status, r.lastError, r.createdAt, r.updatedAt,
                    s.accountId, s.autoSeriesIntentId
                FROM pt_release r LEFT JOIN pt_subscription s ON s.id = r.subscriptionId
                ORDER BY r.id DESC LIMIT ?`, [limit]);
            for (const release of releaseRows) {
                const legacyKey = `pt_release:${release.id}`;
                if (await this._repo('AuditRun').findOneBy({ legacyKey })) continue;
                await this.startRun({
                    correlationId: release.autoSeriesIntentId ? `intent:${release.autoSeriesIntentId}` : `pt:${release.subscriptionId}`,
                    module: 'pt', trigger: 'legacy', subjectType: 'pt_release', subjectId: release.id,
                    subjectName: release.title, accountId: release.accountId,
                    status: normalizeStatus(release.status), summary: release.lastError || '历史 PT Release 摘要',
                    metadata: { legacy: true, incomplete: true, subscriptionId: release.subscriptionId }, legacyKey,
                    startedAt: release.createdAt, finishedAt: release.updatedAt, message: false
                });
                imported++;
            }
            return imported;
        }, 0);
    }
}

const auditService = new AuditService();

module.exports = {
    AuditService,
    auditService,
    auditStorage,
    AUDIT_ACTIONS,
    sanitizeAuditText,
    sanitizeAuditValue,
    safeJson,
    parseJson,
    moduleForWorkflow
};
