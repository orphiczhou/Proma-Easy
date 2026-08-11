/**
 * Agent 会话管理 MCP 工具（mcp__session__*）
 *
 * 移植自 proma-patches 项目的 proma-dev-patches.cjs，
 * 复用 proma-source 已有的 agent-session-manager / channel-manager / agent-workspace-manager 函数。
 *
 * 暴露 11 个 Pi custom tools，让 Agent 自主管理会话：
 * 创建/Fork/发消息/查询/归档/列出渠道和工作区。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { PromaPermissionMode, SDKMessage } from '@proma/shared'
import {
  createAgentSession,
  forkAgentSession,
  getAgentSessionMeta,
  getAgentSessionSDKMessages,
  listAgentSessions,
  updateAgentSessionMeta,
} from './agent-session-manager'
import { listChannels, getChannelById } from './channel-manager'
import {
  listAgentWorkspaces,
  getAgentWorkspace,
} from './agent-workspace-manager'
import {
  runRegisteredHeadlessAgent,
} from './agent-headless-runner-registry'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

interface SessionToolsContext {
  sessionId: string
  channelId: string
  workspaceId?: string
}

// ===== 通用辅助 =====

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

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

// ===== 工具构建 =====

export function buildPiSessionTools(sdk: PiSdk, ctx: SessionToolsContext): ToolDefinition[] {
  return [
    // ---- 自指 ----
    sdk.defineTool({
      name: 'mcp__session__get_my_session_id',
      label: '获取当前会话ID',
      description: '获取你自己（当前 Agent）的会话 ID。调用其他 session 工具前应先获取自己的 ID。',
      promptSnippet: 'get_my_session_id: get your own session ID for use with other session tools.',
      parameters: Type.Object({}),
      async execute() {
        return jsonToolResult({
          session_id: ctx.sessionId,
          hint: '这是你的会话 ID，可配合 get_session_context、list_messages 等工具使用。',
        })
      },
    }),

    // ---- 只读：渠道 ----
    sdk.defineTool({
      name: 'mcp__session__list_channels',
      label: '列出渠道',
      description: '列出所有已配置的 AI 渠道及其可用 Agent 模型。创建会话前应先调用此工具了解可用模型。',
      promptSnippet: 'list_channels: list all AI channels and their available agent models.',
      parameters: Type.Object({}),
      async execute() {
        const channels = listChannels()
        return jsonToolResult({
          channels: channels.map((c) => ({
            id: c.id,
            name: c.name,
            provider: c.provider,
            enabled: !!c.enabled,
            agent_models: (c.models ?? []).filter((m) => m.enabled !== false).map((m) => ({
              id: m.id,
              name: m.name,
            })),
          })),
        })
      },
    }),

    // ---- 只读：工作区 ----
    sdk.defineTool({
      name: 'mcp__session__list_workspaces',
      label: '列出工作区',
      description: '列出所有 Agent 工作区（id/name/slug）。',
      promptSnippet: 'list_workspaces: list all agent workspaces.',
      parameters: Type.Object({}),
      async execute() {
        const workspaces = listAgentWorkspaces()
        return jsonToolResult({
          workspaces: workspaces.map((w) => ({
            id: w.id,
            name: w.name,
            slug: w.slug,
            created_at: w.createdAt,
            updated_at: w.updatedAt,
          })),
        })
      },
    }),

    // ---- 只读：会话列表 ----
    sdk.defineTool({
      name: 'mcp__session__list_sessions',
      label: '列出会话',
      description: '列出 Agent 会话列表，支持按工作区过滤。返回 id/title/channel_id/model_id/workspace_id 等元信息。',
      promptSnippet: 'list_sessions: list agent sessions with optional workspace filter.',
      parameters: Type.Object({
        include_archived: Type.Optional(Type.Boolean({ description: '是否包含已归档会话，默认 false' })),
        workspace_id: Type.Optional(Type.String({ description: '按工作区 ID 过滤' })),
        limit: Type.Optional(Type.Number({ description: '返回上限，默认 50，最大 200' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { include_archived?: boolean; workspace_id?: string; limit?: number }
        let all = listAgentSessions()
        if (!args.include_archived) all = all.filter((s) => !s.archived)
        if (args.workspace_id) all = all.filter((s) => s.workspaceId === args.workspace_id)
        const limit = Math.min(args.limit ?? 50, 200)
        const limited = all.slice(0, limit)

        const wsNames: Record<string, string> = {}
        try {
          for (const ws of listAgentWorkspaces()) wsNames[ws.id] = ws.name
        } catch { /* best-effort */ }

        return jsonToolResult({
          count: limited.length,
          total: all.length,
          sessions: limited.map((s) => ({
            id: s.id,
            title: s.title,
            channel_id: s.channelId,
            model_id: s.modelId,
            workspace_id: s.workspaceId,
            workspace_name: wsNames[s.workspaceId ?? ''] ?? null,
            pinned: !!s.pinned,
            archived: !!s.archived,
            permission_mode: s.permissionMode,
            created_at: s.createdAt,
            updated_at: s.updatedAt,
          })),
        })
      },
    }),

    // ---- 只读：会话详情 ----
    sdk.defineTool({
      name: 'mcp__session__get_session_info',
      label: '查询会话详情',
      description: '查询单个会话的详细元信息（渠道、模型、工作区、附件等）。',
      promptSnippet: 'get_session_info: get detailed info about a specific session.',
      parameters: Type.Object({
        session_id: Type.String({ description: '目标会话 ID' }),
      }),
      async execute(_toolCallId, params) {
        const { session_id } = params as { session_id: string }
        const meta = getAgentSessionMeta(session_id)
        if (!meta) return jsonToolResult({ error: `Session not found: ${session_id}` })

        let channelInfo: { id: string; name: string; provider: string } | null = null
        if (meta.channelId) {
          const ch = getChannelById(meta.channelId)
          if (ch) channelInfo = { id: ch.id, name: ch.name, provider: ch.provider }
        }

        let workspaceInfo: { id: string; name: string; slug: string } | null = null
        if (meta.workspaceId) {
          const ws = getAgentWorkspace(meta.workspaceId)
          if (ws) workspaceInfo = { id: ws.id, name: ws.name, slug: ws.slug }
        }

        return jsonToolResult({
          id: meta.id,
          title: meta.title,
          channel_id: meta.channelId,
          model_id: meta.modelId,
          channel: channelInfo,
          workspace: workspaceInfo,
          pinned: !!meta.pinned,
          archived: !!meta.archived,
          permission_mode: meta.permissionMode,
          attached_directories: meta.attachedDirectories ?? [],
          attached_files: meta.attachedFiles ?? [],
          created_at: meta.createdAt,
          updated_at: meta.updatedAt,
        })
      },
    }),

    // ---- 只读：上下文用量 ----
    sdk.defineTool({
      name: 'mcp__session__get_session_context',
      label: '查询上下文用量',
      description: '查询会话的 token 用量和上下文窗口使用率。用于判断是否接近甜点区上限。',
      promptSnippet: 'get_session_context: check token usage and context window percentage.',
      parameters: Type.Object({
        session_id: Type.String({ description: '目标会话 ID' }),
      }),
      async execute(_toolCallId, params) {
        const { session_id } = params as { session_id: string }
        const meta = getAgentSessionMeta(session_id)
        if (!meta) return jsonToolResult({ error: `Session not found: ${session_id}` })

        let configContextWindow: number | null = null
        let configModelName: string | null = null
        if (meta.channelId && meta.modelId) {
          try {
            const ch = getChannelById(meta.channelId)
            const cm = ch?.models?.find((m) => m.id === meta.modelId)
            if (cm) {
              configModelName = cm.name ?? meta.modelId
              // ChannelModel 不含 contextWindow；留空，SDK result 中的 modelUsage 会提供
            }
          } catch { /* best-effort */ }
        }

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

        if (!contextWindow) contextWindow = configContextWindow
        if (!lastModel) lastModel = configModelName ?? meta.modelId ?? null

        if (!usage) {
          return jsonToolResult({
            session_id,
            title: meta.title,
            model: lastModel,
            context_window: contextWindow,
            message: 'No usage data yet. Send a message and wait for it to complete.',
          })
        }

        const input = usage.input_tokens ?? 0
        const output = usage.output_tokens ?? 0
        const cache = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        const pct = contextWindow ? ((input + output + cache) / contextWindow * 100).toFixed(1) + '%' : null

        return jsonToolResult({
          session_id,
          title: meta.title,
          model: lastModel,
          context_window: contextWindow,
          usage: { input_tokens: input, output_tokens: output, cache_tokens: cache, total: input + output + cache, usage_pct: pct },
        })
      },
    }),

    // ---- 只读：消息列表 ----
    sdk.defineTool({
      name: 'mcp__session__list_messages',
      label: '列出消息',
      description: '列出会话消息历史（含 UUID/角色/文本/usage），支持分页。Fork 时需用 UUID 做精确截断。',
      promptSnippet: 'list_messages: list session messages with pagination and UUIDs.',
      parameters: Type.Object({
        session_id: Type.String({ description: '目标会话 ID' }),
        offset: Type.Optional(Type.Number({ description: '起始偏移，默认 0' })),
        limit: Type.Optional(Type.Number({ description: '返回上限，默认 50，最大 200' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { session_id: string; offset?: number; limit?: number }
        const meta = getAgentSessionMeta(args.session_id)
        if (!meta) return jsonToolResult({ error: `Session not found: ${args.session_id}` })

        try {
          const msgs = getAgentSessionSDKMessages(args.session_id)
          if (!msgs.length) return jsonToolResult({ session_id: args.session_id, messages: [], count: 0, total: 0 })

          const offset = args.offset ?? 0
          const limit = Math.min(args.limit ?? 50, 200)
          const slice = msgs.slice(offset, offset + limit)

          const result = slice.map((m, i) => {
            const msg = m as Record<string, unknown>
            const entry: Record<string, unknown> = {
              index: offset + i,
              type: msg.type,
              uuid: msg.uuid ?? null,
              role: (msg.message as Record<string, unknown>)?.role ?? null,
            }
            // 提取文本摘要
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
            // result 类型附带 usage
            if (msg.type === 'result' && msg.usage) {
              entry.usage = msg.usage
            }
            return entry
          })

          return jsonToolResult({ session_id: args.session_id, count: result.length, total: msgs.length, offset, messages: result })
        } catch (e) {
          return jsonToolResult({ error: `读取消息失败: ${e instanceof Error ? e.message : String(e)}` })
        }
      },
    }),

    // ---- 写入：创建会话 ----
    sdk.defineTool({
      name: 'mcp__session__create_session',
      label: '创建会话',
      description: '创建新的 Agent 会话，指定渠道/模型/标题/工作区。用于并行调度多个子会话。',
      promptSnippet: 'create_session: create a new agent session with specified channel/model/workspace.',
      parameters: Type.Object({
        channel_id: Type.String({ description: '渠道 ID（必填）。先用 list_channels 查看' }),
        model_id: Type.Optional(Type.String({ description: '模型 ID。省略时用渠道默认模型' })),
        title: Type.Optional(Type.String({ description: '会话标题' })),
        workspace_id: Type.Optional(Type.String({ description: '工作区 ID。省略时不绑定工作区' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { channel_id: string; model_id?: string; title?: string; workspace_id?: string }
        const meta = createAgentSession(args.title, args.channel_id, args.workspace_id, args.model_id)
        return jsonToolResult({
          session: {
            id: meta.id,
            title: meta.title,
            channel_id: meta.channelId,
            model_id: meta.modelId,
            workspace_id: meta.workspaceId,
            created_at: meta.createdAt,
          },
          message: `会话 "${meta.title}" 已创建。使用 send_message 向其发送任务。`,
        })
      },
    }),

    // ---- 写入：Fork 会话 ----
    sdk.defineTool({
      name: 'mcp__session__fork_session',
      label: 'Fork 会话',
      description: 'Fork 一个已有会话，保留对话上下文。支持 up_to_message_uuid 精确截断。用于从检查点分支探索。',
      promptSnippet: 'fork_session: fork a session, optionally truncating at a specific message UUID.',
      parameters: Type.Object({
        source_session_id: Type.String({ description: '源会话 ID' }),
        up_to_message_uuid: Type.Optional(Type.String({ description: '截断点的消息 UUID（inclusive）。省略时复制全部历史' })),
        title: Type.Optional(Type.String({ description: '新会话标题' })),
        model_id: Type.Optional(Type.String({ description: '目标模型 ID。省略时继承源会话' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { source_session_id: string; up_to_message_uuid?: string; title?: string; model_id?: string }
        try {
          const meta = await forkAgentSession({
            sessionId: args.source_session_id,
            upToMessageUuid: args.up_to_message_uuid,
            modelId: args.model_id,
          })
          if (args.title) {
            updateAgentSessionMeta(meta.id, { title: args.title })
            meta.title = args.title
          }
          return jsonToolResult({
            session: {
              id: meta.id,
              title: meta.title,
              channel_id: meta.channelId,
              model_id: meta.modelId,
              workspace_id: meta.workspaceId,
              source_session_id: args.source_session_id,
              created_at: meta.createdAt,
            },
            message: `会话 "${meta.title}" 已 Fork。使用 send_message 向其发送任务。`,
          })
        } catch (e) {
          return jsonToolResult({ error: `Fork 失败: ${e instanceof Error ? e.message : String(e)}` })
        }
      },
    }),

    // ---- 写入：发消息 ----
    sdk.defineTool({
      name: 'mcp__session__send_message',
      label: '发送消息',
      description: '向目标会话发送用户消息。wait=true（默认）阻塞等待 Agent 输出并返回 reply；wait=false 立即返回。',
      promptSnippet: 'send_message: send a message to a target session. wait=true returns the agent reply.',
      parameters: Type.Object({
        session_id: Type.String({ description: '目标会话 ID' }),
        message: Type.String({ description: '发送的消息内容' }),
        wait: Type.Optional(Type.Boolean({ description: '是否等待 Agent 完成，默认 true' })),
        model_id: Type.Optional(Type.String({ description: '覆盖模型 ID' })),
        channel_id: Type.Optional(Type.String({ description: '覆盖渠道 ID' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { session_id: string; message: string; wait?: boolean; model_id?: string; channel_id?: string }
        const meta = getAgentSessionMeta(args.session_id)
        if (!meta) return jsonToolResult({ error: `Session not found: "${args.session_id}".` })

        const channelId = args.channel_id ?? meta.channelId
        if (!channelId) return jsonToolResult({ error: 'No channel available for this session.' })
        const modelId = args.model_id ?? meta.modelId
        const shouldWait = args.wait !== false

        try {
          await runRegisteredHeadlessAgent(
            {
              sessionId: args.session_id,
              userMessage: args.message,
              channelId,
              modelId,
              workspaceId: meta.workspaceId,
              permissionModeOverride: 'bypassPermissions' as PromaPermissionMode,
              startedAt: Date.now(),
            },
            {
              source: 'delegation',
              originSessionId: ctx.sessionId,
              onError: () => {},
              onComplete: () => {},
              onTitleUpdated: () => {},
            },
          )
        } catch (e) {
          return jsonToolResult({ session_id: args.session_id, status: 'error', error: e instanceof Error ? e.message : String(e) })
        }

        if (!shouldWait) {
          return jsonToolResult({ session_id: args.session_id, status: 'started', message: '消息已发送，Agent 异步处理中。' })
        }

        // 提取 Agent 回复
        const sdkMessages = getAgentSessionSDKMessages(args.session_id)
        const reply = extractLastAssistantText(sdkMessages)
        return jsonToolResult({
          session_id: args.session_id,
          status: 'completed',
          reply: reply ?? '(无文本输出)',
          message: reply ? undefined : 'Agent 已完成，但未找到文本输出。请用 list_messages 查看完整记录。',
        })
      },
    }),

    // ---- 写入：归档 ----
    sdk.defineTool({
      name: 'mcp__session__archive_session',
      label: '归档会话',
      description: '归档或取消归档会话。归档后会话从默认列表中隐藏。',
      promptSnippet: 'archive_session: archive or unarchive a session.',
      parameters: Type.Object({
        session_id: Type.String({ description: '目标会话 ID' }),
        archived: Type.Optional(Type.Boolean({ description: 'true=归档，false=取消归档，默认 true' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { session_id: string; archived?: boolean }
        const meta = getAgentSessionMeta(args.session_id)
        if (!meta) return jsonToolResult({ error: `Session not found: ${args.session_id}` })
        const archived = args.archived ?? true
        updateAgentSessionMeta(args.session_id, { archived })
        return jsonToolResult({ session_id: args.session_id, title: meta.title, archived })
      },
    }),
  ]
}
