const test = require('node:test');
const assert = require('node:assert/strict');

const aiService = require('../src/services/ai');

test('AI 文件夹分析接收完整套娃目录树', async () => {
    const originalChat = aiService.chat.bind(aiService);
    let userPrompt = '';

    try {
        aiService.chat = async messages => {
            userPrompt = messages.find(message => message.role === 'user')?.content || '';
            return {
                success: true,
                data: JSON.stringify({
                    name: '测试剧',
                    year: 2024,
                    type: 'tv',
                    folders: [
                        { id: 'season', name: 'Season 02', relativePath: '第二季' },
                        { id: 'disc', name: 'Disc 01', relativePath: '第二季/Disc 01' }
                    ]
                })
            };
        };

        const result = await aiService.folderAnalysis('测试剧', [
            { id: 'season', name: '第二季', relativePath: '第二季', parentId: 'root', depth: 1 },
            { id: 'disc', name: 'Disc 01', relativePath: '第二季/Disc 01', parentId: 'season', depth: 2 }
        ]);

        assert.equal(result.success, true);
        assert.match(userPrompt, /第二季\/Disc 01/);
        assert.match(userPrompt, /"depth": 2/);
    } finally {
        aiService.chat = originalChat;
    }
});
