const path = require('path');
const { safeFileName } = require('./ptUtils');
const ConfigService = require('./ConfigService');

// 默认集数提取正则（参考 ani-rss）
const DEFAULT_EPISODE_REGEX = '(第\\d+[话話集]|EP?\\d+(\\.5)?| - \\d+(\\.5)?|\\[\\d+(\\.5)?\\]|【\\d+(\\.5)?】)';

// 默认季度提取正则
const DEFAULT_SEASON_REGEX = '(S(\\d{1,2})|第([一二三四五六七八九十]+|[0-9]+)季|Season\\s*(\\d{1,2}))';

class PtRenameService {
    /**
     * 中文数字转阿拉伯数字
     * @param {string} cnNum - 中文数字
     * @returns {number} 阿拉伯数字
     */
    _cnToNumber(cnNum) {
        const cnMap = {
            '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
            '六': 6, '七': 7, '八': 8, '九': 9, '十': 10
        };

        if (cnMap[cnNum]) return cnMap[cnNum];

        // 处理"十X"格式
        if (cnNum.startsWith('十')) {
            const rest = cnNum.slice(1);
            return 10 + (cnMap[rest] || 0);
        }

        return 0;
    }

    /**
     * 从 release 标题提取季度
     * @param {string} title - release 标题
     * @param {string} customRegex - 自定义正则（可选）
     * @param {number} defaultSeason - 默认季度
     * @returns {number} 季度号
     */
    extractSeason(title, customRegex = '', defaultSeason = 1) {
        if (!title) return defaultSeason;

        try {
            const regexStr = customRegex || DEFAULT_SEASON_REGEX;
            const regex = new RegExp(regexStr, 'i');
            const match = title.match(regex);

            if (!match) return defaultSeason;

            // 从匹配组中提取数字
            for (let i = 1; i < match.length; i++) {
                if (match[i]) {
                    // 尝试解析阿拉伯数字
                    const num = parseInt(match[i], 10);
                    if (!isNaN(num) && num > 0) return num;

                    // 尝试解析中文数字
                    const cnNum = this._cnToNumber(match[i]);
                    if (cnNum > 0) return cnNum;
                }
            }
            return defaultSeason;
        } catch {
            return defaultSeason;
        }
    }

    /**
     * 从 release 标题提取集数
     * @param {string} title - release 标题
     * @param {string} customRegex - 自定义正则（可选）
     * @returns {{ episode: number, episodeStr: string } | null} 集数信息
     */
    extractEpisode(title, customRegex = '') {
        if (!title) return null;

        try {
            const regexStr = customRegex || DEFAULT_EPISODE_REGEX;
            const regex = new RegExp(regexStr, 'i');
            const match = title.match(regex);

            if (!match) return null;

            // 从匹配的文本中提取数字
            const matchedText = match[0];
            const numMatch = matchedText.match(/(\d+)(\.5)?/);
            if (!numMatch) return null;

            const episode = parseInt(numMatch[1], 10);
            const hasHalf = numMatch[2] === '.5';
            const episodeStr = hasHalf ? `${episode}.5` : String(episode).padStart(2, '0');

            return { episode, episodeStr };
        } catch {
            return null;
        }
    }

    /**
     * 从标题中提取分辨率
     * @param {string} title - 标题
     * @returns {string} 分辨率
     */
    extractResolution(title) {
        if (!title) return '';

        const match = title.match(/(720[pP]|1080[pP]|2160[pP]|4[kK])/i);
        if (match) {
            return match[1].toLowerCase().replace('p', 'p');
        }

        // 尝试从分辨率格式提取
        const resMatch = title.match(/(1920x1080|3840x2160|1280x720)/i);
        if (resMatch) {
            const map = {
                '1920x1080': '1080p',
                '3840x2160': '2160p',
                '1280x720': '720p'
            };
            return map[resMatch[1].toLowerCase()] || '';
        }

        return '';
    }

    /**
     * 从标题中提取字幕组名
     * @param {string} title - 标题
     * @returns {string} 字幕组名
     */
    extractSubgroup(title) {
        if (!title) return '';

        // 匹配 [字幕组名] 格式
        const match = title.match(/^\[([^\]]+)\]/);
        if (match) {
            const name = match[1].trim();
            // 过滤掉纯数字、编码格式等非字幕组标签
            if (!/^\d+$/.test(name) && !/^(HEVC|AVC|AAC|FLAC|WebRip|BDRip|MKV|MP4|1080p|720p|2160p|4K)$/i.test(name)) {
                return name;
            }
        }
        return '';
    }

    /**
     * 清理标题（移除字幕组标签、编码信息等）
     * @param {string} title - 原始标题
     * @returns {string} 清理后的标题
     */
    cleanTitle(title) {
        if (!title) return '';

        let cleaned = title;
        // 移除开头的 [字幕组] 标签
        cleaned = cleaned.replace(/^\[[^\]]+\]\s*/, '');
        // 移除常见的编码/质量标签
        cleaned = cleaned.replace(/\[(HEVC|AVC|AAC|FLAC|WebRip|BDRip|MKV|MP4|10bit|Hi10p)\]/gi, '');
        // 移除分辨率标签
        cleaned = cleaned.replace(/\[?(720[pP]|1080[pP]|2160[pP]|4[kK])\]?/gi, '');
        // 移除结尾的 8 位 Hash
        cleaned = cleaned.replace(/\[([A-Z]|\d){8}\]$/, '');
        // 清理多余空格
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }

    /**
     * 应用模板生成文件名
     * @param {string} template - 模板字符串
     * @param {object} variables - 变量对象
     * @returns {string} 生成的文件名
     */
    applyTemplate(template, variables) {
        if (!template) return '';

        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
        }

        return safeFileName(result, '');
    }

    /**
     * 用 AI 解析结果整理 STRM 文件路径（复用自动追剧的配置）
     * - 分类目录：optionalCategoryName（如 ptService 用 TMDB 算出来的）；缺省时按 type 取 organizer.categories.{tv|movie}
     * - 文件名模板：openai.rename.{template|movieTemplate}
     * - 目录结构：{categoryName}/{title} ({year})/Season XX
     *
     * @param {object} subscription - 订阅对象
     * @param {object} release - release 对象
     * @param {object} file - 文件信息 { name, relativeDir, originalFileName, id }
     * @param {object} _config - PT 自身的 strmOrganize 配置（AI 模式下不再使用，保留参数仅为兼容）
     * @param {object} aiBase - AI 解析的基础信息 { name, year, type, season }
     * @param {object|null} aiEpisode - AI 解析的剧集信息 { id, season, episode, extension, name }
     * @param {string|null} optionalCategoryName - 外部传入的分类名（如 TMDB 决定的）
     * @returns {{ dirName: string, fileName: string }} 整理后的目录名和文件名
     */
    organizePathByAi(subscription, release, file, _config, aiBase, aiEpisode, optionalCategoryName = null) {
        const isMovie = (aiBase && aiBase.type) === 'movie';

        // 分类目录：优先用外部（TMDB）算好的；否则按 type 走默认
        const categoryName = optionalCategoryName || (isMovie
            ? ConfigService.getConfigValue('organizer.categories.movie', '电影')
            : ConfigService.getConfigValue('organizer.categories.tv', '电视剧'));

        // 文件名模板：与自动追剧 _processRename 一致
        const template = isMovie
            ? (ConfigService.getConfigValue('openai.rename.movieTemplate') || '{name} ({year}){ext}')
            : (ConfigService.getConfigValue('openai.rename.template') || '{name} - {se}{ext}');

        // 标题与年份
        const title = (aiBase && aiBase.name) || subscription.name || '未知';
        const year = (aiBase && Number(aiBase.year) > 0) ? Number(aiBase.year) : '';
        const resourceFolderName = year ? `${title} (${year})` : title;

        // 季数
        let seasonRaw = (aiBase && aiBase.season) || (aiEpisode && aiEpisode.season) || '01';
        let seasonNum = parseInt(String(seasonRaw), 10);
        if (!seasonNum || isNaN(seasonNum)) seasonNum = 1;
        const seasonStr = String(seasonNum).padStart(2, '0');

        // 集数
        let episodeStr = '';
        let episodeNum = 0;
        if (aiEpisode && aiEpisode.episode != null) {
            const n = parseInt(String(aiEpisode.episode), 10);
            if (!isNaN(n)) {
                episodeNum = n;
                episodeStr = n < 100 ? String(n).padStart(2, '0') : String(n);
            }
        }

        // 原始扩展（先用 AI 给的 extension，再回退到原文件名）
        const originalName = file.originalFileName || file.name || '';
        const originalExt = path.extname(originalName);
        const ext = (aiEpisode && aiEpisode.extension) || originalExt || '';

        // 占位符替换（与 task._generateFileName 一致）
        const replaceMap = {
            '{name}': title,
            '{year}': year ? String(year) : '',
            '{s}': seasonStr,
            '{e}': episodeStr || '01',
            '{sn}': seasonNum || 1,
            '{en}': episodeNum || 1,
            '{ext}': ext,
            '{se}': `S${seasonStr}E${episodeStr || '01'}`
        };

        let baseName = template;
        for (const [key, value] of Object.entries(replaceMap)) {
            const escaped = key.replace(/[{}]/g, c => '\\' + c);
            baseName = baseName.replace(new RegExp(escaped, 'g'), String(value));
        }
        // 模板里的 {ext} 已经把原始扩展拼上了，去掉以便统一换成 .strm
        if (ext && baseName.endsWith(ext)) {
            baseName = baseName.slice(0, -ext.length);
        }
        baseName = baseName.trim().replace(/\s+/g, ' ');

        // movie 模板没有 {se}，但 baseName 此时已经是 "{name} ({year})" 形式；
        // tv 在缺集数时退回原文件名，避免出现 SXXE01 占位
        if (!isMovie && !episodeStr) {
            baseName = path.basename(originalName, originalExt);
        }
        if (!baseName) {
            baseName = path.basename(originalName, originalExt) || resourceFolderName;
        }

        const fileName = `${safeFileName(baseName, '')}.strm`;

        // 目录：categoryName/{title} ({year})/Season XX，电影不带 Season
        let dirName;
        if (isMovie) {
            dirName = `${safeFileName(categoryName, '')}/${safeFileName(resourceFolderName, '')}`;
        } else {
            dirName = `${safeFileName(categoryName, '')}/${safeFileName(resourceFolderName, '')}/Season ${seasonStr}`;
        }

        return { dirName, fileName };
    }

    /**
     * 整理 STRM 文件路径
     * @param {object} subscription - 订阅对象
     * @param {object} release - release 对象
     * @param {object} file - 文件信息 { name, relativeDir, originalFileName }
     * @param {object} config - 整理配置
     * @returns {{ dirName: string, fileName: string }} 整理后的目录名和文件名
     */
    organizePath(subscription, release, file, config) {
        const {
            categoryFolder = '动漫',
            fileTemplate = '{title} S{season}E{episode}',
            seasonRegex = '',
            episodeRegex = '',
            defaultSeason = 1
        } = config || {};

        const title = subscription.name || '未知';
        const releaseTitle = release.title || file.originalFileName || file.name || '';

        // 提取季度和集数
        const season = this.extractSeason(releaseTitle, seasonRegex, defaultSeason);
        const episodeInfo = this.extractEpisode(releaseTitle, episodeRegex);

        // 提取其他信息
        const resolution = this.extractResolution(releaseTitle);
        const subgroup = this.extractSubgroup(releaseTitle);

        // 获取原始文件扩展名
        const originalName = file.originalFileName || file.name || '';
        const ext = path.extname(originalName);

        // 构建变量
        const variables = {
            title: safeFileName(title, ''),
            season: String(season).padStart(2, '0'),
            episode: episodeInfo ? episodeInfo.episodeStr : '00',
            subgroup: subgroup || '未知',
            resolution: resolution || 'unknown',
            original: originalName
        };

        // 生成文件名
        let fileName = this.applyTemplate(fileTemplate, variables);

        // 如果没有提取到集数，使用原始文件名
        if (!episodeInfo) {
            fileName = safeFileName(path.basename(originalName, ext), '');
        }

        // 添加扩展名（.strm）
        fileName = `${fileName}.strm`;

        // 构建目录名
        const dirName = `${safeFileName(categoryFolder, '')}/${safeFileName(title, '')}/Season ${String(season).padStart(2, '0')}`;

        return { dirName, fileName };
    }
}

const ptRenameService = new PtRenameService();
module.exports = { PtRenameService, ptRenameService };
