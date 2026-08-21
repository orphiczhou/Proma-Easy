/**
 * 南大向导「向导图」共享契约
 *
 * 主进程（nanju-router / nanju-router-prompt）与渲染端（guide-dsl）
 * 共用的类型与常量，避免双实现漂移。
 *
 * 注意：本文件是纯类型/常量模块，不得引入 electron 或运行时依赖。
 */

/** 南大项目模式：quick=快消型（4 阶段），iterative=长期迭代型（6 阶段，均含 delivered 哨兵） */
export type NanjuProjectMode = 'quick' | 'iterative'

/** 调度员 Todo 标题强制前缀（nanju-router-prompt 建 Todo 时使用，向导图徽标按此解析） */
export const PHASE_TODO_PREFIX: Record<'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding', string> = {
  requirements: '需求阶段：',
  prototype: '原型阶段：',
  architecture: '架构阶段：',
  planning: '规划阶段：',
  coding: '开发阶段：',
}

/** AC 攻/防角色配置（resolveACActors 的解析结果） */
export interface GuideACActors {
  attacker: { channel: string; model: string }
  defender: { channel: string; model: string }
}

/**
 * 向导图使用的阶段节点：nanju-router PhaseNode 序列化 + 附加 AC 攻防解析结果。
 *
 * 注意：数组含 id==='delivered' 的哨兵空节点（role/outputPath 均为空串），
 * 渲染端负责过滤（PRD 修订 Y3）。
 */
export interface GuideRoutePhase {
  id: string
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
  next: string | null
  taskWeight?: 'light' | 'medium'
  acAttackerChannel?: string
  acAttackerModel?: string
  acDefenderChannel?: string
  acDefenderModel?: string
  /** resolveACActors(phase) 的解析结果（主进程附加，渲染端不复制 AC_PRESETS） */
  acActors: GuideACActors
}
