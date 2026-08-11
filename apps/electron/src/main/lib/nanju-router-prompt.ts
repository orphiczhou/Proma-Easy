/**
 * 南大向导 v2 路由 Prompt 生成
 *
 * 替代 nanju-phase-gate.ts 的 getNanjuPhaseGatePrompt。
 * 为 L1 调度员生成精简的 systemPrompt 指令。
 */

import { findNanjuProjectBySession } from './nanju-router-gate'
import { getPhaseNode, type PhaseId } from './nanju-router'
import { getNanjuProjectDir } from './nanju-project'
import { join } from 'node:path'
import { getWorkspaceFilesDir } from './config-paths'
import { existsSync, readFileSync } from 'node:fs'

/** 读取前序阶段产出文件路径列表 */
function getPriorArtifacts(workspaceSlug: string, projectId: string, currentPhase: PhaseId): string[] {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  const artifacts: string[] = []

  const priorFiles: Partial<Record<PhaseId, string[]>> = {
    prototype: ['01_PRD/prd.md'],
    architecture: ['01_PRD/prd.md', '02_UX_DESIGN/prototype.html'],
    planning: ['01_PRD/prd.md', '03_ARCHITECTURE/architecture.md'],
  }

  const files = priorFiles[currentPhase] ?? []
  for (const f of files) {
    const fullPath = join(projectDir, f)
    if (existsSync(fullPath)) {
      artifacts.push(fullPath)
    }
  }
  return artifacts
}

/** 读取 PRD 摘要（前 500 字） */
function getPrdSummary(workspaceSlug: string, projectId: string): string {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  const prdPath = join(projectDir, '01_PRD/prd.md')
  if (!existsSync(prdPath)) return '无（这是需求阶段）'
  try {
    const content = readFileSync(prdPath, 'utf-8')
    return content.slice(0, 500) + (content.length > 500 ? '\n...(截断)' : '')
  } catch {
    return '无（读取失败）'
  }
}

/**
 * 为 L1 调度员生成当前阶段的 systemPrompt。
 *
 * 这是注入到 agent-orchestrator.ts 的 systemPromptAppend 中的指令。
 * 精简、明确、无歧义。
 */
export function getNanjuRouterPrompt(workspaceSlug: string, sessionId: string): string | undefined {
  const project = findNanjuProjectBySession(workspaceSlug, sessionId)
  if (!project) return undefined

  const stage = project.currentStage as PhaseId
  const phase = getPhaseNode(project.mode, stage)
  if (!phase || stage === 'delivered') return undefined

  const projectDir = getNanjuProjectDir(workspaceSlug, project.projectId)
  const prdSummary = getPrdSummary(workspaceSlug, project.projectId)
  const priorArtifacts = getPriorArtifacts(workspaceSlug, project.projectId, stage)

  return `
## 🔒 南大向导 — 当前阶段：${phase.title}（${stage}）
项目名：${project.name}（${project.mode === 'quick' ? '快消型' : '长期迭代型'}）
项目目录：${projectDir}

### 你的唯一职责
你是调度员。当前阶段你需要委派「${phase.title}」角色子会话完成工作。

### 具体操作步骤
1. 用 \`delegate_agent\` 委派「${phase.title}」子会话：
   - channelId: \`${phase.channel}\`
   - modelId: \`${phase.model}\`
   - task: 你是${phase.title}。${phase.task}
     PRD 摘要：${prdSummary}
     前序产出文件（请先 Read 后再工作）：${priorArtifacts.join('、') || '无（这是需求阶段）'}
     约束：${phase.constraints.join('；')}
     产出文件请写入：${projectDir}/${phase.outputPath}
2. 用 \`wait_for_delegations\` 等待子会话完成
3. 用 \`Read\` 检查产出文件是否存在：${projectDir}/${phase.outputPath}
${phase.requiresAC ? `4. 用 \`delegate_agent(inline:true)\` 发起 AC 审计（攻击者=deepseek, 防御者=glm-zhipu）
5. 在回复中用结构化标记输出 AC 结果：
   \<!-- AC_RESULT: {\"verdict\":\"pass\"或\"required\",\"summary\":\"一句话结论\"} --\>
6. 用 \`AskUserQuestion\` 请求用户确认
7. 用户确认通过后，输出推进标记：\`<!-- PHASE_ADVANCE: ${phase.next ?? 'delivered'} -->\`` : `4. 用 \`AskUserQuestion\` 请求用户确认
5. 用户确认通过后，输出推进标记：\`<!-- PHASE_ADVANCE: ${phase.next ?? 'delivered'} -->\``}

### 你绝对不能做的
- 自己写代码或文档（系统会拦截 Write/Edit/Bash）
- 跳过用户确认直接推进
- 同时委派多个阶段的角色

### 用户指令处理
- 用户说"跳过" → 直接推进到下一阶段
- 用户说"取消" → 终止项目
- 用户说"重做" → 重新委派当前阶段角色

### 上下文管理
如果上下文接近窗口上限，使用 CompactContext 压缩。
`
}
