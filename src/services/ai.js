const got = require('got');
const ConfigService = require('./ConfigService');
const { logTaskEvent } = require('../utils/logUtils');

class AIService {
    constructor() {
        this.defaultConfig = {
            temperature: 0,
            max_tokens: 4096,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0
        };
        this.retryConfig = {
            maxAttempts: 3,
            delayMs: 1500
        };
        this.flowControl = {
            chain: Promise.resolve(),
            queueSize: 0
        };
    }

    async _retryOperation(operationName, executor, options = {}) {
        const maxAttempts = Number(options.maxAttempts || this.retryConfig.maxAttempts || 1);
        const delayMs = Number(options.delayMs || this.retryConfig.delayMs || 0);
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await executor(attempt);
            } catch (error) {
                lastError = error;
                const errorMessage = error?.message || String(error);
                if (attempt >= maxAttempts) {
                    throw error;
                }
                logTaskEvent(`${operationName}失败，第${attempt}/${maxAttempts}次尝试: ${errorMessage}，${delayMs}ms后重试`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        throw lastError || new Error(`${operationName}失败`);
    }

    _getCleanAIJsonText(rawData) {
        if (rawData == null) {
            throw new Error('AI返回内容为空');
        }
        const text = typeof rawData === 'string' ? rawData : String(rawData);
        const cleanText = text
            .replace(/```(?:json)?\s*|\s*```/g, '')
            .replace(/^(?:json)?\s*/, '')
            .trim();
        if (!cleanText) {
            throw new Error('AI返回内容为空');
        }
        return cleanText;
    }

    // 校验是否开启了ai
    isEnabled(openaiConfig) {
        if (!openaiConfig) {
            openaiConfig = ConfigService.getConfigValue('openai')
        }
        return openaiConfig?.enable && openaiConfig?.apiKey && openaiConfig?.baseUrl && openaiConfig?.model;
    }

    isFlowControlEnabled(openaiConfig) {
        if (!openaiConfig) {
            openaiConfig = ConfigService.getConfigValue('openai');
        }
        return Boolean(openaiConfig?.flowControlEnabled);
    }

    async _runWithFlowControl(operationName, executor, openaiConfig) {
        if (!this.isFlowControlEnabled(openaiConfig)) {
            return await executor();
        }

        const previousChain = this.flowControl.chain;
        let releaseCurrent = null;

        this.flowControl.queueSize += 1;
        this.flowControl.chain = new Promise((resolve) => {
            releaseCurrent = () => {
                this.flowControl.queueSize = Math.max(0, this.flowControl.queueSize - 1);
                resolve();
            };
        });

        const waitingCount = Math.max(0, this.flowControl.queueSize - 1);
        if (waitingCount > 0) {
            logTaskEvent(`AI流控：${operationName}进入队列，前方还有 ${waitingCount} 个请求`);
        }

        try {
            await previousChain;
            return await executor();
        } finally {
            releaseCurrent && releaseCurrent();
        }
    }

    async chat(messages, config = {}) {
        try {
            const openaiConfig = ConfigService.getConfigValue('openai')
            if (!this.isEnabled(openaiConfig)) {
                throw new Error('AI服务未配置或未启用');
            }
            const apiKey = openaiConfig?.apiKey;
            const baseURL = openaiConfig?.baseUrl || 'https://api.openai.com/v1';
            const model = openaiConfig?.model || 'gpt-3.5-turbo';

            return await this._runWithFlowControl('AI聊天请求', async () => {
                const response = await got.post(`${baseURL}/chat/completions`, {
                    json: {
                        model,
                        messages,
                        stream: false,
                        ...this.defaultConfig,
                        ...config
                    },
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    responseType: 'json'
                });

                return {
                    success: true,
                    data: response.body.choices[0].message.content
                };
            });
        } catch (error) {
            let errorDetails = error.message;
            if (error.response) {
                errorDetails += `\n状态码: ${error.response.statusCode}`;
                errorDetails += `\n响应头: ${JSON.stringify(error.response.headers)}`;
                errorDetails += `\n响应体: ${JSON.stringify(error.response.body)}`;
            }

            console.error('AI 服务调用失败:', errorDetails);
            return {
                success: false,
                error: errorDetails,
                response: error.response ? {
                    status: error.response.statusCode,
                    headers: error.response.headers,
                    body: error.response.body
                } : null
            }
        }
    }

    // 文件夹分析
    async folderAnalysis(resourcePath, dirs) {
        const messages = [
            {
                role: 'system',
                content: `你是一个专业的影视剧文件夹名称标准化助手。你的任务是将各种格式的季度文件夹名称转换为标准格式。

                输入信息说明：
                1. name 字段必须是纯净的影视剧名称，不能包含年份、季数等信息。**当资源路径中包含括号内的年份时（如 "请回答1994(2025)"），括号前的所有文本（包括数字 "1994" 和文字 "请回答"）都应合并作为 name 字段，即 "请回答1994"。**
                2. 资源路径：包含影视剧的主要信息，**如果资源路径中同时包含普通年份和括号内的年份（如 "请回答1994(2025)"），请优先提取括号内的年份作为最终年份。**
                3. 文件夹列表：需要标准化的文件夹信息

                文件夹命名规则：
                1. 常规季度：仅当文件夹名称明确表示季度时（如 "第一季", "第1季", "S1", "Season1" 等），统一使用 "Season XX" 格式，XX 必须是两位数字。
                2. 特别篇/OVA：仅当文件夹名称明确表示特别篇时（如 "特别篇", "SP", "OVA" 等），统一使用 "特别篇XX" 格式，XX 必须是两位数字。
                3. **保留原始名称：如果文件夹名称不符合上述任何一种可识别的季/特别篇格式（例如，像 '1-100', '合集', 'Extras' 这样的名称），则必须在返回结果中保留其原始名称，绝对不要将其转换为 "Season XX" 或 "特别篇XX"。**
                4. 其他格式转换示例（仅适用于明确表示季/特别篇的情况）：
                   - "第一季" -> "Season 01"
                   - "第1季" -> "Season 01"
                   - "S1" -> "Season 01"
                   - "Season1" -> "Season 01"
                   - "特别篇" -> "特别篇01"
                   - "SP" -> "特别篇01"
                   - "OVA" -> "特别篇01"

                返回格式必须是: {
                    name: string,  // 纯净的影视剧名称，不含年份
                    year: number,  // 年份信息
                    type: "tv" | "movie",  // 资源类型
                    folders: [{    // 标准化后的文件夹列表
                        id: string,
                        name: string  // 标准化后的文件夹名称 (或原始名称)
                    }]
                }
                注意事项：
                1. 不要使用代码块标记，直接返回 JSON 对象
                2. 文件夹名称必须严格按照此格式返回，不要添加任何额外说明文字
                3. 不要对文件名内容做任何主观评判，专注于格式解析
                `
            },
            {
                role: 'user',
                content: `资源路径：${resourcePath}\n文件夹列表：${JSON.stringify(dirs, null, 2)}`
            }
        ];
        try {
            const result = await this._retryOperation('AI文件夹分析', async () => {
                const response = await this.chat(messages, {
                    temperature: 0,
                    max_tokens: 3000
                });
                if (!response.success) {
                    throw new Error(response.error || 'AI服务调用失败');
                }
                const cleanData = this._getCleanAIJsonText(response.data);
                const result = JSON.parse(cleanData);
                if (!this._validateFolderResponse(result)) {
                    throw new Error('AI返回格式不符合要求');
                }
                return result;
            });
            return {
                success: true,
                data: result
            };
        } catch (error) {
            console.log("AI 解析结果格式错误:", error.message)
            return {
                success: false,
                error: error.message || '解析结果格式错误'
            };
        }
    }

    async simpleChatCompletion(resourcePath, files) {
        const CHUNK_SIZE = 40; // 每次处理的文件数量
        let allEpisodes = [];
        let baseResult = null;

        if (!this.isEnabled()) {
            return { success: false, error: 'AI服务未配置或未启用' };
        }

        // 固定排序，避免分块顺序导致 base name 漂移
        files = [...(files || [])].sort((a, b) =>
            String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN', { numeric: true, sensitivity: 'base' })
        );

        try {
            for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                const chunk = files.slice(i, i + CHUNK_SIZE);
                let messages;

                if (i === 0) {
                    // 第一次调用，获取基础信息和第一批剧集
                    messages = [
                        {
                            role: 'system',
                            content: `你是一个专业的影视剧文件名解析助手。你的任务是客观地解析文件名和文件夹名，不要对内容做主观判断。
                            无论文件名的内容是什么，都要尽可能提取以下信息：
                            1. name 字段必须是纯净的影视剧名称，不能包含年份、季数等信息
                            2. 所有年份信息必须提取到 year 字段中
                            3. 如果无法确定年份，返回0, 如果无法确定季编号, 返回01
                            4. 如果无法判断类型，默认为 movie
                            5. 如果是单个文件，episode 数组只包含一个元素

                            返回格式必须是: {
                                name: string,  // 纯净的影视剧名称，不含年份
                                year: number,  // 提取的年份信息
                                type: "tv" | "movie",
                                season: string,  // 季编号，必须是纯数字字符串，如："01"
                                episode: [{ // 仅包含当前处理的 chunk 的剧集信息
                                    id: string,
                                    name: string, // 使用父级目录中提取到的纯净的影视剧名称，不含年份
                                    season: string,  // 季编号，必须是纯数字字符串，如："01"
                                    episode: string,  // 集编号，如果小于100使用两位数字（如："01"），大于等于100使用实际位数
                                    extension: string
                                }]
                            }

                            注意事项：
                            1. 季和剧集编号的格式规则：
                               - 如果编号小于100，使用两位数字格式（如：'01', '99'）
                               - 如果编号大于等于100，保持实际位数（如：'100', '1000'）
                               - 不要包含'S'或'E'前缀
                            2. 如果无法确定季编号, 返回01
                            3. 每个剧集必须包含名称：
                                 * 优先使用所在文件夹的纯净的影视剧名称，不能包含年份、季数等信息
                                 * 保留纯粹的剧集名称，确保与文件夹名称保持一致
                            2. 文件扩展名必须包含点号（如：'.mkv', '.mp4'）。
                            5. 年份必须是数字类型
                            6. 必须严格按照此格式返回，不要添加任何额外说明文字
                            7. 不要使用代码块标记，直接返回 JSON 对象
                            8. 不要对文件名内容做任何主观评判，专注于格式解析`
                        },
                        {
                            role: 'user',
                            content: `资源路径：${resourcePath}\n文件列表：${JSON.stringify(chunk, null, 2)}`
                        }
                    ];
                } else {
                    // 后续调用，只处理文件，使用第一次获取的基础信息
                    messages = [
                        {
                            role: 'system',
                            content: `你是一个专业的影视剧文件名解析助手。基于以下信息，请解析提供的文件列表：
                            影视剧名称: ${baseResult.name}
                            年份: ${baseResult.year}
                            类型: ${baseResult.type}
                            季编号: ${baseResult.season || 'N/A'} // 提供季编号上下文

                            返回格式必须是**严格的 JSON 对象**，包含一个 'episode' 键，其值为一个数组。数组中的每个对象代表一个剧集信息。**确保所有键（如 "id", "name", "season", "episode", "extension"）都用双引号括起来**：
                            {
                                "episode": [{ // 仅包含当前处理的 chunk 的剧集信息
                                    "id": "string",
                                    "name": "${baseResult.name}", // 使用上面提供的影视剧名称，不能包含年份
                                    "season": "${baseResult.season || ''}",  // 使用上面提供的季编号 (确保是字符串)
                                    "episode": "string",  // 集编号，如果小于100使用两位数字（如："01"），大于等于100使用实际位数
                                    "extension": "string"
                                }]
                            }

                            注意事项：
                            1. 集编号的格式规则：
                               - 如果编号小于100，使用两位数字格式（如：'01', '99'）
                               - 如果编号大于等于100，保持实际位数（如：'100', '1000'）
                            2. 文件扩展名必须包含点号（如：'.mkv', '.mp4'）。
                            3. **必须严格按照上述 JSON 格式返回，确保所有键和字符串值都使用双引号。**
                            4. 必须严格按照此格式返回，不要添加任何额外说明文字。
                            5. 不要使用代码块标记，直接返回 JSON 对象
                            6. 只需要返回 'episode' 字段。`
                        },
                        {
                            role: 'user',
                            content: `文件列表：${JSON.stringify(chunk, null, 2)}`
                        }
                    ];
                }

                const chunkNumber = i / CHUNK_SIZE + 1;
                const resultChunk = await this._retryOperation(`AI文件解析块 ${chunkNumber}`, async () => {
                    const response = await this.chat(messages, {
                        temperature: 0,
                        max_tokens: 3000 // 保持足够空间处理块
                    });
                    if (!response.success) {
                        throw new Error(`AI 调用失败 (块 ${chunkNumber}): ${response.error}`);
                    }
                    const cleanData = this._getCleanAIJsonText(response.data);
                    const parsedChunk = JSON.parse(cleanData);
                    if (i === 0) {
                        if (!parsedChunk.episode || !Array.isArray(parsedChunk.episode)) {
                            throw new Error(`AI 返回格式错误 (块 1): 缺少 'episode' 数组`);
                        }
                    } else if (!parsedChunk.episode || !Array.isArray(parsedChunk.episode)) {
                        throw new Error(`AI 返回格式错误 (块 ${chunkNumber}): 缺少 'episode' 数组`);
                    }
                    return parsedChunk;
                });

                if (i === 0) {
                    // 存储第一次的基础信息
                    baseResult = {
                        name: resultChunk.name,
                        year: resultChunk.year,
                        type: resultChunk.type,
                        season: resultChunk.season // 存储季编号
                    };
                    allEpisodes.push(...resultChunk.episode);
                } else {
                    // 对于后续块，确保 episode 里的 name 和 season 与 baseResult 一致
                    const correctedEpisodes = resultChunk.episode.map(ep => ({
                        ...ep,
                        name: baseResult.name, // 强制使用基础名称
                        season: baseResult.season // 强制使用基础季编号
                    }));
                    allEpisodes.push(...correctedEpisodes);
                }
            }

            // 组合最终结果
            const finalResult = { ...baseResult, episode: allEpisodes };

            // 验证最终结果
            if (!this._validateResponse(finalResult)) {
                console.log("最终 AI 解析结果格式错误: " + JSON.stringify(finalResult, null, 2))
                throw new Error('最终 AI 返回格式不符合要求');
            }

            return {
                success: true,
                data: finalResult
            };

        } catch (error) {
            console.log(error)
            console.error("AI simpleChatCompletion 处理出错:", error.message);
            return {
                success: false,
                error: error.message || '处理文件名解析时发生未知错误'
            };
        }
    }

    async filterMediaFiles(resourceName, files, filterDescription) {
        if (!this.isEnabled()) {
            return { success: false, error: 'AI服务未配置或未启用' };
        }
        if (!filterDescription) {
            logTaskEvent('AI过滤：无过滤描述，跳过AI调用');
            return { success: false, error: '缺少过滤描述' };
        }
        if (!files || files.length === 0) {
            logTaskEvent('AI过滤：文件列表为空，无需过滤');
            return { success: true, data: [] }; // 返回空数组
        }

        const CHUNK_SIZE = 50; // 定义每次处理的文件数量 (根据需要调整)
        let allKeptFileIds = []; // 用于收集所有需要保留的文件 ID

        try {
            logTaskEvent(`AI过滤：开始处理 ${files.length} 个文件，分块大小 ${CHUNK_SIZE}`);
            for (let i = 0; i < files.length; i += CHUNK_SIZE) {
                const chunk = files.slice(i, i + CHUNK_SIZE);
                const chunkNumber = i / CHUNK_SIZE + 1;
                logTaskEvent(`AI过滤：处理块 ${chunkNumber}...`);

                const messages = [
                    {
                        role: 'system',
                        content: `你是一个智能文件筛选助手。你的任务是根据用户提供的中文自然语言描述，筛选一个影视剧文件列表，并只返回需要保留的文件的 ID。

                        输入:
                        1. resourceName: 媒体资源的名称 (例如：电影标题、剧集名称)。
                        2. files: 一个文件对象数组，每个对象包含 'id' 和 'name' 字段。
                        3. filterDescription: 一个中文字符串，描述了筛选规则。

                        **处理逻辑:**
                        1.  **理解规则:** 仔细分析 'filterDescription' 以确定筛选标准。规则可能涉及：
                            *   **文件名包含/不包含特定文本:** 例如 "包含 '特效'" 或 "不包含 '预告'"。
                            *   **剧集编号比较:** 例如 "剧集号大于 10", "集数小于等于 5"。
                        2.  **提取信息 (如果需要):**
                            *   对于涉及**剧集编号**的规则，你需要从每个文件的 'name' 字段中提取剧集编号。常见的剧集编号格式包括：
                                *   \`SxxExx\` (例如 \`S01E05\` -> 剧集号是 5)
                                *   \`第 xx 集\` (例如 \`第 12 集\` -> 剧集号是 12)
                                *   单独的数字，如果上下文清晰 (例如 \`Episode 03\` -> 剧集号是 3)
                            *   **优先识别 \`SxxExx\` 格式中的 \`Exx\` 部分。如果不存在，再尝试识别 \`第 xx 集\` 格式。** 提取出的剧集号应为**数字**。
                        3.  **应用规则:** 将提取的信息（或完整文件名）与 'filterDescription' 中的条件进行比较。
                            *   对于剧集编号比较，请进行**数值比较** (例如，判断 12 是否大于 3)。
                        4.  **筛选:** 保留所有满足 'filterDescription' 条件的文件。

                        输出:
                        返回一个 JSON 数组，其中只包含满足条件的原 'files' 数组中文件的 **ID 字符串**。

                        示例输入 1 (文本匹配):
                        resourceName: "我的剧集 第一季"
                        files: [
                          { "id": "file_1", "name": "我的剧集 S01E01.mkv" },
                          { "id": "file_2", "name": "我的剧集 S01E02.mkv" },
                          { "id": "file_3", "name": "我的剧集 S01E03.特效版.mkv" }
                        ]
                        filterDescription: "筛选出文件名不包含 '特效版' 的文件"
                        示例输出 1:
                        [
                          "file_1",
                          "file_2"
                        ]

                        示例输入 2 (剧集号比较):
                        resourceName: "君子无疾 (2025)"
                        files: [
                          { "id": "id_1", "name": "君子无疾 - S01E01 - 第 1 集.mp4" },
                          { "id": "id_2", "name": "君子无疾 - S01E02 - 第 2 集.mp4" },
                          { "id": "id_3", "name": "君子无疾 - S01E03 - 第 3 集.mp4" },
                          { "id": "id_4", "name": "君子无疾 - S01E04 - 第 4 集.mp4" }
                        ]
                        filterDescription: "筛选出 剧集 大于 2 的文件"
                        示例输出 2:
                        [
                          "id_3",
                          "id_4"
                        ]


                        指令:
                        - 严格遵循上述处理逻辑。
                        - 仅返回满足条件的文件的 **ID 字符串** 组成的 JSON 数组。
                        - 输出必须是有效的 JSON 数组格式，数组元素必须是字符串。
                        - 不要在输出中包含任何解释性文字或 Markdown 格式，只需返回纯粹的 JSON 数组。`
                    },
                    {
                        role: 'user',
                        content: `resourceName: "${resourceName}"\nfiles: ${JSON.stringify(chunk, null, 2)}\nfilterDescription: "${filterDescription}"`
                    }
                ];

                logTaskEvent(`AI过滤：调用AI处理块 ${chunkNumber}，描述: ${filterDescription}`);
                const resultChunk = await this._retryOperation(`AI过滤块 ${chunkNumber}`, async () => {
                    const response = await this.chat(messages, {
                        temperature: 0,
                        max_tokens: 2000 // 调整 max_tokens 以适应 ID 列表的输出
                    });
                    if (!response.success) {
                        logTaskEvent(`AI过滤：处理块 ${chunkNumber} 失败 - ${response.error}`);
                        throw new Error(`AI 调用失败 (块 ${chunkNumber}): ${response.error}`);
                    }

                    const cleanData = this._getCleanAIJsonText(response.data);
                    const parsedChunk = JSON.parse(cleanData);

                    if (!Array.isArray(parsedChunk) || !parsedChunk.every(id => typeof id === 'string' || typeof id === 'number')) {
                        logTaskEvent(`AI过滤：块 ${chunkNumber} 返回格式错误，期望得到 ID 字符串或数字数组。原始数据: ${response.data}`);
                        throw new Error(`AI 返回格式错误 (块 ${chunkNumber}): 期望得到 ID 字符串或数字数组`);
                    }

                    return parsedChunk;
                });

                logTaskEvent(`AI过滤：块 ${chunkNumber} 成功解析，得到 ${resultChunk.length} 个文件 ID。`);
                allKeptFileIds.push(...resultChunk); // 合并当前块的结果
            } // end for loop

            logTaskEvent(`AI过滤：所有块处理完成，总共保留 ${allKeptFileIds.length} 个文件 ID。`);
            // 注意：这里返回的是 ID 列表，而不是完整的文件对象列表
            // 在 task.js 中需要根据这个 ID 列表去过滤原始的 fileList
            return {
                success: true,
                data: allKeptFileIds
            };

        } catch (error) {
            // 捕获循环中或 chat 调用中的错误
            logTaskEvent(`AI过滤：处理过程中发生错误 - ${error.message}`);
            console.error("AI filterMediaFiles 处理出错:", error.message);
            return {
                success: false,
                error: error.message || '处理文件过滤时发生未知错误'
            };
        }
    }



    async streamChat(message, onChunk) {
        try {
            const openaiConfig = ConfigService.getConfigValue('openai')
            if (!this.isEnabled(openaiConfig)) {
                throw new Error('AI服务未配置或未启用');
            }
            const apiKey = openaiConfig?.apiKey;
            const baseURL = openaiConfig?.baseUrl || 'https://api.openai.com/v1';
            const model = openaiConfig?.model || 'gpt-3.5-turbo';

            await this._runWithFlowControl('AI流式聊天请求', async () => {
                const response = await got.post(`${baseURL}/chat/completions`, {
                    json: {
                        model,
                        messages: [
                            {
                                role: 'user',
                                content: message
                            }
                        ],
                        stream: true,
                        ...this.defaultConfig
                    },
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    responseType: 'text',
                    isStream: true
                });

                // 处理流式响应
                for await (const chunk of response) {
                    try {
                        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                        for (const line of lines) {
                            if (line.includes('[DONE]')) continue;
                            if (line.startsWith('data: ')) {
                                const data = JSON.parse(line.slice(5));
                                if (data.choices[0].delta?.content) {
                                    onChunk(data.choices[0].delta.content);
                                }
                            }
                        }
                    } catch (error) {
                        console.error('处理响应块时出错:', error);
                    }
                }
                // 所有块处理完成后，发送结束标识
                onChunk('[END]');
            }, openaiConfig);
        } catch (error) {
            console.error('AI 流式服务调用失败:', error.message);
            throw error;
        }
    }


    _validateResponse(result) {
        // 基础验证
        const baseValid = result.name &&
            typeof result.year === 'number' &&
            ['tv', 'movie'].includes(result.type) &&
            Array.isArray(result.episode);
        // 如果基础验证失败，直接返回 false
        if (!baseValid) return false;
        // 根据类型验证剧集信息
        return result.episode.every(ep => {
            return ep.id &&
                ep.extension?.startsWith('.') &&
                (result.type !== 'tv' || ep.episode);  // 只在 tv 类型时验证 episode
        });
    }

    _validateFolderResponse(result) {
        // 基础验证
        const baseValid = result.name &&
            typeof result.year === 'number' &&
            ['tv', 'movie'].includes(result.type);

        if (!baseValid) return false;

        // 如果存在 folders 才进行文件夹验证
        if (result.folders) {
            return Array.isArray(result.folders) && result.folders.every(folder =>
                folder.id &&
                folder.name
            );
        }

        return true;
    }
}

module.exports = new AIService();
