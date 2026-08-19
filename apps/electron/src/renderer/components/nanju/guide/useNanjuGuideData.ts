/**
 * useNanjuGuideData — 向导图数据 hook
 *
 * 数据流（PRD §8）：
 * - 路由结构：nanjuGetRoute(mode)（主进程单一真相源 + AC 攻防解析，mode 不变不重拉）
 * - 项目与进度：nanjuListProjects(workspaceSlug)（_nanju-projects.json）挂载拉取 + 10s 轮询兜底
 * - Todo 完成度：listTodos() → sessionLinks 含调度员 sessionId 过滤 → 标题前缀归类
 * - workspaceSlug 来源：SidePanel 从 currentAgentWorkspaceIdAtom → agentWorkspacesAtom 解析后传入（修订 Y4）
 *
 * 轮询策略（PRD §8.2）：10s 周期；页面隐藏时跳过；组件卸载（tab 切走）即清理定时器。
 * 项目锁定（修订 Y7）：一旦匹配到项目，轮询中项目消失时不静默切换到其他项目，提示「项目已删除」。
 */

import * as React from 'react'
import type { GuideRoutePhase } from '@proma/shared'
import {
  computeStageStates,
  computeTodoStats,
  type GuideMode,
  type GuidePhaseId,
  type StageViewStatus,
} from './guide-dsl'

/** 轮询周期（ms）：进度数据轻量、变化低频，取 10s（TreeViewPanel 3s 轮询先例的降频版） */
const POLL_INTERVAL_MS = 10_000

/** 渲染端使用的项目投影（_nanju-projects.json NanjuProject 的最小字段面） */
export interface NanjuGuideProject {
  projectId: string
  name: string
  mode: GuideMode
  status: string
  currentStage: string
  sessionId?: string
  updatedAt: string
}

export interface NanjuGuideData {
  /** 当前匹配的项目；null 表示空态/错误 */
  project: NanjuGuideProject | null
  /** 过滤哨兵后的路由阶段（id='delivered' 已剔除，修订 Y3） */
  phases: GuideRoutePhase[]
  stageStates: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>>
  abandoned: boolean
  /** Header 追加提示条文案 */
  notice: string | null
  todoStats: ReturnType<typeof computeTodoStats>['stats']
  todosByPhase: ReturnType<typeof computeTodoStats>['todosByPhase']
  loading: boolean
  /** 数据错误（_nanju-projects.json 读取失败/route IPC 失败等，用于骨架+重试态） */
  error: string | null
  /** 轮询期间项目被删除（不静默切换，修订 Y7） */
  projectDeleted: boolean
  /** 手动重试入口（错误态按钮） */
  refresh: () => void
}

export interface UseNanjuGuideDataOptions {
  sessionId: string
  workspaceSlug: string | null
}

export function useNanjuGuideData({ sessionId, workspaceSlug }: UseNanjuGuideDataOptions): NanjuGuideData {
  const [project, setProject] = React.useState<NanjuGuideProject | null>(null)
  const [phases, setPhases] = React.useState<GuideRoutePhase[]>([])
  const [todoStats, setTodoStats] = React.useState<NanjuGuideData['todoStats']>({})
  const [todosByPhase, setTodosByPhase] = React.useState<NanjuGuideData['todosByPhase']>({})
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [projectDeleted, setProjectDeleted] = React.useState(false)
  /** 请求序号：防止轮询竞态（慢响应覆盖新响应） */
  const fetchSeqRef = React.useRef(0)
  /** 已锁定的 projectId：项目消失后不 fallback 到其他项目（修订 Y7） */
  const lockedProjectIdRef = React.useRef<string | null>(null)

  const fetchOnce = React.useCallback(async () => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      // 1. 项目列表 → 匹配当前会话（sessionId 匹配优先；无匹配取最新 active，多项目并存先例 PRD §12.7）
      const projects = (await window.electronAPI.nanjuListProjects(workspaceSlug)) as NanjuGuideProject[]
      if (seq !== fetchSeqRef.current) return
      if (!Array.isArray(projects)) throw new Error('项目数据格式异常')

      let matched: NanjuGuideProject | null =
        projects.find((p) => p.sessionId === sessionId && p.status !== 'abandoned') ?? null
      // 锁定记忆：sessionId 匹配消失且曾锁定 → 不静默切换其他项目（修订 Y7）
      if (!matched) {
        if (lockedProjectIdRef.current && projects.some((p) => p.projectId === lockedProjectIdRef.current)) {
          // 轮询期间 sessionId 关联可能变更（如回滚切到 fork 会话）：仍按 projectId 跟踪
          matched = projects.find((p) => p.projectId === lockedProjectIdRef.current) ?? null
        } else if (!lockedProjectIdRef.current) {
          matched = projects.filter((p) => p.status === 'active').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0] ?? null
        }
        // 曾锁定但项目已删除 → projectDeleted
        if (!matched && lockedProjectIdRef.current) {
          setProjectDeleted(true)
          setProject(null)
          setLoading(false)
          return
        }
      } else {
        lockedProjectIdRef.current = matched.projectId
        setProjectDeleted(false)
      }
      setProject(matched)
      setError(null)

      // 2. Todo 完成度（同轮询周期）：sessionLinks 含调度员 sessionId 过滤 + 标题前缀归类
      const todos = await window.electronAPI.listTodos()
      if (seq !== fetchSeqRef.current) return
      const mine = todos.filter((todo) => todo.sessionLinks?.some((link) => link.sessionId === sessionId))
      const { stats, todosByPhase: byPhase } = computeTodoStats(mine)
      setTodoStats(stats)
      setTodosByPhase(byPhase)

      // 3. 路由结构：mode 确定后拉取一次；mode 不变不重拉（PRD §8.1，拉取在下方 routeModeRef effect 中统一处理）
      if (!matched) {
        setPhases([])
      }
    } catch (e) {
      if (seq !== fetchSeqRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [sessionId, workspaceSlug])

  // mode 变化（理论上仅一次）时重拉路由
  const routeModeRef = React.useRef<GuideMode | null>(null)
  React.useEffect(() => {
    if (!project || routeModeRef.current === project.mode) return
    routeModeRef.current = project.mode
    void window.electronAPI.nanjuGetRoute(project.mode)
      .then((route) => {
        setPhases(((route as GuideRoutePhase[]) ?? []).filter((p) => p.id !== 'delivered'))
      })
      .catch((e: unknown) => {
        console.warn('[向导图] 获取路由失败:', e)
      })
  }, [project])

  // 挂载拉取 + 10s 轮询；页面隐藏跳过；卸载清理（AC-09）
  React.useEffect(() => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    void fetchOnce()
    const timer = window.setInterval(() => {
      if (document.hidden) return
      void fetchOnce()
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [fetchOnce, workspaceSlug])

  // 派生：三态 + 提示（纯函数，guide-dsl.test.ts 覆盖）
  const stageDerived = React.useMemo(() => {
    if (!project || phases.length === 0) {
      return { stageStates: {}, abandoned: false, notice: null as string | null }
    }
    return computeStageStates(project, phases)
  }, [project, phases])

  return {
    project,
    phases,
    stageStates: stageDerived.stageStates,
    abandoned: stageDerived.abandoned,
    notice: stageDerived.notice,
    todoStats,
    todosByPhase,
    loading,
    error,
    projectDeleted,
    refresh: () => { void fetchOnce() },
  }
}
