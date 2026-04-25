class BatchTaskDto {
    constructor(data) {
        this.type = data.type;
        this.taskInfos = data.taskInfos;
        this.targetFolderId = data?.targetFolderId || null;
        this.shareId = data?.shareId || null;
        this.familyId = data?.familyId || null;
        this.copyType = data?.copyType || null;
    }

    validate() {
        if (!this.taskInfos) throw new Error('任务信息不能为空');
        if (!this.type) throw new Error('任务类型不能为空');
    }
    toString() {
        return JSON.stringify(this);
    }
}

module.exports = { BatchTaskDto };
