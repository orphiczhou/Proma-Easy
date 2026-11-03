/**
 * 南大项目 quick UX 与本地埋点支撑（W24-EF F2 v0.17.123）
 *
 * 单一职责：把 PRD §12.4 事件表 14 条 + payload 构建 + 单点收口发射封装为纯模块。
 * - 不接 IPC / renderer / orchestrator / router / runner——这些交 I 集成子会话落补丁；
 * - 不依赖任何网络/外部副作用，发射走 nanju-telemetry.recordTelemetry（内部 try/catch 不上抛）；
 * - payload 严格最小化：仅含类型/计数/布尔/枚举字段，不含坐标、不含原文、不含用户原始输入；
 * - 「自动建议」/「你帮我决定」标注文本固定常量，可被 US-U02 prompt 与 US-U04 摘要共用。
 *
 * 边界与契约（与 nanju-telemetry.ts union 同步）：
 * - PRD §12.4 #1/#2/#4/#5/#14 已入 union，缺发射点；#3/#9/#11/#13 已发射；
 *   #6/#7/#8/#10/#12 union 补齐（F2 范围）；#7/#10/#12 由本模块 payload 构建 +
 *   emitQuickEvent 单点收口，#6/#8 仅声明 union，发射点交 I（点选撤销 / 模式转换在主流程）。
 * - #2 dialog.submitted 由本模块提供 buildDialogSubmitPayload（结构化字段，不存原文）；
 *   父裁决「不额外采集内容」——PRD #2 原文「用户原始输入」收敛为 mode/turn/inputLength/
 *   vague/autoFilledCount（隐私收敛点已在 dispatch/reports/F.md 标注）。
 * - #8「模式转换（快消→长期）」是独立事件 mode.switched，与 #3「向导角色切换」role.switched
 *   语义不同（PRD §12.4 两行），不得复用同一 eventType。
 *
 * 隐私边界（payload 审查红线）：
 * - buildClickToFixPayload 绝不接受 `text/rect/innerText/value` 等敏感字段；输入侧只允许
 *   元素类型枚举/布尔/阶段枚举。
 * - buildRepairPayload 输入 attempts 必须来自 E2 RepairAttempt[]（不允许 I 端伪造 attempt 数）；
 *   strategies 来自 E2 RepairStrategy 枚举字符串（不传 strategy 实现细节）。
 * - buildSatisfactionPayload 不做行为推断：仅标记用户主动应答；activeMsSinceStart 由 I 端
 *   自上次满意交付门禁置位时刻（deliveryAck at）计算，禁止用其他启发式时间戳冒充。
 */

import { recordTelemetry, type TelemetryEventType } from './nanju-telemetry'

// ===== 枚举常量（视图/构建/发射三方共享，防字符串漂移） =====

/** 点选纠错成功阶段（与 nanju-router-prompt.ts ClickToFixPanel 快速选项语义对齐） */
export type ClickToFixStage =
  | 'pick-color'
  | 'pick-text'
  | 'pick-move'
  | 'pick-delete'
  | 'pick-other'

/** 自动修复触发结果（与 E2 RepairPlan.action 派生对齐） */
export type RepairOutcome = 'success' | 'circuit-break' | 'environment-notify'

/** 满意度主动标记（与 W18 交付门禁事实二对齐：ask-answer 精确等值置位） */
export type SatisfactionVerdict = 'satisfied' | 'needs-change'

// ===== PRD §12.4 事件表 14 条 =====

export interface PrdTelemetryEventSpec {
  /** PRD §12.4 编号 */
  index: number
  /** union 字面值 */
  eventType: TelemetryEventType
  /** 建议发射点（文件名 + 模块入口），供 I 集成子会话按表落补丁 */
  emitSite: string
  /** 是否已在 union（F2 期口径） */
  inUnion: boolean
  /** 是否已发射（F2 期口径；F2 范围内负责补齐的标 false） */
  emitted: boolean
}

/**
 * PRD §12.4 事件表 14 条全量索引。
 * - `index` 对应 PRD 原文编号（1–14），eventType 严格取自 nanju-telemetry.ts union，14 条各不同。
 * - `emitted=false`：发射点待 I 集成子会话按 emitSite 落补丁（#1/#2/#4/#5/#6/#7/#8/#10/#12/#14）。
 * - `emitted=true`：已由既有代码发射（#3 role.switched / #9 coding.executed / #11 judge.verdict / #13 project.finished）。
 * - F2 范围内本模块负责 #7/#10/#12 的 payload 构建与 emitQuickEvent 收口；#6/#8 仅 union 声明，发射交 I。
 *
 * 注：表格由 EF.md §1 「满意度 / 本地埋点」表派生，逐条对照不遗漏；如父裁决要调整，发射点以本表为准。
 */
export const PRD_TELEMETRY_EVENTS: ReadonlyArray<PrdTelemetryEventSpec> = Object.freeze([
  Object.freeze({ index: 1, eventType: 'project.created', emitSite: 'apps/electron/src/main/lib/nanju-ipc.ts（nanju:create-project，createNanjuProject 成功后 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 2, eventType: 'dialog.submitted', emitSite: 'apps/electron/src/main/lib/agent-orchestrator.ts（真用户消息提交处，checkConfirmAdvanceInput 同条件 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 3, eventType: 'role.switched', emitSite: 'apps/electron/src/main/lib/nanju-orchestrator.ts:133', inUnion: true, emitted: true }),
  Object.freeze({ index: 4, eventType: 'prd.confirmed', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts（requirements 收口推进成功分支 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 5, eventType: 'prototype.confirmed', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts（prototype 收口推进成功分支 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 6, eventType: 'user.undo', emitSite: 'apps/electron/src/renderer/components/nanju/ClickToFixPanel.tsx（单条撤销/全部放弃 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 7, eventType: 'click_to_fix', emitSite: 'apps/electron/src/main/lib/nanju-ipc.ts（agent:report-click-to-fix：panel-action/commit-changes/blank-click/box-select）+ renderer useGlobalAgentListeners（element-click/change-result 就地处理路径）· W-I B-e', inUnion: true, emitted: true }),
  Object.freeze({ index: 8, eventType: 'mode.switched', emitSite: 'apps/electron/src/main/lib/nanju-ipc.ts（nanju:update-project：quick→iterative 真实落库且写入成功 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 9, eventType: 'coding.executed', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts:813', inUnion: true, emitted: true }),
  Object.freeze({ index: 10, eventType: 'repair.triggered', emitSite: 'apps/electron/src/main/lib/agent-orchestrator.ts（E 派发路径修复/熔断/环境三类 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 11, eventType: 'judge.verdict', emitSite: 'apps/electron/src/main/lib/nanju-gwt-runner.ts:2021', inUnion: true, emitted: true }),
  Object.freeze({ index: 12, eventType: 'satisfaction.marked', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts（delivery.ack-recorded 同拍 · W-I B-e）', inUnion: true, emitted: true }),
  Object.freeze({ index: 13, eventType: 'project.finished', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts:561', inUnion: true, emitted: true }),
  Object.freeze({ index: 14, eventType: 'architecture.confirmed', emitSite: 'apps/electron/src/main/lib/nanju-phase-advance-consumer.ts（architecture 收口推进成功分支 · W-I B-e）', inUnion: true, emitted: true }),
])

// ===== PRD §12.4 #7 点选纠错 payload 构建 =====

export interface ClickToFixPayloadInput {
  /** 元素 data-ai-type 取值；空字符串视为「未命名元素」，仍允许发射 */
  elementType: string
  /** 元素是否含 data-ai-id（隐私：不传 id 本身，仅传布尔） */
  hasId: boolean
  /** 是否成功应用修改（由 nanju-ipc.ts change-result 上报的 ok 字段派生） */
  applied: boolean
  /** 快速选项阶段（决定统计分桶） */
  stage: ClickToFixStage
}

export interface ClickToFixPayload {
  /** 元素类型（如「按钮」/「输入框」/「元素」） */
  elementType: string
  /** 是否含 data-ai-id 标识（用于分析数据完备率，隐私不传 id 本身） */
  hasId: boolean
  /** 是否成功应用（由 IPC 上报 ok 派生；false 含 apply 失败与 undo 还原） */
  applied: boolean
  /** 快速选项阶段标签 */
  stage: ClickToFixStage
}

/**
 * 构建 #7 click_to_fix 事件 payload（隐私最小集合）。
 * - 禁止接受 text/rect/innerText/value；输入侧已强制仅枚举/布尔。
 * - 元素类型长度裁剪 32：防止异常 data-ai-type 撑爆 payload。
 */
export function buildClickToFixPayload(input: ClickToFixPayloadInput): ClickToFixPayload {
  const elementType = String(input.elementType ?? '').trim().slice(0, 32) || '元素'
  const hasId = Boolean(input.hasId)
  const applied = Boolean(input.applied)
  const stage: ClickToFixStage = isClickToFixStage(input.stage) ? input.stage : 'pick-other'
  return { elementType, hasId, applied, stage }
}

function isClickToFixStage(value: unknown): value is ClickToFixStage {
  return value === 'pick-color' || value === 'pick-text' || value === 'pick-move'
    || value === 'pick-delete' || value === 'pick-other'
}

// ===== PRD §12.4 #10 自动修复触发 payload 构建 =====

export interface RepairPayloadInput {
  /** E2 已用尝试次数（含首产则首产不计入——E2 RepairAttempt[] 已固化语义，F2 只接收） */
  attempts: number
  /** 最终结果（success / circuit-break / environment-notify） */
  outcome: RepairOutcome
  /** 本次任务使用的策略序列（取自 E2 RepairStrategy 枚举字符串，无顺序） */
  strategies: ReadonlyArray<string>
}

export interface RepairPayload {
  attempts: number
  outcome: RepairOutcome
  /** 策略去重后按出现顺序拼接；为空数组则留空字符串 */
  strategiesCsv: string
  /** 策略种类数（用于「至少 2 种不同策略」断言观测，PRD Q4） */
  strategyVariants: number
}

function isRepairOutcome(value: unknown): value is RepairOutcome {
  return value === 'success' || value === 'circuit-break' || value === 'environment-notify'
}

/**
 * 构建 #10 repair.triggered 事件 payload。
 * - 严格接收 E2 真实尝试数据：attempts 须 ≥ 0，strategies 须为 E2 RepairStrategy 字符串集合；
 * - 越界输入（如 attempts < 0、outcome 未识别）按 E2 fail-closed 行为降级：
 *   attempts 截到 0、outcome 置为 'circuit-break'（最安全口径，与 E2 planNextRepair 一致）。
 * - I 端禁止伪造 attempt 数；attempts 始终来自 E2 RepairAttempt[] 派生。
 */
export function buildRepairPayload(input: RepairPayloadInput): RepairPayload {
  const attempts = Math.max(0, Math.min(3, Math.floor(Number(input.attempts) || 0)))
  const outcome: RepairOutcome = isRepairOutcome(input.outcome) ? input.outcome : 'circuit-break'
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const raw of input.strategies ?? []) {
    const s = String(raw ?? '').trim().slice(0, 32)
    if (!s) continue
    if (!seen.has(s)) {
      seen.add(s)
      ordered.push(s)
    }
  }
  return {
    attempts,
    outcome,
    strategiesCsv: ordered.join(','),
    strategyVariants: seen.size,
  }
}

// ===== PRD §12.4 #12 满意度标记 payload 构建 =====

export interface SatisfactionPayloadInput {
  /** W18 deliveryAck 的 verdict（satisfied / needs-change） */
  verdict: SatisfactionVerdict
  /** 自上次交付门禁置位至本次 ack 的活跃毫秒数（I 端取自 project.deliveryAckAt） */
  activeMsSinceStart: number
}

export interface SatisfactionPayload {
  verdict: SatisfactionVerdict
  /** 0 表示瞬时；超过 1h（3 600 000ms）视为异常长会话，I 端可观测但不阻断 */
  activeMsSinceStart: number
}

function isSatisfactionVerdict(value: unknown): value is SatisfactionVerdict {
  return value === 'satisfied' || value === 'needs-change'
}

/**
 * 构建 #12 satisfaction.marked 事件 payload。
 * - 不做行为推断：verdict 必须显式来自 W18 deliveryAck；
 * - 活跃时长按 ≥ 0 截断；上限 24h 防异常输入污染 payload。
 */
export function buildSatisfactionPayload(input: SatisfactionPayloadInput): SatisfactionPayload {
  const verdict: SatisfactionVerdict = isSatisfactionVerdict(input.verdict) ? input.verdict : 'needs-change'
  const activeMsSinceStart = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.floor(Number(input.activeMsSinceStart) || 0)))
  return { verdict, activeMsSinceStart }
}

// ===== PRD §12.4 #2 每轮对话提交 payload 构建（隐私收敛：不存原文） =====

export interface DialogSubmitPayloadInput {
  /** 项目模式（quick/iterative） */
  mode: 'quick' | 'iterative'
  /** 对话轮次编号（1 起） */
  turn: number
  /** 用户输入长度（字符数）；不存原文 */
  inputLength: number
  /** 是否被 isVagueInput 判定为极模糊；只存判定布尔，不存原文 */
  vague: boolean
  /** 本轮自动填补的决策项数（「你帮我决定」次数） */
  autoFilledCount: number
}

export interface DialogSubmitPayload {
  mode: 'quick' | 'iterative'
  turn: number
  inputLength: number
  vague: boolean
  autoFilledCount: number
}

/**
 * 构建 #2 dialog.submitted 事件 payload。
 * - 隐私收敛：PRD §12.4 #2 原文要求「用户原始输入 + 时间戳 + 轮次编号」，本模块按父裁决
 *   「不额外采集内容」不存原文，只存 mode/turn/inputLength/vague/autoFilledCount；
 *   时间戳由 recordTelemetry 统一写入，不在此 payload 重复。
 * - 越界降级：turn 截到 ≥1；inputLength 截到 [0,100000]；autoFilledCount 截到 ≥0。
 */
export function buildDialogSubmitPayload(input: DialogSubmitPayloadInput): DialogSubmitPayload {
  const mode: 'quick' | 'iterative' = input.mode === 'iterative' ? 'iterative' : 'quick'
  const turn = Math.max(1, Math.floor(Number(input.turn) || 1))
  const inputLength = Math.max(0, Math.min(100000, Math.floor(Number(input.inputLength) || 0)))
  const vague = Boolean(input.vague)
  const autoFilledCount = Math.max(0, Math.floor(Number(input.autoFilledCount) || 0))
  return { mode, turn, inputLength, vague, autoFilledCount }
}

// ===== 单点收口发射 =====

/**
 * quick UX / 本地埋点单点收口发射。
 * - 包 recordTelemetry（内部 try/catch 不上抛，失败仅 console.warn）；
 * - 仅接受当前已在 nanju-telemetry.ts union 的事件类型——TS 收口，I 端用错事件将编译失败；
 * - 不直接接受外部 recordTelemetry 调用方；所有 #7/#10/#12 与未来 F2 增补事件必须经此函数。
 *
 * 使用示例（I 端接线片段）：
 *
 * ```ts
 * import { emitQuickEvent, buildClickToFixPayload } from './nanju-quick-events'
 *
 * // nanju-ipc.ts onClickToFixReport 处：
 * emitQuickEvent(
 *   workspaceSlug,
 *   projectId,
 *   'click_to_fix',
 *   buildClickToFixPayload({
 *     elementType: element.dataAiType,
 *     hasId: Boolean(element.dataAiId),
 *     applied: result.ok,
 *     stage: stageFromQuickOption(option),
 *   }),
 * )
 * ```
 */
export function emitQuickEvent(
  workspaceSlug: string,
  projectId: string | undefined,
  eventType: TelemetryEventType,
  payload: Record<string, unknown>,
): void {
  recordTelemetry(workspaceSlug, eventType, payload, projectId)
}