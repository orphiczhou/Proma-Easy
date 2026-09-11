/**
 * W17（v0.17.77）：阶段推进链修复测试——PHASE_ADVANCE 全消息扫描消费 + 确认检测补 run 初始输入路径
 *
 * 覆盖面（工单 w17-workorder §3 六项）：
 * 1. 标记出现在 run 中段（后随 tool_use/委派/兜底文本）仍被收集（collectPhaseAdvanceStages
 *    全消息扫描——原实现仅扫末条 assistant 消息，终局复测实证三次标记零消费）；
 * 2. 同轮多标记按序消费：合法+非法混合（prototype 消费、test/delivery 拒绝+纠正消息注入）；
 * 3. 已消费标记去重（同 run 重复声明不二次推进、不注入拒绝消息）；
 * 4. 确认消息作为 run 初始输入 → confirmPendingStage 置位（checkConfirmAdvanceInput，
 *    W16 Q2 失明场景——同一函数，事件流路径与入口路径共用）；
 * 5. 事件流路径确认检测不回归（源码接线断言 + 既有 nanju-confirm-advance.test.ts 基线）；
 * 6. W11 validateAdvanceTarget 规则零变化（既有 nanju-router-gate.test.ts 基线；新消费链
 *    对非法目标的拒绝消息复用 W11 形态断言）。
 *
 * 测试对象：nanju-phase-advance-consumer（W17 从编排器抽出的消费器，无 electron 依赖，
 * 副作用经 hooks 注入）+ nanju-router-gate.collectPhaseAdvanceStages（纯函数）。
 * 编排器侧接线（事件流/入口/result 三处调用 + hooks 装配）以源码断言锁定防退化。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

let fixtureRoot = ''

// ── config-paths mock：nanju 落库全部指向 fixture（仓库既有模式，见 nanju-confirm-advance.test.ts）──
const actualConfigPaths = await import('../config-paths')
mock.module('../config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const { collectPhaseAdvanceStages } = await import('../nanju-router-gate')
const { checkConfirmAdvanceInput, consumePhaseAdvanceMarks } =
  await import('../nanju-phase-advance-consumer')
type PhaseAdvanceHooks = import('../nanju-phase-advance-consumer').PhaseAdvanceHooks
const {
  getProjectConfirmPending,
  // v2.4 推进授权内存态（D7 §1/§2）：授权门红测 + 既有用例补前置
  setConfirmAuthorization, getConfirmAuthorization, consumeConfirmAuthorization,
  setActiveConfirmAsk, getActiveConfirmAsk, clearActiveConfirmAsk,
  registerSystemAdvance, getSystemAdvanceAuthorized, consumeSystemAdvanceAuthorized,
  clearNanjuAdvanceAuthState, __resetNanjuAdvanceAuthStoresForTests,
  CONFIRM_ADVANCE_KEYWORDS,
} = await import('../nanju-project')
// W18：交付双事实门禁（delivered 消费用例前置）
const { checkGwtDeliveryFacts } = await import('../nanju-gwt-runner')
const { readProjectInfo, setProjectDeliveryChallenge, setProjectDeliveryAck } = await import('../nanju-project')

/** 测试用 hooks：捕获注入消息 / GWT 触发 / Todo 收尾 */
function buildTestHooks(): PhaseAdvanceHooks & {
  injected: string[]
  gwtTriggered: Array<Record<string, unknown>>
  finalized: number
} {
  const injected: string[] = []
  const gwtTriggered: Array<Record<string, unknown>> = []
  let finalized = 0
  return {
    injected,
    gwtTriggered,
    get finalized() { return finalized },
    emitAssistantMessage: (_sessionId, text) => { injected.push(text) },
    injectAssistantMessage: (_sessionId, text) => { injected.push(text) },
    triggerGwtRun: (input) => { gwtTriggered.push(input as unknown as Record<string, unknown>) },
    checkGwtDeliveryGate: () => null,
    finalizePhaseTodos: () => { finalized += 1 },
  }
}

/** 构造 fixture：quick 项目（默认 requirements）+ PRD 产出达标（≥100B、含 # 与 US-xx） */
function setupFixture(opts: {
  stage?: string
  sessionId?: string
  confirmPending?: string
} = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-w17-'))
  fixtureRoot = dir
  const sessionId = opts.sessionId ?? 'w17-session-1'
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p1',
    name: 'W17 测试项目',
    mode: 'quick',
    status: 'active',
    currentStage: opts.stage ?? 'requirements',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId,
    workspaceSlug: 'w17-ws',
  }]))
  mkdirSync(join(dir, 'project-p1', '01_PRD'), { recursive: true })
  writeFileSync(join(dir, 'project-p1', '01_PRD', 'prd.md'),
    '# 单位换算工具 PRD\n\n## 用户故事\n\n- US-1 用户输入数值完成单位换算\n'.repeat(3))
  if (opts.confirmPending) {
    mkdirSync(join(dir, 'project-p1'), { recursive: true })
    writeFileSync(join(dir, 'project-p1', '_project-info.json'), JSON.stringify({
      subStage: 'REQ_UC',
      confirmPendingStage: opts.confirmPending,
    }))
  }
}

function readProjects(): Array<{ currentStage?: string; updatedAt?: string }> {
  return JSON.parse(readFileSync(join(fixtureRoot, '_nanju-projects.json'), 'utf-8'))
}

const SESSION_ID = 'w17-session-1'
const WS = 'w17-ws'
const RESUME = { channelId: 'chan-1' }

beforeEach(() => {
  setupFixture()
  // v2.4：推进授权内存态逐用例隔离（Map 跨用例残留会让无授权红测误绿）
  __resetNanjuAdvanceAuthStoresForTests()
})

afterEach(() => {
  __resetNanjuAdvanceAuthStoresForTests()
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 并发清理容忍 */ }
    fixtureRoot = ''
  }
})

// ═══════════════ 工单 §3-1：标记在 run 中段仍被收集（核心场景） ═══════════════

describe('W17 §3-1：collectPhaseAdvanceStages 全消息扫描', () => {
  test('标记在 run 中段（其后还有委派/兜底 assistant 消息）仍被收集——原末条扫描窗口的零消费场景', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: '开始需求分析' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'PRD 已产出，等待确认。' }] } },
      // 中段收口消息：标记在此（终局复测 L117 同型）
      { type: 'assistant', message: { content: [
        { type: 'text', text: '需求阶段完成，推进下一阶段。\n<!-- PHASE_ADVANCE: prototype -->' },
      ] } },
      // 其后还有 tool_use / 委派 / 兜底文本——原实现取"最后一条 assistant"永远扫不到标记
      { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'delegate_agent', input: {} },
      ] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '已委派 UX 顾问，等待产出。' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '轮询委派状态中……' }] } },
    ]
    expect(collectPhaseAdvanceStages(messages)).toEqual(['prototype'])
  })

  test('多标记按「消息序 × 消息内偏移」收集；PHASE_COMPLETE 同型；大小写归一（S1 锚定形态：注释 ∪ 行首）', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'A: <!-- PHASE_ADVANCE: prototype --> 中: <!-- PHASE_COMPLETE: architecture -->' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'B:\nphase_advance: testing' }] } },
    ]
    expect(collectPhaseAdvanceStages(messages)).toEqual(['prototype', 'architecture', 'testing'])
  })

  test('S1 锚定收集：句中引用（正文/说明文字复述协议字面串）不收集', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '下一步我会输出 PHASE_ADVANCE: architecture 作为推进信号，稍后请留意。' }] } },
    ]
    expect(collectPhaseAdvanceStages(messages)).toEqual([])
  })

  test('S1 锚定收集：独立行裸标记仍收集（欠收集比误收集致命，行首声明视为真实意图）', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '需求阶段收口。\nPHASE_ADVANCE: prototype\n以上。' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: '架构完成，推进：\n    PHASE_COMPLETE: architecture（缩进行首仍收）' }] } },
    ]
    expect(collectPhaseAdvanceStages(messages)).toEqual(['prototype', 'architecture'])
  })

  test('S1 丢弃观测：未锚定命中记 phase.advance.discarded-unanchored telemetry（锚定命中仍正常收集）', () => {
    const messages = [
      { type: 'assistant', message: { content: [{ type: 'text', text: '复述协议：先输出 PHASE_ADVANCE: prototype 标记。实际声明：\nPHASE_ADVANCE: prototype' }] } },
    ]
    expect(collectPhaseAdvanceStages(messages, { workspaceSlug: WS })).toEqual(['prototype'])
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    expect(existsSync(telemetryPath)).toBe(true)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const discardedEvent = events.find((e) => e.eventType === 'phase.advance.discarded-unanchored')
    expect(discardedEvent).toBeTruthy()
    expect((discardedEvent.payload as Record<string, unknown>).count).toBe(1)
    expect((discardedEvent.payload as Record<string, unknown>).stages).toEqual(['prototype'])
  })

  test('非 assistant 消息（user/tool_result 回包/result/system）不参与扫描；无标记返回空数组', () => {
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: 'PHASE_ADVANCE: delivered' }] } },
      { type: 'result', subtype: 'success' },
      { type: 'system', subtype: 'status' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] } },
    ]
    expect(collectPhaseAdvanceStages(messages)).toEqual([])
    expect(collectPhaseAdvanceStages([])).toEqual([])
  })
})

// ═══════════════ 工单 §3-2/§3-3：同轮多标记按序消费 + 去重（真实消费链） ═══════════════

describe('W17 §3-2：consumePhaseAdvanceMarks 同轮多标记按序消费', () => {
  test('终局复测案例重演：[prototype, test, delivery]——prototype 消费、test/delivery 按序拒绝并注入纠正教育消息', () => {
    // v2.4（D7 §2）：新门生效后通用分支消费需授权——用系统授权模拟 harness 指令链
    registerSystemAdvance(WS, 'p1', 'prototype')
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(
      SESSION_ID, WS, ['prototype', 'test', 'delivery'],
      RESUME, hooks,
    )
    // prototype 合法：唯一消费成功，状态机推进 + 返回最终推进目标
    expect(advanced).toBe('prototype')
    expect(readProjects()[0]?.currentStage).toBe('prototype')
    expect(hooks.finalized).toBe(1)
    // test / delivery 非法（quick：prototype 的下一阶段是 architecture；且 test/delivery 非法目标 id）
    const rejections = hooks.injected.filter((t) => t.includes('推进标记目标错误'))
    expect(rejections.length).toBe(2)
    expect(rejections[0]).toContain('prototype 的下一阶段是 architecture')
    expect(rejections[0]).toContain('标记目标 test 被忽略')
    expect(rejections[1]).toContain('标记目标 delivery 被忽略')
    // 拒绝形态复用 W11（措辞零变化）
    expect(rejections[0]).toContain('不接受跳级/跨级')
    // 文件验证拦截注入不出现（W11 前置：非法目标先拒，不再对非法目标做产出验证）
    expect(hooks.injected.some((t) => t.includes('阶段推进被拦截'))).toBe(false)
  })

  test('全部标记非法时：状态机不动、返回 null、逐个注入纠正消息', () => {
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(
      SESSION_ID, WS, ['coding', 'delivered'],
      RESUME, hooks,
    )
    expect(advanced).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('requirements')
    expect(hooks.injected.filter((t) => t.includes('推进标记目标错误')).length).toBe(2)
  })

  test('合法目标但产出不达标：W11 放行 → verifyPhaseOutput 拦截（AC L-002 可见化注入）', () => {
    rmSync(join(fixtureRoot, 'project-p1', '01_PRD'), { recursive: true, force: true })
    registerSystemAdvance(WS, 'p1', 'prototype') // v2.4：先过授权门才走到产出验证
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)
    expect(advanced).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('requirements')
    const blocked = hooks.injected.find((t) => t.includes('阶段推进被拦截'))
    expect(blocked).toBeTruthy()
    expect(blocked).toContain('产出文件不存在：01_PRD/prd.md')
    expect(blocked).toContain('产出未达交付标准，请继续修复后重新声明推进')
  })
})

describe('W17 §3-3：已消费标记去重（防重放）', () => {
  test('同 run 重复声明同目标：第二次直接跳过，不二次推进、不注入拒绝消息', () => {
    registerSystemAdvance(WS, 'p1', 'prototype') // v2.4：授权门前置
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(
      SESSION_ID, WS, ['prototype', 'prototype', 'prototype'],
      RESUME, hooks,
    )
    expect(advanced).toBe('prototype')
    expect(readProjects()[0]?.currentStage).toBe('prototype')
    // 第二/三次是"已消费跳过"——既不推进也不教育（区别于非法目标拒绝）
    expect(hooks.injected.filter((t) => t.includes('推进标记目标错误')).length).toBe(0)
    expect(hooks.finalized).toBe(1)
  })

  test('前序消费推进状态机后，后续消费按新状态校验（不是按初始状态）；跨 run 不受去重影响', () => {
    registerSystemAdvance(WS, 'p1', 'prototype') // v2.4：授权门前置
    const hooks = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)).toBe('prototype')
    // 新 run（新消费调用）：prototype 阶段再声明 prototype → W11 拒绝（expected=architecture）
    const hooks2 = buildTestHooks()
    const advanced2 = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks2)
    expect(advanced2).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('prototype')
    expect(hooks2.injected.some((t) => t.includes('下一阶段是 architecture'))).toBe(true)
  })
})

// ═══════════════ 工单 §3-4：确认检测补 run 初始输入路径（W16 Q2 失明场景） ═══════════════

describe('W17 §3-4：checkConfirmAdvanceInput（入口路径共用实现）', () => {
  test('确认文本作为 run 初始输入（活跃收口问句在场 + humanOrigin）→ confirmPending 置位 + 授权 + 埋点落库（v2.4 F2-3/F2-4：散点不再置位）', () => {
    // v2.4：confirmPending/授权统一绑定活跃收口问句——补登记后再走确认链
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，PRD 没问题，继续推进', 'message', { humanOrigin: true })
    expect(getProjectConfirmPending(WS, 'p1')).toBe('requirements')
    expect(getConfirmAuthorization(WS, 'p1')?.expectedTarget).toBe('prototype')
    // telemetry：confirm.advance-hint 事件落库
    const telemetryDir = join(fixtureRoot, '_telemetry')
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(telemetryDir, `events-${month}.jsonl`)
    expect(existsSync(telemetryPath)).toBe(true)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.some((e) => e.eventType === 'confirm.advance-hint' && (e.payload as Record<string, unknown>)?.stage === 'requirements')).toBe(true)
  })

  test('反义词清除（与事件流路径同一函数同一语义）', () => {
    setupFixture({ confirmPending: 'requirements' })
    expect(getProjectConfirmPending(WS, 'p1')).toBe('requirements')
    checkConfirmAdvanceInput(SESSION_ID, WS, '测试不通过，需要修复后再说')
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null)
  })

  test('产出不达标（PRD 缺失）→ 确认文本不置位（verifyPhaseOutput 门禁保持）', () => {
    rmSync(join(fixtureRoot, 'project-p1', '01_PRD'), { recursive: true, force: true })
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，继续推进')
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null)
  })

  test('非确认文本 → 无动作（置位语义不扩散）', () => {
    checkConfirmAdvanceInput(SESSION_ID, WS, '帮我把按钮改成蓝色')
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null)
  })
})

// ═══════════════ W18 前置：delivered 消费链（交付双事实门禁接入后的 fixture 前置） ═══════════════

describe('W18 前置：delivered 消费需 runId+ack 双事实（无 ack 拦截，有 ack 推进+completed）', () => {
  /** fixture 补前置：testing 阶段 + 新版 schema pass 报告（runId+指纹）+ challenge（可选 ack） */
  function setupDeliveryFixture(opts: { ack?: boolean } = {}): void {
    setupFixture({ stage: 'testing' })
    const html = '<!DOCTYPE html><html><body><div data-ai-id="view-note-list">列表</div></body></html>'
    mkdirSync(join(fixtureRoot, 'project-p1', '06_TESTS'), { recursive: true })
    mkdirSync(join(fixtureRoot, 'project-p1', '08_APP'), { recursive: true })
    writeFileSync(join(fixtureRoot, 'project-p1', '08_APP', 'index.html'), html)
    writeFileSync(join(fixtureRoot, 'project-p1', '06_TESTS', 'report.json'), JSON.stringify({
      generatedAt: '2026-09-05T10:00:00.000Z',
      runId: 'R1',
      entryFingerprint: { sha256: createHash('sha256').update(html, 'utf-8').digest('hex'), size: Buffer.byteLength(html, 'utf-8') },
      executionContext: 'file://',
      coverageUnverified: [],
      verdict: 'pass', scenariosTotal: 1, passed: 1, failed: 0, skipped: 0,
      coveredUs: ['US-01'], uncoveredUs: [], retryCount: 0, scenarios: [],
    }))
    setProjectDeliveryChallenge('w17-ws', 'p1', 'R1', SESSION_ID)
    if (opts.ack) setProjectDeliveryAck('w17-ws', 'p1', 'R1', '2026-09-05T10:30:00.000Z')
  }

  /** 门禁接真实事实校验（编排器 checkNanjuGwtDeliveryGate 的 pass 后置同装配） */
  function buildDeliveryHooks() {
    const base = buildTestHooks()
    return {
      ...base,
      checkGwtDeliveryGate: (ws: string, pid: string): string | null => {
        const projectDir = join(fixtureRoot, `project-${pid}`)
        const block = checkGwtDeliveryFacts({
          workspaceSlug: ws,
          projectId: pid,
          reportJsonPath: join(projectDir, '06_TESTS', 'report.json'),
          projectDir,
          info: readProjectInfo(ws, pid),
        })
        return block?.message ?? null
      },
    }
  }

  test('无 ack（用户尚未应答）→ 门禁拦截：状态机不动，注入含「满意交付确认」的拦截文案', () => {
    setupDeliveryFixture({ ack: false })
    const hooks = buildDeliveryHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered'], RESUME, hooks)
    expect(advanced).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('testing')
    const blocked = hooks.injected.find((t) => t.includes('交付被拦截'))
    expect(blocked).toBeTruthy()
    expect(blocked).toContain('满意交付确认')
  })

  test('有 ack（绑当前 runId）→ 推进 delivered + status=completed + project.finished 埋点 + ack 终态清理', () => {
    setupDeliveryFixture({ ack: true })
    const hooks = buildDeliveryHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered'], RESUME, hooks)
    expect(advanced).toBe('delivered')
    expect(readProjects()[0]).toMatchObject({ currentStage: 'delivered', status: 'completed' })
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    expect(existsSync(telemetryPath)).toBe(true)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.filter((e) => e.eventType === 'project.finished').length).toBe(1)
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()
  })
})

// ═══════════════ 工单 §3-5/§3-6：接线不回归 + W11 规则零变化 ═══════════════

describe('W17 §3-5/§3-6：编排器接线源码断言（防退化）', () => {
  const orchestratorSource = readFileSync(new URL('../agent-orchestrator.ts', import.meta.url), 'utf-8')

  test('事件流路径：user 消息检测调用 checkConfirmAdvanceInput（共用同一实现，未复制逻辑）', () => {
    expect(orchestratorSource).toContain('checkConfirmAdvanceInput(sessionId, workspaceSlug, userText)')
    expect(orchestratorSource).toMatch(/msg\.type === 'user' && workspaceSlug && !automationContext/)
  })

  test('run 初始输入路径：sendMessage 入口在 getNanjuRouterPrompt 之前调用同一检测（本轮 prompt 即带强推进提示）', () => {
    // v2.4：入口调用透传 humanOrigin（I1-②a 消息来源分级）
    const entryCall = "checkConfirmAdvanceInput(sessionId, workspaceSlug, userMessage, 'message', {"
    const promptCall = 'getNanjuRouterPrompt(workspaceSlug, sessionId)'
    const entryIdx = orchestratorSource.indexOf(entryCall)
    const promptIdx = orchestratorSource.indexOf(promptCall)
    expect(entryIdx).toBeGreaterThan(-1)
    expect(promptIdx).toBeGreaterThan(-1)
    expect(entryIdx).toBeLessThan(promptIdx)
    expect(orchestratorSource).toContain('!input.triggeredBy && !input.systemInitiated && shouldPersistUserMessage')
    expect(orchestratorSource).toContain('humanOrigin: input.humanOrigin === true')
  })

  test('Q1 接线：result 块用 collectPhaseAdvanceStages(accumulatedMessages) 全量收集并交 consumePhaseAdvanceMarks 按序消费（经 hooks 装配）', () => {
    expect(orchestratorSource).toContain('collectPhaseAdvanceStages(accumulatedMessages, { workspaceSlug })')
    expect(orchestratorSource).toContain('consumePhaseAdvanceMarks(')
    expect(orchestratorSource).toContain('this.buildPhaseAdvanceHooks(sessionId)')
    // 原末条扫描窗口已移除（防回退：result 检测块内不再直接 match PHASE_ADVANCE 单标记）
    expect(orchestratorSource).not.toMatch(/fullText\.match\(\s*\/\(\?:PHASE_COMPLETE\|PHASE_ADVANCE\)/)
  })

  test('W17-AC-M4（A5 顺序断言）：result 块标记扫描先于 accumulatedMessages 清空（Q1 核心时序防静默回退）', () => {
    // 裁决 A5：调用移到清空之后仍可过存在性断言——必须锁执行顺序。带 fromIndex 取检测点
    // 之后的首个清空点，断言检测点在清空点之前（同一同步消息循环内代码序即执行序）。
    const scanIdx = orchestratorSource.indexOf('collectPhaseAdvanceStages(accumulatedMessages, { workspaceSlug })')
    expect(scanIdx).toBeGreaterThan(-1)
    const clearIdx = orchestratorSource.indexOf('accumulatedMessages.length = 0', scanIdx)
    expect(clearIdx).toBeGreaterThan(scanIdx)
  })

  test('W11 规则零变化：validateAdvanceTarget 仍是消费链唯一目标校验（复用而非复制）', () => {
    expect(orchestratorSource).not.toContain('validateAdvanceTarget')  // 编排器不再自带校验
    const consumerSource = readFileSync(new URL('../nanju-phase-advance-consumer.ts', import.meta.url), 'utf-8')
    expect(consumerSource).toMatch(/validateAdvanceTarget\(project\.mode, project\.currentStage, newStage/)
    expect(consumerSource).toContain('不接受跳级/跨级（标记目标')
  })

  test('W17-AC-M1（A1 横幅接活）：run 闭包登记 tool_use，AskUserQuestion 答案 tool_result → 同一确认检测（横幅主确认通道）', () => {
    // run 闭包登记表（Map<tool_use_id, toolName>，run 结束释放）
    expect(orchestratorSource).toContain('const askToolUseNames = new Map<string, string>()')
    // assistant 消息登记 tool_use
    expect(orchestratorSource).toMatch(/askToolUseNames\.set\(block\.id, block\.name \?\? ''\)/)
    // AskUserQuestion tool_result 识别（凭登记表，非文本猜测）
    expect(orchestratorSource).toContain("askToolUseNames.get(block.tool_use_id) !== 'AskUserQuestion'")
    // 答案文本（answers 值）送同一 checkConfirmAdvanceInput（三路径共用；W18 起横幅答案
    // 额外传 source='ask-answer'——唯一可置位交付 ack 的来源）
    expect(orchestratorSource).toContain("checkConfirmAdvanceInput(sessionId, workspaceSlug, answerText, 'ask-answer')")
  })

  test('W17-AC-M2（A2 系统消息豁免）：systemInitiated 续接不进用户意图检测，且不用 triggeredBy 替代', () => {
    // 入口检测条件含 !input.systemInitiated（与 triggeredBy 并列，语义分离）
    expect(orchestratorSource).toContain('!input.triggeredBy && !input.systemInitiated && shouldPersistUserMessage')
    // 全部 6 处系统续接置位：GWT-pass 交付验收 / GWT 回炉 ×3（覆盖/映射/行为） / 护栏续接 / 阶段推进自动续接
    expect(orchestratorSource.split('systemInitiated: true,').length - 1).toBe(6)
    // 不可用 triggeredBy 替代（裁决 M2）：自动续接消息不得置 triggeredBy（会连带跳过 nanjuRouterPrompt 阶段门禁）
    const autoResumeIdx = orchestratorSource.indexOf("'请继续下一阶段的工作。'")
    expect(autoResumeIdx).toBeGreaterThan(-1)
    expect(orchestratorSource.slice(autoResumeIdx, autoResumeIdx + 300)).not.toContain('triggeredBy')
    // AgentSendInput 类型字段存在（shared 类型层）
    const agentTypesSource = readFileSync(
      new URL('../../../../../../packages/shared/src/types/agent.ts', import.meta.url), 'utf-8')
    expect(agentTypesSource).toContain('systemInitiated?: boolean')
  })

  test('W17-AC-M3（A2 提示词缓和）：强提示末句扩用户修改请求优先', () => {
    const promptSource = readFileSync(new URL('../nanju-router-prompt.ts', import.meta.url), 'utf-8')
    expect(promptSource).toContain('若用户消息中还包含修改/补充请求，先完成该请求再推进')
    expect(promptSource).toContain('仅当你确信产出确需补充时，先向用户说明理由')
  })
})

// ═══════════════ v2.4（D7 §2）：推进硬门红测——授权链全覆盖 ═══════════════

describe('v2.4 §2：推进硬门（PHASE_ADVANCE 消费前授权校验）', () => {
  test('红测：纯 mark 无任何授权 → 拒绝推进 + 注入教育消息 + advance.gate-deny 埋点，状态机不动', () => {
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)
    expect(advanced).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('requirements')
    const denied = hooks.injected.find((t) => t.includes('推进未被授权'))
    expect(denied).toBeTruthy()
    expect(denied).toContain('AskUserQuestion')
    expect(denied).toContain('「确认」')
    // telemetry：advance.gate-deny 落库
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    expect(existsSync(telemetryPath)).toBe(true)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const denyEvent = events.find((e) => e.eventType === 'advance.gate-deny')
    expect(denyEvent).toBeTruthy()
    expect((denyEvent!.payload as Record<string, unknown>).target).toBe('prototype')
  })

  test('红测：无授权时产出验证也不执行（拒绝先于文件验证——教育路径清晰）', () => {
    rmSync(join(fixtureRoot, 'project-p1', '01_PRD'), { recursive: true, force: true })
    const hooks = buildTestHooks()
    consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)
    // 产出验证拦截消息不出现（授权门先拒，不对未授权目标做产出验证）
    expect(hooks.injected.some((t) => t.includes('阶段推进被拦截'))).toBe(false)
    expect(hooks.injected.some((t) => t.includes('推进未被授权'))).toBe(true)
  })

  test('ask-answer 授权（target 匹配）→ 推进成功且消费即清（单次授权单次有效）', () => {
    setConfirmAuthorization(WS, 'p1', 'ask-answer', 'prototype')
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)
    expect(advanced).toBe('prototype')
    expect(readProjects()[0]?.currentStage).toBe('prototype')
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null) // 消费即清
    // 同轮第二次声明同目标：已消费去重（不消耗新授权，也不推进）
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, buildTestHooks())).toBe(null)
  })

  test('红测：ask-answer 授权但 expectedTarget 不匹配（确认 A 却推进 B）→ 拒绝且授权保留', () => {
    setConfirmAuthorization(WS, 'p1', 'ask-answer', 'architecture')
    const hooks = buildTestHooks()
    // quick 模式 requirements 下一阶段是 prototype——W11 目标校验对 architecture 拒（跳级），
    // 用合法目标 prototype 才能到达授权门：授权 expectedTarget=architecture ≠ prototype
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)
    expect(advanced).toBe(null)
    expect(readProjects()[0]?.currentStage).toBe('requirements')
    expect(hooks.injected.some((t) => t.includes('推进未被授权'))).toBe(true)
    // 目标不符不消费：授权保留给正确目标
    expect(getConfirmAuthorization(WS, 'p1')?.expectedTarget).toBe('architecture')
  })

  test('systemAdvanceAuthorized（I2）匹配 → 推进；消费即清（单次）；目标不符 → 拒且授权保留', () => {
    registerSystemAdvance(WS, 'p1', 'prototype')
    const hooks = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)).toBe('prototype')
    expect(readProjects()[0]?.currentStage).toBe('prototype')
    expect(getSystemAdvanceAuthorized(WS, 'p1')).toBe(null) // 消费即清

    // 目标不符场景：setupFixture 重置回 requirements
    setupFixture()
    registerSystemAdvance(WS, 'p1', 'prototype')
    const hooks2 = buildTestHooks()
    // W11 拒非法目标在前；用合法但与授权不符的目标无法构造（合法目标唯一），
    // 改测：授权目标 testing（与合法下一阶段 prototype 不符）→ 门拒（W11 对 testing 也拒，
    // 故用 prototype 合法 + 授权 delivered 不匹配——语义等价于 target!==expectedTarget）
    clearNanjuAdvanceAuthState(WS, 'p1')
    registerSystemAdvance(WS, 'p1', 'delivered')
    const advanced2 = consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks2)
    expect(advanced2).toBe(null)
    expect(hooks2.injected.some((t) => t.includes('推进未被授权'))).toBe(true)
    expect(getSystemAdvanceAuthorized(WS, 'p1')?.target).toBe('delivered') // 保留
  })

  test('红测：send_message 注入消息（humanOrigin 缺省 false）+ 确认词 → 不授权也不置 confirmPending（R4-01+F2-4：无 ⏩ 强推进提示）', () => {
    // 模拟 send_message/bridge 注入路径：入口检测 opts 不传 humanOrigin；
    // v2.4 F2-4：注入确认词同样不注入强推进提示（防「命令推进→被拒→循环」污染）
    setActiveConfirmAsk(WS, 'p1', 'prototype') // 即使问句在场，注入文本也不消费它
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，PRD 没问题，继续推进')
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null) // 不置提示
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null) // 不授权
    expect(getActiveConfirmAsk(WS, 'p1')).toBeTruthy() // 问句不被注入消费（留给真人）
    const hooks = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)).toBe(null)
    expect(hooks.injected.some((t) => t.includes('推进未被授权'))).toBe(true)
  })

  test('红测：事件流路径显式 humanOrigin:false + 确认词 → 不授权（工具注入免疫）', () => {
    checkConfirmAdvanceInput(SESSION_ID, WS, '好的，可以推进', 'message', { humanOrigin: false })
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
  })

  test('红测：真 UI 消息（humanOrigin:true）+ 确认词但无活跃确认问句（散点「继续」）→ 不授权（R4-02）+ 埋点观测', () => {
    checkConfirmAdvanceInput(SESSION_ID, WS, '继续', 'message', { humanOrigin: true })
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    expect(existsSync(telemetryPath)).toBe(true)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.some((e) => e.eventType === 'confirm.scatter-no-auth')).toBe(true)
  })

  test('I1-② 完整链：活跃确认问句（harness 登记）+ humanOrigin:true + 确认词 → 授权并消费推进', () => {
    // 模拟「确认」header 问句被路由放行时的登记（nanju-router-gate 放行侧）
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，继续', 'message', { humanOrigin: true })
    const auth = getConfirmAuthorization(WS, 'p1')
    expect(auth).toBeTruthy()
    expect(auth!.source).toBe('user-message')
    expect(auth!.expectedTarget).toBe('prototype')
    // activeConfirmAsk 消费后清除（问句已答）
    expect(getActiveConfirmAsk(WS, 'p1')).toBe(null)
    const hooks = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)).toBe('prototype')
    expect(readProjects()[0]?.currentStage).toBe('prototype')
  })

  test('「跳过」入确认词表：活跃问句 + humanOrigin +「跳过」→ 授权（I1-②c）', () => {
    expect(CONFIRM_ADVANCE_KEYWORDS).toContain('跳过')
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    checkConfirmAdvanceInput(SESSION_ID, WS, '跳过这个环节', 'message', { humanOrigin: true })
    expect(getConfirmAuthorization(WS, 'p1')?.expectedTarget).toBe('prototype')
  })

  test('ask-answer + 活跃收口问句匹配（F2-3②）→ 置位授权 + confirmPending（I1-① 主通道）', () => {
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认', 'ask-answer')
    const auth = getConfirmAuthorization(WS, 'p1')
    expect(auth).toBeTruthy()
    expect(auth!.source).toBe('ask-answer')
    expect(auth!.expectedTarget).toBe('prototype') // harness 按阶段图算（quick: requirements→prototype）
    expect(getProjectConfirmPending(WS, 'p1')).toBe('requirements') // 授权与提示同拍（F2-4）
    expect(getActiveConfirmAsk(WS, 'p1')).toBe(null) // 到达即清（横幅已答）
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.some((e) => e.eventType === 'clarify.suspect-fake-confirm')).toBe(false) // 匹配链路不误报
  })

  test('红测（F2-3②/#3）：中间确认横幅答案（无活跃收口问句的 ask-answer）→ 不授权，仅埋 suspect-fake-confirm（Defender #4 收紧）', () => {
    // 模拟「确认·安装缺失组件」等中间确认横幅：不登记 activeConfirmAsk，答案即达
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认安装', 'ask-answer')
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null)
    const month = new Date().toISOString().slice(0, 7)
    const telemetryPath = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
    const events = readFileSync(telemetryPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const fakeEvent = events.find((e) => e.eventType === 'clarify.suspect-fake-confirm')
    expect(fakeEvent).toBeTruthy()
    expect((fakeEvent!.payload as Record<string, unknown>).reason).toBe('no-active-ask')
    const hooks = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, hooks)).toBe(null)
    expect(hooks.injected.some((t) => t.includes('推进未被授权'))).toBe(true)
  })

  test('红测（F2-3②）：活跃问句 expectedTarget 不匹配 → 不授权（reason=target-mismatch）且问句清除', () => {
    // 构造不匹配：prototype 阶段 harness 期望 architecture，登记问句却指向 coding
    setupFixture({ stage: 'prototype' })
    mkdirSync(join(fixtureRoot, 'project-p1', '02_UX_DESIGN'), { recursive: true })
    writeFileSync(join(fixtureRoot, 'project-p1', '02_UX_DESIGN', 'prototype.html'),
      '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>fixture</title></head><body><div>原型</div></body></html>')
    setActiveConfirmAsk(WS, 'p1', 'coding')
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认', 'ask-answer')
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
    expect(getActiveConfirmAsk(WS, 'p1')).toBe(null) // 到达即清（防残留被后续误用）
    const month = new Date().toISOString().slice(0, 7)
    const events = readFileSync(join(fixtureRoot, '_telemetry', `events-${month}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const fakeEvent = events.find((e) => e.eventType === 'clarify.suspect-fake-confirm')
    expect((fakeEvent!.payload as Record<string, unknown>).reason).toBe('target-mismatch')
  })

  test('红测（F2-4/#15）：散点确认词不注入 ⏩ 强推进提示（无 activeConfirmAsk → confirmPending 不置位，仅埋点）', () => {
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，PRD 没问题，继续推进', 'message', { humanOrigin: true })
    expect(getProjectConfirmPending(WS, 'p1')).toBe(null) // 不注入强推进提示
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
    const month = new Date().toISOString().slice(0, 7)
    const events = readFileSync(join(fixtureRoot, '_telemetry', `events-${month}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(events.some((e) => e.eventType === 'confirm.scatter-no-auth')).toBe(true)
    expect(events.some((e) => e.eventType === 'confirm.advance-hint')).toBe(false)
  })

  test('红测（F2-5/#5/§3）：新 humanOrigin 消息到达即清除活跃问句——非确认消息后续确认词不再授权', () => {
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    // 用户先发了一条与确认无关的新消息（humanOrigin，非确认词）
    checkConfirmAdvanceInput(SESSION_ID, WS, '帮我把按钮改成蓝色', 'message', { humanOrigin: true })
    expect(getActiveConfirmAsk(WS, 'p1')).toBe(null) // 问句被新消息终结
    // 其后再发确认词（humanOrigin）→ 散点，不授权
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认，继续', 'message', { humanOrigin: true })
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
  })

  test('F2-5 对照：反义词（humanOrigin）同样终结活跃问句', () => {
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    checkConfirmAdvanceInput(SESSION_ID, WS, '测试不通过，需要修复后再说', 'message', { humanOrigin: true })
    expect(getActiveConfirmAsk(WS, 'p1')).toBe(null)
  })

  test('TTL：授权与活跃问句 10min 过期后失效（惰性清除）', () => {
    setConfirmAuthorization(WS, 'p1', 'ask-answer', 'prototype')
    setActiveConfirmAsk(WS, 'p1', 'prototype')
    // 快进 11 分钟（monkey-patch Date.now，测后恢复）
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 11 * 60 * 1000
      expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
      expect(getActiveConfirmAsk(WS, 'p1')).toBe(null)
    } finally {
      Date.now = realNow
    }
    // 过期后真 UI 确认词不授权（问句已过期）
    checkConfirmAdvanceInput(SESSION_ID, WS, '确认', 'message', { humanOrigin: true })
    expect(getConfirmAuthorization(WS, 'p1')).toBe(null)
  })

  test('既有特判保留：testing 自环（isTestingSelfAdvance）与 delivered 交付不走授权门（无授权也可触发 GWT/交付门禁）', () => {
    // testing 重入：无任何授权 → 仍触发 GWT（特判先分流）
    setupFixture({ stage: 'testing' })
    const hooks = buildTestHooks()
    consumePhaseAdvanceMarks(SESSION_ID, WS, ['testing'], RESUME, hooks)
    expect(hooks.gwtTriggered.length).toBe(1)
    expect(hooks.injected.some((t) => t.includes('推进未被授权'))).toBe(false)
    expect(readProjects()[0]?.currentStage).toBe('testing')
  })

  test('幂等：同 target 重复 registerSystemAdvance 不叠加（覆盖式刷新）', () => {
    registerSystemAdvance(WS, 'p1', 'prototype')
    registerSystemAdvance(WS, 'p1', 'prototype')
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['prototype'], RESUME, buildTestHooks())).toBe('prototype')
    expect(getSystemAdvanceAuthorized(WS, 'p1')).toBe(null)
  })
})

// ═══════════════ v2.4：消息来源分级 / 门禁重入 / 系统指令登记——源码断言 ═══════════════

describe('v2.4 源码断言：humanOrigin 分级 + nanjuProxy 门禁重入 + registerSystemAdvance 接线', () => {
  const orchestratorSource = readFileSync(new URL('../agent-orchestrator.ts', import.meta.url), 'utf-8')

  test('main/ipc.ts 用户消息通道（SEND_MESSAGE）权威打标：缺省 true，显式 false 优先（Defender #1/#2）', () => {
    const ipcSource = readFileSync(new URL('../../../main/ipc.ts', import.meta.url), 'utf-8')
    expect(ipcSource).toContain("input.humanOrigin = input.humanOrigin === false ? false : true")
    const sharedTypesSource = readFileSync(
      new URL('../../../../../../packages/shared/src/types/agent.ts', import.meta.url), 'utf-8')
    expect(sharedTypesSource).toContain('humanOrigin?: boolean')
  })

  test('三个工具/桥接注入入口显式 humanOrigin:false（R4-01 攻击面；缺省即 false 防回归）', () => {
    const sessionTools = readFileSync(new URL('../agent-session-tools.ts', import.meta.url), 'utf-8')
    const mcpBridge = readFileSync(new URL('../agent-mcp-bridge.ts', import.meta.url), 'utf-8')
    const nanjuOrch = readFileSync(new URL('../nanju-orchestrator.ts', import.meta.url), 'utf-8')
    expect(sessionTools).toContain('humanOrigin: false')
    expect(mcpBridge).toContain('humanOrigin: false')
    expect(nanjuOrch).toContain('humanOrigin: false')
  })

  test('canUseTool 门禁条件：nanjuProxy 代理会话重入门禁（triggeredBy 会话中代理仍过门禁，D7 §4）', () => {
    expect(orchestratorSource).toContain('(!input.triggeredBy || sessionIsNanjuProxy)')
    expect(orchestratorSource).toContain("?.nanjuProxy === true")
  })

  test('systemInitiated 推进指令点统一 registerSystemAdvance（D7 §1 I2：delivered ×1 + testing ×5）', () => {
    expect(orchestratorSource.split("this.registerSystemAdvance(").length - 1).toBe(6)
    expect(orchestratorSource).toContain("this.registerSystemAdvance(workspaceSlug, projectId, 'delivered')")
    expect(orchestratorSource.split("this.registerSystemAdvance(workspaceSlug, projectId, 'testing')").length - 1).toBe(5)
  })

  test('router-gate 第一行为 nanjuProxy 分支（先于 !workspaceSlug 早退与 project 查询，Defender #13）', () => {
    const gateSource = readFileSync(new URL('../nanju-router-gate.ts', import.meta.url), 'utf-8')
    const fnStart = gateSource.indexOf('export function checkNanjuRouterGate')
    const bodyStart = gateSource.indexOf('{', gateSource.indexOf(')', fnStart))
    const firstStmt = gateSource.slice(bodyStart, bodyStart + 700)
    expect(firstStmt).toContain('isNanjuProxySession(sessionId)')
    // 首分支先于 workspaceSlug 早退
    expect(firstStmt.indexOf('isNanjuProxySession')).toBeLessThan(firstStmt.indexOf('if (!workspaceSlug)'))
  })
})
