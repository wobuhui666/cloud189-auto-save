const DEFAULT_MIN_INTERVAL_MS = 1000;
const MAX_MIN_INTERVAL_MS = 60000;

const normalizeEnabled = (value) => value === true || String(value).toLowerCase() === 'true';

const normalizeHdhiveFlowControl = (config = {}) => {
    const parsedInterval = Number(config.minIntervalMs);
    const minIntervalMs = Number.isFinite(parsedInterval)
        ? Math.min(Math.max(Math.round(parsedInterval), 0), MAX_MIN_INTERVAL_MS)
        : DEFAULT_MIN_INTERVAL_MS;

    return {
        enabled: normalizeEnabled(config.enabled),
        minIntervalMs
    };
};

class HdhiveFlowController {
    constructor() {
        this.tail = Promise.resolve();
        this.lastStartedAt = 0;
    }

    async run(executor, config = {}) {
        const normalized = normalizeHdhiveFlowControl(config);
        if (!normalized.enabled) {
            return executor();
        }

        const previous = this.tail;
        let release;
        this.tail = new Promise((resolve) => {
            release = resolve;
        });

        try {
            await previous;
            await this.waitForInterval(normalized.minIntervalMs);
            this.lastStartedAt = Date.now();
            return await executor();
        } finally {
            release();
        }
    }

    async waitForInterval(minIntervalMs) {
        let waitMs = minIntervalMs - (Date.now() - this.lastStartedAt);
        while (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            waitMs = minIntervalMs - (Date.now() - this.lastStartedAt);
        }
    }
}

module.exports = {
    DEFAULT_MIN_INTERVAL_MS,
    MAX_MIN_INTERVAL_MS,
    HdhiveFlowController,
    normalizeHdhiveFlowControl
};
