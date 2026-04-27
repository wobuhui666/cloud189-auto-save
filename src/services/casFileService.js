/**
 * CAS 文件格式处理服务
 * 参考 OpenList-CAS: /internal/openlistplus/casfile/cas.go
 * 
 * .cas 文件格式：
 * - 纯 JSON 格式: {"name":"filename","size":12345,"md5":"abc...","sliceMd5":"def...","create_time":"1234567890"}
 * - Base64 编码: 上述 JSON 的 Base64 编码字符串
 */

class CasFileService {
    /**
     * 解析 CAS 文件内容
     * @param {string|Buffer} data - CAS 文件内容
     * @returns {object} { name, size, md5, sliceMd5, createTime }
     */
    static parse(data) {
        const trimmed = String(data || '').trim();
        if (!trimmed) {
            throw new Error('empty cas content');
        }

        // 尝试直接解析 JSON
        try {
            return CasFileService._parsePayload(trimmed);
        } catch (_) {
            // 不是纯 JSON，尝试 base64 解码
        }

        // 尝试 base64 解码
        try {
            const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
            if (decoded && decoded.trim().startsWith('{')) {
                return CasFileService._parsePayload(decoded.trim());
            }
        } catch (_) {
            // 解码失败，继续尝试其他方式
        }

        // 尝试逐行解析（处理多行情况）
        const lines = trimmed.split(/[\n\r]+/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            if (line.startsWith('{')) {
                try {
                    return CasFileService._parsePayload(line);
                } catch (_) {}
            }
            try {
                const decoded = Buffer.from(line, 'base64').toString('utf8').trim();
                if (decoded.startsWith('{')) {
                    return CasFileService._parsePayload(decoded);
                }
            } catch (_) {}
        }

        throw new Error('CAS文件解析失败: 无法识别格式');
    }

    /**
     * 序列化 CAS 信息为 JSON
     * @param {object} info - { name, size, md5, sliceMd5, createTime? }
     * @returns {string} JSON 字符串
     */
    static marshal(info) {
        if (!info) {
            throw new Error('nil cas info');
        }
        CasFileService._validate(info);

        const payload = {
            name: info.name,
            size: Number(info.size),
            md5: String(info.md5).toLowerCase(),
            sliceMd5: String(info.sliceMd5 || info.slice_md5).toLowerCase()
        };

        if (info.createTime) {
            payload.create_time = String(info.createTime);
        }

        return JSON.stringify(payload);
    }

    /**
     * 序列化 CAS 信息为 Base64
     * @param {object} info - { name, size, md5, sliceMd5, createTime? }
     * @returns {string} Base64 编码字符串
     */
    static marshalBase64(info) {
        const body = CasFileService.marshal(info);
        return Buffer.from(body).toString('base64');
    }

    /**
     * 创建新的 CAS 信息对象
     * @param {string} name - 文件名
     * @param {number} size - 文件大小
     * @param {string} md5 - 文件 MD5
     * @param {string} sliceMd5 - 分片 MD5
     * @returns {object} CAS 信息对象
     */
    static new(name, size, md5, sliceMd5) {
        return {
            name: String(name),
            size: Number(size),
            md5: String(md5).toLowerCase(),
            sliceMd5: String(sliceMd5).toLowerCase(),
            createTime: String(Math.floor(Date.now() / 1000))
        };
    }

    /**
     * 从文件信息生成 CAS 内容
     * @param {object} fileInfo - 文件对象 { name, size, md5, sliceMd5 }
     * @param {string} format - 'json' | 'base64'
     * @returns {string} CAS 内容
     */
    static generate(fileInfo, format = 'base64') {
        const info = CasFileService.new(
            fileInfo.name || fileInfo.fileName,
            fileInfo.size || fileInfo.fileSize,
            fileInfo.md5 || fileInfo.fileMd5,
            fileInfo.sliceMd5 || fileInfo.slice_md5
        );

        if (!info.md5 || !info.sliceMd5) {
            throw new Error('文件缺少 MD5 或 SliceMD5，无法生成秒传存根');
        }

        return format === 'base64' 
            ? CasFileService.marshalBase64(info) 
            : CasFileService.marshal(info);
    }

    /**
     * 批量解析文件 MD5 信息，用于从外部 JSON 生成多个 .cas 文件
     * @param {string|object|Array} data - JSON 数组、{files: []} 或单个文件对象
     * @returns {Array<object>} CAS 信息数组
     */
    static parseBatchSource(data) {
        let payload = data;
        if (typeof data === 'string') {
            const trimmed = data.trim();
            if (!trimmed) {
                throw new Error('批量内容为空');
            }
            payload = JSON.parse(trimmed);
        }

        const list = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.files) ? payload.files : [payload]);

        return list.map((item, index) => {
            try {
                const info = {
                    name: String(item?.name || item?.fileName || '').trim(),
                    size: Number(item?.size || item?.fileSize || 0) || 0,
                    md5: String(item?.md5 || item?.fileMd5 || '').trim().toLowerCase(),
                    sliceMd5: String(item?.sliceMd5 || item?.slice_md5 || item?.sliceMD5 || '').trim().toLowerCase()
                };
                CasFileService._validate(info);
                return info;
            } catch (error) {
                throw new Error(`第 ${index + 1} 个文件信息无效: ${error.message}`);
            }
        });
    }

    /**
     * 判断是否为 CAS 文件
     * @param {string} fileName - 文件名
     * @returns {boolean}
     */
    static isCasFile(fileName) {
        return String(fileName || '').toLowerCase().endsWith('.cas');
    }

    /**
     * 获取原始文件名（去除 .cas 后缀）
     * @param {string} casFileName - CAS 文件名
     * @param {object} casInfo - CAS 信息（可选，用于补全扩展名）
     * @returns {string} 原始文件名
     */
    static getOriginalFileName(casFileName, casInfo = null) {
        const trimmed = String(casFileName || '').replace(/\.cas$/i, '');
        if (!trimmed) {
            return casInfo?.name || casFileName;
        }

        // 如果已经有扩展名，直接返回
        const ext = require('path').extname(trimmed);
        if (ext && ext !== '.') {
            return trimmed;
        }

        // 尝试从 casInfo 补全扩展名
        if (casInfo?.name) {
            const sourceExt = require('path').extname(casInfo.name);
            if (sourceExt && sourceExt !== '.') {
                return trimmed + sourceExt;
            }
        }

        return trimmed;
    }

    /**
     * 构建预览恢复用的 CAS 文件名
     * @param {string} originalName - 原始文件名
     * @param {object} casInfo - CAS 信息
     * @param {boolean} useCurrent - 是否使用当前文件名
     * @returns {string} 预览恢复文件名
     */
    static buildPreviewRestoreName(originalName, casInfo, useCurrent = false) {
        if (useCurrent && originalName) {
            return originalName;
        }
        const base = casInfo?.name || originalName || 'unknown';
        const ext = require('path').extname(base);
        const name = require('path').basename(base, ext);
        const timestamp = Date.now().toString(36);
        return `.cas_preview_${name}_${timestamp}${ext}`;
    }

    /**
     * 构建预览恢复的 CAS 文件名（用于上传）
     * @param {string} restoredName - 恢复后的文件名
     * @returns {string} CAS 文件名
     */
    static buildPreviewRestoreCasName(restoredName) {
        return restoredName + '.cas';
    }

    /**
     * 解析 payload
     * @private
     */
    static _parsePayload(jsonStr) {
        const p = JSON.parse(jsonStr);
        const md5 = String(p.md5 || p.fileMd5 || '').trim();
        const sliceMd5 = String(p.sliceMd5 || p.slice_md5 || '').trim();

        const info = {
            name: String(p.name || p.fileName || '').trim(),
            size: Number(p.size || p.fileSize || 0) || 0,
            md5: md5.toLowerCase(),
            sliceMd5: sliceMd5.toLowerCase(),
            createTime: String(p.create_time || p.createTime || '').trim()
        };

        CasFileService._validate(info);
        return info;
    }

    /**
     * 验证 CAS 信息
     * @private
     */
    static _validate(info) {
        if (!info) {
            throw new Error('nil cas info');
        }
        if (!info.name || !String(info.name).trim()) {
            throw new Error('cas source name is empty');
        }
        if (info.size < 0) {
            throw new Error('cas size must be >= 0');
        }
        if (!CasFileService._looksLikeMD5(info.md5)) {
            throw new Error(`invalid md5: ${info.md5}`);
        }
        if (!CasFileService._looksLikeMD5(info.sliceMd5)) {
            throw new Error(`invalid slice_md5: ${info.sliceMd5}`);
        }
    }

    /**
     * 检查是否为有效的 MD5 格式
     * @private
     */
    static _looksLikeMD5(value) {
        const str = String(value || '').toLowerCase();
        if (str.length !== 32) {
            return false;
        }
        return /^[0-9a-f]{32}$/.test(str);
    }

    /**
     * 获取第一个非空值
     * @private
     */
    static _firstNonEmpty(...values) {
        for (const value of values) {
            if (String(value || '').trim()) {
                return value;
            }
        }
        return '';
    }
}

module.exports = { CasFileService };
