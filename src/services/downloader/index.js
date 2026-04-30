const ConfigService = require('../ConfigService');
const { QbittorrentClient } = require('./qbittorrent');

let cachedClient = null;
let cachedType = null;

function getDownloader() {
    const type = String(ConfigService.getConfigValue('pt.downloader.type', 'qbittorrent') || 'qbittorrent').toLowerCase();
    if (cachedClient && cachedType === type) {
        return cachedClient;
    }
    cachedType = type;
    switch (type) {
        case 'qbittorrent':
            cachedClient = new QbittorrentClient();
            return cachedClient;
        default:
            throw new Error(`不支持的下载客户端类型: ${type}`);
    }
}

function resetDownloader() {
    cachedClient = null;
    cachedType = null;
}

module.exports = { getDownloader, resetDownloader };
