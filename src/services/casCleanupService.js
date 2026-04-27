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
            const deleteResult = await this._createBatchTask(cloud189, 'DELETE', 
                [{ fileId, fileName, isFolder: 0 }], 
                isFamily
            );

            if (deleteResult?.taskId) {
                await this._waitBatchTask(cloud189, 'DELETE', deleteResult.taskId);
            }

            // 2. 清空回收站
            const clearResult = await this._createBatchTask(cloud189, 'CLEAR_RECYCLE',
                [{ fileId, fileName, isFolder: 0 }],
                isFamily
            );

            if (clearResult?.taskId) {
                await this._waitBatchTask(cloud189, 'CLEAR_RECYCLE', clearResult.taskId);
            }

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
            await cloud189.deleteFile(fileId);
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

        const deleteResult = await this._createBatchTask(cloud189, 'DELETE', taskInfos, isFamily);
        if (deleteResult?.taskId) {
            await this._waitBatchTask(cloud189, 'DELETE', deleteResult.taskId);
        }

        const clearResult = await this._createBatchTask(cloud189, 'CLEAR_RECYCLE', taskInfos, isFamily);
        if (clearResult?.taskId) {
            await this._waitBatchTask(cloud189, 'CLEAR_RECYCLE', clearResult.taskId);
        }
    }

    async _createBatchTask(cloud189, type, taskInfos, isFamily = false) {
        const accessToken = await cloud189.client.getAccessToken();
        if (!accessToken) {
            throw new Error('无法获取 AccessToken');
        }

        const timestamp = String(Date.now());
        const formParams = { type, taskInfos: JSON.stringify(taskInfos) };

        if (isFamily && cloud189.FamilyID) {
            formParams.familyId = String(cloud189.FamilyID);
        }

        return await cloud189._makeSignedRequest('/open/batch/createBatchTask.action', formParams, accessToken, timestamp);
    }

    async _waitBatchTask(cloud189, type, taskId, maxWaitMs = 30000) {
        const accessToken = await cloud189.client.getAccessToken();
        const start = Date.now();
        let lastStatus = 0;

        while (Date.now() - start < maxWaitMs) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const timestamp = String(Date.now());
            const checkParams = { type, taskId: String(taskId) };

            const result = await cloud189._makeSignedRequest('/open/batch/checkBatchTask.action', checkParams, accessToken, timestamp);
            lastStatus = result.taskStatus ?? lastStatus;

            if (lastStatus === 4) return;
            if (lastStatus === 2) throw new Error(`批量任务冲突 type=${type}`);
            if (lastStatus != null && lastStatus < 0) throw new Error(`批量任务失败 type=${type} taskStatus=${lastStatus}`);
        }
        throw new Error(`批量任务超时 taskStatus=${lastStatus}`);
    }
}

module.exports = { CasCleanupService };
