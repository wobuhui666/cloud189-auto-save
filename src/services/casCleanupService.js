const { logTaskEvent } = require('../utils/logUtils');

class CasCleanupService {
    constructor() {
        this._cleanupQueue = [];
        this._isProcessing = false;
    }

    async permanentDelete(cloud189, fileId, fileName = '', isFamily = false) {
        try {
            logTaskEvent(`[CAS清理] 开始永久删除: ${fileName || fileId}`);

            // 1. 先删除到回收站
            await this._runBatchTask(cloud189, 'DELETE',
                [{ fileId, fileName, isFolder: 0 }],
                { isFamily }
            );

            // 2. 清空回收站
            await this._runBatchTask(cloud189, 'EMPTY_RECYCLE', [], { isFamily });

            logTaskEvent(`[CAS清理] 永久删除完成: ${fileName || fileId}`);
            return true;
        } catch (error) {
            logTaskEvent(`[CAS清理] 永久删除失败: ${fileName || fileId}, 错误: ${error.message}`);
            throw error;
        }
    }

    async deleteCasFileAfterRestore(cloud189, casFileId, casFileName = '', isFamily = false) {
        return await this.permanentDelete(cloud189, casFileId, casFileName, isFamily);
    }

    async deleteSourceFileAfterGenerate(cloud189, sourceFileId, sourceFileName = '', isFamily = false) {
        logTaskEvent(`[CAS清理] CAS生成后删除源文件: ${sourceFileName || sourceFileId}`);
        return await this.permanentDelete(cloud189, sourceFileId, sourceFileName, isFamily);
    }

    async deleteTempPreviewFile(cloud189, fileId, fileName = '', isFamily = false) {
        logTaskEvent(`[CAS清理] 删除临时预览文件: ${fileName || fileId}`);
        try {
            await cloud189.deleteFile(fileId, fileName);
            return true;
        } catch (error) {
            logTaskEvent(`[CAS清理] 删除临时文件(可能已清理): ${fileName || fileId}`);
            return true;
        }
    }

    async batchPermanentDelete(cloud189, files, isFamily = false) {
        if (!files || files.length === 0) return;

        const taskInfos = files.map(f => ({
            fileId: String(f.fileId),
            fileName: f.fileName || '',
            isFolder: 0
        }));

        await this._runBatchTask(cloud189, 'DELETE', taskInfos, { isFamily });
        await this._runBatchTask(cloud189, 'EMPTY_RECYCLE', [], { isFamily });
    }

    async _runBatchTask(cloud189, type, taskInfos = [], options = {}) {
        const batchTaskDto = {
            type,
            taskInfos: JSON.stringify(taskInfos),
            targetFolderId: ''
        };
        if (options.isFamily && typeof cloud189.resolveFamilyId === 'function') {
            batchTaskDto.familyId = await cloud189.resolveFamilyId();
        }
        const result = await cloud189.createBatchTask(batchTaskDto);
        if (!result || result.res_code != 0) {
            throw new Error(result?.res_msg || result?.res_message || `批量任务创建失败 type=${type}`);
        }
        if (result.taskId) {
            await this._waitBatchTask(cloud189, type, result.taskId);
        }
        return result;
    }

    async _waitBatchTask(cloud189, type, taskId, maxWaitMs = 30000) {
        const start = Date.now();
        let lastStatus = 0;

        while (Date.now() - start < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const result = await cloud189.checkTaskStatus(taskId, { type });
            if (!result || result.res_code != null && result.res_code != 0) {
                throw new Error(result?.res_msg || result?.res_message || `批量任务查询失败 type=${type}`);
            }
            lastStatus = Number(result.taskStatus ?? lastStatus);

            if (lastStatus === 4) return;
            if (lastStatus === 2) throw new Error(`批量任务冲突 type=${type}`);
            if (lastStatus != null && lastStatus < 0) throw new Error(`批量任务失败 type=${type} taskStatus=${lastStatus}`);
        }
        throw new Error(`批量任务超时 taskStatus=${lastStatus}`);
    }
}

module.exports = { CasCleanupService };
