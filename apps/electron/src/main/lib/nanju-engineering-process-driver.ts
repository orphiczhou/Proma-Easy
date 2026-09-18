/** 项目测试驱动进程：仅供宿主执行协议调用，不暴露为Agent任意命令工具。 */
import { spawn } from 'node:child_process'
import { accessSync, constants, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import type { EngineeringExecutionInput, EngineeringRegisteredDriver } from './nanju-engineering-execution'
import { DriverIoTailBuffer, type EngineeringDriverIo } from './nanju-engineering-driver-io'

/** P0-2：错误携带驱动 IO 尾部（process-driver reject → execution catch → suite/tests →
 * gwt 报告；内存透传，不落盘）。 */
interface DriverIoError extends Error {
  driverIo?: EngineeringDriverIo
}

export interface EngineeringProcessRuntime {
  /** 由宿主环境探测提供，不从项目JSON指定解释器绝对路径。 */
  nodePath?: string
  pythonPath?: string
  maxOutputBytes?: number
}
function resolveExecutable(input: EngineeringExecutionInput, runtimes: EngineeringProcessRuntime): string {
  const plan = input.test.driver
  if (!plan) throw new EngineeringExecutionBlocked('缺少结构化测试驱动，不能执行command说明')
  const executable = plan.runtime === 'native' ? join(input.projectDir, '08_APP', plan.path)
    : plan.runtime === 'node' ? runtimes.nodePath : runtimes.pythonPath
  if (!executable || !isAbsolute(executable)) throw new EngineeringExecutionBlocked('缺少可用运行时：' + plan.runtime)
  try { accessSync(executable, constants.X_OK) } catch { throw new EngineeringExecutionBlocked('运行时不可执行：' + plan.runtime) }
  return executable
}

/** P0-1（2026-09-18）：构建驱动子进程 env——固定白名单 ∪ 契约声明 env（仅变量名，
 * 值取宿主进程环境且不落盘；宿主缺该变量时不注入，由驱动自身如实报告缺失）。
 * 密钥值永不写入工程文件/日志/报告。 */
function buildDriverEnv(declared?: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
    DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, PULSE_SERVER: process.env.PULSE_SERVER,
    // 过渡期兜底（P0-1 落地顺序②，防空窗）：与契约透传双通道并存。移除触发件=首个含云端
    // 密钥新项目实测契约透传通过，或 G3b engineering.json 副本（显式升 v2+声明 env）夹具
    // 集成验证通过——二选一先到后独立 commit 移除（chore: remove-dashscope-hardcode）。
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
  }
  for (const name of declared ?? []) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

/** 固定argv、项目cwd、有限输出与执行时间；不是OS沙箱，项目脚本副作用须由单次批准承担。 */
async function executeProcess(input: EngineeringExecutionInput, runtimes: EngineeringProcessRuntime): Promise<unknown> {
  const executable = resolveExecutable(input, runtimes)
  const plan = input.test.driver!
  const cwd = join(input.projectDir, '08_APP')
  const driverPath = join(cwd, plan.path)
  // 摘要校验与执行之间的极小窗口里文件可能被删除/替换：缺文件与非常规文件都必须归一为
  // EngineeringExecutionBlocked（交由调用方记 blocked），不能漏出裸 ENOENT 被当成执行异常。
  let driverIsRegularFile = false
  try { driverIsRegularFile = lstatSync(driverPath).isFile() } catch { driverIsRegularFile = false }
  if (!driverIsRegularFile) throw new EngineeringExecutionBlocked('驱动文件不可用')
  const args = plan.runtime === 'native' ? [...plan.args] : [driverPath, ...plan.args]
  // Windows进程树回收需Job Object等专门机制，未接入前不冒充跨平台执行能力。
  if (process.platform === 'win32') throw new EngineeringExecutionBlocked('Windows测试进程树回收适配尚未接入')
  if (input.signal.aborted) throw new EngineeringExecutionBlocked('测试已取消')
  const limit = runtimes.maxOutputBytes ?? 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      // 不继承渠道密钥；需要网络/设备的驱动须在契约 driver.env 声明变量名并经单次批准。
      env: buildDriverEnv(plan.env),
    })
    let stdout = Buffer.alloc(0)
    let total = 0
    let failure: Error | null = null
    let settled = false
    // P0-2：驱动 stdout/stderr 尾部捕获（stderr 此前只计数不保存——G3b 5 轮盲修根因）
    const stdoutTailBuf = new DriverIoTailBuffer()
    const stderrTailBuf = new DriverIoTailBuffer()
    const driverIo = (): EngineeringDriverIo => ({ stdoutTail: stdoutTailBuf.tail(), stderrTail: stderrTailBuf.tail() })
    const rejectWithIo = (error: Error): void => {
      (error as DriverIoError).driverIo = driverIo()
      reject(error)
    }
    const killGroup = (): void => {
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
    const stop = (error: Error): void => { failure ??= error; killGroup() }
    const onAbort = (): void => stop(new EngineeringExecutionBlocked('测试已取消'))
    const timeout = setTimeout(() => stop(new Error('测试驱动执行超时')), plan.timeoutMs)
    const cleanup = (): void => { clearTimeout(timeout); input.signal.removeEventListener('abort', onAbort); killGroup() }
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    const append = (data: Buffer, capture: boolean): void => {
      total += data.length
      if (total > limit) { stop(new Error('测试驱动输出超过限制')); return }
      if (capture) stdout = Buffer.concat([stdout, data])
      // P0-2：两通道均入尾部缓冲（stdout 全量拼接用于 JSON 解析，尾部管道另走）
      stdoutTailBuf.append(data)
    }
    child.stdout.on('data', (data: Buffer) => append(data, true))
    child.stderr.on('data', (data: Buffer) => { total += data.length; if (total > limit) { stop(new Error('测试驱动输出超过限制')); return }; stderrTailBuf.append(data) })
    child.stdin.on('error', () => { /* 子进程提前退出时由exitCode统一判定 */ })
    child.once('error', (error) => {
      if (settled) return
      settled = true; cleanup(); reject(error)
    })
    child.once('exit', () => { killGroup() })
    child.once('close', (code) => {
      if (settled) return
      settled = true; cleanup()
      if (failure) { rejectWithIo(failure); return }
      try {
        const raw: unknown = JSON.parse(stdout.toString('utf-8'))
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('测试驱动未返回JSON对象')
        // 退出码必须来自OS，不允许子进程报告覆盖。driverIo 随结果透传（P0-2：成功返回
        // 但检查缺失/失败时，stderr 诊断仍需进报告——G3b 固定句盲修场景）。
        resolve({ ...raw, exitCode: code ?? -1, driverIo: driverIo() })
      } catch { rejectWithIo(new Error('测试驱动未返回有效JSON结果，退出码：' + code)) }
    })
    child.stdin.end(JSON.stringify({ schemaVersion: 1, testId: input.test.id, target: input.test.target, covers: input.test.covers, evidenceDigest: input.evidence.digest }))
  })
}

export function createEngineeringProcessDrivers(runtimes: EngineeringProcessRuntime): EngineeringRegisteredDriver[] {
  return (['cli-driver', 'api-driver', 'native-driver', 'mobile-driver'] as const).map((adapter) => ({
    adapter,
    preflight: (input) => {
      if (process.platform === 'win32') return 'Windows测试进程树回收适配尚未接入'
      try { resolveExecutable(input, runtimes); return null } catch (error) { return error instanceof Error ? error.message : String(error) }
    },
    execute: (input) => executeProcess(input, runtimes),
  }))
}
