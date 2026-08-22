const BIG_INTEGER_ID_FIELDS = new Set([
    'id',
    'fileId',
    'shareId',
    'taskId',
    'targetFolderId',
    'parentId',
    'pId',
    'shareDirFileId'
]);

const BIG_INTEGER_ID_PATTERN = /"([A-Za-z][A-Za-z0-9_]*)"\s*:\s*(-?\d{16,})(?=\s*[,}])/g;

/**
 * 解析天翼云盘 JSON，并在 JSON.parse 前把超出安全整数范围的 ID 转为字符串。
 * 只处理明确的标识符字段，避免把容量、文件大小等普通数值误转为字符串。
 */
function parseCloud189Json(text) {
    if (typeof text !== 'string') {
        throw new TypeError('JSON 响应必须是字符串');
    }

    const protectedText = text.replace(BIG_INTEGER_ID_PATTERN, (match, field, value) => {
        return BIG_INTEGER_ID_FIELDS.has(field) ? `"${field}":"${value}"` : match;
    });
    return JSON.parse(protectedText);
}

module.exports = {
    BIG_INTEGER_ID_FIELDS,
    parseCloud189Json
};
