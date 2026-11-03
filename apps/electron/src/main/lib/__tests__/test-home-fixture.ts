/**
 * 测试用 Proma 配置目录隔离夹具（Phase 2 / NEXT-05）。
 *
 * 背景（2026-11-03 实测基线）：
 * - `config-paths.ts` 的配置目录 = `join(homedir(), getConfigDirName())`，即真实 `~/.proma`；
 * - 一批埋点/工作区类测试（nanju-quick-events、nanju-delegation-watch、nanju-delegation-status、
 *   nanju-delivery-view、nanju-telemetry 等）没有隔离 HOME，跑一次全量测试就会在用户真实
 *   `~/.proma/agent-workspaces/<wsId>/workspace-files/` 下建目录、写 `_telemetry/*.jsonl`；
 * - 反过来，凡是想隔离的测试又各自手搓 `mkdtempSync + process.env.HOME + mock.module('node:os')`，
 *   写法不一致且容易漏（漏一处就写脏真实配置）。
 *
 * 本夹具提供统一入口，**只改测试进程内的解析结果，不触碰真实配置目录**：
 * 1. 用 `mkdtempSync` 建独立根目录（默认 `/tmp/proma-test-*`）；
 * 2. `mock.module('node:os')` 把 `homedir()` 指向该根目录 —— 这一步不可省：
 *    Bun 里 `os.homedir()` 的值在进程内已被缓存，单纯改 `process.env.HOME` 无效（实测），
 *    必须 mock 模块才能让 `config-paths.ts` 拿到隔离路径；
 * 3. 固定 `PROMA_DEV=0`，使配置目录名恒为 `.proma`（不因宿主环境漂移到 `.proma-dev`）；
 * 4. 还原时把 mock 指向真实 HOME 并删除临时目录，避免残留 mock 指向已删目录。
 *
 * 用法（推荐，一次安装、每个用例一份干净配置）：
 * ```ts
 * import { useIsolatedPromaConfigDir } from './__tests__/test-home-fixture'
 * const rig = useIsolatedPromaConfigDir() // 模块顶层调用，返回只读视图
 * ```
 *
 * 用法（单用例内临时隔离）：
 * ```ts
 * await withIsolatedPromaConfigDir(async (rig) => {
 *   expect(rig.configDir.startsWith(rig.homeDir)).toBe(true)
 * })
 * ```
 *
 * 注意：`mock.module` 在未开启 `--isolate` 的全仓运行里是进程级共享的，所以本夹具
 * 同时把「还原」实现成「重指向真实 HOME」，即使忘了 restore 也不会把后续文件导向已删目录。
 * 全仓门禁推荐统一使用 `bun test --isolate`（见 NEXT-05 报告）。
 */

import { afterAll, beforeEach, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import * as nodeOs from 'node:os'
import { join } from 'node:path'

/** 隔离后的 Proma 配置目录视图 */
export interface IsolatedPromaConfigDirRig {
  /** 临时根目录（等价于被隔离的 `$HOME`） */
  homeDir: string
  /** 隔离出的配置目录（= `homeDir/.proma`） */
  configDir: string
  /** 判断某个路径是否落在隔离目录内（用于断言没有被写到真实 `~/.proma`） */
  contains(path: string): boolean
  /** 清空配置目录内容（beforeEach 语义：每个用例一份干净配置） */
  reset(): void
  /** 还原 mock 与环境变量，并删除临时目录 */
  restore(): void
}

/** 真实 HOME（夹具加载时捕获，还原时指回去） */
const REAL_HOME = nodeOs.homedir()

/** 当前 mock 生效的 HOME。切换 rig 时改这里，避免反复注册 mock 造成指向漂移。 */
let activeHome = REAL_HOME

/**
 * 注册/刷新 `node:os` mock。
 *
 * 必须**每次安装都重新注册**：`mock.module` 是进程级注册表，最后一次注册生效。
 * 仓库里另有一批文件（如 dingtalk-config.test.ts）也 mock `node:os`，若只注册一次，
 * 后续被它们的 mock 顶掉后本夹具就会静默失准（实测：在非 `--isolate` 全仓运行下
 * 会读到别的文件残留的临时 HOME）。重注册让夹具在任何顺序下都能自证一致。
 */
function installOsMock(): void {
  mock.module('node:os', () => ({
    ...nodeOs,
    // 关键：`homedir()` 每次调用读 activeHome，restore 后自动回到真实 HOME
    homedir: () => activeHome,
  }))
}

/** 创建隔离目录并接管 `homedir()` 解析（同步） */
export function installIsolatedPromaConfigDir(): IsolatedPromaConfigDirRig {
  const homeDir = mkdtempSync(join(nodeOs.tmpdir(), 'proma-test-'))
  const configDir = join(homeDir, '.proma')
  mkdirSync(configDir, { recursive: true })

  const originalHome = process.env.HOME
  const originalPromaDev = process.env.PROMA_DEV

  activeHome = homeDir
  installOsMock()
  // 双保险：仍同步环境变量（新起子进程或未 mock 的分支也能拿到隔离路径）
  process.env.HOME = homeDir
  process.env.PROMA_DEV = '0'

  let restored = false

  return {
    homeDir,
    configDir,
    contains(path: string): boolean {
      return path === homeDir || path.startsWith(`${homeDir}/`)
    },
    reset(): void {
      rmSync(configDir, { recursive: true, force: true })
      mkdirSync(configDir, { recursive: true })
    },
    restore(): void {
      if (restored) return
      restored = true
      // 先把解析指回真实 HOME，再删目录：防止残留 mock 指向已删除路径
      activeHome = REAL_HOME
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      if (originalPromaDev === undefined) {
        delete process.env.PROMA_DEV
      } else {
        process.env.PROMA_DEV = originalPromaDev
      }
      rmSync(homeDir, { recursive: true, force: true })
    },
  }
}

/**
 * 单次包裹：安装隔离 → 执行 fn → 必定还原并清理。
 *
 * 适合在单个 test 内临时把配置目录挪到临时目录（不要跨 test 复用同一 rig）。
 */
export async function withIsolatedPromaConfigDir<T>(
  fn: (rig: IsolatedPromaConfigDirRig) => T | Promise<T>,
): Promise<T> {
  const rig = installIsolatedPromaConfigDir()
  try {
    return await fn(rig)
  } finally {
    rig.restore()
  }
}

/**
 * 按文件安装（推荐）：模块顶层调用一次，
 *
 * - `beforeEach`：清空配置目录，保证用例之间不共享 channels.json / 埋点文件；
 * - `afterAll`：还原 mock、删除临时目录。
 *
 * 必须先于被测模块产生 IO 的时点调用；因为 `homedir()` 只在运行时解析，
 * 即使被测模块是静态 import，在模块顶层调用本函数依然有效（已在夹具自测中锁定）。
 */
export function useIsolatedPromaConfigDir(): IsolatedPromaConfigDirRig {
  const rig = installIsolatedPromaConfigDir()

  beforeEach(() => {
    rig.reset()
  })
  afterAll(() => {
    rig.restore()
  })

  return rig
}

/**
 * 断言辅助：把「路径必须落在隔离目录内」写成显式检查，
 * 防止以后有人把夹具删了却仍以为测试是隔离的。
 */
export function assertInsideRig(rig: IsolatedPromaConfigDirRig, path: string, label: string): void {
  if (!rig.contains(path)) {
    throw new Error(
      `[test-home-fixture] ${label} 未落在隔离目录内：${path}（隔离根 ${rig.homeDir}）。` +
        '说明有代码绕过了 homedir() 隔离，正在读写真实 ~/.proma。',
    )
  }
  if (!existsSync(rig.homeDir)) {
    throw new Error(`[test-home-fixture] 隔离根目录已消失：${rig.homeDir}`)
  }
}
