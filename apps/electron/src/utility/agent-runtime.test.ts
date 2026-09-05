/**
 * P0-B 行为测试：utility 侧 requestParent 分表超时与 pending 生命周期。
 *
 * agent-runtime.ts 在模块加载期要求 process.parentPort 存在（否则 process.exit），
 * 并在收到 bootstrap 消息后把 runtimePort 作为唯一 IPC 通道。这里用 fake
 * parentPort + mock PiAgentAdapter 加载真实模块，通过 QUERY_START 驱动，
 * 再从 SDK 回调（canUseTool / customTools.execute）触发 requestParent，
 * 在 fake port 上断言超时取消、abort 取消与 query 结束清理的真实行为。
 */
import { afterAll, describe, expect, mock, test } from 'bun:test'
import {
  AGENT_RUNTIME_METHODS,
  AGENT_RUNTIME_PROTOCOL_VERSION,
  createAgentRuntimeRequest,
  createAgentRuntimeResponse,
  type AgentRuntimeEnvelope,
  type AgentRuntimeRequest,
} from '@proma/shared'

// ── mock PiAgentAdapter：捕获 query input；generator 挂起直至测试放行 ──
interface CapturedQuery {
  input: Record<string, unknown>
  end: () => void
}
const capturedQueries: CapturedQuery[] = []

class MockPiAgentAdapter {
  // 挂起式 generator：不产出消息，等测试放行后结束以模拟 query 终结
  // eslint-disable-next-line require-yield
  async *query(input: Record<string, unknown>): AsyncGenerator<never> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    capturedQueries.push({ input, end: release })
    await gate
  }
  abort(): void {}
  async sendQueuedMessage(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  dispose(): void {}
}

const adapterModulePath = '../main/lib/adapters/pi-agent-adapter'
const actualAdapterModule = await import(adapterModulePath)
mock.module(adapterModulePath, () => ({ PiAgentAdapter: MockPiAgentAdapter }))

// ── fake parentPort：在模块加载前注入，避免 process.exit(1) ──
type ParentPortListener = (event: { data: unknown; ports?: unknown[] }) => void
let parentPortListener: ParentPortListener | undefined
const fakeParentPort = {
  on(_event: 'message', listener: ParentPortListener): void { parentPortListener = listener },
  start(): void {},
}
const hadParentPort = 'parentPort' in process
Object.defineProperty(process, 'parentPort', { value: fakeParentPort, configurable: true })

await import('./agent-runtime')

// ── fake runtimePort（utility ↔ main 的 MessagePort）──
interface FakePort {
  posted: AgentRuntimeEnvelope[]
  deliver(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start(): void
  close(): void
}
function createFakePort(): FakePort {
  const posted: AgentRuntimeEnvelope[] = []
  let listener: ((event: { data: unknown }) => void) | undefined
  return {
    posted,
    on(_event, l) { listener = l },
    postMessage(message) { if (isEnvelope(message)) posted.push(message) },
    start() {},
    close() {},
    deliver(message) { listener?.({ data: message }) },
  }
}
function isEnvelope(value: unknown): value is AgentRuntimeEnvelope {
  return !!value && typeof value === 'object'
    && (value as Record<string, unknown>).protocolVersion === AGENT_RUNTIME_PROTOCOL_VERSION
    && typeof (value as Record<string, unknown>).method === 'string'
}

const runtimePort = createFakePort()

// bootstrap：模拟 main 侧投递 MessagePort
parentPortListener?.({
  data: { type: 'proma-agent-runtime-port', protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION },
  ports: [runtimePort],
})

const bootId = (() => {
  const stateEvent = runtimePort.posted.find(
    (message) => message.kind === 'event' && message.method === AGENT_RUNTIME_METHODS.EVENT_STATE,
  )
  const payloadBootId = (stateEvent?.payload as { bootId?: string } | undefined)?.bootId
  if (!stateEvent || !payloadBootId) throw new Error('runtime 未发出含 bootId 的 EVENT_STATE')
  return payloadBootId
})()

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function countQueryEnds(): number {
  return runtimePort.posted.filter(
    (message) => message.kind === 'event' && message.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_END,
  ).length
}

/** 启动一个 query，返回 mock 捕获到的 input 与放行句柄。 */
async function startQuery(queryId: string): Promise<CapturedQuery & { queryStartRequest: AgentRuntimeRequest }> {
  const endsBefore = countQueryEnds()
  const queryStartRequest = createAgentRuntimeRequest(
    AGENT_RUNTIME_METHODS.QUERY_START,
    {
      queryId,
      input: {
        sessionId: 'session-p0b',
        customTools: [{ name: 'wait_for_delegations', description: 'wait', parameters: {} }],
      },
    },
    {},
    bootId,
  )
  runtimePort.deliver(queryStartRequest)
  // handleQueryStart 同步 respond 并同步启动 pumpQuery（捕获同步发生）；等 accepted 响应即可。
  await waitFor(() => runtimePort.posted.some(
    (message) => message.kind === 'response' && message.requestId === queryStartRequest.requestId,
  ))
  const captured = capturedQueries[capturedQueries.length - 1]
  if (!captured) throw new Error('query was not captured')
  return { ...captured, queryStartRequest }
}

/** 结束 query 并等待 pumpQuery 收尾（activeQuery 清理 + pending 清理完成）。 */
async function endQueryAndWait(captured: CapturedQuery): Promise<void> {
  const endsBefore = countQueryEnds()
  captured.end()
  await waitFor(() => countQueryEnds() > endsBefore, 3_000)
}

/** 取一个尚未被断言消费过的 capability request（各测试隔离）。 */
const consumedRequestIds = new Set<string>()
function takeCapabilityRequest(method: string): AgentRuntimeRequest {
  const found = runtimePort.posted.find(
    (message): message is AgentRuntimeRequest =>
      message.kind === 'request' && message.method === method && !consumedRequestIds.has(message.requestId),
  )
  if (!found) throw new Error(`未找到待断言的 capability request: ${method}`)
  consumedRequestIds.add(found.requestId)
  return found
}

function cancelPostedFor(requestId: string): boolean {
  return runtimePort.posted.some(
    (message) => message.kind === 'request'
      && message.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL
      && (message.payload as { requestId?: string } | undefined)?.requestId === requestId,
  )
}

type CanUseToolCallback = (toolName: string, input: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>
type CustomToolExecute = (toolCallId: string, input: Record<string, unknown>, signal: AbortSignal | undefined) => Promise<unknown>

afterAll(() => {
  // 恢复真实 adapter 模块并移除 fake parentPort，避免影响同进程内其他测试文件
  mock.module(adapterModulePath, () => actualAdapterModule)
  if (!hadParentPort) {
    try { delete (process as unknown as Record<string, unknown>).parentPort } catch { /* 忽略 */ }
  }
})

describe('agent-runtime requestParent 分表超时（P0-B）', () => {
  test('QUERY_START 被接受，canUseTool 默认无超时：挂起期间无取消，可被 main 正常应答', async () => {
    const query = await startQuery('q-can-use-tool')
    expect(runtimePort.posted.some(
      (message) => message.kind === 'response' && message.requestId === query.queryStartRequest.requestId
        && (message.payload as { accepted?: boolean })?.accepted === true,
    )).toBe(true)

    const canUseTool = query.input.canUseTool as CanUseToolCallback
    let settled = false
    const pending = canUseTool('AskUserQuestion', { questions: [] }, {})
    pending.then(() => { settled = true }, () => { settled = true })

    // 超时表返回 undefined → 不设定时器 → 300ms 内绝不取消、绝不 settle。
    // （回归为硬编码短超时的实现会在此暴露：settled=false 期间已 CAPABILITY_CANCEL）
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(settled).toBe(false)
    expect(runtimePort.posted.some((message) => message.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL)).toBe(false)

    const capabilityRequest = takeCapabilityRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL)
    runtimePort.deliver(createAgentRuntimeResponse(capabilityRequest, { payload: { behavior: 'allow' } }))
    await expect(pending).resolves.toEqual({ behavior: 'allow' })

    await endQueryAndWait(query)
  })

  test('customTool 超时可配置：env 短超时后按时取消并向 main 发 CAPABILITY_CANCEL', async () => {
    process.env.PROMA_CUSTOM_TOOL_TIMEOUT_MS = '80'
    try {
      const query = await startQuery('q-custom-tool')
      const tool = (query.input.customTools as Array<{ name: string; execute: CustomToolExecute }>)[0]
      if (!tool) throw new Error('custom tool was not registered')

      const executing = tool.execute('tool-call-1', { delegationIds: [] }, undefined)
      const capabilityRequest = takeCapabilityRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL)

      await expect(executing).rejects.toThrow('Main runtime request timed out after 80ms: agent.capability.customTool')
      await waitFor(() => cancelPostedFor(capabilityRequest.requestId))
      await endQueryAndWait(query)
    } finally {
      delete process.env.PROMA_CUSTOM_TOOL_TIMEOUT_MS
    }
  })

  test('abort 信号取消：reject 并向 main 发 CAPABILITY_CANCEL', async () => {
    const query = await startQuery('q-abort')
    const canUseTool = query.input.canUseTool as CanUseToolCallback

    const controller = new AbortController()
    const pending = canUseTool('Bash', { command: 'ls' }, { signal: controller.signal })
    const capabilityRequest = takeCapabilityRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL)

    controller.abort()
    await expect(pending).rejects.toThrow('Main runtime request aborted: agent.capability.canUseTool')
    await waitFor(() => cancelPostedFor(capabilityRequest.requestId))
    await endQueryAndWait(query)
  })

  test('query 结束清理：无超时挂起的 canUseTool 在 query 终结时被 reject，且不发 CAPABILITY_CANCEL', async () => {
    const query = await startQuery('q-end-cleanup')
    const canUseTool = query.input.canUseTool as CanUseToolCallback

    const pending = canUseTool('AskUserQuestion', { questions: [] }, {})
    const capabilityRequest = takeCapabilityRequest(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL)
    // 手动捕获 rejection：Bun 1.3.14 的 expect(pending).rejects 在非立即 await 时会死锁
    let rejectionError: Error | undefined
    const rejectionDone = pending.then(
      () => { throw new Error('预期 reject，实际 resolve') },
      (error: Error) => { rejectionError = error },
    )

    await endQueryAndWait(query)
    await rejectionDone
    expect(rejectionError?.message).toBe('Agent query ended: q-end-cleanup')
    // query 已终结，main 侧不再需要取消信号
    expect(cancelPostedFor(capabilityRequest.requestId)).toBe(false)
  })
})
