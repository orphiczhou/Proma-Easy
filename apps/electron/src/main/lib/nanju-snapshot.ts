/**
 * 南大项目快照管理
 *
 * 基于 fork_session 实现线性回滚。不新建 SnapshotManager 实体——
 * 直接复用 agent-session-manager 的 forkAgentSession。
 */

import { forkAgentSession, getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { join } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'
import { verifyFileSnapshotDir } from './nanju-file-snapshot'

// ===== 类型 =====

export interface ProjectSnapshot {
  snapshotId: number
  projectId: string
  timestamp: string
  description: string
  triggerType: 'init' | 'pre-modify' | 'confirm' | 'mode-switch' | 'pre-error'
  sessionId: string
  forkedSessionId: string
  isCurrent: boolean
  /**
   * W-D 工程文件快照关联（可选）。
   *
   * - 缺省 / null：该会话快照没有对应的工程文件快照。
   *   旧（legacy）fork 会话快照即为此形态：回滚只切换会话分支，**不得声称恢复了工程文件**。
   * - 字符串：storageDir/snapshots/<fileSnapshotId> 的文件快照 id（由 W-D
   *   `captureFileSnapshot` 生成，通过 `linkFileSnapshot` 关联）。
   *
   * 该字段是「文件可恢复性」的唯一事实来源：fork 元数据（forkedSessionId 等）
   * 不能当作文件已恢复的证据。
   */
  fileSnapshotId?: string | null
}

/** 会话快照的恢复能力描述（供 UI / IPC 使用，避免把会话回滚夸大成文件恢复） */
export interface SnapshotRecoveryCapability {
  /** fork 会话回滚：总是可用 */
  sessionRollback: true
  /** 工程文件回滚：仅当关联了 W-D 文件快照 */
  fileRollback: boolean
  /** 关联的文件快照 id；未关联时为 null */
  fileSnapshotId: string | null
  /** 面向用户的一句话描述；无文件快照时明确只回滚会话 */
  description: string
}

/** 该会话快照是否已关联工程文件快照（唯一判定入口） */
export function hasFileSnapshot(snapshot: ProjectSnapshot): boolean {
  return typeof snapshot.fileSnapshotId === 'string' && snapshot.fileSnapshotId.length > 0
}

/**
 * 描述会话快照的恢复能力。
 * 无 fileSnapshotId（旧 fork 快照）时 fileRollback=false，且描述中不出现文件恢复承诺。
 */
export function describeSnapshotRecovery(snapshot: ProjectSnapshot): SnapshotRecoveryCapability {
  const raw = snapshot.fileSnapshotId
  const fileSnapshotId = typeof raw === 'string' && raw.length > 0 ? raw : null
  return {
    sessionRollback: true,
    fileRollback: fileSnapshotId !== null,
    fileSnapshotId,
    description: fileSnapshotId !== null
      ? `回滚会话分支并恢复工程文件（文件快照 ${fileSnapshotId}）`
      : '回滚会话分支；该快照未捕获工程文件快照，不恢复工程文件',
  }
}

// ===== 存储 =====

function getSnapshotsPath(workspaceSlug: string, projectId: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`, '_snapshots.json')
}

function readSnapshots(workspaceSlug: string, projectId: string): ProjectSnapshot[] {
  return readJsonFileSafe<ProjectSnapshot[]>(getSnapshotsPath(workspaceSlug, projectId)) ?? []
}

// ===== 公开接口 =====

/**
 * 创建快照。通过 fork 当前会话实现。
 */
export async function createSnapshot(
  workspaceSlug: string,
  projectId: string,
  sessionId: string,
  description: string,
  triggerType: ProjectSnapshot['triggerType'] = 'confirm',
): Promise<ProjectSnapshot> {
  const snapshots = readSnapshots(workspaceSlug, projectId)

  // 取消之前的 isCurrent
  for (const s of snapshots) s.isCurrent = false

  // Fork 当前会话
  const forked = await forkAgentSession({ sessionId })

  // 故意不接受 fileSnapshotId 参数：文件可恢复性必须经 linkFileSnapshot 校验真实快照后才写入，
  // 避免任意字符串直接让 hasFileSnapshot=true（见 S4）。
  const snapshot: ProjectSnapshot = {
    snapshotId: snapshots.length + 1,
    projectId,
    timestamp: new Date().toISOString(),
    description,
    triggerType,
    sessionId,
    forkedSessionId: forked.id,
    isCurrent: true,
  }

  snapshots.push(snapshot)
  writeJsonFileAtomic(getSnapshotsPath(workspaceSlug, projectId), snapshots)

  return snapshot
}

/** linkFileSnapshot 结果：区分「会话快照不存在」与「文件快照不存在/无效」 */
export interface LinkFileSnapshotResult {
  ok: boolean
  reason?: 'session-snapshot-missing' | 'file-snapshot-missing' | 'file-snapshot-invalid' | 'invalid-id'
  message: string
  snapshot: ProjectSnapshot | null
}

/** 文件快照 id 形态（W-D 为 UUID）。拒绝路径分隔符/../，防拼进 storageDir 的逃逸 */
const FILE_SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 把 W-D 文件快照 id 关联到已有会话快照（D2/I 接线用）。
 *
 * S4：关联前必须验证 storageDir/snapshots/<fileSnapshotId> 真实存在且清单/hash 有效，
 * 否则**不得**写入 fileSnapshotId（避免 UI 对不存在的快照声称“可恢复工程文件”）。
 * 生产约定：storageDir 必须在 projectDir 之外（见 W-D 布局守卫）。
 */
export function linkFileSnapshot(
  workspaceSlug: string,
  projectId: string,
  snapshotId: number,
  fileSnapshotId: string,
  storageDir: string,
): LinkFileSnapshotResult {
  const snapshots = readSnapshots(workspaceSlug, projectId)
  const target = snapshots.find((s) => s.snapshotId === snapshotId)
  if (!target) {
    return { ok: false, reason: 'session-snapshot-missing', message: `会话快照不存在: ${snapshotId}`, snapshot: null }
  }
  if (!FILE_SNAPSHOT_ID_RE.test(fileSnapshotId)) {
    return { ok: false, reason: 'invalid-id', message: `文件快照 id 非法: ${fileSnapshotId}`, snapshot: null }
  }
  const snapshotDir = join(storageDir, 'snapshots', fileSnapshotId)
  const verdict = verifyFileSnapshotDir(snapshotDir)
  if (!verdict.ok) {
    const reason = verdict.reason === 'snapshot-missing' ? 'file-snapshot-missing' : 'file-snapshot-invalid'
    return { ok: false, reason, message: `文件快照不可用（${verdict.reason}）: ${snapshotDir}`, snapshot: null }
  }
  target.fileSnapshotId = fileSnapshotId
  writeJsonFileAtomic(getSnapshotsPath(workspaceSlug, projectId), snapshots)
  return { ok: true, message: `已关联文件快照 ${fileSnapshotId}`, snapshot: target }
}

/**
 * 列出所有快照。
 */
export function listSnapshots(
  workspaceSlug: string,
  projectId: string,
): ProjectSnapshot[] {
  return readSnapshots(workspaceSlug, projectId)
}

/**
 * 回滚到指定快照。将目标快照标记为 isCurrent。
 * 实际效果：用户从该快照的 forkedSessionId 继续工作。
 *
 * 注意：本函数只做「会话分支回滚」，不触碰工程文件。
 * 是否需要/能否恢复工程文件取决于快照是否关联了 W-D 文件快照，
 * 由调用方用 `describeSnapshotRecovery(target).fileRollback` 判定后再调 W-D 恢复 API；
 * 旧 fork 快照（无 fileSnapshotId）不得当成文件已恢复。
 */
export function rollbackToSnapshot(
  workspaceSlug: string,
  projectId: string,
  snapshotId: number,
): ProjectSnapshot | null {
  const snapshots = readSnapshots(workspaceSlug, projectId)
  const target = snapshots.find((s) => s.snapshotId === snapshotId)
  if (!target) return null

  for (const s of snapshots) s.isCurrent = false
  target.isCurrent = true

  writeJsonFileAtomic(getSnapshotsPath(workspaceSlug, projectId), snapshots)
  return target
}
