/**
 * 自动追剧 handler: /series /lazy_series
 */
const { send, edit, typing } = require('../messaging');
const { escapeHtml, bold } = require('../escape');
const { friendlyError } = require('../errors');

async function handleSeries(svc, msg, input, mode = 'normal') {
    const chatId = msg.chat.id;
    const normalizedInput = String(input || '').trim();

    if (!normalizedInput) {
        const cmd = mode === 'lazy' ? '/lazy_series' : '/series';
        await send(svc.bot, chatId, `请输入剧名，格式：${cmd} 剧名 [年份]`);
        return;
    }

    const { title, year } = parseTitleAndYear(normalizedInput);
    const statusText = mode === 'lazy'
        ? '⏳ 开始自动追剧(懒转存STRM)...'
        : '⏳ 开始自动追剧(正常任务)...';

    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, statusText);

    try {
        const result = await svc.autoSeriesService.createByTitle({ title, year, mode });
        const resultText = mode === 'lazy'
            ? `✅ 懒转存STRM已生成\n剧名：${escapeHtml(result.taskName)}\n资源：${escapeHtml(result.resourceTitle)}\n文件数：${result.fileCount || 0}`
            : `✅ 自动追剧已完成\n剧名：${escapeHtml(result.taskName)}\n资源：${escapeHtml(result.resourceTitle)}\n任务数：${result.taskCount || 0}`;
        await edit(svc.bot, chatId, statusMsg?.message_id, resultText);
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

function parseTitleAndYear(input) {
    const yearMatch = String(input || '').match(/^(.+?)(?:\s+(\d{4}))?$/);
    if (!yearMatch) {
        return { title: String(input || '').trim(), year: '' };
    }
    return {
        title: String(yearMatch[1] || '').trim(),
        year: String(yearMatch[2] || '').trim(),
    };
}

module.exports = { handleSeries };
