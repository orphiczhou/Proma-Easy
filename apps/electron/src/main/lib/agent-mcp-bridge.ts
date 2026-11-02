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
 *
 * 安全模型（NEXT-04，2026-11-03）：
 * 1. 不返回任何 CORS 响应头。本地 CLI 与主进程 http.request 都不走浏览器 CORS，
 *    删除 `Access-Control-Allow-Origin: *` 后，任意网页无法再通过浏览器跨源读取本端口
 *    响应，也拿不到预检许可，从而阻断「网页 CSRF 驱动本地会话」的攻击面。
 * 2. 本地共享 token：启动时确保 `<配置目录>/.mcp-bridge-token` 存在（32 字节随机 hex，
 *    权限 0600）。请求携带 `x-proma-bridge-token` 或 `Authorization: Bearer` 时必须与
 *    本地 token 相等，否则 401。
 * 3. 兼容性（用户 2026-11-02 裁决）：loopback 直连（127.0.0.1/::1 来源 + loopback 绑定）
 *    且不带 token 头的请求继续放行，保证既有本机自动化栈（19877 直连 RPC 等）不被打断；
 *    非 loopback 来源，或绑定在非 loopback 地址（如 PROMA_BRIDGE_HOST=0.0.0.0）时，
 *    一律要求有效 token。
 * 4. 浏览器 Origin 请求一律拒绝（403）：仅删 CORS 头并不足以阻止网页用 no-cors POST
 *    触发副作用（读不到响应但请求已执行），所以只要带 Origin 就直接拦下；
 *    本地 CLI / node:http.request / MCP stdio 桥均不带 Origin，不受影响。
 */

import * as http from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getConfigDir } from './config-paths'
import type { SessionToolHandler } from './session-tool-handlers'

const LOG_PREFIX = '[MCP Bridge]'
const PORT_START = 19876
const PORT_END = 19895

/** 本地共享 token 文件名（位于 Proma 配置目录，dev/release 相互隔离） */
export const BRIDGE_TOKEN_FILE_NAME = '.mcp-bridge-token'
/** 请求头名：客户端用于回传本地共享 token */
export const BRIDGE_TOKEN_HEADER = 'x-proma-bridge-token'
/** token 形态：32 字节随机数的 hex 表示 */
const BRIDGE_TOKEN_PATTERN = /^[0-9a-f]{64}$/

function log(msg: string): void {
  console.log(`${LOG_PREFIX} ${msg}`)
}

// ===== 工具 handler（蓝图 M1-3：业务逻辑统一在 session-tool-handlers.ts，此处仅以外部调用身份接入）=====

// 运行时延迟加载 session-tool-handlers（见 startMcpHttpBridge）；此处仅引类型，
// 避免模块顶层拉起 Electron 依赖链，便于对鉴权/路由做真实 HTTP 单测。
export type ToolHandler = SessionToolHandler

/** 工具名 → handler 映射；单测可注入 stub，避免拉起 Electron 依赖链 */
export type BridgeHandlerMap = Record<string, ToolHandler>

// ===== 本地共享 token 生命周期 =====

/**
 * 解析 token 文件路径。
 *
 * 默认落在 Proma 配置目录（release `~/.proma/`，dev `~/.proma-dev/`），
 * 使 dev 与 release 实例各自持有独立 token。
 * `PROMA_BRIDGE_TOKEN_PATH` 为显式覆盖：用于单测隔离与自部署场景。
 */
export function getBridgeTokenPath(): string {
  const override = process.env.PROMA_BRIDGE_TOKEN_PATH
  if (override && override.trim()) return override.trim()
  return join(getConfigDir(), BRIDGE_TOKEN_FILE_NAME)
}

/** 读取 token 文件；不存在或内容不是合法 token 形态时返回 null（不抛错） */
export function readBridgeTokenFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null
    const raw = readFileSync(filePath, 'utf-8').trim()
    return BRIDGE_TOKEN_PATTERN.test(raw) ? raw : null
  } catch {
    return null
  }
}

/** 原子写入 token 文件：临时文件 → chmod 0600 → rename，避免半截文件与过宽权限 */
function writeBridgeTokenFile(filePath: string, token: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmpPath, token, { encoding: 'utf-8', mode: 0o600 })
    // umask 可能放宽 mode，这里显式收敛一次
    chmodSync(tmpPath, 0o600)
    renameSync(tmpPath, filePath)
  } catch (e) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw e
  }
}

/**
 * 确保本地共享 token 存在并返回。
 *
 * - 已有合法 token：复用，不覆盖（跨重启/跨进程稳定，客户端无需追随变化）；
 * - 已有但内容非法（截断、被改写）：重新生成覆盖；
 * - 不存在：生成 32 字节随机 hex 并以 0600 原子写入。
 */
export function ensureBridgeToken(): string {
  const filePath = getBridgeTokenPath()
  const existing = readBridgeTokenFile(filePath)
  if (existing) {
    // 历史文件可能是 0644（升级前手工创建），顺手收敛权限
    try {
      if ((statSync(filePath).mode & 0o777) !== 0o600) chmodSync(filePath, 0o600)
    } catch {
      // 权限收敛失败不影响可用性，继续使用既有 token
    }
    return existing
  }

  const token = randomBytes(32).toString('hex')
  writeBridgeTokenFile(filePath, token)
  return token
}

// ===== 请求鉴权 =====

/** 判断地址是否 loopback（来源地址与绑定地址共用同一判定） */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  let addr = address.trim().toLowerCase()
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1)
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length)
  if (addr === 'localhost' || addr === '::1' || addr === '0:0:0:0:0:0:0:1') return true
  return addr.startsWith('127.')
}

/** 常量时间比较，避免 token 对比出现时序旁路 */
function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** 从请求头提取 token：优先 x-proma-bridge-token，其次 Authorization: Bearer */
export function extractBridgeToken(headers: http.IncomingHttpHeaders): string | null {
  const raw = headers[BRIDGE_TOKEN_HEADER]
  const headerValue = Array.isArray(raw) ? raw[0] : raw
  if (headerValue && headerValue.trim()) return headerValue.trim()

  const auth = headers.authorization
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match?.[1]) return match[1].trim()
  }
  return null
}

export interface BridgeAuthInput {
  /** 请求携带的 token（已从 header 解析） */
  providedToken: string | null
  /** 请求来源地址（req.socket.remoteAddress） */
  remoteAddress: string | undefined
  /** 服务实际绑定地址（PROMA_BRIDGE_HOST，默认 127.0.0.1） */
  bindHost: string
  /** 本地共享 token；null 表示启动期未能生成（此时非 loopback 一律拒绝） */
  expectedToken: string | null
  /** 请求的 Origin 头（浏览器跨源请求才带；CLI / node:http.request 不带） */
  origin?: string | null
}

export interface BridgeAuthDecision {
  allowed: boolean
  /** 拒绝时建议的 HTTP 状态码 */
  status?: 401 | 403
  /** 拒绝原因，仅写日志，不返回给客户端（避免信息泄露） */
  reason?: string
}

/**
 * 鉴权判定（纯函数，便于单测覆盖真实分支）。
 *
 * 规则：
 * 1. 带 Origin（浏览器发起的跨源请求）→ 一律拒绝。loopback 直连放行策略若无此条，
 *    网页仍可用 no-cors POST 触发副作用（看不到响应但请求已执行），必须单独关闭；
 * 2. 带 token 且与本地 token 相等 → 放行；
 * 3. 带 token 但不等 → 401（任何来源，含 loopback）；
 * 4. 不带 token：来源与绑定均为 loopback → 放行（本机直连兼容）；
 * 5. 不带 token 且来源或绑定任一非 loopback → 401。
 */
export function evaluateBridgeAuth(input: BridgeAuthInput): BridgeAuthDecision {
  // 浏览器跨源请求一定带 Origin；本地 CLI、node:http.request、MCP stdio 桥都不带
  if (input.origin && input.origin.trim()) {
    return { allowed: false, status: 403, reason: '拒绝浏览器 Origin 请求' }
  }

  const provided = input.providedToken?.trim() || null
  if (provided) {
    if (!input.expectedToken) return { allowed: false, status: 401, reason: '本地 token 未初始化' }
    if (!tokensEqual(provided, input.expectedToken)) return { allowed: false, status: 401, reason: 'token 不匹配' }
    return { allowed: true }
  }

  if (isLoopbackAddress(input.remoteAddress) && isLoopbackAddress(input.bindHost)) {
    return { allowed: true }
  }
  return { allowed: false, status: 401, reason: '非 loopback 访问必须携带 x-proma-bridge-token' }
}

// ===== HTTP Server =====

export interface BridgeServerOptions {
  /** 工具名 → handler */
  handlers: BridgeHandlerMap
  /** 监听端口；0 表示由系统分配（单测用） */
  port: number
  /** 绑定地址 */
  host: string
  /** 实例名（GET /get_instance_info 返回） */
  instanceName: string
  /** 本地共享 token；null 表示未初始化 */
  token: string | null
}

/** 创建并监听 bridge HTTP server（不依赖 Electron 环境，可直接单测） */
export function createBridgeHttpServer(options: BridgeServerOptions): Promise<http.Server> {
  const { handlers, host, instanceName, token } = options

  return new Promise((resolve, reject) => {
    // 实际监听端口（port=0 时由系统分配），用于 /get_instance_info 回报
    let boundPort = options.port

    const server = http.createServer((req, res) => {
      // 鉴权前置：未授权请求不进入路由，也不返回任何 CORS 头
      const decision = evaluateBridgeAuth({
        providedToken: extractBridgeToken(req.headers),
        remoteAddress: req.socket.remoteAddress,
        bindHost: host,
        expectedToken: token,
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : null,
      })
      if (!decision.allowed) {
        log(`拒绝请求 ${req.method ?? ''} ${req.url ?? ''}（${decision.reason ?? 'unauthorized'}）`)
        const status = decision.status ?? 401
        res.writeHead(status, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            error:
              status === 403
                ? 'Forbidden: browser origins are not supported'
                : 'Unauthorized: missing or invalid bridge token',
          }),
        )
      }

      const urlPath = (req.url ?? '/').slice(1).split('?')[0]

      // 实例发现
      if (req.method === 'GET' && urlPath === 'get_instance_info') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ instance: instanceName, proma_dev: process.env.PROMA_DEV === '1', port: boundPort }))
      }

      // 工具调用（hasOwnProperty 限定自有属性，避免 __proto__ / constructor 之类原型键被当作 handler）
      const handler: ToolHandler | undefined =
        urlPath && Object.prototype.hasOwnProperty.call(handlers, urlPath) ? handlers[urlPath] : undefined
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

    server.listen(options.port, host, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') boundPort = addr.port
      resolve(server)
    })
  })
}

let bridgeServer: http.Server | null = null

export function startMcpHttpBridge(): void {
  if (bridgeServer) return

  const instanceName = process.env.PROMA_INSTANCE_NAME ?? (process.env.PROMA_DEV === '1' ? 'dev' : 'release')
  const bindHost = process.env.PROMA_BRIDGE_HOST ?? '127.0.0.1'

  // token 生成失败不能让 bridge 静默裸奔：绑定 loopback 时继续（等价旧行为），
  // 绑定到非 loopback 时因 token 为 null 会导致所有外部请求 401（fail-closed）。
  let token: string | null = null
  try {
    token = ensureBridgeToken()
  } catch (e) {
    log(`本地 token 准备失败: ${e instanceof Error ? e.message : String(e)}`)
  }

  ;(async () => {
    // 延迟加载业务 handler：agent-mcp-bridge 因此不依赖 Electron 侧模块，
    // 便于对鉴权/路由做真实 HTTP 单测（此前只能做源码字符串断言）。
    let handlers: BridgeHandlerMap
    try {
      const { createSessionToolHandlers } = await import('./session-tool-handlers')
      handlers = createSessionToolHandlers({ isExternal: true }) as BridgeHandlerMap
    } catch (e) {
      // 加载失败不能变成未处理的 Promise rejection（启动期由 safeRun 兼顾日志）
      log(`工具 handler 加载失败，bridge 未启动: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    for (let p = PORT_START; p <= PORT_END; p++) {
      try {
        bridgeServer = await createBridgeHttpServer({ handlers, port: p, host: bindHost, instanceName, token })
        log(`External MCP HTTP bridge: http://${bindHost}:${p} (instance: ${instanceName}, token: ${token ? 'enabled' : 'unavailable'})`)
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
