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
import { listAgentWorkspaces, createAgentWorkspace } from './agent-workspace-manager'
import { findNanjuProjectBySession, advanceNanjuStage, getNanjuPhaseGatePrompt } from './nanju-phase-gate'

/** 点选纠错消息防抖：`${sessionId}:${elementId}:${kind}` → 上次注入时间 */
const clickToFixLastSent = new Map<string, number>()
import { loadRoleConfig, loadRoleSequence, createRoleSession, getRoleSequence } from './nanju-orchestrator'
import type { TelemetryEventType } from './nanju-telemetry'
import type { ProjectSnapshot } from './nanju-snapshot'

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

  // ===== HTML 原型监听 =====
  // 主窗引用由 watcher 内部在事件到达时动态获取（main-window-store），
  // 避免 BrowserWindow.getAllWindows()[0] 取到 quick-task 等辅助窗口导致预览事件发错目标
  ipcMain.handle('nanju:start-html-watcher', async (_event, workspaceSlug: string) => {
    startNanjuHtmlWatcher(workspaceSlug)
    return { ok: true }
  })

  // ===== 南大向导工作区 =====
  ipcMain.handle('nanju:ensure-workspace', async () => {
    // 查找已有的南大工作区
    const workspaces = listAgentWorkspaces()
    const existing = workspaces.find((w) => w.workspaceType === 'nanju')
    if (existing) return existing

    // 创建南大专属工作区
    const ws = createAgentWorkspace({
      name: '南大向导',
      workspaceType: 'nanju',
    })
    return ws
  })

  // ===== 阶段门禁 =====
  ipcMain.handle('nanju:get-project-stage', async (_event, input: { workspaceSlug: string; sessionId: string }) => {
    const project = findNanjuProjectBySession(input.workspaceSlug, input.sessionId)
    return project ? { stage: project.currentStage, project } : null
  })

  ipcMain.handle('nanju:advance-stage', async (_event, input: { workspaceSlug: string; sessionId: string; stage: string }) => {
    advanceNanjuStage(input.workspaceSlug, input.sessionId, input.stage as any)
    return true
  })

  // ===== 点选纠错（Click-to-Fix，interaction-spec 交互1）=====
  // 预览 iframe 内用户点击原型元素 → 渲染端 postMessage 捕获 → 此 IPC →
  // 以用户消息形式注入对应南大调度员会话（非 interrupt，排队即可），
  // 调度员按 router-prompt 的对话式设计循环处理（快速选项/修改链）。
  ipcMain.handle('agent:report-click-to-fix', async (_event, input: {
    workspaceSlug: string; sessionId: string; kind: string; id?: string; type?: string; text?: string
  }) => {
    if (!input?.sessionId) return { ok: false, error: 'sessionId 不能为空' }
    // 仅南大项目会话生效（避免普通会话被预览点击骚扰）
    const project = findNanjuProjectBySession(input.workspaceSlug, input.sessionId)
    if (!project) return { ok: false, error: '非南大项目会话，忽略点选' }

    const { queueAgentMessage } = await import('./agent-service')
    const label = input.kind === 'element-click'
      ? `【点选纠错】我点击了原型元素：${input.type}「${input.text || input.id}」（data-ai-id=${input.id}）。请给出这个元素的快速修改选项。`
      : `【点选纠错】我点了原型空白处，没有选中可修改元素。`
    // 与当前用户消息幂等去重：同一元素 3 秒内重复点击只注入一次（渲染端已重置高亮，但消息防抖在宿主做）
    const dedupeKey = `${input.sessionId}:${input.id ?? 'blank'}:${input.kind}`
    const now = Date.now()
    if (clickToFixLastSent.get(dedupeKey) && now - (clickToFixLastSent.get(dedupeKey) ?? 0) < 3000) {
      return { ok: true, deduped: true }
    }
    clickToFixLastSent.set(dedupeKey, now)
    if (clickToFixLastSent.size > 200) {
      // 简单防膨胀
      const oldest = clickToFixLastSent.keys().next().value
      if (oldest) clickToFixLastSent.delete(oldest)
    }

    await queueAgentMessage(
      { sessionId: input.sessionId, userMessage: label, rawUserMessage: label },
      // webContents 仅用于流式回显；点选消息不需要，传 dummy
      { send: () => {}, isDestroyed: () => false } as unknown as Electron.WebContents,
    )
    console.log(`[点选纠错] 已注入调度员会话 ${input.sessionId}: ${input.id ?? 'blank'}`)
    return { ok: true }
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
