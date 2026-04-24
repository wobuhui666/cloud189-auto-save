/**
 * 基础命令 handler: /help /accounts /cancel + 账号切换回调
 */
const { send, edit, deleteMsg } = require('../messaging');
const { helpText, desensitizeUsername } = require('../templates');
const { helpNavKeyboard, serializeCb } = require('../keyboards');
const { escapeHtml } = require('../escape');
const { CB } = require('../constants');

async function handleHelp(svc, msg) {
    const text = helpText();
    const keyboard = helpNavKeyboard();
    await send(svc.bot, msg.chat.id, text, { keyboard });
}

async function handleStart(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);
    const currentAccount = session.account.entity?.username
        ? `当前账号：${escapeHtml(desensitizeUsername(session.account.entity.username))}`
        : '当前尚未选择账号';
    const text = [
        '👋 欢迎使用天翼云盘 Telegram 机器人',
        '',
        currentAccount,
        '',
        '推荐你按这个顺序开始：',
        '1. /accounts 选择账号',
        '2. /fl 查看常用目录',
        '3. 直接发送 cloud.189.cn 分享链接创建任务',
        '4. /search_cs 搜索 CloudSaver 资源',
        '5. /tasks 查看当前任务',
        '',
        '常用快捷命令：',
        '/help /tasks /stats /logs /subs',
    ].join('\n');
    const keyboard = helpNavKeyboard();
    await send(svc.bot, chatId, text, { keyboard });
}

async function handleAccounts(svc, msg) {
    await showAccounts(svc, msg.chat.id);
}

async function showAccounts(svc, chatId, messageId = null) {
    const accounts = await svc.accountRepo.find();
    const session = svc.sessionStore.get(chatId);

    const keyboard = accounts.map(account => [{
        text: `${desensitizeUsername(account.username)} ${account.id === session.account.id ? '✅' : ''}`,
        callback_data: serializeCb({
            t: CB.SET_ACCOUNT,
            i: account.id,
            a: desensitizeUsername(account.username),
        }),
    }]);

    const message = '账号列表 (✅表示当前选中账号):';
    if (messageId) {
        await edit(svc.bot, chatId, messageId, message, { keyboard });
    } else {
        await send(svc.bot, chatId, message, { keyboard });
    }
}

async function handleSetAccount(svc, chatId, data, messageId) {
    const session = svc.sessionStore.get(chatId);
    const accountId = data.i;

    if (session.account.id === accountId) {
        await send(svc.bot, chatId, `账号 [${escapeHtml(data.a)}] 已被选中`);
        await deleteMsg(svc.bot, chatId, messageId);
        return;
    }

    const account = await svc.accountRepo.findOneBy({ id: accountId });
    if (!account) {
        await send(svc.bot, chatId, '未找到该账号');
        return;
    }

    session.account.id = accountId;
    session.account.entity = account;

    // 持久化 tgBotActive 标记
    account.tgBotActive = true;
    svc.accountRepo.save(account).catch(() => {});

    await deleteMsg(svc.bot, chatId, messageId);
    await send(svc.bot, chatId, `已选择账号: ${escapeHtml(desensitizeUsername(account.username))}`);
}

async function handleCancel(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    // 清除搜索模式
    if (session.search.timeoutRef) {
        clearTimeout(session.search.timeoutRef);
        session.search.timeoutRef = null;
    }
    session.search.active = false;
    session.search.resultMap.clear();

    // 清除待分享
    session.pendingShare.link = null;
    session.pendingShare.accessCode = null;

    // 清除 UI 按钮消息
    if (session.ui.lastButtonMsgId) {
        await deleteMsg(svc.bot, chatId, session.ui.lastButtonMsgId);
        session.ui.lastButtonMsgId = null;
    }

    await send(svc.bot, chatId, '已取消当前操作');
}

async function handleHelpNav(svc, chatId, view, messageId) {
    switch (view) {
        case 'tasks':
            const tasksHandler = require('./tasks');
            await tasksHandler.handleTaskPage(svc, chatId, 1);
            break;
        case 'search':
            await send(svc.bot, chatId, '请使用 /search_cs 进入搜索模式');
            break;
        case 'folders':
            const foldersHandler = require('./folders');
            await foldersHandler.handleCommonFolders(svc, { chat: { id: chatId } });
            break;
        case 'stats':
            const statsHandler = require('./stats');
            await statsHandler.handleStats(svc, { chat: { id: chatId } });
            break;
    }
}

module.exports = {
    handleHelp,
    handleStart,
    handleAccounts,
    showAccounts,
    handleSetAccount,
    handleCancel,
    handleHelpNav,
};
