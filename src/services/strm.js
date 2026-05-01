const fs = require('fs').promises;
const path = require('path');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');
const CryptoUtils = require('../utils/cryptoUtils');
const alistService = require('./alistService');
const { MessageUtil } = require('./message');
const { StreamProxyService } = require('./streamProxy');

const { CasService } = require('./casService');

class StrmService {
    constructor() {
        this.enable = ConfigService.getConfigValue('strm.enable');
        this.baseDir = path.join(__dirname + '../../../strm');
        // 从环境变量获取 PUID 和 PGID，默认值设为 0
        this.puid = process.env.PUID || 0;
        this.pgid = process.env.PGID || 0;
        this.messageUtil = new MessageUtil();
        this.streamProxyService = new StreamProxyService();
    }

    _normalizeBaseRelativePath(targetPath = '') {
        const normalizedBaseDir = path.normalize(this.baseDir);
        const normalizedTargetPath = path.normalize(String(targetPath || '').trim());
        if (!normalizedTargetPath || normalizedTargetPath === '.') {
            return '';
        }

        if (normalizedTargetPath === normalizedBaseDir) {
            return '';
        }

        const baseWithSep = normalizedBaseDir.endsWith(path.sep)
            ? normalizedBaseDir
            : `${normalizedBaseDir}${path.sep}`;
        if (normalizedTargetPath.startsWith(baseWithSep)) {
            return path.relative(normalizedBaseDir, normalizedTargetPath);
        }

        const baseName = path.basename(normalizedBaseDir);
        const marker = `${path.sep}${baseName}${path.sep}`;
        const markerIndex = normalizedTargetPath.lastIndexOf(marker);
        if (markerIndex >= 0) {
            return normalizedTargetPath.substring(markerIndex + marker.length);
        }
        if (normalizedTargetPath.endsWith(`${path.sep}${baseName}`)) {
            return '';
        }

        return normalizedTargetPath.replace(/^([/\\])+/, '');
    }

    _resolveBasePath(targetPath = '') {
        return path.join(this.baseDir, this._normalizeBaseRelativePath(targetPath));
    }

    // 确保目录存在并设置权限和组，递归创建的所有目录都设置为 777 权限
    async _ensureDirectoryExists(dirPath) {
        // 确保使用相对路径
        const relativePath = this._normalizeBaseRelativePath(dirPath);
            
        const parts = relativePath.split(path.sep);
        let currentPath = this.baseDir;  // 从基础目录开始

        for (const part of parts) {
            if (part) {
                currentPath = path.join(currentPath, part);
                try {
                    await fs.mkdir(currentPath);
                    if (process.getuid && process.getuid() === 0) {
                        await fs.chown(currentPath, parseInt(this.puid), parseInt(this.pgid));
                    }
                    await fs.chmod(currentPath, 0o777);
                } catch (error) {
                    if (error.code !== 'EEXIST') {
                        throw new Error(`创建目录失败: ${error.message}`);
                    }
                }
            }
        }
    }

    /**
     * 生成 STRM 文件
     * @param {Array} files - 文件列表，每个文件对象需包含 name 属性
     * @param {boolean} overwrite - 是否覆盖已存在的文件
     * @param {boolean} compare - 是否比较文件名 默认比较
     * @returns {Promise<Array>} - 返回生成的文件列表
     */
    async generate(task, files, overwrite = false, compare = true) {
        if (!this.enable){
            logTaskEvent(`STRM生成未启用, 请启用后执行`);
            return;
        }
        logTaskEvent(`${task.resourceName} 开始生成STRM文件, 总文件数: ${files.length}`);
        const results = [];
        let success = 0;
        let failed = 0;
        let skipped = 0;
        try {
            // mediaSuffixs转为小写
            const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase())
            let taskName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1)
            // 去掉头尾/
            taskName = taskName.replace(/^\/|\/$/g, '');
            const targetDir = this._resolveBasePath(path.join(task.account.localStrmPrefix, taskName));
            const mediaFiles = files.filter(file => this._checkFileSuffix(file, mediaSuffixs));
            const expectedStrmPaths = new Set(
                mediaFiles.map(file => this._buildRelativeStrmPath(file.relativeDir || '', file.name))
            );
            if (compare) {
                const strmFiles = await this._listStrmFilesRecursive(this._normalizeBaseRelativePath(path.join(task.account.localStrmPrefix, taskName)));
                for (const file of strmFiles) {
                    if (!expectedStrmPaths.has(file.relativePath)) {
                        await this.delete(file.path);
                    }
                }
            }
            overwrite && await this._deleteDirAllStrm(targetDir)
            await this._ensureDirectoryExists(targetDir);
            for (const file of files) {
                // 检查文件是否是媒体文件
                if (!this._checkFileSuffix(file, mediaSuffixs)) {
                    // logTaskEvent(`文件不是媒体文件，跳过: ${file.name}`);
                    skipped++
                    continue;
                }
                
                try {
                    const fileName = file.name;
                    const strmRelativePath = this._buildRelativeStrmPath(file.relativeDir || '', fileName);
                    const strmPath = path.join(targetDir, strmRelativePath);
                    await this._ensureDirectoryExists(path.dirname(strmPath));

                    // 检查文件是否存在
                    try {
                        await fs.access(strmPath);
                        if (!overwrite) {
                            // logTaskEvent(`STRM文件已存在，跳过: ${strmPath}`);
                            skipped++
                            continue;
                        }
                    } catch (err) {
                        // 文件不存在，继续处理
                    }

                    const content = this._buildTaskStrmContent(task, taskName, file);
                    await fs.writeFile(strmPath, content, 'utf8');
                    // 设置文件权限
                    if (process.getuid && process.getuid() === 0) {
                        await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                    }
                    await fs.chmod(strmPath, 0o777);
                    results.push({
                        originalFile: fileName,
                        strmFile: path.basename(strmPath),
                        path: strmPath
                    });
                    logTaskEvent(`生成STRM文件成功: ${strmPath}`);
                    success++
                } catch (error) {
                    logTaskEvent(`生成STRM文件失败: ${file.name}, 错误: ${error.message}`);
                    failed++
                }
            }
        } catch (error) {
            console.log(error)
            logTaskEvent(`生成STRM文件失败: ${error.message}`);
            failed++
        }
        // 记录文件总数, 成功数, 失败数, 跳过数
        const message = `🎉${task.resourceName} 生成STRM文件完成, 总文件数: ${files.length}, 成功数: ${success}, 失败数: ${failed}, 跳过数: ${skipped}`
        logTaskEvent(message);
        return message;
    }

    _buildTaskStrmContent(task, taskName, file) {
        const accountId = task.accountId || task.account?.id;
        if (ConfigService.getConfigValue('strm.useStreamProxy') && accountId && file?.id) {
            return this.streamProxyService.buildStreamUrl({
                type: 'task',
                accountId,
                fileId: file.id,
                fileName: file.name
            });
        }
        if (ConfigService.getConfigValue('strm.useStreamProxy') && (!accountId || !file?.id)) {
            logTaskEvent(`STRM代理模式缺少必要参数，已回退普通路径: ${file?.name || 'unknown'}`);
        }
        const relativeDir = this._normalizeRelativePath(file.relativeDir || '');
        const taskPath = relativeDir
            ? path.join(taskName, relativeDir)
            : taskName;
        return this._joinUrl(this._joinUrl(task.account.cloudStrmPrefix, taskPath), file.name);
    }

    _buildRelativeStrmPath(relativeDir, fileName) {
        const normalizedRelativeDir = this._normalizeRelativePath(relativeDir || '');
        // 对 .cas 文件，使用原始文件名（去掉 .cas 后缀）
        let effectiveFileName = fileName;
        if (CasService.isCasFile(fileName)) {
            effectiveFileName = CasService.getOriginalFileName(fileName);
        }
        const parsedPath = path.parse(effectiveFileName);
        const strmFileName = `${parsedPath.name}.strm`;
        return normalizedRelativeDir
            ? path.join(normalizedRelativeDir, strmFileName)
            : strmFileName;
    }

    async generateCustom(targetRoot, files, contentResolver, overwrite = false, compare = false, renameMode = 'default') {
        if (!this.enable) {
            logTaskEvent('STRM生成未启用, 请启用后执行');
            return;
        }
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase());
        const normalizedTargetRoot = this._normalizeBaseRelativePath(targetRoot);
        const targetDir = this._resolveBasePath(normalizedTargetRoot);
        let success = 0;
        let failed = 0;
        let skipped = 0;

        const mediaFiles = files.filter(file => this._checkFileSuffix(file, mediaSuffixs));
        const expectedStrmPaths = new Set(
            mediaFiles.map(file => {
                if (renameMode === 'organized' && file.organizedFileName) {
                    return file.organizedFileName;
                }
                return this._buildRelativeStrmPath(file.relativeDir || '', file.name);
            })
        );

        if (compare) {
            // 收窄 compare 范围: 仅在本次 files 实际涉及的子目录内做清理,
            // 避免同 targetRoot 下的兄弟目录(例如多季任务 Season 01 / Season 02)被误删
            const coveredDirs = new Set(
                mediaFiles.map(file => this._normalizeRelativePath(file.relativeDir || ''))
            );
            const strmFiles = await this._listStrmFilesRecursive(normalizedTargetRoot);
            for (const file of strmFiles) {
                const dirName = path.dirname(file.relativePath);
                const normalizedDir = dirName === '.' ? '' : this._normalizeRelativePath(dirName);
                if (!coveredDirs.has(normalizedDir)) {
                    continue;
                }
                if (!expectedStrmPaths.has(file.relativePath)) {
                    await this.delete(file.path);
                }
            }
        }

        overwrite && await this._deleteDirAllStrm(targetDir);
        await this._ensureDirectoryExists(targetDir);

        for (const file of files) {
            if (!this._checkFileSuffix(file, mediaSuffixs)) {
                skipped++;
                continue;
            }
            try {
                // 根据重命名模式决定文件名
                let strmFileName;
                if (renameMode === 'organized' && file.organizedFileName) {
                    strmFileName = file.organizedFileName;
                } else {
                    strmFileName = this._buildRelativeStrmPath(file.relativeDir || '', file.name);
                }

                const strmPath = path.join(targetDir, strmFileName);
                await this._ensureDirectoryExists(path.dirname(strmPath));
                try {
                    await fs.access(strmPath);
                    if (!overwrite) {
                        skipped++;
                        continue;
                    }
                } catch (error) {
                }

                const content = await contentResolver(file);
                await fs.writeFile(strmPath, content, 'utf8');
                if (process.getuid && process.getuid() === 0) {
                    await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                }
                await fs.chmod(strmPath, 0o777);
                success++;
                logTaskEvent(`生成STRM文件成功: ${strmPath}`);
            } catch (error) {
                failed++;
                logTaskEvent(`生成STRM文件失败: ${file.name}, 错误: ${error.message}`);
            }
        }

        const message = `🎉自定义STRM生成完成, 总文件数: ${files.length}, 成功数: ${success}, 失败数: ${failed}, 跳过数: ${skipped}`;
        logTaskEvent(message);
        return message;
    }

    async generateSelectedDirectories(account, directories, options = {}) {
        if (!alistService.Enable()) {
            throw new Error('Alist功能未启用');
        }
        if (!account?.cloudStrmPrefix) {
            throw new Error('账号未配置媒体目录');
        }
        const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase());
        const excludeRegex = this._buildRegex(options.excludePattern);
        const baseStartPath = account.cloudStrmPrefix.includes('/d/')
            ? account.cloudStrmPrefix.split('/d/')[1]
            : path.basename(account.cloudStrmPrefix);
        const stats = {
            success: 0,
            failed: 0,
            skipped: 0,
            totalFiles: 0,
            processedDirs: new Set()
        };

        for (const directory of directories) {
            const relativeSourcePath = this._normalizeRelativePath(directory.path || directory.name);
            if (!relativeSourcePath) {
                continue;
            }
            const sourcePath = this._normalizeRelativePath(path.join(baseStartPath, relativeSourcePath));
            const targetRoot = this._normalizeRelativePath(path.join(options.localPathPrefix || account.localStrmPrefix || '', relativeSourcePath));
            if (options.overwriteExisting) {
                await this.deleteDir(targetRoot);
            }
            await this._processConfiguredDirectory(
                sourcePath,
                account,
                targetRoot,
                relativeSourcePath,
                stats,
                mediaSuffixs,
                !!options.overwriteExisting,
                excludeRegex
            );
        }

        const username = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
        const message = `🎉账号: ${username} 指定目录STRM生成完成\n` +
            `处理目录数: ${stats.processedDirs.size}\n` +
            `总文件数: ${stats.totalFiles}\n` +
            `成功数: ${stats.success}\n` +
            `失败数: ${stats.failed}\n` +
            `跳过数: ${stats.skipped}`;
        logTaskEvent(message);
        return message;
    }

    /**
     * 批量生成STRM文件 根据Alist目录
     * @param {string} startPath - 起始目录路径
     * @returns {Promise<object>} - 返回处理结果统计
     */
    async generateAll(accounts, overwrite = false) {
        if (!alistService.Enable()) {
            throw new Error('Alist功能未启用');
        }
        const messages = [];
        for(const account of accounts) {
            try {
                let startPath = account.cloudStrmPrefix.includes('/d/') 
                ? account.cloudStrmPrefix.split('/d/')[1] 
                : path.basename(account.cloudStrmPrefix);
                // 初始化统计信息
                const stats = {
                    success: 0,
                    failed: 0,
                    skipped: 0,
                    totalFiles: 0,
                    processedDirs: new Set()
                };
                // 获取媒体文件后缀列表
                const mediaSuffixs = ConfigService.getConfigValue('task.mediaSuffix').split(';').map(suffix => suffix.toLowerCase());
                 // 如果覆盖 则直接删除currentPath
                if (overwrite) {
                    this.deleteDir(path.join(account.localStrmPrefix, startPath), true)
                }
                await this._processDirectory(startPath, account, stats, mediaSuffixs, overwrite);
                const userrname = account.username.replace(/(.{3}).*(.{4})/, '$1****$2');
                // 生成最终统计信息
                const message = `🎉账号: ${userrname}生成STRM文件完成\n` +
                              `处理目录数: ${stats.processedDirs.size}\n` +
                              `总文件数: ${stats.totalFiles}\n` +
                              `成功数: ${stats.success}\n` +
                              `失败数: ${stats.failed}\n` +
                              `跳过数: ${stats.skipped}`;
                logTaskEvent(message);
                messages.push(message);
            } catch (error) {
                const message = `生成STRM文件失败: ${error.message}`;
                logTaskEvent(message);
            }
        }
        if (messages.length > 0) {
            this.messageUtil.sendMessage(messages.join('\n\n'), { level: 'success' });
        }   
    }

    /**
     * 处理单个目录
     * @param {string} dirPath - 目录路径
     * @param {object} stats - 统计信息
     * @param {array} mediaSuffixs - 媒体文件后缀列表
     * @private
     */
    async _processDirectory(dirPath, account, stats, mediaSuffixs, overwrite) {
        // 获取alist文件列表
        const alistResponse = await alistService.listFiles(dirPath);
        if (!alistResponse || !alistResponse.data) {
            throw new Error(`获取Alist文件列表失败: ${dirPath}`);
        }
        if (!alistResponse.data.content) {
            return;
        }

        const files = alistResponse.data.content;
        logTaskEvent(`开始处理目录 ${dirPath}, 文件数量: ${files.length}`);

        for (const file of files) {
            try {
                if (file.is_dir) {
                    // 递归处理子目录
                    await this._processDirectory(path.join(dirPath, file.name), account, stats, mediaSuffixs, overwrite);
                } else {
                    stats.totalFiles++;
                    // 检查是否为媒体文件
                    if (!this._checkFileSuffix(file, mediaSuffixs)) {
                        // console.log(`文件不是媒体文件，跳过: ${file.name}`);
                        stats.skipped++;
                        continue;
                    }

                    // 构建STRM文件路径
                    const relativePath = dirPath.substring(dirPath.indexOf('/') + 1).replace(/^\/+|\/+$/g, '')
                    const targetDir = path.join(this.baseDir, account.localStrmPrefix, relativePath);
                    const parsedPath = path.parse(file.name);
                    const strmPath = path.join(targetDir, `${parsedPath.name}.strm`);
                    // overwrite && await this._deleteDirAllStrm(targetDir)
                    // 检查文件是否存在
                    try {
                        await fs.access(strmPath);
                        if (!overwrite) {
                            // console.log(`STRM文件已存在，跳过: ${strmPath}`);
                            stats.skipped++
                            continue;
                        }
                    } catch (err) {
                        // 文件不存在，继续处理
                    }

                    await this._ensureDirectoryExists(targetDir);

                    // 生成STRM文件内容
                    const content = this._joinUrl(account.cloudStrmPrefix, path.join(relativePath.replace(/^\/+|\/+$/g, ''), file.name));
                    // 写入STRM文件
                    await fs.writeFile(strmPath, content, 'utf8');
                    if (process.getuid && process.getuid() === 0) {
                        await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                    }
                    await fs.chmod(strmPath, 0o777);

                    stats.success++;
                    logTaskEvent(`生成STRM文件成功: ${strmPath}`);
                }
            } catch (error) {
                stats.failed++;
                logTaskEvent(`处理文件失败: ${file.name}, 错误: ${error.message}`);
            }
        }
    }

    async _processConfiguredDirectory(sourcePath, account, targetRelativeRoot, relativeContentRoot, stats, mediaSuffixs, overwrite, excludeRegex) {
        const alistResponse = await alistService.listFiles(sourcePath);
        if (!alistResponse || !alistResponse.data) {
            throw new Error(`获取Alist文件列表失败: ${sourcePath}`);
        }
        if (!alistResponse.data.content) {
            return;
        }

        const files = alistResponse.data.content;
        stats.processedDirs.add(sourcePath);
        logTaskEvent(`开始处理指定目录 ${sourcePath}, 文件数量: ${files.length}`);

        for (const file of files) {
            try {
                if (excludeRegex && excludeRegex.test(file.name)) {
                    stats.skipped++;
                    continue;
                }
                if (file.is_dir) {
                    const nextSourcePath = this._normalizeRelativePath(path.join(sourcePath, file.name));
                    const nextTargetRoot = this._normalizeRelativePath(path.join(targetRelativeRoot, file.name));
                    const nextContentRoot = this._normalizeRelativePath(path.join(relativeContentRoot, file.name));
                    await this._processConfiguredDirectory(
                        nextSourcePath,
                        account,
                        nextTargetRoot,
                        nextContentRoot,
                        stats,
                        mediaSuffixs,
                        overwrite,
                        excludeRegex
                    );
                    continue;
                }

                stats.totalFiles++;
                if (!this._checkFileSuffix(file, mediaSuffixs)) {
                    stats.skipped++;
                    continue;
                }

                const targetDir = path.join(this.baseDir, targetRelativeRoot);
                const parsedPath = path.parse(file.name);
                const strmPath = path.join(targetDir, `${parsedPath.name}.strm`);
                try {
                    await fs.access(strmPath);
                    if (!overwrite) {
                        stats.skipped++;
                        continue;
                    }
                } catch (error) {
                }

                await this._ensureDirectoryExists(targetDir);
                const content = this._joinUrl(account.cloudStrmPrefix, path.join(relativeContentRoot, file.name));
                await fs.writeFile(strmPath, content, 'utf8');
                if (process.getuid && process.getuid() === 0) {
                    await fs.chown(strmPath, parseInt(this.puid), parseInt(this.pgid));
                }
                await fs.chmod(strmPath, 0o777);
                stats.success++;
                logTaskEvent(`生成STRM文件成功: ${strmPath}`);
            } catch (error) {
                stats.failed++;
                logTaskEvent(`处理文件失败: ${file.name}, 错误: ${error.message}`);
            }
        }
    }

    async listStrmFiles(dirPath = '') {
        try {
            const targetPath = this._resolveBasePath(dirPath);
            const results = [];
            
            // 检查目录是否存在
            try {
                await fs.access(targetPath);
            } catch (err) {
                return results;
            }
            // 读取目录内容
            const items = await fs.readdir(targetPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(targetPath, item.name);
                const relativePath = path.relative(this.baseDir, fullPath);
                if (item.isDirectory() && !item.name.startsWith('.')) {
                    results.push({
                        id: relativePath,
                        name: item.name,
                        path: relativePath,
                        type: 'directory'
                    });
                }
                if (item.isFile() && !item.name.startsWith('.') && path.extname(item.name) === '.strm') {
                    results.push({
                        id: relativePath,
                        name: item.name,
                        path: relativePath,
                        type: 'file'
                    });
                }
            }

            results.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'directory' ? -1 : 1;
                }
                return a.name.localeCompare(b.name, 'zh-CN');
            });

            return results;
        } catch (error) {
            throw new Error(`列出STRM文件失败: ${error.message}`);
        }
    }

    async _listStrmFilesRecursive(dirPath = '', baseDirPath = dirPath) {
        const normalizedDirPath = this._normalizeBaseRelativePath(dirPath);
        const normalizedBaseDirPath = this._normalizeBaseRelativePath(baseDirPath);
        const targetPath = this._resolveBasePath(normalizedDirPath);
        const results = [];
        try {
            await fs.access(targetPath);
        } catch (error) {
            return results;
        }

        const items = await fs.readdir(targetPath, { withFileTypes: true });
        for (const item of items) {
            const relativePath = path.join(normalizedDirPath, item.name);
            if (item.isDirectory()) {
                const childItems = await this._listStrmFilesRecursive(relativePath, normalizedBaseDirPath);
                results.push(...childItems);
                continue;
            }
            if (item.isFile() && path.extname(item.name) === '.strm') {
                results.push({
                    name: item.name,
                    path: relativePath,
                    relativePath: path.relative(normalizedBaseDirPath, relativePath)
                });
            }
        }
        return results;
    }

    /**
     * 删除STRM文件
     * @param {string} fileName - 原始文件名
     * @returns {Promise<void>}
     */
    async delete(fileName) {
        const parsedPath = path.parse(fileName);
        const dirPath = this._normalizeBaseRelativePath(parsedPath.dir);
        const fileNameWithoutExt = parsedPath.name;
        const targetDir = this._resolveBasePath(dirPath);
        const strmPath = path.join(targetDir, `${fileNameWithoutExt}.strm`);
        const nfoPath = path.join(targetDir, `${fileNameWithoutExt}.nfo`);
        const thumbPath = path.join(targetDir, `${fileNameWithoutExt}-thumb.jpg`);
        try {
           // 删除 .strm 文件
           try {
                await fs.access(strmPath);
                await fs.unlink(strmPath);
                logTaskEvent(`删除STRM文件成功: ${strmPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除STRM文件失败: ${strmPath}, 错误: ${err.message}`);
                }
            }

            // 删除 .nfo 文件
            try {
                await fs.access(nfoPath);
                await fs.unlink(nfoPath);
                logTaskEvent(`删除NFO文件成功: ${nfoPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除NFO文件失败: ${nfoPath}, 错误: ${err.message}`);
                }
            }

            // 删除 -thumb.jpg 图片
            try {
                await fs.access(thumbPath);
                await fs.unlink(thumbPath);
                logTaskEvent(`删除Thumb图片成功: ${thumbPath}`);
            } catch (err) {
                if (err.code !== 'ENOENT') { // 如果不是文件不存在错误，则记录
                    logTaskEvent(`尝试删除Thumb图片失败: ${thumbPath}, 错误: ${err.message}`);
                }
            }
            
            // 尝试删除空目录
            const files = await fs.readdir(targetDir);
            if (files.length === 0) {
                await fs.rmdir(targetDir);
                logTaskEvent(`删除空目录: ${targetDir}`);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`删除STRM文件失败: ${error.message}`);
            }
        }
    }
    // 删除目录
    async deleteDir(dirPath) {
        try {
            const targetDir = this._resolveBasePath(dirPath);
             // 检查目录是否存在
             try {
                await fs.access(targetDir);
            } catch (err) {
                // 目录不存在，直接返回
                // logTaskEvent(`STRM目录不存在，跳过删除: ${targetDir}`);
                return;
            }
            await fs.rm(targetDir, { recursive: true });
            logTaskEvent(`删除STRM目录成功: ${targetDir}`);

            // 检查并删除空的父目录
            const parentDir = path.dirname(targetDir);
            try {
                const files = await fs.readdir(parentDir);
                if (files.length === 0) {
                    await fs.rm(parentDir, { recursive: true });
                    logTaskEvent(`删除空目录: ${parentDir}`);
                }
            } catch (err) {
                
            }
        } catch (error) {
            logTaskEvent(`删除STRM目录失败: ${error.message}`);
        }
    }
    // 删除目录下的所有.strm文件
    async  _deleteDirAllStrm(dirPath) {
        // 检查目录是否存在
        try {
            await fs.access(dirPath);
        } catch (err) {
            // 目录不存在，直接返回
            logTaskEvent(`STRM目录不存在，跳过删除: ${dirPath}`);
            return;
        }
        const files = await fs.readdir(dirPath, { withFileTypes: true });
        await Promise.all(files.map(async file => {
            const filePath = path.join(dirPath, file.name);
            if (file.isDirectory()) {
                await this._deleteDirAllStrm(filePath);
                return;
            }
            if (path.extname(filePath) === '.strm') {
                try {
                    await fs.unlink(filePath);
                    logTaskEvent(`删除文件成功: ${filePath}`);
                } catch (err) {
                    logTaskEvent(`删除文件失败: ${err.message}`);
                }
            }
        }));
    }
    //检查文件是否是媒体文件（.cas 文件也视为媒体文件）
    _checkFileSuffix(file, mediaSuffixs) {
         // 获取文件后缀
         const fileExt = '.' + file.name.split('.').pop().toLowerCase();
         if (CasService.isCasFile(file.name)) return true;
         return mediaSuffixs.includes(fileExt)
    }

    _joinUrl(base, path) {
        // 移除 base 末尾的斜杠（如果有）
        base = base.replace(/\/$/, '');
        // 移除 path 开头的斜杠（如果有）
        path = path.replace(/\\/g, '/').replace(/^\//, '');
        return `${base}/${path}`;
    }

    _buildRegex(pattern) {
        if (!pattern) {
            return null;
        }
        try {
            return new RegExp(pattern, 'i');
        } catch (error) {
            logTaskEvent(`STRM排除规则无效，已忽略: ${pattern}`);
            return null;
        }
    }

    _normalizeRelativePath(targetPath = '') {
        return targetPath
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '')
            .replace(/\/{2,}/g, '/');
    }

    // 根据文件名获取STRM文件路径
    getStrmPath(task) {
        let taskName = task.realFolderName.substring(task.realFolderName.indexOf('/') + 1);
        if (!this.enable){
            // 如果cloudStrmPrefix存在 且不是url地址
            if (task.account.cloudStrmPrefix && !task.account.cloudStrmPrefix.startsWith('http')) {
                return path.join(task.account.cloudStrmPrefix, taskName);
            }
        }else{
            return path.join(this.baseDir, task.account.localStrmPrefix, taskName);
        }
        return '';
    }
}

module.exports = { StrmService };
