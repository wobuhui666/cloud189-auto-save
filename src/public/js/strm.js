var currentStrmPath = '';

function fillAccountsList() {
    const accountsListDom = document.getElementById('accountsList');
    // 从全局账号列表获取数据并填充
    accountsList.forEach(account => {
        const accountItem = document.createElement('label');
        accountItem.onmouseover = () => {
            accountItem.style.backgroundColor = 'var(--hover-color)';
        };
        accountItem.onmouseout = () => {
            accountItem.style.backgroundColor = 'var(--background-color)';
        };
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = account.id;
        checkbox.className = 'account-checkbox';
        
        const label = document.createElement('span');
        label.textContent = account.username;
        if (account.alias) {
            label.textContent += ` (${account.alias})`;
        }
        
        accountItem.appendChild(checkbox);
        accountItem.appendChild(label);
        accountsListDom.appendChild(accountItem);
    });
}

function openStrmModal() {
    document.getElementById('strmModal').style.display = 'block';
    document.getElementById('accountsList').innerHTML = ''; // 清空现有列表
    fillAccountsList();
    
    // 添加全选事件监听
    document.getElementById('selectAllAccounts').onchange = handleSelectAllAccounts;
}

function closeStrmModal() {
    const modal = document.getElementById('strmModal');
    modal.style.display = 'none';
}

function handleSelectAllAccounts() {
    const selectAllCheckbox = document.getElementById('selectAllAccounts');
    const accountCheckboxes = document.querySelectorAll('.account-checkbox');
    accountCheckboxes.forEach(checkbox => {
        checkbox.checked = selectAllCheckbox.checked;
    });
}

async function generateAllStrm(overwrite = false) {
    const selectedAccounts = Array.from(document.querySelectorAll('.account-checkbox:checked'))
        .map(checkbox => checkbox.value);
    
    if (selectedAccounts.length === 0) {
        message.error('请至少选择一个账号');
        return;
    }
    console.log(JSON.stringify({
        accountIds: selectedAccounts,
        overwrite: overwrite
    }));
    try {
        const response = await fetch('/api/strm/generate-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accountIds: selectedAccounts,
                overwrite: overwrite
            })
        });
        message.success("执行中, 请稍后查看结果");
    } catch (error) {
        message.error('生成STRM失败: ' + error.message);
    }
}

function openStrmBrowser(path = '') {
    currentStrmPath = path;
    document.getElementById('strmBrowserModal').style.display = 'block';
    loadStrmEntries(path);
}

function closeStrmBrowser() {
    document.getElementById('strmBrowserModal').style.display = 'none';
}

function getParentStrmPath(path) {
    if (!path) {
        return '';
    }
    const segments = path.split('/').filter(Boolean);
    segments.pop();
    return segments.join('/');
}

async function loadStrmEntries(path = '') {
    currentStrmPath = path;
    const pathLabel = document.getElementById('strmBrowserPath');
    const tbody = document.getElementById('strmBrowserTableBody');
    const parentButton = document.getElementById('strmBrowserParentBtn');

    pathLabel.textContent = path || '/';
    parentButton.disabled = !path;
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">加载中...</td></tr>';

    try {
        const response = await fetch(`/api/strm/list?path=${encodeURIComponent(path)}`);
        const data = await response.json();
        if (!data.success) {
            throw new Error(data.error);
        }

        if (!data.data.length) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">当前目录没有 STRM 文件或子目录</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        data.data.forEach(entry => {
            const tr = document.createElement('tr');
            const nameCell = document.createElement('td');
            const typeCell = document.createElement('td');
            const actionCell = document.createElement('td');
            const actionButton = document.createElement('button');

            nameCell.textContent = entry.name;
            typeCell.textContent = entry.type === 'directory' ? '目录' : 'STRM';
            actionButton.type = 'button';
            actionButton.className = 'btn-small';

            if (entry.type === 'directory') {
                actionButton.textContent = '进入';
                actionButton.onclick = () => openStrmBrowser(entry.path);
            } else {
                actionButton.textContent = '复制路径';
                actionButton.onclick = () => copyStrmPath(entry.path);
            }

            actionCell.appendChild(actionButton);
            tr.appendChild(nameCell);
            tr.appendChild(typeCell);
            tr.appendChild(actionCell);
            tbody.appendChild(tr);
        });
    } catch (error) {
        tbody.innerHTML = `<tr><td colspan="3" style="text-align: center;">加载失败: ${error.message}</td></tr>`;
    }
}

function goToParentStrmPath() {
    openStrmBrowser(getParentStrmPath(currentStrmPath));
}

async function copyStrmPath(filePath) {
    try {
        await navigator.clipboard.writeText(filePath);
        message.success('STRM 路径已复制');
    } catch (error) {
        message.warning('复制失败: ' + error.message);
    }
}
