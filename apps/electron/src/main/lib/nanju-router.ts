/**
 * 南大向导 v2 固定路由状态机
 *
 * 替代 tree-engine 的动态树形管理。南大向导的工作流是确定性管道，
 * 不需要动态分支/剪枝/审计树。
 *
 * 核心设计（AC 三轮审计收敛版 v2.3）：
 * - L1 调度员受固定路由约束（不允许自主偏离）
 * - L2 角色子会话通过 delegate_agent 委派（跨渠道跨模型）
 * - canUseTool 硬门禁按阶段限制工具白名单
 * - 文件验证 + 用户确认 + 异常恢复
 */

import type { ProjectMode } from './nanju-project'
import type { GuideRoutePhase } from '@proma/shared'

// ===== 类型定义 =====

export type PhaseId = 'requirements' | 'prototype' | 'architecture' | 'planning' | 'delivered'

/** AC 审计强度分级：quick 模式全阶段 light（快模型攻防），iterative 模式全阶段 medium（强模型攻防） */
export type TaskWeight = 'light' | 'medium'

export interface PhaseNode {
  id: PhaseId
  role: string
  title: string
  channel: string
  model: string
  task: string
  outputPath: string
  constraints: string[]
  requiresUserConfirmation: boolean
  requiresAC: boolean
  retryLimit: number
  next: PhaseId | null
  /** AC 审计强度：默认按路由模式（quick=light / iterative=medium），显式 ac* 配置可覆盖预设 */
  taskWeight?: TaskWeight
  /** AC 审计攻击者配置（显式指定时覆盖 taskWeight 预设） */
  acAttackerChannel?: string
  acAttackerModel?: string
  /** AC 审计防御者配置（显式指定时覆盖 taskWeight 预设；不得与作者同家族） */
  acDefenderChannel?: string
  acDefenderModel?: string
}

// ===== AC 审计分级预设（P1：v0.16.87） =====

/** AC 攻/防角色配置 */
export interface ACActorConfig {
  channel: string
  model: string
}

/**
 * AC 审计预设表。
 * 攻击者固定 deepseek 家族、防御者固定智谱家族，避免与常见作者渠道同家族；
 * light 用快模型（快消型项目），medium 用强模型（长期迭代型项目）。
 */
export const AC_PRESETS: Record<TaskWeight, { attacker: ACActorConfig; defender: ACActorConfig }> = {
  light: {
    attacker: { channel: 'deepseek', model: 'deepseek-v4-flash' },
    defender: { channel: 'glm-zhipu', model: 'glm-5-turbo' },
  },
  medium: {
    attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
    defender: { channel: 'glm-zhipu', model: 'GLM-5.3' },
  },
}

/**
 * 渠道家族判定：按渠道 ID 前缀归类（deepseek=ds系、glm-zhipu=智谱系、minimax=M3系）。
 * 无法识别前缀的渠道（如 minimax 的 UUID 渠道 ID）视为独立家族，与字面渠道天然不同。
 */
export function channelFamily(channelId: string): string {
  if (channelId.startsWith('deepseek')) return 'family-deepseek'
  if (channelId.startsWith('glm-zhipu')) return 'family-glm'
  if (channelId.startsWith('minimax')) return 'family-minimax'
  return channelId
}

/**
 * AC 家族多样性断言（修复「防御者=作者同家族」缺陷）：
 * - 防御者渠道家族 ≠ 作者渠道家族（防止作者家族既当运动员又当裁判）
 * - 攻击者渠道家族 ≠ 防御者渠道家族（防止攻防串通）
 * 违反时抛错。构建 L2 委派指令时调用（首次构建期即拦截）。
 */
export function assertACFamilyDiversity(input: {
  authorChannel: string
  attackerChannel: string
  defenderChannel: string
}): void {
  const authorFamily = channelFamily(input.authorChannel)
  const attackerFamily = channelFamily(input.attackerChannel)
  const defenderFamily = channelFamily(input.defenderChannel)
  if (defenderFamily === authorFamily) {
    throw new Error(
      `AC 审计配置错误：防御者渠道（${input.defenderChannel}）与作者渠道（${input.authorChannel}）属于同一家族，审计无效，请调整预设或显式覆盖配置`,
    )
  }
  if (attackerFamily === defenderFamily) {
    throw new Error(
      `AC 审计配置错误：攻击者渠道（${input.attackerChannel}）与防御者渠道（${input.defenderChannel}）属于同一家族，攻防可能串通`,
    )
  }
}

/**
 * 解析阶段的 AC 攻/防配置：显式 acAttacker 与 acDefender 字段优先，其次按 taskWeight 取预设；
 * 未标注 taskWeight 时按 medium 处理。
 */
export function resolveACActors(phase: PhaseNode): { attacker: ACActorConfig; defender: ACActorConfig } {
  const preset = AC_PRESETS[phase.taskWeight ?? 'medium']
  return {
    attacker: {
      channel: phase.acAttackerChannel ?? preset.attacker.channel,
      model: phase.acAttackerModel ?? preset.attacker.model,
    },
    defender: {
      channel: phase.acDefenderChannel ?? preset.defender.channel,
      model: phase.acDefenderModel ?? preset.defender.model,
    },
  }
}

/** AC 审计 finding（简化版，v2 无 Arbiter） */
export interface Finding {
  severity: 'red' | 'yellow' | 'green'
  evidence: string
  fix?: string
}

/** 阶段执行结果 */
export interface PhaseResult {
  status: 'success' | 'failed' | 'timeout' | 'needs_modification'
  files: string[]
  acFindings?: Finding[]
  error?: string
  retryCount: number
}

/** 阶段推进动作 */
export type PhaseAction =
  | { action: 'retry'; reason: string }
  | { action: 'advance' }
  | { action: 'ask_user' }
  | { action: 'notify_user'; reason: string }

// ===== 公共节点 =====

const SENTINEL: PhaseNode = {
  id: 'delivered',
  role: '',
  title: '',
  channel: '',
  model: '',
  task: '',
  outputPath: '',
  constraints: [],
  requiresUserConfirmation: false,
  requiresAC: false,
  retryLimit: 0,
  next: null,
}

/** 需求阶段基础定义（各模式共用；taskWeight 在 makeRoute 中按模式赋值） */
const REQUIREMENTS_BASE: Omit<PhaseNode, 'taskWeight'> = {
  id: 'requirements',
  role: 'requirement-analyst',
  title: '需求分析师',
  channel: 'deepseek',
  model: 'deepseek-v4-pro',
  task: '你是需求分析师。与用户对话收集需求，产出 PRD。',
  outputPath: '01_PRD/prd.md',
  constraints: ['用生活化语言提问', '3-5 个引导性问题', '提供选项而非填空'],
  requiresUserConfirmation: true,
  requiresAC: false,
  retryLimit: 3,
  next: 'prototype',
}

/**
 * 工厂函数（修正 R2：显式定义所有节点）。
 *
 * AC 审计强度默认按模式整体分级：quick=light（快模型攻防）、iterative=medium（强模型攻防）；
 * SENTINEL 是终态哨兵，不参与 AC，跳过分级。显式 acAttacker 与 acDefender 字段仍可覆盖预设。
 */
function makeRoute(mode: ProjectMode): PhaseNode[] {
  const defaultWeight: TaskWeight = mode === 'quick' ? 'light' : 'medium'
  const REQUIREMENTS: PhaseNode = { ...REQUIREMENTS_BASE, taskWeight: defaultWeight }

  const prototype: PhaseNode = {
    id: 'prototype',
    role: 'ux-advisor',
    title: 'UX 顾问',
    // 作者为 MiniMax-M3（视觉模型）。minimax 渠道 ID 是 UUID（release/dev 环境不同），
    // 这里的 'minimax' 只是家族标记；实际渠道在构建委派指令时运行时解析（见 nanju-router-prompt.ts）。
    channel: 'minimax',
    model: 'MiniMax-M3',
    task: '你是 UX 顾问。根据 PRD 生成可交互 HTML 原型。',
    outputPath: '02_UX_DESIGN/prototype.html',
    constraints: [
      '单文件 HTML，内联 CSS',
      '简洁现代风格',
      '覆盖 PRD 核心功能',
      '可交互演示原型（硬性标准）：原型必须可真实操作，不是静态展示——用户故事中的每个 P0 交互（点击/输入/切换/提交）都要能实际触发并看到结果；状态/数据用演示数据+JS 状态机模拟（参照闪念Tips 原型的做法：六态状态机、串行队列模拟、故障注入演示面板并标注「演示辅助，非产品功能」）；每个可操作元素给可见反馈（离焦/激活/完成态）',
      '点选纠错标记（硬性标准）：所有可交互/可修改元素必须标 data-ai-id（唯一英文ID如 btn-start/input-amount）+ data-ai-type（按钮/输入框/文本/图片/卡片等中文类型）——系统在预览时会注入点击捕获，用户点选元素直接发起修改请求；无标记的元素用户无法点名',
      '多场景导航规范：场景索引一律用顶部横向分页窄条（tab，高度≤48px，sticky 置顶，命名=用户故事 US-xx）；禁止纵向全屏索引页；≤6 个场景全部展示，>6 横向滚动不换行；核心场景在 1280x720 首屏不滚动即可见',
    ],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 2,
    next: mode === 'quick' ? 'delivered' : 'architecture',
    taskWeight: defaultWeight,
  }

  if (mode === 'quick') {
    return [REQUIREMENTS, prototype, SENTINEL]
  }

  const architecture: PhaseNode = {
    id: 'architecture',
    role: 'architect',
    title: '架构师',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '你是架构设计师。根据 PRD 和原型，产出架构文档。',
    outputPath: '03_ARCHITECTURE/architecture.md',
    constraints: ['技术选型 + 目录结构', 'API 规范设计'],
    requiresUserConfirmation: true,
    requiresAC: true,
    retryLimit: 2,
    next: 'planning',
    taskWeight: defaultWeight,
  }

  const planning: PhaseNode = {
    id: 'planning',
    role: 'engineering-manager',
    title: '工程经理',
    channel: 'deepseek',
    model: 'deepseek-v4-pro',
    task: '你是工程经理。根据架构，产出工程计划。',
    outputPath: '05_PROJECT_PLAN/plan.md',
    constraints: ['技术栈确定', '开发计划 + 里程碑'],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 2,
    next: 'delivered',
    taskWeight: defaultWeight,
  }

  return [REQUIREMENTS, prototype, architecture, planning, SENTINEL]
}

const ROUTES: Record<ProjectMode, PhaseNode[]> = {
  quick: makeRoute('quick'),
  iterative: makeRoute('iterative'),
}

// ===== 路由查询 =====

/** 获取指定模式的完整路由 */
export function getRoute(mode: ProjectMode): PhaseNode[] {
  return ROUTES[mode] ?? ROUTES.iterative
}

/**
 * 获取向导图数据：getRoute(mode) 透传 + 对每个 phase 附加 resolveACActors 解析结果（修订 R2）。
 *
 * 数据契约：返回数组含 id==='delivered' 的哨兵空节点（role/outputPath 为空串），
 * 渲染端负责过滤（PRD 修订 Y3）。
 */
export function getGuideRoute(mode: ProjectMode): GuideRoutePhase[] {
  return getRoute(mode).map((phase) => ({
    ...phase,
    acActors: resolveACActors(phase),
  }))
}

/** 获取指定阶段的节点定义 */
export function getPhaseNode(mode: ProjectMode, phaseId: PhaseId): PhaseNode | undefined {
  return getRoute(mode).find((p) => p.id === phaseId)
}

/** 获取下一阶段 ID */
export function getNextPhase(mode: ProjectMode, currentPhase: PhaseId): PhaseId | null {
  const node = getPhaseNode(mode, currentPhase)
  return node?.next ?? null
}

/** 判断是否为终态 */
export function isTerminal(phaseId: PhaseId): boolean {
  return phaseId === 'delivered'
}

// ===== 阶段推进决策（修正 Y2 + F11） =====

export function handlePhaseResult(result: PhaseResult, phase: PhaseNode): PhaseAction {
  // 失败/超时/需修改 + 重试次数未超限 → 重试
  if (
    (result.status === 'failed' || result.status === 'timeout' || result.status === 'needs_modification')
    && result.retryCount < phase.retryLimit
  ) {
    return { action: 'retry', reason: result.error ?? 'L2 产出需要修改，正在重新委派' }
  }
  // 重试超限 → 通知用户
  if (result.retryCount >= phase.retryLimit && result.status !== 'success') {
    return { action: 'notify_user', reason: `${phase.title} 已重试 ${phase.retryLimit} 次仍失败，是否终止？` }
  }
  // AC 发现 red → 通知用户
  if (phase.requiresAC && result.acFindings?.some((f) => f.severity === 'red')) {
    return { action: 'notify_user', reason: 'AC 审计发现严重问题，请查看后决定' }
  }
  // 正常完成 → 用户确认
  if (phase.requiresUserConfirmation) {
    return { action: 'ask_user' }
  }
  // 无需确认 → 自动推进
  return { action: 'advance' }
}

// ===== 最低内容格式检查（修正 Y5） =====

const FORMAT_CHECKS: Record<PhaseId, (content: string) => boolean> = {
  requirements: (c) => c.includes('# ') || c.includes('## '),
  prototype: (c) => c.includes('<html') || c.includes('<!DOCTYPE') || c.includes('<div'),
  architecture: (c) => c.includes('# ') || c.includes('## '),
  planning: (c) => c.includes('# ') || c.includes('## '),
  delivered: () => true,
}

/** 检查产出文件内容是否符合最低格式要求 */
export function checkOutputFormat(phaseId: PhaseId, content: string): boolean {
  const check = FORMAT_CHECKS[phaseId]
  return check ? check(content) : true
}
