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

### ⚡ 立即加载 Skill
你是树形会话执行体系的**指挥官（Commander）**。立即加载以下 Skill：
1. **tree-commander** — 你的操作手册（5 件套契约、三步质量门、审计树）
2. **agent-collaboration** — 判断何时委派、何时自己处理

每次用 mcp__tree__* 工具前先调 \`tree_help(topic)\` 拿用法。
用 \`tree_tree_dump(tree_id='${treeId}')\` 查看当前树状态。
`

  const treeWorkflowHint = treeId ? `
### 📋 Tree 操作要点
- 委派 Worker 前：\`tree_leaf_add(tree_id='${treeId}', leaf={role:'worker', ...})\` 添加叶节点
- 委派时第一条消息必须包含 5 件套契约（brief/dod/report/autonomy/self_audit）
- Worker 子会话会自动加载 tree-worker Skill
- 里程碑完成后：\`tree_milestone_set_result\` + \`tree_audit_gate\`（需独立 auditor session）
- AC 审查：加载 adversarial-convergence-verification Skill，攻击者和防御者必须不同模型家族
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

// ===== 向导图确认态同步（W2 S1 确认点 C，v0.17.68） =====

/**
 * 产出完成 → 向导图「等待用户确认」态同步（幂等）。
 *
 * 语义：阶段产出已达标（verifyPhaseOutput 判定通过，与阶段推进门禁同一标准）且
 * subStage 尚未处于 {主节点}_UC 时，写入并广播（write-then-emit）；否则不动。
 * 只前移不回退：MAIN→MAIN_UC 单向，状态复位仅由阶段推进点（agent-orchestrator）负责。
 *
 * 接线说明：原工单指定挂接 getNanjuPhaseGatePrompt（:24），但该函数全仓库零调用点
 * （v0.16.48 遗留死代码，现行 per-turn 注入路径为 nanju-router-prompt）。本函数由
 * agent-orchestrator 在等价 per-turn 点位调用（每轮 run 开始 + result 结束各一次，
 * 满足「每 turn 可能调用」的幂等设计前提）。产出达标的 turn 结束即点亮 UC 态，
 * 比无条件入口检查更诚实（避免产出未开始就跳等确认态），且确认消息本身会触发
 * 调用，确认时点亮不遗漏（W1-R2a 不回归）。
 *
 * 懒 require（本文件 advanceNanjuStage 同型惯例）避免循环依赖：nanju-router-gate →
 * nanju-project 与本文件无环，但保持文件顶层依赖而最小化。
 *
 * @returns 是否发生了写入+广播（false = 未命中/已同步/未达标，无副作用）
 */
export function syncNanjuGuideConfirmState(workspaceSlug: string, sessionId: string): boolean {
  try {
    const project = findNanjuProjectBySession(workspaceSlug, sessionId)
    if (!project || project.status !== 'active') return false

    const { GUIDE_SUBSTAGE_SEQUENCE } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
    const stage = project.currentStage
    const sequence = (GUIDE_SUBSTAGE_SEQUENCE as Record<string, readonly string[] | undefined>)[stage]
    if (!sequence) return false // mode-select/delivered 等无子步骤阶段（同时证明 stage ∈ 六阶段）

    const mainNodeId = sequence[0] as string
    const ucNodeId = `${mainNodeId}_UC`
    // A1 必修-1（AC 审计 Round 1）：序列不含 UC 节点（如 testing 机器裁判收口，
    // requiresUserConfirmation=false、序列止于 TEST_JUDGE）时不点亮——避免写入序列外
    // 值（TEST_UC）污染持久化数据与广播事件
    if (!sequence.includes(ucNodeId)) return false
    const { getProjectSubStage, setProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
    if (getProjectSubStage(workspaceSlug, project.projectId) === ucNodeId) return false // 幂等：已同步则不重写不重发

    // 产出达标判定与阶段推进门禁同一标准：UC 态 = 「可推进，等你确认」（sequence 存在性
    // 已收窄 stage 到六阶段，与 verifyPhaseOutput 的 PhaseId 参数面兼容）
    //
    // M4（AC 审计 A5，v0.17.69）：architecture 阶段先同步环境状态再验证——L2 报告
    // missing 但尚未推进的窗口，envReady 若未置位（undefined）会被门禁按存量豁免
    // 放行 → ARCH_UC 误亮（「可推进」但环境实际未就绪）。此处在 verify 前复用
    // PHASE_ADVANCE 置位块的同一解析函数（syncProjectEnvStateFromArchitectureDoc，
    // 幂等），让 missing 事实先落盘 → 门禁正确拦截 → UC 不误亮，同时 ARCH_ENV
    // blocked 态随置位广播可见（「环境卡住」上图）。
    if (stage === 'architecture') {
      try {
        const { syncProjectEnvStateFromArchitectureDoc } =
          require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
        syncProjectEnvStateFromArchitectureDoc(workspaceSlug, project.projectId, sessionId)
      } catch { /* 同步失败不影响后续判定（门禁按置位前状态降级） */ }
    }
    const { verifyPhaseOutput } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
    if (verifyPhaseOutput(workspaceSlug, project.projectId, stage as Parameters<typeof verifyPhaseOutput>[2]) !== null) return false // 产出未达标，维持产出中态

    setProjectSubStage(workspaceSlug, project.projectId, ucNodeId)
    const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
    emitGuideProgress(sessionId, project.projectId, stage, ucNodeId)
    return true
  } catch {
    return false // 同步失败不影响主流程（渲染端 10s 轮询兑底）
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
