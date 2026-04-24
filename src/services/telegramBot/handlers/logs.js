/**
 * 日志 handler: /logs /logs_ID（新功能）
 */
const fs = require('fs').promises;
const { send, typing } = require('../messaging');
const { escapeHtml, bold, pre } = require('../escape');
const { friendlyError } = require('../errors');

const LOG_FILE = '/tmp/cloud189-app.log';
const MAX_LINES = 30;

async function handleLogs(svc, msg, taskId) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        let content;
        try {
            content = await fs.readFile(LOG_FILE, 'utf8');
        } catch {
            await send(svc.bot, chatId, '📭 暂无日志');
            return;
        }

        let lines = content.split('\n').filter(Boolean);

        // 如果指定了任务 ID，过滤相关日志
        if (taskId) {
            const task = await svc.taskService.getTaskById(taskId);
            const filterKeywords = [
                `id:${taskId}`,
                task?.resourceName,
            ].filter(Boolean);

            lines = lines.filter(line =>
                filterKeywords.some(kw => line.includes(kw))
            );

            if (lines.length === 0) {
                await send(svc.bot, chatId, `📭 未找到任务 #${taskId} 的相关日志`);
                return;
            }
        }

        // 取最后 N 行
        const recentLines = lines.slice(-MAX_LINES);
        const header = taskId
            ? `📋 ${bold(`任务 #${taskId} 的日志`)} (最近 ${recentLines.length} 条)\n\n`
            : `📋 ${bold('系统日志')} (最近 ${recentLines.length} 条)\n\n`;

        const logText = recentLines.map(l => escapeHtml(l)).join('\n');
        await send(svc.bot, chatId, header + `<pre>${logText}</pre>`);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = { handleLogs };
