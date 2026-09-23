/**
 * W-I B-c：工程文件快照的生产接线网关（会话快照 ⇄ W-D 文件快照的单点收口）。
 *
 * 为什么需要这一层：
 * - W-D（`nanju-file-snapshot.ts`）只提供引擎（capture/restore/recover + 校验），**生产无人调用**；
 * - `nanju-snapshot.ts` 只做「会话分支快照」（fork），文件可恢复性靠 `fileSnapshotId` 表达；
 * - D-review-2 §5 的五条硬约束必须在这一层落实：
 *   S4 `fileSnapshotId` 唯一写入路径 = `linkFileSnapshot`（带 storageDir，校验真实快照）；
 *   S8 恢复结果的 `complete`/`notRestored` 必须进用户文案（不得声称恢复完整）；
 *   S9 `cross-device` 必须给可行动提示（不得吞错）；
 *   S10 备份保留策略 = 不自动删除，只提示占用；
 *   §5.5 三段式 `createSnapshot → captureFileSnapshot → linkFileSnapshot`（createSnapshot 不收 fileSnapshotId）。
 *
 * 边界（诚实声明）：
 * - 本模块不做 UI 渲染，只产出「用户可读文案」；文案是否被界面展示需 G 波 GUI 实测；
 * - 不引入除 `linkFileSnapshot` 之外的第二条 `fileSnapshotId` 写入路径；
 * - 捕获失败/关联失败一律 fail-closed：保留会话快照但明确「不恢复工程文件」，绝不写假 id；
 * - storageDir 取工程目录之外的兄弟目录（D 布局守卫 + 同工作区根 ⇒ 同一文件系统 ⇒ 恢复不退化为跨设备）。
 */
import { copyFileSync, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  captureFileSnapshot,
  recoverInterruptedRestore,
  restoreFileSnapshot,
  verifyFileSnapshotDir,
} from './nanju-file-snapshot'
import type { CaptureResult, RestoreResult } from './nanju-file-snapshot'
import { createSnapshot, hasFileSnapshot, linkFileSnapshot, listSnapshots, rollbackToSnapshot } from './nanju-snapshot'
import type { ProjectSnapshot } from './nanju-snapshot'
import { listNanjuProjects, getNanjuProjectDir, getNanjuProject, readProjectInfo, writeProjectInfo, updateNanjuProject, clearNanjuAdvanceAuthState } from './nanju-project'
import type { NanjuProject, NanjuProjectInfoFile } from './nanju-project'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { forkAgentSession, getAgentSessionMeta } from './agent-session-manager'
import type { ProjectRecoveryResult } from '@proma/shared'
import { getWorkspaceFilesDir } from './config-paths'

type CaptureFailureReason = Extract<CaptureResult, { ok: false }>['reason']
type RestoreFailureReason = Extract<RestoreResult, { ok: false }>['reason']

/**
 * 工程文件快照存储目录（storageDir）。
 *
 * 位置：`<workspace-files>/project-<id>-file-snapshots`——与 `project-<id>/` 同级，
 * 满足 D 引擎「storageDir 必须在 projectDir 之外且不相交」的布局守卫，
 * 且与工程同处一个工作区目录 ⇒ 同一文件系统，恢复不会被 cross-device 拒绝。
 */
export function getProjectFileSnapshotStorageDir(workspaceSlug: string, projectId: string): string {
  if (![workspaceSlug, projectId].every(value => typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..' && !/[\\/\0]/.test(value))) throw new Error('工作区或工程标识非法')
  return join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}-file-snapshots`)
}

/** 文件快照捕获结论（fail-closed：`ok=false` 时调用方不得写任何 fileSnapshotId） */
export interface FileCaptureOutcome {
  ok: boolean
  /** 仅 ok=true 时存在（W-D 的 UUID 字符串，原样透传，不做数值派生） */
  snapshotId?: string
  snapshotDir?: string
  reason?: CaptureFailureReason
  /** 面向用户/日志的一句话（含不可恢复项数量提示） */
  message: string
}

/**
 * 捕获一次工程文件快照（不写任何索引；关联由 `linkFileSnapshot` 负责）。
 *
 * @param label 归因前缀（如 `[pre-modify] `），仅进文案不影响语义
 */
export function captureProjectFileSnapshot(
  workspaceSlug: string,
  projectId: string,
  label = '',
): FileCaptureOutcome {
  let result: CaptureResult
  try {
    result = captureFileSnapshot(getNanjuProjectDir(workspaceSlug, projectId), getProjectFileSnapshotStorageDir(workspaceSlug, projectId))
  } catch (e) {
    // 引擎自身异常（非预期）；同样 fail-closed，不抛出给调用方（快照失败不得中断阶段推进）
    return { ok: false, message: `${label}文件快照捕获异常：${e instanceof Error ? e.message : String(e)}；本次不创建文件恢复点` }
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      message: `${label}文件快照捕获失败（${result.reason}）：${result.message}；本次不创建文件恢复点（不写 fileSnapshotId）`,
    }
  }
  const { manifest } = result
  const unrecoverable = manifest.unrecoverable.length
  return {
    ok: true,
    snapshotId: manifest.snapshotId,
    snapshotDir: result.snapshotDir,
    message: `${label}文件快照已捕获：${manifest.fileCount} 个文件 / ${manifest.totalBytes} 字节`
      + (unrecoverable > 0 ? `（另有 ${unrecoverable} 个符号链接/特殊文件不入快照，恢复时无法复原）` : ''),
  }
}

/** 检查点创建结果：会话快照 + 文件捕获 + 两者关联事实 */
export interface ProjectCheckpointResult {
  snapshot: ProjectSnapshot
  fileCapture: FileCaptureOutcome
  /** 仅当「捕获成功」且「linkFileSnapshot 校验通过」才非 null（S4） */
  fileSnapshotId: string | null
  /** 面向用户的一句话（含文件可恢复性事实，不夸大） */
  message: string
}

/**
 * 工程检查点（三段式）：`createSnapshot` → `captureFileSnapshot` → `linkFileSnapshot`。
 *
 * 语义保证：
 * - 会话快照创建失败会向上抛（调用方决定是否中断）；
 * - 文件捕获/关联失败**不抛**、不回滚会话快照：返回会话快照 + `fileSnapshotId=null` +
 *   明确文案，避免「文件捕获失败」把已经成立的会话级回滚点也丢掉。
 */
export async function createProjectCheckpoint(
  workspaceSlug: string,
  projectId: string,
  sessionId: string,
  description: string,
  triggerType: ProjectSnapshot['triggerType'],
): Promise<ProjectCheckpointResult> {
  const snapshot = await createSnapshot(workspaceSlug, projectId, sessionId, description, triggerType)
  const fileCapture = captureProjectFileSnapshot(workspaceSlug, projectId, `[${triggerType}] `)
  let fileSnapshotId: string | null = null
  let effective = snapshot
  let message = `已创建${triggerType}快照（会话分支），${fileCapture.message}`
  if (fileCapture.ok && fileCapture.snapshotId) {
    const linked = linkFileSnapshot(workspaceSlug, projectId, snapshot.snapshotId, fileCapture.snapshotId, getProjectFileSnapshotStorageDir(workspaceSlug, projectId))
    if (linked.ok && linked.snapshot) {
      fileSnapshotId = fileCapture.snapshotId
      // 以持久化后的对象为准（linkFileSnapshot 回写的是盘上那份，不是本次入参对象）
      effective = linked.snapshot
      message = `已创建${triggerType}检查点：会话分支 + 工程文件（快照 ${fileCapture.snapshotId}）。${fileCapture.message}`
    } else {
      message = `已创建${triggerType}快照（会话分支），但工程文件快照未关联成功（${linked.reason}：${linked.message}）——回滚该快照只切会话分支，不恢复工程文件。`
    }
  } else {
    message = `已创建${triggerType}快照（会话分支）。${fileCapture.message}——回滚该快照只切会话分支，不恢复工程文件。`
  }
  return { snapshot: effective, fileCapture, fileSnapshotId, message }
}

/** 工程文件恢复结论（S8/S9/S10 的用户可见事实） */
export interface FileRestoreOutcome {
  ok: boolean
  /** 是否所有快照条目都已恢复（S8：false 时不得声称恢复完整） */
  complete: boolean
  /** 快照声明但未恢复的条目（符号链接/特殊文件）；非空即不完整 */
  notRestored: string[]
  reason?: RestoreFailureReason
  /** 恢复前备份保留位置与大小（S10：不自动删除，仅提示占用） */
  preRestoreBackupDir?: string
  backupSizeBytes?: number
  /** true = 该结论要求用户手工处置（跨文件系统/恢复不完整/需人工回滚） */
  actionable: boolean
  userMessage: string
}

/**
 * 把工程目录恢复到指定文件快照。
 *
 * S8：`complete=false` 时文案明确「恢复不完整」并列出 `notRestored`；
 * S9：`cross-device` 给可行动提示（工程未改动，建议迁移快照目录或人工处理）；
 * S10：成功时回报前置备份占用与「系统不自动清理」。
 */
export function restoreProjectFileSnapshot(
  workspaceSlug: string,
  projectId: string,
  fileSnapshotId: string,
): FileRestoreOutcome {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(fileSnapshotId)) return { ok: false, complete: false, notRestored: [], actionable: true, userMessage: '文件快照标识非法，已拒绝恢复。' }
  const storageDir = getProjectFileSnapshotStorageDir(workspaceSlug, projectId)
  const snapshotDir = join(storageDir, 'snapshots', fileSnapshotId)
  const verdict = verifyFileSnapshotDir(snapshotDir)
  if (!verdict.ok) {
    return {
      ok: false, complete: false, notRestored: [], actionable: true,
      userMessage: `工程文件快照不可用（${verdict.reason}）：${snapshotDir}。会话分支回滚不受影响；工程文件保持当前值。`,
    }
  }
  let result: RestoreResult
  try {
    result = restoreFileSnapshot(snapshotDir, getNanjuProjectDir(workspaceSlug, projectId), storageDir)
  } catch (e) {
    return {
      ok: false, complete: false, notRestored: [], actionable: true,
      userMessage: `工程文件恢复异常：${e instanceof Error ? e.message : String(e)}。请检查工程目录与快照目录后重试。`,
    }
  }
  if (!result.ok) {
    return {
      ok: false, complete: false, notRestored: [], reason: result.reason, actionable: true,
      userMessage: describeRestoreFailure(result),
    }
  }
  const notRestored = result.notRestored ?? []
  const complete = result.complete === true && notRestored.length === 0
  const backupNote = result.preRestoreBackupDir
    ? `恢复前的工程已整份保留在 ${result.preRestoreBackupDir}（${result.backupSizeBytes} 字节）；系统不自动清理备份，确认无误后可人工删除以释放空间。`
    : ''
  return {
    ok: true,
    complete,
    notRestored,
    preRestoreBackupDir: result.preRestoreBackupDir,
    backupSizeBytes: result.backupSizeBytes,
    actionable: !complete,
    userMessage: complete
      ? `工程文件已恢复完整（${result.restoredFiles} 个文件）。${backupNote}`
      : `工程文件已恢复但**不完整**：${result.restoredFiles} 个文件已恢复，另有 ${notRestored.length} 项无法复原（符号链接/特殊文件）：${notRestored.slice(0, 10).join('、')}${notRestored.length > 10 ? ' 等' : ''}。请人工补齐这些文件后再验证；不得按「已完整恢复」处置。${backupNote}`,
  }
}

/** 恢复失败的用户文案（S9 跨设备给可行动出口；其余按原因给出下一步） */
function describeRestoreFailure(result: Extract<RestoreResult, { ok: false }>): string {
  const compensated = result.compensated ? '工程已回滚到恢复前状态。' : '工程可能处于中间状态，请人工核查。'
  switch (result.reason) {
    case 'cross-device':
      return `无法恢复：工程目录与快照存储目录不在同一文件系统（${result.message}）。这是有意拒绝而不是静默降级——请把快照存储目录迁移到与工程同一磁盘（或手工复制快照内容）后重试；本次未改动工程。`
    case 'locked':
      return `另一个恢复事务正在进行（${result.message}），本次未改动工程。请等其结束后重试；若确知对方已崩溃，可重启应用后重试（陈旧锁会被安全接管）。`
    case 'project-dir-missing':
      return `工程目录不存在（${result.message}），无法恢复。请确认工程未被移动/删除。`
    case 'snapshot-missing':
    case 'manifest-invalid':
    case 'hash-mismatch':
      return `快照自身不可用（${result.reason}：${result.message}），拒绝以损坏快照覆盖工程。${compensated}请改用其它快照。`
    case 'restore-verify-failed':
      return `恢复后完整性校验失败（${result.message}）。${compensated}`
    case 'io-error':
      return `恢复过程中发生 IO 错误（${result.message}）。${compensated}请检查磁盘空间/权限后重试。`
    case 'unsafe-path':
      return `快照清单含逃逸路径，已拒绝恢复（${result.message}）。${compensated}`
    case 'invalid-layout':
      return `存储布局非法（快照目录与工程目录相交），已拒绝恢复（${result.message}）。本次未改动工程。`
    default:
      return `工程文件恢复失败（${result.message}）。${compensated}`
  }
}

/** 快照存储占用（S10：不自动清理，仅提示） */
export interface SnapshotStorageFootprint {
  /** storageDir/snapshots 下可用的文件快照数 */
  snapshotCount: number
  /** 上述快照总字节 */
  snapshotBytes: number
  /** storageDir/_pre-restore-backups 下恢复前置备份数 */
  backupCount: number
  /** 上述备份总字节 */
  backupBytes: number
  storageDir: string
  /** 面向用户的占用提示（含「不自动清理」口径） */
  message: string
}

function dirFootprint(dir: string): { count: number; bytes: number } {
  if (!existsSync(dir)) return { count: 0, bytes: 0 }
  let count = 0
  let bytes = 0
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    try {
      if (!statSync(child).isDirectory()) continue
    } catch { continue }
    count += 1
    bytes += dirSize(child)
  }
  return { count, bytes }
}

function dirSize(dir: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch { return 0 }
  for (const name of entries) {
    const child = join(dir, name)
    try {
      const st = statSync(child)
      if (st.isDirectory()) total += dirSize(child)
      else total += st.size
    } catch { /* 统计尽力而为：单个条目失败不阻断 */ }
  }
  return total
}

/** 统计工程文件快照与恢复备份占用，并给出「不自动清理」提示文案 */
export function describeSnapshotStorageFootprint(workspaceSlug: string, projectId: string): SnapshotStorageFootprint {
  const storageDir = getProjectFileSnapshotStorageDir(workspaceSlug, projectId)
  const snapshots = dirFootprint(join(storageDir, 'snapshots'))
  const backups = dirFootprint(join(storageDir, '_pre-restore-backups'))
  return {
    snapshotCount: snapshots.count,
    snapshotBytes: snapshots.bytes,
    backupCount: backups.count,
    backupBytes: backups.bytes,
    storageDir,
    message: `工程文件快照：${snapshots.count} 个 / ${snapshots.bytes} 字节；恢复前置备份：${backups.count} 个 / ${backups.bytes} 字节（目录：${storageDir}）。`
      + '系统不会自动清理快照与备份（快照是回滚依据，备份是误恢复的兜底），请人工确认后删除不再需要的目录以释放空间。',
  }
}

/** 跨文件、会话绑定与业务阶段的事务日志放在工程目录外，文件恢复不会覆盖它。 */
interface ProjectRecoveryJournal {
  version: 1
  projectId: string
  phase: 'prepared' | 'files-restored' | 'committed' | 'compensated' | 'partial'
  beforeProject: NanjuProject
  beforeInfo: NanjuProjectInfoFile
  preRestoreSnapshotId: number
  preFileSnapshotId: string
  targetSnapshotId: number
  message: string
}

const recoveryLocks = new Set<string>()
function recoveryKey(workspaceSlug: string, projectId: string): string {
  return `${workspaceSlug}:${projectId}`
}
function recoveryJournalPath(workspaceSlug: string, projectId: string): string {
  return join(getProjectFileSnapshotStorageDir(workspaceSlug, projectId), '_project-recovery.json')
}

function validRecoveryJournal(value: unknown, workspaceSlug: string, projectId: string): value is ProjectRecoveryJournal {
  if (!value || typeof value !== 'object') return false
  const j = value as Partial<ProjectRecoveryJournal>
  if (j.version !== 1 || j.projectId !== projectId || !j.phase || !['prepared', 'files-restored', 'committed', 'compensated', 'partial'].includes(j.phase)) return false
  if (j.beforeProject?.projectId !== projectId || j.beforeProject.workspaceSlug !== workspaceSlug || j.beforeInfo?.projectId !== projectId || j.beforeInfo.workspaceSlug !== workspaceSlug) return false
  if (!j.beforeProject.sessionId || j.beforeProject.sessionId !== j.beforeInfo.sessionId || !['mode-select', 'requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered'].includes(j.beforeProject.currentStage)) return false
  if (!Number.isInteger(j.preRestoreSnapshotId) || !Number.isInteger(j.targetSnapshotId) || typeof j.preFileSnapshotId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(j.preFileSnapshotId)) return false
  const pre = listSnapshots(workspaceSlug, projectId).find(snapshot => snapshot.snapshotId === j.preRestoreSnapshotId && snapshot.projectId === projectId)
  return Boolean(pre && pre.fileSnapshotId === j.preFileSnapshotId && pre.sessionId === j.beforeProject.sessionId)
}

function resolveWithExistingParents(path: string): string {
  let parent = resolve(path)
  const suffix: string[] = []
  while (!existsSync(parent) && dirname(parent) !== parent) {
    suffix.unshift(parent.slice(dirname(parent).length + 1))
    parent = dirname(parent)
  }
  return join(realpathSync(parent), ...suffix)
}

/** 所有 Agent 入口与工具门禁使用同一个锁；重启时未提交日志仍然阻止执行。 */
export function getProjectRecoveryBlock(workspaceSlug: string, projectId: string): string | null {
  if (recoveryLocks.has(recoveryKey(workspaceSlug, projectId))) return '工程正在恢复，请等待恢复结束后继续。'
  const path = recoveryJournalPath(workspaceSlug, projectId)
  if (!existsSync(path)) return null
  const journal = readJsonFileSafe<ProjectRecoveryJournal>(path)
  if (!validRecoveryJournal(journal, workspaceSlug, projectId)) return '恢复日志不可读；请在时间轴选择含文件与阶段信息的检查点，确认后将保留原日志并重新恢复。'
  if (journal.phase === 'committed' || journal.phase === 'compensated') return null
  return journal.phase === 'partial'
    ? '工程仅部分恢复（文件或阶段信息不完整，可能缺少阶段信息）；请在时间轴选择恢复前版本。'
    : '工程恢复尚未完整提交，请先打开工程处理恢复事务。'
}

export function getWorkspaceRecoveryBlock(workspaceSlug: string): string | null {
  for (const project of listNanjuProjects(workspaceSlug)) {
    const block = getProjectRecoveryBlock(workspaceSlug, project.projectId)
    if (block) return `${project.name}：${block}`
  }
  return null
}

/** 沿真实会话父链定位所属项目，含委派/恢复fork；循环或断链不猜测归属。 */
export function findRecoveryProjectForSession(workspaceSlug: string, sessionId: string): NanjuProject | undefined {
  const projects = listNanjuProjects(workspaceSlug)
  const visited = new Set<string>()
  let current: string | undefined = sessionId
  while (current && !visited.has(current) && visited.size < 64) {
    visited.add(current)
    const project = projects.find(p => p.sessionId === current)
    if (project) return project
    current = getAgentSessionMeta(current)?.parentSessionId
  }
  return undefined
}

const RECOVERY_READ_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'find', 'browserobserve', 'browserscreenshot', 'browserlisttabs', 'askuserquestion', 'taskcreate', 'taskupdate', 'tasklist', 'taskget'])
/** 对话/只读诊断始终可达；显式写路径只拦受影响项目，无法约束路径的shell/MCP保守阻止。 */
export function getRecoveryToolBlock(workspaceSlug: string, sessionId: string, toolName: string, input: Record<string, unknown>): string | null {
  const normalizedTool = toolName.toLowerCase().replace(/^functions\./, '')
  if (RECOVERY_READ_TOOLS.has(normalizedTool)) return null
  const blocked = listNanjuProjects(workspaceSlug).filter(p => getProjectRecoveryBlock(workspaceSlug, p.projectId))
  if (!blocked.length) return null
  const owner = findRecoveryProjectForSession(workspaceSlug, sessionId)
  const ownsBlocked = owner && blocked.some(p => p.projectId === owner.projectId)
  if (ownsBlocked) return getProjectRecoveryBlock(workspaceSlug, owner.projectId)
  if (['write', 'edit', 'multiedit'].includes(normalizedTool)) {
    const target = input.file_path ?? input.path
    if (typeof target === 'string' && target.startsWith(sep)) {
      let path: string
      try { path = resolveWithExistingParents(target) } catch { return '写入路径无法核验，请先完成工程恢复。' }
      for (const project of blocked) {
        const roots = [getNanjuProjectDir(workspaceSlug, project.projectId), getProjectFileSnapshotStorageDir(workspaceSlug, project.projectId)]
        if (roots.some(root => { const actual = resolveWithExistingParents(root); return path === actual || path.startsWith(actual + sep) })) return getProjectRecoveryBlock(workspaceSlug, project.projectId)
      }
      return null
    }
  }
  return '工作区存在未完成的恢复事务：可继续只读诊断或修改其它工程的明确文件路径；任意命令/委派请先通过时间轴完成恢复，避免跨工程写入。'
}

/** 中断恢复采用保守补偿：回到恢复前已索引的版本，不猜测未提交的目标状态。 */
export function recoverInterruptedProjectRestore(workspaceSlug: string, projectId: string): { ok: boolean; message: string } {
  if (recoveryLocks.has(recoveryKey(workspaceSlug, projectId))) return { ok: false, message: '工程正在恢复，请稍后重试。' }
  const path = recoveryJournalPath(workspaceSlug, projectId)
  const journal = readJsonFileSafe<ProjectRecoveryJournal>(path)
  if (existsSync(path) && !validRecoveryJournal(journal, workspaceSlug, projectId)) {
    return { ok: false, message: '恢复日志损坏；可只读检查工程，或在时间轴选择完整检查点重新恢复。原日志与备份不会删除。' }
  }
  if (journal?.phase === 'partial') return { ok: false, message: getProjectRecoveryBlock(workspaceSlug, projectId)! }
  if (!journal || journal.phase === 'committed' || journal.phase === 'compensated') {
    const storage = getProjectFileSnapshotStorageDir(workspaceSlug, projectId)
    if (!existsSync(join(storage, '_restore-journal.json'))) return { ok: true, message: '无待恢复事务。' }
    const result = recoverInterruptedRestore(getNanjuProjectDir(workspaceSlug, projectId), storage)
    return { ok: result.ok, message: result.message }
  }
  try {
    const recovered = recoverInterruptedRestore(getNanjuProjectDir(workspaceSlug, projectId), getProjectFileSnapshotStorageDir(workspaceSlug, projectId))
    if (!recovered.ok) return { ok: false, message: recovered.message }
    const restored = restoreProjectFileSnapshot(workspaceSlug, projectId, journal.preFileSnapshotId)
    if (!restored.ok || !restored.complete) return { ok: false, message: `恢复中断后的补偿未完成。${restored.userMessage}` }
    writeProjectInfo(workspaceSlug, projectId, invalidateRecoveryAuthorization(journal.beforeInfo))
    if (!updateNanjuProject(workspaceSlug, projectId, journal.beforeProject)) throw new Error('项目索引不存在')
    if (!rollbackToSnapshot(workspaceSlug, projectId, journal.preRestoreSnapshotId)) throw new Error('恢复前时间轴条目不存在')
    clearNanjuAdvanceAuthState(workspaceSlug, projectId)
    journal.phase = 'compensated'
    journal.message = '发现中断的恢复事务，已返回恢复前版本；请重新验收后继续。'
    writeJsonFileAtomic(path, journal)
    return { ok: true, message: journal.message }
  } catch (e) {
    return { ok: false, message: `恢复中断后的补偿失败：${e instanceof Error ? e.message : String(e)}；请保留快照与备份。` }
  }
}

function invalidateRecoveryAuthorization(info: NanjuProjectInfoFile): NanjuProjectInfoFile {
  const result = { ...info }
  delete result.deliveryAck
  delete result.deliveryChallenge
  delete result.confirmPendingStage
  delete result.pendingAdvanceCorrection
  delete result.codingDelegationId
  return result
}

/** 测试可注入活跃检查；生产由 IPC 接入实际 Agent 运行表，未提供时 fail-closed。 */
export interface ProjectRecoveryPorts {
  isBusy: () => boolean
}

export interface ProjectSnapshotRollbackResult extends ProjectRecoveryResult {
  snapshot: ProjectSnapshot | null
}

/** 恢复前先保存当前版本；文件、会话绑定、业务状态均提交后才报告完整成功。 */
export async function rollbackProjectSnapshot(
  workspaceSlug: string,
  projectId: string,
  snapshotId: number,
  ports?: ProjectRecoveryPorts,
): Promise<ProjectSnapshotRollbackResult> {
  const failed = (message: string, preRestoreSnapshotId: number | null = null): ProjectSnapshotRollbackResult => ({
    ok: false, status: 'failed', snapshot: null, fileRestore: null, message,
    activeSessionId: null, restoredSnapshotId: null, preRestoreSnapshotId,
  })
  const key = recoveryKey(workspaceSlug, projectId)
  if (recoveryLocks.has(key)) return failed('工程正在恢复，请稍后重试。')
  if (!ports || ports.isBusy()) return failed('工作区仍有正在运行的会话；请停止相关会话后再恢复。')
  const target = listSnapshots(workspaceSlug, projectId).find(s => s.snapshotId === snapshotId && s.projectId === projectId)
  if (!target) return failed(`会话快照不存在：${snapshotId}`)
  const project = getNanjuProject(workspaceSlug, projectId)
  const beforeInfo = readProjectInfo(workspaceSlug, projectId)
  if (!project?.sessionId || !beforeInfo) return failed('项目或当前会话绑定缺失，无法保存恢复前版本。')
  const original = getAgentSessionMeta(project.sessionId)
  const targetSession = getAgentSessionMeta(target.forkedSessionId)
  if (!original || !targetSession || !original.workspaceId || original.workspaceId !== targetSession.workspaceId) {
    return failed('快照会话不存在或所属工作区不一致，未修改工程。')
  }
  // partial 可通过选择恢复前版本来修复；其它未提交事务必须先补偿。
  const journalPath = recoveryJournalPath(workspaceSlug, projectId)
  const previousJournal = readJsonFileSafe<ProjectRecoveryJournal>(journalPath)
  const damagedJournal = existsSync(journalPath) && !validRecoveryJournal(previousJournal, workspaceSlug, projectId)
  if (damagedJournal && (!target.recoveryState || !target.fileSnapshotId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(target.fileSnapshotId) || !verifyFileSnapshotDir(join(getProjectFileSnapshotStorageDir(workspaceSlug, projectId), 'snapshots', target.fileSnapshotId)).ok)) return failed('恢复日志损坏；请选择含完整文件与阶段记录的检查点。原日志与备份均已保留。')
  if (!damagedJournal && previousJournal?.phase !== 'partial') {
    const recovered = recoverInterruptedProjectRestore(workspaceSlug, projectId)
    if (!recovered.ok) return failed(recovered.message)
  }
  recoveryLocks.add(key)
  let preId: number | null = null
  let journal: ProjectRecoveryJournal | null = null
  try {
    const pre = await createProjectCheckpoint(workspaceSlug, projectId, project.sessionId, `恢复快照 ${snapshotId} 前的版本`, 'pre-restore')
    preId = pre.snapshot.snapshotId
    if (!pre.fileSnapshotId || !pre.fileCapture.ok) return failed(`未能保存恢复前版本，已取消恢复。${pre.message}`, preId)
    // 不把不可完整恢复的前置快照作为事务补偿承诺。
    const preVerdict = verifyFileSnapshotDir(join(getProjectFileSnapshotStorageDir(workspaceSlug, projectId), 'snapshots', pre.fileSnapshotId))
    if (!preVerdict.ok || preVerdict.manifest.unrecoverable.length > 0) return failed('恢复前版本含无法快照的条目；已取消恢复，请先处理符号链接/特殊文件。', preId)
    // 从冻结的历史上下文再创建分支，避免用户后续消息改写原快照会话。
    const resumed = await forkAgentSession({ sessionId: target.forkedSessionId })
    if (ports.isBusy()) return failed('保存恢复点期间有会话启动，已取消恢复，请停止会话后重试。', preId)
    journal = {
      version: 1, projectId, phase: 'prepared', beforeProject: project, beforeInfo,
      preRestoreSnapshotId: preId, preFileSnapshotId: pre.fileSnapshotId,
      targetSnapshotId: snapshotId, message: '工程恢复未提交，执行暂时停止。',
    }
    if (damagedJournal) {
      // 用户已在时间轴确认恢复；先原样归档损坏日志，随后才用新事务替换。
      copyFileSync(journalPath, `${journalPath}.corrupt-${Date.now()}`)
    }
    writeJsonFileAtomic(journalPath, journal)
    const fileRestore = hasFileSnapshot(target)
      ? restoreProjectFileSnapshot(workspaceSlug, projectId, target.fileSnapshotId as string)
      : null
    if (fileRestore && !fileRestore.ok) throw new Error(fileRestore.userMessage)
    journal.phase = 'files-restored'
    writeJsonFileAtomic(recoveryJournalPath(workspaceSlug, projectId), journal)
    const state = target.recoveryState
    const validStages = new Set<NanjuProject['currentStage']>(['mode-select', 'requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered'])
    const validRecoveryState = Boolean(state && validStages.has(state.currentStage) && state.status)
    const safeState = validRecoveryState ? state! : null
    const restoredStage: NanjuProject['currentStage'] = safeState?.currentStage === 'delivered' ? 'testing' : safeState?.currentStage ?? project.currentStage
    const info = invalidateRecoveryAuthorization(beforeInfo)
    info.sessionId = resumed.id
    info.subStage = safeState?.currentStage === 'delivered' ? 'TEST' : safeState?.subStage
    if (safeState?.projectCategory) info.projectCategory = safeState.projectCategory
    writeProjectInfo(workspaceSlug, projectId, info)
    if (!updateNanjuProject(workspaceSlug, projectId, { sessionId: resumed.id, currentStage: restoredStage, status: 'active' })) throw new Error('项目索引更新失败')
    const snapshot = rollbackToSnapshot(workspaceSlug, projectId, snapshotId)
    if (!snapshot) throw new Error('快照时间轴更新失败')
    clearNanjuAdvanceAuthState(workspaceSlug, projectId)
    const complete = Boolean(fileRestore?.ok && fileRestore.complete && validRecoveryState)
    const message = complete
      ? `已恢复会话、工程文件与阶段；恢复前版本已保存为快照 ${preId}。请重新验收后交付。${fileRestore?.userMessage}`
      : `部分恢复：${fileRestore ? fileRestore.userMessage : '仅恢复会话上下文，旧快照未关联工程文件快照，工程文件保持当前值。'}${validRecoveryState ? '' : '旧快照缺少合法阶段信息，未恢复阶段。'}请先选择恢复前快照 ${preId} 返回完整版本，再补建完整检查点。`
    journal.phase = complete ? 'committed' : 'partial'
    journal.message = message
    writeJsonFileAtomic(recoveryJournalPath(workspaceSlug, projectId), journal)
    return { ok: complete, status: complete ? 'restored' : 'partial', snapshot, fileRestore, message,
      activeSessionId: resumed.id, restoredSnapshotId: snapshotId, preRestoreSnapshotId: preId }
  } catch (e) {
    // 释放内存锁后走与重启相同的补偿路径；失败日志保留并继续阻止 Agent 写入。
    recoveryLocks.delete(key)
    const compensation = journal ? recoverInterruptedProjectRestore(workspaceSlug, projectId) : null
    return failed(`恢复失败：${e instanceof Error ? e.message : String(e)}。${compensation?.message ?? '原工程未恢复；已创建的检查点予以保留。'}`, preId)
  } finally {
    recoveryLocks.delete(key)
  }
}

/**
 * W-I B-d：E 的 `FileRollbackPort` 真实适配（零字段映射薄壳——`RestoreResult` 与
 * `FileRollbackResult` 结构对齐，见 E.md §6 / D-review-2）。
 *
 * - `capture(label)`：包 `captureProjectFileSnapshot`；失败**抛错**（E 明令不得静默成功）；
 * - `rollback(snapshotId)`：先校验快照目录，再包 `restoreFileSnapshot` **原样**透传结果
 *   （`ok/reason/message/compensated/preRestoreBackupDir` 字段名即 E 期望形状）。
 *
 * 不在此层做「成功/失败」判断——措辞由 `buildCircuitBreakMessage` 依结构化结果决定。
 */
export function createProjectFileRollbackPort(
  workspaceSlug: string,
  projectId: string,
): import('./nanju-repair-loop').FileRollbackPort {
  const storageDir = getProjectFileSnapshotStorageDir(workspaceSlug, projectId)
  return {
    async capture(label: string) {
      const outcome = captureProjectFileSnapshot(workspaceSlug, projectId, label)
      if (!outcome.ok || !outcome.snapshotId) {
        throw new Error(`工程文件快照捕获失败（${outcome.reason ?? 'unknown'}）：${outcome.message}`)
      }
      return { snapshotId: outcome.snapshotId }
    },
    async rollback(snapshotId: string) {
      const snapshotDir = join(storageDir, 'snapshots', snapshotId)
      const verdict = verifyFileSnapshotDir(snapshotDir)
      if (!verdict.ok) {
        return {
          ok: false as const,
          reason: verdict.reason,
          message: `快照目录不可用（${verdict.reason}）：${snapshotDir}`,
          compensated: false,
        }
      }
      return restoreFileSnapshot(snapshotDir, getNanjuProjectDir(workspaceSlug, projectId), storageDir)
    },
  }
}

/**
 * 本轮回滚目标快照：最近一个**已关联文件快照**的会话快照（优先 `pre-modify`——
 * 即进入 coding 之前那一份，正是「本次任务开始前」的健康态）。
 *
 * 为什么不是「所有快照里最新」：只有 `hasFileSnapshot` 的快照才能恢复工程文件，
 * 未关联的（legacy/捕获失败）回滚只会切会话分支，拿它做回滚目标会给出错误暗示。
 */
export function resolveRepairRollbackSnapshot(
  workspaceSlug: string,
  projectId: string,
): { snapshotId: string; label: string } | null {
  const linked = listSnapshots(workspaceSlug, projectId).filter((snapshot) => hasFileSnapshot(snapshot) && snapshot.triggerType !== 'pre-restore')
  if (linked.length === 0) return null
  const preferred = [...linked].reverse().find((snapshot) => snapshot.triggerType === 'pre-modify') ?? linked[linked.length - 1]
  if (!preferred || !preferred.fileSnapshotId) return null
  return { snapshotId: preferred.fileSnapshotId, label: preferred.description }
}
