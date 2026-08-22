const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    DEFAULT_MIN_INTERVAL_MS,
    HdhiveFlowController,
    normalizeHdhiveFlowControl
} = require('../src/services/hdhiveFlowControl');

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test('影巢流控关闭时允许请求并发执行', async () => {
    const controller = new HdhiveFlowController();
    const firstGate = deferred();
    const starts = [];

    const first = controller.run(async () => {
        starts.push('first');
        await firstGate.promise;
    }, { enabled: false });
    const second = controller.run(async () => {
        starts.push('second');
    }, { enabled: false });

    await nextTurn();
    assert.deepEqual(starts, ['first', 'second']);
    firstGate.resolve();
    await Promise.all([first, second]);
});

test('影巢流控开启时将请求严格串行', async () => {
    const controller = new HdhiveFlowController();
    const firstGate = deferred();
    const starts = [];

    const first = controller.run(async () => {
        starts.push('first');
        await firstGate.promise;
    }, { enabled: true, minIntervalMs: 0 });
    const second = controller.run(async () => {
        starts.push('second');
    }, { enabled: true, minIntervalMs: 0 });

    await nextTurn();
    assert.deepEqual(starts, ['first']);
    firstGate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(starts, ['first', 'second']);
});

test('影巢请求失败后仍会释放队列', async () => {
    const controller = new HdhiveFlowController();
    const starts = [];

    const first = controller.run(async () => {
        starts.push('first');
        throw new Error('request failed');
    }, { enabled: true, minIntervalMs: 0 });
    const second = controller.run(async () => {
        starts.push('second');
        return 'ok';
    }, { enabled: true, minIntervalMs: 0 });

    await assert.rejects(first, /request failed/);
    assert.equal(await second, 'ok');
    assert.deepEqual(starts, ['first', 'second']);
});

test('影巢流控保证相邻请求的最小启动间隔', async () => {
    const controller = new HdhiveFlowController();
    const starts = [];

    await Promise.all([
        controller.run(async () => starts.push(Date.now()), { enabled: true, minIntervalMs: 30 }),
        controller.run(async () => starts.push(Date.now()), { enabled: true, minIntervalMs: 30 })
    ]);

    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 25, `实际间隔 ${starts[1] - starts[0]}ms`);
});

test('影巢流控配置会归一化异常值', () => {
    assert.deepEqual(normalizeHdhiveFlowControl({ enabled: 'true', minIntervalMs: -2 }), {
        enabled: true,
        minIntervalMs: 0
    });
    assert.deepEqual(normalizeHdhiveFlowControl({ enabled: false, minIntervalMs: 'invalid' }), {
        enabled: false,
        minIntervalMs: DEFAULT_MIN_INTERVAL_MS
    });
    assert.deepEqual(normalizeHdhiveFlowControl({ enabled: true, minIntervalMs: 999999 }), {
        enabled: true,
        minIntervalMs: 60000
    });
});

test('影巢 SDK 的所有网络出口都经过统一流控', () => {
    const sdkPath = path.join(__dirname, '../src/sdk/hdhive/sdk.ts');
    const requestLines = fs.readFileSync(sdkPath, 'utf8')
        .split('\n')
        .filter((line) => /\bgot(?:\.(?:get|post))?\(/.test(line));

    assert.equal(requestLines.length, 12);
    for (const line of requestLines) {
        assert.match(line, /this\.runRequest\(/);
    }
});

test('影巢 Bridge 解锁登录失效时只在重登成功后重试', () => {
    const sdkPath = path.join(__dirname, '../src/sdk/hdhive/sdk.ts');
    const source = fs.readFileSync(sdkPath, 'utf8');

    assert.match(source, /if \(!result\.success && this\.isBridgeAuthError\(result\)\)/);
    assert.match(source, /const relogin = await this\.refreshBridgeLogin\(\);\s*\n\s*if \(relogin\.success\)/);
});
