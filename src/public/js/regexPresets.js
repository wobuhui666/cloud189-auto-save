window.regexPresets = window.regexPresets || [];

let editingRegexPresetIndex = null;

function buildRegexPresetSummary(preset) {
    const parts = [];
    if (preset.sourceRegex || preset.targetRegex) {
        parts.push('重命名');
    }
    if (preset.matchPattern || preset.matchValue) {
        parts.push('筛选');
    }
    return parts.length ? parts.join(' + ') : '仅保存占位信息';
}

function renderRegexPresetOptions() {
    const selects = [
        document.getElementById('regexPresetSelect'),
        document.getElementById('editRegexPresetSelect')
    ].filter(Boolean);

    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = '<option value="">不使用预设</option>';
        window.regexPresets.forEach((preset, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = preset.name;
            select.appendChild(option);
        });
        if (currentValue !== '' && Number(currentValue) < window.regexPresets.length) {
            select.value = currentValue;
        }
    });
}

function applyRegexPreset(preset, fieldMap) {
    if (!preset) {
        return;
    }
    Object.entries(fieldMap).forEach(([presetKey, fieldId]) => {
        const element = document.getElementById(fieldId);
        if (element) {
            element.value = preset[presetKey] || '';
        }
    });
}

function handleCreateRegexPresetChange() {
    const presetIndex = document.getElementById('regexPresetSelect').value;
    if (presetIndex === '') {
        return;
    }
    const preset = window.regexPresets[Number(presetIndex)];
    applyRegexPreset(preset, {
        sourceRegex: 'ctSourceRegex',
        targetRegex: 'ctTargetRegex',
        matchPattern: 'matchPattern',
        matchOperator: 'matchOperator',
        matchValue: 'matchValue'
    });
}

function handleEditRegexPresetChange() {
    const presetIndex = document.getElementById('editRegexPresetSelect').value;
    if (presetIndex === '') {
        return;
    }
    const preset = window.regexPresets[Number(presetIndex)];
    applyRegexPreset(preset, {
        sourceRegex: 'editSourceRegex',
        targetRegex: 'editTargetRegex',
        matchPattern: 'editMatchPattern',
        matchOperator: 'editMatchOperator',
        matchValue: 'editMatchValue'
    });
}

function openRegexPresetManagementModal() {
    renderRegexPresetTable();
    document.getElementById('regexPresetManagementModal').style.display = 'block';
}

function closeRegexPresetManagementModal() {
    document.getElementById('regexPresetManagementModal').style.display = 'none';
}

function openAddEditRegexPresetModal(index = null) {
    editingRegexPresetIndex = index;
    const form = document.getElementById('regexPresetForm');
    form.reset();

    const title = document.getElementById('regexPresetModalTitle');
    if (index === null) {
        title.textContent = '添加正则预设';
    } else {
        title.textContent = '编辑正则预设';
        const preset = window.regexPresets[index];
        if (preset) {
            document.getElementById('regexPresetName').value = preset.name || '';
            document.getElementById('regexPresetDescription').value = preset.description || '';
            document.getElementById('regexPresetSourceRegex').value = preset.sourceRegex || '';
            document.getElementById('regexPresetTargetRegex').value = preset.targetRegex || '';
            document.getElementById('regexPresetMatchPattern').value = preset.matchPattern || '';
            document.getElementById('regexPresetMatchOperator').value = preset.matchOperator || 'lt';
            document.getElementById('regexPresetMatchValue').value = preset.matchValue || '';
        }
    }

    document.getElementById('addEditRegexPresetModal').style.display = 'block';
}

function closeAddEditRegexPresetModal() {
    document.getElementById('addEditRegexPresetModal').style.display = 'none';
    editingRegexPresetIndex = null;
}

function renderRegexPresetTable() {
    const tbody = document.querySelector('#regexPresetTable tbody');
    if (!tbody) {
        return;
    }
    tbody.innerHTML = '';

    if (!window.regexPresets.length) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">暂无正则预设</td></tr>';
        return;
    }

    window.regexPresets.forEach((preset, index) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${preset.name || '未命名预设'}</td>
            <td>${preset.description || '-'}</td>
            <td>${buildRegexPresetSummary(preset)}</td>
            <td>
                <button type="button" class="btn-small" onclick="openAddEditRegexPresetModal(${index})">编辑</button>
                <button type="button" class="btn-small btn-danger" onclick="deleteRegexPreset(${index})">删除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function getRegexPresetFromForm() {
    const name = document.getElementById('regexPresetName').value.trim();
    const sourceRegex = document.getElementById('regexPresetSourceRegex').value.trim();
    const targetRegex = document.getElementById('regexPresetTargetRegex').value.trim();
    const matchPattern = document.getElementById('regexPresetMatchPattern').value.trim();
    const matchOperator = document.getElementById('regexPresetMatchOperator').value;
    const matchValue = document.getElementById('regexPresetMatchValue').value.trim();

    if (!name) {
        throw new Error('预设名称不能为空');
    }
    if (targetRegex && !sourceRegex) {
        throw new Error('填了目标正则, 那么源正则就必须填');
    }
    if (matchPattern && !matchValue) {
        throw new Error('填了匹配模式, 那么匹配值就必须填');
    }

    return {
        name,
        description: document.getElementById('regexPresetDescription').value.trim(),
        sourceRegex,
        targetRegex,
        matchPattern,
        matchOperator,
        matchValue
    };
}

async function saveRegexPresetsToBackend() {
    const response = await fetch('/api/settings/regex-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regexPresets: window.regexPresets })
    });
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || '保存失败');
    }
}

async function deleteRegexPreset(index) {
    if (!confirm('确定要删除这个正则预设吗？')) {
        return;
    }
    window.regexPresets.splice(index, 1);
    try {
        await saveRegexPresetsToBackend();
        renderRegexPresetTable();
        renderRegexPresetOptions();
        message.success('删除成功');
    } catch (error) {
        message.warning('删除失败: ' + error.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const createSelect = document.getElementById('regexPresetSelect');
    const editSelect = document.getElementById('editRegexPresetSelect');
    const form = document.getElementById('regexPresetForm');

    if (createSelect) {
        createSelect.addEventListener('change', handleCreateRegexPresetChange);
    }
    if (editSelect) {
        editSelect.addEventListener('change', handleEditRegexPresetChange);
    }

    if (form) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
                const preset = getRegexPresetFromForm();
                if (editingRegexPresetIndex === null) {
                    window.regexPresets.push(preset);
                } else {
                    window.regexPresets[editingRegexPresetIndex] = preset;
                }
                await saveRegexPresetsToBackend();
                renderRegexPresetTable();
                renderRegexPresetOptions();
                closeAddEditRegexPresetModal();
                message.success('正则预设保存成功');
            } catch (error) {
                message.warning(error.message);
            }
        });
    }
});
