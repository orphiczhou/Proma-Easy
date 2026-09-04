import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * W13 模型 fallback 让步链测试。
 *
 * 分两层：
 * 1. 纯单元：MODEL_FALLBACK_CHAINS 形状 / getFallbackChain 链解析 / modelKey 边界；
 * 2. 集成（mock delegate 失败序列）：startDelegation 的同步降级（渠道/模型校验抛错）、
 *    headless 运行失败降级重试（onError 序列 + generation 守卫防陈旧回调误标）、
 *    全链失败走既有 failed 路径、非 nanju 会话豁免、model.fallback.used 埋点落盘。
 *
 * mock 策略（仓库既有模式，参考 nanju-router-prompt.test.ts / agent-model-selection.test.ts）：
 * 先 mock.module（config-paths 指向 tmpdir / channel-manager 注入渠道 fixture /
 * agent-session-manager 与 agent-headless-runner-registry 换内存桩），再动态导入被测模块。
 */

let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

// ===== 会话管理桩（内存最小实现；导出面与 nanju-delegation-watch.test.ts 同集——
// bun mock.module 跨文件生效，缺导出会在后续文件的链接期抛 SyntaxError，仓库既有模式） =====

let childSessionCounter = 0
const sessionMetas = new Map<string, Record<string, unknown>>()
mock.module('./agent-session-manager', () => ({
  createAgentSession: () => {
    childSessionCounter += 1
    const id = `child-session-${childSessionCounter}`
    sessionMetas.set(id, { id })
    return { id }
  },
  getAgentSessionMeta: (id: string) => sessionMetas.get(id),
  updateAgentSessionMeta: (id: string, patch: Record<string, unknown>) => {
    const prev = sessionMetas.get(id) ?? { id }
    sessionMetas.set(id, { ...prev, ...patch })
  },
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async () => ({ id: `child-fork-${++childSessionCounter}` }),
}))

// ===== headless runner 桩（可编程失败序列；导出面同 delegation-watch） =====

interface RunCall {
  channelId?: string
  modelId?: string
  sessionId: string
  userMessage: string
}
interface RunCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: unknown[]) => void
  onTitleUpdated: (title: string) => void
}
/** 每次 runRegisteredHeadlessAgent 调用的脚本：默认立即成功完成 */
let runScript: (input: RunCall, callbacks: RunCallbacks, callIndex: number) => void = (_i, cb) => {
  cb.onComplete([])
}
const runCalls: RunCall[] = []
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: async (input: RunCall, callbacks: RunCallbacks) => {
    runCalls.push(input)
    runScript(input, callbacks, runCalls.length - 1)
  },
  stopRegisteredAgent: () => {},
}))

// ===== 模型选择桩（可配置端点可用表——同步校验失败序列的驱动源；导出面同 delegation-watch） =====

/** key = `${channelId}:${modelId}`，true = 可用；缺省 = 抛错（模拟渠道/模型未启用） */
let modelAvailability: Record<string, boolean> = {}
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: (input: { channelId?: string; modelId?: string; purpose: string }) => {
    if (input.modelId == null) return undefined
    const modelId = input.modelId.trim()
    if (!modelId) throw new Error(`${input.purpose}模型 ID 不能为空`)
    if (!input.channelId) throw new Error(`${input.purpose}需要可用的 channelId`)
    if (!modelAvailability[`${input.channelId}:${modelId}`]) {
      throw new Error(`${input.purpose}模型不属于当前渠道或未启用: ${modelId}`)
    }
    return modelId
  },
  listEnabledAgentModelsForChannel: () => ({ channelId: 'ch-stub', channelName: 'stub', provider: 'openai' as never, models: [] }),
  pickDefaultModelForChannel: () => {
    throw new Error('跨渠道协作子会话：未配置默认模型（本桩不覆盖该路径）')
  },
}))

// ===== 动态导入被测模块（必须在全部 mock.module 之后） =====

const { MODEL_FALLBACK_CHAINS, getFallbackChain, modelKey, parseModelKey, findNanjuFallbackProject } = await import('./nanju-model-fallback')
const { buildPiCollaborationTools } = await import('./agent-collaboration-tools')
const { readTelemetry } = await import('./nanju-telemetry')

// ===== 测试辅助 =====

/** Pi SDK defineTool 桩：原样返回工具定义 */
const sdkStub = { defineTool: (def: unknown) => def } as never

interface ToolDef {
  name: string
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>
}

/** 构建协作工具集并按名取工具 */
function getTool(name: string): ToolDef {
  const tools = buildPiCollaborationTools(sdkStub, {
    sessionId: 'nanju-l1',
    channelId: 'deepseek',
    workspaceId: 'ws-test',
    workspaceSlug: 'ws-test',
  }) as ToolDef[]
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

/** 解析工具 JSON 结果 */
function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
}

/** 写入 nanju 项目 fixture（sessionId 绑定 L1 调度员会话） */
function writeNanjuProjectFixture(): void {
  mkdirSync(fixtureRoot, { recursive: true })
  writeFileSync(join(fixtureRoot, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p-w13',
    name: 'W13 fallback 测试项目',
    mode: 'quick',
    status: 'active',
    currentStage: 'coding',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: 'nanju-l1',
  }]))
}

let toolCallCounter = 0

/** 发起一次 delegate_agent（返回原始结果或抛错） */
async function delegate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = getTool('mcp__collaboration__delegate_agent')
  toolCallCounter += 1
  const result = await tool.execute(`call-${toolCallCounter}`, {
    task: 'W13 测试委派任务：生成测试场景',
    ...args,
  })
  return parseResult(result)
}

/** 等待委派终态（wait_for_delegations） */
async function waitDelegation(delegationId: string): Promise<Record<string, unknown>> {
  const tool = getTool('mcp__collaboration__wait_for_delegations')
  const result = await tool.execute(`wait-${toolCallCounter}`, {
    delegationIds: [delegationId],
    timeoutSeconds: 5,
  })
  const parsed = parseResult(result) as { delegations?: Array<Record<string, unknown>> }
  return parsed.delegations?.[0] ?? {}
}

function fallbackEvents(): Array<Record<string, unknown>> {
  return readTelemetry('ws-test', 'model.fallback.used').map((e) => e.payload)
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
  modelAvailability = {}
  runCalls.length = 0
  runScript = (_i, cb) => { cb.onComplete([]) }
})

// ===== 第一层：纯单元 =====

describe('MODEL_FALLBACK_CHAINS（代码兑底层，W13b 起配置优先）', () => {
  test('代码链常量形状与 W13 工单 §2.1 一致（5 端点：旗舰→同族快版→异族备援；W13b 起作为配置缺项时的兑底）', () => {
    expect(MODEL_FALLBACK_CHAINS).toEqual({
      'deepseek:deepseek-v4-pro': ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'],
      'deepseek:deepseek-v4-flash': ['glm-zhipu:glm-5.3-flash'],
      'glm-zhipu:GLM-5.3': ['glm-zhipu:glm-5.3-flash', 'deepseek:deepseek-v4-flash'],
      'glm-zhipu:glm-5.3-flash': ['deepseek:deepseek-v4-flash'],
      'minimax:MiniMax-M3': ['glm-zhipu:glm-5.3-flash'],
    })
  })

  test('getFallbackChain：旗舰两级降级；glm:GLM-5.3 走配置链（W13b：参数文件 phases[].fallbacks 优先，同 key 并集）', () => {
    expect(getFallbackChain('deepseek', 'deepseek-v4-pro')).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    // W13b：architecture（声明 deepseek:deepseek-v4-pro）与 coding（声明 glm-5.3-flash →
    // deepseek-v4-flash）共用 glm-zhipu:GLM-5.3 主选——配置链按阶段序取并集，
    // 与代码链（[glm-5.3-flash, v4-flash]）不同 → 证明配置优先
    expect(getFallbackChain('glm-zhipu', 'GLM-5.3')).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-pro' },
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
    ])
  })

  test('getFallbackChain：flash 级单跳异族备援；minimax 链尾备援（配置链与代码链同值）', () => {
    expect(getFallbackChain('deepseek', 'deepseek-v4-flash')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
    expect(getFallbackChain('glm-zhipu', 'glm-5.3-flash')).toEqual([
      { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
    ])
    expect(getFallbackChain('minimax', 'MiniMax-M3')).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
    ])
  })

  test('未配置链的端点返回空数组；渠道 ID 缺失同样空链（防御式：无 fallback = 既有失败路径不变）', () => {
    expect(getFallbackChannelMissing()).toEqual([])
    expect(getFallbackChain('deepseek', 'unknown-model')).toEqual([])
  })

  test('继承模型（未显式传 modelId）不入链——无法构造稳定 key', () => {
    expect(modelKey('deepseek', undefined)).toBeNull()
    expect(getFallbackChain('deepseek', undefined)).toEqual([])
  })

  test('modelKey / parseModelKey 往返一致（modelId 含冒号也不劈叉：首冒号分隔）', () => {
    expect(modelKey('deepseek', 'deepseek-v4-pro')).toBe('deepseek:deepseek-v4-pro')
    expect(parseModelKey('deepseek:deepseek-v4-pro')).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect(parseModelKey('minimax:MiniMax-M3')).toEqual({ channelId: 'minimax', modelId: 'MiniMax-M3' })
  })
})

function getFallbackChannelMissing(channelId = ''): Array<{ channelId: string; modelId: string }> {
  // 占位辅助：渠道 ID 缺失时 getFallbackChain 空链（防御式）
  return getFallbackChain(channelId, 'deepseek-v4-pro')
}

// ===== 第二层：范围限定 =====

describe('findNanjuFallbackProject（nanju 会话范围限定）', () => {
  test('绑定的 L1 调度员会话命中项目；未绑定会话豁免；无 workspaceSlug 豁免', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-scope-'))
    writeNanjuProjectFixture()
    expect(findNanjuFallbackProject('ws-test', 'nanju-l1')?.projectId).toBe('p-w13')
    expect(findNanjuFallbackProject('ws-test', 'session-unbound')).toBeUndefined()
    expect(findNanjuFallbackProject(undefined, 'nanju-l1')).toBeUndefined()
  })
})

// ===== 第三层：delegate 执行链集成（mock 失败序列） =====

describe('delegate_agent fallback 降级重试（nanju 范围内）', () => {
  test('同步降级：请求 v4-pro 但渠道未启用该模型 → 按 chain 校验降级到 v4-flash（单一遥测事件 + 工具结果反映降级模型）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-sync-'))
    writeNanjuProjectFixture()
    // deepseek 渠道只启用 v4-flash（v4-pro 未启用 → 同步校验抛错）
    modelAvailability = { 'deepseek:deepseek-v4-flash': true }

    const result = await delegate({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })

    // 工具结果反映降级后的实际执行模型
    expect(result.effectiveModelId).toBe('deepseek-v4-flash')
    const delegation = result.delegation as Record<string, unknown>
    expect(delegation.modelId).toBe('deepseek-v4-flash')
    // runner 桩同步完成：返回时已是 completed（降级后启动成功）
    expect(delegation.status).toBe('completed')

    // 埋点：原值 → 新值 → 原因
    const events = fallbackEvents()
    expect(events.length).toBe(1)
    expect(events[0]?.fromModelId).toBe('deepseek-v4-pro')
    expect(events[0]?.toModelId).toBe('deepseek-v4-flash')
    expect(String(events[0]?.reason)).toContain('不属于当前渠道或未启用')

    // headless 启动一次即用降级模型
    expect(runCalls.length).toBe(1)
    expect(runCalls[0]?.modelId).toBe('deepseek-v4-flash')
  })

  test('异步降级：首启 onError（渠道超时）→ 同一 delegation 换 v4-flash 重启 → 完成；陈旧 onComplete 不误标（generation 守卫）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-async-'))
    writeNanjuProjectFixture()
    modelAvailability = {
      'deepseek:deepseek-v4-pro': true,
      'deepseek:deepseek-v4-flash': true,
    }
    // 失败序列：第 1 次 run onError 后紧跟 onComplete（模拟 runAgentHeadless catch 分支连发），
    // 第 2 次 run（降级后）正常完成
    runScript = (_input, callbacks, callIndex) => {
      if (callIndex === 0) {
        callbacks.onError('模拟渠道超时：上游 504')
        callbacks.onComplete([]) // 陈旧回调：必须被 generation 守卫丢弃，不得把 record 标 completed
        return
      }
      callbacks.onComplete([{ type: 'result', subtype: 'success' }])
    }

    const result = await delegate({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    const delegationId = (result.delegation as Record<string, unknown>).delegationId as string

    const final = await waitDelegation(delegationId)
    // 终态：第二次（降级）run 完成，而非陈旧回调的空完成，也非 failed
    expect(final.status).toBe('completed')
    expect(final.modelId).toBe('deepseek-v4-flash')

    // 启动序列：v4-pro 失败 → v4-flash 成功（重试 ≤ 链长）
    expect(runCalls.map((c) => c.modelId)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])

    // 埋点一次：v4-pro → v4-flash，原因带错误信息
    const events = fallbackEvents()
    expect(events.length).toBe(1)
    expect(events[0]?.fromModelId).toBe('deepseek-v4-pro')
    expect(events[0]?.toModelId).toBe('deepseek-v4-flash')
    expect(String(events[0]?.reason)).toContain('504')
  })

  test('全链失败：v4-pro → v4-flash → glm-5.3-flash 全部启动失败 → 走既有 failed 路径（3 次尝试 + 2 次埋点）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-exhaust-'))
    writeNanjuProjectFixture()
    modelAvailability = {
      'deepseek:deepseek-v4-pro': true,
      'deepseek:deepseek-v4-flash': true,
      'glm-zhipu:glm-5.3-flash': true,
    }
    runScript = (_input, callbacks) => {
      callbacks.onError('模拟持续失败：鉴权错误')
    }

    const result = await delegate({ channelId: 'deepseek', modelId: 'deepseek-v4-pro' })
    const delegationId = (result.delegation as Record<string, unknown>).delegationId as string

    const final = await waitDelegation(delegationId)
    expect(final.status).toBe('failed')
    expect(String(final.error)).toContain('鉴权错误')
    // 尝试序列 = 原端点 + 整条链（重试 ≤ 链长）
    expect(runCalls.map((c) => c.modelId)).toEqual([
      'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.3-flash',
    ])
    const events = fallbackEvents()
    expect(events.length).toBe(2)
    expect(events.map((e) => e.toModelId)).toEqual(['deepseek-v4-flash', 'glm-5.3-flash'])
  })

  test('链外模型失败不重试：未配置链的端点一次失败即 failed（链表演进不隐式扩大保护面）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-nochain-'))
    writeNanjuProjectFixture()
    modelAvailability = { 'deepseek:some-legacy-model': true }
    runScript = (_input, callbacks) => {
      callbacks.onError('模拟失败')
    }

    const result = await delegate({ channelId: 'deepseek', modelId: 'some-legacy-model' })
    const delegationId = (result.delegation as Record<string, unknown>).delegationId as string
    const final = await waitDelegation(delegationId)
    expect(final.status).toBe('failed')
    expect(runCalls.length).toBe(1)
    expect(fallbackEvents().length).toBe(0)
  })
})

describe('非 nanju 会话豁免（普通 Proma 会话零行为变化）', () => {
  test('异步失败不降级重试：一次 onError 即 failed，无埋点', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-exempt-'))
    // 不写 _nanju-projects.json：该会话不绑定任何 nanju 项目
    modelAvailability = { 'deepseek:deepseek-v4-pro': true }
    runScript = (_input, callbacks) => {
      callbacks.onError('模拟渠道故障')
    }

    const tools = buildPiCollaborationTools(sdkStub, {
      sessionId: 'plain-session',
      channelId: 'deepseek',
      workspaceId: 'ws-test',
      workspaceSlug: 'ws-test',
    }) as ToolDef[]
    const tool = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')
    if (!tool) throw new Error('delegate_agent 工具不存在')
    toolCallCounter += 1
    const result = parseResult(await tool.execute(`call-${toolCallCounter}`, {
      task: '普通会话委派任务',
      channelId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    }))
    const delegationId = (result.delegation as Record<string, unknown>).delegationId as string

    const waitTool = tools.find((t) => t.name === 'mcp__collaboration__wait_for_delegations')
    if (!waitTool) throw new Error('wait 工具不存在')
    toolCallCounter += 1
    const waitResult = JSON.parse((await waitTool.execute(`wait-${toolCallCounter}`, {
      delegationIds: [delegationId],
      timeoutSeconds: 5,
    })).content[0]?.text ?? '{}') as { delegations?: Array<Record<string, unknown>> }
    expect(waitResult.delegations?.[0]?.status).toBe('failed')
    // 豁免：无第二次启动、无降级埋点
    expect(runCalls.length).toBe(1)
    expect(fallbackEvents().length).toBe(0)
    // 埋点目录不存在（config-paths 指向空 tmpdir，recordTelemetry 会建目录写文件——
    // 豁免路径不应触碰 nanju telemetry）
    expect(existsSync(join(fixtureRoot, '_telemetry'))).toBe(false)
  })

  test('同步失败同样豁免：未启用模型直接抛错（不吞错不降级）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-fb-exempt-sync-'))
    modelAvailability = { 'deepseek:deepseek-v4-flash': true }
    const tools = buildPiCollaborationTools(sdkStub, {
      sessionId: 'plain-session-2',
      channelId: 'deepseek',
      workspaceId: 'ws-test',
      workspaceSlug: 'ws-test',
    }) as ToolDef[]
    const tool = tools.find((t) => t.name === 'mcp__collaboration__delegate_agent')
    if (!tool) throw new Error('delegate_agent 工具不存在')
    toolCallCounter += 1
    await expect(tool.execute(`call-${toolCallCounter}`, {
      task: '普通会话委派任务',
      channelId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    })).rejects.toThrow()
    expect(runCalls.length).toBe(0)
    expect(fallbackEvents().length).toBe(0)
  })
})
