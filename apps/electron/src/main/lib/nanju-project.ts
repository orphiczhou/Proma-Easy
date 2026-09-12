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

/**
 * 工程品类（W3，v0.17.66）：coding 阶段工程样板前置——按项目形态选择工程模板。
 * 枚举与 resources/nanju-engineering-templates/ 下的模板文件一一对应。
 */
export type ProjectCategory =
  | 'web-fullstack'
  | 'api-backend'
  | 'mobile-app'
  | 'desktop-app'
  | 'cli-tool'
  | 'ai-application'

/** 品类枚举清单（判定提取的合法值域；提取值不在枚举内视为无效标记） */
export const PROJECT_CATEGORIES: readonly ProjectCategory[] = [
  'web-fullstack', 'api-backend', 'mobile-app', 'desktop-app', 'cli-tool', 'ai-application',
] as const

/** 品类值合法性检查 */
export function isProjectCategory(value: string): value is ProjectCategory {
  return (PROJECT_CATEGORIES as readonly string[]).includes(value)
}

/** 品类判定来源（审计用：标记从哪个文档提取，还是降级默认值） */
export type ProjectCategorySource = 'architecture' | 'prd' | 'default'

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
  /**
   * v2.4 自动补完需求（D7 §5）：快消模式勾选状态与代理预算（持久化于
   * _nanju-projects.json）。enabled=需求补充类问题交 nanju_clarify_proxy 代理
   * 作答；proxyBudget=代理调用预算余量（cap=20）；pendingQuestionIds=代理
   * 已登记待回注的 blocked 事件问题 id。缺失 = 未开启（存量项目零变化）。
   * 存取走 getProjectAutoClarify/updateProjectAutoClarify（唯一写入点纪律）。
   */
  autoClarify?: NanjuAutoClarifyState
}

/** v2.4 自动补完需求持久化状态（NanjuProject.autoClarify） */
export interface NanjuAutoClarifyState {
  /** 是否开启代理作答（快消卡勾选；关闭/升级即失效，D7 §0 硬边界） */
  enabled: boolean
  /** 代理调用预算余量（cap=20；缺省=NANJU_GUARDS.autoClarifyBudgetCap；由 nanju-clarify-proxy-tool 消费递减） */
  proxyBudget?: number
  /** 代理已登记待回注的 blocked 事件问题 id（缺省=空；clarify 工具写入/清除） */
  pendingQuestionIds?: string[]
  /** W22（M-9）：开关最近一次切换时间（ISO；updateNanjuProject 检测到 enabled 变化时自动盖戳，
   * 覆盖 IPC 直写与 updateProjectAutoClarify 两条写入路径；供渲染端/prompt 消费侧展示变更事实） */
  lastToggledAt?: string
}

/** autoClarify 规范化读视图（getProjectAutoClarify/updateProjectAutoClarify 返回形态：
 *  缺省字段已填（proxyBudget=cap、pendingQuestionIds=[]）——消费方（clarify 工具）
 *  免于逐字段判空；写入方（IPC/勾选链路）可按需部分提供） */
export interface NanjuAutoClarifyView {
  enabled: boolean
  proxyBudget: number
  pendingQuestionIds: string[]
  /** W22（M-9）：开关最近一次切换时间（ISO；未切换过为 undefined） */
  lastToggledAt?: string
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

/**
 * 跨大环节回归事件（W2c 判定协议 v1，AC plan-audit A4/A11）：
 * from/to 为阶段 id（如 prototype→requirements / testing→coding），count 为同边
 * 5 分钟窗口内去重合并后的累计次数；at 为该事件（组）首次触发时间。
 */
export interface RegressionEvent {
  from: ProjectStage
  to: ProjectStage
  at: string
  reason: string
  count: number
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
  /** 工程品类（W3，v0.17.66）：推进到 coding 时从 architecture/prd 标记提取后写入；缺失表示尚未判定 */
  projectCategory?: ProjectCategory
  /** 品类判定来源：architecture 文档标记 / prd 标记 / 降级默认（web-fullstack） */
  projectCategorySource?: ProjectCategorySource
  /**
   * 向导图阶段内子步骤（W2 S1）：当前阶段的推进位置（主节点 id 或 {主节点}_UC，
   * 见 nanju-guide-progress.ts 的 GUIDE_SUBSTAGE_SEQUENCE 契约）。
   * 空串 = 已交付等无子步骤态；缺失 = 存量项目（渲染端降级为现状全灰，安全）。
   * 唯一写入点 setProjectSubStage（阶段推进/产出确认钩子），避免多写入点漂移。
   */
  subStage?: string
  /**
   * 跨大环节回归事件（W2c，v0.17.69）：UX→PRD 新需求 / GWT 失败回炉等跨阶段回退的
   * 留痕记录。唯一写入点 recordRegressionEvent（nanju-regression.ts，同 to 5 分钟
   * 窗口内合并 count++）；渲染端按 from/to 聚合画回归边。缺失 = 无回归（新/存量项目）。
   */
  regressionEvents?: RegressionEvent[]
  /**
   * 工程环境就绪状态（W7，v0.17.69）：architecture 阶段解析 architecture.md 的
   * `projectEnv:` 标记行后由 setProjectEnvState 置位（唯一写入点）。
   * true = 全部就绪；false = 有缺失（组件清单见 envCheck）；undefined = 未检查
   * （存量项目豁免口径：门禁只在显式 false 时拦截，见 nanju-router-gate.ts）。
   * 品类变更时由 setProjectCategory diff 重置为 undefined（R8：换品类需重新检查）。
   */
  envReady?: boolean
  /** 环境检查明细（与 envReady 同批写入）：组件/版本/是否就绪/缺失原因/检查时间 */
  envCheck?: Array<{ component: string; version?: string; ok: boolean; reason?: string; attemptedAt: string }>
  /** 最近一次环境检查时间（ISO） */
  checkedAt?: string
  /**
   * 确认待推进阶段（W10，v0.17.72）：用户确认词 + 本阶段产出达标（verifyPhaseOutput null）
   * 时由唯一写入点 setProjectConfirmPending 置位（=当时 currentStage）；PHASE_ADVANCE
   * 推进成功时清除（clearProjectConfirmPending）；用户反义词清除。非空且 = 当前阶段 →
   * getNanjuRouterPrompt 注入强推进提示（不自动推进——推进权在 L1 输出标记）。
   * 缺失 = 无待推进（新/存量项目，可选字段向后兼容）。
   */
  confirmPendingStage?: string
  /**
   * 交付满意确认（W18 Wave2，v0.17.83）：用户经 AskUserQuestion 精确应答「满意交付」且
   * 双事实门禁前置满足时由唯一写入点 setProjectDeliveryAck 置位；delivered 推进成功后
   * 由 clearProjectDeliveryAck 终态清理（防下个项目误读）。缺失 = 无有效确认。
   */
  deliveryAck?: { at: string; reportRunId: string }
  /**
   * 待应答交付挑战（W18 Wave2）：GWT-pass 注入验收消息时由唯一写入点
   * setProjectDeliveryChallenge 登记（记录当时 report.runId + 会话 + 时间）；
   * 应答只认登记值（防旧问题延迟作答绑到新报告）。ask-answer 置位 ack 时清除；
   * 交付否定词 / 下次 GWT-pass 注入重建时清除。缺失 = 无待应答挑战。
   */
  deliveryChallenge?: { reportRunId: string; sessionId: string; askedAt: string }
  /**
   * W22（R1 前半）：coding 阶段内最近一次新建委派的 ID（唯一写入点
   * setProjectCodingDelegationId——按阶段判定不按 title 关键词；重复出现覆盖为最新）。
   * GWT behavior-fail 回炉文案携带该 ID 指引 continue_delegation 原委派修复
   *（保留上下文，不新建修复会话）；ID 不存在时回炉文案降级为「新建但沿用 coding
   * 配置渠道」。缺失 = 尚无 coding 委派（新/存量项目）。
   */
  codingDelegationId?: string
  /**
   * W22（F5 ④）：拒收续接失败时的「待纠正拒因」登记（advance.reject-escalate
   * kind=continuation-giveup 同拍写入；唯一写入点 setProjectPendingAdvanceCorrection）。
   * 阶段推进成功时由消费侧清除（clearProjectPendingAdvanceCorrection）——待下轮
   * prompt 消费侧接线（C 域）。缺失 = 无待纠正拒因。
   */
  pendingAdvanceCorrection?: {
    /** 拒收门类：target-deny（W11 目标校验）/ gate-deny（硬门无授权/auto-gate） */
    kind: 'target-deny' | 'gate-deny'
    /** 被拒的标记目标 */
    target: string
    /** 合法下一阶段（终态时为空串） */
    expected: string
    /** 登记时间（ISO） */
    at: string
    /** 登记时的累计拒收次数 */
    count: number
  }
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
  /**
   * 熔断阈值：阶段失败事件数（failCount 从 1 起累计）达到该值即熔断。
   * 3 = 首次产出失败 1 次 + 回炉失败 2 次（与 testing GWT_RETRY_LIMIT=2 的回炉预算时点对齐；
   * v0.17.65 AC Z-1：原值 2 会让首产失败后仅剩 1 次回炉，回炉预算被缩水 1 轮）。
   */
  phaseFailBreakThreshold: 3,
  /** 熔断阈值：阶段 errorCount 累计达到该值即熔断（执行异常重试无意义，1 次即熔断） */
  phaseErrorBreakThreshold: 1,
  /**
   * v2.4 自动补完需求代理预算上限（D7 §4：cap=20）——单项目 nanju_clarify_proxy
   * 可用预算余量基准；由代理工具消费递减，不随熔断时钟复位（独立预算账户）。
   */
  autoClarifyBudgetCap: 20,
} as const

/** autoClarify 默认预算（存取器缺省骨架用；与 NANJU_GUARDS.autoClarifyBudgetCap 同源） */
export const NANJU_AUTO_CLARIFY_BUDGET_CAP = NANJU_GUARDS.autoClarifyBudgetCap

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

  const updatesWithToggleStamp: Partial<NanjuProject> = { ...updates }
  // W22（M-9）：autoClarify 写入统一走字段级 merge（未提供字段保留现状——防部分写入
  // 丢 lastToggledAt 等）；enabled 变化（含首次开启）→ 自动盖 lastToggledAt（单一检测点，
  // 覆盖 nanju-ipc set-auto-clarify 直写与 updateProjectAutoClarify 两条写入路径）
  if (updates.autoClarify && typeof updates.autoClarify === 'object') {
    const enabledChanged = updates.autoClarify.enabled !== undefined
      && updates.autoClarify.enabled !== (existing.autoClarify?.enabled === true)
    updatesWithToggleStamp.autoClarify = {
      ...existing.autoClarify,
      ...updates.autoClarify,
      ...(enabledChanged ? { lastToggledAt: new Date().toISOString() } : {}),
    }
  }

  const updated: NanjuProject = {
    ...existing,
    ...updatesWithToggleStamp,
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

// ===== v2.4 自动补完需求：autoClarify 存取（D7 §5；唯一写入点纪律） =====

/** 读取 autoClarify 状态（规范化视图：缺省字段已填；未开启返回 null；字段缺失兼容旧数据） */
export function getProjectAutoClarify(
  workspaceSlug: string,
  projectId: string,
): NanjuAutoClarifyView | null {
  const state = getNanjuProject(workspaceSlug, projectId)?.autoClarify
  if (!state) return null
  return {
    enabled: state.enabled === true,
    proxyBudget: typeof state.proxyBudget === 'number' ? state.proxyBudget : NANJU_AUTO_CLARIFY_BUDGET_CAP,
    pendingQuestionIds: Array.isArray(state.pendingQuestionIds) ? state.pendingQuestionIds : [],
    lastToggledAt: typeof state.lastToggledAt === 'string' ? state.lastToggledAt : undefined,
  }
}

/** 局部更新 autoClarify（read-merge-write；未开启时以默认骨架打底；返回规范化视图） */
export function updateProjectAutoClarify(
  workspaceSlug: string,
  projectId: string,
  patch: Partial<NanjuAutoClarifyState>,
): NanjuAutoClarifyView {
  const current = getProjectAutoClarify(workspaceSlug, projectId) ?? {
    enabled: false,
    proxyBudget: NANJU_AUTO_CLARIFY_BUDGET_CAP,
    pendingQuestionIds: [],
  }
  const next: NanjuAutoClarifyView = {
    enabled: patch.enabled ?? current.enabled,
    proxyBudget: patch.proxyBudget ?? current.proxyBudget,
    pendingQuestionIds: patch.pendingQuestionIds ?? current.pendingQuestionIds,
    // W22（M-9）：未显式携带时透传现状戳；enabled 变化时由 updateNanjuProject 统一盖新戳
    lastToggledAt: patch.lastToggledAt ?? current.lastToggledAt,
  }
  updateNanjuProject(workspaceSlug, projectId, { autoClarify: next })
  return next
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

/** 读取 _project-info.json（不存在/损坏返回 null，不抛错——门禁与计数均容错降级）。
 *  v0.17.69 起导出：nanju-regression.ts 的回归事件读写复用同一 read-construct-write
 *  纪律（保留未知字段向后兼容），避免第二套读写实现漂移。 */
export function readProjectInfo(workspaceSlug: string, projectId: string): NanjuProjectInfoFile | null {
  try {
    const path = getProjectInfoPath(workspaceSlug, projectId)
    if (!existsSync(path)) return null
    return readJsonFileSafe<NanjuProjectInfoFile>(path) ?? null
  } catch {
    return null
  }
}

/** 原子写回 _project-info.json（目录缺失时先建——老项目升级路径；保留未知字段向后兼容）。
 *  v0.17.69 起导出（同 readProjectInfo，供 nanju-regression.ts 复用）。 */
export function writeProjectInfo(workspaceSlug: string, projectId: string, info: NanjuProjectInfoFile): void {
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

// ===== 工程品类读写（W3，v0.17.66：coding 阶段工程样板前置） =====

/**
 * 写入品类判定结果（保留未知字段向后兼容；老项目无该字段时自动补齐骨架）。
 * 唯一写入点：coding 推进钩子（agent-orchestrator）调用，避免多写入点漂移。
 *
 * R8 品类变更重置（W7，v0.17.69）：已存品类 ≠ 新品类 → envReady 清 undefined
 * （resetEnvReady 语义并入此函数，保持唯一写入点纪律）——换品类后环境清单
 * 基准变化，旧 envReady 结论失效，需在重新进入 architecture 流程时重新检查。
 */
export function setProjectCategory(
  workspaceSlug: string,
  projectId: string,
  category: ProjectCategory,
  source: ProjectCategorySource,
): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  // 品类变更 diff（R8）：重置环境就绪状态（undefined = 未检查，门禁按存量豁免放行）
  if (base.projectCategory !== undefined && base.projectCategory !== category) {
    base.envReady = undefined
    base.checkedAt = undefined
    // envCheck 明细一并清空：旧品类组件清单对新品类无参考意义
    base.envCheck = undefined
  }
  base.projectCategory = category
  base.projectCategorySource = source
  writeProjectInfo(workspaceSlug, projectId, base)
}

/**
 * 读取品类判定结果。无文件/无字段时返回 null（调用方自行降级，不在读取层纠错）。
 */
export function getProjectCategory(
  workspaceSlug: string,
  projectId: string,
): { category: ProjectCategory; source: ProjectCategorySource } | null {
  const info = readProjectInfo(workspaceSlug, projectId)
  if (!info?.projectCategory || !isProjectCategory(info.projectCategory)) return null
  return {
    category: info.projectCategory,
    source: info.projectCategorySource ?? 'default',
  }
}

// ===== 向导图子步骤读写（W2 S1，v0.17.68：阶段内两态推进——产出中/等确认） =====

/**
 * 写入当前阶段子步骤（唯一写入点，setProjectCategory 同型 read-construct-write 纪律：
 * readProjectInfo 现有对象直接挂字段再 writeProjectInfo，保留 projectCategory 等未知字段；
 * 老项目无文件时自动补齐骨架）。
 *
 * 写入必须先于 emitGuideProgress 广播（write-then-emit）：渲染端冷启动 snapshot
 * 与事件统一按 seq 高者胜，先写后发保证 snapshot 读到的数据不旧于已发事件。
 */
export function setProjectSubStage(
  workspaceSlug: string,
  projectId: string,
  subStage: string,
  opts?: { force?: boolean },
): void {
  // D8 S4′-1（R7-04）：阶段序数单调守卫——同阶段内仅允许序数前进（新序 ≥ 现序），
  // 防写入点乱序回退向导图（如 blocked→CLARIFY 之后又被旧事件拉回主节点以下）。
  // 规则：空串（清空/重置）与未知值（不在任何阶段序列，如 ${主节点}_CLARIFY sentinel，
  // 视为 -1）不参与拦截；跨阶段（新值与现值属于不同阶段序列，阶段切换）bypass——
  // 推进点写入新阶段主节点天然满足；opts.force 显式 bypass（delivered 清空等显式重置）。
  if (!opts?.force && subStage !== '') {
    try {
      const { GUIDE_SUBSTAGE_SEQUENCE } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
      // D8 F2-4（§十）：{主}_CLARIFY sentinel 纳入排序——序数=主节点后首位（0.5），
      // 低于一切子步骤与 UC：已 UC 后的 blocked 补问不使图回退；主节点→sentinel→子步骤
      // 均为前进；sentinel→主节点（blocked 解除恢复）走调用方显式 force 重置通道。
      const locate = (nodeId: string): { stage: string; index: number } | null => {
        for (const [stage, seq] of Object.entries(GUIDE_SUBSTAGE_SEQUENCE)) {
          const idx = seq.indexOf(nodeId)
          if (idx >= 0) return { stage, index: idx }
          const main = seq[0]
          if (main && nodeId === `${main}_CLARIFY`) return { stage, index: 0.5 }
        }
        return null
      }
      const current = getProjectSubStage(workspaceSlug, projectId)
      if (current && current !== '') {
        const next = locate(subStage)
        const prev = locate(current)
        if (next && prev && next.stage === prev.stage && next.index < prev.index) {
          console.warn(`[南大向导图] 子步骤单调守卫拦截回退写入: ${current} → ${subStage}（同阶段序数回退，不落盘）`)
          return
        }
      }
    } catch { /* 序列解析失败（模块环等）不阻断写入——守卫是加固不是硬门 */ }
  }
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.subStage = subStage
  writeProjectInfo(workspaceSlug, projectId, base)
}

/** 读取当前阶段子步骤。无文件/无字段返回 null（渲染端降级为现状全灰着色，不纠错）。 */
export function getProjectSubStage(
  workspaceSlug: string,
  projectId: string,
): string | null {
  return readProjectInfo(workspaceSlug, projectId)?.subStage ?? null
}

// ===== D8 S4′：向导图子步骤事实写入点（归因+阶段产出匹配版） =====

/**
 * D8 S4′-2：带归因与阶段校验的子步骤写入（watch/gwt-runner/consumer 四写入点共用）。
 *
 * 校验链：项目存在 → 当前阶段在路由中有显式 outputPath（写入点语义绑定「作者产出
 * 阶段」——planning 等 quick 无此阶段的异常值自然不写）→ setProjectSubStage（含
 * S4′-1 单调守卫）→ write-then-emit 广播（失败不影响落盘，渲染端 10s 轮询兜底）。
 * @returns 是否实际写入（false = 归因失败/阶段无产出路径/单调守卫拦截）
 */
export function tryAdvanceGuideSubStage(
  workspaceSlug: string,
  projectId: string,
  nodeId: string,
  opts?: { force?: boolean },
): boolean {
  try {
    const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
    const project = getNanjuProject(workspaceSlug, projectId)
    if (!project) return false
    const stage = project.currentStage as import('./nanju-router').PhaseId
    if (!getPhaseNode(project.mode, stage)?.outputPath) return false
    setProjectSubStage(workspaceSlug, projectId, nodeId, opts)
    try {
      const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
      emitGuideProgress(project.sessionId ?? '', projectId, project.currentStage, nodeId)
    } catch { /* 广播失败不影响落盘 */ }
    return true
  } catch {
    return false
  }
}

/**
 * D8 S4′：L2 blocked「澄清中」sentinel 节点 id（{主节点}_CLARIFY）。
 *
 * 跨进程契约：渲染端 guide-dsl 当前无 CLARIFY 结构节点——sentinel 写入后 derive 按
 * 未知值回退（主节点 current，无害不破坏图）；渲染端点亮（DSL 加节点或 derive 识别
 * sentinel→CLARIFY 态）由 C 域后续消费，主进程事实源先行（D8 A 域先行精神）。
 * 单调守卫按未知值（-1）处理：不阻塞后续 ATK/UC 写入。
 */
export function getClarifySentinelNodeId(stage: string): string | null {
  try {
    const { getGuideStageMainNodeId } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
    const main = getGuideStageMainNodeId(stage)
    return main ? `${main}_CLARIFY` : null
  } catch {
    return null
  }
}

// ===== 工程环境就绪状态（W7，v0.17.69：architecture 阶段环境配置主进程置位） =====

/** 环境检查明细项（与 envCheck 字段同构；setProjectEnvState 入参用） */
export interface ProjectEnvCheckItem {
  component: string
  version?: string
  ok: boolean
  reason?: string
  attemptedAt: string
}

/**
 * 写入环境就绪状态（唯一写入点，setProjectCategory 同型纪律）。
 * 触发点：agent-orchestrator 在 architecture 产出验证前解析 architecture.md 的
 * `projectEnv: ready` / `projectEnv: missing:<组件列表>` 标记行后调用（write-then-gate：
 * 先置位再跑含 envReady 门禁的 verifyPhaseOutput）。老项目无文件时自动补齐骨架。
 */
export function setProjectEnvState(
  workspaceSlug: string,
  projectId: string,
  ready: boolean,
  check: ProjectEnvCheckItem[],
): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.envReady = ready
  base.envCheck = check
  base.checkedAt = new Date().toISOString()
  writeProjectInfo(workspaceSlug, projectId, base)
}

/**
 * 读取环境就绪状态。返回 envReady（undefined = 未检查：存量项目/尚未解析标记行）
 * 与缺失组件清单（envCheck 中 ok=false 的组件名，错误消息用）。
 */
export function getProjectEnvState(
  workspaceSlug: string,
  projectId: string,
): { envReady: boolean | undefined; missingComponents: string[]; envCheck: ProjectEnvCheckItem[] } {
  const info = readProjectInfo(workspaceSlug, projectId)
  const envCheck = info?.envCheck ?? []
  return {
    envReady: info?.envReady,
    missingComponents: envCheck.filter((c) => !c.ok).map((c) => c.component),
    envCheck,
  }
}

// ===== 确认响应推进检查（W10，v0.17.72：检测置位 + 提示注入 + 消费清除，不自动推进） =====

/**
 * 用户确认词表（工单 §2.1）：命中且产出达标时置位 confirmPendingStage。
 * 中文 includes / 纯英文 \b 词边界（大小写不敏感，同 guard 惯例——'ok' 不误命中 'skip'）。
 * 可演进常量：按 confirm.advance-hint 观察数据增删。
 */
export const CONFIRM_ADVANCE_KEYWORDS: readonly string[] = [
  '确认', '通过', '没问题', '好的', '可以', '继续', '推进', 'ok', 'approve',
  // W12（交付验收后置）：GWT-pass 后验收询问的确认选项词。「满意交付」整词入表而非裸「满意」
  // ——否定形「不太满意」含「满意」子串会误置位，整词形态天然避开（取舍见 w12-report §4）
  '满意交付',
  // v2.4（D7 §1 I1-②c）：「跳过」入确认词表——活跃确认问句在场的「跳过」应答
  // 与横幅「跳过」选项同义（跳过本环节即推进到下一阶段）；无活跃问句的散点
  // 「跳过」不授权（I1-②b 上下文绑定门管住，不靠词表收窄）
  '跳过',
]

/**
 * 确认反义词（工单 §2.1 排除反义；W10 修订轮 A2 必修扩充，裁决 20260903）：命中则【不算确认】
 * 且清除已置位的待推进状态（用户明确反悔——意味着产出要返工或暂缓，待推进提示必须撤下）。
 * 注意「不通过/没通过」含子串「通过」、「先别推进」含子串「推进」——反义判定必须先于确认词
 * 判定（见 isConfirmAdvanceText），否则反悔被反向置位（裁决 A2 加重证据实测修复）。
 * 扩词风险不对称性有利：clear 代价（撤一条提示，真确认可重置位）≪ set 误置位代价（引导推进）。
 */
export const CONFIRM_REJECT_KEYWORDS: readonly string[] = [
  '不通过', '没通过', '需要修复', '重做', '不行',
  '改主意', '先别', '暂缓', '再想想', '等等', '先停', '不急', '取消',
  // W12（交付验收后置）：验收询问的调整选项词 + 「满意」否定形——交付验收轮里用户明确要改
  // （或不满）时撤下待推进提示；与「满意交付」确认词配对，反义仍先于确认判定
  '需要调整', '不满意',
]

/** 词匹配（中文 includes / 纯英文 \b 词边界，大小写不敏感——同 nanju-delegate-guard 惯例；
 *  不复用 guard 的 keywordMatcher 避免 project↔guard 跨模块依赖） */
function confirmKeywordHit(text: string, keywords: readonly string[]): string | undefined {
  for (const kw of keywords) {
    if (/^[\x20-\x7E]+$/.test(kw)) {
      if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) return kw
    } else if (text.includes(kw)) {
      return kw
    }
  }
  return undefined
}

/** 用户文本是否为确认推进语义（纯函数）：反义词优先排除，再匹配确认词 */
export function isConfirmAdvanceText(text: string): boolean {
  if (confirmKeywordHit(text, CONFIRM_REJECT_KEYWORDS) !== undefined) return false
  return confirmKeywordHit(text, CONFIRM_ADVANCE_KEYWORDS) !== undefined
}

/** 用户文本是否为明确反悔语义（纯函数，调用方据此清除待推进状态） */
export function isConfirmRejectText(text: string): boolean {
  return confirmKeywordHit(text, CONFIRM_REJECT_KEYWORDS) !== undefined
}

/**
 * 确认检测判定（纯函数，agent-orchestrator 每条用户消息调用；置位/清除动作由调用方执行）。
 *
 * @param text 用户消息文本（type=user 且非 tool_result 的文本拼接）
 * @param currentStage 项目当前阶段
 * @param verifyError verifyPhaseOutput(currentStage) 的返回值（null = 产出达标）
 * @returns 'set' = 置位待推进（确认词 + 产出达标 + 活跃阶段）；'clear' = 清除（反义词）；
 *   'none' = 无动作（非确认文本 / 产出未达标 / 终态或选型阶段）
 *
 * 设计（工单 §2.3 防误触发）：产出未达标不置位（避免产出未完成时的误导）；确认词误触发
 * （闲聊「好的」）+ 产出达标 → 仍置位——注入提示本身无害（L1 若判断无需推进会向用户说明）。
 */
export function judgeConfirmAdvance(
  text: string,
  currentStage: string,
  verifyError: string | null,
): 'set' | 'clear' | 'none' {
  if (isConfirmRejectText(text)) return 'clear'
  if (currentStage === 'delivered' || currentStage === 'mode-select') return 'none'
  if (!isConfirmAdvanceText(text)) return 'none'
  if (verifyError !== null) return 'none'
  return 'set'
}

/** 置位确认待推进（唯一写入点，setProjectSubStage 同型 read-construct-write 纪律；幂等） */
export function setProjectConfirmPending(workspaceSlug: string, projectId: string, stage: string): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.confirmPendingStage = stage
  writeProjectInfo(workspaceSlug, projectId, base)
}

/** 清除确认待推进（PHASE_ADVANCE 推进成功 / 用户反义词；幂等——无字段时 no-op） */
export function clearProjectConfirmPending(workspaceSlug: string, projectId: string): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  if (!info || info.confirmPendingStage === undefined) return
  info.confirmPendingStage = undefined
  writeProjectInfo(workspaceSlug, projectId, info)
}

// ===== 交付确认读写（W18 Wave2，v0.17.83：交付双事实门禁——用户确认侧） =====

/**
 * 交付否定词（工单 §1.2）：命中则清除 ack+challenge（用户明确反悔，待验收状态撤下）。
 * 仅用于清除，不承担置位排除——置位走 ask-answer 精确等值天然免疫否定形。
 * 扩词风险不对称性有利：clear 代价（撤一个待应答状态，真确认可重登记）≪ 误置位代价。
 */
export const DELIVERY_REJECT_WORDS: readonly string[] = [
  '不确认交付', '暂不确认', '不要交付', '不接受交付', '先不交付',
]

/** 读取交付确认（无文件/无字段返回 null） */
export function getProjectDeliveryAck(
  workspaceSlug: string,
  projectId: string,
): { at: string; reportRunId: string } | null {
  return readProjectInfo(workspaceSlug, projectId)?.deliveryAck ?? null
}

/** 读取待应答交付挑战（无文件/无字段返回 null） */
export function getProjectDeliveryChallenge(
  workspaceSlug: string,
  projectId: string,
): { reportRunId: string; sessionId: string; askedAt: string } | null {
  return readProjectInfo(workspaceSlug, projectId)?.deliveryChallenge ?? null
}

/**
 * 置位交付确认（唯一写入点，setProjectConfirmPending 同型 read-construct-write 纪律）。
 * 幂等：同 reportRunId 重复置位不重写（at 不变）；不同 reportRunId 防御性覆盖
 * （正常流不会出现——应答前置条件要求 challenge 在场，challenge 登记前旧 ack 已被注入侧清除）。
 * @returns 实际生效的 ack（含 at），供调用方埋点/日志。
 */
export function setProjectDeliveryAck(
  workspaceSlug: string,
  projectId: string,
  reportRunId: string,
  at?: string,
): { at: string; reportRunId: string; rewritten: boolean } {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  if (base.deliveryAck && base.deliveryAck.reportRunId === reportRunId) {
    return { at: base.deliveryAck.at, reportRunId, rewritten: false }
  }
  const writtenAt = at ?? new Date().toISOString()
  base.deliveryAck = { at: writtenAt, reportRunId }
  writeProjectInfo(workspaceSlug, projectId, base)
  return { at: writtenAt, reportRunId, rewritten: true }
}

/** 清除交付确认（delivered 终态清理 / 否定词反悔；幂等——无字段时 no-op） */
export function clearProjectDeliveryAck(workspaceSlug: string, projectId: string): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  if (!info || info.deliveryAck === undefined) return
  info.deliveryAck = undefined
  writeProjectInfo(workspaceSlug, projectId, info)
}

/**
 * 登记待应答交付挑战（唯一写入点：GWT-pass 注入验收消息前，记录当时 report.runId +
 * 会话 + 时间——应答只认登记值，见工单 §0 核心修正 1）。
 */
export function setProjectDeliveryChallenge(
  workspaceSlug: string,
  projectId: string,
  reportRunId: string,
  sessionId: string,
): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.deliveryChallenge = { reportRunId, sessionId, askedAt: new Date().toISOString() }
  writeProjectInfo(workspaceSlug, projectId, base)
}

/** 清除待应答交付挑战（ask-answer 已置 ack / 否定词反悔 / 下次注入重建前；幂等） */
export function clearProjectDeliveryChallenge(workspaceSlug: string, projectId: string): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  if (!info || info.deliveryChallenge === undefined) return
  info.deliveryChallenge = undefined
  writeProjectInfo(workspaceSlug, projectId, info)
}

/** 读取确认待推进阶段。无文件/无字段返回 null */
export function getProjectConfirmPending(workspaceSlug: string, projectId: string): string | null {
  return readProjectInfo(workspaceSlug, projectId)?.confirmPendingStage ?? null
}

// ===== W22（G 域）：codingDelegationId / pendingAdvanceCorrection（_project-info 落盘） =====

/**
 * W22（R1 前半）：读取 coding 阶段内最近一次新建委派的 ID（无/未登记返回 null）。
 * GWT behavior-fail 回炉文案消费：有 ID → continue_delegation(<ID>) 原委派修复；
 * 无 → 降级文案（新建但沿用 coding 配置渠道 GLM）。
 */
export function getProjectCodingDelegationId(workspaceSlug: string, projectId: string): string | null {
  const id = readProjectInfo(workspaceSlug, projectId)?.codingDelegationId
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * W22（R1 前半）：登记 codingDelegationId（唯一写入点；幂等——重复出现覆盖为最新）。
 * 写入方（orchestrator 委派生命周期订阅）已按「currentStage==='coding' 且非代理委派」
 * 前置判定，不按 title 关键词（title 是 L1 自由文本，M-5/M-7 已证明关键词匹配脆弱）。
 */
export function setProjectCodingDelegationId(
  workspaceSlug: string,
  projectId: string,
  delegationId: string,
): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.codingDelegationId = delegationId
  writeProjectInfo(workspaceSlug, projectId, base)
}

/** 读取待纠正拒因登记（无/无字段返回 null） */
export function getProjectPendingAdvanceCorrection(
  workspaceSlug: string,
  projectId: string,
): NonNullable<NanjuProjectInfoFile['pendingAdvanceCorrection']> | null {
  return readProjectInfo(workspaceSlug, projectId)?.pendingAdvanceCorrection ?? null
}

/**
 * W22（F5 ④）：登记待纠正拒因（唯一写入点；advance 拒收续接失败时写入——保证不静默，
 * 下一轮 prompt 消费侧接线后可提示 L1 待纠正事项）。
 */
export function setProjectPendingAdvanceCorrection(
  workspaceSlug: string,
  projectId: string,
  correction: NonNullable<NanjuProjectInfoFile['pendingAdvanceCorrection']>,
): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  const base: NanjuProjectInfoFile = info ?? {
    projectId,
    name: projectId,
    mode: 'quick',
    createdAt: new Date().toISOString(),
    workspaceSlug,
    projectDir: `project-${projectId}`,
    docDirs: [],
  }
  base.pendingAdvanceCorrection = correction
  writeProjectInfo(workspaceSlug, projectId, base)
}

/** 清除待纠正拒因（阶段推进成功时；幂等） */
export function clearProjectPendingAdvanceCorrection(workspaceSlug: string, projectId: string): void {
  const info = readProjectInfo(workspaceSlug, projectId)
  if (!info || info.pendingAdvanceCorrection === undefined) return
  info.pendingAdvanceCorrection = undefined
  writeProjectInfo(workspaceSlug, projectId, info)
}

// ===== v2.4 推进授权内存态（D7 §1/§2/§5：confirmAuthorization / activeConfirmAsk / systemAdvanceAuthorized） =====

/**
 * 推进授权三态（harness 内存态，不落盘——单次 run 生命周期内有效 + TTL，重启即失效
 * 是安全缺省：推进是强后果动作，重启后要求重新确认，无授权冒失推进）。
 *
 * - confirmAuthorization（I1）：用户确认授权——来源限定 ask-answer（横幅 IPC，I1-①）或
 *   真·用户消息（humanOrigin=true + 活跃确认问句 + 确认词，I1-②）。expectedTarget 语义
 *   （D7 §1 I1-②c）：记录「预期推进目标」而非当前阶段，消费时 PHASE_ADVANCE:<target>
 *   必须 target === expectedTarget，堵「确认 A 阶段产出却推进到 B」的目标漂移。
 * - activeConfirmAsk（I1-②b 上下文绑定）：合规「确认」header 问句放行时登记；确认词
 *   命中仅在活跃问句在场（10min TTL）时才构成授权——散点「继续/好的」不授权。
 * - systemAdvanceAuthorized（I2）：harness systemInitiated 推进指令登记（统一出口
 *   registerSystemAdvance，消费即清、单次有效）。
 *
 * key = `${workspaceSlug}/${projectId}`；跨工作区同名 projectId 不串（projectId 本身
 * 按工作区隔离，双保险）。
 */

/** I1 确认授权来源（§1：枚举封闭，其余一律拒绝） */
export type NanjuConfirmSource = 'ask-answer' | 'user-message'

/** confirmAuthorization 内存态（10min TTL，读时惰性过期） */
export interface NanjuConfirmAuthorization {
  source: NanjuConfirmSource
  expectedTarget: string
  ts: number
}

/** activeConfirmAsk 内存态（10min TTL；askedAt 为问句放行时刻） */
export interface NanjuActiveConfirmAsk {
  askedAt: number
  expectedTarget: string
}

/** 授权类内存态 TTL（毫秒）：确认授权 / 活跃确认问句统一 10 分钟（D7 §1 I1-②b/§5） */
export const NANJU_ADVANCE_AUTH_TTL_MS = 10 * 60 * 1000

const confirmAuthorizationStore = new Map<string, NanjuConfirmAuthorization>()
const activeConfirmAskStore = new Map<string, NanjuActiveConfirmAsk>()
const systemAdvanceStore = new Map<string, { target: string; ts: number }>()

function authKey(workspaceSlug: string, projectId: string): string {
  return `${workspaceSlug}/${projectId}`
}

/** 置位 I1 确认授权（唯一写入点；覆盖式——后到者胜，TTL 从新 ts 起算） */
export function setConfirmAuthorization(
  workspaceSlug: string,
  projectId: string,
  source: NanjuConfirmSource,
  expectedTarget: string,
): void {
  confirmAuthorizationStore.set(authKey(workspaceSlug, projectId), { source, expectedTarget, ts: Date.now() })
}

/** 读取 I1 确认授权（TTL 惰性过期：超时返回 null 并清除） */
export function getConfirmAuthorization(
  workspaceSlug: string,
  projectId: string,
): NanjuConfirmAuthorization | null {
  const key = authKey(workspaceSlug, projectId)
  const state = confirmAuthorizationStore.get(key)
  if (!state) return null
  if (Date.now() - state.ts > NANJU_ADVANCE_AUTH_TTL_MS) {
    confirmAuthorizationStore.delete(key)
    return null
  }
  return state
}

/** 消费 I1 确认授权（推进门通过后单次清除；幂等） */
export function consumeConfirmAuthorization(workspaceSlug: string, projectId: string): void {
  confirmAuthorizationStore.delete(authKey(workspaceSlug, projectId))
}

/** 登记 activeConfirmAsk（「确认」header 问句放行时；expectedTarget=harness 按阶段图算的唯一下一阶段） */
export function setActiveConfirmAsk(
  workspaceSlug: string,
  projectId: string,
  expectedTarget: string,
): void {
  activeConfirmAskStore.set(authKey(workspaceSlug, projectId), { askedAt: Date.now(), expectedTarget })
}

/** 读取 activeConfirmAsk（TTL 惰性过期；无/过期返回 null） */
export function getActiveConfirmAsk(
  workspaceSlug: string,
  projectId: string,
): NanjuActiveConfirmAsk | null {
  const key = authKey(workspaceSlug, projectId)
  const state = activeConfirmAskStore.get(key)
  if (!state) return null
  if (Date.now() - state.askedAt > NANJU_ADVANCE_AUTH_TTL_MS) {
    activeConfirmAskStore.delete(key)
    return null
  }
  return state
}

/** 清除 activeConfirmAsk（横幅已答 / 确认词消费 / 用户反悔；幂等） */
export function clearActiveConfirmAsk(workspaceSlug: string, projectId: string): void {
  activeConfirmAskStore.delete(authKey(workspaceSlug, projectId))
}

// ===== W22（G 域 M-6）：install-only 横幅在场标记（内存态；不登记 activeConfirmAsk） =====

/**
 * install-only 横幅（header=确认·安装缺失组件）放行时登记；其横幅答案回传
 * （ask-answer）不构成推进授权，但也不误记 clarify.suspect-fake-confirm——白名单
 * 豁免口径：suspect 埋点 payload 带 whitelisted:true（事后可区分「真伪造」与
 * 「白名单放行」）。10min TTL 与授权态同源（横幅长时间未答即失效）。
 */
const activeInstallAskStore = new Map<string, { askedAt: number }>()

/** 登记 install-only 横幅在场（AskUserQuestion 放行侧；幂等覆盖） */
export function setActiveInstallAsk(workspaceSlug: string, projectId: string): void {
  activeInstallAskStore.set(authKey(workspaceSlug, projectId), { askedAt: Date.now() })
}

/** 读取 install-only 横幅在场标记（TTL 惰性过期；无/过期返回 null） */
export function getActiveInstallAsk(
  workspaceSlug: string,
  projectId: string,
): { askedAt: number } | null {
  const key = authKey(workspaceSlug, projectId)
  const state = activeInstallAskStore.get(key)
  if (!state) return null
  if (Date.now() - state.askedAt > NANJU_ADVANCE_AUTH_TTL_MS) {
    activeInstallAskStore.delete(key)
    return null
  }
  return state
}

/** 清除 install-only 横幅标记（ask-answer 到达时消费；幂等） */
export function clearActiveInstallAsk(workspaceSlug: string, projectId: string): void {
  activeInstallAskStore.delete(authKey(workspaceSlug, projectId))
}

// ===== W22（G 域 F5 ③）：advance 拒收注入防环计数（内存态；对齐熔断口径） =====

/**
 * 同项目 advance 拒收教育注入+续接计数：≤2 次正常教育闭环；第 3 次起转人工提示
 * （不再注入教育/续接——防「拒收→注入→续接→再拒收」死循环烧 token）。阶段推进
 * 成功时清零（新阶段重新计数）；不落盘（进程重启重新计数是安全缺省）。
 */
const advanceRejectCountStore = new Map<string, number>()

/** 拒收计数 +1 并返回新值 */
export function bumpAdvanceRejectCount(workspaceSlug: string, projectId: string): number {
  const key = authKey(workspaceSlug, projectId)
  const next = (advanceRejectCountStore.get(key) ?? 0) + 1
  advanceRejectCountStore.set(key, next)
  return next
}

/** 读取当前拒收计数（不递增） */
export function getAdvanceRejectCount(workspaceSlug: string, projectId: string): number {
  return advanceRejectCountStore.get(authKey(workspaceSlug, projectId)) ?? 0
}

/** 清零拒收计数（阶段推进成功时；幂等） */
export function resetAdvanceRejectCount(workspaceSlug: string, projectId: string): void {
  advanceRejectCountStore.delete(authKey(workspaceSlug, projectId))
}

/**
 * I2 系统推进授权登记（唯一出口 registerSystemAdvance——harness systemInitiated 推进
 * 指令点统一调用；D7 §1 I2/R6-03：现网目标集={testing,delivered}，helper 防御性兜全部
 * 目标，新增跨阶段指令点必须走本出口，不私设旁路）。同 target 重复登记幂等（ts 刷新）。
 */
export function registerSystemAdvance(workspaceSlug: string, projectId: string, target: string): void {
  systemAdvanceStore.set(authKey(workspaceSlug, projectId), { target, ts: Date.now() })
}

/** 读取 I2 系统推进授权（无 TTL 消费语义——登记到消费是同一指令闭环；单次消费即清） */
export function getSystemAdvanceAuthorized(
  workspaceSlug: string,
  projectId: string,
): { target: string; ts: number } | null {
  return systemAdvanceStore.get(authKey(workspaceSlug, projectId)) ?? null
}

/** 消费 I2 系统推进授权（推进门通过后单次清除；幂等） */
export function consumeSystemAdvanceAuthorized(workspaceSlug: string, projectId: string): void {
  systemAdvanceStore.delete(authKey(workspaceSlug, projectId))
}

/** 清空某项目全部推进授权态（项目删除/流程重置用；幂等） */
export function clearNanjuAdvanceAuthState(workspaceSlug: string, projectId: string): void {
  const key = authKey(workspaceSlug, projectId)
  confirmAuthorizationStore.delete(key)
  activeConfirmAskStore.delete(key)
  systemAdvanceStore.delete(key)
  // W22（G 域）：install-ask 标记与拒收防环计数同批清理
  activeInstallAskStore.delete(key)
  advanceRejectCountStore.delete(key)
}

/** 测试专用：全量重置内存态（生产代码禁用——防跨测试污染） */
export function __resetNanjuAdvanceAuthStoresForTests(): void {
  confirmAuthorizationStore.clear()
  activeConfirmAskStore.clear()
  systemAdvanceStore.clear()
  // W22（G 域）：install-ask 标记与拒收防环计数同批重置
  activeInstallAskStore.clear()
  advanceRejectCountStore.clear()
}
