/**
 * R1/R3（W1）单测：
 * 1. nanju-delegation-status / nanju-guard-alert：IPC 广播（mock 主窗；无窗/异常静默）
 * 2. agent-collaboration-tools 生命周期事件漏斗（真实模块 + mock 依赖，Z-4 同型）：
 *    startDelegation → phase=start；markDelegationFinished（cancelled/failed）→ phase=fail
 * 3. nanju-delegation-watch 可选转发钩子：onSoftTimeout（软超时告警点）/
 *    onCircuitJustOpened（仅 justOpened）；均不改既有催办/强停行为
 */

import { describe, expect, mock, test } from 'bun:test'
import type { DelegationLifecycleEvent } from './agent-collaboration-tools'
import type { NanjuDelegationWatchDeps, WatchedDelegation } from './nanju-delegation-watch'

// —— mock 依赖（Z-4 同型：真实 agent-collaboration-tools 需 stub 传递依赖链） ——
let z4ChildSeq = 0
mock.module('./agent-session-manager', () => ({
  createAgentSession: () => ({ id: `child-r1-${++z4ChildSeq}` }),
  getAgentSessionMeta: () => undefined,
  updateAgentSessionMeta: () => {},
  listAgentSessions: () => [],
  getAgentSDKMessages: () => [],
  forkAgentSession: async () => ({ id: `child-r1-fork-${++z4ChildSeq}` }),
  getAgentSessionSDKMessages: () => [],
}))
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: () => Promise.resolve(), // 不触发 onComplete，委派保持 running
  stopRegisteredAgent: () => {},
}))
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: (input: { modelId?: string }) => input.modelId ?? 'model-r1',
  listEnabledAgentModelsForChannel: () => ({ channelId: 'ch-r1', channelName: 'r1', provider: 'r1', models: [] }),
  pickDefaultModelForChannel: () => 'model-r1',
}))

// 主窗 mock：自持实现（bun mock.module 跨文件生效，不依赖真实 main-window-store 状态；
// availability 开关驱动「主窗可用/不可用」两分支，与 nanju-guide-progress.test.ts 的 mock 互不干扰）
const sentViaMainWindow: Array<[string, unknown]> = []
const mainWindowState = { available: true }
mock.module('./main-window-store', () => ({
  getMainWindow: () => mainWindowState.available
    ? {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => { sentViaMainWindow.push([channel, payload]) } },
      }
    : null,
  setMainWindow: () => {},
}))

const { emitDelegationStatus } = await import('./nanju-delegation-status')
const { emitGuardAlert, NANJU_GUARD_ALERT_MESSAGE } = await import('./nanju-guard-alert')
const { buildPiCollaborationTools, subscribeDelegationLifecycle } = await import('./agent-collaboration-tools')
const { NanjuDelegationWatcher } = await import('./nanju-delegation-watch')
const { NANJU_GUARDS } = await import('./nanju-project')

// ===== 1. IPC 广播 =====

describe('nanju-delegation-status：IPC 广播', () => {
  test('主窗可用：send(nanju:delegation-status, payload) 原样透传', () => {
    mainWindowState.available = true
    const before = sentViaMainWindow.length
    emitDelegationStatus({
      sessionId: 's-l1', delegationId: 'd-1', childSessionId: 'c-1', phase: 'start',
      label: 'UX 顾问：生成原型', startedAt: 123, elapsedMs: 0,
    })
    expect(sentViaMainWindow.length).toBe(before + 1)
    const [channel, payload] = sentViaMainWindow[sentViaMainWindow.length - 1]!
    expect(channel).toBe('nanju:delegation-status')
    expect(payload).toMatchObject({ sessionId: 's-l1', phase: 'start', label: 'UX 顾问：生成原型' })
  })

  test('无主窗：静默不抛', () => {
    mainWindowState.available = false
    expect(() => emitDelegationStatus({
      sessionId: 's', delegationId: 'd', childSessionId: 'c', phase: 'done',
      label: 'x', startedAt: 0, elapsedMs: 5,
    })).not.toThrow()
    mainWindowState.available = true
  })
})

describe('nanju-guard-alert：IPC 广播与 spec 文案', () => {
  test('主窗可用：send(nanju:guard-alert, payload)', () => {
    mainWindowState.available = true
    const before = sentViaMainWindow.length
    emitGuardAlert({ sessionId: 's-l1', projectId: 'p-1', stage: 'testing', message: NANJU_GUARD_ALERT_MESSAGE })
    expect(sentViaMainWindow.length).toBe(before + 1)
    const [channel, payload] = sentViaMainWindow[sentViaMainWindow.length - 1]!
    expect(channel).toBe('nanju:guard-alert')
    expect(payload).toMatchObject({ sessionId: 's-l1', projectId: 'p-1', stage: 'testing' })
  })

  test('安抚文案 = spec Flow 4 风格逐字', () => {
    expect(NANJU_GUARD_ALERT_MESSAGE).toBe('自动修复多次没有成功，我已暂停自动尝试。你的项目文件都在，随时可以继续。')
  })

  test('无主窗：静默不抛', () => {
    mainWindowState.available = false
    expect(() => emitGuardAlert({ sessionId: 's', projectId: 'p', stage: 'coding', message: 'm' })).not.toThrow()
    mainWindowState.available = true
  })
})

// ===== 2. 生命周期事件漏斗（真实 agent-collaboration-tools） =====

interface ToolDef {
  name: string
  execute: (toolCallId: string, params: unknown) => Promise<unknown>
}

function buildTools(): ToolDef[] {
  const fakeSdk = { defineTool: (def: unknown) => def }
  return buildPiCollaborationTools(fakeSdk as never, {
    sessionId: 'parent-r1',
    channelId: 'ch-r1',
    modelId: 'model-r1',
    workspaceId: 'ws-r1',
  }) as ToolDef[]
}

function parseResult(res: unknown): Record<string, unknown> {
  const payload = res as { content: Array<{ type: string; text: string }> }
  return JSON.parse(payload.content[0]?.text ?? '{}') as Record<string, unknown>
}

describe('委派生命周期事件（R1 数据源）', () => {
  test('delegate_agent 启动 → phase=start；stop_delegation → phase=fail（cancelled 附原因）', async () => {
    const events: DelegationLifecycleEvent[] = []
    const unsubscribe = subscribeDelegationLifecycle((e) => events.push(e))
    try {
      const tools = buildTools()
      const delegate = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')
      const stop = tools.find((t) => t.name === 'mcp__collaboration__stop_delegation')
      expect(delegate && stop).toBeTruthy()

      const created = parseResult(await delegate!.execute('tc-r1-1', { task: 'R1 生命周期任务' })) as {
        delegation: { delegationId: string; childSessionId: string }
      }
      expect(events).toHaveLength(1)
      expect(events[0]?.phase).toBe('start')
      expect(events[0]?.parentSessionId).toBe('parent-r1')
      expect(events[0]?.delegationId).toBe(created.delegation.delegationId)
      expect(typeof events[0]?.startedAt).toBe('number')

      await stop!.execute('tc-r1-2', { delegationId: created.delegation.delegationId })
      expect(events).toHaveLength(2)
      expect(events[1]?.phase).toBe('fail')
      expect(events[1]?.delegationId).toBe(created.delegation.delegationId)
      expect(events[1]?.reason).toContain('停止')
      expect(typeof events[1]?.settledAt).toBe('number')
    } finally {
      unsubscribe()
    }
  })

  test('退订后不再收到事件（监听者异常不影响委派）', async () => {
    const events: DelegationLifecycleEvent[] = []
    const badListener = (): void => { throw new Error('listener boom') }
    const unsubBad = subscribeDelegationLifecycle(badListener)
    const unsub = subscribeDelegationLifecycle((e) => events.push(e))
    try {
      const tools = buildTools()
      const delegate = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')
      // 监听者抛错不影响委派本身（startDelegation 正常返回）
      const created = parseResult(await delegate!.execute('tc-r1-3', { task: '异常监听者任务' })) as {
        delegation: { delegationId: string }
      }
      expect(created.delegation.delegationId).toBeTruthy()
      expect(events).toHaveLength(1)
    } finally {
      unsubBad()
      unsub()
    }
  })
})

// ===== 3. delegation-watch 可选转发钩子 =====

const SOFT = NANJU_GUARDS.delegationSoftTimeoutMs
const HARD = NANJU_GUARDS.delegationHardTimeoutMs

type SoftTimeoutInfo = Parameters<NonNullable<NanjuDelegationWatchDeps['onSoftTimeout']>>[0]
type CircuitOpenInfo = Parameters<NonNullable<NanjuDelegationWatchDeps['onCircuitJustOpened']>>[0]

interface WatchHarness {
  watcher: InstanceType<typeof NanjuDelegationWatcher>
  clock: { now: number }
  running: Map<string, WatchedDelegation>
  softTimeouts: SoftTimeoutInfo[]
  circuitOpens: CircuitOpenInfo[]
}

function makeWatchHarness(opts: { guardJustOpened?: boolean } = {}): WatchHarness {
  const clock = { now: 1_000_000 }
  const running = new Map<string, WatchedDelegation>()
  const softTimeouts: WatchHarness['softTimeouts'] = []
  const circuitOpens: WatchHarness['circuitOpens'] = []
  const deps: NanjuDelegationWatchDeps = {
    now: () => clock.now,
    listRunningDelegations: () => Array.from(running.values()),
    forceStopDelegation: (_p, delegationId) => {
      running.delete(delegationId)
      return { stopped: true }
    },
    getActiveProjectStage: () => 'prototype',
    recordGuardError: (_ws, _projectId, stage, note) => {
      const justOpened = opts.guardJustOpened ?? true
      return { justOpened, failCount: 0, errorCount: 1, stage, note }
    },
    injectMessage: () => {},
    sendContinuation: () => {},
    onSoftTimeout: (info) => { softTimeouts.push(info) },
    onCircuitJustOpened: (info) => { circuitOpens.push(info) },
    log: () => {},
  }
  const watcher = new NanjuDelegationWatcher(deps)
  watcher.register('ws-r1', 'session-l1', 'proj-r1')
  return { watcher, clock, running, softTimeouts, circuitOpens }
}

describe('onSoftTimeout 转发（R1 timeout 相位数据源）', () => {
  test('软超时告警点转发：含父会话/委派字段；既有催办行为不变', () => {
    const h = makeWatchHarness()
    h.running.set('del-1', {
      delegationId: 'del-1', childSessionId: 'child-1', title: 'UX 顾问：生成原型',
      startedAt: h.clock.now, hasPendingBlockedEvents: false,
    })
    h.watcher.poll() // t0 登记
    h.clock.now += SOFT
    h.watcher.poll()
    expect(h.softTimeouts).toHaveLength(1)
    expect(h.softTimeouts[0]).toMatchObject({
      parentSessionId: 'session-l1',
      delegationId: 'del-1',
      childSessionId: 'child-1',
      title: 'UX 顾问：生成原型',
    })
    expect(h.softTimeouts[0]!.elapsedMs).toBeGreaterThanOrEqual(SOFT)
    // 幂等：后续 poll 不重复转发
    h.clock.now += 60_000
    h.watcher.poll()
    expect(h.softTimeouts).toHaveLength(1)
  })

  test('未配钩子（缺省 no-op）：软超时路径不抛', () => {
    const clock = { now: 1_000_000 }
    const running = new Map<string, WatchedDelegation>([['del-1', {
      delegationId: 'del-1', childSessionId: 'child-1', title: 't', startedAt: clock.now, hasPendingBlockedEvents: false,
    }]])
    const watcher = new NanjuDelegationWatcher({
      now: () => clock.now,
      listRunningDelegations: () => Array.from(running.values()),
      forceStopDelegation: (_p, id) => { running.delete(id); return { stopped: true } },
      getActiveProjectStage: () => 'coding',
      recordGuardError: () => ({ justOpened: true, failCount: 0, errorCount: 1 }),
      injectMessage: () => {},
      sendContinuation: () => {},
    })
    watcher.register('ws', 's', 'p')
    watcher.poll()
    clock.now += SOFT
    expect(() => watcher.poll()).not.toThrow()
  })
})

describe('onCircuitJustOpened 转发（R3 数据源）', () => {
  test('硬超时新触发熔断：转发 justOpened 事实（含阶段与计数）', () => {
    const h = makeWatchHarness({ guardJustOpened: true })
    h.running.set('del-1', {
      delegationId: 'del-1', childSessionId: 'child-1', title: '架构审计',
      startedAt: h.clock.now, hasPendingBlockedEvents: false,
    })
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll()
    expect(h.circuitOpens).toHaveLength(1)
    expect(h.circuitOpens[0]).toMatchObject({
      parentSessionId: 'session-l1',
      workspaceSlug: 'ws-r1',
      projectId: 'proj-r1',
      stage: 'prototype',
    })
  })

  test('未新触发熔断（justOpened=false）：不转发', () => {
    const h = makeWatchHarness({ guardJustOpened: false })
    h.running.set('del-1', {
      delegationId: 'del-1', childSessionId: 'child-1', title: '架构审计',
      startedAt: h.clock.now, hasPendingBlockedEvents: false,
    })
    h.watcher.poll()
    h.clock.now += HARD
    h.watcher.poll()
    expect(h.circuitOpens).toHaveLength(0)
    // 熔断计数照记（既有行为不变）
    expect(h.softTimeouts).toHaveLength(0)
  })
})
