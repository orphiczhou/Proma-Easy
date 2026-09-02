/**
 * NanjuToast — 南大向导 Toast 服务（R1，spec v0.5 交互2）
 *
 * 五类 + info：progress（旋转 spinner，不自动消失）/ success（✓）/ error（⚠）/
 * rollback（↩）/ timeout（⏳）/ info（ℹ）。文案逐字取自 spec 交互2「精确文案」列
 * （PRD §7.5 原文）；自动消失时长按 spec（3.5-4s；progress 由完成/失败事件主动移除）。
 *
 * 机制：模块级极简 store（数组 + Set<listener>）+ useSyncExternalStore 订阅；
 * 任意组件可调用 showNanjuToast / dismissNanjuToastsByKind 命令式驱动
 * （Y2c 回滚成功 Toast、Y5a 删除成功 Toast 复用同一服务）。
 * 呈现：底部固定位置（非对话流气泡），背景色按 spec Token 映射
 * （info/success 系 → blue/emerald；warning 系（error/rollback/timeout）→ amber）。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { AlertTriangle, CheckCircle2, Hourglass, Info, Loader2, Undo2 } from 'lucide-react'

// ===== 类型与 spec 常量（逐字） =====

export type NanjuToastKind = 'progress' | 'success' | 'error' | 'rollback' | 'timeout' | 'info'

/** spec v0.5 交互2 五类精确文案（progress/success/error/rollback/timeout；info 为自定义消息载体） */
export const NANJU_TOAST_TEXT: Record<Exclude<NanjuToastKind, 'info'>, string> = {
  progress: '我正在帮你生成可运行的版本，这个过程只发生在安全环境里，不会影响你的电脑文件。',
  success: '改好了，你看看效果？不满意随时告诉我。',
  error: '刚才的修改没有成功，我已经帮你回到上一个正常版本，你的内容没有丢失。我们换个思路试试？',
  rollback: '已经回到之前的版本了，一切都在。要继续的话随时告诉我。',
  timeout: '这次操作花了比预期更长的时间，我还在处理中。如果等太久，你可以催我。',
}

/** 自动消失时长（ms；progress 不自动消失——由完成/失败事件主动移除；spec 3.5-4s） */
export const NANJU_TOAST_DURATION_MS: Record<NanjuToastKind, number | null> = {
  progress: null,
  success: 4000,
  error: 3500,
  rollback: 4000,
  timeout: 3500,
  info: 3000,
}

export interface NanjuToastItem {
  id: number
  kind: NanjuToastKind
  text: string
}

// ===== 模块级极简 store =====

let nextToastId = 1
let toastItems: NanjuToastItem[] = []
const toastListeners = new Set<() => void>()

function emitToastChange(): void {
  for (const listener of toastListeners) {
    try { listener() } catch { /* 订阅者异常不影响服务 */ }
  }
}

function getToastSnapshot(): NanjuToastItem[] {
  return toastItems
}

function subscribeToasts(listener: () => void): () => void {
  toastListeners.add(listener)
  return () => { toastListeners.delete(listener) }
}

/**
 * 展示一条 Toast（同 kind 自动替换旧的——progress 被 success/error 替换的语义
 * 由调用方 dismiss+show 完成，本函数只做「展示」原语）。
 * 返回 toast id（自动消失计时由 Host 侧负责）。
 */
export function showNanjuToast(kind: NanjuToastKind, opts: { text?: string } = {}): number {
  const id = nextToastId++
  const text = opts.text ?? (kind === 'info' ? '' : NANJU_TOAST_TEXT[kind])
  toastItems = [...toastItems, { id, kind, text }]
  emitToastChange()
  return id
}

/** 按 id 移除（不存在时静默） */
export function dismissNanjuToast(id: number): void {
  if (!toastItems.some((t) => t.id === id)) return
  toastItems = toastItems.filter((t) => t.id !== id)
  emitToastChange()
}

/** 按 kind 移除全部（如 settle 时移除 progress） */
export function dismissNanjuToastsByKind(kind: NanjuToastKind): void {
  if (!toastItems.some((t) => t.kind === kind)) return
  toastItems = toastItems.filter((t) => t.kind !== kind)
  emitToastChange()
}

/** 订阅 hook（useSyncExternalStore；快照引用稳定，未变化零重渲染） */
export function useNanjuToasts(): NanjuToastItem[] {
  return React.useSyncExternalStore(subscribeToasts, getToastSnapshot, getToastSnapshot)
}

// ===== 呈现（底部固定） =====

const TOAST_STYLE: Record<NanjuToastKind, { icon: React.ReactNode; className: string }> = {
  progress: {
    icon: <Loader2 className="size-4 shrink-0 animate-spin" />,
    className: 'border-blue-400/40 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  },
  success: {
    icon: <CheckCircle2 className="size-4 shrink-0" />,
    className: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  },
  error: {
    icon: <AlertTriangle className="size-4 shrink-0" />,
    className: 'border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  rollback: {
    icon: <Undo2 className="size-4 shrink-0" />,
    className: 'border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  timeout: {
    icon: <Hourglass className="size-4 shrink-0" />,
    className: 'border-amber-400/50 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  },
  info: {
    icon: <Info className="size-4 shrink-0" />,
    className: 'border-blue-400/40 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  },
}

function ToastRow({ item }: { item: NanjuToastItem }): React.ReactElement {
  const style = TOAST_STYLE[item.kind]
  // 自动消失（progress 为 null 不计时；计时中 toast 被替换不影响其余）
  React.useEffect(() => {
    const duration = NANJU_TOAST_DURATION_MS[item.kind]
    if (duration == null) return
    const timer = window.setTimeout(() => dismissNanjuToast(item.id), duration)
    return () => { window.clearTimeout(timer) }
  }, [item.id, item.kind])

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto flex max-w-[min(92vw,520px)] items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs leading-relaxed shadow-lg backdrop-blur-sm',
        style.className,
      )}
    >
      {style.icon}
      <span className="flex-1 break-words">{item.text}</span>
    </div>
  )
}

/**
 * Toast 宿主：底部固定渲染当前 Toast 栈（叠加展示——progress 常驻 + timeout 追加等）。
 * 挂载于 nanju 工作区左栏（NanjuWorkspaceView）；容器定位由挂载点决定。
 */
export function NanjuToastHost(): React.ReactElement | null {
  const toasts = useNanjuToasts()
  if (toasts.length === 0) return null
  return (
    <div className="flex w-full flex-col items-center gap-1.5">
      {toasts.map((item) => <ToastRow key={item.id} item={item} />)}
    </div>
  )
}
