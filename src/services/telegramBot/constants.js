/**
 * Telegram Bot 常量定义
 */

// Callback type 枚举 —— 与 callback_data JSON 的 t 字段对应
const CB = {
    FOLDER_SELECT: 'f',         // 选择保存目录
    OVERWRITE_FOLDER: 'of',     // 覆盖同名文件夹确认
    SET_ACCOUNT: 'sa',          // 设置当前账号
    TASK_PAGE: 'tp',            // 任务列表分页
    DELETE_TASK: 'dt',          // 删除任务
    FOLDER_DRILL: 'fd',        // 进入子目录
    FOLDER_CANCEL: 'fc',       // 取消目录操作
    FOLDER_SAVE: 'fs',         // 保存常用目录
    TASK_DETAIL: 'td',         // 任务详情
    TASK_RETRY: 'tr',          // 重试任务
    TASK_EXECUTE: 'te',        // 执行任务
    STATS_REFRESH: 'sr',       // 刷新统计
    HELP_NAV: 'hn',            // help 快捷导航
    SUBS_PAGE: 'sp',           // 订阅分页
};

// 任务状态枚举
const TASK_STATUS = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
};

// TG 消息限制
const TG_LIMITS = {
    MESSAGE_MAX_LEN: 4096,
    SAFE_MESSAGE_LEN: 4000,    // 留 96 字节余量给标签
    CALLBACK_DATA_MAX: 64,
    BUTTON_TEXT_MAX: 60,
};

// 搜索模式超时（毫秒）
const SEARCH_TIMEOUT_MS = 3 * 60 * 1000;

// callback 防抖窗口（毫秒）
const CALLBACK_LOCK_WINDOW_MS = 3 * 1000;

// 会话空闲清理间隔
const SESSION_CLEANUP_INTERVAL = 10 * 60 * 1000;
const SESSION_MAX_IDLE = 30 * 60 * 1000;

module.exports = {
    CB,
    TASK_STATUS,
    TG_LIMITS,
    SEARCH_TIMEOUT_MS,
    CALLBACK_LOCK_WINDOW_MS,
    SESSION_CLEANUP_INTERVAL,
    SESSION_MAX_IDLE,
};
