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
 * 设计原则：宽匹配保守放行——本阶段词或 AC 词命中即放行；两类都不命中（辅助类：
 * 查资料/分析等）也放行并记录 telemetry（pass-unmatched）供观察误拦率；
 * 只有明确命中其他阶段专属词才拒绝。
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

/** 各阶段允许的委派角色关键词（宽松包含匹配，中文 includes / 英文 \b 词边界，大小写不敏感） */
export const STAGE_ROLE_KEYWORDS: Record<NanjuGuardStage, readonly string[]> = {
  requirements: ['需求', 'PRD', 'analyst', 'requirements'],
  prototype: ['UX', '原型', 'prototype', '视觉', '界面'],
  architecture: ['架构', 'architect', '环境', '技术'],
  planning: ['规划', '计划', 'plan', '工程'],
  coding: ['全栈', '开发', 'coding', 'fullstack', '实现'],
  testing: ['测试', 'test', 'GWT', 'QA', '验收', 'testing'],
}

/** 全阶段通用的 AC 攻防类词（命中即放行，且触发层二覆写候选 / 不注入路径约束） */
export const AC_KEYWORDS: readonly string[] = ['攻击', '防御', '审计', '复审', 'attack', 'defense', 'review', 'AC']

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
  /** 命中的本阶段词 / AC 词 */
  matchedKeyword?: string
  /** 拒绝时：命中的其他阶段专属词 */
  violatedKeyword?: string
  /** 拒绝时：该词所属阶段 */
  violatedStage?: NanjuGuardStage
}

/**
 * 层一核心判定：单个委派的标题+任务 与 currentStage 的匹配。
 *
 * 判定顺序（宽匹配保守放行）：
 * 1. 命中本阶段词 → 放行（stage）
 * 2. 命中 AC 通用词 → 放行
 * 3. 命中其他阶段专属词 → 拒绝（violatedKeyword/violatedStage）
 * 4. 都不命中 → 放行（unmatched，调用方记 telemetry 观察）
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

  // 1. 本阶段词
  const stageHit = findKeyword(text, STAGE_ROLE_KEYWORDS[stage])
  if (stageHit !== undefined) {
    return { allowed: true, matchKind: 'stage', matchedKeyword: stageHit }
  }

  // 2. AC 通用词
  const acHit = findKeyword(text, AC_KEYWORDS)
  if (acHit !== undefined) {
    return { allowed: true, matchKind: 'ac', matchedKeyword: acHit }
  }

  // 3. 其他阶段专属词
  for (const otherStage of Object.keys(STAGE_ROLE_KEYWORDS) as NanjuGuardStage[]) {
    if (otherStage === stage) continue
    const hit = findKeyword(text, STAGE_ROLE_KEYWORDS[otherStage])
    if (hit !== undefined) {
      return { allowed: false, matchKind: 'unmatched', violatedKeyword: hit, violatedStage: otherStage }
    }
  }

  // 4. 都不命中（辅助类）
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
 * 层三：在委派 task 末尾追加一行阶段写入边界硬约束（幂等——已含标记原样返回）。
 * AC 类委派不注入（审计只读）；判不准（stage/unmatched）时注入（宁多勿少）。
 */
export function injectStagePathConstraint(stage: NanjuGuardStage, task: string): string {
  if (task.includes(PATH_CONSTRAINT_MARKER)) return task
  const title = STAGE_TITLES[stage]
  const dir = STAGE_WRITE_DIR[stage]
  return (
    `${task}\n${PATH_CONSTRAINT_MARKER}当前处于「${title}」（${stage}）阶段，` +
    `本委派只允许在项目目录 ${dir} 内写入文件；跨目录写入将被记录并要求返工。`
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

/** 单个委派的文本是否命中 AC 通用词（层二独立判定：不受层一判定顺序影响，阶段词先命中也不妨砧AC 覆写） */
export function matchACKeyword(source: DelegationMatchSource): string | undefined {
  return findKeyword(buildMatchText(source), AC_KEYWORDS)
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
