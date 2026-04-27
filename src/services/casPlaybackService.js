/**
 * CAS 视频播放临时恢复服务
 * 参考 OpenList-CAS: /internal/openlistplus/preview.go
 * 
 * 功能：
 * - 临时恢复 CAS 文件用于播放
 * - 播放后自动清理临时文件
 * - 获取播放链接
 */

const { logTaskEvent } = require('../utils/logUtils');
const { CasFileService } = require('./casFileService');
const { CasService } = require('./casService');
const { CasCleanupService } = require('./casCleanupService');
const { Cloud189Service } = require('./cloud189');
const ConfigService = require('./ConfigService');

class CasPlaybackService {
    constructor() {
        this._tempFiles = new Map(); // fileId -> { fileId, fileName, createTime, cleanupTimer }
        this._cleanupService = new CasCleanupService();
        this._tempFileTtlMs = 5 * 60 * 1000; // 默认5分钟后清理
    }

    /**
     * 检查是否支持 CAS 预览
     * @param {string} storageName - 存储名称
     * @returns {boolean}
     */
    static canPreviewCAS(storageName) {
        return storageName === '189CloudPC' || storageName === 'cloud189';
    }

    /**
     * 获取 CAS 文件的预览名称（原始文件名）
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     * @param {string} fileId - CAS 文件ID
     * @param {string} fileName - CAS 文件名
     * @returns {Promise<string>} 原始文件名
     */
    async getPreviewFileName(cloud189, fileId, fileName) {
        if (!CasFileService.isCasFile(fileName)) {
            return fileName;
        }

        try {
            const casService = new CasService();
            const casInfo = await casService.downloadAndParseCas(cloud189, fileId);
            return CasFileService.getOriginalFileName(fileName, casInfo);
        } catch (error) {
            logTaskEvent(`[CAS播放] 获取预览名称失败: ${error.message}`);
            return fileName;
        }
    }

    /**
     * 恢复并获取播放链接
     * 参考 OpenList-CAS preview.go 的 ResolveCASPreviewLinkByMountPath
     * 
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     * @param {string} fileId - CAS 文件ID
     * @param {string} fileName - CAS 文件名
     * @param {string} parentFolderId - 父文件夹ID
     * @returns {Promise<object>} { url, fileName, tempFileId, cleanup }
     */
    async restoreAndGetPlaybackUrl(cloud189, fileId, fileName, parentFolderId) {
        if (!CasFileService.isCasFile(fileName)) {
            throw new Error('不是有效的 CAS 文件');
        }

        logTaskEvent(`[CAS播放] 开始恢复播放: ${fileName}`);

        // 1. 解析 CAS 文件
        const casService = new CasService();
        const casInfo = await casService.downloadAndParseCas(cloud189, fileId);
        const originalName = CasFileService.getOriginalFileName(fileName, casInfo);

        // 2. 检查原始文件是否已存在
        const existingFile = await this._findFileByName(cloud189, parentFolderId, originalName);
        if (existingFile) {
            logTaskEvent(`[CAS播放] 原始文件已存在，直接获取链接: ${originalName}`);
            const playUrl = await cloud189.getFileDownloadUrl(existingFile.id || existingFile.fileId);
            return {
                url: playUrl,
                fileName: originalName,
                tempFileId: existingFile.id || existingFile.fileId,
                isExisting: true
            };
        }

        // 3. 创建临时恢复文件名
        const previewCasName = CasFileService.buildPreviewRestoreCasName(originalName);
        const previewRestoreName = CasFileService.buildPreviewRestoreName(originalName, casInfo, false);

        // 4. 恢复文件
        const casFileInfo = {
            name: originalName,
            size: casInfo.size,
            md5: casInfo.md5,
            sliceMd5: casInfo.sliceMd5 || casInfo.md5
        };

        await casService.restoreFromCas(cloud189, parentFolderId, casFileInfo, previewRestoreName);

        // 5. 获取恢复后的文件
        const restoredFile = await this._findFileByName(cloud189, parentFolderId, previewRestoreName);
        if (!restoredFile) {
            throw new Error('恢复文件失败：无法找到恢复后的文件');
        }

        const tempFileId = restoredFile.id || restoredFile.fileId;
        
        // 6. 获取播放链接
        const playUrl = await cloud189.getFileDownloadUrl(tempFileId);

        // 7. 设置自动清理
        this._scheduleTempFileCleanup(cloud189, tempFileId, previewRestoreName, parentFolderId);

        logTaskEvent(`[CAS播放] 恢复完成: ${previewRestoreName}, 临时ID: ${tempFileId}`);

        return {
            url: playUrl,
            fileName: originalName,
            tempFileId: tempFileId,
            isExisting: false,
            cleanup: () => this._cleanupTempFileNow(cloud189, tempFileId, previewRestoreName)
        };
    }

    /**
     * 立即清理临时文件
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     * @param {string} tempFileId - 临时文件ID
     * @param {string} tempFileName - 临时文件名
     */
    async _cleanupTempFileNow(cloud189, tempFileId, tempFileName) {
        try {
            // 取消定时清理
            const tempFile = this._tempFiles.get(tempFileId);
            if (tempFile?.cleanupTimer) {
                clearTimeout(tempFile.cleanupTimer);
            }
            this._tempFiles.delete(tempFileId);

            // 删除临时文件
            await this._cleanupService.deleteTempPreviewFile(cloud189, tempFileId, tempFileName);
            logTaskEvent(`[CAS播放] 已清理临时文件: ${tempFileName}`);
        } catch (error) {
            logTaskEvent(`[CAS播放] 清理临时文件失败: ${error.message}`);
        }
    }

    /**
     * 安排临时文件清理
     * @private
     */
    _scheduleTempFileCleanup(cloud189, tempFileId, tempFileName, parentFolderId) {
        // 取消已存在的定时器
        const existing = this._tempFiles.get(tempFileId);
        if (existing?.cleanupTimer) {
            clearTimeout(existing.cleanupTimer);
        }

        const cleanupTimer = setTimeout(async () => {
            await this._cleanupTempFileNow(cloud189, tempFileId, tempFileName);
        }, this._tempFileTtlMs);

        this._tempFiles.set(tempFileId, {
            fileId: tempFileId,
            fileName: tempFileName,
            parentFolderId,
            createTime: Date.now(),
            cleanupTimer
        });
    }

    /**
     * 按名称查找文件
     * @private
     */
    async _findFileByName(cloud189, folderId, fileName) {
        try {
            const result = await cloud189.listFiles(folderId);
            const files = result?.fileListAO?.fileList || [];
            return files.find(f => (f.name || f.fileName) === fileName);
        } catch (error) {
            return null;
        }
    }

    /**
     * 获取所有临时文件
     * @returns {Array} 临时文件列表
     */
    getTempFiles() {
        return Array.from(this._tempFiles.values()).map(t => ({
            fileId: t.fileId,
            fileName: t.fileName,
            parentFolderId: t.parentFolderId,
            createTime: t.createTime,
            age: Date.now() - t.createTime
        }));
    }

    /**
     * 清理所有临时文件
     * @param {Cloud189Service} cloud189 - 云盘服务实例
     */
    async cleanupAllTempFiles(cloud189) {
        const files = Array.from(this._tempFiles.entries());
        for (const [fileId, tempFile] of files) {
            await this._cleanupTempFileNow(cloud189, fileId, tempFile.fileName);
        }
    }

    /**
     * 设置临时文件过期时间
     * @param {number} ttlMs - 过期时间（毫秒）
     */
    setTempFileTtl(ttlMs) {
        this._tempFileTtlMs = ttlMs;
    }
}

// 导出单例
const casPlaybackService = new CasPlaybackService();
module.exports = { CasPlaybackService, casPlaybackService };
