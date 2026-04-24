/**
 * 权限校验 —— chatId 白名单 + admin 区分
 */

/**
 * 检查 chatId 是否在白名单中
 * @param {number|string} chatId
 * @param {object} botConfig  { chatId, allowedChatIds, adminChatIds }
 */
function isAllowed(chatId, botConfig) {
    const allowed = botConfig.allowedChatIds;
    if (Array.isArray(allowed) && allowed.length > 0) {
        return allowed.some(id => String(id) === String(chatId));
    }
    // 回退到单 chatId 兼容
    return String(chatId) === String(botConfig.chatId);
}

/**
 * 检查 chatId 是否是管理员
 */
function isAdmin(chatId, botConfig) {
    const admins = botConfig.adminChatIds;
    if (Array.isArray(admins) && admins.length > 0) {
        return admins.some(id => String(id) === String(chatId));
    }
    // 未配置 admin 列表时，所有允许的用户都是管理员
    return isAllowed(chatId, botConfig);
}

module.exports = { isAllowed, isAdmin };
