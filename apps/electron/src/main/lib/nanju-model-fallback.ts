/**
 * W13 模型 fallback 让步链（v0.17.75）
 *
 * 链真相源（W13b 起两层）：参数文件 phases[].fallbacks 优先（nanju-model-config，
 * ~/.proma/ 用户覆盖 > 内置 json > 代码兑底），配置缺项回退本文件的 MODEL_FALLBACK_CHAINS
 * 代码链（W13 原值不变）。清单文档见 nanju-guide/02_PRD与设计/model-matrix.md
 * （后续 W 系列变更两处同步更新）。
 *
 * 设计原则（工单 §2.1）：
 * - 链 = 依次降级（同族快版 → 异族备援），重试次数 ≤ 链长；
 * - 能力保底 flash 级——架构/编码类降 flash 有质量风险，fallback 定位是
 *   「可用性 > 质量」的应急：每次降级埋点 model.fallback.used，可观测后人工评估；
 * - 已知接受度（报告记录）：deepseek 系作者若二跳降到 glm-5.3-flash，与其 AC
 *   预设防御者（glm 系）同族——构建期家族断言按原配置已通过，运行期异族性弱化，
 *   属应急路径可接受残余（跨族备援只在整族不可用时触发，罕见）。
 *
 * 范围限定（工单 §2.2）：只接 nanju 项目会话的委派（findNanjuProjectBySession
 * 同模式——parent sessionId 必须是项目绑定的 L1 调度员会话）；普通 Proma 会话与
 * L2 子会话内部的 inline AC 审计委派不在本链保护范围（L2 委派失败走其既有重试语义）。
 */

import { findNanjuProjectBySession } from './nanju-router-gate'
import { recordTelemetry } from './nanju-telemetry'
import { getConfigFallbackChains } from './nanju-model-config'
import type { NanjuProject } from './nanju-project'

// ===== 类型 =====

/** 渠道 + 模型端点（链节点形态） */
export interface ModelEndpoint {
  channelId: string
  modelId: string
}

// ===== 单一真相源：让步链常量 =====

/**
 * key = `${channelId}:${modelId}`，值 = 依次降级端点（含跨族备援）。
 * 链设计原则：同族快版 → 异族备援；能力保底 flash 级。
 * 注意：key 用渠道字面 ID（nanju 路由的 deepseek / glm-zhipu）；minimax 是 UUID
 * 渠道（运行时解析），不入 key——MiniMax-M3 只作链尾备援目标（字面家族标记足够，
 * delegate 启动时 assertEnabledModelForChannel 会以实际渠道校验）。
 */
export const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  // 旗舰 → 同族快版 → 异族备援
  'deepseek:deepseek-v4-pro': ['deepseek:deepseek-flash', 'glm-zhipu:glm-5.3-flash'],
  'deepseek:deepseek-flash': ['glm-zhipu:glm-5.3-flash'],
  'glm-zhipu:GLM-5.3': ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-flash'],
  'glm-zhipu:glm-5.3-flash': ['deepseek:deepseek-flash'],
  'minimax:MiniMax-M3': ['glm-zhipu:glm-5.3-flash'],
}

// ===== 查询辅助 =====

/** 构造链 key（与 MODEL_FALLBACK_CHAINS 的键同构） */
export function modelKey(channelId: string, modelId: string | undefined): string | null {
  if (!channelId || !modelId) return null // 继承父会话模型（无显式 modelId）不入链
  return `${channelId}:${modelId}`
}

/** 解析链 key 为端点 */
export function parseModelKey(key: string): ModelEndpoint {
  const idx = key.indexOf(':')
  return { channelId: key.slice(0, idx), modelId: key.slice(idx + 1) }
}

/**
 * 查询端点的降级链（不含自身）。未配置链 / 继承模型（modelId 缺省）返回空数组
 * ——空数组 = 无 fallback，走既有失败路径。
 *
 * W13b（v0.17.75）：链来源改为配置优先——优先读参数文件 phases[].fallbacks 编译出的
 * 链（getConfigFallbackChains，~/.proma/ 用户覆盖 > 内置 json > 代码兑底；同 key 多阶段
 * 声明按 NANJU_MODEL_PHASE_ORDER 取并集）；配置缺项（该 key 无任何阶段声明链）回退
 * 下方代码链 MODEL_FALLBACK_CHAINS（两层兼容，W13 常量保持不变）。
 */
export function getFallbackChain(channelId: string, modelId: string | undefined): ModelEndpoint[] {
  const key = modelKey(channelId, modelId)
  if (!key) return []
  const configChain = getConfigFallbackChains()[key]
  if (configChain && configChain.length > 0) return configChain
  return (MODEL_FALLBACK_CHAINS[key] ?? []).map(parseModelKey)
}

// ===== nanju 会话范围限定 =====

/**
 * v2.4 自动补完需求（D7 §4）：nanjuProxy 代理委派渠道固定——不参与模型 fallback 让步链。
 *
 * 代理的核心价值是模型多样性（渠道≠提问方 + AC 避让）；降级到同族快版会侵蚀这一价值，
 * 且代理失败有 fallback:'human' 转述真人兑底，可用性损失可接受。代理渠道一旦解析
 * 定，同步/运行失败都不降级（链为空 = 走既有失败路径 → 工具返回 fallback）。
 */
export function shouldSkipFallbackChainForDelegation(nanjuProxy: boolean | undefined): boolean {
  return nanjuProxy === true
}

/**
 * 判定委派发起会话是否在 fallback 保护范围：parent 会话必须是 nanju 项目绑定的
 * L1 调度员会话（findNanjuProjectBySession 同模式）。返回项目（供埋点带 projectId），
 * 非保护范围返回 undefined。
 */
export function findNanjuFallbackProject(
  workspaceSlug: string | undefined,
  sessionId: string,
): NanjuProject | undefined {
  if (!workspaceSlug) return undefined
  try {
    return findNanjuProjectBySession(workspaceSlug, sessionId)
  } catch {
    // 项目元数据读取失败（IO 异常等）：防御性豁免，不因范围判定阻断委派
    return undefined
  }
}

// ===== 降级埋点 =====

/**
 * 记录一次降级（model.fallback.used：原值 → 新值 → 原因）。
 * 写失败由 recordTelemetry 内部吞掉（不阻断委派热路径）。
 */
export function recordModelFallbackUsed(input: {
  workspaceSlug: string
  project?: Pick<NanjuProject, 'projectId'>
  from: ModelEndpoint
  to: ModelEndpoint
  reason: string
  /** 附加上下文（委派标题/阶段等，可观测性增强） */
  context?: Record<string, unknown>
}): void {
  recordTelemetry(
    input.workspaceSlug,
    'model.fallback.used',
    {
      fromChannelId: input.from.channelId,
      fromModelId: input.from.modelId,
      toChannelId: input.to.channelId,
      toModelId: input.to.modelId,
      reason: input.reason,
      ...input.context,
    },
    input.project?.projectId,
  )
}
