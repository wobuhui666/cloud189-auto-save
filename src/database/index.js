const { DataSource } = require('typeorm');
const {
    Account,
    Task,
    CommonFolder,
    Subscription,
    SubscriptionResource,
    StrmConfig,
    TaskProcessedFile,
    WorkflowRun,
    TmdbCache,
    PtSubscription,
    PtRelease
} = require('../entities');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const synchronizeSchema = process.env.TYPEORM_SYNCHRONIZE != null
    ? process.env.TYPEORM_SYNCHRONIZE === 'true'
    : process.env.NODE_ENV !== 'production';

const sqliteIndexes = [
    'CREATE INDEX IF NOT EXISTS "idx_task_status_proxy_id" ON "task" ("status", "enableSystemProxy", "id")',
    'CREATE INDEX IF NOT EXISTS "idx_task_retry_status_time" ON "task" ("status", "nextRetryTime")',
    'CREATE INDEX IF NOT EXISTS "idx_task_cron_enabled_id" ON "task" ("enableCron", "id")',
    'CREATE INDEX IF NOT EXISTS "idx_task_processed_task_status_updated" ON "task_processed_file" ("taskId", "status", "updatedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_task_processed_task_updated" ON "task_processed_file" ("taskId", "updatedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_subscription_resource_sub_status" ON "subscription_resource" ("subscriptionId", "verifyStatus")',
    'CREATE INDEX IF NOT EXISTS "idx_subscription_resource_sub_id" ON "subscription_resource" ("subscriptionId", "id")',
    'CREATE INDEX IF NOT EXISTS "idx_pt_subscription_enabled_id" ON "pt_subscription" ("enabled", "id")',
    'CREATE INDEX IF NOT EXISTS "idx_pt_release_sub_status_id" ON "pt_release" ("subscriptionId", "status", "id")',
    'CREATE INDEX IF NOT EXISTS "idx_pt_release_sub_guid" ON "pt_release" ("subscriptionId", "guid")'
];

const AppDataSource = new DataSource({
    type: 'sqlite',
    database: path.join(__dirname, '../../data/database.sqlite'),
    synchronize: synchronizeSchema,
    logging: false,
    maxQueryExecutionTime: 1000, // 查询超时设置
    enableWAL: true,   // 启用 WAL 模式提升性能
    busyTimeout: 3000, // 设置超时时间
    entities: [Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig, TaskProcessedFile, WorkflowRun, TmdbCache, PtSubscription, PtRelease],
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

const ensureDatabaseIndexes = async () => {
    if (!AppDataSource.isInitialized || AppDataSource.options.type !== 'sqlite') {
        return;
    }
    for (const sql of sqliteIndexes) {
        try {
            await AppDataSource.query(sql);
        } catch (error) {
            console.warn('数据库索引初始化跳过:', error.message);
        }
    }
};

const initDatabase = async () => {
    try {
        await AppDataSource.initialize();
        await ensureDatabaseIndexes();
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
const getPtSubscriptionRepository = () => AppDataSource.getRepository(PtSubscription);
const getPtReleaseRepository = () => AppDataSource.getRepository(PtRelease);

module.exports = {
    AppDataSource,
    ensureDatabaseIndexes,
    initDatabase,
    getAccountRepository,
    getTaskRepository,
    getCommonFolderRepository,
    getSubscriptionRepository,
    getSubscriptionResourceRepository,
    getStrmConfigRepository,
    getTaskProcessedFileRepository,
    getWorkflowRunRepository,
    getPtSubscriptionRepository,
    getPtReleaseRepository
};
