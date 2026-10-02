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
// I-P7（B-e）：熔断安抚文案唯一真源（US-U07；F2 模块）——本卡片不再自写一套话术
import { buildCircuitBreakMessage } from './quick-ux-model'

/** nanju:guard-alert 事件载荷（preload 桥同构） */
export interface NanjuGuardAlertPayload {
  sessionId: string
  projectId: string
  stage: string
  message: string
  /** I-P7（B-e）：熔断上下文——存在时按 US-U07 通俗口径渲染（缺失回退 message 原文） */
  mode?: 'quick' | 'iterative'
  /** 同一阶段连续熔断次数（1 起） */
  consecutiveCircuitCount?: number
  /** 是否已回滚到健康快照（D1 已就绪；未尝试/失败一律 false） */
  rolledBack?: boolean
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
  // I-P7：有熔断上下文就用通俗安抚口径（第 1/2 次 vs ≥3 次特化 + 已回滚尾句），
  // 否则回退主进程广播的原文（老版本主进程/其它发射点）。
  const displayMessage = alert.mode
    ? buildCircuitBreakMessage({
        mode: alert.mode,
        consecutiveCircuitCount: alert.consecutiveCircuitCount ?? 1,
        rolledBack: alert.rolledBack === true,
      })
    : alert.message

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
        <div className="break-words">{displayMessage}</div>
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
