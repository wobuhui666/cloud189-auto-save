const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonAction, normalizeNativeActions, hasActionLoop, isRecoverableToolError, selectAvailableTools, eligibleCommitCandidateIds, AutoSeriesAgentExecutor } = require('../src/services/autoSeriesAgent');

test('原生Tool Calling与JSON协议归一化为相同动作', () => {
    const json = parseJsonAction('{"name":"inspect_candidate","arguments":{"candidateId":"c1"}}');
    const native = normalizeNativeActions({ tool_calls: [{ id: 'call1', function: { name: 'inspect_candidate', arguments: '{"candidateId":"c1"}' } }] })[0];
    assert.equal(json.name, native.name);
    assert.deepEqual(json.arguments, native.arguments);
    assert.equal(json.protocol, 'json');
    assert.equal(native.protocol, 'native');
});

test('兼容模型泄漏的 call: 工具调用文本与对象参数', () => {
    const text = 'call:plan_metadata_override{"candidateId":"c1","metadata":{"source":"agent","files":[]}}';
    const json = parseJsonAction(text);
    const nativeText = normalizeNativeActions({
        tool_calls: [{ id: 'call-text', function: { name: 'plan_metadata_override', arguments: text } }]
    })[0];
    const nativeObject = normalizeNativeActions({
        tool_calls: [{ id: 'call-object', function: { name: 'inspect_candidate', arguments: { candidateId: 'c1' } } }]
    })[0];

    assert.equal(json.name, 'plan_metadata_override');
    assert.deepEqual(nativeText.arguments, json.arguments);
    assert.deepEqual(nativeObject.arguments, { candidateId: 'c1' });
});

test('Agent拒绝URL、账号和目录参数，并检测循环', () => {
    assert.throws(() => parseJsonAction('{"name":"commit_candidate","arguments":{"url":"https://example.com"}}'), /不得提供参数/);
    assert.throws(() => parseJsonAction('{"name":"commit_candidate","arguments":{"filters":{"callbackUrl":"https://example.com"}}}'), /不得提供/);
    assert.throws(() => parseJsonAction('{"name":"commit_candidate","arguments":{"filters":{"note":"https://example.com"}}}'), /不得提供任意 URL/);
    assert.equal(hasActionLoop([{ name: 'finish', arguments: {} }, { name: 'finish', arguments: {} }]), true);
    assert.equal(hasActionLoop([{ name: 'finish', arguments: { a: 1 } }, { name: 'report_no_coverage', arguments: {} }, { name: 'finish', arguments: { a: 1 } }, { name: 'report_no_coverage', arguments: {} }]), true);
});

test('PT 提交前置条件失败可反馈纠正，提交执行错误仍终止', () => {
    const action = { name: 'commit_candidate' };

    assert.equal(isRecoverableToolError(action, new Error('PT 正则缺少有效的服务端验证令牌')), true);
    assert.equal(isRecoverableToolError(action, new Error('候选缺少有效的元数据检查计划令牌')), true);
    assert.equal(isRecoverableToolError(action, new Error('数据库写入失败')), false);
});

test('Agent 按运行阶段收窄原生工具集', () => {
    const state = {
        searches: 0,
        candidates: new Map(),
        inspectedCandidates: new Set(),
        ptSampleInspections: new Set(),
        metadataInspections: new Map(),
        metadataPlans: new Map(),
        coveragePlans: new Map(),
        validationTokens: new Map()
    };
    assert.deepEqual(selectAvailableTools(state, { sources: ['pt'] }), ['search_resources']);

    state.searches = 1;
    state.candidates.set('pt-1', { candidateId: 'pt-1', type: 'pt_feed' });
    let tools = selectAvailableTools(state, { sources: ['pt'], intentId: 'intent-1' });
    assert.equal(tools.includes('inspect_pt_samples'), true);
    assert.equal(tools.includes('validate_pt_filters'), false);
    assert.equal(tools.includes('commit_candidate'), false);
    assert.equal(tools.includes('plan_coverage'), false);

    state.ptSampleInspections.add('pt-1');
    state.metadataInspections.set('candidate:pt-1', {});
    state.metadataPlans.set('plan-1', { candidateId: 'pt-1' });
    tools = selectAvailableTools(state, { sources: ['pt'], intentId: 'intent-1' });
    assert.equal(tools.includes('validate_pt_filters'), true);
    assert.equal(tools.includes('plan_metadata_override'), true);
    assert.equal(tools.includes('commit_candidate'), false);
    state.validationTokens.set('pt-1', 'validation-token');
    tools = selectAvailableTools(state, { sources: ['pt'], intentId: 'intent-1' });
    assert.deepEqual(eligibleCommitCandidateIds(state), ['pt-1']);
    assert.equal(tools.includes('commit_candidate'), true);
});

test('原生 Tool Calling 将 assistant tool_calls 和 tool 结果按协议回传', async () => {
    const calls = [];
    const aiService = {
        chatCompletion: async (messages) => {
            calls.push(messages);
            if (calls.length === 1) {
                return { success: true, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-search', type: 'function', function: { name: 'search_resources', arguments: '{"source":"cloudsaver"}' } }] } };
            }
            assert.equal(messages.at(-1).role, 'tool');
            assert.equal(messages.at(-1).tool_call_id, 'call-search');
            return { success: true, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-no-coverage', type: 'function', function: { name: 'report_no_coverage', arguments: '{"reason":"none"}' } }] } };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        aiService,
        sources: { cloudsaver: { search: async () => [] } },
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });
    const result = await executor.run({ title: '目标剧', sources: ['cloudsaver'] }, { toolCallMode: 'native', budget: { maxSteps: 3, timeoutMs: 1000 } });
    assert.equal(result.status, 'no_coverage');
    assert.equal(calls.length, 2);
});

test('Agent 未调用元数据工具时收到反馈且无法提交候选', async () => {
    const candidate = { candidateId: 'candidate-1', source: 'cloudsaver', type: 'cloud_share', title: '目标剧', score: 88, mediaInfo: {} };
    let committed = false;
    const calls = [];
    const responses = [
        { success: true, message: { role: 'assistant', content: '{"name":"search_resources","arguments":{"source":"cloudsaver"}}' } },
        { success: true, message: { role: 'assistant', content: '{"name":"commit_candidate","arguments":{"candidateId":"candidate-1"}}' } },
        { success: true, message: { role: 'assistant', content: '{"name":"inspect_candidate","arguments":{"candidateId":"candidate-1"}}' } },
        { success: true, message: { role: 'assistant', content: '{"name":"report_no_coverage","arguments":{"reason":"缺少元数据计划"}}' } }
    ];
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                calls.push(messages);
                return responses.shift();
            }
        },
        sources: { cloudsaver: { search: async () => [candidate] } },
        candidateExecutor: {
            inspect: async () => ({ ...candidate, files: [] }),
            commit: async id => {
                committed = true;
                return { taskIds: [9], candidateId: id };
            },
            registry: { get: () => null }
        },
        ptService: {}
    });

    const result = await executor.run(
        { title: '目标剧', sources: ['cloudsaver'] },
        { toolCallMode: 'json', budget: { maxSteps: 4, timeoutMs: 1000 } }
    );
    const feedbackMessage = [...calls[2]].reverse()
        .find(message => message.role === 'user' && String(message.content || '').includes('"toolResult"'));
    const feedback = JSON.parse(feedbackMessage.content).toolResult;

    assert.equal(result.status, 'no_coverage');
    assert.deepEqual(feedback, { ok: false, error: '候选缺少有效的元数据检查计划令牌' });
    assert.equal(committed, false);
});

test('auto 模式原生协议不兼容时切换 JSON 执行', async () => {
    const calls = [];
    const aiService = {
        chatCompletion: async (messages, options) => {
            calls.push({ messages, options });
            if (calls.length === 1) return { success: false, status: 400, error: 'tools unsupported' };
            return { success: true, message: { role: 'assistant', content: '{"name":"report_no_coverage","arguments":{"reason":"暂无资源"}}' } };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        aiService,
        sources: {},
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });

    const result = await executor.run({ title: '目标剧', sources: [] }, { toolCallMode: 'auto', budget: { maxSteps: 3, timeoutMs: 1000 } });
    assert.equal(result.status, 'no_coverage');
    assert.equal(result.protocol, 'json');
    assert.equal(calls.length, 2);
    assert.equal(Boolean(calls[0].options.tools), true);
    assert.equal(Boolean(calls[1].options.tools), false);
});

test('auto 模式在成功响应缺少原生工具动作时切换 JSON 执行', async () => {
    const calls = [];
    const aiService = {
        chatCompletion: async (messages, options) => {
            calls.push({ messages, options });
            if (calls.length === 1) return { success: true, message: { role: 'assistant', content: '这不是工具动作' } };
            return { success: true, message: { role: 'assistant', content: '{"name":"report_no_coverage","arguments":{"reason":"暂无资源"}}' } };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        aiService,
        sources: {},
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });

    const result = await executor.run({ title: '目标剧', sources: [] }, { toolCallMode: 'auto', budget: { maxSteps: 3, timeoutMs: 1000 } });
    assert.equal(result.status, 'no_coverage');
    assert.equal(result.protocol, 'json');
    assert.equal(calls.length, 2);
    assert.equal(Boolean(calls[0].options.tools), true);
    assert.equal(Boolean(calls[1].options.tools), false);
});

test('auto 模式在 JSON 动作损坏时切回原生协议', async () => {
    const calls = [];
    const aiService = {
        chatCompletion: async (messages, options) => {
            calls.push({ messages, options });
            if (calls.length === 1) return { success: false, status: 400, error: 'native unsupported once' };
            if (calls.length === 2) return { success: true, message: { role: 'assistant', content: '{"name":"report_no_coverage","arguments":{' } };
            return {
                success: true,
                message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call-recovered', type: 'function',
                        function: { name: 'report_no_coverage', arguments: '{"reason":"暂无资源"}' }
                    }]
                }
            };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        aiService,
        sources: {},
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });

    const result = await executor.run(
        { title: '目标剧', sources: [] },
        { toolCallMode: 'auto', budget: { maxSteps: 4, timeoutMs: 1000 } }
    );

    assert.equal(result.status, 'no_coverage');
    assert.deepEqual(calls.map(call => Boolean(call.options.tools)), [true, false, true]);
    assert.equal(calls[2].messages.some(message => /JSON动作无法解析/.test(String(message.content || ''))), true);
});

test('PT 正则校验失败会返回 Agent 继续决策而不是终止运行', async () => {
    const candidate = { candidateId: 'pt-1', source: 'pt', type: 'pt_feed', title: '错误候选', score: 1, mediaInfo: {} };
    const registryEntry = { candidate, secret: { candidate: { items: [] } } };
    const responses = [
        { name: 'search_resources', arguments: { source: 'pt' } },
        { name: 'inspect_pt_samples', arguments: { candidateId: 'pt-1' } },
        { name: 'validate_pt_filters', arguments: { candidateId: 'pt-1', filters: { includePattern: '目标剧' }, seasonNumber: 1 } },
        { name: 'report_no_coverage', arguments: { reason: 'PT 样本不匹配' } }
    ];
    const calls = [];
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                calls.push(messages);
                return { success: true, message: { role: 'assistant', content: JSON.stringify(responses.shift()) } };
            }
        },
        sources: { pt: { search: async () => [candidate] } },
        candidateExecutor: { registry: { get: id => id === 'pt-1' ? registryEntry : null } },
        ptService: { validateAutoSeriesFilters: async () => { throw new Error('PT 正则未命中真实样本'); } }
    });

    const result = await executor.run({ title: '目标剧', sources: ['pt'] }, { toolCallMode: 'json', budget: { maxSteps: 4, timeoutMs: 1000 } });
    const validationMessage = [...calls[3]].reverse()
        .find(message => message.role === 'user' && String(message.content || '').includes('"toolResult"'));
    const validationFeedback = JSON.parse(validationMessage.content).toolResult;
    assert.equal(result.status, 'no_coverage');
    assert.deepEqual(validationFeedback, { ok: false, error: 'PT 正则未命中真实样本' });
});

test('Agent 首次模型决策前自动搜索全部启用来源', async () => {
    const responses = [
        { name: 'report_no_coverage', arguments: { reason: '搜索后无资源' } }
    ];
    const calls = [];
    let searches = 0;
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                calls.push(messages);
                return { success: true, message: { role: 'assistant', content: JSON.stringify(responses.shift()) } };
            }
        },
        sources: { pt: { search: async () => { searches++; return []; } } },
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });

    const result = await executor.run(
        { title: '目标剧', sources: ['pt'] },
        { toolCallMode: 'json', budget: { maxSteps: 4, timeoutMs: 1000 } }
    );
    assert.equal(searches, 1);
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].at(-2).content || ''), /服务端已自动搜索全部启用来源/);
    assert.equal(result.status, 'no_coverage');
});

test('Agent 对重复动作返回纠错反馈而不是立即终止', async () => {
    const candidate = { candidateId: 'pt-1', source: 'pt', type: 'pt_feed', title: '目标剧', score: 80, mediaInfo: {} };
    const responses = [
        { name: 'inspect_pt_samples', arguments: { candidateId: 'pt-1' } },
        { name: 'inspect_pt_samples', arguments: { candidateId: 'pt-1' } },
        { name: 'report_no_coverage', arguments: { reason: '样本没有覆盖' } }
    ];
    const calls = [];
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                calls.push(messages);
                return { success: true, message: { role: 'assistant', content: JSON.stringify(responses.shift()) } };
            }
        },
        sources: { pt: { search: async () => [candidate] } },
        candidateExecutor: {
            registry: { get: id => id === 'pt-1' ? { candidate, secret: { candidate: { items: [] } } } : null }
        },
        ptService: {}
    });

    const result = await executor.run(
        { title: '目标剧', sources: ['pt'] },
        { toolCallMode: 'json', budget: { maxSteps: 4, timeoutMs: 1000 } }
    );
    const feedbackMessage = [...calls[2]].reverse()
        .find(message => message.role === 'user' && String(message.content || '').includes('"toolResult"'));
    const feedback = JSON.parse(feedbackMessage.content).toolResult;

    assert.equal(result.status, 'no_coverage');
    assert.equal(feedback.ok, false);
    assert.match(feedback.error, /已执行过且没有推进状态/);
});

test('PT 提交只使用服务端验证并锁定的有效正则', async () => {
    const candidate = { candidateId: 'pt-1', source: 'pt', type: 'pt_feed', title: 'LoliHouse', score: 90, mediaInfo: {} };
    const secretCandidate = { includePattern: '^\\[LoliHouse\\]', items: [] };
    const effectiveFilters = {
        includePattern: '^\\[LoliHouse\\]\n碧蓝之海 第三季',
        excludePattern: 'Trailer|预告',
        qualityPattern: '',
        resolutionPattern: '',
        effectPattern: ''
    };
    const registryEntry = { candidate, secret: { candidate: secretCandidate } };
    const responses = [
        { name: 'search_resources', arguments: { source: 'pt' } },
        { name: 'inspect_pt_samples', arguments: { candidateId: 'pt-1' } },
        { name: 'inspect_metadata', arguments: { candidateId: 'pt-1' } },
        { name: 'plan_metadata_override', arguments: { candidateId: 'pt-1', metadata: { source: 'agent', work: { title: '碧蓝之海 第三季', mediaType: 'tv' }, files: [] } } },
        () => ({ name: 'validate_pt_filters', arguments: { candidateId: 'pt-1', filters: { includePattern: '碧蓝之海 第三季', excludePattern: 'Trailer|预告' }, seasonNumber: 3 } }),
        () => ({ name: 'commit_candidate', arguments: { candidateId: 'pt-1' } })
    ];
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                const response = responses.shift();
                if (typeof response === 'function') {
                    return { success: true, message: { role: 'assistant', content: JSON.stringify(response()) } };
                }
                return { success: true, message: { role: 'assistant', content: JSON.stringify(response) } };
            }
        },
        sources: { pt: { search: async () => [candidate] } },
        candidateExecutor: {
            registry: { get: id => id === 'pt-1' ? registryEntry : null },
            inspect: async () => ({ ...candidate, fingerprint: 'fingerprint', files: [] }),
            commit: async () => ({ subscriptionId: 7 })
        },
        ptService: {
            validateAutoSeriesFilters: async () => ({ token: 'validation-token', filters: effectiveFilters, summary: { matchedCount: 5 } })
        }
    });

    const result = await executor.run({ title: '碧蓝之海 第三季', sources: ['pt'], agentEnabled: true }, { toolCallMode: 'json', budget: { maxSteps: 7, timeoutMs: 1000 } });

    assert.equal(result.status, 'completed');
    assert.equal(result.actions.at(-1).name, 'commit_candidate');
    assert.equal(result.actions.at(-1).protocol, 'server');
    assert.deepEqual(registryEntry.secret.candidate, { ...secretCandidate, ...effectiveFilters });
    assert.notEqual(registryEntry.secret.candidate.includePattern, '.*');
});

test('Agent 未给覆盖方案中的每个候选规划元数据时拒绝批量提交', async () => {
    const candidateA = { candidateId: 'a', source: 'cloudsaver', type: 'cloud_share', title: '目标剧 S01', score: 90, mediaInfo: {} };
    const candidateB = { candidateId: 'b', source: 'subscription', type: 'cloud_share', title: '目标剧 S02', score: 80, mediaInfo: {} };
    let callIndex = 0;
    const committed = [];
    const candidateExecutor = {
        registry: { get: () => null },
        inspect: async id => ({ ...(id === 'a' ? candidateA : candidateB), coverage: { keys: id === 'a' ? ['S01E001', 'S01E002'] : ['S02E001', 'S02E002'] } }),
        commitPlan: async assignments => {
            committed.push(...assignments);
            return {
                taskIds: [11, 12], coverageComplete: true, missingKeys: [],
                coverage: { keys: assignments.flatMap(item => item.keys), coveredEpisodes: 4, expectedEpisodes: 4 }
            };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        aiService: {
            chatCompletion: async messages => {
                const actions = [
                    { name: 'search_resources', arguments: { source: 'all' } },
                    { name: 'inspect_candidate', arguments: { candidateId: 'a' } },
                    { name: 'inspect_candidate', arguments: { candidateId: 'b' } },
                    { name: 'plan_coverage', arguments: { candidateIds: ['a', 'b'] } }
                ];
                if (callIndex < actions.length) {
                    return { success: true, message: { role: 'assistant', content: JSON.stringify(actions[callIndex++]) } };
                }
                const lastToolResult = JSON.parse(messages.at(-2).content).toolResult;
                return { success: true, message: { role: 'assistant', content: JSON.stringify({ name: 'commit_coverage_plan', arguments: { planToken: lastToolResult.planToken } }) } };
            }
        },
        sources: {
            cloudsaver: { search: async () => [candidateA] },
            subscription: { search: async () => [candidateB] }
        },
        candidateExecutor,
        ptService: {}
    });
    await assert.rejects(executor.run({
        title: '目标剧', sources: ['cloudsaver', 'subscription'],
        tmdbInfo: { seasons: [{ seasonNumber: 1, episodeCount: 2 }, { seasonNumber: 2, episodeCount: 2 }] }
    }, { toolCallMode: 'json', budget: { maxSteps: 8, timeoutMs: 1000 } }), /未完成元数据规划/);
    assert.equal(committed.length, 0);
});

test('metadata_audit 只用 targetRef/fileRef 规划并自动应用', async () => {
    const applied = [];
    const metadataService = {
        resolveTargetRef: (targetRef, intentId) => {
            assert.equal(targetRef, 'target-1');
            assert.equal(intentId, 'intent-1');
            return { type: 'pt_release', id: 8 };
        },
        inspect: async () => ({
            fingerprint: 'fingerprint-1', automaticWork: { title: '目标剧' }, override: null,
            files: [{ fileRef: 'file-1', name: 'E01.mkv', size: 1, relativePath: 'nested/E01.mkv', automatic: { seasonNumber: 1, episodeNumber: 1, special: false } }]
        }),
        createPlan: async (type, id, metadata, options) => {
            assert.equal(type, 'pt_release'); assert.equal(id, 8);
            assert.equal(metadata.files[0].relativePath, 'nested/E01.mkv');
            assert.equal(options.scope.intentId, 'intent-1');
            return { noop: false, planToken: 'plan-1', preview: { changeCount: 1 } };
        },
        applyPlan: async (token, options) => {
            applied.push({ token, options });
            return { applied: true };
        }
    };
    const executor = new AutoSeriesAgentExecutor({
        metadataService,
        aiService: {
            chatCompletion: async () => ({
                success: true,
                message: {
                    role: 'assistant', content: null,
                    tool_calls: [{ id: 'audit-1', type: 'function', function: { name: 'plan_metadata_override', arguments: JSON.stringify({ metadata: { source: 'agent', work: { title: '目标剧', mediaType: 'tv' }, files: [{ fileRef: 'file-1', seasonNumber: 1, episodeNumber: 1 }] } }) } }]
                }
            })
        },
        candidateExecutor: { registry: { get: () => null } },
        ptService: {}
    });
    const result = await executor.runMetadataAudit({ intentId: 'intent-1' }, { targetRef: 'target-1', toolCallMode: 'native' });
    assert.equal(result.noop, false);
    assert.equal(applied[0].token, 'plan-1');
    assert.equal(applied[0].options.scope.targetRef, 'target-1');
});
