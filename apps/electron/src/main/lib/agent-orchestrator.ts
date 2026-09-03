/**
 * AgentOrchestrator — Agent 编排层
 *
 * 从 agent-service.ts 提取的核心业务逻辑，负责：
 * - 并发守卫（同一会话不允许并行请求）
 * - 渠道查找 + API Key 解密
 * - 环境变量构建 + SDK 路径解析
 * - 用户/助手消息持久化
 * - 事件流遍历 + 文本累积 + 事件持久化
 * - 错误处理 + 部分内容保存
 * - 自动标题生成
 *
 * 通过 EventBus 分发 AgentEvent，通过 SessionCallbacks 发送控制信号，
 * 完全解耦 Electron IPC，可独立测试（mock Adapter + EventBus）。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from 'node:fs'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { app } from 'electron'
import type { AgentSendInput, AgentMessage, AgentGenerateTitleInput, AgentProviderAdapter, AgentSessionMeta, CodexOAuthCredentials, XaiOAuthCredentials, TypedError, SDKMessage, SDKAssistantMessage, AgentStreamPayload, AgentAssistantDeltaPayload, RewindSessionResult, SkillActivation } from '@proma/shared'
import {
  PROMA_DEFAULT_PERMISSION_MODE,
  PROMA_PERMISSION_MODE_CONFIG,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isPersistableSDKSystemMessage,
  normalizePathForCompare,
  normalizeMcpTransportType,
  inferContextWindow,
  inferReasoningTransport,
  resolveReasoningProfile,
  collectSkillActivations,
  mergeSkillActivations,
} from '@proma/shared'
import type { PromaPermissionMode, AskUserRequest, ExitPlanModeRequest, SDKSystemMessage } from '@proma/shared'
import type { PiAgentQueryOptions } from './adapters/pi-agent-adapter'
import { getMainRepoRoot } from './git-diff-service'
import { getPiAssistantErrorDetails, hasPiAssistantTextContent, stripPiAssistantError } from './adapters/pi-message-adapter'
import { friendlyErrorMessage, isPromptTooLongError, isThinkingSignatureError, mapAgentErrorToTypedError } from './agent-error-utils'
import { getActiveRunRejectionMessage, shouldPersistInitialUserMessage } from './agent-send-message-policy'
import { isSessionNotFoundError } from './error-patterns'
import { AgentEventBus } from './agent-event-bus'
import { ApiKeyDecryptError, getChannelById, listChannels, persistCodexOAuthCredentials, persistXaiOAuthCredentials, resolveChannelRuntimeApiKey, resolveCodexOAuthCredentials, resolveXaiOAuthCredentials } from './channel-manager'
import { getAdapter, fetchTitle } from '@proma/core'
import pkg from '../../../package.json' with { type: 'json' }
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendSDKMessages, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages, removeSDKErrorMessage, updateSDKUserMessageSkillActivations, rewindPiAgentSession, resolveAgentCwd, getActiveWorktreePath, getAgentCwdMode, getSessionWorkbenchLayout } from './agent-session-manager'
import { getAgentWorkspace, getLocalProjectRootStatus, getProjectFilesPath, getWorkspaceMcpConfig, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles, getWorkspaceAgentsMdPath, readWorkspaceAgentsMd, getWorkspaceMemoryGuidance, isWorkspaceProjectKnowledgeMaintenanceApproved } from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath, getSdkConfigDir, getWorkspaceSkillsDir } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import { getSettings } from './settings-service'
import { buildSystemPrompt, buildDynamicContext } from './agent-prompt-builder'
import { getNanjuRouterPrompt } from './nanju-router-prompt'
import { checkNanjuRouterGate, verifyPhaseOutput } from './nanju-router-gate'
import { NANJU_GUARDS, type NanjuGuardStage } from './nanju-project'
import type { GwtProgressEvent } from './nanju-gwt-runner'
import { resolveProjectInstructions } from './project-instruction-resolver'
import { combinePromaInstructionFiles } from './adapters/pi-resource-loader-overrides'
import { MAX_CONTEXT_MESSAGES, buildContextPrompt, buildRecoveryPrompt, buildReferencedSessionsPrompt } from './agent-session-context-prompt'
import { buildReferencedPlanningPrompt } from './planning-reference-context'
import { permissionService } from './agent-permission-service'
import type { PermissionResult, CanUseToolOptions } from './agent-permission-service'
import { resolvePlanningDeletionPermission } from './planning-permission-policy'
import { askUserService } from './agent-ask-user-service'
import { runRegisteredHeadlessAgent } from './agent-headless-runner-registry'
import { exitPlanService, type ExitPlanPermissionResult } from './agent-exit-plan-service'
import { validateToolInput } from './agent-tool-input-validator'
import { estimateTokenCount, WRITE_CONTENT_TOKEN_THRESHOLD } from './agent-tool-token-estimator'
import { buildPiBuiltinTools } from './adapters/pi-builtin-tools'
import { buildPiMcpTools } from './adapters/pi-mcp-tools'
import { buildAgentRuntimeEnv, type AgentRuntimeEnv } from './agent-runtime-env'
import { isVisibleRunMessage } from './agent-run-message-visibility'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { resolvePiReasoningCapability } from './adapters/pi-model-registry'
import { generateCodexTitle } from './adapters/pi-codex-title-generator'
import { createFallbackTitle, sanitizeGeneratedTitle, TITLE_PROMPT } from './title-generation'
import { claimWorkspaceMemoryRefreshOpportunity } from './agent-memory-refresh-service'
import { browserController } from './browser-controller'

// ===== 类型定义 =====

/**
 * 会话控制信号回调
 *
 * 解耦 Electron webContents，使 Orchestrator 可独立测试。
 * agent-service.ts 负责将这些回调绑定到 webContents.send()。
 */
export interface SessionCallbacks {
  /** 发送流式错误 */
  onError: (error: string) => void
  /** 发送流式完成（携带已持久化的消息列表） */
  onComplete: (messages?: AgentMessage[], opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean }) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number }) => void
}

type RecoverableAgentQueryOptions = {
  prompt: string
  resumeSessionId?: string
  resumeSessionAt?: string
}

// ===== 工具函数 =====

const EMPTY_RESPONSE_RESULT_SUBTYPE = 'empty_response'

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingActiveQueueChannelError(error: unknown): boolean {
  return errorMessageOf(error).includes('无活跃消息通道可注入队列消息')
}

function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function isAssistantDeltaSDKMessage(message: SDKMessage): message is SDKMessage & {
  type: 'assistant_delta'
  uuid: string
  delta: AgentAssistantDeltaPayload['deltas'][number]
  session_id?: string
  _channelModelId?: string
} {
  const record = message as Record<string, unknown>
  return record.type === 'assistant_delta'
    && typeof record.uuid === 'string'
    && !!record.delta
}

/** 默认会话标题（用于判断是否需要自动生成） */
const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/** 默认模型 ID */
const DEFAULT_MODEL_ID = 'claude-sonnet-5'

/**
 * 聚合一次 SDK 调用涉及的所有附加目录（去重，保持插入顺序）。
 *
 * 来源：
 *   1. extraDirs：调用方传入的临时附加目录（例如 sendMessage 时用户当次提交的目录）
 *   2. 当前会话的私有工作目录，以及会话级 attachedDirectories + attachedFiles 的父目录
 *   3. 工作区级 attachedDirectories + attachedFiles 的父目录
 *   4. 项目文件根目录（本地项目为用户目录，空白项目为 workspace-files/）
 */
function collectAttachedDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const { sessionMeta, workspaceSlug, extraDirs } = params
  const result: string[] = []
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  for (const d of extraDirs ?? []) push(d)
  if (sessionMeta?.activeWorktree?.path) push(sessionMeta.activeWorktree.path)
  if (workspaceSlug && sessionMeta) push(getAgentSessionWorkspacePath(workspaceSlug, sessionMeta.id))
  for (const d of sessionMeta?.attachedDirectories ?? []) push(d)
  for (const file of sessionMeta?.attachedFiles ?? []) push(dirname(file))

  if (workspaceSlug) {
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getProjectFilesPath(workspaceSlug))
  }

  return result
}

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildPiAdditionalDirectoriesPrompt(directories: string[]): string {
  if (directories.length === 0) return ''
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  return `

<attached_directories>
这些目录已由 Proma 授权给当前会话，和当前工作目录同属于用户允许访问的范围。
如需读取或修改这些目录中的内容，请直接使用绝对路径，不要先复制到当前工作目录。
${directoryLines}
</attached_directories>`
}

const LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE = 'local_project_root_unavailable'

function createLocalProjectRootUnavailableError(projectRootPath: string, status?: string): Error {
  const error = new Error(
    `本地项目根目录不可用: 本地项目根目录不存在或无法访问：${projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
  ) as Error & { code?: string; details?: string[] }
  error.code = LOCAL_PROJECT_ROOT_UNAVAILABLE_CODE
  error.details = status ? [`目录状态: ${status}`] : undefined
  return error
}

/** 验证本地项目根，并返回用于跨会话比较的真实规范化路径。 */
function resolveLocalProjectRootForRewind(projectRootPath: string): string {
  const status = getLocalProjectRootStatus(projectRootPath)
  if (status !== 'available') {
    throw createLocalProjectRootUnavailableError(projectRootPath, status)
  }

  try {
    accessSync(projectRootPath, constants.R_OK | constants.W_OK | constants.X_OK)
    const realRoot = realpathSync(projectRootPath)
    const normalizedRoot = normalizePathForCompare(realRoot) || realRoot
    return process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  } catch {
    throw createLocalProjectRootUnavailableError(projectRootPath, 'unavailable')
  }
}

// ===== AgentOrchestrator =====

/** 南大 R1（W1）：委派状态事件接线幂等标记（orchestrator 重建不重复订阅） */
let nanjuDelegationStatusWired = false

export class AgentOrchestrator {
  private adapter: AgentProviderAdapter
  private eventBus: AgentEventBus
  private activeSessions = new Map<string, number>()
  private nextRunGeneration = 0

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()
  /** Skill callback may precede queue-message JSONL persistence by one event loop. */
  private pendingUserSkillActivations = new Map<string, Map<string, SkillActivation[]>>()

  /** 被用户手动中止的运行代际（在 stop 中标记，在对应运行的终态路径消费）。 */
  private stoppedBySessions = new Map<string, number>()
  /** 队列启动投影已显示、但运行槽尚未占用时的停止请求。 */
  private stoppedBeforeRunSessions = new Set<string>()

  /** 运行中会话的当前权限模式（支持运行时动态切换） */
  private sessionPermissionModes = new Map<string, PromaPermissionMode>()
  /** 南大向导 GWT 验收：正在跑测试的项目（防同项目重复触发） */
  private runningGwtProjects = new Set<string>()

  /**
   * 南大 L2 委派超时兑底（v0.17.64 Sprint C1，实证②：deepseek 渠道挂起 1h+ 零响应）。
   * 观察哨逻辑在 nanju-delegation-watch.ts（依赖注入、可单测）；此处惰性构建并接轮询定时器。
   */
  private nanjuDelegationWatcher: InstanceType<typeof import('./nanju-delegation-watch').NanjuDelegationWatcher> | null = null
  private nanjuDelegationWatchTimer: ReturnType<typeof setInterval> | null = null

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus) {
    this.adapter = adapter
    this.eventBus = eventBus
    // 南大 R1（W1）：委派生命周期 → nanju:delegation-status IPC（渲染端等待 Toast 数据源；只加 emit 接线）
    this.wireNanjuDelegationStatusEvents()
  }

  /**
   * 南大 R1（W1）：订阅 agent-collaboration-tools 委派生命周期，转发主窗广播。
   * 只做转发不改既有逻辑；模块级幂等（多实例/重建不重复订阅）。
   */
  private wireNanjuDelegationStatusEvents(): void {
    if (nanjuDelegationStatusWired) return
    try {
      const { subscribeDelegationLifecycle } = require('./agent-collaboration-tools') as typeof import('./agent-collaboration-tools')
      const { emitDelegationStatus } = require('./nanju-delegation-status') as typeof import('./nanju-delegation-status')
      nanjuDelegationStatusWired = true
      subscribeDelegationLifecycle((event) => {
        emitDelegationStatus({
          sessionId: event.parentSessionId,
          delegationId: event.delegationId,
          childSessionId: event.childSessionId,
          phase: event.phase,
          label: event.title,
          startedAt: event.startedAt,
          elapsedMs: event.settledAt != null ? event.settledAt - event.startedAt : 0,
          reason: event.reason,
        })
      })
    } catch (e) {
      console.warn('[南大护栏] 委派状态事件接线失败（不影响委派）:', e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 消费一次用户手动停止标记。
   *
   * SDK 在 query.close() 后不一定走异常路径：某些版本会先正常 yield result 再结束迭代。
   * 因此停止标记必须在所有终态路径统一消费，而不能只依赖 catch 块。
   */
  private consumeStoppedByUser(sessionId: string, runGeneration: number): boolean {
    if (this.stoppedBySessions.get(sessionId) !== runGeneration) return false
    this.stoppedBySessions.delete(sessionId)
    return true
  }

  /**
   * 构建工作区 MCP 服务器配置
   */
  private buildMcpServers(workspaceSlug: string | undefined): Record<string, Record<string, unknown>> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      const type = normalizeMcpTransportType((entry as { type?: unknown }).type)

      if (type === 'stdio' && entry.command) {
        const mergedEnv: Record<string, string> = {
          ...(process.env.PATH && { PATH: process.env.PATH }),
          ...entry.env,
        }
        mcpServers[name] = {
          type: 'stdio',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 && { args: entry.args }),
          ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
          required: false,
          startup_timeout_sec: entry.timeout ?? 30,
        }
      } else if ((type === 'http' || type === 'sse') && entry.url) {
        mcpServers[name] = {
          type,
          url: entry.url,
          ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
          required: false,
        }
      } else {
        console.warn(`[Agent 编排] MCP 服务器 "${name}" 配置不完整，已跳过（type=${entry.type}, command=${entry.command ?? '无'}, url=${entry.url ?? '无'}）`)
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      console.log(`[Agent 编排] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
    }

    return mcpServers
  }

  /**
   * 生成 Agent 会话标题
   *
   * 使用 Provider 适配器系统，支持所有渠道。任何错误返回 null。
   */
  async generateTitle(input: AgentGenerateTitleInput, signal?: AbortSignal): Promise<string | null> {
    const { userMessage, channelId, modelId } = input
    if (signal?.aborted) return null
    console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

    // 渠道信息在异常路径也要用于判断是否应用 OpenCode Go 本地兜底，因此提前解析；
    // 同时保留 listChannels 自身的错误边界：解析失败时按“无渠道”处理并返回 null。
    let channel: import('@proma/shared').Channel | undefined
    try {
      channel = listChannels().find((c) => c.id === channelId)
    } catch (error) {
      console.warn('[Agent 标题生成] 渠道解析失败:', error)
      return null
    }
    if (!channel) {
      console.warn('[Agent 标题生成] 渠道不存在:', channelId)
      return null
    }

    if (channel.provider === 'xai') {
      // xAI subscription uses Pi's provider-specific OAuth transport; title generation's
      // generic channel adapter only understands API keys, so retain a local deterministic title.
      return createFallbackTitle(userMessage)
    }

    if (channel.provider === 'openai-codex') {
      const fallbackTitle = createFallbackTitle(userMessage)
      try {
        const [credentials, proxyUrl] = await Promise.all([
          resolveCodexOAuthCredentials(channelId),
          getEffectiveProxyUrl(),
        ])
        if (signal?.aborted) return null
        const generatedTitle = await generateCodexTitle({
          modelId,
          prompt: TITLE_PROMPT + userMessage,
          credentials,
          proxyUrl,
          signal,
          onCredentialsRefreshed: (refreshed) => persistCodexOAuthCredentials(channelId, refreshed),
        })
        if (signal?.aborted) return null
        const title = generatedTitle ? sanitizeGeneratedTitle(generatedTitle) : null
        if (title) {
          console.log(`[Agent 标题生成] ChatGPT OAuth 语义标题生成成功: "${title}"`)
          return title
        }
        console.warn('[Agent 标题生成] ChatGPT OAuth 返回空标题，使用本地兜底')
      } catch (error) {
        if (signal?.aborted) return null
        console.warn('[Agent 标题生成] ChatGPT OAuth 语义标题生成失败，使用本地兜底:', error)
      }
      return fallbackTitle
    }

    try {
      const apiKey = await resolveChannelRuntimeApiKey(channelId)
      const providerAdapter = getAdapter(channel.provider)
      const request = providerAdapter.buildTitleRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        prompt: TITLE_PROMPT + userMessage,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitle(request, providerAdapter, fetchFn)
      const result = title ? sanitizeGeneratedTitle(title) : null
      if (!result) {
        console.warn('[Agent 标题生成] API 未返回可用标题')
        // OpenCode Go 的推理模型可能把输出预算全花在推理上返回空正文，或
        // 内容块为数组；自定义渠道（custom）也可能返回空/异常；任何取不到可用标题的情况
        // 都回退到首行兜底，保证会话一定被重命名。
        return (channel.provider === 'opencode-go-openai' || channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
      }

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      console.warn('[Agent 标题生成] 生成失败:', error)
      // OpenCode Go / 自定义渠道的服务端偶发返回空标题/异常响应/超时，异常路径同样要完成重命名。
      return (channel.provider === 'opencode-go-openai' || channel.provider === 'custom') ? createFallbackTitle(userMessage) : null
    }
  }

  /**
   * 流完成后自动生成标题
   *
   * 如果会话标题仍为默认值，自动调用标题生成并通过回调通知。
   */
  private async autoGenerateTitle(
    sessionId: string,
    userMessage: string,
    channelId: string,
    modelId: string,
    callbacks: SessionCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    try {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

      const title = await this.generateTitle({ userMessage, channelId, modelId }, signal)
      if (!title || signal?.aborted) return

      // 标题请求是异步的；请求期间用户可能已手动重命名，不能用旧结果覆盖。
      const latestMeta = getAgentSessionMeta(sessionId)
      if (!latestMeta || latestMeta.title !== DEFAULT_SESSION_TITLE) return

      updateAgentSessionMeta(sessionId, { title })
      callbacks.onTitleUpdated(title)
      console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
    } catch (error) {
      if (signal?.aborted) return
      console.warn('[Agent 编排] 自动标题生成失败:', error)
    }
  }

  /**
   * Session-not-found 恢复：保留磁盘 sdkSessionId，本轮切换到上下文回填模式
   *
   * 当 resume 的目标 session 报 "No conversation found" 时触发。注意该错误可能是
   * listSessions 路径哈希不匹配导致的误检（见步骤 9.6 注释），不代表会话真正失效，
   * 因此不清除磁盘 meta：本轮以非 resume 模式恢复，若失败下一轮仍可尝试 resume（#903）。
   * 调用方负责设置本地 existingSdkSessionId = undefined 和流程控制（break/continue）。
   *
   */
  // ===== 南大向导 GWT 验收测试（P1 Sprint B：testing 阶段机器裁判闭环） =====

  /** 注入一条可见的 assistant 消息（可见化模式，与 PHASE_ADVANCE 拦截注入同型） */
  private injectNanjuAssistantMessage(sessionId: string, text: string): void {
    this.eventBus.emit(sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
      } as unknown as SDKMessage,
    })
  }

  /** GWT 交付门禁：testing → delivered 必须已有 verdict=pass 的测试报告（机器裁判收口） */
  private checkNanjuGwtDeliveryGate(workspaceSlug: string, projectId: string): string | null {
    // 门禁感知运行中（v0.17.63，AC Z-006）：本轮测试还在跑（结果尚未写回 report.json）时
    // 不误拦——引导等待本轮完成后再声明交付，避免读到上一轮旧报告的 TOCTOU 交错
    if (this.runningGwtProjects.has(projectId)) {
      return '验收测试正在运行中（本轮结果尚未写回测试报告）。请等待本轮测试完成、系统注入结果后再声明推进交付。'
    }
    try {
      const { existsSync, readFileSync } = require('node:fs')
      const { getNanjuProjectDir } = require('./nanju-project') as typeof import('./nanju-project')
      const { join } = require('node:path')
      const reportPath = join(getNanjuProjectDir(workspaceSlug, projectId), '06_TESTS', 'report.json')
      if (!existsSync(reportPath)) {
        return '测试尚未执行（06_TESTS/report.json 不存在）。请先声明 <!-- PHASE_ADVANCE: testing --> 触发自动验收测试，全部通过后系统会自动交付。'
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { verdict?: string; passed?: number; scenariosTotal?: number; errorReason?: string | null }
      // error 报告（v0.17.63，AC Z-005/L-003）：给「重跑测试」指引而非裸拦截
      if (report?.verdict === 'error') {
        return `验收测试执行异常（${report?.errorReason ?? '未知原因'}），测试结论不可用。请检查 08_APP/index.html 与 06_TESTS/ 产物后重跑测试（声明 <!-- PHASE_ADVANCE: testing -->）。`
      }
      if (report?.verdict !== 'pass') {
        return `验收测试未通过（${report?.passed ?? 0}/${report?.scenariosTotal ?? 0} 个场景通过）。请按测试报告修复缺陷后重跑（声明 <!-- PHASE_ADVANCE: testing -->）。`
      }
      return null
    } catch (e) {
      return `测试报告读取失败：${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** 阶段推进 Todo 兑底（从 PHASE_ADVANCE 检测块抽出的复用段：本会话 open Todo 批量完成） */
  private finalizeNanjuPhaseTodos(sessionId: string): void {
    try {
      const { listTodos, updateTodo } = require('./planning-manager') as typeof import('./planning-manager')
      const openTodos = listTodos({ status: 'open', limit: 100 })
      const linked = openTodos.filter((t) =>
        t.sessionLinks?.some((l) => l.sessionId === sessionId)
        && !t.nativeOrigin)
      for (const t of linked) {
        try { updateTodo({ id: t.id, status: 'completed' }) } catch { /* 单条失败不阻断 */ }
      }
      if (linked.length > 0) {
        console.log(`[南大路由] 阶段推进收尾：已自动完成 ${linked.length} 个本会话 Todo`)
      }
    } catch (todoErr) {
      console.warn(`[南大路由] Todo 自动收尾失败（不影响推进）:`, todoErr instanceof Error ? todoErr.message : String(todoErr))
    }
  }

  /**
   * 触发 GWT 验收测试（异步，不阻塞本轮 result 流）。
   *
   * 触发时机：PHASE_ADVANCE: testing 重入（currentStage 已是 testing）——
   * 首次 = 场景已生成；重跑 = coding 缺陷已修复。完成后按规则裁判结果处理：
   * - pass → updateNanjuProject(delivered) + Todo 收尾 + 交付完成富语（机器裁判收口）
   * - error（执行异常）→ errorCount 独立计数（v0.17.64 #6）：errorCount≥1 即熔断，转人工介入
   *   （不自动烧回炉；排查环境后重跑属用户指示的复位路径）
   * - fail 未超限（<3 次，回炉预算未耗尽）且未熔断（v0.17.65 AC Z-1：failCount≥3 或 errorCount≥1 即熔断，熔断后拒绝自动续接）
   *   → 按失败构成分流（v0.17.63 AC L-001）：
   *   · behavior（assert 行为类）→ 回炉 coding 修复代码
   *   · mapping（selector 等待超时/未映射）→ 回炉 testing 重写 steps.json 映射（不烧 coding 预算）
   *   · coverage（US 缺场景）→ 回炉 testing 补场景；PRD 缺 US-xx 清单 → 指引补 PRD（需用户确认）
   * - fail 超限（≥3 次，1 首产 + 2 回炉）→ 注入人工介入提示（notify_user 语义）
   */
  private triggerNanjuGwtRun(input: {
    workspaceSlug: string
    projectId: string
    projectName: string
    projectMode: 'quick' | 'iterative'
    sessionId: string
    resume: { channelId: string; modelId?: string; workspaceId?: string; permissionModeOverride?: PromaPermissionMode }
  }): void {
    const { workspaceSlug, projectId, projectName, projectMode, sessionId, resume } = input
    // 风险告知预检（v0.17.63，AC L-002）：quick 流程 coding 收口走 open_preview（预览协议），
    // 此前可能从未打开受管浏览器 → 未确认风险告知时直接给行动指引（含原文指引 + 人工预览降级
    // 出口），不进 GwtRunner 吃裸异常断链。
    try {
      if (!browserController.hasRiskDisclaimerAcknowledged()) {
        this.injectNanjuAssistantMessage(
          sessionId,
          '⚠️ 尚未确认平台账号风险告知，浏览器验收测试无法启动。\n\n'
          + '· 确认后重跑：请在浏览器面板阅读并确认平台账号风险告知（首次使用受管浏览器前，请在浏览器面板阅读并确认平台账号风险告知后重试），'
          + '然后重新声明推进 <!-- PHASE_ADVANCE: testing -->。\n'
          + '· 不想确认的降级出口：可跳过浏览器自动测试，直接人工预览验证——让调度员用 open_preview 打开 08_APP/index.html，'
          + '你逐条核对用户故事后告知调度员结论；交付收口仍需测试报告，建议确认告知后重跑一次自动测试。',
        )
        return
      }
    } catch (precheckErr) {
      console.warn('[南大路由] 风险告知预检失败（不阻断，交由 GwtRunner 原生异常兜底）:', precheckErr instanceof Error ? precheckErr.message : String(precheckErr))
    }
    if (this.runningGwtProjects.has(projectId)) {
      console.log(`[南大路由] GWT 验收已在进行中：${projectName}，忽略重复触发`)
      return
    }
    this.runningGwtProjects.add(projectId)

    // 进度 IPC：主窗广播（NANJU_PREVIEW_CHANNEL 同型模式）
    const emitProgress = (p: GwtProgressEvent): void => {
      try {
        const { getMainWindow } = require('./main-window-store') as typeof import('./main-window-store')
        const win = getMainWindow()
        win?.webContents.send('nanju:gwt-progress', { sessionId, projectId, ...p })
      } catch { /* IPC 失败不影响测试执行 */ }
    }

    this.injectNanjuAssistantMessage(
      sessionId,
      '🧪 开始自动验收测试：系统将在应用内测试标签中逐场景执行（每个场景独立重载页面，避免状态串扰），完成后自动汇总裁判并给出测试报告。',
    )

    void (async () => {
      try {
        const { runNanjuGwtAcceptance } = require('./nanju-gwt-runner') as typeof import('./nanju-gwt-runner')
        const outcome = await runNanjuGwtAcceptance({
          workspaceSlug,
          projectId,
          projectName,
          projectMode,
          sessionId,
          controller: browserController,
          onProgress: emitProgress,
        })
        // 熔断状态机接入（v0.17.64 Sprint C1）：GWT fail/error 轮次计入 phaseGuards.testing
        // （写入点收敛 updatePhaseGuard，与 report.json 的 retryCount/errorCount 同节奏写入），
        // pass 轮清零；failCount≥3（1 首产 + 2 回炉，AC Z-1）或 errorCount≥1 即熔断（NANJU_GUARDS 阈值）。
        let gwtCircuitOpen = false
        let gwtCircuitJustOpened = false
        let gwtCircuitNarrative = ''
        try {
          const { updatePhaseGuard, isPhaseGuardCircuitOpen } = require('./nanju-project') as typeof import('./nanju-project')
          const guardKind = outcome.verdict === 'pass' ? 'reset' : outcome.verdict === 'error' ? 'error' : 'fail'
          const { previous, current } = updatePhaseGuard(workspaceSlug, projectId, 'testing', {
            kind: guardKind,
            note: `GWT ${outcome.verdict}${outcome.failureKind ? ':' + outcome.failureKind : ''}`,
          })
          gwtCircuitOpen = isPhaseGuardCircuitOpen(current).open
          gwtCircuitJustOpened = !isPhaseGuardCircuitOpen(previous ?? undefined).open && gwtCircuitOpen
          // AC U-1（v0.17.65）：话术去行话——failCount/errorCount 转述为「连续失败/执行异常」次数
          const narrativeParts: string[] = []
          if (current.failCount > 0) narrativeParts.push(`连续失败 ${current.failCount} 次`)
          if (current.errorCount > 0) narrativeParts.push(`执行异常 ${current.errorCount} 次`)
          gwtCircuitNarrative = narrativeParts.join('、')
          if (gwtCircuitJustOpened) {
            try {
              const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
              recordTelemetry(workspaceSlug, 'circuit_break', {
                project_id: projectId,
                stage: 'testing',
                source: 'gwt_outcome',
                reason: outcome.verdict === 'error' ? `GWT 执行异常：${outcome.errorReason ?? '未知'}` : `GWT 失败累计达阈值（${outcome.failureKind ?? 'unknown'}）`,
                fail_count: current.failCount,
                error_count: current.errorCount,
                retry_round: outcome.retryCount,
                error_round: outcome.errorCount,
              }, projectId)
            } catch { /* 埋点失败不影响主流程 */ }
            // 南大 R3（W1）：新触发熔断 → nanju:guard-alert（GuardAlertCard 数据源；只加 emit 不改状态机）
            try {
              const { emitGuardAlert, NANJU_GUARD_ALERT_MESSAGE } = require('./nanju-guard-alert') as typeof import('./nanju-guard-alert')
              emitGuardAlert({ sessionId, projectId, stage: 'testing', message: NANJU_GUARD_ALERT_MESSAGE })
            } catch { /* IPC 失败不影响结果处理 */ }
          }
        } catch (guardErr) {
          console.warn('[南大护栏] GWT 熔断计数更新失败（不影响结果处理）:', guardErr instanceof Error ? guardErr.message : String(guardErr))
        }
        // AC U-1（v0.17.65）：三选项裁决口径单出口——「熔断/查看测试报告/三选项」各只出现一遍。
        // 熔断态才说「不再自动续接回炉」（L-1 口径一致）；非熔断分支不含熔断字样。
        const humanDecisionLine = `请查看测试报告 ${outcome.reportMdPath}，由用户裁决：终止项目 / 人工修复后继续 / 跳过测试直接交付（告诉调度员你的选择即可）。`
        const circuitSuffix = gwtCircuitOpen
          ? `\n\n⛔ 该阶段已触发熔断（${gwtCircuitNarrative}），系统不再自动续接回炉。${humanDecisionLine}`
          : ''
        if (outcome.verdict === 'pass') {
          // 机器裁判收口：全场景通过 + US 全覆盖 → 直接交付（推进即事实）
          const { updateNanjuProject } = require('./nanju-project') as typeof import('./nanju-project')
          updateNanjuProject(workspaceSlug, projectId, { currentStage: 'delivered' })
          console.log(`[南大路由] ✅ GWT 验收通过，项目交付: ${projectName}`)
          // W2 S1：机器裁判交付是推进点 A/B 之外的第三条 delivered 路径，同步清空子步骤
          // 并广播（同 A 语义；工单未列此路径，按「交付=清空子步骤」纪律补齐，报告记录）；
          // W10：同路径消费清除确认待推进（confirmPending=testing 时确认提示已引导过推进）
          try {
            const { setProjectSubStage, clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
            const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
            setProjectSubStage(workspaceSlug, projectId, '')
            clearProjectConfirmPending(workspaceSlug, projectId)
            emitGuideProgress(sessionId, projectId, 'delivered', '')
          } catch { /* 向导图子步骤广播失败不影响交付 */ }
          this.finalizeNanjuPhaseTodos(sessionId)
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + '\n\n🎉 项目已全部完成交付！\n\n向导流程到此结束。产出物在项目目录（01_PRD / 02_UX_DESIGN / 08_APP），可运行应用入口 08_APP/index.html，可随时回看。想继续做新东西？在南大向导首页点「快速做一个工具」开始新项目。',
          )
        } else if (outcome.verdict === 'error') {
          // 执行异常（v0.17.63，AC Z-005/L-003）：报告已落盘（verdict=error）+ retryCount 已计数；
          // v0.17.64：errorCount 独立计数后 errorCount≥1 即熔断——不再自动烧回炉续接，转人工介入
          // v0.17.65 AC U-1：去重——正文只说异常事实，「熔断/查看报告/三选项」由 circuitSuffix
          // （熔断态）或 humanDecisionLine（计数更新失败的兑底）单一出口承载
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText
            + (outcome.retryLimitReached
              ? `\n\n⛔ 测试执行异常累计已达上限（${outcome.retryCount} 轮），转为人工介入。`
              : '\n\n⛔ 测试执行异常（执行异常非代码缺陷，重试无意义），转为人工介入。')
            + (gwtCircuitOpen ? circuitSuffix : `\n\n${humanDecisionLine}`),
          )
        } else if (outcome.retryLimitReached || gwtCircuitOpen) {
          // 重试超限 / 熔断（fail≥3 或 error≥1，AC Z-1）→ 人工介入（handlePhaseResult notify_user 语义的产品化落地）
          // v0.17.65 AC U-1：报告路径与三选项收敛到 circuitSuffix/humanDecisionLine 单出口
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + `\n\n⛔ 测试回炉已达上限（${outcome.retryCount} 次），转为人工介入。`
            + (gwtCircuitOpen ? circuitSuffix : `\n\n${humanDecisionLine}`),
          )
        } else if (outcome.failureKind === 'coverage' && outcome.prdUserStoriesMissing) {
          // 覆盖性基准缺失（v0.17.63，AC F-002）：PRD 缺 US-xx 清单 → 指引补 PRD
          // （需求变更需用户确认，不自动烧回炉续接）
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + '\n\n处理指引：请与用户确认需求范围后，用 continue_delegation 委派「需求分析师」补充 PRD 用户故事清单'
            + '（每条用「US-01 / US-02 …」编号命名并含验收标准），完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。',
          )
        } else if (outcome.failureKind === 'coverage') {
          // 覆盖类失败（AC L-001 分流）：US 无可执行场景 → 回 testing 补场景（不动 coding）
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + '\n\n失败清单：\n' + outcome.failListText
            + '\n\n请 continue_delegation 委派「测试工程师」为缺失的用户故事补生成 GWT 场景与 steps.json 映射'
            + '（只写 06_TESTS/，不动 08_APP/ 与 01_PRD/），完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。',
          )
          setTimeout(() => {
            runRegisteredHeadlessAgent(
              {
                sessionId,
                userMessage: '验收未通过（覆盖类：部分用户故事无可执行场景）。请按系统注入的清单处理：用 continue_delegation 委派测试工程师为缺失的用户故事补场景与映射（只写 06_TESTS/），完成后重新声明推进 <!-- PHASE_ADVANCE: testing -->。',
                channelId: resume.channelId,
                modelId: resume.modelId,
                workspaceId: resume.workspaceId,
                permissionModeOverride: resume.permissionModeOverride,
                startedAt: Date.now(),
              },
              {
                source: 'delegation',
                onError: (error: string) => console.warn('[南大路由] GWT 覆盖类回炉续接错误:', error),
                onComplete: () => {},
                onTitleUpdated: () => {},
              },
            ).catch((e: unknown) => {
              console.warn('[南大路由] GWT 覆盖类回炉续接失败:', e instanceof Error ? e.message : String(e))
            })
          }, 1500)
        } else if (outcome.failureKind === 'mapping') {
          // 映射类失败（AC L-001 分流）：selector 等待超时/未映射 → 回 testing 重写映射，不烧 coding 预算
          // W2c（v0.17.69）：失败分流观测——记回归事件（testing→testing 自环重写映射）
          try {
            const { recordGwtFailureRegression } = require('./nanju-regression') as typeof import('./nanju-regression')
            recordGwtFailureRegression(workspaceSlug, projectId, 'mapping', { sessionId })
          } catch { /* 回归记录失败不影响分流 */ }
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + '\n\n失败清单：\n' + outcome.failListText
            + '\n\n这些是步骤映射问题（目标元素等待超时未出现/未映射），不是应用缺陷。请 continue_delegation 委派「测试工程师」'
            + '重新核对 08_APP 实码的 data-ai-id 后重写对应 steps.json 映射（只改 06_TESTS/，不动 08_APP/ 与 01_PRD/），'
            + '完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。',
          )
          setTimeout(() => {
            runRegisteredHeadlessAgent(
              {
                sessionId,
                userMessage: '验收未通过（映射类：步骤映射与实际代码不符）。请按系统注入的清单处理：用 continue_delegation 委派测试工程师重新映射 steps.json（只改 06_TESTS/，不得改 08_APP/），完成后重新声明推进 <!-- PHASE_ADVANCE: testing -->。',
                channelId: resume.channelId,
                modelId: resume.modelId,
                workspaceId: resume.workspaceId,
                permissionModeOverride: resume.permissionModeOverride,
                startedAt: Date.now(),
              },
              {
                source: 'delegation',
                onError: (error: string) => console.warn('[南大路由] GWT 映射类回炉续接错误:', error),
                onComplete: () => {},
                onTitleUpdated: () => {},
              },
            ).catch((e: unknown) => {
              console.warn('[南大路由] GWT 映射类回炉续接失败:', e instanceof Error ? e.message : String(e))
            })
          }, 1500)
        } else {
          // 行为类失败（AC L-001 分流）：assert 断言不满足 → 回炉 coding 修复（≤2 次）
          // W2c（v0.17.69）：失败分流观测——记回归事件（testing→coding 回炉开发）
          try {
            const { recordGwtFailureRegression } = require('./nanju-regression') as typeof import('./nanju-regression')
            recordGwtFailureRegression(workspaceSlug, projectId, 'behavior', { sessionId })
          } catch { /* 回归记录失败不影响分流 */ }
          this.injectNanjuAssistantMessage(
            sessionId,
            outcome.summaryText + '\n\n失败清单：\n' + outcome.failListText
            + '\n\n请 continue_delegation 委派「全栈开发」修复以上缺陷（仅改 08_APP/ 下代码，不得改 06_TESTS/ 与 01_PRD/），'
            + '修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。',
          )
          setTimeout(() => {
            runRegisteredHeadlessAgent(
              {
                sessionId,
                userMessage: '验收测试未全部通过（行为类：应用缺陷）。请按系统注入的失败清单处理：用 continue_delegation 委派全栈开发修复缺陷（仅改 08_APP/），修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing -->。',
                channelId: resume.channelId,
                modelId: resume.modelId,
                workspaceId: resume.workspaceId,
                permissionModeOverride: resume.permissionModeOverride,
                startedAt: Date.now(),
              },
              {
                source: 'delegation',
                onError: (error: string) => console.warn('[南大路由] GWT 回炉续接错误:', error),
                onComplete: () => {},
                onTitleUpdated: () => {},
              },
            ).catch((e: unknown) => {
              console.warn('[南大路由] GWT 回炉续接失败:', e instanceof Error ? e.message : String(e))
            })
          }, 1500)
        }
      } catch (e) {
        console.error(`[南大路由] GWT 验收执行异常:`, e)
        this.injectNanjuAssistantMessage(
          sessionId,
          `⚠️ 验收测试执行异常：${e instanceof Error ? e.message : String(e)}。请检查 08_APP/index.html 与 06_TESTS/ 产物完整性，修复后重新声明推进 <!-- PHASE_ADVANCE: testing -->。`,
        )
      } finally {
        this.runningGwtProjects.delete(projectId)
      }
    })()
  }

  // ===== 南大 L2 委派超时兑底（v0.17.64 Sprint C1：实证② deepseek 渠道挂起无兑底） =====

  /**
   * L1 调用委派工具时登记超时观察哨（幂等；非委派工具/非活跃南大项目静默跳过）。
   * 只匹配项目关联会话：L2 会话内部的 inline AC 审计委派不是项目关联会话，不会被登记。
   */
  private registerNanjuDelegationWatch(workspaceSlug: string, sessionId: string, toolName: string): void {
    try {
      if (
        toolName !== 'delegate_agent' && toolName !== 'mcp__collaboration__delegate_agent'
        && toolName !== 'delegate_agents' && toolName !== 'mcp__collaboration__delegate_agents'
      ) return
      if (!workspaceSlug) return
      const { findNanjuProjectBySession } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
      const project = findNanjuProjectBySession(workspaceSlug, sessionId)
      if (!project || project.status !== 'active') return
      const watcher = this.ensureNanjuDelegationWatcher()
      watcher.register(workspaceSlug, sessionId, project.projectId)
      this.ensureNanjuDelegationWatchTimer()
    } catch (e) {
      console.warn('[南大护栏] 委派观察哨登记失败（不影响委派本身）:', e instanceof Error ? e.message : String(e))
    }
  }

  /** 惰性构建观察哨（依赖注入接线：委派查询/强停/熔断计数/注入/续接全部走真实通道） */
  private ensureNanjuDelegationWatcher() {
    if (this.nanjuDelegationWatcher) return this.nanjuDelegationWatcher
    const { NanjuDelegationWatcher } = require('./nanju-delegation-watch') as typeof import('./nanju-delegation-watch')
    this.nanjuDelegationWatcher = new NanjuDelegationWatcher({
      listRunningDelegations: (parentSessionId: string) => {
        const { listRunningDelegationsForParent } = require('./agent-collaboration-tools') as typeof import('./agent-collaboration-tools')
        return listRunningDelegationsForParent(parentSessionId)
      },
      forceStopDelegation: (parentSessionId: string, delegationId: string) => {
        const { forceStopDelegation } = require('./agent-collaboration-tools') as typeof import('./agent-collaboration-tools')
        return forceStopDelegation(parentSessionId, delegationId)
      },
      getActiveProjectStage: (workspaceSlug: string, projectId: string, parentSessionId: string) => {
        const { listNanjuProjects } = require('./nanju-project') as typeof import('./nanju-project')
        const project = listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)
        if (!project || project.status !== 'active' || project.sessionId !== parentSessionId) return null
        const stage = project.currentStage
        if (stage === 'requirements' || stage === 'prototype' || stage === 'architecture' || stage === 'planning' || stage === 'coding' || stage === 'testing') return stage
        return null // mode-select/delivered 不观察
      },
      recordGuardError: (workspaceSlug: string, projectId: string, stage, note: string) => {
        const { updatePhaseGuard, isPhaseGuardCircuitOpen } = require('./nanju-project') as typeof import('./nanju-project')
        const { previous, current } = updatePhaseGuard(workspaceSlug, projectId, stage, { kind: 'error', note })
        const justOpened = !isPhaseGuardCircuitOpen(previous ?? undefined).open && isPhaseGuardCircuitOpen(current).open
        if (justOpened) {
          try {
            const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
            recordTelemetry(workspaceSlug, 'circuit_break', {
              project_id: projectId,
              stage,
              source: 'delegation_hard_timeout',
              reason: note,
              fail_count: current.failCount,
              error_count: current.errorCount,
            }, projectId)
          } catch { /* 埋点失败不影响主流程 */ }
        }
        return { justOpened, failCount: current.failCount, errorCount: current.errorCount }
      },
      injectMessage: (sessionId: string, text: string) => this.injectNanjuAssistantMessage(sessionId, text),
      sendContinuation: (sessionId: string, message: string) => this.runNanjuGuardContinuation(sessionId, message),
      // 南大 R1（W1）：软超时告警点 → nanju:delegation-status timeout 相位（转发，不影响催办）
      onSoftTimeout: (info) => {
        const { emitDelegationStatus } = require('./nanju-delegation-status') as typeof import('./nanju-delegation-status')
        emitDelegationStatus({
          sessionId: info.parentSessionId,
          delegationId: info.delegationId,
          childSessionId: info.childSessionId,
          phase: 'timeout',
          label: info.title,
          startedAt: info.startedAt,
          elapsedMs: info.elapsedMs,
          reason: `子会话「${info.title}」软超时告警点转发（仍在处理，可催办）`,
        })
      },
      // 南大 R3（W1）：硬超时新触发熔断 → nanju:guard-alert（GuardAlertCard 数据源；只加 emit 不改状态机）
      onCircuitJustOpened: (info) => {
        const { emitGuardAlert, NANJU_GUARD_ALERT_MESSAGE } = require('./nanju-guard-alert') as typeof import('./nanju-guard-alert')
        emitGuardAlert({
          sessionId: info.parentSessionId,
          projectId: info.projectId,
          stage: info.stage,
          message: NANJU_GUARD_ALERT_MESSAGE,
        })
      },
    })
    return this.nanjuDelegationWatcher
  }

  private ensureNanjuDelegationWatchTimer(): void {
    if (this.nanjuDelegationWatchTimer) return
    this.nanjuDelegationWatchTimer = setInterval(() => {
      const watcher = this.ensureNanjuDelegationWatcher()
      watcher.poll()
      if (watcher.size === 0) this.stopNanjuDelegationWatchTimer()
    }, NANJU_GUARDS.delegationPollIntervalMs)
    console.log(
      `[南大护栏] L2 委派超时轮询已启动：间隔 ${NANJU_GUARDS.delegationPollIntervalMs / 1000}s，`
      + `软超时 ${NANJU_GUARDS.delegationSoftTimeoutMs / 60000}min，硬超时 ${NANJU_GUARDS.delegationHardTimeoutMs / 60000}min`,
    )
  }

  private stopNanjuDelegationWatchTimer(): void {
    if (!this.nanjuDelegationWatchTimer) return
    clearInterval(this.nanjuDelegationWatchTimer)
    this.nanjuDelegationWatchTimer = null
    console.log('[南大护栏] L2 委派超时轮询已停止（无观察对象）')
  }

  /**
   * 护栏续接（注入+续接模式，不直连 sendMessage）：L1 空闲时经注册的 headless 通道
   * 发送续接消息；L1 忙碌（如阻塞在 wait_for_delegations）时短暂重试，耗尽则放弃
   * （硬超时场景强停会解阻塞，L1 的 wait 很快返回并结束本轮）。
   */
  private runNanjuGuardContinuation(sessionId: string, message: string, retriesLeft = 6): void {
    try {
      if (this.isActive(sessionId)) {
        if (retriesLeft > 0) {
          setTimeout(() => this.runNanjuGuardContinuation(sessionId, message, retriesLeft - 1), 10_000)
        } else {
          console.warn(`[南大护栏] 续接放弃（会话持续忙碌）：sessionId=${sessionId}`)
        }
        return
      }
      const meta = getAgentSessionMeta(sessionId)
      if (!meta?.channelId) {
        console.warn(`[南大护栏] 续接跳过（会话元数据缺失 channelId）：sessionId=${sessionId}`)
        return
      }
      runRegisteredHeadlessAgent(
        {
          sessionId,
          userMessage: message,
          channelId: meta.channelId,
          modelId: meta.modelId,
          workspaceId: meta.workspaceId,
          permissionModeOverride: meta.permissionMode,
          startedAt: Date.now(),
        },
        {
          source: 'delegation',
          onError: (error: string) => console.warn('[南大护栏] 续接错误:', error),
          onComplete: () => {},
          onTitleUpdated: () => {},
        },
      ).catch((e: unknown) => {
        console.warn('[南大护栏] 续接失败:', e instanceof Error ? e.message : String(e))
      })
    } catch (e) {
      console.warn('[南大护栏] 续接异常:', e instanceof Error ? e.message : String(e))
    }
  }

  private prepareSessionNotFoundRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
  ): void {
    this.prepareResumeFallbackRecovery(
      sessionId,
      queryOptions,
      contextualMessage,
      agentCwd,
      workspaceSlug,
      accumulatedMessages,
      queryStartedAt,
      '检测到 session-not-found（可能为误检），保留 sdkSessionId 并切换到上下文回填模式',
    )
  }

  /**
   * Resume 失败恢复：本轮切到「非 resume + 历史回填恢复」模式，注入 session 自引用让 Agent
   * 优先通过 session-cleaner 读取干净历史继续工作。使用 <session_recovery> 标签指向当前会话，
   * 比 buildContextPrompt（仅注入 20 条摘要）提供完整得多的上下文连续性。
   *
   * 关于磁盘 meta 的 sdkSessionId（由 clearPersistedSession 控制，默认 false 即保留）：
   * - 默认保留：本轮恢复只改本地 queryOptions，不动磁盘；若本轮成功，SDK 新会话的 ID 会经
   *   onSessionId 回调自动覆盖 meta；若本轮失败到终止，下一轮仍可尝试 resume 旧 ID（#903）。
   *   这是「迷了就别删」的安全默认，适用于 session-not-found（可能为误检）等不确定场景。
   * - 仅 thinking-signature 跨模型不兼容时传 true：旧 ID 指向的 JSONL 焊死了旧模型思考块，
   *   当前模型 resume 必然再次失败，此时主动清除可避免下一轮无谓的失败往返。
   */
  private prepareResumeFallbackRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
    logMessage: string,
    clearPersistedSession = false,
  ): void {
    console.log(`[Agent 编排] ${logMessage}`)
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 仅在确定旧会话永久无效时（thinking-signature）才清除磁盘 meta；
    // 其余场景保留，新 SDK 会话产生的 sdkSessionId 会通过 onSessionId 回调自动覆盖。
    if (clearPersistedSession) {
      try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.resumeSessionAt = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息。
   */
  private persistSDKMessages(
    sessionId: string,
    accumulatedMessages: SDKMessage[],
    durationMs?: number,
  ): void {
    if (accumulatedMessages.length === 0) return

    const hasCompactBoundary = accumulatedMessages.some((m) => {
      return m.type === 'system' && (m as SDKSystemMessage).subtype === 'compact_boundary'
    })

    const toPersist = accumulatedMessages.filter(
      (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result'
        || (m.type === 'system' && isPersistableSDKSystemMessage(m as SDKSystemMessage))
    ).filter((m) => {
      if (isPartialSDKMessage(m)) return false
      if (m.type === 'system') {
        const sysMsg = m as SDKSystemMessage
        if (hasCompactBoundary && sysMsg.subtype === 'status' && sysMsg.compact_result === 'success') {
          return false
        }
      }
      // 过滤 SDK 内部生成的 user 文本消息（如 Skill 展开 prompt），与实时流过滤逻辑一致
      if (m.type === 'user') {
        const content = (m as { message?: { content?: Array<{ type: string }> } }).message?.content
        const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) return false
      }
      return true
    })

    if (toPersist.length === 0) return

    // 为没有 _createdAt 的消息补上时间戳（assistant 消息来自 SDK 原始输出，不含时间）
    const now = Date.now()
    const withTimestamps = toPersist.map((m) => {
      const msg = m as Record<string, unknown>
      if (typeof msg._createdAt === 'number') return m
      // 为 result 消息附加 _durationMs
      if (m.type === 'result' && durationMs != null) {
        return { ...m, _createdAt: now, _durationMs: durationMs } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    appendSDKMessages(sessionId, withTimestamps)
  }

  private persistUserMessage(
    sessionId: string,
    userMessage: string,
    createdAt = Date.now(),
    uuid?: string,
  ): string {
    const persistedUuid = uuid ?? randomUUID()
    const userSDKMsg: SDKMessage = {
      type: 'user',
      uuid: persistedUuid,
      message: {
        content: [{ type: 'text', text: userMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: createdAt,
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [userSDKMsg])
    return persistedUuid
  }

  private recordUserSkillActivations(
    sessionId: string,
    userMessageUuid: string,
    activations: SkillActivation[],
  ): void {
    try {
      if (updateSDKUserMessageSkillActivations(sessionId, userMessageUuid, activations)) return
    } catch (error) {
      console.warn(`[Agent 编排] 写入用户 Skill metadata 失败，将等待消息落盘后重试:`, error)
    }

    const byMessage = this.pendingUserSkillActivations.get(sessionId) ?? new Map<string, SkillActivation[]>()
    byMessage.set(
      userMessageUuid,
      mergeSkillActivations(byMessage.get(userMessageUuid) ?? [], activations),
    )
    this.pendingUserSkillActivations.set(sessionId, byMessage)
  }

  private flushPendingUserSkillActivations(sessionId: string, userMessageUuid: string): void {
    const byMessage = this.pendingUserSkillActivations.get(sessionId)
    const activations = byMessage?.get(userMessageUuid)
    if (!activations?.length) return
    try {
      if (!updateSDKUserMessageSkillActivations(sessionId, userMessageUuid, activations)) return
      byMessage?.delete(userMessageUuid)
      if (byMessage?.size === 0) this.pendingUserSkillActivations.delete(sessionId)
    } catch (error) {
      console.warn(`[Agent 编排] 补写用户 Skill metadata 失败:`, error)
    }
  }

  private clearPendingUserSkillActivations(sessionId: string, userMessageUuid?: string): void {
    if (!userMessageUuid) {
      this.pendingUserSkillActivations.delete(sessionId)
      return
    }
    const byMessage = this.pendingUserSkillActivations.get(sessionId)
    if (!byMessage) return
    byMessage.delete(userMessageUuid)
    if (byMessage.size === 0) this.pendingUserSkillActivations.delete(sessionId)
  }

  private persistEmptyResponseError(
    sessionId: string,
    resultSubtype: string | undefined,
    resultErrors: string[] | undefined,
  ): string {
    const detail = resultErrors?.find((error) => error.trim().length > 0)?.trim()
    const subtype = resultSubtype ?? 'unknown'
    const errorContent = detail
      ? `Agent 本轮结束了，但没有返回任何可展示内容。错误详情：${detail}`
      : resultSubtype === 'success'
        ? 'Agent 本轮结束了，但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。'
        : `Agent 本轮异常结束（${subtype}），但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。`
    const errorSDKMsg: SDKMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: errorContent }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      error: { message: errorContent, errorType: EMPTY_RESPONSE_RESULT_SUBTYPE },
      _createdAt: Date.now(),
      _errorCode: 'unknown_error',
      _errorTitle: '没有收到模型回复',
      _errorCanRetry: true,
      _errorActions: [
        { key: 'r', label: '重试', action: 'retry' },
        { key: 'm', label: '重新选择模型', action: 'select_model' },
      ],
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [errorSDKMsg])
    console.warn(`[Agent 编排] 本轮没有收到可展示内容: sessionId=${sessionId}, resultSubtype=${subtype}`)
    return errorContent
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(
    input: AgentSendInput,
    callbacks: SessionCallbacks,
    extensions: { piCustomTools?: ToolDefinition[] } = {},
  ): Promise<void> {
    const { sessionId, userMessage, rawUserMessage, userMessageUuid, channelId, modelId, workspaceId: requestedWorkspaceId, additionalDirectories, permissionModeOverride, mentionedSkills, mentionedMcpServers, mentionedSessionIds, mentionedTodoIds, mentionedCalendarEventIds, automationContext, retryOfErrorUuid } = input
    const streamStartedAt = input.startedAt ?? Date.now()
    let userMessagePersisted = false
    let initialUserMessageUuid: string | undefined
    let sessionMeta = getAgentSessionMeta(sessionId)

    const completeBeforeRun = (options: {
      stoppedByUser?: boolean
      startedAt?: number
    } = {}): void => {
      const stoppedByUser = this.stoppedBeforeRunSessions.delete(sessionId)
      callbacks.onComplete([], {
        ...options,
        startedAt: options.startedAt ?? streamStartedAt,
        stoppedByUser: options.stoppedByUser === true || stoppedByUser,
      })
    }

    const persistInitialUserMessage = (): void => {
      if (userMessagePersisted) return
      // rawUserMessage 保留展示/持久化用的原始文本（@file 编码原文，remarkMentions 解码显示）；
      // userMessage 是传给 Agent 的 SDK 文本（@file 路径已解码为真实路径）。
      initialUserMessageUuid = this.persistUserMessage(
        sessionId,
        rawUserMessage ?? userMessage,
        Date.now(),
        userMessageUuid,
      )
      userMessagePersisted = true
    }

    // 0. 并发保护
    const hasActiveRun = this.activeSessions.has(sessionId)
    const shouldPersistUserMessage = shouldPersistInitialUserMessage({ hasActiveRun, retryOfErrorUuid })
    if (hasActiveRun) {
      // 并发请求没有真正启动新的 Agent run，绝不能把它当作新用户输入写入 JSONL。
      // 尤其在用户点击停止后、底层 query 尚未完全退出的短暂窗口内，否则同一条
      // 后续消息会随每次点击重复落盘。
      console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求且不保存用户消息`)
      callbacks.onError(getActiveRunRejectionMessage())
      callbacks.onComplete([], { startedAt: streamStartedAt })
      return
    }

    // 手动重试直接删除原错误，避免它在下一轮完成后仍被历史回放。
    // 删除失败不阻断重试（例如旧版本遗留的无 UUID 错误）。
    if (retryOfErrorUuid) {
      try {
        removeSDKErrorMessage(sessionId, retryOfErrorUuid)
      } catch (error) {
        console.warn(`[Agent 编排] 删除重试前错误失败: ${retryOfErrorUuid}`, error)
      }
    }

    if (shouldPersistUserMessage) {
      try {
        persistInitialUserMessage()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Agent 编排] 持久化用户消息失败:', error)
        callbacks.onError(`消息保存失败：${message}`)
        completeBeforeRun()
        return
      }
    }

    // 0.5 清除上一轮中断标记
    try { updateAgentSessionMeta(sessionId, { stoppedByUser: false }) } catch { /* 会话可能已删除 */ }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
      const errorContent = typedError.title
        ? `${typedError.title}: ${typedError.message}`
        : typedError.message
      const errorSDKMsg: SDKMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: errorContent }],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        error: { message: typedError.message, errorType: typedError.code },
        _createdAt: Date.now(),
        _errorCode: typedError.code,
        _errorTitle: typedError.title,
        _errorDetails: typedError.details,
        _errorCanRetry: typedError.canRetry,
        _errorActions: typedError.actions,
      } as unknown as SDKMessage
      try { appendSDKMessages(sessionId, [errorSDKMsg]) } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      callbacks.onError(errorContent)
      completeBeforeRun()
    }

    // 会话元数据是运行项目的权威来源。渲染端的当前项目只是导航状态，不能
    // 覆盖已存在会话的项目归属，否则会把 Agent cwd 指到另一个用户项目根。
    const sessionWorkspaceId = sessionMeta?.workspaceId
    if (sessionWorkspaceId && requestedWorkspaceId && requestedWorkspaceId !== sessionWorkspaceId) {
      reportPreflightError({
        code: 'unknown_error',
        title: '会话项目不匹配',
        message: '当前会话所属项目与请求项目不一致，已拒绝执行以避免访问错误的项目目录。',
        actions: [],
        canRetry: false,
      })
      return
    }
    const workspaceId = sessionWorkspaceId ?? requestedWorkspaceId

    // 本地项目根由用户管理。根目录被删除、替换为文件或无法访问时，绝不能
    // 进入 SDK/Agent 初始化链路，以免后续文件工具通过 mkdir 间接重建该目录。
    if (workspaceId) {
      const workspace = getAgentWorkspace(workspaceId)
      if (!workspace) {
        reportPreflightError({
          code: 'workspace_not_found',
          title: '项目不存在',
          message: `指定的 Agent 项目不存在或已删除: ${workspaceId}`,
          actions: [],
          canRetry: false,
        })
        return
      }

      const projectRootStatus = getLocalProjectRootStatus(workspace.projectRootPath)
      if (projectRootStatus && projectRootStatus !== 'available') {
        reportPreflightError({
          code: 'local_project_root_unavailable',
          title: '本地项目根目录不可用',
          message: `本地项目根目录不存在或无法访问：${workspace.projectRootPath}。请在 Proma 中重新选择项目文件夹。`,
          details: [`目录状态: ${projectRootStatus}`],
          actions: [],
          canRetry: false,
        })
        return
      }
    }

    // Windows 缺少 Git Bash / WSL 时仍允许启动 Pi Agent。
    // Pi adapter 会移除 Bash 工具并注入基础模式说明；文件工具、对话和本地 Proma 工具不受影响。

    // 1. 获取渠道信息并解密 API Key
    const channel = getChannelById(channelId)
    if (!channel) {
      reportPreflightError({
        code: 'channel_not_found',
        title: '渠道不存在',
        message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    let apiKey: string
    let codexOAuthCredentials: CodexOAuthCredentials | undefined
    let xaiOAuthCredentials: XaiOAuthCredentials | undefined
    try {
      // 订阅 OAuth 渠道必须保留完整凭据给 Pi runtime，才能在执行中按真实 expires
      // 自动刷新；其余渠道只需解密 API Key。
      if (channel.provider === 'openai-codex') {
        codexOAuthCredentials = await resolveCodexOAuthCredentials(channelId)
        apiKey = codexOAuthCredentials.access
      } else if (channel.provider === 'xai') {
        xaiOAuthCredentials = await resolveXaiOAuthCredentials(channelId)
        apiKey = xaiOAuthCredentials.access
      } else {
        // 统一走发送链入口：解密失败/Key 为空/密文形态均会抛 ApiKeyDecryptError，
        // 绝不把密文当 API Key 发给服务端（W6 根因修复）。
        apiKey = await resolveChannelRuntimeApiKey(channelId)
      }
    } catch (err) {
      if (err instanceof ApiKeyDecryptError && (channel.provider === 'openai-codex' || channel.provider === 'xai')) {
        // 订阅渠道存储的凭据密文无法解密：与 OAuth 过期是两类问题，分开提示。
        reportPreflightError({
          code: 'api_key_decrypt_failed',
          title: 'API Key 解密失败',
          message: `无法解密此渠道存储的登录凭据（${err.message}）。请到设置中重新登录。`,
          actions: [
            { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
          ],
          canRetry: false,
        })
        return
      }
      if (channel.provider === 'openai-codex' || channel.provider === 'xai') {
        const isXai = channel.provider === 'xai'
        reportPreflightError({
          code: 'expired_oauth_token',
          title: isXai ? 'xAI 登录已失效' : 'ChatGPT 登录已失效',
          message: isXai
            ? '无法刷新 xAI 登录凭据，登录可能已过期或被撤销。请在设置中重新登录 xAI。'
            : '无法刷新 ChatGPT 登录凭据，登录可能已过期或被撤销。请在设置中重新登录 ChatGPT。',
          actions: [
            { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
          ],
          canRetry: false,
        })
        return
      }
      reportPreflightError({
        code: 'api_key_decrypt_failed',
        title: 'API Key 解密失败',
        message: err instanceof ApiKeyDecryptError
          ? `${err.message}。请到设置中重新填写。`
          : '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    const appSettings = getSettings()

    if (sessionMeta?.legacyTranscript?.continuationRequired) {
      reportPreflightError({
        code: 'agent_runtime_not_found',
        title: '历史会话需要迁移',
        message: '这是已退役 Claude runtime 的只读历史会话。请新建 Pi Agent 会话，并通过会话引用带入此历史。',
        actions: [],
        canRetry: false,
      })
      return
    }

    // 2.1 立即抢占会话槽位（在所有同步检查通过后、第一个 await 之前）
    // 防止 buildSdkEnv 等 await 期间并发调用绕过上方的检查，导致多条重复消息写入 JSONL
    // finally 块会通过 generation 匹配来安全清理，不影响正常流程
    if (this.stoppedBeforeRunSessions.has(sessionId)) {
      completeBeforeRun({ stoppedByUser: true })
      return
    }
    const runGeneration = ++this.nextRunGeneration
    this.activeSessions.set(sessionId, runGeneration)

    const releaseActiveRun = (): void => {
      // 在发送 STREAM_COMPLETE 前释放 active slot，避免渲染进程已进入空闲态、
      // 主进程仍在 finally 前短暂拒绝下一条消息。
      const ownsActiveRun = this.activeSessions.get(sessionId) === runGeneration
      if (ownsActiveRun) {
        this.activeSessions.delete(sessionId)
        this.sessionPermissionModes.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
      }
    }
    const completeRun = (
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onComplete(messages, opts)
    }
    const failRun = (
      error: string,
      messages?: AgentMessage[],
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onError(error)
      callbacks.onComplete(messages, opts)
    }

    // E6 修复（v0.16.87）：锁已占用但主 try/finally 尚未生效。此窗口内任何异常
    // （onRunStarted 回调抛错、代理配置读取失败、runtime 环境构建抛错）会带着
    // activeSessions 锁直接逃出 sendMessage——外层调用方只上报错误不释放锁，
    // 导致该会话后续所有消息被「正在处理中」永久拒绝（会话挂死）。此处兑底
    // failRun 释放锁并终止本轮。
    let proxyUrl: string | undefined
    let runtimeEnv: AgentRuntimeEnv
    try {
      callbacks.onRunStarted?.({ startedAt: streamStartedAt })

      // 3. 构建 Pi runtime 环境（代理与 Windows shell 配置）。
      proxyUrl = await getEffectiveProxyUrl()
      runtimeEnv = buildAgentRuntimeEnv({
        proxyUrl,
        runtimeStatus: getRuntimeStatus(),
        windowsShellPreference: appSettings.windowsShellPreference,
      })
    } catch (error) {
      const message = friendlyErrorMessage(errorMessageOf(error) || 'Agent 启动环境构建失败')
      console.error('[Agent 编排] 启动环境构建失败，已释放会话运行锁:', error)
      failRun(message)
      return
    }

    // 4. 读取已有的 SDK session ID（用于 resume）
    let existingSdkSessionId = sessionMeta?.sdkSessionId

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, proma sessionId=${sessionId}`)

    // 5. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    let pendingSkillActivations: SkillActivation[] = []
    const recordSkillActivation = (
      activations: SkillActivation[],
      userMessageUuid: string,
    ): void => {
      pendingSkillActivations = mergeSkillActivations(pendingSkillActivations, activations)
      this.recordUserSkillActivations(sessionId, userMessageUuid, activations)
    }
    // 委派子会话必须继承当前实际运行的模型；未显式传入时与 runtime 的默认值保持一致。
    const selectedModelId = modelId || DEFAULT_MODEL_ID
    let resolvedModel = selectedModelId
    let titleGenerationStarted = false
    /** 捕获到的 SDK session ID（用于 resume / recovery） */
    let capturedSdkSessionId = existingSdkSessionId
    let agentCwd: string | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@proma/shared').AgentWorkspace | undefined

    try {
      console.log(`[Agent 编排] 启动 Pi runtime — 模型: ${modelId || DEFAULT_MODEL_ID}, resume: ${existingSdkSessionId ?? '无'}`)

      // 确定 Agent 工作目录
      agentCwd = homedir()
      workspaceSlug = undefined
      workspace = undefined
      if (workspaceId) {
        const ws = getAgentWorkspace(workspaceId)
        if (!ws) {
          throw new Error(`指定的 Agent 项目不存在或已删除: ${workspaceId}`)
        }
        let activeWorktree = sessionMeta?.activeWorktree
        if (activeWorktree) {
          const activeWorktreePath = getActiveWorktreePath(sessionMeta)
          const currentMainRepoRoot = activeWorktreePath ? await getMainRepoRoot(activeWorktreePath) : null
          if (!activeWorktreePath || !currentMainRepoRoot || normalizePathForCompare(currentMainRepoRoot) !== normalizePathForCompare(activeWorktree.mainRepoRoot)) {
            console.warn(`[Agent 编排] 活动 worktree 已失效，回退默认 cwd: ${activeWorktree.path}`)
            sessionMeta = updateAgentSessionMeta(sessionId, { activeWorktree: undefined })
            activeWorktree = undefined
          }
        }
        agentCwd = resolveAgentCwd(ws, sessionId, sessionMeta?.agentCwdMode, activeWorktree) ?? homedir()
        workspaceSlug = ws.slug
        workspace = ws
        runtimeEnv.env.PROMA_WORKSPACE_DIR = getAgentWorkspacePath(ws.slug)
        runtimeEnv.env.PROMA_WORKSPACE_SLUG = ws.slug
        const cwdKind = activeWorktree ? `worktree ${activeWorktree.branch}` : getAgentCwdMode(sessionMeta)
        console.log(`[Agent 编排] 使用 ${cwdKind} cwd: ${agentCwd} (${ws.name}/${sessionId})`)


        if (existingSdkSessionId) {
          console.log(`[Agent 编排] 将尝试 resume: ${existingSdkSessionId}`)
        } else {
          console.log(`[Agent 编排] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
        }
      }

      // 9.4.1 Fork session JSONL 迁移已在 forkAgentSession 中完成；fork 的 cwd 语义
      // 从源会话继承并持久化，避免历史相对路径在恢复时切换到另一文件根。

      // 必须与 runtime 接收的附加目录保持一致；视觉助手据此限制允许外发的图片路径。
      const allAdditionalDirectories = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const browserAllowedRoots = [...new Set([
        workspaceId ? agentCwd : undefined,
        workspaceSlug ? getProjectFilesPath(workspaceSlug) : undefined,
        ...allAdditionalDirectories,
      ].filter((root): root is string => typeof root === 'string' && root.length > 0))]
      // 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
      // （如 ~/.proma/agent-workspaces/workspace-xxx/sessionId）与 SDK 内部存储的路径哈希可能不匹配，
      // 导致 listSessions 始终返回 0 个会话，误杀有效的 resume。
      // SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume: ${existingSdkSessionId}`)
      }

      // 10. 构建 MCP 服务器配置 + 记忆工具 + 生图工具 + 自定义工具
      const mcpServers = this.buildMcpServers(workspaceSlug)
      let piBuiltinTools: unknown[] = []
      let piMcpTools: unknown[] = []
      const piSdk = await import('@earendil-works/pi-coding-agent')
      const builtinMcpResult = await buildPiBuiltinTools(piSdk, {
        sessionId,
        channelId,
        modelId: selectedModelId,
        workspaceId,
        workspaceSlug,
        agentCwd,
        allowedRoots: browserAllowedRoots,
        permissionMode: permissionModeOverride ?? sessionMeta?.permissionMode ?? PROMA_DEFAULT_PERMISSION_MODE,
        triggeredBy: input.triggeredBy,
        windowsShellAvailable: process.platform !== 'win32' || runtimeEnv.shellKind != null,
      })
      piBuiltinTools = builtinMcpResult.tools
      const collaborationAvailable = builtinMcpResult.collaborationAvailable

      // 合并外部注入的自定义 MCP 服务器（如飞书群聊工具）

      // Proma 主进程连接用户 MCP server，并转换为 Pi custom tools。
      if (Object.keys(mcpServers).length > 0) {
        try {
          piMcpTools = await buildPiMcpTools(mcpServers)
        } catch (error) {
          console.warn('[Agent 编排] Pi MCP 工具桥接失败，已跳过用户 MCP:', error)
        }
      }

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd,
        userBrowserContext: browserController.getUserContext(sessionId),
      })
      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅影响 prompt，不影响持久化
      let enrichedMessage = userMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      if (mentionedSkills?.length || mentionedMcpServers?.length) {
        const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
        for (const slug of mentionedSkills ?? []) {
          const qualifiedName = workspaceSlug
            ? `proma-workspace-${workspaceSlug}:${slug}`
            : slug
          toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
        }
        for (const name of mentionedMcpServers ?? []) {
          toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
        }
        enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${mentionedSkills?.length ?? 0} skills, ${mentionedMcpServers?.length ?? 0} MCP`)
      }
      const referencedPlanningBlock = buildReferencedPlanningPrompt(
        mentionedTodoIds,
        mentionedCalendarEventIds,
        { requireToolRead: true },
      )
      if (referencedPlanningBlock) {
        enrichedMessage = `${referencedPlanningBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_planning: ${mentionedTodoIds?.length ?? 0} todos, ${mentionedCalendarEventIds?.length ?? 0} calendar events`)
      }

      const contextualMessage = [dynamicCtx, enrichedMessage].filter(Boolean).join('\n\n')

      const isCompactCommand = userMessage.trim() === '/compact'
      const finalPrompt = isCompactCommand
        ? '/compact'
        : existingSdkSessionId
          ? contextualMessage
          : buildContextPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })

      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
      } else if (finalPrompt !== contextualMessage) {
        console.log(`[Agent 编排] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
      }

      // 12. 读取应用设置并确定权限模式
      // 权限模式只属于当前 session；新会话默认完全自动模式。
      const initialPermissionMode: PromaPermissionMode = permissionModeOverride
        ?? PROMA_DEFAULT_PERMISSION_MODE
      // 注册到 Map，支持运行中动态切换
      this.sessionPermissionModes.set(sessionId, initialPermissionMode)
      console.log(`[Agent 编排] 权限模式: ${initialPermissionMode}${permissionModeOverride ? '（外部覆盖）' : ''}`)

      const emitPlanModeChanged = (active: boolean, source: 'initial' | 'tool' | 'permission'): void => {
        this.eventBus.emit(sessionId, {
          kind: 'proma_event',
          event: { type: 'plan_mode_changed', sessionId, active, source },
        })
      }

      // 当初始模式为 plan 时，通知渲染进程展示计划模式 UI（如「Agent 正在规划」横幅）
      if (initialPermissionMode === 'plan') {
        this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'enter_plan_mode', sessionId } })
        emitPlanModeChanged(true, 'initial')
      }

      /** 读取当前会话的实时权限模式（支持运行中切换） */
      const getPermissionMode = (): PromaPermissionMode =>
        this.sessionPermissionModes.get(sessionId) ?? initialPermissionMode

      // ExitPlanMode 拦截器：plan 模式下走 UI 审批流程
      const handleExitPlanMode = (toolInput: Record<string, unknown>, signal: AbortSignal): Promise<ExitPlanPermissionResult> => {
        return exitPlanService.handleExitPlanMode(
          sessionId,
          toolInput,
          signal,
          (request: ExitPlanModeRequest) => {
            this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'exit_plan_mode_request', request } })
          },
        )
      }

      /**
       * 判断 Bash 命令是否是只读的（计划模式下安全可执行）
       * 检测写操作特征：文件重定向、破坏性命令、包管理写操作、git 写操作等
       */
      const isBashCommandReadOnly = (command: string): boolean => {
        // 输出重定向：匹配未被数字或 & 前置的 > 符号（排除 2>/dev/null、&> 等 fd 重定向）
        if (/(?<![0-9&])>/.test(command)) return false
        // 破坏性文件操作
        if (/\b(rm|rmdir)\s/.test(command)) return false
        if (/\bsed\s+[^|&;]*-i/.test(command)) return false  // sed -i 原地编辑
        if (/\b(chmod|chown|chattr|truncate)\s/.test(command)) return false
        if (/\b(mv|cp)\s/.test(command)) return false
        if (/\b(mkdir|touch|mktemp)\s/.test(command)) return false
        // 包管理器写操作
        if (/\b(npm|pnpm|yarn|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|link|unlink)\b/.test(command)) return false
        if (/\bpip[23]?\s+(install|uninstall|upgrade)\b/.test(command)) return false
        if (/\b(apt|apt-get|brew|yum|dnf)\s+(install|remove|purge|uninstall|upgrade)\b/.test(command)) return false
        // Git 写操作
        if (/\bgit\s+(commit|push|checkout\s+-[bB]|branch\s+-[mMdD]|merge\b|rebase\b|reset\b|stash\s+(drop|pop)\b|add\b|apply\b|cherry-pick\b)/.test(command)) return false
        // 进程控制
        if (/\b(kill|killall|pkill)\s/.test(command)) return false
        // 脚本执行（具有潜在副作用，如 node script.js / python main.py）
        if (/\b(node|python[23]?|ruby|perl|php)\s+[^-]/.test(command)) return false
        return true
      }

      // Plan 模式下允许的只读工具（不包含 Write/Edit/Bash 等写操作）
      const PLAN_MODE_ALLOWED_TOOLS = new Set([
        'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'TodoRead', 'TaskOutput',
        'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
        'ListMcpResourcesTool', 'ReadMcpResourceTool',
      ])
      const DEFERRED_OR_PROACTIVE_TOOLS = new Set([
        'REPL', 'Workflow', 'ScheduleWakeup', 'Monitor', 'PushNotification',
        'CronCreate', 'CronDelete', 'RemoteTrigger',
      ])
      const PLAN_MODE_READ_ONLY_CHROME_DEVTOOLS = new Set([
        'mcp__chrome_devtools__list_pages',
        'mcp__chrome_devtools__take_snapshot',
        'mcp__chrome_devtools__take_screenshot',
        'mcp__chrome_devtools__list_network_requests',
        'mcp__chrome_devtools__performance_stop_trace',
      ])
      // Planning 是本地用户数据：计划模式只允许查询，严禁创建、更新、删除或确认/推迟提醒。
      const PLAN_MODE_READ_ONLY_PLANNING_TOOLS = new Set([
        'mcp__planning__list_todos', 'mcp__planning__get_todo',
        'mcp__planning__list_calendar_events', 'mcp__planning__get_calendar_event',
        'mcp__planning__list_groups', 'mcp__planning__list_tags',
        'mcp__planning__list_active_reminders',
      ])
      // Pi-native 浏览器工具不是 MCP：必须显式分类，避免被通用 mcp__ 调研放行规则遗漏。
      const PLAN_MODE_READ_ONLY_BROWSER_TOOLS = new Set(['BrowserObserve', 'BrowserScreenshot', 'BrowserListTabs', 'BrowserPreviewOpen'])
      const runTriggeredBy = input.triggeredBy

      /** Plan 模式是否已被 Agent 进入（初始 plan 模式时天然为 true，其他模式需 EnterPlanMode 触发） */
      let planModeEntered = initialPermissionMode === 'plan'

      const syncPlanModeFromToolUse = (toolName: string): void => {
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          return
        }
        if (toolName === 'ExitPlanMode' && getPermissionMode() === 'bypassPermissions') {
          planModeEntered = false
          emitPlanModeChanged(false, 'tool')
          return
        }
        // auto/plan 下 ExitPlanMode 只是发起退出计划的审批请求。
        // 真正退出由用户审批结果触发，不能在工具开始时提前清掉计划态。
      }

      // 动态 canUseTool：每次调用读取当前权限模式，支持运行中切换
      const canUseTool = async (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
        const currentMode = getPermissionMode()

        // ── 参数校验守卫（所有模式、所有工具，优先于权限检查） ──
        const validationFailure = validateToolInput(toolName, input)
        if (validationFailure) {
          console.warn(`[Agent 工具验证] 参数缺失: tool=${toolName}, mode=${currentMode}`)
          return validationFailure
        }

        // ── 南大向导路由硬门禁（优先于权限模式，automation 会话跳过） ──
        if (!automationContext && !input.triggeredBy) {
          const nanjuGate = checkNanjuRouterGate(workspaceSlug, sessionId, toolName, input)
          if (nanjuGate) {
            console.log(`[南大路由门禁] 拒绝工具 ${toolName}`)
            return nanjuGate
          }
          // L2 委派超时兑底（v0.17.64）：L1 发起委派时登记观察哨（软/硬超时见 NANJU_GUARDS）。
          // 只匹配项目关联会话：L2 会话内部的 inline AC 审计委派不会被登记。
          this.registerNanjuDelegationWatch(workspaceSlug ?? '', sessionId, toolName)
        }

        // ── Write 大文件 token 截断防护 ──
        if (toolName === 'Write' && typeof input.content === 'string') {
          const estimatedTokens = estimateTokenCount(input.content)
          if (estimatedTokens > WRITE_CONTENT_TOKEN_THRESHOLD) {
            console.warn(
              `[Agent 工具验证] Write 内容过大: tokens≈${estimatedTokens}, chars=${input.content.length}, file=${String(input.file_path)}`,
            )
            return {
              behavior: 'deny' as const,
              message:
                `The content for Write tool (~${estimatedTokens} estimated tokens, ${input.content.length} chars) is too large and may be truncated. ` +
                `Please split the write into smaller sequential steps: write the first portion of the file now, then use Edit tool to append remaining sections incrementally.`,
            }
          }
        }

        // ── EnterPlanMode / ExitPlanMode 处理 ──

        // 完全自动模式：计划进入和退出都透明化，保持 bypassPermissions 的无人值守语义。
        if (currentMode === 'bypassPermissions' && (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode')) {
          const active = toolName === 'EnterPlanMode'
          planModeEntered = active
          emitPlanModeChanged(active, 'tool')
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // ExitPlanMode：plan 模式下必须让用户确认计划。
        if (toolName === 'ExitPlanMode') {
          console.log(`[canUseTool] ExitPlanMode: signal.aborted=${options.signal.aborted}, planModeEntered=${planModeEntered}, mode=${currentMode}`)
          const result = await handleExitPlanMode(input, options.signal)
          if (result.behavior === 'allow' && 'targetMode' in result && result.targetMode) {
            // 更新 Map，后续 canUseTool 调用使用新模式
            this.sessionPermissionModes.set(sessionId, result.targetMode)
            planModeEntered = false
            emitPlanModeChanged(false, 'permission')
            // 同步通知 SDK 侧切换权限模式
            if (this.adapter.setPermissionMode) {
              this.adapter.setPermissionMode(sessionId, result.targetMode).catch((err: unknown) => {
                console.warn(`[Agent 编排] SDK 权限模式切换失败:`, err)
              })
            }
          }
          return result
        }

        // EnterPlanMode：标记进入状态，通知渲染进程
        if (toolName === 'EnterPlanMode') {
          planModeEntered = true
          emitPlanModeChanged(true, 'tool')
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'enter_plan_mode', sessionId } })
          return { behavior: 'allow' as const, updatedInput: input }
        }

        // AskUserQuestion：始终走交互式问答流程，不受权限模式影响
        if (toolName === 'AskUserQuestion') {
          return askUserService.handleAskUserQuestion(
            sessionId, input, options.signal,
            (request: AskUserRequest) => {
              this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'ask_user_request', request } })
            },
          )
        }

        // 视觉助手由用户在全局设置中显式启用并选择外发渠道；在正常会话中直接放行，
        // 仍由工具服务限制为当前会话/附加目录内的图片。计划模式不执行任何外发操作。
        if (toolName === 'VisionRelay') {
          if (currentMode === 'plan') {
            return { behavior: 'deny' as const, message: '计划模式下不能将本地图片发送给视觉模型，请在计划获批后执行。' }
          }
          return { behavior: 'allow' as const }
        }

        // 所有 Pi 会话均可使用受管浏览器。主进程仍隔离网页来源并默认拒绝网页权限；下载和弹窗留在受管浏览器内，
        // 页面内容始终视为不可信输入。计划模式仅允许只读浏览器操作。
        if (toolName.startsWith('Browser')) {
          if (currentMode === 'plan') {
            return PLAN_MODE_READ_ONLY_BROWSER_TOOLS.has(toolName)
              ? { behavior: 'allow' as const, updatedInput: input }
              : { behavior: 'deny' as const, message: '计划模式下只能观察受管浏览器，请在计划获批后再进行网页交互。' }
          }
          return { behavior: 'allow' as const, updatedInput: input }
        }

        const planningDeletionPermission = resolvePlanningDeletionPermission(
          toolName,
          currentMode,
          runTriggeredBy,
        )
        if (planningDeletionPermission === 'deny-unattended') {
          return { behavior: 'deny' as const, message: '定时任务和协作子 Agent 不能删除本地规划数据，请由用户主会话发起并确认。' }
        }
        if (planningDeletionPermission === 'allow') {
          return { behavior: 'allow' as const, updatedInput: input }
        }
        if (planningDeletionPermission === 'require-single-approval') {
          return permissionService.requestSingleApproval(sessionId, toolName, input, options, (request) => {
            this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'permission_request', request } })
          })
        }

        // ── 普通工具的权限分派 ──

        switch (currentMode) {
          case 'bypassPermissions':
            return { behavior: 'allow' as const, updatedInput: input }

          case 'plan': {
            // Plan 模式：只允许只读工具 + Write/Edit 任意 .md 文件（计划文档）
            if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            // 允许 Write/Edit 到任意 .md 文件（计划文档一定是 markdown；非 .md 仍被拒）
            if (toolName === 'Write' || toolName === 'Edit') {
              const filePath = typeof input.file_path === 'string' ? input.file_path : ''
              if (filePath.toLowerCase().endsWith('.md')) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
            }
            // Bash 工具：只读命令（find、grep、cat 等）允许执行，写操作拒绝
            if (toolName === 'Bash') {
              const command = typeof input.command === 'string' ? input.command : ''
              if (isBashCommandReadOnly(command)) {
                return { behavior: 'allow' as const, updatedInput: input }
              }
              return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
            }
            // Chrome DevTools MCP 同时包含只读观察和会改变页面状态的操作。
            // 计划模式只允许快照、截图、网络列表等调研工具；点击、输入、脚本执行等需等计划通过。
            if (toolName.startsWith('mcp__chrome_devtools__')) {
              return PLAN_MODE_READ_ONLY_CHROME_DEVTOOLS.has(toolName)
                ? { behavior: 'allow' as const, updatedInput: input }
                : { behavior: 'deny' as const, message: '计划模式下不允许执行会改变浏览器页面状态的 Chrome DevTools 操作，请在计划审批通过后再执行' }
            }
            if (toolName.startsWith('mcp__planning__')) {
              return PLAN_MODE_READ_ONLY_PLANNING_TOOLS.has(toolName)
                ? { behavior: 'allow' as const, updatedInput: input }
                : { behavior: 'deny' as const, message: '计划模式下只能查询任务/日程，不能修改本地规划数据，请在计划审批通过后再执行' }
            }
            // 其他 MCP 工具维持既有策略：计划模式下允许调研用 MCP。
            if (toolName.startsWith('mcp__')) {
              return { behavior: 'allow' as const, updatedInput: input }
            }
            if (DEFERRED_OR_PROACTIVE_TOOLS.has(toolName)) {
              return { behavior: 'deny' as const, message: '计划模式下不允许启动后台、定时、通知或脚本执行能力，请在计划审批通过后再执行' }
            }
            // 其余工具拒绝
            return { behavior: 'deny' as const, message: '计划模式下不允许执行写操作，请在计划审批通过后再执行' }
          }
          default:
            return { behavior: 'allow' as const, updatedInput: input }
        }
      }

      // 13. 构建 Adapter 查询选项
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0
        ? appSettings.agentMaxTurns
        : undefined
      const piReasoningCapability = await resolvePiReasoningCapability(channel.provider, selectedModelId)
      const piThinkingLevel = resolvePiThinkingLevel(appSettings, sessionMeta, channel.provider, selectedModelId, piReasoningCapability)
      const projectInstructions = workspaceSlug
        ? (() => {
            try {
              const manifest = resolveProjectInstructions({ projectRoot: getProjectFilesPath(workspaceSlug) })
              for (const diagnostic of manifest.diagnostics) {
                console.warn(`[项目指令] ${diagnostic.path}: ${diagnostic.message}`)
              }
              return manifest
            } catch (error) {
              console.warn('[项目指令] 解析失败，已跳过本轮项目指令注入:', error)
              return undefined
            }
          })()
        : undefined
      const managedWorkspaceInstructionFile = workspaceSlug
        ? (() => {
            try {
              const file = readWorkspaceAgentsMd(workspaceSlug)
              return file.isText && file.content
                ? { path: getWorkspaceAgentsMdPath(workspaceSlug), content: file.content }
                : undefined
            } catch (error) {
              console.warn('[工作区指令] 读取 AGENTS.md 失败，已跳过本轮注入:', error)
              return undefined
            }
          })()
        : undefined
      const instructionFiles = combinePromaInstructionFiles(
        managedWorkspaceInstructionFile,
        projectInstructions?.sources.map(({ path, content }) => ({ path, content })) ?? [],
      )
      // 每次前台对话都基于受管 memory/ 的真实缺口给出渐进引导；自动化、桥接与委派绝不主动追问。
      const projectKnowledgeMaintenanceApproved = workspaceSlug
        ? isWorkspaceProjectKnowledgeMaintenanceApproved(workspaceSlug)
        : false
      const memoryGuidance = workspaceSlug && !automationContext && !input.triggeredBy
        ? getWorkspaceMemoryGuidance(workspaceSlug)
        : undefined
      // Historical sessions are supplementary evidence only. Do not invite a scan
      // before a collaboration profile has been established through real dialogue.
      const memoryRefreshOpportunity = workspaceSlug && !automationContext && !input.triggeredBy && !memoryGuidance?.needsCollaborationProfile
        ? claimWorkspaceMemoryRefreshOpportunity(workspaceSlug)
        : undefined
      const systemPromptAppend = buildSystemPrompt({
        workspaceName: workspace?.name,
        workspaceSlug,
        sessionId,
        agentCwd,
        sessionWorkbenchLayout: getSessionWorkbenchLayout(sessionMeta),
        permissionMode: initialPermissionMode,
        collaborationAvailable,
        currentModelId: selectedModelId,
        legacyProjectInstructions: projectInstructions?.sources,
        projectKnowledgeMaintenanceApproved,
        memoryGuidance,
        memoryRefreshOpportunity,
      }) + (automationContext ? `\n\n## 定时任务执行上下文\n\n${automationContext}` : '')

      // 南大向导阶段门禁：注入当前阶段的硬性指令
      const nanjuRouterPrompt = workspaceSlug && !automationContext && !input.triggeredBy
        ? getNanjuRouterPrompt(workspaceSlug, sessionId)
        : undefined
      const nanjuPrompt = nanjuRouterPrompt ?? ''
      // W2 S1 确认点 C（run 开始侧）：产出达标且尚未同步 → 点亮「等待用户确认」。
      // 幂等（详见 nanju-phase-gate.syncNanjuGuideConfirmState）；result 侧兜底同函数，
      // 两处覆盖冷启动首轮空窗与每轮产出落盘后的即时点亮。失败不影响运行。
      if (nanjuRouterPrompt && workspaceSlug) {
        try {
          const { syncNanjuGuideConfirmState } = require('./nanju-phase-gate') as typeof import('./nanju-phase-gate')
          syncNanjuGuideConfirmState(workspaceSlug, sessionId)
        } catch { /* 向导图子状态同步失败不影响运行 */ }
      }
      const startAutoTitleGeneration = (): void => {
        if (titleGenerationStarted) return
        titleGenerationStarted = true

        // 标题请求与前台 Agent run 使用独立的 Codex Responses 请求，可并发执行。
        // 自动标题只会写入仍为默认名称的会话，因此不会覆盖用户的手动重命名。
        this.autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, callbacks)
          .catch((err) => console.error('[Agent 编排] 标题生成未捕获异常:', err))
      }
      const handleSessionId = (sdkSessionId: string, piSessionFile?: string): void => {
        // 仅在 session_id 真正变化时才持久化。Pi 在同一 artifact 的每条消息都可能回调，
        // capturedSdkSessionId 已初始化为 existingSdkSessionId，并在 recovery 时同步重置。
        const isNewSessionId = sdkSessionId !== capturedSdkSessionId
        const latestSessionMeta = getAgentSessionMeta(sessionId)
        // recovery 新建 artifact 后，旧 entry bindings 属于另一棵 Pi tree，必须原子替换而非合并。
        const artifactReplaced = !!piSessionFile && latestSessionMeta?.piSessionFile !== piSessionFile
        capturedSdkSessionId = sdkSessionId
        if (isNewSessionId || artifactReplaced) {
          try {
            // 用户可在本轮运行中改选下一轮内核；不能让旧 runtime 回填不兼容的 session artifact。
            if (latestSessionMeta?.legacyTranscript?.continuationRequired) {
              console.log(`[Agent 编排] 忽略只读历史会话的 session artifact: ${sdkSessionId}`)
            } else {
              updateAgentSessionMeta(sessionId, {
                sdkSessionId,
                ...(piSessionFile ? { piSessionFile } : {}),
                ...(artifactReplaced ? { piEntryBindings: {} } : {}),
              })
              console.log(`[Agent 编排] 已保存 Pi session_id: ${sdkSessionId}`)
            }
          } catch (err) {
            console.error(`[Agent 编排] 保存 Pi session_id 失败:`, err)
          }
        }

        startAutoTitleGeneration()
      }
      const handleModelResolved = (model: string): void => {
        // `[1m]` 是 SDK 内部上下文变体，不应泄漏到标题生成或用户可见的模型名。
        resolvedModel = model.replace(/\[1m\]$/i, '')
        console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
        this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'model_resolved', model: resolvedModel } })
      }
      const handleContextWindow = (cw: number): void => {
        const inferredWindow = inferContextWindow(modelId)
        const contextWindow = Math.max(cw, inferredWindow ?? 0) || cw
        console.log(`[Agent 编排] 缓存 contextWindow: ${contextWindow}`)
        // result 消息里的真实 contextWindow 透传到 renderer，
        // 覆盖流式过程中按模型名推断的 fallback 值（智谱等端点会把 [1m] 等后缀剥掉，导致 fallback 不准）
        this.eventBus.emit(sessionId, {
          kind: 'proma_event',
          event: { type: 'context_window', contextWindow },
        })
      }
      const piCustomTools = [...piBuiltinTools, ...piMcpTools, ...(extensions.piCustomTools ?? [])]
      const queryOptions: PiAgentQueryOptions = {
        sessionId,
        prompt: finalPrompt,
        // 旧持久化模型 ID 可能带 `[1m]` 上下文后缀；Pi runtime 不支持该变体：
        // 智谱等端点不识别 glm-5.2[1m] 这类后缀，会返回 1211「模型不存在」。
        // 因此 pi 分支直接使用用户配置的原始模型 ID，不追加任何 `[1m]`。
        model: selectedModelId,
        cwd: agentCwd,
        apiKey,
        baseUrl: channel.baseUrl,
        provider: channel.provider,
        channelId,
        channelName: channel.name,
        proxyUrl,
        runtimeEnv,
        ...(maxTurns != null && { maxTurns }),
        permissionMode: initialPermissionMode,
        canUseTool,
        systemPrompt: systemPromptAppend + buildPiAdditionalDirectoriesPrompt(allAdditionalDirectories) + nanjuPrompt,
        ...(instructionFiles.length > 0 && { projectInstructionFiles: instructionFiles }),
        ...(projectInstructions && {
          projectInstructionScope: {
            projectRoot: projectInstructions.projectRoot,
            initialSources: projectInstructions.sources,
          },
        }),
        resumeSessionId: existingSdkSessionId,
        initialUserMessageUuid,
        piAgentDir: getSdkConfigDir(),
        piSessionDir: join(getSdkConfigDir(), 'sessions'),
        ...(allAdditionalDirectories.length > 0 && { additionalDirectories: allAdditionalDirectories }),
        ...(workspaceSlug ? {
          additionalSkillPaths: [getWorkspaceSkillsDir(workspaceSlug)],
          skillWorkspaceSlug: workspaceSlug,
        } : {}),
        ...(mentionedSkills?.length ? { skillMentions: mentionedSkills } : {}),
        onSkillActivated: recordSkillActivation,
        ...(isCompactCommand ? { compactRequest: true } : {}),
        ...(sessionMeta?.codexFastMode && channel.provider === 'openai-codex' ? { codexFastMode: true } : {}),
        ...(codexOAuthCredentials && {
          codexOAuthCredentials,
          onCodexOAuthCredentialsRefreshed: (credentials: CodexOAuthCredentials) => {
            persistCodexOAuthCredentials(channelId, credentials)
          },
        }),
        ...(xaiOAuthCredentials && {
          xaiOAuthCredentials,
          onXaiOAuthCredentialsRefreshed: (credentials: XaiOAuthCredentials) => {
            persistXaiOAuthCredentials(channelId, credentials)
          },
        }),
        ...((channel.provider === 'openai-codex' || channel.provider === 'xai' || channel.provider === 'openai-responses' || channel.provider === 'openai' || channel.provider === 'custom')
          && resolveReasoningProfile({
            modelId: selectedModelId,
            transport: inferReasoningTransport(channel.provider),
          })?.id.startsWith('openai-reasoning-') && {
            openAIThinkingLevel: piThinkingLevel!,
          }),
        thinkingLevel: piThinkingLevel!,
        ...(appSettings.agentMaxBudgetUsd != null && appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        ...(piCustomTools.length > 0 && { customTools: piCustomTools as PiAgentQueryOptions['customTools'] }),
        onSessionId: handleSessionId,
        onPiEntryBindings: (bindings) => {
          const latest = getAgentSessionMeta(sessionId)
          // 运行中切到其他内核后，保留旧 turn 展示但不再写入 Pi 专用恢复 artifact。
          if (latest?.legacyTranscript?.continuationRequired) return
          updateAgentSessionMeta(sessionId, {
            piEntryBindings: { ...(latest?.piEntryBindings ?? {}), ...bindings },
          })
        },
        onModelResolved: handleModelResolved,
        onContextWindow: handleContextWindow,
        retryRunStartedAt: streamStartedAt,
        onRetry: (retry) => {
          this.eventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'retry', ...retry } })
        },
      }

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 事件流。Pi adapter 自行处理传输层重试；此处仅允许一次 resume artifact 回退。
      const MAX_QUERY_ATTEMPTS = 2
      const queryStartedAt = Date.now()

      /** 南大向导：PHASE_ADVANCE 推进后的目标阶段（用于自动续接下一阶段） */
      let nanjuPhaseAdvanced: string | null = null

      for (let attempt = 1; attempt <= MAX_QUERY_ATTEMPTS; attempt++) {
        // A recovery query starts a fresh turn; activations from a failed attempt must not leak.
        pendingSkillActivations = []
        // 回退会清除 queryOptions.resumeSessionId；新建 Pi artifact 不应再触发 prompt replay。
        const wasResuming = !!queryOptions.resumeSessionId
        let shouldRetryFromError = false

        try {
          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = this.adapter.query(queryOptions)
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // 手动事件循环：Promise.race（SDKMessage vs result drain timeout）
          let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // result 收到后的安全超时：正常情况下 adapter 收到 terminal result 后会主动 break 自己的
          // for-await 循环（触发 SDK iterator.return → cleanup），让此处的 next() 立即拿到 done。
          // 此 timeout 仅作真正的兜底安全网，防止极端情况（SDK 行为再次变化等）下 iterator 不关闭、
          // 事件循环无限挂起。正常运行下不应触发——若日志频繁出现 drain timeout，说明 adapter 主动
          // 终止路径失效，需排查。
          let drainTimeoutPromise: Promise<'drain_timeout'> | null = null
          const RESULT_DRAIN_TIMEOUT_MS = 2_000
          let visibleRunMessageCount = 0

          while (true) {
            if (!pendingNext) {
              pendingNext = queryIterator.next()
            }

            const racePromises: Array<Promise<{ kind: string; result: IteratorResult<SDKMessage> | null }>> = [
              pendingNext.then((r) => ({ kind: 'event' as const, result: r })),
            ]
            if (drainTimeoutPromise) {
              racePromises.push(drainTimeoutPromise.then(() => ({ kind: 'drain_timeout' as const, result: null })))
            }

            const raceResult = await Promise.race(racePromises)

            if (raceResult.kind === 'drain_timeout') {
              // 安全网：channel.close() 后 SDK 仍未在超时内关闭 iterator，强制退出
              console.warn(`[Agent 编排] drain timeout: SDK iterator 在 result 后 ${RESULT_DRAIN_TIMEOUT_MS}ms 内未关闭，强制退出`)
              pendingNext?.catch(() => {})
              pendingNext = null
              queryIterator.return?.(undefined as never).catch(() => {})
              break
            }

            const iterResult = raceResult.result
            if (!iterResult || iterResult.done) break

            pendingNext = null
            let msg = iterResult.value
            if (isAssistantDeltaSDKMessage(msg)) {
              this.eventBus.emit(sessionId, {
                kind: 'sdk_delta',
                delta: {
                  uuid: msg.uuid,
                  deltas: [msg.delta],
                  session_id: msg.session_id,
                  runStartedAt: streamStartedAt,
                  _channelModelId: msg._channelModelId,
                },
              })
              continue
            }
            const isPartialMessage = isPartialSDKMessage(msg)
            if (msg.type === 'result') {
              const skillActivations = mergeSkillActivations(
                pendingSkillActivations,
                collectSkillActivations(
                  [...accumulatedMessages, msg],
                  workspaceSlug
                    ? { workspaceSlug, workspaceSkillsRoot: getWorkspaceSkillsDir(workspaceSlug) }
                    : undefined,
                ),
              )
              if (skillActivations.length > 0) {
                msg = {
                  ...(msg as Record<string, unknown>),
                  skill_activations: skillActivations,
                } as unknown as SDKMessage
              }
              pendingSkillActivations = []
            }
            // isVisibleRunMessage 已抽到独立模块，不含 partial 判断；
            // pi runtime 的流式 partial 消息不应计入可见消息数，故在此显式排除。
            if (!isPartialMessage && isVisibleRunMessage(msg)) {
              visibleRunMessageCount += 1
            }


            // SDK 权限模式可能在 canUseTool 前直接批准工具（如 bypassPermissions）。
            // 因此计划阶段状态要从实际 tool_use 流里同步，不能只依赖权限回调。
            if (msg.type === 'assistant') {
              const assistantMsg = msg as SDKAssistantMessage
              if (!assistantMsg.isReplay) {
                for (const block of assistantMsg.message.content) {
                  if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
                    syncPlanModeFromToolUse(block.name)
                  }
                }
              }
            }

            // 检测 assistant 消息中的 SDK 错误
            if (msg.type === 'assistant' && !isPartialMessage) {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                // Pi keeps generated text and the transport failure in separate fields. Claude's
                // content-first extractor would otherwise promote the text to error details.
                const { detailedMessage, originalError } = getPiAssistantErrorDetails(assistantMsg)
                let errorCode = assistantMsg.error.errorType || 'unknown_error'
                if (isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                const typedError = mapAgentErrorToTypedError(errorCode, friendlyErrorMessage(detailedMessage), originalError)

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && wasResuming) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Proma 已持久化上下文重跑一次；再失败才展示用户提示。
                if (
                  typedError.code === THINKING_SIGNATURE_ERROR_CODE &&
                  wasResuming
                ) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
                    true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
                  )
                  shouldRetryFromError = true
                  break
                }

                // 上下文过长：旧 SDK session 已经处于不可继续的超限状态。
                // 自动清除 resume 指针，改用 Proma 最近历史回填重跑一次；用于飞书/自动任务等无人值守入口自恢复。
                if (
                  typedError.code === 'prompt_too_long' &&
                  wasResuming
                ) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
                    true,
                  )
                  shouldRetryFromError = true
                  break
                }

                // 不可重试 → 终止
                const hasPiPartialOutput = hasPiAssistantTextContent(assistantMsg)
                if (hasPiPartialOutput) {
                  const partialOutput = stripPiAssistantError(assistantMsg)
                  if (modelId) partialOutput._channelModelId = modelId
                  partialOutput._channelProvider = channel.provider
                  const partialRecord = partialOutput as SDKAssistantMessage & { _createdAt?: number }
                  if (typeof partialRecord._createdAt !== 'number') {
                    partialRecord._createdAt = streamStartedAt
                  }
                  accumulatedMessages.push(partialOutput)
                  // Reuse the Pi UUID to replace the latest partial frame with normal markdown output.
                  this.eventBus.emit(sessionId, { kind: 'sdk_message', message: partialOutput })
                }
                this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                accumulatedMessages.length = 0
                if (typedError.code === 'prompt_too_long') {
                  try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
                }

                const errorContent = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  uuid: randomUUID(),
                  _channelModelId: modelId,
                  _channelProvider: channel.provider,
                  error: { message: typedError.message, errorType: typedError.code },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                appendSDKMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                this.eventBus.emit(sessionId, { kind: 'sdk_message', message: errorSDKMsg })
                try { updateAgentSessionMeta(sessionId, {}) } catch { /* 忽略 */ }
                completeRun(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })
                return
              }
            }

            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积需要长期可见的状态（压缩 / 权限拒绝）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              const msgRecord = msg as Record<string, unknown>
              if (!msgRecord.isReplay && !isPartialMessage) {
                if (msg.type === 'user') {
                  // 仅累积包含 tool_result 的 user 消息（跳过 SDK 重新发出的初始用户消息）
                  const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
                  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
                  if (hasToolResult) {
                    accumulatedMessages.push(msg)
                  }
                } else {
                  // 为结果消息注入渠道信息，确保持久化后能按模型上下文窗口计算压缩阈值
                  if (msg.type === 'result') {
                    if (modelId) {
                      (msg as Record<string, unknown>)._channelModelId = modelId
                    }
                    ;(msg as Record<string, unknown>)._channelProvider = channel.provider
                  }
                  // 为 assistant 消息注入渠道信息，确保持久化后能正确匹配模型显示名与上下文窗口
                  if (msg.type === 'assistant') {
                    const assistantRecord = msg as Record<string, unknown>
                    if (typeof assistantRecord._createdAt !== 'number') {
                      assistantRecord._createdAt = streamStartedAt
                    }
                    if (modelId) {
                      assistantRecord._channelModelId = modelId
                    }
                    assistantRecord._channelProvider = channel.provider
                  }
                  accumulatedMessages.push(msg)
                }
              }
            } else if (msg.type === 'system') {
              const sysMsg = msg as SDKSystemMessage
              if (isPersistableSDKSystemMessage(sysMsg)) {
                accumulatedMessages.push(msg)
              }
            }

            // W10（v0.17.72）：确认响应推进检查——用户确认语义检测置位。
            // 背景：dev-test-report §六——L1 收到确认后用「干活」响应而非输出 PHASE_ADVANCE，
            // 推进纪律是 prompt 遵从薄弱点。检测（type=user 且非 tool_result）命中确认词
            // 且 verifyPhaseOutput 达标时置位 confirmPendingStage（getNanjuRouterPrompt 注入
            // 强推进提示）；反义词清除（用户反悔）。不自动推进——推进权仍在 L1 输出标记（设计决策）。
            // try-catch 不影响主流程；用户非确认消息不清除（保持待推进直到推进或反悔，工单 §2.3）。
            if (msg.type === 'user' && workspaceSlug && !automationContext && !input.triggeredBy) {
              try {
                const userContent = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content
                if (Array.isArray(userContent) && !userContent.some((b) => b.type === 'tool_result')) {
                  const userText = userContent.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
                  if (userText.trim() !== '') {
                    const { listNanjuProjects, judgeConfirmAdvance, setProjectConfirmPending, clearProjectConfirmPending } =
                      require('./nanju-project')
                    const project = listNanjuProjects(workspaceSlug).find(
                      (p: { sessionId?: string }) => p.sessionId === sessionId,
                    )
                    if (project) {
                      const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage)
                      const action = judgeConfirmAdvance(userText, project.currentStage, verifyError)
                      if (action === 'set') {
                        setProjectConfirmPending(workspaceSlug, project.projectId, project.currentStage)
                        try {
                          const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                          recordTelemetry(workspaceSlug, 'confirm.advance-hint', {
                            project_id: project.projectId,
                            stage: project.currentStage,
                            mode: project.mode,
                          }, project.projectId)
                        } catch { /* 埋点失败不影响置位 */ }
                        console.log(`[南大路由] 确认检测：置位 confirmPending=${project.currentStage}（${project.name}）`)
                      } else if (action === 'clear') {
                        clearProjectConfirmPending(workspaceSlug, project.projectId)
                        console.log(`[南大路由] 确认检测：反义词清除 confirmPending（${project.name}）`)
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn('[南大路由] 确认检测异常（不阻断）:', e instanceof Error ? e.message : String(e))
              }
            }

            // 南大向导：检测 PHASE_ADVANCE 标记 + 文件验证后推进阶段
            if (msg.type === 'result' && workspaceSlug && !automationContext && !input.triggeredBy) {
              try {
                // 从本轮累积的消息中提取最后一条 assistant 文本
                const lastAccumulated = [...accumulatedMessages].reverse().find(
                  (m) => (m as { type?: string }).type === 'assistant',
                )
                const textBlocks = (lastAccumulated as { message?: { content?: Array<{ type: string; text?: string }> } })?.message?.content
                const fullText = (textBlocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
                const phaseMatch = fullText.match(/(?:PHASE_COMPLETE|PHASE_ADVANCE):\s*([a-z-]+)/i)
                // W2c（v0.17.69）：意见收集轮 L1 语义回归标记检测（PHASE_ADVANCE 同型字符串检测；
                // 判定协议 v1 第 3 条——硬规则未命中时 L1 语义判定启动，只标建议，
                // 写入走主进程唯一写入点 recordRegressionEvent，judgment 必附审计日志）
                const regressionMatch = fullText.match(/<!--\s*NANJU_REGRESSION:\s*([^-]+?)\s*-->/)
                if (regressionMatch && !phaseMatch) {
                  try {
                    const { listNanjuProjects: listProj } = require('./nanju-project') as typeof import('./nanju-project')
                    const proj = listProj(workspaceSlug).find((p: { sessionId?: string }) => p.sessionId === sessionId)
                    // 仅 prototype 阶段的意见收集轮生效（标记语义绑定 UX→PRD 回归；其他阶段防误标）
                    if (proj && proj.currentStage === 'prototype') {
                      const { recordRegressionEvent } = require('./nanju-regression') as typeof import('./nanju-regression')
                      const judgment = regressionMatch[1]?.trim() || 'L1 语义判定：意见引入 PRD 未有的新需求'
                      recordRegressionEvent(workspaceSlug, proj.projectId, 'prototype', 'requirements', judgment, {
                        opinion: fullText.slice(0, 500),
                        judgment,
                        sessionId,
                      })
                      console.log(`[南大回归] L1 语义判定标记：${proj.name} prototype→requirements（${judgment}）`)
                    }
                  } catch (e) {
                    console.warn('[南大回归] 标记检测异常（不阻断）:', e instanceof Error ? e.message : String(e))
                  }
                }
                if (phaseMatch) {
                  const newStage = phaseMatch[1]?.toLowerCase()
                  console.log(`[南大路由] 检测到 PHASE_ADVANCE: ${newStage}`)
                  // 文件验证
                  const { verifyPhaseOutput } = require('./nanju-router-gate')
                  const { listNanjuProjects, updateNanjuProject } = require('./nanju-project')
                  const projects = listNanjuProjects(workspaceSlug)
                  const project = projects.find((p: { sessionId: string }) => p.sessionId === sessionId)
                  if (project) {
                    // W7（v0.17.69 + AC 审计 M3/M4）：architecture 产出验证前置位——解析
                    // architecture.md 的 projectEnv 标记行写 envReady（write-then-gate：先置位
                    // 再跑含 envReady 门禁的 verifyPhaseOutput，避免首推进被自己未置位的门禁
                    // 误拦）。解析+置位逻辑已抽 syncProjectEnvStateFromArchitectureDoc 共用
                    //（M3 正则放宽 + 幂等 + 无标记行 warn），与 syncNanjuGuideConfirmState
                    // result 侧复用同一实现，防两处解析口径漂移。
                    if (project.currentStage === 'architecture') {
                      try {
                        const { syncProjectEnvStateFromArchitectureDoc } =
                          require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                        syncProjectEnvStateFromArchitectureDoc(workspaceSlug, project.projectId, sessionId)
                      } catch (e) {
                        console.warn('[南大路由] 环境状态置位失败（不阻断验证）:', e instanceof Error ? e.message : String(e))
                      }
                    }
                    const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage)
                    if (verifyError) {
                      console.log(`[南大路由] 文件验证失败，不推进: ${verifyError}`)
                      // 可见化（AC L-002）：校验失败时 PHASE_ADVANCE 不推进，除主进程日志外
                      // 向会话注入 assistant 消息，让用户/调度员在 UI 直接看到拦截原因；
                      // 不自动续接，待修复后重新声明推进（本轮照常 completeRun）。
                      this.eventBus.emit(sessionId, {
                        kind: 'sdk_message',
                        message: {
                          type: 'assistant',
                          message: { content: [{ type: 'text', text: `⚠️ 阶段推进被拦截：${verifyError}\n产出未达交付标准，请继续修复后重新声明推进。` }] },
                          parent_tool_use_id: null,
                          uuid: randomUUID(),
                        } as unknown as SDKMessage,
                      })
                    } else {
                      // coding.executed 埋点（P1 Sprint A）：coding 阶段推进成功 = 用户已确认的可运行应用交付事实
                      // （推进即事实；不用 verifyPhaseOutput 通过后记，避免把重试中的半成品计入）
                      if (project.currentStage === 'coding') {
                        try {
                          const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                          recordTelemetry(workspaceSlug, 'coding.executed', {
                            project_id: project.projectId, mode: project.mode,
                            entry: '08_APP/index.html',
                          }, project.projectId)
                        } catch { /* 埋点失败不影响推进 */ }
                      }
                      // arch.executed 埋点（W7，v0.17.69）：architecture 阶段推进成功 = 架构师
                      // 环节（含环境探测）首次两模式可观测的交付事实（推进即事实口径，同 coding.executed）
                      if (project.currentStage === 'architecture') {
                        try {
                          const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                          const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
                          recordTelemetry(workspaceSlug, 'arch.executed', {
                            project_id: project.projectId, mode: project.mode,
                            requires_ac: getPhaseNode(project.mode, 'architecture')?.requiresAC ?? false,
                          }, project.projectId)
                        } catch { /* 埋点失败不影响推进 */ }
                      }
                      // Sprint B：testing 阶段推进语义分叉（机器裁判闭环）
                      // ① PHASE_ADVANCE: testing 重入（currentStage 已是 testing）= 场景已生成/缺陷已修复
                      //    → Harness 异步触发 GwtRunner（不改阶段；完成后按裁判结果注入/续接）
                      // ② PHASE_ADVANCE: delivered（当前 testing）= 要求交付
                      //    → 必须已有 verdict=pass 的测试报告，否则拦截（机器裁判收口）
                      const isTestingSelfAdvance = project.currentStage === 'testing' && newStage === 'testing'
                      const isDeliverFromTesting = project.currentStage === 'testing' && newStage === 'delivered'
                      if (isTestingSelfAdvance) {
                        console.log(`[南大路由] testing 重入推进：触发 GWT 验收测试（${project.name}）`)
                        this.triggerNanjuGwtRun({
                          workspaceSlug,
                          projectId: project.projectId,
                          projectName: project.name,
                          projectMode: project.mode,
                          sessionId,
                          resume: { channelId, modelId, workspaceId, permissionModeOverride },
                        })
                        // 不改 currentStage（保持 testing）；不设 nanjuPhaseAdvanced（不触发通用续接，
                        // GwtRunner 完成后按裁判结果自行注入/续接）
                      } else if (isDeliverFromTesting) {
                        const gateError = this.checkNanjuGwtDeliveryGate(workspaceSlug, project.projectId)
                        if (gateError) {
                          console.log(`[南大路由] GWT 交付门禁拦截，不推进: ${gateError}`)
                          this.injectNanjuAssistantMessage(sessionId, `⚠️ 交付被拦截：${gateError}`)
                        } else {
                          updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage })
                          console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}`)
                          nanjuPhaseAdvanced = newStage ?? null
                          // W10：推进成功——消费清除确认待推进（幂等，工单 §2.1 消费侧）
                          try {
                            const { clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
                            clearProjectConfirmPending(workspaceSlug, project.projectId)
                          } catch { /* 清除失败不影响推进（残留提示无害，下次推进再清） */ }
                          this.finalizeNanjuPhaseTodos(sessionId)
                          // W2 S1 推进点 A：交付清空子步骤（delivered 无子步骤态）并广播。
                          // write-then-emit；失败不阻断交付（渲染端 10s 轮询兑底）。
                          try {
                            const { setProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
                            const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
                            setProjectSubStage(workspaceSlug, project.projectId, '')
                            emitGuideProgress(sessionId, project.projectId, newStage ?? 'delivered', '')
                          } catch { /* 向导图子步骤广播失败不影响交付 */ }
                        }
                      } else {
                        // W11（v0.17.73）：推进目标校验——通用分支消费标记前校验标记目标
                        // 必须 === getNextPhase(mode, currentStage)（与 route.next 同源），
                        // 不接受跳级/跨级/回退。终测 E2E 实锤：L1 在 prototype 阶段输出
                        // `PHASE_ADVANCE: coding` 跳过 architecture（jsonl 行 81），检测块
                        // 此前按标记目标推进、无校验（继 W8 拦委派角色/W10 提示推进纪律
                        // 之后的第三个强制力缺口）。插入点在 else 通用分支开头：
                        // isTestingSelfAdvance / isDeliverFromTesting 两特殊分支已在上方
                        // 分流（testing 重入/交付不受本校验影响——纯函数同口径豁免）；
                        // 拒绝时本分支全部推进钩子（熔断复位/埋点/模板落位/
                        // updateNanjuProject/confirmPending 清除/Todo 兑底/子步骤广播）
                        // 都不执行，注入教育消息后本轮照常 completeRun、不设
                        // nanjuPhaseAdvanced（不触发自动续接），待修正标记后重新声明。
                        // try-catch 兜底取舍：校验自身异常（route 数据损坏等）不阻断既有
                        // 推进路径——宁可放行不可卡死（与 verifyPhaseOutput 的拦截语义
                        // 不同：文件验证失败拦推进，校验代码自身出 bug 不能把流程卡死）；
                        // 异常 mode / route 缺失的防御性放行在纯函数内处理（见
                        // validateAdvanceTarget）。
                        let advanceTargetOk = true
                        try {
                          const { validateAdvanceTarget } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
                          const advanceVerdict = validateAdvanceTarget(project.mode, project.currentStage, newStage ?? '')
                          if (!advanceVerdict.ok) {
                            advanceTargetOk = false
                            console.log(`[南大路由] 推进目标校验拒绝: ${project.currentStage} → ${newStage}（合法目标 ${advanceVerdict.expected ?? '无（终态）'}）`)
                            if (advanceVerdict.expected) {
                              this.injectNanjuAssistantMessage(
                                sessionId,
                                `⚠️ 推进标记目标错误：当前 ${project.currentStage} 的下一阶段是 ${advanceVerdict.expected}，`
                                + `不接受跳级/跨级（标记目标 ${newStage} 被忽略）。请输出 <!-- PHASE_ADVANCE: ${advanceVerdict.expected} -->。`,
                              )
                            } else {
                              // 终态兜底（currentStage=delivered，next=null）：无正确标记可引导
                              this.injectNanjuAssistantMessage(
                                sessionId,
                                `⚠️ 推进标记目标错误：当前 ${project.currentStage} 已是终态，无合法下一阶段（标记目标 ${newStage} 被忽略）。`,
                              )
                            }
                          }
                        } catch (e) {
                          console.warn('[南大路由] 推进目标校验异常（放行，不阻断推进）:', e instanceof Error ? e.message : String(e))
                        }
                        if (advanceTargetOk) {
                          // 阶段熔断复位 + phase.elapsed 埋点 + US-xx 上游提示（v0.17.64 Sprint C1）。
                          // 推进 = 离开阶段已收口（用户确认/修复完成）：清零该阶段 guard（用户驱动的复位路径）；
                          // 阶段时长以 project.updatedAt（上次写 currentStage 的时间）近似，够漏斗分析用。
                          try {
                            const { updatePhaseGuard } = require('./nanju-project') as typeof import('./nanju-project')
                            updatePhaseGuard(workspaceSlug, project.projectId, project.currentStage as NanjuGuardStage, {
                              kind: 'reset',
                              note: '阶段推进收口',
                            })
                            const stageDurationMs = Date.now() - Date.parse(project.updatedAt)
                            if (Number.isFinite(stageDurationMs) && stageDurationMs >= 0) {
                              const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                              recordTelemetry(workspaceSlug, 'phase.elapsed', {
                                project_id: project.projectId,
                                from_stage: project.currentStage,
                                to_stage: newStage,
                                duration_ms: stageDurationMs,
                              }, project.projectId)
                            }
                          } catch { /* 复位/埋点失败不影响推进 */ }
                          // US-xx 上游检查强化（#5 升级，提示不阻断）：requirements 收口时 PRD 仍无
                          // US-xx 编号清单 → 注入提醒（测试阶段 parseUserStories 判定将无法进行）
                          if (project.currentStage === 'requirements') {
                            try {
                              const { existsSync: prdExists, readFileSync: prdRead } = require('node:fs')
                              const { join: prdJoin } = require('node:path')
                              const { getNanjuProjectDir } = require('./nanju-project') as typeof import('./nanju-project')
                              const { parseUserStories } = require('./nanju-gwt-runner') as typeof import('./nanju-gwt-runner')
                              const prdPath = prdJoin(getNanjuProjectDir(workspaceSlug, project.projectId), '01_PRD', 'prd.md')
                              if (prdExists(prdPath) && parseUserStories(prdRead(prdPath, 'utf-8')).length === 0) {
                                this.injectNanjuAssistantMessage(
                                  sessionId,
                                  '⚠️ 上游检查提示：PRD 未提取到「US-xx」编号用户故事清单，后续测试阶段的覆盖性判定将无法进行'
                                  + '（测试阶段会 fail-fast 要求补 PRD）。建议补充用户故事编号清单后再继续；本次不阻断推进，可按需继续。',
                                )
                              }
                            } catch { /* 检查失败不阻断推进 */ }
                          }
                          // 工程模板前移落位（W7 R3 前移契约，v0.17.69）：即将进入 architecture
                          // ——按 PRD 初判/默认品类 materialize 模板到 00_ENGINEERING_TEMPLATE/
                          //（头部标注「初判参考」），【不写 projectCategory】：品类写入与权威
                          // 重落位只在 coding 推进钩子（防 existing?? 幂等污染终判）。
                          if (newStage === 'architecture') {
                            try {
                              const {
                                resolveProjectCategoryForCoding,
                                materializeEngineeringTemplate,
                              } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                              const initial = resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
                                ?? { category: 'web-fullstack' as const, source: 'default' as const }
                              const templatePath = materializeEngineeringTemplate(
                                workspaceSlug, project.projectId, initial.category,
                                undefined, { annotateInitialGuess: true },
                              )
                              console.log(`[南大路由] 工程模板前移落位: ${project.name} → ${initial.category}（${initial.source}，初判参考）${templatePath ? '' : '（模板缺失，架构师按品类自行降级）'}`)
                            } catch (e) {
                              console.warn('[南大路由] 工程模板前移落位异常（不阻断推进）:', e instanceof Error ? e.message : String(e))
                            }
                          }
                          // 工程品类判定与模板落位（W3，v0.17.66）：即将进入 coding——从
                          // architecture/prd 提取 projectCategory 写入 _project-info.json，并把
                          // 对应品类工程模板复制到 00_ENGINEERING_TEMPLATE/（coding 委派任务
                          // 注入精简要点 + 全文路径引用）。失败不阻断推进（coding 侧另有
                          // 现场降级兑底，见 getNanjuRouterPrompt）。
                          if (newStage === 'coding') {
                            try {
                              const {
                                resolveProjectCategoryForCoding,
                                materializeEngineeringTemplate,
                              } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                              const { setProjectCategory, getProjectCategory } = require('./nanju-project') as typeof import('./nanju-project')
                              const existing = getProjectCategory(workspaceSlug, project.projectId)
                              const resolved = existing ?? resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
                                ?? { category: 'web-fullstack' as const, source: 'default' as const }
                              setProjectCategory(workspaceSlug, project.projectId, resolved.category, resolved.source)
                              const templatePath = materializeEngineeringTemplate(workspaceSlug, project.projectId, resolved.category)
                              console.log(`[南大路由] 工程品类判定: ${project.name} → ${resolved.category}（${resolved.source}）${templatePath ? '' : '，模板落位失败（coding 侧降级仅要点）'}`)
                            } catch (e) {
                              console.warn('[南大路由] 工程品类判定异常（不阻断推进）:', e instanceof Error ? e.message : String(e))
                            }
                          }
                          updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage })
                          console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}`)
                          nanjuPhaseAdvanced = newStage ?? null
                          // W10：推进成功——消费清除确认待推进（幂等，工单 §2.1 消费侧）
                          try {
                            const { clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
                            clearProjectConfirmPending(workspaceSlug, project.projectId)
                          } catch { /* 清除失败不影响推进（残留提示无害，下次推进再清） */ }
                          // Todo 纪律兜底（P3/L4）：调度员经常忘记在阶段推进时收尾 Todo，
                          // 程序化把该会话关联的 open Todo 标记完成（nativeOrigin 外部来源不动，
                          // 避免同步到系统提醒事项的副作用；只处理本会话通过 TaskCreate 建的）。
                          this.finalizeNanjuPhaseTodos(sessionId)
                          // W2 S1 推进点 B：新阶段子步骤 = 主节点（作者产出中）并广播；推进到
                          // 无主节点阶段（delivered，防御兑底——实际 delivered 推进走 A 点/GWT-pass
                          // 路径，A7 笔误修正：quick 路由 prototype.next=coding 无直连交付边）→ 清空
                          // 子步骤。失败不阻断推进。
                          try {
                            const { setProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
                            const { getGuideStageMainNodeId, emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
                            const subStage = (newStage ? getGuideStageMainNodeId(newStage) : undefined) ?? ''
                            setProjectSubStage(workspaceSlug, project.projectId, subStage)
                            emitGuideProgress(sessionId, project.projectId, newStage ?? 'delivered', subStage)
                          } catch { /* 向导图子步骤广播失败不影响推进 */ }
                        }
                      }
                    }
                  } else {
                    console.log(`[南大路由] 未找到关联的南大项目: sessionId=${sessionId}`)
                  }
                }
              } catch (e) {
                console.warn(`[南大路由] PHASE_ADVANCE 检测异常:`, e instanceof Error ? e.message : String(e))
              }
            }

            // Turn 结束时：持久化累积消息
            if (msg.type === 'result') {
              capturedResultSubtype = (msg as { subtype?: string }).subtype
              // Pi result 的 errors[] 携带真实错误原因，透传到前端展示具体错误。
              const rawResultErrors = (msg as { errors?: unknown }).errors
              capturedResultErrors = Array.isArray(rawResultErrors)
                ? rawResultErrors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                : undefined
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
              console.log(
                `[Agent 编排] result 到达: sessionId=${sessionId}, subtype=${capturedResultSubtype ?? 'unknown'}` +
                (capturedResultErrors?.length ? `, errors=${JSON.stringify(capturedResultErrors)}` : ''),
              )

              // 南大调度员 Todo 步骤级对账（L5：进度标识不更新约根本治理）
              // 指令级纪律对调度员无效（实测 TaskCreate 后 TaskUpdate=0），阶段级兑底
              // 只在阶段切换时触发，步骤进行中永远 0/N。改为每轮 result 到达时按
              // 实际项目状态对账：阶段已推进→该阶段全部旧 Todo 标完成；同阶段内
              // 若本轮产出文件已落盘且被验证过→「委派/等待/检查」类 Todo 也应完成。
              try {
                if (workspaceSlug && nanjuPhaseAdvanced === null) {
                  const { listNanjuProjects } = require('./nanju-project') as typeof import('./nanju-project')
                  const { listTodos, updateTodo } = require('./planning-manager') as typeof import('./planning-manager')
                  const project = listNanjuProjects(workspaceSlug).find((p) => p.sessionId === sessionId)
                  if (project) {
                    const stageOrder = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing', 'delivered']
                    const currentIdx = stageOrder.indexOf(project.currentStage)
                    const openTodos = listTodos({ status: 'open', limit: 100 }).filter((t) =>
                      t.sessionLinks?.some((l) => l.sessionId === sessionId) && !t.nativeOrigin)
                    let completed = 0
                    for (const t of openTodos) {
                      // Todo 标题含阶段前缀（如「需求阶段：…」）；解析出其所属阶段
                      const m = /^(需求|原型|架构|规划|开发|测试)阶段/.exec(t.title)
                      if (!m) continue
                      const todoStageMap: Record<string, string> = { '需求': 'requirements', '原型': 'prototype', '架构': 'architecture', '规划': 'planning', '开发': 'coding', '测试': 'testing' }
                      const todoStage = todoStageMap[m[1] ?? '']
                      if (!todoStage) continue
                      const todoIdx = stageOrder.indexOf(todoStage)
                      // 该 Todo 所属阶段已被跨过（项目已在更晚阶段）→ 标完成
                      if (todoIdx >= 0 && currentIdx > todoIdx) {
                        try { updateTodo({ id: t.id, status: 'completed' }); completed++ } catch { /* 单条失败不断 */ }
                      }
                    }
                    if (completed > 0) {
                      console.log(`[南大路由] 步骤对账：阶段已跨过，自动完成 ${completed} 个旧阶段 Todo（session ${sessionId}）`)
                    }
                  }
                }
              } catch { /* 对账失败不影响主流程 */ }
              // W2 S1 确认点 C（result 侧）：本轮产出落盘后即点亮「等待用户确认」——
              // 「产出完成=等待用户确认」的诚实两态即时可见（幂等；失败不影响主流程）。
              try {
                if (workspaceSlug) {
                  const { syncNanjuGuideConfirmState } = require('./nanju-phase-gate') as typeof import('./nanju-phase-gate')
                  syncNanjuGuideConfirmState(workspaceSlug, sessionId)
                }
              } catch { /* 向导图子状态同步失败不影响主流程 */ }
              // Pi 也可能在 result 中报告失效的 resume artifact；仅回退本轮实际 resume 的请求。
              const resultErrorText = capturedResultErrors?.join('\n')
              if (resultErrorText && wasResuming) {
                if (isSessionNotFoundError(resultErrorText)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  shouldRetryFromError = true
                  break
                }
                if (isPromptTooLongError(resultErrorText)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式', true,
                  )
                  shouldRetryFromError = true
                  break
                }
                if (isThinkingSignatureError(resultErrorText)) {
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  this.prepareResumeFallbackRecovery(
                    sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式', true,
                  )
                  shouldRetryFromError = true
                  break
                }
              }
              if (!drainTimeoutPromise) {
                // Pi adapter 收到终态 result 后会结束 iterator；超时仅保护异常运行时行为。
                drainTimeoutPromise = new Promise((resolve) =>
                  setTimeout(() => resolve('drain_timeout'), RESULT_DRAIN_TIMEOUT_MS),
                )
              }
            }

            // 过滤 SDK 内部生成的 user 消息（如 Skill 展开文本），避免在前端渲染为用户消息
            // 仅允许含 tool_result 的 user 消息通过（这些是工具调用的响应，需要展示）
            // 初始用户消息已通过前端乐观注入显示，无需 SDK 重复推送
            let shouldEmit = true
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
              const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
              if (!hasToolResult) {
                shouldEmit = false
              }
            }

            if (!shouldEmit) {
              // 跳过 SDK 内部 user 消息的前端推送
            } else {
              this.eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
            }
          }

          // 错误 break 触发了 → 继续循环
          if (shouldRetryFromError) {
            continue
          }

          const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          try { updateAgentSessionMeta(sessionId, wasStoppedByUser ? { stoppedByUser: true } : {}) } catch { /* 忽略 */ }

          if (!wasStoppedByUser && visibleRunMessageCount === 0) {
            const errorContent = this.persistEmptyResponseError(sessionId, capturedResultSubtype, capturedResultErrors)
            failRun(errorContent, getAgentSessionMessages(sessionId), {
              startedAt: streamStartedAt,
              resultSubtype: EMPTY_RESPONSE_RESULT_SUBTYPE,
              resultErrors: [errorContent],
            })
            return
          }

          // Plan 模式：Agent 完成规划后注入"接受计划"建议
          if (initialPermissionMode === 'plan' && planModeEntered && this.activeSessions.has(sessionId)) {
            this.eventBus.emit(sessionId, {
              kind: 'sdk_message',
              message: { type: 'prompt_suggestion', suggestion: '请执行该计划' } as unknown as SDKMessage,
            })
            console.log(`[Agent 编排] Plan 模式：已注入计划确认建议`)
          }

          // 南大向导：阶段推进后自动续接下一阶段（delivered 是终点：不续接，注入完成富语，引导用户新建项目）
          if (nanjuPhaseAdvanced && !wasStoppedByUser) {
            const advanceStage = nanjuPhaseAdvanced
            if (advanceStage === 'delivered') {
              console.log(`[南大路由] 项目已交付（delivered），不自动续接，注入完成提示`)
              this.eventBus.emit(sessionId, {
                kind: 'sdk_message',
                message: {
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: '🎉 项目已全部完成交付！\n\n向导流程到此结束。产出物在项目目录（01_PRD / 02_UX_DESIGN / 08_APP），可运行应用入口 08_APP/index.html，可随时回看。\n想继续做新东西？在南大向导首页点「快速做一个工具」开始新项目；对交付物有后续修改需求，可直接在本会话继续描述。' }] },
                  parent_tool_use_id: null,
                  uuid: randomUUID(),
                } as unknown as SDKMessage,
              })
              completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })
              return
            }
            console.log(`[南大路由] 阶段已推进到 ${advanceStage}，1.5 秒后自动续接...`)
            // 注入系统提示，让用户知道已推进
            this.eventBus.emit(sessionId, {
              kind: 'sdk_message',
              message: {
                type: 'assistant',
                message: { content: [{ type: 'text', text: `✅ 本阶段已完成，自动进入下一阶段：${advanceStage === 'prototype' ? 'UX 原型设计' : advanceStage === 'architecture' ? '架构设计' : advanceStage === 'planning' ? '工程规划' : advanceStage === 'coding' ? '全栈开发' : advanceStage}...` }] },
                parent_tool_use_id: null,
                uuid: randomUUID(),
              } as unknown as SDKMessage,
            })
            // 正常完成本轮（completeRun 内释放会话锁并发 STREAM_COMPLETE、驱动队列协调器），
            // renderer 收到完成信号后解除 Running/输入锁定；续接 run 由下方延迟触发。
            completeRun(getAgentSessionMessages(sessionId), { startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })
            setTimeout(() => {
              // 必须走注册的 headless 通道续接，而非直连 this.sendMessage：后者绕过
              // agent-service 布线，无 wc 注册、无启动信号、无完成信号，续接 run 的
              // 全部流式事件会被事件中间件静默丢弃（v0.17.60 UI 冻结根因）。
              // runRegisteredHeadlessAgent 自动注册 wc 并发 external_run_started
              // （renderer activateExternalAgentRun 原生支持，不抢前台焦点），
              // 结束时正常发 STREAM_COMPLETE 并驱动队列协调器。
              runRegisteredHeadlessAgent(
                {
                  sessionId,
                  userMessage: '请继续下一阶段的工作。',
                  channelId,
                  modelId,
                  workspaceId,
                  permissionModeOverride,
                  startedAt: Date.now(),
                },
                {
                  source: 'delegation',
                  onError: (error: string) => {
                    console.warn(`[南大路由] 自动续接错误:`, error)
                  },
                  onComplete: () => {
                    // 自动续接的 onComplete 不需要额外处理——消息已持久化到 JSONL，
                    // 渲染端通过 STREAM_COMPLETE / agent-session-updated 事件刷新
                  },
                  onTitleUpdated: () => {},
                },
              ).catch((e: unknown) => {
                console.warn(`[南大路由] 自动续接失败:`, e instanceof Error ? e.message : String(e))
              })
            }, 1500)
            return
          }

          // 发送完成信号
          completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })

          return

        } catch (error) {
          if (!this.activeSessions.has(sessionId)) {
            const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
            completeRun(getAgentSessionMessages(sessionId), { stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
            return
          }

          const rawErrorMessage = errorMessageOf(error)
          const catchLooksPromptTooLong = isPromptTooLongError(rawErrorMessage)

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage) && wasResuming) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
            continue  // 进入下一次 retry 循环
          }

          // 上下文过长：清除超限 resume 指针，用 Proma 历史回填自动恢复一次。
          if (catchLooksPromptTooLong && wasResuming) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
              true,
            )
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (
            isThinkingSignatureError(rawErrorMessage) &&
            wasResuming
          ) {
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
              true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
            )
            continue  // 进入下一次 retry 循环
          }

          // 不可重试 — 走原有终止逻辑
          const errorMessage = rawErrorMessage || '未知错误'
          console.error(`[Agent 编排] 执行失败:`, error)

          // 保存已累积的部分内容
          if (accumulatedMessages.length > 0) {
            try {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              console.log(`[Agent 编排] 已保存部分执行结果 (${accumulatedMessages.length} 条消息)`)
            } catch (saveError) {
              console.error('[Agent 编排] 保存部分内容失败:', saveError)
            }
          }

          let userFacingError = friendlyErrorMessage(errorMessage)

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const errorStack = error instanceof Error ? (error.stack ?? error.message) : String(error)
            const isPromptTooLong = isPromptTooLongError(userFacingError, errorStack)
            const isThinkingSignature = isThinkingSignatureError(userFacingError, rawErrorMessage, errorStack)
            const errorCode = isPromptTooLong
              ? 'prompt_too_long'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_CODE
                : 'unknown_error'
            const errorTitle = isPromptTooLong
              ? '上下文过长'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_TITLE
                : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
                  { key: 'r', label: '重试', action: 'retry' },
                ]
              : undefined
            userFacingError = errorContent
            if (isPromptTooLong) {
              try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
            }

            const errMsg: SDKMessage = {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: errorContent }],
              },
              parent_tool_use_id: null,
              uuid: randomUUID(),
              error: { message: errorContent, errorType: errorCode },
              _createdAt: Date.now(),
              _errorCode: errorCode,
              _errorTitle: errorTitle,
              _errorActions: errorActions,
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          failRun(userFacingError, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

          // 保留 Pi session ID，确保网络或上游临时失败后的下一轮可继续 resume。
          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 保留 sdkSessionId 以便下一轮 resume（错误未表明会话失效）`)
          }

          return
        }
      }

      const recoveryFailure = '会话恢复失败，请新建会话继续'
      const recoveryError: SDKMessage = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: recoveryFailure }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        error: { message: recoveryFailure, errorType: 'unknown_error' },
        _createdAt: Date.now(),
        _errorCode: 'unknown_error',
        _errorTitle: '会话恢复失败',
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [recoveryError])
      failRun(recoveryFailure, getAgentSessionMessages(sessionId), { startedAt: streamStartedAt })

    } finally {
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      releaseActiveRun()
      permissionService.clearSessionPending(sessionId)
      // turn 结束后，本 run 发起的 AskUserQuestion 已不可能被有效响应：
      // 清理 pending 并广播 ask_user_resolved，让 renderer 横幅不再残留霸占输入
      // （若锁已被更新的 run 接管，其 pending 归新 run 所有，跳过）。
      if (!this.activeSessions.has(sessionId)) {
        for (const pending of askUserService.getPendingRequests()) {
          if (pending.sessionId !== sessionId) continue
          this.eventBus.emit(sessionId, {
            kind: 'proma_event',
            event: { type: 'ask_user_resolved', requestId: pending.requestId },
          })
        }
        askUserService.clearSessionPending(sessionId)
      }
      exitPlanService.clearSessionPending(sessionId)
    }
  }

  /**
   * 中止指定会话的 Agent 执行
   *
   * 先从 activeSessions 移除（供 sendMessage catch 块检测用户中止），
   * 再调用 adapter.abort() 中止底层 SDK 进程。
   */
  stop(sessionId: string, stopBeforeRun = false): void {
    const runGeneration = this.activeSessions.get(sessionId)
    this.activeSessions.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    browserController.cancelSession(sessionId)
    if (runGeneration != null) {
      this.stoppedBySessions.set(sessionId, runGeneration)
    } else if (stopBeforeRun) {
      // 队列启动状态已投影给 renderer 后，run 仍可能卡在预检阶段。
      // 记录这次停止，防止预检完成后错误地创建一个无法终止的新 query。
      this.stoppedBeforeRunSessions.add(sessionId)
    }
    this.queuedMessageUuids.delete(sessionId)
    this.adapter.abort(sessionId)
    console.log(`[Agent 编排] 已中止会话: ${sessionId}`)
  }

  /** 检查指定会话是否正在处理中 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  /** 是否存在任意运行中 Agent（含后台运行与外部触发的会话）。 */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0
  }

  /** 同一个真实本地项目根只能由一个运行中会话执行文件回退。 */
  private hasOtherActiveSessionForLocalProjectRoot(sessionId: string, localProjectRoot: string): boolean {
    for (const activeSessionId of this.activeSessions.keys()) {
      if (activeSessionId === sessionId) continue

      const activeSessionMeta = getAgentSessionMeta(activeSessionId)
      if (!activeSessionMeta?.workspaceId) continue

      const activeWorkspace = getAgentWorkspace(activeSessionMeta.workspaceId)
      if (!activeWorkspace?.projectRootPath) continue

      try {
        if (resolveLocalProjectRootForRewind(activeWorkspace.projectRootPath) === localProjectRoot) {
          return true
        }
      } catch {
        // 运行中的会话已通过启动时校验；若其根后来不可用，无法安全比较，跳过即可。
      }
    }

    return false
  }

  /**
   * 运行中动态切换会话的权限模式
   *
   * 同时更新 Proma 侧（canUseTool 闭包读取的 Map）和 SDK 侧（query.setPermissionMode）。
   * 典型场景：用户在 Agent 运行中通过 PermissionModeSelector 切换模式。
   */
  async updateSessionPermissionMode(sessionId: string, mode: PromaPermissionMode): Promise<void> {
    if (!this.activeSessions.has(sessionId)) return
    this.sessionPermissionModes.set(sessionId, mode)
    this.eventBus.emit(sessionId, {
      kind: 'proma_event',
      event: { type: 'plan_mode_changed', sessionId, active: mode === 'plan', source: 'permission' },
    })
    // 同步通知 SDK 侧
    if (this.adapter.setPermissionMode) {
      await this.adapter.setPermissionMode(sessionId, mode)
    }
    console.log(`[Agent 编排] 运行中权限模式已切换: sessionId=${sessionId}, mode=${mode}`)
  }

  // ===== 快照回退 =====

  /**
   * 回退 Pi 会话到指定消息点。
   *
   * Pi 可安全回退其对话树；文件快照不属于 Pi runtime，因此明确告知用户
   * 当前不会修改工作区文件。退役 Claude 会话仅可查看，不允许回退或继续。
   */
  async rewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionResult> {
    if (this.activeSessions.has(sessionId)) {
      throw new Error('会话正在运行中，请停止后再回退')
    }

    const sessionMeta = getAgentSessionMeta(sessionId)
    if (sessionMeta?.legacyTranscript?.continuationRequired) {
      throw new Error('这是已退役 Claude runtime 的只读历史会话，不能回退；请以 Pi 新会话继续。')
    }
    if (!sessionMeta?.sdkSessionId) {
      throw new Error('会话没有 Pi session ID，无法回退')
    }

    // rewindPiAgentSession 以单一一致性流程处理 Pi branch、JSONL 截断和 metadata 提交。
    const remainingMessages = await rewindPiAgentSession(sessionId, assistantMessageUuid)
    return {
      remainingMessages,
      fileRewind: {
        canRewind: false,
        error: '已回退 Pi 对话；Pi 文件回退尚未启用，当前未修改任何文件。',
      },
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    if (this.activeSessions.size > 0) {
      console.log(`[Agent 编排] 正在中止所有活跃会话 (${this.activeSessions.size} 个)...`)
    }
    // 即便 activeSessions 为空，也要调 dispose 清理可能残留的 pidMap / 子进程
    this.adapter.dispose()
    this.activeSessions.clear()
    this.sessionPermissionModes.clear()
    this.stoppedBeforeRunSessions.clear()
    this.queuedMessageUuids.clear()
    this.pendingUserSkillActivations.clear()
  }

  // ===== 队列消息管理 =====

  /**
   * 流式追加消息
   *
   * 在 Agent 运行中注入用户消息到 SDK，使用 'now' 优先级立即处理。
   * 消息立即持久化到 JSONL。
   *
   * @returns 消息 UUID
   */
  async queueMessage(
    sessionId: string,
    text: string,
    rawText?: string,
    _priority?: string,
    presetUuid?: string,
    opts?: { interrupt?: boolean },
    mentionedSkills?: string[],
    mentionedMcpServers?: string[],
    mentionedSessionIds?: string[],
    mentionedTodoIds?: string[],
    mentionedCalendarEventIds?: string[],
  ): Promise<string> {
    if (!this.activeSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`)
    }

    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    // 注入 mention 引用指令（Skill/MCP/会话）— 与 sendMessage 路径保持一致的 prompt 加工
    const meta = getAgentSessionMeta(sessionId)
    const workspaceSlug = meta?.workspaceId
      ? getAgentWorkspace(meta.workspaceId)?.slug
      : undefined

    const userBrowserContext = browserController.getUserContext(sessionId)
    // 运行中的 Agent 收到队列消息时也必须看到用户刚刚主动打开的页面。
    // 未打开浏览器时保持既有消息形态，避免给每条插队消息重复注入无关环境块。
    let enrichedText = userBrowserContext
      ? `${buildDynamicContext({ userBrowserContext })}\n\n${text}`
      : text
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
    if (referencedSessionsBlock) {
      enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    }
    if (mentionedSkills?.length || mentionedMcpServers?.length) {
      const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
      for (const slug of mentionedSkills ?? []) {
        const qualifiedName = workspaceSlug
          ? `proma-workspace-${workspaceSlug}:${slug}`
          : slug
        toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
      }
      for (const name of mentionedMcpServers ?? []) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      enrichedText = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedText}`
    }
    // Planning read tools are Pi-native. Do not direct Claude sessions to unavailable tools.
    const referencedPlanningBlock = buildReferencedPlanningPrompt(
      mentionedTodoIds,
      mentionedCalendarEventIds,
      { requireToolRead: true },
    )
    if (referencedPlanningBlock) {
      enrichedText = `${referencedPlanningBlock}\n\n${enrichedText}`
    }

    const uuid = presetUuid || randomUUID()

    // 防重记录
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    uuids.add(uuid)
    this.queuedMessageUuids.set(sessionId, uuids)

    // 构造 SDKUserMessage 并注入（强制 'now' 优先级）
    const sdkMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: enrichedText },
      parent_tool_use_id: null,
      priority: 'now' as const,
      uuid,
      session_id: sessionId,
    }

    try {
      // 用户希望"立即打断当前输出并续跑新消息"：interrupt 由 adapter 在消息
      // 入队时统一处理（abort 压制内部 aborted 终态 + prompt chain 续跑新消息）。
      // 例外：会话有挂起的 AskUserQuestion（横幅等待用户点选）时不传 interrupt——
      // 软中断会把挂起的 toolCall 连同后续队列消息一起杀死（stopReason=aborted
      // 清空通道），用户在横幅上提交的回答将无接收方（e2e-v89 实测事故）。
      // 保持排队：用户答完横幅 → turn 正常收尾 → 队列消息在下一 turn 自动消费。
      let shouldInterrupt = !!opts?.interrupt
      if (shouldInterrupt) {
        const hasPendingAskUser = askUserService.getPendingRequests().some((r) => r.sessionId === sessionId)
        if (hasPendingAskUser) {
          shouldInterrupt = false
          console.log(`[Agent 编排] 会话有挂起的用户交互横幅，跳过软中断（消息保持排队，横幅应答后自动消费）: sessionId=${sessionId}`)
        }
      }
      await this.adapter.sendQueuedMessage(sessionId, sdkMessage, {
        ...(shouldInterrupt ? { interrupt: true } : {}),
        ...(mentionedSkills?.length ? { skillMentions: mentionedSkills } : {}),
      })
      console.log(`[Agent 编排] 追加消息已注入: sessionId=${sessionId}, uuid=${uuid}, interrupt=${!!opts?.interrupt}`)

      // 立即持久化到 JSONL — 仅存原始文本，不含 prompt 工程块（与 sendMessage 路径一致）
      const persistMsg: SDKMessage = {
        type: 'user',
        uuid,
        message: {
          content: [{ type: 'text', text: rawText ?? text }],
        },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
      } as unknown as SDKMessage
      appendSDKMessages(sessionId, [persistMsg])
      this.flushPendingUserSkillActivations(sessionId, uuid)
    } catch (error) {
      uuids.delete(uuid)
      this.clearPendingUserSkillActivations(sessionId, uuid)
      if (isMissingActiveQueueChannelError(error)) {
        console.warn(`[Agent 编排] 队列注入失败且消息通道已失效，释放陈旧运行状态: sessionId=${sessionId}`)
        this.activeSessions.delete(sessionId)
        this.sessionPermissionModes.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
      }
      throw error
    }

    return uuid
  }
}
