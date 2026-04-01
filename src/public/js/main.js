async function loadVersion() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        document.getElementById('version').innerText = `v${data.version}`;
    } catch (error) {
        console.error('Failed to load version:', error);
    }
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// 主入口文件
document.addEventListener('DOMContentLoaded', () => {
    // 清理旧版 macOS 主题残留，避免覆盖当前 MD3 样式
    localStorage.removeItem('_currentTheme');
    const legacyMacosCss = document.querySelector('link[data-macos-theme="true"]');
    if (legacyMacosCss) {
        document.head.removeChild(legacyMacosCss);
    }
    // 加载版本号
    loadVersion();
    // 初始化所有功能
    initTabs();
    initAccountForm();
    initFileManager();
    initTaskForm();
    initEditTaskForm();
    // 初始化主题
    initTheme();
    // 初始化日志
    initLogs()

    // 初始化目录选择器
    const folderSelector = new FolderSelector({
        enableFavorites: true,
        favoritesKey: 'createTaskFavorites',
        onSelect: ({ id, name, path }) => {
            document.getElementById('targetFolder').value = path;
            document.getElementById('targetFolderId').value = id;
        }
    });

    // 修改目录选择触发方式
    document.getElementById('targetFolder').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('accountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        folderSelector.show(accountId);
    });

    // 添加常用目录按钮点击事件
    document.getElementById('favoriteFolderBtn').addEventListener('click', (e) => {
        e.preventDefault();
        const accountId = document.getElementById('accountId').value;
        if (!accountId) {
            message.warning('请先选择账号');
            return;
        }
        folderSelector.showFavorites(accountId);
    });

    // 初始化数据
    fetchAccounts(true);
    fetchTasks();
    fetchSubscriptions();
    fetchStrmConfigs();

    // 定时刷新数据
    // setInterval(() => {
    //     fetchTasks();
    // }, 30000);
});


// 从缓存获取数据
function getFromCache(key) {
    // 拼接用户 ID
    const userId = document.getElementById('accountId').value;
    return localStorage.getItem(key + '_' + userId);
}
// 保存数据到缓存
function saveToCache(key, value) {
    const userId = document.getElementById('accountId').value;
    localStorage.setItem(key + '_' + userId, value);
}

document.addEventListener('DOMContentLoaded', function() {
    const tooltip = document.getElementById('regexTooltip');

    // 使用事件委托，监听整个文档的点击事件
    document.addEventListener('click', function(e) {
        // 检查点击的是否是帮助图标
        if (e.target.classList.contains('help-icon')) {
            e.stopPropagation();
            const helpIcon = e.target;
            const rect = helpIcon.getBoundingClientRect();
            const isVisible = tooltip.style.display === 'block';
            
            // 关闭弹窗
            if (isVisible && tooltip._currentIcon === helpIcon) {
                tooltip.style.display = 'none';
                return;
            }

            // 显示弹窗
            tooltip.style.display = 'block';
            tooltip._currentIcon = helpIcon;
            tooltip.style.zIndex = 9999;
            
            // 计算位置
            const viewportWidth = window.innerWidth;
            const tooltipWidth = tooltip.offsetWidth;
            
            // 移动端适配
            if (viewportWidth <= 768) {
                tooltip.style.left = '50%';
                tooltip.style.top = '50%';
                tooltip.style.transform = 'translate(-50%, -50%)';
                tooltip.style.maxWidth = '90vw';
                tooltip.style.maxHeight = '80vh';
                tooltip.style.overflow = 'auto';
            } else {
                let left = rect.left;
                if (left + tooltipWidth > viewportWidth) {
                    left = viewportWidth - tooltipWidth - 10;
                }
                tooltip.style.top = `${rect.bottom + 5}px`;
                tooltip.style.left = `${left}px`;
                tooltip.style.transform = 'none';
            }
        } else if (!tooltip.contains(e.target)) {
            // 点击其他地方关闭弹窗
            tooltip.style.display = 'none';
        }
    });

    // 添加 ESC 键关闭
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            tooltip.style.display = 'none';
        }
    });
});

function toggleFloatingBtns() {
    const container = document.getElementById('floatingBtnsContainer');
    const icon = document.getElementById('toggleIcon');
    container.classList.toggle('collapsed');
    icon.classList.toggle('expanded');
}


function toggleHelpText(button) {
    const helpText = button.nextElementSibling;
    if (helpText.style.display === 'block') {
        helpText.style.display = 'none';
        button.textContent = '显示帮助';
    } else {
        helpText.style.display = 'block';
        button.textContent = '隐藏帮助';
    }
}
