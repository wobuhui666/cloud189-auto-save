/**
 * CAS 自动监控服务
 * 参考 OpenList-CAS: /internal/openlistplus/watch.go
 * 
 * 功能：
 * - 自动扫描配置的监控目录
 * - 发现 .cas 文件自动恢复
 * - 支持定时轮询
 */

const { CasFileService } = require('./casFileService');
const { CasService } = require('./casService');
const { logTaskEvent } = require('../utils/logUtils');
const ConfigService = require('./ConfigService');
const { Cloud189Service } = require('./cloud189');

class CasMonitorService {
    constructor() {
        this._watchedPaths = new Map(); // path -> { cancel: Function, config: Object }
        this._inFlightRestores = new Set(); // 正在恢复的 CAS 路径
        this._defaultIntervalMs = 5 * 60 * 1000; // 默认5分钟
        this._isRunning = false;
    }

    /**
     * 启动监控服务
     */
    start() {
        if (this._isRunning) {
            return;
        }
        this._isRunning = true;
        logTaskEvent('[CAS监控] 服务已启动');
        
        // 加载配置并启动监控
        this._reloadConfig();
    }

    /**
     * 停止监控服务
     */
    stop() {
        this._isRunning = false;
        for (const [path, state] of this._watchedPaths) {
            if (state.cancel) {
                state.cancel();
            }
            if (state.timer) {
                clearInterval(state.timer);
            }
        }
        this._watchedPaths.clear();
        this._inFlightRestores.clear();
        logTaskEvent('[CAS监控] 服务已停止');
    }

    /**
     * 重新加载配置
     */
    reload() {
        this._reloadConfig();
    }

    /**
     * 获取监控状态
     */
    getStatus() {
        return {
            isRunning: this._isRunning,
            watchedPaths: Array.from(this._watchedPaths.keys()),
            inFlightCount: this._inFlightRestores.size
        };
    }

    /**
     * 添加监控路径
     * @param {string} accountId - 账号ID
     * @param {string} folderId - 文件夹ID
     * @param {string} folderPath - 文件夹路径
     * @param {object} options - 配置选项
     */
    addWatchPath(accountId, folderId, folderPath, options = {}) {
        const pathKey = `${accountId}:${folderId}`;
        
        // 如果已经在监控，先停止
        this.removeWatchPath(accountId, folderId);

        const config = {
            accountId,
            folderId,
            folderPath,
            intervalMs: options.intervalMs || this._defaultIntervalMs,
            deleteAfterRestore: options.deleteAfterRestore !== false, // 默认删除
            recursive: options.recursive !== false, // 默认递归
            createdAt: Date.now()
        };

        // 立即执行一次扫描
        this._scanPath(config);

        // 设置定时器
        const timer = setInterval(() => {
            if (!this._isRunning) return;
            this._scanPath(config);
        }, config.intervalMs);

        this._watchedPaths.set(pathKey, {
            config,
            timer,
            cancel: () => clearInterval(timer),
            lastScan: Date.now()
        });

        logTaskEvent(`[CAS监控] 已添加监控路径: ${folderPath} (账号${accountId})`);
        return config;
    }

    /**
     * 移除监控路径
     * @param {string} accountId - 账号ID
     * @param {string} folderId - 文件夹ID
     */
    removeWatchPath(accountId, folderId) {
        const pathKey = `${accountId}:${folderId}`;
        const state = this._watchedPaths.get(pathKey);
        if (state) {
            if (state.cancel) {
                state.cancel();
            }
            this._watchedPaths.delete(pathKey);
            logTaskEvent(`[CAS监控] 已移除监控路径: ${state.config.folderPath}`);
        }
    }

    /**
     * 重新加载配置
     * @private
     */
    _reloadConfig() {
        const casConfig = ConfigService.getConfigValue('cas', {});
        const autoRestorePaths = casConfig.autoRestorePaths || [];
        
        // 停止不在配置中的路径
        for (const [pathKey, state] of this._watchedPaths) {
            const stillConfigured = autoRestorePaths.some(p => 
                `${p.accountId}:${p.folderId}` === pathKey
            );
            if (!stillConfigured) {
                this.removeWatchPath(state.config.accountId, state.config.folderId);
            }
        }

        // 添加新配置的路径
        for (const pathConfig of autoRestorePaths) {
            if (pathConfig.enabled !== false) {
                this.addWatchPath(
                    pathConfig.accountId,
                    pathConfig.folderId,
                    pathConfig.folderPath,
                    {
                        intervalMs: pathConfig.intervalMs,
                        deleteAfterRestore: pathConfig.deleteAfterRestore,
                        recursive: pathConfig.recursive
                    }
                );
            }
        }
    }

    /**
     * 扫描指定路径
     * @private
     */
    async _scanPath(config) {
        const pathKey = `${config.accountId}:${config.folderId}`;
        const state = this._watchedPaths.get(pathKey);
        if (state) {
            state.lastScan = Date.now();
        }

        try {
            // 获取账号
            const { AppDataSource } = require('../database');
            const { Account } = require('../entities');
            const accountRepo = AppDataSource.getRepository(Account);
            const account = await accountRepo.findOneBy({ id: parseInt(config.accountId) });
            
            if (!account) {
                logTaskEvent(`[CAS监控] 账号不存在: ${config.accountId}`);
                return;
            }

            const cloud189 = Cloud189Service.getInstance(account);
            await this._scanFolder(cloud189, config.folderId, config);
        } catch (error) {
            logTaskEvent(`[CAS监控] 扫描路径失败: ${config.folderPath}, 错误: ${error.message}`);
        }
    }

    /**
     * 递归扫描文件夹
     * @private
     */
    async _scanFolder(cloud189, folderId, config, depth = 0) {
        if (!this._isRunning) return;
        if (depth > 10) { // 限制递归深度
            logTaskEvent(`[CAS监控] 达到最大递归深度: ${config.folderPath}`);
            return;
        }

        try {
            const result = await cloud189.listFiles(folderId);
            const fileListAO = result?.fileListAO || {};
            const files = fileListAO.fileList || [];
            const folders = fileListAO.folderList || [];

            // 处理文件
            for (const file of files) {
                if (!this._isRunning) return;
                
                const fileName = file.name || file.fileName;
                if (!CasFileService.isCasFile(fileName)) {
                    continue;
                }

                const casPath = `${folderId}/${file.id}`;
                await this._handleCasFile(cloud189, file, folderId, config);
            }

            // 递归处理子文件夹
            if (config.recursive) {
                for (const folder of folders) {
                    if (!this._isRunning) return;
                    await this._scanFolder(cloud189, folder.id, config, depth + 1);
                }
            }
        } catch (error) {
            logTaskEvent(`[CAS监控] 扫描文件夹失败: ${folderId}, 错误: ${error.message}`);
        }
    }

    /**
     * 处理单个 CAS 文件
     * @private
     */
    async _handleCasFile(cloud189, casFile, parentFolderId, config) {
        const fileId = casFile.id || casFile.fileId;
        const fileName = casFile.name || casFile.fileName;
        const inflightKey = `${config.accountId}:${fileId}`;

        // 检查是否正在处理
        if (this._inFlightRestores.has(inflightKey)) {
            return;
        }

        this._inFlightRestores.add(inflightKey);

        try {
            logTaskEvent(`[CAS监控] 发现 CAS 文件: ${fileName}`);

            // 下载并解析 CAS 文件
            const casService = new CasService();
            const casInfo = await casService.downloadAndParseCas(cloud189, fileId);
            
            // 恢复文件
            const restoreName = CasFileService.getOriginalFileName(fileName, casInfo);
            await casService.restoreFromCas(cloud189, parentFolderId, casInfo, restoreName);

            logTaskEvent(`[CAS监控] 恢复成功: ${restoreName}`);

            // 恢复后删除 CAS 文件
            if (config.deleteAfterRestore !== false) {
                await this._deleteCasFile(cloud189, fileId, fileName);
            }
        } catch (error) {
            logTaskEvent(`[CAS监控] 恢复失败: ${fileName}, 错误: ${error.message}`);
        } finally {
            this._inFlightRestores.delete(inflightKey);
        }
    }

    /**
     * 删除 CAS 文件（永久删除）
     * @private
     */
    async _deleteCasFile(cloud189, fileId, fileName) {
        try {
            // 先删除到回收站
            await cloud189.deleteFile(fileId);
            
            // 再清空回收站
            await cloud189.clearRecycleBin([{ id: fileId }]);
            
            logTaskEvent(`[CAS监控] 已删除 CAS 文件: ${fileName}`);
        } catch (error) {
            logTaskEvent(`[CAS监控] 删除 CAS 文件失败: ${fileName}, 错误: ${error.message}`);
        }
    }

    /**
     * 手动触发扫描
     * @param {string} accountId - 账号ID
     * @param {string} folderId - 文件夹ID
     */
    async triggerScan(accountId, folderId) {
        const pathKey = `${accountId}:${folderId}`;
        const state = this._watchedPaths.get(pathKey);
        if (state) {
            await this._scanPath(state.config);
            return { success: true, message: '扫描已触发' };
        }
        return { success: false, message: '该路径不在监控列表中' };
    }

    /**
     * 处理对象更新回调（用于实时更新）
     * @param {string} accountId - 账号ID
     * @param {string} parentFolderId - 父文件夹ID
     * @param {Array} files - 文件列表
     */
    async handleFilesUpdate(accountId, parentFolderId, files) {
        const pathKey = `${accountId}:${parentFolderId}`;
        const state = this._watchedPaths.get(pathKey);
        if (!state) {
            return; // 不在监控列表中
        }

        for (const file of files) {
            const fileName = file.name || file.fileName;
            if (!CasFileService.isCasFile(fileName)) {
                continue;
            }

            // 获取账号并处理
            const { AppDataSource } = require('../database');
            const { Account } = require('../entities');
            const accountRepo = AppDataSource.getRepository(Account);
            const account = await accountRepo.findOneBy({ id: parseInt(accountId) });
            
            if (account) {
                const cloud189 = Cloud189Service.getInstance(account);
                await this._handleCasFile(cloud189, file, parentFolderId, state.config);
            }
        }
    }
}

// 导出单例
const casMonitorService = new CasMonitorService();
module.exports = { CasMonitorService, casMonitorService };
