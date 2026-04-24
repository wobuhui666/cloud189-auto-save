/**
 * 分享链接处理 handler
 * 修复 bug: 搜索模式下分享链接优先于关键字处理
 */
const { send, typing } = require('../messaging');
const { escapeHtml, bold } = require('../escape');
const { friendlyError } = require('../errors');
const { serializeCb, truncateBtn } = require('../keyboards');
const { desensitizeUsername } = require('../templates');
const { CB } = require('../constants');

// ─── 分享链接消息入口 ───
async function handleShareLink(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    // 修复 bug #3: 搜索模式下也应处理分享链接（而不是跳过）
    // 退出搜索模式再处理
    if (session.search.active) {
        session.search.active = false;
        if (session.search.timeoutRef) {
            clearTimeout(session.search.timeoutRef);
            session.search.timeoutRef = null;
        }
        session.search.resultMap.clear();
        await send(svc.bot, chatId, '检测到分享链接，已自动退出搜索模式');
    }

    if (!svc.checkAccount(chatId)) {
        await send(svc.bot, chatId, '请先使用 /accounts 选择账号');
        return;
    }

    try {
        const { url: shareLink, accessCode } = svc.cloud189Utils.parseCloudShare(msg.text);
        await processShareLink(svc, chatId, shareLink, accessCode);
    } catch (error) {
        console.log(error);
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── 处理分享链接（供搜索编号选择复用） ───
async function processShareLink(svc, chatId, shareLink, accessCode) {
    const session = svc.sessionStore.get(chatId);

    const folders = await svc.commonFolderRepo.find({
        where: { accountId: session.account.id },
    });

    if (folders.length === 0) {
        const keyboard = [[{
            text: '📁 添加常用目录',
            callback_data: serializeCb({ t: CB.FOLDER_DRILL, f: '-11' }),
        }]];
        const username = desensitizeUsername(session.account.entity?.username);
        const message = `当前账号: ${escapeHtml(username)}\n未找到常用目录，请添加常用目录`;
        await send(svc.bot, chatId, message, { keyboard });
        return;
    }

    // 缓存分享信息到会话
    session.pendingShare.link = shareLink;
    session.pendingShare.accessCode = accessCode;

    // 解析链接获取资源名
    await typing(svc.bot, chatId);
    let taskName = '';
    try {
        const shareFolders = await svc.taskService.parseShareFolderByShareLink(
            shareLink, session.account.id, accessCode
        );
        taskName = shareFolders[0].name;
    } catch (e) {
        await send(svc.bot, chatId, friendlyError(e));
        return;
    }

    const keyboard = folders.map(folder => [{
        text: truncateBtn(folder.path.length > 30
            ? '.../' + folder.path.split('/').slice(-2).join('/')
            : folder.path),
        callback_data: serializeCb({
            t: CB.FOLDER_SELECT,
            f: folder.id,
        }),
    }]);

    const username = desensitizeUsername(session.account.entity?.username);
    const message = `当前账号: ${escapeHtml(username)}\n` +
        `资源名称: ${bold(taskName)}\n` +
        `请选择保存目录:`;

    const msg = await send(svc.bot, chatId, message, { keyboard });
    session.ui.lastButtonMsgId = msg?.message_id || null;
}

module.exports = {
    handleShareLink,
    processShareLink,
};
