/**
 * W24-EF F2（v0.17.123）：南大项目 quick UX 与本地埋点支撑测试
 *
 * 测试范围（与 EF.md §3.2 BDD 对齐）：
 * 1. PRD §12.4 事件表 14 条全量索引；
 * 2. #7 click_to_fix payload 构建（含隐私边界）；
 * 3. #10 repair.triggered payload 构建（attempt 数越界降级）；
 * 4. #12 satisfaction.marked payload 构建（verdict 枚举守卫）；
 * 5. 既有 union 成员不漂移（回归锁定）。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/nanju-quick-events.test.ts`
 */
import { describe, expect, test } from 'bun:test'

import {
  PRD_TELEMETRY_EVENTS,
  buildClickToFixPayload,
  buildDialogSubmitPayload,
  buildRepairPayload,
  buildSatisfactionPayload,
  emitQuickEvent,
} from './nanju-quick-events'
import type { TelemetryEventType } from './nanju-telemetry'

describe('W24-EF F2：PRD §12.4 事件表 14 条', () => {
  test('14 条全部存在且 index 1..14 单调（无缺漏无重复）', () => {
    expect(PRD_TELEMETRY_EVENTS).toHaveLength(14)
    const indexes = PRD_TELEMETRY_EVENTS.map((e) => e.index)
    expect(indexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  test('每条均含 eventType 与 emitSite 字段，且 eventType 字符串各不相同', () => {
    const seen = new Set<string>()
    for (const e of PRD_TELEMETRY_EVENTS) {
      expect(typeof e.eventType).toBe('string')
      expect(e.eventType.length).toBeGreaterThan(0)
      expect(typeof e.emitSite).toBe('string')
      expect(e.emitSite.length).toBeGreaterThan(0)
      expect(seen.has(e.eventType)).toBe(false)
      seen.add(e.eventType)
    }
  })

  test('全 14 条均为 inUnion=true（与 nanju-telemetry.ts union 同步）', () => {
    for (const e of PRD_TELEMETRY_EVENTS) {
      expect(e.inUnion).toBe(true)
    }
  })

  test('#1/#2/#4/#5/#6/#7/#8/#10/#12/#14 union 与 emit 一并补齐（W-I B-e 后全部已接线）', () => {
    // W-I B-e（I-P4/I-P5/I-P8 归属修正版）已把最后 10 条发射点接上生产代码，
    // 表中 emitted 反映**当前仓库真相**（不是 F2 期状态）——断言随之更新为 true，
    // 并锁定 eventType 不漂移。任何一条回退为 false 都会在此变红。
    const target: Record<number, { eventType: string; emitted: boolean }> = {}
    for (const e of PRD_TELEMETRY_EVENTS) {
      target[e.index] = { eventType: e.eventType, emitted: e.emitted }
    }
    expect(target[6]).toEqual({ eventType: 'user.undo', emitted: true })
    expect(target[7]).toEqual({ eventType: 'click_to_fix', emitted: true })
    expect(target[8]).toEqual({ eventType: 'mode.switched', emitted: true })
    expect(target[10]).toEqual({ eventType: 'repair.triggered', emitted: true })
    expect(target[12]).toEqual({ eventType: 'satisfaction.marked', emitted: true })
    expect(target[1]).toEqual({ eventType: 'project.created', emitted: true })
    expect(target[2]).toEqual({ eventType: 'dialog.submitted', emitted: true })
    expect(target[4]).toEqual({ eventType: 'prd.confirmed', emitted: true })
    expect(target[5]).toEqual({ eventType: 'prototype.confirmed', emitted: true })
    expect(target[14]).toEqual({ eventType: 'architecture.confirmed', emitted: true })
    // 14 条全量已发射（无一条为 false）
    expect(PRD_TELEMETRY_EVENTS.every((e) => e.emitted)).toBe(true)
  })
})

describe('W24-EF F2：#7 click_to_fix payload 构建（隐私最小）', () => {
  test('Given 点选成功修改 When 构建 payload Then 含元素类型与 applied=true（不暴露 id 原文/坐标/原文）', () => {
    const payload = buildClickToFixPayload({
      elementType: '按钮',
      hasId: true,
      applied: true,
      stage: 'pick-color',
    })
    expect(payload).toEqual({
      elementType: '按钮',
      hasId: true,
      applied: true,
      stage: 'pick-color',
    })
    // 隐私红线：绝不能暴露 id 原文、坐标、原文文本
    expect(Object.keys(payload).sort()).toEqual(['applied', 'elementType', 'hasId', 'stage'])
  })

  test('Given 异常输入（elementType 空串 / 越界 stage）When 构建 Then 降级到「元素」/「pick-other」', () => {
    const payload = buildClickToFixPayload({
      elementType: '',
      hasId: false,
      applied: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stage: 'pick-something-not-real' as any,
    })
    expect(payload.elementType).toBe('元素')
    expect(payload.hasId).toBe(false)
    expect(payload.applied).toBe(false)
    expect(payload.stage).toBe('pick-other')
  })

  test('Given 超长 elementType（>32 字符）When 构建 Then 截到 32 字符', () => {
    const long = 'X'.repeat(120)
    const payload = buildClickToFixPayload({
      elementType: long,
      hasId: true,
      applied: true,
      stage: 'pick-text',
    })
    expect(payload.elementType.length).toBe(32)
  })
})

describe('W24-EF F2：#10 repair.triggered payload 构建（attempt 越界降级）', () => {
  test('Given 三次修复后熔断 When 构建 payload Then attempts=3 且 outcome=circuit-break', () => {
    const payload = buildRepairPayload({
      attempts: 3,
      outcome: 'circuit-break',
      strategies: ['direct-fix', 're-read-design', 'alternate-approach'],
    })
    expect(payload.attempts).toBe(3)
    expect(payload.outcome).toBe('circuit-break')
    expect(payload.strategyVariants).toBe(3)
    expect(payload.strategiesCsv).toBe('direct-fix,re-read-design,alternate-approach')
  })

  test('Given 非法 attempts（负数 / 超 3 / NaN）When 构建 Then 截到合法区间 [0,3]', () => {
    expect(buildRepairPayload({ attempts: -1, outcome: 'success', strategies: [] }).attempts).toBe(0)
    expect(buildRepairPayload({ attempts: 99, outcome: 'success', strategies: [] }).attempts).toBe(3)
    expect(buildRepairPayload({ attempts: Number.NaN, outcome: 'success', strategies: [] }).attempts).toBe(0)
  })

  test('Given 未识别 outcome When 构建 Then 降级为 circuit-break（E2 fail-closed 同口径）', () => {
    const payload = buildRepairPayload({
      attempts: 1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outcome: 'mystery-state' as any,
      strategies: ['direct-fix'],
    })
    expect(payload.outcome).toBe('circuit-break')
  })

  test('Given strategies 含重复 / 空串 When 构建 Then 去重保序', () => {
    const payload = buildRepairPayload({
      attempts: 2,
      outcome: 'success',
      strategies: ['direct-fix', '', 're-read-design', 'direct-fix', '   '],
    })
    expect(payload.strategiesCsv).toBe('direct-fix,re-read-design')
    expect(payload.strategyVariants).toBe(2)
  })
})

describe('W24-EF F2：#12 satisfaction.marked payload 构建', () => {
  test('Given 用户标记满意交付 When 构建 payload Then verdict=satisfied（不做行为推断）', () => {
    const payload = buildSatisfactionPayload({
      verdict: 'satisfied',
      activeMsSinceStart: 1234,
    })
    expect(payload).toEqual({ verdict: 'satisfied', activeMsSinceStart: 1234 })
  })

  test('Given needs-change 与异常大时长 When 构建 Then 截到 24h 上限', () => {
    const payload = buildSatisfactionPayload({
      verdict: 'needs-change',
      activeMsSinceStart: 999 * 60 * 60 * 1000, // 999 小时
    })
    expect(payload.verdict).toBe('needs-change')
    expect(payload.activeMsSinceStart).toBe(24 * 60 * 60 * 1000)
  })

  test('Given 非法 verdict When 构建 Then 降级为 needs-change（保守口径，避免误写满意）', () => {
    const payload = buildSatisfactionPayload({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verdict: 'happy' as any,
      activeMsSinceStart: 100,
    })
    expect(payload.verdict).toBe('needs-change')
  })
})

describe('W24-EF F2：#2 dialog.submitted payload 构建（隐私收敛：不存原文）', () => {
  test('Given 对话提交 When 构建 payload Then 含结构化字段且不含原文', () => {
    const payload = buildDialogSubmitPayload({
      mode: 'quick',
      turn: 3,
      inputLength: 12,
      vague: false,
      autoFilledCount: 2,
    })
    expect(payload).toEqual({
      mode: 'quick',
      turn: 3,
      inputLength: 12,
      vague: false,
      autoFilledCount: 2,
    })
    // 隐私红线：只含 mode/turn/inputLength/vague/autoFilledCount，不含原文/文本字段
    expect(Object.keys(payload).sort()).toEqual(['autoFilledCount', 'inputLength', 'mode', 'turn', 'vague'])
  })

  test('Given 异常输入 When 构建 Then 降级到合法区间', () => {
    const payload = buildDialogSubmitPayload({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mode: 'mystery' as any,
      turn: -1,
      inputLength: 999999,
      vague: true,
      autoFilledCount: -2,
    })
    expect(payload.mode).toBe('quick')
    expect(payload.turn).toBe(1)
    expect(payload.inputLength).toBe(100000)
    expect(payload.vague).toBe(true)
    expect(payload.autoFilledCount).toBe(0)
  })
})

describe('W24-EF F2：emitQuickEvent 单点收口 + 既有 union 回归', () => {
  test('emitQuickEvent 调用合法事件类型不抛（包 recordTelemetry，内部 try/catch 不上抛）', () => {
    // 不需要真的写盘——仅断言调用签名合法。workspaceSlug/projectId 任意。
    expect(() => {
      emitQuickEvent('ws-test', 'proj-test', 'click_to_fix', {
        elementType: '按钮',
        hasId: true,
        applied: true,
        stage: 'pick-color',
      })
      emitQuickEvent('ws-test', undefined, 'repair.triggered', {
        attempts: 2,
        outcome: 'success',
        strategiesCsv: 'direct-fix,re-read-design',
        strategyVariants: 2,
      })
      emitQuickEvent('ws-test', 'proj-test', 'satisfaction.marked', {
        verdict: 'satisfied',
        activeMsSinceStart: 5000,
      })
    }).not.toThrow()
  })

  test('既有 union 成员字符串不漂移（回归锁定 14 条事件表完整引用）', () => {
    // 这条断言确认：nanju-quick-events.ts 引用的 TelemetryEventType 字符串与 union 一一对应。
    // 既有 union 字符串：与 nanju-telemetry.ts 同名（追加 4 项后），F2 不得改既有字符串。
    // 注：union 共有 ~50+ 成员（除 PRD §12.4 表外的埋点保留），本测试只断言 PRD 14 条
    // 全部能在已知 union 字符串列表中找到——不漂移既有 PRD 表项字符串即可。
    const known: TelemetryEventType[] = [
      'project.created', 'dialog.submitted', 'role.switched',
      'prd.confirmed', 'prototype.confirmed', 'coding.executed',
      'judge.verdict', 'project.finished', 'architecture.confirmed',
      'user.undo', 'click_to_fix', 'mode.switched', 'repair.triggered', 'satisfaction.marked',
    ]
    // 事件表 14 条，每条 eventType 必须能在已知 union 字符串列表中找到
    for (const e of PRD_TELEMETRY_EVENTS) {
      expect(known).toContain(e.eventType)
    }
  })
})