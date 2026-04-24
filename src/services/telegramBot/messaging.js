/**
 * 消息发送工具 —— 统一切片、HTML 格式、typing 反馈
 */
const { TG_LIMITS } = require('./constants');

/**
 * 将长文本切片为不超过 maxLen 的片段
 * 优先按段落(\n\n)切，其次按行(\n)切，最后硬切
 */
function splitForTelegram(text, maxLen = TG_LIMITS.SAFE_MESSAGE_LEN) {
    if (!text || text.length <= maxLen) return [text || ''];

    const parts = [];
    let remaining = text;

    while (remaining.length > maxLen) {
        let cutPos = -1;

        // 优先：段落分隔
        const paraIdx = remaining.lastIndexOf('\n\n', maxLen);
        if (paraIdx > 0) {
            cutPos = paraIdx;
        } else {
            // 其次：行分隔
            const lineIdx = remaining.lastIndexOf('\n', maxLen);
            if (lineIdx > 0) {
                cutPos = lineIdx;
            } else {
                // 兜底：硬切
                cutPos = maxLen;
            }
        }

        parts.push(remaining.substring(0, cutPos));
        remaining = remaining.substring(cutPos).replace(/^\n+/, '');
    }

    if (remaining.length > 0) {
        parts.push(remaining);
    }

    return parts;
}

/**
 * 发送消息（自动切片），键盘仅附加在最后一片
 */
async function send(bot, chatId, text, opts = {}) {
    const { keyboard, parseMode = 'HTML' } = opts;
    const parts = splitForTelegram(text);
    let lastMsg = null;

    for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        const options = { parse_mode: parseMode };
        if (isLast && keyboard) {
            options.reply_markup = { inline_keyboard: keyboard };
        }
        try {
            lastMsg = await bot.sendMessage(chatId, parts[i], options);
        } catch (err) {
            console.error('发送消息失败:', err.message);
        }
    }
    return lastMsg;
}

/**
 * 编辑消息文本
 */
async function edit(bot, chatId, messageId, text, opts = {}) {
    const { keyboard, parseMode = 'HTML' } = opts;
    const options = {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: parseMode,
    };
    if (keyboard) {
        options.reply_markup = { inline_keyboard: keyboard };
    }
    try {
        // 编辑消息不切片（TG editMessage 只能编辑单条）
        // 若超长则截断并加提示
        let safeText = text;
        if (text && text.length > TG_LIMITS.SAFE_MESSAGE_LEN) {
            safeText = text.substring(0, TG_LIMITS.SAFE_MESSAGE_LEN - 30) + '\n\n... (内容过长已截断)';
        }
        return await bot.editMessageText(safeText, options);
    } catch (err) {
        if (err.message && err.message.includes('message is not modified')) {
            return null;
        }
        console.error('编辑消息失败:', err.message);
        if (err.message && (
            err.message.includes('message to edit not found') ||
            err.message.includes("message can't be edited") ||
            err.message.includes('message identifier is not specified')
        )) {
            return await send(bot, chatId, text, { keyboard, parseMode });
        }
        return null;
    }
}

/**
 * 发送 typing 状态
 */
async function typing(bot, chatId) {
    try {
        await bot.sendChatAction(chatId, 'typing');
    } catch (_) {
        // 忽略
    }
}

/**
 * 安全删除消息
 */
async function deleteMsg(bot, chatId, messageId) {
    try {
        if (messageId) {
            await bot.deleteMessage(chatId, messageId);
        }
    } catch (_) {
        // 忽略
    }
}

/**
 * 发送带图片的消息
 */
async function sendPhoto(bot, chatId, photo, caption, opts = {}) {
    const { keyboard, parseMode = 'HTML' } = opts;
    const captionMax = 1000;
    const safeCaption = caption && caption.length > captionMax
        ? caption.substring(0, captionMax - 18) + '\n\n... (内容过长)'
        : caption;
    const restText = caption && caption.length > captionMax
        ? caption.substring(captionMax - 18)
        : '';
    const options = {
        caption: safeCaption,
        parse_mode: parseMode,
    };
    if (keyboard) {
        options.reply_markup = { inline_keyboard: keyboard };
    }
    try {
        const photoMsg = await bot.sendPhoto(chatId, photo, options);
        if (restText) {
            await send(bot, chatId, restText, { parseMode });
        }
        return photoMsg;
    } catch (err) {
        console.error('发送图片失败:', err.message);
        return await send(bot, chatId, caption, opts);
    }
}

module.exports = {
    splitForTelegram,
    send,
    edit,
    typing,
    deleteMsg,
    sendPhoto,
};
