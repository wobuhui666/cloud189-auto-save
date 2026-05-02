/**
 * 键盘构建工具
 */
const { CB, TG_LIMITS } = require('./constants');

/**
 * 截断按钮文本，保证不超过 TG 限制
 */
function truncateBtn(text, maxLen = TG_LIMITS.BUTTON_TEXT_MAX) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
}

/**
 * 序列化 callback_data（不超 64 字节）
 */
function serializeCb(obj) {
    const str = JSON.stringify(obj);
    if (Buffer.byteLength(str, 'utf8') > TG_LIMITS.CALLBACK_DATA_MAX) {
        console.warn('callback_data 超过 64 字节:', str.length, str);
    }
    return str;
}

/**
 * 安全解析 callback_data
 */
function parseCb(str) {
    try {
        return JSON.parse(str);
    } catch {
        return null;
    }
}

/**
 * 构建分页键盘行
 * @param {string} cbType  回调类型（如 CB.TASK_PAGE）
 * @param {number} page    当前页
 * @param {number} totalPages 总页数
 */
function paginationRow(cbType, page, totalPages) {
    if (totalPages <= 1) return [];

    const buttons = [];

    // 首页
    if (page > 2) {
        buttons.push({
            text: '⏮',
            callback_data: serializeCb({ t: cbType, p: 1 }),
        });
    }
    // 上一页
    if (page > 1) {
        buttons.push({
            text: '⬅️',
            callback_data: serializeCb({ t: cbType, p: page - 1 }),
        });
    }
    // 当前页/总页数
    buttons.push({
        text: `${page}/${totalPages}`,
        callback_data: serializeCb({ t: cbType, p: page }),
    });
    // 下一页
    if (page < totalPages) {
        buttons.push({
            text: '➡️',
            callback_data: serializeCb({ t: cbType, p: page + 1 }),
        });
    }
    // 末页
    if (page < totalPages - 1) {
        buttons.push({
            text: '⏭',
            callback_data: serializeCb({ t: cbType, p: totalPages }),
        });
    }

    return buttons;
}

/**
 * 将按钮列表排成多列
 * @param {Array} buttons   按钮对象数组
 * @param {number} cols     每行列数
 */
function multiColumn(buttons, cols = 2) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += cols) {
        rows.push(buttons.slice(i, i + cols));
    }
    return rows;
}

/**
 * 构建文件夹列表键盘（名短时自动 2 列，名长时单列）
 */
function folderKeyboard(folders, commonFolderIds = new Set()) {
    const buttons = folders.map(folder => ({
        text: truncateBtn(`📁 ${folder.name}${commonFolderIds.has(folder.id) ? ' ✅' : ''}`),
        callback_data: serializeCb({ t: CB.FOLDER_DRILL, f: folder.id }),
    }));

    // 判断是否可以两列排列（所有按钮文本 <= 20 字符）
    const canTwoCol = buttons.every(b => b.text.length <= 20);
    if (canTwoCol && buttons.length > 3) {
        return multiColumn(buttons, 2);
    }
    // 单列
    return buttons.map(b => [b]);
}

/**
 * 构建任务操作按钮行（详情页用）
 */
function taskActionRow(taskId) {
    return [
        { text: '🔄 执行', callback_data: serializeCb({ t: CB.TASK_EXECUTE, i: taskId }) },
        { text: '🔁 重试', callback_data: serializeCb({ t: CB.TASK_RETRY, i: taskId }) },
        { text: '🗑 删除', callback_data: serializeCb({ t: CB.DELETE_TASK, i: taskId, p: true }) },
    ];
}

/**
 * 构建 PT 订阅操作按钮行
 */
function ptSubActionRow(subId, enabled) {
    return [
        { text: '🔄 刷新', callback_data: serializeCb({ t: CB.PT_SUB_REFRESH, i: subId }) },
        { text: enabled ? '❌ 禁用' : '✅ 启用', callback_data: serializeCb({ t: CB.PT_SUB_TOGGLE, i: subId }) },
        { text: '📋 Releases', callback_data: serializeCb({ t: CB.PT_RELEASE_PAGE, i: subId, p: 1 }) },
    ];
}

/**
 * 构建 PT Release 操作按钮行
 */
function ptReleaseActionRow(releaseId) {
    return [
        { text: '🔁 重试', callback_data: serializeCb({ t: CB.PT_RELEASE_RETRY, i: releaseId }) },
        { text: '🗑 删除', callback_data: serializeCb({ t: CB.PT_RELEASE_DEL, i: releaseId }) },
    ];
}

/**
 * 构建 help 快捷导航键盘
 */
function helpNavKeyboard() {
    return [
        [
            { text: '📋 任务', callback_data: serializeCb({ t: CB.HELP_NAV, v: 'tasks' }) },
            { text: '🔍 搜索', callback_data: serializeCb({ t: CB.HELP_NAV, v: 'search' }) },
        ],
        [
            { text: '📁 目录', callback_data: serializeCb({ t: CB.HELP_NAV, v: 'folders' }) },
            { text: '📊 统计', callback_data: serializeCb({ t: CB.HELP_NAV, v: 'stats' }) },
        ],
    ];
}

module.exports = {
    truncateBtn,
    serializeCb,
    parseCb,
    paginationRow,
    multiColumn,
    folderKeyboard,
    taskActionRow,
    ptSubActionRow,
    ptReleaseActionRow,
    helpNavKeyboard,
};
