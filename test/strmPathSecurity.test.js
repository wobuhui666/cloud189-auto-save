const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { StrmService } = require('../src/services/strm');

const createService = () => {
    const service = Object.create(StrmService.prototype);
    service.baseDir = path.resolve('/tmp/cloud189-strm-security-test/strm');
    return service;
};

test('STRM 路径解析保留合法的历史路径兼容', () => {
    const service = createService();
    assert.equal(service._normalizeBaseRelativePath('strm/动漫/Season 01'), '动漫/Season 01');
    assert.equal(service._resolveBasePath('动漫/Season 01'), path.join(service.baseDir, '动漫/Season 01'));
});

test('STRM 路径解析拒绝父目录、绝对路径和 NUL 字节', () => {
    const service = createService();
    for (const unsafePath of ['../outside', 'a/../../outside', '/etc', 'C:\\Windows', 'safe\0outside']) {
        assert.throws(() => service._resolveBasePath(unsafePath), /STRM路径不合法|STRM路径超出允许目录/);
    }
});

test('STRM 路径解析使用路径段边界而非字符串前缀', () => {
    const service = createService();
    const siblingPath = `${service.baseDir}-backup/file.strm`;
    assert.throws(() => service._resolveBasePath(siblingPath), /STRM路径超出允许目录/);
});

test('STRM 目录读取拒绝逃逸基础目录的符号链接', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud189-strm-security-'));
    const service = createService();
    service.baseDir = path.join(temporaryRoot, 'strm');
    const outsideDir = path.join(temporaryRoot, 'outside');
    await fs.mkdir(service.baseDir);
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, path.join(service.baseDir, 'escape'));
    try {
        await assert.rejects(() => service.listStrmFiles('escape'), /STRM路径超出允许目录/);
    } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
});
