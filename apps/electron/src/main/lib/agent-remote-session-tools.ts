/**
 * Agent 远程会话管理 MCP 工具（mcp__remote-session__*）
 *
 * 移植自 proma-patches 项目的 remote-session MCP server。
 * 让 Agent 像操作本实例一样操作远端 Proma 实例，
 * 通过 HTTP bridge 调用远端实例的同构 session API。
 *
 * 同时提供实例发现功能（扫描 localhost HTTP bridge 端口）。
 */

import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import * as http from 'node:http'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

// ===== 常量 =====

/** HTTP bridge 端口扫描范围（与 proma-patches 约定一致） */
const PORT_START = 19876
const PORT_END = 19895
const CONNECT_TIMEOUT_MS = 2000
const CALL_TIMEOUT_MS = 600_000 // 10 分钟

// 实例发现缓存（60 秒）
interface InstanceInfo {
  port: number
  instance: string
  isIsolated: boolean
}
let discoveryCache: { instances: InstanceInfo[]; ts: number } | null = null
const DISCOVERY_CACHE_TTL_MS = 60_000

// ===== 通用辅助 =====

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

function getInstanceInfo(port: number): Promise<InstanceInfo | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/get_instance_info', method: 'GET', timeout: CONNECT_TIMEOUT_MS },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            const info = JSON.parse(data)
            resolve({
              port,
              instance: info.instance ?? (info.proma_dev ? 'dev' : 'release'),
              isIsolated: !!info.proma_dev || !!info.is_isolated,
            })
          } catch {
            resolve(null)
          }
        })
      },
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

async function discoverInstances(force = false): Promise<InstanceInfo[]> {
  if (!force && discoveryCache && Date.now() - discoveryCache.ts < DISCOVERY_CACHE_TTL_MS) {
    return discoveryCache.instances
  }

  const instances: InstanceInfo[] = []
  for (let port = PORT_START; port <= PORT_END; port++) {
    const info = await getInstanceInfo(port)
    if (info) instances.push(info)
  }

  discoveryCache = { instances, ts: Date.now() }
  return instances
}

async function findPortByInstance(instance: string): Promise<number | null> {
  const instances = await discoverInstances()
  const match = instances.find((i) => i.instance === instance)
  return match?.port ?? null
}

function callRemoteTool(port: number, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(args)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/' + toolName,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            resolve({ error: `远端返回无效 JSON: ${data.slice(0, 200)}` })
          }
        })
      },
    )
    req.on('error', (e) => reject(new Error(`无法连接远端实例 (${e.message})。实例是否在运行？`)))
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（10 分钟）')) })
    req.write(body)
    req.end()
  })
}

// ===== 工具构建 =====

export function buildPiRemoteSessionTools(sdk: PiSdk): ToolDefinition[] {
  return [
    // ---- 实例发现 ----
    sdk.defineTool({
      name: 'mcp__remote-session__discover_instances',
      label: '发现实例',
      description: '扫描 localhost 端口，发现运行中的 Proma 实例。返回实例名/端口/隔离状态。',
      promptSnippet: 'remote_discover_instances: find running Proma instances on localhost.',
      parameters: Type.Object({
        refresh: Type.Optional(Type.Boolean({ description: '强制重新扫描（默认 false，用 60s 缓存）' })),
      }),
      async execute(_toolCallId, params) {
        const { refresh } = params as { refresh?: boolean }
        const instances = await discoverInstances(refresh ?? false)
        return jsonToolResult({
          count: instances.length,
          instances: instances.map((i) => ({
            instance: i.instance,
            port: i.port,
            is_isolated: i.isIsolated,
          })),
        })
      },
    }),

    // ---- 只读工具（镜像 session 组，每个多一个 instance 参数）----
    sdk.defineTool({
      name: 'mcp__remote-session__remote_list_channels',
      label: '远端列出渠道',
      description: '列出远端 Proma 实例的渠道。操作远端实例前应先发现实例并列出渠道。',
      promptSnippet: 'remote_list_channels: list channels on a remote Proma instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名（如 dev, release）' }),
      }),
      async execute(_toolCallId, params) {
        const { instance } = params as { instance: string }
        const port = await findPortByInstance(instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${instance}"。先调用 remote_discover_instances 查看可用实例。` })
        return jsonToolResult(await callRemoteTool(port, 'list_channels', {}))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_list_workspaces',
      label: '远端列出工作区',
      description: '列出远端 Proma 实例的工作区。',
      promptSnippet: 'remote_list_workspaces: list workspaces on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
      }),
      async execute(_toolCallId, params) {
        const { instance } = params as { instance: string }
        const port = await findPortByInstance(instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'list_workspaces', {}))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_list_sessions',
      label: '远端列出会话',
      description: '列出远端 Proma 实例的会话，支持工作区过滤。',
      promptSnippet: 'remote_list_sessions: list sessions on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        include_archived: Type.Optional(Type.Boolean()),
        workspace_id: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; include_archived?: boolean; workspace_id?: string; limit?: number }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'list_sessions', {
          include_archived: args.include_archived,
          workspace_id: args.workspace_id,
          limit: args.limit,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_get_session_info',
      label: '远端查询会话详情',
      description: '查询远端实例上某个会话的详情。',
      promptSnippet: 'remote_get_session_info: get session info from a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        session_id: Type.String({ description: '远端会话 ID' }),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; session_id: string }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'get_session_info', { session_id: args.session_id }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_get_session_context',
      label: '远端查询上下文用量',
      description: '查询远端实例上某个会话的 token 用量。',
      promptSnippet: 'remote_get_session_context: check token usage on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        session_id: Type.String({ description: '远端会话 ID' }),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; session_id: string }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'get_session_context', { session_id: args.session_id }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_list_messages',
      label: '远端列出消息',
      description: '列出远端实例上某个会话的消息历史。',
      promptSnippet: 'remote_list_messages: list messages from a remote session.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        session_id: Type.String({ description: '远端会话 ID' }),
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; session_id: string; limit?: number; offset?: number }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'list_messages', {
          session_id: args.session_id,
          limit: args.limit,
          offset: args.offset,
        }))
      },
    }),

    // ---- 写入工具 ----
    sdk.defineTool({
      name: 'mcp__remote-session__remote_create_session',
      label: '创建会话（本实例/远端）',
      description: '创建一个一级会话（与调度员并列，非子会话）。instance=release 调用本实例。指定 workspace_id 让会话出现在同一工作区侧边栏。跨渠道跨模型。',
      promptSnippet: 'remote_create_session: create a top-level session (local or remote).',
      parameters: Type.Object({
        instance: Type.String({ description: '实例名。本实例用 "release"。' }),
        channel_id: Type.String({ description: '渠道 ID（如 deepseek, glm-zhipu）' }),
        model_id: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        workspace_id: Type.Optional(Type.String({ description: '工作区 ID。指定后会话出现在该工作区侧边栏。' })),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; channel_id: string; model_id?: string; title?: string; workspace_id?: string }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'create_session', {
          channel_id: args.channel_id,
          model_id: args.model_id,
          title: args.title,
          workspace_id: args.workspace_id,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_fork_session',
      label: '远端Fork会话',
      description: '在远端实例上 Fork 一个已有会话。',
      promptSnippet: 'remote_fork_session: fork a session on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        source_session_id: Type.String({ description: '远端源会话 ID' }),
        up_to_message_uuid: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        new_channel_id: Type.Optional(Type.String()),
        new_model_id: Type.Optional(Type.String()),
        new_workspace_id: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params) {
        const args = params as Record<string, string | undefined>
        const port = await findPortByInstance(args.instance as string)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'fork_session', {
          source_session_id: args.source_session_id,
          up_to_message_uuid: args.up_to_message_uuid,
          title: args.title,
          new_channel_id: args.new_channel_id,
          new_model_id: args.new_model_id,
          new_workspace_id: args.new_workspace_id,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_send_message',
      label: '远端发送消息',
      description: '向远端实例上的会话发送消息。',
      promptSnippet: 'remote_send_message: send a message to a remote session.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        session_id: Type.String({ description: '远端会话 ID' }),
        message: Type.String({ description: '消息内容' }),
        wait: Type.Optional(Type.Boolean()),
        model_id: Type.Optional(Type.String()),
        channel_id: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params) {
        const args = params as Record<string, string | boolean | undefined>
        const port = await findPortByInstance(args.instance as string)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'send_message', {
          session_id: args.session_id,
          message: args.message,
          wait: args.wait ?? true,
          model_id: args.model_id,
          channel_id: args.channel_id,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_archive_session',
      label: '远端归档会话',
      description: '在远端实例上归档或取消归档会话。',
      promptSnippet: 'remote_archive_session: archive a session on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
        session_id: Type.String({ description: '远端会话 ID' }),
        archived: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; session_id: string; archived?: boolean }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'archive_session', {
          session_id: args.session_id,
          archived: args.archived,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_abort_session',
      label: '远端中止会话',
      description: '在远端实例上按 sessionId 中止运行中的 run（含挂起的 AskUser 等交互）。用于救援挂起或失控的远端会话；消息未消费时也建议先 abort 再处理。',
      promptSnippet: 'remote_abort_session: abort a running session on a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名。本实例用 "release"。' }),
        session_id: Type.String({ description: '远端会话 ID' }),
      }),
      async execute(_toolCallId, params) {
        const args = params as { instance: string; session_id: string }
        const port = await findPortByInstance(args.instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${args.instance}"` })
        return jsonToolResult(await callRemoteTool(port, 'abort_session', {
          session_id: args.session_id,
        }))
      },
    }),

    sdk.defineTool({
      name: 'mcp__remote-session__remote_get_my_session_id',
      label: '远端实例信息',
      description: '获取远端实例信息。始终返回 null session_id（你不在该实例内）。',
      promptSnippet: 'remote_get_my_session_id: get instance info for a remote instance.',
      parameters: Type.Object({
        instance: Type.String({ description: '远端实例名' }),
      }),
      async execute(_toolCallId, params) {
        const { instance } = params as { instance: string }
        const port = await findPortByInstance(instance)
        if (!port) return jsonToolResult({ error: `未找到实例 "${instance}"` })
        return jsonToolResult({
          session_id: null,
          is_external: true,
          instance,
          port,
          hint: '你不在该实例内，session_id 始终为 null。',
        })
      },
    }),
  ]
}
