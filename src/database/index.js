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
    AuditRun,
    AuditEvent,
    AuditOperation,
    InvalidResource,
    AutoSeriesIntent,
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
    'CREATE INDEX IF NOT EXISTS "idx_pt_release_sub_guid" ON "pt_release" ("subscriptionId", "guid")',
    'CREATE INDEX IF NOT EXISTS "idx_pt_release_sub_episode" ON "pt_release" ("subscriptionId", "seasonNumber", "episodeNumber")',
    'CREATE INDEX IF NOT EXISTS "idx_workflow_run_type_status_updated" ON "workflow_run" ("type", "status", "updatedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_workflow_run_subject" ON "workflow_run" ("subjectType", "subjectId", "updatedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_run_started_module_status" ON "audit_run" ("startedAt", "module", "status")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_run_subject_started" ON "audit_run" ("subjectType", "subjectId", "startedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_run_correlation_started" ON "audit_run" ("correlationId", "startedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_run_account_started" ON "audit_run" ("accountId", "startedAt")',
    'CREATE UNIQUE INDEX IF NOT EXISTS "uq_audit_run_legacy_key" ON "audit_run" ("legacyKey")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_event_run_sequence" ON "audit_event" ("runId", "sequence")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_event_type_created" ON "audit_event" ("type", "createdAt")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_operation_run_sequence" ON "audit_operation" ("runId", "sequence")',
    'CREATE INDEX IF NOT EXISTS "idx_audit_operation_action_status_created" ON "audit_operation" ("action", "status", "createdAt")',
    'CREATE INDEX IF NOT EXISTS "idx_invalid_resource_hash_active" ON "invalid_resource" ("resourceHash", "expiresAt", "releasedAt")',
    'CREATE INDEX IF NOT EXISTS "idx_invalid_resource_source_type" ON "invalid_resource" ("source", "resourceType")',
    'CREATE INDEX IF NOT EXISTS "idx_auto_series_intent_status_next" ON "auto_series_intent" ("status", "nextRunAt")',
    'CREATE INDEX IF NOT EXISTS "idx_auto_series_intent_task" ON "auto_series_intent" ("taskId")',
    'CREATE INDEX IF NOT EXISTS "idx_auto_series_intent_pt" ON "auto_series_intent" ("ptSubscriptionId")'
];

const sqliteTables = [
    `CREATE TABLE IF NOT EXISTS "audit_run" (
        "id" text PRIMARY KEY NOT NULL,
        "correlationId" text NOT NULL,
        "parentRunId" text DEFAULT '',
        "module" text NOT NULL,
        "trigger" text DEFAULT '',
        "subjectType" text DEFAULT '',
        "subjectId" text DEFAULT '',
        "subjectName" text DEFAULT '',
        "accountId" integer,
        "status" text NOT NULL,
        "summary" text DEFAULT '',
        "changeCount" integer NOT NULL DEFAULT 0,
        "failureCount" integer NOT NULL DEFAULT 0,
        "metadataJson" text DEFAULT '',
        "legacyKey" text,
        "startedAt" datetime NOT NULL,
        "finishedAt" datetime,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS "audit_event" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "runId" text NOT NULL,
        "sequence" integer NOT NULL,
        "type" text NOT NULL,
        "level" text DEFAULT 'info',
        "phase" text DEFAULT '',
        "message" text DEFAULT '',
        "dataJson" text DEFAULT '',
        "error" text DEFAULT '',
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS "audit_operation" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "runId" text NOT NULL,
        "sequence" integer NOT NULL,
        "action" text NOT NULL,
        "status" text NOT NULL,
        "sourcePath" text DEFAULT '',
        "targetPath" text DEFAULT '',
        "beforeJson" text DEFAULT '',
        "afterJson" text DEFAULT '',
        "reason" text DEFAULT '',
        "decisionSource" text DEFAULT '',
        "verificationJson" text DEFAULT '',
        "attempts" integer NOT NULL DEFAULT 1,
        "error" text DEFAULT '',
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "completedAt" datetime
    )`,
    `CREATE TABLE IF NOT EXISTS "invalid_resource" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "resourceHash" text NOT NULL,
        "resourceType" text DEFAULT '',
        "source" text DEFAULT '',
        "errorCategory" text DEFAULT '',
        "errorCode" text DEFAULT '',
        "reason" text DEFAULT '',
        "metadataJson" text DEFAULT '',
        "expiresAt" datetime,
        "releasedAt" datetime,
        "releasedBy" text DEFAULT '',
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS "auto_series_intent" (
        "id" text PRIMARY KEY NOT NULL,
        "title" text NOT NULL,
        "year" text DEFAULT '',
        "tmdbId" text DEFAULT '',
        "tmdbJson" text DEFAULT '',
        "accountId" integer NOT NULL,
        "targetFolderId" text NOT NULL,
        "targetFolder" text DEFAULT '',
        "mode" text NOT NULL DEFAULT 'lazy',
        "sourcePreferencesJson" text DEFAULT '',
        "agentEnabled" boolean NOT NULL DEFAULT 0,
        "toolCallMode" text NOT NULL DEFAULT 'auto',
        "agentBudgetJson" text DEFAULT '',
        "mediaPreferenceJson" text DEFAULT '',
        "selectedSource" text DEFAULT '',
        "selectedResourceId" text DEFAULT '',
        "selectedShareLink" text DEFAULT '',
        "selectedResourceTitle" text DEFAULT '',
        "allowHdhivePoints" boolean NOT NULL DEFAULT 0,
        "hdhiveMaxPoints" integer NOT NULL DEFAULT 0,
        "keepCasAfterRestore" boolean NOT NULL DEFAULT 0,
        "taskId" integer,
        "ptSubscriptionId" integer,
        "taskIdsJson" text DEFAULT '',
        "ptSubscriptionIdsJson" text DEFAULT '',
        "coverageJson" text DEFAULT '',
        "metadataTemplateJson" text DEFAULT '',
        "status" text NOT NULL DEFAULT 'pending',
        "degraded" boolean NOT NULL DEFAULT 0,
        "failureCount" integer NOT NULL DEFAULT 0,
        "lastRunAt" datetime,
        "nextRunAt" datetime,
        "lastError" text DEFAULT '',
        "lastWorkflowRunId" text DEFAULT '',
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
    )`
];

const sqliteColumns = [
    { table: 'task', name: 'libraryLayout', sql: 'ALTER TABLE "task" ADD COLUMN "libraryLayout" text' },
    { table: 'task', name: 'coverageScopeJson', sql: 'ALTER TABLE "task" ADD COLUMN "coverageScopeJson" text DEFAULT \'\'' },
    { table: 'task', name: 'metadataOverrideJson', sql: 'ALTER TABLE "task" ADD COLUMN "metadataOverrideJson" text DEFAULT \'\'' },
    { table: 'task', name: 'metadataAppliedOverrideJson', sql: 'ALTER TABLE "task" ADD COLUMN "metadataAppliedOverrideJson" text DEFAULT \'\'' },
    { table: 'task', name: 'autoSeriesIntentId', sql: 'ALTER TABLE "task" ADD COLUMN "autoSeriesIntentId" text DEFAULT \'\'' },
    { table: 'task_processed_file', name: 'transferredCasFileId', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "transferredCasFileId" text DEFAULT \"\"' },
    { table: 'task_processed_file', name: 'casSourceFolderId', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "casSourceFolderId" text DEFAULT \"\"' },
    { table: 'task_processed_file', name: 'restoredCloudFileId', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "restoredCloudFileId" text DEFAULT \"\"' },
    { table: 'task_processed_file', name: 'casArchiveStatus', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "casArchiveStatus" text DEFAULT \"none\"' },
    { table: 'task_processed_file', name: 'casArchiveRelativePath', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "casArchiveRelativePath" text DEFAULT \"\"' },
    { table: 'task_processed_file', name: 'casArchiveFileId', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "casArchiveFileId" text DEFAULT \"\"' },
    { table: 'task_processed_file', name: 'casArchiveError', sql: 'ALTER TABLE "task_processed_file" ADD COLUMN "casArchiveError" text DEFAULT \"\"' },
    { table: 'pt_subscription', name: 'episodeDedup', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "episodeDedup" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'standbyRssJson', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "standbyRssJson" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'coexist', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "coexist" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'downloadNew', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "downloadNew" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'delayedDownloadMinutes', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "delayedDownloadMinutes" integer DEFAULT 0' },
    { table: 'pt_subscription', name: 'notDownloadEpisodes', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "notDownloadEpisodes" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'skipHalfEpisode', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "skipHalfEpisode" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'customEpisode', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "customEpisode" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'customEpisodeRegex', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "customEpisodeRegex" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'customEpisodeGroupIndex', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "customEpisodeGroupIndex" integer DEFAULT 1' },
    { table: 'pt_subscription', name: 'episodeOffset', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "episodeOffset" float DEFAULT 0' },
    { table: 'pt_subscription', name: 'omit', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "omit" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'missingEpisodesJson', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "missingEpisodesJson" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'totalEpisodeNumber', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "totalEpisodeNumber" integer DEFAULT 0' },
    { table: 'pt_subscription', name: 'currentEpisodeNumber', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "currentEpisodeNumber" integer DEFAULT 0' },
    { table: 'pt_subscription', name: 'autoDisabled', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "autoDisabled" boolean NOT NULL DEFAULT 0' },
    { table: 'pt_subscription', name: 'globalExclude', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "globalExclude" boolean NOT NULL DEFAULT 1' },
    { table: 'pt_release', name: 'rawTitle', sql: 'ALTER TABLE "pt_release" ADD COLUMN "rawTitle" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'subgroup', sql: 'ALTER TABLE "pt_release" ADD COLUMN "subgroup" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'seasonNumber', sql: 'ALTER TABLE "pt_release" ADD COLUMN "seasonNumber" integer' },
    { table: 'pt_release', name: 'episodeNumber', sql: 'ALTER TABLE "pt_release" ADD COLUMN "episodeNumber" float' },
    { table: 'pt_release', name: 'episodeLabel', sql: 'ALTER TABLE "pt_release" ADD COLUMN "episodeLabel" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'resolution', sql: 'ALTER TABLE "pt_release" ADD COLUMN "resolution" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'quality', sql: 'ALTER TABLE "pt_release" ADD COLUMN "quality" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'releaseTagsJson', sql: 'ALTER TABLE "pt_release" ADD COLUMN "releaseTagsJson" text DEFAULT \'\'' },
    { table: 'workflow_run', name: 'subjectType', sql: 'ALTER TABLE "workflow_run" ADD COLUMN "subjectType" text DEFAULT \'\'' },
    { table: 'workflow_run', name: 'subjectId', sql: 'ALTER TABLE "workflow_run" ADD COLUMN "subjectId" text DEFAULT \'\'' },
    { table: 'workflow_run', name: 'protocol', sql: 'ALTER TABLE "workflow_run" ADD COLUMN "protocol" text DEFAULT \'\'' },
    { table: 'workflow_run', name: 'summary', sql: 'ALTER TABLE "workflow_run" ADD COLUMN "summary" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'selectedSource', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "selectedSource" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'selectedResourceId', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "selectedResourceId" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'selectedShareLink', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "selectedShareLink" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'selectedResourceTitle', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "selectedResourceTitle" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'taskIdsJson', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "taskIdsJson" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'ptSubscriptionIdsJson', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "ptSubscriptionIdsJson" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'coverageJson', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "coverageJson" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'filterManagedBy', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "filterManagedBy" text DEFAULT \'manual\'' },
    { table: 'pt_subscription', name: 'filterValidationHash', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "filterValidationHash" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'mediaPreferenceJson', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "mediaPreferenceJson" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'upgradePolicy', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "upgradePolicy" text DEFAULT \'none\'' },
    { table: 'pt_subscription', name: 'metadataTemplateJson', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "metadataTemplateJson" text DEFAULT \'\'' },
    { table: 'pt_subscription', name: 'autoSeriesIntentId', sql: 'ALTER TABLE "pt_subscription" ADD COLUMN "autoSeriesIntentId" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'qualityScore', sql: 'ALTER TABLE "pt_release" ADD COLUMN "qualityScore" integer DEFAULT 0' },
    { table: 'pt_release', name: 'upgradeFromReleaseId', sql: 'ALTER TABLE "pt_release" ADD COLUMN "upgradeFromReleaseId" integer' },
    { table: 'pt_release', name: 'activeVersion', sql: 'ALTER TABLE "pt_release" ADD COLUMN "activeVersion" boolean NOT NULL DEFAULT 1' },
    { table: 'pt_release', name: 'metadataTemplateSnapshotJson', sql: 'ALTER TABLE "pt_release" ADD COLUMN "metadataTemplateSnapshotJson" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'metadataOverrideJson', sql: 'ALTER TABLE "pt_release" ADD COLUMN "metadataOverrideJson" text DEFAULT \'\'' },
    { table: 'pt_release', name: 'metadataAppliedOverrideJson', sql: 'ALTER TABLE "pt_release" ADD COLUMN "metadataAppliedOverrideJson" text DEFAULT \'\'' },
    { table: 'auto_series_intent', name: 'metadataTemplateJson', sql: 'ALTER TABLE "auto_series_intent" ADD COLUMN "metadataTemplateJson" text DEFAULT \'\'' }
];

const ensureDatabaseTables = async () => {
    if (!AppDataSource.isInitialized || AppDataSource.options.type !== 'sqlite') return;
    for (const sql of sqliteTables) {
        await AppDataSource.query(sql);
    }
};

const ensureDatabaseColumns = async () => {
    if (!AppDataSource.isInitialized || AppDataSource.options.type !== 'sqlite') {
        return;
    }

    const tableColumnCache = new Map();
    for (const column of sqliteColumns) {
        try {
            if (!tableColumnCache.has(column.table)) {
                const rows = await AppDataSource.query(`PRAGMA table_info("${column.table}")`);
                tableColumnCache.set(column.table, new Set((rows || []).map(row => row.name)));
            }
            const columns = tableColumnCache.get(column.table);
            if (!columns || columns.size === 0 || columns.has(column.name)) {
                continue;
            }
            await AppDataSource.query(column.sql);
            columns.add(column.name);
        } catch (error) {
            console.warn('数据库字段初始化跳过:', column.table, column.name, error.message);
        }
    }
};

const AppDataSource = new DataSource({
    type: 'sqlite',
    database: path.join(__dirname, '../../data/database.sqlite'),
    synchronize: synchronizeSchema,
    logging: false,
    maxQueryExecutionTime: 1000, // 查询超时设置
    enableWAL: true,   // 启用 WAL 模式提升性能
    busyTimeout: 3000, // 设置超时时间
    entities: [Account, Task, CommonFolder, Subscription, SubscriptionResource, StrmConfig, TaskProcessedFile, WorkflowRun, AuditRun, AuditEvent, AuditOperation, InvalidResource, AutoSeriesIntent, TmdbCache, PtSubscription, PtRelease],
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
        await ensureDatabaseTables();
        await ensureDatabaseColumns();
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
const getAuditRunRepository = () => AppDataSource.getRepository(AuditRun);
const getAuditEventRepository = () => AppDataSource.getRepository(AuditEvent);
const getAuditOperationRepository = () => AppDataSource.getRepository(AuditOperation);
const getInvalidResourceRepository = () => AppDataSource.getRepository(InvalidResource);
const getAutoSeriesIntentRepository = () => AppDataSource.getRepository(AutoSeriesIntent);
const getTmdbCacheRepository = () => AppDataSource.getRepository(TmdbCache);
const getPtSubscriptionRepository = () => AppDataSource.getRepository(PtSubscription);
const getPtReleaseRepository = () => AppDataSource.getRepository(PtRelease);

module.exports = {
    AppDataSource,
    ensureDatabaseColumns,
    ensureDatabaseTables,
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
    getAuditRunRepository,
    getAuditEventRepository,
    getAuditOperationRepository,
    getInvalidResourceRepository,
    getAutoSeriesIntentRepository,
    getTmdbCacheRepository,
    getPtSubscriptionRepository,
    getPtReleaseRepository
};
