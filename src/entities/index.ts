import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';

@Entity()
export class Account {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('text')
    username!: string;

    @Column('text', { nullable: true})
    password!: string;

    @Column('text', { nullable: true})
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

    // 默认账号
    @Column('boolean', { nullable: true, default: false })
    isDefault!: boolean;
}

@Entity()
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
    
    @Column({ nullable: true })
    enableTaskScraper!: boolean; // 是否启用刮削

    @Column('boolean', { nullable: true, default: false })
    enableLazyStrm!: boolean; // 是否启用懒转存STRM

    @Column('boolean', { nullable: true, default: false })
    enableOrganizer!: boolean; // 是否启用整理器

    @Column('datetime', { nullable: true, transformer: {
        from: (date: Date) => date && new Date(date.getTime() + (8 * 60 * 60 * 1000)),
        to: (date: Date) => date
    } })
    lastOrganizedAt!: Date;

    @Column('text', { nullable: true })
    lastOrganizeError!: string;

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

export default { Account, Task, TaskProcessedFile, CommonFolder, Subscription, SubscriptionResource, StrmConfig, WorkflowRun, TmdbCache };
