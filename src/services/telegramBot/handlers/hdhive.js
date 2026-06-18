/**
 * 影巢相关 handler: /hdhive + 搜索模式 onMessage + 解锁确认 + /hdhive_checkin
 */
const { send, edit, typing } = require('../messaging');
const { escapeHtml, bold, link, code } = require('../escape');
const { friendlyError } = require('../errors');
const { serializeCb, hdhiveSearchKeyboard, hdhiveResourceKeyboard } = require('../keyboards');
const { CB, SEARCH_TIMEOUT_MS } = require('../constants');

function clearHdhiveTimeout(session) {
    if (session.hdhive.timeoutRef) {
        clearTimeout(session.hdhive.timeoutRef);
        session.hdhive.timeoutRef = null;
    }
}

function clearHdhiveState(session) {
    clearHdhiveTimeout(session);
    session.hdhive.active = false;
    session.hdhive.mode = 'search';
    session.hdhive.keyword = '';
    session.hdhive.results = [];
    session.hdhive.resources = [];
    session.hdhive.selectedItem = null;
}

function resetHdhiveTimeout(svc, chatId) {
    const session = svc.sessionStore.get(chatId);
    clearHdhiveTimeout(session);
    session.hdhive.timeoutRef = setTimeout(async () => {
        if (!session.hdhive.active) {
            return;
        }
        clearHdhiveState(session);
        await send(svc.bot, chatId, '⏰ 长时间未操作，已自动退出影巢搜索模式');
    }, SEARCH_TIMEOUT_MS);
}

function clearConflictingModes(session) {
    if (session.search.timeoutRef) {
        clearTimeout(session.search.timeoutRef);
        session.search.timeoutRef = null;
    }
    session.search.active = false;
    session.search.resultMap.clear();

    if (session.ptSearch.timeoutRef) {
        clearTimeout(session.ptSearch.timeoutRef);
        session.ptSearch.timeoutRef = null;
    }
    session.ptSearch.active = false;
    session.ptSearch.preset = null;
    session.ptSearch.results = [];
    session.ptSearch.groups = [];
}

function getResourcePoints(resource) {
    return typeof resource?.points === 'number' && Number.isFinite(resource.points)
        ? resource.points
        : null;
}

function formatResourceCost(resource) {
    if (resource?.isFree) return '免费';
    const points = getResourcePoints(resource);
    return points === null ? '积分未知' : `${points} 积分`;
}

function formatSearchItem(item, index) {
    const tags = [];
    if (item.shareLink) {
        tags.push('直链');
    } else if (item.tmdbId && ['movie', 'tv'].includes(item.type)) {
        tags.push('查天翼');
    } else if (item.pageUrl) {
        tags.push('详情');
    }
    if (item.source === 'tmdb') {
        tags.push('TMDB');
    }
    if (item.videoResolution) {
        tags.push(item.videoResolution);
    }
    if (item.year) {
        tags.push(item.year);
    }

    const meta = tags.length > 0 ? `\n   ${escapeHtml(tags.join(' · '))}` : '';
    const line = item.pageUrl
        ? link(item.title || `结果 ${index}`, item.pageUrl)
        : escapeHtml(item.title || `结果 ${index}`);
    return `${index}. ${line}${meta}`;
}

function formatSearchResults(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    const lines = [
        `🎬 ${bold('影巢搜索结果')}`,
        '',
        `共找到 ${items.length} 个结果，输入编号继续`,
    ];

    if (result?.warning) {
        lines.push(`提示：${escapeHtml(result.warning)}`);
    }
    if (result?.loginRequired) {
        lines.push('提示：当前影巢搜索页需要有效 Cookie，部分结果可能无法展开详情');
    }
    lines.push('');
    lines.push(...items.map((item, index) => formatSearchItem(item, index + 1)));
    lines.push('');
    lines.push('继续输入关键词可重新搜索，/cancel 退出');
    return lines.join('\n');
}

function normalizeDetailResources(item, detailData = {}) {
    const directLinks = Array.isArray(detailData.links) ? detailData.links : [];
    const resources = Array.isArray(detailData.resources) ? detailData.resources : [];
    const merged = [];
    const seen = new Set();

    directLinks.forEach((entry, index) => {
        const key = entry.shareLink || entry.link || `${item.id}:direct:${index}`;
        if (!key || seen.has(key)) {
            return;
        }
        seen.add(key);
        merged.push({
            id: `direct-${index + 1}`,
            slug: '',
            title: item.title || entry.title || `影巢分享 ${index + 1}`,
            cloudType: 'cloud189',
            cloudTypeName: '天翼云盘',
            sizeFormatted: '',
            points: 0,
            isFree: true,
            expired: false,
            quality: [],
            link: entry.shareLink || entry.link || '',
            code: entry.accessCode || entry.code || '',
            isUnlocked: true,
        });
    });

    resources.forEach((resource, index) => {
        const key = resource.slug || resource.id || resource.link || `${item.id}:resource:${index}`;
        if (!key || seen.has(key)) {
            return;
        }
        seen.add(key);
        merged.push(resource);
    });

    return merged;
}

function formatResourceItem(resource, index) {
    const tags = [];
    if (resource.isUnlocked || resource.link) {
        tags.push('已解锁');
    }
    if (resource.isFree) {
        tags.push('免费');
    } else {
        tags.push(formatResourceCost(resource));
    }
    if (resource.sizeFormatted && resource.sizeFormatted !== '未知') {
        tags.push(resource.sizeFormatted);
    }
    if (Array.isArray(resource.quality) && resource.quality.length > 0) {
        tags.push(resource.quality.join('/'));
    }
    if (resource.expired) {
        tags.push('疑似失效');
    }

    return `${index}. ${escapeHtml(resource.title || `资源 ${index}`)}\n   ${escapeHtml(tags.join(' · '))}`;
}

function formatResourcesText(item, resources, extraMessage = '') {
    const lines = [
        `📦 ${bold(item?.title || '影巢资源')}`,
        '',
        `找到 ${resources.length} 个天翼资源，输入编号转存或解锁`,
    ];
    if (item?.tmdbId) {
        lines.push(`TMDB ID：${code(item.tmdbId)}`);
    }
    if (extraMessage) {
        lines.push(`提示：${escapeHtml(extraMessage)}`);
    }
    lines.push('');
    lines.push(...resources.map((resource, index) => formatResourceItem(resource, index + 1)));
    lines.push('');
    lines.push('继续输入关键词可重新搜索，/cancel 退出');
    return lines.join('\n');
}

function buildTaskOptions(item, resource) {
    return {
        taskName: item?.title || resource?.title || '',
        tmdbId: item?.tmdbId || '',
    };
}

async function fetchResourcesForItem(svc, item) {
    let fallbackWarning = '';

    if (item.tmdbId && ['movie', 'tv'].includes(item.type)) {
        const result = await svc.hdhiveSdk.getResources(item.type, item.tmdbId);
        if (result.success && Array.isArray(result.data) && result.data.length > 0) {
            return { success: true, data: result.data, message: '' };
        }
        if (!result.success) {
            fallbackWarning = result.error || '';
        }
        if (!item.pageUrl) {
            return result.success
                ? { success: false, error: '未找到可用天翼资源' }
                : result;
        }
    }

    if (item.pageUrl) {
        const detailResult = await svc.hdhiveSdk.detail(item.pageUrl);
        if (!detailResult.success) {
            return detailResult;
        }
        const resources = normalizeDetailResources(item, detailResult.data);
        if (resources.length > 0) {
            return {
                success: true,
                data: resources,
                message: fallbackWarning || (detailResult.data?.loginRequired ? '资源来自详情页解析' : '')
            };
        }
        const loginHint = detailResult.data?.loginRequired ? '影巢详情页需要有效 Cookie 才能看到资源' : '';
        return { success: false, error: fallbackWarning || loginHint || '未找到可用天翼资源' };
    }

    return { success: false, error: fallbackWarning || '该结果暂不支持查询天翼资源' };
}

async function handleHdhive(svc, msg, keyword) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    if (!svc.checkAccount(chatId)) {
        await send(svc.bot, chatId, '请先使用 /accounts 选择账号');
        return;
    }

    const status = svc.hdhiveSdk.getAuthStatus();
    if (!status.enabled) {
        await send(svc.bot, chatId, '未启用影巢，请先在网页端媒体设置中开启并配置影巢');
        return;
    }

    clearConflictingModes(session);
    session.hdhive.active = true;
    session.hdhive.mode = 'search';
    session.hdhive.keyword = '';
    session.hdhive.results = [];
    session.hdhive.resources = [];
    session.hdhive.selectedItem = null;
    resetHdhiveTimeout(svc, chatId);

    const normalizedKeyword = String(keyword || '').trim();
    if (!normalizedKeyword) {
        await send(svc.bot, chatId,
            '🎬 已进入影巢搜索模式\n\n' +
            '• 输入关键词搜索资源\n' +
            '• 输入编号继续查看天翼资源或直接转存\n' +
            '• /hdhive 关键字 可直接搜索\n' +
            '• /cancel 退出搜索模式\n' +
            '• 3分钟未操作将自动退出'
        );
        return;
    }

    await performHdhiveSearch(svc, chatId, normalizedKeyword);
}

async function performHdhiveSearch(svc, chatId, keyword, messageId = null) {
    const session = svc.sessionStore.get(chatId);
    session.hdhive.active = true;
    session.hdhive.mode = 'search';
    session.hdhive.keyword = keyword;
    session.hdhive.selectedItem = null;
    session.hdhive.resources = [];
    resetHdhiveTimeout(svc, chatId);

    await typing(svc.bot, chatId);
    const statusMsg = messageId
        ? { message_id: messageId }
        : await send(svc.bot, chatId, '🔍 正在搜索影巢资源...');

    try {
        const result = await svc.hdhiveSdk.search(keyword, 12);
        const items = Array.isArray(result?.items) ? result.items : [];
        session.hdhive.results = items;

        if (items.length === 0) {
            const text = result?.warning
                ? `未找到相关资源\n\n提示：${escapeHtml(result.warning)}`
                : '未找到相关资源';
            await edit(svc.bot, chatId, statusMsg?.message_id, text);
            return;
        }

        await edit(svc.bot, chatId, statusMsg?.message_id, formatSearchResults(result), {
            keyboard: hdhiveSearchKeyboard(items),
        });
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

async function handleHdhiveMessage(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);
    if (!session.hdhive.active) {
        return;
    }

    const input = String(msg.text || '').trim();
    if (!input) {
        return;
    }

    if (/^\d+$/.test(input)) {
        const index = Number(input);
        if (session.hdhive.mode === 'resource') {
            await handleResourceSelect(svc, chatId, index);
            return;
        }
        await handleSearchResultSelect(svc, chatId, index);
        return;
    }

    await performHdhiveSearch(svc, chatId, input);
}

async function handleSearchResultSelect(svc, chatId, index, messageId = null) {
    const session = svc.sessionStore.get(chatId);
    const item = session.hdhive.results[index - 1];
    if (!item) {
        if (messageId) {
            await edit(svc.bot, chatId, messageId, '⚠️ 无效的编号，请输入搜索结果中的序号');
        } else {
            await send(svc.bot, chatId, '⚠️ 无效的编号，请输入搜索结果中的序号');
        }
        return;
    }

    resetHdhiveTimeout(svc, chatId);

    if (item.shareLink) {
        clearHdhiveState(session);
        const shareHandler = require('./share');
        await shareHandler.processShareLink(
            svc,
            chatId,
            item.shareLink,
            item.accessCode,
            buildTaskOptions(item, null)
        );
        return;
    }

    await typing(svc.bot, chatId);
    const statusMsg = messageId
        ? { message_id: messageId }
        : await send(svc.bot, chatId, '🔍 正在查询影巢天翼资源...');

    if (messageId) {
        await edit(svc.bot, chatId, messageId, '🔍 正在查询影巢天翼资源...');
    }

    try {
        const result = await fetchResourcesForItem(svc, item);
        if (!result.success) {
            await edit(svc.bot, chatId, statusMsg?.message_id, `⚠️ ${escapeHtml(result.error || '未找到可用天翼资源')}`);
            return;
        }

        const resources = Array.isArray(result.data) ? result.data : [];
        if (resources.length === 0) {
            await edit(svc.bot, chatId, statusMsg?.message_id, '未找到可用天翼资源');
            return;
        }

        session.hdhive.mode = 'resource';
        session.hdhive.selectedItem = item;
        session.hdhive.resources = resources;
        await edit(svc.bot, chatId, statusMsg?.message_id, formatResourcesText(item, resources, result.message || ''), {
            keyboard: hdhiveResourceKeyboard(resources),
        });
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

async function handleResourceSelect(svc, chatId, index, messageId = null) {
    const session = svc.sessionStore.get(chatId);
    const item = session.hdhive.selectedItem;
    const resource = session.hdhive.resources[index - 1];

    if (!item || !resource) {
        const text = '⚠️ 无效的资源编号，请输入资源列表中的序号';
        if (messageId) {
            await edit(svc.bot, chatId, messageId, text);
        } else {
            await send(svc.bot, chatId, text);
        }
        return;
    }

    resetHdhiveTimeout(svc, chatId);

    if (resource.link) {
        clearHdhiveState(session);
        const shareHandler = require('./share');
        await shareHandler.processShareLink(
            svc,
            chatId,
            resource.link,
            resource.code,
            buildTaskOptions(item, resource)
        );
        return;
    }

    const points = getResourcePoints(resource);
    if (!resource.isFree && (points === null || points > 0)) {
        const message = points === null
            ? `确认解锁「${escapeHtml(resource.title)}」？\n\n该资源的积分消耗未知，继续后会尝试调用影巢解锁。`
            : `确认解锁「${escapeHtml(resource.title)}」？\n\n该操作会消耗 ${points} 积分。`;
        const keyboard = [
            [{ text: '继续解锁', callback_data: serializeCb({ t: CB.HDHIVE_UNLOCK, i: index, c: true }) }],
            [{ text: '取消', callback_data: serializeCb({ t: CB.HDHIVE_UNLOCK, i: index, c: false }) }],
        ];

        if (messageId) {
            await edit(svc.bot, chatId, messageId, message, { keyboard });
        } else {
            await send(svc.bot, chatId, message, { keyboard });
        }
        return;
    }

    await unlockResourceAndTransfer(svc, chatId, index, messageId);
}

async function unlockResourceAndTransfer(svc, chatId, index, messageId = null) {
    const session = svc.sessionStore.get(chatId);
    const item = session.hdhive.selectedItem;
    const resource = session.hdhive.resources[index - 1];

    if (!item || !resource) {
        const text = '⚠️ 未找到待解锁资源';
        if (messageId) {
            await edit(svc.bot, chatId, messageId, text);
        } else {
            await send(svc.bot, chatId, text);
        }
        return;
    }

    const slug = resource.slug || resource.id;
    if (!slug) {
        const text = '⚠️ 当前资源缺少解锁标识，无法继续';
        if (messageId) {
            await edit(svc.bot, chatId, messageId, text);
        } else {
            await send(svc.bot, chatId, text);
        }
        return;
    }

    if (messageId) {
        await edit(svc.bot, chatId, messageId, '⏳ 正在解锁影巢资源...');
    } else {
        await send(svc.bot, chatId, '⏳ 正在解锁影巢资源...');
    }

    try {
        const result = await svc.hdhiveSdk.unlockResource(slug);
        if (!result.success) {
            const text = `⚠️ ${escapeHtml(result.error || '资源解锁失败')}`;
            if (messageId) {
                await edit(svc.bot, chatId, messageId, text);
            } else {
                await send(svc.bot, chatId, text);
            }
            return;
        }

        const shareLink = result.data?.link || '';
        if (!shareLink) {
            const text = '⚠️ 解锁成功，但未返回天翼分享链接';
            if (messageId) {
                await edit(svc.bot, chatId, messageId, text);
            } else {
                await send(svc.bot, chatId, text);
            }
            return;
        }

        if (messageId) {
            await edit(svc.bot, chatId, messageId, '✅ 影巢资源已解锁，正在创建任务...');
        } else {
            await send(svc.bot, chatId, '✅ 影巢资源已解锁，正在创建任务...');
        }

        clearHdhiveState(session);
        const shareHandler = require('./share');
        await shareHandler.processShareLink(
            svc,
            chatId,
            shareLink,
            result.data?.code || '',
            buildTaskOptions(item, resource)
        );
    } catch (error) {
        const text = friendlyError(error);
        if (messageId) {
            await edit(svc.bot, chatId, messageId, text);
        } else {
            await send(svc.bot, chatId, text);
        }
    }
}

async function handleUnlockCallback(svc, chatId, data, messageId) {
    if (!data.c) {
        const session = svc.sessionStore.get(chatId);
        await edit(
            svc.bot,
            chatId,
            messageId,
            formatResourcesText(session.hdhive.selectedItem, session.hdhive.resources, '已取消解锁'),
            { keyboard: hdhiveResourceKeyboard(session.hdhive.resources) }
        );
        return;
    }
    await unlockResourceAndTransfer(svc, chatId, Number(data.i), messageId);
}

async function handleItemCallback(svc, chatId, data, messageId) {
    await handleSearchResultSelect(svc, chatId, Number(data.i), messageId);
}

async function handleResourceCallback(svc, chatId, data, messageId) {
    await handleResourceSelect(svc, chatId, Number(data.i), messageId);
}

async function handleCheckin(svc, msg) {
    const chatId = msg.chat.id;
    const status = svc.hdhiveSdk.getAuthStatus();
    if (!status.enabled) {
        await send(svc.bot, chatId, '未启用影巢，请先在网页端媒体设置中开启并配置影巢');
        return;
    }
    if (!status.signedCustomerApiAvailable) {
        await send(svc.bot, chatId, '影巢签到依赖 Browser Bridge 签名模式，请先配置 Browser Bridge');
        return;
    }

    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '⏳ 正在执行影巢签到...');
    try {
        const result = await svc.hdhiveSdk.checkinByBridge();
        if (!result.success) {
            await edit(svc.bot, chatId, statusMsg?.message_id, `⚠️ ${escapeHtml(result.message || result.error || '影巢签到失败')}`);
            return;
        }
        await edit(svc.bot, chatId, statusMsg?.message_id, `✅ ${escapeHtml(result.message || '影巢签到成功')}`);
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

module.exports = {
    clearHdhiveState,
    handleHdhive,
    handleHdhiveMessage,
    handleItemCallback,
    handleResourceCallback,
    handleUnlockCallback,
    handleCheckin,
};
