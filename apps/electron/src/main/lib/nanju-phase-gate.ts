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

  const baseHeader = `
## 🔒 南大向导 — 当前阶段：${stage}
项目名：${project.name}（${project.mode === 'quick' ? '快消型' : '长期迭代型'}）
项目目录：${projectDir}
`

  const stagePrompts: Record<ProjectStage, string> = {
    'mode-select': '',

    requirements: baseHeader + `
### 你是「调度员」。当前处于需求分析阶段。

**你必须遵守**：
1. 你自己与用户对话，挖掘需求（你是调度员，用生活化语言提问）
2. 问 3-5 个引导性问题，提供选项卡片而非填空
3. 收集完需求后，生成 PRD 文件，保存到：\`${projectDir}/01_PRD/prd.md\`
4. 生成 PRD 后，告诉用户"PRD 已生成，请查看右侧预览确认"
5. **绝对禁止**：写代码、创建代码项目、调用 delegate_agent、创建架构文档
6. 用户确认 PRD 后，输出标记 \`[PHASE_COMPLETE:prototype]\` 推进到 UX 阶段

记住：你是调度员，不是程序员。这一步只做需求收集和 PRD。`,

    prototype: baseHeader + `
### 你是「调度员」。需求已确认，当前处于 UX 原型设计阶段。

**你必须遵守**：
1. **立即使用 delegate_agent 委派 UX 顾问子会话**，不要自己写 HTML
2. 委派参数：
   - title: "UX原型设计"
   - goal: 附带完整 PRD 内容，要求生成可交互 HTML 原型
   - channelId: "glm-zhipu"
   - modelId: "glm-5.2"
3. 委派的 UX 顾问应将 HTML 文件保存到：\`${projectDir}/02_UX_DESIGN/prototype.html\`
4. 等待委派完成（使用 wait_for_delegations）
5. 原型生成后，引导用户预览确认
6. 用户确认后，输出标记 \`[PHASE_COMPLETE:architecture]\`（快消型则 \`[PHASE_COMPLETE:delivered]\`）

**绝对禁止**：自己直接写 HTML 或代码`,

    architecture: baseHeader + `
### 你是「调度员」。UX 原型已确认，当前处于架构设计阶段。

**你必须遵守**：
1. 使用 delegate_agent 委派架构师子会话
2. 委派参数：
   - title: "架构设计"
   - goal: 附带 PRD 和原型描述，要求生成架构文档
   - channelId: "deepseek"
   - modelId: "deepseek-v4-pro"
3. 架构文档保存到：\`${projectDir}/03_ARCHITECTURE/architecture.md\`
4. 等待委派完成
5. 用户确认后，输出 \`[PHASE_COMPLETE:planning]\``,

    planning: baseHeader + `
### 你是「调度员」。架构已确认，当前处于工程规划阶段。

**你必须遵守**：
1. 使用 delegate_agent 委派工程经理子会话
2. 委派参数：
   - title: "工程规划"
   - goal: 附带 PRD 和架构，确定技术栈和开发计划
   - channelId: "deepseek"
   - modelId: "deepseek-v4-pro"
3. 工程计划保存到：\`${projectDir}/05_PROJECT_PLAN/plan.md\`
4. 用户确认后，输出 \`[PHASE_COMPLETE:coding]\``,

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
