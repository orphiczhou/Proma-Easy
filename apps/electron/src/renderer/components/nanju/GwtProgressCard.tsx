/**
 * GwtProgressCard — 南大向导 GWT 验收测试进度卡片（P1 Sprint B）
 *
 * 监听 IPC nanju:gwt-progress（NANJU_PREVIEW_CHANNEL 同型模式），展示场景级进度与
 * 通过率简版卡片（进度+结果）；明细表落在 06_TESTS/report-*.md。
 * 会话匹配（sessionId）时显示；测试结束（phase=done）后短暂保留并淡出。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CheckCircle2, XCircle, SkipForward, FlaskConical } from 'lucide-react'

export interface NanjuGwtProgressData {
  sessionId: string
  projectId: string
  phase: 'start' | 'scenario-start' | 'scenario-end' | 'done'
  current: number
  total: number
  scenario?: string
  scenarioStatus?: 'pass' | 'fail' | 'skip'
  passed: number
  failed: number
  skipped: number
}

/** 渲染端进度卡片最大保留时长（结束后自动隐藏，避免遮挡） */
const DONE_LINGER_MS = 60_000

export function GwtProgressCard({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const [data, setData] = React.useState<NanjuGwtProgressData | null>(null)
  const [doneAt, setDoneAt] = React.useState<number | null>(null)

  React.useEffect(() => {
    const handler = (event: unknown, payload: NanjuGwtProgressData): void => {
      if (!payload || payload.sessionId !== sessionId) return
      setData(payload)
      if (payload.phase === 'done') setDoneAt(Date.now())
      else setDoneAt(null)
    }
    window.electronAPI.onNanjuGwtProgress?.(handler)
    return () => {
      window.electronAPI.offNanjuGwtProgress?.(handler)
    }
  }, [sessionId])

  // 结束后自动隐藏
  React.useEffect(() => {
    if (doneAt == null) return
    const timer = window.setTimeout(() => setData(null), DONE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [doneAt])

  if (!data || data.total <= 0) return null
  const running = data.phase !== 'done'
  const percent = Math.round((data.current / data.total) * 100)

  return (
    <div className={cn(
      'mx-3 mt-2 rounded-md border px-3 py-2 text-[11px] shrink-0',
      running
        ? 'border-primary/40 bg-primary/5'
        : data.failed > 0
          ? 'border-red-400/40 bg-red-500/5'
          : 'border-emerald-400/40 bg-emerald-500/5',
    )}>
      <div className="flex items-center gap-1.5">
        <FlaskConical className={cn('size-3 shrink-0', running && 'animate-pulse')} />
        <span className="font-medium shrink-0">
          {running ? '正在自动验收测试' : data.failed > 0 ? '验收测试未通过' : '验收测试全部通过'}
        </span>
        <span className="text-muted-foreground tabular-nums shrink-0">
          {data.current}/{data.total} 个场景
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0 tabular-nums">
          <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3" />{data.passed}
          </span>
          {data.failed > 0 && (
            <span className="inline-flex items-center gap-0.5 text-red-500">
              <XCircle className="size-3" />{data.failed}
            </span>
          )}
          {data.skipped > 0 && (
            <span className="inline-flex items-center gap-0.5 text-muted-foreground">
              <SkipForward className="size-3" />{data.skipped}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            data.failed > 0 ? 'bg-red-400' : 'bg-emerald-500',
            running && 'animate-pulse',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {running && data.scenario && (
        <div className="mt-1 truncate text-muted-foreground">
          {data.phase === 'scenario-start' ? '正在执行' : '已完成'}：{data.scenario}
        </div>
      )}
      {!running && data.skipped > 0 && (
        <div className="mt-1 text-muted-foreground">
          有 {data.skipped} 个场景被跳过（无法映射到页面元素），明细见测试报告
        </div>
      )}
    </div>
  )
}
