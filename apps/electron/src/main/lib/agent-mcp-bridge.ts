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
import { createSessionToolHandlers } from './session-tool-handlers'

const LOG_PREFIX = '[MCP Bridge]'
const PORT_START = 19876
const PORT_END = 19895

function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`)
}

// ===== 工具 handler（蓝图 M1-3：业务逻辑统一在 session-tool-handlers.ts，此处仅以外部调用身份接入）=====

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>

// ===== HTTP Server =====

let bridgeServer: http.Server | null = null

export function startMcpHttpBridge(): void {
  if (bridgeServer) return

  const handlers = createSessionToolHandlers({ isExternal: true })
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
        const handler: ToolHandler | undefined = urlPath ? (handlers as Record<string, ToolHandler>)[urlPath] : undefined
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
