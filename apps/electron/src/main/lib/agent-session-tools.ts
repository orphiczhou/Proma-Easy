/**
 * Agent 会话管理 MCP 工具（mcp__session__*）
 *
 * 蓝图 proma_agent_next_steps_guide1 §5.1（M1-3）：业务逻辑统一在 session-tool-handlers.ts，
 * 本文件只保留工具 schema（Type.Object 参数、名称、描述）与 jsonToolResult 包装。
 * fork_session 支持统一参数（new_channel_id / new_workspace_id 经 updateAgentSessionMeta 写入）。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { createSessionToolHandlers } from './session-tool-handlers'

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

// ===== 工具构建 =====

export function buildPiSessionTools(sdk: PiSdk, ctx: SessionToolsContext): ToolDefinition[] {
  const handlers = createSessionToolHandlers({ callerSessionId: ctx.sessionId })
  return [
    // ---- 自指 ----
    sdk.defineTool({
      name: 'mcp__session__get_my_session_id',
      label: '获取当前会话ID',
      description: '获取你自己（当前 Agent）的会话 ID。调用其他 session 工具前应先获取自己的 ID。',
      promptSnippet: 'get_my_session_id: get your own session ID for use with other session tools.',
      parameters: Type.Object({}),
      async execute() {
        return jsonToolResult(await handlers.get_my_session_id())
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
        return jsonToolResult(await handlers.list_channels())
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
        return jsonToolResult(await handlers.list_workspaces())
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
        return jsonToolResult(await handlers.list_sessions(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.get_session_info(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.get_session_context(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.list_messages(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.create_session(params as Record<string, unknown>))
      },
    }),

    // ---- 写入：Fork 会话 ----
    sdk.defineTool({
      name: 'mcp__session__fork_session',
      label: 'Fork 会话',
      description: 'Fork 一个已有会话，保留对话上下文。支持 up_to_message_uuid 精确截断与 channel/model/workspace 换绑。用于从检查点分支探索。',
      promptSnippet: 'fork_session: fork a session, optionally truncating at a specific message UUID.',
      parameters: Type.Object({
        source_session_id: Type.String({ description: '源会话 ID' }),
        up_to_message_uuid: Type.Optional(Type.String({ description: '截断点的消息 UUID（inclusive）。省略时复制全部历史' })),
        title: Type.Optional(Type.String({ description: '新会话标题' })),
        model_id: Type.Optional(Type.String({ description: '目标模型 ID。省略时继承源会话' })),
        new_model_id: Type.Optional(Type.String({ description: '同 model_id（兼容拼写）' })),
        channel_id: Type.Optional(Type.String({ description: 'Fork 后绑定渠道 ID' })),
        new_channel_id: Type.Optional(Type.String({ description: '同 channel_id（兼容拼写）' })),
        workspace_id: Type.Optional(Type.String({ description: 'Fork 后绑定工作区 ID' })),
        new_workspace_id: Type.Optional(Type.String({ description: '同 workspace_id（兼容拼写）' })),
      }),
      async execute(_toolCallId, params) {
        return jsonToolResult(await handlers.fork_session(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.send_message(params as Record<string, unknown>))
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
        return jsonToolResult(await handlers.archive_session(params as Record<string, unknown>))
      },
    }),
  ]
}
