import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runEngineeringSuite } from './nanju-engineering-suite'
import type { EngineeringExecutionServices } from './nanju-engineering-execution'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
function fixture(requiresReal: boolean): string {
  root = mkdtempSync(join(tmpdir(), 'nanju-suite-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
  writeFileSync(join(root, '08_APP/app'), 'fixture')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app' }, artifacts: ['app'], build: 'fixture', run: 'fixture', tests: [
    { id: 'unit', layer: 'unit', adapter: 'cli-driver', target: 'app', command: '辅助测试', covers: [], requiresReal: false },
    { id: 'acceptance', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '行为检查', covers: ['US-01'], requiresReal },
  ] }))
  return root
}
function services(unitFails = false): EngineeringExecutionServices {
  return { approve: async () => true, drivers: [{ adapter: 'cli-driver', execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 0,
    checks: [{ storyId: test.layer === 'acceptance' ? 'US-01' : null, label: test.id, expected: '1', actual: unitFails && test.id === 'unit' ? '0' : '1', evidence: ['受控fixture'] }] }) }] }
}
test('Given 全部工程计划 When 辅助测试和验收均执行 Then 汇总分列且只计算验收覆盖', async () => {
  const result = await runEngineeringSuite(fixture(false), services(), new AbortController().signal)
  expect(result.verdict).toBe('pass')
  expect(result.tests.length).toBe(2)
  expect(result.tests[0]?.coveredUs).toEqual([])
  expect(result.coveredUs).toEqual(['US-01'])
})
test('Given 辅助测试失败 When 用户故事检查通过 Then 不能忽略辅助失败交付', async () => {
  const result = await runEngineeringSuite(fixture(false), services(true), new AbortController().signal)
  expect(result.verdict).toBe('fail')
  expect(result.tests[0]?.status).toBe('fail')
})
test('Given 真实系统能力要求 When 项目驱动自报检查通过 Then 仍等待独立证据', async () => {
  const result = await runEngineeringSuite(fixture(true), services(), new AbortController().signal)
  expect(result.tests.every((entry) => entry.status === 'pass')).toBe(true)
  expect(result.verdict).toBe('blocked')
  expect(result.reason).toContain('独立验收证据')
})
test('Given 部分驱动尚未注册 When 开始整套工程测试 Then 不批准任何执行', async () => {
  let approvals = 0
  const result = await runEngineeringSuite(fixture(false), { drivers: [], approve: async () => { approvals++; return true } }, new AbortController().signal)
  expect(result.verdict).toBe('blocked')
  expect(approvals).toBe(0)
})

test('Given 全量环境预检意外异常 When 运行工程套件 Then 返回error而不是裸抛中断报告', async () => {
  let approvals = 0
  const result = await runEngineeringSuite(fixture(false), { approve: async () => { approvals++; return true }, drivers: [{ adapter: 'cli-driver', preflight: () => { throw new Error('fixture预检故障') }, execute: async () => ({}) }] }, new AbortController().signal)
  expect(result.verdict).toBe('error')
  expect(result.reason).toContain('预检故障')
  expect(approvals).toBe(0)
})
