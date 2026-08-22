/**
 * L2 委派超时兜底单测（v0.17.64 Sprint C1，实证②）
 *
 * NanjuDelegationWatcher 依赖全注入：mock 委派（运行清单/强停）与时间（虚拟时钟），
 * 验证软超时（20min 催办）/ 硬超时（35min 强停 + errorCount 熔断计数 + 重派指令）/
 * 幂等 / 阻塞豁免（等用户不算烧钱）/ 重派重新计时 / 观察对象收口移除。
 *
 * 纯逻辑单测：不依赖 electron / agent-collaboration-tools 真实实现。
 */
import { describe, expect, test } from 'bun:test'
import {
  NanjuDelegationWatcher,
  type NanjuDelegationWatchDeps,
  type WatchedDelegation,
} from './nanju-delegation-watch'
import { NANJU_GUARDS, type NanjuGuardStage } from './nanju-project'

const SOFT = NANJU_GUARDS.delegationSoftTimeoutMs
const HARD = NANJU_GUARDS.delegationHardTimeoutMs

interface Harness {
  watcher: NanjuDelegationWatcher
  clock: { now: number }
  running: Map<string, WatchedDelegation>
  stops: Array<{ parentSessionId: string; delegationId: string }>
  guardErrors: Array<{ stage: NanjuGuardStage; note: string; justOpened: boolean }>
  injections: string[]
  continuations: string[]
  activeStages: Map<string, NanjuGuardStage | null>
}

/** 构造全 mock 环境的观察哨（ws/project 固定，stage 可切换） */
function makeHarness(opts: { guardJustOpened?: boolean } = {}): Harness {
  const clock = { now: 1_000_000 }
  const running = new Map<string, WatchedDelegation>()
  const stops: Harness['stops'] = []
  const guardErrors: Harness['guardErrors'] = []
  const injections: string[] = []
  const continuations: string[] = []
  const activeStages = new Map<string, NanjuGuardStage | null>([['demo-project', 'prototype']])

  const deps: NanjuDelegationWatchDeps = {
    now: () => clock.now,
    listRunningDelegations: () => Array.from(running.values()),
    forceStopDelegation: (parentSessionId, delegationId) => {
      stops.push({ parentSessionId, delegationId })
      running.delete(delegationId)
      return { stopped: true }
    },
    getActiveProjectStage: (_ws, projectId) => activeStages.get(projectId) ?? null,
    recordGuardError: (_ws, _projectId, stage, note) => {
      const justOpened = opts.guardJustOpened ?? true
      guardErrors.push({ stage, note, justOpened })
      return { justOpened, failCount: 0, errorCount: guardErrors.length }
    },
    injectMessage: (_sessionId, text) => injections.push(text),
    sendContinuation: (_sessionId, message) => continuations.push(message),
    log: () => {},
  }
  const watcher = new NanjuDelegationWatcher(deps)
  watcher.register('test-ws', 'session-l1', 'demo-project')
  return { watcher, clock, running, stops, guardErrors, injections, continuations, activeStages }
}

function makeDelegation(overrides: Partial<WatchedDelegation> = {}): WatchedDelegation {
  return {
    delegationId: 'del-1',
    childSessionId: 'child-1',
    title: 'UX 顾问：生成原型',
    startedAt: 0,
    hasPendingBlockedEvents: false,
    ...overrides,
  }
}

describe('软超时（默认 20min）', () => {
  test('未到软超时：不催办不强停', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll() // t0 登记
    h.clock.now += SOFT - 1000
    h.watcher.poll()
    expect(h.injections).toHaveLength(0)
    expect(h.continuations).toHaveLength(0)
    expect(h.stops).toHaveLength(0)
  })

  test('到软超时：注入催办 + 续接催办（含检查状态或重派），不强停不计数', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += SOFT
    h.watcher.poll()
    expect(h.injections).toHaveLength(1)
    expect(h.injections[0]).toContain('软超时')
    expect(h.injections[0]).toContain('20 分钟无响应')
    expect(h.continuations).toHaveLength(1)
    expect(h.continuations[0]).toContain('检查其状态')
    expect(h.stops).toHaveLength(0)
    expect(h.guardErrors).toHaveLength(0)
  })

  test('幂等：连续多轮 poll 不重复催办', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += SOFT
    h.watcher.poll()
    h.clock.now += 60_000
    h.watcher.poll()
    expect(h.injections).toHaveLength(1)
  })
})

describe('硬超时（默认 35min）', () => {
  test('到硬超时：强停 + 记 errorCount（进熔断计数）+ 注入重派指令 + 续接重派', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll()
    // 强停
    expect(h.stops).toEqual([{ parentSessionId: 'session-l1', delegationId: 'del-1' }])
    // 熔断计数（写入点收敛 updatePhaseGuard 的注入面）
    expect(h.guardErrors).toHaveLength(1)
    expect(h.guardErrors[0]?.stage).toBe('prototype')
    expect(h.guardErrors[0]?.note).toContain('硬超时')
    // 注入含硬超时与重派指引；新熔断时含熔断说明
    expect(h.injections.join('\n')).toContain('硬超时')
    expect(h.injections.join('\n')).toContain('熔断')
    expect(h.injections.join('\n')).toContain('重派')
    // 续接给出具体重派动作
    expect(h.continuations.join('\n')).toContain('continue_delegation')
    expect(h.continuations.join('\n')).toContain('delegate_agent')
  })

  test('硬超时直接跳过软超时催办（同一轮只执行硬超时动作）', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll()
    // 软超时未单独触发（tracked.softFired 随 hardFired 置位）
    const softOnly = h.injections.filter((t) => t.includes('软超时'))
    expect(softOnly).toHaveLength(0)
  })

  test('未新触发熔断（justOpened=false）：消息不含熔断说明，但 errorCount 照记', () => {
    const h = makeHarness({ guardJustOpened: false })
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll()
    expect(h.guardErrors).toHaveLength(1)
    expect(h.injections.join('\n')).not.toContain('已触发熔断')
  })

  test('幂等：强停后委派消失，后续 poll 不重复强停', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll() // 强停（mock 中从 running 移除）
    h.clock.now += 60_000
    h.watcher.poll()
    expect(h.stops).toHaveLength(1)
    expect(h.guardErrors).toHaveLength(1)
  })
})

describe('阻塞豁免与重派重计时', () => {
  test('等用户回答/权限（pendingBlockedEvents）不烧超时预算：时钟重置，长时不触发', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation({ hasPendingBlockedEvents: true }))
    h.watcher.poll()
    h.clock.now += HARD + 3600_000 // 远超硬超时
    h.watcher.poll()
    expect(h.injections).toHaveLength(0)
    expect(h.stops).toHaveLength(0)
  })

  test('解除阻塞后重新计时：从解除时刻起算软超时', () => {
    const h = makeHarness()
    const del = makeDelegation({ hasPendingBlockedEvents: true })
    h.running.set('del-1', del)
    h.watcher.poll()
    h.clock.now += HARD * 2 // 阻塞期间不计时
    h.watcher.poll()
    del.hasPendingBlockedEvents = false // 用户已回答
    h.watcher.poll() // 时钟在此刻重置
    h.clock.now += SOFT - 1000
    h.watcher.poll()
    expect(h.injections).toHaveLength(0)
    h.clock.now += 1000
    h.watcher.poll()
    expect(h.injections).toHaveLength(1)
  })

  test('continue_delegation 重派后重新计时：委派消失再出现即新时钟', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    h.clock.now += SOFT + 1000 // 已触发软超时
    h.watcher.poll()
    // 委派完成消失 → 重派再出现（同一 delegationId 重新 running）
    h.running.delete('del-1')
    h.watcher.poll()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll() // 重新登记新时钟
    h.clock.now += 60_000
    h.watcher.poll()
    // 只有首轮的 1 次软超时，重派后未再触发
    expect(h.injections).toHaveLength(1)
    expect(h.stops).toHaveLength(0)
  })
})

describe('观察对象生命周期', () => {
  test('项目交付/不活跃/会话解绑（getActiveProjectStage=null）→ 移除观察，size 归零', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation())
    h.watcher.poll()
    expect(h.watcher.size).toBe(1)
    h.activeStages.set('demo-project', null)
    h.watcher.poll()
    expect(h.watcher.size).toBe(0)
  })

  test('多委派并行观察：各自独立计时与触发', () => {
    const h = makeHarness()
    h.running.set('del-1', makeDelegation({ delegationId: 'del-1', title: '任务A' }))
    h.watcher.poll() // del-1 登记
    h.running.set('del-2', makeDelegation({ delegationId: 'del-2', childSessionId: 'child-2', title: '任务B' }))
    h.clock.now += SOFT // del-1 已过软超时；del-2 刚登记
    h.watcher.poll() // del-1 触发软超时；del-2 本轮才登记（时钟=now）
    expect(h.injections).toHaveLength(1)
    expect(h.injections[0]).toContain('任务A')
    h.clock.now += 60_000
    h.watcher.poll()
    expect(h.injections).toHaveLength(1) // del-2 还没到
  })
})
