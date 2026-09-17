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
  getNanjuProjectDir,
} from './nanju-project'
import type { NanjuAutoClarifyState, NanjuProject } from './nanju-project'
import { recordTelemetry, readTelemetry } from './nanju-telemetry'
import type { ProjectMode } from './nanju-project'
import { startNanjuHtmlWatcher } from './nanju-preview-watcher'
import { listSnapshots } from './nanju-snapshot'
import { createProjectCheckpoint, rollbackProjectSnapshot } from './nanju-project-snapshots'
import { listAgentWorkspaces, createAgentWorkspace } from './agent-workspace-manager'
import { findNanjuProjectBySession, getNanjuPhaseGatePrompt } from './nanju-phase-gate'
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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== v2.4「自动补完需求」（auto-clarify）：渲染/IPC 域契约 =====

/**
 * 代答卡片（渲染端 view model）：GuidePanel 代答卡片展示的最小字段面。
 * 溯源诚实（D7 §5）：渠道+问题要点+答案要点+来源标签+耗时全部来自代理日志原文。
 */
export interface NanjuClarifyAnswerCard {
  qid: string
  /** 来源标签：「子会话提问·代理作答」（L2 blocked 澄清）/「L1 提问·代理作答」（L1 自问） */
  sourceLabel: '子会话提问·代理作答' | 'L1 提问·代理作答'
  /** D8（R7-10）：answer=代答（需求澄清）/ decision=代决（设计偏好）——卡片区分「代决」标签 */
  kind: 'answer' | 'decision'
  channel: string
  /** 问题要点（≤80 字） */
  questionSummary: string
  /** 答案要点（≤120 字） */
  answerSummary: string
  /** 耗时（毫秒）；缺失 = null */
  durationMs: number | null
  /** 完成时间戳（ms）；日志缺失时间戳时为 0 */
  ts: number
  /** 发生阶段；缺失 = null */
  stage: string | null
}

/** _nanju-clarify-log.jsonl 单行的宽松入口类型（代理工具域写入；未知字段容忍） */
interface NanjuClarifyLogEntry {
  kind?: string
  qid?: string
  source?: string
  channel?: string
  question?: string
  answer?: string
  durationMs?: number
  ts?: number
  at?: string
  stage?: string
  /** D8（R7-10）：代答/代决区分的宽字段面（B 域 ClarifyLogLine.clarifyKind 主字段 + 兼容宽面） */
  clarifyKind?: string
  decision?: boolean
  answerKind?: string
  category?: string
}

const CLARIFY_SUBAGENT_SOURCE_TOKENS = new Set(['subagent', 'blocked-event', 'l2'])

/**
 * 代答日志行 → 代答卡片（S 级纯函数，红测锁定数据结构）。
 * 非代答完成行（fallback/缺 qid/坏 JSON）不生成卡片（fallback 走转述提示，不是代答成果）。
 */
export function parseClarifyLogLine(raw: string): NanjuClarifyAnswerCard | null {
  let entry: NanjuClarifyLogEntry
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    entry = parsed as NanjuClarifyLogEntry
  } catch {
    return null
  }
  if (entry.kind !== undefined && entry.kind !== 'proxy-answer' && entry.kind !== 'decision') return null
  if (!entry.qid || typeof entry.qid !== 'string') return null
  if (!entry.answer) return null
  const ts = typeof entry.ts === 'number' ? entry.ts
    : typeof entry.at === 'string' ? Date.parse(entry.at)
    : 0
  // D8 返工二 F3-1（§十）：kind 判定——B 域 ClarifyLogLine 实际字段 clarifyKind（v0.17.99）
  // 为主，B 统一字段名后 kind:'decision' / 旧宽字段兼容一轮；proxy-delegate 行类型已从
  // 判据删除（该行无 answer 字段，入口早退 null——不可达分支清理）。
  const isDecision = entry.clarifyKind === 'decision'
    || entry.kind === 'decision'
    || entry.decision === true
    || entry.answerKind === 'decision'
    || entry.category === 'design-preference'
  return {
    qid: entry.qid,
    sourceLabel: entry.source !== undefined && CLARIFY_SUBAGENT_SOURCE_TOKENS.has(entry.source)
      ? '子会话提问·代理作答'
      : 'L1 提问·代理作答',
    kind: isDecision ? 'decision' : 'answer',
    channel: entry.channel ?? 'unknown',
    questionSummary: (entry.question ?? '').slice(0, 80),
    answerSummary: entry.answer.slice(0, 120),
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
    ts: Number.isFinite(ts) ? ts : 0,
    stage: typeof entry.stage === 'string' ? entry.stage : null,
  }
}

/** 关闭/升级处置计划输入（已按 nanjuProxy 过滤后的委派 id 列表） */
export interface AutoClarifyShutdownPlanInput {
  enabled: boolean
  mode: 'quick' | 'iterative'
  runningProxyDelegationIds: string[]
  pendingQuestionIds: string[]
}

/** 处置计划（D7 §7：in-flight stop + pending 转述 + 字段处置 + 升级归档） */
export interface AutoClarifyShutdownPlan {
  shouldDisable: boolean
  stopDelegationIds: string[]
  relayQuestionIds: string[]
  /** 升级长期型时归档代答日志（渲染端提示「日志已归档」） */
  archiveLog: boolean
  notice: string | null
}

/**
 * 关闭/升级处置计划（S 级纯函数，红测锁定）：
 * - 常规关闭：停 in-flight 代理委派 + pending 问题转述 + 提示文案；
 * - 升级长期型（mode:iterative）：同上 + 归档日志 + 升级提示；
 * - 幂等：enabled=false（已关闭）→ 无动作无提示。
 */
export function planAutoClarifyShutdown(input: AutoClarifyShutdownPlanInput): AutoClarifyShutdownPlan {
  if (!input.enabled) {
    return { shouldDisable: false, stopDelegationIds: [], relayQuestionIds: [], archiveLog: false, notice: null }
  }
  const upgraded = input.mode !== 'quick'
  const base: AutoClarifyShutdownPlan = {
    shouldDisable: true,
    stopDelegationIds: [...input.runningProxyDelegationIds],
    relayQuestionIds: [...input.pendingQuestionIds],
    archiveLog: upgraded,
    notice: null,
  }
  const stopNote = input.runningProxyDelegationIds.length > 0
    ? `已停止 ${input.runningProxyDelegationIds.length} 个进行中的代理会话；`
    : ''
  const relayNote = input.pendingQuestionIds.length > 0
    ? `${input.pendingQuestionIds.length} 个未答问题将转述给你回答；`
    : ''
  base.notice = upgraded
    ? `已升级为长期迭代型，自动补完需求已停用；${stopNote}${relayNote}代答日志已归档（_nanju-clarify-log.archived.jsonl）。`
    : `已关闭自动补完需求；${stopNote}${relayNote}后续问题由子会话直接问你。`
  return base
}

/** 代答事件流载荷（主进程 → 渲染端 webContents.send('nanju:clarify-event')） */
export interface NanjuClarifyEventPayload {
  workspaceSlug: string
  projectId: string
  type: 'proxy-answer' | 'fallback-human' | 'enabled' | 'disabled'
  card?: NanjuClarifyAnswerCard
  ts: number
}

/**
 * 代答事件广播（代理工具域调用入口：代答完成/回退/开关变化时推渲染端）。
 * 主窗口不可用时静默丢弃（渲染端轮询兑底）。
 */
export function broadcastNanjuClarifyEvent(payload: NanjuClarifyEventPayload): void {
  try {
    const { getMainWindow } = require('./main-window-store') as typeof import('./main-window-store')
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('nanju:clarify-event', payload)
  } catch { /* 广播失败不阻断主链（渲染端轮询兑底） */ }
}

/** 项目元数据上的 autoClarify 读取（A 域 NanjuProject.autoClarify；缺失 = 未开启） */
function readAutoClarifyField(project: NanjuProject): NanjuAutoClarifyState | undefined {
  return project.autoClarify
}

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
    /** v2.4：勾选态存入项目创建参数（仅快消型；渲染端 ModeSelectView 复选框） */
    autoClarify?: { enabled: boolean }
  }) => {
    const { autoClarify, ...base } = input
    const project = createNanjuProject(base)
    // #1 project.created（PRD §12.4）：建项目成功即事实——只发射一次（失败路径不经过此处）
    try {
      const { emitProjectCreated } = require('./nanju-quick-telemetry') as typeof import('./nanju-quick-telemetry')
      emitProjectCreated(input.workspaceSlug, project)
    } catch { /* 埋点失败不影响建项目 */ }
    // W-I B-c：init 检查点（项目骨架刚建、尚无产出物）——只在带会话时创建（fork 需要 sessionId）。
    // 失败不得中断项目创建（快照是尽力而为的恢复点，建项目本身是主事实）。
    if (input.sessionId) {
      try {
        await createProjectCheckpoint(
          input.workspaceSlug, project.projectId, input.sessionId, `项目初始化：${project.name}`, 'init',
        )
      } catch (e) {
        console.warn('[南大快照] 初始化检查点创建失败（不影响项目创建）:', e instanceof Error ? e.message : String(e))
      }
    }
    // autoClarify 经 updateNanjuProject 独立写入（spread 合并持久化；proxyBudget 初始 = D7 §4 cap=20）
    if (autoClarify?.enabled) {
      const updated = updateNanjuProject(input.workspaceSlug, project.projectId, {
        autoClarify: { enabled: true, proxyBudget: 20, pendingQuestionIds: [] },
      })
      return updated ?? project
    }
    return project
  })

  ipcMain.handle('nanju:update-project', async (_event, input: {
    workspaceSlug: string
    projectId: string
    updates: Record<string, unknown>
    /** 可选：mode 变更原因（PRD §12.4 #8 要求「触发原因」；缺省记 'mode-update'） */
    modeReason?: string
  }) => {
    // #8 mode.switched（PRD §12.4，I-P4 修正版）：这里才是 quick→iterative 的**真实落库点**
    // （`planAutoClarifyShutdown` 只是「关闭自动补完」处置计划器，不是模式转换事实）。
    // 判定口径：变更前 mode=quick 且本次 updates.mode=iterative，**且**写入真成功才发射；
    // 只认这一个方向（iterative→quick 不允许，不发射）。
    const before = input.updates?.mode !== undefined
      ? getNanjuProject(input.workspaceSlug, input.projectId)
      : null
    const updated = updateNanjuProject(input.workspaceSlug, input.projectId, input.updates)
    if (before && updated && before.mode === 'quick' && updated.mode === 'iterative') {
      try {
        const { emitModeSwitched } = require('./nanju-quick-telemetry') as typeof import('./nanju-quick-telemetry')
        emitModeSwitched(input.workspaceSlug, input.projectId, {
          from: 'quick',
          to: 'iterative',
          reason: typeof input.modeReason === 'string' && input.modeReason.trim() !== '' ? input.modeReason : 'mode-update',
          // 快消阶段的项目状态（升级前的阶段事实，供漏斗分析「升级发生在哪个阶段」）
          quickStageState: String(before.currentStage ?? 'unknown'),
        })
      } catch { /* 埋点失败不影响更新 */ }
    }
    return updated
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

  // v2.4（D7 §8）：移除 nanju:advance-stage 死通道（曾 :132，绕过 §2 推进硬门；
  // preload 已暴露但 renderer 零调用——Defender #20）。阶段推进唯一合法入口 = 推进门。

  // ===== v2.4 自动补完需求（auto-clarify）状态面 =====
  ipcMain.handle('nanju:get-auto-clarify', async (_event, input: {
    workspaceSlug: string
    projectId: string
  }) => {
    const project = getNanjuProject(input.workspaceSlug, input.projectId)
    if (!project) return null
    const auto = readAutoClarifyField(project)
    const effectiveEnabled = project.mode === 'quick' && auto?.enabled === true
    // 代答日志（代理工具域写入 _nanju-clarify-log.jsonl；缺失 = 空卡片列表）
    let answers: NanjuClarifyAnswerCard[] = []
    try {
      const logPath = join(getNanjuProjectDir(input.workspaceSlug, input.projectId), '_nanju-clarify-log.jsonl')
      if (existsSync(logPath)) {
        answers = readFileSync(logPath, 'utf-8')
          .split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
          .map(parseClarifyLogLine)
          .filter((card): card is NanjuClarifyAnswerCard => card !== null)
          .slice(-20)
          .reverse()
      }
    } catch { /* 日志读取失败不阻断（渲染端空列表 + 轮询兑底） */ }
    return {
      enabled: effectiveEnabled,
      mode: project.mode,
      proxyBudget: auto?.proxyBudget ?? null,
      pendingQuestionIds: auto?.pendingQuestionIds ?? [],
      answers,
      disabledReason: project.mode !== 'quick' && auto?.enabled === true ? 'iterative-upgraded' : null,
    }
  })

  ipcMain.handle('nanju:set-auto-clarify', async (_event, input: {
    workspaceSlug: string
    projectId: string
    enabled: boolean
  }) => {
    const project = getNanjuProject(input.workspaceSlug, input.projectId)
    if (!project) return { ok: false, error: '项目不存在' }
    if (input.enabled && project.mode !== 'quick') {
      return { ok: false, error: '仅快消型支持自动补完需求' }
    }
    const auto = readAutoClarifyField(project)
    if (input.enabled) {
      updateNanjuProject(input.workspaceSlug, input.projectId, {
        autoClarify: { enabled: true, proxyBudget: auto?.proxyBudget ?? 20, pendingQuestionIds: auto?.pendingQuestionIds ?? [] },
      })
      broadcastNanjuClarifyEvent({ workspaceSlug: input.workspaceSlug, projectId: input.projectId, type: 'enabled', ts: Date.now() })
      return { ok: true, stopped: 0, relayed: 0, notice: null }
    }
    // 关闭（D7 §7）：in-flight 代理委派 stop + pending 转述 + 字段处置 + 升级归档
    const plan = planAutoClarifyShutdown({
      enabled: auto?.enabled === true,
      mode: project.mode,
      runningProxyDelegationIds: [],
      pendingQuestionIds: auto?.pendingQuestionIds ?? [],
    })
    if (!plan.shouldDisable) return { ok: true, stopped: 0, relayed: 0, notice: null }
    let stopped = 0
    try {
      // 识别 in-flight 代理委派：nanjuProxy meta（B 域字段，接线后生效）+ 标题宽匹配兑底
      const { listRunningDelegationsForParent, forceStopDelegation } =
        require('./agent-collaboration-tools') as typeof import('./agent-collaboration-tools')
      if (project.sessionId) {
        const running = listRunningDelegationsForParent(project.sessionId) as Array<{
          delegationId: string
          title: string
          meta?: { nanjuProxy?: boolean }
        }>
        for (const d of running) {
          const isProxy = d.meta?.nanjuProxy === true || /clarify|澄清代理|auto-clarify/i.test(d.title)
          if (isProxy && forceStopDelegation(project.sessionId, d.delegationId).stopped) stopped += 1
        }
      }
    } catch { /* 委派停止失败不阻断字段处置（代理超时兑底由 watch 域负责） */ }
    if (plan.archiveLog) {
      try {
        const { renameSync } = require('node:fs') as typeof import('node:fs')
        const logPath = join(getNanjuProjectDir(input.workspaceSlug, input.projectId), '_nanju-clarify-log.jsonl')
        if (existsSync(logPath)) renameSync(logPath, logPath.replace(/\.jsonl$/, '.archived.jsonl'))
      } catch { /* 归档失败不阻断 */ }
    }
    updateNanjuProject(input.workspaceSlug, input.projectId, {
      // 字段处置（D7 §7）：enabled=false；待转述问题 id 保留在 pendingQuestionIds，
      // 由推进链（A 域 advance-consumer）按转述语义消费，渲染端 notice 同步告知用户。
      autoClarify: { enabled: false, proxyBudget: auto?.proxyBudget ?? 20, pendingQuestionIds: plan.relayQuestionIds },
    })
    broadcastNanjuClarifyEvent({ workspaceSlug: input.workspaceSlug, projectId: input.projectId, type: 'disabled', ts: Date.now() })
    return { ok: true, stopped, relayed: plan.relayQuestionIds.length, notice: plan.notice }
  })

  // ===== 点选纠错（Click-to-Fix，interaction-spec 交互1）=====
  // 预览 iframe 内用户点击原型元素 → 渲染端 postMessage 捕获 → 此 IPC →
  // 以用户消息形式注入对应南大调度员会话（非 interrupt，排队即可），
  // 调度员按 router-prompt 的对话式设计循环处理（快速选项/修改链）。
  ipcMain.handle('agent:report-click-to-fix', async (_event, input: {
    workspaceSlug: string; sessionId: string; kind: string; id?: string; type?: string; text?: string; action?: string; color?: string
    /** I-P3（B-e）：框选批量点选元素清单（id/type，无文本/坐标） */
    items?: Array<{ id?: string; type?: string }>
  }) => {
    if (!input?.sessionId) return { ok: false, error: 'sessionId 不能为空' }
    // 仅南大项目会话生效（避免普通会话被预览点击骚扰）
    const project = findNanjuProjectBySession(input.workspaceSlug, input.sessionId)
    if (!project) return { ok: false, error: '非南大项目会话，忽略点选' }

    // I-P3（B-e）：框选多元素批量点选——只记事实（#7 click_to_fix，框选桶），不注入会话消息。
    // 为什么单独早退：框选不是「空白点击」，落进下方兜底会生成语义错误的消息；
    // 且批量修改指令由用户在面板上确认后再提交（与单元素点选同一交互纪律）。
    if (input.kind === 'box-select') {
      try {
        const { emitQuickEvent, buildClickToFixPayload } = await import('./nanju-quick-events')
        const batchCount = Array.isArray(input.items) ? input.items.length : 0
        emitQuickEvent(input.workspaceSlug, project.projectId, 'click_to_fix', {
          ...buildClickToFixPayload({ elementType: '框选', hasId: false, applied: false, stage: 'pick-other' }),
          batchCount,
        })
      } catch { /* 埋点失败不影响点选 */ }
      console.log(`[点选纠错] 框选批量点选 ${Array.isArray(input.items) ? input.items.length : 0} 个元素（仅记事实，不注入消息）`)
      return { ok: true }
    }

    // #7 click_to_fix（PRD §12.4，I-P3）：落到本 handler 的点选事实统一在此发射——
    // 元素类型/是否含 id/是否成功/阶段四元组，**不含 id 本身、不含文本、不含坐标**（隐私最小）。
    // 说明：element-click / change-result 在渲染端就地处理、不到达主进程，其埋点由渲染端
    // 经 nanju:record-event 上报（见 useGlobalAgentListeners）；这里覆盖真正到达主进程的
    // panel-action / commit-changes / blank-click / box-select 四类。
    const emitClickToFix = async (
      elementType: string,
      hasId: boolean,
      applied: boolean,
      stage: import('./nanju-quick-events').ClickToFixStage,
    ): Promise<void> => {
      try {
        const mod = await import('./nanju-quick-events')
        mod.emitQuickEvent(input.workspaceSlug, project.projectId, 'click_to_fix', {
          ...mod.buildClickToFixPayload({ elementType, hasId, applied, stage }),
        })
      } catch { /* 埋点失败不影响点选 */ }
    }

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
    // #7 收口发射（此处已确定被受理：kind/label 均已解析）
    {
      const actionStage = input.action === 'color' ? 'pick-color'
        : input.action === 'delete' ? 'pick-delete'
          : input.action === 'move' ? 'pick-move'
            : input.action === 'text' ? 'pick-text'
              : 'pick-other'
      if (input.kind === 'element-click') await emitClickToFix(input.type ?? '', Boolean(input.id), false, 'pick-color')
      else if (input.kind === 'panel-action') await emitClickToFix(input.type ?? '', Boolean(input.id), true, actionStage)
      else if (input.kind === 'commit-changes') await emitClickToFix('多元素', false, true, 'pick-other')
      else if (input.kind === 'blank-click') await emitClickToFix('空白', false, false, 'pick-other')
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
  // W-I B-c：create-snapshot 走三段式检查点（会话快照 + 工程文件快照 + linkFileSnapshot）。
  // 返回值向后兼容：除会话快照字段外额外带 fileSnapshotId（未捕获成功时为 null）。
  ipcMain.handle('nanju:create-snapshot', async (_event, input: {
    workspaceSlug: string; projectId: string; sessionId: string;
    description: string; triggerType?: string;
  }) => {
    const result = await createProjectCheckpoint(
      input.workspaceSlug, input.projectId, input.sessionId, input.description,
      input.triggerType as ProjectSnapshot['triggerType'],
    )
    return { ...result.snapshot, fileSnapshotId: result.fileSnapshotId, checkpointMessage: result.message }
  })

  ipcMain.handle('nanju:list-snapshots', async (_event, input: {
    workspaceSlug: string; projectId: string;
  }) => {
    return listSnapshots(input.workspaceSlug, input.projectId)
  })

  // W-I B-c：回滚 = 会话分支回滚 +（已关联文件快照时）工程文件恢复 + 用户可见结论。
  ipcMain.handle('nanju:rollback-snapshot', async (_event, input: {
    workspaceSlug: string; projectId: string; snapshotId: number;
  }) => {
    const result = await rollbackProjectSnapshot(input.workspaceSlug, input.projectId, input.snapshotId)
    // 兼容旧调用方（原来只返回 ProjectSnapshot|null）：保留原字段并附加恢复结论
    return result.snapshot ? { ...result.snapshot, fileRestore: result.fileRestore, rollbackMessage: result.message } : null
  })

  // ===== 埋点 =====
  ipcMain.handle('nanju:record-event', async (_event, input: {
    workspaceSlug: string
    eventType: TelemetryEventType
    payload?: Record<string, unknown>
    projectId?: string
    /**
     * I-P8（B-e）：渲染端埋点（如 #6 user.undo）手里只有 sessionId——由主进程解析归属项目。
     * 只用于解析 projectId，**不写入事件 payload**（不扩散会话 id）。
     */
    sessionId?: string
  }) => {
    const projectId = input.projectId
      ?? (input.sessionId ? findNanjuProjectBySession(input.workspaceSlug, input.sessionId)?.projectId : undefined)
    return recordTelemetry(input.workspaceSlug, input.eventType, input.payload ?? {}, projectId)
  })

  ipcMain.handle('nanju:read-events', async (_event, input: {
    workspaceSlug: string
    eventType?: TelemetryEventType
  }) => {
    return readTelemetry(input.workspaceSlug, input.eventType)
  })
}
