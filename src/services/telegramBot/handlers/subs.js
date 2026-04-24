/**
 * 订阅 handler: /subs（新功能）
 */
const { send, edit, typing } = require('../messaging');
const { escapeHtml, bold } = require('../escape');
const { paginationRow } = require('../keyboards');
const { friendlyError } = require('../errors');
const { CB } = require('../constants');

async function handleSubs(svc, msg) {
    await handleSubsPage(svc, msg.chat.id, 1);
}

async function handleSubsPage(svc, chatId, page = 1, messageId = null) {
    if (!svc.subscriptionRepo) {
        await send(svc.bot, chatId, '📭 订阅功能未启用');
        return;
    }

    await typing(svc.bot, chatId);

    try {
        const pageSize = 5;
        const skip = (page - 1) * pageSize;

        const [subs, total] = await svc.subscriptionRepo.findAndCount({
            order: { updatedAt: 'DESC' },
            take: pageSize,
            skip,
        });

        if (total === 0) {
            await send(svc.bot, chatId, '📭 暂无订阅');
            return;
        }

        const totalPages = Math.ceil(total / pageSize);

        let text = `📡 ${bold('订阅列表')} (第${page}页，共${total}个)\n\n`;
        subs.forEach((sub, i) => {
            const status = sub.enabled ? '✅ 启用' : '❌ 禁用';
            const refreshStatus = sub.lastRefreshStatus || 'unknown';
            const refreshTime = sub.lastRefreshTime
                ? new Date(sub.lastRefreshTime).toLocaleString('zh-CN')
                : '-';
            text += `${skip + i + 1}. ${bold(escapeHtml(sub.name))}\n` +
                `   状态：${status}\n` +
                `   UUID：<code>${escapeHtml(sub.uuid)}</code>\n` +
                `   刷新状态：${escapeHtml(refreshStatus)}\n` +
                `   最后刷新：${escapeHtml(refreshTime)}\n` +
                `   有效/失效资源：${sub.validResourceCount || 0}/${sub.invalidResourceCount || 0}\n` +
                `   可用/总账号：${sub.availableAccountCount || 0}/${sub.totalAccountCount || 0}\n\n`;
        });

        const keyboard = [];
        const pageRow = paginationRow(CB.SUBS_PAGE, page, totalPages);
        if (pageRow.length > 0) keyboard.push(pageRow);

        if (messageId) {
            await edit(svc.bot, chatId, messageId, text, { keyboard });
        } else {
            await send(svc.bot, chatId, text, { keyboard });
        }
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = { handleSubs, handleSubsPage };
