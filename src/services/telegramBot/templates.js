/**
 * 消息模板 —— 统一 HTML 格式
 */
const { escapeHtml, bold, code, link } = require('./escape');
const { TASK_STATUS } = require('./constants');

/**
 * 格式化任务状态
 */
function formatStatus(status) {
    const statusMap = {
        [TASK_STATUS.PENDING]: '⏳ 等待执行',
        [TASK_STATUS.PROCESSING]: '🔄 追剧中',
        [TASK_STATUS.COMPLETED]: '✅ 已完结',
        [TASK_STATUS.FAILED]: '❌ 失败',
    };
    return statusMap[status] || status;
}

/**
 * 脱敏用户名
 */
function desensitizeUsername(username) {
    if (!username) return '未知账号';
    if (username.length <= 6) return username.substring(0, 1) + '****';
    return username.replace(/(.{3}).*(.{4})/, '$1****$2');
}

/**
 * 任务列表卡片
 */
function taskCard(task) {
    const name = task.resourceName || '未命名';
    const episodes = `${task.currentEpisodes || 0}${task.totalEpisodes ? '/' + task.totalEpisodes : ''} 集`;
    const status = formatStatus(task.status);
    const updated = task.lastFileUpdateTime
        ? new Date(task.lastFileUpdateTime).toLocaleString('zh-CN')
        : '-';

    return (
        `📺 ${bold(name)}\n` +
        `⏱ 进度：${escapeHtml(episodes)}\n` +
        `🔄 状态：${status}\n` +
        `⌚️ 更新：${escapeHtml(updated)}\n` +
        `▶️ 执行：/execute_${task.id}\n` +
        `📁 STRM：/strm_${task.id}\n` +
        `🎬 Emby：/emby_${task.id}\n` +
        `📝 详情：/detail_${task.id}\n` +
        `📜 日志：/logs_${task.id}\n` +
        `❌ 删除：/dt_${task.id}`
    );
}

/**
 * 任务详情卡片（完整字段）
 */
function taskDetailCard(task) {
    const name = task.resourceName || '未命名';
    const status = formatStatus(task.status);
    const episodes = `${task.currentEpisodes || 0}${task.totalEpisodes ? '/' + task.totalEpisodes : ''} 集`;
    const created = task.createdAt ? new Date(task.createdAt).toLocaleString('zh-CN') : '-';
    const updated = task.updatedAt ? new Date(task.updatedAt).toLocaleString('zh-CN') : '-';
    const lastFile = task.lastFileUpdateTime ? new Date(task.lastFileUpdateTime).toLocaleString('zh-CN') : '-';
    const lastErr = task.lastError ? escapeHtml(task.lastError.substring(0, 200)) : '无';
    const retries = task.retryCount || 0;
    const remark = task.remark ? escapeHtml(task.remark) : '-';
    const shareLink = task.shareLink || '-';

    return (
        `📺 ${bold(name)}\n\n` +
        `🆔 ID：${task.id}\n` +
        `🔄 状态：${status}\n` +
        `⏱ 进度：${escapeHtml(episodes)}\n` +
        `🔗 分享链接：${code(shareLink)}\n` +
        `📂 目标文件夹ID：${code(task.targetFolderId || '-')}\n` +
        `📝 备注：${remark}\n` +
        `🔁 重试次数：${retries}\n` +
        `❗ 最后错误：${lastErr}\n` +
        `📅 创建时间：${escapeHtml(created)}\n` +
        `📅 更新时间：${escapeHtml(updated)}\n` +
        `📅 最后文件更新：${escapeHtml(lastFile)}`
    );
}

/**
 * 统计信息卡片
 */
function statsCard(statusCounts, recentCount, failedTasks) {
    let text = `📊 ${bold('系统统计')}\n\n`;

    text += `📋 ${bold('任务状态分布')}\n`;
    for (const [status, count] of Object.entries(statusCounts)) {
        text += `  ${formatStatus(status)}：${count}\n`;
    }

    text += `\n📈 最近 7 天新增任务：${recentCount}\n`;

    if (failedTasks && failedTasks.length > 0) {
        text += `\n❌ ${bold('最近失败任务 TOP5')}\n`;
        failedTasks.forEach((task, i) => {
            const name = escapeHtml(task.resourceName || '未命名');
            const err = task.lastError
                ? escapeHtml(task.lastError.substring(0, 60))
                : '未知错误';
            text += `  ${i + 1}. ${name}\n     ${err}\n     /retry_${task.id}\n`;
        });
    }

    return text;
}

/**
 * 帮助文本
 */
function helpText() {
    return (
        `🤖 ${bold('天翼云盘机器人使用指南')}\n\n` +
        `📋 ${bold('基础命令')}\n` +
        `/start - 首次使用引导\n` +
        `/help - 显示帮助信息\n` +
        `/accounts - 账号列表与切换\n` +
        `/tasks - 显示下载任务列表\n` +
        `/tasks_failed - 查看失败任务\n` +
        `/tasks_pending - 查看待执行任务\n` +
        `/tasks_processing - 查看执行中任务\n` +
        `/fl - 显示常用目录列表\n` +
        `/fs - 添加常用目录\n` +
        `/stats - 系统统计信息\n` +
        `/cancel - 取消当前操作\n\n` +
        `🔍 ${bold('搜索与追剧')}\n` +
        `/search_cs - 搜索CloudSaver资源\n` +
        `/series 剧名 [年份] - 自动追剧(正常任务)\n` +
        `/lazy_series 剧名 [年份] - 自动追剧(懒转存STRM)\n\n` +
        `📝 ${bold('任务操作')}\n` +
        `/execute_[ID] - 执行指定任务\n` +
        `/execute_all - 执行所有任务\n` +
        `/detail_[ID] - 查看任务详情\n` +
        `/retry_[ID] - 重试失败任务\n` +
        `/strm_[ID] - 生成STRM文件\n` +
        `/emby_[ID] - 通知Emby刷新\n` +
        `/dt_[ID] - 删除指定任务\n` +
        `/df_[ID] - 删除指定常用目录\n\n` +
        `📋 ${bold('日志与订阅')}\n` +
        `/logs - 查看最近日志\n` +
        `/subs - 查看订阅列表\n\n` +
        `📥 ${bold('创建任务')}\n` +
        `直接发送天翼云盘分享链接即可创建任务\n` +
        `格式：链接（支持访问码的链接）\n\n` +
        `🎬 ${bold('自动追剧')}\n` +
        `1. /series 北上 2025\n` +
        `2. /lazy_series 北上 2025\n` +
        `3. 使用系统页里配置的默认账号与默认目录`
    );
}

/**
 * 常用目录列表文本
 */
function commonFolderList(folders, username) {
    const user = desensitizeUsername(username);
    if (!folders || folders.length === 0) {
        return `当前账号: ${escapeHtml(user)}\n未找到常用目录，请先添加常用目录`;
    }
    const list = folders.map(f =>
        `📁 ${escapeHtml(f.path)}\n❌ 删除: /df_${f.id}`
    ).join('\n\n');
    return `当前账号: ${escapeHtml(user)}\n常用目录列表：\n\n${list}`;
}

/**
 * CloudSaver 搜索结果
 */
function searchResults(results) {
    const header = `💡 以下资源来自 CloudSaver\n📝 共找到 ${results.length} 个结果，输入编号可转存\n\n`;
    const items = results.map((item, index) =>
        `${index + 1}. 🎬 ${link(item.title, item.cloudLinks[0].link)}`
    ).join('\n\n');
    return header + items;
}

module.exports = {
    formatStatus,
    desensitizeUsername,
    taskCard,
    taskDetailCard,
    statsCard,
    helpText,
    commonFolderList,
    searchResults,
};
