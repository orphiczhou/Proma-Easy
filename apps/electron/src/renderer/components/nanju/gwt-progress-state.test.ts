import { expect, test } from 'bun:test'
import { describeGwtProgress } from './gwt-progress-state'
import type { NanjuGwtProgressData } from '@proma/shared'

const base: NanjuGwtProgressData = { sessionId: 's', projectId: 'p', phase: 'done', current: 1, total: 1, passed: 1, failed: 0, skipped: 0 }
test('Given 工程检查全部通过但真实证据阻塞 When 显示终态 Then 不把零失败冒充全部通过', () => {
  expect(describeGwtProgress({ ...base, scope: 'engineering', verdict: 'blocked' }).title).toBe('验收测试已阻塞')
  expect(describeGwtProgress({ ...base, scope: 'engineering' }).title).toBe('测试执行结束，等待最终裁决')
  expect(describeGwtProgress({ ...base, scope: 'engineering', verdict: 'error' }).title).toBe('验收测试执行异常')
})
test('Given 工程预检与等待批准 When 尚无已执行项目 Then 仍显示运行态并允许停止会话', () => {
  const view = describeGwtProgress({ ...base, phase: 'approval', current: 0, total: 0, scope: 'engineering' })
  expect(view.title).toBe('等待本项测试批准')
  expect(view.running).toBe(true)
  expect(view.percent).toBe(0)
})
test('Given 旧版浏览器进度含跳过 When 没有最终裁决 Then 不显示全部通过', () => {
  expect(describeGwtProgress({ ...base, skipped: 1 }).title).toBe('测试执行结束，存在跳过项')
  expect(describeGwtProgress(base).title).toBe('场景执行通过，等待最终裁决')
})
