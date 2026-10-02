/**
 * Task 11（2026-09-20）第一核心片：骨架环境阻塞 → 宿主解释 → suite/GWT 状态与修复预算一致。
 *
 * 覆盖两层：
 * 1. 宿主 interpret 单元级（内存假驱动）：结构化 blocked 标记校验矩阵 + 旧协议 exit-2 兼容 + 伪造/异常 exit 2 归 error；
 * 2. 跨骨架→宿主集成级（真实子进程 + process driver）：blocked / pass / fail / error / 取消 / 伪造 exit2 六态。
 *
 * 架构原则（Task 11）：exit 2 本身不足以证明 blocked——宿主必须校验「来源、诊断、被测场景未执行」；
 * 产品 fail / 崩溃 / 坏 schema 不能洗成 blocked；blocked 的 coveredUs 为空且不消耗产品修复预算。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { captureEngineeringEvidence, parseEngineeringContract } from './nanju-engineering-contract'
import { runRegisteredEngineeringTest } from './nanju-engineering-execution'
import { runEngineeringSuite } from './nanju-engineering-suite'
import { detectEngineeringPython } from './nanju-engineering-runtime'
import type { EngineeringExecutionInput, EngineeringExecutionResult, EngineeringRegisteredDriver } from './nanju-engineering-execution'
import { createEngineeringProcessDrivers } from './nanju-engineering-process-driver'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TEMPLATES_DIR = join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates')
const SKELETON_CJS = join(TEMPLATES_DIR, 'driver-skeleton.cjs')
const SKELETON_PY = join(TEMPLATES_DIR, 'driver-skeleton.py')
if (!isAbsolute(SKELETON_CJS)) throw new Error('骨架路径异常')
// 系统Node用于真实进程fixture，不用Bun冒充Node（先例：nanju-engineering-process-driver.test.ts）
const nodePath = Bun.which('node')
if (!nodePath || !isAbsolute(nodePath)) throw new Error('真实进程fixture需要已安装的系统Node；禁止自动安装或用Bun替代')

let root = ''
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = '' } })

const processDrivers = () => createEngineeringProcessDrivers({ nodePath })

// ===== 单元级（内存假驱动）：host interpret 直接判定 =====
function inMemoryFixture(): EngineeringExecutionInput {
  root = mkdtempSync(join(tmpdir(), 'nanju-blocked-unit-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 读取应用数据')
  writeFileSync(join(root, '08_APP/app.txt'), 'hello')
  const raw = JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'blocked协议单元fixture', covers: ['US-01'], requiresReal: false }] })
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
  return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
function rawDriver(raw: unknown): EngineeringRegisteredDriver {
  return { adapter: 'cli-driver', execute: async () => raw }
}
function runWithRaw(raw: unknown): Promise<EngineeringExecutionResult> {
  return runRegisteredEngineeringTest(inMemoryFixture(), { drivers: [rawDriver(raw)], approve: async () => true })
}
const blockedMarker = (overrides: Record<string, unknown> = {}) => ({ kind: 'environment', missing: ['DISPLAY'], scenarioExecuted: false, ...overrides })
const goodCheck = (label = '标准输出', actual = 'hello') => ({ storyId: 'US-01', label, expected: 'hello', actual, evidence: ['受控fixture'] })

describe('Given 结构化环境阻塞标记（新协议），When 宿主解释，Then 校验来源/诊断/未执行后才判 blocked', () => {
  test('Then 合法 blocked 标记（exit 2 + missing + scenarioExecuted=false + checks空）判 blocked 且 coveredUs 为空', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: blockedMarker(), checks: [] })
    expect(result.status).toBe('blocked')
    expect(result.coveredUs).toEqual([])
    expect(result.reason).toContain('DISPLAY')
    expect(result.reason).toContain('不计入产品修复')
  })
  test('Then blocked 标记与 exit 0 冲突 → error（异常 exit 不洗成环境阻塞）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 0, blocked: blockedMarker(), checks: [] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('退出码不一致')
  })
  test('Then blocked 标记声称场景已执行（scenarioExecuted=true）→ error（与 blocked 语义冲突）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: blockedMarker({ scenarioExecuted: true }), checks: [] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('已执行')
  })
  test('Then blocked 标记缺 missing（空数组）→ error（无法校验诊断来源）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: blockedMarker({ missing: [] }), checks: [] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('缺失项')
  })
  test('Then blocked 标记携带产品检查 → error（阻塞结果不得混入产品断言）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: blockedMarker(), checks: [goodCheck()] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('产品检查')
  })
})

describe('Given 旧协议 exit-2 自检拦截（已复制到存量工程的旧骨架），When 宿主解释，Then 兼容映射', () => {
  test('Then 旧「环境前置自检」exit 2 → blocked（环境，向后兼容）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '缺失: DISPLAY', evidence: ['旧骨架自检'] }] })
    expect(result.status).toBe('blocked')
    expect(result.coveredUs).toEqual([])
    expect(result.reason).toContain('DISPLAY')
  })
  test('Then 旧「输出schema自检」exit 2 → error（坏 schema 不得洗成 blocked）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '输出schema自检', expected: 'x', actual: '结构违规: evidence', evidence: ['旧骨架自检'] }] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('schema')
  })
})

describe('Given 伪造/异常 exit 2，When 宿主解释，Then 不被洗成 blocked', () => {
  test('Then 伪造 exit 2（正常产品检查但 expected≠actual）→ fail 而非 blocked（exit 2 不能洗成环境阻塞）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [goodCheck('伪造exit2', 'goodbye')] })
    expect(result.status).toBe('fail')
    expect(result.status).not.toBe('blocked')
    expect(result.coveredUs).toEqual([])
  })
  test('Then exit 2 但 checks 为空且无 blocked 标记 → error（无行为检查，缺结构化阻塞标记）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [] })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('没有行为检查')
  })
})

describe('Given legacy 伪装产品失败（label=环境前置自检 但签名不符），When 宿主解释，Then 不判 blocked', () => {
  test('Then expected 非「环境就绪」→ 不判 blocked（落回产品 fail）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: 'hello', actual: 'goodbye', evidence: ['伪造'] }] })
    expect(result.status).not.toBe('blocked')
    expect(result.status).toBe('fail')
  })
  test('Then actual 无「缺失: 」前缀（产品断言失败伪装）→ 不判 blocked', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '产品断言失败', evidence: ['伪造'] }] })
    expect(result.status).not.toBe('blocked')
    expect(result.status).toBe('fail')
  })
  test('Then evidence 为空数组 → 不判 blocked（缺可信来源，归 error）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '缺失: DISPLAY', evidence: [] }] })
    expect(result.status).not.toBe('blocked')
    expect(result.status).toBe('error')
  })
  test('Then actual「缺失: 」后为空 → 不判 blocked（诊断无实际缺失项）', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '缺失: ', evidence: ['伪造'] }] })
    expect(result.status).not.toBe('blocked')
    expect(result.status).toBe('fail')
  })
  test('Then 多条 checks（非单条签名）→ 不判 blocked', async () => {
    const result = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [
      { storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '缺失: DISPLAY', evidence: ['伪造'] },
      { storyId: 'US-01', label: '标准输出', expected: 'hello', actual: 'hello', evidence: ['伪造'] },
    ] })
    expect(result.status).not.toBe('blocked')
  })
})

// ===== 集成级（真实子进程 + process driver + 骨架）=====
function integrationFixture(driverScript: string): EngineeringExecutionInput {
  root = mkdtempSync(join(tmpdir(), 'nanju-blocked-int-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 读取应用数据')
  writeFileSync(join(root, '08_APP/app.txt'), 'hello')
  copyFileSync(SKELETON_CJS, join(root, '08_APP/driver-skeleton.cjs'))
  writeFileSync(join(root, '08_APP/drv.cjs'), driverScript)
  const raw = JSON.stringify({ schemaVersion: 2, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt', 'driver-skeleton.cjs', 'drv.cjs'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'blocked协议集成fixture', covers: ['US-01'], requiresReal: false, driver: { runtime: 'node', path: 'drv.cjs', args: [], timeoutMs: 3000 } }] })
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
  return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
const skeletonBlocked = "const sk = require('./driver-skeleton.cjs'); sk.REQUIRED_DISPLAY = false; sk.REQUIRED_ENV_VARS = ['NANJU_BLOCKED_PROTO_TEST_VAR']; sk.runGuarded();\n"
const skeletonPass = "const sk = require('./driver-skeleton.cjs'); sk.REQUIRED_DISPLAY = false; sk.REQUIRED_ENV_VARS = []; sk.runProbes = (req) => [sk.makeCheck(req.covers[0], '读取fixture', 'hello', () => 'hello', ['probe: 读取返回 hello'])]; sk.runGuarded();\n"
const skeletonFail = "const sk = require('./driver-skeleton.cjs'); sk.REQUIRED_DISPLAY = false; sk.REQUIRED_ENV_VARS = []; sk.runProbes = (req) => [sk.makeCheck(req.covers[0], '读取fixture', 'hello', () => 'goodbye', ['probe: 读取返回 goodbye'])]; sk.runGuarded();\n"
const skeletonCrash = "const sk = require('./driver-skeleton.cjs'); sk.REQUIRED_DISPLAY = false; sk.REQUIRED_ENV_VARS = []; sk.runProbes = () => { throw new Error('boom-blocked-proto'); }; sk.runGuarded();\n"
const skeletonHang = "const sk = require('./driver-skeleton.cjs'); sk.REQUIRED_DISPLAY = false; sk.REQUIRED_ENV_VARS = []; sk.runProbes = () => new Promise(() => { setInterval(() => {}, 1000); }); sk.runGuarded();\n"
const forgedExit2 = "const fs = require('node:fs'); const req = JSON.parse(fs.readFileSync(0,'utf8')); console.log(JSON.stringify({testId:req.testId,target:req.target,checks:[{storyId:req.covers[0],label:'伪造exit2冒充环境阻塞',expected:'hello',actual:'goodbye',evidence:['伪造 exit 2']}]})); process.exit(2);\n"

describe('Given 真实骨架经 process driver 跑宿主，When 环境阻塞/通过/失败/崩溃/取消/伪造，Then 状态与修复预算一致', () => {
  test('Then 骨架环境阻塞（声明变量缺失）→ blocked，coveredUs 空（不计入产品修复预算）', async () => {
    const result = await runRegisteredEngineeringTest(integrationFixture(skeletonBlocked), { drivers: processDrivers(), approve: async () => true })
    expect(result.status).toBe('blocked')
    expect(result.coveredUs).toEqual([])
    expect(result.checks).toEqual([])
    expect(result.reason).toContain('NANJU_BLOCKED_PROTO_TEST_VAR')
  })
  test('Then 骨架 probe 通过 → pass', async () => {
    const result = await runRegisteredEngineeringTest(integrationFixture(skeletonPass), { drivers: processDrivers(), approve: async () => true })
    expect(result.status).toBe('pass')
    expect(result.coveredUs).toEqual(['US-01'])
  })
  test('Then 骨架 probe 不符 → fail（产品失败，非环境阻塞）', async () => {
    const result = await runRegisteredEngineeringTest(integrationFixture(skeletonFail), { drivers: processDrivers(), approve: async () => true })
    expect(result.status).toBe('fail')
    expect(result.coveredUs).toEqual([])
  })
  test('Then 骨架 probe 崩溃 → error（结构化 error JSON 后 exit 1）', async () => {
    const result = await runRegisteredEngineeringTest(integrationFixture(skeletonCrash), { drivers: processDrivers(), approve: async () => true })
    expect(result.status).toBe('error')
    expect(result.driverIo?.stderrTail).toContain('boom-blocked-proto')
  })
  test('Then 骨架挂起后取消 → blocked（取消，reason 含取消）', async () => {
    const input = integrationFixture(skeletonHang)
    const abort = new AbortController()
    const pending = runRegisteredEngineeringTest({ ...input, signal: abort.signal }, { drivers: processDrivers(), approve: async () => true })
    const timer = setTimeout(() => abort.abort(), 100)
    try {
      const result = await pending
      expect(result.status).toBe('blocked')
      expect(result.reason).toContain('取消')
    } finally { clearTimeout(timer) }
  })
  test('Then 伪造 exit 2（正常产品检查 + exit 2）→ fail 而非 blocked（exit 2 不足以证明 blocked）', async () => {
    const result = await runRegisteredEngineeringTest(integrationFixture(forgedExit2), { drivers: processDrivers(), approve: async () => true })
    expect(result.status).toBe('fail')
    expect(result.status).not.toBe('blocked')
    expect(result.coveredUs).toEqual([])
  })
})

// ===== 集成级：Python 骨架 → 宿主全链（补齐 Node 之外的 Python 全链覆盖）=====
describe('Given Python 骨架经 process driver 跑宿主，When 环境阻塞，Then 判 blocked 且 coveredUs 空', () => {
  function pythonBlockedFixture(): EngineeringExecutionInput {
    root = mkdtempSync(join(tmpdir(), 'nanju-blocked-py-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 读取应用数据')
    writeFileSync(join(root, '08_APP/app.txt'), 'hello')
    copyFileSync(SKELETON_PY, join(root, '08_APP/driver-skeleton.py'))
    writeFileSync(join(root, '08_APP/drv.py'), [
      'import importlib.util, sys',
      "spec = importlib.util.spec_from_file_location('drv_skeleton', 'driver-skeleton.py')",
      'sk = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(sk)',
      'sk.REQUIRED_DISPLAY = False',
      "sk.REQUIRED_ENV_VARS = ['NANJU_BLOCKED_PROTO_TEST_VAR']",
      'sk.run_guarded()',
      '',
    ].join('\n'))
    const raw = JSON.stringify({ schemaVersion: 2, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt', 'driver-skeleton.py', 'drv.py'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'python blocked协议集成fixture', covers: ['US-01'], requiresReal: false, driver: { runtime: 'python3', path: 'drv.py', args: [], timeoutMs: 3000 } }] })
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
    return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
  }
  test('Then Python 骨架环境阻塞（声明变量缺失）→ blocked，coveredUs 空，不消耗产品修复预算', async () => {
    const pythonPath = await detectEngineeringPython()
    if (!pythonPath) throw new Error('此集成fixture需要宿主Python3，未安装时不能宣称验证通过')
    const result = await runRegisteredEngineeringTest(pythonBlockedFixture(), { drivers: createEngineeringProcessDrivers({ pythonPath }), approve: async () => true })
    expect(result.status).toBe('blocked')
    expect(result.coveredUs).toEqual([])
    expect(result.checks).toEqual([])
    expect(result.reason).toContain('NANJU_BLOCKED_PROTO_TEST_VAR')
  })
})

// ===== suite 级：blocked 结果 → suite verdict=blocked（GWT 据此不计入产品修复预算）=====
describe('Given 驱动返回 blocked 结果，When 运行工程套件，Then verdict=blocked 且 coveredUs 空', () => {
  function suiteFixture(): string {
    root = mkdtempSync(join(tmpdir(), 'nanju-blocked-suite-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
    writeFileSync(join(root, '08_APP/app'), 'fixture')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app' }, artifacts: ['app'], build: 'fixture', run: 'fixture', tests: [{ id: 'acceptance', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '行为检查', covers: ['US-01'], requiresReal: false }] }))
    return root
  }
  const blockedDriver: EngineeringRegisteredDriver = {
    adapter: 'cli-driver',
    execute: async ({ test }) => ({ testId: test.id, target: test.target, exitCode: 2, blocked: { kind: 'environment', missing: ['DISPLAY'], scenarioExecuted: false }, checks: [] }),
  }
  test('Then suite verdict=blocked（非 fail），不进入产品修复预算', async () => {
    const result = await runEngineeringSuite(suiteFixture(), { drivers: [blockedDriver], approve: async () => true }, new AbortController().signal)
    expect(result.verdict).toBe('blocked')
    expect(result.coveredUs).toEqual([])
    expect(result.tests[0]?.status).toBe('blocked')
  })
})
