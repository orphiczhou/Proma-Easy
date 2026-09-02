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
/** 除 delivered 终点外的六个可执行阶段（Sprint B 起 testing 入路由） */
export type GuidePhaseId = 'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing'

/** 阶段主节点 id（SVG 交互锚点，稳定不变） */
export const GUIDE_MAIN_NODE_ID: Record<GuidePhaseId, string> = {
  requirements: 'REQ',
  prototype: 'PROTO',
  architecture: 'ARCH',
  planning: 'PLAN',
  coding: 'CODE',
  testing: 'TEST',
}

/**
 * 各阶段子步骤推进序列（W2 S1/S2，跨进程契约）：与主进程 main/lib/nanju-guide-progress.ts
 * 的 GUIDE_SUBSTAGE_SEQUENCE 一一对应（首元素=主节点）。两侧一致性由 nanju-guide-progress.test.ts
 * 锁定（JSON 相等断言）；改任何一侧必须同步另一侧并过测试。
 * S1 诚实两态起步：主进程只写 {主节点}/{主节点}_UC，中间节点由 derive 推导（细分留 S4）。
 */
export const GUIDE_SUBSTAGE_SEQUENCE: Record<GuidePhaseId, readonly string[]> = {
  requirements: ['REQ', 'REQ_ATK', 'REQ_DEF', 'REQ_UC'],
  prototype: ['PROTO', 'PROTO_SS', 'PROTO_ATK', 'PROTO_DEF', 'PROTO_VIS', 'PROTO_UC'],
  architecture: ['ARCH', 'ARCH_ATK', 'ARCH_DEF', 'ARCH_GATE', 'ARCH_UC'],
  planning: ['PLAN', 'PLAN_ATK', 'PLAN_DEF', 'PLAN_UC'],
  coding: ['CODE', 'CODE_UC'],
  testing: ['TEST', 'TEST_ATK', 'TEST_DEF', 'TEST_GWT', 'TEST_JUDGE'],
}

/**
 * 按 subStage 推导当前阶段序列内三态（规则与主进程 deriveGuideSubStates 同一契约，
 * 含 AC 审计 Round 1 必修-3 的 UC 态特殊化）：
 * - subStage 在序列内：其前 done、本身 current、后 pending；
 * - subStage 不在序列内 → 首节点（主节点）current、其余 pending（= 阶段刚开始，作者产出中）；
 * - **UC 态特殊化**：subStage === {主节点}_UC 时中间节点输出 pending 而非 done
 *   （主节点 done、UC current）——UC 仅证明产出就绪，AC 攻防等中间环节未接数据源
 *   （S4），不得画成「已通过」。
 * - 未知阶段（防御，A8 字面对齐：当前类型面/调用面不可达）返回空对象，与主端一致。
 */
export function deriveSubStageStates(
  phaseId: GuidePhaseId,
  subStage: string,
): Record<string, StageViewStatus> {
  const seq = GUIDE_SUBSTAGE_SEQUENCE[phaseId]
  if (!seq) return {}
  const hitIndex = subStage ? seq.indexOf(subStage) : -1
  const currentIdx = hitIndex === -1 ? 0 : hitIndex
  const isUcState = subStage === `${seq[0]}_UC`
  const result: Record<string, StageViewStatus> = {}
  seq.forEach((id, i) => {
    if (i === currentIdx) {
      result[id] = 'current'
    } else if (i < currentIdx) {
      result[id] = isUcState ? (i === 0 ? 'done' : 'pending') : 'done'
    } else {
      result[id] = 'pending'
    }
  })
  return result
}

/**
 * 各阶段 DSL 子节点的结构流顺序（buildPhaseSubgraph 的实际流程序，含不在推进序列内的
 * 结构节点——如 coding 的 ATK/DEF：S1 两态下未细分，按前驱继承规则着色）。
 */
const PHASE_SUB_NODE_FLOW: Record<GuidePhaseId, readonly string[]> = {
  requirements: ['REQ_ATK', 'REQ_DEF', 'REQ_UC'],
  prototype: ['PROTO_SS', 'PROTO_ATK', 'PROTO_DEF', 'PROTO_VIS', 'PROTO_UC'],
  architecture: ['ARCH_ATK', 'ARCH_DEF', 'ARCH_GATE', 'ARCH_UC'],
  planning: ['PLAN_ATK', 'PLAN_DEF', 'PLAN_UC'],
  coding: ['CODE_ATK', 'CODE_DEF', 'CODE_UC'],
  testing: ['TEST_ATK', 'TEST_DEF', 'TEST_GWT', 'TEST_JUDGE'],
}

/**
 * 当前阶段全部 DSL 子节点三态（W2 S2）：序列内节点取 derive 结果；序列外结构节点按
 * 结构流前驱继承（AC 审计 Round 1 必修-4 修订：**UC 态时继承基线为 pending**——产出
 * 就绪但 AC 攻防/门禁等环节未接数据源，序列外结构节点不得继承主节点的 done；
 * 非 UC 场景前驱 done → done、前驱 current/pending → pending——「正在产出」时下游
 * 未开始，不继承脉冲）。
 */
export function derivePhaseSubNodeStates(
  phaseId: GuidePhaseId,
  subStage: string,
): Record<string, StageViewStatus> {
  const seqStates = deriveSubStageStates(phaseId, subStage)
  const main = GUIDE_MAIN_NODE_ID[phaseId]
  // 前驱继承基线：UC 态一律 pending；主节点已过（done）且非 UC → 未入序列节点视为已随产出通过；否则未开始
  const isUcState = subStage === `${main}_UC`
  let lastStatus: StageViewStatus = seqStates[main] === 'done' && !isUcState ? 'done' : 'pending'
  const result: Record<string, StageViewStatus> = { ...seqStates }
  for (const id of PHASE_SUB_NODE_FLOW[phaseId]) {
    const seqState = seqStates[id]
    if (seqState) {
      lastStatus = seqState === 'done' ? 'done' : 'pending'
      continue
    }
    result[id] = lastStatus
  }
  return result
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
  /**
   * 当前阶段内子步骤（W2 S1，主进程 setProjectSubStage 写入）：主节点 id（作者产出中）
   * 或 {主节点}_UC（等待用户确认）。仅对 current 阶段生效；缺失/不属于该阶段序列 →
   * 降级为现状（子节点无细分着色），安全。
   */
  subStage?: string
}

export interface BuildGuideDslInput {
  mode: GuideMode
  /** nanju:get-route 返回值；函数内部过滤 id==='delivered' 哨兵（修订 Y3） */
  route: GuideRoutePhase[]
  /** null 时输出无进度叠加的静态结构（模式对照查看用，PRD §5.5） */
  progress: GuideProgress | null
  isDark: boolean
  /**
   * 展开集合（W2 S3）：展开阶段输出完整 subgraph 细部；折叠阶段只输出单代表节点
   * （id=主节点，锚点/GuideNodeTarget 解析兼容）。缺省 → 默认派生（progress 存在时
   * =[currentStage 所在阶段，无 current 阶段则全折叠]）；progress=null 对照模式强制全
   * 展开（折叠仅进度模式生效）。
   */
  expandedPhases?: GuidePhaseId[]
}

/**
 * 解析有效展开集合（W2 S3，GuidePanel 与 buildGuideDsl 共用默认派生规则）：
 * 对照模式全展开；进度模式取调用方集合（过滤非法 id），未传则默认 [current 阶段]
 * （无 current——已交付/已放弃/未选模式——则全折叠，紧凑摘要视图）。
 */
export function resolveExpandedPhases(
  route: GuideRoutePhase[],
  progress: GuideProgress | null,
  expandedPhases?: GuidePhaseId[],
): Set<GuidePhaseId> {
  const ids = route
    .filter((p) => p.id !== 'delivered' && p.id !== 'mode-select')
    .map((p) => p.id as GuidePhaseId)
  if (!progress) return new Set(ids)
  if (expandedPhases) return new Set(expandedPhases.filter((id) => ids.includes(id)))
  const current = ids.find((id) => progress.stageStates[id] === 'current')
  return new Set(current ? [current] : [])
}

/** SVG 节点 id → 阶段归属或特殊节点 */
export type GuideNodeTarget = GuidePhaseId | 'user' | 'mode' | 'done'

/** 节点 id 前缀 → 阶段（供 GuideFlow 后处理绑定交互） */
const NODE_ID_TARGETS: Array<{ prefix: string; target: GuideNodeTarget }> = [
  { prefix: 'REQ', target: 'requirements' },
  { prefix: 'PROTO', target: 'prototype' },
  { prefix: 'ARCH', target: 'architecture' },
  { prefix: 'PLAN', target: 'planning' },
  { prefix: 'CODE', target: 'coding' },
  { prefix: 'TEST', target: 'testing' },
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
  { phase: 'coding', keywords: ['开发', '编码'] },
  { phase: 'testing', keywords: ['测试'] },
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

  // 正常：按路由序逐个比较（testing 已入路由，Sprint B 起正常展示三态）
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
  coding: '可运行应用代码',
  testing: 'GWT 验收测试',
}

/** 交付终点 label 第二行（quick 与 iterative 语义不同，PRD §3.2/§3.3；Sprint B 起两版均经测试裁判交付） */
const DONE_SUB_LABEL: Record<GuideMode, string> = {
  quick: '项目可用 · 验收通过',
  iterative: '项目可用 · 验收交付完成',
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
    // st-blocked（W2 S2 预留，类型与样式先行）：等待修复/重试的琥珀色态（S4 接 GWT 失败/AC red 数据源）
    'classDef st-blocked fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#92400E',
  ],
  dark: [
    'classDef st-done fill:#047857,stroke:#34D399,stroke-width:2px,color:#ECFDF5',
    'classDef st-sub-done fill:#065F46,stroke:#10B981,color:#D1FAE5',
    'classDef st-current fill:#312E81,stroke:#818CF8,stroke-width:3px,color:#F8FAFF',
    'classDef st-pending fill:#334155,stroke:#94A3B8,color:#CBD5E1',
    'classDef st-blocked fill:#78350F,stroke:#F59E0B,stroke-width:2px,color:#FEF3C7',
  ],
}

/** 对照模式（progress=null）的中性参考样式：与 st-pending 同款色块。
 *  对照图不表示任何进度状态（AC-11 语义），但需要与进度图一致的元素/背景反差。 */
const REF_CLASS_DEFS: Record<'light' | 'dark', string[]> = {
  light: ['classDef st-ref fill:#FFFFFF,stroke:#9CA3AF,color:#4B5563'],
  dark: ['classDef st-ref fill:#334155,stroke:#94A3B8,color:#CBD5E1'],
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

  // testing 特化：场景生成（AC 审计后）→ Harness 执行 → 规则裁判（机器判定收口，无用户确认）
  if (phaseId === 'testing') {
    lines.push(`        ${main} --> ${atk}["攻击者审查（AC ${weight}）"]`)
    lines.push(`        ${atk} --> ${def}["防御者裁决"]`)
    lines.push(`        ${def} -->|"red → 修复后重新攻击"| ${atk}`)
    lines.push(`        ${def} -->|"无 red"| ${main}_GWT{"Harness 执行 GWT<br/>场景×步骤 · data-ai-id 锚点"}`)
    lines.push(`        ${main}_GWT -->|"❌ 失败场景 → 回炉 coding（≤2 次）"| ${main}`)
    lines.push(`        ${main}_GWT -->|"全场景通过"| ${main}_JUDGE{"规则裁判 judge.verdict<br/>全通过 + US 全覆盖 = 交付"}`)
    lines.push('    end')
    return { lines, mainNode: main, exitNode: `${main}_JUDGE`, edgeCount: 6 }
  }

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

  // W2 S3 展开/折叠：解析有效展开集合（默认派生与对照模式全展开规则见 resolveExpandedPhases）
  const expandedSet = resolveExpandedPhases(route, progress, input.expandedPhases)

  // 各阶段 subgraph + 跨阶段推进边
  const classAssignments: string[] = []
  const subDoneGroups: string[] = []
  /** 全量节点 id（对照模式中性着色的 class 行用） */
  const allNodeIds: string[] = ['USER', 'MODE', 'DONE']
  let prevExit: string | null = null
  phases.forEach((phase, i) => {
    const phaseId = phase.id as GuidePhaseId
    const main = GUIDE_MAIN_NODE_ID[phaseId]
    const stat = progress?.todoStats?.[phaseId]
    // Todo 完成度徽标文本：无匹配不显示（降级，PRD §4.2）；展开主节点前缀 <br/>，折叠框行内拼接
    const todoText = stat && stat.total > 0 && !abandoned ? `Todo ${stat.done}/${stat.total}` : ''
    const todoLabel = todoText ? `<br/>${todoText}` : ''
    const collapsed = !expandedSet.has(phaseId)
    const status: StageViewStatus = abandoned ? 'pending' : statusOf(phaseId)

    // 跨阶段推进边：前阶段出口（折叠框=代表节点 / 展开框=subgraph 出口）→ 本阶段主节点
    if (prevExit) {
      const fromId = phases[i - 1]?.id as GuidePhaseId
      const edgeLabel = i === 1
        ? '确认'
        : fromId === 'prototype'
          ? '全部用户故事通过'
          : fromId === 'coding'
            ? '应用验证通过'
            : '确认'
      lines.push('')
      lines.push(`    ${prevExit} -->|"${edgeLabel}"| ${main}`)
      // 已通过边判定：前阶段 done 且非 abandoned（推进已实际发生）
      if (progress && !abandoned && statusOf(fromId) === 'done') passedEdgeIndexes.push(edgeIndex)
      edgeIndex += 1
    }

    const subs: string[] = []
    if (collapsed) {
      // W2 S3 折叠阶段：只输出单代表节点（id=主节点不变，锚点/GuideNodeTarget 解析兼容），
      // label 承载 subgraph 标题 + 产出物 + 三态状态行 + Todo 徽标摘要；无内部边
      const statusLine = status === 'done' ? '✓ 已完成' : status === 'current' ? '▶ 进行中' : '未开始'
      lines.push('')
      lines.push(`    ${main}["${CIRCLED_NUMBERS[i]} ${phase.title} ${phase.role} · ${phase.model}<br/>${PHASE_OUTPUT_LABEL[phaseId]}<br/>${statusLine}${todoText ? ` ${todoText}` : ''}"]`)
      allNodeIds.push(main)
      prevExit = main
    } else {
      const { lines: subLines, exitNode, edgeCount } = buildPhaseSubgraph(phase, i, todoLabel)
      lines.push('')
      lines.push(...subLines)
      edgeIndex += edgeCount
      prevExit = exitNode
      // 全量节点收集（对照模式中性着色用）
      allNodeIds.push(main)
      const subNodes = [`${main}_ATK`, `${main}_DEF`, exitNode]
      if (phaseId === 'prototype') subNodes.unshift(`${main}_SS`, `${main}_VIS`)
      if (phaseId === 'architecture') subNodes.splice(2, 0, `${main}_GATE`)
      if (phaseId === 'testing') subNodes.splice(2, 0, `${main}_GWT`)
      allNodeIds.push(...subNodes)
      subs.push(...subNodes)
    }

    // 进度 class 注入（对照模式 progress=null 时不注入任何状态 class）
    if (progress) {
      // W2 S2：current 阶段且有有效 subStage → 主节点按序列位置着色（产出完成等确认时
      // 主节点转 done、脉冲移到 UC 节点）；折叠框聚合阶段态不用细分；其余维持阶段三态
      const subStageStates = status === 'current' && !collapsed && progress.subStage
        && GUIDE_SUBSTAGE_SEQUENCE[phaseId].includes(progress.subStage)
        ? derivePhaseSubNodeStates(phaseId, progress.subStage)
        : null
      classAssignments.push(`class ${main} st-${subStageStates?.[main] ?? status}`)
      if (subStageStates && subs.length > 0) {
        // 子节点按推导三态分组（st-sub-done 弱绿 / st-current 脉冲 / st-pending 灰），
        // 替代现状「current 阶段子节点全灰」；分组顺序按结构流（首现顺序稳定可测）
        const groups: Record<StageViewStatus, string[]> = { done: [], current: [], pending: [] }
        for (const id of subs) groups[subStageStates[id] ?? 'pending'].push(id)
        if (groups.done.length > 0) subDoneGroups.push(groups.done.join(','))
        if (groups.current.length > 0) classAssignments.push(`class ${groups.current.join(',')} st-current`)
        if (groups.pending.length > 0) classAssignments.push(`class ${groups.pending.join(',')} st-pending`)
      } else if (status === 'done') {
        // 子节点跟随阶段 done 着色（st-sub-done 弱一档，PRD §4.1.4）
        if (subs.length > 0) subDoneGroups.push(subs.join(','))
      } else if (status === 'pending' || abandoned) {
        if (subs.length > 0) classAssignments.push(`class ${subs.join(',')} st-pending`)
      }
      // else：current 阶段无/未知 subStage → 子节点不注入 class（现状降级，mermaid 默认灰）
    }
  })

  // 交付终点：边标签忠实于路由语义（Sprint B 起两模式均由 testing 裁判交付；prototype 直连 DONE 为遗留路由兼容）
  const last = phases[phases.length - 1]
  const doneEdgeLabel = (last?.id as GuidePhaseId | undefined) === 'testing'
    ? '全场景通过 · 裁判判定'
    : (last?.id as GuidePhaseId | undefined) === 'prototype'
      ? '全部用户故事通过'
      : '确认'
  lines.push('')
  lines.push(`    ${prevExit} -->|"${doneEdgeLabel}"| DONE(["交付 delivered<br/>${DONE_SUB_LABEL[mode]}"])`)
  if (progress && !abandoned && statusOf((last?.id ?? 'planning') as GuidePhaseId) === 'done') {
    passedEdgeIndexes.push(edgeIndex)
  }
  edgeIndex += 1

  // classDef + class + linkStyle（进度模式：状态着色；对照模式：中性参考样式）
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
  } else {
    // 对照模式：无进度状态，注入统一中性色块（反差配色与进度图一致，语义不表状态）
    lines.push('')
    lines.push(...REF_CLASS_DEFS[isDark ? 'dark' : 'light'].map((def) => `    ${def}`))
    lines.push(`    class ${allNodeIds.join(',')} st-ref`)
  }

  return lines.join('\n') + '\n'
}
