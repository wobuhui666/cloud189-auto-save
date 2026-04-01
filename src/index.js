require('dotenv').config();
const express = require('express');
const { AppDataSource } = require('./database');
const { Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig } = require('./entities');
const { TaskService } = require('./services/task');
const { Cloud189Service } = require('./services/cloud189');
const { MessageUtil } = require('./services/message');
const { CacheManager } = require('./services/CacheManager')
const ConfigService = require('./services/ConfigService');
const packageJson = require('../package.json');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { SchedulerService } = require('./services/scheduler');
const { logTaskEvent, initSSE, sendAIMessage } = require('./utils/logUtils');
const TelegramBotManager = require('./utils/TelegramBotManager');
const fs = require('fs').promises;
const path = require('path');
const { setupCloudSaverRoutes, clearCloudSaverToken } = require('./sdk/cloudsaver');
const { Like, Not, IsNull, In, Or } = require('typeorm');
const cors = require('cors'); 
const { EmbyService } = require('./services/emby');
const { StrmService } = require('./services/strm');
const AIService = require('./services/ai');
const CustomPushService = require('./services/message/CustomPushService');
const { SubscriptionService } = require('./services/subscription');
const { StrmConfigService } = require('./services/strmConfig');
const { TMDBService } = require('./services/tmdb');
const { StreamProxyService } = require('./services/streamProxy');

const app = express();
app.use(cors({
    origin: '*', // 允许所有来源
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-api-key'],
    credentials: true
}));
app.use(express.json());

app.use(session({
    store: new FileStore({
        path: './data/sessions',  // session文件存储路径
        ttl: 30 * 24 * 60 * 60,  // session过期时间，单位秒
        reapInterval: 3600,       // 清理过期session间隔，单位秒
        retries: 0,           // 设置重试次数为0
        logFn: () => {},      // 禁用内部日志
        reapAsync: true,      // 异步清理过期session
    }),
    secret: 'LhX2IyUcMAz2',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        maxAge: 24 * 60 * 60 * 1000 * 30 // 30天
    }
}));


// 验证会话的中间件
const authenticateSession = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const configApiKey = ConfigService.getConfigValue('system.apiKey');
    if (apiKey && configApiKey && apiKey === configApiKey) {
        return next();
    }
    if (req.session.authenticated) {
        next();
    } else {
        // API 请求返回 401，页面请求重定向到登录页
        if (req.path.startsWith('/api/')) {
            res.status(401).json({ success: false, error: '未登录' });
        } else {
            res.redirect('./login');
        }
    }
};

// 添加根路径处理
app.get('/', (req, res) => {
    if (!req.session.authenticated) {
        res.redirect('./login');
    } else {
        res.sendFile(__dirname + '/public/index.html');
    }
});


// 登录页面
app.get('/login', (req, res) => {
    res.sendFile(__dirname + '/public/login.html');
});

// 登录接口
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ConfigService.getConfigValue('system.username') && 
        password === ConfigService.getConfigValue('system.password')) {
        req.session.authenticated = true;
        req.session.username = username;
        res.json({ success: true });
    } else {
        res.json({ success: false, error: '用户名或密码错误' });
    }
});
app.use(express.static(path.join(__dirname,'public')));
// 为所有路由添加认证（除了登录页和登录接口）
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/login' 
        || req.path === '/api/auth/login' 
        || req.path === '/api/auth/login' 
        || req.path.startsWith('/api/stream/')
        || req.path === '/emby/notify'
        || req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico)$/)) {
        return next();
    }
    authenticateSession(req, res, next);
});
// 初始化数据库连接
AppDataSource.initialize().then(async () => {
    // 当前版本:
    const currentVersion = packageJson.version;
    console.log(`当前系统版本: ${currentVersion}`);
    console.log('数据库连接成功');

    // 初始化 STRM 目录权限
    const strmBaseDir = path.join(__dirname, '../strm');
    try {
        await fs.mkdir(strmBaseDir, { recursive: true });
        if (process.getuid && process.getuid() === 0) {
            await fs.chown(strmBaseDir, parseInt(process.env.PUID || 0), parseInt(process.env.PGID || 0));
        }
        await fs.chmod(strmBaseDir, 0o777);
        console.log('STRM目录权限初始化完成');
    } catch (error) {
        console.error('STRM目录权限初始化失败:', error);
    }

    const accountRepo = AppDataSource.getRepository(Account);
    const taskRepo = AppDataSource.getRepository(Task);
    const commonFolderRepo = AppDataSource.getRepository(CommonFolder);
    const subscriptionRepo = AppDataSource.getRepository(Subscription);
    const subscriptionResourceRepo = AppDataSource.getRepository(SubscriptionResource);
    const strmConfigRepo = AppDataSource.getRepository(StrmConfig);
    const taskService = new TaskService(taskRepo, accountRepo);
    const subscriptionService = new SubscriptionService(subscriptionRepo, subscriptionResourceRepo, accountRepo);
    const strmConfigService = new StrmConfigService(strmConfigRepo, accountRepo, subscriptionRepo, subscriptionResourceRepo);
    const streamProxyService = new StreamProxyService(accountRepo);
    const tmdbService = new TMDBService();
    const embyService = new EmbyService(taskService)
    const messageUtil = new MessageUtil();
    // 机器人管理
    const botManager = TelegramBotManager.getInstance();
    // 初始化机器人
    await botManager.handleBotStatus(
        ConfigService.getConfigValue('telegram.bot.botToken'),
        ConfigService.getConfigValue('telegram.bot.chatId'),
        ConfigService.getConfigValue('telegram.bot.enable')
    );
    // 初始化缓存管理器
    const folderCache = new CacheManager(parseInt(600));
    // 初始化任务定时器
    await SchedulerService.initTaskJobs(taskRepo, taskService);
    await SchedulerService.initStrmConfigJobs(strmConfigRepo, strmConfigService);
    
    // 账号相关API
    app.get('/api/accounts', async (req, res) => {
        const accounts = await accountRepo.find();
        // 获取容量
        for (const account of accounts) {
            
            account.capacity = {
                cloudCapacityInfo: {usedSize:0,totalSize:0},
                familyCapacityInfo: {usedSize:0,totalSize:0}
            }
            // 如果账号名是s打头 则不获取容量
            if (!account.username.startsWith('n_')) {
                const cloud189 = Cloud189Service.getInstance(account);
                const capacity = await cloud189.getUserSizeInfo()
                if (capacity && capacity.res_code == 0) {
                    account.capacity.cloudCapacityInfo = capacity.cloudCapacityInfo;
                    account.capacity.familyCapacityInfo = capacity.familyCapacityInfo;
                }
            }
            account.original_username = account.username;
            account.accountType = account.accountType || 'personal';
            account.familyId = account.familyId || '';
            account.driveLabel = account.accountType === 'family' ? '家庭云' : '个人云';
            // username脱敏
            account.username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
        }
        res.json({ success: true, data: accounts });
    });

    app.post('/api/accounts', async (req, res) => {
        try {
            const account = accountRepo.create(req.body);
            account.accountType = account.accountType || 'personal';
            account.familyId = account.accountType === 'family' ? (account.familyId || '') : null;
            Cloud189Service.invalidateByUsername(account.username);
            // 尝试登录, 登录成功写入store, 如果需要验证码, 则返回用户验证码图片
            if (!account.username.startsWith('n_') && account.password) {
                // 尝试登录
                const cloud189 = Cloud189Service.getInstance(account);
                const loginResult = await cloud189.login(account.username, account.password, req.body.validateCode);
                if (!loginResult.success) {
                    if (loginResult.code == "NEED_CAPTCHA") {
                        res.json({
                            success: false,
                            code: "NEED_CAPTCHA",
                            data: {
                                captchaUrl: loginResult.data
                            }
                        });
                        return;
                    }
                    res.json({ success: false, error: loginResult.message });
                    return;
                }
            }
            if (!account.username.startsWith('n_') && account.accountType === 'family') {
                const cloud189 = Cloud189Service.getInstance(account);
                account.familyId = await cloud189.resolveFamilyId(account.familyId || null);
            }
            await accountRepo.save(account);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

     // 清空回收站
     app.delete('/api/accounts/recycle', async (req, res) => {
        try {
            taskService.clearRecycleBin(true, true);
            res.json({ success: true, data: "ok" });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.delete('/api/accounts/:id', async (req, res) => {
        try {
            const account = await accountRepo.findOneBy({ id: parseInt(req.params.id) });
            if (!account) throw new Error('账号不存在');
            Cloud189Service.invalidateByUsername(account.username);
            await accountRepo.remove(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    app.put('/api/accounts/:id/strm-prefix', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { strmPrefix, type } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            if (type == 'local') {
                account.localStrmPrefix = strmPrefix;
            }
            if (type == 'cloud') {
                account.cloudStrmPrefix = strmPrefix;
            }
            if (type == 'emby') {
                account.embyPathReplace = strmPrefix;
            }
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    // 修改别名
    app.put('/api/accounts/:id/alias', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            const { alias } = req.body;
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) throw new Error('账号不存在');
            account.alias = alias;
            await accountRepo.save(account);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    app.put('/api/accounts/:id/default', async (req, res) => {
        try {
            const accountId = parseInt(req.params.id);
            // 清除所有账号的默认状态
            await accountRepo.update({}, { isDefault: false });
            // 设置指定账号为默认
            await accountRepo.update({ id: accountId }, { isDefault: true });
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    // 任务相关API
    app.get('/api/tasks', async (req, res) => {
        const { status, search } = req.query;
        let whereClause = { }; // 用于构建最终的 where 条件

        // 基础条件（AND）
        if (status && status !== 'all') {
            whereClause.status = status;
        }
        whereClause.enableSystemProxy = Or(IsNull(), false);

        // 添加搜索过滤
        if (search) {
            const searchConditions = [
                { realFolderName: Like(`%${search}%`) },
                { remark: Like(`%${search}%`) },
                { taskGroup: Like(`%${search}%`) },
                { account: { username: Like(`%${search}%`) } }
            ];
            if (Object.keys(whereClause).length > 0) {
                whereClause = searchConditions.map(searchCond => ({
                    ...whereClause, // 包含基础条件 (如 status)
                    ...searchCond   // 包含一个搜索条件
                }));
            }else{
                whereClause = searchConditions;
            }
        }
        const tasks = await taskRepo.find({
            order: { id: 'DESC' },
            relations: {
                account: true
            },
            select: {
                account: {
                    username: true,
                    accountType: true
                }
            },
            where: whereClause
        });
        // username脱敏
        tasks.forEach(task => {
            task.account.username = task.account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
            task.account.accountType = task.account.accountType || 'personal';
        });
        res.json({ success: true, data: tasks });
    });

    app.post('/api/tasks', async (req, res) => {
        try {
            const task = await taskService.createTask(req.body);
            res.json({ success: true, data: task });
        } catch (error) {
            console.log(error)
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/batch-create', async (req, res) => {
        try {
            const result = await taskService.createTasksBatch(req.body.tasks);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/tasks/batch', async (req, res) => {
        try {
            const taskIds = req.body.taskIds;
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTasks(taskIds, deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 删除任务文件
    app.delete('/api/tasks/files', async (req, res) => {
        try{
            const { taskId, files } = req.body;
            if (!files || files.length === 0) {
                throw new Error('未选择要删除的文件');
            }
            await taskService.deleteFiles(taskId, files);
            res.json({ success: true, data: null });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.delete('/api/tasks/:id', async (req, res) => {
        try {
            const deleteCloud = req.body.deleteCloud;
            await taskService.deleteTask(parseInt(req.params.id), deleteCloud);
            res.json({ success: true });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });


    app.put('/api/tasks/:id', async (req, res) => {
        try {
            const taskId = parseInt(req.params.id);
            const updatedTask = await taskService.updateTask(taskId, req.body);
            res.json({ success: true, data: updatedTask });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/tasks/:id/execute', async (req, res) => {
        try {
            const task = await taskRepo.findOne({
                where: { id: parseInt(req.params.id) },
                relations: {
                    account: true
                },
                select: {
                    account: {
                        username: true,
                        localStrmPrefix: true,
                        cloudStrmPrefix: true,
                        embyPathReplace: true
                    }
                }
            });
            if (!task) throw new Error('任务不存在');
            logTaskEvent(`================================`);
            const taskName = task.shareFolderName?(task.resourceName + '/' + task.shareFolderName): task.resourceName || '未知'
            logTaskEvent(`任务[${taskName}]开始执行`);
            const result = await taskService.processTask(task);
            if (result) {
                messageUtil.sendMessage(result)
            }
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });
    // 根据任务生成STRM文件
    app.post('/api/tasks/strm', async (req, res) => {
        try {
            const taskIds = req.body.taskIds;
            if (!taskIds || taskIds.length == 0) {
                throw new Error('任务ID不能为空');
            }
            const overwrite = req.body.overwrite || false;
            taskService.createStrmFileByTask(taskIds, overwrite);
            return res.json({ success: true, data: 'ok' });
        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
     // 获取目录树
     app.get('/api/folders/:accountId', async (req, res) => {
        try {
            const accountId = parseInt(req.params.accountId);
            const folderId = req.query.folderId || '-11';
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `folders_${accountId}_${folderId}`;
            // forceRefresh 为true 则清空所有folders_开头的缓存
            if (forceRefresh) {
                folderCache.clearPrefix("folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }

            const cloud189 = Cloud189Service.getInstance(account);
            const folders = await cloud189.getFolderNodes(folderId);
            if (!folders) {
                throw new Error('获取目录失败');
            }
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 根据分享链接获取文件目录
    app.get('/api/share/folders/:accountId', async (req, res) => {
        try {
            const taskId = parseInt(req.query.taskId);
            const folderId = req.query.folderId;
            const forceRefresh = req.query.refresh === 'true';
            const cacheKey = `share_folders_${taskId}_${folderId}`;
            if (forceRefresh) {
                folderCache.clearPrefix("share_folders_");
            }
            if (folderCache.has(cacheKey)) {
                return res.json({ success: true, data: folderCache.get(cacheKey) });
            }
            const task = await taskRepo.findOneBy({ id: parseInt(taskId) });
            if (!task) {
                throw new Error('任务不存在');
            }
            if (folderId == -11) {
                // 返回顶级目录
                res.json({success: true, data: [{id: task.shareFileId, name: task.resourceName}]});
                return 
            }
            const account = await accountRepo.findOneBy({ id: req.params.accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            // 查询分享目录
            const shareDir = await cloud189.listShareDir(task.shareId, req.query.folderId, task.shareMode);
            if (!shareDir || !shareDir.fileListAO) {
                res.json({ success: true, data: [] });    
            }
            const folders = shareDir.fileListAO.folderList;
            folderCache.set(cacheKey, folders);
            res.json({ success: true, data: folders });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

     // 获取目录下的文件
     app.get('/api/folder/files', async (req, res) => {
        const { accountId, taskId } = req.query;
        const account = await accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }
        const task = await taskRepo.findOneBy({ id: taskId });
        if (!task) {
            throw new Error('任务不存在');
        }
        const cloud189 = Cloud189Service.getInstance(account);
        try {
            const fileList =  await taskService.getAllFolderFiles(cloud189, task);    
            res.json({ success: true, data: fileList });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/file-manager/list', async (req, res) => {
        try {
            const accountId = parseInt(req.query.accountId);
            const folderId = req.query.folderId || '-11';
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const result = await cloud189.listFiles(folderId);
            if (!result?.fileListAO) {
                return res.json({
                    success: true,
                    data: {
                        currentFolderId: folderId,
                        entries: []
                    }
                });
            }

            const folderList = (result.fileListAO.folderList || []).map((folder) => ({
                id: String(folder.id),
                name: folder.name,
                isFolder: true,
                size: Number(folder.size || 0),
                lastOpTime: folder.lastOpTime || folder.lastModifyTime || folder.createDate || ''
            }));
            const fileList = (result.fileListAO.fileList || []).map((file) => ({
                id: String(file.id),
                name: file.name,
                isFolder: false,
                size: Number(file.size || 0),
                lastOpTime: file.lastOpTime || file.lastModifyTime || file.createDate || '',
                ext: path.extname(file.name || '').toLowerCase()
            }));
            const entries = [...folderList, ...fileList].sort((left, right) => {
                if (left.isFolder !== right.isFolder) {
                    return left.isFolder ? -1 : 1;
                }
                return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
            });

            res.json({
                success: true,
                data: {
                    currentFolderId: folderId,
                    accountType: account.accountType || 'personal',
                    driveLabel: account.accountType === 'family' ? '家庭云' : '个人云',
                    entries
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/folder', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const parentFolderId = req.body.parentFolderId || '-11';
            const folderName = String(req.body.folderName || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!folderName) {
                throw new Error('目录名称不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const createResult = await cloud189.createFolder(folderName, parentFolderId);
            if (!createResult || createResult.res_code && createResult.res_code !== 0) {
                throw new Error(createResult?.res_msg || '创建目录失败');
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: createResult });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/rename', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const fileId = String(req.body.fileId || '').trim();
            const destFileName = String(req.body.destFileName || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!fileId) {
                throw new Error('文件ID不能为空');
            }
            if (!destFileName) {
                throw new Error('新名称不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const renameResult = await cloud189.renameFile(fileId, destFileName);
            if (!renameResult || renameResult.res_code && renameResult.res_code !== 0) {
                throw new Error(renameResult?.res_msg || '重命名失败');
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: renameResult });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/delete', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!entries.length) {
                throw new Error('未选择需要删除的文件');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const folders = entries.filter((entry) => entry.isFolder);
            const files = entries.filter((entry) => !entry.isFolder);
            if (folders.length) {
                await taskService.deleteCloudFile(cloud189, folders, 1);
            }
            if (files.length) {
                await taskService.deleteCloudFile(cloud189, files, 0);
            }
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/file-manager/move', async (req, res) => {
        try {
            const accountId = parseInt(req.body.accountId);
            const targetFolderId = String(req.body.targetFolderId || '').trim();
            const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!targetFolderId) {
                throw new Error('目标目录不能为空');
            }
            if (!entries.length) {
                throw new Error('未选择需要移动的文件');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            await taskService.moveCloudFile(cloud189, entries.map((entry) => ({
                id: entry.id,
                name: entry.name,
                isFolder: entry.isFolder
            })), targetFolderId);
            folderCache.clearPrefix('folders_');
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/file-manager/download-link', async (req, res) => {
        try {
            const accountId = parseInt(req.query.accountId);
            const fileId = String(req.query.fileId || '').trim();
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            if (!fileId) {
                throw new Error('文件ID不能为空');
            }
            const account = await accountRepo.findOneBy({ id: accountId });
            if (!account) {
                throw new Error('账号不存在');
            }
            const cloud189 = Cloud189Service.getInstance(account);
            const downloadUrl = await cloud189.getDownloadLink(fileId);
            res.json({ success: true, data: { url: downloadUrl } });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/files/rename', async (req, res) => {
        const {taskId, accountId, files, sourceRegex, targetRegex } = req.body;
        if (files.length == 0) {
            throw new Error('未获取到需要修改的文件');
        }
        const account = await accountRepo.findOneBy({ id: accountId });
        if (!account) {
            throw new Error('账号不存在');
        }
        const task = await taskService.getTaskById(taskId);
        if (!task) {
            throw new Error('任务不存在');
        }
        // 从realFolderName中获取文件夹名称 删除对应的本地文件
        const folderName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        const strmService = new StrmService();
        const strmEnabled = ConfigService.getConfigValue('strm.enable') && task.account.localStrmPrefix
        if (strmEnabled && task.enableSystemProxy){
            throw new Error('系统代理模式已移除');
        }
        const newFiles = files.map(file => ({id: file.fileId, name: file.destFileName}))
        if(task.enableSystemProxy) {
            throw new Error('系统代理模式已移除');
        }
        const cloud189 = Cloud189Service.getInstance(account);
        const result = []
        const successFiles = []
        for (const file of files) {
            const renameResult = await cloud189.renameFile(file.fileId, file.destFileName);
            if (!renameResult) {
                throw new Error('重命名失败');
            }
            if (renameResult.res_code != 0) {
                result.push(`文件${file.destFileName} ${renameResult.res_msg}`)
            }else{
                if (strmEnabled){
                    // 从realFolderName中获取文件夹名称 删除对应的本地文件
                    const oldFile = path.join(folderName, file.oldName);
                    await strmService.delete(path.join(task.account.localStrmPrefix, oldFile))
                }
                successFiles.push({id: file.fileId, name: file.destFileName})
            }
        }
        // 重新生成STRM文件
        if (strmEnabled){
            strmService.generate(task, successFiles, false, false)
        }
        if (sourceRegex && targetRegex) {
            task.sourceRegex = sourceRegex
            task.targetRegex = targetRegex
            taskRepo.save(task)
        }
        if (result.length > 0) {
            logTaskEvent(result.join('\n'));
        }
        res.json({ success: true, data: result });
    });

    app.post('/api/tasks/executeAll', async (req, res) => {
        taskService.processAllTasks(true);
        res.json({ success: true, data: null });
    });

    app.get('/api/subscriptions', async (req, res) => {
        try {
            const subscriptions = await subscriptionService.listSubscriptions();
            res.json({ success: true, data: subscriptions });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/preview', async (req, res) => {
        try {
            const preview = await subscriptionService.previewSubscriptionCreation(req.query);
            res.json({ success: true, data: preview });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions', async (req, res) => {
        try {
            const subscription = await subscriptionService.createSubscription(req.body);
            res.json({ success: true, data: subscription });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/subscriptions/:id', async (req, res) => {
        try {
            const subscription = await subscriptionService.updateSubscription(parseInt(req.params.id), req.body);
            res.json({ success: true, data: subscription });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions/:id/refresh', async (req, res) => {
        try {
            const result = await subscriptionService.refreshSubscription(parseInt(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/subscriptions/:id', async (req, res) => {
        try {
            await subscriptionService.deleteSubscription(parseInt(req.params.id));
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/:id/resources', async (req, res) => {
        try {
            const resources = await subscriptionService.listResources(parseInt(req.params.id));
            res.json({ success: true, data: resources });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/subscriptions/:id/resources', async (req, res) => {
        try {
            const resource = await subscriptionService.createResource(parseInt(req.params.id), req.body);
            res.json({ success: true, data: resource });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/subscriptions/resources/:id', async (req, res) => {
        try {
            await subscriptionService.deleteResource(parseInt(req.params.id));
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/subscriptions/resources/:id/browse', async (req, res) => {
        try {
            const entries = await subscriptionService.browseResource(
                parseInt(req.params.id),
                req.query.folderId,
                req.query.keyword
            );
            res.json({ success: true, data: entries });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // 系统设置
    app.get('/api/settings', async (req, res) => {
        res.json({success: true, data: ConfigService.getConfig()})
    })

    app.post('/api/settings', async (req, res) => {
        const settings = req.body;
        SchedulerService.handleScheduleTasks(settings,taskService);
        ConfigService.setConfig(settings)
        await botManager.handleBotStatus(
            settings.telegram?.bot?.botToken,
            settings.telegram?.bot?.chatId,
            settings.telegram?.bot?.enable
        );
        // 修改配置, 重新实例化消息推送
        messageUtil.updateConfig()
        Cloud189Service.setProxy()
        res.json({success: true, data: null})
    })


    // 保存媒体配置
    app.post('/api/settings/media', async (req, res) => {
        const settings = req.body;
        // 如果cloudSaver的配置变更 就清空cstoken.json
        if (settings.cloudSaver?.baseUrl != ConfigService.getConfigValue('cloudSaver.baseUrl')
        || settings.cloudSaver?.username != ConfigService.getConfigValue('cloudSaver.username')
        || settings.cloudSaver?.password != ConfigService.getConfigValue('cloudSaver.password')
    ) {
            clearCloudSaverToken();
        }
        ConfigService.setConfig(settings)
        res.json({success: true, data: null})
    })

    app.post('/api/settings/regex-presets', async (req, res) => {
        try {
            const regexPresets = Array.isArray(req.body.regexPresets) ? req.body.regexPresets : [];
            ConfigService.setConfigValue('regexPresets', regexPresets);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.get('/api/version', (req, res) => {
        res.json({ version: currentVersion });
    });

    app.get('/api/stream/:token', async (req, res) => {
        try {
            const latestUrl = await streamProxyService.resolveLatestUrl(req.params.token);
            res.set('Cache-Control', 'no-store');
            res.redirect(302, latestUrl);
        } catch (error) {
            res.status(403).json({ success: false, error: error.message });
        }
    });

    // 解析分享链接
    app.post('/api/share/parse', async (req, res) => {
        try{
            const shareLink = req.body.shareLink;
            const accountId = req.body.accountId;
            const accessCode = req.body.accessCode;
            const shareFolders = await taskService.parseShareFolderByShareLink(shareLink, accountId, accessCode);
            res.json({success: true, data: shareFolders})
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 保存常用目录
    app.post('/api/saveFavorites', async (req, res) => {
        try{
            const favorites = req.body.favorites;
            const accountId = req.body.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            // 先删除该账号下的所有常用目录
            await commonFolderRepo.delete({ accountId: accountId });
            // 构建新的常用目录数据
            const commonFolders = favorites.map(favorite => ({
                accountId: accountId,
                name: favorite.name,
                path: favorite.path,
                id: favorite.id
            }));
            if (commonFolders.length == 0) {
                res.json({ success: true, data: [] });
                return;
            }
            // 批量保存新的常用目录
            const result = await commonFolderRepo.save(commonFolders);
            res.json({ success: true, data: result });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    // 获取常用目录
    app.get('/api/favorites/:accountId', async (req, res) => {
        try{
            const accountId = req.params.accountId;
            if (!accountId) {
                throw new Error('账号ID不能为空');
            }
            const favorites = await commonFolderRepo.find({
                where: { accountId: accountId },
                order: { id: 'ASC' }
            });
            res.json({ success: true, data: favorites });
        }catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    })
    
    // emby 回调
    app.post('/emby/notify', async (req, res) => {
        try {
            await embyService.handleWebhookNotification(req.body);
            res.status(200).send('OK');
        }catch (error) {
            console.log(error);
            res.status(500).send('Error');
        }
    })

    app.post('/api/chat', async (req, res) => {
        const { message } = req.body;
        try {
            let userMessage = message.trim();
            if(!userMessage) {
                res.json({ success: true });
                return
            }
            
            AIService.streamChat(userMessage, async (chunk) => {
                sendAIMessage(chunk);
            })
            res.json({ success: true });
        } catch (error) {
            console.error('处理聊天消息失败:', error);
            res.status(500).json({ success: false, error: '处理消息失败' });
        }
    })


    // STRM相关API
    app.post('/api/strm/generate-all', async (req, res) => {
        try {
            const overwrite = req.body.overwrite || false;
            const accountIds = req.body.accountIds;
            if (!accountIds || accountIds.length == 0) {
                throw new Error('账号ID不能为空');
            }
            const accounts = await accountRepo.find({
                where: {
                    localStrmPrefix: Not(IsNull()),
                    cloudStrmPrefix: Not(IsNull()),
                    id: In(accountIds)
                }
            });
            const strmService = new StrmService();
            strmService.generateAll(accounts, overwrite);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/strm/list', async (req, res) => {
        try {
            const path = req.query.path || '';
            const strmService = new StrmService();
            const files = await strmService.listStrmFiles(path);
            res.json({ success: true, data: files });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/strm/configs', async (req, res) => {
        try {
            const configs = await strmConfigService.listConfigs();
            res.json({ success: true, data: configs });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs', async (req, res) => {
        try {
            const config = await strmConfigService.createConfig(req.body);
            await SchedulerService.refreshStrmConfigJob(config, strmConfigService);
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.put('/api/strm/configs/:id', async (req, res) => {
        try {
            const config = await strmConfigService.updateConfig(parseInt(req.params.id), req.body);
            await SchedulerService.refreshStrmConfigJob(config, strmConfigService);
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.delete('/api/strm/configs/:id', async (req, res) => {
        try {
            await strmConfigService.deleteConfig(parseInt(req.params.id));
            SchedulerService.removeTaskJob(`strm-config-${parseInt(req.params.id)}`);
            res.json({ success: true, data: null });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs/:id/run', async (req, res) => {
        try {
            const result = await strmConfigService.runConfig(parseInt(req.params.id));
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.post('/api/strm/configs/:id/reset', async (req, res) => {
        try {
            const config = await strmConfigService.resetSubscriptionConfig(parseInt(req.params.id));
            res.json({ success: true, data: config });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    app.get('/api/tmdb/search', async (req, res) => {
        try {
            const keyword = req.query.keyword?.trim();
            const year = req.query.year?.trim() || '';
            if (!keyword) {
                throw new Error('搜索关键字不能为空');
            }
            const result = await tmdbService.search(keyword, year);
            res.json({
                success: true,
                data: [
                    ...(result.movies || []),
                    ...(result.tvShows || [])
                ].slice(0, 10)
            });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    });

    // ai重命名
    app.post('/api/files/ai-rename', async (req, res) => {
        try {
            const { taskId, files } = req.body;
            if (files.length == 0) {
                throw new Error('未获取到需要修改的文件');
            }
            const task = await taskService.getTaskById(taskId);
            if (!task) {
                throw new Error('任务不存在');
            }
            // 开始ai分析
            const resourceInfo = await taskService._analyzeResourceInfo(
                task.resourceName,
                files,
                'file'
            )
            return res.json({ success: true, data: await taskService.handleAiRename(files, resourceInfo) });
        } catch (error) {
            res.json({ success: false, error: error.message });
        }
    })

    app.post('/api/custom-push/test', async (req, res) => {
        try{
            const configTest = req.body
            if (await new CustomPushService([]).testPush(configTest)){
                res.json({ success: true, data: null });
            }else{
                res.json({ success: false, error: '推送测试失败' });
            }

        }catch (error) {
            res.json({ success: false, error: error.message });
        }
    })
    
    // 全局错误处理中间件
    app.use((err, req, res, next) => {
        console.error('捕获到全局异常:', err.message);
        res.status(500).json({ success: false, error: error.message });
    });


    initSSE(app)

    // 初始化cloudsaver
    setupCloudSaverRoutes(app);
    // 启动服务器
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`服务器运行在 http://localhost:${port}`);
    });
}).catch(error => {
    console.error('数据库连接失败:', error);
});
