const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreMediaTitle, selectBestTier } = require('../src/services/mediaPreference');

test('媒体偏好分层优先2160p并排除预告样片', () => {
    const best = selectBestTier([
        { title: 'Demo S01E01 1080p WEB-DL AVC AAC' },
        { title: 'Demo S01E01 2160p WEB-DL HEVC HDR Atmos' },
        { title: 'Demo Trailer 2160p Remux' }
    ]);
    assert.match(best.title, /2160p WEB-DL HEVC/);
    assert.equal(scoreMediaTitle('Demo Trailer 2160p').blocked, true);
});

test('英文短排除词按完整词匹配，不误伤外挂字幕等普通文本', () => {
    const result = scoreMediaTitle(
        '[QS-Raws] 终将成为你 [BDRip_1080P][H264-10Bits_FLAC][VOL1][外挂简繁字幕]',
        {}
    );
    assert.equal(result.blocked, false);
    assert.equal(scoreMediaTitle('[Group] Show CAM 1080p', {}).blocked, true);
});
