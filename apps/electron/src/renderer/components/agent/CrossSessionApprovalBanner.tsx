/**
 * CrossSessionApprovalBanner — 跨会话待审批/待回答全局聚合提示横幅（NEXT-03 / P1-2）
 *
 * 痛点：PermissionBanner / AskUserBanner 只渲染当前激活会话的队列。后台子会话
 * （树 Worker、委派会话）触发权限审批或 AskUser 阻塞时，用户停留主会话 Tab
 * 完全无感知（实测后台停滞 17 分钟零提示，GWT 假性「静默卡死」）。
 *
 * 本横幅挂在 AgentView（NanjuWorkspaceView 复用 AgentView 自动覆盖）的
 * PermissionBanner 正上方，展示「所有非当前会话」的待决请求摘要：
 * - permission（非 dangerous）：展示工具名 + sdkTitle + 命令内容后，支持内联
 *   「直接允许 / 拒绝」（respondPermission 按 requestId 全局解析，主进程不校验
 *   激活会话，跨会话响应天然可行）；
 * - permission（dangerous）：只保留「跳转会话」——危险审批必须在原会话展示的
 *   完整上下文中知情处理，禁止跨会话盲批（审计 B-1 安全基线）；
 * - askUser / exitPlanMode：无法替用户作答，只提供「跳转会话」；
 * - 所有条目均可跳转（useOpenSession → openTab 复用真实 Tab 机制）。
 *
 * 键盘：不绑定全局 Enter 快捷键——当前会话 PermissionBanner 已占用 Enter，
 * 双横幅并存时全局 Enter 会产生语义冲突；本横幅按钮可通过 Tab 聚焦 + Enter 触发。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ShieldAlert, Shield, ExternalLink, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  allPendingPermissionRequestsAtom,
  canInlineRespondCrossSession,
  crossSessionPendingApprovalsAtom,
} from '@/atoms/agent-atoms'
import { formatToolName } from './PermissionBanner'
import { useOpenSession } from '@/hooks/useOpenSession'

export function CrossSessionApprovalBanner(): React.ReactElement | null {
  const approvals = useAtomValue(crossSessionPendingApprovalsAtom)
  const setAllRequests = useSetAtom(allPendingPermissionRequestsAtom)
  const openSession = useOpenSession()
  const [responding, setResponding] = React.useState(false)

  // 空状态：无后台阻塞时完全不渲染（不占布局）
  if (approvals.length === 0) return null

  const top = approvals[0]!
  // 计数按去重会话数（同一会话 permission+askUser 双条不重复报数，审计 B-4）
  const restSessionCount = new Set(approvals.map((a) => a.sessionId)).size - 1
  const isPermission = top.kind === 'permission'
  const isDangerous = top.dangerLevel === 'dangerous'
  const showInlineActions = canInlineRespondCrossSession(top)
  const toolLabel = top.sdkDisplayName ?? (top.toolName ? formatToolName(top.toolName) : undefined)
  // 危险操作用警示图标，普通操作用盾牌（与 PermissionBanner 的等级图标语义一致）
  const IconComponent = isPermission && isDangerous ? ShieldAlert : Shield

  /** 内联响应后台权限请求；成功后乐观出队（permission_resolved 事件到达时幂等兜底） */
  const respond = async (behavior: 'allow' | 'deny'): Promise<void> => {
    if (responding) return
    setResponding(true)
    try {
      await window.electronAPI.respondPermission({
        requestId: top.requestId,
        behavior,
        alwaysAllow: false,
      })
      setAllRequests((prev) => {
        const queue = prev.get(top.sessionId)
        if (!queue) return prev
        const map = new Map(prev)
        const next = queue.filter((r) => r.requestId !== top.requestId)
        if (next.length === 0) map.delete(top.sessionId)
        else map.set(top.sessionId, next)
        return map
      })
    } catch (error) {
      console.error('[CrossSessionApprovalBanner] 响应后台权限请求失败:', error)
    } finally {
      setResponding(false)
    }
  }

  /** 跳转到阻塞会话（复用统一 openTab 机制，恢复该会话视图状态） */
  const handleJump = (): void => {
    openSession('agent', top.sessionId, top.sessionTitle)
  }

  return (
    <div
      role="region"
      aria-label="跨会话待审批"
      className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground shadow-sm"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <IconComponent
            className={`size-4 shrink-0 ${isPermission && isDangerous ? 'text-amber-500' : 'text-amber-600/80'}`}
            aria-hidden="true"
          />
          {/* 摘要文案：aria-live 仅包裹文本，按钮操作不触发播报（审计 B-5） */}
          <span aria-live="polite" className="truncate text-amber-700 dark:text-amber-300">
            {isPermission ? (
              <>
                后台会话 <strong className="font-medium">「{top.sessionTitle}」</strong> 正在请求执行工具{' '}
                {toolLabel && <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{toolLabel}</code>}
                {isDangerous && <span className="ml-1 font-medium">（危险操作，需跳转会话确认）</span>}
              </>
            ) : top.kind === 'askUser' ? (
              <>
                后台会话 <strong className="font-medium">「{top.sessionTitle}」</strong> 正在等待你的问题确认
              </>
            ) : (
              <>
                后台会话 <strong className="font-medium">「{top.sessionTitle}」</strong> 的计划等待审批
              </>
            )}
            {top.pendingCount > 1 && <span className="ml-1 text-muted-foreground">（该会话共 {top.pendingCount} 项）</span>}
            {restSessionCount > 0 && <span className="ml-1 text-muted-foreground">另有 {restSessionCount} 个后台会话待处理</span>}
          </span>
        </div>

        {/* 审批上下文（permission 专用）：sdkTitle + 截断命令——跨会话响应必须可见操作内容（审计 B-1） */}
        {isPermission && (top.sdkTitle || top.command) && (
          <div className="min-w-0 pl-6">
            {top.sdkTitle && <p className="truncate text-[11px] text-foreground/80">{top.sdkTitle}</p>}
            {top.command && (
              <pre
                className="mt-0.5 max-h-12 overflow-y-auto whitespace-pre-wrap break-all rounded bg-background/50 px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/80"
                title={top.command}
              >
                {top.command}
              </pre>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {showInlineActions && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 border-green-500/40 px-2 text-[11px] hover:bg-green-500/10"
              disabled={responding}
              onClick={() => { void respond('allow') }}
            >
              <Check className="size-3 text-green-500" />
              直接允许
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 gap-1 border-red-500/40 px-2 text-[11px] hover:bg-red-500/10"
              disabled={responding}
              onClick={() => { void respond('deny') }}
            >
              <X className="size-3 text-red-500" />
              拒绝
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={handleJump}
        >
          跳转会话
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
