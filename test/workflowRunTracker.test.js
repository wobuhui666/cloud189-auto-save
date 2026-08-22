const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkflowRunTracker } = require('../src/services/workflowRunTracker');

function createRepository() {
    const saved = [];
    return {
        saved,
        create(value) {
            return { ...value };
        },
        async save(value) {
            saved.push(JSON.parse(JSON.stringify(value)));
            return value;
        }
    };
}

test('WorkflowRun 记录任务执行阶段并保持进度单调', async () => {
    const repository = createRepository();
    const tracker = new WorkflowRunTracker(repository);
    const run = await tracker.startTaskRun({
        id: 12,
        accountId: 3,
        resourceName: '测试剧',
        shareFolderName: '第一季'
    }, { trigger: 'manual' });

    await tracker.update(run, 'inspect_share', '正在读取分享目录');
    await tracker.update(run, 'transfer', '正在转存新增文件', { fileCount: 2 });
    await tracker.finish(run, 'completed');

    assert.equal(run.type, 'task_execution');
    assert.equal(run.status, 'completed');
    assert.equal(run.source, 'manual');
    assert.equal(run.context.taskId, 12);
    assert.equal(run.context.taskName, '测试剧/第一季');
    assert.equal(run.context.progress, 100);
    assert.deepEqual(run.steps.map(step => step.phase), [
        'start',
        'inspect_share',
        'transfer',
        'complete'
    ]);
});

test('WorkflowRun 失败时保存精简错误和终态', async () => {
    const repository = createRepository();
    const tracker = new WorkflowRunTracker(repository);
    const run = await tracker.startTaskRun({ id: 1, accountId: 1, resourceName: '失败任务' });

    await tracker.finish(run, 'failed', { error: '分享链接已取消' });

    assert.equal(run.status, 'failed');
    assert.equal(run.context.phase, 'failed');
    assert.equal(run.context.error, '分享链接已取消');
    assert.ok(run.context.finishedAt);
});

test('WorkflowRun 审计信息脱敏链接、API Key 和敏感字段', async () => {
    const repository = createRepository();
    const tracker = new WorkflowRunTracker(repository);
    const run = await tracker.startTaskRun({ id: 2, accountId: 1, resourceName: '安全测试' });

    await tracker.finish(run, 'failed', {
        error: '请求 https://cloud.189.cn/t/SecretCode 失败，apiKey=sk-abcdefghijk12345',
        shareLink: 'https://cloud.189.cn/t/SecretCode'
    });

    const serialized = JSON.stringify(run);
    assert.equal(serialized.includes('SecretCode'), false);
    assert.equal(serialized.includes('sk-abcdefghijk12345'), false);
    assert.match(serialized, /REDACTED/);
});
