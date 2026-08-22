const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInvalidResourceHash } = require('../src/services/invalidResource');
const { classifyOperationError } = require('../src/services/operationError');

test('天翼分享码跨来源归一化为同一哈希', () => {
    const left = buildInvalidResourceHash('https://cloud.189.cn/t/AbC123?code=8888', 'cloud_share');
    const right = buildInvalidResourceHash('AbC123', 'cloud_share');
    assert.equal(left, right);
});

test('失效资源默认TTL符合规则', () => {
    const audit = classifyOperationError(new Error('分享链接审核中'));
    const code = classifyOperationError(new Error('访问码错误'));
    const gone = classifyOperationError(new Error('RSS HTTP 410'));
    const missing = classifyOperationError(new Error('RSS HTTP 404'));
    assert.equal(audit.resourceTtlMs, 6 * 60 * 60 * 1000);
    assert.equal(code.resourceTtlMs, 60 * 60 * 1000);
    assert.equal(gone.resourceDisposition, 'permanent');
    assert.equal(missing.resourceTtlMs, 24 * 60 * 60 * 1000);
});
