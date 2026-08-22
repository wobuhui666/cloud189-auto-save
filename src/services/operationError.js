const ERROR_CATEGORIES = Object.freeze({
    TRANSIENT: 'transient',
    RATE_LIMIT: 'rate_limit',
    AUTH: 'auth',
    RESOURCE_AUDIT: 'resource_audit',
    RESOURCE_INVALID: 'resource_invalid',
    PERMISSION: 'permission',
    PARAMETER: 'parameter',
    IDEMPOTENCY_CONFLICT: 'idempotency_conflict',
    UNKNOWN: 'unknown'
});

const DISPOSITIONS = Object.freeze({
    NONE: 'none',
    TEMPORARY: 'temporary',
    PERMANENT: 'permanent'
});

class OperationError extends Error {
    constructor(message, options = {}) {
        super(String(message || '操作失败'));
        this.name = 'OperationError';
        this.category = options.category || ERROR_CATEGORIES.UNKNOWN;
        this.code = String(options.code || 'UNKNOWN');
        this.source = String(options.source || 'system');
        this.operation = String(options.operation || 'unknown');
        this.retryable = Boolean(options.retryable);
        this.retryAfterMs = Number(options.retryAfterMs || 0) || null;
        this.resourceDisposition = options.resourceDisposition || DISPOSITIONS.NONE;
        this.resourceTtlMs = options.resourceTtlMs == null ? null : Number(options.resourceTtlMs);
        this.cause = options.cause;
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            category: this.category,
            code: this.code,
            source: this.source,
            operation: this.operation,
            retryable: this.retryable,
            retryAfterMs: this.retryAfterMs,
            resourceDisposition: this.resourceDisposition,
            resourceTtlMs: this.resourceTtlMs
        };
    }
}

function createNoCoverageError(message = '暂无可用覆盖资源', options = {}) {
    return new OperationError(message, {
        category: ERROR_CATEGORIES.RESOURCE_INVALID,
        code: 'NO_COVERAGE',
        source: options.source || 'auto_series',
        operation: options.operation || 'search',
        retryable: false,
        resourceDisposition: DISPOSITIONS.NONE,
        cause: options.cause
    });
}

function textOf(error) {
    return [
        error?.message,
        error?.code,
        error?.res_code,
        error?.res_msg,
        error?.res_message,
        error?.errorCode,
        error?.errorMsg
    ].filter(Boolean).join(' ');
}

function classifyOperationError(error, context = {}) {
    if (error instanceof OperationError) return error;
    const message = textOf(error) || String(error || '未知错误');
    const lower = message.toLowerCase();
    const base = { source: context.source, operation: context.operation, cause: error };

    if (/shareauditwaiting|审核中/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.RESOURCE_AUDIT, code: 'RESOURCE_AUDIT', retryable: true, retryAfterMs: 6 * 60 * 60 * 1000, resourceDisposition: DISPOSITIONS.TEMPORARY, resourceTtlMs: 6 * 60 * 60 * 1000 });
    }
    if (/访问码.*(无效|错误)|access.?code.*(invalid|wrong)/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.PARAMETER, code: 'ACCESS_CODE_INVALID', retryable: false, resourceDisposition: DISPOSITIONS.TEMPORARY, resourceTtlMs: 60 * 60 * 1000 });
    }
    if (/rss.*\b410\b|http[_ ]?410|status.?410/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.RESOURCE_INVALID, code: 'PT_RSS_GONE', retryable: false, resourceDisposition: DISPOSITIONS.PERMANENT });
    }
    if (/rss.*\b404\b|http[_ ]?404|status.?404/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.RESOURCE_INVALID, code: 'PT_RSS_NOT_FOUND', retryable: true, retryAfterMs: 24 * 60 * 60 * 1000, resourceDisposition: DISPOSITIONS.TEMPORARY, resourceTtlMs: 24 * 60 * 60 * 1000 });
    }
    if (/share.*(cancel|expired|invalid)|分享.*(取消|过期|失效)|shareinfoinvalid|sharecancelled/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.RESOURCE_INVALID, code: 'SHARE_INVALID', retryable: false, resourceDisposition: DISPOSITIONS.PERMANENT });
    }
    if (/invalidsession|unauthori[sz]ed|登录失效|鉴权|token.*expired|http[_ ]?401/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.AUTH, code: 'AUTH_FAILED', retryable: false });
    }
    if (/permissiondenied|forbidden|无权限|权限不足|http[_ ]?403/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.PERMISSION, code: 'PERMISSION_DENIED', retryable: false });
    }
    if (/payment required|response code 402|http[_ ]?402|insufficient.*(?:credit|balance)|余额不足|额度不足/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.PERMISSION, code: 'PAYMENT_REQUIRED', retryable: false });
    }
    if (/requestresubmit|alreadyexist|already exist|重复提交|幂等|conflict|http[_ ]?409/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.IDEMPOTENCY_CONFLICT, code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    }
    if (/429|ratelimit|rate limit|too many|限流|频繁/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.RATE_LIMIT, code: 'RATE_LIMITED', retryable: true, retryAfterMs: Number(error?.retryAfterMs || 0) || null });
    }
    if (/timeout|timed out|超时|econnreset|econnrefused|enotfound|network|socket|http[_ ]?5\d\d/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.TRANSIENT, code: 'TRANSIENT_FAILURE', retryable: true });
    }
    if (/invalid|参数|不能为空|格式错误|not found/.test(lower)) {
        return new OperationError(message, { ...base, category: ERROR_CATEGORIES.PARAMETER, code: 'INVALID_PARAMETER', retryable: false });
    }
    return new OperationError(message, { ...base, category: ERROR_CATEGORIES.UNKNOWN, code: 'UNKNOWN', retryable: true });
}

function calculateRetryDelayMs(retryCount, options = {}) {
    const attempt = Math.max(1, Number(retryCount || 1));
    const baseMs = Math.max(1000, Number(options.baseMs || 60_000));
    const maxMs = Math.min(30 * 60 * 1000, Math.max(baseMs, Number(options.maxMs || 30 * 60 * 1000)));
    const jitterRatio = Math.max(0, Math.min(0.5, Number(options.jitterRatio ?? 0.2)));
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const exponential = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
    const jitter = exponential * jitterRatio * ((random() * 2) - 1);
    return Math.max(1000, Math.min(maxMs, Math.round(exponential + jitter)));
}

module.exports = { OperationError, ERROR_CATEGORIES, DISPOSITIONS, classifyOperationError, calculateRetryDelayMs, createNoCoverageError };
