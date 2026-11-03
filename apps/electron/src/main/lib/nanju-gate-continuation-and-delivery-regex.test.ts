/**
 * P0'' + P2 修复（2026-09-28，E2E-Desktop 21:53 停摆）源码断言与行为测试。
 *
 * 问题 A（P0''）：GWT 交付门禁拦截（isDeliverFromTesting gateError 分支）此前只
 * injectAssistantMessage（写 JSONL + 推 UI，不启动 run）——调度员 run 已结束，
 * 拦截指引（含「请先声明 PHASE_ADVANCE: testing 触发自动验收」关键行动项）无
 * Agent 消费，流程静默停摆。修复：追加 hooks.sendContinuation（systemInitiated
 * 续接，复用 runNanjuGuardContinuation 的 busy 重试/空闲巡检）。
 *
 * 问题 B（P2）：DELIVERY 门禁正则 `/^##\s+测试状态\s*$/m` 要求标题独占一行，
 * 「## 测试状态（2026-09-26 实测）」被判「缺少章节」（coding→testing 卡死 2 天
 * 直接诱因，拒因文案还误导为「缺少」）。修复：负向前瞻 `(?![^\s（(])` 允许
 * 行尾/空白/全半角括号后缀；变体新章节名（「测试状态与xxx」）仍拒。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const CONSUMER = readFileSync(new URL('./nanju-phase-advance-consumer.ts', import.meta.url), 'utf-8')
const CONTRACT_SRC = readFileSync(new URL('./nanju-engineering-contract.ts', import.meta.url), 'utf-8')

function deliverGateBranch(): string {
  const start = CONSUMER.indexOf('const gateError = hooks.checkGwtDeliveryGate')
  expect(start).toBeGreaterThan(-1)
  const end = CONSUMER.indexOf('// W18 Wave2：交付成功单次写双字段', start)
  expect(end).toBeGreaterThan(start)
  return CONSUMER.slice(start, end)
}

describe("P0'' GWT 交付拦截续接：拦截分支驱动调度员", () => {
  const block = deliverGateBranch()

  test('保留可见注入（UI 用户可见）', () => {
    expect(block).toContain("injectAssistantMessage(sessionId, `⚠️ 交付被拦截：${gateError}${authStateNote}`)")
  })

  test('注入之后追加 sendContinuation（拦截+行动指引真正送达调度员）', () => {
    const injectIdx = block.indexOf('injectAssistantMessage')
    const contIdx = block.indexOf('hooks.sendContinuation(')
    expect(contIdx).toBeGreaterThan(-1)
    expect(contIdx).toBeGreaterThan(injectIdx)
  })

  test('续接消息含关键行动项（声明 testing 触发自动验收）', () => {
    const contIdx = block.indexOf('hooks.sendContinuation(')
    const tail = block.slice(contIdx, contIdx + 500)
    expect(tail).toContain('PHASE_ADVANCE: testing')
    expect(tail).toContain('触发自动验收测试')
  })
})

describe('P2 DELIVERY 章节正则：允许括号后缀、拒变体', () => {
  // 与 validateEngineeringCodingOutput 内联正则同字面量（防漂移由首项源码字面断言保证）
  const run = new RegExp('^##\\s+构建与运行(?![^\\s（(])', 'm')
  const status = new RegExp('^##\\s+测试状态(?![^\\s（(])', 'm')

  test('源码使用负向前瞻形态（非旧 \\s*$ 独占行）', () => {
    expect(CONTRACT_SRC).toContain('构建与运行(?![^\\s（(])')
    expect(CONTRACT_SRC).toContain('测试状态(?![^\\s（(])')
  })

  test('精确标题通过；全/半角括号后缀通过；空白后缀通过', () => {
    expect(run.test('## 构建与运行\n## 测试状态')).toBe(true)
    expect(status.test('## 测试状态')).toBe(true)
    expect(status.test('## 测试状态（2026-09-26 实测）')).toBe(true)
    expect(status.test('## 测试状态(2026-09-26)')).toBe(true)
    expect(status.test('## 测试状态 \n')).toBe(true)
  })

  test('变体新章节名仍拒（不得以「测试状态与」扩展语义）', () => {
    expect(status.test('## 测试状态与验收记录')).toBe(false)
    expect(status.test('## 测试状态说明')).toBe(false)
    expect(status.test('### 测试状态')).toBe(false)
    expect(status.test('## 测试状态x')).toBe(false)
  })
})
