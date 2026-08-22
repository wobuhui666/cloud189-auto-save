const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const Module = require('node:module');

test('Emby 反代下游中断时销毁上游且不抛出未处理异常', async () => {
    const upstream = new PassThrough();
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'got') {
            return { stream: () => upstream };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    let EmbyService;
    try {
        delete require.cache[require.resolve('../src/services/emby')];
        ({ EmbyService } = require('../src/services/emby'));
    } finally {
        Module._load = originalLoad;
    }

    const service = Object.create(EmbyService.prototype);
    service.embyUrl = 'http://emby.test';
    const req = new EventEmitter();
    req.headers = {};
    req.method = 'GET';
    req.readable = false;
    const res = new PassThrough();
    res.destroyed = false;
    res.writableEnded = false;
    res.status = () => res;
    res.json = () => res;
    res.setHeader = () => {};

    await service._forwardToEmby(req, res, '/emby/Items', '');
    req.emit('aborted');

    assert.equal(upstream.destroyed, true);
});
