/**
 * 会话状态管理 —— 每个 chatId 独立会话
 */
const { SESSION_CLEANUP_INTERVAL, SESSION_MAX_IDLE } = require('./constants');

class SessionStore {
    constructor() {
        /** @type {Map<number|string, object>} */
        this.sessions = new Map();
        this._cleanupTimer = null;
    }

    /**
     * 获取或创建指定 chatId 的会话
     */
    get(chatId) {
        if (!this.sessions.has(chatId)) {
            this.sessions.set(chatId, this._createDefault());
        }
        const session = this.sessions.get(chatId);
        session.updatedAt = Date.now();
        return session;
    }

    /**
     * 清除指定 chatId 的会话
     */
    clear(chatId) {
        const session = this.sessions.get(chatId);
        if (session) {
            if (session.search.timeoutRef) clearTimeout(session.search.timeoutRef);
            if (session.ptSearch.timeoutRef) clearTimeout(session.ptSearch.timeoutRef);
        }
        this.sessions.delete(chatId);
    }

    /**
     * 清除空闲超时的会话
     */
    clearIdle(maxAgeMs = SESSION_MAX_IDLE) {
        const now = Date.now();
        for (const [chatId, session] of this.sessions) {
            if (now - session.updatedAt > maxAgeMs) {
                this.clear(chatId);
            }
        }
    }

    /**
     * 启动定期清理
     */
    startCleanup() {
        if (this._cleanupTimer) return;
        this._cleanupTimer = setInterval(() => {
            this.clearIdle();
        }, SESSION_CLEANUP_INTERVAL);
        // 不阻塞进程退出
        if (this._cleanupTimer.unref) {
            this._cleanupTimer.unref();
        }
    }

    /**
     * 停止定期清理
     */
    stopCleanup() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }

    /**
     * 清除所有会话
     */
    clearAll() {
        for (const [chatId] of this.sessions) {
            this.clear(chatId);
        }
    }

    _createDefault() {
        return {
            account: { id: null, entity: null },
            pendingShare: { link: null, accessCode: null },
            folderNav: {
                path: '',
                id: '-11',
                folders: new Map(),
                parentStack: [],     // 用数组替代 Set，支持有序 pop
            },
            ui: {
                lastButtonMsgId: null,
                taskListMsgId: null,
                taskListFilter: null,
                commonFolderListMsgId: null,
            },
            search: {
                active: false,
                timeoutRef: null,
                resultMap: new Map(),
            },
            ptSearch: {
                active: false,
                preset: null,
                results: [],
                groups: [],
                timeoutRef: null,
            },
            callbackLocks: new Map(),
            updatedAt: Date.now(),
        };
    }
}

module.exports = { SessionStore };
