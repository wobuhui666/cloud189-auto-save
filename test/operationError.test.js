const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyOperationError, calculateRetryDelayMs, createNoCoverageError, ERROR_CATEGORIES } = require('../src/services/operationError');

test('错误分类覆盖审核、死链、鉴权和限流', () => {
    assert.equal(classifyOperationError(new Error('ShareAuditWaiting')).category, ERROR_CATEGORIES.RESOURCE_AUDIT);
    assert.equal(classifyOperationError(new Error('分享链接已取消或过期')).category, ERROR_CATEGORIES.RESOURCE_INVALID);
    assert.equal(classifyOperationError(new Error('HTTP_401 Unauthorized')).category, ERROR_CATEGORIES.AUTH);
    assert.equal(classifyOperationError(new Error('HTTP_429 rate limit')).category, ERROR_CATEGORIES.RATE_LIMIT);
});

test('AI 402 需要人工处理，不进入自动重试风暴', () => {
    const payment = classifyOperationError(new Error('Response code 402 (Payment Required)'));

    assert.equal(payment.category, ERROR_CATEGORIES.PERMISSION);
    assert.equal(payment.code, 'PAYMENT_REQUIRED');
    assert.equal(payment.retryable, false);
});

test('任务指数退避不超过30分钟并支持抖动', () => {
    assert.equal(calculateRetryDelayMs(1, { baseMs: 60_000, random: () => 0.5 }), 60_000);
    assert.equal(calculateRetryDelayMs(20, { baseMs: 60_000, random: () => 0.5 }), 30 * 60 * 1000);
});

test('无覆盖是非死链的资源类终态，鉴权错误不重试', () => {
    const noCoverage = createNoCoverageError('无资源');
    assert.equal(noCoverage.code, 'NO_COVERAGE');
    assert.equal(noCoverage.resourceDisposition, 'none');
    assert.equal(noCoverage.retryable, false);
    assert.equal(classifyOperationError(new Error('HTTP 401 unauthorized')).retryable, false);
});
