/**
 * W8 委派守卫（三层程序化强制）——纯函数 + 常量
 *
 * 背景：dev-test-report-20260903 §五 P1-C——router-gate 白名单只约束 L1 自身工具，
 * delegate_agent 在一切阶段白名单内，不校验委派角色与 currentStage 匹配；
 * L1 可完全绕过阶段序列（requirements 直委全栈/测试，mini 项目被「直接做」诱导绕过管线）。
 *
 * 三层强制：
 * - 层一：委派角色-阶段匹配校验（本模块 checkDelegationAgainstStage）
 * - 层二：AC 委派模型程序化覆写（本模块 detectACRole / resolveACOverride）
 * - 层三：产出路径阶段约束注入（本模块 injectStagePathConstraint）
 *
 * 设计原则：W18（v0.17.81）起为严格序——AC 纯审计意图最先裁决（审计动词且无强动词），
 * 其后他阶段词扫描先于本阶段词（合法交叉表述误拦成本经用户裁决接受，
 * coPresentStageKeyword 埋点观察）；W18.1（v0.17.83）在③前加下游 OUTPUT 守卫
 * （强动词+下游阶段产出物词并存→deny，闭合引用词掩护绕过）；两类都不命中
 * （辅助类：查资料/分析等）且无强动词时也放行并记录 telemetry（pass-unmatched）
 * 供观察 unmatched 放行面；详见 checkDelegationAgainstStage 的判定顺序注释。
 *
 * 匹配文本：delegate_agent 的 title + task 字段（参数结构调研结论：任务字段名是
 * task 而非 prompt；role 是 explore/research/implement/review/custom 枚举，语义过泛，
 * 不纳入匹配文本）。中文词用 includes，英文词用 \b 词边界（防 'ac' 误命中
 * 'trace'/'space'、'test' 误命中 'latest'）。
 */

import type { NanjuGuardStage } from './nanju-project'
import type { ProjectMode } from './nanju-project'
import { AC_PRESETS, type ACActorConfig } from './nanju-router'

// ===== 层一：阶段角色词表 =====

/**
 * 各阶段允许的委派角色关键词（宽松包含匹配，中文 includes / 英文 \b 词边界，大小写不敏感）。
 * W18.1（A2 修复）：planning 移除裸「工程」——「工程师」是中文标准职称后缀
 * （测试工程师/全栈开发工程师等），子串碰撞在② 他阶段扫描先于③ 的严格序下
 * 把职称误判为 planning 委派（含 testing 阶段自身标题被拒）；换精确词后 planning
 * 典型委派仍命中（「规划/计划/工程计划/里程碑」等，见 STAGE_TITLES.planning 校准）。
 * W18.1（A2 探针）：architecture 的「环境」收紧为「环境配置」——「配置开发环境」
 * （语序相反，不含连续子串「环境配置」）在 coding 阶段被误拦；「环境配置」
 * 仍是 architecture 文档常用语，本阶段匹配不受削弱。
 */
export const STAGE_ROLE_KEYWORDS: Record<NanjuGuardStage, readonly string[]> = {
  requirements: ['需求', 'PRD', 'analyst', 'requirements'],
  prototype: ['UX', '原型', 'prototype', '视觉', '界面'],
  architecture: ['架构', 'architect', '环境配置', '技术'],
  planning: ['规划', '工程计划', '计划', 'plan', '项目经理', '排期', '里程碑', '项目管理'],
  coding: ['全栈', '开发', 'coding', 'fullstack', '实现'],
  testing: ['测试', 'test', 'GWT', 'QA', '验收', 'testing'],
}

/**
 * 阶段推进序（W18.1）：A3 下游 OUTPUT 守卫判定「下游阶段」用（严格晚于当前阶段）。
 * 与 NanjuGuardStage 联合类型声明序、STAGE_ROLE_KEYWORDS/STAGE_TITLES/STAGE_WRITE_DIR
 * 键序同源（requirements→prototype→architecture→planning→coding→testing）。
 */
export const STAGE_ORDER: readonly NanjuGuardStage[] = Object.keys(STAGE_ROLE_KEYWORDS) as NanjuGuardStage[]

/**
 * 全阶段通用的 AC 攻防类词。W18（v0.17.81）起拆分：
 * - AC_AUDIT_VERBS：AC 审计动词（去裸 'AC'）——层一 ① 审计意图裁决与层二 matchACKeyword 共用；
 * - 裸 'AC' 不再构成审计意图（例：「对照 AC-05 编写测试场景」在 requirements 应 deny testing，
 *   而非被独立词 'AC' 放行 ac 类）；裸 AC 文本回归普通判定流（可能 unmatched 放行/被注入约束）。
 */
export const AC_AUDIT_VERBS: readonly string[] = ['攻击', '防御', '审计', '复审', 'attack', 'defense', 'review']

/**
 * 强动作动词表（W10-V2.1，v0.17.72）：明确产出物类动作的中英文动词。
 *
 * 背景：dev-test-report-20260903 §六——W8 层一 unmatched 敞口实测成真（L1 在 requirements
 * 名下用无阶段词委派「把这个工具做出来」完成原型+coding 产物，阶段推进从未发生）。
 * 兜底：unmatched 内部再分级——含强动词（=明确产出物动作）→ deny，要求补角色声明；
 * 无强动词（查询/分析/总结类辅助动作）→ 维持 W8 宽匹配放行（pass-unmatched 现状不变）。
 *
 * 误拦缓解（工单 §1 误拦权衡）：本阶段产出物词优先于强动词判定（见 STAGE_OUTPUT_KEYWORDS
 * ——如 requirements 阶段「调研并编写 PRD 草稿要点」的「编写」是强动词但「PRD」命中
 * 本阶段产出物词，按 stage 放行）。注意「实现/开发」同时是 coding 的角色词（STAGE_ROLE_
 * KEYWORDS.coding），coding 阶段命中它们在第 1 步即放行，强动词表只在其他阶段兜底。
 *
 * 可演进常量：按观察数据（telemetry unmatched-action-deny 的 verbs 分布）增删；
 * 中文词 includes / 纯英文词 \b 词边界（同 W8 惯例，大小写不敏感）。
 *
 * 补词候选清单（W10 修订轮 A1 随批补入 7 词：完善/优化/调整/fix/ship/refine/polish——
 * 迭代类产出动作，裁决 20260903 attack-upheld）；下一批候选按 telemetry verbs 分布决策：
 * - '修复'：暂缓入表（GWT 回炉指令高频合法词，需配合 testing 产出词放行或 verbs 分布数据
 *   裁决后入；现表外=unmatched 放行，设计内行为，边界测试固化）；
 * - '调一下'/'改一下' 等口语化短谓语：误拦风险高于收益，待语料；
 * - 入表前先验证：候选词是否为某阶段 ROLE/OUTPUT 词（同词不宣重复，避免他阶段误拦）。
 */
export const STRONG_ACTION_VERBS: readonly string[] = [
  '实现', '开发', '构建', '生成', '制作', '编写', '写代码', '做成', '做出来',
  'build', 'implement', 'code', 'create the', 'make the', 'develop',
  // W10 修订轮 A1：迭代类产出动作补入（裁决随批）
  '完善', '优化', '调整', 'fix', 'ship', 'refine', 'polish',
]

/**
 * 各阶段产出物词（W10-V2.1：强动词 deny 的误拦缓解——「本阶段目录词优先」）。
 *
 * 只并入第 1 步本阶段放行的补充匹配（与 STAGE_ROLE_KEYWORDS[stage] 并集），
 * **不参与第 3 步他阶段扫描**——产出物词多为跨阶段动作对象（如「代码」也出现在
 * 「代码评审」），若进他阶段扫描会把合法交叉表述误拦（推翻宽匹配原则）。
 * 与角色词表的重复词（需求/PRD/原型/架构等已在 STAGE_ROLE_KEYWORDS）保留：两表
 * 语义不同（角色 vs 产物），重复命中无行为差异（第 1 步并集放行），各自完整可演进。
 */
export const STAGE_OUTPUT_KEYWORDS: Record<NanjuGuardStage, readonly string[]> = {
  requirements: ['PRD', '需求', '用户故事', 'user story', 'user stories'],
  prototype: ['原型', 'prototype', '界面稿', '视觉稿', '线框'],
  architecture: ['架构', 'architecture', '技术选型', '组件清单'],
  planning: ['计划', '规划', '里程碑', 'milestone'],
  coding: ['代码', 'code', '应用', 'index.html'],
  testing: ['测试', 'test', '场景', 'scenario', 'steps.json', 'report.json'],
}
// 注：不含 'app'——过宽（AC 委派文本 'run AC audit on app' 会把 matchKind 从 ac 改判
// stage，磁碰 W8 基线断言且模糊 AC 归类）；英文 coding 委派由 'code'/'index.html' 覆盖，
// 'build the app' 类纯动作文本记为残余误拦面（deny 文案引导补角色声明后可重试）。

/** AC 攻方识别词（用于层二区分攻/防） */
const AC_ATTACKER_KEYWORDS: readonly string[] = ['攻击', 'attack']

/** AC 防方识别词（用于层二区分攻/防） */
const AC_DEFENDER_KEYWORDS: readonly string[] = ['防御', 'defense', '裁决']

/** 各阶段的中文标题（deny 文案与注入文案用，与 nanju-router PhaseNode.title 对齐） */
export const STAGE_TITLES: Record<NanjuGuardStage, string> = {
  requirements: '需求分析师',
  prototype: 'UX 顾问',
  architecture: '架构师',
  planning: '工程经理',
  coding: '全栈开发',
  testing: '测试工程师',
}

/** 编译关键词匹配器：含非 ASCII（中文）→ includes；纯英文 → \b 词边界正则（均不区分大小写） */
function keywordMatcher(keyword: string): (text: string) => boolean {
  if (/^[\x20-\x7E]+$/.test(keyword)) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return (text) => re.test(text)
  }
  return (text) => text.includes(keyword)
}

/** 在文本中查找首个命中的关键词，返回该词（未命中返回 undefined） */
function findKeyword(text: string, keywords: readonly string[]): string | undefined {
  for (const kw of keywords) {
    if (keywordMatcher(kw)(text)) return kw
  }
  return undefined
}

// ===== 层一：校验 =====

/** 委派校验输入（从 delegate_agent/delegate_agents 参数中提取的匹配文本源） */
export interface DelegationMatchSource {
  /** 子会话标题（可选） */
  title?: string
  /** 任务说明（delegate_agent 的必填 task 字段；防御式可选） */
  task?: string
  /** 期望产出说明（R2/AC 裁决 A4：纳入匹配——防 L1 把角色词藏在 expectedOutput 绕过） */
  expectedOutput?: string
}

/** 匹配文本拼接（单一真源：checkDelegationAgainstStage / matchACKeyword / detectACRole 共用；R2 后含 expectedOutput） */
function buildMatchText(source: DelegationMatchSource): string {
  return `${source.title ?? ''}\n${source.task ?? ''}\n${source.expectedOutput ?? ''}`
}

/** 匹配结果分类 */
export type DelegationMatchKind =
  /** 命中当前阶段专属词（放行 + 注入路径约束） */
  | 'stage'
  /** 命中 AC 通用词（放行 + 层二覆写候选 + 不注入路径约束） */
  | 'ac'
  /** 两类词都不命中——辅助类委派（放行 + 注入路径约束 + telemetry 观察） */
  | 'unmatched'

/** 单个委派的阶段匹配校验结果 */
export interface DelegationCheckResult {
  /** false = 命中其他阶段专属词，拒绝 */
  allowed: boolean
  matchKind: DelegationMatchKind
  /** 命中的本阶段词（角色词或产出物词，W10 起）/ AC 词 */
  matchedKeyword?: string
  /** 拒绝时：命中的其他阶段专属词 / 强动作动词（W10） */
  violatedKeyword?: string
  /** 拒绝时：该词所属阶段（仅 other-stage 拒绝时有值） */
  violatedStage?: NanjuGuardStage
  /** W10：拒绝原因细分——'other-stage'（命中他阶段词）/ 'strong-verb'（unmatched+强动作动词）。
   *  未定义 = W8 既有语义（other-stage），调用方按该默认分流（向后兼容） */
  denialKind?: 'other-stage' | 'strong-verb'
  /** W10：strong-verb 拒绝时命中的动作动词（= violatedKeyword 的语义别名，便于调用方取用） */
  matchedVerb?: string
}

/**
 * 层一核心判定：单个委派的标题+任务 与 currentStage 的匹配。
 *
 * 判定顺序（W18，v0.17.81 重排——严格序，用户裁决接受合法交叉表述误拦成本，
 * 误拦面经 router-gate stage-deny 埋点 coPresentStageKeyword 观察统计（口径为
 * 本阶段词共现率 deny-with-coPresent，非误拦率——共现也出现在正确拦截上）；
 * W8/W10 的「本阶段词优先」原则被本条推翻，基线翻转测试固化）：
 * 1. AC 审计意图：命中 AC 审计动词（AC_AUDIT_VERBS）**且无强动作动词** → 放行（ac）。
 *    审计宾语天然跨阶段（「攻击 02_UX_DESIGN 原型」含原型/UX 词仍须放行）——审计
 *    意图不受他阶段词影响；但「审计+产出」不是同一意图：强动词在场时本条不裁决，
 *    落入 2-4（「review 架构并实现应用」「审计后顺便编写测试」均拒）。
 * 2. 他阶段角色词扫描（无条件、先于本阶段词）→ 拒绝（other-stage；产出物词仍不参与
 *    他阶段扫描——跨阶段动作对象误拦风险，见 STAGE_OUTPUT_KEYWORDS 注释）。
 * 2.5. W18.1（A3 闭合）：强动作动词在场 且 下游阶段（阶段序严格晚于当前，见
 *    STAGE_ORDER）产出物词命中 → 拒绝（other-stage，violatedKeyword=该 OUTPUT 词）。
 *    堵「本阶段引用词掩护他阶段产出」的 OUTPUT 词变体——② 只扫 ROLE 词，
 *    「按 PRD 生成应用代码」原先在 3 被本阶段词「PRD」放行。只扫严格下游：
 *    上游阶段产出的合法引用（如 coding 提「按计划」）仍走既有判定，不加码误拦。
 * 3. 本阶段词（角色词 ∪ 产出物词）→ 放行（stage；产出物词优先于强动词判定——误拦缓解）。
 * 4. 强动作动词 → 拒绝（strong-verb——W8 敞口兜底：产出类动作必须显式声明角色）。
 * 5. 都不命中（查询/分析/总结类辅助动作）→ 放行（unmatched，调用方记 telemetry 观察）。
 */
export function checkDelegationAgainstStage(
  stage: NanjuGuardStage,
  source: DelegationMatchSource,
): DelegationCheckResult {
  const text = buildMatchText(source)
  if (text.trim() === '') {
    // 空文本（参数缺 title/task）：交给既有 validateToolInput 必填校验，此处放行
    return { allowed: true, matchKind: 'unmatched' }
  }

  // 1. AC 审计意图：审计动词命中且无强动词 → 只读审计放行（ac）；强动词在场则不裁决
  const acHit = findKeyword(text, AC_AUDIT_VERBS)
  if (acHit !== undefined && findKeyword(text, STRONG_ACTION_VERBS) === undefined) {
    return { allowed: true, matchKind: 'ac', matchedKeyword: acHit }
  }

  // 2. 其他阶段专属词（仅扫角色词表——产出物词不参与他阶段扫描，见 STAGE_OUTPUT_KEYWORDS 注释）
  for (const otherStage of Object.keys(STAGE_ROLE_KEYWORDS) as NanjuGuardStage[]) {
    if (otherStage === stage) continue
    const hit = findKeyword(text, STAGE_ROLE_KEYWORDS[otherStage])
    if (hit !== undefined) {
      return { allowed: false, matchKind: 'unmatched', violatedKeyword: hit, violatedStage: otherStage, denialKind: 'other-stage' }
    }
  }

  // 2.5. W18.1（A3 闭合）：强动作动词在场 + 下游阶段产出物词 → 拒绝（other-stage，
  //     violatedKeyword=该 OUTPUT 词）——堵「本阶段引用词掩护他阶段产出」绕过
  //     （「按 PRD 生成应用代码」原先在 3 被本阶段词放行）。只扫严格下游阶段，
  //     上游产出的合法引用仍走既有判定（见上方判定顺序注释 2.5 条）。
  if (findKeyword(text, STRONG_ACTION_VERBS) !== undefined) {
    const stageIdx = STAGE_ORDER.indexOf(stage)
    for (const downstreamStage of STAGE_ORDER) {
      if (STAGE_ORDER.indexOf(downstreamStage) <= stageIdx) continue
      const outputHit = findKeyword(text, STAGE_OUTPUT_KEYWORDS[downstreamStage])
      if (outputHit !== undefined) {
        return { allowed: false, matchKind: 'unmatched', violatedKeyword: outputHit, violatedStage: downstreamStage, denialKind: 'other-stage' }
      }
    }
  }

  // 3. 本阶段词（角色词 ∪ 产出物词：产出物词优先缓解强动词误拦——「编写 PRD」在
  //    requirements 按本阶段词放行，而非掉入第 4 条强动词拒绝）
  const stageHit = findKeyword(text, [...STAGE_ROLE_KEYWORDS[stage], ...STAGE_OUTPUT_KEYWORDS[stage]])
  if (stageHit !== undefined) {
    return { allowed: true, matchKind: 'stage', matchedKeyword: stageHit }
  }

  // 4. 强动作动词 → 拒绝（产出类动作必须显式声明角色——W8 敞口兜底）
  const verbHit = findKeyword(text, STRONG_ACTION_VERBS)
  if (verbHit !== undefined) {
    return { allowed: false, matchKind: 'unmatched', violatedKeyword: verbHit, denialKind: 'strong-verb', matchedVerb: verbHit }
  }
  // 5. 无强动词（辅助类）→ 放行（现状不变）
  return { allowed: true, matchKind: 'unmatched' }
}

// ===== 层二：AC 攻/防识别与模型覆写 =====

/** AC 角色识别结果：attacker / defender / null（分不出攻防——如仅写「审计」，不覆写） */
export function detectACRole(source: DelegationMatchSource): 'attacker' | 'defender' | null {
  const text = buildMatchText(source)
  const isAttacker = findKeyword(text, AC_ATTACKER_KEYWORDS) !== undefined
  const isDefender = findKeyword(text, AC_DEFENDER_KEYWORDS) !== undefined
  if (isAttacker && isDefender) return 'attacker' // 同词并存时按攻方处理（报告注明）
  if (isAttacker) return 'attacker'
  if (isDefender) return 'defender'
  return null
}

/**
 * 层二覆写值：按项目 mode 取 AC 预设（quick→light 快模型 / iterative→medium 强模型）。
 * 与 resolveACActors 的 taskWeight 口径一致（AC_PRESETS 同源）。
 */
export function resolveACOverride(
  acRole: 'attacker' | 'defender',
  mode: ProjectMode,
): ACActorConfig {
  return AC_PRESETS[mode === 'quick' ? 'light' : 'medium'][acRole]
}

// ===== 层三：产出路径阶段约束注入 =====

/** 各阶段允许写入的产出目录（软约束注入用；真正拦截靠层一，L2 违规写入检测留后续） */
export const STAGE_WRITE_DIR: Record<NanjuGuardStage, string> = {
  requirements: '01_PRD',
  prototype: '02_UX_DESIGN',
  architecture: '03_ARCHITECTURE',
  planning: '05_PROJECT_PLAN',
  coding: '08_APP',
  testing: '06_TESTS',
}

/** 幂等标记：task 已含该标记则不再追加 */
export const PATH_CONSTRAINT_MARKER = '【阶段边界】'

/**
 * 层三：在委派 task 末尾追加一行阶段写入边界约束（幂等——已含标记原样返回）。
 * AC 类委派不注入（审计只读）；判不准（stage/unmatched）时注入（宁多勿少）。
 * F6（W18，v0.17.81）文案诚实化：层三是提示性软约束——主进程对 L2 写入无强制拦截
 * 机制，不再声称「将被记录并要求返工」（虚假承诺），改为明示软约束边界。
 */
export function injectStagePathConstraint(stage: NanjuGuardStage, task: string): string {
  if (task.includes(PATH_CONSTRAINT_MARKER)) return task
  const title = STAGE_TITLES[stage]
  const dir = STAGE_WRITE_DIR[stage]
  return (
    `${task}\n${PATH_CONSTRAINT_MARKER}当前处于「${title}」（${stage}）阶段，` +
    `本委派应在项目目录 ${dir} 内写入文件；跨目录写入为提示性软约束（系统当前不强制拦截），请遵守阶段产出边界。`
  )
}

// ===== 工具名识别 =====

const DELEGATE_TOOL_NAMES = new Set(['delegate_agent', 'delegate_agents'])

/** 归一化工具名（剥去 mcp__collaboration__ 前缀） */
export function normalizeDelegationToolName(toolName: string): string {
  return toolName.startsWith('mcp__collaboration__') ? toolName.slice('mcp__collaboration__'.length) : toolName
}

/** 是否为委派类工具（delegate_agent / delegate_agents 及其 MCP 前缀变体） */
export function isDelegationTool(toolName: string): boolean {
  return DELEGATE_TOOL_NAMES.has(normalizeDelegationToolName(toolName))
}

/** 单个委派的文本是否命中 AC 审计动词（层二独立判定：不受层一判定顺序影响；W18 起用
 * AC_AUDIT_VERBS——裸 'AC' 不再触发层二覆写候选/层三注入豁免，与层一 ① 同源） */
export function matchACKeyword(source: DelegationMatchSource): string | undefined {
  return findKeyword(buildMatchText(source), AC_AUDIT_VERBS)
}

/**
 * W18：文本同时命中的**当前阶段**词（角色词 ∪ 产出物词，键序首命中）。
 * 用途：router-gate stage-deny 埋点 coPresentStageKeyword——严格序下合法交叉表述
 * （本阶段词+他阶段词并存）被拒时的本阶段词共现率（deny-with-coPresent）观察口径
 * （共现≠误拦：正确拦截也共现，W18.1 A4 口径修正）；undefined = 无本阶段词共现。
 */
export function matchStageKeyword(stage: NanjuGuardStage, source: DelegationMatchSource): string | undefined {
  return findKeyword(buildMatchText(source), [...STAGE_ROLE_KEYWORDS[stage], ...STAGE_OUTPUT_KEYWORDS[stage]])
}

/**
 * 从工具入参中提取委派匹配文本源列表。
 * delegate_agent → [{title, task}]；delegate_agents → items 每项的 {title, task}。
 * 防御式取字段（非字符串忽略；items 非数组 → 空，交给 validateToolInput 必填校验）。
 * 非对象项用空 source 占位，保持与 items 数组索引对齐（批量 deny 文案需报序号）。
 */
export function extractDelegationSources(input: Record<string, unknown>): DelegationMatchSource[] {
  const pick = (obj: Record<string, unknown>): DelegationMatchSource => ({
    title: typeof obj.title === 'string' ? obj.title : undefined,
    task: typeof obj.task === 'string' ? obj.task : undefined,
    expectedOutput: typeof obj.expectedOutput === 'string' ? obj.expectedOutput : undefined,
  })
  if (Array.isArray(input.items)) {
    return input.items.map((it) =>
      typeof it === 'object' && it !== null ? pick(it as Record<string, unknown>) : {},
    )
  }
  return [pick(input)]
}
