/**
 * 外部 MCP HTTP Bridge 服务
 *
 * 移植自 proma-patches 项目的 createExternalHttpBridge()。
 * 在 localhost 上启动 HTTP server，将 session 工具暴露给外部调用。
 * 外部工具（Claude Code、脚本等）通过 proma-mcp-server.cjs stdio 桥接访问此服务。
 *
 * 端口范围: 19876-19895（自动选择）
 * 实例发现: GET /get_instance_info
 * 工具调用: POST /<tool_name>
 */

import * as http from 'node:http'
import { randomUUID } from 'node:crypto'
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
import type { SDKMessage, PromaPermissionMode } from '@proma/shared'

const LOG_PREFIX = '[MCP Bridge]'
const PORT_START = 19876
const PORT_END = 19895

function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`)
}

// ===== 工具 handler（与 agent-session-tools.ts 共享逻辑，但外部调用 sourceSessionId=null）=====

interface ToolHandler {
  (args: Record<string, unknown>): Promise<Record<string, unknown>>
}

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

function createSessionToolHandlers(): Record<string, ToolHandler> {
  return {
    get_my_session_id: async () => ({
      session_id: null,
      is_external: true,
      hint: 'No session ID available (external MCP caller).',
    }),

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

    list_sessions: async (args) => {
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

    get_session_info: async (args) => {
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

    get_session_context: async (args) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: ${args.session_id}` }
      let lastModel: string | null = null
      let contextWindow: number | null = null
      let usage: Record<string, number> | null = null
      try {
        const msgs = getAgentSessionSDKMessages(args.session_id as string)
        if (msgs.length > 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i] as unknown as Record<string, unknown>
            if (msg.type !== 'result') continue
            usage = (msg.usage ?? null) as Record<string, number> | null
            const mu = msg.modelUsage as Record<string, Record<string, unknown>> | undefined
            if (mu) {
              const keys = Object.keys(mu)
              if (keys.length > 0) { const k = keys[0]; if (k) { lastModel = k; contextWindow = (mu[k]?.contextWindow as number) ?? null } }
            }
            break
          }
        }
      } catch { /* best-effort */ }
      if (!lastModel) lastModel = meta.modelId ?? null
      if (!usage) return { session_id: args.session_id, title: meta.title, model: lastModel, context_window: contextWindow, message: 'No usage data yet.' }
      const input = usage.input_tokens ?? 0
      const output = usage.output_tokens ?? 0
      const cache = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      const pct = contextWindow ? ((input + output + cache) / contextWindow * 100).toFixed(1) + '%' : null
      return { session_id: args.session_id, title: meta.title, model: lastModel, context_window: contextWindow, usage: { input_tokens: input, output_tokens: output, cache_tokens: cache, total: input + output + cache, usage_pct: pct } }
    },

    list_messages: async (args) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: ${args.session_id}` }
      try {
        const msgs = getAgentSessionSDKMessages(args.session_id as string)
        if (!msgs.length) return { session_id: args.session_id, messages: [], count: 0, total: 0 }
        const offset = (args.offset as number) ?? 0
        const limit = Math.min((args.limit as number) ?? 50, 200)
        const slice = msgs.slice(offset, offset + limit)
        const result = slice.map((m, i) => {
          const msg = m as unknown as Record<string, unknown>
          const entry: Record<string, unknown> = { index: offset + i, type: msg.type, uuid: msg.uuid ?? null, role: (msg.message as Record<string, unknown>)?.role ?? null }
          const content = (msg.message as Record<string, unknown>)?.content
          if (Array.isArray(content)) {
            const texts: string[] = []
            for (const block of content) { if (!block || typeof block !== 'object') continue; const b = block as Record<string, unknown>; if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text) }
            const fullText = texts.join('\n\n')
            entry.text = fullText.length > 500 ? fullText.slice(0, 500) + '...' : fullText
            entry.text_full_length = fullText.length
          }
          if (msg.type === 'result' && msg.usage) entry.usage = msg.usage
          return entry
        })
        return { session_id: args.session_id, count: result.length, total: msgs.length, offset, messages: result }
      } catch (e) { return { error: `读取消息失败: ${e instanceof Error ? e.message : String(e)}` } }
    },

    create_session: async (args) => {
      const meta = createAgentSession(args.title as string | undefined, args.channel_id as string, args.workspace_id as string | undefined, args.model_id as string | undefined)
      return { session: { id: meta.id, title: meta.title, channel_id: meta.channelId, model_id: meta.modelId, workspace_id: meta.workspaceId, created_at: meta.createdAt }, message: `会话 "${meta.title}" 已创建。` }
    },

    fork_session: async (args) => {
      try {
        const meta = await forkAgentSession({ sessionId: args.source_session_id as string, upToMessageUuid: args.up_to_message_uuid as string | undefined, modelId: args.new_model_id as string | undefined })
        if (args.title) { updateAgentSessionMeta(meta.id, { title: args.title as string }); meta.title = args.title as string }
        return { session: { id: meta.id, title: meta.title, channel_id: meta.channelId, model_id: meta.modelId, workspace_id: meta.workspaceId, source_session_id: args.source_session_id, created_at: meta.createdAt }, message: `会话 "${meta.title}" 已 Fork。` }
      } catch (e) { return { error: `Fork 失败: ${e instanceof Error ? e.message : String(e)}` } }
    },

    send_message: async (args) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: "${args.session_id}".` }
      const channelId = (args.channel_id as string) ?? meta.channelId
      if (!channelId) return { error: 'No channel available for this session.' }
      const modelId = (args.model_id as string) ?? meta.modelId
      const shouldWait = args.wait !== false
      try {
        await runRegisteredHeadlessAgent(
          {
            sessionId: args.session_id as string, userMessage: args.message as string, channelId, modelId, workspaceId: meta.workspaceId, permissionModeOverride: 'bypassPermissions' as PromaPermissionMode, startedAt: Date.now(),
            // v2.4（D7 §1 I1-②a）：HTTP bridge 注入非真 UI 人类输入，显式置 false
            //（南大推进门不认 bridge 注入的确认词）
            humanOrigin: false,
          },
          { source: 'delegation', onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} },
        )
      } catch (e) { return { session_id: args.session_id, status: 'error', error: e instanceof Error ? e.message : String(e) } }
      if (!shouldWait) return { session_id: args.session_id, status: 'started', message: '消息已发送，Agent 异步处理中。' }
      const sdkMessages = getAgentSessionSDKMessages(args.session_id as string)
      const reply = extractLastAssistantText(sdkMessages)
      return { session_id: args.session_id, status: 'completed', reply: reply ?? '(无文本输出)' }
    },

    archive_session: async (args) => {
      const meta = getAgentSessionMeta(args.session_id as string)
      if (!meta) return { error: `Session not found: ${args.session_id}` }
      const archived = args.archived ?? true
      updateAgentSessionMeta(args.session_id as string, { archived: !!archived })
      return { session_id: args.session_id, title: meta.title, archived }
    },

    // P0-B Phase2：终止运行中的 run（含挂起的 AskUser 等交互），供远端救援挂起会话。
    abort_session: async (args) => {
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
}

// ===== HTTP Server =====

let bridgeServer: http.Server | null = null

export function startMcpHttpBridge(): void {
  if (bridgeServer) return

  const handlers = createSessionToolHandlers()
  const instanceName = process.env.PROMA_INSTANCE_NAME ?? (process.env.PROMA_DEV === '1' ? 'dev' : 'release')

  function createServer(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // CORS
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          })
          return res.end()
        }

        const urlPath = (req.url ?? '/').slice(1).split('?')[0]

        // 实例发现
        if (req.method === 'GET' && urlPath === 'get_instance_info') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ instance: instanceName, proma_dev: process.env.PROMA_DEV === '1', port }))
        }

        // 工具调用
        const handler: ToolHandler | undefined = urlPath ? handlers[urlPath] : undefined
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: `Unknown tool: ${urlPath}` }))
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }))
        }

        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8')
            const args: Record<string, unknown> = body ? JSON.parse(body) : {}
            const result = await handler(args)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
          }
        })
      })

      server.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') return reject(e)
        log(`HTTP bridge error: ${e.message}`)
      })

      const bindHost = process.env.PROMA_BRIDGE_HOST ?? '127.0.0.1'
      server.listen(port, bindHost, () => resolve(server))
    })
  }

  ;(async () => {
    for (let p = PORT_START; p <= PORT_END; p++) {
      try {
        bridgeServer = await createServer(p)
        const bindHost = process.env.PROMA_BRIDGE_HOST ?? '127.0.0.1'
        log(`External MCP HTTP bridge: http://${bindHost}:${p} (instance: ${instanceName})`)
        return
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'EADDRINUSE') continue
        log(`HTTP bridge start error: ${err.message}`)
        return
      }
    }
    log(`ERROR: No free port in range ${PORT_START}-${PORT_END}`)
  })()
}

export function stopMcpHttpBridge(): void {
  if (bridgeServer) {
    bridgeServer.close()
    bridgeServer = null
    log('HTTP bridge stopped')
  }
}
