import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEngineeringBrowserFileDriver, createEngineeringBrowserUrlDriver } from './nanju-engineering-browser-driver'
import { captureEngineeringEvidence } from './nanju-engineering-contract'
import type { EngineeringTestPlan } from './nanju-engineering-contract'
import { runRegisteredEngineeringTest } from './nanju-engineering-execution'
import type { EngineeringServiceHandle } from './nanju-engineering-service'
import { validateScenarioFileContent } from './nanju-gwt-runner'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'nanju-browser-driver-'))
  for (const path of ['01_PRD', '03_ARCHITECTURE', '08_APP', '06_TESTS/features']) mkdirSync(join(root, path), { recursive: true })
  const test: EngineeringTestPlan = { id: 'ui', adapter: 'browser-file', layer: 'acceptance', target: 'app.html', command: '界面行为', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'] }
  writeFileSync(join(root, '08_APP/app.html'), '<h1>fixture</h1>')
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 界面行为')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'web', platform: 'web', entry: 'app.html' }, artifacts: ['app.html'], build: '无需构建', run: '浏览器', tests: [test] }))
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), JSON.stringify({ schemaVersion: 2, feature: 'US-01', scenario: 'US-01 显示', skip: false, skipReason: null, steps: [{ kind: 'then', text: '显示', op: { type: 'assert-visible', selector: 'data-ai-id=title' } }] }))
  return { projectDir: root, test, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
const scenarioResult = { feature: 'US-01', scenario: 'US-01 显示', status: 'pass' as const, reason: null, failedStep: null, screenshot: null, durationMs: 2 }
test('Given 浏览器契约绑定场景 When 注册驱动执行 Then 调用GWT并记录testId和实际场景', async () => {
  const input = fixture()
  let executed = 0
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, run: async (received, scenarios) => { expect(received.test.target).toBe('app.html'); expect(scenarios.length).toBe(1); executed++; return [scenarioResult] } })
  expect(driver.preflight?.(input)).toBeNull()
  const result = await driver.execute(input) as { testId: string; checks: { actual: string; storyId: string }[] }
  expect(executed).toBe(1)
  expect(result.testId).toBe('ui')
  expect(result.checks[0]?.actual).toBe('pass')
  expect(result.checks[0]?.storyId).toBe('US-01')
})
test('Given 浏览器场景跳过 When 汇总 Then 跳过不是通过', async () => {
  const input = fixture()
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, run: async () => [{ ...scenarioResult, status: 'skip', reason: '映射缺失' }] })
  const result = await driver.execute(input) as { checks: { expected: string; actual: string }[] }
  expect(result.checks[0]?.expected).toBe('pass')
  expect(result.checks[0]?.actual).toBe('skip')
})
test('Given 场景归属不完整或缺少Then断言 When 预检 Then 不请求运行', () => {
  const input = fixture()
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, run: async () => [] })
  input.test.covers = ['US-02']
  expect(driver.preflight?.(input)).toContain('用户故事')
  input.test.covers = ['US-01']
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), JSON.stringify({ schemaVersion: 2, feature: 'US-01', scenario: 'US-01 点击', skip: false, skipReason: null, steps: [{ kind: 'when', text: '点击', op: { type: 'click', selector: 'data-ai-id=title' } }] }))
  expect(driver.preflight?.(input)).toContain('断言')
})
test('Given 浏览器执行已取消 When 调用驱动 Then 不打开测试页面', async () => {
  const input = fixture()
  const abort = new AbortController(); abort.abort(); input.signal = abort.signal
  let calls = 0
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, run: async () => { calls++; return [] } })
  await expect(driver.execute(input)).rejects.toThrow('取消')
  expect(calls).toBe(0)
})

test('Given 尚未确认受管浏览器风险 When 预检混合测试 Then 保留告知门不打开页面', () => {
  const input = fixture()
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, browserPrerequisite: () => '尚未确认平台账号风险告知，请到浏览器面板确认后重跑。', run: async () => [] })
  expect(driver.preflight?.(input)).toContain('平台账号风险告知')
})
test('Given 浏览器验收对象与交付入口不同 When 预检 Then 要求校准契约而不验收替身页面', () => {
  const input = fixture()
  input.test.target = 'other.html'
  const driver = createEngineeringBrowserFileDriver({ validate: validateScenarioFileContent, run: async () => [] })
  expect(driver.preflight?.(input)).toContain('交付入口')
})

// ===== browser-url：served URL 驱动（W-C）=====

function servedFixture(): { projectDir: string; test: EngineeringTestPlan; evidence: NonNullable<ReturnType<typeof captureEngineeringEvidence>['evidence']>; signal: AbortSignal } {
  root = mkdtempSync(join(tmpdir(), 'nanju-browser-url-driver-'))
  for (const path of ['01_PRD', '03_ARCHITECTURE', '08_APP', '06_TESTS/features']) mkdirSync(join(root, path), { recursive: true })
  const test: EngineeringTestPlan = {
    id: 'served-ui', adapter: 'browser-url', layer: 'acceptance', target: 'app.html', command: '经服务入口验证', covers: ['US-01'], requiresReal: false,
    scenarioFiles: ['features/us-01.steps.json'],
    service: { runtime: 'node', path: 'server.cjs', args: [], port: 18742, readyPath: '/', readyTimeoutMs: 500 },
  }
  writeFileSync(join(root, '08_APP/app.html'), '<h1>fixture</h1>')
  writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture')
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 服务页面')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'web', platform: 'web', entry: 'app.html' }, artifacts: ['app.html', 'server.cjs'], build: '无需构建', run: '宿主启动服务', tests: [test] }))
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), JSON.stringify({ schemaVersion: 2, feature: 'US-01', scenario: 'US-01 服务显示', skip: false, skipReason: null, steps: [{ kind: 'then', text: '显示', op: { type: 'assert-visible', selector: 'data-ai-id=title' } }] }))
  return { projectDir: root, test, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
function fakeHandle(projectDir: string, digest: string): EngineeringServiceHandle & { stops: number } {
  const handle = {
    handleId: 'handle-fixture', baseUrl: 'http://127.0.0.1:18742', port: 18742, evidenceDigest: digest, stops: 0,
    entryUrl: (entry: string) => 'http://127.0.0.1:18742/' + entry,
    hasExited: () => false, exitCode: () => null,
    stop: async () => { handle.stops += 1 },
  }
  return handle
}
const servedScenarioResult = { feature: 'US-01', scenario: 'US-01 服务显示', status: 'pass' as const, reason: null, failedStep: null, screenshot: null, durationMs: 2 }

test('Given 已批准的browser-url测试 When 驱动执行 Then 先启动宿主服务再以实际入口URL跑GWT并必停服务', async () => {
  const input = servedFixture()
  const handle = fakeHandle(input.projectDir, input.evidence.digest)
  const urls: string[] = []
  let started = 0
  const driver = createEngineeringBrowserUrlDriver({
    validate: validateScenarioFileContent,
    startService: async () => { started++; return handle },
    run: async (_execution, scenarios, url) => { urls.push(url); expect(scenarios.length).toBe(1); return [servedScenarioResult] },
  })
  expect(driver.preflight?.(input)).toBeNull()
  const result = await driver.execute(input) as { testId: string; checks: { actual: string; storyId: string; evidence: string[] }[] }
  expect(started).toBe(1)
  expect(urls).toEqual(['http://127.0.0.1:18742/app.html'])
  expect(result.testId).toBe('served-ui')
  expect(result.checks[0]?.storyId).toBe('US-01')
  expect(result.checks[0]?.evidence[0]).toContain('host-gwt-browser-url')
  expect(result.checks[0]?.evidence[0]).toContain('http://127.0.0.1:18742/app.html')
  expect(handle.stops).toBe(1)
})
test('Given 批准被拒 When 执行协议先行 Then 0启动服务0打开页面', async () => {
  const input = servedFixture()
  let started = 0
  const driver = createEngineeringBrowserUrlDriver({ validate: validateScenarioFileContent, startService: async () => { started++; return fakeHandle(input.projectDir, input.evidence.digest) }, run: async () => [] })
  const result = await runRegisteredEngineeringTest(input, { drivers: [driver], approve: async () => false })
  expect(result.status).toBe('blocked')
  expect(started).toBe(0)
})
test('Given 服务在浏览器场景执行期间退出 When 驱动收尾 Then 不采信本轮结果且服务已停', async () => {
  const input = servedFixture()
  const handle = fakeHandle(input.projectDir, input.evidence.digest)
  handle.hasExited = () => true
  handle.exitCode = () => 3
  const driver = createEngineeringBrowserUrlDriver({ validate: validateScenarioFileContent, startService: async () => handle, run: async () => [servedScenarioResult] })
  await expect(driver.execute(input)).rejects.toThrow('退出')
  expect(handle.stops).toBe(1)
})
test('Given 场景执行抛出异常 When 驱动收尾 Then finally仍停止服务不泄漏', async () => {
  const input = servedFixture()
  const handle = fakeHandle(input.projectDir, input.evidence.digest)
  const driver = createEngineeringBrowserUrlDriver({ validate: validateScenarioFileContent, startService: async () => handle, run: async () => { throw new Error('CDP通道异常') } })
  await expect(driver.execute(input)).rejects.toThrow('CDP')
  expect(handle.stops).toBe(1)
})
test('Given browser-url验收对象与交付入口不同 When 预检 Then 阻塞而不启动服务', () => {
  const input = servedFixture()
  input.test = { ...input.test, target: 'other.html' }
  let started = 0
  const driver = createEngineeringBrowserUrlDriver({ validate: validateScenarioFileContent, startService: async () => { started++; return fakeHandle(input.projectDir, input.evidence.digest) }, run: async () => [] })
  expect(driver.preflight?.(input)).toContain('交付入口')
  expect(started).toBe(0)
})
test('Given browser-url缺少服务计划或未确认风险告知 When 预检 Then 无副作用阻塞', () => {
  const input = servedFixture()
  const services = { validate: validateScenarioFileContent, startService: async () => fakeHandle(input.projectDir, input.evidence.digest), run: async () => [] as never[] }
  const missingPlan = createEngineeringBrowserUrlDriver(services)
  const noPlanInput = { ...input, test: { ...input.test, service: undefined } }
  expect(missingPlan.preflight?.(noPlanInput)).toContain('服务计划')
  const risky = createEngineeringBrowserUrlDriver({ ...services, browserPrerequisite: () => '尚未确认平台账号风险告知，请到浏览器面板确认后重跑。' })
  expect(risky.preflight?.(input)).toContain('平台账号风险告知')
})
test('Given 浏览器执行已取消 When 驱动执行 Then 不启动服务', async () => {
  const input = servedFixture()
  const abort = new AbortController(); abort.abort(); input.signal = abort.signal
  let started = 0
  const driver = createEngineeringBrowserUrlDriver({ validate: validateScenarioFileContent, startService: async () => { started++; return fakeHandle(input.projectDir, input.evidence.digest) }, run: async () => [] })
  await expect(driver.execute(input)).rejects.toThrow('取消')
  expect(started).toBe(0)
})
test('Given 服务运行时缺失或文件不可执行 When 驱动预检 Then 返回缺失原因且0启动（S5）', () => {
  const input = servedFixture()
  let started = 0
  const driver = createEngineeringBrowserUrlDriver({
    validate: validateScenarioFileContent,
    serviceEnvironment: () => '缺少可用服务运行时：python3',
    startService: async () => { started++; return fakeHandle(input.projectDir, input.evidence.digest) },
    run: async () => [],
  })
  expect(driver.preflight?.(input)).toContain('运行时')
  expect(started).toBe(0)
})
