const test = require('node:test');
const assert = require('node:assert/strict');

const { LazyShareStrmService } = require('../src/services/lazyShareStrm');
const { StreamProxyService } = require('../src/services/streamProxy');

function createService(files) {
    const service = Object.create(LazyShareStrmService.prototype);
    const cloud189 = {
        listFiles: async () => ({
            fileListAO: { fileList: files }
        })
    };
    return { service, cloud189 };
}

test('按源文件 MD5 和大小命中重命名后的目标文件', async () => {
    const { service, cloud189 } = createService([
        { id: 'target-1', name: '整理后的名称.mp4', md5: 'ABC123', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileId: 'share-1',
        fileName: '整理后的名称.mp4',
        originalFileName: '分享原名.1080p.mp4',
        sourceMd5: 'abc123',
        sourceSize: 1024
    });

    assert.equal(result.id, 'target-1');
});

test('有源指纹时不因同名文件而误命中', async () => {
    const { service, cloud189 } = createService([
        { id: 'wrong', name: '整理后的名称.mp4', md5: 'DIFFERENT', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileName: '整理后的名称.mp4',
        sourceMd5: 'ABC123',
        sourceSize: 1024
    });

    assert.equal(result, null);
});

test('同一源指纹对应多个目标文件时确定性选择目标 UFID', async () => {
    const { service, cloud189 } = createService([
        { id: 'target-2', name: 'b.mp4', md5: 'ABC123', size: 1024 },
        { id: 'target-1', name: 'a.mp4', md5: 'ABC123', size: 1024 }
    ]);

    const result = await service._findTransferredFile(cloud189, 'folder-1', {
        fileName: '整理后的名称.mp4',
        sourceMd5: 'ABC123',
        sourceSize: 1024
    });

    assert.equal(result.id, 'target-1');
});

test('CAS 已转存存根必须继续还原，不能直接返回存根', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    service.transferInflight = new Map();
    service._findTransferredFile = async () => ({ id: 'cas-target', name: 'video.mp4.cas' });
    service._restoreCasTransferredFile = async (_cloud189, _folderId, file) => ({
        id: 'restored-target',
        name: file.name.replace(/\.cas$/, '')
    });
    service._submitShareSaveTask = async () => {
        throw new Error('已有 CAS 存根时不应重复提交转存');
    };

    const result = await service._ensureTransferredFile({}, {
        accountId: 1,
        shareId: 'share-1',
        fileId: 'source-1',
        fileName: 'video.mp4.cas',
        originalFileName: 'video.mp4',
        isCas: true
    }, 'folder-1');

    assert.equal(result.id, 'restored-target');
});

test('分享目录收集保留源文件指纹', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    const cloud189 = {
        listShareDir: async () => ({
            fileListAO: {
                folderList: [],
                fileList: [{ id: 'source-1', name: 'video.mp4', md5: 'ABC123', size: 1024 }]
            }
        })
    };

    const files = await service._collectShareEntries(cloud189, {
        isFolder: true,
        fileId: 'root',
        shareId: 'share-1',
        shareMode: 1
    }, '');

    assert.equal(files[0].md5, 'ABC123');
    assert.equal(files[0].size, 1024);
});

test('播放 token 保留源文件指纹', () => {
    const service = Object.create(StreamProxyService.prototype);
    service._getSecret = () => 'test-secret';

    const token = service.buildToken({
        type: 'lazyShare',
        accountId: 1,
        shareId: 'share-1',
        shareMode: 5,
        fileId: 'source-1',
        fileName: '整理后的名称.mp4',
        sourceMd5: 'abc123',
        sourceSize: 1024
    });
    const payload = service.parseToken(token);

    assert.equal(payload.sourceMd5, 'ABC123');
    assert.equal(payload.sourceSize, 1024);
    assert.equal(payload.shareMode, 5);
});

test('PT subscription token 的直链身份和缓存键保持不变', () => {
    const service = Object.create(StreamProxyService.prototype);
    service._getSecret = () => 'test-secret';
    const payload = service.parseToken(service.buildToken({
        type: 'subscription',
        accountId: 7,
        fileId: 'pt-cloud-file',
        fileName: 'episode.mkv'
    }));

    assert.equal(payload.type, 'subscription');
    assert.equal(payload.fileId, 'pt-cloud-file');
    assert.equal(service._getCacheKey(payload), '7:direct:pt-cloud-file');
});

test('PT CAS subscription token 使用归档恢复播放链路', () => {
    const service = Object.create(LazyShareStrmService.prototype);

    assert.equal(service.isArchivedCasPlaybackPayload({
        type: 'subscription',
        targetFolderId: 'root-1',
        isCas: true
    }), true);
    assert.equal(service.isArchivedCasPlaybackPayload({
        type: 'subscription',
        targetFolderId: 'root-1',
        isCas: false
    }), false);
});

test('PT CAS 播放从归档存根恢复，不再读取已删除的旧媒体 ID', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    service.casService = {
        downloadAndParseCas: async (_cloud189, fileId) => {
            assert.equal(fileId, 'cas-5');
            return { name: 'episode.mkv', size: 1024, md5: 'ABC', sliceMd5: 'DEF' };
        },
        restoreFromCas: async (_cloud189, folderId, _casInfo, restoreName) => {
            assert.equal(folderId, 'season-folder');
            assert.equal(restoreName, 'episode.mkv');
        }
    };
    service._inspectFolder = async () => ({ exists: true });
    service._ensureTargetFolder = async () => 'season-folder';
    service._findExistingFolderPath = async (_cloud189, rootFolderId, relativeDir) => {
        assert.equal(rootFolderId, 'media-root');
        assert.equal(relativeDir, '_cas/动漫/Example/Season 01');
        return 'cas-season-folder';
    };
    const requestedNames = [];
    service._findFileByName = async (_cloud189, folderId, fileName) => {
        requestedNames.push([folderId, fileName]);
        if (folderId === 'cas-season-folder' && fileName === 'episode.mkv.cas') {
            return { id: 'cas-5', name: fileName };
        }
        return null;
    };
    service._waitForTransferredFile = async () => ({ id: 'restored-5', name: 'episode.mkv' });

    const result = await service._resolveArchivedCasTargetFile({}, {
        type: 'subscription',
        accountId: 1,
        fileId: 'deleted-media-5',
        fileName: 'episode.mkv',
        originalFileName: 'episode.mkv',
        targetFolderId: 'media-root',
        relativeDir: '动漫/Example/Season 01',
        isCas: true
    });

    assert.equal(result.id, 'restored-5');
    assert.deepEqual(requestedNames, [
        ['season-folder', 'episode.mkv'],
        ['cas-season-folder', 'episode.mkv.cas']
    ]);
});

test('目标目录对象只有 fileId 时直接复用，不重复创建目录', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    let createCalls = 0;
    service.mutationExecutor = {
        createFolder: async () => {
            createCalls += 1;
            return { value: { id: 'unexpected' } };
        }
    };
    const cloud189 = {
        listFiles: async () => ({
            fileListAO: {
                folderList: [{ fileId: 'season-3', fileName: 'Season 03' }]
            }
        })
    };

    const folderId = await service._ensureChildFolder(cloud189, 'show-root', 'Season 03');

    assert.equal(folderId, 'season-3');
    assert.equal(createCalls, 0);
});

test('父目录查询失败时不把失败响应伪装为空目录', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    let createCalls = 0;
    service.mutationExecutor = {
        createFolder: async () => {
            createCalls += 1;
            return { value: { id: 'unexpected' } };
        }
    };
    const cloud189 = {
        listFiles: async () => ({ res_code: 'FileNotFound', res_msg: '文件不存在' })
    };

    await assert.rejects(
        () => service._ensureChildFolder(cloud189, 'deleted-parent', 'Season 03'),
        /文件不存在/
    );
    assert.equal(createCalls, 0);
});

test('恢复被删除的任务目录后同步当前播放 payload', async () => {
    const task = {
        accountId: 1,
        shareId: 'share-1',
        realFolderId: 'deleted-folder'
    };
    const service = Object.create(LazyShareStrmService.prototype);
    service.taskService = {
        taskRepo: {
            findOne: async () => task
        },
        _autoCreateFolder: async (_cloud189, targetTask) => {
            targetTask.realFolderId = 'recovered-folder';
        }
    };
    const payload = {
        accountId: 1,
        shareId: 'share-1',
        targetFolderId: 'deleted-folder'
    };

    const recoveredFolderId = await service._recoverTaskTargetFolder({}, payload);

    assert.equal(recoveredFolderId, 'recovered-folder');
    assert.equal(payload.targetFolderId, 'recovered-folder');
});

test('旧播放令牌目录失效时复用任务已恢复的新目录', async () => {
    const currentTask = {
        accountId: 1,
        shareId: 'share-1',
        realFolderId: 'current-folder'
    };
    const service = Object.create(LazyShareStrmService.prototype);
    service.taskService = {
        taskRepo: {
            findOne: async () => null,
            find: async () => [currentTask]
        },
        _autoCreateFolder: async () => {
            throw new Error('当前目录存在时不应再次恢复');
        }
    };
    service._inspectFolder = async (_cloud189, folderId) => ({
        exists: folderId === 'current-folder'
    });
    const payload = {
        accountId: 1,
        shareId: 'share-1',
        targetFolderId: 'stale-folder'
    };

    const recoveredFolderId = await service._recoverTaskTargetFolder({}, payload);

    assert.equal(recoveredFolderId, 'current-folder');
    assert.equal(payload.targetFolderId, 'current-folder');
});

test('同一分享包含多个任务时旧令牌不误命中兄弟任务目录', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    service.taskService = {
        taskRepo: {
            findOne: async () => null,
            find: async () => [
                { realFolderId: 'folder-a' },
                { realFolderId: 'folder-b' }
            ]
        }
    };
    service._inspectFolder = async () => {
        throw new Error('多个目录时不应猜测目标目录');
    };
    const payload = {
        accountId: 1,
        shareId: 'shared-resource',
        targetFolderId: 'stale-folder'
    };

    const recoveredFolderId = await service._recoverTaskTargetFolder({}, payload);

    assert.equal(recoveredFolderId, '');
    assert.equal(payload.targetFolderId, 'stale-folder');
});

test('新播放令牌用任务身份从同一分享的多个目录中恢复', async () => {
    const service = Object.create(LazyShareStrmService.prototype);
    service.taskService = {
        taskRepo: {
            findOne: async () => null,
            find: async () => [
                { accountId: 1, shareId: 'shared-resource', shareFileId: 'file-a', realFolderId: 'folder-a' },
                { accountId: 1, shareId: 'shared-resource', shareFileId: 'file-b', realFolderId: 'folder-b' }
            ]
        }
    };
    service._inspectFolder = async (_cloud189, folderId) => ({ exists: folderId === 'folder-b' });
    const payload = {
        accountId: 1,
        shareId: 'shared-resource',
        targetFolderId: 'stale-folder',
        targetIdentity: '1:shared-resource:file-b'
    };

    const recoveredFolderId = await service._recoverTaskTargetFolder({}, payload);

    assert.equal(recoveredFolderId, 'folder-b');
    assert.equal(payload.targetFolderId, 'folder-b');
});
