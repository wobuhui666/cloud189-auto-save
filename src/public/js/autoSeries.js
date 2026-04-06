let autoSeriesDefaults = {
    accountId: '',
    targetFolderId: '',
    targetFolder: ''
};

async function createAutoSeries(event) {
    event.preventDefault();
    const title = document.getElementById('autoSeriesTitle').value.trim();
    const year = document.getElementById('autoSeriesYear').value.trim();
    const mode = document.getElementById('autoSeriesMode').value;
    if (!title) {
        message.warning('剧名不能为空');
        return;
    }
    loading.show();
    try {
        const response = await fetch('/api/auto-series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, year, mode })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '自动追剧失败');
        }
        const createdTaskCount = Number(data.data?.taskCount || 0);
        if (mode === 'lazy') {
            message.success(createdTaskCount > 0
                ? `已创建懒转存任务：${data.data.taskName}`
                : `已生成懒转存STRM：${data.data.taskName}`);
        } else {
            message.success(`已自动创建并执行：${data.data.taskName}`);
        }
        document.getElementById('autoSeriesForm').reset();
        document.getElementById('autoSeriesMode').value = mode;
        await fetchTasks();
        await fetchOrganizerTasks();
        if (mode === 'lazy' && createdTaskCount <= 0) {
            document.querySelector('.tab[data-tab="strmConfig"]')?.click();
        } else {
            document.querySelector('.tab[data-tab="task"]')?.click();
        }
    } catch (error) {
        message.warning('自动追剧失败: ' + error.message);
    } finally {
        loading.hide();
    }
}

function updateAutoSeriesDefaultsSummary() {
    const summary = document.getElementById('autoSeriesDefaultsSummary');
    if (!summary) {
        return;
    }
    const account = accountsList.find(item => String(item.id) === String(autoSeriesDefaults.accountId));
    if (!account || !autoSeriesDefaults.targetFolderId || !autoSeriesDefaults.targetFolder) {
        summary.innerHTML = '请先到“系统”页配置自动追剧默认账号和默认保存目录。';
        summary.style.color = '#ff4d4f';
        return;
    }
    summary.style.color = '#666';
    const localStrmPrefix = account.localStrmPrefix || '未配置';
    summary.innerHTML = `
        <div><strong>默认账号：</strong>${getAccountDisplayName(account)}</div>
        <div style="margin-top: 6px;"><strong>默认目录：</strong>${autoSeriesDefaults.targetFolder}</div>
        <div style="margin-top: 6px;"><strong>本地STRM目录：</strong>${localStrmPrefix}</div>
    `;
}

function showAutoSeriesDefaultsHint() {
    updateAutoSeriesDefaultsSummary();
    const summary = document.getElementById('autoSeriesDefaultsSummary')?.innerText || '请先配置默认值';
    message.info(summary);
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('autoSeriesForm')?.addEventListener('submit', createAutoSeries);
});
