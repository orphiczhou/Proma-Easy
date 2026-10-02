import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mergePendingRequests, type PendingRequestLike } from './pending-requests-backfill'

interface FakeRequest extends PendingRequestLike {
  toolName?: string
}

function queue(entries: Record<string, FakeRequest[]>): Map<string, readonly FakeRequest[]> {
  return new Map(Object.entries(entries))
}

describe('Given 主进程仍有待处理请求 When 渲染进程重载回填 Then 合并而非覆盖流中事件', () => {
  test('Given 会话A流中已到请求 When 快照含同 requestId 与新 requestId Then 保留原对象并只追加新的', () => {
    const streamed: FakeRequest = { requestId: 'host-task', sessionId: 'a', toolName: 'Bash' }
    const current = queue({ a: [streamed] })
    const next = mergePendingRequests(current, [
      { requestId: 'host-task', sessionId: 'a', toolName: 'Bash（快照副本，不得覆盖）' },
      { requestId: 'second', sessionId: 'a', toolName: 'Write' },
    ])

    expect(next.get('a')).toEqual([streamed, { requestId: 'second', sessionId: 'a', toolName: 'Write' }])
    // 流中刚到的对象引用未被替换
    expect(next.get('a')?.[0]).toBe(streamed)
    // 原 Map 不被就地修改
    expect(current.get('a')?.length).toBe(1)
  })

  test('Given 快照跨多个会话 When 回填 Then 按 sessionId 归组，不同会话互不干扰', () => {
    const current = queue({ b: [{ requestId: 'b-1', sessionId: 'b' }] })
    const next = mergePendingRequests(current, [
      { requestId: 'a-1', sessionId: 'a' },
      { requestId: 'b-1', sessionId: 'b' },
      { requestId: 'a-2', sessionId: 'a' },
    ])

    expect(next.get('a')).toEqual([{ requestId: 'a-1', sessionId: 'a' }, { requestId: 'a-2', sessionId: 'a' }])
    expect(next.get('b')).toBe(current.get('b'))
  })

  test('Given 回填窗口内该请求已被 resolved When 快照仍然返回它 Then 不复活已结束的请求', () => {
    const current = queue({ a: [] })
    const resolved = new Set(['already-resolved'])
    const next = mergePendingRequests(current, [
      { requestId: 'already-resolved', sessionId: 'a' },
      { requestId: 'still-pending', sessionId: 'a' },
    ], resolved)

    expect([...(next.get('a') ?? [])].map((r) => r.requestId)).toEqual(['still-pending'])
  })

  test('Given 快照无语义变化 When 回填 Then 返回原引用（幂等，不触发无谓重渲染）', () => {
    const current = queue({ a: [{ requestId: 'x', sessionId: 'a' }] })
    expect(mergePendingRequests(current, [{ requestId: 'x', sessionId: 'a' }])).toBe(current)
    expect(mergePendingRequests(current, [])).toBe(current)
  })

  test('Given 渲染进程重载后队列为空 When 主进程快照非空 Then 每个请求都可见', () => {
    const empty = queue({})
    const next = mergePendingRequests(empty, [
      { requestId: 'permission-1', sessionId: 'a' },
      { requestId: 'askuser-1', sessionId: 'a' },
      { requestId: 'exitplan-1', sessionId: 'a' },
    ])

    expect(next.get('a')?.map((r) => r.requestId)).toEqual(['permission-1', 'askuser-1', 'exitplan-1'])
  })
})

describe('接线：全局监听器挂载时用主进程快照回填（M 级源码断言）', () => {
  const hookSource = readFileSync(
    new URL('../hooks/useGlobalAgentListeners.ts', import.meta.url),
    'utf-8',
  )

  test('挂载时消费既有 getPendingRequests（不再出现「主进程有接口、渲染端无消费者」）', () => {
    const backfillBlock = hookSource.slice(
      hookSource.indexOf('待处理请求回填'),
      hookSource.indexOf('// 南大向导：全局监听文件预览事件'),
    )
    expect(backfillBlock).toContain('window.electronAPI.getPendingRequests')
    expect(backfillBlock).toContain('.then((snapshot) =>')
    // 挂载即回填一次（不在事件处理器里重复拉取）
    expect(hookSource.match(/getPendingRequests/g)?.length).toBe(1)
  })

  test('权限 / AskUser / ExitPlan 三个队列都回填', () => {
    expect(hookSource).toContain('allPendingPermissionRequestsAtom, (prev) => mergePendingRequests(prev, snapshot.permissions')
    expect(hookSource).toContain('allPendingAskUserRequestsAtom, (prev) => mergePendingRequests(prev, snapshot.askUsers')
    expect(hookSource).toContain('allPendingExitPlanRequestsAtom, (prev) => mergePendingRequests(prev, snapshot.exitPlans')
  })

  test('回填排除窗口内已 resolved 的 requestId（快照滞后不复活已结束请求）', () => {
    const resolvedBranch = hookSource.slice(
      hookSource.indexOf("event.type === 'permission_resolved'"),
      hookSource.indexOf("event.type === 'ask_user_request'"),
    )
    expect(resolvedBranch).toContain('resolvedDuringBackfill.add(')
    expect(hookSource).toContain('resolvedDuringBackfill')
  })
})
