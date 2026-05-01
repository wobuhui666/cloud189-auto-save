/**
 * PT 站点搜索 handler: /pt_search
 */
const { send, edit, typing } = require('../messaging');
const { serializeCb, multiColumn } = require('../keyboards');
const { escapeHtml, bold, code } = require('../escape');
const { friendlyError } = require('../errors');
const { CB, SEARCH_TIMEOUT_MS } = require('../constants');

const PRESETS = [
    { key: 'anibt', label: 'AniBT' },
    { key: 'mikan', label: '蜜柑' },
    { key: 'animegarden', label: 'AnimeGarden' },
    { key: 'nyaa', label: 'Nyaa' },
    { key: 'dmhy', label: '动漫花园' },
];

// ─── /pt_search ───
async function handlePtSearch(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    if (session.ptSearch.active) {
        await send(svc.bot, chatId, '当前已处于 PT 搜索模式，请直接输入关键词\n输入 /cancel 退出');
        return;
    }

    const buttons = PRESETS.map(p => ({
        text: p.label,
        callback_data: serializeCb({ t: CB.PT_SEARCH_SITE, s: p.key }),
    }));
    const keyboard = multiColumn(buttons, 3);

    await send(svc.bot, chatId, '🔍 选择搜索站点：', { keyboard });
}

// ─── 站点选择回调 ───
async function handleSiteSelect(svc, chatId, messageId, preset) {
    const session = svc.sessionStore.get(chatId);
    session.ptSearch.active = true;
    session.ptSearch.preset = preset;
    session.ptSearch.results = [];
    session.ptSearch.groups = [];
    resetPtSearchTimeout(svc, chatId);

    const presetLabel = PRESETS.find(p => p.key === preset)?.label || preset;
    await edit(svc.bot, chatId, messageId,
        `已选择 ${bold(presetLabel)}\n\n请输入搜索关键词：\n\n` +
        '• 输入关键词搜索番剧\n' +
        '• /cancel 退出搜索模式\n' +
        '• 3分钟未操作将自动退出'
    );
}

// ─── PT 搜索模式下的消息处理 ───
async function handlePtSearchMessage(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    if (!session.ptSearch.active) return;

    const input = msg.text?.trim();
    if (!input) return;

    // 编号选择
    if (/^\d+$/.test(input)) {
        const index = parseInt(input);
        if (session.ptSearch.results.length > 0 && index >= 1 && index <= session.ptSearch.results.length) {
            const selected = session.ptSearch.results[index - 1];
            await handleResultSelect(svc, chatId, selected);
        } else if (session.ptSearch.groups.length > 0 && index >= 1 && index <= session.ptSearch.groups.length) {
            const group = session.ptSearch.groups[index - 1];
            await showRssResult(svc, chatId, group);
        } else {
            await send(svc.bot, chatId, '⚠️ 无效的编号');
        }
        return;
    }

    // 关键词搜索
    const { ptService } = require('../../ptService');
    const preset = session.ptSearch.preset;

    resetPtSearchTimeout(svc, chatId);
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '🔍 正在搜索...');

    try {
        const results = await ptService.searchSource(preset, input);
        if (!results || results.length === 0) {
            await edit(svc.bot, chatId, statusMsg?.message_id, '未找到相关资源');
            return;
        }

        session.ptSearch.results = results;

        // directRss 模式 (nyaa/dmhy): 直接显示 RSS 和字幕组
        if (results[0]?.directRss) {
            const r = results[0];
            let text = `搜索结果：${bold(escapeHtml(r.title))}\n\n`;

            if (r.preview?.length) {
                text += '最新资源预览：\n';
                r.preview.forEach(t => { text += `• ${escapeHtml(t)}\n`; });
                text += '\n';
            }

            if (r.groups?.length) {
                session.ptSearch.groups = r.groups;
                text += '可用字幕组（输入编号选择）：\n';
                r.groups.forEach((g, i) => {
                    text += `${i + 1}. ${escapeHtml(g.name)} (${g.itemCount} 个资源)\n`;
                });
            } else {
                text += `RSS 地址：\n${code(r.url)}`;
                session.ptSearch.active = false;
            }

            await edit(svc.bot, chatId, statusMsg?.message_id, text);
            return;
        }

        // 标准模式 (mikan/anibt/animegarden): 显示结果列表
        let text = '搜索结果：\n\n';
        results.forEach((r, i) => {
            text += `${i + 1}. ${escapeHtml(r.title)}\n`;
        });
        text += '\n输入编号选择番剧';

        await edit(svc.bot, chatId, statusMsg?.message_id, text);
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

// ─── 选择搜索结果后获取字幕组 ───
async function handleResultSelect(svc, chatId, result) {
    const { ptService } = require('../../ptService');
    const preset = result.source;

    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '🔍 正在获取字幕组...');

    try {
        const groups = await ptService.getSourceGroups(preset, { bgmId: result.id });
        if (!groups || groups.length === 0) {
            await edit(svc.bot, chatId, statusMsg?.message_id, '未找到字幕组');
            return;
        }

        const session = svc.sessionStore.get(chatId);
        session.ptSearch.groups = groups;

        // 只有一个字幕组时直接显示 RSS
        if (groups.length === 1) {
            await showRssResult(svc, chatId, groups[0], statusMsg?.message_id);
            return;
        }

        let text = `${bold(escapeHtml(result.title))}\n\n选择字幕组（输入编号）：\n\n`;
        groups.forEach((g, i) => {
            const extra = g.itemCount ? ` (${g.itemCount} 个资源)` : '';
            text += `${i + 1}. ${escapeHtml(g.name)}${extra}\n`;
        });

        await edit(svc.bot, chatId, statusMsg?.message_id, text);
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

// ─── 显示最终 RSS 结果 ───
async function showRssResult(svc, chatId, group, editMsgId) {
    const session = svc.sessionStore.get(chatId);
    session.ptSearch.active = false;
    if (session.ptSearch.timeoutRef) {
        clearTimeout(session.ptSearch.timeoutRef);
        session.ptSearch.timeoutRef = null;
    }

    const text = `✅ ${bold('RSS 地址')}：\n\n` +
        `站点：${escapeHtml(group.source)}\n` +
        `字幕组：${escapeHtml(group.name)}\n\n` +
        `${code(group.rssUrl)}\n\n` +
        '可在 PT 订阅中使用此 RSS 地址';

    if (editMsgId) {
        await edit(svc.bot, chatId, editMsgId, text);
    } else {
        await send(svc.bot, chatId, text);
    }
}

// ─── 辅助函数 ───

function resetPtSearchTimeout(svc, chatId) {
    const session = svc.sessionStore.get(chatId);
    if (session.ptSearch.timeoutRef) {
        clearTimeout(session.ptSearch.timeoutRef);
    }
    session.ptSearch.timeoutRef = setTimeout(async () => {
        if (session.ptSearch.active) {
            session.ptSearch.active = false;
            session.ptSearch.results = [];
            session.ptSearch.groups = [];
            session.ptSearch.timeoutRef = null;
            await send(svc.bot, chatId, '⏰ 长时间未操作，已自动退出 PT 搜索模式');
        }
    }, SEARCH_TIMEOUT_MS);
}

module.exports = {
    handlePtSearch,
    handleSiteSelect,
    handlePtSearchMessage,
};
