const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|passwd|secret|token|apikey|accesskey|sharelink|rssurl|webhook)/i;

function sanitizeWorkflowText(value = '') {
    return String(value)
        .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]')
        .replace(/((?:api[_ -]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function sanitizeWorkflowValue(value, key = '') {
    const normalizedKey = String(key).toLowerCase().replace(/[_-]/g, '');
    if (normalizedKey && SENSITIVE_KEY_PATTERN.test(normalizedKey)) return '[REDACTED]';
    if (typeof value === 'string') return sanitizeWorkflowText(value);
    if (value == null || typeof value !== 'object' || value instanceof Date) return value;
    if (Array.isArray(value)) return value.map(item => sanitizeWorkflowValue(item));
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
        childKey,
        sanitizeWorkflowValue(child, childKey)
    ]));
}

function sanitizeWorkflowRun(run = {}) {
    return {
        ...run,
        steps: sanitizeWorkflowValue(run.steps || []),
        context: sanitizeWorkflowValue(run.context || {}),
        summary: sanitizeWorkflowText(run.summary || '')
    };
}

module.exports = { sanitizeWorkflowText, sanitizeWorkflowValue, sanitizeWorkflowRun };
