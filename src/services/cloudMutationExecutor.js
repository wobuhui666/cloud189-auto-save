const { classifyOperationError } = require('./operationError');
const { auditService } = require('./auditService');

const DEFAULT_VERIFY_DELAYS_MS = [1000, 2000, 3000];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fileIdOf = file => String(file?.id || file?.fileId || '');
const fileNameOf = file => String(file?.name || file?.fileName || '');

const AUDIT_ACTION_BY_OPERATION = Object.freeze({
    create_folder: 'move',
    rename: 'rename',
    move: 'move',
    upload: 'upload',
    delete: 'delete'
});

function getListingItems(listing = {}) {
    const payload = listing?.fileListAO || listing || {};
    return [
        ...(Array.isArray(payload.folderList) ? payload.folderList : []),
        ...(Array.isArray(payload.fileList) ? payload.fileList : [])
    ];
}

class CloudMutationExecutor {
    constructor(options = {}) {
        this.verifyDelaysMs = options.verifyDelaysMs || DEFAULT_VERIFY_DELAYS_MS;
        this.sleep = options.sleep || sleep;
    }

    async execute(options = {}) {
        if (typeof options.mutate !== 'function' || typeof options.verify !== 'function') {
            throw new Error('CloudMutationExecutor 需要 mutate 和 verify');
        }
        const auditOperation = await auditService.planOperation(
            options.audit?.action || AUDIT_ACTION_BY_OPERATION[options.operation] || 'skip',
            {
                sourcePath: options.audit?.sourcePath,
                targetPath: options.audit?.targetPath,
                before: options.audit?.before,
                after: options.audit?.after,
                reason: options.audit?.reason || (options.operation === 'create_folder' ? '创建目标目录' : ''),
                decisionSource: options.audit?.decisionSource || options.source || 'cloud_mutation'
            }
        );
        let response;
        let mutationError = null;
        try {
            response = await options.mutate();
        } catch (error) {
            mutationError = error;
        }

        let verified = await this._verify(options.verify, response);
        if (verified) {
            await auditService.completeOperation(auditOperation, 'completed', {
                verification: { verified: true, resent: false, value: verified },
                after: options.audit?.resultAfter || verified,
                attempts: 1
            });
            return { response, verified: true, resent: false, value: verified };
        }

        if (mutationError && options.ambiguous === false) {
            await auditService.completeOperation(auditOperation, 'failed', {
                verification: { verified: false, resent: false },
                error: mutationError.message || mutationError,
                attempts: 1
            });
            throw classifyOperationError(mutationError, { source: options.source, operation: options.operation });
        }

        if (options.resend !== false) {
            try {
                response = await options.mutate();
                mutationError = null;
            } catch (error) {
                mutationError = error;
            }
            verified = await this._verify(options.verify, response);
            if (verified) {
                await auditService.completeOperation(auditOperation, 'completed', {
                    verification: { verified: true, resent: true, value: verified },
                    after: options.audit?.resultAfter || verified,
                    attempts: 2
                });
                return { response, verified: true, resent: true, value: verified };
            }
        }

        if (mutationError) {
            await auditService.completeOperation(auditOperation, 'failed', {
                verification: { verified: false, resent: options.resend !== false },
                error: mutationError.message || mutationError,
                attempts: options.resend === false ? 1 : 2
            });
            throw classifyOperationError(mutationError, { source: options.source, operation: options.operation });
        }
        await auditService.completeOperation(auditOperation, 'failed', {
            verification: { verified: false, resent: options.resend !== false },
            error: `${options.operation || '云端写操作'}写后验证失败`,
            attempts: options.resend === false ? 1 : 2
        });
        throw classifyOperationError(new Error(`${options.operation || '云端写操作'}写后验证失败`), { source: options.source, operation: options.operation });
    }

    async _verify(verify, response) {
        for (let index = 0; index < this.verifyDelaysMs.length; index++) {
            if (this.verifyDelaysMs[index] > 0) await this.sleep(this.verifyDelaysMs[index]);
            try {
                const result = await verify(response, index);
                if (result) return result;
            } catch (_) {}
        }
        return null;
    }

    async createFolder(cloud189, parentFolderId, folderName) {
        return this.execute({
            source: 'cloud189',
            operation: 'create_folder',
            audit: {
                targetPath: String(folderName || ''),
                before: { parentFolderId },
                after: { folderName },
                reason: '创建目标目录'
            },
            mutate: () => cloud189.createFolder(folderName, parentFolderId),
            verify: async response => {
                const listing = await cloud189.listFiles(parentFolderId);
                const folders = listing?.fileListAO?.folderList || [];
                const responseId = fileIdOf(response);
                return folders.find(folder => fileNameOf(folder) === String(folderName)
                    && (!responseId || fileIdOf(folder) === responseId)) || null;
            }
        });
    }

    async rename(cloud189, fileId, newName, audit = {}) {
        return this.execute({
            source: 'cloud189',
            operation: 'rename',
            audit: {
                targetPath: String(newName || ''),
                before: { fileId },
                after: { fileId, name: newName },
                ...audit
            },
            mutate: () => cloud189.renameFile(fileId, newName),
            verify: async () => {
                const info = await cloud189.getFileInfo(fileId);
                return info && fileNameOf(info) === String(newName) ? info : null;
            }
        });
    }

    async delete(cloud189, fileId, fileName, isFolder = false) {
        const mutate = isFolder && typeof cloud189.deleteFile !== 'function'
            ? null
            : () => cloud189.deleteFile(fileId, fileName);
        return this.execute({
            source: 'cloud189',
            operation: 'delete',
            audit: {
                sourcePath: String(fileName || ''),
                before: { fileId, name: fileName, isFolder },
                after: { deleted: true }
            },
            mutate,
            verify: async () => {
                const info = await cloud189.getFileInfo(fileId).catch(() => null);
                return info ? null : { deleted: true };
            }
        });
    }

    async move(cloud189, sourceParentId, targetFolderId, items, mutate, audit = {}) {
        const normalizedItems = Array.isArray(items) ? items : [items];
        return this.execute({
            source: 'cloud189',
            operation: 'move',
            audit: {
                before: { sourceParentId, itemIds: normalizedItems.map(fileIdOf) },
                after: { targetFolderId },
                ...audit
            },
            mutate,
            verify: async () => {
                const targetItems = getListingItems(await cloud189.listFiles(targetFolderId));
                const sourceItems = sourceParentId ? getListingItems(await cloud189.listFiles(sourceParentId)) : [];
                const ids = new Set(normalizedItems.map(fileIdOf).filter(Boolean));
                const targetHasAll = [...ids].every(id => targetItems.some(item => fileIdOf(item) === id));
                const sourceHasAny = [...ids].some(id => sourceItems.some(item => fileIdOf(item) === id));
                return targetHasAll && !sourceHasAny ? { moved: true } : null;
            }
        });
    }

    async upload(cloud189, parentFolderId, fileName, mutate, expected = {}) {
        return this.execute({
            source: 'cloud189',
            operation: 'upload',
            audit: {
                targetPath: String(fileName || ''),
                before: { expected },
                after: { parentFolderId, fileName }
            },
            mutate,
            verify: async response => {
                const listing = await cloud189.listFiles(parentFolderId);
                const file = (listing?.fileListAO?.fileList || []).find(item => fileNameOf(item) === String(fileName));
                if (!file) return null;
                const size = Number(file.size || file.fileSize || 0);
                if (expected.size && size && size !== Number(expected.size)) return null;
                const responseId = String(response?.fileId || response?.id || '');
                if (responseId && fileIdOf(file) !== responseId) return null;
                return file;
            }
        });
    }
}

module.exports = { CloudMutationExecutor, DEFAULT_VERIFY_DELAYS_MS, getListingItems };
