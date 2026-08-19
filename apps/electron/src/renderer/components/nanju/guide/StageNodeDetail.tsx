/**
 * StageNodeDetail — 阶段详情浮层（面板底部上滑 sheet，PRD §5.4）
 *
 * 分区：头部（阶段/角色/模型/状态）、产出文件（open_preview 链路）、
 * AC 审计配置（resolveACActors 解析结果 + requiresAC 硬门禁 + taskWeight 档位）、
 * 阶段 Todo（只读）、快照与回滚（二次确认 + 失败提示，AC-06/AC-13）。
 */

import * as React from 'react'
import { ChevronDown, FileText, History, Loader2, ShieldCheck, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GuideRoutePhase } from '@proma/shared'
import type { StageViewStatus, TodoLike } from './guide-dsl'

/** 快照渲染端投影（主进程 nanju-snapshot.ts ProjectSnapshot 的最小字段面） */
export interface GuideSnapshot {
  snapshotId: number
  timestamp: string
  description: string
  triggerType: string
  isCurrent: boolean
}

interface StageNodeDetailProps {
  phase: GuideRoutePhase
  status: StageViewStatus
  todos: TodoLike[]
  /** 快照列表（父组件打开时按需拉取） */
  snapshots: GuideSnapshot[]
  snapshotsLoading: boolean
  onOpenPreview: (outputPath: string) => void
  onRollback: (snapshotId: number) => Promise<boolean>
  onClose: () => void
}

const STATUS_LABEL: Record<StageViewStatus, string> = {
  done: '已完成',
  current: '进行中',
  pending: '未开始',
}

const STATUS_CLASS: Record<StageViewStatus, string> = {
  done: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  current: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  pending: 'bg-muted text-muted-foreground',
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export function StageNodeDetail({
  phase,
  status,
  todos,
  snapshots,
  snapshotsLoading,
  onOpenPreview,
  onRollback,
  onClose,
}: StageNodeDetailProps): React.ReactElement {
  const [pendingRollbackId, setPendingRollbackId] = React.useState<number | null>(null)
  const [rollbackError, setRollbackError] = React.useState<string | null>(null)
  const [rollbackBusy, setRollbackBusy] = React.useState(false)

  const handleRollback = React.useCallback(async (snapshotId: number) => {
    setRollbackBusy(true)
    setRollbackError(null)
    const ok = await onRollback(snapshotId)
    setRollbackBusy(false)
    if (ok) {
      setPendingRollbackId(null)
    } else {
      // 回滚失败（handler 返回 null，AC-13）：错误提示，不静默
      setRollbackError('回滚失败：快照不存在或已被删除')
    }
  }, [onRollback])

  return (
    <div className="border-t border-border bg-content-area flex flex-col max-h-[60%]">
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className="text-sm font-medium truncate">{phase.title}</span>
        <span className="text-[11px] text-muted-foreground truncate">{phase.role}</span>
        <span className={cn('ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px]', STATUS_CLASS[status])}>
          {STATUS_LABEL[status]}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted/70 hover:text-foreground"
          aria-label="收起阶段详情"
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      <div className="overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {/* 作者渠道/模型 badge（prototype 为运行时解析值，'minimax' 仅家族标记——修订 Y8 披露） */}
        <div className="flex items-center gap-1.5 flex-wrap text-muted-foreground">
          <span>作者：</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-foreground/80">{phase.channel} / {phase.model}</span>
        </div>

        {/* 产出文件 */}
        <section>
          <div className="flex items-center gap-1 mb-1 font-medium text-foreground/80"><FileText className="size-3.5" />产出文件</div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] break-all">{phase.outputPath}</code>
            <button
              type="button"
              onClick={() => onOpenPreview(phase.outputPath)}
              className="shrink-0 rounded border border-border px-1.5 py-0.5 hover:bg-muted/70"
            >
              打开预览
            </button>
          </div>
        </section>

        {/* AC 审计配置（resolveACActors 解析结果，主进程附加——修订 R2） */}
        <section>
          <div className="flex items-center gap-1 mb-1 font-medium text-foreground/80"><ShieldCheck className="size-3.5" />AC 审计配置</div>
          <div className="space-y-1 text-muted-foreground">
            <div>强度：{phase.taskWeight ?? 'medium'}{phase.requiresAC ? ' · AC 结论为推进硬门禁（red 时通知用户）' : ''}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span>攻击者：</span>
              <span className="rounded bg-red-500/10 text-red-600 dark:text-red-400 px-1.5 py-0.5">{phase.acActors.attacker.channel} / {phase.acActors.attacker.model}</span>
              <span>防御者：</span>
              <span className="rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 px-1.5 py-0.5">{phase.acActors.defender.channel} / {phase.acActors.defender.model}</span>
            </div>
            <div className="text-muted-foreground/70">审计由子会话内完成（攻→防裁决→red 修复重审循环），结论详见会话消息</div>
          </div>
        </section>

        {/* 阶段 Todo（只读） */}
        <section>
          <div className="font-medium text-foreground/80 mb-1">阶段 Todo（{todos.filter((t) => t.status === 'completed').length}/{todos.length}）</div>
          {todos.length === 0 ? (
            <div className="text-muted-foreground">暂无（调度员进入阶段后创建「XX阶段：」前缀 Todo）</div>
          ) : (
            <ul className="space-y-1">
              {todos.map((todo, i) => (
                <li key={`${todo.title}-${i}`} className="flex items-center gap-1.5">
                  <span className={cn('size-1.5 rounded-full shrink-0', todo.status === 'completed' ? 'bg-emerald-500' : 'bg-muted-foreground/50')} />
                  <span className={cn('truncate', todo.status === 'completed' && 'line-through text-muted-foreground')}>{todo.title}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 快照与回滚 */}
        <section className="pb-2">
          <div className="flex items-center gap-1 mb-1 font-medium text-foreground/80"><History className="size-3.5" />快照与回滚</div>
          {snapshotsLoading ? (
            <div className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />加载快照…</div>
          ) : snapshots.length === 0 ? (
            <div className="text-muted-foreground">暂无快照</div>
          ) : (
            <ul className="space-y-1">
              {snapshots.map((snapshot) => (
                <li key={snapshot.snapshotId} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground shrink-0 tabular-nums">#{snapshot.snapshotId}</span>
                  <span className="text-muted-foreground shrink-0">{formatTime(snapshot.timestamp)}</span>
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground shrink-0">{snapshot.triggerType}</span>
                  <span className="truncate flex-1" title={snapshot.description}>{snapshot.description}</span>
                  {snapshot.isCurrent && <span className="shrink-0 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">当前</span>}
                  {!snapshot.isCurrent && (
                    pendingRollbackId === snapshot.snapshotId ? (
                      <span className="shrink-0 flex items-center gap-1">
                        <span className="text-destructive">回滚=切到该快照的 fork 会话，确认？</span>
                        <button type="button" disabled={rollbackBusy} onClick={() => void handleRollback(snapshot.snapshotId)} className="rounded bg-destructive px-1.5 py-0.5 text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50">
                          {rollbackBusy ? '回滚中…' : '确认'}
                        </button>
                        <button type="button" disabled={rollbackBusy} onClick={() => { setPendingRollbackId(null); setRollbackError(null) }} className="rounded border border-border px-1.5 py-0.5 hover:bg-muted/70">取消</button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setPendingRollbackId(snapshot.snapshotId); setRollbackError(null) }}
                        className="shrink-0 inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 hover:bg-muted/70"
                      >
                        <Undo2 className="size-3" />回滚到此
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          {rollbackError && <div className="mt-1 text-destructive">{rollbackError}</div>}
        </section>
      </div>
    </div>
  )
}
