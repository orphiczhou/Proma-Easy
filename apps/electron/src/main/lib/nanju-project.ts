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

/** 读取确认待推进阶段。无文件/无字段返回 null */
export function getProjectConfirmPending(workspaceSlug: string, projectId: string): string | null {
  return readProjectInfo(workspaceSlug, projectId)?.confirmPendingStage ?? null
}
