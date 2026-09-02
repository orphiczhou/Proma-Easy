/**
 * GuardAlertCard — 阶段熔断感知卡片（R3，spec v0.5 交互3「自愈流程关联」/ Flow 4）
 *
 * 熔断新触发（isPhaseGuardCircuitOpen closed→open 跃迁）时主进程广播
 * nanju:guard-alert；本卡片按父会话过滤后置顶展示安抚文案 + 「查看会话」跳转，
 * 用户手动关闭（无自动消失）。
 * 本轮最小版无 [换个方案][先跳过这个功能] 按钮——按钮交互留 Sprint D L-2（工单注明）。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { getDefaultStore } from 'jotai'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'

/** nanju:guard-alert 事件载荷（preload 桥同构） */
export interface NanjuGuardAlertPayload {
  sessionId: string
  projectId: string
  stage: string
  message: string
}

/** 阶段名映射（展示用；与 STAGE_LABELS 口径一致的本地最小面） */
const STAGE_LABELS: Record<string, string> = {
  requirements: '需求分析',
  prototype: '原型设计',
  architecture: '架构设计',
  planning: '工程规划',
  coding: '开发中',
  testing: '测试中',
}

/** 「查看会话」：打开/聚焦该会话 Tab（TabContent 同型 getDefaultStore 模式） */
function openSessionTab(sessionId: string): void {
  try {
    const store = getDefaultStore()
    const result = openTab(store.get(tabsAtom), {
      type: 'agent',
      sessionId,
      title: `会话 ${sessionId.slice(0, 8)}`,
    })
    store.set(tabsAtom, result.tabs)
    store.set(activeTabIdAtom, result.activeTabId)
  } catch (e) {
    console.warn('[南大熔断] 查看会话跳转失败:', e)
  }
}

export function GuardAlertCard({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const [alert, setAlert] = React.useState<NanjuGuardAlertPayload | null>(null)

  React.useEffect(() => {
    const handler = (event: unknown, payload: NanjuGuardAlertPayload): void => {
      if (!payload || payload.sessionId !== sessionId) return
      setAlert(payload)
    }
    window.electronAPI.onNanjuGuardAlert?.(handler)
    return () => {
      window.electronAPI.offNanjuGuardAlert?.(handler)
    }
  }, [sessionId])

  // 会话切换时清场（旧会话的熔断卡片不跨会话残留）
  React.useEffect(() => { setAlert(null) }, [sessionId])

  if (!alert) return null
  const stageLabel = STAGE_LABELS[alert.stage] ?? alert.stage

  return (
    <div
      role="alert"
      className={cn(
        'mx-3 mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-relaxed shrink-0',
        'border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300',
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="break-words">{alert.message}</div>
        <div className="mt-0.5 text-muted-foreground">
          阶段「{stageLabel}」已暂停自动尝试（项目文件未删除）。
        </div>
      </div>
      <button
        type="button"
        onClick={() => openSessionTab(alert.sessionId)}
        className="shrink-0 inline-flex items-center gap-1 rounded border border-amber-400/50 px-1.5 py-0.5 hover:bg-amber-500/15"
      >
        <ExternalLink className="size-3" />查看会话
      </button>
      <button
        type="button"
        onClick={() => setAlert(null)}
        aria-label="关闭熔断告警"
        className="shrink-0 opacity-70 hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
