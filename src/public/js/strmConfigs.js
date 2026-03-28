let strmConfigList = [];
let strmConfigDirectories = [];
let strmConfigDirectorySelector = null;

async function fetchStrmConfigs() {
    try {
        const response = await fetch('/api/strm/configs');
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        strmConfigList = data.data || [];
        renderStrmConfigTable();
    } catch (error) {
        message.warning('加载STRM配置失败: ' + error.message);
    }
}

function renderStrmConfigTable() {
    const tbody = document.querySelector('#strmConfigTable tbody');
    if (!tbody) {
        return;
    }
    tbody.innerHTML = '';
    if (!strmConfigList.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">暂无STRM配置</td></tr>';
        return;
    }

    strmConfigList.forEach(config => {
        const tr = document.createElement('tr');
        const targetText = config.type === 'normal'
            ? buildNormalStrmTargetText(config)
            : buildSubscriptionStrmTargetText(config);
        const actionButtons = [
            `<button type="button" class="btn-small btn-warning" onclick="runStrmConfig(${config.id})">执行</button>`,
            `<button type="button" class="btn-small" onclick="openStrmConfigModal(${config.id})">编辑</button>`,
            `<button type="button" class="btn-small" onclick="toggleStrmConfigEnabled(${config.id}, ${config.enabled ? 'false' : 'true'})">${config.enabled ? '停用' : '启用'}</button>`
        ];
        if (config.type === 'subscription') {
            actionButtons.push(`<button type="button" class="btn-small" onclick="resetStrmConfigTime(${config.id})">重置时间</button>`);
        }
        actionButtons.push(`<button type="button" class="btn-small btn-danger" onclick="deleteStrmConfig(${config.id})">删除</button>`);

        tr.innerHTML = `
            <td>${config.name}</td>
            <td>${config.type === 'normal' ? '普通' : '订阅'}</td>
            <td>${targetText}</td>
            <td>${config.enableCron ? config.cronExpression : '未启用'}</td>
            <td>${config.enabled ? '启用' : '停用'}</td>
            <td>${formatDateTime(config.lastCheckTime)}</td>
            <td>${formatDateTime(config.lastRunAt)}</td>
            <td>${actionButtons.join(' ')}</td>
        `;
        tbody.appendChild(tr);
    });
}

function buildNormalStrmTargetText(config) {
    if (config.directories?.length) {
        return `${config.accountIds.length} 个账号 / ${config.directories.length} 个目录`;
    }
    return `${config.accountIds.length} 个账号 / 全量`;
}

function buildSubscriptionStrmTargetText(config) {
    return `${config.subscriptionId || '-'} / ${config.resourceIds.length || '全部资源'}`;
}

function renderStrmConfigAccounts(selectedIds = []) {
    const container = document.getElementById('strmConfigAccounts');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    accountsList.forEach(account => {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.alignItems = 'center';
        label.style.gap = '6px';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = account.id;
        input.checked = selectedIds.includes(account.id);
        input.addEventListener('change', () => renderStrmConfigDirectoryAccountOptions());
        label.appendChild(input);
        label.appendChild(document.createTextNode(account.alias ? `${account.username} (${account.alias})` : account.username));
        container.appendChild(label);
    });
    renderStrmConfigDirectoryAccountOptions();
}

function renderStrmConfigDirectoryAccountOptions(preferredValue = '') {
    const select = document.getElementById('strmConfigDirectoryAccountId');
    if (!select) {
        return;
    }
    const checkedIds = collectCheckedValues('strmConfigAccounts');
    const availableAccounts = checkedIds.length
        ? accountsList.filter(account => checkedIds.includes(account.id))
        : accountsList;
    const currentValue = preferredValue || select.value;
    select.innerHTML = availableAccounts.map(account => (
        `<option value="${account.id}">${account.alias ? `${account.username} (${account.alias})` : account.username}</option>`
    )).join('');
    if (!availableAccounts.length) {
        select.innerHTML = '<option value="">请先选择账号</option>';
        return;
    }
    select.value = availableAccounts.some(account => String(account.id) === String(currentValue))
        ? String(currentValue)
        : String(availableAccounts[0].id);
}

function renderStrmConfigDirectories() {
    const container = document.getElementById('strmConfigDirectories');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    if (!strmConfigDirectories.length) {
        container.innerHTML = '<div style="color: #999;">未选择目录，将按账号媒体目录整体生成。</div>';
        return;
    }
    strmConfigDirectories.forEach((directory, index) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.justifyContent = 'space-between';
        item.style.alignItems = 'center';
        item.style.gap = '8px';
        const accountLabel = getStrmConfigAccountLabel(directory.accountId);
        item.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 2px;">
                <strong>${directory.name}</strong>
                <span style="font-size: 12px; color: #666;">${accountLabel} / ${directory.path}</span>
            </div>
            <button type="button" class="btn-small btn-danger" onclick="removeStrmConfigDirectory(${index})">移除</button>
        `;
        container.appendChild(item);
    });
}

function getStrmConfigAccountLabel(accountId) {
    const account = accountsList.find(item => item.id === Number(accountId));
    if (!account) {
        return `账号${accountId}`;
    }
    return account.alias ? `${account.username} (${account.alias})` : account.username;
}

function ensureStrmConfigDirectorySelector() {
    if (strmConfigDirectorySelector) {
        return;
    }
    strmConfigDirectorySelector = new FolderSelector({
        title: '选择STRM目录',
        enableFavorites: false,
        onSelect: ({ id, name, path }) => {
            const accountId = Number(document.getElementById('strmConfigDirectoryAccountId').value);
            if (!accountId) {
                message.warning('请先选择账号');
                return;
            }
            const exists = strmConfigDirectories.findIndex(item => item.accountId === accountId && String(item.folderId) === String(id));
            const directory = {
                accountId,
                folderId: String(id),
                name,
                path
            };
            if (exists >= 0) {
                strmConfigDirectories[exists] = directory;
            } else {
                strmConfigDirectories.push(directory);
            }
            ensureStrmConfigAccountChecked(accountId);
            renderStrmConfigDirectories();
        }
    });
}

function ensureStrmConfigAccountChecked(accountId) {
    const checkbox = document.querySelector(`#strmConfigAccounts input[value="${accountId}"]`);
    if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        renderStrmConfigDirectoryAccountOptions(accountId);
    }
}

function removeStrmConfigDirectory(index) {
    strmConfigDirectories.splice(index, 1);
    renderStrmConfigDirectories();
}

function openStrmConfigDirectoryPicker() {
    ensureStrmConfigDirectorySelector();
    const accountId = document.getElementById('strmConfigDirectoryAccountId').value;
    if (!accountId) {
        message.warning('请先选择账号');
        return;
    }
    strmConfigDirectorySelector.show(accountId);
}

async function renderStrmConfigSubscriptions(selectedSubscriptionId = '', selectedResourceIds = []) {
    const subscriptionSelect = document.getElementById('strmConfigSubscriptionId');
    const resourcesContainer = document.getElementById('strmConfigResources');
    if (!subscriptionSelect || !resourcesContainer) {
        return;
    }
    subscriptionSelect.innerHTML = '<option value="">请选择订阅</option>';
    subscriptionList.forEach(subscription => {
        const option = document.createElement('option');
        option.value = subscription.id;
        option.textContent = subscription.name;
        subscriptionSelect.appendChild(option);
    });
    subscriptionSelect.value = selectedSubscriptionId ? String(selectedSubscriptionId) : '';

    resourcesContainer.innerHTML = '';
    if (!selectedSubscriptionId) {
        return;
    }
    try {
        const response = await fetch(`/api/subscriptions/${selectedSubscriptionId}/resources`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        (data.data || []).forEach(resource => {
            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '6px';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = resource.id;
            input.checked = selectedResourceIds.includes(resource.id);
            label.appendChild(input);
            label.appendChild(document.createTextNode(resource.title));
            resourcesContainer.appendChild(label);
        });
    } catch (error) {
        resourcesContainer.innerHTML = `<div style="color: #f5222d;">加载资源失败: ${error.message}</div>`;
    }
}

function updateStrmConfigTypeView() {
    const type = document.getElementById('strmConfigType').value;
    document.getElementById('strmConfigAccountsGroup').style.display = type === 'normal' ? '' : 'none';
    document.getElementById('strmConfigSubscriptionGroup').style.display = type === 'subscription' ? '' : 'none';
    document.getElementById('strmConfigResourcesGroup').style.display = type === 'subscription' ? '' : 'none';
}

async function openStrmConfigModal(id = null) {
    const form = document.getElementById('strmConfigForm');
    form.reset();
    document.getElementById('strmConfigId').value = '';
    document.getElementById('strmConfigEnabled').checked = true;
    document.getElementById('strmConfigType').value = 'normal';
    document.getElementById('strmConfigModalTitle').textContent = id ? '编辑STRM配置' : '新建STRM配置';
    strmConfigDirectories = [];
    renderStrmConfigAccounts([]);
    renderStrmConfigDirectories();
    await renderStrmConfigSubscriptions('', []);
    updateStrmConfigTypeView();

    if (id !== null) {
        const config = strmConfigList.find(item => item.id === id);
        if (!config) {
            message.warning('STRM配置不存在');
            return;
        }
        document.getElementById('strmConfigId').value = config.id;
        document.getElementById('strmConfigName').value = config.name;
        document.getElementById('strmConfigType').value = config.type;
        document.getElementById('strmConfigLocalPathPrefix').value = config.localPathPrefix || '';
        document.getElementById('strmConfigExcludePattern').value = config.excludePattern || '';
        document.getElementById('strmConfigOverwriteExisting').checked = !!config.overwriteExisting;
        document.getElementById('strmConfigEnabled').checked = config.enabled !== false;
        document.getElementById('strmConfigEnableCron').checked = !!config.enableCron;
        document.getElementById('strmConfigCronExpression').value = config.cronExpression || '';
        strmConfigDirectories = (config.directories || []).map(item => ({ ...item, accountId: Number(item.accountId) }));
        renderStrmConfigAccounts(config.accountIds || []);
        renderStrmConfigDirectories();
        await renderStrmConfigSubscriptions(config.subscriptionId || '', config.resourceIds || []);
        updateStrmConfigTypeView();
    }

    document.getElementById('strmConfigModal').style.display = 'block';
}

function closeStrmConfigModal() {
    document.getElementById('strmConfigModal').style.display = 'none';
}

function collectCheckedValues(containerId) {
    return Array.from(document.querySelectorAll(`#${containerId} input[type="checkbox"]:checked`)).map(input => Number(input.value));
}

async function saveStrmConfig(event) {
    event.preventDefault();
    const id = document.getElementById('strmConfigId').value;
    const type = document.getElementById('strmConfigType').value;
    const payload = {
        name: document.getElementById('strmConfigName').value.trim(),
        type,
        accountIds: collectCheckedValues('strmConfigAccounts'),
        directories: strmConfigDirectories,
        subscriptionId: document.getElementById('strmConfigSubscriptionId').value || null,
        resourceIds: collectCheckedValues('strmConfigResources'),
        localPathPrefix: document.getElementById('strmConfigLocalPathPrefix').value.trim(),
        excludePattern: document.getElementById('strmConfigExcludePattern').value.trim(),
        overwriteExisting: document.getElementById('strmConfigOverwriteExisting').checked,
        enabled: document.getElementById('strmConfigEnabled').checked,
        enableCron: document.getElementById('strmConfigEnableCron').checked,
        cronExpression: document.getElementById('strmConfigCronExpression').value.trim()
    };

    try {
        const response = await fetch(id ? `/api/strm/configs/${id}` : '/api/strm/configs', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        closeStrmConfigModal();
        await fetchStrmConfigs();
        message.success('STRM配置保存成功');
    } catch (error) {
        message.warning('STRM配置保存失败: ' + error.message);
    }
}

async function runStrmConfig(id) {
    try {
        const response = await fetch(`/api/strm/configs/${id}/run`, {
            method: 'POST'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchStrmConfigs();
        message.success(data.data || 'STRM配置执行完成');
    } catch (error) {
        message.warning('STRM配置执行失败: ' + error.message);
    }
}

async function toggleStrmConfigEnabled(id, enabled) {
    try {
        const response = await fetch(`/api/strm/configs/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchStrmConfigs();
        message.success(enabled ? 'STRM配置已启用' : 'STRM配置已停用');
    } catch (error) {
        message.warning('更新STRM配置状态失败: ' + error.message);
    }
}

async function resetStrmConfigTime(id) {
    if (!confirm('确定要重置该订阅配置的增量时间吗？')) {
        return;
    }
    try {
        const response = await fetch(`/api/strm/configs/${id}/reset`, {
            method: 'POST'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchStrmConfigs();
        message.success('订阅配置增量时间已重置');
    } catch (error) {
        message.warning('重置增量时间失败: ' + error.message);
    }
}

async function deleteStrmConfig(id) {
    if (!confirm('确定要删除这个STRM配置吗？')) {
        return;
    }
    try {
        const response = await fetch(`/api/strm/configs/${id}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchStrmConfigs();
        message.success('STRM配置删除成功');
    } catch (error) {
        message.warning('STRM配置删除失败: ' + error.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('strmConfigForm');
    const typeSelect = document.getElementById('strmConfigType');
    const subscriptionSelect = document.getElementById('strmConfigSubscriptionId');

    if (form) {
        form.addEventListener('submit', saveStrmConfig);
    }
    if (typeSelect) {
        typeSelect.addEventListener('change', updateStrmConfigTypeView);
    }
    if (subscriptionSelect) {
        subscriptionSelect.addEventListener('change', async event => {
            await renderStrmConfigSubscriptions(event.target.value, []);
        });
    }
});
