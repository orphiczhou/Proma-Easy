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
import {
  buildCategoryGuideLines,
  resolveProjectCategoryForCoding,
  materializeEngineeringTemplate,
} from './nanju-engineering-template'
import type { ProjectCategory, ProjectCategorySource } from './nanju-project'
import { PHASE_TODO_PREFIX } from '@proma/shared'
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
 * 运行时解析 prototype 阶段的 MiniMax-M3 作者渠道（视觉模型；v0.17.63 起 testing 不再走此解析）。
 * 未配置时抛中文错误，提示用户先在设置中配置 minimax 渠道。
 */
export function resolvePrototypeAuthor(): ResolvedChannelModel {
  // 延迟 require：channel-manager 传递依赖 electron 的 shell 模块，
  // 静态导入会破坏测试环境（bun 下 electron 命名导出不存在）；运行期主进程内可用。
  const { listChannels } = require('./channel-manager') as typeof import('./channel-manager')
  const resolved = resolveMinimaxM3Channel(listChannels())
  if (!resolved) {
    throw new Error(
      '未找到可用的 MiniMax 渠道：UX 原型阶段需要 MiniMax-M3 作为作者执行。' +
      '请在「设置 → 渠道」中添加 provider 为 minimax 且包含已启用的 MiniMax-M3 模型的渠道，然后重试。',
    )
  }
  return resolved
}

/**
 * W13：运行时解析 MiniMax-M3 作为 AC 防御者渠道（testing 阶段作者换 glm 系后的异族覆盖）。
 * 与 resolvePrototypeAuthor 同源解析，但未配置时返回 null 而非抛错——防御者是审计角色，
 * 缺失不应阻断整个阶段 prompt 构建：降级用 PhaseNode 字面家族标记 'minimax'
 * （assertACFamilyDiversity 仍按 family-minimax 通过），AC 委派启动会失败并可观测
 * （model-not-found 错误 + fallback 链），人工补配渠道后自然恢复。
 *
 * electron 可用性探测（必须）：测试环境（bun）解析到真实 npm 包时它只导出安装路径
 * 字符串，此时 require channel-manager 会在链接期抛不可捕获的 SyntaxError（named
 * import safeStorage/shell 缺失）并毒化模块——先探测再 require，测试环境安全降级。
 */
export function resolveMinimaxM3Actor(): ResolvedChannelModel | null {
  try {
    const electronModule = require('electron') as unknown
    if (typeof electronModule !== 'object' || electronModule === null) return null
    const { listChannels } = require('./channel-manager') as typeof import('./channel-manager')
    return resolveMinimaxM3Channel(listChannels())
  } catch {
    // 测试环境/解析异常：降级为字面家族标记（不阻断）
    return null
  }
}

/** 读取前序阶段产出文件路径列表 */
function getPriorArtifacts(workspaceSlug: string, projectId: string, currentPhase: PhaseId): string[] {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  const artifacts: string[] = []

  const priorFiles: Partial<Record<PhaseId, string[]>> = {
    prototype: ['01_PRD/prd.md'],
    architecture: ['01_PRD/prd.md', '02_UX_DESIGN/prototype.html'],
    planning: ['01_PRD/prd.md', '03_ARCHITECTURE/architecture.md'],
    // quick 模式下后两个文件不存在，existsSync 自动过滤（零特判）
    coding: ['01_PRD/prd.md', '02_UX_DESIGN/prototype.html', '03_ARCHITECTURE/architecture.md', '05_PROJECT_PLAN/plan.md'],
    // testing：PRD（用户故事清单）+ 原型（交互基准）；实码 08_APP 由 constraints 强制 L2 自读
    testing: ['01_PRD/prd.md', '02_UX_DESIGN/prototype.html'],
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
 * @param categoryInfo 工程品类判定（W3，v0.17.66，仅 coding 阶段消费）：undefined 表示
 *   未传入（测试兼容旧签名）——与 source=default 同样按降级 web-fullstack 处理并注入自检
 * @param acDefenderRuntime W13：AC 防御者运行时解析值（testing 阶段=minimax UUID 渠道）。
 *   提供时覆盖 resolveACActors 解析出的防御者渠道/模型（家族断言用解析后的渠道判定）；
 *   null/缺省 = 用节点解析值（字面家族标记，向后兼容）
 */
export function buildL2TaskWithAC(
  phase: PhaseNode,
  author: { channel: string; model: string },
  prdSummary: string,
  priorArtifacts: string[],
  projectDir: string,
  categoryInfo?: { category: ProjectCategory; source: ProjectCategorySource } | null,
  acDefenderRuntime?: { channel: string; model: string } | null,
): string {
  const isPrototype = phase.id === 'prototype'
  const isCoding = phase.id === 'coding'
  const isTesting = phase.id === 'testing'
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

  // prototype / coding / testing 阶段：前序必读强调（PRD 用户故事与 AC 清单是后续视觉/功能/验收检查的对照基准）
  const needsUserStoryChecklist = isPrototype || isCoding || isTesting
  if (needsUserStoryChecklist) {
    parts.push('## 前序必读：PRD 用户故事清单')
    parts.push('01_PRD/prd.md 包含用户故事与验收标准（AC）清单，是你的必读输入。')
    parts.push('你必须先完整 Read 该文件，把每条用户故事列成对照清单；')
    parts.push(
      '后续的' + (isPrototype ? '原型设计、截图自检、AC 审计' : isTesting ? 'GWT 验收场景生成、步骤映射、AC 审计' : '代码生成、运行自测、AC 审计')
      + '都必须逐条对照该用户故事清单执行，不得遗漏任何一条。',
    )
    if (isCoding) {
      // R1 缓解：原型等大文件由 L2 自主取舍，明确可只读结构与关键交互段
      parts.push('前序文件 02_UX_DESIGN/prototype.html 可能较大：允许只读其结构与关键交互段（导航、核心表单、状态流转），以其为视觉与交互基准即可，不必逐行读完。')
    }
    parts.push('')
  }

  // 工程品类注入（W3，v0.17.66）：仅 coding 阶段——纠正项目形态认知（实证：桌面程序被
  // 误套 HTML 框架）+ 按品类给出工程骨架组织要点 + 验收载体对齐。未判定/未传入时降级
  // web-fullstack 并注入品类自检（第二道防线）。
  if (isCoding) {
    const resolvedCategory = categoryInfo ?? { category: 'web-fullstack' as ProjectCategory, source: 'default' as ProjectCategorySource }
    // 模板已落位（推进钩子复制到 00_ENGINEERING_TEMPLATE/）则引用全文；
    // 未落位（异常/老项目）退化为仅精简要点，不阻断
    const templatePath = join(projectDir, '00_ENGINEERING_TEMPLATE', 'template.md')
    parts.push(...buildCategoryGuideLines({
      category: resolvedCategory.category,
      source: resolvedCategory.source,
      projectDir,
      templatePath: existsSync(templatePath) ? templatePath : null,
    }))
  }

  // 约束
  parts.push('## 约束')
  parts.push(phase.constraints.join('；'))
  parts.push('')

  // 产出文件
  parts.push('## 产出文件')
  parts.push('请将产出写入：' + projectDir + '/' + phase.outputPath)
  parts.push('')

  // testing 阶段：steps.json 机器可执行 schema（双文件契约的机器侧）
  if (isTesting) {
    parts.push('## steps.json 格式规范（机器可执行，Harness 会严格校验并执行）')
    parts.push('每个 ' + projectDir + '/06_TESTS/features/us-XX.feature 配一个同名 us-XX.steps.json，结构如下：')
    parts.push('```json')
    parts.push(JSON.stringify({
      feature: 'us-01',
      scenario: '成功添加一条读书笔记',
      skip: false,
      skipReason: null,
      steps: [
        { kind: 'given', text: '用户在笔记列表页面', op: { type: 'assert-visible', selector: 'data-ai-id=view-note-list' } },
        { kind: 'when', text: '用户输入书名「百年孤独」', op: { type: 'fill', selector: 'data-ai-id=input-title', value: '百年孤独' } },
        { kind: 'when', text: '用户点击「保存」按钮', op: { type: 'click', selector: 'data-ai-id=btn-save' } },
        { kind: 'then', text: '笔记列表中显示「百年孤独」', op: { type: 'assert-text', selector: 'data-ai-id=view-note-list', contains: '百年孤独', timeoutMs: 4000 } },
      ],
    }, null, 2))
    parts.push('```')
    parts.push('op.type 白名单：click / fill / press / wait-selector / assert-text / assert-visible / assert-count。')
    parts.push('· press 的 value 写键名（如 Enter、Escape、Tab）；assert-count 用 count（非负整数）；')
    parts.push('· 复杂状态断言暂不支持自定义脚本：改用 assert-text 轮询读界面呈现的状态文本（如倒计时剩余数值、状态徽标文案）；')
    parts.push('· 断言类默认 timeoutMs=4000（轮询窗口内重试），禁止依赖严格时刻的断言；')
    parts.push('· 无法可靠映射的步骤：op 置 null 且 unmapped:true，场景标 skip:true + skipReason（透明跳过，不臆造）；')
    parts.push('· selector 只允许 data-ai-id=xxx 形态，ID 必须来自实际代码，与 .feature 文字描述一一对应。')
    parts.push('')
  }

  // architecture 阶段（W7，v0.17.69）：环境配置子环节——探测并入架构师委派任务
  // （R1 终裁：执行主体 = 架构师 L2 子会话，不新建第二个子会话）；缺失只报告不安装
  // （U3：用户显式确认后安装，安装指令由 L1 确认后续接委派）；结尾 projectEnv 标记行
  // 由主进程解析置位 envReady（write-then-gate，见 agent-orchestrator）。
  if (phase.id === 'architecture') {
    const isQuick = phase.taskWeight === 'light'
    parts.push('## 环境配置（必须执行，产出验证的一部分）')
    parts.push('按品类对本机工具链逐组件「版本探测 → 记录结果」：')
    parts.push('- web 类：node / npm / bun（--version，秒级）')
    parts.push('- 桌面类：rustc / cargo（Tauri）或 npx electron --version；CLI/后端类：bun / node / python3 及包管理器；移动类：node/bun 与平台工具（如 adb --version）')
    parts.push('- 探测命令幂等（只读版本号，禁止安装/升级/修改任何系统配置）；工具不可用时如实记录「缺失」')
    parts.push('')
    parts.push('探测结果写入架构文档「## 环境配置」节的清单表（列：组件 | 版本 | 用途 | 探测结果 | 备注），')
    parts.push('缺失组件在探测结果列标记「缺失」，并在备注列写建议的安装命令（只写建议，【不执行】）。')
    parts.push('文档结尾必须单独一行输出状态标记（系统按此行拦截未就绪推进）：')
    parts.push('- 全部就绪：`projectEnv: ready`')
    parts.push('- 有缺失：`projectEnv: missing:<组件逗号清单>`（如 projectEnv: missing:rustc,cargo）')
    if (isQuick) {
      parts.push('')
      parts.push('【快消型定位提醒】架构文档保持 30-60 行精简：品类终判 + 技术选型 + 组件清单 + 环境结论四块为主，')
      parts.push('不展开目录树逐文件说明与接口定义（长期演进细节由工程模板承载）。')
    }
    parts.push('')
  }

  // prototype 阶段：截图渲染自检循环（先于 AC 审计，确保视觉闭环）
  if (isPrototype) {
    parts.push('## 截图渲染自检循环（必须执行，先于 AC 审计）')
    parts.push('⏱ 时长预算（硬性，v0.17.64）：整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟；')
    parts.push('   超时应收敛交付当前最优版本（附未解决项说明），而非继续无限迭代。')
    parts.push('每次生成或修改原型 HTML 后，你必须：')
    parts.push('1. 用 chrome-devtools MCP 的 new_page 打开 file://' + projectDir + '/' + phase.outputPath + '（原型绝对路径）。')
    parts.push('2. 用 take_screenshot 获取渲染截图。')
    parts.push('3. 用 read 工具读取该截图（你是视觉模型，必须实际查看渲染结果，不能只看代码推断）。')
    parts.push('4. 对照 PRD 用户故事清单逐条检查：界面覆盖（每条故事都有对应界面）、布局合理性、交互可用性（每个 P0 交互必须实际点击验证：点按钮看反馈、填输入看结果——不允许只看代码就判可交互，必须用 chrome-devtools 实点实测并截图留证）、导航布局合规（场景索引为顶部横向分页窄条且 sticky，核心场景 1280x720 首屏可见，无纵向全屏索引页）、可交互演示达标（原型可真实操作而非静态展示，状态机/演示数据完整，参照闪念Tips 原型标准）。')
    parts.push('5. 发现缺陷 → 修复 HTML → 重新截图检查；连续 2 轮截图检查均无缺陷，才允许进入 AC 对抗审计。')
    parts.push('')
  }

  // AC 审计指令 — L2 内部驱动（P1 分级：显式 ac* 配置 > taskWeight 预设）。
  // W7（v0.17.69）：quick architecture 免 inline AC 攻防（U1 方案 A：四层兑底替代
  // ——L2 产出 + 用户合并确认 + envReady 门禁 + 规则校验层）；DSL 精简链同步不渲染
  // ATK/DEF/GATE（结构忠实：不注入不渲染，图与行为一致）。
  const skipInlineAC = phase.id === 'architecture' && !phase.requiresAC
  const actors = resolveACActors(phase)
  // W13：防御者运行时解析值优先（testing 阶段 minimax UUID 渠道；缺省回退节点解析值）
  if (acDefenderRuntime) {
    actors.defender = { channel: acDefenderRuntime.channel, model: acDefenderRuntime.model }
  }
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

  if (!skipInlineAC) {
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
  parts.push('3. 【审计状态机（严格顺序，不可跳步）】：攻击者 → 防御者裁决 → 若有 red：修复 → 【必须重新委派攻击者复审】→ 再防御者确认 → 仍无 red 才算通过。')
  parts.push('   注意：修复后必须回到步骤 1（重新攻击），不允许「修复后只让防御者确认」就结束——防御者的职责是对攻击发现做裁决，不是代替攻击者复审。无 red 时跳过本步骤。')
  parts.push('   ⏱ 轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮。第 2 轮防御确认后无论 red 是否清零都必须收敛：')
  parts.push('   red 清零 → 审计通过；仍有 red → 停止修复，把未解决 red 整理成「已知问题清单」（逐条：severity/证据/建议）')
  parts.push('   随产出文件一并返回，交调度员内用户裁决。禁止第 3 轮攻击修复。')
  if (isPrototype) {
    parts.push('4. 独立视觉裁决（防作者自证，仅 UX 原型阶段）：攻防通过后，')
    parts.push('   用 delegate_agent(inline:true, channel=' + author.channel + ', model=' + author.model + ') 创建视觉验证者。')
    parts.push('   只给它两样输入：PRD 用户故事清单 + 最新原型截图（先让它用 read 实际查看截图）。')
    parts.push('   要求它仅依据这两样证据输出 red/yellow/green 结论与逐条对照结果，不允许参考你的自述。')
    parts.push('   审查项必含「导航布局合规」：场景索引是否为顶部横向分页窄条（≤48px、sticky 置顶、US-xx 命名）、是否出现纵向全屏索引、核心场景是否首屏可见。')
    parts.push('5. 视觉裁决为 red → 回到「截图渲染自检循环」修复，再重新走攻防与视觉裁决；green/yellow 才算审计通过。')
    parts.push('   ⏱ 视觉裁决 red 回炉 ≤2 次（v0.17.64）：第 2 次回炉后仍 red → 收敛交付，未解决项进「已知问题清单」交用户裁决，不再回炉。')
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
  } else {
    // quick architecture（免 inline AC）：产出后自查清单 + projectEnv 标记行收口
    parts.push('## 产出自查（代替 AC 攻防——快消型轻量兑底）')
    parts.push('写完架构文档后逐项自查（不委派攻击者/防御者）：')
    parts.push('1. 品类终判标记是否在文档显目位置且为六枚举合法值；')
    parts.push('2. 环境清单是否按探测结果如实填写（缺失标记不遗漏）；')
    parts.push('3. 结尾 projectEnv: 标记行是否存在且与清单一致（ready/missing 与探测结果矛盾会导致系统误拦或误放）。')
    parts.push('')
  }

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

  // W10（v0.17.72）：确认待推进提示注入——confirmPendingStage === 当前阶段时在阶段 header
  // 后注入醒目提示。设计决策：不自动推进（推进权在 L1 输出 PHASE_ADVANCE 标记，检查器只
  // 强提示——消除「用干活响应确认」的 prompt 遵从薄弱点，不夺 L1 流程控制权）。
  // 防脏数据：confirmPending ≠ 当前阶段（推进后清除失败的残留）不注入，防误导。
  // W10 修订轮 A3 特判（裁决 20260903 partially-upheld）：testing 是机器判定收口
  // （requiresUserConfirmation=false），用户「继续」的真实语义是触发 GWT 验收测试，
  // 而非 next 同源推导的「立即交付」——标记特判为 testing 重入（触发 GwtRunner），
  // 消除提示与阶段推进机制的语义错配（原设计会引导 L1 输出 delivered 被 GWT 门禁拦后
  // 绕路一轮教育；特判后提示即正确路径）。
  // W12（交付验收后置）：GWT-pass 后语义反转——报告 verdict=pass 时用户确认的真实语义是
  // 「满意交付」（交付门禁已满足），提示目标切 delivered（走 isDeliverFromTesting + 门禁）；
  // 无报告/未通过时维持 A3 语义（testing 重入触发/重跑 GWT）。报告读取失败按未通过处理。
  // W17-AC-M3（A2 提示词缓和）：末句扩「用户同消息修改请求优先」——强命令（立即输出
  // 推进标记/不要重新委派）与用户同消息真实修改请求存在指令对冲（W16 实证 L1 遵从性强，
  // 误推进会级联自动续接烧预算）；缓和为：用户修改/补充请求先完成再推进。
  let confirmHintLines: string[] = []
  try {
    const { getProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
    const pending = getProjectConfirmPending(workspaceSlug, project.projectId)
    if (pending && pending === stage) {
      let hintAdvanceTarget: string = nextPhase
      if (stage === 'testing' && phase.requiresUserConfirmation === false) {
        hintAdvanceTarget = 'testing'
        try {
          const { existsSync: reportExists, readFileSync: reportRead } = require('node:fs') as typeof import('node:fs')
          const reportPath = join(projectDir, '06_TESTS', 'report.json')
          if (reportExists(reportPath)
            && (JSON.parse(reportRead(reportPath, 'utf-8')) as { verdict?: string })?.verdict === 'pass') {
            hintAdvanceTarget = 'delivered'
          }
        } catch { /* 报告读取失败按未通过处理（testing 重入），不阻断提示注入 */ }
      }
      const hintTail = hintAdvanceTarget === 'delivered' ? '完成交付' : '进入下一阶段'
      confirmHintLines = [
        `⏩ 用户已确认本阶段产出（confirmPending=${pending}）。请立即输出推进标记 <!-- PHASE_ADVANCE: ${hintAdvanceTarget} --> ${hintTail}——不要重新委派任务、不要重复产出。若用户消息中还包含修改/补充请求，先完成该请求再推进；仅当你确信产出确需补充时，先向用户说明理由。`,
        '',
      ]
    }
  } catch { /* 读取失败不阻断 prompt 构建（无提示即常态） */ }
  // 新阶段 Todo 强制前缀（向导图进度徽标按此解析；delivered 无新 Todo，PRD 修订 Y5）
  const nextTodoPrefix = nextPhase !== 'delivered' ? PHASE_TODO_PREFIX[nextPhase as Exclude<typeof nextPhase, 'delivered'>] : null

  // prototype 阶段作者 = MiniMax-M3（视觉模型）：渠道 ID 是 UUID，运行时解析。
  // W13：testing 作者换 glm-5.3-flash（字面渠道即可，与 AC 预设防御者同惯例）；
  // testing 的 AC 防御者=minimax 家族覆盖（UUID 渠道），构建 L2 指令时运行时解析
  const authorOverride = phase.id === 'prototype' ? resolvePrototypeAuthor() : null
  const authorChannel = authorOverride?.channelId ?? phase.channel
  const authorModel = authorOverride?.modelId ?? phase.model
  const acDefenderRuntime = phase.acDefenderChannel === 'minimax' ? resolveMinimaxM3Actor() : null
  const acDefenderEndpoint = acDefenderRuntime
    ? { channel: acDefenderRuntime.channelId, model: acDefenderRuntime.modelId }
    : null

  // 工程品类（W3，v0.17.66，仅 coding 消费）：优先读推进钩子写入的判定结果；
  // 读不到（老项目/钩子未触发）时现场从文档提取降级判定，并顺手补写元信息与模板落位
  // （幂等：钩子已处理时此处零开销）
  let categoryInfo: { category: ProjectCategory; source: ProjectCategorySource } | null = null
  if (stage === 'coding') {
    const { getProjectCategory, setProjectCategory } = require('./nanju-project') as typeof import('./nanju-project')
    categoryInfo = getProjectCategory(workspaceSlug, project.projectId)
    if (!categoryInfo) {
      const resolved = resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
      categoryInfo = resolved ?? { category: 'web-fullstack', source: 'default' }
      try {
        setProjectCategory(workspaceSlug, project.projectId, categoryInfo.category, categoryInfo.source)
        materializeEngineeringTemplate(workspaceSlug, project.projectId, categoryInfo.category)
      } catch { /* 补写失败不阻断：注入节已有降级自检兑底 */ }
    }
  }

  // 构建给 L2 的完整任务（含 AC 审计指令；内含家族多样性断言；coding 含品类工程指导）
  const l2Task = buildL2TaskWithAC(phase, { channel: authorChannel, model: authorModel }, prdSummary, priorArtifacts, projectDir, categoryInfo, acDefenderEndpoint)

  // M7（AC 审计 A9-timing，v0.17.69）：主进程预校验——architecture 阶段构建 L1 指令时
  // 现场对 architecture.md 环境清单跑 validateEnvChecklist（§九「清单执行前过确定性规则
  // 校验」的落地：确认安装前拦截幻觉包名/typo，而非等到 PHASE_ADVANCE 门禁才发现）。
  // 校验结论注入 4b：未通过 → L1 不得进入安装确认，先委派架构师修正清单；L2 幻觉包名
  // 在执行安装前被拦下。architecture.md 不存在/无清单时无注入（首轮委派尚未产出）。
  let envPrecheckLines: string[] = []
  if (stage === 'architecture') {
    try {
      const { existsSync: archExists, readFileSync: archRead } = require('node:fs') as typeof import('node:fs')
      const archPath = join(projectDir, '03_ARCHITECTURE', 'architecture.md')
      if (archExists(archPath)) {
        const archContent = archRead(archPath, 'utf-8')
        const {
          resolveProjectCategoryForCoding,
          parseEnvChecklistFromDoc,
          parseProjectEnvMarker,
          validateEnvChecklist,
        } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
        const marker = parseProjectEnvMarker(archContent)
        const checklist = parseEnvChecklistFromDoc(archContent)
        if (marker && checklist.length > 0) {
          const { getProjectCategory } = require('./nanju-project') as typeof import('./nanju-project')
          const resolvedCat = (getProjectCategory(workspaceSlug, project.projectId)
            ?? resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
            ?? { category: 'web-fullstack' as const, source: 'default' as const }).category
          // 校验全清单（不只 missing 组件）：typo/幻觉包名即使标记就绪也要在安装前拦下
          //（与 gate 同一函数同一基准；门禁是第二道，此处是执行前的第一道）
          const validation = validateEnvChecklist(resolvedCat, checklist)
          if (!validation.ok) {
            envPrecheckLines = [
              '   ⛔ 主进程环境清单预校验【未通过】（确认安装前必看）：',
              ...validation.problems.map((p) => `      - ${p}`),
              '      【不得】向用户确认安装、不得委派任何安装命令；先 continue_delegation 委派架构师',
              '      修正环境清单中的组件名（拼写照品类白名单/模板核对），产出修正后重新进入确认流程。',
            ]
          } else {
            envPrecheckLines = [
              '   ✅ 主进程环境清单预校验通过（组件名均合法）——可按 4b 流程向用户确认安装/确认架构。',
            ]
          }
        }
      }
    } catch { /* 预校验失败不阻断 prompt 构建（门禁另有第二道） */ }
  }

  const prompt = [
    '## 🔒 南大向导 — 当前阶段：' + phase.title + '（' + stage + '）',
    ...confirmHintLines,
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
    '2. 用 wait_for_delegations 等待子会话完成（显式传 timeoutSeconds=1200，即 20 分钟）。',
    '   如果返回 status="blocked" + pendingBlockedEvents（子会话有问题要问用户），',
    '   用你自己的 AskUserQuestion 向用户转述，收到回答后用 answer_delegation_question 代答，',
    '   再调 wait_for_delegations 继续等待。',
    '   超时纪律（系统侧另有软/硬超时兑底，这里是你应做的第一步）：',
    '   - wait 超时且子会话仍在 running（超 20 分钟）→ 先用 stop_delegation 终止该子会话，',
    '     再用 continue_delegation 向已停止的子会话追加新指令，或重新 delegate_agent 重派',
    '     （新委派计时从头）；注意 running 中的委派不能直接 continue_delegation（会被拒绝），',
    '     必须先停止再续接；',
    '   - wait 返回 status=cancelled/failed 或收到系统超时通知 → 按系统注入的指引检查产物后处置，',
    '     不要反复无限等待同一个无响应的子会话。',
    '3. 子会话完成后，用 Read 检查产出文件：' + projectDir + '/' + phase.outputPath,
    '   子会话已经内部完成了 AC 审计，产出文件是 AC 通过的版本。',
    ...(stage === 'prototype'
      ? [
        '4. 【对话式设计迭代 + 交互式确认】（原型阶段的核心环节，不是一次问答而是多轮共同设计）：',
        '   a. 【必须】先调用 open_preview（file_path=' + projectDir + '/' + phase.outputPath + '）确保右侧分屏展示原型。',
        '   b. Read ' + projectDir + '/01_PRD/prd.md 提取用户故事（US-xx）清单。',
        '   c. 向用户宣布进入对话式设计环节，邀请直接用自然语言提修改意见，并说明可指代具体元素',
        '      （如「顶部导航太挤」「开始按钮改大」「这个表单去掉」）；',
        '      同时告知：「也可以直接在右侧原型上【点击】想改的元素，点选后元素会出现在输入框，',
        '        你接着打字描述想怎么改（如“改成圆角、红色”），一起发送即可精准修改」。',
        '   c2. 用户消息若携带 <ux-element-ref> 块（点选后打字补充改法）：该块即目标元素',
        '       （id/type/text/prototype 齐全），无需反问指向；把【元素信息+文字描述】合并为',
        '       一条意见进入收集轮；修改指令中引用 data-ai-id 定位。',
        '   c3. 收到【点选纠错·批量修改】消息（开头为「以下是我在原型上即时调整的修改清单」）：',
        '       这是用户已点「接受本轮改动」的收齐清单，【直接】把清单整体转成 continue_delegation',
        '       委派 UX 顾问执行，【不得】再追问「还有其他意见吗」，不得再进收集轮。',
        '      当收到【点选纠错】消息（用户在原型上点击了元素，含 data-ai-id 与类型）：',
        '      - 立即用 AskUserQuestion 弹快速选项（模拟设计规范的快速选项面板）：',
        '        options 固定五项：换个颜色🎨/改文字🖊/换个位置📐/删掉它🗑/其他💬（用户自描述）；',
        '        question 写明「你点击了[元素类型]「[文本摘要]」，想怎么改？」（类型与摘要来自点选消息）。',
        '      - 用户选了预设项或描述后，与文字意见一样进入意见收集轮（见 d，批量改而非立即改）。',
        '   d. 【意见收集轮】（核心节奏：多轮沟通攒一批，再统一修改——【绝不】一条意见就立即改）：',
        '      - 每收到一条用户意见，先记录到你的意见清单（元素定位/意图），并回应确认你的理解；',
        '        涉及需求变更的先按 e 确认范围。',
        '        【回归标记（W2c，v0.17.69）】若用户意见引入 PRD 未有的新需求（硬规则未覆盖的表述——',
        '        如「再加一个导出功能」「支持多人协作」等超出既有 US-xx 清单范围的需求，但不删除既有需求），',
        '        在回应该意见的同一条回复中输出一行标记：<!-- NANJU_REGRESSION: <一句话原因> -->',
        '        （系统检测该标记后会在向导图记录一次「原型→需求」回归；标记只是建议，无需用户操作；',
        '        修改 PRD 的既有条目、删除/撤销需求【不要】输出该标记）',
        '      - 回应后【必须追问】：「这条记下了。还有其他想调整的地方吗？可以继续提，',
        '        都提完我一起改」——除非用户明确说「就这些/开始改吧/没别的了」，否则【禁止】下发修改。',
        '      - 【硬性门禁】收到单条意见后，【不得】立即修改 prototype.html、【不得】立即更新',
        '        prd.md、【不得】下发任何 continue_delegation 修改任务。用户没确认收齐前，',
        '        你的唯一动作是：记录意见 + 确认理解 + 追问是否还有意见。',
        '      - 描述模糊时（「这个」「那个」）：用 BrowserObserve 元素清单向用户确认指向。',
        '      - 用户说收齐了 → 把全部意见整理成【批量修改清单】（每条：元素定位+意图+现状），',
        '        一次 continue_delegation 发给 UX 顾问（修复含截图自检，逐条核对不破坏其他部分）。',
        '      - 修复完成 → 重新 open_preview 展示新版 → 逐条报告改了什么，再次进入意见收集轮。',
        '      - 此循环直到用户对结果表示满意（不再有新意见且说满意/交付）。',
        '   e. 用户意见若涉及需求变更（新增/删除功能、改验收标准）：先与用户确认需求变化，',
        '        用 continue_delegation 要求 UX 顾问同步更新 PRD（01_PRD/prd.md 对应 US 条目），再改原型。',
        '        需求澄清后重新提取用户故事清单。',
        '   e. 用户表示满意后，AskUserQuestion 收口：header「原型交互验证」，multiSelect=true，',
        '      options = 每个用户故事一项（label=US-xx 简短标题，description=验收要点）+「全部通过，交付」。',
        '   f. 全部勾选/选「全部通过」→ 进入第 5 步；有未勾选 → 未通过项回到 d 循环修复后重新收口。',
      ]
      : stage === 'coding'
      ? [
        '4. 【交互验证 + 轻过渡确认】（编码阶段核心环节：预览应用 → 收集意见 → 批量修复 → 确认进入自动测试）：',
        '   a. 【必须】先调用 open_preview（file_path=' + projectDir + '/' + phase.outputPath + '）确保右侧分屏展示可运行应用。',
        '   b. 向用户宣布代码已生成，邀请直接用自然语言提修改意见；同时告知：',
        '      「也可以直接在右侧预览上【点击】想改的元素，点选后元素会出现在输入框，',
        '        你接着打字描述想怎么改（如“这个按钮改大”），一起发送即可精准修改」。',
        '   c. 收到【点选纠错】消息（用户在预览上点击了元素，含 data-ai-id 与类型）：',
        '      - 立即用 AskUserQuestion 弹快速选项：options 固定五项：换个颜色🎨/改文字🖊/换个位置📐/删掉它🗑/其他💬（用户自描述）；',
        '        question 写明「你点击了[元素类型]「[文本摘要]」，想怎么改？」（类型与摘要来自点选消息）。',
        '      - 用户选了预设项或描述后，与文字意见一样进入意见收集轮（见 d，批量改而非立即改）。',
        '   d. 【意见收集轮】（核心节奏：多轮沟通攒一批，再统一修改——【绝不】一条意见就立即改）：',
        '      - 每收到一条用户意见，先记录到你的意见清单（元素定位/意图），并回应确认你的理解；',
        '        涉及需求变更的先与用户确认范围（PRD 不因代码改动回写，但需求变更要先澄清）。',
        '      - 回应后【必须追问】：「这条记下了。还有其他想调整的地方吗？」——除非用户明确说收齐，',
        '        否则【禁止】下发修改任务。',
        '      - 用户说收齐了 → 把全部意见整理成【批量修改清单】（每条：元素定位+意图+现状），',
        '        一次 continue_delegation 发给「全栈开发」子会话执行；修改目标一律是 08_APP/ 下的代码文件，',
        '        【不得】改 02_UX_DESIGN/prototype.html，【不得】回写 01_PRD/prd.md。',
        '      - 收到【点选纠错·批量修改】消息（用户已点「接受本轮改动」的收齐清单）：【直接】把清单',
        '        整体转 continue_delegation 委派全栈开发改 08_APP，【不得】再追问「还有其他意见吗」。',
        '      - 修复完成 → 重新 open_preview 展示新版 → 逐条报告改了什么，再次进入意见收集轮；',
        '      - 此循环直到用户对结果表示满意（不再有新意见且说满意/交付）。',
        '   e. 【轻过渡收口】（W12：用户故事覆盖交还 GWT 机器裁判，coding 收口不再让用户逐条背书故事实现）：',
        '      用户表示满意（或无修改意见直接确认）后，用 AskUserQuestion 弹轻过渡确认：header「预览确认」，',
        '      question「应用已生成（右侧预览）。确认无误我将启动自动测试（GWT 场景验收）——',
        '      用户故事的完整性由自动测试判定，无需人工核对。回复确认即开始测试。」，',
        '      options：确认无误，开始自动测试 / 还有意见要提（回到 d 循环）。',
        '      用户确认 → 进入第 5 步（输出推进标记进入 testing，触发自动测试）；提意见 → d 循环修复后重新收口。',
      ]
      : stage === 'architecture'
      ? [
        '4. 【架构确认 + 环境配置环节】（W7，v0.17.69：架构师环节两模式必经；环境缺失时先收口再确认）：',
        '   a. 子会话完成后，用 Read 检查产出文件：' + projectDir + '/' + phase.outputPath,
        '      确认三要素齐全：品类终判标记（projectCategory:）、「## 环境配置」清单表、结尾 projectEnv: 标记行。',
        '   b. 若结尾标记为 projectEnv: missing:<组件清单>（环境有缺失）：',
        ...envPrecheckLines,
        '      - 先用 AskUserQuestion 向用户确认：「环境缺失 {组件清单}，安装约需 X 分钟（按组件估算，',
        '        如 Rust 工具链约 5-15 分钟，node/bun 秒级），确认安装？」options：确认安装 / 换技术栈 / 暂停；',
        '      - 用户确认安装 → 用 continue_delegation 向架构师子会话追加安装指令：',
        '        【仅安装清单内缺失组件】，限用户级标准安装目录（~/.cargo、~/.local、项目内 node_modules 等，',
        '        不改系统配置/shell rc），逐组件「安装 → 复测 --version」，全部就绪后把文档结尾标记行改为 projectEnv: ready；',
        '      - 用户选换技术栈 → 重新委派架构师按新选型更新架构文档与环境探测；',
        '      - ⚠️ 环境未就绪（仍为 missing）时【不要】输出推进标记——系统会拦截非 web 品类的未就绪推进。',
        '   c. 标记为 ready（或安装后已改 ready）→ 【必须】先 open_preview（file_path=' + projectDir + '/' + phase.outputPath + '）',
        '      展示架构文档，然后用【一条消息】向用户合并确认：架构摘要（品类终判 + 技术选型要点）',
        '      + 环境清单（各组件就绪状态）；AskUserQuestion「确认架构与环境配置？」（quick 与 iterative 同构，',
        '      quick 免 AC 攻防，本次合并确认即最终确认）。',
        '   d. 用户确认通过 → 进入第 5 步；有修改意见 → continue_delegation 转架构师修改后重新确认。',
      ]
      : stage === 'testing'
      ? [
        '4. 【验收测试环节】（测试阶段核心：生成场景 → 系统自动执行 → 按报告处理）：',
        '   a. 子会话完成后，用 Read 检查以下文件已生成：',
        '      - ' + projectDir + '/06_TESTS/features/index.feature（场景汇总入口）',
        '      - ' + projectDir + '/06_TESTS/features/ 下的 us-XX.feature 与同名 us-XX.steps.json（成对）',
        '   b. 向用户简要说明：测试场景已生成，声明推进后系统将自动执行浏览器验收测试',
        '      （在应用内测试标签中运行，每个场景独立重载页面，结果汇总为测试报告）。',
        '   c. 进入第 5 步收口（输出推进标记触发系统执行测试）。',
      ]
      : [
        '4. 【必须】先调用 open_preview 工具（file_path=' + projectDir + '/' + phase.outputPath + '）',
        '   确保右侧分屏正在展示产出文件，然后用 AskUserQuestion 请求用户确认。',
        '   确认时提醒用户：「右侧预览面板已展示产出文件，请查看后确认。」',
      ]),
    ...(stage === 'testing'
      ? [
        '5. 场景生成完成后的收口（场景产出是机器判定，无用户确认环节）：',
        '   【果断收口】双文件核验通过（index/us-XX.feature + 成对 steps.json）后【立即】输出推进标记收口——',
        '   testing 的场景产出推进不等待用户确认（requiresUserConfirmation=false）、不要以「核实/澄清」',
        '   代替推进；除非核验不通过需要修复，否则唯一正确动作就是输出推进标记。',
        '   【先收尾】把本阶段你创建的所有 Todo 用 TaskUpdate 标记 completed，',
        '   再输出推进标记：<!-- PHASE_ADVANCE: testing -->（推进到自身 = 触发 Harness 自动执行 GWT 验收测试）。',
        '   测试结果由系统注入消息告知，按结果三态处理（W12：GWT 通过后的交付验收是唯一用户确认点，故事覆盖仍由机器裁判）：',
        '   - ✅ 全部通过（GWT-pass）：系统续接你发起【交付验收】——用 AskUserQuestion 弹问：',
        '     question「应用已完成并通过自动测试，可以交付使用。你用过了吗？」，',
        '     options：满意交付（可以交付使用）/ 需要调整（说明问题，回炉修复后重新测试）。',
        '     · 用户满意交付（或明确确认交付）→ 【立即】输出 <!-- PHASE_ADVANCE: delivered --> 完成交付',
        '       （交付门禁校验测试报告 verdict=pass 且系统已记录用户满意交付确认已满足——用户经 AskUserQuestion 选择「满意交付」后系统自动登记，直接推进——不要重新委派、不要重复产出、不要再询问）。',
        '     · 用户需要调整（或描述问题）→ 意见收集轮收集修改意见（可引导用户点选右侧预览元素精准定位，',
        '       复用编码阶段 c/d 的收集节奏：逐条确认理解、收齐后统一改），收齐后 continue_delegation',
        '       委派「全栈开发」修复 08_APP/ 下的代码（不动 06_TESTS/ 与 01_PRD/），修复完成后输出',
        '       <!-- PHASE_ADVANCE: testing --> 重跑自动测试（回炉修复与重映射合计 ≤2 次，超限系统转人工）。',
        '   - ❌ 行为类失败（断言不匹配等应用缺陷）：按失败清单 continue_delegation 委派「全栈开发」修复缺陷',
        '     （仅改 08_APP/ 下的代码，不得改 06_TESTS/ 与 01_PRD/），修复完成后重新输出',
        '     <!-- PHASE_ADVANCE: testing --> 重跑测试。',
        '   - 🔁 映射类失败（目标元素等待超时未出现）：continue_delegation 委派「测试工程师」重新映射 steps.json',
        '     （只改 06_TESTS/ 下的映射，不动 08_APP/ 与 01_PRD/），改完重跑；这不是应用缺陷，不要去改代码。',
        '   - 🧭 覆盖类失败（用户故事无可执行场景 / PRD 缺 US-xx 清单）：按注入消息指引委派「测试工程师」补场景，',
        '     或先补 PRD 用户故事清单（需求变更需与用户确认）。',
        '   - ⚠️ 有 skip 场景（主动裁剪）：如需补测，continue_delegation 委派「测试工程师」仅补充被裁剪场景。',
        '   - ⛔ 回炉超过 2 次（映射与修复合计）：系统会通知用户人工介入，等待用户指示。',
        '   项目交付后无需再创建新阶段 Todo。',
      ]
      : [
        '5. 用户确认通过后：【先收尾】把本阶段你创建的所有 Todo 用 TaskUpdate 标记 completed，',
        '   再输出推进标记：<!-- PHASE_ADVANCE: ' + nextPhase + ' -->',
        '   （用户已确认通过后不得再以「再核实/再澄清」推迟推进——立即输出推进标记收口，无追加确认轮。）',
        ...(nextTodoPrefix
          ? [
            '   进入新阶段后立即用 TaskCreate 建立新阶段的 Todo（委派/等待/确认三件套）并随进度维护状态。',
            '   【强制】所有 Todo 标题必须以「' + nextTodoPrefix + '」开头（如「' + nextTodoPrefix + '等待子会话产出」），',
            '   不带此前缀的 Todo 无法计入向导图阶段进度徽标。',
          ]
          : [
            '   项目已交付，无需再创建新阶段 Todo。',
          ]),
      ]),
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
