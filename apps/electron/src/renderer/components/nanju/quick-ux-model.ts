/**
 * 南大项目 quick UX 视图模型（W24-EF F2 v0.17.123）
 *
 * 单一职责：把 US-U01 模式卡片文案 / US-U07 熔断安抚 / US-U08 验收报告逐场景通俗视图
 * 封装为纯渲染端纯函数视图模型。
 * - 不接 IPC / 主进程 / 路由——这些交 I 集成子会话落补丁；
 * - 不依赖 React/Jotai；只产出字符串与对象数据，组件层消费；
 * - 「纯模块」可被组件导入直接渲染，无需 useEffect/useState；
 *
 * 边界（与 EF.md §1 US-U01/U07/U08 表对齐）：
 * - US-U07 场景 3 与 spec/PRD §7.5 文案口径分歧（详见 dispatch/reports/EF.md §1 / 注 6），
 *   F2 不替父裁决，仅暴露两个常量由 I 端择一；
 * - US-U08 报告行的「我们试了：打开添加页面 → … ✓ 成功」叙述由 describeScenarioRow
 *   生成；步骤细节不泄露测试内部 DSL（Given/When/Then 术语），仅保留可读短句。
 */

import type { NanjuGwtProgressData } from '@proma/shared'

// ===== US-U01 模式卡片文案 =====

export interface ModeCardCopy {
  title: string
  subtitle: string
  /** 场景举例（「比如：做个读书笔记…」），可作卡片下方 tag */
  examples: ReadonlyArray<string>
  /** 卡片标签色 token；F2 不消费，由 I 端 ModeSelectView.tsx 自接 */
  accentToken: 'blue' | 'purple'
}

/** US-U01：左卡——快速做一个工具 */
export const QUICK_MODE_CARD: ModeCardCopy = Object.freeze({
  title: '快速做一个工具',
  subtitle: '适合试试想法、做个小工具、验证一个点子。',
  examples: Object.freeze([
    '比如：做个读书笔记',
    '比如：订餐统计',
    '比如：个人记账',
  ]),
  accentToken: 'blue',
})

/** US-U01：右卡——做一个长期维护的项目 */
export const ITERATIVE_MODE_CARD: ModeCardCopy = Object.freeze({
  title: '做一个长期维护的项目',
  subtitle: '适合想持续更新、不断完善的项目。',
  examples: Object.freeze([
    '比如：开源工具',
    '比如：团队协作平台',
    '比如：长期维护的社区网站',
  ]),
  accentToken: 'purple',
})

// ===== US-U08 GWT 报告逐场景通俗视图 =====

export type ScenarioRowStatus = 'pass' | 'fail' | 'skip'

export interface ScenarioResultRow {
  /** 用户故事编号（US-xx），来自 nanju-user-stories.parseUserStories 正则提取 */
  usId: string
  /** 一句通俗描述（可信来源：GWT 报告 scenario description / PRD story）；缺省时 = `${usId}（暂无描述）` */
  plainText: string
  /** 展开叙述（基于可信 plainText，不把技术步骤冒充用户叙述） */
  narration: string
  status: ScenarioRowStatus
}

export interface GwtReportScenarioInput {
  /** 用户故事编号；可缺省——F2 兜底成 'US-?' */
  usId?: string
  /** 可信的一句通俗描述（来自 GWT/US story description）；缺省时不伪造 */
  plainText?: string
  /** 技术步骤（Given/When/Then 或 GWT DSL），仅供诊断，不用于生成用户可见叙述 */
  steps?: ReadonlyArray<string>
  /** 当前状态 */
  verdict: ScenarioRowStatus | 'pass' | 'fail' | 'skip' | string
}

export interface GwtReportInput {
  scenarios: ReadonlyArray<GwtReportScenarioInput>
}

const STATUS_GLYPH: Record<ScenarioRowStatus, string> = Object.freeze({
  pass: '✓',
  fail: '✗',
  skip: '○',
})

const STATUS_LABEL: Record<ScenarioRowStatus, string> = Object.freeze({
  pass: '成功',
  fail: '失败',
  skip: '跳过',
})

function normalizeStatus(raw: string): ScenarioRowStatus {
  const s = String(raw ?? '').trim().toLowerCase()
  if (s === 'pass' || s === '成功' || s === 'ok') return 'pass'
  if (s === 'fail' || s === '失败' || s === 'error') return 'fail'
  if (s === 'skip' || s === '跳过' || s === 'skipped') return 'skip'
  return 'fail' // 未知状态保守口径：与 GWT 报告「未识别即不通过」一致
}

/**
 * 从 GWT 报告输入构建逐场景通俗行。
 * - usId 缺省兜底为 'US-?'；
 * - plainText 只接受可信来源（GWT 报告 scenario description / PRD story）；
 *   缺省时显式标注「`US-xx`（暂无描述）」，不得用 steps[0] 伪造「能正常 X」；
 * - verdict 接受 'pass' / 'fail' / 'skip' / 'error' 等别名。
 */
export function buildScenarioRows(report: GwtReportInput): ScenarioResultRow[] {
  const rows: ScenarioResultRow[] = []
  for (const s of report?.scenarios ?? []) {
    const usId = String(s?.usId ?? '').trim() || 'US-?'
    const trusted = String(s?.plainText ?? '').trim()
    const status = normalizeStatus(s?.verdict ?? 'fail')
    const plainText = trusted || `${usId}（暂无描述）`
    rows.push({ usId, plainText, narration: buildNarration(plainText, status), status })
  }
  return rows
}

function buildNarration(plainText: string, status: ScenarioRowStatus): string {
  // 展开叙述只基于可信 plainText；技术 steps 不冒充用户叙述
  return `${STATUS_GLYPH[status]} ${plainText}（${STATUS_LABEL[status]}）`
}

/**
 * 单行展开叙述生成（暴露给组件直接渲染）——与 buildScenarioRows 的 narration 字段同语义，
 * 允许组件对已构建的 row 二次合成叙述（如失败时附原因）。
 */
export function describeScenarioRow(row: ScenarioResultRow): string {
  return row?.narration ?? ''
}

// ===== US-U08 部分未通过标题 =====

/**
 * 「通过了 X 项，还有 Y 项需要修复」标题构建。
 * - passed/failed ≥ 0 截断；
 * - skipped 不计入「未通过」（按 PRD §8.4 通过=未失败口径）；
 * - 全通过时返回「全部 N 项通过」；
 * - 全失败时返回「N 项未通过」并隐含「已自动进入修复」。
 */
export function buildPartialFailureHeadline(passed: number, failed: number): string {
  const p = Math.max(0, Math.floor(Number(passed) || 0))
  const f = Math.max(0, Math.floor(Number(failed) || 0))
  if (f === 0 && p > 0) return `全部 ${p} 项通过`
  if (p === 0 && f > 0) return `${f} 项未通过，已自动进入修复`
  if (p > 0 && f > 0) return `通过了 ${p} 项，还有 ${f} 项需要修复`
  return '本次验收没有场景可执行'
}

// ===== US-U07 熔断安抚文案（双口径并行暴露，由 I 端择一） =====

export interface CircuitBreakMessageInput {
  /** 项目模式：quick 走快消安抚口径；iterative 走长期迭代安抚口径 */
  mode: 'quick' | 'iterative'
  /** 当前已熔断累计次数（同 projectId 同一阶段的累计，1..3+） */
  consecutiveCircuitCount: number
  /** 是否已成功回滚到健康快照（依赖 D1，未就绪时为 false） */
  rolledBack: boolean
}

/**
 * 构建熔断安抚文案（按 US-U07 场景 3 + 第 1/2 次 vs ≥3 次特化）。
 * - 第 1/2 次熔断：「我正在处理一个技术细节，请稍等几秒…」；
 * - ≥3 次熔断：「这个功能似乎实现起来比我预期的困难，我建议换个方向或先简化范围」；
 * - 已回滚：在末句追加「已回到上一个正常版本，可继续修改」；
 * - 两口径（PRD §7.5 vs spec v0.5 交互 2）由 I 端择一，F2 暴露两个常量文本。
 */
export function buildCircuitBreakMessage(input: CircuitBreakMessageInput): string {
  const count = Math.max(1, Math.floor(Number(input.consecutiveCircuitCount) || 1))
  const isOvertried = count >= 3
  const mode = input.mode === 'iterative' ? 'iterative' : 'quick'
  let base: string
  if (isOvertried) {
    base = mode === 'iterative'
      ? '这个功能似乎实现起来比我预期的困难，我建议换个方向或先简化范围，避免继续消耗预算。'
      : '这个功能似乎实现起来比我预期的困难，我可以帮你换个思路或先做一个简化版继续验证。'
  } else {
    base = mode === 'iterative'
      ? '我正在处理一个技术细节，请稍等几秒。'
      : '我正在帮你修复刚才遇到的小问题，稍等几秒就好。'
  }
  if (input.rolledBack) {
    base += ' 已回到上一个正常版本，可继续修改。'
  }
  return base
}

/** US-U07 第 1/2 次特化（无 count 时兜底） */
export const CIRCUIT_BREAK_FIRST_OR_SECOND_MESSAGE: string =
  '我正在帮你修复刚才遇到的小问题，稍等几秒就好。'

/** US-U07 ≥3 次特化 */
export const CIRCUIT_BREAK_OVER_TRIED_MESSAGE: string =
  '这个功能似乎实现起来比我预期的困难，我可以帮你换个思路或先做一个简化版继续验证。'

// ===== US-U08 汇总行（与 nanju-gwt-runner.ts:758 标题互补） =====

/**
 * GWT 报告汇总行构建——「我们测试了 N 个场景，全部通过 ✓」或失败变体。
 * - N=passed+failed+skipped=total；
 * - 与 nanju-gwt-runner.ts 既有汇总兼容，I 端可选择性替换为 buildPartialFailureHeadline；
 * - 不消费 NanjuGwtProgressData 全字段，只取 passed/failed/skipped（隐私最小）。
 */
export function buildGwtSummaryLine(data: Pick<NanjuGwtProgressData, 'passed' | 'failed' | 'skipped'>): string {
  const p = Math.max(0, Math.floor(Number(data?.passed) || 0))
  const f = Math.max(0, Math.floor(Number(data?.failed) || 0))
  const s = Math.max(0, Math.floor(Number(data?.skipped) || 0))
  const total = p + f + s
  if (total === 0) return '本次没有运行任何场景'
  if (f === 0 && s === 0) return `我们测试了 ${total} 个场景，全部通过 ✓`
  if (s > 0 && f === 0) return `我们测试了 ${total} 个场景，${p} 项通过，${s} 项跳过`
  return buildPartialFailureHeadline(p, f)
}