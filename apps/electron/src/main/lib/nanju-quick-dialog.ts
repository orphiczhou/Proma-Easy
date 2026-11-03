/**
 * 南大项目 quick 对话策略模块（W24-EF F2 v0.17.123，US-U02 纯函数）
 *
 * 单一职责：把 US-U02「快消型需求沟通」的确定性策略封装为纯函数。
 * - 不接 IPC / renderer / orchestrator / router / runner——这些交 I 集成子会话落补丁；
 * - 不依赖任何外部副作用/网络/文件系统；
 * - 提供「模糊检测」「3 轮模糊退出」「开始意图」「需求摘要」「你帮我决定」/「自动建议」标签；
 * - 「首轮 ≥3 问题」校验：纯结构校验，对候选问题数组起作用（与 nanju-router-prompt.ts
 *   的约束「3-5 个引导性问题」对应——F2 不替代模型行为，仅给出程序化断言）。
 *
 * 边界（与 EF.md §1 US-U02 表对齐）：
 * - 不实现对话行为本身——那些属 prompt 承载（F2 不在断言范围）；
 * - isVagueInput / isUserStartIntent 的关键词来自 US-U02 §2.2 + §2.4，可由 I 端在
 *   nanju-router-prompt.ts 中通过 buildVagueFallbackReply / 终止追问模板调用；
 * - 「你帮我决定」/「自动建议」标签固定常量，可被 US-U04 摘要共用（同字面值）。
 */

// ===== 标签常量（视图/构建/对话三方共享，防字符串漂移） =====

/** US-U02：「你帮我决定」字面值——卡片按钮 / 自动补完 prompt 共用 */
export const AUTO_DECIDE_LABEL = '你帮我决定'

/** US-U02/§3.2：「自动建议」字面值——需求摘要与提示词共用，用于标注自动填补的决策项 */
export const AUTO_SUGGEST_TAG = '自动建议'

// ===== 数值常量 =====

/** US-U02：首轮至少 3 个引导性问题 */
export const QUICK_CLARIFY_MIN_QUESTIONS = 3

/** US-U02：连续 3 轮极模糊 → 第 4 轮直接给通用版（触发直接产出/退出） */
export const QUICK_VAGUE_LOOP_LIMIT = 3

/** US-U02：每次回应最多 5 个引导性问题（PRD/约束） */
export const QUICK_CLARIFY_MAX_QUESTIONS = 5

// ===== 关键词表（可由 I 端 prompt 模板消费） =====

/**
 * US-U02：极模糊意图动词——输入命中这些动词时，才进一步判定其后宾语是否具体。
 * 仅当动词后无具体宾语（裸动词或泛化宾语）才判模糊；「做个记账工具」「做一个番茄钟」
 * 这类「动词 + 具体宾语」不判模糊（避免误杀明确需求）。
 */
const QUICK_DIALOG_VAGUE_VERBS: ReadonlyArray<string> = Object.freeze([
  '想做个', '做一个', '弄个', '搞个', '做个', '想做',
])

/** 泛化宾语——动词后跟这些词仍是模糊（不含具体对象语义） */
const QUICK_DIALOG_GENERIC_OBJECTS: ReadonlyArray<string> = Object.freeze([
  '软件', '工具', '东西', '程序', '应用', 'app', '网页',
])

/**
 * US-U02：「先做出来看看」「差不多了先开始吧」类终止沟通意图关键词。
 * 只保留完整/明确组合，去掉裸「差不多」「先做」「先看看」等易误停的过宽词。
 */
export const QUICK_DIALOG_START_KEYWORDS: ReadonlyArray<string> = Object.freeze([
  '先开始吧', '先做出来', '先开始', '开始吧', '直接开始', '开始开发',
  '开始实现', '直接开始吧', '先这样吧', '差不多了吧', '差不多就开始',
  '差不多就开', '帮我做出来', '可以开始', '直接做',
])

// ===== 候选问题结构校验（首轮 ≥3，纯结构断言） =====

export interface QuickClarifyQuestion {
  /** 问题文本（不含「数据库/前端/后端」等实现技术术语） */
  text: string
}

/** 禁用技术术语白名单——F2 仅以最小集合兜底（首轮问题「贴近场景」硬要求） */
const FORBIDDEN_TECH_TERMS: ReadonlyArray<string> = Object.freeze([
  '数据库', '前端', '后端', 'API', 'JSON', 'REST', 'schema',
])

/**
 * 校验问题列表是否满足「≥QUICK_CLARIFY_MIN_QUESTIONS」且不含技术术语。
 * 纯结构校验——F2 不替代模型行为，只为 I 端 prompt 注入时提供程序化断言。
 */
export function validateQuickClarifyQuestions(questions: ReadonlyArray<QuickClarifyQuestion | string>): {
  ok: boolean
  questionCount: number
  reason?: 'too-few' | 'tech-term'
} {
  const list = (questions ?? [])
    .map((q) => (typeof q === 'string' ? q : q?.text ?? ''))
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0)
  if (list.length < QUICK_CLARIFY_MIN_QUESTIONS) {
    return { ok: false, questionCount: list.length, reason: 'too-few' }
  }
  for (const q of list) {
    for (const term of FORBIDDEN_TECH_TERMS) {
      if (q.includes(term)) {
        return { ok: false, questionCount: list.length, reason: 'tech-term' }
      }
    }
  }
  return { ok: true, questionCount: list.length }
}

// ===== 模糊检测 / 退出 =====

/**
 * 判定输入是否极模糊（含「想做个」类意图词但无具体场景/对象）。
 * - 不判定模型生成；仅基于字符串匹配 + 长度阈值；
 * - 字数 < 6 一律视为模糊（覆盖「想做个软件」「弄个工具」类极短输入）。
 */
export function isVagueInput(text: string): boolean {
  const t = String(text ?? '').trim()
  if (t.length === 0) return true
  // 命中意图动词 → 判定其后宾语是否具体
  for (const verb of QUICK_DIALOG_VAGUE_VERBS) {
    const idx = t.indexOf(verb)
    if (idx < 0) continue
    const rest = t.slice(idx + verb.length).trim()
    if (rest.length === 0) return true // 裸「做个」/「想做」
    const lower = rest.toLowerCase()
    for (const g of QUICK_DIALOG_GENERIC_OBJECTS) {
      // 泛化宾语（「做个软件」「帮我做个东西」）仍是模糊
      if (lower === g || lower.startsWith(g)) return true
    }
    return false // 「做个记账工具」「做一个番茄钟」→ 具体宾语 → 明确
  }
  // 无意图动词：仅过短输入（<4 字，如「帮我」「嗯」）判模糊，其余交给对话继续追问
  return t.length < 4
}

export interface QuickClarifyTurn {
  /** 用户原始输入（已 trim） */
  userText: string
  /** 本轮自动填补的决策项（如「界面风格 = 现代极简」）——供摘要「自动建议」标注 */
  autoFilledDecisions: string[]
}

/**
 * 是否应停止追问。
 *
 * 契约（重要）：turns 包含当前轮（数组最后一项 = 本轮用户输入）。
 * - 用户开始意图：任意轮（含当前）isUserStartIntent=true → 立即停止；
 * - 模糊退出：US-U02「连续 3 轮极模糊 → 第 4 轮仍模糊直接给通用版」——
 *   当前轮模糊，且此前连续 3 轮（第 1–3 轮）也模糊，即共 4 轮全模糊 → 停止。
 *   不满 4 轮不退出（防 off-by-one 早停）。
 */
export function shouldStopProbing(turns: ReadonlyArray<QuickClarifyTurn>): boolean {
  const list = turns ?? []
  if (list.length === 0) return false
  // 1) 用户开始意图优先（任意轮命中即终止）
  for (const t of list) {
    if (isUserStartIntent(t.userText)) return true
  }
  // 2) 模糊退出：第 4 轮仍模糊才退出
  const current = list[list.length - 1]!
  if (!isVagueInput(current.userText)) return false // 当前轮明确 → 不退出
  if (list.length < QUICK_VAGUE_LOOP_LIMIT + 1) return false // 未满 4 轮
  const prevRounds = list.slice(-(QUICK_VAGUE_LOOP_LIMIT + 1), -1) // 当前轮之前的 3 轮
  return prevRounds.every((t) => isVagueInput(t.userText))
}

// ===== 用户「开始开发」意图 =====

/**
 * 是否用户主动要求开始——典型话术「差不多了先开始吧」「先做出来看看」。
 * - 与 shouldStopProbing 共用同一关键词表；
 * - 区分模糊退出：本判定要求用户**主动**说开始意图（关键词更严格，含动词起始），
 *   模糊退出则是「既没要求开始、又是模糊」的累计行为。
 */
export function isUserStartIntent(text: string): boolean {
  const t = String(text ?? '').trim()
  if (t.length === 0) return false
  // 疑问/反问句排除（「先做什么呢」「要不要开始？」不是终止沟通意图）
  if (/[?？吗呢么]$/.test(t)) return false
  for (const kw of QUICK_DIALOG_START_KEYWORDS) {
    if (t.includes(kw)) return true
  }
  return false
}

// ===== 需求摘要（PRD §3.2 固定结构模板） =====

export interface RequirementSummaryInput {
  /** 一句话总结（不超过 80 字；F2 不校验长度由调用方负责） */
  oneLine: string
  /** 「具体包括」清单 */
  included: ReadonlyArray<string>
  /** 「不包括」清单（用于约束范围，避免 AI 越界） */
  excluded: ReadonlyArray<string>
}

/**
 * 构建需求摘要——PRD §3.2「我理解你想做的是…具体包括…不包括…」固定结构。
 * - 自动决策：included 中每项若来自 autoFilled 列表，自动追加「[自动建议]」标注；
 * - excluded 不论来源一律不带标注（不含歧义）；
 * - 输出纯文本，I 端可直接拼入 prompt 注入。
 */
export function buildRequirementSummary(
  input: RequirementSummaryInput,
  autoFilled: ReadonlyArray<string> = [],
): string {
  const lines: string[] = []
  lines.push(`我理解你想做的是：${String(input.oneLine ?? '').trim() || '（未给出）'}`)
  const autoSet = new Set((autoFilled ?? []).map((s) => String(s ?? '').trim()).filter((s) => s.length > 0))
  if (input.included.length > 0) {
    lines.push('具体包括：')
    for (const item of input.included) {
      const t = String(item ?? '').trim()
      if (!t) continue
      lines.push(autoSet.has(t) ? `- ${t}（${AUTO_SUGGEST_TAG}）` : `- ${t}`)
    }
  } else {
    lines.push('具体包括：（尚未明确）')
  }
  if (input.excluded.length > 0) {
    lines.push('不包括：')
    for (const item of input.excluded) {
      const t = String(item ?? '').trim()
      if (!t) continue
      lines.push(`- ${t}`)
    }
  } else {
    lines.push('不包括：（暂未排除）')
  }
  return lines.join('\n')
}

// ===== 极模糊回复模板 =====

/**
 * 极模糊输入的回复模板——含四个方向卡片标签，提示用户「具体方向」。
 * - 输出严格文本（无卡片 UI），含中文方向标签；
 * - 不做模型调用；I 端可直接拼入 prompt。
 */
export function buildVagueFallbackReply(): string {
  return [
    '好的！能多说一点吗？',
    '为帮你更快起步，下面几个方向挑一个最接近的：',
    '1. 「实用小工具」——比如记账、清单、计算器',
    '2. 「内容整理」——比如读书笔记、收藏、清单',
    '3. 「可视化展示」——比如数据看板、对比表',
    '4. ' + AUTO_DECIDE_LABEL + '——我先按通用版开工',
  ].join('\n')
}

/** US-U02「循环退出」逐字回复（连续 3 轮模糊后第 4 轮仍模糊时） */
export function buildVagueLoopExitReply(): string {
  return '好的，我先根据你目前说的做一个通用版本，后面再根据你的反馈调整。如果有什么特别想要的功能，随时告诉我。'
}