/**
 * W24/M-1：wait_for_delegations blocked 即唤醒 + 分段等待 单元测试
 *
 * waitForLiveRecords 已导出并开放 countPendingBlocked 注入面（不依赖 electron/
 * 模块级 blockedEvents 真实状态），纯逻辑可测。
 */
import { describe, expect, test } from 'bun:test'
import { waitForLiveRecords } from './agent-collaboration-wait'

type Record = import('./agent-collaboration-wait').WaitableDelegation

function fakeRecord(delegationId: string, status: 'running' | 'done'): Record {
  return {
    delegationId,
    status,
    completion: status === 'done' ? Promise.resolve() : new Promise<void>(() => {}),
  } as unknown as Record
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('waitForLiveRecords（W24/M-1 blocked 唤醒）', () => {
  test('completed：目标数已满足立即返回', async () => {
    const r = await waitForLiveRecords([fakeRecord('d1', 'done')], 5, 1)
    expect(r).toBe('completed')
  })

  test('blocked：轮询发现未解决阻塞事件即提前返回（不等超时）', async () => {
    let pending = 0
    const started = Date.now()
    const p = waitForLiveRecords([fakeRecord('d1', 'running')], 300, 1, {
      countPendingBlocked: () => pending,
    })
    // 3s 后出现阻塞事件（轮询间隔 2s，应在一个间隔内唤醒）
    void sleep(3000).then(() => { pending = 1 })
    const r = await p
    expect(r).toBe('blocked')
    expect(Date.now() - started).toBeLessThan(15000) // 远小于 300s 超时
  })

  test('timeout：无阻塞且未完成 → 超时返回', async () => {
    const r = await waitForLiveRecords([fakeRecord('d1', 'running')], 2, 1, {
      countPendingBlocked: () => 0,
    })
    expect(r).toBe('timeout')
  })

  test('wakeOnBlocked:false 保持旧语义（纯超时，不被 blocked 唤醒）', async () => {
    const r = await waitForLiveRecords([fakeRecord('d1', 'running')], 2, 1, {
      wakeOnBlocked: false,
      countPendingBlocked: () => 5,
    })
    expect(r).toBe('timeout')
  })
})
