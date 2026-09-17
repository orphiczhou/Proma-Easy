import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEngineeringEvidence, parseEngineeringContract } from './nanju-engineering-contract'
import { runRegisteredEngineeringTest } from './nanju-engineering-execution'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
function fixture(): EngineeringExecutionInput {
  root = mkdtempSync(join(tmpdir(), 'nanju-execution-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 输出结果')
  writeFileSync(join(root, '08_APP/app'), '受控CLI fixture，不执行')
  const raw = JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app' }, artifacts: ['app'], build: 'fixture', run: 'fixture', tests: [{ id: 'cli', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '测试真实CLI输出', covers: ['US-01'], requiresReal: true }] })
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
  const contract = parseEngineeringContract(raw).contract!
  return { projectDir: root, test: contract.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
function passing() {
  return { testId: 'cli', target: 'app', exitCode: 0, checks: [{ storyId: 'US-01', label: '标准输出', expected: 'hello', actual: 'hello', evidence: ['stdout:hello'] }] }
}

describe('Given 宿主注册的工程测试驱动，When 请求执行，Then 严守批准与版本边界', () => {
  test('Then 没有注册驱动时不请求批准、不执行', async () => {
    let approvals = 0
    const result = await runRegisteredEngineeringTest(fixture(), { drivers: [], approve: async () => { approvals++; return true } })
    expect(result.status).toBe('blocked')
    expect(approvals).toBe(0)
  })
  test('Then 用户拒绝时不调用驱动', async () => {
    let executions = 0
    const result = await runRegisteredEngineeringTest(fixture(), { drivers: [{ adapter: 'cli-driver', execute: async () => { executions++; return passing() } }], approve: async () => false })
    expect(result.status).toBe('blocked')
    expect(executions).toBe(0)
  })
  test('Then 批准期间版本更新，旧批准失效', async () => {
    let executions = 0
    const input = fixture()
    const result = await runRegisteredEngineeringTest(input, { drivers: [{ adapter: 'cli-driver', execute: async () => { executions++; return passing() } }], approve: async () => { writeFileSync(join(root, '08_APP/app'), '更新fixture'); return true } })
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('版本')
    expect(executions).toBe(0)
  })
  test('Then 已取消时既不批准也不执行', async () => {
    const input = fixture()
    const abort = new AbortController(); abort.abort()
    let approvals = 0
    const result = await runRegisteredEngineeringTest({ ...input, signal: abort.signal }, { drivers: [{ adapter: 'cli-driver', execute: async () => passing() }], approve: async () => { approvals++; return true } })
    expect(result.status).toBe('blocked')
    expect(approvals).toBe(0)
  })
})

describe('Given 实际驱动返回值，When 解释结果，Then 退出成功不代替行为断言', () => {
  test('Then 完整结果只能证明注册驱动记录的断言，仍需产品验收', async () => {
    const input = fixture()
    const result = await runRegisteredEngineeringTest(input, { drivers: [{ adapter: 'cli-driver', execute: async () => passing() }], approve: async (request) => { expect(request.evidence.digest).toBe(input.evidence.digest); return true } })
    expect(result.status).toBe('pass')
    expect(result.coveredUs).toEqual(['US-01'])
    expect(result.evidenceDigest).toBe(input.evidence.digest)
  })
  test('Then 只有退出0或错误对象的报告不可通过', async () => {
    const input = fixture()
    for (const output of [{ exitCode: 0 }, { ...passing(), target: 'other' }, { ...passing(), checks: [] }]) {
      const result = await runRegisteredEngineeringTest(input, { drivers: [{ adapter: 'cli-driver', execute: async () => output }], approve: async () => true })
      expect(result.status).not.toBe('pass')
      expect(result.coveredUs).toEqual([])
    }
  })
  test('Then 期望与实际不符为行为失败而非环境阻塞', async () => {
    const output = passing(); output.checks[0]!.actual = 'goodbye'
    const result = await runRegisteredEngineeringTest(fixture(), { drivers: [{ adapter: 'cli-driver', execute: async () => output }], approve: async () => true })
    expect(result.status).toBe('fail')
    expect(result.checks[0]?.passed).toBe(false)
  })
  test('Then 测试后版本变化，本轮结果不用于交付', async () => {
    const result = await runRegisteredEngineeringTest(fixture(), { drivers: [{ adapter: 'cli-driver', execute: async () => { writeFileSync(join(root, '08_APP/app'), '测试时更新'); return passing() } }], approve: async () => true })
    expect(result.status).toBe('blocked')
    expect(result.coveredUs).toEqual([])
  })
})

test('Given 驱动预检意外异常 When 运行单项 Then 返回可报告的error且不申请批准', async () => {
  let approvals = 0
  const result = await runRegisteredEngineeringTest(fixture(), { approve: async () => { approvals++; return true }, drivers: [{ adapter: 'cli-driver', preflight: () => { throw new Error('fixture环境探测异常') }, execute: async () => passing() }] })
  expect(result.status).toBe('error')
  expect(result.reason).toContain('环境探测异常')
  expect(approvals).toBe(0)
})
