/**
 * GuidePanel — 「向导图」tab 容器（PRD §7）
 *
 * 结构：GuideHeader（项目名/模式/总进度/对照开关）+ 提示条 + GuideFlow（DSL 渲染交互）
 * + StageNodeDetail（阶段详情浮层）+ 底部图例；空态/骨架/错误按 PRD §九切换。
 *
 * 数据：useNanjuGuideData（10s 轮询）→ DSL 由 useMemo 派生（引用相等即不重渲染，轮询零抖动）。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ArrowLeftRight, Eye, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GuideRoutePhase } from '@proma/shared'
import { currentAgentWorkspaceIdAtom, agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { GuideFlow } from './GuideFlow'
import { StageNodeDetail, type GuideSnapshot } from './StageNodeDetail'
import { buildGuideDsl, type GuideNodeTarget, type GuidePhaseId } from './guide-dsl'
import { useNanjuGuideData } from './useNanjuGuideData'

interface GuidePanelProps {
  sessionId: string
}

/** 对照查看的目标阶段状态文案（含终点） */
function describeStageStatus(
  stageStates: Partial<Record<string, string>>,
  phases: GuideRoutePhase[],
): { progress: string; doneCount: number; total: number; currentTitle: string | null } {
  const total = phases.length
  let doneCount = 0
  let currentTitle: string | null = null
  for (const phase of phases) {
    const status = stageStates[phase.id]
    if (status === 'done') doneCount += 1
    if (status === 'current') currentTitle = phase.title
  }
  if (stageStates.delivered === 'done') {
    return { progress: '已交付', doneCount: total, total, currentTitle: null }
  }
  return {
    progress: currentTitle ? `进行中 · ${currentTitle}` : '尚未开始',
    doneCount,
    total,
    currentTitle,
  }
}

export function GuidePanel({ sessionId }: GuidePanelProps): React.ReactElement {
  // workspaceSlug 来源：会话 → 工作区 atoms 解析（修订 Y4，与 SidePanel 同链路）
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const sessionWorkspaceId = sessions.find((session) => session.id === sessionId)?.workspaceId
  const workspaceSlug = workspaces.find(
    (workspace) => workspace.id === (sessionWorkspaceId ?? currentWorkspaceId),
  )?.slug ?? null

  const data = useNanjuGuideData({ sessionId, workspaceSlug })
  const openPreview = useOpenPreview()

  const [selectedPhaseId, setSelectedPhaseId] = React.useState<GuidePhaseId | null>(null)
  /** 对照模式（AC-11）：渲染另一 mode 的静态 DSL（无进度叠加） */
  const [viewMode, setViewMode] = React.useState<'project' | 'compare'>('project')
  const [comparePhases, setComparePhases] = React.useState<GuideRoutePhase[]>([])
  /** MODE 节点点击的模式说明提示条 */
  const [modeBubble, setModeBubble] = React.useState(false)
  /** DONE 节点点击的交付摘要提示条 */
  const [doneBubble, setDoneBubble] = React.useState(false)
  const [isDark, setIsDark] = React.useState(() => document.documentElement.classList.contains('dark'))
  const [snapshots, setSnapshots] = React.useState<GuideSnapshot[]>([])
  const [snapshotsLoading, setSnapshotsLoading] = React.useState(false)
  /** 工作区文件根目录（产出文件绝对路径拼接用） */
  const [workspaceFilesPath, setWorkspaceFilesPath] = React.useState<string | null>(null)

  // 主题切换即时（GuideFlow 自身重渲染 SVG；这里重生成 classDef）
  React.useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  // 工作区文件根目录
  React.useEffect(() => {
    if (!workspaceSlug) return
    let disposed = false
    window.electronAPI.getWorkspaceFilesPath(workspaceSlug)
      .then((path) => { if (!disposed) setWorkspaceFilesPath(path) })
      .catch(() => { if (!disposed) setWorkspaceFilesPath(null) })
    return () => { disposed = true }
  }, [workspaceSlug])

  // 对照模式：按需拉取另一 mode 的路由（DSL 结构必须与 nanju-router 一致，不本地造表）
  const compareMode = data.project?.mode === 'quick' ? 'iterative' : 'quick'
  React.useEffect(() => {
    if (viewMode !== 'compare' || comparePhases.length > 0 || !data.project) return
    void window.electronAPI.nanjuGetRoute(compareMode)
      .then((route) => {
        setComparePhases(((route as GuideRoutePhase[]) ?? []).filter((p) => p.id !== 'delivered'))
      })
      .catch((e: unknown) => console.warn('[向导图] 对照模式路由拉取失败:', e))
  }, [viewMode, compareMode, comparePhases.length, data.project])

  // DSL memo 化（硬约束：字符串 memo 防抖；依赖不变 → 引用相等 → GuideFlow 零重渲染，AC-09）
  const dsl = React.useMemo(() => {
    if (!data.project || data.phases.length === 0) return null
    if (viewMode === 'compare') {
      if (comparePhases.length === 0) return null
      return buildGuideDsl({ mode: compareMode, route: comparePhases, progress: null, isDark })
    }
    return buildGuideDsl({
      mode: data.project.mode,
      route: data.phases,
      progress: {
        stageStates: data.stageStates,
        todoStats: data.todoStats,
        abandoned: data.abandoned,
      },
      isDark,
    })
  }, [data.project, data.phases, data.stageStates, data.todoStats, data.abandoned, viewMode, comparePhases, compareMode, isDark])

  const selectedPhase = selectedPhaseId ? data.phases.find((p) => p.id === selectedPhaseId) ?? null : null

  // 快照列表：详情浮层打开时按需拉取（PRD §8.1）
  React.useEffect(() => {
    if (!selectedPhase || !data.project || !workspaceSlug) { setSnapshots([]); return }
    let disposed = false
    setSnapshotsLoading(true)
    void window.electronAPI.nanjuListSnapshots({ workspaceSlug, projectId: data.project.projectId })
      .then((list) => { if (!disposed) setSnapshots((list as GuideSnapshot[]) ?? []) })
      .catch((e: unknown) => {
        console.warn('[向导图] 快照拉取失败:', e)
        if (!disposed) setSnapshots([])
      })
      .finally(() => { if (!disposed) setSnapshotsLoading(false) })
    return () => { disposed = true }
  }, [selectedPhase, data.project, workspaceSlug])

  // 节点点击分发（§5.2）
  const handleNodeClick = React.useCallback((target: GuideNodeTarget) => {
    setModeBubble(false)
    setDoneBubble(false)
    if (target === 'user') return
    if (target === 'mode') { setModeBubble(true); return }
    if (target === 'done') {
      // 已交付：显示交付摘要；未到达：置灰不可点（无动作）
      if (data.stageStates.delivered === 'done') setDoneBubble(true)
      return
    }
    // 阶段主节点 / AC 子节点：打开阶段详情（子节点定位到所属阶段）
    setSelectedPhaseId(target)
  }, [data.stageStates.delivered])

  // 产出文件 → 右侧分屏预览（与 SidePanel handleFilePreview 同链路）
  const handleOpenPreview = React.useCallback((outputPath: string) => {
    if (!workspaceFilesPath || !data.project) return
    const sep = workspaceFilesPath.includes('\\') && !workspaceFilesPath.includes('/') ? '\\' : '/'
    const filePath = `${workspaceFilesPath}${sep}project-${data.project.projectId}${sep}${outputPath.replace(/\//g, sep)}`
    openPreview(sessionId, { filePath, previewOnly: true })
  }, [workspaceFilesPath, data.project, openPreview, sessionId])

  // 回滚：二次确认由 StageNodeDetail 内联；此处执行并返回是否成功（AC-06/AC-13）
  const handleRollback = React.useCallback(async (snapshotId: number): Promise<boolean> => {
    if (!workspaceSlug || !data.project) return false
    try {
      const result = await window.electronAPI.nanjuRollbackSnapshot({
        workspaceSlug, projectId: data.project.projectId, snapshotId,
      })
      if (!result) return false
      void data.refresh()
      return true
    } catch (e) {
      console.error('[向导图] 快照回滚失败:', e)
      return false
    }
  }, [workspaceSlug, data.project, data.refresh])

  const statusSummary = describeStageStatus(data.stageStates, data.phases)
  const progressPercent = statusSummary.total > 0 ? Math.round((statusSummary.doneCount / statusSummary.total) * 100) : 0

  // ===== 空态 / 骨架 / 错误切换（PRD §九） =====
  let body: React.ReactElement
  if (!workspaceSlug) {
    body = <CenterHint text="等待会话初始化…" />
  } else if (data.error) {
    body = (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground px-4">
        <span>项目数据加载失败：{data.error}</span>
        <button type="button" onClick={data.refresh} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-muted/70">
          <RotateCcw className="size-3" />重试
        </button>
      </div>
    )
  } else if (data.loading && !data.project) {
    body = <SkeletonHint />
  } else if (!data.project) {
    body = (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground px-4 text-center">
        {data.projectDeleted ? (
          <>
            <span>项目已被删除，向导图不再展示。</span>
            <span>如需继续，请从左侧项目列表新建项目。</span>
          </>
        ) : (
          <>
            <span>当前会话未关联南大项目。</span>
            <span>从项目列表打开已有项目，或新建一个项目后回到这里查看流程总图。</span>
          </>
        )}
      </div>
    )
  } else if (data.phases.length === 0 || !dsl) {
    body = <SkeletonHint text="路由加载中…" />
  } else {
    body = (
      <>
        {data.notice && <NoticeBar text={data.notice} tone="info" />}
        {modeBubble && (
          <NoticeBar
            text={`两种模式：快消型 3 步（需求→原型→交付）；长期迭代型 5 步（+架构+规划，AC 审计更强）。点右上「对照」查看另一种模式。`}
            tone="info"
            onClose={() => setModeBubble(false)}
          />
        )}
        {doneBubble && (
          <NoticeBar
            text={`项目已交付。产出文件：${data.phases.map((p) => p.outputPath).join('、')}`}
            tone="success"
            onClose={() => setDoneBubble(false)}
          />
        )}
        {viewMode === 'compare' && (
          <NoticeBar text={`预览另一种模式（${compareMode === 'quick' ? '快消型' : '长期迭代型'}）流程，非本项目进度。`} tone="info" onClose={() => setViewMode('project')} />
        )}
        <div className="flex-1 min-h-0">
          <GuideFlow dsl={dsl} onNodeClick={handleNodeClick} />
        </div>
        {/* 图例（§5.2）：绿=已完成、主色脉冲=进行中、灰=未开始 */}
        <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/40 text-[11px] text-muted-foreground shrink-0">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" />已完成</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-indigo-500 animate-pulse" />进行中</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-gray-400" />未开始</span>
        </div>
      </>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 text-xs">
      {/* GuideHeader：项目名 + 模式 + 总进度 + 对照开关（§4.3/§5.5） */}
      <div className="px-3 pt-2 pb-1.5 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium truncate">{data.project?.name ?? '向导图'}</span>
          {data.project && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {data.project.mode === 'quick' ? '快消型' : '长期迭代型'}
            </span>
          )}
          {data.abandoned && <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已放弃</span>}
          <button
            type="button"
            onClick={() => setViewMode((prev) => (prev === 'project' ? 'compare' : 'project'))}
            disabled={!data.project || data.phases.length === 0}
            title="对照查看另一种模式的流程"
            className={cn(
              'ml-auto shrink-0 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] hover:bg-muted/70 disabled:opacity-40',
              viewMode === 'compare' && 'bg-primary/10 border-primary/40 text-primary',
            )}
          >
            <ArrowLeftRight className="size-3" />对照
          </button>
        </div>
        {data.project && viewMode === 'project' && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 tabular-nums">阶段 {statusSummary.doneCount}/{statusSummary.total} · {statusSummary.progress}</span>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-500', data.abandoned ? 'bg-muted-foreground/40' : 'bg-emerald-500')}
                style={{ width: `${data.abandoned ? 100 : progressPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {body}

      {/* 阶段详情浮层：面板底部上滑 sheet */}
      {selectedPhase && viewMode === 'project' && (
        <StageNodeDetail
          phase={selectedPhase}
          status={data.stageStates[selectedPhase.id as GuidePhaseId] ?? 'pending'}
          todos={data.todosByPhase[selectedPhase.id as GuidePhaseId] ?? []}
          snapshots={snapshots}
          snapshotsLoading={snapshotsLoading}
          onOpenPreview={handleOpenPreview}
          onRollback={handleRollback}
          onClose={() => setSelectedPhaseId(null)}
        />
      )}
    </div>
  )
}

// ===== 局部小组件 =====

function CenterHint({ text }: { text: string }): React.ReactElement {
  return <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs px-4 text-center">{text}</div>
}

function SkeletonHint({ text = '加载中…' }: { text?: string }): React.ReactElement {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
      <div className="w-full max-w-[220px] space-y-2">
        <div className="h-4 rounded bg-muted animate-pulse" />
        <div className="h-16 rounded bg-muted/70 animate-pulse" />
        <div className="h-16 rounded bg-muted/50 animate-pulse" />
        <div className="h-16 rounded bg-muted/30 animate-pulse" />
      </div>
      <div className="flex items-center gap-1 text-muted-foreground"><Eye className="size-3" />{text}</div>
    </div>
  )
}

function NoticeBar({ text, tone, onClose }: { text: string; tone: 'info' | 'success'; onClose?: () => void }): React.ReactElement {
  return (
    <div className={cn(
      'flex items-start gap-1.5 px-3 py-1.5 text-[11px] shrink-0',
      tone === 'info' ? 'bg-primary/10 text-primary' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    )}>
      <span className="flex-1 break-all">{text}</span>
      {onClose && (
        <button type="button" onClick={onClose} className="shrink-0 opacity-70 hover:opacity-100" aria-label="关闭提示">×</button>
      )}
    </div>
  )
}
