import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import PasswordCrypto from '../utils/passwordCrypto';
import ConfigService from '../services/ConfigService';

// 获取加密密钥
const getEncryptionKey = (): Buffer => {
    const envKey = PasswordCrypto.getEncryptionKey();
    if (envKey) return envKey;

    // 从配置文件读取或生成新密钥
    let configKey = ConfigService.getConfigValue('system.passwordEncryptionKey') as unknown as string;
    if (!configKey) {
        configKey = PasswordCrypto.generateKey().toString('hex');
        ConfigService.setConfigValue('system.passwordEncryptionKey', configKey);
    }
    return Buffer.from(configKey, 'hex');
};

// 服务端敏感文本共用：读时解密，写时加密；已是 iv:hex 则跳过防双重加密
const encryptedTextTransformer = {
    from: (value: string | null) => {
        if (!value) return value;
        if (!PasswordCrypto.isEncrypted(value)) {
            return value;
        }
        try {
            const key = getEncryptionKey();
            return PasswordCrypto.decrypt(value, key);
        } catch {
            return value;
        }
    },
    to: (value: string | null) => {
        if (!value) return value;
        if (PasswordCrypto.isEncrypted(value)) {
            return value;
        }
        try {
            const key = getEncryptionKey();
            return PasswordCrypto.encrypt(value, key);
        } catch {
            return value;
        }
    }
};

@Entity()
export class Account {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    username!: string;

    @Column('text', {
        nullable: true,
        transformer: encryptedTextTransformer
    })
    password!: string;

    @Column('text', {
        nullable: true,
        transformer: encryptedTextTransformer
    })
    cookies!: string;

    @Column('boolean', { default: true })
    isActive!: boolean;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;

    @Column('boolean', { nullable: true, default: false })
    clearRecycle!: boolean;

    @Column('text', { nullable: true, default: ''  })
    localStrmPrefix!: string;
    @Column('text', { nullable: true, default: '' })
    cloudStrmPrefix!: string;
    @Column('text', { nullable: true, default: '' })
    embyPathReplace!:string;

    @Column('boolean', { nullable: true, default: false })
    tgBotActive!: boolean;

    @Column('text', { nullable: true, default: '' })
    alias!: string;

    @Column('text', { nullable: true, default: 'personal' })
    accountType!: string;

    @Column('text', { nullable: true })
    familyId!: string;

    @Column('text', { nullable: true, default: '' })
    familyFolderId!: string;

    // 默认账号
    @Column('boolean', { nullable: true, default: false })
    isDefault!: boolean;
}

@Entity()
@Index('idx_task_status_proxy_id', ['status', 'enableSystemProxy', 'id'])
@Index('idx_task_retry_status_time', ['status', 'nextRetryTime'])
@Index('idx_task_cron_enabled_id', ['enableCron', 'id'])
export class Task {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    accountId!: number;

    @ManyToOne(() => Account, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'accountId' })
    account!: Account;

    @Column('text')
    shareLink!: string;

    @Column('text')
    targetFolderId!: string;

    @Column('text', { nullable: true })
    targetFolderName!: string;

    @Column('text', { nullable: true })
    organizerTargetFolderId!: string;

    @Column('text', { nullable: true })
    organizerTargetFolderName!: string;

    @Column('text', { nullable: true })
    videoType!: string;

    @Column('text', { default: 'pending' })
    status!: string;

    @Column('text', { nullable: true })
    lastError!: string;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastCheckTime!: Date;

    @Column('datetime', { nullable: true})
    lastFileUpdateTime!: Date;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastSourceRefreshTime!: Date;

    @Column('text', { nullable: true })
    resourceName!: string;

    @Column('integer', { default: 0 })
    totalEpisodes!: number;

    @Column('integer', { default: 0 })
    currentEpisodes!: number;

    @Column('text', { nullable: true })
    realFolderId!: string;

    @Column('text', { nullable: true })
    realFolderName!: string;

    @Column('text', { nullable: true })
    shareFileId!: string;

    @Column('text', { nullable: true })
    shareFolderId!: string;

    @Column('text', { nullable: true })
    shareFolderName!: string;

    @Column('text', { nullable: true })
    shareId!: string;
    
    @Column('text', { nullable: true })
    shareMode!: string;

    @Column('text', { nullable: true })
    pathType!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;

    @Column('text', { nullable: true })
    accessCode!: string;

    @Column('text', { nullable: true })
    sourceRegex!: string;
    
    @Column('text', { nullable: true })
    targetRegex!: string;

    @Column('text', { nullable: true })
    matchPattern!: string;
    @Column('text', { nullable: true })
    matchOperator!: string;
    @Column('text', { nullable: true })
    matchValue!: string;

    @Column('integer', { nullable: true })
    retryCount!: number;
    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    nextRetryTime!: Date;

    @Column('text', { nullable: true })
    remark!: string;

    @Column('text', { nullable: true })
    taskGroup!: string;

    @Column({ nullable: true })
    cronExpression!: string;

    @Column({ default: false })
    enableCron!: boolean;

    @Column({ nullable: true })
    realRootFolderId!: string;

    @Column({ nullable: true })
    embyId!: string;

    @Column({ nullable: true })
    tmdbId!: string; // tmdbId, 用于匹配tmdb和emby的电影

    @Column('integer', { nullable: true })
    tmdbSeasonNumber!: number;

    @Column('text', { nullable: true })
    tmdbSeasonName!: string;

    @Column('integer', { nullable: true })
    tmdbSeasonEpisodes!: number;

    @Column('boolean', { nullable: true, default: false })
    manualTmdbBound!: boolean;

    @Column('integer', { nullable: true })
    manualSeason!: number;

    @Column('text', { nullable: true })
    tmdbTitle!: string;
    
    @Column({ nullable: true })
    enableTaskScraper!: boolean; // 是否启用刮削

    @Column('boolean', { nullable: true, default: false })
    enableLazyStrm!: boolean; // 是否启用懒转存STRM

    @Column('boolean', { nullable: true, default: false })
    enableOrganizer!: boolean; // 是否启用整理器

    @Column('boolean', { nullable: true, default: false })
    keepCasAfterRestore!: boolean; // CAS秒传恢复后是否保留原CAS文件

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastOrganizedAt!: Date;

    @Column('text', { nullable: true })
    lastOrganizeError!: string;

    // 锁定的媒体库布局 JSON：{categoryName,resourceFolderName,mediaType,year,canonicalTitle,tmdbId,...}
    @Column('text', { nullable: true })
    libraryLayout!: string;

    // 自动追剧多来源任务允许处理的季度/集数范围 JSON
    @Column('text', { nullable: true, default: '' })
    coverageScopeJson!: string;

    // 版本化人工/Agent 元数据覆盖，以及最近一次实际应用的快照
    @Column('text', { nullable: true, default: '' })
    metadataOverrideJson!: string;

    @Column('text', { nullable: true, default: '' })
    metadataAppliedOverrideJson!: string;

    @Column('text', { nullable: true, default: '' })
    autoSeriesIntentId!: string;

    @Column({ nullable: true })
    enableSystemProxy!: boolean; // 是否启用系统代理
    // tmdb内容 json格式
    @Column('text', { nullable: true })
    tmdbContent!: string;

    // 是否是文件夹
    @Column('boolean', { nullable: true, default: true })
    isFolder!: boolean;
}

@Entity()
@Index(['taskId', 'sourceFileId'], { unique: true })
@Index('idx_task_processed_task_status_updated', ['taskId', 'status', 'updatedAt'])
@Index('idx_task_processed_task_updated', ['taskId', 'updatedAt'])
export class TaskProcessedFile {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    taskId!: number;

    @ManyToOne(() => Task, { nullable: false, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'taskId' })
    task!: Task;

    @Column('text')
    sourceFileId!: string;

    @Column('text', { nullable: true })
    sourceFileName!: string;

    @Column('text', { nullable: true })
    sourceMd5!: string;

    @Column('text', { nullable: true })
    sourceShareId!: string;

    @Column('text', { nullable: true })
    restoredFileName!: string;

    @Column('text', { nullable: true, default: '' })
    transferredCasFileId!: string;

    @Column('text', { nullable: true, default: '' })
    casSourceFolderId!: string;

    @Column('text', { nullable: true, default: '' })
    restoredCloudFileId!: string;

    @Column('text', { nullable: true, default: 'none' })
    casArchiveStatus!: string;

    @Column('text', { nullable: true, default: '' })
    casArchiveRelativePath!: string;

    @Column('text', { nullable: true, default: '' })
    casArchiveFileId!: string;

    @Column('text', { nullable: true, default: '' })
    casArchiveError!: string;

    @Column('text', { default: 'processing' })
    status!: string;

    @Column('text', { nullable: true })
    lastError!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

// 常用目录表
@Entity()
export class CommonFolder {
    @Column('text', { primary: true })
    id!: string;

    @Column('integer')
    accountId!: number;

    @ManyToOne(() => Account, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'accountId' })
    account!: Account;

    @Column('text')
    path!: string;

    @Column('text')
    name!: string;
}

@Entity()
export class Subscription {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text', { unique: true })
    uuid!: string;

    @Column('text')
    name!: string;

    @Column('text', { nullable: true, default: '' })
    remark!: string;

    @Column('boolean', { default: true })
    enabled!: boolean;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastRefreshTime!: Date;

    @Column('text', { nullable: true, default: 'unknown' })
    lastRefreshStatus!: string;

    @Column('text', { nullable: true, default: '' })
    lastRefreshMessage!: string;

    @Column('integer', { nullable: true, default: 0 })
    validResourceCount!: number;

    @Column('integer', { nullable: true, default: 0 })
    invalidResourceCount!: number;

    @Column('integer', { nullable: true, default: 0 })
    availableAccountCount!: number;

    @Column('integer', { nullable: true, default: 0 })
    totalAccountCount!: number;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
@Index('idx_subscription_resource_sub_status', ['subscriptionId', 'verifyStatus'])
@Index('idx_subscription_resource_sub_id', ['subscriptionId', 'id'])
export class SubscriptionResource {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    subscriptionId!: number;

    @ManyToOne(() => Subscription, { nullable: true })
    @JoinColumn({ name: 'subscriptionId' })
    subscription!: Subscription;

    @Column('text')
    title!: string;

    @Column('text')
    shareLink!: string;

    @Column('text', { nullable: true, default: '' })
    accessCode!: string;

    @Column('text', { nullable: true })
    shareId!: string;

    @Column('text', { nullable: true })
    shareMode!: string;

    @Column('text', { nullable: true })
    shareFileId!: string;

    @Column('text', { nullable: true })
    shareFileName!: string;

    @Column('boolean', { default: true })
    isFolder!: boolean;

    @Column('text', { nullable: true, default: 'unknown' })
    verifyStatus!: string;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastVerifiedAt!: Date;

    @Column('text', { nullable: true, default: '' })
    lastVerifyError!: string;

    @Column('text', { nullable: true, default: '' })
    availableAccountIds!: string;

    @Column('text', { nullable: true, default: '' })
    verifyDetails!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
export class StrmConfig {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    name!: string;

    @Column('text', { default: 'normal' })
    type!: string;

    @Column('text', { nullable: true, default: '' })
    accountIds!: string;

    @Column('text', { nullable: true, default: '' })
    directories!: string;

    @Column('integer', { nullable: true })
    subscriptionId!: number | null;

    @Column('text', { nullable: true, default: '' })
    resourceIds!: string;

    @Column('text', { nullable: true, default: '' })
    localPathPrefix!: string;

    @Column('text', { nullable: true, default: '' })
    excludePattern!: string;

    @Column('boolean', { default: false })
    overwriteExisting!: boolean;

    // 普通配置：是否用系统中转写 /api/stream 代理地址（订阅固定中转，此字段仅对 normal 生效）
    @Column('boolean', { default: true })
    useStreamProxy!: boolean;

    @Column('boolean', { default: false })
    enableCron!: boolean;

    @Column('text', { nullable: true, default: '' })
    cronExpression!: string;

    @Column('boolean', { default: true })
    enabled!: boolean;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastRunAt!: Date | null;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastCheckTime!: Date | null;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
@Index('idx_workflow_run_type_status_updated', ['type', 'status', 'updatedAt'])
export class WorkflowRun {
    @Column('text', { primary: true })
    id!: string;

    @Column('text')
    type!: string;

    @Column('text')
    status!: string;

    @Column('simple-json')
    steps!: any[];

    @Column('integer', { default: 0 })
    current!: number;

    @Column('simple-json', { nullable: true })
    context!: Record<string, any>;

    @Column('text', { nullable: true })
    confirmKey!: string | null;

    @Column('text', { nullable: true })
    source!: string | null;

    @Column('text', { nullable: true })
    chatId!: string | null;

    @Column('text', { nullable: true, default: '' })
    subjectType!: string;

    @Column('text', { nullable: true, default: '' })
    subjectId!: string;

    @Column('text', { nullable: true, default: '' })
    protocol!: string;

    @Column('text', { nullable: true, default: '' })
    summary!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
@Index('idx_audit_run_started_module_status', ['startedAt', 'module', 'status'])
@Index('idx_audit_run_subject_started', ['subjectType', 'subjectId', 'startedAt'])
@Index('idx_audit_run_correlation_started', ['correlationId', 'startedAt'])
@Index('idx_audit_run_account_started', ['accountId', 'startedAt'])
@Index('uq_audit_run_legacy_key', ['legacyKey'], { unique: true })
export class AuditRun {
    @Column('text', { primary: true })
    id!: string;

    @Column('text')
    correlationId!: string;

    @Column('text', { nullable: true, default: '' })
    parentRunId!: string;

    @Column('text')
    module!: string;

    @Column('text', { nullable: true, default: '' })
    trigger!: string;

    @Column('text', { nullable: true, default: '' })
    subjectType!: string;

    @Column('text', { nullable: true, default: '' })
    subjectId!: string;

    @Column('text', { nullable: true, default: '' })
    subjectName!: string;

    @Column('integer', { nullable: true })
    accountId!: number | null;

    @Column('text')
    status!: string;

    @Column('text', { nullable: true, default: '' })
    summary!: string;

    @Column('integer', { default: 0 })
    changeCount!: number;

    @Column('integer', { default: 0 })
    failureCount!: number;

    @Column('text', { nullable: true, default: '' })
    metadataJson!: string;

    @Column('text', { nullable: true })
    legacyKey!: string | null;

    @Column('datetime')
    startedAt!: Date;

    @Column('datetime', { nullable: true })
    finishedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

@Entity()
@Index('idx_audit_event_run_sequence', ['runId', 'sequence'])
@Index('idx_audit_event_type_created', ['type', 'createdAt'])
export class AuditEvent {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    runId!: string;

    @Column('integer')
    sequence!: number;

    @Column('text')
    type!: string;

    @Column('text', { nullable: true, default: 'info' })
    level!: string;

    @Column('text', { nullable: true, default: '' })
    phase!: string;

    @Column('text', { nullable: true, default: '' })
    message!: string;

    @Column('text', { nullable: true, default: '' })
    dataJson!: string;

    @Column('text', { nullable: true, default: '' })
    error!: string;

    @CreateDateColumn()
    createdAt!: Date;
}

@Entity()
@Index('idx_audit_operation_run_sequence', ['runId', 'sequence'])
@Index('idx_audit_operation_action_status_created', ['action', 'status', 'createdAt'])
export class AuditOperation {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    runId!: string;

    @Column('integer')
    sequence!: number;

    @Column('text')
    action!: string;

    @Column('text')
    status!: string;

    @Column('text', { nullable: true, default: '' })
    sourcePath!: string;

    @Column('text', { nullable: true, default: '' })
    targetPath!: string;

    @Column('text', { nullable: true, default: '' })
    beforeJson!: string;

    @Column('text', { nullable: true, default: '' })
    afterJson!: string;

    @Column('text', { nullable: true, default: '' })
    reason!: string;

    @Column('text', { nullable: true, default: '' })
    decisionSource!: string;

    @Column('text', { nullable: true, default: '' })
    verificationJson!: string;

    @Column('integer', { default: 1 })
    attempts!: number;

    @Column('text', { nullable: true, default: '' })
    error!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @Column('datetime', { nullable: true })
    completedAt!: Date | null;
}

@Entity()
@Index('idx_invalid_resource_hash_active', ['resourceHash', 'expiresAt', 'releasedAt'])
@Index('idx_invalid_resource_source_type', ['source', 'resourceType'])
export class InvalidResource {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    resourceHash!: string;

    @Column('text', { nullable: true, default: '' })
    resourceType!: string;

    @Column('text', { nullable: true, default: '' })
    source!: string;

    @Column('text', { nullable: true, default: '' })
    errorCategory!: string;

    @Column('text', { nullable: true, default: '' })
    errorCode!: string;

    @Column('text', { nullable: true, default: '' })
    reason!: string;

    @Column('text', { nullable: true, default: '' })
    metadataJson!: string;

    @Column('datetime', { nullable: true })
    expiresAt!: Date | null;

    @Column('datetime', { nullable: true })
    releasedAt!: Date | null;

    @Column('text', { nullable: true, default: '' })
    releasedBy!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

@Entity()
@Index('idx_auto_series_intent_status_next', ['status', 'nextRunAt'])
@Index('idx_auto_series_intent_task', ['taskId'])
@Index('idx_auto_series_intent_pt', ['ptSubscriptionId'])
export class AutoSeriesIntent {
    @Column('text', { primary: true })
    id!: string;

    @Column('text')
    title!: string;

    @Column('text', { nullable: true, default: '' })
    year!: string;

    @Column('text', { nullable: true, default: '' })
    tmdbId!: string;

    @Column('text', { nullable: true, default: '' })
    tmdbJson!: string;

    @Column('integer')
    accountId!: number;

    @Column('text')
    targetFolderId!: string;

    @Column('text', { nullable: true, default: '' })
    targetFolder!: string;

    @Column('text', { default: 'lazy' })
    mode!: string;

    @Column('text', { nullable: true, default: '' })
    sourcePreferencesJson!: string;

    @Column('boolean', { default: false })
    agentEnabled!: boolean;

    @Column('text', { default: 'auto' })
    toolCallMode!: string;

    @Column('text', { nullable: true, default: '' })
    agentBudgetJson!: string;

    @Column('text', { nullable: true, default: '' })
    mediaPreferenceJson!: string;

    @Column('text', { nullable: true, default: '' })
    selectedSource!: string;

    @Column('text', { nullable: true, default: '' })
    selectedResourceId!: string;

    @Column('text', { nullable: true, default: '', transformer: encryptedTextTransformer })
    selectedShareLink!: string;

    @Column('text', { nullable: true, default: '' })
    selectedResourceTitle!: string;

    @Column('boolean', { default: false })
    allowHdhivePoints!: boolean;

    @Column('integer', { default: 0 })
    hdhiveMaxPoints!: number;

    @Column('boolean', { default: false })
    keepCasAfterRestore!: boolean;

    @Column('integer', { nullable: true })
    taskId!: number | null;

    @Column('integer', { nullable: true })
    ptSubscriptionId!: number | null;

    @Column('text', { nullable: true, default: '' })
    taskIdsJson!: string;

    @Column('text', { nullable: true, default: '' })
    ptSubscriptionIdsJson!: string;

    @Column('text', { nullable: true, default: '' })
    coverageJson!: string;

    @Column('text', { nullable: true, default: '' })
    metadataTemplateJson!: string;

    @Column('text', { default: 'pending' })
    status!: string;

    @Column('boolean', { default: false })
    degraded!: boolean;

    @Column('integer', { default: 0 })
    failureCount!: number;

    @Column('datetime', { nullable: true })
    lastRunAt!: Date | null;

    @Column('datetime', { nullable: true })
    nextRunAt!: Date | null;

    @Column('text', { nullable: true, default: '' })
    lastError!: string;

    @Column('text', { nullable: true, default: '' })
    lastWorkflowRunId!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}


@Entity()
export class SystemLog {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    level!: string; // info, warn, error, debug

    @Column('text')
    module!: string; // transfer, organizer, ai, tmdb, system

    @Column('text')
    message!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;
}

@Entity()
@Index(['cacheKey'], { unique: true })
export class TmdbCache {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    cacheKey!: string;

    @Column('text')
    category!: string;

    @Column('text')
    content!: string;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    expiresAt!: Date;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
@Index('idx_pt_subscription_enabled_id', ['enabled', 'id'])
export class PtSubscription {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    name!: string;

    @Column('text', { default: 'generic' })
    sourcePreset!: string;

    @Column('text')
    rssUrl!: string;

    @Column('text', { nullable: true, default: '' })
    includePattern!: string;

    @Column('text', { nullable: true, default: '' })
    excludePattern!: string;

    @Column('text', { nullable: true, default: '' })
    qualityPattern!: string;

    @Column('text', { nullable: true, default: '' })
    resolutionPattern!: string;

    @Column('text', { nullable: true, default: '' })
    effectPattern!: string;

    @Column('float', { nullable: true, default: 0 })
    sizeMinMB!: number;

    @Column('float', { nullable: true, default: 0 })
    sizeMaxMB!: number;

    @Column('integer', { nullable: true, default: 0 })
    seedersMin!: number;

    @Column('boolean', { default: false })
    freeOnly!: boolean;

    @Column('boolean', { default: false })
    episodeDedup!: boolean;

    @Column('text', { nullable: true, default: '' })
    standbyRssJson!: string;

    @Column('boolean', { default: false })
    coexist!: boolean;

    @Column('boolean', { default: false })
    downloadNew!: boolean;

    @Column('integer', { nullable: true, default: 0 })
    delayedDownloadMinutes!: number;

    @Column('text', { nullable: true, default: '' })
    notDownloadEpisodes!: string;

    @Column('boolean', { default: false })
    skipHalfEpisode!: boolean;

    @Column('boolean', { default: false })
    customEpisode!: boolean;

    @Column('text', { nullable: true, default: '' })
    customEpisodeRegex!: string;

    @Column('integer', { nullable: true, default: 1 })
    customEpisodeGroupIndex!: number;

    @Column('float', { nullable: true, default: 0 })
    episodeOffset!: number;

    @Column('boolean', { default: false })
    omit!: boolean;

    @Column('text', { nullable: true, default: '' })
    missingEpisodesJson!: string;

    @Column('integer', { nullable: true, default: 0 })
    totalEpisodeNumber!: number;

    @Column('integer', { nullable: true, default: 0 })
    currentEpisodeNumber!: number;

    @Column('boolean', { default: false })
    autoDisabled!: boolean;

    @Column('boolean', { default: true })
    globalExclude!: boolean;

    @Column('text', { nullable: true, default: 'manual' })
    filterManagedBy!: string;

    @Column('text', { nullable: true, default: '' })
    filterValidationHash!: string;

    @Column('text', { nullable: true, default: '' })
    mediaPreferenceJson!: string;

    @Column('text', { nullable: true, default: 'none' })
    upgradePolicy!: string;

    @Column('text', { nullable: true, default: '' })
    metadataTemplateJson!: string;

    @Column('text', { nullable: true, default: '' })
    autoSeriesIntentId!: string;

    @Column('integer')
    accountId!: number;

    @ManyToOne(() => Account, { nullable: true })
    @JoinColumn({ name: 'accountId' })
    account!: Account;

    @Column('text')
    targetFolderId!: string;

    @Column('text', { nullable: true, default: '' })
    targetFolder!: string;

    @Column('boolean', { default: true })
    enabled!: boolean;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastCheckTime!: Date | null;

    @Column('text', { nullable: true, default: 'unknown' })
    lastStatus!: string;

    @Column('text', { nullable: true, default: '' })
    lastMessage!: string;

    @Column('integer', { nullable: true, default: 0 })
    releaseCount!: number;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

@Entity()
@Index('idx_pt_release_sub_status_id', ['subscriptionId', 'status', 'id'])
@Index('idx_pt_release_sub_guid', ['subscriptionId', 'guid'])
@Index('idx_pt_release_sub_episode', ['subscriptionId', 'seasonNumber', 'episodeNumber'])
export class PtRelease {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('integer')
    subscriptionId!: number;

    @ManyToOne(() => PtSubscription, { nullable: true })
    @JoinColumn({ name: 'subscriptionId' })
    subscription!: PtSubscription;

    @Column('text')
    guid!: string;

    @Column('text', { nullable: true, default: '' })
    infoHash!: string;

    @Column('text')
    title!: string;

    @Column('text', { nullable: true, default: '' })
    rawTitle!: string;

    @Column('text', { nullable: true, default: '' })
    subgroup!: string;

    @Column('integer', { nullable: true })
    seasonNumber!: number | null;

    @Column('float', { nullable: true })
    episodeNumber!: number | null;

    @Column('text', { nullable: true, default: '' })
    episodeLabel!: string;

    @Column('text', { nullable: true, default: '' })
    resolution!: string;

    @Column('text', { nullable: true, default: '' })
    quality!: string;

    @Column('text', { nullable: true, default: '' })
    releaseTagsJson!: string;

    @Column('integer', { nullable: true, default: 0 })
    qualityScore!: number;

    @Column('integer', { nullable: true })
    upgradeFromReleaseId!: number | null;

    @Column('boolean', { default: true })
    activeVersion!: boolean;

    @Column('text', { nullable: true, default: '' })
    magnetUrl!: string;

    @Column('text', { nullable: true, default: '' })
    torrentUrl!: string;

    @Column('text', { nullable: true, default: '' })
    detailsUrl!: string;

    @Column('float', { nullable: true, default: 0 })
    size!: number;

    @Column('integer', { nullable: true, default: 0 })
    seeders!: number;

    @Column('integer', { nullable: true, default: 0 })
    peers!: number;

    @Column('integer', { nullable: true, default: 0 })
    grabs!: number;

    @Column('float', { nullable: true })
    downloadVolumeFactor!: number | null;

    @Column('float', { nullable: true })
    uploadVolumeFactor!: number | null;

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    publishedAt!: Date | null;

    @Column('text', { nullable: true, default: '' })
    qbTorrentHash!: string;

    @Column('text', { nullable: true, default: '' })
    downloadPath!: string;

    @Column('text', { nullable: true, default: 'pending' })
    status!: string;

    @Column('float', { nullable: true, default: 0 })
    progress!: number;

    @Column('text', { nullable: true, default: '' })
    manifestJson!: string;

    @Column('text', { nullable: true, default: '' })
    casMetadataJson!: string;

    @Column('text', { nullable: true, default: '' })
    lastError!: string;

    @Column('text', { nullable: true, default: '' })
    localRootName!: string;

    @Column('text', { nullable: true, default: '' })
    torrentFilesJson!: string;

    // 创建 release 时复制订阅模板；之后 release 的审计结果独立保存
    @Column('text', { nullable: true, default: '' })
    metadataTemplateSnapshotJson!: string;

    @Column('text', { nullable: true, default: '' })
    metadataOverrideJson!: string;

    @Column('text', { nullable: true, default: '' })
    metadataAppliedOverrideJson!: string;

    @Column('text', { nullable: true, default: '' })
    cloudFolderId!: string;

    @Column('text', { nullable: true, default: '' })
    cloudFolderName!: string;

    @Column('text', { nullable: true, default: '' })
    streamRootPath!: string;

    @CreateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    createdAt!: Date;

    @UpdateDateColumn({
        transformer: {
            from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
            to: (date: Date) => date
        }
    })
    updatedAt!: Date;
}

export default { Account, Task, TaskProcessedFile, CommonFolder, Subscription, SubscriptionResource, StrmConfig, WorkflowRun, AuditRun, AuditEvent, AuditOperation, InvalidResource, AutoSeriesIntent, SystemLog, TmdbCache, PtSubscription, PtRelease };
