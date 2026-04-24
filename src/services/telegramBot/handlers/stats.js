/**
 * 统计 handler: /stats（新功能）
 */
const { send, typing } = require('../messaging');
const { statsCard } = require('../templates');
const { friendlyError } = require('../errors');

async function handleStats(svc, msg) {
    const chatId = msg.chat.id;
    await typing(svc.bot, chatId);

    try {
        // 1. 状态分布
        const statusResults = await svc.taskRepo
            .createQueryBuilder('task')
            .select('task.status', 'status')
            .addSelect('COUNT(*)', 'cnt')
            .groupBy('task.status')
            .getRawMany();

        const statusCounts = {};
        statusResults.forEach(r => {
            statusCounts[r.status] = parseInt(r.cnt);
        });

        // 2. 近7天新增
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const recentCount = await svc.taskRepo
            .createQueryBuilder('task')
            .where('task.createdAt >= :date', { date: sevenDaysAgo.toISOString() })
            .getCount();

        // 3. 失败 TOP5
        const failedTasks = await svc.taskRepo.find({
            where: { status: 'failed' },
            order: { updatedAt: 'DESC' },
            take: 5,
        });

        const text = statsCard(statusCounts, recentCount, failedTasks);
        await send(svc.bot, chatId, text);
    } catch (error) {
        await send(svc.bot, chatId, friendlyError(error));
    }
}

module.exports = { handleStats };
