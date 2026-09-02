/**
 * 南大 R1（W1）：L2 委派生命周期状态广播（nanju:delegation-status IPC 通道）
 *
 * spec v0.5 交互2「等待状态与进度反馈」的委派场景数据源：
 * - phase=start   → 渲染端 useNanjuDelegationToast 启动 5s/30s 阈值计时
 * - phase=done/fail → 渲染端以 success/error Toast 替换 progress Toast（5s 内完成不显示）
 * - phase=timeout → 主进程 delegation-watch 软超时（20min）告警点转发（「仍在处理/可催办」）
 *
 * 纪律（与 nanju-guide-progress.ts 同型）：
 * - 顶部零 import（纯类型 + 纯广播函数），IPC 依赖惰性 require，失败不抛——
 *   IPC 不可用不影响委派主流程；
 * - 生命周期真值源在 agent-collaboration-tools.ts（startDelegation/markDelegationFinished），
 *   本模块只做「已发生事实 → 主窗广播」的转发，不持有任何状态。
 */

/** 委派生命周期相位（timeout 仅为 delegation-watch 软超时告警点转发，非终态） */
export type NanjuDelegationPhase = 'start' | 'done' | 'fail' | 'timeout'

/** nanju:delegation-status 事件载荷（preload 桥与渲染端 hook 同构） */
export interface DelegationStatusEvent {
  /** L1 父会话（渲染端按会话过滤） */
  sessionId: string
  delegationId: string
  childSessionId: string
  phase: NanjuDelegationPhase
  /** 委派标题（Toast 不直接展示，留作扩展与日志） */
  label: string
  startedAt: number
  elapsedMs: number
  /** fail/timeout 的原因摘要（可缺省） */
  reason?: string
}

/** 广播委派状态到主窗（gwt-progress 同型模式；失败静默，不影响主流程） */
export function emitDelegationStatus(event: DelegationStatusEvent): void {
  try {
    const { getMainWindow } = require('./main-window-store') as typeof import('./main-window-store')
    const win = getMainWindow()
    win?.webContents.send('nanju:delegation-status', event satisfies DelegationStatusEvent)
  } catch { /* 主窗口不可用不影响主流程 */ }
}
