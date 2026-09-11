/**
 * 南大 L2 委派超时兜底（v0.17.64 Sprint C1，实证②）
 *
 * 背景：deepseek 渠道 L2 委派两次挂起（JSONL 仅委派简报零响应 1h+），系统层
 * 没有任何委派时长上限。本模块以「观察哨 + 轮询」实现两级超时：
 * - 软超时（默认 20min）：向 L1 注入催办 + 续接催办（检查状态或重派）
 * - 硬超时（默认 35min）：stop_delegation 强停 + 记 errorCount（进熔断计数）+ 注入重派指令
 *
 * 阈值与轮询间隔见 NANJU_GUARDS（nanju-project.ts，集中可调常量）。
 * 设计要点：
 * - 依赖全部注入（时间/委派查询/强停/计数/注入/续接），orchestrator 负责接线，
 *   本模块纯逻辑可单测（mock 委派与时间即可触发软/硬超时）；
 * - continue_delegation 重派后重新计时（委派记录从 running 消失再出现即重置时钟）；
 * - 等用户回答/权限的阻塞（pendingBlockedEvents）是用户驱动循环，时长控制明确
 *   排除：阻塞期间时钟重置，恢复后重新计时。
 */

import { NANJU_GUARDS, type NanjuGuardStage } from './nanju-project'

/** 运行中委派的观察视图（orchestrator 从 agent-collaboration-tools 提供） */
export interface WatchedDelegation {
  delegationId: string
  childSessionId: string
  title: string
  startedAt: number
  hasPendingBlockedEvents: boolean
  /** v2.4（D7 §4）：nanjuProxy 代理委派——独立时钟（软 5min/硬 10min 不因 blocked 重置）且不计熔断 */
  isNanjuProxy?: boolean
}

/**
 * v2.4（D7 §4）：nanjuProxy 代理委派独立时钟阈值。
 *
 * 与普通 L2 委派（20min/35min）分离：代理任务是短问答（无人工介入），长等待无意义；
 * 且代理无真人应答 blocked 事件——blocked 不重置时钟（否则永不到期）；硬停不计
 * phaseErrorBreakThreshold 熔断（代理失败由 nanju_clarify_proxy 工具 fallback:'human'
 * 兑底，不能拖累主阶段熔断账户）。硬停不注入重派续接（L1 在工具调用内等待，工具
 * 返回 fallback 后按协议转述真人）。
 */
export const NANJU_PROXY_GUARDS = {
  /** 代理软超时（毫秒，默认 5 分钟）：注入提示（L1 侧可见），不强停 */
  delegationSoftTimeoutMs: 5 * 60 * 1000,
  /** 代理硬超时（毫秒，默认 10 分钟）：强停代理委派（不计熔断、不续接重派） */
  delegationHardTimeoutMs: 10 * 60 * 1000,
} as const

/** 熔断计数写入结果（由 orchestrator 经 updatePhaseGuard 单一写入点产出） */
export interface GuardErrorRecord {
  justOpened: boolean
  failCount: number
  errorCount: number
}

/** 依赖注入面（测试可全量 mock；生产实现见 agent-orchestrator.ts 接线） */
export interface NanjuDelegationWatchDeps {
  /** 时间源（默认 Date.now；测试注入虚拟时钟） */
  now?: () => number
  /** 列出 L1 会话下运行中委派 */
  listRunningDelegations: (parentSessionId: string) => WatchedDelegation[]
  /** 强停委派（stop_delegation 程序化通道） */
  forceStopDelegation: (parentSessionId: string, delegationId: string) => { stopped: boolean }
  /**
   * 读取观察对象当前阶段；返回 null 表示项目不存在/不活跃/阶段已收口/会话解绑 → 移除观察。
   */
  getActiveProjectStage: (workspaceSlug: string, projectId: string, parentSessionId: string) => NanjuGuardStage | null
  /** 记 errorCount（进熔断计数；返回是否新触发熔断与最新计数） */
  recordGuardError: (workspaceSlug: string, projectId: string, stage: NanjuGuardStage, note: string) => GuardErrorRecord
  /** 向 L1 注入可见 assistant 消息 */
  injectMessage: (parentSessionId: string, text: string) => void
  /** 向 L1 续接下发指令（催办/重派；orchestrator 侧处理忙碌重试） */
  sendContinuation: (parentSessionId: string, message: string) => void
  /**
   * 南大 R1（W1，可选）：软超时告警点转发（渲染端等待 Toast「仍在处理/可催办」数据源）。
   * 只转发已发生事实，不影响催办动作；缺省 no-op。
   */
  onSoftTimeout?: (info: {
    parentSessionId: string
    delegationId: string
    childSessionId: string
    title: string
    startedAt: number
    elapsedMs: number
  }) => void
  /**
   * 南大 R3（W1，可选）：硬超时导致的新触发熔断转发（GuardAlertCard 数据源）。
   * 仅在 recordGuardError 返回 justOpened 时调用；缺省 no-op，不改状态机。
   */
  onCircuitJustOpened?: (info: {
    parentSessionId: string
    workspaceSlug: string
    projectId: string
    stage: NanjuGuardStage
    failCount: number
    errorCount: number
    note: string
  }) => void
  /** 日志（默认 console.log） */
  log?: (message: string) => void
}

interface TrackedDelegation {
  firstSeenAt: number
  softFired: boolean
  hardFired: boolean
}

interface WatchEntry {
  workspaceSlug: string
  projectId: string
  tracked: Map<string, TrackedDelegation>
}

/** 计数转述（AC U-1 去行话）：failCount/errorCount → 连续失败/执行异常次数 */
function narrativeGuardCounts(guard: GuardErrorRecord): string {
  const parts: string[] = []
  if (guard.failCount > 0) parts.push(`连续失败 ${guard.failCount} 次`)
  if (guard.errorCount > 0) parts.push(`执行异常 ${guard.errorCount} 次`)
  return parts.join('、')
}

/** L2 委派超时观察哨（按 L1 会话维度观察其运行中委派） */
export class NanjuDelegationWatcher {
  private watches = new Map<string, WatchEntry>()
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly deps: NanjuDelegationWatchDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? ((message: string) => console.log(message))
  }

  /** 观察中的 L1 会话数（0 时调用方可停轮询定时器） */
  get size(): number {
    return this.watches.size
  }

  /** 登记观察（幂等；项目状态由 getActiveProjectStage 在轮询时持续核验） */
  register(workspaceSlug: string, parentSessionId: string, projectId: string): void {
    if (this.watches.has(parentSessionId)) return
    this.watches.set(parentSessionId, { workspaceSlug, projectId, tracked: new Map() })
    this.log(`[南大护栏] L2 委派超时观察哨已登记: ${projectId}`)
  }

  /** 移除观察（测试与异常清理用） */
  unregister(parentSessionId: string): void {
    this.watches.delete(parentSessionId)
  }

  /**
   * 单轮轮询：对账运行中委派 → 逐个判定软/硬超时并执行动作。
   * 幂等：单委派的软/硬超时各只触发一次；重派后重新计时。
   */
  poll(): void {
    for (const [sessionId, watch] of this.watches) {
      const stage = this.deps.getActiveProjectStage(watch.workspaceSlug, watch.projectId, sessionId)
      if (!stage) {
        this.watches.delete(sessionId)
        this.log(`[南大护栏] 观察对象已收口/失效，移除观察: ${watch.projectId}`)
        continue
      }

      const running = this.deps.listRunningDelegations(sessionId)
      // 对账：消失的委派移除追踪；新出现的（含 continue_delegation 重派）重新计时
      const runningIds = new Set(running.map((d) => d.delegationId))
      for (const id of watch.tracked.keys()) {
        if (!runningIds.has(id)) watch.tracked.delete(id)
      }
      const now = this.now()
      for (const d of running) {
        if (!watch.tracked.has(d.delegationId)) {
          watch.tracked.set(d.delegationId, { firstSeenAt: now, softFired: false, hardFired: false })
        }
      }

      for (const d of running) {
        const tracked = watch.tracked.get(d.delegationId)
        if (!tracked) continue
        if (d.isNanjuProxy === true) {
          // v2.4：代理独立时钟——blocked 不重置（代理无真人应答），软/硬阈值取 NANJU_PROXY_GUARDS
          const elapsed = this.now() - tracked.firstSeenAt
          if (elapsed >= NANJU_PROXY_GUARDS.delegationHardTimeoutMs && !tracked.hardFired) {
            tracked.hardFired = true
            tracked.softFired = true
            this.handleProxyHardTimeout(sessionId, d)
          } else if (elapsed >= NANJU_PROXY_GUARDS.delegationSoftTimeoutMs && !tracked.softFired) {
            tracked.softFired = true
            this.handleProxySoftTimeout(sessionId, d)
          }
          continue
        }
        if (d.hasPendingBlockedEvents) {
          // 等用户回答/权限是用户驱动循环（时长控制明确排除）：时钟重置，恢复后重新计时
          // D8 S4′：L2 blocked → 澄清中 sentinel（{主节点}_CLARIFY；auto on 语义=
          // 「代理澄清中」（blocked 走 clarify-proxy），auto off = 等用户——渲染端
          // 节点点亮由 C 域后续消费，主进程事实源先行；单调守卫按未知值处理不阻塞）
          this.trySetClarifySentinel(watch.workspaceSlug, watch.projectId, stage)
          tracked.firstSeenAt = this.now()
          tracked.softFired = false
          continue
        }
        const elapsed = this.now() - tracked.firstSeenAt
        if (elapsed >= NANJU_GUARDS.delegationHardTimeoutMs && !tracked.hardFired) {
          tracked.hardFired = true
          tracked.softFired = true
          this.handleHardTimeout(watch, sessionId, stage, d)
        } else if (elapsed >= NANJU_GUARDS.delegationSoftTimeoutMs && !tracked.softFired) {
          tracked.softFired = true
          this.handleSoftTimeout(sessionId, d)
        }
      }
      // D8 S4′：blocked 解除（本轮无任何运行中委派处于 blocked）且现值为 sentinel
      // → 写回主节点 current（澄清收口，恢复产出节奏）
      if (!running.some((d) => d.hasPendingBlockedEvents)) {
        this.tryRestoreMainFromClarify(watch.workspaceSlug, watch.projectId, stage)
      }
    }
  }

  /** D8 S4′：写澄清中 sentinel（幂等：现值已是 sentinel 不重写；归因+outputPath 校验见 tryAdvanceGuideSubStage） */
  private trySetClarifySentinel(workspaceSlug: string, projectId: string, stage: string): void {
    try {
      const { getClarifySentinelNodeId, getProjectSubStage, tryAdvanceGuideSubStage } =
        require('./nanju-project') as typeof import('./nanju-project')
      const sentinel = getClarifySentinelNodeId(stage)
      if (!sentinel || getProjectSubStage(workspaceSlug, projectId) === sentinel) return
      tryAdvanceGuideSubStage(workspaceSlug, projectId, sentinel)
    } catch { /* 向导图写入失败不影响超时观察 */ }
  }

  /** D8 S4′：sentinel → 主节点恢复（blocked 全部解除后；单调守卫：主节点 0 ≥ sentinel -1 可写） */
  private tryRestoreMainFromClarify(workspaceSlug: string, projectId: string, stage: string): void {
    try {
      const { getClarifySentinelNodeId, getProjectSubStage, tryAdvanceGuideSubStage } =
        require('./nanju-project') as typeof import('./nanju-project')
      const sentinel = getClarifySentinelNodeId(stage)
      if (!sentinel || getProjectSubStage(workspaceSlug, projectId) !== sentinel) return
      const { getGuideStageMainNodeId } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
      const main = getGuideStageMainNodeId(stage)
      if (main) tryAdvanceGuideSubStage(workspaceSlug, projectId, main)
    } catch { /* 向导图写入失败不影响超时观察 */ }
  }

  /**
   * v2.4（D7 §4）：代理委派硬超时——强停 + 提示注入；不计熔断（代理失败由工具
   * fallback:'human' 兑底，不拖累主阶段熔断账户）、不续接重派（L1 在工具调用内
   * 等待，工具等待兑底后会返回 fallback，按协议转述真人）。
   */
  private handleProxyHardTimeout(sessionId: string, delegation: WatchedDelegation): void {
    const hardMin = Math.round(NANJU_PROXY_GUARDS.delegationHardTimeoutMs / 60000)
    let stopped = false
    try {
      stopped = this.deps.forceStopDelegation(sessionId, delegation.delegationId).stopped
    } catch (e) {
      this.log(`[南大护栏] 强停代理委派异常: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.log(`[南大护栏] nanjuProxy 代理委派硬超时（不计熔断）: ${delegation.delegationId} stopped=${stopped}`)
    this.deps.injectMessage(
      sessionId,
      `⏹ 南大护栏·代理硬超时：自动补完需求代理「${delegation.title}」已 ${hardMin} 分钟未完成，已被系统强制停止。`
      + `nanju_clarify_proxy 工具将返回 fallback:"human"，请按协议把问题转述给真人。`,
    )
  }

  /** v2.4（D7 §4）：代理委派软超时——仅注入提示（代理无人工介入，不催办重派） */
  private handleProxySoftTimeout(sessionId: string, delegation: WatchedDelegation): void {
    const softMin = Math.round(NANJU_PROXY_GUARDS.delegationSoftTimeoutMs / 60000)
    const hardMin = Math.round(NANJU_PROXY_GUARDS.delegationHardTimeoutMs / 60000)
    this.deps.injectMessage(
      sessionId,
      `⏳ 南大护栏·代理软超时：自动补完需求代理「${delegation.title}」已 ${softMin} 分钟未完成（${hardMin} 分钟硬超时强停，不计熔断）。`,
    )
  }

  /** 软超时：注入催办 + 续接催办（检查状态或重派） */
  private handleSoftTimeout(sessionId: string, delegation: WatchedDelegation): void {
    const softMin = Math.round(NANJU_GUARDS.delegationSoftTimeoutMs / 60000)
    const hardMin = Math.round(NANJU_GUARDS.delegationHardTimeoutMs / 60000)
    this.deps.injectMessage(
      sessionId,
      `⏰ 南大护栏·软超时：子会话「${delegation.title}」已 ${softMin} 分钟无响应。请检查该子会话状态（侧边栏打开查看）；确认卡死可 stop_delegation 终止后重派；若仍在推进可继续等待（${hardMin} 分钟硬超时将强制停止并计入熔断）。`,
    )
    this.deps.sendContinuation(
      sessionId,
      `系统提醒：你委派的子会话「${delegation.title}」已 ${softMin} 分钟无响应。请检查其状态（list_delegations 或打开子会话查看）：确认卡死 → stop_delegation 终止后重新 delegate_agent 重派；仍在推进 → 继续等待并告知用户；需要用户决策 → AskUserQuestion。`,
    )
    // 南大 R1（W1）：软超时告警点转发（orchestrator 接线 → nanju:delegation-status；失败不影响催办）
    try {
      this.deps.onSoftTimeout?.({
        parentSessionId: sessionId,
        delegationId: delegation.delegationId,
        childSessionId: delegation.childSessionId,
        title: delegation.title,
        startedAt: delegation.startedAt,
        elapsedMs: this.now() - delegation.startedAt,
      })
    } catch { /* 转发失败不影响催办 */ }
  }

  /**
   * 硬超时：强停 + 记 errorCount（进熔断计数）+ 注入重派指令。
   * 新触发熔断时由 orchestrator 侧的 recordGuardError 返回 justOpened 并记 circuit_break 埋点。
   */
  private handleHardTimeout(watch: WatchEntry, sessionId: string, stage: NanjuGuardStage, delegation: WatchedDelegation): void {
    const hardMin = Math.round(NANJU_GUARDS.delegationHardTimeoutMs / 60000)
    let stopped = false
    try {
      stopped = this.deps.forceStopDelegation(sessionId, delegation.delegationId).stopped
    } catch (e) {
      this.log(`[南大护栏] 强停委派异常: ${e instanceof Error ? e.message : String(e)}`)
    }

    let guard: GuardErrorRecord | null = null
    try {
      guard = this.deps.recordGuardError(watch.workspaceSlug, watch.projectId, stage, `L2 委派硬超时（${delegation.title}）`)
    } catch (e) {
      this.log(`[南大护栏] 熔断计数更新失败（不影响强停结果）: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 南大 R3（W1）：新触发熔断转发（orchestrator 接线 → nanju:guard-alert；只转发 justOpened 事实）
    if (guard?.justOpened) {
      try {
        this.deps.onCircuitJustOpened?.({
          parentSessionId: sessionId,
          workspaceSlug: watch.workspaceSlug,
          projectId: watch.projectId,
          stage,
          failCount: guard.failCount,
          errorCount: guard.errorCount,
          note: `L2 委派硬超时（${delegation.title}）`,
        })
      } catch { /* 转发失败不影响强停与重派指令 */ }
    }

    const stopText = stopped
      ? `已强制停止子会话「${delegation.title}」（stop_delegation）`
      : `子会话「${delegation.title}」已不在运行（可能刚好完成或已被停止）`
    // AC L-1/U-1（v0.17.65）：熔断说明收敛为单一出口（circuitNote），且只在新触发熔断时
    // 才说「不再自动续接」（与 orchestrator circuitSuffix 口径一致）；计数转述去行话。
    const circuitNote = guard?.justOpened
      ? `阶段「${stage}」已触发熔断（${guard ? narrativeGuardCounts(guard) : ''}），系统不再自动续接，转人工介入。`
      : ''
    this.deps.injectMessage(
      sessionId,
      `⛔ 南大护栏·硬超时：${stopText}，该委派已 ${hardMin} 分钟无响应。\n`
      + (circuitNote ? circuitNote + '\n' : '')
      + `现场已保留：产物文件未删除，可打开子会话查看半成品状态。\n`
      + `请查看失败摘要后由你或用户决定：修复后重派 / 请用户裁决 / 查看报告。`,
    )
    this.deps.sendContinuation(
      sessionId,
      `系统通知：你委派的子会话「${delegation.title}」已达硬超时（${hardMin} 分钟无响应），已被系统强制停止`
      + (circuitNote ? `，且${circuitNote.slice(0, -1)}` : '') + '。'
      + `请先 Read 查看该阶段产出文件与失败摘要，再决定：基本完整 → continue_delegation 追加收尾指令；`
      + `无产出/严重不完整 → 修复后重新 delegate_agent 重派；需要用户裁决（终止/人工接手/跳过）→ AskUserQuestion。`,
    )
  }
}
