export const meta = {
  name: 'optimize-audit-cloud189',
  description: '全库优化审计：16维度并行查找优化点 → 对抗式验证过滤误报 → 综合优先级报告',
  phases: [
    { title: 'Analyze', detail: '16个子系统/维度并行查找优化机会' },
    { title: 'Verify', detail: '对每条高/中优先级发现做对抗式验证' },
    { title: 'Synthesize', detail: '去重、排序，产出可执行的优先级报告' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'category', 'severity', 'file', 'lines', 'evidence', 'recommendation', 'effort', 'confidence'],
        properties: {
          title: { type: 'string', description: '一句话标题(中文)' },
          category: { type: 'string', enum: ['performance', 'correctness', 'simplification', 'deadcode', 'architecture', 'security', 'dx', 'dependency'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file: { type: 'string', description: '主文件路径' },
          lines: { type: 'string', description: '行号范围，如 120-145' },
          evidence: { type: 'string', description: '具体代码证据+为什么是问题(中文，引用关键代码片段)' },
          recommendation: { type: 'string', description: '具体改法(中文)' },
          effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['isReal', 'reasoning', 'adjustedSeverity'],
  properties: {
    isReal: { type: 'boolean', description: '该发现是否真实成立且值得修' },
    reasoning: { type: 'string', description: '为什么成立/不成立(中文)，必须重新核对实际代码' },
    adjustedSeverity: { type: 'string', enum: ['high', 'medium', 'low', 'invalid'] },
    fixSketch: { type: 'string', description: '若成立，给出更精确的修复要点(中文)' },
  },
}

const COMMON = `你是资深 Node.js/React 性能与架构审计专家。仔细阅读指定文件的真实代码（用 Read，必要时 Grep 交叉验证），找出确实值得优化的点。
要求：
- 只报真实、有代码证据的问题；不要泛泛而谈、不要臆测。每条 evidence 必须引用具体代码片段和行号。
- 关注：真实性能瓶颈(N+1查询/全表扫描/缺索引/阻塞I/O/重复网络请求/热路径延迟/无谓的全量重算)、可安全删除的死代码、可显著简化的重复逻辑、明显的正确性隐患(竞态/未await/内存泄漏/未释放资源)、安全问题。
- 不要把"加注释""改风格""加类型"这类琐碎项当成发现。聚焦有实际收益的优化。
- 每个发现给出 severity(对系统的实际影响) + effort(改动成本) + confidence(你的把握)。
- 最多报 7 条，按价值排序，宁缺毋滥。这是一个无单测的生产项目，改动需谨慎，recommendation 要可落地。`

const TARGETS = [
  { key: 'task-perf', label: 'task.js-性能', prompt: `${COMMON}\n\n审计范围：src/services/task.js (3270行，转存核心)。重点找性能瓶颈：分享解析/目录扫描/增量比对/追更逻辑里的 N+1、重复请求云盘API、同步阻塞、不必要的全量扫描、循环内 await 串行化、未缓存的重复计算。` },
  { key: 'task-simplify', label: 'task.js-简化', prompt: `${COMMON}\n\n审计范围：src/services/task.js (3270行)。重点找：重复/可提取的逻辑、死代码、过度复杂可拆分的巨型函数、可合并的分支、冗余的中间变量与数据结构。` },
  { key: 'index-endpoints', label: 'index.js-端点', prompt: `${COMMON}\n\n审计范围：src/index.js (3222行，~128个REST端点)。重点找：重复的请求处理样板可抽公共中间件、缺失的输入校验、重复的 try/catch、同步阻塞操作、可并行化的串行 await、错误处理不一致、可能的鉴权遗漏。` },
  { key: 'cloud189-sdk', label: 'cloud189调用', prompt: `${COMMON}\n\n审计范围：src/services/cloud189.js (932行) 及其被调用方式。重点找：实例缓存策略问题、重复登录/token刷新、请求重试与退避缺失或过度、可批量化的逐个请求、代理使用开销。` },
  { key: 'subscription', label: '订阅', prompt: `${COMMON}\n\n审计范围：src/services/subscription.js (1250行) + src/services/listSubscription.js。重点找：轮询/巡检里的重复全量拉取、N+1、可增量化的全量比对、串行可并行的网络请求。` },
  { key: 'cas', label: 'CAS体系', prompt: `${COMMON}\n\n审计范围：src/services/casService.js (1133行) + casFileService/casMonitorService/casPlaybackService/casCleanupService/casMetadataCache。重点找：秒传哈希计算开销、缓存命中率问题、监控轮询频率、文件遍历效率、热路径(播放)延迟。` },
  { key: 'lazystrm-hot', label: '懒STRM热路径', prompt: `${COMMON}\n\n审计范围：src/services/lazyShareStrm.js (1021行) + src/services/streamProxy.js。这是用户点播时的实时热路径，延迟最敏感。重点找：可缓存却每次重算、串行可并行、阻塞I/O、重复云盘API调用、可提前预热的环节。` },
  { key: 'emby', label: 'Emby反代', prompt: `${COMMON}\n\n审计范围：src/services/emby.js (910行) + src/services/embyPrewarm.js。重点找：反代转发开销、刷库通知重复触发、预热逻辑的无效请求、WebSocket处理、stream pipe 效率。` },
  { key: 'pt', label: 'PT订阅', prompt: `${COMMON}\n\n审计范围：src/services/ptService.js (886行) + ptSource.js (840行) + ptUtils.js + ptRename.js + src/services/downloader/。重点找：RSS轮询重复解析、qB交互串行化、可缓存的种子元数据、正则/字符串处理开销。` },
  { key: 'strm', label: 'STRM生成', prompt: `${COMMON}\n\n审计范围：src/services/strm.js (789行) + src/services/strmConfig.js。重点找：.strm 文件生成/刷新的批量I/O效率、逐文件同步写、重复的路径规则计算、全量重建而非增量。` },
  { key: 'db', label: '数据层', prompt: `${COMMON}\n\n审计范围：src/entities/index.ts (885行) + src/database/index.js + 跨服务的 TypeORM 查询用法(用Grep找 .find/.findOne/.save/.createQueryBuilder)。重点找：缺失索引导致的慢查询、N+1(循环里查DB)、应批量的逐条 save、SELECT全字段、未用事务的批量写、relation 加载过度。指出具体哪条查询缺哪个索引。` },
  { key: 'scheduler', label: '调度CPU', prompt: `${COMMON}\n\n审计范围：src/services/scheduler.js + 全库 cron.schedule 用法(Grep) + 各内置定时job。重点找：过于频繁的轮询导致CPU占用、job重复注册/泄漏、可合并的多个定时任务、空转扫描、绕过 SchedulerService 的直接 cron.schedule。` },
  { key: 'frontend', label: '前端', prompt: `${COMMON}\n\n审计范围：frontend/src/ 下的大型 tab 组件(SubscriptionTab 1682行/SettingsTab 1523/PtTab 1357/PosterWallTab 1258/MediaTab/TaskTab/App.tsx)。重点找：缺失 memo/useMemo/useCallback 导致的重复渲染、轮询过于频繁或未清理的 setInterval、整列表无虚拟化、重复请求、巨型组件可拆分、useEffect 依赖问题导致的重复请求。` },
  { key: 'build-deps', label: '构建依赖', prompt: `${COMMON}\n\n审计范围：package.json + frontend/package.json + tsconfig + Dockerfile + scripts/。重点找：未使用的依赖、可移除的重型依赖、过期/有更优替代的包(如 got@11.8.2 老旧)、Docker 镜像分层与体积优化、构建步骤冗余、缺少 .dockerignore 项。同时确认 src/public_bak/ (约3500行) 是否确为无引用死代码可整目录删除——用 Grep 验证。` },
  { key: 'scrape-ai', label: '刮削/AI', prompt: `${COMMON}\n\n审计范围：src/services/ai.js (629行) + tmdb.js + douban.js + ScrapeService.js + src/services/tmdb 缓存。重点找：重复的第三方API调用未缓存、可批量的逐个刮削、AI prompt 过大、缺失速率限制导致被封、TmdbCache 命中策略问题。` },
  { key: 'security', label: '安全', prompt: `${COMMON}\n\n审计范围：跨全库的安全面——鉴权中间件(src/index.js authenticateSession 附近)、白名单、PasswordCrypto/hashPassword、proxy 处理、Emby反代、stream端点、SQL/命令拼接、SSRF、日志泄露敏感信息(129处console)。重点找真实可利用或会泄露凭据的问题，不要报理论风险。` },
]

phase('Analyze')
log(`并行铺开 ${TARGETS.length} 个维度的优化审计…`)

const results = await pipeline(
  TARGETS,
  // stage 1: 查找
  (t) => agent(t.prompt, { label: `find:${t.key}`, phase: 'Analyze', schema: FINDINGS_SCHEMA })
    .then((r) => ({ key: t.key, label: t.label, findings: (r && r.findings) || [] })),
  // stage 2: 对高/中优先级发现做对抗式验证(low直接保留并标注未验证)
  (res) => {
    const toVerify = res.findings.filter((f) => f.severity === 'high' || f.severity === 'medium')
    const lows = res.findings.filter((f) => f.severity === 'low').map((f) => ({ ...f, verdict: { isReal: true, reasoning: '低优先级，未单独验证', adjustedSeverity: 'low' } }))
    return parallel(
      toVerify.map((f) => () =>
        agent(
          `对抗式验证下面这条"优化建议"是否真实成立。你要带着怀疑去核对真实代码（Read 指定文件与行号，Grep 交叉验证调用方），尽量推翻它。若证据不足、问题不存在、或修复弊大于利，则判为 isReal=false。\n\n` +
          `文件: ${f.file}\n行号: ${f.lines}\n类别: ${f.category}\n标题: ${f.title}\n证据声称: ${f.evidence}\n建议改法: ${f.recommendation}`,
          { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT_SCHEMA }
        ).then((v) => ({ ...f, verdict: v }))
      )
    ).then((verified) => ({ key: res.key, label: res.label, items: [...verified.filter(Boolean), ...lows] }))
  }
)

phase('Synthesize')
const confirmed = results
  .filter(Boolean)
  .flatMap((r) => (r.items || []))
  .filter((f) => f.verdict && f.verdict.isReal && f.verdict.adjustedSeverity !== 'invalid')
  .map((f) => ({
    title: f.title, category: f.category,
    severity: (f.verdict && f.verdict.adjustedSeverity) || f.severity,
    file: f.file, lines: f.lines, evidence: f.evidence,
    recommendation: (f.verdict && f.verdict.fixSketch) || f.recommendation,
    effort: f.effort, confidence: f.confidence,
  }))

const rejectedCount = results.filter(Boolean).flatMap((r) => r.items || []).length - confirmed.length
log(`验证完成：确认 ${confirmed.length} 条，过滤误报/低价值 ${rejectedCount} 条`)

const report = await agent(
  `你是技术负责人。下面是对"天翼云盘自动转存系统"(Node.js Express单体 + React)做的全库优化审计、并经对抗式验证后确认的发现清单(JSON)。请综合成一份给开发者的可执行优化报告(中文 Markdown)。\n\n` +
  `要求：\n` +
  `1. 开头给"执行摘要"：3-5句概括最值得做的优化方向。\n` +
  `2. "快速见效(Quick Wins)"：列出 effort=trivial/small 且收益明显的项，每项一行(文件:行号 — 做什么 — 收益)。\n` +
  `3. "高价值改造"：按 severity=high 优先，分组(性能/架构/安全/死代码等)，每条含：问题、证据(文件:行号)、改法、预估收益与成本。\n` +
  `4. 合并重复或相关的发现，去重。\n` +
  `5. 结尾给一个"建议执行顺序"的有序清单(从低风险高收益开始)。\n` +
  `6. 务实、具体、可落地，引用真实文件行号。不要客套话。\n\n` +
  `确认发现清单：\n${JSON.stringify(confirmed, null, 2)}`,
  { label: 'synthesize-report', phase: 'Synthesize' }
)

return { confirmedCount: confirmed.length, rejectedCount, report }