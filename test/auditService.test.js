const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AuditService,
    sanitizeAuditValue
} = require('../src/services/auditService');

function createMemoryDataSource() {
    const runs = [];
    const events = [];
    const operations = [];
    let eventId = 0;
    let operationId = 0;

    const matches = (value, where = {}) => Object.entries(where).every(([key, expected]) => value[key] === expected);
    const repository = (kind, rows) => ({
        create(value) {
            return { ...value };
        },
        async save(value) {
            if (kind === 'event' && !value.id) value.id = ++eventId;
            if (kind === 'operation' && !value.id) value.id = ++operationId;
            if (!value.createdAt) value.createdAt = new Date();
            const index = rows.findIndex(item => item.id === value.id);
            if (index >= 0) rows[index] = value;
            else rows.push(value);
            return value;
        },
        async findOneBy(where) {
            return rows.find(item => matches(item, where)) || null;
        },
        async findBy(where) {
            return rows.filter(item => matches(item, where));
        },
        async find(options = {}) {
            let result = rows.filter(item => matches(item, options.where || {}));
            const order = options.order || {};
            for (const [key, direction] of Object.entries(order).reverse()) {
                result = result.slice().sort((left, right) => {
                    const a = left[key] instanceof Date ? left[key].getTime() : left[key];
                    const b = right[key] instanceof Date ? right[key].getTime() : right[key];
                    return (a < b ? -1 : a > b ? 1 : 0) * (String(direction).toUpperCase() === 'DESC' ? -1 : 1);
                });
            }
            return result;
        },
        createQueryBuilder() {
            if (kind !== 'run') return null;
            return createRunQueryBuilder(runs, operations);
        }
    });

    const dataSource = {
        isInitialized: true,
        getRepository(target) {
            const name = typeof target === 'string' ? target : target?.name;
            if (name === 'AuditRun') return repository('run', runs);
            if (name === 'AuditEvent') return repository('event', events);
            if (name === 'AuditOperation') return repository('operation', operations);
            throw new Error(`未知仓库: ${name}`);
        },
        async query(sql) {
            if (sql.includes('FROM workflow_run')) {
                return [{
                    id: 101,
                    type: 'task_execution',
                    source: 'legacy',
                    status: 'completed',
                    subjectType: 'task',
                    subjectId: '8',
                    protocol: 'legacy',
                    summary: '旧任务',
                    context: JSON.stringify({ taskName: '旧任务', accountId: 2 }),
                    steps: JSON.stringify([{ phase: 'transfer', activity: '已转存', details: { count: 1 } }]),
                    createdAt: new Date('2026-08-01T00:00:00Z'),
                    updatedAt: new Date('2026-08-01T00:01:00Z')
                }];
            }
            return [];
        },
        _rows: { runs, events, operations }
    };

    return dataSource;
}

function createRunQueryBuilder(runs, operations, state = {}) {
    const query = {
        filters: [...(state.filters || [])],
        aggregate: Boolean(state.aggregate),
        offset: state.offset || 0,
        limit: state.limit,
        order: state.order,
        clone() {
            return createRunQueryBuilder(runs, operations, this);
        },
        andWhere(expression, params = {}) {
            this.filters.push({ expression, params });
            return this;
        },
        select() {
            this.aggregate = true;
            return this;
        },
        addSelect() {
            return this;
        },
        orderBy(key, direction) {
            this.order = { key: key.split('.').pop(), direction };
            return this;
        },
        addOrderBy() {
            return this;
        },
        skip(value) {
            this.offset = value;
            return this;
        },
        take(value) {
            this.limit = value;
            return this;
        },
        update() {
            this.updateMode = true;
            return this;
        },
        set(value) {
            this.updateValues = value;
            return this;
        },
        where(_expression, params = {}) {
            this.updateId = params.id;
            return this;
        },
        async execute() {
            if (!this.updateMode) return { affected: 0 };
            const run = runs.find(item => item.id === this.updateId);
            if (run) {
                for (const [key, value] of Object.entries(this.updateValues || {})) {
                    run[key] = typeof value === 'function'
                        ? Number(run[key] || 0) + 1
                        : value;
                }
            }
            return { affected: run ? 1 : 0 };
        },
        _filtered() {
            return runs.filter(run => this.filters.every(({ expression, params }) => {
                if (expression.includes('subjectName LIKE')) {
                    const keyword = String(params.keyword || '').replace(/^%|%$/g, '');
                    return [run.subjectName, run.summary, run.subjectId, run.correlationId].some(value => String(value || '').includes(keyword));
                }
                if (expression.includes('run.module =')) return run.module === params.module;
                if (expression.includes('run.status =')) return run.status === params.status;
                if (expression.includes('run.accountId =')) return run.accountId === params.accountId;
                if (expression.includes('run.subjectType =')) return run.subjectType === params.subjectType;
                if (expression.includes('run.subjectId =')) return run.subjectId === params.subjectId;
                if (expression.includes('run.correlationId =')) return run.correlationId === params.correlationId;
                if (expression.includes('run.startedAt >=')) return new Date(run.startedAt) >= new Date(params.startAt);
                if (expression.includes('run.startedAt <=')) return new Date(run.startedAt) <= new Date(params.endAt);
                if (expression.includes('EXISTS')) return operations.some(operation => operation.runId === run.id && operation.action === params.action);
                return true;
            }));
        },
        async getCount() {
            return this._filtered().length;
        },
        async getRawOne() {
            const filtered = this._filtered();
            return {
                changes: filtered.reduce((sum, run) => sum + Number(run.changeCount || 0), 0),
                failures: filtered.reduce((sum, run) => sum + Number(run.failureCount || 0), 0),
                running: filtered.filter(run => run.status === 'running').length
            };
        },
        async getMany() {
            let result = this._filtered().slice();
            if (this.order) {
                const { key, direction } = this.order;
                result.sort((left, right) => {
                    const a = left[key] instanceof Date ? left[key].getTime() : left[key];
                    const b = right[key] instanceof Date ? right[key].getTime() : right[key];
                    return (a < b ? -1 : a > b ? 1 : 0) * (String(direction).toUpperCase() === 'DESC' ? -1 : 1);
                });
            }
            return this.limit == null ? result.slice(this.offset) : result.slice(this.offset, this.offset + this.limit);
        }
    };
    return query;
}

test('审计值脱敏 URL、磁力链接和敏感字段', () => {
    const value = sanitizeAuditValue({
        message: '请求 https://cloud.189.cn/t/private 与 magnet:?xt=urn:btih:secret',
        token: 'plain-token',
        nested: { password: 'plain-password' }
    });
    assert.equal(value.message.includes('cloud.189.cn'), false);
    assert.equal(value.message.includes('magnet:?'), false);
    assert.equal(value.token, '[REDACTED]');
    assert.equal(value.nested.password, '[REDACTED]');
});

test('审计运行拒绝旧数据中的未来时间', async () => {
    const dataSource = createMemoryDataSource();
    const service = new AuditService({ dataSource });
    const before = Date.now();
    const run = await service.startRun({
        id: 'future-run',
        module: 'pt',
        startedAt: '2033-11-21 18:58:24.000',
        finishedAt: '2033-11-21 18:59:03.000',
        message: false
    });

    assert.ok(run.startedAt.getTime() >= before);
    assert.ok(run.startedAt.getTime() <= Date.now());
    assert.equal(run.finishedAt.getTime(), run.startedAt.getTime());
});

test('审计运行串联上下文、操作计数、分页筛选和详情', async () => {
    const dataSource = createMemoryDataSource();
    const service = new AuditService({ dataSource });
    const run = await service.startRun({
        id: 'run-1',
        correlationId: 'chain-1',
        module: 'organizer',
        trigger: 'manual',
        subjectType: 'task',
        subjectId: '8',
        subjectName: '测试任务',
        accountId: 7,
        metadata: { shareUrl: 'https://cloud.189.cn/t/private' }
    });

    await service.runInContext(run, async () => {
        assert.equal(service.current().runId, 'run-1');
        await service.event('identify', '识别完成', { phase: 'identify', data: { tmdbId: 123 } });
        const move = await service.planOperation('move', {
            sourcePath: '/源/文件.mkv',
            targetPath: '/目标/文件.mkv',
            before: { token: 'hidden' },
            decisionSource: 'rule'
        });
        await service.completeOperation(move, 'completed', {
            after: { path: '/目标/文件.mkv' },
            verification: { verified: true }
        });
        await service.recordOperation('rename', 'failed', {
            sourcePath: '/源/旧名.mkv',
            targetPath: '/目标/新名.mkv',
            error: '写后验证失败'
        });
    });
    await service.finishRun(run, 'completed', { summary: '整理完成' });

    const result = await service.listRuns({ page: 1, pageSize: 1, action: 'move', keyword: '测试任务' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].id, 'run-1');
    assert.equal(result.stats.changes, 1);
    assert.equal(result.stats.failures, 1);

    const detail = await service.getRunDetail('run-1');
    assert.equal(detail.events.some(event => event.type === 'run_started'), true);
    assert.equal(detail.events.some(event => event.type === 'run_finished'), true);
    assert.equal(detail.operations.length, 2);
    assert.equal(detail.operations[0].verification.verified, true);
    assert.equal(detail.operations[0].before.token, '[REDACTED]');
    assert.equal(detail.relatedRuns.length, 1);
});

test('审计可标记遗留运行中记录为中断，旧数据回填具备幂等性', async () => {
    const dataSource = createMemoryDataSource();
    const service = new AuditService({ dataSource });
    const running = await service.startRun({ id: 'running-1', module: 'task', subjectName: '中断任务' });
    assert.equal(running.status, 'running');
    assert.equal(await service.markInterruptedRuns(), 1);
    assert.equal(dataSource._rows.runs.find(item => item.id === 'running-1').status, 'interrupted');

    assert.equal(await service.backfillLegacy({ limit: 10 }), 1);
    assert.equal(await service.backfillLegacy({ limit: 10 }), 0);
    assert.equal(dataSource._rows.runs.filter(item => item.legacyKey === 'workflow:101').length, 1);
    assert.equal(dataSource._rows.events.some(event => event.type === 'legacy_notice'), true);
});
