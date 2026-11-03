/** 宿主解释器探测，不读取项目命令或从项目目录搜索运行时。 */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

interface PythonProbe {
  path: string
  platform: NodeJS.Platform
  executable(path: string): boolean
  version(path: string): Promise<string>
}

export async function findHostPython3(probe: PythonProbe): Promise<string | undefined> {
  // 执行层尚无Windows Job Object；不探测商店别名或启动器，以免触发安装界面。
  if (probe.platform === 'win32') return undefined
  for (const directory of new Set(probe.path.split(':').filter((path) => isAbsolute(path)))) {
    const path = join(directory, 'python3')
    try {
      if (probe.executable(path) && /^Python 3\.\d+\.\d+(?:\s|$)/.test((await probe.version(path)).trim())) return path
    } catch { /* 一个候选不可用时继续，不自动安装或接受未知版本 */ }
  }
  return undefined
}

export function detectEngineeringPython(): Promise<string | undefined> {
  return findHostPython3({
    path: process.env.PATH ?? '', platform: process.platform,
    executable(path) {
      try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
    },
    version(path) {
      return new Promise((resolve, reject) => {
        execFile(path, ['--version'], { timeout: 2000, maxBuffer: 4096, env: { LANG: 'C' } }, (error, stdout) => {
          if (error) reject(error)
          else resolve(stdout)
        })
      })
    },
  })
}
