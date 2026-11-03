/**
 * P0-B Phase2 施工 C：remote_abort_session 工具 + HTTP bridge abort_session handler。
 *
 * 缺口（e2e-runtime-results §2）：remote-session MCP 无 abort 工具，父实例无法
 * 终止挂起的远端 run（AskUser 挂起 622s+ 无中断路径）。
 *
 * 证据分级：
 * - 工具 schema/名称 = S（直接 import buildPiRemoteSessionTools 断言）；
 * - 工具 → HTTP → abort_session 路由 = S（本地 mock 实例 server，真实 node:http 往返）；
 * - bridge handler 接线 = M（源码断言；agent-mcp-bridge 经 channel-manager 依赖
 *   electron 无法单测加载）。真实远端实例上的终止效果未在单测内执行（R 级留待实例验证）。
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as http from 'node:http'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { buildPiRemoteSessionTools } from './agent-remote-session-tools'

const bridgeSource = readFileSync(new URL('./agent-mcp-bridge.ts', import.meta.url), 'utf-8')

/** stub sdk.defineTool：原样返回定义，便于直接检查 schema */
const stubSdk = {
  defineTool: (tool: ToolDefinition) => tool,
} as unknown as Parameters<typeof buildPiRemoteSessionTools>[0]

const tools = buildPiRemoteSessionTools(stubSdk)
const abortTool = tools.find((t) => t.name === 'mcp__remote-session__remote_abort_session')

describe('remote_abort_session MCP 工具（P0-B Phase2）', () => {
  test('工具存在且 schema 合法：instance + session_id 均必填', () => {
    expect(abortTool).toBeDefined()
    const schema = abortTool!.parameters as unknown as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(schema.properties.instance).toBeDefined()
    expect(schema.properties.session_id).toBeDefined()
    expect(schema.required).toContain('instance')
    expect(schema.required).toContain('session_id')
  })

  test('与既有 remote 工具同模式（名称前缀/execute 返回 jsonToolResult）', () => {
    expect(abortTool!.name.startsWith('mcp__remote-session__')).toBe(true)
    expect(tools.some((t) => t.name === 'mcp__remote-session__remote_send_message')).toBe(true)
    expect(typeof abortTool!.execute).toBe('function')
  })
})

// ===== 真实 HTTP 路由（本地 mock 实例，端口须落在 bridge 发现范围 19876-19895）=====

const MOCK_INSTANCE = 'test-abort-a3f2'
const PORT_RANGE_START = 19876
const PORT_RANGE_END = 19895

let mockServer: http.Server | null = null
let mockPort = 0
const abortCalls: Array<Record<string, unknown>> = []

async function startMockInstance(): Promise<void> {
  for (let port = PORT_RANGE_END; port >= PORT_RANGE_START; port--) {
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && path === '/get_instance_info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ instance: MOCK_INSTANCE, proma_dev: false, port }))
        return
      }
      if (req.method === 'POST' && path === '/abort_session') {
        let body = ''
        req.on('data', (c: Buffer) => (body += c.toString()))
        req.on('end', () => {
          abortCalls.push(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ session_id: JSON.parse(body).session_id, status: 'aborted' }))
        })
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Unknown tool: ${path}` }))
    })
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (ok) {
      mockServer = server
      mockPort = port
      return
    }
  }
  throw new Error('mock 实例端口范围内无空闲端口')
}

afterAll(() => {
  mockServer?.close()
})

// MCP 桥接工具不会读取后续参数；与 pi-mcp-tools.test.ts 同法补齐签名。
const unusedAbortSignal = undefined as unknown as Parameters<ToolDefinition['execute']>[2]
const unusedUpdate = undefined as unknown as Parameters<ToolDefinition['execute']>[3]
const unusedExtensionContext = undefined as unknown as Parameters<ToolDefinition['execute']>[4]

describe('remote_abort_session 真实 HTTP 路由（本地 mock 实例）', () => {
  test('execute 经实例发现路由到远端 abort_session 并透传 session_id', async () => {
    await startMockInstance()
    const result = await abortTool!.execute(
      'call-test-1',
      { instance: MOCK_INSTANCE, session_id: 'sess-hang-622s' },
      unusedAbortSignal,
      unusedUpdate,
      unusedExtensionContext,
    )
    const details = result.details as Record<string, unknown>
    expect(details.status).toBe('aborted')
    expect(abortCalls).toHaveLength(1)
    expect(abortCalls[0]!.session_id).toBe('sess-hang-622s')
  }, 15_000)
})

describe('HTTP bridge abort_session handler 接线（源码断言，M 级）', () => {
  /**
   * M1-3 之后（2026-11-02）abort_session 业务实现已下沉到共享层 session-tool-handlers.ts，
   * bridge 只保留「外部调用身份 + 路由」，因此源码断言改为「共享层含完整实现 ∧ bridge 经共享层接入」。
   * 断言口径未放宽：stop / capability 清理 / 会话存在性校验三项语义仍逐条核对。
   */
  const sharedSource = readFileSync(new URL('./session-tool-handlers.ts', import.meta.url), 'utf-8')

  /** 截取共享层 abort_session handler 段落（到下一个同级 handler 或 handlers 收口） */
  function sharedAbortHandlerSlice(): string {
    const start = sharedSource.indexOf('abort_session: async (args')
    if (start < 0) return ''
    const endCandidates = [
      sharedSource.indexOf('\n    },\n    ', start),
      sharedSource.indexOf('\n  }\n  return handlers', start),
    ].filter((i) => i > start)
    const end = endCandidates.length > 0 ? Math.min(...endCandidates) : sharedSource.length
    return sharedSource.slice(start, end)
  }

  test('handler 存在且执行 stop + 确定性 capability abort', () => {
    const handler = sharedAbortHandlerSlice()
    expect(handler.length).toBeGreaterThan(0)
    // 会话不存在 → 早退，不得对未知会话执行 stop/清理
    expect(handler).toContain('if (!meta) return { error: `Session not found: ${sessionId}` }')
    expect(handler).toContain('isAgentSessionActive(sessionId)')
    expect(handler).toContain('if (wasActive) stopRegisteredAgent(sessionId)')
    expect(handler).toContain('abortAgentPendingCapabilities(sessionId)')
    // 返回形态保持 wire 兼容（was_active 反映停止前状态）
    expect(handler).toContain('was_active: wasActive')
  })

  test('abort 能力由共享层导入，bridge 不新增直依赖', () => {
    // 共享层：stop 走 registry，abort/活跃判定走 agent-service（不重复实现）
    expect(sharedSource).toContain("import { runRegisteredHeadlessAgent, stopRegisteredAgent } from './agent-headless-runner-registry'")
    expect(sharedSource).toContain("import { isAgentSessionActive, abortAgentPendingCapabilities } from './agent-service'")
    // bridge：只经共享层接入，且不直接 import agent-service / registry（保持双入口单一实现）
    expect(bridgeSource).toContain("await import('./session-tool-handlers')")
    expect(bridgeSource).toContain('createSessionToolHandlers({ isExternal: true })')
    expect(bridgeSource).not.toContain("from './agent-service'")
    expect(bridgeSource).not.toContain("from './agent-headless-runner-registry'")
  })
})
