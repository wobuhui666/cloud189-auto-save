const ConfigService = require('../services/ConfigService');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

class ProxyUtil {
    static getProxy(service) {
        let proxy = null;
        if (!this._checkServiceEnabled(service)) {
            return proxy;
        }
        const proxyConfig = ConfigService.getConfigValue('proxy');
        const { type = 'http', host, port, username, password } = proxyConfig;
        if (host && port) {
            let proxyUrl = `${type}://${host}:${port}`;
            if (username && password) {
                proxyUrl = `${type}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
            }
            proxy = proxyUrl;
        }
        return proxy;
    }
    static getProxyAgent(service) {
        const proxy = this.getProxy(service);
        return !proxy?{}:{
            http: new HttpProxyAgent(proxy),
            https: new HttpsProxyAgent(proxy)
        }
    }
    static _checkServiceEnabled(service) {
        return !!ConfigService.getConfigValue(`proxy.services.${service}`);
    }
}

module.exports = ProxyUtil;