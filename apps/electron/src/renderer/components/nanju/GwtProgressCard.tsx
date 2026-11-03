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

import type { NanjuGwtProgressData } from '@proma/shared'
// I-P6（B-e）：通俗汇总行 + 逐场景叙述唯一真源（US-U08；F2 模块 + I 累积器）
import { buildGwtSummaryLine, buildScenarioRows, describeScenarioRow } from './quick-ux-model'
import {
  appendScenarioRow, pickVisibleScenarioRows, scenarioRowSeedFromEvent, type ScenarioRowSeed,
} from './gwt-scenario-rows'
export type { NanjuGwtProgressData } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { describeGwtProgress } from './gwt-progress-state'

/** 渲染端进度卡片最大保留时长（结束后自动隐藏，避免遮挡） */
const DONE_LINGER_MS = 60_000

export function GwtProgressCard({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const [data, setData] = React.useState<NanjuGwtProgressData | null>(null)
  const [doneAt, setDoneAt] = React.useState<number | null>(null)
  const [stopping, setStopping] = React.useState(false)
  const [stopError, setStopError] = React.useState<string | null>(null)
  // I-P6：逐场景种子（事件流累积；无 report IPC 时的唯一可信来源）
  const [scenarioSeeds, setScenarioSeeds] = React.useState<ScenarioRowSeed[]>([])

  React.useEffect(() => {
    setData(null)
    setDoneAt(null)
    setStopping(false)
    setStopError(null)
    setScenarioSeeds([])
    const handler = (event: unknown, payload: NanjuGwtProgressData): void => {
      if (!payload || payload.sessionId !== sessionId) return
      setData(payload)
      if (payload.phase === 'start') {
        setStopping(false)
        setStopError(null)
        setScenarioSeeds([]) // 新轮重跑：清空旧场景行（避免两轮结果叠行）
      }
      // I-P6：scenario-end 事件累积逐场景行（派生失败=无终态/无文本 → 返回 null，不猜）
      const seed = scenarioRowSeedFromEvent(payload)
      if (seed) setScenarioSeeds((prev) => appendScenarioRow(prev, seed))
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

  if (!data) return null
  const { running, title, percent, failed, blocked } = describeGwtProgress(data)
  const stop = async (): Promise<void> => {
    setStopping(true)
    setStopError(null)
    try { await window.electronAPI.stopAgent(sessionId) }
    catch { setStopping(false); setStopError('停止请求失败，请重试。') }
  }

  return (
    <div className={cn(
      'mx-3 mt-2 rounded-md border px-3 py-2 text-[11px] shrink-0',
      running
        ? 'border-primary/40 bg-primary/5'
        : failed || blocked
          ? 'border-red-400/40 bg-red-500/5'
          : 'border-emerald-400/40 bg-emerald-500/5',
    )}>
      <div className="flex items-center gap-1.5">
        <FlaskConical className={cn('size-3 shrink-0', running && 'animate-pulse')} />
        <span className="font-medium shrink-0">
          {title}
        </span>
        <span className="text-muted-foreground tabular-nums shrink-0">
          {/* I-P6：工程测试项按计数展示（口径是「测试项」非「场景」）；普通场景跑完后
              换成通俗汇总行（「我们测试了 N 个场景，全部通过 ✓」/ 部分失败口径）。 */}
          {running || data.scope === 'engineering'
            ? `${data.current}/${data.total} ${data.scope === 'engineering' ? '个测试项' : '个场景'}`
            : buildGwtSummaryLine({ passed: data.passed, failed: data.failed, skipped: data.skipped })}
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
      {running && data.scope === 'engineering' && (
        <Button variant="ghost" size="sm" disabled={stopping} onClick={() => { void stop() }} className="mt-1 h-6 text-xs">
          {stopping ? '正在停止…' : '停止测试及会话'}
        </Button>
      )}
      {stopError && <div role="alert" className="mt-1 text-destructive">{stopError}</div>}
      {!running && data.reason && <div className="mt-1 text-muted-foreground">{data.reason}</div>}
      <div className="mt-1.5 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            failed || blocked ? 'bg-red-400' : 'bg-emerald-500',
            running && 'animate-pulse',
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      {running && data.scenario && (
        <div className="mt-1 truncate text-muted-foreground">
          {data.phase === 'approval' ? '等待批准' : data.phase === 'scenario-start' ? '正在执行' : '已完成'}：{data.scenario}
        </div>
      )}
      {/* I-P6：逐场景通俗行（US-U08）——只在普通场景跑完后展示；失败行优先保留，
          明细仍在 06_TESTS/report-*.md。工程测试项（scope=engineering）不展示（无 US 语义）。 */}
      {!running && data.scope !== 'engineering' && scenarioSeeds.length > 0 && (() => {
        const rows = buildScenarioRows({ scenarios: scenarioSeeds })
        const { visible, hiddenCount } = pickVisibleScenarioRows(rows, 6)
        return (
          <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-muted-foreground">
            {visible.map((row, i) => (
              <div key={`${row.usId}-${i}`} className={cn('truncate', row.status === 'fail' && 'text-red-500')}>
                {describeScenarioRow(row)}
              </div>
            ))}
            {hiddenCount > 0 && <div className="text-[10px]">还有 {hiddenCount} 项，见测试报告明细</div>}
          </div>
        )
      })()}
      {!running && data.skipped > 0 && (
        <div className="mt-1 text-muted-foreground">
          有 {data.skipped} 个{data.scope === 'engineering' ? '测试项未执行或阻塞' : '场景被跳过'}，不计为验收通过，原因见测试报告明细
        </div>
      )}
    </div>
  )
}
