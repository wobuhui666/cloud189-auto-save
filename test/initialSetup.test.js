const test = require('node:test');
const assert = require('node:assert/strict');

const {
    authorizeInitialSetup,
    getInitialSetupClientAddress,
    isLoopbackAddress,
    normalizeRemoteAddress
} = require('../src/utils/initialSetup');

const createRequest = (remoteAddress, setupToken = '', headers = {}) => ({
    socket: { remoteAddress },
    headers,
    body: setupToken ? { setupToken } : {}
});

test('首次初始化允许 IPv4 与 IPv6 回环地址', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.12.34.56'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(normalizeRemoteAddress('::ffff:192.0.2.1'), '192.0.2.1');
});

test('首次初始化默认拒绝远程客户端', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    delete process.env.INITIAL_SETUP_TOKEN;
    try {
        const result = authorizeInitialSetup(createRequest('192.0.2.10'));
        assert.equal(result.allowed, false);
        assert.equal(result.status, 403);
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});

test('首次初始化令牌允许受控的远程设置', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    process.env.INITIAL_SETUP_TOKEN = 'test-only-setup-token';
    try {
        assert.equal(authorizeInitialSetup(createRequest('192.0.2.10')).allowed, false);
        assert.deepEqual(
            authorizeInitialSetup(createRequest('192.0.2.10', 'test-only-setup-token')),
            { allowed: true, mode: 'token' }
        );
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});

test('本机反向代理后的远程初始化仍需令牌', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    process.env.INITIAL_SETUP_TOKEN = 'test-only-setup-token';
    const headers = { 'x-forwarded-for': '192.0.2.10, 127.0.0.1' };
    try {
        const request = createRequest('127.0.0.1', '', headers);
        assert.equal(getInitialSetupClientAddress(request), '192.0.2.10');
        assert.equal(authorizeInitialSetup(request).allowed, false);
        assert.deepEqual(
            authorizeInitialSetup(createRequest('127.0.0.1', 'test-only-setup-token', headers)),
            { allowed: true, mode: 'token' }
        );
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});

test('远程直连不能通过伪造转发头冒充本机', () => {
    const previousToken = process.env.INITIAL_SETUP_TOKEN;
    delete process.env.INITIAL_SETUP_TOKEN;
    try {
        const request = createRequest('192.0.2.10', '', { 'x-forwarded-for': '127.0.0.1' });
        assert.equal(getInitialSetupClientAddress(request), '192.0.2.10');
        assert.equal(authorizeInitialSetup(request).allowed, false);
    } finally {
        if (previousToken === undefined) delete process.env.INITIAL_SETUP_TOKEN;
        else process.env.INITIAL_SETUP_TOKEN = previousToken;
    }
});
