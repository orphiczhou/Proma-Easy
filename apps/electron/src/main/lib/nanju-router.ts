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

// ===== 类型定义 =====

export type PhaseId = 'requirements' | 'prototype' | 'architecture' | 'planning' | 'delivered'

interface PhaseNode {
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
  /** AC 审计攻击者配置（必须与 channel/model 不同家族） */
  acAttackerChannel?: string
  acAttackerModel?: string
  /** AC 审计防御者配置（必须与攻击者不同家族） */
  acDefenderChannel?: string
  acDefenderModel?: string
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
  acAttackerChannel: undefined,
  acAttackerModel: undefined,
  acDefenderChannel: undefined,
  acDefenderModel: undefined,
}

const REQUIREMENTS: PhaseNode = {
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
  // AC: 攻击者用 GLM，防御者用 MiniMax（与 deepseek 不同家族）
  acAttackerChannel: 'glm-zhipu',
  acAttackerModel: 'glm-5.2',
  acDefenderChannel: 'deepseek',
  acDefenderModel: 'deepseek-v4-pro',
}

// ===== 工厂函数（修正 R2：显式定义所有节点） =====

function makeRoute(mode: ProjectMode): PhaseNode[] {
  const prototype: PhaseNode = {
    id: 'prototype',
    role: 'ux-advisor',
    title: 'UX 顾问',
    channel: 'glm-zhipu',
    model: 'glm-5.2',
    task: '你是 UX 顾问。根据 PRD 生成可交互 HTML 原型。',
    outputPath: '02_UX_DESIGN/prototype.html',
    constraints: ['单文件 HTML，内联 CSS', '简洁现代风格', '覆盖 PRD 核心功能', '包含核心页面的可点击导航'],
    requiresUserConfirmation: true,
    requiresAC: false,
    retryLimit: 2,
    next: mode === 'quick' ? 'delivered' : 'architecture',
    // AC: 攻击者用 deepseek，防御者用 MiniMax（与 glm 不同家族）
    acAttackerChannel: 'deepseek',
    acAttackerModel: 'deepseek-v4-pro',
    acDefenderChannel: 'glm-zhipu',
    acDefenderModel: 'glm-5.2',
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
    // AC: 攻击者用 GLM，防御者用 MiniMax（与 deepseek 不同家族）
    acAttackerChannel: 'glm-zhipu',
    acAttackerModel: 'glm-5.2',
    acDefenderChannel: 'deepseek',
    acDefenderModel: 'deepseek-v4-pro',
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
    // AC: 攻击者用 GLM，防御者用 MiniMax（与 deepseek 不同家族）
    acAttackerChannel: 'glm-zhipu',
    acAttackerModel: 'glm-5.2',
    acDefenderChannel: 'deepseek',
    acDefenderModel: 'deepseek-v4-pro',
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
