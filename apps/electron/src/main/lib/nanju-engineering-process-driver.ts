/** 项目测试驱动进程：仅供宿主执行协议调用，不暴露为Agent任意命令工具。 */
import { spawn } from 'node:child_process'
import { accessSync, constants, lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import type { EngineeringExecutionInput, EngineeringRegisteredDriver } from './nanju-engineering-execution'

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
      // 不继承渠道密钥；需要网络/设备的驱动仍须在批准内容中明确说明。
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR,
        DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, PULSE_SERVER: process.env.PULSE_SERVER },
    })
    let stdout = Buffer.alloc(0)
    let total = 0
    let failure: Error | null = null
    let settled = false
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
    }
    child.stdout.on('data', (data: Buffer) => append(data, true))
    child.stderr.on('data', (data: Buffer) => append(data, false))
    child.stdin.on('error', () => { /* 子进程提前退出时由exitCode统一判定 */ })
    child.once('error', (error) => {
      if (settled) return
      settled = true; cleanup(); reject(error)
    })
    child.once('exit', () => { killGroup() })
    child.once('close', (code) => {
      if (settled) return
      settled = true; cleanup()
      if (failure) { reject(failure); return }
      try {
        const raw: unknown = JSON.parse(stdout.toString('utf-8'))
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('测试驱动未返回JSON对象')
        // 退出码必须来自OS，不允许子进程报告覆盖。
        resolve({ ...raw, exitCode: code ?? -1 })
      } catch { reject(new Error('测试驱动未返回有效JSON结果，退出码：' + code)) }
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
