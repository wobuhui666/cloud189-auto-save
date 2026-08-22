const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MediaLibraryLayoutService, isSpecialEpisodeName, pad2 } = require('../src/services/mediaLibraryLayout');

describe('isSpecialEpisodeName', () => {
    it('detects NCOP/NCED/SP/Non-Credit', () => {
        assert.ok(isSpecialEpisodeName('[Group] Show [NCOP][1080p].mkv'));
        assert.ok(isSpecialEpisodeName('[Group] Show [NCED03][1080p].mkv'));
        assert.ok(isSpecialEpisodeName('[Group] Show [NCED][1080p].mkv'));
        assert.ok(isSpecialEpisodeName('[Group] Show [SP01][1080p].mkv'));
        assert.ok(isSpecialEpisodeName('[Group] Show [EP23 C-Part Non-Credit Ver.].mkv'));
        assert.ok(isSpecialEpisodeName('[MAI] EIGHTY SIX [EP09 NCIN][Ma10p_2160p].mkv'));
        assert.ok(isSpecialEpisodeName('[MAI] EIGHTY SIX [11.5][Ma10p_2160p][x265_flac_ass].mkv'));
    });

    it('does not false-positive on normal files', () => {
        assert.ok(!isSpecialEpisodeName('Show.Name.S01E05.1080p.mkv'));
        assert.ok(!isSpecialEpisodeName('[Group] Show [01][1080p].mkv'));
        assert.ok(!isSpecialEpisodeName('Dispatched.Inspector.2024.mkv')); // \bSP\d must not match "sp" inside word
        assert.ok(!isSpecialEpisodeName(''));
        assert.ok(!isSpecialEpisodeName(null));
    });
});

describe('buildRelativeDir union semantics', () => {
    const svc = new MediaLibraryLayoutService();
    const tvInfo = { seasonBased: true, mediaType: 'tv' };

    it('trusts AI season 00 on non-regex name (OVA)', () => {
        const dir = svc.buildRelativeDir(
            { name: 'Show OVA.mkv' },
            { season: '00', episode: '01' },
            tvInfo
        );
        assert.equal(dir, 'Season 00');
    });

    it('safety net promotes NCOP even when AI says season 01', () => {
        const dir = svc.buildRelativeDir(
            { name: '[Group] Show [NCOP][1080p].mkv' },
            { season: '01', episode: '17' },
            tvInfo
        );
        assert.equal(dir, 'Season 00');
    });

    it('normal episodes trust AI season', () => {
        assert.equal(svc.buildRelativeDir({ name: 'E01.mkv' }, { season: '01' }, tvInfo), 'Season 01');
        assert.equal(svc.buildRelativeDir({ name: 'E01.mkv' }, { season: '2' }, tvInfo), 'Season 02');
        assert.equal(svc.buildRelativeDir({ name: 'E01.mkv' }, { season: '00' }, tvInfo), 'Season 00');
    });

    it('falls back to parseMediaTitle when no aiFile', () => {
        assert.equal(svc.buildRelativeDir({ name: 'Show.S02E05.mkv' }, null, tvInfo), 'Season 02');
        assert.equal(svc.buildRelativeDir({ name: 'random.mkv' }, null, tvInfo), 'Season 01');
    });
});

describe('buildFileName union semantics', () => {
    const svc = new MediaLibraryLayoutService();
    const tvInfo = { seasonBased: true, mediaType: 'tv' };
    const resourceInfo = { name: 'Test Show', type: 'tv' };

    it('NCED file with AI season 01 gets S00E in filename', () => {
        const name = svc.buildFileName(
            { name: '[Group] Test Show [NCED02][1080p].mkv' },
            { season: '01', episode: '02', extension: '.mkv' },
            resourceInfo,
            tvInfo
        );
        assert.ok(name.includes('S00E'), `expected S00E in "${name}"`);
        assert.ok(!name.includes('S01E'), `should not contain S01E in "${name}"`);
    });

    it('normal file keeps AI season', () => {
        const name = svc.buildFileName(
            { name: 'Test.Show.S01E05.mkv' },
            { season: '01', episode: '05', extension: '.mkv' },
            resourceInfo,
            tvInfo
        );
        assert.ok(name.includes('S01E05'), `expected S01E05 in "${name}"`);
    });
});

describe('simpleChatCompletion chunk-merge preserves per-file season', () => {
    it('chunk 2 season 00 is not clobbered by baseResult season', async () => {
        const aiService = require('../src/services/ai'); // singleton instance
        const originalChat = aiService.chat.bind(aiService);
        const originalIsEnabled = aiService.isEnabled.bind(aiService);

        try {
            aiService.isEnabled = () => true;
            let callCount = 0;
            aiService.chat = async () => {
                callCount++;
                if (callCount === 1) {
                    // First chunk: base result + 40 episodes
                    return {
                        success: true,
                        data: JSON.stringify({
                            name: 'Test Show',
                            year: 2024,
                            type: 'tv',
                            season: '01',
                            episode: Array.from({ length: 40 }, (_, i) => ({
                                id: String(i + 1),
                                name: 'Test Show',
                                season: '01',
                                episode: String(i + 1).padStart(2, '0'),
                                extension: '.mkv'
                            }))
                        })
                    };
                }
                // Second chunk: 1 normal + 1 special (season 00)
                return {
                    success: true,
                    data: JSON.stringify({
                        episode: [
                            { id: '41', name: 'Test Show', season: '01', episode: '41', extension: '.mkv' },
                            { id: '42', name: 'Test Show', season: '00', episode: '01', extension: '.mkv' }
                        ]
                    })
                };
            };

            const files = Array.from({ length: 42 }, (_, i) => ({
                id: String(i + 1),
                name: `Test.Show.${String(i + 1).padStart(2, '0')}.mkv`
            }));

            const result = await aiService.simpleChatCompletion('Test Show', files);
            assert.ok(result.success, 'AI call should succeed');

            const ep42 = result.data.episode.find(e => e.id === '42');
            assert.ok(ep42, 'episode 42 should exist');
            assert.equal(ep42.season, '00', 'chunk-2 special must keep season 00');
            assert.equal(ep42.name, 'Test Show', 'name must be unified to baseResult');

            const ep41 = result.data.episode.find(e => e.id === '41');
            assert.equal(ep41.season, '01', 'chunk-2 normal keeps season 01');
        } finally {
            aiService.chat = originalChat;
            aiService.isEnabled = originalIsEnabled;
        }
    });
});

describe('AI file parsing keeps nested path context', () => {
    it('passes relativePath to the model for nested folders', async () => {
        const aiService = require('../src/services/ai');
        const originalChat = aiService.chat.bind(aiService);
        const originalIsEnabled = aiService.isEnabled.bind(aiService);
        let userPrompt = '';

        try {
            aiService.isEnabled = () => true;
            aiService.chat = async (messages) => {
                userPrompt = messages.find(message => message.role === 'user')?.content || '';
                return {
                    success: true,
                    data: JSON.stringify({
                        name: 'Test Show',
                        year: 2024,
                        type: 'tv',
                        season: '02',
                        episode: [{
                            id: 'nested-1',
                            name: 'Test Show',
                            season: '02',
                            episode: '01',
                            extension: '.mkv'
                        }]
                    })
                };
            };

            const result = await aiService.simpleChatCompletion('Test Show', [{
                id: 'nested-1',
                name: '01.mkv',
                relativePath: 'Season 02/Disc 01/01.mkv'
            }]);

            assert.equal(result.success, true);
            assert.match(userPrompt, /Season 02\/Disc 01\/01\.mkv/);
        } finally {
            aiService.chat = originalChat;
            aiService.isEnabled = originalIsEnabled;
        }
    });
});

describe('applyLayoutToFiles end-to-end', () => {
    it('12 normal + NCOP + AI-flagged OVA → 12×S01 + 2×S00', () => {
        const svc = new MediaLibraryLayoutService();
        const libraryInfo = {
            seasonBased: true,
            mediaType: 'tv',
            canonicalTitle: 'Test Show',
            year: '2024',
            categoryName: '动漫',
            resourceFolderName: 'Test Show (2024)'
        };
        const resourceInfo = {
            name: 'Test Show',
            year: 2024,
            type: 'tv',
            episode: [
                ...Array.from({ length: 12 }, (_, i) => ({
                    id: String(i + 1),
                    name: 'Test Show',
                    season: '01',
                    episode: String(i + 1).padStart(2, '0'),
                    extension: '.mkv'
                })),
                { id: '13', name: 'Test Show', season: '01', episode: '13', extension: '.mkv' }, // NCOP, AI wrong
                { id: '14', name: 'Test Show', season: '00', episode: '01', extension: '.mkv' }  // OVA, AI correct
            ]
        };
        const files = [
            ...Array.from({ length: 12 }, (_, i) => ({
                id: String(i + 1),
                name: `[Group] Test Show [${String(i + 1).padStart(2, '0')}][1080p].mkv`
            })),
            { id: '13', name: '[Group] Test Show [NCOP][1080p].mkv' },
            { id: '14', name: '[Group] Test Show [OVA][1080p].mkv' }
        ];

        const result = svc.applyLayoutToFiles({
            localStrmPrefix: '/strm',
            libraryInfo,
            resourceInfo,
            files,
            renameFiles: true
        });

        const s00 = result.files.filter(f => (f.relativeDir || '').includes('Season 00'));
        const s01 = result.files.filter(f => (f.relativeDir || '').includes('Season 01'));
        assert.equal(s01.length, 12, '12 normal episodes in Season 01');
        assert.equal(s00.length, 2, 'NCOP + OVA in Season 00');
    });
});
