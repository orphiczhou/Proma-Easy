/**
 * 南大 R3（W1）：阶段熔断告警广播（nanju:guard-alert IPC 通道）
 *
 * spec v0.5 交互3「自愈流程关联」（user-flows.md Flow 4）：熔断触发时用户前端必须
 * 可感知——GuardAlertCard 安抚卡片的数据源。
 *
 * 熔断判定真值源：nanju-project.ts isPhaseGuardCircuitOpen（previous closed →
 * current open 的跃迁 = 「本轮新触发」）。本模块只广播已判定的事实，不参与状态机：
 * 发射点全部挂在既有 justOpened 判定块内（agent-orchestrator GWT 结果处理 +
 * delegation-watch 硬超时熔断），只加 emit，不改状态机。
 */

/** nanju:guard-alert 事件载荷（preload 桥与 GuardAlertCard 同构） */
export interface NanjuGuardAlertEvent {
  /** 项目关联的 L1 会话（渲染端按会话过滤展示） */
  sessionId: string
  projectId: string
  stage: string
  message: string
}

/** 安抚文案（spec Flow 4 风格，逐字；按钮交互留 Sprint D L-2，本轮最小版无 [换个方案][先跳过]） */
export const NANJU_GUARD_ALERT_MESSAGE =
  '自动修复多次没有成功，我已暂停自动尝试。你的项目文件都在，随时可以继续。'

/** 广播熔断告警到主窗（gwt-progress 同型模式；失败静默，不影响主流程） */
export function emitGuardAlert(event: NanjuGuardAlertEvent): void {
  try {
    const { getMainWindow } = require('./main-window-store') as typeof import('./main-window-store')
    const win = getMainWindow()
    win?.webContents.send('nanju:guard-alert', event satisfies NanjuGuardAlertEvent)
  } catch { /* 主窗口不可用不影响主流程 */ }
}
