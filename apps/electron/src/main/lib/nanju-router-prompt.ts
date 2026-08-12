/**
 * 南大向导 v2 路由 Prompt 生成
 *
 * 为 L1 调度员生成精简的 systemPrompt 指令。
 *
 * 关键设计（v0.16.69 修正）：
 * - AC 对抗审计由 L2 角色子会话内部驱动（inline subAgent）
 * - 攻击者和防御者必须使用不同模型家族
 * - L1 调度员只负责：委派 → 等待 → 检查文件 → 请求用户确认 → 推进
 * - 预览面板由 Harness 代码自动打开（文件监听 → IPC 通知）
 */

import { findNanjuProjectBySession } from './nanju-router-gate'
import { getPhaseNode, type PhaseId } from './nanju-router'
import { getNanjuProjectDir } from './nanju-project'
import { join } from 'node:path'
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
    return content.slice(0, 500) + (content.length > 500 ? '...(截断)' : '')
  } catch {
    return '无（读取失败）'
  }
}

/** 为 L2 角色生成包含 AC 审计指令的完整任务描述 */
function buildL2TaskWithAC(
  phase: NonNullable<ReturnType<typeof getPhaseNode>>,
  prdSummary: string,
  priorArtifacts: string[],
  projectDir: string,
): string {
  const parts: string[] = [
    '你是' + phase.title + '。' + phase.task,
    '',
  ]

  // 前序上下文
  if (prdSummary !== '无（这是需求阶段）') {
    parts.push('## 前序 PRD 摘要')
    parts.push(prdSummary)
    parts.push('')
  }
  if (priorArtifacts.length > 0) {
    parts.push('## 前序产出文件（请先 Read 后再工作）')
    parts.push(priorArtifacts.join('、'))
    parts.push('')
  }

  // 约束
  parts.push('## 约束')
  parts.push(phase.constraints.join('；'))
  parts.push('')

  // 产出文件
  parts.push('## 产出文件')
  parts.push('请将产出写入：' + projectDir + '/' + phase.outputPath)
  parts.push('')

  // AC 审计指令 — L2 内部驱动
  const attackerCh = phase.acAttackerChannel ?? 'glm-zhipu'
  const attackerModel = phase.acAttackerModel ?? 'glm-5.2'
  const defenderCh = phase.acDefenderChannel ?? 'deepseek'
  const defenderModel = phase.acDefenderModel ?? 'deepseek-v4-pro'

  parts.push('## AC 对抗审计（必须执行）')
  parts.push('完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：')
  parts.push('')
  parts.push('### 步骤')
  parts.push('1. 用 delegate_agent(inline:true, channel=' + attackerCh + ', model=' + attackerModel + ') 创建攻击者，')
  parts.push('   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。')
  parts.push('   审查维度：完整性、正确性、一致性、可执行性、安全性。')
  parts.push('   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。')
  parts.push('2. 用 delegate_agent(inline:true, channel=' + defenderCh + ', model=' + defenderModel + ') 创建防御者，')
  parts.push('   让它对照攻击者的发现，用证据反驳或确认。')
  parts.push('   注意：攻击者和防御者是不同模型家族，不能串通。')
  parts.push('3. 如果发现 red 级问题：修改产出文件 → 重新发起攻击者审查 → 直到无 red 级问题。')
  parts.push('4. 审计通过后，返回产出文件路径和 AC 审计结论摘要。')
  parts.push('')
  parts.push('### 注意')
  parts.push('- 攻击者和防御者必须使用不同的模型家族（' + attackerCh + ' vs ' + defenderCh + '）。')
  parts.push('- 你自己就是作者，不要用自己的模型做审查。')
  parts.push('- 修复循环由你驱动，不需要调度员或用户参与。')

  return parts.join('\n')
}

/**
 * 为 L1 调度员生成当前阶段的 systemPrompt。
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
  const nextPhase = phase.next ?? 'delivered'

  // 构建给 L2 的完整任务（含 AC 审计指令）
  const l2Task = buildL2TaskWithAC(phase, prdSummary, priorArtifacts, projectDir)

  const prompt = [
    '## 🔒 南大向导 — 当前阶段：' + phase.title + '（' + stage + '）',
    '项目名：' + project.name + '（' + (project.mode === 'quick' ? '快消型' : '长期迭代型') + '）',
    '项目目录：' + projectDir,
    '',
    '### 你的唯一职责',
    '你是调度员。当前阶段你需要委派「' + phase.title + '」角色子会话完成工作。',
    '子会话内部会自行完成 AC 对抗审计（异构模型）并修复 red 级问题。',
    '',
    '### 具体操作步骤',
    '1. 用 delegate_agent 委派「' + phase.title + '」子会话：',
    '   - channelId: ' + phase.channel,
    '   - modelId: ' + phase.model,
    '   - allowSubDelegation: true（子会话需要内部创建 inline 审计子 Agent）',
    '   - task: 下方完整任务描述',
    '   --- task 开始 ---',
    l2Task,
    '   --- task 结束 ---',
    '2. 用 wait_for_delegations 等待子会话完成。',
    '   如果返回 status="blocked" + pendingBlockedEvents（子会话有问题要问用户），',
    '   用你自己的 AskUserQuestion 向用户转述，收到回答后用 answer_delegation_question 代答，',
    '   再调 wait_for_delegations 继续等待。',
    '3. 子会话完成后，用 Read 检查产出文件：' + projectDir + '/' + phase.outputPath,
    '   子会话已经内部完成了 AC 审计，产出文件是 AC 通过的版本。',
    '4. 用 AskUserQuestion 请求用户确认产出。',
    '   **重要**：产出文件（PRD .md / 原型 .html）写入后，系统已自动在右侧预览面板展示。',
    '   你在请求确认时提醒用户：「右侧预览面板已展示产出文件，请查看后确认。」',
    '5. 用户确认通过后，输出推进标记：<!-- PHASE_ADVANCE: ' + nextPhase + ' -->',
    '',
    '### 你绝对不能做的',
    '- 自己写代码或文档（系统会拦截 Write/Edit/Bash）',
    '- 自己做 AC 审计（那是子会话的职责）',
    '- 跳过用户确认直接推进',
    '- 同时委派多个阶段的角色',
    '',
    '### 用户指令处理',
    '- 用户说"跳过" → 直接推进到下一阶段',
    '- 用户说"取消" → 终止项目',
    '- 用户说"重做" → 重新委派当前阶段角色',
    '',
    '### 上下文管理',
    '如果上下文接近窗口上限，使用 CompactContext 压缩。',
  ].join('\n')

  return prompt
}
