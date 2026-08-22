const test = require('node:test');
const assert = require('node:assert/strict');
const { PtService, mediaPreferenceSatisfies, hasCandidateFilters } = require('../src/services/ptService');

test('人工 PT 订阅只在媒体偏好完全满足 Intent 时可复用', () => {
    const requested = {
        resolutionPriority: ['2160p', '1080p'],
        preferredGroups: ['LoliHouse'],
        blockedKeywords: ['Trailer'],
        upgradePolicy: 'higher_score'
    };
    assert.equal(mediaPreferenceSatisfies(requested, requested), true);
    assert.equal(mediaPreferenceSatisfies({ ...requested, preferredGroups: [] }, requested), false);
});

test('Agent PT 候选必须携带至少一个正则字段', () => {
    assert.equal(hasCandidateFilters({}), false);
    assert.equal(hasCandidateFilters({ includePattern: '目标剧' }), true);
});

test('Agent PT 空正则在签发验证令牌前被拒绝', async () => {
    const service = new PtService();

    await assert.rejects(
        service.validateAutoSeriesFilters({
            candidate: { items: [{ title: '目标剧 剧场版', rawTitle: '目标剧 剧场版' }] },
            filters: {},
            title: '目标剧 剧场版',
            mediaType: 'movie'
        }),
        /至少一个正则字段/
    );
});
