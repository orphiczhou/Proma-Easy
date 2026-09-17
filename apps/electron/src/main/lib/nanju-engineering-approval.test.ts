import { expect, test } from 'bun:test'
import { AgentPermissionService } from './agent-permission-service'
import { createEngineeringTestApproval } from './nanju-engineering-approval'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'

function input(): EngineeringExecutionInput {
  return { projectDir: '/fixture', test: { id: 'cli', layer: 'acceptance', adapter: 'cli-driver', target: 'app', command: '验证输出', covers: ['US-01'], requiresReal: true, driver: { runtime: 'node', path: 'check.cjs', args: ['one arg'], timeoutMs: 1000 } },
    evidence: { schemaVersion: 1, digest: 'fixture-digest', prd: { path: 'prd', sha256: 'p', size: 1 }, contract: { path: 'contract', sha256: 'c', size: 1 }, artifacts: [] }, signal: new AbortController().signal }
}
test('Given 工程测试批准 When 用户确认 Then 复用单次权限且显示版本与副作用', async () => {
  const service = new AgentPermissionService()
  let requests = 0
  const approve = createEngineeringTestApproval('session', (request) => {
    requests++
    expect(request.allowAlways).toBe(false)
    expect(request.sdkDescription).toContain('fixture-digest')
    expect(request.sdkDescription).toContain('不是沙箱')
    expect(request.toolInput.driver).toEqual(input().test.driver)
    service.respondToPermission(request.requestId, requests === 1 ? 'allow' : 'deny', true)
  }, service)
  expect(await approve(input())).toBe(true)
  expect(await approve(input())).toBe(false)
  expect(requests).toBe(2)
})

test('Given 工程批准生产接线 When 检查生命周期 Then 使用单次批准并在停止和finally取消', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
  const start = source.indexOf('  private triggerNanjuGwtRun(')
  const end = source.indexOf('// ===== 南大 L2 委派超时', start)
  const block = source.slice(start, end)
  expect(block).toContain('createEngineeringTestApproval(sessionId, (request) =>')
  expect(block).toContain("type: 'permission_request', request")
  expect(block).toContain('engineeringExecution,')
  expect(block).toContain('} finally {\n        this.runningGwtProjects.delete(projectId)\n        engineeringAbort.abort()\n        this.engineeringGwtRuns.delete(projectId)')
  const stop = source.slice(source.indexOf('  stop(sessionId:'), source.indexOf('  abortPendingCapabilities(sessionId:'))
  expect(stop).toContain('if (run.sessionId === sessionId) run.abort.abort()')
})

test('Given 工程单次批准等待中 When 原turn结束后用户应答 Then 后台批准仍可响应且不成为永久白名单', async () => {
  const service = new AgentPermissionService()
  const approve = createEngineeringTestApproval('s', () => {}, service)
  const result = approve(input())
  service.clearSessionPending('s', { preserveHostTasks: true })
  const pending = service.getPendingRequests()[0]!
  expect(pending.allowAlways).toBe(false)
  expect(service.respondToPermission(pending.requestId, 'allow', true)).toBe('s')
  expect(await result).toBe(true)
  const controller = new AbortController()
  const second = approve({ ...input(), signal: controller.signal })
  expect(service.getPendingRequests().length).toBe(1)
  controller.abort()
  expect(await second).toBe(false)
  expect(service.getPendingRequests()).toEqual([])
})

test('Given 后台批准横幅已发布 When 任务取消 Then 清宿主pending并发resolved通知清界面', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let requestId = ''
  const resolved: Array<{ requestId: string; behavior: 'allow' | 'deny' }> = []
  const approve = createEngineeringTestApproval('s', (request) => { requestId = request.requestId }, service, (event) => resolved.push(event))
  const pending = approve({ ...input(), signal: controller.signal })
  controller.abort()
  expect(await pending).toBe(false)
  expect(service.getPendingRequests()).toEqual([])
  expect(resolved).toEqual([{ requestId, behavior: 'deny' }])
})

test('B-b：browser-url 测试的批准说明展示真实服务计划（runtime/path/argv/port/readyPath）', async () => {
  const service = new AgentPermissionService()
  const base = input()
  const browserUrl: EngineeringExecutionInput = {
    ...base,
    test: {
      id: 'svc', layer: 'acceptance', adapter: 'browser-url', target: 'index.html',
      command: '由宿主启动服务后访问 served URL', covers: ['US-02'], requiresReal: true,
      service: { runtime: 'node', path: 'server.cjs', args: ['--port', '4319'], port: 4319, readyPath: '/health', readyTimeoutMs: 3000 },
    },
  }
  let seenDescription = ''
  let seenPayload: Record<string, unknown> = {}
  const approve = createEngineeringTestApproval('session-burl', (request) => {
    seenDescription = request.sdkDescription ?? ''
    seenPayload = request.toolInput
    service.respondToPermission(request.requestId, 'allow', false)
  }, service)
  expect(await approve(browserUrl)).toBe(true)
  // 真实服务计划必须可见：运行时可执行、服务文件、argv、端口、就绪路径、就绪超时
  expect(seenDescription).toContain('服务运行时：node')
  expect(seenDescription).toContain('服务文件：server.cjs')
  expect(seenDescription).toContain('["--port","4319"]')
  expect(seenDescription).toContain('127.0.0.1:4319')
  expect(seenDescription).toContain('/health')
  expect(seenDescription).toContain('3000ms')
  // 既有承诺不得被冲掉：版本 digest 行与非沙箱警示仍在
  expect(seenDescription).toContain('批准绑定版本：fixture-digest')
  expect(seenDescription).toContain('不是沙箱')
  // payload 同时携带结构化服务计划（当前 driver 为 undefined，界面据此也能展示服务而非「未声明」）
  expect(seenPayload.service).toEqual(browserUrl.test.service)
  expect(seenPayload.driver).toBeUndefined()
})

test('B-b：非 browser-url 测试不追加服务行（零行为变化）', async () => {
  const service = new AgentPermissionService()
  let seenDescription = ''
  const approve = createEngineeringTestApproval('session-cli', (request) => {
    seenDescription = request.sdkDescription ?? ''
    service.respondToPermission(request.requestId, 'allow', false)
  }, service)
  expect(await approve(input())).toBe(true)
  expect(seenDescription).not.toContain('服务运行时：')
  expect(seenDescription).toContain('驱动：check.cjs')
})

test('B-b：orchestrator 把已探测运行时传给 runner（消除重复探测）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
  const start = source.indexOf('  private triggerNanjuGwtRun(')
  const block = source.slice(start, source.indexOf('// ===== 南大 L2 委派超时', start))
  expect(block).toContain('const serviceRuntimes = { nodePath: node.available ? node.path ?? undefined : undefined, pythonPath }')
  expect(block).toContain('engineeringExecution = { signal: engineeringAbort.signal, serviceRuntimes, services: {')
  expect(block).toContain('createEngineeringTestApproval(sessionId, (request) =>')
})
