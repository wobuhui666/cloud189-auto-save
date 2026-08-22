const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCloud189Json } = require('../src/utils/safeJson');

test('天翼 18 位标识符在 JSON 解析后保持精确字符串', () => {
    const result = parseCloud189Json(`{
        "fileId": 924511245739356595,
        "shareId":924511245739356596,
        "taskId": 924511245739356597,
        "targetFolderId": 924511245739356598
    }`);

    assert.equal(result.fileId, '924511245739356595');
    assert.equal(result.shareId, '924511245739356596');
    assert.equal(result.taskId, '924511245739356597');
    assert.equal(result.targetFolderId, '924511245739356598');
});

test('安全解析不会改变容量和文件大小等非 ID 数值', () => {
    const result = parseCloud189Json('{"fileId":924511245739356595,"size":924511245739356595,"count":12}');

    assert.equal(result.fileId, '924511245739356595');
    assert.equal(typeof result.size, 'number');
    assert.equal(result.count, 12);
});

test('已经是字符串的 ID 和普通 JSON 保持原样', () => {
    const result = parseCloud189Json('{"fileId":"924511245739356595","res_code":0,"name":"测试"}');

    assert.deepEqual(result, {
        fileId: '924511245739356595',
        res_code: 0,
        name: '测试'
    });
});
