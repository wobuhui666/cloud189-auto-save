/**
 * 用户友好错误消息映射
 */

const ERROR_MAP = [
    { match: /folder already exists/i, msg: '该目录下已有同名文件夹' },
    { match: /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET/i, msg: '网络连接异常，请稍后重试' },
    { match: /timeout/i, msg: '操作超时，请稍后重试' },
    { match: /401|Unauthorized/i, msg: '认证失败，请检查账号状态' },
    { match: /403|Forbidden/i, msg: '无权限访问该资源' },
    { match: /404|Not Found/i, msg: '资源不存在或已失效' },
    { match: /429|Too Many/i, msg: '请求过于频繁，请稍后重试' },
    { match: /分享链接.*无效|invalid.*share/i, msg: '分享链接无效或已过期' },
    { match: /CloudSaverSDK.*登录失败/i, msg: 'CloudSaver 登录失败，请检查配置' },
    { match: /剧名不能为空/i, msg: '请输入剧名' },
];

/**
 * 将技术错误转换为用户友好文案
 * @param {Error|string} error
 * @returns {string}
 */
function friendlyError(error) {
    const msg = error instanceof Error ? error.message : String(error);
    for (const { match, msg: friendly } of ERROR_MAP) {
        if (match.test(msg)) {
            return `⚠️ ${friendly}`;
        }
    }
    // 截断过长的原始错误
    const truncated = msg.length > 100 ? msg.substring(0, 100) + '...' : msg;
    return `⚠️ 操作失败: ${truncated}`;
}

module.exports = { friendlyError };
