const test = require('node:test');
const assert = require('node:assert/strict');

const { QbittorrentClient } = require('../src/services/downloader/qbittorrent');

test('识别 qBittorrent 5 的停止状态', () => {
    const client = new QbittorrentClient();

    assert.equal(client._normalizeTorrent({ state: 'stoppedDL' }).isStopped, true);
    assert.equal(client._normalizeTorrent({ state: 'downloading' }).isStopped, false);
    assert.equal(client._normalizeTorrent({ state: 'queuedDL' }).isQueued, true);
});

test('强制启动任务绕过 qBittorrent 下载队列', async () => {
    const client = new QbittorrentClient();
    let request;
    client._request = async (...args) => {
        request = args;
    };

    await client.forceStartTorrent('ABC123');

    assert.deepEqual(request, [
        'POST',
        '/api/v2/torrents/setForceStart',
        { form: { hashes: 'ABC123', value: 'true' } }
    ]);
});

test('恢复任务使用 qBittorrent 5 的 start API', async () => {
    const client = new QbittorrentClient();
    let request;
    client._request = async (...args) => {
        request = args;
    };

    await client.startTorrent('ABC123');

    assert.equal(request[0], 'POST');
    assert.equal(request[1], '/api/v2/torrents/start');
    assert.deepEqual(request[2], { form: { hashes: 'ABC123' } });
});

test('旧版 qBittorrent 回退到 resume API', async () => {
    const client = new QbittorrentClient();
    const requests = [];
    client._request = async (...args) => {
        requests.push(args);
        if (args[1] === '/api/v2/torrents/start') {
            throw new Error('qBittorrent 请求失败(404): Not Found');
        }
    };

    await client.startTorrent('ABC123');

    assert.equal(requests[1][1], '/api/v2/torrents/resume');
    assert.deepEqual(requests[1][2], { form: { hashes: 'ABC123' } });
});
