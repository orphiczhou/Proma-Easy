/**
 * served URL 工程服务（W-C）：宿主持有的 loopback 服务生命周期。
 * 边界：服务计划来自契约（固定 runtime+argv），单次批准前不得启动；
 * 端口已被占用即拒绝，不接管他人服务，也不把已有未知端口服务冒充产物；
 * 句柄由宿主持有，就绪失败/取消/超时/结束一律杀进程组并注销 lease。
 *
 * 就绪归属（S1）：每次启动生成不可预测 nonce，仅经子进程 env 下发（不继承渠道密钥、
 * 不写契约）；就绪探测只认「响应带匹配 nonce」（header `x-proma-ready-nonce` 或 body），
 * 任意 HTTP 状态码不够；端口探测到 spawn 的 TOCTOU 由 nonce 归属校验封口——抢占者拿不到
 * nonce，无法伪造就绪。
 *
 * 平台（S2）：win32 上进程树回收（Job Object）未实现，预检/start 明确 blocked、禁止 spawn；
 * 本片不宣称 OS 沙箱——服务进程可读写文件/访问网络/占用设备，由单次批准内容说明副作用。
 *
 * 登记表（S4）：按 lease（handleId+sessionId+testId+evidenceDigest+origin）记账；stop 只注销
 * 自身 handleId 的 lease，并发旧 stop 不会撤销新 lease；browser-controller 校验 session+URL。
 *
 * 测试通过注入 deps 验证状态机，不真实监听端口、不真实 spawn。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { accessSync, constants, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'
import type { EngineeringServicePlan } from './nanju-engineering-contract'

export interface EngineeringServiceRuntimes {
  /** 由宿主环境探测提供，不从项目JSON指定解释器绝对路径。 */
  nodePath?: string
  pythonPath?: string
}

/** 宿主持有的子进程句柄（生产为 detached 进程组；测试注入可控fixture）。 */
export interface EngineeringServiceChild {
  pid: number | undefined
  killGroup(): void
  hasExited(): boolean
  exitCode(): number | null
}

/** 就绪探测结论：status 为 HTTP 状态码；nonceMatch 表示响应携带本次启动的匹配 nonce。 */
export interface EngineeringReadyProbe {
  status: number | null
  nonceMatch: boolean
}

export interface EngineeringServiceDeps {
  spawnService(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): EngineeringServiceChild
  /** 探测loopback端口是否已被占用（true=占用，拒绝启动）。 */
  probeLoopbackPort(port: number): Promise<boolean>
  /** 请求就绪路径并校验响应 nonce；无响应或 nonce 不匹配返回 nonceMatch=false。 */
  requestReady(baseUrl: string, readyPath: string, readyNonce: string, timeoutMs: number, signal: AbortSignal): Promise<EngineeringReadyProbe>
  now(): number
  sleep(ms: number): Promise<void>
  /** 平台（生产默认 process.platform）；测试注入 'win32' 断言 blocked。 */
  platform?: NodeJS.Platform
}

export interface EngineeringServiceHandle {
  /** 每次 start 生成的唯一句柄 id，用于 lease 精确注销（并发旧 stop 不撤销新 lease）。 */
  handleId: string
  baseUrl: string
  port: number
  evidenceDigest: string
  /** 仅接受规范相对路径（契约entry口径），编码拼接，防止拼出任意地址。 */
  entryUrl(entryPath: string): string
  hasExited(): boolean
  exitCode(): number | null
  /** 杀进程组、注销自身 lease、有界等待进程退出；幂等。 */
  stop(): Promise<void>
}

/** 就绪 nonce 下发 env 键与响应 header 键（子进程实现方据此回传 nonce）。 */
export const SERVICE_READY_NONCE_ENV = 'PROMA_ENGINEERING_READY_NONCE'
export const SERVICE_READY_NONCE_HEADER = 'x-proma-ready-nonce'

/** 服务归属 lease：handleId 唯一，绑定 session/test/digest/origin。 */
interface EngineeringServiceLease {
  handleId: string
  sessionId: string
  testId: string
  evidenceDigest: string
  origin: string
}

const activeLeases = new Map<string, EngineeringServiceLease>()

/** browser-controller URL 门：仅放行「本 session 登记在册」的 127.0.0.1 工程服务地址；缺 sessionId 一律 fail-closed（不回退全局放行）。 */
export function isRegisteredEngineeringServiceUrl(url: string, sessionId?: string): boolean {
  // N3：缺 sessionId 即 fail-closed，不回退「任一已登记 origin 均放行」。
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false
  if (typeof url !== 'string' || url.length > 2048) return false
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '') return false
  for (const lease of activeLeases.values()) {
    if (lease.origin !== parsed.origin) continue
    if (lease.sessionId !== sessionId) continue
    return true
  }
  return false
}

/** 测试专用：清空登记表（防跨用例污染）；仅测试调用。 */
export function __resetEngineeringServiceRegistryForTests(): void {
  activeLeases.clear()
}

/**
 * 稳定描述 browser-url 服务计划（供单次批准说明使用）。
 * C 只导出稳定描述；approval 侧接线归 I（S3）。
 */
export function describeEngineeringServicePlan(service: EngineeringServicePlan): string {
  return `服务运行时：${service.runtime}；服务文件：${service.path}；参数：${JSON.stringify(service.args)}；` +
    `端口：127.0.0.1:${service.port}；就绪路径：${service.readyPath}；就绪超时：${service.readyTimeoutMs}ms` +
    '（宿主在批准后先启动该 loopback 服务，端口被占用即拒绝，不接管他人服务）'
}

function resolveExecutable(input: EngineeringExecutionInput, runtimes: EngineeringServiceRuntimes): string {
  const plan = input.test.service
  if (!plan) throw new EngineeringExecutionBlocked('browser-url测试缺少service服务计划，不能执行command说明')
  const executable = plan.runtime === 'native' ? join(input.projectDir, '08_APP', plan.path)
    : plan.runtime === 'node' ? runtimes.nodePath : runtimes.pythonPath
  if (!executable || !isAbsolute(executable)) throw new EngineeringExecutionBlocked('缺少可用服务运行时：' + plan.runtime)
  try { accessSync(executable, constants.X_OK) } catch { throw new EngineeringExecutionBlocked('服务运行时不可执行：' + plan.runtime) }
  return executable
}

/** 无副作用预检：平台 + 计划 + 运行时 + 服务文件齐备性（不探测端口、不spawn）。 */
export function validateEngineeringServiceEnvironment(input: EngineeringExecutionInput, runtimes: EngineeringServiceRuntimes, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return 'Windows 平台尚未实现服务进程树回收（Job Object），browser-url 测试不可用；当前不在 Windows 上启动工程服务。'
  const plan = input.test.service
  if (!plan) return 'browser-url测试缺少service服务计划，请在契约中声明固定runtime与argv'
  try { resolveExecutable(input, runtimes) } catch (error) { return error instanceof Error ? error.message : String(error) }
  try {
    const file = join(input.projectDir, '08_APP', plan.path)
    if (!lstatSync(file).isFile()) return '服务文件不可用：' + plan.path
  } catch { return '服务文件不可用：' + plan.path }
  return null
}

/** 就绪探测间隔（生产值；测试注入 sleep 立即返回）。 */
const SERVICE_READY_POLL_MS = 250
/** stop 后有界等待进程退出的上限（S7：确保端口释放，避免下一轮误报端口占用）。 */
const SERVICE_STOP_WAIT_MS = 2000
/** 就绪响应 body 累计缓冲上限（N5：有界全文搜索 nonce，覆盖首段含 nonce 的大响应体）。 */
const READY_BODY_SCAN_LIMIT = 64 * 1024

function generateReadyNonce(): string {
  return randomBytes(32).toString('hex')
}

export async function startEngineeringService(input: EngineeringExecutionInput, runtimes: EngineeringServiceRuntimes, deps: EngineeringServiceDeps, sessionId: string): Promise<EngineeringServiceHandle> {
  const plan = input.test.service
  if (!plan) throw new EngineeringExecutionBlocked('browser-url测试缺少service服务计划，不能执行command说明')
  if (input.signal.aborted) throw new EngineeringExecutionBlocked('工程测试已取消')
  if ((deps.platform ?? process.platform) === 'win32') {
    throw new EngineeringExecutionBlocked('Windows 平台尚未实现服务进程树回收（Job Object），不启动服务、不 spawn；请勿在 Windows 上运行 browser-url 测试。')
  }
  const executable = resolveExecutable(input, runtimes)
  const cwd = join(input.projectDir, '08_APP')
  try { if (!lstatSync(join(cwd, plan.path)).isFile()) throw new EngineeringExecutionBlocked('服务文件不可用：' + plan.path) }
  catch (error) { if (error instanceof EngineeringExecutionBlocked) throw error; throw new EngineeringExecutionBlocked('服务文件不可用：' + plan.path) }
  if (await deps.probeLoopbackPort(plan.port)) {
    throw new EngineeringExecutionBlocked(`服务端口已被占用：127.0.0.1:${plan.port}。拒绝接管他人服务；请更换契约端口或释放占用后重跑。`)
  }
  // S1：每次启动生成不可预测 nonce，仅经子进程 env 下发；就绪响应必须带匹配 nonce。
  const readyNonce = generateReadyNonce()
  const handleId = randomUUID()
  const baseUrl = `http://127.0.0.1:${plan.port}`
  // 不继承渠道密钥；nonce 作为唯一「本进程身份」随 env 下发，服务需要的网络/设备副作用由单次批准内容说明。
  const child = deps.spawnService(executable, plan.args, cwd, {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
    DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, PULSE_SERVER: process.env.PULSE_SERVER,
    [SERVICE_READY_NONCE_ENV]: readyNonce,
  })
  let stopped = false
  const teardown = (): void => {
    if (stopped) return
    stopped = true
    child.killGroup()
    activeLeases.delete(handleId)
  }
  const startedAt = deps.now()
  while (true) {
    if (input.signal.aborted) { teardown(); throw new EngineeringExecutionBlocked('工程测试已取消，服务未交付使用') }
    if (child.hasExited()) {
      teardown()
      throw new Error(`服务进程在就绪前提前退出，退出码 ${child.exitCode() ?? '未知'}；请检查服务实现或就绪路径 ${plan.readyPath}`)
    }
    const probe = await deps.requestReady(baseUrl, plan.readyPath, readyNonce, Math.max(100, Math.min(plan.readyTimeoutMs, 2000)), input.signal)
    if (probe.nonceMatch) break
    if (deps.now() - startedAt > plan.readyTimeoutMs) {
      teardown()
      throw new EngineeringExecutionBlocked(`服务就绪超时（${plan.readyTimeoutMs}ms 内 ${plan.readyPath} 未带本次启动 nonce 响应）。已停止服务；请核对服务是否读取 ${SERVICE_READY_NONCE_ENV} 并在响应 ${SERVICE_READY_NONCE_HEADER} 或 body 回传。`)
    }
    await deps.sleep(SERVICE_READY_POLL_MS)
  }
  if (child.hasExited()) {
    teardown()
    throw new Error(`服务进程在就绪应答后立即退出，退出码 ${child.exitCode() ?? '未知'}；本轮结果不可用`)
  }
  activeLeases.set(handleId, { handleId, sessionId, testId: input.test.id, evidenceDigest: input.evidence.digest, origin: baseUrl })
  return {
    handleId,
    baseUrl,
    port: plan.port,
    evidenceDigest: input.evidence.digest,
    entryUrl(entryPath: string): string {
      if (typeof entryPath !== 'string' || entryPath.length === 0 || entryPath.length > 512
        || entryPath.startsWith('/') || entryPath.includes('\\') || /[\\:\u0000-\u001f]/.test(entryPath)
        || entryPath.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error('服务入口必须是规范相对路径：' + entryPath)
      }
      return baseUrl + '/' + entryPath.split('/').map(encodeURIComponent).join('/')
    },
    hasExited: () => child.hasExited(),
    exitCode: () => child.exitCode(),
    async stop(): Promise<void> {
      if (stopped) return
      teardown()
      // S7：有界等待进程退出，确保端口释放；FakeChild 场景由注入 sleep 快速推进虚拟时间。
      const deadline = deps.now() + SERVICE_STOP_WAIT_MS
      while (!child.hasExited() && deps.now() < deadline) {
        await deps.sleep(SERVICE_READY_POLL_MS)
      }
    },
  }
}

/** 生产 deps：真实 spawn（detached 进程组）、TCP 探测与 HTTP 就绪请求（含 nonce 校验）。 */
export function createDefaultEngineeringServiceDeps(): EngineeringServiceDeps {
  return {
    spawnService(executable, args, cwd, env) {
      const { spawn } = require('node:child_process') as typeof import('node:child_process')
      const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      // 只保留末段stderr用于失败归因，不落盘日志。
      let tail = ''
      child.stderr?.on('data', (data: Buffer) => { tail = (tail + data.toString('utf-8')).slice(-4096) })
      let exited = false
      let code: number | null = null
      child.once('close', (exitCode) => { exited = true; code = exitCode ?? -1 })
      return {
        pid: child.pid,
        killGroup(): void {
          if (!child.pid || exited) return
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
        },
        hasExited: () => exited,
        exitCode: () => (exited ? code : null),
      }
    },
    probeLoopbackPort(port): Promise<boolean> {
      const net = require('node:net') as typeof import('node:net')
      return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port })
        socket.setTimeout(500)
        socket.once('connect', () => { socket.destroy(); resolve(true) })
        socket.once('error', () => resolve(false))
        socket.once('timeout', () => { socket.destroy(); resolve(false) })
      })
    },
    requestReady(baseUrl, readyPath, readyNonce, timeoutMs, signal): Promise<EngineeringReadyProbe> {
      const http = require('node:http') as typeof import('node:http')
      return new Promise((resolve) => {
        if (signal.aborted) { resolve({ status: null, nonceMatch: false }); return }
        let settled = false
        const onAbort = (): void => {
          request.destroy()
          done({ status: null, nonceMatch: false })
        }
        const done = (result: EngineeringReadyProbe): void => {
          if (settled) return
          settled = true
          // S8：resolve 前移除监听，避免就绪轮询累积 abort 监听器。
          signal.removeEventListener('abort', onAbort)
          resolve(result)
        }
        let body = ''
        const request = http.get(baseUrl + readyPath, { timeout: timeoutMs }, (response) => {
          const status = response.statusCode ?? null
          const headerNonce = String(response.headers[SERVICE_READY_NONCE_HEADER] ?? '')
          if (headerNonce === readyNonce) { response.resume(); done({ status, nonceMatch: true }); return }
          response.setEncoding('utf-8')
          response.on('data', (chunk: string) => {
            // N5：在累计缓冲（有界）内全文搜索 nonce，不固定只留末段；nonce 出现在首段也能命中。
            body = (body + chunk).slice(-READY_BODY_SCAN_LIMIT)
            if (body.includes(readyNonce)) { response.destroy(); done({ status, nonceMatch: true }) }
          })
          response.on('end', () => done({ status, nonceMatch: body.includes(readyNonce) }))
          response.on('error', () => done({ status, nonceMatch: false }))
        })
        request.once('error', () => done({ status: null, nonceMatch: false }))
        request.once('timeout', () => { request.destroy(); done({ status: null, nonceMatch: false }) })
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform: process.platform,
  }
}
