/**
 * 南大向导「向导图」阶段内进度（W2 S1）
 *
 * 三件事：
 * 1. 子步骤序列常量 GUIDE_SUBSTAGE_SEQUENCE —— 与渲染端 guide-dsl.ts buildPhaseSubgraph
 *    的节点 id 一一对应（跨进程契约，两侧一致性由 nanju-guide-progress.test.ts 锁定：
 *    序列对齐断言 + JSON 相等断言）。改任何一侧必须同步另一侧并过测试。
 * 2. 纯函数 deriveGuideSubStates —— 按 currentStage+subStage 推导阶段内三态。
 * 3. 事件广播 emitGuideProgress + 冷启动快照 getGuideProgressSnapshot。
 *
 * 纪律：
 * - 本文件顶部仅类型导入（编译期擦除）——纯常量/纯函数，IPC 与文件 IO 全部惰性 require
 *   （agent-orchestrator 钩子同型惯例），保证可被任何测试环境直接 import。
 * - write-then-emit：调用方必须先 setProjectSubStage 落盘、再 emitGuideProgress 广播，
 *   保证渲染端冷启动 snapshot 读到的数据不旧于已发事件（seq 高者胜语义）。
 */

import type { StageDivergence } from './nanju-state-divergence'

/** 向导图可执行阶段（六阶段，与渲染端 GuidePhaseId 对应；mode-select/delivered 无子步骤） */
export type GuideProgressStage =
  | 'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing'

/**
 * 各阶段子步骤推进序列（首元素 = 主节点 id = 阶段开始即「作者产出中」）。
 * S1 诚实两态起步：主进程只写 {主节点} 与 {主节点}_UC 两个值（产出中/等用户确认）；
 * ATK/DEF/GATE/VIS/GWT/JUDGE 等中间节点由 derive 推导；ARCH_ENV 三态由 envState 载荷
 * 强制映射（W7 R9，v0.17.69），优先于 subStage 序列推导。
 */
export const GUIDE_SUBSTAGE_SEQUENCE: Record<GuideProgressStage, readonly string[]> = {
  requirements: ['REQ', 'REQ_ATK', 'REQ_DEF', 'REQ_UC'],
  prototype: ['PROTO', 'PROTO_SS', 'PROTO_ATK', 'PROTO_DEF', 'PROTO_VIS', 'PROTO_UC'],
  architecture: ['ARCH', 'ARCH_ATK', 'ARCH_DEF', 'ARCH_GATE', 'ARCH_ENV', 'ARCH_UC'],
  planning: ['PLAN', 'PLAN_ATK', 'PLAN_DEF', 'PLAN_UC'],
  coding: ['CODE', 'CODE_UC'],
  testing: ['TEST', 'TEST_ATK', 'TEST_DEF', 'TEST_GWT', 'TEST_JUDGE'],
}

/** 子步骤三态（与渲染端 StageViewStatus 同名同义） */
export type GuideSubStageState = 'done' | 'current' | 'pending'

/**
 * 环境配置子步骤（ARCH_ENV）二态（W7 R9 映射契约 + AC 审计 M5 收缩，v0.17.69）：
 * - done = env.setup.verified（全部就绪置位）
 * - blocked = env.setup.failed（缺失置位，渲染端 st-blocked）
 * 原设计的 'current'（探测执行中）已删：探测发生在 L2 子会话内部，主进程直到
 * 标记行被写入才有事实可广播，无任何代码路径发出该值（死代码）——ARCH_ENV 探测中
 * 的着色由 subStage 序列推导兜底。序列中 ARCH_ENV 位于 GATE 之后 UC 之前（两侧同步）。
 */
export type GuideEnvState = 'done' | 'blocked'

/** 回归边投影（与 nanju-regression.ts RegressionEdge 同构；事件/快照载荷用） */
export interface GuideProgressRegression {
  from: string
  to: string
  count: number
  active: boolean
}

/** 阶段 → 主节点 id（序列首元素；未知/无子步骤阶段返回 undefined）——阶段推进点写 subStage 用 */
export function getGuideStageMainNodeId(stage: string): string | undefined {
  return GUIDE_SUBSTAGE_SEQUENCE[stage as GuideProgressStage]?.[0]
}

/**
 * 推导当前阶段的子步骤三态（纯函数，无 IO）。
 *
 * 规则（工单 W2 S1 §2.2 + AC 审计 Round 1 必修-3 修订）：
 * - 仅返回 currentStage 阶段序列内的映射；未知阶段返回空对象；
 * - subStage 在序列内：其前全部 done、本身 current、其后全部 pending；
 * - subStage 为空/未知：首节点（主节点）current、其余 pending（= 阶段刚开始，作者产出中）；
 * - **UC 态特殊化（A2 修订）**：subStage === {主节点}_UC 时，序列内中间节点输出 pending
 *   而非 done（主节点 done、{主节点}_UC current）——UC 点亮仅证明产出文件就绪
 *   （verifyPhaseOutput 门槛），AC 攻防/门禁等中间环节尚未接入数据源（S4），
 *   不得画成「已通过」。
 *
 * 注意：返回值只含序列内节点；序列外结构节点（如 CODE_ATK/CODE_DEF 不在 coding 序列内）
 * 由渲染端 guide-dsl 按结构流前驱继承规则补齐（两侧规则见各自测试）。
 */
export function deriveGuideSubStates(
  currentStage: string,
  subStage: string | null | undefined,
): Record<string, GuideSubStageState> {
  const seq = GUIDE_SUBSTAGE_SEQUENCE[currentStage as GuideProgressStage]
  if (!seq) return {}
  const result: Record<string, GuideSubStageState> = {}
  const hitIndex = subStage ? seq.indexOf(subStage) : -1
  // 空/未知 subStage → 视为首节点（主节点）current：阶段刚开始，作者产出中
  const currentIdx = hitIndex === -1 ? 0 : hitIndex
  // UC 态（等待用户确认）：仅主节点 done，中间节点不继承 done（A2 修订）
  const isUcState = subStage === `${seq[0]}_UC`
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

// ===== 事件广播（渲染端 seq 高者胜协议的 main 侧） =====

/** 模块级事件序号：单调递增，渲染端用于丢弃过期事件 / 与冷启动 snapshot 合流 */
let guideProgressSeq = 0

/** 向导图进度事件载荷（nanju:guide-progress IPC 通道） */
export interface GuideProgressEvent {
  sessionId: string
  projectId: string
  currentStage: string
  subStage: string
  seq: number
  /** 环境配置子步骤三态（W7 R9；缺失 = 无环境事件，渲染端按序列推导降级） */
  envState?: GuideEnvState
  /** 回归边投影（W2c；缺失 = 无回归事件） */
  regressions?: GuideProgressRegression[]
  /** 阶段偏差观测（W18 Wave3；缺失 = 无数据——仅旧主进程事件，向前兼容） */
  divergences?: StageDivergence[]
  /** 偏差事实集合指纹（divergences 稳定派生；渲染端独立通道比较用） */
  divergenceFingerprint?: string
}

/** 事件附加载荷（emitGuideProgress 可选第五参；与 GuideProgressEvent 可选字段对应） */
export interface GuideProgressExtra {
  envState?: GuideEnvState
  regressions?: GuideProgressRegression[]
  /**
   * W18 Wave3 事件侧偏差计算挂点：提供 workspaceSlug 时在广播前现算 divergences
   *（推进点调用方可直接携带，无需自己引依赖）。未提供则事件不带偏差字段——
   * 渲染端由 10s 轮询快照的独立通道兑底（向前兼容，调用方零改动）。
   */
  workspaceSlug?: string
  /** 直通偏差载荷（已由调用方现算时优先；与 workspaceSlug 二选一） */
  divergences?: StageDivergence[]
  divergenceFingerprint?: string
}

/** 冷启动快照（nanju:get-guide-progress 返回值） */
export interface GuideProgressSnapshot {
  currentStage: string
  subStage: string
  seq: number
  /** 由 _project-info.json envReady 推导（true→done / false→blocked；缺失 = undefined） */
  envState?: GuideEnvState
  /** 回归事件投影（getRegressionEvents + projectRegressions；无事件时缺失） */
  regressions?: GuideProgressRegression[]
  /**
   * 阶段偏差观测（W18 Wave3）：快照恒携带（无偏差为空数组）——divergence 事实
   * 随磁盘文件增删变化，与 seq（进度事件序号）无关，快照是渲染端独立通道的
   * 兜底数据源（缺失 = 旧主进程，渲染端维持现状）。
   */
  divergences?: StageDivergence[]
  divergenceFingerprint?: string
}

/**
 * 广播向导图进度到主窗（nanju:gwt-progress 同型模式；失败不抛——IPC 不可用不影响主流程）。
 * 返回本次事件 seq（无窗口/异常时 seq 已自增，保证后续事件仍严格递增；-1 仅作防御兜底）。
 *
 * 调用纪律：先 setProjectSubStage 落盘再调本函数（write-then-emit，见文件头注释）。
 * extra（v0.17.69，W2c/W7）：envState（ARCH_ENV 三态）与 regressions（回归边投影）
 * 随事件携带；subStage 不变的纯状态更新（环境置位/回归写入）只传 extra 即可。
 */
export function emitGuideProgress(
  sessionId: string,
  projectId: string,
  currentStage: string,
  subStage: string,
  extra?: GuideProgressExtra,
): number {
  guideProgressSeq += 1
  const seq = guideProgressSeq
  // W18 Wave3：事件侧偏差挂点——extra.workspaceSlug 提供且未直通 divergences 时现算
  //（计算失败不影响广播；渲染端由 10s 轮询快照独立通道兑底）
  let divergences = extra?.divergences
  let divergenceFingerprint = extra?.divergenceFingerprint
  if (divergences === undefined && extra?.workspaceSlug !== undefined) {
    try {
      const { detectStageDivergence, divergenceFingerprint: fp } =
        require('./nanju-state-divergence') as typeof import('./nanju-state-divergence')
      divergences = detectStageDivergence(extra.workspaceSlug, projectId)
      divergenceFingerprint = fp(divergences)
    } catch { /* 偏差现算失败：事件照发（不带该字段），快照通道兑底 */ }
  }
  try {
    const { getMainWindow } = require('./main-window-store') as typeof import('./main-window-store')
    const win = getMainWindow()
    const event: GuideProgressEvent = {
      sessionId, projectId, currentStage, subStage, seq,
      envState: extra?.envState,
      regressions: extra?.regressions,
    }
    // 条件附加（向前兼容）：未现算/未直通时不含该键，与旧主进程载荷同形
    if (divergences !== undefined) {
      event.divergences = divergences
      event.divergenceFingerprint = divergenceFingerprint
    }
    win?.webContents.send('nanju:guide-progress', event)
  } catch { /* 主窗口不可用不影响主流程；seq 已计入，渲染端冷启动 snapshot 仍可取到最新数据 */ }
  return seq
}

/**
 * 冷启动快照：读 _project-info.json 的 subStage + _nanju-projects.json 的 currentStage，
 * 连同当前 seq 一并返回（渲染端挂载时先拉 snapshot 作初值再监听事件，消除空窗）。
 * 项目不存在返回 null（渲染端降级为无子步骤态）。
 * v0.17.69：附带 envReady 推导的 envState（true→done / false→blocked）与回归事件投影
 * （regressions）——事件丢失时快照兑底（探测中 current 态短暂，丢失退化为序列推导）。
 */
export function getGuideProgressSnapshot(
  workspaceSlug: string,
  projectId: string,
): GuideProgressSnapshot | null {
  try {
    const { listNanjuProjects, readProjectInfo, getProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
    const project = listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)
    if (!project) return null
    const info = readProjectInfo(workspaceSlug, projectId)
    const snapshot: GuideProgressSnapshot = {
      currentStage: project.currentStage,
      subStage: getProjectSubStage(workspaceSlug, projectId) ?? '',
      seq: guideProgressSeq,
    }
    if (info?.envReady === true) snapshot.envState = 'done'
    else if (info?.envReady === false) snapshot.envState = 'blocked'
    const events = info?.regressionEvents ?? []
    if (events.length > 0) {
      const { projectRegressions } = require('./nanju-regression') as typeof import('./nanju-regression')
      snapshot.regressions = projectRegressions(events, project.currentStage)
    }
    // W18 Wave3：偏差观测恒携带（无偏差为空数组）——divergence 事实随磁盘文件增删变化，
    // 与 seq 无关；快照是渲染端独立通道的主数据源（10s 轮询）。失败时快照不带该字段，
    // 渲染端维持现状（向前兼容）。
    try {
      const { detectStageDivergence, divergenceFingerprint } =
        require('./nanju-state-divergence') as typeof import('./nanju-state-divergence')
      const dv = detectStageDivergence(workspaceSlug, projectId)
      snapshot.divergences = dv
      snapshot.divergenceFingerprint = divergenceFingerprint(dv)
    } catch { /* 偏差观测失败：快照不带该字段 */ }
    return snapshot
  } catch {
    return null
  }
}
