const test = require('node:test');
const assert = require('node:assert/strict');
const { nextBeijingDailyRun, SYSTEM_BACKOFF_MS, RATE_LIMIT_BACKOFF_MS, AutoSeriesIntentService } = require('../src/services/autoSeriesIntent');

test('no_coverage下一次巡检固定为北京时间03:15', () => {
    const next = nextBeijingDailyRun(new Date('2026-08-02T00:00:00.000Z'));
    assert.equal(next.toISOString(), '2026-08-02T19:15:00.000Z');
});

test('系统故障退避为5分钟、15分钟、60分钟、24小时', () => {
    assert.deepEqual(SYSTEM_BACKOFF_MS, [300000, 900000, 3600000, 86400000]);
});

test('AI 限流退避最多为60分钟', () => {
    assert.deepEqual(RATE_LIMIT_BACKOFF_MS, [300000, 900000, 1800000, 3600000]);
});

test('Intent 创建保存请求来源快照，并使用 OpenAI 全局默认协议', async () => {
    const ConfigService = require('../src/services/ConfigService');
    const saved = [];
    const intentRepo = {
        create: value => ({ ...value }),
        save: async value => { saved.push(value); return value; }
    };
    const workflowRunRepo = { create: value => ({ ...value }), save: async value => value };
    const autoSeriesService = {
        _resolveTmdb: async () => null,
        _pickTmdbBrief: value => value,
        _normalizeMode: value => value,
        getSettings: () => ({
            accountId: '', targetFolderId: '', targetFolder: '', mode: 'lazy',
            agentEnabled: false, toolCallMode: ConfigService.getConfigValue('openai.toolCallMode', 'auto'), allowHdhivePoints: false,
            hdhiveMaxPoints: 10, keepCasAfterRestore: false, mediaPreference: {}
        }),
        getSourcePreferences: () => [{ source: 'cloudsaver', enabled: true }, { source: 'pt', enabled: true }]
    };
    const service = new AutoSeriesIntentService({ intentRepo, workflowRunRepo, autoSeriesService });
    const original = ConfigService.getConfigValue('openai.toolCallMode');
    ConfigService._config.openai.toolCallMode = 'json';
    try {
        await service.create({ title: '目标剧', accountId: 1, targetFolderId: '2', targetFolder: '目录', sources: ['pt'] });
        const intent = saved[0];
        assert.equal(intent.toolCallMode, 'json');
        assert.deepEqual(JSON.parse(intent.sourcePreferencesJson), [{ source: 'cloudsaver', enabled: false }, { source: 'pt', enabled: true }]);
    } finally {
        ConfigService._config.openai.toolCallMode = original || 'auto';
    }
});

test('执行前补齐历史 Intent 缺失的 TMDB 锚点且保留用户模板', async () => {
    const saved = [];
    const resolved = {
        id: 223564,
        title: '超超超超超喜欢你的100个女朋友',
        type: 'tv',
        totalEpisodes: 32,
        seasons: [{ season_number: 1, episode_count: 32 }]
    };
    const service = new AutoSeriesIntentService({
        intentRepo: { save: async intent => { saved.push(intent); return intent; } },
        autoSeriesService: {
            _resolveTmdb: async (title) => {
                assert.equal(title, '超超超超超喜欢你的100个女朋友 第三季');
                return resolved;
            },
            _pickTmdbBrief: value => ({ ...value, seasons: [{ seasonNumber: 1, episodeCount: 32 }] })
        }
    });
    const intent = {
        title: '超超超超超喜欢你的100个女朋友 第三季',
        year: '',
        tmdbJson: 'null',
        coverageJson: '{}',
        metadataTemplateJson: JSON.stringify({ source: 'user', work: { title: '用户锁定标题', tmdbId: '' } })
    };

    const brief = await service._hydrateTmdbIfMissing(intent);
    assert.equal(brief.type, 'tv');
    assert.equal(JSON.parse(intent.tmdbJson).id, 223564);
    assert.equal(JSON.parse(intent.coverageJson).expectedEpisodes, 32);
    assert.equal(JSON.parse(intent.metadataTemplateJson).work.title, '用户锁定标题');
    assert.equal(saved.length, 1);
});

test('补齐 TMDB 时会纠正旧的 Agent 自动模板', async () => {
    const resolved = {
        id: 223564,
        title: '超超超超超喜欢你的100个女朋友',
        type: 'tv',
        totalEpisodes: 32,
        seasons: [{ season_number: 1, episode_count: 32 }]
    };
    const service = new AutoSeriesIntentService({
        intentRepo: { save: async intent => intent },
        autoSeriesService: {
            _resolveTmdb: async () => resolved,
            _pickTmdbBrief: value => ({ ...value, seasons: [{ seasonNumber: 1, episodeCount: 32 }] })
        }
    });
    const intent = {
        title: '超超超超超喜欢你的100个女朋友 第三季',
        year: '2026',
        tmdbJson: 'null',
        coverageJson: '{}',
        metadataTemplateJson: JSON.stringify({ source: 'agent', work: { title: '错误重复条目', tmdbId: '328583' } })
    };

    await service._hydrateTmdbIfMissing(intent);

    const template = JSON.parse(intent.metadataTemplateJson);
    assert.equal(template.work.tmdbId, '223564');
    assert.equal(template.work.title, resolved.title);
});

test('Intent 巡检只把 nextRunAt 为空的任务当作未计划任务', async () => {
    const queries = [];
    const service = new AutoSeriesIntentService({
        intentRepo: {
            find: async options => {
                queries.push(options.where);
                return [];
            }
        },
        autoSeriesService: {}
    });

    assert.deepEqual(await service.runDue(), { scheduled: 0 });
    assert.equal(queries.length, 2);
    assert.equal(queries[1].nextRunAt.type, 'isNull');
});

test('CloudSaver 手动候选仅保存合法天翼分享链接并可恢复执行上下文', async () => {
    const service = new AutoSeriesIntentService({ autoSeriesService: {} });
    const selected = await service._resolveSelectedResource({
        source: 'cloudsaver',
        shareLink: 'https://cloud.189.cn/t/AbCdEf12',
        resourceTitle: '目标剧'
    });
    assert.equal(selected.source, 'cloudsaver');
    assert.equal(selected.shareLink, 'https://cloud.189.cn/t/AbCdEf12');
    assert.rejects(
        service._resolveSelectedResource({ source: 'cloudsaver', shareLink: 'https://example.com/file' }),
        /不是有效天翼分享链接/
    );
});

test('Intent 对外视图不返回持久化分享链接', async () => {
    const intentRepo = {
        find: async () => [{ id: 'intent-1', title: '目标剧', selectedShareLink: 'https://cloud.189.cn/t/AbCdEf12' }]
    };
    const service = new AutoSeriesIntentService({ intentRepo, autoSeriesService: {} });
    const [intent] = await service.list();
    assert.equal(intent.id, 'intent-1');
    assert.equal(Object.hasOwn(intent, 'selectedShareLink'), false);
});

test('删除 Intent 默认仅解除关联资源并清理编排记录', async () => {
    const intent = {
        id: 'intent-delete', title: '目标剧', taskId: 7, ptSubscriptionId: 11,
        taskIdsJson: '[8]', ptSubscriptionIdsJson: '[12]'
    };
    const deletedIntents = [];
    const workflowDeletes = [];
    const taskUpdates = [];
    const ptUpdates = [];
    const service = new AutoSeriesIntentService({
        intentRepo: {
            findOneBy: async () => intent,
            delete: async where => { deletedIntents.push(where); return { affected: 1 }; }
        },
        workflowRunRepo: {
            delete: async where => { workflowDeletes.push(where); return { affected: 2 }; }
        },
        taskRepo: {
            find: async () => [{ id: 9 }],
            update: async (where, patch) => { taskUpdates.push({ where, patch }); return { affected: 3 }; }
        },
        ptSubscriptionRepo: {
            find: async () => [{ id: 13 }],
            update: async (where, patch) => { ptUpdates.push({ where, patch }); return { affected: 3 }; }
        }
    });

    const result = await service.delete(intent.id);
    assert.equal(result.deletedIntent, true);
    assert.deepEqual(result.taskIds, [7, 8, 9]);
    assert.deepEqual(result.ptSubscriptionIds, [11, 12, 13]);
    assert.deepEqual(result.detachedTaskIds, [7, 8, 9]);
    assert.deepEqual(result.detachedPtSubscriptionIds, [11, 12, 13]);
    assert.deepEqual(result.deletedTaskIds, []);
    assert.deepEqual(result.deletedPtSubscriptionIds, []);
    assert.equal(result.deletedWorkflowRuns, 2);
    assert.deepEqual(deletedIntents, [{ id: intent.id }]);
    assert.deepEqual(workflowDeletes, [{ subjectType: 'auto_series_intent', subjectId: intent.id }]);
    assert.equal(taskUpdates.length, 1);
    assert.deepEqual(taskUpdates[0].patch, { autoSeriesIntentId: '' });
    assert.equal(ptUpdates.length, 1);
    assert.deepEqual(ptUpdates[0].patch, { autoSeriesIntentId: '' });
});

test('删除 Intent 可连带删除关联任务和 PT 订阅', async () => {
    const intent = {
        id: 'intent-delete-cascade', title: '目标剧', taskId: 7, ptSubscriptionId: 11,
        taskIdsJson: '[8]', ptSubscriptionIdsJson: '[12]'
    };
    const deletedTasks = [];
    const ptReleaseDeletes = [];
    const ptSubscriptionDeletes = [];
    const service = new AutoSeriesIntentService({
        intentRepo: {
            findOneBy: async () => intent,
            delete: async () => ({ affected: 1 })
        },
        workflowRunRepo: {
            delete: async () => ({ affected: 0 })
        },
        taskService: {
            deleteTask: async (taskId, deleteCloud) => { deletedTasks.push({ taskId, deleteCloud }); }
        },
        taskRepo: {
            find: async () => []
        },
        ptSubscriptionRepo: {
            find: async () => [],
            delete: async where => { ptSubscriptionDeletes.push(where); return { affected: 2 }; }
        },
        ptReleaseRepo: {
            delete: async where => { ptReleaseDeletes.push(where); return { affected: 4 }; }
        }
    });

    const result = await service.delete(intent.id, { deleteTasks: true, deleteCloud: true, deletePtSubscriptions: true });
    assert.deepEqual(deletedTasks, [{ taskId: 7, deleteCloud: true }, { taskId: 8, deleteCloud: true }]);
    assert.deepEqual(result.deletedTaskIds, [7, 8]);
    assert.deepEqual(result.deletedPtSubscriptionIds, [11, 12]);
    assert.equal(ptReleaseDeletes.length, 1);
    assert.equal(ptSubscriptionDeletes.length, 1);
});

test('Agent 元数据工具失败时不降级绕过并进入退避重试', async () => {
    const intent = {
        id: 'intent-1', title: '目标剧', year: '', mode: 'lazy', accountId: 1,
        targetFolderId: '2', targetFolder: '目录', sourcePreferencesJson: '[]',
        mediaPreferenceJson: '{}', agentBudgetJson: '{}', agentEnabled: true,
        toolCallMode: 'auto', status: 'pending', lastWorkflowRunId: 'run-1',
        failureCount: 0, selectedSource: '', selectedShareLink: '', selectedResourceId: ''
    };
    const run = { id: 'run-1', status: 'pending', context: { title: '目标剧', degraded: false }, steps: [] };
    const intentRepo = {
        findOneBy: async () => intent,
        save: async value => value
    };
    const workflowRunRepo = {
        findOneBy: async () => run,
        create: value => ({ ...value }),
        save: async value => value
    };
    let fallbackCalls = 0;
    const service = new AutoSeriesIntentService({
        intentRepo,
        workflowRunRepo,
        agentExecutor: { run: async () => { throw new Error('AI https://example.com failed apiKey=sk-secret123456'); } },
        autoSeriesService: {
            createByTitle: async context => {
                fallbackCalls++;
                assert.equal(context.agentEnabled, false);
                return { taskIds: [7] };
            }
        }
    });

    await assert.rejects(service.runNow(intent.id), /AI/);
    assert.equal(fallbackCalls, 0);
    assert.equal(intent.status, 'retry_wait');
    assert.equal(intent.failureCount, 1);
    assert.equal(intent.lastError.includes('example.com'), false);
    assert.equal(intent.lastError.includes('sk-secret123456'), false);
    assert.ok(intent.nextRunAt instanceof Date);
});

test('确定性执行上下文携带 Intent ID 供任务反向关联', async () => {
    const intent = {
        id: 'intent-deterministic', title: '目标剧', year: '', mode: 'lazy', accountId: 1,
        targetFolderId: '2', targetFolder: '目录', sourcePreferencesJson: '[]',
        mediaPreferenceJson: '{}', agentBudgetJson: '{}', agentEnabled: false,
        toolCallMode: 'auto', status: 'pending', lastWorkflowRunId: 'run-deterministic',
        failureCount: 0, selectedSource: '', selectedShareLink: '', selectedResourceId: '',
        taskIdsJson: '[]', ptSubscriptionIdsJson: '[]', coverageJson: '{}'
    };
    const run = { id: 'run-deterministic', status: 'pending', context: { title: '目标剧', degraded: false }, steps: [] };
    const intentRepo = {
        findOneBy: async () => intent,
        save: async value => value
    };
    const workflowRunRepo = {
        findOneBy: async () => run,
        create: value => ({ ...value }),
        save: async value => value
    };
    let receivedContext = null;
    const service = new AutoSeriesIntentService({
        intentRepo,
        workflowRunRepo,
        autoSeriesService: {
            createByTitle: async context => {
                receivedContext = context;
                return { taskIds: [7], subscriptionIds: [] };
            }
        }
    });

    await service.runNow(intent.id);
    assert.equal(receivedContext.intentId, intent.id);
    assert.equal(receivedContext.autoSeriesIntentId, intent.id);
    assert.deepEqual(JSON.parse(intent.taskIdsJson), [7]);
});

test('Agent 遇到 AI 429 时使用限流退避而不是系统24小时退避', async () => {
    const intent = {
        id: 'intent-rate-limit', title: '目标剧', year: '', mode: 'lazy', accountId: 1,
        targetFolderId: '2', targetFolder: '目录', sourcePreferencesJson: '[]',
        mediaPreferenceJson: '{}', agentBudgetJson: '{}', agentEnabled: true,
        toolCallMode: 'auto', status: 'pending', lastWorkflowRunId: 'run-rate-limit',
        failureCount: 3, selectedSource: '', selectedShareLink: '', selectedResourceId: ''
    };
    const run = { id: 'run-rate-limit', status: 'pending', context: { title: '目标剧', degraded: false }, steps: [] };
    const intentRepo = {
        findOneBy: async () => intent,
        save: async value => value
    };
    const workflowRunRepo = {
        findOneBy: async () => run,
        create: value => ({ ...value }),
        save: async value => value
    };
    const service = new AutoSeriesIntentService({
        intentRepo,
        workflowRunRepo,
        agentExecutor: { run: async () => { throw new Error('Response code 429 (Too Many Requests)'); } },
        autoSeriesService: { createByTitle: async () => { throw new Error('不应降级执行'); } }
    });

    const before = Date.now();
    await assert.rejects(service.runNow(intent.id), /429/);
    const delayMs = intent.nextRunAt.getTime() - before;
    assert.equal(intent.failureCount, 4);
    assert.equal(intent.status, 'retry_wait');
    assert.ok(delayMs >= 60 * 60 * 1000);
    assert.ok(delayMs < 61 * 60 * 1000);
});

test('Agent 正常报告无覆盖时清理历史失败状态', async () => {
    const intent = {
        id: 'intent-no-coverage', title: '目标剧', year: '', mode: 'lazy', accountId: 1,
        targetFolderId: '2', targetFolder: '目录', sourcePreferencesJson: '[]',
        mediaPreferenceJson: '{}', agentBudgetJson: '{}', agentEnabled: true,
        toolCallMode: 'auto', status: 'retry_wait', lastWorkflowRunId: 'run-no-coverage',
        failureCount: 9, lastError: '旧错误', selectedSource: '', selectedShareLink: '', selectedResourceId: '',
        coverageJson: '{}'
    };
    const run = { id: 'run-no-coverage', status: 'pending', context: { title: '目标剧', degraded: false }, steps: [] };
    const service = new AutoSeriesIntentService({
        intentRepo: { findOneBy: async () => intent, save: async value => value },
        workflowRunRepo: { findOneBy: async () => run, create: value => ({ ...value }), save: async value => value },
        agentExecutor: { run: async () => ({ status: 'no_coverage', reason: '搜索后无资源' }) },
        autoSeriesService: {}
    });

    await service.runNow(intent.id);

    assert.equal(intent.status, 'no_coverage');
    assert.equal(intent.failureCount, 0);
    assert.equal(intent.lastError, '');
});
