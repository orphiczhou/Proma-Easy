/**
 * 南大向导 v2 路由门禁
 *
 * 替代 nanju-phase-gate.ts 的 checkNanjuPhaseGate。
 * 在 canUseTool 中调用，按阶段限制调度员可用工具。
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { listNanjuProjects, type NanjuProject } from './nanju-project'
import { getPhaseNode, type PhaseId, checkOutputFormat } from './nanju-router'
import { getWorkspaceFilesDir } from './config-paths'

// ===== 工具白名单（修正 Y9：移除 EnterPlanMode/ExitPlanMode） =====

const ACTIVE_PHASE_TOOLS = new Set([
  // collaboration 工具（Pi 运行时带 mcp__collaboration__ 前缀）
  'delegate_agent', 'delegate_agents', 'wait_for_delegations',
  'list_delegations', 'stop_delegation', 'get_delegation_results',
  'answer_delegation_question', 'continue_delegation',
  'mcp__collaboration__delegate_agent', 'mcp__collaboration__delegate_agents',
  'mcp__collaboration__wait_for_delegations', 'mcp__collaboration__list_delegations',
  'mcp__collaboration__stop_delegation', 'mcp__collaboration__get_delegation_results',
  'mcp__collaboration__answer_delegation_question', 'mcp__collaboration__continue_delegation',
  'mcp__collaboration__list_available_agent_models',
  // 只读工具
  'Read', 'LS', 'Glob', 'Grep',
  // 交互工具
  'AskUserQuestion',
  // 预览工具（确认环节调度员主动打开右侧分屏展示产出；v0.16.89 起确认步骤强制调用）
  'open_preview', 'mcp__preview__open_preview',
  // 受管浏览器（v0.17.28 起对话式设计迭代：Observe 获取元素 ref / Screenshot 看原型 / PreviewOpen 打开本地 HTML）
  'BrowserPreviewOpen', 'BrowserObserve', 'BrowserScreenshot', 'BrowserListTabs', 'BrowserNewTab',
])

const PHASE_TOOL_WHITELIST: Record<PhaseId, Set<string>> = {
  requirements: new Set(ACTIVE_PHASE_TOOLS),
  prototype: new Set(ACTIVE_PHASE_TOOLS),
  architecture: new Set(ACTIVE_PHASE_TOOLS),
  planning: new Set(ACTIVE_PHASE_TOOLS),
  coding: new Set(ACTIVE_PHASE_TOOLS),
  // Sprint B：testing 与 coding 同白名单（调度员需要委派/等待/Read/AskUserQuestion/预览）
  testing: new Set(ACTIVE_PHASE_TOOLS),
  delivered: new Set(['Read', 'LS', 'AskUserQuestion']),
}

/**
 * 会话级工具不受 phase-gate 限制（修正 NY3）：
 * CompactContext 是会话元工具，管理会话自身的上下文，不是开发工具。
 */
const GLOBAL_ALLOWED_TOOLS = new Set([
  'CompactContext', 'compact',
])

/**
 * 南大向导路由门禁。
 *
 * 在 canUseTool 中调用，返回 null 表示放行（非南大会话或不限制），
 * 返回 { behavior: 'deny', message } 表示拒绝。
 */
export function checkNanjuRouterGate(
  workspaceSlug: string | undefined,
  sessionId: string,
  toolName: string,
  _input: Record<string, unknown>,
): { behavior: 'deny'; message: string } | null {
  if (!workspaceSlug) return null

  const project = findNanjuProjectBySession(workspaceSlug, sessionId)
  if (!project) return null

  const stage = project.currentStage as PhaseId

  // 全局允许的会话元工具
  if (GLOBAL_ALLOWED_TOOLS.has(toolName)) return null

  // 终态阶段
  if (stage === 'delivered') {
    if (PHASE_TOOL_WHITELIST.delivered.has(toolName)) return null
    return {
      behavior: 'deny',
      message: '🎉 该项目已全部交付完成。\n\n· 想回看产出 → 项目目录 01_PRD / 02_UX_DESIGN / 08_APP（可运行应用入口 08_APP/index.html，右侧文件面板可浏览）\n· 想看测试报告 → 06_TESTS/report.json 与 06_TESTS/features/（验收场景与判定结果）\n· 想做新项目 → 在南大向导首页点「快速做一个工具」/「长期迭代项目」\n\n向导流程已收口。如需继续迭代：可在首页新建项目，或在普通 Agent 会话中继续修改 08_APP 代码。',
    }
  }

  // 活跃阶段
  const whitelist = PHASE_TOOL_WHITELIST[stage] ?? PHASE_TOOL_WHITELIST.delivered
  if (whitelist.has(toolName)) return null

  // 阶段信息
  const phase = getPhaseNode(project.mode, stage)
  const phaseTitle = phase?.title ?? stage

  return {
    behavior: 'deny',
    message:
      `🔒 南大向导门禁：当前处于「${phaseTitle}」阶段。\n` +
      `你是调度员，不能自己写代码或文档。请用 delegate_agent 委派角色子会话完成工作。\n` +
      `允许的工具：委派(delegate_agent)、等待(wait_for_delegations)、读取(Read/LS)、提问(AskUserQuestion)。`,
  }
}

/** 根据会话 ID 查找关联的南大项目 */
export function findNanjuProjectBySession(workspaceSlug: string, sessionId: string): NanjuProject | undefined {
  const projects = listNanjuProjects(workspaceSlug)
  return projects.find((p) => p.sessionId === sessionId)
}

/**
 * 验证阶段产出文件（修正 F6 + Y5）。
 * Harness 代码在 PHASE_COMPLETE 检测后调用。
 *
 * 返回 null 表示验证通过，返回 string 表示错误原因。
 */
export function verifyPhaseOutput(
  workspaceSlug: string,
  projectId: string,
  phaseId: PhaseId,
): string | null {
  const projectDir = join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
  const phase = getPhaseNode(
    listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)?.mode ?? 'iterative',
    phaseId,
  )
  if (!phase || !phase.outputPath) return null

  const filePath = join(projectDir, phase.outputPath)

  if (!existsSync(filePath)) {
    return `产出文件不存在：${phase.outputPath}`
  }

  const stat = statSync(filePath)
  if (stat.size < 100) {
    return `产出文件过小（${stat.size} 字节），内容可能不完整：${phase.outputPath}`
  }

  // 最低格式检查
  const content = readFileSync(filePath, 'utf-8')
  if (!checkOutputFormat(phaseId, content)) {
    return `产出文件格式不符合要求（缺少基本结构）：${phase.outputPath}`
  }

  // 仅 coding：入口 HTML 引用的 08_APP 内相对资源必须存在（多文件产出完整性兜底——
  // 写了 index.html 忘了 js/css 时在推进前拦下）。校验失败时 PHASE_ADVANCE 不推进，
  // 由 orchestrator 向会话注入 assistant 消息做可见化提示（见 agent-orchestrator.ts），
  // 不自动 retry；harness 级 retry 接线属 Sprint B（handlePhaseResult 当前无调用点）。
  // 纯 Harness 代码，符合 v2.3 §9 职责边界。排除带 scheme（http/data/mailto/tel/blob/
  // javascript 等通用形态）、协议相对（//cdn）、锚点（#）与根绝对路径（/，加载失败
  // 由预览自然暴露）；双引号/单引号属性均识别。
  if (phaseId === 'coding') {
    const refs = [...content.matchAll(/(?:src|href)=(?:"(?!https?:|data:|#|\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^"]+)"|'(?!https?:|data:|#|\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^']+)')/g)]
      .map((m) => m[1] ?? m[2] ?? '')
    for (const ref of refs) {
      if (!ref) continue
      // 先剥 hash 再剥 query；剥完为空回退原始串；非法百分号编码降级为原始串不抛
      let refPath: string
      try {
        refPath = decodeURIComponent((ref.split('#')[0] ?? '').split('?')[0] || ref)
      } catch {
        refPath = ref
      }
      if (refPath.startsWith('/')) continue
      const resolved = resolve(dirname(filePath), refPath)
      if (!resolved.startsWith(dirname(filePath) + sep)) {
        return '入口文件引用越出 08_APP 目录：' + ref
      }
      if (!existsSync(resolved)) {
        return `入口文件引用的资源不存在：${ref}`
      }
    }
  }

  return null
}
