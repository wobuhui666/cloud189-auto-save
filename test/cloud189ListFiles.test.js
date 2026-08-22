const test = require('node:test');
const assert = require('node:assert/strict');

const { Cloud189Service } = require('../src/services/cloud189');

test('listFiles 保留 FileNotFound 响应，供调用方恢复失效目录', async () => {
    const cloud189 = Object.create(Cloud189Service.prototype);
    cloud189.isFamilyAccount = () => false;
    cloud189.requestWithRetry = async () => ({
        res_code: 'FileNotFound',
        res_msg: '文件不存在'
    });

    const result = await cloud189.listFiles('deleted-folder');

    assert.equal(result.res_code, 'FileNotFound');
    assert.equal(result.res_msg, '文件不存在');
    assert.equal(result.fileListAO, undefined);
});
