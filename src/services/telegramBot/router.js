/**
 * 命令注册 + callback_query 分发路由
 */
const { CB, TASK_STATUS, CALLBACK_LOCK_WINDOW_MS } = require('./constants');
const { parseCb } = require('./keyboards');
const { send } = require('./messaging');
const { friendlyError } = require('./errors');

// Handler 延迟加载（避免循环依赖）
let _handlers = null;
function getHandlers() {
    if (!_handlers) {
        _handlers = {
            basics: require('./handlers/basics'),
            tasks: require('./handlers/tasks'),
            folders: require('./handlers/folders'),
            search: require('./handlers/search'),
            series: require('./handlers/series'),
            share: require('./handlers/share'),
            stats: require('./handlers/stats'),
            logs: require('./handlers/logs'),
            subs: require('./handlers/subs'),
        };
    }
    return _handlers;
}

/**
 * 注册所有命令与事件
 * @param {import('./core').TelegramBotService} svc
 */
function registerCommands(svc) {
    const bot = svc.bot;

    const runCommandWithAccount = async (msg, handler) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (!svc.checkAccount(msg.chat.id)) {
            await send(bot, msg.chat.id, '请先使用 /accounts 选择账号');
            return;
        }
        await handler();
    };

    const withCallbackLock = async (callbackQuery, data, handler) => {
        const chatId = callbackQuery.message.chat.id;
        const session = svc.sessionStore.get(chatId);
        const lockKey = `${data.t}:${data.i || ''}:${data.p || ''}:${data.f || ''}`;
        const now = Date.now();
        const lastAt = session.callbackLocks.get(lockKey) || 0;

        if (now - lastAt < CALLBACK_LOCK_WINDOW_MS) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '处理中，请勿重复点击' }).catch(() => {});
            return false;
        }

        session.callbackLocks.set(lockKey, now);
        try {
            await handler();
            return true;
        } finally {
            setTimeout(() => {
                const current = session.callbackLocks.get(lockKey);
                if (current === now) {
                    session.callbackLocks.delete(lockKey);
                }
            }, CALLBACK_LOCK_WINDOW_MS);
        }
    };

    // ═══════════ 命令路由 ═══════════

    bot.onText(/^\/start$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().basics.handleStart(svc, msg);
    });

    bot.onText(/^\/help$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().basics.handleHelp(svc, msg);
    });

    bot.onText(/^\/accounts$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().basics.handleAccounts(svc, msg);
    });

    bot.onText(/^\/cancel$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().basics.handleCancel(svc, msg);
    });

    bot.onText(/^\/tasks_failed$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().tasks.handleTasksByStatus(svc, msg, TASK_STATUS.FAILED);
        });
    });

    bot.onText(/^\/tasks_pending$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().tasks.handleTasksByStatus(svc, msg, TASK_STATUS.PENDING);
        });
    });

    bot.onText(/^\/tasks_processing$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().tasks.handleTasksByStatus(svc, msg, TASK_STATUS.PROCESSING);
        });
    });

    bot.onText(/^\/tasks$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().tasks.handleTasks(svc, msg);
        });
    });

    bot.onText(/^\/execute_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().tasks.handleExecute(svc, msg, match[1]);
    });

    bot.onText(/^\/execute_all$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (!svc.checkAdmin(msg.chat.id)) {
            await send(bot, msg.chat.id, '⚠️ 仅管理员可执行该操作');
            return;
        }
        await getHandlers().tasks.handleExecuteAll(svc, msg);
    });

    bot.onText(/^\/strm_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().tasks.handleStrm(svc, msg, match[1]);
    });

    bot.onText(/^\/emby_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().tasks.handleEmby(svc, msg, match[1]);
    });

    bot.onText(/^\/dt_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (!svc.checkAdmin(msg.chat.id)) {
            await send(bot, msg.chat.id, '⚠️ 仅管理员可执行该操作');
            return;
        }
        await getHandlers().tasks.handleDeletePrompt(svc, msg, match[1]);
    });

    bot.onText(/^\/detail_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().tasks.handleDetail(svc, msg, match[1]);
    });

    bot.onText(/^\/retry_(\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (!svc.checkAdmin(msg.chat.id)) {
            await send(bot, msg.chat.id, '⚠️ 仅管理员可执行该操作');
            return;
        }
        await getHandlers().tasks.handleRetry(svc, msg, match[1]);
    });

    bot.onText(/^\/fl$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().folders.handleCommonFolders(svc, msg);
        });
    });

    bot.onText(/^\/fs$/, async (msg) => {
        await runCommandWithAccount(msg, async () => {
            await getHandlers().folders.handleFolderTree(svc, msg);
        });
    });

    bot.onText(/^\/df_(-?\d+)$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (!svc.checkAccount(msg.chat.id)) {
            await send(bot, msg.chat.id, '请先使用 /accounts 选择账号');
            return;
        }
        if (!svc.checkAdmin(msg.chat.id)) {
            await send(bot, msg.chat.id, '⚠️ 仅管理员可执行该操作');
            return;
        }
        await getHandlers().folders.handleDeleteFolder(svc, msg, match[1]);
    });

    bot.onText(/\/search_cs/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().search.handleSearchMode(svc, msg);
    });

    bot.onText(/^\/series(?:\s+(.+))?$/i, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().series.handleSeries(svc, msg, match?.[1], 'normal');
    });

    bot.onText(/^\/lazy_series(?:\s+(.+))?$/i, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().series.handleSeries(svc, msg, match?.[1], 'lazy');
    });

    bot.onText(/\/tmdb (.+)/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().search.handleTmdb(svc, msg, match[1]);
    });

    bot.onText(/^\/stats$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().stats.handleStats(svc, msg);
    });

    bot.onText(/^\/logs(?:_(\d+))?$/, async (msg, match) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().logs.handleLogs(svc, msg, match?.[1]);
    });

    bot.onText(/^\/subs$/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().subs.handleSubs(svc, msg);
    });

    // ═══════════ 分享链接（非命令文本） ═══════════

    bot.onText(/cloud\.189\.cn/, async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        await getHandlers().share.handleShareLink(svc, msg);
    });

    // ═══════════ 通用 message（搜索模式） ═══════════

    bot.on('message', async (msg) => {
        if (!svc.checkChatId(msg.chat.id)) return;
        if (msg.text?.startsWith('/')) return;
        await getHandlers().search.handleSearchMessage(svc, msg);
    });

    // ═══════════ callback_query 路由 ═══════════

    bot.on('callback_query', async (callbackQuery) => {
        const data = parseCb(callbackQuery.data);
        if (!data) {
            bot.answerCallbackQuery(callbackQuery.id, { text: '无效操作' }).catch(() => {});
            return;
        }

        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        try {
            const handled = await withCallbackLock(callbackQuery, data, async () => {
                switch (data.t) {
                    case CB.FOLDER_SELECT:
                        await getHandlers().tasks.handleCreateTask(svc, chatId, data, messageId);
                        break;
                    case CB.OVERWRITE_FOLDER:
                        if (!data.o) {
                            const { edit } = require('./messaging');
                            await edit(bot, chatId, messageId, '已取消任务创建');
                            return;
                        }
                        await getHandlers().tasks.handleCreateTask(svc, chatId, data, messageId);
                        break;
                    case CB.SET_ACCOUNT:
                        await getHandlers().basics.handleSetAccount(svc, chatId, data, messageId);
                        break;
                    case CB.TASK_PAGE: {
                        const session = svc.sessionStore.get(chatId);
                        await getHandlers().tasks.handleTaskPage(svc, chatId, data.p, messageId, session.ui.taskListFilter);
                        break;
                    }
                    case CB.DELETE_TASK:
                        if (!svc.checkAdmin(chatId)) {
                            await send(bot, chatId, '⚠️ 仅管理员可执行该操作');
                            return;
                        }
                        if (data.p) {
                            await getHandlers().tasks.handleDeletePrompt(svc, { chat: { id: chatId } }, data.i, messageId);
                            break;
                        }
                        if (!data.c) {
                            const { edit } = require('./messaging');
                            await edit(bot, chatId, messageId, '已取消删除');
                            return;
                        }
                        await getHandlers().tasks.handleDeleteTask(svc, chatId, data, messageId);
                        break;
                    case CB.FOLDER_DRILL:
                        await getHandlers().folders.handleFolderDrill(svc, chatId, data, messageId);
                        break;
                    case CB.FOLDER_CANCEL: {
                        const { deleteMsg } = require('./messaging');
                        await deleteMsg(bot, chatId, messageId);
                        break;
                    }
                    case CB.FOLDER_SAVE:
                        if (!svc.checkAdmin(chatId)) {
                            await send(bot, chatId, '⚠️ 仅管理员可执行该操作');
                            return;
                        }
                        await getHandlers().folders.handleFolderSave(svc, chatId, data, messageId);
                        break;
                    case CB.TASK_EXECUTE:
                        await getHandlers().tasks.handleExecuteCb(svc, chatId, data.i, messageId);
                        break;
                    case CB.TASK_RETRY:
                        if (!svc.checkAdmin(chatId)) {
                            await send(bot, chatId, '⚠️ 仅管理员可执行该操作');
                            return;
                        }
                        await getHandlers().tasks.handleRetryCb(svc, chatId, data.i, messageId);
                        break;
                    case CB.TASK_DETAIL:
                        await getHandlers().tasks.handleDetailCb(svc, chatId, data.i, messageId);
                        break;
                    case CB.HELP_NAV:
                        await getHandlers().basics.handleHelpNav(svc, chatId, data.v, messageId);
                        break;
                    case CB.SUBS_PAGE:
                        await getHandlers().subs.handleSubsPage(svc, chatId, data.p, messageId);
                        break;
                    default:
                        break;
                }
            });

            if (!handled) {
                return;
            }
        } catch (error) {
            await send(bot, chatId, friendlyError(error));
        }

        bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
    });
}

module.exports = { registerCommands };
