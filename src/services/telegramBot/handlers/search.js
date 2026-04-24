/**
 * 搜索相关 handler: /search_cs + 搜索模式 onMessage + /tmdb
 */
const { send, edit, typing, sendPhoto, deleteMsg } = require('../messaging');
const { searchResults } = require('../templates');
const { escapeHtml, bold, link } = require('../escape');
const { friendlyError } = require('../errors');
const { SEARCH_TIMEOUT_MS } = require('../constants');

// ─── /search_cs ───
async function handleSearchMode(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    if (session.search.active) {
        await send(svc.bot, chatId, '当前已处于搜索模式，请直接输入关键字搜索资源\n输入 /cancel 退出搜索模式');
        return;
    }

    if (!svc.checkAccount(chatId)) {
        await send(svc.bot, chatId, '请先使用 /accounts 选择账号');
        return;
    }

    if (!svc.cloudSaverSdk.enabled) {
        await send(svc.bot, chatId, '未开启CloudSaver，请先在网页端配置CloudSaver');
        return;
    }

    session.search.active = true;
    resetSearchTimeout(svc, chatId);

    await send(svc.bot, chatId,
        '🔍 已进入搜索模式\n\n' +
        '• 输入关键字搜索资源\n' +
        '• 输入编号转存资源\n' +
        '• /cancel 退出搜索模式\n' +
        '• 3分钟未操作将自动退出'
    );
}

// ─── 搜索模式下的消息处理 ───
async function handleSearchMessage(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    if (!session.search.active) return;

    const input = msg.text?.trim();
    if (!input) return;

    // 判断是否为编号选择
    if (/^\d+$/.test(input)) {
        const index = parseInt(input);
        const cacheShareLink = session.search.resultMap.get(index);
        if (!cacheShareLink) {
            await send(svc.bot, chatId, '⚠️ 无效的编号，请输入搜索结果中的序号');
            return;
        }
        try {
            const { url: shareLink, accessCode } = svc.cloud189Utils.parseCloudShare(cacheShareLink);
            const shareHandler = require('./share');
            await shareHandler.processShareLink(svc, chatId, shareLink, accessCode);
        } catch (e) {
            await send(svc.bot, chatId, friendlyError(e));
        }
        return;
    }

    // 关键字搜索
    resetSearchTimeout(svc, chatId);
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '🔍 正在搜索...');

    try {
        const result = await svc.cloudSaverSdk.search(input);
        if (result.length <= 0) {
            await edit(svc.bot, chatId, statusMsg?.message_id, '未找到相关资源');
            return;
        }

        // 缓存结果
        session.search.resultMap.clear();
        result.forEach((item, index) => {
            session.search.resultMap.set(index + 1, item.cloudLinks[0].link);
        });

        const text = searchResults(result);
        await edit(svc.bot, chatId, statusMsg?.message_id, `搜索结果：\n\n${text}`);
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

// ─── /tmdb ───
async function handleTmdb(svc, msg, input) {
    const chatId = msg.chat.id;

    let title, year;
    const yearMatch = input.match(/^(.+?)(?:\s+(\d{4}))?$/);
    if (yearMatch) {
        title = yearMatch[1].trim();
        year = yearMatch[2];
    }

    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '🔍 正在搜索...');

    try {
        const results = await svc.tmdbService.search(title, year);
        let responseText = '';

        const firstPoster = results.movies[0]?.posterPath || results.tvShows[0]?.posterPath;

        if (results.movies.length > 0) {
            responseText += `📽 ${bold('电影')}：\n\n`;
            results.movies.forEach(movie => {
                const shortOverview = movie.overview
                    ? (movie.overview.length > 20 ? movie.overview.substring(0, 20) + '...' : movie.overview)
                    : '暂无';
                responseText += `标题：${escapeHtml(movie.title)}\n` +
                    `原标题：${escapeHtml(movie.originalTitle)}\n` +
                    `上映日期：${escapeHtml(movie.releaseDate)}\n` +
                    `评分：${movie.voteAverage}\n` +
                    `简介：${escapeHtml(shortOverview)}\n\n`;
            });
        }

        if (results.tvShows.length > 0) {
            responseText += `📺 ${bold('剧集')}：\n\n`;
            results.tvShows.forEach(show => {
                const shortOverview = show.overview
                    ? (show.overview.length > 20 ? show.overview.substring(0, 20) + '...' : show.overview)
                    : '暂无';
                responseText += `标题：${escapeHtml(show.title)}\n` +
                    `原标题：${escapeHtml(show.originalTitle)}\n` +
                    `首播日期：${escapeHtml(show.releaseDate)}\n` +
                    `评分：${show.voteAverage}\n` +
                    `简介：${escapeHtml(shortOverview)}\n\n`;
            });
        }

        if (!results.movies.length && !results.tvShows.length) {
            responseText = '未找到相关影视信息';
        }

        await deleteMsg(svc.bot, chatId, statusMsg?.message_id);
        if (firstPoster) {
            await sendPhoto(svc.bot, chatId, firstPoster, responseText);
        } else {
            await send(svc.bot, chatId, responseText);
        }
    } catch (error) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(error));
    }
}

// ─── 辅助函数 ───

function resetSearchTimeout(svc, chatId) {
    const session = svc.sessionStore.get(chatId);
    if (session.search.timeoutRef) {
        clearTimeout(session.search.timeoutRef);
    }
    session.search.timeoutRef = setTimeout(async () => {
        if (session.search.active) {
            session.search.active = false;
            session.search.resultMap.clear();
            session.search.timeoutRef = null;
            await send(svc.bot, chatId, '⏰ 长时间未搜索，已自动退出搜索模式');
        }
    }, SEARCH_TIMEOUT_MS);
}

module.exports = {
    handleSearchMode,
    handleSearchMessage,
    handleTmdb,
};
