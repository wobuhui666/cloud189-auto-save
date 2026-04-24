/**
 * 目录相关 handler: /fl /fs /df + 目录树浏览 + 保存常用目录
 */
const { send, edit, typing, deleteMsg } = require('../messaging');
const { commonFolderList, desensitizeUsername } = require('../templates');
const { folderKeyboard, serializeCb } = require('../keyboards');
const { escapeHtml } = require('../escape');
const { friendlyError } = require('../errors');
const { CB } = require('../constants');

// ─── /fl ───
async function handleCommonFolders(svc, msg) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    const folders = await svc.commonFolderRepo.find({
        where: { accountId: session.account.id },
        order: { path: 'ASC' },
    });

    const keyboard = [[{
        text: '📁 添加常用目录',
        callback_data: serializeCb({ t: CB.FOLDER_DRILL, f: '-11' }),
    }]];

    const username = session.account.entity?.username;
    const message = commonFolderList(folders, username);

    // 删除之前的常用目录消息
    if (session.ui.commonFolderListMsgId) {
        await deleteMsg(svc.bot, chatId, session.ui.commonFolderListMsgId);
        session.ui.commonFolderListMsgId = null;
    }

    const newMsg = await send(svc.bot, chatId, message, { keyboard });
    session.ui.commonFolderListMsgId = newMsg?.message_id || null;
}

// ─── /fs ───
async function handleFolderTree(svc, msg) {
    const chatId = msg.chat.id;
    await showFolderTree(svc, chatId, null);
}

// ─── 目录浏览（回调） ───
async function handleFolderDrill(svc, chatId, data, messageId) {
    await showFolderTree(svc, chatId, data, messageId);
}

async function showFolderTree(svc, chatId, data, messageId = null) {
    const session = svc.sessionStore.get(chatId);
    if (!session.account.id) {
        await send(svc.bot, chatId, '请先使用 /accounts 选择账号');
        return;
    }

    try {
        let folderId = data?.f || '-11';
        const nav = session.folderNav;

        if (data?.r) {
            // 返回上一级 —— 使用数组 pop（修复原 Set 无序问题）
            const parentId = nav.parentStack.pop() || '-11';
            // 回退路径
            const pathParts = nav.path.split('/').filter(Boolean);
            if (pathParts.length > 0) pathParts.pop();
            nav.path = pathParts.length > 0 ? '/' + pathParts.join('/') : '/';
            folderId = parentId;
        } else if (folderId !== '-11') {
            // 非根目录时记录父级
            const folder = nav.folders.get(folderId);
            if (folder?.pId) {
                nav.parentStack.push(folder.pId);
            }
        }

        await typing(svc.bot, chatId);

        const cloud189 = svc.Cloud189Service.getInstance(session.account.entity);
        const folders = await cloud189.getFolderNodes(folderId);
        if (!folders) {
            await send(svc.bot, chatId, '获取文件夹列表失败');
            return;
        }

        // 获取常用目录 ID 集合
        const commonFolders = await svc.commonFolderRepo.find({
            where: { accountId: session.account.id },
        });
        const commonFolderIds = new Set(commonFolders.map(f => f.id));

        // 更新导航状态
        nav.id = folderId;
        if (folderId === '-11') {
            nav.path = '/';
        } else {
            const currentFolder = nav.folders.get(folderId);
            if (currentFolder) {
                nav.path = svc.path.join(nav.path, currentFolder.name);
            }
        }

        // 缓存文件夹
        for (const folder of folders) {
            nav.folders.set(folder.id, folder);
        }

        // 构建键盘
        const keyboard = folderKeyboard(folders, commonFolderIds);

        // 操作按钮行
        const actionRow = [
            { text: '❌ 关闭', callback_data: serializeCb({ t: CB.FOLDER_CANCEL }) },
        ];
        if (folderId !== '-11') {
            actionRow.push({
                text: '🔄 返回',
                callback_data: serializeCb({ t: CB.FOLDER_DRILL, f: '-11', r: true }),
            });
        }
        actionRow.push({
            text: '✅ 确认',
            callback_data: serializeCb({ t: CB.FOLDER_SAVE, f: folderId }),
        });
        keyboard.push(actionRow);

        const username = desensitizeUsername(session.account.entity?.username);
        const message = `当前账号: ${escapeHtml(username)}\n当前路径: ${escapeHtml(nav.path)}\n请选择要添加的目录:`;

        if (messageId) {
            await edit(svc.bot, chatId, messageId, message, { keyboard });
        } else {
            await send(svc.bot, chatId, message, { keyboard });
        }
    } catch (error) {
        console.error(error);
        await send(svc.bot, chatId, friendlyError(error));
    }
}

// ─── 保存常用目录（回调） ───
async function handleFolderSave(svc, chatId, data, messageId) {
    const session = svc.sessionStore.get(chatId);

    try {
        let currentPath = session.folderNav.path || '/';

        // 检查是否已是常用目录
        const existing = await svc.commonFolderRepo.findOne({
            where: { accountId: session.account.id, id: data.f },
        });
        if (existing) {
            await edit(svc.bot, chatId, messageId, `${escapeHtml(currentPath)} 已经是常用目录`);
            return;
        }

        if (currentPath === '' || currentPath === '/') {
            currentPath = '/';
        } else {
            currentPath = currentPath.replace(/^\/|\/$/g, '');
        }

        const favorite = {
            accountId: session.account.id,
            id: data.f,
            path: currentPath,
            name: currentPath.split('/').pop() || '根目录',
        };

        await svc.commonFolderRepo.save(favorite);
        await edit(svc.bot, chatId, messageId, `✅ 已将 ${escapeHtml(currentPath || '根目录')} 添加到常用目录`);
    } catch (error) {
        await edit(svc.bot, chatId, messageId, friendlyError(error));
    }
}

// ─── /df_ID ───
async function handleDeleteFolder(svc, msg, folderId) {
    const chatId = msg.chat.id;
    const session = svc.sessionStore.get(chatId);

    try {
        await svc.commonFolderRepo.delete({
            id: folderId,
            accountId: session.account.id,
        });
        await send(svc.bot, chatId, '✅ 删除成功');
        await handleCommonFolders(svc, msg);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = {
    handleCommonFolders,
    handleFolderTree,
    handleFolderDrill,
    handleFolderSave,
    handleDeleteFolder,
};
