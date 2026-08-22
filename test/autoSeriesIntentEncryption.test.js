const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DataSource } = require('typeorm');
const PasswordCrypto = require('../src/utils/passwordCrypto');

test('手动 CloudSaver 分享链接加密落库并在服务端透明解密', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-series-secret-'));
    const database = path.join(tempDir, 'database.sqlite');
    const originalKey = process.env.PASSWORD_ENCRYPTION_KEY;
    process.env.PASSWORD_ENCRYPTION_KEY = '11'.repeat(32);
    const { AutoSeriesIntent } = require('../dist/entities');
    const source = new DataSource({
        type: 'sqlite',
        database,
        synchronize: true,
        logging: false,
        entities: [AutoSeriesIntent]
    });
    try {
        await source.initialize();
        const repository = source.getRepository(AutoSeriesIntent);
        await repository.save(repository.create({
            id: 'intent-secret',
            title: '目标剧',
            accountId: 1,
            targetFolderId: '2',
            targetFolder: '目录',
            selectedShareLink: 'https://cloud.189.cn/t/AbCdEf12'
        }));

        const [raw] = await source.query('SELECT selectedShareLink FROM auto_series_intent WHERE id = ?', ['intent-secret']);
        assert.notEqual(raw.selectedShareLink, 'https://cloud.189.cn/t/AbCdEf12');
        assert.equal(PasswordCrypto.isEncrypted(raw.selectedShareLink), true);
        const loaded = await repository.findOneBy({ id: 'intent-secret' });
        assert.equal(loaded.selectedShareLink, 'https://cloud.189.cn/t/AbCdEf12');
    } finally {
        if (source.isInitialized) await source.destroy();
        if (originalKey === undefined) delete process.env.PASSWORD_ENCRYPTION_KEY;
        else process.env.PASSWORD_ENCRYPTION_KEY = originalKey;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
