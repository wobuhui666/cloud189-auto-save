const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MetadataPlanStore,
    normalizeMetadataOverride,
    mergeMetadataOverrides,
    inspectFiles,
    buildMetadataPlan,
    overridesEqual
} = require('../src/services/metadataOverride');

test('版本化元数据支持整数、半集和 Season 00 特别篇', () => {
    const value = normalizeMetadataOverride({
        source: 'user',
        work: { tmdbId: '100', title: '目标剧', mediaType: 'tv', seasonNumber: 1 },
        files: [
            { relativePath: 'Season 01/a.mkv', seasonNumber: 1, episodeNumber: 1.5 },
            { relativePath: 'extras/OVA.mkv', special: true, episodeNumber: 1 }
        ]
    });
    assert.equal(value.version, 1);
    assert.equal(value.files[0].episodeNumber, 1.5);
    assert.equal(value.files[1].seasonNumber, 0);
    assert.equal(value.files[1].special, true);
    assert.equal(value.work.locks['*'], true);
});

test('用户锁定字段优先于 Agent，Agent 可补齐未锁定字段', () => {
    const user = normalizeMetadataOverride({
        source: 'user',
        work: { title: '人工标题', locks: { title: true } },
        files: [{ relativePath: 'a.mkv', episodeNumber: 8, locks: { episodeNumber: true } }]
    });
    const agent = normalizeMetadataOverride({
        source: 'agent',
        work: { title: 'Agent 标题', tmdbId: '9' },
        files: [{ relativePath: 'a.mkv', seasonNumber: 2, episodeNumber: 3 }]
    });
    const merged = mergeMetadataOverrides({ agent, user });
    assert.equal(merged.work.title, '人工标题');
    assert.equal(merged.work.tmdbId, '9');
    assert.equal(merged.files[0].seasonNumber, 2);
    assert.equal(merged.files[0].episodeNumber, 8);
});

test('规划校验文件指纹作用域且无差异返回 noop', () => {
    const inspection = inspectFiles([{ relativePath: 'Season 01/E01.mkv', size: 10, id: 'f1' }]);
    const override = normalizeMetadataOverride({
        source: 'agent', fingerprint: inspection.fingerprint,
        work: { title: '目标剧', mediaType: 'tv' },
        files: [{ relativePath: 'Season 01/E01.mkv', seasonNumber: 1, episodeNumber: 1 }]
    }, { source: 'agent', fingerprint: inspection.fingerprint });
    const first = buildMetadataPlan({ targetType: 'task', targetId: 1, proposed: override, fingerprint: inspection.fingerprint, inspectedFiles: inspection.files });
    assert.equal(first.noop, false);
    const second = buildMetadataPlan({ targetType: 'task', targetId: 1, current: first.override, proposed: override, fingerprint: inspection.fingerprint, inspectedFiles: inspection.files });
    assert.equal(second.noop, true);
    assert.equal(overridesEqual(first.override, override), true);
    assert.throws(() => buildMetadataPlan({ targetType: 'task', targetId: 1, proposed: { ...override, files: [{ relativePath: '../escape.mkv', episodeNumber: 1 }] }, inspectedFiles: inspection.files }), /路径/);
});

test('计划令牌只能消费一次且严格绑定 Intent 与目标引用', () => {
    const store = new MetadataPlanStore({ ttlMs: 1000 });
    const token = store.issue({ targetType: 'task', targetId: 1 }, { intentId: 'i1', targetRef: 'r1' });
    assert.throws(() => store.consume(token, { intentId: 'i2', targetRef: 'r1' }), /不属于当前作用域/);
    const valid = store.issue({ targetType: 'task', targetId: 1 }, { intentId: 'i1', targetRef: 'r1' });
    assert.equal(store.consume(valid, { intentId: 'i1', targetRef: 'r1' }).targetId, 1);
    assert.throws(() => store.consume(valid, { intentId: 'i1', targetRef: 'r1' }), /失效/);
});

test('不同候选基于各自真实文件树生成独立指纹和文件路径', () => {
    const left = inspectFiles([{ relativePath: 'A/S01E01.mkv', size: 1 }]);
    const right = inspectFiles([{ relativePath: 'B/S02E01.mkv', size: 1 }]);
    assert.notEqual(left.fingerprint, right.fingerprint);
    assert.equal(left.files[0].relativePath, 'A/S01E01.mkv');
    assert.equal(right.files[0].relativePath, 'B/S02E01.mkv');
});
