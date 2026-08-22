const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeCandidateFilters, resolveValidationSeasonNumber, validatePtFilters } = require('../src/services/ptFilterValidation');

const samples = [
    { guid: '1', title: '目标剧 S01E01 2160p WEB-DL', rawTitle: '目标剧 S01E01 2160p WEB-DL', seasonNumber: 1, episodeNumber: 1 },
    { guid: '2', title: '其他剧 S01E01 2160p WEB-DL', rawTitle: '其他剧 S01E01 2160p WEB-DL', seasonNumber: 1, episodeNumber: 1 },
    { guid: '3', title: '目标剧 Trailer 2160p', rawTitle: '目标剧 Trailer 2160p', seasonNumber: 1, episodeNumber: null }
];

test('PT正则必须命中正确样本且不误命中错误标题/预告', () => {
    const result = validatePtFilters({ filters: { includePattern: '目标剧', excludePattern: 'Trailer|预告' }, samples, title: '目标剧', seasonNumber: 1 });
    assert.equal(result.summary.validMatchCount, 1);
    assert.equal(result.summary.falsePositiveCount, 0);
    assert.ok(result.token);
});

test('PT正则编译失败会拒绝保存', () => {
    assert.throws(() => validatePtFilters({ filters: { includePattern: '[' }, samples, title: '目标剧' }));
});

test('PT 验证令牌对正则和样本具有稳定绑定', () => {
    const first = validatePtFilters({ filters: { includePattern: '目标剧', excludePattern: 'Trailer|预告' }, samples, title: '目标剧', seasonNumber: 1 });
    const second = validatePtFilters({ filters: { includePattern: '目标剧', excludePattern: 'Trailer|预告' }, samples, title: '目标剧', seasonNumber: 1 });
    assert.equal(first.token, second.token);
    assert.notEqual(first.token, validatePtFilters({ filters: { includePattern: '目标剧 S01', excludePattern: 'Trailer|预告' }, samples, title: '目标剧', seasonNumber: 1 }).token);
});

test('候选固有正则与 Agent 正则合并后只命中目标字幕组', () => {
    const mixedSamples = [
        { guid: 'loli-1', title: '[LoliHouse] 碧蓝之海 第三季 / Grand Blue S3 - 01', rawTitle: '[LoliHouse] 碧蓝之海 第三季 / Grand Blue S3 - 01', seasonNumber: 3, episodeNumber: 1 },
        { guid: 'tea-1', title: '[绿茶字幕组] 碧蓝之海 第三季 - 01', rawTitle: '[绿茶字幕组] 碧蓝之海 第三季 - 01', seasonNumber: 3, episodeNumber: 1 },
        { guid: 'other-1', title: '[LoliHouse] 其他动画 - 01', rawTitle: '[LoliHouse] 其他动画 - 01', seasonNumber: 3, episodeNumber: 1 }
    ];
    const filters = mergeCandidateFilters(
        { includePattern: '^\\[LoliHouse\\]' },
        { includePattern: '碧蓝之海 第三季', excludePattern: 'Trailer|预告' }
    );
    const result = validatePtFilters({ filters, samples: mixedSamples, title: '碧蓝之海 第三季', seasonNumber: 3 });

    assert.equal(filters.includePattern, '^\\[LoliHouse\\]\n碧蓝之海 第三季');
    assert.deepEqual(result.filters, filters);
    assert.equal(result.summary.matchedCount, 1);
    assert.equal(result.summary.validMatchCount, 1);
    assert.equal(result.summary.falsePositiveCount, 0);
});

test('候选与 Agent 的排除规则任一命中都会排除', () => {
    const filters = mergeCandidateFilters(
        { excludePattern: 'Trailer' },
        { excludePattern: '预告\nTrailer' }
    );

    assert.equal(filters.excludePattern, 'Trailer\n预告');
});

test('Agent 的 Python 风格不区分大小写前缀规范化为 JavaScript 正则', () => {
    const filters = mergeCandidateFilters({}, {
        includePattern: '(?i)目标剧.*WEB-DL',
        excludePattern: '(?i)Trailer|预告'
    });

    assert.equal(filters.includePattern, '目标剧.*WEB-DL');
    assert.equal(filters.excludePattern, 'Trailer|预告');
    assert.doesNotThrow(() => validatePtFilters({ filters, samples, title: '目标剧', seasonNumber: 1 }));
});

test('剧场版真实样本无需季号和集号，但仍拒绝音乐误命中', () => {
    const movieSamples = [
        {
            guid: 'movie-chs',
            title: '[黑白字幕组]我心里危险的东西剧场版 Boku no Kokoro no Yabai Yatsu Movie [2026] [WEB-DL 1080p][CHS]',
            seasonNumber: null,
            episodeNumber: null
        },
        {
            guid: 'music',
            title: '[260218] Best Album 剧场版「我心里危险的东西」插曲 [FLAC]',
            seasonNumber: null,
            episodeNumber: null
        }
    ];
    const result = validatePtFilters({
        filters: { includePattern: '^\\[黑白字幕组\\].*我心里危险的东西剧场版' },
        samples: movieSamples,
        title: '我心里危险的东西 剧场版'
    });

    assert.equal(result.summary.mediaType, 'movie');
    assert.equal(result.summary.validMatchCount, 1);
    assert.equal(result.summary.falsePositiveCount, 0);
    assert.throws(() => validatePtFilters({
        filters: { includePattern: '我心里危险的东西' },
        samples: movieSamples,
        title: '我心里危险的东西 剧场版'
    }), /误命中 1 条/);
});

test('第三季标题允许有限简繁差异，仍严格拒绝错误季度', () => {
    const title = '超超超超超喜欢你的100个女朋友 第三季';
    const traditional = {
        guid: 'season-3',
        title: '[黒ネズミたち] 超超超超超喜歡你的 100 個女朋友 第三季 Hyakkano 3rd Season - 31',
        seasonNumber: 3,
        episodeNumber: 31
    };
    const valid = validatePtFilters({ filters: { includePattern: '第三季' }, samples: [traditional], title, seasonNumber: 3 });

    assert.equal(valid.summary.validMatchCount, 1);
    assert.throws(() => validatePtFilters({
        filters: { includePattern: '第三季' },
        samples: [{ ...traditional, seasonNumber: 1 }],
        title,
        seasonNumber: 3
    }), /季度和集号/);
});

test('PT 校验季度优先使用 TMDB 的唯一季度，否则使用标题季度', () => {
    assert.equal(resolveValidationSeasonNumber({
        title: '超超超超超喜欢你的100个女朋友 第三季',
        tmdbInfo: { type: 'tv', seasons: [{ seasonNumber: 1, episodeCount: 32 }] },
        seasonNumber: 3
    }), 1);
    assert.equal(resolveValidationSeasonNumber({
        title: '超超超超超喜欢你的100个女朋友 第三季',
        tmdbInfo: null,
        seasonNumber: null
    }), 3);
    assert.equal(resolveValidationSeasonNumber({
        title: '我心里危险的东西 剧场版',
        seasonNumber: 1
    }), null);
});
