/**
 * NEXT-04：HTTP Bridge 鉴权与 CORS 收敛 BDD 测试
 *
 * 覆盖：
 * - 本地共享 token 生命周期：生成（32 字节 hex / 0600）、复用不覆盖、非法内容重建、权限收敛；
 * - 请求鉴权真实 HTTP 往返：loopback 无 token 放行、正确 token 通过、错误 token 401、
 *   非 loopback 绑定强制 token、Authorization: Bearer 兼容；
 * - CORS 收敛：任何响应（GET/OPTIONS/401）都不再含 Access-Control-* 通配头；
 * - 客户端注入：agent-remote-session-tools 与 proma-mcp-server.cjs 自动携带 token。
 *
 * 隔离策略：token 落在 mkdtemp 目录（PROMA_BRIDGE_TOKEN_PATH 覆盖 + 临时 HOME），
 * 绝不触碰真实 ~/.proma。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as http from 'node:http'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  BRIDGE_TOKEN_HEADER,
  createBridgeHttpServer,
  ensureBridgeToken,
  evaluateBridgeAuth,
  extractBridgeToken,
  getBridgeTokenPath,
  isLoopbackAddress,
  readBridgeTokenFile,
} from './agent-mcp-bridge'
import { buildPiRemoteSessionTools } from './agent-remote-session-tools'

// ===== 测试隔离环境 =====

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'proma-bridge-next04-'))
const TEST_HOME = join(TEST_ROOT, 'home')
const TOKEN_PATH = join(TEST_HOME, '.proma', '.mcp-bridge-token')
const CLI_PATH = fileURLToPath(new URL('./proma-mcp-server.cjs', import.meta.url))

beforeAll(() => {
  mkdirSync(join(TEST_HOME, '.proma'), { recursive: true })
  process.env.PROMA_BRIDGE_TOKEN_PATH = TOKEN_PATH
})

afterAll(() => {
  delete process.env.PROMA_BRIDGE_TOKEN_PATH
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

// ===== 通用 HTTP 辅助 =====

interface HttpResult {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
  json: Record<string, unknown> | null
}

function request(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const { method = 'POST', path = '/ping', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          let json: Record<string, unknown> | null = null
          try {
            const parsed: unknown = JSON.parse(data)
            if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data, json })
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const pingHandlers = {
  ping: async (args: Record<string, unknown>) => ({ ok: true, echo: args }),
}

/** 启动一个绑定指定地址的 bridge（端口 0 由系统分配） */
async function startBridge(host: string, token: string | null): Promise<{ server: http.Server; port: number }> {
  const server = await createBridgeHttpServer({
    handlers: pingHandlers,
    port: 0,
    host,
    instanceName: 'test-next04',
    token,
  })
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  return { server, port }
}

function expectNoCorsHeaders(headers: http.IncomingHttpHeaders): void {
  const keys = Object.keys(headers).map((k) => k.toLowerCase())
  expect(keys.filter((k) => k.startsWith('access-control-'))).toEqual([])
}

// ===== 1. token 生命周期 =====

describe('本地共享 token 生命周期', () => {
  test('首次启动生成 32 字节 hex token，落盘为 0600', () => {
    expect(existsSync(TOKEN_PATH)).toBe(false)
    expect(getBridgeTokenPath()).toBe(TOKEN_PATH)

    const token = ensureBridgeToken()

    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(TOKEN_PATH, 'utf-8').trim()).toBe(token)
    expect(readBridgeTokenFile(TOKEN_PATH)).toBe(token)
    if (process.platform !== 'win32') {
      expect(statSync(TOKEN_PATH).mode & 0o777).toBe(0o600)
    }
  })

  test('再次启动复用既有 token，不覆盖文件', () => {
    const first = readFileSync(TOKEN_PATH, 'utf-8').trim()
    const second = ensureBridgeToken()
    expect(second).toBe(first)
    expect(readFileSync(TOKEN_PATH, 'utf-8').trim()).toBe(first)
  })

  test('token 文件内容被截断/篡改时重新生成合法 token', () => {
    writeFileSync(TOKEN_PATH, 'deadbeef', 'utf-8')
    expect(readBridgeTokenFile(TOKEN_PATH)).toBeNull()

    const token = ensureBridgeToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(token).not.toBe('deadbeef')
  })

  test('既有合法 token 文件权限过宽时复用它并收敛到 0600', () => {
    if (process.platform === 'win32') return
    const token = ensureBridgeToken()
    writeFileSync(TOKEN_PATH, token, { encoding: 'utf-8', mode: 0o644 })
    statSync(TOKEN_PATH) // 触发一次读取，确保文件就绪

    expect(ensureBridgeToken()).toBe(token)
    expect(statSync(TOKEN_PATH).mode & 0o777).toBe(0o600)
  })
})

// ===== 2. 鉴权纯函数分支 =====

describe('鉴权判定分支', () => {
  const token = 'a'.repeat(64)

  test('loopback 来源 + loopback 绑定 + 无 token → 放行（兼容本机直连）', () => {
    expect(
      evaluateBridgeAuth({ providedToken: null, remoteAddress: '127.0.0.1', bindHost: '127.0.0.1', expectedToken: token })
        .allowed,
    ).toBe(true)
    expect(
      evaluateBridgeAuth({ providedToken: null, remoteAddress: '::1', bindHost: 'localhost', expectedToken: token })
        .allowed,
    ).toBe(true)
    expect(
      evaluateBridgeAuth({
        providedToken: null,
        remoteAddress: '::ffff:127.0.0.1',
        bindHost: '127.0.0.1',
        expectedToken: token,
      }).allowed,
    ).toBe(true)
  })

  test('非 loopback 来源无 token → 401', () => {
    const decision = evaluateBridgeAuth({
      providedToken: null,
      remoteAddress: '192.168.1.20',
      bindHost: '127.0.0.1',
      expectedToken: token,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBeTruthy()
  })

  test('loopback 来源但绑定在 0.0.0.0（局域网暴露）无 token → 401', () => {
    expect(
      evaluateBridgeAuth({ providedToken: null, remoteAddress: '127.0.0.1', bindHost: '0.0.0.0', expectedToken: token })
        .allowed,
    ).toBe(false)
  })

  test('token 相等放行、不等拒绝；token 未初始化时带 token 也拒绝', () => {
    expect(
      evaluateBridgeAuth({ providedToken: token, remoteAddress: '192.168.1.20', bindHost: '0.0.0.0', expectedToken: token })
        .allowed,
    ).toBe(true)
    expect(
      evaluateBridgeAuth({ providedToken: 'b'.repeat(64), remoteAddress: '127.0.0.1', bindHost: '127.0.0.1', expectedToken: token })
        .allowed,
    ).toBe(false)
    expect(
      evaluateBridgeAuth({ providedToken: token, remoteAddress: '127.0.0.1', bindHost: '127.0.0.1', expectedToken: null })
        .allowed,
    ).toBe(false)
  })

  test('带 Origin 的浏览器请求一律拒绝（403），token 正确也不放行', () => {
    const decision = evaluateBridgeAuth({
      providedToken: token,
      remoteAddress: '127.0.0.1',
      bindHost: '127.0.0.1',
      expectedToken: token,
      origin: 'https://evil.example',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.status).toBe(403)
  })

  test('loopback 地址判定覆盖 127.0.0.0/8、::1、localhost 与 IPv4-mapped', () => {
    for (const addr of ['127.0.0.1', '127.9.9.9', '::1', 'localhost', '::ffff:127.0.0.1']) {
      expect(isLoopbackAddress(addr)).toBe(true)
    }
    for (const addr of ['0.0.0.0', '192.168.1.2', '10.0.0.5', '', undefined]) {
      expect(isLoopbackAddress(addr)).toBe(false)
    }
  })

  test('请求头解析：x-proma-bridge-token 优先，Authorization: Bearer 兜底', () => {
    expect(extractBridgeToken({ [BRIDGE_TOKEN_HEADER]: '  abc  ' })).toBe('abc')
    expect(extractBridgeToken({ authorization: 'Bearer tok-123' })).toBe('tok-123')
    expect(extractBridgeToken({ authorization: 'bearer tok-456' })).toBe('tok-456')
    expect(extractBridgeToken({})).toBeNull()
  })
})

// ===== 3. 真实 HTTP 鉴权与 CORS 收敛 =====

describe('bridge 真实 HTTP 鉴权（loopback 绑定）', () => {
  let server: http.Server
  let port = 0
  let token = ''

  beforeAll(async () => {
    token = ensureBridgeToken()
    const started = await startBridge('127.0.0.1', token)
    server = started.server
    port = started.port
  })

  afterAll(() => {
    server.close()
  })

  test('loopback 无 token 头 → 放行（既有本机自动化兼容）', async () => {
    const res = await request(port, { body: JSON.stringify({ from: 'local-automation' }) })
    expect(res.status).toBe(200)
    expect(res.json?.ok).toBe(true)
    expect((res.json?.echo as Record<string, unknown>)?.from).toBe('local-automation')
  })

  test('携带正确 token → 通过', async () => {
    const res = await request(port, { headers: { [BRIDGE_TOKEN_HEADER]: token }, body: '{}' })
    expect(res.status).toBe(200)
    expect(res.json?.ok).toBe(true)
  })

  test('携带错误 token → 401，且响应不带通配 CORS 头', async () => {
    const res = await request(port, { headers: { [BRIDGE_TOKEN_HEADER]: 'f'.repeat(64) }, body: '{}' })
    expect(res.status).toBe(401)
    expect(String(res.json?.error)).toContain('Unauthorized')
    expectNoCorsHeaders(res.headers)
    // 不向客户端泄露内部拒绝原因
    expect(res.body).not.toContain('不匹配')
  })

  test('Authorization: Bearer 等价可用', async () => {
    const res = await request(port, { headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(res.status).toBe(200)
  })

  test('GET /get_instance_info 正常响应且已无 Access-Control-Allow-Origin', async () => {
    const res = await request(port, { method: 'GET', path: '/get_instance_info' })
    expect(res.status).toBe(200)
    expect(res.json?.instance).toBe('test-next04')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expectNoCorsHeaders(res.headers)
  })

  test('OPTIONS 预检不再返回 CORS 许可（浏览器跨源路径被切断）', async () => {
    const res = await request(port, {
      method: 'OPTIONS',
      path: '/ping',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    })
    expect(res.status).not.toBe(204)
    expectNoCorsHeaders(res.headers)
  })

  test('浏览器 Origin 请求一律 403（即使不带/带对 token，阻断 no-cors CSRF 副作用）', async () => {
    const withoutToken = await request(port, {
      path: '/ping',
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ hijack: true }),
    })
    expect(withoutToken.status).toBe(403)
    expectNoCorsHeaders(withoutToken.headers)

    const withValidToken = await request(port, {
      path: '/ping',
      headers: { origin: 'https://evil.example', [BRIDGE_TOKEN_HEADER]: token },
      body: '{}',
    })
    expect(withValidToken.status).toBe(403)
  })

  test('无 Origin 的本地直连仍正常（CLI / node:http.request 不带 Origin）', async () => {
    const res = await request(port, { headers: { 'user-agent': 'node' }, body: '{}' })
    expect(res.status).toBe(200)
  })

  test('未知工具仍返回 404（路由行为未回归）', async () => {
    const res = await request(port, { path: '/not_a_tool', headers: { [BRIDGE_TOKEN_HEADER]: token }, body: '{}' })
    expect(res.status).toBe(404)
  })
})

describe('bridge 真实 HTTP 鉴权（0.0.0.0 绑定，模拟局域网暴露）', () => {
  let server: http.Server
  let port = 0
  let token = ''

  beforeAll(async () => {
    token = ensureBridgeToken()
    const started = await startBridge('0.0.0.0', token)
    server = started.server
    port = started.port
  })

  afterAll(() => {
    server.close()
  })

  test('本机来源但未带 token → 401（绑定非 loopback 时强制 token）', async () => {
    const res = await request(port, { body: '{}' })
    expect(res.status).toBe(401)
    expectNoCorsHeaders(res.headers)
  })

  test('携带正确 token → 通过', async () => {
    const res = await request(port, { headers: { [BRIDGE_TOKEN_HEADER]: token }, body: '{}' })
    expect(res.status).toBe(200)
  })
})

// ===== 4. 客户端注入（远端实例 mock，真实 HTTP 往返）=====

const MOCK_INSTANCE = 'test-next04-remote'
const MOCK_OK = { ok: true, tool: 'list_channels' }

const unusedUpdate = undefined as unknown as Parameters<ToolDefinition['execute']>[3]
const unusedExtensionContext = undefined as unknown as Parameters<ToolDefinition['execute']>[4]
const unusedSignal = undefined as unknown as Parameters<ToolDefinition['execute']>[2]

/** 在 bridge 发现范围内启动一个「要求 token」的 mock 实例 */
function startTokenRequiringMock(token: string, host = '127.0.0.1'): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      if (port > 19895) {
        reject(new Error('19876-19895 无可用端口'))
        return
      }
      const server = http.createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0]
        if (req.method === 'GET' && path === '/get_instance_info') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ instance: MOCK_INSTANCE, proma_dev: false, port }))
          return
        }
        const provided = req.headers[BRIDGE_TOKEN_HEADER]
        if (provided !== token) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Unauthorized' }))
          return
        }
        if (req.method === 'POST' && path === '/list_channels') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(MOCK_OK))
          return
        }
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unknown tool: ${path}` }))
      })
      server.once('error', () => tryPort(port + 1))
      server.listen(port, host, () => resolve({ server, port }))
    }
    tryPort(19876)
  })
}

describe('客户端自动注入 token', () => {
  let mock: http.Server
  let mockPort = 0

  beforeAll(async () => {
    const token = ensureBridgeToken()
    const started = await startTokenRequiringMock(token)
    mock = started.server
    mockPort = started.port
  })

  afterAll(() => {
    mock.close()
  })

  test('agent-remote-session-tools 调用要求 token 的实例成功', async () => {
    const stubSdk = {
      defineTool: (tool: ToolDefinition) => tool,
    } as unknown as Parameters<typeof buildPiRemoteSessionTools>[0]
    const tools = buildPiRemoteSessionTools(stubSdk)
    const listChannels = tools.find((t) => t.name === 'mcp__remote-session__remote_list_channels')
    expect(listChannels).toBeDefined()

    const result = await listChannels!.execute(
      'call-1',
      { instance: MOCK_INSTANCE },
      unusedSignal,
      unusedUpdate,
      unusedExtensionContext,
    )
    const content = (result as { content: Array<{ text: string }> }).content
    const first = content[0]
    expect(first).toBeDefined()
    const payload: unknown = JSON.parse(first!.text)
    expect(payload).toEqual(MOCK_OK)
  }, 20_000)

  test('proma-mcp-server.cjs 从配置目录读取 token 并注入（真实子进程）', async () => {
    ensureBridgeToken()
    // 用 --host 127.0.0.2 走「直连模式」，使 CLI 只看到本测试的 mock
    // （真实实例都绑在 127.0.0.1 上，避免测试打到用户正在运行的实例）。
    // 127.0.0.2 依赖 loopback /8，仅 Linux 默认可用。
    let cliMock: { server: http.Server; port: number } | null = null
    try {
      cliMock = await startTokenRequiringMock(ensureBridgeToken(), '127.0.0.2')
    } catch {
      cliMock = null
    }
    if (!cliMock) {
      // 平台不支持 127.0.0.2：退化为源码级断言，确保注入逻辑仍在
      const source = readFileSync(CLI_PATH, 'utf-8')
      expect(source).toContain('x-proma-bridge-token')
      expect(source).toContain('.mcp-bridge-token')
      return
    }

    const child = spawn('node', [CLI_PATH, '--release', '--host', '127.0.0.2'], {
      env: { ...process.env, HOME: TEST_HOME, PROMA_BRIDGE_TOKEN_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const pending = new Map<number, (msg: Record<string, unknown>) => void>()
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        const id = msg.id
        if (typeof id === 'number' && pending.has(id)) {
          pending.get(id)!(msg)
          pending.delete(id)
        }
      } catch {
        // 非 JSON 输出（如 stderr 混入）忽略
      }
    })

    const sendRequest = (payload: { id: number; method: string; params?: Record<string, unknown> }): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI 响应超时')), 15_000)
        pending.set(payload.id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n')
      })

    try {
      const init = await sendRequest({ id: 1, method: 'initialize' })
      expect((init.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05')

      const called = await sendRequest({
        id: 2,
        method: 'tools/call',
        params: { name: 'list_channels', arguments: {} },
      })
      // mock 只在收到正确 token 时返回 200；此处返回体即 tool 结果
      expect(called.result).toEqual(MOCK_OK)
    } finally {
      child.kill()
      rl.close()
      cliMock.server.close()
    }
  }, 30_000)
})
