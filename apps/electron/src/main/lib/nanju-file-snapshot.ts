/**
 * W-D：不可变工程文件快照与可恢复事务引擎
 *
 * 职责边界（P1 计划 W-D 包）：
 * - 对「工程目录」做不可变文件快照：真实 copy（绝不 hardlink）+ 逐文件 sha256 清单；
 * - 排除依赖（node_modules 等）、密钥（.env/*.pem 等）与会话控制文件（_snapshots.json 等）；
 * - 捕获期间源文件发生变更 → 整体拒绝（逐文件前后 stat 比对 + 全量二次遍历比对）；
 * - 恢复 = 把工程目录整体替换回快照内容，恢复前把当前工程完整备份保留；
 * - 排除类文件（密钥/依赖/控制文件）不属于版本语义：跨恢复以「当前值」为准保留；
 * - staging / 事务日志（journal）/ 失败补偿 / 中断可恢复（recover）。
 *
 * 原子性诚实声明（不允许夸大）：
 * - 「rename 旧目录让位 → rename 新目录就位」是两次独立的 POSIX rename，
 *   合起来不是原子事务。两 rename 之间存在真实崩溃窗口（工程目录短暂缺失），
 *   由事务日志 + 下次 recoverInterruptedRestore() 重放/补偿保证最终一致：
 *   要么恢复完成，要么回滚到恢复前状态，不会出现半新半旧的工程目录。
 * - rename2 完成与 journal 写入 restore-moved 之间也有窗口，recover 以「文件系统 +
 *   清单校验」识别已落位（staging 消失、trash 仍在、projectDir 通过清单校验）。
 * - 若 projectDir 与 storageDir 跨文件系统，rename 会退化为非原子 copy+delete；
 *   本模块直接以 cross-device 拒绝恢复，不静默降级。
 * - 单个元数据文件（manifest/journal）一律经 safe-file 原子写（无 fsync，掉电持久性未证明）。
 *
 * 变更检测边界（诚实降级）：
 * - 捕获期变更检测 = 逐文件 copy 后 stat 比对 + 全量二次遍历 + 源文件 sha256 二次比对；
 *   仍不能覆盖「比对后再次突变」的极端竞态，属尽力而为，不是事务级快照。
 *
 * 不恢复项（诚实声明）：
 * - 符号链接与特殊文件（FIFO/socket/设备）一律跳过，写入 manifest.unrecoverable；
 *   恢复结果 notRestored/complete 显式携带，**不得声称恢复完整**。
 * - 备份为「全量含 node_modules/.git」（排除类文件也在内），逐文件 sha256；
 *   无大小预检、无保留数量上限（每次恢复新增一个备份，不自动删除），属有界存储风险。
 *
 * 并发与锁：
 * - 恢复事务持 storageDir/_restore.lock（wx 独占创建，记录 pid + 所有权 token + 进程启动标识）；
 *   活跃锁 → 第二个恢复直接拒绝（locked）；陈旧锁（进程已死/pid 复用/超 TTL）→ 接管并先 recover。
 * - 锁由统一 finally 释放，且仅当 token 匹配才删除，绝不误删他人新锁（见 S1）。
 * - 捕获不加锁：每次捕获使用独立 staging 目录，最终同文件系统原子 rename 落位；
 *   捕获中途失败只清理自己的 staging，互不影响。
 *
 * 安全边界：
 * - 本模块不推断工程目录：projectDir / storageDir 一律由调用方显式传入；
 * - 入口强制 projectDir 与 storageDir 不相交（不相等、互不嵌套，realpath/resolve 规范化），
 *   违者 fail-closed 返回 invalid-layout，且不写入 staging / journal；
 * - 生产约定：storageDir 必须在 projectDir 之外（否则快照会自我包含）；
 * - 清单中的相对路径在恢复前做逃逸校验（拒绝 ..、绝对路径、盘符）；
 * - 符号链接与特殊文件（FIFO/socket/设备）一律跳过不跟随（防逃逸/防环），
 *   并写入清单/结果的「不可恢复列表」，恢复文案不得称完整。
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync,
  statSync, lstatSync, chmodSync, rmSync, realpathSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, dirname, isAbsolute, resolve, sep } from 'node:path'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'

// ===== 排除规则 =====

/** 依赖与 VCS 目录：任一路径段命中即整棵剪枝 */
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.gradle',
  '.git', // 版本库内部状态不属于文件恢复语义，恢复旧 .git 会破坏仓库一致性
  '.proma', // Proma 受管标记目录（防御）
])

/**
 * Proma 会话/工程控制文件：属于运行状态，不随版本回滚，跨恢复以当前值保留。
 * 核全：项目目录（getNanjuProjectDir）+ 工作区根下会出现的 Proma 状态文件。
 */
const CONTROL_FILE_NAMES: ReadonlySet<string> = new Set([
  '_snapshots.json',            // nanju-snapshot.ts（会话快照索引）
  '_nanju-clarify-log.jsonl',   // nanju-clarify-proxy-tool.ts（代答溯源/熔断计数）
  '_project-info.json',         // nanju-project.ts（阶段/子阶段/phaseGuard 状态）
  '_repair-log.json',           // nanju-repair-loop.ts（三次修复预算）
  '_regression-audit.jsonl',    // nanju-regression.ts（回归审计日志）
  '_nanju-projects.json',       // nanju-project.ts（工作区工程索引）
  '_restore-journal.json',      // 本模块事务日志
  '_restore.lock',              // 本模块恢复锁
])

/** safe-file 原子读写产生的旁路后缀：控制文件的这些变体同样不得进入版本语义 */
const CONTROL_STATE_SUFFIXES: readonly string[] = ['.bak', '.tmp']

/** 目录名是否被排除 */
export function isExcludedDirName(name: string): boolean {
  return EXCLUDED_DIR_NAMES.has(name)
}

/** 是否为 Proma 控制文件（含 .bak/.tmp 原子写旁路后缀变体） */
export function isControlFileName(name: string): boolean {
  if (CONTROL_FILE_NAMES.has(name)) return true
  for (const suffix of CONTROL_STATE_SUFFIXES) {
    if (name.endsWith(suffix) && CONTROL_FILE_NAMES.has(name.slice(0, -suffix.length))) return true
  }
  return false
}

/** 文件名是否被排除（密钥或 Proma 控制文件） */
export function isExcludedFileName(name: string): boolean {
  return isControlFileName(name) || isSecretFileName(name)
}

/** 密钥类后缀 */
const SECRET_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.secret']

/** .env 模板例外：这些是文档不是密钥，随版本走 */
const ENV_TEMPLATE_NAMES: ReadonlySet<string> = new Set(['.env.example', '.env.template', '.env.sample'])

function isSecretFileName(name: string): boolean {
  if (name === '.env') return true
  if (name.startsWith('.env.') && !ENV_TEMPLATE_NAMES.has(name)) return true
  if (name === 'id_rsa' || name.startsWith('id_rsa.')) return true
  if (name === 'id_ed25519' || name.startsWith('id_ed25519.')) return true
  if (name === 'credentials.json' || name.startsWith('service-account')) return true
  const lower = name.toLowerCase()
  return SECRET_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

// ===== 类型 =====

export interface FileSnapshotManifestEntry {
  /** POSIX 风格相对路径（已做逃逸校验） */
  path: string
  sha256: string
  size: number
  mode: number
}

export interface FileSnapshotManifest {
  version: 1
  snapshotId: string
  createdAt: string
  algorithm: 'sha256-v1'
  entries: FileSnapshotManifestEntry[]
  /** 快照内的目录（含空目录），POSIX 相对路径 */
  dirs: string[]
  fileCount: number
  totalBytes: number
  /** entries 按 path:sha256 排序串联后的总哈希，用于快速完整性断言 */
  contentHash: string
  excludedCount: number
  symlinksSkipped: number
  /**
   * 未纳入快照且恢复后无法复原的条目（符号链接/特殊文件）。
   * 它们不属于「快照内容」，恢复后不会出现；调用方据此不得声称恢复完整。
   */
  unrecoverable: UnrecoverableEntry[]
}

/** 不可恢复条目：被跳过且不会在恢复后重建的文件系统对象 */
export interface UnrecoverableEntry {
  /** POSIX 相对路径 */
  path: string
  kind: 'symlink' | 'special-file'
}

export interface CaptureProgressInfo {
  file: string
  index: number
  total: number
}

export interface CaptureOptions {
  /** 进度回调；W-D 测试亦用它注入「捕获中变更」 */
  onProgress?: (info: CaptureProgressInfo) => void
}

export interface CaptureSuccess {
  ok: true
  manifest: FileSnapshotManifest
  /** 快照目录：storageDir/snapshots/<snapshotId> */
  snapshotDir: string
}

export interface CaptureFailure {
  ok: false
  reason: 'source-dir-missing' | 'changed-during-capture' | 'io-error' | 'invalid-layout'
  message: string
  /** reason=changed-during-capture 时列出的变更文件 */
  changedPaths?: string[]
}

export type CaptureResult = CaptureSuccess | CaptureFailure

/** 恢复事务故障注入点——仅供测试模拟进程中断/校验失败，生产代码不得传 */
export type RestoreFaultPoint =
  | 'after-verify'
  | 'after-backup'
  | 'after-current-moved'
  /** rename2 完成但 journal 尚未更新为 restore-moved 的窗口（模拟掉电） */
  | 'after-restore-rename-before-journal'
  | 'after-restore-moved'
  /** 强制让「恢复落位后的完整性校验」失败，用于验证失败补偿路径 */
  | 'force-restore-verify-fail'

export interface RestoreOptions {
  injectFault?: (point: RestoreFaultPoint) => void
}

/** 测试专用崩溃信号：从故障注入抛出时直接向上传播，不触发补偿（等价进程死亡） */
export class TestCrashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TestCrashError'
  }
}

export interface RestoreSuccess {
  ok: true
  txnId: string
  restoredFiles: number
  /** 恢复前当前工程的保留位置（不自动删除） */
  preRestoreBackupDir: string
  /** 备份大小（字节），供调用方做空间/保留策略判定；备份保留策略见模块头 S10 声明 */
  backupSizeBytes: number
  /** 跨恢复以当前值保留的排除类文件（相对路径） */
  carriedOverExcluded: string[]
  /** 快照中声明但未能恢复的条目（符号链接/特殊文件）；非空时恢复不完整 */
  notRestored: string[]
  /** true = 快照中所有条目均已恢复；false = 存在 notRestored 不可恢复项 */
  complete: boolean
}

export interface RestoreFailure {
  ok: false
  reason:
    | 'snapshot-missing' | 'manifest-invalid' | 'hash-mismatch' | 'unsafe-path'
    | 'locked' | 'project-dir-missing' | 'io-error' | 'restore-verify-failed'
    | 'invalid-layout' | 'cross-device'
  message: string
  /** true 表示已成功回滚到恢复前状态 */
  compensated: boolean
}

export type RestoreResult = RestoreSuccess | RestoreFailure

export type RecoverAction =
  | 'nothing-to-recover'
  | 'completed-restore'
  | 'aborted-clean'
  | 'compensated'
  | 'invalid-layout'

export interface RecoverResult {
  ok: boolean
  action: RecoverAction
  message: string
}

// ===== 存储布局 =====
// storageDir/
//   snapshots/<snapshotId>/{manifest.json, files/...}
//   _staging/capture-<id>/{manifest.json, files/...}   ← 捕获暂存，落位时整体 rename 为 snapshots/<id>
//   _staging/restore-<txnId>/<path...>                ← 恢复暂存，落位时整体 rename 为 projectDir
//   _pre-restore-backups/<txnId>/{manifest.json, files/...}
//   _trash/<txnId>[-failed]
//   _restore-journal.json
//   _restore.lock
//
// 「文件根」约定（统一 copy/verify 语义，勿混）：
//   清单里的 path 一律相对「某个文件根」，且文件根本身不被写进 path：
//   - 快照：文件根 = snapshotDir/files（manifest.json 在 snapshotDir 根，不在文件根内）
//   - 备份：文件根 = backupDir/files（与快照同构，便于同一套 hash 语义消费）
//   - 恢复暂存：文件根 = stagingDir 本身；因 stagingDir 会整体 rename 成 projectDir，
//     所以落位后的文件根就是 projectDir。恢复校验与 trunc 恢复均以 projectDir 为文件根。
//   verifyTreeAgainstManifest(treeRoot, manifest) 中 treeRoot 一律传「文件根」，
//   不要传 snapshotDir / storageDir 等包装层。

/**
 * 规范化路径：存在的路径用 realpath（解符号链接），不存在的路径用 resolve（解 .. / 相对段）。
 * 使「目录尚未创建」时也能做布局判断。
 */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** child 等于 parent 或位于 parent 之下 */
function isNestedPath(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

type LayoutVerdict = { ok: true } | { ok: false; message: string }

/**
 * 入口布局守卫（fail-closed）：projectDir 与 storageDir 规范化后必须不相等、互不嵌套。
 * 生产约定：storageDir 在 projectDir 之外；否则快照会把自身 staging/快照包含进工程，
 * 导致捕获永远误报 changed-during-capture、恢复自我替换与孤儿备份。
 */
function verifyDirectoryLayout(projectDir: string, storageDir: string): LayoutVerdict {
  const project = canonicalPath(projectDir)
  const storage = canonicalPath(storageDir)
  if (project === storage) {
    return { ok: false, message: `projectDir 与 storageDir 相同，拒绝恢复/捕获（会自我包含）: ${project}` }
  }
  if (isNestedPath(storage, project)) {
    return { ok: false, message: `storageDir 位于 projectDir 内，拒绝（快照会自我包含）: storage=${storage} project=${project}` }
  }
  if (isNestedPath(project, storage)) {
    return { ok: false, message: `projectDir 位于 storageDir 内，拒绝（恢复会替换自身父目录）: project=${project} storage=${storage}` }
  }
  return { ok: true }
}

/** 沿路径向上找最近存在祖先的 st_dev（用于创建前判断跨文件系统） */
function nearestExistingDevice(p: string): number | null {
  let cur = resolve(p)
  for (;;) {
    try {
      return statSync(cur).dev
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return null
      cur = parent
    }
  }
}

function ensureStorageLayout(storageDir: string): void {
  mkdirSync(storageDir, { recursive: true })
  mkdirSync(join(storageDir, 'snapshots'), { recursive: true })
  mkdirSync(join(storageDir, '_staging'), { recursive: true })
  mkdirSync(join(storageDir, '_pre-restore-backups'), { recursive: true })
  mkdirSync(join(storageDir, '_trash'), { recursive: true })
}

function snapshotsRoot(storageDir: string): string {
  return join(storageDir, 'snapshots')
}

// ===== 内部工具 =====

interface WalkFileEntry {
  rel: string
  abs: string
  size: number
  mtimeMs: number
  mode: number
}

type WalkSelection = 'included' | 'excluded' | 'all'

interface WalkOutcome {
  files: WalkFileEntry[]
  dirs: string[]
  excludedCount: number
  symlinksSkipped: number
  /** 被跳过且恢复后无法复原的条目（symlink / 特殊文件） */
  unrecoverable: UnrecoverableEntry[]
}

/** 相对路径统一为 POSIX 风格（清单与跨平台语义） */
function toPosixRel(rel: string): string {
  return rel.split('\\').join('/')
}

function isSafeRelPath(rel: string): boolean {
  if (rel.length === 0) return false
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false
  const parts = rel.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * 遍历目录树。
 * - selection=included：收集未被排除的文件（快照版本内容）
 * - selection=excluded：只收集被排除的文件（恢复时 carry-over 当前值）；
 *   被排除目录下的所有内容（如 node_modules/**、.git/**）都以「目录整体被排除」计，全部收集
 * - selection=all：收集全部文件（恢复前安全备份，含被排除目录）
 * 目录名命中排除规则时按 selection 决定是否下钻；符号链接一律跳过不跟随。
 */
function walkTree(rootDir: string, selection: WalkSelection): WalkOutcome {
  const out: WalkOutcome = { files: [], dirs: [], excludedCount: 0, symlinksSkipped: 0, unrecoverable: [] }

  const visit = (absDir: string, relDir: string, insideExcluded: boolean): void => {
    const names = readdirSync(absDir).sort()
    for (const name of names) {
      const abs = join(absDir, name)
      const rel = relDir === '' ? name : `${relDir}/${name}`
      let stat
      try {
        stat = lstatSync(abs)
      } catch {
        continue // 竞态消失的条目直接跳过
      }
      if (stat.isSymbolicLink()) {
        out.symlinksSkipped += 1
        if (selection !== 'excluded') out.unrecoverable.push({ path: toPosixRel(rel), kind: 'symlink' })
        continue
      }
      if (stat.isDirectory()) {
        if (isExcludedDirName(name)) {
          // selection=excluded：深入被排除目录收集 carry-over 目标
          // selection=all：备份需要「当前工程全量」，包括依赖/密钥等排除目录内容
          // selection=included：剪枝不入快照
          if (selection === 'excluded' || selection === 'all') visit(abs, rel, true)
          else out.excludedCount += 1
          continue
        }
        out.dirs.push(toPosixRel(rel))
        visit(abs, rel, insideExcluded)
        continue
      }
      if (!stat.isFile()) {
        // FIFO / socket / 设备节点等特殊文件：不版本化且恢复后无法复原
        if (selection !== 'excluded') out.unrecoverable.push({ path: toPosixRel(rel), kind: 'special-file' })
        continue
      }

      // 文件被排除 = 自身命中排除规则，或位于被排除目录之内（整体排除）
      const excluded = insideExcluded || isExcludedFileName(name)
      if (selection === 'included' && excluded) {
        out.excludedCount += 1
        continue
      }
      const wanted = selection === 'all' || (selection === 'excluded' ? excluded : true)
      if (!wanted) continue
      out.files.push({ rel: toPosixRel(rel), abs, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 })
    }
  }

  visit(rootDir, '', false)
  out.files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  out.dirs.sort()
  return out
}

function hashFile(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

function computeContentHash(entries: FileSnapshotManifestEntry[]): string {
  return createHash('sha256')
    .update(entries.map((e) => `${e.path}:${e.sha256}`).sort().join('\n'))
    .digest('hex')
}

function removeDirIfEmpty(dir: string): void {
  try {
    // 注意：不能裸 rmSync(dir) —— 在本仓 Bun 运行时对目录会抛 EFAULT（且非可重试错误），
    // 必须显式 recursive+force 才能删除空目录，否则残留 _staging/_trash 会让幂等清理失效。
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch { /* 尽力而为 */ }
}

// ===== 捕获 =====

/**
 * 捕获不可变文件快照。
 * 双重变更检测：逐文件 copy 后 stat 与捕获前比对 + 全量二次遍历比对文件集合与 stat；
 * 任一不一致 → 整体拒绝并清理 staging，不产生可用快照。
 */
export function captureFileSnapshot(projectDir: string, storageDir: string, options?: CaptureOptions): CaptureResult {
  const layout = verifyDirectoryLayout(projectDir, storageDir)
  if (!layout.ok) {
    return { ok: false, reason: 'invalid-layout', message: layout.message }
  }
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return { ok: false, reason: 'source-dir-missing', message: `工程目录不存在或不是目录: ${projectDir}` }
  }

  let pre: WalkOutcome
  try {
    ensureStorageLayout(storageDir)
    pre = walkTree(projectDir, 'included')
  } catch (error) {
    return { ok: false, reason: 'io-error', message: `扫描工程目录失败: ${String(error)}` }
  }

  const snapshotId = randomUUID()
  const stagingDir = join(storageDir, '_staging', `capture-${snapshotId}`)
  const filesRoot = join(stagingDir, 'files')
  try {
    mkdirSync(filesRoot, { recursive: true })

    // 阶段一：真实 copy（copyFileSync 拷贝字节，绝不 hardlink）+ 逐文件前后 stat 比对
    const entries: FileSnapshotManifestEntry[] = []
    let totalBytes = 0
    for (let i = 0; i < pre.files.length; i++) {
      const file = pre.files[i]
      if (!file) continue
      const dest = join(filesRoot, ...file.rel.split('/'))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file.abs, dest)
      const sha256 = hashFile(dest)
      chmodSync(dest, file.mode)

      const post = statSync(file.abs)
      if (post.size !== file.size || post.mtimeMs !== file.mtimeMs) {
        rmSyncWithRetry(stagingDir, { recursive: true, force: true })
        return {
          ok: false,
          reason: 'changed-during-capture',
          message: `捕获期间检测到源文件变更，已拒绝生成快照: ${file.rel}`,
          changedPaths: [file.rel],
        }
      }
      // S7 封口：stat 级检测存在「同 size 同 mtime」盲区，追加一次源文件 sha256 二次比对。
      // （代价：源文件被再读一遍；此处宁可慢些也要避免非一致点快照。）
      const sourceSha = hashFile(file.abs)
      if (sourceSha !== sha256) {
        rmSyncWithRetry(stagingDir, { recursive: true, force: true })
        return {
          ok: false,
          reason: 'changed-during-capture',
          message: `捕获期间源文件内容发生变化（sha256 不一致），已拒绝生成快照: ${file.rel}`,
          changedPaths: [file.rel],
        }
      }
      entries.push({ path: file.rel, sha256, size: file.size, mode: file.mode })
      totalBytes += file.size
      options?.onProgress?.({ file: file.rel, index: i + 1, total: pre.files.length })
    }

    // 阶段二：全量二次遍历，比对文件集合/目录集合与每个文件的 size/mtime；
    // S7 封口：对 stat 未变的文件再做一次源文件 sha256 与清单比对，屏蔽「同 size 同 mtime 改写」盲区。
    const post = walkTree(projectDir, 'included')
    const changed: string[] = []
    const preFiles = new Map(pre.files.map((f) => [f.rel, f]))
    const postFiles = new Map(post.files.map((f) => [f.rel, f]))
    const entryShaByRel = new Map(entries.map((e) => [e.path, e.sha256]))
    for (const [rel, before] of preFiles) {
      const after = postFiles.get(rel)
      if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        changed.push(rel)
        continue
      }
      const expected = entryShaByRel.get(rel)
      if (expected !== undefined && hashFile(before.abs) !== expected) changed.push(rel)
    }
    for (const rel of postFiles.keys()) {
      if (!preFiles.has(rel)) changed.push(rel)
    }
    const preDirs = new Set(pre.dirs)
    for (const dir of post.dirs) {
      if (!preDirs.has(dir)) changed.push(`${dir}/`)
    }
    if (changed.length > 0) {
      rmSyncWithRetry(stagingDir, { recursive: true, force: true })
      return {
        ok: false,
        reason: 'changed-during-capture',
        message: `捕获期间检测到工程目录变化，已拒绝生成快照（${changed.length} 处）`,
        changedPaths: changed,
      }
    }

    const manifest: FileSnapshotManifest = {
      version: 1,
      snapshotId,
      createdAt: new Date().toISOString(),
      algorithm: 'sha256-v1',
      entries,
      dirs: post.dirs,
      fileCount: entries.length,
      totalBytes,
      contentHash: computeContentHash(entries),
      excludedCount: post.excludedCount,
      symlinksSkipped: post.symlinksSkipped,
      unrecoverable: post.unrecoverable,
    }
    writeJsonFileAtomic(join(stagingDir, 'manifest.json'), manifest)

    // 落位：staging → snapshots/<id>（同文件系统 rename，原子）
    const snapshotDir = join(snapshotsRoot(storageDir), snapshotId)
    renameWithRetry(stagingDir, snapshotDir)
    return { ok: true, manifest, snapshotDir }
  } catch (error) {
    try { rmSyncWithRetry(stagingDir, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    return { ok: false, reason: 'io-error', message: `捕获快照失败: ${String(error)}` }
  }
}

// ===== 事务日志 =====

type RestoreJournalPhase =
  | 'started' | 'verified' | 'backup-done' | 'swap-intent' | 'current-moved'
  | 'restore-moved' | 'restore-verified' | 'compensated' | 'committed' | 'aborted-clean'

interface RestoreJournal {
  txnId: string
  snapshotDir: string
  projectDir: string
  stagingDir: string
  backupDir: string
  trashDir: string
  phase: RestoreJournalPhase
  updatedAt: string
  message?: string
}

function journalPath(storageDir: string): string {
  return join(storageDir, '_restore-journal.json')
}

function readJournal(storageDir: string): RestoreJournal | null {
  return readJsonFileSafe<RestoreJournal>(journalPath(storageDir))
}

function writeJournal(storageDir: string, journal: RestoreJournal): void {
  journal.updatedAt = new Date().toISOString()
  writeJsonFileAtomic(journalPath(storageDir), journal)
}

// ===== 锁 =====

interface LockContent {
  pid: number
  startedAt: string
  /** 锁所有权不透明标识；释放时校验，避免删除他人新锁 */
  token: string
  /** 持锁进程启动标识（Linux /proc/<pid>/stat starttime）；缺失时降级 kill(pid,0) */
  procStart?: string
}

/** 锁最长存活时间：超过视为陈旧（防 pid 复用/僵尸进程永久占锁） */
const RESTORE_LOCK_TTL_MS = 10 * 60 * 1000

function lockPath(storageDir: string): string {
  return join(storageDir, '_restore.lock')
}

/** 读取进程启动标识（Linux）；非 Linux 或不可读返回 null */
function readProcStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(' ')
    // fields[0] = state(field3)... starttime 为第 22 字段 → index 19
    return fields[19] ?? null
  } catch {
    return null
  }
}

/** 进程是否仍存活；有 procStart 时优先用它识别 pid 复用 */
function isPidAlive(pid: number, procStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (procStart) {
    const current = readProcStart(pid)
    if (current !== null) return current === procStart
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM' // 无权发信号但进程仍存在
  }
}

/** 锁是否已陈旧（无法证明持有者仍活着，或已超过 TTL） */
function isLockStale(existing: LockContent | null, now: number): boolean {
  if (!existing || !Number.isInteger(existing.pid)) return true
  if (!isPidAlive(existing.pid, existing.procStart)) return true
  const started = Date.parse(existing.startedAt ?? '')
  if (Number.isFinite(started) && now - started > RESTORE_LOCK_TTL_MS) return true
  return false
}

type LockAcquire = { kind: 'ok'; token: string } | { kind: 'locked' } | { kind: 'stale' }

/**
 * 尝试获取恢复锁。
 * 'ok' 已获得（返回所有权 token）；'locked' 活跃锁拒绝；'stale' 陈旧锁（调用方接管前先 recover）。
 */
function acquireRestoreLock(storageDir: string): LockAcquire {
  mkdirSync(storageDir, { recursive: true })
  const lock = lockPath(storageDir)
  const token = randomUUID()
  const procStart = readProcStart(process.pid)
  try {
    const content: LockContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      token,
      ...(procStart ? { procStart } : {}),
    }
    writeFileSync(lock, JSON.stringify(content), { flag: 'wx' })
    return { kind: 'ok', token }
  } catch {
    return isLockStale(readJsonFileSafe<LockContent>(lock), Date.now())
      ? { kind: 'stale' }
      : { kind: 'locked' }
  }
}

/** 仅当锁文件仍属于自己持有的 token 时才删除，绝不误删他人新锁（锁是文件，非目录） */
function releaseRestoreLock(storageDir: string, token: string): void {
  const lock = lockPath(storageDir)
  try {
    const existing = readJsonFileSafe<LockContent>(lock)
    if (!existing || existing.token !== token) return
    rmSync(lock, { force: true })
  } catch { /* 尽力而为 */ }
}

// ===== 快照校验 =====

type SnapshotVerdict =
  | { ok: true; manifest: FileSnapshotManifest }
  | { ok: false; reason: 'snapshot-missing' | 'manifest-invalid' | 'unsafe-path' | 'hash-mismatch'; message: string; paths?: string[] }

/** 校验快照完整性：清单存在且可读、路径安全、逐文件 hash/size 一致 */
function verifySnapshotDir(snapshotDir: string): SnapshotVerdict {
  const manifestFile = join(snapshotDir, 'manifest.json')
  if (!existsSync(snapshotDir) || !existsSync(manifestFile)) {
    return { ok: false, reason: 'snapshot-missing', message: `快照不存在或缺少清单: ${snapshotDir}` }
  }
  const manifest = readJsonFileSafe<FileSnapshotManifest>(manifestFile)
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries) || manifest.algorithm !== 'sha256-v1') {
    return { ok: false, reason: 'manifest-invalid', message: '快照清单缺失、损坏或版本不识别' }
  }
  // 快照清单中的 path 是「相对文件根」的路径，而快照里的文件根是 snapshotDir/files/，
  // manifest.json 位于 snapshotDir 根，不在文件根内。故校验快照时必须以 snapshotDir/files 为根，
  // 否则会把 src/x.ts 误判为 snapshotDir/src/x.ts（不存在）→ 全部 hash-mismatch。
  return verifyTreeAgainstManifest(join(snapshotDir, 'files'), manifest)
}

/**
 * 以给定「文件根」为根，按清单逐文件校验（快照校验与恢复落位校验共用）。
 *
 * treeRoot 一律是清单 path 的基准目录（文件根），不是 storageDir / snapshotDir 包装层：
 * - 校验快照：treeRoot = snapshotDir/files（snapshotDir = snapshots/<id>/{manifest.json,files/}）
 * - 校验恢复落位：treeRoot = projectDir（staging 的「文件根」被 rename 成 projectDir，见 restore 注释）
 * 两种情形下清单 path 均直接拼接在 treeRoot 之后，语义统一。
 */
function verifyTreeAgainstManifest(treeRoot: string, manifest: FileSnapshotManifest): SnapshotVerdict {
  const mismatched: string[] = []
  for (const entry of manifest.entries) {
    if (!isSafeRelPath(entry.path)) {
      return { ok: false, reason: 'unsafe-path', message: `清单含不安全相对路径，已拒绝: ${entry.path}` }
    }
    // treeRoot 已是文件根：快照校验传 snapshotDir/files，落位校验传 projectDir；
    // 两者都直接用 treeRoot + 清单 path，不再额外拼接 files/ 层。
    const abs = join(treeRoot, ...entry.path.split('/'))
    if (!existsSync(abs)) {
      mismatched.push(entry.path)
      continue
    }
    if (hashFile(abs) !== entry.sha256 || statSync(abs).size !== entry.size) mismatched.push(entry.path)
  }
  if (mismatched.length > 0) {
    return { ok: false, reason: 'hash-mismatch', message: `文件校验失败（${mismatched.length} 个不符），可能已损坏或被篡改`, paths: mismatched }
  }
  // S11：contentHash 不能是死字段。清单若被篡改（改 entries 而未同步 contentHash）在此封口。
  if (typeof manifest.contentHash === 'string' && manifest.contentHash.length > 0
    && computeContentHash(manifest.entries) !== manifest.contentHash) {
    return { ok: false, reason: 'hash-mismatch', message: '清单 contentHash 与 entries 不一致，清单可能被篡改', paths: [] }
  }
  return { ok: true, manifest }
}

/**
 * 导出的快照校验入口（供 nanju-snapshot 关联文件快照前验证存在性/完整性）。
 * 文件根 = snapshotDir/files；同时校验逐文件 hash 与清单 contentHash。
 */
export function verifyFileSnapshotDir(snapshotDir: string): SnapshotVerdict {
  return verifySnapshotDir(snapshotDir)
}

// ===== 恢复 =====

function copyTree(files: WalkFileEntry[], dirs: string[], destRoot: string): void {
  for (const dir of dirs) {
    mkdirSync(join(destRoot, ...dir.split('/')), { recursive: true })
  }
  for (const file of files) {
    const dest = join(destRoot, ...file.rel.split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(file.abs, dest)
    chmodSync(dest, file.mode)
  }
}

function manifestToWalkEntries(snapshotDir: string, manifest: FileSnapshotManifest): WalkFileEntry[] {
  return manifest.entries.map((entry) => ({
    rel: entry.path,
    abs: join(snapshotDir, 'files', ...entry.path.split('/')),
    size: entry.size,
    mtimeMs: 0, // 恢复不依赖源 mtime
    mode: entry.mode,
  }))
}

/** 测试故障注入执行；TestCrashError 直接上抛（模拟进程死亡），其余异常也上抛走正常错误路径 */
function throwFault(options: RestoreOptions | undefined, point: RestoreFaultPoint): void {
  options?.injectFault?.(point)
}

/**
 * 恢复工程目录到快照内容。
 *
 * 事务流程（每步落 journal，见文件头「原子性诚实声明」）：
 * verify → backup 当前工程（全量含排除项）→ 组装 staging（快照内容 + 排除类文件 carry-over）
 * → rename projectDir→trash → rename staging→projectDir → 校验落位结果
 * → 成功：清理 trash（备份保留）→ committed；
 *   失败：补偿（trash→projectDir 回滚，staging 清理）→ compensated。
 */
export function restoreFileSnapshot(snapshotDir: string, projectDir: string, storageDir: string, options?: RestoreOptions): RestoreResult {
  // S3：布局守卫必须在创建任何内容之前 fail-closed（不写 staging/journal）
  const layout = verifyDirectoryLayout(projectDir, storageDir)
  if (!layout.ok) {
    return { ok: false, reason: 'invalid-layout', message: layout.message, compensated: false }
  }
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    return { ok: false, reason: 'project-dir-missing', message: `工程目录不存在，拒绝恢复: ${projectDir}`, compensated: false }
  }
  // S9：cross-device 明确 blocked。projectDir→trash 的 rename 若跨文件系统，会退化为非原子
  // copy+delete（fs-retry EXDEV 路径），崩溃窗口远大于「两次 rename」，故直接拒绝而非静默降级。
  const projectDev = statSync(projectDir).dev
  const storageDev = nearestExistingDevice(storageDir)
  if (storageDev !== null && storageDev !== projectDev) {
    return {
      ok: false,
      reason: 'cross-device',
      message: `projectDir 与 storageDir 不在同一文件系统（dev ${projectDev} vs ${storageDev}），跨 fs rename 非原子，拒绝恢复`,
      compensated: false,
    }
  }

  const txnId = randomUUID()
  ensureStorageLayout(storageDir)

  // S1：锁在整个事务期间持有，由统一 finally 释放（只释放自己持有的 token，不误删他人新锁）
  let ownedToken: string | null = null
  const acquired = acquireRestoreLock(storageDir)
  if (acquired.kind === 'locked') {
    return { ok: false, reason: 'locked', message: '已有恢复事务进行中（锁活跃），请稍后重试或先执行中断恢复', compensated: false }
  }
  if (acquired.kind === 'stale') {
    // 陈旧锁接管：隔离旧锁后重新独占获取；拿不到（并发抢锁）则退回 locked
    try { rmSync(lockPath(storageDir), { force: true }) } catch { /* 尽力而为 */ }
    const retry = acquireRestoreLock(storageDir)
    if (retry.kind !== 'ok') {
      return { ok: false, reason: 'locked', message: '陈旧锁接管时被并发恢复抢占，请重试', compensated: false }
    }
    ownedToken = retry.token
    recoverInterruptedRestore(projectDir, storageDir)
  } else {
    ownedToken = acquired.token
  }

  const stagingDir = join(storageDir, '_staging', `restore-${txnId}`)
  const backupDir = join(storageDir, '_pre-restore-backups', txnId)
  const trashDir = join(storageDir, '_trash', txnId)
  const journal: RestoreJournal = {
    txnId, snapshotDir, projectDir, stagingDir, backupDir, trashDir,
    phase: 'started', updatedAt: new Date().toISOString(),
  }

  // 锁释放统一由 finally 完成；各失败出口不得自行释放，也不得释放非自己持有的锁。
  const fail = (reason: RestoreFailure['reason'], message: string, compensated: boolean): RestoreFailure => {
    return { ok: false, reason, message, compensated }
  }

  /** 补偿：把 trash（恢复前工程）搬回 projectDir，清理 staging 与失败残留 */
  const compensate = (detail: string): RestoreFailure => {
    try {
      if (existsSync(stagingDir)) rmSyncWithRetry(stagingDir, { recursive: true, force: true })
      if (!existsSync(projectDir) && existsSync(trashDir)) {
        renameWithRetry(trashDir, projectDir)
      } else if (existsSync(trashDir)) {
        // projectDir 已是失败的恢复内容：移走后回滚
        const failedDir = `${trashDir}-failed`
        renameWithRetry(projectDir, failedDir)
        renameWithRetry(trashDir, projectDir)
        rmSyncWithRetry(failedDir, { recursive: true, force: true })
      }
      removeDirIfEmpty(join(storageDir, '_trash'))
      journal.phase = 'compensated'
      journal.message = detail
      writeJournal(storageDir, journal)
      return { ok: false, reason: 'restore-verify-failed', message: `恢复失败已补偿，工程保持恢复前状态: ${detail}`, compensated: true }
    } catch (error) {
      // 补偿本身失败：保留 journal 与现场供下次 recover，绝不虚报成功
      journal.message = `补偿失败: ${String(error)}`
      writeJournal(storageDir, journal)
      return { ok: false, reason: 'io-error', message: `恢复失败且自动补偿未完成，已写入事务日志，请执行 recoverInterruptedRestore(): ${String(error)}`, compensated: false }
    }
  }

  try {
    const verdict = verifySnapshotDir(snapshotDir)
    if (!verdict.ok) {
      return fail(verdict.reason, verdict.message, false)
    }
    const manifest = verdict.manifest
    journal.phase = 'verified'
    writeJournal(storageDir, journal)
    throwFault(options, 'after-verify')

    // 2. 备份当前工程（全量含排除项——这是安全网，不是版本）
    //
    // 备份目录与快照目录同构：backupDir/{manifest.json,files/<path>}。
    // 统一「文件根就是 files/」的约定，使备份可直接作为恢复前证据被同一套 hash 语义消费。
    const current = walkTree(projectDir, 'all')
    const backupFilesRoot = join(backupDir, 'files')
    const backupSizeBytes = current.files.reduce((sum, f) => sum + f.size, 0)
    mkdirSync(backupFilesRoot, { recursive: true })
    copyTree(current.files, current.dirs, backupFilesRoot)
    writeJsonFileAtomic(join(backupDir, 'manifest.json'), {
      version: 1 as const,
      kind: 'pre-restore-backup' as const,
      txnId,
      createdAt: new Date().toISOString(),
      sourceProjectDir: projectDir,
      entries: current.files.map((f) => ({ path: f.rel, sha256: hashFile(f.abs), size: f.size, mode: f.mode })),
    })
    journal.phase = 'backup-done'
    writeJournal(storageDir, journal)
    throwFault(options, 'after-backup')

    // 3. 组装新工程：快照内容（已校验）+ 排除类文件从备份 carry-over（以当前值为准）
    //
    // 目录结构约定（全模块统一）：
    // - snapshotDir = snapshots/<id>/，清单在 snapshotDir/manifest.json，文件根为 snapshotDir/files/<path>
    // - backupDir   = _pre-restore-backups/<txnId>/，清单在 backupDir/manifest.json，文件根为 backupDir/files/<path>
    // - stagingDir  = _staging/restore-<txnId>/，文件根就是 stagingDir 本身（不含额外 files/ 层）
    //   因为 restore 把 stagingDir 整体 rename 为 projectDir，故落位后文件根 = projectDir。
    //   若在 stagingDir 内再套一层 files/，rename 后会多出 projectDir/files/，与快照文件根约定冲突。
    //
    // manifestToWalkEntries 的 abs 指向 snapshotDir/files/<path>（快照文件根），是 copyTree 的正确源。
    // carry-over 从 backupDir/files（备份文件根）读取，保证排除类文件以恢复前的当前值为准。
    mkdirSync(stagingDir, { recursive: true })
    const restoredRoot = stagingDir // 文件根即 stagingDir：rename 后成为 projectDir
    copyTree(manifestToWalkEntries(snapshotDir, manifest), manifest.dirs, restoredRoot)

    const carriedOver: string[] = []
    if (existsSync(backupFilesRoot)) {
      const excludedNow = walkTree(backupFilesRoot, 'excluded')
      for (const file of excludedNow.files) {
        const dest = join(restoredRoot, ...file.rel.split('/'))
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(file.abs, dest)
        chmodSync(dest, file.mode)
        carriedOver.push(file.rel)
      }
    }

    // 4. swap：两次独立 rename，中间窗口由 journal + recover 兜底（不是原子事务）
    journal.phase = 'swap-intent'
    writeJournal(storageDir, journal)
    renameWithRetry(projectDir, trashDir)
    journal.phase = 'current-moved'
    writeJournal(storageDir, journal)
    throwFault(options, 'after-current-moved')

    renameWithRetry(stagingDir, projectDir)
    // S6：rename2 已完成、journal 尚未写入 restore-moved 的窗口。recover 靠文件系统+manifest 识别。
    throwFault(options, 'after-restore-rename-before-journal')
    journal.phase = 'restore-moved'
    writeJournal(storageDir, journal)
    throwFault(options, 'after-restore-moved')

    // 5. 校验落位结果（逐文件 hash 与快照清单一致）
    let verifyFailed: string | null = null
    if (options?.injectFault) {
      let forced = false
      try {
        options.injectFault('force-restore-verify-fail')
      } catch (error) {
        if (error instanceof TestCrashError) throw error
        forced = true
      }
      if (forced) verifyFailed = '注入的校验失败（测试）'
    }
    if (verifyFailed === null) {
      const post = verifyTreeAgainstManifest(projectDir, manifest)
      if (!post.ok) verifyFailed = post.message
    }
    if (verifyFailed !== null) {
      const compensation = compensate(verifyFailed)
      return compensation.compensated
        ? { ok: false, reason: 'restore-verify-failed', message: `恢复落位后完整性校验未通过，已回滚到恢复前状态: ${verifyFailed}`, compensated: true }
        : compensation
    }

    // 6. 提交：清理 trash（旧当前内容 = 备份内容，去重），备份保留
    if (existsSync(trashDir)) rmSyncWithRetry(trashDir, { recursive: true, force: true })
    removeDirIfEmpty(join(storageDir, '_trash'))
    removeDirIfEmpty(join(storageDir, '_staging'))
    journal.phase = 'committed'
    journal.message = `carried-over=${carriedOver.length}`
    writeJournal(storageDir, journal)

    // S8：快照中声明为不可恢复的条目（symlink/特殊文件）恢复后不会存在，
    // 由结果显式携带，调用方不得声称恢复完整。
    const notRestored = manifest.unrecoverable.map((item) => item.path)
    return {
      ok: true,
      txnId,
      restoredFiles: manifest.entries.length,
      preRestoreBackupDir: backupDir,
      backupSizeBytes,
      carriedOverExcluded: carriedOver,
      notRestored,
      complete: notRestored.length === 0,
    }
  } catch (error) {
    // TestCrashError：模拟进程死亡，保持现场上抛（journal 留给 recover）；锁由 finally 释放
    if (error instanceof TestCrashError) {
      throw error
    }
    // 普通错误：已进入破坏性阶段则补偿，否则清场即止
    if (journal.phase === 'current-moved' || journal.phase === 'restore-moved' || journal.phase === 'restore-verified') {
      return compensate(String(error))
    }
    try {
      if (existsSync(stagingDir)) rmSyncWithRetry(stagingDir, { recursive: true, force: true })
      // S10：备份未完成（phase 仍为 verified/started）时清掉孤儿部分备份，不放任占盘
      if (journal.phase !== 'backup-done' && existsSync(backupDir)) {
        rmSyncWithRetry(backupDir, { recursive: true, force: true })
      }
      journal.phase = 'aborted-clean'
      journal.message = String(error)
      writeJournal(storageDir, journal)
    } catch { /* 尽力而为 */ }
    return fail('io-error', `恢复失败（工程未受影响）: ${String(error)}`, false)
  } finally {
    // S1：所有出口（成功/失败/补偿/异常/TestCrashError）都释放自己持有的锁；
    // releaseRestoreLock 仅当 token 匹配才删除，绝不误删他人新锁。
    if (ownedToken !== null) releaseRestoreLock(storageDir, ownedToken)
  }
}

// ===== 中断恢复 =====

/**
 * 恢复被进程中断的恢复事务。
 * 决策依据 = journal 阶段 + 文件系统真实状态（rename 是否已发生以目录存在性判定，不信任单一记录）：
 * - swap-intent / current-moved 且 projectDir 缺失 → rename1 已发生：完成 rename2、trash 去重 → completed-restore
 * - swap-intent / current-moved 且 projectDir 存在（S6）：
 *   - staging 已不在且 trash 仍在 → rename2 已完成但 journal 未更新：按清单校验 projectDir，
 *     通过则清 trash → completed-restore；不通过则 trash 回滚 → compensated；
 *   - 否则（staging 仍在）→ rename1 未发生：清 staging → aborted-clean。
 * - restore-moved / restore-verified → 新内容已就位：按清单校验，通过则清理 trash → completed-restore；
 *   不通过 → trash 回滚 → compensated
 * - started / verified / backup-done → 破坏性操作之前：清理 staging → aborted-clean（备份保留）
 * - committed / compensated / aborted-clean → 只做残留清理 → nothing-to-recover
 */
export function recoverInterruptedRestore(projectDir: string, storageDir: string): RecoverResult {
  // S3：recover 入口同样做布局守卫，避免对嵌套/同址配置误操作
  const layout = verifyDirectoryLayout(projectDir, storageDir)
  if (!layout.ok) {
    return { ok: false, action: 'invalid-layout', message: layout.message }
  }
  if (!existsSync(storageDir)) {
    return { ok: true, action: 'nothing-to-recover', message: '存储目录不存在，无需恢复' }
  }
  const journal = readJournal(storageDir)

  if (!journal) {
    // 无 journal：只清理孤儿 restore-staging（capture-staging 属于可能活跃的捕获，不动）
    const stagingRoot = join(storageDir, '_staging')
    if (existsSync(stagingRoot)) {
      for (const name of readdirSync(stagingRoot)) {
        if (name.startsWith('restore-')) rmSyncWithRetry(join(stagingRoot, name), { recursive: true, force: true })
      }
      removeDirIfEmpty(stagingRoot)
    }
    return { ok: true, action: 'nothing-to-recover', message: '无恢复事务日志' }
  }

  const stagingExists = existsSync(journal.stagingDir)
  const trashExists = existsSync(journal.trashDir)
  const projectExists = existsSync(journal.projectDir)

  try {
    if (journal.phase === 'committed' || journal.phase === 'compensated' || journal.phase === 'aborted-clean') {
      if (stagingExists) rmSyncWithRetry(journal.stagingDir, { recursive: true, force: true })
      removeDirIfEmpty(join(storageDir, '_staging'))
      return { ok: true, action: 'nothing-to-recover', message: `事务已是终态（${journal.phase}），仅清理残留` }
    }

    if (journal.phase === 'swap-intent' || journal.phase === 'current-moved') {
      if (!projectExists) {
        // rename1 已发生：完成 rename2
        if (!stagingExists) {
          if (trashExists) {
            // staging 丢失（严重异常）：用 trash 回滚，保住恢复前工程
            renameWithRetry(journal.trashDir, journal.projectDir)
            journal.phase = 'compensated'
            writeJournal(storageDir, journal)
            return { ok: true, action: 'compensated', message: 'staging 缺失，已用 trash 回滚到恢复前状态' }
          }
          return { ok: false, action: 'compensated', message: 'staging 与 trash 均缺失且工程目录缺失，需人工介入' }
        }
        renameWithRetry(journal.stagingDir, journal.projectDir)
        if (trashExists) {
          if (existsSync(journal.backupDir)) {
            rmSyncWithRetry(journal.trashDir, { recursive: true, force: true }) // 与备份内容重复，去重
          } else {
            // 备份缺失时把 trash 升级为备份，绝不丢恢复前工程
            mkdirSync(dirname(journal.backupDir), { recursive: true })
            renameWithRetry(journal.trashDir, journal.backupDir)
          }
        }
        journal.phase = 'restore-moved'
        writeJournal(storageDir, journal)
        journal.phase = 'committed'
        writeJournal(storageDir, journal)
        removeDirIfEmpty(join(storageDir, '_trash'))
        removeDirIfEmpty(join(storageDir, '_staging'))
        return { ok: true, action: 'completed-restore', message: '中断事务已续完：恢复内容落位，恢复前工程保留在备份目录' }
      }
      // projectDir 仍在：需区分「rename1 未发生」与「rename2 已完成但 journal 未更新」（S6 掉电窗口）。
      // 判据：staging 已不在且 trash 仍在 → rename2 已发生（staging 已被搬为 projectDir）。
      if (!stagingExists && trashExists) {
        const manifest = readJsonFileSafe<FileSnapshotManifest>(join(journal.snapshotDir, 'manifest.json'))
        const verified = manifest ? verifyTreeAgainstManifest(journal.projectDir, manifest).ok : false
        if (verified) {
          rmSyncWithRetry(journal.trashDir, { recursive: true, force: true })
          removeDirIfEmpty(join(storageDir, '_trash'))
          removeDirIfEmpty(join(storageDir, '_staging'))
          journal.phase = 'committed'
          writeJournal(storageDir, journal)
          return { ok: true, action: 'completed-restore', message: '识别到 rename2 已完成（journal 未更新窗口）：恢复内容校验通过并收尾' }
        }
        // 校验不通过：用 trash 回滚，绝不留下错误内容
        const failedDir = `${journal.trashDir}-failed`
        renameWithRetry(journal.projectDir, failedDir)
        renameWithRetry(journal.trashDir, journal.projectDir)
        rmSyncWithRetry(failedDir, { recursive: true, force: true })
        journal.phase = 'compensated'
        writeJournal(storageDir, journal)
        return { ok: true, action: 'compensated', message: '识别到 rename2 已完成但校验未通过，已用 trash 回滚到恢复前状态' }
      }
      // rename1 未发生：中止事务，清 staging
      if (stagingExists) rmSyncWithRetry(journal.stagingDir, { recursive: true, force: true })
      removeDirIfEmpty(join(storageDir, '_staging'))
      journal.phase = 'aborted-clean'
      writeJournal(storageDir, journal)
      return { ok: true, action: 'aborted-clean', message: '中断发生在目录替换之前，工程未被触动，已清理暂存' }
    }

    if (journal.phase === 'restore-moved' || journal.phase === 'restore-verified') {
      // 新内容已就位：校验后收尾；校验失败则回滚
      const manifest = readJsonFileSafe<FileSnapshotManifest>(join(journal.snapshotDir, 'manifest.json'))
      let verified = false
      if (manifest) {
        verified = verifyTreeAgainstManifest(journal.projectDir, manifest).ok
      }
      if (verified) {
        if (trashExists) rmSyncWithRetry(journal.trashDir, { recursive: true, force: true })
        removeDirIfEmpty(join(storageDir, '_trash'))
        removeDirIfEmpty(join(storageDir, '_staging'))
        journal.phase = 'committed'
        writeJournal(storageDir, journal)
        return { ok: true, action: 'completed-restore', message: '中断事务已确认：恢复内容校验通过并收尾' }
      }
      if (trashExists) {
        const failedDir = `${journal.trashDir}-failed`
        renameWithRetry(journal.projectDir, failedDir)
        renameWithRetry(journal.trashDir, journal.projectDir)
        rmSyncWithRetry(failedDir, { recursive: true, force: true })
      }
      journal.phase = 'compensated'
      writeJournal(storageDir, journal)
      return { ok: true, action: 'compensated', message: '恢复内容校验未通过，已回滚到恢复前状态' }
    }

    // started / verified / backup-done：破坏性操作之前
    if (stagingExists) rmSyncWithRetry(journal.stagingDir, { recursive: true, force: true })
    removeDirIfEmpty(join(storageDir, '_staging'))
    journal.phase = 'aborted-clean'
    writeJournal(storageDir, journal)
    return { ok: true, action: 'aborted-clean', message: '中断发生在目录替换之前，工程未被触动，已清理暂存（备份保留）' }
  } catch (error) {
    return { ok: false, action: 'compensated', message: `中断恢复执行失败，现场保留待重试: ${String(error)}` }
  }
}
