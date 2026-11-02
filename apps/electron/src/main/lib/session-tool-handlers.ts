/**
 * 统一会话工具处理器（session-tool-handlers）
 *
 * 蓝图 proma_agent_next_steps_guide1 §5.1（M1-3）：消除 agent-session-tools.ts（进程内
 * Pi Tools）与 agent-mcp-bridge.ts（外部 HTTP Bridge）对同一批会话管理操作的重复实现。
 *
 * 本模块只承载业务逻辑与 payload 形态；调用方各自保留：
 * - Pi 工具：Type.Object 参数 schema、工具名（mcp__session__*）、jsonToolResult 包装；
 * - HTTP Bridge：URL 路由、CORS、实例发现（鉴权加固按台账 2026-11-02 裁决暂缓）。
 *
 * payload 兼容性约定：对外（bridge）输出与历史格式逐键一致；内部形态更丰富时以内部为准，
 * 可选键允许 undefined（JSON.stringify 序列化时自动剔除，不改变 wire 格式）。
 */

import {
  createAgentSession,
  forkAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  listAgentSessions,
  updateAgentSessionMeta,
} from './agent-session-manager'
import { listChannels, getChannelById } from './channel-manager'
import { listAgentWorkspaces, getAgentWorkspace } from './agent-workspace-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from './agent-headless-runner-registry'
import { isAgentSessionActive, abortAgentPendingCapabilities } from './agent-service'
import type { PromaPermissionMode, SDKMessage } from '@proma/shared'

export type SessionToolArgs = Record<string, unknown>

export interface SessionToolContext {
  /** 进程内 Pi 工具调用的当前会话 ID；外部 Bridge 调用不传 */
  callerSessionId?: string
  /** 外部 HTTP Bridge 调用（get_my_session_id 返回 is_external=true / session_id=null） */
  isExternal?: boolean
}

export type SessionToolHandler = (args: SessionToolArgs) => Promise<Record<string, unknown>>

// ===== 共享辅助 =====

// 从 SDK 消息中提取最后一条 assistant 文本
function extractLastAssistantText(sdkMessages: SDKMessage[]): string | undefined {
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i] as unknown as Record<string, unknown>
    if (msg.type !== 'assistant') continue
    const outer = msg.message as Record<string, unknown> | undefined
    if (!outer || typeof outer !== 'object') continue
    const content = outer.content
    if (!Array.isArray(content)) continue
    const texts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
    }
    const joined = texts.join('\n\n').trim()
    if (joined) return joined
  }
  return undefined
}

// 从 SDK 消息中提取 usage 信息
function extractUsage(sdkMessages: SDKMessage[]): {
  usage: Record<string, number> | null
  lastModel: string | null
  contextWindow: number | null
} {
  for (let i = sdkMessages.length - 1; i >= 0; i--) {
    const msg = sdkMessages[i] as unknown as Record<string, unknown>
    if (msg.type !== 'result') continue
    const usage = (msg.usage ?? null) as Record<string, number> | null
    let lastModel: string | null = null
    let contextWindow: number | null = null
    const mu = msg.modelUsage as Record<string, unknown> | undefined
    if (mu) {
      const keys = Object.keys(mu)
      if (keys.length > 0) {
        const k = keys[0]
        if (k) {
          lastModel = k
          const entry = mu[k] as Record<string, unknown> | undefined
          contextWindow = (entry?.contextWindow as number) ?? null
        }
      }
    }
    return { usage, lastModel, contextWindow }
  }
  return { usage: null, lastModel: null, contextWindow: null }
}

// ===== 统一 handler 集 =====

export function createSessionToolHandlers(ctx: SessionToolContext = {}) {
  const handlers = {
    get_my_session_id: async () => {
      if (ctx.isExternal) {
        return {
          session_id: null,
          is_external: true,
          hint: 'No session ID available (external MCP caller).',
        }
      }
      return {
        session_id: ctx.callerSessionId ?? null,
        hint: '这是你的会话 ID，可配合 get_session_context、list_messages 等工具使用。',
      }
    },

    list_channels: async () => {
      const channels = listChannels()
      return {
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          enabled: !!c.enabled,
          agent_models: (c.models ?? []).filter((m) => m.enabled !== false).map((m) => ({ id: m.id, name: m.name })),
        })),
      }
    },

    list_workspaces: async () => {
      const workspaces = listAgentWorkspaces()
      return {
        workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, slug: w.slug, created_at: w.createdAt, updated_at: w.updatedAt })),
      }
    },

    list_sessions: async (args: SessionToolArgs) => {
      let all = listAgentSessions()
      if (!args.include_archived) all = all.filter((s) => !s.archived)
      if (args.workspace_id) all = all.filter((s) => s.workspaceId === args.workspace_id)
      const limit = Math.min((args.limit as number) ?? 50, 200)
      const limited = all.slice(0, limit)
      const wsNames: Record<string, string> = {}
      try { for (const ws of listAgentWorkspaces()) wsNames[ws.id] = ws.name } catch { /* best-effort */ }
      return {
        count: limited.length,
        total: all.length,
        sessions: limited.map((s) => ({
          id: s.id, title: s.title, channel_id: s.channelId, model_id: s.modelId,
          workspace_id: s.workspaceId, workspace_name: wsNames[s.workspaceId ?? ''] ?? null,
          pinned: !!s.pinned, archived: !!s.archived, permission_mode: s.permissionMode,
          created_at: s.createdAt, updated_at: s.updatedAt,
        })),
      }
    },

    get_session_info: async (args: SessionToolArgs) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: ${args.session_id}` }
      let channelInfo: Record<string, string> | null = null
      if (meta.channelId) {
        const ch = getChannelById(meta.channelId)
        if (ch) channelInfo = { id: ch.id, name: ch.name, provider: ch.provider }
      }
      let workspaceInfo: Record<string, string> | null = null
      if (meta.workspaceId) {
        const ws = getAgentWorkspace(meta.workspaceId)
        if (ws) workspaceInfo = { id: ws.id, name: ws.name, slug: ws.slug }
      }
      return {
        id: meta.id, title: meta.title, channel_id: meta.channelId, model_id: meta.modelId,
        channel: channelInfo, workspace: workspaceInfo, pinned: !!meta.pinned,
        archived: !!meta.archived, permission_mode: meta.permissionMode,
        attached_directories: meta.attachedDirectories ?? [], attached_files: meta.attachedFiles ?? [],
        created_at: meta.createdAt, updated_at: meta.updatedAt,
      }
    },

    get_session_context: async (args: SessionToolArgs) => {
      const session_id = args.session_id as string
      const meta = getAgentSessionMeta(session_id)
      if (!meta) return { error: `Session not found: ${session_id}` }

      let usage: Record<string, number> | null = null
      let lastModel: string | null = null
      let contextWindow: number | null = null
      try {
        const msgs = getAgentSessionSDKMessages(session_id)
        if (msgs.length > 0) {
          const extracted = extractUsage(msgs)
          usage = extracted.usage
          lastModel = extracted.lastModel
          contextWindow = extracted.contextWindow
        }
      } catch { /* best-effort */ }

      if (!lastModel) lastModel = meta.modelId ?? null

      if (!usage) {
        return {
          session_id, title: meta.title, model: lastModel, context_window: contextWindow,
          message: 'No usage data yet. Send a message and wait for it to complete.',
        }
      }
      const input = usage.input_tokens ?? 0
      const output = usage.output_tokens ?? 0
      const cache = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      const pct = contextWindow ? ((input + output + cache) / contextWindow * 100).toFixed(1) + '%' : null
      return {
        session_id, title: meta.title, model: lastModel, context_window: contextWindow,
        usage: { input_tokens: input, output_tokens: output, cache_tokens: cache, total: input + output + cache, usage_pct: pct },
      }
    },

    list_messages: async (args: SessionToolArgs) => {
      const session_id = args.session_id as string
      const meta = getAgentSessionMeta(session_id)
      if (!meta) return { error: `Session not found: ${session_id}` }
      try {
        const msgs = getAgentSessionSDKMessages(session_id)
        if (!msgs.length) return { session_id, messages: [], count: 0, total: 0 }
        const offset = (args.offset as number) ?? 0
        const limit = Math.min((args.limit as number) ?? 50, 200)
        const slice = msgs.slice(offset, offset + limit)
        const result = slice.map((m, i) => {
          const msg = m as unknown as Record<string, unknown>
          const entry: Record<string, unknown> = {
            index: offset + i, type: msg.type, uuid: msg.uuid ?? null,
            role: (msg.message as Record<string, unknown>)?.role ?? null,
          }
          const content = (msg.message as Record<string, unknown>)?.content
          if (Array.isArray(content)) {
            const texts: string[] = []
            for (const block of content) {
              if (!block || typeof block !== 'object') continue
              const b = block as Record<string, unknown>
              if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
            }
            const fullText = texts.join('\n\n')
            entry.text = fullText.length > 500 ? fullText.slice(0, 500) + '...' : fullText
            entry.text_full_length = fullText.length
          }
          if (msg.type === 'result' && msg.usage) entry.usage = msg.usage
          return entry
        })
        return { session_id, count: result.length, total: msgs.length, offset, messages: result }
      } catch (e) { return { error: `读取消息失败: ${e instanceof Error ? e.message : String(e)}` } }
    },

    create_session: async (args: SessionToolArgs) => {
      const meta = createAgentSession(args.title as string | undefined, args.channel_id as string, args.workspace_id as string | undefined, args.model_id as string | undefined)
      return {
        session: {
          id: meta.id, title: meta.title, channel_id: meta.channelId, model_id: meta.modelId,
          workspace_id: meta.workspaceId, created_at: meta.createdAt,
        },
        message: `会话 "${meta.title}" 已创建。使用 send_message 向其发送任务。`,
      }
    },

    fork_session: async (args: SessionToolArgs) => {
      try {
        // 蓝图 M1-3 统一参数：model_id 与 new_model_id 等价（兼容两种拼写）；
        // new_channel_id/new_workspace_id 在 fork 后经 updateAgentSessionMeta 显式写入。
        const meta = await forkAgentSession({
          sessionId: args.source_session_id as string,
          upToMessageUuid: args.up_to_message_uuid as string | undefined,
          modelId: (args.new_model_id ?? args.model_id) as string | undefined,
        })
        const patchedChannel = (args.new_channel_id ?? args.channel_id) as string | undefined
        const patchedWorkspace = (args.new_workspace_id ?? args.workspace_id) as string | undefined
        const title = args.title as string | undefined
        if (title || patchedChannel || patchedWorkspace) {
          const updated = updateAgentSessionMeta(meta.id, {
            ...(title ? { title } : {}),
            ...(patchedChannel ? { channelId: patchedChannel } : {}),
            ...(patchedWorkspace ? { workspaceId: patchedWorkspace } : {}),
          })
          Object.assign(meta, updated)
        }
        return {
          session: {
            id: meta.id, title: meta.title, channel_id: meta.channelId, model_id: meta.modelId,
            workspace_id: meta.workspaceId, source_session_id: args.source_session_id,
            created_at: meta.createdAt,
          },
          message: `会话 "${meta.title}" 已 Fork。使用 send_message 向其发送任务。`,
        }
      } catch (e) { return { error: `Fork 失败: ${e instanceof Error ? e.message : String(e)}` } }
    },

    send_message: async (args: SessionToolArgs) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: "${args.session_id}".` }
      const channelId = (args.channel_id as string) ?? meta.channelId
      if (!channelId) return { error: 'No channel available for this session.' }
      const modelId = (args.model_id as string) ?? meta.modelId
      const shouldWait = args.wait !== false
      try {
        await runRegisteredHeadlessAgent(
          {
            sessionId: args.session_id as string,
            userMessage: args.message as string,
            channelId,
            modelId,
            workspaceId: meta.workspaceId,
            permissionModeOverride: 'bypassPermissions' as PromaPermissionMode,
            startedAt: Date.now(),
            // v2.4（D7 §1 I1-②a）：工具/Bridge 注入均非真 UI 人类输入，显式置 false——
            // 南大推进门不认注入的确认词（R4-01 攻击面封堵）
            humanOrigin: false,
          },
          {
            source: 'delegation',
            ...(ctx.callerSessionId ? { originSessionId: ctx.callerSessionId } : {}),
            onError: () => {},
            onComplete: () => {},
            onTitleUpdated: () => {},
          },
        )
      } catch (e) {
        return { session_id: args.session_id, status: 'error', error: e instanceof Error ? e.message : String(e) }
      }
      if (!shouldWait) return { session_id: args.session_id, status: 'started', message: '消息已发送，Agent 异步处理中。' }
      const sdkMessages = getAgentSessionSDKMessages(args.session_id as string)
      const reply = extractLastAssistantText(sdkMessages)
      return {
        session_id: args.session_id,
        status: 'completed',
        reply: reply ?? '(无文本输出)',
        message: reply ? undefined : 'Agent 已完成，但未找到文本输出。请用 list_messages 查看完整记录。',
      }
    },

    archive_session: async (args: SessionToolArgs) => {
      const session_id = args.session_id as string
      const meta = getAgentSessionMeta(session_id)
      if (!meta) return { error: `Session not found: ${session_id}` }
      const archived = args.archived ?? true
      updateAgentSessionMeta(session_id, { archived: !!archived })
      return { session_id, title: meta.title, archived }
    },

    // P0-B Phase2：终止运行中的 run（含挂起的 AskUser 等交互），供远端救援挂起会话。
    abort_session: async (args: SessionToolArgs) => {
      const sessionId = args.session_id as string
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) return { error: `Session not found: ${sessionId}` }
      const wasActive = isAgentSessionActive(sessionId)
      if (wasActive) stopRegisteredAgent(sessionId)
      // QUERY_ABORT 往返不可达（utility 失联）时 query 终结清理不执行，这里确定性清空。
      abortAgentPendingCapabilities(sessionId)
      return {
        session_id: sessionId,
        title: meta.title,
        was_active: wasActive,
        status: 'aborted',
        message: wasActive
          ? '已请求中止运行中的 run，pending 交互已清理。'
          : '会话当前无运行中 run，pending 交互已清理。',
      }
    },
  }
  return handlers
}
