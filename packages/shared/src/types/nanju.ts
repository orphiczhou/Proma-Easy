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
export const PHASE_TODO_PREFIX: Record<'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing', string> = {
  requirements: '需求阶段：',
  prototype: '原型阶段：',
  architecture: '架构阶段：',
  planning: '规划阶段：',
  coding: '开发阶段：',
  testing: '测试阶段：',
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
  /** B2：独立视觉验证者配置（独立于 author；prototype 阶段消费）。主进程 slot producer resolvePhaseDelegationSlots 解析后附加。 */
  visualReviewerChannel?: string
  visualReviewerModel?: string
  /** resolveACActors(phase) 的解析结果（主进程附加，渲染端不复制 AC_PRESETS） */
  acActors: GuideACActors
}

// ===== W23 模型配置设置界面（D2 IPC 域契约） =====

/**
 * 南大向导·模型配置 IPC 通道常量（W23 §五；主进程 ipc.ts 注册、preload 经
 * ipcRenderer.invoke 暴露；与 CHANNEL_IPC_CHANNELS 同惯例）。
 */
export const NANJU_MODEL_IPC = {
  /** 读取设置界面初始态（effective/sources/health/channels 摘要；不含 apiKey/baseUrl） */
  GET_STATE: 'nanjuModel:getState',
  /** 逐端点连通测试（main 侧解密 + testChannelDirect；并发 ≤3、单项 15s 超时） */
  TEST_ENDPOINTS: 'nanjuModel:testEndpoints',
  /** 智能配置推荐（确定性整套矩阵 + 硬约束两态） */
  RECOMMEND: 'nanjuModel:recommend',
  /** 保存增量 patch 到层 1.5 覆盖文件（字段值 null=删除该键覆盖） */
  SAVE: 'nanjuModel:save',
  /** 恢复默认（整体）：删层 1.5 文件 → reload */
  RESET: 'nanjuModel:reset',
} as const

/** 模型配置设置界面状态（getState/save/reset 的 state 载荷；全程无密钥字段） */
export interface NanjuModelSettingsState {
  /** 有效配置（四层合并后） */
  effective: {
    phases: Record<
      string,
      {
        channel: string
        model: string
        fallbacks?: string[]
        acAttacker?: { channel: string; model: string }
        acDefender?: { channel: string; model: string }
        /**
         * B2：独立视觉验证者配置（prototype 阶段，可选项；其他阶段 undefined）。
         * **默认不配置**——不做“默认 minimax/MiniMax-M3”的隐含自证（与 author 同端点 =
         * 同端点自证）；未显式配置时 prototype 阶段渲染“视觉裁决 blocked”，不静默跳过。
         */
        visualReviewer?: { channel: string; model: string }
      }
    >
    acPresets: Record<
      'light' | 'medium',
      {
        attacker: { channel: string; model: string }
        defender: { channel: string; model: string }
      }
    >
    proxyCandidates: Array<{ channelId: string; modelId: string }>
  }
  /** 实际参与合并的层来源（排查配置为何未生效） */
  sources: { builtin?: string; override?: string; user?: string }
  /** 逐端点健康（三态红灯；slot 命名见 nanju-model-health 冻结枚举） */
  health: Array<{
    slot: string
    channelId: string
    modelId: string
    status: 'ok' | 'model-disabled' | 'model-missing' | 'channel-missing'
  }>
  /** 多样性警告（quick+iterative 两模式合并去重；行级黄灯） */
  diversityWarnings: Array<{ kind: string; detail: string }>
  /** 渠道摘要（下拉数据源；不含 apiKey/baseUrl） */
  channels: Array<{ channelId: string; name: string; enabledModelIds: string[] }>
  /** 层 1（用户手改文件）是否存在——存在时优先级高于设置界面，UI 顶部提示 */
  handLayerPresent: boolean
}

/** 单端点连通测试结果（testEndpoints 出参） */
export interface NanjuModelTestResultItem {
  channelId: string
  modelId: string
  ok: boolean
  latencyMs?: number
  message?: string
}

/** save 遮蔽可见：本次显式设置的字段被更高层（层 1 手改）覆盖时逐字段回传 */
export interface NanjuModelShadowedField {
  /** 字段名（槽位命名：phases.<id>.<field> / acPresets.<weight>.<role> / proxyCandidates） */
  field: string
  requested: unknown
  effective: unknown
  shadowSource: string
  path: string
}

/** save 增量 patch（同配置 schema 子集；字段值 null = 从层 1.5 删除该键覆盖） */
export interface NanjuModelSavePatch {
  phases?: Record<string, unknown>
  acPresets?: Record<string, unknown>
  proxyCandidates?: Array<{ channelId: string; modelId: string }> | null
}

/** save 响应：reload 后的最新状态 + 被高层遮蔽的字段清单 */
export interface NanjuModelSaveResponse {
  state: NanjuModelSettingsState
  shadowed: NanjuModelShadowedField[]
}

/**
 * 推荐响应（结构等价于主进程 nanju-model-health.NanjuRecommendResult——shared 纯类型
 * 模块不 import 主进程代码，用结构声明保持双端契约）。
 */
export interface NanjuModelRecommendResponse {
  /** 推荐矩阵增量 patch；无解（applyable=false）或无需变更时为 null */
  matrix: Record<string, unknown> | null
  applyable: boolean
  changes: Array<{ slot: string; from: string; to: string; reason: string }>
  notes: string[]
  diversityViolations?: Array<{ slot: string; violation: string }>
}

// ===== W-B B2：南大向导 slot 分类契约 =====

/**
 * 协作委派 slot 分类（producer → schema → delegation record → gate 全链节点）。
 *
 * 设计语义（权威在内部 producer，不在文本）：
 * - slot **不是**工具公开入参。权威来源是内部 producer
 *   `nanju-router-prompt.resolvePhaseDelegationSlots`（config/schema 驱动），其输出经
 *   内部参数 `DelegateAgentArgs.slot`（不暴露在 delegate_agent/delegate_agents 工具 schema）
 *   写入 DelegationRecord 与 session meta（`delegationSlot`），gate 据此判定。
 * - title/task 文本推断（nanju-delegate-guard.detectDelegationSlot）仅为 **legacy 低信任**
 *   回退：公开工具入口会剥离 slot 字段，L1/L2 不能借文本伪造视觉槽位权威。
 * - 视觉验证者（visual-validator）槽位：只有显式配置且与作者异端点时为 resolved，
 *   否则为清晰 blocked；不得按模型名猜视觉、不得默认 null 跳过再宣称已验证。
 */
export type NanjuDelegationSlot =
  | 'author'
  | 'ac-attacker'
  | 'ac-defender'
  | 'visual-validator'
  | 'general'

/** slot 白名单（内部校验用；未知值一律视为 general）。 */
export const NANJU_DELEGATION_SLOTS: readonly NanjuDelegationSlot[] = [
  'author', 'ac-attacker', 'ac-defender', 'visual-validator', 'general',
]

/** slot 白名单校验（未知/非字符串一律 false——调用方回退 general）。 */
export function isNanjuDelegationSlot(value: unknown): value is NanjuDelegationSlot {
  return typeof value === 'string' && (NANJU_DELEGATION_SLOTS as readonly string[]).includes(value)
}

/**
 * 独立视觉验证者槽位配置（与 acAttacker/acDefender 同型，独立于 author）。
 *
 * 语义：prototype 阶段专属（其他阶段不渲染视觉验证者）。channel 可为
 * 'minimax' 家族标记（运行时按渠道记录解析为具体 UUID 渠道），或显式
 * channelId（用户/调度员已声明）。
 *
 * 硬约束（gate 接线，shared 端仅契约声明）：
 * - 与 author 配置（channel+model 均相同）禁止同时启用 → 视为“同端点自证”，
 *   配置层与运行时层均拒绝/阻塞；不允许 null 静默自证。
 * - 未显式配置时 **不是** 默认 minimax/MiniMax-M3——而是清晰 blocked（视觉裁决
 *   明确标注 unavailable），避免与作者同端点自证后冒充独立裁决。
 */
export interface GuideVisualReviewerConfig {
  channel: string
  model: string
}

/** GWT进度仅用于展示，最终交付仍查宿主报告与批准事实。 */
export interface NanjuGwtProgressEvent {
  phase: 'start' | 'approval' | 'scenario-start' | 'scenario-end' | 'done'
  current: number
  total: number
  scenario?: string
  scenarioStatus?: 'pass' | 'fail' | 'skip'
  passed: number
  failed: number
  skipped: number
  scope?: 'engineering'
  verdict?: 'pass' | 'fail' | 'error' | 'blocked'
  reason?: string
}
export interface NanjuGwtProgressData extends NanjuGwtProgressEvent {
  sessionId: string
  projectId: string
}
