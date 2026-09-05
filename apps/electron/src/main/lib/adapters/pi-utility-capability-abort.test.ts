/**
 * Terra MUST-2（P0-B）：host 侧 capability AbortController 按 queryId 清理测试。
 *
 * 纯函数行为 + pi-utility-adapter 接线源码断言（adapter 依赖 electron 无法直接 import）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { abortCapabilityControllersForQuery } from './pi-utility-capability-abort'

function createEntry(queryId: string): { controller: { abort(): void }; queryId: string; aborted: boolean } {
  const entry = {
    controller: { abort(): void { entry.aborted = true } },
    queryId,
    aborted: false,
  }
  return entry
}

describe('abortCapabilityControllersForQuery', () => {
  test('中止并移除目标 queryId 的全部 controller，保留其他 query 的条目', () => {
    const controllers = new Map<string, ReturnType<typeof createEntry>>()
    const a1 = createEntry('query-a')
    const a2 = createEntry('query-a')
    const b1 = createEntry('query-b')
    controllers.set('req-1', a1)
    controllers.set('req-2', a2)
    controllers.set('req-3', b1)

    expect(abortCapabilityControllersForQuery(controllers, 'query-a')).toBe(2)
    expect(a1.aborted).toBe(true)
    expect(a2.aborted).toBe(true)
    expect(b1.aborted).toBe(false)
    expect(controllers.size).toBe(1)
    expect(controllers.has('req-3')).toBe(true)
  })

  test('无匹配时安全空操作', () => {
    const controllers = new Map<string, ReturnType<typeof createEntry>>()
    expect(abortCapabilityControllersForQuery(controllers, 'query-x')).toBe(0)
    const b1 = createEntry('query-b')
    controllers.set('req-1', b1)
    expect(abortCapabilityControllersForQuery(controllers, 'query-x')).toBe(0)
    expect(b1.aborted).toBe(false)
  })
})

describe('pi-utility-adapter 接线源码断言（Terra MUST-2）', () => {
  const source = readFileSync(new URL('./pi-utility-adapter.ts', import.meta.url), 'utf-8')

  test('query finally 按 queryId 中止 capability controller（在 QUERY_ABORT 往返之前）', () => {
    const finallyIndex = source.indexOf('pending.ended = true')
    const abortIndex = source.indexOf('abortCapabilityControllersForQuery(this.capabilityAbortControllers, queryId)')
    const queryAbortIndex = source.indexOf('AGENT_RUNTIME_METHODS.QUERY_ABORT,')
    expect(finallyIndex).toBeGreaterThan(-1)
    expect(abortIndex).toBeGreaterThan(finallyIndex)
    // 不依赖 utility 往返：本地 abort 必须先于 QUERY_ABORT 调用执行
    expect(queryAbortIndex).toBeGreaterThan(abortIndex)
  })
})
