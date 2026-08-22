const test = require('node:test');
const assert = require('node:assert/strict');
const { PtService } = require('../src/services/ptService');

test('同轮 RSS 同集只选择媒体评分最高版本', () => {
    const service = new PtService();
    const selected = service._selectBestEpisodeVersions([
        { guid: '1080', rawTitle: '目标剧 S01E01 1080p WEB-DL AVC AAC', seasonNumber: 1, episodeNumber: 1 },
        { guid: '2160', rawTitle: '目标剧 S01E01 2160p WEB-DL HEVC HDR Atmos', seasonNumber: 1, episodeNumber: 1 }
    ], {
        mediaPreferenceJson: JSON.stringify({ resolutionPriority: ['2160p', '1080p'] }),
        upgradePolicy: 'higher_score'
    }, []);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].guid, '2160');
});

test('1080p 完成后出现 2160p 时标记升级来源且保留旧记录', () => {
    const service = new PtService();
    const selected = service._selectBestEpisodeVersions([
        { guid: '2160', rawTitle: '目标剧 S01E01 2160p WEB-DL HEVC HDR Atmos', seasonNumber: 1, episodeNumber: 1 }
    ], {
        mediaPreferenceJson: JSON.stringify({ resolutionPriority: ['2160p', '1080p'] }),
        upgradePolicy: 'higher_score'
    }, [{ id: 7, status: 'completed', rawTitle: '目标剧 S01E01 1080p WEB-DL AVC AAC', seasonNumber: 1, episodeNumber: 1, qualityScore: 100 }]);
    assert.equal(selected[0]._upgradeFrom.id, 7);
});

test('升级 release 入队时保持非活动，直到上传和 STRM 验证完成', async () => {
    const created = [];
    const releaseRepo = {
        find: async () => [{
            id: 7, subscriptionId: 1, guid: 'old-guid', status: 'completed', activeVersion: true,
            rawTitle: '目标剧 S01E01 1080p WEB-DL AVC', seasonNumber: 1, episodeNumber: 1,
            qualityScore: 100, infoHash: ''
        }],
        create: value => ({ id: 8, ...value }),
        save: async value => { created.push({ ...value }); return value; }
    };
    const service = new PtService({
        repositories: { ptRelease: releaseRepo, ptSubscription: { save: async value => value } },
        sourceService: {
            fetchFeedItems: async () => [{
                guid: 'new-guid', title: '目标剧 S01E01 2160p WEB-DL HEVC HDR', rawTitle: '目标剧 S01E01 2160p WEB-DL HEVC HDR',
                seasonNumber: 1, episodeNumber: 1, magnetUrl: 'magnet:?xt=urn:btih:abcdef'
            }]
        },
        invalidResourceService: { isInvalid: async () => false, record: async () => {} }
    });
    service._dispatchToDownloader = async () => {};

    await service._pollSubscription({
        id: 1, name: '目标剧', rssUrl: 'https://example.com/rss', episodeDedup: true,
        mediaPreferenceJson: JSON.stringify({ resolutionPriority: ['2160p', '1080p'] }),
        upgradePolicy: 'higher_score', globalExclude: false
    });

    const upgrade = created.find(item => item.id === 8);
    assert.equal(upgrade.upgradeFromReleaseId, 7);
    assert.equal(upgrade.activeVersion, false);
});

test('升级 STRM 验证失败时新版本不激活且旧版本保持 active', async () => {
    const release = {
        id: 8, subscriptionId: 1, title: '目标剧 S01E01 2160p', status: 'downloaded',
        upgradeFromReleaseId: 7, activeVersion: false, progress: 100, lastError: ''
    };
    const previous = { id: 7, activeVersion: true, status: 'completed' };
    const saves = [];
    const releaseRepo = {
        async save(value) {
            saves.push({ id: value.id, status: value.status, activeVersion: value.activeVersion });
            return value;
        },
        async findOneBy(where) {
            return Number(where.id) === previous.id ? previous : null;
        }
    };
    const service = new PtService({
        repositories: {
            ptRelease: releaseRepo,
            ptSubscription: { findOneBy: async () => ({ id: 1, accountId: 2, targetFolderId: 'target' }) },
            account: { findOneBy: async () => ({ id: 2, localStrmPrefix: '/strm' }) }
        },
        cloud189Factory: () => ({}),
        casArchiveService: { uploadStub: async () => ({ fileId: 'cas-1', relativePath: '_cas/file.cas' }) }
    });
    service._resolveReleaseLocalPath = async () => '/tmp/fake-release';
    service._buildPtUploadPlan = async () => ({
        rootRelativePath: '目标剧',
        organizeEnabled: false,
        files: [{ source: { relativePath: '目标剧.mkv', fullPath: '/tmp/fake-release/目标剧.mkv', size: 1024 }, cloudRelativePath: '目标剧/目标剧.mkv', fileName: '目标剧.mkv', isMedia: true }]
    });
    service._ensureNestedFolder = async () => 'folder';
    service._resolvePtUploadDestination = async () => ({ existing: true, fileId: 'cloud-1', fileName: '目标剧.mkv' });
    service._generateStrmForRelease = async () => { throw new Error('STRM 升级验证失败'); };

    const os = require('os');
    const path = require('path');
    const fsp = require('fs').promises;
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-upgrade-test-'));
    const mediaPath = path.join(tempDir, '目标剧.mkv');
    try {
        await fsp.writeFile(mediaPath, 'test');
        service._resolveReleaseLocalPath = async () => tempDir;
        service._buildPtUploadPlan = async (_subscription, _release, localFiles) => ({
            rootRelativePath: '目标剧',
            organizeEnabled: false,
            files: [{ source: localFiles[0], cloudRelativePath: '目标剧/目标剧.mkv', fileName: '目标剧.mkv', isMedia: true }]
        });
        await assert.rejects(service._uploadRelease(release), /STRM 升级验证失败/);
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
    }

    assert.equal(release.status, 'uploading');
    assert.equal(release.activeVersion, false);
    assert.equal(previous.activeVersion, true);
    assert.equal(saves.some(item => item.id === 8 && item.status === 'completed'), false);
    assert.equal(saves.some(item => item.id === 7), false);
});

test('旧版本停用写入失败时回滚新版本 active 状态', async () => {
    const release = { id: 8, status: 'uploading', upgradeFromReleaseId: 7, activeVersion: false };
    const previous = { id: 7, status: 'completed', activeVersion: true };
    const saves = [];
    const releaseRepo = {
        findOneBy: async () => previous,
        async save(value) {
            saves.push({ id: value.id, status: value.status, activeVersion: value.activeVersion });
            if (value.id === 7) throw new Error('旧版本状态写入失败');
            return value;
        }
    };
    const service = new PtService();

    await assert.rejects(service._activateUploadedRelease(release, releaseRepo), /旧版本状态写入失败/);
    assert.equal(release.activeVersion, false);
    assert.equal(previous.activeVersion, true);
    assert.deepEqual(saves.filter(item => item.id === 8).map(item => item.activeVersion), [true, false]);
});
