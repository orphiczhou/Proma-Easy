/**
 * L2 委派超时兜底单测（v0.17.64 Sprint C1，实证②）
 *
 * NanjuDelegationWatcher 依赖全注入：mock 委派（运行清单/强停）与时间（虚拟时钟），
 * 验证软超时（20min 催办）/ 硬超时（35min 强停 + errorCount 熔断计数 + 重派指令）/
 * 幂等 / 阻塞豁免（等用户不算烧钱）/ 重派重新计时 / 观察对象收口移除。
 *
 * 纯逻辑单测：不依赖 electron / agent-collaboration-tools 真实实现。
 */
import { describe, expect, mock, test } from 'bun:test'
import {
  NanjuDelegationWatcher,
  type NanjuDelegationWatchDeps,
  type WatchedDelegation,
} from './nanju-delegation-watch'
import { NANJU_GUARDS, type NanjuGuardStage } from './nanju-project'
import type { AgentEventBus } from './agent-event-bus'

// —— AC Z-4（v0.17.65）真实链路测试：停止委派时清理未决 blockedEvents ——
// mock 掉会话/运行器/模型选择依赖后加载真实 agent-collaboration-tools，走 delegate_agent →
// ask_user 阻塞 → stop_delegation / forceStopDelegation，断言 pendingBlockedEvents 清空
// （同 ID continue_delegation 重派后 hasPendingBlockedEvents=false，硬超时不再被陈旧事件豁免）。
// 注：session-manager 与 model-selection 需完全 stub（不 spread 真实模块）——
// 真实模块的传递依赖链上有顶层 `import ... from 'electron'`（workspace/builtin-mcp/
// channel-manager），bun 测试环境缺 electron 二进制会触发下载（仓库既有规避模式）。
// 两个 mock 目标均不被本文件其余用例依赖（纯逻辑观察哨测试），无泄漏。
let z4ChildSeq = 0
// 注：stub 需覆盖同批测试文件静态闭包的具名绑定——nanju-ipc.test 动态 import nanju-ipc.ts →
// nanju-snapshot.ts 具名导入 forkAgentSession/getAgentSessionMeta/updateAgentSessionMeta，
// nanju-orchestrator.ts 具名导入 createAgentSession（bun mock.module 跨文件生效，缺导出会在
// 链接期抛 SyntaxError）。其余导出未被本批闭包引用，不需补。
mock.module('./agent-session-manager', () => ({
  createAgentSession: () => ({ id: `child-z4-${++z4ChildSeq}` }),
  getAgentSessionMeta: () => undefined,
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async () => ({ id: `child-z4-fork-${++z4ChildSeq}` }),
}))
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: () => Promise.resolve(), // 不触发 onComplete，委派保持 running
  stopRegisteredAgent: () => {},
}))
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: (input: { modelId?: string }) => input.modelId ?? 'model-z4',
  listEnabledAgentModelsForChannel: () => ({ channelId: 'ch-z4', channelName: 'z4', provider: 'z4', models: [] }),
  pickDefaultModelForChannel: () => 'model-z4',
}))
const {
  buildPiCollaborationTools,
  registerCollaborationEventBus,
  listRunningDelegationsForParent,
  forceStopDelegation,
} = await import('./agent-collaboration-tools')

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

describe('AC Z-4（v0.17.65）：停止委派清理未决 blockedEvents（重派不被陈旧事件豁免）', () => {
  interface Z4ToolDef {
    name: string
    execute: (toolCallId: string, params: unknown) => Promise<unknown>
  }

  function buildZ4Tools(): Z4ToolDef[] {
    // 假 sdk：defineTool 原样返回定义（name/execute 可直接调用）
    const fakeSdk = { defineTool: (def: unknown) => def }
    return buildPiCollaborationTools(fakeSdk as never, {
      sessionId: 'parent-z4',
      channelId: 'ch-z4',
      modelId: 'model-z4',
      workspaceId: 'ws-z4',
    }) as Z4ToolDef[]
  }

  /** 注册假 EventBus；返回 emitBlocked(childSessionId, requestId) 注入未决阻塞事件 */
  function attachFakeEventBus(): (childSessionId: string, requestId: string) => void {
    let handler: ((sessionId: string, payload: unknown) => void) | null = null
    registerCollaborationEventBus({
      on: (cb: (sessionId: string, payload: unknown) => void) => {
        handler = cb
      },
      emit: (sessionId: string, payload: unknown) => {
        handler?.(sessionId, payload)
      },
    } as unknown as AgentEventBus)
    return (childSessionId: string, requestId: string) => {
      handler?.(childSessionId, {
        kind: 'proma_event',
        event: {
          type: 'ask_user_request',
          request: { requestId, questions: [{ question: '继续吗？', options: [{ label: '继续' }] }] },
        },
      })
    }
  }

  function parseZ4Result(res: unknown): Record<string, unknown> {
    const payload = res as { content: Array<{ type: string; text: string }> }
    return JSON.parse(payload.content[0]?.text ?? '{}') as Record<string, unknown>
  }

  test('stop_delegation 与 forceStopDelegation 均清理未决事件：停止后 blocked 状态不构成豁免', async () => {
    const tools = buildZ4Tools()
    const emitBlocked = attachFakeEventBus()
    const delegate = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')
    const stop = tools.find((t) => t.name === 'mcp__collaboration__stop_delegation')
    expect(delegate && stop).toBeTruthy()

    // 委派 1：blocked → stop_delegation 工具通道
    const created1 = parseZ4Result(await delegate!.execute('tc-z4-d1', { task: 'Z-4 用例任务一' })) as {
      delegation: { delegationId: string; childSessionId: string }
    }
    emitBlocked(created1.delegation.childSessionId, 'req-z4-1')
    expect(
      listRunningDelegationsForParent('parent-z4')
        .some((d) => d.delegationId === created1.delegation.delegationId && d.hasPendingBlockedEvents),
    ).toBe(true) // 修复前：未决事件存在

    const stopped1 = parseZ4Result(await stop!.execute('tc-z4-s1', { delegationId: created1.delegation.delegationId })) as {
      stopped: boolean
      delegation: { pendingBlockedEvents: unknown[] }
    }
    expect(stopped1.stopped).toBe(true)
    // AC Z-4 核心：停止即清理——同 ID continue_delegation 重派后 hasPendingBlockedEvents
    // = getPendingBlockedEvents(id).length>0 = false，观察哨不再误判「等用户」而豁免硬超时
    expect(stopped1.delegation.pendingBlockedEvents).toHaveLength(0)

    // 委派 2：blocked → forceStopDelegation 程序化通道（watcher 硬超时兑底用）
    const created2 = parseZ4Result(await delegate!.execute('tc-z4-d2', { task: 'Z-4 用例任务二' })) as {
      delegation: { delegationId: string; childSessionId: string }
    }
    emitBlocked(created2.delegation.childSessionId, 'req-z4-2')
    expect(
      listRunningDelegationsForParent('parent-z4')
        .some((d) => d.delegationId === created2.delegation.delegationId && d.hasPendingBlockedEvents),
    ).toBe(true)
    const force = forceStopDelegation('parent-z4', created2.delegation.delegationId)
    expect(force.stopped).toBe(true)
    // 强停后该委派退出运行清单；重派同 ID 时不会再被陈旧 blocked 事件豁免
    expect(
      listRunningDelegationsForParent('parent-z4')
        .filter((d) => d.delegationId === created2.delegation.delegationId),
    ).toHaveLength(0)
  })
})

// ===== W24-3：向导图子步骤推导（运行中委派标题 → ATK/DEF/VIS 点亮）=====

describe('W24-3 deriveSubStageFromDelegations（观察哨推导）', () => {
  function makeDeriveHarness(subStage: string | null) {
    const writes: Array<{ nodeId: string; force?: boolean }> = []
    let titles: string[] = []
    const deps: NanjuDelegationWatchDeps = {
      now: () => 1_000_000,
      listRunningDelegations: () => [],
      forceStopDelegation: () => ({ stopped: false }),
      getActiveProjectStage: (_ws, projectId) => (projectId === 'demo-project' ? 'prototype' : null),
      recordGuardError: () => ({ justOpened: false, failCount: 0, errorCount: 0 }),
      injectMessage: () => {},
      sendContinuation: () => {},
      log: () => {},
      listRunningDelegationTitlesByRoot: () => titles,
      readProjectSubStage: () => subStage,
      advanceGuideSubStage: (_ws, _pid, nodeId, opts) => {
        writes.push({ nodeId, force: opts?.force })
        return true
      },
    }
    const watcher = new NanjuDelegationWatcher(deps)
    return {
      watcher,
      writes,
      setTitles: (t: string[]) => { titles = t },
      poll: () => (watcher as unknown as { poll: () => void }).poll(),
    }
  }

  test('攻击者委派在跑 → 写 PROTO_ATK（force）', () => {
    const h = makeDeriveHarness('PROTO')
    ;(h.watcher as unknown as { register: (a: string, b: string, c: string) => void }).register('ws', 'root-1', 'demo-project')
    h.setTitles(['攻击者审查：UX 原型 AC 对抗审计'])
    h.poll()
    expect(h.writes.some((w) => w.nodeId === 'PROTO_ATK' && w.force === true)).toBe(true)
  })

  test('防御+攻击并行 → 取序列更后者 PROTO_DEF；UC 态被活跃攻防覆盖（W24-3b：预存文件早置 UC 不钉死）', () => {
    const h = makeDeriveHarness('PROTO')
    ;(h.watcher as unknown as { register: (a: string, b: string, c: string) => void }).register('ws', 'root-1', 'demo-project')
    h.setTitles(['攻击者复审 R2：原型修复验证', '防御者裁决：UX 原型 AC 审计 R1+R2'])
    h.poll()
    const atkDef = h.writes.filter((w) => w.nodeId === 'PROTO_ATK' || w.nodeId === 'PROTO_DEF')
    expect(atkDef.some((w) => w.nodeId === 'PROTO_DEF')).toBe(true)

    const uc = makeDeriveHarness('PROTO_UC')
    ;(uc.watcher as unknown as { register: (a: string, b: string, c: string) => void }).register('root-1', 'ws', 'demo-project')
    uc.setTitles(['[AC防御者] 原型审计 R1'])
    uc.poll()
    expect(uc.writes.some((w) => w.nodeId === 'PROTO_DEF')).toBe(true)
  })

  test('澄清 sentinel 优先（不覆盖）+ 攻防收工回主节点（回炉可见）', () => {
    const sentinel = makeDeriveHarness('REQ_CLARIFY')
    ;(sentinel.watcher as unknown as { register: (a: string, b: string, c: string) => void }).register('root-1', 'ws', 'demo-project')
    sentinel.setTitles(['攻击者审查：PRD AC'])
    sentinel.poll()
    expect(sentinel.writes.length).toBe(0)

    // prototype 阶段（demo-project 默认）攻防完成后只剩作者委派 → PROTO_DEF 回 PROTO
    const rework = makeDeriveHarness('PROTO_DEF')
    ;(rework.watcher as unknown as { register: (a: string, b: string, c: string) => void }).register('root-1', 'ws', 'demo-project')
    rework.setTitles(['UX 顾问：生成原型（作者产出）'])
    rework.poll()
    expect(rework.writes.some((w) => w.nodeId === 'PROTO' && w.force === true)).toBe(true)
  })
})
