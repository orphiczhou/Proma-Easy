import { expect, test } from 'bun:test'
import type { NanjuGwtProgressEvent } from '@proma/shared'
import { createEngineeringProgressLifecycle } from './nanju-engineering-progress'

test('Given 工程正在批准 When 报告写入异常 Then 结束进度且保留已执行计数', () => {
  const events: NanjuGwtProgressEvent[] = []
  const progress = createEngineeringProgressLifecycle((event) => events.push(event))
  progress.emit({ phase: 'approval', scope: 'engineering', current: 1, total: 2, passed: 1, failed: 0, skipped: 0 })
  progress.fail(new Error('报告目录不可写'), false)
  expect(events.at(-1)).toMatchObject({ phase: 'done', verdict: 'error', current: 1, total: 2, passed: 1, reason: '报告目录不可写' })
})
test('Given 尚未发布进度或已经完成 When 外层失败兜底 Then 初始取消有终态且最终裁决不被覆盖', () => {
  const events: NanjuGwtProgressEvent[] = []
  const progress = createEngineeringProgressLifecycle((event) => events.push(event))
  progress.fail(new Error('运行时探测结束'), true)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ phase: 'done', scope: 'engineering', verdict: 'blocked', total: 0, reason: '测试已取消' })
  progress.fail(new Error('后续展示失败'), false)
  progress.emit({ phase: 'start', current: 0, total: 1, passed: 0, failed: 0, skipped: 0 })
  expect(events).toHaveLength(1)
})
test('Given 界面通知抛错 When 发布进度 Then 展示失败不改变执行路径', () => {
  const progress = createEngineeringProgressLifecycle(() => { throw new Error('窗口关闭') })
  expect(() => progress.fail(new Error('产物缺失'), false)).not.toThrow()
})
