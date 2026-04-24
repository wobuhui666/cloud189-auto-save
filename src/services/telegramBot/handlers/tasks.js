/**
 * 任务相关 handler: /tasks /execute /detail /retry /strm /emby /dt + 分页 + 创建
 */
const { send, edit, typing, deleteMsg } = require('../messaging');
const { taskCard, taskDetailCard, formatStatus } = require('../templates');
const { paginationRow, serializeCb, taskActionRow } = require('../keyboards');
const { friendlyError } = require('../errors');
const { CB, TASK_STATUS } = require('../constants');

function getTaskListTitle(status) {
    switch (status) {
        case TASK_STATUS.FAILED:
            return '失败任务';
        case TASK_STATUS.PENDING:
            return '待执行任务';
        case TASK_STATUS.PROCESSING:
            return '执行中任务';
        default:
            return '任务列表';
    }
}

async function handleTasks(svc, msg) {
    await handleTaskPage(svc, msg.chat.id, 1);
}

async function handleTasksByStatus(svc, msg, status) {
    await handleTaskPage(svc, msg.chat.id, 1, null, status);
}

async function handleTaskPage(svc, chatId, page = 1, messageId = null, status = null) {
    const session = svc.sessionStore.get(chatId);
    const pageSize = 5;
    const skip = (page - 1) * pageSize;
    const where = status ? { status } : {};

    const [tasks, total] = await svc.taskRepo.findAndCount({
        where,
        order: { updatedAt: 'DESC' },
        take: pageSize,
        skip,
    });

    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const taskList = tasks.map(t => taskCard(t)).join('\n\n');
    const keyboard = [];
    const title = getTaskListTitle(status);

    const pageRow = paginationRow(CB.TASK_PAGE, page, totalPages);
    if (pageRow.length > 0) keyboard.push(pageRow);

    const emptyTips = status
        ? `📭 暂无${title}，可使用 /tasks 查看全部任务`
        : '📭 暂无任务，可先发送 cloud.189.cn 分享链接创建任务';
    const message = tasks.length > 0
        ? `📋 ${title} (第${page}页，共${total}个)：\n\n${taskList}`
        : emptyTips;

    session.ui.taskListFilter = status || null;

    if (messageId) {
        await edit(svc.bot, chatId, messageId, message, { keyboard });
    } else {
        if (session.ui.taskListMsgId) {
            await deleteMsg(svc.bot, chatId, session.ui.taskListMsgId);
        }
        const newMsg = await send(svc.bot, chatId, message, { keyboard });
        session.ui.taskListMsgId = newMsg?.message_id || null;
    }
}

// ─── /execute_ID ───
async function handleExecute(svc, msg, taskId) {
    const chatId = msg.chat.id;
    if (isNaN(taskId)) {
        await send(svc.bot, chatId, '⚠️ 任务ID无效');
        return;
    }
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '⏳ 任务开始执行...');
    try {
        await svc.taskService.processAllTasks(true, [taskId]);
        await deleteMsg(svc.bot, chatId, statusMsg?.message_id);
        await send(svc.bot, chatId, '✅ 任务执行完成');
    } catch (e) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(e));
    }
}

// ─── /execute_all ───
async function handleExecuteAll(svc, msg) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '⏳ 开始执行所有任务...');
    try {
        await svc.taskService.processAllTasks(true);
        await edit(svc.bot, chatId, statusMsg?.message_id, '✅ 所有任务执行完成');
    } catch (e) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(e));
    }
}

// ─── /strm_ID ───（修复: 加 await）
async function handleStrm(svc, msg, taskId) {
    const chatId = msg.chat.id;
    if (isNaN(taskId)) {
        await send(svc.bot, chatId, '⚠️ 任务ID无效');
        return;
    }
    const task = await svc.taskService.getTaskById(taskId);
    if (!task) {
        await send(svc.bot, chatId, '未找到该任务');
        return;
    }
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '⏳ 开始生成STRM...');
    try {
        await svc.taskService._createStrmFileByTask(task, false);
        await deleteMsg(svc.bot, chatId, statusMsg?.message_id);
        await send(svc.bot, chatId, '✅ STRM生成完成');
    } catch (e) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(e));
    }
}

// ─── /emby_ID ───
async function handleEmby(svc, msg, taskId) {
    const chatId = msg.chat.id;
    if (isNaN(taskId)) {
        await send(svc.bot, chatId, '⚠️ 任务ID无效');
        return;
    }
    const task = await svc.taskService.getTaskById(taskId);
    if (!task) {
        await send(svc.bot, chatId, '未找到该任务');
        return;
    }
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '⏳ 开始通知Emby...');
    try {
        const embyService = new svc.EmbyService(svc.taskService);
        await embyService.notify(task);
        await deleteMsg(svc.bot, chatId, statusMsg?.message_id);
        await send(svc.bot, chatId, '✅ Emby通知完成');
    } catch (e) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(e));
    }
}

// ─── /dt_ID 确认提示 ───
async function handleDeletePrompt(svc, msg, taskId, messageId = null) {
    const chatId = msg.chat.id;
    const keyboard = [
        [
            { text: '是', callback_data: serializeCb({ t: CB.DELETE_TASK, i: taskId, c: true, df: true }) },
            { text: '否', callback_data: serializeCb({ t: CB.DELETE_TASK, i: taskId, c: true, df: false }) },
        ],
        [{ text: '取消', callback_data: serializeCb({ t: CB.DELETE_TASK, c: false }) }],
    ];
    if (messageId) {
        await edit(svc.bot, chatId, messageId, '是否同步删除网盘文件？', { keyboard });
        return;
    }
    await send(svc.bot, chatId, '是否同步删除网盘文件？', { keyboard });
}

// ─── 删除任务（回调） ───
async function handleDeleteTask(svc, chatId, data, messageId) {
    if (isNaN(data.i)) {
        await edit(svc.bot, chatId, messageId, '⚠️ 任务ID无效');
        return;
    }
    await edit(svc.bot, chatId, messageId, '⏳ 任务删除中...');
    try {
        await svc.taskService.deleteTask(parseInt(data.i), data.df);
        await edit(svc.bot, chatId, messageId, '✅ 任务删除成功');
        setTimeout(() => handleTaskPage(svc, chatId, 1), 800);
    } catch (e) {
        await edit(svc.bot, chatId, messageId, friendlyError(e));
    }
}

// ─── /detail_ID ───（新功能）
async function handleDetail(svc, msg, taskId) {
    const chatId = msg.chat.id;
    if (isNaN(taskId)) {
        await send(svc.bot, chatId, '⚠️ 任务ID无效');
        return;
    }
    const task = await svc.taskService.getTaskById(taskId);
    if (!task) {
        await send(svc.bot, chatId, '未找到该任务');
        return;
    }
    const text = taskDetailCard(task);
    const keyboard = [taskActionRow(task.id)];
    await send(svc.bot, chatId, text, { keyboard });
}

// ─── /detail 回调 ───
async function handleDetailCb(svc, chatId, taskId, messageId) {
    const task = await svc.taskService.getTaskById(taskId);
    if (!task) {
        await edit(svc.bot, chatId, messageId, '未找到该任务');
        return;
    }
    const text = taskDetailCard(task);
    const keyboard = [taskActionRow(task.id)];
    await edit(svc.bot, chatId, messageId, text, { keyboard });
}

// ─── /retry_ID ───（新功能）
async function handleRetry(svc, msg, taskId) {
    const chatId = msg.chat.id;
    if (isNaN(taskId)) {
        await send(svc.bot, chatId, '⚠️ 任务ID无效');
        return;
    }
    const task = await svc.taskService.getTaskById(taskId);
    if (!task) {
        await send(svc.bot, chatId, '未找到该任务');
        return;
    }
    if (task.status !== TASK_STATUS.FAILED) {
        await send(svc.bot, chatId, `⚠️ 该任务状态为 ${formatStatus(task.status)}，仅失败任务可重试`);
        return;
    }
    await typing(svc.bot, chatId);
    const statusMsg = await send(svc.bot, chatId, '🔄 重置任务并开始执行...');
    try {
        await svc.taskRepo.update(task.id, { status: TASK_STATUS.PENDING, lastError: null });
        await svc.taskService.processAllTasks(true, [String(task.id)]);
        await edit(svc.bot, chatId, statusMsg?.message_id, '✅ 任务重试执行完成');
    } catch (e) {
        await edit(svc.bot, chatId, statusMsg?.message_id, friendlyError(e));
    }
}

// ─── /retry 回调 ───
async function handleRetryCb(svc, chatId, taskId, messageId) {
    await handleRetry(svc, { chat: { id: chatId } }, taskId);
}

// ─── /execute 回调 ───
async function handleExecuteCb(svc, chatId, taskId, messageId) {
    await handleExecute(svc, { chat: { id: chatId } }, taskId);
}

// ─── 创建任务（选择目录后的回调） ───
async function handleCreateTask(svc, chatId, data, messageId) {
    const session = svc.sessionStore.get(chatId);
    try {
        const targetFolderId = data.f;
        const targetFolder = await svc.commonFolderRepo.findOne({ where: { id: targetFolderId } });
        if (!targetFolder) {
            await send(svc.bot, chatId, '未找到该目录');
            return;
        }

        await edit(svc.bot, chatId, messageId, '⏳ 任务创建中...');

        const taskDto = {
            accountId: session.account.id,
            shareLink: session.pendingShare.link,
            targetFolderId: targetFolderId,
            targetFolder: targetFolder.path,
            tgbot: true,
            overwriteFolder: data?.o,
            accessCode: session.pendingShare.accessCode,
        };

        const tasks = await svc.taskService.createTask(taskDto);
        const taskIds = tasks.map(t => t.id);

        await edit(svc.bot, chatId, messageId, '✅ 任务创建成功，执行中...');

        if (taskIds.length > 0) {
            await svc.taskService.processAllTasks(true, taskIds);
        }

        await deleteMsg(svc.bot, chatId, messageId);
        await send(svc.bot, chatId, '✅ 任务执行完成');

        // 清空缓存
        session.pendingShare.link = null;
        session.pendingShare.accessCode = null;
    } catch (error) {
        if (error.message && error.message.includes('folder already exists')) {
            const keyboard = [
                [{ text: '是', callback_data: serializeCb({ t: CB.OVERWRITE_FOLDER, f: data.f, o: true }) }],
                [{ text: '否', callback_data: serializeCb({ t: CB.OVERWRITE_FOLDER, f: data.f, o: false }) }],
            ];
            await edit(svc.bot, chatId, messageId, '⚠️ 该目录下已有同名文件夹，是否覆盖？', { keyboard });
        } else {
            await edit(svc.bot, chatId, messageId, friendlyError(error));
            session.pendingShare.link = null;
            session.pendingShare.accessCode = null;
        }
    }
}

module.exports = {
    handleTasks,
    handleTasksByStatus,
    handleTaskPage,
    handleExecute,
    handleExecuteAll,
    handleStrm,
    handleEmby,
    handleDeletePrompt,
    handleDeleteTask,
    handleDetail,
    handleDetailCb,
    handleRetry,
    handleRetryCb,
    handleExecuteCb,
    handleCreateTask,
};
