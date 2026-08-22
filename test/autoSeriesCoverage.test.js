const test = require('node:test');
const assert = require('node:assert/strict');
const {
    analyzeCoverageFiles,
    buildCoverageScope,
    buildExpectedCoverage,
    buildGreedyCoveragePlan,
    mergeCoverageScopes,
    matchesCoverageScope
} = require('../src/services/autoSeriesCoverage');

const tmdbInfo = {
    totalSeasons: 3,
    totalEpisodes: 8,
    seasons: [
        { seasonNumber: 1, episodeCount: 3 },
        { seasonNumber: 2, episodeCount: 3 },
        { seasonNumber: 3, episodeCount: 2 }
    ]
};

test('从嵌套分享目录和文件名提取季度集数覆盖', () => {
    const coverage = analyzeCoverageFiles([
        { name: 'Show.S01E01.2160p.mkv', relativeDir: 'Season 01' },
        { name: 'Show.S01E02.2160p.mkv', relativeDir: 'Season 01' },
        { name: 'Show.E03.1080p.mp4', relativeDir: 'Season 01' },
        { name: 'Show.S01E02.zh-CN.ass', relativeDir: 'Season 01' },
        { name: 'behind-the-scenes.mkv', relativeDir: 'Extras' }
    ], { tmdbInfo, candidateTitle: 'Show S01' });

    assert.deepEqual(coverage.keys, ['S01E001', 'S01E002', 'S01E003']);
    assert.equal(coverage.mediaFileCount, 4);
    assert.equal(coverage.seasons[0].complete, true);
});

test('全集标题只作为声明，不能替代实际文件覆盖证据', () => {
    const coverage = analyzeCoverageFiles([], { tmdbInfo, candidateTitle: 'Show Complete S01-S02 全集' });
    assert.equal(coverage.coveredEpisodes, 0);
    assert.deepEqual(coverage.claimedCompleteSeasons, [1, 2]);
});

test('有季度目录时识别纯数字剧集文件', () => {
    const coverage = analyzeCoverageFiles([
        { name: '01.mkv', relativeDir: 'Season 02' },
        { name: '02.mp4', relativeDir: 'Season 02' }
    ], { tmdbInfo, candidateTitle: 'Show' });
    assert.deepEqual(coverage.keys, ['S02E001', 'S02E002']);
});

test('贪心覆盖计划组合分散来源并避免重复集', () => {
    const expected = buildExpectedCoverage(tmdbInfo);
    const plan = buildGreedyCoveragePlan([
        { candidateId: 'a', score: 80, coverageKeys: ['S01E001', 'S01E002', 'S01E003', 'S02E001'] },
        { candidateId: 'b', score: 95, coverageKeys: ['S02E001', 'S02E002', 'S02E003'] },
        { candidateId: 'c', score: 70, coverageKeys: ['S03E001', 'S03E002'] }
    ], expected);

    assert.equal(plan.complete, true);
    assert.deepEqual(plan.assignments, [
        { candidateId: 'a', keys: ['S01E001', 'S01E002', 'S01E003', 'S02E001'] },
        { candidateId: 'b', keys: ['S02E002', 'S02E003'] },
        { candidateId: 'c', keys: ['S03E001', 'S03E002'] }
    ]);
});

test('任务覆盖范围同时过滤媒体与同集字幕', () => {
    const expected = buildExpectedCoverage(tmdbInfo);
    const scope = buildCoverageScope(['S02E002'], expected);
    assert.equal(matchesCoverageScope({ name: 'Show.S02E02.mkv', relativeDir: 'Season 02' }, scope), true);
    assert.equal(matchesCoverageScope({ name: 'Show.S02E02.zh.ass', relativeDir: 'Season 02' }, scope), true);
    assert.equal(matchesCoverageScope({ name: 'Show.S02E01.mkv', relativeDir: 'Season 02' }, scope), false);
});

test('同一分享后续补集时合并任务覆盖范围', () => {
    const expected = buildExpectedCoverage(tmdbInfo);
    const merged = mergeCoverageScopes(
        buildCoverageScope(['S01E001'], expected),
        buildCoverageScope(['S01E002'], expected),
        expected
    );
    assert.deepEqual(merged.keys, ['S01E001', 'S01E002']);
});
