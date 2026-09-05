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

// ===== W18 Wave3：阶段偏差观测（divergence）纯函数域 =====

/**
 * 阶段偏差观测记录（主进程 StageDivergence 的渲染端最小字段面；弱断言口径 SHOULD-6：
 * 观测到的是「未来阶段产出文件已存在且 >100B」，不能证明谁写的/何时写的/是否越阶段
 * 施工 → observedAt 是观测时刻，文案必须用「可能存在」）。
 */
export interface NanjuGuideDivergence {
  stage: string
  artifact: string
  observedAt?: string
}

/** 偏差事实集（独立通道状态：指纹优先，缺失时按 stage:artifact 集合兑底） */
export interface DivergenceFacts {
  divergences: NanjuGuideDivergence[]
  fingerprint: string | null
}

/** resolveDivergenceUpdate 入参（当前采纳面 + 到达载荷） */
export interface DivergenceResolveInput {
  /** 是否已采纳过任何进度载荷（false = 冷启动，首拉无条件采纳） */
  adoptedAny: boolean
  /** 已采纳 seq（guideSeqRef） */
  currentSeq: number
  /** 当前偏差事实（divergenceFactsRef；null = 尚无事实） */
  currentFacts: DivergenceFacts | null
  /** 到达载荷（快照或事件；divergences 缺失 = 旧主进程，向前兼容） */
  incoming: {
    seq: number
    divergences?: NanjuGuideDivergence[]
    divergenceFingerprint?: string
  }
}

/** resolveDivergenceUpdate 决策输出（两通道各自独立） */
export interface DivergenceResolveResult {
  /** 进度载荷是否整体采纳（冷启动首拉无条件 + 之后 seq 严格高者胜） */
  adoptProgress: boolean
  /** 偏差事实新值；null = 无更新（载荷无字段或事实集未变） */
  divergenceFacts: DivergenceFacts | null
}

/** stage:artifact 规范集（observedAt 不参与——观测时刻不构成事实变化） */
function divergenceCanonical(list: NanjuGuideDivergence[]): string {
  return list.map((d) => `${d.stage}:${d.artifact}`).sort().join('|')
}

/** 事实集是否未变：指纹优先比较；双方都无指纹时按规范集比较 */
function sameDivergenceFacts(current: DivergenceFacts | null, next: DivergenceFacts): boolean {
  if (!current) return false
  if (current.fingerprint !== null && next.fingerprint !== null) return current.fingerprint === next.fingerprint
  if (current.fingerprint === null && next.fingerprint === null) {
    return divergenceCanonical(current.divergences) === divergenceCanonical(next.divergences)
  }
  return false // 一方有指纹一方无（主进程升级）→ 保守视为变化，更新一次即对齐
}

/**
 * 进度/偏差双通道采纳决策（W18 Wave3 纯函数，guide/w18-divergence-adoption.test.ts 锁定）：
 *
 * ① 进度通道（MUST-4 修复）：冷启动首拉无条件采纳——主进程 guideProgressSeq 初始 0，
 *    无历史事件的项目快照 seq=0，原 `seq > 0` 门槛会把首拉连同 divergences 一起丢弃；
 *    首拉之后恢复严格 seq 高者胜（乱序/重复事件防 subStage 状态回退）。
 *
 * ② 偏差独立通道（MUST-5 低成本替代）：偏差事实随磁盘文件增删变化，与 seq（进度事件
 *    序号）无关——seq 相等时允许只更新偏差、不触碰 subStage/推进状态（纯展示数据无
 *    回退面，这就是独立通道的例外依据）。事实未变（指纹相等）不重复更新，防 10s
 *    轮询拖动重渲染。
 */
export function resolveDivergenceUpdate(input: DivergenceResolveInput): DivergenceResolveResult {
  const adoptProgress = input.adoptedAny ? input.incoming.seq > input.currentSeq : true
  if (input.incoming.divergences === undefined) {
    return { adoptProgress, divergenceFacts: null }
  }
  const nextFacts: DivergenceFacts = {
    divergences: input.incoming.divergences,
    fingerprint: input.incoming.divergenceFingerprint ?? null,
  }
  return {
    adoptProgress,
    divergenceFacts: sameDivergenceFacts(input.currentFacts, nextFacts) ? null : nextFacts,
  }
}

/** 偏差阶段中文名（警示条文案用；未知 id 降级原文） */
const DIVERGENCE_STAGE_TITLES: Record<string, string> = {
  requirements: '需求', prototype: '原型', architecture: '架构',
  planning: '规划', coding: '开发', testing: '测试',
}

/**
 * 偏差警示条文案（弱断言，SHOULD-6）：只说「可能存在越阶段施工」，不得输出确定结论；
 * 非阻断（用户裁决 D4：仅展示不拦截）。空列表返回 null（不渲染）。
 */
export function buildDivergenceWarningText(divergences: NanjuGuideDivergence[]): string | null {
  if (divergences.length === 0) return null
  const items = divergences.map(
    (d) => `${d.artifact}（${DIVERGENCE_STAGE_TITLES[d.stage] ?? d.stage}阶段产物）`,
  )
  return `检测到超出当前阶段的产物：${items.join('、')}——可能存在越阶段施工（仅提示，不阻断流程）`
}

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
  /**
   * 当前阶段内子步骤（W2 S1，事件优先/轮询兑底/seq 高者胜）：主进程写入的 subStage
   * （主节点 id 或 {主节点}_UC）；仅当与 project.currentStage 同拍时非 null（防跨阶段
   * 错配着色）；null = 无子步骤数据（渲染端降级为现状全灰，安全）。
   */
  subStage: string | null
  /** ARCH_ENV 环境三态（W7 R9；与 subStage 同拍校验同因：仅 architecture 阶段消费） */
  envState: 'done' | 'blocked' | null
  /** 回归边投影（W2c；与阶段无关，直接透出） */
  regressions: Array<{ from: string; to: string; count: number; active: boolean }> | null
  /**
   * 阶段偏差观测（W18 Wave3，独立通道：不参与 seq 门控，不触碰 subStage）：
   * 未来阶段产出文件已存在且 >100B 的弱断言记录；null = 无数据（旧主进程）。
   */
  divergences: NanjuGuideDivergence[] | null
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

/** 向导图阶段内子步骤进度的最小字段面（主进程 GuideProgressSnapshot/Event 同构） */
interface GuideSubProgress {
  currentStage: string
  subStage: string
  seq: number
  /** W7 R9：ARCH_ENV 环境三态（缺失 = 无环境事件，按序列推导降级） */
  envState?: 'done' | 'blocked'
  /** W2c：回归边投影（缺失 = 无回归事件） */
  regressions?: Array<{ from: string; to: string; count: number; active: boolean }>
  /** W18 Wave3：阶段偏差观测（缺失 = 无数据，向前兼容；独立通道消费） */
  divergences?: NanjuGuideDivergence[]
  divergenceFingerprint?: string
}

export function useNanjuGuideData({ sessionId, workspaceSlug }: UseNanjuGuideDataOptions): NanjuGuideData {
  const [project, setProject] = React.useState<NanjuGuideProject | null>(null)
  const [phases, setPhases] = React.useState<GuideRoutePhase[]>([])
  const [todoStats, setTodoStats] = React.useState<NanjuGuideData['todoStats']>({})
  const [todosByPhase, setTodosByPhase] = React.useState<NanjuGuideData['todosByPhase']>({})
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [projectDeleted, setProjectDeleted] = React.useState(false)
  /** 阶段内子步骤进度（W2 S1）：事件与冷启动快照统一写入，seq 高者胜 */
  const [guideProgress, setGuideProgress] = React.useState<GuideSubProgress | null>(null)
  /** 已采纳的最新子步骤 seq：丢弃过期事件/滞后快照（防状态回退） */
  const guideSeqRef = React.useRef(0)
  /**
   * W18 Wave3（MUST-4 修复）：是否已采纳过任何进度载荷——冷启动首拉（false）时
   * 无条件采纳快照（主进程 seq 初始 0，`seq > 0` 门槛会丢弃无事件项目的首拉）。
   */
  const adoptedAnyRef = React.useRef(false)
  /** 偏差事实（独立通道状态）：divergenceFactsRef 供采纳决策比较，防轮询拖动重渲染 */
  const [divergenceFacts, setDivergenceFacts] = React.useState<DivergenceFacts | null>(null)
  const divergenceFactsRef = React.useRef<DivergenceFacts | null>(null)
  /** 请求序号：防止轮询竞态（慢响应覆盖新响应） */
  const fetchSeqRef = React.useRef(0)
  /** 已锁定的 projectId：项目消失后不 fallback 到其他项目（修订 Y7） */
  const lockedProjectIdRef = React.useRef<string | null>(null)
  /** 锁定归属的 sessionId：跨会话不锁（切换会话时重置，修复“向导图始终一个图”） */
  const lockedSessionIdRef = React.useRef<string | null>(null)

  const fetchOnce = React.useCallback(async () => {
    if (!workspaceSlug) {
      setLoading(false)
      return
    }
    const seq = ++fetchSeqRef.current
    // 跨会话：切换会话后锁定失效，重新按 sessionId 匹配（修复：向导图不随会话切换）
    if (lockedSessionIdRef.current !== null && lockedSessionIdRef.current !== sessionId) {
      lockedProjectIdRef.current = null
      lockedSessionIdRef.current = null
      // 子步骤进度随会话重置：新会话的快照/事件 seq 重新采纳（全局单调，旧会话事件被 sessionId 过滤）；
      // W18 Wave3：冷启动采纳面与偏差事实一并重置（新会话 = 新冷启动，旧项目偏差不残留）
      guideSeqRef.current = 0
      adoptedAnyRef.current = false
      setGuideProgress(null)
      divergenceFactsRef.current = null
      setDivergenceFacts(null)
    }
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
        lockedSessionIdRef.current = sessionId
        setProjectDeleted(false)
      }
      setProject(matched)
      setError(null)

      // 1.5 阶段内子步骤快照（W2 S1 冷启动初值 + 轮询协同）：与事件统一 seq 高者胜
      //（主进程 write-then-emit 保证快照不旧于已发事件；失败降级为无子步骤态，不影响主数据）。
      // W18 Wave3：采纳决策收敛到 resolveDivergenceUpdate 纯函数——① 冷启动首拉
      //（adoptedAny=false）无条件采纳（修 seq=0 丢弃，MUST-4）；② divergences 走独立
      // 通道：每次快照到达无条件覆盖偏差事实，不参与 seq 门控、不触碰 subStage/推进
      // 状态（纯展示数据无回退面——这就是不门控的例外依据，MUST-5 低成本替代）。
      if (matched) {
        try {
          // W18 Wave3 类型视图：preload 契约仍是 W2c 字段面（父授权边界：不改 preload），
          // 主进程 GuideProgressSnapshot 已恒携带 divergences/divergenceFingerprint——preload
          // bridge 运行时透传 invoke 结果，此处以 GuideSubProgress（超集视图）接收：
          // 结构化兼容（新字段全可选），旧主进程缺失时为 undefined（向前兼容）。
          const guideSnapshot: GuideSubProgress | null =
            await window.electronAPI.nanjuGetGuideProgress(workspaceSlug, matched.projectId)
          if (seq !== fetchSeqRef.current) return
          if (guideSnapshot) {
            const decision = resolveDivergenceUpdate({
              adoptedAny: adoptedAnyRef.current,
              currentSeq: guideSeqRef.current,
              currentFacts: divergenceFactsRef.current,
              incoming: {
                seq: guideSnapshot.seq,
                divergences: guideSnapshot.divergences,
                divergenceFingerprint: guideSnapshot.divergenceFingerprint,
              },
            })
            if (decision.adoptProgress) {
              adoptedAnyRef.current = true
              guideSeqRef.current = guideSnapshot.seq
              setGuideProgress(guideSnapshot)
            }
            if (decision.divergenceFacts) {
              divergenceFactsRef.current = decision.divergenceFacts
              setDivergenceFacts(decision.divergenceFacts)
            }
          }
        } catch { /* 子步骤快照失败：降级为无子步骤态 */ }
      }

      // 2. Todo 完成度（同轮询周期）：sessionLinks 含调度员 sessionId 过滤 + 标题前缀归类
      const todos = await window.electronAPI.listTodos()
      if (seq !== fetchSeqRef.current) return
      const mine = todos.filter((todo) => todo.sessionLinks?.some((link) => link.sessionId === sessionId))
      const { stats, todosByPhase: byPhase } = computeTodoStats(mine)
      setTodoStats(stats)
      setTodosByPhase(byPhase)

      // 路由结构是 harness 模板（与项目匹配无关，只与 mode 相关）：不随匹配结果清空。
      // 否则非项目会话清空后，切回项目会话时 routeModeRef 认为 mode 未变不重拉，
      // 图卡在“路由加载中…”（v0.17.45 回归）。清空仅在 mode 真正变化时由下方 effect 处理。
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
    // phases 为空（如首次、或历史版本被清空）也强制重拉，防止卡“路由加载中…”
    if (!project) return
    if (routeModeRef.current === project.mode && phases.length > 0) return
    routeModeRef.current = project.mode
    void window.electronAPI.nanjuGetRoute(project.mode)
      .then((route) => {
        setPhases(((route as GuideRoutePhase[]) ?? []).filter((p) => p.id !== 'delivered'))
      })
      .catch((e: unknown) => {
        console.warn('[向导图] 获取路由失败:', e)
      })
  }, [project, phases.length])

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

  // 事件接入（W2 S1）：nanju:guide-progress 推送优先、10s 轮询快照兑底；seq 高者胜
  // （seq <= 已采纳值的事件丢弃，防乱序/重复导致状态回退）。React effect on/off 配对即
  // 重订机制（GwtProgressCard.tsx 同型）。
  // stale UI 提示明确不做（取舍，AC plan-audit A6 条款④的工程落地）：子步骤为低频状态
  // 数据 + 10s 轮询兑底，stale 窗口≤轮询周期、期间无增量信息可提示（事件通道恢复即自愈）；
  // S4 复审时若 GWT/env 细分接入导致高频化再评估。
  React.useEffect(() => {
    const handler = (event: unknown, payload: GuideSubProgress & { sessionId: string }): void => {
      if (!payload || payload.sessionId !== sessionId) return
      // W18 Wave3：与快照同一采纳决策（纯函数）——进度通道 seq 高者胜（防乱序/重复
      // 回退）；事件携带偏差载荷时同样走独立通道（当前调用方均未携带，能力预留）
      const decision = resolveDivergenceUpdate({
        adoptedAny: adoptedAnyRef.current,
        currentSeq: guideSeqRef.current,
        currentFacts: divergenceFactsRef.current,
        incoming: {
          seq: payload.seq,
          divergences: payload.divergences,
          divergenceFingerprint: payload.divergenceFingerprint,
        },
      })
      if (decision.adoptProgress) {
        adoptedAnyRef.current = true
        guideSeqRef.current = payload.seq
        setGuideProgress({
          currentStage: payload.currentStage,
          subStage: payload.subStage,
          seq: payload.seq,
          envState: payload.envState,
          regressions: payload.regressions,
        })
      }
      if (decision.divergenceFacts) {
        divergenceFactsRef.current = decision.divergenceFacts
        setDivergenceFacts(decision.divergenceFacts)
      }
    }
    window.electronAPI.onNanjuGuideProgress?.(handler)
    return () => {
      window.electronAPI.offNanjuGuideProgress?.(handler)
    }
  }, [sessionId])

  // 派生：三态 + 提示（纯函数，guide-dsl.test.ts 覆盖）
  const stageDerived = React.useMemo(() => {
    if (!project || phases.length === 0) {
      return { stageStates: {}, abandoned: false, notice: null as string | null }
    }
    return computeStageStates(project, phases)
  }, [project, phases])

  // 子步骤仅在与 project.currentStage 同拍时暴露（事件/快照先于轮询 project 刷新到达时
  // 丢弃一个周期，guide-dsl 前缀匹配亦双重兑底——错拍不会着色，安全）；envState 同拍
  // 校验同因（仅 architecture 阶段消费）；regressions 与阶段无直接绑定，直接透出。
  const subStage = guideProgress && project && guideProgress.currentStage === project.currentStage
    ? (guideProgress.subStage || null)
    : null
  const envState = guideProgress && project && guideProgress.currentStage === project.currentStage
    ? (guideProgress.envState ?? null)
    : null
  const regressions = guideProgress?.regressions ?? null
  // 偏差独立通道（W18 Wave3）：与 subStage 同拍校验无关——磁盘事实与进度事件不同拍，
  // 快照到达即无条件覆盖（不门控）；null = 无数据（旧主进程），空数组 = 无偏差
  const divergences = divergenceFacts?.divergences ?? null

  return {
    project,
    phases,
    stageStates: stageDerived.stageStates,
    subStage,
    envState,
    regressions,
    divergences,
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
