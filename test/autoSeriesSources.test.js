const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeSourcePreferences,
    normalizeAutoSeriesSettings,
    normalizeHdhivePointPolicy,
    canUseHdhiveResource,
    validateHdhiveResourceBeforeUnlock,
    inferAutoSeriesMediaType,
    normalizeTmdbLookupTitle,
    withTimeout
} = require('../src/services/autoSeries');
const { PtService } = require('../src/services/ptService');

test('auto series source preferences preserve order, remove duplicates and fill missing sources', () => {
    assert.deepEqual(normalizeSourcePreferences([
        { source: 'pt', enabled: true },
        { source: 'cloudsaver', enabled: false },
        { source: 'pt', enabled: false },
        { source: 'invalid', enabled: true }
    ]), [
        { source: 'pt', enabled: true },
        { source: 'cloudsaver', enabled: false },
        { source: 'hdhive', enabled: true },
        { source: 'subscription', enabled: true }
    ]);
});

test('auto series settings normalize global creation defaults', () => {
    const settings = normalizeAutoSeriesSettings({
        accountId: 7,
        targetFolderId: '99',
        targetFolder: '/电视剧',
        mode: 'auto',
        sourcePreferences: [{ source: 'pt', enabled: true }],
        allowHdhivePoints: true,
        hdhiveMaxPoints: 8,
        agentEnabled: true,
        toolCallMode: 'json',
        mediaPreference: { preferredGroups: ['ANi'] }
    });

    assert.equal(settings.accountId, '7');
    assert.equal(settings.mode, 'normal');
    assert.equal(settings.hdhiveMaxPoints, 8);
    assert.equal(settings.agentEnabled, true);
    assert.equal(settings.toolCallMode, 'json');
    assert.deepEqual(settings.mediaPreference.preferredGroups, ['ANi']);
    assert.equal(settings.sourcePreferences[0].source, 'pt');
});

test('auto series settings reject invalid point limits', () => {
    assert.throws(
        () => normalizeAutoSeriesSettings({ allowHdhivePoints: true, hdhiveMaxPoints: -1 }),
        /积分上限/
    );
});

test('PT deterministic ranking prefers high quality episodic samples', () => {
    const service = new PtService();
    const highQuality = {
        items: [
            { title: '测试剧 S01E01 2160p HDR BluRay', episodeNumber: 1 },
            { title: '测试剧 S01E02 2160p HDR BluRay', episodeNumber: 2 }
        ]
    };
    const lowQuality = {
        items: [
            { title: '测试剧 预告 720p' },
            { title: '测试剧 sample 720p' }
        ]
    };

    assert.ok(
        service._scoreAutoSeriesCandidate(highQuality, '测试剧', null)
        > service._scoreAutoSeriesCandidate(lowQuality, '测试剧', null)
    );
});

test('HDHive point policy is disabled by default and validates its per-resource limit', () => {
    assert.deepEqual(normalizeHdhivePointPolicy(), { allowPoints: false, maxPoints: 0 });
    assert.deepEqual(normalizeHdhivePointPolicy({ allowHdhivePoints: 'true', hdhiveMaxPoints: '12' }), {
        allowPoints: true,
        maxPoints: 12
    });
    assert.throws(
        () => normalizeHdhivePointPolicy({ allowHdhivePoints: true, hdhiveMaxPoints: '-1' }),
        /积分上限/
    );
});

test('HDHive point policy always allows free or unlocked resources and caps paid resources', () => {
    const disabled = { allowPoints: false, maxPoints: 0 };
    const capped = { allowPoints: true, maxPoints: 10 };

    assert.equal(canUseHdhiveResource({ isFree: true }, disabled), true);
    assert.equal(canUseHdhiveResource({ isUnlocked: true, points: 99 }, disabled), true);
    assert.equal(canUseHdhiveResource({ points: 5 }, disabled), false);
    assert.equal(canUseHdhiveResource({ points: 10 }, capped), true);
    assert.equal(canUseHdhiveResource({ points: 11 }, capped), false);
    assert.equal(canUseHdhiveResource({ points: null }, capped), false);
    assert.equal(canUseHdhiveResource({ points: 1, expired: true }, capped), false);
});

test('HDHive unlock validation reports unknown and over-limit point costs', () => {
    const capped = { allowPoints: true, maxPoints: 10 };

    assert.equal(validateHdhiveResourceBeforeUnlock({ isFree: true }, capped), '');
    assert.match(validateHdhiveResourceBeforeUnlock({ points: null }, capped), /积分未知/);
    assert.match(validateHdhiveResourceBeforeUnlock({ points: 11 }, capped), /超过单个资源上限 10/);
    assert.match(validateHdhiveResourceBeforeUnlock({ points: 1 }, { allowPoints: false, maxPoints: 0 }), /未允许消耗积分/);
});

test('auto series source timeout rejects stalled source calls', async () => {
    await assert.rejects(
        withTimeout(new Promise(() => {}), 10, '来源超时'),
        /来源超时/
    );
    assert.equal(await withTimeout(Promise.resolve('ok'), 100, '不应超时'), 'ok');
});

test('auto series strips season and movie intent suffixes before TMDB lookup', async () => {
    assert.equal(inferAutoSeriesMediaType('我心里危险的东西 剧场版'), 'movie');
    assert.equal(inferAutoSeriesMediaType('电影少女'), 'tv');
    assert.equal(normalizeTmdbLookupTitle('我心里危险的东西 剧场版', 'movie'), '我心里危险的东西');
    assert.equal(normalizeTmdbLookupTitle('超超超超超喜欢你的100个女朋友 第三季', 'tv'), '超超超超超喜欢你的100个女朋友');
});
