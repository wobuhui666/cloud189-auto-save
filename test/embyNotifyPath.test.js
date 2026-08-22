const test = require('node:test');
const assert = require('node:assert/strict');

const { EmbyService } = require('../src/services/emby');

function createService() {
    const service = Object.create(EmbyService.prototype);
    service.embyPathReplace = '';
    service._strmService = {
        resolveTaskStrmRoot: () => '电影/名侦探柯南：百万美元的五棱星 (2024)'
    };
    return service;
}

test('整理器任务按实际 STRM 布局通知 Emby', () => {
    const service = createService();
    const result = service._resolveNotifyPath({
        enableOrganizer: true,
        libraryLayout: '{"mediaType":"movie"}',
        realFolderName: 'emby/发布标题',
        account: { localStrmPrefix: '/strm' }
    });

    assert.equal(result, '/strm/电影/名侦探柯南：百万美元的五棱星 (2024)');
});

test('STRM 子前缀不会在 Emby 路径中重复', () => {
    const service = createService();
    service._strmService.resolveTaskStrmRoot = () => 'emby/电影/作品A (2024)';

    assert.equal(service._resolveNotifyPath({
        enableOrganizer: true,
        libraryLayout: '{"mediaType":"movie"}',
        account: { localStrmPrefix: '/strm/emby' }
    }), '/strm/emby/电影/作品A (2024)');
});

test('普通任务继续使用云盘到 Emby 的路径映射', () => {
    const service = createService();
    service.embyPathReplace = 'emby:/media';

    assert.equal(service._resolveNotifyPath({
        enableOrganizer: false,
        realFolderName: 'emby/作品A'
    }), '/media/作品A');
});

test('Emby 多版本选择可从 PlaybackInfo 取得非主媒体源', async () => {
    const service = Object.create(EmbyService.prototype);
    const primaryPath = 'http://example.test/api/stream/primary-token';
    const selectedPath = 'http://example.test/api/stream/selected-token';
    service.getItemById = async () => ({
        Id: 'episode-1',
        MediaSources: [{ Id: 'source-primary', Path: primaryPath }]
    });
    service.getMediaSourceById = async (itemId, mediaSourceId) => {
        assert.equal(itemId, 'episode-1');
        assert.equal(mediaSourceId, 'source-selected');
        return { Id: 'source-selected', Path: selectedPath };
    };
    service._resolveStreamProxyMediaUrl = async (mediaPath) => `resolved:${mediaPath}`;
    service._findTaskByItemPath = async () => {
        throw new Error('STRM 版本不应回退任务文件匹配');
    };

    const result = await service.resolveDirectUrlByItemId('episode-1', 'source-selected');

    assert.equal(result, `resolved:${selectedPath}`);
});

test('Emby 多版本选择优先复用详情中已存在的媒体源', async () => {
    const service = Object.create(EmbyService.prototype);
    const selectedPath = 'http://example.test/api/stream/selected-token';
    service.getItemById = async () => ({
        Id: 'episode-1',
        MediaSources: [
            { Id: 'source-primary', Path: 'http://example.test/api/stream/primary-token' },
            { Id: 'source-selected', Path: selectedPath }
        ]
    });
    service.getMediaSourceById = async () => {
        throw new Error('详情已含指定媒体源时不应再次请求 PlaybackInfo');
    };
    service._resolveStreamProxyMediaUrl = async (mediaPath) => `resolved:${mediaPath}`;

    const result = await service.resolveDirectUrlByItemId('episode-1', 'source-selected');

    assert.equal(result, `resolved:${selectedPath}`);
});

test('Emby 返回不匹配媒体源时不静默回退主版本', async () => {
    const service = Object.create(EmbyService.prototype);
    service.embyUrl = 'http://emby.test';
    service.request = async (_url, options) => {
        assert.equal(options.searchParams.MediaSourceId, 'source-selected');
        return {
            MediaSources: [{ Id: 'source-primary', Path: 'http://example.test/primary' }]
        };
    };

    const result = await service.getMediaSourceById('episode-1', 'source-selected');

    assert.equal(result, null);
});
