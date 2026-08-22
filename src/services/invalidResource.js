const crypto = require('crypto');
const { IsNull, MoreThan } = require('typeorm');
const { getInvalidResourceRepository } = require('../database');
const { DISPOSITIONS, classifyOperationError } = require('./operationError');

function normalizeShareCode(resource = '') {
    const text = String(resource || '').trim();
    const match = text.match(/\/t\/([A-Za-z0-9_-]+)/i)
        || text.match(/[?&](?:t|shareCode)=([A-Za-z0-9_-]+)/i)
        || text.match(/\b([A-Za-z0-9_-]{6,32})\b/);
    return String(match?.[1] || text).trim().toLowerCase();
}

function buildInvalidResourceHash(resource, resourceType = 'cloud_share') {
    const normalized = resourceType === 'cloud_share'
        ? normalizeShareCode(resource)
        : String(resource || '').trim().toLowerCase();
    return crypto.createHash('sha256').update(`${resourceType}:${normalized}`).digest('hex');
}

class InvalidResourceService {
    constructor(repository = null) {
        this.repository = repository;
    }

    _repo() {
        return this.repository || getInvalidResourceRepository();
    }

    async record(resource, options = {}) {
        const operationError = classifyOperationError(options.error || options.reason || '', options);
        if (operationError.resourceDisposition === DISPOSITIONS.NONE) return null;
        const resourceType = options.resourceType || 'cloud_share';
        const resourceHash = buildInvalidResourceHash(resource, resourceType);
        const now = new Date();
        const expiresAt = operationError.resourceDisposition === DISPOSITIONS.PERMANENT
            ? null
            : new Date(now.getTime() + Number(operationError.resourceTtlMs || operationError.retryAfterMs || 0));
        const repo = this._repo();
        let row = await repo.findOne({ where: { resourceHash, releasedAt: IsNull() }, order: { id: 'DESC' } });
        if (!row) row = repo.create({ resourceHash });
        Object.assign(row, {
            resourceType,
            source: options.source || operationError.source || '',
            errorCategory: operationError.category,
            errorCode: operationError.code,
            reason: operationError.message.slice(0, 1000),
            metadataJson: JSON.stringify(options.metadata || {}),
            expiresAt,
            releasedAt: null,
            releasedBy: ''
        });
        return repo.save(row);
    }

    async isInvalid(resource, resourceType = 'cloud_share') {
        const resourceHash = buildInvalidResourceHash(resource, resourceType);
        const repo = this._repo();
        const rows = await repo.find({ where: [{ resourceHash, releasedAt: IsNull(), expiresAt: IsNull() }, { resourceHash, releasedAt: IsNull(), expiresAt: MoreThan(new Date()) }], order: { id: 'DESC' }, take: 1 });
        return rows[0] || null;
    }

    async list(options = {}) {
        const take = Math.min(500, Math.max(1, Number(options.limit || 100)));
        const rows = await this._repo().find({ order: { updatedAt: 'DESC' }, take });
        return options.activeOnly === false ? rows : rows.filter(row => !row.releasedAt && (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now()));
    }

    async release(id, releasedBy = 'manual') {
        const repo = this._repo();
        const row = await repo.findOneBy({ id: Number(id) });
        if (!row) throw new Error('失效资源记录不存在');
        row.releasedAt = new Date();
        row.releasedBy = String(releasedBy || 'manual');
        return repo.save(row);
    }
}

module.exports = { InvalidResourceService, buildInvalidResourceHash, normalizeShareCode };
