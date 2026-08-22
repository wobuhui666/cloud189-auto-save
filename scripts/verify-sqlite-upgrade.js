const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { DataSource } = require('typeorm');

async function main() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud189-upgrade-'));
    const database = path.join(tempDir, 'database.sqlite');
    const source = new DataSource({
        type: 'sqlite',
        database,
        driver: sqlite3,
        synchronize: false,
        logging: false,
        entities: []
    });
    await source.initialize();
    try {
        await source.query('CREATE TABLE "account" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "username" text NOT NULL, "password" text NOT NULL, "cookies" text)');
        await source.query('CREATE TABLE "task" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "status" text NOT NULL DEFAULT \'pending\', "enableSystemProxy" boolean NOT NULL DEFAULT 0, "nextRetryTime" datetime, "enableCron" boolean NOT NULL DEFAULT 0)');
        await source.query('CREATE TABLE "task_processed_file" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "taskId" integer NOT NULL, "status" text NOT NULL DEFAULT \'pending\', "updatedAt" datetime NOT NULL DEFAULT (datetime(\'now\')))');
        await source.query('CREATE TABLE "subscription_resource" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "subscriptionId" integer NOT NULL, "verifyStatus" text NOT NULL DEFAULT \'unknown\')');
        await source.query('CREATE TABLE "workflow_run" ("id" text PRIMARY KEY NOT NULL, "type" text NOT NULL, "status" text NOT NULL, "steps" text, "current" integer NOT NULL DEFAULT 0, "context" text, "createdAt" datetime NOT NULL DEFAULT (datetime(\'now\')), "updatedAt" datetime NOT NULL DEFAULT (datetime(\'now\')))');
        await source.query('CREATE TABLE "pt_subscription" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" text NOT NULL, "sourcePreset" text NOT NULL DEFAULT \'generic\', "rssUrl" text NOT NULL, "accountId" integer NOT NULL, "targetFolderId" text NOT NULL, "enabled" boolean NOT NULL DEFAULT 1, "createdAt" datetime NOT NULL DEFAULT (datetime(\'now\')), "updatedAt" datetime NOT NULL DEFAULT (datetime(\'now\')))');
        await source.query('CREATE TABLE "pt_release" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "subscriptionId" integer NOT NULL, "guid" text NOT NULL, "title" text NOT NULL, "status" text NOT NULL DEFAULT \'pending\', "createdAt" datetime NOT NULL DEFAULT (datetime(\'now\')), "updatedAt" datetime NOT NULL DEFAULT (datetime(\'now\')))');

        const databaseModulePath = require.resolve('../dist/database');
        const databaseModule = require(databaseModulePath);
        databaseModule.AppDataSource.setOptions({ database, synchronize: false });
        if (databaseModule.AppDataSource.isInitialized) await databaseModule.AppDataSource.destroy();
        await databaseModule.AppDataSource.initialize();
        await databaseModule.ensureDatabaseTables();
        await databaseModule.ensureDatabaseColumns();
        await databaseModule.ensureDatabaseIndexes();
        // 升级必须可重复执行，审计账本不得因重启产生重复表或索引错误。
        await databaseModule.ensureDatabaseTables();
        await databaseModule.ensureDatabaseColumns();
        await databaseModule.ensureDatabaseIndexes();

        const intentColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("auto_series_intent")');
        const taskColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("task")');
        const workflowColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("workflow_run")');
        const ptColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("pt_subscription")');
        const releaseColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("pt_release")');
        const auditRunColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("audit_run")');
        const auditEventColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("audit_event")');
        const auditOperationColumns = await databaseModule.AppDataSource.query('PRAGMA table_info("audit_operation")');
        const indexRows = await databaseModule.AppDataSource.query('SELECT name FROM sqlite_master WHERE type = \'index\'');
        const has = (rows, name) => rows.some(row => row.name === name);
        for (const [rows, names] of [
            [taskColumns, ['coverageScopeJson', 'metadataOverrideJson', 'metadataAppliedOverrideJson', 'autoSeriesIntentId']],
            [intentColumns, ['agentEnabled', 'toolCallMode', 'selectedSource', 'selectedResourceId', 'selectedShareLink', 'selectedResourceTitle', 'taskIdsJson', 'ptSubscriptionIdsJson', 'coverageJson', 'metadataTemplateJson']],
            [workflowColumns, ['subjectType', 'subjectId', 'protocol', 'summary']],
            [ptColumns, ['filterManagedBy', 'filterValidationHash', 'mediaPreferenceJson', 'upgradePolicy', 'metadataTemplateJson', 'autoSeriesIntentId']],
            [releaseColumns, ['qualityScore', 'upgradeFromReleaseId', 'activeVersion', 'metadataTemplateSnapshotJson', 'metadataOverrideJson', 'metadataAppliedOverrideJson']]
        ]) {
            for (const name of names) if (!has(rows, name)) throw new Error(`升级缺少字段: ${name}`);
        }
        for (const name of ['idx_auto_series_intent_status_next', 'idx_invalid_resource_hash_active', 'idx_workflow_run_subject']) {
            if (!has(indexRows, name)) throw new Error(`升级缺少索引: ${name}`);
        }
        for (const [rows, names] of [
            [auditRunColumns, ['id', 'correlationId', 'module', 'status', 'legacyKey', 'startedAt', 'finishedAt']],
            [auditEventColumns, ['runId', 'sequence', 'type', 'dataJson']],
            [auditOperationColumns, ['runId', 'sequence', 'action', 'status', 'sourcePath', 'targetPath', 'verificationJson']]
        ]) {
            for (const name of names) if (!has(rows, name)) throw new Error(`升级缺少审计字段: ${name}`);
        }
        for (const name of ['idx_audit_run_started_module_status', 'idx_audit_event_run_sequence', 'idx_audit_operation_run_sequence', 'uq_audit_run_legacy_key']) {
            if (!has(indexRows, name)) throw new Error(`升级缺少审计索引: ${name}`);
        }
        console.log('SQLite 旧库显式升级验证通过');
        await databaseModule.AppDataSource.destroy();
    } finally {
        if (source.isInitialized) await source.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
