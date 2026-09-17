/**
 * W-I B-e：quick UX 埋点接线层（PRD §12.4 各条发射点的宿主侧收口）。
 *
 * 为什么单独成模块：
 * - F2（`nanju-quick-events`）只提供 **payload 构建** 与单点 `emitQuickEvent`；「事件在哪发射、
 *   轮次从哪来」属宿主接线，散在 orchestrator/ipc/consumer 里会各写一套轮次与门禁逻辑。
 * - 本模块集中三件事：① 轮次/去重状态；② 从真实事实源取字段（repair log / project / gate）；
 *   ③ payload 只经 F2 的 builder（隐私字段构造不可能被绕过）。
 *
 * 边界（诚实声明）：
 * - 只发射 PRD §12.4 中标注「发射点待 I 落补丁」的事件：#1/#2/#6/#8/#10；其余既有发射点不动；
 * - #2 不存对话原文（父裁决隐私收敛）：只发 mode/turn/inputLength/vague/autoFilledCount；
 * - 埋点失败一律吞掉（`emitQuickEvent` 内部 try/catch），绝不因埋点影响主流程。
 */

import { buildDialogSubmitPayload, buildRepairPayload, emitQuickEvent } from './nanju-quick-events'
import type { RepairOutcome } from './nanju-quick-events'
import { readRepairLogState } from './nanju-repair-loop'
import { isVagueInput, AUTO_DECIDE_LABEL } from './nanju-quick-dialog'
import { findNanjuProjectBySession } from './nanju-phase-gate'

/**
 * #2 dialog.submitted 的会话轮次计数器（内存态）。
 *
 * 为什么用内存而不是读 jsonl：轮次只是观测维度，不需要精确重建历史；读 jsonl 会把每次
 * 埋点变成 IO 扫描。进程重启后从 1 重新计——埋点断言只要求单调递增且与提交次数一致。
 */
const dialogTurns = new Map<string, number>()

/** 测试隔离用（生产不调用） */
export function __resetQuickTelemetryForTests(): void {
  dialogTurns.clear()
}

/**
 * #2 dialog.submitted：用户消息提交即发射（PRD「每轮对话提交」）。
 *
 * - 只对**已绑定活跃南大项目**的会话发射（无项目会话不是南大对话，不污染漏斗）；
 * - `turn` 按会话内提交顺序自增（1 起）；`vague` 用 quick-dialog 的同一判定（只存布尔）；
 * - `autoFilledCount` = 本轮消息里用户显式使用「你帮我决定」的次数（真实计数，不做行为推断）；
 * - 不传原文，只传字符长度。
 */
export function emitDialogSubmitted(workspaceSlug: string, sessionId: string, text: string): void {
  try {
    if (!workspaceSlug || !sessionId) return
    const project = findNanjuProjectBySession(workspaceSlug, sessionId)
    if (!project || project.status !== 'active') return
    const turn = (dialogTurns.get(sessionId) ?? 0) + 1
    dialogTurns.set(sessionId, turn)
    const raw = text ?? ''
    const autoFilledCount = AUTO_DECIDE_LABEL.length > 0
      ? raw.split(AUTO_DECIDE_LABEL).length - 1
      : 0
    emitQuickEvent(workspaceSlug, project.projectId, 'dialog.submitted', buildDialogSubmitPayload({
      mode: project.mode,
      turn,
      inputLength: raw.length,
      vague: isVagueInput(raw),
      autoFilledCount,
    }) as unknown as Record<string, unknown>)
  } catch { /* 埋点失败不影响对话 */ }
}

/**
 * #10 repair.triggered：修复循环**收尾**事实（success / circuit-break / environment-notify）。
 *
 * attempts 与 strategies **一律**来自 E 的 `_repair-log.json`（禁止伪造 attempt 数）；
 * `success` 且无任何 attempt 时不发射（首产即过的项目没有修复事实，发了就是噪音）。
 */
export function emitRepairTriggered(
  workspaceSlug: string,
  projectId: string,
  outcome: RepairOutcome,
): void {
  try {
    const attempts = readRepairLogState(workspaceSlug, projectId).attempts
    if (outcome === 'success' && attempts.length === 0) return
    emitQuickEvent(workspaceSlug, projectId, 'repair.triggered', buildRepairPayload({
      attempts: attempts.length,
      outcome,
      strategies: attempts.map((item) => item.strategy),
    }) as unknown as Record<string, unknown>)
  } catch { /* 埋点失败不影响主流程 */ }
}

/** #1 project.created：项目创建成功即发射（建项目是事实，失败路径不经过本函数） */
export function emitProjectCreated(
  workspaceSlug: string,
  project: { projectId: string; name: string; mode: 'quick' | 'iterative'; autoClarify?: { enabled?: boolean } },
): void {
  try {
    emitQuickEvent(workspaceSlug, project.projectId, 'project.created', {
      project_id: project.projectId,
      mode: project.mode,
      // 名称长度而非名称本身：埋点不需要标题原文，只用于观测命名习惯
      name_length: String(project.name ?? '').length,
      auto_clarify: project.autoClarify?.enabled === true,
    })
  } catch { /* 埋点失败不影响建项目 */ }
}

/**
 * #8 mode.switched：quick → iterative 的**真实落库**事实。
 *
 * 调用方必须保证「变更前 mode='quick' 且变更后 mode='iterative'」已由落库路径判定
 * （见 `nanju-ipc.ts` 的 project update 分支）；本函数不做方向推断，也不接受其它方向
 * （iterative → quick 不允许，调用方不应调用）。
 */
export function emitModeSwitched(
  workspaceSlug: string,
  projectId: string,
  payload: { from: 'quick'; to: 'iterative'; reason: string; quickStageState: string },
): void {
  try {
    emitQuickEvent(workspaceSlug, projectId, 'mode.switched', {
      project_id: projectId,
      from_mode: payload.from,
      to_mode: payload.to,
      reason: payload.reason,
      quick_stage_state: payload.quickStageState,
    })
  } catch { /* 埋点失败不影响升级流程 */ }
}

/** #6 user.undo：撤销处理即发射（只记发生次数与来源，不记被撤销内容） */
export function emitUserUndo(workspaceSlug: string, projectId: string | undefined, source: string): void {
  try {
    emitQuickEvent(workspaceSlug, projectId, 'user.undo', { source })
  } catch { /* 埋点失败不影响撤销 */ }
}
