const crypto = require('crypto');
const net = require('net');

const getInitialSetupToken = () => String(process.env.INITIAL_SETUP_TOKEN || '').trim();

const normalizeRemoteAddress = (value = '') => {
    const address = String(value || '').trim().toLowerCase();
    if (address.startsWith('::ffff:')) {
        return address.slice('::ffff:'.length);
    }
    const zoneIndex = address.indexOf('%');
    return zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
};

const isLoopbackAddress = (value = '') => {
    const address = normalizeRemoteAddress(value);
    if (address === 'localhost' || address === '::1') {
        return true;
    }
    if (net.isIP(address) === 4) {
        return address.startsWith('127.');
    }
    return false;
};

const timingSafeEqualText = (left = '', right = '') => {
    const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
    const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
};

const getPresentedSetupToken = (req) => String(
    req?.headers?.['x-setup-token']
    || req?.body?.setupToken
    || ''
).trim();

const getInitialSetupClientAddress = (req) => {
    const socketAddress = req?.socket?.remoteAddress || '';
    if (!isLoopbackAddress(socketAddress)) {
        return socketAddress;
    }

    // 仅信任来自本机反向代理的客户端地址，防止远程请求伪造转发头绕过校验。
    const forwardedAddress = String(req?.headers?.['x-forwarded-for'] || '')
        .split(',')[0]
        .trim();
    return forwardedAddress || req?.headers?.['x-real-ip'] || socketAddress;
};

const authorizeInitialSetup = (req) => {
    const configuredToken = getInitialSetupToken();
    const clientAddress = getInitialSetupClientAddress(req);
    if (isLoopbackAddress(clientAddress)) {
        return { allowed: true, mode: 'loopback' };
    }
    if (!configuredToken) {
        return {
            allowed: false,
            status: 403,
            error: '首次初始化仅允许从本机访问；远程初始化请配置 INITIAL_SETUP_TOKEN'
        };
    }
    if (!timingSafeEqualText(getPresentedSetupToken(req), configuredToken)) {
        return {
            allowed: false,
            status: 403,
            error: '首次初始化令牌无效'
        };
    }
    return { allowed: true, mode: 'token' };
};

module.exports = {
    authorizeInitialSetup,
    getInitialSetupClientAddress,
    getInitialSetupToken,
    isLoopbackAddress,
    normalizeRemoteAddress
};
