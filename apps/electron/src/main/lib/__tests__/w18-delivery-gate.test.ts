/**
 * W18 Wave2（v0.17.83）：交付双事实门禁——报告运行标识绑定 + 入口指纹 + AskUser 结构化精确确认 + 四道校验。
 *
 * 双事实（工单 w18-wave2-workorder §1）：
 * - 事实一（机器背书）：report.runId（本次 pass 运行唯一标识）+ entryFingerprint（写盘时刻
 *   对 08_APP/index.html 实测）+ verdict=pass——防「pass 后改应用仍拿旧报告交付」的陈旧错配；
 * - 事实二（用户确认）：GWT-pass 注入验收消息时登记 deliveryChallenge（记录当时 runId）→
 *   用户 AskUserQuestion 应答精确等值「满意交付」（source='ask-answer'）→ deliveryAck 只认
 *   登记值（防旧问题延迟作答绑到新报告）。
 *
 * 覆盖工单 §2 红测试清单：
 * - T0 边界固化：updateNanjuProject 注入 deliveryAck 键 → _project-info.json 不受影响
 * - T1-T4 门禁四道校验（checkGwtDeliveryFacts）：旧 schema / 无 ack / runId 不匹配 / 指纹不符
 * - T5 挑战绑定：ack 绑登记值而非磁盘当前 runId；新报告落盘后旧 ack 被替代校验拦
 * - T6 message 来源自由文本「满意交付」→ 不置位（仅 rejected-freetext 埋点）
 * - T7 否定词清除；T8 幂等（delivered 恰一条 finished / ack at 不重写）；T9 旧答案重放不置位
 * - 交付成功链：ack 后 delivered → currentStage=delivered + status=completed 同拍 + project.finished
 *
 * 编排器侧接线（挑战登记时点 / ask-answer 来源传参）以源码断言锁定（W17 §3-5 同型惯例）。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

let fixtureRoot = ''

// ── config-paths mock：nanju 落库全部指向 fixture（仓库既有模式，见 w17-phase-advance-chain.test.ts）──
const actualConfigPaths = await import('../config-paths')
mock.module('../config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const {
  checkGwtDeliveryFacts,
  computeGwtEntryFingerprint,
  hasGwtDeliverySchemaFields,
} = await import('../nanju-gwt-runner')
const {
  readProjectInfo,
  updateNanjuProject,
  setProjectDeliveryChallenge,
  setProjectDeliveryAck,
  clearProjectDeliveryAck,
  clearProjectDeliveryChallenge,
  DELIVERY_REJECT_WORDS,
} = await import('../nanju-project')
const { checkConfirmAdvanceInput, consumePhaseAdvanceMarks } =
  await import('../nanju-phase-advance-consumer')
type PhaseAdvanceHooks = import('../nanju-phase-advance-consumer').PhaseAdvanceHooks

const SESSION_ID = 'w18-session-1'
const WS = 'w18-ws'
const RESUME = { channelId: 'chan-1' }
const PROJECT_DIR_REL = 'project-p1'
const ENTRY_HTML = '<!DOCTYPE html><html><body><div data-ai-id="view-note-list">笔记列表</div></body></html>'

function fingerprintOf(html: string): { sha256: string; size: number } {
  return { sha256: createHash('sha256').update(html, 'utf-8').digest('hex'), size: Buffer.byteLength(html, 'utf-8') }
}

/** 写入新版 schema 的 pass 报告 + 与指纹一致的 08_APP/index.html */
function writePassReport(runId: string, opts: { entryHtml?: string; generatedAt?: string } = {}): void {
  const html = opts.entryHtml ?? ENTRY_HTML
  mkdirSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS'), { recursive: true })
  mkdirSync(join(fixtureRoot, PROJECT_DIR_REL, '08_APP'), { recursive: true })
  writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '08_APP', 'index.html'), html)
  writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'), JSON.stringify({
    generatedAt: opts.generatedAt ?? '2026-09-05T10:00:00.000Z',
    runId,
    entryFingerprint: fingerprintOf(html),
    executionContext: 'file://',
    coverageUnverified: [],
    verdict: 'pass',
    failureKind: null,
    entry: '08_APP/index.html',
    scenariosTotal: 1, passed: 1, failed: 0, skipped: 0,
    coveredUs: ['US-01'], uncoveredUs: [], retryCount: 0, errorCount: 0,
    scenarios: [],
  }))
}

/** fixture：testing 阶段 quick 项目 + 可选 _project-info.json 内容 */
function setupProject(opts: { stage?: string; info?: Record<string, unknown> } = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-w18-'))
  fixtureRoot = dir
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p1',
    name: 'W18 测试项目',
    mode: 'quick',
    status: 'active',
    currentStage: opts.stage ?? 'testing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: SESSION_ID,
    workspaceSlug: WS,
  }]))
  mkdirSync(join(dir, PROJECT_DIR_REL, '06_TESTS'), { recursive: true })
  mkdirSync(join(dir, PROJECT_DIR_REL, '08_APP'), { recursive: true })
  writeFileSync(join(dir, PROJECT_DIR_REL, '08_APP', 'index.html'), ENTRY_HTML)
  if (opts.info) {
    writeFileSync(join(dir, PROJECT_DIR_REL, '_project-info.json'), JSON.stringify(opts.info))
  }
}

/** 门禁调用薄壳（与编排器 checkNanjuGwtDeliveryGate 的 pass 后置校验同装配） */
function runDeliveryGate(): { reason: string; message: string } | null {
  return checkGwtDeliveryFacts({
    workspaceSlug: WS,
    projectId: 'p1',
    reportJsonPath: join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'),
    projectDir: join(fixtureRoot, PROJECT_DIR_REL),
    info: readProjectInfo(WS, 'p1'),
  })
}

/** 测试用 hooks：checkGwtDeliveryGate 接真实事实校验（编排器同装配），其余捕获 */
function buildTestHooks(): PhaseAdvanceHooks & {
  injected: string[]
  finalized: number
} {
  const injected: string[] = []
  let finalized = 0
  return {
    injected,
    get finalized() { return finalized },
    emitAssistantMessage: (_sid, text) => { injected.push(text) },
    injectAssistantMessage: (_sid, text) => { injected.push(text) },
    triggerGwtRun: () => { /* 交付链测试不触发 GWT */ },
    checkGwtDeliveryGate: (ws, pid) => {
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
    finalizePhaseTodos: () => { finalized += 1 },
  }
}

function readProjects(): Array<{ currentStage?: string; status?: string }> {
  return JSON.parse(readFileSync(join(fixtureRoot, '_nanju-projects.json'), 'utf-8'))
}

function readTelemetryEvents(): Array<{ eventType: string; payload: Record<string, unknown> }> {
  const month = new Date().toISOString().slice(0, 7)
  const p = join(fixtureRoot, '_telemetry', `events-${month}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').trim().split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
}

beforeEach(() => {
  setupProject()
})

afterEach(() => {
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 并发清理容忍 */ }
    fixtureRoot = ''
  }
})

// ═══════════════ T0：两文件边界固化（误报驳回的回归锁） ═══════════════

describe('W18 T0：边界固化——deliveryAck 只存 _project-info.json，updateNanjuProject 不得写入', () => {
  test('经 updateNanjuProject 注入 deliveryAck 键 → ProjectInfo 读值不变（IPC 只写 _nanju-projects，两文件不互通）', () => {
    setupProject({
      info: { deliveryChallenge: { reportRunId: 'R1', sessionId: SESSION_ID, askedAt: '2026-09-05T10:00:01.000Z' } },
    })
    updateNanjuProject(WS, 'p1', {
      deliveryAck: { at: '2026-09-05T12:00:00.000Z', reportRunId: 'FAKE-RUN' },
    } as unknown as Parameters<typeof updateNanjuProject>[2])
    const info = readProjectInfo(WS, 'p1')
    // _project-info.json 不受影响：无伪造 ack，既有 challenge 原样保留
    expect(info?.deliveryAck).toBeUndefined()
    expect(info?.deliveryChallenge).toEqual({ reportRunId: 'R1', sessionId: SESSION_ID, askedAt: '2026-09-05T10:00:01.000Z' })
  })
})

// ═══════════════ T1-T4：门禁四道校验（checkGwtDeliveryFacts） ═══════════════

describe('W18 T1-T4：checkGwtDeliveryFacts 四道校验', () => {
  test('T1 旧 schema 报告（无 runId/entryFingerprint）→ 拦「旧版格式」+ delivery.gate.blocked 埋点', () => {
    // 旧版报告：v0.17.82 及以前（无 runId/entryFingerprint/executionContext）
    writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'), JSON.stringify({
      generatedAt: '2026-09-01T00:00:00.000Z',
      verdict: 'pass', failureKind: null, entry: '08_APP/index.html',
      scenariosTotal: 1, passed: 1, failed: 0, skipped: 0,
      coveredUs: ['US-01'], uncoveredUs: [], retryCount: 0, scenarios: [],
    }))
    const block = runDeliveryGate()
    expect(block?.reason).toBe('legacy-schema')
    expect(block?.message).toContain('旧版格式')
    expect(block?.message).toContain('不可用于交付')
    // 埋点：delivery.gate.blocked + reason 归因
    const events = readTelemetryEvents()
    const blocked = events.filter((e) => e.eventType === 'delivery.gate.blocked')
    expect(blocked.length).toBe(1)
    expect(blocked[0]?.payload.reason).toBe('legacy-schema')
    expect(blocked[0]?.payload.project_id).toBe('p1')
    // schema 判定纯函数：旧报告 false / 新报告 true
    expect(hasGwtDeliverySchemaFields(JSON.parse(readFileSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'), 'utf-8')))).toBe(false)
    writePassReport('R-new')
    expect(hasGwtDeliverySchemaFields(JSON.parse(readFileSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'), 'utf-8')))).toBe(true)
  })

  test('T2 pass + runId + 无 ack → 拦，注入文案含「满意交付确认」与 AskUserQuestion 指引', () => {
    writePassReport('R1')
    const block = runDeliveryGate()
    expect(block?.reason).toBe('no-ack')
    expect(block?.message).toContain('满意交付确认')
    expect(block?.message).toContain('AskUserQuestion')
    expect(readTelemetryEvents().some((e) => e.eventType === 'delivery.gate.blocked' && e.payload.reason === 'no-ack')).toBe(true)
  })

  test('T3 ack.reportRunId ≠ report.runId（新报告落盘后旧 ack）→ 拦「已被替代」', () => {
    writePassReport('R-new')
    setProjectDeliveryAck(WS, 'p1', 'R-old')
    const block = runDeliveryGate()
    expect(block?.reason).toBe('ack-run-mismatch')
    expect(block?.message).toContain('已被替代')
    expect(readTelemetryEvents().some((e) => e.eventType === 'delivery.gate.blocked' && e.payload.reason === 'ack-run-mismatch')).toBe(true)
  })

  test('T3b 冗余防御：同 runId 内 ack.at ≤ report.generatedAt → 拦「已过期」', () => {
    writePassReport('R1', { generatedAt: '2026-09-05T12:00:00.000Z' })
    setProjectDeliveryAck(WS, 'p1', 'R1', '2026-09-05T10:00:00.000Z')
    const block = runDeliveryGate()
    expect(block?.reason).toBe('ack-stale')
    expect(block?.message).toContain('已过期')
  })

  test('T4 pass 后改入口文件（fingerprint 不符）→ 拦「被修改」；改回原文件则放行', () => {
    writePassReport('R1')
    // pass 后应用被修改（08_APP/index.html 内容变化）
    writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '08_APP', 'index.html'), ENTRY_HTML + '<!-- modified after pass -->')
    const block = runDeliveryGate()
    expect(block?.reason).toBe('fingerprint-mismatch')
    expect(block?.message).toContain('被修改')
    expect(readTelemetryEvents().some((e) => e.eventType === 'delivery.gate.blocked' && e.payload.reason === 'fingerprint-mismatch')).toBe(true)
    // 改回原内容 → 指纹恢复一致（仍无 ack，但 reason 从指纹校验退到 no-ack）
    writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '08_APP', 'index.html'), ENTRY_HTML)
    expect(runDeliveryGate()?.reason).toBe('no-ack')
  })

  test('指纹实测纯函数：computeGwtEntryFingerprint 与写入报告口径一致；入口缺失返回 null', () => {
    writePassReport('R1')
    const fp = computeGwtEntryFingerprint(join(fixtureRoot, PROJECT_DIR_REL, '08_APP', 'index.html'))
    expect(fp).toEqual(fingerprintOf(ENTRY_HTML))
    expect(computeGwtEntryFingerprint(join(fixtureRoot, PROJECT_DIR_REL, '08_APP', 'missing.html'))).toBeNull()
  })

  test('四道校验全过（ack 绑当前 runId + 指纹一致 + ack 晚于报告）→ 放行 null', () => {
    writePassReport('R1')
    setProjectDeliveryAck(WS, 'p1', 'R1', '2026-09-05T10:30:00.000Z')
    expect(runDeliveryGate()).toBeNull()
  })
})

// ═══════════════ T5：挑战绑定（发起时登记，应答只认登记值） ═══════════════

describe('W18 T5：挑战绑定——ack 绑登记 runId，不绑磁盘当前报告', () => {
  test('challenge 登记 R1 → 期间新报告 R2 落盘 → ask-answer 应答 → ack.reportRunId===R1（非 R2），且门禁按替代校验拦', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    // 回炉重测后新报告 R2 落盘（pass）——旧 challenge 仍持 R1
    writePassReport('R2')
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const info = readProjectInfo(WS, 'p1')
    expect(info?.deliveryAck?.reportRunId).toBe('R1')
    // 旧 ack 被替代校验拦（ack R1 ≠ 当前报告 R2）
    expect(runDeliveryGate()?.reason).toBe('ack-run-mismatch')
  })

  test('重新注入重建 challenge=R2（清旧 ack/challenge 后登记）→ 重新应答 → ack=R2 → 门禁放行', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    // 模拟编排器 GWT-pass 注入侧：清旧 ack/challenge → 读刚落盘 runId → 重建 challenge
    writePassReport('R2')
    clearProjectDeliveryAck(WS, 'p1')
    clearProjectDeliveryChallenge(WS, 'p1')
    setProjectDeliveryChallenge(WS, 'p1', 'R2', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck?.reportRunId).toBe('R2')
    expect(runDeliveryGate()).toBeNull()
  })

  test('应答后 challenge 被清除（单次有效）；ack 登记埋点 delivery.ack-recorded 落库', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const info = readProjectInfo(WS, 'p1')
    expect(info?.deliveryChallenge).toBeUndefined()
    expect(info?.deliveryAck?.reportRunId).toBe('R1')
    const events = readTelemetryEvents()
    const ackEvents = events.filter((e) => e.eventType === 'delivery.ack-recorded')
    expect(ackEvents.length).toBe(1)
    expect(ackEvents[0]?.payload.project_id).toBe('p1')
    expect(ackEvents[0]?.payload.report_run_id).toBe('R1')
    expect(ackEvents[0]?.payload.source).toBe('ask-answer')
  })

  test('前置条件缺失不置位：非 testing 阶段 / 无 challenge / 报告非 pass / 旧 schema 报告', () => {
    // a) 非 testing 阶段
    setupProject({ stage: 'coding' })
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()

    // b) testing 但无 challenge（未发起过验收询问）
    setupProject()
    writePassReport('R1')
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()

    // c) challenge 存在但磁盘报告 fail
    setupProject()
    writePassReport('R1')
    const reportPath = join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as Record<string, unknown>
    report.verdict = 'fail'
    writeFileSync(reportPath, JSON.stringify(report))
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()

    // d) challenge 存在但报告为旧 schema（无 runId）
    setupProject()
    writeFileSync(join(fixtureRoot, PROJECT_DIR_REL, '06_TESTS', 'report.json'), JSON.stringify({
      generatedAt: '2026-09-01T00:00:00.000Z', verdict: 'pass',
      scenariosTotal: 1, passed: 1, failed: 0, skipped: 0,
      coveredUs: ['US-01'], uncoveredUs: [], retryCount: 0, scenarios: [],
    }))
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()
  })
})

// ═══════════════ T6/T9：message 来源不置位（自由文本 / 旧答案重放） ═══════════════

describe('W18 T6/T9：message 来源命中交付词 → 只埋点不置位', () => {
  test('T6 自由文本 message 来源「满意交付」→ 不置位 ack，仅 delivery.ack-rejected-freetext 埋点（challenge 原样保留）', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'message')
    const info = readProjectInfo(WS, 'p1')
    expect(info?.deliveryAck).toBeUndefined()
    expect(info?.deliveryChallenge?.reportRunId).toBe('R1')
    const events = readTelemetryEvents()
    expect(events.some((e) => e.eventType === 'delivery.ack-rejected-freetext')).toBe(true)
    expect(events.some((e) => e.eventType === 'delivery.ack-recorded')).toBe(false)
  })

  test('T9 旧 tool_result 重放（message 通道携带旧答案文本）→ ack 不重绑：新 challenge=R2 在场时旧答案不置位/不改绑', () => {
    // 旧一轮：R1 已 ack（模拟历史事实）
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const ackAt = readProjectInfo(WS, 'p1')?.deliveryAck?.at
    // 新一轮：R2 落盘 + 新 challenge 登记（等重新应答）
    writePassReport('R2')
    setProjectDeliveryChallenge(WS, 'p1', 'R2', SESSION_ID)
    // 旧答案文本经 message 通道重放（事件流/初始输入均 source=message）
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付')
    const info = readProjectInfo(WS, 'p1')
    // ack 保持 R1（不被重放到 R2），challenge 保持 R2（等待新的 ask-answer 应答）
    expect(info?.deliveryAck?.reportRunId).toBe('R1')
    expect(info?.deliveryAck?.at).toBe(ackAt)
    expect(info?.deliveryChallenge?.reportRunId).toBe('R2')
    // 门禁按替代校验拦（R1 ≠ R2）
    expect(runDeliveryGate()?.reason).toBe('ack-run-mismatch')
  })
})

// ═══════════════ T7：否定词清除 ═══════════════

describe('W18 T7：否定词清除 ack+challenge（ask-answer 与 message 均生效）', () => {
  test('ask-answer「我不确认交付」→ 不置位；已置位则清除', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    // 未置位时：否定应答不置位，challenge 清除（用户明确反悔）
    checkConfirmAdvanceInput(SESSION_ID, WS, '我不确认交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()
    expect(readProjectInfo(WS, 'p1')?.deliveryChallenge).toBeUndefined()

    // 已置位时：清除
    setProjectDeliveryAck(WS, 'p1', 'R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '我不确认交付', 'ask-answer')
    const info = readProjectInfo(WS, 'p1')
    expect(info?.deliveryAck).toBeUndefined()
    expect(info?.deliveryChallenge).toBeUndefined()
    // 清除后门禁回到 no-ack
    expect(runDeliveryGate()?.reason).toBe('no-ack')
  })

  test('message「暂不确认交付」→ 同样清除（两来源一致）', () => {
    writePassReport('R1')
    setProjectDeliveryAck(WS, 'p1', 'R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '暂不确认交付', 'message')
    const info = readProjectInfo(WS, 'p1')
    expect(info?.deliveryAck).toBeUndefined()
    expect(info?.deliveryChallenge).toBeUndefined()
  })

  test('否定词表边界：五词命中；普通确认/中性文本不清除', () => {
    expect(DELIVERY_REJECT_WORDS).toEqual(['不确认交付', '暂不确认', '不要交付', '不接受交付', '先不交付'])
    writePassReport('R1')
    setProjectDeliveryAck(WS, 'p1', 'R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    // 普通确认文本不清除（交付域否定词不扩散到普通确认语义）
    checkConfirmAdvanceInput(SESSION_ID, WS, '没问题，应用很好', 'message')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck?.reportRunId).toBe('R1')
  })
})

// ═══════════════ T8：幂等 ═══════════════

describe('W18 T8：幂等', () => {
  test('同 run 重复 delivered 消费 → 状态单次推进 + project.finished 恰一条；跨 run 重复声明被终态校验拒绝（不重复计）', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered', 'delivered'], RESUME, hooks)
    expect(advanced).toBe('delivered')
    expect(readProjects()[0]).toMatchObject({ currentStage: 'delivered', status: 'completed' })
    let finished = readTelemetryEvents().filter((e) => e.eventType === 'project.finished')
    expect(finished.length).toBe(1)
    // 跨 run 再声明 delivered：currentStage 已终态 → W11 终态拒绝，不重复推进/计埋点
    const hooks2 = buildTestHooks()
    expect(consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered'], RESUME, hooks2)).toBe(null)
    expect(readProjects()[0]).toMatchObject({ currentStage: 'delivered', status: 'completed' })
    finished = readTelemetryEvents().filter((e) => e.eventType === 'project.finished')
    expect(finished.length).toBe(1)
  })

  test('重复 ask-answer 精确应答 → ack 不重写（at 不变）', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const first = readProjectInfo(WS, 'p1')?.deliveryAck
    // 第二次应答：challenge 已清（无登记值可认）→ 不重写
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    const second = readProjectInfo(WS, 'p1')?.deliveryAck
    expect(second?.at).toBe(first?.at)
    expect(second?.reportRunId).toBe('R1')
    // ack 登记埋点恰一条
    expect(readTelemetryEvents().filter((e) => e.eventType === 'delivery.ack-recorded').length).toBe(1)
  })
})

// ═══════════════ 交付成功链 ═══════════════

describe('W18 交付成功链：T5 ack 后 delivered 标记 → delivered+completed 同拍 + project.finished + ack 终态清理', () => {
  test('全链：pass 报告 → challenge 登记 → ask-answer「满意交付」→ L1 输出 delivered → 门禁放行推进', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    checkConfirmAdvanceInput(SESSION_ID, WS, '满意交付', 'ask-answer')
    expect(readProjectInfo(WS, 'p1')?.deliveryAck?.reportRunId).toBe('R1')

    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered'], RESUME, hooks)
    expect(advanced).toBe('delivered')
    // _nanju-projects.json 两字段同拍（单次写）
    const projects = readProjects()
    expect(projects[0]?.currentStage).toBe('delivered')
    expect(projects[0]?.status).toBe('completed')
    // telemetry：project.finished 恰一条（类型首次启用）
    const finished = readTelemetryEvents().filter((e) => e.eventType === 'project.finished')
    expect(finished.length).toBe(1)
    expect(finished[0]?.payload.project_id).toBe('p1')
    expect(finished[0]?.payload.mode).toBe('quick')
    // ack 终态清理（防下个项目误读）
    expect(readProjectInfo(WS, 'p1')?.deliveryAck).toBeUndefined()
    expect(hooks.finalized).toBe(1)
    expect(hooks.injected.some((t) => t.includes('交付被拦截'))).toBe(false)
  })

  test('反向链：无 ack 时 delivered 标记 → 门禁拦截（不推进、状态机不动、无 finished 埋点）', () => {
    writePassReport('R1')
    setProjectDeliveryChallenge(WS, 'p1', 'R1', SESSION_ID)
    // 用户尚未应答（无 ack）——L1 提前输出 delivered 标记
    const hooks = buildTestHooks()
    const advanced = consumePhaseAdvanceMarks(SESSION_ID, WS, ['delivered'], RESUME, hooks)
    expect(advanced).toBe(null)
    expect(readProjects()[0]).toMatchObject({ currentStage: 'testing', status: 'active' })
    const blocked = hooks.injected.find((t) => t.includes('交付被拦截'))
    expect(blocked).toBeTruthy()
    expect(blocked).toContain('满意交付确认')
    expect(readTelemetryEvents().filter((e) => e.eventType === 'project.finished').length).toBe(0)
    expect(hooks.finalized).toBe(0)
  })
})

// ═══════════════ 编排器接线源码断言（W17 §3-5 同型惯例，防退化） ═══════════════

describe('W18 编排器接线源码断言', () => {
  const orchestratorSource = readFileSync(new URL('../agent-orchestrator.ts', import.meta.url), 'utf-8')
  const runnerSource = readFileSync(new URL('../nanju-gwt-runner.ts', import.meta.url), 'utf-8')
  const promptSource = readFileSync(new URL('../nanju-router-prompt.ts', import.meta.url), 'utf-8')
  const telemetrySource = readFileSync(new URL('../nanju-telemetry.ts', import.meta.url), 'utf-8')

  test('挑战登记时点：GWT-pass 注入前——清旧 ack → 清旧 challenge → 读刚落盘 runId → setProjectDeliveryChallenge(runId, sessionId) → 注入验收消息', () => {
    const clearAckIdx = orchestratorSource.indexOf('clearProjectDeliveryAck(workspaceSlug, projectId)')
    const clearChallengeIdx = orchestratorSource.indexOf('clearProjectDeliveryChallenge(workspaceSlug, projectId)')
    const setChallengeIdx = orchestratorSource.indexOf('setProjectDeliveryChallenge(workspaceSlug, projectId, reportRunId, sessionId)')
    const injectIdx = orchestratorSource.indexOf('buildGwtDeliveryAcceptanceMessage(outcome.summaryText)')
    expect(clearAckIdx).toBeGreaterThan(-1)
    expect(clearChallengeIdx).toBeGreaterThan(clearAckIdx)
    expect(setChallengeIdx).toBeGreaterThan(clearChallengeIdx)
    expect(injectIdx).toBeGreaterThan(setChallengeIdx)
  })

  test('来源传参：AskUser tool_result 路径传 source=ask-answer；事件流/初始输入两处保持默认 message', () => {
    expect(orchestratorSource).toContain("checkConfirmAdvanceInput(sessionId, workspaceSlug, answerText, 'ask-answer')")
    expect(orchestratorSource).toContain('checkConfirmAdvanceInput(sessionId, workspaceSlug, userText)')
    expect(orchestratorSource).toContain('checkConfirmAdvanceInput(sessionId, workspaceSlug, userMessage)')
  })

  test('门禁接线：verdict=pass 后调 checkGwtDeliveryFacts（四道事实校验）', () => {
    expect(orchestratorSource).toContain('checkGwtDeliveryFacts({')
    expect(orchestratorSource).toMatch(/checkGwtDeliveryFacts\(\{\s*workspaceSlug,/)
  })

  test('话术同步（W12 段升级）：resume 消息与 router-prompt 均声明「verdict=pass 且系统已记录用户满意交付确认」', () => {
    expect(runnerSource).toContain('且系统已记录用户满意交付确认')
    expect(promptSource).toContain('且系统已记录用户满意交付确认')
  })

  test('话术尾注覆盖边界（gwt-runner 验收续接指令）', () => {
    expect(runnerSource).toContain('覆盖边界')
  })

  test('埋点类型：三事件已入 telemetry 事件枚举', () => {
    expect(telemetrySource).toContain("'delivery.ack-recorded' | 'delivery.gate.blocked' | 'delivery.ack-rejected-freetext'")
  })
})
