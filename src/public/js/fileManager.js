const fileManagerState = {
    accountId: '',
    path: [{ id: '-11', name: '根目录' }],
    entries: [],
    selectedIds: new Set(),
    filterKeyword: '',
    driveLabel: '',
    initialized: false,
    loading: false,
    requestToken: 0
};

function initFileManager() {
    const accountSelect = document.getElementById('fileManagerAccountId');
    const searchInput = document.getElementById('fileManagerSearch');
    if (!accountSelect) {
        return;
    }
    if (fileManagerState.initialized) {
        return;
    }
    fileManagerState.initialized = true;

    accountSelect.addEventListener('change', async (event) => {
        fileManagerState.accountId = event.target.value;
        resetFileManagerNavigation();
        if (fileManagerState.accountId) {
            await loadFileManagerEntries('-11');
        } else {
            renderFileManager();
        }
    });

    document.getElementById('fileManagerRefreshBtn').addEventListener('click', async () => {
        if (!fileManagerState.accountId) {
            message.warning('请先选择账号');
            return;
        }
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    });

    document.getElementById('fileManagerBackBtn').addEventListener('click', async () => {
        if (!fileManagerState.accountId) {
            message.warning('请先选择账号');
            return;
        }
        if (fileManagerState.path.length <= 1) {
            message.warning('已经在根目录');
            return;
        }
        fileManagerState.path = fileManagerState.path.slice(0, -1);
        fileManagerState.selectedIds.clear();
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    });

    document.getElementById('fileManagerCreateFolderBtn').addEventListener('click', async () => {
        if (!fileManagerState.accountId) {
            message.warning('请先选择账号');
            return;
        }
        const folderName = prompt('请输入新目录名称');
        if (folderName === null) {
            return;
        }
        const normalizedName = folderName.trim();
        if (!normalizedName) {
            message.warning('目录名称不能为空');
            return;
        }
        await createFileManagerFolder(normalizedName);
    });

    document.getElementById('fileManagerDeleteBtn').addEventListener('click', async () => {
        if (!fileManagerState.accountId) {
            message.warning('请先选择账号');
            return;
        }
        const selectedEntries = getSelectedFileManagerEntries();
        if (!selectedEntries.length) {
            message.warning('请先选择文件');
            return;
        }
        if (!confirm(`确定删除选中的 ${selectedEntries.length} 个项目吗？`)) {
            return;
        }
        await deleteFileManagerEntries(selectedEntries);
    });

    document.getElementById('fileManagerMoveBtn').addEventListener('click', async () => {
        if (!fileManagerState.accountId) {
            message.warning('请先选择账号');
            return;
        }
        const selectedEntries = getSelectedFileManagerEntries();
        if (!selectedEntries.length) {
            message.warning('请先选择文件');
            return;
        }
        await openFileManagerMoveSelector(selectedEntries);
    });

    searchInput?.addEventListener('input', (event) => {
        fileManagerState.filterKeyword = event.target.value.trim();
        renderFileManager();
    });

    document.getElementById('fileManagerSelectAll').addEventListener('change', (event) => {
        const visibleEntries = getVisibleFileManagerEntries();
        fileManagerState.selectedIds.clear();
        if (event.target.checked) {
            visibleEntries.forEach((entry) => fileManagerState.selectedIds.add(entry.id));
        }
        renderFileManager();
    });

    renderFileManager();
}

function updateFileManagerAccountOptions() {
    const accountSelect = document.getElementById('fileManagerAccountId');
    if (!accountSelect) {
        return;
    }
    const availableAccounts = (accountsList || []).filter((account) => !(account.original_username || '').startsWith('n_'));
    const previousValue = fileManagerState.accountId || accountSelect.value;
    accountSelect.innerHTML = availableAccounts.length
        ? availableAccounts.map((account) => `<option value="${account.id}">${escapeHtml(getAccountDisplayName(account))}</option>`).join('')
        : '<option value="">暂无可用账号</option>';

    const targetAccount = availableAccounts.find((account) => String(account.id) === String(previousValue))
        || availableAccounts.find((account) => account.isDefault)
        || availableAccounts[0];

    const currentAccountId = fileManagerState.accountId;
    fileManagerState.accountId = targetAccount ? String(targetAccount.id) : '';
    accountSelect.value = fileManagerState.accountId;

    if (!fileManagerState.accountId) {
        resetFileManagerNavigation();
        renderFileManager();
        return;
    }

    if (String(currentAccountId || '') !== String(fileManagerState.accountId || '')) {
        resetFileManagerNavigation();
    }

    if (!fileManagerState.loading) {
        loadFileManagerEntries(getCurrentFileManagerFolderId());
    }
}

async function loadFileManagerEntries(folderId = '-11') {
    if (!fileManagerState.accountId) {
        return;
    }
    const requestToken = ++fileManagerState.requestToken;
    fileManagerState.loading = true;
    const refreshButton = document.getElementById('fileManagerRefreshBtn');
    refreshButton?.classList.add('loading');
    renderFileManager();
    try {
        const response = await fetch(`/api/file-manager/list?accountId=${encodeURIComponent(fileManagerState.accountId)}&folderId=${encodeURIComponent(folderId)}`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '加载文件失败');
        }
        if (requestToken !== fileManagerState.requestToken) {
            return;
        }
        fileManagerState.entries = data.data.entries || [];
        fileManagerState.driveLabel = data.data.driveLabel || '';
        fileManagerState.selectedIds.clear();
        const selectAll = document.getElementById('fileManagerSelectAll');
        if (selectAll) {
            selectAll.checked = false;
        }
        renderFileManager();
    } catch (error) {
        if (requestToken === fileManagerState.requestToken) {
            message.warning('加载文件失败: ' + error.message);
        }
    } finally {
        if (requestToken === fileManagerState.requestToken) {
            fileManagerState.loading = false;
            refreshButton?.classList.remove('loading');
            renderFileManager();
        }
    }
}

function renderFileManager() {
    renderFileManagerBreadcrumbs();
    renderFileManagerTable();
    renderFileManagerSummary();
    updateFileManagerControls();
}

function renderFileManagerBreadcrumbs() {
    const container = document.getElementById('fileManagerBreadcrumbs');
    if (!container) {
        return;
    }
    container.innerHTML = fileManagerState.path.map((segment, index) => {
        const separator = index === 0 ? '' : '<span class="file-manager-separator">/</span>';
        return `${separator}<button type="button" class="file-manager-breadcrumb ${index === fileManagerState.path.length - 1 ? 'active' : ''}" data-index="${index}">${escapeHtml(segment.name)}</button>`;
    }).join('');

    container.querySelectorAll('.file-manager-breadcrumb').forEach((button) => {
        button.addEventListener('click', async () => {
            const index = parseInt(button.dataset.index);
            if (Number.isNaN(index) || index === fileManagerState.path.length - 1) {
                return;
            }
            fileManagerState.path = fileManagerState.path.slice(0, index + 1);
            fileManagerState.selectedIds.clear();
            await loadFileManagerEntries(getCurrentFileManagerFolderId());
        });
    });
}

function renderFileManagerSummary() {
    const summary = document.getElementById('fileManagerSummary');
    if (!summary) {
        return;
    }
    const visibleEntries = getVisibleFileManagerEntries();
    const folderCount = visibleEntries.filter((entry) => entry.isFolder).length;
    const fileCount = visibleEntries.length - folderCount;
    const selectedCount = getSelectedFileManagerEntries().length;
    const prefix = fileManagerState.driveLabel ? `${fileManagerState.driveLabel} · ` : '';
    const currentPath = fileManagerState.path.map((segment) => segment.name).join(' / ');
    if (!fileManagerState.accountId) {
        summary.textContent = '请选择账号后开始浏览';
        return;
    }
    const filterText = fileManagerState.filterKeyword
        ? ` · 已筛选 ${visibleEntries.length}/${fileManagerState.entries.length} 项`
        : '';
    const selectedText = selectedCount ? ` · 已选 ${selectedCount} 项` : '';
    summary.textContent = `${prefix}${currentPath} · ${folderCount} 个文件夹，${fileCount} 个文件${filterText}${selectedText}`;
}

function renderFileManagerTable() {
    const tbody = document.querySelector('#fileManagerTable tbody');
    if (!tbody) {
        return;
    }
    const visibleEntries = getVisibleFileManagerEntries();
    if (!visibleEntries.length) {
        const emptyText = fileManagerState.entries.length
            ? '当前筛选条件下没有匹配项'
            : (fileManagerState.loading ? '正在加载目录内容...' : '当前目录暂无内容');
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="file-manager-empty">${emptyText}</td>
            </tr>
        `;
        syncFileManagerSelectAll();
        return;
    }

    tbody.innerHTML = visibleEntries.map((entry) => `
        <tr>
            <td>
                <input type="checkbox" class="file-manager-select" data-id="${escapeHtml(entry.id)}" ${fileManagerState.selectedIds.has(entry.id) ? 'checked' : ''}>
            </td>
            <td>
                <button type="button" class="file-manager-name ${entry.isFolder ? 'folder' : 'file'}" data-action="${entry.isFolder ? 'open' : 'noop'}" data-id="${escapeHtml(entry.id)}">
                    ${entry.isFolder ? '📁' : '📄'} ${escapeHtml(entry.name)}
                </button>
            </td>
            <td>${entry.isFolder ? '文件夹' : (escapeHtml((entry.ext || '').replace('.', '').toUpperCase()) || '文件')}</td>
            <td>${entry.isFolder ? '-' : formatBytes(entry.size || 0)}</td>
            <td>${escapeHtml(entry.lastOpTime || '-')}</td>
            <td>
                <div class="file-manager-actions">
                    ${entry.isFolder ? `<button type="button" class="btn-small btn-default" data-action="open" data-id="${escapeHtml(entry.id)}">打开</button>` : ''}
                    <button type="button" class="btn-small btn-default" data-action="move" data-id="${escapeHtml(entry.id)}">移动</button>
                    <button type="button" class="btn-small btn-default" data-action="rename" data-id="${escapeHtml(entry.id)}">重命名</button>
                    ${entry.isFolder ? '' : `<button type="button" class="btn-small btn-default" data-action="open-link" data-id="${escapeHtml(entry.id)}">打开直链</button>`}
                    ${entry.isFolder ? '' : `<button type="button" class="btn-small btn-default" data-action="copy-link" data-id="${escapeHtml(entry.id)}">复制直链</button>`}
                    <button type="button" class="btn-small btn-danger" data-action="delete" data-id="${escapeHtml(entry.id)}">删除</button>
                </div>
            </td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.file-manager-select').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                fileManagerState.selectedIds.add(checkbox.dataset.id);
            } else {
                fileManagerState.selectedIds.delete(checkbox.dataset.id);
            }
            syncFileManagerSelectAll();
        });
    });

    tbody.querySelectorAll('[data-action]').forEach((button) => {
        button.addEventListener('click', async () => {
            const entry = fileManagerState.entries.find((item) => item.id === button.dataset.id);
            if (!entry) {
                return;
            }
            const action = button.dataset.action;
            if (action === 'open' && entry.isFolder) {
                fileManagerState.path = [...fileManagerState.path, { id: entry.id, name: entry.name }];
                fileManagerState.selectedIds.clear();
                await loadFileManagerEntries(entry.id);
                return;
            }
            if (action === 'rename') {
                const newName = prompt('请输入新的名称', entry.name);
                if (newName === null) {
                    return;
                }
                const normalizedName = newName.trim();
                if (!normalizedName || normalizedName === entry.name) {
                    return;
                }
                await renameFileManagerEntry(entry, normalizedName);
                return;
            }
            if (action === 'move') {
                await openFileManagerMoveSelector([entry]);
                return;
            }
            if (action === 'delete') {
                if (!confirm(`确定删除 ${entry.name} 吗？`)) {
                    return;
                }
                await deleteFileManagerEntries([entry]);
                return;
            }
            if (action === 'copy-link' && !entry.isFolder) {
                await copyFileManagerDownloadLink(entry);
            }
            if (action === 'open-link' && !entry.isFolder) {
                await openFileManagerDownloadLink(entry);
            }
        });
    });

    syncFileManagerSelectAll();
}

function syncFileManagerSelectAll() {
    const selectAll = document.getElementById('fileManagerSelectAll');
    if (!selectAll) {
        return;
    }
    const visibleEntries = getVisibleFileManagerEntries();
    const selectedVisibleCount = visibleEntries.filter((entry) => fileManagerState.selectedIds.has(entry.id)).length;
    selectAll.checked = visibleEntries.length > 0 && selectedVisibleCount === visibleEntries.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleEntries.length;
}

function getCurrentFileManagerFolderId() {
    return fileManagerState.path[fileManagerState.path.length - 1]?.id || '-11';
}

function getSelectedFileManagerEntries() {
    return fileManagerState.entries.filter((entry) => fileManagerState.selectedIds.has(entry.id));
}

function getVisibleFileManagerEntries() {
    const keyword = fileManagerState.filterKeyword.trim().toLowerCase();
    if (!keyword) {
        return fileManagerState.entries;
    }
    return fileManagerState.entries.filter((entry) => {
        const fileTypeLabel = entry.isFolder ? '文件夹' : (entry.ext || '');
        return String(entry.name || '').toLowerCase().includes(keyword)
            || String(fileTypeLabel).toLowerCase().includes(keyword);
    });
}

function resetFileManagerNavigation() {
    fileManagerState.path = [{ id: '-11', name: '根目录' }];
    fileManagerState.entries = [];
    fileManagerState.selectedIds.clear();
    fileManagerState.filterKeyword = '';
    fileManagerState.driveLabel = '';
    const searchInput = document.getElementById('fileManagerSearch');
    if (searchInput) {
        searchInput.value = '';
    }
    const selectAll = document.getElementById('fileManagerSelectAll');
    if (selectAll) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
    }
}

function updateFileManagerControls() {
    const hasAccount = Boolean(fileManagerState.accountId);
    const hasSelection = getSelectedFileManagerEntries().length > 0;
    const isRootFolder = fileManagerState.path.length <= 1;
    const searchInput = document.getElementById('fileManagerSearch');
    const refreshButton = document.getElementById('fileManagerRefreshBtn');
    const backButton = document.getElementById('fileManagerBackBtn');
    const createFolderButton = document.getElementById('fileManagerCreateFolderBtn');
    const moveButton = document.getElementById('fileManagerMoveBtn');
    const deleteButton = document.getElementById('fileManagerDeleteBtn');
    const selectAll = document.getElementById('fileManagerSelectAll');

    if (refreshButton) {
        refreshButton.disabled = !hasAccount || fileManagerState.loading;
    }
    if (backButton) {
        backButton.disabled = !hasAccount || isRootFolder || fileManagerState.loading;
    }
    if (createFolderButton) {
        createFolderButton.disabled = !hasAccount || fileManagerState.loading;
    }
    if (moveButton) {
        moveButton.disabled = !hasAccount || !hasSelection || fileManagerState.loading;
    }
    if (deleteButton) {
        deleteButton.disabled = !hasAccount || !hasSelection || fileManagerState.loading;
    }
    if (searchInput) {
        searchInput.disabled = !hasAccount || fileManagerState.loading;
    }
    if (selectAll) {
        selectAll.disabled = !hasAccount || fileManagerState.loading || !getVisibleFileManagerEntries().length;
    }
}

async function openFileManagerMoveSelector(entries) {
    const selector = new FolderSelector({
        title: '选择目标目录',
        enableFavorites: true,
        favoritesKey: 'fileManagerMoveFavorites',
        onConfirm: async function () {
            if (!this.selectedNode) {
                message.warning('请选择目标目录');
                return;
            }
            const targetFolderId = String(this.selectedNode.id || '');
            if (!targetFolderId) {
                message.warning('请选择目标目录');
                return;
            }
            if (targetFolderId === String(getCurrentFileManagerFolderId())) {
                message.warning('目标目录不能与当前目录相同');
                return;
            }
            if (entries.some((entry) => entry.isFolder && String(entry.id) === targetFolderId)) {
                message.warning('不能把目录移动到它自己里面');
                return;
            }
            const targetPath = this.currentPath.join('/') || '/';
            await moveFileManagerEntries(entries, targetFolderId, targetPath);
            this.close();
        }
    });
    selector.setAccountId(fileManagerState.accountId);
    await selector.show(fileManagerState.accountId);
}

async function createFileManagerFolder(folderName) {
    try {
        const response = await fetch('/api/file-manager/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: fileManagerState.accountId,
                parentFolderId: getCurrentFileManagerFolderId(),
                folderName
            })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '创建目录失败');
        }
        message.success('目录创建成功');
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    } catch (error) {
        message.warning('创建目录失败: ' + error.message);
    }
}

async function renameFileManagerEntry(entry, destFileName) {
    try {
        const response = await fetch('/api/file-manager/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: fileManagerState.accountId,
                fileId: entry.id,
                destFileName
            })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '重命名失败');
        }
        message.success('重命名成功');
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    } catch (error) {
        message.warning('重命名失败: ' + error.message);
    }
}

async function deleteFileManagerEntries(entries) {
    try {
        const response = await fetch('/api/file-manager/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: fileManagerState.accountId,
                entries: entries.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    isFolder: entry.isFolder
                }))
            })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '删除失败');
        }
        message.success(entries.length > 1 ? '批量删除成功' : '删除成功');
        fileManagerState.selectedIds.clear();
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    } catch (error) {
        message.warning('删除失败: ' + error.message);
    }
}

async function moveFileManagerEntries(entries, targetFolderId, targetPath) {
    try {
        const response = await fetch('/api/file-manager/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountId: fileManagerState.accountId,
                targetFolderId,
                entries: entries.map((entry) => ({
                    id: entry.id,
                    name: entry.name,
                    isFolder: entry.isFolder
                }))
            })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error || '移动失败');
        }
        message.success(`已移动到 ${targetPath}`);
        fileManagerState.selectedIds.clear();
        await loadFileManagerEntries(getCurrentFileManagerFolderId());
    } catch (error) {
        message.warning('移动失败: ' + error.message);
    }
}

async function copyFileManagerDownloadLink(entry) {
    try {
        const downloadUrl = await getFileManagerDownloadLink(entry);
        await copyTextToClipboard(downloadUrl);
        message.success('直链已复制');
    } catch (error) {
        message.warning('获取直链失败: ' + error.message);
    }
}

async function openFileManagerDownloadLink(entry) {
    try {
        const downloadUrl = await getFileManagerDownloadLink(entry);
        window.open(downloadUrl, '_blank', 'noopener');
    } catch (error) {
        message.warning('获取直链失败: ' + error.message);
    }
}

async function getFileManagerDownloadLink(entry) {
    const response = await fetch(`/api/file-manager/download-link?accountId=${encodeURIComponent(fileManagerState.accountId)}&fileId=${encodeURIComponent(entry.id)}`);
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || '获取直链失败');
    }
    return data.data.url;
}

async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
