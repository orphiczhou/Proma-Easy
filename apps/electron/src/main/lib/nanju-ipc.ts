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
import type { TelemetryEventType } from './nanju-telemetry'

export function registerNanjuIpc(ipcMain: IpcMain): void {
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
