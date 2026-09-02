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
import { showNanjuToast } from '@/components/nanju/NanjuToast'
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

/** Y2c（W1，spec 交互3）：回滚成功 Toast 文案「已回到「{描述}」。你随时可以从历史版本中切回来。」 */
export function buildRollbackSuccessToastText(description: string): string {
  return `已回到「${description}」。你随时可以从历史版本中切回来。`
}

/** Y2c（W1，spec 交互3）：确认弹窗标题「确定要回到「{描述}」吗？」 */
export function buildRollbackConfirmTitle(description: string): string {
  return `确定要回到「${description}」吗？`
}

/** Y2c（W1，spec 交互3）：确认弹窗正文（spec 原文，逐字） */
export const ROLLBACK_CONFIRM_BODY = '不会丢失现在的版本。你随时可以从历史版本中切回来。'

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

  /** 待确认回滚的快照描述（Y2c 确认弹窗文案用） */
  const pendingSnapshot = pendingRollbackId != null
    ? snapshots.find((s) => s.snapshotId === pendingRollbackId) ?? null
    : null

  const handleRollback = React.useCallback(async (snapshotId: number) => {
    setRollbackBusy(true)
    setRollbackError(null)
    const snapshot = snapshots.find((s) => s.snapshotId === snapshotId)
    const ok = await onRollback(snapshotId)
    setRollbackBusy(false)
    if (ok) {
      setPendingRollbackId(null)
      // Y2c（W1）：回滚成功 Toast（spec 交互3 原文，rollback 类型 4s 自动消失，复用 R1 Toast 服务）
      if (snapshot) showNanjuToast('rollback', { text: buildRollbackSuccessToastText(snapshot.description) })
    } else {
      // 回滚失败（handler 返回 null，AC-13）：错误提示，不静默（文案保持，不回归）
      setRollbackError('回滚失败：快照不存在或已被删除')
    }
  }, [onRollback, snapshots])

  return (
    <div className="relative border-t border-border bg-content-area flex flex-col max-h-[60%]">
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

        {/* Y2a（W1）：快照与回滚上移至第二位（产出文件之后；spec 交互3 回滚入口置顶），
            确认流程改 spec 式居中弹窗（Y2c：取消/确定回滚 + 心理防御文案），
            Todo 节下移至末尾 */}
        <section>
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
                    <button
                      type="button"
                      onClick={() => { setPendingRollbackId(snapshot.snapshotId); setRollbackError(null) }}
                      className="shrink-0 inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 hover:bg-muted/70"
                    >
                      <Undo2 className="size-3" />回到这个版本
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {rollbackError && <div className="mt-1 text-destructive">{rollbackError}</div>}
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

        {/* 阶段 Todo（只读；Y2a 下移至末尾） */}
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
      </div>

      {/* Y2c（W1，spec 交互3）：回滚确认弹窗——居中 dialog + scaleIn；按钮 [取消][确定回滚]。
          注：本实现回滚语义 = 切到该快照的 fork 会话（原文案语义保留在弹窗正文的心理防御线内） */}
      {pendingSnapshot && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/30 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={buildRollbackConfirmTitle(pendingSnapshot.description)}
        >
          <div className="w-full max-w-sm rounded-lg border border-border bg-content-area p-4 shadow-xl">
            <div className="text-sm font-medium text-foreground">{buildRollbackConfirmTitle(pendingSnapshot.description)}</div>
            <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{ROLLBACK_CONFIRM_BODY}</div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={rollbackBusy}
                onClick={() => { setPendingRollbackId(null); setRollbackError(null) }}
                className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/70 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={rollbackBusy}
                onClick={() => void handleRollback(pendingSnapshot.snapshotId)}
                className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              >
                {rollbackBusy ? '回滚中…' : '确定回滚'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
