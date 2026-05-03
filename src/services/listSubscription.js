// 榜单订阅服务
// 周期性拉取豆瓣 / TMDB / Bangumi 榜单，对新条目优先调用自动追剧创建任务，
// 失败再走 PT（聚合搜索的第一个 directRss 结果）创建 PT 订阅。
// 数据持久化在 ConfigService 的 'listSubscriptions' 配置项下。

const cron = require('node-cron');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

const CONFIG_KEY = 'listSubscriptions';
const PT_FALLBACK_PRESETS = ['nyaa', 'dmhy', 'mikan', 'animegarden', 'anibt'];
const VALID_SOURCES = new Set(['douban', 'tmdb', 'bangumi']);

class ListSubscriptionService {
    constructor({ doubanService, tmdbService, autoSeriesService, ptService, ptSubscriptionRepo }) {
        this.doubanService = doubanService;
        this.tmdbService = tmdbService;
        this.autoSeriesService = autoSeriesService;
        this.ptService = ptService;
        this.ptSubscriptionRepo = ptSubscriptionRepo;
        this.cronJobs = new Map(); // id -> ScheduledTask
    }

    // === 持久化 ===
    _loadAll() {
        const list = ConfigService.getConfigValue(CONFIG_KEY, []);
        return Array.isArray(list) ? list : [];
    }

    _saveAll(list) {
        ConfigService.setConfigValue(CONFIG_KEY, list);
    }

    _genId() {
        return `ls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // === CRUD ===
    list() {
        return this._loadAll();
    }

    get(id) {
        return this._loadAll().find(s => s.id === id);
    }

    create(input) {
        const sub = this._validateAndNormalize(input);
        sub.id = this._genId();
        sub.createdAt = new Date().toISOString();
        sub.seenIds = [];
        sub.lastRunAt = null;
        sub.lastResult = null;
        const all = this._loadAll();
        all.push(sub);
        this._saveAll(all);
        this._scheduleOne(sub);
        return sub;
    }

    update(id, patch) {
        const all = this._loadAll();
        const idx = all.findIndex(s => s.id === id);
        if (idx < 0) throw new Error('榜单订阅不存在');
        const merged = { ...all[idx], ...patch };
        const validated = this._validateAndNormalize(merged);
        validated.id = id;
        validated.createdAt = all[idx].createdAt;
        validated.seenIds = Array.isArray(merged.seenIds) ? merged.seenIds : [];
        validated.lastRunAt = merged.lastRunAt || null;
        validated.lastResult = merged.lastResult || null;
        all[idx] = validated;
        this._saveAll(all);
        this._unscheduleOne(id);
        this._scheduleOne(validated);
        return validated;
    }

    remove(id) {
        const all = this._loadAll();
        const next = all.filter(s => s.id !== id);
        if (next.length === all.length) throw new Error('榜单订阅不存在');
        this._saveAll(next);
        this._unscheduleOne(id);
    }

    _validateAndNormalize(input) {
        const source = String(input.source || '').toLowerCase();
        if (!VALID_SOURCES.has(source)) throw new Error(`无效的来源：${input.source}`);
        const category = String(input.category || '').trim();
        if (!category) throw new Error('分类不能为空');
        const cronExpr = String(input.cron || '0 8 * * *').trim();
        if (!cron.validate(cronExpr)) throw new Error(`无效的 cron 表达式：${cronExpr}`);
        const limit = Math.min(Math.max(parseInt(input.limit) || 20, 1), 100);
        return {
            id: input.id,
            name: String(input.name || '').trim() || `${source}-${category}`,
            enabled: input.enabled !== false,
            source,
            category,
            limit,
            cron: cronExpr,
            mode: input.mode === 'normal' ? 'normal' : 'lazy',
            fallbackToPt: input.fallbackToPt !== false,
            ptPreset: input.ptPreset || 'nyaa',
            remark: String(input.remark || '').trim(),
        };
    }

    // === 拉榜单 ===
    async _fetchList(sub) {
        const limit = sub.limit || 20;
        if (sub.source === 'douban') {
            // category：'热门' 走 recent_hot；其他走 search
            if (sub.category === '热门' || sub.category === 'hot') {
                const movies = await this.doubanService.getRecentHot('movie', 0, Math.ceil(limit / 2));
                const tv = await this.doubanService.getRecentHot('tv', 0, Math.floor(limit / 2));
                return [...movies, ...tv];
            }
            const movies = await this.doubanService.searchSubjects(sub.category, 'movie', 0, Math.ceil(limit / 2));
            const tv = await this.doubanService.searchSubjects(sub.category, 'tv', 0, Math.floor(limit / 2));
            return [...movies, ...tv];
        }
        if (sub.source === 'tmdb') {
            // category：'trending' / 'top_rated' / 'genre:{movieId}:{tvId}'
            if (sub.category === 'trending') {
                const data = await this.tmdbService.getTrending('all', 'week', 1);
                return (data || []).slice(0, limit).map(it => this._normalizeTmdb(it));
            }
            if (sub.category === 'top_rated') {
                const m = await this.tmdbService.getTopRated('movie', 1);
                const t = await this.tmdbService.getTopRated('tv', 1);
                const all = [...(m?.results || []), ...(t?.results || [])];
                return all.slice(0, limit).map(it => this._normalizeTmdb(it));
            }
            if (sub.category.startsWith('genre:')) {
                // 'genre:movieGenreId:tvGenreId'
                const parts = sub.category.split(':');
                const movieGenre = parts[1] || '';
                const tvGenre = parts[2] || '';
                const half = Math.ceil(limit / 2);
                const promises = [];
                if (movieGenre) promises.push(this.tmdbService.discover('movie', { with_genres: movieGenre, sort_by: 'popularity.desc', page: 1 }));
                if (tvGenre) promises.push(this.tmdbService.discover('tv', { with_genres: tvGenre, sort_by: 'popularity.desc', page: 1 }));
                const results = await Promise.all(promises);
                const all = results.flatMap(r => (r?.results || []).slice(0, half));
                return all.slice(0, limit).map(it => this._normalizeTmdb(it));
            }
            return [];
        }
        if (sub.source === 'bangumi') {
            if (sub.category === 'today') {
                return await this.doubanService.getBangumiToday();
            }
            if (sub.category === 'ranking') {
                return await this.doubanService.getBangumiRanking(limit);
            }
            const weekday = parseInt(sub.category, 10);
            if (!Number.isNaN(weekday) && weekday >= 1 && weekday <= 7) {
                return await this.doubanService.getBangumiByWeekday(weekday);
            }
            return [];
        }
        return [];
    }

    _normalizeTmdb(it) {
        // 让 TMDB 数据与 douban/bangumi 输出字段对齐：title/year/source/type
        const dateStr = it.releaseDate || it.first_air_date || '';
        const yearMatch = dateStr.match(/(\d{4})/);
        return {
            id: String(it.id),
            title: it.title || it.name || '',
            year: yearMatch ? yearMatch[1] : '',
            type: it.type === 'tv' || it.media_type === 'tv' ? 'tv' : 'movie',
            source: 'tmdb',
        };
    }

    _itemUid(item) {
        // 跨源唯一 id
        return `${item.source || 'unknown'}-${item.id || item.title}`;
    }

    // === 单次执行 ===
    async run(id) {
        const all = this._loadAll();
        const idx = all.findIndex(s => s.id === id);
        if (idx < 0) throw new Error('榜单订阅不存在');
        const sub = all[idx];
        if (!sub.enabled) {
            return { skipped: true, reason: 'disabled' };
        }

        const stats = {
            startedAt: new Date().toISOString(),
            totalFetched: 0,
            newItems: 0,
            autoSeries: 0,
            pt: 0,
            failed: 0,
            errors: []
        };

        try {
            const items = await this._fetchList(sub);
            stats.totalFetched = items.length;
            const seen = new Set(sub.seenIds || []);
            const newItems = items.filter(it => it && !seen.has(this._itemUid(it)));
            stats.newItems = newItems.length;

            for (const item of newItems) {
                const uid = this._itemUid(item);
                try {
                    await this._dispatchOne(sub, item, stats);
                } catch (e) {
                    stats.failed += 1;
                    stats.errors.push({ uid, title: item.title, message: e?.message || String(e) });
                }
                seen.add(uid);
            }
            sub.seenIds = [...seen].slice(-500); // 只保留最近 500 条避免无限增长
        } catch (e) {
            stats.errors.push({ message: `拉取榜单失败: ${e?.message || e}` });
        }

        stats.finishedAt = new Date().toISOString();
        sub.lastRunAt = stats.finishedAt;
        sub.lastResult = stats;
        // 重新读最新数据再写回，避免与并发的 update 互相覆盖
        const fresh = this._loadAll();
        const fIdx = fresh.findIndex(s => s.id === id);
        if (fIdx >= 0) {
            fresh[fIdx] = { ...fresh[fIdx], seenIds: sub.seenIds, lastRunAt: sub.lastRunAt, lastResult: sub.lastResult };
            this._saveAll(fresh);
        }
        return stats;
    }

    async _dispatchOne(sub, item, stats) {
        // 1. 先尝试自动追剧
        try {
            await this.autoSeriesService.createByTitle({
                title: item.title,
                year: item.year || '',
                mode: sub.mode || 'lazy'
            });
            stats.autoSeries += 1;
            return;
        } catch (autoErr) {
            // autoSeries 失败 — 视配置决定是否走 PT 回退
            if (!sub.fallbackToPt) {
                throw autoErr;
            }
        }

        // 2. PT 回退：依次尝试 ptPreset 优先 + 备用列表，找到第一个 directRss 即创建订阅
        if (!this.ptService || !this.ptSubscriptionRepo) {
            throw new Error('PT 服务未初始化，无法回退');
        }
        const presetsTried = [sub.ptPreset, ...PT_FALLBACK_PRESETS.filter(p => p !== sub.ptPreset)];
        let lastErr = null;
        for (const preset of presetsTried) {
            try {
                const results = await this.ptService.searchSource(preset, item.title);
                const first = (results || [])[0];
                if (first?.directRss && first.url) {
                    await this._createPtSubscription(sub, item, first, preset);
                    stats.pt += 1;
                    return;
                }
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('PT 聚合搜索未找到可用 RSS');
    }

    async _createPtSubscription(sub, item, ptResult, preset) {
        // 沿用 task.autoCreate 的默认账号 / 目录配置
        const autoCreate = ConfigService.getConfigValue('task.autoCreate', {}) || {};
        const accountId = parseInt(autoCreate.accountId);
        const targetFolderId = String(autoCreate.targetFolderId || '');
        const targetFolder = String(autoCreate.targetFolder || '');
        if (!accountId || !targetFolderId) {
            throw new Error('需在系统设置中配置自动追剧默认账号与保存目录，PT 回退才能创建订阅');
        }
        const name = `${item.title}${item.year ? ` (${item.year})` : ''}`.trim();
        // 同名已存在则跳过
        const exists = await this.ptSubscriptionRepo.findOne({ where: { name } });
        if (exists) {
            return exists;
        }
        const created = this.ptSubscriptionRepo.create({
            name,
            sourcePreset: preset,
            rssUrl: ptResult.url,
            includePattern: '',
            excludePattern: '',
            accountId,
            targetFolderId,
            targetFolder,
            enabled: true
        });
        await this.ptSubscriptionRepo.save(created);
        // 创建后立即触发一次轮询（忽略失败）
        try {
            await this.ptService.runPoll(created.id);
        } catch {}
        return created;
    }

    // === Cron 调度 ===
    initAll() {
        const all = this._loadAll();
        for (const sub of all) {
            this._scheduleOne(sub);
        }
        logTaskEvent(`榜单订阅: 已挂载 ${this.cronJobs.size} 个任务`);
    }

    _scheduleOne(sub) {
        if (!sub.enabled) return;
        if (!cron.validate(sub.cron)) {
            logTaskEvent(`[榜单订阅] ${sub.name || sub.id} cron 无效: ${sub.cron}`);
            return;
        }
        if (this.cronJobs.has(sub.id)) {
            this.cronJobs.get(sub.id).stop();
        }
        const job = cron.schedule(sub.cron, async () => {
            try {
                const r = await this.run(sub.id);
                logTaskEvent(`[榜单订阅] ${sub.name} 完成: 新增 ${r.newItems} 条 (追剧 ${r.autoSeries}, PT ${r.pt}, 失败 ${r.failed})`);
            } catch (e) {
                logTaskEvent(`[榜单订阅] ${sub.name} 失败: ${e?.message || e}`);
            }
        });
        this.cronJobs.set(sub.id, job);
    }

    _unscheduleOne(id) {
        const job = this.cronJobs.get(id);
        if (job) {
            job.stop();
            this.cronJobs.delete(id);
        }
    }
}

module.exports = { ListSubscriptionService };
