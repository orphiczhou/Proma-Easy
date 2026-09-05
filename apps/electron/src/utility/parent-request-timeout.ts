/**
 * requestParent（utility → main capability RPC）按 method 的超时表。
 *
 * 背景（P0-B）：原实现对所有 capability 共用硬编码 120s 超时。但
 * - canUseTool 承载 AskUserQuestion 等用户交互，语义是"等用户作答，等多久都行"；
 * - customTool 可能承载 wait_for_delegations 等长等待（实测子会话运行 23 分钟）。
 * 120s 定时器会把仍在正常等待的请求错误取消（CAPABILITY_CANCEL + reject），
 * 表现为"确认横幅 120s 后必超时"。因此按 method 区分超时语义：
 *
 * - canUseTool：默认无超时（0）。生命周期兜底：abort 信号、query 结束清理
 *   （agent-runtime.ts pumpQuery finally）、runtime shutdown 全量 reject。
 * - customTool：默认 30 分钟，可通过环境变量调整或置 0 关闭。
 * - 其余（OAuth 凭证刷新等快速本地写）：维持 120s 默认。
 *
 * 该模块保持纯函数（env 显式注入），供 agent-runtime 与单元测试复用。
 */
import { AGENT_RUNTIME_METHODS } from '@proma/shared'

export const DEFAULT_PARENT_REQUEST_TIMEOUT_MS = 120_000
export const CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS = 30 * 60_000

/** canUseTool 超时（毫秒）；0 表示不设超时（用户交互等待语义）。 */
export const PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV = 'PROMA_CAN_USE_TOOL_TIMEOUT_MS'
/** customTool 超时（毫秒）；0 表示不设超时。 */
export const PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV = 'PROMA_CUSTOM_TOOL_TIMEOUT_MS'

export interface ParentRequestTimeoutEnv {
  [PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV]?: string
  [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]?: string
}

/** 严格超时配置：非空且全为十进制数字才合法（Terra MUST-1），拒绝 0x50/+80/80.5/尾部垃圾等静默截断。 */
const STRICT_TIMEOUT_ENV_PATTERN = /^\d+$/

/** Node 定时器安全上限；超出后回退默认，避免 Node 将超大 delay 折叠成约 1ms。 */
const MAX_PARENT_REQUEST_TIMEOUT_MS = 2_147_000_000

function parseTimeoutEnv(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  if (!STRICT_TIMEOUT_ENV_PATTERN.test(raw)) {
    console.warn(`[AgentRuntime] 忽略非法超时配置 ${name}=${raw}（需为非负整数字符串），使用默认 ${fallback}ms`)
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_PARENT_REQUEST_TIMEOUT_MS) {
    console.warn(`[AgentRuntime] 忽略超出安全范围的超时配置 ${name}=${raw}，使用默认 ${fallback}ms`)
    return fallback
  }
  return parsed
}

/**
 * 解析 requestParent 超时（毫秒）。返回 undefined 表示不设超时定时器。
 * 显式传 env 以便测试；生产路径读 process.env。
 */
export function getParentRequestTimeoutMs(
  method: string,
  env: ParentRequestTimeoutEnv | NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env as NodeJS.ProcessEnv
  switch (method) {
    case AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL:
      return parseTimeoutEnv(
        raw[PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV],
        0,
        PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV,
      ) || undefined
    case AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL:
      return parseTimeoutEnv(
        raw[PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV],
        CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS,
        PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV,
      ) || undefined
    default:
      return DEFAULT_PARENT_REQUEST_TIMEOUT_MS
  }
}
