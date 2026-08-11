/**
 * 南大向导 — 阶段门禁（Phase Gate）
 *
 * 硬编码的流程控制，不依赖 Agent 自觉遵守 AGENTS.md。
 * 在每次 Agent 消息发送前，根据项目的 currentStage 注入对应的角色指令。
 *
 * 流程门禁：
 * requirements → [PRD确认] → prototype → [原型确认] → architecture → planning → coding
 */

import { listNanjuProjects, updateNanjuProject, type NanjuProject, type ProjectStage } from './nanju-project'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'

/** 根据会话 ID 查找关联的南大项目 */
export function findNanjuProjectBySession(workspaceSlug: string, sessionId: string): NanjuProject | undefined {
  const projects = listNanjuProjects(workspaceSlug)
  return projects.find((p) => p.sessionId === sessionId)
}

/** 读取角色 system_prompt */
function readRolePrompt(roleId: string): string | undefined {
  const rolesDir = join(__dirname, '..', '..', 'resources', 'nanju-roles')
  const roleFile = join(rolesDir, `${roleId}.json`)
  if (!existsSync(roleFile)) return undefined
  try {
    const config = JSON.parse(readFileSync(roleFile, 'utf-8'))
    return config.system_prompt
  } catch {
    return undefined
  }
}

/** 阶段 → 角色映射 */
const STAGE_ROLE_MAP: Partial<Record<ProjectStage, string>> = {
  requirements: 'requirement-analyst',
  prototype: 'ux-advisor',
  architecture: 'architect',
  planning: 'engineering-manager',
}

/** 阶段门禁指令 */
const STAGE_GATE_PROMPTS: Record<ProjectStage, string> = {
  'mode-select': '',
  requirements: `

## 🔒 当前阶段：需求分析

你现在是「需求分析师」。严格遵守：
1. 只做需求对话，不写代码、不设计架构
2. 用生活化语言问 3-5 个问题
3. 提供选项卡片（而非填空）
4. 需求收集完毕后，生成精简 PRD
5. PRD 确认前，不要调用 delegate_agent 或任何编码工具

**禁止行为**：写代码、创建项目文件夹、调用 delegate_agent、生成架构文档
**必须完成**：与用户对话确认需求 → 生成 PRD → 等待用户确认`,

  prototype: `

## 🔒 当前阶段：UX 原型设计

需求已确认。你现在必须委派 UX 顾问生成 HTML 原型。

**必须执行**：
1. 使用 delegate_agent 委派 UX 顾问（channelId: glm-zhipu, modelId: glm-5.2）
2. 在 goal 中附带完整 PRD 内容
3. 生成的 HTML 原型会自动在右侧预览
4. 等待用户确认原型后才能进入下一阶段

**禁止行为**：自己直接写 HTML、写代码、跳过 UX 阶段`,

  architecture: `

## 🔒 当前阶段：架构设计

UX 原型已确认。你现在必须委派架构师。

**必须执行**：
1. 使用 delegate_agent 委派架构师（channelId: deepseek, modelId: deepseek-v4-pro）
2. 在 goal 中附带 PRD 和已确认的原型描述
3. 等待架构文档完成后才能进入下一阶段`,

  planning: `

## 🔒 当前阶段：工程规划

架构已确认。你现在必须委派工程经理。

**必须执行**：
1. 使用 delegate_agent 委派工程经理（channelId: deepseek, modelId: deepseek-v4-pro）
2. 确定团队配置和协作流程
3. 等待工程计划完成后才能进入编码阶段`,

  coding: `

## 当前阶段：编码实现

所有前期工作已完成。可以开始编码。`,

  testing: `
## 当前阶段：测试验证`,
  delivered: `
## 项目已交付`,
}

/** 生成阶段门禁指令（附加到 systemPrompt 后） */
export function getNanjuPhaseGatePrompt(workspaceSlug: string, sessionId: string): string | undefined {
  const project = findNanjuProjectBySession(workspaceSlug, sessionId)
  if (!project) return undefined

  const stage = project.currentStage
  const gatePrompt = STAGE_GATE_PROMPTS[stage] ?? ''
  return gatePrompt
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
    const { writeJsonFileAtomic } = require('./safe-file')
    const { getMetaPath } = require('./nanju-project')
    writeJsonFileAtomic(getMetaPath(workspaceSlug), projects)
    console.log(`[南大门禁] 阶段推进: ${sessionId} → ${targetStage}`)
  }
}
