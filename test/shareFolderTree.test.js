const test = require('node:test');
const assert = require('node:assert/strict');

const { TaskService } = require('../src/services/task');

test('分享目录解析递归返回套娃文件夹及完整相对路径', async () => {
    const service = Object.create(TaskService.prototype);
    service._mapWithConcurrency = TaskService.prototype._mapWithConcurrency;
    const directoryResults = {
        season: {
            fileListAO: {
                fileList: [],
                folderList: [{ fileId: 'disc', fileName: '超长文件夹名称 Disc 01' }]
            }
        },
        disc: {
            fileListAO: {
                fileList: [{ id: 'episode', name: 'episode.mkv' }],
                folderList: []
            }
        }
    };
    const cloud189 = {
        listShareDir: async (_shareId, folderId) => directoryResults[folderId]
    };
    const rootResult = {
        fileListAO: {
            fileList: [],
            folderList: [{ id: 'season', name: 'Season 01' }]
        }
    };

    const folders = await service._collectShareFolderTree(
        cloud189,
        { shareId: 'share', fileId: 'root', shareMode: 1 },
        'code',
        rootResult
    );

    assert.deepEqual(folders.map(folder => ({ id: folder.id, relativePath: folder.relativePath, depth: folder.depth })), [
        { id: 'season', relativePath: 'Season 01', depth: 1 },
        { id: 'disc', relativePath: 'Season 01/超长文件夹名称 Disc 01', depth: 2 }
    ]);
    assert.equal(folders[0].hasFiles, true);
    assert.equal(folders[1].directFileCount, 1);
});

test('同时选择父子分享目录时只保留父目录，兄弟目录仍可独立选择', () => {
    const service = Object.create(TaskService.prototype);
    const nodes = [
        { id: 'season-1', relativePath: 'Season 01', depth: 1 },
        { id: 'disc-1', relativePath: 'Season 01/Disc 01', depth: 2 },
        { id: 'season-2', relativePath: 'Season 02', depth: 1 }
    ];

    const selected = service._filterSelectedShareFolderNodes(nodes, {
        selectedFolders: ['season-1', 'disc-1', 'season-2']
    });

    assert.deepEqual(selected.map(folder => folder.id), ['season-1', 'season-2']);
});

test('目标目录按分享相对路径逐层复用或创建', async () => {
    const service = Object.create(TaskService.prototype);
    const created = [];
    service.mutationExecutor = {
        createFolder: async (_cloud189, parentId, name) => {
            created.push([parentId, name]);
            return { value: { id: `${parentId}-${name}`, name } };
        }
    };
    const cloud189 = {
        listFiles: async folderId => ({
            fileListAO: {
                folderList: folderId === 'root'
                    ? [{ fileId: 'season-existing', fileName: 'Season 01' }]
                    : []
            }
        })
    };

    const target = await service._ensureTargetSubfolderPath(
        cloud189,
        { id: 'root', name: '/动漫/测试剧' },
        'Season 01/Disc 01'
    );

    assert.deepEqual(created, [['season-existing', 'Disc 01']]);
    assert.equal(target.id, 'season-existing-Disc 01');
    assert.equal(target.name, '/动漫/测试剧/Season 01/Disc 01');
});

test('传给 AI 的文件输入保留套娃目录完整相对路径', () => {
    const service = Object.create(TaskService.prototype);

    assert.deepEqual(service._buildAiFileInput({
        id: 'episode-1',
        name: '01.mkv',
        relativeDir: 'Season 02/Disc 01'
    }), {
        id: 'episode-1',
        name: '01.mkv',
        relativePath: 'Season 02/Disc 01/01.mkv'
    });
});
