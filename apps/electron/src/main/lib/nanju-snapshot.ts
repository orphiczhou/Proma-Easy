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
