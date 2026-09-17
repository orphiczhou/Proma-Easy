import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startEngineeringService, validateEngineeringServiceEnvironment, isRegisteredEngineeringServiceUrl, describeEngineeringServicePlan, SERVICE_READY_NONCE_ENV, __resetEngineeringServiceRegistryForTests } from './nanju-engineering-service'
import type { EngineeringServiceChild, EngineeringServiceDeps } from './nanju-engineering-service'
import { captureEngineeringEvidence } from './nanju-engineering-contract'
import type { EngineeringTestPlan } from './nanju-engineering-contract'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'

/** 可控子进程fixture：手动触发现象，不真实启动任何进程或监听端口。 */
class FakeChild implements EngineeringServiceChild {
  pid = 4242
  killed = 0
  private exited = false
  private code: number | null = null
  killGroup(): void { this.killed += 1 }
  hasExited(): boolean { return this.exited }
  exitCode(): number | null { return this.code }
  triggerExit(code: number | null): void { this.exited = true; this.code = code }
}

interface DepsScript {
  portOccupied?: boolean
  /** requestReady 是否返回 nonceMatch=true（默认 false，即抢占者/未就绪）。 */
  readyNonceMatch?: boolean
  /** 返回的 HTTP 状态码；null 表示无响应（默认 200）。 */
  readyStatus?: number | null
  platform?: NodeJS.Platform
  child?: FakeChild
}
interface FakeDeps extends EngineeringServiceDeps {
  spawns: number
  readyProbes: number
  children: FakeChild[]
  readyNonces: string[]
  spawnedEnvs: NodeJS.ProcessEnv[]
}
function fakeDeps(script: DepsScript = {}): FakeDeps {
  const children: FakeChild[] = []
  const readyNonces: string[] = []
  const spawnedEnvs: NodeJS.ProcessEnv[] = []
  let virtualNow = Date.now()
  const deps: FakeDeps = {
    spawns: 0,
    readyProbes: 0,
    children,
    readyNonces,
    spawnedEnvs,
    platform: script.platform,
    spawnService: (_exe, _args, _cwd, env) => {
      deps.spawns += 1
      spawnedEnvs.push(env)
      const child = script.child ?? new FakeChild()
      children.push(child)
      return child
    },
    probeLoopbackPort: async () => script.portOccupied === true,
    requestReady: async (_base, _path, readyNonce, _timeout, _signal) => {
      deps.readyProbes += 1
      readyNonces.push(readyNonce)
      if (script.readyStatus === null) return { status: null, nonceMatch: false }
      return { status: script.readyStatus ?? 200, nonceMatch: script.readyNonceMatch === true }
    },
    now: () => virtualNow,
    sleep: async (ms: number) => { virtualNow += ms },
  }
  return deps
}

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
  __resetEngineeringServiceRegistryForTests()
})

function fixture(): { projectDir: string; test: EngineeringTestPlan; signal: AbortSignal } {
  root = mkdtempSync(join(tmpdir(), 'nanju-engineering-service-'))
  for (const path of ['01_PRD', '03_ARCHITECTURE', '08_APP', '06_TESTS/features']) mkdirSync(join(root, path), { recursive: true })
  const test: EngineeringTestPlan = {
    id: 'served-ui', adapter: 'browser-url', layer: 'acceptance', target: 'index.html', command: '浏览器经服务入口验证',
    covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'],
    service: { runtime: 'node', path: 'server.cjs', args: ['--fixture'], port: 18742, readyPath: '/healthz', readyTimeoutMs: 500 },
  }
  writeFileSync(join(root, '08_APP/index.html'), '<h1>fixture</h1>')
  writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture，不真实启动')
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 服务页面')
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
    schemaVersion: 1, target: { kind: 'web', platform: 'web', entry: 'index.html' },
    artifacts: ['index.html', 'server.cjs'], build: '无需构建', run: '宿主启动server.cjs后经loopback访问', tests: [test],
  }))
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), JSON.stringify({ schemaVersion: 2, feature: 'US-01', scenario: 'US-01 显示', skip: false, skipReason: null, steps: [{ kind: 'then', text: '显示', op: { type: 'assert-visible', selector: 'data-ai-id=title' } }] }))
  return { projectDir: root, test, signal: new AbortController().signal }
}
function input(): EngineeringExecutionInput {
  const base = fixture()
  const evidence = captureEngineeringEvidence(base.projectDir).evidence
  if (!evidence) throw new Error('fixture工程证据缺失')
  return { ...base, evidence }
}
const runtimes = { nodePath: process.execPath }
const SESSION = 'session-A'

describe('Given browser-url工程服务计划，When 宿主启动，Then 未获批准的路径0启动', () => {
  test('Then 缺服务计划或运行时不可用直接阻塞且不spawn', async () => {
    const base = input()
    base.test = { ...base.test, service: undefined }
    const deps = fakeDeps()
    await expect(startEngineeringService(base as never, {}, deps, SESSION)).rejects.toThrow('服务计划')
    base.test = fixture().test
    const noRuntime = fakeDeps()
    await expect(startEngineeringService(base, {}, noRuntime, SESSION)).rejects.toThrow('运行时')
    expect(noRuntime.spawns).toBe(0)
    expect(validateEngineeringServiceEnvironment(base, {})).toContain('运行时')
  })
  test('Then 取消前置0启动', async () => {
    const base = input()
    const aborted = new AbortController()
    aborted.abort()
    const deps = fakeDeps()
    await expect(startEngineeringService({ ...base, signal: aborted.signal }, runtimes, deps, SESSION)).rejects.toThrow('取消')
    expect(deps.spawns).toBe(0)
  })
  test('Then 端口已被占用时拒绝启动且不接管他人服务', async () => {
    const base = input()
    const deps = fakeDeps({ portOccupied: true })
    await expect(startEngineeringService(base, runtimes, deps, SESSION)).rejects.toThrow('端口已被占用')
    expect(deps.spawns).toBe(0)
  })
  test('Then win32平台明确blocked且禁止spawn（不宣称OS沙箱）', async () => {
    const base = input()
    expect(validateEngineeringServiceEnvironment(base, runtimes, 'win32')).toContain('Windows')
    const deps = fakeDeps({ platform: 'win32' })
    await expect(startEngineeringService(base, runtimes, deps, SESSION)).rejects.toThrow('Windows')
    expect(deps.spawns).toBe(0)
  })
})

describe('Given 服务已spawn，When 等待就绪，Then 生命周期状态机完整清理', () => {
  test('Then 就绪成功返回句柄并登记lease，stop杀组注销且幂等', async () => {
    const base = input()
    const deps = fakeDeps({ readyNonceMatch: true })
    const handle = await startEngineeringService(base, runtimes, deps, SESSION)
    expect(handle.baseUrl).toBe('http://127.0.0.1:18742')
    expect(handle.entryUrl('index.html')).toBe('http://127.0.0.1:18742/index.html')
    expect(handle.evidenceDigest).toBe(base.evidence.digest)
    expect(handle.handleId).toBeTruthy()
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/index.html', SESSION)).toBe(true)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/', SESSION)).toBe(true)
    expect(isRegisteredEngineeringServiceUrl('http://example.com/index.html', SESSION)).toBe(false)
    // N3：缺 sessionId fail-closed，不回退全局放行。
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/index.html')).toBe(false)
    await handle.stop()
    expect(deps.children[0]?.killed).toBeGreaterThan(0)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/index.html', SESSION)).toBe(false)
    await handle.stop()
    expect(deps.children[0]?.killed).toBe(1)
  })
  test('Then 就绪只认匹配nonce，任意HTTP状态码不够（S1）', async () => {
    const base = input()
    // 有 HTTP 响应（404）但 nonce 匹配 → 仍就绪（状态码不是判据）
    const deps = fakeDeps({ readyNonceMatch: true, readyStatus: 404 })
    const handle = await startEngineeringService(base, runtimes, deps, SESSION)
    expect(handle.port).toBe(18742)
    await handle.stop()
  })
  test('Then 每次启动生成不可预测nonce并经env下发，就绪探测携带同一nonce（S1）', async () => {
    const base = input()
    const deps = fakeDeps({ readyNonceMatch: true })
    const handle = await startEngineeringService(base, runtimes, deps, SESSION)
    const envNonce = deps.spawnedEnvs[0]?.[SERVICE_READY_NONCE_ENV]
    expect(envNonce).toMatch(/^[0-9a-f]{64}$/)
    expect(deps.readyNonces[0]).toBe(envNonce)
    expect(deps.readyNonces[0]).toBeTruthy()
    await handle.stop()
  })
  test('Then 端口探测空闲但被外部监听者应答（无nonce）→ 不认定为就绪并超时blocked（S1）', async () => {
    const base = input()
    // 抢占者不知 nonce，永远 nonceMatch=false，即便返回 200
    const deps = fakeDeps({ readyNonceMatch: false, readyStatus: 200 })
    await expect(startEngineeringService(base, runtimes, deps, SESSION)).rejects.toThrow('就绪超时')
    expect(deps.children[0]?.killed).toBeGreaterThan(0)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/')).toBe(false)
  })
  test('Then 就绪超时杀组注销并阻塞', async () => {
    const base = input()
    const deps = fakeDeps({ readyStatus: null })
    await expect(startEngineeringService(base, runtimes, deps, SESSION)).rejects.toThrow('就绪超时')
    expect(deps.children[0]?.killed).toBeGreaterThan(0)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/')).toBe(false)
  })
  test('Then 就绪前进程提前退出立即失败清理', async () => {
    const base = input()
    const child = new FakeChild()
    const deps = fakeDeps({ child })
    const pending = startEngineeringService(base, runtimes, deps, SESSION)
    child.triggerExit(1)
    await expect(pending).rejects.toThrow('提前退出')
    expect(child.killed).toBeGreaterThan(0)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/')).toBe(false)
  })
  test('Then 就绪期间取消触发清理', async () => {
    const base = input()
    const abort = new AbortController()
    const deps = fakeDeps({ readyStatus: null })
    const pending = startEngineeringService({ ...base, signal: abort.signal }, runtimes, deps, SESSION)
    abort.abort()
    await expect(pending).rejects.toThrow()
    expect(deps.children[0]?.killed).toBeGreaterThan(0)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/')).toBe(false)
  })
  test('Then stop有界等待进程退出且不挂起（S7）', async () => {
    const base = input()
    const deps = fakeDeps({ readyNonceMatch: true })
    const handle = await startEngineeringService(base, runtimes, deps, SESSION)
    // FakeChild 不自动退出，stop 走完有界等待（虚拟时间推进）后返回，不真实挂起。
    await handle.stop()
    expect(deps.children[0]?.killed).toBe(1)
  })
})

describe('Given 服务句柄构造URL，When entryPath不合规，Then 拒绝拼出任意地址', () => {
  test('Then 绝对路径、父级引用与反斜杠拒绝；子路径编码拼接', async () => {
    const base = input()
    const deps = fakeDeps({ readyNonceMatch: true })
    const handle = await startEngineeringService(base, runtimes, deps, SESSION)
    expect(() => handle.entryUrl('/etc/passwd')).toThrow()
    expect(() => handle.entryUrl('../outside.html')).toThrow()
    expect(() => handle.entryUrl('a\\b.html')).toThrow()
    expect(handle.entryUrl('docs/note 1.html')).toBe('http://127.0.0.1:18742/docs/note%201.html')
    await handle.stop()
  })
})

describe('Given 服务lease归属，When 跨会话或并发stop，Then 精确注销不误伤（S4）', () => {
  test('Then 会话A登记的服务不向会话B放行', async () => {
    const base = input()
    const deps = fakeDeps({ readyNonceMatch: true })
    const handle = await startEngineeringService(base, runtimes, deps, 'session-A')
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/', 'session-A')).toBe(true)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/', 'session-B')).toBe(false)
    await handle.stop()
  })
  test('Then 并发旧stop不撤销新lease', async () => {
    const depsA = fakeDeps({ readyNonceMatch: true })
    const depsB = fakeDeps({ readyNonceMatch: true })
    const base = input()
    const handleA = await startEngineeringService(base, runtimes, depsA, SESSION)
    // 第二个服务用不同端口（同端口会被端口占用拒绝），归属同一 session 不同 handle。
    const baseB = input()
    baseB.test = { ...baseB.test, service: { ...baseB.test.service!, port: 18743 } }
    const handleB = await startEngineeringService(baseB, runtimes, depsB, SESSION)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/', SESSION)).toBe(true)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18743/', SESSION)).toBe(true)
    await handleA.stop()
    // 旧 stop 只注销自身 lease，不影响新 lease
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18742/', SESSION)).toBe(false)
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18743/', SESSION)).toBe(true)
    await handleB.stop()
    expect(isRegisteredEngineeringServiceUrl('http://127.0.0.1:18743/', SESSION)).toBe(false)
  })
})

describe('Given 单次批准说明，When 描述browser-url服务计划，Then 列出命令与端口（S3，接线归I）', () => {
  test('Then describeEngineeringServicePlan 含 runtime/path/args/port/readyPath', () => {
    const base = input()
    const description = describeEngineeringServicePlan(base.test.service!)
    expect(description).toContain('node')
    expect(description).toContain('server.cjs')
    expect(description).toContain('--fixture')
    expect(description).toContain('18742')
    expect(description).toContain('/healthz')
  })
})
