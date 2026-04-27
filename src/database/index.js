const { DataSource } = require('typeorm');
const { Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig, TaskProcessedFile, WorkflowRun, TmdbCache } = require('../entities');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const AppDataSource = new DataSource({
    type: 'sqlite',
    database: path.join(__dirname, '../../data/database.sqlite'),
    synchronize: true,
    logging: false,
    maxQueryExecutionTime: 1000, // 查询超时设置
    enableWAL: true,   // 启用 WAL 模式提升性能
    busyTimeout: 3000, // 设置超时时间
    entities: [Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig, TaskProcessedFile, WorkflowRun, TmdbCache],
    subscribers: [],
    migrations: [],
    timezone: '+08:00',  // 添加时区设置
    dateStrings: true,   // 将日期作为字符串返回
    poolSize: 10,
    queryTimeout: 30000,
    // 添加自定义日期处理
    extra: {
        dateStrings: true,
        typeCast: function (field, next) {
            if (field.type === 'DATETIME') {
                return new Date(`${field.string()}+08:00`);
            }
            return next();
        }
    }
});

const initDatabase = async () => {
    try {
        await AppDataSource.initialize();
        console.log('数据库连接成功');
    } catch (error) {
        console.error('数据库连接失败:', error);
        process.exit(1);
    }
};

const getAccountRepository = () => AppDataSource.getRepository(Account);
const getTaskRepository = () => AppDataSource.getRepository(Task);
const getCommonFolderRepository = () => AppDataSource.getRepository(CommonFolder);
const getSubscriptionRepository = () => AppDataSource.getRepository(Subscription);
const getSubscriptionResourceRepository = () => AppDataSource.getRepository(SubscriptionResource);
const getStrmConfigRepository = () => AppDataSource.getRepository(StrmConfig);
const getTaskProcessedFileRepository = () => AppDataSource.getRepository(TaskProcessedFile);
const getWorkflowRunRepository = () => AppDataSource.getRepository(WorkflowRun);

module.exports = {
    AppDataSource,
    initDatabase,
    getAccountRepository,
    getTaskRepository,
    getCommonFolderRepository,
    getSubscriptionRepository,
    getSubscriptionResourceRepository,
    getStrmConfigRepository,
    getTaskProcessedFileRepository,
    getWorkflowRunRepository
};
