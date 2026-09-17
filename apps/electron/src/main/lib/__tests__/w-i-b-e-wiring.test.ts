/**
 * W-I B-e（v0.17.124）接线源断言测试。
 *
 * 为什么用源断言：本块的改动 90% 落在**渲染端组件 / IPC handler / 大方法内**，没有可实例化的
 * 单元边界（orchestrator/consumer/handler 都是依赖 Electron 运行时的类方法与闭包）。
 * 纯逻辑部分已由 `nanju-quick-telemetry.test.ts`、`gwt-scenario-rows.test.ts` 行为覆盖；
 * 本文件锁定「接线是否真的接上、顺序是否满足父裁决」——这类事实无法用行为测试表达。
 *
 * 断言口径：只断言**片段存在 + 相对顺序**（不做整文件快照，避免并行写者误伤）。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/__tests__/w-i-b-e-wiring.test.ts`
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// 本文件位于 apps/electron/src/main/lib/__tests__ → 上溯 4 级 = apps/electron
const ROOT = join(import.meta.dir, '../../../..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

const MODE_SELECT = 'src/renderer/components/nanju/ModeSelectView.tsx'
const GWT_CARD = 'src/renderer/components/nanju/GwtProgressCard.tsx'
const GUARD_CARD = 'src/renderer/components/nanju/GuardAlertCard.tsx'
const GUARD_EVENT = 'src/main/lib/nanju-guard-alert.ts'
const PRELOAD = 'src/preload/index.ts'
const ROUTER = 'src/main/lib/nanju-router.ts'
const IPC = 'src/main/lib/nanju-ipc.ts'
const ORCH = 'src/main/lib/agent-orchestrator.ts'
const CONSUMER = 'src/main/lib/nanju-phase-advance-consumer.ts'
const LISTENERS = 'src/renderer/hooks/useGlobalAgentListeners.ts'
const CTF_PANEL = 'src/renderer/components/nanju/ClickToFixPanel.tsx'
const TELEMETRY = 'src/main/lib/nanju-quick-telemetry.ts'

/** 相对顺序断言：a 必须出现在 b 之前（等于 -1 视为失败） */
function expectBefore(text: string, a: string, b: string, label: string): void {
  const ia = text.indexOf(a)
  const ib = text.indexOf(b)
  expect({ label, ia: ia >= 0, ib: ib >= 0 }).toEqual({ label, ia: true, ib: true })
  expect(`${label}:${ia < ib}`).toBe(`${label}:true`)
}

describe('W-I B-e｜I-P1 模式卡（点卡=选模式，不绕 autoClarify 勾选）', () => {
  const text = src(MODE_SELECT)

  test('两张卡片消费 quick-ux-model 常量（文案单一真源，无硬编码重复）', () => {
    expect(text).toContain("import { QUICK_MODE_CARD, ITERATIVE_MODE_CARD } from './quick-ux-model'")
    expect(text).toContain('{QUICK_MODE_CARD.title}')
    expect(text).toContain('{ITERATIVE_MODE_CARD.subtitle}')
    expect(text).toContain('{QUICK_MODE_CARD.examples.map(')
    expect(text).toContain('{ITERATIVE_MODE_CARD.examples.map(')
  })

  test('卡片点击只调 handleSelectMode（选模式），不直接创建项目', () => {
    expect(text).toContain("onClick={() => handleSelectMode('quick')}")
    expect(text).toContain("onClick={() => handleSelectMode('iterative')}")
    // 卡片按钮块内不得出现创建调用
    const quickCard = text.slice(text.indexOf("onClick={() => handleSelectMode('quick')"), text.indexOf('{/* 长期迭代型 */}'))
    expect(quickCard).not.toContain('nanjuCreateProject')
  })

  test('创建动作在「开始创建」按钮：输入框 + 复选框 + 按钮三者都在 selectedMode 之后渲染', () => {
    // JSX 渲染顺序（handler 定义在文件前部，故断言「按钮 JSX」而非函数名）
    expectBefore(text, '{/* 项目名输入 */}', "{autoClarifyAvailability === 'available' && (", 'I-P1：命名输入先于勾选')
    expectBefore(text, "{autoClarifyAvailability === 'available' && (", 'onClick={handleConfirm}', 'I-P1：勾选先于创建动作')
    expect(text).toContain('checked={autoClarify}')
    expect(text).toContain('开始创建')
  })

  test('快消型才显示勾选（长期型隐藏=升级即失效硬边界），且创建入参带 autoClarify', () => {
    expect(text).toContain("autoClarifyAvailability === 'available'")
    expect(text).toMatch(/autoClarify/)
    const confirm = text.slice(text.indexOf('const handleConfirm'))
    expect(confirm).toContain('autoClarify')
  })
})

describe('W-I B-e｜I-P2 需求阶段策略注入（引用常量，不复制字面量）', () => {
  const text = src(ROUTER)

  test('router 从 quick-dialog 引用 US-U02 常量与模板（唯一真源）', () => {
    expect(text).toContain("} from './nanju-quick-dialog'")
    expect(text).toContain('AUTO_DECIDE_LABEL')
    expect(text).toContain('AUTO_SUGGEST_TAG')
    expect(text).toContain('QUICK_VAGUE_LOOP_LIMIT')
    expect(text).toContain('buildVagueLoopExitReply')
  })

  test('策略落在 requirements 约束数组里（不是散落注释/未使用变量）', () => {
    const base = text.slice(text.indexOf('const REQUIREMENTS_BASE'), text.indexOf('next: \'prototype\''))
    expect(base).toContain('${AUTO_DECIDE_LABEL}')
    expect(base).toContain('${QUICK_VAGUE_LOOP_LIMIT}')
    expect(base).toContain('${buildVagueLoopExitReply()}')
    expect(base).toContain('实用小工具')
  })
})

describe('W-I B-e｜I-P3 框选接线（同一批：renderer→preload→IPC）', () => {
  test('renderer 的 box-select 分支出现在空白点击兜底之前（否则误报空白）', () => {
    const text = src(LISTENERS)
    expect(text).toContain("if (msg.kind === 'box-select')")
    expectBefore(text, "if (msg.kind === 'box-select')", "if (msg.kind === 'blank-click')", 'I-P3：框选先于空白兜底')
    // catch-all 上报必须在其后
    expectBefore(text, "if (msg.kind === 'box-select')", 'void window.electronAPI.reportClickToFix({', 'I-P3：框选先于 catch-all')
  })

  test('renderer 侧只转发 id/type 且有条数上限（隐私与防伪造）', () => {
    const branch = src(LISTENERS)
    const seg = branch.slice(branch.indexOf("if (msg.kind === 'box-select')"), branch.indexOf("if (msg.kind === 'blank-click')"))
    expect(seg).toContain('sanitize(item?.id, 64)')
    expect(seg).toContain('.slice(0, 24)')
    expect(seg).not.toContain('innerText')
    expect(seg).not.toContain('rect')
  })

  test('preload 的 reportClickToFix 声明 items（通道契约同步）', () => {
    const text = src(PRELOAD)
    expect(text).toContain('items?: Array<{ id: string; type?: string }>')
    expect(text).toContain("ipcRenderer.invoke('agent:report-click-to-fix', input)")
  })

  test('IPC handler 接收 items 且框选早退不注入消息（不落兜底文案）', () => {
    const text = src(IPC)
    expect(text).toContain('items?: Array<{ id?: string; type?: string }>')
    const handler = text.slice(text.indexOf("ipcMain.handle('agent:report-click-to-fix'"))
    expectBefore(handler, "if (input.kind === 'box-select')", 'const { runAgent } = await import(\'./agent-service\')', 'I-P3：框选早退先于注入')
    expect(handler).toContain("return { ok: true }")
  })

  test('#7 click_to_fix 在三处发射：框选 / 主进程四类 / 渲染端就地路径', () => {
    const ipc = src(IPC)
    const listeners = src(LISTENERS)
    expect(ipc).toContain("'click_to_fix'")
    expect(ipc).toContain('buildClickToFixPayload')
    expect(ipc).toContain("if (input.kind === 'element-click') await emitClickToFix")
    expect(ipc).toContain("else if (input.kind === 'blank-click') await emitClickToFix")
    expect(listeners).toContain("eventType: 'click_to_fix'")
    expect(listeners).toContain("stage: 'pick-color'")
  })
})

describe('W-I B-e｜I-P4 mode.switched 真实落库点', () => {
  const text = src(IPC)

  test('锚在 nanju:update-project（真实写库路径），判定 quick→iterative 且写入成功后发射', () => {
    const handler = text.slice(text.indexOf("ipcMain.handle('nanju:update-project'"), text.indexOf("ipcMain.handle('nanju:get-project'"))
    expect(handler).toContain("before.mode === 'quick' && updated.mode === 'iterative'")
    expect(handler).toContain('emitModeSwitched')
    expect(handler).toContain('quickStageState')
    // 写入前读旧值、写入后判定（不是先发射再写）
    expectBefore(handler, 'getNanjuProject(', 'updateNanjuProject(', 'I-P4：先读旧值')
    expectBefore(handler, 'updateNanjuProject(', 'emitModeSwitched', 'I-P4：写成功后才发射')
  })

  test('不落在 auto-clarify 关闭计划器里（该计划器不是模式落库点）', () => {
    const shutdown = text.slice(text.indexOf("ipcMain.handle('nanju:set-auto-clarify'"), text.indexOf("ipcMain.handle('nanju:update-project'"))
    expect(shutdown).not.toContain('emitModeSwitched')
  })
})

describe('W-I B-e｜I-P5/I-P8 事件发射点（推进即事实）', () => {
  const consumer = src(CONSUMER)

  test('#4/#5 在推进成功分支按当前阶段分流（requirements→#4，prototype→#5）', () => {
    expect(consumer).toContain("project.currentStage === 'requirements' || project.currentStage === 'prototype'")
    expect(consumer).toContain("project.currentStage === 'requirements' ? 'prd.confirmed' : 'prototype.confirmed'")
  })

  test('#14 architecture.confirmed 与 arch.executed 同区但独立（不互为别名）', () => {
    expect(consumer).toContain("project.currentStage === 'architecture'")
    expect(consumer).toContain("'architecture.confirmed'")
    expect(consumer).toContain("'arch.executed'")
  })

  test('#12 satisfaction.marked 与 delivery.ack-recorded 同拍且时长取自 askedAt→ack.at', () => {
    expect(consumer).toContain("'satisfaction.marked'")
    expect(consumer).toContain('buildSatisfactionPayload')
    expect(consumer).toContain('challenge.askedAt')
    expectBefore(consumer, "'delivery.ack-recorded'", "'satisfaction.marked'", 'I-P8：#12 紧随 ack 事实')
    // 不做行为推断：verdict 常量 satisfied，无「猜测」分支
    expect(consumer).toContain("verdict: 'satisfied'")
  })

  test('#1 project.created 在建项目成功后发射', () => {
    const ipc = src(IPC)
    const create = ipc.slice(ipc.indexOf("ipcMain.handle('nanju:create-project'"), ipc.indexOf("ipcMain.handle('nanju:update-project'"))
    expect(create).toContain('createNanjuProject(')
    expect(create).toContain('emitProjectCreated')
    expectBefore(create, 'createNanjuProject(', 'emitProjectCreated', 'I-P8：#1 在建成功之后')
  })

  test('#2 dialog.submitted 与 checkConfirmAdvanceInput 同条件（真用户消息，非自动化/非委派）', () => {
    const text = src(ORCH)
    const seg = text.slice(text.indexOf("checkConfirmAdvanceInput(sessionId, workspaceSlug, userMessage, 'message'"))
    expect(seg.slice(0, 800)).toContain('emitDialogSubmitted')
    expect(text).toContain('automationContext')
    expect(text).toContain('triggeredBy')
  })

  test('#10 repair.triggered 覆盖 success / 熔断 / 环境三类发射位', () => {
    const text = src(ORCH)
    expect(text).toContain('emitRepairTriggered')
    expect(text).toContain("emitRepairTriggered(workspaceSlug, projectId, 'success')")
    expect(text).toContain("emitRepairTriggered(workspaceSlug, projectId, 'circuit-break')")
    expect(text).toContain("emitRepairTriggered(workspaceSlug, projectId, 'environment-notify')")
  })
})

describe('W-I B-e｜I-P6/I-P7 视图消费（通俗行/熔断安抚）', () => {
  test('GwtProgressCard 汇总行走 buildGwtSummaryLine，逐场景走 buildScenarioRows（工程 scope 排除）', () => {
    const text = src(GWT_CARD)
    expect(text).toContain('buildGwtSummaryLine({ passed: data.passed, failed: data.failed, skipped: data.skipped })')
    expect(text).toContain('buildScenarioRows({ scenarios: scenarioSeeds })')
    expect(text).toContain('describeScenarioRow(row)')
    expect(text).toContain("!running && data.scope !== 'engineering'")
    expect(text).toContain('scenarioRowSeedFromEvent(payload)')
  })

  test('GuardAlertCard 用 buildCircuitBreakMessage 且三字段来自主进程（非渲染端推断）', () => {
    const card = src(GUARD_CARD)
    expect(card).toContain('buildCircuitBreakMessage({')
    expect(card).toContain('consecutiveCircuitCount')
    expect(card).toContain('rolledBack')
    const event = src(GUARD_EVENT)
    expect(event).toContain('consecutiveCircuitCount?')
    expect(event).toContain('rolledBack?')
    const orch = src(ORCH)
    expect(orch).toContain('consecutiveCircuitCount: runtime.circuitOpens')
    expect(orch).toContain("rolledBack: decision.rollback?.ok === true")
  })
})

describe('W-I B-e｜#6 user.undo（渲染端事实经主进程解析归属）', () => {
  test('ClickToFixPanel 单条撤销与全部放弃均上报', () => {
    const text = src(CTF_PANEL)
    expect(text).toContain("recordUndo('single')")
    expect(text).toContain("recordUndo('all')")
    expect(text).toContain("eventType: 'user.undo'")
    expectBefore(text, 'const removeChange', "recordUndo('single')", '#6：撤销函数内上报')
  })

  test('record-event 支持 sessionId 解析项目且不写入 payload', () => {
    const text = src(IPC)
    const handler = text.slice(text.indexOf("ipcMain.handle('nanju:record-event'"))
    expect(handler).toContain('findNanjuProjectBySession(input.workspaceSlug, input.sessionId)')
    expect(handler).toContain('input.payload ?? {}')
  })
})

describe('W-I B-e｜埋点接线层边界（模块自述契约）', () => {
  test('接线层只发射 #1/#2/#6/#8/#10 且失败一律吞掉（不影响主流程）', () => {
    const text = src(TELEMETRY)
    for (const fn of ['emitDialogSubmitted', 'emitRepairTriggered', 'emitProjectCreated', 'emitModeSwitched', 'emitUserUndo']) {
      expect(text).toContain(`export function ${fn}`)
    }
    // 每个 emit 函数体都在 try/catch 内（吞异常）
    expect((text.match(/catch \{ \/\* 埋点失败/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })
})
