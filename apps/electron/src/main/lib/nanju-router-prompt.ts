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
import { assertACFamilyDiversity, getPhaseNode, resolveACActors, type PhaseId, type PhaseNode } from './nanju-router'
import { getNanjuProjectDir } from './nanju-project'
import type { Channel } from '@proma/shared'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

// ===== MiniMax 视觉渠道运行时解析（P2：v0.16.87） =====

/** MiniMax-M3 模型匹配（兼容 minimax-m3 / MiniMax-M3 / MiniMax M3 等写法，按 id 或名称匹配） */
const MINIMAX_M3_PATTERN = /minimax[-_\s]?m3/i

/** 已解析的渠道 + 模型 */
export interface ResolvedChannelModel {
  channelId: string
  modelId: string
}

/**
 * 从渠道列表解析包含已启用 MiniMax-M3 模型的 minimax 渠道。
 * minimax 渠道 ID 是 UUID（release 与 dev 环境不同），不能硬编码，必须运行时解析。
 * 返回 null 表示未找到。
 */
export function resolveMinimaxM3Channel(channels: Channel[]): ResolvedChannelModel | null {
  for (const channel of channels) {
    if (!channel.enabled || channel.provider !== 'minimax') continue
    const m3 = channel.models.find(
      (m) => m.enabled && (MINIMAX_M3_PATTERN.test(m.id) || MINIMAX_M3_PATTERN.test(m.name)),
    )
    if (m3) return { channelId: channel.id, modelId: m3.id }
  }
  return null
}

/**
 * 运行时解析 prototype 阶段的 MiniMax-M3 作者渠道（视觉模型）。
 * 未配置时抛中文错误，提示用户先在设置中配置 minimax 渠道。
 */
export function resolvePrototypeAuthor(): ResolvedChannelModel {
  // 延迟 require：channel-manager 传递依赖 electron 的 shell 模块，
  // 静态导入会破坏测试环境（bun 下 electron 命名导出不存在）；运行期主进程内可用。
  const { listChannels } = require('./channel-manager') as typeof import('./channel-manager')
  const resolved = resolveMinimaxM3Channel(listChannels())
  if (!resolved) {
    throw new Error(
      '未找到可用的 MiniMax 渠道：UX 原型阶段需要 MiniMax-M3（视觉模型）作为作者执行截图自检。' +
      '请在「设置 → 渠道」中添加 provider 为 minimax 且包含已启用的 MiniMax-M3 模型的渠道，然后重试。',
    )
  }
  return resolved
}

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

/**
 * 为 L2 角色生成包含 AC 审计指令的完整任务描述。
 *
 * @param author 作者实际委派渠道/模型（prototype 阶段为运行时解析的 minimax 渠道，其余阶段为节点字面值）
 */
export function buildL2TaskWithAC(
  phase: PhaseNode,
  author: { channel: string; model: string },
  prdSummary: string,
  priorArtifacts: string[],
  projectDir: string,
): string {
  const isPrototype = phase.id === 'prototype'
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

  // prototype 阶段：前序必读强调（PRD 用户故事与 AC 清单是后续所有视觉检查的对照基准）
  if (isPrototype) {
    parts.push('## 前序必读：PRD 用户故事清单')
    parts.push('01_PRD/prd.md 包含用户故事与验收标准（AC）清单，是你的必读输入。')
    parts.push('你必须先完整 Read 该文件，把每条用户故事列成对照清单；')
    parts.push('后续的原型设计、截图自检、AC 审计都必须逐条对照该用户故事清单执行，不得遗漏任何一条。')
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

  // prototype 阶段：截图渲染自检循环（先于 AC 审计，确保视觉闭环）
  if (isPrototype) {
    parts.push('## 截图渲染自检循环（必须执行，先于 AC 审计）')
    parts.push('每次生成或修改原型 HTML 后，你必须：')
    parts.push('1. 用 chrome-devtools MCP 的 new_page 打开 file://' + projectDir + '/' + phase.outputPath + '（原型绝对路径）。')
    parts.push('2. 用 take_screenshot 获取渲染截图。')
    parts.push('3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。')
    parts.push('4. 对照 PRD 用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（按钮/导航可点击、流程可达）。')
    parts.push('5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。')
    parts.push('')
  }

  // AC 审计指令 — L2 内部驱动（P1 分级：显式 ac* 配置 > taskWeight 预设）
  const actors = resolveACActors(phase)
  const attackerCh = actors.attacker.channel
  const attackerModel = actors.attacker.model
  const defenderCh = actors.defender.channel
  const defenderModel = actors.defender.model

  // 家族多样性断言：防御者 ≠ 作者家族；攻击者 ≠ 防御者（首次构建期拦截错误配置）
  assertACFamilyDiversity({
    authorChannel: author.channel,
    attackerChannel: attackerCh,
    defenderChannel: defenderCh,
  })

  // prototype 阶段 AC 维度追加「视觉还原度/交互可用性」
  const auditDimensions = isPrototype
    ? '完整性、正确性、一致性、可执行性、安全性、视觉还原度、交互可用性'
    : '完整性、正确性、一致性、可执行性、安全性'

  parts.push('## AC 对抗审计（必须执行）')
  parts.push('完成产出后，你必须进行 AC 对抗审计（自己驱动，不需要人工干预）：')
  parts.push('')
  parts.push('### 步骤')
  parts.push('1. 用 delegate_agent(inline:true, channel=' + attackerCh + ', model=' + attackerModel + ') 创建攻击者，')
  parts.push('   让它严格审查你的产出文件，找出逻辑漏洞、遗漏、不一致、可执行性问题。')
  parts.push('   审查维度：' + auditDimensions + '。')
  parts.push('   攻击者必须给出 red/yellow/green 级别的 finding（带证据）。')
  parts.push('2. 用 delegate_agent(inline:true, channel=' + defenderCh + ', model=' + defenderModel + ') 创建防御者，')
  parts.push('   让它对照攻击者的发现，用证据反驳或确认。')
  parts.push('   注意：攻击者和防御者是不同模型家族，不能串通。')
  parts.push('3. 如果发现 red 级问题：修改产出文件 → 重新发起攻击者审查 → 直到无 red 级问题。')
  if (isPrototype) {
    parts.push('4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，')
    parts.push('   用 delegate_agent(inline:true, channel=' + author.channel + ', model=' + author.model + ') 创建视觉验证者。')
    parts.push('   只给它两样输入：PRD 用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。')
    parts.push('   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。')
    parts.push('5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。')
    parts.push('6. 审计通过后，返回产出文件路径、AC 审计结论摘要与视觉裁决结论。')
  } else {
    parts.push('4. 审计通过后，返回产出文件路径和 AC 审计结论摘要。')
  }
  parts.push('')
  parts.push('### 注意')
  parts.push('- 攻击者和防御者必须使用不同的模型家族（' + attackerCh + ' vs ' + defenderCh + '）。')
  parts.push('- 你自己就是作者，不要不经委派就自己下审计结论。')
  if (isPrototype) {
    parts.push('- 视觉验证者是独立裁决者，只看 PRD 用户故事与最新截图，防止你自证通过。')
  }
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

  // prototype 阶段作者 = MiniMax-M3（视觉模型）：渠道 ID 是 UUID，运行时解析
  const authorOverride = phase.id === 'prototype' ? resolvePrototypeAuthor() : null
  const authorChannel = authorOverride?.channelId ?? phase.channel
  const authorModel = authorOverride?.modelId ?? phase.model

  // 构建给 L2 的完整任务（含 AC 审计指令；内含家族多样性断言）
  const l2Task = buildL2TaskWithAC(phase, { channel: authorChannel, model: authorModel }, prdSummary, priorArtifacts, projectDir)

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
    '   - channelId: ' + authorChannel,
    '   - modelId: ' + authorModel,
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
