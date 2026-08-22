const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const ConfigService = require('../src/services/ConfigService');
const { PtService } = require('../src/services/ptService');

const makeRepositories = (release, saves) => ({
    ptRelease: {
        findOneBy: async () => release,
        save: async value => {
            saves.push({ ...value });
            return value;
        }
    },
    ptSubscription: {
        findOneBy: async () => ({ id: release.subscriptionId })
    }
});

test('qBittorrent 任务被移除但本地文件完整时恢复为已下载', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pt-download-recovery-'));
    const downloadPath = path.join(tempRoot, 'release');
    const mediaPath = path.join(downloadPath, 'VOL1', 'episode.mkv');
    await fsp.mkdir(path.dirname(mediaPath), { recursive: true });
    await fsp.writeFile(mediaPath, 'complete');

    const release = {
        id: 101,
        subscriptionId: 7,
        title: '终将成为你 - QS-Raws',
        status: 'downloading',
        progress: 0,
        qbTorrentHash: 'missing-hash',
        downloadPath,
        torrentFilesJson: JSON.stringify([{ relativePath: 'VOL1/episode.mkv', size: 8 }])
    };
    const saves = [];
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({ getTorrent: async () => null })
    });

    try {
        await service._refreshDownloadStatus(release);
    } finally {
        await fsp.rm(tempRoot, { recursive: true, force: true });
    }

    assert.equal(release.status, 'downloaded');
    assert.equal(release.progress, 100);
    assert.equal(release.downloadPath, downloadPath);
    assert.equal(saves.at(-1).status, 'downloaded');
});

test('下载任务和本地文件都不存在时停止假下载状态', async () => {
    const release = {
        id: 101,
        subscriptionId: 7,
        title: '终将成为你 - QS-Raws',
        status: 'downloading',
        progress: 0,
        qbTorrentHash: 'missing-hash',
        infoHash: '',
        downloadPath: '/path/does/not/exist',
        torrentFilesJson: JSON.stringify([{ relativePath: 'episode.mkv', size: 8 }])
    };
    const saves = [];
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({ getTorrent: async () => null })
    });

    await service._refreshDownloadStatus(release);

    assert.equal(release.status, 'failed');
    assert.equal(release.qbTorrentHash, '');
    assert.equal(release.infoHash, 'missing-hash');
    assert.match(release.lastError, /下载任务不存在/);
});

test('丢失下载任务失败后点击重试会重新投递', async () => {
    const release = {
        id: 101,
        subscriptionId: 7,
        status: 'failed',
        qbTorrentHash: '',
        lastError: '下载任务不存在'
    };
    const saves = [];
    const service = new PtService({ repositories: makeRepositories(release, saves) });
    let dispatched = false;
    service._dispatchToDownloader = async (_subscription, value) => {
        dispatched = true;
        value.status = 'downloading';
    };
    service.runProcessing = async () => ({ processed: 0 });

    await service.retryRelease(release.id);

    assert.equal(dispatched, true);
    assert.equal(release.status, 'downloading');
});

test('下载中的任务点击重试不会跳过完成校验进入上传', async () => {
    const release = {
        id: 104,
        subscriptionId: 7,
        status: 'downloading',
        qbTorrentHash: 'active-hash',
        lastError: '旧错误'
    };
    const saves = [];
    const service = new PtService({ repositories: makeRepositories(release, saves) });
    let refreshed = false;
    service._refreshDownloadStatus = async value => {
        refreshed = true;
        assert.equal(value.status, 'downloading');
    };

    await service.retryRelease(release.id);

    assert.equal(refreshed, true);
    assert.equal(release.status, 'downloading');
});

test('下载器任务被停止时自动恢复下载', async () => {
    const release = {
        id: 101,
        subscriptionId: 7,
        title: '吹响！悠风号 第三季',
        status: 'downloading',
        progress: 0,
        qbTorrentHash: 'stopped-hash',
        downloadPath: ''
    };
    const saves = [];
    let startedHash = '';
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({
            getTorrent: async () => ({
                hash: 'stopped-hash',
                state: 'stoppedDL',
                isStopped: true,
                isCompleted: false,
                progress: 0,
                contentPath: '/downloads/incomplete/episode.mkv'
            }),
            startTorrent: async hash => {
                startedHash = hash;
            }
        })
    });

    await service._refreshDownloadStatus(release);

    assert.equal(startedHash, 'stopped-hash');
    assert.equal(release.lastError, '');
    assert.equal(saves.at(-1).status, 'downloading');
});

test('下载器任务被 qB 队列阻塞时强制启动', async () => {
    const release = {
        id: 102,
        subscriptionId: 7,
        title: '排队中的任务',
        status: 'downloading',
        progress: 0,
        qbTorrentHash: 'queued-hash',
        downloadPath: ''
    };
    const saves = [];
    let forcedHash = '';
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({
            getTorrent: async () => ({
                hash: 'queued-hash',
                state: 'queuedDL',
                isQueued: true,
                isStopped: false,
                isCompleted: false,
                progress: 0,
                savePath: '/downloads/pt'
            }),
            forceStartTorrent: async hash => {
                forcedHash = hash;
            }
        })
    });

    await service._refreshDownloadStatus(release);

    assert.equal(forcedHash, 'queued-hash');
    assert.equal(saves.at(-1).status, 'downloading');
});

test('qBittorrent 文件丢失时停止等待并允许重新投递', async () => {
    const release = {
        id: 105,
        subscriptionId: 7,
        title: '文件丢失的任务',
        status: 'downloading',
        progress: 36,
        qbTorrentHash: 'broken-hash',
        infoHash: '',
        downloadPath: '/downloads/incomplete/release'
    };
    const saves = [];
    let deletedTorrent;
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({
            getTorrent: async () => ({
                hash: 'broken-hash',
                state: 'missingFiles',
                isCompleted: false,
                progress: 0.36
            }),
            deleteTorrent: async (hash, deleteFiles) => {
                deletedTorrent = { hash, deleteFiles };
            }
        })
    });

    await service._refreshDownloadStatus(release);

    assert.deepEqual(deletedTorrent, { hash: 'broken-hash', deleteFiles: false });
    assert.equal(release.status, 'failed');
    assert.equal(release.infoHash, 'broken-hash');
    assert.equal(release.qbTorrentHash, '');
    assert.match(release.lastError, /文件丢失/);
    assert.equal(saves.at(-1).status, 'failed');
});

test('qBittorrent 错误任务移除失败时保留 hash 和明确错误', async () => {
    const release = {
        id: 106,
        subscriptionId: 7,
        title: '下载器错误的任务',
        status: 'downloading',
        qbTorrentHash: 'error-hash',
        infoHash: ''
    };
    const saves = [];
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({
            getTorrent: async () => ({
                hash: 'error-hash',
                state: 'error',
                isCompleted: false,
                progress: 0
            }),
            deleteTorrent: async () => {
                throw new Error('连接已断开');
            }
        })
    });

    await service._refreshDownloadStatus(release);

    assert.equal(release.status, 'failed');
    assert.equal(release.infoHash, 'error-hash');
    assert.equal(release.qbTorrentHash, 'error-hash');
    assert.match(release.lastError, /自动移除 qB 任务失败.*连接已断开/);
});

test('已完成任务从 qB 清理后返回成功语义', async () => {
    const releases = [{
        id: 107,
        subscriptionId: 7,
        title: '已完成并清理',
        status: 'completed',
        qbTorrentHash: 'cleaned-hash'
    }];
    const service = new PtService({
        repositories: {
            ptRelease: {
                find: async () => releases
            }
        },
        downloaderFactory: () => ({
            listNormalizedTorrents: async () => []
        })
    });

    const result = await service.listReleasesWithDownloader();

    assert.equal(result[0].downloader.state, 'cleaned');
});

test('汇总 PT 下载速度和天翼真传速度', () => {
    const service = new PtService();
    service._startCloudUploadTransfer(108);
    service._updateCloudUploadTransfer(108, {
        chunkBytes: 10 * 1024 * 1024,
        durationMs: 2000
    });

    const stats = service.getTransferStats([
        { downloader: { downloadSpeed: 3 * 1024 * 1024 } },
        { downloader: { downloadSpeed: 2 * 1024 * 1024 } },
        { downloader: null }
    ]);

    assert.equal(stats.downloadSpeed, 5 * 1024 * 1024);
    assert.equal(stats.cloudUploadSpeed, 5 * 1024 * 1024);

    service._finishCloudUploadTransfer(108);
    assert.equal(service.getTransferStats([]).cloudUploadSpeed, 0);
});

test('服务重启后会重新投递残留的 pending 任务', async () => {
    const release = {
        id: 103,
        subscriptionId: 7,
        title: '尚未投递的任务',
        status: 'pending',
        qbTorrentHash: ''
    };
    const service = new PtService({
        repositories: {
            ptRelease: {
                find: async () => [release],
                save: async value => value
            },
            ptSubscription: {
                findOneBy: async () => ({ id: 7 })
            }
        }
    });
    let dispatched = false;
    service._dispatchToDownloader = async (_subscription, value) => {
        dispatched = true;
        value.status = 'downloading';
    };
    service._refreshDownloadStatus = async () => {};

    const result = await service.runProcessing();

    assert.equal(dispatched, true);
    assert.equal(release.status, 'downloading');
    assert.deepEqual(result, { processed: 1 });
});

test('服务重启后自动续跑残留的秒传中任务', async () => {
    const release = {
        id: 159,
        subscriptionId: 18,
        title: '描绘直至生命尽头 - 04',
        status: 'uploading',
        progress: 100
    };
    const service = new PtService({
        repositories: {
            ptRelease: {
                find: async () => [release],
                save: async value => value
            }
        }
    });
    let uploaded = false;
    service._uploadRelease = async value => {
        uploaded = true;
        value.status = 'completed';
    };

    const result = await service.runProcessing();

    assert.equal(uploaded, true);
    assert.equal(release.status, 'completed');
    assert.deepEqual(result, { processed: 1 });
});

test('秒传重试时从下载器修正已迁移的本地路径', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const livePath = path.join(os.tmpdir(), `pt-live-${process.pid}.mkv`);
    fs.writeFileSync(livePath, 'complete');
    const release = {
        id: 159,
        qbTorrentHash: 'finished-hash',
        downloadPath: '/downloads/incomplete/moved.mkv'
    };
    const saves = [];
    const service = new PtService({
        repositories: {
            ptRelease: { save: async value => saves.push({ ...value }) }
        },
        downloaderFactory: () => ({
            getTorrent: async () => ({ contentPath: livePath, savePath: path.dirname(livePath) })
        })
    });

    try {
        assert.equal(await service._resolveReleaseLocalPath(release), livePath);
        assert.equal(release.downloadPath, livePath);
        assert.equal(saves.at(-1).downloadPath, livePath);
    } finally {
        fs.unlinkSync(livePath);
    }
});

test('重新投递前会丢弃下载器中不存在的旧 hash', async () => {
    const release = {
        id: 101,
        subscriptionId: 7,
        title: '终将成为你 - QS-Raws',
        status: 'pending',
        qbTorrentHash: 'missing-hash',
        infoHash: '',
        torrentUrl: 'https://example.com/release.torrent'
    };
    const saves = [];
    let addOptions;
    const service = new PtService({
        repositories: makeRepositories(release, saves),
        downloaderFactory: () => ({
            getTorrent: async () => null,
            addTorrent: async options => {
                addOptions = options;
                return { hash: 'new-hash', savePath: '/downloads/pt/sub-7/rel-101' };
            }
        })
    });
    service._prepareTorrentSource = async () => ({
        url: release.torrentUrl,
        infoHash: release.infoHash,
        buffer: null,
        fileName: '',
        rootName: '',
        files: [],
        totalSize: 0
    });

    const originalDownloadRoot = ConfigService.getConfigValue('pt.downloadRoot', '');
    ConfigService._config.pt.downloadRoot = os.tmpdir();
    try {
        await service._dispatchToDownloader({ id: 7 }, release);
    } finally {
        ConfigService._config.pt.downloadRoot = originalDownloadRoot;
    }

    assert.equal(release.infoHash, 'missing-hash');
    assert.equal(release.qbTorrentHash, 'new-hash');
    assert.equal(addOptions.infoHash, undefined);
});
