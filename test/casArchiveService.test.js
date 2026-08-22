const test = require('node:test');
const assert = require('node:assert/strict');

const {
    CasArchiveService,
    buildCasArchiveRelativePath,
    isCasArchivePath,
    pathsOverlap
} = require('../src/services/casArchiveService');

test('CAS archive mirrors the complete media path', () => {
    assert.equal(
        buildCasArchiveRelativePath('动漫/作品/Season 01/E01.mkv'),
        '_cas/动漫/作品/Season 01/E01.mkv.cas'
    );
    assert.equal(
        buildCasArchiveRelativePath('电影/Movie (2026)/Movie.mkv'),
        '_cas/电影/Movie (2026)/Movie.mkv.cas'
    );
    assert.equal(buildCasArchiveRelativePath('../outside.mkv'), '');
    assert.equal(buildCasArchiveRelativePath('动漫/_cas/E01.mkv'), '');
});

test('reserved archive paths are recognized but similarly named folders are not', () => {
    assert.equal(CasArchiveService.isReservedDirectory('_cas'), true);
    assert.equal(CasArchiveService.isReservedDirectory('_cas2'), false);
    assert.equal(isCasArchivePath('_cas/动漫/E01.mkv.cas'), true);
    assert.equal(isCasArchivePath('动漫/_cas_backup/E01.mkv'), false);
});

test('independent media paths do not overlap', () => {
    assert.equal(pathsOverlap('动漫/作品A', '动漫/作品B'), false);
    assert.equal(pathsOverlap('动漫/作品A', '动漫/作品A/Season 01'), true);
    assert.equal(pathsOverlap('电影/A', '电视剧/A'), false);
});

test('folder cache isolates parent folders and coalesces concurrent creation', async () => {
    const archive = new CasArchiveService();
    const calls = [];
    const createdFolders = new Map();
    const cloud189 = {
        async listFiles(parentId) {
            calls.push(`list:${parentId}`);
            return { fileListAO: { folderList: createdFolders.has(parentId) ? [createdFolders.get(parentId)] : [] } };
        },
        async createFolder(name, parentId) {
            calls.push(`create:${parentId}:${name}`);
            await new Promise(resolve => setTimeout(resolve, 5));
            const created = { id: `${parentId}-${name}`, name };
            createdFolders.set(parentId, created);
            return created;
        }
    };

    const [first, duplicate, secondRoot] = await Promise.all([
        archive.ensureFolder(cloud189, 'root-a', '_cas'),
        archive.ensureFolder(cloud189, 'root-a', '_cas'),
        archive.ensureFolder(cloud189, 'root-b', '_cas')
    ]);

    assert.equal(first, 'root-a-_cas');
    assert.equal(duplicate, first);
    assert.equal(secondRoot, 'root-b-_cas');
    assert.deepEqual(calls.filter(call => call.startsWith('create:')).sort(), [
        'create:root-a:_cas',
        'create:root-b:_cas'
    ]);
});
