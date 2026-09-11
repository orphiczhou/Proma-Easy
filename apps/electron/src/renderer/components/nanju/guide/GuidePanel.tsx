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
import { ArrowLeftRight, Eye, RotateCcw, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GuideRoutePhase } from '@proma/shared'
import { currentAgentWorkspaceIdAtom, agentWorkspacesAtom, agentSessionsAtom } from '@/atoms/agent-atoms'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { GuideFlow } from './GuideFlow'
import { StageNodeDetail, type GuideSnapshot } from './StageNodeDetail'
import { buildGuideDsl, resolveExpandedPhases, type GuideNodeTarget, type GuidePhaseId } from './guide-dsl'
import { useNanjuGuideData } from './useNanjuGuideData'

interface GuidePanelProps {
  sessionId: string
}

/**
 * Y1（W1，spec 交互4「角色切换过渡」最小版）：阶段角色一句话职责映射表。
 * key = GuideRoutePhase.role（nanju-router 角色 id）；未知角色降级通用文案。
 * 只读映射，状态随 stageStates 派生，不动 DSL。
 */
const ROLE_DUTY_LINES: Record<string, string> = {
  'requirement-analyst': '把你的想法逐条整理成清晰的需求清单',
  'ux-advisor': '设计你能直接点开的界面原型',
  'architect': '为项目搭好合适的技术骨架',
  'engineering-manager': '排出靠谱的开发计划与优先级',
  'fullstack-developer': '把设计变成能跑起来的应用',
  'test-engineer': '替你逐条验收功能是否好用',
}

/** Y1：当前阶段角色状态栏文案「当前阶段：{阶段名} · {角色}（{模型}）——{一句话职责}」 */
function buildStageRoleNotice(
  phases: GuideRoutePhase[],
  stageStates: Partial<Record<string, string>>,
): string | null {
  const current = phases.find((p) => stageStates[p.id] === 'current')
  if (!current) return null
  const duty = ROLE_DUTY_LINES[current.role] ?? '正在推进这个阶段'
  return `当前阶段：${current.title} · ${current.role}（${current.model}）——${duty}`
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

// ===== v2.4「自动补完需求」（auto-clarify）渲染面 =====

/** 代答卡片（主进程 nanju:get-auto-clarify 返回的 answers 元素；与 nanju-ipc NanjuClarifyAnswerCard 同构） */
interface NanjuClarifyAnswerCardView {
  qid: string
  sourceLabel: string
  /** D8（R7-10）：answer=代答 / decision=代决（「代决」标签区分） */
  kind: 'answer' | 'decision'
  channel: string
  questionSummary: string
  answerSummary: string
  durationMs: number | null
  ts: number
  stage: string | null
}

/** auto-clarify 状态视图（nanju:get-auto-clarify 返回） */
interface NanjuClarifyStatusView {
  enabled: boolean
  mode: 'quick' | 'iterative'
  proxyBudget: number | null
  pendingQuestionIds: string[]
  answers: NanjuClarifyAnswerCardView[]
  disabledReason: 'iterative-upgraded' | null
}

/** 代答卡片耗时展示（ms → 秒，保留 1 位；缺失 = 「—」） */
function formatClarifyDuration(durationMs: number | null): string {
  return typeof durationMs === 'number' && durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '—'
}

/**
 * D8（R7-12）：澄清中 sentinel 文案分叉——auto on：「代理澄清中」（语义随代理，
 * blocked 走 clarify-proxy 代答/代决）；auto off：等用户回答。
 * 仅 {主节点}_CLARIFY 子步骤返回文案；其余（含 UC——R7-13：auto 项目由 autoConfirm
 * 放行点写入，渲染无需特判）返回 null 不渲染。
 */
export function buildClarifyNoticeText(subStage: string | null | undefined, autoClarifyEnabled: boolean): string | null {
  if (!subStage || !subStage.endsWith('_CLARIFY')) return null
  return autoClarifyEnabled
    ? '⏳ 代理澄清中：子会话的澄清问题正由 AI 代理作答/代决，无需你操作。'
    : '⏳ 澄清中：子会话有澄清问题等待你回答。'
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
  /**
   * W2 S3 展开集合覆写：null = 默认派生（跟随 current 阶段，无 current 则全折叠，
   * 见 resolveExpandedPhases）；用户点折叠代表框 → 临时多开；阶段推进/切换项目时收敛回默认
   * （用户手动展开的额外集合在推进时刻收敛，不持久化）。
   */
  const [expandedOverride, setExpandedOverride] = React.useState<GuidePhaseId[] | null>(null)
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

  // W2 S1/S3 + W2c/W7（v0.17.69）：进度输入（含 subStage/envState/regressions）+
  // 有效展开集合（默认派生随 current 阶段）
  const guideProgress = React.useMemo(() => ({
    stageStates: data.stageStates,
    todoStats: data.todoStats,
    abandoned: data.abandoned,
    subStage: data.subStage ?? undefined,
    envState: data.envState ?? undefined,
  }), [data.stageStates, data.todoStats, data.abandoned, data.subStage, data.envState])

  /** 当前 current 阶段（推进检测用；无 current = 已交付/放弃/未选模式） */
  const currentPhaseId = React.useMemo(() => {
    for (const p of data.phases) {
      if (data.stageStates[p.id as GuidePhaseId] === 'current') return p.id as GuidePhaseId
    }
    return null
  }, [data.phases, data.stageStates])

  const expandedPhases = React.useMemo(() => {
    // A5 加固（AC 审计 Round 1 随批）：override 仅在包含 current 阶段（或已无 current——
    // 已交付/已放弃的浏览态）时生效——阶段推进瞬间旧 override 不含新 current → 纯派生层
    // 即回落默认展开，消除「effect 异步收敛前一帧展开旧阶段」的错配；用户手动展开集合
    // 含 current 时照常尊重（多开不变）。effect 重置保留作 state 卫生。
    const honorOverride = expandedOverride && (!currentPhaseId || expandedOverride.includes(currentPhaseId))
    return Array.from(resolveExpandedPhases(data.phases, data.project ? guideProgress : null, honorOverride ? expandedOverride : undefined))
  }, [data.phases, data.project, guideProgress, expandedOverride, currentPhaseId])

  // 阶段推进/切换项目：展开集合收敛回默认（跟随新 current；手动多开不跨推进保留）
  React.useEffect(() => { setExpandedOverride(null) }, [currentPhaseId, data.project?.projectId])

  // W2c（v0.17.69）：active 回归边（阶段 id 对，GuideFlow 按 LS/ES class 匹配 SVG 边注入脉冲动画）
  const activeRegressionEdges = React.useMemo(
    () => (data.regressions ?? [])
      .filter((r) => r.active)
      .map((r) => ({ from: r.from, to: r.to })),
    [data.regressions],
  )
  React.useEffect(() => { setExpandedOverride(null) }, [currentPhaseId, data.project?.projectId])

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
      progress: guideProgress,
      expandedPhases,
      regressions: (data.regressions ?? undefined)?.map((r) => ({
        from: r.from as GuidePhaseId,
        to: r.to as GuidePhaseId,
        count: r.count,
        active: r.active,
      })),
      isDark,
    })
  }, [data.project, data.phases, guideProgress, expandedPhases, data.regressions, viewMode, comparePhases, compareMode, isDark])

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
    // W2 S3：点折叠代表框（阶段 target 且当前折叠）→ 展开该阶段，不打开详情浮层；
    // 已展开（或对照模式全展开）→ 维持现行为打开阶段详情浮层
    if (viewMode === 'project' && !expandedPhases.includes(target)) {
      setExpandedOverride([...expandedPhases, target])
      return
    }
    // 阶段主节点 / AC 子节点：打开阶段详情（子节点定位到所属阶段）
    setSelectedPhaseId(target)
  }, [data.stageStates.delivered, expandedPhases, viewMode])

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
  // Y1（W1）：当前阶段角色状态栏文案（无 current 阶段 → 不显示）
  const stageRoleNotice = React.useMemo(
    () => buildStageRoleNotice(data.phases, data.stageStates),
    [data.phases, data.stageStates],
  )

  // ===== v2.4：自动补完需求（auto-clarify）状态面 =====
  /** 项目级开启态（宽类型访问：A 域 NanjuProject.autoClarify 字段投影随全量 JSON 到达） */
  const autoClarifyEnabled = data.project?.mode === 'quick'
    && (data.project as { autoClarify?: { enabled?: boolean } }).autoClarify?.enabled === true
  // D8（R7-12）：澄清中 sentinel 文案（auto on=代理澄清中 / off=等用户；非 CLARIFY 态 null）
  const clarifySentinelNotice = buildClarifyNoticeText(data.subStage, autoClarifyEnabled)
  const [clarifyOpen, setClarifyOpen] = React.useState(false)
  const [clarifyStatus, setClarifyStatus] = React.useState<NanjuClarifyStatusView | null>(null)
  /** 关闭/升级处置结果提示（主进程 D7 §7 处置计划的 notice） */
  const [clarifyNotice, setClarifyNotice] = React.useState<string | null>(null)

  const refreshClarify = React.useCallback(() => {
    if (!workspaceSlug || !data.project) return
    void window.electronAPI.nanjuGetAutoClarify({ workspaceSlug, projectId: data.project.projectId })
      .then((status) => { setClarifyStatus((status as NanjuClarifyStatusView) ?? null) })
      .catch((e: unknown) => console.warn('[向导图] auto-clarify 状态拉取失败:', e))
  }, [workspaceSlug, data.project])

  // 展开时拉取 + 代答事件流实时刷新 + 10s 轮询兑底（页面隐藏容忍：轻量状态面）
  React.useEffect(() => {
    if (!clarifyOpen) return
    refreshClarify()
    const offEvent = window.electronAPI.onNanjuClarifyEvent(() => { refreshClarify() })
    const timer = window.setInterval(() => { refreshClarify() }, 10_000)
    return () => { offEvent(); window.clearInterval(timer) }
  }, [clarifyOpen, refreshClarify])

  /** 关闭自动补完（D7 §7：in-flight stop + pending 转述 + 字段处置，主进程执行） */
  const handleDisableAutoClarify = React.useCallback(() => {
    if (!workspaceSlug || !data.project) return
    void window.electronAPI.nanjuSetAutoClarify({ workspaceSlug, projectId: data.project.projectId, enabled: false })
      .then((result) => {
        const r = result as { ok?: boolean; notice?: string | null; error?: string }
        if (r?.notice) setClarifyNotice(r.notice)
        else if (r?.ok === false && r?.error) setClarifyNotice(`关闭失败：${r.error}`)
        refreshClarify()
        data.refresh()
      })
      .catch((e: unknown) => {
        console.error('[向导图] 关闭自动补完失败:', e)
        setClarifyNotice('关闭失败，请稍后重试。')
      })
  }, [workspaceSlug, data.project, refreshClarify, data.refresh])

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
        {/* Y1（W1）：项目进行中的角色状态栏（与 data.notice 互斥——abandoned/未知阶段等
            异常态优先；文案随 stageStates 派生，spec 交互4 最小版） */}
        {!data.notice && viewMode === 'project' && stageRoleNotice && (
          <NoticeBar text={stageRoleNotice} tone="info" />
        )}
        {viewMode === 'project' && clarifySentinelNotice && (
          <NoticeBar text={clarifySentinelNotice} tone="info" />
        )}
        {modeBubble && (
          <NoticeBar
            text={`两种模式：快消型 4 步（需求→原型→开发→测试）；长期迭代型 6 步（+架构+规划，AC 审计更强）。点右上「对照」查看另一种模式。`}
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
          <GuideFlow dsl={dsl} onNodeClick={handleNodeClick} activeRegressionEdges={activeRegressionEdges} divergences={data.divergences ?? undefined} />
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
          {/* v2.4：auto 开启徽标（仅快消型；点击展开代答卡片与开关） */}
          {autoClarifyEnabled && (
            <button
              type="button"
              onClick={() => { setClarifyOpen((prev) => !prev); setClarifyNotice(null) }}
              title="自动补完需求已开启：点击查看代答记录与开关"
              className={cn(
                'shrink-0 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]',
                'bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25',
                clarifyOpen && 'ring-1 ring-amber-500/40',
              )}
            >
              <Sparkles className="size-3" />自动进行中
            </button>
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

      {/* v2.4：自动补完需求面板（徽标点击展开；代答卡片 + 开关 + 升级禁用提示） */}
      {clarifyOpen && data.project && workspaceSlug && (
        <div className="border-t border-border/50 px-3 py-2 space-y-2 shrink-0 max-h-64 overflow-y-auto text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium inline-flex items-center gap-1"><Sparkles className="size-3 text-amber-500" />自动补完需求</span>
            {clarifyStatus?.disabledReason === 'iterative-upgraded' ? (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已停用（升级长期迭代型）</span>
            ) : clarifyStatus?.enabled ? (
              <>
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">运行中</span>
                <button
                  type="button"
                  onClick={handleDisableAutoClarify}
                  className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 hover:bg-muted/70"
                >
                  关闭
                </button>
              </>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已关闭</span>
            )}
          </div>
          {clarifyStatus?.disabledReason === 'iterative-upgraded' && (
            <p className="text-muted-foreground">
              已升级为长期迭代型，自动补完需求已停用；代答日志已归档（_nanju-clarify-log.archived.jsonl），后续问题由子会话直接问你。
            </p>
          )}
          {clarifyNotice && <p className="rounded bg-primary/10 px-2 py-1 text-primary break-all">{clarifyNotice}</p>}
          {clarifyStatus && clarifyStatus.pendingQuestionIds.length > 0 && (
            <p className="text-muted-foreground">待处理问题 {clarifyStatus.pendingQuestionIds.length} 个（代理处理中或待转述）</p>
          )}
          {/* 代答卡片：渠道 + 问题要点 + 答案要点 + 来源标签 + 耗时 */}
          {(clarifyStatus?.answers ?? []).length === 0 ? (
            <p className="text-muted-foreground">暂无代答记录。</p>
          ) : (
            <div className="space-y-1.5">
              {(clarifyStatus?.answers ?? []).map((card) => (
                <div key={card.qid} className="rounded border border-border/60 px-2 py-1.5 space-y-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{card.channel}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{card.sourceLabel}</span>
                    {card.kind === 'decision' && (
                      <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:text-indigo-400">代决</span>
                    )}
                    {card.stage && <span className="text-[10px] text-muted-foreground">{card.stage}阶段</span>}
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{formatClarifyDuration(card.durationMs)}</span>
                  </div>
                  <p className="text-foreground/90 break-all">问：{card.questionSummary || '—'}</p>
                  <p className="text-muted-foreground break-all">答：{card.answerSummary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
