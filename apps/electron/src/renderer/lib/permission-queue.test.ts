import { expect, test } from 'bun:test'
import { removeResolvedPermission } from './permission-queue'

test('Given 多会话有批准等待 When 某后台请求已解决 Then 仅移除匹配项且重复通知幂等', () => {
  const queue = new Map([['a', [{ requestId: 'first' }, { requestId: 'host' }]], ['b', [{ requestId: 'other' }]]])
  const next = removeResolvedPermission(queue, 'a', 'host')
  expect(next.get('a')).toEqual([{ requestId: 'first' }])
  expect(next.get('b')).toBe(queue.get('b'))
  expect(queue.get('a')?.length).toBe(2)
  expect(removeResolvedPermission(next, 'a', 'host')).toBe(next)
  expect(removeResolvedPermission(next, 'a', 'first').has('a')).toBe(false)
})
