const test = require('node:test');
const assert = require('node:assert/strict');
const { CloudMutationExecutor } = require('../src/services/cloudMutationExecutor');

test('请求结果不明确时先回读，未生效后最多重发一次', async () => {
    let mutations = 0;
    let verifies = 0;
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const result = await executor.execute({
        operation: 'test',
        mutate: async () => { mutations++; return null; },
        verify: async () => (++verifies >= 2 ? { ok: true } : null)
    });
    assert.equal(result.resent, true);
    assert.equal(mutations, 2);
});

test('创建目录按父目录、名称和ID回读验证', async () => {
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const cloud = {
        createFolder: async () => ({ id: '2', name: '目标' }),
        listFiles: async parent => ({ fileListAO: { folderList: parent === '1' ? [{ id: '2', name: '目标' }] : [] } })
    };
    const result = await executor.createFolder(cloud, '1', '目标');
    assert.equal(result.value.id, '2');
});

test('重命名通过文件详情回读新名称', async () => {
    let currentName = '旧名称';
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const cloud = {
        renameFile: async () => { currentName = '新名称'; return { res_code: 0 }; },
        getFileInfo: async id => ({ id, name: currentName })
    };
    const result = await executor.rename(cloud, '10', '新名称');
    assert.equal(result.value.name, '新名称');
    assert.equal(result.resent, false);
});

test('删除通过文件详情不可见确认完成', async () => {
    let exists = true;
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const cloud = {
        deleteFile: async () => { exists = false; return { res_code: 0 }; },
        getFileInfo: async id => exists ? { id, name: '待删除' } : null
    };
    const result = await executor.delete(cloud, '11', '待删除');
    assert.deepEqual(result.value, { deleted: true });
});

test('移动要求目标目录包含全部项目且源目录不再包含', async () => {
    let moved = false;
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const cloud = {
        listFiles: async folderId => ({
            fileListAO: {
                fileList: folderId === 'target'
                    ? (moved ? [{ id: '20', name: '剧集.mkv' }] : [])
                    : (moved ? [] : [{ id: '20', name: '剧集.mkv' }])
            }
        })
    };
    const result = await executor.move(cloud, 'source', 'target', [{ id: '20' }], async () => { moved = true; });
    assert.deepEqual(result.value, { moved: true });
});

test('上传按父目录、文件名、大小和响应ID回读验证', async () => {
    let uploaded = false;
    const executor = new CloudMutationExecutor({ verifyDelaysMs: [0], sleep: async () => {} });
    const cloud = {
        listFiles: async () => ({
            fileListAO: { fileList: uploaded ? [{ id: '30', name: '剧集.mkv', size: 1024 }] : [] }
        })
    };
    const result = await executor.upload(cloud, 'parent', '剧集.mkv', async () => {
        uploaded = true;
        return { fileId: '30' };
    }, { size: 1024 });
    assert.equal(result.value.id, '30');
    assert.equal(result.resent, false);
});
