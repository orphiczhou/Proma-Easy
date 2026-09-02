/**
 * ProjectDeleteConfirm — 删除确认弹窗（Y5a，W1，spec 交互5「删除流程 - 二次确认」）
 *
 * 内容：危险图标（红色垃圾桶）+「确定要删除「{项目名}」吗？」
 * +「项目及其所有数据将被永久删除，此操作不可撤销。」+ [取消(次要)] [确定删除(危险按钮)]。
 * Escape 关闭（deleting 进行中不关，避免与 IPC 结果竞态）；点击蒙层不关闭（危险操作防误触）。
 * 删除执行（IPC 调用与 Toast）由父组件 ProjectListView 承担，本组件只管确认 UI 与状态机。
 */

import * as React from 'react'
import { Trash2 } from 'lucide-react'
import {
  buildDeleteConfirmTitle,
  DELETE_CONFIRM_WARNING,
} from '@/components/nanju/project-list-logic'

interface ProjectDeleteConfirmProps {
  projectName: string
  /** 删除执行中（按钮禁用 + Escape 不关闭） */
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ProjectDeleteConfirm({
  projectName,
  busy,
  onCancel,
  onConfirm,
}: ProjectDeleteConfirmProps): React.ReactElement {
  // Escape 关闭弹窗（spec 交互5「键盘交互」；busy 时不关）
  React.useEffect(() => {
    if (busy) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [busy, onCancel])

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={buildDeleteConfirmTitle(projectName)}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-content-area p-4 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
            <Trash2 className="size-5 text-red-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground break-words">
              {buildDeleteConfirmTitle(projectName)}
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              {DELETE_CONFIRM_WARNING}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted/70 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          >
            {busy ? '删除中…' : '确定删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
