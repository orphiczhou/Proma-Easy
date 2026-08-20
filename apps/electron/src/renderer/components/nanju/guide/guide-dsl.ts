/**
 * 南大向导「向导图」DSL 生成器 + Todo 前缀解析 + 进度派生（纯函数，无 React / electron 依赖）
 *
 * 设计原则（PRD §3.1）：
 * - 节点 id 稳定且语义化（REQ/PROTO/ARCH/PLAN + *_ATK/*_DEF/*_UC…），作为 SVG 后处理交互锚点
 * - 结构忠实于 nanju-router.ts 实际行为，不做艺术加工；DSL 与 nanju-router 序列不一致 = bug（以代码为准）
 * - 进度以 class 行注入（st-done/st-current/st-pending + st-sub-done），classDef 明暗两套
 *
 * 修订记录落实：
 * - Y2：ARCH 的 AC red 硬门禁为 ARCH_DEF 独立出口边（ARCH_GATE），非确认节点标签
 * - Y5：Todo 前缀「XX阶段：」由 @proma/shared PHASE_TODO_PREFIX 单一真相源
 * - Y6：abandoned → 整图灰态、无进行中动画
 */

import type { GuideRoutePhase } from '@proma/shared'
import { PHASE_TODO_PREFIX } from '@proma/shared'

// ===== 类型 =====

export type GuideMode = 'quick' | 'iterative'
export type StageViewStatus = 'done' | 'current' | 'pending'
/** 除 delivered 终点外的四个可执行阶段 */
export type GuidePhaseId = 'requirements' | 'prototype' | 'architecture' | 'planning'

/** 阶段主节点 id（SVG 交互锚点，稳定不变） */
export const GUIDE_MAIN_NODE_ID: Record<GuidePhaseId, string> = {
  requirements: 'REQ',
  prototype: 'PROTO',
  architecture: 'ARCH',
  planning: 'PLAN',
}

/** Todo 完成度徽标数据 */
export interface GuideTodoStat {
  done: number
  total: number
}

/** 进度输入（null = 对照模式：纯静态、无进度叠加） */
export interface GuideProgress {
  stageStates: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>>
  todoStats?: Partial<Record<GuidePhaseId, GuideTodoStat>>
  /** 项目已放弃：整图灰态、无动画（修订 Y6） */
  abandoned?: boolean
}

export interface BuildGuideDslInput {
  mode: GuideMode
  /** nanju:get-route 返回值；函数内部过滤 id==='delivered' 哨兵（修订 Y3） */
  route: GuideRoutePhase[]
  /** null 时输出无进度叠加的静态结构（模式对照查看用，PRD §5.5） */
  progress: GuideProgress | null
  isDark: boolean
}

/** SVG 节点 id → 阶段归属或特殊节点 */
export type GuideNodeTarget = GuidePhaseId | 'user' | 'mode' | 'done'

/** 节点 id 前缀 → 阶段（供 GuideFlow 后处理绑定交互） */
const NODE_ID_TARGETS: Array<{ prefix: string; target: GuideNodeTarget }> = [
  { prefix: 'REQ', target: 'requirements' },
  { prefix: 'PROTO', target: 'prototype' },
  { prefix: 'ARCH', target: 'architecture' },
  { prefix: 'PLAN', target: 'planning' },
  { prefix: 'USER', target: 'user' },
  { prefix: 'MODE', target: 'mode' },
  { prefix: 'DONE', target: 'done' },
]

/** 解析 mermaid 节点 id（REQ / REQ_ATK / flowchart-REQ-0 等）到阶段或特殊节点；未知返回 null */
export function resolveGuideNodeTarget(nodeId: string): GuideNodeTarget | null {
  const bare = nodeId.replace(/^flowchart-/, '').replace(/-\d+$/, '')
  const hit = NODE_ID_TARGETS.find(({ prefix }) => bare === prefix || bare.startsWith(prefix + '_'))
  return hit?.target ?? null
}

// ===== Todo 前缀解析（PRD §4.2 + 修订 Y5） =====

/** 宽松关键词（兼容「XX阶段：」强制前缀启用前的历史 Todo），按声明顺序优先匹配 */
const TODO_LOOSE_KEYWORDS: Array<{ phase: GuidePhaseId; keywords: string[] }> = [
  { phase: 'requirements', keywords: ['需求'] },
  { phase: 'prototype', keywords: ['原型', 'UX'] },
  { phase: 'architecture', keywords: ['架构'] },
  { phase: 'planning', keywords: ['规划', '工程', '计划'] },
]

/**
 * 按标题前缀把调度员 Todo 归类到阶段。
 * 先精确匹配强制前缀（需求阶段：/原型阶段：/架构阶段：/规划阶段：），
 * 再宽松匹配关键词开头（历史 Todo 降级识别）；无法归类返回 null（该阶段无徽标，降级不报错）。
 */
export function parseTodoPhase(title: string): GuidePhaseId | null {
  for (const [phase, prefix] of Object.entries(PHASE_TODO_PREFIX)) {
    if (title.startsWith(prefix)) return phase as GuidePhaseId
  }
  for (const { phase, keywords } of TODO_LOOSE_KEYWORDS) {
    if (keywords.some((keyword) => title.startsWith(keyword))) return phase
  }
  return null
}

/** Todo 最小数据面（渲染端从 listTodos 返回值裁剪） */
export interface TodoLike {
  title: string
  status: string
}

/** 按 Todo 归类结果统计各阶段完成度与清单 */
export function computeTodoStats(todos: TodoLike[]): {
  stats: Partial<Record<GuidePhaseId, GuideTodoStat>>
  todosByPhase: Partial<Record<GuidePhaseId, TodoLike[]>>
} {
  const stats: Partial<Record<GuidePhaseId, GuideTodoStat>> = {}
  const todosByPhase: Partial<Record<GuidePhaseId, TodoLike[]>> = {}
  for (const todo of todos) {
    const phase = parseTodoPhase(todo.title)
    if (!phase) continue
    const stat = (stats[phase] ??= { done: 0, total: 0 })
    stat.total += 1
    if (todo.status === 'completed') stat.done += 1
    ;(todosByPhase[phase] ??= []).push(todo)
  }
  return { stats, todosByPhase }
}

// ===== 进度三态计算（PRD §4.1，含边界态容错） =====

/** 项目数据面（渲染端从 _nanju-projects.json 投影的最小字段） */
export interface GuideProjectLike {
  mode: GuideMode
  currentStage: string
  status: string
}

/** 计算结果：三态表 + Header 附加提示（null = 无提示） */
export interface StageStatesResult {
  stageStates: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>>
  abandoned: boolean
  /** Header 追加提示条文案（mode-select 引导 / coding/testing 交接 / 未知 stage 数据异常） */
  notice: string | null
}

/** 计算各阶段三态 + 边界态提示（AC-12：mode-select/coding/testing/未知值四类边界不崩溃） */
export function computeStageStates(
  project: GuideProjectLike,
  phases: GuideRoutePhase[],
): StageStatesResult {
  const order = phases.filter((p) => p.id !== 'delivered').map((p) => p.id as GuidePhaseId)
  const allPending = (): StageStatesResult['stageStates'] => {
    const states: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>> = { delivered: 'pending' }
    for (const id of order) states[id] = 'pending'
    return states
  }

  // 已放弃：整图灰态、无进行中动画（修订 Y6）
  if (project.status === 'abandoned') {
    return { stageStates: allPending(), abandoned: true, notice: '项目已放弃，流程不再推进' }
  }

  // 已完成或已交付：全部 done
  if (project.status === 'completed' || project.currentStage === 'delivered') {
    const states: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>> = { delivered: 'done' }
    for (const id of order) states[id] = 'done'
    return { stageStates: states, abandoned: false, notice: null }
  }

  // 待选择模式：全 pending + 引导态
  if (project.currentStage === 'mode-select') {
    return { stageStates: allPending(), abandoned: false, notice: '尚未选择项目模式，请先在对话中选择快消型或长期迭代型' }
  }

  // 遗留 stage 值（不在 v2.3 路由内）：planning 视为 current + 交接提示
  if (project.currentStage === 'coding' || project.currentStage === 'testing') {
    const states = allPending()
    const last = order[order.length - 1]
    if (last) states[last] = 'current'
    const label = project.currentStage === 'coding' ? '编码' : '测试'
    return { stageStates: states, abandoned: false, notice: `项目已进入${label}阶段（由编程 Agent 接管，向导流程已交付）` }
  }

  // 正常：按路由序逐个比较
  const index = order.indexOf(project.currentStage as GuidePhaseId)
  if (index === -1) {
    return { stageStates: allPending(), abandoned: false, notice: `数据异常：未知阶段「${project.currentStage}」，请刷新或检查项目元数据` }
  }
  const states: Partial<Record<GuidePhaseId | 'delivered', StageViewStatus>> = { delivered: 'pending' }
  order.forEach((id, i) => {
    states[id] = i < index ? 'done' : i === index ? 'current' : 'pending'
  })
  return { stageStates: states, abandoned: false, notice: null }
}

// ===== DSL 生成 =====

/** 中文序号（subgraph 标题用） */
const CIRCLED_NUMBERS = ['①', '②', '③', '④', '⑤', '⑥']

/** 各阶段产出物中文名（DSL 主节点 label 首行） */
const PHASE_OUTPUT_LABEL: Record<GuidePhaseId, string> = {
  requirements: '产出 PRD',
  prototype: '可交互 HTML 原型',
  architecture: '产出架构文档',
  planning: '产出工程计划',
}

/** 交付终点 label 第二行（quick 与 iterative 语义不同，PRD §3.2/§3.3） */
const DONE_SUB_LABEL: Record<GuideMode, string> = {
  quick: '项目可用',
  iterative: '进入编码实现阶段',
}

/** 明/暗两套 classDef 色值（南大语义色，PRD §3.1 + design-system DOC-2.4）
 *  2026-08-20 配色修正（用户反馈：背景与元素反差不足）：
 *  改用实色填充替代低透明 rgba，节点色块在画布背景上明显突出；
 *  渲染器必须是官方 mermaid（beautiful-mermaid 不支持 classDef）。 */
const CLASS_DEFS: Record<'light' | 'dark', string[]> = {
  light: [
    'classDef st-done fill:#A7F3D0,stroke:#059669,stroke-width:2px,color:#064E3B',
    'classDef st-sub-done fill:#D1FAE5,stroke:#059669,color:#065F46',
    'classDef st-current fill:#C7D2FE,stroke:#4F46E5,stroke-width:3px,color:#312E81',
    'classDef st-pending fill:#FFFFFF,stroke:#9CA3AF,color:#4B5563',
  ],
  dark: [
    'classDef st-done fill:#047857,stroke:#34D399,stroke-width:2px,color:#ECFDF5',
    'classDef st-sub-done fill:#065F46,stroke:#10B981,color:#D1FAE5',
    'classDef st-current fill:#312E81,stroke:#818CF8,stroke-width:3px,color:#F8FAFF',
    'classDef st-pending fill:#334155,stroke:#94A3B8,color:#CBD5E1',
  ],
}

/** 已通过的跨阶段推进边加粗主色（linkStyle，PRD §3.1 原则 3） */
const PASSED_EDGE_STYLE: Record<'light' | 'dark', string> = {
  light: 'stroke:#059669,stroke-width:2.5px',
  dark: 'stroke:#34D399,stroke-width:2.5px',
}

/** mermaid label 转义：引号与换行占位由生成器控制，这里仅处理双引号 */
function escapeLabel(text: string): string {
  return text.replace(/"/g, '#quot;')
}

/** 生成单个阶段的 subgraph 内部结构；返回 { lines, mainNode, exitNode, edgeCount }；跨阶段边由调用方输出 */
function buildPhaseSubgraph(
  phase: GuideRoutePhase,
  index: number,
  todoLabel: string,
): { lines: string[]; mainNode: string; exitNode: string; edgeCount: number } {
  const phaseId = phase.id as GuidePhaseId
  const main = GUIDE_MAIN_NODE_ID[phaseId]
  const atk = `${main}_ATK`
  const def = `${main}_DEF`
  const uc = `${main}_UC`
  const weight = phase.taskWeight ?? 'medium'
  const isPrototype = phaseId === 'prototype'
  const isArchitecture = phaseId === 'architecture'

  const lines: string[] = []
  let edgeCount = 0
  // subgraph 标题：① 角色名 角色英文 · 模型（渠道为运行时解析值/家族标记，不直接展示，修订 Y8）
  lines.push(`    subgraph SG_${main}["${CIRCLED_NUMBERS[index]} ${phase.title} ${phase.role} · ${phase.model}"]`)
  lines.push('        direction TB')
  lines.push(`        ${main}["${PHASE_OUTPUT_LABEL[phaseId]}<br/>${phase.outputPath}${todoLabel}"]`)

  if (isPrototype) {
    // prototype 特有：截图渲染自检循环（先于 AC 审计）+ 独立视觉裁决（防作者自证）
    // 视觉裁决者与作者同渠道同模型（M3），防自证靠证据隔离（PRD 清单+截图，不看作者自述，修订 Y9）
    lines.push(`        ${main} --> ${main}_SS{"截图渲染自检循环<br/>连续 2 轮无缺陷"}`)
    lines.push(`        ${main}_SS -->|"发现缺陷 → 修复"| ${main}`)
    lines.push(`        ${main}_SS -->|"通过"| ${atk}["攻击者审查（AC ${weight} + 视觉/交互维度）"]`)
    edgeCount += 3
  } else {
    lines.push(`        ${main} --> ${atk}["攻击者审查（AC ${weight}）"]`)
    edgeCount += 1
  }
  lines.push(`        ${atk} --> ${def}["防御者裁决"]`)
  lines.push(`        ${def} -->|"red → 修复后重新攻击"| ${atk}`)
  edgeCount += 2
  if (isArchitecture && phase.requiresAC) {
    // 修订 Y2：AC red 硬门禁 = ARCH_DEF 独立出口边（忠实于 handlePhaseResult 先门禁后确认）
    lines.push(`        ${def} -->|"有 red · AC 结论硬门禁"| ${main}_GATE{"AC 结论硬门禁<br/>red 时通知用户后重审"}`)
    lines.push(`        ${main}_GATE -->|"处理后重新攻击"| ${atk}`)
    lines.push(`        ${def} -->|"无 red"| ${uc}{"用户确认<br/>预览 ${phase.outputPath}"}`)
    edgeCount += 3
  } else {
    lines.push(`        ${def} -->|"无 red"| ${uc}{"用户确认<br/>预览 ${phase.outputPath}"}`)
    edgeCount += 1
  }
  if (isPrototype) {
    lines.push(`        ${def} -->|"无 red"| ${main}_VIS{"独立视觉裁决<br/>防作者自证"}`)
    lines.push(`        ${main}_VIS -->|"red → 回截图自检"| ${main}_SS`)
    lines.push(`        ${main}_VIS -->|"green / yellow"| ${uc}{"原型确认 · 点选纠错<br/>意见收集轮 → 批量修改"}`)
    edgeCount += 3
  }
  lines.push(`        ${uc} -->|"补充意见"| ${main}`)
  edgeCount += 1
  lines.push('    end')

  return { lines, mainNode: main, exitNode: uc, edgeCount }
}

/**
 * 生成向导图 mermaid flowchart DSL。
 *
 * 结构数据驱动：阶段名/角色/模型/outputPath/AC 强度全部来自 nanju:get-route 的 route 数据，
 * 本函数不复制阶段表（结构骨架按 phase id 特化：prototype 自检/视觉裁决、architecture 硬门禁）。
 */
export function buildGuideDsl(input: BuildGuideDslInput): string {
  const { mode, route, progress, isDark } = input
  const phases = route.filter((p) => p.id !== 'delivered' && p.id !== 'mode-select')
  const first = phases[0]
  const weight = first?.taskWeight ?? 'medium'
  // AC 攻/防模型取第一阶段解析结果（按模式整体分级，全阶段一致，nanju-router.ts）
  const acWeightLabel = `AC ${weight}`
  const acActorLabel = first ? `攻 ${first.acActors.attacker.model} / 防 ${first.acActors.defender.model}` : ''
  const modeLabel = mode === 'quick' ? '快消型' : '长期迭代型'

  const lines: string[] = [
    // 紧凑布局指令：缩小节点间距/层级间距/内边距，缓解“布局稀疏、元素小”（用户反馈）
    '---\nconfig:\n  flowchart:\n    nodeSpacing: 28\n    rankSpacing: 36\n    padding: 6\n---',
    'flowchart TD',
  ]
  // 边索引计数：linkStyle 需要按边声明顺序的 0 基索引
  let edgeIndex = 0
  const passedEdgeIndexes: number[] = []
  const statusOf = (id: GuidePhaseId | 'delivered'): StageViewStatus => progress?.stageStates[id] ?? 'pending'
  const abandoned = progress?.abandoned ?? false

  lines.push('    USER(["用户描述想法"]) --> MODE{"模式路由"}')
  edgeIndex += 1 // USER --> MODE
  lines.push(`    MODE -->|"${modeLabel} · ${acWeightLabel}<br/>${acActorLabel}"| ${GUIDE_MAIN_NODE_ID[phases[0]?.id as GuidePhaseId]}`)
  edgeIndex += 1 // MODE --> 第一阶段

  // 各阶段 subgraph + 跨阶段推进边
  const classAssignments: string[] = []
  const subDoneGroups: string[] = []
  let prevExit: string | null = null
  phases.forEach((phase, i) => {
    const phaseId = phase.id as GuidePhaseId
    const stat = progress?.todoStats?.[phaseId]
    // Todo 完成度徽标：无匹配不显示（降级，PRD §4.2）
    const todoLabel = stat && stat.total > 0 && !abandoned ? `<br/>Todo ${stat.done}/${stat.total}` : ''
    const { lines: subLines, mainNode, exitNode, edgeCount } = buildPhaseSubgraph(phase, i, todoLabel)

    if (prevExit) {
      // 跨阶段推进边：前阶段出口 → 本阶段主节点
      const fromId = phases[i - 1]?.id as GuidePhaseId
      const edgeLabel = i === 1 ? '确认' : fromId === 'prototype' ? '全部用户故事通过' : '确认'
      lines.push('')
      lines.push(`    ${prevExit} -->|"${edgeLabel}"| ${mainNode}`)
      // 已通过边判定：前阶段 done 且非 abandoned（推进已实际发生）
      if (progress && !abandoned && statusOf(fromId) === 'done') passedEdgeIndexes.push(edgeIndex)
      edgeIndex += 1
    }

    lines.push('')
    lines.push(...subLines)
    edgeIndex += edgeCount
    prevExit = exitNode

    // 进度 class 注入（对照模式 progress=null 时不注入任何状态 class）
    if (progress) {
      const status = abandoned ? 'pending' : statusOf(phaseId)
      classAssignments.push(`class ${mainNode} st-${status}`)
      if (status === 'done') {
        // 子节点跟随阶段 done 着色（st-sub-done 弱一档，不做子级独立追踪，PRD §4.1.4）
        const subs = [`${mainNode}_ATK`, `${mainNode}_DEF`, exitNode]
        if (phaseId === 'prototype') subs.unshift(`${mainNode}_SS`, `${mainNode}_VIS`)
        if (phaseId === 'architecture') subs.splice(2, 0, `${mainNode}_GATE`)
        subDoneGroups.push(subs.join(','))
      } else if (status === 'pending' || abandoned) {
        const subs = [`${mainNode}_ATK`, `${mainNode}_DEF`, exitNode]
        if (phaseId === 'prototype') subs.unshift(`${mainNode}_SS`, `${mainNode}_VIS`)
        if (phaseId === 'architecture') subs.splice(2, 0, `${mainNode}_GATE`)
        classAssignments.push(`class ${subs.join(',')} st-pending`)
      }
    }
  })

  // 交付终点：边标签忠实于路由语义（quick 由 prototype 用户故事收口 → 全部通过；iterative 由 planning 用户确认 → 确认）
  const last = phases[phases.length - 1]
  const doneEdgeLabel = (last?.id as GuidePhaseId | undefined) === 'prototype' ? '全部用户故事通过' : '确认'
  lines.push('')
  lines.push(`    ${prevExit} -->|"${doneEdgeLabel}"| DONE(["交付 delivered<br/>${DONE_SUB_LABEL[mode]}"])`)
  if (progress && !abandoned && statusOf((last?.id ?? 'planning') as GuidePhaseId) === 'done') {
    passedEdgeIndexes.push(edgeIndex)
  }
  edgeIndex += 1

  // classDef + class + linkStyle（仅进度模式输出）
  if (progress) {
    lines.push('')
    lines.push(...CLASS_DEFS[isDark ? 'dark' : 'light'].map((def) => `    ${def}`))
    const doneFlag = !abandoned && statusOf('delivered') === 'done'
    lines.push(`    class DONE ${doneFlag ? 'st-done' : 'st-pending'}`)
    lines.push(`    class USER,MODE st-pending`)
    for (const assignment of classAssignments) lines.push(`    ${assignment}`)
    for (const group of subDoneGroups) lines.push(`    class ${group} st-sub-done`)
    if (passedEdgeIndexes.length > 0) {
      const style = PASSED_EDGE_STYLE[isDark ? 'dark' : 'light']
      lines.push(`    linkStyle ${passedEdgeIndexes.join(',')} ${style}`)
    }
  }

  return lines.join('\n') + '\n'
}
