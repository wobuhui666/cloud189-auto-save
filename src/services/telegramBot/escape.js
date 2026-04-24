/**
 * HTML 转义与格式化工具
 * Telegram parse_mode:'HTML' 仅需转义 & < > 三个字符
 */

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function bold(str) {
    return `<b>${escapeHtml(str)}</b>`;
}

function italic(str) {
    return `<i>${escapeHtml(str)}</i>`;
}

function code(str) {
    return `<code>${escapeHtml(str)}</code>`;
}

function pre(str) {
    return `<pre>${escapeHtml(str)}</pre>`;
}

function link(text, url) {
    return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

module.exports = {
    escapeHtml,
    bold,
    italic,
    code,
    pre,
    link,
};
