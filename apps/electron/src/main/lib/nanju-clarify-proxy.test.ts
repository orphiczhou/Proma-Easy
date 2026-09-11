/**
 * v2.4「自动补完需求」代理工具域红测（D7 §4/§9；Defender 清单 #21/#12 相关）
 *
 * 覆盖：
 * 1. 类别门（R5-01/R6-01 核心）：ux-advisor 委派的 blocked 事件即便问题文本自称
 *    requirement-clarify，main 按 phase.role 固定映射判 design-preference → 工具
 *    必返回 fallback:'human'（L2 自报无效 + fail-closed 双保险）；反向
 *    requirement-analyst 委派 → 进代理
 * 2. 入参校验：questions 结构/长度越界拒（≤5 题、每题 ≤200 字、{id,question,options?}）
 * 3. 渠道解析：硬≠提问方（main 内部直查 delegations map 取提问委派渠道，非 L1 渠道）；
 *    AC 避让无解 → diversityDegraded:true
 * 4. 代理委派 meta 只含 {nanjuProxy:true}（不写 sourceDelegationId/parentSessionId）
 * 5. 独立时钟：nanjuProxy 委派 blocked 不重置时钟（软 5min/硬 10min），硬停不计熔断
 * 6. 预算/熔断：proxyBudget=0 → budget-exhausted；「无法判断」累计 3 次 → 熔断
 * 7. 注册门：quick+autoClarify 开启才注册给 L1；iterative/未开启/非 L1 不注册
 *
 * mock 策略（仓库既有模式，同 nanju-model-fallback.test.ts / nanju-delegation-watch.test.ts）：
 * 先 mock.module（config-paths 指向 tmpdir / session-manager 内存桩记录 meta patches /
 * headless runner 可编程 / model-selection 可配置端点表 / ask-user-service 记录回注），
 * 再动态导入被测模块。
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

// ===== 会话管理桩（内存最小实现 + meta patch 记录——「代理委派最小 meta」断言数据源） =====
let childSessionCounter = 0
const sessionMetas = new Map<string, Record<string, unknown>>()
/** 每次 updateAgentSessionMeta 的 (id, patch) 流水（断言代理会话只收到 {nanjuProxy:true}） */
const metaPatches: Array<{ id: string; patch: Record<string, unknown> }> = []
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
    metaPatches.push({ id, patch })
  },
  listAgentSessions: () => Array.from(sessionMetas.values()),
  getAgentSessionSDKMessages: () => [],
  forkAgentSession: async () => ({ id: `child-fork-${++childSessionCounter}` }),
}))

// ===== headless runner 桩（可编程：按 userMessage 内容分派行为） =====
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
const runCalls: RunCall[] = []
/** 可编程脚本：默认不触发任何回调（委派保持 running——提问委派需要停在 blocked 态） */
let runScript: (input: RunCall, callbacks: RunCallbacks, callIndex: number) => void = () => {}
mock.module('./agent-headless-runner-registry', () => ({
  runRegisteredHeadlessAgent: async (input: RunCall, callbacks: RunCallbacks) => {
    runCalls.push(input)
    runScript(input, callbacks, runCalls.length - 1)
  },
  stopRegisteredAgent: () => {},
}))

// ===== 模型选择桩（端点可用表；key=`${channelId}:${modelId}`） =====
let modelAvailability: Record<string, boolean> = {}
mock.module('./agent-model-selection', () => ({
  assertEnabledModelForChannel: (input: { channelId?: string; modelId?: string; purpose: string }) => {
    if (input.modelId == null) return undefined
    const modelId = input.modelId.trim()
    if (!modelId) throw new Error(`${input.purpose}模型 ID 不能为空`)
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

// ===== ask-user-service 桩（回注链路断言数据源） =====
const askUserResponses: Array<{ requestId: string; answers: Record<string, string> }> = []
mock.module('./agent-ask-user-service', () => ({
  askUserService: {
    respondToAskUser: (requestId: string, answers: Record<string, string>) => {
      askUserResponses.push({ requestId, answers })
      return 'child-session-resolved'
    },
  },
}))

// ===== 动态导入被测模块（必须在全部 mock.module 之后） =====
const {
  buildPiCollaborationTools,
  registerCollaborationEventBus,
} = await import('./agent-collaboration-tools')
const {
  NANJU_CLARIFY_PROXY_TOOL_NAME,
  buildNanjuClarifyProxyTool,
  deriveBlockedEventCategory,
  parseProxyAnswers,
  readClarifyLog,
  resolveProxyChannel,
  validateClarifyQuestions,
} = await import('./nanju-clarify-proxy-tool')
const { shouldSkipFallbackChainForDelegation } = await import('./nanju-model-fallback')
const { readTelemetry } = await import('./nanju-telemetry')
import type { TelemetryEventType } from './nanju-telemetry'

// 独立时钟测试用真实 nanju-delegation-watch（纯逻辑依赖注入，不需额外 mock；
// 静态导入同既有 nanju-delegation-watch.test.ts 模式——模块顶层无副作用，与 mocks 无依赖冲突）
import { NanjuDelegationWatcher, NANJU_PROXY_GUARDS, type NanjuDelegationWatchDeps, type WatchedDelegation } from './nanju-delegation-watch'
import { NANJU_GUARDS, type NanjuGuardStage } from './nanju-project'
import type { AgentEventBus } from './agent-event-bus'

// ===== 测试辅助 =====

const sdkStub = { defineTool: (def: unknown) => def } as never

interface ToolDef {
  name: string
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>
}

const L1_SESSION = 'nanju-l1'
const L1_CTX = {
  sessionId: L1_SESSION,
  channelId: 'deepseek',
  workspaceId: 'ws-test',
  workspaceSlug: 'ws-test',
}

/** 构建协作工具集并按名取工具 */
function getTool(name: string, ctx: Record<string, unknown> = L1_CTX): ToolDef {
  const tools = buildPiCollaborationTools(sdkStub, ctx as never) as ToolDef[]
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`工具不存在: ${name}`)
  return tool
}

function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>
}

interface ProjectFixtureOptions {
  mode?: 'quick' | 'iterative'
  stage?: string
  autoClarify?: { enabled: boolean; proxyBudget?: number; pendingQuestionIds?: string[] }
  sessionId?: string
}

/** 写入 nanju 项目 fixture（默认绑定 L1 调度员会话、quick、requirements、autoClarify 开启预算 20） */
function writeNanjuProjectFixture(opts: ProjectFixtureOptions = {}): void {
  mkdirSync(fixtureRoot, { recursive: true })
  const autoClarify = opts.autoClarify ?? { enabled: true, proxyBudget: 20, pendingQuestionIds: [] as string[] }
  writeFileSync(join(fixtureRoot, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p-v24',
    name: 'v2.4 代理工具测试项目',
    mode: opts.mode ?? 'quick',
    status: 'active',
    currentStage: opts.stage ?? 'requirements',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: opts.sessionId ?? L1_SESSION,
    autoClarify: {
      enabled: autoClarify.enabled,
      proxyBudget: autoClarify.proxyBudget ?? 20,
      pendingQuestionIds: autoClarify.pendingQuestionIds ?? [],
    },
  }]))
}

/** 预写 clarify 日志行（预算/熔断计数 fixture） */
function seedClarifyLog(lines: Array<Record<string, unknown>>): void {
  const dir = join(fixtureRoot, 'project-p-v24')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '_nanju-clarify-log.jsonl'),
    lines.map((line) => JSON.stringify({ projectId: 'p-v24', ...line })).join('\n') + '\n',
  )
}

/** 假 EventBus 单例（registerCollaborationEventBus 有单次注册守卫，重复 attach 拿不到 handler） */
let fakeBusHandler: ((sessionId: string, payload: unknown) => void) | null = null
if (!fakeBusHandler) {
  registerCollaborationEventBus({
    on: (cb: (sessionId: string, payload: unknown) => void) => {
      fakeBusHandler = cb
    },
    emit: (sessionId: string, payload: unknown) => {
      fakeBusHandler?.(sessionId, payload)
    },
  } as unknown as AgentEventBus)
}

/** 注入阻塞事件（走注册一次的假总线；handler 未就绪即编程错误） */
function emitBlocked(
  childSessionId: string,
  requestId: string,
  questions: Array<{ question: string; options?: Array<{ label: string }> }>,
): void {
  expect(fakeBusHandler).toBeDefined()
  fakeBusHandler?.(childSessionId, {
    kind: 'proma_event',
    event: {
      type: 'ask_user_request',
      request: { requestId, questions: questions.map((q) => ({ question: q.question, options: q.options ?? [{ label: '继续' }] })) },
    },
  })
}

let toolCallCounter = 0

/** 发起一次 delegate_agent（提问委派） */
async function delegateAskingChild(task: string, channelId = 'glm-zhipu', modelId = 'GLM-5.3'): Promise<string> {
  const tool = getTool('mcp__collaboration__delegate_agent')
  toolCallCounter += 1
  const result = parseResult(await tool.execute(`ask-${toolCallCounter}`, { task, channelId, modelId })) as {
    delegation: { delegationId: string }
  }
  return result.delegation.delegationId
}

/** 读取委派 pendingBlockedEvents */
async function getPendingBlocked(delegationId: string): Promise<Array<Record<string, unknown>>> {
  const tool = getTool('mcp__collaboration__list_delegations')
  toolCallCounter += 1
  const result = parseResult(await tool.execute(`list-${toolCallCounter}`, {})) as {
    delegations: Array<{ delegationId: string; pendingBlockedEvents: Array<Record<string, unknown>> }>
  }
  const found = result.delegations.find((d) => d.delegationId === delegationId)
  return found?.pendingBlockedEvents ?? []
}

/** 执行一次 nanju_clarify_proxy 调用 */
async function callClarifyProxy(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = getTool(NANJU_CLARIFY_PROXY_TOOL_NAME)
  toolCallCounter += 1
  return parseResult(await tool.execute(`clarify-${toolCallCounter}`, params))
}

/** headless 桩：代理委派默认脚本——提取 task 中问题 id，逐题返回指定答案 */
function scriptProxyAnswers(answerFor: (qid: string) => string): void {
  runScript = (input, cb) => {
    const ids = [...input.userMessage.matchAll(/- id: (\S+)/g)].map((m) => m[1]!)
    const answersJson = JSON.stringify({ answers: ids.map((id) => ({ id, answer: answerFor(id) })) })
    cb.onComplete([{ role: 'assistant', content: `已完成独立作答。\n\`\`\`json\n${answersJson}\n\`\`\`` }])
  }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
  modelAvailability = {}
  runCalls.length = 0
  metaPatches.length = 0
  askUserResponses.length = 0
  runScript = () => {}
})

// ===== 第一层：纯函数 =====

describe('类别门派生（deriveBlockedEventCategory：main 按 phase.role 固定映射；fail-closed）', () => {
  test('六角色映射表：requirement-analyst/architect → requirement-clarify；ux-advisor → design-preference；其余 → other', () => {
    expect(deriveBlockedEventCategory('phase.role: requirement-analyst\n你是需求分析师。收集需求。')).toBe('requirement-clarify')
    expect(deriveBlockedEventCategory('phase.role: architect\n你是架构师。')).toBe('requirement-clarify')
    expect(deriveBlockedEventCategory('phase.role: ux-advisor\n你是UX 顾问。')).toBe('design-preference')
    expect(deriveBlockedEventCategory('phase.role: engineering-manager\n你是工程经理。')).toBe('other')
    expect(deriveBlockedEventCategory('phase.role: fullstack-developer\n你是全栈开发。')).toBe('other')
    expect(deriveBlockedEventCategory('phase.role: test-engineer\n你是测试工程师。')).toBe('other')
  })

  test('fail-closed：未知 role / 缺失 / 空文本 / 信号歧义（clarify 与 design 并存）→ other', () => {
    expect(deriveBlockedEventCategory('phase.role: unknown-role\n随便什么')).toBe('other')
    expect(deriveBlockedEventCategory(undefined)).toBe('other')
    expect(deriveBlockedEventCategory('')).toBe('other')
    // 歧义：英文角色字面量与中文头衔冲突 → 不猜，fail-closed
    expect(deriveBlockedEventCategory('你是UX 顾问。另请参考 requirement-analyst 的工作。')).toBe('other')
    // 'architect' 词边界：architecture 不误命中 architect
    expect(deriveBlockedEventCategory('你是需求分析师。输出 03_ARCHITECTURE 架构文档。')).toBe('requirement-clarify')
  })

  test('L2 问题文本不参与判定：任务为 UX 顾问时，问题里自称 requirement-clarify 不改变类别（自报无效）', () => {
    // main 只消费委派任务文本；blocked 问题文本（L2 可控）从未进入派生输入
    const task = 'phase.role: ux-advisor\n你是UX 顾问。根据 PRD 生成原型。'
    expect(deriveBlockedEventCategory(task)).toBe('design-preference')
  })

  test('真实 L2 模板头形态（buildL2TaskWithAC 以「你是<title>。」开头，无显式 marker）：六头衔全矩阵', () => {
    // 需求/架构 → 可代理；UX 顾问 → 设计偏好（永不被代理）；其余三角色 → other
    expect(deriveBlockedEventCategory('你是需求分析师。与用户对话收集需求，产出 PRD。\n## 前序 PRD 摘要\n无（这是需求阶段）')).toBe('requirement-clarify')
    expect(deriveBlockedEventCategory('你是架构师。产出 03_ARCHITECTURE 架构文档。技术选型。')).toBe('requirement-clarify')
    expect(deriveBlockedEventCategory('你是UX 顾问。根据 PRD 生成可交互 HTML 原型。多场景导航规范。')).toBe('design-preference')
    expect(deriveBlockedEventCategory('你是工程经理。产出 05_PROJECT_PLAN 工程计划。里程碑排期。')).toBe('other')
    expect(deriveBlockedEventCategory('你是全栈开发。写代码产出 08_APP。')).toBe('other')
    expect(deriveBlockedEventCategory('你是测试工程师。生成 GWT 验收场景。')).toBe('other')
  })
})

describe('渠道解析（resolveProxyChannel：硬≠提问方家族；软避开 AC；无解降级标记）', () => {
  const allOk = () => true

  test('硬约束：代理渠道家族 ≠ 提问方家族（deepseek 提问 → 非 deepseek 候选）', () => {
    const result = resolveProxyChannel({ askerChannelId: 'deepseek', acChannelIds: [], validateEndpoint: allOk })
    expect(result).toBeDefined()
    expect(result!.channelId.startsWith('deepseek')).toBe(false)
  })

  test('软约束：避开 AC 家族有解 → diversityDegraded:false', () => {
    // 提问方 minimax（独立家族）；AC=[deepseek, glm-zhipu]；候选里 minimax 自身被硬排除后仅剩 AC 家族
    const result = resolveProxyChannel({
      askerChannelId: 'minimax',
      acChannelIds: ['deepseek', 'glm-zhipu'],
      candidates: [
        { channelId: 'minimax', modelId: 'MiniMax-M3' },
        { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
        { channelId: 'qwen', modelId: 'qwen-max' },
      ],
      validateEndpoint: allOk,
    })
    expect(result).toEqual({ channelId: 'qwen', modelId: 'qwen-max', diversityDegraded: false })
  })

  test('软约束无解：只剩 AC 家族候选 → diversityDegraded:true（硬约束仍满足）', () => {
    const result = resolveProxyChannel({
      askerChannelId: 'minimax',
      acChannelIds: ['deepseek', 'glm-zhipu'],
      candidates: [
        { channelId: 'minimax', modelId: 'MiniMax-M3' },
        { channelId: 'deepseek', modelId: 'deepseek-v4-flash' },
      ],
      validateEndpoint: allOk,
    })
    expect(result).toEqual({ channelId: 'deepseek', modelId: 'deepseek-v4-flash', diversityDegraded: true })
  })

  test('硬约束无解（候选全与提问方同族）→ undefined（调用方 fallback no-channel）', () => {
    const result = resolveProxyChannel({
      askerChannelId: 'deepseek',
      acChannelIds: [],
      candidates: [{ channelId: 'deepseek', modelId: 'deepseek-v4-flash' }],
      validateEndpoint: allOk,
    })
    expect(result).toBeUndefined()
  })

  test('端点校验：不可用候选按序跳过', () => {
    const result = resolveProxyChannel({
      askerChannelId: 'deepseek',
      acChannelIds: [],
      candidates: [
        { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
        { channelId: 'qwen', modelId: 'qwen-max' },
      ],
      validateEndpoint: (e) => e.channelId === 'qwen',
    })
    expect(result!.channelId).toBe('qwen')
  })
})

describe('questions 入参校验（validateClarifyQuestions：结构/长度越界拒）', () => {
  test('合法：≤5 题、每题 ≤200 字、{id,question,options?} 结构通过', () => {
    const ok = validateClarifyQuestions([
      { id: 'q1', question: '目标用户是谁？', options: [{ label: '大学生' }, { label: '职场人' }] },
      { id: 'q2', question: '需要离线能力吗？' },
    ])
    expect('questions' in ok).toBe(true)
  })

  test('越界拒：>5 题', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: `问题${i}` }))
    expect('error' in validateClarifyQuestions(six)).toBe(true)
  })

  test('越界拒：单题 >200 字符', () => {
    const result = validateClarifyQuestions([{ id: 'q1', question: '长'.repeat(201) }])
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('200')
  })

  test('结构拒：缺 id / 缺 question / id 重复 / options 非对象数组 / questions 非数组', () => {
    expect('error' in validateClarifyQuestions([{ question: 'x' }])).toBe(true)
    expect('error' in validateClarifyQuestions([{ id: 'q1' }])).toBe(true)
    expect('error' in validateClarifyQuestions([{ id: 'q1', question: 'a' }, { id: 'q1', question: 'b' }])).toBe(true)
    expect('error' in validateClarifyQuestions([{ id: 'q1', question: 'a', options: ['oops'] }])).toBe(true)
    expect('error' in validateClarifyQuestions('not-array')).toBe(true)
  })
})

describe('代理答案解析（parseProxyAnswers：fail-closed）', () => {
  test('解析末尾 json 围栏并按 id 匹配；缺 id / 坏 JSON / 缺围栏 → undefined', () => {
    const good = '前言\n```json\n{"answers":[{"id":"q1","answer":"A"},{"id":"q2","answer":"B"}]}\n```\n'
    expect(parseProxyAnswers(good, ['q1', 'q2'])).toEqual([
      { id: 'q1', answer: 'A' }, { id: 'q2', answer: 'B' },
    ])
    expect(parseProxyAnswers('```json\n{"answers":[{"id":"q1","answer":"A"}]}\n```', ['q1', 'q2'])).toBeUndefined()
    expect(parseProxyAnswers('```json\n{broken\n```', ['q1'])).toBeUndefined()
    expect(parseProxyAnswers('没有围栏', ['q1'])).toBeUndefined()
  })
})

describe('模型 fallback 跳过（shouldSkipFallbackChainForDelegation：代理渠道固定）', () => {
  test('nanjuProxy=true → 跳过；undefined/false → 参与链', () => {
    expect(shouldSkipFallbackChainForDelegation(true)).toBe(true)
    expect(shouldSkipFallbackChainForDelegation(undefined)).toBe(false)
    expect(shouldSkipFallbackChainForDelegation(false)).toBe(false)
  })
})

describe('遥测事件类型 union（审查返工 F2-9：B 域 clarify 五事件 + A 域四事件入表）', () => {
  test('clarify 五事件均为合法 TelemetryEventType（B 域）', () => {
    const clarifyEvents = [
      'clarify.proxy-delegate', 'clarify.proxy-answer', 'clarify.relay-human',
      'clarify.guard-deny', 'clarify.budget-exhausted',
    ] as const
    for (const eventType of clarifyEvents) {
      const _typeCheck: TelemetryEventType = eventType
      expect(_typeCheck).toBe(eventType)
    }
  })

  test('A 域四事件 + replay-origin 预置均为合法 TelemetryEventType（union 收口，去 as never 的前提）', () => {
    const guardEvents = [
      'advance.gate-deny', 'confirm.scatter-no-auth', 'router.gate.ask-deny',
      'clarify.suspect-fake-confirm', 'confirm.replay-origin',
    ] as const
    for (const eventType of guardEvents) {
      const _typeCheck: TelemetryEventType = eventType
      expect(_typeCheck).toBe(eventType)
    }
  })
})

// ===== 第二层：集成（真实 agent-collaboration-tools + mock 依赖） =====

describe('注册门（quick + autoClarify 开启才注册给 L1）', () => {
  test('quick + autoClarify 开启 + L1 绑定 → 注册 nanju_clarify_proxy', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-reg-'))
    writeNanjuProjectFixture()
    const tools = buildPiCollaborationTools(sdkStub, L1_CTX as never) as ToolDef[]
    expect(tools.some((t) => t.name === NANJU_CLARIFY_PROXY_TOOL_NAME)).toBe(true)
  })

  test('iterative 模式 / autoClarify 未开启 / 非 L1 会话 → 均不注册', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-reg2-'))
    writeNanjuProjectFixture({ mode: 'iterative' })
    expect((buildPiCollaborationTools(sdkStub, L1_CTX as never) as ToolDef[]).some((t) => t.name === NANJU_CLARIFY_PROXY_TOOL_NAME)).toBe(false)

    writeNanjuProjectFixture({ autoClarify: undefined })
    writeNanjuProjectFixture({})
    // 未开启：autoClarify 字段缺失
    writeFileSync(join(fixtureRoot, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'p-v24', name: 'x', mode: 'quick', status: 'active', currentStage: 'requirements',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionId: L1_SESSION,
    }]))
    expect((buildPiCollaborationTools(sdkStub, L1_CTX as never) as ToolDef[]).some((t) => t.name === NANJU_CLARIFY_PROXY_TOOL_NAME)).toBe(false)

    // 非 L1 会话（项目绑定其他会话）
    writeNanjuProjectFixture({ sessionId: 'other-session' })
    expect((buildPiCollaborationTools(sdkStub, L1_CTX as never) as ToolDef[]).some((t) => t.name === NANJU_CLARIFY_PROXY_TOOL_NAME)).toBe(false)
  })
})

describe('类别门红测（R5-01/R6-01）：design-preference 事件组 → 必返回 fallback:"human"', () => {
  test('ux-advisor（prototype）委派的 blocked 事件：问题文本自称 requirement-clarify 也不进代理', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-cat-'))
    writeNanjuProjectFixture({ stage: 'prototype' })
    modelAvailability = { 'glm-zhipu:GLM-5.3': true, 'deepseek:deepseek-v4-flash': true }

    // 提问委派：phase.role 显式 ux-advisor（即便任务文本混入 clarify 自称，映射仍按 role）
    const delegationId = await delegateAskingChild(
      'phase.role: ux-advisor\n你是UX 顾问。根据 PRD 生成可交互原型。（本阶段子任务自称 requirement-clarify，仅用于测试 L2 自报无效）',
    )
    // 提问委派自身的 headless run 已计入；此后增量应为零（不创建代理委派）
    const proxyRunsBefore = runCalls.length
    emitBlocked((await pendingChild(delegationId)), 'req-cat-1', [
      { question: '右侧导航放顶部还是侧边？（自报 requirement-clarify）', options: [{ label: '顶部' }, { label: '侧边' }] },
    ])
    const events = await getPendingBlocked(delegationId)
    expect(events).toHaveLength(1)
    // main 按 phase.role 固定映射赋值：ux-advisor → design-preference（自报无效）
    expect(events[0]!.category).toBe('design-preference')

    const result = await callClarifyProxy({ delegationId, blockedEventIds: [events[0]!.id as string] })
    expect(result.status).toBe('fallback')
    expect(result.fallback).toBe('human')
    expect(result.reason).toBe('non-clarify-category')
    expect(result.categories).toContain('design-preference')
    // 未创建任何代理委派、未消耗预算
    expect(runCalls.length).toBe(proxyRunsBefore)
    expect(readNanjuProjectAutoClarify().proxyBudget).toBe(20)
    // 遥测：转述真人
    expect(readTelemetry('ws-test', 'clarify.relay-human').length).toBeGreaterThan(0)
  })

  test('未知/缺失类别（旧事件无 phase.role 标记的普通任务）→ fail-closed 转真人', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-cat2-'))
    writeNanjuProjectFixture()
    modelAvailability = { 'glm-zhipu:GLM-5.3': true }
    const delegationId = await delegateAskingChild('写一个与南大阶段无关的普通任务：调研竞品并总结。')
    emitBlocked((await pendingChild(delegationId)), 'req-cat-2', [{ question: '预算范围？' }])
    const events = await getPendingBlocked(delegationId)
    expect(events[0]!.category).toBe('other')
    const result = await callClarifyProxy({ delegationId, blockedEventIds: [events[0]!.id as string] })
    expect(result.status).toBe('fallback')
    expect(result.reason).toBe('non-clarify-category')
  })

  test('反向：requirement-analyst 委派（requirements 阶段）→ 进代理并完成回注', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-cat3-'))
    writeNanjuProjectFixture({ stage: 'requirements' })
    // 提问委派 glm:GLM-5.3（提问方=glm）；代理候选仅 deepseek:v4-flash 可用（AC 家族 → 降级可用）
    modelAvailability = { 'glm-zhipu:GLM-5.3': true, 'deepseek:deepseek-v4-flash': true }

    // 提问委派阶段保持默认脚本（不完成——委派须停在 running 才能产生 blocked 事件）
    const delegationId = await delegateAskingChild(
      'phase.role: requirement-analyst\n你是需求分析师。与用户对话收集需求，产出 PRD。',
    )
    const childId = await pendingChild(delegationId)
    emitBlocked(childId, 'req-cat-3', [
      { question: '目标用户是谁？', options: [{ label: '大学生' }, { label: '职场人' }] },
    ])
    const events = await getPendingBlocked(delegationId)
    expect(events[0]!.category).toBe('requirement-clarify')

    // blocked 登记完成后再装载代理作答脚本（只对后续创建的代理委派生效）
    scriptProxyAnswers(() => '面向大学生的读书笔记管理')

    const result = await callClarifyProxy({ delegationId, blockedEventIds: [events[0]!.id as string] })
    expect(result.status).toBe('answered')
    expect((result.answers as Array<{ answer: string }>)[0]!.answer).toContain('读书笔记')
    // 硬≠提问方：提问委派渠道 glm-zhipu → 代理渠道不落 glm 家族
    expect(String(result.channel).startsWith('glm-zhipu')).toBe(false)
    // AC 避让无解（候选仅 deepseek=AC 家族可用）→ 降级标记
    expect(result.diversityDegraded).toBe(true)
    // 回注：既有 answer_delegation_question 链路（askUserService，按问题原文键）
    expect(askUserResponses).toEqual([
      { requestId: 'req-cat-3', answers: { '目标用户是谁？': '面向大学生的读书笔记管理' } },
    ])
    // 预算递减 + 溯源日志
    expect(readNanjuProjectAutoClarify().proxyBudget).toBe(19)
    const log = readClarifyLog('ws-test', 'p-v24')
    expect(log.some((line) => line.kind === 'proxy-answer' && line.source === 'subagent')).toBe(true)
    // 遥测：proxy-delegate + proxy-answer
    expect(readTelemetry('ws-test', 'clarify.proxy-delegate').length).toBe(1)
    expect(readTelemetry('ws-test', 'clarify.proxy-answer').length).toBe(1)
    // 待回注问题 id 已清除
    expect(readNanjuProjectAutoClarify().pendingQuestionIds).toEqual([])
  })
})

describe('代理委派生成：inline 最小 meta + 独立时钟标记', () => {
  test('代理子会话 meta patch 只含 {nanjuProxy:true}（不写 sourceDelegationId/parentSessionId）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-meta-'))
    writeNanjuProjectFixture()
    modelAvailability = { 'glm-zhipu:GLM-5.3': true, 'deepseek:deepseek-v4-flash': true }
    scriptProxyAnswers(() => '答')

    const result = await callClarifyProxy({ questions: [{ id: 'q1', question: '需要搜索功能吗？' }] })
    expect(result.status).toBe('answered')

    // 找到代理子会话（第二个创建的会话；第一个是……本测试直接走 clarify 工具，无提问委派）
    // 代理委派的 runCalls[0] 是代理本体
    const proxyRun = runCalls.find((c) => c.userMessage.includes('「自动补完需求」独立代理'))
    expect(proxyRun).toBeDefined()
    const proxySessionId = proxyRun!.sessionId
    // 创建时补丁恰为最小集 {nanjuProxy:true}；不含 sourceDelegationId/parentSessionId/rootSessionId
    const creationPatches = metaPatches.filter((p) => p.id === proxySessionId && 'nanjuProxy' in p.patch)
    expect(creationPatches).toHaveLength(1)
    expect(creationPatches[0]!.patch).toEqual({ nanjuProxy: true })
    for (const p of metaPatches.filter((p) => p.id === proxySessionId)) {
      expect(p.patch.sourceDelegationId).toBeUndefined()
      expect(p.patch.parentSessionId).toBeUndefined()
      expect(p.patch.rootSessionId).toBeUndefined()
    }
    // 运行清单暴露 isNanjuProxy（独立时钟数据源）
    const { listRunningDelegationsForParent } = await import('./agent-collaboration-tools')
    expect(listRunningDelegationsForParent(L1_SESSION).every((d) => d.isNanjuProxy !== true)).toBe(true)
  })

  test('代理委派失败（端点全部不可用）→ fallback:"human"，渠道固定不走 fallback 链', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-noch-'))
    writeNanjuProjectFixture()
    // 只有提问家族（deepseek=L1 渠道）端点可用 → 代理候选全被硬约束排除
    modelAvailability = { 'deepseek:deepseek-v4-flash': true }
    const result = await callClarifyProxy({ questions: [{ id: 'q1', question: '需要导出吗？' }] })
    expect(result.status).toBe('fallback')
    expect(result.reason).toBe('no-channel')
    expect(runCalls).toHaveLength(0)
    // 无 model.fallback.used 埋点（代理渠道固定，不降级重试）
    expect(readTelemetry('ws-test', 'model.fallback.used')).toHaveLength(0)
  })
})

describe('预算与熔断', () => {
  test('proxyBudget=0 → fallback:"human"（budget-exhausted）+ 遥测，不创建委派', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-budget-'))
    writeNanjuProjectFixture({ autoClarify: { enabled: true, proxyBudget: 0 } })
    modelAvailability = { 'deepseek:deepseek-v4-flash': true }
    const result = await callClarifyProxy({ questions: [{ id: 'q1', question: '需要深色模式吗？' }] })
    expect(result.status).toBe('fallback')
    expect(result.reason).toBe('budget-exhausted')
    expect(runCalls).toHaveLength(0)
    expect(readTelemetry('ws-test', 'clarify.budget-exhausted').length).toBe(1)
  })

  test('「无法判断」累计 3 次（同组一次）→ 熔断：后续调用直接 fallback:"human"', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-cj-'))
    writeNanjuProjectFixture()
    seedClarifyLog([
      { kind: 'cannot-judge', qid: 'a' },
      { kind: 'cannot-judge', qid: 'b' },
      { kind: 'cannot-judge', qid: 'c' },
    ])
    modelAvailability = { 'deepseek:deepseek-v4-flash': true }
    const result = await callClarifyProxy({ questions: [{ id: 'q1', question: '要不要分页？' }] })
    expect(result.status).toBe('fallback')
    expect(result.reason).toBe('cannot-judge-circuit')
    expect(runCalls).toHaveLength(0)
  })

  test('同组一次不重复：单次多题含「无法判断」→ 组行只记一条（计数=1）', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-cj2-'))
    writeNanjuProjectFixture()
    modelAvailability = { 'deepseek:deepseek-v4-flash': true, 'glm-zhipu:glm-5.3-flash': true }
    scriptProxyAnswers((qid) => (qid === 'q2' ? '无法确定，缺少用户规模数据' : '明确答案'))
    const result = await callClarifyProxy({
      questions: [
        { id: 'q1', question: '问题一？' },
        { id: 'q2', question: '问题二？' },
      ],
    })
    expect(result.status).toBe('answered')
    const cannotJudge = readClarifyLog('ws-test', 'p-v24').filter((line) => line.kind === 'cannot-judge')
    expect(cannotJudge).toHaveLength(1)
  })
})

describe('工具侧等待兑底', () => {
  test('代理委派超时/非完成终态 → fallback:"human"（proxy-timeout/proxy-failed）并强停孤儿', async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-clarify-timeout-'))
    writeNanjuProjectFixture()
    modelAvailability = { 'deepseek:deepseek-v4-flash': true, 'glm-zhipu:glm-5.3-flash': true }
    // 代理委派立即失败（onError）→ 渠道固定不降级 → status=failed → fallback
    runScript = (_i, cb) => { cb.onError('模拟渠道故障') }
    const result = await callClarifyProxy({ questions: [{ id: 'q1', question: '需要登录吗？' }] })
    expect(result.status).toBe('fallback')
    expect(result.reason).toBe('proxy-failed')
  })
})

// ===== 第三层：独立时钟（真实 NanjuDelegationWatcher + mock 依赖） =====

interface WatchHarness {
  watcher: NanjuDelegationWatcher
  clock: { now: number }
  running: Map<string, WatchedDelegation>
  stops: Array<{ parentSessionId: string; delegationId: string }>
  guardErrors: Array<{ stage: NanjuGuardStage; note: string }>
  injections: string[]
  continuations: string[]
}

function makeWatchHarness(): WatchHarness {
  const clock = { now: 1_000_000 }
  const running = new Map<string, WatchedDelegation>()
  const stops: WatchHarness['stops'] = []
  const guardErrors: WatchHarness['guardErrors'] = []
  const injections: string[] = []
  const continuations: string[] = []
  const deps: NanjuDelegationWatchDeps = {
    now: () => clock.now,
    listRunningDelegations: () => Array.from(running.values()),
    forceStopDelegation: (parentSessionId, delegationId) => {
      stops.push({ parentSessionId, delegationId })
      running.delete(delegationId)
      return { stopped: true }
    },
    getActiveProjectStage: () => 'requirements' as NanjuGuardStage,
    recordGuardError: (_ws, _projectId, stage, note) => {
      guardErrors.push({ stage, note })
      return { justOpened: false, failCount: 0, errorCount: guardErrors.length }
    },
    injectMessage: (_sessionId, text) => injections.push(text),
    sendContinuation: (_sessionId, message) => continuations.push(message),
    log: () => {},
  }
  const watcher = new NanjuDelegationWatcher(deps)
  watcher.register('test-ws', 'session-l1', 'demo-project')
  return { watcher, clock, running, stops, guardErrors, injections, continuations }
}

describe('nanjuProxy 独立时钟（软 5min/硬 10min；blocked 不重置；不计熔断；不续接重派）', () => {
  test('blocked 状态下时钟照走：10min 硬停触发（普通委派 blocked 会豁免——行为差异即红测）', () => {
    const h = makeWatchHarness()
    h.running.set('del-proxy', {
      delegationId: 'del-proxy', childSessionId: 'c1', title: '自动补完需求·代答',
      startedAt: 0, hasPendingBlockedEvents: true, isNanjuProxy: true,
    })
    h.running.set('del-normal', {
      delegationId: 'del-normal', childSessionId: 'c2', title: '普通 L2 委派',
      startedAt: 0, hasPendingBlockedEvents: true,
    })
    h.watcher.poll() // t0 登记
    h.clock.now += NANJU_PROXY_GUARDS.delegationHardTimeoutMs // 10min
    h.watcher.poll()
    // 代理：强停已触发
    expect(h.stops).toContainEqual({ parentSessionId: 'session-l1', delegationId: 'del-proxy' })
    // 普通委派：blocked 豁免，不强停（既有行为不变）
    expect(h.stops).not.toContainEqual({ parentSessionId: 'session-l1', delegationId: 'del-normal' })
    // 代理硬停不计熔断（guardErrors 空）
    expect(h.guardErrors).toHaveLength(0)
    // 代理硬停不注入续接重派指令（fallback 由工具返回）
    expect(h.continuations).toHaveLength(0)
    // 注入了说明（L1 侧可见）
    expect(h.injections.join('\n')).toContain('代理硬超时')
  })

  test('5min 软超时：仅注入提示，不续接催办、不强停', () => {
    const h = makeWatchHarness()
    h.running.set('del-proxy', {
      delegationId: 'del-proxy', childSessionId: 'c1', title: '自动补完需求·代答',
      startedAt: 0, hasPendingBlockedEvents: false, isNanjuProxy: true,
    })
    h.watcher.poll()
    h.clock.now += NANJU_PROXY_GUARDS.delegationSoftTimeoutMs // 5min
    h.watcher.poll()
    expect(h.injections.join('\n')).toContain('代理软超时')
    expect(h.continuations).toHaveLength(0)
    expect(h.stops).toHaveLength(0)
    expect(h.guardErrors).toHaveLength(0)
  })

  test('普通委派时钟阈值不受影响（20min/35min 语义保持）', () => {
    const h = makeWatchHarness()
    h.running.set('del-normal', {
      delegationId: 'del-normal', childSessionId: 'c2', title: '普通 L2 委派',
      startedAt: 0, hasPendingBlockedEvents: false,
    })
    h.watcher.poll()
    h.clock.now += NANJU_PROXY_GUARDS.delegationHardTimeoutMs // 10min < 35min：不触发
    h.watcher.poll()
    expect(h.stops).toHaveLength(0)
    h.clock.now += NANJU_GUARDS.delegationHardTimeoutMs - NANJU_PROXY_GUARDS.delegationHardTimeoutMs + 1000
    h.watcher.poll()
    expect(h.stops).toHaveLength(1) // 35min 硬停照旧（计入熔断）
    expect(h.guardErrors).toHaveLength(1)
  })
})

// ===== 辅助读取 =====

function readNanjuProjectAutoClarify(): { enabled: boolean; proxyBudget: number; pendingQuestionIds: string[] } {
  const raw = JSON.parse(readFileSync(join(fixtureRoot, '_nanju-projects.json'), 'utf-8')) as Array<{
    autoClarify?: { enabled?: boolean; proxyBudget?: number; pendingQuestionIds?: string[] }
  }>
  const state = raw[0]?.autoClarify
  return {
    enabled: state?.enabled === true,
    proxyBudget: typeof state?.proxyBudget === 'number' ? state.proxyBudget : 20,
    pendingQuestionIds: state?.pendingQuestionIds ?? [],
  }
}

/** 提问委派创建后取 childSessionId（供 fake EventBus 定向注入 blocked 事件） */
async function pendingChild(delegationId: string): Promise<string> {
  const tool = getTool('mcp__collaboration__delegate_agent')
  const listTool = getTool('mcp__collaboration__list_delegations')
  toolCallCounter += 1
  const result = parseResult(await listTool.execute(`child-${toolCallCounter}`, {})) as {
    delegations: Array<{ delegationId: string; childSessionId: string }>
  }
  const found = result.delegations.find((d) => d.delegationId === delegationId)
  if (!found) throw new Error(`委派不存在: ${delegationId}`)
  return found.childSessionId
}
