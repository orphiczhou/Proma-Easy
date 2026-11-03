import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta, PermissionRequest } from '@proma/shared'
import { createStore } from 'jotai/vanilla'
import {
  agentSessionInputStreamStateAtomFamily,
  agentSessionStreamingStateAtomFamily,
  agentStreamingStatesAtom,
  agentSessionIndicatorMapAtom,
  allPendingPermissionRequestsAtom,
  allPendingAskUserRequestsAtom,
  allPendingExitPlanRequestsAtom,
  agentSessionsAtom,
  currentAgentSessionIdAtom,
  unviewedCompletedSessionIdsAtom,
  crossSessionPendingApprovalsAtom,
  aggregateCrossSessionPendingApprovals,
  canInlineRespondCrossSession,
  type CrossSessionPendingApproval,
  applyAgentEvent,
  clearAgentStreamError,
  isRetryEventForCurrentStream,
  type AgentStreamState,
} from './agent-atoms'

function createStreamState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    inputTokens: 180_000,
    outputTokens: 2_000,
    cacheReadTokens: 160_000,
    cacheCreationTokens: 18_000,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('Agent 上下文压缩状态', () => {
  test('given Pi 手动压缩提供预估 token when 压缩完成 then 显示预估值并清除旧明细', () => {
    const result = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 32_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })

  test('given 压缩后的预估值 when 当前压缩操作的收尾 result 没有 usage then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 收到零 token result then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 下一轮收到真实 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'usage_update',
      usage: {
        inputTokens: 36_000,
        cacheReadTokens: 30_000,
        outputTokens: 800,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 36_000,
      cacheReadTokens: 30_000,
      outputTokens: 800,
      contextUsageIsEstimated: false,
    })
  })

  test('given 压缩后的预估值 when 下一轮仅在 result 返回 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 40_000,
        cacheReadTokens: 34_000,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 40_000,
      cacheReadTokens: 34_000,
      contextUsageIsEstimated: false,
    })
  })

  test('given 没有 Pi 预估 token 的压缩完成事件 when 处理 then 保持既有上下文用量', () => {
    const result = applyAgentEvent(createStreamState(), { type: 'compact_complete', status: 'success' })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 180_000,
    })
    expect(result.contextUsageIsEstimated).toBeUndefined()
  })

  test('given 压缩成功 when 同一流开始下一项工具工作 then 清除压缩终态并恢复正常进度', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const resumed = applyAgentEvent(compacted, {
      type: 'tool_start',
      toolName: 'TaskCreate',
      toolUseId: 'resume-task',
      input: {},
    })

    expect(compacted).toMatchObject({
      isCompacting: false,
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
    expect(resumed.contextCompaction).toBeUndefined()
    expect(resumed.compactInFlight).toBe(false)
    expect('toolActivities' in resumed).toBe(false)
  })

  test('given 压缩成功 when 当前流直接结束 then 保留终态反馈给短时完成提示', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
  })
})

describe('Agent retry 状态机', () => {
  const runStartedAt = 1_000
  const retryAttempt = {
    attempt: 8,
    totalAttempt: 8,
    maxTotalAttempts: 8,
    timestamp: 2_000,
    reason: 'TypeError: Failed to fetch',
    errorMessage: 'TypeError: Failed to fetch',
    delaySeconds: 128,
  }

  test('given retry 已安排 when 实际请求尚未开始 then 不把它记入执行历史', () => {
    const scheduled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retrying',
      attempt: 8,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
      runStartedAt,
      scheduledAt: 1_500,
      delaySeconds: 128,
      reason: 'TypeError: Failed to fetch',
    })

    expect(scheduled.retrying).toMatchObject({
      phase: 'scheduled',
      currentAttempt: 8,
      maxAttempts: 8,
      history: [],
    })
  })

  test('given 第 8 次 retry 已实际开始且最终耗尽 when 更新终态 then 历史不重复追加第 8 项', () => {
    const started = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })
    const exhausted = applyAgentEvent(started, {
      type: 'retry_failed',
      finalAttempt: { ...retryAttempt, errorMessage: '最终请求仍然失败', reason: '最终请求仍然失败' },
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })

    expect(exhausted.retrying).toMatchObject({ phase: 'exhausted', currentAttempt: 8 })
    expect(exhausted.retrying?.history).toHaveLength(1)
    expect(exhausted.retrying?.history[0]).toMatchObject({ attempt: 8, timestamp: 2_000, reason: '最终请求仍然失败' })
  })

  test('given retry 成功 when 后续工具调用到达 then 成功状态被自然收起', () => {
    const running = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const succeeded = applyAgentEvent(running, {
      type: 'retry_cleared',
      runStartedAt,
      attempt: 8,
      maxAttempts: 8,
    })

    expect(succeeded.retrying?.phase).toBe('succeeded')
    expect(applyAgentEvent(succeeded, {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'resume-read',
      input: {},
    }).retrying).toBeUndefined()
  })

  test('given legacy text delta when the runtime reducer receives it then it does not duplicate the live transcript', () => {
    const state = createStreamState()

    expect(applyAgentEvent(state, { type: 'text_delta', text: '只由 live SDKMessage 渲染' })).toBe(state)
  })

  test('given 旧 run 的 retry 终态 when 新流已经开始 then 忽略迟到事件', () => {
    const current = createStreamState({ startedAt: runStartedAt + 1 })
    expect(applyAgentEvent(current, {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })).toBe(current)
  })

  test('given 带 run 标识的 retry 事件 when 流式状态缺少同一 startedAt then 严格拒绝它', () => {
    expect(isRetryEventForCurrentStream(createStreamState(), { runStartedAt })).toBe(false)
  })

  test('given retry 终态或错误 when STREAM_COMPLETE 尚未到达 then 不提前释放运行锁', () => {
    const exhausted = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_failed',
      finalAttempt: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const cancelled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })

    expect(exhausted.running).toBe(true)
    expect(cancelled.running).toBe(true)
    expect(applyAgentEvent(createStreamState(), { type: 'error', message: '终态错误' }).running).toBe(true)
  })
})

describe('Agent 流式错误状态', () => {
  test('given Pi 原生重试成功 when 清理会话错误 then 仅移除该会话的过期记录', () => {
    const errors = new Map([
      ['retried-session', '服务繁忙'],
      ['failed-session', '认证失败'],
    ])

    expect(clearAgentStreamError(errors, 'retried-session')).toEqual(new Map([
      ['failed-session', '认证失败'],
    ]))
  })

  test('given 当前会话没有流式错误 when 清理 then 保持原 Map 引用', () => {
    const errors = new Map([['failed-session', '认证失败']])

    expect(clearAgentStreamError(errors, 'retried-session')).toBe(errors)
  })
})

describe('Agent per-session 流式状态 family', () => {
  test('given another session changes when the active family is subscribed then it does not notify', () => {
    const store = createStore()
    const activeAtom = agentSessionStreamingStateAtomFamily('active-session')
    const otherAtom = agentSessionStreamingStateAtomFamily('other-session')
    const activeState = createStreamState()
    const otherState = createStreamState({ inputTokens: 20_000 })

    store.set(activeAtom, activeState)
    store.set(otherAtom, otherState)
    store.get(activeAtom)

    let notifications = 0
    const unsubscribe = store.sub(activeAtom, () => {
      notifications += 1
    })

    store.set(otherAtom, { ...otherState, inputTokens: 21_000 })

    expect(notifications).toBe(0)
    expect(store.get(agentStreamingStatesAtom).get('active-session')).toBe(activeState)
    expect(store.get(agentStreamingStatesAtom).get('other-session')?.inputTokens).toBe(21_000)
    unsubscribe()
  })

  test('given a session family update when the aggregate compatibility atom is read then it reflects the same state reference', () => {
    const store = createStore()
    const state = createStreamState({ running: true })
    store.set(agentSessionStreamingStateAtomFamily('active-session'), state)

    expect(store.get(agentStreamingStatesAtom)).toEqual(new Map([['active-session', state]]))
  })
})


describe('Agent 输入流状态订阅隔离', () => {
  test('given usage changes in the active session when the input selector is subscribed then it does not notify', () => {
    const store = createStore()
    const inputStateAtom = agentSessionInputStreamStateAtomFamily('active-session')
    const runningState = createStreamState({ inputTokens: 10_000 })
    store.set(agentStreamingStatesAtom, new Map([['active-session', runningState]]))
    store.get(inputStateAtom)

    let notifications = 0
    const unsubscribe = store.sub(inputStateAtom, () => {
      notifications += 1
    })

    store.set(agentStreamingStatesAtom, new Map([[
      'active-session',
      { ...runningState, inputTokens: 12_000, outputTokens: 900 },
    ]]))

    expect(notifications).toBe(0)
    unsubscribe()
  })

  test('given another session changes when the input selector is subscribed then it does not notify', () => {
    const store = createStore()
    const inputStateAtom = agentSessionInputStreamStateAtomFamily('active-session')
    const activeState = createStreamState()
    const otherState = createStreamState({ inputTokens: 20_000 })
    store.set(agentStreamingStatesAtom, new Map([
      ['active-session', activeState],
      ['other-session', otherState],
    ]))
    store.get(inputStateAtom)

    let notifications = 0
    const unsubscribe = store.sub(inputStateAtom, () => {
      notifications += 1
    })

    store.set(agentStreamingStatesAtom, new Map([
      ['active-session', activeState],
      ['other-session', { ...otherState, inputTokens: 21_000 }],
    ]))

    expect(notifications).toBe(0)
    unsubscribe()
  })
})

/** 最小可用的权限请求（侧栏指示只看 requestId/sessionId） */
function pendingPermission(sessionId: string, requestId: string): PermissionRequest {
  return {
    requestId,
    sessionId,
    toolName: 'Bash',
    toolInput: {},
    description: '执行隔离 fixture 命令',
    dangerLevel: 'normal',
  }
}

describe('侧栏会话指示：跨 turn 的后台批准不能因流结束而消失', () => {
  test('given 流已结束（turn 收尾）但仍有待处理权限 when 读取指示 then 标记 blocked', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, new Map([['host-task-session', { ...createStreamState(), running: false }]]))
    store.set(allPendingPermissionRequestsAtom, new Map([['host-task-session', [pendingPermission('host-task-session', 'approve-1')]]]))

    expect(store.get(agentSessionIndicatorMapAtom).get('host-task-session')).toBe('blocked')
  })

  test('given 既有运行中会话又有仅后台待批准会话 when 读取指示 then 各自独立标记', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, new Map([
      ['running-session', createStreamState()],
      ['background-session', { ...createStreamState(), running: false }],
    ]))
    store.set(allPendingPermissionRequestsAtom, new Map([['background-session', [pendingPermission('background-session', 'approve-2')]]]))

    const indicators = store.get(agentSessionIndicatorMapAtom)
    expect(indicators.get('running-session')).toBe('running')
    expect(indicators.get('background-session')).toBe('blocked')
  })

  test('given 会话已完成但未查看且仍有待处理权限 when 读取指示 then blocked 优先于 completed', () => {
    const store = createStore()
    store.set(unviewedCompletedSessionIdsAtom, new Set(['finished-session']))
    store.set(allPendingAskUserRequestsAtom, new Map([['finished-session', [{ requestId: 'ask-1', sessionId: 'finished-session', questions: [], toolInput: {} }]]]))

    expect(store.get(agentSessionIndicatorMapAtom).get('finished-session')).toBe('blocked')
  })

  test('given 无运行流也无待处理请求 when 读取指示 then 不登记该会话（idle 不显示）', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, new Map([['idle-session', { ...createStreamState(), running: false }]]))

    expect(store.get(agentSessionIndicatorMapAtom).has('idle-session')).toBe(false)
  })
})

// ===== 跨会话待审批聚合（NEXT-03 / P1-2）=====

/** 最小可用的会话元数据（聚合只读 id/title，其余为类型必填字段） */
function sessionMeta(id: string, title: string): AgentSessionMeta {
  return { id, title, createdAt: 0, updatedAt: 0 }
}

describe('跨会话待审批聚合：纯函数 aggregateCrossSessionPendingApprovals', () => {
  test('given 仅当前会话有待决请求 when 聚合 then 返回空（当前会话由内联横幅处理）', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [sessionMeta('current-session', '当前会话')],
      new Map([['current-session', [pendingPermission('current-session', 'perm-1')]]]),
      new Map(),
      new Map(),
    )

    expect(result).toEqual([])
  })

  test('given 后台会话有待决权限请求 when 聚合 then 产出 permission 条目并关联会话标题与审批上下文（B-1 安全基线）', () => {
    const request: PermissionRequest = {
      ...pendingPermission('worker-session', 'perm-2'),
      sdkDisplayName: 'Write',
      sdkTitle: 'Write to /tmp/fixture.ts',
      command: 'rm -rf /tmp/fixture',
      dangerLevel: 'dangerous',
    }
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [sessionMeta('worker-session', '树 Worker：实现模块')],
      new Map([['worker-session', [request, pendingPermission('worker-session', 'perm-3')]]]),
      new Map(),
      new Map(),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'permission',
      sessionId: 'worker-session',
      sessionTitle: '树 Worker：实现模块',
      requestId: 'perm-2',
      toolName: 'Bash',
      sdkDisplayName: 'Write',
      sdkTitle: 'Write to /tmp/fixture.ts',
      command: 'rm -rf /tmp/fixture',
      dangerLevel: 'dangerous',
      pendingCount: 2,
    })
  })

  test('given 后台会话有 AskUser 请求 when 聚合 then 产出 askUser 条目（无工具字段）', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [sessionMeta('worker-session', '审计会话')],
      new Map(),
      new Map([['worker-session', [{ requestId: 'ask-1', sessionId: 'worker-session', questions: [], toolInput: {} }]]]),
      new Map(),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'askUser',
      sessionId: 'worker-session',
      sessionTitle: '审计会话',
      requestId: 'ask-1',
      pendingCount: 1,
    })
    expect(result[0]!.toolName).toBeUndefined()
  })

  test('given 后台会话有 ExitPlanMode 请求 when 聚合 then 产出 exitPlanMode 条目（B-3）', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [sessionMeta('plan-session', '计划会话')],
      new Map(),
      new Map(),
      new Map([['plan-session', [{ requestId: 'exit-1', sessionId: 'plan-session', toolInput: {}, allowedPrompts: [] }]]]),
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      kind: 'exitPlanMode',
      sessionId: 'plan-session',
      sessionTitle: '计划会话',
      requestId: 'exit-1',
      pendingCount: 1,
    })
    expect(canInlineRespondCrossSession(result[0]!)).toBe(false)
  })

  test('given 后台同时存在权限、AskUser 与 ExitPlanMode 阻塞 when 聚合 then permission > askUser > exitPlanMode（可内联操作优先展示）', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [sessionMeta('ask-session', '问答会话'), sessionMeta('perm-session', '权限会话'), sessionMeta('plan-session', '计划会话')],
      new Map([['perm-session', [pendingPermission('perm-session', 'perm-4')]]]),
      new Map([['ask-session', [{ requestId: 'ask-2', sessionId: 'ask-session', questions: [], toolInput: {} }]]]),
      new Map([['plan-session', [{ requestId: 'exit-2', sessionId: 'plan-session', toolInput: {}, allowedPrompts: [] }]]]),
    )

    expect(result.map((a) => a.kind)).toEqual(['permission', 'askUser', 'exitPlanMode'])
  })

  test('given 会话列表缺失后台会话元数据 when 聚合 then 标题回退 sessionId 前 8 位（冷启动不崩溃）', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [],
      new Map([['long-session-id-1234567890', [pendingPermission('long-session-id-1234567890', 'perm-5')]]]),
      new Map(),
      new Map(),
    )

    expect(result[0]!.sessionTitle).toBe('long-ses')
  })

  test('given 队列为空数组 when 聚合 then 不产出条目', () => {
    const result = aggregateCrossSessionPendingApprovals(
      'current-session',
      [],
      new Map([['worker-session', []]]),
      new Map([['worker-session', []]]),
      new Map([['worker-session', []]]),
    )

    expect(result).toEqual([])
  })

  test('given currentSessionId 为 null（无激活会话） when 聚合 then 所有待决请求都视为后台阻塞', () => {
    const result = aggregateCrossSessionPendingApprovals(
      null,
      [sessionMeta('any-session', '任意会话')],
      new Map([['any-session', [pendingPermission('any-session', 'perm-6')]]]),
      new Map(),
      new Map(),
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.sessionId).toBe('any-session')
  })
})

describe('跨会话内联放行门槛 canInlineRespondCrossSession（B-1 安全基线）', () => {
  test('given 非危险权限请求 when 判定 then 允许内联允许/拒绝', () => {
    const approval: CrossSessionPendingApproval = {
      kind: 'permission',
      sessionId: 'worker-session',
      sessionTitle: 'Worker',
      requestId: 'perm-safe',
      toolName: 'Bash',
      dangerLevel: 'normal',
      pendingCount: 1,
    }

    expect(canInlineRespondCrossSession(approval)).toBe(true)
  })

  test('given 危险权限请求 when 判定 then 禁止内联放行（dangerous 必须跳回原会话知情处理）', () => {
    const approval: CrossSessionPendingApproval = {
      kind: 'permission',
      sessionId: 'worker-session',
      sessionTitle: 'Worker',
      requestId: 'perm-danger',
      toolName: 'Bash',
      dangerLevel: 'dangerous',
      pendingCount: 1,
    }

    expect(canInlineRespondCrossSession(approval)).toBe(false)
  })

  test('given askUser 或 exitPlanMode 条目 when 判定 then 均不允许内联作答', () => {
    expect(canInlineRespondCrossSession({
      kind: 'askUser', sessionId: 's', sessionTitle: 's', requestId: 'ask-1', pendingCount: 1,
    } satisfies CrossSessionPendingApproval)).toBe(false)
    expect(canInlineRespondCrossSession({
      kind: 'exitPlanMode', sessionId: 's', sessionTitle: 's', requestId: 'exit-1', pendingCount: 1,
    } satisfies CrossSessionPendingApproval)).toBe(false)
  })

  test('given 权限请求缺 dangerLevel（字段缺失的防御路径） when 判定 then 不视为危险，允许内联（与 PermissionBanner 默认一致）', () => {
    expect(canInlineRespondCrossSession({
      kind: 'permission', sessionId: 's', sessionTitle: 's', requestId: 'perm-x', pendingCount: 1,
    } satisfies CrossSessionPendingApproval)).toBe(true)
  })
})

describe('跨会话待审批聚合原子 crossSessionPendingApprovalsAtom', () => {
  test('given 后台会话权限入队且当前会话激活 when 读取原子 then 仅返回后台会话条目', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'current-session')
    store.set(agentSessionsAtom, [
      sessionMeta('current-session', '主会话'),
      sessionMeta('worker-session', '树 Worker'),
    ])
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['current-session', [pendingPermission('current-session', 'perm-cur')]],
      ['worker-session', [pendingPermission('worker-session', 'perm-bg')]],
    ]))

    const approvals = store.get(crossSessionPendingApprovalsAtom)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ sessionId: 'worker-session', requestId: 'perm-bg', sessionTitle: '树 Worker' })
  })

  test('given 切换激活会话 when 重新读取原子 then 聚合结果随新当前会话重新排除（常驻可见性核心）', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [sessionMeta('session-a', '会话 A'), sessionMeta('session-b', '会话 B')])
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['session-a', [pendingPermission('session-a', 'perm-a')]],
      ['session-b', [pendingPermission('session-b', 'perm-b')]],
    ]))

    store.set(currentAgentSessionIdAtom, 'session-a')
    expect(store.get(crossSessionPendingApprovalsAtom)[0]!.sessionId).toBe('session-b')

    // 用户跳转到 B 处理后，A 变为后台阻塞，横幅继续提示
    store.set(currentAgentSessionIdAtom, 'session-b')
    expect(store.get(crossSessionPendingApprovalsAtom)[0]!.sessionId).toBe('session-a')
  })

  test('given 后台会话 ExitPlanMode 入队 when 读取原子 then 产出 exitPlanMode 条目（依赖接线验证）', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'current-session')
    store.set(agentSessionsAtom, [sessionMeta('plan-session', '后台计划会话')])
    store.set(allPendingExitPlanRequestsAtom, new Map([
      ['plan-session', [{ requestId: 'exit-1', sessionId: 'plan-session', toolInput: {}, allowedPrompts: [] }]],
    ]))

    const approvals = store.get(crossSessionPendingApprovalsAtom)
    expect(approvals).toHaveLength(1)
    expect(approvals[0]).toMatchObject({ kind: 'exitPlanMode', sessionId: 'plan-session', sessionTitle: '后台计划会话' })
  })

  test('given 无关会话列表更新（agentSessionsAtom 换引用但聚合内容不变） when 再次读取 then 返回相同引用（B-6）', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'current-session')
    store.set(agentSessionsAtom, [sessionMeta('worker-session', '树 Worker')])
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['worker-session', [pendingPermission('worker-session', 'perm-stable')]],
    ]))
    const first = store.get(crossSessionPendingApprovalsAtom)

    // 无关更新：向会话列表追加一个无阻塞的会话（换引用，但聚合输入内容不变）
    store.set(agentSessionsAtom, [sessionMeta('worker-session', '树 Worker'), sessionMeta('idle-session', '空闲会话')])
    const second = store.get(crossSessionPendingApprovalsAtom)

    expect(second).toBe(first)
  })

  test('given 阻塞会话标题变化 when 再次读取 then 返回新引用且标题更新（B-6）', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'current-session')
    store.set(agentSessionsAtom, [sessionMeta('worker-session', '旧标题')])
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['worker-session', [pendingPermission('worker-session', 'perm-rename')]],
    ]))
    const first = store.get(crossSessionPendingApprovalsAtom)

    store.set(agentSessionsAtom, [sessionMeta('worker-session', '新标题')])
    const second = store.get(crossSessionPendingApprovalsAtom)

    expect(second).not.toBe(first)
    expect(second[0]!.sessionTitle).toBe('新标题')
  })

  test('given 后台请求被响应出队 when 读取原子 then 聚合条目消失', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'current-session')
    store.set(allPendingPermissionRequestsAtom, new Map([
      ['worker-session', [pendingPermission('worker-session', 'perm-done')]],
    ]))
    expect(store.get(crossSessionPendingApprovalsAtom)).toHaveLength(1)

    // 内联批准后的乐观出队（与 CrossSessionApprovalBanner.respond 行为一致）
    store.set(allPendingPermissionRequestsAtom, new Map())
    expect(store.get(crossSessionPendingApprovalsAtom)).toHaveLength(0)
  })
})
