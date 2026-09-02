/**
 * useNanjuDelegationToast — 委派等待 Toast hook（R1，spec v0.5 交互2）
 *
 * 机制（阈值逻辑全在渲染端，spec 交互2「触发条件/步骤序列」）：
 * - phase=start  → 登记待定操作（后到覆盖前操作并移除其 progress，spec 边界 Case），
 *                   起 5s/30s 两个一次性计时器
 * - 5s 阈值      → 未完成则展示 progress Toast（5s 内完成不显示任何等待提示）
 * - 30s 追加     → 追加 timeout Toast（3.5s 自动消失，progress 保留）
 * - phase=done/fail → progress 已显示则替换为 success/error；未显示（<5s 完成）不提示
 * - phase=timeout（主进程 delegation-watch 软 20min 告警点转发）→ 追加 timeout Toast
 *
 * 阈值状态机 reduceDelegationToastState 纯函数（测试覆盖），hook 只做
 * IPC 订阅 + 计时器 + Toast 命令式驱动（stateRef 镜像读最新态，避免闭包过期）。
 */

import * as React from 'react'
import {
  dismissNanjuToastsByKind,
  showNanjuToast,
  NanjuToastHost,
} from '@/components/nanju/NanjuToast'

/** spec 交互2 触发条件：操作开始后超过 5 秒未返回结果 */
export const DELEGATION_PROGRESS_THRESHOLD_MS = 5_000
/** spec 交互2：超过 30 秒追加 timeout Toast */
export const DELEGATION_TIMEOUT_THRESHOLD_MS = 30_000

/** nanju:delegation-status 事件载荷（preload 桥同构） */
export interface NanjuDelegationStatusPayload {
  sessionId: string
  delegationId: string
  childSessionId: string
  phase: 'start' | 'done' | 'fail' | 'timeout'
  label: string
  startedAt: number
  elapsedMs: number
  reason?: string
}

/** 进行中的待定操作（同一时刻仅跟踪最新一条——后到覆盖前操作） */
export interface DelegationPending {
  delegationId: string
  label: string
  startedAt: number
}

export interface DelegationToastState {
  /** 当前跟踪的待定操作（null = 无进行中委派） */
  pending: DelegationPending | null
  /** 5s 阈值已越过且未完成（progress Toast 应展示） */
  progressVisible: boolean
  /** 30s 阈值已越过且未完成（timeout Toast 应追加） */
  timeoutFired: boolean
}

export type DelegationToastAction =
  | { type: 'start'; delegationId: string; label: string; startedAt: number }
  | { type: 'tick'; now: number }
  | { type: 'settle'; delegationId: string }

export const INITIAL_DELEGATION_TOAST_STATE: DelegationToastState = {
  pending: null,
  progressVisible: false,
  timeoutFired: false,
}

/** 展示去重键（continue_delegation 重派复用 delegationId，以 startedAt 区分轮次） */
export function delegationToastKey(pending: DelegationPending): string {
  return `${pending.delegationId}:${pending.startedAt}`
}

/**
 * 阈值状态机（纯函数）：
 * - start：覆盖前操作（spec「连续多个等待操作→后操作覆盖前操作」），重置两个阈值位
 * - tick：按 now - startedAt 幂等推进 progressVisible（≥5s）/timeoutFired（≥30s）
 * - settle：仅当前跟踪的 delegationId 生效（旧操作晚到 settle 不影响新操作）；
 *     完成后的 success/error 替换逻辑由 hook 按 progressVisible 快照执行
 */
export function reduceDelegationToastState(
  state: DelegationToastState,
  action: DelegationToastAction,
): DelegationToastState {
  switch (action.type) {
    case 'start':
      return {
        pending: { delegationId: action.delegationId, label: action.label, startedAt: action.startedAt },
        progressVisible: false,
        timeoutFired: false,
      }
    case 'tick': {
      if (!state.pending) return state
      const elapsed = action.now - state.pending.startedAt
      const progressVisible = state.progressVisible || elapsed >= DELEGATION_PROGRESS_THRESHOLD_MS
      const timeoutFired = state.timeoutFired || elapsed >= DELEGATION_TIMEOUT_THRESHOLD_MS
      if (progressVisible === state.progressVisible && timeoutFired === state.timeoutFired) return state
      return { ...state, progressVisible, timeoutFired }
    }
    case 'settle':
      if (!state.pending || state.pending.delegationId !== action.delegationId) return state
      return INITIAL_DELEGATION_TOAST_STATE
    default:
      return state
  }
}

/**
 * 委派等待 Toast hook：订阅 nanju:delegation-status（按父会话过滤），
 * 5s/30s 阈值驱动 NanjuToast。挂载于 NanjuWorkspaceView（每会话一份）。
 */
export function useNanjuDelegationToast(sessionId: string): void {
  const [state, dispatch] = React.useReducer(reduceDelegationToastState, INITIAL_DELEGATION_TOAST_STATE)
  /** 最新态镜像（IPC handler 内读，避免闭包过期） */
  const stateRef = React.useRef(state)
  stateRef.current = state
  /** 计时器（settle/覆盖/卸载时清理） */
  const timersRef = React.useRef<Array<ReturnType<typeof setTimeout>>>([])
  /** 本轮已展示的 Toast 去重（key = delegationId:startedAt） */
  const shownRef = React.useRef<{ progressKey: string | null; timeoutKey: string | null }>({ progressKey: null, timeoutKey: null })

  const clearTimers = React.useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer)
    timersRef.current = []
  }, [])

  // 阈值位翻转 → 展示 Toast（progress 常驻；timeout 3.5s 自动消失后 progress 保留）
  React.useEffect(() => {
    if (!state.pending) return
    const key = delegationToastKey(state.pending)
    if (state.progressVisible && shownRef.current.progressKey !== key) {
      shownRef.current.progressKey = key
      showNanjuToast('progress')
    }
    if (state.timeoutFired && shownRef.current.timeoutKey !== key) {
      shownRef.current.timeoutKey = key
      showNanjuToast('timeout')
    }
  }, [state])

  // IPC 订阅（GwtProgressCard 同型 on/off 配对）
  React.useEffect(() => {
    const handler = (event: unknown, payload: NanjuDelegationStatusPayload): void => {
      if (!payload || payload.sessionId !== sessionId) return
      if (payload.phase === 'start') {
        // 覆盖前操作：移除其 progress（spec「移除前操作Toast」）
        if (stateRef.current.progressVisible) dismissNanjuToastsByKind('progress')
        clearTimers()
        dispatch({ type: 'start', delegationId: payload.delegationId, label: payload.label, startedAt: payload.startedAt })
        timersRef.current = [
          setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), DELEGATION_PROGRESS_THRESHOLD_MS),
          setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), DELEGATION_TIMEOUT_THRESHOLD_MS),
        ]
        return
      }
      if (payload.phase === 'done' || payload.phase === 'fail') {
        const current = stateRef.current
        // 仅当前跟踪的操作生效；5s 内完成（progress 未显示）不显示任何提示
        if (current.pending && current.pending.delegationId === payload.delegationId) {
          clearTimers()
          if (current.progressVisible) {
            dismissNanjuToastsByKind('progress')
            showNanjuToast(payload.phase === 'done' ? 'success' : 'error')
          }
        }
        dispatch({ type: 'settle', delegationId: payload.delegationId })
        return
      }
      // phase=timeout：主进程软超时告警点转发（仍未完成，可催办）→ 追加 timeout Toast
      const current = stateRef.current
      if (current.pending && current.pending.delegationId === payload.delegationId) {
        showNanjuToast('timeout')
      }
    }
    window.electronAPI.onNanjuDelegationStatus?.(handler)
    return () => {
      window.electronAPI.offNanjuDelegationStatus?.(handler)
      clearTimers()
      dismissNanjuToastsByKind('progress')
    }
  }, [sessionId, clearTimers])
}

/**
 * 挂载桥：hook + 底部固定 Toast 宿主（AgentView 的 nanju 工作区分支使用）。
 * 背景组件级条件挂载避免条件 hook；NanjuWorkspaceView 内同名挂载保留（该视图接线后一致）。
 */
export function NanjuDelegationToastBridge({ sessionId }: { sessionId: string }): React.ReactElement {
  useNanjuDelegationToast(sessionId)
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <NanjuToastHost />
    </div>
  )
}
