// 修改任务相关功能
let shareFolderSelector = new FolderSelector({
    apiUrl: "/api/share/folders",
    onSelect: ({ id, name, path }) => {
        document.getElementById('shareFolder').value = path;
        document.getElementById('shareFolderId').value = id;
    },
    buildParams: (accountId, folderId) => {
        const taskId = document.getElementById('editTaskId').value;
        return `${accountId}?folderId=${folderId}&taskId=${taskId}`;
    }
});

let editFolderSelector = new FolderSelector({
    onSelect: ({ id, name, path }) => {
        document.getElementById('editRealFolder').value = path;
        document.getElementById('editRealFolderId').value = id;
    }
});

function showEditTaskModal(id) {
    const task = getTaskById(id)
    document.getElementById('editTaskId').value = id;
    document.getElementById('editResourceName').value = task.resourceName;
    document.getElementById('editRealFolder').value = task.realFolderName?task.realFolderName:task.realFolderId;
    document.getElementById('editRealFolderId').value = task.realFolderId;
    document.getElementById('editCurrentEpisodes').value = task.currentEpisodes;
    document.getElementById('editTotalEpisodes').value = task.totalEpisodes;
    document.getElementById('editStatus').value = task.status;
    document.getElementById('shareLink').value = task.shareLink;
    document.getElementById('shareFolder').value = task.shareFolderName;
    document.getElementById('shareFolderId').value = task.shareFolderId;
    document.getElementById('editMatchPattern').value = task.matchPattern;
    document.getElementById('editMatchOperator').value = task.matchOperator;
    document.getElementById('editMatchValue').value = task.matchValue;
    document.getElementById('editSourceRegex').value = task.sourceRegex || '';
    document.getElementById('editTargetRegex').value = task.targetRegex || '';
    document.getElementById('editRegexPresetSelect').value = '';
    document.getElementById('editRemark').value = task.remark;
    document.getElementById('editTaskGroup').value = task.taskGroup || '';
    document.getElementById('editSelectedTmdbId').value = task.tmdbId || '';
    document.getElementById('editTmdbKeyword').value = task.resourceName || '';
    document.getElementById('editTmdbYear').value = '';
    document.getElementById('editTaskModal').style.display = 'block';
    document.getElementById('editEnableCron').checked = task.enableCron;
    document.getElementById('editCronExpression').value = task.cronExpression;
    document.getElementById('editAccountId').value = task.accountId;

    document.getElementsByClassName('cronExpression-box')[1].style.display = task.enableCron?'block':'none';
    document.getElementById('editEnableTaskScraper').checked = task?.enableTaskScraper;
    renderEditTaskTmdbSelection(task.tmdbId ? `当前已关联 TMDB ID: ${task.tmdbId}` : '当前未关联 TMDB');
}

function closeEditTaskModal() {
    clearEditTaskTmdbSelection(false);
    document.getElementById('editTaskModal').style.display = 'none';
}

function renderEditTaskTmdbSelection(text) {
    document.getElementById('editTmdbSearchResults').innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div style="color: ${text.includes('未关联') ? '#999' : '#52c41a'};">${text}</div>
            <button type="button" class="btn-default" onclick="clearEditTaskTmdbSelection()">清空</button>
        </div>
    `;
}

function clearEditTaskTmdbSelection(render = true) {
    document.getElementById('editSelectedTmdbId').value = '';
    if (render) {
        renderEditTaskTmdbSelection('当前未关联 TMDB');
    } else {
        document.getElementById('editTmdbSearchResults').innerHTML = '';
    }
}

function selectEditTaskTmdbResult(id, type, title) {
    document.getElementById('editSelectedTmdbId').value = id;
    renderEditTaskTmdbSelection(`已关联 TMDB: ${title}`);
}

async function searchTmdbForEditTask() {
    await searchTmdb({
        keyword: document.getElementById('editTmdbKeyword').value.trim(),
        year: document.getElementById('editTmdbYear').value.trim(),
        resultContainer: document.getElementById('editTmdbSearchResults'),
        onSelect: (item, title) => selectEditTaskTmdbResult(String(item.id), item.type, title)
    });
}

function initEditTaskForm() {
    document.getElementById('shareFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('editAccountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        shareFolderSelector.show(accountId);
    });

    // 更新目录也改为点击触发
    document.getElementById('editRealFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('editAccountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        editFolderSelector.show(accountId);
    });

    document.getElementById('editEnableCron').addEventListener('change', function() {
        const cronInput = document.getElementsByClassName('cronExpression-box')[1];
        cronInput.style.display = this.checked ? 'block' : 'none';
    });

    document.getElementById('editTmdbKeyword').addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchTmdbForEditTask();
        }
    });

    document.getElementById('editTaskForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('editTaskId').value;
        const resourceName = document.getElementById('editResourceName').value;
        const realFolderId = document.getElementById('editRealFolderId').value;
        const realFolderName = document.getElementById('editRealFolder').value;
        const currentEpisodes = document.getElementById('editCurrentEpisodes').value;
        const totalEpisodes = document.getElementById('editTotalEpisodes').value;
        const shareFolderName = document.getElementById('shareFolder').value;
        const shareFolderId = document.getElementById('shareFolderId').value;
        const status = document.getElementById('editStatus').value;

        const matchPattern = document.getElementById('editMatchPattern').value
        const matchOperator = document.getElementById('editMatchOperator').value
        const matchValue = document.getElementById('editMatchValue').value
        const sourceRegex = document.getElementById('editSourceRegex').value;
        const targetRegex = document.getElementById('editTargetRegex').value;
        const remark = document.getElementById('editRemark').value
        const taskGroup = document.getElementById('editTaskGroup').value.trim();
        const tmdbId = document.getElementById('editSelectedTmdbId').value || null;

        const enableCron = document.getElementById('editEnableCron').checked;
        const cronExpression = document.getElementById('editCronExpression').value;
        const enableTaskScraper = document.getElementById('editEnableTaskScraper').checked;

        if (targetRegex && !sourceRegex) {
            message.warning('填了目标正则, 那么源正则就必须填');
            return;
        }

        try {
            loading.show()
            const response = await fetch(`/api/tasks/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    resourceName,
                    realFolderId,
                    currentEpisodes: currentEpisodes?parseInt(currentEpisodes):0,
                    totalEpisodes: totalEpisodes?parseInt(totalEpisodes):0,
                    status,
                    shareFolderName,
                    shareFolderId,
                    realFolderName,
                    sourceRegex,
                    targetRegex,
                    matchPattern,
                    matchOperator,
                    matchValue,
                    remark,
                    taskGroup,
                    tmdbId,
                    enableCron,
                    cronExpression,
                    enableTaskScraper
                })
            });
            loading.hide()
            if (response.ok) {
                closeEditTaskModal();
                await fetchTasks();
            } else {
                const error = await response.json();
                message.warning(error.message || '修改任务失败');
            }
        } catch (error) {
            message.warning('修改任务失败：' + error.message);
        }
    });
}
