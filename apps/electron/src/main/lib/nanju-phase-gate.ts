/**
 * 南大向导 — 阶段门禁（Phase Gate）v2
 *
 * 硬编码的流程控制。每次消息发送前根据 currentStage 注入强制指令。
 * 包含：阶段角色指令、项目目录路径、委派强制、工作流推进标记。
 */

import { listNanjuProjects, type NanjuProject, type ProjectStage } from './nanju-project'
import { join } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'

/** 根据会话 ID 查找关联的南大项目 */
export function findNanjuProjectBySession(workspaceSlug: string, sessionId: string): NanjuProject | undefined {
  const projects = listNanjuProjects(workspaceSlug)
  return projects.find((p) => p.sessionId === sessionId)
}

/** 获取项目目录路径 */
export function getNanjuProjectDir(workspaceSlug: string, projectId: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
}

/** 阶段门禁指令 — 每个阶段都有强制性的行为约束 */
export function getNanjuPhaseGatePrompt(workspaceSlug: string, sessionId: string): string | undefined {
  const project = findNanjuProjectBySession(workspaceSlug, sessionId)
  if (!project) return undefined

  const projectDir = getNanjuProjectDir(workspaceSlug, project.projectId)
  const stage = project.currentStage
  const treeId = project.treeId ?? ''

  const baseHeader = `
## 🔒 南大向导 — 当前阶段：${stage}
项目名：${project.name}（${project.mode === 'quick' ? '快消型' : '长期迭代型'}）
项目目录：${projectDir}
Tree ID：${treeId}
`

  const treeWorkflowHint = treeId ? `
### 📋 Tree 流程管理（使用 mcp__tree__* 工具）
- tree_id: \`${treeId}\`
- 委派角色时，先用 \`tree_leaf_add\` 添加叶节点记录
- 里程碑完成后，用 \`tree_audit_gate\` 设置审计判定（需要独立 auditor session）
- 用 \`tree_tree_dump\` 查看当前树状态
` : ''

  const stagePrompts: Record<ProjectStage, string> = {
    'mode-select': '',

    requirements: baseHeader + treeWorkflowHint + `
### 你是「调度员」。当前处于需求分析阶段。

**你必须遵守**：
1. 你自己与用户对话，挖掘需求（你是调度员，用生活化语言提问）
2. 问 3-5 个引导性问题，提供选项卡片而非填空
3. 收集完需求后，生成 PRD 文件，保存到：\`${projectDir}/01_PRD/prd.md\`
4. 生成 PRD 后，告诉用户"PRD 已生成，请查看右侧预览确认"
5. **绝对禁止**：写代码、创建代码项目、调用 delegate_agent、创建架构文档
6. 用户确认 PRD 后，输出标记 \`[PHASE_COMPLETE:prototype]\` 推进到 UX 阶段
7. 推进前用 \`tree_milestone_set_result\` 标记 m-requirements 里程碑完成

记住：你是调度员，不是程序员。这一步只做需求收集和 PRD。`,

    prototype: baseHeader + treeWorkflowHint + `
### 你是「调度员」。需求已确认，当前处于 UX 原型设计阶段。

**你必须遵守**：
1. **立即使用 delegate_agent 委派 UX 顾问子会话**，不要自己写 HTML
2. 委派前用 \`tree_leaf_add\` 添加 UX 顾问叶节点（role: worker, session_id 用委派返回值）
3. 委派参数：
   - title: "UX原型设计"
   - goal: 附带完整 PRD 内容，要求生成可交互 HTML 原型
   - channelId: "glm-zhipu"
   - modelId: "glm-5.2"
4. 委派的 UX 顾问应将 HTML 文件保存到：\`${projectDir}/02_UX_DESIGN/prototype.html\`
5. 等待委派完成（使用 wait_for_delegations）
6. 原型生成后，引导用户预览确认
7. 用户确认后，用 \`tree_milestone_set_result\` 标记 m-prototype 完成
8. 输出标记 \`[PHASE_COMPLETE:architecture]\`（快消型则 \`[PHASE_COMPLETE:delivered]\`）

**绝对禁止**：自己直接写 HTML 或代码`,

    architecture: baseHeader + treeWorkflowHint + `
### 你是「调度员」。UX 原型已确认，当前处于架构设计阶段。

**你必须遵守**：
1. 使用 delegate_agent 委派架构师子会话
2. 委派前用 \`tree_leaf_add\` 添加架构师叶节点
3. 委派参数：
   - title: "架构设计"
   - goal: 附带 PRD 和原型描述，要求生成架构文档
   - channelId: "deepseek"
   - modelId: "deepseek-v4-pro"
4. 架构文档保存到：\`${projectDir}/03_ARCHITECTURE/architecture.md\`
5. 等待委派完成
6. 用户确认后，用 \`tree_milestone_set_result\` 标记 m-architecture 完成
7. 输出 \`[PHASE_COMPLETE:planning]\``,

    planning: baseHeader + treeWorkflowHint + `
### 你是「调度员」。架构已确认，当前处于工程规划阶段。

**你必须遵守**：
1. 使用 delegate_agent 委派工程经理子会话
2. 委派前用 \`tree_leaf_add\` 添加工程经理叶节点
3. 委派参数：
   - title: "工程规划"
   - goal: 附带 PRD 和架构，确定技术栈和开发计划
   - channelId: "deepseek"
   - modelId: "deepseek-v4-pro"
4. 工程计划保存到：\`${projectDir}/05_PROJECT_PLAN/plan.md\`
5. 用户确认后，用 \`tree_milestone_set_result\` 标记 m-planning 完成
6. 输出 \`[PHASE_COMPLETE:coding]\``,

    coding: baseHeader + `
### 当前阶段：编码实现。

所有前期工作已完成（PRD → UX → 架构 → 工程计划）。
现在可以开始编码实现。使用委派的编码 Agent 或自己编码。`,

    testing: baseHeader + '\n### 当前阶段：测试验证',
    delivered: baseHeader + '\n### 项目已交付',
  }

  return stagePrompts[stage] ?? ''
}

/** 推进项目阶段 */
export function advanceNanjuStage(
  workspaceSlug: string,
  sessionId: string,
  targetStage: ProjectStage,
): void {
  const projects = listNanjuProjects(workspaceSlug)
  const project = projects.find((p) => p.sessionId === sessionId)
  if (project) {
    project.currentStage = targetStage
    project.updatedAt = new Date().toISOString()
    // Use require to avoid circular dependency
    const { writeJsonFileAtomic } = require('./safe-file')
    const metaPath = join(getWorkspaceFilesDir(workspaceSlug), '_nanju-projects.json')
    writeJsonFileAtomic(metaPath, projects)
    console.log(`[南大门禁] 阶段推进: ${project.name} → ${targetStage}`)
  }
}

// ===== 硬门禁：canUseTool 阶段工具过滤 =====

/** 只读工具白名单（所有阶段都允许） */
const READ_ONLY_TOOLS = new Set([
  'Read', 'LS', 'Glob', 'Grep', 'find',
])

/** 委派/会话/tree 工具（所有阶段都允许） */
const DELEGATION_TOOLS = new Set([
  'delegate_agent', 'delegate_agents', 'wait_for_delegations',
  'list_delegations', 'stop_delegation',
])

/**
 * 判断工具是否以指定前缀开头（用于 mcp__tree__*, mcp__session__* 等）
 */
function hasPrefix(toolName: string, prefix: string): boolean {
  return toolName.startsWith(prefix)
}

/**
 * 南大向导阶段硬门禁。
 *
 * 在 canUseTool 中调用，返回 null 表示放行（不是 nanju 会话或不限制），
 * 返回 { behavior: 'deny', message } 表示拒绝。
 *
 * 核心逻辑：
 * - requirements 阶段：禁止写代码/建项目，只允许对话、委派需求分析师、tree 工具、写 PRD(.md)
 * - prototype 阶段：只允许通过 delegate_agent 委派 UX 顾问写 HTML，禁止自己 Write .html
 * - architecture/planning 阶段：只允许委派，禁止自己写代码
 * - coding 阶段：全部放行
 */
export function checkNanjuPhaseGate(
  workspaceSlug: string | undefined,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'deny'; message: string } | null {
  if (!workspaceSlug) return null

  const project = findNanjuProjectBySession(workspaceSlug, sessionId)
  if (!project) return null

  const stage = project.currentStage

  // coding/testing/delivered 阶段：全部放行
  if (stage === 'coding' || stage === 'testing' || stage === 'delivered' || stage === 'mode-select') {
    return null
  }

  // 所有阶段都允许的工具
  if (READ_ONLY_TOOLS.has(toolName)) return null
  if (DELEGATION_TOOLS.has(toolName)) return null
  if (hasPrefix(toolName, 'mcp__tree__')) return null
  if (hasPrefix(toolName, 'mcp__session__')) return null
  if (hasPrefix(toolName, 'mcp__remote-session__')) return null

  // AskUserQuestion / ExitPlanMode 等交互工具放行
  if (toolName === 'AskUserQuestion' || toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return null

  const projectDir = getNanjuProjectDir(workspaceSlug, project.projectId)

  // requirements 阶段
  if (stage === 'requirements') {
    // 允许写 .md 文件（PRD）
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath.toLowerCase().endsWith('.md')) return null
    }
    // 允许只读 Bash
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      // 只允许 ls/cat/mkdir 等只读或创建目录操作
      if (/^(ls|cat|mkdir|pwd|echo)/i.test(cmd.trim())) return null
    }
    // 其他全部拒绝
    return {
      behavior: 'deny',
      message:
        `🔒 南大向导门禁：当前处于「需求分析」阶段。
` +
        `该阶段只允许：
` +
        `1. 与用户对话收集需求
` +
        `2. 使用 delegate_agent 委派「需求分析师」子会话
` +
        `3. 使用 mcp__tree__* 管理流程
` +
        `4. 写 PRD 文档（.md 文件到 ${projectDir}/01_PRD/）

` +
        `禁止：写代码、创建代码项目、写 .html/.js/.ts/.py 等非文档文件。
` +
        `用户确认 PRD 后，输出 [PHASE_COMPLETE:prototype] 推进到下一阶段。`,
    }
  }

  // prototype 阶段
  if (stage === 'prototype') {
    // 允许写 .md 和 .html 文件（UX 原型）
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath.toLowerCase().endsWith('.md') || filePath.toLowerCase().endsWith('.html')) return null
    }
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (/^(ls|cat|mkdir|pwd|echo)/i.test(cmd.trim())) return null
    }
    return {
      behavior: 'deny',
      message:
        `🔒 南大向导门禁：当前处于「UX 原型设计」阶段。
` +
        `该阶段只允许：
` +
        `1. 使用 delegate_agent 委派「UX 顾问」子会话（channelId: glm-zhipu, modelId: glm-5.2）
` +
        `2. 使用 mcp__tree__* 管理流程
` +
        `3. 写 HTML 原型文件（到 ${projectDir}/02_UX_DESIGN/）

` +
        `禁止：写代码、写 .js/.ts/.py 等。
` +
        `用户确认原型后，输出 [PHASE_COMPLETE:architecture] 推进（快消型输出 [PHASE_COMPLETE:delivered]）。`,
    }
  }

  // architecture / planning 阶段
  if (stage === 'architecture' || stage === 'planning') {
    // 允许写 .md 文件（架构/计划文档）
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = typeof input.file_path === 'string' ? input.file_path : ''
      if (filePath.toLowerCase().endsWith('.md')) return null
    }
    if (toolName === 'Bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (/^(ls|cat|mkdir|pwd|echo)/i.test(cmd.trim())) return null
    }
    const phaseLabel = stage === 'architecture' ? '架构设计' : '工程规划'
    const nextStage = stage === 'architecture' ? 'planning' : 'coding'
    return {
      behavior: 'deny',
      message:
        `🔒 南大向导门禁：当前处于「${phaseLabel}」阶段。
` +
        `该阶段只允许：
` +
        `1. 使用 delegate_agent 委派「${stage === 'architecture' ? '架构师' : '工程经理'}」子会话
` +
        `2. 使用 mcp__tree__* 管理流程
` +
        `3. 写 ${stage === 'architecture' ? '架构' : '工程计划'}文档（.md 文件）

` +
        `禁止：写代码、写 .js/.ts/.py 等。
` +
        `用户确认后，输出 [PHASE_COMPLETE:${nextStage}] 推进。`,
    }
  }

  return null
}
