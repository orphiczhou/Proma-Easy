/**
 * v2.4「自动补完需求」代理工具（D7 §4：nanju_clarify_proxy 全链）
 *
 * 职责（L1 侧注册，快消型 + autoClarify 开启时）：
 * - 子会话澄清：L1 传 delegationId + blockedEventIds → 类别门（D8 §九 B′：auto on 时
 *   requirement-clarify / design-preference 组进代理——design-preference 走「代决」准则
 *   （kind:'decision'，保守/维持现状/可逆性优先）；other/未知 fail-closed → fallback。
 *   auto off 维持 D7：仅 requirement-clarify 进代理，design-preference/other → fallback:'human'）
 * - 自身需求补充：L1 传 questions=[{id,question,options?}]（每题 ≤200 字、≤5 题）
 * - 代理委派：inline:true + 最小 meta{nanjuProxy:true}（不写 sourceDelegationId）+
 *   allowSubDelegation:false；渠道解析：硬≠提问方（渠道家族）+ 软避开本阶段 AC 攻/防，
 *   无解时 diversityDegraded:true；代理渠道固定（shouldSkipFallbackChainForDelegation）
 * - 预算：proxyBudget（cap=20/项目，getProjectAutoClarify 唯一读写点）耗尽 → fallback（R7-01：
 *   auto on（入口 enabled）→ 'auto-degrade'——L1 登记 pendingQuestionIds+继续工作+skipped 标记，
 *   不得转述真人（auto 用户不在场，'human' 横幅=死锁）；auto off → 'human' 逐字节不变）
 * - 熔断：代答「无法判断」累计 3 次（同组一次不重复，按 _nanju-clarify-log.jsonl 计数）→ fallback（同上分叉）
 * - 回注：L2 blocked 答案经既有 askUserService.respondToAskUser 通道注入（与
 *   answer_delegation_question 同链路），并广播 ask_user_resolved
 * - 溯源：项目目录 _nanju-clarify-log.jsonl（qid/问题/答案/渠道/耗时/去向/来源标签）+
 *   clarify.* 五事件遥测；答案确认词命中仅作标记——代答永不构成 I1 授权（非 humanOrigin）
 *
 * 安全边界（D7 §0/§1 I3）：
 * - 类别门由 main 按 phase.role 固定映射赋值（BlockedEvent.category，本文件
 *   deriveBlockedEventCategory），L2 无写入载体、不可自报；未知/缺失 fail-closed 为非 clarify
 * - 设计偏好（design-preference）永不被代理——硬边界
 * - 确认门禁与设计偏好交互永远真人：代理答案的确认词命中只标记不授权
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NANJU_AUTO_CLARIFY_BUDGET_CAP,
  getNanjuProjectDir,
  getProjectAutoClarify,
  isConfirmAdvanceText,
  listNanjuProjects,
  updateProjectAutoClarify,
  type NanjuProject,
} from './nanju-project'
import { channelFamily, getPhaseNode, resolveACActors, type PhaseId } from './nanju-router'
import { recordTelemetry } from './nanju-telemetry'
import { assertEnabledModelForChannel } from './agent-model-selection'
import {
  answerBlockedEventFromProxy,
  getBlockedEventsForClarifyProxy,
  getNanjuProxyDelegationInternals,
  listRunningNanjuProxyDelegations,
  startNanjuProxyDelegation,
} from './agent-collaboration-tools'

// ===== 常量（D7 §4/§6） =====

export const NANJU_CLARIFY_PROXY_TOOL_NAME = 'nanju_clarify_proxy'

/** L1 自问每题字符上限（D7 §4） */
export const CLARIFY_QUESTION_CHAR_LIMIT = 200
/** L1 自问每次最多题数（D7 §4） */
export const CLARIFY_MAX_QUESTIONS = 5
/** 预算上限（与 NANJU_GUARDS.autoClarifyBudgetCap 同源；只读引用，消费走唯一写入点） */
export const CLARIFY_PROXY_BUDGET_CAP = NANJU_AUTO_CLARIFY_BUDGET_CAP
/** 「无法判断」熔断阈值：累计 3 次后一律 fallback:'human'（同组一次不重复） */
export const CLARIFY_CANNOT_JUDGE_BREAK = 3
/** 「无法判断」类答案识别词（设计原文词 + 就近变体，保守取小表防误伤） */
const CANNOT_JUDGE_MARKERS: readonly string[] = ['无法判断', '无法确定']
/** 工具内等待代理委派的上限（软 5min/硬 10min 独立时钟之外的工具侧兑底：观察哨硬停
 *  在 10min 触发 completion 兜底；此处 11min 兜住轮询间隔滞后与极端场景） */
export const CLARIFY_PROXY_WAIT_MS = 11 * 60 * 1000
/** 代理答案每条字符上限（入参校验侧；超长截断入日志） */
const CLARIFY_ANSWER_CHAR_LIMIT = 300

/** 类别门三态（D7 §4；BlockedEvent.category 同构） */
export type NanjuClarifyCategory = 'requirement-clarify' | 'design-preference' | 'other'

/**
 * phase.role → category 固定映射表（D7 §4/D6 收口 R6-01，覆盖全部六个角色）。
 * 需求分析师/architect → requirement-clarify；ux-advisor（原型类）→ design-preference；
 * 其余 → other。未知/缺失 fail-closed 为 other（非 clarify）。
 */
export const PHASE_ROLE_CATEGORY_MAP: Readonly<Record<string, NanjuClarifyCategory>> = Object.freeze({
  'requirement-analyst': 'requirement-clarify',
  architect: 'requirement-clarify',
  'ux-advisor': 'design-preference',
  'engineering-manager': 'other',
  'fullstack-developer': 'other',
  'test-engineer': 'other',
})

/** 委派任务模板的显式角色标记（供 main 从 task 文本取 phase.role；router-prompt 侧同步携带） */
export const PHASE_ROLE_MARKER_RE = /(?:^|\n)[ \t]*(?:phase\.role|阶段角色)[ \t]*[:：][ \t]*([a-zA-Z][a-zA-Z-]*)/g

/** 中文阶段头衔前缀（buildL2TaskWithAC 模板以「你是<title>。」起头；匹配锚定模板开头） */
const PHASE_TITLE_PREFIXES: ReadonlyArray<{ title: string; category: NanjuClarifyCategory }> = [
  { title: '需求分析师', category: 'requirement-clarify' },
  { title: '架构师', category: 'requirement-clarify' },
  { title: 'UX 顾问', category: 'design-preference' },
  { title: 'UX顾问', category: 'design-preference' },
]

/** 代理渠道候选池（偏好序：快模型优先；minimax 是家族标记，运行时校验不通过自动跳过） */
export const PROXY_CHANNEL_CANDIDATES: ReadonlyArray<{ channelId: string; modelId: string }> = Object.freeze([
  { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
  { channelId: 'deepseek', modelId: 'deepseek-flash' },
  { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },
  { channelId: 'glm-zhipu', modelId: 'GLM-5.3' },
  { channelId: 'minimax', modelId: 'MiniMax-M3' },
])

// ===== 类别门：委派 → category 派生（main 构造 BlockedEvent 时调用；L2 无自报载体） =====

/**
 * 从委派任务文本派生类别（main 按 phase.role 固定映射；fail-closed）。
 * 优先级：显式 phase.role 标记 > 英文角色字面量（词边界） > 中文阶段头衔前缀（模板开头）。
 * 多类别信号并存（歧义）→ other（fail-closed，宁可转述真人不误代理）。
 */
export function deriveBlockedEventCategory(taskText: string | undefined, title?: string): NanjuClarifyCategory {
  const text = `${taskText ?? ''}\n${title ?? ''}`
  if (!text.trim()) return 'other'

  const signals = new Set<NanjuClarifyCategory>()

  // ① 显式 phase.role 标记（router-prompt 委派任务模板携带；唯一权威信号）
  for (const match of text.matchAll(PHASE_ROLE_MARKER_RE)) {
    const role = (match[1] ?? '').toLowerCase()
    signals.add(PHASE_ROLE_CATEGORY_MAP[role] ?? 'other')
  }

  // ② 英文角色字面量（词边界：architect 不误命中 architecture）
  for (const role of Object.keys(PHASE_ROLE_CATEGORY_MAP)) {
    const re = new RegExp(`\\b${role.replace(/-/g, '\\-')}\\b`, 'i')
    if (re.test(text)) signals.add(PHASE_ROLE_CATEGORY_MAP[role]!)
  }

  // ③ 中文阶段头衔（锚定任务模板开头的「你是<title>」形态，避免正文中引用误命中）
  const head = (taskText ?? '').trimStart().slice(0, 20)
  for (const prefix of PHASE_TITLE_PREFIXES) {
    if (head.startsWith(`你是${prefix.title}`)) signals.add(prefix.category)
  }

  // fail-closed：无信号 / 信号歧义（clarify 与非 clarify 并存）→ other
  if (signals.has('requirement-clarify') && signals.size === 1) return 'requirement-clarify'
  if (signals.has('design-preference') && signals.size === 1) return 'design-preference'
  return 'other'
}

// ===== 渠道解析（纯函数；硬≠提问方家族 + 软避开 AC 攻/防家族） =====

export interface ProxyChannelResolution {
  channelId: string
  modelId: string
  /** true = 硬约束满足但软约束（AC 避让）无解（D7 §4 diversityDegraded） */
  diversityDegraded: boolean
}

/**
 * 解析代理渠道。硬约束：候选家族 ≠ 提问方家族；软约束：候选家族 ∉ AC 攻/防家族。
 * 无硬约束解 → undefined（调用方 fallback:'human'，reason:'no-channel'）。
 * 端点校验注入（assertEnabledModelForChannel）：不可用候选按序跳过。
 */
export function resolveProxyChannel(input: {
  askerChannelId: string
  acChannelIds: readonly string[]
  candidates?: ReadonlyArray<{ channelId: string; modelId: string }>
  validateEndpoint?: (endpoint: { channelId: string; modelId: string }) => boolean
}): ProxyChannelResolution | undefined {
  const candidates = input.candidates ?? PROXY_CHANNEL_CANDIDATES
  const askerFamily = channelFamily(input.askerChannelId)
  const acFamilies = new Set(input.acChannelIds.map((c) => channelFamily(c)))

  let firstHardPass: { channelId: string; modelId: string } | undefined
  for (const candidate of candidates) {
    if (channelFamily(candidate.channelId) === askerFamily) continue // 硬：≠提问方
    const validate = input.validateEndpoint ?? (() => true)
    if (!validate(candidate)) continue
    if (!acFamilies.has(channelFamily(candidate.channelId))) {
      return { ...candidate, diversityDegraded: false } // 软约束满足：最优解
    }
    firstHardPass ??= candidate
  }
  // 硬约束满足但 AC 家族避让无解 → 降级可用（diversityDegraded:true）
  return firstHardPass ? { ...firstHardPass, diversityDegraded: true } : undefined
}

// ===== L1 自问入参校验（纯函数） =====

export interface ClarifyQuestionInput {
  id: string
  question: string
  options?: Array<{ label: string; description?: string }>
}

/** questions 校验：非空数组、≤5 题、每题 {id,question,options?} 结构、每题 ≤200 字符 */
export function validateClarifyQuestions(raw: unknown): { questions: ClarifyQuestionInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'questions 必须是非空数组' }
  if (raw.length > CLARIFY_MAX_QUESTIONS) return { error: `questions 最多 ${CLARIFY_MAX_QUESTIONS} 题（收到 ${raw.length} 题）` }
  const questions: ClarifyQuestionInput[] = []
  const seenIds = new Set<string>()
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') return { error: `questions[${index}] 必须是对象` }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const question = typeof record.question === 'string' ? record.question.trim() : ''
    if (!id) return { error: `questions[${index}].id 不能为空` }
    if (seenIds.has(id)) return { error: `questions[${index}].id 重复: ${id}` }
    seenIds.add(id)
    if (!question) return { error: `questions[${index}].question 不能为空` }
    if (question.length > CLARIFY_QUESTION_CHAR_LIMIT) {
      return { error: `questions[${index}].question 超过 ${CLARIFY_QUESTION_CHAR_LIMIT} 字符（当前 ${question.length}）` }
    }
    let options: ClarifyQuestionInput['options']
    if (record.options !== undefined) {
      if (!Array.isArray(record.options)) return { error: `questions[${index}].options 必须是数组` }
      const parsed: Array<{ label: string; description?: string }> = []
      for (const [optIndex, opt] of (record.options as unknown[]).entries()) {
        if (!opt || typeof opt !== 'object') return { error: `questions[${index}].options[${optIndex}] 必须是对象` }
        const optRecord = opt as Record<string, unknown>
        if (typeof optRecord.label !== 'string' || !optRecord.label.trim()) {
          return { error: `questions[${index}].options[${optIndex}].label 必须是非空字符串` }
        }
        parsed.push({
          label: optRecord.label.trim(),
          description: typeof optRecord.description === 'string' ? optRecord.description : undefined,
        })
      }
      options = parsed
    }
    questions.push({ id, question, options })
  }
  return { questions }
}

// ===== 溯源日志（项目目录 _nanju-clarify-log.jsonl；渲染端代答卡片数据源） =====
// 注：代理会话判定（isNanjuProxySession）不在本模块——router-gate 首分支按持久
// meta.nanjuProxy 判定（单一真相源；本模块只负责创建时写该标记）。

export interface ClarifyLogLine {
  /**
   * 行类型（R2′ F3-1/2 统一，对齐 C 域 v0.17.102 parseClarifyLogLine 融合契约）：
   * 'proxy-answer'=代答完成行 / 'decision'=代决完成行（R7-10 区分，取代该行的
   * 'proxy-answer' 值）/ 'proxy-delegate'=代理委派登记 / 'fallback' / 'cannot-judge'。
   * C 域判据：kind∈{proxy-answer,decision} 才生成卡片，isDecision = kind==='decision'。
   */
  kind: 'proxy-answer' | 'proxy-delegate' | 'fallback' | 'cannot-judge' | 'decision'
  qid?: string
  /** 来源标签：subagent=L2 子会话提问 / l1=L1 自问（渲染端卡片「子会话提问·代理作答」等） */
  source?: 'subagent' | 'l1'
  channel?: string
  question?: string
  answer?: string
  durationMs?: number
  reason?: string
  /** fallback 出口值（R7-01：'auto-degrade' | 'human'） */
  fallback?: 'auto-degrade' | 'human'
  /** 类别门拦截时的组内类别清单（取证用） */
  categories?: string[]
  stage?: string
  projectId: string
  /** number 时间戳（渲染端卡片 ts 字段；兼容 at ISO 字符串写入方） */
  ts?: number
  at?: string
}

function getClarifyLogPath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '_nanju-clarify-log.jsonl')
}

/** 追加一行溯源日志（IO 失败不阻断工具主流程，仅告警） */
function appendClarifyLog(workspaceSlug: string, projectId: string, line: ClarifyLogLine): void {
  try {
    const dir = getNanjuProjectDir(workspaceSlug, projectId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(
      getClarifyLogPath(workspaceSlug, projectId),
      JSON.stringify({ ...line, at: line.at ?? new Date().toISOString() }) + '\n',
      'utf-8',
    )
  } catch (err) {
    console.warn('[nanju-clarify] 溯源日志写入失败（不阻断主流程）:', err instanceof Error ? err.message : err)
  }
}

/** 读全部日志行（预算/熔断计数与关闭处置的数据源；坏行跳过） */
export function readClarifyLog(workspaceSlug: string, projectId: string): ClarifyLogLine[] {
  const path = getClarifyLogPath(workspaceSlug, projectId)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as ClarifyLogLine
        } catch {
          return null
        }
      })
      .filter((line): line is ClarifyLogLine => line !== null)
  } catch {
    return []
  }
}

/** 「无法判断」累计次数（同组一次：proxy-answer 组行 kind='cannot-judge' 每组至多一行） */
export function countCannotJudge(workspaceSlug: string, projectId: string): number {
  return readClarifyLog(workspaceSlug, projectId).filter((line) => line.kind === 'cannot-judge').length
}

// ===== 工具结果形态 =====

export interface ClarifyProxyOk {
  status: 'answered'
  answers: Array<{ id: string; question: string; answer: string }>
  channel: string
  elapsedMs: number
  diversityDegraded?: boolean
  /** 答案确认词命中布尔（仅标记：代答非 humanOrigin，永不构成 I1 授权） */
  confirmWordHit: boolean
  /** 代答/代决区分（R7-10）：answer=requirement-clarify；decision=design-preference 代决 */
  kind: 'answer' | 'decision'
}

export interface ClarifyProxyFallback {
  status: 'fallback'
  /**
   * 出口语义（D8 §九 B′ / R7-01）：
   * - 'human'：转述真人（auto off 全套；或类别门 non-clarify 拒绝——other/未知不代不决）
   * - 'auto-degrade'：确定性降级（auto on 下四条无应答方路径：处理中被关/预算尽/熔断/无通道）
   *   ——L1 契约：登记 pendingQuestionIds + 继续本阶段工作 + 产出附 skipped 标记，不得转述真人
   */
  fallback: 'human' | 'auto-degrade'
  reason:
    | 'non-clarify-category' // 类别门：组内含 design-preference/other/未知
    | 'auto-clarify-disabled' // 项目未开启（含关闭/升级失效）
    | 'budget-exhausted' // 预算 cap=20 耗尽
    | 'cannot-judge-circuit' // 「无法判断」累计 3 次熔断
    | 'no-channel' // 渠道解析无解（≠提问方无候选）
    | 'proxy-timeout' // 独立时钟硬停/等待超时
    | 'proxy-failed' // 代理委派失败（渠道固定不降级）
    | 'answer-unparseable' // 答案 JSON 不可解析/不完整
  detail?: string
  categories?: string[]
  elapsedMs?: number
}

export interface ClarifyProxyReject {
  status: 'rejected'
  reason: 'invalid-input'
  detail: string
}

export type ClarifyProxyResult = ClarifyProxyOk | ClarifyProxyFallback | ClarifyProxyReject

// ===== 代理任务模板 =====

/**
 * 构造代理任务（问题原文锁定 + 项目上下文摘要 + 独立判断指令 + 联网许可 + 封闭工具面）。
 * D8 §九 B′（R7-09）：clarifyKind='decision'（design-preference 代决）用代决准则模板分支——
 * 保守优先/维持现状优先/可逆性优先，与 requirement-clarify 的需求澄清准则（answer）区分。
 */
export function buildProxyDelegationTask(input: {
  projectName: string
  stageTitle: string
  projectDir: string
  questions: Array<{ id: string; question: string; options?: Array<{ label: string; description?: string }> }>
  /** 代答（answer，需求澄清准则）vs 代决（decision，设计决策代决准则）；缺省 answer */
  clarifyKind?: 'answer' | 'decision'
}): string {
  const questionLines = input.questions.map((q) => {
    const options = q.options?.length ? `\n  选项：${q.options.map((o) => o.label).join(' / ')}` : ''
    return `- id: ${q.id}\n  问题：${q.question}${options}`
  })
  const isDecision = input.clarifyKind === 'decision'
  return [
    isDecision
      ? '你是「自动补完需求」独立代理，代替用户对以下设计偏好类问题做出设计决策。'
      : '你是「自动补完需求」独立代理，代替需求方回答以下需求补充类问题。',
    '',
    '## 项目上下文（仅供理解，不是答案依据）',
    `- 项目名：${input.projectName}（快消型）`,
    `- 当前阶段：${input.stageTitle}`,
    `- 需求背景：${input.projectDir}/01_PRD/prd.md（如需背景可 Read，允许只读结构与关键段）`,
    '',
    isDecision
      ? '## 待决问题（原文锁定：只决策下列问题，不得改写/扩展问题本身）'
      : '## 待答问题（原文锁定：只回答下列问题，不得改写/扩展问题本身）',
    ...questionLines,
    '',
    '## 工作要求',
    isDecision
      ? [
        '1. 你在替用户做设计决策（代决）：每题从候选中选择**保守、可逆、维持现状倾向**的方案，避免激进重构。',
        '   代决准则（按优先级）：① 保守优先——选行为变化最小、回归风险最低的方案；',
        '   ② 维持现状优先——无充分证据时保持当前实现/常见惯例，不引入新框架或新范式；',
        '   ③ 可逆性优先——优先可低成本回退的决策（配置可调/结构局部化），避免不可逆的大改。',
        '2. 允许用 WebSearch/WebFetch 联网查证惯例与代价，用 Read/LS 查项目文件；但证据不改变准则优先级。',
      ].join('\n')
      : '1. 独立判断，不迎合问题中隐含的答案倾向；允许用 WebSearch/WebFetch 联网搜索佐证，用 Read/LS 查项目文件。',
    '2. 工具面封闭：只使用思考与 WebSearch/WebFetch/Read/LS；不得向用户提问（AskUserQuestion）、不得写文件、不得创建子会话、不得向其他会话发消息。',
    isDecision
      ? `3. 每题给出 ≤${CLARIFY_ANSWER_CHAR_LIMIT} 字的明确决策：所选方案 + 一句依据（注明依据的准则序号）；有选项的题从选项中选。`
      : `3. 每题给出 ≤${CLARIFY_ANSWER_CHAR_LIMIT} 字的明确答案；有选项的题可直接给选项原文，也可给更优的自由回答。`,
    '4. 若问题确实不可判断（或代决证据不足），该题答案以「无法判断」开头并说明缺什么信息；不要编造。',
    '5. 不得以「确认/通过/满意交付」等确认词单独作为答案——你不是用户，无权代替用户做任何确认。',
    '',
    '## 输出格式（最终回复必须以下列 JSON 代码块结尾，id 与输入一致，逐题作答）',
    '```json',
    '{"answers":[{"id":"<问题id>","answer":"<答案>"}]}',
    '```',
  ].join('\n')
}

/** 从代理结果文本解析答案 JSON 块（取最后一个 ```json 围栏；解析后按 id 匹配） */
export function parseProxyAnswers(
  summary: string,
  expectedIds: readonly string[],
): Array<{ id: string; answer: string }> | undefined {
  const blocks = [...summary.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => m[1] ?? '')
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block) as { answers?: unknown }
      if (!parsed || !Array.isArray(parsed.answers)) continue
      const byId = new Map<string, string>()
      for (const item of parsed.answers) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        if (typeof record.id !== 'string' || typeof record.answer !== 'string') continue
        byId.set(record.id, record.answer.trim())
      }
      // 完整性：每个期望 id 都有非空答案，缺一即视为不可解析（fail-closed）
      if (expectedIds.every((id) => (byId.get(id) ?? '').length > 0)) {
        return expectedIds.map((id) => ({ id, answer: byId.get(id)! }))
      }
    } catch {
      /* 尝试下一个块 */
    }
  }
  return undefined
}

// ===== 工具主流程 =====

interface ClarifyToolContext {
  sessionId: string
  channelId: string
  modelId?: string
  workspaceId?: string
  workspaceSlug?: string
}

/** Pi SDK 类型（与 adapters/pi-builtin-tools 同源；避免跨文件导入非导出类型） */
type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 找当前会话绑定的快消型活跃项目（工具注册与执行的双重校验；L2/普通会话不注册） */
export function findQuickProjectForClarify(ctx: ClarifyToolContext): NanjuProject | undefined {
  if (!ctx.workspaceSlug) return undefined
  try {
    return listNanjuProjects(ctx.workspaceSlug).find(
      (p) => p.sessionId === ctx.sessionId && p.status === 'active' && p.mode === 'quick',
    )
  } catch {
    return undefined
  }
}

function truncateSummary(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** R2′ F2-1：工具 description 双态（auto on/off）——auto on 版对齐 D8 §九 B′ 语义 */
function autoDescribeTool(autoOn: boolean): string {
  const usage = '两种用法：① 子会话澄清——传 delegationId + blockedEventIds（子会话 pendingBlockedEvents 的 id）；② 自身需求补充——传 questions=[{id,question,options?}]（每题≤200字，≤5题）。'
  if (autoOn) {
    return '需求补充/设计偏好类问题的独立模型代理作答与代决（可联网；本项目已开启自动审核）。'
      + usage
      + '设计偏好类问题由代理按代决准则（保守优先/维持现状优先/可逆性优先）代决。确认类问题禁止使用本工具（确认由系统机器事实自动处理，环境安装除外）。'
      + '返回 fallback:"auto-degrade" 时按 auto 协议处理：用保守自判经 answer_delegation_question 回注解除 blocked 悬空；无法给出保守答案则 stop_delegation 终止并在产出记录 <!-- auto-clarify:skipped,terminated,ts --> 标记；不得转述真人、不得弹横幅。'
  }
  return '需求补充类问题的独立模型代理作答（可联网）。'
    + usage
    + '确认类/设计偏好类问题禁止使用本工具（类别门 fail-closed 会返回 fallback）。返回 fallback:"human" 时按协议转述真人（设计偏好用「设计」header，其余用「转述」header）。'
}

/**
 * 构造 nanju_clarify_proxy 工具定义。
 * 注册条件（D7 §4）：quick + autoClarify.enabled + 项目活跃绑定当前会话；
 * 不满足返回 null（动态注册参照 harness 工具可见性控制模式——非 L1 会话零可见）。
 */
export function buildNanjuClarifyProxyTool(
  sdk: PiSdk,
  ctx: ClarifyToolContext,
): ReturnType<PiSdk['defineTool']> | null {
  const project = findQuickProjectForClarify(ctx)
  if (!project) return null
  // 注册门含开启校验（D7 §4：quick + autoClarify 开启；关闭/升级即失效零可见。
  // 执行侧再校验一道——运行中关闭/升级时工具已注册但 fail-closed 转述真人）
  const registryAutoOn = getProjectAutoClarify(ctx.workspaceSlug ?? '', project.projectId)?.enabled === true
  if (!registryAutoOn) return null
  const autoOn = registryAutoOn
  const { Type } = require('typebox') as typeof import('typebox')

  const toolDef = sdk.defineTool({
    name: NANJU_CLARIFY_PROXY_TOOL_NAME,
    label: '自动补完需求（代理作答）',
    // R2′ F2-1：description 按 auto 开关动态生成——auto on（代决含 design-preference、
    // fallback=auto-degrade 语义、解除动作指向保守回注/stop）；off 保持 D7 原文（转述真人）
    description: autoDescribeTool(autoOn),
    parameters: Type.Object({
      delegationId: Type.Optional(Type.String({ description: '子会话澄清模式：提问委派的 ID' })),
      blockedEventIds: Type.Optional(Type.Array(Type.String(), { description: '子会话澄清模式：待代答的阻塞事件 ID 列表' })),
      questions: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: '问题唯一 id（回注对齐用）' }),
        question: Type.String({ description: '问题原文（≤200 字符）' }),
        options: Type.Optional(Type.Array(Type.Object({
          label: Type.String({ description: '选项文案' }),
          description: Type.Optional(Type.String({ description: '选项说明' })),
        }))),
      }), { description: '自身需求补充问题（≤5 题）' })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const args = params as {
        delegationId?: string
        blockedEventIds?: string[]
        questions?: unknown
      }
      const result = await executeClarifyProxy(ctx, args)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      }
    },
  })
  return toolDef
}

/** 工具执行主链（纯逻辑编排；异常一律收敛为 fallback/rejected，不向 harness 抛错） */
async function executeClarifyProxy(
  ctx: ClarifyToolContext,
  args: { delegationId?: string; blockedEventIds?: string[]; questions?: unknown },
): Promise<ClarifyProxyResult> {
  const workspaceSlug = ctx.workspaceSlug ?? ''
  const project = findQuickProjectForClarify(ctx)
  if (!project) return fallbackHuman('auto-clarify-disabled', '当前会话未绑定快消型活跃项目')
  const projectId = project.projectId
  const startedAt = Date.now()

  // —— 开关核验（关闭/升级即失效，D7 §0）——
  const autoClarify = getProjectAutoClarify(workspaceSlug, projectId)
  if (!autoClarify?.enabled) {
    // auto off 入口拒绝（注册后执行前关闭/未开启）：D7 行为逐字节不变（R7-01 的 auto off 基线）
    recordTelemetry(workspaceSlug, 'clarify.relay-human', {
      project_id: projectId, reason: 'auto-clarify-disabled', summary: 'autoClarify 未开启，转述真人',
    }, projectId)
    return fallbackHuman('auto-clarify-disabled', '项目未开启自动补完需求（或已关闭/升级失效）')
  }
  /** auto on 判定锚点（D8 §九 B′/R7-01）：以本次调用入口状态为准——运行中被关属 auto on 降级 */
  const autoOn = true

  // —— 模式与入参校验 ——
  const hasBlockedMode = args.delegationId !== undefined || args.blockedEventIds !== undefined
  const hasQuestionsMode = args.questions !== undefined
  if (hasBlockedMode === hasQuestionsMode) {
    return rejectInput('二选一：传 delegationId+blockedEventIds（子会话澄清）或 questions（自身需求补充），不可并存或全缺')
  }

  let mode: 'subagent' | 'l1'
  let askerChannelId: string
  let stageIdForLog: string
  /** 代答/代决区分（R7-10）：answer=requirement-clarify；decision=design-preference 代决 */
  let clarifyKind: 'answer' | 'decision'
  let questions: Array<{ id: string; question: string; options?: Array<{ label: string; description?: string }> }>
  let blockedRefs: Array<{ id: string; requestId: string | undefined; questionsByQid: Array<{ qid: string; question: string }> }> = []

  if (hasQuestionsMode) {
    const validated = validateClarifyQuestions(args.questions)
    if ('error' in validated) {
      recordTelemetry(workspaceSlug, 'clarify.guard-deny', {
        project_id: projectId, reason: 'invalid-questions', summary: truncateSummary(validated.error),
      }, projectId)
      return rejectInput(validated.error)
    }
    mode = 'l1'
    questions = validated.questions
    askerChannelId = ctx.channelId
    stageIdForLog = project.currentStage
    clarifyKind = 'answer'
  } else {
    mode = 'subagent'
    const delegationId = (args.delegationId ?? '').trim()
    const blockedEventIds = args.blockedEventIds ?? []
    if (!delegationId) return rejectInput('子会话澄清模式需要 delegationId')
    if (!Array.isArray(blockedEventIds) || blockedEventIds.length === 0) {
      return rejectInput('子会话澄清模式需要非空 blockedEventIds')
    }
    const internals = getNanjuProxyDelegationInternals(ctx.sessionId, delegationId)
    if (!internals) {
      return rejectInput(`未找到当前会话下的委派: ${delegationId}（提问委派须由当前会话创建）`)
    }
    askerChannelId = internals.channelId // 硬≠提问方：main 内部直查 delegations map
    stageIdForLog = project.currentStage

    // —— 类别门（D7 §4 + D8 §九 B′/R7-09：L2 自报无效，main 赋值类别判定）——
    const events = getBlockedEventsForClarifyProxy(delegationId, blockedEventIds)
    const missing = blockedEventIds.filter((id) => !events.some((e) => e.id === id))
    if (missing.length > 0) {
      return rejectInput(`阻塞事件不存在或不属于该委派: ${missing.join(', ')}`)
    }
    const resolved = events.filter((e) => e.resolved)
    if (resolved.length > 0) {
      return rejectInput(`阻塞事件已被解决: ${resolved.map((e) => e.id).join(', ')}`)
    }
    // D8 类别门矩阵（B′）：auto on 允许组 ⊆ {requirement-clarify, design-preference} 进代理
    //（design-preference → 代决 kind:'decision'；混合组统一代决准则——保守侧）；auto off 仅
    // requirement-clarify（D7 fail-closed 不变）。other/未知在两种模式下都不进（不代答不代决）。
    const allowed = autoOn
      ? events.every((e) => e.category === 'requirement-clarify' || e.category === 'design-preference')
      : events.every((e) => e.category === 'requirement-clarify')
    if (!allowed) {
      const categories = events.map((e) => e.category ?? 'unknown')
      // R2′ F2-2：auto on 统一 auto-degrade（不转述真人——L1 按契约保守自判回注或
      // stop+terminated 解除悬空，见 F1-2 L1 契约）；auto off 维持转述真人
      const fallback = autoOn ? 'auto-degrade' : 'human'
      appendClarifyLog(workspaceSlug, projectId, {
        kind: 'fallback', reason: 'non-clarify-category', fallback, categories, stage: stageIdForLog, projectId,
      })
      if (autoOn) {
        recordTelemetry(workspaceSlug, 'clarify.auto-degrade', {
          project_id: projectId, reason: 'non-clarify-category', fallback, categories,
          summary: truncateSummary(`类别门拦截（${categories.join(',')}），自动降级：保守自判回注或终止`),
        }, projectId)
      } else {
        recordTelemetry(workspaceSlug, 'clarify.relay-human', {
          project_id: projectId, reason: 'non-clarify-category', categories,
          summary: `类别门拦截（${categories.join(',')}），转述真人`, derivedCategories: categories,
        }, projectId)
      }
      return {
        status: 'fallback', fallback, reason: 'non-clarify-category',
        detail: autoOn
          ? '组内含不可代理类别（其他/未知）：按 auto-degrade 契约以保守自判回注解除悬空，或 stop_delegation 终止并在产出记录 skipped 标记'
          : '组内含不可代理类别（其他/未知），按协议转述真人',
        categories, elapsedMs: Date.now() - startedAt,
      }
    }
    /** 代决判定（R7-09/R7-10）：组内含 design-preference → kind='decision'（代决准则） */
    clarifyKind = events.some((e) => e.category === 'design-preference') ? 'decision' : 'answer'

    // 展开 blocked 问题（qid = `${blockedEventId}#${index}`；答案按问题原文键回注）
    questions = []
    blockedRefs = []
    for (const event of events) {
      const questionsByQid: Array<{ qid: string; question: string }> = []
      const askQuestions = event.questions ?? []
      if (askQuestions.length === 0) {
        return rejectInput(`阻塞事件 ${event.id} 无可代答问题`)
      }
      askQuestions.forEach((q, index) => {
        const qid = `${event.id}#${index}`
        questionsByQid.push({ qid, question: q.question })
        questions.push({
          id: qid,
          question: q.question,
          options: q.options?.map((o) => ({ label: o.label, description: o.description })),
        })
      })
      blockedRefs.push({ id: event.id, requestId: event.askUserRequestId, questionsByQid })
    }
    if (questions.length > CLARIFY_MAX_QUESTIONS * 2) {
      return rejectInput(`单次代答问题过多（${questions.length} 题），请分批`)
    }
  }

  // —— 登记待回注问题 id（R7-01 提前：四条确定性降级路径也要登记——auto-degrade 的 L1 契约
  //     是「登记 pendingQuestionIds + 继续本阶段工作 + 产出附 skipped 标记，不得转述真人」；
  //     关闭处置/用户重开 auto 后可据此转述或追答。回注/运行终态后清除）——
  const pendingQids = questions.map((q) => q.id)
  updateProjectAutoClarify(workspaceSlug, projectId, {
    pendingQuestionIds: Array.from(new Set([...(getProjectAutoClarify(workspaceSlug, projectId)?.pendingQuestionIds ?? []), ...pendingQids])),
  })

  // —— 预算（cap=20/项目；唯一写入点 updateProjectAutoClarify 递减；R7-01 四条降级路径之一）——
  const budgetState = getProjectAutoClarify(workspaceSlug, projectId)
  if (!budgetState?.enabled) {
    // 入口 auto on、运行中被关：D8 B′ 归入 auto-degrade（登记 pending 后继续；关闭处置会转述存量）
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'auto-clarify-disabled', detail: 'autoClarify 已在处理过程中被关闭', stage: stageIdForLog })
  }
  if (budgetState.proxyBudget <= 0) {
    recordTelemetry(workspaceSlug, 'clarify.budget-exhausted', {
      project_id: projectId,
      fallback: autoOn ? 'auto-degrade' : 'human',
      summary: autoOn
        ? `代理预算耗尽（cap=${CLARIFY_PROXY_BUDGET_CAP}），自动降级继续工作`
        : `代理预算耗尽（cap=${CLARIFY_PROXY_BUDGET_CAP}），转述真人`,
    }, projectId)
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'budget-exhausted', detail: `代理预算已耗尽（cap=${CLARIFY_PROXY_BUDGET_CAP}/项目）`, stage: stageIdForLog })
  }

  // —— 「无法判断」熔断（累计 3 次，同组一次不重复；R7-01 四条降级路径之一）——
  if (countCannotJudge(workspaceSlug, projectId) >= CLARIFY_CANNOT_JUDGE_BREAK) {
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'cannot-judge-circuit', detail: `代答「无法判断」累计 ${CLARIFY_CANNOT_JUDGE_BREAK} 次，已熔断`, stage: stageIdForLog })
  }

  // —— 渠道解析（硬≠提问方；软避开本阶段 AC 攻/防；代理渠道固定不降级）——
  const phaseNode = getPhaseNode(project.mode, project.currentStage as PhaseId)
  let acChannelIds: string[] = []
  try {
    const actors = phaseNode ? resolveACActors(phaseNode) : null
    acChannelIds = actors ? [actors.attacker.channel, actors.defender.channel] : []
  } catch { /* AC 解析失败不阻断：软约束退化为无避让（diversityDegraded 由硬约束单独判定） */ }

  const endpointOk = (endpoint: { channelId: string; modelId: string }): boolean => {
    try {
      assertEnabledModelForChannel({ channelId: endpoint.channelId, modelId: endpoint.modelId, purpose: 'clarify 代理渠道校验' })
      return true
    } catch {
      return false
    }
  }
  const channelResolution = resolveProxyChannel({ askerChannelId, acChannelIds, validateEndpoint: endpointOk })
  if (!channelResolution) {
    // R7-01 四条降级路径之一（无通道）
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'no-channel', detail: `无可与提问方（${askerChannelId}）异族的已启用代理渠道`, stage: stageIdForLog })
  }

  // —— 消费预算（委派创建前扣减；失败不退还——代理调用已发生）——
  updateProjectAutoClarify(workspaceSlug, projectId, { proxyBudget: budgetState.proxyBudget - 1 })

  // —— 生成代理委派（inline + 最小 meta{nanjuProxy:true} + allowSubDelegation:false + 渠道固定；
  //     R7-09：clarifyKind 分支模板——decision 用代决准则）——
  const stageTitle = phaseNode?.title ?? project.currentStage
  const task = buildProxyDelegationTask({
    projectName: project.name,
    stageTitle,
    projectDir: getNanjuProjectDir(workspaceSlug, projectId),
    questions,
    clarifyKind,
  })
  let internals
  try {
    internals = startNanjuProxyDelegation(
      {
        sessionId: ctx.sessionId,
        channelId: ctx.channelId,
        modelId: ctx.modelId,
        workspaceId: ctx.workspaceId,
        workspaceSlug: ctx.workspaceSlug,
      },
      {
        channelId: channelResolution.channelId,
        modelId: channelResolution.modelId,
        task,
        title: `自动补完需求·代答（${mode === 'subagent' ? '子会话提问' : 'L1 提问'}）`,
      },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'proxy-failed', detail: `代理委派创建失败: ${detail}`, stage: stageIdForLog })
  }
  recordTelemetry(workspaceSlug, 'clarify.proxy-delegate', {
    project_id: projectId,
    channel: channelResolution.channelId,
    model_id: channelResolution.modelId,
    diversityDegraded: channelResolution.diversityDegraded,
    asker_channel: askerChannelId,
    question_count: questions.length,
    source: mode,
    kind: clarifyKind,
    summary: truncateSummary(`代理${clarifyKind === 'decision' ? '代决' : '代答'} ${questions.length} 题（${mode === 'subagent' ? '子会话' : 'L1'}提问，渠道 ${channelResolution.channelId}）`),
  }, projectId)
  appendClarifyLog(workspaceSlug, projectId, {
    kind: 'proxy-delegate', channel: channelResolution.channelId, stage: stageIdForLog, projectId,
    reason: mode, qid: pendingQids.join(','),
  })

  // —— 等待完成（独立时钟之外的工具侧兜底；观察哨 10min 硬停会让 completion 兑底）——
  let waitResult: 'completed' | 'timeout'
  try {
    waitResult = await Promise.race([
      internals.completion.then(() => 'completed' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CLARIFY_PROXY_WAIT_MS)),
    ])
  } catch {
    waitResult = 'timeout'
  }
  const settled = getNanjuProxyDelegationInternals(ctx.sessionId, internals.delegationId)
  const elapsedMs = Date.now() - startedAt

  if (waitResult === 'timeout' || settled?.status !== 'completed') {
    // 兜底：等待超时但委派仍在运行 → 强停（不留孤儿代理）
    const { forceStopDelegation } = require('./agent-collaboration-tools') as typeof import('./agent-collaboration-tools')
    if (settled?.status === 'running') forceStopDelegation(ctx.sessionId, internals.delegationId)
    const reason = waitResult === 'timeout' ? 'proxy-timeout' : 'proxy-failed'
    const detail = settled ? `代理委派终态: ${settled.status}` : '代理委派记录已丢失'
    clearPendingQids(workspaceSlug, projectId, pendingQids)
    // R2′ F2-2：运行终态失败也统一 auto-degrade（auto on）；auto off → human
    return fallbackDegrade({
      workspaceSlug, projectId, autoOn,
      reason: reason === 'proxy-timeout' ? 'proxy-timeout' : 'proxy-failed',
      detail: `${detail}（等待 ${Math.round(elapsedMs / 1000)}s）`, stage: stageIdForLog,
    })
  }

  // —— 答案解析（fail-closed：JSON 块缺失/不完整 → 转述真人）——
  const expectedIds = questions.map((q) => q.id)
  const parsed = settled?.resultSummary ? parseProxyAnswers(settled.resultSummary, expectedIds) : undefined
  if (!parsed) {
    clearPendingQids(workspaceSlug, projectId, pendingQids)
    return fallbackDegrade({ workspaceSlug, projectId, autoOn, reason: 'answer-unparseable', detail: '代理回复未包含可解析的完整答案 JSON 块', stage: stageIdForLog })
  }

  const answers = parsed.map((a) => ({
    id: a.id,
    question: questions.find((q) => q.id === a.id)?.question ?? a.id,
    answer: a.answer.length > CLARIFY_ANSWER_CHAR_LIMIT * 2 ? a.answer.slice(0, CLARIFY_ANSWER_CHAR_LIMIT * 2) : a.answer,
  }))
  const confirmWordHit = answers.some((a) => isConfirmAdvanceText(a.answer))
  const cannotJudge = answers.some((a) => CANNOT_JUDGE_MARKERS.some((m) => a.answer.includes(m)))

  // —— 日志 + 遥测（每题一行 proxy-answer；R7-10：clarifyKind 区分代答/代决；
  //     「无法判断」组行一次不重复）——
  for (const a of answers) {
    appendClarifyLog(workspaceSlug, projectId, {
      kind: clarifyKind === 'decision' ? 'decision' : 'proxy-answer', qid: a.id, source: mode, channel: channelResolution.channelId,
      question: truncateSummary(a.question, 200), answer: truncateSummary(a.answer, 400),
      durationMs: elapsedMs, stage: stageIdForLog, projectId, ts: Date.now(),
    })
  }
  if (cannotJudge) {
    appendClarifyLog(workspaceSlug, projectId, {
      kind: 'cannot-judge', qid: answers.find((a) => CANNOT_JUDGE_MARKERS.some((m) => a.answer.includes(m)))?.id,
      stage: stageIdForLog, projectId,
    })
  }
  recordTelemetry(workspaceSlug, 'clarify.proxy-answer', {
    project_id: projectId,
    channel: channelResolution.channelId,
    source: mode,
    kind: clarifyKind,
    question_count: answers.length,
    cannot_judge: cannotJudge,
    confirm_word_hit: confirmWordHit,
    diversity_degraded: channelResolution.diversityDegraded,
    duration_ms: elapsedMs,
    summary: truncateSummary(`代理${clarifyKind === 'decision' ? '代决' : '代答'}完成 ${answers.length} 题（渠道 ${channelResolution.channelId}${cannotJudge ? '，含无法判断' : ''}）`),
  }, projectId)

  // —— 回注：L2 来源经既有 answer_delegation_question 通道（askUserService + ask_user_resolved 广播）——
  if (mode === 'subagent') {
    for (const ref of blockedRefs) {
      const answersMap: Record<string, string> = {}
      for (const { qid, question } of ref.questionsByQid) {
        const answer = answers.find((a) => a.id === qid)?.answer
        if (answer !== undefined) answersMap[question] = answer
      }
      try {
        answerBlockedEventFromProxy(ctx.sessionId, ref.id, answersMap)
      } catch (err) {
        console.warn('[nanju-clarify] 回注失败（答案仍返回 L1，可人工补答）:', err instanceof Error ? err.message : err)
      }
    }
  }
  clearPendingQids(workspaceSlug, projectId, pendingQids)

  // R2′ F3-2：代答/代决完成 → nanju:clarify-event 事件流（C 域渲染消费；card 字段统一
  // kind（answer|decision），与 NanjuClarifyAnswerCard.kind 同名——经变量注入结构类型
  // 兼容，A 域接口如需类型化可后续补）
  broadcastClarifyCardEvent(workspaceSlug, projectId, 'proxy-answer', {
    qid: answers[0]?.id ?? '',
    sourceLabel: mode === 'subagent'
      ? (clarifyKind === 'decision' ? '子会话提问·代理代决' : '子会话提问·代理作答')
      : (clarifyKind === 'decision' ? 'L1 提问·代理代决' : 'L1 提问·代理作答'),
    channel: channelResolution.channelId,
    questionSummary: truncateSummary(answers[0]?.question ?? '', 80),
    answerSummary: truncateSummary(answers[0]?.answer ?? '', 120),
    durationMs: elapsedMs,
    ts: Date.now(),
    stage: stageIdForLog,
    kind: clarifyKind,
  })

  return {
    status: 'answered',
    answers,
    channel: `${channelResolution.channelId}:${channelResolution.modelId}`,
    elapsedMs,
    ...(channelResolution.diversityDegraded ? { diversityDegraded: true } : {}),
    confirmWordHit,
    kind: clarifyKind,
  }
}

/**
 * R7-10：clarify 事件流广播（nanju-ipc 的 broadcastNanjuClarifyEvent——注释明示「代理工具域
 * 调用入口」）。card 附 clarifyKind（answer|decision）供渲染端区分代答/代决展示；
 * main window 不可用/require 失败（测试环境 electron 缺位）静默丢弃——轮询兑底。
 */
function broadcastClarifyCardEvent(
  workspaceSlug: string,
  projectId: string,
  type: 'proxy-answer' | 'fallback-human',
  card: Record<string, unknown>,
): void {
  try {
    const { broadcastNanjuClarifyEvent } = require('./nanju-ipc') as typeof import('./nanju-ipc')
    broadcastNanjuClarifyEvent({ workspaceSlug, projectId, type, card: card as never, ts: Date.now() })
  } catch { /* 事件流失败不影响主链（渲染端轮询兜底） */ }
}

/** 清除已处置的待回注问题 id（保持 pendingQuestionIds 只含 in-flight） */
function clearPendingQids(workspaceSlug: string, projectId: string, qids: string[]): void {
  try {
    const current = getProjectAutoClarify(workspaceSlug, projectId)
    if (!current) return
    const remain = current.pendingQuestionIds.filter((id) => !qids.includes(id))
    if (remain.length !== current.pendingQuestionIds.length) {
      updateProjectAutoClarify(workspaceSlug, projectId, { pendingQuestionIds: remain })
    }
  } catch { /* 清理失败不影响主流程 */ }
}

/** 构造 fallback 出参（R7-01：auto on 四条无应答方路径 → 'auto-degrade'；其余 'human'） */
function fallbackOf(
  fallback: ClarifyProxyFallback['fallback'],
  reason: ClarifyProxyFallback['reason'],
  detail?: string,
  extra?: { categories?: string[]; elapsedMs?: number },
): ClarifyProxyFallback {
  return { status: 'fallback', fallback, reason, detail, ...extra }
}

function fallbackHuman(reason: ClarifyProxyFallback['reason'], detail?: string): ClarifyProxyFallback {
  return fallbackOf('human', reason, detail)
}

/**
 * R7-01 四条确定性降级路径的统一出口：返回值按 autoOn 分叉（'auto-degrade' | 'human'），
 * 日志行与遥测带上 fallback 值——auto on 发 clarify.auto-degrade（L1 契约：登记 pending +
 * 继续工作 + skipped 标记，不得转述真人），auto off 维持 clarify.relay-human。
 */
function fallbackDegrade(input: {
  workspaceSlug: string
  projectId: string
  autoOn: boolean
  reason: ClarifyProxyFallback['reason']
  detail: string
  stage: string
}): ClarifyProxyFallback {
  const fallback = input.autoOn ? 'auto-degrade' : 'human'
  appendClarifyLog(input.workspaceSlug, input.projectId, {
    kind: 'fallback', reason: input.reason, fallback, stage: input.stage, projectId: input.projectId,
  })
  if (input.autoOn) {
    recordTelemetry(input.workspaceSlug, 'clarify.auto-degrade', {
      project_id: input.projectId, reason: input.reason, fallback,
      summary: truncateSummary(`自动降级（${input.reason}）：登记待办后继续工作，不转述真人`),
    }, input.projectId)
  } else {
    recordTelemetry(input.workspaceSlug, 'clarify.relay-human', {
      project_id: input.projectId, reason: input.reason, summary: truncateSummary(input.detail),
    }, input.projectId)
  }
  return fallbackOf(fallback, input.reason, input.detail)
}

function rejectInput(detail: string): ClarifyProxyReject {
  return { status: 'rejected', reason: 'invalid-input', detail }
}

/** 列出运行中的代理委派 id（关闭/升级 in-flight 处置的数据源，D7 §7） */
export function listRunningClarifyProxyDelegations(parentSessionId: string): string[] {
  return listRunningNanjuProxyDelegations(parentSessionId)
}
