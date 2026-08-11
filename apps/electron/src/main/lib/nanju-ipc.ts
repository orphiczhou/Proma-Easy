/**
 * 南大项目 IPC handlers
 *
 * 注册项目元数据 + 埋点相关的 IPC 通道。
 */

import type { IpcMain } from 'electron'
import {
  listNanjuProjects,
  createNanjuProject,
  updateNanjuProject,
  getNanjuProject,
  deleteNanjuProject,
} from './nanju-project'
import { recordTelemetry, readTelemetry } from './nanju-telemetry'
import type { ProjectMode } from './nanju-project'
import { startNanjuHtmlWatcher } from './nanju-preview-watcher'
import { createSnapshot, listSnapshots, rollbackToSnapshot } from './nanju-snapshot'
import { loadRoleConfig, loadRoleSequence, createRoleSession, getRoleSequence } from './nanju-orchestrator'
import type { TelemetryEventType } from './nanju-telemetry'
import type { ProjectSnapshot } from './nanju-snapshot'

export function registerNanjuIpc(ipcMain: IpcMain, getMainWindow: () => Electron.BrowserWindow | null): void {
  // ===== 项目元数据 =====
  ipcMain.handle('nanju:list-projects', async (_event, workspaceSlug: string) => {
    return listNanjuProjects(workspaceSlug)
  })

  ipcMain.handle('nanju:create-project', async (_event, input: {
    name: string
    mode: ProjectMode
    workspaceSlug: string
    sessionId?: string
  }) => {
    return createNanjuProject(input)
  })

  ipcMain.handle('nanju:update-project', async (_event, input: {
    workspaceSlug: string
    projectId: string
    updates: Record<string, unknown>
  }) => {
    return updateNanjuProject(input.workspaceSlug, input.projectId, input.updates)
  })

  ipcMain.handle('nanju:get-project', async (_event, input: {
    workspaceSlug: string
    projectId: string
  }) => {
    return getNanjuProject(input.workspaceSlug, input.projectId)
  })

  ipcMain.handle('nanju:delete-project', async (_event, input: {
    workspaceSlug: string
    projectId: string
  }) => {
    return deleteNanjuProject(input.workspaceSlug, input.projectId)
  })

  // ===== HTML 原型监听 =====
  ipcMain.handle('nanju:start-html-watcher', async (_event, workspaceSlug: string) => {
    const win = getMainWindow()
    if (win) {
      startNanjuHtmlWatcher(win, workspaceSlug)
      return { ok: true }
    }
    return { ok: false, error: 'No main window' }
  })

  // ===== 角色编排 =====
  ipcMain.handle('nanju:load-role-config', async (_event, roleId: string) => {
    return loadRoleConfig(roleId)
  })

  ipcMain.handle('nanju:load-role-sequence', async () => {
    return loadRoleSequence()
  })

  ipcMain.handle('nanju:get-role-sequence', async (_event, mode: 'quick' | 'iterative') => {
    return getRoleSequence(mode)
  })

  ipcMain.handle('nanju:create-role-session', async (_event, input: {
    roleId: string; workspaceId: string; projectContext?: string;
  }) => {
    return createRoleSession(input.roleId, input.workspaceId, input.projectContext)
  })

  // ===== 快照管理 =====
  ipcMain.handle('nanju:create-snapshot', async (_event, input: {
    workspaceSlug: string; projectId: string; sessionId: string;
    description: string; triggerType?: string;
  }) => {
    return createSnapshot(input.workspaceSlug, input.projectId, input.sessionId, input.description, input.triggerType as ProjectSnapshot['triggerType'])
  })

  ipcMain.handle('nanju:list-snapshots', async (_event, input: {
    workspaceSlug: string; projectId: string;
  }) => {
    return listSnapshots(input.workspaceSlug, input.projectId)
  })

  ipcMain.handle('nanju:rollback-snapshot', async (_event, input: {
    workspaceSlug: string; projectId: string; snapshotId: number;
  }) => {
    return rollbackToSnapshot(input.workspaceSlug, input.projectId, input.snapshotId)
  })

  // ===== 埋点 =====
  ipcMain.handle('nanju:record-event', async (_event, input: {
    workspaceSlug: string
    eventType: TelemetryEventType
    payload?: Record<string, unknown>
    projectId?: string
  }) => {
    return recordTelemetry(input.workspaceSlug, input.eventType, input.payload ?? {}, input.projectId)
  })

  ipcMain.handle('nanju:read-events', async (_event, input: {
    workspaceSlug: string
    eventType?: TelemetryEventType
  }) => {
    return readTelemetry(input.workspaceSlug, input.eventType)
  })
}
