/**
 * PT 订阅管理 handler: /pt_subs, /pt_detail_<ID>, /pt_refresh_<ID>, /pt_toggle_<ID>, /pt_releases_<ID>
 */
const { send, edit, typing } = require('../messaging');
const { escapeHtml, bold, code } = require('../escape');
const { paginationRow, ptSubActionRow, ptReleaseActionRow, serializeCb } = require('../keyboards');
const { friendlyError } = require('../errors');
const { CB } = require('../constants');
const { ptSubCard, ptReleaseCard, ptStatusFormat } = require('../templates');
const { getPtSubscriptionRepository, getPtReleaseRepository } = require('../../../database');

function parseMissingEpisodes(sub) {
    try {
        const parsed = JSON.parse(sub.missingEpisodesJson || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch (_) {
        return [];
    }
}

// ─── /pt_subs ───
async function handlePtSubs(svc, msg) {
    await handlePtSubsPage(svc, msg.chat.id, 1);
}

// ─── PT 订阅列表分页 ───
async function handlePtSubsPage(svc, chatId, page = 1, messageId = null) {
    await typing(svc.bot, chatId);

    try {
        const repo = getPtSubscriptionRepository();
        const pageSize = 5;
        const skip = (page - 1) * pageSize;

        const [subs, total] = await repo.findAndCount({
            order: { id: 'DESC' },
            take: pageSize,
            skip,
        });

        if (total === 0) {
            await send(svc.bot, chatId, '📭 暂无 PT 订阅');
            return;
        }

        const totalPages = Math.ceil(total / pageSize);

        let text = `📡 ${bold('PT 订阅列表')} (第${page}页，共${total}个)\n\n`;
        subs.forEach((sub, i) => {
            text += ptSubCard(sub, skip + i + 1) + '\n\n';
        });

        const keyboard = [];
        const pageRow = paginationRow(CB.PT_SUB_PAGE, page, totalPages);
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

// ─── /pt_detail_<ID> ───
async function handlePtDetail(svc, msg, subId) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        const repo = getPtSubscriptionRepository();
        const releaseRepo = getPtReleaseRepository();

        const sub = await repo.findOneBy({ id: Number(subId) });
        if (!sub) {
            await send(svc.bot, chatId, '⚠️ 订阅不存在');
            return;
        }

        // 获取最近 5 条 release
        const releases = await releaseRepo.find({
            where: { subscriptionId: sub.id },
            order: { id: 'DESC' },
            take: 5,
        });

        const status = sub.enabled ? '✅ 启用' : '❌ 禁用';
        const lastCheck = sub.lastCheckTime
            ? new Date(sub.lastCheckTime).toLocaleString('zh-CN')
            : '从未';
        const lastStatus = sub.lastStatus === 'ok' ? '✅ 正常' : sub.lastStatus === 'error' ? '❌ 异常' : '未知';
        const lastMsg = sub.lastMessage ? escapeHtml(sub.lastMessage.substring(0, 200)) : '-';
        const missing = parseMissingEpisodes(sub);

        let text = `📡 ${bold('PT 订阅详情')}\n\n` +
            `🆔 ID：${sub.id}\n` +
            `📛 名称：${bold(escapeHtml(sub.name))}\n` +
            `📡 来源：${escapeHtml(sub.sourcePreset)}\n` +
            `🔗 RSS：${code(escapeHtml(sub.rssUrl || '-'))}\n` +
            `📂 目标：${escapeHtml(sub.targetFolder || sub.targetFolderId)}\n` +
            `🔘 状态：${status}\n` +
            `🧩 季集去重：${sub.episodeDedup ? '✅ 开启' : '❌ 关闭'}\n` +
            `🧬 多字幕组共存：${sub.coexist ? '✅ 开启' : '❌ 关闭'}\n` +
            `🆕 只下最新批次：${sub.downloadNew ? '✅ 开启' : '❌ 关闭'}\n` +
            `🌐 全局排除：${sub.globalExclude !== false ? '✅ 开启' : '❌ 关闭'}\n` +
            `🕐 最后检查：${escapeHtml(lastCheck)}\n` +
            `📊 检查结果：${lastStatus}\n` +
            `💬 最后消息：${lastMsg}\n` +
            `📦 Release 数：${sub.releaseCount || 0}\n`;

        if (sub.standbyRssJson) {
            text += `🧷 备用 RSS：已配置\n`;
        }
        if (sub.delayedDownloadMinutes > 0) {
            text += `⏳ 延迟下载：${sub.delayedDownloadMinutes} 分钟\n`;
        }
        if (sub.notDownloadEpisodes) {
            text += `🚫 不下载集数：${code(escapeHtml(sub.notDownloadEpisodes))}\n`;
        }
        if (sub.skipHalfEpisode) {
            text += `🚫 跳过 .5 集：✅ 开启\n`;
        }
        if (sub.customEpisode) {
            text += `🔢 自定义集数：${code(escapeHtml(sub.customEpisodeRegex || '-'))} #${sub.customEpisodeGroupIndex || 1}\n`;
        }
        if (sub.totalEpisodeNumber > 0) {
            text += `📈 进度：${sub.currentEpisodeNumber || 0}/${sub.totalEpisodeNumber}${sub.autoDisabled ? '（满集自动停用）' : ''}\n`;
        }
        if (missing.length > 0) {
            text += `⚠️ 缺集：${escapeHtml(missing.slice(0, 20).join(', '))}${missing.length > 20 ? '...' : ''}\n`;
        }

        if (sub.includePattern) {
            text += `✅ 包含正则：${code(escapeHtml(sub.includePattern))}\n`;
        }
        if (sub.excludePattern) {
            text += `❌ 排除正则：${code(escapeHtml(sub.excludePattern))}\n`;
        }

        if (releases.length > 0) {
            text += `\n📋 ${bold('最近 Release')}\n\n`;
            releases.forEach((rel, i) => {
                text += ptReleaseCard(rel, i + 1) + '\n\n';
            });
        }

        const keyboard = [ptSubActionRow(sub.id, sub.enabled)];

        await send(svc.bot, chatId, text, { keyboard });
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── /pt_refresh_<ID> ───
async function handlePtRefresh(svc, msg, subId) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        const { ptService } = require('../../ptService');
        const result = await ptService.runPoll(Number(subId));
        const count = result?.processed ?? 0;
        await send(svc.bot, chatId, `✅ 刷新完成，本次新增 ${count} 条 release`);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── PT 订阅启用/禁用回调 ───
async function handlePtToggle(svc, chatId, subId, messageId) {
    try {
        const repo = getPtSubscriptionRepository();
        const sub = await repo.findOneBy({ id: Number(subId) });
        if (!sub) {
            await edit(svc.bot, chatId, messageId, '⚠️ 订阅不存在');
            return;
        }

        sub.enabled = !sub.enabled;
        await repo.save(sub);

        const status = sub.enabled ? '✅ 已启用' : '❌ 已禁用';
        await edit(svc.bot, chatId, messageId, `${status}：${bold(escapeHtml(sub.name))}`);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── PT 订阅刷新回调 ───
async function handlePtRefreshCb(svc, chatId, subId, messageId) {
    try {
        const { ptService } = require('../../ptService');
        await edit(svc.bot, chatId, messageId, '🔄 正在刷新...');
        const result = await ptService.runPoll(Number(subId));
        const count = result?.processed ?? 0;
        await edit(svc.bot, chatId, messageId, `✅ 刷新完成，本次新增 ${count} 条 release`);
    } catch (error) {
        await edit(svc.bot, chatId, messageId, friendlyError(error));
    }
}

// ─── /pt_releases_<ID> ───
async function handlePtReleases(svc, msg, subId) {
    await handlePtReleasesPage(svc, msg.chat.id, Number(subId), 1);
}

// ─── Release 列表分页 ───
async function handlePtReleasesPage(svc, chatId, subId, page = 1, messageId = null) {
    await typing(svc.bot, chatId);

    try {
        const repo = getPtSubscriptionRepository();
        const releaseRepo = getPtReleaseRepository();

        const sub = await repo.findOneBy({ id: Number(subId) });
        if (!sub) {
            await send(svc.bot, chatId, '⚠️ 订阅不存在');
            return;
        }

        const pageSize = 5;
        const skip = (page - 1) * pageSize;

        const [releases, total] = await releaseRepo.findAndCount({
            where: { subscriptionId: sub.id },
            order: { id: 'DESC' },
            take: pageSize,
            skip,
        });

        if (total === 0) {
            await send(svc.bot, chatId, `📭 ${bold(escapeHtml(sub.name))} 暂无 release`);
            return;
        }

        const totalPages = Math.ceil(total / pageSize);

        let text = `📋 ${bold(escapeHtml(sub.name))} Releases (第${page}页，共${total}个)\n\n`;
        releases.forEach((rel, i) => {
            text += ptReleaseCard(rel, skip + i + 1) + '\n';
            // 操作按钮用命令链接
            if (rel.status === 'failed' || rel.status === 'upload_failed') {
                text += `   🔁 重试：/pt_retry_${rel.id}  🗑 删除：/pt_del_${rel.id}\n`;
            }
            text += '\n';
        });

        const keyboard = [];
        const pageRow = paginationRow(CB.PT_RELEASE_PAGE, page, totalPages);
        if (pageRow.length > 0) keyboard.push(pageRow);

        // 存储 subId 到分页回调中
        if (messageId) {
            await edit(svc.bot, chatId, messageId, text, { keyboard });
        } else {
            await send(svc.bot, chatId, text, { keyboard });
        }
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── Release 重试 ───
async function handlePtReleaseRetry(svc, msg, releaseId) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        const { ptService } = require('../../ptService');
        await ptService.retryRelease(Number(releaseId));
        await send(svc.bot, chatId, `✅ Release ${releaseId} 已重试`);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── Release 删除 ───
async function handlePtReleaseDelete(svc, msg, releaseId) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        const { ptService } = require('../../ptService');
        await ptService.deleteRelease(Number(releaseId), true);
        await send(svc.bot, chatId, `🗑 Release ${releaseId} 已删除`);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = {
    handlePtSubs,
    handlePtSubsPage,
    handlePtDetail,
    handlePtRefresh,
    handlePtToggle,
    handlePtRefreshCb,
    handlePtReleases,
    handlePtReleasesPage,
    handlePtReleaseRetry,
    handlePtReleaseDelete,
};
