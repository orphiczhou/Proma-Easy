/**
 * 南大项目元数据管理
 *
 * 基于 Proma 的 safe-file.ts 原子写 + 文件系统存储，
 * 不引入数据库。项目元数据存储在工作区的 workspace-files/ 下。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeJsonFileAtomic, readJsonFileSafe } from './safe-file'
import { getWorkspaceFilesDir, getAgentWorkspacePath } from './config-paths'

// ===== 类型 =====

export type ProjectMode = 'quick' | 'iterative'
export type ProjectStatus = 'active' | 'completed' | 'abandoned'
export type ProjectStage =
  | 'mode-select' | 'requirements' | 'prototype'
  | 'architecture' | 'planning' | 'coding' | 'testing' | 'delivered'

export interface NanjuProject {
  projectId: string
  name: string
  mode: ProjectMode
  status: ProjectStatus
  currentStage: ProjectStage
  createdAt: string
  updatedAt: string
  /** 关联的 Agent 会话 ID */
  sessionId?: string
  /** 工作区 slug */
  workspaceSlug: string
  /** 关联的 tree-engine tree_id */
  treeId?: string
}

/** 可挂熔断计数器的阶段（终态 delivered 不参与） */
export type NanjuGuardStage = 'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing'

/** 单阶段熔断计数状态（持久化于 _project-info.json 的 phaseGuards） */
export interface PhaseGuardState {
  /** 判定失败轮次（GWT verdict=fail 等产出性失败） */
  failCount: number
  /** 执行异常轮次（GWT verdict=error / L2 委派硬超时；异常非代码缺陷，重试无意义） */
  errorCount: number
  /** 最近一次 fail/error 的时间（ISO） */
  lastErrorAt?: string
}

/** _project-info.json 文件结构（项目目录内，createNanjuProject 时创建） */
export interface NanjuProjectInfoFile {
  projectId: string
  name: string
  mode: ProjectMode
  sessionId?: string
  createdAt: string
  workspaceSlug: string
  projectDir: string
  docDirs: string[]
  /** 熔断状态机（v0.17.64 Sprint C1）：按阶段累计 fail/error，阈值见 NANJU_GUARDS */
  phaseGuards?: Partial<Record<NanjuGuardStage, PhaseGuardState>>
}

/**
 * 南大向导护栏配置（v0.17.64 Sprint C1，Sprint C 设计稿 Q2/Q3）。
 *
 * 常量对象而非散落字面量：软/硬超时与熔断阈值集中一处，注释说明语义与可调性。
 * C2 计划接设置 UI（guardsConfig per-project 覆盖）；当前为全局默认值。
 */
export const NANJU_GUARDS = {
  /** L2 委派软超时（毫秒，默认 20 分钟）：超时向 L1 注入催办（检查状态或重派），不强停 */
  delegationSoftTimeoutMs: 20 * 60 * 1000,
  /** L2 委派硬超时（毫秒，默认 35 分钟）：超时 stop_delegation 强停 + 记 errorCount + 注入重派指令 */
  delegationHardTimeoutMs: 35 * 60 * 1000,
  /** 超时轮询间隔（毫秒，默认 60 秒）：精度下限，实际触发时点最多滞后一个间隔 */
  delegationPollIntervalMs: 60 * 1000,
  /** 熔断阈值：阶段 failCount 累计达到该值即熔断（与 PhaseNode.retryLimit/testing GWT_RETRY_LIMIT=2 对齐） */
  phaseFailBreakThreshold: 2,
  /** 熔断阈值：阶段 errorCount 累计达到该值即熔断（执行异常重试无意义，1 次即熔断） */
  phaseErrorBreakThreshold: 1,
} as const

// ===== 路径 =====

function getMetaPath(workspaceSlug: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), '_nanju-projects.json')
}

/** _project-info.json 路径 */
function getProjectInfoPath(workspaceSlug: string, projectId: string): string {
  return join(getNanjuProjectDir(workspaceSlug, projectId), '_project-info.json')
}

/** 获取项目目录路径 */
export function getNanjuProjectDir(workspaceSlug: string, projectId: string): string {
  return join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
}

// ===== 公开接口 =====

/** 获取所有南大项目 */
export function listNanjuProjects(workspaceSlug: string): NanjuProject[] {
  const meta = (readJsonFileSafe<NanjuProject[]>(getMetaPath(workspaceSlug)) ?? [])
  return meta ?? []
}

/** 创建南大项目 */
export function createNanjuProject(input: {
  name: string
  mode: ProjectMode
  workspaceSlug: string
  sessionId?: string
}): NanjuProject {
  const now = new Date().toISOString()
  // 使用项目名生成 slug：project-{slugified-name}
  const slugBase = input.name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'untitled'
  const projectId = slugBase

  // 避免重名
  const existing = listNanjuProjects(input.workspaceSlug)
  let uniqueId = projectId
  let counter = 2
  while (existing.some((p) => p.projectId === uniqueId)) {
    uniqueId = `${projectId}-${counter}`
    counter++
  }

  const project: NanjuProject = {
    projectId: uniqueId,
    name: input.name,
    mode: input.mode,
    status: 'active',
    currentStage: 'requirements',
    createdAt: now,
    updatedAt: now,
    sessionId: input.sessionId,
    workspaceSlug: input.workspaceSlug,
  }

  existing.push(project)
  writeJsonFileAtomic(getMetaPath(input.workspaceSlug), existing)

  // 创建文档目录骨架，使用 project-{slugified-name} 格式（08_APP：P1 Sprint A coding 阶段产物目录）
  const docDirs = [
    '01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE',
    '04_API_SPEC', '05_PROJECT_PLAN', '06_TESTS', '07_VERSIONS', '08_APP',
  ]
  const wsFilesDir = getWorkspaceFilesDir(input.workspaceSlug)
  const projectDir = join(wsFilesDir, `project-${uniqueId}`)
  mkdirSync(projectDir, { recursive: true })
  for (const dir of docDirs) {
    mkdirSync(join(projectDir, dir), { recursive: true })
  }

  // 创建项目背景信息文件
  const projectInfo = {
    projectId: uniqueId,
    name: input.name,
    mode: input.mode,
    sessionId: input.sessionId,
    createdAt: now,
    workspaceSlug: input.workspaceSlug,
    projectDir: `project-${uniqueId}`,
    docDirs,
  }
  writeJsonFileAtomic(join(projectDir, '_project-info.json'), projectInfo)

  return project
}

/** 更新南大项目 */
export function updateNanjuProject(
  workspaceSlug: string,
  projectId: string,
  updates: Partial<NanjuProject>,
): NanjuProject | null {
  const projects = listNanjuProjects(workspaceSlug)
  const idx = projects.findIndex((p) => p.projectId === projectId)
  if (idx === -1) return null

  const existing = projects[idx]
  if (!existing) return null

  const updated: NanjuProject = {
    ...existing,
    ...updates,
    projectId: existing.projectId,
    createdAt: existing.createdAt,
    workspaceSlug: existing.workspaceSlug,
    updatedAt: new Date().toISOString(),
  }
  projects[idx] = updated

  writeJsonFileAtomic(getMetaPath(workspaceSlug), projects)
  return updated
}

/** 获取单个南大项目 */
export function getNanjuProject(
  workspaceSlug: string,
  projectId: string,
): NanjuProject | null {
  const projects = listNanjuProjects(workspaceSlug)
  const found = projects.find((p) => p.projectId === projectId)
  return found ?? null

}

/** 删除南大项目 */
export function deleteNanjuProject(
  workspaceSlug: string,
  projectId: string,
): boolean {
  const projects = listNanjuProjects(workspaceSlug)
  const filtered = projects.filter((p) => p.projectId !== projectId)
  if (filtered.length === projects.length) return false
  writeJsonFileAtomic(getMetaPath(workspaceSlug), filtered)
  return true
}

// ===== 熔断状态机（v0.17.64 Sprint C1：Sprint C 设计稿 Q2） =====

/** 读取 _project-info.json（不存在/损坏返回 null，不抛错——门禁与计数均容错降级） */
function readProjectInfo(workspaceSlug: string, projectId: string): NanjuProjectInfoFile | null {
  try {
    const path = getProjectInfoPath(workspaceSlug, projectId)
    if (!existsSync(path)) return null
    return readJsonFileSafe<NanjuProjectInfoFile>(path) ?? null
  } catch {
    return null
  }
}

/** 原子写回 _project-info.json（目录缺失时先建——老项目升级路径；保留未知字段向后兼容） */
function writeProjectInfo(workspaceSlug: string, projectId: string, info: NanjuProjectInfoFile): void {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })
  writeJsonFileAtomic(join(projectDir, '_project-info.json'), info)
}

/** 读取全部阶段熔断计数（无文件/无字段时返回空对象） */
export function getPhaseGuards(
  workspaceSlug: string,
  projectId: string,
): Partial<Record<NanjuGuardStage, PhaseGuardState>> {
  return readProjectInfo(workspaceSlug, projectId)?.phaseGuards ?? {}
}

/** 熔断判定（纯函数）：failCount 或 errorCount 达到 NANJU_GUARDS 阈值即 open */
export function isPhaseGuardCircuitOpen(
  state: PhaseGuardState | undefined,
): { open: boolean; reason: string | null } {
  if (!state) return { open: false, reason: null }
  if (state.errorCount >= NANJU_GUARDS.phaseErrorBreakThreshold) {
    return { open: true, reason: `执行异常累计 ${state.errorCount} 次（阈值 ${NANJU_GUARDS.phaseErrorBreakThreshold}）` }
  }
  if (state.failCount >= NANJU_GUARDS.phaseFailBreakThreshold) {
    return { open: true, reason: `阶段失败累计 ${state.failCount} 次（阈值 ${NANJU_GUARDS.phaseFailBreakThreshold}）` }
  }
  return { open: false, reason: null }
}

/**
 * 熔断计数更新——唯一写入点（Sprint C 设计稿风险提示：多写入点会造成计数漂移，
 * 所有计数变化必须经此函数：GWT fail/error 轮次、L2 委派硬超时、阶段推进重置）。
 *
 * 返回 previous（更新前）与 current（更新后），调用方据此判定「本轮是否新熔断」
 * （previous 未达阈值且 current 达阈值 = 状态从 closed → open，此时记 circuit_break 埋点）。
 */
export function updatePhaseGuard(
  workspaceSlug: string,
  projectId: string,
  stage: NanjuGuardStage,
  update: { kind: 'fail' | 'error' | 'reset'; note?: string },
): { previous: PhaseGuardState | null; current: PhaseGuardState } {
  const info = readProjectInfo(workspaceSlug, projectId)
  // 项目信息文件缺失时构造最小骨架（老项目升级路径：v0.17.63 前创建的项目无 phaseGuards 字段）
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  const guards = base.phaseGuards ?? {}
  const previous = guards[stage] ?? null
  const empty: PhaseGuardState = { failCount: 0, errorCount: 0 }

  let current: PhaseGuardState
  if (update.kind === 'reset') {
    current = { ...empty }
  } else if (update.kind === 'fail') {
    current = {
      failCount: (previous?.failCount ?? 0) + 1,
      errorCount: previous?.errorCount ?? 0,
      lastErrorAt: new Date().toISOString(),
    }
  } else {
    current = {
      failCount: previous?.failCount ?? 0,
      errorCount: (previous?.errorCount ?? 0) + 1,
      lastErrorAt: new Date().toISOString(),
    }
  }

  base.phaseGuards = { ...guards, [stage]: current }
  writeProjectInfo(workspaceSlug, projectId, base)
  if (update.note) {
    // note 仅作日志留痕，不写入文件（避免与 06_TESTS/report.json 事实源重复）
    console.log(`[南大护栏] phaseGuard 更新 ${projectId}/${stage}: ${update.kind}（${update.note}）→ fail=${current.failCount} error=${current.errorCount}`)
  }
  return { previous, current }
}
