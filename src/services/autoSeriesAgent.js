const crypto = require('crypto');
const aiService = require('./ai');
const {
    buildExpectedCoverage,
    buildGreedyCoveragePlan,
    normalizeCoverageState
} = require('./autoSeriesCoverage');
const { buildMetadataTemplate, normalizeMetadataOverride } = require('./metadataOverride');
const { resolveValidationSeasonNumber } = require('./ptFilterValidation');

const TOOL_NAMES = new Set(['search_resources', 'inspect_candidate', 'inspect_target', 'inspect_pt_samples', 'validate_pt_filters', 'list_metadata_targets', 'inspect_metadata', 'plan_metadata_override', 'apply_metadata_plan', 'plan_coverage', 'commit_coverage_plan', 'commit_candidate', 'finish', 'report_no_coverage']);
const PT_FILTER_PROPERTIES = {
    includePattern: { type: 'string', description: '必填且非空。只命中目标作品真实样本的正则。' },
    excludePattern: { type: 'string', description: '排除预告、音乐、样片及错误版本的正则，可为空。' },
    qualityPattern: { type: 'string' },
    resolutionPattern: { type: 'string' },
    effectPattern: { type: 'string' }
};
const TOOL_DEFINITIONS = {
    search_resources: { description: '搜索一个来源或全部来源。source 可为 all、cloudsaver、hdhive、subscription、pt。', properties: { source: { type: 'string' } } },
    inspect_candidate: { description: '递归检查候选实际分享目录，返回服务端识别的季度和集数覆盖。', required: ['candidateId'], properties: { candidateId: { type: 'string' } } },
    inspect_target: { description: '检查目标账号、目录和模式是否已经配置。', properties: {} },
    inspect_pt_samples: { description: '读取 PT 候选的近期安全样本。', required: ['candidateId'], properties: { candidateId: { type: 'string' } } },
    validate_pt_filters: { description: '服务端用真实样本验证 PT 过滤规则并返回提交令牌。filters.includePattern 必须非空；电影无需季号和集号。', required: ['candidateId', 'filters'], properties: { candidateId: { type: 'string' }, filters: { type: 'object', properties: PT_FILTER_PROPERTIES, required: ['includePattern'], additionalProperties: false }, seasonNumber: { type: ['integer', 'null'] } } },
    list_metadata_targets: { description: '列出当前 Intent 已关联且可审计的匿名元数据目标。', properties: {} },
    inspect_metadata: { description: '检查候选或匿名目标的真实文件树、自动识别值、覆盖和文件指纹。', properties: { candidateId: { type: 'string' }, targetRef: { type: 'string' } } },
    plan_metadata_override: { description: '为已检查候选或匿名目标规划作品和逐文件元数据；文件只使用 inspect_metadata 返回的 fileRef，禁止提交路径。', required: ['metadata'], properties: { candidateId: { type: 'string' }, targetRef: { type: 'string' }, metadata: { type: 'object' } } },
    apply_metadata_plan: { description: '自动应用已有匿名目标的元数据计划。', required: ['planToken'], properties: { planToken: { type: 'string' } } },
    plan_coverage: { description: '用已检查候选制定全季覆盖方案；季集分配完全由服务端计算。', required: ['candidateIds'], properties: { candidateIds: { type: 'array', items: { type: 'string' }, minItems: 1 } } },
    commit_coverage_plan: { description: '用 plan_coverage 返回的令牌原样提交多来源覆盖方案；每个候选须已完成元数据检查。', required: ['planToken'], properties: { planToken: { type: 'string' } } },
    commit_candidate: { description: '提交单个已完成元数据规划的候选；PT 候选还必须已经通过服务端正则验证。令牌由服务端按 candidateId 绑定，无需传入。', required: ['candidateId'], properties: { candidateId: { type: 'string' } } },
    finish: { description: '保留工具；不能用它空结束运行。', properties: {} },
    report_no_coverage: { description: '确认没有任何可提交的新覆盖时报告原因。', properties: { reason: { type: 'string' } } }
};
const FORBIDDEN_ARGUMENT_KEYS = new Set(['url', 'sharelink', 'rssurl', 'accountid', 'targetfolderid', 'directoryid', 'folderid', 'relativepath', 'targetpath', 'filepath']);
const RECOVERABLE_TOOL_ERRORS = new Set(['inspect_candidate', 'inspect_pt_samples', 'validate_pt_filters', 'inspect_metadata', 'plan_metadata_override', 'plan_coverage', 'report_no_coverage']);
const RECOVERABLE_COMMIT_PRECONDITION = /候选缺少有效的元数据检查计划令牌|PT 正则缺少有效的服务端验证令牌/;
const DEFAULT_AGENT_BUDGET = Object.freeze({ maxSearches: 6, maxCommits: 5, maxSteps: 20, timeoutMs: 5 * 60 * 1000 });
const COMPLETION_STEP_ALLOWANCE = 6;

function selectAvailableTools(state, context = {}) {
    if (state.searches === 0 && (context.sources || []).length) return ['search_resources'];

    const names = new Set(['search_resources', 'inspect_target', 'report_no_coverage']);
    const candidates = [...state.candidates.values()];
    if (candidates.length) {
        names.add('inspect_candidate');
        names.add('inspect_metadata');
    }
    if (candidates.some(candidate => candidate.type === 'pt_feed')) {
        names.add('inspect_pt_samples');
        if ([...state.ptSampleInspections].some(candidateId => !state.validationTokens.has(candidateId))) {
            names.add('validate_pt_filters');
        }
    }
    if (state.metadataInspections.size) names.add('plan_metadata_override');
    if (eligibleCommitCandidateIds(state).length) {
        names.add('commit_candidate');
    }
    if ([...state.metadataPlans.values()].some(plan => plan.servicePlan)) names.add('apply_metadata_plan');
    if (candidates.some(candidate => candidate.type !== 'pt_feed') && state.inspectedCandidates.size) {
        names.add('plan_coverage');
    }
    if (state.coveragePlans.size) names.add('commit_coverage_plan');
    return [...names];
}

function eligibleCommitCandidateIds(state) {
    const plannedCandidateIds = [...new Set([...state.metadataPlans.values()].map(plan => plan.candidateId).filter(Boolean))];
    return plannedCandidateIds.filter(candidateId => {
        const candidate = state.candidates.get(candidateId);
        return candidate && (candidate.type !== 'pt_feed' || state.validationTokens.has(candidateId));
    });
}

function normalizeToolCallMode(value) {
    const mode = String(value || 'auto').toLowerCase();
    if (!['auto', 'native', 'json'].includes(mode)) throw new Error('toolCallMode 必须是 auto、native 或 json');
    return mode;
}

function normalizeToolAction(action, protocol) {
    if (!action || typeof action !== 'object') throw new Error('AI 动作必须是对象');
    const name = String(action.name || action.tool || '').trim();
    if (!TOOL_NAMES.has(name)) throw new Error(`AI 动作不允许: ${name}`);
    const args = action.arguments == null ? {} : action.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`AI 动作参数必须是对象: ${name}`);
    assertSafeArguments(args);
    return { callId: String(action.callId || action.id || crypto.randomUUID()), name, arguments: args, protocol };
}

function assertSafeArguments(value, path = 'arguments') {
    if (typeof value === 'string' && /https?:\/\//i.test(value)) throw new Error(`AI 不得提供任意 URL (${path})`);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
        if (FORBIDDEN_ARGUMENT_KEYS.has(normalizedKey) || normalizedKey.endsWith('url')) throw new Error(`AI 不得提供参数 ${path}.${key}`);
        assertSafeArguments(child, `${path}.${key}`);
    }
}

function parseJsonAction(content, protocol = 'json') {
    const clean = String(content || '').replace(/```(?:json)?\s*|\s*```/gi, '').trim();
    try {
        return normalizeToolAction(JSON.parse(clean), protocol);
    } catch (jsonError) {
        const call = clean.match(/^call:([a-z_][a-z0-9_]*)\s*([\s\S]*)$/i);
        if (!call) throw jsonError;
        const payload = JSON.parse(call[2] || '{}');
        const action = payload?.name || payload?.tool || payload?.arguments
            ? { ...payload, name: payload.name || payload.tool || call[1] }
            : { name: call[1], arguments: payload };
        return normalizeToolAction(action, protocol);
    }
}

function normalizeNativeActions(message = {}) {
    return (message.tool_calls || []).map(call => {
        const rawArguments = call.function?.arguments;
        if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
            return normalizeToolAction({ callId: call.id, name: call.function?.name, arguments: rawArguments }, 'native');
        }
        let parsedArguments;
        try {
            parsedArguments = JSON.parse(rawArguments || '{}');
        } catch (jsonError) {
            const parsed = parseJsonAction(rawArguments, 'native');
            const nativeName = String(call.function?.name || '').trim();
            if (nativeName && parsed.name !== nativeName) throw new Error(`AI 原生工具名不一致: ${nativeName} / ${parsed.name}`);
            return { ...parsed, callId: String(call.id || parsed.callId) };
        }
        return normalizeToolAction({
            callId: call.id,
            name: call.function?.name,
            arguments: parsedArguments
        }, 'native');
    });
}

function parseResponseActions(message = {}, protocol = 'native') {
    if (protocol === 'json') return { actions: [parseJsonAction(message.content, 'json')], protocol: 'json' };
    const actions = normalizeNativeActions(message);
    if (actions.length) return { actions, protocol: 'native' };
    if (String(message.content || '').trim()) {
        return { actions: [parseJsonAction(message.content, 'json')], protocol: 'json' };
    }
    throw new Error('AI 未返回工具动作');
}

function sanitizeToolError(error) {
    return String(error?.message || error || '工具执行失败')
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .slice(0, 1000);
}

function isRecoverableToolError(action, error) {
    if (RECOVERABLE_TOOL_ERRORS.has(action?.name)) return true;
    return action?.name === 'commit_candidate'
        && RECOVERABLE_COMMIT_PRECONDITION.test(String(error?.message || error || ''));
}

function hasActionLoop(history = []) {
    const keys = history
        .filter(action => action.protocol !== 'server')
        .map(action => `${action.name}:${JSON.stringify(action.arguments || {})}`);
    const length = keys.length;
    if (length >= 2 && keys[length - 1] === keys[length - 2]) return true;
    return length >= 4 && keys[length - 1] === keys[length - 3] && keys[length - 2] === keys[length - 4];
}

class AutoSeriesAgentExecutor {
    constructor(options = {}) {
        this.aiService = options.aiService || aiService;
        this.sources = options.sources || {};
        this.candidateExecutor = options.candidateExecutor;
        this.ptService = options.ptService;
        this.metadataService = options.metadataService || null;
    }

    async run(context = {}, options = {}) {
        const mode = normalizeToolCallMode(options.toolCallMode || 'auto');
        const budget = { ...DEFAULT_AGENT_BUDGET, ...(options.budget || {}) };
        const startedAt = Date.now();
        const state = { searches: 0, commits: 0, actions: [], trace: [], candidates: new Map(), inspectedCandidates: new Set(), ptSampleInspections: new Set(), metadataInspections: new Map(), metadataPlans: new Map(), coveragePlans: new Map(), validationTokens: new Map(), validationFilters: new Map(), validationSummaries: new Map(), paidUnlocks: 0 };
        const messages = [{ role: 'system', content: '你是自动追剧资源选择与元数据审计 Agent。只能调用给定工具；不得提供 URL、账号 ID、目录 ID或路径目标。每个候选提交前必须 inspect_metadata 并 plan_metadata_override；计划和验证令牌由服务端按 candidateId 自动绑定，无需在提交时传入。PT 候选提交前必须 inspect_pt_samples 并 validate_pt_filters；filters.includePattern 必须根据真实样本填写非空正则，验证失败时修正规则或更换候选。先检查实际文件树再规划元数据；不同候选覆盖互补时调用 plan_coverage。资源标题中的“全集”不能替代真实文件证据。电影发布可以没有季号和集号；剧集不得编造季度、集号或文件路径。' }, { role: 'user', content: JSON.stringify({ title: context.title, year: context.year, tmdb: context.tmdbInfo, mediaPreference: context.mediaPreference, sources: context.sources, coverageState: context.coverageState || null }) }];
        let protocol = mode === 'json' ? 'json' : 'native';

        if ((context.sources || []).length) {
            const action = { callId: crypto.randomUUID(), name: 'search_resources', arguments: { source: 'all' }, protocol: 'server' };
            state.actions.push(action);
            const toolResult = await this._execute(action, context, state, budget);
            state.trace.push({ name: action.name, protocol: action.protocol, ok: true });
            messages.push({
                role: 'system',
                content: `服务端已自动搜索全部启用来源。根据以下真实结果继续检查和决策：${JSON.stringify(toolResult)}`
            });

            const topPtCandidate = [...state.candidates.values()]
                .filter(candidate => candidate.type === 'pt_feed' && Number(candidate.mediaInfo?.sampleCount || 0) > 0)
                .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0];
            if (topPtCandidate) {
                const sampleAction = { callId: crypto.randomUUID(), name: 'inspect_pt_samples', arguments: { candidateId: topPtCandidate.candidateId }, protocol: 'server' };
                state.actions.push(sampleAction);
                const sampleResult = await this._execute(sampleAction, context, state, budget);
                state.trace.push({ name: sampleAction.name, protocol: sampleAction.protocol, ok: true });
                messages.push({
                    role: 'system',
                    content: `服务端已按确定性评分预检最高分 PT 候选 ${topPtCandidate.candidateId}。优先根据这些真实样本生成过滤规则：${JSON.stringify(sampleResult)}`
                });
            }
        }

        for (let step = 0; step < budget.maxSteps + ((state.validationTokens.size || state.metadataPlans.size) ? COMPLETION_STEP_ALLOWANCE : 0); step++) {
            if (Date.now() - startedAt > budget.timeoutMs) throw new Error('Agent 运行超时');
            const response = await this._next(messages, protocol, state, context);
            if (!response.success && mode === 'auto' && protocol === 'native' && [400, 404, 422].includes(Number(response.status))) {
                protocol = 'json';
                continue;
            }
            if (!response.success) throw new Error(response.error || 'AI 调用失败');
            let parsed;
            try {
                parsed = parseResponseActions(response.message, protocol);
            } catch (error) {
                if (mode === 'auto') {
                    const failedProtocol = protocol;
                    protocol = protocol === 'native' ? 'json' : 'native';
                    messages.push({
                        role: 'system',
                        content: `上一次${failedProtocol === 'native' ? '原生工具' : 'JSON'}动作无法解析（${sanitizeToolError(error)}）。不要重复原响应；重新生成一个语法完整的工具动作。`
                    });
                    continue;
                }
                throw error;
            }
            protocol = parsed.protocol;
            const actions = parsed.actions;
            if (protocol === 'native') messages.push(response.message);
            for (const action of actions) {
                state.actions.push(action);
                let toolResult;
                if (hasActionLoop(state.actions)) {
                    toolResult = { ok: false, error: `动作 ${action.name} 已执行过且没有推进状态，请根据已有结果选择下一步` };
                } else {
                    try {
                        toolResult = await this._execute(action, context, state, budget);
                    } catch (error) {
                        if (!isRecoverableToolError(action, error)) throw error;
                        toolResult = { ok: false, error: sanitizeToolError(error) };
                    }
                }
                state.trace.push({ name: action.name, protocol: action.protocol, ok: toolResult.ok !== false, error: toolResult.error || '' });
                if (toolResult.terminal) return { ...toolResult, protocol, actions: state.actions, trace: state.trace };
                const readyPtCandidates = eligibleCommitCandidateIds(state)
                    .filter(candidateId => state.candidates.get(candidateId)?.type === 'pt_feed');
                if (toolResult.ok !== false && readyPtCandidates.length === 1) {
                    const commitAction = {
                        callId: crypto.randomUUID(),
                        name: 'commit_candidate',
                        arguments: { candidateId: readyPtCandidates[0] },
                        protocol: 'server'
                    };
                    state.actions.push(commitAction);
                    const committed = await this._execute(commitAction, context, state, budget);
                    state.trace.push({ name: commitAction.name, protocol: commitAction.protocol, ok: true });
                    return { ...committed, protocol, actions: state.actions, trace: state.trace };
                }
                if (protocol === 'native') {
                    messages.push({ role: 'tool', tool_call_id: action.callId, content: JSON.stringify(toolResult) });
                } else {
                    messages.push({ role: 'assistant', content: JSON.stringify({ action }) });
                    messages.push({ role: 'user', content: JSON.stringify({ toolResult }) });
                }
            }
        }
        const error = new Error('Agent 达到工具步骤上限');
        error.agentActions = state.actions;
        error.agentTrace = state.trace;
        throw error;
    }

    async runMetadataAudit(context = {}, options = {}) {
        if (!this.metadataService) throw new Error('元数据审计服务未初始化');
        const targetRef = String(options.targetRef || '');
        if (!targetRef || !context.intentId) throw new Error('metadata_audit 缺少受控目标引用');
        const target = this.metadataService.resolveTargetRef(targetRef, context.intentId);
        const inspection = await this.metadataService.inspect(target.type, target.id);
        const state = {
            searches: 0, commits: 0, actions: [], trace: [], candidates: new Map(), inspectedCandidates: new Set(),
            ptSampleInspections: new Set(),
            metadataInspections: new Map([[`target:${targetRef}`, inspection]]), metadataPlans: new Map(),
            coveragePlans: new Map(), validationTokens: new Map(), validationFilters: new Map(), validationSummaries: new Map(), paidUnlocks: 0
        };
        const messages = [
            {
                role: 'system',
                content: '你处于 metadata_audit 模式。根据服务端给出的作品模板、自动识别和真实文件树，为每个媒体文件提交 plan_metadata_override。文件映射只能使用 fileRef，禁止提交 relativePath、任意路径、URL、账号或目录 ID。用户锁定字段保持不变；SP 使用 seasonNumber=0 和 special=true；半集可用 .5。只调用一次 plan_metadata_override。'
            },
            {
                role: 'user',
                content: JSON.stringify({
                    targetRef,
                    work: inspection.automaticWork,
                    template: context.metadataTemplate || null,
                    currentOverride: inspection.override,
                    fingerprint: inspection.fingerprint,
                    files: inspection.files.map(file => ({ fileRef: file.fileRef, name: file.name, size: file.size, automatic: file.automatic }))
                })
            }
        ];
        const mode = normalizeToolCallMode(options.toolCallMode || 'auto');
        let protocol = mode === 'json' ? 'json' : 'native';
        let response = await this._nextMetadataAudit(messages, protocol);
        if (!response.success && mode === 'auto' && protocol === 'native' && [400, 404, 422].includes(Number(response.status))) {
            protocol = 'json';
            response = await this._nextMetadataAudit(messages, protocol);
        }
        if (!response.success) throw new Error(response.error || 'metadata_audit Agent 调用失败');
        let parsed;
        try {
            parsed = parseResponseActions(response.message, protocol);
        } catch (error) {
            if (mode !== 'auto' || protocol !== 'native') throw error;
            protocol = 'json';
            response = await this._nextMetadataAudit(messages, protocol);
            if (!response.success) throw new Error(response.error || 'metadata_audit Agent 调用失败');
            parsed = parseResponseActions(response.message, protocol);
        }
        protocol = parsed.protocol;
        const action = parsed.actions[0];
        if (!action || action.name !== 'plan_metadata_override') throw new Error('metadata_audit Agent 必须返回元数据规划动作');
        action.arguments = { ...action.arguments, targetRef };
        const planned = await this._execute(action, context, state, DEFAULT_AGENT_BUDGET);
        if (planned.noop) return { status: 'completed', noop: true, protocol, inspection };
        const applied = await this._execute({
            callId: crypto.randomUUID(), name: 'apply_metadata_plan',
            arguments: { planToken: planned.planToken }, protocol
        }, context, state, DEFAULT_AGENT_BUDGET);
        return { status: 'completed', noop: false, protocol, inspection, applied };
    }

    async _nextMetadataAudit(messages, protocol) {
        const definition = TOOL_DEFINITIONS.plan_metadata_override;
        if (protocol === 'native') {
            return this.aiService.chatCompletion(messages, {
                temperature: 0,
                max_tokens: 3000,
                tool_choice: { type: 'function', function: { name: 'plan_metadata_override' } },
                tools: [{
                    type: 'function',
                    function: {
                        name: 'plan_metadata_override',
                        description: definition.description,
                        parameters: { type: 'object', properties: definition.properties, required: definition.required, additionalProperties: false }
                    }
                }]
            });
        }
        return this.aiService.chatCompletion([...messages, {
            role: 'system',
            content: '只输出 JSON：{"name":"plan_metadata_override","arguments":{"targetRef":"给定引用","metadata":{"source":"agent","work":{},"template":{},"files":[{"fileRef":"检查结果中的引用","seasonNumber":1,"episodeNumber":1,"special":false,"episodeTitle":"","targetFileName":""}]}}}'
        }], { temperature: 0, max_tokens: 3000 });
    }

    async _next(messages, protocol, state, context) {
        const availableTools = selectAvailableTools(state, context);
        if (protocol === 'native') {
            return this.aiService.chatCompletion(messages, {
                temperature: 0,
                max_tokens: 1600,
                tool_choice: 'required',
                tools: availableTools.map(name => {
                    const definition = TOOL_DEFINITIONS[name];
                    const required = [...(definition.required || [])];
                    const properties = { ...definition.properties };
                    if (name === 'plan_metadata_override'
                        && [...state.metadataInspections.keys()].some(key => key.startsWith('candidate:'))
                        && !required.includes('candidateId')) {
                        required.push('candidateId');
                    }
                    if (name === 'commit_candidate') {
                        properties.candidateId = { ...properties.candidateId, enum: eligibleCommitCandidateIds(state) };
                    }
                    if (name === 'validate_pt_filters') {
                        properties.candidateId = { ...properties.candidateId, enum: [...state.ptSampleInspections] };
                    }
                    return {
                        type: 'function',
                        function: {
                            name,
                            description: definition.description,
                            parameters: {
                                type: 'object',
                                properties,
                                required,
                                additionalProperties: false
                            }
                        }
                    };
                })
            });
        }
        return this.aiService.chatCompletion([...messages, {
            role: 'system',
            content: `只输出一个 JSON 动作：{"name":"工具名","arguments":{}}。当前可用工具：${availableTools.join('、')}。`
        }], { temperature: 0, max_tokens: 1600 });
    }

    async _execute(action, context, state, budget) {
        if (action.name === 'search_resources') {
            if (++state.searches > budget.maxSearches) throw new Error('Agent 搜索次数超限');
            const sourceName = String(action.arguments.source || 'all');
            const sourceEntries = sourceName === 'all' ? Object.entries(this.sources) : [[sourceName, this.sources[sourceName]]];
            const results = [];
            for (const [name, source] of sourceEntries) {
                if (!source) continue;
                const candidates = await source.search(context, { title: context.title, year: context.year });
                for (const candidate of candidates) state.candidates.set(candidate.candidateId, candidate);
                results.push({ source: name, candidates });
            }
            return { results };
        }
        if (action.name === 'inspect_candidate') {
            const candidate = state.candidates.get(String(action.arguments.candidateId || ''));
            if (!candidate) throw new Error('候选不属于当前运行');
            const inspected = await this.candidateExecutor.inspect(candidate.candidateId, context);
            state.candidates.set(candidate.candidateId, inspected);
            state.inspectedCandidates.add(candidate.candidateId);
            return { candidate: inspected };
        }
        if (action.name === 'list_metadata_targets') {
            if (!this.metadataService || !context.intentId) return { targets: [] };
            return { targets: await this.metadataService.listIntentTargets(context.intentId) };
        }
        if (action.name === 'inspect_metadata') {
            const candidateId = String(action.arguments.candidateId || '');
            const targetRef = String(action.arguments.targetRef || '');
            if (Boolean(candidateId) === Boolean(targetRef)) throw new Error('元数据检查必须且只能指定 candidateId 或 targetRef');
            if (candidateId) {
                const candidate = state.candidates.get(candidateId);
                if (!candidate) throw new Error('候选不属于当前运行');
                const inspectedCandidate = state.inspectedCandidates.has(candidateId)
                    ? candidate
                    : await this.candidateExecutor.inspect(candidateId, context);
                state.candidates.set(candidateId, inspectedCandidate);
                state.inspectedCandidates.add(candidateId);
                const files = Array.isArray(inspectedCandidate.files) ? inspectedCandidate.files : [];
                const inspection = this.metadataService
                    ? this.metadataService.normalize({
                        ...(context.metadataTemplate || buildMetadataTemplate(context.tmdbInfo || {}, 'agent')),
                        source: 'agent',
                        fingerprint: inspectedCandidate.fingerprint || '',
                        files: files.map(file => ({ relativePath: file.relativePath, ...file.automatic }))
                    }, { source: 'agent', fingerprint: inspectedCandidate.fingerprint || '' })
                    : buildMetadataTemplate(context.tmdbInfo || {}, 'agent');
                const result = { candidate: inspectedCandidate, suggestedOverride: inspection, fingerprint: inspectedCandidate.fingerprint || '' };
                state.metadataInspections.set(`candidate:${candidateId}`, result);
                return result;
            }
            if (!this.metadataService) throw new Error('元数据服务未初始化');
            const target = this.metadataService.resolveTargetRef(targetRef, context.intentId);
            const inspection = await this.metadataService.inspect(target.type, target.id);
            state.metadataInspections.set(`target:${targetRef}`, inspection);
            return inspection;
        }
        if (action.name === 'plan_metadata_override') {
            const candidateId = String(action.arguments.candidateId || '');
            const targetRef = String(action.arguments.targetRef || '');
            if (Boolean(candidateId) === Boolean(targetRef)) throw new Error('元数据规划必须且只能指定 candidateId 或 targetRef');
            const key = candidateId ? `candidate:${candidateId}` : `target:${targetRef}`;
            const inspection = state.metadataInspections.get(key);
            if (!inspection) throw new Error('元数据规划前必须先检查同一目标');
            const inspectionFiles = inspection.files || inspection.candidate?.files || [];
            const filesByRef = new Map(inspectionFiles.map(file => [String(file.fileRef || ''), file]));
            const submitted = action.arguments.metadata || {};
            const mappedFiles = (Array.isArray(submitted.files) ? submitted.files : []).map(file => {
                const inspectedFile = filesByRef.get(String(file.fileRef || ''));
                if (!inspectedFile) throw new Error('元数据文件引用不属于当前检查结果');
                const { fileRef, ...mapping } = file;
                return { ...mapping, relativePath: inspectedFile.relativePath };
            });
            const metadata = normalizeMetadataOverride({ ...submitted, files: mappedFiles }, {
                source: 'agent',
                fingerprint: inspection.fingerprint || inspection.candidate?.fingerprint || ''
            });
            if (candidateId) {
                const planToken = crypto.randomUUID();
                state.metadataPlans.set(planToken, { candidateId, metadata });
                return { planToken, noop: false, preview: { changeCount: metadata.files.length + 1, result: metadata } };
            }
            if (!this.metadataService) throw new Error('元数据服务未初始化');
            const target = this.metadataService.resolveTargetRef(targetRef, context.intentId);
            const planned = await this.metadataService.createPlan(target.type, target.id, metadata, {
                targetRef,
                fingerprint: inspection.fingerprint,
                scope: { intentId: context.intentId, targetRef }
            });
            if (!planned.noop) state.metadataPlans.set(planned.planToken, { targetRef, servicePlan: true });
            return planned;
        }
        if (action.name === 'apply_metadata_plan') {
            const planToken = String(action.arguments.planToken || '');
            const known = state.metadataPlans.get(planToken);
            if (!known?.servicePlan || !known.targetRef) throw new Error('只能应用本轮为已有目标生成的元数据计划');
            const result = await this.metadataService.applyPlan(planToken, { scope: { intentId: context.intentId, targetRef: known.targetRef } });
            state.metadataPlans.delete(planToken);
            return result;
        }
        if (action.name === 'inspect_target') return { accountConfigured: Boolean(context.accountId), targetConfigured: Boolean(context.targetFolderId), mode: context.mode };
        if (action.name === 'inspect_pt_samples') {
            const candidateId = String(action.arguments.candidateId || '');
            const entry = this.candidateExecutor.registry.get(candidateId);
            if (!entry || entry.candidate.type !== 'pt_feed') throw new Error('PT 候选不存在');
            state.inspectedCandidates.add(candidateId);
            state.ptSampleInspections.add(candidateId);
            return { samples: (entry.secret.candidate.items || []).slice(0, 50).map(item => ({ title: item.title, seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber, resolution: item.resolution, quality: item.quality })) };
        }
        if (action.name === 'validate_pt_filters') {
            const candidateId = String(action.arguments.candidateId || '');
            if (!state.ptSampleInspections.has(candidateId)) throw new Error('PT 正则校验前必须先检查同一候选的真实样本');
            const entry = this.candidateExecutor.registry.get(candidateId);
            if (!entry || entry.candidate.type !== 'pt_feed') throw new Error('PT 候选不存在');
            state.inspectedCandidates.add(candidateId);
            const seasonNumber = resolveValidationSeasonNumber({
                title: context.title,
                mediaType: context.tmdbInfo?.type || context.tmdbInfo?.mediaType || '',
                tmdbInfo: context.tmdbInfo,
                seasonNumber: action.arguments.seasonNumber ?? null
            });
            const validation = await this.ptService.validateAutoSeriesFilters({
                candidate: entry.secret.candidate,
                filters: action.arguments.filters || {},
                title: context.title,
                aliases: [context.tmdbInfo?.title, context.tmdbInfo?.originalTitle],
                seasonNumber,
                mediaType: context.tmdbInfo?.type || context.tmdbInfo?.mediaType || '',
                tmdbInfo: context.tmdbInfo
            });
            state.validationTokens.set(action.arguments.candidateId, validation.token);
            state.validationFilters.set(action.arguments.candidateId, validation.filters);
            state.validationSummaries.set(action.arguments.candidateId, validation.summary);
            return validation;
        }
        if (action.name === 'plan_coverage') {
            const candidateIds = [...new Set((action.arguments.candidateIds || []).map(String).filter(Boolean))];
            if (!candidateIds.length) throw new Error('覆盖方案至少需要一个候选');
            const candidates = candidateIds.map(candidateId => {
                const candidate = state.candidates.get(candidateId);
                if (!candidate || !state.inspectedCandidates.has(candidateId)) throw new Error('覆盖方案只能使用已检查候选');
                if (candidate.type === 'pt_feed') throw new Error('PT 候选请使用已验证正则的单候选提交');
                return { ...candidate, coverageKeys: candidate.coverage?.keys || [] };
            });
            const expectedCoverage = buildExpectedCoverage(context.tmdbInfo);
            if (!expectedCoverage.keys.length) throw new Error('TMDB 未提供各季集数，无法安全制定全季覆盖方案');
            const existingCoverage = normalizeCoverageState(context.coverageState || {}, expectedCoverage);
            const plan = buildGreedyCoveragePlan(candidates, expectedCoverage, existingCoverage.keys);
            if (!plan.assignments.length) throw new Error('所选候选没有新增覆盖');
            const planToken = crypto.randomUUID();
            state.coveragePlans.set(planToken, plan);
            return {
                planToken,
                assignments: plan.assignments.map(item => ({ candidateId: item.candidateId, episodeCount: item.keys.length })),
                coverage: plan.coverage,
                missingKeys: plan.missingKeys,
                complete: plan.complete
            };
        }
        if (action.name === 'commit_coverage_plan') {
            if (++state.commits > budget.maxCommits) throw new Error('Agent 候选提交次数超限');
            const planToken = String(action.arguments.planToken || '');
            const plan = state.coveragePlans.get(planToken);
            if (!plan) throw new Error('覆盖方案令牌不存在或已失效');
            for (const assignment of plan.assignments) {
                const candidate = state.candidates.get(assignment.candidateId);
                const metadataPlan = [...state.metadataPlans.values()].find(value => value.candidateId === assignment.candidateId);
                if (!metadataPlan) throw new Error(`候选 ${assignment.candidateId} 提交前未完成元数据规划`);
                assignment.metadataOverride = metadataPlan.metadata;
                this._authorizePaidCandidate(candidate, context, state);
            }
            const result = await this.candidateExecutor.commitPlan(plan.assignments, context);
            return {
                terminal: true,
                status: 'completed',
                result,
                preferenceScore: Math.max(...plan.assignments.map(item => Number(state.candidates.get(item.candidateId)?.score || 0))),
                coverage: result.coverage,
                missingKeys: result.missingKeys,
                coverageComplete: result.coverageComplete
            };
        }
        if (action.name === 'commit_candidate') {
            if (++state.commits > budget.maxCommits) throw new Error('Agent 候选提交次数超限');
            const candidateId = String(action.arguments.candidateId || '');
            const candidate = state.candidates.get(candidateId);
            if (!candidate) throw new Error('候选不属于当前运行');
            const metadataPlanEntry = [...state.metadataPlans.entries()].reverse()
                .find(([, plan]) => plan.candidateId === candidateId);
            if (!metadataPlanEntry) throw new Error('候选缺少有效的元数据检查计划令牌');
            const [metadataPlanToken, metadataPlan] = metadataPlanEntry;
            if (candidate.type === 'pt_feed') {
                const validatedFilters = state.validationFilters.get(candidateId);
                if (!state.validationTokens.get(candidateId) || !validatedFilters) {
                    throw new Error('PT 正则缺少有效的服务端验证令牌');
                }
                const entry = this.candidateExecutor.registry.get(candidateId);
                entry.secret.candidate = { ...entry.secret.candidate, ...validatedFilters };
            }
            this._authorizePaidCandidate(candidate, context, state);
            const result = await this.candidateExecutor.commit(candidateId, context, { metadataOverride: metadataPlan.metadata });
            state.metadataPlans.delete(metadataPlanToken);
            return {
                terminal: true,
                status: 'completed',
                result,
                preferenceScore: Number(candidate.score || 0),
                regexValidation: state.validationSummaries.get(candidateId) || null
            };
        }
        if (action.name === 'report_no_coverage') {
            if ((context.sources || []).length && state.searches === 0) {
                throw new Error('报告无覆盖前必须先搜索已启用来源');
            }
            if (state.candidates.size > 0 && state.inspectedCandidates.size === 0) {
                throw new Error('搜索到候选后必须至少检查一个候选才能报告无覆盖');
            }
            if (state.validationTokens.size > 0) {
                throw new Error('已有通过服务端校验的 PT 候选，必须完成元数据规划并提交');
            }
            return { terminal: true, status: 'no_coverage', reason: String(action.arguments.reason || '未找到覆盖资源') };
        }
        if (action.name === 'finish') throw new Error('Agent 必须提交候选或报告无覆盖，不能空结束');
        throw new Error(`未实现工具 ${action.name}`);
    }

    _authorizePaidCandidate(candidate, context, state) {
        const points = Number(candidate?.mediaInfo?.points || 0);
        const needsPaidUnlock = candidate?.source === 'hdhive'
            && !candidate.mediaInfo?.isFree
            && !candidate.mediaInfo?.isUnlocked
            && points > 0;
        if (!needsPaidUnlock) return;
        if (!context.allowHdhivePoints || points > Number(context.hdhiveMaxPoints || 0)) throw new Error('Agent 无权超出影巢积分授权上限');
        if (++state.paidUnlocks > 1) throw new Error('单次 Agent 运行最多一次付费解锁');
    }
}

module.exports = { AutoSeriesAgentExecutor, DEFAULT_AGENT_BUDGET, normalizeToolCallMode, normalizeToolAction, parseJsonAction, normalizeNativeActions, parseResponseActions, hasActionLoop, assertSafeArguments, isRecoverableToolError, selectAvailableTools, eligibleCommitCandidateIds };
