/**
 * W18 Wave3 · F4 产物/阶段偏差可观测性（非阻断告警数据源）
 *
 * 三件事：
 * 1. detectStageDivergence —— 观测「未来阶段 outputPath 文件已存在且 >100B」的偏差事实；
 * 2. isArtifactNormalAtStage —— 08_APP 例外的显式口径（用户裁定，可独立测试）；
 * 3. divergenceFingerprint —— 偏差事实集合的稳定指纹（纯函数，渲染端独立通道比较用）。
 *
 * 弱断言口径（审查 SHOULD-6）：本观测只能证明「文件存在且达标大小」，不能证明谁写的、
 * 何时写的、是否为越阶段施工 → 字段命名 observedAt（观测时刻，非施工时刻），
 * 下游文案必须用「可能存在越阶段施工」，禁止输出「已越阶段施工」类确定结论。
 *
 * 关键口径（用户裁定）：
 * - 只检查各阶段 outputPath 具体文件且 size>100B（与 verifyPhaseOutput 的 100B 门槛对齐，
 *   取严格大于）；**严禁用目录存在性判断**——createNanjuProject 建项目时已预创建全部
 *   目录骨架（nanju-project.ts），空目录不是产出。
 * - 08_APP/index.html 在 currentStage∈{coding,testing,delivered} 均正常（coding 正式
 *   产出 / testing 的 GWT 对象 / delivered 的交付结果）；仅 requirements/prototype/
 *   architecture/planning 阶段出现才算偏差。未来阶段判定（序 > currentStage 序）天然
 *   覆盖该例外，isArtifactNormalAtStage 再显式跳过一次，防止后续改为全阶段扫描时误报。
 * - 04_API_SPEC / 07_VERSIONS 无任何阶段的 outputPath 映射，不纳入（quick 路由无
 *   planning 阶段，plan.md 同理不纳入——偏差按项目 mode 路由判定）。
 *
 * 纪律：与 nanju-guide-progress.ts 同型——顶部仅类型导入（编译期擦除，无运行时依赖），
 * 文件 IO 与模块依赖全部惰性 require，保证可被任何测试环境直接 import。
 */
import type { PhaseId } from './nanju-router'

/** 偏差最小字节数门槛（对齐 verifyPhaseOutput 的 100B；严格大于） */
export const ARTIFACT_DIVERGENCE_MIN_BYTES = 100

/** 阶段偏差观测记录（弱断言命名，SHOULD-6：observedAt = 观测时刻，非施工时刻） */
export interface StageDivergence {
  /** 产物所属阶段（该阶段序 > 当前阶段序） */
  stage: PhaseId
  /** 阶段 outputPath 相对路径（如 '08_APP/index.html'） */
  artifact: string
  /** 观测时刻（ISO；每次检测现取，非文件 mtime——观测不等于施工时点） */
  observedAt: string
}

/**
 * 08_APP 例外显式口径（用户裁定）：coding 产物在 coding/testing/delivered 属正常。
 * 未来阶段判定已天然覆盖，此处显式声明并独立测试，作为口径的单一事实源。
 */
const CODING_ARTIFACT_NORMAL_STAGES: ReadonlySet<string> = new Set(['coding', 'testing', 'delivered'])

/** 阶段产物在某 currentStage 下是否属「正常在场」（不构成偏差） */
export function isArtifactNormalAtStage(stage: PhaseId, currentStage: string): boolean {
  return stage === 'coding' && CODING_ARTIFACT_NORMAL_STAGES.has(currentStage)
}

/**
 * 偏差事实集合指纹（纯函数，无 IO）：
 * - 只由 stage:artifact 集合派生，observedAt 不参与（同一事实集重算不变）；
 * - 与顺序无关（排序后哈希）；空列表为稳定常量（渲染端据此区分「无偏差」与「无数据」）；
 * - FNV-1a 32 位 + 长度前缀，输出短串（IPC 载荷友好；≤6 阶段事实集无碰撞担忧）。
 */
export function divergenceFingerprint(list: StageDivergence[]): string {
  const canonical = list.map((d) => `${d.stage}:${d.artifact}`).sort().join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `dv1-${canonical.length.toString(16)}-${hash.toString(16)}`
}

/**
 * 检测阶段偏差：按项目 mode 路由，检查「未来阶段」（序 > currentStage 序）的 outputPath
 * 文件存在且 size>100B → 记偏差。当前/过去阶段产物属合法在场，不报。
 *
 * 降级安全：项目不存在 / 未知阶段（mode-select 等，无法定义「未来阶段」）/ 任何 IO 异常
 * → 返回空列表（非阻断观测，失败静默；渲染端 10s 轮询下轮自然重试）。
 */
export function detectStageDivergence(workspaceSlug: string, projectId: string): StageDivergence[] {
  try {
    const { listNanjuProjects, getNanjuProjectDir } = require('./nanju-project') as typeof import('./nanju-project')
    const { getRoute } = require('./nanju-router') as typeof import('./nanju-router')
    const { existsSync, statSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')

    const project = listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)
    if (!project) return []
    const route = getRoute(project.mode)
    const currentIdx = route.findIndex((p) => p.id === project.currentStage)
    if (currentIdx === -1) return [] // 未知阶段：无法定义未来阶段，保守不判定
    const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
    const observedAt = new Date().toISOString()

    const divergences: StageDivergence[] = []
    for (const phase of route.slice(currentIdx + 1)) {
      // 哨兵（delivered）无 outputPath；无产出的阶段跳过
      if (!phase.outputPath) continue
      // 08_APP 显式例外（见文件头口径；未来阶段判定下为冗余防御，防后续全阶段扫描改坏）
      if (isArtifactNormalAtStage(phase.id, project.currentStage)) continue
      const filePath = join(projectDir, phase.outputPath)
      if (!existsSync(filePath)) continue
      if (statSync(filePath).size <= ARTIFACT_DIVERGENCE_MIN_BYTES) continue
      divergences.push({ stage: phase.id, artifact: phase.outputPath, observedAt })
    }
    return divergences
  } catch {
    return [] // 非阻断观测：任何异常降级为空（渲染端维持现状，下轮轮询重试）
  }
}
