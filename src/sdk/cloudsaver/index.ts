import { Application } from 'express';
import cloudSaverSDK from './sdk';
const { logTaskEvent } = require('../../utils/logUtils');
export function setupCloudSaverRoutes(app: Application) {
    // 搜索接口
    app.get('/api/cloudsaver/search', async (req, res) => {
        try {
            const { keyword, fast } = req.query;

            if (!keyword || typeof keyword !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: '请提供搜索关键词'
                });
            }

            const results = await cloudSaverSDK.search(keyword, fast === 'true' || fast === '1');
            res.json({
                success: true,
                data: results
            });
        } catch (error) {
            logTaskEvent('CloudSaver 搜索失败:' +  error);
            res.json({
                success: false,
                error: '搜索失败:' + error
            });
        }
    });
}

export function clearCloudSaverToken() {
    logTaskEvent('CloudSaverSDK 配置已更改, 清除token')
    cloudSaverSDK.setToken('');
}
