let subscriptionList = [];
let currentSubscriptionId = null;
let currentSubscriptionResources = [];
let currentSubscriptionBrowser = {
    resourceId: null,
    title: '',
    stack: [],
    keyword: ''
};
let currentSubscriptionPreview = null;

async function fetchSubscriptions() {
    try {
        const response = await fetch('/api/subscriptions');
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        subscriptionList = data.data || [];
        renderSubscriptionTable();
    } catch (error) {
        message.warning('加载订阅失败: ' + error.message);
    }
}

function formatSubscriptionRefreshStatus(subscription) {
    const statusTextMap = {
        success: '正常',
        warning: '部分异常',
        failed: '异常',
        unknown: '未校验'
    };
    const colorMap = {
        success: '#52c41a',
        warning: '#faad14',
        failed: '#ff4d4f',
        unknown: '#999'
    };
    const status = subscription.lastRefreshStatus || 'unknown';
    const summary = `${subscription.validResourceCount || 0}/${subscription.resourceCount || 0}`;
    const title = subscription.lastRefreshMessage || '暂无校验记录';
    return `<span title="${title}" style="color: ${colorMap[status] || colorMap.unknown};">${statusTextMap[status] || statusTextMap.unknown} (${summary})</span>`;
}

function formatSubscriptionAccountCoverage(subscription) {
    return `${subscription.availableAccountCount || 0}/${subscription.totalAccountCount || 0}`;
}

function formatSubscriptionVerifyStatus(resource) {
    const statusTextMap = {
        valid: '可用',
        invalid: '失效',
        unknown: '未校验'
    };
    const colorMap = {
        valid: '#52c41a',
        invalid: '#ff4d4f',
        unknown: '#999'
    };
    const status = resource.verifyStatus || 'unknown';
    return `<span title="${resource.lastVerifyError || ''}" style="color: ${colorMap[status] || colorMap.unknown};">${statusTextMap[status] || statusTextMap.unknown}</span>`;
}

function formatSubscriptionAvailableAccounts(resource) {
    const accounts = resource.availableAccounts || [];
    if (!accounts.length) {
        return '-';
    }
    return accounts.map(account => account.name).join(' / ');
}

function renderSubscriptionPreview(preview) {
    const panel = document.getElementById('subscriptionPreviewPanel');
    if (!panel) {
        return;
    }
    const statusColor = preview.canCreate ? '#52c41a' : '#faad14';
    panel.style.display = 'block';
    panel.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
            <div><strong>UUID:</strong> ${preview.uuid}</div>
            <div><strong>格式检查:</strong> <span style="color: ${preview.looksLikeUuid ? '#52c41a' : '#ff4d4f'};">${preview.looksLikeUuid ? '通过' : '可疑'}</span></div>
            <div><strong>账号数量:</strong> ${preview.accountCount} ${preview.defaultAccount ? `(默认账号: ${preview.defaultAccount.name})` : ''}</div>
            <div><strong>当前结论:</strong> <span style="color: ${statusColor};">${preview.canCreate ? '可以创建' : '建议先处理提示项'}</span></div>
            ${preview.existingSubscription ? `<div><strong>已有订阅:</strong> ${preview.existingSubscription.name} (${preview.existingSubscription.enabled ? '启用' : '停用'})</div>` : ''}
            <div><strong>建议:</strong> ${preview.recommendation}</div>
        </div>
    `;
}

async function previewSubscription() {
    const uuid = document.getElementById('subscriptionUuid').value.trim();
    if (!uuid) {
        message.warning('请先输入 UUID');
        return;
    }
    try {
        const response = await fetch(`/api/subscriptions/preview?uuid=${encodeURIComponent(uuid)}`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        currentSubscriptionPreview = data.data;
        renderSubscriptionPreview(currentSubscriptionPreview);
    } catch (error) {
        message.warning('预检查失败: ' + error.message);
    }
}

function clearSubscriptionPreview() {
    currentSubscriptionPreview = null;
    const panel = document.getElementById('subscriptionPreviewPanel');
    if (panel) {
        panel.style.display = 'none';
        panel.innerHTML = '';
    }
}

function renderSubscriptionTable() {
    const tbody = document.querySelector('#subscriptionTable tbody');
    if (!tbody) {
        return;
    }
    tbody.innerHTML = '';

    if (!subscriptionList.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">暂无订阅</td></tr>';
        return;
    }

    subscriptionList.forEach(subscription => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${subscription.name}</td>
            <td>${subscription.uuid}</td>
            <td>${subscription.resourceCount || 0}</td>
            <td>${formatSubscriptionRefreshStatus(subscription)}</td>
            <td>${formatSubscriptionAccountCoverage(subscription)}</td>
            <td>${formatDateTime(subscription.lastRefreshTime)}</td>
            <td>${subscription.enabled ? '启用' : '停用'}</td>
            <td>
                <button type="button" class="btn-small" onclick="openSubscriptionResourcesModal(${subscription.id})">资源</button>
                <button type="button" class="btn-small" onclick="refreshSubscription(${subscription.id})">校验</button>
                <button type="button" class="btn-small" onclick="openSubscriptionModal(${subscription.id})">编辑</button>
                <button type="button" class="btn-small" onclick="toggleSubscriptionStatus(${subscription.id}, ${subscription.enabled ? 'false' : 'true'})">${subscription.enabled ? '停用' : '启用'}</button>
                <button type="button" class="btn-small btn-danger" onclick="deleteSubscription(${subscription.id})">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openSubscriptionModal(id = null) {
    const form = document.getElementById('subscriptionForm');
    form.reset();
    clearSubscriptionPreview();
    document.getElementById('subscriptionId').value = '';
    document.getElementById('subscriptionEnabled').checked = true;
    document.getElementById('subscriptionModalTitle').textContent = id ? '编辑订阅' : '添加订阅';

    if (id !== null) {
        const subscription = subscriptionList.find(item => item.id === id);
        if (!subscription) {
            message.warning('订阅不存在');
            return;
        }
        document.getElementById('subscriptionId').value = subscription.id;
        document.getElementById('subscriptionUuid').value = subscription.uuid;
        document.getElementById('subscriptionName').value = subscription.name || '';
        document.getElementById('subscriptionRemark').value = subscription.remark || '';
        document.getElementById('subscriptionEnabled').checked = subscription.enabled !== false;
    }

    document.getElementById('subscriptionModal').style.display = 'block';
}

function closeSubscriptionModal() {
    clearSubscriptionPreview();
    document.getElementById('subscriptionModal').style.display = 'none';
}

async function saveSubscription(event) {
    event.preventDefault();
    const id = document.getElementById('subscriptionId').value;
    const payload = {
        uuid: document.getElementById('subscriptionUuid').value.trim(),
        name: document.getElementById('subscriptionName').value.trim(),
        remark: document.getElementById('subscriptionRemark').value.trim(),
        enabled: document.getElementById('subscriptionEnabled').checked
    };

    try {
        if (!id && currentSubscriptionPreview && currentSubscriptionPreview.canCreate === false) {
            throw new Error(currentSubscriptionPreview.recommendation || '预检查未通过');
        }
        const response = await fetch(id ? `/api/subscriptions/${id}` : '/api/subscriptions', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        closeSubscriptionModal();
        await fetchSubscriptions();
        message.success('订阅保存成功');
    } catch (error) {
        message.warning('订阅保存失败: ' + error.message);
    }
}

async function toggleSubscriptionStatus(id, enabled) {
    try {
        const response = await fetch(`/api/subscriptions/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchSubscriptions();
    } catch (error) {
        message.warning('更新状态失败: ' + error.message);
    }
}

async function deleteSubscription(id) {
    if (!confirm('确定要删除这个订阅吗？对应资源也会一起删除')) {
        return;
    }
    try {
        const response = await fetch(`/api/subscriptions/${id}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchSubscriptions();
        message.success('订阅删除成功');
    } catch (error) {
        message.warning('订阅删除失败: ' + error.message);
    }
}

async function openSubscriptionResourcesModal(subscriptionId) {
    currentSubscriptionId = subscriptionId;
    const subscription = subscriptionList.find(item => item.id === subscriptionId);
    document.getElementById('subscriptionResourcesTitle').textContent = `${subscription?.name || '订阅'}的资源`;
    document.getElementById('subscriptionResourcesModal').style.display = 'block';
    await fetchSubscriptionResources();
}

function closeSubscriptionResourcesModal() {
    document.getElementById('subscriptionResourcesModal').style.display = 'none';
}

async function fetchSubscriptionResources() {
    if (!currentSubscriptionId) {
        return;
    }
    try {
        const response = await fetch(`/api/subscriptions/${currentSubscriptionId}/resources`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        currentSubscriptionResources = data.data || [];
        renderSubscriptionResourceTable();
        await fetchSubscriptions();
    } catch (error) {
        message.warning('加载订阅资源失败: ' + error.message);
    }
}

function renderSubscriptionResourceTable() {
    const tbody = document.querySelector('#subscriptionResourceTable tbody');
    if (!tbody) {
        return;
    }
    tbody.innerHTML = '';

    if (!currentSubscriptionResources.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">暂无资源</td></tr>';
        return;
    }

    currentSubscriptionResources.forEach(resource => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${resource.title}</td>
            <td><a href="${resource.shareLink}" target="_blank" class="ellipsis" title="${resource.shareLink}">${resource.shareLink}</a></td>
            <td>${resource.isFolder ? '文件夹' : '文件'}</td>
            <td>${formatSubscriptionVerifyStatus(resource)}</td>
            <td title="${resource.lastVerifyError || ''}">${formatSubscriptionAvailableAccounts(resource)}</td>
            <td>${formatDateTime(resource.lastVerifiedAt)}</td>
            <td>${formatDateTime(resource.updatedAt)}</td>
            <td>
                <button type="button" class="btn-small" onclick="showSubscriptionVerifyDetails(${resource.id})">详情</button>
                <button type="button" class="btn-small" onclick="openSubscriptionBrowser(${resource.id})">浏览</button>
                <button type="button" class="btn-small" onclick="createTaskFromSubscriptionResource(${resource.id})">转存</button>
                <button type="button" class="btn-small btn-danger" onclick="deleteSubscriptionResource(${resource.id})">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function openSubscriptionResourceModal() {
    if (!currentSubscriptionId) {
        message.warning('请先选择订阅');
        return;
    }
    document.getElementById('subscriptionResourceForm').reset();
    document.getElementById('subscriptionResourceModal').style.display = 'block';
}

function closeSubscriptionResourceModal() {
    document.getElementById('subscriptionResourceModal').style.display = 'none';
}

async function saveSubscriptionResource(event) {
    event.preventDefault();
    if (!currentSubscriptionId) {
        message.warning('请先选择订阅');
        return;
    }
    const payload = {
        title: document.getElementById('subscriptionResourceTitle').value.trim(),
        shareLink: document.getElementById('subscriptionResourceShareLink').value.trim(),
        accessCode: document.getElementById('subscriptionResourceAccessCode').value.trim()
    };

    try {
        const response = await fetch(`/api/subscriptions/${currentSubscriptionId}/resources`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        closeSubscriptionResourceModal();
        await fetchSubscriptionResources();
        message.success('资源保存成功');
    } catch (error) {
        message.warning('资源保存失败: ' + error.message);
    }
}

async function refreshSubscription(id, options = {}) {
    const { silent = false } = options;
    try {
        const response = await fetch(`/api/subscriptions/${id}/refresh`, {
            method: 'POST'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchSubscriptions();
        if (currentSubscriptionId === id) {
            await fetchSubscriptionResources();
        }
        if (!silent) {
            const result = data.data || {};
            message.success(`订阅校验完成，可用 ${result.validResourceCount || 0} 个，异常 ${result.invalidResourceCount || 0} 个`);
        }
    } catch (error) {
        message.warning('订阅校验失败: ' + error.message);
    }
}

async function refreshCurrentSubscriptionResources() {
    if (!currentSubscriptionId) {
        message.warning('请先选择订阅');
        return;
    }
    await refreshSubscription(currentSubscriptionId);
}

function showSubscriptionVerifyDetails(resourceId) {
    const resource = currentSubscriptionResources.find(item => item.id === resourceId);
    if (!resource) {
        message.warning('资源不存在');
        return;
    }
    const details = Array.isArray(resource.verifyDetails) ? resource.verifyDetails : [];
    const modal = document.createElement('div');
    modal.className = 'modal subscription-verify-details-modal';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 760px;">
            <div class="modal-header">
                <h3>校验详情 - ${resource.title}</h3>
            </div>
            <div class="form-body">
                ${details.length ? `
                    <table>
                        <thead>
                            <tr>
                                <th>账号</th>
                                <th>状态</th>
                                <th>说明</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${details.map(item => `
                                <tr>
                                    <td>${item.accountName}</td>
                                    <td style="color: ${item.status === 'valid' ? '#52c41a' : '#ff4d4f'};">${item.status === 'valid' ? '可用' : '失败'}</td>
                                    <td style="word-break: break-all;">${item.error || '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : '<div style="text-align: center; color: #999;">暂无账号级校验记录</div>'}
            </div>
            <div class="form-actions">
                <button type="button" class="btn-default" onclick="closeSubscriptionVerifyDetailsModal()">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';
}

function closeSubscriptionVerifyDetailsModal() {
    document.querySelector('.subscription-verify-details-modal')?.remove();
}

async function deleteSubscriptionResource(id) {
    if (!confirm('确定要删除这个资源吗？')) {
        return;
    }
    try {
        const response = await fetch(`/api/subscriptions/resources/${id}`, {
            method: 'DELETE'
        });
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        await fetchSubscriptionResources();
        message.success('资源删除成功');
    } catch (error) {
        message.warning('资源删除失败: ' + error.message);
    }
}

function openSubscriptionBrowser(resourceId) {
    const resource = currentSubscriptionResources.find(item => item.id === resourceId);
    if (!resource) {
        message.warning('资源不存在');
        return;
    }
    currentSubscriptionBrowser = {
        resourceId,
        title: resource.title,
        stack: [],
        keyword: ''
    };
    document.getElementById('subscriptionBrowserTitle').textContent = `资源浏览 - ${resource.title}`;
    document.getElementById('subscriptionBrowserKeyword').value = '';
    document.getElementById('subscriptionBrowserModal').style.display = 'block';
    loadSubscriptionBrowserEntries();
}

function closeSubscriptionBrowserModal() {
    document.getElementById('subscriptionBrowserModal').style.display = 'none';
}

async function loadSubscriptionBrowserEntries() {
    if (!currentSubscriptionBrowser.resourceId) {
        return;
    }
    const tbody = document.querySelector('#subscriptionBrowserTable tbody');
    const pathLabel = document.getElementById('subscriptionBrowserPath');
    const currentFolder = currentSubscriptionBrowser.stack[currentSubscriptionBrowser.stack.length - 1];
    const pathParts = [currentSubscriptionBrowser.title, ...currentSubscriptionBrowser.stack.map(item => item.name)];
    pathLabel.textContent = pathParts.join(' / ');
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">加载中...</td></tr>';

    try {
        const response = await fetch(`/api/subscriptions/resources/${currentSubscriptionBrowser.resourceId}/browse?folderId=${encodeURIComponent(currentFolder?.id || '')}&keyword=${encodeURIComponent(currentSubscriptionBrowser.keyword || '')}`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }
        const entries = data.data || [];
        if (!entries.length) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">当前目录没有内容</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        entries.forEach(entry => {
            const tr = document.createElement('tr');
            const nameCell = document.createElement('td');
            const typeCell = document.createElement('td');
            const actionCell = document.createElement('td');

            nameCell.textContent = entry.name;
            typeCell.textContent = entry.isFolder ? '目录' : '文件';
            actionCell.appendChild(buildSubscriptionBrowserAction(entry));
            tr.appendChild(nameCell);
            tr.appendChild(typeCell);
            tr.appendChild(actionCell);
            tbody.appendChild(tr);
        });
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center;">加载失败: ${error.message}</td></tr>`;
    }
}

function buildSubscriptionBrowserAction(entry) {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.gap = '6px';

    if (entry.isFolder) {
        const browseButton = document.createElement('button');
        browseButton.type = 'button';
        browseButton.className = 'btn-small';
        browseButton.textContent = '进入';
        browseButton.onclick = () => {
            currentSubscriptionBrowser.stack.push({ id: entry.id, name: entry.name });
            currentSubscriptionBrowser.keyword = '';
            document.getElementById('subscriptionBrowserKeyword').value = '';
            loadSubscriptionBrowserEntries();
        };
        wrapper.appendChild(browseButton);
    }

    if (entry.canSave) {
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'btn-small btn-warning';
        saveButton.textContent = '转存';
        saveButton.onclick = () => createTaskFromSubscriptionResource(currentSubscriptionBrowser.resourceId, entry);
        wrapper.appendChild(saveButton);
    }

    return wrapper;
}

function goToSubscriptionBrowserParent() {
    if (currentSubscriptionBrowser.stack.length > 0) {
        currentSubscriptionBrowser.stack.pop();
        currentSubscriptionBrowser.keyword = '';
        document.getElementById('subscriptionBrowserKeyword').value = '';
        loadSubscriptionBrowserEntries();
    }
}

function refreshSubscriptionBrowser() {
    loadSubscriptionBrowserEntries();
}

function searchSubscriptionBrowser() {
    currentSubscriptionBrowser.keyword = document.getElementById('subscriptionBrowserKeyword').value.trim();
    loadSubscriptionBrowserEntries();
}

function createTaskFromSubscriptionResource(resourceId, entry = null) {
    const resource = currentSubscriptionResources.find(item => item.id === resourceId);
    if (!resource) {
        message.warning('资源不存在');
        return;
    }
    openCreateTaskModalWithPrefill({
        shareLink: resource.shareLink,
        accessCode: resource.accessCode || '',
        taskName: entry?.name || resource.title,
        shareFolderId: entry?.canSave ? entry.id : null
    });
    closeSubscriptionBrowserModal();
    closeSubscriptionResourcesModal();
}

document.addEventListener('DOMContentLoaded', () => {
    const subscriptionForm = document.getElementById('subscriptionForm');
    const subscriptionResourceForm = document.getElementById('subscriptionResourceForm');
    const subscriptionUuidInput = document.getElementById('subscriptionUuid');

    if (subscriptionForm) {
        subscriptionForm.addEventListener('submit', saveSubscription);
    }
    if (subscriptionResourceForm) {
        subscriptionResourceForm.addEventListener('submit', saveSubscriptionResource);
    }
    if (subscriptionUuidInput) {
        subscriptionUuidInput.addEventListener('blur', () => {
            if (!document.getElementById('subscriptionId').value && subscriptionUuidInput.value.trim()) {
                previewSubscription();
            }
        });
    }
});
