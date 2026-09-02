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
import { getGuideProgressSnapshot } from './nanju-guide-progress'

/** 点选纠错批量提交清单的单条项（宿主 ClickToFixPanel reportItems 的 JSON 形状） */
export interface CtfCommitItem {
  id?: string
  type?: string
  label?: string
  action?: string
  value?: unknown
  /** move 专属：iframe 上报的终态 transform 串（或宿主 absX/absY 回退拼出的 translate） */
  finalTransform?: string
}

/** 点选纠错批量提交的修改明细文本（WO4，v0.17.59 抽纯函数并 export，供测试复用）。
 *  move 三级回退：finalTransform（绝对终值，直接写死，勿与现有样式叠加）→
 *  absX/absY 拼 translate（同语义）→ legacy dx/dy 增量；text 分支补齐 v0.17.58
 *  缺失的值透传（此前 text 值被丢弃，调度员拿不到改后文本）；color/delete/voice 维持 */
export function buildCtfCommitDetail(items: CtfCommitItem[]): string {
  return items.map((it) => {
    const what = `${it.type ?? '元素'}「${it.label || it.id}」（data-ai-id=${it.id}）`
    if (it.action === 'color') return `- ${what}：背景色改为 ${String(it.value)}`
    if (it.action === 'delete') return `- ${what}：删除`
    if (it.action === 'move') {
      if (typeof it.finalTransform === 'string' && it.finalTransform) {
        return `- ${what}：将 transform 设为 ${it.finalTransform}（绝对终值，直接写死，勿与现有样式叠加）`
      }
      const v = it.value as { dx?: number; dy?: number; absX?: number; absY?: number } | undefined
      if (typeof v?.absX === 'number' && typeof v?.absY === 'number') {
        return `- ${what}：将 transform 设为 translate(${Math.round(v.absX)}px, ${Math.round(v.absY)}px)（绝对终值，直接写死，勿与现有样式叠加）`
      }
      return `- ${what}：平移 (${v?.dx ?? 0}px, ${v?.dy ?? 0}px)`
    }
    if (it.action === 'text') return `- ${what}：文字改为「${String(it.value ?? '')}」`
    if (it.action === 'voice') return `- ${what}：用户意见「${String(it.value ?? '')}」`
    return `- ${what}：${it.action}`
  }).join('\n')
}

/** 点选纠错消息防抖：`${sessionId}:${elementId}:${kind}` → 上次注入时间 */
const clickToFixLastSent = new Map<string, number>()
import { loadRoleConfig, loadRoleSequence, createRoleSession, getRoleSequence } from './nanju-orchestrator'
import { getGuideRoute } from './nanju-router'
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
    workspaceSlug: string; sessionId: string; kind: string; id?: string; type?: string; text?: string; action?: string; color?: string
  }) => {
    if (!input?.sessionId) return { ok: false, error: 'sessionId 不能为空' }
    // 仅南大项目会话生效（避免普通会话被预览点击骚扰）
    const project = findNanjuProjectBySession(input.workspaceSlug, input.sessionId)
    if (!project) return { ok: false, error: '非南大项目会话，忽略点选' }

    const { runAgent } = await import('./agent-service')
    const { getChannelById } = await import('./channel-manager')
    const { getMainWindow } = await import('./main-window-store')
    const meta = (await import('./agent-session-manager')).getAgentSessionMeta(input.sessionId)
    if (!meta) return { ok: false, error: '会话不存在' }
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return { ok: false, error: '主窗口不可用' }
    // 面板选项指令（interaction-spec 交互1 快速选项）：直接转化为修改指令消息
    // coding 阶段（P1 Sprint A）点选目标是 08_APP 代码而非 prototype.html，且不回写 PRD
    const isCodingStage = project.currentStage === 'coding'
    const actionLabel = (() => {
      if (input.kind === 'commit-changes') {
        // 待接受清单一次性提交：结构化列出全部即时调整（WO4：明细构建抽 buildCtfCommitDetail 纯函数）
        let detail = ''
        try {
          detail = buildCtfCommitDetail(JSON.parse(input.action ?? '[]') as CtfCommitItem[])
        } catch {
          detail = input.action ?? ''
        }
        return `以下是我在${isCodingStage ? '应用' : '原型'}上即时调整的修改清单（共 ${input.type}），请把这些改动应用到${isCodingStage ? ' 08_APP 的代码文件（入口 08_APP/index.html），不需要同步 PRD' : ' prototype.html 并同步 PRD'}：\n${detail}`
      }
      if (input.kind !== 'panel-action') return null
      const el = `${input.type}「${input.text || input.id}」`
      if (input.action === 'color') return `把元素 ${el}（data-ai-id=${input.id}）的颜色改为 ${input.color}。`
      if (input.action === 'delete') return `删除元素 ${el}（data-ai-id=${input.id}）。`
      return `对元素 ${el}（data-ai-id=${input.id}）执行：${input.action}。`
    })()
    const label2 = input.kind === 'element-click'
      ? `【点选纠错】我点击了${isCodingStage ? '页面' : '原型'}元素：${input.type}「${input.text || input.id}」（data-ai-id=${input.id}）。请给出这个元素的快速修改选项。`
      : input.kind === 'panel-action' && actionLabel
        ? `【点选纠错】${actionLabel}${isCodingStage ? '目标文件是 08_APP/ 下的代码文件（入口 08_APP/index.html），请执行修改。' : '请执行修改并同步 PRD。'}`
        : input.kind === 'commit-changes' && actionLabel
          ? `【点选纠错·批量修改】${actionLabel}`
          : `【点选纠错】我点了${isCodingStage ? '应用' : '原型'}空白处，没有选中可修改元素。`
    // W2c（v0.17.69）：点选批量提交的回归硬规则检测——委派前路由点。意见文本 = commit
    // 明细（含语音意见项）；PRD 缺失时不检测（回归语义不成立）；仅 prototype 阶段
    //（coding 阶段点选不回写 PRD，无回归语义）。命中 → 记回归事件（prototype→requirements）。
    if (input.kind === 'commit-changes' && !isCodingStage) {
      try {
        let detailText = ''
        try {
          detailText = buildCtfCommitDetail(JSON.parse(input.action ?? '[]') as CtfCommitItem[])
        } catch {
          detailText = input.action ?? ''
        }
        const { readFileSync: prdRead, existsSync: prdExists } = await import('node:fs')
        const { join: prdJoin } = await import('node:path')
        const { getNanjuProjectDir } = await import('./nanju-project')
        const prdPath = prdJoin(getNanjuProjectDir(input.workspaceSlug, project.projectId), '01_PRD', 'prd.md')
        if (prdExists(prdPath)) {
          const { detectRegressionSignal, recordRegressionEvent } = await import('./nanju-regression')
          const signal = detectRegressionSignal([detailText], prdRead(prdPath, 'utf-8'))
          if (signal?.regress) {
            recordRegressionEvent(input.workspaceSlug, project.projectId, 'prototype', 'requirements',
              `点选批量修改引入新用户故事 ${signal.matched ?? ''}（硬规则 ${signal.rule}）`,
              { opinion: detailText.slice(0, 500), sessionId: input.sessionId })
          }
        }
      } catch { /* 回归检测失败不影响点选消息注入 */ }
    }
    // 会话可能空闲（等用户意见时是 idle）：queueAgentMessage 要求会话运行中，
    // 点选消息语义等同用户新消息——用 runAgent 开新一轮（带真实 webContents 流式回显）。
    void runAgent(
      {
        sessionId: input.sessionId,
        userMessage: label2,
        channelId: meta.channelId ?? getChannelById('glm-zhipu')?.id ?? 'glm-zhipu',
        modelId: meta.modelId,
        workspaceId: meta.workspaceId,
        permissionModeOverride: meta.permissionMode,
        startedAt: Date.now(),
      },
      win.webContents,
    ).catch((e: unknown) => {
      console.warn(`[点选纠错] 注入失败:`, e instanceof Error ? e.message : String(e))
    })
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

  // ===== 向导图（项目执行流程总图）=====
  // getGuideRoute = getRoute(mode) 透传 + 每 phase 附加 resolveACActors 解析结果；
  // 返回数组含 id='delivered' 哨兵空节点，渲染端负责过滤（PRD 修订 R2/Y3）。
  ipcMain.handle('nanju:get-route', async (_event, mode: ProjectMode) => {
    return getGuideRoute(mode)
  })

  // 向导图阶段内子步骤冷启动快照（W2 S1）：渲染端挂载时拉取作初值再监听事件（seq 合流）；
  // 项目不存在返回 null（渲染端降级为无子步骤态）。
  ipcMain.handle('nanju:get-guide-progress', async (_event, input: { workspaceSlug: string; projectId: string }) => {
    return getGuideProgressSnapshot(input.workspaceSlug, input.projectId)
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
